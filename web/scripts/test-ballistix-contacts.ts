import assert from 'node:assert/strict';
import { ballDefence, skyOpeningFrame, type BallistixData } from '../shared/games/ballDefence';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';
import { GameClient } from '../client/session';

const seats = [8, 9, 0, 1].map((char, slot) => ({ char, slot, bot: false, name: String(slot) }));
function ready(variant: string) {
  const w = createWorld(ballDefence, seats, [], 47, variant);
  for (let f = 0; f < 12; f++) stepWorld(w, ballDefence, []);
  const d = w.data as BallistixData;
  const b = d.balls[0];
  Object.assign(b, { st: 1, x: 0, y: -96, z: 0, h: 0, spd: 0, tgt: 0, fl: 1024, land: true });
  return { w, d, b };
}

for (const variant of ['crashball', 'beach', 'nballism', 'sky']) {
  const opening = createWorld(ballDefence, seats, [], 47, variant);
  const serve = 28;
  for (let tick = 1; tick <= serve + 16; tick++) {
    stepWorld(opening, ballDefence, []);
    const ball = (opening.data as BallistixData).balls[0];
    if (tick < serve) assert.deepEqual([ball.st, ball.x, ball.y, ball.z], [0, 8192, 8192, 8192]);
    if (tick === serve) {
      assert.equal(ball.st, 12);
      assert.equal(ball.y, variant === 'sky' ? -2048 : variant === 'nballism' ? -1280 : -32);
    }
    if (tick === serve + 16) assert.deepEqual([ball.st, ball.beachKickCd], [6, 20]);
  }

  // A waiting target participates in the rolling ball's contact pass. The
  // native open cylinder ends at exactly 178 horizontally and 255 vertically.
  for (const [dx, dy, hit] of [[177, 254, 1], [178, 0, 0], [40, 255, 0]]) {
    const { w, d, b } = ready(variant);
    d.balls.push({ ...b, id: w.nextId++, st: 12, tm: 10, x: dx, y: b.y + dy });
    const snapshot = cloneWorld(w);
    stepWorld(w, ballDefence, []);
    stepWorld(snapshot, ballDefence, []);
    assert.deepEqual(w, snapshot);
    assert.equal(w.ev.filter(e => e.k === 'sfx' && e.o === 1408).length, hit, variant);
    assert.equal(b.x, hit ? -2 : 0);
  }

  // The first sweep reaches 601 units. A just-served ball has its own lockout.
  for (const [distance, kickCd, expected] of [[600, 0, true], [601, 0, false], [600, 20, false]] as const) {
    const { w, d, b } = ready(variant), pl = d.pl[0];
    if (variant === 'sky') {
      pl.ang = pl.face = 2048;
      pl.x = 0; pl.z = -2304;
    }
    Object.assign(pl, { st: 31, kfr: 0, kcd: 4 });
    Object.assign(b, { x: pl.x, z: pl.z + distance, beachKickCd: kickCd, tgt: 80, spd: 80 });
    stepWorld(w, ballDefence, [IDLE]);
    assert.equal(w.ev.some(e => e.k === 'sfx' && e.o === 1413), expected, variant);
    assert.equal(b.beachKickCd, expected ? 3 : Math.max(0, kickCd - 1));
  }

  const { w, d, b } = ready(variant);
  d.walls = 8;
  Object.assign(b, { x: 2099, z: 900 });
  stepWorld(w, ballDefence, []);
  assert.equal(b.x, 2048);
  assert(w.ev.some(e => e.k === 'sfx' && e.o === 1426));
}
// An isolated Crashball rebound can fit entirely between two online snapshots.
{
  const { w, d, b } = ready('crashball');
  Object.assign(b, { x: 1720, z: 1720 });
  stepWorld(w, ballDefence, []);
  const start = cloneWorld(w);
  Object.assign(b, { x: 0, z: 0, spd: 0, tgt: 0 });
  for (const lit of [1, 1, 0]) {
    stepWorld(w, ballDefence, []);
    assert.equal(d.bumperFrames! & 15, lit);
  }
  const client = new GameClient(() => { throw Error('offline fixture'); }, { name: 'Guest', look: { char: 9, color: 0 } });
  client.round = { t: 'round', round: 1, total: 1, showdown: false, gameId: ballDefence.id, gameName: ballDefence.name, desc: '', controls: '', seats: [], modifier: null };
  client.phase = 'play';
  client.snaps = [{ w: start, tick: start.tick, at: 0 }, { w, tick: w.tick, at: 100 }];
  for (const [ms, lit] of [[100, 0], [134, 1], [167, 1]]) {
    assert.equal(client.renderWorld(ms)!.ballistixMarkers!.lights, lit);
  }
}
{
  const { w, d } = ready('nballism');
  d.post = { i: 2, t: 1 };
  stepWorld(w, ballDefence, []);
  assert.equal(d.post, null);
  assert.equal(d.bumperFrames! & 15, 4);
  stepWorld(w, ballDefence, []);
  assert.equal(d.bumperFrames! & 15, 0);
}
// Three successive machine launches captured on USA L16. The new ball stays
// at the muzzle for its birth tick and rebounds off the machine on the next.
for (const [yaw, positions] of [
  [3623, [[-12, -128, 415], [-16, -96, 549], [-19, -96, 677], [-22, -96, 805], [-25, -96, 933]]],
  [2711, [[-412, -128, 59], [-546, -96, 78], [-672, -96, 96], [-798, -96, 114], [-924, -96, 132]]],
  [1799, [[-130, -128, -396], [-172, -96, -523], [-212, -96, -644], [-252, -96, -765], [-292, -96, -886]]],
] as const) {
  const { w, d } = ready('nballism');
  d.balls.length = 0;
  Object.assign(d.mach!, { st: 4, t: 80, c: 0, yaw });
  for (const xyz of positions) {
    stepWorld(w, ballDefence, []);
    const [b] = d.balls;
    assert.deepEqual([b.x, b.y, b.z], xyz);
    assert.equal(b.spd, 128);
    assert(!w.ev.some(e => e.k === 'sfx' && e.o === 1408));
  }
}
// USA countdown with the engine clock aligned to the web round.
for (const [left, tilt, poses] of [
  [97, [19, 1, 4], [[-55, 3], [-190, 0], [-124, -2], [-134, -5]]],
  [47, [-15, 3, -65], [[-216, 61], [-111, 62], [-155, 62], [-177, 62]]],
  [0, [0, 11, 96], [[-32, -20], [-30, -14], [11, -8], [-63, -2]]],
] as const) {
  const frame = skyOpeningFrame(left);
  assert.deepEqual(frame.tilt, tilt);
  assert.deepEqual(frame.ships.map(p => [p.y + p.skyFloor, p.roll]), poses);
}

// USA Sky Balls frame 1993. The bottom ship is steering into the corner
// while the side fan recovers. The floor is sampled between the two bumper checks.
{
  const { w, d } = ready('sky');
  d.f = 1993;
  d.balls.length = 0;
  Object.assign(d.sky!.ev[2], { pos: -9020, vel: 152, max: 768, ap: 44, an: 0, dir: 0, st: 3, tm: 0 });
  const ship = d.pl[0];
  Object.assign(ship, { x: 1101, z: -2024, face: 1723, ang: 1723, roll: -43, vel: 40, st: 0x1d });
  for (const [rx, rz, floor, height] of [[131, -142, -85, -16], [127, -138, -83, -18], [122, -133, -80, -21]]) {
    stepWorld(w, ballDefence, [{ ...IDLE, x: 1 }]);
    assert.deepEqual(d.tilt, [rx, rz, floor]);
    assert.deepEqual([ship.x, ship.y + ship.skyFloor!, ship.z, ship.face, ship.roll], [1101, height, -2024, 1723, -43]);
  }
}
console.log('Ballistix marker boundaries, kick lockouts, rebounds, N. Gin launches and Sky Balls ship transforms matched.');
