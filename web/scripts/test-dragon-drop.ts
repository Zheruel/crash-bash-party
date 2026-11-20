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

// L28 state 0 at the input unlock. The opening pair have already spun in place.
assert.deepEqual(initial.data.J.map((j: { st: number; yaw: number }) => [j.st, j.yaw]), [[0, 3136], [0, 3136], [6, 0]]);
for (const flightState of [3, 4]) {
  const w = start(), j = w.data.J[0], rider = w.data.P[0];
  const step = () => stepWorld(w, dragonDrop, []);
  Object.assign(j, { st: flightState, owner: 0, x: 0, y: 0, z: 0, vx: 10, vz: 0, vy: 256, b: 4 });
  j.shadow = { x: 0, z: 0, visible: true };
  step();
  assert.equal(j.st, 0);
  assert.equal(j.x, 10);
  assert.equal(j.tracked, flightState === 4);
  assert.equal(j.shadow.x, 0);
  step();
  assert.equal(j.shadow.x, 10);

  Object.assign(j, { x: rider.x + 200, y: -64, z: rider.z, vx: -12 });
  j.shadow.x = j.x;
  step();
  assert.equal(j.st, 1);
  assert.equal(j.tracked, false);
  assert.equal(j.shadow.visible, true);
  assert.equal(j.shadow.x, j.x + 12);
  step();
  assert.equal(j.shadow.visible, false);

  // Throw and knock-loose both restore the full-size jewel and ground marker on this tick.
  j.st = flightState === 3 ? 2 : 5;
  rider.carry = -1;
  const resumed = structuredClone(w);
  step();
  stepWorld(resumed, dragonDrop, []);
  assert.deepEqual(w, resumed);
  assert.equal(j.st, flightState);
  assert.equal(j.tracked, true);
  assert.deepEqual(j.shadow, { x: j.x, z: j.z, visible: true });
}

assert.equal(versusClock(28), 90);
assert.equal(versusClock(29), 89);
for (let second = 5; second >= 0; second--) {
  const tick = RD_TICKS - 30 * second;
  assert.equal(versusClock(tick - 1), second + 1);
  assert.equal(versusClock(tick), second);
}

// USA capture: the rolled target pushes the jewel against the rim on the scoring tick.
const edge = start();
edge.data.th = 17;
const shot = edge.data.J[0];
Object.assign(shot, { x: 70, y: -2231, z: 2715, vx: 151, vy: -1024, vz: -73, yaw: 3456, st: 3, mult: 3, owner: 0 });
stepWorld(edge, dragonDrop, []);
assert.deepEqual([shot.x, shot.y, shot.z, shot.yaw, shot.vx, shot.vz, shot.cd, edge.data.score[0]],
  [352, -2350, 2790, 3586, 118, -118, 19, 3]);

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
console.log('Dragon Drop opening, jewel pickups and rebounds, score roll, timeout and snapshot replay passed.');
