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
const fetch = require('node-fetch');
const {onRequest} = require("firebase-functions/v2/https"); //para tomar conf de firebase
const {defineString} = require("firebase-functions/params"); //para tomar la conf de firebase

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
    const { path } = req.query; // e.g., ?path=/v1/balance/channels
    if (!path) return res.status(400).send('Missing "path" query param.');

    const lndUrl = 'http://35.208.122.165:3000'; // e.g., IP publica de la VM Proxy
    const macaroon = '0201036c6e6402f801030a1082f4cadbd734d464054914485e044e381201301a160a0761646472657373120472656164120577726974651a130a04696e666f120472656164120577726974651a170a08696e766f69636573120472656164120577726974651a210a086d616361726f6f6e120867656e6572617465120472656164120577726974651a160a076d657373616765120472656164120577726974651a170a086f6666636861696e120472656164120577726974651a160a076f6e636861696e120472656164120577726974651a140a057065657273120472656164120577726974651a180a067369676e6572120867656e657261746512047265616400000620795ab76b30a6d0856ea98a0ecb45673b0e40458caaab2158a2f2cafbd9a31913';

    try {
      const response = await fetch(`${lndUrl}${path}`, {
        method: req.method,
        headers: {
          'Grpc-Metadata-macaroon': macaroon,
          'Content-Type': 'application/json',
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`LND Response: Status ${response.status}, Body: ${errorBody}`);
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.code === 12) {
            return res.status(403).json({ error: 'Wallet locked', code: 12 });
          }
          throw new Error(`LND error: ${response.status} - ${errorBody}`);
        } catch (parseErr) {
          throw new Error(`LND error: ${response.status} - ${errorBody}`);
        }
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error('Proxy error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});



// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started
// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });