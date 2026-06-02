# Rendimientos Project Architecture & Agent Guide

## 🏢 Project Information
- **Google Cloud Platform & Firebase Project ID:** `rendimientos-5dbb9` (`rendimientos`)
- **Primary Region:** `us-central1`
- **RTDB URL:** `https://rendimientos-5dbb9-default-rtdb.firebaseio.com/`
- **Application Frontend:** Next.js 15 (App Router + Pages Router hybrid), deployed serverless via Firebase Functions.
- **Frontend SPA Source:** `my-spa/` directory — a standalone Next.js project (TypeScript, TailwindCSS 3) that builds into `functions/.next/`.
- **Backend Stack:** Node.js v22 (Cloud Functions 2nd Gen), Firebase Realtime Database (RTDB), Firebase Authentication.
- **Package Manager:** `pnpm` (used in both `functions/` and `my-spa/`).
- **Admin UID:** `5XgksHrgmyeGqqKFYGVjQVM0KGl1` (hardcoded in RTDB rules and referenced via `ADMIN_UID` defineString param in functions).

## 📂 Repository Structure
```
my-project/
├── agent.md                    # This file
├── firebase.json               # Hosting rewrites, functions config
├── database.rules.json         # RTDB security rules
├── functions/
│   ├── index.js                # All Cloud Functions (~1057 lines)
│   ├── package.json            # Node 22, firebase-functions v7, nodemailer, googleapis, ethers, next 15
│   ├── serviceAccountKey.json  # Google Sheets API auth
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
* **`getDataById`**: HTTP endpoint that securely fetches balance data from RTDB. Includes admin bypass via `ADMIN_UID` comparison and UID-based filtering for regular users.
* ~~**`syncSheetsToRTDB`**~~: **DEPRECATED & REMOVED.** Google Sheets is no longer the source of truth. Historical movements were migrated to native RTDB `/deposits` and `/withdrawals` nodes. RTDB is now the single source of truth for all balance and transaction data.

### LND / Taproot Proxies
* **`lndProxy`**: Secure proxy forwarding JSON requests to the Main Lightning Node using `MAIN_LND_MACAROON` secret. Supports GET/POST. Blocks GET on `/v1/invoices`. Uses `x-forwarded-url` header fallback for path resolution.
* **`tapdProxy`**: Secure proxy forwarding to the Edge Taproot Assets node using `EDGE_TAPD_MACAROON` secret. Supports GET/POST/DELETE. Requires Firebase auth (`verifyToken`).

### Balance Update Triggers
* **`onDepositSettled`**: `onValueWritten` trigger on `deposits/{uid}/{depositId}`. Explicitly configured with `512MiB` memory limit. When a deposit's status changes to `'settled'`, atomically increments `balances/{uid}/BTCbalance` using a database transaction based on `marketBuy.btcBought`. Also updates `totalCopInvested` and recomputes `avgBuyPrice` (weighted average buy price in COP/BTC).
* **`notifyWithdrawalSettled`**: `onValueWritten` trigger on `withdrawals/{uid}/{requestId}`. Explicitly configured with `512MiB` memory limit. When status changes to `'settled'`, atomically deducts `totalBtcToDeduct` from `balances/{uid}/BTCbalance` using a transaction, proportionally reduces `totalCopInvested`, recomputes `avgBuyPrice`, then sends settlement confirmation email to the user.

### Withdrawal System (Email Notifications via `nodemailer`)
* **`notifyGlobalWithdrawal`**: Eventarc-triggered on `withdrawals/{uid}/{requestId}` creation in RTDB. Explicitly configured with `512MiB` memory limit. Sends admin notification email AND user confirmation email.

### Bancolombia Deposit Webhook
* **`bancolombiaWebhook`**: HTTP endpoint secured by `WEBHOOK_SECRET` query parameter. Receives forwarded Bancolombia email alerts, parses them via regex to extract depositor name, amount, date, and time. Normalizes the deposited amount to store it as a clean JavaScript number (e.g. `12000` instead of `"12,000.00"`). Matches deposits to users by comparing the first two words of the parsed name against RTDB `balances` names (case-insensitive). Matched deposits go to `deposits/{uid}` + `deposits/all/{key}`, unmatched go to `unassignedDeposits`. 
  * **Failover Price Feed**: Uses a centralized `getPrices()` helper which queries CoinGecko for live prices (`BTC/USDT`, `USDT/COP`) and automatically falls back to Coinbase API if CoinGecko returns an error or is unreachable. Saves `priceSource` inside the deposit object's `marketBuy` receipt for complete auditability.
  * **Small Deposits**: For matched deposits, evaluates the COP amount against a 10 USDT equivalent threshold. If the amount is below 10 USDT, the deposit status is immediately finalized as `'settled'` directly in RTDB (with 0 BTC bought) to prevent small transactions from lingering indefinitely.
  * **Automated Crypto Purchases**: For deposits >= 10 USDT, evaluates the COP amount and verifies Binance USDT liquidity via the Proxy VM. If sufficient, a `MARKET BUY` for `BTCUSDT` is executed. The resulting BTC is added to `cryptoBalances/{uid}` along with trade details, price source, and status set to `'settled'`, and both user and admin are emailed. If insufficient liquidity or both pricing sources fail, admin receives an urgent warning.

## 🗄️ Realtime Database Schema
```
rendimientos-5dbb9-default-rtdb/
├── balances/
│   └── {id}/                   # User balance data (id = Google UID or National ID)
│       ├── id, name, uid, ...  # Balance fields
│       ├── BTCbalance          # Authoritative BTC balance (atomically updated by Cloud Functions)
│       ├── totalCopInvested    # Total COP currently invested (reduced proportionally on withdrawal)
│       └── avgBuyPrice         # Weighted average buy price (COP/BTC) = totalCopInvested / BTCbalance
├── deposits/
│   ├── {id}/                   # All deposits per user (Bancolombia webhook + migrated historical "Compra")
│   │   └── {depositId}/
│   │       ├── uid, depositId, parsedName, saldoCop
│   │       ├── date, time, timestamp, status ('settled')
│   │       ├── userNotified
│   │       └── marketBuy        # {btcBought, usdtCopPrice, btcUsdtPrice}
│   └── all/                    # Master log of all matched deposits
│       └── {depositId}/
├── withdrawals/
│   └── {id}/
│       └── {requestId}/        # Withdrawal request data
│           ├── uid, requestId, saldoCop, totalBtcToDeduct
│           ├── option, status ('pending' → 'settled')
│           └── quote            # {usdtCop, btcUsdt}
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
└── userSavings/
    └── {uid}/
        └── {txHash}/           # Write-once savings records (validated: userId === $uid)
```

> **Note:** `cryptoBalances/` is strictly deprecated and should not be relied upon. The UI currently still aggregates it via `cryptoBalance + syncBtcBalance` for legacy display, but backend deduction logic should be stripped from the frontend `handleSettle` to prevent data desyncs or double-deductions.

## 🔐 RTDB Security Rules (`database.rules.json`)
- **`balances`**: Read and write are globally enabled (`true`/`true`) for balance tracking.
- **`cryptoBalances/{uid}`**: Owner or admin can read. Write is restricted to the admin UID only.
- **`withdrawals`**: Admin can read/write the entire node. Authenticated users can read/write only their own `{uid}` subtree.
- **`deposits`**: Admin can read/write the entire node. Authenticated users can read/write only their own `{uid}` subtree.
- **`unassignedDeposits`**: Admin-only read/write.
- **`userSavings/{uid}/{txHash}`**: Owner or admin can read. Write-once is enabled for the owner (`!data.exists()`) and must validate `newData.child('userId').val() === $uid` to prevent cross-user writes.

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

## 🔌 LND Infrastructure & Virtual Machines
- **VM Name:** `lnd-proxy-vm2` (Compute Engine `e2-small` running in `us-central1-a`)
- **Purpose:** Acts as a reverse proxy between the public Cloud Functions (`lndProxy` / `tapdProxy`) and internal Tailscale-networked nodes (`Umbrel`/Lightning nodes).
- **Proxy Script:** Node.js app located at `/home/davidleonar/proxy.js` listening on port `3000`.
- **Process Management:** The proxy runs as a background daemon using `pm2` (started via `pm2 start proxy.js --name proxy`). Its configuration is saved (`pm2 save`) to automatically recover across instance reboots.
- **Node Routing Logic:**
  1. Compares incoming `Grpc-Metadata-macaroon` and `x-binance-proxy-token` headers against hardcoded trusted tokens.
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
- **Styling:** TailwindCSS 3.4
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
- **Deposit UI Overhaul:** "COP Depositos" and "BTC Lightning" deposits have been extracted from the legacy "Ahorra Aqui" dropdown into dedicated, premium UI cards below the BTC Wallet. The BTC Lightning deposit flow now writes directly to the unified `deposits` RTDB node to ensure automated balance computation.
- **BTC Lightning Withdrawal Flow**: Features full QR scanning (`html5-qrcode`) and paste/decode (`bolt11` invoice decoding) capabilities. It dynamically computes base and partner fees, performs client-side balance checks against `syncBtcBalance` to block excessive withdrawals, sends payments via LND Node client endpoints `/api/lndProxy/v1/channels/transactions`, and registers the successful result directly as `'settled'` in RTDB `/withdrawals`. The submission payload calculates the precise COP equivalent of the satoshis using the live price feeds and stores it under the `amount` key for consistent bookkeeping.
- **COP Bank Withdrawal Flow**: Allows bank withdrawal submissions in COP with live conversion to BTC, applying a 1% platform fee, and writing request records to `withdrawals/{uid}` for admin approval and manual processing.
- **Yield & Performance Metrics**: Yield percentage (Rendimiento) is computed dynamically from consolidated live market prices vs the user's weighted average purchase price and displayed directly in the BTC Wallet card alongside current buy values in COP.
- **Calculations Decoupling**: Offloads all balance deduction updates exclusively to atomic backend database transaction triggers, eliminating redundant manual calculations and client-side race conditions.
- **Admin Dashboard Portal (`/admin` page)**: A secure management console built exclusively for the admin user (`5XgksHrgmyeGqqKFYGVjQVM0KGl1`). Key features include:
  - **Node Liquidity Monitors**: Tracks live on-chain and lightning channel balances by fetching data from LND node proxy endpoints.
  - **System Metrics Tally**: Calculates Total Deposited BTC aggregated from all user balances and Total Fees Collected from 1% platform withdrawal fees.
  - **Profiles Search Engine**: Allows instant query searches by UID, Name, or National ID (Cédula), displaying real-time profile summaries, live yield calculations, total COP invested, and **Average Purchase Price in BTC/USDT terms** (converting the user's COP weighted cost basis by the live `usdtCop` quote). The *Registered Yield* has been removed to maintain focus on dynamic market metrics.
  - **Comprehensive Transaction details**: Both the selected user's movements and the global activity feeds display detailed receipts for settled transactions. This includes Binance market buy receipts for deposits (BTC bought, USDT spent, BTC/USDT rate, USDT/COP rate, trade price source, and Binance Order ID) and quote receipts for withdrawals (BTC/USDT, USDT/COP, and total COP values), alongside the complete untruncated Order ID (equipped with `select-all` helper class) and the original COP transaction amount.
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
* **Service Accounts:** Google Sheets API calls rely on the `--keyFile='./serviceAccountKey.json'` strategy. Verify this file exists during deployment setup.
* **Authentication Middleware:** Custom `verifyToken()` middleware ensures only Firebase-authenticated HTTP headers (Bearer token) can access restricted endpoints. Admin checks compare against `ADMIN_UID` defineString param.
* **Binance API Geoblocking:** Binance API is geoblocked from US-based Cloud Functions. The solution routes signed Binance requests through `lnd-proxy-vm2` to an Umbrel Edge Node running Nginx Proxy Manager, using CoinGecko API (`api.coingecko.com`) for independent BTC/USDT and COP/USDT pricing logic.
* **Monolithic Page Component:** `my-spa/src/app/page.tsx` is a large (~112KB) single-file component. Consider refactoring into smaller components for maintainability.
* **RTDB as Single Source of Truth:** Historical spreadsheet movements were migrated to native `/deposits` and `/withdrawals` nodes. `syncSheetsToRTDB` has been removed. The `BTCbalance` field in `/balances/{id}` is the authoritative BTC balance and is managed atomically by Cloud Function triggers (`onDepositSettled`, `notifyWithdrawalSettled`).
* **Identity Handling:** Both Google UIDs and National IDs (cédulas) are used uniformly as keys in RTDB (`/balances/{id}`, `/deposits/{id}`, etc.). The `/users/{id}` node (previously `users_directory`) provides an admin-searchable index for non-Google users.
* **Deposit Name Matching:** Bancolombia webhook matches deposits using only the first two words of the depositor's name (case-insensitive) against RTDB balance names. Deposits that don't match go to `unassignedDeposits`.

## ⏳ Pending Features
- **Move 'USDT (Polygon)' Deposits:** Move these from under the 'Ahorra Aqui' section to somewhere below 'BTC Lightning' deposits and add more stylish UI.
- **Automate BTC Buys from USDT (Polygon):** Investigate how to automate BTC buys when the user deposits USDT over the Polygon network.
- **On-Chain BTC Deposits & Withdrawals:** Implement on-chain deposit address generation (segwit bech32 via LND node), manual/automatic transaction syncing to match deposits, credit balances, and compute COP yield cost basis dynamically. Integrate authenticated on-chain withdrawals via a secure Cloud Function enforcing 1% platform fee + network fee checks prior to LND transaction broadcast.
