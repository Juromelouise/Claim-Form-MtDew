// Claim form server. Node 22+, Postgres (Supabase). Signatures are stored as PNG bytes in the claims table.
// Run: npm start (reads .env if present)   ->  http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS;
const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_CONNECTION_STRING;
if (!ADMIN_PASS || !DB_URL) {
  console.error('Set ADMIN_PASS and DATABASE_URL (or SUPABASE_CONNECTION_STRING) environment variables.');
  process.exit(1);
}

const db = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
db.on('error', (e) => console.error('DB idle client error:', e.message)); // pooler drops idle conns; don't crash
const SCHEMA = `CREATE TABLE IF NOT EXISTS claims (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  printed_name TEXT NOT NULL,
  sign_date TEXT NOT NULL,
  is_minor INTEGER NOT NULL DEFAULT 0,
  guardian_name TEXT,
  guardian_date TEXT,
  participant_sig BYTEA NOT NULL,
  guardian_sig BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
// Everything except the signature bytes
const COLS = 'id, name, address, printed_name, sign_date, is_minor, guardian_name, guardian_date, created_at';

const PNG_PREFIX = 'data:image/png;base64,';
const png = (dataUrl) => Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
const isPng = (s) => typeof s === 'string' && s.startsWith(PNG_PREFIX) && s.length < 2_000_000;
const str = (s, max = 500) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function isAdmin(req) {
  const [, b64] = (req.headers.authorization || '').split(' ');
  return b64 && Buffer.from(b64, 'base64').toString().split(':')[1] === ADMIN_PASS;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy(); // ~5MB cap
    });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Public: the form
  if (req.method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html');

  // Public: keep-alive ping (cron-job.org) — touches the DB so Supabase doesn't pause
  if (p === '/health') {
    await db.query('SELECT 1');
    return send(res, 200, 'ok', 'text/plain');
  }

  // Public: submit
  if (req.method === 'POST' && p === '/api/claims') {
    let b;
    try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request' }); }
    const c = {
      name: str(b.name), address: str(b.address), printed_name: str(b.printed_name),
      sign_date: str(b.sign_date, 20), is_minor: b.is_minor ? 1 : 0,
      guardian_name: str(b.guardian_name), guardian_date: str(b.guardian_date, 20),
    };
    if (!c.name || !c.address || !c.printed_name || !c.sign_date || !isPng(b.signature))
      return send(res, 400, { error: 'Please complete all required fields and sign.' });
    if (c.is_minor && (!c.guardian_name || !c.guardian_date || !isPng(b.guardian_signature)))
      return send(res, 400, { error: 'Parent/guardian section is required for participants under 18.' });

    const { rows: [{ id }] } = await db.query(
      `INSERT INTO claims (name,address,printed_name,sign_date,is_minor,guardian_name,guardian_date,participant_sig,guardian_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.name, c.address, c.printed_name, c.sign_date, c.is_minor, c.guardian_name || null, c.guardian_date || null,
        png(b.signature), c.is_minor ? png(b.guardian_signature) : null]
    );
    return send(res, 201, { id });
  }

  // Admin only below
  if (!isAdmin(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Claims admin"' });
    return res.end('Login required');
  }

  if (p === '/admin') {
    const { rows } = await db.query(`SELECT ${COLS} FROM claims ORDER BY id DESC`);
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Claims</title>
      <style>body{font-family:sans-serif;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}</style>
      <form action="/admin/qr" target="_blank">Form link: <input name="url" id="qrUrl" size="40"> <button>Show QR</button></form>
      <script>qrUrl.value = location.origin + '/'; // if this says localhost, type the LAN/public address users can reach</script>
      <h1>Claims (${rows.length})</h1><table><tr><th>#</th><th>Name</th><th>Address</th><th>Minor</th><th>Submitted</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.address)}</td>
        <td>${r.is_minor ? 'Yes' : 'No'}</td><td>${esc(r.created_at.toLocaleString())}</td><td><a href="/?view=${r.id}">View / Print</a></td></tr>`).join('')}
      </table>`, 'text/html');
  }

  if (p === '/admin/qr') {
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Scan to claim</title>
      <style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;background:#fff}
      svg{width:min(85vw,80vh);height:auto}</style>
      <h1>Scan to fill out the claim form</h1><div id="qr"></div><p id="txt"></p>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
      <script>
        const url = new URLSearchParams(location.search).get('url') || location.origin + '/';
        const q = qrcode(0, 'M'); q.addData(url); q.make();
        qr.innerHTML = q.createSvgTag({ cellSize: 10, margin: 2 });
        txt.textContent = url;
      </script>`, 'text/html');
  }

  const m = p.match(/^\/api\/claims\/(\d+)$/);
  if (m) {
    const { rows: [row] } = await db.query(`SELECT ${COLS} FROM claims WHERE id = $1`, [Number(m[1])]);
    return row ? send(res, 200, row) : send(res, 404, { error: 'Not found' });
  }

  // Same URLs as before (/signatures/<id>-participant.png), now served from the DB
  const s = p.match(/^\/signatures\/(\d+)-(participant|guardian)\.png$/);
  if (s) {
    const { rows: [row] } = await db.query(`SELECT ${s[2]}_sig AS img FROM claims WHERE id = $1`, [Number(s[1])]);
    if (row?.img) return send(res, 200, row.img, 'image/png');
  }

  send(res, 404, 'Not found', 'text/plain');
}

db.query(SCHEMA).then(() =>
  http.createServer((req, res) => handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error, please try again.' });
  })).listen(PORT, () => console.log(`Claim form: http://localhost:${PORT}  |  Admin: http://localhost:${PORT}/admin`))
);
