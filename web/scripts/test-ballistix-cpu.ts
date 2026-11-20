// USA FUN_800b8a68 fixtures. Run from web with npx tsx scripts/test-ballistix-cpu.ts.
import assert from 'node:assert/strict';
import { Predictor } from '../client/predict';
import { ballDefence, type BallistixData } from '../shared/games/ballDefence';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';

const game = ballDefence;
const stages = ['crashball', 'nballism', 'sky'] as const;
type Stage = typeof stages[number];

function fixture(stage: Stage, level: number, mode = 3) {
  const seats = [0, 1, 2, 3].map(slot => ({ slot, name: String(slot), level, bot: slot === 0 }));
  const w = createWorld(game, seats, [], 321, stage);
  const d = w.data as BallistixData, pl = d.pl[0];
  const template = d.balls[0];
  d.balls = [];
  d.random = [0x12345678, 0x07654321];
  d.shipOrder = Array.from({ length: 16 }, () => [0, 1, 2, 3]);
  d.efc = 400;
  w.tick = d.f = 99;
  pl.beachCpu = { target: 1, roamX: 0, roamZ: pl.z, mode, lapse: 0, catchT: 0, wait: 1 };
  function ball(x: number, z: number, h: number, st: number) {
    d.balls.push({ ...template, x, z, h, st, y: -96, id: w.nextId++, beachPoolSlot: d.balls.length });
  }
  function step() {
    stepWorld(w, game, [game.bot!(w, 0), IDLE, IDLE, IDLE]);
    return pl.beachCpu!.nextPad!;
  }
  return { w, d, pl, ball, step };
}

for (const stage of stages) {
  for (const level of [0, 1, 2]) {
    // Two incoming balls. The closest predicted crossing depends on the skill's angular error.
    const defend = fixture(stage, level);
    defend.ball(-1200, 10, 720, 1);
    defend.ball(600, -1200, 930, 1);
    const direction = stage === 'sky' ? [0, 0, -1][level] : [1, -1, -1][level];
    const pad = defend.step();
    assert.deepEqual([pad.x, !!pad.r], [direction, stage !== 'sky' && level === 0]);
    assert.equal(defend.pl.vel, 0); // The pad is queued for the following tick.
    defend.step();
    assert.equal(Math.sign(defend.pl.vel), direction);

    const kick = fixture(stage, level);
    kick.ball(0, kick.pl.z + 260, 650, 8);
    assert.equal(kick.step().a, true);
    assert.equal(kick.pl.st, 0x1c);
    kick.step();
    assert.equal(kick.pl.st, 0x1f);

    const roam = fixture(stage, level, 0);
    roam.step();
    assert.equal(roam.pl.beachCpu!.roamX, stage === 'crashball' ? -50 : -160);
    assert.equal(roam.pl.beachCpu!.mode, 4);
    const wait = fixture(stage, level, 5);
    assert.equal(wait.step().c, true);
    wait.step();
    assert.equal(wait.pl.st, 0x1e);

    if (stage === 'nballism') {
      const shield = fixture(stage, level);
      shield.d.post = { i: 3, t: 45 };
      const pad = shield.step();
      assert.deepEqual([pad.x, !!pad.r], [-1, level === 2]);
    }
  }

  // A disconnected human's pending CPU pad survives a wire snapshot. An explicit human pad takes over immediately.
  const { w, d } = fixture(stage, 1);
  const human = d.pl[1];
  stepWorld(w, game, [game.bot!(w, 0), game.bot!(w, 1), IDLE, IDLE]);
  assert.equal(human.cpuFallback, true);
  const predictor = new Predictor(game, 2);
  predictor.onSnapshot(JSON.parse(JSON.stringify(w)), 0);
  for (let seq = 1; seq <= 12; seq++) {
    const input = { ...IDLE, y: -1, seq };
    stepWorld(w, game, [game.bot!(w, 0), game.bot!(w, 1), input, IDLE]);
    predictor.push(input);
    assert.deepEqual(predictor.pred, w);
  }
  const before = cloneWorld(w);
  game.bot!(w, 0);
  assert.deepEqual(w, before);
  stepWorld(w, game, [game.bot!(w, 0), { ...IDLE, x: -1 }, IDLE, IDLE]);
  assert.equal(human.cpuFallback, undefined);
  assert.equal(human.beachCpu?.nextPad, undefined);
  assert.ok(human.vel < 0);
}
// USA L17. The hull enters its knockout on 4871 and the burst and both sounds start on 4932.
{
  const { w, pl, d } = fixture('sky', 1);
  w.tick = d.f = 4870;
  d.efc = 200;
  pl.score = 0;
  const tick = () => stepWorld(w, game, [IDLE, IDLE, IDLE, IDLE]);
  tick();
  assert.equal(pl.st, 0x24);
  for (let i = 0; i < 60; i++) tick();
  assert.equal(d.f, 4931);
  assert.equal(pl.st, 0x24);
  tick();
  assert.equal(pl.st, 0x25);
  assert.equal(w.ev.filter(e => e.k === 'gone').length, 1);
  const sounds = w.ev.filter(e => e.k === 'sfx').map(e => e.o);
  assert(sounds.includes(1414));
  assert.equal(sounds.filter(id => id === 451 || id === 452).length, 1);
  assert.equal(pl.beachSmoke?.length, 3);
}
console.log('Ballistix defensive lines, kicks, taunts, shield targeting and CPU takeover matched.');
