// USA L13 object 0x1408, recorded from the first playable update in PCSX ReARMed.
import assert from 'node:assert/strict';
import { tilePainter, tidx, tileWorld } from '../shared/games/tilePainter';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

const seats = [8, 9, 0, 1].map((char, slot) => ({ slot, char, name: String(slot), bot: false }));
const world = createWorld(tilePainter, seats, [], 123, 'padlock');
const d = world.data;
d.arT = d.itT = 10000;
d.cash = [];
const tick = () => stepWorld(world, tilePainter, seats.map(() => IDLE));
const body = () => world.bodies.find(b => b.kind === 'padlock');
for (let i = 0; i < 127; i++) tick();
assert.equal(body(), undefined);
tick();
assert.equal(body()!.vx, 0);
for (let height = 1; height <= 16; height++) {
  tick();
  assert.equal(body()!.vx, height / 16);
  assert.equal(d.pad.st, 1);
}
tick();
assert.equal(d.pad.st, 3);

// Drive the same positive-X glide as the recording. Origin and destination are in 512-unit tiles.
Object.assign(d.pad, { st: 5, hop: 18, px: 5, pz: 0, tx: 6, tz: 0 });
const rawX = [853, 924, 983, 1032, 1073, 1107, 1135, 1159, 1179, 1195, 1209, 1220, 1230, 1238, 1245, 1250, 1255, 1280];
const restored = cloneWorld(world);
for (const x of rawX) {
  tick();
  stepWorld(restored, tilePainter, seats.map(() => IDLE));
  assert.equal((d.pad.px - 3.5) * 512, x);
}
assert.deepEqual(world, restored);
assert.equal(d.pad.st, 3);

// Pick up a moving lock. The burst follows the lock's exact position on its tile.
Object.assign(d.pad, { st: 5, px: 5.1875, pz: 2, tx: 6, tz: 2, hop: 15, stage: 4, left: 8 });
d.fx[1] = d.px[1] = 5;
d.fz[1] = d.pz[1] = 2;
d.fx[2] = d.px[2] = 5;
d.fz[2] = d.pz[2] = 2;
const painted = tidx(4, 2);
d.tiles.fill(-1);
d.tiles[painted] = 1;
tick();
assert.equal(d.item[1], 6);
assert.equal(d.item[2], 6);
assert.equal(d.itemYaw[1], 0x71);
assert.deepEqual(world.ev.filter(e => e.k === 'sfx' && e.v === 0x54c).map(e => e.s), [1]);
assert.equal(d.st[painted], 10);
assert.equal(body(), undefined);
const effect = world.ev.find(e => e.k === 'pickup' && e.s === 1);
assert.deepEqual([effect?.x, effect?.z], tileWorld(5.1875, 2));
assert.equal(world.ev.filter(e => e.k === 'pickup' && e.v === 6).length, 1);
for (let i = 0; i < 119; i++) tick();
assert.equal(body(), undefined);
tick();
assert.equal(d.pad.stage, 0);
assert.equal(d.pad.left, 18);
assert.equal(body()!.vx, 0);
console.log('Pogo Padlock opening, growth, glide, pickup and respawn matched the L13 fixtures.');
