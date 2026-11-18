/**
 * CRASH DASH (game id 'dashRace') - after Crash Bash's Crash Dash.
 *
 * Race DR_LAPS (10) laps round a ring track, clockwise seen from above (the floor arrows point that way), on a fixed
 * camera. The start/finish line is on the +x axis; the grid sits just before it, so the lap counter (which shows laps
 * still to go) drops 10 -> 9 on the first crossing. Grab wumpa fruit (fuel for the speed boost) and weapon items (missile / force
 * field). The first kart over the line after the last lap wins the round at once, otherwise the leader when the
 * 1:30 clock runs out.
 *   Stick = point the kart (it accelerates while the stick is held), A = speed boost (burns fuel),
 *   B = fire the missile / raise the force field, in Splash Dash with nothing held: jump the push rods
 *
 * The four tracks are the real stages (assets/stages/dashRace.json, stage model units x DR_K = world units, origin = the
 * stage origin so the fixed camera of the original frames lines up):
 *   dot    DOT DASH    egg-shaped ring round a hexagonal hub (no hazards)
 *   toxic  TOXIC DASH  circular ring round a toxic pit; a slime monster rises from the hub and sweeps its arms
 *   splash SPLASH DASH circular ring round a hub; two rods sweep the ring (hop over them)
 *   dante  DANTE'S DASH sand disc round a volcano, lava outside; winged demons fly low over the track
 *
 * world.data:
 *   variant: string
 *   ang:     number[4]  unwrapped progress angle per slot (starts just below 0, the line is at ang = k * 2pi)
 *   lap:     number[4]  line crossings (laps left = DR_LAPS - lap);  finish: number[4]  finish time (s) or -1;  first: time of first finish or -1
 *   fuel:    number[4]  boost fuel 0..1;  turbo: boolean[4] boost burning right now
 *   item:    number[4]  held item: 0 none, 1 missile, 2 force field;  shield: number[4] force field seconds left
 *   stun:    number[4]  seconds spun out / stunned (no control)
 *   mon:     number     toxic monster height 0 (hidden) .. 1 (up)
 *   prevB, prevA, hitCd: (internal)
 *
 * Bodies:
 *   'player':  kart (r DR_KART_R), face = heading, y = hop height
 *   'item':    weapon item on the track; cd > 0 while respawning
 *   'fruit':   wumpa fruit; cd > 0 while respawning
 *   'missile': slot = owner, flies along the track and homes in on the nearest rival ahead, cd = age
 *   'rod':     [splash/toxic] sweeping arm from the hub, face = direction (x = cos, z = sin), dash = length, r = half width
 *   'bat':     winged demon [dante], orbits the track, r 0.7
 *
 * Events: turbo (s=slot started boosting), pickup (s=slot, v=1 item / 2 fruit), missile (s=slot fired), shield (s=slot),
 *   explode (missile blew, x/z), hit (s=victim spun out, o=attacker or -1), lap (s=slot, v=laps left/DR_LAPS),
 *   finish (s=slot), bump (collision), hop (s=slot jumped), monster (v=1 rises / 0 sinks)
 */
import { addBody, clamp, collideCircles, effMass, emit, lastContact, rand } from '../physics';
import { IDLE, type Body, type InputState, type MiniGame, type World } from '../types';
import { TAU, angDiff, pickVariant } from './common';

/** world units per stage model unit */
export const DR_K = 3.4;
export const DR_LAPS = 10;
export const DR_KART_R = 0.58;
const N = 24;

export interface Track {
  /** track centre in stage model units */
  cx: number;
  cz: number;
  /** drivable inner / outer radius per direction theta_k = k*2pi/N, model units (theta here runs counter-clockwise seen from above, i.e. x = cos, z = -sin) */
  rIn: number[];
  rOut: number[];
}
const smooth = (a: number[]) => a.map((v, i) => (a[(i + N - 1) % N] + 2 * v + a[(i + 1) % N]) / 4);
const flat = (v: number) => Array<number>(N).fill(v);
/** Measured from the stage meshes: hub curb (inner) and road edge (outer) around the hub centre. */
export const DR_TRACKS: Record<string, Track> = {
  dot: {
    cx: 0, cz: 0.95,
    rIn: smooth([1.05, 1.05, 1.12, 1.12, 1.33, 1.62, 1.62, 1.62, 1.33, 1.12, 1.12, 1.05, 1.05, 1.14, 1.38, 1.38, 1.58, 1.58, 1.59, 1.58, 1.58, 1.4, 1.4, 1.14]),
    rOut: smooth([2.6, 2.73, 2.91, 3.19, 3.33, 3.6, 3.6, 3.6, 3.33, 3.19, 2.91, 2.73, 2.6, 2.49, 2.57, 2.61, 2.62, 2.62, 2.6, 2.62, 2.62, 2.61, 2.57, 2.49].map((v) => v - 0.15)),
  },
  toxic: { cx: 0, cz: 0, rIn: flat(1.2), rOut: flat(2.62) },
  splash: { cx: 0, cz: 0, rIn: flat(1.12), rOut: flat(2.68) },
  dante: { cx: 0, cz: 0, rIn: flat(0.98), rOut: flat(2.9) },
};

export const DR_VARIANTS = [
  { id: 'dot', name: 'DOT DASH' },
  { id: 'toxic', name: 'TOXIC DASH' },
  { id: 'splash', name: 'SPLASH DASH' },
  { id: 'dante', name: "DANTE'S DASH" },
];

/** th is the clockwise direction angle used everywhere else (x = cos, z = +sin); the tables above are counter-clockwise */
const interp = (a: number[], th: number) => {
  const u = ((-th / TAU) % 1 + 1) % 1 * N, i = Math.floor(u), f = u - i;
  return a[i % N] * (1 - f) + a[(i + 1) % N] * f;
};
/** world-unit inner/outer radius of a track in direction th */
export function trackRadii(variant: string, th: number): [number, number] {
  const t = DR_TRACKS[variant] ?? DR_TRACKS.dot;
  return [interp(t.rIn, th) * DR_K, interp(t.rOut, th) * DR_K];
}
export const trackCentre = (variant: string): [number, number] => { const t = DR_TRACKS[variant] ?? DR_TRACKS.dot; return [t.cx * DR_K, t.cz * DR_K]; };
/** world position at direction th and lane fraction f (0 = inner edge, 1 = outer edge) */
export function lanePos(variant: string, th: number, f: number): [number, number] {
  const [cx, cz] = trackCentre(variant), [ri, ro] = trackRadii(variant, th);
  const r = ri + (ro - ri) * f;
  return [cx + Math.cos(th) * r, cz + Math.sin(th) * r];
}
/** direction angle of a world point around the track centre (clockwise on screen, +x = 0, the racing direction) */
export const dirOf = (variant: string, x: number, z: number) => { const [cx, cz] = trackCentre(variant); return Math.atan2(z - cz, x - cx); };
/** heading (Body.face) of the racing direction at direction th */
export const tangentFace = (th: number) => Math.atan2(-Math.sin(th), Math.cos(th));

const FRUIT_SPOTS = 9, ITEM_SPOTS = 5;
export const DR_FRUIT: { a: number; f: number }[] = Array.from({ length: FRUIT_SPOTS }, (_, i) => ({ a: 0.55 + (i * TAU) / FRUIT_SPOTS, f: i % 2 ? 0.72 : 0.3 }));
export const DR_ITEMS: { a: number; f: number }[] = Array.from({ length: ITEM_SPOTS }, (_, i) => ({ a: 1.15 + (i * TAU) / ITEM_SPOTS, f: [0.5, 0.25, 0.75, 0.4, 0.6][i] }));
const ROD_SPEED = 0.85, ROD_HALF = 0.28;
const BASE_SPEED = 5.4, TURN = 4.8, GRIP = 6;

interface Data {
  variant: string;
  ang: number[];
  prev: number[];
  finish: number[];
  lap: number[];
  first: number;
  fuel: number[];
  turbo: boolean[];
  item: number[];
  shield: number[];
  stun: number[];
  prevB: boolean[];
  prevA: boolean[];
  hitCd: number[];
  mon: number;
  monUp: boolean;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');
const wrap = (a: number) => angDiff(0, a);

function stunKart(w: World, d: Data, p: Body, secs: number, by: number) {
  if (d.shield[p.slot] > 0) { emit(w, 'bump', p.x, p.z, -1, 0.6); return; }
  d.stun[p.slot] = Math.max(d.stun[p.slot], secs);
  d.turbo[p.slot] = false;
  emit(w, 'hit', p.x, p.z, p.slot, 1, by);
}

/** distance from p to the rod segment starting at the hub centre; returns [dist, nx, nz] */
function rodDist(rod: Body, hubX: number, hubZ: number, px: number, pz: number): [number, number, number] {
  const ux = Math.cos(rod.face), uz = Math.sin(rod.face);
  const rx = px - hubX, rz = pz - hubZ;
  const t = clamp(rx * ux + rz * uz, 0, rod.dash);
  const dx = rx - ux * t, dz = rz - uz * t, dd = Math.hypot(dx, dz) || 1;
  return [dd, dx / dd, dz / dd];
}

export const dashRace: MiniGame = {
  id: 'dashRace',
  name: 'Crash Dash',
  description: `Race ${DR_LAPS} laps round the track. Fruit fuels the boost; pick up missiles and force fields. First across the line - or the leader at 1:30 - wins.`,
  controls: 'Steer to drive. Hold Space: boost (uses fuel). Shift: fire missile / force field (Splash Dash: jump the rods).',
  variants: DR_VARIANTS,
  maxTime: 90,

  setup(w, slots) {
    const variant = pickVariant(w, DR_VARIANTS);
    const d: Data = {
      variant, ang: [0, 0, 0, 0], prev: [0, 0, 0, 0], finish: [-1, -1, -1, -1], lap: [0, 0, 0, 0], first: -1,
      fuel: [0.3, 0.3, 0.3, 0.3], turbo: [false, false, false, false], item: [0, 0, 0, 0], shield: [0, 0, 0, 0], stun: [0, 0, 0, 0],
      prevB: [false, false, false, false], prevA: [false, false, false, false], hitCd: [0, 0, 0, 0], mon: 0, monUp: false,
    };
    w.data = d;
    // staggered grid just before the line (clockwise = increasing direction angle, the line is at 0)
    const grid: [number, number][] = [[-0.2, 0.3], [-0.34, 0.7], [-0.5, 0.3], [-0.64, 0.7]];
    const order = [1, 0, 3, 2];
    for (const s of slots) {
      const sc = w.params.playerScale;
      const [th, f] = grid[order[s.slot]];
      const [x, z] = lanePos(variant, th, f);
      const b = addBody(w, 'player', s.slot, x, z, DR_KART_R * sc, 3 * sc * sc);
      b.face = tangentFace(th);
      d.prev[s.slot] = th;
      d.ang[s.slot] = th;
    }
    for (const f of DR_FRUIT) { const [x, z] = lanePos(variant, f.a, f.f); addBody(w, 'fruit', -1, x, z, 0.55, 1); }
    for (const it of DR_ITEMS) { const [x, z] = lanePos(variant, it.a, it.f); addBody(w, 'item', -1, x, z, 0.6, 1); }
    const [cx, cz] = trackCentre(variant);
    if (variant === 'splash' || variant === 'toxic') {
      for (let i = 0; i < 2; i++) {
        const rd = addBody(w, 'rod', -1, cx, cz, ROD_HALF * (variant === 'toxic' ? 1.4 : 1), 1);
        rd.face = i * Math.PI + 0.4;
        rd.dash = trackRadii(variant, 0)[1] - 0.2;
      }
    }
    if (variant === 'dante') {
      for (let i = 0; i < 3; i++) {
        const b = addBody(w, 'bat', -1, 0, 0, 0.7, 1);
        b.face = 1.6 + (i * TAU) / 3; // direction angle
        b.dash = (i % 2 ? -1 : 1) * (0.7 + i * 0.15); // angular speed
        b.cd = [0.35, 0.7, 0.5][i]; // lane fraction
        b.y = 0.8;
      }
    }
  },

  step(w, inputs, dt) {
    const d = w.data as Data;
    const ps = players(w);
    const v = d.variant;
    const [hubX, hubZ] = trackCentre(v);

    // pickups' respawn timers; hazards
    for (const b of w.bodies) {
      if (b.kind === 'item' || b.kind === 'fruit') b.cd = Math.max(0, b.cd - dt);
      else if (b.kind === 'bat') {
        const th = b.face + b.dash * w.time;
        const [x, z] = lanePos(v, th, b.cd);
        b.vx = (x - b.x) / dt; b.vz = (z - b.z) / dt;
        b.x = x; b.z = z;
      }
    }
    // rods: splash sweeps always, toxic only while its monster is up
    const rods = w.bodies.filter((b) => b.kind === 'rod');
    if (v === 'toxic') {
      const ph = (w.time - 8) % 23;
      const up = w.time >= 8 && ph < 9;
      if (up !== d.monUp) { d.monUp = up; emit(w, 'monster', hubX, hubZ, -1, up ? 1 : 0); }
      d.mon = clamp(d.mon + (up ? 1 : -1) * dt, 0, 1);
    }
    rods.forEach((rd, i) => { rd.face = (i % 2 ? Math.PI : 0) + 0.4 + (v === 'toxic' ? 1.2 : ROD_SPEED) * w.time * (i % 2 ? 1 : 1); rd.alive = v === 'splash' || d.mon >= 1; });

    for (const p of ps) {
      const s = p.slot;
      const raw = inputs[s] ?? IDLE;
      const done = d.finish[s] >= 0;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.hitCd[s] = Math.max(0, d.hitCd[s] - dt);
      d.shield[s] = Math.max(0, d.shield[s] - dt);
      const stunned = d.stun[s] > 0;
      const inp = stunned ? IDLE : raw;
      const mag = Math.min(1, Math.hypot(inp.x, inp.y));
      // boost
      const wantTurbo = !stunned && raw.a && d.fuel[s] > 0.02 && mag > 0.2;
      if (wantTurbo && !d.turbo[s]) emit(w, 'turbo', p.x, p.z, s, 1);
      d.turbo[s] = wantTurbo;
      d.fuel[s] = clamp(d.fuel[s] - (wantTurbo ? 0.3 : 0) * dt, 0, 1);
      // steering: face the stick direction, accelerate while it is held
      if (mag > 0.2) {
        const want = Math.atan2(inp.x, inp.y);
        p.face += clamp(angDiff(p.face, want), -TURN * dt, TURN * dt);
      }
      const spd = BASE_SPEED * w.params.speed * (wantTurbo ? 1 + 0.5 * w.params.boost : 1) * (done ? 0.6 : 1) * (stunned ? 0.3 : 1);
      const tx = mag > 0.2 ? Math.sin(p.face) * spd * mag : 0, tz = mag > 0.2 ? Math.cos(p.face) * spd * mag : 0;
      const k = 1 - Math.exp(-GRIP * w.params.friction * (mag > 0.2 ? 1 : 0.6) * dt);
      p.vx += (tx - p.vx) * k; p.vz += (tz - p.vz) * k;
      if (stunned) p.face += 9 * dt; // spun out
      p.x += p.vx * dt; p.z += p.vz * dt;
      // hop
      p.vy -= 22 * w.params.gravity * dt;
      p.y = Math.max(0, p.y + p.vy * dt);
      if (p.y <= 0 && p.vy < 0) p.vy = 0;
      // walls: stay between the hub and the outer edge
      const th = dirOf(v, p.x, p.z);
      const [ri, ro] = trackRadii(v, th);
      const rx = p.x - hubX, rz = p.z - hubZ, r = Math.hypot(rx, rz) || 1;
      const nx = rx / r, nz = rz / r;
      const lo = ri + p.r, hi = ro - p.r;
      if (r < lo || r > hi) {
        const target = clamp(r, lo, hi);
        p.x = hubX + nx * target; p.z = hubZ + nz * target;
        const vr = p.vx * nx + p.vz * nz;
        if ((r < lo && vr < 0) || (r > hi && vr > 0)) {
          p.vx -= vr * nx * 1.4; p.vz -= vr * nz * 1.4;
          if (Math.abs(vr) > 3) emit(w, 'bump', p.x, p.z, -1, Math.min(1, Math.abs(vr) / 9));
        }
      }
      // fruit and items
      for (const o of w.bodies) {
        if ((o.kind !== 'item' && o.kind !== 'fruit') || o.cd > 0) continue;
        if (Math.hypot(o.x - p.x, o.z - p.z) > o.r + p.r) continue;
        if (o.kind === 'item') {
          if (d.item[s] !== 0 || done) continue;
          d.item[s] = rand(w) < 0.65 ? 1 : 2;
          o.cd = 7;
          emit(w, 'pickup', o.x, o.z, s, 1);
        } else {
          if (d.fuel[s] >= 0.99) continue;
          d.fuel[s] = Math.min(1, d.fuel[s] + 0.3);
          o.cd = 9;
          emit(w, 'pickup', o.x, o.z, s, 2);
        }
      }
      // B: use the item, else (splash) hop
      const rise = raw.b && !d.prevB[s];
      d.prevB[s] = raw.b;
      if (rise && !stunned) {
        if (d.item[s] === 1) {
          const m = addBody(w, 'missile', s, p.x, p.z, 0.4, 0.2);
          const a = dirOf(v, p.x, p.z);
          m.y = 0.5; m.face = a; // direction angle (the missile rides the track)
          emit(w, 'missile', p.x, p.z, s, 1);
          d.item[s] = 0;
        } else if (d.item[s] === 2) {
          d.shield[s] = 5; d.item[s] = 0;
          emit(w, 'shield', p.x, p.z, s, 1);
        } else if (v === 'splash' && p.y <= 0.001) {
          p.vy = 7.5; emit(w, 'hop', p.x, p.z, s, 1);
        }
      }
      // hazards
      for (const o of w.bodies) {
        if (o.kind === 'rod' && o.alive) {
          const [dd, ux, uz] = rodDist(o, hubX, hubZ, p.x, p.z);
          const rr = o.r + p.r;
          if (dd < rr && p.y < 0.45) {
            p.x += ux * (rr - dd); p.z += uz * (rr - dd);
            const vn = p.vx * ux + p.vz * uz;
            if (vn < 0) { p.vx -= 1.8 * vn * ux; p.vz -= 1.8 * vn * uz; }
            if (d.hitCd[s] <= 0) { d.hitCd[s] = v === 'toxic' ? 1.4 : 0.8; if (v === 'toxic') stunKart(w, d, p, 0.5, -1); else emit(w, 'bump', p.x, p.z, -1, 0.8); }
          }
        } else if (o.kind === 'bat' && d.hitCd[s] <= 0 && !stunned && Math.hypot(o.x - p.x, o.z - p.z) < o.r + p.r) {
          d.hitCd[s] = 1.8;
          const l = Math.hypot(p.x - o.x, p.z - o.z) || 1;
          p.vx += ((p.x - o.x) / l) * 4; p.vz += ((p.z - o.z) / l) * 4;
          stunKart(w, d, p, 0.9, -1);
        }
      }
      // progress (clockwise: direction angle increases; every crossing of the line at ang = k * 2pi counts a lap)
      const a = dirOf(v, p.x, p.z);
      d.ang[s] += wrap(a - d.prev[s]);
      d.prev[s] = a;
      const lap = d.ang[s] >= 0 ? Math.floor(d.ang[s] / TAU) + 1 : 0;
      if (lap > d.lap[s] && d.finish[s] < 0) { d.lap[s] = lap; emit(w, 'lap', p.x, p.z, s, Math.max(0, DR_LAPS - lap) / DR_LAPS); }
      if (lap >= DR_LAPS && d.finish[s] < 0) {
        d.finish[s] = w.time;
        if (d.first < 0) d.first = w.time;
        emit(w, 'finish', p.x, p.z, s, 1);
      }
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++)
        if (collideCircles(ps[i], ps[j], 0.8, effMass(ps[i]), effMass(ps[j])) && lastContact.impact > 2.5 && w.tick % 5 === 0)
          emit(w, 'bump', (ps[i].x + ps[j].x) / 2, (ps[i].z + ps[j].z) / 2, -1, Math.min(1, lastContact.impact / 9));

    // missiles ride the track and home in on the nearest rival ahead
    const dead = new Set<number>();
    for (const m of w.bodies.filter((b) => b.kind === 'missile')) {
      m.cd += dt;
      const a = m.face;
      const [ri, ro] = trackRadii(v, a);
      let r = Math.hypot(m.x - hubX, m.z - hubZ);
      let tgt: Body | null = null, tg = 1.6;
      for (const p of ps) {
        if (p.slot === m.slot || d.finish[p.slot] >= 0) continue;
        const gap = wrap(dirOf(v, p.x, p.z) - a);
        if (gap > -0.05 && gap < tg) { tg = gap; tgt = p; }
      }
      if (tgt) r += clamp(Math.hypot(tgt.x - hubX, tgt.z - hubZ) - r, -3 * dt, 3 * dt);
      r = clamp(r, ri + 0.3, ro - 0.3);
      const na = a + (14 / r) * dt;
      m.face = na;
      m.x = hubX + Math.cos(na) * r; m.z = hubZ + Math.sin(na) * r;
      m.vx = -Math.sin(na) * 14; m.vz = Math.cos(na) * 14;
      let boom = m.cd > 3;
      for (const p of ps) {
        if (p.slot === m.slot || Math.hypot(p.x - m.x, p.z - m.z) > p.r + m.r + 0.2) continue;
        stunKart(w, d, p, 1.2, m.slot);
        boom = true;
        break;
      }
      if (boom) { dead.add(m.id); emit(w, 'explode', m.x, m.z, -1, 1, m.slot); }
    }
    if (dead.size) w.bodies = w.bodies.filter((b) => !dead.has(b.id));
  },

  isOver(w) {
    const d = w.data as Data;
    return d.finish.every((f) => f >= 0) || (d.first >= 0 && w.time - d.first > 1.5);
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
    const v = d.variant;
    if (d.stun[slot] > 0) return IDLE;
    const th = dirOf(v, me.x, me.z);
    const [ri, ro] = trackRadii(v, th);
    const [hubX, hubZ] = trackCentre(v);
    const r = Math.hypot(me.x - hubX, me.z - hubZ);
    let f = 0.35 + (slot % 3) * 0.15; // lane fraction to hold
    let ahead = 0.34;
    let bestGap = 1.0;
    const consider = (sa: number, sf: number) => {
      const gap = wrap(sa - th);
      if (gap > 0.04 && gap < bestGap) { bestGap = gap; f = sf; ahead = Math.min(0.34, gap + 0.05); }
    };
    for (const o of w.bodies) {
      if (o.cd > 0) continue;
      if (o.kind === 'item' && d.item[slot] === 0) { const a = dirOf(v, o.x, o.z); const [a0, a1] = trackRadii(v, a); consider(a, (Math.hypot(o.x - hubX, o.z - hubZ) - a0) / (a1 - a0)); }
      else if (o.kind === 'fruit' && d.fuel[slot] < 0.85) { const a = dirOf(v, o.x, o.z); const [a0, a1] = trackRadii(v, a); consider(a, (Math.hypot(o.x - hubX, o.z - hubZ) - a0) / (a1 - a0)); }
    }
    // bats: steer to the other side of the lane
    for (const o of w.bodies) {
      if (o.kind !== 'bat') continue;
      const gap = wrap(dirOf(v, o.x, o.z) - th);
      if (gap < -0.05 || gap > 0.7) continue;
      const bf = (Math.hypot(o.x - hubX, o.z - hubZ) - ri) / (ro - ri);
      f = bf > 0.5 ? Math.max(0.12, bf - 0.45) : Math.min(0.88, bf + 0.45);
    }
    const ta = th + ahead;
    const [tx, tz] = lanePos(v, ta, clamp(f, 0.1, 0.9));
    const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
    const out: InputState = { x: dx / l, y: dz / l, a: Math.abs(r - (ri + (ro - ri) * f)) < 0.9 && d.fuel[slot] > 0.4, b: false };
    // hop over a sweeping rod about to arrive (splash)
    if (v === 'splash' && me.y < 0.05) {
      for (const o of w.bodies) {
        if (o.kind !== 'rod') continue;
        // angular position of the rod relative to the kart, and where it will be in 0.3 s
        const rel = wrap(o.face - th);
        const rate = ROD_SPEED;
        const nowGap = rel, soon = wrap(rel + rate * 0.28);
        if (Math.abs(nowGap) < 0.5 && (nowGap * soon <= 0 || Math.abs(soon) < 0.25) && r < o.dash + 0.4) out.b = true;
      }
    }
    // weapons
    if (d.item[slot] > 0 && w.tick % 3 === 0) {
      if (d.item[slot] === 1) {
        for (const o of w.bodies) {
          if (o.kind !== 'player' || o.slot === slot) continue;
          const gap = wrap(dirOf(v, o.x, o.z) - th), dr = Math.abs(Math.hypot(o.x - hubX, o.z - hubZ) - r);
          if (gap > 0.05 && gap < 0.9 && dr < 2.4) out.b = true;
        }
      } else if (w.bodies.some((o) => o.kind === 'missile' && o.slot !== slot && wrap(th - o.face) > 0 && wrap(th - o.face) < 0.9)) out.b = true;
    }
    return out;
  },
};
