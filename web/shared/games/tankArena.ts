/**
 * TANK WARS (game id 'tankArena', levels 5-8) - rules taken from the decompiled overlay (re/notes/tankWars.md).
 *
 * Everything is simulated in the game's own units (1/512 tile, 30 Hz frame counts, angles 0..4095) and mapped to world
 * units for the bodies: x_w = (x_g - cx) * G, z_w = -(z_g - cz) * G (G = TA_K / 1024), shell face = -yaw * 2pi / 4096.
 *
 * Levels (variant -> level id): swamp = 5 (SWAMP FOX, open pen, hover boats), desert = 6 (4x4 crates, grid driving),
 * jungle = 7 (centre pedestal, free driving), metal = 8 (4x3 raised crates, grid driving).
 *   Stick = d-pad (L5: left/right turn, up thrust), A = fire (square, tap), B = lay a mine (circle), C = taunt (triangle),
 *   L / R (keyboard Q / E) = L1 / R1: turn the turret 0x40 per frame like the disc (R1 also thrusts on L5).
 * Cross activates Swamp Fox's shield. CPU tanks run the original AI inside step().
 *
 * world.data (see Data): lv, f, tk (per tank), shells, mines, flames, bombs, pickups, dropper, spawner, over.
 * Bodies (world units): 'tank' (face = turret yaw, y = hop), 'bullet', 'mine', 'flame', 'bomb', 'pickup' (cd = type),
 * 'dropper'. Events: sfx (v = game sound id, mapped per level by the view), shoot, mine, boom, hit, ko, pickup, spawn,
 * bounce, taunt, shield.
 */
import { DISC_CHARACTER, winnerCheerFrame } from '../look';
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';
import { initialMetalWalls, metalWallAt, stepMetalWalls, type MetalWalls } from './tankArenaMetalWalls';
import { initialJungleStatues, statueStopsShot, stepJungleStatues, type JungleStatues } from './tankJungleStatues';
import { atan2g } from '../ps1Angle';
import { TANK_BOMB_RELEASE_POSE, TANK_STOCK_WEAPON, tankGunFire, tankGunIdle } from './tankWeaponPose';

export const TA_K = 2.6;
export const TA_HP = 99;
export const TANK_INTRO_TICKS = 99;
export const BOAT_IDLE_SPIN = 0xb3;
export const BOAT_ROTOR_AT_GO = (-(TANK_INTRO_TICKS + 1) * BOAT_IDLE_SPIN) & 0xfff;
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
const LIVE_CHAR = DISC_CHARACTER; // look.ts index -> engine character
const SPEED = [28, 28, 24, 24, 26, 26, 24, 24];
const SHOT_SFX = [0x4ca, 0x4cb, 0x4cc, 0x4cd, 0x4ce, 0x4cf, 0x4d0, 0x4d0];
const PAD_OF_OCT = [0x10, 0x30, 0x20, 0x60, 0x40, 0xc0, 0x80, 0x90];
const HULL = [0x800, 0xc00, 0, 0x400]; // grid dir (0 -z, 1 -x, 2 +z, 3 +x) -> hull heading
const DIRBIT = [0x40, 0x80, 0x10, 0x20];
const DVX = [0, -1, 0, 1], DVZ = [-1, 0, 1, 0];
const FREEMOVE: Record<number, number> = { 0x10: 0, 0x30: 0x200, 0x20: 0x400, 0x60: 0x600, 0x40: 0x800, 0xc0: 0xa00, 0x80: 0xc00, 0x90: 0xe00 };
/** Shell damage, impact script, lifetime and speed by weapon ID. */
const SHELL: Record<number, [number, number, number, number]> = { 11: [20, 10, 90, 74], 8: [20, 12, 63, 54], 10: [30, 11, 75, 44], 9: [20, 13, 135, 44], 2: [60, 4, 0, 200] };
const MUZZLE: Record<number, number> = { 11: 7, 8: 8, 9: 15, 10: 6 };
const RICOCHET_SFX: Record<number, number> = { 11: 0x4d8, 9: 0x4db, 10: 0x4de, 8: 0x4e1 };
const END_SFX: Record<number, number> = { 8: 0x4e4, 10: 0x4e5, 9: 0x4e6, 11: 0x4e7 };
// Ages from GO and the per-character scripts 0x57 (hit) and 0x58 (wreck).
export const TANK_TIMEOUT_TICK = 2698;
export const TANK_HIT_TICKS = [27, 22, 30, 30, 30, 30, 28, 30];
export const TANK_WRECK_TICKS = [58, 50, 41, 41, 41, 41, 51, 41];
const S_HIT = 0x69, S_DIE = 0x6a, S_DEAD = 0x6b, S_RUN = 0x6e, S_TURN = 0x6f;

interface Ai { mode: number; timer: number; target: number; pad: number; tx: number; tz: number; shoot: number; mref: number; mineId?: number; idle: number }
// 1321 emits script 4 at ages 1, 5, 10 and 15. Its mesh lasts four updates.
const SHIELD_FRAMES = [-1, 0, 1, 2, 3, 0, 1, 2, 3, -1, 0, 1, 2, 3, -1, 0, 1, 2, 3];
export const swampShieldFrame = (age: number) => SHIELD_FRAMES[age] ?? -1;
const MINE_BOB = [-3, -2, -1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, -1, -2, -3];

interface Tk {
  shield?: { start: number; x: number; y: number; z: number };
  x: number; z: number; yaw: number; hull: number; st: number; stT: number; dir: number; tn: number; td: number;
  vx: number; vz: number; bank: number; wpn: number; ammo: number; cd: number; busy: number; gunFrame: number; gunPose: number;
  mines: number; mcd: number; hp: number; cpu: boolean; skill: number; char: number; speed: number; pad: number; prev: number;
  ghostAt?: number; resultVoiceTicks?: number; anim?: number; animAt?: number; rotor?: number;
  aim: number; inv: number; shieldCd: number; dodge: boolean; taunt: number; hy: number; hvy: number; kills: number;
  elim: number; hpAt: number; ai: Ai; body: number; bot: number;

}
interface Sh { id: number; o: number; x: number; z: number; y: number; vx: number; vz: number; vy: number; life: number; flag: number; w: number; spin: number; yaw?: number; born?: number }
interface Mn { rack?: number; id: number; o: number; x: number; z: number; n: number; born?: number; drift?: { angle: number; age: number; y: number; armed: boolean } }
interface Fl { id: number; o: number; x: number; z: number; dx: number; dz: number }
interface Bm { id: number; o: number; x: number; z: number; y: number; vx: number; vz: number; vy: number }
/** Mode 5 descends by 20 per tick. Metal Fox starts at floor height. Mode 0 bounces. */
export interface TankPickup { rack?: number; born?: number; landed?: number; id: number; t: number; x: number; z: number; y: number; vy: number; m: number }
interface Dr { born?: number; y?: number; id: number; x: number; z: number; vx: number; flag: number }
/** Desert and Jungle Fox dropper lanes, one picked by rand(4) at spawn (FUN_800be234, table 0x800ca600) */
const DROP_Z = [0x100, 0x500, 0xb00, 0xf00];
interface Data {
  variant: string; lv: number; f: number; over: boolean; overF: number; hum: number;
  tk: Tk[]; shells: Sh[]; mines: Mn[]; flames: Fl[]; bombs: Bm[]; pickups: TankPickup[]; dropper: Dr | null; spawnT: number; par: number; bump: number;
  result?: { winner: number; rankedAt: number; poseAt?: number; recovered?: boolean };
  metalWalls?: MetalWalls; jungleStatues?: JungleStatues;
}

const R = (w: World, n: number) => Math.floor(rand(w) * n);
const sfx = (w: World, id: number, x: number, z: number, s = -1) => emit(w, 'sfx', x, z, s, id);
const L_ = (d: Data) => TA_LV[d.lv];
const wallAt = (d: Data, x: number, z: number, objectId?: number) => {
  const L = L_(d);
  const c = x >> 9, r = z >> 9;
  return x < 0 || z < 0 || c >= L.W || r >= L.H || L.tiles[r * L.W + c] !== 0 || metalWallAt(d.metalWalls, c, r, d.f, objectId);
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
  t.st = S_HIT; t.stT = 0; t.hvy = -100; t.hy = 0; t.inv = 60;
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
  const sp = t.speed, half = sp >> 1, dir = t.dir, x = t.x, z = t.z;
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
  if (wallAt(d, wx, wz)) return;
  const snap = (v: number) => { let off = v & 0xff; if (off > 0x80) off -= 0x100; return Math.abs(off) <= half ? v - off : v; };
  if (dir === 1 || dir === 3) t.x = snap(x + DVX[dir] * sp); else t.z = snap(z + DVZ[dir] * sp);
}

function gridMove(d: Data, p: number, t: Tk) {
  const pad = t.pad;
  if (t.st === S_TURN) {
    t.hull = (t.hull + t.td) & 0xfff;
    if (--t.tn <= 0) { t.st = S_RUN; if (pad & 0xf0) gridStep(d, p, t); }
    return;
  }
  if (!(pad & 0xf0)) return;
  const atC = (t.x & 0x1ff) === 0x100 && (t.z & 0x1ff) === 0x100;
  if (atC) {
    const free = (dc: number, dr: number) => !wallAt(d, t.x + dc * 512, t.z + dr * 512);
    const tests: [number, number, boolean][] = [[0x20, 3, free(1, 0)], [0x80, 1, free(-1, 0)], [0x10, 2, free(0, 1)], [0x40, 0, free(0, -1)]];
    for (const [bit, want, ok] of tests) {
      if (!(pad & bit) || !ok) continue;
      if (t.dir === want) continue;
      const from = t.dir;
      t.dir = want;
      if (((from + 2) & 3) === want) return;
      const pos = (want === 3 && from === 2) || (want === 1 && from === 0) || (want === 2 && from === 1) || (want === 0 && from === 3);
      t.td = pos ? 0x80 : -0x80; t.tn = 8; t.st = S_TURN;
      return;
    }
  }
  const opp = (t.dir + 2) & 3;
  if (!atC && (pad & DIRBIT[opp])) t.dir = opp;
  gridStep(d, p, t);
}

const JUNGLE_PEDESTAL = [{ x: 2048, z: 2048 }];

function freeMove(d: Data, p: number, t: Tk) {
  const L = L_(d);
  let pad = t.pad;
  // Older snapshots predate the moving statues and carried only the pedestal.
  const statues = d.jungleStatues?.actors ?? JUNGLE_PEDESTAL;
  for (const statue of statues) {
    if (Math.abs(t.x - statue.x) < 350 && Math.abs(t.z - statue.z) < 350) {
      pad &= statue.x < t.x ? ~0x80 : ~0x20;
      pad &= statue.z > t.z ? ~0x10 : ~0x40;
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
  if (!wallAt(d, Math.max(0, Math.min(prx, L.bx)), Math.max(0, Math.min(prz, L.bz)))) {
    t.x = Math.max(0x100, Math.min(nx, L.bx));
    t.z = Math.max(0x100, Math.min(nz, L.bz));
  }
}

function boatMove(d: Data, p: number, t: Tk) {
  const L = L_(d), pad = t.pad, sp = t.speed;
  const turn = Math.trunc((sp * 3) / 2);
  t.bank = Math.sign(t.bank) * Math.max(0, Math.abs(t.bank) - 10);
  if (Math.abs(t.bank) < 3) t.bank = 0;
  if (pad & 0x20) { t.yaw = (t.yaw + turn) & 0xfff; t.bank = Math.max(-200, t.bank - 0x14); }
  if (pad & 0x80) { t.yaw = (t.yaw - turn) & 0xfff; t.bank = Math.min(200, t.bank + 0x14); }
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
const SHELL_HEIGHT: Record<number, number> = { 2: -0xe6, 8: -0xfa, 9: -0x104, 10: -0x14a, 11: -0x113 };

function spawnShell(w: World, d: Data, p: number, t: Tk, wpn: number, offset: number) {
  const [, , life, speed] = SHELL[wpn];
  const double = wpn === 2;
  // Double uses two muzzle angles from 0x800c93ac, but both shells travel along the turret yaw.
  const muzzle = t.yaw - offset;
  const boatShot = !double && L_(d).level === 5;
  const dx = double ? -((25 * sn(muzzle)) >> 8) : (-400 * sn(muzzle)) >> 12;
  const dz = double ? -((25 * cs(muzzle)) >> 8) : (-400 * cs(muzzle)) >> 12;
  const sx = t.x + dx + (boatShot ? t.vx : 0);
  const sz = t.z + dz + (boatShot ? t.vz : 0);
  const id = mk(w, d, 'bullet', p, sx, sz, 0.1 * 1024);
  byId(w, id)!.dash = wpn;
  const vx = (-speed * sn(t.yaw)) >> 12, vz = (-speed * cs(t.yaw)) >> 12;
  d.shells.push({
    id, o: p, x: sx, z: sz, y: SHELL_HEIGHT[wpn] + t.hy,
    vx: boatShot ? Math.trunc(vx * 3 / 2) : vx, vz: boatShot ? Math.trunc(vz * 3 / 2) : vz,
    vy: wpn === 10 ? -30 : 0, life: boatShot ? Math.trunc(life * 2 / 3) : life, flag: 1, w: wpn, spin: 0, yaw: t.yaw, born: d.f,
  });
  const L = L_(d);
  if (double) emit(w, 'sfx', px(L, t.x), pz(L, t.z), p, 0x522, id);
  else emit(w, 'shellMuzzle', px(L, sx), pz(L, sz), p, -(SHELL_HEIGHT[wpn] + t.hy) * G, MUZZLE[wpn], -t.yaw * TAU / 4096);
}

function fire(w: World, d: Data, p: number, t: Tk) {
  const L = L_(d), wp = t.wpn;
  t.cd = Math.round((wp === 3 ? 60 : 10) / Math.max(1, w.params.fireRate));
  t.busy = wp;
  t.gunFrame = 0;
  if (wp === 2) {
    for (const offset of [-0x104, 0x104]) spawnShell(w, d, p, t, wp, offset);
    t.ammo--;
  } else if (wp !== 3) {
    spawnShell(w, d, p, t, wp, 0);
    sfx(w, SHOT_SFX[t.char - 1], px(L, t.x), pz(L, t.z), p);
  }
  t.anim = 0x5d; t.animAt = w.tick + 1;
  if (wp !== 3) emit(w, 'shoot', px(L, t.x), pz(L, t.z), p, 1);
}

/** Post-state callback: advance the gun after the current frame's fire gate (FUN_800b71f8). */
function stepGun(w: World, d: Data, p: number, t: Tk) {
  const L = L_(d);
  if (t.busy < 0) {
    if (L.level === 5) {
      const frame = t.gunFrame ?? 0;
      t.gunPose = tankGunIdle(L.level, t.wpn, frame);
      t.gunFrame = (frame + 1) % 6;
    }
    return;
  }
  const pose = tankGunFire(L.level, t.busy, t.gunFrame ?? 0);
  if (pose === undefined) {
    t.busy = -1;
    t.gunFrame = 0;
    if (t.ammo < 1) {
      t.wpn = TANK_STOCK_WEAPON[t.char - 1];
      t.ammo = 999;
      t.cd = 30;
    }
    t.gunPose = tankGunIdle(L.level, t.wpn);
    return;
  }
  t.gunFrame = (t.gunFrame ?? 0) + 1;
  t.gunPose = pose;
  if (t.busy !== 3 || pose !== TANK_BOMB_RELEASE_POSE || L.level === 5) return;

  const X = px(L, t.x), Z = pz(L, t.z);
  emit(w, 'lob', X, Z, p);
  if (t.wpn !== 3) return;
  const dx = -250 * sn(t.yaw), dz = -250 * cs(t.yaw);
  const x = t.x + (dx >> 12), z = t.z + (dz >> 12);
  const id = mk(w, d, 'bomb', p, x, z, 0.28 * 1024);
  d.bombs.push({ id, o: p, x, z, y: t.hy - 300, vx: dx >> 13, vz: dz >> 13, vy: -91 });
  t.ammo--;
  emit(w, 'shoot', X, Z, p);
  sfx(w, 0x4f3, px(L, x), pz(L, z), p);
}

function mineRack(d: Data) {
  const rack = Array<Mn | undefined>(8).fill(undefined);
  for (const mine of d.mines) {
    mine.rack ??= rack.indexOf(undefined);
    if (mine.rack >= 0) rack[mine.rack] = mine;
  }
  return rack;
}

function spawnMine(w: World, d: Data, owner: number, x: number, z: number) {
  const id = mk(w, d, 'mine', owner, x, z, 0x80);
  const mine: Mn = { id, rack: mineRack(d).indexOf(undefined), o: owner, x, z, n: 120, born: d.f };
  if (owner >= 0 && L_(d).level === 5) {
    mine.n = 0;
    mine.drift = floatingMine(d.f);
  }
  d.mines.push(mine);
}

function layMine(w: World, d: Data, p: number, t: Tk) {
  const L = L_(d), X = px(L, t.x), Z = pz(L, t.z);
  if (t.mines <= 0) { if (!t.cpu) sfx(w, 0x4f2, X, Z, p); return; }
  if (t.mcd > 0) { if (!t.cpu) sfx(w, 0x4f1, X, Z, p); return; }
  if (L.level === 5) {
    if (d.mines.some(m => m.o === p)) return;
  } else {
    for (const m of mineRack(d)) if (m && Math.abs(m.x - t.x) <= 256 && Math.abs(m.z - t.z) <= 256) m.n = 1;
  }
  spawnMine(w, d, p, t.x, t.z);
  sfx(w, L.level === 5 ? 0x50a : 0x4e9, X, Z, p); sfx(w, 0x4ec + p, X, Z, p);
  t.anim = 0x5b; t.animAt = w.tick + 1;
  t.mines--; t.mcd = L.level === 5 ? 30 : 120;
  emit(w, 'mine', X, Z, p, 1);
}

// ---------------------------------------------------------------- projectiles
const rndHit = (w: World, x: number, z: number) => sfx(w, 0x4ba + R(w, 4), x, z);
/** FUN_800bc7d8, the Jungle Fox double shot. Its callback runs until contact. */
function stepDoubleShot(w: World, d: Data, s: Sh): 0 | 2 {
  const x = s.x + s.vx, z = s.z + s.vz;
  if (!statueStopsShot(d.jungleStatues, x, z) && !wallAt(d, x, z)) {
    s.x = x;
    s.z = z;
    breakPickupAt(w, d, x, s.y, z);
    const victim = d.tk.findIndex(t => !gone(t) && Math.abs(x - t.x) < 0x10f && Math.abs(z - t.z) < 0x10e);
    if (victim < 0 || victim === s.o) {
      if ((d.f & 1) === 0) emit(w, 'shellTrail', px(L_(d), x), pz(L_(d), z), s.o, -s.y * G, 17);
      return 0;
    }
    hurt(w, d, victim, 60, s.o);
  }
  const L = L_(d);
  sfx(w, 0x43d, px(L, x), pz(L, z));
  emit(w, 'doubleImpact', px(L, x), pz(L, z), s.o, -s.y * G, s.id);
  return 2;
}

function shellStep(w: World, d: Data, s: Sh): number {
  const L = L_(d);
  if (s.w === 8 && (d.f & 7) === 0) emit(w, 'shellTrail', px(L, s.x), pz(L, s.z), s.o, -s.y * G, 2);
  const fromX = s.x, fromZ = s.z, initialVx = s.vx, initialVz = s.vz;
  if (s.yaw !== undefined && s.w === 9) s.yaw = (s.yaw + 0x118) & 0xfff;
  if (s.w === 10) { // lob: arcs and hops on the ground
    s.spin = (s.spin + 0x55) & 0xfff;
    s.vy += 12; s.y += s.vy;
    if (s.y > -0x65) { s.y = -0x64 - 0x3c; s.vy = -0x3c; sfx(w, L.level === 5 ? 0x4f7 + R(w, 4) : 0x4d2 + R(w, 6), px(L, s.x), pz(L, s.z)); }
  }
  if (L.level === 8 && s.flag !== 1 && wallAt(d, fromX, fromZ, s.id)) return stockFeedback(w, d, s, 1);
  s.x += s.vx; s.z += s.vz;
  // The outer coordinates themselves are legal. The tile layer only covers the interior.
  const blockedTile = (x: number, z: number) => x >= 0 && z >= 0 && x < L.W * 512 && z < L.H * 512 && wallAt(d, x, z, s.id);
  const outsideX = (x: number) => x < 0 || x > L.bx + 0x100;
  const outsideZ = (z: number) => z < 0 || z > L.bz + 0x100;
  let ricochet = false;
  if (s.flag === 1) {
    // A muzzle can start inside a rail. Walk backwards along its firing line until the first legal step.
    const stride = Math.max(Math.abs(s.vx), Math.abs(s.vz));
    for (let back = 0; outsideX(s.x) || outsideZ(s.z) || (s.y >= -400 && blockedTile(s.x, s.z)); back += stride) {
      if (!stride || back > Math.max(L.W, L.H) * 512) return stockFeedback(w, d, s, 1);
      s.x -= s.vx; s.z -= s.vz;
    }
  } else if (outsideX(s.x)) {
    s.x = fromX; s.vx = -s.vx; ricochet = fromX !== 0;
  } else if (outsideZ(s.z)) {
    s.z = fromZ; s.vz = -s.vz; ricochet = fromZ !== 0;
  } else if (s.y >= -400 && blockedTile(s.x, s.z)) {
    const cx = (s.x >> 9) * 512 + 256, cz = (s.z >> 9) * 512 + 256;
    let reflectX = Math.abs(fromX - cx) > Math.abs(fromZ - cz);
    if (blockedTile(reflectX ? fromX : s.x, reflectX ? s.z : fromZ)) reflectX = !reflectX;
    if (reflectX) { s.x = fromX; s.vx = -s.vx; } else { s.z = fromZ; s.vz = -s.vz; }
    ricochet = true;
  }
  if (s.yaw !== undefined) {
    if (s.vx !== initialVx) s.yaw = (-s.yaw) & 0xfff;
    if (s.vz !== initialVz) s.yaw = (0x800 - s.yaw) & 0xfff;
  }
  const result = stockContact(w, d, s);
  return stockFeedback(w, d, s, result, ricochet);
}

function stockFeedback(w: World, d: Data, s: Sh, result: number, ricochet = false) {
  const L = L_(d), X = px(L, s.x), Z = pz(L, s.z);
  if (result) emit(w, 'shellImpact', X, Z, s.o, -s.y * G, SHELL[s.w][1]);
  if (ricochet && (s.w === 11 || !result)) {
    sfx(w, RICOCHET_SFX[s.w] + R(w, 3), X, Z);
    emit(w, 'bounce', X, Z, -1, 0.5);
  }
  if (result) {
    sfx(w, END_SFX[s.w], X, Z);
    if (result === 1) emit(w, 'fizzle', X, Z, -1, 0.4);
  }
  return result;
}

function stockContact(w: World, d: Data, s: Sh): number {
  const L = L_(d), X = px(L, s.x), Z = pz(L, s.z);
  const damage = SHELL[s.w][0];
  breakPickupAt(w, d, s.x, s.y, s.z);
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (gone(t) || t.hp <= 0 && t.st !== S_HIT) continue;
    if (Math.abs(s.x - t.x) < 0x10f && Math.abs(s.z - t.z) < 0x10e) {
      rndHit(w, X, Z);
      if (L.level === 5 && (t.cpu || t.bot === d.f) && t.shieldCd === 0 && d.hum > 0 && R(w, 32) < t.skill) { t.dodge = true; return 2; }
      hurt(w, d, p, p === s.o ? damage >> 1 : damage, s.o);
      return 2;
    }
  }
  for (let p = 0; p < 4; p++) {
    const t = d.tk[p];
    if (t.inv > 0 && Math.abs(s.x - t.x) < 0xe1 && Math.abs(s.z - t.z) < 0xe1) return 2;
  }
  if (statueStopsShot(d.jungleStatues, s.x, s.z)) return 2;
  s.flag = 0;
  return --s.life <= 0 ? 1 : 0;
}

function floatingMine(frame: number) {
  // 800c7598 uses the global frame counter. The online clock starts with the round intro.
  return { angle: (frame + TANK_INTRO_TICKS) & 0xfff, age: 0, y: -20, armed: false };
}

function stepFloatingMine(w: World, d: Data, m: Mn): boolean {
  const drift = m.drift ??= floatingMine(m.born ?? d.f); // snapshots from before drift was recorded
  drift.y += MINE_BOB[drift.age++ & 15];
  drift.angle = (drift.angle + 4) & 0xfff;
  const L = L_(d);
  m.x = Math.max(256, Math.min(L.bx, m.x + ((7 * sn(drift.angle)) >> 12)));
  m.z = Math.max(256, Math.min(L.bz, m.z + ((7 * cs(drift.angle)) >> 12)));
  const p = d.tk.findIndex(t => !gone(t) && Math.abs(m.x - t.x) <= 400 && Math.abs(m.z - t.z) < 400);
  if (p < 0) { drift.armed = true; return false; }
  if (!drift.armed) return false;
  sfx(w, 0x4ea, px(L, m.x), pz(L, m.z));
  hurt(w, d, p, 60, m.o);
  d.tk[p].vx = 0;
  d.tk[p].vz = 0;
  return true;
}

function explodeMine(w: World, d: Data, m: Mn) {
  const L = L_(d), X = px(L, m.x), Z = pz(L, m.z);
  if (m.drift) emit(w, 'floatingMineBlast', X, Z, m.o, -m.drift.y * G);
  else {
    sfx(w, 0x4ea, X, Z);
    emit(w, 'explode', X, Z, -1, 1.2, m.o);
  }
  if (L.level === 5 || L.level === 7) {
    for (let p = 0; p < 4; p++) { const t = d.tk[p]; if (!gone(t) && Math.abs(t.x - m.x) <= 0x300 && Math.abs(t.z - m.z) <= 0x2ff) hurt(w, d, p, 0x3c, m.o); }
  } else {
    for (const [dx, dz] of [[250, 0], [-250, 0], [0, 250], [0, -250]]) {
      const id = mk(w, d, 'flame', m.o, m.x + dx, m.z + dz, 0x60);
      d.flames.push({ id, o: m.o, x: m.x + dx, z: m.z + dz, dx: Math.sign(dx), dz: Math.sign(dz) });
    }
  }
  if (m.drift) return; // The proximity callback already handled its direct contact.
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
// FUN_800bf548: a shot or rising platform breaks a pickup in this box.
function pickupInBox(pickup: TankPickup, x: number, y: number, z: number): boolean {
  const inRange = (v: number) => v >= -0xff && v < 0x100;
  return inRange(pickup.x - x) && inRange(pickup.y - y) && inRange(pickup.z - z);
}

function breakPickupAt(w: World, d: Data, x: number, y: number, z: number) {
  if (!d.pickups.length) return;
  const pickup = supplyRack(d).find(k => k && pickupInBox(k, x, y, z));
  if (!pickup) return;
  const L = L_(d);
  d.pickups.splice(d.pickups.indexOf(pickup), 1);
  sfx(w, 0x4b8, px(L, x), pz(L, z));
  emit(w, 'pkhit', px(L, pickup.x), pz(L, pickup.z), -1, -pickup.y * G);
  drop(w, pickup.id);
}

// The native registry keeps three slots. An occupied slot keeps its index until collection or destruction.
function supplyRack(d: Data) {
  const rack = Array<TankPickup | undefined>(3).fill(undefined);
  for (const k of d.pickups) {
    const slot = k.rack ?? rack.indexOf(undefined);
    if (slot >= 0) { k.rack = slot; rack[slot] = k; }
  }
  return rack;
}

function spawnPickup(w: World, d: Data, rack: number, x: number, y: number, z: number): TankPickup {
  const L = L_(d);
  const id = mk(w, d, 'pickup', -1, x, z, 0x90);
  const k = { id, rack, born: d.f, t: 5, x, z, y, vy: 0, m: 5 };
  d.pickups.push(k);
  sfx(w, 0x4b0 + R(w, 4), px(L, x), pz(L, z));
  emit(w, 'spawn', px(L, x), pz(L, z), -1, 1);
  return k;
}

function collect(w: World, d: Data, p: number, k: TankPickup): boolean {
  const t = d.tk[p], L = L_(d), X = px(L, k.x), Z = pz(L, k.z);
  const ty = k.t;
  if (d.over) { emit(w, 'crateBreak', X, Z, -1, -k.y * G); sfx(w, 0x4ea, X, Z); return true; }
  if (ty <= 3) {
    t.ammo = t.wpn === ty ? t.ammo + 2 : 2; t.wpn = ty; t.busy = -1;
    t.gunFrame = 0;
    t.gunPose = tankGunIdle(L.level, t.wpn);
    sfx(w, ty === 3 ? 0x48e : ty === 2 ? 0x51f : 0x1c2, X, Z, p);
  } else if (ty === 4) { t.hp = Math.min(99, t.hp + 20); sfx(w, 0x1c2, X, Z, p); }
  else if (ty === 5) { t.mines++; sfx(w, 0x4e8, X, Z, p); }
  else if (ty === 6) {
    hurt(w, d, p, 30, -1);
    emit(w, 'trapCatch', X, Z, p, -k.y * G);
    sfx(w, 0x4ea, X, Z, p);
    return true;
  }
  else if (ty === 7) {
    t.ammo = t.wpn === 3 ? t.ammo + 1 : 1;
    t.wpn = 3;
    t.gunPose = tankGunIdle(L.level, t.wpn);
    if (p < 2) t.mines++;
    sfx(w, 0x1c2, X, Z, p);
  }
  emit(w, 'pickup', X, Z, p, ty);
  return true;
}

// ---------------------------------------------------------------- AI
const hasHuman = (d: Data) => d.tk.some((t) => !t.cpu && t.hp > 0);
const skillOf = (d: Data, t: Tk) => (d.hum === 0 ? 30 : t.skill);
function pickTarget(w: World, d: Data, p: number): number {
  const scanLanes = d.variant === 'desert' || d.variant === 'metal';
  const start = scanLanes ? R(w, 4) : 0;
  const candidates: number[] = [];
  const me = d.tk[p];
  for (let n = 0; n < 4; n++) {
    const seat = (start + n) & 3;
    const rival = d.tk[seat];
    if (seat === p || rival.hp <= 0 || gone(rival)) continue;
    candidates.push(seat);
    if (!scanLanes || (rival.cpu && R(w, 256) <= 210)) continue;
    if (Math.abs(me.x - rival.x) < 1000 || Math.abs(me.z - rival.z) < 1000) return seat;
  }
  // Each eligible versus seat has native selection weight 16.
  return candidates.length ? candidates[R(w, 16 * candidates.length) >> 4] : -1;
}
function freeDir(d: Data, t: Tk, bit: number): boolean {
  const dc = bit === 0x20 ? 1 : bit === 0x80 ? -1 : 0, dr = bit === 0x10 ? 1 : bit === 0x40 ? -1 : 0;
  const x = t.x + dc * 512, z = t.z + dr * 512;
  return x <= L_(d).bx && z <= L_(d).bz && !wallAt(d, x, z);
}
const stepTime = (t: Tk, extra: number) => Math.trunc((t.speed / 2 + extra) / t.speed);
const ROUTE_BITS = [0x20, 0x80, 0x10, 0x40];

function routePickup(d: Data, t: Tk) {
  // Both CPU routines use a signed z difference and check registry slots in order.
  return supplyRack(d).find(k => k && Math.abs(t.x - k.x) + t.z - k.z < 0x600);
}

function seek(w: World, d: Data, t: Tk) {
  const pickup = routePickup(d, t);
  let bit = 0;
  if (pickup) {
    const dx = pickup.x - t.x, dz = pickup.z - t.z;
    if (Math.abs(dx) > 112) bit = dx > 0 ? 0x20 : 0x80;
    else if (Math.abs(dz) > 112) bit = dz > 0 ? 0x10 : 0x40;
  }
  if (!bit) {
    t.ai.mode = 5;
    t.ai.timer = stepTime(t, 512);
  }
  if (!bit || !freeDir(d, t, bit)) {
    // Metal platforms or old snapshots can leave no open direction.
    if (!ROUTE_BITS.some(b => freeDir(d, t, b))) { t.ai.pad = 0; return; }
    do { bit = ROUTE_BITS[R(w, 4)]; } while (!freeDir(d, t, bit));
  }
  t.ai.pad = bit;
}

/** 800b4240 starts with the radial octant and may add a perpendicular direction. */
function away(w: World, d: Data, t: Tk, ox: number, oz: number) {
  const a = t.ai, L = L_(d);
  a.mode = 2;
  a.timer = stepTime(t, 1024);
  a.pad = PAD_OF_OCT[(atan2g(t.x - ox, t.z - oz) >> 9) & 7];
  if (!d.hum) return;
  const odd = (R(w, 4) & 1) !== 0;
  if (!(a.pad & 0xa0)) {
    const right = t.x < 1024 || (t.x + 1024 <= L.bx &&
      (odd ? wallAt(d, t.x - 256, t.z) : !wallAt(d, t.x + 256, t.z)));
    a.pad |= right ? 0x20 : 0x80;
  } else if (!(a.pad & 0x50)) {
    const down = t.z + 1024 > L.bz || (t.z >= 1024 &&
      (odd ? wallAt(d, t.x, t.z + 256) : !wallAt(d, t.x, t.z - 256)));
    a.pad |= down ? 0x40 : 0x10;
  }
}

function avoidMine(w: World, d: Data, t: Tk): boolean {
  if (!d.hum || R(w, t.skill + 1) < 8 || t.ai.mode === 2) return false;
  const a = t.ai;
  let mine: Mn | undefined;
  if (a.mineId !== undefined) {
    mine = d.mines.find(m => m.id === a.mineId);
    if (!mine) delete a.mineId;
  } else {
    a.mref = (a.mref + 1) & 7;
    mine = mineRack(d)[a.mref];
  }
  if (!mine || (Math.abs(mine.x - t.x) >= 1000 && Math.abs(mine.z - t.z) >= 1000)) return false;
  a.mineId = mine.id;
  away(w, d, t, mine.x, mine.z);
  return true;
}

function decide(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai;
  a.timer = 30; a.target = pickTarget(w, d, p);
  if (a.mineId !== undefined && avoidMine(w, d, t)) return;
  const r = R(w, 8);
  if (r === 0 && d.hum && R(w, t.skill + 1) < 13) { a.timer = R(w, 30) + 15; a.pad = 0; a.mode = 0; return; }
  if (r === 1) { seek(w, d, t); return; }
  if (r === 2 && t.mines > 0) { a.pad |= 0x2000; a.timer = stepTime(t, 512); return; }
  if (a.target < 0) { seek(w, d, t); return; }
  const o = d.tk[a.target];
  if (t.cd >= 5) {
    if (!d.hum) t.cd--;
    if (d.hum || R(w, 256) <= 64) { away(w, d, t, o.x, o.z); return; }
  }
  a.pad = PAD_OF_OCT[(atan2g(o.x - t.x, o.z - t.z) >> 9) & 7];
  a.mode = 4; a.timer = stepTime(t, 512);
}
/** FUN_800b3f44: shoot decision */
function shootGate(w: World, d: Data, t: Tk): boolean {
  const a = t.ai;
  if (d.hum > 0 && R(w, 101) > a.shoot) return false;
  if (a.target < 0) return false;
  const L = L_(d);
  if (L.level === 5) {
    const o = d.tk[a.target];
    return Math.abs(sext(atan2g(t.x - o.x, t.z - o.z) - t.yaw)) < 100;
  }
  const h = (t.yaw + (sext(t.aim - t.yaw) >> 2)) & 0xfff;
  // 800c891c indexes the flat shot map, including the empty padding at its ends.
  const col = (t.x + ((-0x200 * sn(h)) >> 12)) >> 9;
  const row = (t.z + ((-0x200 * cs(h)) >> 12)) >> 9;
  const index = row * L.W + col;
  return !L.tiles[index] && !metalWallAt(d.metalWalls, index % L.W, Math.floor(index / L.W));
}
function decide5(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai;
  a.target = pickTarget(w, d, p);
  const route = a.target < 0 ? 5 : t.busy >= 0 ? 7 : R(w, 8);
  if (route === 0 && d.hum && R(w, t.skill + 1) < 13) {
    a.timer = R(w, 30) + 15;
    a.pad = 0;
    a.mode = 0;
  } else if (route < 5) {
    a.mode = 6;
    a.timer = 90;
  } else if (route < 7) {
    // The L5 routine includes the origins of knocked-out opponents.
    let sx = 0, sz = 0;
    for (const [i, rival] of d.tk.entries()) {
      if (i !== p) { sx += rival.x; sz += rival.z; }
    }
    a.tx = sx >= 3 * 2048 ? 512 : 3584;
    a.tz = sz >= 3 * 2048 ? 512 : 3584;
    a.mode = 7;
    a.timer = 180;
  } else {
    const pickup = routePickup(d, t);
    if (pickup) {
      a.tx = pickup.x; a.tz = pickup.z;
    } else {
      const i = R(w, 9);
      a.tx = 512 + (i % 3) * 1536;
      a.tz = 512 + Math.floor(i / 3) * 1536;
    }
    a.mode = 4;
    a.timer = 90;
  }
}
function aiFrame(w: World, d: Data, p: number, t: Tk) {
  const a = t.ai, L = L_(d);
  if (L.level === 5) {
    if (--a.timer < 1) decide5(w, d, p, t);
    let pad = 0;
    const o = a.target >= 0 ? d.tk[a.target] : null;
    if (a.mode === 6 && o) {
      const df = sext(atan2g(t.x - o.x, t.z - o.z) - t.yaw);
      if (df > 0x46) pad = 0x20; if (df < -0x46) pad = 0x80;
    } else if (a.mode === 4 || a.mode === 7) {
      if (Math.abs(t.x - a.tx) <= 99) a.timer = 0;
      const df = sext(atan2g(t.x - a.tx, t.z - a.tz) - t.yaw);
      if (df > 0x28) pad = 0x820; if (df < -0x28) pad = 0x880;
    }
    a.pad &= ~0x8000;
    if (shootGate(w, d, t)) { a.pad |= 0x8000; pad |= 0x8000; }
    if (t.dodge) { pad |= 0x4000; t.dodge = false; }
    t.pad = pad;
    return;
  }
  const tg = a.target >= 0 ? d.tk[a.target] : null;
  if (tg) t.aim = (atan2g(tg.x - t.x, tg.z - t.z) + 0x800) & 0xfff;
  if (a.mode === 5 && (t.x & 0x1ff) === 0 && (t.z & 0x1ff) === 0) decide(w, d, p, t);
  if (--a.timer < 1) decide(w, d, p, t);
  else { avoidMine(w, d, t); if (shootGate(w, d, t)) a.pad |= 0x8000; }
  if (d.hum > 0 && R(w, skillOf(d, t) + 1) > 8) {
    for (const m of mineRack(d)) {
      if (!m) continue;
      const dx = m.x - t.x, dz = m.z - t.z;
      if (Math.abs(dx) > 250 && Math.abs(dx) < 500) a.pad &= dx > 0 ? ~0x20 : ~0x80;
      if (Math.abs(dz) > 250 && Math.abs(dz) < 500) a.pad &= dz > 0 ? ~0x10 : ~0x40;
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
  if (inp.d) pad |= 0x4000;
  if (inp.l) pad |= 0x400;
  if (inp.r) pad |= 0x800;
  return pad;
}

function enterTankWin(result: NonNullable<Data['result']>, tick: number, t: Tk) {
  result.poseAt = tick;
  t.st = 0x70;
  t.hy = 0;
}

function tankStep(w: World, d: Data, p: number, t: Tk, inp: InputState) {
  const L = L_(d), lv = L.level;
  const drv = t.cpu || t.bot === d.f; // CPU slot, or a vacated human seat driven by bot()
  if (d.over) t.pad = 0;
  else if (t.cpu && alive(t)) aiFrame(w, d, p, t);
  else if (!t.cpu) t.pad = alive(t) ? humanPad(inp, lv) : 0;
  const pad = t.pad, prevPad = t.prev, press = pad & ~t.prev;
  t.prev = pad;
  if (lv === 5 && t.st !== S_DEAD) {
    t.rotor = ((t.rotor ?? BOAT_ROTOR_AT_GO) - ((pad & 0xa00) ? 0x2a7 : BOAT_IDLE_SPIN)) & 0xfff;
  }
  if (t.mcd > 0) t.mcd--;
  if (t.inv > 0) t.inv--;
  const shieldReady = t.shieldCd === 0;
  if (!shieldReady) t.shieldCd--;
  if (t.taunt > 0) t.taunt--;
  if (t.st === S_HIT) {
    t.hvy += 12; t.hy += t.hvy;
    if (t.hy > 0) { t.hvy = -Math.trunc(t.hvy / 2); t.hy = 0; }
    stepGun(w, d, p, t);
    if (t.hp <= 0 || (d.result && d.f > d.result.rankedAt)) t.inv = 0;
    if (++t.stT < TANK_HIT_TICKS[t.char - 1]) return;
    t.hy = 0;
    if (t.hp <= 0) { t.st = S_DIE; t.stT = 0; return; }
    t.st = S_RUN;
    if (d.result?.winner === p && d.f > d.result.rankedAt) {
      enterTankWin(d.result, d.f, t);
      d.result.recovered = true; // FUN_800baab0 selects idle after the recovery callback enters victory.
    }
    return;
  }
  if (t.st === S_DIE) {
    stepGun(w, d, p, t);
    if (++t.stT >= TANK_WRECK_TICKS[t.char - 1]) {
      t.st = S_DEAD;
      t.ghostAt = d.f;
      t.yaw = 0;
      sfx(w, 0x4f0, px(L, t.x), pz(L, t.z), p);
      emit(w, 'boom', px(L, t.x), pz(L, t.z), p, 1.2);
    }
    return;
  }
  if (t.st === S_DEAD) return;
  if (d.result) {
    const result = d.result;
    if (result.winner === p && d.f > result.rankedAt) {
      if (result.poseAt === undefined) {
        enterTankWin(d.result, d.f, t);
      } else {
        t.yaw = (t.yaw + 0x15) & 0xfff;
        if (lv === 7) t.hull = (t.hull - 0x15) & 0xfff;
      }
    }
    stepGun(w, d, p, t);
    return;
  }
  // turret
  if (lv !== 5) {
    const previousYaw = t.yaw;
    if (!drv) {
      if (pad & 0xa00) t.yaw = (t.yaw + 0x40) & 0xfff;
      else if (pad & 0x500) t.yaw = (t.yaw - 0x40) & 0xfff;
    } else if (t.aim >= 0) {
      const df = sext(t.aim - t.yaw);
      t.yaw = (t.yaw + (df >> 2)) & 0xfff;
      if (Math.abs(df >> 2) <= 3) t.aim = -1;
    }
    // Jungle stores the chassis as a child of the turret. Counter-rotate before driving.
    if (lv === 7) t.hull = (t.hull + previousYaw - t.yaw) & 0xfff;
  }
  // fire / mine / shield
  if (!d.over) {
    if (t.cd > 0) t.cd -= d.hum === 0 && t.cd > 1 ? 2 : 1;
    else if ((press & 0x8000) && t.busy < 0 && d.shells.filter((s) => s.o === p && s.w !== 2).length < 3) fire(w, d, p, t);
  }
  if (press & 0x2000) layMine(w, d, p, t);
  if ((press & 0x4000) && lv === 5 && shieldReady) {
    t.shield = { start: d.f, x: t.x, y: t.hy, z: t.z };
    t.inv = 10; t.shieldCd = t.cpu ? (((0x20 - t.skill) * 0x3c) >> 5) + 0xf : 60;
    sfx(w, 0x510 + p, px(L, t.x), pz(L, t.z), p); emit(w, 'shield', px(L, t.x), pz(L, t.z), p);
  }
  // Triangle held (0x80051388), taunt cooldown run out, in the idle / drive / turn states 0x6c 0x6e 0x6f: clip 0x5a + voice
  if ((pad & 0x1000) && t.taunt <= 0 && (t.st === S_RUN || t.st === S_TURN)) { t.taunt = 0x5a; t.anim = 0x5a; t.animAt = w.tick + 1; emit(w, 'taunt', 0, 0, p); }
  // FUN_800b8ec4 -> FUN_800b6ed8: every time a CPU tank stops (enters the idle state 0x6c) a counter (starts rand(30)) goes up;
  // past 0x4f it taunts (clip 0x5a + its taunt voice) and the counter restarts at 0
  if (t.cpu && t.st === S_RUN && (prevPad & 0xf0) && !(pad & 0xf0) && ++t.ai.idle > 0x4f) { t.ai.idle = 0; t.taunt = 0x5a; t.anim = 0x5a; t.animAt = w.tick + 1; emit(w, 'taunt', 0, 0, p); }
  // movement
  const sp0 = t.speed;
  t.speed = Math.max(1, Math.round(sp0 * w.params.speed));
  if (lv === 5) boatMove(d, p, t); else if (lv === 7) freeMove(d, p, t); else gridMove(d, p, t);
  t.speed = sp0;
  stepGun(w, d, p, t);
}

// ---------------------------------------------------------------- objects
function objects(w: World, d: Data) {
  const L = L_(d);
  for (let i = d.shells.length - 1; i >= 0; i--) {
    const s = d.shells[i];
    if (s.born === d.f) continue;
    const r = s.w === 2 ? stepDoubleShot(w, d, s) : shellStep(w, d, s);
    if (r) {
      drop(w, s.id); d.shells.splice(i, 1);
    }
  }
  for (let i = d.mines.length - 1; i >= 0; i--) {
    const m = d.mines[i];
    if (m.born === d.f) continue;
    let boom = false;
    if (L.level === 5 && m.o >= 0) boom = stepFloatingMine(w, d, m);
    else if (L.level === 8 && wallAt(d, m.x, m.z, m.id)) boom = true;
    else { m.n--; if (m.n <= 0) boom = true; else if (m.n % 30 === 0) sfx(w, 0x4eb, px(L, m.x), pz(L, m.z)); }
    if (boom) { d.mines.splice(i, 1); drop(w, m.id); explodeMine(w, d, m); }
  }
  for (let i = d.flames.length - 1; i >= 0; i--) {
    const f = d.flames[i];
    let end = wallAt(d, f.x, f.z, f.id);
    for (let k = 0; k < 2 && !end; k++) {
      f.x += f.dx * 250; f.z += f.dz * 250;
      if (f.x < 0x100 || f.x > L.bx + 0x100 || f.z < 0x100 || f.z > L.bz + 0x100 || wallAt(d, f.x, f.z, f.id)) { end = true; break; }
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
    if (k.born === d.f) continue;
    if (wallAt(d, k.x, k.z, k.id)) {
      emit(w, 'crateBreak', px(L, k.x), pz(L, k.z), -1, -k.y * G);
      sfx(w, 0x4ea, px(L, k.x), pz(L, k.z));
      drop(w, k.id); d.pickups.splice(i, 1); continue;
    }
    if (k.m === 5) { // FUN_800be988 mode 5: descend, land at -300 (mines under it go off; levels 5-7: script 3 + sfx 0x4b4 + rand(4))
      k.y += 0x14;
      if (k.y > -300) {
        for (const m of d.mines) if (Math.abs(m.x - k.x) <= 0x100 && Math.abs(m.z - k.z) <= 0x100) {
          if (m.drift) m.drift.angle = 1;
          else m.n = 1;
        }
        if (L.level < 8) { emit(w, 'land', px(L, k.x), pz(L, k.z), -1, -k.y * G); sfx(w, 0x4b4 + R(w, 4), px(L, k.x), pz(L, k.z)); }
        if (k.t === 6) {
          spawnMine(w, d, -1, k.x, k.z);
          drop(w, k.id);
          d.pickups.splice(i, 1);
          continue;
        }
        k.y = 0; k.vy = -0x28; k.m = 0; k.landed = d.f;
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
    if (got) { drop(w, k.id); d.pickups.splice(i, 1); }
  }
  if (d.dropper) stepDropper(w, d, d.dropper);
}

function stepDropper(w: World, d: Data, q: Dr) {
  if (q.born === d.f) return;
  q.x += q.vx;
  if (d.over) q.y = (q.y ?? -1024) - 50;
  if (q.x < -2048 || q.x > 6144) { drop(w, q.id); d.dropper = null; return; }
  if (q.flag !== 3 || d.over || (q.x & 511) !== 256 || q.x < 2 || q.x > 4094) return;
  const rack = supplyRack(d);
  const first = rack.find(k => k !== undefined);
  if (first && first.x === q.x && first.z === q.z) return;
  if (R(w, 0x8000) >= 0x2800) return;
  const slot = rack.indexOf(undefined);
  if (slot < 0) return;
  const k = spawnPickup(w, d, slot, q.x, (q.y ?? -1024) - 200, q.z + 60);
  q.flag = 0;
  const dead = d.tk.filter(t => t.hp < 1).length;
  if (R(w, 7000) < 2000 * dead) k.t = 6;
  else if (L_(d).level === 7) k.t = [5, 4, 2][R(w, 3)];
  else k.t = R(w, 1000) < 501 ? 4 : 5;
}

function stepSupply(w: World, d: Data) {
  const L = L_(d);
  if (L.level === 5 || d.over) return;
  if (d.spawnT > 0) { d.spawnT--; return; }
  d.spawnT = R(w, 120) + 180;
  if (L.level !== 8) {
    if (d.dropper) return;
    const fromRight = (++d.par & 1) !== 0;
    const x = fromRight ? 6144 : -2048;
    const z = DROP_Z[R(w, 4)];
    const id = mk(w, d, 'dropper', -1, x, z, 256);
    d.dropper = { id, born: d.f, x, y: -1024, z, vx: fromRight ? -64 : 64, flag: 3 };
    sfx(w, 0x4f6, px(L, x), pz(L, z));
    return;
  }
  const rack = supplyRack(d);
  for (let i = 0; i < rack.length; i++) {
    if (rack[i]) continue;
    const [x, z] = L8_SPOTS[R(w, L8_SPOTS.length)];
    const first = rack.find(k => k !== undefined);
    if (first && first.x === x && first.z === z) return;
    if (d.tk.some(t => !gone(t) && Math.abs(t.x - x) <= 512 && Math.abs(t.z - z) < 512)) return;
    const k = spawnPickup(w, d, i, x, 0, z);
    k.t = [5, 4, 3][R(w, 3)];
    rack[i] = k;
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
  for (const m of d.mines) { put(m.id, m.x, m.drift?.y ?? -20, m.z); const b = byId(w, m.id); if (b) b.cd = m.n; }
  for (const f of d.flames) put(f.id, f.x, 0, f.z, Math.atan2(f.dx, -f.dz));
  for (const k of d.bombs) put(k.id, k.x, k.y, k.z);
  for (const k of d.pickups) { put(k.id, k.x, k.y, k.z); const b = byId(w, k.id); if (b) b.dash = k.m; }
  if (d.dropper) put(d.dropper.id, d.dropper.x, d.dropper.y ?? -1024, d.dropper.z); // rides 0x400 up (FUN_800be234)
}

export const tankArena: MiniGame = {
  id: 'tankArena',
  name: 'Tank Wars',
  description: 'Destroy rival tanks. Last standing or most health at the buzzer wins.',
  variantDescriptions: {
    swamp: 'Destroy rival hovercraft. Last standing or most health at the buzzer wins.',
    desert: 'Destroy rival tanks. Mines blast down lanes. Last standing or most health at the buzzer wins.',
    jungle: 'Destroy rival tanks and dodge the statues’ shockwaves. Last standing or most health at the buzzer wins.',
    metal: 'Destroy rival tanks. Lob bombs over rising walls. Last standing or most health at the buzzer wins.',
  },
  controls: '{move} drive. {l} / {r} aim turret. {a} fire / {b} lay mine. {c} taunt.',
  variantControls: { swamp: '{lr} steer. Hold {r} or {up} to thrust. {a} fire / {b} drop floating mine. {d} shield / {c} taunt.' },
  variants: TA_VARIANTS,
  maxTime: 90,
  settlesAfterTimeout: true,

  setup(w, slots) {
    const variant = pickVariant(w, TA_VARIANTS);
    const lv = TA_LV.findIndex((l) => l.id === variant);
    const L = TA_LV[lv];
    const d: Data = { variant, lv, f: 0, over: false, overF: -1, hum: 1, tk: [], shells: [], mines: [], flames: [], bombs: [], pickups: [], dropper: null, spawnT: 239 - TANK_INTRO_TICKS, par: 0, bump: 0 };
    w.data = d;
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = slots.find((q) => q.slot === i);
      const char = LIVE_CHAR[(s?.char ?? i) % LIVE_CHAR.length];
      const [x, z, yaw] = L.spawns[i];
      const dir = yaw === 0x800 ? 2 : yaw === 0xc00 ? 3 : yaw === 0 ? 0 : 1; // grid heading = shell direction
      const lvl = Math.max(0, Math.min(2, s?.level ?? 1));
      const base = SPEED[char - 1];
      const weapon = TANK_STOCK_WEAPON[char - 1];
      const boatFrame = L.level === 5 ? TANK_INTRO_TICKS % 6 : 0;
      const id = mk(w, d, 'tank', i, x, z, 0xe0);
      d.tk.push({
        x, z, yaw, hull: L.level === 7 ? 0 : HULL[dir], st: S_RUN, stT: 0, dir, tn: 0, td: 0, vx: 0, vz: 0, bank: 0,
        ...(L.level === 5 ? { rotor: BOAT_ROTOR_AT_GO } : {}),
        wpn: weapon, ammo: 999, cd: 0, busy: -1, gunFrame: L.level === 5 ? (boatFrame + 1) % 6 : 0,
        gunPose: tankGunIdle(L.level, weapon, boatFrame), mines: 3, mcd: 0, hp: TA_HP, cpu: s ? s.bot : true,
        skill: L.skill[lvl], char, resultVoiceTicks: winnerCheerFrame(s?.char ?? i), speed: L.level === 5 ? Math.trunc((base * 3) / 2) : base, pad: 0, prev: 0, aim: -1, inv: 0, shieldCd: 0,
        dodge: false, taunt: 0, hy: 0, hvy: 0, kills: 0, elim: -1, hpAt: 0,
        ai: { mode: 0, timer: 1, target: -1, pad: 0, tx: 0, tz: 0, shoot: ((L.skill[lvl] * 0x55) >> 5) + 5, mref: 0, idle: R(w, 0x1e) }, body: id, bot: -1,
      });
      byId(w, id)!.face = (-yaw * TAU) / 4096;
    }
    if (L.level === 7) d.jungleStatues = initialJungleStatues(TANK_INTRO_TICKS);
    if (L.level === 8) d.metalWalls = initialMetalWalls(d.tk);
  },

  step(w, inputs) {
    const d = w.data as Data;
    d.f++;
    d.hum = hasHuman(d) ? 1 : 0;
    for (let p = 0; p < 4; p++) { const t = d.tk[p]; t.ai.shoot = (((d.hum ? t.skill : 30) * 0x55) >> 5) + 5; tankStep(w, d, p, t, inputs[p] ?? IDLE); }
    for (const t of d.tk) {
      if (!t.shield) continue;
      const age = d.f - t.shield.start;
      if (age >= SHIELD_FRAMES.length) delete t.shield;
      else if (swampShieldFrame(age) === 0) {
        t.shield.x = t.x;
        t.shield.z = t.z;
      }
    }
    if (d.metalWalls) {
      stepMetalWalls(d.metalWalls, d.f, d.tk.filter(t => !gone(t)), d.over, {
        firstLaterId: w.nextId,
        onWave: () => sfx(w, 0x501, 0, 0),
        onRise: wall => breakPickupAt(w, d, wall.x, wall.y, wall.z),
      });
    }
    if (d.jungleStatues) {
      const L = L_(d);
      stepJungleStatues(d.jungleStatues, d.tk.filter(t => !gone(t)), d.over, {
        sound: (id, x, z) => sfx(w, id, px(L, x), pz(L, z)),
        slam: (x, z) => {
          emit(w, 'statueSlam', px(L, x), pz(L, z), -1, -300 * G);
          d.tk.forEach((t, slot) => {
            if (Math.abs(x - t.x) <= 768 && Math.abs(z - t.z) <= 768) hurt(w, d, slot, 60, -1);
          });
        },
        crushPickup: (x, y, z) => breakPickupAt(w, d, x, y, z),
      });
    }
    stepSupply(w, d);
    objects(w, d);
    if (!d.over && (d.f >= TANK_TIMEOUT_TICK || d.tk.filter(alive).length <= 1)) {
      const best = Math.max(...d.tk.map(t => t.hp));
      const leaders = d.tk.filter(t => t.hp === best);
      const winner = best > 0 && leaders.length === 1 ? d.tk.indexOf(leaders[0]) : -1;
      d.over = true;
      d.overF = d.f;
      d.result = { winner, rankedAt: d.f + Number(d.f < TANK_TIMEOUT_TICK) };
    }
    sync(w, d);
  },

  isOver(w) {
    const d = w.data as Data;
    const result = d.result;
    if (!result) return d.over && d.f - d.overF >= 60;
    if (result.winner < 0) return d.f >= result.rankedAt;
    const t = d.tk[result.winner];
    const cheer = t.resultVoiceTicks ?? winnerCheerFrame(DISC_CHARACTER.findIndex(char => char === t.char));
    return result.poseAt !== undefined && d.f - result.poseAt >= cheer;
  },

  isDraw(w, [first, second]) {
    const d = w.data as Data;
    return d.result ? d.result.winner === -1 : d.tk[first].hp === d.tk[second].hp;
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
      d: (pad & 0x4000) !== 0,
    };
  },
};
