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
import { attackHull, TAUNT_TICKS } from './onFoot';
import { CRATE_GRIPS, CT_HULL } from './crateGripData';
import { DISC_CHARACTER } from '../look';
import { addBody, emit, rand } from '../physics';
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
const BOOTS_T = 240, MASK_T = 300, WEIGHT_T = 240, SLOW_T = 240, PASS_LOCK = 30;
const FRUIT_LIFE = 150, POWER_LIFE = 120;
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

/** crate sub state */
const C_GROW = 0, C_IDLE = 1, C_HELD = 2, C_THROWN = 3, C_SLIDE = 4, C_DELAY = 5, C_OPEN = 6, C_FALL = 7, C_DROP = 8;
interface CS { gripScript?: number; gripFrame?: number; walking?: boolean; pitch?: number; s: number; t: number; hv: number; vv: number; up: boolean; dx: number; dz: number; own: number; fuse: number; kt: number; item: number }

interface Data {
  char: number[];
  cpu?: CrushBot[];
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
  pend: { dmg: number; cls: number; by: number; kx: number; kz: number; kv: number }[];
  weapon: number[]; ammo: number[]; wcd: number[];
  shots?: Record<number, DrainShot>;
  floor: number[];
  penguin: number;
  cs: Record<number, CS>;
  cells: number[]; cur: number; deck: number[]; di: number;
  tSpawn: number; tFruit: number; tBurst: number; tBurstGap: number; tBurstN: number; tPower: number; tChest: number;
  lastBy: number[]; lastByTick: number[];
}

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
    if (!b.alive || !(isCrate(b) || b.kind === 'penguin')) continue;
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
  const nitroCap = cfg.nitroCap[4 - np];
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

// ---------- damage + explosions ----------
function queueDamage(d: Data, slot: number, dmg: number, cls: number, by: number, kx = 0, kz = 0, kv = 0) {
  const p = d.pend[slot];
  if (dmg > p.dmg) { p.dmg = dmg; p.cls = cls; p.by = by; p.kx = kx; p.kz = kz; p.kv = kv; }
}

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
  } else if (kind === 'chest') {
    emit(w, 'smash', c.x, c.z, -1, 1);
    openChest(w, d, c, s);
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
    if (d.variant === 'snow' && d.penguin <= 0 && dist2(c.x, c.z, 0, 0) / U < BLAST_R + 300) wakePenguin(w, d);
  }
  if (s.own >= 0) { /* score credit is given on the hit events */ }
  delete d.cs[c.id];
}

function openChest(w: World, d: Data, c: Body, s: CS) {
  const it = addBody(w, s.item === 0 ? 'fruit' : 'weapon', -1, c.x, c.z, 0.5, 1);
  it.y = 0; it.slot = s.item; it.dash = FRUIT_LIFE; // slot holds the weapon id (0 = fruit)
}

function wakePenguin(w: World, d: Data) {
  d.penguin = 210;
  const g = w.bodies.find((b) => b.kind === 'penguin');
  if (g) emit(w, 'penguinWake', g.x, g.z, -1, 1);
}

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
    d.cpu = [0, 1, 2, 3].map((slot) => newCrushBot(variant, slots.find((s) => s.slot === slot)?.level));
    d.humanSlots = slots.reduce((mask, s) => s.bot ? mask : mask | (1 << s.slot), 0);
    d.cells = buildCells(w, variant);
    const deck: number[] = [];
    for (let i = 0; i < cfg.deck[0] * 4; i++) deck.push(4);
    for (let i = 0; i < cfg.deck[1] * 4; i++) deck.push(5);
    for (let i = 0; i < cfg.deck[2] * 4; i++) deck.push(6);
    while (deck.length < 64) deck.push(4);
    for (let k = 0; k < 600; k++) { const a = Math.floor(rand(w) * 64), b = Math.floor(rand(w) * 64); const t = deck[a]; deck[a] = deck[b]; deck[b] = t; }
    d.deck = deck;
    d.di = Math.floor(rand(w) * 32) + 20;
    if (variant === 'snow') { const g = addBody(w, 'penguin', -1, 0, 0, 1.1, 8); g.face = 0; }
    for (const s of slots) {
      d.char[s.slot] = DISC_CHARACTER[s.char ?? s.slot] ?? 1;
      const [x, z] = SPAWN[s.slot];
      const b = addBody(w, 'player', s.slot, x * U, z * U, CT_HULL[d.char[s.slot] - 1][0] * U * w.params.playerScale, 3);
      b.face = Math.atan2(-x, -z);
      d.f8[s.slot] = snap8(b.face);
    }
    spawnCrates(w, d, cfg.start);
  },

  step(w, inputs) {
    const d = D(w);
    const cfg = CFG[d.variant];
    const ps = players(w);
    const live = ps.filter((p) => p.alive);
    const contestants = crushContestants(live);
    const focus = crushFocus(w, d, contestants);
    d.cpu = [0, 1, 2, 3].map((slot) => planCrushBot(w, slot, contestants, focus).state);
    // FUN_800b432c clears an eliminated focus this tick and draws its replacement next tick.
    d.cpuFocus = contestants.some((p) => p.slot === focus) ? focus : undefined;
    const sr = Math.max(0.1, w.params.spawnRate);
    const np = Math.max(2, Math.min(4, live.length));
    const crateN = crates(w).filter((c) => c.kind !== 'chest').length;

    // ---- crate spawner (FUN_800b7358) ----
    if (live.length > 1) {
      d.tSpawn -= sr >= 1 ? sr : 1;
      if (d.tSpawn < 0) {
        const cap = cfg.cap[4 - np];
        if (cap <= crateN) d.tSpawn = Math.floor(rand(w) * 40) + 5;
        else {
          const room = cap - crateN;
          let n = Math.min(4, cap);
          if (room < n) { n = Math.floor(rand(w) * room) + 1; d.tSpawn = Math.floor(rand(w) * 20) + 8; } else d.tSpawn = Math.floor(rand(w) * 10) + 2;
          spawnCrates(w, d, n);
        }
      }
      // fruit: keep fewer than 3 lying around
      const fruitN = w.bodies.filter((b) => b.kind === 'fruit' && b.alive).length;
      if (fruitN < 3) {
        if (d.tFruit <= 0) { const c = freeCell(w, d); if (c) dropFruit(w, c[0], c[1], 0); d.tFruit = Math.floor(rand(w) * 30) + 10; } else d.tFruit--;
      }
      // fruit bursts (not in drain bash): 6-9 fruits every 30-50 s
      if (d.variant !== 'drain') {
        if (d.tBurstN === 0) {
          if (d.tBurst <= 0) {
            if (fruitN < 5) { d.tBurstN = Math.floor(rand(w) * 4) + 6; d.tBurst = (Math.floor(rand(w) * 20) + 30) * 30; } else d.tBurst = 60;
          } else d.tBurst--;
        } else {
          if (d.tBurst > 0) d.tBurst--;
          if (d.tBurstGap <= 0) {
            const k = Math.floor(rand(w) * 256);
            const x = cellRaw(d.cells[k * 2]), z = cellRaw(d.cells[k * 2 + 1]);
            if (floorAt(d, x * U, z * U) && !occupiedAt(w, Math.floor(x / 256) + 10, 9 - Math.floor(z / 256))) { dropFruit(w, x, z, 1); d.tBurstN--; d.tBurstGap = Math.floor(rand(w) * 4) + 2; }
          } else d.tBurstGap--;
        }
      }
      // power-ups (space + snow): one at a time, when nobody holds one
      if (d.variant === 'space' || d.variant === 'snow') {
        if (d.tPower <= 0) {
          if (d.eff.some((e) => e !== 0) || w.bodies.some((b) => b.kind === 'boots' || b.kind === 'potion' || b.kind === 'mask' || b.kind === 'weight')) d.tPower = (Math.floor(rand(w) * 10) + 5) * 30;
          else {
            const kind = 0x12 + Math.floor(rand(w) * 4);
            const k = Math.floor(rand(w) * 256), x = cellRaw(d.cells[k * 2]), z = cellRaw(d.cells[k * 2 + 1]);
            if (floorAt(d, x * U, z * U) && !occupiedAt(w, Math.floor(x / 256) + 10, 9 - Math.floor(z / 256))) {
              const name = kind === EFF_AKU ? 'mask' : kind === EFF_BOOTS ? 'boots' : kind === EFF_WEIGHT ? 'weight' : 'potion';
              const it = addBody(w, name, -1, x * U, z * U, 0.5, 1);
              it.y = 2032 * U; it.dash = POWER_LIFE; it.vy = 0; // falls from the sky
              d.tPower = (Math.floor(rand(w) * 10) + 10) * 30;
            }
          }
        } else d.tPower--;
      }
      // drain bash: four "?" crates at the edges once the last weapon was taken
      if (d.variant === 'drain') {
        if (d.tPower <= 0 && !crates(w).some((c) => c.kind === 'chest')) {
          const at: [number, number][] = [[0, -0x700], [0, 0x600], [-0x700, 0], [0x600, 0]];
          const win = Math.floor(rand(w) * 4);
          const wlist = [W_MISSILE, W_ORB, W_RING];
          for (let k = 0; k < 4; k++) {
            const off = (Math.floor(rand(w) * 12) - 6) * 0x100 + 0x80;
            const x = k < 2 ? off : at[k][0], z = k < 2 ? at[k][1] : off;
            const c = addCrate(w, d, 'chest', x, z);
            csOf(d, c).item = k === win ? wlist[Math.floor(rand(w) * 3)] : 0;
          }
          d.tPower = 1 << 20;
        } else if (d.tPower > 0) d.tPower--;
      }
    }

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
    const timeUp = w.time >= crateToss.maxTime;
    return [0, 1, 2, 3].sort((a, b) => {
      const aa = d.hp[a] > 0, bb = d.hp[b] > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.hp[b] - d.hp[a] || (timeUp ? 0 : d.score[b] - d.score[a]) || d.score[b] - d.score[a] || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  bot(w, slot): InputState { return botInput(w, slot); },
};

function dropFruit(w: World, xr: number, zr: number, sky: number) {
  const f = addBody(w, 'fruit', 0, xr * U, zr * U, 0.5, 1);
  f.dash = FRUIT_LIFE;
  f.y = sky ? 2032 * U : 0;
  f.slot = 0;
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
      const elapsed = (action === ST_HURT ? HURT_TICKS : ctActionTicks(char, action)) - d.stT[s];
      return [s, { state: action === ST_SPIN ? 'ready' : 'action', script, elapsed, outAge: 0 }];
    }
    const ground = d.groundPose?.[s];
    const script = held ? d.cs[held.id]?.gripScript ?? (moving ? 0x11 : 0x10) : ground?.script || (moving ? 5 : 1);
    const elapsed = held ? d.cs[held.id]?.gripFrame ?? 0 : ground?.frame ?? 0;
    return [s, { state: 'ready', script, elapsed, outAge: 0 }];
  }));
  let winnerAt = -1;
  const justThrown = new Set<number>();

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
            justThrown.add(crate.id);
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
      justThrown.clear();
      for (const p of actors) stepActor(p, forSlot.get(p.slot)!);
      for (const c of crates(world)) if (!justThrown.has(c.id)) stepCrate(world, d, c);
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
      if (d.eff[slot] === EFF_WEIGHT) { // the weight goes off in your hands: out
        d.eff[slot] = 0;
        d.hp[slot] = 0;
        knockOut(w, d, p, -1);
        return;
      }
      d.eff[slot] = 0;
    }
  }
  if (d.pass[slot] > 0) d.pass[slot]--;
  if (d.inv[slot] > 0) d.inv[slot]--;
  if (d.wcd[slot] > 0) d.wcd[slot]--;
  // pending damage (FUN_80084e04 keeps the largest per tick, the player loop applies it)
  const pd = d.pend[slot];
  if (pd.dmg > 0) {
    const blocked = (d.inv[slot] > 0 || d.st[slot] === ST_HURT) && pd.cls <= d.ic[slot];
    if (!blocked) applyHit(w, d, p, pd);
    pd.dmg = 0;
    if (!p.alive) return;
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
    case ST_HURT:
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; if (d.ic[slot] !== -1) d.inv[slot] = Math.max(d.inv[slot], FLICKER_TICKS); }
      break;
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
  // crates are solid for walkers (only the moving player is pushed out)
  for (const c of crates(w)) {
    if (c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s) continue;
    if (!bodyOverlapsHeight(d, p, c.y, c.y + CRATE_H * U)) continue;
    const dd = dist2(p.x, p.z, c.x, c.z), m = p.r + CRATE_R * U;
    if (dd >= m) continue;
    // standing on top (falling onto it) is handled by groundAt; otherwise slide out sideways
    if (p.y > c.y + CRATE_H * U * 0.85) continue;
    const nx = dd > 1e-6 ? (p.x - c.x) / dd : 1, nz = dd > 1e-6 ? (p.z - c.z) / dd : 0;
    p.x = c.x + nx * (m + 1 * U); p.z = c.z + nz * (m + 1 * U);
    // touching a nitro sets it off (flag 8)
    if (c.kind === 'nitro' && s.s === C_IDLE) { s.own = slot; destroy(w, d, c, -1); }
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
  const slot = p.slot;
  const held = holdingCrate(w, slot);
  if (held) { // dropped crate falls and breaks where it lands
    const s = csOf(d, held);
    held.cd = 0; s.s = C_THROWN; s.hv = 0; s.vv = 0; s.up = false; s.own = pd.by; s.t = 0;
    held.dash = 1;
  }
  const aku = d.eff[slot] === EFF_AKU;
  d.st[slot] = ST_HURT; d.stT[slot] = HURT_TICKS; d.act[slot] = 4; d.ic[slot] = pd.cls;
  d.vx[slot] = pd.kx * pd.kv; d.vz[slot] = pd.kz * pd.kv;
  if (aku) { d.eff[slot] = 0; d.effT[slot] = 0; d.ic[slot] = -1; emit(w, 'hit', p.x, p.z, slot, 0, pd.by); return; }
  d.hp[slot] -= pd.dmg;
  d.taken[slot]++;
  if (pd.by >= 0 && pd.by !== slot) { d.score[pd.by]++; d.lastBy[slot] = pd.by; d.lastByTick[slot] = w.tick; }
  emit(w, 'hit', p.x, p.z, slot, pd.dmg / CT_HP, pd.by >= 0 && pd.by !== slot ? pd.by : -1);
  if (d.hp[slot] <= 0) knockOut(w, d, p, pd.by === slot ? -1 : pd.by);
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
  const h = holdingCrate(w, p.slot);
  if (h) { const s = csOf(d, h); h.cd = 0; s.s = C_IDLE; h.y = p.y; }
  emit(w, 'ko', p.x, p.z, p.slot, 1, by);
}

function passWeight(w: World, d: Data, a: Body, b: Body) {
  // FUN_800bede8: the holder bumps b: b gets the remaining time + 10, a is cleared
  if (d.eff[a.slot] !== EFF_WEIGHT || d.pass[a.slot] > 0) return;
  if (d.inv[b.slot] > 0 || d.st[b.slot] === ST_HURT) return;
  d.eff[b.slot] = EFF_WEIGHT; d.effT[b.slot] = d.effT[a.slot] + 10; d.pass[b.slot] = PASS_LOCK;
  d.eff[a.slot] = 0; d.effT[a.slot] = 0;
  d.weight = b.slot;
  emit(w, 'weight', b.x, b.z, b.slot, 1);
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

function throwCrate(w: World, d: Data, p: Body, c: Body) {
  const s = csOf(d, c);
  const f = d.f8[p.slot];
  c.cd = 0; c.dash = 1;
  const [speed, , , rise] = THROWS[(d.char?.[p.slot] ?? 1) - 1];
  s.s = C_THROWN; s.own = p.slot; s.hv = speed; s.vv = rise; s.up = rise > 0; s.dx = Math.sin(f); s.dz = Math.cos(f); s.t = 0;
  // Release from the character's last hand pose.
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
    if (d.inv[o.slot] === 0 && d.st[o.slot] !== ST_HURT && (!forwardAttack || Math.abs(angDiff(p.face, ang)) < Math.PI / 4)) {
      const push = forwardAttack ? p.face : ang;
      queueDamage(d, o.slot, SPIN_DMG, 0, slot, Math.sin(push), Math.cos(push), SPIN_KNOCK);
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
    break; // FUN_800c159c signals one crate.
  }
}

/** the crate was hit (flag 2): it slides away along one of 8 directions; nitro goes off, tnt is lit */
function kickCrate(w: World, d: Data, c: Body, s: CS, by: number, ang: number) {
  if (c.kind === 'nitro') { s.own = by; destroy(w, d, c, -1); return; }
  const a = snap8(ang);
  s.s = C_SLIDE; s.own = by; s.hv = longKick(d.char?.[by] ?? 1) ? 112 : 80; s.dx = Math.sin(a); s.dz = Math.cos(a); s.kt = 2; s.t = 0;
  c.dash = 2;
  if (c.kind === 'tnt') lightTnt(w, d, c, s);
  emit(w, 'beep', c.x, c.z, -1, 0.5);
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
    s.fuse--;
    c.m = Math.max(0, s.fuse / 30);
    if (s.fuse > 0 && s.fuse % 30 === 0) emit(w, 'beep', c.x, c.z, -1, 1);
    if (s.fuse <= 0) { destroy(w, d, c, -1); return; }
  }
  switch (s.s) {
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
      const [x, y, z, yaw, pitch] = track[frame+1];
      const sin = Math.sin(p.face), cos = Math.cos(p.face);
      c.x = p.x + (x*cos + z*sin)*U;
      c.y = p.y + y*U;
      c.z = p.z + (z*cos - x*sin)*U;
      c.face = p.face + yaw * TAU / 4096;
      s.pitch = pitch * TAU / 4096;
      return;
    }
    case C_THROWN: {
      s.t++;
      const [, max, drag, , gravity] = THROWS[(d.char?.[s.own] ?? 1) - 1];
      s.hv = Math.min(max, Math.max(0, s.hv - drag));
      c.x += s.dx * s.hv * U; c.z += s.dz * s.hv * U;
      if (s.up) { s.vv -= gravity; if (s.vv <= 0) { s.vv = 0; s.up = false; } else c.y += s.vv * U; }
      else { s.vv = Math.min(80, s.vv + gravity); c.y -= s.vv * U; }
      c.face += 0.25;
      const hitWall = clampCrate(c);
      const hole = !floorAt(d, c.x, c.z);
      const ground = groundAt(w, d, c.x, c.z, c);
      const landed = !s.up && !hole && c.y <= Math.max(0, ground);
      if (landed) c.y = d.variant === 'space' ? ground : Math.max(0, c.y);
      if (hole && c.y < -SPACE_OBJECT_CULL * U) { c.alive = false; delete d.cs[c.id]; return; }
      if (hitWall || landed || strike(w, d, c, s) || !hole && s.hv <= 0 && s.t > 40) impact(w, d, c, s);
      return;
    }
    case C_SLIDE: {
      s.t++;
      if (s.kt > 0) s.kt--;
      s.hv = Math.max(0, s.hv - (d.variant === 'snow' ? 2 : longKick(d.char?.[s.own] ?? 1) ? 4 : 3));
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

/** flying / sliding crate against players (and other crates): returns true on contact */
function strike(w: World, d: Data, c: Body, s: CS): boolean {
  for (const p of players(w)) {
    if (!p.alive || p.slot === s.own) continue;
    if (!bodyOverlapsHeight(d, p, c.y, c.y + CRATE_H * U)) continue;
    if (dist2(p.x, p.z, c.x, c.z) < p.r + CRATE_R * U) return true;
  }
  for (const o of crates(w)) {
    if (o === c || o.cd !== 0) continue;
    const os = d.cs[o.id];
    if (!os || os.s !== C_IDLE) continue;
    if (Math.abs(o.y - c.y) >= CRATE_H * U) continue;
    if (dist2(o.x, o.z, c.x, c.z) < 2 * CRATE_R * U) {
      // the target reacts (nitro blows up, others are shoved away), the projectile breaks as well
      kickCrate(w, d, o, os, s.own, Math.atan2(o.x - c.x, o.z - c.z));
      return true;
    }
  }
  return false;
}

/** thrown / kicked crate broke: wood breaks, TNT and nitro explode; the player who threw it is spared */
function impact(w: World, d: Data, c: Body, s: CS) {
  const own = s.own;
  if (own >= 0) d.lastBy[0] = d.lastBy[0]; // (credit goes through the hit events)
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
    if (o.y <= 0) { o.vy = 0; }
    return;
  }
  if (--o.dash <= 0) { o.alive = false; return; }
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
    case 'mask': d.eff[slot] = EFF_AKU; d.effT[slot] = MASK_T; emit(w, 'pickup', o.x, o.z, slot, 4); break;
    case 'weight': d.eff[slot] = EFF_WEIGHT; d.effT[slot] = WEIGHT_T; d.weight = slot; d.pass[slot] = 0; emit(w, 'pickup', o.x, o.z, slot, 5); break;
    case 'weapon': {
      const k = o.slot;
      d.weapon[slot] = k === W_MISSILE ? 2 : k === W_ORB ? 1 : 3;
      d.ammo[slot] = k === W_MISSILE ? 2 : k === W_ORB ? 3 : 1;
      emit(w, 'pickup', o.x, o.z, slot, 5 + d.weapon[slot]);
      for (const c of crates(w)) if (c.kind === 'chest' && c.cd === 0) { c.alive = false; delete d.cs[c.id]; } // the other "?" crates vanish
      d.tPower = (Math.floor(rand(w) * 6) + 2) * 30;
      break;
    }
  }
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
  if (victim && d.inv[victim.slot] === 0 && d.st[victim.slot] !== ST_HURT) {
    const a = Math.atan2(victim.x - b.x, victim.z - b.z);
    queueDamage(d, victim.slot, 8, 0, b.slot, Math.sin(a), Math.cos(a), 48);
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
function stepPenguin(w: World, d: Data, live: Body[]) {
  const g = w.bodies.find((b) => b.kind === 'penguin');
  if (!g) return;
  if (d.penguin <= 0) {
    for (const c of crates(w)) if (c.cd === 0 && d.cs[c.id] && d.cs[c.id].s !== C_IDLE && dist2(c.x, c.z, g.x, g.z) < g.r + CRATE_R * U) wakePenguin(w, d);
    for (const p of live) if (p.alive && dist2(p.x, p.z, g.x, g.z) < g.r + p.r + 0.1) { wakePenguin(w, d); break; }
    // solid while asleep
    for (const p of live) { const dx = p.x - g.x, dz = p.z - g.z, dd = Math.hypot(dx, dz) || 1, m = g.r + p.r; if (dd < m) { p.x = g.x + dx / dd * m; p.z = g.z + dz / dd * m; } }
    return;
  }
  d.penguin--;
  let tgt: Body | null = null, td = Infinity;
  for (const o of live) { if (!o.alive) continue; const dd = dist2(o.x, o.z, g.x, g.z); if (dd < td) { td = dd; tgt = o; } }
  const back = d.penguin < 45 || !tgt;
  const tx = back ? 0 : tgt!.x, tz = back ? 0 : tgt!.z;
  const dx = tx - g.x, dz = tz - g.z, dd = Math.hypot(dx, dz) || 1;
  const sp = (back ? 3 : 4.6) / 30;
  if (dd > 0.2) { g.x += dx / dd * sp; g.z += dz / dd * sp; g.face = Math.atan2(dx, dz); }
  if (!back && tgt && td < g.r + tgt.r + 0.1) {
    queueDamage(d, tgt.slot, 5, 0, -1, (tgt.x - g.x) / (td || 1), (tgt.z - g.z) / (td || 1), 96); // FUN_800b8c9c: 5 HP, knock 96 raw/tick
    emit(w, 'penguinHit', tgt.x, tgt.z, tgt.slot, 1);
    d.penguin = Math.min(d.penguin, 40);
  }
  if (d.penguin <= 0) { g.x = 0; g.z = 0; }
}

// ---------- AI (FUN_800b4ab0) ----------
type CrushRoute = 'object' | 'opponent' | 'station' | 'retreat';

interface CrushBot {
  skill: number;
  target: number;
  resumeFrom?: CrushRoute;
  throwAt: number;
  retreatUntil: number;
  retreatAngle: number;
  jumpUntil: number;
  tauntAt: number;
  taunting?: boolean;
}

interface CrushPlan { state: CrushBot; input: InputState }

/** Party difficulty rows at 0x800c302c / 30a0 / 3114 / 3188. */
const CRUSH_SKILLS: Record<string, number[]> = {
  jungle: [1, 16, 32], space: [1, 16, 32], snow: [1, 16, 32], drain: [1, 16, 28],
};
const STANDOFF = [0x500, 0x400, 0x400, 0x600]; // 0x800c39f0, by slot
const FRUIT_INTEREST = [100, 20, 15, 10, 8, 5, 4, 3, 3, 2, 2, 1, 1, 1, 0, 0, -1, -2, -4, -8, -10]; // 0x800c3ac4
const ROAM_CHANCE: Record<string, number> = { jungle: 6, space: 3, snow: 4, drain: 8 };
const ROAM_VALUE: Record<string, number> = { jungle: 0x4000, space: 0x2000, snow: 0x3000, drain: 0x4000 };
/** Edge stations from 0x800c3a58, with the PS1 Z axis converted to the web arena. */
const EDGE_STATIONS = [[0, 0], [-1920, 1920], [0, 1920], [1920, 1920], [-1920, 0], [1920, 0],
  [-1920, -1920], [0, -1920], [1920, -1920]];
const STATION_CLEARANCE_SQ = 0x7fffff;

function newCrushBot(variant: string, level = 2): CrushBot {
  const skills = CRUSH_SKILLS[variant] ?? CRUSH_SKILLS.jungle;
  return { skill: skills[level] ?? skills[2], target: 0, throwAt: -1, retreatUntil: 0, retreatAngle: 0, jumpUntil: 0, tauntAt: 0 };
}

/** A deterministic stand-in for the original AI's random draws. Asking for input never advances world RNG. */
function crushDraw(w: World, slot: number, salt: number, limit: number): number {
  const h = Math.imul(w.tick + 1, 0x9e3779b1) ^ Math.imul(slot + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35) ^ w.rng;
  return ((Math.imul(h ^ h >>> 16, 0x7feb352d) ^ h >>> 15) >>> 0) % limit;
}

function crushContestants(ps: Body[]): Body[] {
  return ps.filter((p) => p.alive && !p.fall).sort((a, b) => a.slot - b.slot);
}

/** FUN_80084788 arms the override after an elimination leaves only CPUs in play. */
function crushFocus(w: World, d: Data, live: Body[]): number | undefined {
  if (!d.cpuOnly || !live.length) return undefined;
  return d.cpuFocus ?? live[crushDraw(w, 4, 6, live.length)].slot;
}

const rawDistanceSq = (a: Pick<Body, 'x' | 'z'>, b: Body) => ((a.x - b.x) / U) ** 2 + ((a.z - b.z) / U) ** 2;
const rawDistance = (a: Body, b: Body) => Math.round(Math.hypot(a.x - b.x, a.z - b.z) / U);
const headingTo = (a: Body, b: Pick<Body, 'x' | 'z'>) => Math.atan2(b.x - a.x, b.z - a.z);
const nearAngle = (a: number, b: number, t: number) => Math.abs(angDiff(a, b)) < t;

function crateBotTarget(d: Data, obj: Body): boolean {
  if (!obj.alive || !floorAt(d, obj.x, obj.z)) return false;
  if (isCrate(obj)) return obj.y <= 0.01 && obj.kind !== 'nitro' && obj.cd === 0 && d.cs[obj.id]?.s === C_IDLE && !obj.fall;
  return isPickup(obj) && obj.kind !== 'weight' && obj.kind !== 'potion';
}

/** FUN_800b62ec scans native station IDs 7–15, including the center at ID 7. */
function crushStation(w: World, slot: number): number {
  const others = players(w).filter((p) => p.slot !== slot);
  // A station inside any other slot's clearance radius falls back to the current best score.
  // The score can only rise from zero to 0x7fffff, so the first qualifying station wins.
  const station = EDGE_STATIONS.findIndex(([x, z]) =>
    others.every((p) => rawDistanceSq({ x: x * U, z: z * U }, p) >= STATION_CLEARANCE_SQ));
  return station < 0 ? 0 : -station - 1;
}

/** Undefined means the search failed. Zero is a successful roaming branch with no qualifying station. */
function chooseCrushTarget(w: World, d: Data, me: Body, foes: Body[], nearest: number, skill: number,
  resumeFrom?: CrushRoute): number | undefined {
  const slot = me.slot;
  const bias = crushDraw(w, slot, 0, 0x1000);
  const armed = d.ammo[slot] > 0;
  const ring = armed && d.weapon[slot] === 3;
  const weight = d.eff[slot] === EFF_WEIGHT;
  const close = weight ? 512 : armed ? (ring ? 10 : 0) : nearest < 0x300 ? 0 : 8;
  const far = weight ? 0 : armed ? (ring ? 0 : 10) : nearest < 0x300 ? 8 : 0;
  const hp = Math.max(0, Math.min(CT_HP, Math.floor(d.hp[slot])));
  const fruit = weight ? 0 : FRUIT_INTEREST[hp] + (16 - skill) * 4;
  let objectScore = 0, objectTarget = 0;
  for (const obj of w.bodies) {
    if (!crateBotTarget(d, obj)) continue;
    const dist = rawDistance(me, obj);
    let value = 0;
    if (obj.kind === 'crate' || obj.kind === 'tnt') value = (0x1000 - Math.abs(dist - bias)) * (weight ? 8 : 40);
    else if (obj.kind === 'chest') value = Math.abs(dist - bias) * 400 / (armed || d.eff[slot] ? 256 : 1);
    else if (obj.kind === 'fruit') value = Math.max(0, 0xe00 - dist) * (close + fruit);
    else if (!weight) value = Math.abs(dist - bias) * 250;
    if (value > objectScore) { objectScore = value; objectTarget = obj.id; }
  }
  let opponentScore = 0, opponentTarget = 0;
  let interest = weight ? 512 : (skill - 16) * 2 | 1;
  for (const foe of foes) {
    const cargo = holdingCrate(w, foe.slot);
    if (!weight) {
      if (!cargo) interest = 0;
      else if (d.variant === 'space') interest += cargo.fall ? 1 : 5;
      else interest += cargo.fall ? 8 : 16;
    }
    if (d.air[foe.slot]) interest += 32;
    const dist = rawDistance(me, foe);
    const effect = armed || weight ? 160 : 0;
    const value = Math.max(Math.max(0, 0x800 - dist) * (close + interest + effect), dist * (far - interest - effect));
    if (value > opponentScore) { opponentScore = value; opponentTarget = foe.id; }
  }
  const roam = resumeFrom !== 'station' && crushDraw(w, slot, 1, ROAM_CHANCE[d.variant]) === 0
    ? (0x180 - (16 - skill) * 0x10) * fruit + ROAM_VALUE[d.variant] : 0;
  // FUN_800b6138 saves the interrupted route category at +0x22. The scorer zeros that category.
  if (resumeFrom === 'object') objectScore = 0;
  if (resumeFrom === 'opponent') opponentScore = 0;
  if (roam > objectScore && roam > opponentScore) return crushStation(w, slot);
  if (objectScore > opponentScore) return objectTarget;
  return opponentScore >= 0x15 ? opponentTarget : undefined;
}

/** FUN_800b6da4 weights the focus slot 48 and the other slots 16. */
function carryCrushTarget(w: World, d: Data, slot: number, foes: Body[], focus?: number, penguin?: Body): number {
  if (penguin && d.penguin <= 0 && crushDraw(w, slot, 2, 10) === 0) return penguin.id;
  if (!foes.length) return 0;
  const weight = (foe: Body) => foe.slot === focus ? 48 : 16;
  let draw = crushDraw(w, slot, 3, foes.reduce((total, foe) => total + weight(foe), 0));
  for (const foe of foes) {
    draw -= weight(foe);
    if (draw < 0) return foe.id;
  }
  return 0;
}

function botFloor(d: Data, x: number, z: number): boolean {
  return Math.abs(x) < CT_HALF && Math.abs(z) < CT_HALF && floorAt(d, x, z);
}

function evadeCrushHeading(d: Data, me: Body, angle: number): number {
  for (const turn of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const heading = snap8(angle) + turn * TAU / 8;
    if (botFloor(d, me.x + Math.sin(heading) * 180 * U, me.z + Math.cos(heading) * 180 * U)) return heading;
  }
  return angle;
}

/** FUN_800b5e28 / 800b6138: parallel cell probes 120 units either side of the current heading. */
function crushDanger(d: Data, me: Body, heading: number, hazards: Body[]) {
  const x = Math.sin(heading), z = Math.cos(heading);
  return [352, 608, 864].map((run) => [-120, 120].some((side) => {
    const px = me.x + (run * x + side * z) * U, pz = me.z + (run * z - side * x) * U;
    if (!botFloor(d, px, pz)) return true;
    const col = Math.floor(px / U / 256), row = Math.floor(pz / U / 256);
    return hazards.some((obj) => Math.floor(obj.x / U / 256) === col && Math.floor(obj.z / U / 256) === row);
  }));
}

const crushRouteBlocked = ([near, mid, far]: boolean[]) => near && (mid || far);

function planCrushBot(w: World, slot: number, contestants: Body[], focus: number | undefined): CrushPlan {
  const d = D(w), now = w.tick;
  const state = { ...(d.cpu?.[slot] ?? newCrushBot(d.variant)) };
  const me = contestants.find((b) => b.slot === slot);
  const result = (input: InputState = IDLE): CrushPlan => ({ input, state });
  if (!me) return result();
  if (d.st[slot] !== ST_MOVE) {
    if (d.st[slot] === ST_HURT) {
      state.target = 0;
      delete state.taunting;
      state.throwAt = -1;
      state.retreatUntil = now + 20;
      state.retreatAngle = d.f8[slot] + Math.PI;
    }
    return result();
  }
  const foes = contestants.filter((p) => p.slot !== slot);
  if (!foes.length) return result();
  const skill = focus === undefined ? state.skill : focus === slot ? 8 : 26;
  const face = d.f8[slot], held = holdingCrate(w, slot), weight = d.eff[slot] === EFF_WEIGHT;
  const nearest = Math.min(...foes.map((foe) => rawDistance(me, foe)));
  const penguin = w.bodies.find((b) => b.kind === 'penguin' && b.alive);
  const dangerFoe = foes.find((foe) => d.eff[foe.slot] === EFF_WEIGHT && rawDistance(me, foe) < 1024)
    ?? (penguin && d.penguin > 0 && rawDistance(me, penguin) < 1536 ? penguin : undefined);
  const hazards = w.bodies.filter((obj) => obj.alive && obj !== held && obj.y < CRATE_H * U
    && (obj.kind === 'nitro' || (obj.kind === 'tnt' && obj.fall) || d.cs[obj.id]?.s === C_DELAY
      || obj.kind === 'weight' || obj.kind === 'potion'));
  const steer = (angle: number, buttons: Partial<InputState> = {}) => {
    const heading = snap8(angle);
    return result({ x: Math.sin(heading), y: Math.cos(heading), a: false, b: false, ...buttons });
  };
  const byId = (id: number) => w.bodies.find((b) => b.id === id && b.alive && !b.fall);
  const canFire = () => !d.air[slot] && !d.prevB[slot] && d.wcd[slot] <= 1 && d.ammo[slot] > 0 && foes.some(
    (foe) => d.weapon[slot] === 3 ? rawDistanceSq(me, foe) < 0x51000 : nearAngle(face, headingTo(me, foe), 0x155 * TAU / 4096));
  const startRetreat = (route: CrushRoute) => {
    state.resumeFrom = route;
    state.retreatUntil = now + 30;
    state.target = 0;
    state.retreatAngle = me.face + Math.PI - 0x31c * TAU / 4096;
  };

  if (now < state.jumpUntil) {
    if (d.air[slot]) return steer(state.retreatAngle, { c: !!d.jh[slot] });
    state.jumpUntil = 0;
  }

  // Like the native controller, steer away from a rolling penguin or an opponent with the weight.
  if (dangerFoe) return steer(evadeCrushHeading(d, me, headingTo(me, dangerFoe) + Math.PI));
  if (now < state.retreatUntil) {
    if (state.resumeFrom && crushRouteBlocked(crushDanger(d, me, me.face, hazards))) startRetreat('retreat');
    return steer(evadeCrushHeading(d, me, state.retreatAngle));
  }
  if (now === state.retreatUntil && state.resumeFrom) return result();

  const taunt = () => {
    const target = carryCrushTarget(w, d, slot, foes, focus, penguin);
    if (!target) return result();
    state.tauntAt = now + 300;
    state.taunting = true;
    state.target = target;
    return result({ ...IDLE, d: true });
  };
  // The Triangle branch is available at long range, then waits four ticks before reassessing.
  if (state.taunting) {
    if (now < state.tauntAt - 296) return result();
    const target = byId(state.target);
    if ((d.tauntAt?.[slot] ?? -1) >= 0 && target) {
      if (foes.some((foe) => !((d.humanSlots ?? 0) & (1 << foe.slot))
        && d.cpu?.[foe.slot]?.target === me.id && rawDistanceSq(me, foe) < 0x240000)) {
        state.target = 0;
        delete state.taunting;
      }
      return steer(headingTo(me, target));
    }
    state.target = 0;
    delete state.taunting;
    return result();
  }
  if (!held && !weight && !d.air[slot] && now >= state.tauntAt && state.target === 0
    && nearest > skill * 32 + 0x400) {
    return taunt();
  }

  let target = byId(state.target);
  if (held) {
    if (target?.kind !== 'player' && !(target && target === penguin && d.penguin <= 0)) {
      state.target = carryCrushTarget(w, d, slot, foes, focus, penguin);
      state.throwAt = -1;
      target = byId(state.target);
    }
  } else {
    state.throwAt = -1;
    if ((!target && state.target > 0) || (target && target.kind !== 'player' && !crateBotTarget(d, target))) state.target = 0;
    if (state.target === 0) {
      const next = chooseCrushTarget(w, d, me, foes, nearest, skill, state.resumeFrom);
      if (next !== undefined) { state.target = next; delete state.resumeFrom; }
      return result(canFire() ? { ...IDLE, b: true } : IDLE);
    }
  }

  const station = state.target < 0 ? EDGE_STATIONS[-state.target - 1] : undefined;
  const at = target ?? (station ? { x: station[0] * U, z: station[1] * U } : undefined);
  if (!at) return result();
  const angle = headingTo(me, at);
  const danger = crushDanger(d, me, me.face, hazards);
  const closeFoe = foes.find((foe) => rawDistance(me, foe) < SPIN_R + PLAYER_R
    && Math.abs(me.y - foe.y) < PLAYER_H * U);

  if (held && target) {
    const dist = rawDistance(me, target);
    const range = STANDOFF[slot] + (16 - skill) * 32;
    const panic = held.kind === 'tnt' && held.fall && (d.cs[held.id]?.fuse ?? FUSE) < crushDraw(w, slot, 4, 4);
    const obstruction = crates(w).some((obj) => obj !== held && obj.cd === 0 && d.cs[obj.id]?.s === C_IDLE
      && Math.hypot(obj.x - me.x - Math.sin(face) * 256 * U, obj.z - me.z - Math.cos(face) * 256 * U) < 256 * U);
    const atEdge = Math.max(Math.abs(me.x), Math.abs(me.z)) >= Math.min(0x780 * U, CT_HALF - me.r - 4 * U);
    if (state.throwAt < 0 && (closeFoe || danger[0] || obstruction || panic || atEdge && dist <= range
      || (dist > range && dist < range + 256))) state.throwAt = now + 5;
    if (state.throwAt >= 0) {
      if (now >= state.throwAt && nearAngle(face, angle, 0x155 * TAU / 4096) && !d.prevA[slot]) {
        state.target = 0;
        state.throwAt = -1;
        return result({ ...IDLE, a: true });
      }
      return steer(angle);
    }
    if (dist <= range) {
      state.retreatUntil = now + 10;
      state.retreatAngle = angle + Math.PI;
      return steer(evadeCrushHeading(d, me, state.retreatAngle));
    }
    return steer(angle);
  }

  if (crushRouteBlocked(danger)) {
    startRetreat(station ? 'station' : target?.kind === 'player' ? 'opponent' : 'object');
    return steer(angle);
  }
  if (station && rawDistanceSq(at, me) < 0x4000) return taunt();

  if (canFire()) return result({ ...IDLE, b: true });

  if (!d.air[slot] && !d.prevB[slot] && closeFoe && !weight && d.inv[closeFoe.slot] === 0 && d.st[closeFoe.slot] !== ST_HURT) {
    const char = d.char[slot] ?? 1;
    const inRange = (char !== 3 && char !== 4) || nearAngle(face, headingTo(me, closeFoe), Math.PI / 4);
    if (inRange && (station || target === closeFoe || crushDraw(w, slot, 5, 3) === 0)) {
      state.target = 0;
      return result({ ...IDLE, b: true });
    }
  }

  if (!d.air[slot] && !d.prevA[slot] && target && isCrate(target) && findPick(w, d, me) === target) {
    state.target = 0;
    return result({ ...IDLE, a: true });
  }

  if (danger[0] && !d.air[slot] && !d.prevC?.[slot]) {
    state.jumpUntil = now + 18;
    state.retreatAngle = angle;
    return steer(angle, { c: true });
  }
  return steer(angle);
}

function botInput(w: World, slot: number): InputState {
  const contestants = crushContestants(players(w));
  return planCrushBot(w, slot, contestants, crushFocus(w, D(w), contestants)).input;
}
