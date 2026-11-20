import assert from 'node:assert/strict';
import { tankArena, type TankPickup } from '../shared/games/tankArena';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const round = (variant: string) => createWorld(tankArena, seats, [], 42, variant);
const step = (w: World) => stepWorld(w, tankArena, []);

const swamp = round('swamp');
for (let tick = 0; tick < 650; tick++) {
  step(swamp);
  assert.equal(swamp.data.dropper, null);
  assert.equal(swamp.data.pickups.length, 0);
}

for (const variant of ['desert', 'jungle']) {
  const w = round(variant), d = w.data;
  for (let tick = 0; tick < 140; tick++) step(w);
  assert.equal(d.dropper, null);
  w.rng = 34;
  step(w);
  assert.deepEqual([d.dropper.x, d.dropper.y, d.dropper.vx], [6144, -1024, -64]);
  let observed = false;
  for (let age = 1; age <= 128; age++) {
    step(w);
    assert.equal(d.dropper.x, 6144 - 64 * age);
    const k = d.pickups[0] as TankPickup | undefined;
    if (!k) continue;
    const elapsed = d.f - k.born!;
    if (elapsed === 0) {
      observed = true;
      assert.deepEqual([k.x, k.y, k.z], [d.dropper.x, -1224, d.dropper.z + 60]);
    }
    if (elapsed < 47) assert.deepEqual([k.m, k.y], [5, -1224 + 20 * elapsed]);
    if (elapsed === 47) assert.deepEqual([k.m, k.y, k.vy, k.landed], [0, 0, -40, d.f]);
  }
  assert(observed);
  step(w);
  assert.equal(d.dropper, null);
  while (d.spawnT > 0) step(w);
  step(w);
  assert.deepEqual([d.dropper.x, d.dropper.vx], [-2048, 64]);
}

const metal = round('metal');
metal.data.spawnT = 0;
metal.rng = 0;
step(metal);
const items = metal.data.pickups as TankPickup[];
assert.deepEqual(items.map(k => [k.rack, k.x, k.y, k.z, k.t]), [
  [0, 256, 0, 256, 5], [1, 2304, 0, 2816, 4], [2, 3328, 0, 2816, 4],
]);
assert.equal(metal.data.spawnT, 211);
const resumed = JSON.parse(JSON.stringify(metal));
for (let i = 0; i < 90; i++) {
  step(metal);
  step(resumed);
  assert.deepEqual(metal.data.pickups, resumed.data.pickups);
}
assert.equal(items[0].landed, 2);

// A single shell breaks only the lowest occupied native registry slot inside its box.
const stacked = round('desert');
stacked.data.tk[0].wpn = 11;
stepWorld(stacked, tankArena, [{ ...IDLE, a: true }]);
const shot = stacked.data.shells[0];
for (const rack of [2, 0]) {
  stacked.data.pickups.push({ id: stacked.nextId++, rack, t: 5, x: shot.x, z: shot.z + shot.vz, y: shot.y, vy: 0, m: 0 });
}
step(stacked);
assert.deepEqual(stacked.data.pickups.map((k: TankPickup) => k.rack), [2]);
assert.equal(stacked.ev.filter(e => e.k === 'pkhit').length, 1);

const finished = round('jungle');
finished.data.spawnT = 0;
step(finished);
finished.data.over = true;
finished.data.pickups.push({ id: finished.nextId++, t: 4, x: 1024, z: 3000, y: -80, vy: 0, m: 0 });
step(finished);
assert.equal(finished.data.dropper.y, -1074);
assert.equal(finished.data.pickups.length, 1);
console.log('PASS Tank Wars supply timing, alternating flights, floor spawns, result motion and snapshot replay');
