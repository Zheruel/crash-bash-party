import assert from 'node:assert/strict';
import { IDLE } from '../shared/types';
import { createWorld, stepWorld } from '../shared/sim';
import { tankArena, swampShieldFrame } from '../shared/games/tankArena';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, bot: false, name: String(slot) }));
const w = createWorld(tankArena, seats, [], 10, 'swamp');
const d = w.data, pilot = d.tk[0];
d.spawnT = 9999;
Object.assign(pilot, { x: 1800, z: 1800 });
const step = (mine = false, shield = false) => stepWorld(w, tankArena, [{ ...IDLE, b: mine, d: shield }]);
step(true, true);
const m = d.mines[0];
assert.deepEqual([m.x, m.drift.y, m.z, pilot.mines, pilot.shieldCd, pilot.inv], [1800, -20, 1800, 2, 60, 10]);
assert(w.ev.some(e => e.k === 'sfx' && e.v === 0x50a));

// Start at the captured frame-counter phase of the first L5 mine.
m.drift.angle = 3262;
for (let age = 1; age <= 40; age++) {
  step(age === 40);
  if (age === 1) assert.deepEqual([m.x, m.drift.y, m.z, m.drift.armed], [1793, -23, 1802, false]);
  if (age === 10) assert.deepEqual([m.x, m.drift.y, m.z, pilot.inv], [1730, -15, 1820, 0]);
  if (age === 40) assert.deepEqual([m.x, m.drift.y, m.z, pilot.mines, pilot.shieldCd], [1520, -20, 1896, 2, 20]);
}
Object.assign(pilot, { x: 3800, z: 2300 });
step();
assert.equal(m.drift.armed, true);
while (pilot.shieldCd > 1) step();
step(false, true); // The last cooldown frame consumes this edge.
assert.equal(pilot.inv, 0);
step();
step(false, true);
assert.equal(pilot.inv, 10);
const phase = [];
for (let age = 1; age <= 19; age++) {
  pilot.x -= 8;
  const origin = pilot.shield?.x;
  step();
  const frame = pilot.shield ? swampShieldFrame(d.f - pilot.shield.start) : -1;
  phase.push(frame);
  if (pilot.shield) assert.equal(pilot.shield.x, frame === 0 ? pilot.x : origin);
}
assert.deepEqual(phase, [0, 1, 2, 3, 0, 1, 2, 3, -1, 0, 1, 2, 3, -1, 0, 1, 2, 3, -1]);
while (m.drift.age < 160) step();
assert.equal(d.mines.length, 1);
assert.equal(pilot.hp, 99);
assert(!w.ev.some(e => e.k === 'sfx' && e.v === 0x4eb));

// Contact stops the first boat. The wider blast also reaches an adjacent pilot.
Object.assign(d.tk[1], { x: m.x, z: m.z, vx: 8, vz: 4 });
Object.assign(d.tk[2], { x: m.x + 580, z: m.z });
const resumed = JSON.parse(JSON.stringify(w));
step();
stepWorld(resumed, tankArena, [IDLE]);
assert.deepEqual(JSON.parse(JSON.stringify(resumed)), JSON.parse(JSON.stringify(w)));
assert.deepEqual([d.mines.length, d.tk[1].hp, d.tk[1].vx, d.tk[1].vz, d.tk[2].hp], [0, 39, 0, 0, 39]);
assert.equal(w.ev.filter(e => e.k === 'floatingMineBlast').length, 1);
step(false, true);
step(true);
assert.deepEqual([d.mines.length, pilot.mines, pilot.shieldCd], [1, 1, 59]);
// Cardinal target, 70-unit facing threshold and wider 99-unit firing threshold.
for (const [yaw, pad] of [[70, 0x8000], [71, 0x8080], [99, 0x8080], [100, 0x80]]) {
  const aiWorld = createWorld(tankArena, seats.map(s => ({ ...s, bot: true })), [], 42, 'swamp');
  const [boat, target] = aiWorld.data.tk;
  Object.assign(boat, { x: 2200, z: 1900, yaw });
  Object.assign(target, { x: 2200, z: 900 });
  Object.assign(boat.ai, { mode: 6, target: 1, timer: 60 });
  stepWorld(aiWorld, tankArena, []);
  assert.equal(boat.pad, pad);
}
for (const dx of [-100, -99, 99, 100]) {
  const aiWorld = createWorld(tankArena, seats.map(s => ({ ...s, bot: true })), [], 42, 'swamp');
  const boat = aiWorld.data.tk[0];
  Object.assign(boat.ai, { mode: 7, target: -1, timer: 60, tx: boat.x + dx, tz: boat.z + 1500 });
  stepWorld(aiWorld, tankArena, []);
  assert.equal(boat.ai.timer, Math.abs(dx) === 99 ? 0 : 59);
}
console.log('PASS Swamp Fox mines, shield pulses, CPU aim and waypoints, and snapshot replay');
