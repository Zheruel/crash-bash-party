/**
 * POGO PANDEMONIUM (game id 'tilePainter') - Crash Bash levels 10-13 (Pogo Painter / Pogo-a-gogo / El Pogo Loco / Pogo Padlock).
 * Rules, constants and timings come from the decompiled overlay (see re/notes/pogoPainter.md, function addresses in comments).
 * Everything is counted in 30 Hz frames; there is no delta time in the original either.
 *
 * Coordinates: the sim works in the game's own tile space (rx = 0..7 left to right, rz = 0..7 bottom (near camera) to top).
 * `tiles`/`st`/`tm` arrays are in view order i = z*8 + x with z = 7 - rz (so row 0 is the top row on screen).
 *
 * Variants (world.data.variant) = levels:
 *   pogo       lvl 10 POGO PAINTER   paint tiles, cash them in at the 2 purple crates, arrows / item crates
 *   agogo      lvl 11 POGO-A-GOGO    enclose areas (the rotating coloured border helps), enclosures are cashed automatically
 *   elpogoloco lvl 12 EL POGO LOCO   enclose + cash at 3 crates, a monster drops mines and "cross" tiles
 *   padlock    lvl 13 POGO PADLOCK   landing on your own tile wipes ALL your tiles, a padlock object shields, steal gun
 *
 * world.data (all JSON):
 *   variant, lvl, tiles[64] owner (-1 none, 5 monster), st[64] tile state (0 flipping in, 1 normal, 3 cashed,
 *   5 mine, 7 cross tile, 10 locked), tm[64] state timer, cap[64] 1 = locked, score[4], item[4] (0 none,
 *   1 missile 2 four-way 3 electro 4 steal gun 5 speed 6 shield), itemT[4], stun[4], hd[4] heading (0 +x 1 -x 2 up 3 down),
 *   cnt[4] hop counter (-1 idle), fx/fz/tx/tz[4] tile coordinates, px/pz[4] position in tile units, border (lvl 11 ring offset)
 * Bodies: 'player', 'crate' (cash crate), 'power' (item crate, cd = item id), 'arrow' (arrow crate, m = 7|8, cd = dir 0..3),
 *   'missile' (slot = owner, cd = kind), 'beam' (slot = owner, cd = dir), 'monster', 'padlock'.
 * Events: sfx (v = original sound id), paint, cash, capture, pickup, crate, power, arrow, missile, beam, hit, stun, steal,
 *   wipe, mine, boom, cross, line, lock, unlock, border, spawn, shield.
 */
import { atan2g } from '../ps1Angle';
import { DISC_CHARACTER, winnerCheerFrame } from '../look';
import { addBody, emit, rand } from '../physics';
import { cloneWorld } from '../sim';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { createPlayerDispatch, nextPlayerOrder, pickVariant, tickVersusTally, VERSUS_CLOCK_END, versusClock as pogoClock } from './common';

export const TP_N = 8;
export const TP_TILE = 1.8;
export const TP_HALF = (TP_N * TP_TILE) / 2;
export const TP_FRAMES = VERSUS_CLOCK_END;
export { pogoClock };

// ---- constants read from the overlay
const HOP_END = [0, 17, 17, 17, 17, 17, 17, 17, 16]; // c5372 counter: FUN_800b5ee4 lands when cnt >= total (c5074 = 17, 16 for char 8); +1 decision frame => 18 frame period
const DRAW_RESULT_TICKS = 120; // FUN_8007d9dc starts this timer at the verdict.
// FUN_800b5ee4 emits a landing effect on the character's matching hop pose.
const HOP_FX_FRAME = [0, 10, 14, 2, 2, 14, 14, 2, 2];
const STUN_FRAMES = 51; // FUN_800b6f34: c5368 counts up, cleared when > 0x32
const BOOST_FRAMES = 240; // pickup case 5: c5362 = 0xf0
const SHIELD_FRAMES = 240; // case 6 / padlock object
const MINE_WARNING = 0x20; // simulation flag for the first footprint in a monster crossing
const MINE_WARNING_TICKS = new Set([90, 60, 30, 20, 10]);
const MINE_FRAMES = 120; // monster footprint tile timer 0x78
const LOCK_FRAMES = 240; // tile state 10 timer 0xf0
const PROJ_SPEED = 9 / 256 * 4096 / 512; // FUN_800bc5bc: sin*9>>8 = 144 units/frame = 0.28125 tile
const PROJ_HIT = 160 / 512; // distance < 0xa0 units
const PROJ_MIN = (-0xa00 + 0x700) / 512, PROJ_MAX = (0x800 + 0x700) / 512;
export const POGO_TRAIL_FRAMES = 16; // 0x1000 scale, dropping by 0x100 each update
export const BEAM_FRAMES = 20; // FUN_800c2be8 starts the counter at 0x14; FUN_800b662c removes the beam at zero
// Event 0x14 in each family's script 0x30, including loops during the hold.
const BEAM_SPARK_AGES = [[], [1, 6, 11, 16], [1, 5, 9, 15, 19], [1, 5, 9, 13, 17],
  [1, 5, 9, 13, 17], [1, 6, 11, 16], [1, 5, 9, 15, 19], [1, 6, 11, 16], [1, 5, 10, 15, 17]];
const CRATE_GROW = 16; // scale +0x100 per frame up to 0x1000 (FUN_800baba8 case 2)
/** FUN_800bad74 / 800baef0: an item crate starts 0x1000 above its tile, falls at +14 per frame up to 160 and lands on its 32nd update. */
export const POGO_ITEM_LAND = 32;
// Crate age counts the spawn tick, so object update n runs at age n + 1. Players check pickups after the object pass.
const ARROW_READY = CRATE_GROW + 1; // FUN_800baba8 enters state 3 on update 16
const ITEM_READY = POGO_ITEM_LAND + 1; // FUN_800baef0 enters state 3 on the landing update
const ITEM_DROP = 0x1000, ITEM_FALL = 14, ITEM_FALL_MAX = 160, ITEM_BOUNCE = 15; // FUN_800bad74, 800baef0, 8007a26c
/** Native height of an item crate above its tile at a given crate age (FUN_8007a26c fall, then the 15-update bounce). */
export function pogoItemHeight(age: number): number {
  const update = age - 1;
  if (update >= POGO_ITEM_LAND) {
    // Each landing sets an upward speed of 0x40 with deceleration 8: 56, 104, ... 224 at the top.
    const b = (update - POGO_ITEM_LAND) % ITEM_BOUNCE;
    return 4 * b * (ITEM_BOUNCE - b);
  }
  let h = ITEM_DROP;
  for (let u = 2; u <= update; u++) h -= Math.min(ITEM_FALL_MAX, ITEM_FALL * (u - 1)); // the first update only turns the motion around
  return Math.max(0, h);
}
/** FUN_800baef0: the 0x2029 shadow under an item scales 0x1000 - 6h within 0x200 units of the floor. */
export const pogoItemShadow = (height: number) => height < 0x200 ? 0x1000 - 6 * height : 0;
/** FUN_800baba8 turns a ready arrow by an eighth of its unsigned error and steps the direction when the step falls below 2. */
function turnArrow(c: Crate) {
  const dir = (c.dir ?? 0) & 3;
  let error = ((c.yaw ?? 0) - (dir << 10)) & 0xfff;
  if (error > 0x800) error = 0x1000 - error; // FUN_80015480
  c.yaw = ((c.yaw ?? 0) + (error >> 3)) & 0xfff;
  if (error >> 3 < 2) c.dir = (dir + 1) & 3;
}
/** Level and object updates that run under the countdown, before the first playable frame. */
export const POGO_INTRO_TICKS = 112;
const STUN_LOCK = 9; // 8009d576 is held at 10 through the stun and blocks the next nine idle frames
// Idle scripts 0x2e and 0x2f per family: loop length and the VM events 0x11 dust + flash, 0x13 / 0x14 dust, 0x12 landing
// (FUN_800b6438). Tick 1 is the first idle update after FUN_800b6370.
type IdleLoop = { n: number; ev: Record<number, number> };
const IDLE_LOOP: (IdleLoop | null)[] = [null, { n: 17, ev: { 14: 0x14, 17: 0x12 } }, { n: 17, ev: { 13: 0x14, 17: 0x12 } },
  { n: 16, ev: { 1: 0x13, 16: 0x12 } }, { n: 16, ev: { 1: 0x13, 16: 0x12 } }, { n: 16, ev: { 13: 0x14, 16: 0x12 } },
  { n: 18, ev: { 14: 0x14, 18: 0x12 } }, { n: 17, ev: { 4: 0x11, 14: 0x12 } }, { n: 16, ev: { 2: 0x11, 15: 0x12 } }];
const IDLE_FAST_LOOP: (IdleLoop | null)[] = [null, { n: 9, ev: { 4: 0x12, 5: 0x14 } }, { n: 8, ev: { 7: 0x14, 8: 0x12 } },
  { n: 8, ev: { 1: 0x13, 8: 0x12 } }, { n: 8, ev: { 1: 0x13, 8: 0x12 } }, { n: 9, ev: { 7: 0x14, 9: 0x12 } },
  { n: 9, ev: { 7: 0x14, 9: 0x12 } }, { n: 9, ev: { 2: 0x11, 8: 0x12 } }, { n: 9, ev: { 2: 0x11, 8: 0x12 } }];
/** per char family 1..8 (c502c, c5050, c5074): hop move window start / frames (measured in-game for 1, 5, 6, 8) */
const FAM_S = [0, 3, 3, 5, 5, 5, 4, 3, 3];
const FAM_M = [0, 9, 9, 13, 13, 11, 12, 9, 13];
/** FUN_800b9c10 / b9d64 spawn tables (800c38b8..38e8), index lvl-10 */
const ITEM_START = [2, 2, 1, 1], ITEM_MAX = [3, 3, 1, 2], ARROW_START = [2, 2, 2, 0], ARROW_MAX = [2, 2, 2, 0];
/** AI index per level & difficulty (800c3678 / 3724 / 37bc / 3854); delay frames = 96 - 3*idx (tables 800c3a38 / c38f8) */
const AI_IDX = [[1, 12, 20], [1, 16, 24], [1, 16, 28], [1, 16, 24]];
/** padlock object: hops per stage (800c530c) and wait frames per stage (800c5334) */
const PAD_HOPS = [18, 16, 14, 13, 12, 10, 8, 7];
const PAD_WAIT = [1, 4, 7, 10, 14, 19, 23, 28];
/** L13 object callbacks completed before the first playable update. */
export const PADLOCK_INTRO_TICKS = 112;
/** monster action table lvl 12 (800c468c); 6 walk, 7 walk + cross tile, 8 walk + spin attack, 12 = restart */
const MON_ACTIONS = [6, 6, 6, 7, 6, 7, 6, 7, 6, 6, 8, 8, 6, 8];
/** lvl 11 border ring (800c3c14 row 0): 4 colours x 8 segments, row r is the ring shifted by r */
const RING = '00001111111122222222333333330000';

export const TP_START = [TP_N * (TP_N - 1), 0, TP_N - 1, TP_N * TP_N - 1]; // yellow BL, red TL, blue TR, green BR (view order)
const START_RX = [0, 0, 7, 7], START_RZ = [0, 7, 7, 0], START_HD = [2, 3, 3, 2];
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1]; // heading 0 +x, 1 -x, 2 +z (screen up), 3 -z

export const TP_VARIANTS = [
  { id: 'pogo', name: 'POGO PAINTER' },
  { id: 'agogo', name: 'POGO-A-GOGO' },
  { id: 'elpogoloco', name: 'EL POGO LOCO' },
  { id: 'padlock', name: 'POGO PADLOCK' },
];
export const TP_LEVEL: Record<string, number> = { pogo: 10, agogo: 11, elpogoloco: 12, padlock: 13 };
/** Item id -> short names (view). */
export const TP_ITEMS: Record<string, number[]> = { pogo: [1, 5], agogo: [2, 3, 5], elpogoloco: [1, 5], padlock: [4, 5] };

/** dir = arrow object +0x60 (0 +z, 1 +x, 2 -z, 3 -x), yaw = its node yaw. */
interface Crate { id: number; k: 'item' | 'arrow'; t: number; rx: number; rz: number; age: number; dir?: number; yaw?: number }
interface Cash { st: number; tm: number; rx: number; rz: number; age: number; id: number }
interface Pad { st: number; tm: number; rx: number; rz: number; age: number; stage: number; left: number; hop: number; tx: number; tz: number; px: number; pz: number; id: number }
interface Mon { st: number; tm: number; cyc: number; x: number; z: number; sx: number; sz: number; ax: number; az: number; dir: number; act: number; idx: number; hops: number; bf4: number; yaw?: number; goalYaw?: number; pose?: number; head?: number; shadowX?: number; shadowZ?: number; id: number; walking: number; lat: number }
interface Proj { id: number; own: number; kind: number; x: number; z: number; dir: number; hd: number; fl: number; firstTick?: number; stepX?: number; stepZ?: number }
export interface PogoProjectileTrail { x: number; y: number; z: number; tick: number }
interface Beam { id: number; own: number; dir: number; t: number; firstTick?: number }

interface PogoRoute {
  mode: 'search' | 'wander' | 'pickup' | 'square' | 'flood' | 'line';
  x: number; z: number; wait: number;
  squareStart: number; squareStep: number; odd: boolean;
}

interface Data {
  variant: string; lvl: number; ai: number;
  tiles: number[]; st: number[]; tm: number[]; prev: number[]; fl: number[]; rsv: number[]; cap: number[];
  cashPaint?: Record<number, { owner: number; edges: number; locked: boolean }>;
  score: number[]; shown?: number[]; item: number[]; itemT: number[]; itemAge: number[]; stun: number[]; hd: number[]; cnt: number[]; fam: number[]; fastHop?: boolean[];
  itemYaw?: number[];
  idle?: number[]; // idle script clock since FUN_800b6370
  fastIdle?: boolean[]; // script 0x2f was started by the last idle entry
  lock?: number[]; // idle frames left without movement after a stun
  carry?: boolean[]; // move flag 0x40 left set by an interrupted hop: one extra stride on the next hop's first update
  extra?: boolean[]; // the current hop took that stride
  shadow?: number[]; // rider shadow scale (4096 = 1)
  jetIdx?: [number, number]; // flame index of families 3 and 4 (800c52e4, 800c52e0)
  jetTilt?: number[]; // flame tilt in degrees (800c53cc)
  jetY?: number[]; // flame Y scale (4096 = 1)
  note?: number[]; // per tile: ripple number 2..8 from FUN_800b8660, played when the flip ends
  random?: [number, number];
  updateOrders?: number[][];
  freeQueued?: number; // transient during the live player pass, omitted from snapshots
  pendingStun?: number; // native player flag 0x800, consumed by the next rider update
  fx: number[]; fz: number[]; tx: number[]; tz: number[]; px: number[]; pz: number[]; on: boolean[]; prevFire: boolean[]; taz: number[];
  wx: number[]; wz: number[]; // AI random wander targets
  cpuRoute?: (PogoRoute | null)[];
  cpuLandedAt?: number[];
  crates: Crate[]; cash: Cash[]; pad: Pad | null; mon: Mon | null; proj: Proj[]; beams: Beam[];
  projTrail?: PogoProjectileTrail[];
  arT: number; arN: number; itT: number; itN: number;
  border: number; bdir: number; bsteps: number; bwait: number; btype: number; bwarn: number;
  over: boolean; resultHits?: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
/** view-order tile index for tile-space (rx, rz) */
export const tidx = (rx: number, rz: number) => (7 - rz) * 8 + rx;
export const tileCenter = (i: number): [number, number] => [((i % TP_N) + 0.5) * TP_TILE - TP_HALF, (Math.floor(i / TP_N) + 0.5) * TP_TILE - TP_HALF];
export const tileIndex = (x: number, z: number) => {
  const tx = Math.floor((x + TP_HALF) / TP_TILE), tz = Math.floor((z + TP_HALF) / TP_TILE);
  return tx < 0 || tz < 0 || tx >= TP_N || tz >= TP_N ? -1 : tz * TP_N + tx;
};
export const tileWorld = (rx: number, rz: number): [number, number] => [(rx - 3.5) * TP_TILE, (3.5 - rz) * TP_TILE];
export function tileCounts(d: { tiles: number[] }): number[] {
  const c = [0, 0, 0, 0];
  for (const o of d.tiles) if (o >= 0 && o < 4) c[o]++;
  return c;
}
const inb = (x: number, z: number) => x >= 0 && z >= 0 && x < 8 && z < 8;
const ri = (w: World, n: number) => Math.floor(rand(w) * n); // FUN_80015590(n)
const rnd = (v: number) => Math.floor(v + 0.5); // (pos + 0x800) >> 9 equivalent for tile-unit positions

/** Colour of the lvl-11 border segment beside tile (rx,rz) on the given side (0 left, 1 top, 2 right, 3 bottom) for ring offset r. */
export function borderColor(r: number, side: number, seg: number): number {
  const i = side === 0 ? seg : side === 1 ? 8 + seg : side === 2 ? 16 + (7 - seg) : 24 + (7 - seg);
  return RING.charCodeAt(((i - r) % 32 + 32) % 32) - 48;
}

/** FUN_800bbc94 picks one of 16 painted shapes, including joins to the moving rim. */
export function pogoJoinedEdges(i: number, tiles: number[], rim: number): number {
  const owner = tiles[i];
  if (owner < 0) return 0;
  const x = i % 8, row = i >> 3, z = 7 - row;
  const left = x ? tiles[i - 1] : borderColor(rim, 0, z);
  const right = x < 7 ? tiles[i + 1] : borderColor(rim, 2, z);
  const bottom = row < 7 ? tiles[i + 8] : borderColor(rim, 3, x);
  const top = row ? tiles[i - 8] : borderColor(rim, 1, x);
  return Number(left === owner) | Number(bottom === owner) << 1 |
    Number(right === owner) << 2 | Number(top === owner) << 3;
}

// ------------------------------------------------------------------ occupancy helpers
function occupant(d: Data, rx: number, rz: number, except = -1): number {
  for (let s = 0; s < MAX_SEATS; s++) if (d.on[s] && s !== except && rnd(d.px[s]) === rx && rnd(d.pz[s]) === rz) return s + 1;
  const m = d.mon;
  if (m && inb(rx, rz) && rnd(m.shadowX ?? m.x) === rx && rnd(m.shadowZ ?? m.z) === rz) return 5;
  return 0;
}
const crateAt = (d: Data, rx: number, rz: number): Crate | undefined => d.crates.find((c) => c.rx === rx && c.rz === rz);
const cashAt = (d: Data, rx: number, rz: number): Cash | undefined => d.cash.find((c) => c.st >= 2 && c.rx === rx && c.rz === rz);
const hasObj = (d: Data, rx: number, rz: number) => !!crateAt(d, rx, rz) || !!cashAt(d, rx, rz);
/** FUN_800c0afc: ready padlock on this tile */
const padAt = (d: Data, rx: number, rz: number) => !!d.pad && d.pad.st >= 3 && rnd(d.pad.px) === rx && rnd(d.pad.pz) === rz;
/** FUN_800bc04c: spawn-free tile */
function freeSpawn(d: Data, rx: number, rz: number): boolean {
  const i = tidx(rx, rz);
  if (occupant(d, rx, rz) || d.rsv[i] || hasObj(d, rx, rz)) return false;
  if (d.st[i] === 5 || d.st[i] === 6) return false;
  return !padAt(d, rx, rz);
}
function freeTile(w: World, d: Data): [number, number] | null {
  for (let t = 0; t < 10; t++) {
    const x = ri(w, 8), z = ri(w, 8);
    if (freeSpawn(d, x, z)) return [x, z];
  }
  return null;
}

// ------------------------------------------------------------------ sound / event helpers
function sfx(w: World, id: number, rx: number, rz: number, slot = -1) {
  const [x, z] = tileWorld(rx, rz);
  emit(w, 'sfx', x, z, slot, id);
}
function sfxP(w: World, d: Data, id: number, slot: number) {
  const [x, z] = tileWorld(d.px[slot], d.pz[slot]);
  emit(w, 'sfx', x, z, slot, id);
}

// ------------------------------------------------------------------ tile state machine
function setTile(d: Data, rx: number, rz: number, owner: number, st: number, tm: number, prev = -1) {
  const i = tidx(rx, rz);
  d.tiles[i] = owner; d.st[i] = st; d.tm[i] = tm; if (prev >= -1) d.prev[i] = prev;
  d.cap[i] = st === 10 ? 1 : 0;
  d.fl[i] &= ~MINE_WARNING;
}

/** FUN_800b87dc updates tile timers during play and results. */
export function tickPogoTiles(w: World) {
  const d = w.data as Data;
  delete d.cashPaint;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    const i = tidx(rx, rz);
    const expiry = d.st[i] === 10 ? 0 : 1; // flip, cash and mine callbacks expire as the timer passes below 2
    if (d.tm[i] > 0 && --d.tm[i] <= expiry) {
      if (d.st[i] === 0) {
        d.st[i] = 1;
        // An arrow or cross line plays its rising notes 0x516..0x51c as each tile turns over.
        const note = d.note?.[i] ?? 0;
        if (note >= 2 && note <= 8) sfx(w, 0x514 + note, rx, rz);
        if (note) d.note![i] = 0;
      }
      else if (d.st[i] === 3) { d.st[i] = 1; d.tiles[i] = -1; d.tm[i] = 0; }
      else if (d.st[i] === 5) boom(w, d, rx, rz);
      else if (d.st[i] === 10) { d.st[i] = 1; d.cap[i] = 0; }
    }
    if (d.st[i] === 5 && (d.fl[i] & MINE_WARNING) && MINE_WARNING_TICKS.has(d.tm[i])) sfx(w, 0x3f0, rx, rz);
    if (d.fl[i] & 0x10 && !occupant(d, rx, rz)) d.fl[i] &= ~0x10;
  }
}

/** FUN_800b7b1c: a landing paints; holding the shield locks the tile */
function paintTile(d: Data, rx: number, rz: number, p: number) {
  const i = tidx(rx, rz);
  const old = d.tiles[i];
  if (d.item[p] === 6) setTile(d, rx, rz, p, 10, LOCK_FRAMES, old);
  else setTile(d, rx, rz, p, 1, 0, old);
}
/** FUN_800b788c / c2338: cash every tile of p. Returns the count. */
function cashIn(w: World, d: Data, p: number): number {
  // c2338 changes ownership immediately but leaves the current face on the board until the tile callback.
  const owned: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (d.tiles[i] !== p) continue;
    owned.push(i);
    const owner = d.st[i] === 0 && (d.tm[i] === 10 || (w.tick & 1)) ? d.prev[i] : p;
    (d.cashPaint ??= {})[i] = { owner, edges: d.lvl === 11 ? pogoJoinedEdges(i, d.tiles, d.border) : 0, locked: d.st[i] === 10 };
  }
  for (const i of owned) setTile(d, i % 8, 7 - (i >> 3), -1, 3, 10, p);
  const n = owned.length;
  if (n && !d.over) {
    d.score[p] += n;
    const [x, z] = tileWorld(d.px[p], d.pz[p]);
    takeQueued(d); // floating score object
    emit(w, 'cash', x, z, p, n);
  }
  return n;
}
/** FUN_800b8f94: padlock level - landing on an own tile wipes everything you own */
function wipe(w: World, d: Data, p: number) {
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) if (d.tiles[tidx(rx, rz)] === p) { setTile(d, rx, rz, -1, 1, 0, -1); n++; }
  if (n) {
    sfx(w, 0x54b, d.px[p], d.pz[p], p);
    const [x, z] = tileWorld(d.px[p], d.pz[p]);
    emit(w, 'wipe', x, z, p, n);
  }
}
/** FUN_800b91e8: shield ends, locked tiles go back to normal */
function unlockAll(w: World, d: Data, p: number) {
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    const i = tidx(rx, rz);
    if (d.st[i] === 10 && d.tiles[i] === p) { d.st[i] = 1; d.cap[i] = 0; n++; }
  }
  if (n) { sfxP(w, d, 0x54d, p); const [x, z] = tileWorld(d.px[p], d.pz[p]); emit(w, 'unlock', x, z, p, n); }
}
/** FUN_800c1cf0: drop the held item (shield ends, speed ends) */
function clearItem(w: World, d: Data, p: number) {
  // Losing the speed item under script 0x2f re-enters idle: a hop in flight stops on the nearest tile without landing.
  if (d.item[p] === 5 && d.fastIdle?.[p] && !d.over && d.stun[p] === 0 && d.taz[p] === 0) {
    stopHop(d, p);
    enterIdle(d, p);
  }
  if (d.item[p] === 6) unlockAll(w, d, p);
  d.item[p] = 0; d.itemT[p] = 0;
}
/** FUN_800b9080: padlock pickup locks every tile you own */
function lockAll(w: World, d: Data, p: number) {
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    const i = tidx(rx, rz);
    if (d.st[i] === 1 && d.tiles[i] === p) { d.st[i] = 10; d.tm[i] = LOCK_FRAMES; d.cap[i] = 1; n++; }
  }
  const [x, z] = tileWorld(d.px[p], d.pz[p]);
  if (n) sfxP(w, d, 0x54c, p);
  emit(w, 'lock', x, z, p, n);
}

/** FUN_800b8660: paint a line of tiles from (rx,rz) along (dx,dz), rippling in (+4 frames per tile) */
function line(w: World, d: Data, rx: number, rz: number, dx: number, dz: number, p: number) {
  let tm = 6, note = 2;
  const notes = d.note ??= new Array(64).fill(0);
  while (inb(rx, rz)) {
    const i = tidx(rx, rz);
    const s = d.st[i];
    if (s !== 5 && s !== 6 && s !== 7) { setTile(d, rx, rz, p, 0, tm, d.tiles[i]); notes[i] = note++ & 0xff; tm += 4; }
    rx += dx; rz += dz;
  }
}

// ------------------------------------------------------------------ capture (FUN_800c1a18 / bb840 / bbb08)
function borderSeg(d: Data, side: number, seg: number): number { return borderColor(d.border, side, seg); }
function outsideTiles(d: Data, p: number, closingTile = -1) {
  const reach = new Uint8Array(64);
  const flood = (sx: number, sz: number) => {
    const q: [number, number][] = [[sx, sz]];
    while (q.length) {
      const [x, z] = q.pop()!;
      if (!inb(x, z)) continue;
      const i = tidx(x, z);
      if (i === closingTile || d.tiles[i] === p || reach[i]) continue;
      reach[i] = 1;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) q.push([x + a, z + b]); // 8-connected (FUN_800c1840)
    }
  };
  if (d.lvl === 11) {
    for (let i = 0; i < 8; i++) {
      const edges: [number, number, number][] = [[0, i, 0], [i, 7, 1], [7, i, 2], [i, 0, 3]]; // x, z, side
      for (const [x, z, side] of edges) {
        const seg = side === 0 || side === 2 ? z : x;
        const c = borderSeg(d, side, seg), c0 = seg > 0 ? borderSeg(d, side, seg - 1) : -9, c1 = seg < 7 ? borderSeg(d, side, seg + 1) : -9;
        // FUN_800bb840: a segment of my colour only lets the flood in at the ends of my run
        if (c !== p || (seg > 0 && c0 !== p) || (seg < 7 && c1 !== p)) flood(x, z);
      }
    }
  } else for (let i = 0; i < 8; i++) { flood(0, i); flood(7, i); flood(i, 0); flood(i, 7); }
  return reach;
}

function canCapture(d: Data, p: number, rx: number, rz: number) {
  const i = tidx(rx, rz);
  return d.tiles[i] !== p && !occupant(d, rx, rz) && d.st[i] !== 5 && d.st[i] !== 6 && d.st[i] !== 7;
}

function capture(w: World, d: Data, p: number): number {
  if (d.lvl === 10 || d.lvl === 13) return 0;
  const reach = outsideTiles(d, p);
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    const i = tidx(rx, rz);
    if (reach[i] || !canCapture(d, p, rx, rz)) continue;
    setTile(d, rx, rz, p, 0, 10, d.tiles[i]);
    n++;
  }
  if (n) {
    sfxP(w, d, 0x51d, p);
    const [x, z] = tileWorld(d.px[p], d.pz[p]);
    emit(w, 'capture', x, z, p, n);
    if (d.lvl === 11) cashIn(w, d, p);
  }
  return n;
}

// FUN_8007906c queues active object addresses before running the players. If a pickup or
// beam frees its address during that pass, the next allocation inherits its queued callback.
function takeQueued(d: Data): boolean {
  if (!d.freeQueued) return false;
  d.freeQueued--;
  return true;
}

// ------------------------------------------------------------------ hits
function stealTiles(w: World, d: Data, victim: number, owner: number) {
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    if (d.tiles[tidx(rx, rz)] === victim) { setTile(d, rx, rz, owner, 0, 10, victim); n++; }
  }
  sfxP(w, d, 0x552, victim);
  if (n) emit(w, 'steal', ...tileWorld(d.px[victim], d.pz[victim]), owner, n, victim);
}

function clearReservation(d: Data, owner: number) {
  for (let i = 0; i < d.rsv.length; i++) if (d.rsv[i] === owner) d.rsv[i] = 0;
}

function hitPlayer(w: World, d: Data, v: number, by: number, steal: boolean) {
  const pending = d.pendingStun ?? 0;
  if (d.over || d.stun[v] > 0 || (pending & (1 << v))) return;
  d.pendingStun = pending | (1 << v);
  if (steal && by >= 0 && by < 4) stealTiles(w, d, v, by);
  // Rockets and beams clear the item at contact. A mine only sets the hit flag until stun entry.
  if (by >= 0) clearItem(w, d, v);
  emit(w, 'hit', ...tileWorld(d.px[v], d.pz[v]), v, 1, by);
}

function removeBeam(w: World, d: Data, slot: number) {
  const beam = d.beams.find(b => b.own === slot);
  if (!beam) return;
  if (d.freeQueued !== undefined) d.freeQueued++;
  d.beams = d.beams.filter(b => b !== beam);
  w.bodies = w.bodies.filter(b => b.id !== beam.id);
}

/** FUN_800c159c + 800c2810: snap to the nearest tile and drop the reservation. The move flag 0x40 stays as the hop left it. */
function stopHop(d: Data, slot: number) {
  if (d.cnt[slot] >= 0 && hopSteps(d, slot, d.cnt[slot] + hopRate(d, slot)) > hopSteps(d, slot, d.cnt[slot])) {
    (d.carry ??= [false, false, false, false])[slot] = true;
  }
  const x = rnd(d.px[slot]), z = rnd(d.pz[slot]);
  d.px[slot] = d.fx[slot] = d.tx[slot] = x;
  d.pz[slot] = d.fz[slot] = d.tz[slot] = z;
  d.cnt[slot] = -1;
  clearReservation(d, slot + 1);
}

/** FUN_800b6c14 / 800b6df4. Contact sets the flag after the rider update. */
function enterStun(w: World, d: Data, slot: number) {
  // Dropping speed under script 0x2f runs the idle entry inside the stun entry (FUN_800c1cf0 -> FUN_800868b4(0x39)).
  // The rider is left in idle with the hit flag still set, and the stun starts on the next update without a second cry.
  const nested = d.item[slot] === 5 && !!d.fastIdle?.[slot] && d.stun[slot] === 0;
  const repeat = d.stun[slot] < 0;
  if (!nested) d.pendingStun = (d.pendingStun ?? 0) & ~(1 << slot);
  stopHop(d, slot);
  d.taz[slot] = 0;
  clearItem(w, d, slot);
  d.stun[slot] = nested ? -1 : 1;
  removeBeam(w, d, slot);
  const x = d.fx[slot], z = d.fz[slot];
  if (inb(x, z)) d.rsv[tidx(x, z)] = slot + 1;
  if (!repeat) emit(w, 'stun', ...tileWorld(x, z), slot, STUN_FRAMES / 30);
}

/** FUN_800b8180: a mine goes off - stuns every player within one tile */
function boom(w: World, d: Data, rx: number, rz: number) {
  for (let s = 0; s < MAX_SEATS; s++) {
    if (!d.on[s] || d.stun[s] > 0) continue;
    if (Math.abs(rnd(d.px[s]) - rx) < 1.5 && Math.abs(rnd(d.pz[s]) - rz) < 1.5) hitPlayer(w, d, s, -1, false);
  }
  setTile(d, rx, rz, -1, 1, 0, -1);
  sfx(w, [0x3ec, 0x3ed, 0x3ee, 0x3ef][ri(w, 4)], rx, rz);
  const [x, z] = tileWorld(rx, rz);
  takeQueued(d);
  emit(w, 'boom', x, z, -1, 1);
}

// ------------------------------------------------------------------ projectiles
// All four versus floors have their ground reference 16 PS1 units above the stage origin.
const projectileHeight = (owner: number) => (16 + (owner === 5 ? 512 : 384)) * TP_TILE / 512;

function spawnProj(w: World, d: Data, own: number, rx: number, rz: number, dir: number, kind: number, spinYaw?: number) {
  const [x, z] = tileWorld(rx, rz);
  const b = addBody(w, 'missile', own, x, z, 0.3, 0.2);
  b.y = projectileHeight(own); b.cd = kind; b.face = Math.atan2(DX[dir], -DZ[dir]);
  // Live steps pass the upcoming tick to stepProj. Result playback has already advanced w.tick.
  const firstTick = w.tick + (takeQueued(d) || d.over ? 1 : 2);
  const shot: Proj = { id: b.id, own, kind, x: rx, z: rz, dir, hd: dir, fl: 0, firstTick };
  if (spinYaw !== undefined) {
    const angle = spinYaw * Math.PI / 2048;
    b.face = -angle;
    shot.stepX = -((Math.round(4096 * Math.sin(angle)) * 9) >> 8);
    shot.stepZ = -((Math.round(4096 * Math.cos(angle)) * 9) >> 8);
  }
  d.proj.push(shot);
}
function fire(w: World, d: Data, p: number, padDir: number, input: InputState, locked: boolean) {
  const it = d.item[p];
  const rx = rnd(d.px[p]), rz = rnd(d.pz[p]);
  const dir = padDir >= 0 ? padDir : d.hd[p];
  const [x, z] = tileWorld(d.px[p], d.pz[p]);
  if (it === 1 || it === 4) { // FUN_800bc184
    // Digital aim resolves simultaneous directions in the order Up, Right, Down, Left.
    let aim = dir;
    if (input.y < -0.4) aim = 2;
    else if (input.x > 0.4) aim = 0;
    else if (input.y > 0.4) aim = 3;
    else if (input.x < -0.4) aim = 1;
    spawnProj(w, d, p, rx, rz, aim, it === 4 ? 3 : 1);
    emit(w, 'missile', x, z, p, 1, aim);
    sfxP(w, d, 0x522, p);
    clearItem(w, d, p);
  } else if (it === 2) { // FUN_800bc314: four ways, but never off the board
    for (const k of [1, 0, 3, 2]) if (inb(rx + DX[k], rz + DZ[k])) spawnProj(w, d, p, rx, rz, k, 2);
    emit(w, 'missile', x, z, p, 4, dir);
    sfxP(w, d, 0x43c, p);
    clearItem(w, d, p);
  } else if (it === 3) { // FUN_800ba51c: electro beam along the facing row/column
    const hop = d.cnt[p] < 0 && !locked ? hopDirection(d, p, padDir, input) : -1;
    const aim = hop >= 0 ? hop : d.hd[p];
    const room = aim === 0 ? 7 - rx : aim === 1 ? rx : aim === 2 ? 7 - rz : rz;
    if (room <= 0) return;
    // The object origin is half a tile ahead of the shooter's exact pre-movement position.
    const b = addBody(w, 'beam', p, x + DX[aim] * TP_TILE / 2, z - DZ[aim] * TP_TILE / 2, 0.3, 0.2);
    b.y = 80 * TP_TILE / 512;
    b.cd = aim; b.dash = room;
    d.beams.push({ id: b.id, own: p, dir: aim, t: BEAM_FRAMES, firstTick: w.tick + (takeQueued(d) ? 1 : 2) });
    d.taz[p] = BEAM_FRAMES;
    d.hd[p] = aim;
    // An idle rider already dispatched one stride. A rider firing in mid-hop stops where they are.
    if (hop >= 0) {
      const stride = Math.floor(512 / FAM_M[d.fam[p]]) / 512;
      d.px[p] += DX[hop] * stride;
      d.pz[p] += DZ[hop] * stride;
    }
    d.fx[p] = d.tx[p] = rnd(d.px[p]);
    d.fz[p] = d.tz[p] = rnd(d.pz[p]);
    d.cnt[p] = -1;
    clearReservation(d, p + 1);
    takeQueued(d); // script 8 at the far end
    emit(w, 'sfx', x, z, p, 0x520);
    emit(w, 'beam', x, z, p, aim, room);
    clearItem(w, d, p);
  }
}
function stepProj(w: World, d: Data, tick: number) {
  const dead = new Set<number>();
  const trail = d.projTrail;
  while (trail?.length && tick - trail[0].tick >= POGO_TRAIL_FRAMES) trail.shift();
  for (const m of d.proj) {
    const b = w.bodies.find((q) => q.id === m.id);
    const y = b?.y ?? projectileHeight(m.own);
    // FUN_800bc5bc emits every second odd tick into eight child slots. The child's
    // local offset grows at the same rate as the shot, keeping its world position fixed.
    const first = m.firstTick ??= tick;
    if (tick < first) continue;
    const phase = tick - first + (first & 1);
    if ((phase & 3) === 3 && phase < 32) {
      const [x, z] = tileWorld(m.x, m.z);
      (d.projTrail ??= []).push({ x, y, z, tick });
    }
    if (m.stepX !== undefined && m.stepZ !== undefined) {
      m.x = (Math.round(m.x * 512) + m.stepX) / 512;
      m.z = (Math.round(m.z * 512) + m.stepZ) / 512;
    } else {
      m.x += DX[m.dir] * PROJ_SPEED; m.z += DZ[m.dir] * PROJ_SPEED;
    }
    let hit = false;
    for (let s = 0; s < MAX_SEATS; s++) {
      if (!d.on[s] || s === m.own) continue;
      if (Math.hypot(d.px[s] - m.x, d.pz[s] - m.z) < PROJ_HIT) {
        hit = true;
        if (d.resultHits === undefined) {
          if (d.stun[s] === 0) hitPlayer(w, d, s, m.own, m.kind === 3);
        } else if (!(d.resultHits & (1 << s))) {
          // Entered result states keep their pose. An unfinished hop still handles its hit flag.
          if (d.cnt[s] >= 0 && d.taz[s] === 0) d.pendingStun = (d.pendingStun ?? 0) | (1 << s);
          d.resultHits |= 1 << s;
          if (m.kind === 3) stealTiles(w, d, s, m.own);
          clearItem(w, d, s);
        }
      }
    }
    const ended = hit || m.x < PROJ_MIN || m.x > PROJ_MAX || m.z < PROJ_MIN || m.z > PROJ_MAX;
    const [x, z] = tileWorld(m.x, m.z);
    if (b) { b.x = x; b.z = z; }
    if (ended) {
      dead.add(m.id);
      emit(w, 'pogoProjectileEnd', x, z, m.own, y);
      sfx(w, 0x521, m.x, m.z);
    }
  }
  if (dead.size) {
    d.proj = d.proj.filter((m) => !dead.has(m.id));
    w.bodies = w.bodies.filter((b) => !(b.kind === 'missile' && dead.has(b.id)));
  }
  // FUN_800ba994 includes the rounded origin in the hit line.
  for (const beam of d.beams) {
    if (!d.taz[beam.own]) {
      // Older hosts could transmit the beam after its owner had already been stunned.
      removeBeam(w, d, beam.own);
      continue;
    }
    if (tick < (beam.firstTick ?? 0)) continue;
    const body = w.bodies.find(b => b.id === beam.id);
    if (!body) continue;
    beam.t = d.taz[beam.own];
    const dx = DX[beam.dir], dz = DZ[beam.dir];
    // Older snapshots place the body at the shooter.
    const offset = beam.firstTick === undefined ? 0.5 : 0;
    const ox = rnd(3.5 + Math.round(body.x * 512 / TP_TILE) / 512 + dx * offset);
    const oz = rnd(3.5 - Math.round(body.z * 512 / TP_TILE) / 512 + dz * offset);
    for (let s = 0; s < MAX_SEATS; s++) {
      if (!d.on[s] || s === beam.own || d.stun[s] > 0) continue;
      const x = rnd(d.px[s]) - ox, z = rnd(d.pz[s]) - oz;
      if (x * dz === z * dx && x * dx + z * dz >= 0) hitPlayer(w, d, s, beam.own, false);
    }
  }
}

// ------------------------------------------------------------------ pickups (FUN_800b935c)
function pickup(w: World, d: Data, p: number) {
  const rx = rnd(d.px[p]), rz = rnd(d.pz[p]);
  if (!inb(rx, rz)) return;
  const [x, z] = tileWorld(rx, rz);
  if (padAt(d, rx, rz)) { // padlock object (lvl 13)
    clearItem(w, d, p);
    d.item[p] = 6; d.itemT[p] = SHIELD_FRAMES; d.itemAge[p] = 0;
    const pad = d.pad!;
    // Several seats can reach the same rounded tile before the object gets its hide callback.
    if (pad.st !== 6) emit(w, 'pickup', ...tileWorld(pad.px, pad.pz), p, 6);
    pad.st = 6;
    lockAll(w, d, p);
    return;
  }
  const cash = cashAt(d, rx, rz);
  const cr = crateAt(d, rx, rz);
  if (!cash && !cr) return;
  const reserved = d.rsv[tidx(rx, rz)];
  if (reserved && reserved !== p + 1) return;
  // FUN_800ba018: only once the object reaches state 3 (an arrow has grown, an item has landed).
  if (cr && cr.age < (cr.k === 'item' ? ITEM_READY : ARROW_READY)) return;
  if (cash && cash.st !== 3) return;
  if (d.lvl !== 13) applyLanding(w, d, p, rx, rz);
  if (cr && cr.k === 'item') {
    const t = cr.t;
    if (t === 5) { if (d.item[p] !== 5) clearItem(w, d, p); d.item[p] = 5; d.itemT[p] = BOOST_FRAMES; sfx(w, 0x41c, rx, rz, p); }
    else { clearItem(w, d, p); d.item[p] = t; sfx(w, t === 2 ? 0x438 : t === 3 ? 0x51e : 0x51f, rx, rz, p); }
    d.itemAge[p] = 0;
    d.itN--;
    emit(w, 'pickup', x, z, p, t);
  } else if (cr && cr.k === 'arrow') {
    const dir = arrowDir(cr); // +0x60 & 3
    const v: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    sfx(w, 0x515, rx, rz, p);
    line(w, d, rx, rz, v[dir][0], v[dir][1], p);
    if (cr.t === 8) line(w, d, rx, rz, v[dir ^ 2][0], v[dir ^ 2][1], p);
    d.arN--;
    emit(w, 'line', x, z, p, cr.t, dir);
    capture(w, d, p);
  } else if (cash) {
    sfx(w, 0x514, rx, rz, p);
    cashIn(w, d, p);
    cash.st = 4;
    emit(w, 'pogoCashCrate', x, z, p);
  }
  if (cr?.k === 'item') capture(w, d, p);
  takeQueued(d); // pickup puff or cash-crate break
  if (cr) {
    if (d.freeQueued !== undefined) d.freeQueued++;
    d.crates = d.crates.filter((c) => c !== cr);
    w.bodies = w.bodies.filter((b) => b.id !== cr.id);
  }
}

// ------------------------------------------------------------------ landing (FUN_800b5ee4 -> b8af8 + b8be4)
function land(w: World, d: Data, p: number, rx = d.tx[p], rz = d.tz[p]) {
  d.fx[p] = rx; d.fz[p] = rz; d.px[p] = rx; d.pz[p] = rz;
  sfx(w, 0x55e + d.fam[p] - 1, rx, rz, p); // FUN_800b8af8: landing sound per character
  applyLanding(w, d, p, rx, rz);
  enterIdle(d, p);
}

/** FUN_800b6370: every idle entry restarts the bounce script, 0x2f while the speed item is held. */
function enterIdle(d: Data, p: number, clock = 0) {
  d.cnt[p] = -1;
  (d.idle ??= [0, 0, 0, 0])[p] = clock;
  (d.fastIdle ??= [false, false, false, false])[p] = d.item[p] === 5;
}

/** FUN_800b6438: the idle bounce lands on its tile again, with the landing sound, on VM event 0x12. */
function tickIdle(w: World, d: Data, p: number) {
  const idle = d.idle ??= [0, 0, 0, 0], fast = d.fastIdle ??= [false, false, false, false];
  const loop = (fast[p] ? IDLE_FAST_LOOP : IDLE_LOOP)[d.fam[p]];
  if (!loop) return;
  const event = loop.ev[idle[p]++ % loop.n + 1];
  const rx = rnd(d.px[p]), rz = rnd(d.pz[p]);
  if (event === 0x12) {
    sfx(w, 0x55e + d.fam[p] - 1, rx, rz, p);
    applyLanding(w, d, p, rx, rz);
    if (fast[p] && d.item[p] !== 5) enterIdle(d, p);
  } else if (event) {
    takeQueued(d);
    emit(w, 'pogoDust', ...tileWorld(d.px[p], d.pz[p]), p, event === 0x11 ? 6 : 4);
  }
  // The jet families take their flame index from the idle word: 0x4000 / 0x4080 plus the frame, in steps of 2 under 0x2f.
  const family = d.fam[p];
  if (family === 3 || family === 4) jetIndex(d)[family - 3] = (fast[p] ? 2 : 1) * (idle[p] % (fast[p] ? IDLE_FAST_LOOP : IDLE_LOOP)[family]!.n);
}

/** The idle VM event that FUN_800b6438 handles as its clock passes `clock` under the countdown (script 0x2e). */
export function pogoIntroEvent(family: number, clock: number): number | undefined {
  const loop = IDLE_LOOP[family];
  return loop ? loop.ev[clock % loop.n + 1] : undefined;
}

// FUN_800b5b1c: the flame under families 3 and 4. 800c52e4 (family 3) and 800c52e0 (family 4) are shared by
// every rider of that family. Indices other than 0 and 20 draw a random Y scale from the first 16 entries.
export const POGO_JET_SCALE = [4096, 4352, 4608, 5120, 5632, 6144, 7680, 8192, 7936, 7680, 7936, 8192, 6656, 4608, 4096, 4096,
  4096, 4096, 4096, 4096, 2048]; // 800c44d8
const jetIndex = (d: Data) => d.jetIdx ??= [0, 0];
function tickJet(w: World, d: Data, p: number) {
  const family = d.fam[p];
  if (family !== 3 && family !== 4) return;
  const tilt = d.jetTilt ??= [5, 5, 5, 5]; // 800c53cc, degrees; FUN_800c327c starts it at 5
  tilt[p] = d.cnt[p] >= 0 && !d.stun[p] && !d.taz[p] ? Math.min(45, tilt[p] + 5) : Math.max(5, tilt[p] - 2);
  let idx = jetIndex(d)[family - 3];
  if (idx > 20) idx = 0;
  if (idx !== 20 && idx !== 0) idx = ri(w, 16);
  (d.jetY ??= [4096, 4096, 4096, 4096])[p] = POGO_JET_SCALE[idx];
}

/** FUN_800b8be4: resolve the tile separately from the hop animation and landing sound. */
function applyLanding(w: World, d: Data, p: number, rx: number, rz: number, silent = false) {
  if (!inb(rx, rz)) return;
  const i = tidx(rx, rz);
  d.rsv[i] = 0;
  if (!silent && !d.over) (d.cpuLandedAt ??= [-2, -2, -2, -2])[p] = w.tick; // 800c5ae0
  const stepped = d.tiles[i] !== p;
  if (stepped) { if (!silent) sfx(w, 0x55a + p, rx, rz, p); d.fl[i] |= 0x10; } // FUN_800b8dfc
  const [x, z] = tileWorld(rx, rz);
  // FUN_800c1ea8 (lvl 12): the cross tile paints its whole row and column
  if (d.lvl === 12 && d.st[i] === 7) {
    paintTile(d, rx, rz, p);
    // FUN_800b8660 starts every arm on the centre tile, which flips first.
    if (rx > 0) line(w, d, rx, rz, -1, 0, p);
    if (rx < 7) line(w, d, rx, rz, 1, 0, p);
    if (rz > 0) line(w, d, rx, rz, 0, -1, p);
    if (rz < 7) line(w, d, rx, rz, 0, 1, p);
    capture(w, d, p);
    if (!silent) sfx(w, 0x515, rx, rz, p);
    emit(w, 'cross', x, z, p, 1);
    return;
  }
  // FUN_800c1da4 (lvl 13)
  if (d.lvl === 13) {
    if (d.st[i] === 10) { if (!silent) sfx(w, 0x54e + p, rx, rz, p); return; }
    if (d.tiles[i] === p && !(d.fl[i] & 0x10)) { wipe(w, d, p); return; }
  }
  const o = d.tiles[i];
  if (o !== -1) {
    if (o === p) return;
    const s = d.st[i];
    if (s === 5) { boom(w, d, rx, rz); return; }
    if (s !== 1 && s !== 3) return; // flipping / locked / cross tiles cannot be taken
  }
  paintTile(d, rx, rz, p);
  emit(w, 'paint', x, z, p, 0.5, o >= 0 && o < 4 ? 1 : 0);
  if (w.params.brush > 0) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const nx = rx + a, nz = rz + b;
    if (!inb(nx, nz) || (!a && !b)) continue;
    const j = tidx(nx, nz);
    if (d.st[j] === 5 || d.st[j] === 7 || d.st[j] === 10 || d.tiles[j] === p) continue;
    setTile(d, nx, nz, p, 1, 0, d.tiles[j]);
  }
  capture(w, d, p);
}

// ------------------------------------------------------------------ movement
/** FUN_800bdcb8. `cpu` = avoid mines (human players may walk into them), `own` = lvl 13 CPU avoids its own tiles. */
function canMove(d: Data, p: number, rx: number, rz: number, cpu: boolean, own: boolean): boolean {
  if (!inb(rx, rz)) return false;
  const i = tidx(rx, rz);
  if (occupant(d, rx, rz, p)) return false;
  if (d.rsv[i] && d.rsv[i] !== p + 1) return false;
  if (cpu && (d.st[i] === 5 || d.st[i] === 6)) return false;
  // Pass 1 on Pogo Padlock refuses the CPU's own paint unless it holds the shield or a cash crate stands there.
  if (own && d.lvl === 13 && d.tiles[i] === p && d.item[p] !== 6 && !cashAt(d, rx, rz)) return false;
  return true;
}
function padDirOf(inp: InputState): number {
  const mag = Math.hypot(inp.x, inp.y);
  if (mag < 0.4) return -1;
  return Math.abs(inp.x) > Math.abs(inp.y) ? (inp.x > 0 ? 0 : 1) : inp.y > 0 ? 3 : 2;
}
function hopDirection(d: Data, p: number, dir: number, input: InputState): number {
  const rx = d.fx[p], rz = d.fz[p];
  if (Math.abs(input.x) > 0.4 && Math.abs(input.y) > 0.4) {
    // FUN_800b574c keeps the last legal direction: vertical overrides horizontal.
    const vertical = input.y > 0 ? 3 : 2;
    dir = canMove(d, p, rx, rz + DZ[vertical], false, false) ? vertical : (input.x > 0 ? 0 : 1);
  }
  if (d.item[p] === 5 && dir < 0) dir = d.hd[p]; // speed state hops on its own in the facing direction
  return dir >= 0 && canMove(d, p, rx + DX[dir], rz + DZ[dir], false, false) ? dir : -1;
}
function decide(w: World, d: Data, p: number, dir: number, input: InputState) {
  dir = hopDirection(d, p, dir, input);
  if (dir < 0) return;
  const nx = d.fx[p] + DX[dir], nz = d.fz[p] + DZ[dir];
  clearReservation(d, p + 1);
  d.rsv[tidx(nx, nz)] = p + 1;
  d.tx[p] = nx; d.tz[p] = nz; d.hd[p] = dir; d.cnt[p] = 0;
  (d.fastHop ??= [false, false, false, false])[p] = d.item[p] === 5;
  (d.extra ??= [false, false, false, false])[p] = !!d.carry?.[p];
  if (d.carry) d.carry[p] = false;
  // FUN_800c2dcc: taking off lands on the tile once more, without the step sound.
  applyLanding(w, d, p, d.fx[p], d.fz[p], true);
}
const hopRate = (d: Data, p: number) => (d.fastHop?.[p] ?? (d.item[p] === 5)) ? 2 : 1;
/** Strides taken once the hop counter reads `cnt`. The previous counter gates movement. Fast hops visit only even counters. */
function hopSteps(d: Data, p: number, cnt: number) {
  const fam = d.fam[p], pre = FAM_S[fam] - 2, span = FAM_M[fam], rate = hopRate(d, p);
  const first = Math.floor(pre / rate);
  return Math.max(0, Math.min(Math.floor((pre + span) / rate) - first, cnt / rate - first - 1));
}
function hopPos(d: Data, p: number) {
  if (d.cnt[p] < 0) { d.px[p] = d.fx[p]; d.pz[p] = d.fz[p]; return; }
  const span = FAM_M[d.fam[p]], rate = hopRate(d, p);
  const steps = hopSteps(d, p, d.cnt[p]) + (d.extra?.[p] && d.cnt[p] >= rate ? 1 : 0);
  const stride = rate * Math.floor(512 / (rate === 2 ? span + span % 2 : span));
  const prog = steps * stride / 512;
  d.px[p] = d.fx[p] + (d.tx[p] - d.fx[p]) * prog;
  d.pz[p] = d.fz[p] + (d.tz[p] - d.fz[p]) * prog;
}

function advanceHop(w: World, d: Data, slot: number) {
  const previous = d.cnt[slot], family = d.fam[slot];
  d.cnt[slot] += hopAdvance(w, d, slot);
  // FUN_800b5ee4: the shadow shrinks to 0xc00 at the top of the hop and stays at its landing size while idle.
  (d.shadow ??= [0x1a00, 0x1a00, 0x1a00, 0x1a00])[slot] = 0xc00 + 0x100 * Math.abs((HOP_END[family] >> 1) - Math.min(HOP_END[family], Math.floor(d.cnt[slot])));
  if (family === 3 || family === 4) jetIndex(d)[family - 3] = Math.min(HOP_END[family], Math.floor(d.cnt[slot]));
  if (d.cnt[slot] >= HOP_END[family]) {
    land(w, d, slot);
    return;
  }
  hopPos(d, slot);
  const trigger = HOP_FX_FRAME[family];
  if (previous < trigger && d.cnt[slot] >= trigger) {
    const [x, z] = tileWorld(d.px[slot], d.pz[slot]);
    takeQueued(d);
    emit(w, 'pogoDust', x, z, slot, family >= 7 ? 6 : 4);
  }
}

function hopAdvance(w: World, d: Data, slot: number) {
  const fast = d.fastHop?.[slot] ?? (d.item[slot] === 5);
  return (fast ? 2 : 1) * w.params.speed;
}

export function pogoWinnerTailTicks(char: number) {
  return winnerCheerFrame(char) + 2 + 90 + 30;
}

/** Result window measured from the terminal snapshot, including an unfinished winner hop. */
export function pogoResultWindowTicks(w: World | undefined, winner: number | undefined, char = 0) {
  if (winner === undefined) return DRAW_RESULT_TICKS;
  if (!w) return Math.max(...HOP_END) + pogoWinnerTailTicks(char);
  const d = w.data as Data;
  let counter = d.cnt[winner];
  let entry = 1;
  if (counter >= 0 && !d.stun[winner] && !d.taz[winner]) {
    if ((d.pendingStun ?? 0) & (1 << winner)) return 2 + pogoWinnerTailTicks(char);
    const advance = hopAdvance(w, d, winner);
    const end = HOP_END[d.fam[winner]];
    // Accumulate like advanceHop, including fractional Double Time increments.
    while ((counter += advance) < end) entry++;
  }
  return entry + pogoWinnerTailTicks(char);
}

function turnRider(body: Body, dir: number, shift: number) {
  const yaw = Math.round(-body.face * 2048 / Math.PI) & 4095;
  const target = [3072, 1024, 2048, 0][dir];
  const error = (target - yaw) & 4095;
  body.face = -((yaw + ((error > 2048 ? error - 4096 : error) >> shift)) & 4095) * Math.PI / 2048;
}

function beamCentre(position: number) {
  const raw = Math.round(position * 512);
  return (raw - Math.trunc((raw - rnd(position) * 512) / 4)) / 512;
}

function advanceBeam(w: World, d: Data, body: Body) {
  const s = body.slot;
  const x = rnd(d.px[s]), z = rnd(d.pz[s]);
  d.px[s] = beamCentre(d.px[s]);
  d.pz[s] = beamCentre(d.pz[s]);
  turnRider(body, d.hd[s], 3);
  const age = BEAM_FRAMES - --d.taz[s];
  if (BEAM_SPARK_AGES[d.fam[s]].includes(age)) {
    takeQueued(d);
    emit(w, 'pogoBeamSpark', ...tileWorld(d.px[s], d.pz[s]), s);
  }
  if (!d.taz[s]) {
    removeBeam(w, d, s);
    d.fx[s] = d.tx[s] = x;
    d.fz[s] = d.tz[s] = z;
    enterIdle(d, s);
  }
}

function syncPlayer(d: Data, p: Body) {
  const slot = p.slot, family = d.fam[slot], counter = d.cnt[slot];
  const [x, z] = tileWorld(d.px[slot], d.pz[slot]);
  const moving = counter >= FAM_S[family] && counter < HOP_END[family];
  const prog = Math.max(0, Math.min(1, (counter - FAM_S[family]) / FAM_M[family]));
  p.x = x; p.z = z; p.y = moving ? 4 * prog * (1 - prog) : 0;
  if (!d.taz[slot] && !d.stun[slot]) turnRider(p, d.hd[slot], 2);
}

/** Result actors finish an active hop before switching states (FUN_800b5ee4). */
export function finishPogoHop(w: World, p: Body): boolean {
  const d = w.data as Data, slot = p.slot;
  if (!(d.cnt[slot] >= 0) || d.stun[slot] > 0 || d.taz[slot] > 0) return false;
  // A moving rider handles a pending hit before the verdict. Idle and beam states take the verdict first.
  if ((d.pendingStun ?? 0) & (1 << slot)) {
    enterStun(w, d, slot);
    syncPlayer(d, p);
    return true;
  }
  advanceHop(w, d, slot);
  syncPlayer(d, p);
  return d.cnt[slot] >= 0;
}

/** Result updates run on the view's copy of the final world. */
export function enterPogoResult(w: World, p: Body, lose: boolean) {
  const d = w.data as Data, slot = p.slot;
  clearItem(w, d, slot);
  d.pendingStun = (d.pendingStun ?? 0) & ~(1 << slot);
  d.stun[slot] = 0; d.taz[slot] = 0; d.cnt[slot] = -1;
  clearReservation(d, slot + 1);
  removeBeam(w, d, slot);
  if (lose) {
    d.px[slot] = rnd(d.px[slot]); d.pz[slot] = rnd(d.pz[slot]); // FUN_800b6960
    [p.x, p.z] = tileWorld(d.px[slot], d.pz[slot]);
  }
  p.y = 0;
}

export function pogoWinnerLand(w: World, slot: number) {
  const d = w.data as Data;
  land(w, d, slot, rnd(d.px[slot]), rnd(d.pz[slot]));
}

/** FUN_800b574c checks pickups before the player's current state handler, including during results. */
export function pogoResultPickup(w: World, p: Body, entered: boolean) {
  const d = w.data as Data, slot = p.slot;
  pickup(w, d, slot);
  if (entered) clearItem(w, d, slot);
  else advanceItemYaw(d, slot);
}

/** FUN_800b76cc spins the held-item node and retains its angle while the slot is empty. */
function advanceItemYaw(d: Data, slot: number) {
  if (!d.item[slot]) return;
  const yaw = d.itemYaw ??= d.itemAge.map(age => Math.max(0, age - 1) * 0x71 & 0xfff);
  yaw[slot] = (yaw[slot] + 0x71) & 0xfff;
}

/** Only the renderer owns this copy. The terminal snapshot remains the source of the round result. */
export function createPogoResult(terminal: World): World {
  const w = cloneWorld(terminal);
  const d = w.data as Data;
  d.over = true;
  d.resultHits = d.stun.reduce((mask, stun, slot) => stun > 0 ? mask | (1 << slot) : mask, d.pendingStun ?? 0);
  // Recover the fixed-point positions after snapshot rounding, including a shot exactly on a bound.
  for (const m of d.proj) {
    m.x = Math.round(m.x * 512) / 512;
    m.z = Math.round(m.z * 512) / 512;
  }
  if (d.pad) {
    d.pad.px = Math.round(d.pad.px * 512) / 512;
    d.pad.pz = Math.round(d.pad.pz * 512) / 512;
  }
  w.ev = [];
  return w;
}

/** Object callbacks that continue after timeout, when the overlay's spawners and border are gated off. */
export function tickPogoResultObjects(w: World) {
  const d = w.data as Data;
  tickArenaCrates(w, d);
  tickPad(w, d);
  tickMonster(w, d);
  stepProj(w, d, w.tick);
  syncCrates(w, d);
}

// ------------------------------------------------------------------ crates, padlock, monster, border
function newBody(w: World, kind: string, x: number, z: number, r = 0.6): Body { return addBody(w, kind, -1, x, z, r, 1); }

/** Snapshots from before the arrow kept +0x60 used a fixed start direction and a 32-frame turn. */
const arrowDir = (c: Crate) => c.dir ?? Math.floor(1 + (c.age - ARROW_READY) / 32) & 3;

/** FUN_800b9c10 picks the tile, then the type, and FUN_800ba3e0 draws the start direction. */
function spawnArrow(w: World, d: Data) {
  const f = freeTile(w, d);
  if (!f || (d.lvl !== 10 && d.lvl !== 11)) return; // El Pogo Loco runs the timer and tile draws without a type
  const t = d.lvl === 10 || ri(w, 3) !== 0 ? 7 : 8;
  const [x, z] = tileWorld(f[0], f[1]);
  const b = newBody(w, 'arrow', x, z); b.m = t;
  const dir = ri(w, 4);
  d.crates.push({ id: b.id, k: 'arrow', t, rx: f[0], rz: f[1], age: 0, dir, yaw: dir << 10 });
  d.arN++;
  emit(w, 'arrow', x, z, -1, t);
}
/** FUN_800b9d64 / 800ba25c. FUN_800bad74 starts the item 0x1000 above the tile with sfx 0x41f. */
function spawnItem(w: World, d: Data) {
  let t = 0;
  const f = freeTile(w, d);
  if (!f) return;
  if (d.lvl === 10) t = ri(w, 3) === 0 ? 5 : 1;
  else if (d.lvl === 11) { const r = ri(w, 5); t = r === 0 ? 3 : r < 3 ? 5 : 2; }
  else if (d.lvl === 12) t = ri(w, 2) === 0 ? 1 : 5;
  else t = ri(w, 2) === 0 ? 4 : 5;
  const [x, z] = tileWorld(f[0], f[1]);
  const b = newBody(w, 'power', x, z); b.cd = t;
  d.crates.push({ id: b.id, k: 'item', t, rx: f[0], rz: f[1], age: 0 });
  d.itN++;
  sfx(w, 0x41f, f[0], f[1]);
  emit(w, 'power', x, z, -1, t);
}
function tickSpawners(w: World, d: Data) {
  const l = d.lvl - 10;
  // FUN_800b9c10 (arrow crates)
  if (d.arT === -1) { if (d.arN < ARROW_START[l]) d.arT = 40 + ri(w, 70); }
  else {
    const s = d.arT - 1;
    d.arT = s;
    if (s <= 4) {
      spawnArrow(w, d);
      d.arT = ARROW_MAX[l] < d.arN ? -1 : 40 + ri(w, 70);
    }
  }
  // FUN_800b9d64 (item crates)
  if (d.itT === -1) { if (ITEM_START[l] > d.itN) d.itT = 60 + ri(w, 60); }
  else {
    d.itT--;
    if (d.itT <= 1) {
      spawnItem(w, d);
      d.itT = ITEM_MAX[l] < d.itN ? -1 : 60 + ri(w, 60);
    }
  }
}

function tickArenaCrates(w: World, d: Data) {
  // cash crates (FUN_800bb12c): wait, place, grow 16 frames, ready (AI waits a while), after use 40..79 frames
  for (const c of d.cash) {
    if (c.st === 0) { if (--c.tm < 1) c.st = 1; }
    else if (c.st === 1) {
      const f = freeTile(w, d);
      if (f) {
        c.rx = f[0]; c.rz = f[1]; c.st = 2; c.age = 0;
        const [x, z] = tileWorld(f[0], f[1]);
        const b = newBody(w, 'crate', x, z); c.id = b.id;
        sfx(w, 0x3fa, f[0], f[1]);
        emit(w, 'crate', x, z, -1, 1);
      }
    } else if (c.st === 2 || c.st === 3) {
      c.age++;
      if (c.age >= CRATE_GROW + (d.over ? 0 : 1)) c.st = 3;
    }
    else if (c.st === 4) { w.bodies = w.bodies.filter((b) => b.id !== c.id); c.st = 0; c.tm = 40 + ri(w, 40); }
  }
  for (const c of d.crates) {
    c.age++;
    const update = c.age - 1;
    if (c.k === 'arrow') { // FUN_800baba8
      if (update === 1) sfx(w, 0x3fa, c.rx, c.rz);
      else if (update > CRATE_GROW && c.dir !== undefined) turnArrow(c);
    } else if (update === POGO_ITEM_LAND) sfx(w, 0x420, c.rx, c.rz); // FUN_800baef0 landing
  }
}

function syncCrates(w: World, d: Data) {
  for (const b of w.bodies) {
    if (b.kind === 'power' || b.kind === 'arrow') {
      const c = d.crates.find((q) => q.id === b.id);
      if (c) {
        b.dash = c.age;
        if (b.kind === 'arrow') {
          b.cd = arrowDir(c);
          // The view draws the node yaw. Older snapshots ease towards the direction instead.
          if (c.yaw !== undefined) b.vz = c.yaw;
        }
      }
    } else if (b.kind === 'crate') {
      const c = d.cash.find((q) => q.id === b.id);
      if (c) b.dash = c.age;
    }
  }
}

function tickPad(w: World, d: Data) {
  const pd = d.pad;
  if (!pd) return;
  switch (pd.st) {
    case 0: // hidden, waiting to appear (FUN_800c0584 case 0)
      if (--pd.tm > 0) break;
      for (let k = 0; k < 10; k++) {
        const x = ri(w, 8), z = ri(w, 8);
        if (freeSpawn(d, x, z) && k < 9) {
          pd.rx = x; pd.rz = z; pd.px = x; pd.pz = z; pd.st = 1; pd.tm = 10; pd.age = 0;
          pd.stage = 0; pd.left = PAD_HOPS[0];
          const [wx, wz] = tileWorld(x, z);
          const b = newBody(w, 'padlock', wx, wz); pd.id = b.id; b.vx = 0;
          break;
        }
      }
      break;
    case 1: // grows 16 frames
      pd.age++;
      if (pd.age > 16) { pd.st = 3; pd.tm = PAD_WAIT[pd.stage]; }
      break;
    case 3: // wait; after PAD_HOPS hops the stage advances and it gets slower
      if (--pd.tm < 1) {
        if (pd.stage < 7 && --pd.left < 1) { pd.stage++; pd.left = PAD_HOPS[pd.stage]; }
        pd.st = 4;
      }
      break;
    case 4: { // pick a free neighbour (5 tries)
      let tries = 0, ok = false;
      let x = 0, z = 0;
      const cx = rnd(pd.px), cz = rnd(pd.pz);
      while (tries < 5 && !ok) {
        const k = ri(w, 4);
        if (k === 1 && cx < 1) { continue; }
        if (k === 0 && cz < 1) continue;
        if (k === 3 && cx > 6) continue;
        if (k === 2 && cz > 6) continue;
        // real code: 0 = -z, 1 = -x, 2 = +z, 3 = +x
        x = cx + (k === 1 ? -1 : k === 3 ? 1 : 0); z = cz + (k === 0 ? -1 : k === 2 ? 1 : 0);
        tries++;
        if (tries === 5) break; // fifth in-bounds draw enters the retry wait before probing the tile
        ok = inb(x, z) && !hasObj(d, x, z) && !occupant(d, x, z) && !d.rsv[tidx(x, z)];
      }
      if (!ok) { pd.st = 3; pd.tm = 5; break; }
      pd.tx = x; pd.tz = z; pd.st = 5; pd.hop = 18;
      break;
    }
    case 5: { // glide: closes 1/6 of the distance per frame, snaps after 18
      const x = Math.round(pd.px * 512), z = Math.round(pd.pz * 512);
      pd.px = (x + Math.trunc((pd.tx * 512 - x) / 6)) / 512;
      pd.pz = (z + Math.trunc((pd.tz * 512 - z) / 6)) / 512;
      if (--pd.hop < 1) { pd.px = pd.tx; pd.pz = pd.tz; pd.st = 3; pd.tm = PAD_WAIT[pd.stage]; }
      break;
    }
    case 6: // collected: hide, come back after 120 frames
      w.bodies = w.bodies.filter((b) => b.id !== pd.id);
      pd.st = 0; pd.tm = 120;
      return;
  }
  if (pd.st === 0) return;
  const body = w.bodies.find(q => q.id === pd.id);
  if (body) {
    [body.x, body.z] = tileWorld(pd.px, pd.pz);
    body.vx = pd.st === 1 ? Math.min(1, pd.age / 16) : 1;
  }
}

// The monster numbers directions -Z, -X, +Z, +X.
function monsterTarget(bx: number, bz: number, dir: number, lateral = 0): [number, number] {
  if (dir === 0 || dir === 2) return [bx + lateral, bz + (dir === 0 ? -2 : 2)];
  return [bx + (dir === 1 ? -2 : 2), bz + lateral];
}

/** FUN_800bfa14 folds an overshooting hop around the corner of the rim. */
function patrolHop(m: Mon, bx: number, bz: number) {
  let [x, z] = monsterTarget(bx, bz, m.dir);
  if (z < -1 || z > 8) {
    z = Math.max(-1, Math.min(8, z));
    if (x === -1) { x++; m.dir = 3; }
    else if (x === 8) { x--; m.dir = 1; }
  } else if (x < -1 || x > 8) {
    x = Math.max(-1, Math.min(8, x));
    if (z === -1) { z++; m.dir = 2; }
    else if (z === 8) { z--; m.dir = 0; }
  } else if ((x === -1 || x === 8) && (z === -1 || z === 8)) {
    const verticalArrival = m.dir === (z === 8 ? 2 : 0);
    m.dir = verticalArrival ? (x === -1 ? 3 : 1) : (z === -1 ? 2 : 0);
  }
  monSetHop(m, x, z);
}

function monSetHop(m: Mon, ax: number, az: number) {
  m.sx = m.x; m.sz = m.z; m.ax = ax; m.az = az;
  m.goalYaw = (atan2g(Math.round((ax - m.x) * 512), Math.round((az - m.z) * 512)) + 2048) & 4095;
}

function tickMonster(w: World, d: Data) {
  const m = d.mon;
  if (!m) return;
  const b = w.bodies.find(q => q.id === m.id);
  m.shadowX = m.x; m.shadowZ = m.z;
  m.yaw ??= Math.round((m.head ?? 0) * 2048 / Math.PI) & 4095;
  const place = () => {
    if (!b) return;
    [b.x, b.z] = tileWorld(m.x, m.z);
    b.face = -(m.yaw ?? 0) * Math.PI / 2048;
    b.dash = b.face;
    b.vx = m.st;
  };
  if (m.st === 1) {
    m.pose = 0x4080 + (160 - m.tm) % 26;
    if (--m.tm < 2) {
      m.st = 2; m.tm = 100 + ri(w, 60); m.dir = w.tick & 1 ? 1 : 3;
      sfx(w, 0x542, m.x, m.z);
    }
    place();
    return;
  }
  if (m.st === 5) {
    m.yaw = (m.yaw + 22) & 4095;
    m.pose = 0x4000 + (140 - m.tm) % 21;
    m.tm--;
    if (m.pose === 0x4012) {
      spawnProj(w, d, 5, m.x, m.z, 0, 1, m.yaw);
      sfx(w, 0x522, m.x, m.z);
    }
    if (m.tm <= 0 || d.over) { m.st = 4; m.hops = 100; }
    place();
    return;
  }
  // FUN_800bf8e4 moves in whole PS1 units on hop frames 2–11.
  if (inb(m.ax, m.az)) {
    clearReservation(d, 5);
    d.rsv[tidx(m.ax, m.az)] = 5;
  }
  const drift = Math.min(10, Math.max(0, m.cyc - 1));
  m.x = (Math.round(m.sx * 512) + drift * Math.trunc(Math.round((m.ax - m.sx) * 512) / 10)) / 512;
  m.z = (Math.round(m.sz * 512) + drift * Math.trunc(Math.round((m.az - m.sz) * 512) / 10)) / 512;
  const turn = (m.yaw - (m.goalYaw ?? 0)) & 4095;
  m.yaw = (m.yaw - ((turn > 2048 ? turn - 4096 : turn) >> 1)) & 4095;
  m.pose = 0x4100 + m.cyc;
  if (m.st === 2 && m.tm > 0 && !d.over) m.tm--; // keep hopping, but timeout freezes the patrol's action countdown
  m.cyc++;
  if (m.cyc <= 13) { place(); return; }
  m.cyc = 0; // decision frame
  sfx(w, 0x53c + ri(w, 6), m.x, m.z);
  const bx = rnd(m.x), bz = rnd(m.z);
  if (m.st === 2) {
    if (m.tm > 0) { // patrol the rim, 2 cells per hop
      patrolHop(m, bx, bz);
    } else {
      const idx = m.idx++ % (MON_ACTIONS.length + 1);
      const a = idx >= MON_ACTIONS.length ? 6 : MON_ACTIONS[idx];
      m.act = a; m.hops = 0;
      m.st = a === 8 ? 4 : 3;
      if (bx === 8) m.dir = 1;
      else if (bx === -1) m.dir = 3;
      else if (bz === 8) m.dir = 0;
      else if (bz === -1) m.dir = 2;
      monNext(w, d, m, bx, bz);
      m.bf4 = a === 6 ? 50 : ri(w, 3) + 1;
      sfx(w, w.tick & 1 ? 0x542 : 0x543, bx, bz);
    }
  } else if (m.st === 3 || m.st === 4) {
    // landing tile: mine (state 5, 120 frames) or, once, the cross tile (state 7)
    if (inb(bx, bz) && m.hops < 100) {
      if (m.st === 3) {
        const cross = m.hops === m.bf4;
        setTile(d, bx, bz, 5, cross ? 7 : 5, cross ? 0 : MINE_FRAMES);
        if (m.hops === 0 && !cross) d.fl[tidx(bx, bz)] |= MINE_WARNING;
        emit(w, 'mine', ...tileWorld(bx, bz), -1, cross ? 2 : 1);
      } else if (m.hops === m.bf4) { m.st = 5; m.tm = 140; }
      m.hops++;
    }
    if (monNext(w, d, m, bx, bz)) {
      clearReservation(d, 5);
      m.st = 2; m.tm = 100 + ri(w, 80);
    }
  }
  place();
}

function monsterCanLand(d: Data, x: number, z: number): boolean {
  if (!inb(x, z)) return true;
  const owner = d.rsv[tidx(x, z)];
  return (owner === 0 || owner === 5) && !occupant(d, x, z) && !hasObj(d, x, z);
}

/** FUN_800bfc6c chooses a landing, or turns along the rim if the hop leaves the board. */
function monNext(w: World, d: Data, m: Mon, bx: number, bz: number): boolean {
  for (let tries = 1; ; tries++) {
    if (tries > 5) {
      // The disc keeps drawing forever on a completely blocked board. Let the host
      // advance one hop in place so riders can release their reservations.
      const hasExit = [0, 1, 2, 3].some(dir =>
        [-1, 0, 1].some(side => monsterCanLand(d, ...monsterTarget(bx, bz, dir, side))));
      if (!hasExit) { monSetHop(m, bx, bz); return false; }
      m.dir = ri(w, 4);
      tries = 0;
    }
    let [x, z] = monsterTarget(bx, bz, m.dir, ri(w, 3) - 1);
    if (!monsterCanLand(d, x, z)) continue;
    const outside = !inb(x, z);
    if (x < 0 || x > 7) {
      m.dir = (w.tick & 1) ? 0 : 2;
      if (x < -1 || x > 8) { x = x < -1 ? -1 : 8; z += z < 4 ? 1 : -1; }
    } else if (z < 0 || z > 7) {
      m.dir = (w.tick & 1) ? 1 : 3;
      if (z < -1 || z > 8) { z = z < -1 ? -1 : 8; x += x < 4 ? 1 : -1; }
    }
    monSetHop(m, x, z);
    return outside;
  }
}

function tickBorder(w: World, d: Data) {
  if (d.lvl !== 11) return;
  const rem = pogoClock(w.tick + 1); // timer digits before the current frame's decrement
  if (d.btype === 0) { // waiting for 1:15, 1:00, 0:45, 0:30, 0:15
    if ([75, 60, 45, 30, 15].includes(rem) && d.bwarn !== -rem) {
      d.btype = ri(w, 4) + 1; d.bwarn = -rem;
      d.bdir = d.btype <= 2 ? 1 : -1;
      d.bsteps = d.btype % 2 === 1 ? 8 : 16;
      d.bwait = 8;
      sfx(w, 0x534, 0, 0);
      emit(w, 'border', 0, 0, -1, 0, d.btype);
    } else if ([77, 76, 62, 61, 47, 46, 32, 31, 17, 16].includes(rem) && d.bwarn !== rem) { d.bwarn = rem; sfx(w, 0x532, 0, 0); }
    return;
  }
  if (--d.bwait > 0) return;
  d.border = ((d.border + d.bdir) % 32 + 32) % 32;
  for (let p = 0; p < MAX_SEATS; p++) capture(w, d, p); // every player re-checks (FUN_800bcb4c)
  sfx(w, 0x533, 0, 0);
  emit(w, 'border', 0, 0, -1, 1, d.border);
  if (--d.bsteps < 1) { d.btype = 0; ri(w, 200); } else d.bwait = 8; // the unused versus delay draw
}

// ------------------------------------------------------------------ CPU routing
function ownsRouteTile(d: Data, p: number, x: number, z: number) {
  if (inb(x, z)) return d.tiles[tidx(x, z)] === p;
  if (d.lvl !== 11) return false;
  if (z >= 0 && z < 8 && (x === -1 || x === 8)) return borderSeg(d, x === -1 ? 0 : 2, z) === p;
  if (x >= 0 && x < 8 && (z === -1 || z === 8)) return borderSeg(d, z === -1 ? 3 : 1, x) === p;
  return false;
}

/** FUN_800c0f08 / 800be158: scan for an own tile past a gap, facing forward and to either side. */
function lineRoute(d: Data, p: number, x: number, z: number): [number, number] | null {
  const dx = DX[d.hd[p]], dz = DZ[d.hd[p]];
  const rays = [[dx, dz], [-dz, dx], [dz, -dx]];
  const gap = [false, false, false];
  for (let n = 1; n <= 8; n++) for (const [i, [sx, sz]] of rays.entries()) {
    const nx = x + n * sx, nz = z + n * sz;
    if (inb(nx, nz) && !ownsRouteTile(d, p, nx, nz)) gap[i] = true;
    if (gap[i] && ownsRouteTile(d, p, nx, nz)) {
      const tx = Math.max(0, Math.min(7, nx)), tz = Math.max(0, Math.min(7, nz));
      return occupant(d, tx, tz) ? null : [tx, tz];
    }
  }
  return null;
}

/** FUN_800be864 / 800bea34 / 800beb6c: try a single closing tile with the native capture flood. */
function floodRoute(d: Data, p: number, rx: number, rz: number): [number, number] | null {
  let best = Infinity;
  let target: [number, number] | null = null;
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) {
    const dd = (x - rx) ** 2 + (z - rz) ** 2;
    if (dd >= best || ownsRouteTile(d, p, x, z) || occupant(d, x, z)) continue;
    let adjacent = 0;
    for (let k = 0; k < 4; k++) if (ownsRouteTile(d, p, x + DX[k], z + DZ[k])) adjacent++;
    if (adjacent < 2) continue;
    const closing = tidx(x, z), reach = outsideTiles(d, p, closing);
    let captures = false;
    for (let i = 0; i < 64; i++) {
      if (i !== closing && !reach[i] && canCapture(d, p, i % 8, 7 - (i >> 3))) {
        captures = true;
        break;
      }
    }
    if (captures) { target = [x, z]; best = dd; }
  }
  return target;
}

// 800c45bc / 800c457c: two hops per side, with the first side chosen from the current quadrant.
const SQUARE_HEADS = [[1, 3, 0, 2], [0, 3, 1, 2]];
const SQUARE_START = [[4, 2, 6, 0], [6, 0, 4, 2]];
function nextSquareTile(cpu: PogoRoute, x: number, z: number) {
  const k = SQUARE_HEADS[Number(cpu.odd)][((cpu.squareStart + cpu.squareStep) & 7) >> 1];
  cpu.x = x + DX[k];
  cpu.z = z + DZ[k];
}


/** FUN_800ba110 grades a tile for the CPU: the object's type, 9 for a cross tile, 0 when it cannot be a target. */
function aiPickupTile(d: Data, p: number, x: number, z: number): number {
  // FUN_800c0afc: the padlock is checked first and has no grid object, so FUN_800bdf60 always accepts it.
  if (padAt(d, x, z)) return d.pad!.st === 6 ? 0 : 99;
  if (occupant(d, x, z)) return 0; // includes the CPU's own tile
  const reserved = d.rsv[tidx(x, z)];
  if (reserved && reserved !== p + 1) return 0;
  // +0x64 starts when the object reaches state 3 and must have run out.
  const delay = 96 - 3 * AI_IDX[d.lvl - 10][d.ai];
  const crate = crateAt(d, x, z);
  if (crate) return crate.age >= (crate.k === 'item' ? ITEM_READY : ARROW_READY) + delay ? crate.t : 0;
  const cash = cashAt(d, x, z);
  if (cash) return cash.st === 3 && cash.age >= CRATE_GROW + 1 + delay ? 10 : 0;
  return d.st[tidx(x, z)] === 7 ? 9 : 0;
}

/** FUN_800bdf60: the nearest tile that beats the held item, scanning x then z and keeping the first of equal distances. */
function pogoPickupTarget(d: Data, p: number, rx: number, rz: number): [number, number] | null {
  let best = Infinity;
  let target: [number, number] | null = null;
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) {
    const kind = aiPickupTile(d, p, x, z);
    if (!kind || d.item[p] >= kind) continue;
    const dd = (x - rx) ** 2 + (z - rz) ** 2;
    if (dd < best) { best = dd; target = [x, z]; }
  }
  return target;
}

/** FUN_800bd790: steer to the closest legal next tile, preferring +z, -z, +x, -x in a tie. */
function steerPogoBot(d: Data, p: number, rx: number, rz: number, x: number, z: number) {
  let best = Infinity, dir = -1;
  for (const avoidOwn of [true, false]) {
    for (const k of [2, 3, 0, 1]) {
      const nx = rx + DX[k], nz = rz + DZ[k];
      if (!canMove(d, p, nx, nz, true, avoidOwn)) continue;
      const dd = (nx - x) ** 2 + (nz - z) ** 2;
      if (dd < best) { best = dd; dir = k; }
    }
    if (dir >= 0 || d.lvl !== 13) break;
  }
  return dir;
}

// Derive the CPU's small random draws from the snapshot without consuming the arena's RNG.
function routeDraw(w: World, p: number, salt: number, limit: number) {
  const h = w.rng ^ Math.imul(w.tick + 1, 0x9e3779b1) ^ Math.imul(p + 1, 0x85ebca6b)
    ^ Math.imul(salt + 1, 0xc2b2ae35);
  return ((Math.imul(h ^ (h >>> 16), 0x7feb352d) ^ (h >>> 15)) >>> 0) % limit;
}

function seekPogoRoute(w: World, d: Data, p: number, cpu: PogoRoute, rx: number, rz: number) {
  // Only Pogo-a-gogo and El Pogo Loco try the line, flood and square routes.
  if ((d.lvl === 11 || d.lvl === 12) && cpu.wait === 0) {
    cpu.wait = 3 + routeDraw(w, p, 1, 3);
    const line = lineRoute(d, p, rx, rz);
    if (line) { cpu.mode = 'line'; [cpu.x, cpu.z] = line; return true; }
    const flood = d.lvl === 11 ? floodRoute(d, p, rx, rz) : null;
    if (flood) { cpu.mode = 'flood'; [cpu.x, cpu.z] = flood; return true; }
    if (d.tiles.filter((owner) => owner === p).length >= 9) {
      cpu.mode = 'square'; cpu.squareStep = 0; cpu.odd = (w.tick & 1) !== 0;
      cpu.squareStart = SQUARE_START[Number(cpu.odd)][((rx & 4) >> 1) | ((rz & 4) >> 2)];
      nextSquareTile(cpu, rx, rz);
      return true;
    }
  }
  const pickup = pogoPickupTarget(d, p, rx, rz);
  if (!pickup) return false;
  cpu.mode = 'pickup';
  [cpu.x, cpu.z] = pickup;
  return true;
}

/** FUN_800bd10c / 800bde24 on every stage: plan against the pre-step board and commit the state in step(). */
function planPogoRoute(w: World, d: Data, p: number) {
  const cpu: PogoRoute = d.cpuRoute?.[p] ? { ...d.cpuRoute[p] } : {
    mode: 'search', x: -1, z: -1, wait: 3 + routeDraw(w, p, 0, 3), squareStart: 0, squareStep: 0, odd: false,
  };
  const landed = d.cpuLandedAt?.[p] === w.tick - 1;
  if (landed && cpu.wait > 0 && (d.lvl === 11 || d.lvl === 12)) cpu.wait--;
  const rx = rnd(d.px[p]), rz = rnd(d.pz[p]);
  const mode = cpu.mode;
  if (mode === 'search' || mode === 'wander' || mode === 'pickup') {
    const found = seekPogoRoute(w, d, p, cpu, rx, rz);
    if (mode === 'search' && !found) {
      cpu.mode = 'wander';
      cpu.x = routeDraw(w, p, 2, 8); cpu.z = routeDraw(w, p, 3, 8);
    }
    if (mode === 'pickup' && !found) cpu.mode = 'search';
    if (mode === 'search' || (mode === 'wander' && found) || (mode === 'pickup' && !found)) return { cpu, dir: -1 };
  }

  // State 5 writes the next waypoint but steers against the previous target for this update.
  const { x, z } = cpu;
  if (rx === x && rz === z && cpu.mode !== 'pickup') {
    if (cpu.mode === 'square') {
      cpu.squareStep++;
      if (cpu.squareStep < 8) nextSquareTile(cpu, rx, rz);
    }
    if (cpu.mode !== 'square' || cpu.squareStep === 8 || !canMove(d, p, cpu.x, cpu.z, true, false)) {
      cpu.mode = 'search';
      cpu.wait = 3 + routeDraw(w, p, 4, 3);
      return { cpu, dir: -1 };
    }
  }
  const dir = steerPogoBot(d, p, rx, rz, x, z);
  if (landed && dir !== d.hd[p]) cpu.wait = 2 + routeDraw(w, p, 5, 2);
  return { cpu, dir };
}

// ------------------------------------------------------------------ the game
export const tilePainter: MiniGame = {
  id: 'tilePainter',
  name: 'Pogo Painter',
  description: 'Paint tiles by hopping. Land on cash crates to bank them. Highest score wins.',
  variantDescriptions: {
    agogo: 'Enclose tiles with your color to score instantly. The rotating border counts. Highest score wins.',
    elpogoloco: "Enclose tiles, then bank them at cash crates. Dodge the monster's mines. Highest score wins.",
    padlock: 'Bank the most tiles at cash crates. Landing on your color wipes your tiles. Grab the padlock to protect them.',
  },
  controls: '{move} hop. {a} fire held weapon.',
  variants: TP_VARIANTS,
  maxTime: TP_FRAMES / 30,
  settlesAfterTimeout: true,

  setup(w, slots) {
    const variant = pickVariant(w, TP_VARIANTS);
    const lvl = TP_LEVEL[variant];
    const forced = Number(w.data?.aiLevel);
    const z4 = () => [0, 0, 0, 0];
    const d: Data = {
      ...createPlayerDispatch(w.rng), variant, lvl, ai: Number.isFinite(forced) ? Math.max(0, Math.min(2, forced)) : slots[0]?.level ?? 1,
      tiles: new Array(64).fill(-1), st: new Array(64).fill(1), tm: new Array(64).fill(0), prev: new Array(64).fill(-1),
      fl: new Array(64).fill(0), rsv: new Array(64).fill(0), cap: new Array(64).fill(0),
      score: z4(), shown: z4(), item: z4(), itemT: z4(), itemAge: z4(), itemYaw: z4(), stun: z4(), hd: START_HD.slice(), cnt: [-1, -1, -1, -1],
      fam: Array.isArray(w.data?.fam) ? w.data.fam.slice(0, 4) : [1, 5, 6, 8],
      fx: START_RX.slice(), fz: START_RZ.slice(), tx: START_RX.slice(), tz: START_RZ.slice(), px: START_RX.slice(), pz: START_RZ.slice(),
      on: [false, false, false, false], prevFire: [false, false, false, false], taz: z4(), wx: z4(), wz: z4(),
      crates: [], cash: [], pad: null, mon: null, proj: [], beams: [],
      idle: new Array(4).fill(POGO_INTRO_TICKS), fastIdle: [false, false, false, false], lock: z4(), shadow: new Array(4).fill(0x1a00),
      note: new Array(64).fill(0),
      arT: -1, arN: 0, itT: -1, itN: 0,
      border: 0, bdir: 1, bsteps: 0, bwait: 0, btype: 0, bwarn: 0, over: false,
    };
    const forcedFamilies = Array.isArray(w.data?.fam);
    w.data = d;
    for (const s of slots) {
      if (!forcedFamilies && s.char != null && DISC_CHARACTER[s.char] != null) d.fam[s.slot] = DISC_CHARACTER[s.char];
      const b = addBody(w, 'player', s.slot, 0, 0, 0.6, 3);
      d.on[s.slot] = true;
      const rx = START_RX[s.slot], rz = START_RZ[s.slot];
      d.tiles[tidx(rx, rz)] = s.slot;
      d.fl[tidx(rx, rz)] |= 0x10; // painted by the first idle landing under the countdown
      const [x, z] = tileWorld(rx, rz);
      b.x = x; b.z = z; b.face = Math.atan2(DX[d.hd[s.slot]], -DZ[d.hd[s.slot]]);
      d.wx[s.slot] = rx; d.wz[s.slot] = rz;
    }
    const nCash = lvl === 10 ? 2 : lvl === 12 ? 3 : lvl === 13 ? 2 : 0;
    for (let k = 0; k < nCash; k++) d.cash.push({ st: 0, tm: 60 + ri(w, 60), rx: 0, rz: 0, age: 0, id: -1 }); // FUN_800c1b7c
    if (lvl === 11) ri(w, 200); // FUN_800c10f8 draws the first rotation delay, which versus never reads
    if (lvl === 12) {
      const [x, z] = tileWorld(3, 8);
      const b = addBody(w, 'monster', -1, x, z, 1, 5);
      d.mon = { st: 1, tm: 49, cyc: 0, x: 3, z: 8, sx: 3, sz: 8, ax: 3, az: 8, dir: 1, act: 0, idx: 0, hops: 0, bf4: 0, yaw: 0, goalYaw: 0, pose: 0x4086, id: b.id, walking: 0, lat: 0 };
    }
    // FUN_800b3e34 runs the arrow and item spawners and the crate objects under the countdown. Their sounds are
    // part of the intro, before the first simulated tick.
    const events = w.ev.length;
    for (let k = 0; k < POGO_INTRO_TICKS; k++) {
      tickSpawners(w, d);
      tickArenaCrates(w, d);
    }
    syncCrates(w, d);
    w.ev.length = events;
    if (lvl === 13) d.pad = { st: 0, tm: 240 - PADLOCK_INTRO_TICKS, rx: 4, rz: 4, age: 0, stage: 0, left: PAD_HOPS[0], hop: 0, tx: 4, tz: 4, px: 4, pz: 4, id: -1 };
  },

  step(w, inputs) {
    const d = w.data as Data;
    if (d.over) return;
    d.cpuRoute = d.on.map((on, slot) => on ? planPogoRoute(w, d, slot).cpu : null);
    tickPogoTiles(w);
    tickSpawners(w, d);
    tickArenaCrates(w, d);
    tickMonster(w, d);
    tickBorder(w, d);

    const tick = w.tick + 1;
    const locked = !!d.shown && tick > TP_FRAMES + 1;
    d.freeQueued = 0;
    const riders = players(w);
    for (const s of nextPlayerOrder(w.rng, d)) {
      const p = riders.find(rider => rider.slot === s);
      if (!p) continue;
      pickup(w, d, s);
      if (locked) clearReservation(d, s + 1);
      const inp = inputs[s] ?? IDLE;
      const dir = padDirOf(inp);
      const fireNow = (inp.a || inp.b) && !d.prevFire[s];
      d.prevFire[s] = inp.a || inp.b;
      // item timers
      if (d.item[s] === 5 || d.item[s] === 6) { if (--d.itemT[s] <= 0) clearItem(w, d, s); }
      if (d.item[s] > 0) d.itemAge[s]++;
      if ((d.pendingStun ?? 0) & (1 << s)) {
        enterStun(w, d, s);
      } else if (d.stun[s] > 0) {
        d.px[s] = d.fx[s]; d.pz[s] = d.fz[s];
        d.rsv[tidx(d.fx[s], d.fz[s])] = s + 1;
        // FUN_800b6f34 alternates the jet flame index between 0 and 20.
        const family = d.fam[s];
        if (family === 3 || family === 4) jetIndex(d)[family - 3] = jetIndex(d)[family - 3] === 0 ? 20 : 0;
        if (++d.stun[s] > STUN_FRAMES) {
          d.stun[s] = 0;
          clearReservation(d, s + 1);
          (d.lock ??= [0, 0, 0, 0])[s] = STUN_LOCK;
          enterIdle(d, s, 1); // FUN_800b6f34 runs the script once more after the idle entry
        }
      } else if (d.taz[s] > 0) {
        advanceBeam(w, d, p);
      } else {
        if (fireNow && d.item[s] > 0) fire(w, d, s, dir, inp, locked);
        if (d.taz[s] === 0) {
          if (d.cnt[s] >= 0) advanceHop(w, d, s);
          else {
            // FUN_800b574c: the input lock only clears the reservation
            if (d.lock?.[s]) { d.lock[s]--; clearReservation(d, s + 1); }
            else if (!locked) decide(w, d, s, dir, inp);
            if (d.cnt[s] < 0) tickIdle(w, d, s);
          }
        }
      }
      if (d.cnt[s] < 0 && d.stun[s] === 0 && d.taz[s] === 0) { d.px[s] = d.fx[s]; d.pz[s] = d.fz[s]; }
      syncPlayer(d, p);
      tickJet(w, d, s);
      advanceItemYaw(d, s);
    }
    delete d.freeQueued;
    tickPad(w, d);
    stepProj(w, d, tick);
    syncCrates(w, d);
    // Global timer phase at GO in the four recorded USA stage openings.
    d.over = d.shown ? tickVersusTally(d.score, d.shown, tick, d.lvl === 12 ? 1 : 0) : tick >= TP_FRAMES;
  },

  isOver(w) {
    const d = w.data as Data;
    return d.over || (!d.shown && w.time >= tilePainter.maxTime);
  },

  isDraw(w, [a, b]) { return w.data.score[a] === w.data.score[b]; },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  /** FUN_800bd10c chooses a route and fires after a reaction delay. */
  bot(w, slot): InputState {
    const d = w.data as Data;
    if (!d.on[slot] || d.stun[slot] > 0 || d.taz[slot] > 0) return IDLE;
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    const delay = 96 - 3 * AI_IDX[d.lvl - 10][d.ai];
    // FUN_800bd378 / bd520: an enemy ahead along the rounded row or column, after the reaction delay (+0x24)
    const it = d.item[slot];
    if (it >= 1 && it <= 4 && d.itemAge[slot] >= delay) {
      const rx = rnd(d.px[slot]), rz = rnd(d.pz[slot]);
      const body = w.bodies.find(b => b.kind === 'player' && b.slot === slot);
      // "Ahead" is the rider's current yaw quadrant: 0 -z, 1 -x, 2 +z, 3 +x.
      const quadrant = body ? (Math.round(-body.face * 2048 / Math.PI) & 4095) >> 10 : [3, 1, 2, 0][d.hd[slot]];
      for (let s = 0; s < MAX_SEATS; s++) {
        if (s === slot || !d.on[s]) continue;
        const ox = rnd(d.px[s]), oz = rnd(d.pz[s]);
        const ahead = quadrant === 0 ? ox === rx && oz < rz : quadrant === 1 ? oz === rz && ox < rx
          : quadrant === 2 ? ox === rx && oz > rz : oz === rz && ox > rx;
        if (it === 2 ? (ox === rx || oz === rz) : ahead) { out.a = true; break; }
      }
    }
    const dir = planPogoRoute(w, d, slot).dir;
    if (dir >= 0) { out.x = DX[dir]; out.y = -DZ[dir] || 0; }
    return out;
  },
};
