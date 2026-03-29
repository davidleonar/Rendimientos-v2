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

const { defineString, defineSecret } = require('firebase-functions/params');
const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
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

exports.syncSheetsToRTDB = onRequest((req, res) => {
  cors(req, res, async () => {
    // Verify token (auth required)
    if (!(await verifyToken(req, res))) return;

    // Check if user is admin
    if (req.user.uid !== adminUid.value()) {
      return res.status(403).send('Forbidden: Admin access required.');
    }

    console.log('syncSheetsToRTDB function started.');
    try {
      // 1. Fetch Balances
      console.log('Fetching balances data...');
      const balancesSheetId = '1Etee_5MhgVS6ozENYqcagoqjq4z3a64mn1WD6y_aCIg';
      const balancesRange = 'Sheet1!A1:G50';
      const balancesData = await fetchAllSpreadsheetData(balancesSheetId, balancesRange);
      console.log(`Fetched ${balancesData.length} balances.`);

      // 2. Fetch Movements
      console.log('Fetching movements data...');
      const movementsSheetId = '1Ke7ftv8OSmec6yqpjMzOXIqLaK24Dp8S4Pc5JEmCMlE';
      const movementsRange = 'Sheet1!A1:G120';
      const movementsData = await fetchAllSpreadsheetData(movementsSheetId, movementsRange);
      console.log(`Fetched ${movementsData.length} movements.`);

      // 3. Restructure data
      console.log('Restructuring data...');
      const rtdbData = {
        balances: {},
      };

      balancesData.forEach((item) => {
        if (item.id) {
          rtdbData.balances[item.id] = item;
        }
      });

      movementsData.forEach((item) => {
        if (item.id && rtdbData.balances[item.id]) {
          if (!rtdbData.balances[item.id].movements) {
            rtdbData.balances[item.id].movements = [];
          }
          rtdbData.balances[item.id].movements.push(item);
        }
      });
      console.log('Data restructured.');

      // 4. Write to Realtime Database
      console.log('Writing data to Realtime Database...');
      await rtdb.ref('balances').set(rtdbData.balances);    // se puede cambiar a update() si no se quiere sobreescribir todo y solo actualizar
      console.log('Data successfully written to Realtime Database.');

      res.status(200).json({ message: 'Successfully synced spreadsheet data to Realtime Database.' });
      console.log('syncSheetsToRTDB function finished successfully.');
    } catch (error) {
      console.error('Error syncing data to RTDB:', error);
      res.status(500).json({ error: 'Internal Server Error' });
      console.log('syncSheetsToRTDB function finished with error.');
    }
  });
});

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
      const range = 'Sheet1!A1:G120'; // Adjust if movements are in a different sheet/range

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
async function sendWithdrawalEmail(withdrawalData, type) {
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
    text: `
      User ID: ${withdrawalData.userId || 'N/A'}
      Name: ${withdrawalData.name || 'N/A'}
      Email: ${withdrawalData.userEmail || 'N/A'}
      Amount: ${withdrawalData.amount || 'N/A'}
      Option: ${withdrawalData.option || 'N/A'}
      Bank Data: ${withdrawalData.bankData || 'N/A'}
      Bank Name: ${withdrawalData.bankName || 'N/A'}
      Country: ${withdrawalData.country || 'N/A'}
      Timestamp: ${new Date().toISOString()}

      Full Details: ${JSON.stringify(withdrawalData, null, 2)}
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
    subject: `Transfer confirmation from Rendimientos.net`,
    text: `
      Hello ${withdrawalData.name || 'User'},

      We have successfully received your withdrawal request!
      
      Amount: ${withdrawalData.amount || 'N/A'}
      Option: ${withdrawalData.option || 'N/A'}
      Bank Data: ${withdrawalData.bankData || 'N/A'}
      Bank Name: ${withdrawalData.bankName || 'N/A'}
      Country: ${withdrawalData.country || 'N/A'}

      We will process it shortly. Thank you!
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
    secrets: ['SMTP_PASS']  // Pass your secret(s); add more if needed
  },

  async (event) => {
    const withdrawal = event.data.val();
    await sendWithdrawalEmail(withdrawal, 'Global');
    await sendUserWithdrawalEmail(withdrawal);
    return null;  // End cleanly
  }
);

// Trigger to notify user when withdrawal is settled
exports.notifyWithdrawalSettled = onValueUpdated(
  {
    ref: "withdrawals/{uid}/{requestId}",
    secrets: ['SMTP_PASS']
  },
  async (event) => {
    const before = event.data.before.val() || {};
    const after = event.data.after.val() || {};

    // Only trigger if status just changed to 'settled'
    if (after.status === 'settled' && before.status !== 'settled') {
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
        subject: `Withdrawal Completed - Rendimientos.net`,
        text: `
          Hello ${after.name || 'User'},

          Great news! Your withdrawal request has been successfully COMPLETED.
          
          Amount: ${after.amount || 'N/A'}
          Destination: ${after.bankName || 'N/A'} - ${after.bankData || 'N/A'}
          
          The funds should now be fully transferred. Please check your bank account to verify!
          
          Thank you for using Rendimientos.net!
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

// --- NEW: Bancolombia Webhook ---
exports.bancolombiaWebhook = onRequest(async (req, res) => {
  // Basic token security check (we define a static token that the GAS uses)
  const secretToken = process.env.WEBHOOK_SECRET || 'david_bancolombia_123';
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
  const parsedAmount = amountMatch[1].trim(); // Extracting amount as string
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
    amount: parsedAmount,
    date: parsedDate,
    time: parsedTime,
    rawEmail: emailBody,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    status: 'settled', // it's already a completed deposit
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
    } else {
      console.log(`Unassigned incoming deposit for name: ${parsedName}`);
      depositData.adminNotified = false;
      depositData.status = 'unassigned';
      const newRef = rtdb.ref(`unassignedDeposits`).push();
      await newRef.set(depositData);
    }
    
    res.status(200).send('Successfully processed integration');
  } catch (err) {
    console.error('Firebase save error:', err);
    res.status(500).send('Database error');
  }
});
