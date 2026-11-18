/**
 * CRATE CRUSH (game id 'crateToss') - after Crash Bash's Crate Crush.
 *
 * Pick up crates and throw them at your rivals (or kick them). Each player has a health bar; last one standing
 * wins, when time runs out the most health wins. Three crate kinds fall from the sky:
 *   wood  - plain crate, a throw/kick that connects hurts and the crate smashes
 *   TNT   - starts a 3 s fuse when picked up or kicked, then explodes wherever it is (also in your hands!)
 *   nitro - explodes on impact: when it hits a player, a wall, lands after a throw/kick, or is dropped by a
 *           player who gets hurt while carrying it. Explosions also set off nearby nitro/TNT.
 * Pickups: wumpa fruit (+health), speedy boots, slow-motion potion (DRAIN BASH only - avoid it).
 *   Stick = move, A = pick up a crate / throw it, B = kick a crate in front of you (otherwise jump; jump to dodge)
 *
 * Variants (world.data.variant): jungle (JUNGLE BASH, plain) |
 *   space (SPACE BASH: explosions blow holes in the floor - fall in and you are out) |
 *   snow (SNOW BASH: slippery ice floor) | drain (DRAIN BASH: slow-motion potions about)
 *
 * world.data:
 *   variant: string
 *   hp:      number[4]  health 0..CT_HP (<= 0 = out)
 *   score:   number[4]  hits landed (crates + explosions); taken: number[4] damage events suffered
 *   elim:    number[4]  tick the player went out, -1 while alive
 *   stun:    number[4]  seconds stunned (cannot act)
 *   boots / slow: number[4]  seconds of speedy boots / slow motion left
 *   floor:   number[]   [space only] CT_FLOOR_N*CT_FLOOR_N flags, 1 = floor present, 0 = hole (row-major z*N+x);
 *                       [] on the other maps (solid floor everywhere)
 *   prevA, prevB, nextSpawn, nextPickup, lastBy, lastByTick: (internal)
 *
 * Bodies:
 *   'player': alive=false once out; fall=true while dropping through a hole
 *   'crate' / 'tnt' / 'nitro': cd = holder slot + 1 (0 = on the floor / flying), dash = remaining flight time
 *       (> 0 = a thrown or kicked, dangerous crate), slot = last thrower (-1 none), y > 0 while falling in.
 *       tnt only: fall = true once lit, m = seconds of fuse left (3 until lit)
 *   'fruit' | 'boots' | 'potion': pickups lying on the floor
 *
 * Events: grab, throw, kick (s=slot), hit (s=victim, o=attacker or -1, v=dmg/CT_HP), smash (wood crate broke),
 *   bounce, land, explode (v=radius, o=who lit/threw it or -1), lit (TNT fuse started), pickup (s=slot,
 *   v=1 fruit / 2 boots / 3 potion), ko (s=player out, o=attacker or -1), hole (floor square destroyed at x/z),
 *   jump (from movePlayer)
 */
import { addBody, clamp, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { angDiff, pickVariant } from './common';

export const CT_HALF = 9;
export const CT_HP = 10;
export const CT_FLOOR_N = 9; // space bash floor grid (squares are 2 units)
const CT_TILE = (CT_HALF * 2) / CT_FLOOR_N;
const GRAB_RANGE = 1.9, THROW_SPEED = 15, KICK_SPEED = 13, FLY_TIME = 0.9, STUN = 1.0, MAX_CRATES = 8, FUSE = 3;
const AIM_CONE = 0.45; // radians of aim assist toward the nearest rival
const WOOD_DMG = 2, TNT_DMG = 4, NITRO_DMG = 5, TNT_R = 2.6, NITRO_R = 3.0;
const CRATE_KINDS = ['crate', 'tnt', 'nitro'];

export const CT_VARIANTS = [
  { id: 'jungle', name: 'JUNGLE BASH' },
  { id: 'space', name: 'SPACE BASH' },
  { id: 'snow', name: 'SNOW BASH' },
  { id: 'drain', name: 'DRAIN BASH' },
];

interface Data {
  variant: string;
  hp: number[];
  score: number[];
  taken: number[];
  elim: number[];
  stun: number[];
  boots: number[];
  slow: number[];
  floor: number[];
  prevA: boolean[];
  prevB: boolean[];
  lastBy: number[];
  lastByTick: number[];
  nextSpawn: number;
  nextPickup: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const isCrate = (b: Body) => CRATE_KINDS.includes(b.kind);
const crates = (w: World) => w.bodies.filter((b) => isCrate(b) && b.alive);
const holding = (w: World, slot: number) => crates(w).find((c) => c.cd === slot + 1);
const aliveCount = (w: World) => players(w).filter((p) => p.alive).length;

/** Is there floor under (x, z)? Always true outside the space map. */
export function floorAt(d: { floor: number[] }, x: number, z: number): boolean {
  if (!d.floor.length) return true;
  const tx = Math.floor((x + CT_HALF) / CT_TILE), tz = Math.floor((z + CT_HALF) / CT_TILE);
  if (tx < 0 || tz < 0 || tx >= CT_FLOOR_N || tz >= CT_FLOOR_N) return true; // walls / edges count as solid
  return d.floor[tz * CT_FLOOR_N + tx] === 1;
}

function hurt(w: World, d: Data, p: Body, dmg: number, by: number, stun = STUN) {
  if (!p.alive || p.fall) return;
  d.hp[p.slot] -= dmg;
  d.taken[p.slot]++;
  d.stun[p.slot] = Math.max(d.stun[p.slot], stun);
  if (by >= 0 && by !== p.slot) { d.score[by]++; d.lastBy[p.slot] = by; d.lastByTick[p.slot] = w.tick; }
  emit(w, 'hit', p.x, p.z, p.slot, dmg / CT_HP, by === p.slot ? -1 : by);
  const h = holding(w, p.slot);
  if (h) { // hurt while carrying: drop it (nitro goes off in your arms)
    h.cd = 0; h.y = 0.5; h.vx = h.vz = 0;
    if (h.kind === 'nitro') blast(w, d, h, by);
  }
  if (d.hp[p.slot] <= 0 && p.alive) knockOut(w, d, p, by === p.slot ? -1 : by);
}

function knockOut(w: World, d: Data, p: Body, by: number) {
  d.hp[p.slot] = 0;
  p.alive = false;
  p.vx = p.vz = 0;
  d.elim[p.slot] = w.tick;
  const h = holding(w, p.slot);
  if (h) { h.cd = 0; h.y = 0.5; }
  emit(w, 'ko', p.x, p.z, p.slot, 1, by);
}

function destroyFloor(w: World, d: Data, x: number, z: number, radius: number) {
  if (!d.floor.length) return;
  for (let i = 0; i < d.floor.length; i++) {
    if (!d.floor[i]) continue;
    if (d.floor.reduce((a, b) => a + b, 0) <= 36) return; // keep a playable core
    const cx = ((i % CT_FLOOR_N) + 0.5) * CT_TILE - CT_HALF, cz = (Math.floor(i / CT_FLOOR_N) + 0.5) * CT_TILE - CT_HALF;
    if (Math.hypot(cx - x, cz - z) <= radius) { d.floor[i] = 0; emit(w, 'hole', cx, cz, -1, 1); }
  }
}

/** A TNT/nitro crate detonates. Chains to neighbouring nitro (blast) and TNT (fuse shortened). */
function blast(w: World, d: Data, c: Body, by: number) {
  if (!c.alive) return;
  c.alive = false;
  c.cd = 0;
  const nitro = c.kind === 'nitro';
  const radius = nitro ? NITRO_R : TNT_R, dmg = nitro ? NITRO_DMG : TNT_DMG;
  emit(w, 'explode', c.x, c.z, -1, radius, by);
  for (const p of players(w)) {
    if (!p.alive || p.fall) continue;
    const dx = p.x - c.x, dz = p.z - c.z, dd = Math.hypot(dx, dz);
    if (dd > radius + p.r * 0.5 || p.y > 2) continue;
    const l = dd || 1;
    p.vx += (dx / l) * 9; p.vz += (dz / l) * 9; p.vy = 5;
    hurt(w, d, p, dmg, by, 1.2);
  }
  for (const o of crates(w)) {
    if (o === c || Math.hypot(o.x - c.x, o.z - c.z) > radius) continue;
    if (o.kind === 'nitro') blast(w, d, o, by);
    else if (o.kind === 'tnt') { if (!o.fall) { o.fall = true; o.m = 0.3; } else o.m = Math.min(o.m, 0.3); }
  }
  destroyFloor(w, d, c.x, c.z, radius * 0.9);
}

function light(w: World, c: Body) {
  if (c.kind === 'tnt' && !c.fall) { c.fall = true; c.m = FUSE; emit(w, 'lit', c.x, c.z, -1, 1); }
}

function spawnCrate(w: World, d: Data) {
  let x = 0, z = 0;
  for (let k = 0; k < 12; k++) {
    x = (rand(w) * 2 - 1) * (CT_HALF - 1.5);
    z = (rand(w) * 2 - 1) * (CT_HALF - 1.5);
    if (floorAt(d, x, z)) break;
  }
  const r = rand(w);
  const kind = r < 0.55 ? 'crate' : r < 0.85 ? 'tnt' : 'nitro';
  const c = addBody(w, kind, -1, x, z, 0.55, 1);
  c.y = 9;
  c.vy = 0;
  c.face = rand(w) * Math.PI * 2;
  if (kind === 'tnt') c.m = FUSE;
}

export const crateToss: MiniGame = {
  id: 'crateToss',
  name: 'Crate Crush',
  description: 'Pick up and throw crates at your opponents. TNT counts down, nitro explodes on impact. Last one standing - or most health - wins.',
  controls: 'Space: pick up crate, press again to throw. Shift: kick a crate (or jump).',
  variants: CT_VARIANTS,
  maxTime: 100,

  setup(w, slots) {
    const variant = pickVariant(w, CT_VARIANTS);
    const d: Data = {
      variant, hp: [CT_HP, CT_HP, CT_HP, CT_HP], score: [0, 0, 0, 0], taken: [0, 0, 0, 0], elim: [-1, -1, -1, -1], stun: [0, 0, 0, 0],
      boots: [0, 0, 0, 0], slow: [0, 0, 0, 0], floor: variant === 'space' ? new Array(CT_FLOOR_N * CT_FLOOR_N).fill(1) : [],
      prevA: [false, false, false, false], prevB: [false, false, false, false], lastBy: [-1, -1, -1, -1], lastByTick: [-99, -99, -99, -99],
      nextSpawn: 0.3, nextPickup: 8,
    };
    w.data = d;
    const c = CT_HALF - 2;
    const spawns: [number, number][] = [[-c, -c], [c, -c], [-c, c], [c, c]];
    for (const s of slots) {
      const sc = w.params.playerScale;
      const [x, z] = spawns[s.slot];
      const b = addBody(w, 'player', s.slot, x, z, 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-x, -z);
    }
    void MAX_SEATS;
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ps = players(w);
    const live = ps.filter((p) => p.alive);

    // spawn rain
    d.nextSpawn -= dt;
    if (d.nextSpawn <= 0 && crates(w).length < MAX_CRATES && aliveCount(w) > 1) {
      spawnCrate(w, d);
      d.nextSpawn = (1.5 + rand(w) * 1.2) / w.params.spawnRate;
    }
    // pickups
    if (w.time >= d.nextPickup && live.length > 1) {
      d.nextPickup = w.time + 7 + rand(w) * 4;
      const pk = w.bodies.filter((b) => b.kind === 'fruit' || b.kind === 'boots' || b.kind === 'potion');
      if (pk.length < 2) {
        const hurtSomeone = live.some((p) => d.hp[p.slot] < CT_HP - 2);
        const r = rand(w);
        const kind = d.variant === 'drain' && r < 0.4 ? 'potion' : hurtSomeone && r < 0.75 ? 'fruit' : r < 0.9 ? 'boots' : 'fruit';
        let x = 0, z = 0;
        for (let k = 0; k < 12; k++) { x = (rand(w) * 2 - 1) * (CT_HALF - 1.5); z = (rand(w) * 2 - 1) * (CT_HALF - 1.5); if (floorAt(d, x, z)) break; }
        addBody(w, kind, -1, x, z, 0.5, 1);
      }
    }

    const grip = d.variant === 'snow' ? 3.2 : 12;
    for (const p of ps) {
      if (!p.alive) continue;
      const inp = inputs[p.slot] ?? IDLE;
      const slot = p.slot;
      if (p.fall) { // dropping through a hole
        movePlayer(w, p, IDLE, dt, grip, 6);
        if (p.y < -15) { p.alive = false; p.vx = p.vz = p.vy = 0; }
        continue;
      }
      d.stun[slot] = Math.max(0, d.stun[slot] - dt);
      d.boots[slot] = Math.max(0, d.boots[slot] - dt);
      d.slow[slot] = Math.max(0, d.slow[slot] - dt);
      const stunned = d.stun[slot] > 0;
      const held = holding(w, slot);
      const aRise = inp.a && !d.prevA[slot], bRise = inp.b && !d.prevB[slot];
      d.prevA[slot] = inp.a; d.prevB[slot] = inp.b;
      let jump = false;
      if (aRise && !stunned) {
        if (held) {
          // aim assist: snap toward the closest rival inside a cone
          let face = p.face, best = AIM_CONE;
          for (const o of live) {
            if (o.slot === slot) continue;
            const diff = Math.abs(angDiff(p.face, Math.atan2(o.x - p.x, o.z - p.z)));
            if (diff < best) { best = diff; face = Math.atan2(o.x - p.x, o.z - p.z); }
          }
          p.face = face;
          held.cd = 0;
          held.x = p.x + Math.sin(face) * (p.r + 0.7);
          held.z = p.z + Math.cos(face) * (p.r + 0.7);
          held.y = 0.9;
          held.vx = Math.sin(face) * THROW_SPEED;
          held.vz = Math.cos(face) * THROW_SPEED;
          held.dash = FLY_TIME;
          held.slot = slot;
          light(w, held);
          emit(w, 'throw', p.x, p.z, slot, 1);
        } else {
          let best: Body | null = null, bd = GRAB_RANGE;
          for (const c of crates(w)) {
            if (c.cd !== 0 || c.dash > 0 || c.y > 0.3) continue;
            const dd = Math.hypot(c.x - p.x, c.z - p.z);
            if (dd < bd) { bd = dd; best = c; }
          }
          if (best) { best.cd = slot + 1; best.vx = best.vz = 0; best.slot = slot; light(w, best); emit(w, 'grab', best.x, best.z, slot, 1); }
        }
      }
      if (bRise && !stunned) {
        let best: Body | null = null, bd = 1.9;
        if (!held) {
          for (const c of crates(w)) {
            if (c.cd !== 0 || c.dash > 0 || c.y > 0.4) continue;
            const dd = Math.hypot(c.x - p.x, c.z - p.z);
            if (dd < bd && Math.abs(angDiff(p.face, Math.atan2(c.x - p.x, c.z - p.z))) < 1.1) { bd = dd; best = c; }
          }
        }
        if (best) {
          let face = p.face, bestA = AIM_CONE;
          for (const o of live) {
            if (o.slot === slot) continue;
            const diff = Math.abs(angDiff(p.face, Math.atan2(o.x - p.x, o.z - p.z)));
            if (diff < bestA) { bestA = diff; face = Math.atan2(o.x - p.x, o.z - p.z); }
          }
          best.vx = Math.sin(face) * KICK_SPEED; best.vz = Math.cos(face) * KICK_SPEED;
          best.y = 0.5; best.dash = FLY_TIME * 0.9; best.slot = slot;
          light(w, best);
          emit(w, 'kick', p.x, p.z, slot, 1);
        } else jump = true;
      }
      const spd = 6.4 * (held ? 0.85 : 1) * (d.boots[slot] > 0 ? 1.45 : 1) * (d.slow[slot] > 0 ? 0.5 : 1);
      movePlayer(w, p, stunned ? IDLE : { x: inp.x, y: inp.y, a: jump, b: false }, dt, grip, spd);
      // pickups
      for (const o of w.bodies) {
        if (!(o.kind === 'fruit' || o.kind === 'boots' || o.kind === 'potion') || !o.alive || p.y > 0.8) continue;
        if (Math.hypot(o.x - p.x, o.z - p.z) > p.r + o.r) continue;
        o.alive = false;
        if (o.kind === 'fruit') { d.hp[slot] = Math.min(CT_HP, d.hp[slot] + 3); emit(w, 'pickup', o.x, o.z, slot, 1); }
        else if (o.kind === 'boots') { d.boots[slot] = 8; emit(w, 'pickup', o.x, o.z, slot, 2); }
        else { d.slow[slot] = 6; emit(w, 'pickup', o.x, o.z, slot, 3); }
      }
    }
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++)
        if (!live[i].fall && !live[j].fall && Math.abs(live[i].y - live[j].y) < 1.2) collideCircles(live[i], live[j], 0.7, effMass(live[i]), effMass(live[j]));
    for (const p of live) {
      if (p.fall) continue;
      const lim = CT_HALF - p.r;
      p.x = clamp(p.x, -lim, lim);
      p.z = clamp(p.z, -lim, lim);
      // space bash: no floor under you = you fall
      if (p.y <= 0.05 && !floorAt(d, p.x, p.z)) {
        p.fall = true;
        d.hp[p.slot] = 0;
        d.elim[p.slot] = w.tick;
        const by = w.tick - d.lastByTick[p.slot] < 90 ? d.lastBy[p.slot] : -1;
        const h = holding(w, p.slot);
        if (h) { h.cd = 0; h.y = 0.5; }
        emit(w, 'ko', p.x, p.z, p.slot, 1, by);
      }
    }

    // crates
    for (const c of crates(w)) {
      if (!c.alive) continue;
      if (c.kind === 'tnt' && c.fall) { // lit fuse
        c.m -= dt;
        if (c.m <= 0) { blast(w, d, c, c.slot); continue; }
      }
      if (c.cd > 0) { // carried: float above the holder
        const p = live.find((q) => q.slot === c.cd - 1);
        if (!p || p.fall) { c.cd = 0; continue; }
        c.x = p.x + Math.sin(p.face) * 0.2;
        c.z = p.z + Math.cos(p.face) * 0.2;
        c.y = p.y + 1.9 * (p.r / 0.7 > 1 ? p.r / 0.7 : 1);
        c.face = p.face;
        continue;
      }
      if (c.dash > 0) {
        c.dash -= dt;
        c.x += c.vx * dt;
        c.z += c.vz * dt;
        c.face += dt * 10;
        const lim = CT_HALF - c.r;
        let hitWall = false;
        if (Math.abs(c.x) > lim) { c.x = clamp(c.x, -lim, lim); c.vx = -c.vx * 0.5; hitWall = true; }
        if (Math.abs(c.z) > lim) { c.z = clamp(c.z, -lim, lim); c.vz = -c.vz * 0.5; hitWall = true; }
        if (hitWall) {
          emit(w, 'bounce', c.x, c.z, -1, 0.6);
          if (c.kind === 'nitro') { blast(w, d, c, c.slot); continue; }
          c.dash = 0;
        }
        let struck = false;
        for (const p of live) {
          if (p.slot === c.slot || p.fall || p.y > 0.6) continue;
          if (Math.hypot(p.x - c.x, p.z - c.z) > p.r + c.r) continue;
          struck = true;
          if (c.kind === 'nitro') { blast(w, d, c, c.slot); break; }
          const sp = Math.hypot(c.vx, c.vz) || 1;
          p.vx = (c.vx / sp) * 7; p.vz = (c.vz / sp) * 7; p.vy = 4;
          if (c.kind === 'crate') {
            hurt(w, d, p, WOOD_DMG, c.slot);
            emit(w, 'smash', c.x, c.z, -1, 1);
            c.alive = false;
          } else { // TNT thuds off the player and keeps burning
            hurt(w, d, p, 1, c.slot, 0.5);
            c.vx *= -0.3; c.vz *= -0.3; c.dash = 0;
          }
          break;
        }
        if (struck || !c.alive) continue;
        if (c.dash <= 0 && c.kind === 'nitro') { blast(w, d, c, c.slot); continue; } // landed after the throw
        continue;
      }
      // free crate: gravity, friction, bounce off walls; falls into holes
      const hole = !floorAt(d, c.x, c.z);
      if (c.y > 0 || c.vy !== 0 || hole) {
        c.vy -= 24 * dt;
        c.y += c.vy * dt;
        if (c.y <= 0 && !hole) { c.y = 0; if (c.vy < -3) emit(w, 'land', c.x, c.z, -1, Math.min(1, -c.vy / 16)); c.vy = 0; }
        if (c.y < -10) { c.alive = false; continue; }
      }
      c.x += c.vx * dt;
      c.z += c.vz * dt;
      c.vx *= 0.9; c.vz *= 0.9;
      const lim = CT_HALF - c.r;
      c.x = clamp(c.x, -lim, lim);
      c.z = clamp(c.z, -lim, lim);
    }
    // pickups on holes vanish
    for (const o of w.bodies) if ((o.kind === 'fruit' || o.kind === 'boots' || o.kind === 'potion') && o.alive && !floorAt(d, o.x, o.z)) o.alive = false;
    w.bodies = w.bodies.filter((b) => b.alive || b.kind === 'player');
  },

  isOver(w) {
    return aliveCount(w) <= 1 || w.time >= crateToss.maxTime;
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const aa = d.hp[a] > 0, bb = d.hp[b] > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.hp[b] - d.hp[a] || d.score[b] - d.score[a] || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot && b.alive);
    if (!me || me.fall) return IDLE;
    const d = w.data as Data;
    if (d.stun[slot] > 0) return IDLE;
    const held = holding(w, slot);
    const foes = players(w).filter((o) => o.alive && !o.fall && o.slot !== slot);
    let foe: Body | null = null, fd = Infinity;
    for (const o of foes) {
      const dd = Math.hypot(o.x - me.x, o.z - me.z);
      if (dd < fd) { fd = dd; foe = o; }
    }
    // 1. get away from lit TNT / flying nitro (unless it is the one in my hands)
    let fx = 0, fz = 0, danger = false;
    for (const c of crates(w)) {
      if (c === held) continue;
      const hot = (c.kind === 'tnt' && c.fall && c.m < 2.4) || (c.kind === 'nitro' && c.dash > 0);
      if (!hot) continue;
      const dx = me.x - c.x, dz = me.z - c.z, dd = Math.hypot(dx, dz);
      if (dd < 3.6) { fx += dx / (dd || 1); fz += dz / (dd || 1); danger = true; }
    }
    // keep off potions and holes
    const safe = (dx: number, dz: number): [number, number] => {
      if (!d.floor.length) return [dx, dz];
      const l = Math.hypot(dx, dz) || 1;
      for (const rot of [0, 0.9, -0.9, 1.8, -1.8]) {
        const c = Math.cos(rot), s = Math.sin(rot);
        const rx = (dx * c - dz * s) / l, rz = (dx * s + dz * c) / l;
        if (floorAt(d, me.x + rx * 1.6, me.z + rz * 1.6) && floorAt(d, me.x + rx * 0.8, me.z + rz * 0.8)) return [rx, rz];
      }
      return [0, 0];
    };
    if (danger) {
      const [sx, sz] = safe(fx, fz);
      return { x: sx, y: sz, a: false, b: false };
    }
    if (!held) {
      // wumpa fruit when hurt, boots when close
      let pick: Body | null = null, pd = Infinity;
      for (const o of w.bodies) {
        if (!o.alive || !(o.kind === 'fruit' || o.kind === 'boots')) continue;
        const want = o.kind === 'fruit' ? d.hp[slot] <= CT_HP - 3 : d.boots[slot] <= 0;
        const dd = Math.hypot(o.x - me.x, o.z - me.z);
        if (want && dd < pd && dd < (o.kind === 'fruit' ? 14 : 6)) { pd = dd; pick = o; }
      }
      if (pick) { const [sx, sz] = safe(pick.x - me.x, pick.z - me.z); return { x: sx, y: sz, a: false, b: false }; }
      let best: Body | null = null, bd = Infinity;
      for (const c of crates(w)) {
        if (c.cd !== 0 || c.dash > 0 || c.y > 1 || !floorAt(d, c.x, c.z)) continue;
        if (c.kind === 'tnt' && c.fall) continue; // already burning
        if (c.kind === 'nitro' && fd < 5) continue; // too risky with a rival close by
        const dd = Math.hypot(c.x - me.x, c.z - me.z);
        if (dd < bd) { bd = dd; best = c; }
      }
      if (!best) {
        if (!foe) return IDLE;
        const [sx, sz] = safe(me.x * -0.1, me.z * -0.1); // drift to the middle and wait
        return { x: sx, y: sz, a: false, b: false };
      }
      const [sx, sz] = safe(best.x - me.x, best.z - me.z);
      return { x: sx, y: sz, a: bd < GRAB_RANGE * 0.8 && best.y < 0.3 && w.tick % 2 === 0, b: false };
    }
    if (!foe) return IDLE;
    const dx = foe.x - me.x, dz = foe.z - me.z;
    const err = Math.abs(angDiff(me.face, Math.atan2(dx, dz)));
    const burning = held.kind === 'tnt' && held.fall;
    const fire = ((err < 0.3 && fd < 10) || (burning && held.m < 1.2)) && w.tick % 2 === 0;
    const k = fd > 3 ? 1 : 0.2;
    const [sx, sz] = safe((dx / fd) * k, (dz / fd) * k);
    return { x: sx, y: sz, a: fire, b: false };
  },
};
