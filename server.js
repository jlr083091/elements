const http = require('http');
const fs = require('fs');
const path = require('path');
const SQL = require('sql.js');

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
