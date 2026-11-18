import { addBody, clamp, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, type Body, type InputState, type MiniGame, type World } from '../types';

/**
 * RING DING (Crash Bash level 28 in the cheat table, family 0x103; stage model 0621, meadow arena).
 * Disc text (0148): "SCORE BY HITTING THE TARGET WITH A JEWEL / WIN BY BEING THE PLAYER WITH THE HIGHEST SCORE
 * WHEN TIME RUNS OUT / PRESS FOR SLIDE ATTACK / PRESS TO SHOOT JEWEL / PRESS AND HOLD BUTTON TO SHOOT FURTHER /
 * COLLECT JEWELS TO SHOOT AT THE TARGET / (crystal challenge) YOU CAN ONLY SCORE FROM INSIDE THE FLASHING ZONE".
 *
 * Real game (captured from the emulator): 4 players ride dinosaurs inside a round stone-walled meadow pit. Jewels lie
 * on the floor; ride over one to carry it (it hovers over the rider). A big bull's-eye TARGET circles OUTSIDE the wall
 * and you lob jewels over the wall at it. The floor is split into scoring bands (x1 outer, x2, x3, x5 = circles
 * round a point on the south rim): a hit scores the multiplier of the band the shooter STOOD in. Round = 1:30, the
 * highest score wins. The HUD shows 3-digit scores and the clock.
 *
 * Units: 1 world unit = 1/3.4 of a PS1 model unit (the same scale the character models use), arena radius 10.6.
 *
 * world.data (Data): score[4], jewels[4] carried, charge[4] seconds held (0 = not charging), stun[4], prevA[4], hits[4],
 *   nextJewel (time), ta (target orbit angle, rad; 0 = far side -z, + toward +x).
 * Bodies: 'player' (slot), 'jewel' (floor pickup, `m` = colour 0..3; vy>0 while a dropped jewel is still in the air),
 *   'shot' (slot = shooter, m = colour, cd = elapsed, dash = flight time, face = shooter band multiplier; x/z follow an arc).
 * Events: 'shoot' (s, v charge 0..1), 'score' (s, v points, x,z = target), 'miss' (landing x,z), 'pickup' (s),
 *   'slam' (s victim, o attacker, v jewels dropped), 'dash'/'jump' from physics.
 */
export const RD_R = 10.6; // floor radius
export const RD_WALL = 11.2; // stone wall (solid)
export const RD_TRACK = 19; // target orbit radius (outside the wall)
export const RD_HIT = 3.2; // jewel counts as a hit when it lands this close to the target
export const RD_MAX_JEWELS = 3;
export const RD_MIN_RANGE = 5;
export const RD_MAX_RANGE = 31;
export const RD_CHARGE = 0.9; // seconds for a full charge
export const RD_TARGET_PERIOD = 11.5; // seconds per target lap
/** Band circles are centred on the south rim point (0, RD_ZC); radii for x5, x3, x2 (x1 beyond). */
export const RD_ZC = 9.2;
export const RD_BANDS: [number, number][] = [[3.7, 5], [7.5, 3], [12.2, 2]];
// slot 0 bottom-left, 1 top-left, 2 top-right, 3 bottom-right (as seen from the default camera)
export const RD_STARTS: [number, number][] = [[-5.2, 5.2], [-5.2, -5.8], [5.2, -5.8], [5.2, 5.2]];

export interface RingDingData {
  score: number[]; jewels: number[]; charge: number[]; stun: number[]; prevA: boolean[]; hits: number[];
  nextJewel: number; ta: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const angDiff = (a: number, b: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

/** Score multiplier of the floor band at (x, z). */
export function rdBand(x: number, z: number): number {
  const d = Math.hypot(x, z - RD_ZC);
  for (const [r, m] of RD_BANDS) if (d < r) return m;
  return 1;
}
/** Target angle at time t (it laps the arena clockwise seen from above: right -> left across the far side). */
export const rdTargetAngle = (t: number) => 0.9 - (t / RD_TARGET_PERIOD) * Math.PI * 2;
export const rdTargetPos = (t: number): [number, number] => { const a = rdTargetAngle(t); return [Math.sin(a) * RD_TRACK, -Math.cos(a) * RD_TRACK]; };
/** Range a given charge (0..1) will land at. */
export const rdRange = (c: number) => RD_MIN_RANGE + clamp(c, 0, 1) * (RD_MAX_RANGE - RD_MIN_RANGE);
const flightTime = (range: number) => 0.5 + range * 0.03;

/** Where aiming at the (moving) target from (x,z) should land: lead included. Returns [aimAngle, range, tx, tz]. */
export function rdSolve(t: number, x: number, z: number): [number, number, number, number] {
  let T = 1, tx = 0, tz = 0;
  for (let i = 0; i < 4; i++) {
    [tx, tz] = rdTargetPos(t + T);
    T = flightTime(Math.hypot(tx - x, tz - z));
  }
  return [Math.atan2(tx - x, tz - z), Math.hypot(tx - x, tz - z), tx, tz];
}

function spawnJewel(w: World, x?: number, z?: number, pop = false, col?: number) {
  if (x === undefined || z === undefined) {
    const a = rand(w) * Math.PI * 2;
    const r = 1.5 + rand(w) * (RD_R - 4);
    x = Math.cos(a) * r; z = Math.sin(a) * r;
  }
  const j = addBody(w, 'jewel', -1, x, z, 0.9, 1);
  j.m = col ?? Math.floor(rand(w) * 4);
  if (pop) { const a = rand(w) * Math.PI * 2; j.vx = Math.cos(a) * 4; j.vz = Math.sin(a) * 4; j.vy = 6; j.y = 0.8; }
  return j;
}

export const ringDing: MiniGame = {
  id: 'ringDing',
  name: 'Ring Ding',
  description: 'Ride your dino, grab jewels and lob them at the big target circling outside the wall. Shooting from the far band scores x5!',
  controls: 'A: shoot jewel (hold to shoot further). B: slide attack.',
  maxTime: 90,

  setup(w, slots) {
    const d: RingDingData = {
      score: [0, 0, 0, 0], jewels: [0, 0, 0, 0], charge: [0, 0, 0, 0], stun: [0, 0, 0, 0], prevA: [false, false, false, false],
      hits: [0, 0, 0, 0], nextJewel: 2.5, ta: rdTargetAngle(0),
    };
    w.data = d;
    for (const s of slots) {
      const [sx, sz] = RD_STARTS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, sx, sz, 1.1 * sc, 3 * sc * sc);
      b.face = Math.atan2(-sx, -sz);
    }
    spawnJewel(w, -4, 0.2, false, 3); spawnJewel(w, 4, 0.2, false, 1);
  },

  step(w, inputs, dt) {
    const d = w.data as RingDingData;
    const ps = players(w);
    d.ta = rdTargetAngle(w.time);

    // jewel supply
    d.nextJewel -= dt;
    const onFloor = w.bodies.filter((b) => b.kind === 'jewel').length;
    if (d.nextJewel <= 0 && onFloor < 5) { spawnJewel(w); d.nextJewel = (2.2 + rand(w) * 1.6) / w.params.spawnRate; }

    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      const stunned = d.stun[s] > 0;
      const charging = !stunned && inp.a && d.jewels[s] > 0;
      if (charging) d.charge[s] = Math.min(RD_CHARGE, d.charge[s] + dt);
      const released = d.prevA[s] && !inp.a;
      if (stunned) d.charge[s] = 0;
      else if (released && d.charge[s] > 0 && d.jewels[s] > 0) {
        const c = d.charge[s] / RD_CHARGE;
        const range = rdRange(c);
        const T = flightTime(range);
        // aim assist: snap to the target (with lead) when roughly facing it
        let face = p.face;
        const [aim] = rdSolve(w.time, p.x, p.z);
        if (Math.abs(angDiff(face, aim)) < 0.5) face = aim;
        p.face = face;
        const sh = addBody(w, 'shot', s, p.x + Math.sin(face) * 1.2, p.z + Math.cos(face) * 1.2, 0.5, 1);
        sh.y = 2.4; sh.face = face; sh.m = s;
        sh.vx = (Math.sin(face) * (range - 1.2)) / T; sh.vz = (Math.cos(face) * (range - 1.2)) / T;
        sh.cd = 0; sh.dash = T;
        sh.fall = false;
        (sh as Body & { mult?: number }).mult = rdBand(p.x, p.z);
        d.jewels[s]--;
        emit(w, 'shoot', p.x, p.z, s, c);
        d.charge[s] = 0;
      } else if (!charging) d.charge[s] = 0;
      d.prevA[s] = inp.a && !stunned;

      const aim = d.charge[s] > 0;
      movePlayer(w, p, stunned ? IDLE : { x: inp.x * (aim ? 0.5 : 1), y: inp.y * (aim ? 0.5 : 1), a: false, b: inp.b && !aim }, dt, 12, 8.2);
    }

    // player vs player + slide attack
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 0.1) {
          for (const [x, y] of [[a, b], [b, a]] as [Body, Body][]) {
            if (x.dash > 0 && y.dash <= 0 && d.stun[y.slot] <= 0) {
              d.stun[y.slot] = 1.0;
              const drop = Math.ceil(d.jewels[y.slot] / 2);
              d.jewels[y.slot] -= drop;
              d.charge[y.slot] = 0;
              for (let k = 0; k < drop; k++) spawnJewel(w, y.x, y.z, true);
              emit(w, 'slam', y.x, y.z, y.slot, drop, x.slot);
            }
          }
        }
        collideCircles(a, b, 0.6, effMass(a), effMass(b));
      }
    }
    for (const p of ps) {
      const dd = Math.hypot(p.x, p.z) || 1;
      const hi = RD_R - p.r * 0.6;
      if (dd > hi) { p.x = (p.x / dd) * hi; p.z = (p.z / dd) * hi; p.vx *= 0.4; p.vz *= 0.4; }
    }

    // floor jewels
    for (const b of w.bodies) {
      if (b.kind !== 'jewel') continue;
      if (b.y > 0 || b.vy > 0) {
        b.vy -= 22 * dt; b.y += b.vy * dt; b.x += b.vx * dt; b.z += b.vz * dt;
        if (b.y <= 0) { b.y = 0; b.vy = 0; b.vx *= 0.2; b.vz *= 0.2; }
        const dd = Math.hypot(b.x, b.z) || 1;
        if (dd > RD_R - 1) { b.x = (b.x / dd) * (RD_R - 1); b.z = (b.z / dd) * (RD_R - 1); }
        continue;
      }
      for (const p of ps) {
        if (d.stun[p.slot] > 0 || d.jewels[p.slot] >= RD_MAX_JEWELS) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < p.r + b.r) {
          d.jewels[p.slot]++; b.alive = false;
          emit(w, 'pickup', b.x, b.z, p.slot, b.m);
          break;
        }
      }
    }

    // shots in flight
    for (const sh of w.bodies) {
      if (sh.kind !== 'shot') continue;
      sh.cd += dt;
      const u = clamp(sh.cd / sh.dash, 0, 1);
      sh.x += sh.vx * dt; sh.z += sh.vz * dt;
      sh.y = 2.4 + Math.sin(u * Math.PI) * (1.5 + sh.dash * 3) - u * 2.4;
      if (sh.cd >= sh.dash) {
        sh.alive = false;
        const [tx, tz] = rdTargetPos(w.time);
        if (Math.hypot(sh.x - tx, sh.z - tz) < RD_HIT) {
          const pts = (sh as Body & { mult?: number }).mult ?? 1;
          d.score[sh.slot] += pts; d.hits[sh.slot]++;
          emit(w, 'score', tx, tz, sh.slot, pts);
        } else emit(w, 'miss', sh.x, sh.z, sh.slot, 1);
      }
    }
    w.bodies = w.bodies.filter((b) => b.alive);
  },

  isOver(w) {
    return w.time >= ringDing.maxTime;
  },

  placements(w) {
    const d = w.data as RingDingData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || d.hits[b] - d.hits[a] || a - b);
  },

  bot(w, slot): InputState {
    const d = w.data as RingDingData;
    const me = players(w).find((p) => p.slot === slot);
    if (!me) return IDLE;
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (d.stun[slot] > 0) return out;
    const go = (tx: number, tz: number, k = 1) => {
      const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
      out.x = (dx / l) * k; out.y = (dz / l) * k;
    };
    if (d.jewels[slot] > 0) {
      // walk to the south rim band (x5/x3), face the target and charge to the needed range
      const [aim, range] = rdSolve(w.time, me.x, me.z);
      const want = clamp((range - RD_MIN_RANGE) / (RD_MAX_RANGE - RD_MIN_RANGE), 0, 1);
      const reachable = range < RD_MAX_RANGE - 0.5;
      if (d.charge[slot] > 0) {
        out.a = d.charge[slot] / RD_CHARGE < want;
        const k = 0.3; out.x = Math.sin(aim) * k; out.y = Math.cos(aim) * k;
        return out;
      }
      const mult = rdBand(me.x, me.z);
      const hotspot: [number, number] = [Math.sin(aim + Math.PI) * 4, 5 + Math.cos(aim + Math.PI) * 2];
      if (mult >= 3 && reachable && Math.abs(angDiff(me.face, aim)) < 0.35) { out.a = true; go(me.x + Math.sin(aim), me.z + Math.cos(aim), 0.3); return out; }
      if (mult < 3 || !reachable) { go(hotspot[0], hotspot[1], 0.9); return out; }
      go(me.x + Math.sin(aim), me.z + Math.cos(aim), 0.35);
      return out;
    }
    let best: Body | null = null, bd = 1e9;
    for (const b of w.bodies) {
      if (b.kind !== 'jewel') continue;
      const dd = Math.hypot(b.x - me.x, b.z - me.z);
      let rival = 1e9;
      for (const q of players(w)) if (q.slot !== slot) rival = Math.min(rival, Math.hypot(b.x - q.x, b.z - q.z));
      const sc = dd + (rival < dd ? 7 : 0);
      if (sc < bd) { bd = sc; best = b; }
    }
    for (const p of players(w)) {
      if (p.slot === slot || d.jewels[p.slot] < 1) continue;
      const dd = Math.hypot(p.x - me.x, p.z - me.z);
      if (dd < 4 && me.cd <= 0) { go(p.x, p.z); out.b = true; return out; }
    }
    if (best) go(best.x, best.z);
    else go(0, 6, 0.4);
    return out;
  },
};
