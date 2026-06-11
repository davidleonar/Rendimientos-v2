const crypto = require('crypto');
const { execSync } = require('child_process');

function getSecret(secretName) {
  try {
    return execSync(`gcloud secrets versions access latest --secret=${secretName} --project=rendimientos-5dbb9`, { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`Failed to fetch secret ${secretName} from gcloud:`, err.message);
    process.exit(1);
  }
}

async function testEndpoint(name, url, method, headers, body = null) {
  console.log(`\n--- Testing ${name} ---`);
  console.log(`URL: ${url}`);
  console.log(`Method: ${method}`);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    console.log(`Status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`Response: ${text.substring(0, 500)}`);
    return response.ok;
  } catch (err) {
    console.error(`Error testing ${name}:`, err);
    return false;
  }
}

async function runDiagnostics() {
  console.log("Fetching secrets from Google Cloud Secret Manager...");
  const binanceApiKeyVal = getSecret('BINANCE_API_KEY');
  const binanceSecretKeyVal = getSecret('BINANCE_SECRET_KEY');
  const binanceProxyTokenVal = getSecret('BINANCE_PROXY_TOKEN');
  
  const proxyVmUrlVal = "http://35.208.122.165:3000";
  
  console.log(`Using Proxy VM URL: ${proxyVmUrlVal}`);

  const commonHeaders = {
    'x-binance-proxy-token': binanceProxyTokenVal,
    'Host': 'api.binance.com'
  };

  // Test 1: Public Time Endpoint (No credentials required)
  const timeUrl = `${proxyVmUrlVal}/api/v3/time`;
  await testEndpoint("Public Binance Time API", timeUrl, "GET", commonHeaders);

  // Test 2: User Data Stream Endpoint (Requires API Key only, no signature/timestamp)
  const streamUrl = `${proxyVmUrlVal}/api/v3/userDataStream`;
  const streamHeaders = {
    ...commonHeaders,
    'X-MBX-APIKEY': binanceApiKeyVal
  };
  await testEndpoint("UserDataStream API (API Key validation)", streamUrl, "POST", streamHeaders);

  // Test 3: Account Info Endpoint (Requires API Key, timestamp, and signature)
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', binanceSecretKeyVal).update(queryString).digest('hex');
  const accountUrl = `${proxyVmUrlVal}/api/v3/account?${queryString}&signature=${signature}`;
  const accountHeaders = {
    ...commonHeaders,
    'X-MBX-APIKEY': binanceApiKeyVal
  };
  await testEndpoint("Account Info API (Full signature + permissions validation)", accountUrl, "GET", accountHeaders);
}

runDiagnostics();
