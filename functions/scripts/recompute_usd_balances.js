#!/usr/bin/env node

/**
 * Recompute & Backfill User USD Balances & Avg Buy Price
 * 
 * Usage:
 *   node recompute_usd_balances.js
 */

const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp({
  databaseURL: 'https://rendimientos-5dbb9-default-rtdb.firebaseio.com/'
});

const rtdb = getDatabase();

async function run() {
  console.log('--- RECOMPUTING USER BALANCES (USD & COP) ---');

  const balancesSnap = await rtdb.ref('balances').once('value');
  const balances = balancesSnap.val() || {};

  const depositsSnap = await rtdb.ref('deposits').once('value');
  const depositsData = depositsSnap.val() || {};

  const userIds = Object.keys(balances);
  console.log(`Found ${userIds.length} users in /balances.`);

  for (const uid of userIds) {
    if (uid === 'all') continue;

    const userDepositsObj = depositsData[uid] || {};
    const userDeposits = Object.values(userDepositsObj).filter(d => d && d.status === 'settled');

    let totalBtc = 0;
    let totalCop = 0;
    let totalUsdt = 0;

    userDeposits.forEach(dep => {
      const btc = dep.marketBuy?.btcBought || dep.btcBought || 0;
      const cop = dep.saldoCop || parseFloat((dep.amount || '0').toString().replace(/,/g, '')) || 0;
      const usdt = dep.marketBuy?.usdtSpent
        || (dep.marketBuy?.btcBought && dep.marketBuy?.btcUsdtPrice ? dep.marketBuy.btcBought * dep.marketBuy.btcUsdtPrice : 0)
        || (cop > 0 && dep.marketBuy?.usdtCopPrice ? cop / dep.marketBuy.usdtCopPrice : 0);

      totalBtc += btc;
      totalCop += cop;
      totalUsdt += usdt;
    });

    totalBtc = parseFloat(totalBtc.toFixed(8));
    totalCop = parseFloat(totalCop.toFixed(2));
    totalUsdt = parseFloat(totalUsdt.toFixed(2));

    const avgBuyPrice = totalBtc > 0 ? Math.round(totalCop / totalBtc) : 0;
    const avgBuyPriceUsdt = totalBtc > 0 ? Math.round(totalUsdt / totalBtc) : 0;

    console.log(`User ${uid}:`);
    console.log(`  BTC Balance: ${totalBtc}`);
    console.log(`  Total COP Invested: $${totalCop}`);
    console.log(`  Total USDT Invested: $${totalUsdt}`);
    console.log(`  Avg Buy Price (COP): $${avgBuyPrice} COP/BTC`);
    console.log(`  Avg Buy Price (USDT): $${avgBuyPriceUsdt} USDT/BTC`);

    const updateData = {
      totalCopInvested: totalCop,
      totalUsdtInvested: totalUsdt,
      avgBuyPrice: avgBuyPrice,
      avgBuyPriceUsdt: avgBuyPriceUsdt
    };

    if (totalBtc > 0 && (!balances[uid].BTCbalance || balances[uid].BTCbalance === 0)) {
      updateData.BTCbalance = totalBtc;
    }

    await rtdb.ref(`balances/${uid}`).update(updateData);
  }

  console.log('--- RECOMPUTATION COMPLETED SUCCESSFULLY ---');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal Error executing script:', err);
  process.exit(1);
});
