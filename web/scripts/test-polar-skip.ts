// Forced victory with every human out (FUN_8007d5ec / FUN_8007d6d0 / FUN_800b5910).
import assert from 'node:assert/strict';
import { POLAR_SKIP_WAIT, S_OUT, S_WIN, poSetState, poTest, pushOff } from '../shared/games/pushOff';
import { createWorld, roundOver, stepWorld } from '../shared/sim';
import { IDLE, type InputState, type World } from '../shared/types';

const seats = (roster: number[], humans: number[]) => roster.map((char, slot) => ({ char, slot, name: String(slot), bot: !humans.includes(slot) }));
const now = (w: World) => w.ev.filter((e) => e.t === w.tick - 1);
const sounds = (w: World) => now(w).filter((e) => e.k === 'sfx').map((e) => e.o);

// The CPUs stand still in the middle so both stay in for the 240-tick wait.
poTest.noAI = true;
poTest.pre = (_w, d) => d.P.forEach((q: { x: number; z: number; vx: number; vz: number } | null, s: number) => {
  if (q) { q.x = s * 400 - 600; q.z = 0; q.vx = q.vz = 0; }
});
for (const variant of ['tilt', 'polar', 'melt', 'manic']) {
  const w = createWorld(pushOff, seats([0, 3, 5, 7], [0, 2]), [], 77, variant);
  const pads = (b = false, both = false): InputState[] => [{ ...IDLE, b }, IDLE, { ...IDLE, b: b && both }, IDLE];
  stepWorld(w, pushOff, pads());
  poSetState(w, 0, S_OUT);
  stepWorld(w, pushOff, pads(true));
  assert.equal(w.data.skipWait, undefined, 'a human still plays');
  poSetState(w, 2, S_OUT);
  // the wait counts ticks with no human playing; a press before the prompt does nothing
  for (let t = 0; t < POLAR_SKIP_WAIT; t++) {
    stepWorld(w, pushOff, pads(t % 2 === 0));
    assert.deepEqual(sounds(w), []);
    assert.equal(w.data.skipShown, undefined);
  }
  stepWorld(w, pushOff, pads());
  assert.deepEqual(sounds(w), [0x194]);
  assert.equal(w.data.skipShown, w.data.t);
  for (let t = 0; t < 5; t++) stepWorld(w, pushOff, pads());
  const before = w.data.P.filter((q: { fl: number }) => !(q.fl & 0x2000)).length;
  assert.equal(before, 2);
  stepWorld(w, pushOff, pads(true));
  assert.deepEqual(sounds(w), [0x195]);
  assert(!now(w).some((e) => e.k === 'splash'), 'FUN_800d0470 keys no 0x45d after the skip');
  const states = w.data.P.map((q: { st: number }) => q.st);
  const winner = states.indexOf(S_WIN);
  assert(winner === 1 || winner === 3);
  assert.equal(states.filter((s: number) => s === S_OUT).length, 3);
  assert.equal(now(w).filter((e) => e.k === 'skipOut').length, 1);
  stepWorld(w, pushOff, pads(true));
  assert(roundOver(pushOff, w));
  assert.equal(pushOff.isDraw!(w, pushOff.placements(w)), false);
  assert.equal(pushOff.placements(w)[0], winner);
}

// Two humans pressing on one tick run FUN_800b5910 twice: the second pass also puts the chosen winner out.
{
  const w = createWorld(pushOff, seats([0, 3, 5, 7], [0, 2]), [], 77, 'melt');
  poSetState(w, 0, S_OUT); poSetState(w, 2, S_OUT);
  for (let t = 0; t <= POLAR_SKIP_WAIT; t++) stepWorld(w, pushOff, []);
  stepWorld(w, pushOff, [{ ...IDLE, b: true }, IDLE, { ...IDLE, b: true }, IDLE]);
  assert.deepEqual(sounds(w), [0x195, 0x195]);
  assert(w.data.P.every((q: { st: number }) => q.st === S_OUT));
  stepWorld(w, pushOff, []);
  assert(roundOver(pushOff, w));
  assert.equal(pushOff.isDraw!(w, pushOff.placements(w)), true);
}

// All-CPU rounds have no pad to take the prompt.
{
  const w = createWorld(pushOff, seats([0, 3, 5, 7], []), [], 77, 'polar');
  for (let t = 0; t < POLAR_SKIP_WAIT + 4; t++) stepWorld(w, pushOff, []);
  assert.equal(w.data.skipShown, undefined);
}
console.log('Polar Push forced victory matched FUN_8007d5ec, FUN_8007d6d0 and FUN_800b5910 on all four stages.');
