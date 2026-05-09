# Rendimientos Project Architecture & Agent Guide

## 🏢 Project Information
- **Google Cloud Platform & Firebase Project ID:** `rendimientos-5dbb9` (`rendimientos`)
- **Primary Region:** `us-central1`
- **RTDB URL:** `https://rendimientos-5dbb9-default-rtdb.firebaseio.com/`
- **Application Frontend:** Next.js 15 (App Router + Pages Router hybrid), deployed serverless via Firebase Functions.
- **Frontend SPA Source:** `my-spa/` directory — a standalone Next.js project (TypeScript, TailwindCSS 3) that builds into `functions/.next/`.
- **Backend Stack:** Node.js v22 (Cloud Functions 2nd Gen), Google Sheets Data Sync, Firebase Realtime Database (RTDB), Firebase Authentication.
- **Admin UID:** `5XgksHrgmyeGqqKFYGVjQVM0KGl1` (hardcoded in RTDB rules and referenced via `ADMIN_UID` defineString param in functions).

## 📂 Repository Structure
```
my-project/
├── agent.md                    # This file
├── firebase.json               # Hosting rewrites, functions config
├── database.rules.json         # RTDB security rules
├── functions/
│   ├── index.js                # All Cloud Functions (868 lines)
│   ├── package.json            # Node 22, firebase-functions v7, nodemailer, googleapis, ethers, next 15
│   ├── serviceAccountKey.json  # Google Sheets API auth
│   ├── .env / .env.local       # Environment config
│   └── .next/                  # Built Next.js output (synced from my-spa)
├── my-spa/                     # Frontend SPA (Next.js 15 + TypeScript + TailwindCSS)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Main app (~102KB monolithic page component)
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
* **`getDataById`** / **`getMovementsById`**: HTTP endpoints that securely fetch balance and movement data directly from specific Google Spreadsheets. Include admin bypass via `ADMIN_UID` comparison and UID-based row filtering for regular users.
* **`syncSheetsToRTDB`**: Auth-required function that pulls balances and movements from two Google Spreadsheets and populates the `balances` node in RTDB. Restructures data by ID and nests movements under each user's balance. Triggered automatically on user login (no longer requires manual admin button).

### LND / Taproot Proxies
* **`lndProxy`**: Secure proxy forwarding JSON requests to the Main Lightning Node using `MAIN_LND_MACAROON` secret. Supports GET/POST. Blocks GET on `/v1/invoices`. Uses `x-forwarded-url` header fallback for path resolution.
* **`tapdProxy`**: Secure proxy forwarding to the Edge Taproot Assets node using `EDGE_TAPD_MACAROON` secret. Supports GET/POST/DELETE. Requires Firebase auth (`verifyToken`).

### Withdrawal System (Email Notifications via `nodemailer`)
* **`notifyGlobalWithdrawal`**: Eventarc-triggered on `withdrawals/{uid}/{requestId}` creation in RTDB. Sends admin notification email AND user confirmation email.
* **`notifyWithdrawalSettled`**: Eventarc-triggered on `withdrawals/{uid}/{requestId}` update. Fires only when `status` changes to `'settled'`, sends settlement confirmation to the user's email.

### Bancolombia Deposit Webhook
* **`bancolombiaWebhook`**: HTTP endpoint secured by `WEBHOOK_SECRET` query parameter. Receives forwarded Bancolombia email alerts, parses them via regex to extract depositor name, amount, date, and time. Matches deposits to users by comparing the first two words of the parsed name against RTDB `balances` names (case-insensitive). Matched deposits go to `deposits/{uid}` + `deposits/all/{key}`, unmatched go to `unassignedDeposits`. 
  * **Automated Crypto Purchases**: For matched deposits, evaluates the COP amount against a 10 USDT equivalent threshold (using CoinGecko for both `USDT/COP` and `BTC/USDT` prices). If met, it securely checks Binance USDT liquidity via the Proxy VM. If sufficient, a `MARKET BUY` for `BTCUSDT` is executed. The resulting BTC is added to `cryptoBalances/{uid}` along with trade details saved in the deposit record, and both user and admin are emailed. If insufficient liquidity or CoinGecko fails, admin receives an urgent warning.

## 🗄️ Realtime Database Schema
```
rendimientos-5dbb9-default-rtdb/
├── balances/
│   └── {uid}/                  # User balance data (synced from Spreadsheets)
│       ├── id, name, uid, ...  # Balance fields from spreadsheet
│       └── movements/[]        # Array of movement records
├── cryptoBalances/
│   └── {uid}/                  # Automated BTC wallet balances
│       ├── balance             # Total BTC owned
│       └── updatedAt           # Timestamp of last buy
├── withdrawals/
│   └── {uid}/
│       └── {requestId}/        # Withdrawal request data
│           ├── userId, name, userEmail, amount, option
│           ├── bankData, bankName, country
│           └── status           # 'pending' → 'settled'
├── deposits/
│   ├── {uid}/                  # Matched Bancolombia deposits per user
│   │   └── {depositId}/
│   │       ├── parsedName, amount, date, time
│   │       ├── rawEmail, timestamp, status ('settled')
│   │       ├── userNotified
│   │       └── marketBuy        # (Optional) {btcBought, usdtSpent, orderId, usdtCopPrice, btcUsdtPrice}
│   └── all/                    # Master log of all matched deposits
│       └── {depositId}/
├── unassignedDeposits/         # Deposits that couldn't be matched to a user
│   └── {depositId}/
│       ├── parsedName, amount, date, time
│       ├── rawEmail, timestamp, status ('unassigned')
│       └── adminNotified
└── userSavings/
    └── {uid}/
        └── {txHash}/           # Write-once savings records (validated: userId === $uid)
```

## 🔐 RTDB Security Rules (`database.rules.json`)
- **`balances/{id}`**: Read by owner or admin. Write: disabled (server-managed).
- **`cryptoBalances/{uid}`**: Read by owner or admin. Write: disabled (server-managed/admin only).
- **`withdrawals`**: Admin can read/write entire node. Users can read/write only their own `{uid}` subtree.
- **`deposits`**: Admin can read/write entire node. Users can read/write only their own `{uid}` subtree.
- **`unassignedDeposits`**: Admin-only read/write.
- **`userSavings/{uid}/{txHash}`**: Read by owner or admin. Write-once only (can't overwrite existing), must include `userId === $uid`.

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
  - **Real-time Price WebSockets:** Connects directly to Binance (`wss://stream.binance.com:9443/ws/btcusdt@ticker`) for live BTC/USDT pricing, efficiently replacing legacy REST API polling.
- **Data Aggregation:** The BTC Wallet UI displays a dynamically summed balance (`cryptoBalance` from automated purchases + `BTCBalance` from synced spreadsheet). User "Movements" natively merge spreadsheet records with newly mapped RTDB automated deposit objects.
- **Notification System:** Modal-based notification history (replaced browser `alert()` dialogs). Bell icon UI for both user deposit notifications and admin unassigned deposit alerts. For automated crypto purchases, the UI presents key metrics (BTC Bought, BTC/USDT price, USDT/COP price) while keeping backend-only data (like Order ID and USDT spent) hidden.
- **Build & Deploy:** `npm run build` in `my-spa/` runs `next build` then syncs `.next/` to `functions/.next/` via `rsync`. Then `firebase deploy` from root.

## 📦 Deployment & Commands
- **GCP Authentication:** Use `gcloud auth application-default login` to grant MCP/CLI tools access to the project.
- **Build Frontend:** `cd my-spa && npm run build` (builds Next.js and syncs `.next/` to `functions/.next/`).
- **Deploying All:** `cd my-spa && npm run deploy` (builds + `firebase deploy` from root).
- **Deploying Functions Only:** `firebase deploy --only functions:<functionName>` from the project root. (e.g. `firebase deploy --only functions:nextServer`).
- **VM Maintenance:** `gcloud compute ssh lnd-proxy-vm2 --zone=us-central1-a` to access the proxy. Package updates (security updates for Docker, systemd, networking) should be run periodically.

## ⚠️ Important Quirks & Rules
* **Next.js Initialization:** `app.prepare()` must be initialized globally (via `const preparePromise = app.prepare();`) and `await`ed on each request. Do NOT `await app.prepare()` directly inside the `onRequest()` handler as this generates an `EventEmitter` memory leak crash.
* **Service Accounts:** Google Sheets API calls rely on the `--keyFile='./serviceAccountKey.json'` strategy. Verify this file exists during deployment setup.
* **Authentication Middleware:** Custom `verifyToken()` middleware ensures only Firebase-authenticated HTTP headers (Bearer token) can access restricted endpoints. Admin checks compare against `ADMIN_UID` defineString param.
* **Binance API Geoblocking:** Binance API is geoblocked from US-based Cloud Functions. The solution routes signed Binance requests through `lnd-proxy-vm2` to an Umbrel Edge Node running Nginx Proxy Manager, using CoinGecko API (`api.coingecko.com`) for independent BTC/USDT and COP/USDT pricing logic.
* **Monolithic Page Component:** `my-spa/src/app/page.tsx` is a large (~102KB) single-file component. Consider refactoring into smaller components for maintainability.
* **RTDB Sync on Login:** Spreadsheet-to-RTDB sync now triggers automatically on user login; the manual admin "Sync with RTDB" button has been removed. `balances` are explicitly keyed by `uid`.
* **Deposit Name Matching:** Bancolombia webhook matches deposits using only the first two words of the depositor's name (case-insensitive) against RTDB balance names. Deposits that don't match go to `unassignedDeposits`.
* **Spreadsheet Query Ranges:** `getMovementsById` targets `Sheet1!A1:H120`. If adding new columns to the sheet, ensure this range is extended in `functions/index.js`.
