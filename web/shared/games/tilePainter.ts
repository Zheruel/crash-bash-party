/**
 * POGO PAINTER (game id 'tilePainter') - after Crash Bash's Pogo Painter.
 *
 * Hop around a 10x10 grid on a pogo stick, one square per hop, painting every square you land on in your
 * colour (rivals' squares get repainted = stolen). Painted squares are worth nothing until banked: hop onto a
 * cash crate ("?") to break it, turning ALL your painted squares into points and resetting them to neutral.
 * Most points when time runs out wins (ties: most painted squares still on the board).
 *   Stick = hop in that direction (tap = one hop, hold = keep hopping).  A or B = use the item you hold.
 * Power-up crates hold: missile (stuns the first rival in line, 2 s), arrow (paints a whole row/column of the
 * way you face) and speedy boots (hop faster for 8 s).
 *
 * Variants (world.data.variant): pogo (POGO PAINTER, plain) |
 *   agogo (POGO-A-GOGO: enclose squares with your colour - the arena edge counts - to capture them) |
 *   elpogoloco (EL POGO LOCO: hopping onto a square of your OWN colour wipes all your painted squares) |
 *   padlock (POGO PADLOCK: stone blocks in the arena - walls you cannot hop onto, missiles stop at them)
 *
 * world.data:
 *   variant: string
 *   tiles:   number[100]  owner slot per square (-1 = neutral), row-major (z * TP_N + x). Painted but not yet banked.
 *   walls:   number[]     indices of wall squares (padlock; [] otherwise)
 *   score:   number[4]    banked points per slot (the real score)
 *   item:    number[4]    held item: 0 none, 1 missile, 2 arrow
 *   boots:   number[4]    seconds of speedy boots left
 *   stun:    number[4]    seconds left stunned (cannot hop onward)
 *   dir:     number[4]    last hop direction 0 +x, 1 -x, 2 +z, 3 -z (the way you face / fire)
 *   to:      number[4]    square index the hop in progress is heading to (== the square you stand on while idle)
 *   nextCash, nextPower, from, hopT, buf, prevAct, prevFire, lastFx: (internal)
 *
 * Bodies:
 *   'player': x/z/y are already the hop arc (y > 0 in the air), face = hop direction
 *   'crate':  cash crate "?" sitting on a square (hop onto it to bank)
 *   'power':  power-up crate on a square; cd = 1 missile, 2 arrow, 3 boots
 *   'missile': flying along a row/column, slot = owner (vx/vz = velocity, y = 0.8)
 *
 * Events: paint (landing painted s=slot, v=size 0..1, o = 1 if it stole rivals' squares), cash (s=slot, v=squares
 *   banked, x/z crate), crate (a cash crate appeared), power (power crate appeared), pickup (s=slot, v=item 1/2/3),
 *   missile (s=slot fired), arrow (s=slot, v=0 row / 1 column), hit (missile hit s=victim, o=owner), stun (s=victim),
 *   wipe (s=slot lost its squares, v=count) [elpogoloco], capture (s=slot, v=squares, x/z centre) [agogo],
 *   fizzle (missile hit a wall), bump (hop blocked by a player or wall)
 */
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const TP_N = 10; // grid is TP_N x TP_N
export const TP_TILE = 1.8;
export const TP_HALF = (TP_N * TP_TILE) / 2;
const HOP = 0.34, BOOT_TIME = 8, STUN = 2, CAPTURE_MAX = 20;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const TP_VARIANTS = [
  { id: 'pogo', name: 'POGO PAINTER' },
  { id: 'agogo', name: 'POGO-A-GOGO' },
  { id: 'elpogoloco', name: 'EL POGO LOCO' },
  { id: 'padlock', name: 'POGO PADLOCK' },
];

interface Data {
  variant: string;
  tiles: number[];
  walls: number[];
  score: number[];
  item: number[];
  boots: number[];
  stun: number[];
  dir: number[];
  from: number[];
  to: number[];
  hopT: number[];
  buf: number[];
  prevAct: boolean[];
  prevFire: boolean[];
  lastFx: number[];
  nextCash: number;
  nextPower: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
export const tileIndex = (x: number, z: number) => {
  const tx = Math.floor((x + TP_HALF) / TP_TILE), tz = Math.floor((z + TP_HALF) / TP_TILE);
  return tx < 0 || tz < 0 || tx >= TP_N || tz >= TP_N ? -1 : tz * TP_N + tx;
};
export const tileCenter = (i: number): [number, number] => [((i % TP_N) + 0.5) * TP_TILE - TP_HALF, (Math.floor(i / TP_N) + 0.5) * TP_TILE - TP_HALF];
export function tileCounts(d: { tiles: number[] }): number[] {
  const c = [0, 0, 0, 0];
  for (const o of d.tiles) if (o >= 0) c[o]++;
  return c;
}
const stepTile = (i: number, dir: number): number => {
  const x = (i % TP_N) + DIRS[dir][0], z = Math.floor(i / TP_N) + DIRS[dir][1];
  return x < 0 || z < 0 || x >= TP_N || z >= TP_N ? -1 : z * TP_N + x;
};

function paintTile(w: World, d: Data, slot: number, i: number, radius: number) {
  const tx = i % TP_N, tz = Math.floor(i / TP_N);
  let changed = 0, stolen = 0;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tx + dx, z = tz + dz;
      if (x < 0 || z < 0 || x >= TP_N || z >= TP_N) continue;
      const k = z * TP_N + x;
      if (d.tiles[k] === slot || d.walls.includes(k)) continue;
      if (d.tiles[k] >= 0) stolen = 1;
      d.tiles[k] = slot;
      changed++;
    }
  if (changed) {
    const [cx, cz] = tileCenter(i);
    emit(w, 'paint', cx, cz, slot, Math.min(1, changed / 9), stolen);
  }
}

/** POGO-A-GOGO: small pockets walled in by your colour (arena edge counts) become yours. */
function capture(w: World, d: Data, slot: number) {
  const seen = new Uint8Array(TP_N * TP_N);
  for (let s = 0; s < TP_N * TP_N; s++) {
    if (seen[s] || d.tiles[s] === slot || d.walls.includes(s)) continue;
    const region: number[] = [s];
    seen[s] = 1;
    for (let h = 0; h < region.length; h++) {
      for (let k = 0; k < 4; k++) {
        const n = stepTile(region[h], k);
        if (n < 0 || seen[n] || d.tiles[n] === slot || d.walls.includes(n)) continue;
        seen[n] = 1;
        region.push(n);
      }
    }
    if (region.length > CAPTURE_MAX) continue;
    let cx = 0, cz = 0;
    for (const n of region) { d.tiles[n] = slot; const [x, z] = tileCenter(n); cx += x; cz += z; }
    emit(w, 'capture', cx / region.length, cz / region.length, slot, region.length);
  }
}

function freeTile(w: World, d: Data): number {
  const taken = new Set<number>(d.walls);
  for (const b of w.bodies) if (b.kind === 'crate' || b.kind === 'power') taken.add(tileIndex(b.x, b.z));
  for (let s = 0; s < MAX_SEATS; s++) { if (d.to[s] >= 0) taken.add(d.to[s]); if (d.from[s] >= 0) taken.add(d.from[s]); }
  for (let tries = 0; tries < 30; tries++) {
    const i = Math.floor(rand(w) * TP_N * TP_N);
    if (!taken.has(i)) return i;
  }
  return -1;
}

export const tilePainter: MiniGame = {
  id: 'tilePainter',
  name: 'Pogo Painter',
  description: 'Hop around the grid painting squares your colour. Break the "?" crate to turn your squares into points. Most points wins.',
  controls: 'Move: hop to the next square. Space or Shift: fire your item.',
  variants: TP_VARIANTS,
  maxTime: 75,

  setup(w, slots) {
    const variant = pickVariant(w, TP_VARIANTS);
    const walls: number[] = [];
    if (variant === 'padlock') for (const [x, z] of [[4, 4], [5, 4], [4, 5], [5, 5], [2, 2], [7, 2], [2, 7], [7, 7]]) walls.push(z * TP_N + x);
    const d: Data = {
      variant, tiles: new Array(TP_N * TP_N).fill(-1), walls, score: [0, 0, 0, 0], item: [0, 0, 0, 0], boots: [0, 0, 0, 0], stun: [0, 0, 0, 0],
      dir: [0, 1, 2, 3], from: [-1, -1, -1, -1], to: [-1, -1, -1, -1], hopT: [0, 0, 0, 0], buf: [-1, -1, -1, -1],
      prevAct: [false, false, false, false], prevFire: [false, false, false, false], lastFx: [-1, -1, -1, -1], nextCash: 6, nextPower: 4,
    };
    w.data = d;
    const corners = [0, TP_N - 1, TP_N * (TP_N - 1), TP_N * TP_N - 1];
    for (const s of slots) {
      const i = corners[s.slot];
      const [x, z] = tileCenter(i);
      const b = addBody(w, 'player', s.slot, x, z, 0.6, 3);
      b.face = Math.atan2(-x, -z);
      d.from[s.slot] = d.to[s.slot] = i;
      d.tiles[i] = s.slot;
      d.hopT[s.slot] = s.slot * 0.08; // stagger the rhythm slightly
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ps = players(w);

    // crates
    const crates = w.bodies.filter((b) => b.kind === 'crate'), powers = w.bodies.filter((b) => b.kind === 'power');
    if (crates.length < 2 && w.time >= d.nextCash) {
      const i = freeTile(w, d);
      if (i >= 0) {
        const [x, z] = tileCenter(i);
        addBody(w, 'crate', -1, x, z, 0.6, 1);
        emit(w, 'crate', x, z, -1, 1);
      }
      d.nextCash = w.time + 4 + rand(w) * 3;
    }
    if (powers.length < 2 && w.time >= d.nextPower) {
      const i = freeTile(w, d);
      if (i >= 0) {
        const [x, z] = tileCenter(i);
        const b = addBody(w, 'power', -1, x, z, 0.6, 1);
        const r = rand(w);
        b.cd = r < 0.4 ? 1 : r < 0.65 ? 2 : 3;
        emit(w, 'power', x, z, -1, b.cd);
      }
      d.nextPower = w.time + 8 + rand(w) * 3;
    }

    for (const p of ps) {
      const sl = p.slot;
      const inp = inputs[sl] ?? IDLE;
      d.stun[sl] = Math.max(0, d.stun[sl] - dt);
      d.boots[sl] = Math.max(0, d.boots[sl] - dt);
      const dur = HOP / w.params.speed / (d.boots[sl] > 0 ? 1.6 : 1);

      // stick -> direction (0 +x, 1 -x, 2 +z, 3 -z), -1 = none
      const mag = Math.hypot(inp.x, inp.y);
      const dir = mag < 0.4 ? -1 : Math.abs(inp.x) > Math.abs(inp.y) ? (inp.x > 0 ? 0 : 1) : inp.y > 0 ? 2 : 3;
      if (dir >= 0 && !d.prevAct[sl]) d.buf[sl] = dir; // a tap mid-hop is remembered
      d.prevAct[sl] = dir >= 0;

      // item
      const fire = (inp.a || inp.b) && !d.prevFire[sl];
      d.prevFire[sl] = inp.a || inp.b;
      if (fire && d.stun[sl] <= 0 && d.item[sl] > 0) {
        if (d.item[sl] === 1) {
          const [dx, dz] = DIRS[d.dir[sl]];
          const m = addBody(w, 'missile', sl, p.x, p.z, 0.3, 0.2);
          m.y = 0.8; m.vx = dx * 16; m.vz = dz * 16; m.cd = 0; m.face = Math.atan2(dx, dz);
          emit(w, 'missile', p.x, p.z, sl, 1);
        } else {
          const i = d.to[sl];
          const horiz = d.dir[sl] < 2;
          if (i >= 0) {
            const tx = i % TP_N, tz = Math.floor(i / TP_N);
            for (let k = 0; k < TP_N; k++) {
              const n = horiz ? tz * TP_N + k : k * TP_N + tx;
              if (d.walls.includes(n) || d.tiles[n] === sl) continue;
              d.tiles[n] = sl;
            }
            emit(w, 'arrow', p.x, p.z, sl, horiz ? 0 : 1);
            if (d.variant === 'agogo') capture(w, d, sl);
          }
        }
        d.item[sl] = 0;
      }

      // hop progress
      d.hopT[sl] += dt;
      if (d.hopT[sl] >= dur) {
        d.hopT[sl] -= dur;
        const prev = d.from[sl], landed = d.to[sl];
        d.from[sl] = landed;
        if (landed !== prev) {
          // landing effects
          const [lx, lz] = tileCenter(landed);
          const crate = w.bodies.find((b) => b.kind === 'crate' && tileIndex(b.x, b.z) === landed);
          const power = w.bodies.find((b) => b.kind === 'power' && tileIndex(b.x, b.z) === landed);
          const wipe = d.variant === 'elpogoloco' && d.tiles[landed] === sl && !crate;
          if (wipe) {
            let n = 0;
            for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === sl) { d.tiles[k] = -1; n++; }
            emit(w, 'wipe', lx, lz, sl, n);
          }
          paintTile(w, d, sl, landed, w.params.brush);
          if (d.variant === 'agogo') capture(w, d, sl);
          if (crate) {
            let n = 0;
            for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === sl) { d.tiles[k] = -1; n++; }
            d.score[sl] += n;
            emit(w, 'cash', lx, lz, sl, n);
            w.bodies = w.bodies.filter((b) => b !== crate);
          }
          if (power) {
            const kind = power.cd;
            if (kind === 3) d.boots[sl] = BOOT_TIME; else d.item[sl] = kind;
            emit(w, 'pickup', lx, lz, sl, kind);
            w.bodies = w.bodies.filter((b) => b !== power);
          }
        }
        // next hop
        const nd = d.stun[sl] > 0 ? -1 : dir >= 0 ? dir : d.buf[sl];
        d.buf[sl] = -1;
        let target = landed;
        if (nd >= 0) {
          const n = stepTile(landed, nd);
          const blockedBy = n < 0 || d.walls.includes(n) || ps.some((o) => o !== p && (d.to[o.slot] === n || d.from[o.slot] === n));
          if (!blockedBy) target = n;
          else { emit(w, 'bump', p.x, p.z, -1, 0.3); }
          d.dir[sl] = nd;
          const [dx, dz] = DIRS[nd];
          p.face = Math.atan2(dx, dz);
        }
        d.to[sl] = target;
      }

      // body follows the hop arc
      const u = Math.min(1, d.hopT[sl] / dur);
      const [fx, fz] = tileCenter(d.from[sl]), [tx, tz] = tileCenter(d.to[sl]);
      p.x = fx + (tx - fx) * u;
      p.z = fz + (tz - fz) * u;
      p.y = (d.from[sl] === d.to[sl] ? 0.35 : 1.0) * 4 * u * (1 - u);
      p.vx = (tx - fx) / dur; p.vz = (tz - fz) / dur;
    }

    // missiles
    const dead = new Set<number>();
    for (const m of w.bodies.filter((b) => b.kind === 'missile')) {
      m.x += m.vx * dt; m.z += m.vz * dt; m.cd += dt;
      const i = tileIndex(m.x, m.z);
      if (i < 0 || d.walls.includes(i) || m.cd > 1.2) { dead.add(m.id); emit(w, 'fizzle', m.x, m.z, -1, 0.5); continue; }
      for (const p of ps) {
        if (p.slot === m.slot || Math.hypot(p.x - m.x, p.z - m.z) > 0.9) continue;
        d.stun[p.slot] = STUN;
        dead.add(m.id);
        emit(w, 'hit', p.x, p.z, p.slot, 1, m.slot);
        emit(w, 'stun', p.x, p.z, p.slot, STUN);
        break;
      }
    }
    if (dead.size) w.bodies = w.bodies.filter((b) => !dead.has(b.id));
  },

  isOver(w) {
    return w.time >= tilePainter.maxTime;
  },

  placements(w) {
    const d = w.data as Data;
    const c = tileCounts(d);
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || c[b] - c[a] || a - b);
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
    if (!me) return IDLE;
    const d = w.data as Data;
    if (d.stun[slot] > 0) return IDLE;
    const loco = d.variant === 'elpogoloco';
    const start = d.to[slot];
    if (start < 0) return IDLE;
    const counts = tileCounts(d);
    const mine = counts[slot];
    const crates = w.bodies.filter((b) => b.kind === 'crate').map((b) => tileIndex(b.x, b.z));
    const powers = w.bodies.filter((b) => b.kind === 'power').map((b) => tileIndex(b.x, b.z));
    const others = [0, 1, 2, 3].filter((s) => s !== slot && d.to[s] >= 0);
    const timeLeft = tilePainter.maxTime - w.time;
    const cashNow = crates.length > 0 && (mine >= 7 || (timeLeft < 14 && mine >= 2));

    // item use
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (d.item[slot] === 1) {
      const dir = d.dir[slot];
      let n = start;
      for (let k = 0; k < 9; k++) {
        n = stepTile(n, dir);
        if (n < 0 || d.walls.includes(n)) break;
        if (others.some((s) => d.to[s] === n)) { out.a = w.tick % 2 === 0; break; }
      }
    } else if (d.item[slot] === 2) {
      const dir = d.dir[slot];
      const tx = start % TP_N, tz = Math.floor(start / TP_N);
      let free = 0;
      for (let k = 0; k < TP_N; k++) { const n = dir < 2 ? tz * TP_N + k : k * TP_N + tx; if (d.tiles[n] !== slot && !d.walls.includes(n)) free++; }
      if (free >= 5) out.a = w.tick % 2 === 0;
    }

    // BFS to the nearest goal
    const goals = new Set<number>();
    if (cashNow) crates.forEach((c) => goals.add(c));
    else {
      const near = powers.filter((p) => Math.abs((p % TP_N) - (start % TP_N)) + Math.abs(Math.floor(p / TP_N) - Math.floor(start / TP_N)) <= 4);
      near.forEach((p) => goals.add(p));
    }
    const search = (avoidOwn: boolean): number => {
      const distT = new Int16Array(TP_N * TP_N).fill(-1);
      const first = new Int8Array(TP_N * TP_N).fill(-1);
      const q: number[] = [start];
      distT[start] = 0;
      let bestTile = -1, bestScore = Infinity;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (c !== start) {
          let score = Infinity;
          if (goals.has(c)) score = distT[c] - 3;
          else if (!cashNow && goals.size === 0 && d.tiles[c] !== slot) score = distT[c] - (d.tiles[c] >= 0 ? 0.6 : 0) + ((c * 7 + slot * 13) % 5) * 0.05;
          if (score < bestScore) { bestScore = score; bestTile = c; }
        }
        if (distT[c] > 12) continue;
        for (let k = 0; k < 4; k++) {
          const n = stepTile(c, k);
          if (n < 0 || distT[n] >= 0 || d.walls.includes(n)) continue;
          if (others.some((s) => d.to[s] === n || d.from[s] === n)) continue;
          if (avoidOwn && d.tiles[n] === slot && !goals.has(n)) continue;
          distT[n] = distT[c] + 1;
          first[n] = c === start ? k : first[c];
          q.push(n);
        }
      }
      return bestTile >= 0 ? first[bestTile] : -1;
    };
    let dir = search(loco);
    if (dir < 0 && goals.size) { goals.clear(); dir = search(loco); }
    if (dir < 0 && loco) dir = search(false);
    if (dir < 0) {
      // nothing to do: head for a crate anyway, or just keep hopping around
      if (crates.length) { goals.clear(); crates.forEach((c) => goals.add(c)); dir = search(false); }
    }
    if (dir >= 0) { out.x = DIRS[dir][0]; out.y = DIRS[dir][1]; }
    return out;
  },
};
