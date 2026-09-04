# Rendimientos Project Architecture & Agent Guide

## 🏢 Project Information
- **Google Cloud Platform & Firebase Project ID:** `rendimientos-5dbb9` (`rendimientos`)
- **Primary Region:** `us-central1`
- **RTDB URL:** `https://rendimientos-5dbb9-default-rtdb.firebaseio.com/`
- **Application Frontend:** Next.js 15 (App Router + Pages Router hybrid), deployed serverless via Firebase Functions.
- **Frontend SPA Source:** `my-spa/` directory — a standalone Next.js project (TypeScript, TailwindCSS 3) that builds into `functions/.next/`.
- **Backend Stack:** Node.js v22 (Cloud Functions 2nd Gen), Firebase Realtime Database (RTDB), Firebase Authentication.
- **Package Manager:** `pnpm` (used in both `functions/` and `my-spa/`).
- **Admin UIDs:** Configured via `ADMIN_UIDS` (server-side) and `NEXT_PUBLIC_ADMIN_UIDS` (client-side) environment variables, managed centrally via `my-spa/src/app/lib/auth-utils.ts`.

## 📂 Repository Structure
```
my-project/
├── agent.md                    # This file
├── firebase.json               # Hosting rewrites, functions config
├── database.rules.json         # RTDB security rules
├── functions/
│   ├── index.js                # All Cloud Functions (~1057 lines)
│   ├── package.json            # Node 22, firebase-functions v7, nodemailer, ethers, next 15
│   ├── .env / .env.local       # Environment config
│   └── .next/                  # Built Next.js output (synced from my-spa)
├── my-spa/                     # Frontend SPA (Next.js 15 + TypeScript + TailwindCSS)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Main app (~127KB monolithic page component)
│   │   │   ├── admin/
│   │   │   │   └── page.tsx    # Admin Dashboard Console Portal (~33KB component)
│   │   │   ├── layout.tsx      # Root layout
│   │   │   ├── globals.css     # Global styles
│   │   │   ├── components/     # QrScanner.tsx
│   │   │   ├── lib/            # firebase.ts, firebase-admin.ts, useMetaMask.ts
│   │   │   ├── api/            # Next.js API routes (lndProxy/, tapdProxy/)
│   │   │   └── types/          # Type definitions (tron, window, qrcode-react)
│   │   └── pages/_document.tsx # Custom document
│   ├── next.config.js          # Firebase env vars, webpack aliases, image caching
│   └── package.json            # React 19, firebase 12, ethers, bolt11, html5-qrcode, etc.
├── lnd-proxy-vm2/
│   └── proxy.js                # LND reverse proxy (local copy of VM script)
└── public/                     # Static assets
```

## ☁️ Cloud Functions (`functions/index.js`)
The application defines the following 2nd Gen HTTP/Eventarc Cloud Functions:

### Core App
* **`nextServer`**: Serves the primary Next.js web application. Must explicitly have memory set (`512MiB`) to prevent SSR / Image optimization memory leak crashes (OOM at `256MiB`).

### Data Sync
* ~~**`getDataById`**~~: **DEPRECATED & REMOVED.** Securely fetched balance data from RTDB.
* ~~**`syncSheetsToRTDB`**~~: **DEPRECATED & REMOVED.** Google Sheets is no longer the source of truth. Historical movements were migrated to native RTDB `/deposits` and `/withdrawals` nodes. RTDB is now the single source of truth for all balance and transaction data.

### LND / Taproot Proxies & Lightning Settlement Engine
* **`lndProxy`**: Secure proxy forwarding JSON requests to the Main Lightning Node using `MAIN_LND_MACAROON` secret. Supports GET/POST. Uses `x-forwarded-url` header fallback for path resolution. Non-admin users are strictly whitelisted to read-only or safe creation endpoints (`/v1/invoices` and `/v1/channels/transactions` for POST; `/v1/invoice/*` and `/v1/fees` for GET) to prevent unauthorized transaction execution. Direct router sending (`/v2/router/send`) is strictly restricted to server-side functions and admins.
* **`tapdProxy`**: Secure proxy forwarding to the Edge Taproot Assets node using `EDGE_TAPD_MACAROON` secret. Supports GET/POST/DELETE. Requires Firebase auth (`verifyToken`).
* **`createInvoice`** (Authenticated): Server-side Lightning invoice generation. Enforces rate limits (10/min), validates amount bounds (1 to 5,000,000 sats), computes live COP/USD price equivalents, generates bolt11 via LND `POST /v1/invoices`, and records persistent invoices in `/invoices/{uid}/{paymentHash}` and `/pendingInvoices/{paymentHash}`.
* **`checkInvoiceSettlement`** (Authenticated): On-demand verification endpoint allowing active web sessions to trigger immediate (<1s) settlement verification and crediting without waiting for the scheduled background sync.
* **`syncLightningInvoices`** (Scheduled): Runs every 1 minute. Reconciles all pending invoices in `/pendingInvoices` against LND `GET /v1/invoice/{paymentHash}`. When an invoice settles, updates `/invoices/{uid}/{paymentHash}`, writes to `/deposits/{uid}/{paymentHash}` (triggering `onDepositSettled` to atomically increment BTC balance and update average buy prices), creates an in-app notification in `/notifications/{uid}`, sends confirmation email to the user, and removes the invoice from `/pendingInvoices`. Automatically cleans up expired invoices.
* **`processLightningWithdrawal`** (Authenticated): Server-side atomic Lightning withdrawal execution. Validates invoice via LND (`GET /v1/payreq`), performs atomic balance reservation on `balances/{uid}/BTCbalance` via database transaction, sends payment via LND Router (`POST /v2/router/send`), automatically rolls back reserved balance on routing failure, and on success finalizes the settled record in `withdrawals/{uid}/{requestId}`, proportionally reduces invested totals, dispatches in-app notification to `notifications/{uid}`, and sends email confirmation.

### Bitcoin On-Chain Management
* **`getNewDepositAddress`** (Authenticated): Calls the LND node (`GET /v1/newaddress?type=WITNESS_PUBKEY_HASH`) to generate a Bech32 Native Segwit address. Maps it in `/btcAddresses/{address}` and updates the user's balances profile in RTDB.
* **`processOnChainWithdrawal`** (Authenticated): Server-side atomic Bitcoin on-chain withdrawal execution. Validates the address via `bitcoin-address-validation`, fetches real-time fee estimations from Mempool.space, performs atomic balance reservation on `balances/{uid}/BTCbalance` via database transaction (deducting 1% platform fee + estimated network fee based on 148 vBytes), and broadcasts via LND (`POST /v1/transactions`). On broadcast failure, automatically refunds reserved balance. On broadcast success, records the settled withdrawal (`balanceAlreadyDeducted: true`), proportionally reduces `totalCopInvested` and `totalUsdtInvested` to maintain cost-basis and yield integrity (`avgBuyPrice` and `avgBuyPriceUsdt`), dispatches in-app notification to `/notifications/{uid}` (`type: 'onchain_withdrawal'`), and sends email receipt.
* **`syncOnChainDeposits`** (Scheduled): Runs every 2 minutes. Fetches on-chain transactions from the LND node and maps destination addresses to user profiles. Features real-time **0-conf mempool detection**: records unconfirmed incoming transactions to `/deposits/{uid}/{txid}` as `status: 'pending'`, triggering the frontend live confirmation tracker and dispatching an in-app notification (`type: 'onchain_detected'`). When transaction achieves **1 block confirmation**, transitions status to `'settled'`, notifies the user via email and in-app notification (`type: 'onchain_deposit'`), and triggers `onDepositSettled` to atomically increment `BTCbalance` and update average buy prices.

### Balance Update Triggers
* **`onDepositSettled`**: `onValueWritten` trigger on `deposits/{uid}/{depositId}`. Explicitly configured with `512MiB` memory limit. When a deposit's status changes to `'settled'`, atomically increments `balances/{uid}/BTCbalance` using a database transaction based on `marketBuy.btcBought`. Also increments `totalCopInvested` (by fiat deposited) and `totalUsdtInvested` (by USD spent), recomputing `avgBuyPrice` (weighted average buy price in COP/BTC) and `avgBuyPriceUsdt` (weighted average buy price in USDT/BTC based on execution-time rates).
* **`notifyWithdrawalSettled`**: `onValueWritten` trigger on `withdrawals/{uid}/{requestId}`. Explicitly configured with `512MiB` memory limit. When status changes to `'settled'`, atomically deducts `totalBtcToDeduct` from `balances/{uid}/BTCbalance` using a transaction, proportionally reduces both `totalCopInvested` and `totalUsdtInvested` based on the fraction of BTC balance withdrawn ($\text{fraction} = \frac{\text{BTC withdrawn}}{\text{BTC before}}$), recomputes `avgBuyPrice` and `avgBuyPriceUsdt` for the remaining balance, then sends settlement confirmation email to the user.

### Withdrawal System (Email Notifications via `nodemailer`)
* **`notifyGlobalWithdrawal`**: Eventarc-triggered on `withdrawals/{uid}/{requestId}` creation in RTDB. Explicitly configured with `512MiB` memory limit. Sends admin notification email AND user confirmation email. Skips notifications for manual withdrawals.

### Manual Operations
* **`createManualProfile`** (Authenticated, Admin Only): Allows admins to create manual user profiles identified by their National ID (Cédula) without requiring a Google account or Firebase Auth record. Validates mandatory `id` and `name` fields, ensures uniqueness in `/balances/{id}`, and initializes zero balances (`BTCbalance`, `avgBuyPrice`, `totalCopInvested`, etc.) in RTDB `/balances/{id}` and `/users/{id}`.
* **`createManualDeposit`** (Authenticated): Allows admins to manually record a deposit for a user. It computes the BTC equivalent by looking up the historical or current price (Binance/CoinGecko) at the specified Date and Time, updates the RTDB, and sends an email notification to the user (falling back to `userBalance.email` if the user is a manual profile without Firebase Auth).
* **`createManualWithdrawal`** (Authenticated): Allows admins to manually record a withdrawal for a user. Resolves the user email via Firebase Admin Auth (or `userBalance.email`), validates that the user has a sufficient BTC balance, and writes the withdrawal record to the RTDB as `'settled'` with the details. This automatically triggers balance updates and recomputations.

### Bancolombia Deposit Webhook & Deposit Intent Engine
* **`createDepositIntent`** (Authenticated): Registers a user's intent to deposit COP via Bancolombia / Bre-B key `0092325247`. Validates amount ($5.000 to $50.000.000 COP), records sender account holder name, assigns unique `intentId` and friendly reference (`REND-XXXX`), sets a 4-hour active window, stores in `/depositIntents/{uid}/{intentId}` and `/pendingDepositIntents/{intentId}`, and pushes an in-app notification (`type: 'intent_created'`). Supersedes any previously pending intent for that user.
* **`cancelDepositIntent`** (Authenticated): Allows users to cancel an unfulfilled pending intent, removing it from `/pendingDepositIntents` and marking it `'cancelled'` in RTDB.
* **`bancolombiaWebhook`**: HTTP endpoint secured by `WEBHOOK_SECRET`. Receives forwarded Bancolombia email alerts, parses them via regex to extract depositor name, amount, date, and time. Normalizes the deposited amount to a clean number.
  * **Tier 1 (Intent Match)**: Queries active `/pendingDepositIntents` for matching amount. Checks for sender name token matches against `parsedName`. If matched (or if exactly 1 active intent exists for that amount in the window), links to the intent's `uid`, marks the intent `'settled'`, and deletes from `/pendingDepositIntents`.
  * **Tier 2 (Balance Name Fallback)**: If no intent matched, matches the first two words of `parsedName` against RTDB `/balances` names. If multiple candidates share the exact same tokens, routes to unassigned.
  * **Tier 3 (Unassigned)**: Unmatched deposits route to `/unassignedDeposits` for manual admin assignment.
  * **Failover Price Feed**: Uses a centralized `getPrices()` helper which queries CoinGecko for live prices (`BTC/USDT`, `USDT/COP`) and automatically falls back to Coinbase API if CoinGecko returns an error or is unreachable. Saves `priceSource` inside the deposit object's `marketBuy` receipt for complete auditability.
  * **Small Deposits (< 10 USDT)**: Finalized directly as `'settled'` in RTDB without buying crypto, and dispatches in-app notification to `/notifications/{uid}` (`type: 'cop_deposit_small'`).
  * **Automated Crypto Purchases (>= 10 USDT)**: Executes a `MARKET BUY` for `BTCUSDT` via Binance Proxy VM. Sets status to `'settled'` in `deposits/{uid}/{depositId}` (triggering `onDepositSettled` to atomically increment `balances/{uid}/BTCbalance`), dispatches in-app notification (`type: 'cop_deposit'`), and sends confirmation emails to user and admin.

## 🗄️ Realtime Database Schema
```
rendimientos-5dbb9-default-rtdb/
├── balances/
│   └── {id}/                   # User balance data (id = Google UID or National ID)
│       ├── id, name, uid, ...  # Balance fields
│       ├── BTCbalance          # Authoritative BTC balance (atomically updated by Cloud Functions)
│       ├── totalCopInvested    # Total COP currently invested (reduced proportionally on withdrawals)
│       ├── totalUsdtInvested   # Total USDT/USD currently invested (reduced proportionally on withdrawals)
│       ├── avgBuyPrice         # Weighted average buy price in COP (COP/BTC) = totalCopInvested / BTCbalance
│       ├── avgBuyPriceUsdt     # Weighted average buy price in USD (USDT/BTC) = totalUsdtInvested / BTCbalance
│       ├── btcDepositAddress   # The user's active Bech32 on-chain deposit address
│       └── btcDepositAddresses # Historic log of deposit addresses generated by the user
├── deposits/
│   ├── {id}/                   # All deposits per user (Bancolombia webhook + on-chain deposit + migrated)
│   │   └── {depositId}/
│   │       ├── uid, depositId, parsedName, saldoCop, address
│   │       ├── date, time, timestamp, status ('pending' | 'settled'), confirmations, type
│   │       ├── userNotified
│   │       └── marketBuy        # {btcBought, usdtCopPrice, btcUsdtPrice}
│   └── all/                    # Master log of all matched deposits
│       └── {depositId}/
├── withdrawals/
│   └── {id}/
│       └── {requestId}/        # Withdrawal request data
│           ├── uid, requestId, saldoCop, totalBtcToDeduct, bankData, bankName
│           ├── option ('btcOnChain' | 'btcLightning' | 'copBank'), status ('pending' → 'settled')
│           └── receipt          # {usdtCop, btcUsdt, feeRate}
├── users/                      # Replaced users_directory
│   └── {id}/                   # Mixed IDs (Google UIDs and National IDs)
│       ├── name
│       ├── Full Name           # Copied from balances node
│       └── GoogleAuthName      # Sourced from Firebase Auth
├── unassignedDeposits/         # Deposits that couldn't be matched to a user
│   └── {depositId}/
│       ├── parsedName, amount, date, time
│       ├── rawEmail, timestamp, status ('unassigned')
│       └── adminNotified
├── userSavings/
│   └── {uid}/
│       └── {txHash}/           # Write-once savings records (validated: userId === $uid)
├── btcAddresses/
│   └── {address}/              # Global index of on-chain deposit addresses to owner UIDs
│       ├── uid                 # Owner user UID
│       └── generatedAt         # Timestamp
├── invoices/
│   └── {uid}/
│       └── {paymentHash}/      # Hex payment hash (server-side Lightning invoices)
│           ├── paymentHash, uid, bolt11, amountSats, amountCop
│           ├── btcUsdtPrice, usdtCopPrice, memo, status ('pending' | 'settled' | 'expired')
│           └── createdAt, expiresAt, settledAt, amtPaidSat, btcBought
├── pendingInvoices/
│   └── {paymentHash}/          # Fast index for syncLightningInvoices scheduler
│       ├── paymentHash, uid, amountSats, amountCop, createdAt, expiresAt
├── depositIntents/
│   └── {uid}/
│       └── {intentId}/         # User COP deposit intents (Bancolombia / Bre-B)
│           ├── id, uid, amount, senderName, reference, status ('pending' | 'settled' | 'cancelled')
│           ├── breBKey, createdAt, expiresAt, settledAt, depositId
├── pendingDepositIntents/
│   └── {intentId}/             # Global index for fast lookup by bancolombiaWebhook
│       ├── intentId, uid, amount, senderName, reference, createdAt, expiresAt
└── notifications/
    └── {uid}/
        └── {notifId}/          # User in-app notifications
            └── id, type, title, message, amountSats, amountCop, timestamp, read
```

> **Note:** `cryptoBalances/` node has been completely deprecated and removed from the database rules, backend Cloud Functions, manual scripts, and the frontend SPA UI. All balances are tracked natively in the `balances/` node.

## 🔐 RTDB Security Rules (`database.rules.json`)
- **`balances`**: Read access is restricted to authenticated users for their own UID (`$uid === auth.uid`) and authorized admins (`5XgksHrgmyeGqqKFYGVjQVM0KGl1`, `VldgsZCsJaOTrFT2uR2YvXxUe7o1`). Client write access is completely disabled (`.write: false`); all balance updates are performed server-side via Cloud Function admin SDK triggers.
- **`withdrawals`**: Admin can read/write the entire node. Authenticated users can read/write only their own `{uid}` subtree.
- **`deposits`**: Admin can read/write the entire node. Authenticated users can read/write only their own `{uid}` subtree.
- **`unassignedDeposits`**: Admin-only read/write.
- **`userSavings/{uid}/{txHash}`**: Owner or admin can read. Write-once is enabled for the owner (`!data.exists()`) and must validate `newData.child('userId').val() === $uid` to prevent cross-user writes.
- **`btcAddresses`**: Admin-only read/write, preventing address scanning or harvesting by unauthorized users.

## 🔑 Secrets & Environment Variables
| Variable | Type | Purpose |
|---|---|---|
| `MAIN_LND_MACAROON` | Secret | Main LND node admin macaroon |
| `EDGE_TAPD_MACAROON` | Secret | Edge Taproot Assets node macaroon |
| `SMTP_PASS` | Secret | Gmail SMTP password for nodemailer |
| `ADMIN_UID` | String | Firebase UID of the admin user |
| `WEBHOOK_SECRET` | String | Token for Bancolombia webhook authentication |
| `LND_URL` | String | Base URL for LND proxy forwarding |
| `ADMIN_EMAIL` | String | Email address for admin notifications |
| `SMTP_USER` | String | SMTP sender email address |
| `BINANCE_API_KEY` | Secret | Binance API Key |
| `BINANCE_SECRET_KEY`| Secret | Binance API Secret |
| `BINANCE_PROXY_TOKEN`| Secret | Custom token for proxying Binance requests |
| `PROXY_VM_URL` | String | Cloud Function config variable for proxy endpoint |
| `ADMIN_UIDS` | String | Comma-separated admin UIDs for server API route authorization |
| `NEXT_PUBLIC_ADMIN_UIDS` | String | Comma-separated admin UIDs for client component authorization |

## 🛡️ Security Architecture & Hardening
- **Environment-Based Admin Authorization**: Admin UIDs are configured dynamically via `ADMIN_UIDS` (server) and `NEXT_PUBLIC_ADMIN_UIDS` (client) env variables and verified via `isAdminUser()` and `getAdminUidsServer()` in `my-spa/src/app/lib/auth-utils.ts`.
- **Dual-Layer Rate Limiting**: Next.js proxy routes (`/api/lndProxy`, `/api/tapdProxy`) enforce dual-tier `RateLimiterMemory` guards:
  - **IP-Level Limiter**: 30 req/min per IP address to mitigate unauthenticated DDOS/brute-force.
  - **User-Level Limiter**: 10 req/min per authenticated UID evaluated immediately after Firebase ID token verification.
- **LND Invoice Input Validation**: `POST /v1/invoices` strictly enforces `0 < value_msat <= 5_000_000_000` (5 billion msat = 5,000,000 sats / 0.05 BTC), rejecting invalid, non-numeric, negative, or excessively large amounts with HTTP 400.
- **Explicit CORS & Origin Whitelisting**: Centralized domain origin verification across HTTP functions and proxy handlers, allowing requests exclusively from trusted web endpoints (`https://rendimientos.net`, `https://www.rendimientos.net`, `https://rendimientos-5dbb9.web.app`, `https://rendimientos-5dbb9.firebaseapp.com`, `http://localhost:3000`).
- **GCP VPC Firewall Restrictions (`allow-proxy`)**: Ingress on port `3000` of `lnd-proxy-vm2` is strictly restricted to Tailscale CIDRs (`100.64.0.0/10`), GCP internal networks (`10.128.0.0/9`), and Google Cloud Run / Functions egress IP ranges (`35.192.0.0/12`, `35.199.0.0/16`, `34.64.0.0/10`), blocking unauthenticated public internet scanners.
- **Header-Based Bearer Auth & CSRF Immunity**: API routes validate Firebase ID tokens passed via custom `Authorization: Bearer <idToken>` headers. Custom headers are not automatically attached by web browsers, making cross-origin requests protected against traditional CSRF vulnerabilities.
- **Constant-Time Webhook Verification**: `bancolombiaWebhook` validates `x-webhook-token` using `crypto.timingSafeEqual` to prevent timing side-channel attacks, paired with SHA-256 idempotency deduplication (`processedWebhooks/{hash}`) and 50M COP deposit size caps.

## 🔌 LND Infrastructure & Virtual Machines
- **VM Name:** `lnd-proxy-vm2` (Compute Engine `e2-small` running in `us-central1-a`)
- **Purpose:** Acts as a reverse proxy between the public Cloud Functions (`lndProxy` / `tapdProxy`) and internal Tailscale-networked nodes (`Umbrel`/Lightning nodes).
- **Proxy Script:** Node.js app located at `/home/davidleonar/proxy.js` listening on port `3000`.
- **Process Management:** The proxy runs as a background daemon using `pm2` (started via `pm2 start proxy.js --name proxy`). Its configuration is saved (`pm2 save`) to automatically recover across instance reboots.
- **Node Routing Logic:**
  1. Compares incoming `Grpc-Metadata-macaroon` and `x-binance-proxy-token` headers against environment variables (`process.env.MAIN_MACAROON`, `process.env.EDGE_MACAROON`, `process.env.BINANCE_PROXY_TOKEN`).
  2. If matching the `MAIN_MACAROON`, it forwards the traffic to the Main Node IP (`100.103.9.71:8080`) securely via `./mainnode/tls.cert`.
  3. If matching the `EDGE_MACAROON`, it forwards the traffic to the Edge Node IP (`100.68.2.83:8080`) over `./edgenode/tls.cert`.
  4. If matching the `BINANCE_PROXY_TOKEN`, it strips the token, forces the `Host: api.binance.com` header, and forwards the request to Nginx Proxy Manager on the Edge Node (`100.68.2.83:40080`) via HTTP. This bypasses Cloud Functions geoblocking against Binance US.

## 🌐 Firebase Hosting Rewrites (`firebase.json`)
| Source | Target |
|---|---|
| `/api/lndProxy/**` | `lndProxy` function |
| `/api/tapdProxy/**` | `tapdProxy` function |
| `/_next/**` | `nextServer` function |
| `**` (catch-all) | `nextServer` function |

Security redirects are in place for `.php`, `.git`, and `.env*` paths → `/404` (301).

## 🖥️ Frontend SPA (`my-spa/`)
- **Framework:** Next.js 15.3.1 with React 19 and TypeScript
- **Styling:** Vanilla CSS design system (TailwindCSS 3.4 setup available but vanilla custom overrides applied for high-fidelity animations, unified layouts, and card sizes).
- **Wallet-Style UI:** Redesigned to look like a digital wallet with card-based layouts, balance displays, and transaction-oriented navigation.
- **Key Integrations:**
  - Firebase Auth (login/signup)
  - Firebase RTDB (real-time balance/withdrawal/deposit data)
  - Lightning Network (invoice creation via `lndProxy` API routes)
  - MetaMask / Ethereum (via `ethers` + custom `useMetaMask` hook)
  - QR Code scanning (`html5-qrcode`) and generation (`qrcode.react`)
  - Bolt11 invoice decoding (`bolt11`)
  - **Real-time Price WebSockets:** Connects directly to Binance (`wss://stream.binance.com:9443/ws/btcusdt@ticker` and `wss://stream.binance.com:9443/ws/usdtcop@ticker`) for live BTC/USDT and USDT/COP pricing, replacing legacy REST API polling with a high-performance live feed.
- **Withdrawal UX Improvements:** 
  - Withdrawal submissions dynamically pause to execute an HTTP fetch against Binance APIs at the precise moment of submission, guaranteeing the freshest `btcUsdt` and `usdtCop` quotes are embedded as a `receipt` inside the RTDB withdrawal object.
  - Submissions feature a `window.confirm` safety dialog.
  - Timestamps utilize `Date.now()` directly to prevent serialization issues (`NaN`) that occur when passing Firebase's `serverTimestamp()` object wrapper back into number properties.
- **Deposit UI Overhaul:** "COP Depositos", "BTC Lightning", and "BTC On-Chain" deposits are organized into dedicated, premium UI cards below the BTC Wallet. The BTC Lightning and on-chain flows write directly to the unified `deposits` RTDB node to ensure automated balance computation.
- **BTC On-Chain Deposit UI Card**: Displays the user's active Bech32 Segwit deposit address (generated on-demand via secure `/api/getNewDepositAddress` backend call if not already present), a QR code, a copy-to-clipboard button, and an explanation of the 1-block confirmation requirement.
- **BTC On-Chain Withdrawal Flow**: Added as a withdrawal option in the interface. Enforces address validation via `bitcoin-address-validation`. Connects to the Mempool.space precise fee API in the background to present high-granularity sat/vB fees for three priority tiers (High, Medium, Low). Calculates and shows estimated network fees, the 1% platform fee, and total BTC to deduct. Sends the withdrawal through a secure backend Cloud Function.
- **BTC Lightning Withdrawal Flow**: Features full QR scanning (`html5-qrcode`) and paste/decode (`bolt11` invoice decoding) capabilities. Upon user confirmation, routes requests to the authenticated backend Cloud Function `processLightningWithdrawal`. The backend decodes and validates the invoice against LND, executes an atomic balance reservation on `balances/{uid}/BTCbalance` via database transaction, and routes payment via LND router with dynamic fee allowance (up to 2%) and 60-second timeouts. If routing fails, the reserved balance is immediately rolled back and friendly Spanish error explanations are returned. Upon success, the backend atomically records the settled withdrawal in RTDB `/withdrawals/{uid}/{requestId}`, adjusts weighted average buy price calculations, dispatches in-app alerts to `/notifications/{uid}`, and sends confirmation emails. Direct client database writes to `/withdrawals` are completely eliminated.
- **COP Bank Withdrawal Flow**: Allows bank withdrawal submissions in COP with live conversion to BTC, applying a 1% platform fee, and writing request records to `withdrawals/{uid}` for admin approval and manual processing.
- **Yield & Performance Metrics**: Yield percentage (Rendimiento) is computed dynamically from consolidated live market prices vs the user's weighted average purchase price and displayed directly in the BTC Wallet card alongside current buy values in COP.
- **Calculations Decoupling**: Offloads all balance deduction updates exclusively to atomic backend database transaction triggers, eliminating redundant manual calculations and client-side race conditions.
- **Admin Dashboard Portal (`/admin` page)**: A secure management console built exclusively for the admin user (`5XgksHrgmyeGqqKFYGVjQVM0KGl1`). Key features include:
  - **Node Liquidity Monitors**: Tracks live on-chain and lightning channel balances by fetching data from LND node proxy endpoints.
  - **System Metrics Tally**: Calculates Total Deposited BTC aggregated from all user balances and Total Fees Collected from 1% platform withdrawal fees.
  - **Profiles Search Engine**: Allows instant query searches by UID, Name, or National ID (Cédula), displaying real-time profile summaries, live yield calculations, total COP invested, and **Average Purchase Price in BTC/USDT terms** (converting the user's COP weighted cost basis by the live `usdtCop` quote). The *Registered Yield* has been removed to maintain focus on dynamic market metrics.
  - **Comprehensive Transaction details**: Both the selected user's movements and the global activity feeds display detailed receipts for settled transactions. This includes Binance market buy receipts for deposits (BTC bought, USDT spent, BTC/USDT rate, USDT/COP rate, trade price source, and Binance Order ID) and quote receipts for withdrawals (BTC/USDT, USDT/COP, and total COP values), alongside the complete untruncated Order ID (equipped with `select-all` helper class) and the original COP transaction amount.
  - **Manual Operations forms**: Allows the admin to record manual transactions. This includes:
    - **Manual Deposit**: Simulates a market buy in COP at a specific date and time, auto-calculating BTC bought.
    - **Manual Withdrawal**: Records a settled manual withdrawal with inputs for both COP and BTC amounts (featuring real-time auto-conversion based on live WebSocket exchange feeds), date, time, destination account, and destination account description.
- **Admin Unified View**: The admin user (`5XgksHrgmyeGqqKFYGVjQVM0KGl1`) now successfully runs both global administrative RTDB listeners (unassigned deposits, pending withdrawals) and personal listeners simultaneously. This ensures the admin can track global system metrics while also viewing their own personal BTC balances and historic movements.
- **Unified Activity Feed**: The notification bell modal combines all `deposits` and `withdrawals` for the user into a single chronological feed, sorted by timestamp descending. For the admin, this modal combines system-wide global notifications with their own personal movements. Displays `saldoCop`, market buy details (BTC bought, BTC/USDT price, USDT/COP price), and withdrawal receipts.
- **Build & Deploy:** `pnpm build` in `my-spa/` runs `next build` then syncs `.next/` to `functions/.next/` via `rsync`. Then `firebase deploy` from root.

## 📦 Deployment & Commands
- **GCP Authentication:** Use `gcloud auth application-default login` to grant MCP/CLI tools access to the project.
- **Build Frontend:** `cd my-spa && pnpm build` (builds Next.js and syncs `.next/` to `functions/.next/`).
- **Deploying All:** `cd my-spa && pnpm deploy` (builds + `firebase deploy` from root).
- **Deploying Functions Only:** `firebase deploy --only functions:<functionName>` from the project root. (e.g. `firebase deploy --only functions:nextServer`).
- **VM Maintenance:** `gcloud compute ssh lnd-proxy-vm2 --zone=us-central1-a` to access the proxy. Package updates (security updates for Docker, systemd, networking) should be run periodically.

## ⚠️ Important Quirks & Rules
* **Next.js Initialization:** `app.prepare()` must be initialized globally (via `const preparePromise = app.prepare();`) and `await`ed on each request. Do NOT `await app.prepare()` directly inside the `onRequest()` handler as this generates an `EventEmitter` memory leak crash.
* **Authentication Middleware:** Custom `verifyToken()` middleware ensures only Firebase-authenticated HTTP headers (Bearer token) can access restricted endpoints. Admin checks compare against `ADMIN_UID` defineString param.
* **Binance API Geoblocking:** Binance API is geoblocked from US-based Cloud Functions. The solution routes signed Binance requests through `lnd-proxy-vm2` to an Umbrel Edge Node running Nginx Proxy Manager, using CoinGecko API (`api.coingecko.com`) for independent BTC/USDT and COP/USDT pricing logic.
* **Monolithic Page Component:** `my-spa/src/app/page.tsx` is a large (~112KB) single-file component. Consider refactoring into smaller components for maintainability.
* **RTDB as Single Source of Truth:** Historical spreadsheet movements were migrated to native `/deposits` and `/withdrawals` nodes. `syncSheetsToRTDB` has been removed. The `BTCbalance` field in `/balances/{id}` is the authoritative BTC balance and is managed atomically by Cloud Function triggers (`onDepositSettled`, `notifyWithdrawalSettled`).
* **Identity Handling:** Both Google UIDs and National IDs (cédulas) are used uniformly as keys in RTDB (`/balances/{id}`, `/deposits/{id}`, etc.). The `/users/{id}` node (previously `users_directory`) provides an admin-searchable index for non-Google users.
* **Deposit Name Matching:** Bancolombia webhook matches deposits using only the first two words of the depositor's name (case-insensitive) against RTDB balance names. Deposits that don't match go to `unassignedDeposits`.

## ⏳ Pending Features
- **Move 'USDT (Polygon)' Deposits:** Move these from under the 'Ahorra Aqui' section to somewhere below 'BTC Lightning' deposits and add more stylish UI.
- **Automate BTC Buys from USDT (Polygon):** Investigate how to automate BTC buys when the user deposits USDT over the Polygon network.
