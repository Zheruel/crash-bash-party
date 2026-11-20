import assert from 'node:assert/strict';
import { animStart, createMalletMashResult, malletMash, mmOpeningPose, mmPose, type MMData } from '../shared/games/malletMash';
import { CHARACTERS } from '../shared/look';
import { createWorld, stepWorld } from '../shared/sim';
import { VERSUS_CLOCK_END } from '../shared/games/common';

// USA L29 at the locked countdown's first and last updates, including separate idle cycle lengths.
for (const [ch, last] of [[2, 15], [3, 3], [6, 3], [8, 19]]) {
  assert.deepEqual(mmOpeningPose(ch, 98), [0, 1]);
  assert.deepEqual(mmOpeningPose(ch, 0), [0, last]);
}
for (const [char] of CHARACTERS.entries()) {
  const w = createWorld(malletMash, [{ char, slot: 0, name: 'P1', bot: false }], [], 29);
  const p = (w.data as MMData).p[0];
  assert.deepEqual(mmOpeningPose(p.ch, 0), mmPose(p.an));
}

function terminal(chars: number[], winner?: number) {
  const w = createWorld(malletMash, chars.map((char, slot) => ({ char, slot, name: String(slot), bot: false })), [], 73);
  const d = w.data as MMData;
  w.tick = VERSUS_CLOCK_END - 1;
  d.g = w.tick + 99;
  d.clock = w.tick - 27;
  d.p.forEach((p, i) => { p.score = d.shown![i] = i === winner ? 20 : 0; });
  stepWorld(w, malletMash, []);
  assert.equal(d.winner, winner ?? -1);
  return { w, d };
}

for (const [look] of CHARACTERS.entries()) {
  const { w, d } = terminal([look, 1, 4, 3], 0);
  const snapshot = JSON.stringify(w);
  const result = createMalletMashResult(w, 0);
  const [winner, loser] = result.data.p;
  assert.equal(winner.an.pose, d.p[0].an.pose);
  assert.equal(result.cameraActive, false);
  assert.deepEqual(result.step().filter(e => e.k === 'resultWinner').map(e => e.s), [0]);
  assert.equal(winner.st, 0x47);
  assert.equal(winner.an.id, 0x39);
  assert.equal(winner.yaw, d.p[0].yaw);
  assert.equal(loser.an.id, 0x33);
  assert.equal(loser.sc, 4096);
  assert.equal(result.cameraActive, true);
  result.step();
  assert.equal(loser.sc, 3968);
  for (let tick = 3; tick <= 32; tick++) assert.equal(result.step().some(e => e.k === 'resultBurst' && e.s >= 0), false);
  assert.equal(loser.sc, 128);
  assert.deepEqual(result.step().filter(e => e.k === 'resultBurst' && e.s >= 0).map(e => e.s), [1, 2, 3]);
  assert.equal(loser.sc, 0);
  assert.equal(result.step().some(e => e.k === 'resultBurst' && e.s >= 0), false);
  assert.equal(JSON.stringify(w), snapshot);
}

{
  const { w, d } = terminal([6, 1, 4, 3], 0);
  for (const p of d.p.slice(0, 2)) {
    p.st = 0x42;
    animStart(p, 0x38);
  }
  const result = createMalletMashResult(w, 0);
  const entries: number[] = [], bursts: number[][] = [];
  for (let tick = 1; tick <= 54; tick++) {
    for (const e of result.step()) {
      if (e.k === 'resultWinner') entries.push(tick);
      if (e.k === 'resultBurst' && e.s >= 0) bursts.push([tick, e.s]);
    }
    assert.equal(result.cameraActive, tick >= 28);
  }
  assert.deepEqual(entries, [28]);
  assert.deepEqual(bursts, [[33, 2], [33, 3], [54, 1]]);
}

{
  const { w, d } = terminal([8, 9, 0, 3]);
  const [idle, charge] = d.p;
  for (const p of [idle, charge]) {
    p.yaw = p.hd = 3072;
    p.pw = 1;
  }
  charge.st = 0x44;
  charge.lock = 10;
  animStart(charge, 0x36);
  d.mu[0] = { st: 2, c: 2, x: 0, z: 0, ys: 0, gold: true, bd: 0, id: 1 };
  d.mu[1] = { st: 0xe, c: 2, x: 800, z: 0, ys: 0xc00, gold: false, bd: 0, id: 2 };
  const result = createMalletMashResult(w, undefined);
  const [a, b] = result.data.p;
  const events = result.step();
  assert.equal(a.yaw, 3328);
  assert.equal(b.yaw, 3072);
  assert.equal(b.st, 0x40);
  assert.equal(result.cameraActive, true);
  events.push(...result.step(), ...result.step());
  assert.equal(result.data.mu[0]?.c, 2);
  assert.deepEqual(events.map(e => [e.k, e.s]), [['resultBurst', -1]]);
  assert.equal(a.pw, 1);
  assert.equal(b.pw, 1);
}

{
  const { w, d } = terminal([4, 1, 6, 3], 0);
  d.mu[0] = { st: 2, c: 90, x: 0, z: 0, ys: 0, gold: true, bd: 0, id: 1 };
  d.mu[1] = { st: 2, c: 91, x: 800, z: 0, ys: 0, gold: false, bd: 0, id: 2 };
  d.mu[2] = { st: 0xe, c: 2, x: 1600, z: 0, ys: 0xc00, gold: false, bd: 0, id: 3 };
  const result = createMalletMashResult(w, 0);
  const cues: [number, string][] = [];
  for (let tick = 1; tick <= 91; tick++) {
    for (const e of result.step()) {
      if (e.k === 'boom' || (e.k === 'rise' && e.x === 0 && e.z === 0)) cues.push([tick, e.k]);
    }
  }
  assert.deepEqual(cues, [[3, 'boom'], [90, 'rise']]);
  assert.equal(result.data.mu[1]?.c, 1);
}

console.log('Mallet Mash result dispatch, draw, staggered damage, and snapshot isolation passed for all ten looks.');
