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
const { https: { onRequest } } = require('firebase-functions/v2');

const next = require('next');
const path = require('path');
const admin = require('firebase-admin');

//mainMacaroons
const lndUrl = defineString('LND_URL'); 
const mainMacaroon = defineSecret('MAIN_LND_MACAROON');  // Main admin.mainMacaroon
const edgeMacaroon = defineSecret('EDGE_TAPD_MACAROON');  // Edge admin.mainMacaroon
const adminUid = defineString('ADMIN_UID');  // Your UID


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

exports.syncSheetsToRTDB = functions.https.onRequest((req, res) => {
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
    const movementsRange = 'Sheet1!A1:G82';
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

exports.getDataById = functions.https.onRequest((req, res) => {
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

      const filteredData = data
        .filter((row) => row[idColumnIndex] && row[idColumnIndex].toString() === id.toString())
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
exports.getMovementsById = functions.https.onRequest((req, res) => {
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
      const range = 'Sheet1!A1:G82'; // Adjust if movements are in a different sheet/range

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
exports.lndProxy = functions.https.onRequest({secrets: [mainMacaroon]}, (req, res) => {
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

exports.tapdProxy = functions.https.onRequest({secrets: [edgeMacaroon]}, (req, res) => {
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

exports.nextServer = functions.https.onRequest(async (req, res) => {
  
  try {
    await app.prepare();

    handle(req, res);

  } catch (error) {
    console.error('Next.js server error:', error);
    res.status(500).send('Server Error');
  }
});