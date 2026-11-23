// Run with npx tsx scripts/test-crate-cpu.ts from web/.
import assert from 'node:assert/strict';
import { crateToss, CT_U, ctHurtKnockout, ctHurtTicks, spaceFloorIndex } from '../shared/games/crateToss';
import { addBody } from '../shared/physics';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE, type World } from '../shared/types';

const variants = ['jungle', 'space', 'snow', 'drain'] as const;
const positions = [[0, 0], [1150, -1100], [1480, -1100], [1800, -1250]] as const;

function fixture(variant: string, level: number, mixed: boolean) {
  const seats = positions.map((_, slot) => ({ slot, name: String(slot), bot: !mixed || slot !== 3, level, char: [0, 8, 9, 2][slot] }));
  const w = createWorld(crateToss, seats, [], 432, variant);
  w.bodies = w.bodies.filter((b) => b.kind === 'player');
  w.tick = 100;
  w.rng = 46; // The web roaming draw is zero for all four stages on tick 100.
  Object.assign(w.data, { tSpawn: 10000, tFruit: 10000, tBurst: 10000, tPower: 10000 });
  for (const [slot, [x, z]] of positions.entries()) {
    position(w, slot, x, z);
    cpu(w, slot).tauntAt = 10000;
  }
  return w;
}

const player = (w: World, slot: number) => w.bodies.find((b) => b.kind === 'player' && b.slot === slot)!;
const cpu = (w: World, slot = 0) => w.data.cpu[slot];
const input = (w: World, slot = 0) => crateToss.bot!(w, slot);

function position(w: World, slot: number, x: number, z: number, face = Math.PI / 2) {
  Object.assign(player(w, slot), { x: x * CT_U, z: z * CT_U, face });
  w.data.f8[slot] = face;
}

function tick(w: World) {
  // Advance the real planner via stepWorld while the scripted player positions stay fixed.
  stepWorld(w, crateToss, []);
}

function crate(w: World, x: number, z: number, kind = 'crate', holder?: number) {
  const obj = addBody(w, kind, -1, x * CT_U, z * CT_U, 120 * CT_U, 1);
  obj.cd = holder === undefined ? 0 : holder + 1;
  w.data.cs[obj.id] = { s: holder === undefined ? 1 : 2, t: 0, hv: 0, vv: 0, up: false, dx: 0, dz: 0, own: holder ?? -1, fuse: 0, kt: 0, item: 0 };
  return obj;
}

// FUN_800bff1c counts a lethal hit out at hurt event 8. The fixture starts one update before that event.
function eliminate(w: World, slot: number) {
  const char = w.data.char[slot];
  Object.assign(w.data, { dying: [-2, -2, -2, -2].map((v, i) => i === slot ? -1 : w.data.dying?.[i] ?? v) });
  w.data.hp[slot] = 0;
  w.data.st[slot] = w.data.act[slot] = 4;
  w.data.stT[slot] = ctHurtTicks(char) - ctHurtKnockout(char);
  tick(w);
  assert.equal(player(w, slot).alive, false);
}

for (const variant of variants) for (const level of [0, 1, 2]) {
  for (const mixed of [true, false]) {
    // L0–L3 ROM selection traces, with the native stage roaming draw also held at zero.
    const w = fixture(variant, level, mixed);
    assert.deepEqual(w.data.char, [1, 3, 3, 5]); // Disc stats for both custom characters.
    assert.equal(cpu(w).skill, [1, 16, variant === 'drain' ? 28 : 32][level]);
    const before = cloneWorld(w);
    assert.deepEqual(input(w), IDLE);
    assert.deepEqual(input(w), input(cloneWorld(w)));
    assert.deepEqual(w, before);
    tick(w);
    assert.equal(w.data.cpuFocus, undefined);
    assert.equal(cpu(w).target, level === 2 ? player(w, 1).id : -2); // ROM slot 1 or station ID 8.
    assert.notEqual(input(w).x, 0);

    for (const route of ['object', 'opponent', 'station'] as const) {
      const interrupted = fixture(variant, level, mixed);
      const wood = crate(interrupted, -800, 0);
      const hazards = [crate(interrupted, 352, 120, 'nitro'), crate(interrupted, 608, 120, 'nitro')];
      cpu(interrupted).target = { object: wood.id, opponent: player(interrupted, 1).id, station: -2 }[route];
      tick(interrupted);
      assert.equal(cpu(interrupted).target, 0);
      assert.equal(cpu(interrupted).resumeFrom, route);
      assert.equal(cpu(interrupted).retreatUntil, 130);
      hazards.forEach((obj) => { obj.alive = false; });
      for (let i = 0; i < 29; i++) {
        assert.notDeepEqual(input(interrupted), IDLE);
        tick(interrupted);
        assert.equal(cpu(interrupted).target, 0);
      }
      assert.deepEqual(input(interrupted), IDLE);
      tick(interrupted); // The native retreat-to-search transition emits no pad.
      assert.equal(cpu(interrupted).resumeFrom, route);
      interrupted.rng = 1; // A zero roaming draw at tick 131 on every stage.
      tick(interrupted);
      assert.equal(cpu(interrupted).resumeFrom, undefined);
      assert.equal(cpu(interrupted).target, route === 'object'
        ? level === 2 ? player(interrupted, 1).id : -2
        : wood.id);
    }
  }

  const all = fixture(variant, level, false);
  eliminate(all, 3);
  assert.equal(all.data.cpuFocus, undefined);
  assert.equal(all.data.cpuOnly, true);
  all.rng = 0; // Focus selects slot 0. Slot 1's carry draw falls within its 48-point interval.
  crate(all, 1100, -1100, 'crate', 1);
  cpu(all, 1).target = 0;
  const pending = cloneWorld(all);
  assert.deepEqual(input(all, 1), input(cloneWorld(all), 1));
  assert.deepEqual(all, pending); // Polling leaves focus and RNG untouched.
  tick(all);
  assert.equal(all.rng, 0);
  assert.equal(all.data.cpuFocus, 0);
  assert.equal(cpu(all, 1).target, player(all, 0).id);

  const roaming = cloneWorld(all);
  roaming.bodies = roaming.bodies.filter((b) => b.kind === 'player');
  roaming.rng = 23; // Zero roaming draw at tick 102.
  cpu(roaming).target = 0;
  tick(roaming);
  assert.equal(cpu(roaming).target, -2); // Focus skill 8 makes the station win at every configured difficulty.

  const taunt = cloneWorld(all);
  taunt.bodies = taunt.bodies.filter((b) => b.kind === 'player');
  [0, -1500, 1500].forEach((z, slot) => {
    position(taunt, slot, 0, z);
    Object.assign(cpu(taunt, slot), { tauntAt: 0, target: 0 });
  });
  assert.equal(input(taunt).d, true); // Skill 8 taunts past 1280 raw.
  assert.equal(input(taunt, 1).d, undefined); // Skill 26 waits until past 1856 raw.

  eliminate(all, 0);
  assert.equal(all.data.cpuFocus, 0);
  tick(all);
  assert.equal(all.data.cpuFocus, undefined);
  tick(all);
  assert.ok(all.data.cpuFocus === 1 || all.data.cpuFocus === 2);

  const mixed = fixture(variant, level, true);
  tick(mixed);
  mixed.rng = 0;
  crate(mixed, 1100, -1100, 'crate', 1);
  cpu(mixed, 1).target = 0;
  tick(mixed);
  assert.equal(cpu(mixed, 1).target, player(mixed, 2).id); // Equal weights while a human is still in play.
  eliminate(mixed, 2);
  assert.equal(mixed.data.cpuOnly, undefined);
  eliminate(mixed, 3);
  tick(mixed);
  assert.equal(mixed.data.cpuOnly, true);
  assert.ok(mixed.data.cpuFocus === 0 || mixed.data.cpuFocus === 1);
}

// Station 8 precedes a farther station, and even a missing tile under it passes the native scan.
{
  const w = fixture('space', 1, true);
  w.data.hp[0] = 14;
  [[1100, 100], [1400, 230], [1750, 380]].forEach(([x, z], i) => position(w, i + 1, x, z));
  w.data.floor[spaceFloorIndex(-1920 * CT_U, 1920 * CT_U)] = 0;
  tick(w);
  assert.equal(cpu(w).target, -2);
}

{
  const w = fixture('jungle', 1, true);
  position(w, 1, -1800, 1800);
  player(w, 1).alive = false;
  tick(w);
  assert.equal(cpu(w).target, -4); // The eliminated slot disqualifies station 8. ROM picks ID 10.
}

{
  const w = fixture('jungle', 1, true);
  for (const slot of [1, 2, 3]) position(w, slot, 0, 0);
  cpu(w).resumeFrom = 'object';
  tick(w);
  assert.equal(cpu(w).target, 0);
  assert.equal(cpu(w).resumeFrom, undefined); // Roaming won, but the station scan found no match.
}

{
  const w = fixture('jungle', 2, true);
  cpu(w).resumeFrom = 'opponent';
  tick(w);
  assert.equal(cpu(w).target, 0);
  assert.equal(cpu(w).resumeFrom, 'opponent');
  const wood = crate(w, -800, 0);
  tick(w);
  assert.equal(cpu(w).target, wood.id);
  assert.equal(cpu(w).resumeFrom, undefined);
}

{
  const w = fixture('space', 1, true);
  const target = player(w, 1);
  cpu(w).target = target.id;
  crate(w, 352, 120, 'nitro');
  assert.equal(input(w).c, true);
  stepWorld(w, crateToss, [input(w)]);
  assert.equal(w.data.air[0], true);
  assert.equal(cpu(w).target, target.id);
  assert.equal(cpu(w).resumeFrom, undefined);
}

{
  const w = fixture('jungle', 1, true);
  const wood = crate(w, -800, 0);
  const hazards = [crate(w, 352, 120, 'nitro'), crate(w, 608, 120, 'nitro')];
  cpu(w).target = wood.id;
  tick(w);
  assert.equal(cpu(w).resumeFrom, 'object');
  tick(w); // Another obstruction while retreating replaces the saved route with retreat itself.
  assert.equal(cpu(w).resumeFrom, 'retreat');
  assert.equal(cpu(w).retreatUntil, 131);
  hazards.forEach((obj) => { obj.alive = false; });
  while (w.tick <= 132) tick(w);
  assert.equal(cpu(w).target, wood.id);
  assert.equal(cpu(w).resumeFrom, undefined);
}

{
  const w = fixture('jungle', 1, true);
  cpu(w).target = -2;
  position(w, 0, -1792, 1920, 3 * Math.PI / 4);
  assert.equal(input(w).d, undefined); // Exactly 128 raw from the station.
  position(w, 0, -1793, 1920, 3 * Math.PI / 4);
  assert.equal(input(w).d, true);
  tick(w);
  assert.equal(cpu(w).tauntAt, 400);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(input(w), IDLE);
    tick(w);
  }
  assert.equal(cpu(w).target, 0);
}

console.log('Crate CPU ROM regressions passed for four stages, three difficulties and both room types.');
