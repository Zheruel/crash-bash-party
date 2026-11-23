// Run with npx tsx scripts/test-ring-ding-sfx.ts from web/.
import assert from 'node:assert/strict';
import { ringDing, type RingDingData } from '../shared/games/ringDing';
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
console.log('ring ding sfx ok');
