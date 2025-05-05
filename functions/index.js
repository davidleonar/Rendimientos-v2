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


// Initialize Firebase Admin SDK
initializeApp({
  credential: applicationDefault(),
});


const db = getFirestore();

// Google Sheets configuration
const sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
  keyFile: './serviceAccountKey.json', // Update with the path to your service account file
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
})});

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
  cors(req, res, async () => { // Wrap the handler with cors
    if (req.method !== 'GET') {
      return res.status(405).send('Method Not Allowed. Use GET.');
    }

    const id = req.query.id;
    if (!id) {
      return res.status(400).send('Missing "id" parameter in query.');
    }

    try {
      const spreadsheetId = '1Etee_5MhgVS6ozENYqcagoqjq4z3a64mn1WD6y_aCIg';
      const range = 'Sheet1!A1:F11';

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
      const range = 'Sheet1!A1:G29'; // Adjust if movements are in a different sheet/range

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



// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
