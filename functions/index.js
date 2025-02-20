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

/*
exports.helloWorld = functions.https.onRequest((req, res) => {
    res.send('Hello World! David');
  });
*/

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

// Function to load data from Google Sheets and store it in Firestore
exports.loadDataFromSheet = functions.https.onRequest(async (req, res) => {
  try {
    // Replace with your spreadsheet ID and range
    const spreadsheetId = '1Etee_5MhgVS6ozENYqcagoqjq4z3a64mn1WD6y_aCIg';
    const range = 'Sheet1!A1:E9'; // Adjust range as needed

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
        console.log('No data found.');
        res.send('No data found.');
      return;
    }

    // Log the extracted data
    console.log('Extracted data:', rows);

    // Assuming the first row is the header
    const headers = rows[0];
    const data = rows.slice(1);

    // Store data in Firestore
    const batch = db.batch();
    const collectionRef = db.collection('rendimientos'); // Update with your collection name

    data.forEach((row, index) => {
      const docRef = collectionRef.doc(`doc${index + 1}`); // You can use a unique identifier here
      const docData = {};
      headers.forEach((header, colIndex) => {
        docData[header] = row[colIndex];
      });
      batch.set(docRef, docData);
    });

    await batch.commit();
    console.log('Data loaded successfully.');
    res.send('Data loaded successfully.');
  } catch (error) {
    console.error('Error loading data:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
