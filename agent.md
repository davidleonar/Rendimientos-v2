# Rendimientos Project Architecture & Agent Guide

## 🏢 Project Information
- **Google Cloud Platform & Firebase Project ID:** `rendimientos-5dbb9` (`rendimientos`)
- **Primary Region:** `us-central1`
- **Application Frontend:** Next.js (Version unknown, serverless deployment via Firebase Functions).
- **Backend Stack:** Node.js v22 (Cloud Functions 2nd Gen), Google Sheets Data Sync, Firebase Realtime Database (RTDB), Firebase Authentication.

## ☁️ Cloud Functions (`functions/index.js`)
The application defines several important 2nd Gen HTTP Cloud Functions:
* `nextServer`: Serves the primary Next.js web application. Must explicitly have memory set (e.g., `512MiB`) to prevent SSR / Image optimization memory leak crashes (OOM `256MiB`).
* `getDataById` / `getMovementsById`: HTTP endpoints that securely fetch balance and movement data directly from specific Google Spreadsheets.
* `syncSheetsToRTDB`: An admin-only function that pulls balances and movements from Spreadsheets and populates the `balances` list in the Firebase Realtime Database (`rendimientos-5dbb9-default-rtdb.firebaseio.com`).
* `lndProxy` & `tapdProxy`: Specialized secure proxies that accept JSON requests and forward them to internal Lightning Network/Taproot nodes using hard-coded Macaroons (`MAIN_LND_MACAROON`, `EDGE_TAPD_MACAROON`).
* `notifyGlobalWithdrawal`: An Eventarc-triggered function hooked to the `"withdrawals/{uid}/{requestId}"` RTDB table, which automatically emails the admin via `nodemailer` when a user requests a withdrawal. 

## 🔌 LND Infrastructure & Virtual Machines
- **VM Name:** `lnd-proxy-vm2` (Compute Engine `e2-small` running in `us-central1-a`)
- **Purpose:** Acts as a reverse proxy between the public Cloud Functions (`lndProxy` / `tapdProxy`) and internal Tailscale-networked nodes (`Umbrel`/Lightning nodes).
- **Proxy Script:** Node.js app located at `/home/davidleonar/proxy.js` listening on port `3000`.
- **Process Management:** The proxy runs as a background daemon using `pm2` (started via `pm2 start proxy.js --name proxy`). Its configuration is saved (`pm2 save`) to automatically recover across instance reboots.
- **Node Routing Logic:**
  1. Compares incoming `Grpc-Metadata-macaroon` headers against hardcoded trusted tokens.
  2. If matching the `MAIN_MACAROON`, it forwards the traffic to the Main Node IP (`100.103.9.71:8080`) securely via `./mainnode/tls.cert`.
  3. If matching the `EDGE_MACAROON`, it forwards the traffic to the Edge Node IP (`100.68.2.83:8080`) over `./edgenode/tls.cert`.

## 📦 Deployment & Commands
- **GCP Authentication:** Use `gcloud auth application-default login` to grant MCP/CLI tools access to the project.
- **Deploying Functions:** You do not need to reboot VMs to deploy functions. Run `firebase deploy --only functions:<functionName>` from the active workspace. (e.g. `firebase deploy --only functions:nextServer`).
- **VM Maintenance:** You can `gcloud compute ssh lnd-proxy-vm2 --zone=us-central1-a` to maintain the proxy. Package updates (security updates for Docker, systemd, networking) should be run periodically.

## ⚠️ Important Quirks & Rules
* **Next.js Initialization:** `app.prepare()` must be initialized globally (via `const preparePromise = app.prepare();`) and `await`ed on each request. Do NOT `await app.prepare()` directly inside the `onRequest()` handler as this generates an `EventEmitter` memory leak crash.
* **Service Accounts:** Google Sheets API calls rely on the `--keyFile='./serviceAccountKey.json'` strategy. Verify this file exists during deployment setup.
* **Authentication Middleware:** Custom `verifyToken()` middleware ensures only Firebase-authenticated HTTP headers (Bearer token) can access restricted endpoints. Admin checks check against `ADMIN_UID` defineString param.
