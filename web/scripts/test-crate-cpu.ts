// Run with npx tsx scripts/test-crate-cpu.ts from web/.
// Seeded regressions for the FUN_800b4ab0 controller port on all four Crate Crush stages.
import assert from 'node:assert/strict';
import { crateToss, CT_U, ctHurtTicks } from '../shared/games/crateToss';
import { botInput } from '../shared/bots';
import { addBody, drawDiscRandom } from '../shared/physics';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import type { InputState, World } from '../shared/types';

const variants = ['jungle', 'space', 'snow', 'drain'] as const;
const TAU = Math.PI * 2;

function match(variant: string, seed: number, level: number, humans = 0) {
  const seats = [0, 1, 2, 3].map((slot) => ({ slot, name: String(slot), bot: slot >= humans, level, char: [0, 1, 4, 6][slot] }));
  return createWorld(crateToss, seats, [], seed, variant);
}

const player = (w: World, slot: number) => w.bodies.find((b) => b.kind === 'player' && b.slot === slot)!;
const cpu = (w: World, slot = 0) => w.data.cpu[slot];
const inputs = (w: World) => [0, 1, 2, 3].map((slot) => botInput(crateToss, w, slot));
const tick = (w: World) => stepWorld(w, crateToss, inputs(w));

/** Fixture coordinates are game units relative to this point, clear of the Snow rock and the arena walls. */
const O = [-1500, 700];

/** An empty arena with the spawners parked and slot 0 at O facing +X. */
function fixture(variant: string, level = 1) {
  const w = match(variant, 432, level);
  w.bodies = w.bodies.filter((b) => b.kind === 'player' || b.kind === 'penguin');
  Object.assign(w.data, { tSpawn: 1e5, tFruit: 1e5, tBurst: 1e5, tPower: 1e5 });
  if (w.data.peng) w.data.peng.f = 1e5; // the penguin keeps sleeping
  const at = [[0, 0], [-1600, -1600], [1600, -1600], [1600, 1600]];
  at.forEach(([x, z], slot) => place(w, slot, x - (slot ? O[0] : 0), z - (slot ? O[1] : 0)));
  return w;
}

/** Game coordinates: web Z is minus game Z. Face is a web heading. */
function place(w: World, slot: number, x: number, z: number, face = Math.PI / 2) {
  Object.assign(player(w, slot), { x: (x + O[0]) * CT_U, z: -(z + O[1]) * CT_U, face });
  w.data.f8[slot] = face;
  cpu(w, slot).yaw14 = -1;
}

function crate(w: World, x: number, z: number, kind = 'crate', holder?: number) {
  const obj = addBody(w, kind, -1, (x + O[0]) * CT_U, -(z + O[1]) * CT_U, 120 * CT_U, 1);
  obj.cd = holder === undefined ? 0 : holder + 1;
  w.data.cs[obj.id] = { s: holder === undefined ? 1 : 2, t: 0, hv: 0, vv: 0, up: false, dx: 0, dz: 0, own: holder ?? -1, fuse: 90, kt: 0, item: 0 };
  return obj;
}

const heading = (inp: InputState) => Math.atan2(inp.x, inp.y);
const near = (a: number, b: number, eps = 0.02) => Math.abs(((a - b) % TAU + 3 * Math.PI) % TAU - Math.PI) < eps;

// Party skill rows per stage and difficulty, with every target weight at 16.
for (const variant of variants) for (const level of [0, 1, 2]) {
  const w = match(variant, 5, level);
  assert.deepEqual(w.data.cpuSkill, Array(4).fill([1, 16, variant === 'drain' ? 28 : 32][level]));
  assert.deepEqual(w.data.cpuWeight, [16, 16, 16, 16]);
}

// The first update: every CPU stands idle with no one within 0x7fffff squared, so it skips the taunt and searches.
// That is one FUN_80015590(0x100) in the preamble plus 0x100, 0x1000 and the stage's roaming draw in FUN_800b62ec.
for (const variant of variants) for (const humans of [0, 1]) {
  const w = match(variant, 99, 1, humans);
  const expected: [number, number] = [...w.data.cpuRandom];
  const roam = { jungle: 6, space: 3, snow: 4, drain: 8 }[variant];
  for (let slot = humans; slot < 4; slot++) for (const limit of [0x100, 0x100, 0x1000, roam]) drawDiscRandom(expected, limit);
  tick(w);
  assert.deepEqual(w.data.cpuRandom, expected, `${variant}: draw order with ${humans} human seat(s)`);
  for (let slot = humans; slot < 4; slot++) assert.ok([1, 2, 3].includes(cpu(w, slot).state));
}

// Whole matches: polling never changes the world, the step plans what polling returned, and seeds replay exactly.
for (const variant of variants) {
  const states = new Set<number>();
  let presses = 0;
  const a = match(variant, 2024, 2), b = match(variant, 2024, 2);
  for (let i = 0; i < 900 && !crateToss.isOver(a); i++) {
    const before = JSON.stringify(a);
    const polled = inputs(a);
    assert.equal(JSON.stringify(a), before, `${variant}: polling mutated the world at ${i}`);
    stepWorld(a, crateToss, polled);
    stepWorld(b, crateToss, inputs(b));
    polled.forEach((inp, slot) => {
      const bot = cpu(a, slot);
      assert.equal(!!inp.b, !!(bot.pad & 0x8000));
      assert.equal(!!inp.a, !!(bot.pad & 0x2000));
      assert.equal(!!inp.c, !!(bot.pad & 0x4000));
      assert.equal(bot.dir, inp.x !== 0 || inp.y !== 0);
      if (inp.a || inp.b) presses++;
      states.add(bot.state);
    });
  }
  assert.equal(JSON.stringify(a), JSON.stringify(b), `${variant}: seeded replay diverged`);
  for (const s of [1, 2, 10, 12, 13]) assert.ok(states.has(s), `${variant}: never reached route state ${s}`);
  assert.ok(presses > 20, `${variant}: CPUs barely acted`);
}

for (const variant of variants) {
  // FUN_800b6138: the first sample and a later one blocked turns the yaw by 0x31c and retreats for 30 updates.
  // The pad still points at the target that update, so the next update finds the same lanes and saves state 5.
  {
    const w = fixture(variant);
    Object.assign(cpu(w), { state: 3, tgt: 1 });
    place(w, 1, 1400, 0);
    crate(w, 352, 120, 'nitro'); crate(w, 608, -120, 'nitro');
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).saved, cpu(w).t32, cpu(w).tgt], [5, 3, 30, -1]);
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).saved, cpu(w).t32], [5, 5, 30]);
    assert.equal(cpu(w).dir, false);
  }
  // An isolated blockage holds Cross and keeps the route.
  {
    const w = fixture(variant);
    Object.assign(cpu(w), { state: 3, tgt: 1 });
    place(w, 1, 1400, 0);
    crate(w, 352, 120, 'nitro');
    const inp = botInput(crateToss, w, 0);
    assert.equal(inp.c, true);
    assert.ok(near(heading(inp), Math.PI / 2));
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).tgt], [3, 1]);
  }
  // Carrying with the first sample blocked goes straight to the throw state.
  {
    const w = fixture(variant);
    crate(w, 0, 0, 'crate', 0);
    Object.assign(cpu(w), { state: 12, tgt: 1 });
    place(w, 1, 3000, 0);
    crate(w, 352, 120, 'nitro');
    tick(w);
    assert.equal(cpu(w).state, 13);
  }
  // FUN_800b46b8: a weight holder within 1024 units replaces the route heading with one pointing away.
  {
    const w = fixture(variant);
    Object.assign(cpu(w), { state: 3, tgt: 2 });
    place(w, 1, 600, 0);
    Object.assign(w.data, { eff: [0, 0x14, 0, 0], effT: [0, 200, 0, 0] });
    assert.ok(near(heading(botInput(crateToss, w, 0)), -Math.PI / 2));
  }
  // Hurt: state 6 while hurt, until the five-update timer runs out, then state 7 until the lanes clear, then a 20-update retreat.
  {
    const w = fixture(variant);
    w.data.st[0] = 4; w.data.stT[0] = ctHurtTicks(w.data.char[0]);
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).t32], [6, 5]);
    w.data.st[0] = 0; w.data.stT[0] = 0;
    if (w.data.lock) w.data.lock[0] = 0;
    for (let i = 0; i < 4; i++) tick(w);
    assert.equal(cpu(w).state, 6);
    tick(w);
    assert.equal(cpu(w).state, 7);
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).t26, cpu(w).t32], [5, 180, 20]);
  }
  // State 7 holds L2 while a lane is blocked, and the facing turns 0x100 per update.
  {
    const w = fixture(variant);
    Object.assign(cpu(w), { state: 7, yaw14: 0xc00 });
    crate(w, 352, 120, 'nitro');
    const inp = botInput(crateToss, w, 0);
    assert.equal(inp.l, true);
    tick(w);
    assert.equal(cpu(w).yaw14, 0xb00);
    assert.ok(near(w.data.f8[0], Math.PI / 2 + 0x100 * TAU / 4096, 1e-9));
  }
  // Within 128 units of a station, state 4 draws a victim and taunts with a four-update wait and a 300-update cooldown.
  {
    const w = fixture(variant);
    Object.assign(cpu(w), { state: 4, tgt: 8 });
    place(w, 0, -1920 + 100 - O[0], -1920 - O[1]);
    const inp = botInput(crateToss, w, 0);
    assert.equal(inp.d, true);
    assert.equal(inp.x, 0);
    tick(w);
    assert.deepEqual([cpu(w).state, cpu(w).t26, cpu(w).t32], [21, 300, 4]);
    assert.ok(cpu(w).tgt >= 1 && cpu(w).tgt <= 3 || cpu(w).tgt === 6);
  }
  // State 13 throws with Circle once the facing is within 0x155 of the bearing to the victim.
  {
    const w = fixture(variant);
    crate(w, 0, 0, 'crate', 0);
    Object.assign(cpu(w), { state: 13, tgt: 1, t32: 0 });
    place(w, 1, 1400, 100);
    assert.equal(botInput(crateToss, w, 0).a, true);
    place(w, 1, 0, 1200);
    assert.equal(botInput(crateToss, w, 0).a, false);
  }
  // FUN_800b62ec with Square held near an opponent: a touching non-target opponent is spun on a 1-in-3 draw in state 2.
  {
    const w = fixture(variant);
    const wood = crate(w, 1200, 0);
    Object.assign(cpu(w), { state: 2, obj: wood.id });
    place(w, 1, 0, -200);
    let spins = 0;
    for (let r = 0; r < 60; r++) {
      w.data.cpuRandom = [r * 7919 + 1, 0x0573cec9];
      if (botInput(crateToss, w, 0).b) spins++;
    }
    assert.ok(spins > 5 && spins < 40, `${variant}: ${spins} spins of 60`);
  }
}

// FUN_800b432c: with only CPUs left, every slot has skill 26 and weight 16 except one drawn focus at 8 / 48.
{
  const w = fixture('jungle');
  w.data.cpuOnly = true;
  tick(w);
  const focus = w.data.cpuFocus;
  assert.ok(focus >= 0 && focus <= 3);
  assert.deepEqual(w.data.cpuSkill, [0, 1, 2, 3].map((s) => s === focus ? 8 : 26));
  assert.deepEqual(w.data.cpuWeight, [0, 1, 2, 3].map((s) => s === focus ? 48 : 16));
  player(w, focus).alive = false;
  tick(w);
  assert.equal(w.data.cpuFocus, undefined);
  tick(w);
  assert.ok(w.data.cpuFocus !== undefined && w.data.cpuFocus !== focus);
}

// Polling a copy matches polling the original.
{
  const w = match('snow', 31, 2);
  for (let i = 0; i < 200; i++) tick(w);
  assert.deepEqual(inputs(w), inputs(cloneWorld(w)));
}

console.log('Crate CPU controller regressions passed on all four stages.');
