import { atan2g } from '../ps1Angle';
import { ps1SqrtQ6 } from '../ps1Sqrt';
export { atan2g } from '../ps1Angle';
import { DISC_CHARACTER } from '../look';
import { addBody, emit, rand } from '../physics';
import { type GameEvent, type InputState, type MiniGame, type SlotInfo, type World } from '../types';
import { MM_SCRIPTS } from './malletMashData';
import { tickPlayerTally, VERSUS_CLOCK_END } from './common';

/**
 * MALLET MASH (Crash Bash level 29, family 0x10e), ported from the PS1 code (overlay 0x800b33a4.., see re/notes/malletMash.md).
 *
 * Everything runs in the game's own integer units at its 30 Hz logic rate (1 sim tick = 1 logic frame). Game units -> sim world
 * units: world = game / 301.4 (1024 game units = 1 model unit x 3.398 arena scale); the game's +z is the screen-up direction, so
 * world.z = -game.z. Angles are 0..0xfff, 0 = +z, clockwise (atan2(dx, dz)); sin/cos table and atan2 are replicas of the exe ones.
 *
 * The sim starts at the end of the real game's 99-frame intro (mushrooms / crates already ran their intro timers, pre-simulated in
 * setup); the clock starts 27 frames later and ends after 2671 clock steps (2672 clock calls: 1:30 on the display, 0:00 at the end).
 *
 * world.data (MMData): p[4] players, mu[10] mushroom slots, cr[3] crate slots, spawner counters, clock.
 * Bodies: 'player' per slot, x/z mirror the game position (for the shared view helpers).
 * Events: 'rise' (mushroom pops up, v 1 = gold), 'smash' (s, v points, o 1 = gold), 'swing' (s: windup sound), 'strike' (s: swing
 *   sound at event 0xc), 'hit' (s: mallet lands), 'wave' (s, v radius world units, o 1 = power wave), 'stun' (s victim, o attacker or -1),
 *   'boom' (mushroom explodes), 'cbreak' (crate smashed by s), 'crate' (s got power-up: v 0 boots / 1 shock power), 'pop' (v 1 = gold pop), 'end'.
 */

// ---------------------------------------------------------------- constants
/** game units per world unit */
export const MM_S = 301.4;
export const mmX = (x: number) => x / MM_S;
export const mmZ = (z: number) => -z / MM_S;
export const mmFace = (yaw: number) => Math.PI - (((yaw - 0x800) & 0xfff) * 2 * Math.PI) / 4096;
/** players are clamped to this radius minus their collision radius */
export const MM_ARENA = 0x980;
export const MM_SPAWN = 0x880;
export const MM_R = MM_ARENA / MM_S;
export const MM_SLOTS = 10;

const INTRO_END = 99; // frame the intro flag (0x4000000) clears: input / AI / mushroom timers start
const CLOCK_START = 126; // first clock step
const CLOCK_STEPS = 2672; // clock calls until the end check sees 0:00 (display 1:30 -> 0:00, BCD -2 per frame, checked before the decrement)
/** sim frame (counted from INTRO_END) the round ends on */
export const MM_END = CLOCK_START + CLOCK_STEPS - 1 - INTRO_END;
export const MM_MAX_TIME = (MM_END + 1) / 30;

const START: [number, number, number][] = [[-1485, -1485, 3584], [-1618, 1539, 512], [1572, 1606, 1536], [1467, -1509, 2560]];
/** engine character id (1..8) per look.ts CHARACTERS index: crash coco tiny dingodile cortex brio koala rilla big-stein (Cortex) */
export const MM_CHAR = DISC_CHARACTER;
/** Part 0 body cylinder 0x40 in the eight mallet models (0848–0862). */
const RADIUS = [0, 219, 199, 210, 184, 328, 312, 259, 333];
/** Shape 0x40 radius of a mushroom (pack 0343 part 1) and a crate (part 14), L29 RAM. */
const MUSH_R = 181;
const CRATE_R = 128;
/** FUN_800b7b48: probe radius of the moving player against a solid object (object flag 0x200) */
const PROBE_R = 0x78;
/** Tag 1 on the strike pose, event 8 of character script 0x37. */
const MALLET_HEAD = [[0, 0], [-119, -338], [-16, -439], [65, -419], [72, -465],
  [0, -832], [0, -819], [-187, -691], [-213, -775]];
/** swing reach per engine char (table 0x800b9580) */
const REACH = [4096, 512, 512, 544, 544, 800, 800, 768, 768];
const STAGE_SECS = [15, 15, 13, 10, 10];
const CAPS = [6, 5, 5, 4, 3];
const GOLD_T = [600, 600, 600, 450, 300];
const WAIT0 = [80, 80, 70, 70, 60];
const WAITR = [60, 50, 40, 45, 40];
const BOT_SKILL = [22, 25, 30]; // versus table 0x800b92c4
const WIN_NAME_WAIT = [0, 24, 23, 26, 23, 23, 23, 26, 26]; // FUN_8008a200
/** pad bits for the 8 AI directions (table 0x80051244) */
const DIRBITS = [16, 48, 32, 96, 64, 192, 128, 144];
/** controller heading per d-pad combination (measured) */
const HEADING: Record<number, number> = { 0x10: 2048, 0x30: 2557, 0x20: 3072, 0x60: 3584, 0x40: 4096, 0xc0: 4611, 0x80: 5120, 0x90: 5632 };

// ---------------------------------------------------------------- exe math replicas
const COS = new Int16Array(4096);
for (let i = 0; i < 4096; i++) COS[i] = Math.round(4096 * Math.cos((i * 2 * Math.PI) / 4096));
const T = (i: number) => COS[i & 0xfff];
/** FUN_800154a0: signed shortest turn from a to b */
const angDiff = (a: number, b: number) => { const v = (b - a) & 0xfff; return v > 0x800 ? v - 0x1000 : v; };
/** FUN_80015480: unsigned angle difference */
const angAbs = (a: number, b: number) => { const v = (b - a) & 0xfff; return v > 0x800 ? 0x1000 - v : v; };
/** FUN_800b62c8 squared distance through the FUN_80032490 square root (Q6) */
const dist = (ax: number, az: number, bx: number, bz: number) => ps1SqrtQ6((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) >> 6;

// ---------------------------------------------------------------- data
export interface AnimSt { id: number; pc: number; c: number; h: number; l: number; d: number; pose: number }
export interface MMAi { mode: number; tk: number; ti: number; tx: number; tz: number; cd: number; pad: number }
export interface MMPlayer {
  ch: number; bot: boolean; x: number; z: number; yaw: number;
  hd: number; spd: number; kn: number; knh: number; mv: number;
  sc: number; st: number; prev: number; fl: number; score: number; lock: number; blink: number; stun: number; hits: number; hid: boolean;
  /** power-up: 0 speedy boots, 1 shock power, 3 none; pwT = boots frames left */
  pw: number; pwT: number;
  /** locked swing target: kind 0 none / 1 mushroom / 2 crate, slot */
  tk: number; ti: number; chg: number;
  /** pending hit request (set by a shock wave, applied in this player's own turn) */
  req: boolean;
  pad: number; an: AnimSt; ai: MMAi;
}
/** up: the model stands on the floor (y = floor) instead of 0x2000 below it, so it is solid to players */
export interface MMMush { st: number; c: number; x: number; z: number; ys: number; gold: boolean; bd: number; id: number; up?: boolean }
export interface MMCrate { st: number; c: number; x: number; z: number; s: number; bd: number; yaw: number }
export interface MMData {
  g: number; // frames since the real init (intro included)
  p: MMPlayer[];
  mu: (MMMush | null)[];
  cr: (MMCrate | null)[];
  n: number; stage: number; stageT: number; spawnCd: number; goldT: number; golds: number; nc: number; nextId: number;
  skill: number; clock: number; over: boolean; winner: number; seats: number;
  shown?: number[];
}

const rn = (w: World, n: number) => (n < 2 ? 0 : Math.floor(rand(w) * n));
const scriptOf = (P: MMPlayer) => MM_SCRIPTS[P.ch][P.an.id - 0x33];

// ---------------------------------------------------------------- animation script interpreter (FUN_8008502c / FUN_800854c0)
export function animStart(P: MMPlayer, id: number): number {
  const S = MM_SCRIPTS[P.ch][id - 0x33];
  P.an = { id, pc: 0, c: -1, h: 0, l: 0, d: S[0], pose: P.an?.pose ?? 0 };
  return animStep(P);
}
export function animStep(P: MMPlayer, onState?: (st: number) => void): number {
  const a = P.an, S = scriptOf(P);
  a.c--;
  let ret = 0;
  if (a.c >= 0) return ret;
  let v = 0;
  for (let guard = 0; guard < 64; guard++) {
    if (a.h !== 0 && a.l !== 0) { v = a.l + 1; a.h--; break; }
    a.pc++;
    v = S[a.pc];
    if (!(v & 0x8000)) break;
    if (v === 0x8000) { a.pc++; a.pc = S[a.pc]; if (ret === 0) ret = 2; }
    else if (v === 0x8003) { a.pc++; ret = S[a.pc]; }
    else if (v === 0x8004) { a.pc++; onState?.(S[a.pc]); return ret; }
    else if (v === 0x8007) { a.pc++; a.l = 0; a.h = S[a.pc] - 1; }
  }
  a.pose = v; a.l = v; a.c = a.d;
  return ret;
}
/** [clip, frame] of the current pose (clip = gltf animation index, 30 fps = one logic frame per key) */
export const mmPose = (an: AnimSt): [number, number] => [(an.pose - 0x4000) >> 7, an.pose & 0x7f];

/** All eight L29 idle scripts loop a consecutive run of render words from opcode 0x8007. */
export function mmOpeningPose(character: number, ticksLeft: number): [number, number] {
  const [, , length, first] = MM_SCRIPTS[character][0];
  const age = Math.max(0, INTRO_END - ticksLeft);
  return [(first - 0x4000) >> 7, (first & 127) + age % length];
}

// ---------------------------------------------------------------- helpers
const intro = (d: MMData) => d.g < INTRO_END;

function clampTo(o: { x: number; z: number }, R: number) {
  if (R * R <= o.x * o.x + o.z * o.z) {
    const a = atan2g(o.x, o.z);
    o.x = (R * T(a - 0x400)) >> 12;
    o.z = (R * T(a)) >> 12;
  }
}

/** FUN_800b3d28: random free spot for a mushroom / crate */
function findSpot(w: World, d: MMData): [number, number] | null {
  for (let it = 0; it < 10; it++) {
    const x = rn(w, 0x1000) - 0x800, z = rn(w, 0x1000) - 0x800;
    let ok = true;
    for (const P of d.p) if (dist(P.x, P.z, x, z) < 0x400) ok = false;
    if (ok && d.n !== 0) for (const m of d.mu) if (m && dist(m.x, m.z, x, z) < 0x400) ok = false;
    if (ok && d.nc !== 0) for (const c of d.cr) if (c && dist(c.x, c.z, x, z) < 0x300) ok = false;
    if (ok) return [x, z];
  }
  return null;
}

/** FUN_800b4454: nearest eligible target. flags: 0x100 mushrooms, 0x200 crates, 2 reach, 4 facing, 1 bot filter */
function findTarget(d: MMData, P: MMPlayer, flags: number): { k: number; i: number } | null {
  let best = (flags & 2) ? REACH[P.ch] : 0xffffff;
  let out: { k: number; i: number } | null = null;
  const consider = (k: number, i: number, st: number, x: number, z: number, bd: number) => {
    if ((flags & 1) && !(st > 8 && bd === 0)) return;
    if (st <= 10) return;
    const dd = dist(P.x, P.z, x, z);
    if (dd < best) {
      if (flags & 4) { if (angAbs(atan2g(P.x - x, P.z - z), P.hd) > 799) return; }
      best = dd; out = { k, i };
    }
  };
  if (flags & 0x100) d.mu.forEach((m, i) => { if (m) consider(1, i, m.st, m.x, m.z, m.bd); });
  if (flags & 0x200) d.cr.forEach((c, i) => { if (c) consider(2, i, c.st, c.x, c.z, c.bd); });
  return out;
}

// ---------------------------------------------------------------- scoring / hits
function addScore(d: MMData, s: number, v: number) { d.p[s].score += v; }

/** FUN_800b47c8: owner s hits mushroom i */
function hitMushroom(w: World, d: MMData, s: number, i: number) {
  const m = d.mu[i];
  if (!m) return;
  const v = m.st === 0xd ? (m.gold ? 15 : 3) : m.st === 0xe ? (m.gold ? 20 : 5) : m.gold ? 10 : 2;
  if (s >= 0) { addScore(d, s, v); emit(w, 'smash', mmX(m.x), mmZ(m.z), s, v, m.gold ? 1 : 0); }
  m.st = 4;
}

/** FUN_800b6cd8 (drops the old power-up through FUN_800b8ef8 first) */
function setPower(w: World, d: MMData, s: number, type: number) {
  const P = d.p[s];
  P.pw = 3;
  if (type === 0) P.pwT = 180;
  P.pw = type;
  emit(w, 'crate', mmX(P.x), mmZ(P.z), s, type);
}

/** FUN_800b4910: shock wave at (cx,cz), radius r, owner s (-1 none), flags&0x100: smashes mushrooms for the owner */
function shock(w: World, d: MMData, cx: number, cz: number, r: number, s: number, flags: number) {
  if (d.over) return;
  d.p.forEach((V, i) => {
    if (i === s) return;
    if (dist(cx, cz, V.x, V.z) <= r && V.blink === 0 && V.stun === 0) {
      const a = atan2g(cx - V.x, cz - V.z);
      V.knh = a; V.kn = 0x50;
      V.req = true; V.hits = 0x14;
      // power-ups are lost on a hit (FUN_800b8ef8)
      V.pw = 3;
      // one of the victim's four hit voices (0x8009e080 + char * 8)
      emit(w, 'stun', mmX(V.x), mmZ(V.z), i, rn(w, 4), s);
    }
  });
  if (flags & 0x100) d.mu.forEach((m, i) => { if (m && m.st > 10 && dist(cx, cz, m.x, m.z) <= r) hitMushroom(w, d, s, i); });
}

// ---------------------------------------------------------------- player states
function enter(w: World, d: MMData, i: number, st: number) {
  const P = d.p[i];
  P.prev = P.st; P.st = st;
  switch (st) {
    case 0x40: P.mv = 1; animStart(P, 0x33); break; // FUN_800b72fc
    case 0x41: P.mv = 1; animStart(P, 0x34); break; // FUN_800b8d3c
    case 0x42: P.mv = 0; animStart(P, 0x38); P.stun = 0x1e; break; // FUN_800b8cb4
    case 0x43: P.tk = 0; P.lock = 10; emit(w, 'swing', mmX(P.x), mmZ(P.z), i, 1); animStart(P, 0x35); break; // FUN_800b8ba0
    case 0x44: animStart(P, 0x36); P.lock = 10; P.chg = 0; break; // FUN_800b8b3c
    case 0x45: P.lock = 10; animStart(P, 0x37); break; // FUN_800b8af4
    case 0x46: P.lock = 10; break;
    case 0x47: P.pw = 3; animStart(P, 0x39); P.mv = 0; P.lock = 2; break; // FUN_800b8918
    case 0x48: P.pw = 3; P.mv = 0; P.lock = 2; animStart(P, 0x33); break; // FUN_800b876c
  }
}

function headPos(P: MMPlayer): [number, number] {
  const [x, z] = MALLET_HEAD[P.ch];
  const sin = T(P.yaw - 0x400), cos = T(P.yaw);
  return [P.x + ((x*cos + z*sin) >> 12), P.z + ((z*cos - x*sin) >> 12)];
}

/** FUN_800b6efc */
function waveAt(w: World, d: MMData, i: number) {
  const P = d.p[i];
  const [cx, cz] = headPos(P);
  if (P.pw === 1) {
    emit(w, 'wave', mmX(cx), mmZ(cz), i, 0x600 / MM_S, 1);
    shock(w, d, cx, cz, 0x600, i, 0x100);
    P.pw = 3;
  } else {
    emit(w, 'wave', mmX(cx), mmZ(cz), i, 0x380 / MM_S, 0);
    shock(w, d, cx, cz, 0x380, i, 0);
  }
}

/** FUN_800b8714 (draw, full only) / FUN_800b8814 (lose) / FUN_800b89d8 (win); FUN_8008abf8 in idle and run */
function endFlags(w: World, d: MMData, i: number, full: boolean): boolean {
  const P = d.p[i];
  if (full && (P.fl & 0x100)) { enter(w, d, i, 0x40); return true; }
  if (P.fl & 0x400) { enter(w, d, i, 0x48); return true; }
  if (P.fl & 0x200) { enter(w, d, i, 0x47); return true; }
  return false;
}

/** FUN_800b7b48: circle push of the moving player out of the others and out of the mushrooms and crates */
function collide(w: World, d: MMData, i: number) {
  const P = d.p[i];
  const rp = RADIUS[P.ch];
  d.p.forEach((Q, j) => {
    if (j === i || (Q.fl & 0xf800)) return;
    const take = P.spd !== 0 ? true : Q.spd === 0;
    if (!take) return;
    const r = rp + RADIUS[Q.ch];
    const dx = Q.x - P.x, dz = Q.z - P.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      const dd = ps1SqrtQ6(d2) >> 6;
      if (dd < r) {
        const a = atan2g(dx, dz);
        const o = r - dd + 1;
        P.x -= (o * T(a - 0x400)) >> 12;
        P.z -= (o * T(a)) >> 12;
      }
    }
  });
  // Solid objects (flag 0x200) in object-list order, newest first: the mushrooms, then the two crates made at init.
  const push = (x: number, z: number, rad: number) => {
    const r = rad + PROBE_R;
    const dx = x - P.x, dz = z - P.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    const dd = ps1SqrtQ6(d2) >> 6;
    if (dd >= r) return;
    let a = atan2g(dx, dz) & 0xfff;
    if ((a & 0xff) === 0) a = a - 8 + rn(w, 0x10);
    if (P.spd === 0) return;
    const o = r - dd + 1;
    P.x -= (o * T(a - 0x400)) >> 12;
    P.z -= (o * T(a)) >> 12;
  };
  const mush = d.mu.filter((m): m is MMMush => !!m?.up).sort((a, b) => b.id - a.id);
  for (const m of mush) push(m.x, m.z, MUSH_R);
  for (let k = d.cr.length - 1; k >= 0; k--) {
    const c = d.cr[k];
    if (c && (c.st === 10 || c.st === 0xc || c.st === 4 || c.st === 6)) push(c.x, c.z, CRATE_R);
  }
}

function stateUpdate(w: World, d: MMData, i: number) {
  const P = d.p[i];
  const onState = (st: number) => enter(w, d, i, st);
  switch (P.st) {
    case 0x40: { // idle, FUN_800b738c (Square: FUN_800b8e64, moving: FUN_800b8d88)
      if (endFlags(w, d, i, false)) return;
      if (P.pad & 0x8000) { enter(w, d, i, 0x43); return; }
      if (P.spd !== 0) { enter(w, d, i, 0x41); return; }
      animStep(P, onState);
      if (P.fl & 0x100) P.hd = 0;
      return;
    }
    case 0x41: { // run, FUN_800b747c (stopped: FUN_800b8e08)
      if (endFlags(w, d, i, false)) return;
      if (P.pad & 0x8000) { enter(w, d, i, 0x43); return; }
      if (P.spd === 0) { enter(w, d, i, 0x40); return; }
      P.mv = 1;
      collide(w, d, i);
      const marker = animStep(P, onState);
      if (marker === 8 || marker === 9) emit(w, 'footstep', mmX(P.x), mmZ(P.z), i, marker + 2);
      return;
    }
    case 0x42: { // stunned, FUN_800b8c3c
      if (P.kn !== 0) collide(w, d, i);
      animStep(P, onState);
      return;
    }
    case 0x43: { // windup, FUN_800b76cc (hold pose, turns to the locked target)
      if (endFlags(w, d, i, true)) return;
      P.lock = 10;
      const t = findTarget(d, P, 0x306);
      if (t) {
        P.tk = t.k; P.ti = t.i;
        const o = t.k === 1 ? d.mu[t.i]! : d.cr[t.i]!;
        P.hd = atan2g(P.x - o.x, P.z - o.z);
      }
      if (animStep(P, onState) === 8) enter(w, d, i, P.pad & 0x8000 ? 0x44 : 0x45);
      return;
    }
    case 0x44: { // charge, FUN_800b77fc
      if (endFlags(w, d, i, true)) return;
      P.lock = 10;
      if (P.chg === 0) { if (animStep(P, onState) === 8) P.chg = 1; if (P.chg === 0) return; }
      if (!(P.pad & 0x8000)) { enter(w, d, i, 0x45); P.chg = 0; }
      return;
    }
    case 0x45: { // swing, FUN_800b7908
      if (endFlags(w, d, i, true)) return;
      P.lock = 10;
      const ev = animStep(P, onState);
      if (ev === 0xc) emit(w, 'strike', mmX(P.x), mmZ(P.z), i, 1);
      if (ev === 8) {
        if (P.prev === 0x44 || P.pw === 1) waveAt(w, d, i);
        if (P.tk === 1) { const m = d.mu[P.ti]; if (m && m.st > 10) hitMushroom(w, d, i, P.ti); }
        else if (P.tk === 2) { const c = d.cr[P.ti]; if (c && c.st > 10) hitCrate(w, d, i, P.ti); }
        emit(w, 'hit', mmX(P.x), mmZ(P.z), i, 1, -1);
        enter(w, d, i, 0x46);
      }
      return;
    }
    case 0x46: { // recovery, FUN_800b8a30
      if (endFlags(w, d, i, true)) return;
      P.lock = 10;
      if (animStep(P, onState) === 9) { enter(w, d, i, 0x40); P.lock = 0; }
      return;
    }
    case 0x47: { // winner, FUN_800b886c
      P.lock = 2;
      P.hd = 0;
      animStep(P, onState);
      P.yaw = (P.yaw + (angDiff(P.yaw, 0) >> 2)) & 0xfff;
      return;
    }
    case 0x48: { // loser shrinks away, FUN_800b8550
      if (P.sc > 0) {
        P.sc = Math.max(0, P.sc - 0x80);
        if (P.sc === 0) emit(w, 'resultBurst', mmX(P.x), mmZ(P.z), i);
      }
      P.lock = 2;
      animStep(P, onState);
      return;
    }
  }
}

/** FUN_800b64b4 */
function hitCrate(w: World, d: MMData, s: number, i: number) {
  const c = d.cr[i];
  if (!c) return;
  setPower(w, d, s, rn(w, 2));
  c.st = 4;
  // FUN_800b64b4: one of 0x3f5-0x3f8 at random
  emit(w, 'cbreak', mmX(c.x), mmZ(c.z), s, rn(w, 4));
}

// ---------------------------------------------------------------- AI (FUN_800b5ba0)
function aiPad(w: World, d: MMData, i: number): number {
  const P = d.p[i], A = P.ai;
  if (intro(d)) return 0;
  if (A.cd !== 0) A.cd--;
  let bits = 0;
  const t = findTarget(d, P, 0x301);
  if (!t) {
    let sx = 0, sz = 0;
    d.p.forEach((Q, j) => { if (j !== i && dist(P.x, P.z, Q.x, Q.z) < 0x1000) { sx += P.x - Q.x; sz += P.z - Q.z; } });
    if (sx !== 0 || sz !== 0) { const a = atan2g(sx, sz); A.mode = 1; bits |= DIRBITS[(a >> 9) & 7]; }
  } else {
    const o = t.k === 1 ? d.mu[t.i]! : d.cr[t.i]!;
    if (!(A.tk === t.k && A.ti === t.i) && A.cd === 0) {
      A.tk = t.k; A.ti = t.i; A.tx = o.x; A.tz = o.z; A.cd = 10;
      const odd = d.g & 1;
      if (t.k === 1) A.mode = P.pw === 1 ? 2 : odd ? 2 : 3;
      else A.mode = P.pw === 1 ? 4 : odd ? 4 : 5;
    }
  }
  const tgt = A.tk === 1 ? d.mu[A.ti] : A.tk === 2 ? d.cr[A.ti] : null;
  if (A.mode >= 2 && A.mode <= 5 && tgt) {
    if (dist(P.x, P.z, tgt.x, tgt.z) < REACH[P.ch]) {
      const hold = A.mode === 3 || A.mode === 5;
      if (hold) { if (P.st !== 0x44) bits |= 0x8000; }
      else if (P.st !== 0x43) bits |= 0x8000;
    }
    bits |= DIRBITS[(atan2g(tgt.x - P.x, tgt.z - P.z) >> 9) & 7];
  }
  void w;
  return bits;
}

// ---------------------------------------------------------------- one logic frame
function playerFrame(w: World, d: MMData, i: number, inp: InputState | null | undefined) {
  const P = d.p[i];
  // held buttons this frame: a human's input, or what the AI wrote last frame
  let pad = 0;
  if (P.bot) pad = P.ai.pad;
  else if (inp) {
    if (inp.y < -0.5) pad |= 0x10;
    if (inp.y > 0.5) pad |= 0x40;
    if (inp.x < -0.5) pad |= 0x80;
    if (inp.x > 0.5) pad |= 0x20;
    if (inp.a) pad |= 0x8000;
  }
  // hit request / stun / blink bookkeeping (FUN_80083e8c)
  if (!(P.fl & 0xff00)) {
    if (P.req) {
      if (P.blink === 0 && P.stun === 0) { enter(w, d, i, 0x42); P.blink = 0; }
      P.req = false;
    }
    if (P.stun !== 0) {
      P.stun--;
      if (P.stun === 0 && P.hits > 0) P.blink = 0x28;
      pad = 0;
    }
  }
  if (P.lock !== 0) P.lock--;
  if (P.blink !== 0) { P.blink--; P.hid = P.blink % 3 === 0; } else P.hid = false;
  if (P.bot) P.ai.pad = aiPad(w, d, i);
  if (intro(d)) pad = 0;
  P.pad = pad;
  // input -> control (FUN_800b717c)
  P.spd = 0;
  const bits = (P.lock !== 0 ? pad & 0x8000 : pad) & 0xf0;
  if (bits !== 0) {
    const hd = HEADING[bits];
    if (hd !== undefined) P.hd = hd;
    if (P.mv !== 0) {
      if (P.pw === 0) P.spd = P.bot ? botBoots(d.skill) : 0x50;
      else P.spd = P.bot ? botSpeed(d.skill) : 0x2d;
    }
  }
  stateUpdate(w, d, i);
  // physics (FUN_80085d2c): turn, move, knock-back
  // FUN_800b70c4
  if (P.lock === 0 || P.st === 0x43) P.yaw = (P.yaw + (angDiff(P.yaw, P.hd) >> 2)) & 0xfff;
  movePlayer(P);
}

function movePlayer(P: MMPlayer) {
  P.x -= (P.spd * T(P.hd - 0x400)) >> 12;
  P.z -= (P.spd * T(P.hd)) >> 12;
  if (P.kn !== 0) {
    P.x -= (P.kn * T(P.knh - 0x400)) >> 12;
    P.z -= (P.kn * T(P.knh)) >> 12;
    P.kn -= 4;
    if (P.kn < 0) P.kn = 0;
  }
  clampTo(P, MM_ARENA - RADIUS[P.ch]); // FUN_800b9054
  // power-up timer (FUN_800b6e1c)
  if (P.pw === 0) { P.pwT--; if (P.pwT < 1) P.pw = 3; }
}

/** FUN_800b3668 (mushroom object update; spawned by FUN_800b66c8, init FUN_800b65f0, spot clamp FUN_800b8f64) */
function mushFrame(w: World, d: MMData, idx: number, freezeWaiting: boolean) {
  const m = d.mu[idx];
  if (!m) return;
  switch (m.st) {
    case 0: {
      const sp = findSpot(w, d);
      if (!sp) break;
      m.bd = 1000;
      m.x = sp[0]; m.z = sp[1];
      m.up = false;
      clampTo(m, MM_SPAWN);
      m.st = 2;
      if (m.c === 0) { m.bd = 0; m.bd = botDelay(d.skill); m.c = rn(w, 20) + 10; } else m.bd = 0;
      if (d.goldT === 0) { m.gold = true; d.golds++; d.goldT = GOLD_T[Math.min(d.golds, 4)]; } else m.gold = false;
      m.ys = 0;
      break;
    }
    case 2:
      if (!freezeWaiting) m.c--;
      if (m.c < 1) {
        m.st = 10; m.ys = 0; m.up = true;
        emit(w, 'rise', mmX(m.x), mmZ(m.z), -1, m.gold ? 1 : 0);
      }
      break;
    case 4:
      if (d.over) emit(w, 'resultBurst', mmX(m.x), mmZ(m.z));
      m.st = 6;
      break;
    case 5: {
      shock(w, d, m.x, m.z, 0x380, -1, 0);
      m.st = 6;
      // one of 0x733-0x736 at random (table 0x800b9e20)
      emit(w, 'boom', mmX(m.x), mmZ(m.z), -1, rn(w, 4));
      break;
    }
    case 6:
      if (CAPS[d.stage] < d.n) { m.st = 1; d.n--; m.up = false; } else { m.st = 0; m.c = 0; }
      break;
    case 10:
      m.ys += 0x100;
      if (m.ys > 0xc00) { m.ys = 0xc00; m.st = 0xc; m.c = WAIT0[d.stage] + rn(w, WAITR[d.stage]); }
      break;
    case 0xc:
      if (m.bd !== 0) m.bd--;
      m.c--;
      if (m.c < 1) { m.st = 0xd; m.c = 0x46; }
      break;
    case 0xd:
    case 0xe:
      if (m.bd !== 0) m.bd--;
      m.c--;
      if (m.c < 1) {
        if (m.st === 0xd) { m.st = 0xe; m.c = 0x28; return; }
        m.st = freezeWaiting ? 4 : 5;
        return;
      }
      m.ys = m.st === 0xd ? rn(w, 0x200) + 0xb00 : rn(w, 0x800) + 0x800;
      break;
  }
}

/** FUN_800b4038 (crate object update; init FUN_800b3f10 / FUN_800b6568) */
function crateFrame(w: World, d: MMData, idx: number, freezeWaiting: boolean) {
  const c = d.cr[idx];
  if (!c) return;
  switch (c.st) {
    case 0:
      if (c.c === 0) { c.bd = botDelay(d.skill); c.c = rn(w, 0x5a) + 0x5a; } else c.bd = 0;
      c.yaw = rn(w, 0x1000);
      c.st = 2;
      c.s = 0;
      break;
    case 2:
      if (!freezeWaiting && c.c > 0) c.c--;
      if (c.c > 0) return;
      { const sp = findSpot(w, d);
        if (sp) { c.x = sp[0]; c.z = sp[1]; clampTo(c, MM_SPAWN); c.st = 10; c.s = 0; } }
      break;
    case 4: c.st = 6; break;
    case 6: c.c = 0; c.st = 0; break;
    case 10: {
      const prev = c.s;
      c.s += 0x100;
      if (prev > 0xfff) { c.s = 0x1000; c.st = 0xc; }
      break;
    }
    case 0xc: if (c.bd > 0) c.bd--; break;
  }
}

const botDelay = (skill: number) => Math.max(0, 96 - 3 * skill);
const botSpeed = (skill: number) => Math.min(62, 45 + Math.max(0, skill - 15));
const botBoots = (skill: number) => Math.min(97, 80 + Math.max(0, skill - 15));

function advanceArena(w: World, d: MMData, freezeWaiting = intro(d)) {
  // spawner (FUN_800b34f8, from the per-frame hook FUN_800b67c4; state reset FUN_800b347c)
  if (d.spawnCd > 0) d.spawnCd--;
  if (d.goldT > 0 && d.golds < 4) d.goldT--;
  if (d.n !== 0) d.mu.forEach((m, i) => { if (m && m.st === 1) d.mu[i] = null; });
  if (d.stage < 4) { const z = d.stageT === 0; d.stageT--; if (z) { d.stage++; d.stageT = STAGE_SECS[d.stage] * 30; } }
  if (d.n < CAPS[d.stage] && d.spawnCd === 0) {
    if (d.n < 10) {
      const m: MMMush = { st: 0, c: rn(w, 10) + d.n * 5, x: 0, z: 0, ys: 0xc00, gold: false, bd: 0, id: d.nextId++ };
      d.mu[d.n] = m;
      d.n++;
    }
    d.spawnCd = 0x14;
  }
  for (let i = 0; i < MM_SLOTS; i++) mushFrame(w, d, i, freezeWaiting);
  for (let i = 0; i < 3; i++) crateFrame(w, d, i, freezeWaiting);
}

function frame(w: World, d: MMData, inputs: (InputState | null | undefined)[]) {
  for (let i = 0; i < d.p.length; i++) playerFrame(w, d, i, inputs[i]);
  advanceArena(w, d);
  // clock
  if (d.g >= INTRO_END && !d.over) {
    if (d.g >= CLOCK_START) d.clock++;
    const tick = d.g - INTRO_END + 1;
    if (d.shown ? tickPlayerTally(d.p, d.shown, tick, 1) : d.clock >= CLOCK_STEPS) finish(w, d);
    else if (d.shown && tick > VERSUS_CLOCK_END) d.p.forEach(p => { p.lock = 100; });
  }
  d.g++;
}

/** Play the L29 result from the ranked snapshot while the authority holds the final scores. */
export function createMalletMashResult(terminal: World, winner: number | undefined) {
  const data = structuredClone(terminal.data) as MMData;
  const world: World = { ...terminal, data, ev: [] };
  let freezeAt = winner === undefined ? 0 : Infinity;
  let tick = 0;
  data.over = true;
  data.p.forEach((p, slot) => {
    p.fl = (p.fl & ~0x700) | (winner === undefined ? 0x100 : slot === winner ? 0x200 : 0x400);
  });

  return {
    data,
    cameraActive: false,
    step(): GameEvent[] {
      tick++;
      world.ev = [];
      data.p.forEach((p, slot) => {
        const state = p.st;
        // FUN_80083e8c clears the pad and blink before processing each flagged player.
        p.pad = 0;
        p.spd = 0;
        p.blink = 0;
        p.hid = false;
        if (p.lock > 0) p.lock--;
        stateUpdate(world, data, slot);
        if (p.st === 0x47 && state !== 0x47) {
          this.cameraActive = true;
          freezeAt = tick + 31 + (WIN_NAME_WAIT[p.ch] + 1) + 31;
          emit(world, 'resultWinner', mmX(p.x), mmZ(p.z), slot);
        }
        if (winner === undefined && state === 0x40) this.cameraActive = true;
        if (p.lock === 0) p.yaw = (p.yaw + (angDiff(p.yaw, p.hd) >> 2)) & 0xfff;
        movePlayer(p);
      });
      // FUN_8007d9dc sets the intro flag on a draw or once the winner's reaction begins.
      advanceArena(world, data, tick > freezeAt);
      data.g++;
      world.tick++;
      return world.ev;
    },
  };
}

/** FUN_800b5820 (-1): rank by score (ties: lower slot first); equal top two = draw */
function finish(w: World, d: MMData) {
  const ord = [0, 1, 2, 3].slice(0, d.p.length).sort((a, b) => d.p[b].score - d.p[a].score || a - b);
  d.over = true;
  if (d.p.length > 1 && d.p[ord[0]].score === d.p[ord[1]].score) {
    d.winner = -1;
    for (const P of d.p) P.fl |= 0x100;
  } else {
    d.winner = ord[0];
    d.p.forEach((P, i) => { P.fl |= i === ord[0] ? 0x200 : 0x400; });
  }
  emit(w, 'end', 0, 0, d.winner, 1);
}

function syncBodies(w: World, d: MMData) {
  for (const b of w.bodies) {
    if (b.kind !== 'player') continue;
    const P = d.p[b.slot];
    if (!P) continue;
    const nx = mmX(P.x), nz = mmZ(P.z);
    b.vx = (nx - b.x) * 30; b.vz = (nz - b.z) * 30;
    b.x = nx; b.z = nz;
    b.face = mmFace(P.yaw);
  }
}

// ---------------------------------------------------------------- the game
export const malletMash: MiniGame = {
  id: 'malletMash',
  name: 'Mallet Mash',
  description: 'Smash mushrooms to score. Shaking and gold mushrooms are worth more. Highest score wins.',
  controls: '{move} run. Tap {a} to swing. Hold and release {a} for a shock wave.',
  maxTime: MM_MAX_TIME,
  settlesAfterTimeout: true,

  setup(w: World, slots: SlotInfo[]) {
    const ps: MMPlayer[] = [];
    const bots = slots.filter((s) => s.bot);
    const level = bots.length ? bots[bots.length - 1].level ?? 2 : 2;
    for (const s of slots) {
      const i = s.slot;
      const ch = MM_CHAR[(s.char ?? i * 2) % MM_CHAR.length] ?? 1;
      const [x, z, yaw] = START[i];
      const P: MMPlayer = {
        ch, bot: s.bot, x, z, yaw, hd: yaw, spd: 0, kn: 0, knh: 0, mv: 1, sc: 0x1000, st: 0x40, prev: 0x40, fl: 0, score: 0, lock: 0, blink: 0,
        stun: 0, hits: 0, hid: false, pw: 3, pwT: 0, tk: 0, ti: 0, chg: 0, req: false, pad: 0,
        an: { id: 0x33, pc: 0, c: -1, h: 0, l: 0, d: 0, pose: 0 },
        ai: { mode: 0, tk: 0, ti: 0, tx: 0, tz: 0, cd: 0, pad: 0 },
      };
      ps[i] = P;
      addBody(w, 'player', i, mmX(x), mmZ(z), RADIUS[ch] / MM_S, 1);
      animStart(P, 0x33);
    }
    const d: MMData = {
      g: 0, p: ps, mu: Array(MM_SLOTS).fill(null), cr: [null, null, null], n: 0, stage: 0, stageT: STAGE_SECS[0] * 30,
      spawnCd: 0, goldT: GOLD_T[0], golds: 0, nc: 0, nextId: 1, skill: BOT_SKILL[Math.max(0, Math.min(2, level))], clock: 0,
      over: false, winner: -2, seats: slots.length, shown: [0, 0, 0, 0],
    };
    for (let i = 0; i < 2; i++) d.cr[i] = { st: 0, c: i * 0x5a + 0x1e, x: 0, z: 0, s: 0, bd: 0, yaw: 0 };
    d.nc = 2;
    w.data = d;
    // the real game's intro (players locked, mushroom / crate timers frozen, spawner running)
    for (let k = 0; k < INTRO_END; k++) frame(w, d, []);
    w.ev.length = 0;
    syncBodies(w, d);
    for (const b of w.bodies) { b.vx = 0; b.vz = 0; }
  },

  /** Seats that are not CPU slots (e.g. a human who disconnected mid-round) are driven through here with the same AI;
   *  real CPU slots run it inside frame() (one-frame pad latency like the game), so they return idle. Uses P.ai, which humans never touch. */
  bot(w: World, slot: number): InputState {
    const d = w.data as MMData;
    const P = d?.p?.[slot];
    if (!P || P.bot || d.over) return { x: 0, y: 0, a: false, b: false };
    const pad = aiPad(w, d, slot);
    return { x: pad & 0x80 ? -1 : pad & 0x20 ? 1 : 0, y: pad & 0x10 ? -1 : pad & 0x40 ? 1 : 0, a: (pad & 0x8000) !== 0, b: false };
  },

  step(w, inputs) {
    const d = w.data as MMData;
    frame(w, d, inputs);
    syncBodies(w, d);
  },

  isOver(w) {
    const d = w.data as MMData;
    if (d.winner === -1) return true;
    return d.over;
  },

  isDraw(w, [a, b]) { return w.data.p[a]?.score === w.data.p[b]?.score; },

  placements(w) {
    const d = w.data as MMData;
    return [0, 1, 2, 3].sort((a, b) => (d.p[b]?.score ?? 0) - (d.p[a]?.score ?? 0) || a - b);
  },
};
