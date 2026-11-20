import assert from 'node:assert/strict';
import { tankArena, taWorld } from '../shared/games/tankArena';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

const variants = ['swamp', 'desert', 'jungle', 'metal'];
const seats = [0, 2, 3, 4].map((char, slot) => ({ char, slot, name: String(slot), bot: false }));
const step = (w: World, fire = false) => stepWorld(w, tankArena, [{ ...IDLE, a: fire }]);

// USA L5–L8. The mixed-room AI has 52 cooldown ticks left before the first live step.
for (const variant of variants) {
  const swamp = variant === 'swamp';
  const looks = [0, 0, 8, 9];
  for (const level of [0, 1, 2]) {
    const lineup = looks.map((char, slot) => ({ char, slot, level, bot: slot > 0, name: String(slot) }));
    const w = createWorld(tankArena, lineup, [], 42, variant);
    const customSpeed = (swamp ? [30, 36, 39] : [24, 25, 27])[level];
    assert.deepEqual(w.data.tk.map((t: { speed: number }) => t.speed),
      [swamp ? 42 : 28, (swamp ? [35, 42, 46] : [28, 30, 32])[level], customSpeed, customSpeed]);
    for (let tick = 0; tick <= 52; tick++) {
      assert.deepEqual(w.data.tk.map((t: { cd: number }) => t.cd), [0, 52 - tick, 52 - tick, 52 - tick]);
      step(w);
    }
    const bots = createWorld(tankArena, lineup.map(s => ({ ...s, bot: true })), [], 42, variant);
    assert(bots.data.tk.every((t: { cd: number }) => t.cd === 0));
  }
}

// First recoil word and first idle word captured from the two native callbacks.
for (const variant of variants) {
  for (const { char } of seats) {
    const w = createWorld(tankArena, [{ ...seats[0], char }, ...seats.slice(1)], [], 42, variant);
    const t = w.data.tk[0];
    const poses = variant === 'swamp' ? [[0x4380, 0x4300], [0x4080, 0x4000], [0x4180, 0x4100], [0x4280, 0x4200]]
      : [[0x4180, 0x2010], [0x4100, 0x2012], [0x4200, 0x2009], [0x4280, 0x2011]];
    const [recoil, idle] = poses[seats.findIndex(s => s.char === char)];
    for (let i = 0; i < 12; i++) {
      step(w, true);
      assert.equal(t.gunPose, recoil + i);
      assert.equal(t.ammo, 999);
      assert.equal(t.busy, t.wpn);
    }
    step(w, true);
    assert.equal(t.gunPose, idle);
    assert.equal(t.busy, -1);
    assert.equal(w.ev.filter(e => e.k === 'shoot').length, 1);
    step(w);
    if (variant === 'swamp') assert.equal(t.gunPose, idle);
    step(w, true);
    assert.equal(t.gunPose, recoil);
  }
}

function equipped(weapon: number, ammo: number) {
  const w = createWorld(tankArena, seats, [], 42, weapon === 2 ? 'jungle' : 'metal');
  Object.assign(w.data.tk[0], { wpn: weapon, ammo });
  return w;
}

for (const ammo of [1, 2]) {
  const w = equipped(3, ammo), t = w.data.tk[0];
  for (let i = 0; i < 12; i++) {
    step(w, i === 0);
    assert.equal(t.gunPose, 0x4000 + i);
    assert.equal(t.ammo, ammo - Number(i >= 4));
    assert.equal(w.data.bombs.length, Number(i >= 4));
    assert.equal(w.ev.filter(e => e.k === 'lob').length, Number(i >= 4));
    assert.equal(t.cd, 60 - i);
  }
  step(w, true);
  assert.deepEqual([t.busy, t.wpn, t.ammo, t.cd, t.gunPose], ammo === 1
    ? [-1, 9, 999, 30, 0x2010] : [-1, 3, 1, 48, 0x2008]);
  while (t.cd > 1) step(w);
  step(w, true); // An edge on the tick that decrements cooldown to zero is dropped.
  assert.equal(t.busy, -1);
  step(w);
  step(w, true);
  assert.equal(t.busy, t.wpn);
}

for (const ammo of [1, 2]) {
  const w = equipped(2, ammo), t = w.data.tk[0];
  step(w, true);
  assert.equal(w.data.shells.length, 2);
  assert.ok(w.data.shells.every((s: { w: number; vz: number }) => s.w === 2 && s.vz === 200));
  // Keep projectile collisions from interrupting the isolated fire-gate check.
  w.data.shells.length = 0;
  w.bodies = w.bodies.filter(b => b.kind !== 'bullet');
  for (let i = 1; i < 39; i++) {
    assert.deepEqual([t.busy, t.ammo, t.gunPose], [2, ammo - 1, 0x200c]);
    step(w);
  }
  step(w, true); // The gun is still busy when this edge is checked.
  assert.deepEqual([t.busy, t.wpn, t.ammo, t.cd, t.gunPose], ammo === 1
    ? [-1, 9, 999, 30, 0x2010] : [-1, 2, 1, 0, 0x200b]);
  if (ammo === 2) {
    step(w);
    step(w, true);
    assert.deepEqual([t.busy, t.ammo, t.gunPose], [2, 0, 0x200c]);
  }
}

{
  // An ordinary pickup cancels the current bomb animation and keeps its cooldown.
  const w = equipped(3, 1), t = w.data.tk[0];
  step(w, true);
  w.data.pickups.push({ id: 100, t: 3, x: t.x, z: t.z, y: 0, vy: 0, m: 0 });
  step(w);
  assert.deepEqual([t.busy, t.ammo, t.cd, t.gunPose], [-1, 3, 59, 0x2008]);
  for (let i = 0; i < 12; i++) step(w);
  assert.equal(w.data.bombs.length, 0);
  assert.equal(w.ev.filter(e => e.k === 'lob').length, 0);
}

{
  // The fire gate counts stock shell slots even when the selected weapon is double.
  const w = equipped(2, 2), t = w.data.tk[0];
  const shell = { o: 0, x: 0, z: 0, y: -330, vx: 0, vz: 0, vy: 0, life: 50, flag: 1, w: 9, spin: 0 };
  w.data.shells.push(...[100, 101, 102].map(id => ({ ...shell, id })));
  step(w, true);
  assert.equal(t.busy, -1);
  assert.equal(t.ammo, 2);
  w.data.shells[0].w = 2;
  step(w);
  step(w, true);
  assert.equal(t.busy, 2);
  assert.equal(t.ammo, 1);
}

// Same muzzle and weapon in the live L5–L8 capture. The boat trades lifetime for speed.
for (const variant of variants) {
  const w = createWorld(tankArena, seats, [], 42, variant), t = w.data.tk[0];
  t.wpn = 11;
  step(w, true);
  const shell = w.data.shells[0];
  assert.equal(shell.z, 1168);
  assert.equal(shell.life, variant === 'swamp' ? 60 : 90);
  step(w);
  assert.equal(shell.z, variant === 'swamp' ? 1279 : 1242);
}

// L7 live replay. Both rounds traverse the muzzle positions on the trigger tick.
for (const { x, victimZ, ticks, impactZ, health } of [
  { x: 768, victimZ: 3840, ticks: 13, impactZ: 3737, health: 39 },
  { x: 1800, victimZ: 3840, ticks: 2, impactZ: 1537, health: 99 },
  { x: 768, victimZ: 2400, ticks: 5, impactZ: 2137, health: 39 },
  { x: 1200, victimZ: 3840, ticks: 15, impactZ: 4137, health: 99 },
]) {
  const w = equipped(2, 4), d = w.data;
  d.tk[0].x = x;
  d.tk[1].z = victimZ;
  step(w, true);
  const muzzles = [x - 155, x + 156];
  for (let age = 0; age < ticks; age++) {
    assert.deepEqual(d.shells.map((s: { x: number }) => s.x).sort((a: number, b: number) => a - b), muzzles);
    assert(d.shells.every((s: { z: number }) => s.z === 1137 + age * 200));
    step(w);
  }
  assert.equal(d.shells.length, 0);
  const starts = w.ev.filter(e => e.k === 'sfx' && e.v === 0x522).map(e => e.o).sort();
  assert.equal(new Set(starts).size, 2);
  assert.deepEqual(w.ev.filter(e => e.k === 'doubleImpact').map(e => e.o).sort(), starts);
  assert.equal(d.tk[1].hp, health);
  assert.equal(w.ev.filter(e => e.k === 'bounce').length, 0);
  assert.equal(w.ev.filter(e => e.k === 'sfx' && e.v === 0x43d).length, 2);
  const impacts = w.ev.filter(e => e.k === 'doubleImpact').sort((a, b) => a.x - b.x);
  assert.deepEqual(impacts.map(e => [e.x, e.z]), muzzles.map(gx => taWorld('jungle', gx, impactZ)));
}

// A hit can fall between two online snapshots. The host supplies the muzzle and contact positions.
for (const variant of variants) {
  for (const [weapon, muzzle, burst, sound] of [
    [8, 8, 12, 0x4e4], [9, 15, 13, 0x4e6], [10, 6, 11, 0x4e5], [11, 7, 10, 0x4e7],
  ]) {
    const w = createWorld(tankArena, seats, [], 42, variant);
    w.data.tk[0].wpn = weapon;
    Object.assign(w.data.tk[1], { x: 256, z: 1480 });
    step(w, true);
    const flash = w.ev.find(e => e.k === 'shellMuzzle');
    assert(flash);
    assert.deepEqual([flash.o, flash.yaw, flash.x, flash.z], [muzzle, -Math.PI, ...taWorld(variant, 256, 1168)]);
    for (let i = 0; w.data.shells.length && i < 4; i++) step(w);
    assert.equal(w.data.shells.length, 0);
    const hit = w.ev.find(e => e.k === 'hit');
    const impact = w.ev.find(e => e.k === 'shellImpact');
    assert(hit && impact && impact.v > 0);
    assert.equal(impact.o, burst);
    assert.equal(w.ev.filter(e => e.k === 'sfx' && e.v === sound).length, 1);
    assert.equal(w.ev.filter(e => e.k === 'boom').length, 0);
    assert.equal(w.data.tk[1].hp, weapon === 10 ? 69 : 79);
    if (weapon === 8 && variant === 'swamp') assert.deepEqual([impact.x, impact.z], taWorld(variant, 256, 1249));
  }
}

// In the USA pickup callback, catching the descending trap one frame earlier changes the outcome.
for (const variant of variants) {
  for (const [startY, caught] of [[-320, true], [-319, false]] as const) {
    const w = createWorld(tankArena, seats, [], 42, variant), d = w.data;
    const t = d.tk[0];
    d.pickups.push({ id: w.nextId++, x: t.x, z: t.z, y: startY, vy: 0, m: 5, t: 6 });
    step(w);
    assert.equal(d.pickups.length, 0);
    assert.equal(t.hp, caught ? 69 : 99);
    assert.equal(w.ev.filter(e => e.k === 'trapCatch').length, Number(caught));
    assert.equal(w.ev.filter(e => e.k === 'boom').length, 0);
    if (!caught) {
      const mine = d.mines[0], resumed = structuredClone(w);
      assert.deepEqual([mine.o, mine.n, t.mines], [-1, 120, 3]);
      for (let i = 0; i < 120; i++) {
        step(w);
        step(resumed);
      }
      assert.equal(d.mines.length, 0);
      assert.equal(t.hp, 39);
      assert.deepEqual(resumed.data.tk, d.tk);
    }
  }
}

// USA Jungle Fox. A pillar can be clear along the eventual aim while still
// blocking the next turret step, or clear on that step while blocking the aim.
for (const [x, z, targetX, targetZ, yaw, aim, fire] of [
  [1707, 2427, 2646, 1280, 591, 3649, true],
  [1683, 1083, 2598, 1188, 2039, 2998, false],
] as const) {
  const w = createWorld(tankArena, seats, [], 42, 'jungle');
  const [pilot, rival] = w.data.tk;
  Object.assign(pilot, { x, z, yaw });
  Object.assign(rival, { x: targetX, z: targetZ });
  Object.assign(pilot.ai, { target: 1, timer: 10, mode: 6, shoot: 100 });
  const pad = tankArena.bot!(w, 0);
  assert.equal(pilot.aim, aim);
  assert.equal(pad.a, fire);
}

// Target selection prioritizes a human within 999 units along either axis.
// The CPU driving a disconnected seat uses the same selection routine.
{
  const w = createWorld(tankArena, seats, [], 42, 'metal');
  const positions = [[1280, 1280], [2280, 2280], [2279, 3328], [4352, 3328]];
  w.data.tk.forEach((t: { x: number; z: number }, s: number) => { [t.x, t.z] = positions[s]; });
  tankArena.bot!(w, 0);
  assert.equal(w.data.tk[0].ai.target, 2);
}

console.log('Tank Wars weapon sequences passed for L5–L8');
