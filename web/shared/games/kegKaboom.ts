import { atan2g } from '../ps1Angle';
export { atan2g } from '../ps1Angle';
import { DISC_CHARACTER } from '../look';
import { addBody, discRandomInt, discRandomState, drawDiscRandom, emit } from '../physics';
import { ps1SqrtQ6 } from '../ps1Sqrt';
import { IDLE, type InputState, type MiniGame, type SlotInfo, type World } from '../types';
import { KK_AIR_HIT_SCRIPTS, KK_SCRIPTS } from './kegKaboomData';
import { nextPlayerOrder, shufflePlayerOrders, tickPlayerTally, VERSUS_CLOCK_END } from './common';

/**
 * KEG KABOOM (Crash Bash level 30, family 0x10d), ported from the PS1 code (overlay 0x800b32b4.., see re/notes/kegKaboom.md).
 *
 * Everything runs in the game's own integer units at its 30 Hz logic rate (1 sim tick = 1 logic frame). Game units -> sim world
 * units: world = game / 301.4 (1024 game units = 1 model unit x 3.398 arena scale); the game's +z is the screen-up direction, so
 * world.z = -game.z. Angles are 0..0xfff, 0 = +z, clockwise (atan2(dx, dz)). y is height above the floor, NEGATIVE up (game convention).
 *
 * Rules (all from the code): hold Square (b) on the ground to drop a gunpowder node every frame at a per-character spot beside you
 * (grid of 128-unit cells, a node lives 60 frames, CPUs 60*skill/16). Two flames orbit the rim (radius 2304, 12 angle units per
 * frame); a flame ignites every node in the 8 cells around it: each becomes two sparks that run (20 units per frame) along the
 * trail from node to node, and blow up every keg within a +-300 box (chains +-288 from each keg). A keg is worth min(10, combo + chain
 * + 2) (silver 10, gold 20, every 8th keg silver, every 32nd gold); the combo of a player grows by what his sparks blow up and
 * drops to 0 ten frames after his last spark. The shock-wave pickup (a bouncing flame, every 600 frames) lets the next press of
 * Circle (on the ground) blow every keg within +-896 and stun everyone else in that box. Cross = jump.
 * Highest score after 1:30 wins; the real scores are all even (HUD counters roll up one digit at a time, which is where odd
 * numbers seen on screen come from).
 *
 * The sim starts at the end of the real game's 99-frame intro (keg spawner / flames / pickup timers already ran, pre-simulated in
 * setup); the clock starts 27 frames later and waits for any outstanding points at the horn.
 *
 * world.data (KKData): p[4] players (null for an empty seat), o[] objects (kegs t1, nodes t2, pickup t4, sparks t5), fl[2] flames.
 * Bodies: 'player' per slot, x/z/y mirror the game position (for the shared view helpers).
 * Events (x z in world units): 'spawn' (keg appears, o kind), 'pop' (keg hit: s owner, v points, o kind 0 normal / 1 silver / 2 gold, k = chain depth),
 *   'boom' (keg explodes one frame later, v sound variant 0..3), 'fuse' (s: first spark of a trail), 'ignite' (flame lights a node),
 *   'wave' (s, v radius world units: shock wave), 'pick' (s got the shock pickup), 'pspawn' (pickup appears), 'stun' (s victim, o attacker),
 *   'step' (s: footfall), 'end'.
 */

// ---------------------------------------------------------------- constants
/** game units per world unit */
export const KK_S = 301.4;
export const kkX = (x: number) => x / KK_S;
export const kkZ = (z: number) => -z / KK_S;
export const KK_ARENA = 0x938;
export const KK_BOX = 0x684;
export const KK_R = KK_ARENA / KK_S;
/** a keg stops players closer than this (centre distance) */
export const KK_KEG_R = 224 / KK_S;
export const KK_FLAME_R = 2304 / KK_S;
/** shock wave reach (box half side) */
export const KK_WAVE = 0x380;

export const KK_INTRO_TICKS = 99; // last update with the native countdown input lock
export const KK_FLAME_STEP = 12;
const CLOCK_START = 126;
const LEGACY_END_G = 2813;
export const KK_MAX_TIME = VERSUS_CLOCK_END / 30;

const START: [number, number, number][] = [[-933, -1176, 3584], [-1141, 1343, 512], [1059, 1295, 1536], [1038, -1145, 2560]];
/** Engine character ID per roster look. Both custom carriers use Cortex's physics. */
export const KK_CHAR = DISC_CHARACTER;
// FUN_800b46bc caches marker 0x40 at the collision pose in table 0x800bc188.
// Coco, Brio and Koala also have no fallback cylinder in their Keg animation frames.
const CYLINDER: readonly (readonly [bottom: number, radius: number, top: number] | null)[] = [
  null, [0, 204, -502], null, [3, 153, -519], null, [-5, 179, -724], [-9, 119, -707], [0, 332, -718], null,
];
const LEGACY_CYLINDER = [Infinity, 120, -Infinity] as const;
// Slots 0–12 hold the permanent scene and four fuse followers.
const FIRST_DYNAMIC_SLOT = 13, OBJECT_SLOT_COUNT = 104;
/** jump table (exe 0x8009d354): initial speed, max fall, fall accel, rise decel */
const JUMP: number[][] = [[0, 0, 0, 0], [108, 114, 8, 10], [108, 114, 8, 10], [108, 114, 8, 10], [108, 114, 8, 10], [72, 114, 10, 6], [72, 114, 10, 6], [72, 114, 10, 6], [72, 114, 10, 6]];
const SKILL = [14, 19, 22];
/** powder node offset per engine char (table 0x800bba44): distance, yaw offset, height */
const NODE_OFF: [number, number, number][] = [[0, 0, 0], [130, -900, 220], [100, -1200, 250], [100, 1100, 200], [100, 1100, 200], [130, -1500, 250], [130, -1500, 300], [130, -1100, 300], [130, -1100, 300]];
/** pad bits for the 8 AI directions (table 0x80051244) */
const DIRBITS = [16, 48, 32, 96, 64, 192, 128, 144];
/** controller heading per d-pad combination (measured) */
const HEADING: Record<number, number> = { 0x10: 2048, 0x30: 2557, 0x20: 3072, 0x60: 3584, 0x40: 4096, 0xc0: 4611, 0x80: 5120, 0x90: 5632 };
/** 8 neighbour cells (table 0x800bc1b0) */
const NB: [number, number][] = [[-128, -128], [-128, 0], [-128, 128], [0, -128], [0, 128], [128, -128], [128, 0], [128, 128]];
const GRID = 0xa00;

// ---------------------------------------------------------------- exe math replicas
const COS = new Int16Array(4096);
for (let i = 0; i < 4096; i++) COS[i] = Math.round(4096 * Math.cos((i * 2 * Math.PI) / 4096));
const T = (i: number) => COS[i & 0xfff];
const angDiff = (a: number, b: number) => { const v = (b - a) & 0xfff; return v > 0x800 ? v - 0x1000 : v; };
export const kkTurn = (yaw: number, target: number) => (yaw + (angDiff(yaw, target) >> 2)) & 0xfff;
const dist = (ax: number, az: number, bx: number, bz: number) => ps1SqrtQ6((bx - ax) ** 2 + (bz - az) ** 2) >> 6;

// ---------------------------------------------------------------- data
export interface AnimSt { id: number; pc: number; c: number; h: number; l: number; d: number; pose: number }
export interface KAi { mode: number; tm: number; pad: number; tx: number; tz: number; ang: number; keg: number; pk: number; burn: number }
export interface KP {
  ch: number; bot: boolean; slot: number; cpuFallback?: boolean;
  x: number; y: number; z: number; yaw: number; hd: number; spd: number; mv: number; run: number;
  st: number; fl: number; score: number;
  /** jump physics: speed, cap, fall accel, rise decel, rising (cap 0 = off) */
  jv: number; jc: number; ja: number; jd: number; jr: number;
  pad: number; ppad: number; lay: number; combo: number; shock: number; fuse: number; fuseP: number;
  fuseStart?: number; fuseVariant?: number;
  /** Last spark in the seat's update order, plus the origin read by this tick's audio update. */
  fuseOrigin?: [number, number]; fuseMixOrigin?: [number, number];
  nx: number; nz: number; hasN: number; lastNodeSlot?: number;
  sl: number; sr: number;
  an: AnimSt; ai: KAi;
}
interface ArenaObject { poolSlot?: number }
export interface KKeg extends ArenaObject { t: 1; id: number; x: number; z: number; sc: number; gr: number; hit: number; kind: number; claim: number; sl: number; born: number; dead?: boolean }
export interface KNode extends ArenaObject { t: 2; yaw?: number; id: number; x: number; z: number; y: number; vy: number; life: number; own: number; born: number; dead?: boolean }
export interface KPick extends ArenaObject { t: 4; id: number; x: number; z: number; y: number; vy: number; ch: number; born: number; dead?: boolean }
export interface KSpark extends ArenaObject { t: 5; id: number; x: number; z: number; tx: number; tz: number; st: number; life: number; own: number; sc?: number; born: number; dead?: boolean }
// Point numbers and blast scripts occupy the same native slots as kegs and powder.
interface KEffect extends ArenaObject { t: 6; id: number; x: number; z: number; life: number; born: number; dead?: boolean }
export type KObj = KKeg | KNode | KPick | KSpark | KEffect;
export interface KKData {
  g: number;
  p: (KP | null)[];
  o: KObj[];
  fl: number[];
  /** keg spawner timer, pickup spawner timer, keg counter, object id */
  kt: number; pt: number; kn: number; nid: number;
  skill: number; over: boolean; winner: number;
  shown?: number[];
  random?: [number, number];
  updateOrders?: number[][];
  pool?: { next: number; free: number[] };
}

/** Substitute recorded draws when comparing with an emulator trace. */
export const kkTest: { rn: ((w: World, n: number) => number) | null } = { rn: null };
const R = (w: World, n: number) => (kkTest.rn ? kkTest.rn(w, n) : discRandomInt(w, n));

// ---------------------------------------------------------------- animation script interpreter (FUN_8008502c / FUN_800854c0)
type AnimPlayer = Pick<KP, 'ch' | 'an'>;
const scriptOf = (P: AnimPlayer, id = P.an.id) => id >= 0x61 ? KK_SCRIPTS[P.ch][id - 0x61] : KK_AIR_HIT_SCRIPTS[P.ch][id];
function animCall(P: AnimPlayer, id: number, onState?: (st: number) => void): number {
  P.an = { id, pc: 0, c: -1, h: 0, l: P.an?.l ?? 0, d: scriptOf(P, id)[0], pose: P.an?.pose ?? 0 };
  return animStep(P, onState);
}
export function animStart(P: KP, id: number, onState?: (st: number) => void): number { return animCall(P, id, onState); }
export function animStep(P: AnimPlayer, onState?: (st: number) => void): number {
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
    else if (v === 0x8002 || v === 0x8003) { a.pc++; ret = S[a.pc]; }
    else if (v === 0x8004) { a.pc++; onState?.(S[a.pc]); return ret; }
    else if (v === 0x8005) { a.pc++; return animCall(P, S[a.pc], onState); }
    else if (v === 0x8007) { a.pc++; a.l = 0; a.h = S[a.pc] - 1; }
    else if (v === 0x8008 || v === 0x8009 || v === 0x800a) { a.pc++; }
    else if (v === 0x8018) { a.pc++; a.d = S[a.pc]; }
  }
  a.pose = v; a.l = v; a.c = a.d;
  return ret;
}
/** [clip, frame] of the current pose (clip = gltf animation index, 30 fps = one logic frame per key) */
export const kkPose = (an: AnimSt): [number, number] => [(an.pose - 0x4000) >> 7, an.pose & 0x7f];

function startOpeningIdle(player: AnimPlayer) {
  animCall(player, 0x61);
  // The first drawn native arena frame has already run one idle update after the initial call.
  animStep(player);
}

/** Sample the locked opening's idle script from its initial call, independently of the host snapshot. */
export function kkOpeningPoses(ch: number): [number, number][] {
  const player: AnimPlayer = { ch, an: { id: 0x61, pc: 0, c: -1, h: 0, l: 0, d: 0, pose: 0 } };
  startOpeningIdle(player);
  const poses = [kkPose(player.an)];
  for (let tick = 0; tick < KK_INTRO_TICKS; tick++) {
    animStep(player);
    poses.push(kkPose(player.an));
  }
  return poses;
}

export function kkStartFall(P: KP) {
  P.mv = 1; P.jv = 8; P.jc = 0x70; P.ja = 10; P.jd = 0; P.jr = 0;
}

/** Advance the native vertical integrator (FUN_800860d4), returning true at the apex. */
export function kkStepJump(P: KP, crossHeld: boolean): boolean {
  if (P.jc === 0) return false;
  if (P.jr) {
    const dec = !P.bot && !crossHeld && P.jv > 0x40 ? 0x28 : P.jd;
    P.jv -= dec;
    if (P.jv < 0) {
      P.jv = 0; P.jr = 0;
      return true;
    }
    P.y -= P.jv;
  } else {
    P.jv = Math.min(P.jv + P.ja, P.jc);
    P.y += P.jv;
  }
  return false;
}

// ---------------------------------------------------------------- helpers
const intro = (d: KKData) => d.g < KK_INTRO_TICKS;
const cellOf = (x: number, z: number) => ((z + GRID) >> 7) * 0x28 + ((x + GRID) >> 7);
const grid = new Map<number, KNode>();
const bySlot = new Map<number, KObj>();

const liveKegs = (d: KKData): KKeg[] => {
  const out: KKeg[] = [];
  for (const o of d.o) if (o.t === 1 && !o.dead) out.push(o);
  return out.sort((a, b) => a.sl - b.sl);
};
const findObj = <T extends KObj>(d: KKData, t: number, id: number): T | undefined => {
  for (const o of d.o) if (o.t === t && o.id === id && !o.dead) return o as T;
  return undefined;
};
const findPick = (d: KKData): KPick | undefined => {
  for (const o of d.o) if (o.t === 4 && !o.dead) return o;
  return undefined;
};
const kill = (d: KKData, o: KObj) => {
  o.dead = true;
  if (d.pool && o.poolSlot !== undefined) {
    d.pool.free.push(o.poolSlot);
    bySlot.delete(o.poolSlot);
  }
  if (o.t === 2 && grid.get(cellOf(o.x, o.z)) === o) grid.delete(cellOf(o.x, o.z));
};
function indexSlot(d: KKData, o: KObj) {
  if (!d.pool) return;
  o.poolSlot ??= d.pool.free.pop() ?? d.pool.next++;
  bySlot.set(o.poolSlot, o);
}
const poolFull = (d: KKData) => !!d.pool && !d.pool.free.length && d.pool.next >= OBJECT_SLOT_COUNT;
const add = <T extends KObj>(d: KKData, o: T): T | undefined => {
  if (poolFull(d)) return undefined;
  indexSlot(d, o);
  d.o.push(o);
  return o;
};

function clampArena(P: KP) {
  if (P.x < -KK_BOX || P.x > KK_BOX || P.z < -KK_BOX || P.z > KK_BOX) {
    const ex = dist(0, 0, P.x, P.z) - KK_ARENA;
    if (ex > 0) {
      const a = atan2g(P.x, P.z);
      P.x -= (ex * T(a - 0x400)) >> 12;
      P.z -= (ex * T(a)) >> 12;
    }
  }
}

/** a player the keg spawner / pickup spawner / pickup consider alive (flags & 0xc000 == 0) */
const free = (P: KP | null): P is KP => !!P && (P.fl & 0xc000) === 0;

// The renderer plays the visual independently. Its native callback still occupies a slot.
function allocateEffect(d: KKData, x: number, z: number, life: number) {
  if (d.pool) add<KEffect>(d, { t: 6, id: d.nid++, x, z, life, born: d.g });
}

// ---------------------------------------------------------------- scoring: FUN_800b7df0
function chain(w: World, d: KKData, x: number, z: number, owner: number, base: number, rad: number, depth: number): number {
  let tot = 0;
  for (const k of liveKegs(d)) {
    if (k.hit === 1) continue;
    const dx = k.x - x, dz = k.z - z;
    if (!(dx > -rad && dx < rad && dz > -rad && dz < rad) || k.gr === 1) continue;
    k.hit = 1;
    let v: number;
    if (k.kind === 2) v = 20;
    else if (k.kind === 1) v = 10;
    else v = Math.min(10, base + tot + 2);
    const P = d.p[owner];
    if (P) P.score += v;
    allocateEffect(d, k.x, k.z, Math.max(1, depth) + 103);
    depth += 10;
    emit(w, 'pop', kkX(k.x), kkZ(k.z), owner, v, k.kind);
    const sub = chain(w, d, k.x, k.z, owner, v, 0x120, depth);
    tot += 2 + sub;
  }
  return tot;
}

// ---------------------------------------------------------------- player states
function enter(w: World, d: KKData, i: number, st: number) {
  const P = d.p[i]!;
  P.st = st;
  const onState = (s: number) => enter(w, d, i, s);
  switch (st) {
    case 0x71: P.jc = 0; P.mv = 1; animCall(P, 0x61, onState); break;
    case 0x72: P.mv = 1; animCall(P, 0x64, onState); break;
    case 0x73: P.mv = 0; P.shock = 0; animCall(P, 0x68, onState); break;
    case 0x74: P.mv = 0; P.jc = 0; animCall(P, 0x61, onState); break;
    case 0x75: P.mv = 0; P.jc = 0; animCall(P, 0x6b, onState); break;
    case 0x78: {
      P.mv = 1;
      animCall(P, 0x65, onState);
      emit(w, 'jump', kkX(P.x), kkZ(P.z), i, 1); // anim 0x65 carries a voice (0x8008) on frame 1
      const t = P.bot ? JUMP[1] : JUMP[P.ch];
      P.jv = t[0]; P.jc = t[1]; P.ja = t[2]; P.jd = t[3]; P.jr = 1;
      break;
    }
    case 0x7a: kkStartFall(P); animCall(P, 0x66, onState); break;
    case 0x7b: P.mv = 1; P.jc = 0; animCall(P, 0x67, onState); emit(w, 'land', kkX(P.x), kkZ(P.z), i, 1); break; // 0x67: voice on frame 1
  }
}

/** FUN_800b52c8 resolves player cylinders. The keg object has its own contact callback. */
function collide(d: KKData, i: number) {
  const P = d.p[i]!;
  const marker = d.pool ? CYLINDER[P.ch] : LEGACY_CYLINDER;
  if (!marker) return;
  for (let j = 0; j < 4; j++) {
    const Q = d.p[j];
    if (!Q || j === i || (Q.fl & 0xf800)) continue;
    const take = P.spd !== 0 ? true : Q.spd === 0;
    if (!take) continue;
    const other = d.pool ? CYLINDER[Q.ch] : LEGACY_CYLINDER;
    if (!other || P.y + marker[2] >= Q.y + other[0] || Q.y + other[2] >= P.y + marker[0]) continue;
    const r = marker[1] + other[1];
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
  }
  if (!d.pool && P.spd !== 0) {
    for (const k of liveKegs(d)) {
      const dx = k.x - P.x, dz = k.z - P.z;
      const r = 224;
      if (dx * dx + dz * dz < r * r) {
        const dd = ps1SqrtQ6(dx * dx + dz * dz) >> 6;
        if (dd < r) {
          const a = atan2g(dx, dz);
          const o = r - dd + 1;
          P.x -= (o * T(a - 0x400)) >> 12;
          P.z -= (o * T(a)) >> 12;
        }
      }
    }
  }
}

function endFlags(w: World, d: KKData, i: number): boolean {
  const P = d.p[i]!;
  if (P.fl & 0x200) { enter(w, d, i, 0x75); return true; }
  if (P.fl & 0x400) { enter(w, d, i, 0x74); return true; }
  return false;
}

function stateUpdate(w: World, d: KKData, i: number, pressX: boolean) {
  const P = d.p[i]!;
  const onState = (s: number) => enter(w, d, i, s);
  switch (P.st) {
    case 0x71: { // idle
      if (endFlags(w, d, i)) return;
      if (pressX) { enter(w, d, i, 0x78); return; }
      if (P.spd !== 0) { enter(w, d, i, 0x72); return; }
      animStep(P, onState);
      return;
    }
    case 0x72: { // run
      if (endFlags(w, d, i)) return;
      if (pressX) { enter(w, d, i, 0x78); return; }
      if (P.spd === 0) { enter(w, d, i, 0x71); return; }
      P.mv = 1;
      collide(d, i);
      const ev = animStep(P, onState);
      if (ev === 8 || ev === 9) emit(w, 'step', kkX(P.x), kkZ(P.z), P.slot, ev - 8);
      return;
    }
    case 0x73: { // hit
      animStep(P, onState);
      return;
    }
    case 0x74: case 0x75: { // loser / winner
      animStep(P, onState);
      return;
    }
    case 0x78: { // jump, rising
      collide(d, i);
      animStep(P, onState);
      return;
    }
    case 0x7a: { // falling
      if (P.y >= 0) { P.y = 0; P.jc = 0; enter(w, d, i, 0x7b); }
      collide(d, i);
      animStep(P, onState);
      return;
    }
    case 0x7b: { // landing
      if (endFlags(w, d, i)) return;
      if (pressX) { enter(w, d, i, 0x78); return; }
      if (P.spd === 0) { collide(d, i); animStep(P, onState); } else enter(w, d, i, 0x72);
      return;
    }
  }
}

// ---------------------------------------------------------------- AI (FUN_800b37c8 / FUN_800b3488 / FUN_800b3338)
/** FUN_800b3338: aim at a spot 256 units beside the target */
function aiAim(P: KP, tx: number, tz: number) {
  const a = atan2g(tx - P.x, tz - P.z);
  const a2 = P.ch === 3 || P.ch === 4 ? a - 0x5a : a + 0x5a;
  const nx = tx + (T((a2 & 0xfff) - 0x400) >> 4), nz = tz + (T(a2 & 0xfff) >> 4);
  P.ai.tx = nx; P.ai.tz = nz;
  P.ai.ang = atan2g(nx - P.x, nz - P.z);
}

/** nearest keg by the AI's weighting (claimed kegs count double, silver 2/3, gold 1/2) */
function aiNearest(d: KKData, i: number, P: KP): KKeg | null {
  let best = 0x8000, sel: KKeg | null = null;
  for (const k of liveKegs(d)) {
    let dd = dist(P.x, P.z, k.x, k.z);
    if (k.claim >= 0 && k.claim !== i) dd <<= 1;
    if (k.kind === 1) dd = Math.trunc((dd << 1) / 3);
    else if (k.kind === 2) dd = Math.trunc(dd / 2);
    if (dd < best) { best = dd; sel = k; }
  }
  return sel;
}

function aiPick(w: World, d: KKData, i: number, P: KP) {
  const A = P.ai, sk = d.skill;
  if (R(w, 0x40) <= sk + 0x20) {
    const pk = findPick(d);
    if (pk && Math.abs(P.x - pk.x) + (P.z - pk.z) < 0xf00) {
      A.pk = pk.id; A.mode = 5; A.tm = 0x96;
      aiAim(P, pk.x, pk.z);
      return;
    }
    A.pk = -1;
    if (A.burn < 1) {
      A.mode = 7; A.tm = 60;
      A.ang = atan2g(P.x, P.z);
      return;
    }
    const sel = aiNearest(d, i, P);
    if (sel) {
      A.mode = 6; A.keg = sel.id; A.tm = 60;
      aiAim(P, sel.x, sel.z);
      sel.claim = i;
      return;
    }
  }
  A.tm = 0x1e;
  const r = R(w, 8);
  if (r < 3 || r > 7) { A.tm = R(w, 0x1e) + 0xf; A.pad = 0; A.mode = 1; return; }
  A.mode = 4;
  A.tx = R(w, 0x1100) - 0x880;
  A.tz = R(w, 0x1100) - 0x880;
  A.ang = atan2g(A.tx - P.x, A.tz - P.z);
}

function aiFrame(w: World, d: KKData, i: number, P: KP): number {
  if (d.g < KK_INTRO_TICKS - (d.random ? 1 : 0)) return 0;
  const A = P.ai, sk = d.skill;
  const off = [-200, 0, 200, 0][(A.tm >> 4) & 3];
  A.pad = 0;
  if (A.burn > 0) A.burn--;
  A.tm--;
  if (A.tm < 1) aiPick(w, d, i, P);
  const dirOf = (a: number) => DIRBITS[(a >> 9) & 7];
  let repick = false;
  switch (A.mode) {
    case 4:
      A.pad |= dirOf(A.ang + off);
      if (A.tm < 5 || (A.tx - P.x + 99 >= 0 && A.tx - P.x + 99 < 199 && A.tz - P.z + 99 >= 0 && A.tz - P.z + 99 < 199)) { A.mode = 1; A.tm = 1; A.pad |= 0x2000; }
      break;
    case 5: {
      const pk = A.pk >= 0 ? findObj<KPick>(d, 4, A.pk) : undefined;
      if (pk) { aiAim(P, pk.x, pk.z); A.pad |= dirOf(A.ang + off); } else repick = true;
      break;
    }
    case 6: {
      let keg = A.burn > 0 ? findObj<KKeg>(d, 1, A.keg) : undefined;
      if (keg) {
        if (R(w, 0x20) < sk) {
          if (keg.claim === i) keg.claim = -21;
          const sel = aiNearest(d, i, P);
          if (sel) { A.mode = 6; A.keg = sel.id; A.tm = 60; aiAim(P, sel.x, sel.z); sel.claim = i; keg = sel; }
        }
        aiAim(P, keg.x, keg.z);
        A.pad |= dirOf(A.ang + off);
      } else repick = true;
      break;
    }
    case 7:
      if (A.burn < 1) {
        if (dist(0, 0, P.x, P.z) >= KK_ARENA - 200) { A.mode = 8; A.tm = 60; A.ang -= 0x400; }
        A.pad |= dirOf(A.ang);
      } else repick = true;
      break;
    case 8:
      if (A.burn < 1) A.pad |= dirOf(A.ang); else repick = true;
      break;
  }
  if (repick) aiPick(w, d, i, P);
  if ((A.tm & 7) !== 0) {
    let n = 0;
    for (const k of liveKegs(d)) if (dist(P.x, P.z, k.x, k.z) < 0x380) n++;
    if (n > 2) A.pad |= 0x2000;
  }
  if (A.mode !== 4 && A.mode !== 1 && A.mode !== 7) A.pad |= 0x8000;
  return A.pad;
}

// A disconnected seat's controller must run inside the same shuffled pass as the other players.
const CPU_CONTROL = Symbol('Keg Kaboom CPU control');
const cpuRequest = { ...IDLE, [CPU_CONTROL]: true };

// ---------------------------------------------------------------- one player, one logic frame
function playerFrame(w: World, d: KKData, i: number, inp: InputState | null | undefined) {
  const P = d.p[i]!;
  let pad = 0;
  const cpu = P.bot || (inp ? CPU_CONTROL in inp : P.cpuFallback === true);
  if (!P.bot && cpu) P.cpuFallback = true;
  if (P.cpuFallback && !cpu) {
    delete P.cpuFallback;
    P.ai.pad = 0;
  }
  if (cpu) {
    const previousPad = P.ai.pad;
    const nextPad = aiFrame(w, d, i, P);
    pad = d.random ? previousPad : nextPad;
  } else if (inp && !intro(d)) {
    if (inp.y < -0.5) pad |= 0x10;
    if (inp.y > 0.5) pad |= 0x40;
    if (inp.x < -0.5) pad |= 0x80;
    if (inp.x > 0.5) pad |= 0x20;
    if (inp.a) pad |= 0x4000;
    if (inp.b) pad |= 0x8000;
    if (inp.c) pad |= 0x2000;
  }
  if (d.shown && d.g - KK_INTRO_TICKS >= VERSUS_CLOCK_END) {
    pad = 0;
    P.hd = P.yaw;
  }
  const crossHeld = (pad & 0x4000) !== 0;
  const pressX = crossHeld && !(P.ppad & 0x4000);
  P.ppad = pad;
  P.pad = pad;
  // input -> control (FUN_800b48e4)
  P.spd = 0;
  const bits = pad & 0xf0;
  if (bits === 0) P.hd &= 0xfff;
  else {
    const hd = HEADING[bits];
    if (hd !== undefined) P.hd = hd & 0xfff;
    if (P.mv !== 0) P.spd = P.run ? P.sr : P.sl;
  }
  stateUpdate(w, d, i, pressX);
  // physics (FUN_80085d2c / FUN_800b4b34)
  if (P.st !== 0x74 && P.st !== 0x75) P.yaw = kkTurn(P.yaw, P.hd);
  P.run = (pad & 0x8000) === 0 ? 1 : 0;
  if (kkStepJump(P, crossHeld)) {
    if (P.st === 0x78) enter(w, d, i, 0x7a);
    else { P.jv = 8; P.jc = 0x70; P.ja = 10; }
  } else if (P.jc !== 0 && !P.jr && P.st === 0x73 && P.y >= 0) {
    P.y = 0; P.jc = 0;
  }
  if (P.spd !== 0) {
    P.x -= (P.spd * T(P.hd - 0x400)) >> 12;
    P.z -= (P.spd * T(P.hd)) >> 12;
  }
  // powder: a node every frame while Square is held on the ground
  if ((pad & 0x8000) === 0 || P.y < -0x31) {
    P.lay--;
    if (P.lay < 1) P.combo = 0;
  } else {
    P.lay = 0xf;
    // The native last-node pointer still refers to its slot if another effect has reused it.
    const previous = P.lastNodeSlot === undefined ? undefined : bySlot.get(P.lastNodeSlot);
    const dx = P.x - (previous?.x ?? P.nx), dz = P.z - (previous?.z ?? P.nz);
    if (!P.hasN || dx * dx + dz * dz > 0x3ff) layNode(w, d, i, P);
  }
  // shock wave
  if ((pad & 0x2a00) !== 0 && P.y > -0x32 && P.shock !== 0) {
    P.shock = 0;
    emit(w, 'wave', kkX(P.x), kkZ(P.z), i, KK_WAVE / KK_S, -1, undefined, -P.y / KK_S);
    chain(w, d, P.x, P.z, i, 0, KK_WAVE, 0);
    for (let j = 0; j < 4; j++) {
      const Q = d.p[j];
      if (!Q || j === i) continue;
      if (Math.abs(P.x - Q.x) <= KK_WAVE && Math.abs(P.z - Q.z) <= KK_WAVE && !d.over && (Q.fl & 64000) === 0) {
        enter(w, d, j, 0x73);
        emit(w, 'stun', kkX(Q.x), kkZ(Q.z), j, d.random ? R(w, 4) : 1, i, undefined, -Q.y / KK_S);
      }
    }
    allocateEffect(d, P.x, P.z, 9);
  }
  clampArena(P);
}

/** FUN_800b7948 */
function layNode(w: World, d: KKData, i: number, P: KP) {
  const [dd, ao, yo] = NODE_OFF[P.ch];
  const a = (P.yaw + ao) & 0xfff;
  const cl = (v: number) => (v < -0x9ff ? -0x9ff : v > 0x9ff ? 0x9ff : v);
  const nx = cl(P.x + ((dd * T(a - 0x400)) >> 12));
  const nz = cl(P.z + ((dd * T(a)) >> 12));
  const c = cellOf(nx, nz);
  const old = grid.get(c);
  let life = 60;
  if (P.bot) life = (life * d.skill) >> 4;
  const n = add<KNode>(d, { t: 2, id: d.nid++, x: nx, z: nz, y: P.y - yo, vy: 0, yaw: P.yaw, life, own: i, born: d.g });
  if (!n) return;
  if (n.poolSlot !== undefined) P.lastNodeSlot = n.poolSlot;
  if (old) kill(d, old);
  grid.set(c, n);
  P.nx = nx; P.nz = nz; P.hasN = 1;
  void w;
}

// ---------------------------------------------------------------- objects
function spawnKeg(w: World, d: KKData) {
  const used = new Set(liveKegs(d).map((k) => k.sl));
  let sl = 0;
  while (used.has(sl)) sl++;
  for (let tries = 0; tries < 400; tries++) {
    const x = (R(w, 8) - 4) * 0x200, z = (R(w, 8) - 4) * 0x200;
    if (dist(0, 0, x, z) > 0x800) continue;
    if (d.p.some((P) => free(P) && Math.abs(x - P.x) <= 0x200 && Math.abs(z - P.z) < 0x200)) continue;
    if (liveKegs(d).some((k) => k.x === x && k.z === z)) continue;
    if (poolFull(d)) return;
    d.kn++;
    const kind = (d.kn & 0x1f) === 0 ? 2 : (d.kn & 7) === 0 ? 1 : 0;
    add<KKeg>(d, { t: 1, id: d.nid++, x, z, sc: 1000, gr: 1, hit: 0, kind, claim: -23, sl, born: d.g });
    emit(w, 'spawn', kkX(x), kkZ(z), -1, 1, kind);
    return;
  }
}

function kegSpawner(w: World, d: KKData) {
  if (d.over) return;
  if (d.kt === 0) {
    const n = liveKegs(d).length;
    d.kt = n * 5 + 1;
    if (n < 8) spawnKeg(w, d);
  } else d.kt--;
}

function pickSpawner(w: World, d: KKData) {
  if (d.over) return;
  if (d.pt !== 0) { d.pt--; return; }
  d.pt = 600;
  if (findPick(d)) return;
  for (let tries = 0; tries < 400; tries++) {
    const x = (R(w, 14) - 7) * 0x100, z = (R(w, 14) - 7) * 0x100;
    if (d.p.some((P) => free(P) && Math.abs(x - P.x) <= 0x200 && Math.abs(z - P.z) < 0x200)) continue;
    if (liveKegs(d).some((k) => k.x === x && k.z === z)) continue;
    if (poolFull(d)) return;
    add<KPick>(d, { t: 4, id: d.nid++, x, z, y: 0, vy: 0, ch: R(w, 2) + 1, born: d.g });
    emit(w, 'pspawn', kkX(x), kkZ(z));
    return;
  }
}

export function kkFlamePosition(angle: number): [number, number] {
  return [(T(angle - 0x400) * 9) >> 4, (T(angle) * 9) >> 4];
}

function flameFrame(w: World, d: KKData, f: number) {
  d.fl[f] = (d.fl[f] + KK_FLAME_STEP) & 0xfff;
  const [fx, fz] = kkFlamePosition(d.fl[f]);
  for (const [ox, oz] of NB) {
    const x = fx + ox, z = fz + oz;
    if (!(x > -GRID && x < GRID && z > -GRID && z < GRID)) continue;
    const n = grid.get(cellOf(x, z));
    if (!n) continue;
    add<KSpark>(d, { t: 5, id: d.nid++, x, z, tx: 0, tz: 0, st: -13, life: 15, own: n.own, born: d.g });
    add<KSpark>(d, { t: 5, id: d.nid++, x, z, tx: 0, tz: 0, st: -13, life: 15, own: n.own, born: d.g });
    emit(w, 'ignite', kkX(x), kkZ(z), n.own);
    kill(d, n);
  }
}

/** FUN_800b7b80 */
function sparkScan(d: KKData, s: KSpark) {
  if (d.over) return;
  for (const [ox, oz] of NB) {
    const x = s.x + ox, z = s.z + oz;
    if (!(x > -GRID && x < GRID && z > -GRID && z < GRID)) continue;
    const n = grid.get(cellOf(x, z));
    if (!n) continue;
    if (s.st < 0) {
      s.st = 0; s.tx = n.x; s.tz = n.z; s.own = n.own;
      s.sc = Math.min(4096, Math.max(600, Math.trunc((n.life + 15) * 4096 / 60)));
      kill(d, n);
    } else {
      add<KSpark>(d, { t: 5, id: d.nid++, x: s.x, z: s.z, tx: n.x, tz: n.z, st: -7, life: 15, own: n.own, born: d.g });
    }
  }
}

function sparkFrame(w: World, d: KKData, s: KSpark) {
  const previousOwner = d.p[s.own];
  if (previousOwner) previousOwner.ai.burn = 2;
  if (s.st === 0) {
    if (s.x < s.tx) s.x += 20; else if (s.x > s.tx) s.x -= 20;
    if (s.z < s.tz) s.z += 20; else if (s.z > s.tz) s.z -= 20;
    if (s.tx - s.x + 0x27 >= 0 && s.tx - s.x + 0x27 < 0x4f && s.tz - s.z + 0x27 >= 0 && s.tz - s.z + 0x27 < 0x4f) { s.x = s.tx; s.z = s.tz; s.st = -7; }
  } else {
    s.life--;
    if (s.life < 1) { kill(d, s); return; }
  }
  if (s.st < 0) sparkScan(d, s);
  const own = d.p[s.own];
  if (!own) return;
  const tot = chain(w, d, s.x, s.z, s.own, own.combo, 300, 0);
  own.combo = Math.min(10, own.combo + tot);
  own.fuseOrigin = [s.x, s.z];
  own.fuse = 10;
}

function kegFrame(w: World, d: KKData, k: KKeg) {
  for (const P of d.p) {
    if (!P) continue;
    const dx = P.x - k.x, dz = P.z - k.z;
    if (dx >= -255 && dx <= 255 && dz > -0x100 && dz < 0x100) {
      const e = dist(0, 0, dx, dz) - 0x70;
      if (e < 0x70) {
        const a = atan2g(dx, dz);
        P.x += (e * T(a - 0x400)) >> 12;
        P.z += (e * T(a)) >> 12;
      }
    }
  }
  if (k.gr === 1) {
    k.sc += 1000;
    if (k.sc > 5999) { k.sc = 6000; k.gr = 0; }
  } else if (k.hit !== 0) {
    allocateEffect(d, k.x, k.z, 23);
    emit(w, 'boom', kkX(k.x), kkZ(k.z), -1, R(w, 4), k.kind);
    kill(d, k);
  }
}

function nodeFrame(d: KKData, n: KNode) {
  if (n.y !== 0 || n.vy !== 0) {
    n.vy += 12; n.y += n.vy;
    if (n.y > 0) { n.y = 0; n.vy = 0; }
  }
  n.life--;
  if (n.life === 0) kill(d, n);
}

function pickFrame(w: World, d: KKData, k: KPick) {
  k.vy += 8; k.y += k.vy;
  if (k.y >= 0) { k.vy = -0x28; k.y = -1 - 0x28; }
  for (let j = 0; j < 4; j++) {
    const P = d.p[j];
    if (!free(P)) continue;
    if (Math.abs(k.x - P.x) <= 0x100 && Math.abs(k.z - P.z) < 0x100) {
      if (!d.over) {
        P.shock = 0;
        if (k.ch >= 1 && k.ch < 3) P.shock = k.ch;
        emit(w, 'pick', kkX(k.x), kkZ(k.z), j, k.ch, -1, undefined, -k.y / KK_S);
      }
      kill(d, k);
      return;
    }
  }
}

/** fuse follower (0x1d09, FUN_800b8e10): hiss on the first spark, combo resets 10 frames after the last one */
function fuseFrame(w: World, d: KKData, i: number) {
  const P = d.p[i];
  if (!P) return;
  if (P.fuse > 0) {
    P.fuseMixOrigin = P.fuseOrigin;
    if (P.fuseP === 0) {
      P.fuseStart = d.g;
      P.fuseVariant = R(w, 4);
      const [x, z] = P.fuseOrigin ?? [P.x, P.z];
      emit(w, 'fuse', kkX(x), kkZ(z), i, P.fuseVariant);
    } else { P.fuse--; if (P.fuse < 1) P.combo = 0; }
  }
  P.fuseP = P.fuse;
}

// ---------------------------------------------------------------- one logic frame
/** FUN_8007906c collects occupied addresses before the seats run. A slot can change occupants
 * before its turn, so the queue contains addresses and resolves the current actor on dispatch. */
function collectCallbacks(d: KKData) {
  grid.clear();
  bySlot.clear();
  for (const o of d.o) {
    if (o.dead) continue;
    if (o.t === 2) grid.set(cellOf(o.x, o.z), o);
    indexSlot(d, o);
  }
  return d.pool ? Array.from(bySlot.keys()).sort((a, b) => a - b) : undefined;
}

function stepObjects(w: World, d: KKData, slots: number[] | undefined) {
  for (let i = 0; i < 4; i++) fuseFrame(w, d, i);
  kegSpawner(w, d);
  flameFrame(w, d, 0);
  flameFrame(w, d, 1);
  pickSpawner(w, d);
  const queue = slots ?? d.o.slice();
  for (const entry of queue) {
    const o = typeof entry === 'number' ? bySlot.get(entry) : entry;
    if (!o || o.dead || (!slots && o.born === d.g)) continue;
    switch (o.t) {
      case 1: kegFrame(w, d, o); break;
      case 2: nodeFrame(d, o); break;
      case 4: pickFrame(w, d, o); break;
      case 5: sparkFrame(w, d, o); break;
      case 6: if (--o.life === 0) kill(d, o); break;
    }
  }
  if (d.o.some((o) => o.dead)) d.o = d.o.filter((o) => !o.dead);
}

export function stepKegResultObjects(w: World, winnerEntered: boolean) {
  const d = w.data as KKData;
  // DAT_800bc444 is set by winner entry, not by the verdict. Draws keep their spawners.
  d.over = winnerEntered;
  dispatchSeats(w, d);
  const slots = collectCallbacks(d);
  stepObjects(w, d, slots);
  d.g++;
  w.tick++;
  // After ranking the BCD clock is settled; the HUD keeps its normal four-tick cadence.
  if (d.shown) tickPlayerTally(d.p, d.shown, w.tick % 4, 3);
}

const FIXED_SEATS = [0, 1, 2, 3];
function dispatchSeats(w: World, d: KKData): readonly number[] {
  if (!d.random) return FIXED_SEATS;
  drawDiscRandom(d.random, 2); // FUN_800155fc, before the scene update.
  return nextPlayerOrder(w.rng, d);
}

function frame(w: World, d: KKData, inputs: (InputState | null | undefined)[]) {
  const g = d.g;
  const slots = collectCallbacks(d);
  for (const i of dispatchSeats(w, d)) if (d.p[i]) playerFrame(w, d, i, inputs[i]);
  stepObjects(w, d, slots);
  if (g >= KK_INTRO_TICKS && !d.over) {
    const tick = g - KK_INTRO_TICKS + 1;
    if (d.shown ? tickPlayerTally(d.p, d.shown, tick, 3, VERSUS_CLOCK_END - 1) : g >= LEGACY_END_G) finish(w, d);
  }
  d.g++;
}

/** FUN_800ba220: rank by score (ties: lower slot first); equal top two = draw */
function finish(w: World, d: KKData) {
  const ps = d.p.filter((P): P is KP => !!P);
  const ord = ps.slice().sort((a, b) => b.score - a.score || a.slot - b.slot);
  d.over = true;
  if (ord.length > 1 && ord[0].score === ord[1].score) {
    d.winner = -1;
    for (const P of ps) P.fl |= 0x100;
  } else {
    d.winner = ord[0].slot;
    for (const P of ps) P.fl |= P === ord[0] ? 0x200 : 0x400;
  }
  emit(w, 'end', 0, 0, d.winner, 1);
}

function syncBodies(w: World, d: KKData) {
  for (const b of w.bodies) {
    if (b.kind !== 'player') continue;
    const P = d.p[b.slot];
    if (!P) continue;
    const nx = kkX(P.x), nz = kkZ(P.z);
    b.vx = (nx - b.x) * 30; b.vz = (nz - b.z) * 30;
    b.x = nx; b.z = nz; b.y = Math.max(0, -P.y / KK_S);
    b.face = Math.PI - (((P.yaw - 0x800) & 0xfff) * 2 * Math.PI) / 4096;
  }
}

// ---------------------------------------------------------------- the game
export const kegKaboom: MiniGame = {
  id: 'kegKaboom',
  name: 'Keg Kaboom',
  description: 'Link flames to kegs with gunpowder trails. Gold is worth 20, silver 10. Highest score wins.',
  controls: '{move} run. Hold {b} to lay gunpowder. {a} jump. {c} use shock wave pickup.',
  maxTime: KK_MAX_TIME,
  settlesAfterTimeout: true,

  setup(w: World, slots: SlotInfo[]) {
    const ps: (KP | null)[] = [null, null, null, null];
    const bots = slots.filter((s) => s.bot);
    const level = bots.length ? bots[bots.length - 1].level ?? 1 : 1;
    const skill = SKILL[Math.max(0, Math.min(2, level))];
    const uBot = (skill * 2 + 0x44) & 0xfffe;
    for (const s of slots) {
      const i = s.slot;
      if (i < 0 || i > 3) continue;
      const ch = KK_CHAR[(s.char ?? i * 2) % KK_CHAR.length] ?? 1;
      const [x, z, yaw] = START[i];
      const P: KP = {
        ch, bot: s.bot, slot: i, x, y: 0, z, yaw, hd: yaw, spd: 0, mv: 1, run: 1, st: 0x71, fl: 0, score: 0,
        jv: 0, jc: 0, ja: 0, jd: 0, jr: 0, pad: 0, ppad: 0, lay: 0, combo: 0, shock: 0, fuse: 0, fuseP: 0, nx: 0, nz: 0, hasN: 0,
        sl: s.bot ? Math.floor((uBot * 35) / 100) : 35, sr: s.bot ? Math.floor((uBot * 60) / 100) : 60,
        an: { id: 0x61, pc: 0, c: -1, h: 0, l: 0, d: 0, pose: 0 },
        ai: { mode: 1, tm: 1, pad: 0, tx: 0, tz: 0, ang: 0, keg: -1, pk: -1, burn: 0 },
      };
      ps[i] = P;
      addBody(w, 'player', i, kkX(x), kkZ(z), (CYLINDER[ch]?.[1] ?? 120) / KK_S, 1);
      startOpeningIdle(P);
    }
    const random = discRandomState(w.rng);
    for (let i = 0; i < 4; i++) drawDiscRandom(random, 60); // generic seat idle timers
    const updateOrders = shufflePlayerOrders(random);
    const a0 = drawDiscRandom(random, 0x1000) + KK_FLAME_STEP;
    const d: KKData = { g: 0, p: ps, o: [], fl: [a0 & 0xfff, (a0 + 0x800) & 0xfff], kt: 59, pt: 599, kn: 0, nid: 1, skill, over: false, winner: -2, shown: [0, 0, 0, 0], random, updateOrders, pool: { next: FIRST_DYNAMIC_SLOT, free: [] } };
    w.data = d;
    // Reproduce the 31 intervening RNG advances in the reference full-round load.
    for (let i = 0; i < 31; i++) drawDiscRandom(random, 2);
    dispatchSeats(w, d); // first visible scene update, already reflected in the timers and opening poses
    // the real game's intro (players locked, spawner / flames / pickup timers running)
    for (let k = 0; k < KK_INTRO_TICKS; k++) frame(w, d, []);
    w.ev.length = 0;
    syncBodies(w, d);
    for (const b of w.bodies) { b.vx = 0; b.vz = 0; }
  },

  bot() { return cpuRequest; },

  step(w, inputs) {
    const d = w.data as KKData;
    frame(w, d, inputs);
    syncBodies(w, d);
  },

  isOver(w) {
    return (w.data as KKData).over;
  },

  isDraw(w, [a, b]) { return w.data.p[a]?.score === w.data.p[b]?.score; },

  placements(w) {
    const d = w.data as KKData;
    return [0, 1, 2, 3].sort((a, b) => (d.p[b]?.score ?? 0) - (d.p[a]?.score ?? 0) || a - b);
  },
};

export { CLOCK_START as KK_CLOCK_START };
