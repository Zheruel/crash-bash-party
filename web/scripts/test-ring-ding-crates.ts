// Run with npx tsx scripts/test-ring-ding-crates.ts from web/.
import assert from 'node:assert/strict';
import { createRingDingResult, ddHeldItem, DD_S, DD_TICKS, ringDing, type DDCrate, type RingDingData } from '../shared/games/ringDing';
import { addBody, rand } from '../shared/physics';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

const ANGLE = Math.PI / 2048;
const ROSTER = [6, 1, 4, 3];
const IDLES = [IDLE, IDLE, IDLE, IDLE];
const HOVER = 0x13, MAGNET = 0x17;

function room(chars = ROSTER) {
  const w = createWorld(ringDing, chars.map((char, slot) => ({ char, slot, bot: false })), [], 123);
  const d = w.data as RingDingData;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  d.tc = d.tb = d.tk = 10000;
  d.rs = 13;
  for (const [slot, p] of d.P.entries()) {
    Object.assign(p!, { x: [-1650, 0, 1550, 0][slot], z: [-500, -1700, 350, 1650][slot], face: 0, heading: 0 });
  }
  return { w, d };
}

function addCrate(w: World, d: RingDingData, state: number, slot: number, x: number, z: number, height = 0): DDCrate {
  const body = addBody(w, state === 13 ? 'item' : 'crate', -1, x * DD_S, -z * DD_S, 0.7, 1);
  const crate = { bid: body.id, x, z, st: state, tf: false, tc: state === 1 ? -1 : slot, g: state === 13 ? height : 0x1000, yaw: 416, item: HOVER };
  d.C.push(crate);
  return crate;
}

function setRoll(w: World, result: number, beforeBreak = false) {
  // The fixture controls the roll while exercising the shipped crate RNG call and threshold.
  for (let seed = 1; seed < 1000; seed++) {
    const stream = { rng: seed } as World;
    if (beforeBreak) rand(stream);
    if (Math.floor(rand(stream) * 32) === result) { w.rng = seed; return; }
  }
  assert.fail('no fixture seed');
}

function snapshot(w: World): World { return JSON.parse(JSON.stringify(w)); }

type Frame = [frame: number, state: number, x: number, height: number, z: number, yaw: number, remaining: number, heldHeight: number];
interface Trace {
  name: string;
  slot: number;
  start: [number, number, number];
  item: number;
  gain: number;
  frames: Frame[];
  terminal?: 'draw' | 'win' | 'lose';
  input?: 'spin' | 'jump' | 'move';
  ring?: [number, number];
}

// Consecutive logic frames from USA L27 in PCSX ReARMed, sampled throughout each flight.
// A state of -1 means the native render flag cleared. Heights are measured above y = -16.
const traces: Trace[] = [
  { name: 'ordinary-0', slot: 0, start: [1, 205, 30], item: 19, gain: 34, input: 'spin', frames: [
    [1, 1, 205, 0, 30, 416, 0, -1],
    [2, 9, 205, 0, 30, 416, 0, -1],
    [3, 12, 205, 0, 30, 416, 0, -1],
    [4, 13, 205, 0, 30, 416, 0, -1],
    [8, 13, 205, 344, 30, 868, 0, -1],
    [16, 13, 205, 840, 30, 1772, 0, -1],
    [23, 13, 205, 1064, 30, 2563, 0, -1],
    [24, 13, 205, 1080, 30, 2676, 0, -1],
    [25, 13, 205, 1092, 30, 2789, 0, -1],
    [27, 13, 205, 1104, 30, 3015, 0, -1],
    [28, 13, 205, 1104, 30, 3128, 0, -1],
    [29, 13, 191, 990, 18, 3241, 0, -1],
    [30, 13, 180, 900, 9, 3354, 0, -1],
    [31, 13, 172, 828, 2, 3467, 0, -1],
    [32, 13, 167, 769, -3, 3580, 0, -1],
    [33, 13, 163, 721, -7, 3693, 0, -1],
    [34, -1, 160, 682, -10, 3806, 240, -1],
    [35, -1, 160, 682, -10, 3806, 239, 730],
    [36, -1, 160, 682, -10, 3806, 238, 733],
    [37, -1, 160, 682, -10, 3806, 237, 736],
  ] },
  { name: 'flight-1-magnet', slot: 1, start: [12, 430, 30], item: 23, gain: 32, frames: [
    [1, 13, 430, 0, 30, 416, 0, -1],
    [2, 13, 430, 92, 30, 529, 0, -1],
    [3, 13, 430, 180, 30, 642, 0, -1],
    [4, 13, 430, 264, 30, 755, 0, -1],
    [8, 13, 430, 560, 30, 1207, 0, -1],
    [16, 13, 430, 960, 30, 2111, 0, -1],
    [23, 13, 430, 1100, 30, 2902, 0, -1],
    [24, 13, 430, 1104, 30, 3015, 0, -1],
    [25, 13, 430, 1104, 30, 3128, 0, -1],
    [26, 13, 328, 965, 24, 3241, 0, -1],
    [27, 13, 251, 857, 19, 3354, 0, -1],
    [28, 13, 194, 772, 16, 3467, 0, -1],
    [29, 13, 151, 704, 13, 3580, 0, -1],
    [30, 13, 119, 649, 11, 3693, 0, -1],
    [31, 13, 95, 603, 10, 3806, 0, -1],
    [32, -1, 77, 565, 9, 3919, 300, -1],
    [33, -1, 77, 565, 9, 3919, 299, 627],
    [34, -1, 77, 565, 9, 3919, 298, 626],
    [35, -1, 77, 565, 9, 3919, 297, 626],
  ] },
  { name: 'far-2-hover', slot: 2, start: [12, 1800, 30], item: 19, gain: 34, ring: [1024, 1800], frames: [
    [1, 13, 1799, 0, -37, 429, 0, -1],
    [2, 13, 1798, 92, -72, 555, 0, -1],
    [3, 13, 1798, 180, -72, 668, 0, -1],
    [4, 13, 1798, 264, -72, 781, 0, -1],
    [8, 13, 1798, 560, -72, 1233, 0, -1],
    [16, 13, 1798, 960, -72, 2137, 0, -1],
    [23, 13, 1798, 1100, -72, 2928, 0, -1],
    [24, 13, 1798, 1104, -72, 3041, 0, -1],
    [25, 13, 1798, 1104, -72, 3154, 0, -1],
    [27, 13, 1049, 820, -38, 3380, 0, -1],
    [28, 13, 809, 723, -27, 3493, 0, -1],
    [29, 13, 629, 646, -19, 3606, 0, -1],
    [30, 13, 495, 584, -13, 3719, 0, -1],
    [31, 13, 394, 534, -8, 3832, 0, -1],
    [32, 13, 319, 493, -5, 3945, 0, -1],
    [33, 13, 263, 458, -3, 4058, 0, -1],
    [34, -1, 221, 428, -1, 75, 240, -1],
    [35, -1, 221, 428, -1, 75, 239, 547],
    [36, -1, 221, 428, -1, 75, 238, 546],
    [37, -1, 221, 428, -1, 75, 237, 546],
  ] },
  { name: 'flight-3-magnet', slot: 3, start: [12, 430, 30], item: 23, gain: 31, frames: [
    [1, 13, 430, 0, 30, 416, 0, -1],
    [2, 13, 430, 92, 30, 529, 0, -1],
    [3, 13, 430, 180, 30, 642, 0, -1],
    [4, 13, 430, 264, 30, 755, 0, -1],
    [8, 13, 430, 560, 30, 1207, 0, -1],
    [16, 13, 430, 960, 30, 2111, 0, -1],
    [23, 13, 430, 1100, 30, 2902, 0, -1],
    [24, 13, 430, 1104, 30, 3015, 0, -1],
    [25, 13, 430, 1104, 30, 3128, 0, -1],
    [26, 13, 345, 985, 23, 3241, 0, -1],
    [27, 13, 281, 892, 17, 3354, 0, -1],
    [28, 13, 233, 819, 13, 3467, 0, -1],
    [29, 13, 197, 761, 10, 3580, 0, -1],
    [30, 13, 170, 714, 8, 3693, 0, -1],
    [31, -1, 149, 675, 6, 3806, 300, -1],
    [32, -1, 149, 675, 6, 3806, 299, 723],
    [33, -1, 149, 675, 6, 3806, 298, 725],
    [34, -1, 149, 675, 6, 3806, 297, 728],
  ] },
  { name: 'jump-1-magnet', slot: 1, start: [12, 430, 30], item: 23, gain: 30, input: 'jump', frames: [
    [1, 13, 430, 0, 30, 416, 0, -1],
    [2, 13, 430, 92, 30, 529, 0, -1],
    [3, 13, 430, 180, 30, 642, 0, -1],
    [4, 13, 430, 264, 30, 755, 0, -1],
    [8, 13, 430, 560, 30, 1207, 0, -1],
    [16, 13, 430, 960, 30, 2111, 0, -1],
    [23, 13, 430, 1100, 30, 2902, 0, -1],
    [24, 13, 430, 1104, 30, 3015, 0, -1],
    [25, 13, 430, 1104, 30, 3128, 0, -1],
    [26, 13, 323, 954, 23, 3241, 0, -1],
    [27, 13, 243, 816, 18, 3354, 0, -1],
    [28, 13, 183, 686, 14, 3467, 0, -1],
    [29, 13, 157, 634, 12, 3580, 0, -1],
    [30, -1, 149, 583, 10, 3693, 300, -1],
    [31, -1, 149, 583, 10, 3693, 299, 563],
    [32, -1, 149, 583, 10, 3693, 298, 550],
    [33, -1, 149, 583, 10, 3693, 297, 537],
  ] },
  { name: 'moving-0-magnet', slot: 0, start: [12, 430, 30], item: 23, gain: 31, input: 'move', frames: [
    [1, 13, 430, 0, 30, 416, 0, -1],
    [2, 13, 430, 92, 30, 529, 0, -1],
    [3, 13, 430, 180, 30, 642, 0, -1],
    [4, 13, 430, 264, 30, 755, 0, -1],
    [8, 13, 430, 560, 30, 1207, 0, -1],
    [16, 13, 430, 960, 30, 2111, 0, -1],
    [23, 13, 430, 1100, 30, 2902, 0, -1],
    [24, 13, 430, 1104, 30, 3015, 0, -1],
    [25, 13, 430, 1104, 30, 3128, 0, -1],
    [26, 13, 573, 994, -3, 3241, 0, -1],
    [27, 13, 681, 907, -27, 3354, 0, -1],
    [28, 13, 762, 837, -45, 3467, 0, -1],
    [29, 13, 823, 780, -59, 3580, 0, -1],
    [30, 13, 869, 732, -69, 3693, 0, -1],
    [31, -1, 903, 691, -77, 3806, 300, -1],
    [32, -1, 903, 691, -77, 3806, 299, 728],
    [33, -1, 903, 691, -77, 3806, 298, 725],
    [34, -1, 903, 691, -77, 3806, 297, 722],
  ] },
  { name: 'draw-2-magnet', slot: 2, start: [13, 430, 30], item: 23, gain: 31, terminal: 'draw', frames: [
    [1, 13, 430, 92, 30, 529, 0, -1],
    [2, 13, 430, 180, 30, 642, 0, -1],
    [3, 13, 430, 264, 30, 755, 0, -1],
    [4, 13, 430, 344, 30, 868, 0, -1],
    [8, 13, 430, 624, 30, 1320, 0, -1],
    [16, 13, 430, 992, 30, 2224, 0, -1],
    [23, 13, 430, 1104, 30, 3015, 0, -1],
    [24, 13, 430, 1104, 30, 3128, 0, -1],
    [25, 13, 344, 944, 24, 3241, 0, -1],
    [26, 13, 280, 820, 19, 3354, 0, -1],
    [27, 13, 232, 723, 16, 3467, 0, -1],
    [28, 13, 197, 646, 13, 3580, 0, -1],
    [29, 13, 171, 584, 11, 3693, 0, -1],
    [30, 13, 151, 534, 10, 3806, 0, -1],
    [31, -1, 137, 493, 9, 3919, 300, -1],
    [32, -1, 137, 493, 9, 3919, 299, 547],
    [33, -1, 137, 493, 9, 3919, 298, 547],
    [34, -1, 137, 493, 9, 3919, 297, 547],
  ] },
  { name: 'win-2-hover', slot: 2, start: [13, 430, 30], item: 19, gain: 28, terminal: 'win', frames: [
    [1, 13, 430, 92, 30, 529, 0, -1],
    [2, 13, 430, 180, 30, 642, 0, -1],
    [3, 13, 430, 264, 30, 755, 0, -1],
    [4, 13, 430, 344, 30, 868, 0, -1],
    [8, 13, 430, 624, 30, 1320, 0, -1],
    [16, 13, 430, 992, 30, 2224, 0, -1],
    [21, 13, 430, 1092, 30, 2789, 0, -1],
    [22, 13, 430, 1100, 30, 2902, 0, -1],
    [23, 13, 430, 1104, 30, 3015, 0, -1],
    [24, 13, 430, 1104, 30, 3128, 0, -1],
    [25, 13, 297, 940, -2, 3241, 0, -1],
    [26, 13, 195, 812, -27, 3354, 0, -1],
    [27, 13, 111, 707, -46, 3467, 0, -1],
    [28, -1, 39, 859, -62, 3580, 240, -1],
    [29, -1, 39, 859, -62, 3580, 239, 531],
    [30, -1, 39, 859, -62, 3580, 238, 579],
    [31, -1, 39, 859, -62, 3580, 237, 590],
  ] },
  { name: 'lose-2-magnet', slot: 2, start: [13, 430, 30], item: 23, gain: 28, terminal: 'lose', frames: [
    [1, 13, 430, 92, 30, 529, 0, -1],
    [2, 13, 430, 180, 30, 642, 0, -1],
    [3, 13, 430, 264, 30, 755, 0, -1],
    [4, 13, 430, 344, 30, 868, 0, -1],
    [8, 13, 430, 624, 30, 1320, 0, -1],
    [16, 13, 430, 992, 30, 2224, 0, -1],
    [21, 13, 430, 1092, 30, 2789, 0, -1],
    [22, 13, 430, 1100, 30, 2902, 0, -1],
    [23, 13, 430, 1104, 30, 3015, 0, -1],
    [24, 13, 430, 1104, 30, 3128, 0, -1],
    [25, 13, 332, 876, 23, 3241, 0, -1],
    [26, 13, 258, 698, 18, 3354, 0, -1],
    [27, 13, 202, 558, 14, 3467, 0, -1],
    [28, -1, 160, 446, 11, 3580, 300, -1],
    [29, -1, 160, 446, 11, 3580, 299, 230],
    [30, -1, 160, 446, 11, 3580, 298, 219],
    [31, -1, 160, 446, 11, 3580, 297, 208],
  ] },
  { name: 'terminalhit-2-hover', slot: 2, start: [12, 430, 30], item: 19, gain: 32, terminal: 'draw', frames: [
    [1, 13, 430, 0, 30, 416, 0, -1],
    [2, 13, 430, 92, 30, 529, 0, -1],
    [3, 13, 430, 180, 30, 642, 0, -1],
    [4, 13, 430, 264, 30, 755, 0, -1],
    [8, 13, 430, 560, 30, 1207, 0, -1],
    [16, 13, 430, 960, 30, 2111, 0, -1],
    [23, 13, 430, 1100, 30, 2902, 0, -1],
    [24, 13, 430, 1104, 30, 3015, 0, -1],
    [25, 13, 430, 1104, 30, 3128, 0, -1],
    [26, 13, 344, 944, 24, 3241, 0, -1],
    [27, 13, 280, 820, 19, 3354, 0, -1],
    [28, 13, 233, 723, 16, 3467, 0, -1],
    [29, 13, 198, 646, 13, 3580, 0, -1],
    [30, 13, 172, 585, 11, 3693, 0, -1],
    [31, 13, 152, 535, 10, 3806, 0, -1],
    [32, -1, 138, 494, 9, 3919, 240, -1],
    [33, -1, 138, 494, 9, 3919, 239, 547],
    [34, -1, 138, 494, 9, 3919, 238, 547],
    [35, -1, 138, 494, 9, 3919, 237, 546],
  ] },
];
for (const trace of traces) {
  const { w, d } = room();
  const { slot, item, terminal, name } = trace;
  Object.assign(d.P[slot]!, { x: 0, z: 0, face: -3072 * ANGLE, heading: 3072 });
  const [state, x, z] = trace.start;
  const crate = addCrate(w, d, state, slot, x, z);
  if (state === 13) {
    crate.item = item;
    crate.flight = { speed: 96, rising: true };
  }
  if (trace.ring) [crate.ringAngle, crate.ringRadius] = trace.ring;
  setRoll(w, item === HOVER ? 31 : 0, state === 1 || state === 9);
  if (terminal) {
    d.itemActors = d.P.map(() => ({ script: 1, frame: 0, yaw: 0, offset: 0, visible: false }));
    d.t = w.tick = DD_TICKS;
    d.draw = terminal === 'draw';
    d.winner = terminal === 'win' ? slot : terminal === 'lose' ? (slot + 1) % 4 : -1;
  }
  const winner = d.winner < 0 ? undefined : d.winner;
  const initial = snapshot(w);
  const result = terminal && createRingDingResult(w, winner);
  const resumedResult = terminal && createRingDingResult(snapshot(w), winner);
  const events: string[] = [];
  let resumed: World | undefined;
  for (let frame = 1; frame <= trace.frames.at(-1)![0]; frame++) {
    const expected = trace.frames.find(r => r[0] === frame);
    const pad = { ...IDLE, b: trace.input === 'spin' && frame <= 8, a: trace.input === 'jump' && frame >= 2,
      x: trace.input === 'move' && frame <= 23 ? 1 : 0 };
    const input = IDLES.map((idle, s) => s === slot ? pad : idle);
    let c: DDCrate | undefined;
    let p = d.P[slot]!;
    let actor = d.itemActors?.[slot];
    if (result && resumedResult) {
      const step = result.advance(frame);
      assert.deepEqual(resumedResult.advance(frame), step, name);
      assert.deepEqual(result.advance(frame), [], name);
      c = result.crates.get(crate.bid);
      p = result.players[slot]!;
      actor = result.itemActors?.[slot];
      events.push(...step.map(e => e.k));
    } else {
      const eventId = w.evId;
      stepWorld(w, ringDing, input);
      c = d.C[0];
      actor = d.itemActors?.[slot];
      events.push(...w.ev.filter(e => e.id >= eventId).map(e => e.k));
      if (resumed) {
        stepWorld(resumed, ringDing, input);
        assert.deepEqual(snapshot(resumed), snapshot(w), name);
      }
      if ([3, 15, 26, trace.gain, trace.gain + 1].includes(frame)) resumed = snapshot(w);
    }
    if (frame === trace.gain) {
      assert.equal(c, undefined, name);
      assert.equal(p.pu, item, name);
      assert.equal(ddHeldItem(p, actor).visible, false, name);
    }
    if (!expected) continue;
    const [, nativeState, nx, nh, nz, yaw, remaining, heldHeight] = expected;
    assert.equal(c?.st ?? -1, nativeState, name + ' state ' + frame);
    if (c) assert.deepEqual([c.x, c.st === 13 ? c.g : 0, c.z, c.yaw], [nx, nh, nz, yaw], name + ' transform ' + frame);
    assert.equal(p.put, remaining, name + ' timer ' + frame);
    if (heldHeight >= 0) {
      const gear = ddHeldItem(p, actor);
      assert.equal(gear.visible, true, name);
      assert.equal(gear.height, heldHeight, name + ' equipped height ' + frame);
      assert.equal(gear.yaw, -(((frame - trace.gain) * 0xaa) & 0xfff) * ANGLE, name + ' equipped yaw ' + frame);
    }
  }
  assert.equal(events.filter(k => k === 'crate').length, 1, name);
  assert.equal(events.filter(k => k === 'cratehit').length, state === 1 ? 1 : 0, name);
  if (result) assert.deepEqual(snapshot(w), initial, name);
}

// The new crate is already one growth step old on its first visible update.
{
  const { w, d } = room();
  d.slots = d.slots.map(() => [0xa00, 1280]);
  d.tc = 0;
  const native = [[-923, -887, 576, 6, 0], [-941, -869, 1088, 6, 0], [-958, -850, 1600, 6, 0],
    [-975, -830, 2112, 6, 0], [-991, -811, 2624, 6, 0], [-1007, -791, 3136, 6, 0],
    [-1023, -771, 3648, 6, 0], [-1038, -750, 4096, 0, 0], [-1053, -730, 4096, 1, 13]];
  for (const frame of native) {
    stepWorld(w, ringDing, IDLES);
    const [c] = d.C;
    assert.deepEqual([c.x, c.z, c.g, c.st, c.yaw], frame);
  }
  assert.equal(w.ev.filter(e => e.k === 'cratespawn').length, 1);
}

// Already homing. A falling second seat steals the magnet through the full contact handler.
{
  const { w, d } = room();
  Object.assign(d.P[0]!, { x: 0, z: 0, face: -3072 * ANGLE, heading: 3072 });
  Object.assign(d.P[2]!, { x: 420, z: 30, h: 299, ph: 2, vv: 20, face: -3072 * ANGLE, heading: 3072 });
  const c = addCrate(w, d, 13, 0, 430, 30, 550);
  c.item = MAGNET; c.flight = { speed: 24, rising: false, touchable: true };
  stepWorld(w, ringDing, IDLES);
  assert.deepEqual([c.x, c.g, c.z, c.tc], [428, 548, 30, 2]);
  assert.equal(d.C.length, 0);
  assert.deepEqual(d.P.map(p => p?.put), [0, 0, 300, 0]);
  assert.equal(w.ev.find(e => e.k === 'crate')?.s, 2);
}

// Floor pickup and the signed horizontal threshold while safely above the cylinder.
for (const [x, h, z, speed, collected, out] of [
  [430, 1, 400, 236, true, [359, 0, 295]],
  [150, 2000, -13, 24, true, [149, 1643, -14]],
  [142, 2000, -13, 24, false, [143, 1643, -14]],
] as const) {
  const { w, d } = room();
  Object.assign(d.P[0]!, { x: 0, z: 0, face: -3072 * ANGLE, heading: 3072 });
  const c = addCrate(w, d, 13, 0, x, z, h);
  c.flight = { speed, rising: false, touchable: true };
  stepWorld(w, ringDing, IDLES);
  assert.deepEqual([c.x, c.g, c.z], out);
  assert.equal(d.C.length === 0, collected);
}

// Skill rolls are inclusive. Snapshots from before flight velocity was stored start in homing.
for (const [bot, roll, item] of [[false, 12, MAGNET], [false, 13, HOVER], [true, 20, MAGNET], [true, 21, HOVER]] as const) {
  const { w, d } = room();
  Object.assign(d.P[0]!, { x: 0, z: 0, bot, face: -3072 * ANGLE, heading: 3072 });
  const c = addCrate(w, d, 12, 0, 430, 30);
  setRoll(w, roll);
  stepWorld(w, ringDing, IDLES);
  assert.equal(c.item, item);
  c.g = 1104;
  delete c.flight;
  const old = snapshot(w);
  stepWorld(old, ringDing, IDLES);
  assert.equal((old.data as RingDingData).C[0].flight?.rising, false);
}

// Custom human seats use Cortex's disc marker geometry, including the live spin entry.
for (const look of [8, 9]) {
  const stock = room([4, 1, 6, 3]), custom = room([look, 1, 6, 3]);
  for (const { w, d } of [stock, custom]) {
    Object.assign(d.P[0]!, { x: 0, z: 0, face: -3072 * ANGLE, heading: 3072 });
    addCrate(w, d, 1, 0, 205, 30);
    setRoll(w, look === 8 ? 0 : 31, true);
  }
  for (let frame = 0; frame < 42; frame++) {
    const input = [{ ...IDLE, b: frame < 8 }, IDLE, IDLE, IDLE];
    for (const { w } of [stock, custom]) stepWorld(w, ringDing, input);
    assert.deepEqual(custom.w, stock.w);
  }
  assert.equal(custom.d.P[0]?.pu, look === 8 ? MAGNET : HOVER);
}

// No fixture placements or inputs. Both items must be collected in full CPU rounds.
for (const [seed, chars] of [[7, ROSTER], [432, [8, 9, 4, 3]], [1234, [8, 9, 6, 1]]] as const) {
  const w = createWorld(ringDing, chars.map((char, slot) => ({ char, slot, bot: true })), [], seed);
  const gained = new Set<number>();
  while (!ringDing.isOver(w)) {
    const id = w.evId;
    stepWorld(w, ringDing, []);
    for (const event of w.ev) if (event.id >= id && event.k === 'crate') gained.add(event.v);
  }
  assert.deepEqual([...gained].sort(), [1, 2], 'seed ' + seed);
}
console.log('PASS Ring Ding native crate spawn, opening, launch, marker homing, pickup, held items, and snapshot replay');
