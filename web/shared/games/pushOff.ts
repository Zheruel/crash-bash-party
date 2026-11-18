/**
 * POLAR PUSH (game id 'pushOff') - after Crash Bash's Polar Push.
 *
 * Everyone rides a polar bear on a floating ice platform. Charge into rivals to knock them into the water;
 * last bear on the ice wins. Charging uses a meter (empty meter = no charge). A bear that goes over the
 * edge first hangs on: mash A (4 taps) to climb back onto the ice before it slips (1.5 s), otherwise it falls.
 *   Stick = move, A = jump / mash to climb back, B = charge (needs meter)
 *
 * Variants (world.data.variant): tilt (TILT PANIC: the platform tips towards the heaviest side, everyone slides) |
 *   polar (POLAR PANIC: a beam drops power-ups: lightning / weight) |
 *   melt (MELT PANIC: the platform melts and shrinks) |
 *   manic (MANIC PANIC: energy bolts strike the ice and fling bears, slight tilt, slow melt).
 *   Every variant also shrinks after 40 s so rounds always end.
 *
 * world.data:
 *   variant: string
 *   radius:  number     current platform radius (use this, it already includes melting)
 *   tilt:    [x, z]     platform tilt in -1..1 (direction the ice slopes down towards); [0,0] when not tilting
 *   meter:   number[4]  charge meter 0..1 (a charge costs PO_CHARGE_COST)
 *   hang:    number[4]  seconds left of hanging on the edge (0 = not hanging)
 *   zap:     number[4]  seconds of lightning left (free, stronger charges)
 *   weight:  number[4]  seconds of the weight curse left (slower; passes to the bear you ram)
 *   elim:    number[4]  tick of falling, -1 while on the ice
 *   by / byTick: number[4]  last bear that shoved this one, and when (internal)
 *   taps, grace, prevA, nextBeam, nextBolt: (internal)
 *
 * Bodies:
 *   'player' (bear): r~0.8, fall = true once lost to the water (y falls, alive=false below -15),
 *                    cd = charge cooldown, dash > 0 during a charge
 *   'beam':  power-up spot (r 1.1) [polar]; cd = seconds before it fades
 *   'bolt':  incoming energy strike marker (r 2.4) [manic]; cd = seconds until it strikes
 *
 * Events: jump, dash (charge), land, hit (a charge connected; s=victim, o=attacker), bump (bears collide),
 *   ko (s=bear lost, o=last shover or -1), hang (s=bear grabbed the edge), climb (s=bear climbed back),
 *   pickup (s=bear, v=1 lightning / 2 weight), weight (s=new holder, o=previous), bolt (warning at x/z),
 *   strike (bolt lands at x/z, v=radius)
 */
import { addBody, clamp, collideCircles, effMass, emit, lastContact, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';
import { pickVariant } from './common';

export const PO_RADIUS = 8;
export const PO_CHARGE_COST = 0.4;
const HANG_TIME = 1.5, CLIMB_TAPS = 4, BOLT_WARN = 1.0, POWER_TIME = 8;
/** Platform radius of the melting variant at time t (kept for older renderers; prefer world.data.radius). */
export const platformRadius = (time: number) => Math.max(3.2, PO_RADIUS - Math.max(0, time - 20) * 0.1);

export const PO_VARIANTS = [
  { id: 'tilt', name: 'TILT PANIC' },
  { id: 'polar', name: 'POLAR PANIC' },
  { id: 'melt', name: 'MELT PANIC' },
  { id: 'manic', name: 'MANIC PANIC' },
];

interface Data {
  variant: string;
  radius: number;
  tilt: [number, number];
  meter: number[];
  hang: number[];
  zap: number[];
  weight: number[];
  elim: number[];
  by: number[];
  byTick: number[];
  taps: number[];
  grace: number[];
  prevA: boolean[];
  nextBeam: number;
  nextBolt: number;
}

const radiusAt = (variant: string, t: number) => {
  let r = PO_RADIUS;
  if (variant === 'melt') r -= Math.max(0, t - 6) * 0.09;
  else if (variant === 'manic') r -= Math.max(0, t - 12) * 0.04;
  r -= Math.max(0, t - 40) * 0.15;
  return Math.max(3.2, r);
};

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const standing = (w: World) => players(w).filter((p) => !p.fall);

export const pushOff: MiniGame = {
  id: 'pushOff',
  name: 'Polar Push',
  description: 'Charge into the other bears to knock them off the ice. Last bear standing wins.',
  controls: 'Move. Shift: charge (needs meter). Space: jump; mash it to climb back from the edge.',
  variants: PO_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, PO_VARIANTS);
    const d: Data = {
      variant, radius: PO_RADIUS, tilt: [0, 0], meter: [0.6, 0.6, 0.6, 0.6], hang: [0, 0, 0, 0], zap: [0, 0, 0, 0], weight: [0, 0, 0, 0],
      elim: [], by: [], byTick: [], taps: [0, 0, 0, 0], grace: [0, 0, 0, 0], prevA: [false, false, false, false], nextBeam: 4, nextBolt: 4,
    };
    for (let i = 0; i < MAX_SEATS; i++) { d.elim.push(-1); d.by.push(-1); d.byTick.push(-99); }
    w.data = d;
    for (const s of slots) {
      const a = (s.slot * Math.PI) / 2 + Math.PI / 4;
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, Math.sin(a) * 4.5, Math.cos(a) * 4.5, 0.8 * sc, 3 * sc * sc);
      b.face = Math.atan2(-Math.sin(a), -Math.cos(a));
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const R = (d.radius = radiusAt(d.variant, w.time));
    const ps = players(w).filter((p) => p.alive);
    const st0 = ps.filter((p) => !p.fall && d.hang[p.slot] <= 0);

    // platform tilt: slopes towards the centre of weight
    if (d.variant === 'tilt' || d.variant === 'manic') {
      let cx = 0, cz = 0;
      for (const p of st0) { cx += p.x; cz += p.z; }
      const n = Math.max(1, st0.length);
      let tx = cx / (n * R), tz = cz / (n * R);
      const l = Math.hypot(tx, tz);
      if (l > 1) { tx /= l; tz /= l; }
      const k = d.variant === 'tilt' ? 1 : 0.45;
      const f = 1 - Math.exp(-3 * dt);
      d.tilt[0] += (tx * k - d.tilt[0]) * f;
      d.tilt[1] += (tz * k - d.tilt[1]) * f;
    }

    // power-up beam (polar)
    if (d.variant === 'polar') {
      const beam = w.bodies.find((b) => b.kind === 'beam');
      if (beam) {
        beam.cd -= dt;
        if (beam.cd <= 0) w.bodies = w.bodies.filter((b) => b !== beam);
      } else if (w.time >= d.nextBeam && st0.length > 1) {
        const a = rand(w) * Math.PI * 2, rr = Math.sqrt(rand(w)) * R * 0.6;
        const b = addBody(w, 'beam', -1, Math.sin(a) * rr, Math.cos(a) * rr, 1.1, 1);
        b.cd = 9;
        d.nextBeam = w.time + 6;
      }
    }
    // energy bolts (manic)
    if (d.variant === 'manic') {
      if (w.time >= d.nextBolt && st0.length > 1) {
        const a = rand(w) * Math.PI * 2, rr = Math.sqrt(rand(w)) * R * 0.85;
        const b = addBody(w, 'bolt', -1, Math.sin(a) * rr, Math.cos(a) * rr, 2.4, 1);
        b.cd = BOLT_WARN;
        d.nextBolt = w.time + 2.2 + rand(w) * 1.8;
        emit(w, 'bolt', b.x, b.z, -1, 0.5);
      }
      for (const bolt of w.bodies.filter((b) => b.kind === 'bolt')) {
        bolt.cd -= dt;
        if (bolt.cd > 0) continue;
        emit(w, 'strike', bolt.x, bolt.z, -1, bolt.r);
        for (const p of ps) {
          if (p.fall || d.hang[p.slot] > 0 || p.y > 1.2) continue;
          let dx = p.x - bolt.x, dz = p.z - bolt.z;
          const dd = Math.hypot(dx, dz);
          if (dd > bolt.r + p.r) continue;
          if (dd < 1e-6) { dx = 1; dz = 0; }
          const l = Math.hypot(dx, dz);
          p.vx = (dx / l) * 11; p.vz = (dz / l) * 11; p.vy = 4;
          d.by[p.slot] = -1; d.byTick[p.slot] = -99;
        }
        w.bodies = w.bodies.filter((b) => b !== bolt);
      }
    }

    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      const rising = inp.a && !d.prevA[s];
      d.prevA[s] = inp.a;
      d.grace[s] = Math.max(0, d.grace[s] - dt);
      d.zap[s] = Math.max(0, d.zap[s] - dt);
      if (d.weight[s] > 0) { d.weight[s] -= dt; if (d.weight[s] <= 0) d.weight[s] = 0; }

      if (!p.fall && d.hang[s] > 0) {
        // hanging on the edge: mash A to climb back
        const l = Math.hypot(p.x, p.z) || 1, ux = p.x / l, uz = p.z / l;
        d.hang[s] -= dt;
        if (rising) d.taps[s]++;
        // a charging bear that reaches a hanging one knocks it into the water
        const stomper = ps.find((q) => q !== p && !q.fall && q.dash > 0 && d.hang[q.slot] <= 0 && Math.hypot(q.x - p.x, q.z - p.z) < q.r + p.r + 0.8);
        if (stomper) {
          d.hang[s] = 0;
          p.fall = true;
          d.elim[s] = w.tick;
          p.vx = ux * 3; p.vz = uz * 3;
          emit(w, 'hit', p.x, p.z, s, 1, stomper.slot);
          emit(w, 'ko', p.x, p.z, s, 1, stomper.slot);
        } else if (d.taps[s] >= CLIMB_TAPS) {
          p.x = ux * (R - 1.2); p.z = uz * (R - 1.2);
          p.vx = -ux * 3; p.vz = -uz * 3; p.y = 0; p.vy = 0;
          d.hang[s] = 0; d.taps[s] = 0; d.grace[s] = 0.9;
          emit(w, 'climb', p.x, p.z, s, 1);
        } else if (d.hang[s] <= 0) {
          d.hang[s] = 0;
          p.fall = true;
          d.elim[s] = w.tick;
          const killer = w.tick - d.byTick[s] < 90 ? d.by[s] : -1;
          emit(w, 'ko', p.x, p.z, s, 1, killer);
        } else { p.x = ux * (R + 0.2); p.z = uz * (R + 0.2); p.vx = p.vz = 0; p.y = 0; p.vy = 0; }
        continue;
      }

      if (!p.fall) {
        d.meter[s] = Math.min(1, d.meter[s] + 0.22 * dt);
        if (d.variant === 'tilt' || d.variant === 'manic') { // slide down the slope
          if (p.y <= 0.05) { p.vx += d.tilt[0] * 9 * dt; p.vz += d.tilt[1] * 9 * dt; }
        }
      }
      const canCharge = d.meter[s] >= PO_CHARGE_COST || d.zap[s] > 0;
      const cdBefore = p.cd;
      const speed = 6.5 * (d.weight[s] > 0 ? 0.6 : 1);
      movePlayer(w, p, { ...inp, b: inp.b && canCharge }, dt, 5, speed);
      if (!p.fall && cdBefore <= 0 && p.cd > 0.5) { // a charge just started
        if (d.zap[s] > 0) { p.vx *= 1.5; p.vz *= 1.5; p.dash = 0.3; p.cd = 0.7; } else { d.meter[s] -= PO_CHARGE_COST; p.vx *= 0.85; p.vz *= 0.85; }
      }

      // power-up beam
      if (!p.fall) {
        const beam = w.bodies.find((b) => b.kind === 'beam');
        if (beam && Math.hypot(p.x - beam.x, p.z - beam.z) < beam.r + p.r * 0.6) {
          const lightning = rand(w) < 0.5;
          if (lightning) { d.zap[s] = POWER_TIME; d.meter[s] = 1; } else { d.weight[s] = POWER_TIME; }
          emit(w, 'pickup', beam.x, beam.z, s, lightning ? 1 : 2);
          w.bodies = w.bodies.filter((b) => b !== beam);
        }
      }

      // over the edge: grab on and mash, or fall
      if (!p.fall && p.y <= 0.05 && Math.hypot(p.x, p.z) > R + 0.15) {
        if (d.grace[s] > 0) {
          p.fall = true;
          d.elim[s] = w.tick;
          const killer = w.tick - d.byTick[s] < 90 ? d.by[s] : -1;
          emit(w, 'ko', p.x, p.z, s, 1, killer);
        } else {
          d.hang[s] = HANG_TIME; d.taps[s] = 0;
          p.vx = p.vz = 0;
          emit(w, 'hang', p.x, p.z, s, 1);
        }
      }
      if (p.fall && p.y < -15) { p.alive = false; p.vx = p.vz = p.vy = 0; }
    }

    const st = ps.filter((p) => !p.fall && d.hang[p.slot] <= 0);
    for (let i = 0; i < st.length; i++)
      for (let j = i + 1; j < st.length; j++)
        if (Math.abs(st[i].y - st[j].y) < 1.2 && collideCircles(st[i], st[j], 0.95, effMass(st[i]), effMass(st[j]))) {
          const imp = lastContact.impact;
          if (imp < 2) continue;
          const a = st[i], b = st[j];
          const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
          // the weight curse jumps to the bear that gets rammed
          for (const [x, y] of [[a, b], [b, a]] as const) {
            if (d.weight[x.slot] > 0 && d.weight[y.slot] <= 0) { d.weight[y.slot] = POWER_TIME; d.weight[x.slot] = 0; emit(w, 'weight', y.x, y.z, y.slot, 1, x.slot); }
          }
          // the charger is the attacker
          if ((a.dash > 0) !== (b.dash > 0)) {
            const atk = a.dash > 0 ? a : b, vic = atk === a ? b : a;
            d.by[vic.slot] = atk.slot; d.byTick[vic.slot] = w.tick;
            emit(w, 'hit', mx, mz, vic.slot, Math.min(1.5, imp / 10), atk.slot);
          } else if (w.tick % 5 === 0) emit(w, 'bump', mx, mz, -1, Math.min(1, imp / 10));
        }
  },

  isOver(w) {
    return standing(w).length <= 1;
  },

  placements(w) {
    const d = w.data as Data;
    const R = (b: { x: number; z: number }) => Math.hypot(b.x, b.z);
    const bySlot = new Map(players(w).map((p) => [p.slot, p]));
    return [0, 1, 2, 3].sort((a, b) => {
      const pa = bySlot.get(a)!, pb = bySlot.get(b)!;
      if (!pa || !pb) return a - b;
      if (pa.fall !== pb.fall) return pa.fall ? 1 : -1;
      if (!pa.fall) return R(pa) - R(pb) || a - b;
      return d.elim[b] - d.elim[a] || a - b;
    });
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
    if (!me || me.fall) return IDLE;
    const d = w.data as Data;
    if (d.hang[slot] > 0) return { x: -me.x * 0.1, y: -me.z * 0.1, a: w.tick % 3 === 0, b: false };
    const R = d.radius;
    const dist = Math.hypot(me.x, me.z);
    const foes = standing(w).filter((p) => p.slot !== slot);
    // target the bear closest to the edge (and not too far from me)
    let foe = null as (typeof foes)[number] | null, fd = Infinity, bestScore = -Infinity;
    for (const f of foes) {
      const dd = Math.hypot(f.x - me.x, f.z - me.z);
      const sc = Math.hypot(f.x, f.z) - dd * 0.35;
      if (sc > bestScore) { bestScore = sc; fd = dd; foe = f; }
    }
    const k = 0.85;
    const go = (tx: number, tz: number, mul = k): InputState => {
      const dx = tx - me.x, dz = tz - me.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: (dx / l) * mul, y: (dz / l) * mul, a: false, b: false };
    };
    // dodge incoming energy bolts
    for (const b of w.bodies) {
      if (b.kind !== 'bolt') continue;
      const dd = Math.hypot(b.x - me.x, b.z - me.z);
      if (dd < b.r + 1.2) { const o = go(2 * me.x - b.x, 2 * me.z - b.z, 1); return dist > R * 0.8 ? go(0, 0, 1) : o; }
    }
    // beam power-up when nobody is next to me
    const beam = w.bodies.find((b) => b.kind === 'beam');
    if (beam && fd > 3 && Math.hypot(beam.x, beam.z) < R * 0.75) return go(beam.x, beam.z, 1);
    if (foe && dist > R * 0.7 && fd < 2.6 && me.cd <= 0 && (d.meter[slot] >= PO_CHARGE_COST || d.zap[slot] > 0) && w.tick % 3 === 0) {
      const dx = foe.x - me.x, dz = foe.z - me.z, l = Math.hypot(dx, dz) || 1; // pinned near the edge: shove my way out
      return { x: dx / l, y: dz / l, a: false, b: true };
    }
    if (dist > R * 0.7 || !foe) {
      // lean against the tilt
      return go(0 - d.tilt[0] * R * 0.3, 0 - d.tilt[1] * R * 0.3);
    }
    // approach from the inside of the foe so a shove sends them outward
    const fr = Math.hypot(foe.x, foe.z) || 1;
    const out = go(foe.x - (foe.x / fr) * 1.2, foe.z - (foe.z / fr) * 1.2);
    const ready = d.meter[slot] >= PO_CHARGE_COST || d.zap[slot] > 0;
    const dx = foe.x - me.x, dz = foe.z - me.z, l = Math.hypot(dx, dz) || 1;
    const outward = (dx / l) * (foe.x / fr) + (dz / l) * (foe.z / fr); // does a shove send them towards the water?
    if (fd < (d.hang[foe.slot] > 0 ? 3.4 : 3) && dist < R * 0.75 && ready && me.cd <= 0 && outward > 0.4 && fr > R * 0.3 && w.tick % 3 === 0) {
      return { x: dx / l, y: dz / l, a: false, b: true };
    }
    out.x = clamp(out.x, -1, 1); out.y = clamp(out.y, -1, 1);
    return out;
  },
};
