import assert from 'node:assert/strict';
import { BallistixResult, ballistixCupDelay, ballistixResultEntry } from '../client/games/ballDefenceResult';
import { LEVEL_CAMS } from '../client/games/ps1cam';
import { ballDefence, ballistixFloor, BD_U, stepBallistixResultArena, type BallistixData } from '../shared/games/ballDefence';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import type { World } from '../shared/types';

const seats = [6, 1, 8, 9].map((char, slot) => ({ slot, char, bot: false }));

// A spectator arriving after the second knockout resumes the first barrier's loop.
for (const variant of ['crashball', 'beach', 'nballism', 'sky']) {
  const w = createWorld(ballDefence, seats, [], 47, variant);
  w.data.pl[0].score = 0;
  stepWorld(w, ballDefence, []);
  assert.equal(w.data.wallSoundAt, 1);
  for (let i = 0; i < 12; i++) stepWorld(w, ballDefence, []);
  w.data.pl[2].score = 0;
  stepWorld(w, ballDefence, []);
  const saved = cloneWorld(w).data as BallistixData;
  assert.equal(saved.walls, 9);
  assert.equal(saved.wallSoundAt, 1);
  assert.deepEqual(w.ev.filter(e => e.k === 'sfx' && e.o === 1425).map(e => e.t), [0]);
}

function fixture(variant: string, slot: number) {
  const w = createWorld(ballDefence, seats, [], 47, variant);
  for (let f = 0; f < 12; f++) stepWorld(w, ballDefence, []);
  Object.assign(w.data.balls[0], { st: 1, x: 200, y: -96, z: 375, h: 100, spd: 48, tgt: 48, land: true, fl: 0x400 });
  (w.data as BallistixData).pl.forEach((p, s) => Object.assign(p, {
    score: s === slot ? 5 : 0, st: s === slot ? 0x1c : 0x24, stateAt: 100,
  }));
  w.data.f = 100;
  w.data.walls = 15;
  return w;
}

function ship(result: BallistixResult, w: World) {
  const body = w.bodies.find(b => b.kind === 'player' && b.slot === result.slot)!;
  const { body: b, y, roll, pose } = result.winnerBody(body, w.data as BallistixData);
  return [b.x * BD_U, y, -b.z * BD_U, Math.round(-b.face * 2048 / Math.PI) & 4095, roll, pose];
}

{
  // In the L14 contact capture the rolling ball reaches the winning hull two
  // callbacks into its ship script. The verdict and score are already fixed.
  const w = fixture('crashball', 0);
  Object.assign(w.data.pl[0], { x: 576, roll: -52 });
  Object.assign(w.data.balls[0], { x: 796, z: -1660, h: 0, spd: 48, tgt: 48 });
  const result = new BallistixResult(w, 0, 101, LEVEL_CAMS[14], false);
  const hits: number[] = [];
  for (let f = 100; f <= 103; f++) {
    w.data.f = f;
    result.advance(w, 0, undefined, e => { if (e.k === 'hit') hits.push(f); });
  }
  assert.deepEqual(hits, [103]);
  assert.equal(w.data.balls[0].z, -1660);
}

const translation = ({ camera: { x, y, z } }: BallistixResult) => [x, y, z];
const quiet = () => {};

{
  // USA L14 capture: Koala, seat 0 with lateral x = 576, verdict at 4717.
  const w = fixture('crashball', 0);
  Object.assign(w.data.pl[0], { x: 576, roll: -56 });
  assert.equal(ballistixResultEntry(w, 0), 101);
  const result = new BallistixResult(w, 0, 101, LEVEL_CAMS[14], false);
  for (const row of [
    { frame: 0, ship: [576, -128, -2176, 2048, -42, undefined], cam: [0, 0, 3327] },
    { frame: 1, ship: [576, -128, -2144, 2560, -32, 0x4281], cam: [0, 0, 3327] },
    { frame: 28, ship: [576, -128, -1280, 4093, -3, 0x429c], cam: [0, 0, 3327] },
    { frame: 29, ship: [576, -128, -1280, 4093, -3, 0x429d], cam: [-35, 16, 3216] },
    { frame: 89, ship: [576, -128, -1280, 4093, -3, 0x4299], cam: [-554, 249, 1590] },
  ]) {
    w.data.f = 101 + row.frame;
    result.advance(w, 0, undefined, quiet);
    assert.deepEqual(ship(result, w), row.ship);
    assert.deepEqual(translation(result), row.cam);
  }
}

{
  const w = fixture('nballism', 2);
  Object.assign(w.data.pl[2], { z: 576, roll: 21 });
  Object.assign(w.data.mach, { st: 2, t: 9 });
  const live = new BallistixResult(w, 2, 101, LEVEL_CAMS[16], false);
  const sounds: number[] = [];
  const arena = live.advance(w, 0, undefined, e => { if (e.k === 'sfx') sounds.push(e.o); })!;
  assert.deepEqual(sounds, [1472]);
  assert.equal(arena.data.mach.st, 0);
  assert.equal(arena.data.balls[0].x, 193);
  assert.equal(arena.data.balls[0].z, 328);
  w.data.f = 130;
  live.advance(w, 1, undefined, quiet);
  assert.deepEqual(translation(live), [-79, 96, 3132]);
  assert.equal(arena.data.walls, 0);

  w.finished = true;
  w.data.f = 160;
  (w.data as BallistixData).pl.forEach((p, slot) => { if (slot !== 2) p.st = 0x25; });
  assert.equal(ballistixCupDelay(w, 2, 98), 1400);
  const wireResults = JSON.stringify(w);
  live.advance(w, 2, undefined, quiet);
  live.advance(w, 3, undefined, quiet);
  const late = new BallistixResult(w, 2, ballistixResultEntry(w, 2)!, LEVEL_CAMS[16], true);
  const lateArena = late.advance(w, 3, 2, () => assert.fail('late replay made a sound'))!;
  assert.deepEqual(translation(late), translation(live));
  assert.deepEqual(lateArena.data.balls, arena.data.balls);
  assert.deepEqual(lateArena.data.pl.map(p => p.score), [0, 0, 5, 0]);
  assert.deepEqual(ballDefence.placements(w), [2, 0, 1, 3]);
  assert.equal(JSON.stringify(w), wireResults);
}

{
  // USA L17 first tracking frame: the platform leaves the boat at y = -65.
  const w = fixture('sky', 3);
  Object.assign(w.data.pl[3], { x: -2222, z: 610, face: 3247, vel: 21, roll: 21 });
  w.data.tilt = [0, 8, 79];
  delete w.data.sky;
  assert.equal(ballistixFloor(w.data.tilt, -1262, 610) - 128, -65);
  const sky = new BallistixResult(w, 3, 101, LEVEL_CAMS[17], false);
  w.data.f = 102;
  sky.advance(w, 0, undefined, quiet);
  assert.deepEqual(ship(sky, w).slice(3, 5), [3479, 16]);
  w.data.f = 132;
  sky.advance(w, 1, undefined, quiet);
  assert.deepEqual(ship(sky, w).slice(0, 4), [-1262, -65, 610, 4093]);
  assert.deepEqual(translation(sky), [80, 133, 3168]);

  const rocking = fixture('sky', 3);
  rocking.data.f = 2235;
  rocking.data.sky.t = 0;
  rocking.data.sky.i = 4;
  for (const [i, floor] of [-95, -95, -96, -96].entries()) {
    const events = stepBallistixResultArena(rocking, 202 + i);
    assert.equal(rocking.data.tilt[2], floor);
    assert.equal(rocking.data.sky.i, 4);
    assert.ok(!events.some(e => e.k === 'tilt'));
  }
}

{
  // The existing Beach verdict is already 86–89 frames into the script.
  const w = fixture('beach', 3);
  w.finished = true;
  w.data.f = 1089;
  w.data.beachDecidedAt = 999;
  w.data.beachResultAt = 1089;
  Object.assign(w.data.pl[3], { x: -1280, z: -234, score: 5, st: 0x22, stateAt: 1000, roll: -3, character: 7 });
  (w.data as BallistixData).pl.slice(0, 3).forEach(p => { p.st = 0x25; });
  assert.equal(ballistixCupDelay(w, 3, 89), 100);
  const terminal = cloneWorld(w);
  const replay = new BallistixResult(w, 3, ballistixResultEntry(w, 3)!, LEVEL_CAMS[15], true);
  const arena = replay.advance(w, 11, 10, () => assert.fail('late replay made a sound'))!;
  assert.equal(replay.age, 119);
  assert.deepEqual(ship(replay, arena), [-1280, -128, -234, 4093, -3, 0x411d]);
  assert.notDeepEqual(arena.data.balls, w.data.balls);
  assert.deepEqual(w, terminal);
}

console.log('Ballistix native winner poses, camera frames, and private terminal replays passed');
