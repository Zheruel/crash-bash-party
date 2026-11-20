import { BD_U, ballistixFloor, stepBallistixResultArena, type BallistixData } from '../../shared/games/ballDefence';
import { cloneWorld } from '../../shared/sim';
import type { Body, GameEvent, World } from '../../shared/types';
import { playerPose } from './playerPose';
import { FitCam, type PS1Cam } from './ps1cam';

const END_TRACK = { xl: 256, xr: 256, zn: 0, zf: 0, h: 960 };
const FACE = [0x800, 0, 0x400, 0xc00];
const FRAME_LIMIT = 330;

export function ballistixResultEntry(w: World, slot: number): number | undefined {
  const d = w.data as BallistixData;
  const winner = d.pl[slot];
  if (winner.st === 0x22) return winner.stateAt;
  const losers = d.pl.filter((_, p) => p !== slot);
  if (d.variant !== 'beach' && winner.score > 0 && losers.every(p => p.score <= 0 && p.st >= 0x24)) {
    // The host spends the final knockout ticking the losing ships. Its surviving
    // ship and arena objects are still at the verdict when the terminal snapshot arrives.
    return Math.max(...losers.map(p => p.stateAt)) + 1;
  }
  if (w.finished) return d.f;
}

/** The native cup tally first becomes visible three frames after the cheer. */
export function ballistixCupDelay(terminal: World, slot: number, cheerFrame: number) {
  const entry = ballistixResultEntry(terminal, slot) ?? terminal.data.f;
  return Math.max(0, entry + cheerFrame + 3 - terminal.data.f) * 1000 / 30;
}

function easeAngle(angle: number, target: number) {
  const delta = (target - angle) & 0xfff;
  return angle + ((delta > 0x800 ? delta - 0x1000 : delta) >> 2);
}

export class BallistixResult {
  private readonly discBeach: boolean;
  private readonly initial: BallistixData['pl'][number];
  private readonly fit: FitCam;
  private readonly arrival: number;
  private readonly axis: 'x' | 'z';
  private readonly sign: number;
  private readonly sky: boolean;
  private terminalAt?: number;
  private arena?: World;
  age = -1;
  audioAge = -1;

  constructor(source: World, readonly slot: number, readonly entry: number, camera: PS1Cam, readonly arrivedLate: boolean) {
    const d = source.data as BallistixData;
    this.initial = { ...d.pl[slot] };
    this.discBeach = d.variant === 'beach' && this.initial.st === 0x22;
    this.sky = d.variant === 'sky';
    this.fit = new FitCam(camera);
    this.axis = slot < 2 ? 'z' : 'x';
    this.sign = slot === 0 || slot === 3 ? -1 : 1;
    // All four Beach boats start their victory run at the fixed goal line.
    const start = this.discBeach ? 2176 : this.sign * this.initial[this.axis];
    this.arrival = Math.max(0, Math.ceil((start - 0x500) / 0x20));
    if (!this.discBeach) {
      this.arena = cloneWorld(source);
      const capped = source.finished && entry === d.f;
      this.arena.data.f = capped ? entry : entry - 2;
    }
  }

  advance(source: World, now: number, replayAt: number | undefined, onEvent: (e: GameEvent) => void) {
    if (source.finished && this.terminalAt === undefined) {
      this.terminalAt = replayAt ?? now;
      if (this.discBeach) this.arena = cloneWorld(source);
    }
    const d = source.data as BallistixData;
    const elapsed = this.terminalAt === undefined ? 0 : Math.max(0, Math.floor((now - this.terminalAt) * 30 + 1e-7));
    const target = Math.min(FRAME_LIMIT, d.f - this.entry + elapsed);
    const previous = this.age;
    this.age = Math.max(previous, target);
    if (this.arena) {
      while (this.arena.data.f < this.entry + this.age) {
        const frame = this.arena.data.f + 1 - this.entry;
        const arenaData = this.arena.data as BallistixData;
        const winner = !this.discBeach && frame >= 0 ? this.winnerMotion(arenaData, frame) : undefined;
        const events = stepBallistixResultArena(this.arena, frame + 1, winner);
        if (!this.discBeach && frame > this.arrival) this.fitCamera(arenaData, frame, 1);
        // Discard old one-shots when a terminal snapshot is first seen or rendering resumes.
        if ((!this.arrivedLate || this.audioAge >= 0) && this.arena.data.f >= this.entry + this.age - 1) events.forEach(onEvent);
      }
    }
    if (this.discBeach && this.age > this.arrival) {
      this.fitCamera((this.arena?.data ?? d) as BallistixData, this.age, this.age - Math.max(this.arrival, previous));
    }
    return this.arena;
  }

  private winnerMotion(data: BallistixData, age: number) {
    const player = data.pl[this.slot];
    const position = this.discBeach ? player : this.initial;
    let { x, z } = position;
    let face = this.discBeach ? FACE[this.slot] : this.initial.face;
    let roll = this.discBeach ? player.roll : this.initial.roll ?? 0;
    let vel = this.discBeach ? 0 : this.initial.vel;
    let slide = 0;
    for (let f = 0; f <= Math.min(age, 32); f++) {
      if (f > 0) face = easeAngle(face, 0);
      if (this.discBeach) continue;
      vel = Math.sign(vel) * Math.max(0, Math.abs(vel) - (this.sky ? 6 : 18));
      const signedVel = (this.slot === 0 || this.slot === 2) ? -vel : vel;
      if (this.sky) face += signedVel;
      else slide += vel;
      roll = easeAngle(roll, signedVel);
    }
    const inward = this.discBeach ? 0 : this.sign * Math.min(age, this.arrival) * 0x20;
    x += this.axis === 'x' ? -inward : slide;
    z += this.axis === 'z' ? -inward : slide;
    return { slot: this.slot, x, y: ballistixFloor(data.tilt, x, z) - 128, z, face: face & 4095, roll, vel };
  }

  winnerBody(body: Body, data: BallistixData) {
    const player = data.pl[this.slot];
    const age = Math.max(0, this.age);
    const { x, y, z, face, roll } = this.winnerMotion(data, age);
    return {
      body: { ...body, x: x / BD_U, z: -z / BD_U, face: -face * Math.PI / 2048, vx: 0, vz: 0 },
      roll,
      y,
      pose: age > 0 ? playerPose(0x1f, player.character, age) : undefined,
    };
  }

  get camera(): PS1Cam { return this.fit.c; }

  private fitCamera(data: BallistixData, age: number, frames: number) {
    const { x, y, z } = this.winnerMotion(data, age);
    const boxes = [{ ...END_TRACK, x, y, z }];
    data.pl.forEach((p, slot) => {
      // A surviving seat at an externally capped round stays in the seated pose.
      if (slot !== this.slot && p.score > 0) boxes.push({ ...END_TRACK, x: p.x, y: ballistixFloor(data.tilt, p.x, p.z) - 128, z: p.z });
    });
    for (let f = 0; f < frames; f++) this.fit.update(boxes);
  }
}
