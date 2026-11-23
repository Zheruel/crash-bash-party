/**
 * CRATE CRUSH (game id 'crateToss') - rules decoded from the real game (overlay 0728.t5d, see re/notes/crateCrush.md).
 *
 * Logic runs at 30 Hz, one step() = one tick. Distances below are written in the game's raw units (arena = +-2048 raw = +-CT_HALF
 * world units, so U world units per raw unit) and per-tick speeds; the real code adds them to the position every tick.
 *
 * Controls (Circle / Square / Cross / Triangle):
 *   A (Circle)  pick up the crate in front of you / throw the crate you hold
 *   B           Square: a spin attack that kicks crates away and hits players for 1 HP; C (Cross) jumps independently
 * Crates: wood (5 HP, 3 HP in DRAIN BASH), TNT (8 HP, 90 tick fuse), nitro (8 HP, explodes when touched / kicked / landed on).
 *   Every crate that breaks or blows up hurts all players within 640 raw (2.25 units) except the player who threw / kicked it.
 * Pickups: fruit (+1 HP, up to 20). SPACE / SNOW: Aku Aku mask (blocks one hit, 10 s), speedy boots (8 s), the weight (hot
 *   potato: pass it on by bumping a rival or you are out when its 8 s run out), slow motion (8 s, you act at half rate).
 *   DRAIN: purple "?" crates hold a weapon (homing orb x3 / eight-way missile x2 / sonic ring x1) or fruit.
 *
 * world.data:
 *   variant: 'jungle' | 'space' | 'snow' | 'drain'
 *   hp:      number[4]  health 0..CT_HP (<= 0 = out)
 *   score:   number[4]  hits landed; taken: number[4] hits suffered; elim: number[4] tick the player went out (-1 alive)
 *   stun:    number[4]  seconds of hurt state left (view: 'hit' pose); act: number[4] 0 none / 1 pick / 2 throw / 3 spin / 4 hurt
 *   boots / slow / mask: number[4] seconds left; weight: slot carrying the weight (-1); weightT: its ticks left
 *   floor:   number[]   [space only] CT_FLOOR_N*CT_FLOOR_N flags, 1 = tile present, 0 = hole (row-major z*N+x)
 *   weapon / ammo: number[4] (drain), penguin: ticks awake (snow)
 *   cs: crate sub state (internal), plus internal counters
 *
 * Bodies:
 *   'player'  alive=false once out; y = height above the floor
 *   'crate' | 'tnt' | 'nitro' | 'chest': cd = holder slot + 1 (0 = on floor), dash = 1 thrown / 2 sliding after a kick / 0 resting,
 *       y = height of the crate base. tnt: fall = true once lit, m = seconds of fuse left. m also = spawn scale for 8 ticks of growing.
 *   'fruit' | 'boots' | 'potion' | 'mask' | 'weight' | 'weapon': pickups (weapon = the weapon item that pops out of a chest)
 *   'orb' | 'rocket' | 'ring': drain weapon shots; 'penguin': snow bash
 * Events: grab, throw, kick (spin), hit (s victim, o attacker, v = dmg / CT_HP), smash (wood broke), land, explode (v radius, s=kind 0 tnt 1 nitro),
 *   lit, pickup (v 1 fruit 2 boots 3 slow 4 mask 5 weight 6.. weapons), ko, weapon, weaponHit, penguinWake / penguinHit, hole, jump, beep
 */
import { attackHull, onFootItemMarker, TAUNT_TICKS } from './onFoot';
import { CRATE_GRIPS, CT_HULL } from './crateGripData';
import { DISC_CHARACTER } from '../look';
import { addBody, discRandomState, drawDiscRandom, emit, rand } from '../physics';
import { atan2g } from '../ps1Angle';
import { ps1SqrtQ6 } from '../ps1Sqrt';
import { IDLE, type Body, type GameEvent, type InputState, type MiniGame, type World } from '../types';
import { angDiff, pickVariant } from './common';

export const CT_HALF = 7.2;
export const CT_HP = 20;
export const CT_OPENING_TICKS = 99;
// Script 5's cycle length and its two foot-contact events from the USA character VM.
const STRIDE = [[22, 9, 20], [22, 8, 19], [22, 1, 12], [22, 1, 12],
  [20, 1, 11], [20, 1, 11], [18, 4, 13], [20, 1, 11]];
const CARRY_STEPS = [[7, 19], [9, 20], [0, 12], [0, 12], [0, 10], [0, 10], [0, 12], [0, 10]];
const LAND_TICKS = [27, 11, 6, 4, 11, 9, 15, 7];
interface GroundPose { script: number; frame: number; scrape?: number }
const openingGroundPose = (): GroundPose => ({ script: 1, frame: CT_OPENING_TICKS });
export const CT_FLOOR_N = 8; // space bash floor grid (tiles of 512 raw)
/** world units per raw unit */
export const CT_U = CT_HALF / 2048;
const U = CT_U;
const TAU = Math.PI * 2;

// ---------- constants decoded from the game (raw units, per tick) ----------
// Movement rows 0x8009d318 / 0x8009d354. Characters 5..8 have a lower jump and carry faster.
const WALK = 45, BOOT_BONUS = 20, ICE_ACC = 8, ICE_DEC = 4;
const JUMP_CUT = 40, JUMP_FALL_MAX = 112;
const PLAYER_R = 153, CRATE_R = 120, ARENA = 2048;
const SPACE_KO_DEPTH = 0x180, SPACE_OBJECT_CULL = ARENA;
const CRATE_H = 256, PLAYER_H = 700;
const PICK_REACH = 256, PICK_CONE = 0x280 / 4096 * TAU;     // FUN_800c1848: crate within 256 raw of the point 256 raw in front, +-56 deg
// Per-character script lengths (pickup 0xf, throw 0x12, attack 0xa) and frame of throw event 0x13.
const ACTIONS = [
  [11, 15, 16, 8], [12, 16, 16, 8], [8, 13, 19, 2], [13, 13, 13, 2],
  [9, 17, 12, 5], [11, 20, 16, 5], [16, 28, 14, 8], [16, 26, 14, 6],
];
export function ctActionTicks(char: number, action: number) {
  return (ACTIONS[char - 1] ?? ACTIONS[0])[action - 1];
}
const throwVoiceFrame = (char: number) => char === 5 ? 1 : ACTIONS[char - 1][3];
const SPIN_R = 330, SPIN_DMG = 1, SPIN_KNOCK = 48;
// Throw table 0x8009e3b4: initial and maximum forward speed, drag, rise speed, vertical acceleration.
const THROWS = [
  [113, 128, 6, 32, 9], [128, 128, 5, 40, 9], [144, 144, 5, 18, 8], [144, 144, 5, 18, 8],
  [144, 128, 5, 0, 6], [144, 128, 5, 0, 6], [112, 128, 5, 0, 7], [128, 128, 5, 0, 7],
];
const longKick = (char: number) => char <= 2 || char >= 7;
const BLAST_R = 640, CHAIN_DELAY = 10, FUSE = 90, GROW = 8;
const DMG_WOOD = 5, DMG_WOOD_DRAIN = 3, DMG_BIG = 8;                                      // damage table 0x8009d3b8, row 5 / 3 / 8
const HURT_TICKS = 30, FLICKER_TICKS = 40;
// Hurt script 9 per engine character: its length, the frame of event 8 (lethal switch to script 0x13) and the
// frame whose event plays the impact voice (FUN_800bff1c: event 9 for Cortex and Brio, event 8 for the others).
const HURT_LEN = [30, 30, 30, 30, 30, 29, 30, 34];
const HURT_EV8 = [11, 14, 19, 15, 19, 19, 11, 10];
const HURT_VOICE = [11, 14, 13, 13, 19, 19, 11, 10];
// FUN_800c0bac: the weight drops 4096 raw at 256 per update, then FUN_800c0de4 starts the spirit 28 updates later.
export const CT_WEIGHT_DROP = 16, CT_WEIGHT_OUT = 44;
export const ctHurtTicks = (char: number) => HURT_LEN[char - 1] ?? HURT_TICKS;
export const ctHurtKnockout = (char: number) => HURT_EV8[char - 1] ?? 11;
const BOOTS_T = 240, MASK_T = 300, WEIGHT_T = 240, SLOW_T = 240, PASS_LOCK = 30;
const FRUIT_LIFE = 150, POWER_LIFE = 120;
// FUN_8008d6c8: launch at 64 raw units, gravity 8, relaunch at floor contact.
export function ctFruitRise(ticksFromSpawn: number) {
  const age = Math.max(0, ticksFromSpawn) % 15;
  return 4 * age * (15 - age) * U;
}
const AIM = 0x110 / 4096 * TAU;                                                           // facing re-snaps when the stick is > 24 deg off

const KIND_DMG = (variant: string, kind: string) => (kind === 'crate' ? (variant === 'drain' ? DMG_WOOD_DRAIN : DMG_WOOD) : DMG_BIG);

export const CT_VARIANTS = [
  { id: 'jungle', name: 'JUNGLE BASH' },
  { id: 'space', name: 'SPACE BASH' },
  { id: 'snow', name: 'SNOW BASH' },
  { id: 'drain', name: 'DRAIN BASH' },
];

/** Per level: crates to start with (FUN_800b710c arg 1), floor caps by player count 2/3/4, deck counts [wood, tnt, nitro] x4, nitro cap by player count. */
interface Cfg { start: number; cap: [number, number, number]; deck: [number, number, number]; nitroCap: [number, number, number]; spawnWood: 3 | 4 }
const CFG: Record<string, Cfg> = {
  jungle: { start: 8, cap: [12, 10, 8], deck: [10, 3, 3], nitroCap: [3, 2, 2], spawnWood: 4 },
  space: { start: 10, cap: [14, 12, 10], deck: [10, 4, 2], nitroCap: [2, 2, 2], spawnWood: 4 },
  snow: { start: 8, cap: [12, 10, 8], deck: [10, 3, 3], nitroCap: [3, 2, 2], spawnWood: 4 },
  drain: { start: 6, cap: [6, 6, 6], deck: [14, 2, 0], nitroCap: [1, 1, 1], spawnWood: 3 },
};
const SPAWN: [number, number][] = [[-1600, 1600], [-1600, -1600], [1600, -1600], [1600, 1600]]; // P1 bottom-left (camera side), P2 top-left, P3 top-right, P4 bottom-right

const ST_MOVE = 0, ST_PICK = 1, ST_THROW = 2, ST_SPIN = 3, ST_HURT = 4;
const EFF_AKU = 0x12, EFF_BOOTS = 0x13, EFF_WEIGHT = 0x14, EFF_SLOW = 0x15;
const W_MISSILE = 0x19, W_ORB = 0x1b, W_RING = 0x1c;
const DRAIN_WEAPONS = [25, 27, 28, 25, 28, 27, 28, 25, 27, 28, 27, 25, 27, 28, 25, 27, 25, 28]; // 0x800c46c0

/** crate sub state */
const C_GROW = 0, C_IDLE = 1, C_HELD = 2, C_THROWN = 3, C_SLIDE = 4, C_DELAY = 5, C_FALL = 7, C_DROP = 8;
export const CT_CHEST_REVEAL = 6, CT_CHEST_SHRINK = 9;
interface CS { kc?: number; homing?: boolean; touchable?: boolean; fruitFrame?: number; releasedAt?: number; gripScript?: number; gripFrame?: number; walking?: boolean; pitch?: number; s: number; t: number; hv: number; vv: number; up: boolean; dx: number; dz: number; own: number; fuse: number; kt: number; item: number }

interface Data {
  char: number[];
  cpu?: CrushBot[];
  /** Skill and target weight per slot (0x8009d87c rows) and the CPU's FUN_80015590 state */
  cpuSkill?: number[]; cpuWeight?: number[]; cpuRandom?: [number, number];
  humanSlots?: number;
  cpuOnly?: boolean;
  cpuFocus?: number;
  variant: string;
  hp: number[]; score: number[]; taken: number[]; elim: number[];
  stun: number[]; tauntAt?: number[]; act: number[]; st: number[]; stT: number[]; inv: number[]; ic: number[];
  boots: number[]; slow: number[]; mask: number[];
  eff: number[]; effT: number[]; pass: number[];
  weight: number; weightT: number;
  f8: number[]; vx: number[]; vz: number[]; vy: number[]; air: boolean[]; jh: boolean[]; prevA: boolean[]; prevB: boolean[];
  groundPose?: GroundPose[];
  jumpFrame?: number[]; landedAt?: number[];
  iceTargets?: { x: number; z: number }[];
  /** Cross (jump) held last tick */
  prevC?: boolean[];
  pend: { dmg: number; cls: number; by: number; kx: number; kz: number; kv: number; snd?: number }[];
  weapon: number[]; ammo: number[]; wcd: number[];
  shots?: Record<number, DrainShot>;
  floor: number[];
  drainWeaponIndex?: number;
  openingSpawns?: Record<number, number>;
  /** 1 while the penguin runs (native state 3) */
  penguin: number;
  cs: Record<number, CS>;
  cells: number[]; cur: number; deck: number[]; di: number;
  tSpawn: number; tFruit: number; tBurst: number; tBurstGap: number; tBurstN: number; tPower: number; tChest: number;
  lastBy: number[]; lastByTick: number[];
  /** FUN_80083e8c pad lock 0x8009d574 (30 updates after a hit), flickering starts when it expires */
  lock?: number[];
  /** health reached zero: the knockout follows hurt event 8, credited to this slot (-1 none, -2 not dying) */
  dying?: number[];
  /** cause of the knockout per slot: 1 = the weight went off (state 0x12) */
  outBy?: number[];
  /** Snow penguin (objects 0x1102): native state, animation entry and frame, run timer and orbit angle */
  peng?: CtPenguin;
}

/** FUN_800b879c state 1 sleeps (entry 0, or entry 2 on the way back), 2 wakes (entry 1), 3 runs. */
export interface CtPenguin { s: number; e: number; f: number; t: number; a: number; hit?: boolean }
/** Penguin script 0x800c3654: wake event 8 after 73 updates, sleep loop 60, return 54; sounds per entry frame. */
export const CT_PENGUIN_WAKE = 73, CT_PENGUIN_LOOP = 60, CT_PENGUIN_RETURN = 54;
// Marker 0x50 of mesh 0x2001 (copied at init) and marker 0x400 of the running mesh 0x2002 in 0798.t29.
const PENGUIN_BODY = 212, PENGUIN_REACH = 384, PENGUIN_H = 622;

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const CRATE_KINDS = ['crate', 'tnt', 'nitro', 'chest'];
const isCrate = (b: Body) => CRATE_KINDS.includes(b.kind);
const crates = (w: World) => w.bodies.filter((b) => isCrate(b) && b.alive);
const PICKUPS = ['fruit', 'boots', 'potion', 'mask', 'weight', 'weapon'];
const isPickup = (b: Body) => PICKUPS.includes(b.kind);
const D = (w: World) => w.data as Data;
const aliveCount = (w: World) => players(w).filter((p) => p.alive).length;
const holdingCrate = (w: World, slot: number) => crates(w).find((c) => c.cd === slot + 1);
const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/** FUN_800bac5c indexes 512-unit cells in game coordinates. World Z mirrors game Z. */
export function spaceFloorIndex(x: number, z: number): number {
  const column = Math.floor((x / U + 2048) / 512);
  const row = CT_FLOOR_N - 1 - Math.floor((-z / U + 2048) / 512);
  if (column < 0 || column >= CT_FLOOR_N || row < 0 || row >= CT_FLOOR_N) return -1;
  return row * CT_FLOOR_N + column;
}

export function floorAt(d: { floor?: number[] }, x: number, z: number): boolean {
  if (!d.floor?.length) return true;
  const i = spaceFloorIndex(x, z);
  return i < 0 || d.floor[i] === 1;
}

// ---------- cell grid + spawn deck (FUN_800b7e74 / 800b710c / 800b8040 / 800b7d20) ----------
function buildCells(w: World, variant: string): number[] {
  const cells: number[] = [];
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
    if (variant === 'drain') { // the outer two rings map to random inner cells
      const ii = i >= 2 && i <= 13 ? i : 2 + Math.floor(rand(w) * 12), jj = j >= 2 && j <= 13 ? j : 2 + Math.floor(rand(w) * 12);
      cells.push(ii, jj);
    } else cells.push(i, j);
  }
  for (let k = 0; k < 600; k++) { // 600 random swaps
    const a = Math.floor(rand(w) * 256), b = Math.floor(rand(w) * 256);
    const x = cells[a * 2], z = cells[a * 2 + 1];
    cells[a * 2] = cells[b * 2]; cells[a * 2 + 1] = cells[b * 2 + 1]; cells[b * 2] = x; cells[b * 2 + 1] = z;
  }
  return cells;
}
const cellRaw = (i: number) => -0x780 + 0x100 * i;
const cellOf = (x: number) => Math.floor(x / U / 256 + 10 + 1e-9) ; // grid column of a world x (0..19)
function occupiedAt(w: World, ci: number, cj: number): boolean {
  // FUN_800bad70 reserves the four 256-unit spawn cells beneath each missing tile.
  if (!floorAt(D(w), cellRaw(ci - 2) * U, -cellRaw(cj - 2) * U)) return true;
  for (const b of w.bodies) {
    if (b.kind === 'player') {
      // FUN_80086d88 marks the 3x3 cells around every player, eliminated ones included, when its own cell is on the grid.
      const pi = Math.floor(b.x / U / 256) + 10, pj = 9 - Math.floor(b.z / U / 256);
      if (pi >= 0 && pi < 20 && pj >= 0 && pj < 20 && Math.abs(ci - pi) <= 1 && Math.abs(cj - pj) <= 1) return true;
      continue;
    }
    if (!b.alive || !(isCrate(b) || isPickup(b) || b.kind === 'penguin')) continue;
    if (Math.floor(b.x / U / 256) + 10 === ci && 9 - Math.floor(b.z / U / 256) === cj) return true;
  }
  return false;
}
function neighbours(w: World, ci: number, cj: number): number {
  let n = 0;
  for (let a = Math.max(0, ci - 1); a <= Math.min(19, ci + 1); a++) for (let b = Math.max(0, cj - 1); b <= Math.min(19, cj + 1); b++) if ((a !== ci || b !== cj) && occupiedAt(w, a, b)) n++;
  return n;
}
/** next free cell: a free one with no crowded neighbours, else the least crowded of nine tries */
function freeCell(w: World, d: Data): [number, number] | null {
  let idx = d.cur, best = -1, bestN = 9, tries = 9;
  for (let guard = 0; guard < 256; guard++) {
    idx = (idx + 1) & 255;
    const x = cellRaw(d.cells[idx * 2]), z = cellRaw(d.cells[idx * 2 + 1]);
    const gi = Math.floor(x / 256) + 10, gj = 9 - Math.floor(z / 256);
    if (occupiedAt(w, gi, gj)) continue;
    const n = neighbours(w, gi, gj);
    if (n === 0) { d.cur = idx; return [x, z]; }
    if (n < bestN) { bestN = n; best = idx; }
    if (--tries < 0) break;
  }
  if (best < 0) return null;
  d.cur = best;
  return [cellRaw(d.cells[best * 2]), cellRaw(d.cells[best * 2 + 1])];
}

function newCS(s: number): CS { return { s, t: 0, hv: 0, vv: 0, up: false, dx: 0, dz: 0, own: -1, fuse: 0, kt: 0, item: 0 }; }
const csOf = (d: Data, c: Body): CS => d.cs[c.id] ?? (d.cs[c.id] = newCS(C_IDLE));

function addCrate(w: World, d: Data, kind: string, xr: number, zr: number): Body {
  const c = addBody(w, kind, -1, xr * U, zr * U, CRATE_R * U, 1);
  c.y = 0;
  c.m = kind === 'tnt' ? FUSE / 30 : 0;
  const s = newCS(C_GROW);
  s.t = GROW;
  d.cs[c.id] = s;
  return c;
}

function spawnCrates(w: World, d: Data, n: number) {
  const cfg = CFG[d.variant];
  const np = Math.max(2, Math.min(4, players(w).filter((p) => p.alive).length || 4));
  const nitroCap = cfg.nitroCap[np - 2];
  for (let k = 0; k < n; k++) {
    const cell = freeCell(w, d);
    if (!cell) continue;
    let t = d.deck[d.di];
    d.di = (d.di + 1) & 63;
    const nitros = crates(w).filter((c) => c.kind === 'nitro').length;
    if (t === 6 && nitros >= nitroCap) t = 4;
    if (d.variant === 'drain' && t === 4) t = 3;
    addCrate(w, d, t === 6 ? 'nitro' : t === 5 ? 'tnt' : 'crate', cell[0], cell[1]);
  }
}

// L3 chooses one offset for all four edges. Occupied cells are probed in
// alternating directions along the edge, in the original grid's column/row order.
function spawnDrainChests(w: World, d: Data) {
  const offset = (Math.floor(rand(w) * 12) - 6) * 256 + 128;
  const chests: Body[] = [];
  const center = (raw: number) => Math.floor(raw / 256) * 256 + 128;
  for (let edge = 0; edge < 4; edge++) {
    const horizontal = edge < 2;
    const near = edge === 0 || edge === 2;
    const fixed = near ? -0x700 : 0x600;
    const start = edge === 0 || edge === 3 ? -offset : offset;
    let along = start;
    for (let attempt = 0; attempt <= 16; attempt++) {
      const direction = (attempt % 2 === 1 ? 1 : -1) * (horizontal ? 1 : -1);
      const cell = (Math.floor(start / 256) + direction * Math.ceil(attempt / 2)) * 256;
      const x = horizontal ? cell : fixed, z = horizontal ? fixed : cell;
      if (!occupiedAt(w, 10 + Math.floor(x / 256), 10 + Math.floor(z / 256))) {
        if (Math.abs(cell) <= 0x700) along = cell;
        break;
      }
    }
    const x = horizontal ? along : fixed, z = horizontal ? fixed : along;
    chests.push(addCrate(w, d, 'chest', center(x), -center(z)));
  }
  const winner = chests[Math.floor(rand(w) * 4)];
  const index = d.drainWeaponIndex ?? Math.floor(rand(w) * DRAIN_WEAPONS.length);
  csOf(d, winner).item = DRAIN_WEAPONS[index];
  d.drainWeaponIndex = (index + 1) % DRAIN_WEAPONS.length;
}

function stepSpawners(w: World, d: Data, survivors: number, opening = false) {
  if (survivors < 2) return;
  const cfg = CFG[d.variant];
  const sr = Math.max(0.1, w.params.spawnRate);
  const np = Math.max(2, Math.min(4, survivors));
  const crateN = crates(w).length; // FUN_800bb7e8 includes Drain's four question crates

  // ---- crate spawner (FUN_800b7358) ----
  d.tSpawn -= sr >= 1 ? sr : 1;
  if (d.tSpawn < 0) {
    const cap = cfg.cap[np - 2];
    if (cap <= crateN) d.tSpawn = Math.floor(rand(w) * 40) + 5;
    else {
      const room = cap - crateN;
      let n = Math.min(4, cap);
      if (room < n) { n = Math.floor(rand(w) * room) + 1; d.tSpawn = Math.floor(rand(w) * 20) + 8; } else d.tSpawn = Math.floor(rand(w) * 10) + 2;
      spawnCrates(w, d, n);
    }
  }
  // The native pickup counter includes fruit, power-ups and dropped weapons.
  const pickupCount = w.bodies.filter((b) => isPickup(b) && b.alive).length;
  if (pickupCount < 3) {
    if (d.tFruit <= 0) { const c = freeCell(w, d); if (c) dropFruit(w, c[0], c[1], 0, opening); d.tFruit = Math.floor(rand(w) * 30) + 10; } else d.tFruit--;
  }
  // fruit bursts (not in drain bash): 6-9 fruits every 30-50 s
  if (d.variant !== 'drain') {
    if (d.tBurstN === 0) {
      if (d.tBurst <= 0) {
        if (pickupCount < 5) { d.tBurstN = Math.floor(rand(w) * 4) + 6; d.tBurst = (Math.floor(rand(w) * 20) + 30) * 30; } else d.tBurst = 60;
      } else d.tBurst--;
    } else {
      if (d.tBurst > 0) d.tBurst--;
      if (d.tBurstGap <= 0) {
        const k = Math.floor(rand(w) * 256);
        const x = cellRaw(d.cells[k * 2]), z = cellRaw(d.cells[k * 2 + 1]);
        if (floorAt(d, x * U, z * U) && !occupiedAt(w, Math.floor(x / 256) + 10, 9 - Math.floor(z / 256))) { dropFruit(w, x, z, 1, opening); d.tBurstN--; d.tBurstGap = Math.floor(rand(w) * 4) + 2; }
      } else d.tBurstGap--;
    }
  }
  // FUN_800b7358 power-ups (space + snow): one on the floor at a time. A kind that a player already
  // carries, or an occupied cell, leaves the timer at zero for another draw on the next update.
  if (d.variant === 'space' || d.variant === 'snow') {
    if (d.tPower <= 0) {
      if (w.bodies.some((b) => b.alive && (b.kind === 'boots' || b.kind === 'potion' || b.kind === 'mask' || b.kind === 'weight'))) d.tPower = (Math.floor(rand(w) * 10) + 5) * 30;
      else {
        const kind = 0x12 + Math.floor(rand(w) * 4);
        if (!d.eff.includes(kind)) {
          const k = Math.floor(rand(w) * 256), x = cellRaw(d.cells[k * 2]), z = cellRaw(d.cells[k * 2 + 1]);
          if (floorAt(d, x * U, z * U) && !occupiedAt(w, Math.floor(x / 256) + 10, 9 - Math.floor(z / 256))) {
            const name = kind === EFF_AKU ? 'mask' : kind === EFF_BOOTS ? 'boots' : kind === EFF_WEIGHT ? 'weight' : 'potion';
            const it = addBody(w, name, -1, x * U, z * U, 0.5, 1);
            it.y = 2032 * U; it.dash = POWER_LIFE; it.vy = 0; // falls from the sky
            cue(w, 0x41f, it.x, it.z, true, it.y); // FUN_800be370..800be838
            d.tPower = (Math.floor(rand(w) * 10) + 10) * 30;
          }
        }
      }
    } else d.tPower--;
  }
  // drain bash: four "?" crates at the edges once the last weapon was taken
  if (d.variant === 'drain') {
    if (d.tPower >= (1 << 19)) d.tPower = 0; // older snapshots stored a sentinel while chests existed
    if (d.tPower <= 0 && !crates(w).some((c) => c.kind === 'chest')) {
      spawnDrainChests(w, d);
      d.tPower = 0;
    } else if (d.tPower > 0) d.tPower--;
  }
}

// ---------- damage + explosions ----------
/** FUN_80084e04 keeps the largest pending damage. `snd` is the id played when it lands (0x446 for spins, the penguin and the ring). */
function queueDamage(d: Data, slot: number, dmg: number, cls: number, by: number, kx = 0, kz = 0, kv = 0, snd = 0) {
  const p = d.pend[slot];
  if (dmg > p.dmg) { p.dmg = dmg; p.cls = cls; p.by = by; p.kx = kx; p.kz = kz; p.kv = kv; p.snd = snd; }
}

/** A sound the original plays by id. `at` = positional (the sound call passes the object's position). */
function cue(w: World, id: number, x = 0, z = 0, at = false, y?: number) {
  emit(w, 'cue', x, z, -1, id, at ? 1 : 0, undefined, y);
}

/** 0x8009d570 flicker or 0x8009d574 hurt lock */
const guarded = (d: Data, slot: number) => d.inv[slot] > 0 || (d.lock?.[slot] ?? 0) > 0;

/** FUN_8008dec8: everyone within 640 raw (not `skip`) takes `dmg`; grounded players are always inside, jumpers above `tol` raw are not. */
function areaDamage(w: World, d: Data, x: number, z: number, y: number, dmg: number, skip: number, tol: number) {
  for (const p of players(w)) {
    if (!p.alive || p.slot === skip) continue;
    const dd = dist2(p.x, p.z, x, z) / U;
    if (dd >= BLAST_R) continue;
    if (tol > 0 && d.air[p.slot] && p.y / U > y / U + tol) continue;
    const ang = Math.atan2(p.x - x, p.z - z);
    queueDamage(d, p.slot, dmg, 2, skip, Math.sin(ang), Math.cos(ang), dd < 128 ? 80 : (BLAST_R - dd) / 8);
  }
}

/** The crate leaves the world with an effect: break (wood), explosion (tnt / nitro). `skip` = player it does not hurt. */
function destroy(w: World, d: Data, c: Body, skip: number, chain = true) {
  if (!c.alive) return;
  const s = csOf(d, c);
  c.alive = false;
  c.cd = 0;
  const kind = c.kind;
  if (kind === 'crate') {
    emit(w, 'smash', c.x, c.z, -1, 1);
    areaDamage(w, d, c.x, c.z, c.y, KIND_DMG(d.variant, 'crate'), skip, 0xa0);
  } else {
    // LAB_800bae98 clears the tile at the center of a floor-level TNT or nitro blast.
    if (d.variant === 'space' && c.y === 0) {
      const tile = spaceFloorIndex(c.x, c.z);
      if (tile >= 0) d.floor[tile] = 0;
    }
    emit(w, 'explode', c.x, c.z, kind === 'tnt' ? 0 : 1, BLAST_R * U, skip);
    areaDamage(w, d, c.x, c.z, c.y, DMG_BIG, skip, kind === 'nitro' ? 0 : 0xa0);
    if (chain) for (const o of crates(w)) { // FUN_8008dec8 tail: crates flagged 0x100 within the radius blow up 10 ticks later
      if (o === c || (o.kind !== 'tnt' && o.kind !== 'nitro')) continue;
      if (dist2(o.x, o.z, c.x, c.z) / U >= BLAST_R || Math.abs(o.y - c.y) / U >= 0x80) continue;
      const os = csOf(d, o);
      if (os.s !== C_DELAY) { os.s = C_DELAY; os.t = CHAIN_DELAY; os.own = -1; if (o.cd) o.cd = 0; }
    }
  }
  if (s.own >= 0) { /* score credit is given on the hit events */ }
  delete d.cs[c.id];
}

function chestMarker(w: World, d: Data, p: Body) {
  const slot = p.slot, char = d.char[slot], action = d.act[slot];
  let script = d.groundPose?.[slot]?.script || 1, frame = d.groundPose?.[slot]?.frame ?? w.tick;
  const held = holdingCrate(w, slot);
  if (action >= 1 && action <= 3) {
    script = [15, 18, 10][action - 1]; frame = ctActionTicks(char, action) - d.stT[slot];
  } else if (d.st[slot] === ST_HURT) {
    script = 9; frame = ctHurtTicks(char) - d.stT[slot] - 1;
  } else if (held) {
    const grip = d.cs[held.id];
    script = grip.gripScript ?? 16; frame = grip.gripFrame ?? 0;
  } else if (d.air[slot]) {
    script = d.jh[slot] ? 6 : 7; frame = d.jumpFrame?.[slot] ?? 0;
  } else if ((d.tauntAt?.[slot] ?? -1) >= 0) {
    script = 2; frame = w.tick - d.tauntAt![slot];
  }
  const [x, h, z] = onFootItemMarker(char, script, Math.max(0, frame)) ?? [0, 384, 0];
  const sin = Math.round(-4096 * Math.sin(p.face)), cos = Math.round(4096 * Math.cos(p.face));
  return [Math.round(p.x / U) + ((x * cos + z * sin) >> 12), Math.round(p.y / U) + h,
    Math.round(-p.z / U) + ((-x * sin + z * cos) >> 12)];
}

// The Drain actor has a 128-unit extent and the disc tests its edge against the arena.
function outsideChestArena(c: Body) {
  return Math.max(Math.abs(c.x), Math.abs(c.z)) > (ARENA - 128) * U;
}

/** Native chest states 0xc/d (struck) and 0xe/f (thrown). Coordinates below use the disc's Z axis. */
function stepChestReveal(w: World, d: Data, c: Body, s: CS) {
  const age = ++s.t;
  if (age === -1) emit(w, 'chestBreak', c.x, c.z, s.own);
  if (age < 0) return;
  if (age === 0) {
    c.x = ((Math.round(c.x / U) & ~255) + 128) * U;
    c.z = -((Math.round(-c.z / U) & ~255) + 128) * U;
    s.vv = s.homing ? 96 : 128;
    s.up = true;
    if (!s.item) s.fruitFrame = Math.floor(rand(w) * 14);
    return;
  }
  if ((!s.homing && age > 150) || outsideChestArena(c)) {
    c.alive = false;
    delete d.cs[c.id];
    return;
  }
  let x = Math.round(c.x / U), h = Math.round(c.y / U), z = Math.round(-c.z / U);
  let collected = false;
  const actors = players(w);
  const opener = actors.find(p => p.slot === s.own);
  if (s.homing && !s.up && opener) {
    const [tx, th, tz] = chestMarker(w, d, opener);
    const dx = x - tx, dz = z - tz;
    x -= dx >> 2; h += (th - h) >> 2; z -= dz >> 2;
    collected = (dx >> 3) === 0 && (dz >> 3) === 0;
    s.touchable = true;
  }
  const contact = () => actors.find(p => p.alive && !p.fall && bodyOverlapsHeight(d, p, c.y, c.y + 256 * U)
    && dist2(p.x, p.z, c.x, c.z) < p.r + 128 * U);
  c.x = x * U; c.y = h * U; c.z = -z * U;
  let receiver = s.touchable && s.homing ? contact() : undefined;
  if (s.hv > 0) {
    s.hv = Math.max(0, s.hv - THROWS[(d.char[s.own] ?? 1) - 1][2]);
    x -= (Math.round(-4096 * Math.sin(c.face)) * s.hv) >> 12;
    z -= (Math.round(4096 * Math.cos(c.face)) * s.hv) >> 12;
  }
  s.vv = Math.min(s.homing ? 240 : 80, Math.max(0, s.vv + (s.up ? -4 : 4)));
  h += s.up ? s.vv : -s.vv;
  if (!s.vv) s.up = false;
  const surface = s.up ? -Infinity : crateFlightSurface(w, d, c, x * U, h * U, -z * U);
  const landed = !s.up && h * U <= surface;
  if (landed) { h = Math.round(surface / U); s.up = true; s.vv >>= 1; s.hv >>= 1; }
  c.x = x * U; c.y = h * U; c.z = -z * U;
  if (!s.homing) {
    if (!s.up) s.touchable = true;
    if (s.touchable) receiver = contact();
  }
  if (s.homing || s.item) c.face -= 113 * TAU / 4096;
  else c.face = 0;
  if (s.homing && (collected || landed)) receiver ??= opener;
  if (receiver || (s.homing && landed)) {
    if (receiver) awardChest(w, d, receiver, s.item, c);
    c.alive = false;
    delete d.cs[c.id];
  }
}

/** Flag 2 on the penguin (a moving crate, FUN_800bf404, or a spin, FUN_800c159c). Only a sleeping penguin reacts. */
function hitPenguin(d: Data) {
  if (d.peng) d.peng.hit = true;
}
const sin12 = (a: number) => Math.round(4096 * Math.sin((a & 0xfff) * TAU / 4096));
const cos12 = (a: number) => Math.round(4096 * Math.cos((a & 0xfff) * TAU / 4096));

// ---------- setup ----------
export const crateToss: MiniGame = {
  id: 'crateToss',
  name: 'Crate Crush',
  description: 'Throw crates at rivals. TNT ticks down and nitro bursts on touch. Last standing or most health at the buzzer wins.',
  variantDescriptions: {
    space: 'Throw crates at rivals. Explosions open holes in the floor. Last standing or most health at the buzzer wins.',
    snow: 'Throw crates at rivals on slippery ice. Avoid waking the penguin. Last standing or most health at the buzzer wins.',
    drain: 'Throw crates at rivals. Break open special crates for weapons. Last standing or most health at the buzzer wins.',
  },
  controls: '{move} walk. {a} pick up or throw. {b} spin to kick crates. {c} jump empty-handed / {d} taunt.',
  variantControls: { drain: '{move} walk. {a} pick up or throw. {b} spin or fire held weapon. {c} jump empty-handed / {d} taunt.' },
  variants: CT_VARIANTS,
  maxTime: 90,

  primeCountdownPad(w, slot, pad) {
    const d = D(w);
    d.prevA[slot] = pad.a;
    d.prevB[slot] = pad.b;
    (d.prevC ??= [false, false, false, false])[slot] = !!pad.c;
  },

  setup(w, slots) {
    const variant = pickVariant(w, CT_VARIANTS);
    const cfg = CFG[variant];
    const z4 = () => [0, 0, 0, 0];
    const d: Data = {
      variant, char: [1, 1, 1, 1], hp: [CT_HP, CT_HP, CT_HP, CT_HP], score: z4(), taken: z4(), elim: [-1, -1, -1, -1],
      stun: z4(), act: z4(), st: z4(), stT: z4(), inv: z4(), ic: z4(), boots: z4(), slow: z4(), mask: z4(),
      eff: z4(), effT: z4(), pass: z4(), weight: -1, weightT: 0,
      f8: [0, 0, 0, 0], vx: z4(), vz: z4(), vy: z4(), air: [false, false, false, false], jh: [false, false, false, false], prevA: [false, false, false, false], prevB: [false, false, false, false],
      groundPose: Array.from({ length: 4 }, openingGroundPose),
      pend: [0, 1, 2, 3].map(() => ({ dmg: 0, cls: 0, by: -1, kx: 0, kz: 0, kv: 0 })),
      weapon: z4(), ammo: z4(), wcd: z4(),
      floor: variant === 'space' ? new Array(CT_FLOOR_N * CT_FLOOR_N).fill(1) : [], // 0711.t29 has all 64 top labels
      penguin: 0, cs: {}, cells: [], cur: 0, deck: [], di: 0,
      tSpawn: 0, tFruit: 0, tBurst: (Math.floor(rand(w) * 10) + 10) * 30, tBurstGap: 0, tBurstN: 0,
      tPower: variant === 'jungle' ? 30 : variant === 'drain' ? Math.floor(rand(w) * 30) + 30 : (Math.floor(rand(w) * 10) + 10) * 30,
      tChest: 30, lastBy: [-1, -1, -1, -1], lastByTick: [-99, -99, -99, -99],
    };
    w.data = d;
    d.cpu = [0, 1, 2, 3].map(newCrushBot);
    d.cpuSkill = crushSkills(d, [0, 1, 2, 3].map((slot) => slots.find((s) => s.slot === slot)?.level));
    d.cpuWeight = [16, 16, 16, 16];
    d.cpuRandom = discRandomState(w.rng);
    d.humanSlots = slots.reduce((mask, s) => s.bot ? mask : mask | (1 << s.slot), 0);
    d.cells = buildCells(w, variant);
    const deck: number[] = [];
    for (let i = 0; i < cfg.deck[0] * 4; i++) deck.push(4);
    for (let i = 0; i < cfg.deck[1] * 4; i++) deck.push(5);
    for (let i = 0; i < cfg.deck[2] * 4; i++) deck.push(6);
    while (deck.length < 64) deck.push(4);
    for (let k = 0; k < 600; k++) { const a = Math.floor(rand(w) * 64), b = Math.floor(rand(w) * 64); const t = deck[a]; deck[a] = deck[b]; deck[b] = t; }
    d.deck = deck;
    if (variant === 'drain') d.drainWeaponIndex = Math.floor(rand(w) * DRAIN_WEAPONS.length);
    d.di = Math.floor(rand(w) * 32) + 20;
    if (variant === 'snow') {
      const g = addBody(w, 'penguin', -1, 0, 0, PENGUIN_BODY * U, 8);
      g.face = -0xe3 * TAU / 4096;
      d.peng = { s: 1, e: 0, f: CT_OPENING_TICKS, t: 0, a: 0 };
    }
    for (const s of slots) {
      d.char[s.slot] = DISC_CHARACTER[s.char ?? s.slot] ?? 1;
      const [x, z] = SPAWN[s.slot];
      const b = addBody(w, 'player', s.slot, x * U, z * U, CT_HULL[d.char[s.slot] - 1][0] * U * w.params.playerScale, 3);
      b.face = Math.atan2(-x, -z);
      d.f8[s.slot] = snap8(b.face);
    }
    // The network clock starts on GO. Run the arena spawner during the 99
    // locked updates and keep birth ticks so a joining client can draw the intro.
    const openingSpawns: Record<number, number> = {};
    let nextSpawn = w.nextId;
    spawnCrates(w, d, cfg.start);
    for (let frame = 0; frame < CT_OPENING_TICKS; frame++) {
      stepSpawners(w, d, slots.length, true);
      while (nextSpawn < w.nextId) openingSpawns[nextSpawn++] = frame;
      for (const c of crates(w)) if (d.cs[c.id].s === C_GROW) stepCrate(w, d, c);
      for (const o of w.bodies) if (isPickup(o)) stepPickup(w, d, o, []);
    }
    d.openingSpawns = openingSpawns;
  },

  step(w, inputs) {
    const d = D(w);
    const ps = players(w);
    const live = ps.filter((p) => p.alive);
    crushCpuPass(w, true);
    stepSpawners(w, d, live.length);

    // ---- players ----
    for (const p of ps) if (p.alive) stepPlayer(w, d, p, inputs[p.slot] ?? IDLE);
    // players bump (the moving one is pushed out; weight changes hands)
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (!a.alive || !b.alive || a.fall || b.fall || !bodyOverlapsHeight(d, b, a.y + CT_HULL[d.char[a.slot]-1][1]*U, a.y + CT_HULL[d.char[a.slot]-1][2]*U)) continue;
      const dd = dist2(a.x, a.z, b.x, b.z), m = a.r + b.r;
      if (dd >= m) continue;
      const nx = dd > 1e-6 ? (a.x - b.x) / dd : 1, nz = dd > 1e-6 ? (a.z - b.z) / dd : 0;
      const am = Math.hypot(d.vx[a.slot], d.vz[a.slot]) > 0, bm = Math.hypot(d.vx[b.slot], d.vz[b.slot]) > 0;
      const push = m - dd + 1 * U;
      if (am || !bm) { a.x += nx * push; a.z += nz * push; } else { b.x -= nx * push; b.z -= nz * push; }
      passWeight(w, d, a, b); passWeight(w, d, b, a);
    }
    for (const p of live) clampPlayer(w, d, p);

    // ---- crates ----
    for (const c of crates(w)) stepCrate(w, d, c);

    // ---- pickups ----
    for (const o of w.bodies) if (o.alive && isPickup(o)) stepPickup(w, d, o, live);

    // ---- penguin + weapon shots ----
    stepPenguin(w, d, live);
    stepShots(w, d, live);

    // ---- weight ----
    if (d.weight >= 0) {
      const wp = ps.find((p) => p.slot === d.weight);
      if (!wp || !wp.alive || d.eff[d.weight] !== EFF_WEIGHT) d.weight = -1;
      else d.weightT = d.effT[d.weight];
    }
    // seconds mirrors for the view
    for (const p of ps) {
      const s = p.slot;
      d.stun[s] = d.st[s] === ST_HURT ? d.stT[s] / 30 : 0;
      d.boots[s] = d.eff[s] === EFF_BOOTS ? d.effT[s] / 30 : 0;
      d.slow[s] = d.eff[s] === EFF_SLOW ? d.effT[s] / 30 : 0;
      d.mask[s] = d.eff[s] === EFF_AKU ? d.effT[s] / 30 : 0;
    }
    // time limit is handled by isOver/placements; keep arrays tidy
    w.bodies = w.bodies.filter((b) => b.alive || b.kind === 'player');
  },

  isOver(w) {
    return aliveCount(w) <= 1 || w.time >= crateToss.maxTime;
  },

  placements(w) {
    const d = D(w);
    return [0, 1, 2, 3].sort((a, b) => {
      const aa = d.hp[a] > 0, bb = d.hp[b] > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.hp[b] - d.hp[a] || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  isDraw(w, [first, second]) {
    const { hp } = D(w);
    // The versus timer compares remaining health. Tied live leaders do not receive the winner flag.
    return hp[first] > 0 && hp[first] === hp[second];
  },

  bot(w, slot): InputState { return botInput(w, slot); },
};

function dropFruit(w: World, xr: number, zr: number, sky: number, opening: boolean) {
  const f = addBody(w, 'fruit', 0, xr * U, zr * U, 0.5, 1);
  f.dash = FRUIT_LIFE;
  f.y = sky ? 2032 * U : 0;
  if (!opening) emit(w, 'fruitSpawn', f.x, f.z, -1);
}

// ---------- players ----------
const snap8 = (a: number) => Math.round(a / (TAU / 8)) * (TAU / 8);

function groundAt(w: World, d: Data, x: number, z: number, ignore?: Body): number {
  if (!floorAt(d, x, z)) return -1e9;
  let g = 0;
  for (const c of crates(w)) {
    if (c === ignore || c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s || (s.s !== C_IDLE && s.s !== C_GROW)) continue;
    if (dist2(x, z, c.x, c.z) < CRATE_R * U * 0.9) g = Math.max(g, c.y + CRATE_H * U);
  }
  return g;
}

/** FUN_800bac5c / FUN_80025e00, the support nearest to a descending crate. */
function crateFlightSurface(w: World, d: Data, flying: Body, x: number, y: number, z: number) {
  if (!floorAt(d, x, z)) return -Infinity;
  if (Math.max(x, -z) >= ARENA * U || Math.min(x, -z) < -ARENA * U) return 0;
  let surface = 0;
  for (const crate of crates(w)) {
    if (crate === flying || crate.cd !== 0) continue;
    const state = d.cs[crate.id]?.s;
    if (state !== C_IDLE && state !== C_GROW) continue;
    // Marker 0x10 has radius 128. The native floor probe adds 64.
    if (dist2(x, z, crate.x, crate.z) >= 192 * U) continue;
    const top = crate.y + CRATE_H * U;
    if (Math.abs(y - top) < Math.abs(y - surface)) surface = top;
  }
  return surface;
}

type ResultPlayerState = 'ready' | 'action' | 'rise' | 'fall' | 'hole' | 'land' | 'winner' | 'loser' | 'out';

interface CrateResultPlayer {
  state: ResultPlayerState;
  script: number;
  elapsed: number;
  outAge: number;
}

/** Advance the arena after a verdict using a private copy of the terminal snapshot. */
export function createCrateCrushResult(terminal: World, winner: number | undefined) {
  const world: World = {
    ...terminal, data: structuredClone(terminal.data), bodies: terminal.bodies.map(b => ({ ...b })), ev: [],
  };
  const d = D(world);
  const actors = players(world);
  const forSlot = new Map<number, CrateResultPlayer>(actors.map(p => {
    const s = p.slot, char = d.char[s];
    if (!p.alive) {
      const outAge = Math.max(0, terminal.tick - d.elim[s] - 1);
      return [s, { state: 'out', script: 0, elapsed: 0, outAge }];
    }
    if (p.fall) return [s, { state: 'hole', script: 7, elapsed: 0, outAge: 0 }];
    if (d.air[s]) {
      const initialRise = char >= 5 ? 72 : 108;
      const dec = char >= 5 ? 6 : 10;
      const elapsed = d.jh[s] ? (initialRise - d.vy[s]) / dec - 1 : (d.vy[s] - 8) / 10;
      return [s, { state: d.jh[s] ? 'rise' : 'fall', script: d.jh[s] ? 6 : 7, elapsed: d.jumpFrame?.[s] ?? Math.max(0, Math.round(elapsed)), outAge: 0 }];
    }
    const action = d.st[s], held = holdingCrate(world, s);
    const moving = Math.hypot(p.vx, p.vz) > 0.7;
    if (action !== ST_MOVE) {
      const script = action === ST_PICK ? 0xf : action === ST_THROW ? 0x12 : action === ST_SPIN ? 0xa : 9;
      const elapsed = action === ST_HURT ? ctHurtTicks(char) - d.stT[s] - 1 : ctActionTicks(char, action) - d.stT[s];
      return [s, { state: action === ST_SPIN ? 'ready' : 'action', script, elapsed, outAge: 0 }];
    }
    const ground = d.groundPose?.[s];
    const script = held ? d.cs[held.id]?.gripScript ?? (moving ? 0x11 : 0x10) : ground?.script || (moving ? 5 : 1);
    const elapsed = held ? d.cs[held.id]?.gripFrame ?? 0 : ground?.frame ?? 0;
    return [s, { state: 'ready', script, elapsed, outAge: 0 }];
  }));
  let winnerAt = -1;

  function pose(a: CrateResultPlayer, state: ResultPlayerState, script: number, elapsed = 0) {
    a.state = state;
    a.script = script;
    a.elapsed = elapsed;
  }

  // FUN_800880e0 / 800c0f14 / 800c1278 detach the crate at its last hand transform.
  // FUN_800bc038 state 4 clears its angles and arms a vertical drop.
  function release(p: Body) {
    const c = holdingCrate(world, p.slot);
    if (!c) return;
    const cs = csOf(d, c);
    c.cd = 0;
    c.dash = 1;
    cs.s = C_DROP;
    cs.t = 0;
    cs.pitch = 0;
    cs.vv = 80;
    cs.own = -1;
  }

  function enterVerdict(p: Body, a: CrateResultPlayer) {
    const win = p.slot === winner;
    release(p);
    d.eff[p.slot] = d.weapon[p.slot] = d.inv[p.slot] = 0;
    p.vx = p.vy = p.vz = 0;
    p.fall = false;
    p.y = Math.max(0, groundAt(world, d, p.x, p.z));
    pose(a, win ? 'winner' : 'loser', win ? 0xc : 1);
    if (win) winnerAt = world.tick - terminal.tick;
  }

  function stepActor(p: Body, a: CrateResultPlayer) {
    const s = p.slot, char = d.char[s];
    a.elapsed++;
    switch (a.state) {
      case 'out':
        a.outAge++;
        return;
      case 'hole':
        d.vy[s] = Math.min(112, d.vy[s] + 10);
        p.y -= d.vy[s] * U;
        if (p.y < -SPACE_KO_DEPTH * U) {
          if (s === winner) pose(a, 'ready', 1);
          else {
            p.alive = false;
            pose(a, 'out', 0);
            emit(world, 'resultOut', p.x, p.z, s);
          }
        }
        return;
      case 'rise':
      case 'fall': {
        const gravity = world.params.gravity;
        p.x += d.vx[s] * world.params.speed * U;
        p.z += d.vz[s] * world.params.speed * U;
        if (a.state === 'rise') {
          d.vy[s] -= (d.vy[s] > 0x40 ? JUMP_CUT : char >= 5 ? 6 : 10) * gravity;
          if (d.vy[s] >= 0) p.y += d.vy[s] * U;
          else {
            release(p);
            d.jh[s] = false;
            d.vy[s] = 8;
            pose(a, 'fall', 7);
          }
          return;
        }
        const g = groundAt(world, d, p.x, p.z);
        if (p.y <= g) {
          p.y = g;
          p.vy = 0;
          d.air[s] = false;
          pose(a, 'land', 8, 1);
          emit(world, 'resultLand', p.x, p.z, s);
        } else if (p.y < 0 && !floorAt(d, p.x, p.z)) {
          pose(a, 'hole', 7);
          release(p);
          d.vy[s] = 8;
        } else {
          d.vy[s] = Math.min(112, d.vy[s] + 10 * gravity);
          p.y -= d.vy[s] * U;
        }
        return;
      }
      case 'action': {
        const action = d.st[s];
        d.stT[s]--;
        const releaseFrame = ACTIONS[char - 1][3];
        if (action === ST_THROW && a.elapsed === throwVoiceFrame(char)) emit(world, 'resultThrowVoice', p.x, p.z, s);
        if (action === ST_THROW && a.elapsed === releaseFrame) {
          const crate = holdingCrate(world, s);
          if (crate) {
            throwCrate(world, d, p, crate);
          }
        }
        if (d.stT[s] <= 0) {
          d.st[s] = ST_MOVE;
          d.act[s] = 0;
          if (action === ST_THROW && char <= 2) {
            pose(a, 'land', 8);
            emit(world, 'resultLand', p.x, p.z, s);
          } else pose(a, 'ready', holdingCrate(world, s) ? 0x10 : 1);
        }
        return;
      }
      case 'winner': {
        // FUN_8008a200 turns one quarter of the signed 12-bit error per update.
        const yaw = Math.round(-p.face * 4096 / TAU) & 4095;
        const diff = (-yaw) & 4095;
        p.face = -((yaw + ((diff > 2048 ? diff - 4096 : diff) >> 2)) & 4095) * TAU / 4096;
        d.hp[s] = Math.max(2, d.hp[s]);
        return;
      }
      case 'loser':
        d.hp[s] = Math.max(2, d.hp[s]);
        return;
      case 'ready':
      case 'land':
        if (winner === undefined) return;
        // The carrying handlers divert to script 0x12 when result flags are set.
        if (a.state === 'ready' && holdingCrate(world, s)) {
          d.st[s] = ST_THROW;
          d.act[s] = ST_THROW;
          d.stT[s] = ctActionTicks(char, ST_THROW);
          p.vx = p.vz = 0;
          pose(a, 'action', 0x12);
        } else enterVerdict(p, a);
        return;
    }
  }

  return {
    world,
    actors: forSlot,
    get winnerAt() { return winnerAt; },
    step(): GameEvent[] {
      world.tick++;
      world.ev = [];
      for (const p of actors) stepActor(p, forSlot.get(p.slot)!);
      for (const c of crates(world)) stepCrate(world, d, c);
      for (const o of world.bodies) if (o.alive && isPickup(o)) stepPickup(world, d, o, []);
      stepPenguin(world, d, []);
      stepShots(world, d, []);
      world.bodies = world.bodies.filter(b => b.alive || b.kind === 'player');
      return world.ev;
    },
  };
}

/** FUN_800874ec checks ice velocity before friction. Entering idle from a run takes one update. */
function stepGroundPose(w: World, d: Data, p: Body, walking: boolean, occupied: boolean) {
  const slot = p.slot, char = d.char[slot];
  const poses = d.groundPose ??= Array.from({ length: 4 }, openingGroundPose);
  const pose = poses[slot];
  const previous = pose.script;
  const touchdown = d.landedAt?.[slot] === w.tick + 1;
  let script = 1;
  if (occupied || d.air[slot]) script = 0;
  else if (touchdown || (previous === 8 && !walking && pose.frame + 1 < LAND_TICKS[char - 1])) script = 8;
  else if (walking) script = 5;
  else if (d.variant === 'snow' && (previous === 1 || previous === 14) && (d.vx[slot] || d.vz[slot])) script = 14;
  pose.script = script;
  if (script === 0) pose.frame = 0;
  else if (script === previous) pose.frame++;
  else pose.frame = script === 8 || script === 14 || (script === 1 && previous === 14) ? 1 : 0;
  if (script === 14 && previous !== 14) pose.scrape = 0x456 + Math.floor(rand(w) * 6);
  else if (script !== 14) delete pose.scrape;
  if (script !== 5) return;
  const [period, left, right] = STRIDE[char - 1];
  const phase = pose.frame % period;
  if (phase === left || (phase === right && d.eff[slot] !== EFF_SLOW)) {
    emit(w, 'step', p.x, p.z, slot, phase === left ? 0 : 1, d.eff[slot] === EFF_SLOW ? 0x41e : -1, undefined, p.y);
  }
}

function stepPlayer(w: World, d: Data, p: Body, inp: InputState) {
  const slot = p.slot;
  if (p.fall) {
    // FUN_800882dc sets 8/112/10, then FUN_8008a854 advances the out state below the floor.
    d.vy[slot] = Math.min(112, d.vy[slot] + 10);
    p.y -= d.vy[slot] * U;
    syncBody(p, d);
    if (p.y < -SPACE_KO_DEPTH * U) {
      d.hp[slot] = 0;
      knockOut(w, d, p, d.lastBy[slot]);
    }
    return;
  }
  const char = d.char?.[slot] ?? 1;
  const heavy = char >= 5;
  const slow = d.eff[slot] === EFF_SLOW;
  // effect timers run every tick
  if (d.effT[slot] > 0) {
    d.effT[slot]--;
    if (d.effT[slot] === 0) {
      if (d.eff[slot] === EFF_WEIGHT) {
        // FUN_800c09f4: state 0x12 counts the holder out at once, drops the weight on them and plays 0x453.
        d.eff[slot] = 0;
        d.hp[slot] = 0;
        (d.outBy ??= [0, 0, 0, 0])[slot] = 1;
        cue(w, 0x453);
        knockOut(w, d, p, -1);
        return;
      }
      if (d.eff[slot] === EFF_AKU) cue(w, 0x421); // FUN_800bef00
      d.eff[slot] = 0;
    }
  }
  if (d.pass[slot] > 0) d.pass[slot]--;
  if (d.inv[slot] > 0) d.inv[slot]--;
  if (d.wcd[slot] > 0) d.wcd[slot]--;
  // pending damage (FUN_80084e04 keeps the largest per tick, FUN_80083e8c applies it)
  const pd = d.pend[slot];
  const lock = d.lock ??= [0, 0, 0, 0];
  if (pd.dmg > 0) {
    const blocked = guarded(d, slot) && pd.cls <= d.ic[slot];
    if (!blocked) applyHit(w, d, p, pd);
    pd.dmg = 0;
    if (!p.alive) return;
  }
  // FUN_80083e8c: the hurt lock zeroes the pad, and its expiry starts 40 updates of flicker.
  if (lock[slot] > 0) {
    if (--lock[slot] === 0 && (d.dying?.[slot] ?? -2) === -2) d.inv[slot] = FLICKER_TICKS;
    inp = IDLE;
  }
  const odd = (w.tick & 1) === 1;
  if (slow && odd) { syncBody(p, d); return; } // slow motion: acts every other tick
  const aDown = inp.a, aNew = aDown && !d.prevA[slot];
  const bNew = inp.b && !d.prevB[slot];
  d.prevA[slot] = aDown; d.prevB[slot] = inp.b;
  const pc = (d.prevC ??= [false, false, false, false]);
  const cNew = !!inp.c && !pc[slot];
  pc[slot] = !!inp.c;
  const held = holdingCrate(w, slot);
  const ice = d.variant === 'snow' || w.params.friction < 0.5;
  const sx = inp.x, sz = inp.y, sl = Math.hypot(sx, sz);
  const moving = sl > 0.3;
  const sang = Math.atan2(sx, sz);
  const wasFree = d.st[slot] === ST_MOVE;
  const hurt = d.st[slot] === ST_HURT;
  let wantJump = false;

  // state machine
  if (d.stT[slot] > 0) d.stT[slot]--;
  switch (d.st[slot]) {
    case ST_HURT: {
      // FUN_800bff1c: script 9 plays the impact voice, and event 8 switches a lethal hit to script 0x13.
      const frame = ctHurtTicks(char) - d.stT[slot] - 1;
      if (frame === HURT_VOICE[char - 1]) emit(w, 'thud', p.x, p.z, slot, 1, -1, undefined, p.y);
      const killer = d.dying?.[slot] ?? -2;
      if (frame === HURT_EV8[char - 1] && killer !== -2) { d.dying![slot] = -2; knockOut(w, d, p, killer); return; }
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    }
    case ST_PICK:
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    case ST_THROW: {
      const t = ctActionTicks(char, 2) - d.stT[slot];
      if (t === throwVoiceFrame(char)) emit(w, 'throwVoice', p.x, p.z, slot);
      if (t === ACTIONS[char - 1][3]) { const c = holdingCrate(w, slot); if (c) throwCrate(w, d, p, c); }
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    }
    case ST_SPIN:
      spinHit(w, d, p);
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    default: {
      if (held) {
        if (aDown && (aNew || d.cs[held.id]?.gripScript === 17)) {
          d.st[slot] = ST_THROW; d.stT[slot] = ctActionTicks(char, 2); d.act[slot] = 2;
        }
        break;
      }
      if (inp.b && d.ammo[slot] > 0 && d.wcd[slot] <= 0) {
        fireWeapon(w, d, p);
        break;
      }
      if (d.air[slot]) break;
      if (bNew && !d.ammo[slot] && d.wcd[slot] <= 0) {
        d.st[slot] = ST_SPIN; d.stT[slot] = ctActionTicks(char, 3); d.act[slot] = 3; emit(w, 'kick', p.x, p.z, slot, 1);
        break;
      }
      if (aNew) {
        const c = findPick(w, d, p);
        if (c) { pickUp(w, d, p, c); break; }
        // FUN_80086fcc clears the old Circle bit so a held pickup can retry next tick.
        d.prevA[slot] = false;
      }
      wantJump = cNew;
    }
  }
  const free = d.st[slot] === ST_MOVE;
  if (held) csOf(d, held).walking = wasFree && free && moving;
  const drive = free || (wasFree && (d.st[slot] === ST_PICK || d.st[slot] === ST_THROW));
  const taunt = (d.tauntAt ??= [-1, -1, -1, -1]);
  if (!free || held || moving || wantJump || d.air[slot]) taunt[slot] = -1;
  else {
    if (taunt[slot] >= 0 && w.tick - taunt[slot] >= TAUNT_TICKS[char - 1]) taunt[slot] = -1;
    if (inp.d && taunt[slot] < 0) {
      taunt[slot] = w.tick;
      emit(w, 'taunt', p.x, p.z, slot);
    }
  }
  // FUN_800859d4: with no direction held, a CPU's L2 / R2 turns its yaw by 0x100 (the web heading turns the other way).
  if (free && !moving && isCpuSlot(d, slot) && (inp.l || inp.r)) {
    d.f8[slot] += ((inp.l ? 1 : 0) - (inp.r ? 1 : 0)) * 0x100 * TAU / 4096;
  }
  // facing (8-way, re-snaps when the stick is more than 24 degrees away)
  if (free && moving && Math.abs(angDiff(d.f8[slot], sang)) > AIM) d.f8[slot] = snap8(sang);
  if (free && moving) p.face += angDiff(p.face, sang) / 4;
  else if (!moving && free) p.face += angDiff(p.face, d.f8[slot]) / 8;

  // The character callback updates height before Snow Bash reads it for ice steering.
  const g = groundAt(w, d, p.x, p.z);
  const human = d.humanSlots === undefined || !!(d.humanSlots & (1 << slot));
  const riseDec = heavy && human ? 6 : 10;
  const grav = w.params.gravity;
  const jumpFrame = d.jumpFrame ??= [-1, -1, -1, -1];
  const landedAt = d.landedAt ??= [-1, -1, -1, -1];
  if (!free || moving || wantJump || taunt[slot] >= 0) landedAt[slot] = -1;
  if (wantJump && free) {
    d.air[slot] = true;
    d.jh[slot] = true;
    d.vy[slot] = heavy && human ? 72 : 108;
    jumpFrame[slot] = 0;
    emit(w, 'jump', p.x, p.z, slot, 1);
  } else if (d.air[slot]) jumpFrame[slot]++;
  if (d.air[slot]) {
    // Coco's ten-pose rise track ends before the vertical integrator changes state.
    if (d.jh[slot] && char === 2 && jumpFrame[slot] >= 10) {
      d.jh[slot] = false; d.vy[slot] = 8; jumpFrame[slot] = 0;
    }
    if (d.jh[slot]) {
      const dec = human && !inp.c && d.vy[slot] > 0x40 ? JUMP_CUT : riseDec;
      d.vy[slot] -= dec * grav;
      if (d.vy[slot] < 0) {
        d.jh[slot] = false; d.vy[slot] = 8; jumpFrame[slot] = 0;
      } else p.y += d.vy[slot] * U;
    } else if (p.y <= g + 1e-9) {
      p.y = g;
      d.air[slot] = false; d.vy[slot] = 0;
      landedAt[slot] = w.tick + 1;
      emit(w, 'land', p.x, p.z, slot, 0.4, -1, undefined, p.y);
      landedOn(w, d, p);
    } else {
      d.vy[slot] = Math.min(JUMP_FALL_MAX, d.vy[slot] + 10 * grav);
      p.y -= d.vy[slot] * U;
    }
  } else if (p.y > g + 1e-6) {
    d.air[slot] = true; d.jh[slot] = false; d.vy[slot] = 8; jumpFrame[slot] = 0;
  } else p.y = Math.max(0, g);

  stepGroundPose(w, d, p, wasFree && free && moving, !free || !!held || taunt[slot] >= 0);
  // ---- horizontal velocity (raw/tick) ----
  const sp = w.params.speed;
  const hasHold = !!held || d.st[slot] === ST_THROW;
  const carrySpeed = heavy ? 40 : 30;
  if (hurt) {
    // knock-back: speed decays 4 per tick (ice: per axis)
    const k = Math.hypot(d.vx[slot], d.vz[slot]);
    if (k > 0) { const n = Math.max(0, k - 4) / k; d.vx[slot] *= n; d.vz[slot] *= n; }
  } else if (d.variant === 'snow') {
    const targets = d.iceTargets ??= Array.from({ length: 4 }, () => ({ x: 0, z: 0 }));
    const target = targets[slot];
    if (!moving) { target.x = 0; target.z = 0; }
    else if (drive) {
      const speed = 4 * ((hasHold ? carrySpeed : WALK) + (d.eff[slot] === EFF_BOOTS ? BOOT_BONUS : 0));
      target.x = ((Math.round(Math.sin(sang) * 4096) * speed) >> 12) / 4;
      target.z = -((Math.round(-Math.cos(sang) * 4096) * speed) >> 12) / 4;
    }
    const airborne = p.y > Math.max(0, g) + 1e-9;
    d.vx[slot] = approach(d.vx[slot], target.x, airborne ? 32 : target.x ? ICE_ACC / 4 : ICE_DEC / 4);
    d.vz[slot] = approach(d.vz[slot], target.z, airborne ? 32 : target.z ? ICE_ACC / 4 : ICE_DEC / 4);
  } else if (ice) {
    const walk = 4 * ((hasHold ? carrySpeed : WALK) + (d.eff[slot] === EFF_BOOTS ? BOOT_BONUS : 0));
    const tx = drive && moving ? Math.sin(sang) * walk : 0, tz = drive && moving ? Math.cos(sang) * walk : 0;
    d.vx[slot] = approach(d.vx[slot], tx, tx === 0 ? ICE_DEC : ICE_ACC);
    d.vz[slot] = approach(d.vz[slot], tz, tz === 0 ? ICE_DEC : ICE_ACC);
  } else if (drive) {
    const spd = (hasHold ? carrySpeed : WALK) + (d.eff[slot] === EFF_BOOTS ? BOOT_BONUS : 0);
    d.vx[slot] = moving ? Math.sin(sang) * spd : 0;
    d.vz[slot] = moving ? Math.cos(sang) * spd : 0;
  } else { d.vx[slot] = 0; d.vz[slot] = 0; }
  const snow = d.variant === 'snow' && !hurt;
  p.x += (snow ? Math.floor(d.vx[slot]) : d.vx[slot]) * sp * U;
  p.z += (snow ? Math.ceil(d.vz[slot]) : d.vz[slot]) * sp * U;

  syncBody(p, d);
}

function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

function syncBody(p: Body, d: Data) {
  p.vx = d.vx[p.slot] * 30 * U;
  p.vz = d.vz[p.slot] * 30 * U;
  p.vy = d.air[p.slot] ? (d.jh[p.slot] ? d.vy[p.slot] : -d.vy[p.slot]) * 30 * U : 0;
}

function bodyOverlapsHeight(d: Data, p: Body, bottom: number, top: number) {
  const hull = CT_HULL[d.char[p.slot] - 1];
  return bottom < p.y + hull[2] * U && p.y + hull[1] * U < top;
}

function clampPlayer(w: World, d: Data, p: Body) {
  if (!p.alive || p.fall) return;
  const slot = p.slot;
  // FUN_800c1a30: crates push out a moving player (any player on ice) by 120 plus the crate shape's 128.
  // FUN_800c284c pushes a hurt player out of idle or sliding crates whether or not they move.
  const pushed = d.variant === 'snow' || d.st[slot] === ST_HURT || d.vx[slot] !== 0 || d.vz[slot] !== 0;
  for (const c of crates(w)) {
    if (c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s || s.s === CT_CHEST_REVEAL || s.s === CT_CHEST_SHRINK || (s.s === C_THROWN && s.own === slot)) continue;
    if (!bodyOverlapsHeight(d, p, c.y, c.y + CRATE_H * U)) continue;
    const dd = dist2(p.x, p.z, c.x, c.z), m = (CRATE_R + 128) * U;
    if (dd >= m) continue;
    // touching a nitro sets it off (flag 8)
    if (c.kind === 'nitro' && s.s === C_IDLE) { s.own = slot; destroy(w, d, c, -1); continue; }
    if (!pushed) continue;
    // standing on top (falling onto it) is handled by groundAt; otherwise slide out sideways
    if (p.y > c.y + CRATE_H * U * 0.85) continue;
    const nx = dd > 1e-6 ? (p.x - c.x) / dd : 1, nz = dd > 1e-6 ? (p.z - c.z) / dd : 0;
    p.x = c.x + nx * (m + 1 * U); p.z = c.z + nz * (m + 1 * U);
  }
  // The penguin is in the same collidable list, with its 212-unit marker.
  const g = w.bodies.find((b) => b.kind === 'penguin');
  if (g && pushed && bodyOverlapsHeight(d, p, g.y, g.y + PENGUIN_H * U)) {
    const dd = dist2(p.x, p.z, g.x, g.z), m = (CRATE_R + PENGUIN_BODY) * U;
    if (dd < m) {
      const nx = dd > 1e-6 ? (p.x - g.x) / dd : 1, nz = dd > 1e-6 ? (p.z - g.z) / dd : 0;
      p.x = g.x + nx * (m + 1 * U); p.z = g.z + nz * (m + 1 * U);
    }
  }
  const lim = ARENA * U - p.r;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
  if (p.y > 0 || floorAt(d, p.x, p.z)) return;
  // FUN_800882dc locks you to the tile center and releases your held crate.
  const tile = spaceFloorIndex(p.x, p.z);
  p.x = ((tile % CT_FLOOR_N) * 512 - 1792) * U;
  p.z = (Math.floor(tile / CT_FLOOR_N) * 512 - 1792) * U;
  p.fall = true;
  d.air[slot] = true; d.jh[slot] = false;
  d.vx[slot] = 0; d.vz[slot] = 0; d.vy[slot] = 8;
  const held = holdingCrate(w, slot);
  if (held) {
    const state = csOf(d, held);
    held.cd = 0;
    held.dash = 1;
    state.s = C_THROWN; state.hv = 0; state.vv = 80; state.up = false; state.t = 0;
  }
  syncBody(p, d);
  emit(w, 'hole', p.x, p.z, slot, 1);
}

function applyHit(w: World, d: Data, p: Body, pd: Data['pend'][number]) {
  const slot = p.slot, char = d.char[slot];
  if (pd.snd) cue(w, pd.snd);
  // FUN_800bfd2c: the held crate drops through state 4, owned by the attacker.
  const held = holdingCrate(w, slot);
  if (held) {
    const s = csOf(d, held);
    held.cd = 0; s.s = C_DROP; s.hv = 0; s.vv = 80; s.up = false; s.own = pd.by; s.t = 0; s.pitch = 0;
    held.dash = 1;
  }
  const aku = d.eff[slot] === EFF_AKU;
  d.st[slot] = ST_HURT; d.stT[slot] = ctHurtTicks(char); d.act[slot] = 4; d.ic[slot] = pd.cls;
  d.vx[slot] = pd.kx * pd.kv; d.vz[slot] = pd.kz * pd.kv;
  const lock = d.lock ??= [0, 0, 0, 0];
  d.inv[slot] = 0;
  // Hurt entry ends the boots and empties a Drain weapon.
  if (d.eff[slot] === EFF_BOOTS) { d.eff[slot] = 0; d.effT[slot] = 0; }
  d.ammo[slot] = 0; d.weapon[slot] = 0;
  if (aku) {
    // The mask absorbs the hit: its timer ends (sound 0x421 on the next update) and no hurt lock starts.
    d.effT[slot] = 1; lock[slot] = 0;
    emit(w, 'hit', p.x, p.z, slot, 0, pd.by);
    return;
  }
  lock[slot] = HURT_TICKS;
  d.hp[slot] = Math.max(0, d.hp[slot] - pd.dmg);
  d.taken[slot]++;
  if (pd.by >= 0 && pd.by !== slot) { d.score[pd.by]++; d.lastBy[slot] = pd.by; d.lastByTick[slot] = w.tick; }
  emit(w, 'hit', p.x, p.z, slot, pd.dmg / CT_HP, pd.by >= 0 && pd.by !== slot ? pd.by : -1);
  if (d.hp[slot] <= 0) (d.dying ??= [-2, -2, -2, -2])[slot] = pd.by === slot ? -1 : pd.by;
}

function knockOut(w: World, d: Data, p: Body, by: number) {
  if (!p.alive) return;
  d.hp[p.slot] = Math.max(0, d.hp[p.slot]);
  p.alive = false;
  d.elim[p.slot] = w.tick;
  const humans = d.humanSlots;
  if (humans !== undefined && !players(w).some((other) => other.alive && !other.fall && (humans & (1 << other.slot)))) {
    d.cpuOnly = true;
  }
  d.vx[p.slot] = d.vz[p.slot] = 0;
  d.eff[p.slot] = 0; d.effT[p.slot] = 0;
  if (d.lock) d.lock[p.slot] = 0;
  if (d.dying) d.dying[p.slot] = -2;
  // FUN_800c09f4 releases a carried crate through state 4.
  const h = holdingCrate(w, p.slot);
  if (h) { const s = csOf(d, h); h.cd = 0; h.dash = 1; s.s = C_DROP; s.hv = 0; s.vv = 80; s.up = false; s.t = 0; s.pitch = 0; }
  emit(w, 'ko', p.x, p.z, p.slot, 1, by);
}

function passWeight(w: World, d: Data, a: Body, b: Body) {
  // FUN_800bede8: the holder bumps b: b gets the remaining time + 10, a is cleared
  if (d.eff[a.slot] !== EFF_WEIGHT || d.pass[a.slot] > 0) return;
  if (guarded(d, b.slot)) return;
  d.eff[b.slot] = EFF_WEIGHT; d.effT[b.slot] = d.effT[a.slot] + 10; d.pass[b.slot] = PASS_LOCK;
  d.eff[a.slot] = 0; d.effT[a.slot] = 0;
  d.weight = b.slot;
  emit(w, 'weight', b.x, b.z, b.slot, 1);
  cue(w, 0x454);
}

function landedOn(w: World, d: Data, p: Body) {
  for (const c of crates(w)) {
    if (c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s || s.s !== C_IDLE) continue;
    if (dist2(p.x, p.z, c.x, c.z) >= CRATE_R * U * 0.9 || Math.abs(p.y - (c.y + CRATE_H * U)) > 1e-3) continue;
    if (c.kind === 'nitro') { s.own = p.slot; destroy(w, d, c, -1); }
    else if (c.kind === 'tnt') lightTnt(w, d, c, s);
  }
}

function lightTnt(w: World, d: Data, c: Body, s: CS) {
  if (c.fall) return;
  c.fall = true; s.fuse = FUSE; c.m = FUSE / 30;
  emit(w, 'lit', c.x, c.z, -1, 1);
  emit(w, 'beep', c.x, c.z, -1, 1);
}

// ---------- pick up / throw / spin ----------
function findPick(w: World, d: Data, p: Body): Body | null {
  const f = d.f8[p.slot];
  const cx = p.x + Math.sin(f) * PICK_REACH * U, cz = p.z + Math.cos(f) * PICK_REACH * U;
  let best: Body | null = null, bd = Infinity;
  for (const c of crates(w)) {
    if (c.kind === 'nitro' || c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s || s.s !== C_IDLE || c.y > 1e-3) continue;
    const dd = dist2(c.x, c.z, cx, cz) / U;
    if (dd >= PICK_REACH) continue;
    if (Math.abs(angDiff(f, Math.atan2(c.x - p.x, c.z - p.z))) >= PICK_CONE) continue;
    if (dd < bd) { bd = dd; best = c; }
  }
  return best;
}

function pickUp(w: World, d: Data, p: Body, c: Body) {
  const s = csOf(d, c);
  s.s = C_HELD; s.own = p.slot; c.cd = p.slot + 1; c.dash = 0;
  p.face = Math.atan2(c.x - p.x, c.z - p.z); d.f8[p.slot] = snap8(p.face);
  d.st[p.slot] = ST_PICK; d.stT[p.slot] = ctActionTicks(d.char?.[p.slot] ?? 1, 1); d.act[p.slot] = 1;
  if (c.kind === 'tnt') lightTnt(w, d, c, s);
  emit(w, 'grab', c.x, c.z, p.slot, 1);
}

function applyGrip(p: Body, c: Body, s: CS, [ax, ay, az, bx, by, bz]: number[]) {
  const heading = -Math.round(p.face * 4096 / TAU) * TAU / 4096;
  const sin = Math.round(4096 * Math.sin(heading)), cos = Math.round(4096 * Math.cos(heading));
  const x = (ax * cos + az * sin) >> 12, z = (az * cos - ax * sin) >> 12;
  if (bx === undefined) {
    c.x = p.x + x * U;
    c.y = p.y - ay * U;
    c.z = p.z - z * U;
    c.face = p.face;
    s.pitch = 0;
    return;
  }
  // Rotate each hand in fixed point before deriving the midpoint, yaw and tilt.
  const dx = x - ((bx * cos + bz * sin) >> 12), dz = z - ((bz * cos - bx * sin) >> 12);
  const tilt = atan2g(ps1SqrtQ6(dx * dx + dz * dz) >> 6, by - ay);
  const vertical = Math.round(4096 * Math.cos((tilt + 399) * TAU / 4096)) >> 5;
  c.x = p.x + (x - Math.trunc(dx / 2)) * U;
  c.y = p.y - (by - vertical) * U;
  c.z = p.z - (z - Math.trunc(dz / 2)) * U;
  c.face = (512 - atan2g(dx, dz)) * TAU / 4096;
  s.pitch = (625 - tilt) * TAU / 4096;
}

function throwCrate(w: World, d: Data, p: Body, c: Body) {
  const s = csOf(d, c);
  const f = d.f8[p.slot];
  c.cd = 0; c.dash = 1;
  const index = (d.char?.[p.slot] ?? 1) - 1;
  const [speed, , , rise] = THROWS[index];
  applyGrip(p, c, s, CRATE_GRIPS[index][3][ACTIONS[index][3] + 1]);
  s.releasedAt = w.tick;
  s.s = C_THROWN; s.own = p.slot; s.hv = speed; s.vv = rise; s.up = rise > 0; s.dx = Math.sin(f); s.dz = Math.cos(f); s.t = 0;
  // The crate samples the release pose before its first airborne update.
  c.face = f; s.pitch = 0;
  emit(w, 'throw', p.x, p.z, p.slot, 1);
}

/** the spin attack, each tick (FUN_80088794): a player in reach takes 1 HP and is knocked back 48/tick, crates in reach are kicked away */
function spinHit(w: World, d: Data, p: Body) {
  const slot = p.slot;
  const char = d.char?.[slot] ?? 1;
  if (char <= 2) p.face += TAU * 0x155 / 4096;
  const forwardAttack = char === 3 || char === 4;
  // The pose contributes the attack cylinder, including its forward reach.
  const frame = ctActionTicks(char, 3) - d.stT[slot] - 1;
  const hit = attackHull(char, frame, p.face);
  const cx = p.x + hit.x*U, cz = p.z + hit.z*U;
  const bottom = p.y + hit.bottom*U, top = p.y + hit.top*U;
  for (const o of players(w)) {
    if (o === p || !o.alive || !bodyOverlapsHeight(d, o, bottom, top)) continue;
    if (dist2(o.x, o.z, cx, cz) >= hit.radius*U + o.r) continue;
    const ang = Math.atan2(o.x - p.x, o.z - p.z);
    if (!guarded(d, o.slot) && (!forwardAttack || Math.abs(angDiff(p.face, ang)) < Math.PI / 4)) {
      const push = forwardAttack ? p.face : ang;
      queueDamage(d, o.slot, SPIN_DMG, 0, slot, Math.sin(push), Math.cos(push), SPIN_KNOCK, 0x446);
    }
    break; // FUN_800864cc returns the first intersecting player.
  }
  for (const c of crates(w)) {
    if (c.cd !== 0 || c.y >= top || c.y + CRATE_H*U <= bottom) continue;
    const s = d.cs[c.id];
    if (!s || (s.s !== C_IDLE && s.s !== C_SLIDE)) continue;
    if (dist2(c.x, c.z, cx, cz) >= (hit.radius + 128) * U) continue;
    const direction = Math.atan2(c.x - p.x, c.z - p.z);
    if (char >= 3 && char <= 6 && Math.abs(angDiff(p.face, direction)) >= PICK_CONE) continue;
    kickCrate(w, d, c, s, slot, direction);
    return; // FUN_800c159c signals one object.
  }
  const g = w.bodies.find((b) => b.kind === 'penguin');
  if (g && bottom < g.y + PENGUIN_H * U && dist2(g.x, g.z, cx, cz) < (hit.radius + PENGUIN_BODY) * U) hitPenguin(d);
}

/** the crate was hit (flag 2): it slides away along one of 8 directions; nitro goes off, tnt is lit */
function kickCrate(w: World, d: Data, c: Body, s: CS, by: number, ang: number, kickChar = d.char?.[by] ?? 1) {
  if (c.kind === 'chest') {
    s.s = CT_CHEST_REVEAL; s.t = -3; s.homing = true; s.own = by; s.hv = 0;
    c.face = snap8(ang);
    return;
  }
  if (c.kind === 'nitro') { s.own = by; destroy(w, d, c, -1); return; }
  const a = snap8(ang);
  // FUN_800bc038: the kicker's id from 0x8009e2b4, then state 9 plays 0x3f9 (wood, lit TNT) or lights the TNT (0x3f0).
  if (by >= 0 && by < 4) cue(w, 0x442 + by, c.x, c.z, true, c.y);
  const lit = c.kind === 'tnt' && c.fall;
  s.s = C_SLIDE; s.own = by; s.kc = kickChar; s.hv = longKick(kickChar) ? 112 : 80; s.dx = Math.sin(a); s.dz = Math.cos(a); s.kt = 2; s.t = 0;
  c.dash = 2;
  if (c.kind === 'tnt' && !lit) lightTnt(w, d, c, s);
  else cue(w, 0x3f9, c.x, c.z, true, c.y);
}

// ---------- crates ----------
// FUN_800bc038 moves unsupported resting and rolling crates to a vertical descent.
function startCrateFall(c: Body, s: CS, speed: number) {
  s.s = C_FALL;
  s.vv = speed;
  c.dash = 1;
}

function stepCrate(w: World, d: Data, c: Body) {
  const s = csOf(d, c);
  // lit TNT keeps burning (also in your hands); beeps every 30 ticks
  if (c.kind === 'tnt' && c.fall && s.s !== C_DELAY) {
    // FUN_800bc038 beeps when the decremented fuse reaches 60, 30 and 0, and explodes on the next update.
    if (s.fuse <= 0) { destroy(w, d, c, -1); return; }
    s.fuse--;
    c.m = Math.max(0, s.fuse / 30);
    if (s.fuse % 30 === 0) emit(w, 'beep', c.x, c.z, -1, 1);
  }
  switch (s.s) {
    case CT_CHEST_REVEAL:
      stepChestReveal(w, d, c, s);
      return;
    case CT_CHEST_SHRINK:
      if (--s.t <= 0) { c.alive = false; delete d.cs[c.id]; }
      return;
    case C_DROP: {
      if (s.t++ === 0) return;
      c.y -= s.vv * U;
      const ground = groundAt(w, d, c.x, c.z, c);
      if (c.y <= ground) { c.y = ground; impact(w, d, c, s); }
      else if (c.y < -SPACE_OBJECT_CULL * U) { c.alive = false; delete d.cs[c.id]; }
      return;
    }
    case C_GROW:
      if (--s.t <= 0) s.s = C_IDLE;
      return;
    case C_DELAY:
      if (--s.t <= 0) destroy(w, d, c, -1);
      return;
    case C_HELD: {
      const p = players(w).find((q) => q.slot === c.cd - 1);
      if (!p || !p.alive) { c.cd = 0; s.s = C_IDLE; c.y = p ? p.y : 0; return; }
      const slot = p.slot, char = d.char?.[slot] ?? 1;
      const action = d.act[slot];
      const walking = s.walking ?? Math.hypot(p.vx, p.vz) > 0.7;
      const script = action === 1 ? 15 : action === 2 ? 18 : walking ? 17 : 16;
      const track = CRATE_GRIPS[char-1][script-15];
      const frozen = d.eff[slot] === EFF_SLOW && (w.tick & 1) !== 0 && s.gripScript === script;
      let frame = action === 1 || action === 2 ? ctActionTicks(char, action) - d.stT[slot]
        : s.gripScript === script ? (s.gripFrame ?? 0) + (frozen ? 0 : 1) : 0;
      if (frame >= track.length-1) frame = track[0][0] < 0 ? track.length-2 : track[0][0];
      if (script === 17 && !frozen) {
        const [left, right] = CARRY_STEPS[char - 1];
        if (frame === left || frame === right) emit(w, 'carryStep', p.x, p.z, slot, frame === left ? 0 : 1);
      }
      s.gripScript = script; s.gripFrame = frame;
      if (script !== 15 || frame !== 0) applyGrip(p, c, s, track[frame + 1]);
      return;
    }
    case C_THROWN: {
      if (s.releasedAt === w.tick) return;
      s.t++;
      const [, max, drag, , gravity] = THROWS[(d.char?.[s.own] ?? 1) - 1];
      s.hv = Math.min(max, Math.max(0, s.hv - drag));
      // The disc subtracts each signed 4.12 component after shifting, before converting its Z axis.
      c.x -= ((Math.round(-4096 * s.dx) * s.hv) >> 12) * U;
      c.z += ((Math.round(4096 * s.dz) * s.hv) >> 12) * U;
      if (s.up) { s.vv -= gravity; if (s.vv <= 0) { s.vv = 0; s.up = false; } else c.y += s.vv * U; }
      else { s.vv = Math.min(80, s.vv + gravity); c.y -= s.vv * U; }
      if (c.kind !== 'chest') c.face += 0.25;
      const hitWall = c.kind !== 'chest' && clampCrate(c);
      const hole = !floorAt(d, c.x, c.z);
      const surface = s.up ? -Infinity : crateFlightSurface(w, d, c, c.x, c.y, c.z);
      const landed = !s.up && c.y <= surface;
      if (landed) c.y = surface;
      if (hole && c.y < -SPACE_OBJECT_CULL * U) { c.alive = false; delete d.cs[c.id]; return; }
      if (landed && c.kind === 'chest') s.hv >>= 1;
      if (hitWall || landed || strike(w, d, c, s) || !hole && s.hv <= 0 && s.t > 40) impact(w, d, c, s);
      return;
    }
    case C_SLIDE: {
      s.t++;
      if (s.kt > 0) s.kt--;
      s.hv = Math.max(0, s.hv - (d.variant === 'snow' ? 2 : longKick(s.kc ?? d.char?.[s.own] ?? 1) ? 4 : 3));
      c.x += s.dx * s.hv * U; c.z += s.dz * s.hv * U;
      c.face += 0.1;
      const hitWall = clampCrate(c);
      const hitSomething = s.kt <= 0 && strike(w, d, c, s);
      if (hitSomething) { impact(w, d, c, s); return; }
      if (hitWall) { if (c.kind === 'crate') { impact(w, d, c, s); return; } s.hv = 0; }
      if (!floorAt(d, c.x, c.z)) {
        c.x = (Math.floor(c.x / U / 256) * 256 + 128) * U;
        c.z = -(Math.floor(-c.z / U / 256) * 256 + 128) * U;
        startCrateFall(c, s, 0);
        return;
      }
      if (s.hv <= 0) { s.s = C_IDLE; c.dash = 0; }
      return;
    }
    case C_FALL:
      s.vv = Math.min(80, s.vv + 6);
      c.y -= s.vv * U;
      if (c.y < -SPACE_OBJECT_CULL * U) { c.alive = false; delete d.cs[c.id]; }
      return;
    default:
      if (!floorAt(d, c.x, c.z)) startCrateFall(c, s, 80);
  }
}

function clampCrate(c: Body): boolean {
  const lim = ARENA * U;
  let hit = false;
  if (c.x > lim) { c.x = lim; hit = true; } else if (c.x < -lim) { c.x = -lim; hit = true; }
  if (c.z > lim) { c.z = lim; hit = true; } else if (c.z < -lim) { c.z = -lim; hit = true; }
  return hit;
}

/** FUN_800bf404: a moving crate (shape radius 128) against players, then the collidable objects. */
function strike(w: World, d: Data, c: Body, s: CS): boolean {
  for (const p of players(w)) {
    if (!p.alive || p.slot === s.own) continue;
    if (!bodyOverlapsHeight(d, p, c.y, c.y + CRATE_H * U)) continue;
    if (dist2(p.x, p.z, c.x, c.z) < p.r + 128 * U) return true;
  }
  for (const o of crates(w)) {
    if (o === c || o.cd !== 0) continue;
    const os = d.cs[o.id];
    if (!os || os.s !== C_IDLE) continue;
    if (Math.abs(o.y - c.y) >= CRATE_H * U) continue;
    if (dist2(o.x, o.z, c.x, c.z) < 256 * U) {
      // The struck crate gets flag 8 or 2 without an owner: nitro explodes, TNT lights, wood stays put.
      if (o.kind === 'nitro') destroy(w, d, o, -1);
      else if (o.kind === 'tnt') lightTnt(w, d, o, os);
      return true;
    }
  }
  const g = w.bodies.find((b) => b.kind === 'penguin');
  if (g && c.y < g.y + PENGUIN_H * U && dist2(g.x, g.z, c.x, c.z) < (PENGUIN_BODY + 128) * U) {
    hitPenguin(d);
    return true;
  }
  return false;
}

/** thrown / kicked crate broke: wood breaks, TNT and nitro explode; the player who threw it is spared */
function impact(w: World, d: Data, c: Body, s: CS) {
  const own = s.own;
  if (c.kind === 'chest') {
    emit(w, 'chestBreak', c.x, c.z, own);
    if (outsideChestArena(c)) { c.alive = false; delete d.cs[c.id]; return; }
    s.s = CT_CHEST_REVEAL; s.t = -1; s.homing = false;
    c.cd = 0; c.dash = 0;
    return;
  }
  destroy(w, d, c, own);
}

// ---------- pickups ----------
function stepPickup(w: World, d: Data, o: Body, live: Body[]) {
  if (!floorAt(d, o.x, o.z)) {
    o.vy = Math.min(80, o.vy + 6);
    o.y -= o.vy * U;
    if (o.y < -SPACE_OBJECT_CULL * U) o.alive = false;
    return;
  }
  if (o.y > 0) { // falling from the sky: accel 6 per tick up to 80 (state 4 table)
    o.vy = Math.min(80, o.vy + 6);
    o.y = Math.max(0, o.y - o.vy * U);
    if (o.y <= 0) {
      o.vy = 0;
      if (o.kind !== 'fruit') cue(w, 0x420, o.x, o.z, true); // FUN_800be9d0 landing from state 4
    }
    return;
  }
  if (o.kind === 'fruit') o.cd++; // grounded bounce clock, floor Wumpa persist until collected
  else if (--o.dash <= 0) { o.alive = false; return; }
  for (const p of live) {
    if (!p.alive || p.y > 700 * U) continue;
    if (dist2(p.x, p.z, o.x, o.z) >= p.r + CRATE_R * U) continue;
    collect(w, d, o, p);
    return;
  }
}

function collect(w: World, d: Data, o: Body, p: Body) {
  const slot = p.slot;
  o.alive = false;
  switch (o.kind) {
    case 'fruit': d.hp[slot] = Math.min(CT_HP, d.hp[slot] + 1); emit(w, 'pickup', o.x, o.z, slot, 1); break;
    case 'boots': d.eff[slot] = EFF_BOOTS; d.effT[slot] = BOOTS_T; emit(w, 'pickup', o.x, o.z, slot, 2); break;
    case 'potion': d.eff[slot] = EFF_SLOW; d.effT[slot] = SLOW_T; emit(w, 'pickup', o.x, o.z, slot, 3); break;
    case 'mask': // FUN_800be9d0 also clears the pending damage
      d.eff[slot] = EFF_AKU; d.effT[slot] = MASK_T; d.pend[slot].dmg = 0; emit(w, 'pickup', o.x, o.z, slot, 4); break;
    case 'weight': d.eff[slot] = EFF_WEIGHT; d.effT[slot] = WEIGHT_T; d.weight = slot; d.pass[slot] = 0; emit(w, 'pickup', o.x, o.z, slot, 5); break;
    case 'weapon': awardChest(w, d, p, o.slot, o); break; // older snapshots with loose weapons
  }
}

function awardChest(w: World, d: Data, p: Body, item: number, at: Body) {
  const slot = p.slot;
  if (!item) {
    d.hp[slot] = Math.min(CT_HP, d.hp[slot] + 1);
    emit(w, 'pickup', at.x, at.z, slot, 1);
    return;
  }
  d.weapon[slot] = item === W_MISSILE ? 2 : item === W_ORB ? 1 : 3;
  d.ammo[slot] = item === W_MISSILE ? 2 : item === W_ORB ? 3 : 1;
  emit(w, 'pickup', at.x, at.z, slot, 5 + d.weapon[slot]);
  for (const chest of crates(w)) {
    const state = d.cs[chest.id];
    if (chest.kind === 'chest' && state?.s === C_IDLE) {
      state.s = CT_CHEST_SHRINK;
      state.t = 8;
    }
  }
  d.tPower = (Math.floor(rand(w) * 6) + 2) * 30;
}

// ---------- Drain Bash weapons ----------
interface DrainShot { born: number; angle: number; speed: number; fall: number; target: number }

/** The five 4.12 scale triples from 0x800c3b08 (FUN_800ba780). */
export const CT_WEAPON_BLAST = [[20480, 20480, 20480], [16384, 8192, 16384], [6144, 4096, 6144],
  [2048, 2560, 2048], [512, 512, 512]];
export const CT_RING_COUNT = 7;
export const CT_RING_GAP = 5;
export const CT_RING_TICKS = 13;
export const ctRingScale = (age: number) => 4096 + (age + 1) * 1280;
const nativeHeading = (a: number) => Math.round(-a * 4096 / TAU) & 4095;
const fromHeading = (a: number) => -a * TAU / 4096;
const shotAngleDiff = (a: number, b: number) => ((a - b + 2048) & 4095) - 2048;

function newShot(w: World, d: Data, p: Body, kind: string, radius: number, angle = 0, target = -1) {
  const b = addBody(w, kind, p.slot, p.x, p.z, radius * U, 1);
  b.y = p.y;
  b.face = fromHeading(angle);
  b.cd = -1; // view age, starts with the first object update
  (d.shots ??= {})[b.id] = { born: w.tick, angle, speed: 32, fall: 0, target };
  return b;
}

function fireWeapon(w: World, d: Data, p: Body) {
  const slot = p.slot, weapon = d.weapon[slot];
  d.ammo[slot]--;
  d.wcd[slot] = weapon === 3 ? 40 : 20;
  if (d.ammo[slot] <= 0) d.weapon[slot] = 0;
  const face = nativeHeading(d.f8[slot]);
  if (weapon === 1) {
    // FUN_800b9dd8 chooses the smallest deviation from the launch heading once.
    let target = -1, best = 2048;
    for (const rival of players(w)) {
      if (rival.slot === slot) continue;
      const aim = nativeHeading(Math.atan2(rival.x - p.x, rival.z - p.z));
      const off = Math.abs(shotAngleDiff(face, aim));
      if (off < best) { best = off; target = rival.slot; }
    }
    newShot(w, d, p, 'orb', 128, face, target).y += 384 * U;
  } else if (weapon === 2) {
    for (let i = 0; i < 8; i++) newShot(w, d, p, 'rocket', 32, (face + i * 512) & 4095).y += 224 * U;
  } else newShot(w, d, p, 'ring', 0);
  emit(w, 'weapon', p.x, p.z, slot, weapon);
}

/** FUN_800b97a8 probes the hulls. A touched crate is kicked and takes precedence over the player contact. */
function weaponContact(w: World, d: Data, live: Body[], shot: Body, radius: number): Body | undefined {
  let hit: Body | undefined;
  for (const p of live) {
    if (!p.alive || p.slot === shot.slot || !bodyOverlapsHeight(d, p, shot.y - radius, shot.y + radius)) continue;
    if (dist2(p.x, p.z, shot.x, shot.z) < p.r + radius) hit = p;
  }
  for (const c of crates(w)) {
    const crate = d.cs[c.id];
    if (!crate || c.cd || crate.s !== C_IDLE || shot.y - radius >= c.y + CRATE_H * U || shot.y + radius <= c.y) continue;
    if (dist2(c.x, c.z, shot.x, shot.z) >= c.r + radius) continue;
    const owner = live.find((p) => p.slot === shot.slot);
    const a = owner ? Math.atan2(c.x - owner.x, c.z - owner.z) : shot.face;
    kickCrate(w, d, c, crate, shot.slot, a);
    hit = undefined;
  }
  return hit;
}

function weaponBlast(w: World, d: Data, b: Body, floor: boolean) {
  const flash = newShot(w, d, b, 'weaponBlast', BLAST_R);
  flash.y = (floor ? 0 : b.y) + 128 * U;
  const audible = b.kind === 'orb' || rand(w) < 0.25;
  emit(w, 'weaponBlast', b.x, b.z, b.slot, 1, audible ? Math.floor(rand(w) * 4) : -1);
  b.alive = false;
}

function damageWeaponBlast(d: Data, live: Body[], blast: Body) {
  for (const p of live) {
    if (!p.alive || p.slot === blast.slot) continue;
    const distance = Math.floor(dist2(p.x, p.z, blast.x, blast.z) / U);
    if (distance >= BLAST_R) continue;
    const angle = distance < 128 ? d.f8[p.slot] : Math.atan2(p.x - blast.x, p.z - blast.z);
    queueDamage(d, p.slot, DMG_BIG, 2, blast.slot, Math.sin(angle), Math.cos(angle), (BLAST_R - distance) >> 3);
  }
}

function moveWeaponShot(b: Body, s: DrainShot) {
  s.speed = Math.min(160, s.speed + 8);
  const heading = fromHeading(s.angle);
  const dx = -((s.speed * Math.round(-Math.sin(heading) * 4096)) >> 12);
  const dz = (s.speed * Math.round(Math.cos(heading) * 4096)) >> 12;
  b.x += dx * U;
  b.z += dz * U;
  b.vx = dx * U * 30;
  b.vz = dz * U * 30;
  b.face = heading;
}

/** FUN_800ba488 updates the pulse visuals, then checks the combined radius once at the previous origin. */
function stepWeaponRing(w: World, d: Data, live: Body[], b: Body) {
  const age = b.cd;
  let scale = 0;
  for (let i = 0; i < CT_RING_COUNT; i++) {
    const pulse = age - i * CT_RING_GAP;
    if (pulse >= 0 && pulse < CT_RING_TICKS) scale = Math.max(scale, ctRingScale(pulse));
  }
  const probe = { ...b, y: b.y + 256 * U };
  const victim = weaponContact(w, d, live, probe, (64 + (scale >> 5)) * U);
  if (victim && !guarded(d, victim.slot)) {
    const a = Math.atan2(victim.x - b.x, victim.z - b.z);
    queueDamage(d, victim.slot, 8, 0, b.slot, Math.sin(a), Math.cos(a), 48, 0x446);
    emit(w, 'weaponHit', victim.x, victim.z, victim.slot, 3, b.slot);
  }
  const owner = live.find((p) => p.slot === b.slot);
  if (owner) { b.x = owner.x; b.y = owner.y; b.z = owner.z; }
  if (scale === 0) b.alive = false;
}

function stepShots(w: World, d: Data, live: Body[]) {
  if (!d.shots) return;
  for (const b of w.bodies.slice()) {
    const shot = d.shots[b.id];
    if (!shot || !b.alive || shot.born === w.tick) continue;
    b.cd++;
    switch (b.kind) {
      case 'weaponBlast':
        if (b.cd >= CT_WEAPON_BLAST.length) b.alive = false;
        else if (b.cd === 1) damageWeaponBlast(d, live, b);
        break;
      case 'ring':
        stepWeaponRing(w, d, live, b);
        break;
      case 'rocket': {
        moveWeaponShot(b, shot);
        shot.fall = Math.min(128, shot.fall + 1);
        b.y -= shot.fall * U;
        b.vy = -shot.fall * U * 30;
        if (b.y <= 0) weaponBlast(w, d, b, true);
        const hit = weaponContact(w, d, live, b, b.r);
        if (hit) weaponBlast(w, d, b, true);
        break;
      }
      case 'orb': {
        const target = w.bodies.find((p) => p.kind === 'player' && p.slot === shot.target);
        if (target) {
          const aim = nativeHeading(Math.atan2(target.x - b.x, target.z - b.z));
          const diff = shotAngleDiff(shot.angle, aim);
          shot.angle = (shot.angle + (Math.abs(diff) < 64 ? diff < 0 ? 64 : -64 : -(diff >> 3))) & 4095;
          if (dist2(target.x, target.z, b.x, b.z) < 512 * U) b.y += ((Math.round((target.y - b.y) / U) + 160) >> 2) * U;
        }
        moveWeaponShot(b, shot);
        if (b.y <= 0 || b.cd === 100) weaponBlast(w, d, b, true);
        const hit = weaponContact(w, d, live, b, b.r);
        if (hit) weaponBlast(w, d, b, false);
        if (Math.max(Math.abs(b.x), Math.abs(b.z)) > 4096 * U) b.alive = false;
        break;
      }
    }
    if (!b.alive) delete d.shots[b.id];
  }
}

// ---------- snow bash penguin ----------
// FUN_800b879c / 800b8c9c: the penguin sleeps at the center until struck, wakes, then slides an orbit of
// radius min(0x500, 3/8 sin t) for 512 updates while its 0x400 marker hits players and shoves crates.
function stepPenguin(w: World, d: Data, live: Body[]) {
  const g = w.bodies.find((b) => b.kind === 'penguin');
  const pg = d.peng;
  if (!g || !pg) return;
  switch (pg.s) {
    case 1:
      if (pg.hit) {
        pg.s = 2; pg.e = 1; pg.f = 0;
        cue(w, 0x426);
        // The wake cancels a running fruit burst and delays the next by 600 updates.
        d.tBurstN = 0; d.tBurst += 600;
        emit(w, 'penguinWake', g.x, g.z, -1, 1);
        break;
      }
      pg.f++;
      if (pg.e === 2) {
        if (pg.f === 14) cue(w, 0x425);
        if (pg.f >= CT_PENGUIN_RETURN) { pg.e = 0; pg.f = 0; }
      } else if (pg.f % CT_PENGUIN_LOOP === 38) cue(w, 0x424);
      break;
    case 2:
      if (++pg.f === 26) cue(w, 0x428);
      if (pg.f >= CT_PENGUIN_WAKE) { pg.s = 3; pg.t = 0x800; }
      break;
    case 3: {
      if (pg.t < 1) {
        pg.s = 1; pg.e = 2; pg.f = 0;
        g.x = 0; g.z = 0; g.face = -0xe3 * TAU / 4096;
        break;
      }
      const r = Math.min(0x500, (sin12(pg.t) * 3) >> 3);
      pg.t -= 4;
      pg.a = (pg.a + ((0x500 - Math.abs(r)) >> 6) + 0x28) & 0xfff;
      g.x = ((r * sin12(pg.a)) >> 12) * U;
      g.z = -((r * cos12(pg.a)) >> 12) * U;
      penguinContacts(w, d, live, g);
      g.face -= 0x1c7 * TAU / 4096;
      break;
    }
  }
  pg.hit = false;
  d.penguin = pg.s === 3 ? 1 : 0;
}

function penguinContacts(w: World, d: Data, live: Body[], g: Body) {
  for (const p of live) {
    if (!p.alive || p.fall || !bodyOverlapsHeight(d, p, g.y, g.y + 630 * U)) continue;
    const dd = dist2(p.x, p.z, g.x, g.z);
    if (dd >= p.r + PENGUIN_REACH * U) continue;
    const nx = dd > 1e-9 ? (p.x - g.x) / dd : 0, nz = dd > 1e-9 ? (p.z - g.z) / dd : 1;
    queueDamage(d, p.slot, 5, 0, -1, nx, nz, 96, 0x446); // 0x8005: 5 HP, knock 0x60
    emit(w, 'penguinHit', p.x, p.z, p.slot, 1);
  }
  for (const c of crates(w)) {
    if (c.y >= g.y + 630 * U || c.y + CRATE_H * U <= g.y) continue;
    const dd = dist2(c.x, c.z, g.x, g.z), m = (PENGUIN_REACH + 128) * U;
    if (dd >= m) continue;
    const s = d.cs[c.id];
    if (!s) continue;
    if (c.cd) { destroy(w, d, c, -1); continue; } // a carried crate breaks in its holder's hands
    if (dd > 1e-9) { c.x += (c.x - g.x) / dd * (m - dd); c.z += (c.z - g.z) / dd * (m - dd); }
    // Owner 6 kicks along the bearing from the arena center with slot 0's kick row.
    if (c.kind === 'nitro') destroy(w, d, c, -1);
    else if (s.s === C_IDLE || s.s === C_SLIDE) kickCrate(w, d, c, s, -1, Math.atan2(c.x, c.z), d.char[0]);
  }
}

// ---------- AI (FUN_800b4ab0) ----------
// The CPU works in game units and 12-bit angles. Game X is world X and game Z is minus world Z. FUN_8001463c(dx, dz)
// gives the bearing a with (sin a, cos a) along (dx, dz). The motion yaw at +0x14 and the facing at +0x18 are that
// bearing plus 0x800.

/** The controller block at 0x8009d54c. */
export interface CrushBot {
  /** +0x20 route state and +0x22 the state FUN_800b6138 interrupted */
  state: number; saved: number;
  /** +0x0c object id (0 = none) and +0x10 target: -1 none, 0..3 a slot, 6 the penguin, 7..15 a station */
  obj: number; tgt: number;
  /** +0x24 back-off, +0x26 taunt cooldown, +0x30 and +0x32 general timers */
  t24: number; t26: number; t30: number; t32: number;
  /** +0x2a pad heading and motion yaw +0x14 (-1 until the first update reads the player's facing) */
  heading: number; yaw14: number;
  /** pad bits FUN_80013c94 wrote, and whether they held a direction */
  pad: number; dir: boolean;
}

const newCrushBot = (): CrushBot => ({ state: 1, saved: 0, obj: 0, tgt: -1, t24: 0, t26: 0, t30: 0, t32: 0, heading: 0, yaw14: -1, pad: 0, dir: false });

/** Party skill rows at 0x800c302c / 30a0 / 3114 / 3188 (Easy, Normal, Hard). */
const CRUSH_SKILLS: Record<string, number[]> = {
  jungle: [1, 16, 32], space: [1, 16, 32], snow: [1, 16, 32], drain: [1, 16, 28],
};
const CRUSH_LEVEL: Record<string, number> = { jungle: 0, space: 1, snow: 2, drain: 3 }; // DAT_8005a648
const STANDOFF = [0x500, 0x400, 0x400, 0x600]; // 0x800c39f0, by slot
const FRUIT_INTEREST = [100, 20, 15, 10, 8, 5, 4, 3, 3, 2, 2, 1, 1, 1, 0, 0, -1, -2, -4, -8, -10]; // 0x800c3ac4
/** Station IDs 7..15 at 0x800c3a58, in game coordinates. */
const CRUSH_STATIONS: [number, number][] = [[0, 0], [-1920, -1920], [0, -1920], [1920, -1920], [-1920, 0], [1920, 0],
  [-1920, 1920], [0, 1920], [1920, 1920]];
const PAD_L2 = 0x100, PAD_R2 = 0x200, PAD_TRIANGLE = 0x1000, PAD_CIRCLE = 0x2000, PAD_CROSS = 0x4000, PAD_SQUARE = 0x8000;

const gameX = (b: { x: number }) => Math.round(b.x / U);
const gameZ = (b: { z: number }) => Math.round(-b.z / U);
/** Game yaw (+0x18 convention) of a web movement heading. */
const yawOf = (heading: number) => -Math.round(heading * 4096 / TAU) & 0xfff;
/** FUN_80015480 */
const angleGap = (a: number, b: number) => { const u = (b - a) & 0xfff; return u > 0x800 ? 0x1000 - u : u; };
const rawDist = (d2: number) => ps1SqrtQ6(d2) >> 6;

interface CrushPass {
  w: World; d: Data; level: number;
  /** Players by slot. Eliminated players keep their last position. */
  ps: (Body | undefined)[];
  cpu: CrushBot[]; skill: number[]; weight: number[];
  /** FUN_80015590's state for the CPU slots. Human slots plan on a copy. */
  random: [number, number];
  grid: Uint8Array;
  objects: Body[];
  focus: number;
}

interface CrushPad { bits: number; heading?: number; clearCircle?: boolean }

const inPlay = (p?: Body): p is Body => !!p && p.alive;
const isCpuSlot = (d: Data, slot: number) => d.humanSlots !== undefined && !(d.humanSlots & (1 << slot));

/** The object kind at +0x14 of the object's state block. */
function crushKind(d: Data, b: Body): number {
  switch (b.kind) {
    case 'crate': return CFG[d.variant]?.spawnWood ?? 4;
    case 'tnt': return b.fall ? 7 : 5;
    case 'nitro': return 6;
    case 'chest': { const s = d.cs[b.id]; return s?.s === CT_CHEST_REVEAL ? s.item || 0x11 : 2; }
    case 'fruit': return 0x11;
    case 'mask': return EFF_AKU;
    case 'boots': return EFF_BOOTS;
    case 'weight': return EFF_WEIGHT;
    case 'potion': return EFF_SLOW;
    case 'weapon': return b.slot;
    case 'penguin': return 0xe;
  }
  return 0;
}

/** State +0x1a reads 1 for a resting crate or a sleeping penguin. */
function crushResting(d: Data, b: Body): boolean {
  if (b.kind === 'penguin') return d.peng?.s === 1;
  if (b.kind === 'chest' && d.cs[b.id]?.s === CT_CHEST_REVEAL) return true; // the reward rising out of an opened chest
  if (isCrate(b)) return b.cd === 0 && d.cs[b.id]?.s === C_IDLE;
  return true;
}

/** The power at 0x8009d584: a Drain weapon while it has ammunition, otherwise the effect. */
function crushPower(d: Data, slot: number): number {
  if (d.ammo[slot] > 0) return d.weapon[slot] === 2 ? W_MISSILE : d.weapon[slot] === 1 ? W_ORB : W_RING;
  return d.eff[slot] ?? 0;
}

/** Player state 0x8009d558 as the controller reads it: 0 idle, 2 taunt, 3 walk, 0xd hurt, 0xf/0x10 carry, 0x13 out. */
function crushPlayerState(w: World, d: Data, slot: number, bot: CrushBot): number {
  if (d.st[slot] === ST_HURT) return (d.dying?.[slot] ?? -2) !== -2 ? 0x13 : 0xd;
  if (d.st[slot] === ST_PICK) return 0xe;
  if (d.st[slot] === ST_THROW) return 0x11;
  if (d.st[slot] === ST_SPIN) return 0xa;
  if (d.air[slot]) return d.jh[slot] ? 4 : 5;
  if ((d.tauntAt?.[slot] ?? -1) >= 0) return 2;
  const walking = bot.dir && !(d.lock?.[slot]);
  if (holdingCrate(w, slot)) return walking ? 0x10 : 0xf;
  return walking ? 3 : 0;
}

/** FUN_800b432c builds the 20x20 cell grid at 0x8009d90c: FUN_80086f78, 800bb7e8, 80086d88, then the stage layer. */
function crushGrid(d: Data, ps: (Body | undefined)[], objects: Body[]): Uint8Array {
  const grid = new Uint8Array(400);
  const clamp = (n: number) => Math.max(0, Math.min(19, n));
  // The object list runs newest first, so the oldest object in a cell writes last.
  for (const o of objects) grid[clamp(9 - (gameZ(o) >> 8)) * 20 + clamp((gameX(o) >> 8) + 10)] = crushKind(d, o) & 0xff;
  ps.forEach((p, slot) => {
    if (!p) return;
    const col = (gameX(p) >> 8) + 10, row = 9 - (gameZ(p) >> 8);
    if (col < 0 || col > 19 || row < 0 || row > 19) return;
    const mark = slot << 5 | 0x80;
    for (const r of [row > 0 ? row - 1 : row, row, row < 19 ? row + 1 : row]) {
      for (const c of [col > 0 ? col - 1 : col, col, col < 19 ? col + 1 : col]) grid[r * 20 + c] |= mark;
    }
  });
  if (d.variant === 'space') { // FUN_800bad70
    for (let col = 2; col < 18; col++) for (let row = 2; row < 18; row++) {
      if (!floorAt(d, ((col - 10) * 256 + 128) * U, -((9 - row) * 256 + 128) * U)) grid[row * 20 + col] = 0xff;
    }
  } else if (d.variant === 'snow') { // FUN_800b8b00
    for (let col = 8; col < 12; col++) for (let row = 8; row < 12; row++) grid[row * 20 + col] = 0xf0;
    const g = objects.find((o) => o.kind === 'penguin');
    if (g) {
      const cols = [((gameX(g) - 0x80) >> 8) + 10, ((gameX(g) + 0x80) >> 8) + 10];
      const rows = [9 - ((gameZ(g) - 0x80) >> 8), 9 - ((gameZ(g) + 0x80) >> 8)];
      for (const c of cols) for (const r of rows) if (c >= 0 && c < 20 && r >= 0 && r < 20) grid[r * 20 + c] |= 0x40;
    }
  }
  return grid;
}

/** FUN_800b5e28 samples two lanes 120 units either side of the motion yaw, from 352 units ahead in 256-unit steps. */
function crushLanes(slot: number, me: Body, yaw: number, grid: Uint8Array): number[][] {
  const c = cos12(yaw), s = cos12(yaw + 0x400), back = cos12(yaw + 0x800);
  const sideX = (c * 15) >> 9, sideZ = (s * 15) >> 9, aheadX = (s * 11) >> 7, aheadZ = (back * 11) >> 7;
  const own = slot << 5 | 0x80;
  const lane = (x: number, z: number) => {
    const cells: number[] = [];
    while (cells.length < 8 && ((x + 0x7ff) >>> 0) < 0xfff && z < 0x800 && z > -0x800) {
      let cell = grid[(9 - (z >> 8)) * 20 + (x >> 8) + 10];
      if ((cell & 0xf0) === own) cell &= 0x1f;
      cells.push(cell);
      x += s >> 4;
      z += back >> 4;
    }
    while (cells.length < 8) cells.push(0xfe);
    return cells;
  };
  const x = gameX(me), z = gameZ(me);
  return [lane(x + sideX + aheadX, z + sideZ + aheadZ), lane(x - sideX + aheadX, z - sideZ + aheadZ)];
}

/** Nitro, lit TNT, the weight and the slow potion block a lane. */
const laneHazard = (cell: number) => { const k = cell & 0x3f; return k > 5 && (k < 8 || (k < 0x16 && k > 0x13)); };

/** FUN_800b6138 */
function crushRouteCheck(bot: CrushBot, lanes: number[][], carrying: boolean, pad: CrushPad): boolean {
  const blocked = [0, 1, 2].map((i) => {
    const [a, b] = [lanes[0][i], lanes[1][i]];
    return a === 0xff || b === 0xff || a === 0xfe || b === 0xfe || laneHazard(a) || laneHazard(b);
  });
  if (!blocked[0]) return false;
  if (carrying) { bot.state = 13; return true; }
  if (blocked[1] || blocked[2]) {
    bot.yaw14 = (bot.yaw14 + 0x31c) & 0xfff;
    bot.saved = bot.state;
    bot.state = 5;
    bot.t32 = 30;
    bot.tgt = -1;
    bot.obj = 0;
    return true;
  }
  pad.bits |= PAD_CROSS; // +0x1d holds the jump through its full rise
  return false;
}

/** FUN_800bb100 ignores the off-grid marker. */
function crushTurnBlocked(lanes: number[][]): boolean {
  return [0, 1, 2].some((i) => {
    const [a, b] = [lanes[0][i], lanes[1][i]];
    return a === 0xff || b === 0xff || laneHazard(a) || laneHazard(b);
  });
}

/** FUN_800b6fe0: nearest live opponent, or 0 when none is within 0x7fffff squared units. */
function crushNearest(ai: CrushPass, slot: number): number {
  const me = ai.ps[slot]!;
  let best = 0x7fffff;
  ai.ps.forEach((p, i) => {
    if (i === slot || !inPlay(p)) return;
    const dx = gameX(me) - gameX(p), dz = gameZ(me) - gameZ(p);
    best = Math.min(best, dx * dx + dz * dz);
  });
  return best === 0x7fffff ? 0 : rawDist(best);
}

/** FUN_800b6da4: the resting penguin on one draw in ten, else a live slot drawn by weight. */
function crushVictim(ai: CrushPass, slot: number): number {
  let total = 0;
  ai.ps.forEach((p, i) => { if (i !== slot && inPlay(p)) total += ai.weight[i]; });
  if (slot < 4 && ai.objects.some((o) => o.kind === 'penguin') && ai.d.peng?.s === 1
    && drawDiscRandom(ai.random, 10) === 0) return 6;
  if (total) {
    const pick = drawDiscRandom(ai.random, total);
    let sum = 0;
    for (let i = 0; i < ai.ps.length; i++) {
      if (i === slot || !inPlay(ai.ps[i])) continue;
      sum += ai.weight[i];
      if (pick < sum) return i;
    }
  }
  return -1;
}

/** FUN_800b46b8: flee an opponent holding the weight within 1024 units, then the running penguin within 1536. */
function crushFlee(ai: CrushPass, slot: number): number {
  const me = ai.ps[slot]!;
  for (let i = 0; i < ai.ps.length; i++) {
    const p = ai.ps[i];
    if (i === slot || !inPlay(p) || crushPower(ai.d, i) !== EFF_WEIGHT) continue;
    const dx = gameX(me) - gameX(p), dz = gameZ(me) - gameZ(p);
    if (dx * dx + dz * dz <= 0xfffff) return atan2g(dx, dz);
  }
  const g = ai.objects.find((o) => o.kind === 'penguin');
  if (!g || ai.d.peng?.s !== 3) return 0;
  const dx = gameX(g) - gameX(me), dz = gameZ(g) - gameZ(me);
  return dx * dx + dz * dz < 0x240000 ? atan2g(-dx, -dz) : 0;
}

/** FUN_800b4848 fires a Drain weapon: the ring needs a live player within 0x51000 squared, the others aim at any slot. */
function crushFire(ai: CrushPass, slot: number, heading: number, bot: CrushBot, pad: CrushPad) {
  const d = ai.d, me = ai.ps[slot]!;
  if (!(d.ammo[slot] > 0) || d.wcd[slot] > 0) return;
  let pick = -1;
  if (crushPower(d, slot) !== W_RING) {
    let best = 0x800;
    ai.ps.forEach((p, i) => {
      if (i === slot || !p) return;
      const gap = angleGap(heading, atan2g(gameX(p) - gameX(me), gameZ(p) - gameZ(me)));
      if (gap < best) { best = gap; pick = i; }
    });
  } else {
    let best = 0x51000;
    ai.ps.forEach((p, i) => {
      if (i === slot || !inPlay(p)) return;
      const dx = gameX(me) - gameX(p), dz = gameZ(me) - gameZ(p), d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; pick = i; }
    });
  }
  if (pick < 0) return;
  bot.tgt = -1;
  bot.state = 1;
  pad.bits |= PAD_SQUARE;
}

/** FUN_800864cc: the first live player whose hull overlaps ours. */
function crushContact(ai: CrushPass, slot: number): number {
  const d = ai.d, me = ai.ps[slot]!, hull = CT_HULL[d.char[slot] - 1];
  for (let i = 0; i < ai.ps.length; i++) {
    const p = ai.ps[i];
    if (i === slot || !inPlay(p)) continue;
    if (!bodyOverlapsHeight(d, p, me.y + hull[1] * U, me.y + hull[2] * U)) continue;
    if (dist2(me.x, me.z, p.x, p.z) < me.r + p.r) return i;
  }
  return -1;
}

/** FUN_800c2b60(p, 3): the first touchable object within 256 units of the point 256 units ahead. */
function crushAhead(ai: CrushPass, me: Body): Body | undefined {
  const yaw = yawOf(me.face);
  const x = gameX(me) - (cos12(yaw - 0x400) >> 4), z = gameZ(me) - (cos12(yaw) >> 4);
  return ai.objects.find((o) => {
    if (o.kind === 'chest' && ai.d.cs[o.id]?.s === CT_CHEST_SHRINK) return false;
    const dx = gameX(o) - x, dz = gameZ(o) - z;
    return dx * dx + dz * dz < 0x10000;
  });
}

/** FUN_800b62ec scores objects, opponents and roaming. Returns false when nothing qualifies. */
function crushSearch(ai: CrushPass, slot: number, bot: CrushBot): boolean {
  const { d, w } = ai;
  const me = ai.ps[slot]!;
  const skill = ai.skill[slot];
  const power = crushPower(d, slot);
  drawDiscRandom(ai.random, 0x100);
  let [close, far] = crushNearest(ai, slot) < 0x300 ? [0, 8] : [8, 0];
  let bias = drawDiscRandom(ai.random, 0x1000);
  let armed = 0;
  if (d.ammo[slot] > 0) {
    armed = 0xa0;
    [close, far] = power === W_ORB || power === W_MISSILE ? [0, 10] : [10, 0];
  }
  let crateWeight = 0x20;
  let interest = (skill - 16) * 2 | 1;
  let fruit = (FRUIT_INTEREST[Math.max(0, Math.min(20, Math.trunc(d.hp[slot])))] + (16 - skill) * 4) << 16 >> 16;
  if (power === EFF_WEIGHT) {
    armed = 0xa0; interest = 0x200; crateWeight = 0; close = 0x200; far = 0; fruit = 0;
  }
  const roamBase = (0x180 - (16 - skill) * 0x10) << 16 >> 16;
  const roamRow = [[6, 0x4000], [3, 0x2000], [4, 0x3000], [8, 0x4000]][ai.level] ?? [6, 0x4000];
  let roam = drawDiscRandom(ai.random, roamRow[0]) === 0 ? Math.imul(roamBase, fruit) + roamRow[1] : 0;
  if (bot.t30) {
    bias = drawDiscRandom(ai.random, 0x400);
    interest = 0; close = 0; far = 0;
  }
  const x = gameX(me), z = gameZ(me);
  const distTo = (o: Body) => rawDist((x - gameX(o)) ** 2 + (z - gameZ(o)) ** 2);
  let objectScore = 0, objectId = 0;
  const offer = (o: Body, value: number) => { if (objectScore < value) { objectScore = value; objectId = o.id; } };
  for (const o of ai.objects) {
    const current = bot.obj === o.id;
    const kind = crushKind(d, o);
    switch (kind) {
      case 1: case 3: case 4: case 5:
        if (crushResting(d, o)) offer(o, Math.imul(0x1000 - Math.abs(distTo(o) - bias), crateWeight + 8) >> (current ? 8 : 0));
        break;
      case 2: {
        let value = Math.abs(distTo(o) - bias) * 400;
        if (power) value >>= 8;
        offer(o, value >> (current ? 4 : 0));
        break;
      }
      case 0xe:
        if (crushResting(d, o)) {
          const dist = distTo(o), shift = current ? 8 : 0;
          offer(o, Math.imul(Math.max(0, 0x800 - dist), close + crateWeight) >> shift);
          offer(o, Math.imul(dist, far | crateWeight) >> shift);
        }
        break;
      case 0x11:
        offer(o, Math.imul(Math.max(0, 0xe00 - distTo(o)), close + fruit) >> (current ? 12 : 0));
        break;
      case 0x12: case 0x13: case W_MISSILE: case W_ORB: case W_RING:
        offer(o, Math.abs(distTo(o) - bias) * 250 >> (current ? 8 : 0));
        break;
    }
  }
  let opponentScore = 0, opponentSlot = -1;
  ai.ps.forEach((p, i) => {
    if (i === slot || !inPlay(p)) return;
    if (power !== EFF_WEIGHT) {
      const cargo = holdingCrate(w, i);
      if (!cargo) interest = 0;
      else if (ai.level === 1) interest += crushKind(d, cargo) === 7 ? 1 : 5;
      else interest += crushKind(d, cargo) === 7 ? 8 : 16;
    }
    if ((d.tauntAt?.[i] ?? -1) >= 0) interest += 0x20;
    const dist = distTo(p), share = interest << 16 >> 16, shift = bot.tgt === i ? 6 : 0;
    const near = Math.imul(Math.max(0, 0x800 - dist), close + share + armed) >> shift;
    const away = Math.imul(dist, far - share - armed) >> shift;
    if (opponentScore < near) { opponentScore = near; opponentSlot = i; }
    if (opponentScore < away) { opponentScore = away; opponentSlot = i; }
  });
  if (bot.saved === 3) opponentScore = 0;
  else if (bot.saved === 2) objectScore = 0;
  else if (bot.saved === 4) roam = 0;
  let target = -1;
  if (!(objectScore < roam) || roam <= opponentScore) {
    if (opponentScore < objectScore) { bot.obj = objectId; bot.tgt = -1; return true; }
    if (opponentScore < 0x15) return false;
    target = opponentSlot;
  } else {
    // The first station farther than 0x7fffff squared from every other slot, eliminated ones included.
    let best = 0;
    CRUSH_STATIONS.forEach(([sx, sz], i) => {
      let clear = 0x7fffff;
      ai.ps.forEach((p, j) => { if (j !== slot && p && (sx - gameX(p)) ** 2 + (sz - gameZ(p)) ** 2 < clear) clear = 0; });
      if (best < clear) { best = clear; target = i + 7; }
    });
  }
  bot.tgt = target;
  bot.obj = 0;
  return true;
}

/** FUN_800b4ab0 for one CPU slot. */
function crushController(ai: CrushPass, slot: number): CrushPad {
  const { w, d } = ai;
  const bot = ai.cpu[slot], me = ai.ps[slot];
  const pad: CrushPad = { bits: 0 };
  if (!inPlay(me)) return pad;
  if (bot.yaw14 < 0) bot.yaw14 = yawOf(me.face);
  if (bot.t30) bot.t30--;
  if (bot.t32) bot.t32--;
  if (bot.t24) bot.t24--;
  if (bot.t26) bot.t26--;
  const state = crushPlayerState(w, d, slot, bot);
  if (state === 0xd || state === 0x13) { bot.tgt = -1; bot.t32 = 5; bot.obj = 0; bot.state = 6; }
  let dist2 = 0;
  let heading = yawOf(d.f8[slot]);
  const roll = drawDiscRandom(ai.random, 0x100);
  const x = gameX(me), z = gameZ(me);
  let obj = bot.obj ? ai.objects.find((o) => o.id === bot.obj) : undefined;
  if (bot.obj) {
    if (obj && crushResting(d, obj)) {
      const dx = gameX(obj) - x, dz = gameZ(obj) - z;
      dist2 = dx * dx + dz * dz;
      heading = atan2g(dx, dz);
    } else { obj = undefined; bot.obj = 0; bot.state = 1; }
  }
  if (bot.tgt !== -1) {
    let at: [number, number] | undefined;
    if (bot.tgt < 4) {
      const p = ai.ps[bot.tgt];
      if (inPlay(p)) at = [gameX(p), gameZ(p)];
    } else if (bot.tgt === 6) {
      const g = ai.objects.find((o) => o.kind === 'penguin');
      if (g && d.peng?.s === 1) at = [gameX(g), gameZ(g)];
    } else at = CRUSH_STATIONS[bot.tgt - 7];
    if (at) {
      const dx = at[0] - x, dz = at[1] - z;
      dist2 = dx * dx + dz * dz;
      heading = atan2g(dx, dz);
    } else { bot.tgt = -1; bot.state = 1; }
  }
  const lanes = crushLanes(slot, me, bot.yaw14, ai.grid);
  const held = holdingCrate(w, slot);
  const air = d.air[slot];
  const go = (h = heading): CrushPad => { bot.heading = h & 0xfff; pad.heading = bot.heading; return pad; };
  const flee = () => { const h = crushFlee(ai, slot); if (h) heading = h; };
  const taunt = (victim: number): CrushPad => {
    bot.state = 21; bot.t32 = 4; bot.tgt = victim; bot.t26 = 300;
    pad.bits |= PAD_TRIANGLE;
    return pad;
  };
  /** The obstacle switch shared by the opponent, station and retreat routes. */
  const obstacle = (o: Body | undefined): boolean => {
    if (!o) return false;
    const kind = crushKind(d, o);
    if (kind === 3 || kind === 4 || kind === 5 || kind === 7 || kind === 0xe) pad.bits |= PAD_SQUARE;
    else if (kind < 0x11 || kind > 0x13) pad.bits |= PAD_CROSS;
    return true;
  };

  switch (bot.state) {
    case 2: {
      if (air) return go();
      if (bot.tgt !== -1) { bot.state = 3; return pad; }
      if (!obj) { bot.state = 1; return pad; }
      if (held) { bot.state = 10; return pad; }
      flee();
      if (obj.cd === slot + 1) { bot.state = 1; return pad; }
      if (crushRouteCheck(bot, lanes, false, pad)) return go();
      if (ai.level === 3) crushFire(ai, slot, heading, bot, pad);
      const touch = crushContact(ai, slot);
      if (touch !== -1 && !d.inv[touch] && !d.lock?.[touch] && drawDiscRandom(ai.random, 3) === 0) pad.bits |= PAD_SQUARE;
      const ahead = crushAhead(ai, me);
      if (!ahead) return go();
      pad.clearCircle = true;
      const kind = crushKind(d, ahead), targetKind = crushKind(d, obj);
      const sameKind = kind === targetKind;
      if (ahead === obj || sameKind) {
        if (kind === 2) pad.bits |= PAD_SQUARE;
        else if ([3, 4, 5, 0x11, 0x12, 0x13].includes(kind)) { bot.state = 1; pad.bits |= PAD_CIRCLE; }
        else if (kind === 7 || kind === 0xe) { bot.state = 1; pad.bits |= PAD_SQUARE; }
        else pad.bits |= PAD_CROSS;
      } else if ([2, 3, 4, 5, 7, 0xe].includes(kind)) { bot.state = 1; pad.bits |= PAD_SQUARE; }
      else if (kind < 0x11 || kind > 0x13) pad.bits |= PAD_CROSS;
      return go();
    }
    case 3: {
      if (air) return go();
      if (obj) { bot.state = 2; return pad; }
      if (bot.tgt === -1) { bot.state = 1; return pad; }
      if (bot.tgt > 4) { bot.state = 4; return pad; }
      flee();
      if (crushRouteCheck(bot, lanes, false, pad)) return go();
      crushFire(ai, slot, heading, bot, pad);
      const touch = crushContact(ai, slot);
      if (touch === bot.tgt) { bot.tgt = -1; bot.state = 1; pad.bits |= PAD_SQUARE; }
      else if (touch !== -1 && (holdingCrate(w, touch) || (roll & 0x10) === 0)) pad.bits |= PAD_SQUARE;
      const ahead = crushAhead(ai, me);
      if (ahead) pad.clearCircle = true;
      obstacle(ahead);
      return go();
    }
    case 4: {
      if (bot.tgt === -1) { bot.state = 1; return pad; }
      flee();
      if (crushRouteCheck(bot, lanes, false, pad)) return go();
      crushFire(ai, slot, heading, bot, pad);
      if (dist2 < 0x4000) {
        const victim = crushVictim(ai, slot);
        if (victim !== -1) return taunt(victim);
        bot.state = 1; bot.tgt = -1; bot.obj = 0;
      }
      if (crushContact(ai, slot) !== -1) { bot.tgt = -1; bot.state = 1; pad.bits |= PAD_SQUARE; }
      obstacle(crushAhead(ai, me));
      return go();
    }
    case 5: {
      if (bot.t32 === 0) { bot.tgt = -1; bot.obj = 0; bot.state = 1; return pad; }
      flee();
      if (crushRouteCheck(bot, lanes, false, pad)) return pad;
      crushFire(ai, slot, heading, bot, pad);
      if (crushContact(ai, slot) !== -1) { bot.tgt = -1; bot.state = 1; pad.bits |= PAD_SQUARE; }
      obstacle(crushAhead(ai, me));
      return go(bot.yaw14 + 0x800);
    }
    case 6:
      if (bot.t32 === 0 && state === 0) { bot.t32 = 5; bot.state = 7; }
      return pad;
    case 7:
      if (!crushTurnBlocked(lanes)) {
        if (state === 0) { bot.t26 = 0xb4; bot.t32 = 0x14; bot.tgt = -1; bot.obj = 0; bot.state = 5; }
        return pad;
      }
      pad.bits |= PAD_L2;
      return pad;
    case 10: {
      if (!held) bot.state = 1;
      const victim = crushVictim(ai, slot);
      if (victim !== -1) { bot.tgt = victim; bot.obj = 0; bot.state = 12; }
      return pad;
    }
    case 12: {
      if (bot.tgt === -1 || obj) { bot.state = 10; return pad; }
      if (!held) { bot.state = 1; bot.tgt = -1; bot.obj = 0; return pad; }
      flee();
      if (crushRouteCheck(bot, lanes, true, pad)) return go();
      if (crushContact(ai, slot) !== -1) { bot.state = 13; bot.t32 = 5; }
      if (crushAhead(ai, me)) { bot.state = 13; bot.t32 = 5; }
      if (bot.t32 !== 0) return go();
      const dist = rawDist(dist2);
      if (bot.t24 === 0) {
        const range = STANDOFF[slot] + (16 - ai.skill[slot]) * 32;
        if (range < dist) {
          if (dist < range + 0x100) { bot.state = 13; bot.t32 = 5; }
        } else if (((x + 0x780) >>> 0) < 0xf01 && z < 0x781 && z > -0x781) {
          heading = (heading + 0x800) & 0xfff;
          bot.t24 = 10;
        } else if (angleGap(atan2g(x, z), bot.yaw14) > 0x400) { bot.state = 13; bot.t32 = 5; }
      } else heading = (heading + 0x800) & 0xfff;
      if (crushKind(d, held) === 7 && (d.cs[held.id]?.fuse ?? FUSE) < drawDiscRandom(ai.random, 4)) { bot.state = 13; bot.t32 = 5; }
      return go();
    }
    case 13: {
      const facing = (yawOf(d.f8[slot]) + 0x800) & 0xfff;
      if (!(d.ammo[slot] > 0)) {
        if (!held) { bot.state = 1; bot.tgt = -1; bot.obj = 0; return pad; }
      } else if (!held) {
        if (bot.t32 !== 0) return go();
        const power = crushPower(d, slot);
        if ((power !== W_MISSILE && power !== W_ORB) || angleGap(facing, heading) < 0x155) pad.bits |= PAD_SQUARE;
        return go();
      }
      if (bot.t32 === 0 && (state === 0xf || state === 0x10) && angleGap(facing, heading) < 0x155) pad.bits |= PAD_CIRCLE;
      return go();
    }
    case 21: {
      const h = crushFlee(ai, slot);
      if (h) { bot.state = 4; return go(h); }
      if (bot.t32 !== 0) return pad;
      if (state === 2) {
        ai.ps.forEach((p, i) => {
          if (i === slot || !p || !isCpuSlot(d, i) || ai.cpu[i].tgt !== slot) return;
          if ((gameX(p) - x) ** 2 + (gameZ(p) - z) ** 2 < 0x240000) { bot.tgt = -1; bot.state = 1; }
        });
        return go();
      }
      bot.tgt = -1; bot.state = 1; pad.bits = 0;
      return pad;
    }
    default: {
      pad.bits = 0;
      if (held) bot.state = 10;
      if (state !== 0) return pad;
      if (bot.t30 === 0 && bot.t26 === 0 && ai.skill[slot] * 0x20 + 0x400 < crushNearest(ai, slot)) {
        const victim = crushVictim(ai, slot);
        if (victim !== -1) return taunt(victim);
      }
      if (ai.level === 3) crushFire(ai, slot, heading, bot, pad);
      if (bot.t32 === 0 && crushSearch(ai, slot, bot)) {
        bot.state = bot.obj ? 2 : 3;
        bot.saved = 0;
      }
      return pad;
    }
  }
}

/** FUN_800b5be0 / FUN_80013c94: the pad bits, and DAT_80051370's exact heading whenever a direction is held. */
function crushInput(pad: CrushPad): InputState {
  const input: InputState = { ...IDLE };
  if (pad.heading !== undefined) {
    input.x = sin12(pad.heading) / 4096;
    input.y = -cos12(pad.heading) / 4096;
  }
  if (pad.bits & PAD_SQUARE) input.b = true;
  if (pad.bits & PAD_CIRCLE) input.a = true;
  if (pad.bits & PAD_CROSS) input.c = true;
  if (pad.bits & PAD_TRIANGLE) input.d = true;
  if (pad.bits & PAD_L2) input.l = true;
  if (pad.bits & PAD_R2) input.r = true;
  return input;
}

/** Snapshots from before this port carry a different controller layout. */
function crushBots(d: Data): CrushBot[] {
  return [0, 1, 2, 3].map((slot) => {
    const bot = d.cpu?.[slot];
    return bot && typeof bot.state === 'number' ? bot : newCrushBot();
  });
}

function crushSkills(d: Data, levels: (number | undefined)[]): number[] {
  const row = CRUSH_SKILLS[d.variant] ?? CRUSH_SKILLS.jungle;
  return levels.map((level) => row[level ?? 2] ?? row[2]);
}

/**
 * One update of CPU control: the FUN_800b432c hook (grid, Party focus), then FUN_800b4ab0 for each slot in seat order.
 * CPU seats draw from the shared CPU stream. Human seats run the same controller on a copy of the stream so a seat that
 * drops to bot control keeps its route without changing the CPUs' draws. With commit false, everything runs on copies.
 */
function crushCpuPass(w: World, commit: boolean): InputState[] {
  const d = D(w);
  const random: [number, number] = d.cpuRandom ? [...d.cpuRandom] : discRandomState(w.rng);
  const ps = [0, 1, 2, 3].map((slot) => players(w).find((p) => p.slot === slot));
  const objects = w.bodies.filter((b) => b.alive && (isCrate(b) || isPickup(b) || b.kind === 'penguin')).reverse();
  const ai: CrushPass = {
    w, d, level: CRUSH_LEVEL[d.variant] ?? 0, ps,
    cpu: crushBots(d).map((bot) => ({ ...bot })),
    skill: [...(d.cpuSkill ?? crushSkills(d, [2, 2, 2, 2]))],
    weight: [...(d.cpuWeight ?? [16, 16, 16, 16])],
    random, grid: new Uint8Array(0), objects, focus: d.cpuFocus ?? -1,
  };
  // FUN_800b432c: once only CPUs remain, every slot gets skill 26 and weight 16, and one live slot is drawn as the
  // focus with skill 8 and weight 48. An eliminated focus is cleared and redrawn on the following update.
  if (d.cpuOnly) {
    if (ai.focus === -1) {
      ai.skill = [26, 26, 26, 26];
      ai.weight = [16, 16, 16, 16];
      const focus = crushVictim(ai, 99);
      ai.focus = focus < 0 || focus > 3 ? -1 : focus;
      if (ai.focus >= 0) { ai.weight[ai.focus] = 48; ai.skill[ai.focus] = 8; }
    } else if (!inPlay(ps[ai.focus])) ai.focus = -1;
  }
  ai.grid = crushGrid(d, ps, objects);
  const inputs = [0, 1, 2, 3].map((slot) => {
    const cpu = isCpuSlot(d, slot);
    const pass = cpu ? ai : { ...ai, random: [...ai.random] as [number, number] };
    const pad = crushController(pass, slot);
    const bot = ai.cpu[slot];
    if (inPlay(ps[slot]) && !d.lock?.[slot]) {
      if (pad.heading !== undefined) bot.yaw14 = (pad.heading + 0x800) & 0xfff;
      else if (pad.bits & PAD_L2) bot.yaw14 = (bot.yaw14 - 0x100) & 0xfff;
      else if (pad.bits & PAD_R2) bot.yaw14 = (bot.yaw14 + 0x100) & 0xfff;
    }
    bot.pad = pad.bits;
    bot.dir = pad.heading !== undefined;
    // The obstacle check clears the previous Circle bit, so a held Circle presses again.
    if (commit && cpu && pad.clearCircle) d.prevA[slot] = false;
    return crushInput(pad);
  });
  if (commit) {
    d.cpu = ai.cpu;
    d.cpuSkill = ai.skill;
    d.cpuWeight = ai.weight;
    d.cpuRandom = ai.random;
    d.cpuFocus = ai.focus < 0 ? undefined : ai.focus;
  }
  return inputs;
}

/** Polling replays the update's CPU pass on copies. It never advances world or CPU state. */
function botInput(w: World, slot: number): InputState {
  return crushCpuPass(w, false)[slot] ?? IDLE;
}
