import assert from 'node:assert/strict';
import { pushOff, stepPolarResultMotion, type Seal } from '../shared/games/pushOff';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

// USA L18. Ages are 30 Hz ticks from the creation of object 0x1610.
const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const pads = seats.map(() => IDLE);
const samples = [
  [0, 0, 0, 1024, -1, 2396, 1966, -2397, -1967],
  [1, 256, 128, 779, -1, 2365, 1940, -2367, -1942],
  [12, 3072, 1536, -860, -1, 2024, 1654, -2037, -1667],
  [27, 6912, 3456, 0, -1, 1559, 1264, -1587, -1292],
  [28, 3584, 3584, 0, 0, 1528, 1238, -1557, -1267],
  [64, 256, 3711, 0, 4, 1063, 913, -1122, -967],
];

for (const opposite of [false, true]) {
  const w = createWorld(pushOff, seats, [], 123, 'tilt');
  const d = w.data, seal = d.seal as Seal;
  if (opposite) {
    seal.st = 6;
    stepWorld(w, pushOff, pads); // Reposition at the second rim.
    seal.pc = -1; // The second USA fixture starts with a fresh animation script.
  }
  // Keep the four idle riders centered through both dives.
  d.P.forEach((p: { x: number; z: number }, slot: number) => {
    p.x = slot % 2 ? 350 : -350;
    p.z = slot < 2 ? 350 : -350;
  });
  seal.t = -1;
  d.ms = 1;
  d.mh = -1;
  d.m100 = 9999;
  let resumed: World | undefined;
  const cues: [number, number][] = [];
  const dive = opposite ? 213 : 211;
  for (let age = 0; age <= dive + 39; age++) {
    stepWorld(w, pushOff, pads);
    if (resumed) {
      stepWorld(resumed, pushOff, pads);
      assert.deepEqual(resumed.data.seal, seal);
    }
    if (age === 18) resumed = JSON.parse(JSON.stringify(w)) as World;
    if (age === 12 || age === 103) {
      const result = structuredClone(w);
      for (let i = 0; i < 100; i++) stepPolarResultMotion(result);
      const hazard = result.data.seal as Seal;
      if (age === 12) {
        assert.equal(hazard.st, 2);
        assert.equal(hazard.t, seal.t);
        assert.equal(hazard.fish?.landed, true);
        assert.equal(seal.fish?.landed, false);
      } else {
        assert.equal(hazard.st, 5);
        assert.equal(hazard.fish, undefined);
      }
      assert.deepEqual(result.data.P, w.data.P);
      assert.deepEqual(result.bodies, w.bodies);
    }
    const expected = samples.find(([tick]) => tick === age);
    if (expected) {
      const [, pitch, yaw, y, frame, x, z, otherX, otherZ] = expected;
      const f = seal.fish!;
      assert.deepEqual([f.x, f.y, f.z, f.pitch, f.yaw, f.frame], [opposite ? otherX : x, y, opposite ? otherZ : z, pitch, yaw, frame]);
    }
    const fresh = w.ev.filter(e => e.t === w.tick - 1);
    for (const e of fresh) {
      if (e.k === 'sealSound' || e.k === 'seal') cues.push([age, e.v]);
      if (e.k === 'seal' && e.v === 1) assert(e.o >= 0 && e.o <= 3);
    }
    if (age === 117) assert.equal(seal.pose, 0x4012);
    if (age === 119) assert.equal(seal.pose, 0x4013);
    if (age === 130) assert(seal.fish);
    if (age === 131) {
      assert.equal(seal.fish, undefined);
      assert.equal(seal.pose, 0x4020);
    }
    if (age === dive + 38) {
      assert.equal(seal.pose, 0x4126);
      assert.equal(w.bodies.find(b => b.kind === 'seal')?.alive, true);
    }
  }
  assert.equal(w.bodies.find(b => b.kind === 'seal')?.alive, false);
  assert.deepEqual(cues, [
    [0, 2], [27, 0x479], [92, 3], [119, 1],
    [138, 0x476], [144, 0x477], [154, 0x476], [160, 0x477], [161, 0x47a],
    [170, 0x476], [176, 0x477], [186, 0x476], [192, 0x477], [202, 0x476], [208, 0x477], [dive, 7],
  ]);
}

console.log('Tilt Panic seal and fish matched both USA rim fixtures, including snapshot resumption.');
