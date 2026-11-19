/**
 * CRATE CRUSH (game id 'crateToss') - rules decoded from the real game (overlay 0728.t5d, see re/notes/crateCrush.md).
 *
 * Logic runs at 30 Hz, one step() = one tick. Distances below are written in the game's raw units (arena = +-2048 raw = +-CT_HALF
 * world units, so U world units per raw unit) and per-tick speeds; the real code adds them to the position every tick.
 *
 * Controls (real pad: Circle / Square / Cross; here A / B only):
 *   A (Circle)  pick up the crate in front of you / throw the crate you hold
 *   B           Square: a spin attack that kicks crates away and hits players for 1 HP; with nothing in reach it is a jump (Cross)
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
import { addBody, emit, rand } from '../physics';
import { IDLE, type Body, type InputState, type MiniGame, type World } from '../types';
import { angDiff, pickVariant } from './common';

export const CT_HALF = 7.2;
export const CT_HP = 20;
export const CT_FLOOR_N = 8; // space bash floor grid (tiles of 512 raw)
/** world units per raw unit */
export const CT_U = CT_HALF / 2048;
const U = CT_U;
const TAU = Math.PI * 2;

// ---------- constants decoded from the game (raw units, per tick) ----------
const WALK = 45, HOLD_WALK = 30, BOOT_BONUS = 20;            // table 0x8009d318 (chars 1-4): walk, walk holding a crate, boots bonus
const ICE_WALK = 180, ICE_HOLD = 120, ICE_BOOT = 80, ICE_ACC = 8, ICE_DEC = 4; // snow bash: velocity ramps to these (table 0x800c3984)
const JUMP_V0 = 108, JUMP_DEC = 10, JUMP_CUT = 40, JUMP_FALL_ACC = 8, JUMP_FALL_MAX = 114; // table 0x8009d354, FUN_800860d4
const PLAYER_R = 153, CRATE_R = 120, ARENA = 2048;
const CRATE_H = 240, PLAYER_H = 700;
const PICK_REACH = 256, PICK_CONE = 0x280 / 4096 * TAU;     // FUN_800c1848: crate within 256 raw of the point 256 raw in front, +-56 deg
const PICK_TICKS = 11, THROW_REL = 9, THROW_TICKS = 16, SPIN_TICKS = 27;  // anim scripts clip 15 / 18 / 9 (char 1)
const SPIN_R = 330, SPIN_DMG = 1, SPIN_KNOCK = 48;
const THROW_V0 = 113, THROW_DEC = 6, THROW_VY0 = 32, THROW_VYDEC = 9, THROW_VYACC = 9, THROW_VYMAX = 80; // throw table 0x8009e3b4 char 1
const KICK_V0 = 112, KICK_DEC = 4;                                                       // kick table 0x8009e3dc char 1
const HELD_Y = 560;                                                                      // crate base above the holder's feet (est.)
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
const C_GROW = 0, C_IDLE = 1, C_HELD = 2, C_THROWN = 3, C_SLIDE = 4, C_DELAY = 5, C_OPEN = 6;
interface CS { s: number; t: number; hv: number; vv: number; up: boolean; dx: number; dz: number; own: number; fuse: number; kt: number; item: number }

interface Data {
  variant: string;
  hp: number[]; score: number[]; taken: number[]; elim: number[];
  stun: number[]; act: number[]; st: number[]; stT: number[]; inv: number[]; ic: number[];
  boots: number[]; slow: number[]; mask: number[];
  eff: number[]; effT: number[]; pass: number[];
  weight: number; weightT: number;
  f8: number[]; vx: number[]; vz: number[]; vy: number[]; air: boolean[]; jh: boolean[]; prevA: boolean[]; prevB: boolean[];
  /** Cross (jump) held last tick */
  prevC?: boolean[];
  pend: { dmg: number; cls: number; by: number; kx: number; kz: number; kv: number }[];
  weapon: number[]; ammo: number[]; wcd: number[];
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

/**
 * Space Bash floor (FUN_800b8578 area, table 0x800c3bb4): at load every 512-raw cell without a floor object is a permanent hole
 * (flag 0x100, ground 0x7fffffff); nothing removes tiles later. Read from the emulator (level 1): rows = game x cell, columns =
 * game z cell, '#' = hole. Our floor index is r*N + c with c = x cell and r = 7 - z cell (world z = -game z).
 */
const SPACE_HOLES = ['........', '........', '#..#....', '..#..#..', '.....#.#', '....#..#', '.#....#.', '..#.....'];
function spaceFloor(): number[] {
  const f = new Array(CT_FLOOR_N * CT_FLOOR_N).fill(1);
  SPACE_HOLES.forEach((row, ux) => [...row].forEach((ch, uz) => { if (ch === '#') f[(7 - uz) * CT_FLOOR_N + ux] = 0; }));
  return f;
}

/** Is there floor under (x, z)? Space bash has missing tiles. */
export function floorAt(d: { floor: number[] }, x: number, z: number): boolean {
  if (!d.floor.length) return true;
  const T = (CT_HALF * 2) / CT_FLOOR_N;
  const tx = Math.floor((x + CT_HALF) / T), tz = Math.floor((z + CT_HALF) / T);
  if (tx < 0 || tz < 0 || tx >= CT_FLOOR_N || tz >= CT_FLOOR_N) return true;
  return d.floor[tz * CT_FLOOR_N + tx] === 1;
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
    const ci = d.cells[idx * 2] + 2, cj = d.cells[idx * 2 + 1] + 2; // 16x16 inner grid sits at 2..17 of the 20x20 occupancy grid
    const x = cellRaw(d.cells[idx * 2]), z = cellRaw(d.cells[idx * 2 + 1]);
    if (!floorAt(d, x * U, z * U)) continue;
    if (occupiedAt(w, ci, 9 - Math.floor(z / 256) < 0 ? cj : 9 - Math.floor(z / 256))) continue;
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
  description: 'Pick up and throw crates at your opponents. TNT counts down, nitro explodes on touch. Last one standing - or most health - wins.',
  controls: '{move} walk. {a} pick up / throw a crate. {b} spin attack (kicks crates, rivals lose 1 HP; fires a weapon you picked up). {c} jump.',
  variants: CT_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, CT_VARIANTS);
    const cfg = CFG[variant];
    const z4 = () => [0, 0, 0, 0];
    const d: Data = {
      variant, hp: [CT_HP, CT_HP, CT_HP, CT_HP], score: z4(), taken: z4(), elim: [-1, -1, -1, -1],
      stun: z4(), act: z4(), st: z4(), stT: z4(), inv: z4(), ic: z4(), boots: z4(), slow: z4(), mask: z4(),
      eff: z4(), effT: z4(), pass: z4(), weight: -1, weightT: 0,
      f8: [0, 0, 0, 0], vx: z4(), vz: z4(), vy: z4(), air: [false, false, false, false], jh: [false, false, false, false], prevA: [false, false, false, false], prevB: [false, false, false, false],
      pend: [0, 1, 2, 3].map(() => ({ dmg: 0, cls: 0, by: -1, kx: 0, kz: 0, kv: 0 })),
      weapon: z4(), ammo: z4(), wcd: z4(),
      floor: variant === 'space' ? spaceFloor() : [],
      penguin: 0, cs: {}, cells: [], cur: 0, deck: [], di: 0,
      tSpawn: 0, tFruit: 0, tBurst: (Math.floor(rand(w) * 10) + 10) * 30, tBurstGap: 0, tBurstN: 0,
      tPower: variant === 'jungle' ? 30 : variant === 'drain' ? Math.floor(rand(w) * 30) + 30 : (Math.floor(rand(w) * 10) + 10) * 30,
      tChest: 30, lastBy: [-1, -1, -1, -1], lastByTick: [-99, -99, -99, -99],
    };
    w.data = d;
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
      const [x, z] = SPAWN[s.slot];
      const b = addBody(w, 'player', s.slot, x * U, z * U, PLAYER_R * U * w.params.playerScale, 3);
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
      if (!a.alive || !b.alive || Math.abs(a.y - b.y) > PLAYER_H * U) continue;
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

function stepPlayer(w: World, d: Data, p: Body, inp: InputState) {
  const slot = p.slot;
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
      const t = THROW_TICKS - d.stT[slot];
      if (t === THROW_REL) { const c = holdingCrate(w, slot); if (c) throwCrate(w, d, p, c); }
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    }
    case ST_SPIN:
      spinHit(w, d, p);
      if (d.stT[slot] <= 0) { d.st[slot] = ST_MOVE; d.act[slot] = 0; }
      break;
    default: {
      if (!held && aNew && !d.air[slot]) {
        const c = findPick(w, d, p);
        if (c) pickUp(w, d, p, c);
        else { d.st[slot] = ST_PICK; d.stT[slot] = PICK_TICKS; d.act[slot] = 1; }
      } else if (held && aNew) {
        d.st[slot] = ST_THROW; d.stT[slot] = THROW_TICKS; d.act[slot] = 2;
      } else if (bNew) {
        if (d.weapon[slot] > 0 && d.ammo[slot] > 0 && d.wcd[slot] <= 0 && !held) fireWeapon(w, d, p);
        else if (!held && !d.air[slot]) { d.st[slot] = ST_SPIN; d.stT[slot] = SPIN_TICKS; d.act[slot] = 3; emit(w, 'kick', p.x, p.z, slot, 1); }
      } else if (cNew && !d.air[slot]) wantJump = true;
    }
  }
  const free = d.st[slot] === ST_MOVE;
  // facing (8-way, re-snaps when the stick is more than 24 degrees away)
  if (free && moving && Math.abs(angDiff(d.f8[slot], sang)) > AIM) d.f8[slot] = snap8(sang);
  if (free && moving) p.face += angDiff(p.face, sang) / 4;
  else if (!moving && free) p.face += angDiff(p.face, d.f8[slot]) / 8;

  // ---- horizontal velocity (raw/tick) ----
  const sp = w.params.speed;
  const hasHold = !!held || d.st[slot] === ST_THROW;
  if (hurt) {
    // knock-back: speed decays 4 per tick (ice: per axis)
    const k = Math.hypot(d.vx[slot], d.vz[slot]);
    if (k > 0) { const n = Math.max(0, k - 4) / k; d.vx[slot] *= n; d.vz[slot] *= n; }
  } else if (ice) {
    const walk = (hasHold ? ICE_HOLD : ICE_WALK) + (d.eff[slot] === EFF_BOOTS ? ICE_BOOT : 0);
    const tx = free && moving ? Math.sin(sang) * walk : 0, tz = free && moving ? Math.cos(sang) * walk : 0;
    d.vx[slot] = approach(d.vx[slot], tx, tx === 0 ? ICE_DEC : ICE_ACC);
    d.vz[slot] = approach(d.vz[slot], tz, tz === 0 ? ICE_DEC : ICE_ACC);
  } else if (free) {
    const spd = (hasHold ? HOLD_WALK : WALK) + (d.eff[slot] === EFF_BOOTS ? BOOT_BONUS : 0);
    d.vx[slot] = moving ? Math.sin(sang) * spd : 0;
    d.vz[slot] = moving ? Math.cos(sang) * spd : 0;
  } else { d.vx[slot] = 0; d.vz[slot] = 0; }
  p.x += d.vx[slot] * sp * U;
  p.z += d.vz[slot] * sp * U;

  // ---- vertical (jump physics of FUN_800860d4) ----
  const grav = w.params.gravity;
  const g = groundAt(w, d, p.x, p.z);
  const rawY = p.y / U;
  if (wantJump && !d.air[slot] && free) { d.air[slot] = true; d.vy[slot] = JUMP_V0; d.jh[slot] = true; emit(w, 'jump', p.x, p.z, slot, 1); }
  if (d.air[slot]) {
    if (d.vy[slot] > 0 || d.jh[slot]) {
      if (d.jh[slot]) {
        const dec = !inp.c && d.vy[slot] > 0x40 ? JUMP_CUT : JUMP_DEC;
        d.vy[slot] -= dec * grav;
        if (d.vy[slot] < 0) { d.vy[slot] = 0; d.jh[slot] = false; } else p.y += d.vy[slot] * U;
      }
    } else {
      d.vy[slot] = Math.min(JUMP_FALL_MAX, d.vy[slot] + JUMP_FALL_ACC * grav);
      p.y -= d.vy[slot] * U;
    }
    if (!d.jh[slot] && d.vy[slot] <= 0) d.vy[slot] = JUMP_FALL_ACC * grav; // start the fall
    if (!d.jh[slot] && p.y <= g) { // landed
      p.y = Math.max(0, g);
      d.air[slot] = false; d.vy[slot] = 0;
      emit(w, 'land', p.x, p.z, slot, 0.4);
      landedOn(w, d, p);
    }
  } else if (p.y > g + 1e-6) { // walked off a crate
    d.air[slot] = true; d.jh[slot] = false; d.vy[slot] = JUMP_FALL_ACC;
  } else p.y = Math.max(0, g);
  void rawY;
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
  p.fall = false;
}

function clampPlayer(w: World, d: Data, p: Body) {
  const slot = p.slot;
  // crates are solid for walkers (only the moving player is pushed out)
  for (const c of crates(w)) {
    if (c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s) continue;
    if (p.y >= c.y + CRATE_H * U - 1e-3 || p.y + PLAYER_H * U <= c.y) continue;
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
  // space bash: no tile under you = you fall and are out
  if (p.alive && !d.air[slot] && p.y <= 1e-6 && !floorAt(d, p.x, p.z)) {
    emit(w, 'hole', p.x, p.z, -1, 1);
    d.hp[slot] = 0;
    knockOut(w, d, p, d.lastBy[slot]);
  }
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
  d.st[p.slot] = ST_PICK; d.stT[p.slot] = PICK_TICKS; d.act[p.slot] = 1;
  if (c.kind === 'tnt') lightTnt(w, d, c, s);
  emit(w, 'grab', c.x, c.z, p.slot, 1);
}

function throwCrate(w: World, d: Data, p: Body, c: Body) {
  const s = csOf(d, c);
  const f = d.f8[p.slot];
  c.cd = 0; c.dash = 1;
  s.s = C_THROWN; s.own = p.slot; s.hv = THROW_V0; s.vv = THROW_VY0; s.up = true; s.dx = Math.sin(f); s.dz = Math.cos(f); s.t = 0;
  c.x = p.x + s.dx * 0.3; c.z = p.z + s.dz * 0.3;
  emit(w, 'throw', p.x, p.z, p.slot, 1);
}

/** the spin attack, each tick (FUN_80088794): a player in reach takes 1 HP and is knocked back 48/tick, crates in reach are kicked away */
function spinHit(w: World, d: Data, p: Body) {
  const slot = p.slot;
  p.face += TAU * 0x155 / 4096 * -1; // visual spin
  for (const o of players(w)) {
    if (o === p || !o.alive || Math.abs(o.y - p.y) > PLAYER_H * U) continue;
    if (dist2(o.x, o.z, p.x, p.z) >= (SPIN_R + PLAYER_R) * U) continue;
    if (d.inv[o.slot] > 0 || d.st[o.slot] === ST_HURT) continue;
    const ang = Math.atan2(o.x - p.x, o.z - p.z);
    queueDamage(d, o.slot, SPIN_DMG, 0, slot, Math.sin(ang), Math.cos(ang), SPIN_KNOCK);
  }
  for (const c of crates(w)) {
    if (c.cd !== 0) continue;
    const s = d.cs[c.id];
    if (!s || (s.s !== C_IDLE && s.s !== C_SLIDE)) continue;
    if (dist2(c.x, c.z, p.x, p.z) >= (SPIN_R + CRATE_R) * U) continue;
    kickCrate(w, d, c, s, slot, Math.atan2(c.x - p.x, c.z - p.z));
  }
}

/** the crate was hit (flag 2): it slides away along one of 8 directions; nitro goes off, tnt is lit */
function kickCrate(w: World, d: Data, c: Body, s: CS, by: number, ang: number) {
  if (c.kind === 'nitro') { s.own = by; destroy(w, d, c, -1); return; }
  const a = snap8(ang);
  s.s = C_SLIDE; s.own = by; s.hv = KICK_V0; s.dx = Math.sin(a); s.dz = Math.cos(a); s.kt = 2; s.t = 0;
  c.dash = 2;
  if (c.kind === 'tnt') lightTnt(w, d, c, s);
  emit(w, 'beep', c.x, c.z, -1, 0.5);
}

// ---------- crates ----------
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
    case C_GROW:
      if (--s.t <= 0) s.s = C_IDLE;
      return;
    case C_DELAY:
      if (--s.t <= 0) destroy(w, d, c, -1);
      return;
    case C_HELD: {
      const p = players(w).find((q) => q.slot === c.cd - 1);
      if (!p || !p.alive) { c.cd = 0; s.s = C_IDLE; c.y = p ? p.y : 0; return; }
      c.x = p.x; c.z = p.z; c.y = p.y + HELD_Y * U; c.face = p.face;
      return;
    }
    case C_THROWN: {
      s.t++;
      s.hv = Math.max(0, s.hv - THROW_DEC);
      c.x += s.dx * s.hv * U; c.z += s.dz * s.hv * U;
      // vertical: rises with vv (decel 9) then falls (accel 9, max 80)
      if (s.up) { s.vv -= THROW_VYDEC; if (s.vv <= 0) { s.vv = 0; s.up = false; } else c.y += s.vv * U; }
      else { s.vv = Math.min(THROW_VYMAX, s.vv + THROW_VYACC); c.y -= s.vv * U; }
      c.face += 0.25;
      const hitWall = clampCrate(c);
      const landed = !s.up && c.y <= Math.max(0, groundAt(w, d, c.x, c.z, c));
      if (landed) { c.y = Math.max(0, c.y); }
      if (hitWall || landed || strike(w, d, c, s) || s.hv <= 0 && s.t > 40) impact(w, d, c, s);
      return;
    }
    case C_SLIDE: {
      s.t++;
      if (s.kt > 0) s.kt--;
      s.hv = Math.max(0, s.hv - KICK_DEC);
      c.x += s.dx * s.hv * U; c.z += s.dz * s.hv * U;
      c.face += 0.1;
      const hitWall = clampCrate(c);
      const hitSomething = s.kt <= 0 && strike(w, d, c, s);
      if (hitSomething) { impact(w, d, c, s); return; }
      if (hitWall) { if (c.kind === 'crate') { impact(w, d, c, s); return; } s.hv = 0; }
      if (!floorAt(d, c.x, c.z)) { c.y -= 0.3; if (c.y < -6) { c.alive = false; delete d.cs[c.id]; } return; }
      if (s.hv <= 0) { s.s = C_IDLE; c.dash = 0; }
      return;
    }
    default: {
      // idle: falls into holes
      if (!floorAt(d, c.x, c.z)) { c.y -= 0.25; if (c.y < -6) { c.alive = false; delete d.cs[c.id]; } }
    }
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
    if (p.y >= c.y + CRATE_H * U || p.y + PLAYER_H * U <= c.y) continue;
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
  if (o.y > 0) { // falling from the sky: accel 6 per tick up to 80 (state 4 table)
    o.vy = Math.min(80, o.vy + 6);
    o.y = Math.max(0, o.y - o.vy * U);
    if (o.y <= 0) { o.vy = 0; }
    return;
  }
  if (!floorAt(d, o.x, o.z)) { o.alive = false; return; }
  if (--o.dash <= 0) { o.alive = false; return; }
  for (const p of live) {
    if (!p.alive || p.y > 700 * U) continue;
    if (dist2(p.x, p.z, o.x, o.z) >= (PLAYER_R + CRATE_R) * U) continue;
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

// ---------- drain bash weapons ----------
function fireWeapon(w: World, d: Data, p: Body) {
  const slot = p.slot, k = d.weapon[slot];
  d.ammo[slot]--;
  d.wcd[slot] = k === 3 ? 40 : 20;
  if (d.ammo[slot] <= 0) d.weapon[slot] = 0;
  const f = d.f8[slot];
  if (k === 1) {
    const b = addBody(w, 'orb', slot, p.x + Math.sin(f) * 1.2, p.z + Math.cos(f) * 1.2, 0.5, 1);
    b.y = 1.2; b.vx = Math.sin(f) * 9; b.vz = Math.cos(f) * 9; b.cd = 4;
  } else if (k === 2) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + f;
      const b = addBody(w, 'rocket', slot, p.x + Math.sin(a) * 1.0, p.z + Math.cos(a) * 1.0, 0.4, 1);
      b.y = 1.0; b.vx = Math.sin(a) * 12; b.vz = Math.cos(a) * 12; b.cd = 1.1; b.face = a;
    }
  } else {
    for (const o of players(w)) {
      if (o === p || !o.alive) continue;
      const dd = dist2(o.x, o.z, p.x, p.z);
      if (dd > 5.5) continue;
      queueDamage(d, o.slot, 5, 2, slot, (o.x - p.x) / (dd || 1), (o.z - p.z) / (dd || 1), 40);
    }
  }
  emit(w, 'weapon', p.x, p.z, slot, k);
}

function stepShots(w: World, d: Data, live: Body[]) {
  const dt = 1 / 30;
  for (const b of w.bodies) {
    if (!b.alive || (b.kind !== 'orb' && b.kind !== 'rocket')) continue;
    b.cd -= dt;
    if (b.kind === 'orb') {
      let tgt: Body | null = null, td = Infinity;
      for (const o of live) { if (!o.alive || o.slot === b.slot) continue; const dd = dist2(o.x, o.z, b.x, b.z); if (dd < td) { td = dd; tgt = o; } }
      if (tgt) {
        const want = Math.atan2(tgt.x - b.x, tgt.z - b.z), cur = Math.atan2(b.vx, b.vz);
        const na = cur + Math.max(-4 * dt, Math.min(4 * dt, angDiff(cur, want)));
        b.vx = Math.sin(na) * 9; b.vz = Math.cos(na) * 9;
      }
    }
    b.x += b.vx * dt; b.z += b.vz * dt;
    if (b.cd <= 0 || Math.abs(b.x) > CT_HALF || Math.abs(b.z) > CT_HALF) { b.alive = false; continue; }
    for (const p of live) {
      if (!p.alive || p.slot === b.slot || dist2(p.x, p.z, b.x, b.z) > p.r + b.r) continue;
      const sp = Math.hypot(b.vx, b.vz) || 1;
      queueDamage(d, p.slot, b.kind === 'orb' ? 3 : 2, 2, b.slot, b.vx / sp, b.vz / sp, 30);
      b.alive = false;
      emit(w, 'weaponHit', b.x, b.z, p.slot, 1);
      break;
    }
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

// ---------- AI ----------
function botInput(w: World, slot: number): InputState {
  const d = D(w);
  const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot && b.alive);
  if (!me) return IDLE;
  if (d.st[slot] === ST_HURT || d.st[slot] === ST_THROW || d.st[slot] === ST_PICK) return IDLE;
  const held = holdingCrate(w, slot);
  const foes = players(w).filter((o) => o.alive && o.slot !== slot);
  let foe: Body | null = null, fd = Infinity;
  for (const o of foes) { const dd = dist2(o.x, o.z, me.x, me.z); if (dd < fd) { fd = dd; foe = o; } }
  const dir = (tx: number, tz: number): [number, number] => { const l = Math.hypot(tx - me.x, tz - me.z) || 1; return [(tx - me.x) / l, (tz - me.z) / l]; };
  const away = (tx: number, tz: number): [number, number] => { const [a, b] = dir(tx, tz); return [-a, -b]; };
  // run from anything about to blow
  let fx = 0, fz = 0, danger = false;
  for (const c of crates(w)) {
    if (c === held) continue;
    const s = d.cs[c.id];
    const hot = (c.kind === 'tnt' && c.fall && s && s.fuse < 60) || (s && (s.s === C_DELAY || s.s === C_THROWN || s.s === C_SLIDE));
    if (!hot && c.kind !== 'nitro') continue;
    const dd = dist2(c.x, c.z, me.x, me.z);
    if (dd < (hot ? 3.4 : 1.4)) { const [a, b] = away(c.x, c.z); fx += a; fz += b; danger = true; }
  }
  const png = w.bodies.find((b) => b.kind === 'penguin');
  if (png && dist2(png.x, png.z, me.x, me.z) < (d.penguin > 0 ? 4.5 : 2.2)) { const [a, b] = away(png.x, png.z); fx += a * 1.5; fz += b * 1.5; danger = true; }
  const safe = (ax: number, az: number): [number, number] => {
    if (!d.floor.length) return [ax, az];
    const l = Math.hypot(ax, az) || 1;
    for (const rot of [0, 0.9, -0.9, 1.8, -1.8]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const rx = (ax * c - az * s) / l, rz = (ax * s + az * c) / l;
      if (floorAt(d, me.x + rx * 1.6, me.z + rz * 1.6) && floorAt(d, me.x + rx * 0.8, me.z + rz * 0.8)) return [rx, rz];
    }
    return [0, 0];
  };
  if (danger) { const [a, b] = safe(fx, fz); return { x: a, y: b, a: false, b: false }; }
  const tick2 = w.tick % 4 === 0;
  if (d.eff[slot] === EFF_WEIGHT && foe) { const [a, b] = dir(foe.x, foe.z); return { x: a, y: b, a: false, b: false }; }
  if (!held && d.weapon[slot] > 0 && d.ammo[slot] > 0 && foe && fd < 8) {
    const [a, b] = safe(...dir(foe.x, foe.z));
    return { x: a, y: b, a: false, b: tick2 && Math.abs(angDiff(d.f8[slot], Math.atan2(foe.x - me.x, foe.z - me.z))) < 0.5 };
  }
  if (!held) {
    // pickups worth walking to
    let pick: Body | null = null, pdist = Infinity;
    for (const o of w.bodies) {
      if (!o.alive || !(isPickup(o) || o.kind === 'chest') || o.y > 0) continue;
      if (o.kind === 'weight' || o.kind === 'potion' || o.kind === 'chest') continue;
      const want = o.kind === 'fruit' ? d.hp[slot] <= CT_HP - 1 : o.kind === 'boots' ? d.eff[slot] === 0 : o.kind === 'mask' ? d.eff[slot] === 0 : d.weapon[slot] === 0;
      const dd = dist2(o.x, o.z, me.x, me.z);
      if (want && dd < pdist && dd < 9) { pdist = dd; pick = o; }
    }
    if (pick) { const [a, b] = safe(...dir(pick.x, pick.z)); return { x: a, y: b, a: false, b: false }; }
    // spin-kick a rival that is right next to us
    if (foe && fd < (SPIN_R + PLAYER_R) * U * 0.9 && d.inv[foe.slot] === 0 && tick2) return { x: 0, y: 0, a: false, b: true };
    let best: Body | null = null, bd = Infinity;
    for (const c of crates(w)) {
      if (c.cd !== 0 || c.kind === 'nitro' || c.kind === 'chest' && d.variant !== 'drain') continue;
      const s = d.cs[c.id];
      if (!s || s.s !== C_IDLE || c.y > 0.01 || !floorAt(d, c.x, c.z)) continue;
      if (c.kind === 'tnt' && c.fall) continue;
      const dd = dist2(c.x, c.z, me.x, me.z);
      if (dd < bd) { bd = dd; best = c; }
    }
    if (!best) { if (!foe) return IDLE; const [a, b] = safe(-me.x * 0.1, -me.z * 0.1); return { x: a, y: b, a: false, b: false }; }
    // walk so that the crate ends up 256 raw in front of us
    const f = d.f8[slot], cx = me.x + Math.sin(f) * PICK_REACH * U, cz = me.z + Math.cos(f) * PICK_REACH * U;
    const near = dist2(best.x, best.z, cx, cz) < PICK_REACH * U * 0.7 && Math.abs(angDiff(f, Math.atan2(best.x - me.x, best.z - me.z))) < PICK_CONE * 0.7;
    if (near && tick2) return { x: 0, y: 0, a: true, b: false };
    const [a, b] = safe(...dir(best.x, best.z));
    return { x: a, y: b, a: false, b: false };
  }
  if (!foe) return IDLE;
  const dx = foe.x - me.x, dz = foe.z - me.z;
  const ang = Math.atan2(dx, dz);
  const aligned = Math.abs(angDiff(d.f8[slot], ang)) < 0.4;
  const burning = held.kind === 'tnt' && held.fall && (d.cs[held.id]?.fuse ?? 90) < 40;
  const fire = (aligned && fd < 4.2 && fd > 1.4 || burning) && tick2;
  const k = fd > 3.2 ? 1 : 0.3;
  const [a, b] = safe(dx / fd * k, dz / fd * k);
  return { x: a, y: b, a: fire, b: false };
}
