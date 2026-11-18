import { addBody, clamp, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';

/**
 * RING DING (Crash Bash level 27, family 0x103).
 * Disc text (0148): "SCORE BY HITTING THE TARGET WITH A JEWEL / WIN BY BEING THE PLAYER WITH THE HIGHEST
 * SCORE WHEN TIME RUNS OUT / PRESS FOR SLIDE ATTACK / PRESS TO SHOOT JEWEL / PRESS AND HOLD BUTTON TO SHOOT
 * FURTHER / COLLECT JEWELS TO SHOOT AT THE TARGET / (crystal challenge) YOU CAN ONLY SCORE FROM INSIDE THE
 * FLASHING ZONE".
 *
 * Rules implemented
 *  - Circular arena (radius RD_R). A target pedestal stands in the middle (radius RD_TARGET, a solid obstacle).
 *  - Jewels appear on the floor; walk over one to carry it (max RD_MAX_JEWELS).
 *  - A = shoot a jewel the way you face. Tap = short lob, HOLD to charge a longer shot (release fires).
 *    The jewel lands where the charge says: range = RD_MIN_RANGE .. RD_MAX_RANGE. Landing on the target scores:
 *    1 point, or 3 points when it lands inside the FLASHING ZONE (a wedge that relocates every few seconds).
 *  - B = slide attack: a fast dash. Hitting a rival stuns him and makes him drop half his jewels.
 *  - Highest score when time runs out wins.
 *
 * world.data (Data): score[4], jewels[4] carried, charge[4] seconds held (0 = not charging), stun[4] seconds,
 *   prevA[4], hits[4] (tie-break), nextJewel (time), zone (flash-zone centre angle, rad), zoneT (time it next moves).
 * Bodies: 'player' (slot), 'jewel' (floor pickup; vy>0 while a dropped jewel is still in the air),
 *   'shot' (slot = shooter; cd = elapsed flight time, dash = total flight time, y follows an arc).
 * Events: 'shoot' (s shooter, v charge 0..1), 'score' (s shooter, v points, x,z landing), 'miss' (landing x,z),
 *   'pickup' (s), 'slam' (s victim, o attacker, v jewels dropped), 'zone' (new zone), 'dash'/'jump' from physics.
 */
export const RD_R = 11;
export const RD_TARGET = 2.5; // scoring disc radius
export const RD_HUB = 3.4; // solid pedestal radius (players cannot enter)
export const RD_MAX_JEWELS = 5;
export const RD_MIN_RANGE = 2.5;
export const RD_MAX_RANGE = 15;
export const RD_CHARGE = 0.95; // seconds for a full charge
export const RD_ZONE_HALF = 0.85; // half-width of the flashing wedge (rad)
export const RD_STARTS: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // S, W, N, E

export interface RingDingData {
  score: number[]; jewels: number[]; charge: number[]; stun: number[]; prevA: boolean[]; hits: number[];
  nextJewel: number; zone: number; zoneT: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const angDiff = (a: number, b: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

/** Range a given charge (0..1) will land at. */
export const rdRange = (c: number) => RD_MIN_RANGE + clamp(c, 0, 1) * (RD_MAX_RANGE - RD_MIN_RANGE);
const flightTime = (range: number) => 0.45 + range * 0.035;

function spawnJewel(w: World, x?: number, z?: number, pop = false) {
  if (x === undefined || z === undefined) {
    const a = rand(w) * Math.PI * 2;
    const r = RD_HUB + 1.6 + rand(w) * (RD_R - RD_HUB - 3.2);
    x = Math.cos(a) * r; z = Math.sin(a) * r;
  }
  const j = addBody(w, 'jewel', -1, x, z, 0.55, 1);
  if (pop) { const a = rand(w) * Math.PI * 2; j.vx = Math.cos(a) * 3.5; j.vz = Math.sin(a) * 3.5; j.vy = 5; j.y = 0.6; }
  return j;
}

export const ringDing: MiniGame = {
  id: 'ringDing',
  name: 'Ring Ding',
  description: 'Collect jewels and shoot them at the target in the middle. Hit the flashing zone for triple points. Highest score wins.',
  controls: 'A: shoot jewel (hold to shoot further). B: slide attack.',
  maxTime: 60,

  setup(w, slots) {
    const d: RingDingData = {
      score: [0, 0, 0, 0], jewels: [1, 1, 1, 1], charge: [0, 0, 0, 0], stun: [0, 0, 0, 0], prevA: [false, false, false, false],
      hits: [0, 0, 0, 0], nextJewel: 0.4, zone: rand(w) * Math.PI * 2, zoneT: 5,
    };
    w.data = d;
    for (const s of slots) {
      const [nx, nz] = RD_STARTS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, nx * (RD_R - 2.2), nz * (RD_R - 2.2), 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-nx, -nz);
    }
    for (let i = 0; i < 4; i++) spawnJewel(w);
    void MAX_SEATS;
  },

  step(w, inputs, dt) {
    const d = w.data as RingDingData;
    const ps = players(w);

    // flashing zone relocates
    d.zoneT -= dt;
    if (d.zoneT <= 0) {
      d.zone = (d.zone + Math.PI * (0.6 + rand(w) * 0.8)) % (Math.PI * 2);
      d.zoneT = 4 + rand(w) * 2;
      emit(w, 'zone', Math.cos(d.zone) * RD_TARGET, Math.sin(d.zone) * RD_TARGET, -1, 1);
    }

    // jewel supply
    d.nextJewel -= dt;
    const onFloor = w.bodies.filter((b) => b.kind === 'jewel').length;
    if (d.nextJewel <= 0 && onFloor < 8) { spawnJewel(w); d.nextJewel = (0.9 + rand(w) * 0.7) / w.params.spawnRate; }

    // players
    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      const stunned = d.stun[s] > 0;
      const charging = !stunned && inp.a && d.jewels[s] > 0;
      // shooting: charge while A is held, fire on release
      if (charging) d.charge[s] = Math.min(RD_CHARGE, d.charge[s] + dt);
      const released = d.prevA[s] && !inp.a;
      if (stunned) d.charge[s] = 0;
      else if (released && d.charge[s] > 0 && d.jewels[s] > 0) {
        const c = d.charge[s] / RD_CHARGE;
        const range = rdRange(c);
        const T = flightTime(range);
        // gentle aim assist toward the target when roughly facing it
        let face = p.face;
        const toC = Math.atan2(-p.x, -p.z);
        if (Math.abs(angDiff(face, toC)) < 0.16) face = toC;
        const sh = addBody(w, 'shot', s, p.x + Math.sin(face) * 0.8, p.z + Math.cos(face) * 0.8, 0.35, 1);
        sh.y = 0.9; sh.face = face;
        sh.vx = (Math.sin(face) * (range - 0.8)) / T; sh.vz = (Math.cos(face) * (range - 0.8)) / T;
        sh.cd = 0; sh.dash = T;
        d.jewels[s]--;
        emit(w, 'shoot', p.x, p.z, s, c);
        d.charge[s] = 0;
      } else if (!charging) d.charge[s] = 0;
      d.prevA[s] = inp.a && !stunned;

      const aim = d.charge[s] > 0;
      movePlayer(w, p, stunned ? IDLE : { x: inp.x * (aim ? 0.55 : 1), y: inp.y * (aim ? 0.55 : 1), a: false, b: inp.b && !aim }, dt, 14, 7.6);
    }

    // player vs player + slide attack
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const near = Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 0.1;
        if (near) {
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
      // pedestal + wall
      const dd = Math.hypot(p.x, p.z) || 1;
      const lo = RD_HUB + p.r, hi = RD_R - p.r;
      if (dd < lo) { p.x = (p.x / dd) * lo; p.z = (p.z / dd) * lo; }
      else if (dd > hi) { p.x = (p.x / dd) * hi; p.z = (p.z / dd) * hi; p.vx *= 0.5; p.vz *= 0.5; }
    }

    // floor jewels: physics for dropped ones, pickup
    for (const b of w.bodies) {
      if (b.kind !== 'jewel') continue;
      if (b.y > 0 || b.vy > 0) {
        b.vy -= 20 * dt; b.y += b.vy * dt; b.x += b.vx * dt; b.z += b.vz * dt;
        if (b.y <= 0) { b.y = 0; b.vy = 0; b.vx *= 0.2; b.vz *= 0.2; }
        const dd = Math.hypot(b.x, b.z) || 1;
        if (dd > RD_R - 0.7) { b.x = (b.x / dd) * (RD_R - 0.7); b.z = (b.z / dd) * (RD_R - 0.7); }
        if (dd < RD_HUB + 0.6) { b.x = (b.x / dd) * (RD_HUB + 0.6); b.z = (b.z / dd) * (RD_HUB + 0.6); }
        continue;
      }
      for (const p of ps) {
        if (d.stun[p.slot] > 0 || d.jewels[p.slot] >= RD_MAX_JEWELS) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < p.r + b.r) {
          d.jewels[p.slot]++; b.alive = false;
          emit(w, 'pickup', b.x, b.z, p.slot);
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
      sh.y = 0.9 + Math.sin(u * Math.PI) * (0.8 + (sh.dash - 0.45) * 2.2) - u * 0.9;
      if (sh.cd >= sh.dash) {
        sh.alive = false;
        const r = Math.hypot(sh.x, sh.z);
        if (r < RD_TARGET) {
          let pts = 1;
          if (Math.abs(angDiff(d.zone, Math.atan2(sh.z, sh.x))) < RD_ZONE_HALF) pts = 3;
          d.score[sh.slot] += pts; d.hits[sh.slot]++;
          emit(w, 'score', sh.x, sh.z, sh.slot, pts);
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
    const dist = Math.hypot(me.x, me.z);

    if (d.jewels[slot] > 0) {
      const toC = Math.atan2(-me.x, -me.z);
      const aligned = Math.abs(angDiff(me.face, toC)) < 0.12;
      // charge needed to land on the centre (slightly randomised by tick so bots are not perfect robots)
      const want = clamp((dist - RD_MIN_RANGE + 0.8 + Math.sin(w.tick * 0.37 + slot * 2.1) * 2.6) / (RD_MAX_RANGE - RD_MIN_RANGE), 0, 1);
      if (d.charge[slot] > 0) {
        go(0, 0, 0.2);
        // keep holding until the charge matches
        out.a = d.charge[slot] / RD_CHARGE < want;
        return out;
      }
      if (dist > 5 && dist < 12 && aligned) { out.a = true; go(0, 0, 0.2); return out; }
      if (dist < 5) { go(me.x * 3, me.z * 3, 0.9); return out; }
      go(0, 0, aligned ? 0.2 : 0.35);
      return out;
    }
    // hunt jewels, or slide at a rival carrying jewels
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
      if (p.slot === slot || d.jewels[p.slot] < 2) continue;
      const dd = Math.hypot(p.x - me.x, p.z - me.z);
      if (dd < 3.2 && me.cd <= 0) { go(p.x, p.z); out.b = true; return out; }
    }
    if (best) go(best.x, best.z);
    else go(0, 0, 0.1);
    return out;
  },
};
