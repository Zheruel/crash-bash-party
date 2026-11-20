import { atan2g } from '../ps1Angle';
import { ps1SqrtQ6 } from '../ps1Sqrt';
/**
 * BALLISTIX (game id 'ballDefence') - port of Crash Bash's Ballistix overlay (levels 14-17, see re/notes/ballistix.md).
 *
 * The game logic of the disc runs at 30 Hz, exactly our TICK_RATE, so one step() is one game frame and every constant
 * below is the disc's per-frame value. All state is kept in disc units ("u", 1024 u = 1 native model unit, 256 u = 1 sim unit)
 * in world.data; the bodies in world.bodies are only a mirror in sim units for rendering (sim x = u / 256, sim z = -u_z / 256,
 * so game player 0, who sits at u_z = -2176, is the ship at the bottom of the screen = slot 0).
 *
 * Four ships (slot = game player index) each guard one side. The CRASHBALL / BEACH BALL / N.BALLISM ships slide along their wall
 * (slots 0,1 along x, 2,3 along z), the SKY BALLS ships orbit the disc on a ring. Every ball that crosses your goal line costs one
 * point of your start score (15 / 12 / 20 / 20); at 0 your goal is walled up and you are out. Last ship standing wins.
 *   A = kick (square).  B = speed boost (any shoulder button); BEACH BALL: B = catch (cross, hold) and release to fire.
 *
 * world.data (all JSON):
 *   variant, f (frame), pl: Pl[4], balls: Ball[], posts, mach, ...  -- see the interfaces below
 *
 * Events: sfx (o = real effect id, s = slot, see re/notes/ballistix.md), goal (s = scored-on slot, o = last toucher),
 *   ko (s), kick (s), hit (o = slot, v = impact), bounce, spawn, pickup (s), shield (s, v 1/0), catch (s), launch (s),
 *   machine (v = state).
 */
import { addBody, discRandomInt, discRandomState, emit } from '../physics';
import { DISC_CHARACTER } from '../look';
import { DT, IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const BD_U = 256; // disc units per sim unit
export const BD_K = 4;
export const BD_HALF = 9; // legacy: arena half size in sim units (0x900 / 256 = 9)
export const BD_BALL_R = 0.5; // 128 u
export const BD_TRAIL_LENGTH = 6;
export type BDTrailPoint = [x: number, z: number];
export interface CrashballFlash { tick: number; x: number; y: number; z: number }
export const BD_SHIP_R = 1.35; // body sphere 345 u
export const BD_START_BY: Record<string, number> = { crashball: 15, beach: 12, nballism: 20, sky: 20 };
export const BD_START = 15;
/** Outward normal of each slot's goal in sim space: 0 bottom(+z), 1 top(-z), 2 right(+x), 3 left(-x) */
export const BD_NORMALS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

export const BD_VARIANTS = [
  { id: 'crashball', name: 'CRASHBALL' },
  { id: 'beach', name: 'BEACH BALL' },
  { id: 'nballism', name: 'N.BALLISM' },
  { id: 'sky', name: 'SKY BALLS' },
];

/** corner bumpers (x, z, r) in u, in the disc's order */
export const BD_BUMPERS: Record<string, [number, number, number][]> = {
  crashball: [[2048, 2048, 512], [2048, -2048, 512], [-2048, 2048, 512], [-2048, -2048, 512]],
  beach: [[2048, 2048, 512], [2048, -2048, 512], [-2048, 2048, 512], [-2048, -2048, 512]],
  nballism: [[2128, 2128, 416], [2128, -2128, 416], [-2128, 2128, 416], [-2128, -2128, 416]],
  sky: [[1869, 1869, 464], [1869, -1869, 464], [-1869, 1869, 464], [-1869, -1869, 464]],
};
/** ball spawn corners (u, game z) in the disc's order */
const SPAWNS: Record<string, [number, number][]> = {
  crashball: [[-2048, -2048], [2048, -2048], [-2048, 2048], [2048, 2048]],
  beach: [[-2048, -2048], [2048, -2048], [-2048, 2048], [2048, 2048]],
  nballism: [[-2304, -2304], [2304, -2304], [-2304, 2304], [2304, 2304]],
  sky: [[-2048, -2048], [2048, -2048], [-2048, 2048], [2048, 2048]],
};
const SPAWN_Y: Record<string, number> = { crashball: -256, beach: -256, nballism: -1280, sky: -2048 };
/** corner pair used for the next ball after side s conceded (0x800c1214) */
const SPAWN_AFTER = [[0, 1], [2, 3], [1, 3], [0, 2]];
/** ship rest positions (u, game z) */
const START: [number, number][] = [[0, -2176], [0, 2176], [2176, 0], [-2176, 0]];
/** quantised facing (angle of the outward direction) */
const FACE = [0x800, 0, 0x400, 0xc00];
/** AI defence segments (0x800c1900): [x1, z1, x2, z2] */
const LINES: number[][] = [[-2048, -1952, 2048, -1952], [-2048, 1952, 2048, 1952], [1952, -2048, 1952, 2048], [-1952, -2048, -1952, 2048]];
/** AI error windows (0x800c1980) */
const WIN = [0x100, 0x140, 0x180, 0x1c0, 0x280, 0x240, 0x280, 0x2c0, 0x300, 0x340, 0x380, 0x3c0, 0x480, 0x440, 0x480, 0x4c0,
  0x500, 0x540, 0x580, 0x5c0, 0x680, 0x640, 0x680, 0x6c0, 0x700, 0x740, 0x780, 0x7c0, 0x880, 0x840, 0x880, 0x8c0];
const CNT_OFF = [16, 8, 4, 2, 1, 0, 0, 0, 0, 0]; // 0x800c1328, indexed by ball count
/** Party-mode CPU skills (the EASY/MEDIUM/HARD tables pointed to by 0x8009d900). */
const BOT_SKILLS: Record<string, number[]> = {
  crashball: [2, 10, 18], beach: [2, 11, 19], nballism: [2, 11, 18], sky: [6, 14, 20],
};
const PAD_BITS = [0x10, 0x30, 0x20, 0x60, 0x40, 0xc0, 0x80, 0x90]; // 0x80051244: direction bits per 45 deg of angle
const POST_SEQ = [0, 1, 2, 3, 1, 3, 0, 1, 0, 3, 2, 1, 2, 0, 2, 3]; // 0x800c1440, indexed by running counter
const RING = 2304; // Sky Balls ship orbit radius
const BALL_MARKER_RADIUS = 89; // 0762 ball collision marker
const BALL_MARKER_HEIGHT = 255; // range from y - 127 to y + 128
const BEACH_CAUGHT = 0x80; // set by the held update and retained after release
const SHIP_FRONT_OFFSET = [[-2, -132], [2, 132], [132, -2], [-132, 2]]; // 0x800c1aa4, x/z
const SIDE_SFX = [1400, 1401, 1402, 1403];
const KICK_SFX = [1409, 1410, 1411, 1412];
const HIT_SFX = [1404, 1405, 1406, 1407];
const BOUNCE_SFX = [1415, 1416, 1417, 1418, 1419, 1420];
const LAND_SFX = [1421, 1422, 1423, 1424];

// ---------------------------------------------------------------- fixed point helpers (Q12 angle units, 0x1000 = 360 deg)
const SIN = new Int16Array(4096);
for (let i = 0; i < 4096; i++) SIN[i] = Math.round(4096 * Math.sin((i * Math.PI * 2) / 4096));
const sinq = (a: number) => SIN[a & 4095];
const cosq = (a: number) => SIN[(a + 0x400) & 4095];
/** angle of (dx, dz): 0 = +z, 0x400 = +x (FUN_8001463c) */
const atan = (dx: number, dz: number) => (Math.round((Math.atan2(dx, dz) * 4096) / (Math.PI * 2)) & 4095);
const discAngle = (x: number, z: number) => atan2g(x, z) & 4095;
/** signed difference b - a in -0x800..0x7ff (FUN_800154a0) */
const adiff = (a: number, b: number) => { const d = (b - a) & 4095; return d >= 0x800 ? d - 4096 : d; };
const aabs = (a: number, b: number) => Math.abs(adiff(a, b));
const rnd = discRandomInt; // Beach uses the disc pair. The other variants keep their existing stream.
/** deterministic pseudo random for the bot (must not touch w.rng) */
const hash = (...v: number[]) => { let h = 0x811c9dc5; for (const x of v) { h = Math.imul(h ^ (x | 0), 0x01000193); h ^= h >>> 15; } return (h >>> 0) / 4294967296; };

// ---------------------------------------------------------------- state
interface Pl {
  x: number; z: number; // u (game z)
  y: number; roll: number; // hull's hover height and lean, in game coordinates
  skyFloor?: number; // height sampled before the ship takes its orbital step
  vel: number; // lateral velocity (+0xc)
  face: number; // facing angle (outward)
  ang: number; // Sky Balls: ring angle
  score: number;
  kcd: number; // kick cooldown (0x8009d592)
  kpen: number; // kick penalty (0x8009d594)
  kfr: number; // frames into the kick swing (0x8009d596)
  st: number; // 0x1c idle, 0x1d move, 0x1e taunt, 0x1f kick, 0x21 catch, 0x22 win, 0x24 dying, 0x25 gone
  stateAt: number;
  character: number;
  idleT: number;
  idleAt: number; // frame origin of script 0x1b, or -1 when inactive
  hold: number; // catch timer (0x8009d590)
  arm: number; // CPU release arming (+0x28)
  beachCpu?: BeachCpu;
  cpuFallback?: true;
  cpu: boolean;
  skill: number;
  pa: boolean; // previous A
  pb: boolean;
  pc: boolean;
  shield: number; // frames of force field left
  dead: number; // 0 alive, else frame of elimination
  dieT: number;
  beachSmoke?: BeachSmoke[];
  pushed: boolean;
  last: number; // last lateral velocity (for the view)
  boost: boolean;
}
interface BeachSmoke {
  wait: number;
  age: number; // -1 until the puff spawns
  y: number;
  vy: number;
}
interface BeachCpu {
  target: number;
  roamX: number;
  roamZ: number;
  mode: number;
  lapse: number;
  catchT: number;
  wait: number;
  nextPad?: InputState;
}
interface Ball {
  id: number;
  beachPoolSlot?: number; // callback order, separate from the newest-first contact list
  st: number; // 0 new, 0xc waiting, 6 falling in, 8 bounce, 1 rolling, 2 held, 4/0x11/99 into goal, 0x12 scored
  x: number; y: number; z: number;
  prevX?: number; prevZ?: number;
  firstServeAt?: number;
  h: number; spd: number; tgt: number; acc: number; dec: number;
  who: number; // last toucher / conceding player (-1 none)
  hcd: number; tm: number;
  beachKickCd?: number; // Serialized name of the ball's kick cooldown (+0x20) on all stages.
  vv: number; vmax: number; vup: number; vdn: number; vdir: number; // vertical bounce state (vdir 0 = down)
  psh: number; pshA: number;
  land: boolean; sink: number; fl: number;
  corner: number;
  trail?: BDTrailPoint[]; // current point followed by the six previous points, in disc units
}
type BeachPoolEffect = { beachPoolSlot: number } & ({ wall: number } | { releaseAt: number });
interface Post { i: number; t: number }
/** Sky Balls platform event per player (0x800c1e78 + p*0x1c): offset, velocity, velocity clamp, accel up / down, direction, state, timer */
interface SkyEv { pos: number; vel: number; max: number; ap: number; an: number; dir: number; st: number; tm: number }
interface Mach { st: number; t: number; c: number; yaw: number; spin: number }
interface Data {
  variant: string; f: number;
  pl: Pl[]; balls: Ball[]; bid: number[]; // bid[ball.id] = body id
  beachFreeBallSlots?: number[]; // Shared free stack. Keep the original snapshot field name.
  beachPoolEffects?: BeachPoolEffect[];
  ef8: number; efc: number; efa: number; off: number;
  last: number; // side that conceded last (0x800c1f16), -1 none
  walls: number; // closed goals bitmask 1=z- 2=z+ 4=x- 8=x+ (game axes)
  skyWallSoundDelay?: number;
  cool: number[]; // spawn corner cooldowns
  bumperHitAt?: number[];
  bumperFrames?: number; // Eight ticks of four light bits, newest in the low nibble.
  flashes?: CrashballFlash[];
  postT: number; postSeq: number; post: Post | null;
  mach: Mach | null;
  random?: [number, number];
  shipOrder?: number[][];
  beachSpectatorTarget?: number; // -1 while the all-CPU controller has to choose a target
  beachDecidedAt?: number; // Seat pass sets the native 0x800 round-decided flag.
  beachResultAt?: number; // Victory script ends the round on its second character sound.
  /** Sky Balls: platform events, event timer / table index (0x800c1c78 / 7c), disc tilt [rx 0x800c1c68, rz 0x800c1c6c, floor y 0x8005a5d8] */
  sky?: { ev: SkyEv[]; t: number; i: number };
  tilt?: number[];
}

export type BallistixData = Data;

/** FUN_800bfd14: the Sky Balls floor at a native horizontal position. */
export function ballistixFloor(tilt: readonly number[] | undefined, x: number, z: number) {
  if (!tilt) return 0;
  const [rx, rz, y] = tilt;
  return y - ((z * sinq(rx)) >> 12) + ((x * sinq(rz)) >> 12);
}

function skyBaseTilt(frame: number): [number, number, number] {
  const cosine = cosq(frame * 0x20);
  return [(sinq(frame * 0x20) * 5) >> 10, ((sinq(frame * 0x40) + cosine) * 11) >> 12, (cosine * 3) >> 7];
}

// All seats are idle for the 99 controller updates before input unlocks.
// Index by time remaining so reconnects can start at the current numbered frame.
const skyOpening = (() => {
  const roll = [0, 0, 0, 0];
  return Array.from({ length: 99 }, (_, index) => {
    const tick = index - 98;
    const tilt = skyBaseTilt(tick);
    const ships = FACE.map((angle, slot) => {
      const x = (sinq(angle) * RING) >> 12, z = (cosq(angle) * RING) >> 12;
      const bob = sinq((tick + slot) * 0x40);
      roll[slot] += adiff(roll[slot], (bob * 17) >> 10) >> 2;
      return { x, z, y: -128 + ((bob * 15) >> 11), skyFloor: ballistixFloor(tilt, x, z), roll: roll[slot] };
    });
    return { tilt, ships };
  });
})();

export function skyOpeningFrame(ticksLeft: number) {
  return skyOpening[98 - Math.max(0, Math.min(98, Math.floor(ticksLeft)))];
}

const V = (w: World) => (w.data as Data).variant;
const bumpers = (d: Data) => BD_BUMPERS[d.variant];
const isSky = (d: Data) => d.variant === 'sky';
const nBalls = (d: Data) => d.balls.length;
const living = (d: Data) => d.pl.filter((p) => p.score > 0).length;

export const bdBallY = (y: number) => -(y + 96) / BD_U; // disc y -> sim height above the floor

const CPU_CONTROL = Symbol('Beach Ball CPU control');
const cpuRequest = { ...IDLE, [CPU_CONTROL]: true };

/** FUN_80085650: sixteen rows of four swaps, each against any seat in its row. */
function ballistixShipOrder(w: World): number[][] {
  return Array.from({ length: 16 }, () => {
    const row = [0, 1, 2, 3];
    for (let i = 0; i < row.length; i++) {
      const other = rnd(w, row.length);
      [row[i], row[other]] = [row[other], row[i]];
    }
    return row;
  });
}

/** USA L14 FUN_800bc0d8, before the shuffled seat callbacks. */
function crashballFlash(w: World, d: Data, tick: number) {
  if (rnd(w, 15) === 0) {
    (d.flashes ??= []).push({ tick, x: rnd(w, 6144) - 3072, y: -128 - rnd(w, 512), z: 4096 + rnd(w, 2048) });
  }
}

// ---------------------------------------------------------------- setup
function beachAllocSlot(d: Data): number {
  // FUN_80022a3c / FUN_80022fd4: returned slots go ahead of untouched slots.
  return d.beachFreeBallSlots?.pop() ?? 1 + Math.max(-1,
    ...d.balls.map((b, i) => b.beachPoolSlot ?? i),
    ...(d.beachPoolEffects ?? []).map(e => e.beachPoolSlot));
}

function beachFreeSlot(d: Data, slot: number) {
  (d.beachFreeBallSlots ??= []).push(slot);
}

function newBall(w: World, d: Data): Ball {
  const beachPoolSlot = d.variant === 'beach' ? beachAllocSlot(d) : undefined;
  return {
    id: w.nextId++, ...(beachPoolSlot === undefined ? {} : { beachPoolSlot }),
    st: 0, x: 4096, y: -128, z: 4096, h: 0, spd: 0, tgt: 0, acc: 0, dec: 0, who: -1, hcd: 0, tm: 0,
    vv: 0, vmax: 0, vup: 0, vdn: 0, vdir: 0, psh: 0, pshA: 0, land: false, sink: 0, fl: 0, corner: -1,
  };
}

export const ballDefence: MiniGame = {
  id: 'ballDefence',
  name: 'Ballistix',
  description: 'Defend your goal. Each ball you concede costs a point. Last ship in play wins.',
  variantDescriptions: {
    beach: 'Defend your goal and launch caught balls past rivals. Last ship in play wins.',
    nballism: "Defend your goal from N. Gin's ball launcher. Grab the corner shield. Last ship in play wins.",
    sky: 'Guard your goal as the arena tilts. Last ship in play wins.',
  },
  controls: '{move} slide. {a} kick. Hold {r} to boost. {c} taunt when stopped.',
  variantControls: {
    beach: '{move} slide / hold {r} to boost. {a} kick. Hold {b} to catch, release to fire. {c} taunt when stopped.',
    sky: '{move} orbit. {a} kick. Hold {r} to boost. {c} taunt when stopped.',
  },
  variants: BD_VARIANTS,
  maxTime: 240,

  setup(w, slots) {
    const variant = pickVariant(w, BD_VARIANTS);
    const start = BD_START_BY[variant] ?? BD_START;
    const d: Data = {
      variant, f: 0, pl: [], balls: [], bid: [], ef8: 59, efc: 0, efa: 1, off: 8, last: -1, walls: 0,
      cool: [0, 0, 0, 0], postT: variant === 'nballism' ? 81 : 180, postSeq: 0, post: null, mach: null,
    };
    w.data = d;
    if (variant === 'beach' || variant === 'crashball') {
      d.random = discRandomState(w.rng);
      // The engine allocates all four AI records before shuffling, even for human seats.
      for (let i = 0; i < MAX_SEATS; i++) rnd(w, 60);
      d.shipOrder = ballistixShipOrder(w);
    }
    d.postSeq = rnd(w, 15);
    if (variant === 'beach') {
      // The arena initializer also seeds the two event tables in individual versus.
      rnd(w, 18);
      rnd(w, 18);
    }
    if (variant === 'nballism') d.mach = { st: 0, t: 291, c: 0, yaw: 0, spin: 0 };
    if (variant === 'sky') { // The 270-tick tilt timer has counted down to 171 at GO.
      d.sky = { ev: [0, 1, 2, 3].map(() => ({ pos: 0, vel: 0, max: 0, ap: 0, an: 0, dir: 0, st: 0, tm: 0 })), t: 171, i: rnd(w, 0x12) };
      d.tilt = [...skyOpeningFrame(0).tilt];
    }
    for (let i = 0; i < MAX_SEATS; i++) {
      const seat = slots.find((s) => s.slot === i);
      d.pl.push({
        x: START[i][0], z: START[i][1], y: -128, roll: 0,
        ...(variant === 'sky' ? skyOpeningFrame(0).ships[i] : {}),
        vel: 0, face: FACE[i], ang: FACE[i],
        score: start, kcd: 0, kpen: 0, kfr: 0, st: 0x1c, stateAt: 0, hold: 0, arm: 0, cpu: !!seat?.bot,
        skill: BOT_SKILLS[variant][seat?.level ?? 2] ?? BOT_SKILLS[variant][2],
        character: DISC_CHARACTER[seat?.char ?? 0] ?? 1, idleT: rnd(w, 150) + 180, idleAt: -1,
        pa: false, pb: false, pc: false, shield: 0, dead: 0, dieT: 0, pushed: false, last: 0, boost: false,
      });
    }
    for (const s of slots) {
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, 0, 0, BD_SHIP_R * sc, 3 * sc * sc);
      b.alive = true;
    }
    // The disc has run 99 controller ticks at input unlock. The first ball
    // stays offstage for the first 27 playable ticks of GO.
    const first = newBall(w, d);
    first.x = first.y = first.z = 8192;
    first.firstServeAt = 28;
    d.balls.push(first);
    if (variant === 'crashball') {
      // The first snapshot also supplies the full countdown to a late guest.
      for (let tick = -98; tick <= 0; tick++) {
        rnd(w, 2);
        crashballFlash(w, d, tick);
        rnd(w, 16);
      }
    }
    mirror(w, d);
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const alive = living(d);
    const beach = d.variant === 'beach';
    d.f++;
    if (alive === 0 || (!beach && alive === 1)) {
      // Finish the last knockout before handing control to the round results.
      for (let p = 0; p < MAX_SEATS; p++) if (d.pl[p].score <= 0) playerFrame(w, d, p, IDLE);
      mirror(w, d);
      return;
    }
    if (beach || d.variant === 'crashball') {
      d.random ??= discRandomState(w.rng);
      d.shipOrder ??= ballistixShipOrder(w);
      rnd(w, 2); // FUN_800155fc advances the engine RNG once before the scene update.
    }
    if (beach) {
      // Old snapshots have only creation order. Preserve it for their initial slots.
      d.balls.forEach((b, i) => { b.beachPoolSlot ??= i; });
    }
    const previousPost = d.post;
    controller(w, d);
    // Newly spawned posts register before the mesh pass. Expiry clears the marker afterward.
    updateBumperLights(d, previousPost ?? d.post);
    // FUN_8007906c collects callbacks after the arena controller and before the seats.
    const callbacks = beach ? [...d.balls, ...(d.beachPoolEffects ?? [])] : undefined;
    if (beach && d.shipOrder) {
      let humanPlaying = false;
      for (const p of d.shipOrder[rnd(w, 16)]) {
        const pl = d.pl[p], input = inputs[p];
        // The host supplies a CPU request for vacancies and disconnects. Prediction
        // has missing pads, so it carries the last known controller from the snapshot.
        const cpu = input ? CPU_CONTROL in input : pl.cpu || pl.cpuFallback === true;
        humanPlaying ||= !cpu && pl.score > 0;
        if (!pl.cpu && cpu) pl.cpuFallback = true;
        else if (pl.cpuFallback) delete pl.cpuFallback;
        if (!cpu && pl.beachCpu?.nextPad) delete pl.beachCpu.nextPad;
        if (pl.st !== 0x25 || pl.beachSmoke) tickKickCooldown(pl);
        const pad = cpu ? beachCpuPad(w, d, p) : input ?? IDLE;
        playerFrame(w, d, p, pl.score <= 0 || d.beachDecidedAt !== undefined ? IDLE : pad, cpu);
      }
      // FUN_80084788 detects the last human's elimination after the seat pass.
      if (!humanPlaying || alive === 1) d.beachSpectatorTarget ??= -1;
      if (alive === 1) d.beachDecidedAt ??= d.f;
    } else if (d.variant === 'crashball' && d.shipOrder) {
      for (const p of d.shipOrder[rnd(w, 16)]) playerFrame(w, d, p, inputs[p] ?? IDLE);
    } else {
      for (let p = 0; p < MAX_SEATS; p++) playerFrame(w, d, p, inputs[p] ?? IDLE);
    }
    pushShields(w, d);
    if (callbacks) beachPoolFrame(w, d, callbacks);
    else {
      const balls = d.balls.slice();
      if (d.mach) machine(w, d);
      for (const b of balls) ballFrame(w, d, b);
    }
    d.balls = d.balls.filter((b) => b.st !== -1);
    mirror(w, d);
  },

  isOver(w) {
    const d = w.data as Data;
    const alive = living(d);
    if (d.variant === 'beach' && alive === 1) return d.beachResultAt !== undefined && d.f >= d.beachResultAt;
    return alive <= 1 && d.pl.every((p) => p.score > 0 || p.st === 0x25);
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const aa = d.pl[a].score > 0, bb = d.pl[b].score > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.pl[b].score - d.pl[a].score || a - b;
      return d.pl[b].dead - d.pl[a].dead || a - b;
    });
  },

  bot(w, slot) {
    const d = w.data as Data;
    if (d.variant === 'beach') return cpuRequest;
    return botInput(w, d, slot);
  },
};

function beachPoolFrame(w: World, d: Data, callbacks: (Ball | BeachPoolEffect)[]) {
  callbacks.sort((a, b) => a.beachPoolSlot! - b.beachPoolSlot!);
  for (const entity of callbacks) {
    if ('st' in entity) {
      ballFrame(w, d, entity);
      if (entity.st === -1) beachFreeSlot(d, entity.beachPoolSlot!);
    } else if ('releaseAt' in entity ? d.f >= entity.releaseAt :
      d.beachDecidedAt !== undefined && d.f - d.beachDecidedAt >= 30) {
      if ('wall' in entity) d.walls &= ~entity.wall;
      beachFreeSlot(d, entity.beachPoolSlot);
      d.beachPoolEffects = d.beachPoolEffects?.filter(e => e !== entity);
    }
  }
}

/** Advance arena objects on the client's copy of the awarded round. */
export function stepBallistixResultArena(w: World, age: number, winner?: Pick<Pl, 'x' | 'y' | 'z' | 'roll' | 'face' | 'vel'> & { slot: number }) {
  const d = w.data as Data;
  w.ev = [];
  if (d.variant === 'beach' && d.beachDecidedAt !== undefined) {
    // Beach snapshots already carry the native post-verdict allocator and RNG.
    ballDefence.step(w, [], DT);
  } else {
    d.f++;
    updateBumperLights(d);
    for (let c = 0; c < d.cool.length; c++) if (d.cool[c] > 0) d.cool[c]--;
    if (age >= 30) d.walls = 0;
    if (d.mach?.st) {
      d.mach.st = 5;
      machine(w, d);
    }
    if (d.post && d.post.t-- <= 0) {
      d.post = null;
      emit(w, 'sfx', 0, 0, -1, 1, 1496);
    }
    if (d.sky) skyPlatform(w, d, d.sky, false);
    if (winner) {
      const { slot, ...motion } = winner;
      Object.assign(d.pl[slot], motion, { st: 0x22 });
      shipBalls(w, d, slot, winner.vel);
    }
    for (const b of d.balls.slice()) {
      if (b.st === 0 || b.st === 0x12) b.st = -1;
      else ballFrame(w, d, b);
    }
    d.balls = d.balls.filter(b => b.st !== -1);
    mirror(w, d);
  }
  w.tick++;
  w.time += DT;
  return w.ev;
}

// ---------------------------------------------------------------- body mirror (rendering)
function mirror(w: World, d: Data) {
  const sc = w.params.playerScale;
  for (const b of w.bodies) {
    if (b.kind !== 'player') continue;
    const p = d.pl[b.slot];
    b.x = p.x / BD_U; b.z = -p.z / BD_U;
    b.vx = p.vel; b.vz = 0; // lateral velocity in u per frame (view uses it for the lean)
    const fa = (p.face * Math.PI * 2) / 4096; // game angle: 0 = +z(game), 0x400 = +x. inward in sim = opposite of outward
    b.face = Math.atan2(-Math.sin(fa), Math.cos(fa)); // sim yaw (0 = +z sim) of the inward direction
    b.alive = p.score > 0 && p.st !== 0x25;
    b.cd = p.kcd / 30; b.dash = p.st === 0x1f ? 0.1 : 0;
    b.r = BD_SHIP_R * sc;
  }
  // balls
  const live = new Set<number>();
  for (const bl of d.balls) {
    live.add(bl.id);
    let b = w.bodies.find((q) => q.id === bl.id);
    if (!b) { b = { id: bl.id, kind: 'ball', slot: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0.5, m: 1, face: 0, alive: true, fall: false, cd: 0, dash: 0 }; w.bodies.push(b); }
    b.x = bl.x / BD_U; b.z = -bl.z / BD_U; b.y = bdBallY(bl.y);
    b.r = BD_BALL_R * w.params.ballScale;
    const sp = (bl.spd * 30) / BD_U;
    b.vx = -((bl.spd * sinq(bl.h)) / 4096) * 30 / BD_U; b.vz = ((bl.spd * cosq(bl.h)) / 4096) * 30 / BD_U; b.vy = sp;
    b.cd = bl.who + 1; b.alive = bl.st !== 0 && bl.st !== 0xc && bl.st !== 0x12;
    b.dash = bl.st === 2 ? 1 : 0;
    b.face = bl.st;
  }
  w.bodies = w.bodies.filter((b) => b.kind !== 'ball' || live.has(b.id));
}

// ---------------------------------------------------------------- level controller (FUN_800bc0d8, FUN_800bbc3c, FUN_800bd770)
function controller(w: World, d: Data) {
  if (d.variant === 'crashball') {
    if (d.flashes?.length && d.flashes[0].tick < d.f - 12) d.flashes = d.flashes.filter(f => f.tick >= d.f - 12);
    crashballFlash(w, d, d.f);
  }
  if (d.beachSpectatorTarget === -1 && d.beachDecidedAt === undefined) {
    // FUN_800b40ac favors the first surviving seat with the lowest score.
    let target = -1;
    for (let p = 0; p < MAX_SEATS; p++) {
      if (d.pl[p].score > 0 && (target === -1 || d.pl[p].score < d.pl[target].score)) target = p;
    }
    d.beachSpectatorTarget = target;
  }
  for (let c = 0; c < 4; c++) if (d.cool[c] > 0) d.cool[c]--; // corner spawn cooldown (0x800c1cfa, FUN_800bcb..)
  if (d.beachDecidedAt !== undefined) return;
  const alive = living(d);
  const mact = !!d.mach && d.mach.st !== 0;
  // N.Ballism power-up post
  if (d.variant === 'nballism') {
    if (d.post) {
      d.post.t--;
      if (mact || d.post.t <= 0) { emit(w, 'sfx', 0, 0, -1, 1, 1496); d.post = null; } // 0x5d8 expiry
    } else if (!d.pl.some((p) => p.shield > 0)) {
      if (d.postT === 0) {
        if (!mact) spawnPost(w, d);
        d.postT = rnd(w, 90) + 30;
      } else d.postT--;
    }
  }
  // ball count
  if (d.efc === 0) {
    d.ef8++;
    let target = Math.floor(d.ef8 / 300) + 1;
    target = Math.min(target, d.variant === 'beach' ? 4 : 5);
    if (mact) target = 0;
    d.efa = nBalls(d);
    if (target > d.efa) {
      if (d.balls.length < 9 && (d.variant === 'beach' || alive > 1)) d.balls.push(newBall(w, d));
      d.efc = 30;
    }
  } else d.efc--;
  d.off = d.variant === 'beach' && d.efa === 0 ? 10 : CNT_OFF[Math.min(d.efa, 9)];
  if (d.sky) skyPlatform(w, d, d.sky);
}

function updateBumperLights(d: Data, post = d.post) {
  let lit = 0;
  if (d.variant === 'nballism') {
    lit = post ? 1 << post.i : 0;
  } else if (d.variant === 'crashball' && d.bumperHitAt) {
    for (let i = 0; i < 4; i++) {
      const age = d.f - d.bumperHitAt[i];
      if (age === 1 || age === 2) lit |= 1 << i;
    }
  } else return;
  d.bumperFrames = ((d.bumperFrames ?? 0) << 4) | lit;
}

function spawnPost(w: World, d: Data) {
  const out = (p: number) => d.pl[p].score <= 0;
  const pairs: [number, number][] = [[0, 3], [0, 2], [1, 3], [1, 2]]; // goals next to each corner post
  for (let tries = 0; tries < 5; tries++) {
    d.postSeq++;
    const i = d.postSeq < POST_SEQ.length ? POST_SEQ[d.postSeq] : -1;
    if (i < 0) { d.postSeq = 0; continue; }
    if (out(pairs[i][0]) && out(pairs[i][1])) continue;
    d.post = { i, t: 180 };
    emit(w, 'post', 0, 0, i, 1);
    return;
  }
}

function machine(w: World, d: Data) {
  const m = d.mach!;
  switch (m.st) {
    case 0:
      if (m.t === 0) m.st = 1; else m.t--;
      break;
    case 1: m.st = 2; m.t = 10; emit(w, 'sfx', 0, 0, -1, 1, 1470); emit(w, 'machine', 0, 0, 1, 1); break; // rise (0x5be)
    case 2:
      m.yaw = (m.yaw + 0x20) & 4095;
      if (m.t === 0) { m.st = 3; m.t = 0x5a; m.spin = 0x10; emit(w, 'sfx', 0, 0, -1, 1, 1471); emit(w, 'machine', 0, 0, 3, 1); } else m.t--;
      break;
    case 3:
      m.yaw = (m.yaw + m.spin) & 4095; m.spin += 4;
      if (m.t === 0) { m.st = 4; m.t = 0x96; m.c = rnd(w, 10) + 10; emit(w, 'machine', 0, 0, 4, 1); } else m.t--;
      break;
    case 4:
      m.yaw = (m.yaw + 0x1c7) & 4095;
      if (m.c === 0) { spit(w, d, m); m.c = 0xf; } else m.c--;
      if (m.t === 0) m.st = 5; else m.t--;
      break;
    case 5:
      emit(w, 'sfx', 0, 0, -1, 1, 1472); emit(w, 'machine', 0, 0, 5, 1); // retract (0x5c0)
      m.st = 0; m.t = (rnd(w, 15) + 8) * 30; d.efc = 0x19;
      break;
  }
}

function spit(w: World, d: Data, m: Mach) {
  if (d.balls.length >= 8) return;
  const b = newBall(w, d);
  b.st = 1; b.x = (sinq(m.yaw) * 13) >> 7; b.z = (cosq(m.yaw) * 13) >> 7;
  b.h = m.yaw; b.spd = b.tgt = 0x80; b.acc = 4; b.dec = 1; b.y = -128; b.fl = 0x40;
  d.balls.push(b);
  emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, -1, 1, 1473);
}

// ---------------------------------------------------------------- players
/** Top and bottom goals take horizontal input. The side goals take vertical input, including on Sky Balls. */
export const ballistixSlidesHorizontally = (slot: number) => slot === 0 || slot === 1;
/** Clip lengths in the character scripts 0x1b (idle gesture) and 0x1c (Triangle taunt). */
const IDLE_POSE_TICKS = [0, 109, 41, 60, 56, 46, 60, 31, 75];
const TAUNT_POSE_TICKS = [0, 52, 49, 52, 50, 42, 42, 61, 40];
const TAUNT_VOICES = [0, 7, 0x39, 0x6b, 0x9d, 0x133, 0x165, 0x101, 0xcf];
const BEACH_WIN_VOICE_TICKS = [90, 24, 23, 26, 23, 23, 23, 26, 26];

function tickKickCooldown(pl: Pl) {
  if (pl.kcd > 0) pl.kcd--;
  else if (pl.kpen > 0) pl.kpen--;
}

function beachIdleFrame(w: World, d: Data, pl: Pl) {
  if (pl.idleAt >= 0) {
    if (d.f - pl.idleAt >= IDLE_POSE_TICKS[pl.character]) {
      pl.idleAt = -1;
      pl.stateAt = d.f; // Script 0x1b returns to the first pose of 0x19.
    }
  } else if (pl.idleT > 0) pl.idleT--;
  else {
    // FUN_800b66d0 starts script 0x1b at pose 0 and advances it again
    // in the same callback once the pilot is settled.
    pl.idleAt = d.f - 1;
    pl.idleT = rnd(w, 600) + 300;
  }
}

function playerFrame(w: World, d: Data, p: number, inp: InputState, cpu = d.pl[p].cpu) {
  const pl = d.pl[p];
  const beach = d.variant === 'beach';
  if (pl.st === 0x25) {
    if (pl.beachSmoke) beachSmokeFrame(w, d, pl, pl.beachSmoke);
    return;
  }
  if (!beach && pl.score <= 0 && pl.st < 0x24) {
    enterDie(w, d, p);
    return;
  }
  if (!beach && pl.st === 0x24) {
    pl.vel = 0;
    if (--pl.dieT <= 0) finishDie(w, d, pl, p);
    return;
  }
  const sky = isSky(d);
  const fr = w.params.friction;
  // --- input to pad bits (digital)
  const th = 0.35;
  const L = inp.x < -th, R = inp.x > th, U = inp.y < -th, Dn = inp.y > th; // screen directions; U = toward the top of the screen
  const boost = !!inp.l || !!inp.r || (!!inp.b && !beach);
  const catchB = !!inp.b && beach;
  const edgeA = !!inp.a && !pl.pa; pl.pa = !!inp.a;
  const edgeB = catchB && !pl.pb; pl.pb = catchB;
  const edgeC = !!inp.c && !pl.pc; pl.pc = !!inp.c;
  // --- slide (FUN_800b558c / FUN_800b58e8)
  let max = sky ? 0x28 : 0x68, acc = sky ? 0xd : 0x22, dec = sky ? 6 : 0x12;
  if (p === 1) acc = sky ? 0x15 : 0x2a;
  if (boost) { max = sky ? 0x48 : 0xa0; acc = sky ? 0x12 : 0x38; }
  dec = Math.max(1, Math.round(dec * fr));
  // direction: sim screen-left/right is -x/+x; the game's +x slide is screen right for every slider; z sliders: up = +game z = screen up
  let dirv = 0; // +1 / -1 along the slide axis in game coordinates
  if (ballistixSlidesHorizontally(p)) dirv = (R ? 1 : 0) - (L ? 1 : 0);
  else dirv = (U ? 1 : 0) - (Dn ? 1 : 0);
  const gate = pl.st !== 0x25;
  if (dirv === 0) {
    pl.pushed = bump(d, pl, p);
    if (pl.pushed) pl.vel = 0;
    if (pl.vel > 0) { pl.vel -= dec; if (pl.vel < 0) pl.vel = 0; }
    else if (pl.vel < 0) { pl.vel += dec; if (pl.vel > 0) pl.vel = 0; }
  } else if (gate) {
    let a = dirv * acc;
    pl.pushed = bump(d, pl, p);
    if (pl.pushed) { if (a < 0) a -= max >> 1; if (a > 0) a += max >> 1; }
    const old = pl.vel;
    pl.vel = old + a;
    if (pl.vel > max) pl.vel = max;
    if (pl.vel < -max) pl.vel = -max;
    if (pl.vel === 0 && a !== 0) pl.vel = a < 0 ? -1 : 1;
  }
  pl.boost = boost;
  // --- state machine (FUN_800b66d0 / b60fc)
  const previous = pl.st;
  if (!beach) tickKickCooldown(pl);
  // The idle callback runs before the catch, kick and movement transitions.
  if (beach && previous === 0x1c && !edgeC) beachIdleFrame(w, d, pl);
  if (pl.st === 0x1f) {
    kickUpdate(w, d, p);
  } else if (pl.st === 0x21) {
    catchUpdate(w, d, p, !!inp.b, cpu);
  } else if (beach && pl.st === 0x24) {
    if (--pl.dieT <= 0) finishDie(w, d, pl, p);
  } else if (beach && pl.st === 0x22) {
    // FUN_800b6cf0: the winner travels inward before the result screen.
    const axis = ballistixSlidesHorizontally(p) ? 'z' : 'x';
    if (Math.abs(pl[axis]) > 0x500) pl[axis] -= Math.sign(pl[axis]) * 0x20;
  } else if (beach && pl.score <= 0) {
    enterDie(w, d, p);
  } else if (beach && d.beachDecidedAt !== undefined) {
    pl.st = 0x22;
    // FUN_80089fa4 / FUN_8008a200: opening 30 ticks, character voice,
    // then a 30-tick announcer pause before the result flag.
    d.beachResultAt = d.f + 63 + BEACH_WIN_VOICE_TICKS[pl.character];
  } else {
    const taunting = previous === 0x1e && d.f - pl.stateAt < TAUNT_POSE_TICKS[pl.character];
    pl.st = pl.vel !== 0 ? 0x1d : taunting ? 0x1e : 0x1c;
    if (previous === 0x1c && edgeC) {
      pl.st = 0x1e;
      if (rnd(w, 3) === 0 || !cpu) emit(w, 'taunt', pl.x / BD_U, -pl.z / BD_U, p, 1, TAUNT_VOICES[pl.character ?? 1]);
    } else if (edgeB) { pl.st = 0x21; pl.hold = 0x96; pl.kfr = 0; }
    else if (edgeA) {
      if (pl.kcd === 0) { pl.st = 0x1f; pl.kfr = 0; pl.kpen = Math.min(pl.kpen + 0x1e, 0x5a); pl.kcd = pl.kpen; emit(w, 'kick', pl.x / BD_U, -pl.z / BD_U, p, 1); emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, KICK_SFX[p]); }
    }
  }
  if (pl.st !== previous) {
    pl.stateAt = d.f;
    pl.idleAt = -1;
    if (pl.st === 0x1c) pl.idleT = rnd(w, 150) + 180;
  } else if (!beach && pl.st === 0x1c) {
    if ((pl.idleAt ?? -1) >= 0) {
      if (d.f - pl.idleAt >= IDLE_POSE_TICKS[pl.character]) pl.idleAt = -1;
    } else if ((pl.idleT ?? 0) > 0) pl.idleT--;
    else {
      pl.idleAt = d.f;
      pl.idleT = rnd(w, 600) + 300;
    }
  }
  // --- apply motion (FUN_800b5c30 / b5ec8)
  const sm = w.params.speed;
  if (sky) {
    pl.skyFloor = ballistixFloor(d.tilt, pl.x, pl.z);
    const sgn = (p === 0 || p === 2) ? -1 : 1;
    pl.ang = (pl.ang + sgn * Math.trunc(pl.vel * sm)) & 4095;
    pl.face = pl.ang;
  } else if (pl.vel !== 0) {
    if (ballistixSlidesHorizontally(p)) pl.x += Math.trunc(pl.vel * sm); else pl.z += Math.trunc(pl.vel * sm);
    bump(d, pl, p);
  }
  // The ship body bobs in a 64-frame cycle. Its roll eases towards the motion or idle target.
  const bob = sinq((d.f + p) * 0x40);
  const signedVel = (p === 0 || p === 2) ? -pl.vel : pl.vel;
  const settling = beach && (pl.score <= 0 || d.beachDecidedAt !== undefined);
  const targetRoll = signedVel || (settling ? 0 : (bob * 0x11) >> 10);
  pl.y = settling ? -128 : -128 + ((bob * 15) >> 11);
  pl.roll = (pl.roll ?? 0) + (adiff(pl.roll ?? 0, targetRoll) >> 2);
  pl.last = pl.vel;
  if (beach ? pl.score > 0 : pl.dead === 0) shipBalls(w, d, p, pl.vel);
  bump(d, pl, p); // The seat update finishes with the stage's bumper callback.
}

/** FUN_80089be8: the sinking hull emits three puffs on the shared RNG stream. */
function beachSmokeFrame(w: World, d: Data, pl: Pl, puffs: BeachSmoke[]) {
  const y = -24 * (d.f - pl.stateAt);
  if (y < -0xa00) {
    delete pl.beachSmoke;
    return;
  }
  for (const puff of puffs) {
    if (puff.age >= 0) {
      puff.vy = Math.min(48, puff.vy + 4);
      puff.y += puff.vy;
      puff.age++;
      if (puff.y > 0 || 0x100 + 0x60 * puff.age > 0xfff) {
        puff.wait = rnd(w, 10) + 2;
        puff.age = -1;
      }
    } else if (puff.wait > 0) puff.wait--;
    else {
      rnd(w, 0x800); // heading is cosmetic, but the draw precedes later seat callbacks
      puff.age = 0;
      puff.y = y;
      puff.vy = -64;
    }
  }
}

function enterDie(w: World, d: Data, p: number) {
  const pl = d.pl[p];
  const beach = d.variant === 'beach';
  if (!beach) {
    releaseBalls(w, d, p, false);
    pl.vel = 0;
  }
  pl.st = 0x24; pl.stateAt = d.f; pl.dieT = beach ? 61 : 60; pl.dead ||= d.f;
  if (!d.walls) emit(w, 'sfx', 0, 0, -1, 1, 1425); // goal wall closes (0x591/0x592)
  const wall = [1, 2, 8, 4][p];
  if (beach) (d.beachPoolEffects ??= []).push({ beachPoolSlot: beachAllocSlot(d), wall });
  d.walls |= wall;
  pl.shield = 0;
  emit(w, 'ko', pl.x / BD_U, -pl.z / BD_U, p, 1);
}

function finishDie(w: World, d: Data, pl: Pl, p: number) {
  pl.st = 0x25;
  emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1414);
  emit(w, 'gone', pl.x / BD_U, -pl.z / BD_U, p, -(pl.y ?? -128) / BD_U);
  if (d.variant !== 'beach') return;
  pl.roll = 0;
  // Pack 0762 script 0 returns its entity after 23 updates.
  (d.beachPoolEffects ??= []).push({ beachPoolSlot: beachAllocSlot(d), releaseAt: d.f + 23 });
  // FUN_800898ec: three smoke delays and a choice of knockout sound.
  pl.beachSmoke = [0, 3, 6].map(offset => ({ wait: rnd(w, 10) + offset, age: -1, y: 0, vy: 0 }));
  emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 451 + rnd(w, 2));
}

/** push a ship out of the corner bumpers (FUN_800b42f4); true when it was pushed */
function bump(d: Data, pl: Pl, p: number): boolean {
  const sky = isSky(d);
  if (sky) {
    pl.x = (sinq(pl.ang) * 9) >> 4;
    pl.z = (cosq(pl.ang) * 9) >> 4;
  }
  for (const [cx, cz, cr] of bumpers(d)) {
    const R = cr + 345; // All four ship transforms carry the 0x40 collision flag.
    const dx = pl.x - cx, dz = pl.z - cz;
    if (dx * dx + dz * dz < R * R) {
      const a = discAngle(-dx, -dz);
      if (ballistixSlidesHorizontally(p)) pl.x = cx - ((R * sinq(a)) >> 12);
      if (!ballistixSlidesHorizontally(p)) pl.z = cz - ((R * cosq(a)) >> 12);
      if (sky) {
        pl.ang = discAngle(pl.x, pl.z);
        pl.x = (sinq(pl.ang) * 9) >> 4; pl.z = (cosq(pl.ang) * 9) >> 4;
        pl.face = pl.ang;
      }
      return true;
    }
  }
  return false;
}

function kickUpdate(w: World, d: Data, p: number) {
  const pl = d.pl[p];
  const reach = ((pl.kfr * 0x600 + 0x1000) & 0xffff) >> 3;
  if (kickBalls(w, d, p, reach)) pl.kcd = 0;
  pl.kfr++;
  if (pl.kfr > 3) pl.st = 0x1c;
}

/** FUN_800befd4 */
function kickBalls(w: World, d: Data, p: number, reach: number): boolean {
  const pl = d.pl[p];
  const radius = BALL_MARKER_RADIUS * w.params.ballScale + reach;
  let hit = false;
  for (let i = d.balls.length - 1; i >= 0; i--) {
    const b = d.balls[i];
    if (b.st !== 1 && b.st !== 8) continue;
    // Older land and Sky snapshots recorded an active kick lockout in hcd.
    if ((b.beachKickCd ?? (d.variant === 'beach' ? 0 : b.hcd)) !== 0) continue;
    const dx = b.x - pl.x, dz = b.z - pl.z;
    const dist2 = dx * dx + dz * dz;
    if (dist2 >= radius * radius) continue;
    const dist = ps1SqrtQ6(dist2) >> 6;
    if (dist >= radius) continue;
    const a = discAngle(-dx, -dz);
    const push = radius - dist + 1;
    b.x -= (push * sinq(a)) >> 12; b.z -= (push * cosq(a)) >> 12;
    b.who = p; b.h = a; b.beachKickCd = 4;
    emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, p, 1, 1413);
    emit(w, 'hit', b.x / BD_U, -b.z / BD_U, -1, 1.4, p);
    const old = b.tgt;
    b.tgt = d.variant === 'beach' ? 0x40 : isSky(d) ? 0x80 : 0x90;
    b.spd = old + 0x40;
    hit = true;
  }
  return hit;
}

function catchUpdate(w: World, d: Data, p: number, bHeld: boolean, cpu: boolean) {
  const pl = d.pl[p];
  pl.kfr++;
  if (pl.hold === 0) { releaseBalls(w, d, p, false); pl.st = 0x1c; return; }
  pl.hold--;
  if (pl.hold > 0x90) return;
  if (bHeld) { pl.arm = 2; return; }
  if (!cpu || pl.arm === 0) { releaseBalls(w, d, p, true); pl.st = 0x1c; }
}

const catchAngle = (pl: Pl, h: number) => Math.max(-0x220, Math.min(0x220, adiff(pl.face, h)));

/** The hull's forward sphere and release marker share the ship's yaw and roll. */
function hullPoint(pl: Pl, x: number, y: number, z: number) {
  const sr = sinq(pl.roll ?? 0), cr = cosq(pl.roll ?? 0);
  const sin = sinq(pl.face), cos = cosq(pl.face);
  return {
    x: pl.x + ((x * ((cr * cos) >> 12) - y * ((sr * cos) >> 12) + z * sin) >> 12),
    y: (pl.y ?? -128) + ((x * sr + y * cr) >> 12),
    z: pl.z + ((x * ((-cr * sin) >> 12) + y * ((sr * sin) >> 12) + z * cos) >> 12),
  };
}

/** FUN_800bb674: let go of the balls this ship holds */
function releaseBalls(w: World, d: Data, p: number, fast: boolean) {
  const pl = d.pl[p];
  const marker = hullPoint(pl, 0, 2, 145); // marker 4 of 0766/part3
  for (const b of d.variant === 'beach' ? d.balls.slice().reverse() : d.balls) {
    if (b.st !== 2 || b.who !== p) continue;
    const sp = fast ? 0xe0 : 0x30;
    b.spd = sp; b.tgt = sp;
    const heading = discAngle(marker.x - b.x, marker.z - b.z);
    b.h = (pl.face + catchAngle(pl, heading)) & 4095;
    b.x -= (b.spd * sinq(b.h)) >> 12; b.z -= (b.spd * cosq(b.h)) >> 12;
    b.st = 1;
    if (fast) emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1459 + p);
    emit(w, 'launch', b.x / BD_U, -b.z / BD_U, p, fast ? 1 : 0);
  }
}

/** FUN_800be4d4 uses a per-seat sphere offset even on the rotating Sky platform. */
function shipBalls(w: World, d: Data, p: number, velocity: number) {
  const pl = d.pl[p];
  const rb = 345 * w.params.playerScale, rf = 414 * w.params.playerScale;
  const BR = BALL_MARKER_RADIUS * w.params.ballScale;
  const [fx, fz] = SHIP_FRONT_OFFSET[p];
  const catching = pl.st === 0x21;
  for (let i = d.balls.length - 1; i >= 0; i--) {
    const b = d.balls[i];
    if (b.st === -1 || b.y <= -626 || b.y >= 625) continue;
    if (b.st === 2) {
      if (b.who === p) { // held ball rides on the front sphere
        const a = catchAngle(pl, b.h);
        const R = BR + rf;
        const at = hullPoint(pl, 2 - (R * sinq(a) >> 12), 0, 132 - (R * cosq(a) >> 12));
        b.x = at.x; b.y = at.y; b.z = at.z;
      }
      continue;
    }
    const to = discAngle(
      pl.x + ((-67 * sinq(pl.face)) >> 12) - (b.prevX ?? b.x),
      pl.z + ((-67 * cosq(pl.face)) >> 12) - (b.prevZ ?? b.z),
    );
    const front = aabs(pl.face, to) < 0x38f;
    const cx = pl.x + (front ? fx : 0), cz = pl.z + (front ? fz : 0);
    const r = (front ? rf + (catching ? 0x80 : 0) : rb) + BR;
    const dx = b.x - cx, dz = b.z - cz;
    const dist2 = dx * dx + dz * dz;
    if (dist2 >= r * r || (ps1SqrtQ6(dist2) >> 6) >= r) continue;
    // move the ball back along its path to the sphere surface (FUN_800be1c4)
    discPushOut(b, cx, cz, r + 8, b.h);
    const n = discAngle(cx - b.x, cz - b.z);
    b.who = p;
    if (front && catching) {
      b.h = n; b.spd = 0; b.tgt = 0; b.st = 2;
      emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1455 + p);
      emit(w, 'catch', b.x / BD_U, -b.z / BD_U, p, 1);
      continue;
    }
    emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, p, 1, HIT_SFX[rnd(w, 4)]);
    const lv = Math.abs(velocity);
    const T = (b.h + 0x800) & 4095;
    const vx = ((b.spd * sinq(n)) >> 12) + ((lv * sinq(pl.face)) >> 12);
    const vz = ((b.spd * cosq(n)) >> 12) + ((lv * cosq(pl.face)) >> 12);
    const va = discAngle(vx, vz);
    const D = adiff(T, va);
    let nh: number;
    if (Math.abs(D) <= 0x400) nh = va + Math.max(-0x3f0, Math.min(0x3f0, D));
    else {
      nh = discAngle(((b.spd * sinq(va)) >> 12) + ((lv * sinq(pl.face)) >> 12),
        ((b.spd * cosq(va)) >> 12) + ((lv * cosq(pl.face)) >> 12));
    }
    b.h = nh & 4095;
    if (lv !== 0) { b.spd += lv; if (b.spd > b.tgt + 0x40) b.spd = b.tgt + 0x40; }
    if (b.hcd === 0 && b.tgt < 0x90) b.tgt += 4;
    emit(w, 'hit', b.x / BD_U, -b.z / BD_U, -1, Math.min(1.5, 0.3 + lv / 100), p);
  }
}

/** FUN_800be1c4 keeps axis-aligned z shots in place and quantizes the other pushbacks to Q8. */
function discPushOut(b: Ball, cx: number, cz: number, radius: number, h: number) {
  const dx = -(sinq(h + 0x800) >> 3), dz = -(cosq(h + 0x800) >> 3);
  if (dx === 0) return;
  const x = b.x + dx, z = b.z + dz;
  const rx = cx - x, rz = cz - z;
  const a = (dx * dx + dz * dz) >> 4;
  const dot = (2 * (dx * rx + dz * rz)) >> 4;
  const c = (rx * rx + rz * rz - Math.floor(radius * radius)) >> 4;
  const disc = dot * dot - 4 * a * c;
  if (disc < 0) return;
  // Giant Balls can exceed the range of the disc's signed 32-bit distance math.
  const root = disc > 0x7fffffff ? Math.floor(Math.sqrt(disc)) : ps1SqrtQ6(disc) >> 6;
  const near = Math.trunc(((-dot - root) * 256) / (2 * a));
  const far = Math.trunc(((-dot + root) * 256) / (2 * a));
  const t = near >= 0 ? near : far;
  if (t < 0) return;
  b.x = x - ((dx * t) >> 8);
  b.z = z - ((dz * t) >> 8);
}

/** FUN_800bf2bc: a force field repels every rolling ball within 0x859 of its ship */
function pushShields(w: World, d: Data) {
  for (let p = 0; p < MAX_SEATS; p++) {
    const pl = d.pl[p];
    if (pl.shield <= 0) continue;
    if (pl.dead) { pl.shield = 0; continue; }
    pl.shield--;
    if (pl.shield === 0) { emit(w, 'shield', pl.x / BD_U, -pl.z / BD_U, p, 0); emit(w, 'sfx', 0, 0, p, 1, 1496); continue; }
    const R = 0x800 + 0x59;
    for (const b of d.balls) {
      if (b.st !== 1) continue;
      const dx = b.x - pl.x, dz = b.z - pl.z;
      const dd = dx * dx + dz * dz;
      if (dd < R * R) { b.pshA = atan(-dx, -dz); b.psh = (R - Math.trunc(Math.sqrt(dd))) >> 4; }
    }
  }
  // power-up pickup (FUN_800bdab8)
  if (d.variant === 'nballism' && d.post) {
    const [cx, cz, cr] = bumpers(d)[d.post.i];
    for (let p = 0; p < MAX_SEATS; p++) {
      const pl = d.pl[p];
      if (pl.dead) continue;
      const R = cr + 345 + 0x40; // 800bdab8 reads the ship's flagged body radius.
      const dx = pl.x - cx, dz = pl.z - cz;
      if (dx * dx + dz * dz < R * R) {
        pl.shield = 0xf0;
        emit(w, 'pickup', cx / BD_U, -cz / BD_U, p, 1);
        emit(w, 'shield', pl.x / BD_U, -pl.z / BD_U, p, 1);
        emit(w, 'sfx', 0, 0, p, 1, 1498); // 0x5da
        d.post = null;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- balls (FUN_800b9e54)
function wallNormal(walls: number, b: Ball): number {
  let n = -1;
  if (b.x > 2048 && (walls & 8)) { b.x = 2048; n = 0x400; }
  if (b.x < -2048 && (walls & 4)) { b.x = -2048; n = 0xc00; }
  if (b.z > 2048 && (walls & 2)) { b.z = 2048; n = 0; }
  if (b.z < -2048 && (walls & 1)) { b.z = -2048; n = 0x800; }
  return n;
}

/** 800b4880 checks a closed goal after all bumpers; Sky's 800b4ae8 checks after each bumper. */
function circleHit(w: World, d: Data, b: Ball, BR: number): number {
  const sky = isSky(d);
  let n = -1;
  const corners = bumpers(d);
  for (let i = 0; i < corners.length; i++) {
    const [cx, cz, cr] = corners[i];
    const radius = cr + BR, dx = b.x - cx, dz = b.z - cz;
    if (dx * dx + dz * dz < radius * radius) {
      discPushOut(b, cx, cz, radius, b.h);
      n = discAngle(cx - b.x, cz - b.z);
      if (d.variant === 'crashball') {
        d.bumperHitAt ??= [-3, -3, -3, -3];
        d.bumperHitAt[i] = d.f;
      }
      if (!sky) return n;
    }
    if (sky && d.walls) {
      const wall = wallNormal(d.walls, b);
      if (wall !== -1) n = wall;
      if (n !== -1) {
        if (d.skyWallSoundDelay) d.skyWallSoundDelay--;
        else { emit(w, 'sfx', 0, 0, -1, 1, 1426); d.skyWallSoundDelay = 3; }
      }
    }
  }
  if (!sky && d.walls) {
    n = wallNormal(d.walls, b);
    if (n !== -1) emit(w, 'sfx', 0, 0, -1, 1, 1426);
  }
  return n;
}

/** goal line test (FUN_800c0a74 / FUN_800b4d9c); returns the conceding player or -1 */
function goalSide(d: Data, b: Ball, far: boolean, clampBall?: Ball): number {
  if (isSky(d)) {
    const r = far ? 0xc00 : 0x980;
    if (r * r < b.x * b.x + b.z * b.z) {
      const q = (atan(-b.x, -b.z) + 0x200) & 0xc00;
      return q === 0x400 ? 3 : q === 0x800 ? 1 : q === 0xc00 ? 2 : 0;
    }
    if (clampBall) clampMouth(clampBall);
    return -1;
  }
  const t = far ? 0xb80 : 0xa00;
  if (b.x > t) return 2;
  if (b.x < -t) return 3;
  if (b.z > t) return 1;
  if (b.z < -t) return 0;
  if (clampBall) clampMouth(clampBall);
  return -1;
}

/** while a ball sinks into a goal it may not leave the mouth sideways (0x600) */
function clampMouth(b: Ball) {
  if (b.who === 0 || b.who === 1) b.x = Math.max(-0x600, Math.min(0x600, b.x));
  else b.z = Math.max(-0x600, Math.min(0x600, b.z));
}

function ballFrame(w: World, d: Data, b: Ball) {
  const BR = 128 * w.params.ballScale;
  const sm = w.params.speed;
  const beach = d.variant === 'beach';
  b.prevX = b.x; b.prevZ = b.z;
  if (b.st === 0) {
    spawnWait(w, d, b);
    ballContact(w, d, b);
    return;
  }
  if (b.st === 0x12) { scoreBall(w, d, b); return; }
  const fadingInGoal = b.st === 0x11 && b.tm === 0;
  // speed towards target, then move
  if (b.spd < b.tgt) { b.spd += b.acc; if (b.tgt < b.spd) b.spd = b.tgt; }
  else if (b.tgt < b.spd) { b.spd -= b.dec; if (b.spd < b.tgt) b.spd = b.tgt; }
  const dxm = (b.spd * sinq(b.h)) >> 12, dzm = (b.spd * cosq(b.h)) >> 12;
  b.x -= sm === 1 ? dxm : Math.trunc(dxm * sm); b.z -= sm === 1 ? dzm : Math.trunc(dzm * sm);
  if (b.hcd > 0) b.hcd--;
  if (b.beachKickCd) b.beachKickCd--;
  const sky = isSky(d);
  switch (b.st) {
    case 0xc:
      if (b.tm === 0) launch(w, d, b); else b.tm--;
      break;
    case 6:
    case 8: {
      if (b.st === 6 && inClear(d, b, BR)) { b.h = b.pshA; b.pshA = 0; b.st = 8; }
      const down = vertical(w, d, b);
      if (down && (b.fl & 0x400)) {
        const n = circleHit(w, d, b, BR);
        if (n !== -1) bounce(w, d, b, n);
        const g = goalSide(d, b, false);
        if (g !== -1) goal(w, d, b, g, 4);
      }
      break;
    }
    case 1: {
      if (!sky) b.y = -96;
      const n = circleHit(w, d, b, BR);
      if (n !== -1) bounce(w, d, b, n);
      const g = goalSide(d, b, false);
      if (g !== -1) goal(w, d, b, g, 8);
      else applyPush(d, b);
      break;
    }
    case 2:
      if (beach) b.fl |= BEACH_CAUGHT;
      separateHeldBall(w, d, b, BR);
      break;
    case 4:
    case 0x11: {
      if (b.tm === 0) b.sink += 0x200;
      else { b.tm--; if (b.tm === 0) b.sink = 0x400; }
      if (b.st === 4) {
        if (!sky) { b.spd >>= 1; b.tgt >>= 1; }
        b.vv += b.vup - b.vdn; if (b.vv < 0) b.vv = 0; if (b.vv > b.vmax) b.vv = b.vmax;
        b.y += b.vv;
      }
      const g = goalSide(d, b, true, b);
      if (beach && g !== -1) b.who = g;
      if (g !== -1 || b.sink > 0xfff) b.st = 0x12;
      break;
    }
    case 99: {
      const r = goalSide(d, b, false);
      if (r === -1) { b.st = 1; break; }
      b.h = atan(-b.x, -b.z);
      const far = goalSide(d, b, true);
      if (far !== -1 || b.tm === 0) { b.st = 4; b.tm = 0; b.vv = 0x20; b.vmax = 0x60; b.vup = 6; b.vdn = 0; }
      else b.tm--;
      break;
    }
  }
  b.psh = 0;
  // ball against ball (FUN_800bf640)
  if (b.st !== 2 && b.st !== 4 && b.st !== 0x12 && b.st !== 99) ballContact(w, d, b);
  // FUN_800b9e54 records a floor point after the first landing and displays the six previous samples.
  if (d.variant === 'crashball') {
    if (!fadingInGoal && (b.st === 1 || (b.land && (b.st === 8 || b.st === 0x11)))) {
      const trail = b.trail ??= [];
      trail.unshift([b.x, b.z]);
      if (trail.length > BD_TRAIL_LENGTH + 1) trail.pop();
    } else if (b.trail) b.trail = undefined;
  }
}

/** FUN_800bb924: balls held at the bumper avoid corner obstacles and spread out around the capture ring. */
function separateHeldBall(w: World, d: Data, b: Ball, radius: number) {
  const pl = d.pl[b.who];
  if (!pl) return;
  const marker = hullPoint(pl, 0, 2, 145);
  for (const [x, z, r] of bumpers(d)) {
    const dx = b.x - x, dz = b.z - z, limit = r + radius;
    if (dx * dx + dz * dz >= limit * limit) continue;
    const angle = discAngle(-dx, -dz);
    discPushOut(b, x, z, limit, angle);
    b.h = discAngle(marker.x - b.x, marker.z - b.z);
  }
  for (const other of d.variant === 'beach' ? d.balls.slice().reverse() : d.balls) {
    if (other === b || other.st !== 2) continue;
    const dx = other.x - b.x, dz = other.z - b.z;
    if (dx * dx + dz * dz >= (radius * 2) ** 2) continue;
    const a = discAngle(marker.x - b.x, marker.z - b.z), c = discAngle(marker.x - other.x, marker.z - other.z);
    const delta = adiff(a, c);
    const split = ((0xe3 - Math.abs(delta)) >> 1) * (delta < 0 ? 1 : -1);
    b.h = (a + split) & 4095;
    other.h = (c - split) & 4095;
  }
}

function spawnWait(w: World, d: Data, b: Ball) {
  if (b.firstServeAt !== undefined) {
    if (d.f < b.firstServeAt) return;
    delete b.firstServeAt;
  }
  if (d.variant === 'beach') {
    if (d.beachResultAt !== undefined && d.f > d.beachResultAt) {
      b.x = b.y = b.z = 0x2000;
      return;
    }
  } else if (living(d) <= 1) return;
  let c: number;
  if (d.last >= 0 && d.last < 4) c = SPAWN_AFTER[d.last][rnd(w, 2)]; else c = rnd(w, 4);
  if (d.cool[c] > 0) return;
  d.last = -1;
  const sp = SPAWNS[d.variant][c];
  b.x = sp[0]; b.z = sp[1];
  b.y = d.variant === 'nballism' || isSky(d) ? SPAWN_Y[d.variant] : -32;
  d.cool[c] = 0x1f; b.corner = c;
  b.tm = 0xf; b.st = 0xc;
}

function launch(w: World, d: Data, b: Ball) {
  const a = atan(b.x, b.z);
  b.h = a; b.pshA = (a + rnd(w, 0x1c7) - 0xe3) & 4095;
  b.acc = 4; b.dec = 1; b.psh = 0; b.beachKickCd = 20;
  emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, -1, 1, 1440);
  emit(w, 'spawn', b.x / BD_U, -b.z / BD_U, -1, 1);
  b.st = 6; b.spd = 0x20; b.who = -1; b.fl = 0; b.land = false;
  const y0 = SPAWN_Y[d.variant];
  b.y = y0;
  switch (d.variant) {
    case 'nballism': b.tgt = 0x50; b.vv = 0x10; b.vmax = 0x60; b.vup = 3; b.vdn = 0; b.vdir = 0; break;
    case 'sky': b.tgt = 0x50; b.spd = 0x50; b.vv = 0x40; b.vmax = 0x50; b.vup = 6; b.vdn = 0; b.vdir = 0; break;
    case 'beach': b.tgt = 0x30; b.vv = 0x30; b.vmax = 0x60; b.vup = 0; b.vdn = 6; b.vdir = 1; break;
    default: b.tgt = 0x50; b.vv = 0x30; b.vmax = 0x60; b.vup = 0; b.vdn = 6; b.vdir = 1; break;
  }
}

/** FUN_800b4efc: true while the ball is still inside a bumper or outside the box */
function inClear(d: Data, b: Ball, BR: number): boolean {
  for (const [cx, cz, cr] of bumpers(d)) {
    const R = cr + BR;
    if ((b.x - cx) * (b.x - cx) + (b.z - cz) * (b.z - cz) < R * R) return false;
  }
  if (isSky(d)) return b.x * b.x + b.z * b.z < 0x900 * 0x900;
  return !(b.x > 0x900 || b.x < -0x900 || b.z > 0x900 || b.z < -0x900);
}

/** vertical bounce of states 6 and 8 */
function vertical(w: World, d: Data, b: Ball): boolean {
  b.vv += b.vup - b.vdn;
  if (b.vv < 0) b.vv = 0;
  if (b.vv > b.vmax) b.vv = b.vmax;
  b.y += b.vdir === 0 ? b.vv : -b.vv;
  if (b.vv === 0) { const t = b.vdn; b.vdn = 0; b.vdir = 0; b.vup = t; }
  if (b.vdir !== 0) return false;
  {
    if (b.y >= -96) {
      b.y = -96; b.fl |= 0x400;
      if (!b.land) { b.land = true; emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, -1, 1, LAND_SFX[rnd(w, 4)]); }
      b.vv = d.variant === 'nballism' ? b.vv >> 2 : b.vv >> 1;
      const t = b.vup; b.vup = 0; b.vdir = 1; b.vdn = t;
      if (b.vv < 8) { b.st = 1; b.fl |= 0x400; }
    }
  }
  return true;
}

function bounce(w: World, d: Data, b: Ball, n: number) {
  let D = adiff((b.h + 0x800) & 4095, n);
  if (Math.abs(D) < 8) D = rnd(w, 0x10) + 8;
  b.h = (n + D) & 4095;
  emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, -1, 1, BOUNCE_SFX[rnd(w, 6)]);
  emit(w, 'bounce', b.x / BD_U, -b.z / BD_U, -1, 0.4);
}

/** FUN_800bb41c: shield push bends the heading */
function applyPush(d: Data, b: Ball) {
  if (d.tilt) {
    // FUN_800bb41c, Sky Balls: the disc's tilt replaces the push with a downhill pull (it only bends the heading)
    const [tx, tz] = d.tilt;
    const i3 = Math.abs((sinq(tx) * 5) >> 3), i4 = Math.abs((sinq(tz) * 5) >> 3);
    const u5 = tx < 0 ? 0x800 : 0, i6 = tz < 0 ? 0x400 : tz > 0 ? 0xc00 : 0;
    b.pshA = atan(((i3 * sinq(u5)) >> 12) + ((i4 * sinq(i6)) >> 12), ((i3 * cosq(u5)) >> 12) + ((i4 * cosq(i6)) >> 12));
    b.psh = (i3 + i4) >> 6;
  }
  if (b.psh === 0) return;
  const vx = ((b.spd * sinq(b.h)) >> 12) + ((b.psh * sinq(b.pshA)) >> 12);
  const vz = ((b.spd * cosq(b.h)) >> 12) + ((b.psh * cosq(b.pshA)) >> 12);
  b.h = atan(vx, vz);
}

/** Sky Balls platform: who the event goes to (0x800c19fc, the 4-player table: never player 1) */
const SKY_EV_SLOT = [1, 2, 3, 2, 3, 1, 3, 1, 2, 1, 2, 3, 2, 3, 1, 3, 1, 2];

/** FUN_800bc0d8 (sky part) + FUN_800bd43c + FUN_800bd510 + the tilt sum of FUN_800bca38 */
function skyPlatform(w: World, d: Data, sk: NonNullable<Data['sky']>, serveEvents = true) {
  if (serveEvents && sk.t === 0) {
    sk.i = sk.i + 1 > 0x11 ? 0 : sk.i + 1;
    const p = SKY_EV_SLOT[sk.i], e = sk.ev[p];
    // FUN_800bd43c: the disc lurches towards that player for 60..89 frames, then rocks back to level
    e.tm = rnd(w, 0x1e) + 0x3c; e.st = 1; e.an = 0xa0; e.max = 0x300; e.vel = 0; e.ap = 0; e.dir = -1;
    emit(w, 'sfx', 0, 0, p, 1, 0x5c9);
    emit(w, 'sfx', 0, 0, p, 1, 0x5ca + rnd(w, 4));
    emit(w, 'tilt', 0, 0, p, 1);
    sk.t = rnd(w, 9) * 0x1e + 0x10e;
  } else if (serveEvents) sk.t--;
  // FUN_800bca38 draws the current offsets before FUN_800bd510 advances them.
  skyTiltState(d, sk);
  for (const e of sk.ev) {
    if (e.tm !== 0) e.tm--;
    if (e.st === 2) { e.max = 0x300; e.dir = 0; e.ap = 4; e.an = 0; e.st = 3; }
    else if (e.st === 1) {
      if (e.tm === 0) e.st = 2;
      if (e.dir === -1) { if (e.pos < -0x1500) { e.dir = 0; e.ap = 0x60; e.an = 0; } }
      else {
        if (e.vel > 0) e.ap = 0x10;
        if (e.pos > -0x1300) { e.dir = -1; e.ap = 0; e.an = 0x40; }
      }
    } else if (e.st === 3) {
      if (e.dir === 0) {
        const a = e.ap; e.ap = a + 2;
        if (e.pos > 0) { e.an = a + 2; e.ap = 0; e.dir = -1; e.max >>= 1; }
      } else {
        const a = e.an; e.an = a + 2;
        if (e.pos < 0) {
          if (e.max > 0x40) { e.ap = a + 2; e.an = 0; e.dir = 0; e.max >>= 1; }
          else { e.pos = 0; e.vel = 0; e.ap = 0; e.an = 0; e.st = 0; }
        }
      }
    }
    e.vel = e.vel + e.ap - e.an;
    if (e.max < e.vel) e.vel = e.max;
    if (e.vel < -e.max) e.vel = -e.max;
    e.pos += e.vel;
  }
}

function skyTiltState(d: Data, sk: NonNullable<Data['sky']>) {
  // FUN_800bca38: slow wobble and bob plus each player's lurch along its diagonal.
  const tilt = skyBaseTilt(d.f);
  sk.ev.forEach((e, p) => {
    if (e.pos === 0) return;
    const t = discAngle(0xa00, e.pos >> 4) - 0x400;
    tilt[0] += p === 1 || p === 2 ? t : -t;
    tilt[1] += p < 2 ? t : -t;
  });
  d.tilt = tilt;
}

function goal(w: World, d: Data, b: Ball, side: number, tm: number) {
  b.who = side;
  b.sink = 0;
  if (isSky(d)) { b.st = 99; b.tm = 0x10; return; }
  b.tm = tm === 4 ? 4 : 8;
  if (d.variant === 'crashball') { b.st = 0x11; return; }
  b.st = 4; b.vv = d.variant === 'beach' ? 0x80 : 0x60; b.vmax = 0x60; b.vup = 8; b.vdn = 0;
}

/** state 0x12 (FUN_800b9e54): the ball has crossed the goal line for good */
function scoreBall(w: World, d: Data, b: Ball) {
  const p = b.who;
  b.st = -1;
  if (p < 0 || p > 3) return;
  const pl = d.pl[p];
  if (pl.dead || pl.score <= 0 || d.beachDecidedAt !== undefined) return;
  d.last = p;
  emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, SIDE_SFX[p]);
  pl.score--;
  if (pl.score === 0 && d.variant === 'beach') {
    pl.dead = d.f;
    if (d.beachSpectatorTarget === p) d.beachSpectatorTarget = -1;
  }
  emit(w, 'goal', b.x / BD_U, -b.z / BD_U, p, 1, -1);
}

/** FUN_800bf640, tests ball markers in newest-first order, including balls still waiting or falling. */
function ballContact(w: World, d: Data, a: Ball) {
  const r = BALL_MARKER_RADIUS * w.params.ballScale;
  for (let i = d.balls.length - 1; i >= 0; i--) {
    const other = d.balls[i];
    if (other === a || other.st === -1 || Math.abs(other.y - a.y) >= BALL_MARKER_HEIGHT) continue;
    const hit = resolveContact(a, 2 * r, other);
    if (hit) {
      emit(w, 'sfx', a.x / BD_U, -a.z / BD_U, -1, 1, 1408);
      if (a.fl & BEACH_CAUGHT) return;
    }
  }
  // N.Gin is the oldest entity on the list. Its stationary marker has radius
  // 460 and vertical bounds -523..110. It reflects the ball silently.
  if (d.mach && d.mach.st >= 3 && a.y > -651 && a.y < 237) resolveContact(a, r + 460);
}

function resolveContact(a: Ball, radius: number, other?: Ball): boolean {
  const dx = a.x - (other?.x ?? 0), dz = a.z - (other?.z ?? 0);
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= radius * radius) return false;
  const distance = ps1SqrtQ6(distanceSq) >> 6;
  if (distance >= radius) return false;
  const normal = discAngle(dx, dz);
  const opposite = (normal + 0x800) & 4095;
  const overlap = radius - distance + 1;
  let reflected = a;
  if (other && (a.fl & BEACH_CAUGHT)) {
    other.x -= (overlap * sinq(normal)) >> 12;
    other.z -= (overlap * cosq(normal)) >> 12;
    reflected = other;
  } else {
    const push = overlap > radius / 2 ? radius : overlap;
    a.x += (push * sinq(normal)) >> 12;
    a.z += (push * cosq(normal)) >> 12;
    if (other && !(other.fl & BEACH_CAUGHT)) {
      other.h = normal;
      a.spd = other.spd = Math.trunc((a.spd + other.spd) / 2);
    }
  }
  reflected.h = (opposite + adiff((reflected.h + 0x800) & 4095, opposite)) & 4095;
  return true;
}

// ---------------------------------------------------------------- Beach Ball CPU (FUN_800b8a68, four-seat party mode)
// Attack aims at the goal mouth. Defence predicts against the wider line in front of it.
const BEACH_GOALS = [[-1280, -2048, 1280, -2048], [-1280, 2048, 1280, 2048],
  [2048, -1280, 2048, 1280], [-2048, -1280, -2048, 1280]];
// Opponent order from 0x800c19c0, indexed here by the defending seat.
const BEACH_BIAS_ORDER = [[3, 1, 2], [2, 0, 3], [0, 3, 1], [1, 2, 0]];

function beachSkill(d: Data, slot: number): number {
  if (d.beachSpectatorTarget !== undefined &&
      (d.beachSpectatorTarget !== -1 || d.beachDecidedAt !== undefined)) {
    return slot === d.beachSpectatorTarget ? 0 : 32;
  }
  return d.pl[slot].skill ?? BOT_SKILLS.beach[2];
}



/** FUN_800b7c60 / FUN_800b808c: intersect two segments in 16 u steps, then interpolate on the goal line. */
function beachRay(d: Data, slot: number, b: Ball, heading: number, goal: boolean, draw: (n: number) => number) {
  const skill = beachSkill(d, slot);
  const win = WIN[Math.max(0, 0x20 - skill - d.off)];
  const h = heading + draw(win) - win;
  const x2 = b.x - sinq(h), z2 = b.z - cosq(h);
  const [lx, lz, rx, rz] = (goal ? BEACH_GOALS : LINES)[slot];
  if (Math.max(b.x, x2) < lx || rx < Math.min(b.x, x2) ||
      Math.max(b.z, z2) < lz || rz < Math.min(b.z, z2)) return null;
  const dx = (b.x - x2) >> 4, dz = (b.z - z2) >> 4;
  const px = (lx - b.x) >> 4, pz = (lz - b.z) >> 4;
  const sx = (rx - lx) >> 4, sz = (rz - lz) >> 4;
  const den = sz * dx - sx * dz;
  if (den === 0) return null;
  const alongLine = (dz * px - dx * pz) / den;
  const alongBall = (sx * pz - sz * px) / den;
  if (alongLine < 0 || alongLine > 1 || alongBall < 0 || alongBall > 1) return null;
  const t = Math.trunc(alongLine * 256);
  return [lx + (((rx - lx) * t) >> 8), lz + (((rz - lz) * t) >> 8)];
}

function beachCpuPad(w: World, d: Data, slot: number): InputState {
  const pl = d.pl[slot];
  // The engine keeps calling the planner until the sinking hull is hidden.
  if ((pl.st === 0x25 && !pl.beachSmoke) || (d.beachResultAt !== undefined && d.f > d.beachResultAt)) return IDLE;
  const state = pl.beachCpu ??= {
    target: -1, roamX: 0, roamZ: 0, mode: 0, lapse: 0, catchT: 0, wait: 8,
  };
  // The engine reads the raw pad before this scene update. FUN_800b8a68 writes
  // the next raw pad while the ship consumes the pad already read this frame.
  const pad = state.nextPad ?? IDLE;
  const input: InputState = { ...IDLE };
  const draw = (n: number) => rnd(w, n);
  if (pl.arm > 0) pl.arm--;
  const skill = beachSkill(d, slot);
  const lateralX = ballistixSlidesHorizontally(slot);
  if (state.lapse > 0) state.lapse--;
  if (state.catchT > 0) state.catchT--;
  if (state.wait > 0) state.wait--;
  if (state.target === -1 && d.beachDecidedAt === undefined) {
    const rivals = d.pl.flatMap((p, i) => p.score > 0 && i !== slot ? [i] : []);
    if (rivals.length) {
      if (d.beachSpectatorTarget === undefined) state.target = rivals[draw(rivals.length * 16) >> 4];
      else {
        const weight = (p: number) => p === d.beachSpectatorTarget ? 32 : 4;
        let roll = draw(rivals.reduce((total, p) => total + weight(p), 0));
        state.target = rivals.find(p => (roll -= weight(p)) < 0) ?? -1;
      }
    }
  }

  // The disc prepends new balls to its linked list.
  const balls = d.balls.slice().reverse();
  let tx = pl.x, tz = pl.z, best = 0x7fffff;
  for (const b of balls) {
    if (b.st !== 1) continue;
    const hit = beachRay(d, slot, b, b.h, false, draw);
    if (!hit) continue;
    const dd = (b.x - hit[0]) ** 2 + (b.z - hit[1]) ** 2;
    if (dd < best) { best = dd; [tx, tz] = hit; }
  }
  const threat = best === 0x7fffff ? 0 : ps1SqrtQ6(best) >> 6;
  const bias = [-64, 0, 64][BEACH_BIAS_ORDER[slot].indexOf(state.target)] ?? 0;
  // The +x seat also applies its bias on x, the fixed axis of its slide.
  if (slot === 3) tz -= bias;
  else tx += slot === 0 ? bias : -bias;
  const angle = threat ? discAngle(tx - pl.x, tz - pl.z) : discAngle(state.roamX - pl.x, state.roamZ - pl.z);
  const steer = () => {
    const pad = PAD_BITS[(angle >> 9) & 7];
    if (lateralX) input.x = Number(!!(pad & 0x20)) - Number(!!(pad & 0x80));
    else input.y = Number(!!(pad & 0x40)) - Number(!!(pad & 0x10));
  };
  const close = balls.some(b => {
    const dx = pl.x - b.x, dz = pl.z - b.z;
    return dx * dx + dz * dz < 640 ** 2 && aabs(discAngle(dx, dz), pl.face) < 0x2aa;
  });
  if (state.catchT > 0) {
    if (close) input.b = true;
    else state.catchT = 0;
    if (state.catchT < 30) {
      for (const b of balls) {
        if (b.st !== 2 || b.who !== slot || state.target === -1) continue;
        const alternate = d.f & 3;
        if (beachRay(d, state.target, b, b.h, false, draw) ||
            (alternate !== slot && beachRay(d, alternate, b, b.h, false, draw))) {
          state.catchT = 0;
          state.target = -1;
          input.b = false;
        }
      }
    }
  }

  switch (state.mode) {
    case 3: { // defend
      const reach = Math.max(1, skill * 16 - d.off);
      const range = reach + draw(reach) + 256;
      if (state.catchT === 0) {
        const target = state.target;
        let blindKick = d.beachSpectatorTarget === undefined;
        if (target !== -1 && state.lapse === 0) {
          if (draw(24) > skill) state.lapse = ((32 - skill) >> 1) + 64;
          else blindKick = true;
        }
        const nearby = target !== -1 && pl.kcd === 0
          ? balls.filter(b => (pl.x - b.x) ** 2 + (pl.z - b.z) ** 2 < range * range)
          : [];
        const aimedKick = () => nearby.some(b => beachRay(d, target, b, discAngle(pl.x - b.x, pl.z - b.z), true, draw));
        if (aimedKick()) input.a = true;
        else {
          if (state.lapse > 0) state.lapse--;
          if (close) { state.catchT = 90; input.b = true; }
          else if (nearby.length) {
            // Party mode enables the blind fallback. The native check still rolls a second ray.
            input.a = aimedKick() || blindKick;
          }
        }
        if (input.a) state.target = -1;
      }
      if (threat === 0) state.mode = 1;
      else {
        const distance = Math.abs(lateralX ? pl.x - tx : pl.z - tz) + (skill + d.off) * 32;
        if (distance > 640) {
          if (threat < distance) input.r = true;
          steer();
        }
      }
      break;
    }
    case 4: // head to the roaming position
      if (threat) state.mode = 3;
      else if ((ps1SqrtQ6((pl.x - state.roamX) ** 2 + (pl.z - state.roamZ) ** 2) >> 6) > 0x7f) steer();
      else { state.wait = draw(60) + 30; state.mode = 5; }
      break;
    case 5:
      if (threat) state.mode = 3;
      else if (state.wait === 0) { state.mode = 0x15; input.c = true; }
      break;
    case 0x15:
      if (threat) state.mode = 3;
      else if (pl.st !== 0x1e) state.mode = 1;
      break;
    default:
      state.roamX = lateralX ? draw(1024) - 512 : pl.x;
      state.roamZ = lateralX ? pl.z : draw(1024) - 512;
      state.mode = 4;
  }
  state.nextPad = input;
  return pad;
}

// ---------------------------------------------------------------- AI for Crashball, N.Ballism and Sky Balls
/** intersection of a ball's predicted path (with the AI's aiming error) with a ship's defence segment (FUN_800b7c60) */
function predict(w: World, d: Data, slot: number, b: Ball, salt: number): [number, number] | null {
  let idx = (0x20 - (d.pl[slot].skill ?? BOT_SKILLS[d.variant][2])) - d.off;
  if (idx < 0) idx = 0;
  const win = WIN[idx];
  const err = Math.floor(hash(w.tick, slot, b.id, salt) * win) - win;
  const h = (b.h + err) & 4095;
  const ex = b.x - cosq(h - 0x400), ez = b.z - cosq(h);
  const [x1, z1, x2, z2] = LINES[slot];
  // segment (b -> e) against segment (l1 -> l2)
  const r = [ex - b.x, ez - b.z], s = [x2 - x1, z2 - z1];
  const den = r[0] * s[1] - r[1] * s[0];
  if (den === 0) return null;
  const qx = x1 - b.x, qz = z1 - b.z;
  const t = (qx * s[1] - qz * s[0]) / den, u = (qx * r[1] - qz * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [b.x + r[0] * t, b.z + r[1] * t];
}

function botInput(w: World, d: Data, slot: number): InputState {
  const pl = d.pl[slot];
  const out: InputState = { x: 0, y: 0, a: false, b: false };
  if (!pl || pl.score <= 0 || pl.st >= 0x24) return out;
  const skill = pl.skill ?? BOT_SKILLS[d.variant][2];
  const sky = isSky(d);
  const ax = ballistixSlidesHorizontally(slot);
  // target: the ball whose predicted intercept is nearest to the ball itself
  let best = 0x7fffff * 1, tx = 0, tz = 0, bd = 0, any = false;
  for (const b of d.balls) {
    if (b.st !== 1) continue;
    const hit = sky ? predictSky(w, d, slot, b) : predict(w, d, slot, b, 0);
    if (!hit) continue;
    const dd = (b.x - hit[0]) ** 2 + (b.z - hit[1]) ** 2;
    if (dd < best) { best = dd; tx = hit[0]; tz = hit[1]; bd = Math.sqrt(dd); any = true; }
  }
  // N.Ballism: chase a power-up that is closer than any threat
  if (d.variant === 'nballism' && d.post) {
    const [cx, cz] = bumpers(d)[d.post.i];
    const k = Math.max(1, (0x20 - skill) * 0x20);
    const dd = (pl.x - cx + k) ** 2 + (pl.z - cz + k) ** 2;
    if (dd < best) { best = dd; tx = cx; tz = cz; bd = Math.sqrt(dd); any = true; }
  }
  let dirv = 0; // +1 = right (x sliders) / screen up (z sliders) in the game's pad terms
  const sgn = slot === 0 || slot === 2 ? -1 : 1; // Sky Balls: ring angle = ang + sgn * vel
  if (!any) {
    // wander around the middle of the goal
    const tgt = Math.floor(hash(slot, Math.floor(d.f / 90)) * 1024) - 512;
    if (sky) {
      const da = adiff(pl.ang, (FACE[slot] + (tgt >> 1)) & 4095);
      if (Math.abs(da) > 0x20) dirv = (da > 0 ? 1 : -1) * sgn;
    } else {
      const diff = (ax ? pl.x : pl.z) - tgt;
      if (Math.abs(diff) > 0x80) dirv = diff > 0 ? -1 : 1;
    }
  } else {
    const k = (skill + d.off) * 0x20;
    const da = sky ? adiff(pl.ang, atan(tx, tz)) : 0;
    const diff = sky ? (da * RING * Math.PI * 2) / 4096 : ax ? pl.x - tx : pl.z - tz;
    const dist = Math.abs(diff) + k;
    if (dist > 0x280) {
      if (bd < dist) out.r = true;
      if (sky) dirv = (da > 0 ? 1 : da < 0 ? -1 : 0) * sgn;
      else {
        const bits = PAD_BITS[(atan(tx - pl.x, tz - pl.z) >> 9) & 7];
        dirv = ax ? (bits & 0x20 ? 1 : bits & 0x80 ? -1 : 0) : (bits & 0x10 ? 1 : bits & 0x40 ? -1 : 0);
      }
    }
  }
  // pad -> stick: x sliders use stick x, z sliders: game +z is screen up (stick y < 0)
  if (ax) out.x = dirv; else out.y = -dirv;
  // kick
  if (pl.kcd === 0 && pl.st !== 0x1f && pl.st !== 0x21) {
    let R = Math.max(1, skill * 0x10 - d.off);
    R = R + Math.floor(hash(w.tick, slot, 77) * R) + 0x100;
    const lapse = hash(slot, Math.floor((w.tick + slot * 7) / 39)) * 0x20 < skill;
    for (const b of d.balls) {
      if (b.st !== 1 && b.st !== 8) continue;
      const dx = pl.x - b.x, dz = pl.z - b.z;
      if (dx * dx + dz * dz >= R * R) continue;
      const a = atan(dx, dz);
      let good = !lapse;
      if (!good) {
        // would the kicked ball reach someone else's line?
        for (let o = 0; o < 4 && !good; o++) {
          if (o === slot || d.pl[o].score <= 0 || sky) continue;
          const bb: Ball = { ...b, h: a, x: b.x, z: b.z };
          if (predict(w, d, o, bb, 1)) good = true;
        }
      }
      if (good) { out.a = true; break; }
    }
  }
  return out;
}

function predictSky(w: World, d: Data, slot: number, b: Ball): [number, number] | null {
  // path of the ball against the ring of this ship
  let idx = (0x20 - (d.pl[slot].skill ?? BOT_SKILLS[d.variant][2])) - d.off;
  if (idx < 0) idx = 0;
  const win = WIN[idx];
  const err = Math.floor(hash(w.tick, slot, b.id, 0) * win) - win;
  const h = (b.h + err) & 4095;
  const ex = -cosq(h - 0x400), ez = -cosq(h); // unit (Q12) travel direction
  // march along the path until the radius passes RING
  for (let t = 0; t < 4096; t += 128) {
    const x = b.x + (ex * t) / 4096, z = b.z + (ez * t) / 4096;
    if (x * x + z * z >= RING * RING) {
      const a = atan(x, z);
      const q = (a + 0x200) & 0xc00;
      const side = q === 0x800 ? 0 : q === 0 ? 1 : q === 0x400 ? 2 : 3;
      if (side !== slot) return null;
      return [x, z];
    }
  }
  return null;
}
