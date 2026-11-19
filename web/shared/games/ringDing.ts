import { DISC_CHARACTER } from '../look';
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';

/**
 * RING DING (Crash Bash level id 28 in the overlay numbering, family 0x103; stage model 0621, meadow pit). Ported from the
 * decompiled overlay, see re/notes/ringDing.md for every constant and the function addresses (FUN_800b....).
 *
 * The simulation runs in PS1 integer units at 30 Hz (one tick = one game frame step) and is mirrored into world bodies:
 *   body.x = x * S, body.z = -z * S (PS1 +z points away from the camera), body.y = -y * S (PS1 y is down), S = 3.4 / 1024.
 * Angles are 4096 per turn; an entity at yaw h moves along (-sin h, -cos h); body.face = -h * 2pi / 4096.
 *
 * Rules: 90 s. Ride over a jewel to carry it, square throws it (hold it a moment for a higher arc) at the TARGET that swings
 * round the outside of the pit; a hit scores the multiplier of the floor zone you stood in when you threw (x5 / x3 / x2 / x1).
 * Without a jewel square is a barge (charge): it knocks a rival's jewel loose and sends them spinning. Highest score wins.
 *
 * world.data (RingDingData): see the interface. Bodies: 'player' (slot), 'jewel' (slot = index 0..2, m = state, cd = owner or -1).
 * Events: 'throw' (s), 'barge' (s), 'bump' (s, o, v sample 0..3), 'wallbump' (s, v), 'recoil' (s), 'step' (s, v 0/1),
 * 'jpick' (s), 'jthrow' (s, v mult), 'jbounce' (v), 'jwall', 'jclash' (v), 'jdrop' (v), 'jspawn', 'score' (s, v mult), 'gong'.
 */
export const RD_S = 3.4 / 1024;
export const RD_TICKS = 2700; // 1:30 at 30 Hz
export const RD_R = 0xb00; // floor radius (ps1 units); the wall pushes back to 0xafc / 0xafe
export const RD_TARGET_R = 2816; // target orbit radius
export const RD_TARGET_Y = -1061;

const SKILLS = [8, 16, 20]; // easy / normal / hard (table 0x800bd970; normal = 16 verified in RAM)
const BOT_SPEED = [48, 50, 52, 54, 56, 58, 60, 62, 64, 78, 82, 86, 90, 94, 98, 102]; // 0x800bdc1c, index skill >> 1
const WALK = 84; // human walk target speed (0x800bdc14)
const CARRY = 106; // target speed while carrying (0x800bdc18)
const STARTS: [number, number][] = [[-1280, -1740], [-1280, 1740], [972, 1740], [972, -1740]];
const JEWEL0: [number, number, number][] = [[1024, -64, 0], [-1024, -64, 0], [0, -64, 512]];
const EVADE = [0, 1024, 2048, 3072, 1536, 2560, 3584, 512]; // 0x800bdb58
const RAY = 1624; // 0x800bdb50
const RIVAL_R = 250; // 0x800bdb78

/** look.ts CHARACTERS index -> game character id 1..8 (1 crash, 2 coco, 3 cortex, 4 brio, 5 tiny, 6 rilla, 7 dingodile, 8 koala). */
export const RD_CHAR_ID = DISC_CHARACTER;

export const ST_IDLE = 99, ST_RUN = 100, ST_THROW = 101, ST_BARGE = 102, ST_RECOIL = 103;

// ---------------------------------------------------------------- exe math replicas
const COS = new Int16Array(4096);
for (let i = 0; i < 4096; i++) COS[i] = Math.round(4096 * Math.cos((i * 2 * Math.PI) / 4096));
const AT = new Int16Array(2049);
for (let i = 0; i <= 2048; i++) AT[i] = Math.round((Math.atan(i / 2048) * 4096) / (2 * Math.PI));
export const T = (a: number) => COS[a & 0xfff];
export const SIN = (a: number) => COS[(a - 0x400) & 0xfff];
const q = (n: number, m: number) => Math.trunc(n / m);
/** FUN_8001463c: angle of (x, z), 0 = +z, 0x400 = +x */
export function at2(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  if (a < 0) {
    const n = -a;
    if (b >= 0) return n < b ? 0x1000 - AT[q(n * 0x800, b)] : AT[q(b * 0x800, n)] + 0xc00;
    const m = -b;
    return n < m ? AT[q(n * 0x800, m)] + 0x800 : 0xc00 - AT[q(m * 0x800, n)];
  }
  if (b < 0) {
    const m = -b;
    return a < m ? 0x800 - AT[q(a * 0x800, m)] : AT[q(m * 0x800, a)] + 0x400;
  }
  return b <= a ? 0x400 - AT[q(b * 0x800, a)] : AT[q(a * 0x800, b)];
}
/** FUN_800154a0: signed shortest turn from a to b */
const adiff = (a: number, b: number) => { const v = (b - a) & 0xfff; return v > 0x800 ? v - 0x1000 : v; };
/** FUN_8003233c: hyperbolic CORDIC square root of a value normalised to ~2^8..2^10 (as written by the original, bit exact) */
function cordicSqrt(x: number): number {
  const A = new Int32Array(7), B = new Int32Array(7);
  A[0] = x + 0x5d50ad; B[0] = x - 0x5d50ad;
  for (let i = 1; i < 7; i++) {
    const a = A[i - 1], b = B[i - 1];
    if (i === 4) {
      let a3 = a, b3 = b;
      if (b >= 0) { a3 = a - (b >> 4); b3 = b - (a >> 4); } else { a3 = a + (b >> 4); b3 = b + (a >> 4); }
      A[3] = a3; B[3] = b3;
      if (b3 < 0) { A[4] = a3 + (b3 >> 4); B[4] = b3 + (a3 >> 4); } else { A[4] = a3 - (b3 >> 4); B[4] = b3 - (a3 >> 4); }
    } else if (b >= 0) { A[i] = a - (b >> i); B[i] = b - (a >> i); } else { A[i] = a + (b >> i); B[i] = b + (a >> i); }
  }
  return A[6];
}
/** FUN_80032490(n) >> 6: the original's table-free sqrt (sqrt(n) in 6-bit fixed point, slightly inexact) */
const sq = (n: number): number => {
  n |= 0;
  if (n === 0) return 0;
  const v = 8 - (n > 0 ? Math.clz32(n) : 0);
  let s: number, a: number;
  if (v < 0) { s = (v >> 1) + 1; a = n << (-(s * 2) & 31); } else { s = v >> 1; a = n >> (s * 2); }
  s -= 6;
  const r = cordicSqrt(a);
  return (s < 0 ? r >> -s : r << s) >> 6;
};
const sh12 = (a: number, b: number) => Math.floor((a * b) / 4096);
const ri = (w: World, n: number) => Math.floor(rand(w) * n);
const i32 = (n: number) => n | 0;

/**
 * Scoring zones (FUN_8008c4c8): intersections of half planes (x0, z0, angle) per group; group 0 = the whole floor, 1 = x5, 2 = x3, 3 = x2.
 * A point is inside when ((x - x0) * T(-a) >> 12) - ((z - z0) * T(-a - 0x400) >> 12) >= 0 for every plane.
 */
const ZONES: number[][] = [
  [-169, -2760, 879, -1131, -2545, 683, -1595, -2279, 536, -2194, -1725, 400, -2654, -1076, 156, -2834, -342, 4071, -2804, 482, 3879, -2515, 1322, 3627, -1976, 1938, 3543, -1387, 2458, 3348, -930, 2664, 3168, -382, 2746, 3100, 350, 2778, 2912, 1068, 2599, 2754, 1561, 2338, 2592, 2265, 1701, 2374, 2604, 1083, 2199, 2762, 417, 2083, 2804, -348, 1866, 2605, -1048, 1794, 2454, -1418, 1572, 2023, -1902, 1553, 1516, -2440, 1251, 785, -2707, 1059],
  [-2480, -6742, 3870, -1411, -3782, 3916, -1068, -2568, 3982, -1000, -2182, 3608, -704, -1864, 3275, 0, -1636, 2862, 681, -1864, 2431, 909, -2205, 2281, 1045, -2568, 2262, 1321, -3373, 2292, 1523, -3887, 2290, 2639, -6742, 1022],
  [-2912, -4719, 3923, -2139, -1872, 3648, -1386, -954, 3380, -363, -431, 3042, 343, -463, 2803, 1363, -909, 2574, 1886, -1409, 2619, 2296, -1750, 2207, 3071, -4856, 1008],
  [-3503, -3685, 3956, -2775, -338, 3610, -2296, 181, 3459, -1454, 750, 3203, -454, 954, 3041, 522, 909, 2916, 1454, 681, 2707, 2321, 138, 2556, 2818, -363, 2226, 3776, -3776, 1014],
];
export function rdInside(g: number, x: number, z: number): boolean {
  const Z = ZONES[g];
  for (let i = 0; i < Z.length; i += 3) {
    const a = Z[i + 2];
    if (sh12(x - Z[i], T(-a)) - sh12(z - Z[i + 1], T(-a - 0x400)) < 0) return false;
  }
  return true;
}
/** Zone index 1..3 (smallest group containing the point) or -1 (FUN_800bcce8) */
export function rdZone(x: number, z: number): number {
  let r = -1;
  for (let g = 3; g > 0; g--) if (rdInside(g, x, z)) r = g;
  return r;
}
export const rdMult = (x: number, z: number) => { const g = rdZone(x, z); return g === 1 ? 5 : g === 2 ? 3 : g === 3 ? 2 : 1; };


// ---------------------------------------------------------------- data
export interface RDAi {
  /** handler: 0 idle, 1 jewel hunt (b3a38), 2 chase carrier (b3c1c), 3 direct throw (b3d90), 4 to the x5 spot (b4b14), 5 in zone (b3fdc), 6 evade (b4d6c) */
  h: number;
  jw: number; n30: number; mode: number; ang: number; t40: number; rv: number;
  /** pad angle computed by the AI (comp +0x2a) */
  pa: number;
  /** pad accumulator (comp +0x2c) and the current / target point (comp +0x10.. / +0x1c..) */
  acc: number; cx: number; cz: number; tx: number; tz: number;
}
export interface RDPlayer {
  bid: number; id: number; bot: boolean; skill: number;
  x: number; z: number; yaw: number; hd: number;
  vx: number; vz: number; tvx: number; tvz: number; ac: number; dc: number;
  st: number; rt: number; tt: number; cd: number;
  /** carried jewel index or -1 */
  carry: number;
  /** run animation counter (footsteps), control lock (ticks) */
  sc: number; lock: number;
  /** pad word (0x10 up(+z) 0x20 right 0x40 down 0x80 left, 0x8000 square held) and the pad angle word */
  pad: number; ang: number;
  face: number;
  ai: RDAi;
}
export interface RDJewel {
  bid: number;
  /** 0 rest, 1 carried, 2 throw init, 3 flight, 4 knocked loose, 5 knock init, 6 hidden, 7 appear */
  st: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number;
  g: number; fl: number; b: number; hold: number; mult: number; owner: number; cd: number;
}
export interface RingDingData {
  t: number;
  /** target: phase (0xc / tick), swing angle th (-0x300..0x300), placed yaw / roll / position, gong cooldown */
  phase: number; th: number; tyaw: number; troll: number; tx: number; tz: number; gcd: number;
  score: number[];
  /** per slot mirrors for the client: state, carried jewel (-1 none), barge cooldown */
  st: number[]; carry: number[]; cd: number[];
  P: (RDPlayer | null)[]; J: RDJewel[];
  winner: number; draw: boolean;
  /** 16 shuffled player update orders (FUN_80085650); one is picked per tick (FUN_80015590(16)) */
  ord: number[][];
}

const players = (d: RingDingData) => d.P.filter((p): p is RDPlayer => !!p);
const E = (w: World, k: string, px: number, pz: number, s = -1, v = 1, o = -1) => emit(w, k, px * RD_S, -pz * RD_S, s, v, o);

/** pad bits -> pad angle (FUN_800b3538) */
export function rdPadAngle(b: number): number {
  let a = 0;
  if (b & 0x80) a = 0xc00;
  if (b & 0x20) a = 0x400;
  if (b & 0x10) a = 0;
  if (b & 0x40) a = 0x800;
  if ((b & 0x90) === 0x90) a = 0xe00;
  if ((b & 0xc0) === 0xc0) a = 0xa00;
  if ((b & 0x30) === 0x30) a = 0x200;
  if ((b & 0x60) === 0x60) a = 0x600;
  return a;
}
function padOf(inp: InputState): number {
  let b = 0;
  if (inp.y < -0.4) b |= 0x10;
  if (inp.y > 0.4) b |= 0x40;
  if (inp.x < -0.4) b |= 0x80;
  if (inp.x > 0.4) b |= 0x20;
  if (inp.a || inp.b) b |= 0x8000;
  return b;
}

// ---------------------------------------------------------------- target (FUN_800b7aa0) and its collision box (FUN_800b8a40)
/** local -> world matrix for angles (0, b, c) (FUN_8003278c with a = 0), row major */
function matFwd(b: number, c: number): number[] {
  const sB = SIN(b), cB = T(b), sC = SIN(c), cC = T(c);
  const t = sh12(cC, -sB), u = sh12(sC, -sB);
  return [sh12(cC, cB), -sh12(sC, cB), sB, sC, cC, 0, t, -u, cB];
}
const mulv = (M: number[], x: number, y: number, z: number): [number, number, number] => [
  Math.floor((M[0] * x + M[1] * y + M[2] * z) / 4096),
  Math.floor((M[3] * x + M[4] * y + M[5] * z) / 4096),
  Math.floor((M[6] * x + M[7] * y + M[8] * z) / 4096),
];
/** box from the stage collision data (RAM 0x801c2088): x -886..900, z -3..196, y top -893 (all in the target's local frame) */
const BOX = { x0: -886, x1: 900, z0: -3, z1: 196, ymax: -893 };
/** Point vs the target box inflated by 384; pushes the point out of it and returns true on contact. */
function targetBox(d: RingDingData, p: { x: number; y: number; z: number }): boolean {
  const dx = p.x - d.tx, ly = p.y - RD_TARGET_Y, dz = p.z - d.tz;
  const C = T(d.tyaw), S = SIN(d.tyaw);
  // local = Ry(-th) * (p - target): rows (cos, 0, -sin), (0, 1, 0), (sin, 0, cos)
  const x = Math.floor((C * dx - S * dz) / 4096), z = Math.floor((S * dx + C * dz) / 4096);
  let f = 0;
  if (x < BOX.x0) f |= 2;
  if (ly < BOX.ymax) f |= 0x10;
  if (z < BOX.z0) f |= 4;
  if (BOX.x1 < x) f |= 1;
  if (BOX.z1 < z) f |= 8;
  let dist = 0x7ffffff, nx = 0, ny = 0, nz = 0;
  switch (f) {
    case 1: dist = Math.abs(x - BOX.x1); nx = 4096; break;
    case 2: dist = Math.abs(x - BOX.x0); nx = -4096; break;
    case 4: dist = Math.abs(z - BOX.z0); nz = -4096; break;
    case 8: dist = Math.abs(z - BOX.z1); nz = 4096; break;
    case 5: dist = sq((x - BOX.x1) ** 2 + (z - BOX.z0) ** 2); nx = 4096; nz = -4096; break;
    case 6: dist = sq((x - BOX.x0) ** 2 + (z - BOX.z0) ** 2); nx = -4096; nz = -4096; break;
    case 9: dist = sq((x - BOX.x1) ** 2 + (z - BOX.z1) ** 2); nx = 4096; nz = 4096; break;
    case 10: dist = sq((x - BOX.x0) ** 2 + (z - BOX.z1) ** 2); nx = -4096; nz = 4096; break;
    case 0x10: case 0x14: case 0x15: case 0x16: case 0x18: case 0x19: case 0x1a: dist = Math.abs(ly - BOX.ymax); ny = -4096; break;
    default: break;
  }
  const R = 0x180;
  if (dist >= R) return false;
  const k = Math.abs(R - dist) + 8;
  const [wx, wy, wz] = mulv(matFwd(d.tyaw, d.troll), nx, ny, nz);
  p.x += Math.floor((k * wx) / 4096);
  p.y += Math.floor((k * wy) / 4096);
  p.z += Math.floor((k * wz) / 4096);
  return true;
}

/** reflect a jewel's heading (its yaw) at a plane with unit normal n = (nx, nz) (4096 scale); sets yaw and velocity like FUN_800b7aa0 / FUN_800bb3ec */
function reflect(j: RDJewel, nx: number, nz: number) {
  const v = sq(j.vx * j.vx + j.vz * j.vz);
  const dx = -SIN(j.yaw), dz = -T(j.yaw);
  const dot = sh12(dx, nx) + sh12(dz, nz);
  const rx = dx - Math.floor((dot * nx) / 2048), rz = dz - Math.floor((dot * nz) / 2048);
  const a = at2(rx, rz);
  j.yaw = (a + 0x800) & 0xfff;
  j.vx = -Math.floor((v * T(a + 0x400)) / 4096);
  j.vz = -Math.floor((v * T(a + 0x800)) / 4096);
}

function targetTick(w: World, d: RingDingData) {
  // gong cooldown (0, -1, 0, -1 ... at rest, exactly like the original compare-then-decrement)
  const neg = d.gcd < 0;
  d.gcd--;
  if (neg) d.gcd = 0;
  const th = d.th;
  d.tx = Math.floor((SIN(th) * 11) / 16);
  d.tz = Math.floor((T(th) * 11) / 16);
  d.tyaw = th;
  d.troll = th << 1;
  d.th = Math.floor((SIN(d.phase) * 3) / 16) & 0xfff;
  if (d.th > 0x2f7 && d.gcd === 0 && d.th < 0x401) { E(w, 'gong', d.tx, d.tz); d.gcd = 0x5a; }
  if (d.th < 0xd09 && d.gcd === 0 && d.th > 0x3ff) { E(w, 'gong', d.tx, d.tz); d.gcd = 0x5a; }
  d.phase = (d.phase + 0xc) & 0xfff;
  for (const j of d.J) {
    if (j.st !== 3 || j.b >= 2 || j.cd >= 1) continue;
    if (!targetBox(d, j)) continue;
    j.cd = 0x14;
    // reflect about the target's inward normal (sin(yaw + 0x800), cos(yaw + 0x800))
    const a0 = (d.tyaw + 0x800) & 0xfff;
    reflect(j, SIN(a0), T(a0));
    j.x += j.vx; j.z += j.vz; // the target code moves the jewel once more (the jewel update then moves it again)
    const o = d.P[j.owner];
    if (o) {
      d.score[j.owner] += j.mult;
      E(w, 'score', d.tx, d.tz, j.owner, j.mult);
    }
  }
}

// ---------------------------------------------------------------- bot AI (FUN_800b5424 and its handlers)
const H_IDLE = 0, H_JEWEL = 1, H_CHASE = 2, H_DIRECT = 3, H_TOX5 = 4, H_INZONE = 5, H_EVADE = 6;

/** FUN_800b4268: forward ray (rx, rz) against a circle (cx, cz, r) in 12 bit fixed point (int32 wrap like the MIPS code) */
function rayCircle(rx: number, rz: number, cx: number, cz: number, r: number): boolean {
  const a = (i32(Math.imul(rx, rx) + Math.imul(rz, rz))) >> 12;
  const b = (i32(Math.imul(rx, cx) + Math.imul(rz, cz)) * 2) >> 12;
  const c = (i32(Math.imul(cx, cx) + Math.imul(cz, cz) - r * r)) >> 12;
  const disc = i32(Math.imul(b, b) + Math.imul(Math.imul(a, c), -4));
  if (disc < 0) return false;
  const s = sq(disc);
  const t1 = q((-b + s) * 256, a * 2), t2 = q((-b - s) * 256, a * 2);
  if (t1 < 0 && t2 < 0) return false;
  if (t1 < t2) { if (t1 > -1) return t1 < 0x100; } else if (t2 < 1) return t1 < 0x100;
  if (t2 < 0x100) return true;
  return t1 < 0x100;
}
/** FUN_800b4474: the same test with 8 bit scaling and no length limit (a ray, not a segment) */
function rayHits(rx: number, rz: number, cx: number, cz: number, r: number): boolean {
  const a = (i32(Math.imul(rx, rx) + Math.imul(rz, rz))) >> 8;
  const b = (i32(Math.imul(rx, cx) + Math.imul(rz, cz)) * 2) >> 8;
  const c = (i32(Math.imul(cx, cx) + Math.imul(cz, cz) - r * r)) >> 8;
  const disc = i32(Math.imul(b, b) + Math.imul(Math.imul(a, c), -4));
  if (disc < 0) return false;
  const s = sq(disc);
  const t1 = q((-b + s) * 256, a * 2), t2 = q((-b - s) * 256, a * 2);
  return !(t1 < 0 && t2 < 0);
}

/** FUN_800b33d8: weighted random pick of the rival to go for (all weights equal here) */
function pickVictim(w: World, d: RingDingData, me: number): number {
  const r1 = ri(w, 4), r2 = ri(w, 0x1000);
  for (let k = r1; k < r1 + 4; k++) {
    const u = k & 3;
    if (u === me) continue;
    let sc = 0;
    if (d.P[u]) {
      let sum = 0;
      for (let v = 0; v < 4; v++) if (v !== me && d.P[v]) sum += d.P[v]!.skill * 0x80;
      if (sum !== 0) sc = q(d.P[u]!.skill << 19, sum);
    } else sc = -1;
    if (r2 < sc) return u;
  }
  return -1;
}
/** FUN_800b49ac: is a barge at the picked nearest rival worth it right now */
function bargeChance(w: World, d: RingDingData, me: number): boolean {
  const p = d.P[me]!;
  let best = 0x7ffffff, bi = -1;
  for (let i = 0; i < 4; i++) {
    const o = d.P[i];
    if (i === me || !o) continue;
    const dd = (o.x - p.x) ** 2 + (o.z - p.z) ** 2;
    if (dd < best) { best = dd; bi = i; }
  }
  if (bi === -1) return false;
  if (pickVictim(w, d, me) !== bi) return false;
  if (best < 0x100000) {
    const o = d.P[bi]!;
    const rx = Math.floor((RAY * SIN(p.yaw)) / 4096), rz = Math.floor((RAY * T(p.yaw)) / 4096);
    return rayCircle(rx, rz, o.x - p.x, o.z - p.z, 200);
  }
  return false;
}
/** FUN_800b3538: move the stick towards the target point (strict comparisons) */
function aiPad(p: RDPlayer) {
  const a = p.ai;
  let b = 0;
  if (a.tx < a.cx) b |= 0x80;
  if (a.cx < a.tx) b |= 0x20;
  if (a.tz < a.cz) b |= 0x40;
  if (a.cz < a.tz) b |= 0x10;
  a.acc |= b;
  if (p.lock === 0) p.pad = a.acc;
  a.pa = rdPadAngle(a.acc);
  if (p.lock === 0) p.ang = a.pa;
}
const jfree = (j: RDJewel) => j.st === 0 || j.st === 3 || j.st === 4;
function nearestFree(w: World, d: RingDingData, p: RDPlayer): number {
  let best = 0x7fffffff, bi = -1;
  const s = ri(w, 3);
  for (let k = s; k < s + 3; k++) {
    const i = k > 2 ? k - 3 : k, j = d.J[i];
    if (j && jfree(j)) {
      const dd = (j.x - p.x) ** 2 + (j.z - p.z) ** 2;
      if (dd < best) { best = dd; bi = i; }
    }
  }
  return bi;
}
function nearestCarried(w: World, d: RingDingData, me: number): number {
  const p = d.P[me]!;
  let best = 0x7fffffff, bi = -1;
  const s = ri(w, 3);
  for (let k = s; k < s + 3; k++) {
    const i = k > 2 ? k - 3 : k, j = d.J[i];
    if (j && j.st === 1 && pickVictim(w, d, me) === j.owner) {
      const dd = (j.x - p.x) ** 2 + (j.z - p.z) ** 2;
      if (dd < best) { best = dd; bi = i; }
    }
  }
  return bi;
}
const aimsAtTarget = (d: RingDingData, p: RDPlayer) => {
  const rx = Math.floor((RAY * 4 * SIN(p.yaw)) / 4096), rz = Math.floor((RAY * 4 * T(p.yaw)) / 4096);
  return rayCircle(rx, rz, d.tx - p.x, d.tz - p.z, 0x300);
};

function aiTick(w: World, d: RingDingData, p: RDPlayer, me: number) {
  const a = p.ai;
  a.acc = 0;
  if (a.h !== H_DIRECT) {
    if (p.carry >= 0) {
      if (a.mode === 0) {
        let m = 2;
        if (ri(w, 0x1000) > 0x7ff) { a.t40 = 0x3c; m = 4; }
        a.mode = m;
      }
      if (a.mode === 2) a.h = H_TOX5;
      if (a.mode === 1) a.h = H_DIRECT;
      if (a.mode === 4) a.h = H_EVADE;
      if (a.mode === 3) a.h = H_INZONE;
    }
  }
  if (a.h === H_IDLE) {
    a.mode = 0;
    let j = nearestFree(w, d, p);
    if (j !== -1) { a.jw = j; a.h = H_JEWEL; }
    j = nearestCarried(w, d, me);
    if (j !== -1) { a.jw = j; a.h = H_CHASE; }
  }
  const toIdle = () => { a.jw = -1; a.h = H_IDLE; };
  const setMe = () => { a.cx = p.x; a.cz = p.z; };
  switch (a.h) {
    case H_JEWEL: {
      const j = nearestFree(w, d, p);
      if (j !== -1) a.jw = j;
      if (!(a.jw >= 0 && jfree(d.J[a.jw]))) {
        const k = nearestFree(w, d, p);
        if (k === -1) { toIdle(); break; }
        a.jw = k;
      }
      if (bargeChance(w, d, me)) a.acc |= 0x8000;
      setMe(); a.tx = d.J[a.jw].x; a.tz = d.J[a.jw].z;
      aiPad(p);
      break;
    }
    case H_CHASE: {
      const j = a.jw >= 0 ? d.J[a.jw] : null;
      if (j && j.st === 1) {
        setMe(); a.tx = j.x; a.tz = j.z;
        if (bargeChance(w, d, me)) a.acc |= 0x8000;
        p.pad = a.acc;
        aiPad(p);
      } else toIdle();
      break;
    }
    case H_DIRECT: {
      if (p.carry < 0) { toIdle(); break; }
      if (!bargeChance(w, d, me)) {
        setMe(); a.tx = d.tx; a.tz = d.tz;
        aiPad(p);
        if (aimsAtTarget(d, p)) { a.acc |= 0x8000; p.pad = a.acc; a.jw = -1; a.n30 = 8; a.h = H_IDLE; a.mode = 0; }
      } else { a.t40 = ri(w, 15) + 0x3c; a.mode = 4; }
      break;
    }
    case H_TOX5: {
      if (!bargeChance(w, d, me)) {
        if (p.carry < 0) { toIdle(); break; }
        setMe(); a.tx = 0; a.tz = -0xb00;
        aiPad(p);
        const dx = a.cx - a.tx, dz = a.cz - a.tz;
        if (dx * dx + dz * dz > 0x3ffff) break;
        a.mode = 3;
      } else { a.t40 = 0x5a; a.mode = 4; }
      break;
    }
    case H_INZONE: {
      if (p.carry < 0) { toIdle(); break; }
      if (rdZone(p.x, p.z) === 1) {
        setMe(); a.tx = d.tx; a.tz = d.tz;
        const c = a.n30;
        a.n30 = c - 1;
        if (c > 0) aiPad(p);
        if (a.n30 < -2) a.n30 = 8;
        if (aimsAtTarget(d, p)) { a.acc |= 0x8000; p.pad = a.acc; a.jw = -1; a.n30 = 8; a.h = H_IDLE; a.mode = 0; }
      } else { a.t40 = 0x3c; a.mode = 4; a.h = H_EVADE; }
      break;
    }
    case H_EVADE: {
      if (p.carry < 0) { toIdle(); break; }
      a.t40--;
      let rv = 0, best = 0x7fffffff;
      for (let i = 0; i < 4; i++) {
        const o = d.P[i];
        if (i === me || !o) continue;
        const dd = (o.x - p.x) ** 2 + (o.z - p.z) ** 2;
        if (dd < best) { best = dd; rv = i; }
      }
      a.rv = rv;
      const R = d.P[rv]!;
      p.hd = at2(p.x - R.x, p.z - R.z) & 0xfff;
      const cx = R.x - p.x, cz = R.z - p.z;
      if ((R.x - p.x) ** 2 + (R.z - p.z) ** 2 < 0x283e40) {
        const r8 = ri(w, 8);
        const ray = (ang: number): [number, number] => [Math.floor((RAY * SIN(ang)) / 4096), Math.floor((RAY * T(ang)) / 4096)];
        let found = false;
        const [rx, rz] = ray(a.ang);
        if (!rayHits(rx, rz, cx, cz, RIVAL_R)) {
          let other = false;
          for (let i = 0; i < 4; i++) {
            const o = d.P[i];
            if (i === me || i === rv || !o) continue;
            if (rayHits(rx, rz, o.x - p.x, o.z - p.z, RIVAL_R)) other = true;
          }
          if (!other && rdInside(0, p.x - rx, p.z - rz)) { found = true; setMe(); a.tx = p.x - rx; a.tz = p.z - rz; aiPad(p); }
        }
        if (!found) {
          for (let u = r8; u < r8 + 8; u++) {
            const ang = EVADE[u & 7];
            const [ex, ez] = ray(ang);
            if (rayHits(ex, ez, cx, cz, RIVAL_R)) continue;
            let bad = false;
            for (let i = 0; i < 4; i++) {
              const o = d.P[i];
              if (i === me || i === rv || !o) continue;
              if (rayHits(ex, ez, o.x - p.x, o.z - p.z, RIVAL_R)) bad = true;
            }
            if (!bad && rdInside(0, p.x - ex, p.z - ez)) { setMe(); a.tx = p.x - ex; a.tz = p.z - ez; aiPad(p); a.ang = ang; break; }
          }
        }
        if (a.t40 > 0) return;
      }
      a.h = H_DIRECT; a.mode = 1;
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- players
function setState(w: World, d: RingDingData, p: RDPlayer, s: number, st: number) {
  p.st = st;
  switch (st) {
    case ST_IDLE: p.ac = p.dc = 9; break;
    case ST_THROW: p.tt = 0; E(w, 'throw', p.x, p.z, s); break;
    case ST_BARGE:
      p.ac = 10; p.dc = 6;
      p.hd = p.yaw;
      p.vx = p.tvx = Math.floor((T(p.yaw + 0x400) * 0x59) / 2048);
      p.vz = p.tvz = Math.floor((T(p.yaw + 0x800) * 0x59) / 2048);
      E(w, 'barge', p.x, p.z, s);
      break;
    case ST_RECOIL:
      p.tvx = p.tvz = 0; p.ac = p.dc = 9; p.rt = 7; p.carry = -1;
      E(w, 'recoil', p.x, p.z, s);
      break;
    default: break;
  }
  void d;
}

/** FUN_800ba960: bump against the other riders; barges send the victim spinning */
function collide(w: World, d: RingDingData, p: RDPlayer, s: number) {
  for (let u = 0; u < 4; u++) {
    const o = d.P[u];
    if (u === s || !o) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = sq(dx * dx + dz * dz);
    if (dist >= 0x19c) continue;
    if (p.vx * p.vx + p.vz * p.vz > 0x1000) E(w, 'bump', p.x, p.z, s, ri(w, 4), u);
    ri(w, 4);
    const a = at2(dx, dz);
    [p.vx, o.vx] = [o.vx, p.vx];
    [p.vz, o.vz] = [o.vz, p.vz];
    let os = o.st;
    if (p.st !== ST_RECOIL) {
      if (os === ST_BARGE) {
        if (p.carry >= 0 && d.J[p.carry].st === 1) d.J[p.carry].st = 5;
        setState(w, d, p, s, ST_RECOIL);
        setState(w, d, o, u, ST_IDLE);
        E(w, 'bargehit', p.x, p.z, s, 1, u);
        os = o.st;
      }
    }
    if (os !== ST_RECOIL && p.st === ST_BARGE) {
      if (o.carry >= 0 && d.J[o.carry].st === 1) d.J[o.carry].st = 5;
      setState(w, d, o, u, ST_RECOIL);
      setState(w, d, p, s, ST_IDLE);
      E(w, 'bargehit', o.x, o.z, u, 1, s);
    }
    const k = 0x19e - dist;
    p.x -= Math.floor((k * T((a & 0xfff) - 0x400)) / 4096);
    p.z -= Math.floor((k * T(a & 0xfff)) / 4096);
  }
}

/** FUN_800ba810: square pressed: throw the carried jewel, or barge */
function press(w: World, d: RingDingData, p: RDPlayer, s: number) {
  if (p.carry < 0) {
    if (p.cd > 0) return;
    if (p.pad & 0x8000) { p.cd = 0x1e; setState(w, d, p, s, ST_BARGE); }
  } else {
    const j = d.J[p.carry];
    if (!j || j.owner !== s) return;
    if (p.pad & 0x8000) { setState(w, d, p, s, ST_THROW); j.st = 2; p.carry = -1; }
  }
}

/** Test hook: when `pads` is set the step uses these pad words (and no AI) so recorded real-game traces can be replayed. */
export const rdTest: { pads: number[] | null; order: number[] | null } = { pads: null, order: null };

function playerTick(w: World, d: RingDingData, p: RDPlayer, s: number) {
  if (p.lock > 0) p.lock--;
  if (rdTest.pads) { p.pad = rdTest.pads[s]; p.ang = rdPadAngle(p.pad); } else if (p.bot) aiTick(w, d, p, s);
  // FUN_800b9930: pad -> heading and target velocity
  if (p.lock !== 0) p.pad = 0;
  p.tvx = 0; p.tvz = 0;
  if (p.st !== ST_BARGE && (p.pad & 0xf0) !== 0) {
    p.hd = (p.ang + 0x800) & 0xfff;
    const spd = p.carry >= 0 ? CARRY : p.bot ? BOT_SPEED[p.skill >> 1] : WALK;
    p.tvx = Math.floor((spd * T(p.hd + 0x400)) / 4096);
    p.tvz = Math.floor((spd * T(p.hd + 0x800)) / 4096);
  }
  if (p.st === ST_THROW) { p.tvx = 0; p.tvz = 0; }
  // state handler
  switch (p.st) {
    case ST_IDLE:
      collide(w, d, p, s);
      if (p.pad & 0xf0) p.st = ST_RUN;
      press(w, d, p, s);
      break;
    case ST_RUN:
      p.sc++;
      if (p.sc === 6) E(w, 'step', p.x, p.z, s, 0);
      if (p.sc === 0x13) E(w, 'step', p.x, p.z, s, 1);
      if (p.sc > 0x19) p.sc = 0;
      collide(w, d, p, s);
      if (!(p.pad & 0xf0)) setState(w, d, p, s, ST_IDLE);
      press(w, d, p, s);
      break;
    case ST_THROW:
      collide(w, d, p, s);
      if (++p.tt >= 15) setState(w, d, p, s, ST_IDLE);
      break;
    case ST_BARGE:
      collide(w, d, p, s);
      if (sq(p.vx * p.vx + p.vz * p.vz) < 0x20 && (p.st as number) !== ST_IDLE) setState(w, d, p, s, ST_IDLE);
      break;
    case ST_RECOIL: {
      p.yaw = (p.yaw + 0x80) & 0xfff;
      collide(w, d, p, s);
      p.lock = 2; p.pad = 0;
      const old = p.rt--;
      if (old < 0) setState(w, d, p, s, ST_IDLE);
      break;
    }
    default: break;
  }
  // FUN_800b9778: turn, accelerate, move, wall
  if (p.lock === 0) p.yaw = (p.yaw + (adiff(p.yaw, p.hd) >> 2)) & 0xfff;
  if (p.vx !== p.tvx) {
    const k = p.tvx === 0 ? p.dc : p.ac;
    if (p.vx < p.tvx) { p.vx += k; if (p.tvx < p.vx) p.vx = p.tvx; } else { p.vx -= k; if (p.vx < p.tvx) p.vx = p.tvx; }
  }
  if (p.vz !== p.tvz) {
    const k = p.tvz === 0 ? p.dc : p.ac;
    if (p.vz < p.tvz) { p.vz += k; if (p.tvz < p.vz) p.vz = p.tvz; } else { p.vz -= k; if (p.vz < p.tvz) p.vz = p.tvz; }
  }
  p.x += p.vx; p.z += p.vz;
  const r = sq(p.x * p.x + p.z * p.z);
  if (r > 0xb00) {
    const a = at2(p.x, p.z) & 0xfff;
    const k = r - 0xafe;
    p.x -= Math.floor((k * T(a - 0x400)) / 4096);
    p.z -= Math.floor((k * T(a)) / 4096);
    if (p.vx * p.vx + p.vz * p.vz > 0x1000 && p.st === ST_BARGE) E(w, 'wallbump', p.x, p.z, s, ri(w, 4));
    if (a !== 0 && p.st === ST_BARGE) { p.vx = p.vz = p.tvx = p.tvz = 0; }
  }
}

// ---------------------------------------------------------------- jewels (FUN_800bb3ec)
function tryPickup(w: World, d: RingDingData, j: RDJewel, jj: number): boolean {
  if (j.st === 1) return false;
  for (let i = 0; i < 4; i++) {
    const p = d.P[i];
    if (!p || p.carry >= 0 || p.st === ST_THROW) continue;
    if (Math.abs(j.y) > 0x200 || !jfree(j)) continue;
    const dx = p.x - j.x, dz = p.z - j.z;
    if (dx * dx + dz * dz >= 0x40000) continue;
    j.owner = i; p.carry = jj;
    return true;
  }
  void w;
  return false;
}
function jewelBounce(w: World, j: RDJewel): boolean {
  // floor at j.fl (0): clamp, halve everything, 5th bounce settles
  if (j.fl < j.y) {
    j.y -= Math.abs(j.y - j.fl);
    j.vy = -j.vy >> 1;
    j.vx >>= 1; j.vz >>= 1;
    j.b++;
    E(w, 'jbounce', j.x, j.z, -1, ri(w, 4));
    if (j.b > 4) { j.b = 0; j.st = 0; j.vx = 0; j.vz = 0; j.owner = 5; return true; }
  }
  return false;
}
function jewelTick(w: World, d: RingDingData, j: RDJewel, jj: number) {
  if (j.cd > 0) j.cd--;
  let skipWall = false;
  const pick = () => {
    if (tryPickup(w, d, j, jj)) {
      j.st = 1;
      E(w, 'jpick', j.x, j.z, j.owner);
      return true;
    }
    return false;
  };
  switch (j.st) {
    case 0: {
      j.yaw = (j.yaw + 0x20) & 0xfff;
      for (let u = 0; u < 3; u++) {
        const o = d.J[u];
        if (o === j || o.st === 6 || (j.st as number) === 6) continue;
        if (Math.abs(j.y - o.y) >= 0x200) continue;
        const dx = j.x - o.x, dz = j.z - o.z;
        const dist = sq(dx * dx + dz * dz);
        if (dist >= 0x200) continue;
        const a = at2(dx, dz);
        const k = 0x208 - dist;
        j.x += Math.floor((k * T((a & 0xfff) - 0x400)) / 4096);
        j.z += Math.floor((k * T(a & 0xfff)) / 4096);
        E(w, 'jclash', j.x, j.z, -1, ri(w, 4));
        [j.vx, o.vx] = [o.vx, j.vx];
        [j.vz, o.vz] = [o.vz, j.vz];
      }
      j.x += j.vx; j.z += j.vz;
      if (j.vx < 0) { j.vx = Math.min(j.vx + 2, 0); } else if (j.vx > 0) j.vx = Math.max(j.vx - 2, 0);
      if (j.vz < 0) { j.vz = Math.min(j.vz + 2, 0); } else if (j.vz > 0) j.vz = Math.max(j.vz - 2, 0);
      if (pick()) return;
      break;
    }
    case 1: {
      j.yaw = (j.yaw + 0x40) & 0xfff;
      const o = d.P[j.owner];
      if (o) { j.x = o.x; j.z = o.z; j.y = -0x400; }
      break;
    }
    case 2: {
      const o = d.P[j.owner]!;
      j.x = o.x; j.z = o.z; j.y = -0x200;
      j.g = 0x800; j.vy = 0; j.fl = 0; j.b = 0; j.hold = 4;
      j.vx = Math.floor((SIN(o.yaw) * -0xd2) / 4096);
      j.vz = Math.floor((T(o.yaw) * -0xd2) / 4096);
      j.mult = rdMult(o.x, o.z);
      j.yaw = o.yaw;
      j.st = 3;
      E(w, 'jthrow', o.x, o.z, j.owner, j.mult);
      break;
    }
    case 3: {
      const o = d.P[j.owner];
      const old = j.hold--;
      if (old > 0 && o && ((o.bot) || (o.pad & 0x8000))) {
        j.vy -= 0x1800;
        if (j.vy < -0x6000) j.vy = -0x6000;
      }
      j.x += j.vx; j.z += j.vz;
      j.y += j.vy >> 8;
      j.vy += j.g;
      if (jewelBounce(w, j)) return;
      if (pick()) return;
      break;
    }
    case 4: {
      j.x += j.vx; j.z += j.vz;
      j.y += j.vy;
      j.vy += j.g;
      if (jewelBounce(w, j)) return;
      if (pick()) return;
      break;
    }
    case 5: {
      const r = ri(w, 0x1000);
      j.vy = -0x60; j.g = 8; j.fl = 0; j.b = 0;
      j.vx = SIN(r) >> 6; j.vz = T(r) >> 6;
      j.st = 4;
      E(w, 'jdrop', j.x, j.z, -1, ri(w, 4));
      break;
    }
    case 7: {
      j.st = 0;
      E(w, 'jspawn', j.x, j.z);
      break;
    }
    default: skipWall = true; break;
  }
  if (j.st !== 1 && !skipWall) {
    const r = sq(j.x * j.x + j.z * j.z);
    if (r > 0xb00) {
      const a = at2(j.x, j.z) & 0xfff;
      const k = r - 0xafc;
      j.x -= Math.floor((k * T(a - 0x400)) / 4096);
      j.z -= Math.floor((k * T(a)) / 4096);
      E(w, 'jwall', j.x, j.z);
      const a0 = (a + 0x800) & 0xfff;
      reflect(j, SIN(a0), T(a0));
    }
  }
}

// ---------------------------------------------------------------- mirror to bodies
function sync(w: World, d: RingDingData) {
  const map = new Map<number, Body>();
  for (const b of w.bodies) map.set(b.id, b);
  d.P.forEach((p, s) => {
    if (!p) return;
    const b = map.get(p.bid);
    if (!b) return;
    const ox = b.x, oz = b.z;
    b.x = p.x * RD_S; b.z = -p.z * RD_S; b.y = 0;
    b.vx = (b.x - ox) * 30; b.vz = (b.z - oz) * 30; b.vy = 0;
    p.face = (-p.yaw * Math.PI * 2) / 4096;
    b.face = p.face;
    b.dash = p.st === ST_BARGE ? 0.1 : 0;
    b.cd = p.cd / 30;
    b.fall = false;
    void s;
  });
  d.J.forEach((j, i) => {
    const b = map.get(j.bid);
    if (!b) return;
    b.x = j.x * RD_S; b.z = -j.z * RD_S; b.y = -j.y * RD_S;
    b.vx = j.vx * RD_S * 30; b.vz = -j.vz * RD_S * 30; b.vy = -j.vy * RD_S * 30;
    b.face = (-j.yaw * Math.PI * 2) / 4096;
    b.m = j.st; b.cd = j.owner; b.slot = i;
    b.alive = true;
  });
  d.score = d.score.slice(0, 4);
  for (let s = 0; s < MAX_SEATS; s++) {
    const p = d.P[s];
    d.st[s] = p ? p.st : 0;
    d.carry[s] = p ? p.carry : -1;
    d.cd[s] = p ? p.cd : 0;
  }
}

// ---------------------------------------------------------------- game
export const ringDing: MiniGame = {
  id: 'ringDing',
  name: 'Ring Ding',
  description: 'Ride the dinos, grab jewels and throw them at the swinging target. Throw from the far side for 5x. Square without a jewel is a barge!',
  controls: 'Move: stick. A/B (square): throw the carried jewel (hold it for a higher arc), or barge when empty-handed.',
  maxTime: 90,

  setup(w, slots) {
    const chars = w.data?.chars as number[] | undefined; // optional host override: roster index per slot
    const d: RingDingData = {
      t: 0, phase: 0, th: 0, tyaw: 0, troll: 0, tx: 0, tz: RD_TARGET_R, gcd: 0,
      score: [0, 0, 0, 0], st: [0, 0, 0, 0], carry: [-1, -1, -1, -1], cd: [0, 0, 0, 0],
      P: [null, null, null, null], J: [], winner: -1, draw: false, ord: [],
    };
    w.data = d;
    // the target's swing phase runs 97 ticks ahead of the round clock (measured: phase = 12 * t + 1164)
    d.th = Math.floor((SIN(1176) * 3) / 16) & 0xfff;
    d.phase = 1188;
    for (let i = 0; i < 16; i++) {
      const a = [0, 1, 2, 3];
      for (let k = 0; k < 4; k++) { const j = ri(w, 4); [a[k], a[j]] = [a[j], a[k]]; }
      d.ord.push(a);
    }
    for (const s of slots) {
      const look = Math.max(0, Math.min(RD_CHAR_ID.length - 1, chars?.[s.slot] ?? s.char ?? s.slot));
      const [x, z] = STARTS[s.slot];
      const yaw = at2(x, z) & 0xfff;
      const b = addBody(w, 'player', s.slot, x * RD_S, -z * RD_S, 206 * RD_S * w.params.playerScale, 1);
      const skill = SKILLS[Math.max(0, Math.min(2, s.level ?? 1))];
      d.P[s.slot] = {
        bid: b.id, id: RD_CHAR_ID[look], bot: s.bot, skill, x, z, yaw, hd: yaw,
        vx: 0, vz: 0, tvx: 0, tvz: 0, ac: 9, dc: 9, st: ST_IDLE, rt: 0, tt: 0, cd: 0, carry: -1, sc: 0, lock: 0, pad: 0, ang: 0,
        face: (-yaw * Math.PI * 2) / 4096,
        ai: { h: H_IDLE, jw: -1, n30: 8, mode: 0, ang: 0, t40: 0, rv: 0, pa: 0, acc: 0, cx: 0, cz: 0, tx: 0, tz: 0 },
      };
      b.face = d.P[s.slot]!.face;
    }
    JEWEL0.forEach(([x, y, z], i) => {
      const b = addBody(w, 'jewel', i, x * RD_S, -z * RD_S, 0.4, 1);
      d.J.push({ bid: b.id, st: i < 2 ? 7 : 6, x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, g: 0x800, fl: 0, b: 0, hold: 0, mult: 1, owner: 5, cd: 0 });
    });
    sync(w, d);
  },

  step(w, inputs) {
    const d = w.data as RingDingData;
    if (d.t >= RD_TICKS) return;
    targetTick(w, d);
    for (const p of players(d)) if (p.cd > 0) p.cd--;
    d.t++;
    if (d.t === 0x546) d.J[2].st = 7;
    for (let s = 0; s < MAX_SEATS; s++) {
      const p = d.P[s];
      if (!p) continue;
      if (!p.bot && !rdTest.pads) {
        p.pad = padOf(inputs[s] ?? IDLE);
        p.ang = rdPadAngle(p.pad);
      }
    }
    const order = rdTest.order ?? d.ord[ri(w, 16)];
    for (const s of order) {
      const p = d.P[s];
      if (p) playerTick(w, d, p, s);
    }
    d.J.forEach((j, i) => jewelTick(w, d, j, i));
    sync(w, d);
    if (d.t >= RD_TICKS) {
      const pl = ringDing.placements(w);
      d.draw = d.score[pl[0]] === d.score[pl[1]] && !!d.P[pl[1]];
      d.winner = d.draw ? -1 : pl[0];
    }
  },

  isOver(w) {
    return (w.data as RingDingData).t >= RD_TICKS;
  },

  placements(w) {
    const d = w.data as RingDingData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },
};
