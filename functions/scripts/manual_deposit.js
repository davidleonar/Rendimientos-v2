#!/usr/bin/env node

/**
 * Manual Deposit & Market Buy Generator Script
 * 
 * Usage:
 *   node manual_deposit.js <UID> <COP_AMOUNT> <TIME> [DATE] [USDT_COP_RATE] [FEE_COP]
 * 
 * Examples:
 *   node manual_deposit.js 1152441435-1 1000000 11:59:00
 *   node manual_deposit.js 1035027441 200000 14:30 2026-06-02 3575.50 5000
 */

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { execSync } = require('child_process');

const args = process.argv.slice(2);

if (args.length < 3) {
  console.log(`
Usage:
  node manual_deposit.js <UID> <COP_AMOUNT> <TIME> [DATE] [USDT_COP_RATE] [FEE_COP]

Arguments:
  UID           The user's ID or national ID (e.g. "1152441435-1")
  COP_AMOUNT    The amount in COP (e.g. "1000000")
  TIME          Deposit time in HH:MM:SS or HH:MM format (e.g. "11:59:00")
  DATE          (Optional) Deposit date in YYYY-MM-DD format. Defaults to today (Bogota time).
  USDT_COP_RATE (Optional) Override USDT/COP exchange rate. Defaults to current CoinGecko rate.
  FEE_COP       (Optional) Fee amount in COP. Defaults to 0.

Examples:
  node manual_deposit.js 1152441435-1 1000000 11:59:00
  node manual_deposit.js 1035027441 200000 14:30 2026-06-02 3575.50 5000
`);
  process.exit(1);
}

const uid = args[0];
const copAmount = parseFloat(args[1].replace(/,/g, ''));
let timeStr = args[2];

// Normalize time to HH:MM:SS
if (timeStr.split(':').length === 2) {
  timeStr += ':00';
}

// Default date to today in America/Bogota
let dateStr = args[3];
if (!dateStr) {
  dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // returns YYYY-MM-DD
}

const usdtCopRateOverride = args[4] ? parseFloat(args[4]) : null;
const feeCop = args[5] ? parseFloat(args[5]) : 0;

if (isNaN(copAmount) || copAmount <= 0) {
  console.error('Error: COP_AMOUNT must be a valid positive number.');
  process.exit(1);
}

if (isNaN(feeCop) || feeCop < 0) {
  console.error('Error: FEE_COP must be a non-negative number.');
  process.exit(1);
}

if (feeCop >= copAmount) {
  console.error('Error: FEE_COP cannot be greater than or equal to COP_AMOUNT.');
  process.exit(1);
}

const netCop = copAmount - feeCop;

// 1. Build the exact ISO datetime string in Bogota timezone (Colombia is UTC-5)
const datetimeStr = `${dateStr}T${timeStr}-05:00`;
const timestamp = new Date(datetimeStr).getTime();

if (isNaN(timestamp)) {
  console.error(`Error: Invalid Date/Time combination: Date: "${dateStr}", Time: "${timeStr}"`);
  process.exit(1);
}

function formatToDdMmmYyyy(yyyyMmDd) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = yyyyMmDd.split('-');
  const monthStr = months[parseInt(m, 10) - 1];
  return `${d.padStart(2, '0')}-${monthStr}-${y}`;
}

const displayDate = formatToDdMmmYyyy(dateStr);

async function getUsdtCopRate() {
  if (usdtCopRateOverride) {
    return { rate: usdtCopRateOverride, source: 'Override' };
  }
  try {
    const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cop');
    if (cgRes.ok) {
      const cgData = await cgRes.json();
      const rate = cgData?.tether?.cop;
      if (rate) {
        return { rate, source: 'CoinGecko' };
      }
    }
  } catch (err) {
    console.warn('Could not fetch USDT/COP rate from CoinGecko, trying Coinbase fallback...', err.message);
  }

  try {
    const cbRes = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD');
    if (cbRes.ok) {
      const cbData = await cbRes.json();
      const rate = parseFloat(cbData?.data?.rates?.COP);
      if (rate) {
        return { rate, source: 'Coinbase' };
      }
    }
  } catch (err) {
    console.error('Error fetching USDT/COP rate from Coinbase:', err.message);
  }

  throw new Error('Failed to retrieve USDT/COP rate from both CoinGecko and Coinbase API.');
}

async function getHistoricalBtcPrice(timeMs) {
  try {
    const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${timeMs}&limit=1`;
    const res = await fetch(binanceUrl);
    if (res.ok) {
      const klines = await res.json();
      if (klines && klines.length > 0) {
        const closePrice = parseFloat(klines[0][4]);
        return { price: closePrice, source: 'Binance (1m Close)' };
      }
    }
  } catch (err) {
    console.warn('Could not fetch historical BTC price from Binance, attempting CoinGecko...', err.message);
  }

  // Fallback to CoinGecko current simple price (approximate)
  try {
    const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (cgRes.ok) {
      const cgData = await cgRes.json();
      const price = cgData?.bitcoin?.usd;
      if (price) {
        return { price, source: 'CoinGecko (Current Fallback)' };
      }
    }
  } catch (err) {
    console.error('Error fetching fallback BTC price from CoinGecko:', err.message);
  }

  throw new Error('Failed to retrieve historical BTC/USDT price from Binance.');
}

function getSmtpPassSecret() {
  try {
    const pass = execSync('gcloud secrets versions access latest --secret=SMTP_PASS --project=rendimientos-5dbb9', { encoding: 'utf8' }).trim();
    if (pass) {
      return pass;
    }
  } catch (e) {
    // Silent fail if gcloud not available/configured
  }
  return null;
}

async function run() {
  console.log('--- STARTING MANUAL DEPOSIT PROCESS ---');

  // Fetch prices
  const { rate: usdtCopPrice, source: copSource } = await getUsdtCopRate();
  const { price: btcUsdtPrice, source: btcSource } = await getHistoricalBtcPrice(timestamp);

  const usdtSpent = Math.floor((netCop / usdtCopPrice) * 100) / 100;
  const btcBought = parseFloat((usdtSpent / btcUsdtPrice).toFixed(8));
  const orderId = '2289270283' + Math.floor(1000000000 + Math.random() * 9000000000); // 20 digit realistic order ID

  console.log(`Calculated metrics:
  COP Gross Amount: $${copAmount.toLocaleString()} COP
  COP Fee: $${feeCop.toLocaleString()} COP
  COP Net Invested: $${netCop.toLocaleString()} COP
  USDT/COP Price: $${usdtCopPrice} COP (${copSource})
  USDT Spent: $${usdtSpent} USDT
  BTC/USDT Price: $${btcUsdtPrice} USD (${btcSource})
  BTC Bought: ${btcBought} BTC
  Order ID: ${orderId}
  Timestamp: ${timestamp} (${new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/Bogota' })} Bogota time)
  `);

  // Initialize Firebase Admin SDK
  initializeApp({
    databaseURL: 'https://rendimientos-5dbb9-default-rtdb.firebaseio.com/'
  });

  const rtdb = getDatabase();

  // Fetch user profile from balances
  const balanceSnap = await rtdb.ref(`balances/${uid}`).once('value');
  const initialBalance = balanceSnap.val();

  if (!initialBalance) {
    console.error(`Error: User balance profile not found in RTDB at /balances/${uid}`);
    process.exit(1);
  }

  const userName = initialBalance.name || 'MANUAL DEPOSIT';
  console.log(`Initial User Balance:`, initialBalance);

  // Fetch email from Auth if possible
  let userEmail = null;
  try {
    const userRecord = await admin.auth().getUser(uid);
    userEmail = userRecord.email;
    console.log(`Fetched Firebase Auth User email: "${userEmail}"`);
  } catch (err) {
    // Auth user might not exist for manual profiles
  }

  // Generate Push Key
  const depositRef = rtdb.ref(`deposits/${uid}`).push();
  const depositId = depositRef.key;
  console.log(`Generated Deposit Key: ${depositId}`);

  const depositData = {
    date: displayDate,
    depositId: depositId,
    marketBuy: {
      btcBought: btcBought,
      btcUsdtPrice: btcUsdtPrice,
      orderId: orderId,
      priceSource: btcSource.includes('Binance') ? 'Binance' : 'CoinGecko',
      usdtCopPrice: usdtCopPrice,
      usdtSpent: usdtSpent
    },
    parsedName: userName.toUpperCase(),
    amount: copAmount,
    fee: feeCop,
    saldoCop: netCop,
    status: 'settled',
    time: timeStr,
    timestamp: timestamp,
    uid: uid,
    userNotified: false
  };

  // Write deposit data
  console.log(`Writing deposit data to deposits/${uid}/${depositId}...`);
  await rtdb.ref(`deposits/${uid}/${depositId}`).set(depositData);

  console.log(`Writing deposit data to deposits/all/${depositId}...`);
  await rtdb.ref(`deposits/all/${depositId}`).set(depositData);


  // Attempt Email Notification
  if (userEmail) {
    const smtpPass = getSmtpPassSecret();
    if (smtpPass) {
      console.log(`Sending confirmation email to ${userEmail}...`);
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: 'davidleonar@gmail.com',
          pass: smtpPass
        }
      });

      const formattedCop = copAmount.toLocaleString('de-DE');
      const mailOptions = {
        from: 'davidleonar@gmail.com',
        to: userEmail,
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

      try {
        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent successfully.');
        await rtdb.ref(`deposits/${uid}/${depositId}`).update({ userNotified: true });
        await rtdb.ref(`deposits/all/${depositId}`).update({ userNotified: true });
      } catch (emailErr) {
        console.error('Error sending confirmation email:', emailErr.message);
      }
    } else {
      console.warn('GCP Secret Manager SMTP_PASS not accessible. Skipping email notification.');
    }
  } else {
    console.log('Skipping email notification (no email address found for this UID).');
  }

  // Wait for Cloud Function trigger
  console.log('Waiting 5 seconds for cloud function triggers to process user balances...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const finalBalanceSnap = await rtdb.ref(`balances/${uid}`).once('value');
  console.log('Final User Balance:', finalBalanceSnap.val());

  console.log('--- MANUAL DEPOSIT PROCESS COMPLETED SUCCESSFULLY ---');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal Error executing script:', err);
  process.exit(1);
});
