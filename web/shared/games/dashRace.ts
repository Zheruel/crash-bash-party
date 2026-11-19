/**
 * CRASH DASH (game id 'dashRace', levels 23-26) - rules taken from the decompiled overlay (re/notes/crashDash.md).
 *
 * Everything is simulated in the game's own units (1024 = 1 model unit, 30 Hz frame counts, yaw 0..4095) and mapped to
 * world units for the bodies: x_w = x_g * DR_K / 1024, z_w = -z_g * DR_K / 1024, face = -yaw * 2pi / 4096.
 *
 *   Left / right (stick x): tank-like steering. The target yaw moves +-turn per frame and yaw follows (tgt - yaw) >> 2.
 *   Up (stick y < 0, = R1): run. Boost (a, = Square): burns fuel. Circle (b): use the held item (Splash with nothing held: hop).
 *   10 laps; the first kart to finish ends the race (draw if two finish together), otherwise the leader at 1:30.
 *
 * world.data (all per slot arrays of 4):
 *   variant, f (frame), gx gz gy (game units; gy up), yaw tgt vx vz vy, fuel (0..1), item (0 none, 1 missile, 2 shield),
 *   shield (frames left), state (0x5b drive, 0x5d hit, 0x5e hop, 0x61 fall), st (frames in state), turbo, stun (s, hit/fall),
 *   lap (laps done), c30 c148 (line counter), finish (time s or -1), first, rot/pat (splash), mon (toxic monster 0..1)
 * Bodies: 'player', 'fruit', 'item' (crate), 'missile', 'rod' (splash spoke: face = direction, y = height 0..1), 'rock' (dante).
 * Events: turbo pickup missile shield explode hit lap finish bump hop fall monster spoke
 */
import { addBody, clamp, emit, rand } from '../physics';
import { IDLE, type InputState, type MiniGame, type World } from '../types';
import { TAU, pickVariant } from './common';

export const DR_K = 3.4;
export const DR_LAPS = 10;
export const DR_KART_R = 220 * DR_K / 1024;
const G = DR_K / 1024;
const FUEL_MAX = 0x10000;

export interface Track { cx: number; cz: number; rIn: number[]; rOut: number[] }
const N = 24;
const flat = (v: number) => Array<number>(N).fill(v);
/** Measured from the stage meshes (model units, world-z flipped, for the view). The sim uses the game-unit tables below. */
export const DR_TRACKS: Record<string, Track> = {
  dot: {
    cx: 0, cz: 0.95,
    rIn: [1.05, 1.05, 1.12, 1.12, 1.33, 1.62, 1.62, 1.62, 1.33, 1.12, 1.12, 1.05, 1.05, 1.14, 1.38, 1.38, 1.58, 1.58, 1.59, 1.58, 1.58, 1.4, 1.4, 1.14],
    rOut: [2.6, 2.73, 2.91, 3.19, 3.33, 3.6, 3.6, 3.6, 3.33, 3.19, 2.91, 2.73, 2.6, 2.49, 2.57, 2.61, 2.62, 2.62, 2.6, 2.62, 2.62, 2.61, 2.57, 2.49].map((v) => v - 0.15),
  },
  toxic: { cx: 0, cz: 0, rIn: flat(1.2), rOut: flat(2.62) },
  splash: { cx: 0, cz: 0, rIn: flat(1.12), rOut: flat(2.68) },
  dante: { cx: 0, cz: 0, rIn: flat(0.98), rOut: flat(2.9) },
};
export const DR_VARIANTS = [
  { id: 'dot', name: 'DOT DASH' },
  { id: 'toxic', name: 'TOXIC DASH' },
  { id: 'splash', name: 'SPLASH DASH' },
  { id: 'dante', name: "DANTE'S DASH" },
];
export const trackCentre = (variant: string): [number, number] => { const t = DR_TRACKS[variant] ?? DR_TRACKS.dot; return [t.cx * DR_K, t.cz * DR_K]; };
/** approximate world inner/outer radius around the view centre (used by the view for decor only) */
export function trackRadii(variant: string, th: number): [number, number] {
  const t = DR_TRACKS[variant] ?? DR_TRACKS.dot;
  const u = ((-th / TAU) % 1 + 1) % 1 * N, i = Math.floor(u), f = u - i;
  const ip = (a: number[]) => a[i % N] * (1 - f) + a[(i + 1) % N] * f;
  return [ip(t.rIn) * DR_K, ip(t.rOut) * DR_K];
}

// ---- real wall polygons (group 0 = hub, group 3 = outer wall of Dot Dash, from the level collision model) ----
const DOT_HUB = [[-667, -103], [-482, 281], [-334, 552], [-172, 712], [181, 708], [370, 584], [551, 300], [736, -122], [877, -510], [915, -959], [871, -1434], [656, -1731], [447, -1875], [86, -1958], [-442, -1841], [-795, -1408], [-881, -985], [-784, -491]];
const DOT_OUT = [[-2610, -12], [-2366, 982], [-1874, 1947], [-910, 2821], [-91, 3021], [746, 2876], [1365, 2493], [2093, 1638], [2512, 746], [2657, 109], [2639, -455], [2599, -1201], [2380, -1962], [2038, -2621], [1510, -3193], [946, -3331], [491, -3440], [91, -3495], [-364, -3495], [-910, -3367], [-1692, -2967], [-2239, -2384], [-2512, -1820], [-2603, -1383], [-2639, -928]];
/** circular levels (game units): hub radius (mesh), fall radius (Toxic 3072 / Dante 3328 are decoded, Splash is an estimate) */
const RING: Record<string, { rin: number; fall: number }> = {
  toxic: { rin: 1200, fall: 3072 },
  splash: { rin: 1.12 * 1024, fall: 2944 },
  dante: { rin: 0.98 * 1024, fall: 3328 },
};
/** start slots from the game's table at 0x8005b2b8 (read from the emulator after the level cheat), all facing -z_g (yaw 0) */
const START: Record<string, number[][]> = {
  dot: [[963, 560], [1463, 248], [1835, -120], [2336, -455]],
  toxic: [[1020, 1000], [1520, 687], [1892, 318], [2406, -28]],
  splash: [[931, 1053], [1430, 740], [1803, 371], [2304, 37]],
  dante: [[950, 900], [1450, 588], [1822, 219], [2323, -115]],
};
const LINE_Z = -493;

// ---- kart constants (data 0x800c66cc, Splash overrides FUN_800b8f04) ----
interface Phys { acc: number; bacc: number; dec: number; run: number; boost: number; turn: number }
const PHYS: Phys = { acc: 768, bacc: 2048, dec: 160, run: 80, boost: 160, turn: 128 };
const PHYS_SPLASH: Phys = { acc: 600, bacc: 1600, dec: 125, run: 62, boost: 125, turn: 100 };
const AI_ACC = [384, 414, 444, 474, 504, 584, 634, 684, 734, 784, 896];
/** AI skill of the hardest bot level (FUN_80086918 table d900[difficulty]: Dot 1/11/22, Toxic 1/10/20, Splash 1/10/20, Dante 1/11/22) */
const SKILL: Record<string, number> = { dot: 22, toxic: 20, splash: 20, dante: 22 };

const S_DRIVE = 0x5b, S_HIT = 0x5d, S_HOP = 0x5e, S_FALL = 0x61;
/** fall clip (anim 0x4b, 0x54 on Splash) lengths measured from the character scripts in re/dumps/L23.ram: 24 / 32 frames */
const FALL_CLIP = 24, FALL_CLIP_SPLASH = 32;
/** the kart sits 256 above the floor (ground y = -256); a respawn drops from y = -1400 = 1144 above that */
const DROP_H = 1144;

/** Splash spoke patterns (table 0x800c6b70): [hold, start delay] per spoke, delay -1 = unused; duration 180 frames each */
const PAT: number[][][] = [
  [[10, 10], [10, 20], [10, 29], [10, 40], [10, 50], [10, 60]],
  [[120, 0], [120, -1], [120, -1], [120, -1], [120, -1], [120, -1]],
  [[120, 0], [120, -1], [120, -1], [120, -1], [120, -1], [120, -1]],
  [[120, 0], [0, -1], [0, -1], [120, 0], [0, -1], [0, -1]],
  [[120, 0], [0, -1], [0, -1], [120, 0], [0, -1], [0, -1]],
  [[1200, 0], [1200, 0], [1200, 0], [1200, 0], [1200, 0], [1200, 0]],
];
const PAT_LEN = 180;
/** Toxic monster anim lengths (model 639, measured): rise 119, attack 42, sink 35 frames */
const MON_RISE = 119, MON_ATK = 42, MON_SINK = 35;
/** blob landing targets by spawn index (FUN_800c3738) */
const BLOB_START = [-512, -668, -512];

/** Toxic barrels (model 0x5006), read from the game's barrel array at 0x800c6f88 (11 of them); a hit kart spins out, the barrel is gone for 180 + rand(60) frames */
export const DR_BARRELS = [[-1577, 2173], [-1142, 2253], [1529, 2189], [1158, 2446], [-2493, -719], [-2155, -1053], [-2173, -1572], [-2618, -230], [-2618, 236], [-321, -2639], [-257, -1428]];

interface Spoke { ext: number; state: number; cnt: number; hold: number; started: boolean }
interface Blob { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; k: number; init: boolean; st: number; tm: number }
interface Rock { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; tx: number; tz: number; spd: number; init: boolean }

interface Data {
  variant: string;
  f: number;
  gx: number[]; gz: number[]; gy: number[]; vy: number[];
  yaw: number[]; tgt: number[]; vx: number[]; vz: number[];
  fuel: number[]; item: number[]; shield: number[];
  state: number[]; st: number[]; turbo: boolean[]; stun: number[];
  lap: number[]; c30: number[]; c148: number[];
  finish: number[]; first: number;
  prevB: boolean[]; prevA: boolean[];
  /** hit counter (S+0xc), fall handler calls / phase / landings / drop velocity / polar angle (S+0x54), bot stamp */
  cnt: number[]; fc: number[]; fph: number[]; fl: number[]; dvy: number[]; p54: number[]; bf: number[];
  occ: boolean[]; cdF: number; cdC: number; pre: number;
  /** Splash: spoke rotation, current pattern, pattern call counter, start wait, extension max */
  rot: number; pat: number; pt: number; wait: number; smax: number; sp: Spoke[];
  /** Toxic monster: state 0 rise 1 attack 2 sink 3 hidden, frames in state, hidden timer, visual rise 0..1 */
  mon: number; monS: number; monT: number; monTim: number; blobs: Blob[]; blobK: number; bar: { x: number; z: number; t: number }[];
  /** Dante volcano: state 0 wait 1 launch 2 flight, timer */
  vs: number; vt: number;
  /** missiles: id, owner, polar angle (rad, x = r sin a, z_g = r cos a), radius, rate sign, bounces, age */
  mis: { id: number; o: number; a: number; r: number; sg: number; b: number; age: number; gy: number }[];
  rocks: Rock[];
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const sinT = (a: number) => Math.sin((a * TAU) / 4096);
const cosT = (a: number) => Math.cos((a * TAU) / 4096);
const sdiff = (a: number, b: number) => { let d = (b - a) & 0xfff; if (d > 0x800) d -= 0x1000; return d; };
/** the game's trig table: cos(a) * 4096 (sin(a) = Ti(a - 0x400)) */
const Ti = (a: number) => Math.round(4096 * Math.cos((((a % 4096) + 4096) % 4096) * TAU / 4096));
/** FUN_8001463c(x, z): angle a with (sin a, cos a) along (x, z), 0..0xfff */
const ang = (x: number, z: number) => Math.round((Math.atan2(x, z) * 4096) / TAU) & 0xfff;
/** signed 12-bit */
const sext = (a: number) => ((a & 0xfff) ^ 0x800) - 0x800;
const R_ = (w: World, n: number) => Math.floor(rand(w) * n);
const polarAng = (x: number, z: number) => Math.atan2(x, z); // from +z toward +x

/** closest point on the closed polygon: [dist, nx, nz (unit, from the boundary toward p)], and whether p is inside */
function polyQuery(poly: number[][], x: number, z: number): { d: number; nx: number; nz: number; inside: boolean } {
  let best = 1e18, bx = 0, bz = 0, inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [x0, z0] = poly[j], [x1, z1] = poly[i];
    if ((z0 > z) !== (z1 > z) && x < ((x1 - x0) * (z - z0)) / (z1 - z0) + x0) inside = !inside;
    const ex = x1 - x0, ez = z1 - z0, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - x0) * ex + (z - z0) * ez) / l2, 0, 1);
    const cx = x0 + ex * t, cz = z0 + ez * t, dd = (x - cx) ** 2 + (z - cz) ** 2;
    if (dd < best) { best = dd; bx = x - cx; bz = z - cz; }
  }
  const d = Math.sqrt(best) || 1e-6;
  return { d, nx: bx / d, nz: bz / d, inside };
}

const phys = (v: string): Phys => (v === 'splash' ? PHYS_SPLASH : PHYS);

function setState(d: Data, s: number, st: number) { d.state[s] = st; d.st[s] = 0; }

/** FUN_800868b4(p, 0x5d): hit state. Enter: counter 60, vy -160, gravity 10 up / 20 down. No speed cut: the pad is zeroed, so the kart only decelerates. */
function hit(w: World, d: Data, s: number, by: number) {
  if (d.state[s] === S_HIT || d.state[s] === S_FALL || d.finish[s] >= 0) return;
  setState(d, s, S_HIT);
  d.cnt[s] = 60;
  d.vy[s] = -160; // up
  d.turbo[s] = false;
  emit(w, 'hit', d.gx[s] * G, -d.gz[s] * G, s, 1, by);
}

function freeSlot(w: World, d: Data): number {
  let k = Math.floor(rand(w) * 16);
  for (let i = 0; i < 16; i++, k = (k + 1) & 15) if (!d.occ[k]) return k;
  return -1;
}
function spawnPickup(w: World, d: Data, kind: 'fruit' | 'item', variant: string) {
  const k = freeSlot(w, d);
  if (k < 0) return;
  d.occ[k] = true;
  const a = (k * 0x100 * TAU) / 4096;
  const rad = kind === 'fruit' ? (variant === 'splash' ? 1500 : 2200) : 2200 + Math.floor(rand(w) * 100);
  const b = addBody(w, kind, -1, rad * Math.sin(a) * G, -rad * Math.cos(a) * G, 384 * G, 1);
  b.vy = k; // pickup slot
  b.dash = kind === 'item' && variant === 'toxic' ? 5 : 0; // crate type
}

function setup(w: World, slots: { slot: number }[]) {
  const variant = pickVariant(w, DR_VARIANTS);
  const z4 = [0, 0, 0, 0], f4 = [false, false, false, false], n4 = [-1, -1, -1, -1];
  const d: Data = {
    variant, f: 0, gx: [...z4], gz: [...z4], gy: [...z4], vy: [...z4], yaw: [...z4], tgt: [...z4], vx: [...z4], vz: [...z4],
    fuel: [...z4], item: [...z4], shield: [...z4], state: [S_DRIVE, S_DRIVE, S_DRIVE, S_DRIVE], st: [...z4], turbo: [...f4], stun: [...z4],
    lap: [...z4], c30: [...z4], c148: [...z4], finish: [...n4], first: -1, prevB: [...f4], prevA: [...f4],
    cnt: [...z4], fc: [...z4], fph: [...z4], fl: [...z4], dvy: [...z4], p54: [...z4], bf: [...z4],
    occ: Array.from({ length: 16 }, (_, i) => i === 2), cdF: 30, cdC: 30, pre: 60,
    rot: 0, pat: 4, pt: 0, wait: 180, smax: 17, sp: [],
    mon: 0, monS: 3, monT: 0, monTim: 0, blobs: [], blobK: 0, bar: [], vs: 0, vt: 0x1c2, mis: [], rocks: [],
  };
  w.data = d;
  for (const s of slots) {
    const k = s.slot;
    const [x, z] = START[variant][k];
    d.gx[k] = x; d.gz[k] = z; d.yaw[k] = d.tgt[k] = 0;
    const b = addBody(w, 'player', k, x * G, -z * G, DR_KART_R * w.params.playerScale, 3);
    b.face = 0;
  }
  if (variant === 'splash') {
    d.pat = R_(w, 5);
    for (let i = 0; i < 6; i++) {
      const rd = addBody(w, 'rod', -1, 0, 0, 120 * G, 1);
      rd.dash = 2700 * G; d.sp.push({ ext: 0, state: 0, cnt: 0, hold: 0, started: false });
    }
  }
  if (variant === 'toxic') for (const [bx, bz] of DR_BARRELS) d.bar.push({ x: bx, z: bz, t: 0 });
  if (variant === 'toxic') d.monTim = 0xf0 + R_(w, 0x5a); // FUN_800c4774: hidden for 240..329 frames first
  if (variant === 'dante') d.vt = 0x1c2;
}

/** the pad as the game sees it */
interface Pad { l: boolean; r: boolean; run: boolean; boost: boolean; use: boolean }
const NOPAD: Pad = { l: false, r: false, run: false, boost: false, use: false };
const padOf = (inp: InputState): Pad => ({ l: inp.x < -0.25, r: inp.x > 0.25, run: inp.y < -0.3, boost: inp.a, use: inp.b });

const KART_R = 220;
/**
 * FUN_800b6dbc: push the kart out of the walls (Dot: hub polygon + outer polygon, other levels: the hub circle); radius 220.
 * Returns the outward normal angle of the last wall touched (-1 = none).
 */
function wallResolve(d: Data, s: number): number {
  const v = d.variant;
  let n = -1;
  if (v === 'dot') {
    for (const poly of [DOT_HUB, DOT_OUT]) {
      const q = polyQuery(poly, d.gx[s], d.gz[s]);
      const hub = poly === DOT_HUB;
      const allowed = hub ? !q.inside : q.inside;
      const c = allowed ? q.d : -q.d; // clearance on the allowed side
      if (c < KART_R) {
        const sg = allowed ? 1 : -1;
        const ax = sg * q.nx, az = sg * q.nz;
        d.gx[s] += ax * (KART_R - c); d.gz[s] += az * (KART_R - c);
        n = ang(ax, az);
      }
    }
  } else {
    const r = Math.hypot(d.gx[s], d.gz[s]) || 1;
    const lo = RING[v].rin + KART_R;
    if (r < lo) {
      const nx = d.gx[s] / r, nz = d.gz[s] / r;
      d.gx[s] = nx * lo; d.gz[s] = nz * lo;
      n = ang(nx, nz);
    }
  }
  return n;
}

/** Splash spokes (estimated geometry: arm from 1000 to 2700 along its direction, half width 120, height = extension * 16). */
/** spoke arm direction: the model (level 0641 part24) reaches along its own -z from the hub, so at yaw a the arm points
 *  R(a)(0,0,-1) = (-sin a, -cos a) in game space */
function spokeArm(d: Data, i: number): [number, number] {
  const a = (i * 0x2aa + d.rot) & 0xfff;
  return [-sinT(a), -cosT(a)];
}
/** push the kart out of raised spokes; returns the push direction when a *rising* spoke is hit (the 0x6000 kick of FUN_800b980c) */
function spokePush(d: Data, s: number): [number, number] | null {
  let kick: [number, number] | null = null;
  d.sp.forEach((q, i) => {
    const hgt = q.ext * 16;
    if (hgt <= 0 || d.gy[s] > hgt) return;
    const [ux, uz] = spokeArm(d, i);
    const t = clamp(d.gx[s] * ux + d.gz[s] * uz, 1000, 2700);
    const dx = d.gx[s] - ux * t, dz = d.gz[s] - uz * t, dd = Math.hypot(dx, dz) || 1;
    if (dd < 120 + KART_R) {
      d.gx[s] += (dx / dd) * (120 + KART_R - dd); d.gz[s] += (dz / dd) * (120 + KART_R - dd);
      if (q.state === 1) kick = [dx / dd, dz / dd];
    }
  });
  return kick;
}

/**
 * One frame of FUN_800b8fd8 (input -> targets, fuel) + FUN_800b980c (velocity ramp, move, wall deflection, fall check).
 */
function moveKart(w: World, d: Data, s: number, pad: Pad, ph: Phys, ai: boolean) {
  const v = d.variant;
  const st = d.state[s];
  wallResolve(d, s); // first FUN_800b6dbc call
  if (st === S_FALL) { d.vx[s] = d.vz[s] = 0; d.turbo[s] = false; return; }
  const ctl = st !== S_HIT; // DAT_8009d576 == 0
  let tx = 0, tz = 0, ax = 0, az = 0;
  let boosting = false;
  if (ctl) {
    if (pad.l) d.tgt[s] -= ph.turn;
    if (pad.r) d.tgt[s] += ph.turn;
    d.tgt[s] &= 0xfff;
    if (pad.boost && d.fuel[s] > 0) {
      ax = az = ph.bacc;
      tx = (ph.boost * Ti(d.yaw[s] + 0x400)) >> 12;
      tz = (ph.boost * Ti(d.yaw[s] + 0x800)) >> 12;
      d.fuel[s] -= 0x180; // AI skill >= 0x17 would get a refund; the hardest level (skill 22 / 20) never does
      boosting = true;
      if (d.fuel[s] < 0) { d.fuel[s] = 0; boosting = false; }
    }
    if (!boosting && pad.run) {
      ax = az = ph.acc;
      if (ai) {
        const sk = SKILL[v];
        ax = az = sk < 0x16 ? Math.max(0x200, 768 + (sk - 16) * 64) : 768 + AI_ACC[sk - 0x16];
      }
      tx = (ph.run * Ti(d.yaw[s] + 0x400)) >> 12;
      tz = (ph.run * Ti(d.yaw[s] + 0x800)) >> 12;
    }
  }
  if (ctl) d.yaw[s] = (d.yaw[s] + (sdiff(d.yaw[s], d.tgt[s]) >> 2)) & 0xfff; // FUN_800b48ec (after the targets used the old yaw)
  if (boosting && !d.turbo[s]) emit(w, 'turbo', d.gx[s] * G, -d.gz[s] * G, s, 1);
  d.turbo[s] = boosting;
  // velocity ramp toward the target (<< 8), accel when a target exists else decel
  const ramp = (cur: number, tgt: number, acc: number) => {
    if (cur === tgt) return cur;
    const step = tgt !== 0 ? acc : ph.dec;
    if (cur < tgt) { cur += step; if (cur > tgt) cur = tgt; } else { cur -= step; if (cur < tgt) cur = tgt; }
    return cur;
  };
  let vx = ramp(d.vx[s], tx << 8, ax), vz = ramp(d.vz[s], tz << 8, az);
  if (v === 'splash') {
    const k = spokePush(d, s);
    if (k) { vx = Math.trunc(k[0] * 0x6000); vz = Math.trunc(k[1] * 0x6000); }
  }
  vx = clamp(vx, -0xc800, 0xc800); vz = clamp(vz, -0xc800, 0xc800);
  d.vx[s] = vx; d.vz[s] = vz;
  d.gx[s] += vx >> 8; d.gz[s] += vz >> 8;
  const n = wallResolve(d, s); // second call: the wall deflects the kart (78% of its speed, 72 degrees off the normal) and turns it
  if (n >= 0) {
    const h = ang(vx >> 8, vz >> 8);
    const dd = (h - n) & 0xfff;
    const u = dd < 0x801 ? n + 0x338 : n - 0x338;
    const mag = Math.floor((Math.floor(Math.sqrt(vx * vx + vz * vz))) * 200 / 256);
    d.vx[s] = (mag * Ti(u - 0x400)) >> 12; d.vz[s] = (mag * Ti(u)) >> 12;
    d.tgt[s] = (u + 0x800) & 0xfff;
    if ((d.vx[s] !== 0 || d.vz[s] !== 0) && dd > 0x600 && dd < 0xa00) emit(w, 'wall', d.gx[s] * G, -d.gz[s] * G, s, 1);
  }
  // fall (Toxic r > 3072, Dante r > 3328, Splash estimated)
  if (v !== 'dot' && Math.hypot(d.gx[s], d.gz[s]) > RING[v].fall && st !== S_FALL) enterFall(w, d, s);
}

function enterFall(w: World, d: Data, s: number) {
  setState(d, s, S_FALL);
  d.fc[s] = 0; d.fph[s] = 0; d.fl[s] = 0; d.dvy[s] = 0;
  d.p54[s] = ang(d.gx[s], d.gz[s]);
  d.item[s] = 0; d.turbo[s] = false;
  emit(w, 'fall', d.gx[s] * G, -d.gz[s] * G, s, 1);
}

/** FUN_800bafc8: falling clip, then respawn 512 toward the hub dropped from above (gravity 768, bounce 100/256), second landing ends it */
function fallStep(w: World, d: Data, s: number) {
  d.fc[s]++;
  if (d.fph[s] === 0) {
    d.vx[s] = d.vz[s] = 0;
    d.gy[s] = -(d.fc[s] * d.fc[s]) / 2; // sink (visual only: the real kart stays put while the clip plays)
    if (d.fc[s] >= (d.variant === 'splash' ? FALL_CLIP_SPLASH : FALL_CLIP)) {
      d.fph[s] = 1;
      d.gx[s] -= Ti(d.p54[s] - 0x400) >> 3; d.gz[s] -= Ti(d.p54[s]) >> 3;
      d.gy[s] = DROP_H; d.dvy[s] = 0;
      emit(w, 'fall', d.gx[s] * G, -d.gz[s] * G, s, 2);
    }
  } else {
    d.yaw[s] = d.tgt[s] = (d.p54[s] - 0x200) & 0xfff;
    d.vx[s] = d.vz[s] = 0;
    d.dvy[s] += 0x300;
    d.gy[s] -= d.dvy[s] >> 8;
    if (d.gy[s] < 0) {
      d.gy[s] = 0;
      d.dvy[s] = -((d.dvy[s] * 100) >> 8);
      if (++d.fl[s] > 1) { setState(d, s, S_DRIVE); d.dvy[s] = 0; d.stun[s] = 0; }
    }
  }
}

/** FUN_800bc0a4: the hit hop, the kart spins on the ground once it lands; 62 handler calls in all */
function hitStep(d: Data, s: number) {
  d.vy[s] += d.vy[s] < 0 ? 10 : 20;
  d.gy[s] -= d.vy[s];
  if (d.vy[s] > 0 && d.gy[s] < 0) { d.gy[s] = 0; d.yaw[s] = (d.yaw[s] + 0x100) & 0xfff; }
  if (d.cnt[s]-- < 0) { setState(d, s, S_DRIVE); d.gy[s] = 0; d.vy[s] = 0; }
}

function lapCheck(w: World, d: Data, s: number, pz: number) {
  const x = d.gx[s], z = d.gz[s];
  if (x > 0 && pz > LINE_Z && z <= LINE_Z) d.c30[s] = Math.min(1, d.c30[s] + 1);
  else if (x > 0 && pz <= LINE_Z && z > LINE_Z) d.c30[s] = Math.max(-1, d.c30[s] - 1);
  if (d.c30[s] === 1) {
    d.c30[s] = 0;
    if (d.c148[s] === 0) d.c148[s] = 1;
    else if (d.finish[s] < 0) {
      d.lap[s]++;
      emit(w, 'lap', x * G, -z * G, s, Math.max(0, DR_LAPS - d.lap[s]) / DR_LAPS);
      if (d.lap[s] >= DR_LAPS) {
        d.finish[s] = w.time;
        if (d.first < 0) d.first = w.time;
        emit(w, 'finish', x * G, -z * G, s, 1);
      }
    }
  }
}

/** race progress key: lower = further ahead (laps remaining * 0x1000 + angle progress, FUN_800bd99c) */
function key(d: Data, s: number): number {
  const a = Math.round((polarAng(d.gx[s], d.gz[s]) * 4096) / TAU);
  const prog = (0x152c - a) & 0xfff;
  return (DR_LAPS - d.lap[s]) * 0x1000 + prog - d.c148[s] * 0x1000;
}

function useItem(w: World, d: Data, s: number) {
  if (d.item[s] === 1) {
    const x = d.gx[s], z = d.gz[s];
    const a = polarAng(x, z), r = Math.hypot(x, z);
    // direction of travel: the side of the tangent the kart is facing
    const hx = -sinT(d.yaw[s]), hz = -cosT(d.yaw[s]);
    const tx = Math.cos(a), tz = -Math.sin(a);
    const sg = hx * tx + hz * tz >= 0 ? 1 : -1;
    const b = addBody(w, 'missile', s, x * G, -z * G, 384 * G, 1);
    d.mis.push({ id: b.id, o: s, a, r, sg, b: 0, age: 0, gy: d.gy[s] });
    emit(w, 'missile', x * G, -z * G, s, 1);
    d.item[s] = 0;
  } else if (d.item[s] === 2) {
    d.shield[s] = 15; // FUN_800c1cfc: 15 frames of pushing the first kart in range away; blocks pickups meanwhile (S+0x130)
    d.item[s] = 0;
    emit(w, 'shield', d.gx[s] * G, -d.gz[s] * G, s, 1);
  }
}

/** FUN_800b5d14 / FUN_800b5a70: rotating spokes that rise out of the floor in patterns */
function stepSplash(w: World, d: Data) {
  const ended = d.first >= 0;
  d.rot = (d.rot - (d.pat === 1 || d.pat === 2 ? -4 : 4)) & 0xfff;
  if (d.wait >= 0) d.wait--;
  else {
    if (ended) d.pat = 5;
    // FUN_800b5a70
    d.pt = ended ? 0 : d.pt + 1;
    if (d.pt > (d.pat === 5 ? 1800 : PAT_LEN)) {
      d.pt = 0;
      d.smax = 17 + R_(w, 12);
      for (const q of d.sp) { q.started = false; q.cnt = 0; }
      d.pat = R_(w, 5);
      emit(w, 'spoke', 0, 0, -1, 0);
    } else {
      const tab = PAT[d.pat];
      d.sp.forEach((q, i) => {
        const [hold, delay] = tab[i];
        if (!q.started && delay !== -1) {
          if (q.cnt < delay) q.cnt++;
          else { q.started = true; q.state = 1; emit(w, 'spoke', 0, 0, -1, 1); }
        }
        if (q.started) {
          if (ended) q.state = 2;
          if (q.state === 2) { q.ext -= 2; if (q.ext < 0) { q.ext = 0; q.state = 0; } }
          else if (q.state === 1) { q.ext += 2; if (q.ext > d.smax) { q.ext = d.smax; q.state = 3; } }
          else if (q.state === 3) {
            const c = q.hold++;
            if (hold < c) { q.hold = 0; q.state = 2; emit(w, 'spoke', 0, 0, -1, 2); }
          }
        }
      });
    }
  }
  const rods = w.bodies.filter((b) => b.kind === 'rod');
  rods.forEach((rd, i) => {
    const q = d.sp[i];
    rd.y = q.ext / 28; rd.vy = q.ext * 16;
    const a = (i * 0x2aa + d.rot) & 0xfff;
    rd.face = (a * TAU) / 4096 - Math.PI / 2; rd.cd = a;
  });
}

/** FUN_800c2e10 (Toxic monster) + FUN_800c3738/3934 (the three blobs it spits out) */
function stepToxic(w: World, d: Data) {
  const ended = d.first >= 0;
  d.monT++;
  if (d.monS === 3) {
    d.mon = 0;
    const t = d.monTim--;
    if (t < 0 && !ended) { d.monTim = 0x1c2 + R_(w, 0x96); d.monS = 0; d.monT = 0; emit(w, 'monster', 0, 0, -1, 1); }
  } else if (d.monS === 0) {
    d.mon = clamp(d.monT / 60, 0, 1);
    if (d.monT >= MON_RISE) { d.monS = 1; d.monT = 0; }
  } else if (d.monS === 1) {
    d.mon = 1;
    if (d.monT === 22) {
      for (let k = 0; k < 3; k++) {
        const kk = d.blobK; d.blobK = (d.blobK + 1) % 3;
        const a = -0x200 * kk;
        const tx = (Ti(a + 0x600) * 7) >> 4, tz = (Ti(a + 0xa00) * 7) >> 4;
        const b = addBody(w, 'rock', -1, BLOB_START[0] * G, -BLOB_START[2] * G, 200 * G, 1);
        d.blobs.push({ id: b.id, x: BLOB_START[0], y: BLOB_START[1], z: BLOB_START[2], vx: tx, vy: 0, vz: tz, k: kk, init: false, st: 0, tm: 0x5a });
      }
    }
    if (d.monT >= MON_ATK) { d.monS = 2; d.monT = 0; }
  } else {
    d.mon = clamp(1 - d.monT / MON_SINK, 0, 1);
    if (d.monT >= MON_SINK) { d.monS = 3; d.monT = 0; d.mon = 0; emit(w, 'monster', 0, 0, -1, 0); }
  }
  // barrels (FUN_800b6474 / 800b6108): contact within 384 pushes the kart out, spins it and removes the barrel for 180 + rand(60) frames
  d.bar.forEach((b, bi) => {
    if (b.t > 0) { if (--b.t === 0) emit(w, 'barrel', b.x * G, -b.z * G, bi, 2); return; }
    let used = false;
    for (let s = 0; s < 4; s++) {
      const dx = d.gx[s] - b.x, dz = d.gz[s] - b.z, d2 = dx * dx + dz * dz;
      if (d2 >= 0x24000) continue;
      const dist = Math.sqrt(d2) || 1, push = 0x180 - dist;
      d.gx[s] += (dx / dist) * push; d.gz[s] += (dz / dist) * push;
      const vn = d.vx[s] * dx / dist + d.vz[s] * dz / dist; // FUN_800be7b4 (kart/barrel exchange, estimated as a mirror bounce)
      if (vn < 0) { d.vx[s] -= 2 * vn * dx / dist; d.vz[s] -= 2 * vn * dz / dist; }
      used = true;
      if (d.state[s] !== S_FALL) hit(w, d, s, -1);
    }
    if (used) { b.t = 0xb4 + R_(w, 0x3c); emit(w, 'barrel', b.x * G, -b.z * G, bi, 1); }
  });
  // blobs
  const gone = new Set<number>();
  for (const b of d.blobs) {
    if (ended) { gone.add(b.id); continue; }
    const nearKart = () => {
      for (let s = 0; s < 4; s++) {
        if ((b.x - d.gx[s]) ** 2 + (b.z - d.gz[s]) ** 2 < 0x10000) { hit(w, d, s, -1); return true; }
      }
      return false;
    };
    if (b.st === 0) {
      if (!b.init) { // FUN_8008c5c4: ballistic arc to the landing target (b.vx/b.vz hold the target here)
        const dx = b.vx - BLOB_START[0], dz = b.vz - BLOB_START[2];
        const F = Math.floor(Math.floor(Math.sqrt(dx * dx + dz * dz)) / 64) || 1;
        b.vy = Math.trunc((0 - BLOB_START[1]) / F) - (F >> 1) * 16;
        const a = ang(dx, dz);
        b.vx = (64 * Ti(a - 0x400)) >> 12; b.vz = (64 * Ti(a)) >> 12;
        b.init = true;
      }
      b.y += b.vy; b.vy += 16; b.x += b.vx; b.z += b.vz;
      if (b.y >= 0 && b.vy > 0) { b.y = 0; b.st = 1; }
    } else if (b.st === 1) {
      if (nearKart()) { gone.add(b.id); continue; }
      if (b.tm-- < 0) b.st = 2;
    } else if (b.st === 2) {
      const p = ang(b.x, b.z), a = (p + 0x400) & 0xfff;
      b.x -= Ti(a - 0x400) >> 7; b.z -= Ti(a) >> 7;
      if (nearKart()) { gone.add(b.id); continue; }
      if (a < 0x400) b.st = 3;
    } else {
      b.z -= Ti(0x800) >> 7; // z += 32
      if (b.x * b.x + b.z * b.z > 0x790000) { gone.add(b.id); continue; }
    }
    const bd = w.bodies.find((o) => o.id === b.id);
    if (bd) { bd.x = b.x * G; bd.z = -b.z * G; bd.y = Math.max(0, -b.y * G); }
  }
  if (gone.size) { d.blobs = d.blobs.filter((b) => !gone.has(b.id)); w.bodies = w.bodies.filter((b) => !gone.has(b.id)); }
}

/** FUN_800c2388: the Dante volcano throws three rocks out of the crater every ~300 frames */
function stepDante(w: World, d: Data) {
  const ended = d.first >= 0;
  if (ended) { for (const k of d.rocks) { const b = w.bodies.find((o) => o.id === k.id); if (b) b.alive = false; } d.rocks = []; return; }
  if (d.vs === 0) {
    // timer counts 450 -> -1 (rumble sfx at 60), then the launch frame
    d.vt--;
    if (d.vt < 0) d.vs = 1;
  } else if (d.vs === 1) {
    let u = R_(w, 0x1000);
    for (let i = 0; i < 3; i++) {
      const spd = 0xc - R_(w, 3);
      const b = addBody(w, 'rock', -1, 0, 0, 400 * G, 1);
      d.rocks.push({ id: b.id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: (Ti(u - 0x400) * 0x4b) >> 9, tz: (Ti(u) * 0x4b) >> 9, spd, init: false });
      u += 0x555 + R_(w, 0x200);
    }
    emit(w, 'monster', 0, 0, -1, 1);
    d.vt = 0x14; d.vs = 2;
  } else {
    const dead = new Set<number>();
    for (const k of d.rocks) {
      const r2 = k.x * k.x + k.z * k.z;
      if (!k.init) { // FUN_8008c5c4 start: reach the target in dist/speed frames, gravity 4
        const F = Math.floor(Math.floor(Math.sqrt(k.tx * k.tx + k.tz * k.tz)) / k.spd) || 1;
        k.vy = -(F >> 1) * 4;
        const a = ang(k.tx, k.tz);
        k.vx = (k.spd * Ti(a - 0x400)) >> 12; k.vz = (k.spd * Ti(a)) >> 12;
        k.init = true;
      }
      k.y += k.vy; k.vy += 4; k.x += k.vx; k.z += k.vz;
      if (k.y >= 0x100 && k.vy > 0) k.y = 0x100;
      if (r2 < 0x90000) { // inside the crater: bounce on the kart plane, skid out at 20 per axis
        if (k.y > -0x100 && k.vy > 0) {
          k.vy = -((k.vy * 0x94) >> 8);
          k.vx = k.vx < 0 ? -20 : k.vx > 0 ? 20 : 0; k.vz = k.vz < 0 ? -20 : k.vz > 0 ? 20 : 0;
        }
      } else if (k.y > -0x80 && k.vy > 0) { k.vy = -((k.vy * 0x94) >> 8); k.y = -0x80; }
      if (r2 > 0x900000) dead.add(k.id);
    }
    for (const k of d.rocks) {
      if (dead.has(k.id)) continue;
      for (let s = 0; s < 4; s++) {
        const dy = -256 - d.gy[s] - k.y;
        if ((k.x - d.gx[s]) ** 2 + (k.z - d.gz[s]) ** 2 + dy * dy < 160000) { hit(w, d, s, -1); dead.add(k.id); break; }
      }
    }
    for (const k of d.rocks) {
      const b = w.bodies.find((o) => o.id === k.id);
      if (b) { b.x = k.x * G; b.z = -k.z * G; b.y = Math.max(0.2, -k.y * G); }
    }
    if (dead.size) { d.rocks = d.rocks.filter((k) => !dead.has(k.id)); w.bodies = w.bodies.filter((b) => !dead.has(b.id)); }
    if (!d.rocks.length && d.vt-- < 0) { d.vt = 300; d.vs = 0; }
  }
}

function step(w: World, inputs: (InputState | null | undefined)[], _dt: number) {
  const d = w.data as Data;
  const v = d.variant;
  const ph = phys(v);
  const ps = players(w);
  d.f++;
  // hazards
  if (v === 'splash') stepSplash(w, d);
  else if (v === 'toxic') stepToxic(w, d);
  else if (v === 'dante') stepDante(w, d);

  for (const p of ps) {
    const s = p.slot;
    const raw = inputs[s] ?? IDLE;
    const done = d.finish[s] >= 0;
    const st = d.state[s];
    const pz = d.gz[s];
    d.st[s]++;
    let pad = padOf(raw);
    if (st === S_HIT || st === S_FALL || done) pad = NOPAD;
    moveKart(w, d, s, pad, ph, d.bf[s] === d.f);
    if (st === S_HIT) hitStep(d, s);
    else if (st === S_FALL) fallStep(w, d, s);
    else if (st === S_HOP) {
      d.gy[s] -= d.vy[s];
      d.vy[s] += d.vy[s] < 0 ? 5 : 10;
      if (d.gy[s] <= 0 && d.vy[s] > 0) { d.gy[s] = 0; d.vy[s] = 0; setState(d, s, S_DRIVE); }
    }

    // pickups
    const grounded = d.state[s] !== S_FALL;
    if (grounded && d.shield[s] === 0 && !done) {
      for (const o of w.bodies) {
        if (o.kind !== 'fruit' && o.kind !== 'item') continue;
        const ox = o.x / G, oz = -o.z / G;
        if ((ox - d.gx[s]) ** 2 + (oz - d.gz[s]) ** 2 >= 0x24000 || Math.abs(d.gy[s]) >= 0x200) continue;
        if (o.kind === 'fruit') {
          d.fuel[s] = Math.min(FUEL_MAX, d.fuel[s] + 0x2000);
          emit(w, 'pickup', o.x, o.z, s, 2);
        } else {
          d.item[s] = o.dash === 5 ? 2 : 1;
          emit(w, 'pickup', o.x, o.z, s, 1);
        }
        d.occ[o.vy] = false;
        o.alive = false;
      }
    }
    // item / hop
    const press = pad.use && !d.prevB[s];
    d.prevB[s] = pad.use;
    if (press && d.state[s] === S_DRIVE && !done) {
      if (d.item[s]) useItem(w, d, s);
      else if (v === 'splash') { d.state[s] = S_HOP; d.st[s] = 0; d.vy[s] = -0x44; emit(w, 'hop', d.gx[s] * G, -d.gz[s] * G, s, 1); }
    }
    if (d.state[s] !== S_FALL) lapCheck(w, d, s, pz);
  }

  // karts vs karts (FUN_800bebc0)
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) kartPair(w, d, i, j);
  // shield (FUN_800c1cfc): the first other kart within 900 is thrown away at 0x8000, 15 frames
  for (let s = 0; s < 4; s++) {
    if (d.shield[s] <= 0) continue;
    d.shield[s]--;
    for (let o = 0; o < 4; o++) {
      if (o === s) continue;
      const dx = d.gx[o] - d.gx[s], dz = d.gz[o] - d.gz[s];
      if (dx * dx + dz * dz < 810000) {
        const l = Math.hypot(dx, dz) || 1;
        d.vx[o] = clamp(Math.trunc((dx / l) * 0x8000), -0xc800, 0xc800); d.vz[o] = clamp(Math.trunc((dz / l) * 0x8000), -0xc800, 0xc800);
        break;
      }
    }
  }
  missiles(w, d);
  // pickup spawners (FUN_800c04ec / FUN_800c0cb4)
  d.pre--;
  if (d.pre < 0) {
    const cap = d.f <= 900 ? 3 : d.f <= 1800 ? 2 : 1;
    const fruits = w.bodies.filter((b) => b.kind === 'fruit' && b.alive).length;
    if (fruits + cap !== 6) { d.cdF--; if (d.cdF <= 0) { spawnPickup(w, d, 'fruit', v); d.cdF = 30; } }
    if (v !== 'splash') {
      const held = d.item.filter((i) => i > 0).length;
      const crates = w.bodies.filter((b) => b.kind === 'item' && b.alive).length;
      const want = d.f <= 1800 ? 2 : 3;
      if (crates + held < want) { d.cdC--; if (d.cdC <= 0) { spawnPickup(w, d, 'item', v); d.cdC = 30; } }
    }
  }
  w.bodies = w.bodies.filter((b) => b.alive);

  // sync bodies
  for (const p of ps) {
    const s = p.slot;
    p.x = d.gx[s] * G; p.z = -d.gz[s] * G; p.y = (d.state[s] === S_FALL ? d.gy[s] : Math.max(0, d.gy[s])) * G;
    p.face = (-d.yaw[s] * TAU) / 4096;
    p.vx = (d.vx[s] / 256) * G * 30; p.vz = (-d.vz[s] / 256) * G * 30;
    d.stun[s] = d.state[s] === S_HIT || d.state[s] === S_FALL ? 1 : 0;
  }
}

function kartPair(w: World, d: Data, i: number, j: number) {
  if (d.state[i] === S_FALL || d.state[j] === S_FALL) return;
  if (Math.abs(d.gy[i] - d.gy[j]) >= 0x181) return;
  const dx = d.gx[j] - d.gx[i], dz = d.gz[j] - d.gz[i];
  const dist = Math.hypot(dx, dz);
  if (dist >= 0x180) return;
  const l = dist || 1, nx = dx / l, nz = dz / l;
  const push = (0x188 - dist) / 2;
  d.gx[i] -= nx * push; d.gz[i] -= nz * push; d.gx[j] += nx * push; d.gz[j] += nz * push;
  const sp = (s: number) => Math.hypot(d.vx[s], d.vz[s]) / 256;
  const si = sp(i), sj = sp(j);
  // equal masses, restitution 1: swap the normal components
  const vi = d.vx[i] * nx + d.vz[i] * nz, vj = d.vx[j] * nx + d.vz[j] * nz;
  if (vi - vj > 0) {
    d.vx[i] += (vj - vi) * nx; d.vz[i] += (vj - vi) * nz; d.vx[j] += (vi - vj) * nx; d.vz[j] += (vi - vj) * nz;
    const cap = (s: number) => { const m = Math.hypot(d.vx[s], d.vz[s]), c = PHYS.boost * 256; if (m > c) { d.vx[s] *= c / m; d.vz[s] *= c / m; } };
    cap(i); cap(j);
    if (si + sj > 30) emit(w, 'bump', (d.gx[i] + d.gx[j]) / 2 * G, -(d.gz[i] + d.gz[j]) / 2 * G, -1, Math.min(1, (si + sj) / 140));
  }
  // the faster kart that rams a much slower one spins out
  if (sj * sj < (si * si) / 2 && si > 79.6) hit(w, d, i, j);
  else if (si * si < (sj * sj) / 2 && sj > 79.6) hit(w, d, j, i);
}

function missiles(w: World, d: Data) {
  const dead = new Set<number>();
  for (const m of d.mis) {
    m.age++;
    m.a += (m.sg * 140) / m.r;
    const x = m.r * Math.sin(m.a), z = m.r * Math.cos(m.a);
    const b = w.bodies.find((o) => o.id === m.id);
    let boom = false;
    // wall bounce (Dot polygons) / lifetime
    if (d.variant === 'dot') {
      const hq = polyQuery(DOT_HUB, x, z), oq = polyQuery(DOT_OUT, x, z);
      if (hq.inside || hq.d < 150 || !oq.inside || oq.d < 150) { m.sg = -m.sg; m.b++; m.a += (m.sg * 140 * 2) / m.r; emit(w, 'bump', x * G, -z * G, -1, 0.5); if (m.b >= 3) boom = true; }
    } else if (m.age > 300) boom = true;
    for (let s = 0; s < 4 && !boom; s++) {
      if (s === m.o || d.state[s] === S_FALL) continue;
      if ((x - d.gx[s]) ** 2 + (z - d.gz[s]) ** 2 < 0x24000 && Math.abs(m.gy - d.gy[s]) <= 0x180) {
        hit(w, d, s, m.o); // FUN_800bf0f8: no shield immunity
        boom = true;
      }
    }
    if (b) { b.x = x * G; b.z = -z * G; b.y = m.gy * G; b.vx = Math.cos(m.a) * m.sg * 140 * G * 30; b.vz = Math.sin(m.a) * m.sg * 140 * G * 30; }
    if (boom) { dead.add(m.id); emit(w, 'explode', x * G, -z * G, -1, 1, m.o); }
  }
  if (dead.size) { d.mis = d.mis.filter((m) => !dead.has(m.id)); w.bodies = w.bodies.filter((b) => !dead.has(b.id)); }
}

/**
 * FUN_800b3e60: does the segment from the kart along (fx, fz) touch the circle at (cx, cz)? (the game feeds it the *backward* vector and
 * its quadratic solves for the mirrored circle, so the real test is a forward ray). Roots are compared in 1/256 of the segment.
 */
function segHit(fx: number, fz: number, cx: number, cz: number, r: number): boolean {
  const a = fx * fx + fz * fz, b = 2 * (fx * cx + fz * cz), c = cx * cx + cz * cz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a === 0) return false;
  const s = Math.sqrt(disc);
  const tl = ((b + s) / (2 * a)) * 256, ts = ((b - s) / (2 * a)) * 256;
  if (tl < 0 && ts < 0) return false;
  if (ts >= 1) return ts < 256;
  return tl < 256;
}

const hash32 = (n: number) => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const insideHub = (v: string, x: number, z: number) => (v === 'dot' ? polyQuery(DOT_HUB, x, z).inside : Math.hypot(x, z) < RING[v].rin);

/**
 * The game's CPU (FUN_800b4708 -> FUN_800b5360 / 800b4edc): it always runs and boosts (while it has fuel), steering with two forward probes
 * (512 ahead: inside the hub -> left; 1936 ahead: past the outer edge -> right), kart avoidance (not Dot), items. Toxic barrel dodging is not ported
 * (barrel positions unknown). It also marks the slot as bot-driven so the sim uses the AI run acceleration (FUN_800b8fd8).
 */
function bot(w: World, slot: number): InputState {
  const d = w.data as Data;
  if (!d) return IDLE;
  d.bf[slot] = d.f + 1;
  const st = d.state[slot];
  if (st === S_HIT || st === S_FALL || d.finish[slot] >= 0) return IDLE;
  const v = d.variant;
  const x = d.gx[slot], z = d.gz[slot], yaw = d.yaw[slot];
  const fwx = -sinT(yaw), fwz = -cosT(yaw);
  let l = false, r = false, boost = true, use = false;
  const pMe = ang(x, z);
  // nearest pickup (FUN_800c5c64); chased when within 1600 and further along the lap (larger polar angle)
  let near: { x: number; z: number } | null = null, nd = Infinity;
  for (const o of w.bodies) {
    if ((o.kind !== 'fruit' && o.kind !== 'item') || !o.alive) continue;
    const ox = o.x / G, oz = -o.z / G, dd = (ox - x) ** 2 + (oz - z) ** 2;
    if (dd < nd) { nd = dd; near = { x: ox, z: oz }; }
  }
  const chase = near !== null && nd < 0x271000 && pMe < ang(near.x, near.z);
  // kart avoidance (FUN_800b442c)
  if (v !== 'dot') {
    for (let o = 0; o < 4; o++) {
      if (o === slot) continue;
      if (sext(ang(d.gx[o], d.gz[o]) - pMe) > 99 && segHit(fwx * 1524, fwz * 1524, d.gx[o] - x, d.gz[o] - z, 0x180)) {
        if (d.gx[o] ** 2 + d.gz[o] ** 2 < 0x310001) { l = true; r = false; } else { r = true; l = false; }
      }
    }
  }
  if (chase && near) {
    const diff = sext(ang(x - near.x, z - near.z) - yaw);
    if (diff > 500) { r = true; l = false; }
    if (diff < -500) { l = true; r = false; }
    boost = false; // FUN_800b5528: run only
  } else {
    if (insideHub(v, x + fwx * 512, z + fwz * 512)) l = true;
    const fx = x + fwx * 1936, fz = z + fwz * 1936;
    if (v === 'dot' ? !polyQuery(DOT_OUT, fx, fz).inside : fx * fx + fz * fz > (v === 'toxic' ? 0x510000 : 0x640000)) r = true;
  }
  if (v === 'toxic') {
    // FUN_800b3890: nearest live barrel that is ahead in the lap, on the 4096-long forward ray -> steer away from the hub / towards it, boost off
    let bi = -1, bd = Infinity;
    for (let i = 0; i < d.bar.length; i++) {
      const b = d.bar[i];
      if (b.t > 0) continue;
      if (((pMe - 0x400) & 0xfff) <= ((ang(b.x, b.z) - 0x400) & 0xfff)) {
        const dd = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (dd < bd) { bd = dd; bi = i; }
      }
    }
    if (bi >= 0 && segHit(fwx * 4096, fwz * 4096, d.bar[bi].x - x, d.bar[bi].z - z, 0x180)) {
      if (d.bar[bi].x ** 2 + d.bar[bi].z ** 2 < 0x400000) { r = false; l = true; } else { l = false; r = true; }
      boost = false;
    }
    // FUN_800b3bc0: the nearest blob on the forward ray
    let nb: Blob | null = null; bd = Infinity;
    for (const b of d.blobs) { const dd = (x - b.x) ** 2 + (z - b.z) ** 2; if (dd < bd) { bd = dd; nb = b; } }
    if (nb && segHit(fwx * 4096, fwz * 4096, nb.x - x, nb.z - z, 0x180)) {
      if (nb.x ** 2 + nb.z ** 2 < x * x + z * z) { r = false; l = true; } else { l = false; r = true; }
      boost = false;
    }
  }
  if (v === 'splash') {
    // FUN_800b372c: hop when a raised spoke is within 256 of the point 64 ahead
    const px = x + fwx * 64, pz = z + fwz * 64;
    d.sp.forEach((q, i) => {
      if (q.ext < 2) return;
      const [ux, uz] = spokeArm(d, i);
      const t = clamp(px * ux + pz * uz, 1000, 2700);
      if (Math.hypot(px - ux * t, pz - uz * t) < 256) use = true;
    });
  } else if (d.item[slot] === 1 || d.item[slot] === 2) {
    // FUN_800b41dc (missile) / FUN_800b406c (shield): pick a random target (weights equal, 1/3 chance per try, 3 tries a frame);
    // missile: it is ahead in the lap and on the forward ray (2048 long); shield: it is within 768
    const live = [0, 1, 2, 3].filter((o) => o !== slot && d.finish[o] < 0).length;
    for (let o = 0; o < 4 && !use; o++) {
      if (o === slot) continue;
      let pick = -1;
      const hh = hash32(d.f * 7919 + slot * 104729 + o * 1299721); // deterministic stand-in for the game's rand (keeps world.rng untouched)
      const k0 = (hh >>> 8) & 3, thr = (hh >>> 12) & 4095;
      for (let i = k0; i < k0 + 4 && live; i++) {
        const k = i & 3;
        if (k === slot) continue;
        if (thr < (d.finish[k] >= 0 ? -1 : 4096 / live)) { pick = k; break; }
      }
      if (pick !== o) continue;
      if (d.item[slot] === 1) use = sext(ang(d.gx[o], d.gz[o]) - pMe) > 99 && segHit(fwx * 2048, fwz * 2048, d.gx[o] - x, d.gz[o] - z, 0x180);
      else use = (d.gx[o] - x) ** 2 + (d.gz[o] - z) ** 2 < 0x90000;
    }
  }
  return { x: (r ? 1 : 0) - (l ? 1 : 0), y: -1, a: boost && d.fuel[slot] > 0, b: use };
}

export const dashRace: MiniGame = {
  id: 'dashRace',
  name: 'Crash Dash',
  description: `Race ${DR_LAPS} laps round the track. Fruit fuels the boost; crates hold a missile (shield on Toxic Dash). First across the line - or the leader at 1:30 - wins.`,
  controls: '{lr} steer. Hold {up} to run. {a} boost (uses fuel). {b} use your item (Splash Dash: hop).',
  variants: DR_VARIANTS,
  maxTime: 90,
  setup,
  step,
  isOver(w) {
    const d = w.data as Data;
    return d.first >= 0 && w.time - d.first > 1;
  },
  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const fa = d.finish[a] >= 0, fb = d.finish[b] >= 0;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return d.finish[a] - d.finish[b] || a - b;
      return key(d, a) - key(d, b) || a - b;
    });
  },
  bot,
};
