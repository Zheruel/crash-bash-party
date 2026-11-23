// USA overlay 0725. Check the four-direction paint table and the original one-tick cash handoff.
import assert from 'node:assert/strict';
import { pogoBoardCell } from '../client/games/pogoBoard';
import { finishPogoHop, pogoResultWindowTicks, tilePainter, tickPogoTiles, tidx } from '../shared/games/tilePainter';
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
// The last arena tick follows the winner's character cue and any hop left at the verdict.
const nativeTails = [209, 208, 208, 211, 211, 208, 211, 208, 219, 220];
for (const variant of tilePainter.variants!) {
  for (const [char, tail] of nativeTails.entries()) {
    const w = createWorld(tilePainter, [{ slot: 0, char, name: 'Winner', bot: false }], [], 83, variant.id);
    assert.equal(pogoResultWindowTicks(w, undefined), 120);
    assert.equal(pogoResultWindowTicks(w, 0, char), tail + 1);
    const body = w.bodies.find(b => b.kind === 'player' && b.slot === 0)!;
    for (const [counter, fast, pending, speed] of [
      [0, false, false, 1], [8, false, false, 1], [4, true, false, 1],
      [6, false, true, 1], [8, false, false, 1.6],
    ] as const) {
      const replay = cloneWorld(w);
      replay.data.cnt[0] = counter;
      replay.data.fastHop = [fast, false, false, false];
      replay.data.pendingStun = pending ? 1 : 0;
      replay.params.speed = speed;
      const expected = pogoResultWindowTicks(replay, 0, char);
      const rider = replay.bodies.find(b => b.id === body.id)!;
      let entry = 1;
      while (finishPogoHop(replay, rider) && entry < 30) entry++;
      assert.equal(expected, entry + tail, `${variant.id}/${char} hop at ${counter}`);
    }
  }
}
console.log('Pogo board connections, cash frames, mine warnings and result windows passed.');
