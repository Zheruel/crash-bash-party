/**
 * TANK WARS (game id 'tankArena', levels 5-8) - rules taken from the decompiled overlay (re/notes/tankWars.md).
 *
 * Everything is simulated in the game's own units (1/512 tile, 30 Hz frame counts, angles 0..4095) and mapped to world
 * units for the bodies: x_w = (x_g - cx) * G, z_w = -(z_g - cz) * G (G = TA_K / 1024), shell face = -yaw * 2pi / 4096.
 *
 * Levels (variant -> level id): swamp = 5 (SWAMP FOX, open pen, hover boats), desert = 6 (4x4 crates, grid driving),
 * jungle = 7 (centre pedestal, free driving), metal = 8 (4x3 raised crates, grid driving).
 *   Stick = d-pad (L5: left/right turn, up thrust), A = fire (square, tap), B = lay a mine (circle).
 * Deviation from the disc: the real turret turns with L1/R1; here it slews towards the stick direction at the real
 * speed (0x40 per frame). CPU tanks run the original AI inside step() (skill from SlotInfo.level).
 *
 * world.data (see Data): lv, f, tk (per tank), shells, mines, flames, bombs, pickups, dropper, spawner, over.
 * Bodies (world units): 'tank' (face = turret yaw, y = hop), 'bullet', 'mine', 'flame', 'bomb', 'pickup' (cd = type),
 * 'dropper'. Events: sfx (v = game sound id, mapped per level by the view), shoot, mine, boom, hit, ko, pickup, spawn,
 * bounce, taunt, shield.
 */
import { DISC_CHARACTER } from '../look';
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const TA_K = 2.6;
export const TA_HP = 99;
const G = TA_K / 1024;

type Spawn = [number, number, number];
export interface Lv {
  id: string; name: string; level: number; W: number; H: number; bx: number; bz: number; cx: number; cz: number;
  spawns: Spawn[]; skill: number[]; tiles: number[];
}
const grid = (W: number, H: number, rows: number[], cols: number[]) => {
  const t = Array<number>(W * H).fill(0);
  for (const r of rows) for (const c of cols) t[r * W + c] = 1;
  return t;
};
const SP: Spawn[] = [[256, 768, 0x800], [768, 3840, 0xc00], [3840, 3328, 0], [3328, 256, 0x400]];
export const TA_LV: Lv[] = [
  { id: 'swamp', name: 'SWAMP FOX', level: 5, W: 9, H: 8, bx: 0x1100, bz: 0xf00, cx: 0x900, cz: 0x800, spawns: SP, skill: [1, 16, 26], tiles: grid(9, 8, [], []) },
  { id: 'desert', name: 'DESERT FOX', level: 6, W: 8, H: 8, bx: 0xf00, bz: 0xf00, cx: 0x800, cz: 0x800, spawns: SP, skill: [16, 24, 32], tiles: grid(8, 8, [1, 3, 4, 6], [1, 3, 4, 6]) },
  { id: 'jungle', name: 'JUNGLE FOX', level: 7, W: 8, H: 8, bx: 0xf00, bz: 0xf00, cx: 0x800, cz: 0x800, spawns: SP, skill: [16, 24, 32], tiles: grid(8, 8, [3, 4], [3, 4]) },
  { id: 'metal', name: 'METAL FOX', level: 8, W: 9, H: 7, bx: 0x1100, bz: 0xd00, cx: 0x900, cz: 0x700, spawns: [[256, 768, 0x800], [768, 3328, 0xc00], [4352, 2816, 0], [3840, 256, 0x400]], skill: [16, 24, 32], tiles: grid(9, 7, [1, 3, 5], [1, 3, 5, 7]) },
];
export const TA_VARIANTS = TA_LV.map((l) => ({ id: l.id, name: l.name }));
export type Block = [number, number, number, number];
export interface TankMap { name: string; hx: number; hz: number; blocks: Block[] }
/** pen half extents and blocked tiles in world units (centred on the pen; z already flipped) */
export const TA_MAPS: Record<string, TankMap> = Object.fromEntries(TA_LV.map((L) => {
  const blocks: Block[] = [];
  L.tiles.forEach((v, i) => { if (v) blocks.push([((i % L.W) * 512 + 256 - L.cx) * G, -(Math.floor(i / L.W) * 512 + 256 - L.cz) * G, 256 * G, 256 * G]); });
  return [L.id, { name: L.name, hx: L.cx * G, hz: L.cz * G, blocks }];
}));
export const taWorld = (variant: string, gx: number, gz: number): [number, number] => {
  const L = TA_LV.find((l) => l.id === variant) ?? TA_LV[0];
  return [(gx - L.cx) * G, -(gz - L.cz) * G];
};

// ---- tables ----
const TAU = Math.PI * 2;
const SIN: number[] = [], COS: number[] = [];
for (let a = 0; a < 4096; a++) { SIN.push(Math.round(4096 * Math.sin((a * TAU) / 4096))); COS.push(Math.round(4096 * Math.cos((a * TAU) / 4096))); }
const sn = (a: number) => SIN[a & 0xfff];
const cs = (a: number) => COS[a & 0xfff];
const sext = (v: number) => (v << 20) >> 20;
const ang = (dx: number, dz: number) => Math.round((Math.atan2(dx, dz) * 4096) / TAU) & 0xfff;
const LIVE_CHAR = DISC_CHARACTER; // look.ts index -> engine character
const SPEED = [28, 28, 24, 24, 26, 26, 24, 24];
const WPN = [9, 9, 11, 11, 10, 10, 8, 8];
const SHOT_SFX = [0x4ca, 0x4cb, 0x4cc, 0x4cd, 0x4ce, 0x4cf, 0x4cf, 0x4d0];
const PAD_OF_OCT = [0x10, 0x30, 0x20, 0x60, 0x40, 0xc0, 0x80, 0x90];
const HULL = [0x800, 0xc00, 0, 0x400]; // grid dir (0 -z, 1 -x, 2 +z, 3 +x) -> hull heading
const DIRBIT = [0x40, 0x80, 0x10, 0x20];
const DVX = [0, -1, 0, 1], DVZ = [-1, 0, 1, 0];
const FREEMOVE: Record<number, number> = { 0x10: 0, 0x30: 0x200, 0x20: 0x400, 0x60: 0x600, 0x40: 0x800, 0xc0: 0xa00, 0x80: 0xc00, 0x90: 0xe00 };
/** shell: [object, damage, effect, life, speed] by weapon id */
const SHELL: Record<number, [number, number, number, number]> = { 11: [20, 10, 90, 74], 8: [20, 12, 63, 54], 10: [30, 11, 75, 44], 9: [20, 13, 135, 44], 2: [60, 4, 30, 200] };
const S_HIT = 0x69, S_DIE = 0x6a, S_DEAD = 0x6b, S_RUN = 0x6e, S_TURN = 0x6f;

interface Ai { mode: number; timer: number; target: number; pad: number; tx: number; tz: number; shoot: number; mref: number; idle: number }
interface Tk {
  x: number; z: number; yaw: number; hull: number; st: number; stT: number; dir: number; tn: number; td: number;
  vx: number; vz: number; bank: number; wpn: number; ammo: number; cd: number; busy: number; busyT: number; pend: number;
  mines: number; mcd: number; hp: number; cpu: boolean; skill: number; char: number; speed: number; pad: number; prev: number;
  aim: number; inv: number; shieldCd: number; dodge: boolean; taunt: number; hy: number; hvy: number; kills: number;
  elim: number; hpAt: number; ai: Ai; body: number; bot: number;
}
interface Sh { id: number; o: number; x: number; z: number; y: number; vx: number; vz: number; vy: number; life: number; flag: number; w: number; spin: number }
interface Mn { id: number; o: number; x: number; z: number; n: number }
interface Fl { id: number; o: number; x: number; z: number; dx: number; dz: number }
interface Bm { id: number; o: number; x: number; z: number; y: number; vx: number; vz: number; vy: number }
/** m 5 = descending (FUN_800be7dc: every pickup comes down at 0x14 / tick under the 0786 part42 crate), 0 = landed (bounces) */
interface Pk { id: number; t: number; x: number; z: number; y: number; vy: number; m: number }
interface Dr { id: number; x: number; z: number; vx: number; flag: number }
/** dropper lanes (z) per level 5..9, one picked by rand(4) at spawn (FUN_800be234, table 0x800ca600) */
const DROP_Z = [[0x100, 0x500, 0xb00, 0xf00], [0x100, 0x500, 0xb00, 0xf00], [0x100, 0x500, 0xb00, 0xf00], [0x100, 0x500, 0x900, 0xd00], [0x300, 0x500, 0x900, 0xd00]];
interface Data {
  variant: string; lv: number; f: number; over: boolean; overF: number; hum: number;
  tk: Tk[]; shells: Sh[]; mines: Mn[]; flames: Fl[]; bombs: Bm[]; pickups: Pk[]; dropper: Dr | null; spawnT: number; par: number; bump: number;
}

const R = (w: World, n: number) => Math.floor(rand(w) * n);
const sfx = (w: World, id: number, x: number, z: number, s = -1) => emit(w, 'sfx', x, z, s, id);
const L_ = (d: Data) => TA_LV[d.lv];
const wallAt = (L: Lv, x: number, z: number) => {
  const c = x >> 9, r = z >> 9;
  return x < 0 || z < 0 || c >= L.W || r >= L.H || L.tiles[r * L.W + c] !== 0;
};
const px = (L: Lv, gx: number) => (gx - L.cx) * G;
const pz = (L: Lv, gz: number) => -(gz - L.cz) * G;

function byId(w: World, id: number): Body | undefined { return w.bodies.find((b) => b.id === id); }
function drop(w: World, id: number) { const i = w.bodies.findIndex((b) => b.id === id); if (i >= 0) w.bodies.splice(i, 1); }
function mk(w: World, d: Data, kind: string, slot: number, gx: number, gz: number, r: number): number {
  const L = L_(d);
  const b = addBody(w, kind, slot, px(L, gx), pz(L, gz), r * G, 1);
  return b.id;
}
const gone = (t: Tk) => t.st === S_DIE || t.st === S_DEAD;
const alive = (t: Tk) => t.hp > 0;

// ---------------------------------------------------------------- damage
function hurt(w: World, d: Data, p: number, dmg: number, by: number) {
  const t = d.tk[p];
  if (d.over || t.inv > 0 || t.hp <= 0 || gone(t) || t.st === S_HIT) return;
  if (dmg < 400) {
    if (d.hum === 0) dmg *= 3;
    else if (t.cpu) dmg = Math.trunc((dmg * ((((0x20 - t.skill) * 0x96) >> 5) + 0x32)) / 100);
  }
  t.st = S_HIT; t.stT = 0; t.hvy = -60; t.hy = 0;
  t.hp -= dmg;
  const L = L_(d);
  emit(w, 'hit', px(L, t.x), pz(L, t.z), p, dmg / TA_HP, by === p ? -1 : by);
  if (t.hp <= 0) {
    t.hpAt = t.hp + dmg; t.hp = 0; t.elim = d.f;
    if (by >= 0 && by !== p) d.tk[by].kills++;
    emit(w, 'ko', px(L, t.x), pz(L, t.z), p, 1, by === p ? -1 : by);
  }
}

// ---------------------------------------------------------------- tanks
/** grid step in direction dir: tank boxes, wall tile, move and snap (0x800b9e20) */
function gridStep(d: Data, p: number, t: Tk) {
  const L = L_(d), sp = t.speed, half = sp >> 1, dir = t.dir, x = t.x, z = t.z;
  for (let o = 0; o < 4; o++) {
    const q = d.tk[o];
    if (o === p || gone(q)) continue;
    let hit: boolean;
    if (dir === 0) hit = Math.abs(x - q.x) <= 0x1c0 && Math.abs(z - sp - q.z) < 0x1c0;
    else if (dir === 1) hit = Math.abs(x - sp - q.x) < 0x1c1 && Math.abs(z - q.z) < 0x1c0;
    else { const m = 0x1c0 - sp; hit = dir === 2 ? Math.abs(x - q.x) <= m && Math.abs(z + sp - q.z) < m : Math.abs(x + sp - q.x) <= m && Math.abs(z - q.z) < m; }
    if (hit) return;
  }
  let wx = x, wz = z;
  if (dir === 0) wz = z - (half + 0x100); else if (dir === 1) wx = x - (half + 0x100); else if (dir === 2) wz = z + 0x100; else wx = x + 0x100;
  if (wallAt(L, wx, wz)) return;
  const snap = (v: number) => { let off = v & 0xff; if (off > 0x80) off -= 0x100; return Math.abs(off) <= half ? v - off : v; };
  if (dir === 1 || dir === 3) t.x = snap(x + DVX[dir] * sp); else t.z = snap(z + DVZ[dir] * sp);
}

function gridMove(d: Data, p: number, t: Tk) {
  const L = L_(d), pad = t.pad;
  if (t.st === S_TURN) {
    t.hull = (t.hull + t.td) & 0xfff;
    if (--t.tn <= 0) { t.st = S_RUN; if (pad & 0xf0) gridStep(d, p, t); }
    return;
  }
  if (!(pad & 0xf0)) return;
  const atC = (t.x & 0x1ff) === 0x100 && (t.z & 0x1ff) === 0x100;
  if (atC) {
    const c = t.x >> 9, r = t.z >> 9;
    const free = (dc: number, dr: number) => { const cc = c + dc, rr = r + dr; return cc >= 0 && rr >= 0 && cc < L.W && rr < L.H && L.tiles[rr * L.W + cc] === 0; };
    const tests: [number, number, boolean][] = [[0x20, 3, free(1, 0)], [0x80, 1, free(-1, 0)], [0x10, 2, free(0, 1)], [0x40, 0, free(0, -1)]];
    for (const [bit, want, ok] of tests) {
      if (!(pad & bit) || !ok) continue;
      if (t.dir === want) break;
      const from = t.dir;
      t.dir = want;
      if (((from + 2) & 3) === want) { t.hull = HULL[want]; break; }
      const pos = (want === 3 && from === 2) || (want === 1 && from === 0) || (want === 2 && from === 1) || (want === 0 && from === 3);
      t.td = pos ? 0x80 : -0x80; t.tn = 8; t.st = S_TURN;
      return;
    }
  }
  const opp = (t.dir + 2) & 3;
  if (pad & DIRBIT[opp] && !(pad & DIRBIT[t.dir])) { t.dir = opp; t.hull = HULL[opp]; }
  gridStep(d, p, t);
}

function freeMove(d: Data, p: number, t: Tk) {
  const L = L_(d);
  let pad = t.pad;
  if (L.level === 7) { // centre blockers keep the d-pad from driving into the pedestal
    if (Math.abs(t.x - 2048) < 0x15e && Math.abs(t.z - 2048) < 0x15e) {
      pad &= 2048 < t.x ? ~0x80 : ~0x20;
      pad &= 2048 > t.z ? ~0x10 : ~0x40;
    }
  }
  const target = FREEMOVE[pad & 0xf0];
  if (target === undefined) return;
  let diff = sext(target - ((t.yaw + t.hull) & 0xfff));
  while (Math.abs(diff) > 0x400) { t.hull = (t.hull + 0x800) & 0xfff; diff = sext(target - ((t.yaw + t.hull) & 0xfff)); }
  t.hull = (t.hull + Math.trunc(diff / 4)) & 0xfff;
  const a = (t.yaw + t.hull) & 0xfff;
  let nx = t.x + ((t.speed * sn(a)) >> 12), nz = t.z + ((t.speed * cs(a)) >> 12);
  const prx = nx + (sn(a) >> 4), prz = nz + (cs(a) >> 4);
  if (L.level === 7 && nx >= 0x581 && nx <= 0xa7f && nz > 0x580 && nz < 0xa80) {
    if (nx < 0x5c0) nx = 0x580;
    if (nz < 0x5c0) nz = 0x580;
  }
  for (let o = 0; o < 4; o++) {
    const q = d.tk[o];
    if (o === p || gone(q)) continue;
    if (Math.abs(nx - q.x) < 0x1c1 && Math.abs(nz - q.z) < 0x1c0) return;
  }
  if (!wallAt(L, prx, prz)) { t.x = nx; t.z = nz; }
}

function boatMove(d: Data, p: number, t: Tk) {
  const L = L_(d), pad = t.pad, sp = t.speed;
  const turn = Math.trunc((sp * 3) / 2);
  if (pad & 0x20) { t.yaw = (t.yaw + turn) & 0xfff; t.bank = Math.max(-200, t.bank - 0x14); }
  else if (pad & 0x80) { t.yaw = (t.yaw - turn) & 0xfff; t.bank = Math.min(200, t.bank + 0x14); }
  else if (Math.abs(t.bank) < 3) t.bank = 0; else t.bank += t.bank > 0 ? -10 : 10;
  if (pad & 0xa00) {
    t.vx += (-((sp * sn(t.yaw)) >> 12)) >> 2;
    t.vz += (-((sp * cs(t.yaw)) >> 12)) >> 2;
  }
  t.vx = Math.max(-sp, Math.min(sp, t.vx)); t.vz = Math.max(-sp, Math.min(sp, t.vz));
  let nx = t.x + t.vx, nz = t.z + t.vz;
  if (t.vx <= 0) { if (t.vx !== 0) t.vx++; if (nx < 0x100) { t.vx = -t.vx; nx = 0x100; } }
  else { t.vx--; if (nx > L.bx) { t.vx = -t.vx; nx = L.bx; } }
  if (t.vz <= 0) { if (t.vz !== 0) t.vz++; if (nz < 0x100) { t.vz = -t.vz; nz = 0x100; } }
  else { t.vz--; if (nz > L.bz) { t.vz = -t.vz; nz = L.bz; } }
  for (let o = 0; o < 4; o++) {
    const q = d.tk[o];
    if (o === p || gone(q)) continue;
    if (Math.abs(nx - q.x) < 0x1c1 && Math.abs(nz - q.z) < 0x1c0) {
      q.vx += Math.trunc(t.vx / 2); q.vz += Math.trunc(t.vz / 2);
      t.vx = Math.trunc(t.vx / 4); t.vz = Math.trunc(t.vz / 4);
      return;
    }
  }
  t.x = nx; t.z = nz;
}

// ---------------------------------------------------------------- weapons
function spawnShell(w: World, d: Data, p: number, t: Tk, wpn: number, yaw: number, ox: number, oz: number) {
  const [, , , sp] = SHELL[wpn];
  const L = L_(d);
  const sx = t.x + ((-400 * sn(yaw)) >> 12) + ox + (L.level === 5 ? t.vx : 0);
  const sz = t.z + ((-400 * cs(yaw)) >> 12) + oz + (L.level === 5 ? t.vz : 0);
  const id = mk(w, d, 'bullet', p, sx, sz, 0.1 * 1024);
  const b = byId(w, id)!;
  b.dash = wpn;
  d.shells.push({
    id, o: p, x: sx, z: sz, y: -0x14a, vx: -((sp * sn(yaw)) >> 12), vz: -((sp * cs(yaw)) >> 12), vy: wpn === 10 ? -30 : 0,
    life: SHELL[wpn][2], flag: 1, w: wpn, spin: 0,
  });
}

function fire(w: World, d: Data, p: number, t: Tk) {
  const L = L_(d), wp = t.wpn;
  const rate = Math.max(1, w.params.fireRate);
  if (wp === 3) {
    t.cd = Math.round(60 / rate); t.pend = 4;
  } else if (wp === 2) {
    t.cd = Math.round(10 / rate);
    const px_ = (0x104 * cs(t.yaw)) >> 12, pz_ = -((0x104 * sn(t.yaw)) >> 12);
    spawnShell(w, d, p, t, 2, t.yaw, px_, pz_);
    spawnShell(w, d, p, t, 2, t.yaw, -px_, -pz_);
    sfx(w, 0x522, px(L, t.x), pz(L, t.z), p);
  } else {
    t.cd = Math.round(10 / rate);
    spawnShell(w, d, p, t, wp, t.yaw, 0, 0);
    sfx(w, wp === 11 ? (t.char === 3 ? 0x4cc : 0x4cd) : SHOT_SFX[t.char - 1], px(L, t.x), pz(L, t.z), p);
  }
  t.busy = wp; t.busyT = wp === 2 ? 39 : 13;
  emit(w, 'shoot', px(L, t.x), pz(L, t.z), p, 1);
  if (--t.ammo < 1) { t.wpn = WPN[t.char - 1]; t.ammo = 999; t.cd = 30; }
}

function layMine(w: World, d: Data, p: number, t: Tk) {
  const L = L_(d), X = px(L, t.x), Z = pz(L, t.z);
  if (t.mines <= 0) { if (!t.cpu) sfx(w, 0x4f2, X, Z, p); return; }
  if (t.mcd > 0) { if (!t.cpu) sfx(w, 0x4f1, X, Z, p); return; }
  if (L.level === 5) {
    t.shieldCd = 0;
  } else {
    for (const m of d.mines) if (Math.abs(m.x - t.x) <= 0x101 && Math.abs(m.z - t.z) <= 0x101) m.n = 1;
  }
  const id = mk(w, d, 'mine', p, t.x, t.z, 0x80);
  d.mines.push({ id, o: p, x: t.x, z: t.z, n: 0x78 });
  sfx(w, 0x4e9, X, Z, p); sfx(w, 0x4ec + p, X, Z, p);
  t.mines--; t.mcd = L.level === 5 ? 30 : 120;
  emit(w, 'mine', X, Z, p, 1);
}

// ---------------------------------------------------------------- projectiles
const rndHit = (w: World, x: number, z: number) => sfx(w, 0x4ba + R(w, 4), x, z);
function shellStep(w: World, d: Data, s: Sh): number {
  const L = L_(d);
  const bw = SHELL[s.w][0], fx = SHELL[s.w][1];
  void fx;
  if (L.level === 8 && s.flag !== 1 && wallAt(L, s.x, s.z)) return 1;
  s.x += s.vx; s.z += s.vz;
  if (s.w === 10) { // lob: arcs and hops on the ground
    s.spin = (s.spin + 0x55) & 0xfff;
    s.vy += 12; s.y += s.vy;
    if (s.y > -0x65) { s.y = -0x64 - 0x3c; s.vy = -0x3c; sfx(w, L.level === 5 ? 0x4f7 + R(w, 4) : 0x4d2 + R(w, 6), px(L, s.x), pz(L, s.z)); }
  }
  let bounced = false;
  if (s.x < 0 || s.x > L.bx + 0x100) { if (s.flag !== 1) { s.x -= s.vx; s.vx = -s.vx; bounced = true; } }
  else if (s.z < 0 || s.z > L.bz + 0x100) { if (s.flag !== 1) { s.z -= s.vz; s.vz = -s.vz; bounced = true; } }
  else if (s.y > -400 && wallAt(L, s.x, s.z) && s.flag !== 1) {
    const tcx = (s.x >> 9) * 512 + 256, tcz = (s.z >> 9) * 512 + 256;
    if (Math.abs(s.x - tcx) >= Math.abs(s.z - tcz)) { s.x -= s.vx; s.vx = -s.vx; } else { s.z -= s.vz; s.vz = -s.vz; }
    if (wallAt(L, s.x, s.z)) { if (Math.abs(s.x - tcx) >= Math.abs(s.z - tcz)) { s.z -= s.vz; s.vz = -s.vz; } else { s.x -= s.vx; s.vx = -s.vx; } }
    bounced = true;
  }
  const X = px(L, s.x), Z = pz(L, s.z);
  if (bounced) {
    sfx(w, s.w === 8 ? 0x4e1 + R(w, 3) : 0x4d8 + R(w, 3), X, Z);
    emit(w, 'bounce', X, Z, -1, 0.5);
  }
  for (let i = d.pickups.length - 1; i >= 0; i--) {
    const k = d.pickups[i];
    // FUN_800bf548: (pickup - shot) + 0xff < 0x1ff unsigned on x, z and y = a 511-unit box centred on the shot
    const inBox = (v: number) => v + 0xff >= 0 && v + 0xff < 0x1ff;
    if (inBox(k.x - s.x) && inBox(k.z - s.z) && inBox(k.y - s.y)) {
      sfx(w, 0x4b8, px(L, k.x), pz(L, k.z)); emit(w, 'pkhit', px(L, k.x), pz(L, k.z), -1, 0.5);
      drop(w, k.id); d.pickups.splice(i, 1);
    }
  }
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (gone(t) || t.hp <= 0 && t.st !== S_HIT) continue;
    if (Math.abs(s.x - t.x) < 0x10f && Math.abs(s.z - t.z) < 0x10e) {
      if (L.level === 5 && t.cpu && t.shieldCd === 0 && d.hum > 0 && R(w, 32) < t.skill) { t.dodge = true; return 2; }
      rndHit(w, X, Z);
      hurt(w, d, p, p === s.o ? bw >> 1 : bw, s.o);
      emit(w, 'boom', X, Z, p, 0.6);
      return 2;
    }
  }
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (t.inv > 0 && Math.abs(s.x - t.x) < 0xe1 && Math.abs(s.z - t.z) < 0xe1) return 2;
  }
  s.flag = 0;
  return --s.life <= 0 ? 1 : 0;
}

function explodeMine(w: World, d: Data, m: Mn) {
  const L = L_(d), X = px(L, m.x), Z = pz(L, m.z);
  sfx(w, 0x4ea, X, Z);
  emit(w, 'explode', X, Z, -1, 1.2, m.o);
  if (L.level === 5 || L.level === 7) {
    for (let p = 0; p < 4; p++) { const t = d.tk[p]; if (!gone(t) && Math.abs(t.x - m.x) <= 0x300 && Math.abs(t.z - m.z) < 0x2ff) hurt(w, d, p, 0x3c, m.o); }
  } else {
    for (const [dx, dz] of [[250, 0], [-250, 0], [0, 250], [0, -250]]) {
      const id = mk(w, d, 'flame', m.o, m.x + dx, m.z + dz, 0x60);
      d.flames.push({ id, o: m.o, x: m.x + dx, z: m.z + dz, dx: Math.sign(dx), dz: Math.sign(dz) });
    }
  }
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (Math.abs(t.x - m.x) < 0xfb && Math.abs(t.z - m.z) < 0xfa) { hurt(w, d, p, 0x3c, m.o); break; }
  }
}

function explodeBomb(w: World, d: Data, b: Bm, all: boolean) {
  const L = L_(d), X = px(L, b.x), Z = pz(L, b.z);
  sfx(w, 0x4ba + R(w, 4), X, Z); sfx(w, 0x490 + R(w, 2), X, Z);
  emit(w, 'explode', X, Z, -1, 1.4, b.o);
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (gone(t)) continue;
    if (Math.abs(b.x - t.x) < 0x181 && Math.abs(b.z - t.z) < (all ? 0x181 : 0x180)) { hurt(w, d, p, 0x3c, b.o); if (!all) break; }
  }
}

// ---------------------------------------------------------------- pickups
function spawnPickup(w: World, d: Data, type: number, x: number, y: number, z: number) {
  if (d.pickups.length >= 3) return;
  const L = L_(d);
  const id = mk(w, d, 'pickup', -1, x, z, 0x90);
  byId(w, id)!.cd = type;
  d.pickups.push({ id, t: type, x, z, y, vy: 0, m: 5 });
  sfx(w, 0x4b0 + R(w, 4), px(L, x), pz(L, z));
  emit(w, 'spawn', px(L, x), pz(L, z), -1, 1);
}

function collect(w: World, d: Data, p: number, k: Pk): boolean {
  const t = d.tk[p], L = L_(d), X = px(L, k.x), Z = pz(L, k.z);
  const ty = k.t;
  if (d.over) { sfx(w, 0x4ea, X, Z); return true; }
  if (ty <= 3) {
    t.ammo = t.wpn === ty ? t.ammo + 2 : 2; t.wpn = ty; t.busy = -1;
    sfx(w, ty === 3 ? 0x48e : ty === 2 ? 0x51f : 0x1c2, X, Z, p);
  } else if (ty === 4) { t.hp = Math.min(99, t.hp + 20); sfx(w, 0x1c2, X, Z, p); }
  else if (ty === 5) { t.mines++; sfx(w, 0x4e8, X, Z, p); }
  else if (ty === 6) { hurt(w, d, p, 30, -1); emit(w, 'boom', X, Z, p, 0.6); sfx(w, 0x4ea, X, Z, p); }
  else if (ty === 7) { t.wpn = 3; t.ammo += 1; if (p < 2) t.mines++; sfx(w, 0x1c2, X, Z, p); }
  emit(w, 'pickup', X, Z, p, ty);
  return true;
}

// ---------------------------------------------------------------- AI
const hasHuman = (d: Data) => d.tk.some((t) => !t.cpu && t.hp > 0);
const skillOf = (d: Data, t: Tk) => (d.hum === 0 ? 30 : t.skill);
function pickTarget(w: World, d: Data, p: number): number {
  const c = d.tk.map((t, i) => (i !== p && t.hp > 0 ? i : -1)).filter((i) => i >= 0);
  return c.length ? c[R(w, c.length)] : -1;
}
function freeDir(d: Data, t: Tk, bit: number): boolean {
  const L = L_(d), c = t.x >> 9, r = t.z >> 9;
  const dc = bit === 0x20 ? 1 : bit === 0x80 ? -1 : 0, dr = bit === 0x10 ? 1 : bit === 0x40 ? -1 : 0;
  const cc = c + dc, rr = r + dr;
  return cc >= 0 && rr >= 0 && cc < L.W && rr < L.H && L.tiles[rr * L.W + cc] === 0;
}
const stepTime = (t: Tk, extra: number) => Math.trunc((t.speed / 2 + extra) / t.speed);

function wander(w: World, d: Data, t: Tk) {
  const bits = [0x20, 0x80, 0x10, 0x40], s0 = R(w, 4);
  for (let i = 0; i < 4; i++) {
    const b = bits[(s0 + i) & 3];
    if (freeDir(d, t, b)) { t.ai.pad = b; t.ai.mode = 5; t.ai.timer = stepTime(t, 0x200); return; }
  }
  t.ai.pad = 0; t.ai.mode = 0; t.ai.timer = 15;
}
function seek(w: World, d: Data, t: Tk) {
  let best: Pk | null = null, bd = 0x600;
  for (const k of d.pickups) {
    if (k.t === 6) continue;
    const dd = Math.abs(k.x - t.x) + Math.abs(k.z - t.z);
    if (dd < bd) { bd = dd; best = k; }
  }
  if (best) {
    const dx = best.x - t.x, dz = best.z - t.z;
    const opts: number[] = [];
    const h = Math.abs(dx) > 0x70 ? (dx > 0 ? 0x20 : 0x80) : 0, v = Math.abs(dz) > 0x70 ? (dz > 0 ? 0x10 : 0x40) : 0;
    if (Math.abs(dx) >= Math.abs(dz)) opts.push(h, v); else opts.push(v, h);
    for (const b of opts) if (b && freeDir(d, t, b)) { t.ai.pad = b; t.ai.mode = 5; t.ai.timer = stepTime(t, 0x200); return; }
  }
  wander(w, d, t);
}
/** FUN_800b4240: move away from (ox, oz) (or towards it when `toward`) */
function away(w: World, d: Data, t: Tk, ox: number, oz: number, toward = false): boolean {
  const sg = toward ? -1 : 1;
  const hb = (t.x - ox) * sg >= 0 ? 0x20 : 0x80, vb = (t.z - oz) * sg >= 0 ? 0x10 : 0x40;
  const order = R(w, 2) ? [hb, vb] : [vb, hb];
  for (const b of order) if (freeDir(d, t, b)) { t.ai.pad = b; t.ai.mode = 2; t.ai.timer = stepTime(t, 0x400); return true; }
  return false;
}
function avoidMine(w: World, d: Data, p: number, t: Tk): boolean {
  if (R(w, skillOf(d, t) + 1) < 8 || t.ai.mode === 2 || !d.mines.length) return false;
  const m = d.mines[t.ai.mref++ % d.mines.length];
  if (Math.abs(m.x - t.x) < 0x7ce && Math.abs(m.z - t.z) < 0x7ce) return away(w, d, t, m.x, m.z);
  return false;
}
function decide(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai;
  a.timer = 30; a.target = pickTarget(w, d, p);
  if (avoidMine(w, d, p, t)) return;
  const r = R(w, 8);
  if (r === 0 && R(w, skillOf(d, t) + 1) < 13) { a.timer = R(w, 30) + 15; a.pad = 0; a.mode = 0; return; }
  if (r === 1) { seek(w, d, t); return; }
  if (r === 2 && t.mines > 0) { a.pad |= 0x2000; a.timer = stepTime(t, 0x200); return; }
  if (a.target < 0) { seek(w, d, t); return; }
  const o = d.tk[a.target];
  if (t.cd < 5) {
    a.pad = PAD_OF_OCT[((ang(o.x - t.x, o.z - t.z) + 0x100) >> 9) & 7]; a.mode = 4; a.timer = stepTime(t, 0x200);
  } else if (!(d.hum === 0 && R(w, 256) > 0x40 && away(w, d, t, o.x, o.z, true)) && !away(w, d, t, o.x, o.z)) wander(w, d, t);
}
/** FUN_800b3f44: shoot decision */
function shootGate(w: World, d: Data, t: Tk): boolean {
  const a = t.ai;
  if (d.hum > 0 && R(w, 101) > a.shoot) return false;
  if (a.target < 0 || d.tk[a.target].hp <= 0) return false;
  const L = L_(d);
  if (L.level === 5) {
    const o = d.tk[a.target];
    return Math.abs(sext(ang(t.x - o.x, t.z - o.z) - t.yaw)) < 0x46;
  }
  const h = t.aim >= 0 ? t.aim : t.yaw;
  return !wallAt(L, t.x + ((-0x200 * sn(h)) >> 12), t.z + ((-0x200 * cs(h)) >> 12));
}
function decide5(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai, L = L_(d);
  a.target = pickTarget(w, d, p);
  const seekPt = () => {
    let k: Pk | null = null;
    for (const q of d.pickups) if (Math.abs(t.x - q.x) + Math.abs(t.z - q.z) < 0x600) { k = q; break; }
    if (k) { a.tx = k.x; a.tz = k.z; } else { const i = R(w, 9); a.tx = 512 + (i % 3) * 1536; a.tz = 512 + Math.floor(i / 3) * 1536; }
    a.mode = 4; a.timer = 0x5a;
  };
  const flee = (): boolean => {
    let n = 0, sx = 0, sz = 0;
    d.tk.forEach((q, i) => { if (i !== p && q.hp > 0) { n++; sx += q.x; sz += q.z; } });
    if (n <= 1) return false;
    a.tx = Math.trunc(sx / n) >= 0x800 ? 0x200 : 0xe00; a.tz = Math.trunc(sz / n) >= 0x800 ? 0x200 : 0xe00;
    a.mode = 7; a.timer = 0xb4; return true;
  };
  if (a.target < 0) { if (!flee()) { if (R(w, 100) < 30) seekPt(); else { a.mode = 0; a.timer = 15; a.pad = 0; } } return; }
  if (t.busy >= 0) { seekPt(); return; }
  const r = R(w, 8);
  if (r === 0 && d.hum > 0 && R(w, skillOf(d, t) + 1) < 13) { a.timer = R(w, 30) + 15; a.pad = 0; a.mode = 0; return; }
  if (r <= 4) { a.mode = 6; a.timer = 0x5a; return; }
  if (r <= 6) { if (flee()) return; if (R(w, 100) < 30) { seekPt(); return; } a.mode = 6; a.timer = 0x5a; return; }
  void L; seekPt();
}
function aiFrame(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai, L = L_(d);
  if (L.level === 5) {
    if (--a.timer < 1) decide5(w, d, p, t);
    let pad = 0;
    const o = a.target >= 0 ? d.tk[a.target] : null;
    if (a.mode === 6 && o) {
      const df = sext(ang(t.x - o.x, t.z - o.z) - t.yaw);
      if (df > 0x46) pad = 0x20; if (df < -0x46) pad = 0x80;
    } else if (a.mode === 4 || a.mode === 7) {
      if (Math.abs(t.x - a.tx) < 99 && Math.abs(t.z - a.tz) < 99) a.timer = 0;
      const df = sext(ang(t.x - a.tx, t.z - a.tz) - t.yaw);
      if (df > 0x28) pad = 0x820; if (df < -0x28) pad = 0x880;
    }
    if (shootGate(w, d, t)) pad |= 0x8000;
    if (t.dodge) { pad |= 0x4000; t.dodge = false; }
    t.pad = pad;
    return;
  }
  const tg = a.target >= 0 && d.tk[a.target].hp > 0 ? d.tk[a.target] : null;
  if (tg) t.aim = (ang(tg.x - t.x, tg.z - t.z) + 0x800) & 0xfff;
  if (a.mode === 5 && (t.x & 0x1ff) === 0 && (t.z & 0x1ff) === 0) decide(w, d, p, t);
  if (--a.timer < 1) decide(w, d, p, t);
  else { avoidMine(w, d, p, t); if (shootGate(w, d, t)) a.pad |= 0x8000; }
  if (d.hum > 0 && R(w, skillOf(d, t) + 1) > 8) {
    for (const m of d.mines) {
      const dx = m.x - t.x, dz = m.z - t.z;
      if (Math.abs(dx) >= 250 && Math.abs(dx) <= 500) a.pad &= dx > 0 ? ~0x20 : ~0x80;
      if (Math.abs(dz) >= 250 && Math.abs(dz) <= 500) a.pad &= dz > 0 ? ~0x10 : ~0x40;
    }
  }
  t.pad = a.pad;
}

// ---------------------------------------------------------------- per tank
function humanPad(inp: InputState, lv: number): number {
  let pad = 0;
  if (inp.x > 0.3) pad |= 0x20; else if (inp.x < -0.3) pad |= 0x80;
  if (inp.y < -0.3) pad |= lv === 5 ? 0x800 : 0x10; else if (inp.y > 0.3 && lv !== 5) pad |= 0x40;
  if (inp.a) pad |= 0x8000;
  if (inp.b) pad |= 0x2000;
  if (inp.c) pad |= 0x1000;
  return pad;
}

function tankStep(w: World, d: Data, p: number, t: Tk, inp: InputState) {
  const L = L_(d), lv = L.level;
  const drv = t.cpu || t.bot === d.f; // CPU slot, or a vacated human seat driven by bot()
  if (t.cpu && alive(t)) aiFrame(w, d, p, t);
  else if (!t.cpu) t.pad = alive(t) ? humanPad(inp, lv) : 0;
  const pad = t.pad, prevPad = t.prev, press = pad & ~t.prev;
  t.prev = pad;
  if (t.cd > 0) t.cd -= 1 + (d.hum === 0 && t.cd !== 1 ? 1 : 0);
  if (t.cd < 0) t.cd = 0;
  if (t.mcd > 0) t.mcd--;
  if (t.inv > 0) t.inv--;
  if (t.shieldCd > 0) t.shieldCd--;
  if (t.taunt > 0) t.taunt--;
  if (t.busyT > 0 && --t.busyT === 0) t.busy = -1;
  if (t.pend > 0 && --t.pend === 0) {
    const id = mk(w, d, 'bomb', p, t.x + ((-250 * sn(t.yaw)) >> 12), t.z + ((-250 * cs(t.yaw)) >> 12), 0.28 * 1024);
    d.bombs.push({ id, o: p, x: t.x + ((-250 * sn(t.yaw)) >> 12), z: t.z + ((-250 * cs(t.yaw)) >> 12), y: -300, vx: (-250 * sn(t.yaw)) >> 13, vz: (-250 * cs(t.yaw)) >> 13, vy: -91 });
    sfx(w, 0x4f3, px(L, t.x), pz(L, t.z), p);
    if (t.wpn === 3 && t.ammo < 1) { t.wpn = WPN[t.char - 1]; t.ammo = 999; }
  }
  if (t.st === S_HIT) {
    t.hvy += 12; t.hy += t.hvy;
    if (t.hy > 0) { t.hvy = -Math.trunc(t.hvy / 2); t.hy = 0; }
    if (++t.stT >= 30) {
      t.hy = 0;
      if (t.hp <= 0) { t.st = S_DIE; t.stT = 0; } else t.st = S_RUN;
    }
    return;
  }
  if (t.st === S_DIE) {
    if (++t.stT >= 41) { t.st = S_DEAD; sfx(w, 0x4f0, px(L, t.x), pz(L, t.z), p); emit(w, 'boom', px(L, t.x), pz(L, t.z), p, 1.2); }
    return;
  }
  if (t.st === S_DEAD) return;
  // turret
  if (lv !== 5) {
    if (!drv) {
      if (pad & 0xf0) {
        const dx = ((pad & 0x20) ? 1 : 0) - ((pad & 0x80) ? 1 : 0), dz = ((pad & 0x10) ? 1 : 0) - ((pad & 0x40) ? 1 : 0);
        const tgt = ang(-dx, -dz), df = sext(tgt - t.yaw);
        t.yaw = (t.yaw + Math.max(-0x40, Math.min(0x40, df))) & 0xfff;
      }
    } else if (t.aim >= 0) {
      const df = sext(t.aim - t.yaw);
      t.yaw = (t.yaw + (df >> 2)) & 0xfff;
      if (Math.abs(df >> 2) < 3) t.aim = -1;
    }
  }
  // fire / mine / shield
  if ((press & 0x8000) && t.cd === 0 && t.busy < 0 && d.shells.filter((s) => s.o === p).length < 3) fire(w, d, p, t);
  if (press & 0x2000) layMine(w, d, p, t);
  if ((press & 0x4000) && lv === 5 && t.shieldCd === 0) {
    t.inv = 10; t.shieldCd = d.hum > 0 && t.cpu ? (((0x20 - t.skill) * 0x3c) >> 5) + 0xf : 60;
    sfx(w, 0x510 + p, px(L, t.x), pz(L, t.z), p); emit(w, 'shield', px(L, t.x), pz(L, t.z), p);
  }
  // Triangle held (0x80051388), taunt cooldown run out, in the idle / drive / turn states 0x6c 0x6e 0x6f: clip 0x5a + voice
  if ((pad & 0x1000) && t.taunt <= 0 && (t.st === S_RUN || t.st === S_TURN)) { t.taunt = 0x5a; emit(w, 'taunt', 0, 0, p); }
  // FUN_800b8ec4 -> FUN_800b6ed8: every time a CPU tank stops (enters the idle state 0x6c) a counter (starts rand(30)) goes up;
  // past 0x4f it taunts (clip 0x5a + its taunt voice) and the counter restarts at 0
  if (t.cpu && t.st === S_RUN && (prevPad & 0xf0) && !(pad & 0xf0) && ++t.ai.idle > 0x4f) { t.ai.idle = 0; t.taunt = 0x5a; emit(w, 'taunt', 0, 0, p); }
  // movement
  const sp0 = t.speed;
  t.speed = Math.max(1, Math.round(sp0 * w.params.speed));
  if (lv === 5) boatMove(d, p, t); else if (lv === 7) freeMove(d, p, t); else gridMove(d, p, t);
  t.speed = sp0;
  if (lv === 6 || lv === 8) { if (t.st !== S_TURN && t.hull !== HULL[t.dir] && Math.abs(sext(t.hull - HULL[t.dir])) < 0x80) t.hull = HULL[t.dir]; }
}

// ---------------------------------------------------------------- objects
function objects(w: World, d: Data) {
  const L = L_(d);
  for (let i = d.shells.length - 1; i >= 0; i--) {
    const s = d.shells[i];
    const r = shellStep(w, d, s);
    if (r) {
      if (r === 1) { sfx(w, s.w === 8 ? 0x4e4 : 0x4e7, px(L, s.x), pz(L, s.z)); emit(w, 'fizzle', px(L, s.x), pz(L, s.z), -1, 0.4); }
      drop(w, s.id); d.shells.splice(i, 1);
    }
  }
  for (let i = d.mines.length - 1; i >= 0; i--) {
    const m = d.mines[i];
    let boom = false;
    if (L.level === 8 && wallAt(L, m.x, m.z)) boom = true;
    else { m.n--; if (m.n <= 0) boom = true; else if (m.n % 30 === 0) sfx(w, 0x4eb, px(L, m.x), pz(L, m.z)); }
    if (boom) { d.mines.splice(i, 1); drop(w, m.id); explodeMine(w, d, m); }
  }
  for (let i = d.flames.length - 1; i >= 0; i--) {
    const f = d.flames[i];
    let end = wallAt(L, f.x, f.z);
    for (let k = 0; k < 2 && !end; k++) {
      f.x += f.dx * 250; f.z += f.dz * 250;
      if (f.x < 0x100 || f.x > L.bx + 0x100 || f.z < 0x100 || f.z > L.bz + 0x100 || wallAt(L, f.x, f.z)) { end = true; break; }
      for (let p = 0; p < 4; p++) {
        const t = d.tk[p];
        if (Math.abs(f.x - t.x) < 0xfb && Math.abs(f.z - t.z) < 0xfa && !gone(t)) { hurt(w, d, p, 0x3c, f.o); rndHit(w, px(L, f.x), pz(L, f.z)); end = true; break; }
      }
    }
    if (end) { drop(w, f.id); d.flames.splice(i, 1); }
  }
  for (let i = d.bombs.length - 1; i >= 0; i--) {
    const b = d.bombs[i];
    b.x += b.vx; b.z += b.vz; b.vy += 12; b.y += b.vy;
    let done = false;
    for (let p = 0; p < 4 && !done; p++) {
      const t = d.tk[p];
      if (p !== b.o && !gone(t) && Math.abs(b.x - t.x) < 0x181 && Math.abs(b.z - t.z) < 0x181) { explodeBomb(w, d, b, true); done = true; }
    }
    if (!done && b.vy >= 1 && b.y >= -0x103) { explodeBomb(w, d, b, false); done = true; }
    if (!done && (b.x < -0x400 || b.x > L.bx + 0x500 || b.z < -0x400 || b.z > L.bz + 0x500)) done = true;
    if (done) { drop(w, b.id); d.bombs.splice(i, 1); }
  }
  for (let i = d.pickups.length - 1; i >= 0; i--) {
    const k = d.pickups[i];
    if (wallAt(L, k.x, k.z)) { drop(w, k.id); d.pickups.splice(i, 1); continue; }
    if (k.m === 5) { // FUN_800be988 mode 5: descend, land at -300 (mines under it go off; levels 5-7: script 3 + sfx 0x4b4 + rand(4))
      k.y += 0x14;
      if (k.y > -300) {
        for (const m of d.mines) if (Math.abs(m.x - k.x) <= 0x100 && Math.abs(m.z - k.z) <= 0x100) m.n = 1;
        if (L.level < 8) { emit(w, 'land', px(L, k.x), pz(L, k.z), -1, k.t); sfx(w, 0x4b4 + R(w, 4), px(L, k.x), pz(L, k.z)); }
        k.y = 0; k.vy = -0x28; k.m = 0;
      }
    } else {
      k.vy += 8; k.y += k.vy;
      if (k.y >= 0) { k.y = -1; k.vy = -0x28; k.y -= 0x28; }
    }
    let got = false;
    for (let p = 0; p < 4 && !got; p++) {
      const t = d.tk[p];
      if (gone(t) || t.hp <= 0) continue;
      if (Math.abs(t.x - k.x) < 0x12d && Math.abs(t.z - k.z) < 0x12c && k.y >= -0x2ed) got = collect(w, d, p, k);
    }
    if (!got && d.over) { sfx(w, 0x4ea, px(L, k.x), pz(L, k.z)); got = true; }
    if (got) { drop(w, k.id); d.pickups.splice(i, 1); }
  }
  // dropper (levels 5-7)
  if (d.dropper) {
    const q = d.dropper;
    q.x += q.vx;
    if (q.x + 0x800 >= 0x2001) { drop(w, q.id); d.dropper = null; }
    else if (q.flag === 3 && !d.over && (q.x & 0x1ff) === 0x100 && q.x >= 2 && q.x <= 0xffe) {
      const z = q.z;
      if (!d.pickups.some((k) => k.x === q.x && k.z === z + 0x3c) && R(w, 0x8000) < 0x2800 && d.pickups.length < 3) {
        const dead = d.tk.filter((t) => t.hp < 1).length;
        let ty: number;
        if (R(w, 7000) < 2000 * dead) ty = 6;
        else if (L.level === 7) ty = [5, 4, 2][R(w, 3)];
        else ty = R(w, 1000) < 0x1f5 ? 4 : 5;
        spawnPickup(w, d, ty, q.x, -0x400 - 200, z + 0x3c);
        q.flag = 0;
      }
    }
  }
  // spawner
  if (!d.over && --d.spawnT <= 0) {
    d.spawnT = R(w, 0x78) + 0xb4;
    if (L.level === 8) {
      const SPOTS = L8_SPOTS;
      if (d.pickups.length < 3) {
        const [x, z] = SPOTS[R(w, SPOTS.length)];
        const busy = d.tk.some((t) => t.hp > 0 && Math.abs(t.x - x) < 0x201 && Math.abs(t.z - z) < 0x200) || d.pickups.some((k) => k.x === x && k.z === z);
        if (!busy) { const ty = [5, 4, 3][R(w, 3)]; spawnPickup(w, d, ty, x, -0x400 - 200, z); }
      }
    } else if (!d.dropper) {
      const even = d.par++ % 2 === 0;
      const z = (DROP_Z[L.level - 5] ?? DROP_Z[0])[R(w, 4)];
      const id = mk(w, d, 'dropper', -1, 0x600, z, 0x100);
      d.dropper = { id, x: even ? -0x800 : 0x1800, z, vx: even ? 0x40 : -0x40, flag: 3 };
      sfx(w, 0x4f6, 0, 0);
    }
  }
}
const L8_SPOTS: [number, number][] = [
  [256, 256], [256, 768], [256, 1280], [256, 1792], [256, 2304], [256, 2816], [256, 3328], [1280, 256], [1280, 768], [1280, 1280], [1280, 1792], [1280, 2304], [1280, 2816], [1280, 3328],
  [2304, 256], [2304, 768], [2304, 1280], [2304, 1792], [2304, 2304], [2304, 2816], [2304, 3328], [3328, 256], [3328, 768], [3328, 1280], [3328, 1792], [3328, 2304], [3328, 2816], [3328, 3328],
  [4352, 256], [4352, 768], [4352, 1280], [256, 1792], [256, 2304], [256, 2816], [256, 3328], [256, 768], [256, 1792], [256, 2816], [4352, 768], [4352, 1792], [4352, 2816],
];

function sync(w: World, d: Data) {
  const L = L_(d);
  for (const t of d.tk) {
    const b = byId(w, t.body);
    if (!b) continue;
    b.x = px(L, t.x); b.z = pz(L, t.z); b.y = -t.hy * G;
    b.vx = t.vx * G * 30; b.vz = -t.vz * G * 30;
    b.face = (-t.yaw * TAU) / 4096;
    b.alive = t.hp > 0;
    b.dash = t.inv > 0 ? 1 : 0;
    b.cd = t.cd;
  }
  const put = (id: number, x: number, y: number, z: number, face = 0) => {
    const b = byId(w, id);
    if (!b) return;
    b.x = px(L, x); b.z = pz(L, z); b.y = -y * G; b.face = face;
  };
  for (const s of d.shells) { put(s.id, s.x, s.y, s.z, Math.atan2(s.vx, -s.vz)); const b = byId(w, s.id); if (b) { b.vx = s.vx * G * 30; b.vz = -s.vz * G * 30; } }
  for (const m of d.mines) { put(m.id, m.x, 0, m.z); const b = byId(w, m.id); if (b) b.cd = m.n; }
  for (const f of d.flames) put(f.id, f.x, 0, f.z, Math.atan2(f.dx, -f.dz));
  for (const k of d.bombs) put(k.id, k.x, k.y, k.z);
  for (const k of d.pickups) { put(k.id, k.x, k.y, k.z); const b = byId(w, k.id); if (b) b.dash = k.m; }
  if (d.dropper) put(d.dropper.id, d.dropper.x, -0x400, d.dropper.z); // rides 0x400 up (FUN_800be234)
}

export const tankArena: MiniGame = {
  id: 'tankArena',
  name: 'Tank Wars',
  description: "Destroy all of your opponents' tanks. Fire shells, lay mines, collect pickups. Last tank standing, or most health when time runs out, wins.",
  controls: 'Stick: drive (swamp: left/right turn, up thrust). A: fire (tap). B: lay a mine. E / gamepad Y: taunt.',
  variants: TA_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, TA_VARIANTS);
    const lv = TA_LV.findIndex((l) => l.id === variant);
    const L = TA_LV[lv];
    const d: Data = { variant, lv, f: 0, over: false, overF: -1, hum: 1, tk: [], shells: [], mines: [], flames: [], bombs: [], pickups: [], dropper: null, spawnT: R(w, 0x78) + 0xb4, par: 0, bump: 0 };
    w.data = d;
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = slots.find((q) => q.slot === i);
      const char = LIVE_CHAR[(s?.char ?? i) % LIVE_CHAR.length];
      const [x, z, yaw] = L.spawns[i];
      const dir = yaw === 0x800 ? 2 : yaw === 0xc00 ? 3 : yaw === 0 ? 0 : 1; // grid heading = shell direction
      const lvl = Math.max(0, Math.min(2, s?.level ?? 1));
      const base = SPEED[char - 1];
      const id = mk(w, d, 'tank', i, x, z, 0xe0);
      d.tk.push({
        x, z, yaw, hull: HULL[dir], st: S_RUN, stT: 0, dir, tn: 0, td: 0, vx: 0, vz: 0, bank: 0,
        wpn: WPN[char - 1], ammo: 999, cd: 0, busy: -1, busyT: 0, pend: 0, mines: 3, mcd: 0, hp: TA_HP, cpu: s ? s.bot : true,
        skill: L.skill[lvl], char, speed: L.level === 5 ? Math.trunc((base * 3) / 2) : base, pad: 0, prev: 0, aim: -1, inv: 0, shieldCd: 0,
        dodge: false, taunt: 0, hy: 0, hvy: 0, kills: 0, elim: -1, hpAt: 0,
        ai: { mode: 0, timer: 1, target: -1, pad: 0, tx: 0, tz: 0, shoot: ((L.skill[lvl] * 0x55) >> 5) + 5, mref: 0, idle: R(w, 0x1e) }, body: id, bot: -1,
      });
      byId(w, id)!.face = (-yaw * TAU) / 4096;
    }
  },

  step(w, inputs) {
    const d = w.data as Data;
    d.f++;
    d.hum = hasHuman(d) ? 1 : 0;
    for (let p = 0; p < 4; p++) { const t = d.tk[p]; t.ai.shoot = (((d.hum ? t.skill : 30) * 0x55) >> 5) + 5; tankStep(w, d, p, t, inputs[p] ?? IDLE); }
    objects(w, d);
    // timeout (1:30): the healthiest tank wins, the rest are blown up
    if (!d.over && d.f >= 2700) {
      let best = -1;
      d.tk.forEach((t, i) => { if (t.hp > 0 && (best < 0 || t.hp > d.tk[best].hp)) best = i; });
      d.tk.forEach((t, i) => { if (i !== best && t.hp > 0) { t.hpAt = t.hp; t.hp = 0; t.elim = d.f; t.st = S_DIE; t.stT = 0; emit(w, 'ko', px(L_(d), t.x), pz(L_(d), t.z), i, 1, -1); } });
    }
    if (!d.over && d.tk.filter((t) => t.hp > 0).length <= 1) { d.over = true; d.overF = d.f; }
    sync(w, d);
  },

  isOver(w) {
    const d = w.data as Data;
    return d.over && d.f - d.overF >= 60;
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const A = d.tk[a], B = d.tk[b], aa = A.hp > 0, bb = B.hp > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return B.hp - A.hp || a - b;
      return B.elim - A.elim || B.hpAt - A.hpAt || a - b;
    });
  },

  /** A human seat whose player left (not a CPU slot) is driven through here with the same AI; real CPU slots run it inside step(). */
  bot(w: World, slot: number): InputState {
    const d = w.data as Data;
    const t = d?.tk?.[slot];
    if (!t || t.cpu || t.hp <= 0 || gone(t) || d.over) return IDLE;
    aiFrame(w, d, slot, t);
    const pad = t.pad;
    t.bot = d.f + 1; // step() runs next with d.f + 1: aim like a CPU tank this frame
    const lv5 = L_(d).level === 5;
    return {
      x: pad & 0x20 ? 1 : pad & 0x80 ? -1 : 0,
      y: lv5 ? (pad & 0x800 ? -1 : 0) : pad & 0x10 ? -1 : pad & 0x40 ? 1 : 0,
      a: (pad & 0x8000) !== 0,
      b: (pad & 0x2000) !== 0,
    };
  },
};
