import assert from 'node:assert/strict';
import { tankArena, TANK_HIT_TICKS, TANK_TIMEOUT_TICK, TANK_WRECK_TICKS } from '../shared/games/tankArena';
import { DISC_CHARACTER, winnerCheerFrame } from '../shared/look';
import { cloneWorld, createWorld, roundOver, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';
import { ghostSparkFrames } from '../client/games/ghostSparks';
import { poseTicks } from '../client/games/playerPose';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
for (const { id } of tankArena.variants!) {
  for (const health of [[99, 99, 99, 99], [40, 99, 99, 40], [40, 40, 20, 20], [0, 0, 0, 0], [99, 40, 40, 40], [40, 99, 40, 40]]) {
    const w = createWorld(tankArena, seats, [], 13, id);
    w.data.tk.forEach((t: { hp: number }, i: number) => { t.hp = health[i]; });
    w.data.f = w.tick = TANK_TIMEOUT_TICK - 1;
    w.time = w.tick / 30;
    stepWorld(w, tankArena, []);
    const win = health.filter(h => h === 99).length === 1;
    assert.equal(tankArena.isDraw!(w, tankArena.placements(w)), !win);
    assert.equal(roundOver(tankArena, w), !win);
    const hp = () => w.data.tk.map((t: { hp: number }) => t.hp);
    assert.deepEqual(hp(), health);
    assert(!w.ev.some(e => e.k === 'ko'));
    if (!win) continue;
    const slot = health.indexOf(99), t = w.data.tk[slot];
    const poseAt = TANK_TIMEOUT_TICK + 1, startYaw = t.yaw, startHull = t.hull;
    const fromSnapshot = cloneWorld(w);
    for (let age = 0; age <= winnerCheerFrame(seats[slot].char); age++) {
      // Holding every control after the verdict cannot move a tank or create a weapon.
      stepWorld(w, tankArena, seats.map(() => ({ ...IDLE, x: 1, a: true, b: true, l: true })));
      stepWorld(fromSnapshot, tankArena, []);
      assert.equal(w.data.result.poseAt, poseAt);
      assert.equal(t.yaw, (startYaw + 21 * age) & 4095);
      assert.equal(t.hull, id === 'jungle' ? (startHull - 21 * age) & 4095 : startHull);
      assert.equal(roundOver(tankArena, w), age === winnerCheerFrame(seats[slot].char));
      assert.deepEqual(hp(), health);
    }
    assert.deepEqual(w, fromSnapshot);
  }
}

// Original Jungle Fox live shell, fired on native frame 249. Input unlock was frame 99.
const w = createWorld(tankArena, [6, 0, 2, 3].map((char, i) => ({ ...seats[i], char })), [], 37, 'jungle');
w.data.f = w.tick = 149;
w.time = w.tick / 30;
Object.assign(w.data.tk[0], { x: 256, z: 1692, yaw: 0, wpn: 11 });
Object.assign(w.data.tk[1], { x: 256, z: 768, hp: 1 });
for (const t of w.data.tk.slice(2)) Object.assign(t, { hp: 0, st: 0x6b });
for (let frame = 249; frame <= 345; frame++) {
  stepWorld(w, tankArena, [{ ...IDLE, a: frame === 249 }]);
  const t = w.data.tk[1];
  if (frame < 253) { assert.equal(t.hp, 1); continue; }
  assert.equal(t.hp, 0);
  assert.equal(w.data.result.rankedAt, 254 - 99);
  assert.equal(w.data.result.poseAt, frame >= 255 ? 255 - 99 : undefined);
  assert.equal(t.st, frame < 280 ? 0x69 : frame < 338 ? 0x6a : 0x6b);
  if (frame >= 338) assert.equal(t.ghostAt, 338 - 99);
  if (frame <= 255) assert.equal(t.hy, [0, -88, -164][frame - 253]);
  assert.equal(roundOver(tankArena, w), frame >= 344);
}
// The timeout arrives during Coco's 22-frame hit. The winner callback runs on the
// last recovery update, with 79 HP still displayed and all three opponents alive.
const hurt = createWorld(tankArena, [5, 1, 2, 3].map((char, i) => ({ ...seats[i], char })), [], 37, 'jungle');
hurt.tick = hurt.data.f = TANK_TIMEOUT_TICK - 7;
hurt.time = hurt.tick / 30;
const tanks = hurt.data.tk;
for (const t of tanks) t.hp = 40;
Object.assign(tanks[0], { x: 256, z: 1692, yaw: 0, wpn: 11 });
Object.assign(tanks[1], { x: 256, z: 768, hp: 99 });
for (let frame = 249; frame <= 276; frame++) {
  stepWorld(hurt, tankArena, [{ ...IDLE, a: frame === 249 }]);
  if (frame >= 253) assert.equal(tanks[1].hp, 79);
  if (frame >= 255) {
    assert.equal(hurt.data.result.winner, 1);
    assert.equal(tanks[1].st, frame < 275 ? 0x69 : 0x70);
    if (frame >= 256) assert.equal(tanks[1].inv, 0);
    if (frame >= 275) assert.equal(hurt.data.result.recovered, true);
  }
}
for (const char of DISC_CHARACTER) {
  assert.equal(TANK_HIT_TICKS[char - 1], poseTicks(0x57, char));
  assert.equal(TANK_WRECK_TICKS[char - 1], poseTicks(0x58, char));
}
// Swamp Fox, spirit socket y=72. These are the first six observed RNG results.
const draws = [6, 1, 7, 583, 1691, 457];
const sparks = ghostSparkFrames(72, 0, () => draws.shift() ?? 0);
assert.equal(sparks[7][0], null);
assert.deepEqual(sparks[8][0], { x: -39, y: -156, z: -24, fade: 352 });
assert.deepEqual(sparks[15][0], { x: -240, y: -464, z: -148, fade: 1024 });
assert.deepEqual(sparks[30][0], { x: -315, y: -464, z: -195, fade: 2464 });
console.log('Tank Wars timeout awards, knockout poses, winner timing and snapshot replay passed.');
