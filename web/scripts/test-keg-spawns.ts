import assert from 'node:assert/strict';
import { kegKaboom, KK_CHAR, type KKData } from '../shared/games/kegKaboom';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { botInput } from '../shared/bots';
import { IDLE } from '../shared/types';

// USA L30 capture, room seed 19 applied before the first generic seat timer.
const seats = [1, 4, 6, 8].map((id, slot) => ({ char: KK_CHAR.indexOf(id), slot, name: String(slot), bot: false }));
const world = createWorld(kegKaboom, seats, [], 19);
const data = world.data as KKData;
const positions = [[-1024, 512], [0, 0], [-2048, 0], [-1536, -1024],
  [-512, 1536], [0, -1536], [1536, 512], [1024, -512]];
const checkpoints = [
  { tick: 0, rng: [3941177923, 3714082468], yaw: 2537, count: 5, scale: 2000 },
  { tick: 23, rng: [4176390795, 3133345382], yaw: 2813, count: 6, scale: 3000 },
  { tick: 100, rng: [641802645, 2222089938], yaw: 3737, count: 8, scale: 6000 },
  { tick: 500, rng: [4262220947, 3790382919], yaw: 345, count: 8, scale: 6000 },
  { tick: 501, rng: [1067717382, 444444415], yaw: 357, count: 8, scale: 6000 },
  { tick: 2699, rng: [1329863097, 2375178916], yaw: 2157, count: 8, scale: 6000 },
];
const pads = seats.map(() => IDLE);
for (const { tick, rng, yaw, count, scale } of checkpoints) {
  while (world.tick < tick) stepWorld(world, kegKaboom, pads);
  assert.deepEqual(data.random, rng, 'RNG at tick ' + tick);
  assert.deepEqual(data.fl.map(a => (a - 1024) & 4095), [yaw, (yaw + 2048) & 4095]);
  const kegs = data.o.filter(o => o.t === 1).sort((a, b) => a.sl - b.sl);
  assert.deepEqual(kegs.map(k => [k.x, k.z]), positions.slice(0, count));
  assert.deepEqual(kegs.map(k => k.sc), kegs.map((_, i) => i === count - 1 ? scale : 6000));
  assert.deepEqual(kegs.map(k => k.kind), kegs.map((_, i) => Number(i === 7)));
  const pickup = data.o.find(o => o.t === 4);
  assert.deepEqual(pickup && [pickup.x, pickup.z, pickup.ch], tick >= 501 ? [0, 1536, 1] : undefined);
  assert.equal(kegKaboom.isOver(world), tick === 2699);
}
assert.equal(data.winner, -1);

// The CPU stages input at GO. Its first move uses the pad drawn on the previous tick.
const mixedSeats = [4, 2, 5, 7].map((id, slot) => ({ ...seats[slot], char: KK_CHAR.indexOf(id), bot: slot !== 0, level: 1 }));
const mixed = createWorld(kegKaboom, mixedSeats, [], 71);
const mixedData = mixed.data as KKData;
assert.deepEqual(mixedData.p.map(p => [p!.pad, p!.ai.pad]), [[0, 0], [0, 0], [0, 16], [0, 96]]);
while (mixed.tick < 21) stepWorld(mixed, kegKaboom, []);
const sixthKeg = mixedData.o.find(o => o.t === 1 && o.sl === 5);
assert.ok(sixthKeg?.t === 1);
assert.deepEqual([sixthKeg.poolSlot, sixthKeg.sc], [26, 2000]);
while (mixed.tick < 45) stepWorld(mixed, kegKaboom, []);
assert.deepEqual(mixedData.random, [3229907558, 3107449235]);
assert.deepEqual(mixedData.p.map(p => [p!.x, p!.z]), [[-933, -1176], [-1449, 1658], [-225, 1988], [2279, -616]]);

// USA Hard, three CPUs. The human runs right, lays a trail north, then taps jump.
const hardSeats = [2, 4, 6, 8].map((id, slot) => ({ ...seats[slot], char: KK_CHAR.indexOf(id), bot: slot !== 0, level: 2 }));
const hard = createWorld(kegKaboom, hardSeats, [], 54);
while (!kegKaboom.isOver(hard)) {
  const t = hard.tick + 1;
  assert.ok(t < 2800);
  const pad = { ...IDLE, x: Number(t >= 12 && t < 37), y: -Number(t >= 48 && t < 67),
    b: t >= 42 && t < 77, a: t >= 107 && t < 112 };
  stepWorld(hard, kegKaboom, [pad]);
  if (t === 2699) assert.deepEqual(hard.data.p.map((p: { score: number }) => p.score), [0, 286, 176, 354]);
  if (t === 1339) {
    assert.deepEqual(hard.data.p.map((p: { score: number }) => p.score), [0, 110, 114, 102]);
    assert.equal(hard.data.p[0].st, 0x73);
    assert.deepEqual(hard.data.random, [1713890303, 2972044184]);
  }
}
assert.deepEqual(hard.data.p.map((p: { score: number }) => p.score), [0, 286, 178, 354]);
assert.equal(hard.tick, 2735);
assert.equal(hard.data.winner, 3);

// The two custom carriers use Cortex's solid marker. Coco's carrier has no such marker.
for (const [look, blocks] of [[8, true], [9, true], [1, false]] as const) {
  const players = [look, 8, 0, 0].map((char, slot) => ({ ...seats[slot], char }));
  const contact = createWorld(kegKaboom, players, [], 19);
  const d = contact.data as KKData;
  d.o = [];
  d.kt = 99;
  Object.assign(d.p[0]!, { x: 0, z: 0 });
  Object.assign(d.p[1]!, { x: 140, z: 0, st: 0x72 });
  stepWorld(contact, kegKaboom, [IDLE, { ...IDLE, x: 1 }]);
  assert.equal(d.p[1]!.x, blocks ? 367 : 200);
}

// A peer predicts a disconnected human from the snapshot with no further pad for that seat.
const host = createWorld(kegKaboom, seats, [], 19);
const initial = cloneWorld(host);
const bot = botInput(kegKaboom, host, 1);
assert.deepEqual(host, initial);
stepWorld(host, kegKaboom, [IDLE, bot]);
const peer = cloneWorld(host);
for (let i = 0; i < 100; i++) {
  stepWorld(host, kegKaboom, [IDLE, botInput(kegKaboom, host, 1)]);
  stepWorld(peer, kegKaboom, []);
}
assert.deepEqual(peer, host);
stepWorld(host, kegKaboom, [IDLE, { ...IDLE, x: -1, b: true }]);
assert.equal(host.data.p[1].cpuFallback, undefined);
assert.equal(host.data.p[1].pad, 0x8080);
// Snapshots from the previous format keep their world RNG and fixed seat order.
const legacy = cloneWorld(initial);
delete legacy.data.pool;
delete legacy.data.random;
delete legacy.data.updateOrders;
for (const o of legacy.data.o) delete o.poolSlot;
legacy.data.kt = 0;
const restored = JSON.parse(JSON.stringify(legacy));
stepWorld(legacy, kegKaboom, []);
stepWorld(restored, kegKaboom, []);
assert.deepEqual(legacy.data, restored.data);
assert.notEqual(legacy.rng, initial.rng);
assert.equal(legacy.data.random, undefined);
console.log('Keg Kaboom native opening, spawns, pickup, CPU input, reconnect and timeout passed.');
