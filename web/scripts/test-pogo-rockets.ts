// USA L10–L13 firing, contact and stun dispatch through the shared 30 Hz sim.
import assert from 'node:assert/strict';
import { createPogoResult, finishPogoHop, tickPogoResultObjects, tidx, tilePainter } from '../shared/games/tilePainter';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import type { World } from '../shared/types';

const seats = [8, 9, 2, 1].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
function place(w: World, slot: number, x: number, z: number) {
  const d = w.data;
  d.fx[slot] = d.px[slot] = d.tx[slot] = x;
  d.fz[slot] = d.pz[slot] = d.tz[slot] = z;
}

function fixture(variant: string, item: number) {
  const w = createWorld(tilePainter, seats, [], 1, variant);
  const d = w.data;
  d.cash = []; d.arT = d.itT = 9999;
  [[3, 3], [5, 3], [3, 5], [0, 0]].forEach(([x, z], slot) => place(w, slot, x, z));
  d.item[0] = item;
  return w;
}

for (const variant of ['pogo', 'agogo', 'elpogoloco', 'padlock']) {
  for (const item of [1, 2, 4]) {
    const w = fixture(variant, item), d = w.data;
    const axis = item === 1 ? Math.SQRT1_2 : item === 4 ? -Math.SQRT1_2 : 0;
    const victims = item === 1 ? [1] : item === 4 ? [2] : [1, 2];
    const target = tidx(6, 6);
    if (item === 4) {
      d.tiles[target] = 2; d.st[target] = 10; d.tm[target] = 200;
      d.item[2] = 6; d.itemT[2] = 200;
    }
    stepWorld(w, tilePainter, [{ x: axis, y: axis, a: true, b: false }]);
    assert.deepEqual(d.proj.map((p: { dir: number }) => p.dir), item === 1 ? [0] : item === 4 ? [2] : [1, 0, 3, 2]);
    for (const p of d.proj) assert.deepEqual([p.x, p.z], [3, 3]);
    assert.equal(d.item[0], 0);
    while (w.tick < 8) stepWorld(w, tilePainter, []);
    for (const slot of victims) {
      assert.ok(d.pendingStun & (1 << slot));
      assert.equal(d.stun[slot], 0);
    }
    if (item === 4) {
      assert.deepEqual([d.tiles[target], d.st[target], d.tm[target]], [0, 0, 10]);
      assert.ok(!w.ev.some(e => e.k === 'sfx' && e.v === 0x54d));
    }
    const snapshot = cloneWorld(w);
    for (let t = 9; t <= 60; t++) {
      stepWorld(w, tilePainter, []);
      stepWorld(snapshot, tilePainter, []);
      for (const slot of victims) {
        assert.equal(d.stun[slot], t === 60 ? 0 : t - 8);
        assert.equal(d.rsv[tidx(d.px[slot], d.pz[slot])], t === 60 ? 0 : slot + 1);
      }
    }
    assert.deepEqual(snapshot, w);
  }
}

// Down + Right shoots right. It hops down when open and right when that hop is blocked.
for (const blocked of [false, true]) {
  const w = fixture('pogo', 1), d = w.data;
  if (blocked) place(w, 3, 3, 2);
  stepWorld(w, tilePainter, [{ x: Math.SQRT1_2, y: Math.SQRT1_2, a: true, b: false }]);
  assert.deepEqual([d.tx[0], d.tz[0]], blocked ? [4, 3] : [3, 2]);
  assert.equal(d.proj[0].dir, 0);
}

// A shot in the terminal snapshot can interrupt an unfinished hop on the next player callback.
const last = fixture('pogo', 1);
stepWorld(last, tilePainter, [{ x: 1, y: 0, a: true, b: false }]);
const result = createPogoResult(last), d = result.data;
place(result, 1, 3.53, 3);
d.cnt[1] = 4;
result.tick++;
tickPogoResultObjects(result);
assert.ok(d.pendingStun & 2);
const rider = result.bodies.find(b => b.kind === 'player' && b.slot === 1)!;
assert.ok(finishPogoHop(result, rider));
assert.deepEqual([d.px[1], d.pz[1], d.stun[1], d.cnt[1]], [4, 3, 1, -1]);
assert.equal(finishPogoHop(result, rider), false);
console.log('Pogo rocket launches, diagonal aim and movement, steal, stun and result handoff passed.');
