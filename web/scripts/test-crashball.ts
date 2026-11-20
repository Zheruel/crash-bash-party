import assert from 'node:assert/strict';
import { ballDefence, SPECTATOR_WAIT, type BallistixData } from '../shared/games/ballDefence';
import { DISC_CHARACTER } from '../shared/look';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

const seats = [5, 3, 6, 8].map((character, slot) => ({
  slot, char: DISC_CHARACTER.indexOf(character), bot: slot > 0, level: 1,
}));
const game = ballDefence;

// USA L14, one idle human and three Normal CPUs. At tick 380 the two balls
// collide in reused entity slots. Updating them in creation order changes the shot.
{
  const w = createWorld(game, seats, [], 17654, 'crashball');
  const d = w.data as BallistixData;
  for (let tick = 1; tick <= 2948; tick++) {
    stepWorld(w, game, [IDLE, game.bot!(w, 1), game.bot!(w, 2), game.bot!(w, 3)]);
    if (tick === 380) {
      assert.deepEqual(d.balls.map(b => [b.x, b.z, b.h & 4095]), [[-999, 1571, 2371], [-1124, 1342, 3419]]);
    }
    if (tick === 2262) assert.equal(d.pl[0].st, 0x24);
    if (tick === 2323) {
      assert.equal(d.pl[0].st, 0x25);
      assert.deepEqual(d.random, [1168468470, 3183051748]);
    }
  }
  assert.deepEqual(d.pl.map(p => p.score), [0, 0, 8, 0]);
  assert.deepEqual(d.random, [1902637880, 1656137839]);
}

// In the seed-3 opening one flash expires during the first spawn. Native slot
// 4 is still owned by that flash when the ball claims slot 5 (pool index 1).
assert.equal(createWorld(game, seats, [], 3, 'crashball').data.balls[0].beachPoolSlot, 1);

for (const variant of ['crashball', 'beach', 'nballism', 'sky']) {
  const w = createWorld(game, seats.map(s => ({ ...s, bot: s.slot >= 2 })), [], 47, variant);
  const d = w.data as BallistixData;
  // Keep the contenders tied while the native spectator timer runs.
  d.balls = [];
  d.efc = 10000;
  d.pl[0].score = 0;
  const cross = { ...IDLE, b: true };
  const pads = [cross, IDLE, game.bot!(w, 2), game.bot!(w, 3)];
  stepWorld(w, game, pads);
  assert.equal(d.spectatorSince, undefined);
  d.pl[1].score = 0;
  for (let i = 0; i <= SPECTATOR_WAIT; i++) stepWorld(w, game, pads);
  assert.equal(d.f - d.spectatorSince!, SPECTATOR_WAIT);
  assert.equal(w.ev.filter(e => e.o === 0x194).length, 1);
  const rejoined = cloneWorld(w);
  for (const world of [w, rejoined]) {
    stepWorld(world, game, pads);
    assert.ok(world.data.pl[3].score > 0, 'holding the button through entry must not accept');
    stepWorld(world, game, [IDLE, IDLE, pads[2], pads[3]]);
    const score = world.data.pl[2].score;
    stepWorld(world, game, pads);
    assert.deepEqual(world.data.pl.map((p: { score: number }) => p.score), [0, 0, score, 0]);
    assert.equal(world.ev.filter(e => e.o === 0x195).length, 1);
  }
  assert.deepEqual(w, rejoined);
}

console.log('Crashball collision order, knockouts and Ballistix spectator victory matched.');
