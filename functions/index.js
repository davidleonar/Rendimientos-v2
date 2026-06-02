const functions = require('firebase-functions');
const { google } = require('googleapis');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const cors = require('cors')({ origin: true });
const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');

const { defineString, defineSecret } = require('firebase-functions/params');
const { onValueCreated, onValueUpdated, onValueWritten } = require('firebase-functions/v2/database');
//const { https: { onRequest } } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');

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

// Helper function to fetch all spreadsheet data
async function fetchAllSpreadsheetData(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('No data found in spreadsheet.');
      return [];
    }

    const headers = rows[0];
    const data = rows.slice(1).map((row) => {
      const rowData = {};
      headers.forEach((header, index) => {
        rowData[header] = row[index] || null;
      });
      return rowData;
    });

    return data;
  } catch (error) {
    console.error('Error fetching spreadsheet data:', error);
    throw error;
  }
}


// Google Sheets configuration
const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    keyFile: './serviceAccountKey.json', // Update with the path to your service account file
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  }),
});


// Helper function to fetch and filter spreadsheet data by ID
async function fetchSpreadsheetDataById(spreadsheetId, range, id) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('No data found in spreadsheet.');
      throw new Error('No data found.');
    }

    const headers = rows[0];
    const data = rows.slice(1);

    const idColumnIndex = headers.findIndex(
      (header) => header.toLowerCase() === 'id'
    );
    if (idColumnIndex === -1) {
      throw new Error('No "id" column found in spreadsheet headers.');
    }

    const filteredData = data
      .filter((row) => row[idColumnIndex] && row[idColumnIndex].toString() === id.toString())
      .map((row) => {
        const rowData = {};
        headers.forEach((header, index) => {
          rowData[header] = row[index] || null;
        });
        return rowData;
      });

    return filteredData;
  } catch (error) {
    console.error('Error fetching spreadsheet data:', error);
    throw error;
  }
}

exports.getDataById = onRequest((req, res) => {
  cors(req, res, async () => {

    // The verifyToken middleware now handles sending the response on failure.
    // If it returns false, we just stop.
    if (!(await verifyToken(req, res))) return;

    console.log(`Request authenticated for user: ${req.user.uid}`);

    if (req.method !== 'GET') {
      return res.status(405).send('Method Not Allowed. Use GET.');
    }

    const id = req.query.id;
    if (!id) {
      return res.status(400).send('Missing "id" parameter in query.');
    }

    try {
      const spreadsheetId = '1Etee_5MhgVS6ozENYqcagoqjq4z3a64mn1WD6y_aCIg';
      const range = 'Sheet1!A1:G50';

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const rows = response.data.values;

      if (!rows || rows.length === 0) {
        console.log('No data found in spreadsheet.');
        return res.status(404).send('No data found.');
      }

      const headers = rows[0];
      const data = rows.slice(1);

      const idColumnIndex = headers.findIndex(
        (header) => header.toLowerCase() === 'id'
      );
      if (idColumnIndex === -1) {
        return res.status(500).send('No "id" column found in spreadsheet headers.');
      }

      const uidColumnIndex = headers.findIndex(
        (header) => header.toLowerCase() === 'uid'
      );
      if (uidColumnIndex === -1) {
        return res.status(500).send('No "uid" column found in spreadsheet headers.');
      }

      const isAdmin = req.user.uid === adminUid.value();

      const filteredData = data
        .filter((row) => {
          // Check if ID matches
          if (!row[idColumnIndex] || row[idColumnIndex].toString() !== id.toString()) {
            return false;
          }
          // Validate UID matches req.user.uid, bypass if Admin
          if (!isAdmin) {
            const rowUid = row[uidColumnIndex];
            if (!rowUid || rowUid.toString() !== req.user.uid) {
              return false;
            }
          }
          return true;
        })
        .map((row) => {
          const rowData = {};
          headers.forEach((header, index) => {
            rowData[header] = row[index] || null;
          });
          return rowData;
        });

      if (filteredData.length === 0) {
        return res.status(404).send(`No data found for id: ${id}`);
      }

      console.log("Successfully fetched data:", filteredData);

      res.status(200).json({
        success: true,
        data: filteredData,
      });
    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).send('Internal Server Error');
    }
  });
});

// New function: getMovementsById
exports.getMovementsById = onRequest((req, res) => {
  cors(req, res, async () => {
    if (!(await verifyToken(req, res))) return;
    if (req.method !== 'GET') {
      return res.status(405).send('Method Not Allowed. Use GET.');
    }

    const id = req.query.id;
    if (!id) {
      return res.status(400).send('Missing "id" parameter in query.');
    }

    try {
      const spreadsheetId = '1Ke7ftv8OSmec6yqpjMzOXIqLaK24Dp8S4Pc5JEmCMlE';
      const range = 'Sheet1!A1:H120'; // Adjust if movements are in a different sheet/range

      const filteredData = await fetchSpreadsheetDataById(spreadsheetId, range, id);

      if (filteredData.length === 0) {
        return res.status(404).send(`No movements found for id: ${id}`);
      }

      res.status(200).json({
        success: true,
        data: filteredData,
      });
    } catch (error) {
      console.error('Error in getMovementsById:', error);
      res.status(500).send('Internal Server Error');
    }
  });
});

// LND proxy para conectar con el Nodo Umbrel
exports.lndProxy = onRequest({ secrets: [mainMacaroon] }, (req, res) => {
  cors(req, res, async () => {
    //if (!(await verifyToken(req, res))) return;

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
      });;

      // 5. Read response
      let lndData;
      const contentType = lndResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        lndData = await lndResponse.json();
      } else {
        const text = await lndResponse.text();
        console.error('LND non-JSON response:', text);
        return res.status(502).json({
          error: 'Invalid response from LND',
          details: text.substring(0, 200),
        });
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

    console.log('tapdProxy request:', {
      method: req.method,
      path: req.query.path,
      xForwardedUrl: req.headers['x-forwarded-url'],
      headers: req.headers,
      body: req.body,
    });

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
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed. Use GET, POST, or DELETE.' });
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

      //Forward to TAPD
      const lndUrlFinal = `${lndUrl.value()}${path.startsWith('/') ? '' : '/'}${path}`;
      console.log('Fetching TAPD:', lndUrlFinal);

      const tapdResponse = await fetch(lndUrlFinal, {
        method: req.method,
        headers: {
          'Grpc-Metadata-macaroon': edgeMacaroon.value(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        //agent,
        timeout: 10000, // 10s timeout
      }).catch(err => {
        console.error('Fetch error:', err);
        throw err; // Re-throw to catch block
      });;

      //Read response
      let tapdData;
      const contentType = tapdResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        tapdData = await tapdResponse.json();
      } else {
        const text = await tapdResponse.text();
        console.error('TAPD non-JSON response:', text);
        return res.status(502).json({
          error: 'Invalid response from TAPD',
          details: text.substring(0, 200),
        });
      }

      //Forward success
      console.log('tapdData Response:', tapdData);
      res.status(tapdResponse.status).json(tapdData);

    } catch (err) {
      console.error('tapdProxy error:', err);
      res.status(500).json({
        error: 'Internal proxy error',
        details: err.message,
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
        <li><strong>User ID:</strong> ${withdrawalData.userId || 'N/A'}</li>
        <li><strong>Name:</strong> ${withdrawalData.name || 'N/A'}</li>
        <li><strong>Email:</strong> ${withdrawalData.userEmail || 'N/A'}</li>
        <li><strong>Amount:</strong> ${withdrawalData.amount || 'N/A'}</li>
        <li><strong>Option:</strong> ${withdrawalData.option || 'N/A'}</li>
        <li><strong>Requested BTC:</strong> ${withdrawalData.requestedBtcAmount || 'N/A'}</li>
        <li><strong>Fee (1%):</strong> ${withdrawalData.fee || 'N/A'}</li>
        <li><strong>Total BTC to Deduct:</strong> ${withdrawalData.totalBtcToDeduct || 'N/A'}</li>
        <li><strong>Bank Data:</strong> ${withdrawalData.bankData || 'N/A'}</li>
        <li><strong>Bank Name:</strong> ${withdrawalData.bankName || 'N/A'}</li>
        <li><strong>Country:</strong> ${withdrawalData.country || 'N/A'}</li>
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
      <p>Hello ${withdrawalData.name || 'User'},</p>
      <p><strong>Has solicitado un retiro de BTC!</strong></p>
      <ul>
        <li><strong>Amount:</strong> ${withdrawalData.amount || 'N/A'}</li>
        <li><strong>Option:</strong> ${withdrawalData.option || 'N/A'}</li>
        <li><strong>Requested BTC:</strong> ${withdrawalData.requestedBtcAmount || 'N/A'}</li>
        <li><strong>Fee (1%):</strong> ${withdrawalData.fee || 'N/A'}</li>
        <li><strong>Total BTC to Deduct:</strong> ${withdrawalData.totalBtcToDeduct || 'N/A'}</li>
        <ul>
            <li><strong>Precio BTC/USDT:</strong> ${withdrawalData.receipt.btcUsdt || 'N/A'}</li>
            <li><strong>Precio USDT/COP:</strong> ${withdrawalData.receipt.usdtCop || 'N/A'}</li>
        </ul>
        <li><strong>Bank Data:</strong> ${withdrawalData.bankData || 'N/A'}</li>
        <li><strong>Bank Name:</strong> ${withdrawalData.bankName || 'N/A'}</li>
        <li><strong>Country:</strong> ${withdrawalData.country || 'N/A'}</li>
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

        // 2. Update totalCopInvested and avgBuyPrice
        const copAmount = after.saldoCop || parseFloat((after.amount || '0').toString().replace(/,/g, '')) || 0;
        if (copAmount > 0) {
          const copRef = rtdb.ref(`balances/${uid}/totalCopInvested`);
          await copRef.transaction((current) => {
            return parseFloat(((current || 0) + copAmount).toFixed(2));
          });

          // Read current values and compute avgBuyPrice
          const balSnap = await rtdb.ref(`balances/${uid}`).once('value');
          const bal = balSnap.val() || {};
          const totalCop = bal.totalCopInvested || 0;
          const totalBtc = bal.BTCbalance || 0;
          const avg = totalBtc > 0 ? Math.round(totalCop / totalBtc) : 0;
          await rtdb.ref(`balances/${uid}/avgBuyPrice`).set(avg);
          console.log(`Updated avgBuyPrice for ${uid}: ${avg} COP/BTC (totalCopInvested: ${totalCop})`);
        }
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

        // Deduct BTC
        const balanceRef = rtdb.ref(`balances/${uid}/BTCbalance`);
        await balanceRef.transaction((currentValue) => {
          const newBalance = (currentValue || 0) - btcAmountToDeduct;
          return parseFloat(newBalance.toFixed(8));
        });
        console.log(`Deducted ${btcAmountToDeduct} BTC from user ${uid} balance.`);

        // Proportionally reduce totalCopInvested
        if (btcBefore > 0 && currentCop > 0) {
          const fraction = btcAmountToDeduct / btcBefore;
          const newCop = parseFloat((currentCop - currentCop * fraction).toFixed(2));
          const btcAfter = btcBefore - btcAmountToDeduct;
          const avg = btcAfter > 0 ? Math.round(newCop / btcAfter) : 0;
          await rtdb.ref(`balances/${uid}/totalCopInvested`).set(newCop);
          await rtdb.ref(`balances/${uid}/avgBuyPrice`).set(avg);
          console.log(`Updated avgBuyPrice for ${uid}: ${avg} COP/BTC (totalCopInvested: ${newCop})`);
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
          <p>Hola ${userName || 'User'},</p>
          <p><strong>¡Hemos recibido exitosamente tu depósito de $${formattedCop} COP!</strong></p>
          <p>¡Tu billetera de BTC ha sido acreditada con ${btcAmount} BTC!</p>
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
  // Basic token security check
  const secretToken = webhookSecret.value();
  if (req.query.token !== secretToken) {
    return res.status(403).send('Forbidden: Invalid token');
  }

  const emailBody = req.body.emailBody;
  if (!emailBody) {
    return res.status(400).send('Missing email body');
  }

  if (!emailBody.includes("Bancolombia:") || !emailBody.includes("RENDIMIENTOS")) {
    console.log("Ignored email: Does not contain Bancolombia: RENDIMIENTOS");
    return res.status(200).send("Ignored: Not a RENDIMIENTOS deposit");
  }

  console.log('Received email body:', emailBody);
  // Parse using Regex
  // Example string: 
  // Bancolombia: RENDIMIENTOS, recibiste un pago de SUSANA ARBOLEDA CEBALLOS por $2,000.00 en tu cuenta *9328 conectado a la llave 0092325247 el 28/03/2026 a las 18:34. Con codigo QR es facil y de una. Dudas al 018000912345.

  const nameMatch = emailBody.match(/pago de (.*?) por/i);
  const amountMatch = emailBody.match(/por \$([0-9,.,\s]+) en tu cuenta/i);
  const dateMatch = emailBody.match(/el (\d{2}\/\d{2}\/\d{4})/i);
  const timeMatch = emailBody.match(/a las (\d{2}:\d{2})/i);

  if (!nameMatch || !amountMatch) {
    console.error('Regex failed to match name or amount in:', emailBody);
    return res.status(400).send('Could not parse Bancolombia format');
  }

  const parsedName = nameMatch[1].trim().toUpperCase();
  const parsedAmountStr = amountMatch[1].trim(); // Extracting amount as string
  const numericAmount = parseFloat(parsedAmountStr.replace(/,/g, ''));
  const parsedDate = dateMatch ? dateMatch[1] : null;
  const parsedTime = timeMatch ? timeMatch[1] : null;

  // Search RTDB balances for a matching name
  const balancesSnap = await rtdb.ref('balances').once('value');
  const balances = balancesSnap.val() || {};

  let matchedUid = null;
  // Match using the first two words (case-insensitive)
  const parsedNameTokens = parsedName.split(/\s+/).slice(0, 2).join(' ');
  for (const key in balances) {
    const userBalance = balances[key];
    if (userBalance && userBalance.name) {
      const dbNameTokens = userBalance.name.trim().toUpperCase().split(/\s+/).slice(0, 2).join(' ');
      if (dbNameTokens === parsedNameTokens && parsedNameTokens.length > 0) {
        matchedUid = userBalance.uid;
        break;
      }
    }
  }

  const depositData = {
    parsedName,
    amount: numericAmount, // Stored as a pure number (e.g. 12000 instead of "12,000.00")
    date: parsedDate,
    time: parsedTime,
    rawEmail: emailBody,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    status: 'pending', // Initialize as pending
    userNotified: false
  };

  try {
    if (matchedUid) {
      console.log(`Matched incoming deposit to user UID: ${matchedUid}`);
      depositData.uid = matchedUid;
      const newRef = rtdb.ref(`deposits/${matchedUid}`).push();
      await newRef.set(depositData);

      // Keep a master log
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
            // For deposits below 10 USDT, mark as settled directly (but with 0 BTC bought)
            await newRef.update({ status: 'settled' });
            await rtdb.ref(`deposits/all/${newRef.key}`).update({ status: 'settled' });
          } else {
            const availableUsdt = await getBinanceUsdtBalance();
            console.log(`Available USDT on Binance: ${availableUsdt}`);

            if (availableUsdt < requiredUsdt) {
              console.warn('Insufficient USDT liquidity on Binance.');
              // Send warning to Admin
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
              // Execute Binance Buy (format to 2 decimals usually for quoteOrderQty)
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

              // Update Crypto Balance
              const cryptoBalanceRef = rtdb.ref(`cryptoBalances/${matchedUid}`);
              const snap = await cryptoBalanceRef.once('value');
              const currentBalance = snap.val() ? parseFloat(snap.val().balance || 0) : 0;
              const newBalance = currentBalance + btcBought;
              await cryptoBalanceRef.set({
                balance: newBalance,
                updatedAt: admin.database.ServerValue.TIMESTAMP
              });

              cryptoBuySuccess = true;
            }
          }
        }
      } catch (cryptoErr) {
        console.error('Error in crypto buy process:', cryptoErr);
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

      // Finalize status: only set status to settled after successful purchase
      if (cryptoBuySuccess && marketBuyInfo) {
        console.log('Finalizing deposit: Setting status to settled and adding marketBuy info...');
        await newRef.update({ status: 'settled', marketBuy: marketBuyInfo });
        await rtdb.ref(`deposits/all/${newRef.key}`).update({ status: 'settled', marketBuy: marketBuyInfo });

        // Notify User
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
    console.error('Firebase save error:', err);
    res.status(500).send('Database error');
  }
});
exports.testBinanceProxy = onRequest({ secrets: [binanceApiKey, binanceSecretKey, binanceProxyToken] }, async (req, res) => {
  try {
    const balance = await getBinanceUsdtBalance();
    res.status(200).send(`Proxy connection successful! Available USDT balance: ${balance}`);
  } catch (error) {
    console.error('Test Proxy Error:', error);
    res.status(500).send(`Error testing proxy: ${error.message}`);
  }
});
