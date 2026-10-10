import http from 'node:http';
import fs from 'node:fs';
import { verifyCredentials } from './services/auth.js';
// tiny express-like server without deps
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url));
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/login') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (req.method === 'POST' && req.url === '/api/login') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const { email, password } = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (!email || !password) { res.statusCode = 400; return res.end('{"error":"missing"}'); }
      const r = verifyCredentials(email, password);
      if (!r.ok) { res.statusCode = 401; return res.end(JSON.stringify({ error: r.reason })); }
      res.end(JSON.stringify({ token: r.token, user: r.user }));
    }); return;
  }
  res.statusCode = 404; res.end();
}).listen(4789);
