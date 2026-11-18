// Headless smoke test. Start the server first with PARTY_FAST=1 (short phases):
//   PARTY_FAST=1 npm run dev     (or PARTY_FAST=1 npm start)
// then: npm run test:e2e   [ws://host:port/ws]
import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://127.0.0.1:5173/ws';
const ROUNDS = 2;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const checks = [];
const ok = (name, cond) => { checks.push([name, !!cond]); if (!cond) fail(name); };

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, id: 0, code: '', snaps: 0, lastAck: 0, phases: [], rounds: [], results: [], room: null, lastWorld: null, firstWorld: null };
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'joined') { c.id = m.id; c.code = m.code; }
    else if (m.t === 'room') c.room = m.room;
    else if (m.t === 'phase') c.phases.push(m.phase);
    else if (m.t === 'round') c.rounds.push(m);
    else if (m.t === 'results') c.results.push(m);
    else if (m.t === 'snap') { c.snaps++; c.lastAck = m.ack; c.lastWorld = m.w; if (c.phases.at(-1) === 'play' && !c.firstWorld) c.firstWorld = m.w; }
    else if (m.t === 'error') fail('server error: ' + m.msg);
  });
  return c;
}
const until = (cond, ms, what) => new Promise((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res(); }
    else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout waiting for ' + what)); }
  }, 20);
});

const a = client('Alice');
await a.open;
a.send({ t: 'join', name: 'Alice' });
await until(() => a.code, 2000, 'Alice joined');
ok('room code is 4 letters', /^[A-Z]{4}$/.test(a.code));

const b = client('Bob');
await b.open;
b.send({ t: 'join', name: 'Bob', room: a.code });
await until(() => b.room?.seats.filter((s) => s.clientId != null).length === 2, 2000, 'Bob seated');
ok('2 humans + 2 bots', a.room.seats.filter((s) => s.clientId == null).length === 2);

a.send({ t: 'config', rounds: ROUNDS });
await until(() => a.room.totalRounds === ROUNDS, 1000, 'config applied');

// a spectator joining mid-flow
let spec = null;

// drive inputs while playing
let seq = 0;
const driver = setInterval(() => {
  if (a.phases.at(-1) === 'play') { seq++; a.send({ t: 'input', seq, x: 1, y: 0, a: seq % 40 === 0, b: false }); b.send({ t: 'input', seq, x: 0, y: -1, a: false, b: seq % 25 === 0 }); }
}, 33);

a.send({ t: 'ready', ready: true });
b.send({ t: 'ready', ready: true });

await until(() => a.rounds.length >= 1, 3000, 'round 1 start');
ok('round has game + modifier', a.rounds[0].gameId && a.rounds[0].modifier.id);
await until(() => a.phases.includes('play'), 3000, 'play phase');
spec = client('Spec');
await spec.open;
spec.send({ t: 'join', name: 'Spec', room: a.code });
await until(() => a.results.length >= 1, 15000, 'round 1 results');
ok('snapshots arrived', a.snaps > 20 && b.snaps > 20);
ok('input acks advance', a.lastAck > 0);
ok('players moved from spawn', a.firstWorld && a.lastWorld && JSON.stringify(a.firstWorld.bodies.filter((x) => x.kind === 'player')) !== JSON.stringify(a.lastWorld.bodies.filter((x) => x.kind === 'player')));
ok('results have 4 placements', a.results[0].placements.length === 4 && new Set(a.results[0].placements).size === 4);
ok('points awarded', a.results[0].gained.reduce((x, y) => x + y, 0) === 10);
ok('spectator got snapshots + no seat', spec.snaps > 5 && !spec.room.seats.some((s) => s.clientId === spec.id));

await until(() => a.results.some((r) => r.final), 20000, 'final results');
const fin = a.results.at(-1);
ok(`played ${ROUNDS} rounds`, a.rounds.length === ROUNDS && fin.round === ROUNDS);
ok('winner(s) declared', fin.winners.length >= 1);
ok('phases in order', ['intro', 'countdown', 'play', 'results', 'intro', 'countdown', 'play', 'final'].every((p, i) => a.phases.filter((x, j) => j === 0 || x !== a.phases[j - 1])[i] === p));
await until(() => a.room.phase === 'lobby' && a.phases.at(-1) === 'lobby', 3000, 'back to lobby');
ok('ready reset in lobby', a.room.seats.filter((s) => s.clientId != null).every((s) => !s.ready));

clearInterval(driver);
console.log(`PASS (${checks.length} checks). games: ${a.rounds.map((r) => r.gameId + '/' + r.modifier.id).join(', ')}; winners: ${fin.winners}; scores: ${fin.scores}`);
for (const c of [a, b, spec]) c.ws.close();
setTimeout(() => process.exit(0), 100);
