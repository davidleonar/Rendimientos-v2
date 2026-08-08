const functions = require('firebase-functions');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const allowedOrigins = [
  'https://rendimientos-5dbb9.web.app',
  'https://rendimientos-5dbb9.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:5000'
];

const cors = require('cors')({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  }
});

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const rateLimitMap = new Map();
function isRateLimited(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const userRecord = rateLimitMap.get(key) || { count: 0, resetTime: now + windowMs };
  if (now > userRecord.resetTime) {
    userRecord.count = 1;
    userRecord.resetTime = now + windowMs;
    rateLimitMap.set(key, userRecord);
    return false;
  }
  userRecord.count += 1;
  rateLimitMap.set(key, userRecord);
  return userRecord.count > maxRequests;
}
const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');

const { defineString, defineSecret } = require('firebase-functions/params');
const { onValueCreated, onValueUpdated, onValueWritten } = require('firebase-functions/v2/database');
//const { https: { onRequest } } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const next = require('next');
const path = require('path');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

//mainMacaroons
const lndUrl = defineString('LND_URL');
const mainMacaroon = defineSecret('MAIN_LND_MACAROON');  // Main admin.mainMacaroon
const edgeMacaroon = defineSecret('EDGE_TAPD_MACAROON');  // Edge admin.mainMacaroon
const adminUid = defineString('ADMIN_UID');  // Your UID
const webhookSecret = defineString('WEBHOOK_SECRET');  // Your webhook secret

// Binance secrets
const binanceApiKey = defineSecret('BINANCE_API_KEY');
const binanceSecretKey = defineSecret('BINANCE_SECRET_KEY');
const binanceProxyToken = defineSecret('BINANCE_PROXY_TOKEN');
const proxyVmUrl = defineString('PROXY_VM_URL');

//Mailer configuration (example with Gmail, adjust as needed)
const adminEmail = defineString('ADMIN_EMAIL');
const smtpUser = defineString('SMTP_USER');
const smtpPass = defineSecret('SMTP_PASS');

// Initialize Firebase Admin SDK
initializeApp({
  credential: applicationDefault(),
  databaseURL: "https://rendimientos-5dbb9-default-rtdb.firebaseio.com/"
});

// Middleware to verify token
async function verifyToken(req, res) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send('Unauthorized: No token provided.');
    return false; // Indicate failure
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded; // Attach user to req
    console.log('Token verified for user:', decoded.uid);
    return true;
  } catch (err) {
    res.status(401).send('Unauthorized: Invalid token.');
    return false; // Indicate failure
  }
}

const rtdb = getDatabase();

// LND proxy para conectar con el Nodo Umbrel
exports.lndProxy = onRequest({ secrets: [mainMacaroon] }, (req, res) => {
  cors(req, res, async () => {
    if (!(await verifyToken(req, res))) return;

    console.log('lndProxy request:', {
      method: req.method,
      path: req.query.path,
      xForwardedUrl: req.headers['x-forwarded-url'],
      headers: req.headers,
      body: req.body,
    });


    try {
      // Use x-forwarded-url as fallback if path is undefined
      let path = req.query.path;
      if (!path || typeof path !== 'string') {
        const forwardedUrl = req.headers['x-forwarded-url'];
        if (forwardedUrl && typeof forwardedUrl === 'string') {
          const url = new URL(`http://dummy${forwardedUrl}`); // Parse as URL
          path = url.pathname.replace(/^\/api\/lndProxy/, ''); // Strip /api/lndProxy prefix
        }
        if (!path) {
          return res.status(400).json({
            error: 'Missing or invalid "path" query parameter',
            example: '?path=/v1/invoices',
          });
        }
      }

      // Reject GET on /v1/invoices
      if (req.method === 'GET' && path === '/v1/invoices') {
        return res.status(405).json({
          error: 'Method Not Allowed. Use POST to create an invoice.',
          example: 'POST /v1/invoices',
        });
      }

      // 2. Validate method
      if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
      }

      // Whitelist check for non-admin users
      const ADMIN_UIDS = [adminUid.value(), 'VldgsZCsJaOTrFT2uR2YvXxUe7o1'];
      const isAdmin = ADMIN_UIDS.includes(req.user.uid);
      const pathWithoutQuery = path.split('?')[0];

      if (!isAdmin) {
        if (req.method === 'POST') {
          const allowedPOST = ['/v1/invoices', '/v1/channels/transactions', '/v2/router/send'];
          if (!allowedPOST.includes(pathWithoutQuery)) {
            return res.status(403).json({ error: 'Forbidden: Admin access required.' });
          }
        } else if (req.method === 'GET') {
          const isInvoiceGet = pathWithoutQuery.startsWith('/v1/invoice/');
          const isFeesGet = pathWithoutQuery === '/v1/fees';
          if (!isInvoiceGet && !isFeesGet) {
            return res.status(403).json({ error: 'Forbidden: Admin access required.' });
          }
        } else {
          return res.status(403).json({ error: 'Forbidden: Method not allowed.' });
        }
      }

      // 3. Parse JSON body (only for POST)
      let body = undefined;
      if (req.method === 'POST') {
        if (!req.is('json')) {
          return res.status(400).json({ error: 'Content-Type must be application/json' });
        }
        body = req.body;
        if (!body || typeof body !== 'object') {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      }
      /*
      // Check lookup invoice by hash
      if (path.startsWith('/v1/invoice/') && req.method === 'GET') {
        // Validate hash format (base64, ~43 chars)
        const hash = path.split('/v1/invoice/')[1];
        if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) {
          return res.status(400).json({ error: 'Invalid payment hash' });
        }
      }
      */
      // 4. Forward to LND

      const lndUrlFinal = `${lndUrl.value()}${path.startsWith('/') ? '' : '/'}${path}`;
      console.log('Fetching LND:', lndUrlFinal);
      const lndResponse = await fetch(lndUrlFinal, {
        method: req.method,
        headers: {
          'Grpc-Metadata-macaroon': mainMacaroon.value(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        //agent,
        timeout: 10000, // 10s timeout
      }).catch(err => {
        console.error('Fetch error:', err);
        throw err; // Re-throw to catch block
      });

      // 5. Read response (handles both single JSON objects and streaming NDJSON responses from LND)
      const text = await lndResponse.text();
      let lndData;
      try {
        lndData = JSON.parse(text);
      } catch (parseErr) {
        // Handle streaming NDJSON (multiple JSON objects separated by newlines, e.g. /v2/router/send)
        const lines = text.trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          try {
            const parsedLines = lines.map(line => JSON.parse(line));
            // Find the last parsed object containing result or status, or pick the last object
            lndData = parsedLines[parsedLines.length - 1];
            if (lndData && lndData.result) {
              lndData = lndData.result;
            }
          } catch (lineErr) {
            console.error('LND non-JSON response:', text);
            return res.status(502).json({
              error: 'Invalid JSON response from LND',
              details: text.substring(0, 200),
            });
          }
        } else {
          return res.status(502).json({
            error: 'Empty response from LND',
          });
        }
      }

      // 6. Forward success
      res.status(lndResponse.status).json(lndData);

    } catch (err) {
      console.error('lndProxy error:', err);

      // === CLIENT-FRIENDLY ERROR HANDLING ===
      if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        return res.status(502).json({ error: 'LND TLS certificate error' });
      }
      if (err.code === 'ECONNREFUSED') {
        return res.status(502).json({ error: 'Cannot connect to LND node' });
      }
      if (err.message.includes('timeout')) {
        return res.status(504).json({ error: 'LND request timed out' });
      }

      // Generic fallback
      res.status(500).json({
        error: 'Internal proxy error',
        details: err.message,
      });
    }
  });
});

exports.tapdProxy = onRequest({ secrets: [edgeMacaroon] }, (req, res) => {
  cors(req, res, async () => {
    if (!(await verifyToken(req, res))) return;

    try {
      // Use x-forwarded-url as fallback if path is undefined
      let path = req.query.path;
      if (!path || typeof path !== 'string') {
        const forwardedUrl = req.headers['x-forwarded-url'];
        if (forwardedUrl && typeof forwardedUrl === 'string') {
          const url = new URL(`http://dummy${forwardedUrl}`); // Parse as URL
          path = url.pathname.replace(/^\/api\/tapdProxy/, ''); // Strip /api/tapdProxy prefix
        }
        if (!path) {
          return res.status(400).json({
            error: 'Missing or invalid "path" query parameter',
            example: '?path=/v1/taproot-assets',
          });
        }
      }

      // Validate method
      if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
      }

      // Whitelist check for non-admin users
      const ADMIN_UIDS = [adminUid.value(), 'VldgsZCsJaOTrFT2uR2YvXxUe7o1'];
      const isAdmin = ADMIN_UIDS.includes(req.user.uid);
      const pathWithoutQuery = path.split('?')[0];

      if (!isAdmin) {
        const allowedGET = ['/v1/taproot-assets/assets', '/v1/taproot-assets/assets/leaves'];
        if (req.method !== 'GET' || !allowedGET.includes(pathWithoutQuery)) {
          return res.status(403).json({ error: 'Forbidden: Admin access required.' });
        }
      }

      // 3. Parse JSON body (only for POST)
      let body = undefined;
      if (req.method === 'POST') {
        if (!req.is('json')) {
          return res.status(400).json({ error: 'Content-Type must be application/json' });
        }
        body = req.body;
        if (!body || typeof body !== 'object') {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      }

      // Forward to TAPD
      const lndUrlFinal = `${lndUrl.value()}${path.startsWith('/') ? '' : '/'}${path}`;

      const tapdResponse = await fetch(lndUrlFinal, {
        method: req.method,
        headers: {
          'Grpc-Metadata-macaroon': edgeMacaroon.value(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        timeout: 10000, // 10s timeout
      }).catch(err => {
        console.error('Fetch error:', err);
        throw err;
      });

      // Read response
      let tapdData;
      const contentType = tapdResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        tapdData = await tapdResponse.json();
      } else {
        const text = await tapdResponse.text();
        console.error('TAPD non-JSON response status:', tapdResponse.status);
        return res.status(502).json({
          error: 'Invalid response from TAPD',
        });
      }

      // Forward success
      res.status(tapdResponse.status).json(tapdData);

    } catch (err) {
      console.error('tapdProxy error:', err.message || err);
      res.status(500).json({
        error: 'Internal proxy error',
      });
    }
  });
});

// funcion que maneja Next.js
const app = next({
  dev: false,
  conf: { distDir: '.next' },
});
const handle = app.getRequestHandler();
const preparePromise = app.prepare();

exports.nextServer = onRequest({ memory: '512MiB' }, async (req, res) => {

  console.log('Request:', req.url);

  try {
    await preparePromise;

    handle(req, res);

  } catch (error) {
    console.error('Next.js server error:', error);
    res.status(500).send('Server Error');
  }
});

// Helper to send email
async function sendWithdrawalEmailRequest(withdrawalData, type) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser.value(),
      pass: smtpPass.value(),
    },
  });

  const mailOptions = {
    from: smtpUser.value(),
    to: adminEmail.value(),
    subject: `Rendimientos.net - New ${type} Withdrawal Request`,
    html: `
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="https://rendimientos.net/pig-180-nobg.png" alt="Rendimientos.net Logo" width="180" style="display: block; margin: 0 auto;">
      </div>
      <p><strong>Se ha recibido una solicitud de retiro!</strong></p>
      <ul>
        <li><strong>User ID:</strong> ${escapeHtml(withdrawalData.userId || 'N/A')}</li>
        <li><strong>Name:</strong> ${escapeHtml(withdrawalData.name || 'N/A')}</li>
        <li><strong>Email:</strong> ${escapeHtml(withdrawalData.userEmail || 'N/A')}</li>
        <li><strong>Amount:</strong> ${escapeHtml(withdrawalData.amount || 'N/A')}</li>
        <li><strong>Option:</strong> ${escapeHtml(withdrawalData.option || 'N/A')}</li>
        <li><strong>Requested BTC:</strong> ${escapeHtml(withdrawalData.requestedBtcAmount || 'N/A')}</li>
        <li><strong>Fee (1%):</strong> ${escapeHtml(withdrawalData.fee || 'N/A')}</li>
        <li><strong>Total BTC to Deduct:</strong> ${escapeHtml(withdrawalData.totalBtcToDeduct || 'N/A')}</li>
        <li><strong>Bank Data:</strong> ${escapeHtml(withdrawalData.bankData || 'N/A')}</li>
        <li><strong>Bank Name:</strong> ${escapeHtml(withdrawalData.bankName || 'N/A')}</li>
        <li><strong>Country:</strong> ${escapeHtml(withdrawalData.country || 'N/A')}</li>
        <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
      </ul>
      <p><strong>¡Favor procesar el retiro prontamente!</strong></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent for withdrawal: ${withdrawalData.userId}`);
  } catch (error) {
    console.error('Email send error:', error);
    // Optional: Add retry or Firebase alert integration later
  }
}

// Helper to send confirmation email to the user
async function sendUserWithdrawalEmail(withdrawalData) {
  if (!withdrawalData.userEmail) {
    console.warn('Skipping user confirmation email: no userEmail provided');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser.value(),
      pass: smtpPass.value(),
    },
  });

  const mailOptions = {
    from: smtpUser.value(),
    to: withdrawalData.userEmail,
    subject: `Rendimientos.net - Tu retiro ha sido enviado!`,
    html: `
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="https://rendimientos.net/pig-180-nobg.png" alt="Rendimientos.net Logo" width="180" style="display: block; margin: 0 auto;">
      </div>
      <p>Hello ${escapeHtml(withdrawalData.name || 'User')},</p>
      <p><strong>Has solicitado un retiro de BTC!</strong></p>
      <ul>
        <li><strong>Amount:</strong> ${escapeHtml(withdrawalData.amount || 'N/A')}</li>
        <li><strong>Option:</strong> ${escapeHtml(withdrawalData.option || 'N/A')}</li>
        <li><strong>Requested BTC:</strong> ${escapeHtml(withdrawalData.requestedBtcAmount || 'N/A')}</li>
        <li><strong>Fee (1%):</strong> ${escapeHtml(withdrawalData.fee || 'N/A')}</li>
        <li><strong>Total BTC to Deduct:</strong> ${escapeHtml(withdrawalData.totalBtcToDeduct || 'N/A')}</li>
        <ul>
            <li><strong>Precio BTC/USDT:</strong> ${escapeHtml(withdrawalData.receipt?.btcUsdt || 'N/A')}</li>
            <li><strong>Precio USDT/COP:</strong> ${escapeHtml(withdrawalData.receipt?.usdtCop || 'N/A')}</li>
        </ul>
        <li><strong>Bank Data:</strong> ${escapeHtml(withdrawalData.bankData || 'N/A')}</li>
        <li><strong>Bank Name:</strong> ${escapeHtml(withdrawalData.bankName || 'N/A')}</li>
        <li><strong>Country:</strong> ${escapeHtml(withdrawalData.country || 'N/A')}</li>
      </ul>
      <p>Pronto recibiras los fondos!</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Confirmation email sent to user: ${withdrawalData.userEmail}`);
  } catch (error) {
    console.error('User email send error:', error);
  }
}

// Trigger for Global Withdrawals (v2 syntax)
exports.notifyGlobalWithdrawal = onValueCreated(
  {
    ref: "withdrawals/{uid}/{requestId}",
    secrets: ['SMTP_PASS'],  // Pass your secret(s); add more if needed
    memory: '512MiB'
  },

  async (event) => {
    const withdrawal = event.data.val();
    if (withdrawal && withdrawal.option === 'manualWithdrawal') {
      console.log('Skipping global withdrawal notifications for manual withdrawal');
      return null;
    }
    await sendWithdrawalEmailRequest(withdrawal, 'Global');
    await sendUserWithdrawalEmail(withdrawal);
    return null;  // End cleanly
  }
);

// Trigger to notify user when withdrawal is settled

// Trigger to update BTC balance and avg buy price when a deposit is settled
exports.onDepositSettled = onValueWritten(
  {
    ref: "deposits/{uid}/{depositId}",
    memory: '512MiB'
  },
  async (event) => {
    const before = event.data.before ? event.data.before.val() || {} : {};
    const after = event.data.after ? event.data.after.val() || {} : {};

    // Only trigger if status just changed to 'settled' or was created as 'settled'
    if (after.status === 'settled' && before.status !== 'settled') {
      const btcBought = after.marketBuy?.btcBought || after.btcBought || 0;
      if (btcBought > 0) {
        const uid = event.params.uid;
        const rtdb = getDatabase();

        // 1. Increment BTCbalance
        const balanceRef = rtdb.ref(`balances/${uid}/BTCbalance`);
        await balanceRef.transaction((currentValue) => {
          const newBalance = (currentValue || 0) + btcBought;
          return parseFloat(newBalance.toFixed(8));
        });
        console.log(`Added ${btcBought} BTC to user ${uid} balance.`);

        // 2. Update totalCopInvested, totalUsdtInvested, avgBuyPrice, and avgBuyPriceUsdt
        const copAmount = after.saldoCop || parseFloat((after.amount || '0').toString().replace(/,/g, '')) || 0;
        const usdtSpent = after.marketBuy?.usdtSpent 
          || (after.marketBuy?.btcBought && after.marketBuy?.btcUsdtPrice ? after.marketBuy.btcBought * after.marketBuy.btcUsdtPrice : 0)
          || (copAmount > 0 && after.marketBuy?.usdtCopPrice ? copAmount / after.marketBuy.usdtCopPrice : 0);

        if (copAmount > 0) {
          const copRef = rtdb.ref(`balances/${uid}/totalCopInvested`);
          await copRef.transaction((current) => {
            return parseFloat(((current || 0) + copAmount).toFixed(2));
          });
        }

        if (usdtSpent > 0) {
          const usdtRef = rtdb.ref(`balances/${uid}/totalUsdtInvested`);
          await usdtRef.transaction((current) => {
            return parseFloat(((current || 0) + usdtSpent).toFixed(2));
          });
        }

        // Read current values and compute avgBuyPrice & avgBuyPriceUsdt
        const balSnap = await rtdb.ref(`balances/${uid}`).once('value');
        const bal = balSnap.val() || {};
        const totalCop = bal.totalCopInvested || 0;
        const totalUsdt = bal.totalUsdtInvested || 0;
        const totalBtc = bal.BTCbalance || 0;
        const avgCop = totalBtc > 0 ? Math.round(totalCop / totalBtc) : 0;
        const avgUsdt = totalBtc > 0 ? Math.round(totalUsdt / totalBtc) : 0;

        await rtdb.ref(`balances/${uid}/avgBuyPrice`).set(avgCop);
        await rtdb.ref(`balances/${uid}/avgBuyPriceUsdt`).set(avgUsdt);
        console.log(`Updated balances for ${uid}: avgBuyPrice=${avgCop} COP/BTC, avgBuyPriceUsdt=${avgUsdt} USDT/BTC`);
      }
    }
    return null;
  }
);

exports.notifyWithdrawalSettled = onValueWritten(
  {
    ref: "withdrawals/{uid}/{requestId}",
    secrets: ['SMTP_PASS'],
    memory: '512MiB'
  },
  async (event) => {
    const before = event.data.before ? event.data.before.val() || {} : {};
    const after = event.data.after ? event.data.after.val() || {} : {};

    // Only trigger if status just changed to 'settled' or was created as 'settled'
    if (after.status === 'settled' && before.status !== 'settled') {
      if (after.balanceAlreadyDeducted) {
        console.log(`BTC balance for user ${event.params.uid} was already reserved/deducted during transaction broadcast. Skipping duplicate deduction.`);
        return null;
      }
      // Update BTC Balance and avgBuyPrice
      const btcAmountToDeduct = parseFloat(after.totalBtcToDeduct) || 0;
      if (btcAmountToDeduct > 0) {
        const uid = event.params.uid;
        const rtdb = getDatabase();

        // Read balance BEFORE deduction to compute the fraction
        const preSnap = await rtdb.ref(`balances/${uid}`).once('value');
        const preBal = preSnap.val() || {};
        const btcBefore = (preBal.BTCbalance || 0);
        const currentCop = preBal.totalCopInvested || 0;
        const currentUsdt = preBal.totalUsdtInvested || 0;

        // Deduct BTC
        const balanceRef = rtdb.ref(`balances/${uid}/BTCbalance`);
        await balanceRef.transaction((currentValue) => {
          const newBalance = (currentValue || 0) - btcAmountToDeduct;
          return parseFloat(newBalance.toFixed(8));
        });
        console.log(`Deducted ${btcAmountToDeduct} BTC from user ${uid} balance.`);

        // Proportionally reduce totalCopInvested and totalUsdtInvested
        if (btcBefore > 0) {
          const fraction = btcAmountToDeduct / btcBefore;
          const newCop = currentCop > 0 ? parseFloat((currentCop - currentCop * fraction).toFixed(2)) : 0;
          const newUsdt = currentUsdt > 0 ? parseFloat((currentUsdt - currentUsdt * fraction).toFixed(2)) : 0;
          const btcAfter = btcBefore - btcAmountToDeduct;

          const avgCop = btcAfter > 0 ? Math.round(newCop / btcAfter) : 0;
          const avgUsdt = btcAfter > 0 ? Math.round(newUsdt / btcAfter) : 0;

          await rtdb.ref(`balances/${uid}/totalCopInvested`).set(newCop);
          await rtdb.ref(`balances/${uid}/totalUsdtInvested`).set(newUsdt);
          await rtdb.ref(`balances/${uid}/avgBuyPrice`).set(avgCop);
          await rtdb.ref(`balances/${uid}/avgBuyPriceUsdt`).set(avgUsdt);
          console.log(`Updated balances after withdrawal for ${uid}: avgBuyPrice=${avgCop} COP/BTC, avgBuyPriceUsdt=${avgUsdt} USDT/BTC`);
        }
      }
      if (!after.userEmail) {
        console.warn('Skipping settled email: no userEmail provided');
        return null;
      }

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: smtpUser.value(),
          pass: smtpPass.value(),
        },
      });

      const mailOptions = {
        from: smtpUser.value(),
        to: after.userEmail,
        subject: `Retiro Completado - Rendimientos.net`,
        html: `
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="https://rendimientos.net/pig-180-nobg.png" alt="Rendimientos.net Logo" width="180" style="display: block; margin: 0 auto;">
          </div>
          <p>Hola ${after.name || 'User'},</p>
          <p><strong>¡Excelentes noticias! Tu retiro se ha completado con éxito.</strong></p>
          <ul>
            <li><strong>Cantidad:</strong> ${after.amount || 'N/A'}</li>
            <li><strong>Destino:</strong> ${after.bankName || 'N/A'} - ${after.bankData || 'N/A'}</li>
          </ul>
          <p>Los fondos ya deberían haberse transferido. Por favor, revisa tu cuenta bancaria para verificar!</p>
          <p>Gracias por usar Rendimientos.net!</p>
        `,
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log(`Settled confirmation email sent to user: ${after.userEmail}`);
      } catch (error) {
        console.error('User settled email send error:', error);
      }
    }
    return null;  // End cleanly
  }
);

// --- NEW: Binance API Helpers ---
async function getBinanceUsdtBalance() {
  const endpoint = '/api/v3/account';
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', binanceSecretKey.value()).update(queryString).digest('hex');

  const proxyUrl = `${proxyVmUrl.value()}${endpoint}?${queryString}&signature=${signature}`;

  const response = await fetch(proxyUrl, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': binanceApiKey.value(),
      'x-binance-proxy-token': binanceProxyToken.value(),
      'Host': 'api.binance.com'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Binance Get Balance Error:', response.status, text);
    throw new Error(`Binance error: ${text}`);
  }

  const data = await response.json();
  const usdtAsset = data.balances.find(b => b.asset === 'USDT');
  return usdtAsset ? parseFloat(usdtAsset.free) : 0;
}

async function executeBinanceBuyOrder(usdtAmount) {
  const MAX_BUY_USDT = 10000; // $10,000 USDT safety cap per order
  if (typeof usdtAmount !== 'number' || isNaN(usdtAmount) || usdtAmount < 10 || usdtAmount > MAX_BUY_USDT) {
    throw new Error(`Invalid Binance buy order amount: ${usdtAmount} USDT (Allowed range: 10 - ${MAX_BUY_USDT} USDT)`);
  }
  const endpoint = '/api/v3/order';
  const timestamp = Date.now();
  // quoteOrderQty defines how much USDT we want to spend to buy BTC
  const queryString = `symbol=BTCUSDT&side=BUY&type=MARKET&quoteOrderQty=${usdtAmount}&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', binanceSecretKey.value()).update(queryString).digest('hex');

  const proxyUrl = `${proxyVmUrl.value()}${endpoint}?${queryString}&signature=${signature}`;

  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': binanceApiKey.value(),
      'x-binance-proxy-token': binanceProxyToken.value(),
      'Host': 'api.binance.com'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Binance Buy Order Error:', response.status, text);
    throw new Error(`Binance error: ${text}`);
  }

  const data = await response.json();
  // data.executedQty is the BTC amount bought
  return {
    btcBought: parseFloat(data.executedQty),
    usdtSpent: parseFloat(data.cummulativeQuoteQty),
    orderId: data.orderId,
    fills: data.fills
  };
}

// Helper to send email for successful BTC buy
async function sendUserCryptoDepositEmail(userEmail, userName, copAmount, btcAmount) {
  if (!userEmail) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser.value(),
      pass: smtpPass.value(),
    },
  });

  const formattedCop = typeof copAmount === 'number' ? copAmount.toLocaleString('de-DE') : copAmount;

  const mailOptions = {
    from: smtpUser.value(),
    to: userEmail,
    subject: `Depósito Exitoso - Saldo BTC Actualizado`,
    html: `
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="https://rendimientos.net/pig-180-nobg.png" alt="Rendimientos.net Logo" width="180" style="display: block; margin: 0 auto;">
          </div>
          <p>Hola ${escapeHtml(userName || 'User')},</p>
          <p><strong>¡Hemos recibido exitosamente tu depósito de $${escapeHtml(formattedCop)} COP!</strong></p>
          <p>¡Tu billetera de BTC ha sido acreditada con ${escapeHtml(btcAmount)} BTC!</p>
          <p>Inicia sesión en Rendimientos.net para ver tu saldo actualizado.</p>
        `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Crypto deposit confirmation email sent to user: ${userEmail}`);
  } catch (error) {
    console.error('User email send error:', error);
  }
}

// Helper to get prices from CoinGecko with Coinbase fallback
async function getPrices() {
  let btcUsdt = null;
  let usdtCop = null;

  // 1. Try CoinGecko first
  try {
    const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=usd,cop');
    if (cgRes.ok) {
      const cgData = await cgRes.json();
      btcUsdt = cgData?.bitcoin?.usd;
      usdtCop = cgData?.tether?.cop;
      if (btcUsdt && usdtCop) {
        console.log(`Fetched prices from CoinGecko. BTC/USDT: ${btcUsdt}, USDT/COP: ${usdtCop}`);
        return { btcUsdt, usdtCop, source: 'CoinGecko' };
      }
    } else {
      console.warn(`CoinGecko pricing API returned status: ${cgRes.status}`);
    }
  } catch (err) {
    console.error('Error fetching from CoinGecko:', err);
  }

  // 2. Fallback to Coinbase API
  console.log('Attempting fallback to Coinbase API...');
  try {
    const btcRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    const rateRes = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD');

    if (btcRes.ok && rateRes.ok) {
      const btcData = await btcRes.json();
      const rateData = await rateRes.json();

      btcUsdt = parseFloat(btcData?.data?.amount);
      usdtCop = parseFloat(rateData?.data?.rates?.COP);

      if (btcUsdt && usdtCop) {
        console.log(`Fetched prices from Coinbase fallback. BTC/USD: ${btcUsdt}, USD/COP: ${usdtCop}`);
        return { btcUsdt, usdtCop, source: 'Coinbase' };
      }
    } else {
      console.warn(`Coinbase fallback APIs returned error statuses. BTC: ${btcRes.status}, Rates: ${rateRes.status}`);
    }
  } catch (err) {
    console.error('Error fetching from Coinbase fallback:', err);
  }

  throw new Error('Failed to retrieve price data from both CoinGecko and Coinbase fallback APIs.');
}

// --- NEW: Bancolombia Webhook ---
async function sendDepositEmailToAdmin(depositData, matched) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser.value(),
      pass: smtpPass.value(),
    },
  });

  let btcUsdt = 'N/A';
  let usdtCop = 'N/A';
  let source = 'N/A';
  try {
    const priceData = await getPrices();
    btcUsdt = priceData.btcUsdt;
    usdtCop = priceData.usdtCop;
    source = priceData.source;
  } catch (e) {
    console.error('Error fetching prices for admin email:', e);
  }

  const statusType = matched ? 'MATCHED' : 'UNASSIGNED';
  const mailOptions = {
    from: smtpUser.value(),
    to: adminEmail.value(),
    subject: `Rendimientos.net - New ${statusType} Deposit Received`,
    text: `
      A new Bancolombia deposit has been processed.
      
      Status: ${statusType}
      Name: ${depositData.parsedName}
      Amount: $${depositData.amount}
      Date: ${depositData.date || 'N/A'}
      Time: ${depositData.time || 'N/A'}
      UID Matched: ${depositData.uid || 'N/A'}

      Current Prices (${source}):
      BTC/USDT: $${btcUsdt}
      COP/USDT: $${usdtCop}
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Admin email sent for deposit update BTC/USDT: ${btcUsdt} COP/USDT: ${usdtCop} (via ${source})`);
  } catch (error) {
    console.error('Email send error for deposit:', error);
  }
}

exports.bancolombiaWebhook = onRequest({ secrets: [smtpPass, binanceApiKey, binanceSecretKey, binanceProxyToken] }, async (req, res) => {
  // Token security check (Header x-webhook-token or Bearer or query param fallback)
  const secretToken = webhookSecret.value();
  const providedToken = req.headers['x-webhook-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.token;

  if (!providedToken || !timingSafeEqualStr(providedToken, secretToken)) {
    return res.status(403).send('Forbidden: Invalid token');
  }

  const emailBody = req.body.emailBody;
  if (!emailBody || typeof emailBody !== 'string') {
    return res.status(400).send('Missing or invalid email body');
  }

  if (!emailBody.includes("Bancolombia:") || !emailBody.includes("RENDIMIENTOS")) {
    console.log("Ignored email: Does not contain Bancolombia: RENDIMIENTOS");
    return res.status(200).send("Ignored: Not a RENDIMIENTOS deposit");
  }

  // Parse using Regex
  const nameMatch = emailBody.match(/pago de (.*?) por/i);
  const amountMatch = emailBody.match(/por \$([0-9,.,\s]+) en tu cuenta/i);
  const dateMatch = emailBody.match(/el (\d{2}\/\d{2}\/\d{4})/i);
  const timeMatch = emailBody.match(/a las (\d{2}:\d{2})/i);

  if (!nameMatch || !amountMatch) {
    console.error('Regex failed to match name or amount in Bancolombia notification');
    return res.status(400).send('Could not parse Bancolombia format');
  }

  const parsedName = nameMatch[1].trim().toUpperCase();
  const parsedAmountStr = amountMatch[1].trim();
  const numericAmount = parseFloat(parsedAmountStr.replace(/,/g, ''));
  const parsedDate = dateMatch ? dateMatch[1] : null;
  const parsedTime = timeMatch ? timeMatch[1] : null;

  // Sanity check on parsed amount (Max 50M COP per single automated deposit)
  const MAX_SINGLE_DEPOSIT_COP = 50000000;
  if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount > MAX_SINGLE_DEPOSIT_COP) {
    console.error(`Invalid or excessive deposit amount: ${numericAmount} COP`);
    return res.status(400).send('Invalid or out-of-bounds deposit amount');
  }

  // Idempotency / Deduplication check via RTDB
  const emailHash = crypto.createHash('sha256').update(`${parsedName}_${numericAmount}_${parsedDate}_${parsedTime}`).digest('hex');
  const processedRef = rtdb.ref(`processedWebhooks/${emailHash}`);
  const processedSnap = await processedRef.once('value');

  if (processedSnap.exists()) {
    console.log(`Duplicate webhook notification skipped for hash ${emailHash}`);
    return res.status(200).send('Ignored: Duplicate notification');
  }

  // Mark hash as processed immediately
  await processedRef.set({
    timestamp: admin.database.ServerValue.TIMESTAMP,
    parsedName,
    amount: numericAmount
  });

  // Search RTDB balances for a matching user name
  const balancesSnap = await rtdb.ref('balances').once('value');
  const balances = balancesSnap.val() || {};

  let matchedUid = null;
  let matchCount = 0;
  const parsedNameTokens = parsedName.split(/\s+/).slice(0, 2).join(' ');
  for (const key in balances) {
    const userBalance = balances[key];
    if (userBalance && userBalance.name) {
      const dbNameTokens = userBalance.name.trim().toUpperCase().split(/\s+/).slice(0, 2).join(' ');
      if (dbNameTokens === parsedNameTokens && parsedNameTokens.length > 0) {
        matchedUid = userBalance.uid;
        matchCount++;
      }
    }
  }

  // If multiple candidates share the exact same first 2 name tokens, force manual admin review
  if (matchCount > 1) {
    console.warn(`Ambiguous name match (${matchCount} candidates) for name: ${parsedName}. Routing to unassigned.`);
    matchedUid = null;
  }

  const depositData = {
    parsedName,
    amount: numericAmount,
    date: parsedDate,
    time: parsedTime,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    status: 'pending',
    userNotified: false
  };

  try {
    if (matchedUid) {
      console.log(`Matched incoming deposit for ${parsedName} to user UID: ${matchedUid}`);
      depositData.uid = matchedUid;
      const newRef = rtdb.ref(`deposits/${matchedUid}`).push();
      await newRef.set(depositData);

      await rtdb.ref(`deposits/all/${newRef.key}`).set(depositData);

      await sendDepositEmailToAdmin(depositData, true);

      // --- Crypto Buy Logic ---
      let cryptoBuySuccess = false;
      let marketBuyInfo = null;
      let btcBought = 0;

      try {
        const { btcUsdt, usdtCop, source } = await getPrices();
        if (usdtCop && btcUsdt) {
          const requiredUsdt = numericAmount / usdtCop;
          console.log(`Required USDT for $${numericAmount} COP at ${usdtCop} (via ${source}): ${requiredUsdt} USDT`);

          if (requiredUsdt < 10) {
            console.log('Deposit below 10 USDT threshold. Skipping crypto buy.');
            await newRef.update({ status: 'settled' });
            await rtdb.ref(`deposits/all/${newRef.key}`).update({ status: 'settled' });
          } else {
            const availableUsdt = await getBinanceUsdtBalance();
            console.log(`Available USDT on Binance: ${availableUsdt}`);

            if (availableUsdt < requiredUsdt) {
              console.warn('Insufficient USDT liquidity on Binance.');
              const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: smtpUser.value(), pass: smtpPass.value() }
              });
              await transporter.sendMail({
                from: smtpUser.value(),
                to: adminEmail.value(),
                subject: `URGENT: Insufficient Binance Liquidity`,
                text: `A deposit of $${numericAmount} COP requires ~${requiredUsdt} USDT, but Binance only has ${availableUsdt} USDT.`
              });
            } else {
              console.log('Sufficient liquidity. Executing MARKET BUY...');
              const formattedUsdt = Math.floor(requiredUsdt * 100) / 100;
              const buyResult = await executeBinanceBuyOrder(formattedUsdt);
              btcBought = buyResult.btcBought;
              console.log(`Bought ${btcBought} BTC`);

              marketBuyInfo = {
                btcBought: buyResult.btcBought,
                usdtSpent: buyResult.usdtSpent,
                orderId: buyResult.orderId,
                usdtCopPrice: usdtCop,
                btcUsdtPrice: btcUsdt,
                priceSource: source
              };

              cryptoBuySuccess = true;
            }
          }
        }
      } catch (cryptoErr) {
        console.error('Error in crypto buy process:', cryptoErr.message || cryptoErr);
        try {
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: smtpUser.value(), pass: smtpPass.value() }
          });
          await transporter.sendMail({
            from: smtpUser.value(),
            to: adminEmail.value(),
            subject: `ALERT: Deposit Crypto Purchase Failed`,
            text: `Error during crypto buy process for deposit of $${numericAmount} COP:\n\n${cryptoErr.message || cryptoErr}`
          });
        } catch (mailErr) {
          console.error('Failed to send error email to admin:', mailErr);
        }
      }

      if (cryptoBuySuccess && marketBuyInfo) {
        console.log('Finalizing deposit: Setting status to settled and adding marketBuy info...');
        await newRef.update({ status: 'settled', marketBuy: marketBuyInfo });
        await rtdb.ref(`deposits/all/${newRef.key}`).update({ status: 'settled', marketBuy: marketBuyInfo });

        try {
          const userRecord = await admin.auth().getUser(matchedUid);
          if (userRecord && userRecord.email) {
            await sendUserCryptoDepositEmail(userRecord.email, parsedName, numericAmount, btcBought);
          }
        } catch (userErr) {
          console.error('Error fetching user email for notification:', userErr);
        }
      }

    } else {
      console.log(`Unassigned incoming deposit for name: ${parsedName}`);
      depositData.adminNotified = false;
      depositData.status = 'unassigned';
      const newRef = rtdb.ref(`unassignedDeposits`).push();
      await newRef.set(depositData);

      await sendDepositEmailToAdmin(depositData, false);
    }

    res.status(200).send('Successfully processed integration');
  } catch (err) {
    console.error('Firebase save error:', err.message || err);
    res.status(500).send('Database error');
  }
});
exports.createManualDeposit = onRequest({ secrets: [smtpPass, binanceProxyToken] }, (req, res) => {
  cors(req, res, async () => {
    // 1. Verify token
    if (!(await verifyToken(req, res))) return;

    // 2. Check if user is admin
    if (req.user.uid !== adminUid.value() && req.user.uid !== 'VldgsZCsJaOTrFT2uR2YvXxUe7o1') {
      return res.status(403).send('Forbidden: Only admins can perform manual deposits.');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Use POST.');
    }

    try {
      const { uid, amount, time, date, usdtCopRate, feeCop } = req.body;

      if (!uid || !amount || !time) {
        return res.status(400).send('Missing required fields: uid, amount, time');
      }

      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).send('Invalid amount');
      }

      const numericFeeCop = feeCop ? parseFloat(feeCop) : 0;
      if (isNaN(numericFeeCop) || numericFeeCop < 0) {
        return res.status(400).send('Invalid feeCop value');
      }
      if (numericFeeCop >= numericAmount) {
        return res.status(400).send('Fee cannot be greater than or equal to total deposit amount');
      }

      const netCop = numericAmount - numericFeeCop;

      // Time format: HH:MM or HH:MM:SS
      let normalizedTime = time;
      if (normalizedTime.split(':').length === 2) {
        normalizedTime += ':00';
      }

      // Default date to today in America/Bogota
      let normalizedDate = date;
      if (!normalizedDate) {
        normalizedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // returns YYYY-MM-DD
      }

      // Build the Bogota timestamp
      const datetimeStr = `${normalizedDate}T${normalizedTime}-05:00`;
      const timestamp = new Date(datetimeStr).getTime();

      if (isNaN(timestamp)) {
        return res.status(400).send('Invalid Date/Time format');
      }

      // A. Get USDT/COP rate
      let finalUsdtCopRate = usdtCopRate ? parseFloat(usdtCopRate) : null;
      let copSource = 'Manual Override';
      if (!finalUsdtCopRate) {
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cop');
          if (cgRes.ok) {
            const cgData = await cgRes.json();
            finalUsdtCopRate = cgData?.tether?.cop;
            copSource = 'CoinGecko';
          }
        } catch (err) {
          console.warn('CoinGecko fetch failed:', err.message);
        }

        if (!finalUsdtCopRate) {
          try {
            const cbRes = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD');
            if (cbRes.ok) {
              const cbData = await cbRes.json();
              finalUsdtCopRate = parseFloat(cbData?.data?.rates?.COP);
              copSource = 'Coinbase Fallback';
            }
          } catch (err) {
            console.error('Coinbase fetch failed:', err.message);
          }
        }
      }

      if (!finalUsdtCopRate) {
        return res.status(500).send('Failed to retrieve USDT/COP exchange rate');
      }

      // B. Get BTC/USDT price from Binance at timestamp (via proxy)
      let btcUsdtPrice = null;
      let btcSource = 'Binance (via Proxy)';
      try {
        const endpoint = '/api/v3/klines';
        const queryString = `symbol=BTCUSDT&interval=1m&startTime=${timestamp}&limit=1`;
        const proxyUrl = `${proxyVmUrl.value()}${endpoint}?${queryString}`;
        const response = await fetch(proxyUrl, {
          method: 'GET',
          headers: {
            'x-binance-proxy-token': binanceProxyToken.value(),
            'Host': 'api.binance.com'
          }
        });

        if (response.ok) {
          const klines = await response.json();
          if (klines && klines.length > 0) {
            btcUsdtPrice = parseFloat(klines[0][4]);
          }
        }
      } catch (err) {
        console.warn('Proxy BTC lookup failed:', err.message);
      }

      if (!btcUsdtPrice) {
        // Fallback to CoinGecko current price
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
          if (cgRes.ok) {
            const cgData = await cgRes.json();
            btcUsdtPrice = cgData?.bitcoin?.usd;
            btcSource = 'CoinGecko (Current Fallback)';
          }
        } catch (err) {
          console.error('CoinGecko fallback failed:', err.message);
        }
      }

      if (!btcUsdtPrice) {
        return res.status(500).send('Failed to retrieve BTC price');
      }

      // C. Perform calculations using netCop
      const usdtSpent = Math.floor((netCop / finalUsdtCopRate) * 100) / 100;
      const btcBought = parseFloat((usdtSpent / btcUsdtPrice).toFixed(8));
      const orderId = '2289270283' + Math.floor(1000000000 + Math.random() * 9000000000);

      // D. Get user details from balances
      const balancesRef = rtdb.ref(`balances/${uid}`);
      const balanceSnap = await balancesRef.once('value');
      const userBalance = balanceSnap.val();

      if (!userBalance) {
        return res.status(404).send(`User profile not found in /balances/${uid}`);
      }

      const userName = userBalance.name || 'MANUAL DEPOSIT';

      // Helper function to format YYYY-MM-DD to DD-MMM-YYYY
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const [y, m, d] = normalizedDate.split('-');
      const displayDate = `${d.padStart(2, '0')}-${months[parseInt(m, 10) - 1]}-${y}`;

      // E. Write deposit record
      const newRef = rtdb.ref(`deposits/${uid}`).push();
      const depositId = newRef.key;

      const depositData = {
        date: displayDate,
        depositId: depositId,
        marketBuy: {
          btcBought,
          btcUsdtPrice,
          orderId,
          priceSource: btcSource.includes('Binance') ? 'Binance' : 'CoinGecko',
          usdtCopPrice: finalUsdtCopRate,
          usdtSpent
        },
        parsedName: userName.toUpperCase(),
        amount: numericAmount,
        fee: numericFeeCop,
        saldoCop: netCop,
        status: 'settled',
        time: normalizedTime,
        timestamp: timestamp,
        uid: uid,
        userNotified: false
      };

      await newRef.set(depositData);
      await rtdb.ref(`deposits/all/${depositId}`).set(depositData);

      // F. Send notification email if possible
      let emailSent = false;
      try {
        const userRecord = await admin.auth().getUser(uid);
        if (userRecord && userRecord.email) {
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: smtpUser.value(),
              pass: smtpPass.value()
            }
          });

          const formattedCop = numericAmount.toLocaleString('de-DE');
          const mailOptions = {
            from: smtpUser.value(),
            to: userRecord.email,
            subject: `Depósito Exitoso - Saldo BTC Actualizado`,
            html: `
                  <div style="text-align: center; margin-bottom: 20px;">
                    <img src="https://rendimientos.net/pig-180-nobg.png" alt="Rendimientos.net Logo" width="180" style="display: block; margin: 0 auto;">
                  </div>
                  <p>Hola ${userName || 'User'},</p>
                  <p><strong>¡Hemos recibido exitosamente tu depósito de $${formattedCop} COP!</strong></p>
                  <p>¡Tu billetera de BTC ha sido acreditada con ${btcBought} BTC!</p>
                  <p>Inicia sesión en Rendimientos.net para ver tu saldo actualizado.</p>
                `
          };

          await transporter.sendMail(mailOptions);
          emailSent = true;
          await rtdb.ref(`deposits/${uid}/${depositId}`).update({ userNotified: true });
          await rtdb.ref(`deposits/all/${depositId}`).update({ userNotified: true });
        }
      } catch (err) {
        console.warn('Skipping email notification:', err.message);
      }

      res.status(200).json({
        success: true,
        depositId,
        btcBought,
        btcUsdtPrice,
        usdtCopPrice: finalUsdtCopRate,
        usdtSpent,
        netCop,
        fee: numericFeeCop,
        emailSent
      });

    } catch (err) {
      console.error('Manual deposit function error:', err.message || err);
      res.status(500).send('Internal Server Error');
    }
  });
});

exports.createManualWithdrawal = onRequest({ secrets: [smtpPass] }, (req, res) => {
  cors(req, res, async () => {
    // 1. Verify token
    if (!(await verifyToken(req, res))) return;

    // 2. Check if user is admin
    if (req.user.uid !== adminUid.value() && req.user.uid !== 'VldgsZCsJaOTrFT2uR2YvXxUe7o1') {
      return res.status(403).send('Forbidden: Only admins can perform manual withdrawals.');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Use POST.');
    }

    try {
      const { uid, amountCop, amountBtc, feeBtc, date, time, destinationAccount, destinationAccountDescription, btcUsdtPrice, usdtCopRate } = req.body;

      if (!uid || !amountCop || !amountBtc || !time || !destinationAccount) {
        return res.status(400).send('Missing required fields');
      }

      const numericCop = parseFloat(amountCop);
      const numericBtc = parseFloat(amountBtc);
      const numericFeeBtc = feeBtc ? parseFloat(feeBtc) : 0;
      if (isNaN(numericCop) || numericCop <= 0 || isNaN(numericBtc) || numericBtc <= 0 || isNaN(numericFeeBtc) || numericFeeBtc < 0) {
        return res.status(400).send('Invalid amount or fee values');
      }

      const totalBtcToDeduct = parseFloat((numericBtc + numericFeeBtc).toFixed(8));

      // Time format: HH:MM or HH:MM:SS
      let normalizedTime = time;
      if (normalizedTime.split(':').length === 2) {
        normalizedTime += ':00';
      }

      // Default date to today in America/Bogota
      let normalizedDate = date;
      if (!normalizedDate) {
        normalizedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // returns YYYY-MM-DD
      }

      // Build the Bogota timestamp
      const datetimeStr = `${normalizedDate}T${normalizedTime}-05:00`;
      const timestamp = new Date(datetimeStr).getTime();

      if (isNaN(timestamp)) {
        return res.status(400).send('Invalid Date/Time format');
      }

      // Read user details from balances
      const balancesRef = rtdb.ref(`balances/${uid}`);
      const balanceSnap = await balancesRef.once('value');
      const userBalance = balanceSnap.val();

      if (!userBalance) {
        return res.status(404).send(`User profile not found in /balances/${uid}`);
      }

      // Check current user balance before manual withdrawal against total required deduction (amount + fee)
      const currentBtc = parseFloat(userBalance.BTCbalance ?? userBalance.BTCBalance ?? userBalance.btcBalance ?? 0);
      if (currentBtc < totalBtcToDeduct) {
        return res.status(400).send(`Insufficient user balance. Available: ${currentBtc} BTC, Total Required (incl. fee): ${totalBtcToDeduct} BTC.`);
      }

      const userName = userBalance.name || 'MANUAL WITHDRAWAL';
      let userEmail = '';
      try {
        const userRecord = await admin.auth().getUser(uid);
        if (userRecord && userRecord.email) {
          userEmail = userRecord.email;
        }
      } catch (authErr) {
        console.warn('Could not fetch user email from auth:', authErr.message);
      }

      // Helper function to format YYYY-MM-DD to DD-MMM-YYYY
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const [y, m, d] = normalizedDate.split('-');
      const displayDate = `${d.padStart(2, '0')}-${months[parseInt(m, 10) - 1]}-${y}`;

      // Write withdrawal record
      const withdrawalRef = rtdb.ref(`withdrawals/${uid}`).push();
      const requestId = withdrawalRef.key;

      const withdrawalData = {
        uid: uid,
        userEmail: userEmail,
        name: userName,
        amount: numericCop,
        saldoCop: numericCop,
        requestedBtcAmount: numericBtc,
        fee: numericFeeBtc,
        totalBtcToDeduct: totalBtcToDeduct,
        bankData: destinationAccountDescription || '',
        bankName: destinationAccount,
        option: 'manualWithdrawal',
        timestamp: timestamp,
        status: 'settled',
        date: displayDate,
        time: normalizedTime,
        userNotified: false,
        receipt: {
          btcUsdt: btcUsdtPrice || 0,
          usdtCop: usdtCopRate || 0
        }
      };

      await rtdb.ref(`withdrawals/${uid}/${requestId}`).set(withdrawalData);

      res.status(200).json({
        success: true,
        requestId,
        requestedBtc: numericBtc,
        feeBtc: numericFeeBtc,
        deductedBtc: totalBtcToDeduct,
        deductedCop: numericCop
      });

    } catch (err) {
      console.error('Manual withdrawal function error:', err.message || err);
      res.status(500).send('Internal Server Error');
    }
  });
});

exports.testBinanceProxy = onRequest({ secrets: [binanceApiKey, binanceSecretKey, binanceProxyToken] }, async (req, res) => {
  try {
    const balance = await getBinanceUsdtBalance();
    res.status(200).send(`Proxy connection successful! Available USDT balance: ${balance}`);
  } catch (error) {
    console.error('Test Proxy Error:', error.message || error);
    res.status(500).send('Error testing proxy');
  }
});

exports.getNewDepositAddress = onRequest({ secrets: ['MAIN_LND_MACAROON'] }, (req, res) => {
  cors(req, res, async () => {
    if (!(await verifyToken(req, res))) return;

    if (isRateLimited(`address_${req.user.uid}`, 5, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Use POST.');
    }

    try {
      const uid = req.user.uid;
      const lndUrlFinal = `${lndUrl.value()}/v1/newaddress?type=WITNESS_PUBKEY_HASH`;
      console.log(`Generating new address for user ${uid}`);

      const response = await fetch(lndUrlFinal, {
        method: 'GET',
        headers: {
          'Grpc-Metadata-macaroon': mainMacaroon.value(),
        }
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('LND NewAddress error:', response.status);
        return res.status(502).json({ error: 'Failed to generate address from node' });
      }

      const data = await response.json();
      const address = data.address;
      if (!address) {
        return res.status(502).json({ error: 'No address returned from node' });
      }

      // Save to global lookup
      await rtdb.ref(`btcAddresses/${address}`).set({
        uid: uid,
        generatedAt: Date.now()
      });

      // Update user balances profile
      await rtdb.ref(`balances/${uid}/btcDepositAddress`).set(address);
      await rtdb.ref(`balances/${uid}/btcDepositAddresses/${address}`).set({
        generatedAt: Date.now()
      });

      console.log(`Successfully generated and mapped address for user ${uid}`);
      return res.status(200).json({ success: true, address });

    } catch (error) {
      console.error('Error in getNewDepositAddress:', error.message || error);
      return res.status(500).send('Internal Server Error');
    }
  });
});

exports.processOnChainWithdrawal = onRequest({ secrets: ['MAIN_LND_MACAROON', 'SMTP_PASS'] }, (req, res) => {
  cors(req, res, async () => {
    if (!(await verifyToken(req, res))) return;

    if (isRateLimited(`withdrawal_${req.user.uid}`, 5, 60000)) {
      return res.status(429).json({ error: 'Too many withdrawal requests. Please try again later.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Use POST.');
    }

    const { address, amountBtc, feeTier } = req.body || {};
    if (!address || !amountBtc || !feeTier) {
      return res.status(400).json({ error: 'Missing required parameters: address, amountBtc, feeTier' });
    }

    // 1. Validate Address
    const { validate } = require('bitcoin-address-validation');
    const isValidAddress = validate(address, 'mainnet');
    if (!isValidAddress) {
      return res.status(400).json({ error: 'Invalid Bitcoin mainnet address.' });
    }

    // 2. Validate Amount
    const amountBtcNum = parseFloat(amountBtc);
    if (isNaN(amountBtcNum) || amountBtcNum <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' });
    }

    // 3. Validate Fee Tier
    const allowedTiers = ['high', 'medium', 'low'];
    if (!allowedTiers.includes(feeTier)) {
      return res.status(400).json({ error: 'Invalid feeTier. Must be high, medium, or low.' });
    }

    try {
      const uid = req.user.uid;

      // 4. Fetch recommended precise fees from Mempool.space
      let feeRate = 15.0; // fallback
      try {
        const feeRes = await fetch('https://mempool.space/api/v1/fees/precise');
        if (feeRes.ok) {
          const fees = await feeRes.json();
          if (feeTier === 'high') feeRate = parseFloat(fees.fastestFee);
          else if (feeTier === 'medium') feeRate = parseFloat(fees.halfHourFee);
          else feeRate = parseFloat(fees.hourFee);
        } else {
          console.warn('Mempool.space precise fee API failed, using fallback fee rate of 15 sat/vB.');
        }
      } catch (feeErr) {
        console.warn('Error fetching fees from Mempool.space:', feeErr.message);
      }

      // 5. Calculate Satoshis and Fees
      const amountSats = Math.round(amountBtcNum * 100000000);
      const platformFeeSats = Math.ceil(amountSats * 0.01);
      const networkFeeSats = Math.ceil(148 * feeRate); // estimate 148 vBytes size
      const totalDeductSats = amountSats + platformFeeSats + networkFeeSats;
      const totalDeductBtc = parseFloat((totalDeductSats / 100000000).toFixed(8));

      const requestedBtc = parseFloat((amountSats / 100000000).toFixed(8));
      const feeBtc = parseFloat(((platformFeeSats + networkFeeSats) / 100000000).toFixed(8));

      // 6. Balance Reservation (Atomic Transaction)
      let reservedBalanceSuccess = false;
      let availableBtcBefore = 0;

      const txResult = await rtdb.ref(`balances/${uid}/BTCbalance`).transaction((currentValue) => {
        availableBtcBefore = parseFloat(currentValue || 0);
        if (availableBtcBefore < totalDeductBtc) {
          return; // Abort transaction if balance is insufficient
        }
        return parseFloat((availableBtcBefore - totalDeductBtc).toFixed(8));
      });

      if (!txResult.committed) {
        return res.status(400).json({ error: `Insufficient BTC balance. Required: ${totalDeductBtc} BTC, Available: ${availableBtcBefore} BTC.` });
      }
      reservedBalanceSuccess = true;

      console.log(`User ${uid} balance atomically reserved (${totalDeductBtc} BTC). Broadcasting tx to ${address}...`);

      // 7. Call LND SendCoins REST API
      const lndUrlFinal = `${lndUrl.value()}/v1/transactions`;
      let txid = '';
      try {
        const lndRes = await fetch(lndUrlFinal, {
          method: 'POST',
          headers: {
            'Grpc-Metadata-macaroon': mainMacaroon.value(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            addr: address,
            amount: amountSats.toString(),
            sat_per_vbyte: Math.round(feeRate).toString()
          })
        });

        if (!lndRes.ok) {
          const errText = await lndRes.text();
          throw new Error(errText || `LND HTTP error ${lndRes.status}`);
        }

        const lndData = await lndRes.json();
        if (lndData.payment_error) {
          throw new Error(lndData.payment_error);
        }
        txid = lndData.txid;
        if (!txid) {
          throw new Error('No txid returned from LND SendCoins');
        }
      } catch (broadcastErr) {
        console.error('LND transaction broadcast failed:', broadcastErr.message);

        // Roll back reserved balance
        if (reservedBalanceSuccess) {
          await rtdb.ref(`balances/${uid}/BTCbalance`).transaction((val) => {
            const current = parseFloat(val || 0);
            return parseFloat((current + totalDeductBtc).toFixed(8));
          });
          console.log(`Rollback: Restored ${totalDeductBtc} BTC to user ${uid} balance.`);
        }

        return res.status(502).json({ error: 'Failed to broadcast transaction via LND node' });
      }

      console.log(`Successfully broadcasted transaction ${txid} for withdrawal.`);

      // 8. Fetch prices to calculate COP equivalent
      const prices = await getPrices().catch(() => ({ btcUsdt: 0, usdtCop: 0 }));
      const btcUsdt = prices.btcUsdt || 0;
      const usdtCop = prices.usdtCop || 0;
      const copEquivalent = Math.round(requestedBtc * btcUsdt * usdtCop);

      // 9. Write settled withdrawal record with balanceAlreadyDeducted: true
      const withdrawalRef = rtdb.ref(`withdrawals/${uid}`).push();
      const requestId = withdrawalRef.key;

      const userRecord = await admin.auth().getUser(uid).catch(() => ({ email: 'email' }));
      const userBalanceSnap = await rtdb.ref(`balances/${uid}`).once('value');
      const userName = userBalanceSnap.val()?.name || 'Unknown';

      const withdrawalData = {
        uid: uid,
        userEmail: userRecord.email || 'email',
        name: userName,
        amount: copEquivalent,
        requestedBtcAmount: requestedBtc,
        fee: feeBtc,
        totalBtcToDeduct: totalDeductBtc,
        balanceAlreadyDeducted: true,
        bankData: address,
        bankName: 'Bitcoin On-Chain',
        option: 'btcOnChain',
        timestamp: Date.now(),
        status: 'settled',
        txid: txid,
        requestId: requestId,
        receipt: {
          btcUsdt: btcUsdt,
          usdtCop: usdtCop,
          feeRate: feeRate
        }
      };

      await rtdb.ref(`withdrawals/${uid}/${requestId}`).set(withdrawalData);
      
      return res.status(200).json({ success: true, txid, requestId });

    } catch (error) {
      console.error('Error in processOnChainWithdrawal:', error.message || error);
      return res.status(500).json({ error: 'Internal Server Error during on-chain processing' });
    }
  });
});

exports.syncOnChainDeposits = onSchedule(
  {
    schedule: "every 5 minutes",
    secrets: ['MAIN_LND_MACAROON', 'SMTP_PASS'],
    memory: '512MiB'
  },
  async (event) => {
    console.log('--- STARTING ON-CHAIN DEPOSIT SYNC CRON ---');
    try {
      // 1. Fetch address mappings
      const btcAddressesSnap = await rtdb.ref('btcAddresses').once('value');
      const addressMap = btcAddressesSnap.val() || {};
      const activeAddresses = Object.keys(addressMap);

      if (activeAddresses.length === 0) {
        console.log('No deposit addresses generated in RTDB. Skipping sync.');
        return null;
      }

      // 2. Fetch LND transactions
      const lndUrlFinal = `${lndUrl.value()}/v1/transactions`;
      const response = await fetch(lndUrlFinal, {
        method: 'GET',
        headers: {
          'Grpc-Metadata-macaroon': mainMacaroon.value()
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch transactions from LND: ${errText}`);
      }

      const lndData = await response.json();
      const transactions = lndData.transactions || [];
      console.log(`Fetched ${transactions.length} total on-chain transactions from LND.`);

      // 3. Process each LND transaction
      for (const tx of transactions) {
        const amountSats = parseInt(tx.amount || '0');
        // Deposits have positive amount in LND
        if (amountSats <= 0) continue;

        const destAddresses = tx.dest_addresses || [];
        const txid = tx.tx_hash;

        for (const addr of destAddresses) {
          if (addressMap[addr]) {
            const { uid } = addressMap[addr];
            console.log(`Matched transaction ${txid} output to address ${addr} owned by user ${uid}`);

            const confirmations = parseInt(tx.num_confirmations || '0');
            const targetStatus = confirmations >= 1 ? 'settled' : 'pending';

            // Check if already processed
            const depositRef = rtdb.ref(`deposits/${uid}/${txid}`);
            const depositSnap = await depositRef.once('value');
            const existingDeposit = depositSnap.val();

            if (!existingDeposit) {
              // Fetch prices to calculate COP value
              const prices = await getPrices().catch(() => ({ btcUsdt: 0, usdtCop: 0 }));
              const btcUsdt = prices.btcUsdt || 0;
              const usdtCop = prices.usdtCop || 0;

              const btcBought = parseFloat((amountSats / 100000000).toFixed(8));
              const copAmount = Math.round(btcBought * btcUsdt * usdtCop);

              const userBalanceSnap = await rtdb.ref(`balances/${uid}`).once('value');
              const userName = userBalanceSnap.val()?.name || 'Unknown';

              const depositData = {
                uid: uid,
                depositId: txid,
                address: addr,
                amount: copAmount,
                saldoCop: copAmount,
                btcBought: btcBought,
                txid: txid,
                confirmations: confirmations,
                status: targetStatus,
                timestamp: parseInt(tx.time_stamp) * 1000,
                type: 'onchain_deposit',
                date: new Date(parseInt(tx.time_stamp) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }),
                time: new Date(parseInt(tx.time_stamp) * 1000).toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Bogota' }),
                userNotified: false,
                parsedName: userName.toUpperCase()
              };

              console.log(`Creating new ${targetStatus} deposit for user ${uid}.`);
              await depositRef.set(depositData);
              await rtdb.ref(`deposits/all/${txid}`).set(depositData);

              // If it settled immediately, trigger email
              if (targetStatus === 'settled') {
                const userRecord = await admin.auth().getUser(uid).catch(() => null);
                if (userRecord && userRecord.email) {
                  await sendUserCryptoDepositEmail(userRecord.email, userName, copAmount, btcBought);
                  await depositRef.update({ userNotified: true });
                  await rtdb.ref(`deposits/all/${txid}`).update({ userNotified: true });
                }
              }
            } else if (existingDeposit.status === 'pending' && targetStatus === 'settled') {
              console.log(`Deposit ${txid} transitioned from pending to settled. Updating balance and sending email.`);
              
              // Update status and confirmations
              const updates = { status: 'settled', confirmations: confirmations };
              await depositRef.update(updates);
              await rtdb.ref(`deposits/all/${txid}`).update(updates);

              // Send email
              const userRecord = await admin.auth().getUser(uid).catch(() => null);
              if (userRecord && userRecord.email) {
                await sendUserCryptoDepositEmail(userRecord.email, existingDeposit.parsedName || 'User', existingDeposit.amount, existingDeposit.btcBought);
                await depositRef.update({ userNotified: true });
                await rtdb.ref(`deposits/all/${txid}`).update({ userNotified: true });
              }
            } else {
              // Update confirmations count if it changed but status is same
              if (existingDeposit.confirmations !== confirmations) {
                await depositRef.update({ confirmations: confirmations });
                await rtdb.ref(`deposits/all/${txid}`).update({ confirmations: confirmations });
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Error in syncOnChainDeposits cron job:', err);
    }
    console.log('--- ON-CHAIN DEPOSIT SYNC CRON COMPLETED ---');
    return null;
  }
);
