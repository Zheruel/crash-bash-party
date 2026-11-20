// USA L11 electro beam traces. Exercise the same 30 Hz step used by the host and prediction.
import assert from 'node:assert/strict';
import { BEAM_FRAMES, tilePainter, TP_TILE } from '../shared/games/tilePainter';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';

const seats = [8, 9, 0, 1].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const right = { x: 1, y: 0, a: false, b: false };
const fire = { x: 0, y: -1, a: false, b: true };

function fixture(x = 3, victimX = 5) {
  const w = createWorld(tilePainter, seats, [], 1, 'agogo'), d = w.data;
  d.cash = []; d.arT = d.itT = 9999;
  for (const [s, [cx, cz]] of [[x, 3], [victimX, 3], [0, 7], [7, 0]].entries()) {
    d.fx[s] = d.px[s] = d.tx[s] = cx;
    d.fz[s] = d.pz[s] = d.tz[s] = cz;
  }
  d.item[0] = 3; d.hd[0] = 0;
  return w;
}

for (const start of [0, 3, 6, 7]) {
  const w = fixture(start, start === 6 ? 0 : 7), d = w.data;
  stepWorld(w, tilePainter, [{ ...right, b: true }]);
  const b = w.bodies.find(b => b.kind === 'beam');
  if (start === 7) {
    assert.equal(b, undefined);
    assert.equal(d.item[0], 3);
    continue;
  }
  assert.ok(b);
  assert.equal(b.dash, 7 - start);
  assert.equal(Math.round(b.x * 512 / TP_TILE), (start - 3) * 512);
  assert.equal(Math.round(b.y * 512 / TP_TILE), 80);
  assert.equal(d.pendingStun ?? 0, 0);
  stepWorld(w, tilePainter, []);
  assert.equal(d.pendingStun ?? 0, start === 6 ? 0 : 2);
  const rejoin = cloneWorld(w);
  assert.ok(w.ev.some(e => e.t === w.tick - 1 && e.k === 'pogoBeamSpark'));
  const sparks = [1];
  for (let age = 2; age <= BEAM_FRAMES; age++) {
    for (const copy of [w, rejoin]) stepWorld(copy, tilePainter, []);
    if (w.ev.some(e => e.t === w.tick - 1 && e.k === 'pogoBeamSpark')) sparks.push(age);
  }
  assert.deepEqual(sparks, [1, 5, 9, 13, 17]); // Big Stein uses Cortex's character script.
  assert.deepEqual(rejoin, w);
  assert.equal(w.bodies.some(b => b.kind === 'beam'), false);
  assert.equal(d.px[0], start);
}

// The object queue captures slot addresses before players run. Collecting an item releases
// its slot after the pickup effect is allocated. The next beam can hit in that same frame.
for (const [pickupSeat, order, immediate] of [
  [0, [0, 1, 2, 3], true],
  [2, [2, 0, 1, 3], true],
  [2, [0, 2, 1, 3], false],
] as const) {
  const w = fixture(), d = w.data;
  d.updateOrders = [order];
  d.crates.push({ id: 91, rx: d.px[pickupSeat], rz: d.pz[pickupSeat],
    k: 'item', t: pickupSeat === 0 ? 3 : 5, age: 21 });
  stepWorld(w, tilePainter, [{ ...right, b: true }]);
  assert.equal(d.beams[0].firstTick, immediate ? 1 : 2);
  assert.equal(d.pendingStun ?? 0, immediate ? 2 : 0);
  assert.equal(d.stun[1], 0);
  assert.equal(d.freeQueued, undefined);
}

// Restore an older host snapshot that kept the beam after stunning its owner.
const legacy = fixture();
stepWorld(legacy, tilePainter, [{ ...right, b: true }]);
delete legacy.data.beams[0].firstTick;
legacy.data.taz[0] = 0; legacy.data.stun[0] = 1;
stepWorld(legacy, tilePainter, []);
assert.equal(legacy.data.beams.length, 0);
assert.equal(legacy.bodies.some(b => b.kind === 'beam'), false);

// A blocked direction retains the rider's facing and cannot start a stride.
const blocked = fixture(3, 4);
blocked.data.hd[0] = 2;
stepWorld(blocked, tilePainter, [{ ...right, b: true }]);
assert.equal(blocked.data.px[0], 3);
assert.equal(blocked.data.beams[0].dir, 2);

// Fire during each half of a rightward hop while pressing Up. The muzzle stays put.
for (const steps of [8, 14]) {
  const w = fixture(), d = w.data;
  for (let i = 0; i < steps; i++) stepWorld(w, tilePainter, [right]);
  const source = d.px[0], dest = Math.round(source);
  assert.equal(dest, steps === 8 ? 3 : 4);
  stepWorld(w, tilePainter, [fire]);
  assert.equal(d.px[0], source);
  assert.equal(d.hd[0], 0);
  assert.equal(d.cnt[0], -1);
  assert.ok(!d.rsv.includes(1));
  const b = w.bodies.find(b => b.kind === 'beam')!, muzzle = b.x;
  for (let i = 0; i < BEAM_FRAMES; i++) {
    stepWorld(w, tilePainter, []);
    assert.equal(b.x, muzzle);
  }
  assert.equal(d.px[0], dest);
}
console.log('Pogo electro beam range, interruption, hits, player order and snapshot replay passed');
