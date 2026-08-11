const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const Stripe = require('stripe');
const SQL = require('sql.js');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, { apiVersion: '2023-08-16' }) : null;

const rootDir = __dirname;
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'plays.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

let db;

function saveDb() {
  const binary = db.export();
  fs.writeFileSync(dbPath, Buffer.from(binary));
}

function initDb() {
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS play_counts (
      song TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const existing = db.prepare('SELECT count FROM play_counts WHERE song = ?').get('risk-it-all');
  if (!existing) {
    db.run('INSERT INTO play_counts (song, count) VALUES (?, 0)', ['risk-it-all']);
  }

  saveDb();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getCount() {
  const row = db.prepare('SELECT count FROM play_counts WHERE song = ?').get('risk-it-all');
  return row ? row.count : 0;
}

function incrementCount() {
  db.run('UPDATE play_counts SET count = count + 1 WHERE song = ?', ['risk-it-all']);
  saveDb();
  return getCount();
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.mp3': return 'audio/mpeg';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(data);
  });
}

initDb();

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ publishableKey: stripePublishableKey, stripeEnabled: Boolean(stripePublishableKey) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/create-checkout-session') {
    parseJsonBody(req).then(async (body) => {
      try {
        if (!stripe) {
          throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.');
        }

        const quantity = Math.max(1, Math.min(10, Number(body.quantity) || 1));
        let lineItem;
        let metadata = {
          buyer_name: body.buyerName || '',
          buyer_email: body.buyerEmail || '',
          product_type: body.productType || '',
        };

        if (body.productType === 'vinyl') {
          lineItem = {
            price_data: {
              currency: 'usd',
              unit_amount: 3500,
              product_data: {
                name: 'ELEMENTS Limited Edition Vinyl',
                description: '180g limited edition vinyl pre-order',
              },
            },
            quantity,
          };
        } else if (body.productType === 'tshirt') {
          const style = body.tshirtStyle || 'True North';
          const size = body.tshirtSize || 'L';
          metadata.tshirt_style = style;
          metadata.tshirt_size = size;
          lineItem = {
            price_data: {
              currency: 'usd',
              unit_amount: 4500,
              product_data: {
                name: `ELEMENTS T-Shirt (${style}, Size ${size})`,
                description: `Heavyweight ELEMENTS T-Shirt in ${style} style`,
              },
            },
            quantity,
          };
        } else {
          throw new Error('Invalid product type.');
        }

              const successUrl = `${process.env.DOMAIN || `http://localhost:${port}`}/?checkoutSuccess=1`;
        const cancelUrl = `${process.env.DOMAIN || `http://localhost:${port}`}/?checkoutCanceled=1`;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [lineItem],
          mode: 'payment',
          success_url: successUrl,
          cancel_url: cancelUrl,
          customer_email: body.buyerEmail || undefined,
          metadata,
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ url: session.url }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || 'Checkout session error' }));
      }
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message || 'Invalid JSON body' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/play-count') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: getCount() }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/play-count/increment') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: incrementCount() }));
    return;
  }

  const requestedPath = url.pathname === '/' ? path.join(rootDir, 'index.html') : path.join(rootDir, decodeURIComponent(url.pathname.replace(/^\//, '')));
  const safePath = path.normalize(requestedPath);
  if (!safePath.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(safePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(safePath);
  if (stat.isDirectory()) {
    serveFile(res, path.join(safePath, 'index.html'));
  } else {
    serveFile(res, safePath);
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
