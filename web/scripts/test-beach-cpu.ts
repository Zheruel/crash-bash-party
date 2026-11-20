// Run with npx tsx scripts/test-beach-cpu.ts from web/.
import assert from 'node:assert/strict';
import { playerPose } from '../client/games/playerPose';
import { Predictor } from '../client/predict';
import { ballDefence } from '../shared/games/ballDefence';
import { CHARACTERS } from '../shared/look';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

function fixture(level: number, bot = true) {
  const seats = [0, 1, 2, 3].map(slot => ({ slot, name: String(slot), bot, level }));
  const w = createWorld(ballDefence, seats, [], 321, 'beach');
  w.tick = 100;
  Object.assign(w.data, { balls: [], off: 8, efa: 1, efc: 400 });
  return w;
}

function ball(w: World, x: number, z: number, h: number, st = 1, who = -1) {
  const b = {
    id: w.nextId++, st, who, x, y: -96, z, h, spd: 48, tgt: 48, acc: 4, dec: 1, hcd: 0, tm: 0,
    vv: 0, vmax: 96, vup: 6, vdn: 0, vdir: 0, psh: 0, pshA: 0, land: true, sink: 0, fl: 0x400, corner: -1,
  };
  w.data.balls.push(b);
  return b;
}

const opponents = [1, 0, 3, 2];
const cpuPad = (w: World, slot: number) => ballDefence.bot!(w, slot);
const step = (w: World, slot: number, pad = cpuPad(w, slot)) =>
  stepWorld(w, ballDefence, [0, 1, 2, 3].map(i => i === slot ? pad : IDLE));

function cpu(w: World, slot: number, a = 1814383525, b = 741505146) {
  // Rewind the isolated native seed past the engine advance and seat-order draw.
  for (let i = 0; i < 2; i++) {
    b = (b - a - (a >>> 31)) >>> 0;
    a = (a - b) >>> 0;
  }
  w.data.random = [a, b];
  w.data.f = 99;
  w.data.shipOrder = Array.from({ length: 16 }, () => [slot, ...[0, 1, 2, 3].filter(p => p !== slot)]);
  const pl = w.data.pl[slot];
  pl.beachCpu = {
    target: opponents[slot], roamX: pl.x, roamZ: pl.z, mode: 3, lapse: 8, catchT: 0, wait: 0,
  };
  return pl;
}

// Native pad results for a held shot at the opposite goal, catch countdown 26.
const release = [
  [false, false, true], [false, true, true], [true, false, true], [false, false, true],
];
for (const slot of [0, 1, 2, 3]) {
  for (const level of [0, 1, 2]) {
    const w = fixture(level);
    const pl = cpu(w, slot);
    assert.equal(pl.skill, [2, 11, 19][level]);
    const dx = Math.sign(pl.x), dz = Math.sign(pl.z);
    ball(w, pl.x - 520 * dx, pl.z - 520 * dz, (pl.face + 1800) & 4095, 8);
    const before = cloneWorld(w);
    assert.deepEqual(cpuPad(w, slot), cpuPad(before, slot));
    assert.deepEqual(w, before);
    step(w, slot);
    assert.equal(pl.beachCpu.nextPad.b, true); // FUN_800b8964 admits bouncing balls.
    assert.equal(pl.beachCpu.catchT, 90);
    assert.equal(pl.st, 0x1c);
    step(w, slot);
    assert.equal(pl.st, 0x21);

    const held = fixture(level);
    const ship = cpu(held, slot);
    Object.assign(ship, { hold: 90, arm: 2, st: 0x21 });
    Object.assign(ship.beachCpu, { mode: 5, catchT: 26, wait: 10 });
    ball(held, ship.x - 430 * dx, ship.z - 430 * dz, ship.face, 2, slot);
    step(held, slot);
    assert.equal(ship.beachCpu.nextPad.b, !release[slot][level]);
    assert.equal(ship.st, 0x21);
    assert.equal(ship.beachCpu.catchT, release[slot][level] ? 0 : 25);
    if (release[slot][level]) {
      assert.equal(ship.arm, 1);
      step(held, slot);
      assert.equal(ship.st, 0x1c);
      assert.equal(held.data.balls[0].spd, 224);
    }
  }

  const w = fixture(2);
  const pl = cpu(w, slot, 1815632890, 741520281);
  ball(w, pl.x - 550 * Math.sign(pl.x), pl.z - 550 * Math.sign(pl.z), pl.face);
  const cooldown = cloneWorld(w);
  step(w, slot);
  assert.equal(pl.beachCpu.nextPad.a, true); // Native aimed square takes priority over cross.
  assert.equal(pl.beachCpu.nextPad.b, false);
  cooldown.data.pl[slot].kcd = 8;
  step(cooldown, slot);
  assert.equal(cooldown.data.pl[slot].beachCpu.nextPad.a, false);
  assert.equal(cooldown.data.pl[slot].beachCpu.nextPad.b, true);
}

// Live USA pad replay, slot 0. The oblique shot reaches the catch sphere on frame 2.
const w = fixture(1, false);
w.data.f = 5705;
Object.assign(w.data.pl[0], { y: -105, roll: 34 });
const caught = ball(w, 80, -1656, 347);
step(w, 0, { ...IDLE, b: true });
assert.deepEqual([caught.st, caught.x, caught.z], [1, 56, -1697]);
step(w, 0, IDLE);
assert.deepEqual([caught.st, caught.x, caught.z, caught.h], [2, 71, -1672, 2122]);
assert.equal(caught.fl & 0x80, 0x80);
for (let i = 0; i < 5; i++) step(w, 0, IDLE);
assert.deepEqual([caught.st, caught.x, caught.z, caught.h, caught.spd], [1, 99, -1363, 2115, 224]);
assert.equal(caught.fl & 0x80, 0x80);

const kick = fixture(1, false);
const kicked = ball(kick, 620, -2176, 0);
kicked.spd = kicked.tgt = 0;
step(kick, 0, { ...IDLE, a: true });
step(kick, 0, IDLE);
assert.equal(kicked.who, -1);
step(kick, 0, IDLE);
assert.deepEqual([kicked.who, kicked.x, kicked.spd], [0, 858, 64]);

// USA individual-versus frame 5759. Seat 1 rolls its idle timer between
// its own CPU draws and those of seats 3 and 2.
const scene = fixture(1);
Object.assign(scene.data, { f: 5758, random: [686472468, 3737864357], ef8: 443, efa: 2, efc: 0 });
scene.data.shipOrder[7] = [1, 3, 0, 2];
const [human, top, right, left] = scene.data.pl;
human.idleT = 457;
Object.assign(top, {
  x: -657, vel: -14, st: 0x1d,
  beachCpu: { target: 0, roamX: 272, roamZ: 2176, mode: 3, lapse: 36, catchT: 0, wait: 0 },
});
Object.assign(right, {
  z: 558,
  beachCpu: { target: 3, roamX: 2176, roamZ: 324, mode: 5, lapse: 0, catchT: 0, wait: 66 },
});
Object.assign(left, {
  z: 360, vel: -86, st: 0x1d,
  beachCpu: { target: 1, roamX: -2176, roamZ: 352, mode: 3, lapse: 31, catchT: 0, wait: 75, nextPad: { ...IDLE, y: -1 } },
});
ball(scene, 503, 118, 2629);
ball(scene, 809, -747, 1538);
stepWorld(scene, ballDefence, [IDLE]);
assert.deepEqual(scene.data.random, [919563934, 2850955246]);
assert.deepEqual([top.x, top.idleT, top.beachCpu.nextPad.x], [-657, 325, 1]);
assert.deepEqual([left.z, left.vel, left.beachCpu.nextPad.y], [308, -52, 1]);
assert.equal(human.beachCpu, undefined);

// USA 6216–6262. The first idle tick already displays pose 1. The
// timer is frozen on the frame that puts pose 0 of the idle loop back.
for (const [id, donor, length, firstPose] of [
  ['tiny', 5, 46, 0x4201],
  ['cortex', 3, 60, 0x4081],
  ['big-stein', 3, 60, 0x4081],
  ['top-g', 3, 60, 0x4081],
] as const) {
  const roster = [0, 1, 2, 3].map(slot => ({
    slot, name: String(slot), bot: false, char: slot === 0 ? CHARACTERS.findIndex(c => c.id === id) : 0,
  }));
  const idle = createWorld(ballDefence, roster, [], 321, 'beach');
  Object.assign(idle.data, { balls: [], f: 6215, efc: 1000, random: [2444158742, 3873005423] });
  const pilot = idle.data.pl[0];
  pilot.idleT = 0;
  for (let slot = 1; slot < 4; slot++) idle.data.pl[slot].idleT = 1000;
  step(idle, 0, IDLE);
  assert.equal(pilot.character, donor);
  assert.deepEqual([pilot.idleT, idle.data.f - pilot.idleAt], [635, 1]);
  assert.equal(playerPose(0x1b, pilot.character, idle.data.f - pilot.idleAt), firstPose);
  for (let i = 2; i < length; i++) step(idle, 0, IDLE);
  assert.deepEqual([pilot.idleT, idle.data.f - pilot.idleAt], [635, length - 1]);

  const idlePredictor = new Predictor(ballDefence, 0);
  idlePredictor.onSnapshot(JSON.parse(JSON.stringify(idle)), 0);
  const pad = { ...IDLE, seq: 1 };
  idlePredictor.push(pad);
  step(idle, 0, pad);
  assert.deepEqual(idlePredictor.pred, idle);
  assert.deepEqual([pilot.idleT, pilot.idleAt, idle.data.f - pilot.stateAt], [635, -1, 0]);
  assert.equal(playerPose(0x19, pilot.character, idle.data.f - pilot.stateAt), 0x4000);
  step(idle, 0, IDLE);
  assert.equal(pilot.idleT, 634);
  if (id === 'tiny') {
    for (let i = 0; i < 634; i++) step(idle, 0, IDLE);
    assert.deepEqual([idle.data.f, pilot.idleT, pilot.idleAt], [6896, 0, -1]);
    // Two draws before the second native rand(600).
    idle.data.random = [3230572079, 4078053701];
    step(idle, 0, IDLE);
    assert.deepEqual([idle.data.f, pilot.idleT, idle.data.f - pilot.idleAt], [6897, 450, 1]);
  }
}

// USA 7124. Use the RNG words two draws before the gone handler, with
// no planner draws in this fixture. The first puff starts nine frames later.
const knockout = fixture(1);
Object.assign(knockout.data, { f: 7123, random: [1574539781, 4066774357] });
const [gone, ...survivors] = knockout.data.pl;
Object.assign(gone, { cpu: false, score: 0, st: 0x24, dieT: 1 });
survivors.forEach(pl => {
  pl.beachCpu = { target: 0, mode: 5, wait: 200, catchT: 0, lapse: 0 };
});
const stepAfterKnockout = () => stepWorld(knockout, ballDefence, [IDLE, ...[1, 2, 3].map(p => cpuPad(knockout, p))]);
stepAfterKnockout();
assert.equal(gone.st, 0x25);
assert.deepEqual(knockout.data.random, [4195042214, 1766081879]);
assert.deepEqual(gone.beachSmoke.map((puff: { wait: number }) => puff.wait), [8, 12, 10]);
assert.equal(knockout.data.beachSpectatorTarget, -1);
for (let i = 0; i < 9; i++) stepAfterKnockout();
assert.equal(knockout.data.beachSpectatorTarget, 1);
assert.deepEqual(gone.beachSmoke[0], { wait: 0, age: 0, y: -216, vy: -64 });

// USA three-CPU frame 6182, isolated at seat 1's planner call. The native
// defence ray hits x=32 and opponent 2 moves the target to x=96.
const steering = fixture(1, false);
Object.assign(steering.data, { off: 2, efa: 3 });
const catcher = cpu(steering, 1, 2019755542, 2037440152);
steering.data.f = 6181;
Object.assign(catcher, { x: -191, vel: -104, st: 0x21, hold: 76, arm: 2 });
Object.assign(catcher.beachCpu, {
  target: 2, roamX: -264, lapse: 0, catchT: 82, wait: 12, nextPad: { ...IDLE, b: true },
});
const heldAt6182 = ball(steering, -178, 1806, 4081, 2, 1);
Object.assign(heldAt6182, { y: -147, spd: 0, tgt: 0 });
const threatAt6182 = ball(steering, -574, 2396, 426);
Object.assign(threatAt6182, { spd: 115, tgt: 56, prevX: -505, prevZ: 2487 });
ball(steering, 593, 477, 1739);
step(steering, 1);
assert.deepEqual([catcher.beachCpu.nextPad.x, catcher.beachCpu.nextPad.b, !!catcher.beachCpu.nextPad.r], [1, true, false]);
assert.deepEqual([catcher.x, catcher.vel], [-277, -86]);
step(steering, 1);
assert.deepEqual([catcher.x, catcher.vel, heldAt6182.x], [-321, -44, -308]);

const motion = (b: ReturnType<typeof ball>) => [b.x, b.z, b.h, b.spd, b.st];
const contactSounds = (w: World) => w.ev.filter(e => e.k === 'sfx' && e.o === 1408);

// Ordinary rolling balls share speed. The target uses its new heading and
// decelerates toward its own target speed during its later callback.
const rollingContact = fixture(0, false);
const incoming = ball(rollingContact, -150, 0, 3072);
Object.assign(incoming, { spd: 80, tgt: 80 });
const outgoing = ball(rollingContact, 90, 0, 1024);
step(rollingContact, 0, IDLE);
assert.deepEqual(motion(incoming), [-89, 0, 1024, 64, 1]);
assert.deepEqual(motion(outgoing), [153, 0, 3072, 63, 1]);
assert.equal(contactSounds(rollingContact).length, 1);

// The vertical intervals must overlap. A sinking target is still eligible.
for (const drop of [254, 255]) {
  const verticalContact = fixture(0, false);
  const roller = ball(verticalContact, -150, 0, 3072);
  Object.assign(roller, { spd: 80, tgt: 80 });
  const sinking = ball(verticalContact, 90, 0, 1024, 4);
  Object.assign(sinking, { y: -96 + drop, spd: 0, tgt: 0 });
  step(verticalContact, 0, IDLE);
  assert.equal(contactSounds(verticalContact).length, drop === 254 ? 1 : 0);
}

// USA frame 5964. The newer ordinary ball takes its movement callback first.
// The released ball then redirects it from behind without sharing its speed.
const releasedContact = fixture(0, false);
releasedContact.data.f = 5963;
const released = ball(releasedContact, -73, -1249, 3959, 1, 1);
Object.assign(released, { spd: 224, tgt: 224, fl: 0x480, beachPoolSlot: 1 });
const ordinary = ball(releasedContact, -33, -1581, 3802);
Object.assign(ordinary, { beachPoolSlot: 0 });
const releaseSnapshot: World = JSON.parse(JSON.stringify(releasedContact));
const contactPrediction = new Predictor(ballDefence, 0);
contactPrediction.onSnapshot(releaseSnapshot, 0);
const idleContact = { ...IDLE, seq: 1 };
contactPrediction.push(idleContact);
step(releasedContact, 0, idleContact);
assert.deepEqual(motion(ordinary), [-9, -1646, 2226, 48, 1]);
assert.deepEqual(motion(released), [-26, -1468, 3959, 224, 1]);
assert.equal(contactSounds(releasedContact).length, 1);
assert.deepEqual(contactPrediction.pred, releasedContact);
const catchContact = { ...IDLE, b: true, seq: 2 };
contactPrediction.push(catchContact);
step(releasedContact, 0, catchContact);
assert.deepEqual(motion(ordinary), [-7, -1509, 2314, 48, 1]);
assert.deepEqual(motion(released), [21, -1687, 3959, 224, 1]);
assert.equal(contactSounds(releasedContact).length, 3);
contactPrediction.onSnapshot(releaseSnapshot, 0);
assert.deepEqual(contactPrediction.pred, releasedContact);

// USA frame 6117. The balls pass 224 u apart, outside their combined 178 u radius.
const nearMiss = fixture(1, false);
nearMiss.data.f = 6116;
const slower = ball(nearMiss, -1248, 723, 1454);
const faster = ball(nearMiss, -1017, 942, 135, 1, 1);
Object.assign(faster, { spd: 224, tgt: 224, fl: 0x480 });
step(nearMiss, 0, IDLE);
assert.deepEqual(motion(slower), [-1285, 753, 1454, 48, 1]);
assert.deepEqual(motion(faster), [-1063, 723, 135, 224, 1]);
assert.equal(contactSounds(nearMiss).length, 0);

// USA frame 6475. The rolling ball reflects from a ball held by seat 2.
const heldContact = fixture(1, false);
heldContact.data.f = 6474;
Object.assign(heldContact.data.pl[2], { z: -577, vel: -104, roll: 131, hold: 136, st: 0x21 });
const rolling = ball(heldContact, 1650, -723, 3493);
const heldTarget = ball(heldContact, 1807, -618, 974, 2, 2);
Object.assign(heldTarget, { y: -93, spd: 0, tgt: 0, fl: 0x480 });
step(heldContact, 2, { ...IDLE, b: true });
assert.deepEqual(motion(rolling), [1640, -771, 109, 48, 1]);
assert.deepEqual(motion(heldTarget), [1807, -704, 974, 0, 2]);
assert.equal(contactSounds(heldContact).length, 1);

// Scored balls return their callback slots to the pool in update order.
const recycling = fixture(0, false);
ball(recycling, 0, -2900, 0, 0x12, 0);
ball(recycling, 0, 0, 0);
ball(recycling, 0, 2900, 0, 0x12, 1);
step(recycling, 0, IDLE);
assert.deepEqual(recycling.data.beachFreeBallSlots, [0, 2]);
recycling.data.ef8 = 899;
for (const slots of [[1, 2], [1, 2, 0]]) {
  recycling.data.efc = 0;
  step(recycling, 0, IDLE);
  assert.deepEqual(recycling.data.balls.map((b: { beachPoolSlot: number }) => b.beachPoolSlot), slots);
}

// A vacant seat and a disconnected human replay their serialized CPU state. A
// real pad takes over immediately, including on a mirrored round.
const seats = [0, 1, 2, 3].map(slot => ({ slot, name: String(slot), bot: slot === 2 }));
const host = createWorld(ballDefence, seats, [], 30, 'beach');
host.params.mirror = true;
const fallback = cpuPad(host, 3);
stepWorld(host, ballDefence, [IDLE, IDLE, cpuPad(host, 2), fallback]);
assert.equal(host.data.pl[0].beachCpu, undefined);
assert.equal(host.data.pl[1].beachCpu, undefined);
assert.equal(host.data.pl[3].cpuFallback, true);
const snapshot = JSON.parse(JSON.stringify(host)) as World;
const pred = new Predictor(ballDefence, 0);
const local = { ...IDLE, seq: 1, x: 1 };
pred.onSnapshot(snapshot, 0);
pred.push(local);
stepWorld(host, ballDefence, [local, IDLE, cpuPad(host, 2), fallback]);
assert.deepEqual(pred.pred, host);
assert.ok(host.data.pl[0].x < 0);
const rejoin = new Predictor(ballDefence, 3);
const remote = { ...IDLE, seq: 1, y: -1 };
const beforeRejoin = host.data.pl[3];
Object.assign(beforeRejoin, { st: 0x21, hold: 90, arm: 2 });
const heldOnRejoin = ball(host, -1745, beforeRejoin.z, beforeRejoin.face, 2, 3);
rejoin.onSnapshot(JSON.parse(JSON.stringify(host)), 0);
rejoin.push(remote);
const state = { ...beforeRejoin.beachCpu };
delete state.nextPad;
stepWorld(host, ballDefence, [IDLE, IDLE, cpuPad(host, 2), remote]);
assert.deepEqual(rejoin.pred, host);
assert.equal(beforeRejoin.cpuFallback, undefined);
assert.deepEqual(beforeRejoin.beachCpu, state);
assert.ok(beforeRejoin.z < 0);
assert.equal(heldOnRejoin.spd, 224);

// Replay a mixed round through ball contact, catches by both controllers,
// and a CPU releasing two held balls. Reconcile with three pads still pending.
const mixedSeats = seats.map(seat => ({ ...seat, level: 1, bot: seat.slot === 1 || seat.slot === 2 }));
const mixed = createWorld(ballDefence, mixedSeats, [], 321, 'beach');
Object.assign(mixed.data, { balls: [], off: 1, efa: 4, efc: 400 });
cpu(mixed, 1);
Object.assign(mixed.data.pl[0], { y: -105, roll: 34 });
ball(mixed, 80, -1656, 347);
ball(mixed, 0, 1656, 1800, 8);
ball(mixed, -134, 50, 3072);
ball(mixed, 134, 50, 1024);
const mixedPred = new Predictor(ballDefence, 0);
const history: World[] = [JSON.parse(JSON.stringify(mixed))];
const contacts: number[] = [];
const catches: [frame: number, seat: number][] = [];
const launches: [frame: number, seat: number, fast: number][] = [];
mixedPred.onSnapshot(history[0], 0);
for (let seq = 1; seq <= 132; seq++) {
  const pad = { ...IDLE, seq, b: seq <= 7 };
  mixedPred.push(pad);
  stepWorld(mixed, ballDefence, [pad, cpuPad(mixed, 1), cpuPad(mixed, 2), IDLE]);
  assert.deepEqual(mixedPred.pred, mixed);
  history.push(JSON.parse(JSON.stringify(mixed)));
  if (seq % 6 === 0) {
    const ack = seq - 3;
    mixedPred.onSnapshot(history[ack], ack);
    assert.deepEqual(mixedPred.pred, mixed);
  }
  for (const event of mixed.ev.filter(e => e.t === seq - 1)) {
    if (event.k === 'sfx' && event.o === 1408) contacts.push(seq);
    if (event.k === 'catch') catches.push([seq, event.s]);
    if (event.k === 'launch') launches.push([seq, event.s, event.v]);
  }
}
assert.deepEqual(contacts, [1]);
assert.deepEqual(catches, [[2, 1], [2, 0], [24, 1], [109, 2]]);
assert.deepEqual(launches, [[8, 0, 1], [127, 1, 1], [127, 1, 1]]);

console.log('Beach Ball native CPU, pad and prediction fixtures passed');
