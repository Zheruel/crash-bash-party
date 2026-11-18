/**
 * BALLISTIX (game id 'ballDefence') - after Crash Bash's Ballistix.
 *
 * Four hover-ships each guard a goal on one side of a square arena. Balls are fired in; every ball that
 * enters your goal costs 1 point from a starting score of 15. At 0 your goal is closed off and you are
 * out. Last ship left wins (on timeout: highest remaining score).
 *   A = extra kick (swing that bats a ball hard).  B = hold for speed boost
 *   (BEACH BALL: hold B = magnet that catches nearby balls; release to fire them at your rivals).
 *
 * Variants (world.data.variant): crashball (CRASHBALL, plain) | beach (BEACH BALL, magnet) |
 *   nballism (N.BALLISM, N.Gin lobs extra balls at goals + force-field posts) |
 *   sky (SKY BALLS, engines randomly stall)
 *
 * Slots: 0 south goal (+z), 1 north (-z), 2 west (-x), 3 east (+x); see BD_NORMALS.
 *
 * world.data:
 *   variant: string
 *   lives:   number[4]  score left per slot, starts at BD_START (15); <=0 = eliminated (goal closed)
 *   elim:    number[4]  tick of elimination, -1 while alive
 *   shield:  number[4]  seconds of force field left (goal mouth closed while > 0)
 *   held:    number[4]  id of the ball held by that slot's magnet (0 = none)   [beach]
 *   holdT:   number[4]  seconds the magnet has held the ball
 *   stall:   number[4]  seconds of engine failure left                           [sky]
 *   pending: number[]   (internal) times at which a replacement ball spawns
 *   ginT:    number     (internal) time of the next N.Gin attack
 *   prevA:   boolean[4], kicked: {ballId: tick}, stallT: number[4]  (internal)
 *
 * Bodies:
 *   'player' (the ship): r~0.7, cd = kick cooldown, dash > 0 while the kick swing is active
 *   'ball': cd = last toucher slot + 1 (0 none), dash = 1 for an N.Gin ball (fast, no replacement)
 *   'post': force-field pickup at slot's corner post (slot = owner, cd > 0 while respawning)  [nballism]
 *
 * Events: hit (ship bats a ball; o=slot, v=impact), kick (s=slot swing), bounce (wall), goal (s=scored-on slot,
 *   o=last toucher or -1), ko (s=eliminated slot, o=last toucher), pickup (s=slot, force field), shield (s=slot,
 *   v=1 on, 0 off), magnet (s=slot caught a ball), launch (s=slot fired the held ball), ngin (s=target slot,
 *   x/z = target goal), stall (s=slot engines cut out, v=seconds)
 */
import { addBody, clamp, collideCircles, effMass, emit, lastContact, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const BD_HALF = 10; // arena half-size
export const BD_GOAL = 3.2; // goal mouth half-width
export const BD_START = 15; // starting score of every player
const BD_BAND = 5.5; // ships stay within this depth of their own wall
const SHIELD_TIME = 6, POST_RESPAWN = 14;
// Outward normal of each slot's goal side: 0 south(+z), 1 north(-z), 2 west(-x), 3 east(+x)
export const BD_NORMALS: [number, number][] = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const lat = (slot: number, x: number, z: number) => (slot < 2 ? x : z);
const postPos = (slot: number): [number, number] => {
  const [nx, nz] = BD_NORMALS[slot], t = slot === 0 || slot === 3 ? 1 : -1, d = BD_HALF - 1, l = (BD_HALF - 1.4) * t;
  return slot < 2 ? [l, nz * d] : [nx * d, l];
};

interface Data {
  variant: string;
  lives: number[];
  elim: number[];
  shield: number[];
  held: number[];
  holdT: number[];
  stall: number[];
  stallT: number[];
  pending: number[];
  ginT: number;
  prevA: boolean[];
  kicked: Record<number, number>;
}

export const BD_VARIANTS = [
  { id: 'crashball', name: 'CRASHBALL' },
  { id: 'beach', name: 'BEACH BALL' },
  { id: 'nballism', name: 'N.BALLISM' },
  { id: 'sky', name: 'SKY BALLS' },
];

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const balls = (w: World) => w.bodies.filter((b) => b.kind === 'ball');
const aliveCount = (d: Data) => d.lives.filter((l) => l > 0).length;
const baseSpeed = (w: World) => 7 * (1 + w.time / 60) * w.params.speed;
const fold = (x: number) => { // reflect a straight-line projection back into the arena
  const H = BD_HALF;
  let u = (x + H) % (4 * H);
  if (u < 0) u += 4 * H;
  if (u > 2 * H) u = 4 * H - u;
  return u - H;
};

function spawnBall(w: World, x = 0, z = 0, aimX?: number, aimZ?: number, speedMul = 1, gin = false) {
  const b = addBody(w, 'ball', -1, x, z, 0.5 * w.params.ballScale, 1);
  const s = baseSpeed(w) * speedMul;
  let vx: number, vz: number;
  if (aimX !== undefined && aimZ !== undefined) {
    const dx = aimX - x, dz = aimZ - z, l = Math.hypot(dx, dz) || 1;
    vx = (dx / l) * s; vz = (dz / l) * s;
  } else {
    const a = rand(w) * Math.PI * 2;
    vx = Math.sin(a) * s; vz = Math.cos(a) * s;
  }
  b.vx = vx; b.vz = vz;
  if (gin) b.dash = 1;
  return b;
}

export const ballDefence: MiniGame = {
  id: 'ballDefence',
  name: 'Ballistix',
  description: 'Deflect the balls away from your goal! Every ball that gets in costs you 1 of your 15 points. Last ship in play wins.',
  controls: 'Move your ship. Space: extra kick. Hold Shift: speed boost (Beach Ball: magnet, release to fire).',
  variants: BD_VARIANTS,
  maxTime: 120,

  setup(w, slots) {
    const variant = pickVariant(w, BD_VARIANTS);
    const d: Data = {
      variant, lives: [], elim: [], shield: [0, 0, 0, 0], held: [0, 0, 0, 0], holdT: [0, 0, 0, 0], stall: [0, 0, 0, 0],
      stallT: [6, 8, 10, 12], pending: [0.5, 6, 16, 30], ginT: 7, prevA: [false, false, false, false], kicked: {},
    };
    for (let i = 0; i < MAX_SEATS; i++) { d.lives.push(BD_START); d.elim.push(-1); }
    w.data = d;
    for (const s of slots) {
      const n = BD_NORMALS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, n[0] * (BD_HALF - 2.5), n[1] * (BD_HALF - 2.5), 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-n[0], -n[1]);
      if (variant === 'nballism') {
        const [px, pz] = postPos(s.slot);
        addBody(w, 'post', s.slot, px, pz, 0.6, 1);
      }
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const H = BD_HALF;
    const live = aliveCount(d) > 1;
    const base = baseSpeed(w);

    // spawn queued balls
    if (live) {
      for (let i = d.pending.length - 1; i >= 0; i--) {
        if (d.pending[i] <= w.time) { d.pending.splice(i, 1); spawnBall(w, (rand(w) - 0.5) * 3, (rand(w) - 0.5) * 3); }
      }
      // N.Gin attacks one goal with an extra fast ball
      if (d.variant === 'nballism' && w.time >= d.ginT && balls(w).length < 7) {
        d.ginT = w.time + 8;
        const open = [0, 1, 2, 3].filter((s) => d.lives[s] > 0);
        const s = open[Math.min(open.length - 1, Math.floor(rand(w) * open.length))];
        const [nx, nz] = BD_NORMALS[s];
        const tx = nx * H, tz = nz * H;
        const g = spawnBall(w, 0, 0, tx, tz, 1.5, true);
        g.cd = 0;
        emit(w, 'ngin', tx, tz, s, 1);
      }
    }

    // timers
    for (let s = 0; s < MAX_SEATS; s++) {
      if (d.shield[s] > 0) { d.shield[s] -= dt; if (d.shield[s] <= 0) { d.shield[s] = 0; emit(w, 'shield', 0, 0, s, 0); } }
      if (d.stall[s] > 0) d.stall[s] = Math.max(0, d.stall[s] - dt);
      if (d.variant === 'sky' && d.lives[s] > 0 && live && w.time >= d.stallT[s]) {
        d.stall[s] = 1.1;
        d.stallT[s] = w.time + 7 + rand(w) * 6;
        const p = players(w).find((q) => q.slot === s);
        emit(w, 'stall', p ? p.x : 0, p ? p.z : 0, s, 1.1);
      }
    }

    const bs = balls(w);
    // ships
    const ps = players(w).filter((p) => p.alive);
    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      let ix = inp.x, iz = inp.y;
      const len = Math.hypot(ix, iz);
      if (len > 1) { ix /= len; iz /= len; }
      const mag = Math.min(len, 1);
      const boost = inp.b && d.variant !== 'beach' ? 1.5 : 1;
      const sp = 7.5 * w.params.speed * boost * (d.stall[s] > 0 ? 0.3 : 1);
      const t = 1 - Math.exp(-11 * w.params.friction * dt);
      p.vx += (ix * sp - p.vx) * t;
      p.vz += (iz * sp - p.vz) * t;
      if (mag > 0.15) p.face = Math.atan2(ix, iz);
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.cd = Math.max(0, p.cd - dt);
      p.dash = Math.max(0, p.dash - dt);
      if (inp.a && !d.prevA[s] && p.cd <= 0 && d.stall[s] <= 0) { p.dash = 0.2; p.cd = 0.45; emit(w, 'kick', p.x, p.z, s, 1); }
      d.prevA[s] = inp.a;
      // stay in the ship's zone along its own wall
      const [nx, nz] = BD_NORMALS[s];
      const depth = nx * p.x + nz * p.z, want = clamp(depth, H - BD_BAND, H - p.r);
      p.x += (want - depth) * nx; p.z += (want - depth) * nz;
      const lim = H - p.r;
      if (Math.abs(p.x) > lim) { p.x = clamp(p.x, -lim, lim); p.vx = 0; }
      if (Math.abs(p.z) > lim) { p.z = clamp(p.z, -lim, lim); p.vz = 0; }
      // force field post
      if (d.variant === 'nballism') {
        const post = w.bodies.find((q) => q.kind === 'post' && q.slot === s);
        if (post) {
          post.cd = Math.max(0, post.cd - dt);
          if (post.cd <= 0 && Math.hypot(post.x - p.x, post.z - p.z) < p.r + post.r) {
            post.cd = POST_RESPAWN;
            d.shield[s] = SHIELD_TIME;
            emit(w, 'pickup', post.x, post.z, s, 1);
            emit(w, 'shield', p.x, p.z, s, 1);
          }
        }
      }
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) collideCircles(ps[i], ps[j], 0.5, effMass(ps[i]), effMass(ps[j]));

    // magnet (beach ball)
    const heldIds = new Set<number>();
    if (d.variant === 'beach') {
      for (const p of ps) {
        const s = p.slot, inp = inputs[s] ?? IDLE;
        let hb = d.held[s] ? bs.find((b) => b.id === d.held[s]) : undefined;
        if (d.held[s] && !hb) d.held[s] = 0;
        if (hb) {
          d.holdT[s] += dt;
          if (!inp.b || d.holdT[s] > 2.5) {
            let dx = Math.sin(p.face), dz = Math.cos(p.face);
            const [nx, nz] = BD_NORMALS[s];
            const dn = dx * nx + dz * nz;
            if (dn > -0.2) { dx -= (dn + 0.5) * nx; dz -= (dn + 0.5) * nz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
            hb.vx = dx * base * 2; hb.vz = dz * base * 2; hb.cd = s + 1;
            d.held[s] = 0; d.holdT[s] = 0;
            emit(w, 'launch', hb.x, hb.z, s, 1);
            hb = undefined;
          }
        } else if (inp.b && d.stall[s] <= 0) {
          let best: Body | null = null, bd = 3.4;
          for (const b of bs) {
            if (d.held.includes(b.id)) continue;
            const dd = Math.hypot(b.x - p.x, b.z - p.z);
            if (dd < bd) { bd = dd; best = b; }
          }
          if (best) {
            const dx = p.x - best.x, dz = p.z - best.z, l = Math.hypot(dx, dz) || 1;
            best.vx += (dx / l) * 40 * dt; best.vz += (dz / l) * 40 * dt;
            if (bd < p.r + best.r + 0.35) { d.held[s] = best.id; d.holdT[s] = 0; best.vx = best.vz = 0; best.cd = s + 1; emit(w, 'magnet', best.x, best.z, s, 1); }
          }
        }
        if (hb) {
          heldIds.add(hb.id);
          const off = p.r + hb.r + 0.25;
          hb.x = clamp(p.x + Math.sin(p.face) * off, -(H - hb.r), H - hb.r);
          hb.z = clamp(p.z + Math.cos(p.face) * off, -(H - hb.r), H - hb.r);
          hb.vx = hb.vz = 0;
        }
      }
    }

    // balls
    const dead = new Set<number>();
    for (const b of bs) {
      if (heldIds.has(b.id)) continue;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      for (const p of ps) {
        const dist = Math.hypot(b.x - p.x, b.z - p.z);
        const swinging = p.dash > 0 && dist < p.r + b.r + 0.6 && w.tick - (d.kicked[b.id] ?? -99) > 8 && d.stall[p.slot] <= 0;
        const hit = collideCircles(p, b, 1, effMass(p), b.m);
        if (swinging) {
          const [nx, nz] = BD_NORMALS[p.slot];
          let dx = b.x - p.x, dz = b.z - p.z;
          const dn = dx * nx + dz * nz;
          dx -= dn * nx; dz -= dn * nz; // lateral aim from where the ball sits relative to the ship
          dx = dx * 0.8 - nx; dz = dz * 0.8 - nz; // always kick inwards
          const l = Math.hypot(dx, dz) || 1;
          b.vx = (dx / l) * base * 2.2; b.vz = (dz / l) * base * 2.2;
          b.cd = p.slot + 1;
          d.kicked[b.id] = w.tick;
          emit(w, 'hit', b.x, b.z, -1, 1.4, p.slot);
        } else if (hit) {
          b.cd = p.slot + 1; // last toucher
          if (lastContact.impact > 2) emit(w, 'hit', b.x, b.z, -1, Math.min(1.5, lastContact.impact / 14), p.slot);
        }
      }
    }
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) if (!heldIds.has(bs[i].id) && !heldIds.has(bs[j].id)) collideCircles(bs[i], bs[j], 1);

    for (const b of bs) {
      if (heldIds.has(b.id)) continue;
      // walls + goals
      for (let s = 0; s < MAX_SEATS; s++) {
        const [nx, nz] = BD_NORMALS[s];
        const a = nx * b.x + nz * b.z;
        if (a <= H - b.r) continue;
        const open = d.lives[s] > 0 && d.shield[s] <= 0;
        if (open && Math.abs(lat(s, b.x, b.z)) < BD_GOAL) {
          if (a > H + b.r) {
            dead.add(b.id);
            d.lives[s]--;
            const toucher = b.cd - 1 === s ? -1 : b.cd - 1;
            emit(w, 'goal', b.x, b.z, s, 1, toucher);
            if (b.dash <= 0) d.pending.push(w.time + 1.5);
            if (d.lives[s] <= 0) {
              d.elim[s] = w.tick;
              emit(w, 'ko', b.x, b.z, s, 1, toucher);
              const body = ps.find((p) => p.slot === s);
              if (body) { body.alive = false; body.vx = body.vz = 0; }
              d.shield[s] = 0;
              if (d.held[s]) d.held[s] = 0;
            }
          }
          continue;
        }
        const vn = b.vx * nx + b.vz * nz;
        if (vn > 0) { b.vx -= 2 * vn * nx; b.vz -= 2 * vn * nz; emit(w, 'bounce', b.x, b.z, -1, 0.4); }
        const over = a - (H - b.r);
        b.x -= nx * over; b.z -= nz * over;
      }
      // keep speed within a sane band; kicked balls slow down towards a brisk pace
      let sp = Math.hypot(b.vx, b.vz) || 1;
      if (sp > base * 1.5) sp = Math.max(base * 1.5, sp - (sp - base * 1.5) * Math.min(1, 0.9 * dt * 3));
      const t = clamp(sp, base * 0.9, base * 2.4) / (Math.hypot(b.vx, b.vz) || 1);
      b.vx *= t; b.vz *= t;
    }
    if (dead.size) { w.bodies = w.bodies.filter((b) => !dead.has(b.id)); for (const id of dead) delete d.kicked[id]; }
  },

  isOver(w) {
    return aliveCount(w.data as Data) <= 1;
  },

  placements(w) {
    const d = w.data as Data;
    const slots = [0, 1, 2, 3];
    return slots.sort((a, b) => {
      const aa = d.lives[a] > 0, bb = d.lives[b] > 0;
      if (aa !== bb) return aa ? -1 : 1;
      if (aa) return d.lives[b] - d.lives[a] || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
    if (!me || !me.alive) return IDLE;
    const d = w.data as Data;
    const H = BD_HALF;
    const [nx, nz] = BD_NORMALS[slot];
    // beach ball: aim a caught ball at the weakest rival goal, then let go
    if (d.held[slot]) {
      let tgt = -1;
      for (let s = 0; s < MAX_SEATS; s++) if (s !== slot && d.lives[s] > 0 && (tgt < 0 || d.lives[s] < d.lives[tgt])) tgt = s;
      const [tx, tz] = tgt >= 0 ? BD_NORMALS[tgt] : [0, 0];
      const dx = tx * H - me.x, dz = tz * H - me.z, l = Math.hypot(dx, dz) || 1;
      return { x: (dx / l) * 0.4, y: (dz / l) * 0.4, a: false, b: d.holdT[slot] < 0.45 };
    }
    // most threatening ball: soonest to reach my line
    let best: Body | null = null, bestT = Infinity;
    for (const b of w.bodies) {
      if (b.kind !== 'ball') continue;
      const vn = b.vx * nx + b.vz * nz;
      if (vn <= 0.1) continue;
      const t = (H - (nx * b.x + nz * b.z)) / vn;
      if (t < bestT) { bestT = t; best = b; }
    }
    let target = 0;
    let depth = H - 1.9;
    if (best) {
      const vl = lat(slot, best.vx, best.vz);
      target = clamp(fold(lat(slot, best.x, best.z) + vl * bestT), -BD_GOAL + 0.3, BD_GOAL - 0.3);
      if (bestT < 1.0) depth = H - 2.8; // step out to meet the ball
    } else if (d.variant === 'nballism' && d.shield[slot] <= 0) {
      const post = w.bodies.find((q) => q.kind === 'post' && q.slot === slot);
      if (post && post.cd <= 0) { const dx = post.x - me.x, dz = post.z - me.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, y: dz / l, a: false, b: false }; }
    }
    if (best && bestT > 2.4 && d.variant === 'nballism' && d.shield[slot] <= 0) {
      const post = w.bodies.find((q) => q.kind === 'post' && q.slot === slot);
      if (post && post.cd <= 0) { const dx = post.x - me.x, dz = post.z - me.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, y: dz / l, a: false, b: false }; }
    }
    const tx = nx * depth + (slot < 2 ? target : 0);
    const tz = nz * depth + (slot < 2 ? 0 : target);
    const out: InputState = { x: clamp((tx - me.x) * 1.6, -1, 1), y: clamp((tz - me.z) * 1.6, -1, 1), a: false, b: false };
    if (best) {
      const dist = Math.hypot(best.x - me.x, best.z - me.z);
      if (dist < 2.1 && me.cd <= 0) out.a = true;
      if (d.variant === 'beach' && dist < 3.2 && bestT < 1.6) out.b = true;
    }
    return out;
  },
};
