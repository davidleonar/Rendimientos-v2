# Security & Vulnerability Scan Report — my-project

- **Repository:** `https://github.com/davidleonar/my-project`
- **Project:** Rendimientos (Firebase project `rendimientos-5dbb9`)
- **Scan Date:** 2026-08-07
- **Scope:** Full codebase — `functions/` (1,707-line `index.js`, scripts, env files), `database.rules.json`, `firebase.json`, `lnd-proxy-vm2/proxy.js`, `my-spa/` config, `agent.md`, `.gitignore`, and full dependency audit (`pnpm audit`)
- **Totals:** 15 code-level findings + 59 dependency vulnerabilities (1 critical, 28 high, 27 moderate, 3 low)

---

## Part 1 — Code & Configuration Findings

### 🔴 CRITICAL

#### C1. LND Admin Macaroon Committed to Git (functions/.env.default)
Full admin macaroon for the main Lightning node committed in plaintext:

```
LND_MACAROON="0201036c6e6402f801030a1082f4cadbd734d464054914485e044e381201301a160a076164647265737312047265616412057772697465...00000620795ab76b30a6d0856ea98a0ecb45673b0e40458caaab2158a2f2cafbd9a31913"
```

Decoded permissions include `address`, `info`, `invoices`, `macaroon:generate`, `message`, `offchain`, `onchain`, `peers` — all with read/write. This is effectively root access to the node: create invoices, send on-chain/off-chain payments, bake new macaroons. Anyone with read access to this repo (now or historically) owns the node.

#### C2. Second AND Third Macaroon Hardcoded in lnd-proxy-vm2/proxy.js
The same main macaroon **plus the Edge node Taproot Assets macaroon** are hardcoded as constants:

```javascript
const MAIN_MACAROON = '0201036c6e6402f8...a31913';
const EDGE_MACAROON = '0201036c6e6402f801030a101a5c91aff535645ac3bf23689ed43df2...b7bd';
```

Both nodes' full credentials are in the repo. The proxy also falls back to a hardcoded default token: `BINANCE_PROXY_TOKEN = process.env.BINANCE_PROXY_TOKEN || 'rendimientos-token-umbrel'` — a predictable default that authenticates Binance API proxying.

#### C3. Secrets-Containing Env File Committed (functions/.env.rendimientos-5dbb9)
Contains operational secrets and infrastructure details:
- `INFURA_API_KEY="bef2925bd9084965a67249e7ea35cd77"`
- `LND_URL="http://35.208.122.165:3000"` and `PROXY_VM_URL="http://35.208.122.165:3000"` — public IP, plaintext HTTP
- `WEBHOOK_SECRET="david_…_123"` — weak, human-memorable secret
- `ADMIN_UID`, `ADMIN_EMAIL`/`SMTP_USER="davidleonar@gmail.com"`, USDT contract address, app wallet address

`.gitignore` ignores `.env` but NOT `.env.default` or `.env.rendimientos-5dbb9` — both pattern variants are in the repo.

#### C4. Webhook Authentication: Weak Token in URL Query (bancolombiaWebhook)
```javascript
if (req.query.token !== secretToken) {
  return res.status(403).send('Forbidden: Invalid token');
}
```
- Token travels as a URL query parameter — recorded in CDN/load-balancer logs, Cloud Logging, browser history, referrer headers.
- Secret value is weak (`david_…_123`).
- No HMAC signature, no timestamp/nonce (replay attacks possible), no IP allowlist, no rate limit.
- **Blast radius:** this single check protects the endpoint that parses deposits and **auto-executes Binance market buys**. Forging a request = triggering real BTC purchases and crediting arbitrary user balances.

#### C5. No Validation/Limits on Automated Binance Market Buys
`executeBinanceBuyOrder(usdtAmount)` builds `quoteOrderQty=${usdtAmount}` directly from webhook-parsed email amounts. There is:
- No min/max per-order cap, no daily/weekly volume cap
- No sanity check on parsed amounts (regex-parsed from email text — a crafted email body can inject any number)
- No per-user or per-day limits, no cooldown, no manual approval threshold
- No idempotency: the webhook has no deduplication — the same email re-sent (or replayed) creates a new deposit and a new market buy every time

Combined with C4, this is a direct path from an unauthenticated HTTP request to real-money exchange orders.

#### C6. Public Read/Write on `balances` (database.rules.json)
```json
"balances": { ".read": true, ".write": true }
```
- Anyone on the internet can read every user's balance, name, email-adjacent data, invested amounts, deposit addresses.
- Anyone can write arbitrary values directly into `balances/{uid}` — including `BTCbalance` — bypassing every Cloud Function control. The function-layer checks (admin UIDs, token verification) are irrelevant when the DB itself is world-writable.
- Writes here also fire the `onValueWritten` triggers (`onDepositSettled`, `notifyWithdrawalSettled`) indirectly via deposits/withdrawals paths — those nodes' rules should be checked in the same fix.

#### C7. Proxy VM Binds to Public Interface on HTTP (proxy.js + env)
- `server.listen(3000)` with no bind address = listens on `0.0.0.0`, and the env files point at the VM's public IP `35.208.122.165:3000` over **plain HTTP**.
- Macaroons and the Binance proxy token traverse the public internet unencrypted (headers `Grpc-Metadata-macaroon`, `x-binance-proxy-token` sniffable by anyone on path).
- The proxy forwards **all headers** to the target (`headers: req.headers`) and decides routing purely by credential match — it is an open relay to the main node, edge node, or Binance (via Nginx Proxy Manager) for anyone presenting valid creds... which are the ones committed in this repo (C1/C2). No logging, no rate limiting, no request size limits.

---

### 🟠 HIGH

#### H1. Hardcoded Admin UIDs in Multiple Layers
- `functions/index.js`: `const ADMIN_UIDS = [adminUid.value(), 'VldgsZCsJaOTrFT2uR2YvXxUe7o1'];` (lndProxy whitelist bypass)
- Inline comparisons in `createManualDeposit` / `createManualWithdrawal`: `req.user.uid !== adminUid.value() && req.user.uid !== 'VldgsZCsJaOTrFT2uR2YvXxUe7o1'`
- `database.rules.json`: both UIDs hardcoded for `withdrawals`, `deposits`, `unassignedDeposits`, `btcAddresses`
- `my-spa/src/app/admin/page.tsx` and `my-spa/src/app/api/lndProxy/[...path]/route.ts`: same UIDs client-side
No custom-claims RBAC, no MFA requirement for admin operations. UID is an identifier, not a secret — anyone who can mint/steal a session for these UIDs is admin everywhere.

#### H2. tapdProxy Forwards to LND_URL with No Path Whitelist
`tapdProxy` accepts `GET/POST/DELETE` and forwards any `path` to `${lndUrl.value()}${path}` using the **Edge macaroon** — for **any authenticated user** (no admin check, no endpoint whitelist, unlike lndProxy). Any signed-in user can invoke arbitrary Taproot Assets RPC endpoints, including DELETE methods, asset transfers, universe queries, etc.

#### H3. tapdProxy Logs Full Request Headers and Bodies
```javascript
console.log('tapdProxy request:', { method, path, xForwardedUrl, headers: req.headers, body: req.body });
```
`headers` includes the user's `Authorization: Bearer <Firebase ID token>` — tokens land in Cloud Logging, readable by anyone with log access, replayable until expiry. `lndProxy` does the same. Also logs `tapdData` responses, potentially leaking asset/channel data into logs.

#### H4. Name-Matching Deposit Attribution is Spoofable
The Bancolombia webhook matches deposits to users by comparing the **first two words of the depositor's name** (case-insensitive) against `balances/{uid}/name`:
```javascript
const parsedNameTokens = parsedName.split(/\s+/).slice(0, 2).join(' ');
if (dbNameTokens === parsedNameTokens && parsedNameTokens.length > 0) { matchedUid = ... }
```
- Collisions: any two users sharing first+last name tokens (extremely common in Colombian naming) misattribute funds.
- Spoofing: a depositor (or attacker triggering transfers) using a name matching a target user auto-credits that user AND triggers a Binance buy.
- No confirmation loop, no amount/schedule correlation, no manual review before the crypto purchase executes.

#### H5. Open CORS on Every HTTP Function
`const cors = require('cors')({ origin: true });` — reflects any origin, on all endpoints: lndProxy, tapdProxy, createManualDeposit, createManualWithdrawal, getNewDepositAddress, processOnChainWithdrawal. Combined with Bearer tokens stored in web clients, any malicious site can attempt credentialed API calls from users' browsers.

#### H6. Balance Manipulation via Public Rules + Trigger Side Effects
Because `deposits/{uid}/{depositId}` and `withdrawals/{uid}/{requestId}` triggers fire on `status: 'settled'` transitions, and the rules around deposits/withdrawals rely on per-path checks while `balances` is world-writable (C6), an attacker can:
- Write a fake settled deposit → `onDepositSettled` credits real `BTCbalance` via transaction.
- Directly overwrite `balances/{uid}/BTCbalance`, `totalCopInvested`, `avgBuyPrice` — corrupting accounting for every user.

#### H7. On-Chain Withdrawal: Race Between Balance Check and Broadcast
`processOnChainWithdrawal` reads balance, then broadcasts the LND transaction, then writes the settled withdrawal record (which triggers the deduction). The balance check and deduction are **not atomic** — concurrent withdrawal requests can each pass the balance check and all broadcast, overdrawing the account. Additionally, the network fee uses a hardcoded 148 vBytes estimate, and on broadcast failure the user has already passed validation with no compensating record.

#### H8. Dependency Vulnerabilities — High Severity (28)
28 high-severity advisories in the functions dependency tree (full list in Part 2), including exploitable issues in `next` (SSRF in Server Actions and rewrites on custom servers — this project runs Next inside a custom Cloud Functions server), `@grpc/grpc-js` crashes, `nodemailer` arbitrary file read/SSRF via `raw`, `ws` memory exhaustion, `protobufjs` DoS, `axios` proxy/prototype-pollution issues, `sharp`/libvips CVEs, `postcss` arbitrary file read, `brace-expansion`, `js-yaml`, `fast-uri`, `form-data`, `nanoid`.

---

### 🟡 MEDIUM

#### M1. No Rate Limiting Anywhere
No per-IP or per-user throttling on: webhook, withdrawals, manual admin ops, address generation, proxies, or the Next.js server. Abuse vectors: balance-probing, address exhaustion (each call to `getNewDepositAddress` grows the wallet keypool), email-spam via notification triggers, Binance order spam.

#### M2. Email HTML/Content Injection
User-controlled values (`name`, `userEmail`, `amount`, `bankData`, `bankName`, `parsedName` from external emails) are interpolated raw into `nodemailer` HTML templates sent to admin and users. Enables phishing-grade email spoofing from the official sender address (`davidleonar@gmail.com`), and nodemailer CRLF/header injection (see advisory 1120795).

#### M3. Sensitive Data in Logs
Beyond H3: webhook logs full raw email bodies (`console.log('Received email body:', emailBody)` — bank customer names/amounts), deposit/withdrawal PII, internal IPs/URLs, and proxy targets are logged at multiple points.

#### M4. No Audit Trail
No persistent audit log for: balance changes, admin manual deposits/withdrawals, Binance orders, failed auth attempts, webhook invocations. Incidents would be effectively un-investigable; Cloud Functions stdout is the only record.

#### M5. `lndProxy` Invoice Amount Unvalidated
Non-admin users are allowed `POST /v1/invoices` — the proxy forwards the body verbatim. There is no cap on `value_msat`, no memo filtering, no per-user invoice quota. A user can mint invoices of arbitrary size against the node's wallet (the my-spa Next.js API route variant has the same gap).

#### M6. Secrets in Repo History
Even if current files are cleaned, `functions/.env.default`, `functions/.env.rendimientos-5dbb9`, and both hardcoded macaroons in `proxy.js` exist in Git history. Deleting the files without history rewrite does not remediate.

#### M7. Predictable Internal Addresses / Metadata Exposure
`agent.md` documents architecture, env var names, admin UID strategy, internal Tailscale IPs (`100.103.9.71`, `100.68.2.83`), ports, and operational thresholds (10 USDT minimum) — a complete attack map, committed to the repo.

#### M8. firebase.json Hosting Gaps
`.env*` redirect-to-404 rules exist for Hosting, but the secrets exposure is at the repo level, not hosting. No security headers (no `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `Referrer-Policy`) configured for the hosted app.

---

### 🔵 LOW

#### L1. Error Messages Leak Internals
Endpoints return raw upstream errors to clients: `res.status(500).send('Internal Server Error: ' + err.message)` and proxy errors include LND response bodies (`details: text.substring(0, 200)`) — leaks node versions, paths, and failure modes useful for targeted attacks.

#### L2. Weak/Predictable Values Elsewhere
Default Binance proxy token `'rendimientos-token-umbrel'`, webhook secret pattern `david_…_123`, and documented UI password conventions indicate low-entropy secret hygiene overall.

#### L3. Unpinned Dependencies / Wide Ranges
`next ^15.4.6`, `firebase-functions ^7.0.0`, etc. pull in the vulnerable transitive versions listed below. No lockfile review process evident (audit required installing pnpm on the fly).

#### L4. Dependency Vulnerabilities — Low Severity (3)
`@babel/core` arbitrary file read via sourceMappingURL; `body-parser` DoS (two advisories).

---

## Part 2 — Full Dependency Audit (pnpm audit)

**59 vulnerabilities: 1 critical, 28 high, 27 moderate, 3 low**

| Severity | Package | Title | Vulnerable | Patched | Advisory |
|---|---|---|---|---|---|
| CRITICAL | websocket-driver | Message corruption via abuse of protocol length headers | <0.7.5 | >=0.7.5 | GHSA-xv26-6w52-cph6 |
| HIGH | @grpc/grpc-js | Malformed request can cause server crash | >=1.14.0 <1.14.4 | >=1.14.4 | GHSA-5375-pq7m-f5r2 |
| HIGH | @grpc/grpc-js | Malformed compressed message can crash client/server | >=1.14.0 <1.14.4 | >=1.14.4 | GHSA-99f4-grh7-6pcq |
| HIGH | form-data | CRLF injection via unescaped multipart field names | >=4.0.0 <4.0.6 | >=4.0.6 | GHSA-hmw2-7cc7-3qxx |
| HIGH | form-data | CRLF injection via unescaped multipart field names | <2.5.6 | >=2.5.6 | GHSA-hmw2-7cc7-3qxx |
| HIGH | nodemailer | raw option bypasses disableFileAccess/disableUrlAccess → arbitrary file read + SSRF | <=9.0.0 | >=9.0.1 | GHSA-p6gq-j5cr-w38f |
| HIGH | ws | Memory exhaustion DoS from tiny fragments | >=8.0.0 <8.21.0 | >=8.21.0 | GHSA-96hv-2xvq-fx4p |
| HIGH | protobufjs | DoS through unbounded Any expansion during JSON conversion | <=7.6.0 | >=7.6.1 | GHSA-wcpc-wj8m-hjx6 |
| HIGH | brace-expansion | DoS via exponential-time expansion of {} groups | >=2.0.0 <2.1.2 | >=2.1.2 | GHSA-3jxr-9vmj-r5cp |
| HIGH | brace-expansion | DoS via exponential-time expansion of {} groups | <1.1.16 | >=1.1.16 | GHSA-3jxr-9vmj-r5cp |
| HIGH | js-yaml | YAML merge-key chains force quadratic CPU consumption | >=3.0.0 <3.15.0 | >=3.15.0 | GHSA-52cp-r559-cp3m |
| HIGH | axios | HTTP adapter can use inherited proxy after interceptor config cloning | >=1.15.2 <1.18.0 | >=1.18.0 | GHSA-gcfj-64vw-6mp9 |
| HIGH | fast-uri | Host confusion via literal backslash authority delimiter | >=3.0.0 <=3.1.3 | >=3.1.4 | GHSA-v2hh-gcrm-f6hx |
| HIGH | sharp | Inherited libvips CVEs (CVE-2026-33327/33328/35590/35591) | <0.35.0 | >=0.35.0 | GHSA-f88m-g3jw-g9cj |
| HIGH | next | DoS in App Router using Server Actions | >=13.0.0 <15.5.21 | >=15.5.21 | GHSA-m99w-x7hq-7vfj |
| HIGH | next | SSRF in Server Actions on custom servers | >=14.1.1 <15.5.21 | >=15.5.21 | GHSA-89xv-2m56-2m9x |
| HIGH | next | SSRF in rewrites via attacker-controlled destination hostname | >=12.0.0 <15.5.21 | >=15.5.21 | GHSA-p9j2-gv94-2wf4 |
| HIGH | postcss | Arbitrary file read via sourceMappingURL in CSS comments | <=8.5.11 | >=8.5.12 | GHSA-6g55-p6wh-862q |
| HIGH | postcss | Path traversal in source map auto-loading → .map disclosure | <=8.5.17 | >=8.5.18 | GHSA-r28c-9q8g-f849 |
| HIGH | brace-expansion | DoS via unbounded expansion length (OOM) | <1.1.17 | >=1.1.17 | GHSA-mh99-v99m-4gvg |
| HIGH | brace-expansion | DoS via unbounded expansion length (OOM) | >=2.0.0 <2.1.3 | >=2.1.3 | GHSA-mh99-v99m-4gvg |
| HIGH | fast-uri | Host confusion via backslash authority introducer | >=3.0.0 <3.1.5 | >=3.1.5 | GHSA-7p8r-x3mc-p8w7 |
| HIGH | brace-expansion | DoS via unbounded intermediate arrays (bypasses CVE-2026-14257 fix) | >=2.0.0 <2.1.4 | >=2.1.4 | GHSA-rgw5-rvv9-x895 |
| HIGH | brace-expansion | DoS via unbounded intermediate arrays (bypasses CVE-2026-14257 fix) | <1.1.18 | >=1.1.18 | GHSA-rgw5-rvv9-x895 |
| HIGH | js-yaml | Quadratic CPU in !!omap resolution | >=3.0.0 <3.15.1 | >=3.15.1 | GHSA-5p4m-2wfm-xmqj |
| HIGH | fast-uri | Host confusion via failed IDN canonicalization | >=3.0.0 <3.1.3 | >=3.1.3 | GHSA-4c8g-83qw-93j6 |
| HIGH | nanoid | Non-secure generators loop indefinitely with negative size | <3.3.16 | >=3.3.16 | GHSA-28wg-ghj8-5hjv |
| HIGH | nanoid | Custom generators loop indefinitely when size is zero | <3.3.17 | >=3.3.17 | GHSA-2v37-7h3g-55p8 |
| MODERATE | postcss | XSS via unescaped </style> in CSS stringify output | <8.5.10 | >=8.5.10 | GHSA-qx2v-qp2m-jg93 |
| MODERATE | ws | Uninitialized memory disclosure | >=8.0.0 <8.20.1 | >=8.20.1 | GHSA-58qx-3vcg-4xpx |
| MODERATE | protobufjs | DoS via unbounded recursive JSON descriptor expansion | <=7.5.7 | >=7.5.8 | GHSA-jggg-4jg4-v7c6 |
| MODERATE | uuid | Missing buffer bounds check in v3/v5/v6 | <11.1.1 | >=11.1.1 | GHSA-w5hq-g745-h8pq |
| MODERATE | qs | Remotely triggerable DoS in qs.stringify | >=6.11.1 <=6.15.1 | >=6.15.2 | GHSA-q8mj-m7cp-5q26 |
| MODERATE | nodemailer | CRLF injection in List-* header comments → header injection | <=8.0.8 | >=8.0.9 | GHSA-268h-hp4c-crq3 |
| MODERATE | nodemailer | jsonTransport bypasses disableFileAccess/disableUrlAccess | <=8.0.8 | >=8.0.9 | GHSA-wqvq-jvpq-h66f |
| MODERATE | nodemailer | Improper TLS validation in OAuth2 token fetch → credential interception | <=8.0.7 | >=8.0.8 | GHSA-r7g4-qg5f-qqm2 |
| MODERATE | ts-deepmerge | Prototype method override → DoS | <8.0.0 | >=8.0.0 | GHSA-87mf-gv2c-c62c |
| MODERATE | js-yaml | Quadratic-complexity DoS via repeated aliases | <3.15.0 | >=3.15.0 | GHSA-h67p-54hq-rp68 |
| MODERATE | websocket-driver | Resource limit bypass via message compression | <0.7.5 | >=0.7.5 | GHSA-mp7j-qc5w-4988 |
| MODERATE | protobufjs | Schema-derived names shadow runtime-significant properties | <=7.6.2 | >=7.6.3 | GHSA-f38q-mgvj-vph7 |
| MODERATE | axios | Excessive recursion in formDataToJSON → DoS | >=1.0.0 <1.18.0 | >=1.18.0 | GHSA-42h9-826w-cgv3 |
| MODERATE | axios | Deep formToJSON key recursion → DoS | >=1.0.0 <1.18.0 | >=1.18.0 | GHSA-pmv8-rq9r-6j72 |
| MODERATE | axios | Fetch adapter ReadableStream uploads bypass maxBodyLength | >=1.7.0 <1.18.0 | >=1.18.0 | GHSA-jqh4-m9w3-8hp9 |
| MODERATE | axios | Prototype pollution gadgets alter request construction | >=1.0.0 <1.18.0 | >=1.18.0 | GHSA-mmx7-hfxf-jppx |
| MODERATE | axios | NO_PROXY bypass for 0.0.0.0 local addresses | >=1.15.0 <1.18.0 | >=1.18.0 | GHSA-f4gw-2p7v-4548 |
| MODERATE | protobufjs | DoS via infinite loop in .proto option parsing | >=7.5.0 <=7.6.4 | >=7.6.5 | GHSA-j3f2-48v5-ccww |
| MODERATE | axios | Form serializer maxDepth bypass via {} metatoken | >=1.15.1 <1.18.0 | >=1.18.0 | GHSA-hcpx-6fm6-wx23 |
| MODERATE | axios | Nested option objects consume polluted prototype values | >=1.0.0 <1.18.0 | >=1.18.0 | GHSA-7q8q-rj6j-mhjq |
| MODERATE | axios | HTTP/2 streamed uploads bypass maxBodyLength | >=1.13.0 <1.18.0 | >=1.18.0 | GHSA-mwf2-3pr3-8698 |
| MODERATE | next | Cache confusion of response bodies for requests with bodies | >=13.0.0 <15.5.21 | >=15.5.21 | GHSA-68g3-v927-f742 |
| MODERATE | next | Cache confusion with invalid UTF-8 byte sequences | >=13.0.0 <15.5.21 | >=15.5.21 | GHSA-4633-3j49-mh5q |
| MODERATE | next | Unbounded Server Action payload in Edge runtime | >=13.0.0 <15.5.21 | >=15.5.21 | GHSA-4c39-4ccg-62r3 |
| MODERATE | next | DoS in Image Optimization API using SVGs | >=15.5.0 <15.5.21 | >=15.5.21 | GHSA-q8wf-6r8g-63ch |
| MODERATE | next | Unauthenticated disclosure of internal Server Function endpoints | >=13.0.0 <15.5.21 | >=15.5.21 | GHSA-955p-x3mx-jcvp |
| MODERATE | postcss | Incomplete fix of GHSA-6g55-p6wh-862q — arbitrary .map reads | <=8.5.22 | >=8.5.23 | GHSA-fxqj-rqcc-2cmp |
| MODERATE | axios | Prototype pollution auth subfields can inject Basic auth | >=1.15.2 <1.18.0 | >=1.18.0 | GHSA-xj6q-8x83-jv6g |
| LOW | @babel/core | Arbitrary file read via sourceMappingURL comment | <=7.29.0 | >=7.29.1 | GHSA-4x5r-pxfx-6jf8 |
| LOW | body-parser | DoS when invalid limit disables size enforcement | >=2.0.0 <2.3.0 | >=2.3.0 | GHSA-v422-hmwv-36x6 |
| LOW | body-parser | DoS when invalid limit disables size enforcement | <1.20.6 | >=1.20.6 | GHSA-v422-hmwv-36x6 |

---

## Part 3 — Summary Table

| # | Severity | Finding | Location |
|---|---|---|---|
| C1 | Critical | LND admin macaroon committed | functions/.env.default |
| C2 | Critical | Main + Edge macaroons hardcoded, default proxy token | lnd-proxy-vm2/proxy.js |
| C3 | Critical | Secrets-laden env file committed (Infura key, IPs, weak webhook secret) | functions/.env.rendimientos-5dbb9 |
| C4 | Critical | Webhook auth = weak token in URL query; no HMAC/replay/IP protection | functions/index.js (bancolombiaWebhook) |
| C5 | Critical | Unvalidated, unlimited auto Binance market buys; no idempotency | functions/index.js (executeBinanceBuyOrder) |
| C6 | Critical | `balances` world read/write | database.rules.json |
| C7 | Critical | Public HTTP proxy forwarding credentialed traffic; open relay w/ committed creds | lnd-proxy-vm2/proxy.js |
| H1 | High | Hardcoded admin UIDs across rules, backend, frontend | rules, index.js, my-spa |
| H2 | High | tapdProxy: no whitelist, DELETE allowed, any authed user | functions/index.js |
| H3 | High | Full headers (Bearer tokens) + bodies logged | lndProxy, tapdProxy |
| H4 | High | Name-based deposit attribution spoofable/collidable; auto-triggers buys | bancolombiaWebhook |
| H5 | High | Open CORS (`origin: true`) on all endpoints | functions/index.js |
| H6 | High | Fake settled deposit → real balance credit via triggers | rules + onDepositSettled |
| H7 | High | Non-atomic balance check/broadcast race in on-chain withdrawals | processOnChainWithdrawal |
| H8 | High | 28 high-severity dependency advisories (incl. next SSRF on custom servers) | dependency tree |
| M1 | Medium | No rate limiting | all endpoints |
| M2 | Medium | Email HTML/header injection | nodemailer templates |
| M3 | Medium | PII/secrets/internal data in logs | multiple functions |
| M4 | Medium | No audit trail | system-wide |
| M5 | Medium | Invoice creation unvalidated (amount/quota) | lndProxy |
| M6 | Medium | Secrets persist in Git history | repo |
| M7 | Medium | Attack-map documentation (IPs, thresholds, internals) in repo | agent.md |
| M8 | Medium | No security headers on hosting | firebase.json |
| L1 | Low | Raw upstream errors leaked to clients | multiple endpoints |
| L2 | Low | Predictable default secrets/tokens | proxy.js, env files |
| L3 | Low | Unpinned/wide dependency ranges | package.json |
| L4 | Low | 3 low-severity dependency advisories | dependency tree |

## Overall Assessment

**Risk Level: CRITICAL.** Three separate full node-credentials exposures (C1, C2), a world-writable balances database (C6), and an unauthenticated-to-money pipeline (C4+C5) are each independently capable of causing direct financial loss today. The exposed macaroons and secrets must be considered compromised regardless of whether abuse has been observed.
