// Run with npx tsx scripts/test-ring-ding-cpu.ts from web/.
import assert from 'node:assert/strict';
import { Predictor } from '../client/predict';
import { ringDing, type RingDingData } from '../shared/games/ringDing';
import { addBody } from '../shared/physics';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE, type Input, type World } from '../shared/types';

function room(level: number, mixed: boolean, seed = 432) {
  const slots = [0, 1, 2, 3].map((slot) => ({
    slot, level, char: [0, 1, 4, 5][slot], name: String(slot), bot: !mixed || slot !== 3,
  }));
  return createWorld(ringDing, slots, [], seed);
}

function controlled(level: number, mixed: boolean, seed?: number) {
  const w = room(level, mixed, seed);
  const d = w.data as RingDingData;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  d.tb = d.tk = d.tc = 10000;
  d.cpuRng = [944, 170]; // FUN_80015590 seed words at 0x800517b8.
  const positions = [[0, 0], [350, 0], [1500, -1000], [-1600, 950]];
  d.P.forEach((p, slot) => {
    [p!.x, p!.z] = positions[slot];
    p!.face = Math.PI / 2;
    p!.cpuYaw = 3072;
  });
  const player = d.P[0]!;
  const ai = player.cpu!;
  ai.timer = 0;
  ai.cooldown = 55;
  return { w, d, player, ai };
}

function balloon(w: World, d: RingDingData, x: number, z: number, owner: number, hy = 1600) {
  const bid = addBody(w, 'balloon', owner, 0, 0, 1, 1).id;
  d.B.push({ bid, x, z, hy, ty: owner === -1 ? 12 : owner === 0 ? 11 : 8, ow: owner,
    angle: 0, dr: 0, da: 0, po: 0, pa: 0, st: 1, tf: false, tc: -1, ot: 0 });
  return bid;
}

function crate(w: World, d: RingDingData, x: number, z: number) {
  const bid = addBody(w, 'crate', -1, 0, 0, 1, 1).id;
  d.C.push({ bid, x, z, st: 1, g: 4096, tf: false, tc: -1, item: 19 });
  return bid;
}

// Drive one CPU through the real step while the other pads stay neutral.
const tick = (w: World) => stepWorld(w, ringDing, [null, IDLE, IDLE, IDLE]);

for (const level of [0, 1, 2]) for (const mixed of [true, false]) {
  // L27 MIPS pad traces. The high own balloon is selected before it gets into pop range.
  {
    const { w, d, player, ai } = controlled(level, mixed);
    const own = balloon(w, d, 800, 35, 0);
    assert.equal(player.skill, [12, 20, 24][level]);
    tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad, ai.timer], [own, 2, 0, [21, 13, 9][level]]);
    Object.assign(d.B[0], { x: 800, z: 35 }); // Keep the native replay's fixed target origin.
    tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad, ai.heading, ai.timer],
      [own, 13, level === 0 ? 0x4030 : 0x4020, [960, 1105, 1052][level], 8]);
    assert.equal(player.ph, 0);
    tick(w);
    assert.equal(player.ph, 1);
    assert.equal(w.ev.filter(e => e.k === 'jump' && e.s === 0).length, 1);
    d.B.length = 0;
    tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad], [0, 1, 0]);
  }
  {
    const { w, d, ai } = controlled(level, mixed);
    d.rc = 82; d.rcO = 0;
    balloon(w, d, 480, 0, 1, 800);
    const own = balloon(w, d, 800, 35, 0);
    tick(w); tick(w);
    // Even during its own recolour, this CPU does not jump at the closer foreign balloon.
    assert.deepEqual([ai.target, ai.mode, ai.pad], [own, 2, level === 0 ? 0x30 : 0x20]);
  }
  {
    const { w, d, ai } = controlled(level, mixed);
    d.rc = 81; d.rcO = 1;
    balloon(w, d, 800, 35, 0);
    balloon(w, d, 480, 0, 1, 800);
    const black = balloon(w, d, 500, 400, -1);
    tick(w); tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad], [black, 2, level === 0 ? 0x10 : 0x30]);
  }
  {
    const { w, d, ai } = controlled(level, mixed);
    const black = balloon(w, d, 500, 400, -1);
    tick(w);
    Object.assign(d.B[0], { x: 500, z: 400 });
    tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad, ai.heading, ai.timer],
      [black, 13, level === 0 ? 0x4010 : 0x4030, [472, 667, 554][level], [20, 12, 8][level]]);
  }
  {
    const { w, d, player, ai } = controlled(level, mixed);
    const box = crate(w, d, 480, 0);
    tick(w); tick(w);
    assert.deepEqual([ai.target, ai.mode, ai.pad, ai.heading],
      [box, 2, level === 0 ? 0x8030 : 0x8020, [967, 1214, 1138][level]]);
    tick(w);
    assert.equal(player.st, 1);
  }
  {
    const { w, d, ai } = controlled(level, mixed);
    d.P[3]!.x = 200; d.P[3]!.z = 0;
    d.P[3]!.pu = 23; d.P[3]!.put = 60;
    balloon(w, d, 800, 35, 0);
    ai.mode = 3; ai.rival = 3;
    tick(w);
    // Point-blank rival and balloon can request both buttons. Square wins the action.
    assert.equal(ai.pad, [0xc010, 0xc020, 0xc030][level]);
    tick(w);
    assert.equal(d.P[0]!.st, 1);
    assert.equal(d.P[0]!.ph, 0);
  }
  for (const dir of [1, -1]) {
    const { w, d, player, ai } = controlled(level, mixed);
    Object.assign(player, { x: 950, cpuYaw: 2048, face: -Math.PI });
    d.dir = dir; d.rs = -dir;
    ai.target = balloon(w, d, 350, 1800, 0, 1000);
    ai.mode = 2;
    tick(w);
    assert.equal(ai.heading, (dir === 1 ? [3406, 3539, 3701] : [3902, 3845, 3913])[level]);
  }
  {
    const { w, d, player, ai } = controlled(level, mixed);
    [[2160, 100], [1650, -1500], [-2000, 300]].forEach(([x, z], i) => Object.assign(d.P[i+1]!, { x, z }));
    ai.cooldown = 0;
    balloon(w, d, 800, 35, 0);
    tick(w);
    assert.deepEqual([ai.mode, ai.rival, ai.pad, ai.taunt], [21, 3, 0x1000, [600, 840, 960][level]]);
    tick(w);
    assert.equal(player.tauntAt, 1);
  }
}

// A CPU sees an earlier human seat's move on the same update. Its new pad
// remains latched for the following update, including across a snapshot.
for (const [seed, spin] of [[0, false], [432, true]] as const) {
  const { w, d, player, ai } = controlled(1, true, seed);
  Object.assign(d.P[1]!, { x: 1500, z: 500 });
  Object.assign(d.P[3]!, { x: 280, z: 0 });
  Object.assign(ai, { rival: 3, mode: 3 });
  stepWorld(w, ringDing, [null, IDLE, IDLE, { ...IDLE, x: -1 }]);
  assert.equal(d.P[3]!.x, 230);
  assert.equal((ai.pad & 0x8000) !== 0, spin);
  assert.equal(player.st, 0);
  const resumed = cloneWorld(w);
  tick(w);
  tick(resumed);
  assert.equal(player.st, spin ? 1 : 0);
  assert.deepEqual(resumed, w);
}

{
  const { w, d, ai } = controlled(1, true);
  balloon(w, d, 800, 35, 0);
  const newest = balloon(w, d, 800, 35, 0);
  tick(w);
  assert.equal(ai.target, newest); // Equal-distance objects are sampled newest first.
}

const wire = (w: World): World => JSON.parse(JSON.stringify(w, (_, v: unknown) =>
  typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
const humanPad = (seq: number): Input => ({ seq, x: 0, y: seq % 60 < 15 ? 1 : 0, a: seq % 31 < 2, b: false });

for (const level of [0, 1, 2]) for (const mixed of [true, false]) for (const mirror of [true, false]) {
  const w = room(level, mixed);
  w.params.mirror = mirror;
  const pads = (world: World, i: Input) => [0, 1, 2, 3].map(s => {
    if (mixed && s === 3) return i;
    const input = ringDing.bot!(world, s);
    return mirror ? { ...input, x: -input.x, y: -input.y } : input;
  });
  for (let seq = 1; seq <= 480; seq++) stepWorld(w, ringDing, pads(w, humanPad(seq)));
  const snapshot = wire(w);
  const auth = cloneWorld(snapshot);
  const pred = new Predictor(ringDing, mixed ? 3 : null);
  pred.onSnapshot(snapshot, 480);
  for (let seq = 481; seq <= 500; seq++) {
    const input = humanPad(seq);
    stepWorld(auth, ringDing, pads(auth, input));
    pred.push(input);
  }
  pred.onSnapshot(snapshot, 480);
  assert.deepEqual(pred.pred, auth);
  assert.deepEqual(snapshot, wire(w));
}

{
  const w = room(1, true);
  const before = cloneWorld(w);
  const fallback = ringDing.bot!(w, 3);
  assert.deepEqual(w, before);
  stepWorld(w, ringDing, [null, null, null, fallback]);
  assert.equal(w.data.P[3].cpuFallback, true);
  const copy = wire(w);
  const host = cloneWorld(copy);
  stepWorld(host, ringDing, [null, null, null, fallback]);
  stepWorld(copy, ringDing, []);
  assert.deepEqual(host, copy);
  stepWorld(w, ringDing, [null, null, null, { ...IDLE, a: true }]);
  assert.equal(w.data.P[3].cpuFallback, undefined);
  assert.equal(w.data.P[3].ph, 1);
}

{
  const oldSnapshot = wire(room(1, true));
  const d = oldSnapshot.data as RingDingData;
  delete d.cpuRng;
  delete d.updateOrders;
  delete d.random;
  for (const p of d.P) { delete p?.cpu; delete p?.cpuYaw; }
  const replay = cloneWorld(oldSnapshot);
  stepWorld(oldSnapshot, ringDing, []);
  stepWorld(replay, ringDing, []);
  assert.deepEqual(replay, oldSnapshot);
  const restored = oldSnapshot.data as RingDingData;
  assert.ok(restored.cpuRng && restored.P[0]?.cpu && restored.P[1]?.cpu && restored.P[2]?.cpu);
  assert.equal(restored.updateOrders?.length, 16);
  assert.equal(restored.random?.length, 2);
}

console.log('PASS Ring Ding native pads and snapshot replay');
