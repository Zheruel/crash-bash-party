/**
 * CRASH DASH (game id 'dashRace', levels 23-26) - rules taken from the decompiled overlay (re/notes/crashDash.md).
 *
 * Everything is simulated in the game's own units (1024 = 1 model unit, 30 Hz frame counts, yaw 0..4095) and mapped to
 * world units for the bodies: x_w = x_g * DR_K / 1024, z_w = -z_g * DR_K / 1024, face = -yaw * 2pi / 4096.
 *
 *   Left / right (stick x): tank-like steering. The target yaw moves +-turn per frame and yaw follows (tgt - yaw) >> 2.
 *   Up (stick y < 0, = R1): run. Boost (a, = Square): burns fuel. Circle (b): use the held item (Splash with nothing held: hop).
 *   The first tenth-lap crossing processed in the current update ends the race. At 1:30, equal lap leaders draw.
 *
 * world.data (all per slot arrays of 4):
 *   variant, f (frame), gx gz gy (game units; gy up), yaw tgt vx vz vy, fuel (0..1), item (0 none, 1 missile, 2 shield),
 *   shield (frames left), state (0x5b drive, 0x5d hit, 0x5e hop, 0x61 fall), st (frames in state), turbo, stun (s, hit/fall),
 *   lap (laps done), c30 c148 (line counter), finish (time s or -1), first, rot/pat (splash), mon (toxic monster 0..1)
 * Bodies: 'player', 'fruit', 'item' (crate), 'missile', 'rod' (splash spoke: face = direction, y = height 0..1), 'rock' (dante).
 * Events: turbo pickup missile shield explode hit lap finish bump hop fall monster spoke
 */
import { addBody, clamp, discRandomInt, emit } from '../physics';
import { atan2g } from '../ps1Angle';
import { ps1SqrtQ6 } from '../ps1Sqrt';
import { IDLE, type Body, type InputState, type MiniGame, type SlotInfo, type World } from '../types';
import { createPlayerDispatch, nextPlayerOrder, TAU, pickVariant, VERSUS_CLOCK_END } from './common';
import { AI_HUB, DOT_OUTER, FALL_EDGE, SPOKE_REACH, TRACK_WALLS } from './dashCollisionData';
import { createDantePool, spawnDanteActor, freeDanteActor, type DantePool } from './dantePool';
import { MISSILE_WALLS } from './dashObjectData';

export const DR_K = 3.4;
export const DR_LAPS = 10;
/** USA individual versus holds the grid through stage update 112. */
export const DASH_OPENING_TICKS = 112;
export const dashSpokeTurn = (pattern: number) => pattern === 1 || pattern === 2 ? 4 : -4;
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
const SKILL: Record<string, number[]> = { dot: [1, 11, 22], toxic: [1, 10, 20], splash: [1, 10, 20], dante: [1, 11, 22] };

const S_DRIVE = 0x5b, S_HIT = 0x5d, S_HOP = 0x5e, S_FALL = 0x61, S_WIN = 0x62;
export const DR_ANGLE = Math.PI / 2048;
export const dashRideHeight = (variant: string) => variant === 'dante' ? 180 : 256;
const RACE_SECONDS = 90;
/** fall clip (anim 0x4b, 0x54 on Splash) lengths measured from the character scripts in re/dumps/L23.ram: 24 / 32 frames */
const FALL_CLIP = 24, FALL_CLIP_SPLASH = 32;

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
/** Toxic monster updates from one animation transition to the next. */
const MON_RISE = 111, MON_ATK = 43, MON_SINK = 32;
/** blob landing targets by spawn index (FUN_800c3738) */
const BLOB_START = [-512, -668, -512];

/** Toxic barrels (model 0x5006), read from the game's barrel array at 0x800c6f88 (11 of them); a hit kart spins out, the barrel stays hidden until the next round */
export const DR_BARRELS = [[-1577, 2173], [-1142, 2253], [1529, 2189], [1158, 2446], [-2493, -719], [-2155, -1053], [-2173, -1572], [-2618, -230], [-2618, 236], [-321, -2639], [-257, -1428]];

export interface DashMotor {
  run: number;   // Tick the current sample began, or -1 while stopped.
  boost: number;
  puff: number;  // Boost exhaust postpones the run switch on every fifth powered tick.
  runPuff?: number;
}
const newMotor = (): DashMotor => ({ run: -1, boost: -1, puff: 0 });
export interface DashExhaust { kind: 'run' | 'boost' | 'spray'; born: number; x: number; y: number; z: number }
interface Spoke { ext: number; state: number; cnt: number; hold: number; started: boolean }
interface Blob { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; init: boolean; st: number; tm: number; yaw: number; frame: number }
interface Rock { id: number; fireActor?: number; slot?: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; tx: number; tz: number; spd: number; init: boolean; yaw: number; roll?: number }
interface Missile { id: number; owner: number; x: number; y: number; z: number; yaw: number; bounces: number; age: number }

interface Data {
  variant: string;
  f: number; openingTicks?: number;
  gx: number[]; gz: number[]; gy: number[]; vy: number[];
  yaw: number[]; tgt: number[]; vx: number[]; vz: number[];
  fuel: number[]; item: number[]; shield: number[];
  shieldOrigin?: ([number, number, number] | null)[]; // x, z and height of the shield object
  itemMarkers?: { item: number; yaw: number; x: number; y: number; z: number }[];
  state: number[]; st: number[]; turbo: boolean[]; stun: number[];
  lap: number[]; c30: number[]; c148: number[];
  finish: number[]; first: number; winner?: number;
  updateOrders?: number[][]; random?: [number, number];
  skill?: number; boostAt?: number[];
  pitch?: number[]; bank?: number[]; hitLock?: number[]; motors?: DashMotor[];
  /** Seats under CPU control at the last update, including disconnected humans. */
  cpuSeats?: number;
  bf?: number[]; // Per-seat frame stamps in older snapshots.
  prevB: boolean[];
  /** hit counter (S+0xc), fall handler calls / phase / landings / drop velocity / polar angle (S+0x54) */
  cnt: number[]; fc: number[]; fph: number[]; fl: number[]; dvy: number[]; p54: number[];
  hopBounce: boolean[];
  kartPose?: { script: number; frame: number; boostHeld: boolean }[];
  exhaust?: DashExhaust[];
  dantePool?: DantePool;
  rocksHidden?: boolean;
  respawnAt?: number[];
  occ: boolean[]; cdF: number; cdC: number; pre: number;
  /** Splash: spoke rotation, current pattern, pattern call counter, start wait, extension max */
  rot: number; pat: number; pt: number; wait: number; smax: number; sp: Spoke[];
  /** Toxic monster: state 0 rise 1 attack 2 sink 3 hidden, frames in state, hidden timer, visual rise 0..1 */
  mon: number; monS: number; monT: number; monTim: number; blobs: Blob[]; blobK: number; bar: { x: number; z: number; t: number }[];
  spitAt?: number; // Stage update that created the Toxic spit emitter.
  /** Dante volcano: state 0 wait 1 launch 2 flight, timer */
  vs: number; vt: number;
  rockMeshes?: { roll: number; trail: number }[];
  mis: Missile[];
  rocks: Rock[];
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const sdiff = (a: number, b: number) => { let d = (b - a) & 0xfff; if (d > 0x800) d -= 0x1000; return d; };
/** the game's trig table: cos(a) * 4096 (sin(a) = Ti(a - 0x400)) */
const Ti = (a: number) => Math.round(4096 * Math.cos((((a % 4096) + 4096) % 4096) * TAU / 4096));
/** signed 12-bit */
const sext = (a: number) => ((a & 0xfff) ^ 0x800) - 0x800;

const phys = (v: string): Phys => (v === 'splash' ? PHYS_SPLASH : PHYS);

/** FUN_800868b4 enter handlers: FUN_800c57b4 (0x5b script 0x48 / 0x52), FUN_800bba04 (0x5d road script 0x4a), FUN_800bad54 (0x61). */
function setState(d: Data, s: number, st: number) {
  d.state[s] = st;
  d.st[s] = 0;
  const pose = d.kartPose?.[s];
  const sea = d.variant === 'splash';
  if (pose && (st === S_DRIVE || st === S_FALL || (st === S_HIT && !sea))) {
    if (st === S_HIT) pose.script = 0x4a;
    else if (st === S_FALL) pose.script = sea ? 0x54 : 0x4b;
    else pose.script = sea ? 0x52 : 0x48;
    pose.frame = 0;
    pose.boostHeld = false;
  }
}

/** FUN_800868b4(p, 0x5d) -> FUN_800bba04: hit state. Enter: counter 60, vy -160, gravity 10 up / 20 down. No speed cut: the pad is zeroed, so the kart only decelerates. */
function hit(w: World, d: Data, s: number, by: number, interruptFall = false) {
  if (d.state[s] === S_HIT || (d.state[s] === S_FALL && !interruptFall) || d.state[s] === S_WIN || d.first >= 0) return;
  setState(d, s, S_HIT);
  d.cnt[s] = 60;
  d.vy[s] = -160; // up
  d.turbo[s] = false;
  emit(w, 'hit', d.gx[s] * G, -d.gz[s] * G, s, d.variant === 'splash' ? 0 : discRandomInt(w, 4), by);
}

/** Slot probe and FUN_80022a3c(.., 0x1702) shared by FUN_800c04ec (fruit) and FUN_800c0cb4 (crates). */
function spawnPickup(w: World, d: Data, kind: 'fruit' | 'item', start: number, rad: number): 'occupied' | 'unavailable' | 'spawned' {
  // The native search gives up at the sixteenth probe, including a free last slot.
  let k = start, probes = 1;
  while (probes < 16 && d.occ[k]) { k = (k + 1) & 15; probes++; }
  if (probes === 16) return 'occupied';
  if (d.dantePool) {
    // FUN_800c0cb4 claims the crate slot before FUN_80022a3c; FUN_800c04ec claims a fruit slot only for a created object.
    if (kind === 'item') d.occ[k] = true;
    const slot = spawnDanteActor(d.dantePool, 'pickup', -1, w.nextId);
    if (!slot) return 'unavailable';
    d.occ[k] = true;
    if (d.dantePool.actors[slot]!.body === undefined) return 'unavailable';
  } else d.occ[k] = true;
  const a = k * 0x100;
  const b = addBody(w, kind, -1, (rad * Ti(a - 0x400) >> 12) * G, -(rad * Ti(a) >> 12) * G, 384 * G, 1);
  b.vy = k; // pickup slot
  b.vx = -0x2000; // vertical 8.8 velocity (PS1 Y, down)
  b.dash = kind === 'item' && d.variant === 'toxic' ? 5 : 0; // crate type
  return 'spawned';
}

/** FUN_800bfd84 -> FUN_800c467c. Splash fruit stays on its spawn plane. */
function movePickup(b: Body, splash: boolean) {
  if (!splash) {
    b.vx += 0x200;
    const height = Math.round(b.y / G) - (b.vx >> 8);
    b.y = Math.max(0, height) * G;
    if (height < 0) b.vx = -b.vx;
  }
  b.cd++;
  b.face = -(b.cd * 0x80 & 0xfff) * DR_ANGLE;
}

function setup(w: World, slots: SlotInfo[]) {
  const variant = pickVariant(w, DR_VARIANTS);
  const z4 = [0, 0, 0, 0], f4 = [false, false, false, false], n4 = [-1, -1, -1, -1];
  const d: Data = {
    variant, skill: SKILL[variant][slots[0]?.level ?? 1], boostAt: [-1000, -1000, -1000, -1000], f: 0, gx: [...z4], gz: [...z4], gy: [...z4], vy: [...z4], yaw: [...z4], tgt: [...z4], vx: [...z4], vz: [...z4],
    fuel: [...z4], item: [...z4], shield: [...z4], state: [S_DRIVE, S_DRIVE, S_DRIVE, S_DRIVE], st: [...z4], turbo: [...f4], stun: [...z4],
    itemMarkers: z4.map(() => ({ item: 0, yaw: 0, x: 0, y: 0, z: 0 })),
    lap: [...z4], c30: [...z4], c148: [...z4], finish: [...n4], first: -1, prevB: [...f4],
    cnt: [...z4], fc: [...z4], fph: [...z4], fl: [...z4], dvy: [...z4], p54: [...z4],
    openingTicks: DASH_OPENING_TICKS, pitch: [...z4], bank: [...z4], hitLock: [...z4], motors: Array.from({ length: 4 }, newMotor),
    cpuSeats: slots.reduce((mask, s) => s.bot ? mask | (1 << s.slot) : mask, 0), hopBounce: [...f4], exhaust: [],
    occ: Array.from({ length: 16 }, (_, i) => i === 2), cdF: 30, cdC: 0, pre: 60,
    rot: 0, pat: 4, pt: 0, wait: 180, smax: 17, sp: [],
    mon: 0, monS: 3, monT: 0, monTim: 0, blobs: [], blobK: 0, bar: [], vs: 0, vt: 0x1c2, mis: [], rocks: [],
  };
  if (variant === 'dante') d.dantePool = createDantePool();
  w.data = d;
  Object.assign(d, createPlayerDispatch(w.rng));
  for (const s of slots) {
    const k = s.slot;
    const [x, z] = START[variant][k];
    d.gx[k] = x; d.gz[k] = z; d.yaw[k] = d.tgt[k] = 0;
    const b = addBody(w, 'player', k, x * G, -z * G, DR_KART_R * w.params.playerScale, 3);
    b.face = 0;
  }
  // FUN_800c5f54 -> FUN_800b4a4c installs the callbacks; FUN_800c5918 (player reset): drive state, yaw 0.
  // FUN_8007eb1c starts the clock. Prepare the GO snapshot. Finish and pickup clocks only advance during play.
  d.f = DASH_OPENING_TICKS;
  d.st.fill(d.f);
  // FUN_800b5778 initializes six spoke slots on every course. The last draw selects the pattern.
  for (let i = 0; i < 6; i++) d.pat = discRandomInt(w, 5);
  d.kartPose = z4.map(() => ({ script: variant === 'splash' ? 0x52 : 0x48, frame: d.f, boostHeld: false }));
  if (variant === 'splash') {
    d.wait -= d.f;
    d.rot = dashSpokeTurn(d.pat) * d.f & 4095;
    for (let i = 0; i < 6; i++) {
      const [ox, oz] = spokeOrigin(i);
      addBody(w, 'rod', -1, ox * G, -oz * G, 176 * G, 1);
      d.sp.push({ ext: 0, state: 0, cnt: 0, hold: 0, started: false });
    }
    syncSpokes(w, d);
  }
  if (variant === 'toxic') for (const [bx, bz] of DR_BARRELS) d.bar.push({ x: bx, z: bz, t: 0 }); // FUN_800b5f04
  if (variant === 'toxic') d.monTim = 0xf0 + discRandomInt(w, 0x5a) - d.f; // FUN_800c4774: hidden for 240..329 frames first
  if (variant === 'dante') {
    for (let i = 0; i < 3; i++) discRandomInt(w, 4096); // FUN_800c2284: the three hidden rock meshes receive a yaw at setup.
    d.vt = 0x1c2 - d.f;
  }
  for (let tick = 0; tick < d.f; tick++) {
    discRandomInt(w, 2); // FUN_80010394 advances the RNG before the stage callback.
    discRandomInt(w, 16); // Player dispatch runs during the starting grid lock.
  }
}

/** the pad as the game sees it */
interface Pad { l: boolean; r: boolean; run: boolean; boost: boolean; use: boolean }
const NOPAD: Pad = { l: false, r: false, run: false, boost: false, use: false };
const padOf = (inp: InputState): Pad => ({ l: inp.x < -0.25, r: inp.x > 0.25, run: !!inp.r || inp.y < -0.3, boost: inp.a, use: inp.b });

/** Fixed-point squared distance to a native wall triangle (FUN_800b66c4, 8 fractional bits). */
function wallDistanceSq(face: number[], x: number, y: number, z: number) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = face;
  const px = ax-x, py = ay-y, pz = az-z;
  const dot = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
    (x1*x2 >> 8) + (y1*y2 >> 8) + (z1*z2 >> 8);
  const aa = dot(cx-ax, cy-ay, cz-az, cx-ax, cy-ay, cz-az);
  const bb = dot(bx-ax, by-ay, bz-az, bx-ax, by-ay, bz-az);
  const ab = dot(cx-ax, cy-ay, cz-az, bx-ax, by-ay, bz-az);
  const ap = dot(cx-ax, cy-ay, cz-az, px, py, pz), bp = dot(bx-ax, by-ay, bz-az, px, py, pz);
  const det = (aa*bb >> 8) - (ab*ab >> 8);
  if (!det) return Infinity;
  let u = Math.trunc((ab*bp-bb*ap)/det), v = Math.trunc((ab*ap-aa*bp)/det);
  const bound = (num: number, den: number) => clamp(Math.trunc(num*256/den), 0, 255);
  if (u+v < 256) {
    if (u < 0 && (v >= 0 || ap >= 0)) { u = 0; v = bound(-bp, bb); }
    else if (v < 0) { v = 0; u = bound(-ap, aa); }
  } else if (u < 0 && ab-bb+ap-bp >= 0) {
    u = 0; v = bound(-bp, bb);
  } else if (v < 0 && aa-ab+ap-bp < 1) {
    v = 0; u = bound(-ap, aa);
  } else if (v < 0) {
    v = bound(aa-ab+ap-bp, aa-2*ab+bb); u = 255-v;
  } else {
    u = bound(bb-ab-ap+bp, aa-2*ab+bb); v = 255-u;
  }
  return Math.abs(u*((aa*u >> 8)+(ab*v >> 8)+2*ap) + v*((ab*u >> 8)+(bb*v >> 8)+2*bp) + dot(px,py,pz,px,py,pz)*256);
}

/** FUN_800b6dbc: test the active collision meshes in strip order. Only Dot's outer rail deflects velocity. */
function wallResolve(d: Data, s: number, y = -dashRideHeight(d.variant)): number {
  let deflect = -1;
  for (const [index, mesh] of TRACK_WALLS[d.variant].entries()) {
    for (const face of mesh) {
      const x = d.gx[s], z = d.gz[s];
      if (x+220 < Math.min(face[0],face[3],face[6]) || x-220 > Math.max(face[0],face[3],face[6]) ||
          z+220 < Math.min(face[2],face[5],face[8]) || z-220 > Math.max(face[2],face[5],face[8])) continue;
      const distance = wallDistanceSq(face, x, y, z);
      if (distance >= 0xbd11) continue;
      const push = 0x3702 - ps1SqrtQ6(distance);
      d.gx[s] += push*face[9] >> 18;
      d.gz[s] += push*face[10] >> 18;
      if (d.variant === 'dot' && index === 1) deflect = atan2g(face[9], face[10]) & 4095;
    }
  }
  return deflect;
}

/** FUN_800b7190 group 1. Query only the exposed side, within 200 units of the course edge. */
function atFallEdge(variant: string, x: number, z: number) {
  const edges = FALL_EDGE[variant];
  if (!edges) return x*x + z*z > (variant === 'toxic' ? 0x900000 : 0xa90000);
  return edges.some(([ax, az, bx, bz, length, yaw]) => {
    if (((x-ax)*Ti(-yaw) >> 12) - ((z-az)*Ti(-yaw-1024) >> 12) < 0) return false;
    const div = length*length >> 12;
    const t = div ? clamp(Math.trunc(((bx-ax)*(x-ax)+(bz-az)*(z-az))/div), 0, 4096) : 0;
    const dx = ax + (t*(bx-ax) >> 12) - x, dz = az + (t*(bz-az) >> 12) - z;
    return dx*dx+dz*dz <= 40000;
  });
}

/** FUN_800b7190 with the missile's inward-facing normals and 150-unit probe. */
function reflectMissile(m: Missile, group: number[][]) {
  let best = 150 * 150, normal: number | undefined;
  for (const [ax, az, bx, bz, length, yaw] of group) {
    const a = yaw + 0x800;
    const nx = Ti(-a), nz = Ti(-a + 0x400);
    if (((m.x - ax) * nx >> 12) - ((m.z - az) * Ti(-a - 0x400) >> 12) < 0) continue;
    const t = clamp(Math.trunc(((bx - ax) * (m.x - ax) + (bz - az) * (m.z - az)) / (length * length >> 12)), 0, 4096);
    const dx = ax + (t * (bx - ax) >> 12) - m.x, dz = az + (t * (bz - az) >> 12) - m.z;
    const dist = dx * dx + dz * dz;
    if (dist > best) continue;
    best = dist;
    const push = 152 - (ps1SqrtQ6(dist) >> 6);
    m.x += push * nx >> 12;
    m.z += push * nz >> 12;
    normal = a;
  }
  if (normal === undefined) return false;
  const nx = Ti(normal), nz = Ti(normal - 0x400);
  const vx = -Ti(m.yaw - 0x400), vz = -Ti(m.yaw);
  const dot = (vx * nx >> 12) + (vz * nz >> 12);
  m.yaw = (atan2g(vx - (dot * nx >> 11), vz - (dot * nz >> 11)) + 0x800) & 0xfff;
  return true;
}

const SPOKE_Y = -151;
function spokeOrigin(i: number): [number, number] {
  return i === 5 ? [106, 9] : [0, 0];
}

/** FUN_800b82fc. Returns the contacted faces and push in game coordinates. */
function spokeContact(d: Data, i: number, x: number, y: number, z: number) {
  const [ox, oz] = spokeOrigin(i);
  const angle = (i * 0x2aa + d.rot) & 4095;
  const sin = Ti(angle - 0x400), cos = Ti(angle);
  const lx = ((x - ox) * cos - (z - oz) * sin) >> 12;
  const lz = ((x - ox) * sin + (z - oz) * cos) >> 12;
  const tip = -SPOKE_REACH[d.sp[i].ext];
  const nx = lx < -176 ? -1 : lx > 176 ? 1 : 0;
  const nz = lz < tip ? -1 : lz > -778 ? 1 : 0;
  const above = y < SPOKE_Y - 357;
  const faces = (nx < 0 ? 2 : nx) | (nz < 0 ? 4 : nz * 8) | (above ? 16 : 0);
  if (!nx && !nz && !above) return null;
  // The game's top test on its own or on a Z face ignores horizontal distance.
  if (above) {
    if ((!nz && nx !== 0) || SPOKE_Y - 357 - y >= 256) return null;
    return { faces, dx: 0, dy: SPOKE_Y - 357 - y - 256, dz: 0 };
  }
  const dx = lx - clamp(lx, -176, 176), dz = lz - clamp(lz, tip, -778);
  const distance = nx && nz ? ps1SqrtQ6(dx * dx + dz * dz) >> 6 : Math.abs(dx) + Math.abs(dz);
  const penetration = 256 - distance;
  if (penetration <= 0) return null;
  return { faces, dx: (penetration * (nx * cos + nz * sin)) >> 12, dy: 0, dz: (penetration * (nz * cos - nx * sin)) >> 12 };
}

function spokePush(d: Data, s: number, x: number, z: number) {
  let kick: [number, number] | null = null;
  let dy = 0;
  for (let i = 0; i < d.sp.length; i++) {
    const hit = spokeContact(d, i, x, -256 - d.gy[s], z);
    if (!hit) continue;
    dy += hit.dy;
    d.gx[s] += hit.dx; d.gz[s] += hit.dz;
    if (hit.faces === 4 && d.sp[i].state === 1) {
      const angle = atan2g(x - d.gx[s], z - d.gz[s]);
      kick = [-6 * Ti(angle - 0x400), -6 * Ti(angle)];
    }
  }
  return { kick, dy };
}

function exhaustPuff(d: Data, s: number, kind: DashExhaust['kind'], offset = 200) {
  if (d.dantePool) {
    const slot = spawnDanteActor(d.dantePool, 'exhaust', d.f + (kind === 'run' ? 18 : 17));
    if (!slot || d.dantePool.actors[slot]!.expires < 0) return;
  }
  (d.exhaust ??= []).push({
    kind, born: d.f,
    x: d.gx[s] + (Ti(d.yaw[s] - 1024) * offset >> 12),
    y: dashRideHeight(d.variant) + d.gy[s],
    z: d.gz[s] + (Ti(d.yaw[s]) * offset >> 12),
  });
}

function advanceCourseFrame(d: Data) {
  d.f++;
  if (d.exhaust?.length) d.exhaust = d.exhaust.filter(p => d.f - p.born <= (p.kind === 'run' ? 17 : 16));
}

/** FUN_800ba278 and FUN_800bafc8 share the puff timers. Water karts have no continuous motor tones. */
function updateMotor(d: Data, s: number, pad: Pad, tick: number) {
  const motor = (d.motors ??= Array.from({ length: 4 }, newMotor))[s];
  const sea = d.variant === 'splash';
  if (d.state[s] === S_FALL) {
    if (d.fl[s] > 0) {
      if (!pad.boost) motor.run = -1;
      else {
        if (!sea && motor.run < 0) motor.run = tick;
        if (motor.puff-- === 0) {
          motor.puff = 4;
          exhaustPuff(d, s, 'run', 256);
        }
      }
    }
    return;
  }
  if (d.state[s] !== S_DRIVE) return;
  if (pad.boost && d.fuel[s] > 0) {
    if (!sea && motor.boost < 0) motor.boost = tick;
    if (motor.puff-- === 0) {
      motor.puff = 4;
      exhaustPuff(d, s, sea ? 'spray' : 'boost');
      return;
    }
  } else motor.boost = -1;
  if (!pad.run) motor.run = -1;
  else {
    if (!sea && motor.run < 0) motor.run = tick;
    motor.runPuff ??= 0;
    if (motor.runPuff-- === 0) {
      motor.runPuff = 6;
      exhaustPuff(d, s, sea ? 'spray' : 'run');
    }
  }
}

/**
 * One frame of FUN_800b8fd8 (input -> targets, fuel) + FUN_800b980c (velocity ramp, move, wall deflection, fall check).
 */
function moveKart(w: World, d: Data, s: number, rawPad: Pad, ph: Phys, ai: boolean, racers: Body[]) {
  const v = d.variant;
  const st = d.state[s];
  const bank = d.bank ??= [0, 0, 0, 0];
  let targetBank = 0;
  const lock = d.hitLock ??= [0, 0, 0, 0];
  const ctl = lock[s] === 0;
  const pad = ctl || st === S_FALL ? rawPad : NOPAD;
  if (lock[s] > 0) lock[s]--;
  let tx = 0, tz = 0, ax = 0, az = 0;
  let boosting = false;
  if (ctl) {
    if (pad.l || pad.r) {
      const v2 = (Math.imul(d.vx[s], d.vx[s]) + Math.imul(d.vz[s], d.vz[s])) | 0;
      const speed = (ps1SqrtQ6(v2) << 2) >> 8;
      const tilt = Math.min(0x3c8, Math.trunc(speed * 0x3c8 / 100) >> 8);
      targetBank = pad.r ? -tilt : tilt;
    }
    if (pad.l) d.tgt[s] -= ph.turn;
    if (pad.r) d.tgt[s] += ph.turn;
    d.tgt[s] &= 0xfff;
    if (pad.boost && d.fuel[s] > 0) {
      ax = az = ph.bacc;
      tx = (ph.boost * Ti(d.yaw[s] + 0x400)) >> 12;
      tz = (ph.boost * Ti(d.yaw[s] + 0x800)) >> 12;
      if (st !== S_FALL) d.fuel[s] -= 0x180; // AI skill >= 0x17 would get a refund; the hardest level (skill 22 / 20) never does
      boosting = true;
      if (d.fuel[s] < 0) { d.fuel[s] = 0; boosting = false; }
    }
    if (!boosting && pad.run) {
      ax = az = ph.acc;
      if (ai) {
        const sk = d.skill ?? SKILL[v][1];
        ax = az = sk < 0x16 ? Math.max(0x200, 768 + (sk - 16) * 64) : 768 + AI_ACC[sk - 0x16];
      }
      tx = (ph.run * Ti(d.yaw[s] + 0x400)) >> 12;
      tz = (ph.run * Ti(d.yaw[s] + 0x800)) >> 12;
    }
  }
  kartContacts(w, d, s, racers);
  if (ctl) {
    d.yaw[s] = (d.yaw[s] + (sdiff(d.yaw[s], d.tgt[s]) >> 2)) & 0xfff;
    bank[s] += sdiff(bank[s], targetBank) >> (ai ? 3 : 2);
  }
  const falling = d.state[s] === S_FALL;
  if (!falling) updateMotor(d, s, rawPad, w.tick + 1);
  if (d.state[s] === S_DRIVE && pad.use && d.item[s]) useItem(w, d, s);
  const pose = d.kartPose?.[s];
  let boostStart = false;
  if (pose) {
    if (d.state[s] === S_DRIVE) {
      if (!rawPad.boost) pose.boostHeld = false;
      else if (d.fuel[s] > 0 && !pose.boostHeld) {
        pose.boostHeld = true;
        boostStart = true;
        pose.script = v === 'splash' ? 0x53 : 0x49;
        pose.frame = 0;
      }
    }
    // The hop handler advances the current script. The sea hit handler holds its pose.
    if (v !== 'splash' || d.state[s] !== S_HIT) pose.frame++;
  }
  stepAirborneKart(w, d, s, d.state[s]);
  if (falling && d.state[s] === S_FALL) updateMotor(d, s, rawPad, w.tick + 1);
  // Re-entering the drive state clears both speed targets before the movement pass.
  if (st === S_HOP && d.state[s] === S_DRIVE) tx = tz = 0;
  const previousX = d.gx[s], previousZ = d.gz[s];
  wallResolve(d, s);
  if (d.state[s] === S_FALL) {
    d.vx[s] = d.vz[s] = 0; d.turbo[s] = false;
    return;
  }
  boosting &&= d.state[s] !== S_HIT;
  if (pose ? boostStart : boosting && !d.turbo[s]) {
    (d.boostAt ??= [-1000, -1000, -1000, -1000])[s] = w.tick + 1;
    emit(w, 'turbo', d.gx[s] * G, -d.gz[s] * G, s, 1);
  }
  d.turbo[s] = boosting;
  // velocity ramp toward the target (<< 8), accel when a target exists else decel
  const ramp = (cur: number, tgt: number, acc: number) => {
    if (cur === tgt) return cur;
    const step = tgt !== 0 ? acc : ph.dec;
    if (cur < tgt) { cur += step; if (cur > tgt) cur = tgt; } else { cur -= step; if (cur < tgt) cur = tgt; }
    return cur;
  };
  let vx = ramp(d.vx[s], tx << 8, ax), vz = ramp(d.vz[s], tz << 8, az);
  let wallY = -dashRideHeight(v);
  if (v === 'splash') {
    const { kick, dy } = spokePush(d, s, previousX, previousZ);
    wallY += dy;
    if (kick) [vx, vz] = kick;
  }
  vx = clamp(vx, -0xc800, 0xc800); vz = clamp(vz, -0xc800, 0xc800);
  d.vx[s] = vx; d.vz[s] = vz;
  d.gx[s] += vx >> 8; d.gz[s] += vz >> 8;
  const n = wallResolve(d, s, wallY); // second call: the wall deflects the kart (78% of its speed, 72 degrees off the normal) and turns it
  if (n >= 0) {
    const h = atan2g(vx >> 8, vz >> 8);
    const dd = (h - n) & 0xfff;
    const u = dd < 0x801 ? n + 0x338 : n - 0x338;
    const mag = (ps1SqrtQ6(Math.imul(vx, vx) + Math.imul(vz, vz)) >> 6) * 200 >> 8;
    d.vx[s] = (mag * Ti(u - 0x400)) >> 12; d.vz[s] = (mag * Ti(u)) >> 12;
    d.tgt[s] = (u + 0x800) & 0xfff;
    const take = discRandomInt(w, 4);
    if ((d.vx[s] !== 0 || d.vz[s] !== 0) && dd > 0x600 && dd < 0xa00) emit(w, 'raceSound', d.gx[s] * G, -d.gz[s] * G, s, 0x64c + take);
  }
  if (d.state[s] !== S_FALL && atFallEdge(v, d.gx[s], d.gz[s])) enterFall(w, d, s);
}

/** FUN_800bad54 */
function enterFall(w: World, d: Data, s: number) {
  if (d.pitch) d.pitch[s] = 0;
  if (d.motors) d.motors[s].run = d.motors[s].boost = -1;
  setState(d, s, S_FALL);
  d.fc[s] = 0; d.fph[s] = 0; d.fl[s] = 0; d.dvy[s] = 0;
  d.p54[s] = atan2g(d.gx[s], d.gz[s]) & 4095;
  d.item[s] = 0; d.turbo[s] = false;
  emit(w, 'fall', d.gx[s] * G, -d.gz[s] * G, s, 1);
}

/** FUN_800bafc8: falling clip, then respawn 512 toward the hub dropped from above (gravity 768, bounce 100/256), second landing ends it */
function fallStep(w: World, d: Data, s: number) {
  d.fc[s]++;
  if (d.fph[s] === 0) {
    d.vx[s] = d.vz[s] = 0;
    if (d.fc[s] >= (d.variant === 'splash' ? FALL_CLIP_SPLASH : FALL_CLIP)) {
      d.fph[s] = 1;
      if (d.bank) d.bank[s] = 0;
      d.gx[s] -= Ti(d.p54[s] - 0x400) >> 3; d.gz[s] -= Ti(d.p54[s]) >> 3;
      d.gy[s] = 1400 - dashRideHeight(d.variant); d.dvy[s] = 0;
      const burst = spawnRaceEffect(d, 12);
      if (burst) (d.respawnAt ??= [-1000, -1000, -1000, -1000])[s] = d.f;
      const pose = d.kartPose?.[s];
      if (pose) { pose.script = d.variant === 'splash' ? 0x52 : 0x48; pose.frame = 0; }
      emit(w, 'fall', d.gx[s] * G, -d.gz[s] * G, s, burst ? 2 : 3);
    }
  } else {
    (d.hitLock ??= [0, 0, 0, 0])[s] = 1; // The drop handler also locks the first drive tick after landing.
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
  // Hit handlers refresh the input lock. It survives the transition to falling or driving.
  (d.hitLock ??= [0, 0, 0, 0])[s] = 1;
  const pitch = d.pitch ??= [0, 0, 0, 0];
  if (d.vy[s] > 0 && d.gy[s] < 0) {
    d.gy[s] = 0;
    d.yaw[s] = (d.yaw[s] + 0x100) & 0xfff;
    pitch[s] -= pitch[s] >> 1;
  } else pitch[s] += 0x80;
  if (d.cnt[s]-- < 0) { setState(d, s, S_DRIVE); d.gy[s] = 0; }
}

function lapCheck(w: World, d: Data, s: number, pz: number) {
  const x = d.gx[s], z = d.gz[s];
  if (x > 0 && pz >= LINE_Z && z < LINE_Z) d.c30[s] = Math.min(1, d.c30[s] + 1);
  else if (x > 0 && pz < LINE_Z && z >= LINE_Z) d.c30[s] = Math.max(-1, d.c30[s] - 1);
  if (d.c30[s] === 1) {
    d.c30[s] = 0;
    if (d.c148[s] === 0) d.c148[s] = 1;
    else if (d.finish[s] < 0) {
      d.lap[s]++;
      emit(w, 'lap', x * G, -z * G, s, Math.max(0, DR_LAPS - d.lap[s]) / DR_LAPS);
      if (d.lap[s] >= DR_LAPS) {
        d.finish[s] = w.time;
        d.first = w.time;
        d.winner = s;
        emit(w, 'finish', x * G, -z * G, s, 1);
      }
    }
  }
}

/** FUN_800bc984: item 1 -> FUN_800c5154 missile 0x1701 (init FUN_800bf2b8, sound 0x522); item 0x20 -> shield 0x1708. */
function useItem(w: World, d: Data, s: number) {
  if (d.item[s] === 1) {
    const x = Math.trunc(d.gx[s]), z = Math.trunc(d.gz[s]);
    if (d.dantePool) {
      const slot = spawnDanteActor(d.dantePool, 'missile', -1, w.nextId);
      if (!slot || d.dantePool.actors[slot]!.body === undefined) {
        d.item[s] = 0;
        return;
      }
    }
    const b = addBody(w, 'missile', s, x * G, -z * G, 384 * G, 1);
    b.y = (dashRideHeight(d.variant) + d.gy[s] + 128) * G;
    b.face = -d.yaw[s] * DR_ANGLE;
    // The first update copies the kart origin into its flight position (FUN_800bf460).
    d.mis.push({ id: b.id, owner: s, x, y: -dashRideHeight(d.variant) - d.gy[s], z, yaw: d.yaw[s], bounces: 0, age: 0 });
    emit(w, 'missile', x * G, -z * G, s, 1);
    d.item[s] = 0;
  } else if (d.item[s] === 2) {
    d.shield[s] = 17; // Creation, ring start, then 15 pushes.
    (d.shieldOrigin ??= [null, null, null, null])[s] = [d.gx[s], d.gz[s], dashRideHeight(d.variant) + d.gy[s] - 96];
    d.item[s] = 0;
  }
}

/** FUN_800b5d14 / FUN_800b5a70: rotating spokes that extend from the hub in patterns */
function stepSplash(w: World, d: Data, ended = false) {
  d.rot = (d.rot + dashSpokeTurn(d.pat)) & 0xfff;
  if (d.wait >= 0) d.wait--;
  else {
    if (ended) d.pat = 5;
    // FUN_800b5a70
    d.pt = ended ? 0 : d.pt + 1;
    if (d.pt > (d.pat === 5 ? 1800 : PAT_LEN)) {
      d.pt = 0;
      d.smax = 17 + discRandomInt(w, 12);
      for (const q of d.sp) { q.started = false; q.cnt = 0; }
      d.pat = discRandomInt(w, 5);
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
  syncSpokes(w, d);
}

function syncSpokes(w: World, d: Data) {
  const rods = w.bodies.filter((b) => b.kind === 'rod');
  rods.forEach((rd, i) => {
    const q = d.sp[i];
    rd.y = q.ext / 28; rd.vy = q.ext * 16;
    const a = (i * 0x2aa + d.rot) & 0xfff;
    rd.face = (a * TAU) / 4096 - Math.PI / 2; rd.cd = a;
  });
}

/** FUN_800b6108 (and its fragment FUN_800b627c) resolves all karts touching the same barrel, in seat order. */
function stepToxicBarrels(w: World, d: Data) {
  for (const [index, barrel] of d.bar.entries()) {
    if (barrel.t > 0) continue;
    let struck = false, barrelVx = 0, barrelVz = 0;
    for (let s = 0; s < 4; s++) {
      const dx = Math.trunc(d.gx[s]) - barrel.x, dz = Math.trunc(d.gz[s]) - barrel.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= 0x24000) continue;
      const yaw = atan2g(dx, dz), push = 384 - (ps1SqrtQ6(distanceSq) >> 6);
      d.gx[s] = Math.trunc(d.gx[s]) + (push * Ti(yaw - 1024) >> 12);
      d.gz[s] = Math.trunc(d.gz[s]) + (push * Ti(yaw) >> 12);

      // FUN_800be7b4, kart mass 256 and barrel mass 128. The next contact in
      // this pass reads the barrel velocity written by the previous kart.
      const vx = d.vx[s] >> 8, vz = d.vz[s] >> 8;
      const oldBarrelVz = barrelVz >> 8;
      d.vx[s] = Math.trunc((vx + 2 * (barrelVx >> 8)) * 256 / 3);
      d.vz[s] = Math.trunc((vz + 2 * oldBarrelVz) * 256 / 3);
      barrelVx = d.vx[s];
      barrelVz = d.vz[s] + (vz - oldBarrelVz) * 256;
      if (d.state[s] !== S_FALL) {
        emit(w, 'raceSound', barrel.x * G, -barrel.z * G, s, 0x663 + discRandomInt(w, 2));
        hit(w, d, s, -1);
      }
      struck = true;
    }
    if (struck) {
      // State 0 stores this timer. Only state 2 decrements it.
      barrel.t = 180 + discRandomInt(w, 60);
      emit(w, 'barrel', barrel.x * G, -barrel.z * G, index, 1);
    }
  }
}

/** FUN_800c2e10 (Toxic monster) + FUN_800c3738/3934 (the three blobs it spits out) */
function stepToxic(w: World, d: Data, ended = false) {
  const activeBlobs = d.blobs.length;
  d.monT++;
  if (d.monS === 3) {
    d.mon = 0;
    const t = d.monTim--;
    if (t < 0 && !ended) { d.monTim = 0x1c2 + discRandomInt(w, 0x96); d.monS = 0; d.monT = 0; emit(w, 'monster', 0, 0, -1, 1); }
  } else if (d.monS === 0) {
    d.mon = clamp(d.monT / 60, 0, 1);
    if (d.monT === 60) emit(w, 'raceSound', 0, 0, -1, 0x666);
    if (d.monT >= MON_RISE) { emit(w, 'raceSound', 0, 0, -1, 0x667); d.monS = 1; d.monT = 0; }
  } else if (d.monS === 1) {
    d.mon = 1;
    if (d.monT === 22) {
      emit(w, 'raceSound', 0, 0, -1, 0x668);
      d.spitAt = d.f;
      for (let k = 0; k < 3; k++) {
        const kk = d.blobK; d.blobK = (d.blobK + 1) % 3;
        const a = -0x200 * kk;
        const tx = (Ti(a + 0x600) * 7) >> 4, tz = (Ti(a + 0xa00) * 7) >> 4;
        const b = addBody(w, 'rock', -1, BLOB_START[0] * G, -BLOB_START[2] * G, 200 * G, 1);
        b.y = -BLOB_START[1] * G;
        d.blobs.push({ id: b.id, x: BLOB_START[0], y: BLOB_START[1], z: BLOB_START[2], vx: tx, vy: 0, vz: tz, init: false, st: 0, tm: 0x5a, yaw: 0, frame: 0 });
      }
    }
    if (d.monT >= MON_ATK) { emit(w, 'raceSound', 0, 0, -1, 0x669); d.monS = 2; d.monT = 0; }
  } else {
    d.mon = clamp(1 - d.monT / MON_SINK, 0, 1);
    if (d.monT >= MON_SINK) { d.monS = 3; d.monT = 0; d.mon = 0; emit(w, 'monster', 0, 0, -1, 0); }
  }
  // Level script 10 emits four particles per update until its 12 slots are full.
  const spitAge = d.f - (d.spitAt ?? d.f);
  if (spitAge >= 1 && spitAge <= 3) {
    for (let draw = 0; draw < 16; draw++) discRandomInt(w, 4096);
  }
  // blobs: object 0x170d, init FUN_800c3738, update FUN_800c3934
  const gone = new Set<number>();
  for (let i = 0; i < activeBlobs; i++) {
    const b = d.blobs[i];
    if (ended) { gone.add(b.id); continue; }
    const nearKart = () => {
      for (let s = 0; s < 4; s++) {
        if ((b.x - d.gx[s]) ** 2 + (b.z - d.gz[s]) ** 2 < 0x10000) { hit(w, d, s, -1, true); return true; }
      }
      return false;
    };
    if (b.st === 0) {
      if (!b.init) { // FUN_8008c5c4: ballistic arc to the landing target (b.vx/b.vz hold the target here)
        const dx = b.vx - BLOB_START[0], dz = b.vz - BLOB_START[2];
        const F = ps1SqrtQ6(dx * dx + dz * dz) >> 12;
        b.vy = Math.trunc((0 - BLOB_START[1]) / F) - (F >> 1) * 16;
        const a = atan2g(dx, dz);
        b.vx = (64 * Ti(a - 0x400)) >> 12; b.vz = (64 * Ti(a)) >> 12;
        b.init = true;
      }
      b.y += b.vy; b.vy += 16; b.x += b.vx; b.z += b.vz;
      if (b.y >= 0 && b.vy > 0) { b.y = 0; b.st = 1; }
    } else if (b.st === 1) {
      b.frame++;
      if (nearKart()) { gone.add(b.id); continue; }
      if (b.tm-- < 0) {
        b.st = 2;
        // The next update overwrites this random heading with a tangential one.
        discRandomInt(w, 4096);
      }
    } else if (b.st === 2) {
      b.frame++;
      const a = (atan2g(b.x, b.z) + 0x400) & 0xfff;
      b.x -= Ti(a - 0x400) >> 7; b.z -= Ti(a) >> 7;
      if (nearKart()) { gone.add(b.id); continue; }
      b.yaw -= sext(b.yaw - a) >> 2;
      if (a < 0x400) b.st = 3;
    } else {
      b.frame++;
      b.z -= Ti(0x800) >> 7; // z += 32
      b.yaw -= sext(b.yaw - 0x800) >> 2;
      if (b.x * b.x + b.z * b.z > 0x790000) { gone.add(b.id); continue; }
    }
    const bd = w.bodies.find((o) => o.id === b.id);
    if (bd) { bd.x = b.x * G; bd.z = -b.z * G; bd.y = -b.y * G; bd.face = -b.yaw * DR_ANGLE; bd.cd = b.frame; }
  }
  if (gone.size) { d.blobs = d.blobs.filter((b) => !gone.has(b.id)); w.bodies = w.bodies.filter((b) => !gone.has(b.id)); }
}

function spawnRaceEffect(d: Data, lifetime: number) {
  return d.dantePool ? spawnDanteActor(d.dantePool, 'effect', lifetime < 0 ? -1 : d.f + lifetime) : -1;
}

function endRock(w: World, d: Data, rock: Rock) {
  if (d.dantePool && spawnRaceEffect(d, 23)) emit(w, 'rockBurst', rock.x * G, -rock.z * G, -1, -rock.y * G);
  if (rock.fireActor && d.dantePool) {
    freeDanteActor(d.dantePool, rock.fireActor);
    rock.fireActor = 0;
  }
}

/** FUN_800c2388 launches three rocks from the crater. */
function stepDante(w: World, d: Data, ended = false) {
  if (ended) {
    // The result hides the three meshes. Their ground-fire actors stay alive
    // at the last position until the arena closes.
    d.rocksHidden = true;
    return;
  }
  // Each native mesh retains its rotation and smoke timer across eruptions.
  const meshes = d.rockMeshes ??= Array.from({ length: 3 }, (_, i) => ({ roll: d.rocks[i]?.roll ?? 0, trail: 0 }));
  if (d.vs === 0) {
    // timer counts 450 -> -1 (rumble sfx at 60), then the launch frame
    d.vt--;
    if (d.vt === 60) emit(w, 'raceSound', 0, 0, -1, 0x69a);
    if (d.vt < 0) d.vs = 1;
  } else if (d.vs === 1) {
    let u = discRandomInt(w, 0x1000);
    for (let i = 0; i < 3; i++) {
      const spd = 0xc - discRandomInt(w, 3);
      const b = addBody(w, 'rock', -1, 0, 0, 400 * G, 1);
      b.face = -(u & 0xfff) * DR_ANGLE;
      b.cd = meshes[i].roll;
      d.rocks.push({ id: b.id, slot: i, fireActor: spawnRaceEffect(d, -1), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: (Ti(u - 0x400) * 0x4b) >> 9, tz: (Ti(u) * 0x4b) >> 9, spd, init: false, yaw: u & 0xfff });
      u += 0x555 + discRandomInt(w, 0x200);
    }
    if (d.dantePool && spawnRaceEffect(d, 25)) emit(w, 'craterBlast', 0, 0);
    emit(w, 'monster', 0, 0, -1, 1);
    d.vt = 0x14; d.vs = 2;
  } else {
    const dead = new Set<number>();
    for (const [index, k] of d.rocks.entries()) {
      const mesh = meshes[k.slot ??= index];
      const r2 = k.x * k.x + k.z * k.z;
      mesh.roll = (mesh.roll - 0x80) & 0xfff;
      if (!k.init) { // FUN_8008c5c4 starts the rock with gravity 4.
        const frames = Math.trunc((ps1SqrtQ6(k.tx * k.tx + k.tz * k.tz) >> 6) / k.spd);
        k.vy = -(frames >> 1) * 4;
        const a = atan2g(k.tx, k.tz);
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
      if (r2 > 0x900000) {
        emit(w, 'raceSound', k.x * G, -k.z * G, -1, 0x69c + discRandomInt(w, 4));
        endRock(w, d, k);
        dead.add(k.id);
      } else if (mesh.trail-- < 0) {
        mesh.trail = 8 + discRandomInt(w, 3);
        if (spawnRaceEffect(d, 30)) emit(w, 'rockTrail', k.x * G, -k.z * G, -1, 1, -1, undefined, -k.y * G);
      }
    }
    // The volcano counts a rock that hits a kart as gone on the following update.
    const allRocksGone = dead.size === d.rocks.length;
    for (const k of d.rocks) {
      if (dead.has(k.id)) continue;
      for (let s = 0; s < 4; s++) {
        const dy = -dashRideHeight(d.variant) - d.gy[s] - k.y;
        if ((k.x - d.gx[s]) ** 2 + (k.z - d.gz[s]) ** 2 + dy * dy < 160000) {
          hit(w, d, s, -1, true);
          endRock(w, d, k);
          dead.add(k.id);
          k.y = 0;
        }
      }
    }
    for (const [index, k] of d.rocks.entries()) {
      const b = w.bodies.find((o) => o.id === k.id);
      if (b) { b.x = k.x * G; b.z = -k.z * G; b.y = -k.y * G; b.face = -k.yaw * DR_ANGLE; b.cd = meshes[k.slot ?? index].roll; }
    }
    if (dead.size) { d.rocks = d.rocks.filter((k) => !dead.has(k.id)); w.bodies = w.bodies.filter((b) => !dead.has(b.id)); }
    if (allRocksGone && d.vt-- < 0) { d.vt = 300; d.vs = 0; }
  }
}

function stepPickup(w: World, d: Data, o: Body) {
  const v = d.variant;
  movePickup(o, v === 'splash');
  const ox = Math.round(o.x / G), oz = Math.round(-o.z / G);
  for (let s = 0; s < 4; s++) {
    if ((ox - d.gx[s]) ** 2 + (oz - d.gz[s]) ** 2 >= 0x24000 ||
        Math.abs(Math.round(o.y / G) - d.gy[s] - dashRideHeight(v)) >= 0x200) continue;
    if (!d.shield[s]) {
      if (o.kind === 'fruit') {
        d.fuel[s] = Math.min(FUEL_MAX, d.fuel[s] + 0x2000);
        emit(w, 'pickup', o.x, o.z, s, 2);
      } else {
        d.item[s] = o.dash === 5 ? 2 : 1;
        emit(w, 'pickup', o.x, o.z, s, 1);
      }
      d.occ[o.vy] = false;
    }
    o.alive = false;
    break;
  }
}

function step(w: World, inputs: (InputState | null | undefined)[], _dt: number) {
  const d = w.data as Data;
  if (w.finished || d.winner !== undefined || d.first >= 0) return;
  const v = d.variant;
  const ph = phys(v);
  const ps = players(w);
  // The older format stamped the frame on which a CPU supplied its last input.
  d.cpuSeats ??= d.f ? (d.bf ?? []).reduce((mask, tick, s) => tick === d.f ? mask | (1 << s) : mask, 0) : 0;
  advanceCourseFrame(d);
  discRandomInt(w, 2);
  spawnPickups(w, d);
  // hazards
  if (v === 'splash') stepSplash(w, d);
  else if (v === 'toxic') stepToxicBarrels(w, d);
  for (const s of nextPlayerOrder(w.rng, d)) {
    if (!ps.some((p) => p.slot === s)) continue;
    const input = inputs[s];
    const bit = 1 << s;
    const cpu: boolean = input ? CPU_CONTROL in input : !!(d.cpuSeats & bit);
    d.cpuSeats = cpu ? d.cpuSeats | bit : d.cpuSeats & ~bit;
    // FUN_80083e8c calls the Dash CPU immediately before moving this seat.
    const raw = cpu ? dashCpuInput(w, s) : input ?? IDLE;
    const st = d.state[s];
    const pz = d.gz[s];
    d.st[s]++;
    const rawPad = padOf(raw);
    const pad = st !== S_FALL && d.hitLock?.[s] ? NOPAD : rawPad;
    moveKart(w, d, s, rawPad, ph, cpu, ps);
    // FUN_800bcc20 -> FUN_800bc2d0. Humans need a fresh Cross press to hop. A CPU sends the hop bit while a spoke is in range.
    if (v === 'splash' && pad.use && (cpu || !d.prevB[s]) && st === S_DRIVE && d.state[s] === S_DRIVE) {
      setState(d, s, S_HOP);
      d.hopBounce[s] = false;
      d.vy[s] = -0x44;
      emit(w, 'hop', d.gx[s] * G, -d.gz[s] * G, s, 1);
    }
    d.prevB[s] = raw.b;
    if (d.state[s] !== S_FALL) lapCheck(w, d, s, pz);
    if (d.first >= 0) break; // FUN_800c0218 dispatches the result before the next kart moves.
  }

  if (!d.dantePool) for (const o of w.bodies) {
    if (o.alive && (o.kind === 'fruit' || o.kind === 'item')) stepPickup(w, d, o);
  }

  if (d.first >= 0) {
    // The missile is an object callback and still gets this update.
    if (d.dantePool) stepDanteObjects(w, d);
    else missiles(w, d);
    w.bodies = w.bodies.filter((b) => b.alive);
    syncKarts(ps, d);
    return;
  }

  if (v === 'toxic') stepToxic(w, d);
  else if (v === 'dante') stepDante(w, d);
  stepShields(w, d);
  if (d.dantePool) stepDanteObjects(w, d);
  else missiles(w, d);
  stepRespawnEffects(w, d);
  w.bodies = w.bodies.filter((b) => b.alive);
  syncKarts(ps, d);
  const timeLimit = d.openingTicks === undefined ? RACE_SECONDS : VERSUS_CLOCK_END / 30;
  if (w.time + _dt >= timeLimit - 1e-8) {
    const [a, b] = placements(w);
    d.winner = d.lap[a] === d.lap[b] ? -1 : a;
  }
}

// The two respawn emitters have pools of 12 and release 3 and 4 particles per tick.
function stepRespawnEffects(w: World, d: Data) {
  for (const start of d.respawnAt ?? []) {
    const age = d.f - start;
    if (age < 1 || age > 4) continue;
    const particles = age === 4 ? 3 : 7;
    for (let i = 0; i < particles * 4; i++) discRandomInt(w, 4096);
  }
}

/** Shield object 0x1708 (init FUN_800c4db8, update FUN_800c1cfc). */
function stepShields(w: World, d: Data) {
  for (let s = 0; s < 4; s++) {
    if (d.shield[s] <= 0) continue;
    d.shield[s]--;
    if (d.shield[s] === 16) continue;
    const origin = d.shieldOrigin?.[s];
    if (d.shield[s] === 15) {
      emit(w, 'shield', (origin?.[0] ?? d.gx[s]) * G, -(origin?.[1] ?? d.gz[s]) * G, s, 1, -1, undefined, (origin?.[2] ?? 160) * G);
      continue;
    }
    for (let o = 0; o < 4; o++) {
      if (o === s) continue;
      const dx = d.gx[o] - d.gx[s], dz = d.gz[o] - d.gz[s];
      if (dx * dx + dz * dz < 810000) {
        const yaw = atan2g((origin?.[0] ?? d.gx[s]) - d.gx[o], (origin?.[1] ?? d.gz[s]) - d.gz[o]);
        d.vx[o] = -8 * Ti(yaw - 1024);
        d.vz[o] = -8 * Ti(yaw);
        break;
      }
    }
  }
}

/** FUN_800c04ec: fruit spawner and the held-item markers. */
function stepFruitAndHeldItems(w: World, d: Data) {
  const cap = d.f <= 900 ? 3 : d.f <= 1800 ? 2 : 1;
  const fruits = w.bodies.filter(b => b.kind === 'fruit' && b.alive).length;
  if (fruits + cap !== 6) d.cdF = Math.max(0, d.cdF - 1);
  const firstSlot = discRandomInt(w, 16);
  if (!d.cdF) {
    d.cdF = 30;
    const pickup = spawnPickup(w, d, 'fruit', firstSlot, d.variant === 'splash' ? 1500 : 2200);
    if (pickup === 'occupied') return;
    if (pickup === 'spawned') {
      // The picker draws the type twice before versus forces it to fruit.
      discRandomInt(w, 5);
      discRandomInt(w, 4096);
    }
  }
  d.itemMarkers ??= d.item.map(() => ({ item: 0, yaw: 0, x: 0, y: 0, z: 0 }));
  for (const [s, marker] of d.itemMarkers.entries()) {
    marker.item = d.item[s];
    if (!marker.item) continue;
    marker.yaw = (marker.yaw + 128) & 4095;
    marker.x = d.gx[s];
    marker.y = dashRideHeight(d.variant) + d.gy[s] + 512;
    marker.z = d.gz[s];
  }
}

/** FUN_800b8d68 counts DAT_800c6bb0 down, then runs FUN_800c04ec and (off Splash) the crate spawner FUN_800c0cb4. */
function spawnPickups(w: World, d: Data, locked = false) {
  if (!locked) d.pre--;
  if (d.pre >= 0) return;
  stepFruitAndHeldItems(w, d);
  if (d.variant === 'splash') return;
  const crates = w.bodies.filter(b => b.kind === 'item' && b.alive).length;
  const held = d.item.filter(item => item > 0).length;
  const missing = (d.f <= 1800 ? 2 : 3) - crates - held;
  if (missing !== 0) d.cdC = Math.max(0, d.cdC - 1);
  for (let i = 0; i < missing; i++) {
    const radius = 2200 + discRandomInt(w, 100);
    const slot = discRandomInt(w, 16);
    if (!d.cdC) {
      d.cdC = 30;
      if (spawnPickup(w, d, 'item', slot, radius) === 'occupied') return;
    }
  }
}

function syncKarts(ps: Body[], d: Data) {
  for (const p of ps) {
    const s = p.slot;
    p.x = d.gx[s] * G; p.z = -d.gz[s] * G; p.y = d.gy[s] * G;
    p.face = (-d.yaw[s] * TAU) / 4096;
    p.vx = (d.vx[s] / 256) * G * 30; p.vz = (-d.vz[s] / 256) * G * 30;
    d.stun[s] = d.state[s] === S_HIT || d.state[s] === S_FALL ? 1 : 0;
  }
}

function stepAirborneKart(w: World, d: Data, s: number, st: number) {
  if (st === S_HIT) hitStep(d, s);
  else if (st === S_FALL) fallStep(w, d, s);
  else if (st === S_HOP) hopStep(d, s);
  else if (st === S_DRIVE) {
    d.gy[s] = 0;
    if (d.pitch) d.pitch[s] -= d.pitch[s] >> 1;
  }
}

/** FUN_800bc4b0: a short second bounce starts on the first landing's own tick. */
function hopStep(d: Data, s: number) {
  const land = () => {
    d.vy[s] += d.vy[s] < 0 ? 5 : 10;
    d.gy[s] -= d.vy[s];
    return d.vy[s] > 0 && d.gy[s] < 0;
  };
  if (!d.hopBounce[s] && land()) {
    d.vy[s] = -0x20;
    d.hopBounce[s] = true;
  }
  if (d.hopBounce[s] && land()) {
    d.gy[s] = d.vy[s] = 0;
    setState(d, s, S_DRIVE);
  }
}

/** Advance the native arena after the result. The caller owns a copy of the terminal snapshot. */
export function stepDashResult(w: World, winner: number | undefined) {
  const d = w.data as Data;
  const ps = players(w);
  w.tick++;
  advanceCourseFrame(d);
  w.ev = [];
  discRandomInt(w, 2);
  spawnPickups(w, d, true);
  if (d.variant === 'splash') stepSplash(w, d, true);
  else if (d.variant === 'toxic') stepToxicBarrels(w, d);

  const visible = winner === undefined ? ps : ps.filter(p => p.slot === winner);
  for (const s of nextPlayerOrder(w.rng, d)) {
    if (!visible.some(p => p.slot === s)) continue;
    const cpu = !!((d.cpuSeats ?? 0) & (1 << s));
    // The dispatcher still calls the winning CPU, including its held-item decision.
    const pad = s === winner && cpu ? padOf(dashCpuInput(w, s, true)) : NOPAD;
    // FUN_800c5400 enters 0x62 (FUN_800bcdac), then FUN_800c53bc updates it.
    // Splash's hop handler returns to drive before it can dispatch the result.
    if (s === winner && d.state[s] !== S_HOP) {
      const entering = d.state[s] !== S_WIN;
      if (d.hitLock?.[s]) d.hitLock[s]--;
      // FUN_800b48ec runs before the first result handler sets its steering flag.
      else if (entering || d.st[s] === 0) {
        d.tgt[s] = (d.tgt[s] + (Number(pad.r) - Number(pad.l)) * phys(d.variant).turn) & 0xfff;
        d.yaw[s] = (d.yaw[s] + (sdiff(d.yaw[s], d.tgt[s]) >> 2)) & 0xfff;
      }
      if (entering) {
        const hit = d.state[s] === S_HIT;
        setState(d, s, S_WIN);
        if (d.pitch) d.pitch[s] = 0;
        if (d.bank) d.bank[s] = 0;
        d.gy[s] = d.vx[s] = d.vz[s] = 0;
        // FUN_800bc0a4 finishes its vertical update after dispatching the result.
        if (hit) hitStep(d, s);
      } else {
        d.st[s]++;
        d.yaw[s] = (d.yaw[s] + (sdiff(d.yaw[s], 0) >> 2)) & 0xfff;
      }
      d.turbo[s] = false;
    } else {
      d.st[s]++;
      moveKart(w, d, s, NOPAD, phys(d.variant), cpu, visible);
    }
  }
  if (d.variant === 'toxic') stepToxic(w, d, true);
  else if (d.variant === 'dante') stepDante(w, d, true);
  if (!d.dantePool) for (const b of w.bodies) if (b.kind === 'fruit' || b.kind === 'item') movePickup(b, d.variant === 'splash');
  stepShields(w, d);
  if (d.dantePool) stepDanteObjects(w, d, true);
  else missiles(w, d, false);
  stepRespawnEffects(w, d);
  w.bodies = w.bodies.filter((b) => b.alive);
  syncKarts(ps, d);
}

/** FUN_800bebc0 runs once per driver, before its state handler and movement.
 * Only the active kart is separated. Velocity exchange affects both immediately. */
function kartContacts(w: World, d: Data, s: number, racers: Body[]) {
  const cap = phys(d.variant).boost << 8;
  for (let other = 0; other < 4; other++) {
    if (s === other || !racers.some(p => p.slot === other) || Math.abs(d.gy[s] - d.gy[other]) > 384) continue;
    const dx = d.gx[other] - d.gx[s], dz = d.gz[other] - d.gz[s];
    const distance = ps1SqrtQ6(dx * dx + dz * dz) >> 6;
    if (distance >= 384) continue;
    const take = discRandomInt(w, 4);
    const yaw = atan2g(dx, dz), push = 392 - distance;
    d.gx[s] -= push * Ti(yaw - 1024) >> 12;
    d.gz[s] -= push * Ti(yaw) >> 12;

    // All four courses use equal masses and restitution 256. FUN_800be914
    // clamps each incoming axis, drops its eight fractional bits, then swaps it.
    for (const v of [d.vx, d.vz]) {
      const a = clamp(v[s], -cap, cap) >> 8, b = clamp(v[other], -cap, cap) >> 8;
      v[s] = b << 8;
      v[other] = a << 8;
    }
    const speed = dashSpeedSq(d.vx[s], d.vz[s]);
    const sea = d.variant === 'splash';
    if (speed > (sea ? 0x10d2a4 : 0x62e08)) {
      emit(w, 'raceSound', d.gx[s] * G, -d.gz[s] * G, s, (sea ? 0x675 : 0x640) + take);
    }
    const half = speed >> 1;
    if (half > 810000 && dashSpeedSq(d.vx[other], d.vz[other]) < half &&
        d.state[other] !== S_FALL && d.state[other] !== S_HIT && d.state[s] !== S_HIT) {
      emit(w, 'raceSound', d.gx[s] * G, -d.gz[s] * G, s, 0x654);
      hit(w, d, s, other, true);
    }
  }
}

function dashSpeedSq(vx: number, vz: number): number {
  return (Math.imul(vx, vx) >> 8) + (Math.imul(vz, vz) >> 8);
}

function stepDanteObjects(w: World, d: Data, ended = false) {
  const pool = d.dantePool!;
  for (let slot = 5; slot < pool.actors.length; slot++) {
    const actor = pool.actors[slot];
    if (!actor) continue;
    if (actor.expires === d.f) {
      freeDanteActor(pool, slot);
      continue;
    }
    if (actor.body === undefined) continue;
    const body = w.bodies.find(b => b.id === actor.body);
    if (!body) continue;
    if (body.kind === 'missile') {
      const m = d.mis.find(m => m.id === body.id);
      if (m && stepMissile(w, d, m, !ended)) {
        d.mis = d.mis.filter(other => other !== m);
        body.alive = false;
      }
    } else if (ended) movePickup(body, false);
    else stepPickup(w, d, body);
    if (!body.alive) freeDanteActor(pool, slot);
  }
}

function missiles(w: World, d: Data, canHit = true) {
  const dead = d.mis.filter(m => stepMissile(w, d, m, canHit));
  if (!dead.length) return;
  const ids = new Set(dead.map(m => m.id));
  d.mis = d.mis.filter(m => !ids.has(m.id));
  w.bodies = w.bodies.filter(b => !ids.has(b.id));
}

function stepMissile(w: World, d: Data, m: Missile, canHit: boolean) {
  const age = m.age++;
  if (age === 0) return false;
  const b = w.bodies.find((o) => o.id === m.id);
  if (age === 1) {
    m.x = d.gx[m.owner]; m.z = d.gz[m.owner];
    m.y = -dashRideHeight(d.variant) - d.gy[m.owner];
    m.yaw = d.yaw[m.owner];
  }
  const oldX = m.x, oldZ = m.z;
  if (age % 3 === 2 && spawnRaceEffect(d, 11)) emit(w, 'missileTrail', oldX * G, -oldZ * G, -1, -m.y * G);
  const dx = -(140 * Ti(m.yaw - 0x400) >> 12), dz = -(140 * Ti(m.yaw) >> 12);
  m.x += dx; m.z += dz;
  let hitKart = false;
  for (let s = 0; canHit && s < 4; s++) { // FUN_800bf0f8
    if (s === m.owner || d.state[s] === S_FALL) continue;
    if (Math.abs(m.y + dashRideHeight(d.variant) + d.gy[s]) > 0x180) break;
    if ((m.x - d.gx[s]) ** 2 + (m.z - d.gz[s]) ** 2 < 0x24000) {
      hit(w, d, s, m.owner);
      hitKart = true;
      break;
    }
  }
  const escaped = (ps1SqrtQ6(oldX * oldX + oldZ * oldZ) >> 6) >= 0xf01;
  if (!hitKart && !escaped) {
    for (const group of MISSILE_WALLS[d.variant] ?? []) {
      if (!reflectMissile(m, group)) continue;
      m.bounces++;
      emit(w, 'missileBounce', m.x * G, -m.z * G, -1, 0x65e + discRandomInt(w, 3));
    }
  }
  if (hitKart || (!escaped && m.bounces >= 3)) {
    const burst = spawnRaceEffect(d, 18);
    emit(w, burst ? 'explode' : 'missilePop', (hitKart ? oldX : m.x) * G, -(hitKart ? oldZ : m.z) * G, -1, -m.y * G, m.owner);
  }
  if (b) {
    b.x = m.x * G; b.z = -m.z * G; b.y = -m.y * G;
    b.vx = dx * G * 30; b.vz = -dz * G * 30; b.face = -m.yaw * DR_ANGLE;
  }
  return hitKart || escaped || m.bounces >= 3;
}

/** FUN_800b3e60 uses the backward heading and signed roots in 1/256 of the sight line. */
function seesObstacle(dx: number, dz: number, reach: number, cx: number, cz: number): boolean {
  dx = dx * reach >> 12;
  dz = dz * reach >> 12;
  const a = (dx * dx + dz * dz) >> 12;
  const b = 2 * (dx * cx + dz * cz) >> 12;
  const c = (cx * cx + cz * cz - 0x180 ** 2) >> 12;
  const disc = (b * b - 4 * a * c) | 0;
  if (disc < 0) return false;
  const root = ps1SqrtQ6(disc) >> 6;
  const far = Math.trunc(((-b + root) * 256) / (2 * a));
  if (far < 0) return false;
  const near = Math.trunc(((-b - root) * 256) / (2 * a));
  return (near > 0 ? near : far) < 256;
}

/** FUN_8008c4c8 tests every edge plane and rounds the two products separately. */
function insideCourseGroup(edges: number[][], x: number, z: number): boolean {
  return edges.every(([ox, oz, nx, nz]) => ((x - ox) * nx >> 12) >= ((z - oz) * nz >> 12));
}

const CPU_CONTROL = Symbol('Crash Dash CPU control');
const cpuRequest = { ...IDLE, [CPU_CONTROL]: true };

/** FUN_800b4708 (CPU callback FUN_800c5d8c) checks opponents, chooses a driving line, then reacts to stage hazards. */
export function dashCpuInput(w: World, slot: number, afterVerdict = false): InputState {
  const d = w.data as Data;
  if (!d) return IDLE;
  if (!afterVerdict && (d.winner !== undefined || d.first >= 0 || d.finish[slot] >= 0)) return IDLE;
  const v = d.variant;
  const x = d.gx[slot], z = d.gz[slot], yaw = d.yaw[slot];
  const dx = Ti(yaw - 0x400), dz = Ti(yaw);
  let l = false, r = false, boost = true, use = false;
  const pMe = atan2g(x, z) & 4095;
  // nearest pickup (FUN_800c5c64 by FUN_8008ceb0 X/Z distance, test FUN_800c5dac / FUN_800b5660); chased when within 1600 and further along the lap (larger polar angle)
  let near: { x: number; z: number } | null = null, nd = Infinity;
  for (const o of w.bodies) {
    if ((o.kind !== 'fruit' && o.kind !== 'item') || !o.alive) continue;
    const ox = o.x / G, oz = -o.z / G, dd = (ox - x) ** 2 + (oz - z) ** 2;
    if (dd <= nd) { nd = dd; near = { x: ox, z: oz }; }
  }
  const chase = near !== null && nd < 0x271000 && pMe < (atan2g(near.x, near.z) & 4095);
  // kart avoidance (FUN_800b442c)
  if (v !== 'dot') {
    for (let o = 0; o < 4; o++) {
      if (o === slot) continue;
      if (sext(atan2g(d.gx[o], d.gz[o]) - pMe) > 99 && seesObstacle(dx, dz, 1524, d.gx[o] - x, d.gz[o] - z)) {
        if (d.gx[o] ** 2 + d.gz[o] ** 2 < 0x310001) { l = true; r = false; } else { r = true; l = false; }
      }
    }
  }
  if (chase && near) {
    const diff = sext(atan2g(x - near.x, z - near.z) - yaw);
    if (diff > 500) { r = true; l = false; }
    if (diff < -500) { l = true; r = false; }
    boost = false; // FUN_800b5528: run only
  } else { // FUN_800b5360 -> FUN_800b4edc
    const speedSq = dashSpeedSq(d.vx[slot], d.vz[slot]);
    const speed = ps1SqrtQ6(speedSq) >> 14;
    const nearReach = 512 + Math.max(0, Math.trunc((speed - 80) * 384 / 80));
    if (insideCourseGroup(AI_HUB[v], x - (dx * nearReach >> 12), z - (dz * nearReach >> 12))) l = true;
    const fx = x - (dx * 121 >> 8), fz = z - (dz * 121 >> 8);
    if (v === 'dot' ? !insideCourseGroup(DOT_OUTER, fx, fz) : fx * fx + fz * fz > (v === 'toxic' ? 0x510000 : 0x640000)) r = true;
  }
  if (v === 'toxic') {
    // FUN_800b3890: nearest live barrel that is ahead in the lap, on the 4096-long forward ray -> steer away from the hub / towards it, boost off
    let bi = -1, bd = Infinity;
    for (let i = 0; i < d.bar.length; i++) {
      const b = d.bar[i];
      if (b.t > 0) continue;
      if (((pMe - 0x400) & 0xfff) <= ((atan2g(b.x, b.z) - 0x400) & 0xfff)) {
        const dd = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (dd < bd) { bd = dd; bi = i; }
      }
    }
    if (bi >= 0 && seesObstacle(dx, dz, 4096, d.bar[bi].x - x, d.bar[bi].z - z)) {
      if (d.bar[bi].x ** 2 + d.bar[bi].z ** 2 < 0x400000) { r = false; l = true; } else { l = false; r = true; }
      boost = false;
    }
    // FUN_800b3bc0: the nearest blob on the forward ray
    let nb: Blob | null = null; bd = Infinity;
    for (const b of d.blobs) { const dd = (x - b.x) ** 2 + (z - b.z) ** 2; if (dd <= bd) { bd = dd; nb = b; } }
    if (nb && seesObstacle(dx, dz, 4096, nb.x - x, nb.z - z)) {
      if (nb.x ** 2 + nb.z ** 2 < x * x + z * z) { r = false; l = true; } else { l = false; r = true; }
      boost = false;
    }
  }
  if (v === 'splash') {
    // FUN_800b372c: hop when a raised spoke is within 256 of the point 64 ahead
    const px = x - (dx >> 6), pz = z - (dz >> 6);
    use = d.sp.some((_, i) => {
      const hit = spokeContact(d, i, px, 0, pz);
      return !!hit && !(hit.faces & 4);
    });
  } else if (d.item[slot] === 1 || (v === 'toxic' && d.item[slot] === 2)) {
    // FUN_800b41dc (missile) / FUN_800b406c (shield), target from FUN_800b35cc.
    // Individual versus gives every eligible opponent the same weight (16).
    const live = d.finish.filter((finish, s) => s !== slot && finish < 0).length;
    for (let o = 0; o < 4 && !use; o++) {
      if (o === slot) continue;
      let pick = discRandomInt(w, 4);
      const threshold = discRandomInt(w, 4096);
      if (!live || threshold >= Math.trunc(4096 / live)) continue;
      while (pick === slot || d.finish[pick] >= 0) pick = (pick + 1) & 3;
      if (pick !== o) continue;
      if (d.item[slot] === 1) use = sext(atan2g(d.gx[o], d.gz[o]) - pMe) > 99 && seesObstacle(dx, dz, 2048, d.gx[o] - x, d.gz[o] - z);
      else use = (d.gx[o] - x) ** 2 + (d.gz[o] - z) ** 2 < 0x90000;
    }
  }
  return { x: (r ? 1 : 0) - (l ? 1 : 0), y: -1, a: boost, b: use };
}

/** FUN_800bd99c ranks by remaining laps with a stable bubble sort; equal leaders draw. */
function placements(w: World) {
  const d = w.data as Data;
  return [0, 1, 2, 3].sort((a, b) => d.lap[b] - d.lap[a] || a - b);
}

const driveControls = '{lr} steer. Hold {up} or {r} to accelerate. Hold {a} to boost with fruit.';

export const dashRace: MiniGame = {
  id: 'dashRace',
  name: 'Crash Dash',
  description: `First to ${DR_LAPS} laps or most laps at the buzzer wins. Crates contain missiles.`,
  variantDescriptions: {
    toxic: `First to ${DR_LAPS} laps or most laps at the buzzer wins. Dodge barrels and grab shield crates.`,
    splash: `First to ${DR_LAPS} laps or most laps at the buzzer wins. Hop over rising rods.`,
    dante: `First to ${DR_LAPS} laps or most laps at the buzzer wins. Dodge lava rocks and grab missile crates.`,
  },
  controls: driveControls + ' Hold {b} to fire a missile.',
  variantControls: {
    toxic: driveControls + ' Hold {b} to use a shield.',
    splash: driveControls + ' Tap {b} to hop.',
  },
  variants: DR_VARIANTS,
  maxTime: RACE_SECONDS,
  setup,
  step,
  isOver(w) {
    const d = w.data as Data;
    return d.winner !== undefined || d.first >= 0;
  },
  isDraw(w, [a, b]) {
    const d = w.data as Data;
    return d.winner === undefined ? d.lap[a] === d.lap[b] : d.winner < 0;
  },
  placements,
  bot() { return cpuRequest; },
};
