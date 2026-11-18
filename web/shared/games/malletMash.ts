import { addBody, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';

/**
 * MALLET MASH (Crash Bash level 29, family 0x10e).
 * Disc text (0150): "DESTROY THE MUSHROOMS WITH YOUR MALLET TO SCORE POINTS / WIN BY BEING THE PLAYER WITH THE
 * HIGHEST SCORE WHEN TIME RUNS OUT / PRESS TO HIT MUSHROOMS / PRESS AND HOLD DOWN TO GENERATE A SHOCK WAVE /
 * COLLECT POWER UPS FROM INSIDE THE SPECIAL CRATES / COLLECT SPEEDY BOOTS TO MOVE FASTER / COLLECT EXTRA POWER
 * SHOCK WAVE / HIT MUSHROOMS TO SCORE POINTS, SCORE MORE POINTS WHEN THE MUSHROOM IS SHAKING / MUSHROOM 2, 3, 5
 * POINTS / GOLD MUSHROOM 10, 15, 20 / (crystal challenge) BEWARE OF YOUR OPPONENTS' SHOCK WAVES".
 *
 * Rules implemented
 *  - Mushrooms pop out of 16 holes. Each is worth 3 stages of points: rising 2 / standing 3 / SHAKING 5
 *    (it shakes just before it ducks back down). Gold mushrooms (rarer): 10 / 15 / 20.
 *  - A = swing the mallet (cone in front of you). Hold A (~0.9 s) and release for a SHOCK WAVE: a ring around you that
 *    smashes every mushroom inside it and stuns rivals. Charging slows you down.
 *  - Special crates hold SPEEDY BOOTS (faster for 10 s) or EXTRA POWER (bigger shock wave for 14 s).
 *  - Highest score when time runs out wins.
 *
 * world.data (Data): score[4], stun[4], boots[4], power[4] (seconds left), hold[4] (seconds A has been held),
 *   swingCd[4], prevA[4], holes[] ({x,z, st, t, dur, gold}), nextSpawn, nextCrate.
 *   hole.st: 0 empty, 1 rising, 2 standing, 3 shaking, 4 ducking, 5 smashed. hole.t = time in state.
 * Bodies: 'player', 'crate' (cd = 1 boots / 2 extra power).
 * Events: 'rise' (mushroom pops up; v 1 = gold), 'swing' (s, x/z = hammer spot), 'whiff', 'smash' (s, v points, o = 1
 *   gold), 'wave' (s, v radius), 'stun' (s victim, o attacker), 'crate' (s, v item), 'combo'.
 */
export const MM_HALF = 9.6;
export const MM_SPACING = 3.4;
const SWING_REACH = 1.9, SWING_CD = 0.42, WAVE_CHARGE = 0.9, WAVE_R = 2.9, WAVE_R_POWER = 5.4;
export const MM_STARTS: [number, number][] = [[-1, 1], [1, 1], [-1, -1], [1, -1]];

export interface Hole { x: number; z: number; st: number; t: number; dur: number; gold: boolean }
export interface MalletMashData {
  score: number[]; stun: number[]; boots: number[]; power: number[]; hold: number[]; swingCd: number[]; prevA: boolean[];
  holes: Hole[]; nextSpawn: number; nextCrate: number;
}
const RISE = 0.38, SHAKE = 0.85, DUCK = 0.3, SMASHED = 0.5;
/** Points for a mushroom in state st. Gold: 10/15/20. */
export function mushroomValue(h: Hole): number {
  if (h.st < 1 || h.st > 3) return 0;
  return h.gold ? [10, 15, 20][h.st - 1] : [2, 3, 5][h.st - 1];
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');

function smash(w: World, d: MalletMashData, h: Hole, slot: number): number {
  const v = mushroomValue(h);
  h.st = 5; h.t = 0;
  d.score[slot] += v;
  emit(w, 'smash', h.x, h.z, slot, v, h.gold ? 1 : 0);
  return v;
}

/** Best mushroom in the hammer cone for this player, or null. */
function pick(d: MalletMashData, x: number, z: number, face: number): Hole | null {
  let best: Hole | null = null, bv = -1;
  const fx = Math.sin(face), fz = Math.cos(face);
  for (const h of d.holes) {
    if (h.st < 1 || h.st > 3) continue;
    const dx = h.x - x, dz = h.z - z, dd = Math.hypot(dx, dz);
    if (dd > SWING_REACH + 0.5) continue;
    if (dd > 0.9 && (dx * fx + dz * fz) / dd < 0.25) continue;
    const v = mushroomValue(h) - dd * 0.2;
    if (v > bv) { bv = v; best = h; }
  }
  return best;
}

export const malletMash: MiniGame = {
  id: 'malletMash',
  name: 'Mallet Mash',
  description: 'Mushrooms pop out of the ground. Whack them with your mallet! The more they shake, the more they are worth.',
  controls: 'A: swing mallet (hold + release: shock wave).',
  maxTime: 60,

  setup(w, slots) {
    const holes: Hole[] = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) holes.push({ x: (i - 1.5) * MM_SPACING, z: (j - 1.5) * MM_SPACING, st: 0, t: 0, dur: 0, gold: false });
    const d: MalletMashData = {
      score: [0, 0, 0, 0], stun: [0, 0, 0, 0], boots: [0, 0, 0, 0], power: [0, 0, 0, 0], hold: [0, 0, 0, 0], swingCd: [0, 0, 0, 0],
      prevA: [false, false, false, false], holes, nextSpawn: 0.5, nextCrate: 7,
    };
    w.data = d;
    for (const s of slots) {
      const [sx, sz] = MM_STARTS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, sx * (MM_HALF - 1.6), sz * (MM_HALF - 1.6), 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-sx, -sz);
    }
    void MAX_SEATS;
  },

  step(w, inputs, dt) {
    const d = w.data as MalletMashData;
    const ps = players(w);

    // mushroom life cycle
    let active = 0;
    for (const h of d.holes) {
      if (h.st === 0) continue;
      h.t += dt;
      if (h.st === 1 && h.t >= RISE) { h.st = 2; h.t = 0; }
      else if (h.st === 2 && h.t >= h.dur) { h.st = 3; h.t = 0; }
      else if (h.st === 3 && h.t >= SHAKE) { h.st = 4; h.t = 0; }
      else if (h.st === 4 && h.t >= DUCK) { h.st = 0; h.t = 0; }
      else if (h.st === 5 && h.t >= SMASHED) { h.st = 0; h.t = 0; }
      if (h.st >= 1 && h.st <= 3) active++;
    }
    d.nextSpawn -= dt;
    const maxActive = Math.min(9, 5 + Math.floor(w.time / 15));
    if (d.nextSpawn <= 0 && active < maxActive) {
      const free = d.holes.filter((h) => h.st === 0);
      if (free.length) {
        const h = free[Math.floor(rand(w) * free.length)];
        h.st = 1; h.t = 0; h.dur = 0.9 + rand(w) * 1.1; h.gold = rand(w) < 0.12;
        emit(w, 'rise', h.x, h.z, -1, h.gold ? 1 : 0);
      }
      d.nextSpawn = Math.max(0.22, 0.55 - w.time * 0.006) / w.params.spawnRate * (0.7 + rand(w) * 0.6);
    }
    d.nextCrate -= dt;
    if (d.nextCrate <= 0) {
      if (w.bodies.filter((b) => b.kind === 'crate').length < 2) {
        // somewhere between the holes
        const c = addBody(w, 'crate', -1, (Math.floor(rand(w) * 3) - 1) * MM_SPACING, (Math.floor(rand(w) * 3) - 1) * MM_SPACING, 0.7, 1);
        c.x += MM_SPACING / 2 * (rand(w) < 0.5 ? 1 : -1) ; c.z += MM_SPACING / 2 * (rand(w) < 0.5 ? 1 : -1);
        c.cd = rand(w) < 0.5 ? 1 : 2; c.y = 7;
      }
      d.nextCrate = 9 + rand(w) * 5;
    }

    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.boots[s] = Math.max(0, d.boots[s] - dt);
      d.power[s] = Math.max(0, d.power[s] - dt);
      d.swingCd[s] = Math.max(0, d.swingCd[s] - dt);
      const stunned = d.stun[s] > 0;
      const press = inp.a && !d.prevA[s] && !stunned;
      const release = !inp.a && d.prevA[s];
      d.prevA[s] = inp.a && !stunned;

      if (stunned) d.hold[s] = 0;
      else if (inp.a) d.hold[s] += dt;
      if (press && d.swingCd[s] <= 0) {
        d.swingCd[s] = SWING_CD;
        const h = pick(d, p.x, p.z, p.face);
        emit(w, 'swing', p.x + Math.sin(p.face) * 1.2, p.z + Math.cos(p.face) * 1.2, s, 1);
        if (h) smash(w, d, h, s); else emit(w, 'whiff', p.x + Math.sin(p.face) * 1.3, p.z + Math.cos(p.face) * 1.3, s, 1);
      }
      if (release && !stunned && d.hold[s] >= WAVE_CHARGE) {
        const R = d.power[s] > 0 ? WAVE_R_POWER : WAVE_R;
        emit(w, 'wave', p.x, p.z, s, R);
        for (const h of d.holes) if (h.st >= 1 && h.st <= 3 && Math.hypot(h.x - p.x, h.z - p.z) < R) smash(w, d, h, s);
        for (const q of ps) {
          if (q === p) continue;
          const dx = q.x - p.x, dz = q.z - p.z, dd = Math.hypot(dx, dz);
          if (dd < R + 0.4 && d.stun[q.slot] <= 0.4) {
            d.stun[q.slot] = 1.4;
            q.vx = (dx / (dd || 1)) * 8; q.vz = (dz / (dd || 1)) * 8;
            emit(w, 'stun', q.x, q.z, q.slot, 1, s);
          }
        }
        d.swingCd[s] = 0.8;
      }
      if (!inp.a || stunned) d.hold[s] = 0;
      const slow = d.hold[s] > 0.25 ? 0.5 : 1;
      movePlayer(w, p, stunned ? IDLE : { x: inp.x * slow, y: inp.y * slow, a: false, b: false }, dt, 14, d.boots[s] > 0 ? 10.5 : 7.2);
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) collideCircles(ps[i], ps[j], 0.5, effMass(ps[i]), effMass(ps[j]));
    for (const p of ps) {
      const lim = MM_HALF - p.r;
      if (Math.abs(p.x) > lim) { p.x = Math.sign(p.x) * lim; p.vx = 0; }
      if (Math.abs(p.z) > lim) { p.z = Math.sign(p.z) * lim; p.vz = 0; }
    }

    // crates
    for (const c of w.bodies) {
      if (c.kind !== 'crate') continue;
      if (c.y > 0) { c.vy -= 20 * dt; c.y = Math.max(0, c.y + c.vy * dt); if (c.y === 0) c.vy = 0; continue; }
      for (const p of ps) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + c.r) {
          c.alive = false;
          if (c.cd === 1) d.boots[p.slot] = 10; else d.power[p.slot] = 14;
          emit(w, 'crate', c.x, c.z, p.slot, c.cd);
          break;
        }
      }
    }
    w.bodies = w.bodies.filter((b) => b.alive);
  },

  isOver(w) {
    return w.time >= malletMash.maxTime;
  },

  placements(w) {
    const d = w.data as MalletMashData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  bot(w, slot): InputState {
    const d = w.data as MalletMashData;
    const me = players(w).find((p) => p.slot === slot);
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (!me || d.stun[slot] > 0) return out;
    const go = (tx: number, tz: number, k = 1) => {
      const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
      out.x = (dx / l) * k; out.y = (dz / l) * k;
    };
    const R = d.power[slot] > 0 ? WAVE_R_POWER : WAVE_R;
    const near = d.holes.filter((h) => h.st >= 1 && h.st <= 3 && Math.hypot(h.x - me.x, h.z - me.z) < R - 0.4).length;
    // keep a shock wave charging while it would pay off
    if (d.hold[slot] > 0 && near >= 2) {
      out.a = d.hold[slot] < WAVE_CHARGE + 0.05;
      return out;
    }
    // best mushroom: value per distance; skip ones a rival is clearly closer to
    let best: Hole | null = null, bs = -1;
    for (const h of d.holes) {
      if (h.st < 1 || h.st > 3) continue;
      const dd = Math.hypot(h.x - me.x, h.z - me.z);
      let rival = 99;
      for (const q of players(w)) if (q.slot !== slot) rival = Math.min(rival, Math.hypot(h.x - q.x, h.z - q.z));
      const home = MM_STARTS[slot];
      const s = mushroomValue(h) / (dd + 1.5) * (dd <= rival ? 1.3 : 0.15) * (Math.sign(h.x) === home[0] && Math.sign(h.z) === home[1] ? 1.6 : 1);
      if (s > bs) { bs = s; best = h; }
    }
    // crates
    for (const c of w.bodies) {
      if (c.kind !== 'crate' || c.y > 0.2) continue;
      if (Math.hypot(c.x - me.x, c.z - me.z) < 5) { go(c.x, c.z); return out; }
    }
    if (!best) {
      // pose in the middle; or go for a shock-wave stun on a close rival
      go(0, 0, 0.5);
      return out;
    }
    const dx = best.x - me.x, dz = best.z - me.z, dd = Math.hypot(dx, dz);
    // approach to hammer range
    if (dd > 1.3) go(best.x, best.z, 1);
    else go(best.x, best.z, 0.25);
    const angOk = Math.abs((((Math.atan2(dx, dz) - me.face) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.7;
    if (dd < SWING_REACH && angOk && d.swingCd[slot] <= 0) {
      const rivalNear = players(w).some((q) => q.slot !== slot && Math.hypot(q.x - best!.x, q.z - best!.z) < 3);
      if (best.st === 3 || best.gold || rivalNear || best.st === 2 && best.t > 0.5) out.a = true;
    }
    // several mushrooms bunched: start charging a shock wave
    if (near >= 2 && !out.a && d.swingCd[slot] <= 0 && w.tick % 5 === 0) out.a = true;
    return out;
  },
};
