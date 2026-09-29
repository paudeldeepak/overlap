import http from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx, read, DEFAULT_DB } from './db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || DEFAULT_DB;
// Set TRUST_PROXY=1 only when a reverse proxy (Caddy, nginx) sits in front and sets
// X-Forwarded-For / X-Forwarded-Proto. Without a proxy those headers are spoofable.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const COOKIE = 'overlap_sid';
const MAX_BODY = 16 * 1024;
const MAX_DAYS = 400;
const ID_RE = /^[a-z0-9]{4,32}$/;

const db = openDb(DB_PATH);
const q = {
  personByToken: db.prepare('SELECT id FROM people WHERE token_hash = ?'),
  addPerson: db.prepare('INSERT INTO people (id, token_hash, created) VALUES (?, ?, ?)'),
  addEvent: db.prepare('INSERT INTO events (id, title, created, owner_id) VALUES (?, ?, ?, ?)'),
  getEvent: db.prepare('SELECT title, created, owner_id AS "by", owner_name AS byName FROM events WHERE id = ?'),
  getResponses: db.prepare('SELECT person_id AS id, name, dates, updated FROM responses WHERE event_id = ? ORDER BY updated'),
  saveResponse: db.prepare(`
    INSERT INTO responses (event_id, person_id, name, dates, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (event_id, person_id) DO UPDATE
      SET name = excluded.name, dates = excluded.dates, updated = excluded.updated`),
  // Ownership is part of each statement, so a non-owner's request changes zero rows.
  setOwnerName: db.prepare('UPDATE events SET owner_name = ? WHERE id = ? AND owner_id = ?'),
  rename: db.prepare('UPDATE events SET title = ? WHERE id = ? AND owner_id = ?'),
  deleteEvent: db.prepare('DELETE FROM events WHERE id = ? AND owner_id = ?'),
};

/* ── the page ─────────────────────────────────────────────── */
const PAGE = readFileSync(path.join(ROOT, 'public', 'index.html'));
// The page's one inline script is allowed by its hash; nothing else can run.
const inline = PAGE.toString().match(/<script type="module">([\s\S]*?)<\/script>/);
const SCRIPT_HASH = inline ? createHash('sha256').update(inline[1]).digest('base64') : '';
const CSP = [
  "default-src 'none'",
  `script-src 'sha256-${SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/* ── helpers ──────────────────────────────────────────────── */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newId = (n) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    // The proxy appends the address it saw, so the last entry is the one to trust.
    return req.headers['x-forwarded-for'].split(',').pop().trim();
  }
  return req.socket.remoteAddress || '';
}
const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

function currentPerson(req) {
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const row = q.personByToken.get(hashToken(token));
  return row ? row.id : null;
}
function requirePerson(req) {
  const id = currentPerson(req);
  if (!id) throw new HttpError(401, 'Your session has expired. Reload the page.');
  return id;
}

/* Writes must come from this site. The session cookie is SameSite=Strict, and this
   also rejects any cross-site request a browser marks as such. */
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
  const origin = req.headers.origin;
  if (origin) {
    const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    if (originHost !== host) throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('That request was not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('That request was not valid JSON.');
  return body;
}

function text(v, max, field) {
  if (typeof v !== 'string') bad(`${field} is missing.`);
  const t = v.trim();
  if (!t) bad(`${field} can't be empty.`);
  if (t.length > max) bad(`${field} can be at most ${max} characters.`);
  return t;
}
function dateList(v) {
  if (!Array.isArray(v)) bad('dates must be a list.');
  if (v.length > MAX_DAYS) bad(`You can save up to ${MAX_DAYS} days.`);
  const out = new Set();
  for (const d of v) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) bad('Dates must look like 2026-10-03.');
    const [y, m, day] = d.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) bad(`${d} is not a real date.`);
    out.add(d);
  }
  return [...out].sort();
}

/* Fixed-window counters, enough to stop a script from filling the database. */
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) hits.set(key, (h = { n: 0, reset: now + windowMs }));
  if (++h.n > max) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
}, 60_000).unref();
const TEN_MIN = 10 * 60_000;

/* ── live updates ─────────────────────────────────────────── */
// Everyone looking at an event holds a server-sent-events connection. After each
// write, the whole event is sent to them again.
const watchers = new Map();
const openStreams = new Map();
const MAX_STREAMS_PER_IP = 30;

function snapshot(id) {
  return read(db, () => {
    const event = q.getEvent.get(id) || null;
    const responses = event ? q.getResponses.all(id).map((r) => ({ ...r, dates: JSON.parse(r.dates) })) : [];
    return { event, responses };
  });
}
function broadcast(id) {
  const set = watchers.get(id);
  if (!set) return;
  const msg = `data: ${JSON.stringify(snapshot(id))}\n\n`;
  for (const res of set) res.write(msg);
}
function stream(req, res, id) {
  const ip = clientIp(req);
  const open = openStreams.get(ip) || 0;
  if (open >= MAX_STREAMS_PER_IP) throw new HttpError(429, 'Too many open pages.');
  openStreams.set(ip, open + 1);
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let set = watchers.get(id);
  if (!set) watchers.set(id, (set = new Set()));
  set.add(res);
  res.write(`data: ${JSON.stringify(snapshot(id))}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) watchers.delete(id);
    const n = (openStreams.get(ip) || 1) - 1;
    n ? openStreams.set(ip, n) : openStreams.delete(ip);
  });
}

/* ── routes ───────────────────────────────────────────────── */
async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    if (pathname !== '/' && pathname !== '/index.html') throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
    });
    return res.end(method === 'HEAD' ? undefined : PAGE);
  }

  if (method !== 'GET') checkOrigin(req);

  // A browser's identity: a random token in an HttpOnly cookie. Only its hash is stored.
  if (pathname === '/api/session' && method === 'POST') {
    const existing = currentPerson(req);
    if (existing) return send(res, 200, { id: existing });
    limit('session:' + clientIp(req), 20, TEN_MIN);
    const token = randomBytes(32).toString('base64url');
    const id = newId(20);
    tx(db, () => q.addPerson.run(id, hashToken(token), Date.now()));
    const cookie = `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=34560000${isHttps(req) ? '; Secure' : ''}`;
    return send(res, 200, { id }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/events' && method === 'POST') {
    const me = requirePerson(req);
    limit('create:' + me, 30, TEN_MIN);
    limit('create-ip:' + clientIp(req), 60, TEN_MIN);
    const { title } = await readJson(req);
    const clean = text(title, 80, 'The event name');
    const id = newId(10);
    tx(db, () => q.addEvent.run(id, clean, Date.now(), me));
    return send(res, 201, { id });
  }

  const m = pathname.match(/^\/api\/events\/([^/]+)(\/stream|\/responses\/me)?$/);
  if (!m) throw new HttpError(404, 'Not found.');
  const [, id, sub] = m;
  if (!ID_RE.test(id)) throw new HttpError(404, 'Not found.');
  const me = requirePerson(req);

  if (sub === '/stream' && method === 'GET') return stream(req, res, id);

  if (sub === '/responses/me' && method === 'PUT') {
    limit('save:' + me, 120, TEN_MIN);
    const body = await readJson(req);
    const name = text(body.name, 40, 'Your name');
    const dates = dateList(body.dates);
    tx(db, () => {
      const event = q.getEvent.get(id);
      if (!event) throw new HttpError(404, 'That event no longer exists.');
      q.saveResponse.run(id, me, name, JSON.stringify(dates), Date.now());
      // The creator's name goes on the event so other people's lists can show it.
      if (event.by === me) q.setOwnerName.run(name, id, me);
    });
    broadcast(id);
    return send(res, 200, { ok: true });
  }

  if (!sub && method === 'PATCH') {
    const { title } = await readJson(req);
    const clean = text(title, 80, 'The event name');
    const changed = tx(db, () => q.rename.run(clean, id, me).changes);
    if (!changed) throw new HttpError(403, 'Only the person who made this event can rename it.');
    broadcast(id);
    return send(res, 200, { ok: true });
  }

  if (!sub && method === 'DELETE') {
    const changed = tx(db, () => q.deleteEvent.run(id, me).changes);
    if (!changed) throw new HttpError(403, 'Only the person who made this event can delete it.');
    broadcast(id);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(405, 'Method not allowed.');
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  console.log(`Overlap is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

function shutdown() {
  server.close();
  for (const set of watchers.values()) for (const res of set) res.end();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
