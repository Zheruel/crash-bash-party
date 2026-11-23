// USA L12 action 8 from the last frame of its first inward hop.
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { createPogoResult, tickPogoResultObjects, tidx, tilePainter } from '../shared/games/tilePainter';

const seats = [8, 9].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const world = createWorld(tilePainter, seats, [], 5, 'elpogoloco');
const d = world.data, m = d.mon;
const tick = () => stepWorld(world, tilePainter, []);
tick();
assert.deepEqual([m.tm, m.pose], [48, 0x4087]);

d.cash = [];
d.arT = d.itT = 9999;
// Drop the crates placed under the countdown and keep the seeded draws of the recorded approach.
d.crates = []; d.arN = d.itN = 0; world.bodies = world.bodies.filter(b => b.kind !== 'power' && b.kind !== 'arrow');
world.rng = 5;
// The custom riders use Cortex's family, whose jet flame (FUN_800b5b1c) draws from the shared RNG on every
// update. Pogo-only families keep the stream of the recorded approach; the hits below do not depend on family.
d.fam = [1, 5, 6, 8];
Object.assign(m, {
  st: 4, cyc: 13, sx: 3, sz: 8, ax: 3, az: 6, dir: 0,
  yaw: 0, goalYaw: 0, hops: 0, bf4: 1,
});
for (let i = 0; i < 15; i++) tick();
const raw = (v: number) => Math.round((v - 3.5) * 512);
assert.deepEqual([m.st, m.tm, m.pose, m.yaw, raw(m.x), raw(m.z)], [5, 140, 0x410d, 3796, 254, 264]);

const spinTile = tidx(Math.round(m.x), Math.round(m.z));
assert.equal(d.rsv[spinTile], 5);
const fires: number[][] = [];
for (let age = 1; age <= 140; age++) {
  tick();
  assert.equal(d.rsv[spinTile], 5);
  if (m.pose === 0x4012) {
    const shot = d.proj.at(-1);
    assert.ok(shot && shot.own === 5);
    assert.deepEqual([raw(shot.x), raw(shot.z)], [254, 264]);
    assert.ok(world.ev.some(e => e.t === world.tick - 1 && e.k === 'sfx' && e.v === 0x522));
    fires.push([age, m.yaw]);
  }
  if (age === 19) {
    // Position either custom rider in the first shot's path on its first movement callback.
    for (const { slot } of seats) {
      const copy = cloneWorld(world), c = copy.data;
      c.fx[slot] = c.px[slot] = 229 / 512 + 3.5;
      c.fz[slot] = c.pz[slot] = 123 / 512 + 3.5;
      stepWorld(copy, tilePainter, []);
      assert.ok(copy.ev.some(e => e.k === 'hit' && e.s === slot));
      assert.equal(c.proj.length, 0);
    }
  }
  if (age === 20) assert.deepEqual([raw(d.proj[0].x), raw(d.proj[0].z)], [229, 123]);
  if (age === 39) {
    const after = createPogoResult(world);
    after.tick++;
    tickPogoResultObjects(after);
    assert.deepEqual([after.data.mon.st, after.data.mon.pose], [4, 0x4012]);
    assert.ok(after.ev.some(e => e.k === 'sfx' && e.v === 0x522));
    assert.equal(m.st, 5);
  }
}
assert.deepEqual(fires, [[19,118], [40,580], [61,1042], [82,1504], [103,1966], [124,2428]]);
assert.deepEqual([m.st, m.yaw, m.pose], [4, 2780, 0x400d]);
for (let i = 0; i < 3; i++) tick();
assert.deepEqual([raw(m.x), raw(m.z), m.yaw, m.pose], [254, 161, 3931, 0x4102]);
assert.deepEqual([raw(m.shadowX), raw(m.shadowZ)], [254, 264]);
for (const variant of ['pogo', 'agogo', 'elpogoloco', 'padlock']) {
  const board = createWorld(tilePainter, seats, [], 5, variant);
  board.data.item[0] = 1;
  stepWorld(board, tilePainter, [{ x: 1, y: 0, a: true, b: false }]);
  const missile = board.bodies.find(b => b.kind === 'missile');
  assert.equal(missile?.y, 400 * 1.8 / 512);
}

function decision(x: number, z: number, dir: number, state: number) {
  const board = createWorld(tilePainter, seats, [], 0, 'elpogoloco');
  const d = board.data;
  d.cash = [];
  d.arT = d.itT = 9999;
  d.crates = []; d.arN = d.itN = 0; board.bodies = board.bodies.filter(b => b.kind !== 'power' && b.kind !== 'arrow');
  d.fam = [1, 5, 6, 8]; // no jet flame draws after the monster's own
  Object.assign(d.mon, { x, z, sx: x, sz: z, ax: x, az: z, dir, st: state, cyc: 13, tm: 99, hops: 100 });
  return board;
}

// The same corner reached exactly and overshot by one tile (FUN_800bfa14).
for (const [z, xNext, zNext] of [[6, 8, 8], [7, 7, 8]]) {
  const w = decision(8, z, 2, 2);
  stepWorld(w, tilePainter, []);
  const m = w.data.mon;
  assert.deepEqual([m.ax, m.az, m.dir], [xNext, zNext, 1]);
}

const crossing = decision(3, 3, 0, 3);
const c = crossing.data;
c.fx[0] = c.px[0] = 2; c.fz[0] = c.pz[0] = 1;
c.rsv[tidx(3, 1)] = 2;
c.crates.push({ id: 100, k: 'item', t: 1, rx: 4, rz: 1, age: 20 });
// No forward landing fits between the rider, reserved tile and item crate.
// Seed 1 draws all three before choosing +Z on the sixth attempt.
crossing.rng = 1;
stepWorld(crossing, tilePainter, []);
assert.deepEqual([c.mon.ax, c.mon.az, c.mon.dir, crossing.rng], [4, 5, 2, 1767624617]);
assert.equal(c.rsv[tidx(3, 3)], 5);
const resumed = cloneWorld(crossing);
for (const w of [crossing, resumed]) {
  const d = w.data;
  d.fx[0] = d.px[0] = 3; d.fz[0] = d.pz[0] = 5;
  stepWorld(w, tilePainter, [{ x: 1, y: 0, a: false, b: false }]);
  assert.equal(d.cnt[0], -1);
  assert.equal(d.rsv[tidx(3, 3)], 0);
  assert.equal(d.rsv[tidx(4, 5)], 5);
}
assert.deepEqual(resumed, crossing);

const exit = decision(7, 3, 3, 3);
stepWorld(exit, tilePainter, []);
assert.deepEqual([exit.data.mon.st, exit.data.mon.ax, exit.data.mon.az, exit.data.mon.dir], [2, 8, 3, 2]);
assert.ok(!exit.data.rsv.includes(5));

// A fully surrounded monster waits one hop, leaving the room and its clock live.
const blocked = decision(3, 3, 0, 3);
blocked.data.rsv.fill(2);
stepWorld(blocked, tilePainter, []);
assert.deepEqual([blocked.data.mon.st, blocked.data.mon.ax, blocked.data.mon.az], [3, 3, 3]);
console.log('El Pogo Loco spin, shots, rim turns, blocked hops, reservations and resume passed.');
