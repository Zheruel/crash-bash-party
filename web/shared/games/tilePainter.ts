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
 *   5 mine, 7 cross tile, 10 locked), tm[64] state timer, cap[64] 1 = locked (view pop), score[4], item[4] (0 none,
 *   1 missile 2 four-way 3 electro 4 steal gun 5 speed 6 shield), itemT[4], stun[4], hd[4] heading (0 +x 1 -x 2 up 3 down),
 *   cnt[4] hop counter (-1 idle), fx/fz/tx/tz[4] tile coordinates, px/pz[4] position in tile units, border (lvl 11 ring offset)
 * Bodies: 'player', 'crate' (cash crate), 'power' (item crate, cd = item id), 'arrow' (arrow crate, m = 7|8, cd = dir 0..3),
 *   'missile' (slot = owner, cd = kind), 'beam' (slot = owner, cd = dir), 'monster', 'padlock'.
 * Events: sfx (v = original sound id), paint, cash, capture, pickup, crate, power, arrow, missile, beam, hit, stun, steal,
 *   wipe, mine, boom, cross, line, lock, unlock, border, spawn, shield.
 */
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const TP_N = 8;
export const TP_TILE = 1.8;
export const TP_HALF = (TP_N * TP_TILE) / 2;
export const TP_FRAMES = 2700; // 1:30 at 30 Hz (FUN_8007b7fc(0x130)); timer ticks once per second, 30 frames each

// ---- constants read from the overlay
const HOP_END = 17; // c5372 counter: FUN_800b5ee4 lands when cnt >= total (c5074 = 17, 16 for char 8); +1 decision frame => 18 frame period
const STUN_FRAMES = 51; // FUN_800b6f34: c5368 counts up, cleared when > 0x32
const BOOST_FRAMES = 240; // pickup case 5: c5362 = 0xf0
const SHIELD_FRAMES = 240; // case 6 / padlock object
const MINE_FRAMES = 120; // monster footprint tile timer 0x78
const LOCK_FRAMES = 240; // tile state 10 timer 0xf0
const PROJ_SPEED = 9 / 256 * 4096 / 512; // FUN_800bc5bc: sin*9>>8 = 144 units/frame = 0.28125 tile
const PROJ_HIT = 160 / 512; // distance < 0xa0 units
const BEAM_FRAMES = 24; // tazing beam (estimate, anim 0x2005 per segment; not read)
const CRATE_GROW = 16; // scale +0x100 per frame up to 0x1000 (FUN_800baba8 case 2)
/** per char family 1..8 (c502c, c5050, c5074): hop move window start / frames (measured in-game for 1, 5, 6, 8) */
const FAM_S = [0, 3, 3, 5, 5, 5, 5, 3, 5];
const FAM_M = [0, 9, 9, 13, 13, 12, 12, 9, 13];
/** FUN_800b9c10 / b9d64 spawn tables (800c38b8..38e8), index lvl-10 */
const ITEM_START = [2, 2, 1, 1], ITEM_MAX = [3, 3, 1, 2], ARROW_START = [2, 2, 2, 0], ARROW_MAX = [2, 2, 2, 0];
/** AI index per level & difficulty (800c3678 / 3724 / 37bc / 3854); delay frames = 96 - 3*idx (tables 800c3a38 / c38f8) */
const AI_IDX = [[1, 12, 20], [1, 16, 24], [1, 16, 28], [1, 16, 24]];
/** padlock object: hops per stage (800c530c) and wait frames per stage (800c5334) */
const PAD_HOPS = [18, 16, 14, 13, 12, 10, 8, 7];
const PAD_WAIT = [1, 4, 7, 10, 14, 19, 23, 28];
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

interface Crate { id: number; k: 'item' | 'arrow'; t: number; rx: number; rz: number; age: number }
interface Cash { st: number; tm: number; rx: number; rz: number; age: number; id: number }
interface Pad { st: number; tm: number; rx: number; rz: number; age: number; stage: number; left: number; hop: number; tx: number; tz: number; px: number; pz: number; id: number }
interface Mon { st: number; tm: number; cyc: number; x: number; z: number; sx: number; sz: number; ax: number; az: number; dir: number; act: number; idx: number; hops: number; bf4: number; spin: number; head: number; id: number; walking: number; lat: number }
interface Proj { id: number; own: number; kind: number; x: number; z: number; dir: number; hd: number; fl: number }
interface Beam { id: number; own: number; dir: number; t: number }

interface Data {
  variant: string; lvl: number; ai: number;
  tiles: number[]; st: number[]; tm: number[]; prev: number[]; fl: number[]; rsv: number[]; cap: number[];
  score: number[]; item: number[]; itemT: number[]; itemAge: number[]; stun: number[]; hd: number[]; cnt: number[]; fam: number[];
  fx: number[]; fz: number[]; tx: number[]; tz: number[]; px: number[]; pz: number[]; on: boolean[]; prevFire: boolean[]; taz: number[];
  wx: number[]; wz: number[]; // AI random wander targets
  crates: Crate[]; cash: Cash[]; pad: Pad | null; mon: Mon | null; proj: Proj[]; beams: Beam[];
  arT: number; arN: number; itT: number; itN: number;
  border: number; bdir: number; bsteps: number; bwait: number; btype: number; bwarn: number;
  over: boolean;
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

// ------------------------------------------------------------------ occupancy helpers
function occupant(d: Data, rx: number, rz: number, except = -1): number {
  for (let s = 0; s < MAX_SEATS; s++) if (d.on[s] && s !== except && rnd(d.px[s]) === rx && rnd(d.pz[s]) === rz) return s + 1;
  if (d.mon && inb(rnd(d.mon.x), rnd(d.mon.z)) && rnd(d.mon.x) === rx && rnd(d.mon.z) === rz) return 5;
  return 0;
}
const crateAt = (d: Data, rx: number, rz: number): Crate | undefined => d.crates.find((c) => c.rx === rx && c.rz === rz);
const cashAt = (d: Data, rx: number, rz: number): Cash | undefined => d.cash.find((c) => c.st >= 2 && c.rx === rx && c.rz === rz);
const hasObj = (d: Data, rx: number, rz: number) => !!crateAt(d, rx, rz) || !!cashAt(d, rx, rz);
/** FUN_800c0afc: ready padlock on this tile */
const padAt = (d: Data, rx: number, rz: number) => !!d.pad && d.pad.st >= 3 && d.pad.st !== 6 && rnd(d.pad.px) === rx && rnd(d.pad.pz) === rz;
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
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    if (d.tiles[tidx(rx, rz)] === p) { setTile(d, rx, rz, -1, 3, 10, p); n++; }
  }
  if (n) {
    d.score[p] += n;
    const [x, z] = tileWorld(d.px[p], d.pz[p]);
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
  emit(w, 'lock', x, z, p, n);
}

/** FUN_800b8660: paint a line of tiles from (rx,rz) along (dx,dz), rippling in (+4 frames per tile) */
function line(w: World, d: Data, rx: number, rz: number, dx: number, dz: number, p: number) {
  let tm = 6;
  while (inb(rx, rz)) {
    const i = tidx(rx, rz);
    const s = d.st[i];
    if (s !== 5 && s !== 6 && s !== 7) { setTile(d, rx, rz, p, 0, tm, d.tiles[i]); tm += 4; }
    rx += dx; rz += dz;
  }
}

// ------------------------------------------------------------------ capture (FUN_800c1a18 / bb840 / bbb08)
function borderSeg(d: Data, side: number, seg: number): number { return borderColor(d.border, side, seg); }
function capture(w: World, d: Data, p: number): number {
  if (d.lvl === 10 || d.lvl === 13) return 0;
  const reach = new Uint8Array(64);
  const flood = (sx: number, sz: number) => {
    const q: [number, number][] = [[sx, sz]];
    while (q.length) {
      const [x, z] = q.pop()!;
      if (!inb(x, z) || d.tiles[tidx(x, z)] === p || reach[tidx(x, z)]) continue;
      reach[tidx(x, z)] = 1;
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
  let n = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    const i = tidx(rx, rz);
    if (reach[i] || d.tiles[i] === p || occupant(d, rx, rz) || d.st[i] === 5 || d.st[i] === 6 || d.st[i] === 7) continue;
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

// ------------------------------------------------------------------ hits
function hitPlayer(w: World, d: Data, v: number, by: number, steal: boolean) {
  if (d.stun[v] > 0) return;
  d.stun[v] = 1;
  const [x, z] = tileWorld(d.px[v], d.pz[v]);
  // FUN_800b6f34: the player stays on the tile he is nearest to
  if (d.cnt[v] >= 0) { d.fx[v] = rnd(d.px[v]); d.fz[v] = rnd(d.pz[v]); d.tx[v] = d.fx[v]; d.tz[v] = d.fz[v]; }
  for (let i = 0; i < 64; i++) if (d.rsv[i] === v + 1) d.rsv[i] = 0;
  d.cnt[v] = -1; d.taz[v] = 0;
  clearItem(w, d, v);
  if (steal && by >= 0 && by < 4) {
    let n = 0;
    for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) if (d.tiles[tidx(rx, rz)] === v) { setTile(d, rx, rz, by, 0, 10, v); n++; } // FUN_800bb724
    sfx(w, 0x552, d.px[v], d.pz[v], v);
    if (n) emit(w, 'steal', x, z, by, n, v);
  }
  emit(w, 'hit', x, z, v, 1, by);
  emit(w, 'stun', x, z, v, STUN_FRAMES / 30);
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
  emit(w, 'boom', x, z, -1, 1);
}

// ------------------------------------------------------------------ projectiles
function spawnProj(w: World, d: Data, own: number, rx: number, rz: number, dir: number, kind: number) {
  const [x, z] = tileWorld(rx, rz);
  const b = addBody(w, 'missile', own, x, z, 0.3, 0.2);
  b.y = 0.8; b.cd = kind; b.face = Math.atan2(DX[dir], -DZ[dir]);
  d.proj.push({ id: b.id, own, kind, x: rx, z: rz, dir, hd: dir, fl: 0 });
}
function fire(w: World, d: Data, p: number, padDir: number) {
  const it = d.item[p];
  const rx = rnd(d.px[p]), rz = rnd(d.pz[p]);
  const dir = padDir >= 0 ? padDir : d.hd[p];
  const [x, z] = tileWorld(d.px[p], d.pz[p]);
  if (it === 1 || it === 4) { // FUN_800bc184
    spawnProj(w, d, p, rx, rz, dir, it === 4 ? 3 : 1);
    sfx(w, 0x522, rx, rz, p);
    emit(w, 'missile', x, z, p, 1, dir);
    clearItem(w, d, p);
  } else if (it === 2) { // FUN_800bc314: four ways, but never off the board
    for (let k = 0; k < 4; k++) if (inb(rx + DX[k], rz + DZ[k])) spawnProj(w, d, p, rx, rz, k, 2);
    sfx(w, 0x43c, rx, rz, p);
    emit(w, 'missile', x, z, p, 4, dir);
    clearItem(w, d, p);
  } else if (it === 3) { // FUN_800ba51c: electro beam along the facing row/column
    const room = dir === 0 ? 7 - rx : dir === 1 ? rx : dir === 2 ? 7 - rz : rz;
    if (room <= 0) return;
    const b = addBody(w, 'beam', p, x, z, 0.3, 0.2);
    b.cd = dir; b.dash = room; b.face = Math.atan2(DX[dir], -DZ[dir]);
    d.beams.push({ id: b.id, own: p, dir, t: BEAM_FRAMES });
    d.taz[p] = BEAM_FRAMES;
    sfx(w, 0x520, rx, rz, p);
    emit(w, 'beam', x, z, p, dir, room);
    clearItem(w, d, p);
  }
}
function stepProj(w: World, d: Data) {
  const dead = new Set<number>();
  for (const m of d.proj) {
    m.x += DX[m.dir] * PROJ_SPEED; m.z += DZ[m.dir] * PROJ_SPEED;
    let hit = false;
    for (let s = 0; s < MAX_SEATS; s++) {
      if (!d.on[s] || s === m.own) continue;
      if (Math.hypot(d.px[s] - m.x, d.pz[s] - m.z) < PROJ_HIT) {
        hit = true;
        if (d.stun[s] === 0) hitPlayer(w, d, s, m.own, m.kind === 3);
      }
    }
    // the board spans -0xa00..0x800 in game units (x/z in tiles: -2.5 .. 4+... ) - beyond that the shot is gone
    if (hit || m.x < -2.5 + 0.5 - 0.5 - 0.5 || m.x > 7.5 + 0.5 + 0.0 || m.z < -2.5 + 0.5 - 0.5 - 0.5 || m.z > 7.5 + 0.5) dead.add(m.id);
    const b = w.bodies.find((q) => q.id === m.id);
    if (b) { const [x, z] = tileWorld(m.x, m.z); b.x = x; b.z = z; }
  }
  if (dead.size) {
    d.proj = d.proj.filter((m) => !dead.has(m.id));
    w.bodies = w.bodies.filter((b) => !(b.kind === 'missile' && dead.has(b.id)));
    for (const id of dead) { void id; }
  }
  // electro beams: everyone else on the line ahead of the shooter gets stunned (FUN_800ba994)
  for (const bm of d.beams) {
    bm.t--;
    const o = bm.own;
    for (let s = 0; s < MAX_SEATS; s++) {
      if (!d.on[s] || s === o || d.stun[s] > 0) continue;
      const sx = rnd(d.px[s]), sz = rnd(d.pz[s]), ox = rnd(d.px[o]), oz = rnd(d.pz[o]);
      const on = (bm.dir === 0 && sz === oz && sx > ox) || (bm.dir === 1 && sz === oz && sx < ox) || (bm.dir === 2 && sx === ox && sz > oz) || (bm.dir === 3 && sx === ox && sz < oz);
      if (on) hitPlayer(w, d, s, o, false);
    }
  }
  const ended = d.beams.filter((b) => b.t <= 0).map((b) => b.id);
  if (ended.length) {
    d.beams = d.beams.filter((b) => b.t > 0);
    w.bodies = w.bodies.filter((b) => !(b.kind === 'beam' && ended.includes(b.id)));
  }
}

// ------------------------------------------------------------------ pickups (FUN_800b935c)
function pickup(w: World, d: Data, p: number, rx: number, rz: number) {
  const [x, z] = tileWorld(rx, rz);
  if (padAt(d, rx, rz)) { // padlock object (lvl 13)
    clearItem(w, d, p);
    d.item[p] = 6; d.itemT[p] = SHIELD_FRAMES; d.itemAge[p] = 0;
    d.pad!.st = 6;
    lockAll(w, d, p);
    sfx(w, 0x54c, rx, rz, p);
    emit(w, 'pickup', x, z, p, 6);
    return;
  }
  const cash = cashAt(d, rx, rz);
  const cr = crateAt(d, rx, rz);
  if (!cash && !cr) return;
  if (cr && cr.age < CRATE_GROW + 1) return; // FUN_800ba018: only when fully grown (+0x5c >= 3)
  if (cash && cash.age < CRATE_GROW + 1) return;
  if (d.lvl !== 13) { /* FUN_800b8be4(p,1): paints the crate tile (already ours after the landing) */ }
  if (cr && cr.k === 'item') {
    const t = cr.t;
    if (t === 5) { if (d.item[p] !== 5) clearItem(w, d, p); d.item[p] = 5; d.itemT[p] = BOOST_FRAMES; sfx(w, 0x41c, rx, rz, p); }
    else { clearItem(w, d, p); d.item[p] = t; sfx(w, t === 2 ? 0x438 : t === 3 ? 0x51e : 0x51f, rx, rz, p); }
    d.itemAge[p] = 0;
    d.itN--;
    emit(w, 'pickup', x, z, p, t);
  } else if (cr && cr.k === 'arrow') {
    const dir = Math.floor(1 + (cr.age - 17) / 32) & 3; // +0x60 & 3 (counter bumps every ~32 frames once ready)
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
  }
  if (cr) {
    if (cr.k === 'item') capture(w, d, p);
    d.crates = d.crates.filter((c) => c !== cr);
    w.bodies = w.bodies.filter((b) => b.id !== cr.id);
  }
}

// ------------------------------------------------------------------ landing (FUN_800b5ee4 -> b8af8 + b8be4)
function land(w: World, d: Data, p: number) {
  const rx = d.tx[p], rz = d.tz[p];
  d.fx[p] = rx; d.fz[p] = rz; d.px[p] = rx; d.pz[p] = rz;
  d.cnt[p] = -1;
  const i = tidx(rx, rz);
  d.rsv[i] = 0;
  sfx(w, 0x55e + d.fam[p] - 1, rx, rz, p); // FUN_800b8af8: landing sound per character
  const stepped = d.tiles[i] !== p;
  if (stepped) { sfx(w, 0x55a + p, rx, rz, p); d.fl[i] |= 0x10; } // FUN_800b8dfc
  const [x, z] = tileWorld(rx, rz);
  // FUN_800c1ea8 (lvl 12): the cross tile paints its whole row and column
  if (d.lvl === 12 && d.st[i] === 7) {
    setTile(d, rx, rz, p, 1, 0, d.tiles[i]);
    line(w, d, rx - 1, rz, -1, 0, p); line(w, d, rx + 1, rz, 1, 0, p); line(w, d, rx, rz - 1, 0, -1, p); line(w, d, rx, rz + 1, 0, 1, p);
    capture(w, d, p);
    sfx(w, 0x515, rx, rz, p);
    emit(w, 'cross', x, z, p, 1);
    return;
  }
  // FUN_800c1da4 (lvl 13)
  if (d.lvl === 13) {
    if (d.st[i] === 10) { sfx(w, 0x54e + p, rx, rz, p); return; }
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
  if (own && d.lvl === 13 && d.tiles[i] === p && d.item[p] !== 6) return false;
  return true;
}
function padDirOf(inp: InputState): number {
  const mag = Math.hypot(inp.x, inp.y);
  if (mag < 0.4) return -1;
  return Math.abs(inp.x) > Math.abs(inp.y) ? (inp.x > 0 ? 0 : 1) : inp.y > 0 ? 3 : 2;
}
function decide(w: World, d: Data, p: number, dir: number) {
  const rx = d.fx[p], rz = d.fz[p];
  pickup(w, d, p, rx, rz);
  if (d.item[p] === 5 && dir < 0) dir = d.hd[p]; // speed state hops on its own in the facing direction
  if (dir < 0) return;
  const nx = rx + DX[dir], nz = rz + DZ[dir];
  if (!canMove(d, p, nx, nz, false, false)) return;
  d.rsv[tidx(nx, nz)] = p + 1;
  d.tx[p] = nx; d.tz[p] = nz; d.hd[p] = dir; d.cnt[p] = 0;
}
function hopPos(d: Data, p: number) {
  if (d.cnt[p] < 0) { d.px[p] = d.fx[p]; d.pz[p] = d.fz[p]; return; }
  const fam = d.fam[p], S = FAM_S[fam], M = FAM_M[fam];
  const prog = d.cnt[p] < S ? 0 : d.cnt[p] >= HOP_END ? 1 : Math.min(1, (d.cnt[p] - S + 1) / M);
  d.px[p] = d.fx[p] + (d.tx[p] - d.fx[p]) * prog;
  d.pz[p] = d.fz[p] + (d.tz[p] - d.fz[p]) * prog;
}

// ------------------------------------------------------------------ crates, padlock, monster, border
function newBody(w: World, kind: string, x: number, z: number, r = 0.6): Body { return addBody(w, kind, -1, x, z, r, 1); }

function spawnArrow(w: World, d: Data) {
  if (d.lvl !== 10 && d.lvl !== 11) return;
  const t = d.lvl === 10 ? 7 : ri(w, 3) !== 0 ? 7 : 8; // FUN_800b9c10
  const f = freeTile(w, d);
  if (!f) return;
  const [x, z] = tileWorld(f[0], f[1]);
  const b = newBody(w, 'arrow', x, z); b.m = t;
  d.crates.push({ id: b.id, k: 'arrow', t, rx: f[0], rz: f[1], age: 0 });
  d.arN++;
  sfx(w, 0x3fa, f[0], f[1]);
  emit(w, 'arrow', x, z, -1, t);
}
function spawnItem(w: World, d: Data) {
  let t = 0;
  const f = freeTile(w, d);
  if (!f) return;
  // FUN_800b9d64 per level
  if (d.lvl === 10) t = ri(w, 3) === 0 ? 5 : 1;
  else if (d.lvl === 11) { const r = ri(w, 5); t = r === 0 ? 3 : r < 3 ? 5 : 2; }
  else if (d.lvl === 12) t = ri(w, 2) === 0 ? 1 : 5;
  else t = ri(w, 2) === 0 ? 4 : 5;
  const [x, z] = tileWorld(f[0], f[1]);
  const b = newBody(w, 'power', x, z); b.cd = t;
  d.crates.push({ id: b.id, k: 'item', t, rx: f[0], rz: f[1], age: 0 });
  d.itN++;
  sfx(w, 0x3fa, f[0], f[1]);
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
    } else if (c.st === 2 || c.st === 3) { c.age++; if (c.age > CRATE_GROW) c.st = 3; }
    else if (c.st === 4) { w.bodies = w.bodies.filter((b) => b.id !== c.id); c.st = 0; c.tm = 40 + ri(w, 40); }
  }
  for (const c of d.crates) c.age++;
}

function tickPad(w: World, d: Data) {
  const pd = d.pad;
  if (!pd) return;
  const moveBody = () => {
    const b = w.bodies.find((q) => q.id === pd.id);
    if (b) { const [x, z] = tileWorld(pd.px, pd.pz); b.x = x; b.z = z; b.y = pd.st >= 3 ? 0 : 0; b.vx = pd.st === 1 || pd.st === 2 ? Math.min(1, pd.age / 16) : 1; }
  };
  switch (pd.st) {
    case 0: // hidden, waiting to appear (FUN_800c0584 case 0)
      if (--pd.tm > 0) break;
      for (let k = 0; k < 10; k++) {
        const x = ri(w, 8), z = ri(w, 8);
        if (freeSpawn(d, x, z)) {
          pd.rx = x; pd.rz = z; pd.px = x; pd.pz = z; pd.st = 1; pd.tm = 10; pd.age = 0;
          const [wx, wz] = tileWorld(x, z);
          const b = newBody(w, 'padlock', wx, wz); pd.id = b.id; b.vx = 0;
          sfx(w, 0x3fa, x, z);
          emit(w, 'spawn', wx, wz, -1, 1);
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
        ok = inb(x, z) && !hasObj(d, x, z) && !occupant(d, x, z) && !d.rsv[tidx(x, z)];
      }
      if (!ok) { pd.st = 3; pd.tm = 5; break; }
      pd.tx = x; pd.tz = z; pd.st = 5; pd.hop = 18;
      break;
    }
    case 5: // glide: closes 1/6 of the distance per frame, snaps after 18
      pd.px += (pd.tx - pd.px) / 6; pd.pz += (pd.tz - pd.pz) / 6;
      if (--pd.hop < 1) { pd.px = pd.tx; pd.pz = pd.tz; pd.st = 3; pd.tm = PAD_WAIT[pd.stage]; }
      break;
    case 6: // collected: hide, come back after 120 frames
      w.bodies = w.bodies.filter((b) => b.id !== pd.id);
      pd.st = 0; pd.tm = 120;
      return;
  }
  if (pd.st > 0) moveBody();
}

/** ring cells of the rim around the board (tile coords -1..8), clockwise from the top-left */
const RIM: [number, number][] = (() => {
  const r: [number, number][] = [];
  for (let x = -1; x <= 8; x++) r.push([x, 8]);
  for (let z = 7; z >= -1; z--) r.push([8, z]);
  for (let x = 7; x >= -1; x--) r.push([x, -1]);
  for (let z = 0; z <= 7; z++) r.push([-1, z]);
  return r;
})();

function monSetHop(m: Mon, ax: number, az: number) { m.sx = m.x; m.sz = m.z; m.ax = ax; m.az = az; }
function tickMonster(w: World, d: Data) {
  const m = d.mon;
  if (!m) return;
  // body follows the hop: 2 stand frames, 10 glide frames, 2 stand frames (FUN_800c0cf4 wraps every 14 frames)
  const glide = m.cyc >= 2 && m.cyc <= 11 ? (m.cyc - 1) / 10 : m.cyc > 11 ? 1 : 0;
  m.x = m.sx + (m.ax - m.sx) * glide; m.z = m.sz + (m.az - m.sz) * glide;
  const b = w.bodies.find((q) => q.id === m.id);
  const place = () => { if (b) { const [x, z] = tileWorld(m.x, m.z); b.x = x; b.z = z; b.face = Math.atan2(DX[m.dir & 3] ?? 0, 0); b.vx = m.st; b.cd = m.walking; b.dash = m.head; } };
  if (m.st === 1) { if (--m.tm <= 0) { m.st = 2; m.tm = 100 + ri(w, 60); m.dir = w.tick & 1 ? 1 : 3; } place(); return; }
  if (m.st === 5) { // spin attack: fires every 20 frames while turning
    m.head += 22 / 4096 * Math.PI * 2; m.tm--;
    if (m.tm % 20 === 0) {
      const dir = ((Math.round(m.head / (Math.PI / 2)) % 4) + 4) % 4;
      const p0 = [3, 1, 2, 0]; // heading step -> dir code
      const dd = p0[dir];
      const mx = Math.max(0, Math.min(7, rnd(m.x))), mz = Math.max(0, Math.min(7, rnd(m.z)));
      const [x, z] = tileWorld(mx, mz);
      const bb = addBody(w, 'missile', 5, x, z, 0.3, 0.2);
      bb.y = 0.8; bb.cd = 1; bb.face = Math.atan2(DX[dd], -DZ[dd]);
      d.proj.push({ id: bb.id, own: 5, kind: 1, x: mx, z: mz, dir: dd, hd: dd, fl: 0 });
      sfx(w, 0x522, mx, mz);
    }
    if (m.tm <= 0) { m.st = 4; m.hops = 100; }
    place();
    return;
  }
  if (m.st === 2) m.tm--; // patrol timer runs per frame, checked on hop-wrap frames
  m.cyc++;
  if (m.cyc <= 13) { place(); return; }
  m.cyc = 0; // decision frame
  const bx = rnd(m.x), bz = rnd(m.z);
  if (m.st === 2) {
    if (m.tm > 0) { // patrol the rim, 2 cells per hop
      const idx = RIM.findIndex((c) => c[0] === bx && c[1] === bz);
      const k = idx < 0 ? 0 : idx;
      const n = RIM[(k + (m.dir === 1 ? -2 : 2) + RIM.length) % RIM.length];
      monSetHop(m, n[0], n[1]);
    } else {
      const idx = m.idx++ % (MON_ACTIONS.length + 1);
      const a = idx >= MON_ACTIONS.length ? 6 : MON_ACTIONS[idx];
      m.act = a; m.hops = 0; m.bf4 = a === 6 ? 50 : ri(w, 3) + 1;
      m.st = a === 8 ? 4 : 3;
      m.dir = bx >= 8 ? 1 : bx <= -1 ? 3 : bz >= 8 ? 0 : 2; // inward: 0 -z, 1 -x, 2 +z, 3 +x (monster dir codes)
      if (a === 8) m.bf4 = ri(w, 3) + 1;
      monNext(w, d, m, bx, bz);
      sfx(w, w.tick & 1 ? 0x542 : 0x543, bx, bz);
    }
  } else if (m.st === 3 || m.st === 4) {
    // landing tile: mine (state 5, 120 frames) or, once, the cross tile (state 7)
    if (inb(bx, bz) && m.hops < 100) {
      const i = tidx(bx, bz);
      if (m.st === 3) {
        if (m.hops === m.bf4) { d.tiles[i] = 5; d.st[i] = 7; d.tm[i] = 0; d.cap[i] = 0; emit(w, 'mine', ...tileWorld(bx, bz), -1, 2); }
        else { d.tiles[i] = 5; d.st[i] = 5; d.tm[i] = MINE_FRAMES; d.cap[i] = 0; emit(w, 'mine', ...tileWorld(bx, bz), -1, 1); }
      } else if (m.hops === m.bf4) { m.st = 5; m.tm = 140; m.head = 0; m.hops = 100; place(); return; }
      m.hops++;
    }
    monNext(w, d, m, bx, bz);
  }
  place();
}
/** FUN_800bfc6c: next hop = 2 tiles ahead and 0/+-1 sideways; leaving the board ends the action */
function monNext(w: World, d: Data, m: Mon, bx: number, bz: number) {
  const fx = m.dir === 1 ? -1 : m.dir === 3 ? 1 : 0, fz = m.dir === 0 ? -1 : m.dir === 2 ? 1 : 0;
  for (let t = 0; t < 5; t++) {
    const lat = ri(w, 3) - 1;
    const x = bx + fx * 2 + (fz ? lat : 0), z = bz + fz * 2 + (fx ? lat : 0);
    if (inb(x, z) && !hasObj(d, x, z)) { monSetHop(m, x, z); return; }
    if ((fx < 0 && bx <= 1) || (fx > 0 && bx >= 6) || (fz < 0 && bz <= 1) || (fz > 0 && bz >= 6)) break;
  }
  // done: walk off the far side and start patrolling the rim again
  const ex = Math.max(-1, Math.min(8, bx + fx * 2)), ez = Math.max(-1, Math.min(8, bz + fz * 2));
  monSetHop(m, ex, ez);
  m.st = 2; m.tm = 100 + ri(w, 80); m.dir = (w.tick & 1) ? 1 : 3;
}

function tickBorder(w: World, d: Data) {
  if (d.lvl !== 11) return;
  const rem = TP_FRAMES / 30 - Math.ceil(w.tick / 30); // seconds left on the clock
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
  if (--d.bsteps < 1) d.btype = 0; else d.bwait = 8;
}

// ------------------------------------------------------------------ the game
export const tilePainter: MiniGame = {
  id: 'tilePainter',
  name: 'Pogo Painter',
  description: 'Hop around the arena on a pogo stick, painting squares your colour. Cash them in at the special crates. Highest score in 90 seconds wins.',
  controls: 'Move: hop to the next square. Space / Shift: fire your item.',
  variants: TP_VARIANTS,
  maxTime: TP_FRAMES / 30,

  setup(w, slots) {
    const variant = pickVariant(w, TP_VARIANTS);
    const lvl = TP_LEVEL[variant];
    const forced = Number(w.data?.aiLevel);
    const z4 = () => [0, 0, 0, 0];
    const d: Data = {
      variant, lvl, ai: Number.isFinite(forced) ? Math.max(0, Math.min(2, forced)) : 1,
      tiles: new Array(64).fill(-1), st: new Array(64).fill(1), tm: new Array(64).fill(0), prev: new Array(64).fill(-1),
      fl: new Array(64).fill(0), rsv: new Array(64).fill(0), cap: new Array(64).fill(0),
      score: z4(), item: z4(), itemT: z4(), itemAge: z4(), stun: z4(), hd: START_HD.slice(), cnt: [-1, -1, -1, -1],
      fam: Array.isArray(w.data?.fam) ? w.data.fam.slice(0, 4) : [1, 5, 6, 8],
      fx: START_RX.slice(), fz: START_RZ.slice(), tx: START_RX.slice(), tz: START_RZ.slice(), px: START_RX.slice(), pz: START_RZ.slice(),
      on: [false, false, false, false], prevFire: [false, false, false, false], taz: z4(), wx: z4(), wz: z4(),
      crates: [], cash: [], pad: null, mon: null, proj: [], beams: [],
      arT: 24, arN: 0, itT: 28, itN: 0,
      border: 0, bdir: 1, bsteps: 0, bwait: 0, btype: 0, bwarn: 0, over: false,
    };
    const forcedFamilies = Array.isArray(w.data?.fam);
    w.data = d;
    for (const s of slots) {
      const b = addBody(w, 'player', s.slot, 0, 0, 0.6, 3);
      d.on[s.slot] = true;
      const rx = START_RX[s.slot], rz = START_RZ[s.slot];
      d.tiles[tidx(rx, rz)] = s.slot;
      const [x, z] = tileWorld(rx, rz);
      b.x = x; b.z = z; b.face = Math.atan2(DX[d.hd[s.slot]], -DZ[d.hd[s.slot]]);
      d.wx[s.slot] = rx; d.wz[s.slot] = rz;
    }
    const nCash = lvl === 10 ? 2 : lvl === 12 ? 3 : lvl === 13 ? 2 : 0;
    for (let k = 0; k < nCash; k++) d.cash.push({ st: 0, tm: 48, rx: 0, rz: 0, age: 0, id: -1 });
    if (lvl === 12) {
      const [x, z] = tileWorld(3, 8);
      const b = addBody(w, 'monster', -1, x, z, 1, 5);
      d.mon = { st: 1, tm: 22, cyc: 0, x: 3, z: 8, sx: 3, sz: 8, ax: 3, az: 8, dir: 1, act: 0, idx: 0, hops: 0, bf4: 0, spin: 0, head: 0, id: b.id, walking: 0, lat: 0 };
    }
    if (lvl === 13) d.pad = { st: 0, tm: 100, rx: 4, rz: 4, age: 0, stage: 0, left: PAD_HOPS[0], hop: 0, tx: 4, tz: 4, px: 4, pz: 4, id: -1 };
  },

  step(w, inputs) {
    const d = w.data as Data;
    if (d.over) return;
    const f = w.tick; // frames elapsed (World.tick is incremented by the host after step)
    void f;
    // tile timers (state 0 flips in, 3 cash flip, 5 mine, 10 lock)
    for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
      const i = tidx(rx, rz);
      if (d.tm[i] > 0) {
        d.tm[i]--;
        if (d.tm[i] <= 0) {
          if (d.st[i] === 0) d.st[i] = 1;
          else if (d.st[i] === 3) { d.st[i] = 1; d.tiles[i] = -1; }
          else if (d.st[i] === 5) boom(w, d, rx, rz);
          else if (d.st[i] === 10) { d.st[i] = 1; d.cap[i] = 0; }
        }
      }
      if (d.fl[i] & 0x10 && !occupant(d, rx, rz)) d.fl[i] &= ~0x10; // stepped flag clears once the tile is empty
    }
    tickSpawners(w, d);
    tickPad(w, d);
    tickMonster(w, d);
    tickBorder(w, d);

    for (const p of players(w)) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      const dir = padDirOf(inp);
      const fireNow = (inp.a || inp.b) && !d.prevFire[s];
      d.prevFire[s] = inp.a || inp.b;
      // item timers
      if (d.item[s] === 5 || d.item[s] === 6) { if (--d.itemT[s] <= 0) clearItem(w, d, s); }
      if (d.item[s] > 0) d.itemAge[s]++;
      if (d.stun[s] > 0) {
        d.stun[s]++;
        if (d.stun[s] > STUN_FRAMES) d.stun[s] = 0;
        // ease towards the tile centre (FUN_800bc0ec)
        d.px[s] += (d.fx[s] - d.px[s]) / 4; d.pz[s] += (d.fz[s] - d.pz[s]) / 4;
      } else if (d.taz[s] > 0) {
        d.taz[s]--;
      } else {
        if (fireNow && d.item[s] > 0) fire(w, d, s, dir);
        if (d.taz[s] === 0) {
          if (d.cnt[s] < 0) decide(w, d, s, dir);
          else {
            d.cnt[s] += (d.item[s] === 5 ? 2 : 1) * w.params.speed;
            if (d.cnt[s] >= HOP_END) land(w, d, s);
            else hopPos(d, s);
          }
        }
      }
      if (d.cnt[s] < 0 && d.stun[s] === 0 && d.taz[s] === 0) { d.px[s] = d.fx[s]; d.pz[s] = d.fz[s]; }
      // body
      const [x, z] = tileWorld(d.px[s], d.pz[s]);
      const moving = d.cnt[s] >= FAM_S[d.fam[s]] && d.cnt[s] < HOP_END;
      p.x = x; p.z = z;
      const prog = d.cnt[s] < 0 ? 0 : Math.max(0, Math.min(1, (d.cnt[s] - FAM_S[d.fam[s]]) / FAM_M[d.fam[s]]));
      p.y = moving ? 1.0 * 4 * prog * (1 - prog) : 0;
      p.face = Math.atan2(DX[d.hd[s]], -DZ[d.hd[s]]);
    }
    stepProj(w, d);
    // crates / pickups keep their body positions; flag cooldown field for the view (grow animation)
    for (const b of w.bodies) {
      if (b.kind === 'power' || b.kind === 'arrow') { const c = d.crates.find((q) => q.id === b.id); if (c) { b.dash = c.age; if (b.kind === 'arrow') b.cd = Math.floor(1 + (c.age - 17) / 32) & 3; } }
      else if (b.kind === 'crate') { const c = d.cash.find((q) => q.id === b.id); if (c) b.dash = c.age; }
    }
    if (w.tick + 1 >= TP_FRAMES) d.over = true;
  },

  isOver(w) {
    return (w.data as Data).over || w.time >= tilePainter.maxTime;
  },

  placements(w) {
    const d = w.data as Data;
    const c = tileCounts(d);
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || c[b] - c[a] || a - b);
  },

  /** The game's CPU (FUN_800bd10c): nearest better pickup, else a random wander target; fires after a reaction delay. */
  bot(w, slot): InputState {
    const d = w.data as Data;
    if (!d.on[slot] || d.stun[slot] > 0 || d.taz[slot] > 0) return IDLE;
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    const rx = d.fx[slot], rz = d.fz[slot];
    const delay = 96 - 3 * AI_IDX[d.lvl - 10][d.ai];
    // ---- fire (FUN_800bd378 / bd520): an enemy on my line, after the reaction delay
    const it = d.item[slot];
    if (it >= 1 && it <= 4 && d.itemAge[slot] >= delay) {
      for (let s = 0; s < MAX_SEATS; s++) {
        if (s === slot || !d.on[s]) continue;
        const ox = rnd(d.px[s]), oz = rnd(d.pz[s]), h = d.hd[slot];
        const ahead = (h === 0 && oz === rz && ox > rx) || (h === 1 && oz === rz && ox < rx) || (h === 2 && ox === rx && oz > rz) || (h === 3 && ox === rx && oz < rz);
        if (it === 2 ? (ox === rx || oz === rz) : ahead) { out.a = true; break; }
      }
    }
    // ---- target (FUN_800bdf60): nearest pickup that beats what I hold, or a special tile / padlock
    let best = -1, bx = -1, bz = -1;
    const consider = (x: number, z: number) => {
      if (x === rx && z === rz) return;
      const dd = (x - rx) ** 2 + (z - rz) ** 2;
      if (best < 0 || dd < best) { best = dd; bx = x; bz = z; }
    };
    const dly = (age: number) => age >= 17 + delay;
    for (const c of d.crates) if (d.item[slot] < c.t && dly(c.age) && !occupant(d, c.rx, c.rz, slot) && (!d.rsv[tidx(c.rx, c.rz)] || d.rsv[tidx(c.rx, c.rz)] === slot + 1)) consider(c.rx, c.rz);
    for (const c of d.cash) if (c.st === 3 && d.item[slot] < 10 && dly(c.age) && !occupant(d, c.rx, c.rz, slot)) consider(c.rx, c.rz);
    if (d.pad && d.pad.st >= 3 && d.pad.st !== 6) consider(rnd(d.pad.px), rnd(d.pad.pz));
    if (d.lvl === 12) for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) if (d.st[tidx(x, z)] === 7 && !occupant(d, x, z)) consider(x, z);
    if (best < 0 && (d.lvl === 11 || d.lvl === 12)) {
      // enclosing strategy (approximation of FUN_800be864): a free tile that touches two of my tiles closes a loop
      let mine = 0;
      for (let i = 0; i < 64; i++) if (d.tiles[i] === slot) mine++;
      if (mine >= 3) for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) {
        const i = tidx(x, z);
        if (d.tiles[i] === slot || d.st[i] === 5 || d.st[i] === 7 || occupant(d, x, z, slot)) continue;
        let n = 0;
        for (let k = 0; k < 4; k++) { const nx = x + DX[k], nz = z + DZ[k]; if (inb(nx, nz) ? d.tiles[tidx(nx, nz)] === slot : false) n++; }
        if (n >= 2) consider(x, z);
      }
    }
    if (best < 0) {
      if ((rx === d.wx[slot] && rz === d.wz[slot])) { /* new wander target is chosen by the sim step */ }
      bx = d.wx[slot]; bz = d.wz[slot];
    }
    // ---- steer: smallest distance after the step, first of (+z, -z, +x, -x) wins ties (FUN_800bd790)
    const order = [2, 3, 0, 1];
    let bestD = Infinity, bestK = -1;
    for (const pass of [true, false]) {
      for (const k of order) {
        const nx = rx + DX[k], nz = rz + DZ[k];
        if (!canMove(d, slot, nx, nz, true, pass)) continue;
        const dd = (nx - bx) ** 2 + (nz - bz) ** 2;
        if (dd < bestD) { bestD = dd; bestK = k; }
      }
      if (bestK >= 0) break;
    }
    if (bestK >= 0 && !(bx === rx && bz === rz)) { out.x = bestK === 0 ? 1 : bestK === 1 ? -1 : 0; out.y = bestK === 3 ? 1 : bestK === 2 ? -1 : 0; }
    return out;
  },
};

/** The sim keeps AI wander targets fresh for every slot (deterministic, uses world.rng). */
const origStep = tilePainter.step;
tilePainter.step = (w, inputs, dt) => {
  const d = w.data as Data;
  if (!d.over) {
    for (let s = 0; s < MAX_SEATS; s++) {
      if (!d.on[s]) continue;
      if (d.fx[s] === d.wx[s] && d.fz[s] === d.wz[s]) { d.wx[s] = ri(w, 8); d.wz[s] = ri(w, 8); }
    }
  }
  origStep(w, inputs, dt);
};
