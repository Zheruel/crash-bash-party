import assert from 'node:assert/strict';
import { POLAR_DRAW_TICKS, POLAR_TIMEOUT_TICK, S_IDLE, S_OUT, S_WIN, pushOff, stepPolarResultMotion } from '../shared/games/pushOff';
import { winnerCheerFrame } from '../shared/look';
import { createWorld, roundOver, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

const seats = (roster: number[]) => roster.map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const isDraw = (w: World) => pushOff.isDraw!(w, pushOff.placements(w));

// USA L19, first ten playable ticks. The screen's upward direction is native +Z.
for (const [x, y] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
  for (const mirror of [false, true]) {
    const w = createWorld(pushOff, seats([7, 0, 4, 6]), [], 243, 'polar');
    w.params.mirror = mirror;
    const rider = w.data.P[0];
    const start = [rider.x, rider.z];
    for (const distance of [2, 6, 12, 20, 30, 42, 56, 72, 90, 110]) {
      stepWorld(w, pushOff, [{ ...IDLE, x, y }]);
      const d = mirror ? -distance : distance;
      assert.deepEqual([rider.x, rider.z], [start[0] + x * d, start[1] - y * d]);
    }
  }
}

// A disconnected human uses the bot's native pad through the human input path.
const takeoverDirections = new Set<number>();
for (let slot = 0; slot < 4; slot++) {
  const w = createWorld(pushOff, seats([0, 8, 9, 2]), [], 243, 'polar');
  const q = w.data.P[slot];
  for (let t = 0; t < 60; t++) {
    const pads = [IDLE, IDLE, IDLE, IDLE];
    pads[slot] = pushOff.bot!(w, slot);
    const direction = q.ai.bits & 0xf0;
    stepWorld(w, pushOff, pads);
    assert.equal(q.pb & 0xf0, direction);
    takeoverDirections.add(direction & 0x50);
  }
}
assert(takeoverDirections.has(0x10) && takeoverDirections.has(0x40));

// USA L18–21. Each live rider has 20 ranking points regardless of position or dash charge.
for (const variant of ['tilt', 'polar', 'melt', 'manic']) {
  for (const survivors of [0, 1, 2, 3, 4]) {
    const w = createWorld(pushOff, seats([8, 9, 0, 2]), [], 123, variant);
    w.tick = w.data.t = POLAR_TIMEOUT_TICK - 1;
    w.time = w.tick / 30;
    for (const [s, q] of w.data.P.entries()) {
      q.g = s * 49;
      if (s >= 4 - survivors) continue;
      q.st = S_OUT;
      q.fl |= 0xa000;
      w.data.elim[s] = w.tick - s;
    }
    stepWorld(w, pushOff, []);
    assert(roundOver(pushOff, w));
    assert.equal(isDraw(w), survivors !== 1);
    if (survivors === 1) assert.equal(pushOff.placements(w)[0], 3);
  }
}

// The uninterrupted USA Polar Panic recording counts the first playable update as tick 1.
const polar = createWorld(pushOff, seats([8, 9, 0, 2]), [], 21, 'polar');
polar.data.m100 = 9999;
for (let t = 1; t <= 2699; t++) {
  stepWorld(polar, pushOff, []);
  assert.equal(roundOver(pushOff, polar), t === 2699);
}

// Accelerated L18 clock with Rilla, Crash, Tiny and Dingodile. The two hanging
// riders count as survivors at the buzzer and fall away during the TIE display.
const tilt = createWorld(pushOff, seats([7, 0, 2, 3]), [], 12, 'tilt');
for (let tick = 1; tick < 114; tick++) stepWorld(tilt, pushOff, []);
tilt.tick = POLAR_TIMEOUT_TICK - 1;
tilt.time = tilt.tick / 30;
stepWorld(tilt, pushOff, []);
assert(isDraw(tilt));
const frozen = structuredClone(tilt);
const replay = structuredClone(tilt);
const rejoined: World = JSON.parse(JSON.stringify(tilt));
for (let i = 1; i <= POLAR_DRAW_TICKS; i++) {
  stepPolarResultMotion(replay, true);
  stepPolarResultMotion(rejoined, true);
  assert.deepEqual(replay.data.P, rejoined.data.P);
}
assert.deepEqual(tilt, frozen);
assert.deepEqual(replay.data.P.map((q: { x: number; z: number; st: number }) => [q.x, q.z, q.st]), [
  [-1502, -2312, S_OUT], [-1994, 142, S_IDLE], [-66, -744, S_IDLE], [672, -2502, S_OUT],
]);
// L18, sample 130. Three opponents slip. A rider on the ice gets a close-up;
// with the last survivor hanging off the rim the camera eases to its previous target.
for (const hanging of [false, true]) {
  const slot = hanging ? 0 : 1;
  const lineup = hanging ? [6, 0, 1, 4] : [6, 0, 2, 3];
  const match = createWorld(pushOff, seats(lineup), [], 12, 'tilt');
  for (let tick = 1; tick <= 68; tick++) {
    if (tick === 33) for (const [s, q] of match.data.P.entries()) {
      if (s === slot) continue;
      q.x = s % 2 ? -5900 : 5900;
      q.z = 600 * s - 1000;
    }
    stepWorld(match, pushOff, []);
  }
  assert(roundOver(pushOff, match));
  assert.equal(pushOff.placements(match)[0], slot);
  assert.equal(match.data.P[slot].st, S_WIN);
  assert.deepEqual(match.data.camera, hanging ? [206, -665, 10490] : [-438, -266, 9908]);
  const after = JSON.parse(JSON.stringify(match));
  for (let tick = 0; tick < 67; tick++) stepPolarResultMotion(after, slot, winnerCheerFrame(lineup[slot]));
  assert.equal(after.data.P[slot].yaw & 4095, 4093);
  assert.deepEqual(after.data.camera, hanging ? [192, -668, 9931] : [758, 612, 439]);
  assert.equal(match.data.P[slot].k, 0);
}
console.log('Polar Push timeouts, win cameras, draws and terminal replay passed.');
