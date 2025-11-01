const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');

const lndUrl = 'https://100.103.9.71:8080';  // e.g., la IP Tailscale del nodo btc
const agent = new https.Agent({ ca: fs.readFileSync('./tls.cert') });

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const options = {
    hostname: '100.103.9.71',
    port: 8080,
    path: parsedUrl.path,
    method: req.method,
    headers: req.headers,
    agent,
  };
  const proxyReq = https.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
  proxyReq.on('error', err => res.status(500).json({ error: err.message }));
});

server.listen(3000, () => console.log('Proxy on 3000'));