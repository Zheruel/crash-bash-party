// The party engine: lobby, round flow, scoring, snapshots. Transport-agnostic:
// it only needs "connections" that can send strings. It runs inside a Web Worker in the
// host's browser (PeerJS mode) or inside the Node ws server (LAN mode).
import { getGame, GAMES } from './registry';
import { CT_OPENING_TICKS } from './games/crateToss';
import { BALLISTIX_OPENING_TICKS } from './games/ballDefence';
import { POLAR_WIN_TALLY_TICKS } from './games/pushOff';
import { dragonResultFrames } from './games/dragonDrop';
import { pogoResultWindowTicks } from './games/tilePainter';
import { modifiersFor } from './modifiers';
import { createWorld, roundOver, stepWorld } from './sim';
import { botInput } from './bots';
import { COLORS, CHARACTERS, EMOTES, sanitizeLook, winnerCheerFrame, type Look } from './look';
import { DEFAULT_CUPS_TO_WIN, INPUT_HISTORY, NUMBERED_COUNTDOWN_TICKS, isCupsToWin, readsCountdownPad } from './protocol';
import type { Award, C2S, Phase, ResultsMsg, RoomState, RoundMsg, S2C, Seat, SeatInfo, StageBallot, StageOption, WheelMsg, WinCondition } from './protocol';
import { DT, IDLE, MAX_SEATS, POINTS, type Input, type InputState, type MiniGame, type Modifier, type World } from './types';

export interface Conn {
  id: number;
  /** `unreliable` hints that this message may be dropped/reordered (snapshots). */
  send(data: string, unreliable?: boolean): void;
}

export interface Timing {
  intro: number;
  countdown: number;
  results: number;
  vote: number;
  wheel: number;
  final: number;
  /** cap on play time in seconds (tests) */
  playCap: number;
  /** how long a dropped player's seat is held (ms) */
  grace: number;
}
export const STANDINGS_MIN_MS = 1200;
export const NORMAL_TIMING: Timing = { intro: 4200, countdown: 2800, results: 7500, vote: 5000, wheel: 3200, final: 40000, playCap: Infinity, grace: 60000 };
export const FAST_TIMING: Timing = { intro: 200, countdown: 200, results: 200, vote: 200, wheel: 200, final: 600, playCap: 3, grace: 20000 };

export interface PartyOptions {
  timing?: Timing;
  rounds?: number;
  /** restrict the game pool (tests) */
  games?: MiniGame[];
  /** force a variant per game id (dev: ?game=tilePainter:agogo) */
  variants?: Record<string, string>;
  /** dev sweeps only (?chars=, ?allbots=1): force the four seat characters per round, and let bots drive human seats */
  dev?: { chars?: number[]; bots?: boolean };
}

interface Member {
  id: number;
  token: string;
  name: string;
  look: Look;
  conn: Conn | null;
  ready: boolean;
  queue: Input[];
  cur: InputState;
  idleTicks: number;
  lastRecv: number;
  applied: number;
  lastEmote: number;
  lostAt: number;
}

interface Stats { kos: number; dealt: number; taken: number; wins: number; emotes: number; comebacks: number }
const newStats = (): Stats => ({ kos: 0, dealt: 0, taken: 0, wins: 0, emotes: 0, comebacks: 0 });

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const readPad = (m: Input, seq: number): Input => ({
  seq, x: num(m.x, -1, 1), y: num(m.y, -1, 1), a: !!m.a, b: !!m.b,
  ...(m.c ? { c: true } : {}), ...(m.d ? { d: true } : {}), ...(m.l ? { l: true } : {}), ...(m.r ? { r: true } : {}),
});
const samePad = (a: InputState, b: InputState) => a.x === b.x && a.y === b.y && a.a === b.a && a.b === b.b
  && a.c === b.c && a.d === b.d && a.l === b.l && a.r === b.r;
const roundJson = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
const shuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const token = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

let nextMemberId = 1;

export class Party {
  readonly timing: Timing;
  private members = new Map<number, Member>();
  private byConn = new Map<number, Member>();
  private seats: (number | null)[] = [null, null, null, null]; // member ids
  private pool: MiniGame[];
  // A room keeps its CPU lineup. Reserve human picks first when seats change.
  private cpuRoster = shuffle(CHARACTERS.map((_, i) => i));
  private stages: StageOption[];
  private ballot: StageBallot | undefined;
  private ballotId = 0;
  private stage: StageOption | null = null;

  phase: Phase = 'lobby';
  private phaseStartedAt = 0;
  private phaseEnds = 0;
  private totalRounds: number;
  private winCondition: WinCondition = 'rounds';
  private cupsToWin = DEFAULT_CUPS_TO_WIN;
  private round = 0;
  private botLevel = 1;
  private twists = false;
  private scores = [0, 0, 0, 0];
  private wins = [0, 0, 0, 0];
  private stats: Stats[] = [newStats(), newStats(), newStats(), newStats()];
  private hostId = 0;
  private rematch = new Set<number>();

  private game: MiniGame | null = null;
  private world: World | null = null;
  private frozen: SeatInfo[] = [];
  /** Stages already played this party: the draw leaves them out until every stage has had a turn. */
  private played: StageOption[] = [];
  private next: { game: MiniGame; mod: Modifier | null; showdown: boolean; variant: { id: string; name: string } | null } | null = null;
  private lastWheel: WheelMsg | null = null;
  private lastRound: RoundMsg | null = null;
  private lastResults: ResultsMsg | null = null;
  private lastEv = 0;
  private acc = 0;
  private now = 0;
  private lastUpdate = 0;
  private lastSnap = '';

  constructor(public readonly code: string, private opts: PartyOptions = {}) {
    this.timing = opts.timing ?? NORMAL_TIMING;
    this.totalRounds = opts.rounds ?? 8;
    this.pool = opts.games ?? GAMES;
    this.stages = this.pool.flatMap<StageOption>((game) => {
      const variants = game.variants ?? [];
      const forced = variants.find((v) => v.id === opts.variants?.[game.id]);
      return variants.length
        ? (forced ? [forced] : variants).map((v) => ({ id: `${game.id}:${v.id}`, gameId: game.id, variantId: v.id, name: v.name }))
        : [{ id: game.id, gameId: game.id, variantId: null, name: game.name }];
    });
  }

  // ---- connections ----
  /** A transport connection opened. The player only exists once it sends `join`. */
  connect(conn: Conn) {
    this.pendingConns.set(conn.id, conn);
  }

  disconnect(connId: number) {
    this.pendingConns.delete(connId);
    const m = this.byConn.get(connId);
    this.byConn.delete(connId);
    if (!m || m.conn?.id !== connId) return;
    m.conn = null;
    m.lostAt = this.now;
    m.queue = [];
    m.cur = IDLE;
    if (this.phase === 'lobby') m.ready = false;
    this.rematch.delete(m.id);
    this.fixHost();
    this.broadcastRoom();
  }

  get empty() {
    return this.members.size === 0;
  }
  get connected() {
    return [...this.members.values()].filter((m) => m.conn).length;
  }

  private fixHost() {
    const h = this.members.get(this.hostId);
    if (h?.conn) return;
    const next = [...this.members.values()].find((m) => m.conn);
    this.hostId = next ? next.id : this.hostId;
  }

  private join(conn: Conn, msg: Extract<C2S, { t: 'join' }>) {
    const name = String(msg.name ?? '').trim().slice(0, 16) || 'Player';
    // rejoin with token -> same member, same seat
    let m: Member | undefined;
    if (typeof msg.token === 'string') m = [...this.members.values()].find((x) => x.token === msg.token);
    const resumed = !!m;
    if (m) {
      if (m.conn && m.conn.id !== conn.id) this.byConn.delete(m.conn.id);
      m.queue = []; m.cur = IDLE; m.lastRecv = m.applied; m.idleTicks = 0;
      m.conn = conn;
      m.name = name;
    } else {
      m = { id: nextMemberId++, token: token(), name, look: sanitizeLook(msg.look), conn, ready: false, queue: [], cur: IDLE, idleTicks: 0, lastRecv: 0, applied: 0, lastEmote: 0, lostAt: 0 };
      this.members.set(m.id, m);
      m.look = this.freeLook(m.look, m.id);
      if (!msg.spectate && this.phase === 'lobby') this.sit(m);
    }
    this.byConn.set(conn.id, m);
    this.fixHost();
    if (!this.members.get(this.hostId)?.conn) this.hostId = m.id;
    this.send(m, { t: 'joined', id: m.id, code: this.code, token: m.token, resumed });
    this.send(m, { t: 'room', room: this.state() });
    // catch the newcomer up with whatever is on screen
    if (this.phase === 'vote' || this.phase === 'wheel') {
      const ms = Math.max(0, this.phaseEnds - this.now);
      const elapsedMs = Math.max(0, this.now - this.phaseStartedAt);
      if (this.phase === 'wheel' && this.lastWheel) this.send(m, { ...this.lastWheel, ms, elapsedMs: elapsedMs || undefined });
      this.send(m, { t: 'phase', phase: this.phase, ms, elapsedMs });
    } else if (this.world && this.lastRound) {
      this.send(m, this.lastRound);
      this.send(m, { t: 'phase', phase: this.phase, ms: Math.max(0, this.phaseEnds - this.now), elapsedMs: Math.max(0, this.now - this.phaseStartedAt) });
      if (this.lastSnap) this.sendRaw(m, this.snapFor(m));
      if ((this.phase === 'results' || this.phase === 'final') && this.lastResults) this.send(m, this.lastResults);
    }
    this.broadcastRoom();
  }

  private sit(m: Member) {
    if (this.seats.includes(m.id)) return;
    const free = this.seats.indexOf(null);
    if (free >= 0) this.seats[free] = m.id;
  }

  /** Keep colours unique among seated humans (and make sure a free one is chosen). */
  private freeLook(look: Look, forId: number): Look {
    const taken = new Set<number>();
    for (const mm of this.members.values()) if (mm.id !== forId && this.seats.includes(mm.id)) taken.add(mm.look.color);
    let c = look.color;
    for (let i = 0; i < COLORS.length && taken.has(c); i++) c = (c + 1) % COLORS.length;
    return { char: look.char, color: c };
  }

  // ---- messages in ----
  message(connId: number, data: string) {
    let m: C2S;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const mem = this.byConn.get(connId);
    if (!mem) {
      if (m.t === 'join') this.join(this.connFor(connId), m);
      return;
    }
    this.onMessage(mem, m);
  }

  private pendingConns = new Map<number, Conn>();
  private connFor(id: number): Conn {
    const c = this.pendingConns.get(id);
    if (!c) throw new Error('unknown connection ' + id);
    return c;
  }

  private onMessage(c: Member, m: C2S) {
    switch (m.t) {
      case 'join': // duplicate join on an existing connection: just refresh the name
        return;
      case 'input': {
        const opening = m.opening === true;
        if (m.round !== undefined && m.round !== this.round) return;
        if (opening && (!readsCountdownPad(this.game?.id) || m.round === undefined)) return;
        if (this.phase !== (opening ? 'countdown' : 'play')) return;
        const seq = Math.floor(num(m.seq, 0, 1e9));
        if (seq <= c.lastRecv) return;
        const input = readPad(m, seq);
        // Seed the held pad for GO. A live packet can still replace it on the first tick.
        if (opening) {
          if (this.world?.data.variant === 'splash') input.b = false;
          c.cur = input;
          c.applied = c.lastRecv = seq;
          c.idleTicks = 0;
          return;
        }
        if (seq > c.lastRecv + 1 && m.round === this.round && Array.isArray(m.recent)) {
          const recent = m.recent;
          for (let i = Math.max(0, recent.length - INPUT_HISTORY); i < recent.length; i++) {
            const prior = recent[i];
            const expected = seq - (recent.length - i);
            if (expected > c.lastRecv && prior?.seq === expected) c.queue.push(readPad(prior, expected));
          }
        }
        c.lastRecv = seq;
        c.queue.push(input);
        if (c.queue.length > 8) c.queue.splice(0, c.queue.length - 8);
        return;
      }
      case 'ready':
        if (this.phase === 'lobby' && this.seats.includes(c.id)) { c.ready = !!m.ready; this.broadcastRoom(); }
        return;
      case 'seat':
        if (this.phase !== 'lobby') return;
        if (m.take) {
          this.sit(c);
          c.look = this.freeLook(c.look, c.id);
        } else {
          const i = this.seats.indexOf(c.id);
          if (i >= 0) { this.seats[i] = null; c.ready = false; }
        }
        this.broadcastRoom();
        return;
      case 'look':
        if (this.phase !== 'lobby') return;
        {
          const want = sanitizeLook(m.look);
          const clash = [...this.members.values()].some((o) => o.id !== c.id && this.seats.includes(o.id) && this.seats.includes(c.id) && o.look.color === want.color);
          c.look = { char: want.char, color: clash ? c.look.color : want.color };
          this.broadcastRoom();
        }
        return;
      case 'config':
        if (this.phase === 'lobby' && c.id === this.hostId) {
          if (typeof m.rounds === 'number' && Number.isFinite(m.rounds)) this.totalRounds = Math.floor(num(m.rounds, 1, 20));
          if (m.winCondition === 'rounds' || m.winCondition === 'cups') this.winCondition = m.winCondition;
          if (isCupsToWin(m.cupsToWin)) this.cupsToWin = m.cupsToWin;
          if (typeof m.twists === 'boolean') this.twists = m.twists;
          if (typeof m.botLevel === 'number' && Number.isFinite(m.botLevel)) this.botLevel = Math.floor(num(m.botLevel, 0, 2));
          if (m.stage === null) this.stage = null;
          else if (typeof m.stage === 'string') {
            const stage = this.stages.find((s) => s.id === m.stage);
            if (stage) this.stage = stage;
          }
          this.broadcastRoom();
        }
        return;
      case 'stageVote': {
        const ballot = this.ballot;
        if (!ballot || this.phase !== 'vote' || this.now >= this.phaseEnds
          || m.ballot !== ballot.id || m.round !== ballot.round
          || !c.conn || !this.seats.includes(c.id)
          || !ballot.options.some((stage) => stage.id === m.stage)
          || ballot.votes.some((vote) => vote.playerId === c.id)) return;
        ballot.votes.push({ playerId: c.id, stageId: m.stage });
        this.broadcastRoom();
        return;
      }
      case 'emote': {
        const slot = this.seats.indexOf(c.id);
        const id = Math.floor(num(m.id, 0, EMOTES.length - 1));
        if (slot < 0 || this.now - c.lastEmote < 250) return;
        c.lastEmote = this.now;
        this.stats[slot].emotes++;
        this.broadcast({ t: 'emote', slot, id });
        return;
      }
      case 'skip':
        // host fast-forwards waiting screens (never gameplay)
        if (c.id === this.hostId && (this.phase === 'wheel' || this.phase === 'intro' || this.phase === 'results')) this.phaseEnds = Math.min(this.phaseEnds, this.now);
        return;
      case 'rematch':
        if (this.phase !== 'final' || !this.seats.includes(c.id)) return;
        this.rematch.add(c.id);
        this.broadcastRoom();
        {
          const humans = this.seats.filter((id): id is number => id != null && !!this.members.get(id)?.conn);
          if (this.rematch.has(this.hostId) || humans.every((id) => this.rematch.has(id))) this.startParty(this.now);
        }
        return;
    }
  }

  // ---- state out ----
  private seatLooks(): Look[] {
    const used = new Set<number>();
    const looks: (Look | null)[] = this.seats.map((id) => {
      const m = id != null ? this.members.get(id) : undefined;
      if (m) used.add(m.look.color);
      return m ? m.look : null;
    });
    const humanChars = new Set(looks.flatMap(l => l ? [l.char] : []));
    const available = this.cpuRoster.filter(char => !humanChars.has(char));
    return looks.map((l, i) => {
      if (l) return l;
      let c = (i * 3 + 1) % COLORS.length;
      for (let k = 0; k < COLORS.length && used.has(c); k++) c = (c + 1) % COLORS.length;
      used.add(c);
      return { char: available.shift() ?? this.cpuRoster[i], color: c };
    });
  }

  state(): RoomState {
    const looks = this.seatLooks();
    const seats: Seat[] = this.seats.map((id, i) => {
      const m = id != null ? this.members.get(id) : undefined;
      return {
        clientId: m ? m.id : null,
        name: m ? m.name : CHARACTERS[looks[i].char].name,
        ready: m ? m.ready : true,
        score: this.scores[i],
        look: looks[i],
        connected: m ? !!m.conn : true,
      };
    });
    const spectators = [...this.members.values()].filter((m) => !this.seats.includes(m.id) && m.conn).map((m) => ({ id: m.id, name: m.name }));
    return {
      code: this.code, phase: this.phase, hostId: this.hostId, totalRounds: this.totalRounds, round: this.round,
      winCondition: this.winCondition, cupsToWin: this.cupsToWin, botLevel: this.botLevel,
      twists: this.winCondition === 'rounds' && this.twists,
      stage: this.stage?.id ?? null, stages: this.stages, ballot: this.ballot, seats, spectators, rematch: this.rematch.size,
    };
  }

  private get cupTarget() {
    return this.winCondition === 'cups' ? this.cupsToWin : undefined;
  }

  private sendRaw(m: Member, s: string, unreliable = false) {
    m.conn?.send(s, unreliable);
  }
  private send(m: Member, msg: S2C) {
    this.sendRaw(m, JSON.stringify(msg));
  }
  private broadcast(msg: S2C) {
    const s = JSON.stringify(msg);
    for (const m of this.members.values()) this.sendRaw(m, s);
  }
  private broadcastRoom() {
    this.broadcast({ t: 'room', room: this.state() });
  }
  private snapFor(m: Member) {
    return `{"t":"snap","round":${this.round},"tick":${this.world!.tick},"ack":${m.applied},"w":${this.lastSnap}}`;
  }
  private broadcastSnap(reliable = false) {
    if (!this.world) return;
    this.lastSnap = JSON.stringify(this.world, roundJson);
    for (const m of this.members.values()) if (m.conn) this.sendRaw(m, this.snapFor(m), !reliable);
  }

  private setPhase(p: Phase, ms: number, now: number) {
    this.phase = p;
    this.phaseStartedAt = now;
    this.phaseEnds = now + ms;
    this.broadcast({ t: 'phase', phase: p, ms });
    this.broadcastRoom();
  }

  // ---- flow ----
  /** Drive the party. Call often (8-16 ms) with a monotonic clock in ms. */
  update(now: number) {
    const last = this.lastUpdate || now;
    this.lastUpdate = now;
    this.now = now;
    // drop members whose grace expired
    for (const m of [...this.members.values()]) {
      if (!m.conn && now - m.lostAt > this.timing.grace) {
        this.members.delete(m.id);
        if (this.ballot) this.ballot.votes = this.ballot.votes.filter((vote) => vote.playerId !== m.id);
        const i = this.seats.indexOf(m.id);
        if (i >= 0) this.seats[i] = null;
        this.fixHost();
        this.broadcastRoom();
      }
    }
    const T = this.timing;
    switch (this.phase) {
      case 'lobby': {
        const humans = this.seats.filter((id): id is number => id != null).map((id) => this.members.get(id)!).filter((m) => m.conn);
        if (humans.length && humans.every((m) => m.ready)) this.startParty(now);
        break;
      }
      case 'vote':
        if (now >= this.phaseEnds) this.drawStage(now);
        break;
      case 'wheel':
        if (now >= this.phaseEnds) this.startRound(now);
        break;
      case 'intro':
        if (now >= this.phaseEnds) {
          const ticks = NUMBERED_COUNTDOWN_TICKS + (this.lastRound?.countdownLeadTicks ?? 0);
          this.setPhase('countdown', T.countdown * ticks / NUMBERED_COUNTDOWN_TICKS, now);
        }
        break;
      case 'countdown':
        if (now >= this.phaseEnds) {
          if (this.game?.primeCountdownPad && this.world) {
            for (const [slot, id] of this.seats.entries()) {
              if (id !== null) this.game.primeCountdownPad(this.world, slot, this.members.get(id)?.cur ?? IDLE);
            }
          }
          this.setPhase('play', 0, now);
          this.acc = 0;
        }
        break;
      case 'play':
        this.acc += now - last;
        for (let n = 0; n < 5 && this.acc >= DT * 1000; n++) {
          this.acc -= DT * 1000;
          this.tick();
          if (this.phase !== 'play') break;
        }
        if (this.acc > 500) this.acc = 0;
        break;
      case 'results':
        if (now >= this.phaseEnds) this.queueNext(now);
        break;
      case 'final':
        if (now >= this.phaseEnds) this.toLobby(now);
        break;
    }
  }

  private startParty(now: number) {
    this.scores = [0, 0, 0, 0];
    this.stats = [newStats(), newStats(), newStats(), newStats()];
    this.round = 0;
    this.played = [];
    this.ballot = undefined;
    this.lastWheel = null;
    this.rematch.clear();
    this.lastResults = null;
    this.wins = [0, 0, 0, 0];
    this.queueNext(now);
  }

  /** Pick a round for Party, or reuse the opening stage throughout a cups battle. */
  private queueNext(now: number) {
    this.round++;
    const cupsToWin = this.cupTarget;
    if (cupsToWin !== undefined && this.round > 1) {
      this.startRound(now);
      return;
    }
    if (this.stage) {
      this.prepareStage(this.stage);
      this.startRound(now);
      return;
    }
    const fresh = this.freshStages();
    if (fresh.length > 1) {
      this.ballot = {
        id: ++this.ballotId, round: this.round,
        options: shuffle([...fresh]).slice(0, 3), votes: [],
      };
      this.setPhase('vote', this.timing.vote, now);
      return;
    }
    this.drawStage(now);
  }

  /** Stages not played yet this party; once every stage has had a turn, everything again. */
  private freshStages(): StageOption[] {
    const ids = new Set(this.played.map((s) => s.id));
    const fresh = this.stages.filter((s) => !ids.has(s.id));
    if (fresh.length) return fresh;
    this.played = [];
    return this.stages;
  }

  private prepareStage(stage: StageOption) {
    if (!this.played.some((s) => s.id === stage.id)) this.played.push(stage);
    const game = this.pool.find((g) => g.id === stage.gameId)!;
    const mods = this.cupTarget === undefined && this.twists ? modifiersFor(game.id) : [];
    const mod = mods.length && Math.random() < 0.65 ? mods[Math.floor(Math.random() * mods.length)] : null;
    const showdown = this.cupTarget === undefined && this.round >= this.totalRounds;
    const variant = stage.variantId === null ? null : { id: stage.variantId, name: stage.name };
    return this.next = { game, mod, showdown, variant };
  }

  private drawStage(now: number) {
    // Every arena has two tickets. Each accepted vote adds one ticket to that arena.
    const options = shuffle([...this.freshStages()]);
    const tickets = options.flatMap((stage) => [stage, stage]);
    for (const vote of this.ballot?.votes ?? []) {
      const stage = options.find((s) => s.id === vote.stageId);
      if (stage) tickets.push(stage);
    }
    const pick = options.indexOf(tickets[Math.floor(Math.random() * tickets.length)]);
    this.ballot = undefined;
    const { showdown, mod } = this.prepareStage(options[pick]);
    this.lastWheel = {
      t: 'wheel', round: this.round, total: this.totalRounds, cupsToWin: this.cupTarget, showdown,
      options, pick, modifier: mod ? { id: mod.id, name: mod.name, desc: mod.desc } : null,
      ms: this.timing.wheel,
    };
    this.broadcast(this.lastWheel);
    this.setPhase('wheel', this.timing.wheel, now);
  }

  private startRound(now: number) {
    const { game, mod, showdown, variant } = this.next!;
    const looks = this.seatLooks();
    const dev = this.opts.dev;
    if (dev?.chars?.length) {
      // dev sweep: rotate through the list so every character is seated across consecutive rounds
      for (let i = 0; i < looks.length; i++) looks[i] = { char: dev.chars[((this.round - 1) * looks.length + i) % dev.chars.length], color: looks[i].color };
    }
    this.frozen = this.seats.map((id, i) => {
      const m = id != null ? this.members.get(id) : undefined;
      return { name: m && !dev?.bots ? m.name : CHARACTERS[looks[i].char].name, bot: !m || !!dev?.bots, look: looks[i] };
    });
    this.game = game;
    this.world = createWorld(game, this.frozen.map((f, slot) => ({ slot, name: f.name, bot: f.bot, char: f.look.char, level: this.botLevel })), mod ? [mod] : [], (Math.random() * 2 ** 32) >>> 0, variant?.id);
    this.lastEv = 0;
    for (const m of this.members.values()) { m.queue = []; m.cur = IDLE; m.lastRecv = 0; m.applied = 0; m.idleTicks = 0; }
    this.lastRound = {
      t: 'round', round: this.round, total: this.totalRounds, cupsToWin: this.cupTarget, showdown, gameId: game.id, gameName: game.name, variant,
      // Individual-versus Dash exposes the arena at stage update 4 and draws 3 on update 29.
      countdownLeadTicks: game.id === 'ballDefence' ? BALLISTIX_OPENING_TICKS - NUMBERED_COUNTDOWN_TICKS
        : game.id === 'crateToss' ? CT_OPENING_TICKS - NUMBERED_COUNTDOWN_TICKS
        : game.id === 'dashRace' ? 25 : ['ringDing', 'dragonDrop', 'malletMash', 'kegKaboom'].includes(game.id) ? 11 : undefined,
      desc: game.variantDescriptions?.[variant?.id ?? ''] ?? game.description,
      controls: game.variantControls?.[variant?.id ?? ''] ?? game.controls, modifier: mod ? { id: mod.id, name: mod.name, desc: mod.desc } : null, seats: this.frozen.map((f) => ({ ...f })),
    };
    this.lastResults = null;
    this.broadcast(this.lastRound);
    this.broadcastSnap();
    this.setPhase('intro', this.timing.intro, now);
  }

  private tick() {
    const game = this.game!, world = this.world!;
    const inputs: (InputState | null)[] = [];
    for (let slot = 0; slot < MAX_SEATS; slot++) {
      const id = this.seats[slot];
      const m = id != null ? this.members.get(id) : undefined;
      if (m && m.conn && !this.frozen[slot].bot) {
        // Catch up after jitter by skipping repeated holds. A release between
        // taps has to reach the game for the second press to register.
        if (m.queue.length > 3) {
          while (m.queue.length > 2) {
            const repeat = m.queue.findIndex((pad, i) => i < m.queue.length - 1
              && (samePad(pad, m.queue[i + 1]) || (i === 0 && samePad(pad, m.cur))));
            if (repeat < 0) break;
            m.queue.splice(repeat, 1);
          }
        }
        const next = m.queue.shift();
        if (next) { m.cur = next; m.applied = next.seq; m.idleTicks = 0; }
        else if (++m.idleTicks > 6) m.cur = IDLE;
        inputs.push(m.cur);
      } else {
        let b = botInput(game, world, slot);
        if (world.params.mirror) b = { ...b, x: -b.x, y: -b.y, l: b.r, r: b.l }; // stepWorld flips it back
        inputs.push(b);
      }
    }
    stepWorld(world, game, inputs);
    for (const e of world.ev) {
      if (e.id <= this.lastEv) continue;
      this.lastEv = e.id;
      const attacker = this.stats[e.o], target = this.stats[e.s];
      // Pogo monster shots carry owner 5. Only a contest between seats awards combat stats.
      if (!attacker || !target) continue;
      if (e.k === 'ko') attacker.kos++;
      else if (e.k === 'hit') { attacker.dealt++; target.taken++; }
    }
    const finished = roundOver(game, world) || world.time >= this.timing.playCap;
    if (finished) world.finished = true;
    this.broadcastSnap(finished);
    if (finished) this.finishRound(this.now);
  }

  private finishRound(now: number) {
    const game = this.game!, world = this.world!;
    const order = game.placements(world);
    const winner = order[0];
    const cupsToWin = this.cupTarget;
    const showdown = this.next?.showdown ?? false;
    const prev = [...this.scores];
    const gained = [0, 0, 0, 0], bonus = [0, 0, 0, 0];
    const draw = game.isDraw?.(world, order) ?? false;
    if (!draw) {
      if (cupsToWin !== undefined) {
        gained[winner] = 1;
        this.scores[winner]++;
      } else {
        // Comeback bonus goes to last place when the scores differ.
        const lo = Math.min(...prev), hi = Math.max(...prev);
        const mult = showdown ? 2 : 1;
        if (this.round > 1 && hi > lo) prev.forEach((v, i) => { if (v === lo) { bonus[i] = 1; this.stats[i].comebacks++; } });
        order.forEach((slot, rank) => { gained[slot] = (POINTS[rank] ?? 0) * mult; this.scores[slot] += gained[slot] + bonus[slot]; });
      }
      this.stats[winner].wins++;
      this.wins[winner]++;
    }
    const final = cupsToWin === undefined ? this.round >= this.totalRounds : this.scores[winner] >= cupsToWin;
    const best = Math.max(...this.scores);
    // ties broken by mini-game wins
    const tied = this.scores.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
    const bw = Math.max(...tied.map((i) => this.wins[i]));
    this.lastResults = {
      t: 'results', round: this.round, total: this.totalRounds, cupsToWin, showdown, draw, placements: order, gained, bonus, prev, scores: [...this.scores],
      stars: [...this.wins], final,
      winners: final ? tied.filter((i) => this.wins[i] === bw) : [],
      awards: final && cupsToWin === undefined ? this.awards() : [],
    };
    this.broadcast(this.lastResults);
    let duration = final ? this.timing.final : this.timing.results;
    if (!final && game.id === 'tilePainter' && duration >= NORMAL_TIMING.results) {
      const char = this.lastRound?.seats[winner]?.look.char ?? 0;
      const resultTicks = pogoResultWindowTicks(world, draw ? undefined : winner, char);
      duration = Math.max(duration, resultTicks * DT * 1000 + STANDINGS_MIN_MS);
    }
    if (!final && !draw && !cupsToWin && duration >= NORMAL_TIMING.results) {
      const char = this.lastRound?.seats[winner]?.look.char ?? 0;
      if (game.id === 'pushOff') duration = Math.max(duration, (winnerCheerFrame(char) + POLAR_WIN_TALLY_TICKS) * DT * 1000 + STANDINGS_MIN_MS);
      if (game.id === 'dragonDrop') duration = Math.max(duration, dragonResultFrames(false, char) * DT * 1000 + STANDINGS_MIN_MS);
    }
    this.setPhase(final ? 'final' : 'results', duration, now);
  }

  private awards(): Award[] {
    const defs: { id: string; title: string; desc: string; pick: (s: Stats) => number; min: number }[] = [
      { id: 'ko', title: 'Knockout King', desc: 'Most knockouts', pick: (s) => s.kos, min: 1 },
      { id: 'wins', title: 'Round Ruler', desc: 'Most round wins', pick: (s) => s.wins, min: 1 },
      { id: 'dealt', title: 'Sharpshooter', desc: 'Most hits landed', pick: (s) => s.dealt, min: 2 },
      { id: 'taken', title: 'Punching Bag', desc: 'Most hits taken', pick: (s) => s.taken, min: 2 },
      { id: 'comeback', title: 'Comeback Kid', desc: 'Most comeback bonuses', pick: (s) => s.comebacks, min: 2 },
      { id: 'emotes', title: 'Chatterbox', desc: 'Most emotes', pick: (s) => s.emotes, min: 2 },
    ];
    const out: Award[] = [];
    for (const d of defs) {
      let slot = -1, v = 0;
      this.stats.forEach((s, i) => { const x = d.pick(s); if (x > v) { v = x; slot = i; } });
      if (slot >= 0 && v >= d.min) out.push({ id: d.id, title: d.title, desc: d.desc, slot, value: v });
    }
    return out.slice(0, 4);
  }

  private toLobby(now: number) {
    this.world = null; this.game = null; this.lastRound = null; this.lastResults = null; this.lastSnap = ''; this.lastWheel = null;
    this.round = 0;
    this.played = [];
    this.rematch.clear();
    for (const m of this.members.values()) m.ready = false;
    this.setPhase('lobby', 0, now);
  }
}

export { getGame };
