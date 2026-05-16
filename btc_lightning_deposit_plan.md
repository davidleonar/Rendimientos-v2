# Move BTC Lightning Deposits Feature

The goal is to relocate the BTC Lightning deposit functionality from the generic "Ahorra Aqui" section directly underneath the authoritative "BTC Wallet" display. This will establish a more intuitive user flow, enhance the aesthetics with clear formatting and success animations, and securely tie Lightning deposits directly into the new unified Realtime Database (RTDB) architecture.

## Proposed Changes

### UI & Location Modifications
* **Remove from 'Ahorra Aqui'**: Delete the `btcLightning` option and its associated UI block from the `savingsOption` toggle.
* **Relocate to BTC Wallet Area**: Create a new premium UI card titled **"Deposit via Lightning"** immediately following the `BTC Wallet` section (around line 1650).
* **Enhanced Styling & Formatting**:
  * Implement an input field that automatically formats numbers with a thousands separator (e.g., `10,000`).
  * Explicitly append `sats` (satoshis) or `⚡ sats` to the input field so users intuitively understand the denomination.
  * Render the QR code and Lightning Invoice string inside a sleek, glassmorphic container to match the modern aesthetic.

### Success Animations
* **Replace `alert()`**: Remove the jarring browser `alert('¡Ahorro recibido!')`.
* **Add Success UI**: Introduce a temporary, animated success overlay or a vibrant green success block when `savingsPaymentStatus === 'settled'`.
* **Confetti (Optional)**: If `canvas-confetti` is installed, trigger a confetti burst to celebrate the deposited savings.

### RTDB Architecture Alignment (Critical)
Currently, successful Lightning payments write to a legacy `userSavings/` node. We need to integrate this with our new unified `deposits` flow so that the `onDepositSettled` Cloud Function automatically manages the user's total BTC balance.

* **Update RTDB Writing Logic**: When the Lightning invoice settles (polled via `useEffect`), we will write directly to `deposits/${user.uid}/${savingsPaymentHash}`.
* **Data Structure**:
  ```javascript
  const btcAmount = Number(invoice.amt_paid_sat) / 100_000_000;
  
  const depositData = {
    uid: user.uid,
    depositId: savingsPaymentHash,
    parsedName: "BTC Lightning Deposit",
    status: "settled",
    timestamp: Date.now(),
    marketBuy: {
      btcBought: btcAmount,
      // Pass the current live market prices to evaluate portfolio accurately
      btcUsdtPrice: currentPrice || 0, 
      usdtCopPrice: currentUsdtCop || 0
    }
  };
  // Write to RTDB
  await set(ref(database, `deposits/${user.uid}/${savingsPaymentHash}`), depositData);
  ```
  By doing this, the Cloud Function will natively catch the `'settled'` status and atomically add the exact deposited BTC amount to `balances/${user.uid}/BTCbalance`.

## Verification Plan
1. **Dependency Installation**: Run `pnpm add canvas-confetti @types/canvas-confetti` in the `my-spa` directory.
2. **Locally start the app** to verify the UI layout is correct and the thousands separator works seamlessly.
3. **Generate a test invoice** to ensure `lndProxy` still creates invoices successfully.
4. **Simulate a payment** (using an Umbrel admin panel or testnet, if available) and observe the polling system and confetti animation.
5. **Verify Database Write**: Check the `deposits` node in Firebase to ensure it structured the data perfectly for the Cloud Function.
6. **Verify Cloud Function**: Confirm that the user's `BTCbalance` increments correctly without any manual frontend deductions.
