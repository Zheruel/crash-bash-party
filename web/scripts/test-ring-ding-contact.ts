// Run with npx tsx scripts/test-ring-ding-contact.ts from web/.
import assert from 'node:assert/strict';
import { playerPose } from '../client/games/playerPose';
import { createRingDingOpening, createRingDingResult, DD_S, DD_TICKS, ringDing, type DDBalloon, type DDCrate, type DDPlayer, type RingDingData } from '../shared/games/ringDing';
import { DISC_CHARACTER } from '../shared/look';
import { addBody } from '../shared/physics';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type InputState } from '../shared/types';

const ANGLE = Math.PI * 2 / 4096;
const square = { ...IDLE, b: true };
const right = { ...IDLE, x: 1 };
const cross = { ...IDLE, a: true };
const xyz = (p: DDPlayer) => [p.x, p.z, p.h];
const yaw = (p: DDPlayer) => Math.round(-p.face / ANGLE) & 0xfff;

{
  const w = createWorld(ringDing, [8, 4, 9, 0].map((char, slot) => ({ slot, char, name: String(slot), bot: false })), [], 27);
  const d = w.data as RingDingData;
  assert.deepEqual(d.P.map(p => [p!.x, p!.z, yaw(p!)]),
    [[-4, -646, 4], [667, -5, 3077], [-697, -19, 1006], [7, 682, 2055]]);
  for (const p of d.P as DDPlayer[]) {
    const b = w.bodies.find(b => b.id === p.bid)!;
    assert.deepEqual([b.x, b.z, b.face], [p.x * DD_S, -p.z * DD_S, p.face]);
  }
  const opening = createRingDingOpening(w)!;
  for (const [frame, count, yaw] of [[1, 0, 1], [30, 0, 312], [31, 4, 325], [61, 8, 715], [99, 8, 1209]]) {
    const stage = opening.advance(frame);
    assert.equal(stage.data.B.length, count);
    assert.equal(Math.round(-stage.data.ang / ANGLE), yaw);
    assert.deepEqual([stage.data.tc, stage.data.tk], [300 - frame, 400 - frame]);
    assert.equal(stage.tick, 0);
    assert.deepEqual(stage.ev, []);
  }
  const go = createRingDingOpening(JSON.parse(JSON.stringify(w)))!.advance(99);
  assert.deepEqual([go.bodies, go.data.B, go.rng, go.nextId, go.evId], [w.bodies, d.B, w.rng, w.nextId, w.evId]);
  assert.equal(w.time, 0);
  assert.equal(d.t, 0);
  assert.deepEqual(d.score, [0, 0, 0, 0]);
}

function room(chars: number[] = [6, 1, 4, 3], cpuSeat = -1, seed?: number) {
  const w = createWorld(ringDing, chars.map((char, slot) => ({ slot, char, name: String(slot), bot: slot === cpuSeat })), [], seed ?? 432);
  const d = w.data as RingDingData;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  // The geometry and timing captures used the same numbered row on every frame.
  if (seed === undefined) d.updateOrders = Array.from({ length: 16 }, () => [0, 1, 2, 3]);
  d.tb = d.tc = d.tk = 10000;
  d.rs = 13;
  const seats = d.P as DDPlayer[];
  const set = (slot: number, x: number, z: number, heading = 0) => {
    Object.assign(seats[slot], { x, z, face: -heading * ANGLE, heading });
  };
  [[-1700, 0], [0, -1600], [1750, 0], [0, 1600]].forEach(([x, z], s) => set(s, x, z));
  const tick = (slot = -1, pad: InputState = IDLE) => {
    const pads = seats.map((_, s) => s === slot ? pad : s === cpuSeat ? null : IDLE);
    stepWorld(w, ringDing, pads);
  };
  const crate = (x: number, z: number, polar?: [number, number]) => {
    const bid = addBody(w, 'crate', -1, x * DD_S, -z * DD_S, 0.7, 1).id;
    const c: DDCrate = { bid, x, z, st: 1, g: 0x1000, tc: -1, tf: false, item: 0x13 };
    if (polar) [c.ringAngle, c.ringRadius] = polar;
    d.C.push(c);
    return c;
  };
  const balloon = (hy: number, owner = 0) => {
    const bid = addBody(w, 'balloon', owner, 0, 0, 0.45, 1).id;
    const o: DDBalloon = { bid, ty: [11, 8, 9, 10][owner], ow: owner, x: 0, z: 0, hy,
      angle: 0, dr: 9, da: 0xe00, po: 4, pa: 0, st: 1, tf: false, tc: -1, ot: 0 };
    d.B.push(o);
    return o;
  };
  return { w, d, seats, set, tick, crate, balloon };
}

// PCSX ReARMed US L27 with the seat order fixed to 0, 1, 2, 3.
{
  const { w, seats, set, tick } = room();
  set(0, 205, 75, 0x777);
  set(2, 0, 0, 0xc00);
  Object.assign(seats[2], { st: 1, t: 19 });
  const p = seats[0];
  const x = [205, 253, 297, 337, 373, 405, 433, 457, 477, 493, 505, 513, 517];
  x.forEach((xp, i) => {
    tick();
    assert.deepEqual(xyz(p), [xp, 75, 0], `directed impulse tick ${i + 1}`);
    assert.equal(p.kn, 48 - i * 4);
    assert.equal(p.knockAngle, 0xc00);
    assert.equal(p.st, i === 0 ? 0 : 2);
    assert.equal(p.heading, 0x400);
    if (i === 0) assert.deepEqual(xyz(seats[2]), [-63, -23, 0]);
  });
  assert.equal(yaw(p), 1051);
  assert.equal(playerPose(0x2b, p.id, p.hitFrame!), 0x420c);
  assert.equal(w.ev.filter(e => e.k === 'punch' && e.v === 2 && e.s === 0).length, 1);
  while (w.tick < 37) tick();
  assert.equal(p.st, 2);
  tick();
  assert.equal(p.st, 0); // Koala exits script 0x2b on the 37th handler call.
}

{
  const { seats, set, tick } = room();
  set(0, 0, 0, 0xc00);
  set(2, 205, 75, 0x777);
  Object.assign(seats[0], { st: 1, t: 14 });
  tick();
  assert.deepEqual([seats[2].x, seats[2].z, seats[2].kn, seats[2].knockAngle], [251, 92, 44, 2843]);
  assert.equal(yaw(seats[2]), 0x777); // The radial hit keeps the victim's heading.
  assert.equal(playerPose(0x2b, seats[2].id, seats[2].hitFrame!), 0x4001);
  for (let i = 1; i < 12; i++) tick();
  assert.deepEqual([seats[2].x, seats[2].z, seats[2].kn], [505, 189, 0]);
}

{
  const { seats, set, tick } = room();
  set(0, 205, 75, 0x777);
  set(2, 0, 0, 0xc00);
  Object.assign(seats[0], { h: 189, ph: 1, vv: 72, pu: 0x13, put: 240 });
  Object.assign(seats[2], { st: 1, t: 19 });
  tick();
  assert.deepEqual(xyz(seats[0]), [269, 99, 221]);
  tick();
  assert.deepEqual(xyz(seats[0]), [317, 99, 240]);
  assert.equal(seats[0].pu, 0);
  for (let i = 2; i < 13; i++) tick();
  assert.deepEqual(xyz(seats[0]), [581, 99, 0]);
  assert.equal(seats[0].st, 2);
  assert.equal(seats[0].landing, 0);
}

for (const [pad, frames] of [
  [IDLE, [[-150, 100, 0], [-150, 100, 0]]],
  [right, [[-177, 80, 0], [-172, 66, 0], [-166, 49, 0], [-158, 29, 0]]],
  [cross, [[-150, 100, 115], [-227, 80, 217]]],
] as const) {
  const { seats, set, tick } = room();
  set(0, -150, 100);
  set(1, 40, 150);
  for (const frame of frames) {
    tick(0, pad);
    assert.deepEqual(xyz(seats[0]), frame);
    assert.deepEqual(xyz(seats[1]), [40, 150, 0]);
  }
}

{
  const { seats, set, tick } = room();
  set(0, 2410, 40);
  tick(0, right);
  assert.deepEqual(xyz(seats[0]), [2279, -8, 0]); // 2432 minus Koala's radius 153.
  assert.equal(yaw(seats[0]), 3840);
}

{
  const { seats, tick } = room();
  tick(0, { ...right, x: Math.SQRT1_2, y: -Math.SQRT1_2 });
  assert.deepEqual(xyz(seats[0]), [-1664, 70, 0]);
  assert.equal(seats[0].heading, 2557);
  assert.equal(yaw(seats[0]), 3711);
}

{
  const { w, seats, set, tick } = room([4, 4, 6, 1]);
  set(0, -260, 0, 0xc00);
  set(1, 260, 0, 0x400);
  set(3, 0, 40);
  for (const p of seats.slice(0, 2)) Object.assign(p, { st: 1, t: 19 });
  tick();
  const last = seats[3];
  assert.deepEqual([last.x, last.z, last.knockAngle], [-48, 40, 0x400]);
  assert.equal(w.ev.find(e => e.k === 'punch' && e.v === 2)?.o, 0);
}

{
  const { seats, set, tick, crate } = room();
  set(0, -130, 40);
  crate(0, 0);
  tick();
  assert.deepEqual(xyz(seats[0]), [-237, 74, 0]);
}

{
  const { seats, set, tick, crate } = room();
  set(0, -130, 40);
  crate(0, 0);
  Object.assign(seats[0], { st: 2, t: 24, kn: 48, knockAngle: 0x880 });
  tick();
  assert.deepEqual(xyz(seats[0]), [-227, 122, 0]); // Solid prop before impulse integration.
  tick();
  assert.deepEqual(xyz(seats[0]), [-218, 166, 0]);
}

{
  const { w, d, seats, set, tick, crate } = room();
  set(0, 1190, 50);
  const c = crate(1280, 0, [0x400, 1280]);
  tick();
  assert.deepEqual(xyz(seats[0]), [1063, 99, 0]);
  assert.deepEqual([c.x, c.z], [1279, -26]);
  const copy = structuredClone(d);
  const result = createRingDingResult(w, undefined);
  result.advance(13);
  assert.deepEqual(d, copy);
  assert.deepEqual([result.crates.get(c.bid)!.x, result.crates.get(c.bid)!.z], [1267, -179]);
}

{
  const { d, seats, set, tick, crate } = room();
  set(2, 0, 0, 0xc00);
  const c = crate(228, 50);
  tick(2, square);
  assert.equal(c.st, 1); // Square enters script 10 before the first attack query.
  assert.equal(seats[2].st, 1);
  tick();
  assert.equal(c.st, 9);
  tick();
  assert.equal(c.st, 12);
  tick();
  assert.equal(c.st, 13);
  assert.equal(d.C.length, 1);
}

{
  const { w, d, seats, set, crate } = room();
  set(0, -909, -490);
  Object.assign(seats[0], { st: 3, t: 8 });
  d.st[0] = 2;
  const c = crate(-1111, -636); // Legacy terminal snapshot without the original polar fields.
  const result = createRingDingResult(w, 1);
  for (const [tick, x, z] of [[7, -954, -399], [8, -955, -390], [13, -965, -379], [43, -967, -380]]) {
    result.advance(tick);
    assert.deepEqual(xyz(result.players[0]!), [x, z, 0]);
  }
  assert.deepEqual([result.crates.get(c.bid)!.x, result.crates.get(c.bid)!.z], [-1179, -499]);
  result.advance(44);
  assert.equal(result.players[0]!.hidden, true);
}

{
  const { w, d, seats, set } = room();
  set(1, -170, -100, 3413);
  set(2, -265, 110, 3817);
  Object.assign(seats[2], { st: 3, t: 6 });
  d.st[2] = 1;
  const result = createRingDingResult(w, undefined);
  for (const [tick, x, z, kn] of [[1, -170, -100, 48], [2, -150, -143, 48], [5, -90, -272, 44], [16, 24, -507, 0]]) {
    result.advance(tick);
    const q = result.players[1]!;
    assert.deepEqual([q.x, q.z, q.kn, q.st, q.entered], [x, z, kn, 0, -1]);
    assert.equal(q.heading, 1769);
    assert.equal(yaw(q), 3413);
  }
}

// Exercise Square, queued hits, body mirrors and the custom Cortex profiles through the normal step.
for (let slot = 0; slot < 4; slot++) {
  for (const bot of [false, true]) {
    for (const [look, nativeId] of DISC_CHARACTER.entries()) {
      const chars = [1, 1, 1, 1];
      chars[slot] = look;
      chars[(slot + 1) % 4] = look;
      const { w, d, seats, set, tick } = room(chars, bot ? slot : -1, 432);
      const attacker = seats[slot], victimSlot = (slot + 1) % 4, victim = seats[victimSlot];
      set(slot, 0, 0, 0xc00);
      set(victimSlot, 260, 60, 0x777);
      if (bot) attacker.cpu!.pad = 0x8000;
      tick(bot ? -1 : slot, square);
      assert.equal(attacker.id, nativeId);
      assert.equal(attacker.st, 1);
      assert.equal(victim.kn, 0);
      tick();
      const secondRow = [2, 0, 3, 1];
      if (secondRow.indexOf(slot) > secondRow.indexOf(victimSlot)) {
        assert.equal(victim.pendingHit, slot);
        assert.equal(victim.kn, 48);
        assert.equal(victim.st, 0);
        tick();
      }
      assert.equal(victim.st, 2, `look ${look}, seat ${slot}, CPU ${bot}`);
      assert.equal(victim.id, nativeId);
      assert.equal(victim.kn, 44);
      assert.equal(victim.hitFrame, 1);
      assert.equal(d.st[victimSlot], 2);
      assert.ok(victim.x > 260);
      const body = w.bodies.find(b => b.id === victim.bid)!;
      assert.deepEqual([body.x, body.z, body.face], [victim.x * DD_S, -victim.z * DD_S, victim.face]);
    }
  }
}

// USA L27 scheduler and contact captures, seeded before the first dispatch.
for (const [seed, row, order, nextRow, last, spinTrace] of [
  [0, 1, '1032', 15, 0, [48, 48, 44, 2]],
  [1, 14, '2310', 12, 0, [0, 40, 48, 0]],
  [7, 13, '2013', 15, 1, [-47, 48, 44, 2]],
  [432, 12, '2301', 0, 1, [0, 40, 48, 0]],
] as const) {
  const chars = [6, 1, 4, 3]; // Koala, Coco, Cortex, Dingodile
  {
    const { w, d, tick } = room(chars, -1, seed);
    assert.equal(d.updateOrders?.length, 16);
    assert.equal(d.updateOrders?.[row].join(''), order);
    stepWorld(w, ringDing, chars.map(() => square));
    assert.equal(w.ev.filter(e => e.k === 'punch').map(e => e.s).join(''), order);
    tick();
    assert.equal(d.random![0] % 16, nextRow);
  }
  {
    const { w, d, seats, set, tick, balloon } = room(chars, -1, seed);
    set(0, -215, 35);
    set(1, 220, -35);
    Object.assign(seats[0], { h: 300, ph: 1, vv: 128 });
    Object.assign(seats[1], { h: 310, ph: 1, vv: 128 });
    const o = balloon(800, 1);
    tick();
    assert.deepEqual([o.st, o.tc], [9, last]);
    tick();
    assert.equal(w.ev.find(e => e.k === 'pop')?.s, last);
    assert.equal(d.score[1], Number(last === 1));
    assert.equal(seats[0].st, last === 0 ? 2 : 0);
  }
  for (const kind of ['spin', 'crate', 'result'] as const) {
    const { w, d, seats, set, tick, crate } = room(chars, -1, seed);
    set(0, -260, 0, 0xc00);
    set(1, 260, 0, 0x400);
    Object.assign(seats[0], { st: 1, t: 14 });
    Object.assign(seats[1], { st: 1, t: 16 });
    if (kind === 'crate') {
      const c = crate(0, 0);
      tick();
      assert.deepEqual([c.st, c.tc], [9, last]);
      tick();
      assert.equal(w.ev.find(e => e.k === 'cratehit')?.s, last);
    } else {
      set(3, 0, 40, 0xc00);
      if (kind === 'spin') {
        tick();
        const v = seats[3];
        assert.deepEqual([v.x, v.z, v.kn, v.st], spinTrace);
      } else {
        d.draw = true;
        d.st = seats.map(p => p.st);
        for (const p of seats) p.st = 3;
        const saved = JSON.parse(JSON.stringify(w));
        const result = createRingDingResult(w, undefined);
        const resumed = createRingDingResult(saved, undefined);
        result.advance(1);
        const v = result.players[3]!;
        assert.deepEqual([v.x, v.z, v.kn, v.st], [...spinTrace.slice(0, 3), 0]);
        result.advance(2);
        assert.deepEqual(result.advance(12), resumed.advance(12));
        assert.deepEqual(JSON.parse(JSON.stringify(result.players)), JSON.parse(JSON.stringify(resumed.players)));
        assert.deepEqual(JSON.parse(JSON.stringify(w)), saved);
      }
    }
  }
}

// A live draw consumes the first row. The terminal replay starts at the second.
{
  const { w, d, set } = room([6, 1, 4, 3], -1, 0);
  set(0, -260, 0, 0xc00);
  set(1, 260, 0, 0x400);
  set(3, 0, 40, 0xc00);
  d.t = DD_TICKS - 1;
  stepWorld(w, ringDing, [square, square, IDLE, IDLE]);
  assert.equal(d.draw, true);
  const saved = JSON.parse(JSON.stringify(w));
  const result = createRingDingResult(saved, undefined);
  result.advance(1);
  const v = result.players[3]!;
  assert.deepEqual([v.x, v.z, v.kn, v.st], [-47, 48, 44, 0]);
  assert.deepEqual(saved, JSON.parse(JSON.stringify(w)));
}

// US L27 balloon cylinder boundaries, before the actor advances.
for (const [slot, x, h, hy, hit] of [
  [0, -247, 200, 960, true], [0, -248, 200, 960, false], [0, -247, 200, 961, false], // Koala
  [0, -247, 600, 353, true], [0, -247, 600, 352, false],
  [1, -247, 200, 861, true], [1, -247, 200, 862, false], // Coco
  [2, -245, 200, 776, true], [2, -245, 200, 777, false], // Cortex
] as const) {
  const { w, d, seats, set, tick, balloon } = room();
  set(slot, x, 0);
  Object.assign(seats[slot], { h, ph: 1, vv: 128 });
  const o = balloon(hy, slot);
  tick();
  assert.deepEqual([o.st, o.tc, o.x, o.z], [hit ? 9 : 1, hit ? slot : -1, 7, -9]);
  assert.deepEqual(d.score, [0, 0, 0, 0]);
  assert.ok(!w.ev.some(e => e.k === 'pop'));
  if (hit) {
    tick();
    assert.equal(d.score[slot], 1);
    assert.equal(d.B.length, 0);
    assert.ok(!w.bodies.some(b => b.id === o.bid));
    assert.equal(w.ev.find(e => e.k === 'pop')?.s, slot);
  }
}

// Both players can tag on the contact update. A contender arriving on the pop update
// still meets the cylinder but cannot change the saved toucher.
for (const [cocoHeight, owner, toucher] of [[310, 1, 1], [138, 0, 0]]) {
  const { w, d, seats, set, tick, balloon } = room();
  set(0, -215, 35);
  set(1, 220, -35);
  Object.assign(seats[0], { h: 300, ph: 1, vv: 128 });
  Object.assign(seats[1], { h: cocoHeight, ph: 1, vv: 128 });
  const o = balloon(800, owner);
  tick();
  assert.deepEqual([o.st, o.tc], [9, toucher]);
  tick();
  assert.equal(w.ev.find(e => e.k === 'pop')?.s, toucher);
  assert.equal(d.score[toucher], 1);
}

{
  const { w, d, seats, set, tick, balloon } = room();
  set(1, -200, 80);
  Object.assign(seats[1], { h: 300, ph: 1, vv: 128 });
  const o = balloon(800);
  tick();
  assert.deepEqual([o.st, o.tc, seats[1].st, seats[1].h], [9, 1, 0, 388]);
  tick();
  assert.deepEqual([seats[1].st, seats[1].h, seats[1].kn], [2, 436, 0]);
  assert.deepEqual(d.score, [0, 0, 0, 0]);
  assert.deepEqual(w.ev.filter(e => ['pop', 'hurt'].includes(e.k)).map(e => [e.k, e.s, e.t]),
    [['pop', 1, 1], ['hurt', 1, 1]]);
}

{
  const { d, seats, set, tick, balloon } = room();
  set(0, -275, 35, 0xc00);
  Object.assign(seats[0], { h: 300, ph: 1, vv: 128 });
  const o = balloon(800);
  const pad = { ...right, a: true };
  for (const [x, z, h, st, tc, awarded] of [
    [-225, 35, 415, 1, -1, 0], [-187, 38, 517, 9, 0, 0], [-173, 49, 606, 9, 0, 1],
  ]) {
    tick(0, pad);
    assert.deepEqual([...xyz(seats[0]), o.st, o.tc, d.score[0]], [x, z, h, st, tc, awarded]);
  }
}

// A low balloon can overlap the tall Koala even on the ground.
{
  const { d, seats, set, tick, balloon } = room();
  set(0, -200, 80);
  const o = balloon(760);
  tick();
  assert.deepEqual([...xyz(seats[0]), o.st, o.tc], [-231, 93, 0, 9, 0]);
  tick();
  assert.equal(d.score[0], 1);
}

// A contact one update earlier can award before the expiry callback. On the
// expiry update the contact has only entered state 9 when ranking runs.
for (const airborne of [true, false]) {
  const { w, d, seats, set, tick, balloon } = room();
  d.t = w.tick = DD_TICKS - 2;
  w.time = w.tick / 30;
  set(0, -210, 35);
  if (airborne) Object.assign(seats[0], { h: 300, ph: 1, vv: 128 });
  const o = balloon(800);
  tick(0, airborne ? IDLE : cross);
  assert.deepEqual([o.st, o.tc, d.score[0]], airborne ? [9, 0, 0] : [1, -1, 0]);
  tick(0, airborne ? IDLE : cross);
  assert.equal(d.score[0], Number(airborne));
  assert.equal(d.draw, !airborne);
  assert.equal(w.ev.some(e => e.k === 'pop' && e.s === 0), airborne);
  if (!airborne) assert.deepEqual([o.st, o.tc], [9, 0]);
}

// L27 awards a queued pop on result tick 1. In a win the late digit can tie the winner.
for (const score of [[0, 0, 0, 0], [4, 5, 2, 0]]) {
  const { w, d, seats, set, tick, balloon } = room();
  d.t = w.tick = DD_TICKS - 1;
  d.score = [...score];
  d.shown = [...score];
  set(0, -210, 35);
  Object.assign(seats[0], { h: 300, ph: 1, vv: 128 });
  const o = balloon(800);
  tick();
  const order = ringDing.placements(w);
  const draw = ringDing.isDraw!(w, order);
  const snapshot = structuredClone(w);
  const result = createRingDingResult(w, draw ? undefined : order[0]);
  assert.equal(ringDing.isOver(w), true);
  assert.deepEqual(result.advance(0), []);
  assert.equal(result.balloons.get(o.bid)?.st, 9);
  const [pop] = result.advance(1);
  assert.deepEqual([pop.k, pop.s, pop.o, pop.x, pop.z, pop.v, pop.balloonType],
    ['pop', 0, 0, 7 * DD_S, 9 * DD_S, 799 * DD_S, 11]);
  assert.equal(result.balloons.size, 0);
  assert.equal(result.shown[0], score[0] + 1);
  assert.deepEqual(result.advance(1), []);
  assert.deepEqual(result.advance(90), []);
  assert.deepEqual(w, snapshot);
  assert.deepEqual(ringDing.placements(w), order);
  assert.equal(ringDing.isDraw!(w, order), draw);
}

// Two untouched balloons drift on ticks 1 and 2, then burst at the last origins.
// The second fixture starts with an initializing balloon and uses the same native samples.
for (const [initial, recolour] of [[1, 0], [0, 25]]) {
  const { w, d, balloon } = room();
  d.rc = recolour; d.rcO = 2;
  const older = balloon(799), newer = balloon(799);
  Object.assign(older, { x: 567, z: 1, st: initial, dr: 10, da: 3072 });
  Object.assign(newer, { x: 0, z: -6 });
  const result = createRingDingResult(w, undefined);
  assert.equal(result.balloonSlot(result.balloons.get(older.bid)!), recolour ? 2 : 0);
  for (const [frame, state, positions] of [[1, 1, [[584, 2, 798], [1, -12, 798]]], [2, 9, [[600, 3, 797], [2, -18, 797]]]] as const) {
    assert.deepEqual(result.advance(frame), []);
    const remaining = [...result.balloons.values()];
    assert.deepEqual(remaining.map(o => [o.x, o.z, o.hy]), positions);
    assert.deepEqual(remaining.map(o => [o.st, o.tc]), [[state, -1], [state, -1]]);
  }
  assert.deepEqual(result.advance(3).map(e => [e.k, e.s, e.o, e.x, e.z]),
    [['pop', -1, 0, 2 * DD_S, 18 * DD_S], ['pop', -1, 0, 600 * DD_S, -3 * DD_S]]);
  assert.equal(result.balloons.size, 0);
  assert.deepEqual(result.shown, d.score);
}

// An overlap after dispatch makes the balloon enter state 9 early without awarding a point.
{
  const { w, seats, set, balloon } = room();
  set(0, -210, 35);
  Object.assign(seats[0], { h: 217, ph: 1, vv: 102 });
  const o = balloon(894);
  Object.assign(o, { x: 17, z: -18 });
  const result = createRingDingResult(w, undefined);
  assert.deepEqual(result.advance(1), []);
  const moved = result.balloons.get(o.bid)!;
  assert.deepEqual([moved.x, moved.z, moved.hy, moved.st, moved.tc], [27, -26, 892, 9, -1]);
  assert.deepEqual(result.advance(2).map(e => [e.k, e.s]), [['pop', -1]]);
  assert.deepEqual(result.shown, [0, 0, 0, 0]);
}

// Recoloured and black pops keep their own sound types. A wrong
// colour can also interrupt the pose of an already selected winner.
{
  const { w, d, seats, set, balloon } = room();
  d.rc = 27; d.rcO = 2;
  set(0, -246, 42);
  const o = balloon(757);
  Object.assign(o, { x: 7, z: -9, st: 9, tc: 0 });
  const black = balloon(799);
  Object.assign(black, { x: 600, z: 3, ty: 12, ow: -1, ot: 4 });
  const result = createRingDingResult(w, 0);
  assert.deepEqual(result.advance(1).map(e => [e.k, e.o, e.s, e.balloonType]),
    [['pop', 2, 0, 11], ['hurt', -1, 0, undefined]]);
  assert.equal(result.players[0]?.st, 2);
  assert.equal(result.players[0]?.entered, -1);
  assert.equal(seats[0].st, 0);
  assert.deepEqual(result.advance(3).map(e => [e.k, e.balloonType]), [['pop', 12], ['black', undefined]]);
  assert.equal(result.players[1]?.entered, 1);
  result.advance(45);
  assert.ok(result.players[0]!.entered > 1);
  assert.equal(result.players[0]?.hidden, false);
  assert.deepEqual(result.shown, [0, 0, 0, 0]);
}

// L27: a held press made during recovery retries on the first eligible tick.
for (const [look] of DISC_CHARACTER.entries()) for (let slot = 0; slot < 4; slot++) {
  const roster = [0, 1, 2, 3];
  roster[slot] = look;
  const { w, seats, tick } = room(roster);
  let resumed: typeof w | undefined;
  const attacks: number[][] = [];
  for (let frame = 1; frame <= 153; frame++) {
    const pad = { ...IDLE, b: frame === 3 || frame === 23 || (frame >= 44 && frame < 100) || frame === 130 || frame === 152,
      a: frame === 133, d: frame === 153 };
    tick(slot, pad);
    const player = seats[slot];
    if (w.ev.some(e => e.t === frame - 1 && e.k === 'punch' && e.s === slot && e.v === 1)) {
      attacks.push([frame, player.spinLock!]);
    }
    if (resumed) {
      stepWorld(resumed, ringDing, roster.map((_, i) => i === slot ? pad : IDLE));
      assert.deepEqual(JSON.parse(JSON.stringify((resumed.data as RingDingData).P[slot])), JSON.parse(JSON.stringify(player)));
    }
    if (frame === 46) resumed = JSON.parse(JSON.stringify(w));
    if (frame === 133) assert.deepEqual([player.st, player.ph], [0, 1]);
    if (frame === 153) assert.deepEqual([player.st, player.tauntAt], [0, frame - 1]);
  }
  assert.deepEqual(attacks, [[3, 15], [23, 25], [48, 40], [130, 15], [152, 23]]);
}

console.log('PASS Ring Ding L27 balloons, knockback, crates, results, spin recovery, interrupts, and roster/seat replay');
