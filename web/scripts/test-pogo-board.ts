// USA overlay 0725. Check the four-direction paint table and the original one-tick cash handoff.
import assert from 'node:assert/strict';
import { pogoBoardCell } from '../client/games/pogoBoard';
import { tilePainter, tickPogoTiles, tidx } from '../shared/games/tilePainter';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';

const seats = [8, 9].map((char, slot) => ({ slot, char, name: String(slot), bot: false }));
const agogo = createWorld(tilePainter, seats, [], 123, 'agogo').data;
const center = tidx(3, 3);
for (let owner = 0; owner < 4; owner++) {
  for (let mask = 0; mask < 16; mask++) {
    agogo.tiles.fill(-1);
    agogo.tiles[center] = owner;
    const neighbours = [tidx(2, 3), tidx(3, 2), tidx(4, 3), tidx(3, 4)];
    neighbours.forEach((tile, bit) => { if (mask & (1 << bit)) agogo.tiles[tile] = owner; });
    assert.equal(pogoBoardCell(11, agogo, center, 0), owner * 16 + mask);
  }
}

const padlock = createWorld(tilePainter, seats, [], 123, 'padlock');
const d = padlock.data;
d.tiles.fill(-1);
d.tiles[center] = 0;
d.st[center] = 10;
d.tm[center] = 240;
Object.assign(d.cash[0], { st: 3, rx: d.px[0], rz: d.pz[0], age: 255 });
stepWorld(padlock, tilePainter, []);
assert.equal(d.score[0], 1);
const restored = cloneWorld(padlock);
assert.equal(pogoBoardCell(13, restored.data, center, restored.tick), 85);
for (let n = 1; n <= 9; n++) stepWorld(restored, tilePainter, []);
assert.equal(restored.data.st[center], 1);
assert.equal(pogoBoardCell(13, restored.data, center, restored.tick), 80);

const loco = createWorld(tilePainter, seats, [], 83, 'elpogoloco');
for (let n = 0; n < 1400 && !loco.data.fl.some((flag: number) => flag & 0x20); n++) stepWorld(loco, tilePainter, []);
const firstMine = loco.data.fl.findIndex((flag: number) => flag & 0x20);
assert.ok(firstMine >= 0);
for (const over of [false, true]) {
  const world = cloneWorld(loco);
  world.data.over = over;
  const warnings: number[] = [];
  for (let n = 0; n < 119; n++) {
    world.ev = [];
    tickPogoTiles(world);
    if (world.ev.some(e => e.k === 'sfx' && e.v === 0x3f0)) warnings.push(world.data.tm[firstMine]);
  }
  assert.deepEqual(warnings, [90, 60, 30, 20, 10]);
  assert.equal(world.data.st[firstMine], 1);
}
console.log('Pogo board connections, cash frames and mine warnings passed.');
