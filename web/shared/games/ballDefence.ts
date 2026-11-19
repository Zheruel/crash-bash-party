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
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const BD_U = 256; // disc units per sim unit
export const BD_K = 4;
export const BD_HALF = 9; // legacy: arena half size in sim units (0x900 / 256 = 9)
export const BD_BALL_R = 0.5; // 128 u
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
const PAD_BITS = [0x10, 0x30, 0x20, 0x60, 0x40, 0xc0, 0x80, 0x90]; // 0x80051244: direction bits per 45 deg of angle
const POST_SEQ = [0, 1, 2, 3, 1, 3, 0, 1, 0, 3, 2, 1, 2, 0, 2, 3]; // 0x800c1440, indexed by running counter
const RING = 2304; // Sky Balls ship orbit radius
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
/** signed difference b - a in -0x800..0x7ff (FUN_800154a0) */
const adiff = (a: number, b: number) => { const d = (b - a) & 4095; return d >= 0x800 ? d - 4096 : d; };
const aabs = (a: number, b: number) => Math.abs(adiff(a, b));
const rnd = (w: World, n: number) => Math.floor(rand(w) * n); // FUN_80015590(n)
/** deterministic pseudo random for the bot (must not touch w.rng) */
const hash = (...v: number[]) => { let h = 0x811c9dc5; for (const x of v) { h = Math.imul(h ^ (x | 0), 0x01000193); h ^= h >>> 15; } return (h >>> 0) / 4294967296; };

// ---------------------------------------------------------------- state
interface Pl {
  x: number; z: number; // u (game z)
  vel: number; // lateral velocity (+0xc)
  face: number; // facing angle (outward)
  ang: number; // Sky Balls: ring angle
  score: number;
  kcd: number; // kick cooldown (0x8009d592)
  kpen: number; // kick penalty (0x8009d594)
  kfr: number; // frames into the kick swing (0x8009d596)
  st: number; // 0x1c idle, 0x1d move, 0x1f kick, 0x21 catch, 0x24 dying, 0x25 gone
  hold: number; // catch timer (0x8009d590)
  arm: number; // release arming (+0x28)
  pa: boolean; // previous A
  pb: boolean;
  shield: number; // frames of force field left
  dead: number; // 0 alive, else frame of elimination
  dieT: number;
  pushed: boolean;
  last: number; // last lateral velocity (for the view)
  boost: boolean;
}
interface Ball {
  id: number;
  st: number; // 0 new, 0xc waiting, 6 falling in, 8 bounce, 1 rolling, 2 held, 4/0x11/99 into goal, 0x12 scored
  x: number; y: number; z: number;
  h: number; spd: number; tgt: number; acc: number; dec: number;
  who: number; // last toucher / conceding player (-1 none)
  hcd: number; tm: number;
  vv: number; vmax: number; vup: number; vdn: number; vdir: number; // vertical bounce state (vdir 0 = down)
  psh: number; pshA: number;
  land: boolean; sink: number; fl: number; hoff: number;
  corner: number;
}
interface Post { i: number; t: number }
/** Sky Balls platform event per player (0x800c1e78 + p*0x1c): offset, velocity, velocity clamp, accel up / down, direction, state, timer */
interface SkyEv { pos: number; vel: number; max: number; ap: number; an: number; dir: number; st: number; tm: number }
interface Mach { st: number; t: number; c: number; yaw: number; spin: number }
interface Data {
  variant: string; f: number;
  pl: Pl[]; balls: Ball[]; bid: number[]; // bid[ball.id] = body id
  ef8: number; efc: number; efa: number; off: number;
  last: number; // side that conceded last (0x800c1f16), -1 none
  walls: number; // closed goals bitmask 1=z- 2=z+ 4=x- 8=x+ (game axes)
  cool: number[]; // spawn corner cooldowns
  postT: number; postSeq: number; post: Post | null;
  mach: Mach | null;
  /** Sky Balls: platform events, event timer / table index (0x800c1c78 / 7c), disc tilt [rx 0x800c1c68, rz 0x800c1c6c, floor y 0x8005a5d8] */
  sky?: { ev: SkyEv[]; t: number; i: number };
  tilt?: number[];
}

const V = (w: World) => (w.data as Data).variant;
const bumpers = (d: Data) => BD_BUMPERS[d.variant];
const isSky = (d: Data) => d.variant === 'sky';
const nBalls = (d: Data) => d.balls.length;

export const bdBallY = (y: number) => -(y + 96) / BD_U; // disc y -> sim height above the floor

// ---------------------------------------------------------------- setup
function newBall(w: World, d: Data): Ball {
  return {
    id: w.nextId++, st: 0, x: 4096, y: 4096, z: 4096, h: 0, spd: 0, tgt: 0, acc: 0, dec: 0, who: -1, hcd: 0, tm: 0,
    vv: 0, vmax: 0, vup: 0, vdn: 0, vdir: 0, psh: 0, pshA: 0, land: false, sink: 0, fl: 0, hoff: 0, corner: -1,
  };
}

export const ballDefence: MiniGame = {
  id: 'ballDefence',
  name: 'Ballistix',
  description: 'Deflect the balls away from your goal! Every ball that gets in costs you a point. Last ship in play wins.',
  controls: '{move} move your ship. {a} kick. Hold {b} for a speed boost (Beach Ball: hold {b} to catch a ball, let go to fire it).',
  variants: BD_VARIANTS,
  maxTime: 240,

  setup(w, slots) {
    const variant = pickVariant(w, BD_VARIANTS);
    const start = BD_START_BY[variant] ?? BD_START;
    const d: Data = {
      variant, f: 0, pl: [], balls: [], bid: [], ef8: 0, efc: 10, efa: 0, off: 0, last: -1, walls: 0,
      cool: [0, 0, 0, 0], postT: 180, postSeq: rnd(w, 15), post: null, mach: null,
    };
    if (variant === 'nballism') d.mach = { st: 0, t: (rnd(w, 15) + 8) * 30, c: 0, yaw: 0, spin: 0 };
    if (variant === 'sky') { // level init: event timer 0x10e, table index rand(0x12)
      d.sky = { ev: [0, 1, 2, 3].map(() => ({ pos: 0, vel: 0, max: 0, ap: 0, an: 0, dir: 0, st: 0, tm: 0 })), t: 0x10e, i: rnd(w, 0x12) };
      d.tilt = [0, 0, 0];
    }
    for (let i = 0; i < MAX_SEATS; i++) {
      d.pl.push({
        x: START[i][0], z: START[i][1], vel: 0, face: FACE[i], ang: FACE[i], score: start, kcd: 0, kpen: 0, kfr: 0, st: 0x1c, hold: 0, arm: 0,
        pa: false, pb: false, shield: 0, dead: 0, dieT: 0, pushed: false, last: 0, boost: false,
      });
    }
    w.data = d;
    for (const s of slots) {
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, 0, 0, BD_SHIP_R * sc, 3 * sc * sc);
      b.alive = true;
    }
    mirror(w, d);
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    d.f++;
    controller(w, d);
    for (let p = 0; p < MAX_SEATS; p++) playerFrame(w, d, p, inputs[p] ?? IDLE);
    pushShields(w, d);
    for (const b of d.balls.slice()) ballFrame(w, d, b);
    d.balls = d.balls.filter((b) => b.st !== -1);
    mirror(w, d);
  },

  isOver(w) {
    const d = w.data as Data;
    return d.pl.filter((p) => p.score > 0).length <= 1;
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
    return botInput(w, w.data as Data, slot);
  },
};

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
  for (let c = 0; c < 4; c++) if (d.cool[c] > 0) d.cool[c]--; // corner spawn cooldown (0x800c1cfa, FUN_800bcb..)
  const alive = d.pl.filter((p) => p.score > 0).length;
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
      if (d.balls.length < 9 && alive > 1) { d.balls.push(newBall(w, d)); }
      d.efc = 30;
    }
  } else d.efc--;
  d.off = CNT_OFF[Math.min(d.efa, 9)];
  // N.Gin machine
  if (d.mach) machine(w, d);
  if (d.sky) skyPlatform(w, d, d.sky);
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
      if (m.t > 0) { m.t--; if (m.t === 0) { m.st = 1; } }
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
  b.st = 1; b.x = (sinq(m.yaw) * 13) >> 7; b.z = (cosq(m.yaw) * 13) >> 7; b.y = -96;
  b.h = m.yaw; b.spd = b.tgt = 0x80; b.acc = 4; b.dec = 1; b.land = true; b.fl = 0x400;
  d.balls.push(b);
  emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, -1, 1, 1473);
}

// ---------------------------------------------------------------- players
const AXIS_X = (p: number) => p === 0 || p === 1; // slides along x (else along game z)

function playerFrame(w: World, d: Data, p: number, inp: InputState) {
  const pl = d.pl[p];
  const v0 = pl.vel;
  if (pl.st === 0x25) return;
  if (pl.score <= 0 && pl.st < 0x24) { enterDie(w, d, p); }
  if (pl.st === 0x24) {
    pl.vel = 0;
    if (--pl.dieT <= 0) { pl.st = 0x25; emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1414); emit(w, 'gone', pl.x / BD_U, -pl.z / BD_U, p, 1); }
    return;
  }
  const sky = isSky(d);
  const fr = w.params.friction;
  // --- input to pad bits (digital)
  const th = 0.35;
  const L = inp.x < -th, R = inp.x > th, U = inp.y < -th, Dn = inp.y > th; // screen directions; U = toward the top of the screen
  const boost = !!inp.b && d.variant !== 'beach';
  const catchB = !!inp.b && d.variant === 'beach';
  const edgeA = !!inp.a && !pl.pa; pl.pa = !!inp.a;
  const edgeB = catchB && !pl.pb; pl.pb = catchB;
  // --- slide (FUN_800b558c / FUN_800b58e8)
  let max = sky ? 0x28 : 0x68, acc = sky ? 0xd : 0x22, dec = sky ? 6 : 0x12;
  if (p === 1) acc = sky ? 0x15 : 0x2a;
  if (boost) { max = sky ? 0x48 : 0xa0; acc = sky ? 0x12 : 0x38; }
  dec = Math.max(1, Math.round(dec * fr));
  // direction: sim screen-left/right is -x/+x; the game's +x slide is screen right for every slider; z sliders: up = +game z = screen up
  let dirv = 0; // +1 / -1 along the slide axis in game coordinates
  if (AXIS_X(p)) dirv = (R ? 1 : 0) - (L ? 1 : 0);
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
  if (pl.kcd > 0) pl.kcd--; else if (pl.kpen > 0) pl.kpen--;
  if (pl.st === 0x1f) {
    kickUpdate(w, d, p);
  } else if (pl.st === 0x21) {
    catchUpdate(w, d, p, !!inp.b);
  } else {
    pl.st = pl.vel !== 0 ? 0x1d : 0x1c;
    if (d.variant === 'beach' && edgeB) { pl.st = 0x21; pl.hold = 0x96; pl.arm = 2; emit(w, 'catch', pl.x / BD_U, -pl.z / BD_U, p, 1); }
    else if (edgeA) {
      if (pl.kcd === 0) { pl.st = 0x1f; pl.kfr = 0; pl.kpen = Math.min(pl.kpen + 0x1e, 0x5a); pl.kcd = pl.kpen; emit(w, 'kick', pl.x / BD_U, -pl.z / BD_U, p, 1); emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, KICK_SFX[p]); }
    }
  }
  // --- apply motion (FUN_800b5c30 / b5ec8)
  const sm = w.params.speed;
  if (sky) {
    const sgn = (p === 0 || p === 2) ? -1 : 1;
    pl.ang = (pl.ang + sgn * Math.trunc(pl.vel * sm)) & 4095;
    pl.x = (sinq(pl.ang) * 9) >> 4; pl.z = (cosq(pl.ang) * 9) >> 4;
    if (pl.vel !== 0) bump(d, pl, p);
    pl.face = pl.ang;
  } else if (pl.vel !== 0) {
    if (AXIS_X(p)) pl.x += Math.trunc(pl.vel * sm); else pl.z += Math.trunc(pl.vel * sm);
    bump(d, pl, p);
  }
  pl.last = pl.vel;
  if (pl.dead === 0) shipBalls(w, d, p, v0); // after the move, but the push uses the velocity the ship had at the start of the frame (emulator traces)
}

function enterDie(w: World, d: Data, p: number) {
  const pl = d.pl[p];
  pl.st = 0x24; pl.dieT = 60; pl.vel = 0; pl.dead = d.f;
  if (!d.walls) emit(w, 'sfx', 0, 0, -1, 1, 1425); // goal wall closes (0x591/0x592)
  d.walls |= [1, 2, 8, 4][p];
  pl.shield = 0;
  emit(w, 'ko', pl.x / BD_U, -pl.z / BD_U, p, 1);
}

/** push a ship out of the corner bumpers (FUN_800b42f4); true when it was pushed */
function bump(d: Data, pl: Pl, p: number): boolean {
  const sky = isSky(d);
  for (const [cx, cz, cr] of bumpers(d)) {
    const R = cr + 0x80;
    const dx = pl.x - cx, dz = pl.z - cz;
    if (dx * dx + dz * dz < R * R) {
      const a = atan(-dx, -dz);
      if (sky || AXIS_X(p)) pl.x = cx - ((R * sinq(a)) >> 12);
      if (sky || !AXIS_X(p)) pl.z = cz - ((R * cosq(a)) >> 12);
      if (sky) {
        pl.ang = atan(pl.x, pl.z);
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
  const BR = 128 * w.params.ballScale;
  let hit = false;
  for (const b of d.balls) {
    if (b.st !== 1 && b.st !== 8) continue;
    const dx = b.x - pl.x, dz = b.z - pl.z;
    const R = BR + reach;
    const dist2 = dx * dx + dz * dz;
    if (dist2 >= R * R) continue;
    const dist = Math.sqrt(dist2);
    if (b.hcd !== 0) continue;
    const a = atan(-dx, -dz);
    const push = R - Math.trunc(dist) + 1;
    b.x -= (push * sinq(a)) >> 12; b.z -= (push * cosq(a)) >> 12;
    b.who = p; b.hcd = 4; b.h = a;
    emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, p, 1, 1413);
    emit(w, 'hit', b.x / BD_U, -b.z / BD_U, -1, 1.4, p);
    const old = b.tgt;
    b.tgt = d.variant === 'beach' ? 0x40 : isSky(d) ? 0x80 : 0x90;
    b.spd = old + 0x40;
    hit = true;
  }
  return hit;
}

function catchUpdate(w: World, d: Data, p: number, bHeld: boolean) {
  const pl = d.pl[p];
  pl.kfr++;
  if (pl.hold === 0) { releaseBalls(w, d, p, false); pl.st = 0x1c; return; }
  pl.hold--;
  if (pl.hold > 0x90) return;
  if (bHeld) { pl.arm = 2; return; }
  if (pl.arm > 0) { pl.arm--; }
  if (pl.arm === 0) { releaseBalls(w, d, p, true); pl.st = 0x1c; }
}

/** FUN_800bb674: let go of the balls this ship holds */
function releaseBalls(w: World, d: Data, p: number, fast: boolean) {
  for (const b of d.balls) {
    if (b.st !== 2 || b.who !== p) continue;
    const sp = fast ? 0xe0 : 0x30;
    b.spd = sp; b.tgt = sp;
    const pl = d.pl[p];
    b.h = (pl.face + Math.max(-0x220, Math.min(0x220, b.hoff))) & 4095;
    b.x -= (b.spd * sinq(b.h)) >> 12; b.z -= (b.spd * cosq(b.h)) >> 12;
    b.st = 1;
    if (fast) emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1417 + 0); // launch swoosh uses 0x5a9+p in the real game
    emit(w, 'launch', b.x / BD_U, -b.z / BD_U, p, fast ? 1 : 0);
  }
}

/** ship sphere centres: body (at the ship) and front (132 u toward the wall) */
function spheres(d: Data, pl: Pl) {
  const f = pl.face;
  return { bx: pl.x, bz: pl.z, fx: pl.x + ((sinq(f) * 132) >> 12), fz: pl.z + ((cosq(f) * 132) >> 12) };
}

/** FUN_800be4d4: ship against every ball */
function shipBalls(w: World, d: Data, p: number, v0: number) {
  const pl = d.pl[p];
  const sc = w.params.playerScale;
  const rb = 345 * sc, rf = 414 * sc;
  const BR = 128 * w.params.ballScale;
  const s = spheres(d, pl);
  const catching = pl.st === 0x21;
  for (const b of d.balls) {
    if (b.y < -600) continue;
    if (b.st === 2) {
      if (b.who === p) { // held ball rides on the front sphere
        const a = (pl.face + 0x800 + Math.max(-0x220, Math.min(0x220, b.hoff))) & 4095;
        const R = BR + rf;
        b.x = s.fx + ((R * sinq(a)) >> 12); b.z = s.fz + ((R * cosq(a)) >> 12);
      }
      continue;
    }
    if (b.st !== 1 && b.st !== 6 && b.st !== 8) continue;
    const to = atan(pl.x - b.x, pl.z - b.z);
    const front = aabs(pl.face, to) < 0x38f;
    const cx = front ? s.fx : s.bx, cz = front ? s.fz : s.bz;
    const r = (front ? rf + (catching ? 0x80 : 0) : rb) + BR;
    const dx = b.x - cx, dz = b.z - cz;
    if (dx * dx + dz * dz >= r * r) continue;
    // move the ball back along its path to the sphere surface (FUN_800be1c4)
    pushOut(b, cx, cz, r + 8, b.h);
    const n = atan(cx - b.x, cz - b.z);
    b.who = p;
    if (front && catching) {
      const hh = atan(s.fx - b.x, s.fz - b.z);
      b.hoff = adiff(pl.face, hh);
      b.h = hh; b.spd = 0; b.tgt = 0; b.st = 2;
      emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, 1417 + 0);
      emit(w, 'catch', b.x / BD_U, -b.z / BD_U, p, 1);
      continue;
    }
    emit(w, 'sfx', b.x / BD_U, -b.z / BD_U, p, 1, HIT_SFX[rnd(w, 4)]);
    const lv = Math.abs(v0);
    const T = (b.h + 0x800) & 4095;
    const vx = ((b.spd * sinq(n)) >> 12) + ((lv * sinq(pl.face)) >> 12);
    const vz = ((b.spd * cosq(n)) >> 12) + ((lv * cosq(pl.face)) >> 12);
    const va = atan(vx, vz);
    const D = adiff(T, va);
    let nh: number;
    if (Math.abs(D) <= 0x400) nh = va + Math.max(-0x3f0, Math.min(0x3f0, D));
    else nh = va;
    b.h = nh & 4095;
    if (lv !== 0) { b.spd += lv; if (b.spd > b.tgt + 0x40) b.spd = b.tgt + 0x40; }
    if (b.fl === 0 && b.tgt < 0x90) { /* +0x32 cooldown is 0 */ }
    if (b.tgt < 0x90) b.tgt += 4;
    emit(w, 'hit', b.x / BD_U, -b.z / BD_U, -1, Math.min(1.5, 0.3 + lv / 100), p);
  }
}

/** FUN_800be1c4: place the ball at the first point of its backwards path that is outside the circle */
function pushOut(b: Ball, cx: number, cz: number, R: number, h: number) {
  const a = (h + 0x800) & 4095;
  const dxv = sinq(a) >> 3, dzv = cosq(a) >> 3; // backwards step (512 u long at most)
  const sx = b.x - dxv, sz = b.z - dzv; // start of the path: 512 u behind the ball, outside the circle
  const ex = b.x - sx, ez = b.z - sz; // (= -d) path direction
  // the disc's code walks from (sx,sz) towards the ball; its parameter t runs 0..1 over that step
  const fx = sx - cx, fz = sz - cz;
  const A = ex * ex + ez * ez, Bq = 2 * (ex * fx + ez * fz), C = fx * fx + fz * fz - R * R;
  if (A === 0) return;
  const disc = Bq * Bq - 4 * A * C;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  const t1 = (-Bq + sq) / (2 * A), t2 = (-Bq - sq) / (2 * A);
  if (t1 < 0 && t2 < 0) return;
  let t: number;
  if (t1 < t2) t = t1 < 0 ? t2 : t1; else t = t2 >= 0 ? t2 : t1;
  b.x = Math.trunc(sx + ex * t); b.z = Math.trunc(sz + ez * t);
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
      const R = cr + 0x80 + 0x40;
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
function circleHit(d: Data, b: Ball, BR: number): number {
  // FUN_800b4880 / b4ae8: corner bumpers, then the walls of closed goals; returns the normal angle or -1
  let n = -1;
  for (const [cx, cz, cr] of bumpers(d)) {
    const R = cr + BR;
    const dx = b.x - cx, dz = b.z - cz;
    if (dx * dx + dz * dz < R * R) {
      pushOut(b, cx, cz, R, b.h);
      n = atan(cx - b.x, cz - b.z);
      if (!isSky(d)) break;
    }
  }
  if (n !== -1 && !isSky(d)) return n;
  if (d.walls) {
    const L = 0x800;
    if (L < b.x && (d.walls & 8)) { b.x = L; n = 0x400; }
    if (b.x < -L && (d.walls & 4)) { b.x = -L; n = 0xc00; }
    if (L < b.z && (d.walls & 2)) { b.z = L; n = 0; }
    if (b.z < -L && (d.walls & 1)) { b.z = -L; n = 0x800; }
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
  if (b.st === 0) { spawnWait(w, d, b); return; }
  if (b.st === 0x12) { scoreBall(w, d, b); return; }
  // speed towards target, then move
  if (b.spd < b.tgt) { b.spd += b.acc; if (b.tgt < b.spd) b.spd = b.tgt; }
  else if (b.tgt < b.spd) { b.spd -= b.dec; if (b.spd < b.tgt) b.spd = b.tgt; }
  const dxm = (b.spd * sinq(b.h)) >> 12, dzm = (b.spd * cosq(b.h)) >> 12;
  b.x -= sm === 1 ? dxm : Math.trunc(dxm * sm); b.z -= sm === 1 ? dzm : Math.trunc(dzm * sm);
  if (b.hcd > 0) b.hcd--;
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
        const n = circleHit(d, b, BR);
        if (n !== -1) bounce(w, d, b, n);
        const g = goalSide(d, b, false);
        if (g !== -1) goal(w, d, b, g, 4);
      }
      break;
    }
    case 1: {
      const n = circleHit(d, b, BR);
      if (n !== -1) bounce(w, d, b, n);
      const g = goalSide(d, b, false);
      if (g !== -1) goal(w, d, b, g, 8);
      else applyPush(d, b);
      break;
    }
    case 2:
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
  if (b.st === 1 || b.st === 8 || b.st === 6) ballBall(w, d, b, BR);
}

function spawnWait(w: World, d: Data, b: Ball) {
  const alive = d.pl.filter((p) => p.score > 0).length;
  if (alive <= 1) return;
  let c: number;
  if (d.last >= 0 && d.last < 4) c = SPAWN_AFTER[d.last][rnd(w, 2)]; else c = rnd(w, 4);
  if (d.cool[c] > 0) return;
  d.last = -1;
  const sp = SPAWNS[d.variant][c];
  b.x = sp[0]; b.z = sp[1]; b.y = -32;
  d.cool[c] = 0x1f; b.corner = c;
  b.tm = 0xf; b.st = 0xc;
}

function launch(w: World, d: Data, b: Ball) {
  const a = atan(b.x, b.z);
  b.h = a; b.pshA = (a + rnd(w, 0x1c7) - 0xe3) & 4095;
  b.acc = 4; b.dec = 1; b.psh = 0;
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
function skyPlatform(w: World, d: Data, sk: NonNullable<Data['sky']>) {
  if (sk.t === 0) {
    sk.i = sk.i + 1 > 0x11 ? 0 : sk.i + 1;
    const p = SKY_EV_SLOT[sk.i], e = sk.ev[p];
    // FUN_800bd43c: the disc lurches towards that player for 60..89 frames, then rocks back to level
    e.tm = rnd(w, 0x1e) + 0x3c; e.st = 1; e.an = 0xa0; e.max = 0x300; e.vel = 0; e.ap = 0; e.dir = -1;
    emit(w, 'sfx', 0, 0, p, 1, 0x5c9);
    emit(w, 'sfx', 0, 0, p, 1, 0x5ca + rnd(w, 4));
    emit(w, 'tilt', 0, 0, p, 1);
    sk.t = rnd(w, 9) * 0x1e + 0x10e;
  } else sk.t--;
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
  // FUN_800bca38: a slow wobble and bob (64-frame cycle) plus each player's lurch along its diagonal
  const u = d.f & 0x7f;
  let rz = ((sinq(u * 0x40) + cosq(u * 0x40)) * 0xb) >> 12, rx = (sinq(u * 0x20) * 5) >> 10;
  const floor = (cosq(u * 0x40) * 3) >> 7;
  sk.ev.forEach((e, p) => {
    if (e.pos === 0) return;
    const t = atan(0xa00, e.pos >> 4) - 0x400;
    if (p === 0) { rz += t; rx -= t; } else if (p === 1) { rz += t; rx += t; } else if (p === 2) { rz -= t; rx += t; } else { rz -= t; rx -= t; }
  });
  d.tilt = [rx, rz, floor];
}

function goal(w: World, d: Data, b: Ball, side: number, tm: number) {
  b.who = side;
  b.sink = 0;
  if (isSky(d)) { b.st = 99; b.tm = 0x10; return; }
  b.tm = tm === 4 ? 4 : 8;
  if (d.variant === 'crashball') { b.st = 0x11; return; }
  b.st = 4; b.vv = 0x60; b.vmax = 0x60; b.vup = 8; b.vdn = 0;
}

/** state 0x12 (FUN_800b9e54): the ball has crossed the goal line for good */
function scoreBall(w: World, d: Data, b: Ball) {
  const p = b.who;
  b.st = -1;
  if (p < 0 || p > 3) return;
  const pl = d.pl[p];
  if (pl.dead || pl.score <= 0) return;
  d.last = p;
  emit(w, 'sfx', pl.x / BD_U, -pl.z / BD_U, p, 1, SIDE_SFX[p]);
  pl.score--;
  emit(w, 'goal', b.x / BD_U, -b.z / BD_U, p, 1, -1);
}

function ballBall(w: World, d: Data, a: Ball, BR: number) {
  for (const o of d.balls) {
    if (o === a || (o.st !== 1 && o.st !== 8 && o.st !== 6)) continue;
    const dx = o.x - a.x, dz = o.z - a.z;
    const R = BR * 2;
    const dd = dx * dx + dz * dz;
    if (dd >= R * R) continue;
    const dist = Math.trunc(Math.sqrt(dd));
    const ang = atan(-dx, -dz); // direction from o to a
    let ov = R - dist + 1;
    if (R / 2 < ov) ov = R;
    a.x += (ov * sinq(ang)) >> 12; a.z += (ov * cosq(ang)) >> 12;
    o.h = ang;
    const m = Math.trunc((a.spd + o.spd) / 2);
    a.spd = m; o.spd = m;
    emit(w, 'sfx', a.x / BD_U, -a.z / BD_U, -1, 1, 1408);
    const ang2 = (ang + 0x800) & 4095;
    const D = adiff((a.h + 0x800) & 4095, ang2);
    a.h = (ang2 + D) & 4095;
  }
}

// ---------------------------------------------------------------- AI (FUN_800b8a68), memoryless so it stays deterministic
const SKILL = 18; // the real HARD value (EASY 2, MEDIUM 10, HARD 18); BotBrain degrades it for the lower levels

/** intersection of a ball's predicted path (with the AI's aiming error) with a ship's defence segment (FUN_800b7c60) */
function predict(w: World, d: Data, slot: number, b: Ball, salt: number): [number, number] | null {
  let idx = (0x20 - SKILL) - d.off;
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
  const sky = isSky(d);
  const ax = AXIS_X(slot);
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
    const k = Math.max(1, (0x20 - SKILL) * 0x20);
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
    const k = (SKILL + d.off) * 0x20;
    const da = sky ? adiff(pl.ang, atan(tx, tz)) : 0;
    const diff = sky ? (da * RING * Math.PI * 2) / 4096 : ax ? pl.x - tx : pl.z - tz;
    const dist = Math.abs(diff) + k;
    if (dist > 0x280) {
      if (bd < dist) out.b = d.variant !== 'beach';
      if (sky) dirv = (da > 0 ? 1 : da < 0 ? -1 : 0) * sgn;
      else {
        const bits = PAD_BITS[(atan(tx - pl.x, tz - pl.z) >> 9) & 7];
        dirv = ax ? (bits & 0x20 ? 1 : bits & 0x80 ? -1 : 0) : (bits & 0x10 ? 1 : bits & 0x40 ? -1 : 0);
      }
    }
  }
  // pad -> stick: x sliders use stick x, z sliders: game +z is screen up (stick y < 0)
  if (ax) out.x = dirv; else out.y = -dirv;
  // kick / catch
  if (d.variant === 'beach') {
    if (pl.st === 0x21) {
      out.b = pl.hold > 0x96 - 0x5a;
    } else {
      for (const b of d.balls) {
        if (b.st !== 1) continue;
        const dx = pl.x - b.x, dz = pl.z - b.z;
        if (dx * dx + dz * dz < 0x64000 && aabs(atan(dx, dz), pl.face) < 0x2aa) { out.b = true; break; }
      }
    }
  }
  if (pl.kcd === 0 && pl.st !== 0x1f && pl.st !== 0x21) {
    let R = Math.max(1, SKILL * 0x10 - d.off);
    R = R + Math.floor(hash(w.tick, slot, 77) * R) + 0x100;
    const lapse = hash(slot, Math.floor((w.tick + slot * 7) / 39)) * 0x20 < SKILL;
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
      if (good && !(d.variant === 'beach' && out.b)) { out.a = true; break; }
    }
  }
  return out;
}

function predictSky(w: World, d: Data, slot: number, b: Ball): [number, number] | null {
  // path of the ball against the ring of this ship
  let idx = (0x20 - SKILL) - d.off;
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
