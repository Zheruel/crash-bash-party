// Run with npx tsx scripts/test-pogo-routes.ts from web/.
import assert from 'node:assert/strict';
import { tidx, tilePainter } from '../shared/games/tilePainter';
import { createWorld, stepWorld } from '../shared/sim';
import type { World } from '../shared/types';

type Position = [x: number, z: number, heading: number];
const seats = [0, 1, 2, 3].map((slot) => ({ slot, name: String(slot), bot: true }));
const corners: Position[] = [[0, 0, 2], [7, 7, 3], [0, 7, 3], [7, 0, 2]];

function fixture(variant: string, positions = corners, slot = 0, border = 0): World {
  const w = createWorld(tilePainter, seats, [], 47621, variant);
  const d = w.data;
  w.tick = 100;
  d.tiles.fill(-1);
  d.arT = d.itT = 500;
  d.cash = [];
  d.mon = null;
  d.border = border;
  positions.forEach(([x, z, heading], p) => {
    d.px[p] = x; d.pz[p] = z;
    d.fx[p] = d.tx[p] = Math.round(x); d.fz[p] = d.tz[p] = Math.round(z);
    d.hd[p] = heading;
  });
  d.cpuRoute = Array(4).fill(null);
  d.cpuRoute[slot] = { mode: 'wander', x: 7, z: 7, wait: 0, squareStart: 0, squareStep: 0, odd: false };
  return w;
}

function cpuTick(w: World, slot = 0) {
  const input = tilePainter.bot!(w, slot);
  stepWorld(w, tilePainter, seats.map((s) => s.slot === slot ? input : null));
  return [input.x, input.y];
}

function target(w: World, slot = 0) {
  const { mode, x, z } = w.data.cpuRoute[slot];
  return [mode, x, z];
}

// USA disc match boards from native frame 5998. Replay an eligible seek from the recorded positions.
const observed: { variant: string; board: string[]; positions: Position[]; border: number; aim: [number, number]; stick: number[] }[] = [
  {
    variant: 'agogo', border: 8,
    board: ['...1111.', '........', '........', '..3.....', '333.....', '........', '........', '0...22..'],
    positions: [[0, 0, 2], [3, 6.390625, 3], [3, 0, 1], [0.84375, 3, 0]],
    aim: [7, 6], stick: [1, 0],
  },
  {
    variant: 'elpogoloco', border: 0,
    board: ['........', '...1111.', '......33', '..1.....', '..1222..', '..221...', '..2.....', '0.......'],
    positions: [[0, 0, 2], [4, 2.76171875, 2], [5, 3.73828125, 2], [7, 5.380859375, 2]],
    aim: [2, 3], stick: [-1, 0],
  },
];
for (const { variant, board, positions, border, aim, stick } of observed) {
  const slot = 1;
  const w = fixture(variant, positions, slot, border);
  board.forEach((row, i) => {
    Array.from(row).forEach((owner, x) => { if (owner !== '.') w.data.tiles[tidx(x, 7 - i)] = Number(owner); });
  });
  assert.deepEqual(cpuTick(w, slot), [0, 0]);
  assert.deepEqual(target(w, slot), ['line', ...aim]);
  assert.deepEqual(cpuTick(w, slot), stick);
}

for (const [variant, center, expected] of [
  ['agogo', 1, ['flood', 2, 3]],
  ['agogo', 5, ['wander', 7, 7]],
  ['elpogoloco', 1, ['wander', 7, 7]],
] as const) {
  const w = fixture(variant);
  for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) {
    if (!(z === 3 && x <= 3)) w.data.tiles[tidx(x, z)] = 0;
  }
  w.data.st[tidx(3, 3)] = center;
  cpuTick(w);
  assert.deepEqual(target(w), expected);
}

{
  const w = fixture('agogo', [[4, 4, 0], ...corners.slice(1)]);
  for (const [x, z] of [[1, 0], [1, 1], [4, 4]]) w.data.tiles[tidx(x, z)] = 0;
  cpuTick(w);
  assert.deepEqual(target(w), ['flood', 0, 1]);
}

{
  const w = fixture('agogo');
  for (const [x, z] of [[0, 0], [2, 3], [3, 2], [6, 6]]) w.data.tiles[tidx(x, z)] = 0;
  cpuTick(w);
  assert.deepEqual(target(w), ['wander', 7, 7]);
}

for (const odd of [false, true]) {
  const w = fixture('elpogoloco', [[1, 1, 0], ...corners.slice(1)]);
  if (odd) w.tick++;
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) w.data.tiles[tidx(x, z)] = 0;
  cpuTick(w);
  assert.deepEqual(target(w), odd ? ['square', 1, 2] : ['square', 2, 1]);
  const landings: number[][] = [];
  let last = [1, 1];
  let exit: string | undefined;
  for (let ticks = 0; ticks < 160 && landings.length < 8; ticks++) {
    cpuTick(w);
    const mode = w.data.cpuRoute[0].mode;
    if (mode !== 'square') exit ??= mode;
    const next = [w.data.fx[0], w.data.fz[0]];
    if (next[0] !== last[0] || next[1] !== last[1]) { landings.push(next); last = next; }
  }
  assert.deepEqual(landings, odd
    ? [[1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1], [1, 1]]
    : [[2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [1, 2], [1, 1]]);
  assert.equal(exit, 'search');
}

console.log('Pogo routes match the disc targets, flood rules and both eight-hop squares.');
