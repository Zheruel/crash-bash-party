import { onFootItemMarker, TAUNT_TICKS } from './onFoot';
import { createPlayerDispatch, nextPlayerOrder, tickVersusTally, VERSUS_CLOCK_END } from './common';
import { CRATE_ATTACK, CT_HULL } from './crateGripData';
import { at2, ps1SqrtFixed } from './dragonDrop';
import { DISC_CHARACTER } from '../look';
import { addBody, discRandomState, drawDiscRandom, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type GameEvent, type InputState, type MiniGame, type World } from '../types';

/**
 * RING DING (Crash Bash level id 27 in the overlay numbering, clock-tower arena). Ported from the decompiled overlay,
 * see re/notes/ringDing.md for every constant and the function addresses (FUN_800b....).
 *
 * The simulation runs in PS1 integer units (30 Hz, one tick = one game frame step) and is mirrored into world bodies:
 *   body.x = x * S, body.z = -z * S (PS1 +z points away from the camera), body.y = height above the floor * S, S = 3.4 / 1024.
 * PS1 angles are 4096 per turn; a point at angle a, radius r is (x, z) = r * (sin a, cos a).
 *
 * Rules: 90 s; jump into balloons of your colour (+1), a wrong colour hurts you (37 tick stun); square = spin attack (hits rivals,
 * opens crates); black balloons: recolour all balloons / pop the others' balloons / reverse the ring; crates give hover boots
 * (240 ticks, the ring does not carry you) or the balloon magnet (300 ticks). The ring (radius 896..2560) carries everyone on
 * the ground; balloons are airborne and not carried. Highest score wins.
 *
 * world.data (RingDingData): see the interface. Bodies: 'player' (slot), 'balloon' (slot = display colour, -1 black),
 * 'crate' (m = grow 0..1), 'item' (flying power-up; cd 1 hover / 2 magnet).
 * Events: 'pop' (s popper or -1, o display colour or -1 black, v height), 'score' (s), 'hurt' (s), 'black' (s, v 0 pop others / 1 reverse /
 * 2 recolour), 'reverse', 'flash', 'cratehit', 'crate' (s, v 1 hover / 2 magnet), 'punch' (v 1 swing / 2 hit), 'jump', 'land', 'spawn'.
 */
export const DD_S = 3.4 / 1024;
export const DD_IN = 838 * DD_S; // hub radius (the ring starts at 896)
export const DD_OUT = 2559 * DD_S; // outer rim of the ring
export const DD_TICKS = VERSUS_CLOCK_END;
export const DD_INTRO_TICKS = 99; // last update with the USA countdown input lock
export const DD_LOSE_SCALE_STEP = 0x60;
export const DD_LANDING_TICKS = [26, 10, 5, 3, 10, 8, 14, 6]; // L27 script 8, after the touchdown update
const DD_LOSE_MIN_SCALE = 0x301;
const RESULT_TURN_LOCK = 99; // L27 terminal snapshot, decremented before FUN_80085c84

const FLOOR_R2_MIN = 0xc3fff; // ring carry: radius^2 in (0xc4000, 0x640001)
const FLOOR_R2_MAX = 0x640001;
const LIMIT = 0x980; // outer limit (FUN_800b8f48)
const TYPES = [11, 8, 9, 10]; // colour rotation: player index -> balloon type (0x800bb88c)
const OWNER: Record<number, number> = { 8: 1, 9: 2, 10: 3, 11: 0 };
const WEIGHT = [...Array(8).fill(16), 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]; // 0x800bb848 (0 beyond)
const SKILLS = [12, 20, 24]; // versus difficulty table at 0x800bb748
const HIT_TICKS = 38; // L27 script 0x2b, Koala ends one update earlier
const PU_HOVER = 0x13;
const PU_MAGNET = 0x17;
const ANGLE = 2 * Math.PI / 4096;
// Individual versus markers at the countdown, in seat order: X, Z and native yaw.
const START = [[-4, -646, 4], [667, -5, 3077], [-697, -19, 1006], [7, 682, 2055]];
const BALLOON_RADIUS = 128;
const BALLOON_BOTTOM = -43;
const BALLOON_TOP = 252;

/** look.ts CHARACTERS index -> game character id 1..8 (1 crash, 2 coco, 3 cortex, 4 brio, 5 tiny, 6 rilla, 7 dingodile, 8 koala). */
const LOOK_TO_ID = DISC_CHARACTER;
const SPIN_TICKS = [0, 16, 16, 19, 13, 12, 16, 14, 14]; // script 0x0a by engine character ID

const COS: number[] = [];
for (let i = 0; i < 4096; i++) COS.push(Math.round(4096 * Math.cos((i * Math.PI * 2) / 4096)));
const trig = (a: number) => COS[a & 4095];
const turnDelta = (from: number, to: number) => {
  const delta = (to - from) & 0xfff;
  return delta > 0x800 ? delta - 0x1000 : delta;
};
const actorYaw = (face: number) => Math.round(-face / ANGLE) & 0xfff;
function humanHeading(input: InputState) {
  // Native pads use 0x00/0xff around 0x80, with Y inverted.
  const extent = Math.max(Math.abs(input.x), Math.abs(input.y));
  const x = Math.round(input.x / extent * (input.x < 0 ? 128 : 127));
  const z = Math.round(-input.y / extent * (input.y < 0 ? 128 : 127));
  return (at2(x, z) + 0x800) & 0xfff;
}
const ri = (w: World, n: number) => Math.floor(rand(w) * n);

export interface DDPlayer {
  bid: number;
  x: number; z: number; h: number; vv: number;
  /** 0 ground, 1 rising, 2 falling */
  ph: number;
  jumpAt?: number; // snapshot tick of the first jump pose
  landing?: number; // ticks left including the current frame of script 8
  /** 0 free, 1 spin attack, 2 hit, 3 round over */
  st: number;
  t: number;
  spinLock?: number; // ticks before another attack can start
  spinCost?: number; // recovery for successive attacks, decays after the lock expires
  id: number; // game character id 1..8
  bot: boolean; skill?: number;
  v0: number; gd: number; gu: number; spd: number;
  pu: number; put: number;
  kx: number; kz: number; kn: number;
  knockAngle?: number; // native bearing toward the source of the impulse
  pendingHit?: number; // attacker slot, consumed when the victim next updates
  hitFrame?: number;
  heading?: number; // movement yaw, independent of the rendered actor yaw
  moving?: boolean;
  idleAt?: number; // first frame of the current idle script, including the pre-GO loop
  tauntAt?: number;
  pA: boolean; pB: boolean;
  face: number; // radians, 0 = +z (body space)
  cpu?: RingDingCpu;
  cpuYaw?: number; // the movement controller's yaw, before easing the actor's facing
  cpuFallback?: true; // a disconnected human was CPU-driven in the last authoritative step
}
export interface DDBalloon {
  bid: number; ty: number; ow: number;
  objectSlot?: number;
  x: number; z: number; hy: number;
  angle: number; dr: number; da: number; po: number; pa: number;
  st: number; tf: boolean; tc: number; ot: number;
}
export interface DDCrate {
  bid: number; x: number; z: number;
  objectSlot?: number;
  /** 3 spawned, 0 init, 6 growing, 1/11 solid, 9 hit, 12 opening, 13 flying */
  st: number; g: number; tf: boolean; tc: number; item: number;
  // g is the vertical scale for a box and height above the floor for a flying item.
  yaw?: number;
  flight?: { speed: number; rising: boolean; touchable?: boolean; touched?: boolean };
  ringAngle?: number; ringRadius?: number;
}
interface DDItemActor {
  script: number; frame: number;
  yaw: number; offset: number;
  visible: boolean;
  source?: number;
}
export interface RingDingData {
  t: number;
  openingRng?: number; // after the spawn-slot shuffle, before the countdown
  /** ring angular speed (4096/turn per tick) and target direction */
  rs: number; dir: number;
  /** accumulated ring angle (radians, three.js rotation.y) */
  ang: number;
  score: number[];
  shown?: number[]; // Three-digit HUD counters. Older snapshots have only the awarded scores.
  /** ticks left: hit stun, hover, magnet */
  stun: number[]; hover: number[]; magnet: number[];
  /** per slot: 0 free, 1 spinning, 2 hit, 3 over (mirror of P[].st) and 0 ground / 1 rising / 2 falling */
  st: number[]; ph: number[];
  /** recolour effect: ticks left and owner */
  rc: number; rcO: number;
  /** DAT_800bbd68: the recolour flicker cue already played in this bright phase (older snapshots: 0) */
  rcCue?: number;
  tc: number; tk: number; tb: number; col: number; cur: number;
  slots: number[][];
  P: (DDPlayer | null)[];
  B: DDBalloon[]; C: DDCrate[];
  freeObjectSlots?: number[];
  itemActors?: (DDItemActor | null)[];
  cpuRng?: [number, number];
  updateOrders?: number[][];
  random?: [number, number]; // player dispatch only
  winner: number; draw: boolean;
}

const players = (d: RingDingData) => d.P.filter((p): p is DDPlayer => !!p);

function sync(w: World, d: RingDingData) {
  const map = new Map<number, Body>();
  for (const b of w.bodies) map.set(b.id, b);
  const place = (b: Body | undefined, x: number, h: number, z: number) => { if (b) { b.x = x * DD_S; b.z = -z * DD_S; b.y = h * DD_S; } };
  d.P.forEach((p, s) => {
    if (!p) return;
    const b = map.get(p.bid);
    if (!b) return;
    const ox = b.x, oz = b.z;
    place(b, p.x, p.h, p.z);
    b.vx = (b.x - ox) * 30; b.vz = (b.z - oz) * 30; b.vy = p.ph === 1 ? p.vv * DD_S * 30 : p.ph === 2 ? -p.vv * DD_S * 30 : 0;
    b.face = p.face;
    b.dash = p.st === 1 ? 0.1 : 0;
    b.fall = false;
  });
  for (const o of d.B) {
    const b = map.get(o.bid);
    if (!b) continue;
    const ox = b.x, oz = b.z;
    place(b, o.x, o.hy, o.z);
    b.vx = (b.x - ox) * 30; b.vz = (b.z - oz) * 30;
    b.face = o.angle; // spawn phase used by the dual-frequency bob in FUN_800b6044
    b.slot = dispSlot(d, o);
    b.cd = o.st === 9 ? 1 : 0;
  }
  for (const c of d.C) {
    const b = map.get(c.bid);
    if (!b) continue;
    place(b, c.x, c.item && c.st === 13 ? c.g : 0, c.z);
    b.m = c.st === 13 ? 1 : Math.min(1, c.g / 4096);
    b.kind = c.st === 13 ? 'item' : 'crate';
    b.cd = c.item === PU_HOVER ? 1 : 2;
    b.face = -(c.yaw ?? 0) * ANGLE;
  }
}

function dispSlot(d: RingDingData, o: DDBalloon): number {
  if (o.ty === 12) return -1;
  if (d.rc > 0) return d.rc < 30 && (d.rc & 2) ? o.ow : d.rcO;
  return o.ow;
}

/** Ring carry of a ground point: rotates by the ring speed and rounds the radius like FUN_800b3a3c. */
export function ddCarry(x: number, z: number, rs: number): [number, number] | null {
  const r2 = x * x + z * z;
  if (r2 <= FLOOR_R2_MIN || r2 >= FLOOR_R2_MAX) return null;
  return ringPoint((ps1SqrtFixed(r2) + 0x20) >> 6, at2(x, z) + rs);
}

function ringPoint(radius: number, angle: number): [number, number] {
  return [radius * trig(angle - 1024) >> 12, radius * trig(angle) >> 12];
}

/** FUN_800b8f48 subtracts the solid cylinder's radius from the outer limit. */
function limit(o: { x: number; z: number }, padding: number): boolean {
  const radius = LIMIT - padding;
  if (o.x * o.x + o.z * o.z < radius * radius) return false;
  [o.x, o.z] = ringPoint(radius, at2(o.x, o.z));
  return true;
}

// ---------- spawn slots (FUN_800b382c / FUN_800b4f7c) ----------

function makeSlots(w: World): number[][] {
  const s: number[][] = [];
  for (let r = 0; r < 4; r++) for (let k = 0; k < 16; k++) s.push([k << 8, 0x500 + 0x140 * r]);
  for (let i = 0; i < 300; i++) {
    const a = ri(w, 4) * 16 + ri(w, 16), b = ri(w, 4) * 16 + ri(w, 16);
    const t = s[a]; s[a] = s[b]; s[b] = t;
  }
  return s;
}

function occupancy(d: RingDingData): Uint8Array {
  const g = new Uint8Array(400);
  const mark = (c: number, r: number) => { if (c >= 0 && c < 20 && r >= 0 && r < 20) g[r * 20 + c] = 1; };
  const obj = (x: number, z: number) => {
    for (const c of [(x - 128 >> 8) + 10, (x + 128 >> 8) + 10]) for (const r of [9 - (z - 128 >> 8), 9 - (z + 128 >> 8)]) mark(c, r);
  };
  for (const b of d.B) obj(b.x, b.z);
  for (const c of d.C) obj(c.x, c.z);
  for (const p of players(d)) {
    const c = (p.x >> 8) + 10, r = 9 - (p.z >> 8);
    if (c < 0 || c >= 20 || r < 0 || r >= 20) continue;
    for (const cc of [c > 0 ? c - 1 : c, c, c < 19 ? c + 1 : c]) for (const rr of [r > 0 ? r - 1 : r, r, r < 19 ? r + 1 : r]) mark(cc, rr);
  }
  return g;
}

/** Slot picker: walks the shuffled table from the cursor and takes a slot with an empty 6x6 neighbourhood (else the least crowded of 10). */
function pick(d: RingDingData, g: Uint8Array): number[] | null {
  const cell = (p: number[]): [number, number] => [(p[0] >> 8) + 10, 9 - (p[1] >> 8)];
  const at = (c: number, r: number) => (r * 20 + c >= 0 && r * 20 + c < 400 ? g[r * 20 + c] : 0);
  let nx = d.cur;
  let p = d.slots[nx];
  let best = p, bestIdx = nx, bestCnt = 27, tries = 9;
  for (;;) {
    let [c, r] = cell(p);
    nx = (nx + 1) & 63;
    if (at(c, r)) {
      do {
        if (nx === d.cur) return null;
        p = d.slots[nx];
        [c, r] = cell(p);
        nx = (nx + 1) & 63;
      } while (at(c, r));
    }
    let cnt = 0;
    for (let cc = c - 3; cc < c + 3; cc++) for (let rr = r - 3; rr < r + 3; rr++) if (cc >= 0 && cc < 20 && rr >= 0 && rr < 20 && at(cc, rr)) cnt++;
    if (cnt === 0) { d.cur = nx; return p; }
    if (cnt < bestCnt) { best = p; bestIdx = nx; bestCnt = cnt; }
    if (nx === d.cur) return null;
    p = d.slots[nx];
    if (--tries === -1) { d.cur = bestIdx; return best; }
  }
}

function spawnBalloon(w: World, d: RingDingData, slot: number[], ty: number) {
  const [a, r] = slot;
  const x = (r * trig(a - 1024)) >> 12, z = (r * trig(a)) >> 12;
  const body = addBody(w, 'balloon', -1, x * DD_S, -z * DD_S, 0.45, 1);
  const o: DDBalloon = {
    bid: body.id, objectSlot: d.freeObjectSlots?.pop(), ty, ow: ty === 12 ? -1 : OWNER[ty], x, z, hy: 1536 + ri(w, 128),
    angle: a, dr: 0, da: 0, po: 4, pa: 0, st: 3, tf: false, tc: -1, ot: 0,
  };
  if (ty === 12) o.ot = 4 + ri(w, 3);
  o.dr = ri(w, 8) + 4;
  o.da = (a + 0x800 + d.dir * -0x200) & 4095;
  d.B.push(o);
  emit(w, 'spawn', x * DD_S, -z * DD_S, o.ow, 1);
}

function spawnCrate(w: World, d: RingDingData, slot: number[]) {
  const [a, r] = slot;
  const x = (r * trig(a - 1024)) >> 12, z = (r * trig(a)) >> 12;
  const body = addBody(w, 'crate', -1, x * DD_S, -z * DD_S, 0.7, 1);
  d.C.push({ bid: body.id, objectSlot: d.freeObjectSlots?.pop(), x, z, st: 6, g: 0x40, tf: false, tc: -1,
    item: [PU_MAGNET, PU_HOVER][ri(w, 2)], yaw: 0, ringAngle: a, ringRadius: r });
  emit(w, 'cratespawn', x * DD_S, -z * DD_S);
}

const countOf = (d: RingDingData, ty: number) => d.B.filter((b) => b.ty === ty && [0, 1, 3].includes(b.st)).length;

// ---------- timers (FUN_800b4970) ----------

function timers(w: World, d: RingDingData) {
  const g = occupancy(d);
  if (d.rc > 0) d.rc--;
  let mag = -1, max = 8;
  for (const p of players(d)) if (p.pu === PU_MAGNET) { mag = d.P.indexOf(p); max = 10; if (d.tb > 30) d.tb = 30; }
  const crates = d.C.filter((c) => [0, 1, 3, 6, 7].includes(c.st)).length;
  if (!crates && mag === -1) {
    let t = d.tc - 1;
    if (d.tc === 0) {
      const s = pick(d, g);
      if (s) spawnCrate(w, d, s);
      t = ri(w, 60) + 90;
    }
    d.tc = t;
  }
  if (!d.B.some((b) => b.ty === 12 && [0, 1, 3].includes(b.st))) {
    if (d.tk === 0) {
      const s = pick(d, g);
      if (s) spawnBalloon(w, d, s, 12);
      d.tc = ri(w, 60) + 90;
    } else d.tk--;
  }
  const count = TYPES.reduce((n, ty) => n + countOf(d, ty), 0);
  if (d.tb === 0) {
    if (count < max) {
      let n = 4;
      if (max - count < 4) { n = ri(w, max - count) + 1; d.tb = ri(w, 20) + 30; } else d.tb = ri(w, 10) + 20;
      if (w.params.spawnRate !== 1) d.tb = Math.max(1, Math.round(d.tb / w.params.spawnRate));
      if (mag === -1) {
        for (let i = 0; i < n; i++) {
          const s = pick(d, g);
          if (s) {
            d.col = (d.col + 1) & 3;
            const ty = TYPES[d.col];
            const cnt = countOf(d, ty);
            if (cnt < 2) {
              const human = !d.P[d.col]?.bot;
              if (human && d.t > 300) {
                const r = ri(w, (d.P[d.col]?.skill ?? 20) + 1);
                if (!(cnt === 0 ? r < 9 : r < 7)) return;
              }
              spawnBalloon(w, d, s, ty);
            }
          }
        }
      } else {
        const s = pick(d, g);
        if (s) spawnBalloon(w, d, s, TYPES[mag]);
      }
    } else d.tb = ri(w, 30) + 60;
  } else d.tb--;
}

// ---------- ring (FUN_800b3a3c) ----------

function carryPlayer(p: DDPlayer, speed: number) {
  if (p.h > 0 || p.pu === PU_HOVER) return;
  const position = ddCarry(p.x, p.z, speed);
  if (!position) return;
  [p.x, p.z] = position;
  p.heading = ((p.heading ?? actorYaw(p.face)) + speed) & 0xfff;
  if (p.cpuYaw !== undefined) p.cpuYaw = (p.cpuYaw + speed) & 0xfff;
}

function restoreCratePolar(c: DDCrate, r2: number): [number, number] {
  const radius = (ps1SqrtFixed(r2) + 0x20) >> 6;
  const angle = at2(c.x, c.z);
  // Older snapshots only have the projected origin. Prefer the original spawn radius
  // when its fixed-point projection can reproduce that origin.
  const spawnRadius = 0x500 + 0x140 * Math.round((radius - 0x500) / 0x140);
  if (spawnRadius >= 0x500 && spawnRadius <= 0x8c0 && Math.abs(spawnRadius - radius) <= 2) {
    for (const delta of [0, 1, -1, 2, -2]) {
      const [x, z] = ringPoint(spawnRadius, angle + delta);
      if (x === c.x && z === c.z) return [spawnRadius, angle + delta];
    }
  }
  return [radius, angle];
}

function carryCrate(c: DDCrate, speed: number) {
  if (c.st === 13 && c.g > 0) return;
  const r2 = c.x * c.x + c.z * c.z;
  if (r2 <= FLOOR_R2_MIN || r2 >= FLOOR_R2_MAX) return;
  if (c.ringRadius === undefined || c.ringAngle === undefined) {
    [c.ringRadius, c.ringAngle] = restoreCratePolar(c, r2);
  }
  c.ringAngle = (c.ringAngle + speed) & 0xfff;
  c.yaw = ((c.yaw ?? 0) + speed) & 0xfff;
  [c.x, c.z] = ringPoint(c.ringRadius, c.ringAngle);
}

function ring(d: RingDingData) {
  const target = d.dir * 13;
  d.rs += Math.sign(target - d.rs);
  d.ang -= d.rs * ANGLE;
  for (const p of players(d)) if (p.st !== 3) carryPlayer(p, d.rs);
  for (const c of d.C) carryCrate(c, d.rs);
}

// ---------- player contact and integration ----------

function hurt(w: World, d: RingDingData, q: DDPlayer, by: number) {
  if (q.st >= 2) return;
  enterHit(q);
  if (by < 0) q.kn = 0;
  emit(w, 'punch', q.x * DD_S, -q.z * DD_S, d.P.indexOf(q), 2, by);
}

function enterHit(q: DDPlayer) {
  q.st = 2; q.t = HIT_TICKS - (q.id === 8 ? 1 : 0);
  q.hitFrame = 0;
  q.idleAt = undefined;
  q.landing = 0; q.moving = false; q.tauntAt = undefined;
  q.pu = q.put = 0;
}

function moveBy(p: DDPlayer, speed: number, yaw: number) {
  p.x -= speed * trig(yaw - 0x400) >> 12;
  p.z -= speed * trig(yaw) >> 12;
}

function integrateHorizontal(p: DDPlayer, speed = 0) {
  if (speed) moveBy(p, speed, p.heading ?? actorYaw(p.face));
  if (p.kn > 0) {
    const yaw = p.knockAngle ?? at2(Math.round(-p.kx * 4096), Math.round(-p.kz * 4096));
    moveBy(p, Math.round(p.kn), yaw);
    p.kn = Math.max(0, Math.round(p.kn) - 4);
  }
  limit(p, CT_HULL[p.id - 1][0]);
}

function turnPlayer(p: DDPlayer, heading = p.heading ?? actorYaw(p.face)) {
  const yaw = actorYaw(p.face);
  p.face = -((yaw + (turnDelta(yaw, heading) >> 2)) & 0xfff) * ANGLE;
}

function separate(p: DDPlayer, x: number, z: number, radius: number, jitter?: () => number, push = true) {
  const dx = x - p.x, dz = z - p.z;
  const r2 = dx * dx + dz * dz;
  if (r2 >= radius * radius) return false;
  const distance = ps1SqrtFixed(r2) >> 6;
  if (distance >= radius) return false;
  const penetration = radius - distance + 1;
  let yaw = at2(dx, dz);
  if (jitter && (yaw & 0xff) === 0) yaw += jitter() - 8;
  if (push) moveBy(p, penetration, yaw);
  return true;
}

function shovePlayers(p: DDPlayer, seats: (DDPlayer | null)[]) {
  const [radius, low, high] = CT_HULL[p.id - 1];
  for (const q of seats) {
    if (!q || q === p || q.st === 3 || (!p.moving && q.moving)) continue;
    const [otherRadius, otherLow, otherHigh] = CT_HULL[q.id - 1];
    if (q.h + otherLow >= p.h + high || p.h + low >= q.h + otherHigh) continue;
    separate(p, q.x, q.z, radius + otherRadius);
  }
}

function solidCrate(c: DDCrate) {
  return c.st === 1 || c.st === 11;
}

function touchCrates(w: World, d: RingDingData, p: DDPlayer, slot: number, fullContact: boolean) {
  const [, low, high] = CT_HULL[p.id - 1];
  const jitter = fullContact ? () => ri(w, 16) : undefined;
  for (let i = d.C.length - 1; i >= 0; i--) {
    const c = d.C[i];
    const solid = solidCrate(c);
    if (!solid && !(fullContact && (c.st === 9 || c.st === 12 || c.st === 13))) continue;
    const h = c.st === 13 ? c.g : 0;
    if (p.h + low >= h + 256 || p.h + high <= h) continue;
    if (!separate(p, c.x, c.z, 120 + 128, jitter, !fullContact || p.moving)) continue;
    if (c.flight?.touchable) {
      c.flight.touched = true;
      c.tc = slot;
    } else if (solid) c.tc = slot;
  }
}

function stepHit(p: DDPlayer, seats: (DDPlayer | null)[]) {
  if (p.kn > 0) shovePlayers(p, seats);
  p.hitFrame = (p.hitFrame ?? 0) + 1;
  if (--p.t <= 0) p.st = 0;
}

function spinContact(p: DDPlayer, seats: (DDPlayer | null)[], crates: readonly DDCrate[], slot: number, result: boolean) {
  const heading = p.heading ?? actorYaw(p.face);
  const radial = p.id <= 2 || p.id >= 7;
  if (p.id <= 2) p.face += 0x155 * ANGLE;
  const track = CRATE_ATTACK[p.id - 1];
  const frame = Math.max(0, Math.min(track.length - 1, SPIN_TICKS[p.id] - p.t));
  const [x, z, radius, low, high] = track[frame];
  const yaw = actorYaw(p.face);
  const sin = trig(yaw - 0x400), cos = trig(yaw);
  const cx = p.x + ((x * cos - z * sin) >> 12);
  const cz = p.z + ((-x * sin - z * cos) >> 12);
  const touches = (x: number, z: number, r: number) => (x - cx) ** 2 + (z - cz) ** 2 < (r + radius) ** 2;
  for (const q of seats) {
    if (!q || q === p || q.st === 3) continue;
    const [r, bottom, top] = CT_HULL[q.id - 1];
    if (p.h + low >= q.h + top || q.h + bottom >= p.h + high || !touches(q.x, q.z, r)) continue;
    const towardSpin = at2(p.x - q.x, p.z - q.z);
    if (q.st !== 2 && (radial || Math.abs(turnDelta(heading, towardSpin)) < 0x200)) {
      q.kn = 0x30;
      q.knockAngle = radial ? towardSpin : heading;
      if (!radial) {
        q.heading = heading ^ 0x800;
        if (q.cpuYaw !== undefined) q.cpuYaw = q.heading;
      }
      if (!result) q.pendingHit ??= slot;
    }
    break; // the first intersecting seat owns the query even when the hit is rejected
  }
  for (let i = crates.length - 1; i >= 0; i--) {
    const c = crates[i];
    if (!solidCrate(c) || p.h + low >= 256 || p.h + high <= 0 || !touches(c.x, c.z, 128)) continue;
    if (!radial && Math.abs(turnDelta(heading, at2(p.x - c.x, p.z - c.z))) >= 0x280) continue;
    c.tf = true; c.tc = slot;
    break;
  }
}

function finishSpin(w: World, p: DDPlayer, slot: number) {
  if (--p.t > 0) return;
  p.st = 0;
  if (p.id >= 7) {
    p.landing = DD_LANDING_TICKS[p.id - 1] + 1;
    emit(w, 'land', p.x * DD_S, -p.z * DD_S, slot, 0);
  }
}

/** The falling (or hit) handler tests the previous origin before the vertical integrator runs. */
function snapJumpToFloor(p: DDPlayer) {
  if (p.ph !== 2 || p.h > 0) return false;
  p.h = p.vv = p.ph = 0;
  if (p.st === 0) p.landing = DD_LANDING_TICKS[p.id - 1];
  return true;
}

/** FUN_800860d4 integrates after the state handler, including the first step below the floor. */
function advanceJump(p: DDPlayer, gravity: number, cross: boolean) {
  if (p.ph === 1) {
    const release = !p.bot && !cross && p.vv > 0x40;
    p.vv -= (release ? 0x28 : p.gu) * gravity;
    if (p.vv >= 0) p.h += p.vv;
    else { p.ph = 2; p.vv = 0; }
  } else if (p.ph === 2) {
    p.vv = Math.min(p.v0, p.vv + p.gd * gravity);
    p.h -= p.vv;
  }
}

function stepPlayer(w: World, d: RingDingData, p: DDPlayer, slot: number, inp: InputState, cpu: boolean) {
  if (p.put > 0 && --p.put === 0) p.pu = 0;
  const pressA = inp.a && !p.pA, pressB = inp.b && !p.pB;
  p.pA = inp.a; p.pB = inp.b;
  if (p.st === 3) return;
  if (p.spinLock) p.spinLock--;
  else if (p.spinCost) p.spinCost--;

  const wasMoving = p.moving;
  const wasAirborne = p.ph !== 0;
  const wasSpinning = p.st === 1;
  const hit = p.st === 2;
  const free = p.st === 0;
  const moving = !hit && Math.hypot(inp.x, inp.y) > 0.25;
  p.moving = moving && ((free && p.tauntAt === undefined) || (wasSpinning && p.id <= 2));
  const drive = p.moving; // Native pads set speed before the handler changes state.
  p.heading ??= actorYaw(p.face);
  if (moving) {
    p.heading = cpu ? p.cpuYaw ?? p.heading : humanHeading(inp);
  }

  const touchdown = snapJumpToFloor(p);
  const wasLanding = !!p.landing;
  if (touchdown) {
    if (free) emit(w, 'land', p.x * DD_S, -p.z * DD_S, slot, 0);
  } else if (p.landing) {
    p.landing = p.moving || pressA || (pressB && !p.spinLock) || inp.d ? 0 : p.landing - 1;
  }

  const attackPressed = free && !wasAirborne && pressB;
  const spin = attackPressed && !p.spinLock;
  // The disc clears the previous pad bit on a blocked press. Holding that new press retries it.
  if (attackPressed && p.spinLock) p.pB = false;
  const jump = !hit && !wasAirborne && !spin && pressA;
  const cancelToTaunt = wasSpinning && !jump && inp.d;
  if (wasSpinning && (jump || cancelToTaunt)) {
    p.st = p.t = 0;
    if (cancelToTaunt) p.moving = false;
  }
  if (jump) {
    p.ph = 1; p.vv = p.v0; p.jumpAt = w.tick + 1;
    emit(w, 'jump', p.x * DD_S, -p.z * DD_S, slot);
  } else if (spin) {
    p.spinCost = Math.min(40, (p.spinCost ?? 0) + 15);
    p.spinLock = p.spinCost;
    p.st = 1; p.t = SPIN_TICKS[p.id];
    emit(w, 'punch', p.x * DD_S, -p.z * DD_S, slot, 1);
  }

  if (p.moving || p.ph || p.st || p.landing) p.tauntAt = undefined;
  else if (p.tauntAt !== undefined) {
    if (w.tick - p.tauntAt >= TAUNT_TICKS[p.id - 1]) p.tauntAt = undefined;
  } else if (inp.d) {
    p.tauntAt = w.tick;
    emit(w, 'taunt', p.x * DD_S, -p.z * DD_S, slot);
  }

  if (hit) {
    stepHit(p, d.P);
    if (p.kn > 0) {
      touchBalloons(w, d, p, slot, true);
      touchCrates(w, d, p, slot, true);
    }
    touchCrates(w, d, p, slot, false);
    touchBalloons(w, d, p, slot, false);
  } else if (!jump && !spin && !cancelToTaunt && (wasSpinning || wasAirborne || p.moving || wasLanding)) {
    if (wasSpinning) spinContact(p, d.P, d.C, slot, false);
    shovePlayers(p, d.P);
    touchCrates(w, d, p, slot, true);
    touchBalloons(w, d, p, slot, true);
    if (wasSpinning) finishSpin(w, p, slot);
  } else if (!jump && !spin && !wasMoving && p.tauntAt === undefined) {
    touchCrates(w, d, p, slot, false);
    touchBalloons(w, d, p, slot, false);
  }
  if (!wasSpinning || jump || cancelToTaunt || p.id > 2) turnPlayer(p);
  advanceJump(p, w.params.gravity, !hit && p.pA);
  integrateHorizontal(p, drive ? Math.round(p.spd * w.params.speed) : 0);
  if (p.moving || p.ph || p.st || p.landing || p.tauntAt !== undefined) p.idleAt = undefined;
  else p.idleAt ??= w.tick + 1;
}

type RingResultPlayer = DDPlayer & { entered: number; hidden: boolean };
type RingResultEvent = GameEvent & { balloonType?: number };

function stepResultPlayer(p: RingResultPlayer, slot: number, players: (RingResultPlayer | null)[],
                          w: World, d: RingDingData, tick: number, winner: number | undefined) {
  if (p.hidden) return;
  if (winner !== undefined && p.entered < 0 && !p.ph && p.st !== 2) {
    p.entered = tick;
    p.pu = p.put = 0;
  }
  const wasMoving = p.moving;
  p.moving = false;
  if (p.entered < 0) {
    const touchdown = snapJumpToFloor(p);
    const spin = p.st === 1, hit = p.st === 2;
    if (hit) {
      stepHit(p, players);
      if (p.kn > 0) {
        touchBalloons(w, d, p, slot, true);
        touchCrates(w, d, p, slot, true);
      }
      touchCrates(w, d, p, slot, false);
      touchBalloons(w, d, p, slot, false);
    } else if (p.ph || spin || p.landing) {
      if (spin) spinContact(p, players, d.C, slot, true);
      shovePlayers(p, players);
      touchCrates(w, d, p, slot, true);
      touchBalloons(w, d, p, slot, true);
    } else if (!wasMoving && p.tauntAt === undefined) {
      touchCrates(w, d, p, slot, false);
      touchBalloons(w, d, p, slot, false);
    }
    if (p.landing && !touchdown) p.landing--;
    if (spin) finishSpin(w, p, slot);
    if (tick >= RESULT_TURN_LOCK && (!spin || p.id > 2)) turnPlayer(p);
    advanceJump(p, w.params.gravity, false);
  } else if (slot !== winner) {
    const resultTick = tick - p.entered;
    if (0x1000 - DD_LOSE_SCALE_STEP * resultTick < DD_LOSE_MIN_SCALE) {
      p.hidden = true;
      p.st = 3;
      return;
    }
    if (resultTick >= 8) turnPlayer(p);
  }
  integrateHorizontal(p);
  if (p.put > 0 && --p.put === 0) p.pu = 0;
}

function stepResultBalloon(w: World, d: RingDingData, o: DDBalloon,
                           players: (RingResultPlayer | null)[]): boolean {
  if (o.st !== 9) {
    if (o.st === 0 || o.st === 3) {
      o.st = o.st === 3 ? 0 : 1;
      o.tf = false; // These entry states skip the touch check in FUN_800b6044.
    }
    moveBalloon(w, d, o, true);
    return true;
  }

  // State 9 retains a touch already queued at dispatch. Forced clearing has no toucher.
  const p = players[o.tc];
  const owner = p && d.rc > 0 ? d.rcO : o.ow;
  const x = o.x * DD_S, z = -o.z * DD_S;
  const event: RingResultEvent = { id: w.evId++, t: w.tick, k: 'pop', x, z, s: o.tc, v: o.hy * DD_S,
    o: o.ty === 12 ? -1 : owner, balloonType: o.ty };
  w.ev.push(event);
  if (o.ty === 12) blackEffect(w, d, o);
  else if (p && owner === o.tc) d.score[o.tc] = Math.min(999, d.score[o.tc] + 1);
  else if (p) {
    // The native wrong-colour state can interrupt a player who has entered their win pose.
    enterHit(p);
    p.entered = -1;
    emit(w, 'hurt', x, z, o.tc);
  }
  return false;
}

/** Continue the stage on a render-owned copy after placements have been decided. */
export function createRingDingResult(w: World, winner: number | undefined) {
  const d = w.data as RingDingData;
  const players = d.P.map((p, slot): RingResultPlayer | null => p && {
    ...p, st: d.st[slot], entered: -1, hidden: false,
    heading: p.heading ?? actorYaw(p.face), pendingHit: undefined,
  });
  const crates = new Map(d.C.map(c => [c.bid, { ...c, flight: c.flight && { ...c.flight } }]));
  const data = { ...d, dir: 0, P: players, C: [...crates.values()], B: d.B.map(o => ({ ...o })),
    score: [...d.score], shown: [...(d.shown ?? d.score)], itemActors: d.itemActors?.map(a => a && { ...a }),
    random: d.random && [...d.random] } satisfies RingDingData;
  const balloons = new Map(data.B.map(o => [o.bid, o]));
  const replay = { ...w, data, ev: [] as RingResultEvent[] };
  let tick = 0;
  return {
    players, crates, balloons, shown: data.shown,
    get itemActors() { return data.itemActors; },
    get angle() { return data.ang; },
    balloonSlot(o: DDBalloon) {
      return o.ty !== 12 && data.rcO < 0 ? o.ow : dispSlot(data, o);
    },
    advance(frame: number) {
      replay.ev = [];
      while (tick < frame) {
        tick++;
        replay.tick++;
        data.rs -= Math.sign(data.rs);
        data.ang -= data.rs * ANGLE;
        players.forEach((p, slot) => {
          if (p && !p.hidden && slot !== winner) carryPlayer(p, data.rs);
        });
        for (const c of data.C) carryCrate(c, data.rs);
        for (const slot of nextPlayerOrder(replay.rng, data)) {
          const p = players[slot];
          if (!p) continue;
          const equipped = p.pu ? p.put : 0;
          stepResultPlayer(p, slot, players, replay, data, tick, winner);
          trackCrateActor(replay, data, p, slot, equipped, tick, slot === winner);
        }
        updateArenaObjects(replay, data, { tick, winner, players, balloons, crates });
        for (let s = 0; s < data.shown.length; s++) {
          data.shown[s] += Math.sign(data.score[s] - data.shown[s]);
        }
      }
      return replay.ev;
    },
  };
}

// ---------- balloons (FUN_800b6044 / FUN_800b6608 / FUN_800b6ec0) ----------

function avoidAndMagnet(d: RingDingData, o: DDBalloon) {
  for (let s = 0; s < MAX_SEATS; s++) {
    const p = d.P[s];
    if (!p || p.pu !== PU_MAGNET || p.st === 3) continue;
    if (d.rc === 0 || d.rcO !== s ? o.ow === s : d.rc > 29) {
      const dx = p.x - o.x, dz = p.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0x1e40000) {
        const k = ps1SqrtFixed(d2) >> 9;
        const a = at2(dx, dz);
        o.x += (k * trig(a - 1024)) >> 12;
        o.z += (k * trig(a)) >> 12;
      }
    }
  }
  for (let i = d.B.length - 1; i >= 0; i--) {
    const q = d.B[i];
    if (q === o || q.ty > 12 || q.ty < 8 || q.hy >= o.hy + BALLOON_TOP || q.hy <= o.hy + BALLOON_BOTTOM - 256) continue;
    const dx = q.x - o.x, dz = q.z - o.z;
    const dist = ps1SqrtFixed(dx * dx + dz * dz) >> 6;
    if (dist < 0x100) {
      const a = at2(dx, dz);
      o.x -= ((0xff - dist) * trig(a - 1024)) >> 12;
      o.z -= ((0xff - dist) * trig(a)) >> 12;
    } else if (dist < 0x400) {
      o.po = (0x400 - dist) >> 6;
      o.pa = at2(dx, dz);
    }
  }
}

/** Native signed vertical draw offset, in PS1 world units. */
export function ddBalloonBob(angle: number, tick: number) {
  const phase = angle + tick * 16;
  return (trig(4 * phase - 1024) + trig(phase)) >> 6;
}

function moveBalloon(w: World, d: RingDingData, o: DDBalloon, clearing = false) {
  if (o.tf) { o.st = 9; o.tf = false; }
  if (clearing) { o.tc = -1; o.tf = true; }
  o.pa = (at2(-o.x, -o.z) + d.rs) & 4095;
  o.po = 4;
  o.x -= (o.dr * trig(o.da - 1024)) >> 12;
  o.z -= (o.dr * trig(o.da)) >> 12;
  const radius = o.st === 0 ? 0 : BALLOON_RADIUS;
  if (limit(o, radius)) o.da = (o.da - d.dir * 0x200) & 4095;
  avoidAndMagnet(d, o);
  o.x -= (o.po * trig(o.pa - 1024)) >> 12;
  o.z -= (o.po * trig(o.pa)) >> 12;
  recolourCue(w, d, o);
  const diff = 768 - o.hy;
  if (Math.abs(diff) > 16) o.hy += diff >> 6;
}

/** FUN_800b6044 / FUN_800b6608: in the last 30 recolour ticks a colour balloon shows its own colour while bit 1 of the timer is
 *  set. The first such balloon of each bright phase plays 0x5ef (no position, 0x1000 / 0x1e00); a dark phase re-arms it. */
function recolourCue(w: World, d: RingDingData, o: DDBalloon) {
  if (o.ty === 12 || d.rc === 0 || d.rc >= 30) return;
  if (!(d.rc & 2)) { d.rcCue = 0; return; }
  if (!d.rcCue) emit(w, 'flash', 0, 0, -1);
  d.rcCue = 1;
}

function blackEffect(w: World, d: RingDingData, o: DDBalloon) {
  const s = o.tc;
  if (s !== -1) {
    const bot = !!d.P[s]?.bot;
    const k = d.P[s]?.skill ?? 20;
    const u1 = WEIGHT[k] ?? 0, u2 = WEIGHT[32 - k] ?? 0;
    let u3 = u1, u4 = u2, iv = (u2 >> 1) + 1;
    if (bot) { u3 = u2; u4 = u1; iv = (u1 >> 1) + 1; }
    const r = ri(w, u3 + 1 + u4 + 1 + iv);
    o.ot = 4;
    if (r > u4 + 1) o.ot = 5;
    if (r > u4 + 1 + iv) o.ot = 6;
  }
  if (o.ot === 5) {
    for (const q of d.B) if (q.ty >= 8 && q.ty < 12 && q.ow !== o.tc) { q.tc = -1; q.tf = true; }
    emit(w, 'black', o.x * DD_S, -o.z * DD_S, o.tc, 0);
  } else if (o.ot === 6) {
    d.dir = -d.dir;
    emit(w, 'black', o.x * DD_S, -o.z * DD_S, o.tc, 1);
    emit(w, 'reverse', 0, 0, o.tc, d.dir);
  } else {
    d.rc = 150; d.rcO = o.tc;
    emit(w, 'black', o.x * DD_S, -o.z * DD_S, o.tc, 2);
  }
}

function popBalloon(w: World, d: RingDingData, o: DDBalloon) {
  const ds = dispSlot(d, o);
  const xw = o.x * DD_S, zw = -o.z * DD_S;
  emit(w, 'pop', xw, zw, o.tc, o.hy * DD_S, ds);
  if (o.ty === 12) { blackEffect(w, d, o); return; }
  const s = o.tc;
  if (s < 0 || s > 3) return;
  const owner = d.rc === 0 ? o.ow : d.rcO;
  if (owner === s) {
    d.score[s]++;
    emit(w, 'score', xw, zw, s, 1);
  } else {
    const p = d.P[s];
    if (p) hurt(w, d, p, -1);
    emit(w, 'hurt', xw, zw, s, 1);
  }
}

function updateBalloon(w: World, d: RingDingData, o: DDBalloon): boolean {
  limit(o, o.st === 3 || o.st === 0 ? 0 : BALLOON_RADIUS);
  if (o.st === 9) { popBalloon(w, d, o); return false; }
  if (o.st === 3) o.st = 0;
  else if (o.st === 0) o.st = 1;
  moveBalloon(w, d, o);
  return true;
}

interface RingResultObjects {
  tick: number;
  winner: number | undefined;
  players: (RingResultPlayer | null)[];
  balloons: Map<number, DDBalloon>;
  crates: Map<number, DDCrate>;
}

const objectSlot = (o: DDBalloon | DDCrate) => o.objectSlot ?? o.bid;

/** FUN_8007906c queues callbacks by ascending pool slot. Free slots are reused last-freed first. */
function updateArenaObjects(w: World, d: RingDingData, result?: RingResultObjects) {
  const queue = [...d.B, ...d.C].sort((a, b) => objectSlot(a) - objectSlot(b));
  for (const actor of queue) {
    if ('ty' in actor) {
      const keep = result ? stepResultBalloon(w, d, actor, result.players) : updateBalloon(w, d, actor);
      if (keep) continue;
      d.B.splice(d.B.indexOf(actor), 1);
      result?.balloons.delete(actor.bid);
    } else {
      if (updateCrate(w, d, actor, result?.tick, result?.winner)) continue;
      d.C.splice(d.C.indexOf(actor), 1);
      result?.crates.delete(actor.bid);
    }
    if (!result) {
      (d.freeObjectSlots ??= []).push(objectSlot(actor));
      const body = w.bodies.find(body => body.id === actor.bid);
      if (body) body.alive = false;
    }
  }
}

// The clock and the players wait for GO. The ring, spawners and balloon objects do not.
const initialArena = { rs: 0, dir: 1, ang: 0, tc: 300, tk: 400, tb: 30, col: 0, cur: 0 };

function advanceOpening(w: World, frames: number) {
  const d = w.data as RingDingData;
  for (let tick = 0; tick < frames; tick++) {
    timers(w, d);
    ring(d);
    updateArenaObjects(w, d);
    sync(w, d);
  }
  w.ev = [];
}

/** Rebuild the countdown locally from the same shuffled slots and pre-countdown RNG as the host. */
export function createRingDingOpening(w: World) {
  const settled = w.data as RingDingData;
  if (settled.openingRng === undefined || w.tick !== 0) return;
  const bodies = w.bodies.filter(b => b.kind === 'player').map(b => ({ ...b }));
  const d: RingDingData = { ...settled, ...initialArena, B: [], C: [], freeObjectSlots: undefined, P: settled.P.map(p => p && { ...p }) };
  const replay = { ...w, rng: settled.openingRng, bodies, data: d, nextId: Math.max(0, ...bodies.map(b => b.id)) + 1, evId: 1, ev: [] };
  let elapsed = 0;
  return {
    advance(frame: number) {
      const target = Math.max(elapsed, Math.min(DD_INTRO_TICKS, frame));
      if (target > elapsed) advanceOpening(replay, target - elapsed);
      elapsed = target;
      return replay;
    },
  };
}

/** FUN_800ba514 / FUN_800baf1c, before the player integrators. */
function touchBalloons(w: World, d: RingDingData, p: DDPlayer, slot: number, fullContact: boolean) {
  const [, low, high] = CT_HULL[p.id - 1];
  const jitter = fullContact ? () => ri(w, 16) : undefined;
  for (let i = d.B.length - 1; i >= 0; i--) {
    const o = d.B[i];
    // A state-9 balloon still has its cylinder, but the update cleared its touch mask.
    if (o.st !== 1 && !(fullContact && o.st === 9)) continue;
    if (p.h + high <= o.hy + BALLOON_BOTTOM || o.hy + BALLOON_TOP <= p.h + low) continue;
    if (separate(p, o.x, o.z, 120 + BALLOON_RADIUS, jitter, !fullContact || p.moving) && o.st === 1) {
      o.tc = slot;
      o.tf = true;
    }
  }
}

// ---------- crates (FUN_800b54cc) ----------

const DD_CRATE_BREAK_SOUNDS = [0x3f5, 0x3f5, 0x3f7, 0x3f8];
const DD_WIN_LOAD = [15, 14, 13, 15, 15, 15, 15, 14];

function itemMarker(p: DDPlayer, a: DDItemActor | null | undefined) {
  return onFootItemMarker(p.id, a?.script ?? 1, a?.frame ?? 0);
}

function trackCrateActor(w: World, d: RingDingData, p: DDPlayer | RingResultPlayer, slot: number, carried: number,
                         resultTick = 0, won = false) {
  const actors = d.itemActors ??= d.P.map(() => null);
  const previous = actors[slot];
  const entered = 'entered' in p ? p.entered : -1;
  const hidden = 'hidden' in p && p.hidden;
  const age = resultTick - entered;
  let script = p.st === 2 ? 0x2b : p.st === 1 ? 10 : p.ph ? 0x2c : p.landing ? 8 :
    p.moving ? 5 : p.tauntAt !== undefined ? 2 : 1;
  if (entered >= 0) script = won ? (age < DD_WIN_LOAD[p.id - 1] ? 12 : 13) : 1;
  const a = actors[slot] = {
    script, frame: previous?.script === script ? previous.frame + 1 : 0,
    yaw: previous?.yaw ?? 0, offset: 0,
    visible: !!(carried && p.pu && !hidden),
    source: previous?.source,
  };
  if (script === 0x2b && p.hitFrame !== undefined) a.frame = p.hitFrame;
  else if (script === 10) a.frame = Math.max(0, SPIN_TICKS[p.id] - p.t);
  else if (script === 0x2c && p.jumpAt !== undefined) a.frame = Math.max(0, w.tick + (resultTick ? 0 : 1) - p.jumpAt) + 1;
  else if (script === 8) a.frame = DD_LANDING_TICKS[p.id - 1] + 1 - p.landing!;
  else if (script === 2) a.frame = w.tick - p.tauntAt!;
  else if (script === 12) a.frame = age;
  else if (script === 13) a.frame = age - DD_WIN_LOAD[p.id - 1] + 1;
  if (carried && (p.pu || carried === 1) && !hidden) a.yaw = (a.yaw + 0xaa) & 0xfff;
  const marker = itemMarker(p, a);
  const scale = entered >= 0 && !won ? Math.max(0, 0x1000 - DD_LOSE_SCALE_STEP * age) : 0x1000;
  a.offset = marker ? -((-marker[1] * scale) >> 12) + 0x40 : itemFallbackHeight(p.id);
}

const itemFallbackHeight = (char: number) => char < 3 ? 0x180 : char < 5 ? 0x200 : 0x280;

export function ddHeldItem(p: DDPlayer, actor: DDItemActor | null | undefined) {
  return {
    kind: p.pu === PU_HOVER ? 1 : p.pu === PU_MAGNET ? 2 : 0,
    visible: actor?.visible ?? p.put > 0,
    height: p.h + (actor?.offset ?? itemFallbackHeight(p.id)),
    yaw: -(actor?.yaw ?? 0) * ANGLE,
    source: actor?.source,
    elapsed: Math.max(0, (p.pu === PU_HOVER ? 240 : 300) - p.put),
  };
}

/** FUN_80025e00 chooses the nearest surface under the horizontal probe, even when approaching from below. */
function crateFloor(d: RingDingData, probe: { x: number; z: number }, h: number, skip?: DDCrate) {
  let floor = 0;
  for (const c of d.C) {
    if (c === skip || (!solidCrate(c) && c.st !== 9 && c.st !== 12 && c.st !== 13)) continue;
    const top = (c.st === 13 ? c.g : 0) + 0x100;
    if (Math.abs(top - h) < Math.abs(floor - h) && dist2(c, probe) < (128 + 64) ** 2) floor = top;
  }
  return floor;
}

function flightTarget(d: RingDingData, p: DDPlayer | RingResultPlayer, slot: number, resultTick: number, won: boolean) {
  const marker = itemMarker(p, d.itemActors?.[slot]);
  let height = p.h;
  let yaw = actorYaw(p.face);
  const entered = 'entered' in p ? p.entered : -1;
  const age = resultTick - entered;
  if (entered >= 0) {
    height = crateFloor(d, p, 0x200);
    if (won) for (let i = 0; i < Math.min(age, 32); i++) yaw = (yaw + (turnDelta(yaw, 0) >> 2)) & 0xfff;
  }
  if (!marker) return [p.x, height + 0x180, p.z, height];
  const scale = entered >= 0 && !won ? Math.max(0, 0x1000 - DD_LOSE_SCALE_STEP * age) : 0x1000;
  const [x, h, z] = marker;
  const sin = (trig(yaw - 1024) * scale) >> 12, cos = (trig(yaw) * scale) >> 12;
  return [p.x + ((x * cos + z * sin) >> 12), height - ((-h * scale) >> 12), p.z + ((-x * sin + z * cos) >> 12), height];
}

function flyCrate(w: World, d: RingDingData, c: DDCrate, resultTick: number, winner: number | undefined) {
  const p = d.P[c.tc];
  if (!p || limit(c, 128)) return false;
  const flight = c.flight ??= { speed: 0, rising: false }; // older snapshots were already homing
  let collected = !!flight.touched;
  if (!flight.rising) {
    flight.touchable = true;
    const [x, h, z, origin] = flightTarget(d, p, c.tc, resultTick, c.tc === winner);
    const dx = c.x - x, dz = c.z - z;
    c.x -= dx >> 2; c.g += (h - c.g) >> 2; c.z -= dz >> 2;
    const [radius, bottom, top] = CT_HULL[p.id - 1];
    collected ||= (dx >> 3) === 0 && (dz >> 3) === 0 ||
      (!('hidden' in p && p.hidden) && c.g < origin + top && c.g + 256 > origin + bottom &&
        dist2(c, p) < (128 + radius) ** 2);
  }
  flight.speed = Math.max(0, Math.min(0xf0, flight.speed + (flight.rising ? -4 : 4)));
  c.g += flight.rising ? flight.speed : -flight.speed;
  flight.rising = flight.speed > 0 && flight.rising;
  c.yaw = ((c.yaw ?? 0) + 0x71) & 0xfff;
  if (flight.rising) return true;
  const floor = crateFloor(d, c, c.g, c);
  if (!collected && c.g > floor) return true;
  c.g = Math.max(c.g, floor);
  p.pu = c.item; p.put = c.item === PU_HOVER ? 240 : 300;
  const actor = d.itemActors?.[c.tc];
  if (actor) actor.source = c.bid;
  emit(w, 'crate', c.x * DD_S, -c.z * DD_S, c.tc, c.item === PU_HOVER ? 1 : 2);
  return false;
}

function updateCrate(w: World, d: RingDingData, c: DDCrate, resultTick = 0, winner?: number): boolean {
  limit(c, 128);
  switch (c.st) {
    case 3: c.st = 6; break;
    case 6:
      c.yaw = 0;
      c.g += 0x200;
      if (c.g > 0xfff) { c.g = 0x1000; c.st = 0; }
      break;
    case 7:
      c.g = Math.min(0x1000, c.g + 0x100);
      if (c.g === 0x1000) c.st = 0;
      break;
    case 0: c.st = 1; c.tc = -1; break;
    case 1: case 11:
      if (c.tf) { if (c.tc >= 0) c.st = 9; c.tf = false; }
      break;
    case 9:
      c.st = 12;
      emit(w, 'cratehit', c.x * DD_S, -c.z * DD_S, c.tc, 1, DD_CRATE_BREAK_SOUNDS[ri(w, 4)]);
      break;
    case 12: {
      const p = d.P[c.tc];
      if (p) {
        const skill = p.skill ?? 20;
        const a = p.bot ? skill : 32 - skill;
        c.item = ri(w, 32) <= a ? PU_MAGNET : PU_HOVER;
      }
      c.st = 13; c.g = 0; c.flight = { speed: 0x60, rising: true };
      break;
    }
    case 13: return flyCrate(w, d, c, resultTick, winner);
  }
  return true;
}

// ---------- CPU pad synthesis (US overlay 0720, FUN_800b7508) ----------

enum CpuMode { Search = 1, Object = 2, Rival = 3, Wait = 6, Jump = 13, Taunt = 21 }
interface RingDingCpu {
  mode: CpuMode;
  target: number; // object body id, or 0
  rival: number; // seat, or -1
  timer: number;
  cooldown: number;
  taunt: number;
  heading: number;
  pad: number;
}

const CPU_CONTROL = Symbol('Ring Ding CPU control');
const cpuRequest = { ...IDLE, [CPU_CONTROL]: true };
const CPU_DIR = [0x10, 0x30, 0x20, 0x60, 0x40, 0xc0, 0x80, 0x90]; // 0x80051244
const JUMP = 0x4000, SPIN = 0x8000, TAUNT = 0x1000;
type CpuObject = DDBalloon | DDCrate;

function newCpu(rng: [number, number]): RingDingCpu {
  return { mode: CpuMode.Search, target: 0, rival: -1, timer: 8, cooldown: 30 + drawDiscRandom(rng, 60), taunt: 0, heading: 0, pad: 0 };
}

const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const isCrate = (o: CpuObject): o is DDCrate => !('ty' in o);
const liveRival = (p: DDPlayer | null | undefined): p is DDPlayer => !!p && p.st !== 3;
const taunting = (p: DDPlayer) => p.st === 0 && p.ph === 0 && p.tauntAt !== undefined;
const idle = (p: DDPlayer) => p.st === 0 && p.ph === 0 && !p.moving && !p.landing && !taunting(p);

/** FUN_800b85a4 uses one distance roll for the entire scan. */
function selectCpuTarget(d: RingDingData, slot: number, p: DDPlayer, ai: RingDingCpu, objects: CpuObject[],
  skill: number, draw: (n: number) => number) {
  draw(0x100); // the original consumes this draw and discards it
  const roll = draw(0x1000);
  const noise = 33 - skill;
  const foreign = d.rc > 0 && d.rcO !== slot;
  const distanceWeight = (o: { x: number; z: number }) => Math.abs((ps1SqrtFixed(dist2(p, o)) >> 6) - roll);

  let own = foreign ? 0 : (skill + 20) * 4;
  let crate = foreign ? skill << 4 : 30;
  let black = 30;
  let rival = foreign ? skill << 5 : skill << 3;
  if (p.pu === PU_MAGNET) {
    own = foreign ? noise * 4 : skill << 5;
    crate = d.rc > 0 ? noise * 2 : noise * 4;
    black = foreign ? skill << 5 : d.rc > 0 ? noise * 4 : noise * 2;
    rival = skill << 3;
  } else if (p.pu === PU_HOVER) {
    own = foreign ? noise * 4 : skill << 5;
    crate = d.rc > 0 ? noise * 4 : noise * 8;
    black = foreign ? skill << 5 : d.rc > 0 ? skill << 6 : noise * 8;
    rival = foreign ? skill << 4 : skill << 3;
  }

  let score = 0, target = 0;
  for (const o of objects) {
    let value = 0;
    if (isCrate(o) || o.ty === 12) {
      value = distanceWeight(o) * (isCrate(o) ? crate : black);
      // The loop in b85a4 rechecks this CPU's pointer four times.
      if (o.bid === ai.target) value >>= 4;
    } else if (!foreign && o.ow === slot) {
      value = distanceWeight(o) * own;
    }
    if (value > score) { score = value; target = o.bid; }
  }
  let rivalScore = 0, opponent = -1;
  for (let s = 0; s < MAX_SEATS; s++) {
    const q = d.P[s];
    if (s === slot || !liveRival(q) || !(taunting(q) || q.pu)) continue;
    let value = distanceWeight(q) * rival;
    if (ai.rival >= 0) value >>= 4; // applies to every rival while this CPU has a rival target
    if (value > rivalScore) { rivalScore = value; opponent = s; }
  }
  if (target === 0 && opponent === -1) return false;
  ai.target = score > rivalScore ? target : 0;
  ai.rival = ai.target ? -1 : opponent;
  ai.mode = ai.target ? CpuMode.Object : CpuMode.Rival;
  return true;
}

/** FUN_800bb230: closest active object, with a forward cylinder for crates. */
function nearbyCpuObject(p: DDPlayer, objects: CpuObject[]) {
  const yaw = actorYaw(p.face);
  const forward = { x: p.x - (trig(yaw - 0x400) >> 4), z: p.z - (trig(yaw) >> 4) };
  let near: CpuObject | undefined;
  let closest = 0x400 * 0x400;
  for (const o of objects) {
    if (o.st !== 1) continue;
    const crate = isCrate(o);
    const dd = dist2(o, crate ? forward : p);
    if (dd < closest && (!crate || dd < 0x10000)) { near = o; closest = dd; }
  }
  return near;
}

/** FUN_800864cc with mask 0x40. The first overlapping seat can block a spin. */
function nearbyCpuRival(d: RingDingData, p: DDPlayer) {
  const [r, bottom, top] = CT_HULL[p.id - 1];
  return d.P.findIndex((q) => {
    if (!liveRival(q) || q === p) return false;
    const [qr, qb, qt] = CT_HULL[q.id - 1];
    return p.h + bottom < q.h + qt && q.h + qb < p.h + top && dist2(p, q) < (r + qr) ** 2;
  });
}

function tickCpu(d: RingDingData, slot: number, p: DDPlayer, ai: RingDingCpu, objects: CpuObject[], rng: [number, number]) {
  const draw = (n: number) => drawDiscRandom(rng, n);
  const skill = p.skill ?? 20, noise = 33 - skill;
  if (ai.cooldown > 0) ai.cooldown--;
  if (ai.timer > 0) ai.timer--;
  if (ai.taunt > 0) ai.taunt--;
  if (p.st === 2) {
    ai.target = 0; ai.rival = -1;
    ai.mode = CpuMode.Wait; ai.timer = 5;
  }

  const chance = draw(0x100);
  const object = ai.target ? objects.find((o) => o.bid === ai.target && o.st === 1) : undefined;
  if (object) ai.rival = -1;
  const rival = d.P[ai.rival];
  const target = object ?? (liveRival(rival) && rival.st !== 2 ? rival : undefined);
  if (target) {
    let x = target.x + noise * 16 - draw(noise * 32);
    let z = target.z + noise * 16 - draw(noise * 32);
    const polar = at2(x, z);
    const lead = turnDelta(polar, at2(p.x, p.z)) * d.dir;
    if (p.pu !== PU_HOVER && p.ph === 0 && lead > 40) {
      const radius = (ps1SqrtFixed(x * x + z * z) + 0x20) >> 6;
      const a = polar - noise * d.dir;
      x = radius * trig(a - 0x400) >> 12;
      z = radius * trig(a) >> 12;
    }
    const a = at2(x - p.x, z - p.z) & 0xfff;
    const steer = (heading = a) => {
      ai.heading = heading;
      return CPU_DIR[heading >> 9];
    };
    const corrected = p.pu !== PU_HOVER && lead > 0 && (x !== p.x || z !== p.z)
      ? (a - Math.trunc(noise * 0x2000 / 360)) & 0xfff : a;

    switch (ai.mode) {
      case CpuMode.Object:
      case CpuMode.Rival: {
        if (p.ph !== 0) return steer();
        const chasingObject = ai.mode === CpuMode.Object;
        if (Boolean(object) !== chasingObject) {
          ai.mode = chasingObject ? CpuMode.Rival : CpuMode.Object;
          if (!chasingObject) ai.timer = noise;
          return 0;
        }
        let buttons = 0;
        const close = nearbyCpuRival(d, p);
        if (!chasingObject && close === ai.rival) {
          ai.mode = CpuMode.Search; ai.rival = -1; ai.timer = noise;
          if (d.P[close]?.st !== 2) buttons |= SPIN;
        } else if (close >= 0 && d.P[close]?.st !== 2
          && (chasingObject ? draw(3) === 0 : (chance & 0x10) === 0)) {
          buttons |= SPIN;
          if (chasingObject) { ai.mode = CpuMode.Search; ai.timer = noise; }
        }
        const nearby = nearbyCpuObject(p, objects);
        if (nearby) {
          if (isCrate(nearby)) buttons |= SPIN;
          else if (nearby.ty === 12 || nearby.ow === slot) {
            ai.mode = CpuMode.Jump; ai.target = nearby.bid; ai.rival = -1;
            // In object chase, black or a different type keeps the running timer.
            if (!chasingObject || (object && !isCrate(object) && nearby.ty !== 12 && nearby.ty === object.ty)) ai.timer = 8;
            buttons |= JUMP;
          }
        }
        return buttons | steer(chasingObject ? corrected : a);
      }
      case CpuMode.Jump:
        if (ai.timer !== 0 || p.ph !== 0) return JUMP | steer();
        ai.mode = CpuMode.Search; ai.timer = noise; ai.rival = -1; ai.target = 0;
        return 0;
      case CpuMode.Wait:
        if (ai.timer === 0 && idle(p)) { ai.mode = CpuMode.Search; ai.timer = 5; }
        return 0;
      case CpuMode.Taunt:
        if (ai.timer !== 0) return 0;
        if (!taunting(p)) {
          ai.mode = CpuMode.Search; ai.timer = noise; ai.rival = -1;
          return 0;
        }
        if (d.P.some((q) => q !== p && q?.cpu?.rival === slot && dist2(p, q) < 0x240000)) {
          ai.mode = CpuMode.Search; ai.timer = noise; ai.rival = -1;
        }
        return steer();
    }
  } else {
    ai.target = 0;
    ai.mode = CpuMode.Search;
    ai.timer = noise;
  }

  if (!idle(p)) return 0;
  const rivals = d.P.flatMap((q, s) => s !== slot && liveRival(q) ? [s] : []);
  let far = false;
  if (p.pu === 0 && ai.cooldown === 0 && ai.taunt === 0) {
    const nearest = rivals.reduce((best, s) => Math.min(best, dist2(p, d.P[s]!)), 0x7fffff);
    far = nearest < 0x7fffff && (ps1SqrtFixed(nearest) >> 6) > skill * 32 + 0x400;
  }
  if (!far && selectCpuTarget(d, slot, p, ai, objects, skill, draw)) return 0;

  // Party gives each eligible rival the same weight (16) in FUN_800b8b5c.
  ai.rival = rivals[draw(rivals.length * 16) >> 4] ?? -1;
  if (far || draw(noise) >= 9) {
    ai.mode = CpuMode.Taunt; ai.timer = 4; ai.taunt = far ? (skill + 8) * 30 : 300;
    return TAUNT;
  }
  ai.mode = CpuMode.Rival;
  return 0;
}

function cpuPad(d: RingDingData, p: DDPlayer, slot: number, objects: CpuObject[], rng: [number, number]): InputState {
  const ai = p.cpu ??= newCpu(rng);
  // FUN_800136bc latches the last pad before b7508 writes this tick's aim and next pad.
  const pad = ai.pad;
  ai.pad = tickCpu(d, slot, p, ai, objects, rng);
  const moving = (pad & 0xf0) !== 0;
  if (moving) p.cpuYaw = (ai.heading + 0x800) & 0xfff;
  else p.cpuYaw ??= actorYaw(p.face);
  return {
    x: moving ? trig(ai.heading - 0x400) / 4096 : 0, y: moving ? -trig(ai.heading) / 4096 : 0,
    a: (pad & JUMP) !== 0, b: (pad & SPIN) !== 0, d: (pad & TAUNT) !== 0,
  };
}

// ---------- game ----------

export const ringDing: MiniGame = {
  id: 'ringDing',
  name: 'Ring Ding',
  description: 'Pop balloons of your color to score. Black balloons can reverse the ring. Highest score wins.',
  controls: '{move} run. Tap {a} to hop, hold to jump higher. {b} spin on the ground to hit rivals or open crates. {d} taunt when stopped.',
  maxTime: 90,
  settlesAfterTimeout: true,

  setup(w, slots) {
    const chars = w.data?.chars as number[] | undefined; // optional host override: roster index per slot
    const cpuRng = discRandomState(w.rng);
    const d: RingDingData = {
      t: 0, ...initialArena, score: [0, 0, 0, 0], stun: [0, 0, 0, 0], hover: [0, 0, 0, 0], magnet: [0, 0, 0, 0],
      st: [0, 0, 0, 0], ph: [0, 0, 0, 0], rc: 0, rcO: 0,
      slots: [], P: [null, null, null, null], B: [], C: [], cpuRng, shown: [0, 0, 0, 0], winner: -1, draw: false,
      ...createPlayerDispatch(w.rng),
    };
    d.slots = makeSlots(w);
    d.openingRng = w.rng;
    w.data = d;
    for (const s of slots) {
      const look = Math.max(0, Math.min(LOOK_TO_ID.length - 1, chars?.[s.slot] ?? s.char ?? s.slot));
      const id = LOOK_TO_ID[look];
      const skill = SKILLS[s.level ?? 1] ?? 20;
      const [x, z, yaw] = START[s.slot];
      const heavy = id >= 5;
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, x * DD_S, -z * DD_S, 120 * DD_S * sc, 3 * sc * sc);
      b.face = -yaw * ANGLE;
      d.P[s.slot] = {
        bid: b.id, x, z, h: 0, vv: 0, ph: 0, st: 0, t: 0, id, bot: s.bot, skill,
        v0: s.bot ? 136 : 128, gd: s.bot ? 9 : heavy ? 8 : 6, gu: s.bot ? 11 : heavy ? 13 : 11,
        spd: s.bot ? 50 + (skill >> 2) : 50, pu: 0, put: 0, kx: 0, kz: 0, kn: 0, pA: false, pB: false,
        face: b.face, idleAt: -DD_INTRO_TICKS, cpu: newCpu(cpuRng), cpuYaw: s.bot ? actorYaw(b.face) : undefined,
      };
    }
    advanceOpening(w, DD_INTRO_TICKS);
  },

  step(w, inputs) {
    const d = w.data as RingDingData;
    if (ringDing.isOver(w)) return;
    const seed = w.rng;
    d.t++;
    timers(w, d);
    ring(d);

    const rng = d.cpuRng ??= discRandomState(w.rng);
    // The native list prepends each object, so the newest object wins distance ties.
    const objects = [...d.B, ...d.C].sort((a, b) => b.bid - a.bid);
    for (const s of nextPlayerOrder(seed, d)) {
      const p = d.P[s];
      if (!p) continue;
      const input = inputs[s];
      const cpu = input ? CPU_CONTROL in input : p.bot || p.cpuFallback === true;
      if (!p.bot && cpu) p.cpuFallback = true;
      if (!cpu) {
        if (p.cpuFallback) delete p.cpuFallback;
        if (p.cpuYaw !== undefined) delete p.cpuYaw;
      }
      if (p.pendingHit !== undefined) {
        hurt(w, d, p, p.pendingHit);
        delete p.pendingHit;
      }
      const pad = cpu ? cpuPad(d, p, s, objects, rng) : input ?? IDLE;
      const locked = d.shown && d.t > DD_TICKS + 1;
      const equipped = p.pu ? p.put : 0;
      stepPlayer(w, d, p, s, locked ? IDLE : pad, cpu);
      trackCrateActor(w, d, p, s, equipped);
    }

    updateArenaObjects(w, d);

    // mirrors for the client
    for (let s = 0; s < MAX_SEATS; s++) {
      const p = d.P[s];
      d.stun[s] = p && p.st === 2 ? p.t : 0;
      d.hover[s] = p && p.pu === PU_HOVER ? p.put : 0;
      d.magnet[s] = p && p.pu === PU_MAGNET ? p.put : 0;
      d.st[s] = p ? p.st : 0;
      d.ph[s] = p ? p.ph : 0;
    }
    if (d.shown ? tickVersusTally(d.score, d.shown, d.t, 3) : d.t >= 2700) {
      const order = ringDing.placements(w);
      d.draw = d.score[order[0]] === d.score[order[1]] && !!d.P[order[1]];
      d.winner = d.draw ? -1 : order[0];
      for (const p of players(d)) p.st = 3;
    }
    sync(w, d);
    w.bodies = w.bodies.filter((b) => b.alive);
  },

  isOver(w) {
    const d = w.data as RingDingData;
    return d.shown ? d.draw || d.winner >= 0 : d.t >= 2700;
  },

  isDraw(w, [a, b]) { return w.data.score[a] === w.data.score[b]; },

  placements(w) {
    const d = w.data as RingDingData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  // Party calls this for CPU seats and for disconnected humans. The shared step owns the pad state.
  bot: () => cpuRequest,
};
