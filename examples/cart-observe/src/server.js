import http from 'node:http';
import fs from 'node:fs';
import { products } from './store.js';
import { addItem, cartView, checkout } from './cart.js';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url));
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (req.method === 'GET' && req.url === '/api/products') return send(res, 200, products);
  if (req.method === 'GET' && req.url === '/api/cart') return send(res, 200, cartView());
  if (req.method === 'POST' && req.url === '/api/cart') {
    const { productId, qty } = await readBody(req);
    const r = addItem(productId, qty);
    return send(res, r.status, r.body);
  }
  if (req.method === 'POST' && req.url === '/api/checkout') {
    const r = checkout();
    return send(res, r.status, r.body);
  }
  send(res, 404, { error: 'not-found' });
}).listen(4790);
