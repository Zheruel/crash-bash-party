/**
 * POLAR PUSH (game id 'pushOff'): integer port of the real game's overlay (0x800b32b4.., re/out_polarPush/ovl.c, notes re/notes/polarPush.md).
 *
 * 30 Hz, no delta time, PS1 fixed point: positions in game units (1024 = 1 model unit, world = units / 320, world z = game z),
 * angles 4096 per turn (0 = +z, 0x400 = +x). A bear's yaw points *backwards*: it moves along -(sin yaw, cos yaw).
 * Four bears slide on ice (accel 2 / decel 1 per tick toward the pad target velocity), bump with a mass-weighted elastic exchange
 * (radius 256) and dash (Square) to knock rivals over the edge. Centre outside the level hull -> slip: slow = hang on and mash
 * Square 5x to climb back, fast = fall. Last bear on the ice wins; the clock is 1:30.
 *   Stick = move (8 directions), A or B (Square) = dash / mash to climb; MANIC PANIC: B (Circle) = throw the carried bolt
 *
 * Per tick (FUN_8007976c): level update (tilt FUN_800b3aa0), one engine rand, then the players in one of 16 shuffled orders
 * (rand(16)); per player: lock-1, CPU AI (FUN_800cad60), pad -> target velocity (FUN_800cccb8), state handler (0x8009dca4 table),
 * integrator (FUN_800b5788); then the object list (Uka mask FUN_800bd67c, TILT seal FUN_800c358c). CPUs run the real AI state
 * machine inside step() (behaviour pick FUN_800b9d48, handlers b6708/b7f70/b7520/b7224/b90c0/..., pad synthesis b5ebc, dash b60b8).
 * setup() also runs the 112-tick intro (AI and objects tick, bears frozen, no tilt).
 * Replay-verified on all four levels (re/notes/polarPush.md "Replay"): seeded per tick with the game's state and rng, the sim
 * reproduces the emulator tick for tick (AI, physics, mask items, pillars, melting, bolts, the seal), all-CPU and with a human pad.
 * Not modelled: the engine's render-node pool. When it runs out the real game silently drops cosmetic objects (sparks, the bolt
 * burst) and their rng draws, and now and then a gameplay object too (see the notes). Estimated: easy / hard skill.
 *
 * Variants (world.data.variant):
 *   tilt  TILT PANIC: the platform tilts toward the bears' weighted centre, everything slides; a seal (object 0x160c) jumps on,
 *         crosses the ice and shoves bears (FUN_800c358c).
 *   polar POLAR PANIC: 40 breakable ice pillars fence the rim (FUN_800c0888); a hard hit breaks one and opens the edge.
 *   melt  MELT PANIC: 16 ice sectors; the mask (object 0x160a, FUN_800c1584) flies round the ring, melts the sector under it and
 *         half-melts its neighbours; whoever touches it gets shrink / snowball / freeze / bomb.
 *   manic MANIC PANIC: a bolt pickup (0x160e / 0x160f) appears on the ice; B (Circle) throws it (0x160d). A hit knocks the rider
 *         off the bear (on foot: lighter, no edge hang); a hit on foot eliminates.
 *
 * world.data: variant, radius, tilt [x,z] (-1..1), tiltRad [x,z], meter[4], hang[4] (s left), item[4] (1 shrink 2 grow 3 bomb 4 stun
 *   5 zap 6 snowball 7 frozen), itemT[4], elim[4], melt[16], pillars [x,z,alive][], foot[4] (1 = knocked off the bear), hold[4]
 *   (carries a bolt), P[] (per-player engine state), seal, internals.
 * Bodies: 'player', 'mask' (y = hover height), 'seal' (TILT; y = height while it jumps in), 'bolt' (manic: pickup on the ice, carried, or thrown; y = height). Events: dash, thump,
 *   hit, skid, ko, hang, climb, pickup, beamWarn, beam, beamEnd, zap, bomb, boom, dazed, melt, pillar, seal, bolt (pickup appears), grab (s
 *   takes it), throw, strike (bolt lands / explodes, v = blast radius), zapped (s hit by o's bolt: v 1 off the bear, 2 out).
 *   world.data.scale[4] = Uka shrink/grow model scale.
 */
import { FitCam, trackBox, type TrackBox } from '../fitCamera';
import { addBody, discRandomInt, discRandomState, emit } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';
import { pickVariant, VERSUS_CLOCK_END } from './common';
import { at2, RD_CHAR_ID, SIN, T } from './dragonDrop';

/** GO is the first movement update. Ranking runs 2,698 ticks later. */
export const POLAR_TIMEOUT_TICK = VERSUS_CLOCK_END;
export const POLAR_DRAW_TICKS = 120;
/** From the winner's reaction to the versus reset, including the cup tally. */
export const POLAR_WIN_TALLY_TICKS = 123;
export const PO_RADIUS = 8;
export const PO_CHARGE_COST = 0.5;
/** Collision circle of the real game: 256 units apart = 0.8 world units. */
export const PO_BEAR_R = 0.4;
export const U = 1 / 320;
export const platformRadius = (_t: number) => PO_RADIUS;

export const PO_VARIANTS = [
  { id: 'tilt', name: 'TILT PANIC' },
  { id: 'polar', name: 'POLAR PANIC' },
  { id: 'melt', name: 'MELT PANIC' },
  { id: 'manic', name: 'MANIC PANIC' },
];

// ---------------------------------------------------------------- exe math
const imul = Math.imul;
const s16 = (v: number) => (v << 16) >> 16;
/** FUN_800154a0: signed shortest turn from a to b (+-0x800) */
const adiff = (a: number, b: number) => { const v = (b - a) & 0xfff; return v > 0x800 ? v - 0x1000 : v; };
/** (a * T) >> 12 with 32-bit wraparound like the MIPS code */
const m12 = (a: number, t: number) => imul(a, t) >> 12;
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
/** FUN_80032490(n) >> 6: table-free CORDIC sqrt (slightly inexact, bit exact port) */
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
function ri(w: World, n: number): number {
  return poTest.rng ? poTest.rng(n) : discRandomInt(w, n);
}
/** a draw made by the init of a cosmetic object (spark 0x1612, burst 0x1614): only its count matters */
const fx = (w: World, n: number) => { if (!poTest.fx || poTest.fx(false, n)) ri(w, n); };
/** pad bits -> pad angle (b5ebc / pad reader): up 0, right 0x400, down 0x800, left 0xc00 */
/** FUN_800136bc: the engine's pad reader turns digital bits into a fake stick (0 / 0x80 / 0xff) and stores at2 of it at +0x38. */
function stickAngle(b: number): number {
  const x = b & 0x80 ? 0 : b & 0x20 ? 0xff : 0x80, y = b & 0x10 ? 0 : b & 0x40 ? 0xff : 0x80;
  return at2(x - 0x80, 0x80 - y);
}
/** FUN_800b5ebc's 8-way angle table (CPU pad angle refresh) */
function padAngle(b: number): number {
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

// ---------------------------------------------------------------- level hull (FUN_800b4260)
/**
 * Hulls = edge lists x,z,angle of the level collision data (*(PTR_PTR_80058ad0 + 0x10), table at +0x14; read from RAM of each
 * level): inside iff ((px-x)*T(-a)>>12) - ((pz-z)*T(-a-0x400)>>12) >= 0 for every edge.
 */
/** TILT PANIC: 40 edges (L18 0x801ccaf4) */
const HULL_RAW = [-687,-2517,847,-1194,-2378,834,-1595,-2258,672,-2051,-1987,376,-2236,-1704,308,-2420,-1346,139,-2518,-901,49,-2551,-477,51,-2583,-75,4059,-2562,315,4025,-2518,717,3978,-2453,1075,3928,-2349,1472,3784,-2138,1879,3426,-1725,2128,3292,-1324,2269,3295,-867,2432,3086,-368,2443,3157,44,2497,2979,500,2432,3018,875,2402,2968,1266,2339,2907,1662,2237,2769,2053,2041,2426,2281,1694,2247,2411,1281,2229,2498,977,2134,2563,488,2107,2607,10,1963,2552,-410,1999,2520,-857,1870,2411,-1248,1870,2303,-1639,1694,2107,-1965,1435,1781,-2204,1264,1390,-2356,1187,1010,-2454,1088,576,-2497,1084,120,-2541,1008,-357,-2530,997];
/** POLAR PANIC: 40 edges (L19 0x801c9a28) */
const HULL_POLAR = [-746,-2432,904,-1148,-2357,766,-1557,-2188,688,-1984,-1948,422,-2223,-1632,205,-2348,-1252,142,-2441,-838,92,-2507,-381,44,-2535,15,4061,-2513,428,4044,-2481,830,3913,-2366,1232,3934,-2283,1559,3752,-2067,1929,3453,-1663,2198,3363,-1287,2377,3199,-870,2460,3166,-462,2519,3140,72,2576,2986,492,2520,2985,862,2471,2942,1295,2384,2921,1709,2286,2777,2102,2096,2377,2321,1701,2216,2446,1226,2204,2528,890,2186,2627,433,2062,2637,-7,1972,2582,-480,2003,2555,-893,1920,2468,-1335,1746,2220,-1833,1556,2029,-2037,1411,1759,-2220,1275,1435,-2353,1152,1033,-2434,1099,620,-2482,1039,162,-2494,1010,-401,-2483,926];
/** MELT PANIC (L20): hull 0 = the whole disc (16 edges, 0x801d1f00), hull 1 = what is left where a sector is gone (0x801d22bc) */
const HULL_MELT = [531,-2561,1014,-497,-2548,770,-1406,-2177,513,-2136,-1453,267,-2543,-521,23,-2579,441,3850,-2148,1528,3635,-1497,2290,3306,-528,2655,3074,573,2659,2746,1467,2171,2536,2351,1221,2227,2558,491,2064,2582,-502,1775,2173,-1427,1554,1481,-2161,1283];
const HULL_MELT_IN = [-382,-1775,796,-1019,-1545,533,-1528,-1070,226,-1800,-322,4095,-1800,356,3862,-1545,1036,3618,-1086,1545,3324,-382,1832,3116,355,1883,2831,1053,1613,2511,1579,1002,2287,1834,339,2015,1800,-356,1795,1545,-985,1550,1034,-1521,1297,373,-1817,987];
/**
 * MELT hulls 2 and 3 (0x801d2678 / 0x801d275c): the two half-melted wedges, a triangle each with the normals pointing out, given
 * for sector 15 and turned by (sector + 1) * 0x100 (FUN_800b4094). Hull 2 = the half next to sector + 1, hull 3 = next to sector - 1.
 */
const MELT_TRI = [[602,3252,988,-186,3294,2304,356,1987,3970], [59,3235,985,-679,3277,2186,-390,1936,3878]];
/** MANIC PANIC: 26 edges (L21 0x801d12d4) */
const HULL_MANIC = [-14,-3169,860,-648,-3007,1083,-1172,-3056,778,-1951,-2749,688,-2647,-2358,259,-2986,-1554,1,-2988,-984,3989,-2909,-503,187,-3064,18,33,-3096,613,4023,-2995,1516,3870,-2706,2319,3458,-1658,3026,3073,-756,3028,3143,231,3136,2964,1195,2976,3036,1814,2942,2659,2737,2266,2238,3117,1002,1976,3052,410,2143,3202,-604,1927,2959,-1916,1774,2659,-2589,1302,1871,-2950,1171,901,-3174,1050,386,-3196,979];
const HULLS: Record<string, number[]> = { tilt: HULL_RAW, polar: HULL_POLAR, melt: HULL_MELT, manic: HULL_MANIC };
const hullInside = (H: number[], px: number, pz: number): boolean => {
  for (let i = 0; i < H.length; i += 3) {
    const a = H[i + 2];
    if (m12(px - H[i], T(-a)) - m12(pz - H[i + 1], T(-a - 0x400)) < 0) return false;
  }
  return true;
};
/** FUN_800b4094: false when the point lies in the half-melted wedge n (0 = hull 2, 1 = hull 3) of its sector. */
function wedgeFree(px: number, pz: number, n: number): boolean {
  const H = MELT_TRI[n], rot = ((sectorOf(px, pz) + 1) & 0xf) * 0x100, c = T(rot), sn = SIN(rot);
  let out = 0;
  for (let i = 0; i < 9; i += 3) { // edge point through the engine's Ry matrix (FUN_8003278c / FUN_800330cc), edge angle - rot
    const ex = (c * H[i] + sn * H[i + 1]) >> 12, ez = (-sn * H[i] + c * H[i + 1]) >> 12, a = rot - H[i + 2];
    if (m12(px - ex, T(a)) - m12(pz - ez, T(a - 0x400)) < 0) out++;
  }
  return out !== 3;
}
export const insideHull = (gx: number, gz: number, variant = 'tilt'): boolean => hullInside(HULLS[variant] ?? HULL_RAW, gx | 0, gz | 0);

// ---------------------------------------------------------------- tables
/** Player states (0x8009dca0) */
export const S_IDLE = 0x49, S_WALK = 0x4a, S_STUN = 0x4b, S_BLAST = 0x4d, S_SLIP = 0x4e, S_ITEM = 0x4f, S_OUT = 0x50, S_DASH = 0x51, S_WIN = 0x58;
/** MELT: frozen 0x4c, snowball 0x52. MANIC: throw 0x53, on foot idle / walk 0x54 / 0x55, knocked off the bear 0x56, burnt (out) 0x57. */
export const S_FROZEN = 0x4c, S_BALL = 0x52, S_THROW = 0x53, S_FOOT = 0x54, S_FOOTWALK = 0x55, S_OFF = 0x56, S_BURN = 0x57;
const F_ELIM = 0x2000, F_OUT = 0x8000, F_WON = 0x200;
/** Behaviour probabilities 0x800d4e0c (x/4096), indexed by game char id 1..8 with the per-behaviour offsets of the code. */
const PROB = [3072, 3072, 3072, 3072, 3072, 3072, 3072, 3072, 2048, 3072, 2048, 2048, 2048, 2048, 2048, 2048, 0, 0, 0, 0, 0, 0, 0, 0, 2048, 4096, 4096, 2048, 0, 0, 512, 512, 2048, 0, 0, 0, 0, 0, 2048, 2048, 2048, 2048, 1024, 1024, 1024, 1024, 1024, 1024, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 2048, 4096, 4096, 4096, 512, 512, 512, 512];
/** Dash countdown reduction by skill (0x800d52e0) and hang-climb chance by skill (0x800d5364, x128/4096). */
const T52E0 = (k: number) => (k < 9 ? 0 : Math.min(64, (k - 8) * 4));
const T5364 = (k: number) => (k < 9 ? 0 : Math.min(32, (k - 8) * 2));
/** Evade directions 0x800d53e8 */
const EV8 = [0, 1024, 2048, 3072, 1536, 2560, 3584, 512];
/**
 * Anim scripts (anim VM FUN_8008502c, tables 0x8009d29c + id*4, read from RAM): one script word per tick, frame words < 0x8000,
 * 0x8008 n = sound (skipped in the same tick), 0x8004 n = change state. The script pc is the "anim frame" the code tests
 * (dash impulse at pc 1/6/10, climb allowed while pc < 0x21). Encoded as runs of frame words and [opcode, arg] pairs.
 */
const DASH_SCRIPT: (number | [number, number])[][] = [[],
  [15, [0x8008, 0x18], 5, [0x8004, S_IDLE]], [14, [0x8008, 0x4a], 6, [0x8004, S_IDLE]],
  [30, [0x8008, 0x7c], 7, [0x8004, S_IDLE]], [30, [0x8008, 0xae], 7, [0x8004, S_IDLE]],
  [23, [0x8008, 0x144], 3, [0x8004, S_IDLE]], [12, [0x8008, 0x176], 10, [0x8004, S_IDLE]],
  [16, [0x8008, 0x112], 7, [0x8004, S_IDLE]], [1, [0x8008, 0xde], 15, [0x8008, 0xe0], 9, [0x8004, S_IDLE]]];
/** edge hang 0x3d: 42 frames (ids 3, 4: 40) then state 0x50 */
const HANG_SCRIPT = (id: number): (number | [number, number])[] => [id === 3 || id === 4 ? 40 : 42, [0x8004, S_OUT]];
const words = (sc: (number | [number, number])[]) => { const o = [0]; for (const x of sc) if (typeof x === 'number') for (let i = 0; i < x; i++) o.push(0x4000); else o.push(...x); return o; };
/** knocked off the bear, clip 0x3f: 19..30 frames then state 0x54; dash on foot, clip 0x45: 20 frames then 0x54 (all ids) */
const OFF_FRAMES = [0, 19, 19, 26, 20, 30, 29, 30, 27];
const SCRIPTS = DASH_SCRIPT.map((sc, id) => (id ? { dash: words(sc), hang: words(HANG_SCRIPT(id)), foot: words([20, [0x8004, S_FOOT]]), off: words([OFF_FRAMES[id], [0x8004, S_FOOT]]) } : null));
/** Skill (DAT_8009d87c) per difficulty: normal 16 read from RAM; easy / hard estimated like Ring Ding. */
const SKILLS = [8, 16, 20];
const CENTRE_R2 = 1000000; // DAT_800d4dd0 on TILT (0x400000 elsewhere)

const mass0 = (id: number) => (id >= 5 ? 0x180 : 0x100);
/** FUN_800b5684: base mass, 0x46 less on foot */
const massOf = (q: PoP) => mass0(q.sel ?? q.ch) - (q.md === 1 ? 0x46 : 0);
const speed0 = (id: number) => (id >= 5 ? 40 : 55);
/** FUN_800d05a8 */
const dashCost = (q: PoP) => (q.md !== 0 ? 0x80 : q.ch === 3 || q.ch === 4 ? 0x100 : q.ch === 5 || q.ch === 6 ? 0xb4 : 0x80);
/** FUN_800d0750 */
const dashSpeed = (q: PoP) => (q.md !== 0 ? 0x46 : q.ch === 3 || q.ch === 4 ? 0x82 : q.ch === 5 || q.ch === 6 ? 0x69 : q.ch === 7 || q.ch === 8 ? 0x4b : 0x5a);
const dashFrame = (id: number) => (id === 3 || id === 4 ? 10 : id === 5 || id === 6 ? 6 : 1);

// ---------------------------------------------------------------- state
/** AI handler ids (= the state numbers the code stores at +0x30) */
const H_ATTACK = 1, H_MASK = 2, H_NOP4 = 4, H_IDLE = 5, H_EVADE = 6, H_HELP = 7, H_ITEM = 8, H_WANDER = 9, H_WAIT = 10, H_CENTRE = 11, H_SEAL = 12, H_BOLT = 13;
interface PoAI {
  tx: number; tz: number; sx: number; sz: number; cnt: number; tgt: number; ev: number; st: number; h: number;
  fl: number; per: number; dir: number; f4c: number; f58: number; dcd: number;
  /** +0x54: decide() calls since this bear carries a bolt (MANIC) */
  f54: number;
  /** pad struct (PTR_DAT_8009d54c): +0x20 AI pad on, +0x24 angle refresh counter, +0x2a angle, +0x2c bits of this tick */
  on: number; c24: number; a2a: number; bits: number;
}
export interface PoP {
  ch: number; cpu: boolean; sk: number;
  st: number; pst: number; fl: number; lk: number;
  x: number; y: number; z: number; yaw: number; sc: number;
  vx: number; vz: number; tvx: number; tvz: number; acx: number; dcx: number; acz: number; dcz: number;
  mass: number; ty: number; qy: number; spd: number;
  /** anim script pc (+0x1e of the anim struct), clip (0 loop, 1 dash, 2 hang, 3 dash on foot, 4 knocked off) and ticks in the current state */
  af: number; clip: number; k: number;
  bombExpiry?: PolarBombExpiry;
  slipSoundTick?: number;
  /** mount component: gauge +0x20, presses +0x14, slip speed +0x18, mode +0x24, stun counter +0x1c, forced fall +0xac */
  g: number; pr: number; ss: number; md: number; sc1c: number; ac: number;
  /** pad: held / newly pressed this tick, pad angle; nb/pb = CPU bits of the last two ticks (applied by the pad reader) */
  held: number; pressed: number; ang: number; nb: number; pb: number;
  ai: PoAI;
  by: number; byT: number; s98: number;
  /** MANIC: carries a bolt (mount +0x28), hit immunity ticks (player +0x44) */
  hold: number; imm: number;
  /** a pad is plugged into this CPU's port (DAT_80051338 & 1): the pad path stays on while the AI is off (replay harness only) */
  pc?: boolean;
  /** replay only: the id in the selection table DAT_8005a664 (FUN_800b5684 reads the base mass from it); the same as ch in a normal game */
  sel?: number;
}
/** Object 0x1602's fixed origin and the rider's last animation frame, carried in round snapshots. */
export interface PolarBombExpiry {
  tick: number; x: number; y: number; z: number; frame: number; fidget: number;
}
interface SealFlight {
  x: number; y: number; z: number; sx: number; sy: number; sz: number; tx: number; tz: number;
  go: number; vy: number; vx: number; vz: number;
}
interface SealFish extends SealFlight {
  yaw: number; pitch: number; spin: number; landed: boolean; frame: number;
}

/**
 * TILT seal (object 0x160c): state +0xc / timer +0x10, entity x / y / z / yaw, jump (FUN_8008c5c4: go +0x18, vy +0x28, vx / vz +0x48 / +0x4c,
 * start +0x74.., target +0x68..), flip-book pc, walk speed +0x88 -> +0x8c, target yaw +0x90, rim angle DAT_800d563c, the velocity of its
 * motion component (mass 0x400) and obj +0x5c = bears collide with it.
 */
export interface Seal extends SealFlight {
  fish?: SealFish; pose?: number;
  st: number; t: number; yaw: number; pc: number; spd: number; tgt: number; dir: number; base: number;
  mvx: number; mvz: number; on: number;
}
/** Cosmetic state of objects 0x1601/0x160a and their scripted 0x1605 effects. PS1 units and angles. */
export interface PolarEmitterPose {
  y: number; pitch: number; yaw: number; roll: number; tick: number;
  phase: number; speed: number; targetSpeed: number;
  effect: { kind: 'beam' | 'pickup' | 'melt'; age: number; x: number; z: number } | null;
}
interface Data {
  random?: [number, number];
  camera?: [number, number, number];
  cameraTarget?: [number, number, number];
  variant: string; radius: number; tilt: [number, number]; tiltRad: [number, number];
  meter: number[]; hang: number[]; item: number[]; itemT: number[]; elim: number[]; scale: number[];
  melt: number[]; pillars: [number, number, number][];
  P: (PoP | null)[]; ord: number[][]; ax: number; az: number; rayLen: number; over: boolean; t: number; one: number;
  flags: number[]; d5ffc: number; d6004: number; noHuman: boolean;
  maskA: number; mx: number; mz: number; beam: number;
  maskView?: PolarEmitterPose;
  ms: number; m58: number; m100: number; mk: number; mh: number; k18: number[]; k28: number[]; t38: number[]; t68: number; t70: number; c6c: number; cool: number[];
  human: boolean[]; seal: Seal | null;
  /** MELT sectors: state +0xbc (0 whole, 1 gone, 2 / 3 half gone, 4 both halves), melt count +0xb8, anim timer +0xc0 (0..0x74) */
  sec: number[]; secN: number[]; secT: number[]; secAnim: number[];
  /** MELT mask: target angle +0x1c0 and point +0x1d0 / +0x1d8, state +0x14, item clock +0x64, counter +0xb4 */
  meltCamera?: [number, number]; // Last position of tracking object 0x160b during mask travel.
  mTarget: number; mTx: number; mTz: number; mState: number; m64: number; mb4: number;
  /** MANIC: spawner 0x160e (state +0xc, timer +0x10, bolts out +0x18) and the bolts (pickup 0x160f / thrown 0x160d) */
  sp: { st: number; t: number; n: number }; bolts: Bolt[]; foot: number[]; hold: number[];
  /** FUN_800bcc9c: elapsed fidget script ticks plus one, or zero when inactive */
  fid?: number[];
  /** POLAR: ticks the mask-pickup effect (0x1605 script 3) still emits particles */
  fxT: number;
}
/** k 0 = pickup (st 0 on the ice, 1 carried by own), k 1 = thrown (st 0 flying, 1 exploding), k 2 = the bear of a rider knocked off (0x1611, flies away);
 * y is up-negative like the engine */
interface Bolt {
  id: number; k: number; st: number; x: number; y: number; z: number; own: number; t: number; yaw: number; fresh: boolean;
  sx: number; sz: number; tx: number; tz: number; spd: number; go: number; vx: number; vy: number; vz: number; floor: number;
}

/** Test hook: replay real-game traces (pads per slot, forced update order, AI off). */
export const poTest: {
  pads: { held: number; pressed: number; ang: number }[] | null; order: number[] | null; noAI: boolean; noObjects: boolean;
  pre: ((w: World, d: any) => void) | null; post: ((w: World, d: any) => void) | null;
  /** replace the world rng (e.g. with the game's LCG FUN_80015590) */
  rng: ((n: number) => number) | null; noSeal: boolean; introNoPre: boolean;
  /** asked before every draw a cosmetic object makes when it spawns, and (obj = true) before the bolt pickup / flying bear spawn;
   *  false = that spawn failed in the real game (render-node pool empty) */
  fx: ((obj: boolean, n: number) => boolean) | null;
} = { fx: null, introNoPre: false, pads: null, order: null, noAI: false, noObjects: false, pre: null, post: null, rng: null, noSeal: false };
/** test access to the state switch (enter handlers) */
export const poSetState = (w: World, s: number, st: number) => { const d = w.data as Data; setState(w, d, d.P[s]!, s, st); };
/** test access to the edge test (level hull + MELT sectors) */
export const poOnIce = (w: World, gx: number, gz: number) => onIce(w.data as Data, gx | 0, gz | 0);

const SECTORS = 16;
const sectorOf = (gx: number, gz: number) => ((at2(gx, gz) - 0x7d) & 0xfff) >> 8;
const elim = (q: PoP | null) => !q || (q.fl & F_ELIM) !== 0;
const P = (d: Data, i: number) => d.P[i];
const dist2 = (ax: number, az: number, bx: number, bz: number) => imul(ax - bx, ax - bx) + imul(az - bz, az - bz);

/** FUN_800b4260: is the point on the ice? MELT: a gone sector is tested against the inner hull, a half gone one against its wedge. */
function onIce(d: Data, gx: number, gz: number): boolean {
  let H = HULLS[d.variant] ?? HULL_RAW;
  if (d.variant === 'melt') {
    const s = sectorOf(gx, gz), st = d.sec[s], done = d.secT[s] > 0x71;
    if (st === 1) H = HULL_MELT_IN;
    if ((st === 3 && done && !wedgeFree(gx, gz, 0)) || (st === 2 && done && !wedgeFree(gx, gz, 1))) return false;
    if (st === 4 && done && (!wedgeFree(gx, gz, 0) || !wedgeFree(gx, gz, 1))) return false;
  }
  return hullInside(H, gx, gz);
}

// ---------------------------------------------------------------- player state machine
function setState(w: World, d: Data, q: PoP, s: number, st: number) {
  if (st === S_BLAST) {
    const frame = q.st === S_DASH || q.st === S_STUN ? q.k : Math.max(0, q.af - 1);
    q.bombExpiry = { tick: w.tick + 1, x: q.x, y: q.y, z: q.z, frame, fidget: d.fid?.[s] ?? 0 };
  }
  if (d.fid) d.fid[s] = 0;
  delete q.slipSoundTick;
  q.pst = q.st; q.st = st; q.k = 0;
  switch (st) {
    case S_IDLE: { // FUN_800cd594
      const r6 = ri(w, 6);
      if (q.fl & F_WON) { setState(w, d, q, s, S_WIN); return; }
      q.pr = 0;
      const v = sq(imul(q.vx, q.vx) + imul(q.vz, q.vz));
      q.dcx = q.dcz = 1; q.acx = q.acz = 2;
      play(q, 0);
      if (v > 0x20) { ri(w, 0x100); E(w, 'skid', q.x, q.z, s, r6); }
      break;
    }
    case S_WALK: if (q.fl & F_WON) { setState(w, d, q, s, S_WIN); return; } play(q, 0); break;
    case S_DASH: { // FUN_800d0808
      if (q.fl & F_WON) { setState(w, d, q, s, S_WIN); return; }
      play(q, q.md === 1 ? 3 : 1);
      q.g -= dashCost(q);
      q.vx = q.vz = q.tvx = q.tvz = 0;
      E(w, 'dash', q.x, q.z, s, q.md === 1 ? 2 : 1);
      break;
    }
    case S_SLIP: { // FUN_800cfc58
      if (q.fl & F_WON) { setState(w, d, q, s, S_WIN); return; }
      if (q.pst === 0x52 || q.pst === 0x4c) q.ac = 1;
      if (q.pst === 0x4c) break;
      if (q.pst !== 0x52 && q.pst !== S_STUN) {
        if (q.md === 0) play(q, 2);
        const v = sq(imul(q.vx, q.vx) + imul(q.vz, q.vz));
        q.ss = v;
        if (v < 0x4a) {
          if (q.md === 0) { q.slipSoundTick = w.tick + 1; E(w, 'hang', q.x, q.z, s, 1); }
        }
        else { q.af = 0x21; eliminate(w, d, q, s); }
      }
      if (d.variant === 'tilt' && d.seal && sealBox(d.seal, q, 300)) q.af = 0x21; // FUN_800cac20: the seal is right there, no hang
      break;
    }
    case S_OUT: // FUN_800d0470
      q.fl |= F_OUT | F_ELIM;
      E(w, 'splash', q.x, q.z, s, 1);
      break;
    case S_ITEM: // FUN_800d034c: straight to idle (its enter still sees the old speed), then the velocity is cleared
      setState(w, d, q, s, q.md === 1 ? S_FOOT : S_IDLE);
      q.vx = q.vz = q.tvx = q.tvz = 0;
      break;
    case S_BLAST: eliminate(w, d, q, s); break; // bomb (FUN_800d3170); the handler stops it from the next tick
    case S_STUN: { // FUN_800cde8c
      q.sc1c = 0; q.s98 = 0; q.vx = q.vz = q.tvx = q.tvz = 0; q.mass = 0x200;
      break;
    }
    case S_WIN: q.vx = q.vz = q.tvx = q.tvz = 0; break;
    case S_FROZEN: case S_BALL: if (q.fl & F_WON) { setState(w, d, q, s, S_WIN); return; } break; // FUN_800cf9ec / FUN_800d14cc: model swap only
    case S_THROW: { // FUN_800d1188: the bolt (0x160d) leaves 0x100 above the bear toward 0x700 (ids 1-4, 86 u/tick) / 0x800 (106 u/tick) ahead
      const far = q.ch <= 4 ? 0x700 : 0x800;
      d.bolts.push({
        id: -1, k: 1, st: 0, x: q.x, y: q.y - 0x100, z: q.z, own: s, t: 0, yaw: q.yaw, fresh: true, sx: q.x, sz: q.z,
        tx: (q.x - m12(far, SIN(q.yaw))) | 0, tz: (q.z - m12(far, T(q.yaw))) | 0, spd: q.ch <= 4 ? 0x56 : 0x6a, go: 0, vx: 0, vy: 0, vz: 0, floor: 0,
      });
      q.hold--;
      E(w, 'throw', q.x, q.z, s, 1);
      break;
    }
    case S_FOOT: { // FUN_800d191c: idle on foot, accel 4 / decel 2
      const r6 = ri(w, 6);
      q.pr = 0; q.md = 1;
      const v = sq(imul(q.vx, q.vx) + imul(q.vz, q.vz));
      q.acx = q.acz = 4; q.dcx = q.dcz = 2;
      play(q, 0);
      if (v > 0x20) { ri(w, 0x100); E(w, 'skid', q.x, q.z, s, r6); }
      break;
    }
    case S_FOOTWALK: play(q, 0); break; // FUN_800d2e00
    case S_OFF: // FUN_800d2044: off the bear (mode 1); the clip ends in 0x54
      if (q.md === 0) q.md = 1; else eliminate(w, d, q, s);
      play(q, 4);
      break;
    case S_BURN: q.s98 = 0; eliminate(w, d, q, s); break; // FUN_800d2248
  }
}

/** FUN_8008502c: one script step per tick (rate word 0). */
function anim(w: World, d: Data, q: PoP, s: number) {
  const S = SCRIPTS[q.ch]!;
  const sc = q.clip === 1 ? S.dash : q.clip === 2 ? S.hang : q.clip === 3 ? S.foot : q.clip === 4 ? S.off : null;
  if (!sc) { q.af++; return; }
  for (let n = 0; n < 64; n++) {
    const wd = sc[++q.af] ?? 0x4000;
    if (!(wd & 0x8000)) return;
    const arg = sc[++q.af];
    if (wd === 0x8004) { setState(w, d, q, s, arg); return; }
    if (wd === 0x8000) q.af = arg;
  }
}
const play = (q: PoP, clip: number) => { q.clip = clip; q.af = 1; };

function eliminate(w: World, d: Data, q: PoP, s: number) {
  if (q.fl & (F_ELIM | F_WON)) return;
  q.fl |= F_ELIM;
  d.elim[s] = w.tick;
  E(w, 'ko', q.x, q.z, s, 1, d.t - q.byT < 90 ? q.by : -1);
}

/** FUN_800cd214: centre outside the hull -> slip (0x4e). */
function edgeTest(w: World, d: Data, q: PoP, s: number) {
  if (onIce(d, q.x, q.z)) return;
  if (q.fl & F_WON) return;
  if (q.st === S_SLIP) return;
  setState(w, d, q, s, S_SLIP);
}

/** FUN_800cbbe8: 1D elastic exchange per axis, mass weighted, clamped to +-150. */
function exchange(d: Data, a: PoP, b: PoP) {
  let m1 = a.mass, m2 = b.mass;
  if (m1 <= 0 || m2 <= 0) return;
  const adj = (q: PoP, m: number) => {
    if (!q.cpu) return m;
    if (q.sk < 9) { m += (9 - q.sk) * -0x20; if (m < 0x11) m = 0x10; }
    if (q.sk > 0x18) m += (q.sk - 0x18) * 0x40;
    return m;
  };
  m1 = adj(a, m1); m2 = adj(b, m2);
  if (a.st === S_DASH && a.sc > 4000) m1 += 0x220;
  if (b.st === S_DASH && b.sc > 4000) m2 += 0x220;
  const ax = (u1: number, u2: number): [number, number] => {
    const df = (u1 - u2) | 0;
    const num = (imul(imul(df, -0x100), m2) + imul(imul(m1, u1) + imul(m2, u2), 0x100)) | 0;
    let r1 = Math.trunc(num / (m1 + m2)) | 0;
    let r2 = (r1 + imul(df, 0x100)) | 0;
    r1 = Math.max(-0x9600, Math.min(0x9600, r1)); r2 = Math.max(-0x9600, Math.min(0x9600, r2));
    return [r1 >> 8, r2 >> 8];
  };
  [a.vx, b.vx] = ax(a.vx, b.vx);
  [a.vz, b.vz] = ax(a.vz, b.vz);
}

/** FUN_800bbf2c: bump every other bear closer than 256; only this bear is pushed out to 266. */
function collide(w: World, d: Data, q: PoP, s: number) {
  for (let i = 0; i < 4; i++) {
    const o = d.P[i];
    if (i === s || !o || (o.fl & F_ELIM)) continue;
    const ex = o.x - q.x, ez = o.z - q.z;
    const dist = sq(imul(ex, ex) + imul(ez, ez));
    if (dist >= 0x100) continue;
    const r4 = ri(w, 4);
    const a = at2(ex, ez);
    exchange(d, q, o);
    const sp2 = imul(q.vx, q.vx) + imul(q.vz, q.vz);
    if (sp2 > 0x400 && q.st !== S_BALL) E(w, 'thump', (q.x + o.x) >> 1, (q.z + o.z) >> 1, s, Math.min(1, Math.sqrt(sp2) / 90), i + 4 * r4);
    if (sp2 > 0x1000 && q.st !== S_BALL && q.st !== 0x4c && q.st !== S_STUN && q.st !== 0x5a) { ri(w, 4); E(w, 'hit', (q.x + o.x) >> 1, (q.z + o.z) >> 1, s, Math.min(1.5, Math.sqrt(sp2) / 60), i); }
    q.by = i; q.byT = d.t; o.by = s; o.byT = d.t;
    bombPass(w, d, q, s, o, i);
    const push = 0x10a - dist;
    q.x = (q.x - m12(push, SIN(a))) | 0;
    q.z = (q.z - m12(push, T(a))) | 0;
  }
  // obstacle list PTR_DAT_800d5454 (the seal while obj +0x5c is set): box push, then an elastic exchange with its motion component
  if (d.seal && d.seal.on && sealBox(d.seal, q, 0x100)) sealBump(d.seal, q);
}

/** FUN_800d0650: Square with a full enough gauge -> dash. */
function dashCheck(w: World, d: Data, q: PoP, s: number): boolean {
  if (dashCost(q) > q.g) return false;
  if (!(q.pressed & 0x8000)) { q.held &= ~0x8000; return false; }
  if (q.st !== S_DASH) setState(w, d, q, s, S_DASH);
  return true;
}

/** FUN_800d10a0: Circle while carrying a bolt -> throw (0x53). */
function throwCheck(w: World, d: Data, q: PoP, s: number): boolean {
  if (!q.hold) return false;
  if (!(q.pressed & 0x2000)) { q.held &= ~0x2000; return false; }
  if (q.st !== S_THROW) setState(w, d, q, s, S_THROW);
  return true;
}

function stateTick(w: World, d: Data, q: PoP, s: number) {
  if ((q.fl & F_WON) && q.st !== S_WIN && q.st !== S_OUT) { setState(w, d, q, s, S_WIN); return; }
  q.k++;
  switch (q.st) {
    case S_IDLE: case S_WALK: case S_FOOT: case S_FOOTWALK: { // FUN_800cda54 / FUN_800cdbd0, on foot FUN_800d1c14 / FUN_800d1db4
      if (q.st === S_FOOT) q.md = 1;
      q.g = Math.min(0x100, q.g + 4);
      collide(w, d, q, s);
      anim(w, d, q, s);
      const still = q.st === S_IDLE || q.st === S_FOOT;
      if (still ? (q.held & 0xf0) : !(q.held & 0xf0)) setState(w, d, q, s, still ? (q.md === 1 ? S_FOOTWALK : S_WALK) : q.md === 1 ? S_FOOT : S_IDLE);
      dashCheck(w, d, q, s);
      throwCheck(w, d, q, s);
      edgeTest(w, d, q, s);
      pillars(w, d, q, s);
      break;
    }
    case S_THROW: // FUN_800d2eb0: one tick
      setState(w, d, q, s, q.md === 1 ? S_FOOT : S_IDLE);
      anim(w, d, q, s);
      break;
    case S_OFF: // FUN_800d2d9c: still slides, bumps and can fall while the clip runs
      anim(w, d, q, s);
      edgeTest(w, d, q, s);
      collide(w, d, q, s);
      pillars(w, d, q, s);
      break;
    case S_BURN: // FUN_800d2334: out after 60 ticks
      q.vx = q.vz = q.tvz = 0;
      if (q.k === 4) burst(w);
      if (q.k === 0x3c) setState(w, d, q, s, S_OUT);
      if (--q.s98 < 0) { q.s98 = ri(w, 7) + 1; fx(w, 0x1000); fx(w, 0x1000); } // two sparks (0x1612)
      break;
    case S_FROZEN: // FUN_800cfb7c: no pad, turns slowly, still bumps and slips
      q.held = q.pressed = 0;
      collide(w, d, q, s);
      edgeTest(w, d, q, s);
      pillars(w, d, q, s);
      q.lk = 2;
      q.yaw = s16(q.yaw + 0x10);
      q.tvx = q.tvz = 0;
      break;
    case S_BALL: // FUN_800d17e8: rolls (no dash), the pad steers at speed 0x10
      q.g = Math.min(0x100, q.g + 4);
      collide(w, d, q, s);
      edgeTest(w, d, q, s);
      pillars(w, d, q, s);
      break;
    case S_DASH: { // FUN_800d2f48 + FUN_800d0a6c
      collide(w, d, q, s);
      const u = q.af, id = q.ch;
      if (q.md === 0 && (id === 3 || id === 4)) {
        q.lk = 0;
        if (u === 10) { impulse(q, false); q.acx = q.acz = 6; q.dcx = q.dcz = 3; q.lk = 2; }
      } else if (q.md === 0 && (id === 5 || id === 6)) {
        if (u === 6) impulse(q, false);
        if (u < 6) q.vx = q.vz = q.tvx = q.tvz = 0;
      } else if (u === 1) impulse(q, true);
      anim(w, d, q, s);
      edgeTest(w, d, q, s);
      pillars(w, d, q, s);
      break;
    }
    case S_SLIP: { // FUN_800d0060
      if (q.pst === 0x4c || q.pst === 0x52 || q.pst === S_STUN || q.pst === 0x5a || q.md === 1 || q.ac) {
        q.y += 0x60; q.ac = 1;
        eliminate(w, d, q, s);
        if (q.y > 0x400) setState(w, d, q, s, S_OUT);
        break;
      }
      if (q.ss === 0) q.ss = sq(imul(q.vx, q.vx) + imul(q.vz, q.vz));
      q.ty = (((at2(q.x, q.z) + 0x800) & 0xfff) + 0x800) & 0xffff;
      q.tvx = q.tvz = q.vx = q.vz = 0;
      if (q.pressed & 0x8000) q.pr++;
      if (q.af < 0x21) {
        if (q.ss < 0x4a && q.pr > 4) { // FUN_800cff44: climb back, 74 u/f inward
          const a = (at2(q.x, q.z) + 0x800) & 0xfff;
          q.ty = (a + 0x800) & 0xffff;
          q.vx = (SIN(a) * 0x25) >> 11; q.vz = (T(a) * 0x25) >> 11;
          q.x += q.vx; q.z += q.vz;
          q.ss = 0;
          E(w, 'climb', q.x, q.z, s, 1);
          setState(w, d, q, s, S_IDLE);
          return;
        }
      } else eliminate(w, d, q, s);
      anim(w, d, q, s);
      break;
    }
    case S_STUN: { // FUN_800ce664: 182 ticks, no pad, still bumps and slips
      if (q.s98-- < 0) { q.s98 = ri(w, 8) + 0x18; fx(w, 0x1000); fx(w, 0x1000); E(w, 'dazed', q.x, q.z, s, 1); } // two star objects (0x1612), one rand each (replay count)
      q.held = q.pressed = 0;
      collide(w, d, q, s);
      edgeTest(w, d, q, s);
      pillars(w, d, q, s);
      q.lk = 2;
      if (q.sc1c > 0x1e && q.md === 0) q.yaw = s16(q.yaw + 0x10); // dazed spin (not on foot)
      if (q.sc1c++ >= 0xb5 && q.st === S_STUN) { q.mass = massOf(q); setState(w, d, q, s, q.md === 1 ? S_FOOT : S_IDLE); } // FUN_800b5684 then 0x49 / 0x54
      break;
    }
    case S_WIN:
      q.held = q.pressed = 0;
      q.lk = 0x14;
      q.yaw = s16(q.yaw + (adiff(q.yaw, 0) >> 2));
      q.vx = q.vz = q.tvx = q.tvz = 0;
      break;
    case S_BLAST: // FUN_800d30c0: frozen in the blast; flagged out after 123 ticks (replay), the state stays 0x4d
      q.held = q.pressed = 0; q.vx = q.vz = q.tvx = q.tvz = 0;
      if (q.k >= 123) q.fl |= F_OUT | F_ELIM;
      break;
  }
}

function impulse(q: PoP, hold: boolean) {
  const v = dashSpeed(q);
  q.vx = m12(v, T(q.ty + 0x400)); q.vz = m12(v, T(q.ty + 0x800));
  q.tvx = hold ? q.vx : 0; q.tvz = hold ? q.vz : 0;
}

/** FUN_800cccb8: pad -> heading target and target velocity, plus the tilt slide. */
function padTick(d: Data, q: PoP) {
  if (q.lk) { q.held = 0; q.pressed = 0; }
  if (q.st !== S_DASH) { q.tvx = 0; q.tvz = 0; }
  if ((!q.cpu || q.pc || q.ai.on) && (q.held & 0xf0)) {
    q.ty = (q.ang + 0x800) & 0xfff;
    q.tvx = m12(q.spd, T(q.ty + 0x400));
    q.tvz = m12(q.spd, T(q.ty + 0x800));
  }
  const m = (q.mass * 3) >> 3;
  q.tvx = (q.tvx + m12(m, SIN(d.ax))) | 0;
  q.tvz = (q.tvz - m12(m, SIN(d.az))) | 0;
  if (q.fl & F_WON) { q.tvx = q.tvz = q.vx = q.vz = 0; }
  if (Math.abs(adiff(q.ty, q.qy)) > 0x110) q.qy = (q.ty + 0x100) & 0xe00;
}

/** FUN_800b5788 (+ FUN_800b5570 yaw): yaw += diff/4, velocity toward the target by accel/decel, move. */
function integrate(q: PoP) {
  if (q.lk === 0) q.yaw = s16(q.yaw + (adiff(q.yaw, q.ty) >> (q.st === S_BALL ? 5 : 2)));
  const ax = (v: number, t: number, ac: number, dc: number) => {
    if (v === t) return v;
    const st = t === 0 ? dc : ac;
    if (v < t) { v += st; return t < v ? t : v; }
    v -= st; return v < t ? t : v;
  };
  q.vx = ax(q.vx, q.tvx, q.acx, q.dcx);
  q.vz = ax(q.vz, q.tvz, q.acz, q.dcz);
  q.z = (q.z + q.vz) | 0; q.x = (q.x + q.vx) | 0;
}

// ---------------------------------------------------------------- CPU AI
/** FUN_800bfee0 with origin 0: does the circle (c, r) lie on the -dir side of the line through 0 (the bear's front)? int32 like the original. */
function ray(dx: number, dz: number, cx: number, cz: number, r: number): boolean {
  const A = (imul(dx, dx) + imul(dz, dz)) >> 8;
  const B = imul(imul(dx, cx) + imul(dz, cz), 2) >> 8;
  const disc = (imul(B, B) + imul(imul(A, ((imul(cx, cx) + imul(cz, cz)) - imul(r, r)) >> 8), -4)) | 0;
  if (disc < 0) return false;
  const s = sq(disc), A2 = A << 1;
  if (A2 === 0) return false;
  const t1 = Math.trunc(imul(-B + s, 0x100) / A2), t2 = Math.trunc(imul(-B - s, 0x100) / A2);
  return !(t1 < 0 && t2 < 0);
}
/** FUN_800b7a58: rival q in front of p (forward ray of DAT_800d4e04, radius 200)? */
function ahead(d: Data, p: PoP, q: PoP): boolean {
  return ray(m12(d.rayLen, SIN(p.yaw)), m12(d.rayLen, T(p.yaw)), s16(q.x - p.x), s16(q.z - p.z), 200);
}
/** nearest other bear (not out, not hidden), FUN_800b7b88 / cb178 */
function nearest(d: Data, s: number, init = 0x7ffffff): [number, number] {
  let best = init, bi = -1;
  const p = d.P[s]!;
  for (let i = 0; i < 4; i++) {
    const o = d.P[i];
    if (i === s || !o || (o.fl & (F_ELIM | F_OUT))) continue;
    const dd = dist2(o.x, o.z, p.x, p.z);
    if (dd < best) { best = dd; bi = i; }
  }
  return [bi, best];
}
/** FUN_800b5ebc: pad bits toward (tx,tz); the pad angle is refreshed every per+1 ticks. */
function steer(q: PoP) {
  const a = q.ai;
  let b = a.tx < a.sx ? 0x80 : 0;
  if (a.sx < a.tx) b |= 0x20;
  if (a.tz < a.sz) b |= 0x40;
  if (a.sz < a.tz) b |= 0x10;
  a.bits |= b;
  if (q.lk === 0) q.held = a.bits;
  const c = a.c24;
  a.c24 = s16(c - 1);
  if (c === 0) { a.a2a = padAngle(a.bits); a.c24 = s16(a.per); }
  if (q.lk === 0) q.ang = a.a2a;
}
const aim = (q: PoP, tx: number, tz: number) => { q.ai.tx = tx; q.ai.tz = tz; q.ai.sx = q.x; q.ai.sz = q.z; };
/** FUN_800b60b8: dash when a rival is close and in front. */
function aiDash(d: Data, q: PoP, s: number) {
  const [n, dd] = nearest(d, s);
  if (n < 0 || dd >= 0x40000 || !ahead(d, q, d.P[n]!)) return;
  if (dashCost(q) > q.g) return;
  const c = q.ai.dcd; q.ai.dcd = c - 1;
  if (c >= 1 || (q.ai.bits & 0x8000)) return;
  if (q.sk > 0x20) q.sk = 0x20;
  q.ai.bits |= 0x8000;
  q.ai.dcd = 0x40 - T52E0(q.sk);
}
/** MANIC bolts (list DAT_800d5294): FUN_800cb56c = does bear s carry one; the first one still lying on the ice */
const carries = (d: Data, s: number) => d.bolts.some((b) => b.k === 0 && b.st === 1 && b.own === s);
const freeBolt = (d: Data) => d.bolts.find((b) => b.k === 0 && b.st === 0);
/** FUN_800b6eb4: throw (Circle) at rival t when closer than 2000, in front, and the bolt was held for 0x1f decide() calls. */
function aiThrow(d: Data, q: PoP, t: number) {
  const o = d.P[t];
  if (!o || dist2(q.x, q.z, o.x, o.z) > 3999999 || q.ai.f54 < 0x1f) return;
  if (ahead(d, q, o)) q.ai.bits |= 0x2000;
}
/** the MANIC lines of the handlers: carrying a bolt -> throw at the nearest rival (FUN_800cb178) */
function aiThrowNearest(d: Data, q: PoP, s: number) {
  if (d.variant !== 'manic' || !carries(d, s)) return;
  const [n] = nearest(d, s);
  if (n !== -1) aiThrow(d, q, n);
}
/** FUN_800b3740: weighted random rival (equal weights 16 -> each candidate 4096/n), -1 if the roll misses. */
function pickRival(w: World, d: Data, s: number): number {
  const r4 = ri(w, 4), r = ri(w, 0x1000);
  let n = 0;
  for (let i = 0; i < 4; i++) if (i !== s && !elim(d.P[i])) n++;
  for (let u = r4; u < r4 + 4; u++) {
    const q = u & 3;
    if (q === s) continue;
    const wq = elim(d.P[q]) ? -1 : n ? Math.trunc((16 << 19) / (n * 16 * 0x80)) : 0;
    if (r < wq) return q;
  }
  return -1;
}
/** FUN_800b649c: random first live rival from rand(4). */
function randomRival(w: World, d: Data, s: number) {
  const a = d.P[s]!.ai;
  let n = 0;
  for (let i = 0; i < 4; i++) { if (elim(d.P[i])) n++; a.st = H_IDLE; if (n > 2) return; }
  a.tgt = ri(w, 4); a.per = 1;
  for (let k = 0; k < 8; k++) {
    const i = a.tgt;
    if (i !== s && !elim(d.P[i])) {
      if (!(a.fl & 2)) return;
      let last = -1;
      for (let j = 0; j < 4; j++) if (j !== s && !elim(d.P[j]) && dist2(d.P[j]!.x, d.P[j]!.z, d.P[s]!.x, d.P[s]!.z) < 0x7ffffff) last = j;
      if (last === -1) { a.st = H_IDLE; a.h = H_IDLE; return; }
      a.tgt = last; return;
    }
    a.tgt = (i + 1) & 3;
  }
}
const prob = (q: PoP, off: number) => PROB[q.ch + off] ?? 0;

/** behaviours tried from a random start when idle (0x800d4df0) */
function behaviour(w: World, d: Data, q: PoP, s: number, k: number): boolean {
  const a = q.ai;
  switch (k) {
    case 0: { // FUN_800b94b8 attack a random rival
      const r = ri(w, 0x1000);
      if (q.md === 1 || r >= prob(q, -1)) return false;
      randomRival(w, d, s);
      a.cnt = ri(w, 0x78) + 0x3c;
      const t = pickRival(w, d, s);
      if (t === -1) a.fl |= 2; else { a.tgt = t; a.fl &= ~2; }
      a.st = H_ATTACK; a.h = H_ATTACK;
      return true;
    }
    case 1: { // FUN_800b9600 go for the mask's item
      if (d.variant === 'melt') return false;
      let r = ri(w, 0x1000);
      if (d.P.some((o) => o && o.cpu && o.ai.st === H_ITEM)) r = 0x7fff;
      if (r >= prob(q, 0x27)) return false;
      a.cnt = ri(w, 0x168) + 0x5a;
      a.st = H_ITEM; a.h = H_ITEM;
      return true;
    }
    case 2: { // FUN_800b9714 wander to a random point on the 1800 ring
      if (q.md === 1) return false;
      if (ri(w, 0x1000) >= prob(q, 0x2f)) return false;
      const u = ri(w, 0x1000);
      a.tx = (T(u) * 0x708) >> 12; a.tz = (SIN(u) * 0x708) >> 12; a.sx = q.x; a.sz = q.z;
      a.st = H_WANDER; a.h = H_WANDER;
      return true;
    }
    case 3: { // FUN_800b9994 go after a rival far from the centre
      const r3 = ri(w, 3);
      if (ri(w, 0x1000) >= prob(q, 0x1f)) return false;
      for (let u = r3; u < r3 + 4; u++) {
        const i = u & 3;
        if (i === s || elim(d.P[i]) || !(d.flags[i] & 1)) continue;
        a.tgt = i;
        let n = 0, early = false;
        for (let j = 0; j < 4; j++) { if (elim(d.P[j])) n++; a.st = H_NOP4; a.h = H_NOP4; if (n > 2) { early = true; break; } }
        if (!early) { a.per = 1; a.cnt = ri(w, 0x3c) + 5; }
        a.st = H_HELP; a.h = H_HELP;
        return true;
      }
      return false;
    }
    default: { // FUN_800b98ac (MANIC PANIC only): go for the bolt
      if (d.variant !== 'manic') return false;
      if (ri(w, 0x1000) >= prob(q, 0x3f)) return false;
      a.cnt = ri(w, 0x168) + 0x5a;
      a.st = H_BOLT; a.h = H_BOLT;
      return true;
    }
  }
}

/** FUN_800b9d48: per-tick situation flags and behaviour choice. */
function decide(w: World, d: Data, q: PoP, s: number) {
  const a = q.ai;
  a.on = 1;
  if (a.st !== H_ATTACK) a.f58 = 0;
  for (let i = 0; i < 4; i++) {
    const o = d.P[i];
    if (!o) continue;
    d.flags[i] = o.st === S_STUN || o.st === 0x5a ? 0x80 : 0;
    const sl = d.seal;
    if (d.variant === 'tilt' && sl && dist2(sl.x, sl.z, q.x, q.z) < 0xb0644 && (sl.st === 1 || sl.st === 5)) d.flags[i] |= 0x100;
    if (o.st === S_OFF) d.flags[i] |= 0x800;
    if (d.variant === 'melt' && o.st === S_BALL) d.flags[i] |= 0x200;
    if (d.variant === 'manic') {
      if (carries(d, i)) { d.flags[i] |= 0x400; o.ai.f54++; }
      else {
        o.ai.f54 = 0;
        // a bolt lies on the ice and this CPU is on foot: every idle bear goes for it
        if (freeBolt(d) && o.ai.h === H_IDLE && q.md === 1) { o.ai.cnt = ri(w, 0x168) + 0x5a; o.ai.st = H_BOLT; o.ai.h = H_BOLT; }
      }
    }
  }
  // FUN_800b6258: hanging CPU decides to climb
  if (q.st === S_SLIP) {
    const [n, dd] = nearest(d, s);
    const roll = () => {
      const r = ri(w, 0x1000);
      if (q.sk > 0x30) q.sk = 0x30;
      const th = T5364(q.sk) * 0x80 + (d.variant === 'tilt' ? 0x400 : 0);
      if (r < th) q.pr = 8;
      if (d.noHuman) q.pr = 0;
    };
    if (n === -1 && q.af === 0x1e) q.pr = 8;
    else {
      if (dd < 0x40000 && ahead(d, q, d.P[n]!)) roll();
      if (q.af === 0x1e) roll();
    }
  }
  aiDash(d, q, s);
  if (q.st === S_SLIP || (q.fl & F_ELIM)) { a.st = H_IDLE; a.h = H_IDLE; return; }
  if (dist2(0, 0, q.x, q.z) > (d.variant === 'tilt' ? CENTRE_R2 : 0x400000)) d.flags[s] |= 1;
  // Uka mask: beaming -> 2, else 1; item holders flag themselves
  d.d5ffc = d.beam > 0 ? 2 : 1;
  if (d.d5ffc === 1) a.f4c &= ~1;
  if (d.c6c !== 5) d.flags[d.c6c] |= d.mk === 5 ? 2 : d.mk === 6 ? 0x40 : 0;
  if (d.mh !== -1) { const k = d.k28[d.mh]; d.flags[d.mh] |= k === 1 ? 4 : k === 0 ? 8 : k === 2 ? 0x20 : 0; }
  if (!(a.f4c & 1) && d.d5ffc === 2 && d.variant !== 'melt') { // FUN_800b9398
    if (d.noHuman) { a.st = H_MASK; a.h = H_MASK; }
    else if (d.c6c !== s) {
      const r = ri(w, 0x1000);
      a.f4c |= 1;
      if (r < prob(q, 0x17)) { a.st = H_MASK; a.h = H_MASK; }
    }
  }
  if (a.st === H_IDLE) {
    let k = ri(w, 5);
    for (let n = 0; n < 5; n++) { if (behaviour(w, d, q, s, k)) break; if (++k > 4) k = 0; }
  }
  const attack = (i: number, cnt = 0xd2) => {
    d.d6004 = -1;
    if (a.st !== H_ATTACK || a.cnt === 0) a.cnt = cnt;
    a.st = H_ATTACK; a.per = 1; a.h = H_ATTACK; a.tgt = i; a.fl &= ~2;
  };
  for (let i = 0; i < 4; i++) {
    const o = d.P[i];
    if (i === s || !o || o.st === S_SLIP || (o.fl & F_ELIM)) continue;
    const f = d.flags[i];
    if ((f & 0x400) && dist2(q.x, q.z, o.x, o.z) < 0x4d1c40) attack(i); // a rival with a bolt nearby: rush it
    if (f & 4) { d.d6004 = -1; if (a.st !== H_EVADE || a.cnt === 0) a.cnt = 0xd2; a.st = H_EVADE; a.h = H_EVADE; a.ev = i; a.per = 1; a.fl |= 1; }
    if (f & 8) attack(i);
    if (f & 0x20) attack(i);
    if (f & 2) { d.d6004 = -1; if (a.cnt < 1 && (a.st !== H_EVADE || a.cnt === 0)) a.cnt = 0x168; a.st = H_EVADE; a.h = H_EVADE; a.ev = i; a.per = 0; a.fl |= 1; }
    if (f & 0x40) attack(i);
    if (f & 0x80) attack(i);
    if ((f & 0x200) && d.d6004 === 1) attack(i);
  }
  const own = d.flags[s];
  const hunt = (per: number, cnt: number) => {
    a.per = per;
    if (a.st !== H_ATTACK || a.cnt === 0) a.cnt = cnt;
    if (a.f58 === 0) {
      const r = pickRival(w, d, s);
      a.f58 = 1;
      a.st = H_ATTACK; a.h = H_ATTACK;
      if (r === -1) { a.tgt = 0; a.fl |= 2; } else { a.tgt = r; a.fl &= ~2; }
    }
  };
  const flee = (st: number, h: number, per: number) => { a.fl |= 1; if (a.st !== H_EVADE || a.cnt === 0) a.cnt = 0xd2; a.st = st; a.per = per; a.ev = 0; a.h = h; };
  if (own & 4) hunt(2, 0xd2);
  if (own & 8) flee(H_EVADE, H_EVADE, 2);
  if (own & 2) hunt(0, 0x168);
  if (own & 0x40) flee(H_EVADE, H_EVADE, 2);
  if (own & 0x100) flee(H_SEAL, H_SEAL, 1);
  if (own & 0x200) flee(H_EVADE, H_EVADE, 2);
  if (own & 0x800) flee(H_EVADE, H_EVADE, 2);
  if (q.st === S_STUN || q.st === 0x4c) { a.on = 0; a.st = H_IDLE; a.h = H_IDLE; }
}

/** evade handlers FUN_800b7f70 (rival) / FUN_800b889c (seal): turn away, run to a free point on the ice in one of 8 directions. */
function evade(w: World, d: Data, q: PoP, s: number, seal: boolean) {
  const a = q.ai;
  if (d.variant === 'tilt') d.rayLen = 0x9f4;
  a.cnt--;
  let fromSeal = false;
  if (!seal) aiThrowNearest(d, q, s);
  if (!seal) aiDash(d, q, s);
  if (a.fl & 1) {
    let best = 0x7fffffff, bi = 0;
    for (let i = 0; i < 4; i++) {
      const o = d.P[i];
      if (i === s || !o || (o.fl & F_ELIM)) continue;
      const dd = dist2(o.x, o.z, q.x, q.z);
      if (dd < best) { best = dd; bi = i; }
    }
    a.ev = bi;
    const sl = d.seal;
    if (seal && d.variant === 'tilt' && sl && dist2(sl.x, sl.z, q.x, q.z) < best) { fromSeal = true; a.ev = 5; }
  }
  const src = fromSeal && d.seal ? { x: d.seal.x, z: d.seal.z } : d.P[a.ev] ?? q;
  q.ty = at2(q.x - src.x, q.z - src.z) & 0xfff;
  const r = seal ? 0x10e : 0xfa;
  const cx = s16(src.x - q.x), cz = s16(src.z - q.z);
  if (dist2(src.x, src.z, q.x, q.z) < 0x283e40) {
    const r8 = ri(w, 8);
    const blocked = (dx: number, dz: number) => {
      for (let i = 0; i < 4; i++) {
        const o = d.P[i];
        if (i === s || i === a.ev || !o || (o.fl & F_ELIM)) continue;
        if (ray(dx, dz, s16(o.x - q.x), s16(o.z - q.z), r)) return true;
      }
      return false;
    };
    const tryDir = (dir: number): boolean => {
      const dx = m12(d.rayLen, SIN(dir)), dz = m12(d.rayLen, T(dir));
      if (ray(dx, dz, cx, cz, r)) return false;
      if (blocked(dx, dz)) return false;
      const px = q.x - dx, pz = q.z - dz;
      // MELT asks the engine's plain hull test (FUN_8008c4c8) for hull 1, the inner disc, whatever the sectors are
      if (!(d.variant === 'melt' && !seal ? hullInside(HULL_MELT_IN, px, pz) : onIce(d, px, pz))) return false;
      aim(q, px, pz); steer(q);
      return true;
    };
    if (!tryDir(a.dir)) {
      for (let u = r8; u < r8 + 8; u++) { const dir = EV8[u & 7]; if (tryDir(dir)) { a.dir = dir; break; } }
    }
  }
  if (d.flags[s] & 1) { a.st = H_CENTRE; a.cnt = 0x5a; a.h = H_CENTRE; }
  if (a.cnt < 1) { a.st = H_IDLE; a.h = H_IDLE; a.fl &= ~1; }
}

function handler(w: World, d: Data, q: PoP, s: number) {
  const a = q.ai;
  switch (a.h) {
    case H_ATTACK: { // FUN_800b6708
      a.per = 1;
      const tg = d.P[a.tgt];
      if ((a.fl & 2) && (elim(tg) || tg?.st === S_OUT)) {
        let best = 0x7fffffff, bi = 0;
        for (let i = 0; i < 4; i++) {
          const o = d.P[i];
          if (i === s || !o || (o.fl & F_ELIM) || tg?.st === S_OUT) continue;
          const dd = dist2(o.x, o.z, q.x, q.z);
          if (dd < best) { best = dd; bi = i; }
        }
        a.tgt = bi;
      }
      const t1 = d.P[a.tgt];
      const hang = q.md === 1 && t1?.st === S_SLIP;
      if (elim(t1) || hang || t1?.st === S_OUT) {
        let best = 0x7fffffff, bi = 0;
        if (!(a.fl & 2)) {
          const r = pickRival(w, d, s);
          if (r === -1) {
            for (let i = 0; i < 4; i++) {
              const o = d.P[i];
              if (i === s || !o || (o.fl & F_ELIM) || hang || t1?.st === S_OUT) continue;
              const dd = dist2(o.x, o.z, q.x, q.z);
              if (dd < best) { best = dd; bi = i; }
            }
            a.st = H_ATTACK; a.tgt = bi; a.h = H_ATTACK; a.fl |= 2;
          } else a.tgt = r;
        } else {
          for (let i = 0; i < 4; i++) {
            const o = d.P[i];
            if (i === s || !o || (o.fl & F_ELIM) || hang || o.st === S_OUT) continue;
            const dd = dist2(o.x, o.z, q.x, q.z);
            if (dd < best) { best = dd; bi = i; }
          }
          a.tgt = bi;
        }
      }
      if (d.variant === 'manic' && carries(d, s)) aiThrow(d, q, a.tgt);
      const c = a.cnt; a.cnt = c - 1;
      if (c < 1) { a.st = H_IDLE; a.h = H_IDLE; a.fl &= ~2; }
      if (hang) { a.st = H_IDLE; a.h = H_IDLE; a.fl &= ~2; break; }
      aiDash(d, q, s);
      const t = d.P[a.tgt] ?? q;
      aim(q, t.x, t.z); steer(q);
      break;
    }
    case H_MASK: { // FUN_800b782c: stand under the beaming mask
      aiThrowNearest(d, q, s);
      a.per = 1;
      aim(q, d.mx, d.mz);
      if (dist2(q.x, q.z, d.mx, d.mz) < 0x19000) { a.st = H_IDLE; a.h = H_IDLE; }
      if (d.d5ffc === 1) { a.st = H_IDLE; a.h = H_IDLE; }
      steer(q);
      break;
    }
    case H_EVADE: evade(w, d, q, s, false); break;
    case H_SEAL: evade(w, d, q, s, true); break;
    case H_HELP: { // FUN_800b767c
      let n = 0;
      for (let i = 0; i < 4; i++) { if (elim(d.P[i])) n++; a.st = H_IDLE; a.h = H_IDLE; if (n > 2) return; }
      const t = d.P[a.tgt];
      if (elim(t)) { a.st = H_NOP4; a.h = H_NOP4; }
      const c = a.cnt; a.cnt = c - 1;
      if (c < 0) { a.st = H_IDLE; a.h = H_IDLE; }
      if (!t || t.st === S_SLIP) { a.st = H_IDLE; a.h = H_IDLE; } else { aim(q, t.x, t.z); steer(q); }
      break;
    }
    case H_ITEM: { // FUN_800b6d74: follow the mask
      aiThrowNearest(d, q, s);
      a.per = 1;
      aim(q, d.mx, d.mz);
      const c = a.cnt; a.cnt = c - 1;
      if (c < 0) { a.st = H_IDLE; a.h = H_IDLE; a.fl &= ~1; }
      aiDash(d, q, s);
      steer(q);
      break;
    }
    case H_WANDER: { // FUN_800b7520
      a.sx = q.x; a.sz = q.z;
      if (dist2(a.tx, a.tz, a.sx, a.sz) < 0x24001) { a.cnt = ri(w, 0x78); a.st = H_WAIT; a.h = H_WAIT; } else steer(q);
      if (d.variant === 'tilt' && (d.flags[s] & 1)) { a.st = H_CENTRE; a.cnt = 0x5a; a.h = H_CENTRE; }
      break;
    }
    case H_WAIT: { // FUN_800b7224: stand, face the nearest bear, go evasive when one comes close
      let best = 0x7fffffff, bi = 0;
      // carrying a bolt: FUN_800cb178 leaves the nearest rival's distance in the same local, so the loop below finds nobody nearer
      // and the bear faces slot 0 (and evades "from" slot 0)
      if (d.variant === 'manic' && carries(d, s)) { const [n, dd] = nearest(d, s); best = dd; if (n !== -1) aiThrow(d, q, n); }
      for (let i = 0; i < 4; i++) {
        const o = d.P[i];
        if (i === s || !o || (o.fl & F_ELIM)) continue;
        const dd = dist2(o.x, o.z, q.x, q.z);
        if (dd < best) { best = dd; bi = i; }
      }
      const o = d.P[bi]!;
      q.ty = at2(q.x - o.x, q.z - o.z) & 0xfff;
      if (best < 0x100000) { a.ev = bi; a.cnt = 0x5a; aiDash(d, q, s); a.st = H_EVADE; a.h = H_EVADE; a.fl |= 1; }
      const c = a.cnt; a.cnt = c - 1;
      if (c < 0) { a.st = H_IDLE; a.h = H_IDLE; a.fl &= ~1; }
      if (d.flags[s] & 1) { a.st = H_CENTRE; a.cnt = 0x5a; a.h = H_CENTRE; }
      break;
    }
    case H_CENTRE: { // FUN_800b90c0: walk back to the middle
      aiThrowNearest(d, q, s);
      a.per = 1;
      aim(q, 0, 0);
      if (dist2(q.x, q.z, 0, 0) < 0x19000) { a.st = H_IDLE; a.h = H_IDLE; }
      const c = a.cnt; a.cnt = c - 1;
      if (c < 1) { a.st = H_IDLE; a.h = H_IDLE; }
      steer(q);
      break;
    }
    case H_BOLT: { // FUN_800b6fec (MANIC): walk to the bolt; once carrying it pick a rival and attack
      if (carries(d, s)) {
        randomRival(w, d, s);
        a.cnt = ri(w, 0x78) + 0x3c;
        const t = pickRival(w, d, s);
        if (t === -1) a.fl |= 2; else { a.tgt = t; a.fl &= ~2; }
        a.st = H_ATTACK; a.h = H_ATTACK;
        break;
      }
      const b = freeBolt(d);
      if (!b) { a.st = H_IDLE; a.h = H_IDLE; break; }
      a.per = 1;
      aim(q, b.x, b.z);
      const c = a.cnt; a.cnt = c - 1;
      if (c < 0) { a.st = H_IDLE; a.h = H_IDLE; }
      aiDash(d, q, s);
      steer(q);
      break;
    }
    default: break; // 4, 5: nothing
  }
}

/** FUN_800cad60 */
function aiTick(w: World, d: Data, q: PoP, s: number) {
  q.ai.bits = 0;
  decide(w, d, q, s);
  handler(w, d, q, s);
  q.nb = q.ai.bits;
}

// ---------------------------------------------------------------- TILT seal (object 0x160c, FUN_800c32a4 / FUN_800c358c)
/**
 * FUN_800c2ecc: bear vs the seal's box (+-200 x +-0x180 in the seal's frame, grown by r = 0x100, or 300 for the slip test).
 * Closer than r to the box -> the bear is pushed out along the face normal (corners: both axes, not normalised). A centre
 * inside the box is not touched.
 */
function sealBox(sl: Seal, q: PoP, r: number): boolean {
  const dx = q.x - sl.x, dz = q.z - sl.z, c = T(sl.yaw), sn = SIN(sl.yaw);
  const lx = (imul(c, dx) - imul(sn, dz)) >> 12, lz = (imul(sn, dx) + imul(c, dz)) >> 12; // Ry(-yaw) (FUN_80032cac / FUN_800330cc)
  const f = (lx < -200 ? 2 : 0) | (lz < -0x180 ? 4 : 0) | (lx > 200 ? 1 : 0) | (lz > 0x180 ? 8 : 0);
  if (f === 0 || (f & 3) === 3 || (f & 12) === 12) return false;
  const ex = f & 1 ? lx - 200 : lx + 200, ez = f & 8 ? lz - 0x180 : lz + 0x180;
  const nx = f & 1 ? 0x1000 : f & 2 ? -0x1000 : 0, nz = f & 8 ? 0x1000 : f & 4 ? -0x1000 : 0;
  const dist = nx && nz ? sq(imul(ex, ex) + imul(ez, ez)) : nx ? Math.abs(ex) : Math.abs(ez);
  if (dist >= r) return false;
  const push = Math.abs(r - dist);
  const wx = (imul(c, nx) + imul(sn, nz)) >> 12, wz = (imul(c, nz) - imul(sn, nx)) >> 12; // Ry(yaw) (FUN_8003278c)
  q.x = (q.x + (imul(push, wx) >> 12)) | 0; q.z = (q.z + (imul(push, wz) >> 12)) | 0;
  return true;
}
/** FUN_800ca930: elastic exchange per axis between the bear (mass +0x4e) and the seal's motion component (mass 0x400), no clamp. */
function sealBump(sl: Seal, q: PoP) {
  const m1 = q.mass, m2 = 0x400;
  if (m1 <= 0) return;
  const ax = (u1: number, u2: number): [number, number] => {
    const df = (u1 - u2) | 0;
    const r = Math.trunc(((imul(imul(df, -0x100), m2) + imul(imul(m1, u1) + imul(m2, u2), 0x100)) | 0) / (m1 + m2)) | 0;
    return [r >> 8, (r + imul(df, 0x100)) >> 8];
  };
  [q.vx, sl.mvx] = ax(q.vx, sl.mvx);
  [q.vz, sl.mvz] = ax(q.vz, sl.mvz);
}
/** Rim point of the seal for DAT_800d563c = base: 3100 units out, 0x400 under the ice; it jumps to the point 2000 out. */
function sealPlace(sl: Seal, base: number) {
  sl.base = base;
  sl.x = (SIN(base) * 0x307) >> 10; sl.y = 0x400; sl.z = (T(base) * 0x307) >> 10;
  sl.sx = sl.x; sl.sy = sl.y; sl.sz = sl.z;
  sl.tx = (SIN(base) * 0x7d) >> 8; sl.tz = (T(base) * 0x7d) >> 8;
  sl.yaw = at2(sl.x, sl.z) & 0xfff;
  sl.go = 0;
}
function newSeal(w: World): Seal {
  const sl: Seal = { st: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, go: 0, vy: 0, vx: 0, vz: 0, sx: 0, sy: 0, sz: 0, tx: 0, tz: 0, pc: -1, spd: 0, tgt: 0, dir: 0, base: 0, mvx: 0, mvz: 0, on: 0 };
  sealPlace(sl, 0x240); // DAT_800d563c
  sl.t = ri(w, 8) * 0x1e + 0x10e;
  return sl;
}
/** FUN_8008c5c4 for the seal: speed 0x28, gravity 0x10, floor 0; true once it has landed. */
function sealFly(sl: SealFlight): boolean {
  if (!sl.go) {
    const dx = sl.tx - sl.sx, dz = sl.tz - sl.sz;
    const n = Math.trunc(sq(imul(dx, dx) + imul(dz, dz)) / 0x28);
    if (n === 0) return true;
    sl.vy = Math.trunc(-sl.sy / n) - (n >> 1) * 0x10;
    const hd = at2(dx, dz) & 0xfff;
    sl.vx = m12(0x28, SIN(hd)); sl.vz = m12(0x28, T(hd));
    sl.go = 1;
  }
  sl.y += sl.vy; sl.vy += 0x10; sl.x += sl.vx; sl.z += sl.vz;
  if (sl.y >= 0 && sl.vy > 0) { sl.y = 0; return true; }
  return false;
}
/** FUN_800c40b8: the fish spins in flight, then skids and flaps on the ice. */
function stepSealFish(w: World, f: SealFish) {
  f.yaw = s16(f.yaw + f.spin);
  f.pitch = s16(f.pitch + 0x100);
  if (!f.landed) {
    f.landed = sealFly(f);
    if (f.landed) E(w, 'sealSound', f.x, f.z, -1, 0x479);
    return;
  }
  f.frame = (f.frame + 1) & 15;
  f.x += f.vx;
  f.z += f.vz;
  f.spin >>= 1;
  f.pitch >>= 1;
  f.vx -= Math.sign(f.vx);
  f.vz -= Math.sign(f.vz);
}

/**
 * FUN_800c358c. 0 waits under the rim (timer; needs the mask idle) -> 2 warning (object 0x1610, 91 ticks) -> 3 / 4 jumps in
 * (27 ticks to the point 2000 out) -> 1 lands (12 ticks; from here the bears collide with it) -> 5 turns round at 16 u/tick and
 * waddles back out until the point 128 behind it leaves the ice -> 7 dives (38 ticks) -> 6 moves to the opposite rim point, waits
 * rand(900) + 90. Its motion velocity (what a bump exchanges with) is the jump velocity, except 0 while it walks.
 */
function sealTick(w: World, d: Data) {
  const sl = d.seal;
  if (!sl) return;
  sl.mvx = sl.vx; sl.mvz = sl.vz;
  if (sl.fish) stepSealFish(w, sl.fish);
  switch (sl.st) {
    case 0:
      if (sl.t-- < 0 && !d.over && d.ms === 1 && d.mh === -1) {
        sl.st = 2; sl.t = 0x5a;
        sl.fish = {
          x: sl.sx, y: sl.sy, z: sl.sz, sx: sl.sx, sy: sl.sy, sz: sl.sz, tx: sl.tx, tz: sl.tz,
          go: 0, vy: 0, vx: 0, vz: 0, yaw: 0, pitch: 0, spin: 0x80, landed: false, frame: -1,
        };
        E(w, 'seal', sl.tx, sl.tz, -1, 2);
      }
      break;
    case 2: if (!d.over && sl.t-- < 0) { sl.st = 3; sl.t = 0; E(w, 'seal', sl.x, sl.z, -1, 3); } break;
    case 3:
      sl.t++; sl.pc++;
      sl.pose = 0x4000 + Math.max(0, sl.pc - 6);
      sealFly(sl);
      sl.mvx = sl.vx; sl.mvz = sl.vz;
      if (sl.pc === 0x18) { sl.st = 4; sl.pc = 0; }
      break;
    case 4:
      sl.pose = 0x4013;
      if (!sealFly(sl)) break;
      const bark = ri(w, 4);
      sl.st = 1; sl.t = 0x96; sl.pc = 0;
      E(w, 'seal', sl.x, sl.z, -1, 1, bark);
      break;
    case 1:
      sl.on = 1;
      sl.pc++;
      sl.pose = 0x4014 + sl.pc;
      if (sl.pc === 12) { delete sl.fish; sl.st = 5; sl.pc = 0; sl.t = 0; sl.tgt = 0x10; sl.spd = 0; sl.dir = sl.yaw + 0x800; }
      break;
    case 5: {
      sl.pc = (sl.pc + 1) & 15;
      sl.pose = 0x4080 + sl.pc;
      if (sl.pc === 7 || sl.pc === 13) E(w, 'sealSound', sl.x, sl.z, -1, sl.pc === 7 ? 0x476 : 0x477);
      sl.yaw = s16(sl.yaw - (((sl.yaw - sl.dir) << 20) >> 24));
      if (sl.spd < sl.tgt) sl.spd = sl.tgt; // the ramp code at 0x800c3a.. ends on the target in one step (replay)
      if (++sl.t === 30) E(w, 'sealSound', sl.x, sl.z, -1, 0x47a);
      sl.x = (sl.x - m12(sl.spd, SIN(sl.yaw))) | 0; sl.z = (sl.z - m12(sl.spd, T(sl.yaw))) | 0;
      sl.mvx = sl.mvz = 0;
      if (!hullInside(HULL_RAW, sl.x + (SIN(sl.yaw) >> 5), sl.z + (T(sl.yaw) >> 5))) { sl.st = 7; sl.pc = 0; E(w, 'seal', sl.x, sl.z, -1, 7); }
      break;
    }
    case 7:
      sl.pc++;
      sl.pose = 0x4100 + sl.pc;
      if (sl.pc === 38) { sl.pc++; sl.st = 6; }
      break;
    case 6:
      sl.t = ri(w, 900) + 0x5a; sl.st = 0; sl.on = 0; sl.pc = 0;
      sealPlace(sl, sl.base + 0x800);
      break;
  }
}

/** Engine mode 1. Store the eased translation so a late client can reproduce the result shot. */
function updatePolarCamera(d: Data, result: boolean, winner: boolean, trackHazards: boolean) {
  const boxes: TrackBox[] = [];
  const add = (x: number, y: number, z: number, yaw: number, r: number, h: number, f: number) => {
    boxes.push(result ? { x, y, z, xl: r >> 1, xr: r >> 1, zn: 0, zf: 0, h: h - (h >> 2) } : trackBox(x, y, z, yaw, r, h, f));
  };
  if (d.variant === 'melt' && trackHazards) {
    const marker = d.meltCamera;
    add(marker?.[0] ?? 0, marker ? 256 : 0, marker?.[1] ?? 0, 0, 512, 512, 512);
  }
  const seal = d.seal;
  if (seal && seal.st >= 1 && seal.st !== 2 && trackHazards) {
    add(seal.x, seal.y, seal.z, seal.yaw, 512, 512, 512);
  }
  for (let slot = d.P.length - 1; slot >= 0; slot--) {
    const q = d.P[slot];
    if (!q || q.y > 0 || q.st === S_OUT || (q.fl & F_OUT)) continue;
    if (winner && (!(q.fl & F_WON) || !onIce(d, q.x, q.z))) continue;
    add(q.x, q.y, q.z, q.yaw, 512, 1280, 1024);
  }
  const [x, y, z] = d.camera ?? [0, 0, 0];
  const fit = new FitCam({ x, y, z, pitch: d.variant === 'melt' ? 257 : 227, H: 512 });
  if (fit.update(boxes, !d.camera, !result)) d.cameraTarget = fit.destination;
  else if (d.cameraTarget) fit.approach(d.cameraTarget);
  d.camera = [fit.c.x, fit.c.y, fit.c.z];
}

/** Advance a private terminal snapshot. The winner settles into state 0x58. Draws continue with released pads and fixed ice tilt. */
export function stepPolarResultMotion(w: World, outcome: boolean | number = false, cheerTick = 0) {
  w.ev.length = 0;
  const d = w.data as Data;
  d.over = true;
  if (outcome !== false) {
    const winner = typeof outcome === 'number' ? d.P[outcome] : null;
    if (winner) winner.fl |= F_WON;
    for (const q of d.P) if (q) { q.pressed = 0; q.held = 0; }
    advancePolarArena(w, d, !!winner && (winner.st !== S_WIN || winner.k < cheerTick));
    updatePolarCamera(d, true, !!winner, false);
    sync(w, d);
    w.tick++;
    w.time += 1 / 30;
    return;
  }
  let moved = false;
  for (const [slot, q] of d.P.entries()) {
    if (q?.st !== S_SLIP || !(q.fl & F_ELIM)) continue;
    q.pressed = q.held = 0;
    stateTick(w, d, q, slot);
    integrate(q);
    moved = true;
  }
  sealTick(w, d);
  if (moved) sync(w, d);
  w.tick++;
}

// ---------------------------------------------------------------- Uka mask / items (FUN_800bd67c), other hazards
const MASK_ITEMS = [0, 1, 6, 5];
/** MELT mask kinds (0x800d5480): shrink, snowball, freeze, bomb */
const MELT_ITEMS = [0, 8, 2, 5];
export const POLAR_INTRO_TICKS = 112;
/** mask orbit centre = its spawn point (mask data +0x88 / +0x90, read from RAM of each level) */
const MASK_CENTRE: Record<string, [number, number]> = { tilt: [108, -8], polar: [-403, -70], manic: [-141, 312] };
export const MASK_HEIGHT: Record<string, number> = { tilt: -1380, polar: -1246, melt: -1094, manic: -1301 };
function newMaskPose(variant: string): PolarEmitterPose {
  return { y: MASK_HEIGHT[variant] ?? MASK_HEIGHT.tilt, pitch: 0, yaw: 0, roll: 0, tick: 0,
    phase: 0, speed: 12, targetSpeed: 12, effect: null };
}
/** The MIPS shifts sign-extend the low 12 bits before easing the angle. */
const maskTurn = (a: number, target: number) => s16(a - (((a - target) << 20) >> 22));
type MaskRider = Pick<PoP, 'x' | 'y' | 'z' | 'fl'>;
function nearestMaskRider(riders: (MaskRider | null)[], x: number, z: number) {
  let nearest = riders[0];
  let range = Infinity;
  for (const q of riders) {
    if (!q || q.fl & F_ELIM) continue;
    const distance = dist2(x, z, q.x, q.z);
    if (distance < range) { nearest = q; range = distance; }
  }
  return nearest;
}
function maskOrbit(phase: number, cx: number, cz: number): [number, number] {
  const u = phase >> 1;
  return [cx + ((1500 * SIN(SIN(u))) >> 12), cz + ((1500 * T(T(u) & 0xfff)) >> 12)];
}
function aimMask(pose: PolarEmitterPose, q: MaskRider | null, x: number, z: number, down: boolean) {
  if (!q) return;
  pose.yaw = maskTurn(pose.yaw, at2(x - q.x, z - q.z));
  const pitch = down ? 0x400 : at2(q.y - pose.y - 0x1c2, sq(dist2(x, z, q.x, q.z)));
  pose.pitch = maskTurn(pose.pitch, pitch);
}
function meltHover(pose: PolarEmitterPose, leaving: boolean): [number, number] {
  const { phase } = pose;
  if (!leaving) pose.y = MASK_HEIGHT.melt + (SIN(phase) >> 6);
  pose.phase = (phase + (pose.targetSpeed < 0 ? 64 : -64)) & 0xfff;
  return [T(phase) >> 5, (SIN(phase) * 3) >> 5];
}
function aimMeltMask(pose: PolarEmitterPose, pitch: number, yaw: number) {
  pose.pitch += (pitch - pose.pitch) >> 2;
  pose.yaw += (yaw - pose.yaw) >> 2;
  pose.roll = pose.pitch;
}
function meltTravelAxis(value: number, target: number) {
  if (value < target) value += 32;
  if (target < value) value -= 32;
  return value;
}
/** kind -> client item code (pickup event value, world.data.item) */
const CLIENT_ITEM: Record<number, number> = { 0: 1, 1: 2, 5: 3, 6: 5, 2: 4, 8: 6 };
/** FUN_800bbf2c bomb/zap pass: touching the carrier while the fuse runs hands it over (15-tick lockout +0x48). */
function bombPass(w: World, d: Data, q: PoP, s: number, o: PoP, i: number) {
  if (d.t68 <= 0) return;
  let passed = false;
  if (d.c6c === s && d.cool[i] === 0) { d.c6c = i; d.cool[s] = 0xf; d.cool[i] = 0; passed = true; E(w, 'bomb', o.x, o.z, i, 1, s); }
  if (d.c6c === i && !passed && d.cool[s] === 0) { d.c6c = s; d.cool[i] = 0xf; d.cool[s] = 0; E(w, 'bomb', q.x, q.z, s, 1, i); }
}

function maskTick(w: World, d: Data) {
  const pose = d.maskView ??= newMaskPose(d.variant);
  pose.tick++;
  if (pose.effect && ++pose.effect.age > 120) pose.effect = null;
  if (d.variant === 'melt') { meltMaskTick(w, d, pose); return; }
  maskItems(w, d, pose);
  // POLAR: the pickup effect's particle emitter draws 25 rands on four ticks, after the mask's own draws (replay count). In the game
  // it starts on the pickup tick or, if the effect object lands in a pool slot that is not updated any more this tick, one tick later.
  if (d.fxT > 0) { d.fxT--; for (let i = 0; i < 25; i++) fx(w, 0x1000); }
}
function maskItems(w: World, d: Data, pose: PolarEmitterPose) {
  // The target slot is chosen before translation. The angles are evaluated from the new position.
  const [cx, cz] = MASK_CENTRE[d.variant] ?? MASK_CENTRE.tilt;
  const x = d.maskA === 0 ? cx : d.mx;
  const z = d.maskA === 0 ? cz : d.mz;
  const nearest = nearestMaskRider(d.P, x, z);
  if (d.ms === 1) {
    // orbit (FUN_800bd67c): pos = centre (+0x88/+0x90 = spawn point) + 1500 * (SIN(SIN(a/2)), COS(COS(a/2))), then a (DAT_800d5474) += 8
    [d.mx, d.mz] = maskOrbit(d.maskA, cx, cz);
    pose.y = d.over ? pose.y - 16 : (MASK_HEIGHT[d.variant] ?? MASK_HEIGHT.tilt) + (SIN(d.maskA * 16) >> 6);
    d.maskA += 8;
  }
  // FUN_800bd67c item part. Mask +0x14 ms (1 orbit, 2 beam), +0x58 m58 counter, +100 m100 next-beam time, +0x60 beam length 0x78,
  // +0xc mk kind (table 0x800d5458 = 0 shrink, 1 grow, 6 zap, 5 bomb; DAT_8009d908 (no human) maps 0 -> 6, 1 -> 5),
  // +0x10 mh holder, +0x18/+0x28/+0x38 per-player kind (phase 1 / phase 2) and timer, +0x68 t68 bomb/zap fuse, +0x6c c6c carrier (5 = none),
  // +0x70 t70 15-tick flourish, +0x48 pass lockout.
  for (let i = 0; i < 4; i++) { const q = d.P[i]; if (q && !(q.fl & F_ELIM) && d.cool[i] > 0) d.cool[i]--; }
  // DAT_800d544c: the beam clock stops while the TILT seal is out (FUN_800c358c sets it on entry 0 -> 2, clears it on 7 -> 6)
  const sealOut = !!d.seal && d.seal.st !== 0 && d.seal.st !== 6;
  if (d.ms === 1 && !d.over && !sealOut) {
    d.m58++;
    if (d.m100 - d.m58 === 15) E(w, 'beamWarn', d.mx, d.mz);
    if (d.m58 >= d.m100) {
      let k = MASK_ITEMS[ri(w, 4)];
      if (d.noHuman) k = k === 0 ? 6 : k === 1 ? 5 : k;
      d.mk = k; d.m58 = 0; d.ms = 2;
      pose.effect = { kind: 'beam', age: 0, x: d.mx, z: d.mz };
      E(w, 'beam', d.mx, d.mz, -1, CLIENT_ITEM[k]);
    }
  }
  const aimingDown = d.ms === 2;
  if (d.ms === 2 && ++d.m58 >= 0x78) { d.ms = 1; d.m58 = 0; E(w, 'beamEnd', d.mx, d.mz, -1, 0); }
  aimMask(pose, nearest, d.mx, d.mz, aimingDown);
  if (d.ms === 2) {
    for (let i = 0; i < 4; i++) {
      const q = d.P[i];
      if (!q || (q.fl & F_ELIM) || d.mh !== -1 || dist2(q.x, q.z, d.mx, d.mz) >= 0x19000) continue;
      d.mh = i; d.ms = 1; d.m58 = 0;
      pose.effect = { kind: 'pickup', age: 0, x: d.mx, z: d.mz };
      const k = d.mk;
      if (d.variant === 'polar') d.fxT = 4;
      if (k === 0 || k === 1) {
        d.m100 = ri(w, 0x3c) + 0xd2; d.t38[i] = 0xb4; d.k18[i] = k; d.k28[i] = k; d.t70 = 0;
        q.mass = k === 0 ? 0x50 : 600; q.spd = k === 0 ? 0x40 : 0x20;
      } else { d.m100 = 0x168; d.t38[i] = 0; d.k18[i] = k; d.k28[i] = k; d.t70 = 0xf; }
      setState(w, d, q, i, S_ITEM);
      if (k === 5 || k === 6) q.hold = 0; // bomb / zap: a carried bolt is dropped (its object goes this tick)
      E(w, 'pickup', q.x, q.z, i, CLIENT_ITEM[k]);
    }
  }
  const h = d.mh;
  if (h === -1) { d.beam = d.ms === 2 ? 0x78 - d.m58 : 0; return; }
  const q = d.P[h]!;
  if (d.t38[h] > 0) d.t38[h]--;
  if (d.t70 > 0) d.t70--;
  const toIdle = () => { d.k18[h] = -1; setState(w, d, q, h, q.md === 1 ? S_FOOT : S_IDLE); }; // on foot (MANIC) back to 0x54
  switch (d.k18[h]) {
    case 0: if (d.t70 < 1) { if (q.sc < 0xa01) toIdle(); else q.sc -= 0x100; } break;
    case 1: if (d.t70 < 1) { if (q.sc > 6000) toIdle(); else q.sc += 0x100; } break;
    case 5: case 6: if (d.t70 < 1) { d.c6c = h; d.t68 = 300; toIdle(); } break;
  }
  const end = (next: number) => {
    d.m100 = next; d.m58 = 0;
    if (d.mh !== -1) d.k28[d.mh] = -1;
    d.mh = -1; d.c6c = 5;
  };
  if (d.t38[h] === 0) {
    switch (d.k28[h]) {
      case 0: case 1: { // shrink back up / grow back down 0x100 per tick, then normal mass and speed
        const done = d.k28[h] === 0 ? q.sc >= 0x1000 : q.sc < 0x1001;
        if (!done) q.sc += d.k28[h] === 0 ? 0x100 : -0x100;
        else { d.k28[h] = -1; q.mass = massOf(q); q.spd = speed0(q.ch); d.m58 = 0; d.mh = -1; q.sc = 0x1000; }
        break;
      }
      case 5: { // bomb: fuse 300, the carrier (passed on contact) is blown off
        if (d.c6c === 5) break;
        if (d.t68 > 0) d.t68--;
        let c = d.P[d.c6c]!;
        if (d.t68 === 0 && c.st !== S_BLAST) {
          // the game sets 0x2000 here; eliminate() (S_BLAST enter, same tick) sets it and records the KO
          E(w, 'boom', c.x, c.z, d.c6c, 1);
          setState(w, d, c, d.c6c, S_BLAST);
          end(0xd2);
          break;
        }
        if (d.over || c.st === S_OUT || (c.fl & F_ELIM)) end(0xd2);
        break;
      }
      case 6: { // zap: fuse 300, then every other bear still in -> 0x4b
        if (d.c6c === 5) break;
        if (d.t68 > 0) d.t68--;
        if (d.t68 === 0) {
          for (let i = 0; i < 4; i++) {
            const o = d.P[i];
            if (!o || i === d.c6c || (o.fl & F_ELIM) || o.st === S_OUT) continue;
            if (o.st !== S_STUN) setState(w, d, o, i, S_STUN);
          }
          const c = d.P[d.c6c]!;
          E(w, 'zap', c.x, c.z, d.c6c, 1);
          end(0x14a);
          break;
        }
        const c = d.P[d.c6c]!;
        if (d.over || c.st === 0x56 || c.st === S_OUT || (c.fl & F_ELIM)) end(0xd2);
        break;
      }
    }
  }
  d.beam = d.ms === 2 ? 0x78 - d.m58 : 0;
}

/** Item a bear shows (client codes: 1 shrink, 2 grow, 3 bomb, 5 zap, 6 snowball, 7 frozen; 0 none) and its timer in ticks. */
function itemOf(d: Data, i: number): [number, number] {
  if (d.variant === 'melt') {
    if (d.c6c === i) return [3, d.t68];
    if (d.mh !== i) return [0, 0];
    const k = d.k18[i] !== -1 ? d.k18[i] : d.k28[i];
    return [k === 0 ? 1 : k === 8 ? 6 : k === 2 ? 7 : k === 5 ? 3 : 0, Math.max(0, d.m64) + d.t70];
  }
  if (d.c6c === i) return [d.k28[d.mh] === 6 || d.mk === 6 ? 5 : 3, d.t68];
  if (d.mh === i && (d.k28[i] === 0 || d.k28[i] === 1)) return [d.k28[i] + 1, d.t38[i]];
  if (d.mh === i && (d.k18[i] === 5 || d.k18[i] === 6)) return [CLIENT_ITEM[d.k18[i]], 300 + d.t70];
  return [0, 0];
}

// ---------------------------------------------------------------- MELT PANIC (mask object 0x160a, FUN_800c121c / FUN_800c1584)
/** point on the mask's ring: radius 0x115 * 4096 >> 9 = 2216 */
const ringPt = (a: number): [number, number] => [(SIN(a) * 0x115) >> 9, (T(a) * 0x115) >> 9];
/** FUN_800c0fe8: melt sector s (state 1) and half-melt its neighbours (2 = the half toward s - 1 goes, 3 = toward s + 1, 4 = both). */
function meltSector(w: World, d: Data, s: number) {
  const n = (s + 1) & 0xf, p = (s - 1) & 0xf;
  // Animation group depends on which half melted first (sector record +0xc4).
  const set = (i: number, st: number, group: number) => {
    d.sec[i] = st; d.secT[i] = 0; d.secN[i]++; d.secAnim[i] = group;
  };
  const next = () => { if (d.sec[n] === 0) set(n, 2, 6); else if (d.sec[n] === 3) set(n, 4, 4); };
  const prev = () => { if (d.sec[p] === 0) set(p, 3, 7); else if (d.sec[p] === 2) set(p, 4, 2); };
  const cnt = d.secN[s];
  if (cnt === 0) { set(s, 1, 0); next(); prev(); }
  else if (cnt === 1) { if (d.sec[s] === 2 || d.sec[s] === 3) set(s, 1, d.sec[s] === 2 ? 3 : 5); prev(); next(); }
  else if (cnt === 2) { if (d.sec[s] === 4) set(s, 1, 1); }
  else return;
  const a = s * 256 + 0x7d + 128;
  E(w, 'melt', (SIN(a) * 2210) >> 12, (T(a) * 2210) >> 12, -1, s);
}

/**
 * FUN_800c1584. State +0x14: 4 start wait, 0 flying to the target point (32 u/tick per axis), 1 pause after a melt (61 ticks),
 * 3 item running, 2 leaving. While the item clock +0x64 is negative the first bear (from a random slot) closer than 320 units
 * gets a random item; the clock only runs during an item, so after a bomb (it is left at 0xd2) the mask hands out nothing more.
 */
function meltMaskTick(w: World, d: Data, pose: PolarEmitterPose) {
  const r4 = ri(w, 4);
  const a0 = at2(d.mx, d.mz);
  let [pitch, yaw] = meltHover(pose, d.mState === 2);
  let orient = true;
  for (let i = 0; i < SECTORS; i++) if (d.secN[i] !== 0 && d.secT[i] < 0x74) d.secT[i] += 4;
  for (let i = 0; i < 4; i++) if (d.cool[i] > 0) d.cool[i]--;
  if (d.m64 < 0) {
    for (let u = r4; u < r4 + 4; u++) {
      const i = u & 3, q = d.P[i];
      if (d.mState === 1 || d.over || d.mh !== -1 || !q || (q.fl & F_ELIM) || dist2(d.mx, d.mz, q.x, q.z) > 0x18fff) continue;
      q.vx = q.vz = q.tvx = q.tvz = 0;
      const k = MELT_ITEMS[ri(w, 4)];
      d.mh = i; d.mState = 3; d.mk = k;
      pose.effect = { kind: 'pickup', age: 0, x: d.mx, z: d.mz };
      d.m64 = k === 2 ? ri(w, 0x3c) + 0x5a : k === 0 ? ri(w, 0x3c) + 0x96 : k === 5 ? 0x14a : ri(w, 0x3c) + 300;
      d.t38[i] = 0; d.k18[i] = k; d.k28[i] = k; d.t70 = 0xf;
      if (k === 0) { q.mass = 0x50; q.spd = 0x40; }
      if (k === 8) { q.mass = 400; q.spd = 0x10; }
      setState(w, d, q, i, S_ITEM);
      d.mb4 = 0x3c;
      E(w, 'pickup', q.x, q.z, i, CLIENT_ITEM[k]);
    }
  }
  switch (d.mState) {
    case 0: {
      if (d.over) { d.mState = 2; orient = false; break; }
      d.mx = meltTravelAxis(d.mx, d.mTx);
      d.mz = meltTravelAxis(d.mz, d.mTz);
      d.meltCamera = [d.mx, d.mz];
      pose.speed += Math.sign(pose.targetSpeed - pose.speed);
      const angle = at2(d.mx, d.mz);
      if (pose.speed === pose.targetSpeed && Math.abs((angle - d.mTarget) << 20 >> 20) <= Math.abs(pose.speed) * 8) pose.targetSpeed = 0;
      const dx = d.mx - d.mTx, dz = d.mz - d.mTz;
      if (imul(dx, dx) + imul(dz, dz) > 0xfff) break;
      let u = ri(w, 0x1000);
      d.mState = 1; d.mb4 = 0x3c;
      pose.effect = { kind: 'melt', age: 0, x: d.mx, z: d.mz };
      meltSector(w, d, ((a0 + 1) & 0xfff) >> 8); // sfx 0x489 and loop 0x44c
      let all = true;
      for (let n = 0; n < 0x10; n++) { const i = u & 0xf; u++; if (d.sec[i] !== 1) { all = false; break; } }
      if (all) { d.mState = 2; orient = false; break; }
      d.mTarget = ((u & 0xf) * 0x100 - 0x40) & 0xfff; // one past the first sector still there: the mask stops over that sector
      [d.mTx, d.mTz] = ringPt(d.mTarget);
      pose.speed = 0;
      pose.targetSpeed = ((angle - d.mTarget) << 20) < 0 ? 12 : -12;
      break;
    }
    case 1: yaw = pitch = 0; if (--d.mb4 === -1) { d.mState = 0; d.mb4 = 0xf0; } break;
    case 2: pose.y -= 16; break;
    case 3: {
      const fuseEnded = d.mk === 5 && d.c6c !== 5 && d.t68 <= 1;
      meltItem(w, d);
      if (fuseEnded) orient = false;
      break;
    }
    case 4: if (d.m64-- < 0) d.mState = 0; break;
  }
  if (orient) aimMeltMask(pose, pitch, yaw);
  for (let i = 0; i < SECTORS; i++) d.melt[i] = d.sec[i] === 0 ? 0 : (d.secT[i] / 0x74) * (d.sec[i] === 1 ? 1 : 0.4);
  d.radius = PO_RADIUS * (1 - (d.melt.reduce((x, y) => x + y, 0) / SECTORS) * 0.5);
  d.beam = 0;
}

/** FUN_800c1584 state 3: 15-tick flourish, then the item runs on the clock +0x64 while the mask drifts back to the middle. */
function meltItem(w: World, d: Data) {
  const h = d.mh, q = d.P[h]!;
  const k1 = d.k18[h];
  if (k1 !== -1 && d.t70-- < 1) {
    if (k1 === 2) { if (q.st !== S_FROZEN) { setState(w, d, q, h, S_FROZEN); q.vx = q.vz = q.tvx = q.tvz = 0; d.k18[h] = -1; } }
    else if (k1 === 5) { d.c6c = h; d.t68 = 300; d.k18[h] = -1; setState(w, d, q, h, S_IDLE); }
    else if (k1 === 8) {
      if (q.st !== S_BALL) { // snowball: rolls off toward the middle at 64 u/tick
        setState(w, d, q, h, S_BALL);
        q.y -= 0x14c;
        const a = at2(q.x, q.z) & 0xfff;
        q.yaw = a; q.ty = a;
        q.tvx = q.vx = -(SIN(a) >> 6); q.tvz = q.vz = -(T(a) >> 6);
        d.k18[h] = -1;
      }
    } else if (k1 === 0) { if (q.sc < 0xa01) { d.k18[h] = -1; setState(w, d, q, h, S_IDLE); } else q.sc -= 0x100; }
  }
  if (d.k18[h] !== -1) return;
  if (d.mb4-- < 0) { // the mask drifts to the middle, 24 u/tick per axis
    if (d.mx < 0) d.mx += 0x18;
    if (d.mx > 0) d.mx -= 0x18;
    if (d.mz < 0) d.mz += 0x18;
    if (d.mz > 0) d.mz -= 0x18;
  }
  const c = d.m64--;
  // the holder goes back to idle whatever it is doing, even when it has fallen or is out meanwhile (replay: 0x50 -> 0x49, flags kept)
  switch (d.k28[h]) {
    case 2: if (c < 0) { d.mState = 0; d.k28[h] = -1; if (q.st !== S_IDLE) { setState(w, d, q, h, S_IDLE); d.mh = -1; } } break;
    case 0:
      if (c >= 0) break;
      if (q.sc < 0x1000) q.sc += 0x100;
      else { d.k28[h] = -1; q.spd = speed0(q.ch); q.mass = massOf(q); d.mh = -1; d.mState = 0; q.sc = 0x1000; }
      break;
    case 8:
      if (c < 0) { q.mass = massOf(q); q.spd = speed0(q.ch); d.mState = 0; d.k28[h] = -1; if (q.st !== S_IDLE) { setState(w, d, q, h, S_IDLE); q.y += 0x14c; d.mh = -1; } }
      break;
    case 5: { // bomb: fuse 300 from the end of the flourish, passed on contact (FUN_800bbf2c), the carrier is blown off
      if (d.c6c === 5) break;
      if (d.t68 > 0) d.t68--;
      const ci = d.c6c, cr = d.P[ci]!;
      const end = () => { d.m64 = 0xd2; if (d.mh !== -1) d.k28[d.mh] = -1; d.m58 = 0; d.mh = -1; d.c6c = 5; d.mState = 0; };
      if (d.t68 === 0 && cr.st !== S_BLAST) { E(w, 'boom', cr.x, cr.z, ci, 1); setState(w, d, cr, ci, S_BLAST); end(); break; }
      if (d.over || cr.st === S_OUT || (cr.fl & F_ELIM)) end();
      break;
    }
  }
}

// ---------------------------------------------------------------- POLAR PANIC pillars (FUN_800c0888)
/**
 * 40 ice pillars fence the rim (stage sub-objects with collision, list DAT_800d6010; positions from RAM). Contact radius 330
 * (dist^2 < 0x1a964): the bear is put back at 332 and sent toward the middle at half its speed; the pillar breaks when
 * speed * mass > table speed * 192. One pillar per call.
 */
function pillars(w: World, d: Data, q: PoP, s: number) {
  if (d.variant !== 'polar') return;
  for (const pl of d.pillars) {
    if (!pl[2]) continue;
    const px = pl[0] - q.x, pz = pl[1] - q.z;
    if (Math.abs(px) >= 0x14b || Math.abs(pz) >= 0x14b) continue;
    const dd = imul(px, px) + imul(pz, pz);
    if (dd >= 0x1a964) continue;
    const a = at2(px, pz) & 0xfff, pu = 0x14c - sq(dd);
    q.x = (q.x - m12(pu, SIN(a))) | 0; q.z = (q.z - m12(pu, T(a))) | 0;
    const u = at2(q.x, q.z) & 0xfff, spd = sq(imul(q.vx, q.vx) + imul(q.vz, q.vz));
    q.vx = -(imul(spd, T(0x400 - u)) >> 13); q.vz = -(imul(spd, T(-u)) >> 13);
    if (speed0(q.ch) * 192 < spd * q.mass) { pl[2] = 0; E(w, 'pillar', pl[0], pl[1], s, ri(w, 3)); } // 3 ice chunks (0x1604), sfx 0x46a-c
    return;
  }
}

// ---------------------------------------------------------------- MANIC PANIC bolts (0x160e spawner, 0x160f pickup, 0x160d thrown)
const BOLT_R = 300;
/**
 * FUN_800b44b4: the first bear (slot order) within r2 of the bolt, not its thrower, not immune (player +0x44), gets hit:
 * riding -> knocked off the bear (0x56: mode 1, mass - 0x46, 60 ticks immune; the bear, object 0x1611, flies off), on foot -> burnt (0x57, out).
 */
function boltHit(w: World, d: Data, b: Bolt, r2: number): boolean {
  for (let i = 0; i < 4; i++) {
    const q = d.P[i];
    if (!q || (q.fl & F_ELIM) || i === b.own || q.imm !== 0 || q.st === S_BLAST || q.st === S_OUT) continue;
    if (dist2(b.x, b.z, q.x, q.z) >= r2) continue;
    ri(w, 4); // hit sfx 0x490-0x493 + the voice of the character
    q.by = b.own; q.byT = d.t;
    if (q.md === 1) {
      q.ty = 0x800; q.yaw = 0x800;
      E(w, 'zapped', q.x, q.z, i, 2, b.own);
      if (q.st !== S_BURN) setState(w, d, q, i, S_BURN);
    } else {
      // (real quirk, test hook only: with the render-node pool empty the bear object cannot spawn and the hit does nothing)
      if (poTest.fx && !poTest.fx(true, 0)) return true;
      q.ty = (b.yaw + 0x800) & 0xffff;
      // the bear (0x1611) flies off 3000 u along the bolt's heading at 50 u/tick
      d.bolts.push({
        id: -1, k: 2, st: 0, x: q.x, y: q.y, z: q.z, own: i, t: 5, yaw: b.yaw, fresh: true, sx: q.x, sz: q.z,
        tx: q.x - m12(3000, SIN(b.yaw)), tz: q.z - m12(3000, T(b.yaw)), spd: 0x32, go: 0, vx: 0, vy: 0, vz: 0, floor: 0x100,
      });
      E(w, 'zapped', q.x, q.z, i, 1, b.own);
      setState(w, d, q, i, S_OFF);
      q.imm = 0x3c;
      q.mass -= 0x46;
    }
    return true;
  }
  return false;
}

/** FUN_8008c5c4: ballistic step toward (tx, tz) and dy lower: n = dist / speed ticks, gravity 2; true when it lands on the floor. */
function boltFly(b: Bolt, dy = 0x100): boolean {
  if (!b.go) {
    const dx = b.tx - b.sx, dz = b.tz - b.sz;
    const n = Math.trunc(sq(imul(dx, dx) + imul(dz, dz)) / b.spd);
    if (n === 0) return true;
    b.vy = Math.trunc(dy / n) - (n >> 1) * 2;
    const hd = at2(dx, dz) & 0xfff;
    b.vx = m12(b.spd, SIN(hd)); b.vz = m12(b.spd, T(hd));
    b.go = 1;
  }
  b.y += b.vy; b.vy += 2; b.x += b.vx; b.z += b.vz;
  if (b.floor <= b.y && b.vy > 0) { b.y = b.floor; return true; }
  return false;
}

/** FUN_800c4498: the burst 0x1614 has 17 shards, each draws 6 x rand(0x4c) for its velocity when it spawns. */
function burst(w: World) { for (let i = 0; i < 102; i++) fx(w, 0x4c); }

function boltTick(w: World, d: Data) {
  if (d.variant !== 'manic') return;
  // spawner FUN_800cb8a4: one bolt out at a time; the first after 0xb4 ticks, the next 0x5a ticks after the last one is gone
  const sp = d.sp;
  if (sp.n < 0) sp.n = 0;
  if (sp.st === 0) { if (sp.n < 1 && sp.t-- < 0 && !d.over) { sp.st = 2; sp.t = 0x5a; sp.n++; } }
  else {
    const x = ri(w, 0x800) - ri(w, 0x800), z = ri(w, 0x800) - ri(w, 0x800);
    // (real quirk, test hook only: with the render-node pool empty the pickup cannot spawn; the count stays 1, so no bolt comes any more this round)
    if (!poTest.fx || poTest.fx(true, 0)) d.bolts.push({ id: -1, k: 0, st: 0, x, y: 0, z, own: -1, t: 0, yaw: 0, fresh: true, sx: x, sz: z, tx: x, tz: z, spd: 0, go: 0, vx: 0, vy: 0, vz: 0, floor: 0 });
    E(w, 'bolt', x, z, -1, 0.5); // sfx 0x3fa
    sp.st = 0;
  }
  const dead = new Set<Bolt>();
  for (const b of d.bolts) {
    if (b.fresh) { b.fresh = false; continue; } // objects made this tick first run on the next one
    if (b.k === 2) { // FUN_800ca514: sparks every 1-7 ticks until it lands 0x100 below the ice
      if (--b.t < 0) { fx(w, 0x1000); b.t = ri(w, 7) + 1; }
      if (boltFly(b, -b.y)) dead.add(b);
      continue;
    }
    if (b.k === 0 && b.st === 0) { // FUN_800b5074 on the ice: the first bear (slot order) within 300 takes it
      b.yaw = (b.yaw + 0x20) & 0xfff;
      const i = d.P.findIndex((q) => q && !(q.fl & F_ELIM) && dist2(b.x, b.z, q.x, q.z) < BOLT_R * BOLT_R);
      if (i === -1) continue;
      const q = d.P[i]!;
      b.own = i;
      E(w, 'grab', b.x, b.z, i, 1); // sfx 0x48e
      // the bomb / zap carrier cannot take it: the bolt is just used up
      if (q.hold === 0 && d.c6c !== i) { q.hold = 1; b.st = 1; } else { sp.n--; dead.add(b); }
    } else if (b.k === 0) { // carried: gone when the carrier is out, has won, got the bomb / zap, or has thrown it
      const q = d.P[b.own]!;
      if (q.fl & F_ELIM) { sp.n--; dead.add(b); continue; }
      if ((q.fl & F_WON) || d.c6c === b.own) { sp.n--; q.hold = 0; dead.add(b); continue; }
      b.x = q.x; b.z = q.z; b.y = q.y - ((imul(q.sc, q.ch === 1 ? 600 : 0x300)) >> 12);
      b.yaw = (b.yaw + 0x20) & 0xfff;
      if (q.hold === 0) { sp.n--; dead.add(b); }
    } else if (b.st === 0) { // FUN_800b4c74 thrown: off the ice it drops into the water (floor 0x100)
      const on = hullInside(HULL_MANIC, b.x, b.z);
      if (!on) { b.floor = 0x100; if (b.floor <= b.y) { dead.add(b); continue; } }
      if (!boltFly(b)) {
        if (b.t-- < 0) { fx(w, 0x1000); b.t = ri(w, 2); } // spark trail: a 0x1612 (its init draws its angle) every 2-3 ticks
        if (boltHit(w, d, b, BOLT_R * BOLT_R)) { b.st = 1; b.t = 0; }
      } else { b.st = 1; b.t = 0; } // sfx 0x48f on the ice, 0x494 in the water
    } else { // explodes where it landed / hit: blast radius 470 on the first tick, gone after 31
      if (b.t === 0) { E(w, 'strike', b.x, b.z, b.own, 470 * U); burst(w); boltHit(w, d, b, 0x35ee4); }
      if (++b.t >= 0x1f) dead.add(b);
    }
  }
  if (dead.size) d.bolts = d.bolts.filter((b) => !dead.has(b));
}

/** TILT PANIC FUN_800b3aa0: tilt toward the mass-weighted centre of the bears on the ice (and the seal while it is on it). */
function tiltTick(d: Data) {
  if (d.variant !== 'tilt') { d.ax = d.az = 0; return; }
  let sx = 0, sz = 0;
  for (const q of d.P) if (q && !(q.fl & 0xfa00)) { sx = (sx + imul(q.x, q.mass)) | 0; sz = (sz + imul(q.z, q.mass)) | 0; }
  let ix: number, iz: number;
  const sl = d.seal;
  if (sl && (sl.st === 1 || sl.st === 5 || sl.st === 7)) { ix = Math.trunc(((sx + imul(sl.x, 0x400)) >> 8) / 5); iz = Math.trunc(((sz + imul(sl.z, 0x400)) >> 8) / 5); }
  else { ix = sx >> 10; iz = sz >> 10; }
  iz = -iz;
  d.ax = d.ax - (((d.ax - Math.trunc(ix / 15)) << 20) >> 22);
  if (iz < 0) iz += 15;
  d.az = d.az - (((d.az - (iz >> 4)) << 20) >> 22);
  d.ax = Math.max(-0x80, Math.min(0x80, d.ax));
  d.az = Math.max(-0x40, Math.min(0x40, d.az));
}

const E = (w: World, k: string, gx: number, gz: number, s = -1, v = 1, o = -1) => emit(w, k, gx * U, gz * U, s, v, o);

function padOf(inp: InputState): number {
  let b = 0;
  if (inp.y > 0.4) b |= 0x10; // +z (the view's +z)
  if (inp.y < -0.4) b |= 0x40;
  if (inp.x < -0.4) b |= 0x80;
  if (inp.x > 0.4) b |= 0x20;
  if (inp.a) b |= 0x8000;
  if (inp.b) b |= 0x2000;
  return b;
}

function newP(id: number, cpu: boolean, sk: number, x: number, z: number): PoP {
  const yaw = (((at2(x, z) + 0x800) & 0xfff) + 0x800) & 0xffff;
  return {
    ch: id, cpu, sk, st: S_IDLE, pst: S_IDLE, fl: 0, lk: 0, x, y: 0, z, yaw: s16(yaw), sc: 0x1000,
    vx: 0, vz: 0, tvx: 0, tvz: 0, acx: 2, dcx: 1, acz: 2, dcz: 1, mass: mass0(id), ty: yaw & 0xffff, qy: 0, spd: speed0(id),
    af: 0, clip: 0, k: 0, g: 0x100, pr: 0, ss: 0, md: 0, sc1c: 0, ac: 0, held: 0, pressed: 0, ang: 0, nb: 0, pb: 0,
    ai: { tx: 0, tz: 0, sx: 0, sz: 0, cnt: 0, tgt: 0, ev: 0, st: H_IDLE, h: H_IDLE, fl: 0, per: 1, dir: 0, f4c: 0, f58: 0, dcd: 0, f54: 0, on: 0, c24: 0, a2a: 0, bits: 0 },
    by: -1, byT: -999, s98: 0, hold: 0, imm: 0,
  };
}

/** Start positions per slot (game units), read from emulator RAM at round start for levels 0x12-0x15. */
const PO_STARTS: Record<string, [number, number][]> = {
  tilt: [[-1280, -1740], [-1280, 1740], [972, 1740], [972, -1740]],
  polar: [[-1506, -1580], [-1588, 1290], [1291, 1360], [1277, -1597]],
  melt: [[-1379, -1758], [-1433, 1372], [1206, 1372], [1293, -1687]],
  manic: [[-1506, -1580], [-1588, 1290], [1291, 1360], [1277, -1597]],
};
/** The round snapshot has already run these ticks, so the countdown renders this pre-roll locally. */
export function polarEmitterIntro(variant: string, slots: number[], target: number) {
  const [cx, cz] = MASK_CENTRE[variant] ?? [0, 0];
  let x = cx, z = cz;
  const starts = PO_STARTS[variant] ?? PO_STARTS.tilt;
  const riders = starts.map(([x, z], slot) => slots.includes(slot) ? { x, y: 0, z, fl: 0 } : null);
  const pose = newMaskPose(variant);
  const frames = [{ x, z, pose: { ...pose } }];
  const [tx, tz] = ringPt(target);
  for (let i = 0; i < POLAR_INTRO_TICKS; i++) {
    pose.tick++;
    if (variant === 'melt') {
      const [pitch, yaw] = meltHover(pose, false);
      if (i >= 92) { x = meltTravelAxis(x, tx); z = meltTravelAxis(z, tz); }
      aimMeltMask(pose, pitch, yaw);
    } else {
      const q = nearestMaskRider(riders, x, z);
      [x, z] = maskOrbit(i * 8, cx, cz);
      pose.y = MASK_HEIGHT[variant] + (SIN(i * 0x80) >> 6);
      aimMask(pose, q, x, z, false);
    }
    frames.push({ x, z, pose: { ...pose } });
  }
  return frames;
}
/** POLAR PANIC pillars: the 40 stage sub-objects with collision (models 0x5003-0x500a) in list order DAT_800d6010 (L19 RAM). */
export const POLAR_PILLARS: [number, number][] = [[-181,-2410],[253,-2411],[659,-2368],[-142,2395],[288,2392],[661,2360],[-2366,623],[-2406,253],[-2410,-176],[2435,648],[2485,225],[2483,-232],[-1390,-2175],[-962,-2300],[-558,-2374],[-2373,-589],[-2320,-959],[-2210,-1406],[2452,-603],[2391,-1024],[2270,-1466],[2091,1823],[2258,1462],[2367,1015],[-2043,-1732],[-1730,-2019],[2121,-1760],[1833,-2058],[1441,-2217],[1072,-2293],[1067,2277],[1499,2184],[1831,2063],[-2011,1765],[-2185,1447],[-2293,1030],[-1751,2010],[-1360,2191],[-972,2295],[-552,2360]];

/** One intro tick (112 from the round reset to GO): no level tick (tilt stays 0), no bear moves, but the CPU AI and the objects run. */
function introTick(w: World, d: Data) {
  if (!poTest.introNoPre) ri(w, 0x100);
  const order = d.ord[ri(w, 16)];
  for (const s of order) {
    const q = d.P[s];
    if (!q) continue;
    if (q.cpu) aiTick(w, d, q, s);
    if (q.lk === 0) q.yaw = s16(q.yaw + (adiff(q.yaw, q.ty) >> 2)); // a waiting CPU already turns to face the nearest bear (replay)
  }
  maskTick(w, d); // the objects run: the mask orbits and its beam clock counts from the reset (replay)
  if (!poTest.noSeal) sealTick(w, d);
  boltTick(w, d);
}
export const poIntroTick = (w: World) => introTick(w, w.data as Data);

/** One engine tick for one player (FUN_80083e8c body). */
function playerTick(w: World, d: Data, q: PoP, s: number) {
  if (q.fl & F_OUT) return;
  if (q.fl & F_ELIM) { q.held = 0; q.pressed = 0; q.imm = 0; }
  if (q.lk) q.lk--;
  if (q.imm) q.imm--;
  if (q.cpu && !poTest.noAI) aiTick(w, d, q, s);
  padTick(d, q);
  stateTick(w, d, q, s);
  integrate(q);
}

/** Player and object dispatch continues during the native TIE sequence. */
function advancePolarArena(w: World, d: Data, tiltActive = !d.over) {
  d.noHuman = !d.P.some((q) => q && !q.cpu && !(q.fl & 0xfa00));
  if (variant6004(d)) { if (d.d6004 === 0 && d.mh !== -1) d.d6004 = 1; if (d.d6004 === -1 && d.mh === -1) d.d6004 = 0; } // FUN_800bb810
  if (tiltActive) tiltTick(d);
  if (poTest.pre) poTest.pre(w, d);
  ri(w, 0x100); // one engine rand per tick before the player loop (a pre-updated object, not identified; replay-verified count)
  const oi = ri(w, 16);
  const order = poTest.order ?? d.ord[oi];
  for (const s of order) { const q = d.P[s]; if (q) playerTick(w, d, q, s); }
  // FUN_800bcc9c (cosmetic): after 0xd1 level ticks a CPU standing idle in evade / wander starts its fidget script once
  // (engine characters 1-4 and 7); it lasts until the bear leaves the idle state (the flag +0x50 clears)
  d.fid ??= [0, 0, 0, 0];
  for (let s = 0; s < 4; s++) {
    const q = d.P[s];
    if (!q || q.st !== S_IDLE) { d.fid[s] = 0; continue; }
    if (d.fid[s] || (d.t > 0xd1 && q.cpu && (q.ai.st === H_EVADE || q.ai.st === H_WANDER) && [1, 2, 3, 4, 7].includes(q.ch))) d.fid[s]++;
  }
  // one bear was left when this tick began: it is flagged 0x200 after the bears and before the objects (a carried bolt goes this tick)
  if (!d.over && d.one === 1) { const st = d.P.filter((q): q is PoP => !!q && !(q.fl & F_ELIM)); if (st.length === 1) st[0].fl |= F_WON; }
  // FUN_8007976c: level tick (8007906c), the bears (80083e8c), then the object list (mask, seal, MANIC bolts).
  // Replay-confirmed: a mask pickup zeroes v after that tick's integration.
  if (!poTest.noObjects) { maskTick(w, d); if (!poTest.noSeal) sealTick(w, d); boltTick(w, d); }
  if (poTest.post) poTest.post(w, d);
  d.t++;
}

export const pushOff: MiniGame = {
  id: 'pushOff',
  name: 'Polar Push',
  description: 'Knock rivals off the tilting ice. Watch for the seal. Last standing wins.',
  variantDescriptions: {
    polar: 'Break the rim pillars to open gaps, then knock rivals off. Last standing wins.',
    melt: 'Knock rivals off as Uka Uka melts the rim. Last standing wins.',
    manic: 'Knock rivals off the ice. Bolts unseat riders and eliminate players on foot. Last standing wins.',
  },
  controls: '{move} skate. {a} dash (uses meter). Tap {a} repeatedly to climb if hanging.',
  variantControls: { manic: '{move} move. {a} dash (uses meter). Tap {a} repeatedly to climb if hanging. {b} throw a bolt.' },
  variants: PO_VARIANTS,
  settlesAfterTimeout: true,
  maxTime: 90, // FUN_800bafa0: FUN_8007b7fc(0x130) = 1:30 clock

  setup(w, slots) {
    const variant = pickVariant(w, PO_VARIANTS);
    const chars = w.data?.chars as number[] | undefined; // optional host override: roster index per slot
    const d: Data = {
      random: discRandomState(w.rng),
      variant, radius: PO_RADIUS, tilt: [0, 0], tiltRad: [0, 0], meter: [0, 0, 0, 0], hang: [0, 0, 0, 0], item: [0, 0, 0, 0], itemT: [0, 0, 0, 0], scale: [1, 1, 1, 1],
      elim: [-1, -1, -1, -1], melt: new Array(SECTORS).fill(0), pillars: variant === 'polar' ? POLAR_PILLARS.map(([x, z]) => [x, z, 1]) : [],
      P: [null, null, null, null], ord: [], ax: 0, az: 0, rayLen: 0x658, over: false, t: 0, one: 0, flags: [0, 0, 0, 0], d5ffc: 1, d6004: 0, noHuman: false,
      maskA: 0, mx: 0, mz: 0, beam: 0, maskView: newMaskPose(variant), ms: 1, m58: 0, m100: 210, mk: 0, mh: -1, k18: [-1, -1, -1, -1], k28: [-1, -1, -1, -1], t38: [0, 0, 0, 0], t68: 0, t70: 0, c6c: 5, cool: [0, 0, 0, 0], human: [false, false, false, false], seal: null,
      sec: new Array(SECTORS).fill(0), secN: new Array(SECTORS).fill(0), secT: new Array(SECTORS).fill(0), secAnim: new Array(SECTORS).fill(0),
      mTarget: 0, mTx: 0, mTz: 0, mState: 4, m64: 0x5a, mb4: 300,
      sp: { st: 0, t: 0xb4, n: 0 }, bolts: [], foot: [0, 0, 0, 0], hold: [0, 0, 0, 0], fid: [0, 0, 0, 0], fxT: 0,
    };
    w.data = d;
    for (let i = 0; i < 16; i++) { // FUN_80085650: 16 shuffled update orders
      const a = [0, 1, 2, 3];
      for (let k = 0; k < 4; k++) { const j = ri(w, 4); [a[k], a[j]] = [a[j], a[k]]; }
      d.ord.push(a);
    }
    if (variant === 'melt') { // FUN_800c121c: starts in the middle, first target at one of four angles
      d.mTarget = [0xf00, 0x300, 0x700, 0xb00][ri(w, 4)];
      [d.mTx, d.mTz] = ringPt(d.mTarget);
    } else d.m100 = 210 + ri(w, 90);
    for (const s of slots) {
      const [sx, sz] = PO_STARTS[variant]?.[s.slot] ?? PO_STARTS.tilt[s.slot];
      const look = Math.max(0, Math.min(RD_CHAR_ID.length - 1, chars?.[s.slot] ?? s.char ?? s.slot));
      const q = newP(RD_CHAR_ID[look], s.bot, SKILLS[Math.max(0, Math.min(2, s.level ?? 1))], sx, sz);
      q.ai.on = s.bot ? 1 : 0;
      d.P[s.slot] = q;
      d.human[s.slot] = !s.bot;
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, sx * U, sz * U, PO_BEAR_R * sc, 3 * sc * sc);
      b.face = faceOf(q.yaw);
    }
    if (variant === 'melt') { d.mx = 0; d.mz = 0; } else { const [cx, cz] = MASK_CENTRE[variant] ?? MASK_CENTRE.tilt; d.mx = cx; d.mz = cz + 1500; }
    // Intro (112 ticks from round reset to GO, measured): the bears stand with the pad zeroed but the CPU AI already thinks,
    // so at GO most CPUs are in attack (+0x30 = 1) on a random rival with part of their countdown used.
    d.noHuman = !d.P.some((q) => q && !q.cpu);
    if (variant === 'tilt') d.seal = newSeal(w); // made at level setup: its timer already runs during the intro
    for (let t = 0; t < POLAR_INTRO_TICKS; t++) introTick(w, d);
    for (const q of d.P) if (q) { q.nb = 0; q.pb = 0; }
    addBody(w, 'mask', -1, d.mx * U, d.mz * U, 0.5, 1);
    if (variant === 'tilt' && d.seal) {
      const sb = addBody(w, 'seal', -1, d.seal.x * U, d.seal.z * U, 0x100 * U, 4);
      sb.alive = false;
    }
    updatePolarCamera(d, false, false, true);
    sync(w, d);
  },

  step(w, inputs) {
    const d = w.data as Data;
    if (d.over) return;
    // pad reader: humans from the stick, CPUs get the bits their AI wrote last tick
    for (let s = 0; s < 4; s++) {
      const q = d.P[s];
      if (!q) continue;
      if (poTest.pads) { const b = poTest.pads[s]; q.pressed = b.pressed; q.held = b.held; q.ang = b.ang; continue; }
      if (!q.cpu) {
        const b = padOf(inputs[s] ?? IDLE);
        if (d.t === 0) q.pb = b; // the pad's previous bits keep tracking during the intro: a button held through GO is not a press (replay)
        q.pressed = b & ~q.pb; q.held = b; q.pb = b; q.ang = stickAngle(b);
      } else { q.pressed = q.nb & ~q.pb; q.held = q.nb; q.pb = q.nb; q.ang = stickAngle(q.nb); }
    }
    advancePolarArena(w, d);
    // last bear standing (flag 0x200) / three out -> round over (DAT_800d4dec)
    // (the engine flags the survivor 0x200 one tick after the last elimination, see above; the round stops the tick after that)
    const all = d.P.filter((q): q is PoP => !!q);
    const standing = all.filter((q) => !(q.fl & F_ELIM));
    if (all.length > 1 && standing.length <= 1) {
      d.one++;
      if (d.one >= 3) d.over = true;
    }
    if (all.filter((q) => q.st === S_OUT).length >= all.length - 1) d.over = true;
    if (w.tick + 1 >= POLAR_TIMEOUT_TICK) d.over = true;
    const winner = standing.find(q => q.fl & F_WON);
    updatePolarCamera(d, d.over || !!winner, winner?.st === S_WIN, winner?.st !== S_WIN);
    sync(w, d);
  },

  isOver(w) {
    return (w.data as Data).over;
  },

  isDraw(w) {
    const { P } = w.data as Data;
    // FUN_80084788 compares the same 20 points for every surviving rider.
    return !P.some(q => q && (q.fl & F_WON)) && P.filter(q => !elim(q)).length !== 1;
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const pa = d.P[a], pb = d.P[b];
      if (!pa || !pb) return pa ? -1 : pb ? 1 : a - b;
      if ((pa.fl ^ pb.fl) & F_WON) return pa.fl & F_WON ? -1 : 1;
      const ea = elim(pa), eb = elim(pb);
      if (ea !== eb) return ea ? 1 : -1;
      if (!ea) return a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  /** For a vacated human seat: the real CPU AI (decide + handler) on this bear, with a hashed rng so the world rng is untouched. */
  bot(w, slot): InputState {
    const d = w.data as Data;
    const q = d?.P[slot];
    if (!q || q.cpu || elim(q) || d.over) return IDLE;
    let c = 0;
    const saved = poTest.rng;
    poTest.rng = (n) => {
      c++;
      let h = (Math.imul(w.tick + 1, 0x9e3779b1) ^ Math.imul(slot + 1, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
      h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
      return n < 2 ? 0 : ((h ^ (h >>> 15)) >>> 0) % n;
    };
    try { q.ai.bits = 0; decide(w, d, q, slot); handler(w, d, q, slot); } finally { poTest.rng = saved; }
    const b = q.ai.bits | (q.pr === 8 ? 0x8000 : 0);
    return { x: b & 0x80 ? -1 : b & 0x20 ? 1 : 0, y: b & 0x10 ? 1 : b & 0x40 ? -1 : 0, a: (b & 0x8000) !== 0, b: (b & 0x2000) !== 0 };
  },
};

/** DAT_800d6004 only matters for the MELT snowball reaction; kept off the replay-checked TILT path */
const variant6004 = (d: Data) => d.variant === 'melt';
const faceOf = (yaw: number) => (((yaw + 0x800) & 0xfff) * Math.PI * 2) / 4096;

function sync(w: World, d: Data) {
  for (const b of w.bodies) {
    if (b.kind === 'player') {
      const q = d.P[b.slot];
      if (!q) continue;
      b.x = q.x * U; b.z = q.z * U; b.vx = q.vx * 30 * U; b.vz = q.vz * 30 * U; b.face = faceOf(q.yaw);
      const falling = q.st === S_OUT || q.st === S_BLAST || (q.st === S_SLIP && (q.ac !== 0 || q.af >= 0x21));
      b.fall = falling;
      b.y = -q.y * U;
      b.alive = q.st !== S_OUT && !(q.fl & F_OUT);
      b.dash = q.st === S_DASH ? 0.2 : 0;
      b.cd = 0;
      d.meter[b.slot] = q.g / 0x100;
      d.hang[b.slot] = q.st === S_SLIP && !falling ? Math.max(0, (0x21 - q.af) / 30) : 0;
      const [it, itT] = itemOf(d, b.slot);
      d.item[b.slot] = q.st === S_STUN ? 4 : it;
      d.itemT[b.slot] = Math.max(0, itT / 30);
      d.scale[b.slot] = q.sc / 0x1000;
      d.foot[b.slot] = q.md; d.hold[b.slot] = q.hold;
    } else if (b.kind === 'mask') {
      b.x = d.mx * U; b.y = -(d.maskView?.y ?? MASK_HEIGHT[d.variant] ?? MASK_HEIGHT.tilt) * U; b.z = d.mz * U;
    }
    else if (b.kind === 'seal' && d.seal) {
      const sl = d.seal;
      b.x = sl.x * U; b.z = sl.z * U; b.y = -sl.y * U; b.face = faceOf(sl.yaw); b.alive = sl.st !== 0 && sl.st !== 2;
    }
  }
  if (d.variant === 'manic') { // one 'bolt' body per pickup / thrown bolt (not while it explodes), 'flybear' for a knocked-off bear (0x1611)
    for (const bl of d.bolts) {
      if (bl.k === 1 && bl.st === 1) continue;
      const kind = bl.k === 2 ? 'flybear' : 'bolt';
      let b = w.bodies.find((o) => o.id === bl.id && o.kind === kind);
      if (!b) { b = addBody(w, kind, -1, bl.x * U, bl.z * U, BOLT_R * U, 1); bl.id = b.id; }
      b.x = bl.x * U; b.z = bl.z * U; b.y = -bl.y * U; b.face = faceOf(bl.yaw);
    }
    const liveIds = new Set(d.bolts.filter((bl) => !(bl.k === 1 && bl.st === 1)).map((bl) => bl.id));
    if (w.bodies.some((o) => (o.kind === 'bolt' || o.kind === 'flybear') && !liveIds.has(o.id))) w.bodies = w.bodies.filter((o) => (o.kind !== 'bolt' && o.kind !== 'flybear') || liveIds.has(o.id));
  }
  d.tilt = [d.ax / 0x80, d.az / 0x40];
  d.tiltRad = [(d.ax * Math.PI * 2) / 4096, (d.az * Math.PI * 2) / 4096];
}
