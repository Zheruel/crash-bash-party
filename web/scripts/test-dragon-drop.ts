import assert from 'node:assert/strict';
import { versusClock } from '../shared/games/common';
import { createDragonDropResult, dragonDrop, RD_INTRO_GONG, RD_INTRO_TARGETS, RD_TICKS } from '../shared/games/dragonDrop';
import { createWorld, roundOver, stepWorld } from '../shared/sim';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const start = () => createWorld(dragonDrop, seats, [], 0);
const initial = start();
assert.equal(RD_INTRO_GONG, 80);
assert.deepEqual(RD_INTRO_TARGETS[99], { phase: 1188, th: 747, tx: 2570, tz: 1148, tyaw: 750, troll: 1500, gcd: 71 });
assert.deepEqual(initial.data.ord[0], [2, 0, 3, 1]);
const beforeResult = JSON.stringify(initial);
createDragonDropResult(initial, undefined).advance(120);
assert.equal(JSON.stringify(initial), beforeResult);

assert.equal(versusClock(28), 90);
assert.equal(versusClock(29), 89);
for (let second = 5; second >= 0; second--) {
  const tick = RD_TICKS - 30 * second;
  assert.equal(versusClock(tick - 1), second + 1);
  assert.equal(versusClock(tick), second);
}

for (const points of [0, 1, 3, 5]) {
  const w = start();
  w.tick = w.data.t = RD_TICKS - 1;
  w.time = w.tick / 30;
  w.data.score[0] = points;
  for (let extra = 0; extra <= points; extra++) {
    const resumed = JSON.parse(JSON.stringify(w));
    stepWorld(w, dragonDrop, []);
    stepWorld(resumed, dragonDrop, []);
    assert.equal(w.data.shown[0], Math.min(extra + 1, points));
    assert.equal(roundOver(dragonDrop, w), extra === points);
    assert.equal(JSON.stringify(w), JSON.stringify(resumed));
  }
  assert.equal(dragonDrop.isDraw!(w, dragonDrop.placements(w)), points === 0);
}
console.log('Dragon Drop countdown, score roll, native timeout and snapshot replay passed.');
