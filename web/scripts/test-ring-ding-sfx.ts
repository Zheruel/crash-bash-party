// Run with npx tsx scripts/test-ring-ding-sfx.ts from web/.
import assert from 'node:assert/strict';
import { ringDing, type DDPlayer, type RingDingData } from '../shared/games/ringDing';
import { addBody } from '../shared/physics';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

// FUN_800b6044 / FUN_800b6608: 0x5ef plays once per bright phase of the last 30 recolour ticks (timer bit 1 set).
{
  const w = createWorld(ringDing, [0, 1, 2, 3].map((char, slot) => ({ slot, char, name: String(slot), bot: false })), [], 27);
  const d = w.data as RingDingData;
  d.tk = d.tc = 10000;
  const pads = [IDLE, IDLE, IDLE, IDLE];
  for (let i = 0; i < 200 && !d.B.some(o => o.ty !== 12 && o.st === 1); i++) stepWorld(w, ringDing, pads);
  assert.ok(d.B.some(o => o.ty !== 12), 'a colour balloon is live');
  d.rc = 40; d.rcO = 0; d.rcCue = 0;
  const at: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 45; i++) {
    stepWorld(w, ringDing, pads);
    for (const e of w.ev) if (e.k === 'flash' && !seen.has(e.id)) { seen.add(e.id); at.push(d.rc); }
  }
  assert.deepEqual(at, [27, 23, 19, 15, 11, 7, 3]);
  assert.equal(d.rc, 0);
}

// Without colour balloons nothing updates the flag, so the cue stays silent.
{
  const w = createWorld(ringDing, [0, 1, 2, 3].map((char, slot) => ({ slot, char, name: String(slot), bot: false })), [], 27);
  const d = w.data as RingDingData;
  d.tk = d.tc = d.tb = 10000;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  d.rc = 40;
  for (let i = 0; i < 45; i++) {
    stepWorld(w, ringDing, [IDLE, IDLE, IDLE, IDLE]);
    assert.ok(!w.ev.some(e => e.k === 'flash'));
  }
}
// Quiet arena: four Crash (engine character 1) with no spawns.
function quiet() {
  const w = createWorld(ringDing, [0, 1, 2, 3].map(slot => ({ slot, char: 0, name: String(slot), bot: false })), [], 27);
  const d = w.data as RingDingData;
  d.tk = d.tc = d.tb = 10000;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  const seats = d.P as DDPlayer[];
  [[-1700, 0], [0, -1600], [1750, 0], [0, 1600]].forEach(([x, z], s) => Object.assign(seats[s], { x, z }));
  const seen = new Set<number>();
  const fresh = (k: string) => w.ev.filter(e => e.k === k && !seen.has(e.id) && seen.add(e.id));
  return { w, d, seats, fresh };
}

// FUN_8008a924 / FUN_80087b8c: script 5 frames 9 and 20 of Crash's 22-frame run loop play 0xa and 0xb at the player.
{
  const { w, fresh } = quiet();
  const steps: number[][] = [];
  for (let frame = 0; frame < 50; frame++) {
    stepWorld(w, ringDing, [{ ...IDLE, x: 1 }, IDLE, IDLE, IDLE]);
    for (const e of fresh('footstep')) if (e.s === 0) steps.push([frame, e.v]);
  }
  assert.deepEqual(steps, [[9, 0xa], [20, 0xb], [31, 0xa], [42, 0xb]]);
}

// FUN_800b937c: event 9 (frame 1) plays 0x446 + slot, event 8 (Crash frame 11) the 0x11 voice once grounded.
{
  const { w, seats, fresh } = quiet();
  seats[2].pendingHit = 0;
  const cues: [number, string, number][] = [];
  for (let frame = 0; frame < 40; frame++) {
    stepWorld(w, ringDing, [IDLE, IDLE, IDLE, IDLE]);
    for (const e of [...fresh('hitsfx'), ...fresh('hitland')]) cues.push([frame, e.k, e.v]);
  }
  // The victim's first update enters 0x33 and shows frame 1, so event 9 fires on the entry update.
  assert.deepEqual(cues, [[0, 'hitsfx', 0x448], [10, 'hitland', 0x11]]);
}

// FUN_800b6044 draws rand(4) after the score for each colour pop and keys an id of the balloon's own type.
{
  const { w, d, fresh } = quiet();
  const bid = addBody(w, 'balloon', 1, 0, 0, 0.45, 1).id;
  d.B.push({ bid, ty: 9, ow: 2, x: 0, z: 0, hy: 768, angle: 0, dr: 0, da: 0, po: 4, pa: 0, st: 9, tf: false, tc: -1, ot: 0 });
  const rng = w.rng;
  stepWorld(w, ringDing, [IDLE, IDLE, IDLE, IDLE]);
  const [pop] = fresh('popsfx');
  assert.ok(pop && [0x5e0, 0x5e1, 0x5e2, 0x5e3].includes(pop.o));
  assert.notEqual(w.rng, rng);
}
console.log('ring ding sfx ok');
