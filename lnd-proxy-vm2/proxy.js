const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');

// Define macaroons and proxy token from environment variables
const MAIN_MACAROON = process.env.MAIN_MACAROON;
const EDGE_MACAROON = process.env.EDGE_MACAROON;
const BINANCE_PROXY_TOKEN = process.env.BINANCE_PROXY_TOKEN;

// Node configurations (IPs from your curl tests)
const NODE_CONFIGS = {
  main: {
    hostname: '100.103.9.71',
    port: 8080,
    caPath: './mainnode/tls.cert',
    isHttps: true
  },
  edge: {
    hostname: '100.68.2.83',
    port: 8080,
    caPath: './edgenode/tls.cert',
    isHttps: true
  },
  binance: {
    hostname: '100.68.2.83',
    port: 40080, // Nginx Proxy Manager HTTP port on Umbrel
    isHttps: false
  }
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Extract credentials from headers (Node.js lowercases headers)
  const macaroon = req.headers['grpc-metadata-macaroon'];
  const binanceToken = req.headers['x-binance-proxy-token'];

  // Determine target based on credentials
  let targetConfig;
  if (binanceToken === BINANCE_PROXY_TOKEN) {
    targetConfig = NODE_CONFIGS.binance;
    // Strip the proxy token before forwarding
    delete req.headers['x-binance-proxy-token'];
    // Force the Host header for Nginx Proxy Manager to route correctly
    req.headers['host'] = 'api.binance.com';
  } else if (macaroon === MAIN_MACAROON) {
    targetConfig = NODE_CONFIGS.main;
  } else if (macaroon === EDGE_MACAROON) {
    targetConfig = NODE_CONFIGS.edge;
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid credentials' }));
    return;
  }

  let agent;
  if (targetConfig.isHttps) {
    try {
      const caCert = fs.readFileSync(targetConfig.caPath);
      agent = new https.Agent({ ca: caCert });
    } catch (err) {
      console.error('Error loading CA cert:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load TLS certificate' }));
      return;
    }
  }

  // Build proxy options
  const options = {
    hostname: targetConfig.hostname,
    port: targetConfig.port,
    path: parsedUrl.path,
    method: req.method,
    headers: req.headers,  // Forward all headers
    agent,
  };

  // Forward the request
  const requestClient = targetConfig.isHttps ? https : http;
  const proxyReq = requestClient.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  req.pipe(proxyReq, { end: true });

  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(3000, () => console.log('Proxy on 3000'));