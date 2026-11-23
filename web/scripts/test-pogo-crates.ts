// Pogo crate objects, the countdown pre-roll, CPU targets and the jet flame. Run with npx tsx scripts/test-pogo-crates.ts from web/.
import assert from 'node:assert/strict';
import { pogoItemHeight, pogoItemShadow, POGO_ITEM_LAND, tidx, tilePainter } from '../shared/games/tilePainter';
import { rand } from '../shared/physics';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import type { World } from '../shared/types';

const seats = [0, 1, 2, 3].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const corners = [[0, 0], [0, 7], [7, 7], [7, 0]];

function board(variant: string, seed = 7, chars = seats): World {
  const w = createWorld(tilePainter, chars, [], seed, variant), d = w.data;
  d.cash = []; d.crates = []; d.arN = d.itN = 0; d.arT = d.itT = 9999;
  w.bodies = w.bodies.filter(b => b.kind !== 'power' && b.kind !== 'arrow' && b.kind !== 'crate');
  return w;
}
const sounds = (w: World, id: number) => w.ev.filter(e => e.t === w.tick - 1 && e.k === 'sfx' && e.v === id).length;
const place = (w: World, slot: number, x: number, z: number) => {
  const d = w.data;
  d.fx[slot] = d.px[slot] = d.tx[slot] = x;
  d.fz[slot] = d.pz[slot] = d.tz[slot] = z;
};

// FUN_800b9c10 / 800ba3e0: free tile, then the type, then the start direction. FUN_800baba8 plays 0x3fa on its first update.
{
  const w = board('agogo'), d = w.data;
  d.arT = 5;
  const expect = cloneWorld(w);
  const draw = (n: number) => Math.floor(rand(expect) * n);
  const x = draw(8), z = draw(8), type = draw(3) !== 0 ? 7 : 8, dir = draw(4), next = 40 + draw(70);
  stepWorld(w, tilePainter, []);
  const arrow = d.crates[0];
  assert.deepEqual([arrow.rx, arrow.rz, arrow.t, arrow.dir, arrow.yaw, d.arT], [x, z, type, dir, dir << 10, next]);
  assert.equal(sounds(w, 0x3fa), 0);
  stepWorld(w, tilePainter, []);
  assert.equal(sounds(w, 0x3fa), 1);
  // The direction steps on the first ready update (16 + 1), then every 35 updates.
  const turns: number[] = [];
  for (let k = 0; k < 130; k++) {
    const before = arrow.dir;
    stepWorld(w, tilePainter, []);
    if (arrow.dir !== before) turns.push(arrow.age - 1);
  }
  assert.deepEqual(turns, [17, 52, 87, 122]);
  assert.equal(w.bodies.find(b => b.id === arrow.id)?.vz, arrow.yaw);
}

// El Pogo Loco runs the arrow timer and draws a tile without spawning.
{
  const w = board('elpogoloco'), d = w.data;
  d.arT = 5; d.mon = null;
  const expect = cloneWorld(w);
  rand(expect); rand(expect);
  const next = 40 + Math.floor(rand(expect) * 70);
  stepWorld(w, tilePainter, []);
  assert.equal(d.crates.length, 0);
  assert.equal(d.arT, next);
}

// FUN_800bad74 / 800baef0: the item falls with 0x41f, lands on update 32 with 0x420 and is pickable from then on.
{
  assert.equal(pogoItemHeight(1), 0x1000);
  assert.equal(pogoItemHeight(POGO_ITEM_LAND), 132);
  assert.equal(pogoItemHeight(POGO_ITEM_LAND + 1), 0);
  assert.deepEqual([1, 7, 8, 15].map(k => pogoItemHeight(POGO_ITEM_LAND + 1 + k)), [56, 224, 224, 0]);
  assert.deepEqual([pogoItemShadow(0), pogoItemShadow(0x1ff), pogoItemShadow(0x200)], [0x1000, 0x1000 - 6 * 0x1ff, 0]);
  const w = board('pogo'), d = w.data;
  d.itT = 2;
  stepWorld(w, tilePainter, []);
  const item = d.crates[0];
  assert.equal(item.k, 'item');
  assert.equal(sounds(w, 0x41f), 1);
  place(w, 1, item.rx === 0 && item.rz === 7 ? 1 : 0, 7); // keep the corner rider off the crate
  place(w, 0, item.rx, item.rz);
  while (item.age < POGO_ITEM_LAND) {
    stepWorld(w, tilePainter, []);
    assert.equal(sounds(w, 0x420), 0);
    assert.equal(d.crates.length, 1);
  }
  stepWorld(w, tilePainter, []);
  assert.equal(sounds(w, 0x420), 1);
  assert.equal(d.crates.length, 0);
  assert.equal(d.item[0], item.t);
}

// FUN_800b3e34 runs the spawners and crate objects for the 112 updates under the countdown, without sounds.
{
  const w = createWorld(tilePainter, seats, [], 99, 'pogo'), d = w.data;
  assert.equal(w.ev.filter(e => e.k === 'sfx').length, 0);
  assert.notEqual(d.arT, -1);
  assert.notEqual(d.itT, -1);
  assert.ok(d.crates.length > 0 || d.cash.some((c: { st: number }) => c.st > 0));
  assert.deepEqual(createWorld(tilePainter, seats, [], 99, 'pogo'), w);
}

// FUN_800bdf60 keeps the first of two equal targets in x-then-z order on Pogo Painter as well.
{
  const w = board('pogo'), d = w.data;
  place(w, 0, 3, 3);
  for (const [s, [x, z]] of corners.entries()) if (s) place(w, s, x, z);
  for (const [id, rx] of [[90, 4], [91, 2]]) d.crates.push({ id, k: 'arrow', t: 7, rx, rz: 3, age: 200, dir: 0, yaw: 0 });
  d.cpuRoute = [{ mode: 'pickup', x: -1, z: -1, wait: 0, squareStart: 0, squareStep: 0, odd: false }, null, null, null];
  assert.equal(tilePainter.bot!(w, 0).x, -1);
  // A tile reserved by another rider is not a target, also for cash crates.
  d.crates = [];
  d.cash = [{ st: 3, tm: 0, rx: 3, rz: 5, age: 500, id: -1 }, { st: 3, tm: 0, rx: 3, rz: 0, age: 500, id: -1 }];
  d.rsv[tidx(3, 5)] = 2;
  assert.equal(tilePainter.bot!(w, 0).y, 1);
}

// FUN_800bdcb8 pass 1 on Pogo Padlock: the CPU avoids its own paint except under a cash crate.
{
  const w = board('padlock'), d = w.data;
  d.pad = null;
  place(w, 0, 3, 3);
  for (const [s, [x, z]] of corners.entries()) if (s) place(w, s, x, z);
  for (const [x, z] of [[2, 3], [4, 3], [3, 2], [3, 4]]) d.tiles[tidx(x, z)] = 0;
  d.cash = [{ st: 2, tm: 0, rx: 3, rz: 4, age: 1, id: -1 }, { st: 3, tm: 0, rx: 0, rz: 3, age: 500, id: -1 }];
  d.cpuRoute = [{ mode: 'pickup', x: -1, z: -1, wait: 0, squareStart: 0, squareStep: 0, odd: false }, null, null, null];
  assert.deepEqual([tilePainter.bot!(w, 0).x, tilePainter.bot!(w, 0).y], [0, -1]);
}

// FUN_800bd378 compares rounded positions: a rider mid-hop on the line ahead still draws fire.
{
  const w = board('pogo'), d = w.data;
  place(w, 0, 3, 3);
  for (const [s, [x, z]] of corners.entries()) if (s) place(w, s, x, z);
  d.px[0] = 3.4; d.cnt[0] = 8; d.tx[0] = 4;
  place(w, 1, 3, 6);
  d.item[0] = 1; d.itemAge[0] = 500;
  w.bodies.find(b => b.kind === 'player' && b.slot === 0)!.face = -Math.PI; // yaw 0x800, facing +z
  assert.equal(tilePainter.bot!(w, 0).a, true);
}

// FUN_800c1cf0 inside the stun entry: dropping speed under script 0x2f leaves the rider in idle for one update.
{
  const w = board('pogo'), d = w.data;
  d.item[0] = 5; d.itemT[0] = 100; d.fastIdle[0] = true;
  d.pendingStun = 1;
  stepWorld(w, tilePainter, []);
  assert.deepEqual([d.stun[0], d.item[0], d.pendingStun], [-1, 0, 1]);
  assert.equal(w.ev.filter(e => e.k === 'stun').length, 1);
  stepWorld(w, tilePainter, []);
  assert.deepEqual([d.stun[0], d.pendingStun], [1, 0]);
  assert.equal(w.ev.filter(e => e.k === 'stun').length, 1);
}

// FUN_800b5b1c: a Cortex rider tilts the flame by 5 per hop update up to 45 and back by 2 to 5 idle.
{
  const cortex = [4, 0, 1, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false })); // look 4 = Cortex
  const w = board('pogo', 7, cortex), d = w.data;
  assert.equal(d.fam[0], 3);
  stepWorld(w, tilePainter, [{ x: 1, y: 0, a: false, b: false }]);
  const tilts = [d.jetTilt[0]];
  for (let k = 0; k < 20; k++) { stepWorld(w, tilePainter, []); tilts.push(d.jetTilt[0]); }
  assert.deepEqual(tilts.slice(0, 10), [10, 15, 20, 25, 30, 35, 40, 45, 45, 45]);
  assert.ok(tilts.at(-1)! < 45);
  assert.ok(d.jetY.every((y: number) => y >= 2048 && y <= 8192));
}

console.log('Pogo item drops, arrows, pre-roll, CPU targets, nested stun and jet flame passed.');
