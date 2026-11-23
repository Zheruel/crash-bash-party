import assert from 'node:assert/strict';
import { tankArena } from '../shared/games/tankArena';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type InputState, type World } from '../shared/types';

// Pilot script cycle, grid turn cue, hurt voice takes and the bomb blast height (overlay 0726).
const humans = [0, 1, 2, 3].map(slot => ({ char: 0, slot, name: String(slot), bot: false }));
const step = (w: World, input: Partial<InputState> = {}) => stepWorld(w, tankArena, [{ ...IDLE, ...input }]);
const sounds = (w: World, id: number) => w.ev.filter(e => e.k === 'sfx' && e.v === id);

// FUN_800b906c: a right-angle change at a tile centre plays 0x4fd + seat and restarts idle 0x59.
// FUN_800c7db8: the 0x6e enter at the end of the eight-tick turn restarts idle again.
for (const variant of ['desert', 'metal']) {
  const w = createWorld(tankArena, humans, [], 7, variant);
  const t = w.data.tk[0];
  Object.assign(t, { x: 256, z: 256, dir: 2 });
  step(w, { a: true });
  assert.equal(t.anim, 0x5d);
  step(w, { x: 1 });
  assert.equal(t.st, 0x6f);
  assert.equal(t.anim, 0x59);
  assert.equal(sounds(w, 0x4fd).length, 1);
  for (let i = 0; i < 8; i++) step(w, { x: 1 });
  assert.equal(t.st, 0x6e);
  assert.equal(t.animN, 0);
}

// FUN_800b6ed8: each finished pilot script advances the CPU counter. At 80 it taunts with script 0x5a.
{
  const w = createWorld(tankArena, humans.map((s, slot) => ({ ...s, bot: slot > 0 })), [], 3, 'jungle');
  const cpu = w.data.tk[1];
  cpu.ai.idle = 78;
  Object.assign(cpu, { anim: 0x59, animN: 19, hp: 1 });
  cpu.ai.timer = 99; // keep the AI from replacing the pad this tick
  step(w);
  assert.equal(cpu.ai.idle, 79);
  assert.equal(cpu.anim, 0x59);
  cpu.animN = 19;
  step(w);
  assert.equal(cpu.ai.idle, 0);
  assert.equal(cpu.anim, 0x5a);
  assert.equal(cpu.taunt, 0, 'the CPU taunt leaves the human taunt cooldown alone');
  assert(w.ev.some(e => e.k === 'taunt' && e.s === 1));
}

// FUN_800ba964 draws the hurt voice take; FUN_800bc27c lands at y = -0x104 and plays script 1 there.
{
  const w = createWorld(tankArena, humans, [], 11, 'metal');
  const [shooter, target] = w.data.tk;
  Object.assign(shooter, { wpn: 3, ammo: 1, x: 1280, z: 256, yaw: 0xc00 });
  Object.assign(target, { x: 2304, z: 256 });
  let blast;
  for (let i = 0; i < 40 && !blast; i++) {
    step(w, { a: i === 0 });
    blast = w.ev.find(e => e.k === 'bombBlast');
  }
  assert(blast, 'the bomb exploded');
  const voice = w.ev.find(e => e.k === 'hitVoice');
  if (voice) assert(voice.v >= 0 && voice.v < 4);
}

console.log('Tank Wars pilot scripts, turn cues, hurt voices and bomb blasts passed.');
