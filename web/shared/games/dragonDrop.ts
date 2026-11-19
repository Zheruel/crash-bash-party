import { DISC_CHARACTER } from '../look';
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';

/**
 * DRAGON DROP (Crash Bash level id 27 in the overlay numbering, clock-tower arena). Ported from the decompiled overlay,
 * see re/notes/dragonDrop.md for every constant and the function addresses (FUN_800b....).
 *
 * The simulation runs in PS1 integer units (30 Hz, one tick = one game frame step) and is mirrored into world bodies:
 *   body.x = x * S, body.z = -z * S (PS1 +z points away from the camera), body.y = height above the floor * S, S = 3.4 / 1024.
 * PS1 angles are 4096 per turn; a point at angle a, radius r is (x, z) = r * (-cos a, sin a).
 *
 * Rules: 90 s; jump into balloons of your colour (+1), a wrong colour hurts you (37 tick stun); square = spin attack (hits rivals,
 * opens crates); black balloons: recolour all balloons / pop the others' balloons / reverse the ring; crates give hover boots
 * (240 ticks, the ring does not carry you) or the balloon magnet (300 ticks). The ring (radius 896..2560) carries everyone on
 * the ground; balloons are airborne and not carried. Highest score wins.
 *
 * world.data (DragonDropData): see the interface. Bodies: 'player' (slot), 'balloon' (slot = display colour, -1 black),
 * 'crate' (m = grow 0..1), 'item' (flying power-up; cd 1 hover / 2 magnet).
 * Events: 'pop' (s popper or -1, o display colour or -1 black, v height), 'score' (s), 'hurt' (s), 'black' (s, v 0 pop others / 1 reverse /
 * 2 recolour), 'reverse', 'flash', 'cratehit', 'crate' (s, v 1 hover / 2 magnet), 'punch' (v 1 swing / 2 hit), 'jump', 'spawn'.
 */
export const DD_S = 3.4 / 1024;
export const DD_IN = 838 * DD_S; // hub radius (the ring starts at 896)
export const DD_OUT = 2559 * DD_S; // outer rim of the ring
export const DD_TICKS = 2700; // 1:30 at 30 Hz

const FLOOR_R2_MIN = 0xc3fff; // ring carry: radius^2 in (0xc4000, 0x640001)
const FLOOR_R2_MAX = 0x640001;
const LIMIT = 0x980; // outer limit (FUN_800b8f48)
const TYPES = [11, 8, 9, 10]; // colour rotation: player index -> balloon type (0x800bb88c)
const OWNER: Record<number, number> = { 8: 1, 9: 2, 10: 3, 11: 0 };
const WEIGHT = [...Array(8).fill(16), 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]; // 0x800bb848 (0 beyond)
const SKILL = 20;
const HIT_TICKS = 37;
const PU_HOVER = 0x13;
const PU_MAGNET = 0x17;

/** look.ts CHARACTERS index -> game character id 1..8 (1 crash, 2 coco, 3 cortex, 4 brio, 5 tiny, 6 rilla, 7 dingodile, 8 koala). */
const LOOK_TO_ID = DISC_CHARACTER;
const SPIN_TICKS = [0, 16, 16, 19, 19, 18, 18, 14, 14]; // by character id (tiny/rilla: unmeasured, estimated)

const SIN: number[] = [];
for (let i = 0; i < 4096; i++) SIN.push(Math.round(4096 * Math.sin((i * Math.PI * 2) / 4096)));
const sin = (a: number) => SIN[a & 4095];
/** PS1 angle whose (-cos a, sin a) points along (dx, dz). */
const ang = (dx: number, dz: number) => Math.round((Math.atan2(dz, -dx) * 4096) / (Math.PI * 2)) & 4095;
const ri = (w: World, n: number) => Math.floor(rand(w) * n);

export interface DDPlayer {
  bid: number;
  x: number; z: number; h: number; vv: number;
  /** 0 ground, 1 rising, 2 falling */
  ph: number;
  /** 0 free, 1 spin attack, 2 hit, 3 round over */
  st: number;
  t: number;
  id: number; // game character id 1..8
  bot: boolean;
  v0: number; gd: number; gu: number; spd: number;
  pu: number; put: number;
  kx: number; kz: number; kn: number;
  hits: number[];
  pA: boolean; pB: boolean;
  face: number; // radians, 0 = +z (body space)
}
export interface DDBalloon {
  bid: number; ty: number; ow: number;
  x: number; z: number; hy: number;
  dr: number; da: number; po: number; pa: number;
  st: number; tf: boolean; tc: number; ot: number;
}
export interface DDCrate {
  bid: number; x: number; z: number;
  /** 3 spawned, 0 init, 6 growing, 1 idle, 9 hit, 12 opening, 13 flying */
  st: number; g: number; tf: boolean; tc: number; item: number;
}
export interface DragonDropData {
  t: number;
  /** ring angular speed (4096/turn per tick) and target direction */
  rs: number; dir: number;
  /** accumulated ring angle (radians, three.js rotation.y) */
  ang: number;
  score: number[];
  /** ticks left: hit stun, hover, magnet */
  stun: number[]; hover: number[]; magnet: number[];
  /** per slot: 0 free, 1 spinning, 2 hit, 3 over (mirror of P[].st) and 0 ground / 1 rising / 2 falling */
  st: number[]; ph: number[];
  /** recolour effect: ticks left and owner */
  rc: number; rcO: number;
  tc: number; tk: number; tb: number; col: number; cur: number;
  slots: number[][];
  P: (DDPlayer | null)[];
  B: DDBalloon[]; C: DDCrate[];
  winner: number; draw: boolean;
}

const players = (d: DragonDropData) => d.P.filter((p): p is DDPlayer => !!p);

function sync(w: World, d: DragonDropData) {
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
  }
}

function dispSlot(d: DragonDropData, o: DDBalloon): number {
  if (o.ty === 12) return -1;
  if (d.rc > 0) return d.rc < 30 && (d.rc & 2) ? o.ow : d.rcO;
  return o.ow;
}

/** Ring carry of a ground point: rotates by the ring speed and rounds the radius like FUN_800b3a3c. */
export function ddCarry(x: number, z: number, rs: number): [number, number] | null {
  const r2 = x * x + z * z;
  if (!(r2 < FLOOR_R2_MAX && r2 > FLOOR_R2_MIN)) return null;
  const r = (Math.floor(Math.sqrt(r2) * 64) + 0x20) >> 6;
  const a = (ang(x, z) + rs) & 4095;
  return [(r * sin(a - 1024)) >> 12, (r * sin(a)) >> 12];
}

/** Outer limit (FUN_800b8f48): clamp to radius 0x980, returns true when clamped. */
function limit(o: { x: number; z: number }): boolean {
  if (o.x * o.x + o.z * o.z < LIMIT * LIMIT) return false;
  const a = ang(o.x, o.z);
  o.x = (LIMIT * sin(a - 1024)) >> 12;
  o.z = (LIMIT * sin(a)) >> 12;
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

function occupancy(d: DragonDropData): Uint8Array {
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
function pick(d: DragonDropData, g: Uint8Array): number[] | null {
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

function spawnBalloon(w: World, d: DragonDropData, slot: number[], ty: number) {
  const [a, r] = slot;
  const x = (r * sin(a - 1024)) >> 12, z = (r * sin(a)) >> 12;
  const body = addBody(w, 'balloon', -1, x * DD_S, -z * DD_S, 0.45, 1);
  const o: DDBalloon = {
    bid: body.id, ty, ow: ty === 12 ? -1 : OWNER[ty], x, z, hy: 1536 + ri(w, 128),
    dr: 0, da: 0, po: 4, pa: 0, st: 3, tf: false, tc: -1, ot: 0,
  };
  if (ty === 12) o.ot = 4 + ri(w, 3);
  o.dr = ri(w, 8) + 4;
  o.da = (a + 0x800 + d.dir * -0x200) & 4095;
  d.B.push(o);
  emit(w, 'spawn', x * DD_S, -z * DD_S, o.ow, 1);
}

function spawnCrate(w: World, d: DragonDropData, slot: number[]) {
  const [a, r] = slot;
  const x = (r * sin(a - 1024)) >> 12, z = (r * sin(a)) >> 12;
  const body = addBody(w, 'crate', -1, x * DD_S, -z * DD_S, 0.7, 1);
  d.C.push({ bid: body.id, x, z, st: 3, g: 0x40, tf: false, tc: -1, item: [PU_MAGNET, PU_HOVER][ri(w, 2)] });
}

const countOf = (d: DragonDropData, ty: number) => d.B.filter((b) => b.ty === ty && [0, 1, 3].includes(b.st)).length;

// ---------- timers (FUN_800b4970) ----------

function timers(w: World, d: DragonDropData) {
  const g = occupancy(d);
  if (d.rc > 0) d.rc--;
  let mag = -1, max = 8;
  for (const p of players(d)) if (p.pu === PU_MAGNET) { mag = d.P.indexOf(p); max = 10; if (d.tb > 30) d.tb = 30; }
  const crates = d.C.filter((c) => [0, 1, 3, 6].includes(c.st)).length;
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
                const r = ri(w, SKILL + 1);
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

function ring(d: DragonDropData) {
  const target = d.dir * -13;
  if (d.rs !== target) d.rs += d.rs < target ? 1 : -1;
  d.ang += (-d.rs * Math.PI * 2) / 4096;
  for (const p of players(d)) {
    if (p.st === 3 || p.ph !== 0 || p.pu === PU_HOVER) continue;
    const c = ddCarry(p.x, p.z, d.rs);
    if (c) { p.x = c[0]; p.z = c[1]; p.face += (-d.rs * Math.PI * 2) / 4096; }
  }
  for (const c of d.C) {
    if (c.st === 13) continue;
    const q = ddCarry(c.x, c.z, d.rs);
    if (q) { c.x = q[0]; c.z = q[1]; }
  }
}

// ---------- players ----------

function hurt(w: World, d: DragonDropData, q: DDPlayer, fromX: number | null, fromZ: number | null, by: number) {
  if (q.st >= 2) return;
  q.st = 2; q.t = HIT_TICKS; q.hits = [];
  q.kn = 0;
  if (fromX !== null && fromZ !== null) {
    const dx = q.x - fromX, dz = q.z - fromZ, l = Math.hypot(dx, dz) || 1;
    q.kx = dx / l; q.kz = dz / l; q.kn = 52;
  }
  emit(w, 'punch', q.x * DD_S, -q.z * DD_S, d.P.indexOf(q), 2, by);
}

function stepPlayer(w: World, d: DragonDropData, p: DDPlayer, slot: number, inp: InputState) {
  if (p.put > 0 && --p.put === 0) p.pu = 0;
  const pressA = inp.a && !p.pA, pressB = inp.b && !p.pB;
  p.pA = inp.a; p.pB = inp.b;
  if (p.st === 3) return;
  const free = p.st === 0;
  // jump
  if (free && p.ph === 0 && pressA) { p.ph = 1; p.vv = p.v0; emit(w, 'jump', p.x * DD_S, -p.z * DD_S, slot); }
  // spin attack
  if (free && p.ph === 0 && pressB) {
    p.st = 1; p.t = SPIN_TICKS[p.id]; p.hits = [];
    emit(w, 'punch', p.x * DD_S, -p.z * DD_S, slot, 1);
  }
  // run (full air control, instant velocity, d-pad style: fixed speed in the stick direction)
  if (p.st === 0) {
    const l = Math.hypot(inp.x, inp.y);
    if (l > 0.25) {
      const sp = p.spd * w.params.speed;
      p.x += Math.round((inp.x / l) * sp);
      p.z += Math.round((-inp.y / l) * sp);
      p.face = Math.atan2(inp.x, inp.y);
    }
  } else if (p.st === 1) {
    p.face += (0x155 * Math.PI * 2) / 4096;
    p.t--;
    // hits (hitbox mask 0x400): rivals within reach are hurt once per spin, crates open
    for (const q of players(d)) {
      if (q === p || q.st >= 2 || p.hits.includes(d.P.indexOf(q))) continue;
      if (Math.hypot(q.x - p.x, q.z - p.z) < 300) { p.hits.push(d.P.indexOf(q)); hurt(w, d, q, p.x, p.z, slot); }
    }
    for (const c of d.C) if ((c.st === 1 || c.st === 0) && Math.hypot(c.x - p.x, c.z - p.z) < 330) { c.tf = true; c.tc = slot; }
    if (p.t <= 0) p.st = 0;
  } else if (p.st === 2) {
    if (p.kn > 0) { p.x += Math.round(p.kx * p.kn); p.z += Math.round(p.kz * p.kn); p.kn = Math.max(0, p.kn - 4.3); }
    if (--p.t <= 0) p.st = 0;
  }
  // vertical (jump: rise v -= gu while v > 0, then fall with v += gd)
  if (p.ph === 1) {
    p.vv -= p.gu * w.params.gravity;
    if (p.vv > 0) p.h += p.vv; else { p.ph = 2; p.vv = 0; }
  } else if (p.ph === 2) {
    p.vv += p.gd * w.params.gravity;
    p.h -= p.vv;
    if (p.h <= 0) { p.h = 0; p.ph = 0; p.vv = 0; }
  }
  limit(p);
}

function collidePlayers(d: DragonDropData) {
  const ps = players(d);
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.st === 3 || b.st === 3) continue;
      const dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz);
      if (dist >= 240) continue;
      const nx = dist < 1 ? 1 : dx / dist, nz = dist < 1 ? 0 : dz / dist, push = (240 - dist) / 2;
      a.x -= Math.round(nx * push); a.z -= Math.round(nz * push);
      b.x += Math.round(nx * push); b.z += Math.round(nz * push);
    }
  }
}

// ---------- balloons (FUN_800b6044 / FUN_800b6608 / FUN_800b6ec0) ----------

function avoidAndMagnet(d: DragonDropData, o: DDBalloon) {
  for (let s = 0; s < MAX_SEATS; s++) {
    const p = d.P[s];
    if (!p || p.pu !== PU_MAGNET || p.st === 3) continue;
    if (d.rc === 0 || d.rcO !== s ? o.ow === s : d.rc > 29) {
      const dx = p.x - o.x, dz = p.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0x1e40000) {
        const k = Math.floor(Math.sqrt(d2) * 64) >> 9;
        const a = ang(dx, dz);
        o.x += (k * sin(a - 1024)) >> 12;
        o.z += (k * sin(a)) >> 12;
      }
    }
  }
  for (const q of d.B) {
    if (q === o || q.ty > 12 || q.ty < 8 || Math.abs(q.hy - o.hy) >= 256) continue;
    const dx = q.x - o.x, dz = q.z - o.z;
    const dist = Math.floor(Math.sqrt(dx * dx + dz * dz));
    if (dist < 0x100) {
      const a = ang(dx, dz);
      o.x -= ((0xff - dist) * sin(a - 1024)) >> 12;
      o.z -= ((0xff - dist) * sin(a)) >> 12;
    } else if (dist < 0x400) {
      o.po = (0x400 - dist) >> 6;
      o.pa = ang(dx, dz);
    }
  }
}

function moveBalloon(d: DragonDropData, o: DDBalloon) {
  if (o.tf) { o.st = 9; o.tf = false; }
  o.pa = (ang(-o.x, -o.z) + d.rs) & 4095;
  o.po = 4;
  o.x -= (o.dr * sin(o.da - 1024)) >> 12;
  o.z -= (o.dr * sin(o.da)) >> 12;
  if (limit(o)) o.da = (o.da - d.dir * 0x200) & 4095;
  avoidAndMagnet(d, o);
  o.x -= (o.po * sin(o.pa - 1024)) >> 12;
  o.z -= (o.po * sin(o.pa)) >> 12;
  const diff = 768 - o.hy;
  if (Math.abs(diff) > 16) o.hy += diff >> 6;
}

function blackEffect(w: World, d: DragonDropData, o: DDBalloon) {
  const s = o.tc;
  if (s !== -1) {
    const bot = !!d.P[s]?.bot;
    const k = Math.max(0, Math.min(32, SKILL));
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

function popBalloon(w: World, d: DragonDropData, o: DDBalloon) {
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
    if (p) hurt(w, d, p, null, null, -1);
    emit(w, 'hurt', xw, zw, s, 1);
  }
}

function updateBalloon(w: World, d: DragonDropData, o: DDBalloon): boolean {
  if (o.st === 9) { popBalloon(w, d, o); return false; }
  if (o.st === 3) o.st = 0;
  else if (o.st === 0) o.st = 1;
  else moveBalloon(d, o);
  return true;
}

function touchBalloons(d: DragonDropData) {
  for (let s = 0; s < MAX_SEATS; s++) {
    const p = d.P[s];
    if (!p || p.st !== 0 || p.ph === 0) continue;
    for (const o of d.B) {
      if (o.st !== 1 && o.st !== 9) continue;
      const dx = o.x - p.x, dz = o.z - p.z;
      if (dx * dx + dz * dz >= 248 * 248) continue;
      const dy = o.hy - p.h;
      if (dy < 0 || dy > 720) continue;
      o.tc = s; o.tf = o.st === 1;
    }
  }
}

// ---------- crates (FUN_800b54cc) ----------

function updateCrate(w: World, d: DragonDropData, c: DDCrate): boolean {
  switch (c.st) {
    case 3: c.st = 6; break;
    case 6:
      c.g += 0x200;
      if (c.g > 0xfff) { c.g = 0x1000; c.st = 0; }
      break;
    case 0: c.st = 1; break;
    case 1:
      if (c.tf) { if (c.tc >= 0) c.st = 9; c.tf = false; }
      break;
    case 9:
      c.st = 12;
      emit(w, 'cratehit', c.x * DD_S, -c.z * DD_S, c.tc, 1);
      break;
    case 12: {
      const s = c.tc;
      const bot = !!d.P[s]?.bot;
      const a = bot ? SKILL : 32 - SKILL; // threshold: r <= a gives the magnet, else hover boots (32 values)
      c.item = ri(w, 32) <= a ? PU_MAGNET : PU_HOVER;
      c.st = 13; c.g = 0;
      break;
    }
    case 13: {
      const p = d.P[c.tc];
      if (!p) return false;
      const ty = p.h + 0x180;
      const dx = c.x - p.x, dz = c.z - p.z;
      c.x -= dx >> 2; c.z -= dz >> 2; c.g -= (c.g - ty) >> 2;
      if (Math.abs(dx) < 120 && Math.abs(dz) < 120) {
        p.pu = c.item; p.put = c.item === PU_HOVER ? 240 : 300;
        emit(w, 'crate', c.x * DD_S, -c.z * DD_S, c.tc, c.item === PU_HOVER ? 1 : 2);
        return false;
      }
      break;
    }
  }
  return true;
}

// ---------- game ----------

export const dragonDrop: MiniGame = {
  id: 'dragonDrop',
  name: 'Dragon Drop',
  description: 'Jump to burst the balloons in YOUR colour on the spinning clock-tower ring. Black balloons shake things up!',
  controls: 'A: jump (burst balloons). B: spin attack (hits rivals, opens crates).',
  maxTime: 90,

  setup(w, slots) {
    const chars = w.data?.chars as number[] | undefined; // optional host override: roster index per slot
    const d: DragonDropData = {
      t: 0, rs: 0, dir: 1, ang: 0, score: [0, 0, 0, 0], stun: [0, 0, 0, 0], hover: [0, 0, 0, 0], magnet: [0, 0, 0, 0],
      st: [0, 0, 0, 0], ph: [0, 0, 0, 0], rc: 0, rcO: 0, tc: 300, tk: 400, tb: 30, col: 0, cur: 0,
      slots: [], P: [null, null, null, null], B: [], C: [], winner: -1, draw: false,
    };
    d.slots = makeSlots(w);
    w.data = d;
    for (const s of slots) {
      const look = Math.max(0, Math.min(LOOK_TO_ID.length - 1, chars?.[s.slot] ?? s.char ?? s.slot));
      const id = LOOK_TO_ID[look];
      const a = (s.slot * Math.PI) / 2 + Math.PI / 4;
      const x = Math.round(Math.sin(a) * 300), z = Math.round(Math.cos(a) * 300);
      const heavy = id >= 5;
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, x * DD_S, -z * DD_S, 120 * DD_S * sc, 3 * sc * sc);
      b.face = Math.atan2(-x, z);
      d.P[s.slot] = {
        bid: b.id, x, z, h: 0, vv: 0, ph: 0, st: 0, t: 0, id, bot: s.bot,
        v0: s.bot ? 136 : 128, gd: s.bot ? 9 : heavy ? 8 : 6, gu: s.bot ? 11 : heavy ? 13 : 11,
        spd: s.bot ? 50 + (SKILL >> 2) : 50, pu: 0, put: 0, kx: 0, kz: 0, kn: 0, hits: [], pA: false, pB: false,
        face: Math.atan2(-x, z),
      };
    }
    sync(w, d);
  },

  step(w, inputs) {
    const d = w.data as DragonDropData;
    if (d.t >= DD_TICKS) return;
    d.t++;
    timers(w, d);
    ring(d);

    for (let s = 0; s < MAX_SEATS; s++) {
      const p = d.P[s];
      if (!p) continue;
      stepPlayer(w, d, p, s, inputs[s] ?? IDLE);
    }
    collidePlayers(d);
    touchBalloons(d);

    d.B = d.B.filter((o) => {
      const keep = updateBalloon(w, d, o);
      if (!keep) { const b = w.bodies.find((q) => q.id === o.bid); if (b) b.alive = false; }
      return keep;
    });
    d.C = d.C.filter((c) => {
      const keep = updateCrate(w, d, c);
      if (!keep) { const b = w.bodies.find((q) => q.id === c.bid); if (b) b.alive = false; }
      return keep;
    });

    // mirrors for the client
    for (let s = 0; s < MAX_SEATS; s++) {
      const p = d.P[s];
      d.stun[s] = p && p.st === 2 ? p.t : 0;
      d.hover[s] = p && p.pu === PU_HOVER ? p.put : 0;
      d.magnet[s] = p && p.pu === PU_MAGNET ? p.put : 0;
      d.st[s] = p ? p.st : 0;
      d.ph[s] = p ? p.ph : 0;
    }
    if (d.t >= DD_TICKS) {
      const order = dragonDrop.placements(w);
      d.draw = d.score[order[0]] === d.score[order[1]] && !!d.P[order[1]];
      d.winner = d.draw ? -1 : order[0];
      for (const p of players(d)) p.st = 3;
    }
    sync(w, d);
    w.bodies = w.bodies.filter((b) => b.alive);
  },

  isOver(w) {
    return (w.data as DragonDropData).t >= DD_TICKS;
  },

  placements(w) {
    const d = w.data as DragonDropData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  bot(w, slot): InputState {
    const d = w.data as DragonDropData;
    const me = d.P[slot];
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (!me || me.st !== 0) return out;
    const dist = (x: number, z: number) => Math.hypot(x - me.x, z - me.z);
    // what pops for me: own colour (or any colour while I own the recolour), nothing else; black balloons are always fine
    const mine = (o: DDBalloon) => o.ty === 12 || (d.rc > 0 ? d.rcO === slot : o.ow === slot);
    let apex = 0;
    for (let v = me.v0 - me.gu; v > 0; v -= me.gu) apex += v;
    const reach = apex + 700; // how high a balloon can be and still be popped by a jump
    let tgt: { x: number; z: number; kind: number; hy: number } | null = null, bs = -1;
    for (const o of d.B) {
      if (o.st !== 1 || !mine(o) || o.hy > reach) continue;
      const dd = dist(o.x, o.z);
      const v = (o.ty === 12 ? 2 : 10) / (dd + 400);
      if (v > bs) { bs = v; tgt = { x: o.x, z: o.z, kind: o.ty === 12 ? 2 : 1, hy: o.hy }; }
    }
    if (me.pu === 0) {
      for (const c of d.C) {
        if (c.st !== 1) continue;
        const dd = dist(c.x, c.z);
        const v = 2 / (dd + 400);
        if (v > bs) { bs = v; tgt = { x: c.x, z: c.z, kind: 3, hy: 0 }; }
      }
    }
    // a rival right next to me: spin
    for (const q of players(d)) {
      if (q === me || q.st >= 2 || d.score[d.P.indexOf(q)] < d.score[slot]) continue;
      if (dist(q.x, q.z) < 260 && me.ph === 0) out.b = true;
    }
    if (!tgt) return out;
    let tx = tgt.x, tz = tgt.z;
    if (tgt.kind !== 3) {
      // lead the drifting balloon a little
      const o = d.B.find((q) => q.x === tgt!.x && q.z === tgt!.z);
      if (o) {
        const t = Math.min(20, dist(o.x, o.z) / me.spd);
        tx -= ((o.dr * sin(o.da - 1024)) >> 12) * -t;
        tz -= ((o.dr * sin(o.da)) >> 12) * -t;
      }
    }
    // aim noise like the original (+-(0x21 - skill) * 16 units, re-rolled about once a second)
    const seed = Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(Math.floor(d.t / 30) + 1, 0x85ebca6b);
    const hash = (k: number) => ((Math.imul(seed ^ k, 0xc2b2ae35) >>> 8) & 0xffff) / 0xffff - 0.5;
    tx += hash(1) * 2 * (0x21 - SKILL) * 16; tz += hash(2) * 2 * (0x21 - SKILL) * 16;
    const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
    if (l > 40) { out.x = dx / l; out.y = -dz / l; }
    if (tgt.kind === 3) { if (l < 280) out.b = true; } else if (me.ph === 0 && l < 420) out.a = true;
    return out;
  },
};
