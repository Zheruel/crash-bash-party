// Headless client state machine: talks to any ClientTransport, tracks the party, runs prediction
// and snapshot interpolation. No DOM / three.js, so tests drive it directly.
import type { RenderWorld } from './games/types';
import type { BallistixData } from '../shared/games/ballDefence';
import { DT, type Body, type GameEvent, type InputState, type World } from '../shared/types';
import type { C2S, MatchConfig, Phase, ResultsMsg, RoomState, RoundMsg, S2C, WheelMsg } from '../shared/protocol';
import { INPUT_HISTORY, readsCountdownPad } from '../shared/protocol';
import { getGame } from '../shared/registry';
import { sanitizeLook, type Look } from '../shared/look';
import { Predictor } from './predict';
import { TransportError, type ClientTransport } from './net/transport';

export type Status = 'connecting' | 'online' | 'reconnecting' | 'hostLeft' | 'failed' | 'left';

export interface Profile {
  name: string;
  look: Look;
  spectate?: boolean;
  /** room code to join; empty = create (ws mode) */
  room?: string;
}

export interface SessionHandlers {
  status?(s: Status, detail?: string): void;
  joined?(code: string, resumed: boolean): void;
  room?(r: RoomState): void;
  wheel?(m: WheelMsg): void;
  round?(m: RoundMsg): void;
  phase?(p: Phase, ms: number): void;
  results?(m: ResultsMsg): void;
  emote?(slot: number, id: number): void;
  event?(e: GameEvent): void;
  error?(msg: string): void;
}

interface Snap { tick: number; w: World; at: number }

const INTERP_TICKS = 3; // render other players ~100 ms in the past
const RETRIES = 6;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class GameClient {
  status: Status = 'connecting';
  me = 0;
  code = '';
  token = '';
  room: RoomState | null = null;
  round: RoundMsg | null = null;
  wheel: WheelMsg | null = null;
  results: ResultsMsg | null = null;
  phase: Phase = 'lobby';
  phaseStartedAt = 0;
  phaseEnds = 0;
  playStartedAt = 0;
  scores = [0, 0, 0, 0];
  roundSlot: number | null = null; // seat identity frozen at round start
  predictor: Predictor | null = null;
  snaps: Snap[] = [];
  snapCount = 0;
  lastAck = 0;
  h: SessionHandlers = {};
  private t: ClientTransport | null = null;
  private lastEv = 0;
  private closing = false;

  constructor(private makeTransport: () => ClientTransport, public profile: Profile) {
    try { this.token = sessionStorage.getItem('pb-token') ?? ''; } catch { /* no storage */ }
  }

  // ---- lifecycle ----
  async start(): Promise<void> {
    this.setStatus('connecting');
    await this.open(true);
  }

  private async open(first: boolean): Promise<void> {
    const t = this.makeTransport();
    try {
      await t.connect();
    } catch (e) {
      t.close();
      if (first) {
        const err = e instanceof TransportError ? e : new TransportError('failed', String(e));
        this.setStatus('failed', err.message);
        throw err;
      }
      throw e;
    }
    this.t = t;
    t.onMessage = (raw) => this.onRaw(raw);
    t.onClose = () => this.onClosed(t);
    const p = this.profile;
    this.rawSend({ t: 'join', name: p.name, room: this.code || p.room || undefined, spectate: p.spectate, token: this.token || undefined, look: p.look });
  }

  private async onClosed(t: ClientTransport) {
    if (this.closing || this.t !== t) return;
    this.t = null;
    this.setStatus('reconnecting');
    for (let i = 0; i < RETRIES && !this.closing; i++) {
      await new Promise((r) => setTimeout(r, 1000 + i * 700));
      if (this.closing) return;
      try {
        await this.open(false);
        return; // `joined` flips us back online
      } catch (e) {
        if (e instanceof TransportError && e.code === 'no-host') break;
      }
    }
    if (!this.closing) this.setStatus('hostLeft');
  }

  leave() {
    this.closing = true;
    this.t?.close();
    this.t = null;
    this.setStatus('left');
  }

  private setStatus(s: Status, detail?: string) {
    this.status = s;
    this.h.status?.(s, detail);
  }

  // ---- send ----
  private rawSend(m: C2S, fast = false) {
    this.t?.send(m, fast);
  }
  ready(ready: boolean) { this.rawSend({ t: 'ready', ready }); }
  seat(take: boolean) { this.rawSend({ t: 'seat', take }); }
  setLook(look: Look) { this.profile.look = look; this.rawSend({ t: 'look', look }); }
  config(c: MatchConfig) { this.rawSend({ t: 'config', ...c }); }
  emote(id: number) { this.rawSend({ t: 'emote', id }); }
  rematch() { this.rawSend({ t: 'rematch' }); }
  voteStage(ballot: number, round: number, stage: string) {
    this.rawSend({ t: 'stageVote', ballot, round, stage });
  }

  skip() { this.rawSend({ t: 'skip' }); }

  mySlot(): number | null {
    const i = this.room ? this.room.seats.findIndex((s) => s.clientId === this.me) : -1;
    return i >= 0 ? i : null;
  }

  /** Sample held controls during the countdown without predicting movement. */
  sendInput(s: InputState) {
    if (!this.predictor || this.roundSlot == null) return;
    const opening = this.phase === 'countdown' && readsCountdownPad(this.round?.gameId);
    if (!opening && this.phase !== 'play') return;
    const inp = { seq: ++this.predictor.seq, ...s };
    if (opening) {
      this.predictor.openingPad = s;
      this.rawSend({ t: 'input', round: this.round?.round, ...inp, opening: true }, true);
      return;
    }
    const recent = this.t?.kind === 'peer' && this.predictor.pending.length
      ? this.predictor.pending.slice(-INPUT_HISTORY) : undefined;
    this.rawSend({ t: 'input', round: this.round?.round, ...inp, recent }, true);
    this.predictor.push(inp);
  }

  // ---- receive ----
  private onRaw(raw: string) {
    let m: S2C;
    try { m = JSON.parse(raw); } catch { return; }
    this.onMessage(m);
  }

  onMessage(m: S2C) {
    const now = performance.now();
    switch (m.t) {
      case 'error':
        this.h.error?.(m.msg);
        if (this.status === 'connecting' || !this.code) { this.setStatus('failed', m.msg); }
        break;
      case 'joined':
        this.me = m.id;
        this.code = m.code;
        this.token = m.token;
        try { sessionStorage.setItem('pb-token', m.token); } catch { /* ignore */ }
        this.setStatus('online');
        this.h.joined?.(m.code, m.resumed);
        break;
      case 'room':
        this.room = m.room;
        this.scores = m.room.seats.map((s) => s.score);
        this.h.room?.(m.room);
        break;
      case 'wheel':
        this.wheel = m;
        this.h.wheel?.(m);
        break;
      case 'round': {
        this.round = m;
        this.results = null;
        this.roundSlot = this.mySlot();
        const game = getGame(m.gameId);
        this.predictor = game ? new Predictor(game, this.roundSlot) : null;
        this.snaps = [];
        this.lastEv = 0;
        this.h.round?.(m);
        break;
      }
      case 'phase':
        this.phase = m.phase;
        this.phaseStartedAt = now - (m.elapsedMs ?? 0);
        this.phaseEnds = now + m.ms;
        if (m.phase === 'vote') this.wheel = null;
        if (m.phase === 'play') this.playStartedAt = this.phaseStartedAt;
        if (m.phase === 'lobby') { this.round = null; this.results = null; this.predictor = null; this.snaps = []; this.wheel = null; }
        this.h.phase?.(m.phase, m.ms);
        break;
      case 'snap': {
        if (m.round !== undefined && m.round !== this.round?.round) break;
        this.snapCount++;
        const last = this.snaps[this.snaps.length - 1];
        if (last && m.tick <= last.tick) break; // reordered/stale
        this.lastAck = m.ack;
        this.snaps.push({ tick: m.tick, w: m.w, at: now });
        if (this.snaps.length > 24) this.snaps.shift();
        this.predictor?.onSnapshot(m.w, m.ack);
        for (const e of m.w.ev ?? []) if (e.id > this.lastEv) { this.lastEv = e.id; this.h.event?.(e); }
        break;
      }
      case 'results':
        this.results = m;
        this.scores = m.scores;
        this.h.results?.(m);
        break;
      case 'emote':
        this.h.emote?.(m.slot, m.id);
        break;
    }
  }

  // ---- rendering helper ----
  /** Latest world for display: interpolated others + predicted local player. */
  renderWorld(now: number): RenderWorld | null {
    const snaps = this.snaps;
    if (!snaps.length) return null;
    const last = snaps[snaps.length - 1];
    if (last.w.finished) return last.w;
    let world: RenderWorld = last.w;
    if (this.phase === 'play' && snaps.length > 1) {
      const rt = Math.min(last.tick, last.tick + (now - last.at) / 1000 / DT - INTERP_TICKS);
      let i = snaps.length - 1;
      while (i > 0 && snaps[i - 1].tick > rt) i--;
      const b = snaps[i], a = snaps[Math.max(0, i - 1)];
      const t = b.tick === a.tick ? 1 : Math.min(1, Math.max(0, (rt - a.tick) / (b.tick - a.tick)));
      const base = t < 1 ? a.w : b.w;
      let data = base.data;
      if (this.round?.gameId === 'pushOff' && t < 1 && a.w.data.camera && b.w.data.camera) {
        const camera = a.w.data.camera.map((axis: number, j: number) => lerp(axis, b.w.data.camera[j], t));
        data = { ...data, camera };
      }
      if (this.round?.gameId === 'ballDefence' && t < 1) {
        const from = a.w.data as BallistixData, to = b.w.data as BallistixData;
        const balls = from.balls.map(ball => {
          const end = to.balls.find(other => other.id === ball.id);
          if (ball.pitch === undefined || end?.pitch === undefined) return ball;
          return { ...ball, pitch: lerp(ball.pitch, end.pitch, t), yaw: lerp(ball.yaw ?? 0, end.yaw ?? 0, t) };
        });
        data = { ...data, balls };
      }
      const next = new Map<number, Body>(b.w.bodies.map(body => [body.id, body]));
      world = {
        ...base, data, time: lerp(a.w.time, b.w.time, t),
        bodies: base.bodies.map(aa => {
          const bb = next.get(aa.id);
          if (!bb || t >= 1) return aa;
          return { ...aa, x: lerp(aa.x, bb.x, t), y: lerp(aa.y, bb.y, t), z: lerp(aa.z, bb.z, t), face: lerpAngle(aa.face, bb.face, t) };
        }),
      };
      if (this.round?.gameId === 'ballDefence' && t < 1 && (data.variant === 'crashball' || data.variant === 'nballism')) {
        const elapsed = Math.floor(t * (b.tick - a.tick) + 1e-7);
        const ahead = b.tick - a.tick - elapsed;
        const future = b.w.data as BallistixData;
        const lights = ahead < 8 && future.bumperFrames !== undefined
          ? (future.bumperFrames >>> (4 * ahead)) & 15
          : (data.bumperFrames ?? (data.post ? 1 << data.post.i : 0)) & 15;
        const cool = data.cool.map((timer: number, i: number) => {
          const next = future.cool[i];
          return next > 0 && next + ahead <= 31 ? next + ahead : Math.max(0, timer - elapsed);
        });
        const flashes = ahead <= 8 ? future.flashes : data.flashes;
        const tick = data.f + elapsed;
        const markers: NonNullable<RenderWorld['ballistixMarkers']> = { lights, cool, tick, flashes };
        world.ballistixMarkers = markers;
        if (data.variant === 'nballism') {
          const rise = future.mach?.rise;
          if (rise && rise.tick > data.f && rise.tick <= tick)
            world.data = { ...data, mach: { ...data.mach, rise } };
          markers.shields = future.pl.map((p, i) => {
            const before = data.pl[i].shield;
            if (p.shield > 0 && p.shield + ahead <= 241) return p.shield + ahead;
            return Math.max(0, before - elapsed);
          });
        }
      }
    }
    const pw = this.predictor?.pred;
    if (this.phase === 'play' && pw && this.roundSlot != null) {
      const mine = pw.bodies.find((b) => (b.kind === 'player' || b.kind === 'tank') && b.slot === this.roundSlot);
      if (mine) {
        const slot = this.roundSlot, game = this.round?.gameId;
        const carried = (b: Body) => game === 'dragonDrop' ? b.kind === 'jewel' && b.cd === slot
          : game === 'crateToss' && ['crate', 'tnt', 'nitro', 'chest'].includes(b.kind) && b.cd === slot + 1;
        const local = new Map(pw.bodies.filter(b => b.id === mine.id || carried(b)).map(b => [b.id, b]));
        world = { ...world, predicted: pw, bodies: world.bodies.map(b =>
          local.get(b.id) ?? (carried(b) ? pw.bodies.find(p => p.id === b.id) : undefined) ?? b) };
      }
    }
    return world;
  }
}

export { sanitizeLook };
