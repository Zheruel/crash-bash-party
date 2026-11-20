import assert from 'node:assert/strict';
import { dashCheerPose, fitDashResult } from '../client/games/dashRaceResult';
import { FitCam, LEVEL_CAMS } from '../client/games/ps1cam';
import { dashKartPose } from '../client/games/playerPose';
import { Predictor } from '../client/predict';
import { arenaClock } from '../client/ui/ps1hud';
import { dashCpuInput, dashRace, dashRideHeight, DR_ANGLE, DR_K, DR_VARIANTS, stepDashResult } from '../shared/games/dashRace';
import { CHARACTERS, DISC_CHARACTER } from '../shared/look';
import { createWorld, roundOver, stepWorld } from '../shared/sim';
import { IDLE, type Body } from '../shared/types';

const slots = ['big-stein', 'top-g', 'crash', 'cortex'].map((id, slot) => {
  const char = CHARACTERS.findIndex((c) => c.id === id);
  assert.ok(char >= 0, id);
  return { slot, bot: false, name: CHARACTERS[char].name, char };
});
const U = DR_K / 1024;
const native = (b: Body) => [b.x / U, -b.y / U, -b.z / U, -b.face / DR_ANGLE].map(Math.round);
const fresh = (variant: string) => createWorld(dashRace, slots, [], 0x1234, variant);
const step = (w: ReturnType<typeof fresh>) => stepWorld(w, dashRace, []);

// The first playable USA individual-versus update is stage frame 113. Pickup and lap counters
// wait for GO, while the idle poses, hub and volcano have already advanced.
for (const { id } of DR_VARIANTS) {
  const race = fresh(id), d = race.data;
  const startZ = d.gz[0];
  assert.equal(race.tick, 0);
  assert.deepEqual([d.f, d.pre, ...d.st], [112, 60, 112, 112, 112, 112]);
  assert.equal(d.vz[0], 0);
  if (id === 'dante') assert.equal(d.vt, 338);
  if (id === 'toxic') assert.ok(d.monTim >= 128 && d.monTim <= 217);
  if (id === 'splash') {
    const angle = d.pat === 1 || d.pat === 2 ? 448 : 4096 - 448;
    assert.deepEqual([d.rot, d.wait], [angle, 68]);
    assert.deepEqual(race.bodies.filter(b => b.kind === 'rod').map(b => b.cd),
      Array.from({ length: 6 }, (_, i) => (angle + i * 682) & 4095));
  }
  stepWorld(race, dashRace, [{ ...IDLE, y: -1 }]);
  assert.deepEqual([d.f, d.pre, d.gz[0], d.vz[0]], [113, 59, startZ - 3, id === 'splash' ? -600 : -768]);
  assert.deepEqual(d.exhaust, [{
    kind: id === 'splash' ? 'spray' : 'run', born: 113, x: d.gx[0], y: dashRideHeight(id), z: startZ + 200,
  }]);
  for (let t = 2; t <= 89; t++) {
    step(race);
    if (t <= 19) assert.equal(d.exhaust.length, Number(t <= (id === 'splash' ? 17 : 18)));
    if (t === 28 || t === 29) assert.equal(arenaClock('dashRace', race), t === 28 ? 90 : 89);
  }
  assert.equal(race.bodies.some(b => b.kind === 'fruit'), false);
  step(race);
  assert.ok(race.bodies.some(b => b.kind === 'fruit') || race.ev.some(e => e.k === 'pickup' && e.v === 2));
}

// USA Toxic versus recording, with a human holding the accelerator through update 162
// and three Normal CPUs. The monster's first salvo advances the shared RNG at 408.
{
  const seats = slots.map(s => ({ ...s, bot: s.slot !== 0, level: 1 }));
  const race = createWorld(dashRace, seats, [], 1, 'toxic'), d = race.data;
  d.random = [811997945, 1310019043];
  d.monTim = 160;
  d.updateOrders = [
    [1, 0, 3, 2], [1, 3, 2, 0], [2, 3, 0, 1], [0, 1, 3, 2],
    [2, 3, 0, 1], [3, 0, 1, 2], [1, 2, 3, 0], [0, 1, 2, 3],
    [1, 3, 0, 2], [2, 0, 3, 1], [1, 0, 3, 2], [1, 0, 3, 2],
    [1, 0, 3, 2], [3, 2, 0, 1], [0, 1, 2, 3], [0, 2, 3, 1],
  ];
  for (let f = 113; f <= 2811; f++) {
    assert.equal(d.winner, undefined, 'Toxic race still live at ' + f);
    stepWorld(race, dashRace, [{ ...IDLE, r: f <= 162 }]);
    if (f === 407) assert.deepEqual([d.monS, d.monT, d.blobs.length], [1, 22, 3]);
    if (f === 408) assert.deepEqual(d.random, [2763286833, 2940092012]);
  }
  assert.equal(d.winner, 3);
  assert.deepEqual(d.random, [1978194025, 2805844477]);
  stepDashResult(race, 3);
  assert.deepEqual([d.state[3], d.yaw[3]], [0x62, 479]);
  assert.deepEqual(d.random, [2272954870, 761922852]);
}

// USA Dante versus. Kart 3's respawn sound plays even though the component
// pool cannot fit its burst. Spending the burst's RNG changes the race winner.
{
  const seats = slots.map(s => ({ ...s, bot: s.slot !== 0, level: 1 }));
  const race = createWorld(dashRace, seats, [], 1, 'dante'), d = race.data;
  d.random = [2654384581, 4056746850];
  d.updateOrders = [
    [2, 1, 3, 0], [2, 3, 0, 1], [2, 3, 1, 0], [1, 2, 0, 3],
    [1, 2, 3, 0], [2, 3, 0, 1], [1, 3, 2, 0], [0, 3, 1, 2],
    [2, 3, 0, 1], [2, 0, 3, 1], [2, 0, 1, 3], [2, 3, 0, 1],
    [1, 3, 2, 0], [3, 0, 1, 2], [1, 0, 3, 2], [0, 3, 2, 1],
  ];
  let restored: typeof race | undefined;
  const predictor = new Predictor(dashRace, 0);
  for (let f = 113; f <= 2811; f++) {
    const pads = [{ ...IDLE, r: f <= 162, seq: f }];
    stepWorld(race, dashRace, pads);
    if (restored) stepWorld(restored, dashRace, pads);
    if (f === 1921) {
      const sizes = d.dantePool.free.map((block: number[]) => block[1]);
      assert.equal(Math.max(...sizes), 724);
      restored = JSON.parse(JSON.stringify(race));
      predictor.onSnapshot(structuredClone(restored!), f);
    } else if (f > 1921 && f <= 1926) {
      predictor.push(pads[0]);
      assert.deepEqual(predictor.pred!.data.random, d.random);
      assert.deepEqual(predictor.pred!.data.dantePool, d.dantePool);
    }
    if (f === 1922) assert.ok(race.ev.some(e => e.k === 'fall' && e.s === 3 && e.v === 3));
    if (f === 1923) assert.deepEqual(d.random, [3929204831, 1974997237]);
  }
  assert.equal(d.winner, -1);
  assert.deepEqual(d.lap, [0, 8, 8, 8]);
  assert.deepEqual(d.random, [1235243578, 1619137848]);
  assert.deepEqual(restored!.data.dantePool, d.dantePool);
  assert.deepEqual(restored!.data.random, d.random);
  assert.equal(restored!.data.winner, d.winner);
}

// Dot and Splash shared this dispatch table at their recorded GO checkpoints.
const versusDispatch = [
  [1, 3, 2, 0], [1, 2, 0, 3], [0, 3, 1, 2], [2, 3, 0, 1],
  [2, 3, 0, 1], [1, 3, 0, 2], [0, 2, 3, 1], [2, 1, 3, 0],
  [2, 3, 1, 0], [1, 0, 2, 3], [2, 1, 3, 0], [0, 3, 1, 2],
  [2, 0, 1, 3], [0, 2, 3, 1], [3, 2, 0, 1], [1, 0, 2, 3],
];

// USA Dot finish with an active missile and a CPU winner holding another.
{
  const seats = slots.map(s => ({ ...s, bot: s.slot !== 0, level: 1 }));
  const race = createWorld(dashRace, seats, [], 1, 'dot'), d = race.data;
  d.random = [3248407212, 1060766285];
  d.updateOrders = versusDispatch;
  for (let f = 113; f <= 2194; f++) {
    assert.equal(d.winner, undefined, 'Dot race still live at ' + f);
    stepWorld(race, dashRace, [{ ...IDLE, r: f <= 162 }]);
  }
  assert.equal(d.winner, 3);
  assert.deepEqual(d.mis.map((m: { x: number; z: number }) => [m.x, m.z]), [[1768, -208]]);
  for (const [yaw, x, z, random] of [
    [4049, 1849, -322, [53104885, 4241161141]],
    [4061, 1930, -436, [1607973257, 2453804564]],
    [4069, 2011, -550, [802113954, 449534500]],
  ] as const) {
    stepDashResult(race, 3);
    assert.deepEqual([d.state[3], d.yaw[3]], [0x62, yaw]);
    assert.deepEqual(d.mis.map((m: { x: number; z: number }) => [m.x, m.z]), [[x, z]]);
    assert.deepEqual(d.random, random);
  }
}

// USA Splash versus recording. One human holds the accelerator through frame 162.
// Three Normal CPUs play the race from the recorded GO checkpoint.
{
  const seats = slots.map(s => ({ ...s, bot: s.slot !== 0, level: 1 }));
  const race = createWorld(dashRace, seats, [], 1, 'splash'), d = race.data;
  d.random = [3248407212, 1060766285];
  d.pat = 4;
  d.rot = 3648;
  d.updateOrders = versusDispatch;
  for (let f = 113; f <= 2378; f++) {
    assert.equal(d.first, -1, 'Splash race still live at ' + f);
    stepWorld(race, dashRace, [{ ...IDLE, r: f <= 162 }]);
    if (f === 253) { // Final hop landing while accelerating.
      assert.deepEqual([d.gx[1], d.gz[1], d.vx[1], d.vz[1]], [-1124, 1432, 12419, 9347]);
    }
    if (f === 418) { // Airborne above the spokes alongside the island wall.
      assert.deepEqual([d.gx[2], d.gy[2], d.gz[2]], [-489, 265, -1207]);
    }
    if (f >= 370 && f <= 377) { // The rider holds the impact frame throughout the hit.
      const pose = d.kartPose[0];
      assert.equal(dashKartPose(pose.script, 1, pose.frame), 0x4086);
    }
    if (f === 1423) { // Respawn locks steering for this tick but allows the boost animation.
      const pose = d.kartPose[1];
      assert.equal(dashKartPose(pose.script, 3, pose.frame), 0x4101);
    }
  }
  assert.equal(d.winner, 1);
  assert.deepEqual(d.random, [1373698267, 478405491]);
  stepDashResult(race, 1);
  assert.deepEqual([d.state[1], d.yaw[1], d.gy[1]], [0x62, 382, 60]);
  assert.deepEqual(d.random, [2105800672, 28988337]);
}

// Steering and boost bits read from FUN_800b4708 on the USA course images.
for (const [variant, positions, yaw, vx, vz, steer, boost] of [
  ['dot', [[17, -1517], [-786, -364], [-2079, 1710], [-203, -2359]], 3613, 20356, -29282, -1, true],
  ['toxic', [[-1411, -864], [2264, -1850], [1722, -2328], [-1977, 2124]], 519, 20108, 26111, 1, false],
  ['splash', [[-1312, 1104], [1689, -2391], [-874, 1326], [2244, 627]], 3355, 6560, -25424, -1, true],
  ['dante', [[236, -1803], [2113, -426], [-139, 1852], [2240, -1307]], 2600, -48929, 11300, 0, true],
] as const) {
  const race = fresh(variant), d = race.data;
  d.gx = positions.map(p => p[0]); d.gz = positions.map(p => p[1]);
  d.yaw[0] = yaw; d.vx[0] = vx; d.vz[0] = vz;
  const pad = dashCpuInput(race, 0);
  assert.deepEqual([pad.x, pad.y, pad.a], [steer, -1, boost], variant);
}

// Recorded calls to the USA missile and shield target routines. The next
// random words matter even when the CPU decides to keep the item.
for (const variant of ['dot', 'toxic', 'dante']) {
  for (const [slot, points, heading, words, excluded, fire, next] of [
    [0, [[1165, -1437], [-841, -2003], [636, -1270], [477, -1778]], 724, [1196568003, 3263386598], 1, true, [2482123976, 2939086225]],
    [2, [[2122, -105], [1018, 998], [1006, 1552], [2597, 248]], 3583, [3794536785, 1757493384], 3, false, [2382301639, 2426515850]],
  ] as const) {
    const race = fresh(variant), d = race.data;
    d.gx = points.map(p => p[0]); d.gz = points.map(p => p[1]);
    d.yaw[slot] = heading; d.random = [...words]; d.finish[excluded] = 1;
    d.item[slot] = variant === 'toxic' ? 2 : 1;
    assert.equal(dashCpuInput(race, slot).b, fire);
    assert.deepEqual(d.random, next);
  }
}

// The same four-kart pileup, sampled after one USA player dispatch on each course.
// Rows are [x, z, vx, vz, state, height above ride plane, pitch].
for (const [variant, order, expected] of [
  ['dot', [1, 3, 2, 0], [
    [1710, 320, 15456, 0, 91, 0, 0], [2006, 618, -13152, 30048, 93, 150, 128],
    [1788, -78, -13664, -13920, 91, 0, 0], [2239, 222, 17760, 23136, 93, 150, 128],
  ]],
  ['toxic', [3, 0, 1, 2], [
    [1426, 284, -13664, -13920, 93, 150, 128], [1899, 558, -13152, 30048, 93, 150, 128],
    [1840, 87, 15456, 0, 91, 0, 0], [2218, 42, 17760, 23136, 93, 150, 128],
  ]],
  ['splash', [2, 3, 1, 0], [
    [1598, 482, -13187, 29827, 91, 0, 0], [2108, 464, 17795, 23171, 93, 150, 128],
    [1650, -26, 15616, 0, 93, 150, 128], [1992, -66, -13699, -13955, 91, 0, 0],
  ]],
  ['dante', [2, 1, 0, 3], [
    [1598, 482, -13152, 29792, 91, 0, 0], [2118, 501, 15456, 0, 93, 150, 128],
    [1650, -26, 17920, 23296, 93, 150, 128], [1961, 63, -13664, -13920, 91, 0, 0],
  ]],
] as const) {
  const race = fresh(variant), d = race.data;
  Object.assign(d, {
    gx: [1650, 1910, 1780, 2000], gz: [320, 356, 87, 112],
    vx: [15670, -13720, 17987, -13060], vz: [0, -14000, 23511, 30387],
    updateOrders: [order],
  });
  delete d.pitch; delete d.bank; delete d.hitLock; // Rejoin from the older snapshot format.
  const pred = new Predictor(dashRace, 0);
  pred.onSnapshot(structuredClone(race), 0);
  step(race);
  pred.push({ ...IDLE, seq: 1 });
  assert.deepEqual(pred.pred?.data, d, variant + ' pileup prediction');
  assert.deepEqual(slots.map(({ slot: i }) =>
    [d.gx[i], d.gz[i], d.vx[i], d.vz[i], d.state[i], d.gy[i], d.pitch[i]]), expected, variant);
  const base = variant === 'splash' ? 0x675 : 0x640;
  assert.ok(race.ev.some(e => e.k === 'raceSound' && e.v >= base && e.v < base + 4));
  assert.equal(race.ev.filter(e => e.k === 'raceSound' && e.v === 0x654).length,
    expected.filter(row => row[4] === 93).length);
}

// Steering and acceleration are calculated before the first hit handler
// sets the native input lock. The last drop landing leaves one locked tick.
{
  const race = fresh('dot'), d = race.data;
  d.state[0] = 0x5d; d.cnt[0] = 60; d.vy[0] = -160;
  stepWorld(race, dashRace, [{ ...IDLE, y: -1 }]);
  assert.deepEqual([d.gy[0], d.vz[0], d.hitLock[0]], [150, -768, 1]);
  d.state[0] = 0x61; d.fph[0] = 1; d.gy[0] = 0; d.dvy[0] = 0; d.fl[0] = 1;
  stepWorld(race, dashRace, [{ ...IDLE, y: -1 }]);
  assert.deepEqual([d.state[0], d.hitLock[0]], [0x5b, 1]);
  stepWorld(race, dashRace, [{ ...IDLE, y: -1 }]);
  assert.deepEqual([d.vx[0], d.vz[0]], [0, 0]);
  stepWorld(race, dashRace, [{ ...IDLE, y: -1 }]);
  assert.ok(d.vx[0] || d.vz[0]);
}

// PCSX sound handles for R1, R1+Square, Square, release, and a second R1 press.
for (const { id } of DR_VARIANTS) {
  const race = fresh(id), d = race.data;
  delete d.motors;
  d.fuel[0] = 65536;
  for (let tick = 1; tick <= 62; tick++) {
    d.gx = [1800, -1800, 0, 0]; d.gz = [0, 0, -2000, 2000];
    d.vx.fill(0); d.vz.fill(0);
    const run = (tick >= 6 && tick <= 28) || (tick >= 46 && tick <= 55);
    const boost = tick >= 15 && tick <= 38;
    stepWorld(race, dashRace, [{ ...IDLE, y: run ? -1 : 0, a: boost }]);
    const motor = d.motors?.[0];
    assert.equal(motor?.run ?? -1, run && id !== 'splash' ? (tick < 46 ? 6 : 46) : -1, id);
    assert.equal(motor?.boost ?? -1, boost && id !== 'splash' ? 15 : -1, id);
  }
}

// At the exact center the USA push points along +Z. The stored random timer
// stays fixed even after that many ticks, until the next race rebuilds the course.
const toxic = fresh('toxic'), barrel = toxic.data.bar[9];
toxic.data.gx[0] = barrel.x;
toxic.data.gz[0] = barrel.z;
toxic.data.vx[0] = 3072;
toxic.data.vz[0] = -2304;
step(toxic);
assert.equal(toxic.data.state[0], 0x5d);
assert.deepEqual([toxic.data.vx[0], toxic.data.vz[0]], [864, -608]); // 1/3 transfer, then 160 deceleration
assert.deepEqual([toxic.data.gx[0], toxic.data.gz[0]], [barrel.x + 3, barrel.z + 381]);
assert.equal(toxic.ev.filter(e => e.k === 'barrel' && e.s === 9 && e.v === 1).length, 1);
const stored = barrel.t;
assert.ok(stored >= 180 && stored < 240);
for (let i = 0; i < 260; i++) step(toxic);
assert.equal(barrel.t, stored);
assert.equal(fresh('toxic').data.bar[9].t, 0);

// Advance prediction through delayed snapshots, a disconnected host seat and its return.
for (const { id } of DR_VARIANTS) {
  const race = createWorld(dashRace, slots.map(s => ({ ...s, bot: s.slot >= 2 })), [], 103, id);
  const predictor = new Predictor(dashRace, 0);
  const initial = structuredClone(race.data.gx);
  predictor.onSnapshot(structuredClone(race), 0);
  for (let tick = 1; tick <= 90; tick++) {
    const me = { ...IDLE, seq: tick, y: -1, x: tick < 30 ? 0 : 1 };
    const cpuControl = dashRace.bot!(race, 2);
    const other = tick >= 31 && tick <= 60 ? cpuControl : IDLE;
    stepWorld(race, dashRace, [me, other, cpuControl, cpuControl]);
    predictor.push(me);
    // Control transfers are learned from the authoritative snapshot.
    if (tick % 8 === 0 || tick === 31 || tick === 61) predictor.onSnapshot(structuredClone(race), tick);
    assert.deepEqual(predictor.pred, race, id + ' tick ' + tick);
    assert.equal(race.data.cpuSeats, tick >= 31 && tick <= 60 ? 14 : 12);
  }
  assert.notDeepEqual(race.data.gx.slice(2), initial.slice(2), id);
  // An old in-progress snapshot identifies CPU seats by their last frame stamps.
  const old = structuredClone(race);
  delete old.data.cpuSeats;
  old.data.bf = [0, 0, old.data.f, old.data.f];
  step(old); step(race);
  assert.deepEqual(old.data.gx, race.data.gx);
  assert.deepEqual(old.data.gz, race.data.gz);
  assert.equal(old.data.cpuSeats, race.data.cpuSeats);
}

for (const { id } of DR_VARIANTS) {
  for (const [row, winner] of [[[2, 1, 3, 0], 1], [[2, 0, 3, 1], 0]] as const) {
    const race = fresh(id), d = race.data;
    assert.deepEqual(d.lap, [0, 0, 0, 0]);
    assert.equal(d.winner, undefined);
    d.gx = [1480, 2160, -1550, -2200];
    d.gz[2] = 900; d.gz[3] = -850;
    d.gz[0] = d.gz[1] = -443;
    d.lap[0] = d.lap[1] = 9;
    d.c148[0] = d.c148[1] = 1;
    d.vz[0] = d.vz[1] = -80 * 256;
    // Fix the deciding row independently of any barrel contacts earlier in the update.
    d.updateOrders = Array.from({ length: 16 }, () => [...row]);
    race.bodies.reverse();

    const predictor = new Predictor(dashRace, winner);
    predictor.onSnapshot(JSON.parse(JSON.stringify(race)), 0);
    predictor.push({ ...IDLE, seq: 1 });
    step(race);
    assert.equal(predictor.pred?.data.winner, winner, id);
    assert.deepEqual(predictor.pred?.data, d, id);
    assert.equal(roundOver(dashRace, race), true, id);
    assert.deepEqual(d.lap.slice(0, 2), winner === 0 ? [10, 9] : [9, 10], id);
    assert.equal(d.gz[1 - winner], -443, id);
    assert.deepEqual(race.ev.filter(e => e.k === 'lap' || e.k === 'finish').map(e => [e.k, e.s]), [['lap', winner], ['finish', winner]], id);
    assert.equal(dashRace.placements(race)[0], winner, id);
    assert.equal(dashRace.isDraw!(race, dashRace.placements(race)), false, id);

    race.finished = true;
    const terminal = JSON.parse(JSON.stringify(race));
    predictor.onSnapshot(terminal, 0); // Pending local input survives the terminal snapshot.
    assert.deepEqual(predictor.pred?.data, terminal.data, id);
    const result = structuredClone(terminal);
    stepDashResult(result, winner);
    assert.equal(result.data.state[winner], 0x62, id);
    assert.equal(result.data.vz[winner], 0, id);
    assert.equal(result.data.gz[winner], d.gz[winner], id);
  }

  const draw = fresh(id);
  draw.tick = 2697;
  draw.time = draw.tick / 30;
  draw.data.lap[1] = draw.data.lap[3] = 7;
  step(draw);
  assert.equal(roundOver(dashRace, draw), false, id);
  const lastLap = structuredClone(draw);
  lastLap.data.lap.fill(0);
  lastLap.data.gx[0] = 1600;
  lastLap.data.gz[0] = -475;
  lastLap.data.c148[0] = 1;
  lastLap.data.vz[0] = -80 * 256;
  step(lastLap);
  assert.deepEqual([lastLap.data.lap[0], lastLap.data.winner], [1, 0], id + ' crossing at timeout');
  step(draw);
  assert.equal(draw.tick, 2699, id);
  assert.equal(roundOver(dashRace, draw), true, id);
  assert.equal(dashRace.isDraw!(draw, dashRace.placements(draw)), true, id);
  assert.equal(draw.data.winner, -1, id);
  stepDashResult(draw, undefined);
  assert.equal(draw.data.state.includes(0x62), false, id);
}

// FUN_800bf460, Dot USA capture. The launch hangs at kart height + 128 for
// one tick, then the missile moves on a line and reflects using groups 0/2.
for (const [x, z, yaw, frames] of [
  [1750, 100, 256, { 1: [1750, -384, 100, 256], 2: [1697, -256, -29, 256], 5: [1538, -256, -416, 256] }],
  [2160, 250, 3072, { 1: [2160, -384, 250, 3072], 3: [2421, -256, 245, 708], 15: [1020, -256, -508, 2936] }],
] as const) {
  const race = fresh('dot'), d = race.data;
  d.gx = [x, -1500, -1500, -1500]; d.gz = [z, 1080, 1660, 2240];
  d.yaw.fill(yaw); d.tgt.fill(yaw); d.item[0] = 1;
  for (let tick = 1; tick <= 40; tick++) {
    stepWorld(race, dashRace, [tick === 1 ? { ...IDLE, b: true } : IDLE]);
    const expected = (frames as Record<number, readonly number[]>)[tick];
    if (expected) assert.deepEqual(native(race.bodies.find(b => b.kind === 'missile')!), expected);
  }
  assert.equal(race.bodies.some(b => b.kind === 'missile'), false);
}

// Dot frame 1391. This shallow reflection leaves heading 74 and lasts 21 more ticks.
{
  const race = fresh('dot'), d = race.data;
  d.gx = [-1900, -1800, -1600, -1700]; d.gz = [-1300, -400, 600, 1500];
  d.mis.push({ id: race.nextId++, owner: 2, x: 1066, y: -256, z: 2893, yaw: 2692, bounces: 1, age: 53 });
  step(race);
  const missile = d.mis[0];
  assert.deepEqual([missile.x, missile.z, missile.yaw], [1118, 2866, 74]);
  for (let i = 0; i < 20; i++) step(race);
  assert.deepEqual([d.mis[0].x, d.mis[0].z], [818, 86]);
  step(race);
  assert.equal(d.mis.length, 0);
}

// Toxic frame 686. A driver can land outside the course and enter fall again on that tick.
{
  const race = fresh('toxic'), d = race.data;
  d.gx[2] = 2793; d.gz[2] = 1461; d.state[2] = 0x61; d.fph[2] = 1; d.fl[2] = 1;
  step(race);
  assert.deepEqual([d.state[2], d.fph[2], d.fc[2]], [0x61, 0, 0]);
  assert.ok(race.ev.some(e => e.k === 'fall' && e.s === 2 && e.v === 1));
}

// The USA road item checks the held button. Its marker takes the pre-move
// pose on the release tick. A missile takes its first flight step from the
// moving kart on the following tick, while the Toxic ring starts its cue.
for (const variant of ['dot', 'toxic', 'dante']) {
  const race = fresh(variant), d = race.data;
  d.pre = -1; d.cdC = 30; delete d.itemMarkers; // Load a snapshot from before markers were serialized.
  d.gx[0] = 1900; d.gz[0] = 750;
  if (variant === 'toxic') { d.gx[1] = 2270; d.gz[1] = 1160; }
  d.item[0] = variant === 'toxic' ? 2 : 1;
  d.prevB[0] = true; d.vz[0] = -50 * 256;
  const pad = { ...IDLE, y: -1, b: true };
  stepWorld(race, dashRace, [pad]);
  const ride = variant === 'dante' ? 180 : 256;
  assert.deepEqual(d.itemMarkers[0], { item: variant === 'toxic' ? 2 : 1, yaw: 128, x: 1900, y: ride + 512, z: 750 });
  assert.equal(d.item[0], 0);
  if (variant !== 'toxic') assert.deepEqual(native(race.bodies.find(b => b.kind === 'missile')!), [1900, -ride - 128, 750, 0]);
  const rejoined = structuredClone(race);
  stepWorld(race, dashRace, [pad]);
  stepWorld(rejoined, dashRace, [pad]);
  assert.deepEqual(rejoined, race);
  assert.equal(d.itemMarkers[0].item, 0);
  if (variant === 'toxic') {
    const ring = race.ev.find(e => e.k === 'shield' && e.t === 1);
    assert.ok(ring);
    assert.deepEqual([ring.x, ring.y, ring.z], [1900 * U, 160 * U, -750 * U]);
    assert.deepEqual([d.vx[1], d.vz[1]], [0, 0]);
    stepWorld(race, dashRace, [pad]);
    assert.deepEqual([d.vx[1], d.vz[1]], [21968, 24312]);
  } else if (variant === 'dot') {
    assert.deepEqual(native(race.bodies.find(b => b.kind === 'missile')!), [1900, -ride, 501, 0]);
  }
}

const splash = fresh('splash');
const sd = splash.data;
sd.state[0] = 0x5e; sd.vy[0] = -0x44;
const heights: number[] = [];
while (sd.state[0] !== 0x62 && heights.length < 60) {
  stepDashResult(splash, 0);
  heights.push(sd.gy[0]);
}
assert.equal(sd.state[0], 0x62);
assert.deepEqual(heights.slice(0, 3), [63, 121, 174]);
assert.equal(sd.hopBounce[0], true);

// FUN_800bfd84 advances the pickup flip-book every tick. Only Splash skips
// the launch and gravity, so its fruit stays at Y=0.
for (const [variant, expected] of [['dot', [30, 58, 84, 108]], ['splash', [0, 0, 0, 0]]] as const) {
  const race = fresh(variant);
  let fruit: Body | undefined;
  for (let tick = 0; tick < 180 && !fruit; tick++) {
    step(race);
    fruit = race.bodies.find(b => b.kind === 'fruit');
  }
  assert.ok(fruit);
  const heights = [Math.round(fruit.y / U)];
  for (let tick = 1; tick <= 3; tick++) {
    step(race);
    assert.equal(fruit.cd, tick + 1);
    heights.push(Math.round(fruit.y / U));
  }
  assert.deepEqual(heights, expected);
}

const dot = fresh('dot');
const p = dot.bodies[0];
p.x = 1350 * U; p.z = 370 * U;
const camera = new FitCam(LEVEL_CAMS[23]);
for (let i = 0; i < 30; i++) fitDashResult(camera, dot, 0);
assert.deepEqual([camera.c.x, camera.c.y, camera.c.z], [-1172, -130, 3240]);
assert.equal(dashCheerPose('dot', 8, 8), 0x4201);
assert.equal(dashCheerPose('splash', 1, 12), 0x4181);
for (const { char } of slots.slice(0, 2)) {
  assert.equal(dashCheerPose('splash', DISC_CHARACTER[char], 12 + 37), 0x4181);
}
console.log('Crash Dash kart contacts, engine loops, CPU steering and prediction, Toxic barrel impacts, finishes, Splash hop, result camera and missile traces passed');
