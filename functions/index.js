/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const functions = require('firebase-functions');
const { google } = require('googleapis');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true }); // Enable CORS for all origins
const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const {onRequest} = require("firebase-functions/v2/https"); //para tomar conf de firebase
const {defineString} = require("firebase-functions/params"); //para tomar la conf de firebase
const next = require('next');
const path = require('path');

const lndUrl = 'http://35.208.122.165:3000'; // e.g., IP publica de la VM Proxy 35.208.122.165
const macaroon = '0201036c6e6402f801030a1082f4cadbd734d464054914485e044e381201301a160a0761646472657373120472656164120577726974651a130a04696e666f120472656164120577726974651a170a08696e766f69636573120472656164120577726974651a210a086d616361726f6f6e120867656e6572617465120472656164120577726974651a160a076d657373616765120472656164120577726974651a170a086f6666636861696e120472656164120577726974651a160a076f6e636861696e120472656164120577726974651a140a057065657273120472656164120577726974651a180a067369676e6572120867656e657261746512047265616400000620795ab76b30a6d0856ea98a0ecb45673b0e40458caaab2158a2f2cafbd9a31913';

/*
// Load LND TLS cert (must be in functions folder)
const tlsCert = fs.readFileSync('./tls.cert'); // ← tls.cert in same dir

// Create HTTPS agent that trusts your LND cert
const agent = new https.Agent({
  ca: tlsCert,
  rejectUnauthorized: false, // Enforce cert
});
*/

// Initialize Firebase Admin SDK
initializeApp({
  credential: applicationDefault(),
});

const db = getFirestore();

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

// Bypass SSL verification (for testing only)
//process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// LND proxy para conectar con el Nodo Umbrel
exports.lndProxy = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {

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
          path = url.pathname; // Extract /api/lndProxy/v1/invoices
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

      // 4. Forward to LND
      await fetch(`${lndUrl}${path.startsWith('/') ? '' : '/'}${path}`, {
        method: req.method,
        headers: {
          'Grpc-Metadata-macaroon': macaroon,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        //agent,
        timeout: 10000, // 10s timeout
      });

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