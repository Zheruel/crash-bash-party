import assert from 'node:assert/strict';
import { BOAT_ROTOR_AT_GO, tankArena } from '../shared/games/tankArena';
import { DISC_CHARACTER } from '../shared/look';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type InputState, type World } from '../shared/types';

function make(variant: string, char: number) {
  const seats = [char, 0, 2, 3].map((look, slot) => ({ char: look, slot, name: String(slot), bot: false }));
  return createWorld(tankArena, seats, [], 42, variant);
}

function drive(w: World, ticks: number, pad: Partial<InputState>) {
  for (let i = 0; i < ticks; i++) stepWorld(w, tankArena, [{ ...IDLE, ...pad }]);
}

// L6/L8 four-human recording, slot 0 Brio. The custom pilots use the same speed.
for (const variant of ['desert', 'metal']) {
  for (const char of [5, 8, 9]) {
    const w = make(variant, char), t = w.data.tk[0];
    const corner = { x: 1, y: 1, r: true };
    const pose = () => [t.x, t.z, t.yaw, (t.hull + 2048) & 4095, t.dir];
    drive(w, 1, corner);
    assert.deepEqual(pose(), [256, 768, 2112, 2048, 0]);
    drive(w, 23, corner);
    assert.deepEqual(pose(), [256, 256, 3584, 2048, 3]);
    const resumed = structuredClone(w);
    drive(w, 7, corner);
    assert.deepEqual(pose(), [256, 256, 4032, 1152, 3]);
    drive(w, 1, corner);
    assert.deepEqual(pose(), [280, 256, 0, 1024, 3]);
    drive(resumed, 8, corner);
    assert.deepEqual(resumed.data.tk, w.data.tk);
  }
}

// The Jungle body keeps the same heading while the pilot rotates. At this spawn Up drives toward +z.
for (let char = 0; char < DISC_CHARACTER.length; char++) {
  const w = make('jungle', char), t = w.data.tk[0];
  drive(w, 8, { r: true });
  assert.deepEqual([t.x, t.z, t.yaw, (t.hull + t.yaw) & 4095], [256, 768, 2560, 2048]);
  drive(w, 21, { y: -1, r: true });
  assert.deepEqual([t.x, t.z, t.yaw, (t.hull + t.yaw) & 4095], [256, 768 + 21 * t.speed, 3904, 0]);
  drive(w, 40, { x: -1, y: -1 });
  assert.equal(t.x, 256);
  assert(t.z > 768 + 21 * t.speed);
}

// L5, slot 0 Cortex. The first unlocked rotor pose includes 100 coasting callbacks.
for (const char of [4, 8, 9]) {
  const w = make('swamp', char), t = w.data.tk[0];
  assert.equal(t.rotor, BOAT_ROTOR_AT_GO);
  assert.deepEqual([t.rotor, t.gunPose], [2580, 0x4203]);
  drive(w, 5, {});
  drive(w, 1, { r: true });
  assert.deepEqual([t.rotor, t.gunPose], [1006, 0x4203]);
  drive(w, 19, { x: 1, y: -1 });
  assert.equal(t.bank, -200);
  const resumed = structuredClone(w);
  drive(w, 8, {});
  drive(resumed, 8, {});
  assert.deepEqual(resumed.data.tk, w.data.tk);
  assert.equal(t.bank, -120);
}

// Identical positions, one rival in the forward lane. USA L5/L7 weight all
// survivors equally while L6/L8 prefer the aligned human.
function cpuWorld(variant: string, seed: number) {
  const seats = [8, 9, 0, 7].map((char, slot) => ({ char, slot, name: 'P', bot: false, level: 2 }));
  const w = createWorld(tankArena, seats, [], 42, variant);
  const d = w.data, t = d.tk[0];
  [[1792, 1792], [1792, 3072], [3840, 256], [3584, 512]].forEach(([x, z], i) => Object.assign(d.tk[i], { x, z }));
  Object.assign(t, { aim: 0, cd: 10, busy: -1 });
  Object.assign(t.ai, { timer: 1, target: 1 });
  w.rng = seed;
  return w;
}

for (const [variant, target] of Object.entries({ swamp: 2, desert: 1, jungle: 2, metal: 1 })) {
  const w = cpuWorld(variant, 1);
  tankArena.bot!(w, 0);
  assert.equal(w.data.tk[0].ai.target, target, variant);
}

for (const [seed, cursor, watched, nextCursor, nextId, pad] of [
  [11, 0, undefined, 1, 100, 0x90], // acquire a mine in slot 1
  [12, 0, 100, 0, 100, 0x90],       // keep watching the same mine
  [13, 0, 99, 0, undefined, 0],      // watched mine expired
  [14, 2, undefined, 3, undefined, 0], // empty slot still advances the cursor
] as const) {
  const w = cpuWorld('desert', seed), t = w.data.tk[0];
  Object.assign(t.ai, { timer: 8, mref: cursor, mineId: watched });
  w.data.mines = [{ id: 100, rack: 1, x: 1792, z: 1536, o: 1, n: 60 }];
  const resumed = JSON.parse(JSON.stringify(w));
  for (const world of [w, resumed]) {
    tankArena.bot!(world, 0);
    const { ai } = world.data.tk[0];
    assert.deepEqual([ai.mref, ai.mineId, ai.pad], [nextCursor, nextId, pad]);
  }
}

const swamp = cpuWorld('swamp', 10), boat = swamp.data.tk[0];
boat.busy = 0;
boat.dodge = true;
swamp.data.pickups = [{ rack: 2, x: 512, z: 0 }, { rack: 0, x: 3584, z: 3584 }];
const takeover = tankArena.bot!(swamp, 0);
assert.deepEqual([boat.ai.mode, boat.ai.tx, boat.ai.tz, takeover.d], [4, 3584, 3584, true]);
stepWorld(swamp, tankArena, [takeover]);
assert.equal(boat.inv, 10);

console.log('Tank Wars steering, CPU routes, mine tracking and boat phases passed on four stages.');
