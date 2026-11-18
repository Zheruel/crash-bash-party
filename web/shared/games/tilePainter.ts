/**
 * POGO PANDEMONIUM (game id 'tilePainter') - Crash Bash levels 10-13 (Pogo Painter / Pogo-a-gogo / El Pogo Loco / Pogo Padlock).
 *
 * Everyone hops on a pogo stick around an 8x8 grid, one square per hop, painting the square they land on.
 * Real controls: D-pad = hop to the next square (tap = one hop, hold = keep hopping), Square (A/B here) = fire the held item.
 * Round = 90 s, highest score wins (HUD: a 3-digit score per player).
 * Start squares (the coloured pads): P1 yellow bottom-left, P2 red top-left, P3 blue top-right, P4 green bottom-right.
 *
 * Variants (world.data.variant):
 *   pogo       POGO PAINTER: paint squares, then hop onto a "?" crate to turn all your painted squares into points.
 *              Items: missile (stun), arrow (paints a whole row/column), speedy boots.
 *   agogo      POGO-A-GOGO: encircle areas with your colour to capture them (they become permanent points). The arena
 *              edge counts as your colour: each edge is split between the two neighbouring players' colours.
 *              Items: four-way missile, electro stun beam, arrow, boots.
 *   elpogoloco EL POGO LOCO: encircle to capture (as agogo) and break "?" crates to bank your loose squares.
 *              Items: missile, boots.
 *   padlock    POGO PADLOCK: landing on a square of your OWN colour loses all your squares. Break "?" crates to bank them.
 *              Items: padlock (your squares cannot be taken), missile (stuns and steals squares), boots.
 *
 * world.data:
 *   variant: string
 *   tiles:   number[64] owner slot per square (-1 neutral), row-major (z * TP_N + x)
 *   cap:     number[64] 1 = captured for good (agogo / elpogoloco): scored, cannot be repainted
 *   score:   number[4]  points per slot (captured / banked)
 *   item:    number[4]  held item: 0 none, 1 missile, 2 arrow, 4 four-way missile, 5 electro beam, 6 padlock
 *   boots:   number[4]  seconds of speedy boots left
 *   stun:    number[4]  seconds stunned
 *   lock:    number[4]  seconds of padlock protection left
 *   dir:     number[4]  facing 0 +x, 1 -x, 2 +z, 3 -z
 *   to:      number[4]  square being hopped to (== the square you stand on while idle)
 * Bodies: 'player' (y = hop arc), 'crate' (cash crate), 'power' (item crate, cd = item id), 'missile' (slot = owner).
 * Events: paint, cash, capture, crate, power, pickup (v = item), missile, beam, arrow, lock, hit, stun, steal, wipe, fizzle, bump.
 */
import { addBody, emit, rand } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const TP_N = 8;
export const TP_TILE = 1.8;
export const TP_HALF = (TP_N * TP_TILE) / 2;
const HOP = 0.42, BOOT_TIME = 8, STUN = 2, LOCK_TIME = 8;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const TP_START = [TP_N * (TP_N - 1), 0, TP_N - 1, TP_N * TP_N - 1]; // yellow BL, red TL, blue TR, green BR

export const TP_VARIANTS = [
  { id: 'pogo', name: 'POGO PAINTER' },
  { id: 'agogo', name: 'POGO-A-GOGO' },
  { id: 'elpogoloco', name: 'EL POGO LOCO' },
  { id: 'padlock', name: 'POGO PADLOCK' },
];

/** Item ids available per variant (item crates draw from this list). */
export const TP_ITEMS: Record<string, number[]> = {
  pogo: [1, 1, 2, 2, 3],
  agogo: [4, 5, 2, 3],
  elpogoloco: [1, 1, 3],
  padlock: [6, 1, 1, 3],
};

interface Data {
  variant: string;
  tiles: number[];
  cap: number[];
  score: number[];
  item: number[];
  boots: number[];
  stun: number[];
  lock: number[];
  dir: number[];
  from: number[];
  to: number[];
  hopT: number[];
  buf: number[];
  prevAct: boolean[];
  prevFire: boolean[];
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
/** Whose colour the arena edge is, beyond tile (x,z) in direction dir (pogo-a-gogo edges are split per corner player). */
export function edgeOwner(x: number, z: number, dir: number): number {
  const h = TP_N / 2;
  if (dir === 3) return x < h ? 1 : 2; // top
  if (dir === 2) return x < h ? 0 : 3; // bottom
  if (dir === 1) return z < h ? 1 : 0; // left
  return z < h ? 2 : 3; // right
}

function paintTile(w: World, d: Data, slot: number, i: number, radius: number) {
  const tx = i % TP_N, tz = Math.floor(i / TP_N);
  let changed = 0, stolen = 0;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tx + dx, z = tz + dz;
      if (x < 0 || z < 0 || x >= TP_N || z >= TP_N) continue;
      const k = z * TP_N + x;
      const o = d.tiles[k];
      if (o === slot || d.cap[k] || (o >= 0 && d.lock[o] > 0)) continue;
      if (o >= 0) stolen = 1;
      d.tiles[k] = slot;
      changed++;
    }
  if (changed) {
    const [cx, cz] = tileCenter(i);
    emit(w, 'paint', cx, cz, slot, Math.min(1, changed / 9), stolen);
  }
}

/** Pogo-a-gogo / El Pogo Loco: any region not walled in by `slot` tiles and `slot` edge stays open; enclosed ones are captured. */
function capture(w: World, d: Data, slot: number) {
  const seen = new Uint8Array(TP_N * TP_N);
  for (let s = 0; s < TP_N * TP_N; s++) {
    if (seen[s] || d.tiles[s] === slot || d.cap[s]) continue;
    const region: number[] = [s];
    seen[s] = 1;
    let enclosed = true;
    for (let h = 0; h < region.length; h++) {
      const c = region[h], cx = c % TP_N, cz = Math.floor(c / TP_N);
      for (let k = 0; k < 4; k++) {
        const n = stepTile(c, k);
        if (n < 0) { if (edgeOwner(cx, cz, k) !== slot) enclosed = false; continue; }
        if (seen[n] || d.tiles[n] === slot || d.cap[n]) continue;
        seen[n] = 1;
        region.push(n);
      }
    }
    if (!enclosed) continue;
    let cx = 0, cz = 0, gain = 0;
    for (const n of region) {
      d.tiles[n] = slot; d.cap[n] = 1; gain++;
      const [x, z] = tileCenter(n); cx += x; cz += z;
    }
    d.score[slot] += gain;
    emit(w, 'capture', cx / region.length, cz / region.length, slot, gain);
  }
  // own loose squares that now sit inside a closed outline stay loose; only enclosed neutral/rival ground is captured
}

function freeTile(w: World, d: Data): number {
  const taken = new Set<number>();
  for (const b of w.bodies) if (b.kind === 'crate' || b.kind === 'power') taken.add(tileIndex(b.x, b.z));
  for (let s = 0; s < MAX_SEATS; s++) { if (d.to[s] >= 0) taken.add(d.to[s]); if (d.from[s] >= 0) taken.add(d.from[s]); }
  for (let tries = 0; tries < 30; tries++) {
    const i = Math.floor(rand(w) * TP_N * TP_N);
    if (!taken.has(i) && !d.cap[i]) return i;
  }
  return -1;
}

/** Turn all of a slot's loose painted squares into points. */
function bank(d: Data, slot: number): number {
  let n = 0;
  for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === slot && !d.cap[k]) { d.tiles[k] = -1; n++; }
  d.score[slot] += n;
  return n;
}

function fireMissile(w: World, slot: number, x: number, z: number, dir: number) {
  const [dx, dz] = DIRS[dir];
  const m = addBody(w, 'missile', slot, x, z, 0.3, 0.2);
  m.y = 0.8; m.vx = dx * 16; m.vz = dz * 16; m.cd = 0; m.face = Math.atan2(dx, dz);
}

function stunPlayer(w: World, d: Data, p: { x: number; z: number; slot: number }, by: number, secs: number) {
  d.stun[p.slot] = secs;
  emit(w, 'hit', p.x, p.z, p.slot, 1, by);
  emit(w, 'stun', p.x, p.z, p.slot, secs);
  if (d.variant === 'padlock' && d.lock[p.slot] <= 0) {
    // padlock: a hit steals half of the victim's squares
    const mine: number[] = [];
    for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === p.slot) mine.push(k);
    const take = Math.ceil(mine.length / 2);
    for (let k = 0; k < take; k++) d.tiles[mine[k]] = by;
    if (take) emit(w, 'steal', p.x, p.z, by, take, p.slot);
  }
}

export const tilePainter: MiniGame = {
  id: 'tilePainter',
  name: 'Pogo Painter',
  description: 'Hop around the arena on a pogo stick, painting squares your colour. Cash them in at the special crates. Highest score in 90 seconds wins.',
  controls: 'Move: hop to the next square. Space / Shift: fire your item.',
  variants: TP_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, TP_VARIANTS);
    const d: Data = {
      variant, tiles: new Array(TP_N * TP_N).fill(-1), cap: new Array(TP_N * TP_N).fill(0), score: [0, 0, 0, 0], item: [0, 0, 0, 0],
      boots: [0, 0, 0, 0], stun: [0, 0, 0, 0], lock: [0, 0, 0, 0], dir: [3, 2, 2, 3], from: [-1, -1, -1, -1], to: [-1, -1, -1, -1],
      hopT: [0, 0, 0, 0], buf: [-1, -1, -1, -1], prevAct: [false, false, false, false], prevFire: [false, false, false, false],
      nextCash: 5, nextPower: 3,
    };
    w.data = d;
    for (const s of slots) {
      const i = TP_START[s.slot];
      const [x, z] = tileCenter(i);
      const b = addBody(w, 'player', s.slot, x, z, 0.6, 3);
      b.face = Math.atan2(-x, -z);
      d.from[s.slot] = d.to[s.slot] = i;
      d.tiles[i] = s.slot;
      d.hopT[s.slot] = s.slot * 0.08;
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ps = players(w);
    const cashCrates = d.variant !== 'agogo';

    // crates
    const crates = w.bodies.filter((b) => b.kind === 'crate'), powers = w.bodies.filter((b) => b.kind === 'power');
    if (cashCrates && crates.length < 2 && w.time >= d.nextCash) {
      const i = freeTile(w, d);
      if (i >= 0) {
        const [x, z] = tileCenter(i);
        addBody(w, 'crate', -1, x, z, 0.6, 1);
        emit(w, 'crate', x, z, -1, 1);
      }
      d.nextCash = w.time + 5 + rand(w) * 4;
    }
    if (powers.length < 2 && w.time >= d.nextPower) {
      const i = freeTile(w, d);
      if (i >= 0) {
        const [x, z] = tileCenter(i);
        const b = addBody(w, 'power', -1, x, z, 0.6, 1);
        const list = TP_ITEMS[d.variant] ?? TP_ITEMS.pogo;
        b.cd = list[Math.floor(rand(w) * list.length)];
        emit(w, 'power', x, z, -1, b.cd);
      }
      d.nextPower = w.time + 7 + rand(w) * 4;
    }

    for (const p of ps) {
      const sl = p.slot;
      const inp = inputs[sl] ?? IDLE;
      d.stun[sl] = Math.max(0, d.stun[sl] - dt);
      d.boots[sl] = Math.max(0, d.boots[sl] - dt);
      d.lock[sl] = Math.max(0, d.lock[sl] - dt);
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
        const it = d.item[sl];
        if (it === 1) {
          fireMissile(w, sl, p.x, p.z, d.dir[sl]);
          emit(w, 'missile', p.x, p.z, sl, 1);
        } else if (it === 4) {
          for (let k = 0; k < 4; k++) fireMissile(w, sl, p.x, p.z, k);
          emit(w, 'missile', p.x, p.z, sl, 4);
        } else if (it === 5) {
          // electro stun beam: instant, first rival in line
          let n = d.to[sl], hit = -1;
          for (let k = 0; k < TP_N && n >= 0 && hit < 0; k++) {
            n = stepTile(n, d.dir[sl]);
            const o = ps.find((q) => q.slot !== sl && (d.to[q.slot] === n || d.from[q.slot] === n));
            if (o) hit = o.slot;
          }
          emit(w, 'beam', p.x, p.z, sl, d.dir[sl]);
          if (hit >= 0) { const o = ps.find((q) => q.slot === hit)!; stunPlayer(w, d, o, sl, 3); }
        } else if (it === 6) {
          d.lock[sl] = LOCK_TIME;
          emit(w, 'lock', p.x, p.z, sl, LOCK_TIME);
        } else if (it === 2) {
          const i = d.to[sl];
          const horiz = d.dir[sl] < 2;
          if (i >= 0) {
            const tx = i % TP_N, tz = Math.floor(i / TP_N);
            for (let k = 0; k < TP_N; k++) {
              const n = horiz ? tz * TP_N + k : k * TP_N + tx;
              if (d.tiles[n] === sl || d.cap[n] || (d.tiles[n] >= 0 && d.lock[d.tiles[n]] > 0)) continue;
              d.tiles[n] = sl;
            }
            emit(w, 'arrow', p.x, p.z, sl, horiz ? 0 : 1);
            if (d.variant === 'agogo' || d.variant === 'elpogoloco') capture(w, d, sl);
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
          const [lx, lz] = tileCenter(landed);
          const crate = w.bodies.find((b) => b.kind === 'crate' && tileIndex(b.x, b.z) === landed);
          const power = w.bodies.find((b) => b.kind === 'power' && tileIndex(b.x, b.z) === landed);
          if (d.variant === 'padlock' && d.tiles[landed] === sl && !crate && d.lock[sl] <= 0) {
            let n = 0;
            for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === sl) { d.tiles[k] = -1; n++; }
            emit(w, 'wipe', lx, lz, sl, n);
          }
          paintTile(w, d, sl, landed, w.params.brush);
          if (d.variant === 'agogo' || d.variant === 'elpogoloco') capture(w, d, sl);
          if (crate) {
            const n = bank(d, sl);
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
          const blockedBy = n < 0 || ps.some((o) => o !== p && (d.to[o.slot] === n || d.from[o.slot] === n));
          if (!blockedBy) target = n;
          else emit(w, 'bump', p.x, p.z, -1, 0.3);
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
      if (i < 0 || m.cd > 1.5) { dead.add(m.id); emit(w, 'fizzle', m.x, m.z, -1, 0.5); continue; }
      for (const p of ps) {
        if (p.slot === m.slot || Math.hypot(p.x - m.x, p.z - m.z) > 0.9) continue;
        stunPlayer(w, d, p, m.slot, STUN);
        dead.add(m.id);
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
    const start = d.to[slot];
    if (start < 0) return IDLE;
    const avoidOwnTiles = d.variant === 'padlock' && d.lock[slot] <= 0;
    const capVar = d.variant === 'agogo' || d.variant === 'elpogoloco';
    const counts = tileCounts(d);
    let mine = 0;
    for (let k = 0; k < d.tiles.length; k++) if (d.tiles[k] === slot && !d.cap[k]) mine++;
    void counts;
    const crates = w.bodies.filter((b) => b.kind === 'crate').map((b) => tileIndex(b.x, b.z));
    const powers = w.bodies.filter((b) => b.kind === 'power').map((b) => tileIndex(b.x, b.z));
    const others = [0, 1, 2, 3].filter((s) => s !== slot && d.to[s] >= 0);
    const timeLeft = tilePainter.maxTime - w.time;
    const cashNow = crates.length > 0 && (mine >= 8 || (timeLeft < 15 && mine >= 2));

    const out: InputState = { x: 0, y: 0, a: false, b: false };
    const it = d.item[slot];
    if (it === 1 || it === 5) {
      let n = start;
      for (let k = 0; k < 8; k++) {
        n = stepTile(n, d.dir[slot]);
        if (n < 0) break;
        if (others.some((s) => d.to[s] === n)) { out.a = w.tick % 2 === 0; break; }
      }
    } else if (it === 4) {
      out.a = w.tick % 7 === 0;
    } else if (it === 6) {
      out.a = mine >= 4 && w.tick % 2 === 0;
    } else if (it === 2) {
      const tx = start % TP_N, tz = Math.floor(start / TP_N);
      let free = 0;
      for (let k = 0; k < TP_N; k++) { const n = d.dir[slot] < 2 ? tz * TP_N + k : k * TP_N + tx; if (d.tiles[n] !== slot && !d.cap[n]) free++; }
      if (free >= 4) out.a = w.tick % 2 === 0;
    }

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
          const cx = c % TP_N, cz = Math.floor(c / TP_N);
          if (goals.has(c)) score = distT[c] - 3;
          else if (!cashNow && goals.size === 0 && d.tiles[c] !== slot && !d.cap[c]) {
            // capture variants: prefer squares on the border next to my own edge, else nearest unpainted
            const edge = capVar && (cx === 0 || cz === 0 || cx === TP_N - 1 || cz === TP_N - 1) && [0, 1, 2, 3].some((k) => stepTile(c, k) < 0 && edgeOwner(cx, cz, k) === slot);
            score = distT[c] - (d.tiles[c] >= 0 ? 0.6 : 0) - (edge ? 0.8 : 0) + ((c * 7 + slot * 13) % 5) * 0.05;
          }
          if (score < bestScore) { bestScore = score; bestTile = c; }
        }
        if (distT[c] > 12) continue;
        for (let k = 0; k < 4; k++) {
          const n = stepTile(c, k);
          if (n < 0 || distT[n] >= 0) continue;
          if (others.some((s) => d.to[s] === n || d.from[s] === n)) continue;
          if (avoidOwn && d.tiles[n] === slot && !goals.has(n)) continue;
          distT[n] = distT[c] + 1;
          first[n] = c === start ? k : first[c];
          q.push(n);
        }
      }
      return bestTile >= 0 ? first[bestTile] : -1;
    };
    let dir = search(avoidOwnTiles);
    if (dir < 0 && goals.size) { goals.clear(); dir = search(avoidOwnTiles); }
    if (dir < 0 && avoidOwnTiles) dir = search(false);
    if (dir < 0 && crates.length) { goals.clear(); crates.forEach((c) => goals.add(c)); dir = search(false); }
    if (dir >= 0) { out.x = DIRS[dir][0]; out.y = DIRS[dir][1]; }
    return out;
  },
};
