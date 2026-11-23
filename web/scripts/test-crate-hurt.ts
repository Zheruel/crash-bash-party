// Hurt, knockout, power-up and crate sound timing from the USA overlay 0728. Run with npx tsx scripts/test-crate-hurt.ts.
import assert from 'node:assert/strict';
import { crateToss, CT_U, ctHurtKnockout, ctHurtTicks } from '../shared/games/crateToss';
import { DISC_CHARACTER } from '../shared/look';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type GameEvent, type InputState, type World } from '../shared/types';

function fixture(variant: string, char = 0, seats = 2) {
  const w = createWorld(crateToss, Array.from({ length: seats }, (_, slot) => ({ slot, name: 'P' + slot, char: slot ? 1 : char })), [], 432, variant);
  w.bodies = w.bodies.filter(b => b.kind === 'player' || b.kind === 'penguin');
  Object.assign(w.data, { tSpawn: 1e6, tFruit: 1e6, tBurst: 1e6, tPower: 1e6 });
  const p = w.bodies.find(b => b.kind === 'player' && b.slot === 0)!;
  Object.assign(p, { x: 0, z: 0 });
  return { w, p };
}
const step = (w: World, input: Partial<InputState> = {}) => {
  stepWorld(w, crateToss, [{ ...IDLE, ...input }]);
  return w.ev.filter((e: GameEvent) => e.t === w.tick - 1);
};
const cues = (ev: GameEvent[]) => ev.filter(e => e.k === 'cue').map(e => e.v);

for (const [char, disc] of DISC_CHARACTER.entries()) {
  // FUN_800bff1c: a lethal hit stays in script 9 until event 8, then counts the player out.
  const { w, p } = fixture('jungle', char);
  w.data.hp[0] = 3;
  w.data.pend[0] = { dmg: 5, cls: 2, by: 1, kx: 0, kz: 0, kv: 0 };
  let thud = -1;
  for (let frame = 0; frame < ctHurtKnockout(disc); frame++) {
    const ev = step(w);
    if (ev.some(e => e.k === 'thud')) thud = frame;
    assert.equal(p.alive, true, 'char ' + disc + ' frame ' + frame);
    assert.equal(w.data.hp[0], 0);
  }
  const ev = step(w);
  if (ev.some(e => e.k === 'thud')) thud = ctHurtKnockout(disc);
  assert.equal(p.alive, false);
  assert.ok(ev.some(e => e.k === 'ko' && e.o === 1));
  assert.equal(thud, disc === 3 || disc === 4 ? 13 : ctHurtKnockout(disc));

  // A survivable hit locks the pad for 30 updates, then flickers for 40.
  const s = fixture('jungle', char);
  s.w.data.pend[0] = { dmg: 1, cls: 0, by: 1, kx: 0, kz: 0, kv: 0 };
  for (let i = 0; i < 30; i++) {
    step(s.w, { x: 1, a: true, b: true, c: true });
    assert.equal(s.w.data.inv[0], i < 29 ? 0 : 40);
    assert.equal(s.w.data.air[0], false);
  }
  assert.equal(s.w.data.inv[0], 40);
  assert.equal(s.w.data.st[0], ctHurtTicks(disc) > 30 ? 4 : 0);
}

{
  // Aku Aku: the mask absorbs the hit, enters the hurt script without a lock, and ends with 0x421.
  const { w } = fixture('space');
  Object.assign(w.data, { eff: [0x12, 0, 0, 0], effT: [200, 0, 0, 0] });
  w.data.pend[0] = { dmg: 8, cls: 2, by: 1, kx: 0, kz: 0, kv: 0 };
  step(w);
  assert.equal(w.data.hp[0], 20);
  assert.equal(w.data.lock[0], 0);
  assert.deepEqual(cues(step(w)), [0x421]);
  assert.equal(w.data.eff[0], 0);
}

{
  // FUN_800bfd2c ends the boots; Drain hurt entry empties the weapon.
  const space = fixture('space');
  Object.assign(space.w.data, { eff: [0x13, 0, 0, 0], effT: [200, 0, 0, 0] });
  space.w.data.pend[0] = { dmg: 1, cls: 0, by: 1, kx: 0, kz: 0, kv: 0, snd: 0x446 };
  assert.deepEqual(cues(step(space.w)), [0x446]);
  assert.equal(space.w.data.eff[0], 0);
  const drain = fixture('drain');
  Object.assign(drain.w.data, { weapon: [1, 0, 0, 0], ammo: [3, 0, 0, 0] });
  drain.w.data.pend[0] = { dmg: 1, cls: 0, by: 1, kx: 0, kz: 0, kv: 0 };
  step(drain.w);
  assert.equal(drain.w.data.ammo[0], 0);
  assert.equal(drain.w.data.weapon[0], 0);
}

{
  // FUN_800c09f4: the weight counts its holder out at expiry and plays 0x453.
  const { w, p } = fixture('snow', 0, 3);
  Object.assign(w.data, { eff: [0x14, 0, 0, 0], effT: [1, 0, 0, 0], weight: 0 });
  const ev = step(w);
  assert.equal(p.alive, false);
  assert.equal(w.data.outBy[0], 1);
  assert.ok(cues(ev).includes(0x453));
}

{
  // FUN_800b7358: a player's effect does not block a power-up of another kind.
  const { w } = fixture('space');
  Object.assign(w.data, { eff: [0x13, 0, 0, 0], effT: [1000, 0, 0, 0], tPower: 0 });
  let spawned = false;
  for (let i = 0; i < 60 && !spawned; i++) {
    const ev = step(w);
    spawned = cues(ev).includes(0x41f);
    if (spawned) assert.ok(w.bodies.some(b => ['potion', 'mask', 'weight'].includes(b.kind)));
  }
  assert.ok(spawned);
}

{
  // FUN_800bc038: lit TNT beeps at 60, 30 and 0, then explodes on the next update.
  const { w } = fixture('jungle');
  const c = { ...w.bodies[0], id: w.nextId++, kind: 'tnt', slot: -1, x: 1000 * CT_U, z: 1000 * CT_U, y: 0, alive: true, fall: false, cd: 0, dash: 0, r: 120 * CT_U };
  w.bodies.push(c);
  w.data.cs[c.id] = { s: 1, t: 0, hv: 0, vv: 0, up: false, dx: 0, dz: 0, own: -1, fuse: 90, kt: 0, item: 0 };
  c.fall = true;
  const beeps: number[] = [];
  let blast = -1;
  for (let i = 1; i <= 95 && blast < 0; i++) {
    const ev = step(w);
    if (ev.some(e => e.k === 'beep')) beeps.push(i);
    if (ev.some(e => e.k === 'explode')) blast = i;
  }
  assert.deepEqual(beeps, [30, 60, 90]);
  assert.equal(blast, 91);
}

{
  // FUN_800b879c: touching the sleeping penguin does nothing; a thrown crate wakes it.
  const { w, p } = fixture('snow');
  const g = w.bodies.find(b => b.kind === 'penguin')!;
  Object.assign(p, { x: 300 * CT_U, z: 0 });
  for (let i = 0; i < 10; i++) step(w, { x: -1 });
  assert.equal(w.data.peng.s, 1);
  assert.ok(Math.hypot(p.x, p.z) >= 332 * CT_U - 1e-9);
  const c = { ...p, id: w.nextId++, kind: 'crate', slot: -1, x: 400 * CT_U, z: 0, y: 200 * CT_U, cd: 0, dash: 1, r: 120 * CT_U };
  w.bodies.push(c);
  w.data.cs[c.id] = { s: 3, t: 0, hv: 60, vv: 0, up: false, dx: -1, dz: 0, own: 1, fuse: 0, kt: 0, item: 0 };
  Object.assign(p, { x: -1500 * CT_U, z: -1500 * CT_U });
  step(w);
  const woke = step(w);
  assert.equal(w.data.peng.s, 2);
  assert.ok(cues(woke).includes(0x426));
  let wake = 0;
  while (w.data.peng.s === 2) { step(w); wake++; }
  assert.equal(wake, 73);
  let run = 0, far = 0;
  while (w.data.peng.s === 3) { step(w); run++; far = Math.max(far, Math.hypot(g.x, g.z) / CT_U); }
  assert.equal(run, 513);
  assert.ok(far > 1270 && far < 1282, String(far));
  assert.equal(w.data.peng.e, 2);
}

console.log('Crate Crush hurt, knockout, power-up, penguin and crate cue timing passed.');
