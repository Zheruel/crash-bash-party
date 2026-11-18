import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Party, FAST_TIMING, NORMAL_TIMING, type Conn } from '../shared/party';
import type { C2S } from '../shared/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const ASSETS = path.resolve(here, '../../assets');
const PORT = Number(process.env.PORT) || 8787;
const HOST = '0.0.0.0';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ico': 'image/x-icon',
};

function serveFile(root: string, rel: string, res: http.ServerResponse, spaFallback = false) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = spaFallback ? path.join(root, 'index.html') : '';
  }
  if (!target || !fs.existsSync(target)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/health') { res.writeHead(200).end('ok'); return; }
  if (p.startsWith('/assets/')) return serveFile(ASSETS, p.slice('/assets/'.length), res); // read-only
  if (fs.existsSync(DIST)) return serveFile(DIST, p.slice(1), res, true);
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Game server running. Use `npm run dev` (Vite on :5173) or `npm run build` first.');
});

const FAST = process.env.PARTY_FAST === '1'; // test mode: short phases and play cap
const ROUNDS = Number(process.env.PARTY_ROUNDS) || 5;
const rooms = new Map<string, Party>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

let nextConn = 1;
wss.on('connection', (ws) => {
  const conn: Conn = { id: nextConn++, send: (d) => { if (ws.readyState === 1) ws.send(d); } };
  let party: Party | null = null;
  ws.on('message', (data) => {
    const raw = data.toString();
    if (!party) {
      let m: C2S;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object' || m.t !== 'join') return;
      const code = typeof m.room === 'string' ? m.room.trim().toUpperCase() : '';
      if (code) {
        party = rooms.get(code) ?? null;
        if (!party) { ws.send(JSON.stringify({ t: 'error', msg: `Room ${code} not found` })); return; }
      } else {
        party = new Party(newCode(), { timing: FAST ? FAST_TIMING : NORMAL_TIMING, rounds: ROUNDS });
        rooms.set(party.code, party);
      }
      party.connect(conn);
    }
    party.message(conn.id, raw);
  });
  ws.on('close', () => {
    party?.disconnect(conn.id);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  const now = performance.now();
  for (const [code, r] of rooms) {
    r.update(now);
    if (r.empty) rooms.delete(code); // everyone gone (reconnect grace expired)
  }
}, 8);

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT} (ws path /ws)`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`[server] LAN: http://${i.address}:5173 (dev) / :${PORT} (built)`);
});
