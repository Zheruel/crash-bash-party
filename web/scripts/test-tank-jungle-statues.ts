import assert from 'node:assert/strict';
import { tankArena } from '../shared/games/tankArena';
import { statueStopsShot, type JungleStatue } from '../shared/games/tankJungleStatues';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const jungle = () => createWorld(tankArena, seats, [], 37, 'jungle');
const pose = (a: JungleStatue) => [a.x, a.y, a.z, a.yaw, a.pose];

// Both routes from a USA L7 replay with four idle human seats.
const frames = new Map([
  [801, [0, 2018, -738, 2003, 0, 0x4180]],
  [856, [0, 932, 0, 361, 0, 0x4180]],
  [975, [0, 844, 0, 609, 1661, 0x419b]],
  [995, [0, 521, 0, 1483, 1661, 0x4092]],
  [1017, [0, 416, 0, 1777, 5, 0x420d]],
  [1035, [0, 416, 0, 1777, 5, 0x4011]],
  [1046, [0, 416, 0, 1777, 5, 0x2004]],
  [1101, [1, 2078, -408, 2003, 0, 0x4180]],
  [1181, [1, 2963, 0, 669, 0, 0x4180]],
  [1546, [1, 779, 0, 2033, 9, 0x420d]],
  [2461, [0, 3289, 0, 2313, -2, 0x418e]],
]);
let w = jungle(), slams = 0;
while (w.tick < 2699) {
  stepWorld(w, tankArena, []);
  const sample = frames.get(w.tick);
  if (sample) assert.deepEqual(pose(w.data.jungleStatues.actors[sample[0]]), sample.slice(1));
  slams += w.ev.filter(e => e.t === w.tick - 1 && e.k === 'statueSlam').length;
  if (w.tick % 180 === 0) w = JSON.parse(JSON.stringify(w));
}
assert.equal(slams, 18);
assert.deepEqual(w.data.tk.map((t: { hp: number }) => t.hp), [0, 0, 39, 39]);

// Native launch clearance includes the x boundary, and the statue absorbs shots
// throughout the bounce. Damage uses the pre-movement slam origin.
w = jungle();
const state = w.data.jungleStatues, pilot = w.data.tk[0];
state.timer = 1;
Object.assign(pilot, { x: 912, z: 1024 });
for (let i = 0; i < 12; i++) stepWorld(w, tankArena, []);
assert.equal(state.released, 0);
Object.assign(pilot, { x: 1478, z: 1770 });
stepWorld(w, tankArena, []);
assert.equal(state.released, 1);
for (let i = 0; i < 20; i++) stepWorld(w, tankArena, []);
assert.equal(pilot.hp, 39);
const actor = state.actors[0];
assert(statueStopsShot(state, actor.x + 224, actor.z - 224));
assert(!statueStopsShot(state, actor.x + 225, actor.z - 224));
assert(w.ev.some(e => e.k === 'statueSlam' && e.t === w.tick - 1));
// A stock shell hits the resting statue on its fifth update. Both barrels of
// the double shot reach it on their second update, on opposite sides of its origin.
for (const weapon of [11, 2]) {
  w = jungle();
  const gunner = w.data.tk[0], target = w.data.jungleStatues.actors[0];
  Object.assign(gunner, { x: 932, z: 1350, yaw: 0, wpn: weapon, ammo: 3 });
  Object.assign(target, { x: 932, y: 0, z: 361, phase: 'rest', rest: 90 });
  w.data.jungleStatues.released = 1;
  w.data.jungleStatues.timer = 300;
  stepWorld(w, tankArena, [{ ...IDLE, a: true }]);
  assert.equal(w.data.shells.length, weapon === 11 ? 1 : 2);
  const flight = weapon === 11 ? 5 : 2;
  for (let frame = 0; frame < flight; frame++) stepWorld(w, tankArena, []);
  const impacts = w.ev.filter(e => e.t === w.tick - 1 && e.k === (weapon === 11 ? 'shellImpact' : 'doubleImpact'));
  const raw = impacts.map(e => [Math.round(2048 + e.x * 1024 / 2.6), Math.round(2048 - e.z * 1024 / 2.6)]);
  assert.deepEqual(raw.sort((a, b) => a[0] - b[0]), weapon === 11 ? [[932, 580]] : [[777, 582], [1088, 582]]);
  assert.equal(w.data.shells.length, 0);
}
for (const variant of ['swamp', 'desert', 'metal']) {
  assert.equal(createWorld(tankArena, seats, [], 37, variant).data.jungleStatues, undefined);
}
console.log('Jungle Fox statue routes, damage, contact and snapshot replay matched');
