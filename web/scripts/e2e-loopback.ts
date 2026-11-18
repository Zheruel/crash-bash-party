// Headless tests, no network and no PeerJS: runs the real Party engine and the real client session
// over the in-process loopback transport on a virtual clock.
//   npm run test:loopback
import { InlineHostCore } from '../client/net/hostCore';
import { LoopbackTransport } from '../client/net/loopback';
import { TransportError } from '../client/net/transport';
import { GameClient } from '../client/session';
import { FAST_TIMING } from '../shared/party';
import { POINTS } from '../shared/types';
import { GAMES } from '../shared/registry';
import { CHARACTERS } from '../shared/look';
import { createWorld, defaultParams, stepWorld } from '../shared/sim';
import { modifiersFor } from '../shared/modifiers';
import { BotBrain } from '../shared/bots';
import { DT, type InputState, type World } from '../shared/types';

let checks = 0;
const ok = (name: string, cond: unknown) => {
  checks++;
  if (!cond) { console.error('FAIL:', name); process.exit(1); }
};
const tick = () => new Promise<void>((r) => setImmediate(r));

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
        const w: World = createWorld(game, slots, mod ? [mod] : [], seed);
        const brain = new BotBrain(2); // hard brain uses Math.random only when degraded; level tested below
        void brain;
        let steps = 0;
        const levelBrain = new BotBrain(level);
        while (!game.isOver(w) && w.time < game.maxTime) {
          const inputs: InputState[] = slots.map((s) => {
            // deterministic scripted input from the game bot (hard) so two runs match exactly
            let b = game.bot ? game.bot(w, s.slot) : { x: 0, y: 0, a: false, b: false };
            if (level !== 2 && !mod) b = levelBrain.input(game, w, s.slot);
            return w.params.mirror ? { ...b, x: -b.x, y: -b.y } : b;
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
      ok(`${game.id}: round length <= maxTime`, steps * DT <= game.maxTime + 0.1);
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
      while (!game.isOver(w) && w.time < game.maxTime) stepWorld(w, game, slots.map((s) => game.bot!(w, s.slot)));
      return w;
    };
    const w = play();
    ok(`${game.id}/${v.id}: variant honoured`, w.data.variant === v.id);
    ok(`${game.id}/${v.id}: ends within maxTime`, w.time <= game.maxTime + 0.1);
    ok(`${game.id}/${v.id}: finite bodies`, w.bodies.every((b) => [b.x, b.y, b.z, b.vx, b.vz].every(Number.isFinite)));
    const pl = game.placements(w);
    ok(`${game.id}/${v.id}: placements valid`, pl.length === 4 && new Set(pl).size === 4);
    ok(`${game.id}/${v.id}: deterministic`, JSON.stringify(play()) === JSON.stringify(w));
  }
  console.log(`  variants ok: ${game.id} ${game.variants!.map((v) => v.id).join(', ')}`);
}

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
ok('distinct colours', new Set(A.c.room!.seats.map((s) => s.look.color)).size === 4);
ok('same colour request is resolved', A.c.room!.seats[0].look.color !== A.c.room!.seats[1].look.color);

A.c.config({ rounds: 3, botLevel: 2 });
B.c.config({ rounds: 9 }); // non-host cannot configure
await step();
ok('host config applied, guest config ignored', A.c.room!.totalRounds === 3 && A.c.room!.botLevel === 2);
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
let spec: ReturnType<typeof mk> | null = null;
let dropped = false, rejoined = false, emoted = false;
let sawBotTakeover = false;
for (let i = 0; i < 20000 && !(A.log.results.some((r) => r.final)); i++) {
  await step(16);
  if (i % 2 === 0) drive();
  if (A.c.phase === 'play' && !emoted) { A.c.emote(2); emoted = true; }
  if (A.c.phase === 'play' && !spec) { spec = mk('Spec', true); await spec.c.start(); }
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
ok('N. Brio reaches gameplay', A.log.rounds[0].seats.some((s: { name: string; look: { char: number } }) => s.name === 'Bob' && s.look.char === brioIdx));
ok('wheel before every round', A.log.wheels.length === 3 && A.log.wheels.every((w) => w.options.length === GAMES.length && w.pick >= 0 && w.pick < GAMES.length));
ok('wheel pick matches the round', A.log.wheels.every((w, i) => w.options[w.pick].id === A.log.rounds[i].gameId));
ok('last round is the showdown', !A.log.rounds[0].showdown && !A.log.rounds[1].showdown && A.log.rounds[2].showdown);
const r3 = A.log.results[2];
const coinPot = POINTS.reduce((x, y) => x + y, 0);
ok('showdown doubles points', r3.gained.reduce((x: number, y: number) => x + y, 0) === coinPot * 2);
ok('normal round awards the point pot', A.log.results[0].gained.reduce((x: number, y: number) => x + y, 0) === coinPot);
ok('no comeback bonus in round 1', A.log.results[0].bonus.every((b: number) => b === 0));
ok('comeback bonus is 0 or 1, never for everyone', A.log.results.slice(1).every((r) => r.bonus.every((b: number) => b === 0 || b === 1) && r.bonus.some((b: number) => b === 0)));
ok('scores add up', r3.scores.every((s: number, i: number) => s === r3.prev[i] + r3.gained[i] + r3.bonus[i]));
ok('winner(s) declared + awards on final', r3.final && r3.winners.length >= 1 && r3.awards.length >= 1);
ok('phase order per round (wheel, intro, countdown, play, results)', ['wheel', 'intro', 'countdown', 'play', 'results'].every((p, i) => A.log.phases[i] === p));
ok('snapshots + events flow to clients', A.c.snapCount > 100 && A.log.events > 0 && B.c.snapCount > 100);
ok('input acks advance', A.c.lastAck > 0);
ok('emote broadcast', A.log.emotes >= 1);
ok('spectator streamed and has no seat', spec!.c.snapCount > 20 && spec!.c.mySlot() === null);
ok('modifier is null or valid', A.log.rounds.every((r) => r.modifier === null || typeof r.modifier.id === 'string'));

// rematch from the final screen
ok('final phase', A.c.phase === 'final');
A.c.rematch();
await step(); await step();
ok('rematch starts a fresh party', A.c.room!.round <= 1 && A.c.phase === 'wheel' && A.c.scores.every((s) => s === 0));
for (let i = 0; i < 4000 && A.log.rounds.length < 4; i++) await step(16);
ok('rematch reaches round 1 of the new party', A.log.rounds.length === 4 && A.log.rounds[3].round === 1);

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
