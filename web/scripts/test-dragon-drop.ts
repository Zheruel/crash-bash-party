import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Predictor } from '../client/predict';
import { botInput } from '../shared/bots';
import { IDLE } from '../shared/types';
import { versusClock } from '../shared/games/common';
import { createDragonDropResult, dragonDrop, RD_INTRO_GONG, RD_INTRO_TARGETS, RD_TICKS, type DragonDropData } from '../shared/games/dragonDrop';
import { createWorld, roundOver, stepWorld } from '../shared/sim';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const start = () => createWorld(dragonDrop, seats, [], 0);
const initial = start();
assert.equal(RD_INTRO_GONG, 80);
assert.deepEqual(RD_INTRO_TARGETS[99], { phase: 1188, th: 747, tx: 2570, tz: 1148, tyaw: 750, troll: 1500, gcd: 71 });
assert.deepEqual(initial.data.ord[0], [2, 0, 3, 1]);
const beforeResult = JSON.stringify(initial);
createDragonDropResult(initial, undefined).advance(120);
assert.equal(JSON.stringify(initial), beforeResult);

// A disconnected custom rider gets the same inputs, speed and throw boost as a roster CPU.
for (const slot of [0, 1]) {
  const host = start();
  const reference = start();
  reference.data.P[slot].bot = true;
  const inputs = seats.map(() => IDLE);
  inputs[slot] = botInput(dragonDrop, host, slot);
  for (let tick = 0; tick < 150; tick++) {
    stepWorld(host, dragonDrop, inputs);
    stepWorld(reference, dragonDrop, []);
    const { bot, cpuFallback, ...actual } = host.data.P[slot];
    const { bot: rosterCPU, ...expected } = reference.data.P[slot];
    assert.equal(bot, false);
    assert.equal(cpuFallback, true);
    assert.equal(rosterCPU, true);
    assert.deepEqual(actual, expected);
    assert.deepEqual(host.data.J, reference.data.J);
  }
  const spectator = new Predictor(dragonDrop, null);
  spectator.onSnapshot(JSON.parse(JSON.stringify(host)), 0);
  spectator.push({ ...IDLE, seq: 1 });
  stepWorld(host, dragonDrop, inputs);
  assert.equal(JSON.stringify(spectator.pred), JSON.stringify(host));

  const rider = host.data.P[slot];
  rider.lock = 0;
  const keyboard = { ...IDLE, x: -1, seq: 2 };
  const rejoined = new Predictor(dragonDrop, slot);
  rejoined.onSnapshot(JSON.parse(JSON.stringify(host)), 1);
  rejoined.push(keyboard);
  inputs[slot] = keyboard;
  stepWorld(host, dragonDrop, inputs);
  assert.equal(rider.cpuFallback, undefined);
  assert.equal(rider.pad, 0x80);
  assert.equal(JSON.stringify(rejoined.pred), JSON.stringify(host));
}

// L28 state 0 at the input unlock. The opening pair have already spun in place.
assert.deepEqual(initial.data.J.map((j: { st: number; yaw: number }) => [j.st, j.yaw]), [[0, 3136], [0, 3136], [6, 0]]);
for (const flightState of [3, 4]) {
  const w = start(), j = w.data.J[0], rider = w.data.P[0];
  const step = () => stepWorld(w, dragonDrop, []);
  Object.assign(j, { st: flightState, owner: 0, x: 0, y: 0, z: 0, vx: 10, vz: 0, vy: 256, b: 4 });
  j.shadow = { x: 0, z: 0, visible: true };
  step();
  assert.equal(j.st, 0);
  assert.equal(j.x, 10);
  assert.equal(j.tracked, flightState === 4);
  assert.equal(j.shadow.x, 0);
  step();
  assert.equal(j.shadow.x, 10);

  Object.assign(j, { x: rider.x + 200, y: -64, z: rider.z, vx: -12 });
  j.shadow.x = j.x;
  step();
  assert.equal(j.st, 1);
  assert.equal(j.tracked, false);
  assert.equal(j.shadow.visible, true);
  assert.equal(j.shadow.x, j.x + 12);
  step();
  assert.equal(j.shadow.visible, false);

  // Throw and knock-loose both restore the full-size jewel and ground marker on this tick.
  j.st = flightState === 3 ? 2 : 5;
  rider.carry = -1;
  const resumed = structuredClone(w);
  step();
  stepWorld(resumed, dragonDrop, []);
  assert.deepEqual(w, resumed);
  assert.equal(j.st, flightState);
  assert.equal(j.tracked, true);
  assert.deepEqual(j.shadow, { x: j.x, z: j.z, visible: true });
}

assert.equal(versusClock(28), 90);
assert.equal(versusClock(29), 89);
for (let second = 5; second >= 0; second--) {
  const tick = RD_TICKS - 30 * second;
  assert.equal(versusClock(tick - 1), second + 1);
  assert.equal(versusClock(tick), second);
}

// USA capture: the rolled target pushes the jewel against the rim on the scoring tick.
const edge = start();
edge.data.th = 17;
const shot = edge.data.J[0];
Object.assign(shot, { x: 70, y: -2231, z: 2715, vx: 151, vy: -1024, vz: -73, yaw: 3456, st: 3, mult: 3, owner: 0 });
stepWorld(edge, dragonDrop, []);
assert.deepEqual([shot.x, shot.y, shot.z, shot.yaw, shot.vx, shot.vz, shot.cd, edge.data.score[0]],
  [352, -2350, 2790, 3586, 118, -118, 19, 3]);

for (const points of [0, 1, 3, 5]) {
  const w = start();
  w.tick = w.data.t = RD_TICKS - 1;
  w.time = w.tick / 30;
  w.data.score[0] = points;
  for (let extra = 0; extra <= points; extra++) {
    const resumed = JSON.parse(JSON.stringify(w));
    stepWorld(w, dragonDrop, []);
    stepWorld(resumed, dragonDrop, []);
    assert.equal(w.data.shown[0], Math.min(extra + 1, points));
    assert.equal(roundOver(dragonDrop, w), extra === points);
    assert.equal(JSON.stringify(w), JSON.stringify(resumed));
  }
  assert.equal(dragonDrop.isDraw!(w, dragonDrop.placements(w)), points === 0);
}
// Three complete USA L28 captures, starting from the disc's order table and RNG at GO.
const firstOrder = '0132123002311230032121031032230121301230120332100123123023101320';
for (const capture of [
  { mode: 'Normal', rng: [1246185985, 2713100104], order: '1230023112300321210310322301213012301203321001231230231013201230', digest: '7b09ae8d2b30f6573e7e49e2e069070e95ec10252513b0904834827b774f770e' },
  { mode: 'Hard', rng: [2754134720, 1885585218], order: firstOrder, digest: '3f4793c92587c212020f06fe5756b6fc8c3592559190743eb7f5e69d0955e844' },
  { mode: 'Human', rng: [2171508062, 3975092396], order: firstOrder, digest: '96ddc75bf7811c5cef0eabfb7f194dfc14a6073fe181873ab28ce3086dd2a8c7' },
]) {
  const roster = [1, 4, 7, 6].map((char, slot) => ({
    char, slot, name: String(slot), bot: capture.mode !== 'Human' && slot > 0, level: capture.mode === 'Hard' ? 2 : 1,
  }));
  const w = createWorld(dragonDrop, roster, [], 0);
  const d = w.data as DragonDropData;
  d.random = [capture.rng[0], capture.rng[1]];
  d.ord = capture.order.match(/.{4}/g)!.map(row => Array.from(row, Number));
  const hash = createHash('sha256');
  for (let tick = 1; tick <= RD_TICKS; tick++) {
    const input = { ...IDLE };
    if (tick > 1 && capture.mode !== 'Normal') {
      const phase = (tick - 1) % 140;
      if (phase < 36) input.x = 1;
      else if (phase < 65) input.y = -1;
      else if (phase < 96) input.y = 1;
      else input.x = -1;
    }
    stepWorld(w, dragonDrop, [input]);
    const values = [...d.random];
    for (let slot = 0; slot < 4; slot++) {
      const p = d.P[slot]!;
      values.push(p.x, p.z, p.yaw, p.hd, p.vx, p.vz, p.st, p.cd, p.carry, p.pad, d.score[slot]);
    }
    for (const j of d.J) values.push(j.x, j.y, j.z, j.st, j.owner);
    hash.update(values.join(',') + '\n');
  }
  assert.equal(hash.digest('hex'), capture.digest, capture.mode);
}
console.log('Dragon Drop opening, jewel contacts, score roll, reconnect and three full USA round replays passed.');
