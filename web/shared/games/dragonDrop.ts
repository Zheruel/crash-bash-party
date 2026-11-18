import { addBody, clamp, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';

/**
 * DRAGON DROP (Crash Bash level 28, family 0x10b).
 * Disc text (0142): "BURST YOUR OWN BALLOONS TO SCORE / JUMP TO BURST BALLOONS / WIN BY BEING THE PLAYER WITH
 * THE HIGHEST SCORE WHEN TIME RUNS OUT / PRESS TO ATTACK OTHER PLAYERS / PRESS TO JUMP / COLLECT POWER UPS FROM
 * INSIDE THE SPECIAL CRATES / HOVER BOOTS ALLOW YOU TO MOVE FREELY IN ANY DIRECTION / ATTRACT BALLOONS TOWARDS
 * YOU / BURST BLACK BALLOONS TO AFFECT THE ACTION: BURSTS OTHER PLAYERS' BALLOONS, CHANGES THE RING'S DIRECTION,
 * CHANGES ALL BALLOONS TO YOUR COLOR / (crystal challenge) AVOID BURSTING BALLOONS THAT ARE NOT YOUR COLOR".
 *
 * Rules implemented
 *  - A dragon in the middle spits out balloons in the four player colours (and the odd black one). Players run on a
 *    slowly rotating RING platform (it carries them round) and may not leave it without hover boots.
 *  - Jump into a balloon of YOUR colour to burst it: +1 point (chain 3+ pops within 1.5 s: +2 each).
 *    Bursting another colour only pops it (denies the owner). Balloons that nobody pops float away.
 *  - Black balloons: random effect  0 = pops every other player's balloons, 1 = reverses the ring, 2 = recolours
 *    every balloon to the popper's colour.
 *  - Special crates (touch to open): HOVER BOOTS (free movement incl. over the middle) or MAGNET (your balloons
 *    drift towards you), both timed.
 *  - B = attack: a short punch that stuns and shoves a rival. Highest score when time runs out wins.
 *
 * world.data (Data): score[4], stun[4], hover[4] / magnet[4] seconds left, streak[4], streakT[4], ring (current
 *   angular speed, rad/s), dir (+1/-1 target direction), nextBalloon, nextCrate (times), prevB[4].
 * Bodies: 'player'; 'balloon' (slot = colour owner, -1 = black; cd = age; m = 1 normal, 0 once floating away);
 *   'crate' (cd = item 1 hover / 2 magnet).
 * Events: 'pop' (s popper, o balloon owner, v 1 = own colour), 'score' (s, v points), 'black' (s, v effect 0..2),
 *   'reverse', 'crate' (s, v item), 'punch' (s attacker, o victim), 'spawn' (balloon spit out), 'fade'.
 */
export const DD_IN = 2.7; // hub radius (stone pit in the middle; players start here, it does not turn)
export const DD_OUT = 8.5; // outer ring radius
export const DD_DRAGON = 0; // kept for the old view API (the hub is open: players start in it)
const RING_W = 0.32;
export const DD_STARTS: [number, number][] = [[0, 0.9], [-0.9, 0], [0, -0.9], [0.9, 0]]; // inside the hub
const MAX_BALLOONS = 28;
export const DD_MAX_AGE = 15;

export interface DragonDropData {
  score: number[]; stun: number[]; hover: number[]; magnet: number[]; streak: number[]; streakT: number[]; prevB: boolean[];
  ring: number; dir: number; nextBalloon: number; nextCrate: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');

function spawnBalloon(w: World, slot: number) {
  const a = rand(w) * Math.PI * 2;
  const R = 1.5 + rand(w) * (DD_OUT + 1.5);
  const b = addBody(w, 'balloon', slot, Math.cos(a) * 1.8, Math.sin(a) * 1.8, 0.5, 1);
  b.y = 4.6;
  b.vx = Math.cos(a) * R * 1.6; b.vz = Math.sin(a) * R * 1.6;
  b.vy = 2 + rand(w) * 2;
  b.cd = 0; b.m = 1;
  b.face = 1.8 + rand(w) * 0.7; // preferred float height
  emit(w, 'spawn', b.x, b.z, slot, 1);
}

function spawnCrate(w: World) {
  const a = rand(w) * Math.PI * 2;
  const R = DD_IN + 0.8 + rand(w) * (DD_OUT - DD_IN - 2);
  const c = addBody(w, 'crate', -1, Math.cos(a) * R, Math.sin(a) * R, 0.7, 1);
  c.cd = rand(w) < 0.5 ? 1 : 2;
  c.y = 6; c.vy = 0;
}

export const dragonDrop: MiniGame = {
  id: 'dragonDrop',
  name: 'Dragon Drop',
  description: 'The dragon drops balloons on a spinning ring. Jump to burst the ones in YOUR colour. Black balloons shake things up!',
  controls: 'A: jump (burst balloons). B: attack rivals.',
  maxTime: 90,

  setup(w, slots) {
    const d: DragonDropData = {
      score: [0, 0, 0, 0], stun: [0, 0, 0, 0], hover: [0, 0, 0, 0], magnet: [0, 0, 0, 0], streak: [0, 0, 0, 0], streakT: [0, 0, 0, 0],
      prevB: [false, false, false, false], ring: 0.3, dir: 1, nextBalloon: 0.2, nextCrate: 6,
    };
    w.data = d;
    for (const s of slots) {
      const [nx, nz] = DD_STARTS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, nx * 1.7, nz * 1.7, 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-nx, -nz);
    }
    for (let i = 0; i < 8; i++) spawnBalloon(w, i % 4);
    void MAX_SEATS;
  },

  step(w, inputs, dt) {
    const d = w.data as DragonDropData;
    const ps = players(w);

    // ring speed eases towards direction
    d.ring += (d.dir * 0.34 - d.ring) * Math.min(1, dt * 1.6);
    const dth = d.ring * dt;
    const cs = Math.cos(dth), sn = Math.sin(dth);
    const rot = (b: Body) => { const x = b.x * cs - b.z * sn; b.z = b.x * sn + b.z * cs; b.x = x; };

    // spawning
    const balloons = w.bodies.filter((b) => b.kind === 'balloon' && b.m > 0);
    d.nextBalloon -= dt;
    if (d.nextBalloon <= 0 && balloons.length < MAX_BALLOONS) {
      spawnBalloon(w, rand(w) < 0.14 ? -1 : Math.floor(rand(w) * 4));
      d.nextBalloon = (0.3 + rand(w) * 0.25) / w.params.spawnRate;
    }
    d.nextCrate -= dt;
    if (d.nextCrate <= 0) {
      if (w.bodies.filter((b) => b.kind === 'crate').length < 2) spawnCrate(w);
      d.nextCrate = 9 + rand(w) * 5;
    }

    // players
    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.hover[s] = Math.max(0, d.hover[s] - dt);
      d.magnet[s] = Math.max(0, d.magnet[s] - dt);
      d.streakT[s] = Math.max(0, d.streakT[s] - dt);
      if (d.streakT[s] <= 0) d.streak[s] = 0;
      const stunned = d.stun[s] > 0;
      const hov = d.hover[s] > 0;
      movePlayer(w, p, stunned ? IDLE : { ...inp, b: false }, dt, 14, hov ? 8.6 : 7.4);
      // attack (edge)
      const press = inp.b && !d.prevB[s] && !stunned;
      d.prevB[s] = inp.b;
      if (press && p.cd <= 0.0001) {
        p.cd = 0.8; p.dash = 0.18;
        emit(w, 'punch', p.x, p.z, s, 1);
        for (const q of ps) {
          if (q === p || d.stun[q.slot] > 0) continue;
          const dx = q.x - p.x, dz = q.z - p.z, dd = Math.hypot(dx, dz);
          if (dd < 2.0 && dd > 0 && (dx * Math.sin(p.face) + dz * Math.cos(p.face)) / dd > 0.2) {
            d.stun[q.slot] = 1.1;
            q.vx = (dx / dd) * 9; q.vz = (dz / dd) * 9; q.vy = 3.5;
            emit(w, 'punch', q.x, q.z, s, 2, q.slot);
          }
        }
      }
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) collideCircles(ps[i], ps[j], 0.5, effMass(ps[i]), effMass(ps[j]));

    for (const p of ps) {
      const hov = d.hover[p.slot] > 0;
      const dd = Math.hypot(p.x, p.z) || 1;
      const hi = (hov ? DD_OUT + 1.4 : DD_OUT) - p.r;
      if (dd > hi) { p.x = (p.x / dd) * hi; p.z = (p.z / dd) * hi; p.vx *= 0.3; p.vz *= 0.3; }
      if (!hov && dd > DD_IN) rot(p); // the ring carries you (the hub stays put)
    }

    // balloons
    for (const b of balloons) {
      b.cd += dt;
      // spit-out flight with drag, then hover and drift
      const drag = Math.exp(-1.5 * dt);
      b.vx *= drag; b.vz *= drag;
      b.x += b.vx * dt; b.z += b.vz * dt;
      const settle = b.cd > 0.5;
      if (settle) { b.x += Math.sin(w.time * 0.9 + b.id) * 0.25 * dt; b.z += Math.cos(w.time * 0.7 + b.id * 1.7) * 0.25 * dt; }
      const ty = b.cd > DD_MAX_AGE - 2 ? 8 : b.face + Math.sin(w.time * 2 + b.id) * 0.18;
      b.vy += (ty - b.y) * 6 * dt - b.vy * 2.2 * dt;
      b.y += b.vy * dt;
      if (b.cd > 0.6 && Math.hypot(b.x, b.z) > DD_IN) rot(b);
      // magnets
      if (b.slot >= 0 && d.magnet[b.slot] > 0) {
        const m = ps.find((q) => q.slot === b.slot);
        if (m) {
          const dx = m.x - b.x, dz = m.z - b.z, dd = Math.hypot(dx, dz) || 1;
          if (dd > 0.9) { const k = 3.6 * dt; b.x += (dx / dd) * k * Math.min(dd, 5); b.z += (dz / dd) * k * Math.min(dd, 5); }
        }
      }
      // keep over the ring (loosely)
      const dd = Math.hypot(b.x, b.z) || 1;
      if (b.cd > 0.6 && dd > DD_OUT + 3) { const k = (DD_OUT + 3) / dd; b.x *= k; b.z *= k; }
      if (b.cd > DD_MAX_AGE) { b.alive = false; emit(w, 'fade', b.x, b.z, b.slot, 1); continue; }
    }

    // bursting (jump into a balloon)
    for (const p of ps) {
      if (d.stun[p.slot] > 0) continue;
      const reach = p.y + 1.55;
      for (const b of balloons) {
        if (!b.alive || b.cd < 0.5) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) > p.r + b.r * 0.85) continue;
        if (reach < b.y - 0.1 || p.y > b.y + 0.4) continue;
        b.alive = false;
        const own = b.slot === p.slot;
        emit(w, 'pop', b.x, b.z, p.slot, own ? 1 : 0, b.slot);
        if (b.slot < 0) {
          const eff = Math.floor(rand(w) * 3);
          emit(w, 'black', b.x, b.z, p.slot, eff);
          if (eff === 0) {
            for (const o of balloons) if (o.alive && o.slot >= 0 && o.slot !== p.slot) { o.alive = false; emit(w, 'pop', o.x, o.z, p.slot, 0, o.slot); }
          } else if (eff === 1) { d.dir = -d.dir; emit(w, 'reverse', 0, 0, p.slot, d.dir); }
          else for (const o of balloons) if (o.alive && o.slot >= 0) { o.slot = p.slot; }
        } else if (own) {
          d.streak[p.slot]++; d.streakT[p.slot] = 1.5;
          const pts = d.streak[p.slot] >= 3 ? 2 : 1;
          d.score[p.slot] += pts;
          emit(w, 'score', b.x, b.z, p.slot, pts);
        }
      }
    }

    // crates
    for (const c of w.bodies) {
      if (c.kind !== 'crate') continue;
      if (c.y > 0) { c.vy -= 20 * dt; c.y = Math.max(0, c.y + c.vy * dt); if (c.y === 0) c.vy = 0; rot(c); continue; }
      rot(c);
      for (const p of ps) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + c.r) {
          c.alive = false;
          if (c.cd === 1) d.hover[p.slot] = 9; else d.magnet[p.slot] = 9;
          emit(w, 'crate', c.x, c.z, p.slot, c.cd);
          break;
        }
      }
    }
    w.bodies = w.bodies.filter((b) => b.alive);
    void RING_W;
    void clamp;
  },

  isOver(w) {
    return w.time >= dragonDrop.maxTime;
  },

  placements(w) {
    const d = w.data as DragonDropData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  bot(w, slot): InputState {
    const d = w.data as DragonDropData;
    const me = players(w).find((p) => p.slot === slot);
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (!me || d.stun[slot] > 0) return out;
    const go = (tx: number, tz: number, k = 1) => {
      const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
      out.x = (dx / l) * k; out.y = (dz / l) * k;
    };
    // best balloon: mine (or black when none), the nearest by a lead-adjusted distance
    let tgt: Body | null = null, bs = 1e9;
    for (const b of w.bodies) {
      if (b.kind !== 'balloon' || b.cd < 0.6 || b.cd > DD_MAX_AGE - 2) continue;
      const own = b.slot === slot;
      if (!own && b.slot >= 0) continue;
      const score = Math.hypot(b.x - me.x, b.z - me.z) + (own ? 0 : 4);
      if (score < bs) { bs = score; tgt = b; }
    }
    // crates are worth a detour
    for (const c of w.bodies) {
      if (c.kind !== 'crate' || c.y > 0.2) continue;
      const dd = Math.hypot(c.x - me.x, c.z - me.z);
      if (dd < 5 && dd < bs - 1.5) { go(c.x, c.z); return out; }
    }
    // punch a rival standing right next to us
    for (const q of players(w)) {
      if (q.slot === slot) continue;
      const dx = q.x - me.x, dz = q.z - me.z, dd = Math.hypot(dx, dz);
      if (dd < 1.7 && me.cd <= 0 && (dx * Math.sin(me.face) + dz * Math.cos(me.face)) / (dd || 1) > 0.4 && d.score[q.slot] >= d.score[slot] && w.tick % 4 === 0) { out.b = true; }
    }
    if (tgt) {
      const dd = Math.hypot(tgt.x - me.x, tgt.z - me.z);
      // lead the (rotating-ring-fixed) target only a little: it sits still relative to the ring
      go(tgt.x, tgt.z, dd < 0.6 ? 0.2 : 1);
      if (dd < 1.0 && me.y <= 0.001 && tgt.y < me.y + 2.8) out.a = true;
    } else go(0, 0, 0.1);
    return out;
  },
};
