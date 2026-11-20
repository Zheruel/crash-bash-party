import assert from 'node:assert/strict';
import { VERSUS_CLOCK_END } from '../shared/games/common';
import { kegKaboom } from '../shared/games/kegKaboom';
import { malletMash } from '../shared/games/malletMash';
import { ringDing, type RingDingData } from '../shared/games/ringDing';
import { tilePainter, tidx, TP_VARIANTS } from '../shared/games/tilePainter';
import { createWorld, roundOver, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const start = () => createWorld(ringDing, seats, [], 73);

// An L27 balloon in state 9 is awarded before the timer callback. A touched moving
// balloon still needs another update, so a previously level score can remain a draw.
for (const state of [1, 9]) {
  const w = start();
  const d = w.data as RingDingData;
  d.t = w.tick = VERSUS_CLOCK_END - 1;
  w.time = w.tick / 30;
  d.B.push({ bid: w.nextId++, ty: 11, ow: 0, x: 0, z: 0, hy: 900, angle: 0,
    dr: 0, da: 0, po: 0, pa: 0, st: state, tf: true, tc: 0, ot: 0 });
  stepWorld(w, ringDing, []);
  const popped = state === 9;
  assert.equal(d.score[0], Number(popped));
  assert.equal(d.shown![0], Number(popped));
  assert.equal(roundOver(ringDing, w), !popped);
  if (popped) stepWorld(w, ringDing, []);
  assert.equal(d.draw, !popped);
  assert.equal(d.winner, popped ? 0 : -1);
}

const w = start();
w.data.score[0] = 9;
for (let t = 1; t <= 9; t++) {
  stepWorld(w, ringDing, []);
  assert.equal(w.data.shown[0], Math.ceil(t / 4));
}
w.tick = w.data.t = VERSUS_CLOCK_END - 1;
w.time = w.tick / 30;
const walk = [{ ...IDLE, x: 1 }];
for (let frame = 0; frame <= 6; frame++) {
  const resumed = structuredClone(w);
  stepWorld(w, ringDing, walk);
  stepWorld(resumed, ringDing, walk);
  assert.deepEqual(w, resumed);
  assert.equal(w.data.shown[0], Math.min(9, frame + 4));
  assert.equal(roundOver(ringDing, w), frame === 6);
  assert.equal(w.data.P[0].moving, frame <= 1);
}
const legacy = start();
delete legacy.data.shown;
legacy.data.t = legacy.tick = 2698;
stepWorld(legacy, ringDing, []);
assert.equal(roundOver(ringDing, legacy), false);
stepWorld(legacy, ringDing, []);
assert.equal(roundOver(ringDing, legacy), true);
console.log('Ring Ding late balloon scoring, HUD, timeout input, and snapshot replay passed.');

for (const { id } of TP_VARIANTS) {
  const w = createWorld(tilePainter, seats, [], 73, id);
  w.data.score[0] = 5;
  for (let tick = 1; tick <= 8; tick++) {
    stepWorld(w, tilePainter, []);
    assert.equal(w.data.shown[0], Math.floor((tick + (id === 'elpogoloco' ? 1 : 0)) / 4));
  }
  w.tick = VERSUS_CLOCK_END - 1;
  w.time = w.tick / 30;
  // Inject the same score mismatch as the USA clock trace on all four levels.
  w.data.shown[0] = 1;
  for (let extra = 0; extra <= 4; extra++) {
    const resumed = structuredClone(w);
    stepWorld(w, tilePainter, []);
    stepWorld(resumed, tilePainter, []);
    assert.deepEqual(w, resumed);
    assert.equal(w.data.shown[0], Math.min(extra + 2, 5));
    assert.equal(roundOver(tilePainter, w), extra === 4);
  }
}

// L10: move a mature cash crate under an in-flight player at hop counter 9.
// Two owned tiles plus the pickup's tile are banked while the hop continues.
const pogo = createWorld(tilePainter, seats, [], 73, 'pogo');
pogo.tick = VERSUS_CLOCK_END - 1;
pogo.time = pogo.tick / 30;
const d = pogo.data;
d.tiles.fill(-1);
d.tiles[tidx(2, 1)] = d.tiles[tidx(3, 1)] = 0;
d.cnt[0] = 9;
d.tx[0] = 1;
Object.assign(d.cash[0], { st: 3, age: 24, rx: 0, rz: 0 });
for (let extra = 0; extra <= 3; extra++) {
  stepWorld(pogo, tilePainter, []);
  assert.equal(d.score[0], 3);
  assert.equal(d.shown[0], Math.min(3, extra + 1));
  assert.equal(d.cnt[0], extra + 10);
  assert.equal(roundOver(tilePainter, pogo), extra === 3);
}
assert.equal(pogo.ev.filter(e => e.k === 'pogoCashCrate').length, 1);
assert.equal(pogo.ev.filter(e => e.k === 'cash').length, 1);
console.log('All four Pogo score counters, late cash pickup, and delayed result dispatch passed.');

for (const game of [kegKaboom, malletMash]) {
  const phase = game === kegKaboom ? 3 : 1;
  const w = createWorld(game, seats, [], 73);
  w.data.p[0].score = 5;
  for (let tick = 1; tick <= 8; tick++) {
    stepWorld(w, game, []);
    assert.equal(w.data.shown[0], Math.floor((tick + phase) / 4));
  }
  w.tick = VERSUS_CLOCK_END - 1;
  w.time = w.tick / 30;
  w.data.g = 99 + w.tick;
  if (game === malletMash) w.data.clock = w.tick - 27;
  // Another slot still has two points to count after slot zero catches up.
  w.data.p[1].score = 6;
  w.data.shown = [1, 0, 0, 0];
  for (let extra = 0; extra <= 6; extra++) {
    const resumed = structuredClone(w);
    stepWorld(w, game, walk);
    stepWorld(resumed, game, walk);
    assert.deepEqual(w, resumed);
    assert.equal(w.data.shown[0], Math.min(5, 2 + extra));
    assert.equal(w.data.shown[1], Math.min(6, 1 + extra));
    assert.equal(roundOver(game, w), extra === 6);
  }
  assert.equal(w.data.winner, 1);
}
console.log('Mallet Mash and Keg Kaboom multi-seat score settlement passed.');
