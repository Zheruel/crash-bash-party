// Captured from USA L0–L3. Run with npx tsx scripts/test-crate-controls.ts.
import assert from 'node:assert/strict';
import { crateToss, CT_U, ctActionTicks } from '../shared/games/crateToss';
import { DISC_CHARACTER } from '../shared/look';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { readsCountdownPad } from '../shared/protocol';
import { IDLE, type InputState, type World } from '../shared/types';
import { playerPose } from '../client/games/playerPose';

function fixture(variant: string, char: number, bot = false) {
  const w = createWorld(crateToss, [{ slot: 0, name: 'P1', bot, char }], [], 432, variant);
  const p = w.bodies.find(b => b.kind === 'player')!;
  Object.assign(p, { x: 0, z: 0, face: 0 });
  w.data.f8[0] = 0;
  const crate = w.bodies.find(b => ['crate', 'nitro', 'tnt'].includes(b.kind))!;
  Object.assign(crate, { kind: 'crate', x: 1200 * CT_U, z: 350 * CT_U, y: 0 });
  w.data.cs[crate.id].s = 1;
  w.bodies = [p, crate];
  return { w, p, crate };
}
const step = (w: World, input: Partial<InputState> = {}) => stepWorld(w, crateToss, [{ ...IDLE, ...input }]);

const lightHold = [98,186,264,332,390,438,476,504,522,530,530,512,484,446,398,340,272,194,106,8,-100,0];
const cocoHold = lightHold.filter((_, i) => i !== 10);
const heavyHold = [66,126,180,228,270,306,336,360,378,390,396,396,396,378,350,312,264,206,138,60,-28,0];
const lightTap = [98,156,204,242,270,288,296,296,278,250,212,164,106,38,-40,0];
const heavyTap = [66,92,112,126,134,136,136,118,90,52,4,-54,0];

assert(readsCountdownPad(crateToss.id));
for (const variant of ['jungle', 'space', 'snow', 'drain']) {
  for (const [char, disc] of DISC_CHARACTER.entries()) {
    for (const held of [true, false]) {
      const { w, p } = fixture(variant, char);
      crateToss.primeCountdownPad!(w, 0, { ...IDLE, c: true });
      step(w, { c: true });
      assert.equal(w.data.air[0], false);
      step(w);
      const heights = held ? disc >= 5 ? heavyHold : disc === 2 ? cocoHold : lightHold : disc >= 5 ? heavyTap : lightTap;
      heights.forEach((rawY, i) => {
        step(w, { c: held || i === 0 });
        assert.equal(Math.round(p.y / CT_U), rawY, variant + ' char ' + char + ' frame ' + i);
      });
      assert.equal(w.data.air[0], false);
      assert.equal(w.data.landedAt[0], w.tick);
      assert(playerPose(8, disc, 1));
    }
    const { w, p, crate } = fixture(variant, char);
    for (let i = 0; i < 20; i++) { step(w, { a: true }); assert.equal(w.data.act[0], 0); }
    crate.x = 0;
    step(w, { a: true, c: true });
    assert.equal(crate.cd, 1);
    assert.equal(w.data.act[0], 1);
    for (let i = 0; i <= ctActionTicks(disc, 1); i++) step(w, { a: true });
    step(w, { a: true, c: true });
    assert.equal(w.data.air[0], false);
    assert.equal(w.data.act[0], 0);
    step(w, { x: 1, a: true });
    assert.equal(w.data.cs[crate.id].gripScript, 17);
    const copy = cloneWorld(w);
    const x = p.x;
    step(w, { x: 1, a: true });
    step(copy, { x: 1, a: true });
    assert.deepEqual(w, copy);
    assert(p.x > x);
    assert.equal(w.data.act[0], 2);
    let release = 0;
    for (let n = 1; n <= ctActionTicks(disc, 2); n++) {
      step(w);
      if (w.ev.some(e => e.k === 'throw' && e.t === w.tick - 1)) release = n;
    }
    assert.equal(crate.cd, 0);
    assert.equal(release, [8, 8, 2, 2, 5, 5, 8, 6][disc - 1]);
  }
  for (const b of [false, true]) {
    const { w } = fixture(variant, 9);
    step(w, { a: true, b, c: true });
    assert.equal(w.data.air[0], !b);
    assert.equal(w.data.act[0], b ? 3 : 0);
  }
}

{
  const { w, p } = fixture('jungle', 2, true);
  lightHold.forEach((height, i) => {
    step(w, { c: i === 0 });
    assert.equal(Math.round(p.y / CT_U), height);
  });
}
{
  const { w, p, crate } = fixture('snow', 5);
  w.bodies = [p];
  delete w.data.cs[crate.id];
  p.x = -1000 * CT_U;
  for (let i = 1; i <= 25; i++) {
    step(w, { x: 1 });
    assert.equal(w.data.vx[0], Math.min(45, 2 * i));
    if (i === 23) assert.equal(Math.round(p.x / CT_U), -449);
  }
  step(w);
  assert.equal(w.data.vx[0], 44);
  step(w, { x: -1, y: -1, c: true });
  assert.equal(w.data.vx[0], 12);
  assert.equal(w.data.vz[0], -31.75);
  const before = p.z;
  step(w, { x: -1, y: -1, c: true });
  assert.equal(Math.round((p.z - before) / CT_U), -31);
  step(w);
  assert.equal(w.data.vz[0], 0);
}
console.log('Crate Crush countdown, pickup, throw, jumps, landing and Snow Bash steering passed.');
