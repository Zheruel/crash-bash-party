/**
 * CRASH DASH (game id 'dashRace') - after Crash Bash's Crash Dash.
 *
 * Race DR_LAPS laps round a circular track. Grab wumpa fruit (fuel for the turbo), weapon crates (missile or
 * mine) and drive over boost pads. First over the finish line wins; once someone finishes the rest get 9 s,
 * then placements come from race progress. Counter-clockwise (increasing angle atan2(z, x)); the start line is at
 * angle 0 (the +x axis).
 *   Stick = steer/drive, A = hold for turbo (burns fuel), B = fire missile / drop mine
 *
 * Variants (world.data.variant): dot (DOT DASH, clean track) | toxic (TOXIC DASH: sludge puddles slow you) |
 *   splash (SPLASH DASH: push rods pop out of the track walls) | dante (DANTE'S DASH: winged demons sweep the track)
 *
 * world.data:
 *   variant: string
 *   ang:     number[4]  unwrapped progress angle per slot (race is won at DR_LAPS * 2π)
 *   lap:     number[4]  completed laps;  finish: number[4]  finish time (s) or -1;  first: time of first finish or -1
 *   fuel:    number[4]  turbo fuel 0..1;  turbo: boolean[4] turbo burning right now
 *   boost:   number[4]  seconds of pad boost left
 *   item:    number[4]  held weapon: 0 none, 1 missile, 2 mine
 *   stun:    number[4]  seconds spun out / stunned (no control)
 *   prevB, hitCd, inSludge: (internal)
 *
 * Bodies:
 *   'player':  kart (r 0.6)
 *   'crate':   weapon crate on the track (DR_CRATES spots); cd > 0 while respawning
 *   'fruit':   wumpa fruit (DR_FRUIT spots); cd > 0 while respawning
 *   'missile': slot = owner, flies along the track and homes in on the nearest rival ahead, cd = age
 *   'mine':    slot = owner, cd > 0 while arming
 *   'sludge':  puddle [toxic] r 1.2
 *   'rod':     push rod [splash] r 1.25, dash = 1 while extended (solid), 0 while retracted
 *   'bat':     winged demon [dante], moves on a circle, r 0.7
 *
 * Events: boost (pad, s=slot), turbo (s=slot started turbo), pickup (s=slot, v=1 crate / 2 fruit), missile (s=slot
 *   fired), mine (s=slot laid), explode (missile/mine blew, x/z), hit (s=victim spun out, o=attacker or -1),
 *   lap (s=slot, v=lap/DR_LAPS), finish (s=slot), bump (collision), sludge (s=slot drove into a puddle)
 */
import { addBody, clamp, collideCircles, effMass, emit, lastContact, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type Body, type InputState, type MiniGame, type World } from '../types';
import { TAU, pickVariant } from './common';

export const DR_INNER = 6;
export const DR_OUTER = 10.5;
export const DR_MID = (DR_INNER + DR_OUTER) / 2;
export const DR_LAPS = 5;
export const DR_PADS: { a: number; r: number }[] = [
  { a: 0.9, r: 7.2 }, { a: 2.0, r: 9.2 }, { a: 3.1, r: 7.2 }, { a: 4.2, r: 9.2 }, { a: 5.3, r: 8.2 },
];
export const DR_PAD_R = 1.15;
/** Weapon crate spots (angle, radius) and wumpa fruit spots. */
export const DR_CRATES: { a: number; r: number }[] = [
  { a: 0.35, r: 7.6 }, { a: 1.45, r: 9.0 }, { a: 2.55, r: 7.6 }, { a: 3.65, r: 9.0 }, { a: 4.75, r: 7.6 }, { a: 5.85, r: 9.0 },
];
export const DR_FRUIT: { a: number; r: number }[] = [
  { a: 1.2, r: 8.3 }, { a: 2.3, r: 8.3 }, { a: 3.4, r: 8.3 }, { a: 4.5, r: 8.3 }, { a: 5.6, r: 8.3 }, { a: 6.1, r: 8.8 },
];
export const DR_SLUDGE: { a: number; r: number }[] = [
  { a: 0.6, r: 8.4 }, { a: 1.7, r: 7.0 }, { a: 2.7, r: 9.4 }, { a: 3.9, r: 7.2 }, { a: 4.9, r: 9.4 }, { a: 5.9, r: 7.2 },
];
export const DR_RODS: { a: number; r: number }[] = [
  { a: 0.5, r: 7.4 }, { a: 2.1, r: 9.1 }, { a: 3.7, r: 7.4 }, { a: 5.0, r: 9.1 },
];
const BOOST_TIME = 1.1;
const SLUDGE_R = 1.2, ROD_R = 1.25;

export const DR_VARIANTS = [
  { id: 'dot', name: 'DOT DASH' },
  { id: 'toxic', name: 'TOXIC DASH' },
  { id: 'splash', name: 'SPLASH DASH' },
  { id: 'dante', name: "DANTE'S DASH" },
];

interface Data {
  variant: string;
  ang: number[];
  prev: number[];
  finish: number[];
  boost: number[];
  lap: number[];
  first: number;
  fuel: number[];
  turbo: boolean[];
  item: number[];
  stun: number[];
  prevB: boolean[];
  prevA: boolean[];
  hitCd: number[];
  inSludge: boolean[];
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const wrap = (a: number) => { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
export const padPos = (i: number): [number, number] => [Math.cos(DR_PADS[i].a) * DR_PADS[i].r, Math.sin(DR_PADS[i].a) * DR_PADS[i].r];
const polar = (s: { a: number; r: number }): [number, number] => [Math.cos(s.a) * s.r, Math.sin(s.a) * s.r];

function stunShip(w: World, d: Data, p: Body, secs: number, by: number) {
  d.stun[p.slot] = Math.max(d.stun[p.slot], secs);
  d.turbo[p.slot] = false;
  emit(w, 'hit', p.x, p.z, p.slot, 1, by);
}

export const dashRace: MiniGame = {
  id: 'dashRace',
  name: 'Crash Dash',
  description: `Race ${DR_LAPS} laps round the track. Grab fruit for turbo fuel and weapon crates for missiles and mines. First across the line wins.`,
  controls: 'Move to drive. Hold Space: turbo (uses fuel). Shift: fire missile / drop mine.',
  variants: DR_VARIANTS,
  maxTime: 100,

  setup(w, slots) {
    const variant = pickVariant(w, DR_VARIANTS);
    const d: Data = {
      variant, ang: [0, 0, 0, 0], prev: [0, 0, 0, 0], finish: [-1, -1, -1, -1], boost: [0, 0, 0, 0], lap: [0, 0, 0, 0], first: -1,
      fuel: [0.5, 0.5, 0.5, 0.5], turbo: [false, false, false, false], item: [0, 0, 0, 0], stun: [0, 0, 0, 0],
      prevB: [false, false, false, false], prevA: [false, false, false, false], hitCd: [0, 0, 0, 0], inSludge: [false, false, false, false],
    };
    w.data = d;
    const radii = [6.9, 8.1, 9.3, 10.0 - 0.3];
    const order = [1, 2, 0, 3]; // spread starting lanes
    for (const s of slots) {
      const sc = w.params.playerScale;
      const r = radii[order[s.slot]];
      const a = -0.09 - (order[s.slot] % 2) * 0.1;
      const b = addBody(w, 'player', s.slot, Math.cos(a) * r, Math.sin(a) * r, 0.6 * sc, 3 * sc * sc);
      b.face = Math.atan2(-Math.sin(a), Math.cos(a)); // track tangent: x' = -sin a, z' = cos a
      d.prev[s.slot] = a;
      d.ang[s.slot] = a;
    }
    for (const c of DR_CRATES) { const [x, z] = polar(c); addBody(w, 'crate', -1, x, z, 0.7, 1); }
    for (const f of DR_FRUIT) { const [x, z] = polar(f); addBody(w, 'fruit', -1, x, z, 0.6, 1); }
    if (variant === 'toxic') for (const s of DR_SLUDGE) { const [x, z] = polar(s); addBody(w, 'sludge', -1, x, z, SLUDGE_R, 1); }
    if (variant === 'splash') for (const s of DR_RODS) { const [x, z] = polar(s); addBody(w, 'rod', -1, x, z, ROD_R, 1); }
    if (variant === 'dante') {
      const lanes = [7.0, 8.4, 9.6, 7.8, 9.0];
      lanes.forEach((r, i) => {
        const a0 = (i * TAU) / lanes.length + 0.3;
        const b = addBody(w, 'bat', -1, Math.cos(a0) * r, Math.sin(a0) * r, 0.7, 1);
        b.y = 0.8; b.face = a0; b.dash = (i % 2 ? -1 : 1) * (0.55 + (i % 3) * 0.12);
      });
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ps = players(w);

    // respawn timers of pickups; moving hazards
    for (const b of w.bodies) {
      if (b.kind === 'crate' || b.kind === 'fruit') b.cd = Math.max(0, b.cd - dt);
      else if (b.kind === 'bat') {
        const r = Math.hypot(b.x, b.z), th = b.face + b.dash * w.time;
        b.x = Math.cos(th) * r; b.z = Math.sin(th) * r;
        b.vx = -Math.sin(th) * r * b.dash; b.vz = Math.cos(th) * r * b.dash;
      } else if (b.kind === 'rod') {
        const i = w.bodies.filter((q) => q.kind === 'rod').indexOf(b);
        b.dash = (w.time + i * 0.8) % 3.2 < 1.8 ? 1 : 0;
      }
    }

    for (const p of ps) {
      const s = p.slot;
      const raw = inputs[s] ?? IDLE;
      const done = d.finish[s] >= 0;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.hitCd[s] = Math.max(0, d.hitCd[s] - dt);
      d.boost[s] = Math.max(0, d.boost[s] - dt);
      const stunned = d.stun[s] > 0;
      const inp = stunned ? IDLE : { ...raw, a: false, b: false };
      // turbo
      const wantTurbo = !stunned && raw.a && d.fuel[s] > 0.02 && Math.hypot(raw.x, raw.y) > 0.3;
      if (wantTurbo && !d.turbo[s]) emit(w, 'turbo', p.x, p.z, s, 1);
      d.turbo[s] = wantTurbo;
      d.fuel[s] = clamp(d.fuel[s] + (wantTurbo ? -0.4 : 0.03) * dt, 0, 1);
      const sludge = w.bodies.some((b) => b.kind === 'sludge' && Math.hypot(b.x - p.x, b.z - p.z) < SLUDGE_R + p.r * 0.5);
      if (sludge && !d.inSludge[s]) emit(w, 'sludge', p.x, p.z, s, 1);
      d.inSludge[s] = sludge;
      const base = 6.2 * (d.boost[s] > 0 ? 1 + 0.6 * w.params.boost : 1) * (wantTurbo ? 1 + 0.5 * w.params.boost : 1) * (sludge ? 0.5 : 1) * (done ? 0.6 : 1);
      movePlayer(w, p, inp, dt, 6, base);
      // ring walls
      const r = Math.hypot(p.x, p.z) || 1;
      const nx = p.x / r, nz = p.z / r;
      const lo = DR_INNER + p.r, hi = DR_OUTER - p.r;
      if (r < lo || r > hi) {
        const target = clamp(r, lo, hi);
        p.x = nx * target; p.z = nz * target;
        const vr = p.vx * nx + p.vz * nz;
        if ((r < lo && vr < 0) || (r > hi && vr > 0)) {
          p.vx -= vr * nx * 1.2; p.vz -= vr * nz * 1.2;
          if (Math.abs(vr) > 4) emit(w, 'bump', p.x, p.z, -1, Math.min(1, Math.abs(vr) / 10));
        }
      }
      // boost pads
      for (let i = 0; i < DR_PADS.length; i++) {
        const [px, pz] = padPos(i);
        if (Math.hypot(p.x - px, p.z - pz) < DR_PAD_R + p.r * 0.5 && d.boost[s] < BOOST_TIME * 0.6) {
          d.boost[s] = BOOST_TIME;
          // kick along the track direction
          const a = Math.atan2(p.z, p.x);
          const tx = -Math.sin(a), tz = Math.cos(a);
          p.vx += tx * 6 * w.params.boost; p.vz += tz * 6 * w.params.boost;
          emit(w, 'boost', p.x, p.z, s, 1);
        }
      }
      // weapon crates and fruit
      for (const o of w.bodies) {
        if ((o.kind !== 'crate' && o.kind !== 'fruit') || o.cd > 0) continue;
        if (Math.hypot(o.x - p.x, o.z - p.z) > o.r + p.r) continue;
        if (o.kind === 'crate') {
          if (d.item[s] !== 0 || done) continue;
          d.item[s] = rand(w) < 0.6 ? 1 : 2;
          o.cd = 6;
          emit(w, 'pickup', o.x, o.z, s, 1);
        } else {
          if (d.fuel[s] >= 0.99) continue;
          d.fuel[s] = Math.min(1, d.fuel[s] + 0.35);
          o.cd = 8;
          emit(w, 'pickup', o.x, o.z, s, 2);
        }
      }
      // fire / drop
      const rise = raw.b && !d.prevB[s];
      d.prevB[s] = raw.b;
      if (rise && !stunned && d.item[s] > 0) {
        if (d.item[s] === 1) {
          const m = addBody(w, 'missile', s, p.x, p.z, 0.4, 0.2);
          const a = Math.atan2(p.z, p.x);
          m.y = 0.5; m.vx = -Math.sin(a) * 15; m.vz = Math.cos(a) * 15; m.face = Math.atan2(m.vx, m.vz);
          emit(w, 'missile', p.x, p.z, s, 1);
        } else {
          const a = Math.atan2(p.z, p.x);
          const m = addBody(w, 'mine', s, p.x + Math.sin(a) * 0.1, p.z - Math.cos(a) * 0.1, 0.5, 1);
          m.cd = 0.8; m.dash = 30;
          emit(w, 'mine', m.x, m.z, s, 1);
        }
        d.item[s] = 0;
      }
      // hazards
      for (const o of w.bodies) {
        if (o.kind === 'rod' && o.dash > 0) {
          const dx = p.x - o.x, dz = p.z - o.z, dd = Math.hypot(dx, dz), rr = o.r + p.r;
          if (dd < rr) {
            const l = dd || 1, ux = dx / l, uz = dz / l;
            p.x = o.x + ux * rr; p.z = o.z + uz * rr;
            const vn = p.vx * ux + p.vz * uz;
            if (vn < 0) { p.vx -= 1.6 * vn * ux; p.vz -= 1.6 * vn * uz; }
            p.vx *= 0.8; p.vz *= 0.8;
            if (d.hitCd[s] <= 0) { d.hitCd[s] = 0.6; emit(w, 'bump', p.x, p.z, -1, 0.8); }
          }
        } else if (o.kind === 'bat' && d.hitCd[s] <= 0 && !stunned && Math.hypot(o.x - p.x, o.z - p.z) < o.r + p.r) {
          d.hitCd[s] = 1.8;
          const l = Math.hypot(p.x - o.x, p.z - o.z) || 1;
          p.vx += ((p.x - o.x) / l) * 5; p.vz += ((p.z - o.z) / l) * 5;
          stunShip(w, d, p, 0.9, -1);
        }
      }
      // progress
      const a = Math.atan2(p.z, p.x);
      d.ang[s] += wrap(a - d.prev[s]);
      d.prev[s] = a;
      const lap = Math.max(0, Math.floor(d.ang[s] / TAU));
      if (lap > d.lap[s] && d.finish[s] < 0) { d.lap[s] = lap; emit(w, 'lap', p.x, p.z, s, lap / DR_LAPS); }
      if (d.ang[s] >= DR_LAPS * TAU && d.finish[s] < 0) {
        d.finish[s] = w.time;
        if (d.first < 0) d.first = w.time;
        emit(w, 'finish', p.x, p.z, s, 1);
      }
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++)
        if (collideCircles(ps[i], ps[j], 0.8, effMass(ps[i]), effMass(ps[j])) && lastContact.impact > 2.5 && w.tick % 5 === 0)
          emit(w, 'bump', (ps[i].x + ps[j].x) / 2, (ps[i].z + ps[j].z) / 2, -1, Math.min(1, lastContact.impact / 9));

    // missiles and mines
    const dead = new Set<number>();
    for (const m of w.bodies.filter((b) => b.kind === 'missile')) {
      m.cd += dt;
      const a = Math.atan2(m.z, m.x);
      let r = Math.hypot(m.x, m.z);
      // home in on the closest rival ahead
      let tgt: Body | null = null, tg = 1.6;
      for (const p of ps) {
        if (p.slot === m.slot || d.finish[p.slot] >= 0) continue;
        const gap = wrap(Math.atan2(p.z, p.x) - a);
        if (gap > -0.05 && gap < tg) { tg = gap; tgt = p; }
      }
      if (tgt) r += clamp(Math.hypot(tgt.x, tgt.z) - r, -3 * dt, 3 * dt);
      r = clamp(r, DR_INNER + 0.4, DR_OUTER - 0.4);
      const na = a + (16 / r) * dt;
      m.x = Math.cos(na) * r; m.z = Math.sin(na) * r;
      m.vx = -Math.sin(na) * 16; m.vz = Math.cos(na) * 16; m.face = Math.atan2(m.vx, m.vz);
      let boom = m.cd > 3;
      for (const p of ps) {
        if (p.slot === m.slot || Math.hypot(p.x - m.x, p.z - m.z) > p.r + m.r + 0.2) continue;
        stunShip(w, d, p, 1.2, m.slot);
        boom = true;
        break;
      }
      if (boom) { dead.add(m.id); emit(w, 'explode', m.x, m.z, -1, 1, m.slot); }
    }
    for (const m of w.bodies.filter((b) => b.kind === 'mine')) {
      m.cd = Math.max(0, m.cd - dt);
      m.dash -= dt;
      if (m.dash <= 0) { dead.add(m.id); continue; }
      if (m.cd > 0) continue;
      for (const p of ps) {
        if (Math.hypot(p.x - m.x, p.z - m.z) > p.r + m.r) continue;
        stunShip(w, d, p, 1.2, m.slot === p.slot ? -1 : m.slot);
        dead.add(m.id);
        emit(w, 'explode', m.x, m.z, -1, 1, m.slot);
        break;
      }
    }
    if (dead.size) w.bodies = w.bodies.filter((b) => !dead.has(b.id));
  },

  isOver(w) {
    const d = w.data as Data;
    return d.finish.every((f) => f >= 0) || (d.first >= 0 && w.time - d.first > 9);
  },

  placements(w) {
    const d = w.data as Data;
    return [0, 1, 2, 3].sort((a, b) => {
      const fa = d.finish[a] >= 0, fb = d.finish[b] >= 0;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return d.finish[a] - d.finish[b] || a - b;
      return d.ang[b] - d.ang[a] || a - b;
    });
  },

  bot(w, slot): InputState {
    const me = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
    if (!me) return IDLE;
    const d = w.data as Data;
    if (d.stun[slot] > 0) return IDLE;
    const a = Math.atan2(me.z, me.x);
    const r = Math.hypot(me.x, me.z);
    // aim at an upcoming pickup / pad if one is close ahead, otherwise hold a lane
    let tr = DR_MID - 1.2 + (slot % 3) * 0.5;
    let ahead = 0.42;
    let bestGap = 1.3;
    const consider = (sa: number, sr: number) => {
      const gap = wrap(sa - a);
      if (gap > 0.05 && gap < bestGap) { bestGap = gap; tr = sr; ahead = Math.min(0.42, gap); }
    };
    for (const p of DR_PADS) consider(p.a, p.r);
    for (const o of w.bodies) {
      if (o.cd > 0) continue;
      if (o.kind === 'crate' && d.item[slot] === 0) consider(Math.atan2(o.z, o.x), Math.hypot(o.x, o.z));
      else if (o.kind === 'fruit' && d.fuel[slot] < 0.8) consider(Math.atan2(o.z, o.x), Math.hypot(o.x, o.z));
    }
    // dodge hazards in the way
    for (const o of w.bodies) {
      if (o.kind !== 'sludge' && o.kind !== 'rod' && o.kind !== 'bat') continue;
      const hr = Math.hypot(o.x, o.z), gap = wrap(Math.atan2(o.z, o.x) - a);
      const lead = o.kind === 'bat' ? 0.12 : 0;
      if (gap < -0.05 || gap > 0.65 + lead) continue;
      if (Math.abs(hr - tr) > o.r + 1.5) continue;
      tr = hr < DR_MID ? Math.min(hr + o.r + 1.3, DR_OUTER - 0.9) : Math.max(hr - o.r - 1.3, DR_INNER + 0.9);
      ahead = Math.min(ahead, Math.max(0.2, gap));
    }
    const ta = a + ahead;
    const tx = Math.cos(ta) * tr, tz = Math.sin(ta) * tr;
    const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
    const straight = Math.abs(r - tr) < 0.9;
    const out: InputState = { x: dx / l, y: dz / l, a: straight && d.fuel[slot] > 0.25 && !d.inSludge[slot], b: false };
    // weapons
    if (d.item[slot] > 0 && w.tick % 3 === 0) {
      for (const o of w.bodies) {
        if (o.kind !== 'player' || o.slot === slot) continue;
        const gap = wrap(Math.atan2(o.z, o.x) - a), dr = Math.abs(Math.hypot(o.x, o.z) - r);
        if (d.item[slot] === 1 && gap > 0.05 && gap < 0.9 && dr < 2.2) out.b = true;
        if (d.item[slot] === 2 && gap < -0.05 && gap > -0.5 && dr < 1.6) out.b = true;
      }
    }
    return out;
  },
};
