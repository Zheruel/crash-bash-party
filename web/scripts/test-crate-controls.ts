// Captured from USA L0–L3. Run with npx tsx scripts/test-crate-controls.ts.
import assert from 'node:assert/strict';
import { crateToss, CT_OPENING_TICKS, CT_U, ctActionTicks, ctFruitRise } from '../shared/games/crateToss';
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
    let release = 0, voice = 0;
    for (let n = 1; n <= ctActionTicks(disc, 2); n++) {
      step(w);
      if (w.ev.some(e => e.k === 'throwVoice' && e.t === w.tick - 1)) voice = n;
      if (w.ev.some(e => e.k === 'throw' && e.t === w.tick - 1)) release = n;
    }
    assert.equal(crate.cd, 0);
    assert.equal(voice, disc === 5 ? 1 : release);
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
// Running, skating with both feet planted, coming to rest, and restarting on the ice.
for (const [char, disc] of DISC_CHARACTER.entries()) {
  const { w, p, crate } = fixture('snow', char);
  w.bodies = [p];
  p.x = -1000 * CT_U;
  assert.deepEqual(w.data.groundPose[0], { script: 1, frame: CT_OPENING_TICKS });
  const steps = [];
  for (let i = 0; i < 25; i++) {
    step(w, { x: 1 });
    assert.deepEqual(w.data.groundPose[0], { script: 5, frame: i });
    for (const e of w.ev) if (e.k === 'step' && e.t === w.tick - 1) steps.push([i, e.v]);
  }
  const left = [9, 8, 1, 1, 1, 1, 4, 1][disc - 1];
  const right = [20, 19, 12, 12, 11, 11, 13, 11][disc - 1];
  assert.deepEqual(steps.slice(0, 2), [[left, 0], [right, 1]]);
  step(w);
  assert.deepEqual(w.data.groundPose[0], { script: 1, frame: 0 });
  step(w);
  const scrape = w.data.groundPose[0].scrape;
  assert(scrape >= 0x456 && scrape <= 0x45b);
  const rejoined = cloneWorld(w);
  for (let i = 2; i <= 44; i++) {
    step(w);
    step(rejoined);
    assert.deepEqual(w.data.groundPose[0], { script: 14, frame: i, scrape });
    assert.deepEqual(w.data.groundPose[0], rejoined.data.groundPose[0]);
  }
  assert.equal(w.data.vx[0], 0);
  step(w);
  assert.deepEqual(w.data.groundPose[0], { script: 1, frame: 1 });
  // Bring the crate into range and check that its authored foot contacts only play during carry walk.
  w.bodies.push(crate);
  Object.assign(crate, { x: p.x + 350 * CT_U, z: p.z });
  w.data.f8[0] = Math.PI / 2;
  step(w, { a: true });
  for (let i = 0; i < ctActionTicks(disc, 1); i++) step(w);
  const carrySteps = [];
  for (let i = 0; i < 24; i++) {
    step(w, { x: -1 });
    for (const e of w.ev) if (e.k === 'carryStep' && e.t === w.tick - 1) carrySteps.push([i, e.v]);
  }
  const carryContacts = [[7, 19], [9, 20], [0, 12], [0, 12], [0, 10], [0, 10], [0, 12], [0, 10]][disc - 1];
  assert.deepEqual(carrySteps.slice(0, 2), carryContacts.map((frame, foot) => [frame, foot]));
  step(w);
  assert.equal(w.data.cs[crate.id].gripScript, 16);
  assert.equal(w.data.groundPose[0].script, 0);
  assert(w.data.vx[0] < 0);
}
const seats = [8, 9, 0, 1].map((char, slot) => ({ slot, name: String(slot), bot: false, char }));
for (const [variant, limits] of Object.entries({ jungle: [12,10,8], snow: [12,10,8], space: [14,12,10], drain: [6,6,6] })) {
  const w = createWorld(crateToss, seats, [], 432, variant);
  const boxes = (world: World) => world.bodies.filter(b => ['crate', 'tnt', 'nitro'].includes(b.kind));
  assert.equal(boxes(w).length, limits[2]);
  assert(boxes(w).every(b => w.data.cs[b.id].s === 1 && w.data.openingSpawns[b.id] === 0));
  const fruits = w.bodies.filter(b => b.kind === 'fruit');
  assert.equal(fruits.length, 3);
  for (const f of fruits) assert.equal(f.cd, CT_OPENING_TICKS - w.data.openingSpawns[f.id]);
  if (variant === 'drain') {
    const chests = w.bodies.filter(b => b.kind === 'chest');
    assert.equal(chests.length, 4);
    const remaining = cloneWorld(w);
    const removed = boxes(remaining)[0];
    remaining.bodies = remaining.bodies.filter(b => b.id !== removed.id);
    remaining.data.tSpawn = 0;
    step(remaining);
    assert.equal(boxes(remaining).length, 5);
    assert.equal(chests.filter(b => w.data.cs[b.id].item !== 0).length, 1);
    for (const c of chests) {
      assert([c.x, c.z].some(v => Math.abs(Math.round(v / CT_U)) === 1664));
      assert(w.data.openingSpawns[c.id] >= 30 && w.data.openingSpawns[c.id] < 60);
      assert.equal(w.data.cs[c.id].s, 1);
    }
  }
  const go = cloneWorld(w);
  const box = boxes(go).find(b => b.kind === 'crate')!;
  const player = go.bodies.find(b => b.kind === 'player' && b.slot === 0)!;
  Object.assign(player, { x: box.x, z: box.z - 256 * CT_U, face: 0 });
  go.data.f8[0] = 0;
  step(go, { a: true });
  assert.equal(box.cd, 1, variant + ' first-frame pickup');

  for (const survivors of [2, 3, 4]) {
    const world = cloneWorld(w);
    world.bodies = world.bodies.filter(b => b.kind === 'player');
    for (const p of world.bodies) p.alive = p.slot < survivors;
    world.data.tFruit = world.data.tPower = 9999;
    world.data.deck.fill(variant === 'drain' ? 3 : 6);
    for (let tick = 0; tick < 40; tick++) {
      world.data.tSpawn = 0;
      step(world);
    }
    assert.equal(boxes(world).length, limits[survivors - 2]);
    const nitro = variant === 'drain' ? 0 : variant === 'space' || survivors !== 2 ? 2 : 3;
    assert.equal(boxes(world).filter(b => b.kind === 'nitro').length, nitro);
  }
}
assert.deepEqual(Array.from({ length: 16 }, (_, i) => Math.round(ctFruitRise(i) / CT_U)),
  [0,56,104,144,176,200,216,224,224,216,200,176,144,104,56,0]);

// USA Drain Bash, Brio's pickup and throw. Coordinates use the web Z convention.
for (const edge of [false, true]) {
  const w = createWorld(crateToss, [4, 2].map((disc, slot) => ({
    slot, char: DISC_CHARACTER.indexOf(disc), bot: false, name: 'P' + slot,
  })), [], 538, 'drain');
  const ps = w.bodies.filter(b => b.kind === 'player');
  const chest = w.bodies.find(b => b.kind === 'chest')!;
  w.bodies = [...ps, chest];
  w.data.tPower = w.data.tSpawn = w.data.tFruit = 100000;
  Object.assign(ps[0], { x: 128 * CT_U, z: (edge ? 647 : -634) * CT_U, face: 0 });
  w.data.f8[0] = 0;
  Object.assign(ps[1], { x: -1846 * CT_U, z: -1755 * CT_U });
  Object.assign(chest, { x: 128 * CT_U, z: (edge ? 896 : -384) * CT_U });
  w.data.cs[chest.id].item = 25;
  for (let frame = 120; frame <= 200; frame++) {
    if (!edge && frame === 175) Object.assign(ps[1], { x: 93 * CT_U, z: 1267 * CT_U });
    step(w, { a: frame <= 122 || frame === 152 || frame === 153 });
    if (frame === 154) assert.deepEqual([chest.x, chest.y, chest.z].map(v => Math.round(v / CT_U)), [120, 352, edge ? 1059 : -222]);
    if (frame === 166) assert(chest.alive);
    if (edge && frame === 167) assert.equal(chest.alive, false);
    if (!edge && frame === 174) assert.deepEqual([chest.x, chest.y, chest.z].map(v => Math.round(v / CT_U)), [93, 420, 1267]);
    if (!edge && frame === 199) assert.equal(w.data.ammo[1], 0);
  }
  assert.equal(w.data.ammo[0], 0);
  assert.equal(w.data.ammo[1], edge ? 0 : 2);
}

// USA Drain Bash, Rilla Roo's diagonal throw from release until the crate opens.
{
  const w = createWorld(crateToss, [6, 1].map((disc, slot) => ({
    slot, char: DISC_CHARACTER.indexOf(disc), bot: false, name: 'P' + slot,
  })), [], 538, 'drain');
  const ps = w.bodies.filter(b => b.kind === 'player');
  const chest = w.bodies.find(b => b.kind === 'chest')!;
  w.bodies = [...ps, chest];
  w.data.tPower = w.data.tSpawn = w.data.tFruit = 100000;
  Object.assign(ps[0], { x: -49 * CT_U, z: -561 * CT_U, face: Math.PI / 4 });
  w.data.f8[0] = ps[0].face;
  Object.assign(ps[1], { x: -1846 * CT_U, z: -1755 * CT_U });
  Object.assign(chest, { x: 128 * CT_U, z: -384 * CT_U });
  w.data.cs[chest.id].item = 25;
  const positions = [
    [381, 379, 56], [472, 373, 146], [559, 361, 232], [643, 343, 315],
    [723, 319, 394], [800, 289, 470], [873, 253, 542], [943, 211, 611],
    [1009, 163, 676], [1072, 109, 738], [1131, 49, 796], [1187, 0, 851],
  ];
  for (let frame = 120; frame <= 168; frame++) {
    step(w, { a: frame <= 122 || frame === 152 || frame === 153 });
    if (frame >= 157) {
      assert.deepEqual([chest.x, chest.y, chest.z].map(v => Math.round(v / CT_U)), positions[frame - 157]);
    }
  }
}
console.log('Crate Crush countdown, controls, movement poses and crate throws passed.');
