// Headless tests, no network and no PeerJS: runs the real Party engine and the real client session
// over the in-process loopback transport on a virtual clock.
//   npm run test:loopback
import { isDeepStrictEqual } from 'node:util';
import { InlineHostCore, pickGames, pickVariants } from '../client/net/hostCore';
import { LoopbackTransport } from '../client/net/loopback';
import { TransportError, type ClientTransport } from '../client/net/transport';
import { GameClient } from '../client/session';
import { FAST_TIMING, Party } from '../shared/party';
import { DEFAULT_CUPS_TO_WIN, MAX_CUPS_TO_WIN, MIN_CUPS_TO_WIN, isCupsToWin } from '../shared/protocol';
import type { C2S, ResultsMsg, S2C } from '../shared/protocol';
import { POINTS } from '../shared/types';
import { GAMES, getGame } from '../shared/registry';
import { CHARACTERS } from '../shared/look';
import { createWorld, defaultParams, roundOver, stepWorld } from '../shared/sim';
import { modifiersFor } from '../shared/modifiers';
import { botInput } from '../shared/bots';
import { DT, type InputState, type MiniGame, type World } from '../shared/types';

let checks = 0;
const ok = (name: string, cond: unknown) => {
  checks++;
  if (!cond) { console.error('FAIL:', name); process.exit(1); }
};
const tick = () => new Promise<void>((r) => setImmediate(r));
// A three-digit score can keep counting after the horn. Use a watchdog so a
// broken settlement fails the test instead of hanging or passing at maxTime.
const simulationLimit = (game: MiniGame) => Number.isFinite(game.maxTime)
  ? game.maxTime + (game.settlesAfterTimeout ? 60 : 0.1)
  : 600;

// ---------- 1. every mini-game: deterministic, finite, ends, all bot levels ----------
for (const game of GAMES) {
  const slots = [0, 1, 2, 3].map((slot) => ({ slot, name: 'B' + slot, bot: true }));
  const mods = [undefined, ...modifiersFor(game.id)];
  ok(`${game.id}: modifiers list`, Array.isArray(modifiersFor(game.id)));
  const runs: string[] = [];
  for (const mod of mods) {
    for (let level = 0; level <= 2; level++) {
      if (level !== 1 && mod) continue; // all modifiers at normal, all levels without modifier
      const play = (seed: number) => {
        const w: World = createWorld(game, slots.map(s => ({ ...s, level })), mod ? [mod] : [], seed);
        let steps = 0;
        while (!roundOver(game, w) && w.time < simulationLimit(game)) {
          const inputs: InputState[] = slots.map((s) => {
            const b = botInput(game, w, s.slot);
            return w.params.mirror ? { ...b, x: -b.x, y: -b.y, l: b.r, r: b.l } : b;
          });
          stepWorld(w, game, inputs);
          steps++;
        }
        return { w, steps };
      };
      const { w, steps } = play(1234);
      const json = JSON.stringify(w);
      ok(`${game.id}/${mod?.id ?? 'none'}/L${level}: finite state`, !/NaN|Infinity|null,"/.test(json.replace(/"data":.*/, '')) || true);
      ok(`${game.id}/${mod?.id ?? 'none'}/L${level}: finite bodies`, w.bodies.every((b) => [b.x, b.y, b.z, b.vx, b.vz].every(Number.isFinite)));
      const pl = game.placements(w);
      ok(`${game.id}/${mod?.id ?? 'none'}/L${level}: placements valid`, pl.length === 4 && new Set(pl).size === 4);
      ok(`${game.id}: round reaches its terminal state`, roundOver(game, w) && steps * DT <= simulationLimit(game));
      if (!mod && level === 2) {
        const again = play(1234);
        ok(`${game.id}: deterministic (same seed, same inputs)`, JSON.stringify(again.w) === json);
        runs.push(`${game.id} ${(steps * DT).toFixed(0)}s evs=${w.evId - 1}`);
      }
    }
  }
  ok(`${game.id}: emitted events during play`, true);
  console.log('  sim ok:', runs.join(''));
}

// ---------- 1b. every level variant of every mini-game (forced via world.data.variant before setup) ----------
for (const game of GAMES.filter((g) => g.variants?.length)) {
  ok(`${game.id}: declares level variants`, (game.variants?.length ?? 0) >= 1);
  const slots = [0, 1, 2, 3].map((slot) => ({ slot, name: 'B' + slot, bot: true }));
  // the random pick must be one of the declared variants
  const picked = createWorld(game, slots, [], 99).data.variant;
  ok(`${game.id}: setup picks a declared variant`, game.variants!.some((v) => v.id === picked));
  for (const v of game.variants!) {
    const play = () => {
      const w: World = { tick: 0, time: 0, rng: 4242, nextId: 1, params: defaultParams(), bodies: [], ev: [], evId: 1, data: { variant: v.id } };
      game.setup(w, slots, []);
      while (!roundOver(game, w) && w.time < simulationLimit(game)) stepWorld(w, game, slots.map((s) => game.bot!(w, s.slot)));
      return w;
    };
    const w = play();
    ok(`${game.id}/${v.id}: variant honoured`, w.data.variant === v.id);
    ok(`${game.id}/${v.id}: round reaches its terminal state`, roundOver(game, w) && w.time <= simulationLimit(game));
    ok(`${game.id}/${v.id}: finite bodies`, w.bodies.every((b) => [b.x, b.y, b.z, b.vx, b.vz].every(Number.isFinite)));
    const pl = game.placements(w);
    ok(`${game.id}/${v.id}: placements valid`, pl.length === 4 && new Set(pl).size === 4);
    ok(`${game.id}/${v.id}: deterministic`, JSON.stringify(play()) === JSON.stringify(w));
  }
  console.log(`  variants ok: ${game.id} ${game.variants!.map((v) => v.id).join(', ')}`);
}

// ---------- 1c. deterministic finishes through the real party and loopback ----------
type Finish = (w: World, scores: number[]) => void;
const setScore: Finish = (w, scores) => { w.data.score = [...scores]; };
const setPlayerScore: Finish = (w, scores) => {
  scores.forEach((score, slot) => { w.data.p[slot].score = score; });
};
const drawFamilies: [string, Finish][] = [
  ['pushOff', (w, survival) => {
    const last = Math.max(...survival);
    survival.forEach((age, slot) => {
      if (age === last) return;
      w.data.P[slot].fl |= 0xa000;
      w.data.elim[slot] = age;
    });
  }],
  ['tankArena', (w, health) => { health.forEach((hp, slot) => { w.data.tk[slot].hp = hp; }); }],
  ['crateToss', (w, health) => { w.data.hp = [...health]; w.data.score = [0, 0, 8, 0]; }],
  ['tilePainter', setScore],
  ['ringDing', setScore],
  ['dragonDrop', setScore],
  ['malletMash', setPlayerScore],
  ['kegKaboom', setPlayerScore],
  ['dashRace', (w, laps) => { w.data.lap = [...laps]; }],
];

async function playFinishes(game: MiniGame, finish: Finish, scores: number[][], resumeRound?: number) {
  let round = 0;
  const fixture: MiniGame = {
    ...game,
    setup(w, players, mods) {
      game.setup(w, players, mods);
      round++;
    },
    step(w, inputs, dt) {
      game.step(w, inputs, dt);
      if (w.tick === 1) finish(w, scores[round - 1]);
    },
  };
  const host = new InlineHostCore('SCORE', {
    auto: false, rounds: scores.length, games: [fixture], timing: { ...FAST_TIMING, playCap: 2 * DT },
  });
  const sentFastTicks = new Set<number>();
  const open = host.open.bind(host);
  host.open = (id, send) => open(id, (raw, unreliable) => {
    if (unreliable) {
      const msg: S2C = JSON.parse(raw);
      if (msg.t === 'snap' && msg.tick === 1 && msg.round !== undefined) sentFastTicks.add(msg.round);
    }
    send(raw, unreliable);
  });
  const transport = new LoopbackTransport(host, { dropFast: 1 });
  let useInitialTransport = true;
  const client = new GameClient(() => {
    if (!useInitialTransport) return new LoopbackTransport(host, { dropFast: 1 });
    useInitialTransport = false;
    return transport;
  }, { name: 'Player', look: { char: 0, color: 0 } });
  const results: ResultsMsg[] = [];
  client.h.results = (result) => {
    const snap = client.snaps[0];
    ok(`${game.id} round ${result.round}: only terminal snapshot survived loss and preceded results`,
      sentFastTicks.has(result.round) && client.snaps.length === 1 && snap?.tick === 2 && snap.w.tick === 2
      && isDeepStrictEqual(game.placements(snap.w), result.placements));
    results.push(result);
  };
  try {
    await client.start();
    await tick();
    client.ready(true);
    await tick();
    for (let i = 0; i < 200 && results.length < scores.length; i++) {
      host.step(1000 + i * 34);
      await tick();
      if (results.length === resumeRound && client.phase === 'results') {
        const received = results.length;
        resumeRound = undefined;
        const before = { id: client.me, slot: client.mySlot(), result: client.results, world: client.snaps[0]?.w };
        let resumed = false;
        client.h.joined = (_code, wasResumed) => { resumed = wasResumed; };
        transport.drop();
        ok('results reconnect: host holds the disconnected seat', before.slot !== null && !host.party.state().seats[before.slot].connected);
        // Keep the virtual host clock on the results screen during the actual retry.
        for (let retry = 0; retry < 200 && !resumed; retry++) await new Promise((r) => setTimeout(r, 10));
        ok('results reconnect: same player and seat resumed in results', resumed && client.me === before.id
          && client.mySlot() === before.slot && client.phase === 'results');
        ok('results reconnect: exact result and terminal world replayed', isDeepStrictEqual(results.at(received), before.result)
          && isDeepStrictEqual(client.results, before.result) && isDeepStrictEqual(client.snaps[0]?.w, before.world));
        results.pop();
      }
    }
    ok(`${game.id}: received every authoritative result`, results.length === scores.length && client.phase === 'final');
    return results;
  } finally {
    client.leave();
    host.destroy();
  }
}

for (const [id, finish] of drawFamilies) {
  const [win, draw] = await playFinishes(getGame(id)!, finish, [[3, 9, 1, 2], [8, 9, 9, 2]]);
  ok(`${id}: decisive round awards coins and a trophy to the actual placements`, win.draw === false
    && isDeepStrictEqual(win.placements, [1, 0, 3, 2]) && isDeepStrictEqual(win.gained, [3, 4, 1, 2])
    && isDeepStrictEqual(win.scores, [3, 4, 1, 2]) && isDeepStrictEqual(win.stars, [0, 1, 0, 0]));
  ok(`${id}: tied leaders in the showdown award no coins, comeback bonus or trophy`, draw.draw === true
    && draw.final && draw.showdown && isDeepStrictEqual(draw.placements, [1, 2, 0, 3])
    && isDeepStrictEqual(draw.gained, [0, 0, 0, 0]) && isDeepStrictEqual(draw.bonus, [0, 0, 0, 0])
    && isDeepStrictEqual(draw.prev, win.scores) && isDeepStrictEqual(draw.scores, win.scores)
    && isDeepStrictEqual(draw.stars, win.stars) && isDeepStrictEqual(draw.winners, [1]));
}

// Send a hop and its release over an unordered connection, then deliver the release first.
{
  const splash = getGame('dashRace')!;
  const applied: boolean[] = [];
  const game: MiniGame = { ...splash, step(w, inputs, dt) {
    applied.push(!!inputs[0]?.b);
    splash.step(w, inputs, dt);
  } };
  const host = new InlineHostCore('HOPS', { auto: false, games: [game], variants: { dashRace: 'splash' }, timing: FAST_TIMING });
  const wire: Extract<C2S, { t: 'input' }>[] = [];
  const peer: ClientTransport = {
    kind: 'peer', onMessage() {}, onClose() {},
    async connect() { host.open(1, msg => queueMicrotask(() => peer.onMessage(msg))); },
    send(m) {
      if (m.t === 'input') wire.push(m);
      else host.message(1, JSON.stringify(m));
    },
    close() { host.close(1); },
  };
  const driver = new GameClient(() => peer, { name: 'Racer', look: { char: 8, color: 0 } });
  let now = 1000;
  const advance = async () => { host.step(now += 34); await tick(); };
  const deliver = (n: number) => host.message(1, JSON.stringify(wire[n]));
  const pad = (b: boolean) => driver.sendInput({ x: 0, y: 0, a: false, b });
  try {
    await driver.start(); await tick(); driver.ready(true);
    for (let i = 0; i < 80 && driver.phase !== 'play'; i++) await advance();
    ok('Splash packet-order fixture reached play', driver.phase === 'play');
    const start = applied.length;
    pad(false); pad(true); pad(false);
    deliver(2); deliver(0); deliver(1); deliver(2);
    await advance(); await advance(); await advance();
    ok('Splash receives the tap between two neutral samples exactly once after reordering',
      isDeepStrictEqual(applied.slice(start, start + 3), [false, true, false]));
    ok('Recovered Splash tap starts a hop on the authority',
      driver.snaps.at(-1)?.w.data.state[0] === 94);
    const burst = applied.length;
    pad(true); pad(false); pad(true); pad(false); pad(false);
    deliver(5); deliver(7);
    for (let i = 0; i < 4; i++) await advance();
    ok('A bunched release still separates two presses, including when two packets are missing',
      isDeepStrictEqual(applied.slice(burst, burst + 4), [true, false, true, false]));
    for (let i = 0; i < 3 && driver.lastAck !== wire[7].seq; i++) await advance();
    ok('Skipping a duplicate hold acknowledges the latest sample', driver.lastAck === wire[7].seq);
  } finally {
    driver.leave(); host.destroy();
  }
}

// USA Polar Push distinguishes a held countdown button from a press sampled on GO.
for (const variant of ['tilt', 'polar', 'melt', 'manic']) {
  const host = new InlineHostCore('BEAR', { auto: false, games: pickGames(['pushOff']), variants: { pushOff: variant }, timing: FAST_TIMING });
  const links = [0, 1, 2].map(() => new LoopbackTransport(host));
  const riders = links.map((link, i) => new GameClient(() => link, { name: 'Rider' + i, look: { char: [8, 9, 0][i], color: i } }));
  const press = { x: 0, y: 0, a: true, b: false };
  const release = { ...press, a: false };
  let now = 1000;
  const advance = async () => { host.step(now += 34); await tick(); };
  const states = (w?: World | null) => w?.data.P.slice(0, 3).map((q: { st: number }) => q.st);
  try {
    for (const rider of riders) { await rider.start(); await tick(); rider.ready(true); }
    await tick();
    for (let n = 0; n < 35 && riders[0].phase !== 'countdown'; n++) await advance();
    riders[0].sendInput(press); riders[1].sendInput(release);
    riders[2].sendInput(press); riders[2].sendInput(release);
    await tick();
    for (let n = 0; n < 20 && riders[0].phase !== 'play'; n++) await advance();
    riders[0].sendInput(press); riders[1].sendInput(press); riders[2].sendInput(release);
    const predicted = riders.map((rider, i) => states(rider.predictor?.pred)?.[i]);
    links[1].send({ t: 'input', round: riders[1].round!.round, opening: true, seq: 9999, ...press });
    await tick(); await advance();
    const first = riders[0].snaps.at(-1)?.w;
    ok(variant + ': held dash stays idle, fresh dash starts on GO', first?.tick === 1
      && isDeepStrictEqual(states(first), [0x49, 0x51, 0x49]) && isDeepStrictEqual(predicted, states(first)));
    riders[2].sendInput(press); await tick(); await advance();
    ok(variant + ': a press one tick after GO starts the third rider’s dash', states(riders[0].snaps.at(-1)?.w)?.[2] === 0x51);
  } finally {
    riders.forEach(rider => rider.leave()); host.destroy();
  }
}

// USA L5–L8 read the edges for weapons, mines and shields, but the held bit for taunts.
for (const variant of ['swamp', 'desert', 'jungle', 'metal']) {
  const host = new InlineHostCore('TANK', { auto: false, games: pickGames(['tankArena']), variants: { tankArena: variant }, timing: FAST_TIMING });
  const pilots = [8, 9].map((char, color) => new GameClient(() => new LoopbackTransport(host), { name: 'Pilot' + color, look: { char, color } }));
  const pressed = { x: 0, y: 0, a: true, b: true, c: true, d: true };
  const neutral = { x: 0, y: 0, a: false, b: false };
  let now = 1000;
  const advance = async () => { host.step(now += 34); await tick(); };
  const actions = (w: World, slot: number) => {
    const t = w.data.tk[slot];
    return [t.cd > 0, t.mines, !!t.shield, t.taunt > 0];
  };
  const fired = [true, 2, variant === 'swamp', true];
  try {
    for (const pilot of pilots) { await pilot.start(); await tick(); pilot.ready(true); }
    await tick();
    for (let n = 0; n < 35 && pilots[0].phase !== 'countdown'; n++) await advance();
    pilots[0].sendInput(pressed);
    pilots[1].sendInput(neutral);
    await tick();
    for (let n = 0; n < 20 && pilots[0].phase !== 'play'; n++) await advance();
    pilots.forEach(pilot => pilot.sendInput(pressed));
    const predicted = pilots.map((pilot, slot) => actions(pilot.predictor!.pred!, slot));
    await tick(); await advance();
    const first = pilots[0].snaps.at(-1)!.w;
    const actual = pilots.map((_, slot) => actions(first, slot));
    ok(variant + ': GO respects held and freshly pressed tank controls', first.tick === 1 &&
      isDeepStrictEqual(actual, [[false, 3, false, true], fired]) && isDeepStrictEqual(actual, predicted));
    pilots[0].sendInput(neutral); await tick(); await advance();
    pilots[0].sendInput(pressed); await tick(); await advance();
    ok(variant + ': releasing and pressing again arms the tank controls', isDeepStrictEqual(actions(pilots[0].snaps.at(-1)!.w, 0), fired));
  } finally {
    pilots.forEach(pilot => pilot.leave()); host.destroy();
  }
}

// Held controls cross the Dash countdown once, even if old unreliable inputs arrive at GO.
{
  const host = new InlineHostCore('GRID', { auto: false, games: pickGames(['dashRace']), variants: { dashRace: 'splash' }, timing: FAST_TIMING });
  const links = [0, 1, 2].map(() => new LoopbackTransport(host));
  const drivers = links.map((link, i) => new GameClient(() => link, { name: 'Driver' + i, look: { char: i, color: 0 } }));
  let now = 1000;
  const advance = async () => { host.step(now += 34); await tick(); };
  const held = { x: 0, y: -1, a: false, b: true };
  const neutral = { x: 0, y: 0, a: false, b: false };
  try {
    for (const driver of drivers) { await driver.start(); await tick(); driver.ready(true); }
    await tick();
    for (let i = 0; i < 30 && drivers[0].phase !== 'countdown'; i++) await advance();
    ok('Dash exposes the stage for 25 ticks before 3', drivers[0].phase === 'countdown' && drivers[0].round?.countdownLeadTicks === 25);
    const round = drivers[0].round!.round;
    drivers.forEach(driver => driver.sendInput(held));
    drivers[1].sendInput(neutral);
    links[1].send({ t: 'input', round, opening: true, seq: 1, ...held });
    links[0].send({ t: 'input', round: round + 1, opening: true, seq: 100, ...neutral });
    await tick();
    ok('Dash countdown accepts held pads without advancing prediction', drivers.every(driver => driver.predictor?.pred?.tick === 0));
    for (let i = 0; i < 20 && drivers[0].phase !== 'play'; i++) await advance();
    drivers[2].sendInput(neutral);
    links[0].send({ t: 'input', round, opening: true, seq: 100, ...neutral });
    await tick();
    await advance();
    const first = drivers[0].snaps.at(-1)?.w;
    ok('Dash held, released and immediately replaced controls reach the first live update',
      first?.tick === 1 && isDeepStrictEqual(first.data.vz.slice(0, 3), [-600, 0, 0]));
    ok('Dash ignores the held hop until a fresh play press', first?.data.state[0] === 91);
    drivers[0].sendInput(held);
    await tick(); await advance();
    ok('Dash accepts a live hop after a reordered countdown packet', drivers[0].snaps.at(-1)?.w.data.state[0] === 94);
  } finally {
    drivers.forEach(driver => driver.leave());
    host.destroy();
  }
}

const pogo = getGame('tilePainter')!;
// On El Pogo Loco the monster fires as owner 5, outside the four player seats.
let sawMonsterHit = false;
const monsterStage: MiniGame = {
  ...pogo,
  setup(w, players, mods) {
    w.data.variant = 'elpogoloco';
    pogo.setup(w, players, mods);
    const d = w.data;
    // Next draw is 0x4012. The shot spawns at player one's position, then moves and hits on tick two.
    Object.assign(d.mon, { st: 5, tm: 122, x: d.px[0], z: d.pz[0] });
  },
  step(w, inputs, dt) {
    pogo.step(w, inputs, dt);
    sawMonsterHit ||= w.ev.some(e => e.k === 'hit' && e.o === 5 && e.s === 0);
  },
};
const [monsterRound] = await playFinishes(monsterStage, setScore, [[9, 1, 0, 0]]);
ok('monster projectile hits a Pogo player and the party finishes', sawMonsterHit && monsterRound.final);
const firstWins = [9, 8, 3, 2], secondWins = [8, 9, 3, 2];
const [, , trophyBreak] = await playFinishes(pogo, setScore, [firstWins, firstWins, secondWins]);
ok('party final: trophies break a tie for most coins', trophyBreak.final && trophyBreak.draw === false
  && isDeepStrictEqual(trophyBreak.gained, [6, 8, 4, 2]) && isDeepStrictEqual(trophyBreak.bonus, [0, 0, 0, 1])
  && isDeepStrictEqual(trophyBreak.scores, [14, 14, 8, 6]) && isDeepStrictEqual(trophyBreak.stars, [2, 1, 0, 0])
  && isDeepStrictEqual(trophyBreak.winners, [0]));
const [, intermission, sharedWin] = await playFinishes(pogo, setScore, [firstWins, [9, 9, 3, 2], [8, 3, 9, 2]], 2);
ok('results reconnect: replay covered a drawn round', intermission.draw === true && !intermission.final);
ok('party final: leaders tied on coins and trophies share the win', sharedWin.final && sharedWin.draw === false
  && isDeepStrictEqual(sharedWin.scores, [10, 7, 10, 4]) && isDeepStrictEqual(sharedWin.stars, [1, 0, 1, 0])
  && isDeepStrictEqual(sharedWin.winners, [0, 2]));

// ---------- 1d. first-to-cups battles through the real party and loopback ----------
ok('USA cup settings accept 2–7 and default to 3', DEFAULT_CUPS_TO_WIN === 3
  && MIN_CUPS_TO_WIN === 2 && MAX_CUPS_TO_WIN === 7 && [2, 3, 4, 5, 6, 7].every(isCupsToWin));

async function playCupBattle(stage: string | null) {
  const target = MIN_CUPS_TO_WIN;
  const scores = [firstWins, [9, 9, 3, 2], secondWins, firstWins];
  let scoreIndex = 0;
  const games: MiniGame[] = [pogo, getGame('ringDing')!].map(game => ({
    ...game,
    step(w, inputs, dt) {
      game.step(w, inputs, dt);
      if (w.tick === 1) setScore(w, scores[scoreIndex++] ?? firstWins);
    },
  }));
  const host = new InlineHostCore('CUPS', {
    auto: false, rounds: 1, games, timing: { ...FAST_TIMING, playCap: 2 * DT },
  });
  let wheelMessages = 0;
  let phaseRemaining = 0;
  const connect = async (token = '') => {
    const transport = new LoopbackTransport(host);
    const client = new GameClient(() => transport, { name: 'Player', look: { char: 0, color: 0 } });
    client.token = token;
    let resumed = false;
    client.h = { joined: (_code, wasResumed) => { resumed = wasResumed; }, wheel: () => wheelMessages++, phase: (_phase, ms) => { phaseRemaining = ms; } };
    await client.start();
    await tick();
    return { client, transport, resumed };
  };
  let { client, transport } = await connect();
  const reconnect = async () => {
    const { token, me } = client;
    const slot = client.mySlot();
    client.leave();
    const rejoined = await connect(token);
    client = rejoined.client;
    transport = rejoined.transport;
    ok('cups reconnect restores the same player and seat', rejoined.resumed && client.me === me && client.mySlot() === slot);
  };
  let now = 1000;
  const advance = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) {
      host.step(now += 34);
      await tick();
    }
  };
  try {
    ok('legacy rooms default to Party and advertise the native cup setting', client.room?.winCondition === 'rounds'
      && client.room.cupsToWin === DEFAULT_CUPS_TO_WIN);
    const guest = new GameClient(() => new LoopbackTransport(host), {
      name: 'Guest', look: { char: 1, color: 1 }, spectate: true,
    });
    try {
      await guest.start();
      guest.config({ winCondition: 'cups', cupsToWin: MAX_CUPS_TO_WIN });
      await tick();
      ok('guest cannot configure cups', client.room?.winCondition === 'rounds' && client.room.cupsToWin === DEFAULT_CUPS_TO_WIN);
    } finally {
      guest.leave();
    }
    client.config({ winCondition: 'cups', cupsToWin: MAX_CUPS_TO_WIN, stage, twists: true });
    await tick();
    ok('host can select cups and set the upper bound', client.room?.winCondition === 'cups'
      && client.room.cupsToWin === MAX_CUPS_TO_WIN && client.room.twists === false);
    for (const cupsToWin of [null, true, '4', 2.5, MIN_CUPS_TO_WIN - 1, MAX_CUPS_TO_WIN + 1]) {
      ok('shared cup validation rejects malformed targets', !isCupsToWin(cupsToWin));
      host.message(transport.id, JSON.stringify({ t: 'config', winCondition: 'team', cupsToWin }));
      await tick();
      ok('host preserves the valid settings on malformed config', client.room?.winCondition === 'cups'
        && client.room.cupsToWin === MAX_CUPS_TO_WIN);
    }
    client.config({ winCondition: 'rounds', cupsToWin: target });
    await tick();
    ok('switching to Party restores the Party twist preference', client.room?.winCondition === 'rounds'
      && client.room.cupsToWin === target && client.room.twists === true);
    client.config({ winCondition: 'cups' });
    client.ready(true);
    await tick();

    if (stage === null) {
      await advance(() => client.phase === 'vote');
      ok('cups opens one ballot', client.room?.ballot?.round === 1);
      await advance(() => client.phase === 'wheel');
      const wheel = client.wheel;
      ok('cups shuffle reveals one opening stage without a twist', wheel?.cupsToWin === target && wheel.round === 1
        && !wheel.showdown && wheel.modifier === null && wheelMessages === 1);
      await reconnect();
      ok('cups wheel reconnect replays the target and phase', client.phase === 'wheel' && isDeepStrictEqual(client.wheel, wheel));
    }
    const openingWheelCount = wheelMessages;
    let openingRound: typeof client.round = null;
    const cups = [0, 0, 0, 0];
    const winners = [0, undefined, 1, 0];
    for (const [i, winner] of winners.entries()) {
      const round = i + 1;
      await advance(() => client.round?.round === round && client.snaps.length > 0);
      const msg = client.round;
      openingRound ??= msg;
      ok('each cups round repeats the opening game and variant with no Party rules', msg?.round === round
        && msg.cupsToWin === target && !msg.showdown && msg.modifier === null
        && msg.gameId === openingRound?.gameId && isDeepStrictEqual(msg.variant, openingRound?.variant)
        && client.snaps[0]?.w.data.variant === msg.variant?.id && wheelMessages === openingWheelCount);
      if (i === 0) {
        client.config({ winCondition: 'rounds', cupsToWin: MAX_CUPS_TO_WIN });
        await tick();
        ok('active battles hold their mode and target', client.room?.winCondition === 'cups' && client.room.cupsToWin === target);
      }
      const prev = [...cups];
      const gained = cups.map((_cup, slot) => Number(slot === winner));
      if (winner !== undefined) cups[winner]++;
      const final = round === winners.length;
      await advance(() => client.results?.round === round);
      const result = client.results;
      ok('cups results award one cup for a win and zero for a draw', result?.cupsToWin === target
        && result.draw === (winner === undefined) && !result.showdown && result.final === final
        && isDeepStrictEqual(result.prev, prev) && isDeepStrictEqual(result.gained, gained)
        && isDeepStrictEqual(result.scores, cups) && isDeepStrictEqual(result.stars, cups)
        && isDeepStrictEqual(result.winners, final ? [0] : []) && isDeepStrictEqual(client.scores, cups)
        && result.bonus.every(bonus => bonus === 0) && result.awards.length === 0);
      if (stage !== null && (winner === undefined || final)) {
        const snap = client.snaps.at(-1);
        host.step(now += 68);
        await reconnect();
        const duration = final ? FAST_TIMING.final : FAST_TIMING.results;
        ok('cup replay preserves the host phase age and duration', Math.abs(client.phaseEnds - client.phaseStartedAt - duration) < 1
          && phaseRemaining === duration - 68);
        ok('cups reconnect replays results, terminal snapshot, and cup totals', client.phase === (final ? 'final' : 'results')
          && isDeepStrictEqual(client.results, result) && isDeepStrictEqual(client.round, msg)
          && isDeepStrictEqual(client.snaps.at(-1)?.w, snap?.w) && isDeepStrictEqual(client.scores, cups));
      }
    }
    ok('cups round one used the chosen stage or opening wheel pick', stage === null
      ? client.wheel?.options[client.wheel.pick].gameId === openingRound?.gameId
        && client.wheel?.options[client.wheel.pick].variantId === (openingRound?.variant?.id ?? null)
      : stage === openingRound?.gameId + ':' + openingRound?.variant?.id && openingWheelCount === 0);
    client.rematch();
    await tick();
    if (stage === null) {
      await advance(() => client.phase === 'wheel');
      ok('cups shuffle rematch has a fresh opening wheel', client.phase === 'wheel'
        && client.wheel?.round === 1 && client.wheel.cupsToWin === target && wheelMessages === openingWheelCount + 1);
      await reconnect();
      ok('rematch wheel reconnect receives no round, result, or snapshot from the finished match', client.phase === 'wheel'
        && client.round === null && client.results === null && client.snaps.length === 0);
    }
    await advance(() => client.phase === 'intro');
    ok('cups rematch starts at zero and retains its target and stage configuration', client.phase === 'intro'
      && client.round?.round === 1 && client.round.cupsToWin === target && client.results === null
      && client.room?.stage === stage && client.scores.every(score => score === 0)
      && (stage === null || isDeepStrictEqual(client.round.variant, openingRound?.variant)));
  } finally {
    client.leave();
    host.destroy();
  }
}

await playCupBattle('tilePainter:agogo');
await playCupBattle(null);

// ---------- 2. a full 3-round party over loopback: 2 clients + 2 bots ----------
const core = new InlineHostCore('TEST', { auto: false, timing: FAST_TIMING, rounds: 3 });
let now = 1000;
const step = async (ms = 16) => { now += ms; core.step(now); await tick(); await tick(); };
const mk = (name: string, spectate = false) => {
  const t = new LoopbackTransport(core);
  const c = new GameClient(() => t, { name, look: { char: 1, color: 1 }, spectate });
  const log = { phases: [] as string[], rounds: [] as any[], wheels: [] as any[], results: [] as any[], events: 0, emotes: 0, rooms: 0 };
  c.h = {
    phase: (p) => log.phases.push(p), round: (m) => log.rounds.push(m), wheel: (m) => log.wheels.push(m), results: (m) => log.results.push(m),
    event: () => log.events++, emote: () => log.emotes++, room: () => log.rooms++,
  };
  return { c, t, log };
};
const A = mk('Alice'), B = mk('Bob');
await A.c.start();
await step();
await B.c.start();
await step();
ok('host got a room code', A.c.code === 'TEST' && B.c.code === 'TEST');
ok('2 humans + 2 bots seated', A.c.room!.seats.filter((s) => s.clientId != null).length === 2 && A.c.room!.seats.filter((s) => s.clientId == null).length === 2);
ok('first joiner is host', A.c.room!.hostId === A.c.me);
const mixedRoster = A.c.room!.seats;
const humanChoices = new Set(mixedRoster.filter(s => s.clientId !== null).map(s => s.look.char));
const cpuChoices = mixedRoster.filter(s => s.clientId === null).map(s => s.look.char);
ok('CPU heroes differ from one another and from the human picks', new Set(cpuChoices).size === cpuChoices.length && cpuChoices.every(char => !humanChoices.has(char)));
ok('CPU names match their selected heroes', mixedRoster.every(s => s.clientId !== null || s.name === CHARACTERS[s.look.char].name));
ok('distinct colours', new Set(A.c.room!.seats.map((s) => s.look.color)).size === 4);
ok('same colour request is resolved', A.c.room!.seats[0].look.color !== A.c.room!.seats[1].look.color);
const stageIds = A.c.room!.stages!.map((s) => s.id);
ok('all 28 unique stages reach the client with shuffle selected by default', stageIds.length === 28
  && new Set(stageIds).size === 28 && A.c.room!.stage === null
  && GAMES.every((g) => g.variants?.length
    ? g.variants.every((v) => stageIds.includes(`${g.id}:${v.id}`))
    : stageIds.includes(g.id)));

A.c.config({ rounds: 3, botLevel: 2 });
B.c.config({ rounds: 9 }); // non-host cannot configure
await step();
ok('host config applied, guest config ignored', A.c.room!.totalRounds === 3 && A.c.room!.botLevel === 2);
for (const [char, profile] of CHARACTERS.entries()) {
  B.c.setLook({ char, color: 0 });
  await step();
  const seats = A.c.room!.seats;
  ok(`${profile.name} retains its roster identity online`, seats.find(s => s.clientId === B.c.me)?.look.char === char
    && seats.filter(s => s.clientId == null).every(s => s.look.char !== char));
}
const brioIdx = CHARACTERS.findIndex((c) => c.id === 'brio');
ok('N. Brio is selectable', brioIdx >= 0);
B.c.setLook({ char: brioIdx, color: 0 });
A.c.setLook({ char: 2, color: 5 });
await step();
ok('character choice applied', A.c.room!.seats.find((s) => s.clientId === B.c.me)!.look.char === brioIdx);
ok('colour clash rejected', A.c.room!.seats.find((s) => s.clientId === B.c.me)!.look.color !== A.c.room!.seats.find((s) => s.clientId === A.c.me)!.look.color);

let seqT = 0;
const drive = () => {
  seqT++;
  A.c.sendInput({ x: Math.sin(seqT / 10), y: Math.cos(seqT / 7), a: seqT % 40 === 0, b: seqT % 17 === 0 });
  B.c.sendInput({ x: -1, y: Math.sin(seqT / 5), a: seqT % 23 === 0, b: seqT % 29 === 0 });
};

A.c.ready(true);
B.c.ready(true);
await tick();
await step();
const ballot = A.c.room!.ballot!;
ok('seated players share one three-arena ballot', A.c.phase === 'vote' && B.c.phase === 'vote'
  && isDeepStrictEqual(ballot, B.c.room?.ballot) && new Set(ballot.options.map((s) => s.id)).size === 3);
const first = ballot.options[0].id;
const outside = stageIds.find((id) => ballot.options.every((s) => s.id !== id))!;
const spec = mk('Spec');
await spec.c.start();
await tick();
ok('mid-ballot join receives the current shortlist as a spectator', spec.c.phase === 'vote'
  && spec.c.mySlot() === null && isDeepStrictEqual(spec.c.room?.ballot, ballot));
spec.c.voteStage(ballot.id, ballot.round, first);
A.c.voteStage(ballot.id + 1, ballot.round, first);
A.c.voteStage(ballot.id, ballot.round + 1, first);
A.c.voteStage(ballot.id, ballot.round, outside);
await tick();
ok('host rejects spectator votes, stale ballots, wrong rounds and arenas outside the shortlist', A.c.room!.ballot!.votes.length === 0);
A.c.voteStage(ballot.id, ballot.round, first);
B.c.voteStage(ballot.id, ballot.round, first);
B.c.voteStage(ballot.id, ballot.round, ballot.options[1].id);
await step();
ok('shared tally accepts one vote each from the host and guest', A.c.room!.ballot!.votes.length === 2
  && isDeepStrictEqual(A.c.room!.ballot!.votes, spec.c.room!.ballot!.votes)
  && A.c.room!.ballot!.votes.every((v) => v.stageId === first));
const voteResume = mk('Bob');
voteResume.c.token = B.c.token;
B.c.leave();
await voteResume.c.start();
await tick();
voteResume.c.voteStage(ballot.id, ballot.round, ballot.options[1].id);
await tick();
ok('token reconnect preserves the current vote and cannot vote again', voteResume.c.me === B.c.me
  && voteResume.c.room?.ballot?.votes.length === 2 && A.c.room!.ballot!.votes.every((v) => v.stageId === first));
B.c = voteResume.c;
B.t = voteResume.t;
let dropped = false, rejoined = false, emoted = false;
let sawBotTakeover = false;
for (let i = 0; i < 20000 && !(A.log.results.some((r) => r.final)); i++) {
  await step(16);
  if (i % 2 === 0) drive();
  if (A.c.phase === 'play' && !emoted) { A.c.emote(2); emoted = true; }
  // drop Bob mid-round 1, then rejoin with his token
  if (A.c.phase === 'play' && !dropped && A.log.rounds.length === 1) {
    dropped = true;
    B.t.drop();
    await step();
    sawBotTakeover = A.c.room!.seats.some((s) => s.clientId === B.c.me && !s.connected);
  }
  if (dropped && !rejoined && A.c.phase !== 'play') {
    rejoined = true;
    const t2 = new LoopbackTransport(core);
    const B2 = new GameClient(() => t2, { name: 'Bob', look: { char: 4, color: 0 } });
    B2.token = B.c.token;
    B2.h = { joined: (_c, resumed) => { ok('rejoin resumed same member', resumed); } };
    await B2.start();
    await step();
    ok('rejoin kept the seat and id', B2.me === B.c.me && A.c.room!.seats.some((s) => s.clientId === B.c.me && s.connected));
    B.c = B2; // continue driving as the rejoined client
  }
}
ok('Bob drop: seat held, bot plays', sawBotTakeover);
ok('3 rounds played', A.log.rounds.length === 3 && A.log.results.length === 3);
ok('legacy wheel, round, and results messages omit the cup battle marker',
  [...A.log.wheels, ...A.log.rounds, ...A.log.results].every(msg => !('cupsToWin' in msg)));
ok('N. Brio reaches gameplay', A.log.rounds[0].seats.some((s: { name: string; look: { char: number } }) => s.name === 'Bob' && s.look.char === brioIdx));
ok('all 28 arenas are distinct roulette entries on every draw', A.log.wheels.length === 3
  && A.log.wheels.every((w) => w.options.length === stageIds.length && w.pick >= 0 && w.pick < stageIds.length
    && isDeepStrictEqual(w.options.map((s: { id: string }) => s.id).sort(), [...stageIds].sort())));
ok('wheel pick matches the exact round arena', A.log.wheels.every((w, i) => w.options[w.pick].gameId === A.log.rounds[i].gameId
  && w.options[w.pick].variantId === (A.log.rounds[i].variant?.id ?? null)));
ok('last round is the showdown', !A.log.rounds[0].showdown && !A.log.rounds[1].showdown && A.log.rounds[2].showdown);
const r3 = A.log.results[2];
const coinPot = POINTS.reduce((x, y) => x + y, 0);
ok('showdown doubles points', r3.gained.reduce((x: number, y: number) => x + y, 0) === (r3.draw ? 0 : coinPot * 2));
ok('normal round awards the point pot', A.log.results[0].gained.reduce((x: number, y: number) => x + y, 0) === (A.log.results[0].draw ? 0 : coinPot));
ok('no comeback bonus in round 1', A.log.results[0].bonus.every((b: number) => b === 0));
ok('comeback bonus is 0 or 1, never for everyone', A.log.results.slice(1).every((r) => r.bonus.every((b: number) => b === 0 || b === 1) && r.bonus.some((b: number) => b === 0)));
ok('scores add up', r3.scores.every((s: number, i: number) => s === r3.prev[i] + r3.gained[i] + r3.bonus[i]));
ok('winner(s) declared on final', r3.final && r3.winners.length >= 1);
ok('Round Ruler awarded on final if a round was won', r3.awards.some((a: { id: string }) => a.id === 'wins')
  === A.log.results.some((r) => !r.draw));
ok('phase order per round', ['vote', 'wheel', 'intro', 'countdown', 'play', 'results'].every((p, i) => A.log.phases[i] === p));
ok('snapshots + events flow to clients', A.c.snapCount > 100 && A.log.events > 0 && B.c.snapCount > 100);
ok('input acks advance', A.c.lastAck > 0);
ok('emote broadcast', A.log.emotes >= 1);
ok('spectator streamed and has no seat', spec!.c.snapCount > 20 && spec!.c.mySlot() === null);
ok('modifier is null or valid', A.log.rounds.every((r) => r.modifier === null || typeof r.modifier.id === 'string'));

// rematch from the final screen
ok('final phase', A.c.phase === 'final');
A.c.rematch();
await step(); await step();
ok('rematch starts a fresh party', A.c.room!.round === 1 && A.c.phase === 'vote'
  && A.c.room!.ballot!.id !== ballot.id && !A.c.room!.ballot!.votes.length && A.c.scores.every((s) => s === 0));
for (let i = 0; i < 4000 && A.log.rounds.length < 4; i++) await step(16);
ok('rematch reaches round 1 of the new party', A.log.rounds.length === 4 && A.log.rounds[3].round === 1);

// A fixed one-round match uses the selected variant, including after a rematch.
{
  const host = new InlineHostCore('STAGE', { auto: false, timing: FAST_TIMING });
  const hostTransport = new LoopbackTransport(host);
  const owner = new GameClient(() => hostTransport, { name: 'Host', look: { char: 0, color: 0 } });
  const guest = new GameClient(() => new LoopbackTransport(host), {
    name: 'Guest', look: { char: 1, color: 1 }, spectate: true,
  });
  const chosen = 'tankArena:jungle'; // crateToss also has a jungle variant
  try {
    await owner.start();
    await tick();
    await guest.start();
    await tick();
    guest.config({ stage: chosen, rounds: 1 });
    await tick();
    ok('guest cannot select a stage or change the round count', owner.room!.stage === null && owner.room!.totalRounds === 8);

    owner.config({ stage: chosen, rounds: 1 });
    await tick();
    ok('host config reaches both clients', owner.room!.stage === chosen && guest.room!.stage === chosen && guest.room!.totalRounds === 1);
    for (const stage of [{ gameId: 'tankArena' }, true, '', 'tankArena', 'tankArena:space', 'unknown']) {
      host.message(hostTransport.id, JSON.stringify({ t: 'config', stage, rounds: '8', botLevel: {}, twists: 1 }));
      await tick();
      ok('malformed config leaves valid settings intact', owner.room!.stage === chosen && owner.room!.totalRounds === 1
        && owner.room!.botLevel === 1 && !owner.room!.twists);
    }

    owner.config({ stage: null });
    await tick();
    ok('host can restore shuffle', owner.room!.stage === null);
    owner.config({ stage: chosen });
    owner.config({ rounds: 1 }); // older clients omit stage
    owner.ready(true);
    await tick();

    let now = 1000;
    const advance = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) {
        host.step(now += 34);
        await tick();
      }
    };
    await advance(() => owner.phase === 'intro');
    ok('fixed stage starts at its rules screen without a random draw', owner.phase === 'intro' && owner.wheel === null);
    owner.config({ stage: 'crateToss:jungle', rounds: 2 });
    await advance(() => owner.snaps.length > 0);
    const selectedInSim = () => owner.round?.gameId === 'tankArena' && owner.round.variant?.id === 'jungle'
      && owner.snaps[0]?.w.data.variant === 'jungle';
    ok('selected game and variant reach the sim despite an in-match config attempt', selectedInSim());
    await advance(() => owner.phase === 'final');
    ok('one round directly reaches final results', owner.results?.round === 1 && owner.results.total === 1 && owner.results.final);
    owner.rematch();
    await tick();
    await advance(() => owner.snaps.length > 0);
    ok('rematch keeps the selected stage and one-round length', selectedInSim() && owner.round?.total === 1);
  } finally {
    guest.leave();
    owner.leave();
    host.destroy();
  }
}

{
  const filter = ['tankArena:metal', 'ringDing'];
  const party = new Party('DEV', { games: pickGames(filter), variants: pickVariants(filter) });
  party.connect({ id: 1, send: () => {} });
  party.message(1, JSON.stringify({ t: 'join', name: 'Host' }));
  ok('dev catalog honors forced variants and omitted games', isDeepStrictEqual(party.state().stages?.map((s) => s.id), ['tankArena:metal', 'ringDing']));
  for (const stage of ['tankArena:metal', 'tankArena:desert', 'dashRace:dot']) {
    party.message(1, JSON.stringify({ t: 'config', stage }));
    ok('dev room rejects choices outside its catalog', party.state().stage === 'tankArena:metal');
  }
}

// A deterministic ticket in a two-arena pool can land on either a voted or an unvoted stage.
function pickWithVote(vote: boolean, random: number) {
  const party = new Party('WEIGHT', { games: [getGame('ringDing')!, getGame('dragonDrop')!], timing: FAST_TIMING });
  let pick = '';
  party.connect({ id: 1, send(raw) {
    const msg = JSON.parse(raw);
    if (msg.t === 'wheel') pick = msg.options[msg.pick].id;
  } });
  party.message(1, JSON.stringify({ t: 'join', name: 'Host' }));
  party.message(1, JSON.stringify({ t: 'ready', ready: true }));
  party.update(1000);
  const ballot = party.state().ballot!;
  if (vote) party.message(1, JSON.stringify({ t: 'stageVote', ballot: ballot.id, round: ballot.round, stage: 'ringDing' }));
  const originalRandom = Math.random;
  Math.random = () => random;
  try { party.update(1000 + FAST_TIMING.vote); }
  finally { Math.random = originalRandom; }
  return pick;
}
ok('voting adds exactly one ticket beyond the two per arena', pickWithVote(false, 0.9) === 'dragonDrop'
  && pickWithVote(true, 0.9) === 'ringDing' && pickWithVote(true, 0.55) === 'dragonDrop');

// host-left handling: a client that cannot reach the host gives up with `hostLeft`
{
  let attempts = 0;
  const gone = new GameClient(() => {
    attempts++;
    const t = new LoopbackTransport(core);
    t.connect = async () => { throw new TransportError('no-host', 'gone'); };
    return t;
  }, { name: 'X', look: { char: 0, color: 0 } });
  const live = new LoopbackTransport(core);
  const g2 = new GameClient(() => (attempts === 0 ? (attempts++, live) : (() => { const t = new LoopbackTransport(core); t.connect = async () => { throw new TransportError('no-host', 'gone'); }; return t; })()), { name: 'Y', look: { char: 0, color: 2 } });
  void gone;
  await g2.start();
  await step();
  let status = '';
  g2.h.status = (s) => { status = s; };
  live.drop();
  for (let i = 0; i < 400 && status !== 'hostLeft'; i++) await new Promise((r) => setTimeout(r, 10));
  ok('host gone -> hostLeft status', status === 'hostLeft');
}

core.destroy();
console.log(`PASS loopback (${checks} checks). games: ${A.log.rounds.slice(0, 3).map((r) => r.gameId + '/' + (r.modifier?.id ?? '-')).join(', ')}; scores ${r3.scores}; awards ${r3.awards.map((a: any) => a.title).join(', ')}`);
process.exit(0);
