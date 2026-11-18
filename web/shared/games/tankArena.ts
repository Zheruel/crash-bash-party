/**
 * TANK WARS (game id 'tankArena') - after Crash Bash's Tank Wars.
 *
 * Tanks fight in an arena with obstacles. Fire shells (A, hold to keep firing) and lay mines (B). Every tank has a
 * health bar; a destroyed tank is out for good. Last tank standing wins; when time runs out the tank with the most
 * health wins. Collect extra mines, wumpa fruit (health) and the lobbing bomb from pickups.
 *   Stick = drive / turn (the tank faces the way you steer and fires that way), A = fire, B = lay a mine
 *
 * Variants (world.data.variant) are the four real fox pens, in model units of the stage x TA_K (2.6) = world units,
 * centred on the pen: swamp (SWAMP FOX: open black pit inside a wooden fence) | desert (DESERT FOX: 3x3 camo crates
 * and grates) | jungle (JUNGLE FOX: log fence round a clearing with a stone pedestal) | metal (METAL FOX: 4x3 raised
 * steel crates). The pen is ~4.5x3.7 model units while a tank is ~0.63 wide, so everything here is small compared
 * to the old 20x20 arena. Shells explode on walls and crates; the Super Bounce modifier (params.bounces 5) lets
 * them ricochet 3 times.
 *
 * world.data:
 *   variant: string
 *   blocks:  [cx, cz, halfW, halfD][]   static obstacles of this map (same as TA_MAPS[variant].blocks)
 *   hx, hz:  pen half extents (world units)
 *   hp:      number[4]  health 0..TA_HP (<= 0 = destroyed)
 *   kills / deaths: number[4]
 *   elim:    number[4]  tick of destruction, -1 while alive
 *   mines:   number[4]  mines left to lay (start 3, max 6)
 *   bomb:    number[4]  lobbing-bomb shots left (A fires them instead of shells)
 *   stun:    number[4]  hit flash / slow (s)
 *   inv:     number[4]  spawn protection (s), currently only at the start
 *   mcd, prevB, nextPick: (internal)
 *
 * Bodies:
 *   'tank':   r 0.55, alive=false once destroyed (stays in the list), cd = shell reload (s), face = hull/aim yaw
 *   'bullet': shell, y 0.6, slot = shooter, dash = bounces left, cd = age (s), face = heading
 *   'mine':   slot = owner, cd > 0 while arming (not dangerous yet), dash = remaining life
 *   'pickup': cd = 1 extra mines, 2 wumpa fruit (+health), 3 lobbing bomb
 *   'bomb':   lobbed shell in the air, slot = owner, dash = seconds until it lands (y is the arc height)
 *
 * Events: shoot, lob (bomb thrown), mine (mine laid), explode (mine/bomb blew up at x/z, v=radius),
 *   hit (s=tank damaged, o=attacker or -1 for self/none, v=dmg/TA_HP), ko (s=destroyed tank, o=killer or -1),
 *   bounce (shell off a wall), fizzle (shell spent / cancelled), pickup (s=tank, v=1 mines / 2 fruit / 3 bomb)
 */
import { addBody, clamp, collideCircles, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { angDiff, pickVariant } from './common';

/** world units per stage model unit (stage models are decoded at 1 unit = 1/1024 of PS1 space) */
export const TA_K = 2.6;
export const TA_HP = 16;
const SHELL_DMG = 1, MINE_DMG = 5, BOMB_DMG = 5, FRUIT = 4, MINE_R = 1.25, BOMB_R = 1.4, START_MINES = 3, MAX_MINES = 6;
const TANK_R = 0.55, BULLET_R = 0.16, BULLET_SPEED = 11, TANK_SPEED = 4.6, TURN = 7, LOB_RANGE = 4.6;

type Block = [number, number, number, number];
export interface TankMap { name: string; hx: number; hz: number; blocks: Block[]; spawns: [number, number][] }
const m = (v: number) => +(v * TA_K).toFixed(3);
/** crates on a regular grid, centres in model units (pen-relative), half = half footprint */
const grid = (xs: number[], zs: number[], half: number): Block[] => zs.flatMap((z) => xs.map((x) => [m(x), m(z), m(half), m(half)] as Block));
/**
 * The four pens (centred on the origin, world units). Pen floors measured from the stage models:
 *   metal 689: 4.68x3.66 (crates 0.5 raised tiles on a 1.0 pitch, 4 columns x 3 rows)
 *   desert 693: 4.17x4.17 (3x3 crates at 1.23 pitch)
 *   jungle 691: 4.0x3.7 clearing, stone pedestal 1.0 wide just off centre
 *   swamp: no extracted stage; open pit 5.7x4.8 measured from the original frames (fence line + tank spots)
 */
export const TA_MAPS: Record<string, TankMap> = {
  swamp: { name: 'SWAMP FOX', hx: m(2.85), hz: m(2.4), blocks: [], spawns: [[-2.1, -1.8], [2.1, -1.8], [-2.1, 1.8], [2.1, 1.8]] },
  desert: { name: 'DESERT FOX', hx: m(2.09), hz: m(2.12), blocks: grid([-1.23, 0, 1.23], [-1.23, 0, 1.23], 0.4), spawns: [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]] },
  jungle: { name: 'JUNGLE FOX', hx: m(2.0), hz: m(1.85), blocks: [[m(-0.19), m(0.04), m(0.5), m(0.5)]], spawns: [[-1.5, -1.35], [1.5, -1.35], [-1.5, 1.35], [1.5, 1.35]] },
  metal: { name: 'METAL FOX', hx: m(2.34), hz: m(1.83), blocks: grid([-1.51, -0.51, 0.49, 1.49], [-1, 0, 1], 0.3), spawns: [[-1.95, -1.4], [1.95, -1.4], [-1.95, 1.4], [1.95, 1.4]] },
};
/** Default map (SWAMP FOX); kept for older renderers. Prefer world.data.blocks. */
export const TA_BLOCKS: Block[] = TA_MAPS.swamp.blocks;
export const TA_VARIANTS = [
  { id: 'swamp', name: 'SWAMP FOX' },
  { id: 'desert', name: 'DESERT FOX' },
  { id: 'jungle', name: 'JUNGLE FOX' },
  { id: 'metal', name: 'METAL FOX' },
];

interface Data {
  variant: string;
  blocks: Block[];
  hx: number;
  hz: number;
  hp: number[];
  kills: number[];
  deaths: number[];
  elim: number[];
  mines: number[];
  bomb: number[];
  stun: number[];
  inv: number[];
  mcd: number[];
  prevB: boolean[];
  nextPick: number;
}

const tanks = (w: World) => w.bodies.filter((b) => b.kind === 'tank');
const bullets = (w: World) => w.bodies.filter((b) => b.kind === 'bullet');
const aliveTanks = (w: World) => tanks(w).filter((t) => t.alive);

/** Push a circle out of all blocks; returns the contact normal of the last block touched, if any. */
function resolveBlocks(b: Body, r: number, blocks: Block[]): [number, number] | null {
  let hit: [number, number] | null = null;
  for (const [cx, cz, hw, hd] of blocks) {
    const px = clamp(b.x, cx - hw, cx + hw), pz = clamp(b.z, cz - hd, cz + hd);
    let dx = b.x - px, dz = b.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 < 1e-9) { // centre inside block: push along the shallowest axis
      const ox = hw + r - Math.abs(b.x - cx), oz = hd + r - Math.abs(b.z - cz);
      if (ox < oz) { dx = Math.sign(b.x - cx) || 1; dz = 0; b.x = cx + dx * (hw + r); } else { dz = Math.sign(b.z - cz) || 1; dx = 0; b.z = cz + dz * (hd + r); }
      hit = [dx, dz];
      continue;
    }
    const d = Math.sqrt(d2);
    b.x = px + (dx / d) * r;
    b.z = pz + (dz / d) * r;
    hit = [dx / d, dz / d];
  }
  return hit;
}

/** Is the straight segment a->b blocked by an obstacle block? (slab test; used by bots) */
export function blocked(ax: number, az: number, bx: number, bz: number, blocks: Block[] = TA_BLOCKS): boolean {
  const dx = bx - ax, dz = bz - az;
  for (const [cx, cz, hw, hd] of blocks) {
    let t0 = 0, t1 = 1, miss = false;
    for (const [p, q] of [[-dx, ax - (cx - hw)], [dx, cx + hw - ax], [-dz, az - (cz - hd)], [dz, cz + hd - az]] as [number, number][]) {
      if (Math.abs(p) < 1e-9) { if (q < 0) { miss = true; break; } continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!miss && t0 <= t1) return true;
  }
  return false;
}


/** position along the rectangular lane ring of half extents rx, rz (u = 0 at the top-left corner, clockwise seen from above) */
function ringU(x: number, z: number, rx: number, rz: number): number {
  if (Math.abs(z) / rz >= Math.abs(x) / rx) return z < 0 ? clamp(x, -rx, rx) + rx : 2 * rx + 2 * rz + (rx - clamp(x, -rx, rx));
  return x > 0 ? 2 * rx + clamp(z, -rz, rz) + rz : 4 * rx + 2 * rz + (rz - clamp(z, -rz, rz));
}
function ringPt(u: number, rx: number, rz: number): [number, number] {
  const P = 4 * (rx + rz);
  u = ((u % P) + P) % P;
  if (u < 2 * rx) return [u - rx, -rz];
  u -= 2 * rx;
  if (u < 2 * rz) return [rx, u - rz];
  u -= 2 * rz;
  if (u < 2 * rx) return [rx - u, rz];
  u -= 2 * rx;
  return [-rx, rz - u];
}

function hurt(w: World, d: Data, t: Body, dmg: number, by: number) {
  if (!t.alive || d.inv[t.slot] > 0) return;
  d.hp[t.slot] -= dmg;
  d.stun[t.slot] = 0.5;
  emit(w, 'hit', t.x, t.z, t.slot, dmg / TA_HP, by === t.slot ? -1 : by);
  if (d.hp[t.slot] <= 0) {
    d.hp[t.slot] = 0;
    t.alive = false;
    t.vx = t.vz = 0;
    d.elim[t.slot] = w.tick;
    d.deaths[t.slot]++;
    if (by >= 0 && by !== t.slot) d.kills[by]++;
    emit(w, 'ko', t.x, t.z, t.slot, 1, by === t.slot ? -1 : by);
  }
}

function explode(w: World, d: Data, x: number, z: number, radius: number, dmg: number, by: number) {
  emit(w, 'explode', x, z, -1, radius, by);
  for (const t of aliveTanks(w)) {
    const dx = t.x - x, dz = t.z - z, dd = Math.hypot(dx, dz);
    if (dd > radius + t.r * 0.5) continue;
    const l = dd || 1;
    t.vx += (dx / l) * 4; t.vz += (dz / l) * 4;
    hurt(w, d, t, dmg, by);
  }
}

function freeSpot(w: World, d: Data): [number, number] {
  let x = 0, z = 0;
  for (let k = 0; k < 20; k++) {
    x = (rand(w) * 2 - 1) * (d.hx - 0.7);
    z = (rand(w) * 2 - 1) * (d.hz - 0.7);
    if (!d.blocks.some(([cx, cz, hw, hd]) => Math.abs(x - cx) < hw + 0.6 && Math.abs(z - cz) < hd + 0.6)) break;
  }
  return [x, z];
}

export const tankArena: MiniGame = {
  id: 'tankArena',
  name: 'Tank Wars',
  description: 'Destroy all of your opponents\' tanks. Fire shells, lay mines, collect fruit. Last tank standing - or most health when time runs out - wins.',
  controls: 'Steer to move and aim. Space: fire. Shift: drop a mine.',
  variants: TA_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, TA_VARIANTS);
    const map = TA_MAPS[variant];
    const d: Data = {
      variant, blocks: map.blocks.map((b) => [...b] as Block), hx: map.hx, hz: map.hz, hp: [], kills: [], deaths: [], elim: [], mines: [], bomb: [], stun: [], inv: [], mcd: [], prevB: [false, false, false, false], nextPick: 6,
    };
    for (let i = 0; i < MAX_SEATS; i++) { d.hp.push(TA_HP); d.kills.push(0); d.deaths.push(0); d.elim.push(-1); d.mines.push(START_MINES); d.bomb.push(0); d.stun.push(0); d.inv.push(0.8); d.mcd.push(0); }
    w.data = d;
    for (const s of slots) {
      const [x, z] = map.spawns[s.slot].map((v) => v * TA_K);
      const b = addBody(w, 'tank', s.slot, x, z, TANK_R, 4);
      b.face = Math.atan2(-x, -z);
      b.cd = 0.6; // reload timer
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ts = aliveTanks(w);

    // pickups
    if (w.time >= d.nextPick && ts.length > 1) {
      d.nextPick = w.time + 6 + rand(w) * 3;
      if (w.bodies.filter((b) => b.kind === 'pickup').length < 3) {
        const [x, z] = freeSpot(w, d);
        const p = addBody(w, 'pickup', -1, x, z, 0.45, 1);
        const r = rand(w);
        p.cd = r < 0.35 ? 1 : r < 0.75 ? 2 : 3;
      }
    }

    for (const t of ts) {
      const inp = inputs[t.slot] ?? IDLE;
      const s = t.slot;
      d.inv[s] = Math.max(0, d.inv[s] - dt);
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.mcd[s] = Math.max(0, d.mcd[s] - dt);
      const mag = Math.min(1, Math.hypot(inp.x, inp.y));
      const sp = TANK_SPEED * w.params.speed * (d.stun[s] > 0 ? 0.5 : 1);
      if (mag > 0.15) {
        const want = Math.atan2(inp.x, inp.y);
        const step = TURN * dt;
        t.face += clamp(angDiff(t.face, want), -step, step);
        const align = Math.abs(angDiff(t.face, want));
        const go = align < 0.8 ? mag * (1 - align / 1.2) : 0;
        t.vx = Math.sin(t.face) * sp * go;
        t.vz = Math.cos(t.face) * sp * go;
      } else { t.vx *= 0.7; t.vz *= 0.7; }
      t.x += t.vx * dt;
      t.z += t.vz * dt;
      t.cd -= dt;
      if (inp.a && t.cd <= 0) {
        if (d.bomb[s] > 0) { // lobbing bomb: flies over obstacles and lands 7 units ahead
          d.bomb[s]--;
          t.cd = 1.2 / w.params.fireRate;
          const tx = clamp(t.x + Math.sin(t.face) * LOB_RANGE, -(d.hx - 0.3), d.hx - 0.3), tz = clamp(t.z + Math.cos(t.face) * LOB_RANGE, -(d.hz - 0.3), d.hz - 0.3);
          const b = addBody(w, 'bomb', s, t.x, t.z, 0.25, 0.3);
          b.vx = (tx - t.x) / 0.9; b.vz = (tz - t.z) / 0.9; b.dash = 0.9; b.face = t.face;
          emit(w, 'lob', t.x, t.z, s, 1);
        } else {
          t.cd = 1.4 / w.params.fireRate;
          const bl = addBody(w, 'bullet', s, t.x + Math.sin(t.face) * (TANK_R + 0.2), t.z + Math.cos(t.face) * (TANK_R + 0.2), BULLET_R, 0.3);
          bl.y = 0.5;
          bl.vx = Math.sin(t.face) * BULLET_SPEED;
          bl.vz = Math.cos(t.face) * BULLET_SPEED;
          bl.face = t.face;
          bl.dash = Math.max(0, w.params.bounces - 2); // wall bounces left (0 = explodes on the first wall)
          bl.cd = 0; // age
          emit(w, 'shoot', t.x, t.z, s, 1);
        }
      }
      if (inp.b && !d.prevB[s] && d.mcd[s] <= 0 && d.mines[s] > 0) {
        d.mines[s]--;
        d.mcd[s] = 0.7;
        const m = addBody(w, 'mine', s, t.x - Math.sin(t.face) * 0.95, t.z - Math.cos(t.face) * 0.95, 0.3, 1);
        m.cd = 1.0; // arming time
        m.dash = 40;
        emit(w, 'mine', m.x, m.z, s, 1);
      }
      d.prevB[s] = inp.b;
      t.x = clamp(t.x, -(d.hx - t.r), d.hx - t.r);
      t.z = clamp(t.z, -(d.hz - t.r), d.hz - t.r);
      resolveBlocks(t, t.r, d.blocks);
    }
    for (let i = 0; i < ts.length; i++)
      for (let j = i + 1; j < ts.length; j++) collideCircles(ts[i], ts[j], 0.1);
    for (const t of ts) { // keep out of walls again after tank-tank pushing
      t.x = clamp(t.x, -(d.hx - t.r), d.hx - t.r);
      t.z = clamp(t.z, -(d.hz - t.r), d.hz - t.r);
      resolveBlocks(t, t.r, d.blocks);
    }

    // pickups
    for (const p of w.bodies.filter((b) => b.kind === 'pickup')) {
      for (const t of ts) {
        if (!t.alive || Math.hypot(t.x - p.x, t.z - p.z) > t.r + p.r) continue;
        if (p.cd === 1) d.mines[t.slot] = Math.min(MAX_MINES, d.mines[t.slot] + 3);
        else if (p.cd === 2) d.hp[t.slot] = Math.min(TA_HP, d.hp[t.slot] + FRUIT);
        else d.bomb[t.slot] += 2;
        emit(w, 'pickup', p.x, p.z, t.slot, p.cd);
        w.bodies = w.bodies.filter((b) => b !== p);
        break;
      }
    }

    const dead = new Set<number>();
    // mines
    const mines = w.bodies.filter((b) => b.kind === 'mine');
    const boom = (m: Body) => {
      if (dead.has(m.id)) return;
      dead.add(m.id);
      explode(w, d, m.x, m.z, MINE_R, MINE_DMG, m.slot);
      for (const o of mines) if (!dead.has(o.id) && Math.hypot(o.x - m.x, o.z - m.z) < MINE_R) boom(o); // chain reaction
    };
    for (const m of mines) {
      m.cd = Math.max(0, m.cd - dt);
      m.dash -= dt;
      if (m.dash <= 0) { dead.add(m.id); continue; }
      if (m.cd > 0) continue;
      for (const t of aliveTanks(w)) if (Math.hypot(t.x - m.x, t.z - m.z) < t.r + m.r) { boom(m); break; }
    }

    // lobbed bombs
    for (const b of w.bodies.filter((q) => q.kind === 'bomb')) {
      b.dash -= dt;
      b.x += b.vx * dt; b.z += b.vz * dt;
      const u = clamp(1 - b.dash / 0.9, 0, 1);
      b.y = 2.2 * 4 * u * (1 - u);
      if (b.dash <= 0) { dead.add(b.id); explode(w, d, b.x, b.z, BOMB_R, BOMB_DMG, b.slot); }
    }

    // bullets
    const bs = bullets(w);
    for (const b of bs) {
      b.cd += dt;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      let bounced = false;
      const lx = d.hx - b.r, lz = d.hz - b.r;
      if (Math.abs(b.x) > lx) { b.x = clamp(b.x, -lx, lx); b.vx = -b.vx; bounced = true; }
      if (Math.abs(b.z) > lz) { b.z = clamp(b.z, -lz, lz); b.vz = -b.vz; bounced = true; }
      const n = resolveBlocks(b, b.r, d.blocks);
      if (n) {
        const vn = b.vx * n[0] + b.vz * n[1];
        if (vn < 0) { b.vx -= 2 * vn * n[0]; b.vz -= 2 * vn * n[1]; }
        bounced = true;
      }
      if (bounced) {
        b.face = Math.atan2(b.vx, b.vz);
        emit(w, 'bounce', b.x, b.z, -1, 0.5);
        if (--b.dash < 0) { dead.add(b.id); emit(w, 'fizzle', b.x, b.z, -1, 0.4); continue; }
      }
      if (b.cd > 8) { dead.add(b.id); continue; }
      for (const m of mines) { // shells detonate mines
        if (dead.has(m.id) || dead.has(b.id)) continue;
        if (Math.hypot(m.x - b.x, m.z - b.z) < m.r + b.r) { dead.add(b.id); boom(m); }
      }
      for (const t of ts) {
        if (!t.alive || dead.has(b.id)) continue;
        if (t.slot === b.slot && b.cd < 0.25) continue;
        const dx = t.x - b.x, dz = t.z - b.z, rr = t.r + b.r;
        if (dx * dx + dz * dz > rr * rr) continue;
        dead.add(b.id);
        if (d.inv[t.slot] > 0) { emit(w, 'bounce', b.x, b.z, -1, 0.3); continue; }
        t.vx += b.vx * 0.2; t.vz += b.vz * 0.2;
        hurt(w, d, t, SHELL_DMG, b.slot);
      }
    }
    for (let i = 0; i < bs.length; i++) // opposing shots cancel out
      for (let j = i + 1; j < bs.length; j++) {
        if (dead.has(bs[i].id) || dead.has(bs[j].id) || bs[i].slot === bs[j].slot) continue;
        if (Math.hypot(bs[i].x - bs[j].x, bs[i].z - bs[j].z) < BULLET_R * 2) {
          dead.add(bs[i].id); dead.add(bs[j].id);
          emit(w, 'fizzle', bs[i].x, bs[i].z, -1, 1);
        }
      }
    if (dead.size) w.bodies = w.bodies.filter((b) => !dead.has(b.id));
  },

  isOver(w) {
    return aliveTanks(w).length <= 1 || w.time >= tankArena.maxTime;
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const aa = d.hp[a] > 0, bb = d.hp[b] > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.hp[b] - d.hp[a] || d.kills[b] - d.kills[a] || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'tank' && b.slot === slot && b.alive);
    if (!me) return IDLE;
    const d = w.data as Data;
    let foe: Body | null = null, fd = Infinity;
    for (const t of aliveTanks(w)) {
      if (t.slot === slot) continue;
      const dd = Math.hypot(t.x - me.x, t.z - me.z);
      if (dd < fd) { fd = dd; foe = t; }
    }
    if (!foe) return IDLE;
    // sidestep the nearest incoming bullet
    for (const b of bullets(w)) {
      if (b.slot === slot && b.cd < 0.6) continue;
      const rx = me.x - b.x, rz = me.z - b.z;
      if (Math.hypot(rx, rz) > 3.6) continue;
      const sp = Math.hypot(b.vx, b.vz) || 1;
      const along = (rx * b.vx + rz * b.vz) / sp;
      const side = (rx * -b.vz + rz * b.vx) / sp;
      if (along > 0 && Math.abs(side) < 0.9) {
        const s = side >= 0 ? 1 : -1;
        return { x: (-b.vz / sp) * s, y: (b.vx / sp) * s, a: false, b: false };
      }
    }
    // keep clear of mines
    let rx = 0, rz = 0;
    for (const m of w.bodies) {
      if (m.kind !== 'mine') continue;
      const dx = me.x - m.x, dz = me.z - m.z, dd = Math.hypot(dx, dz);
      if (dd < 1.9) { rx += (dx / (dd || 1)) * (1.9 - dd); rz += (dz / (dd || 1)) * (1.9 - dd); }
    }
    const dx = foe.x - me.x, dz = foe.z - me.z;
    const ux = dx / (fd || 1), uz = dz / (fd || 1);
    const err = Math.abs(angDiff(me.face, Math.atan2(dx, dz)));
    const clear = !blocked(me.x, me.z, foe.x, foe.z, d.blocks);
    let mx = ux, mz = uz;
    if (clear && fd < 3) { mx = ux * 0.16; mz = uz * 0.16; } // hold ground, keep aiming
    else if (!clear && d.blocks.length >= 6) { // crate field: only the lane ring round it is passable, follow it towards the foe
      const rx = d.hx - 0.65, rz = d.hz - 0.65, P = 4 * (rx + rz);
      let du = (ringU(foe.x, foe.z, rx, rz) - ringU(me.x, me.z, rx, rz)) % P;
      if (du > P / 2) du -= P; else if (du < -P / 2) du += P;
      const [px, pz] = ringPt(ringU(me.x, me.z, rx, rz) + Math.sign(du || 1) * 1.8, rx, rz);
      const l = Math.hypot(px - me.x, pz - me.z) || 1;
      mx = (px - me.x) / l; mz = (pz - me.z) / l;
    } else if (!clear) { const k = slot % 2 ? 1 : -1; mx = ux - uz * k * 0.9; mz = uz + ux * k * 0.9; }
    // grab pickups we need when nobody is close
    if (fd > 4) {
      let pk: Body | null = null, pd = Infinity;
      for (const p of w.bodies) {
        if (p.kind !== 'pickup') continue;
        const want = p.cd === 2 ? d.hp[slot] <= TA_HP - 4 : p.cd === 1 ? d.mines[slot] < 3 : d.bomb[slot] < 2;
        const dd = Math.hypot(p.x - me.x, p.z - me.z);
        if (want && dd < pd && dd < 7) { pd = dd; pk = p; }
      }
      if (pk) { mx = (pk.x - me.x) / pd; mz = (pk.z - me.z) / pd; }
    }
    mx += rx * 0.8; mz += rz * 0.8;
    // lay a mine when a foe is chasing from behind
    const behind = Math.abs(angDiff(me.face, Math.atan2(dx, dz))) > 2.3;
    const out: InputState = { x: clamp(mx, -1, 1), y: clamp(mz, -1, 1), a: false, b: false };
    out.b = behind && fd < 3.6 && d.mines[slot] > 0 && d.mcd[slot] <= 0 && w.tick % 4 === 0;
    const lob = d.bomb[slot] > 0;
    out.a = lob ? err < 0.25 && fd < LOB_RANGE + 1.5 : clear && err < 0.13 && fd < 12;
    return out;
  },
};
