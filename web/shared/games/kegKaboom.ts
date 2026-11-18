import { addBody, clamp, collideCircles, effMass, emit, movePlayer, rand } from '../physics';
import { IDLE, MAX_SEATS, type InputState, type MiniGame, type World } from '../types';

/**
 * KEG KABOOM (Crash Bash level 30, family 0x10d).
 * Disc text (0149): "LAY GUNPOWDER TRAILS TO IGNITE THE POWDER KEGS AND SCORE POINTS / WIN BY BEING THE PLAYER WITH
 * THE HIGHEST SCORE WHEN TIME RUNS OUT / PRESS AND HOLD TO RELEASE GUNPOWDER / PRESS EITHER BUTTON TO GENERATE
 * SHOCKWAVE / PRESS TO JUMP / NORMAL BARREL - 2, 4, 6, 8, 10 / SILVER BARREL - 10 POINTS / GOLD BARREL - 20 POINTS /
 * COLLECT SHOCKWAVE TO IGNITE POWDER KEGS AT A DISTANCE / (crystal challenge) WIN WITHOUT BEING HIT BY THE ROAMING BOMB".
 *
 * Real layout (stage 0609, checked against the disc): a round dirt yard (about 17 units across) inside a low stone wall, a
 * village with a windmill on the hills behind; 90 seconds; the four players start on the diagonals (P1 front-left, P2
 * back-left, P3 back-right, P4 front-right) and run at about 4 units/s. Kegs are about 1.4 units tall.
 *
 * Rules implemented
 *  - Powder kegs stand around the yard. Normal kegs are worth 2/4/6/8/10 (the further from the middle, the more),
 *    SILVER 10, GOLD 20. A destroyed keg is replaced a moment later.
 *  - Hold B to lay a gunpowder trail behind you (you carry a limited powder supply that refills when you stop).
 *    LET GO to light it at its START: the fire races along the trail. Every keg a burning trail touches blows up and
 *    scores for the player who laid the trail. A blast also ignites trails and kegs next to it (chains!).
 *  - Burning powder stuns whoever stands on it (jump over it!). Jumping while laying leaves a gap the fire cannot cross.
 *  - A picks up the SHOCKWAVE crate: next time you press A (instead of jumping) a ring ignites every keg in reach.
 *  - Highest score when time runs out wins.
 *
 * world.data (Data): score[4], stun[4], invul[4], powder[4] (nodes left), laying[4] (id of the trail being laid, 0 none),
 *   shock[4] (shockwave charges), prevA[4], kegs[], trails[], nextKeg, nextItem, nextId.
 *   Keg: {id,x,z,v,kind 0 normal/1 silver/2 gold, fuse (-1 idle, else s to blast), owner, age}.
 *   Trail: {id, slot, x[], z[], t[] (-1 unlit, >=0 burn time, -2 burnt out), done}.
 * Bodies: 'player', 'crate' (shockwave pickup).
 * Events: 'lay' (trail started), 'light' (trail lit, s owner), 'ignite' (keg lit; s owner), 'boom' (keg destroyed;
 *   s owner, v points, o kind), 'burn' (s victim: stepped in fire), 'blast' (knocked by an explosion), 'wave' (s,
 *   shockwave ring), 'crate' (s), 'kegSpawn'.
 */
/** Yard play radius (floor disc is about 8.4 across the short side; the wall stands on its rim). */
export const KK_R = 8.0;
export const KK_KEG_R = 0.7;
export const NODE_D = 0.6;
export const POWDER_MAX = 50;
const RUN = 4.4, RUN_LAY = 3.6;
const POWDER_REGEN = 9, BURN_LIFE = 0.5, KEG_FUSE = 0.5, KEG_REACH = KK_KEG_R + 1.0, WAVE_R = 5.0, KEG_TARGET = 6, BLAST_R = 2.3;
/** Diagonal starts (+z = toward the camera): P1 front-left, P2 back-left, P3 back-right, P4 front-right. */
export const KK_STARTS: [number, number][] = [[-1, 1], [-1, -1], [1, -1], [1, 1]];
export const KK_START_AXIS = 4.1;

export interface Keg { id: number; x: number; z: number; v: number; kind: number; fuse: number; owner: number; age: number }
export interface Trail { id: number; slot: number; x: number[]; z: number[]; t: number[]; done: boolean }
export interface KegKaboomData {
  score: number[]; stun: number[]; invul: number[]; powder: number[]; laying: number[]; shock: number[]; prevA: boolean[];
  kegs: Keg[]; trails: Trail[]; nextKeg: number; nextItem: number; nextId: number;
}

const players = (w: World) => w.bodies.filter((b) => b.kind === 'player');

function spawnKeg(w: World, d: KegKaboomData): void {
  const ps = players(w);
  for (let tries = 0; tries < 30; tries++) {
    const a = rand(w) * Math.PI * 2, rr = Math.sqrt(rand(w)) * (KK_R - 1.6);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (d.kegs.some((k) => Math.hypot(k.x - x, k.z - z) < 3.0)) continue;
    if (ps.some((p) => Math.hypot(p.x - x, p.z - z) < 3)) continue;
    const roll = rand(w);
    const kind = roll < 0.07 ? 2 : roll < 0.2 ? 1 : 0;
    const dist = Math.hypot(x, z);
    const v = kind === 2 ? 20 : kind === 1 ? 10 : 2 * (1 + Math.min(4, Math.floor(dist / 1.5)));
    d.kegs.push({ id: d.nextId++, x, z, v, kind, fuse: -1, owner: -1, age: 0 });
    emit(w, 'kegSpawn', x, z, -1, kind);
    return;
  }
}

function lightKeg(w: World, d: KegKaboomData, k: Keg, owner: number, fuse = KEG_FUSE): void {
  if (k.fuse >= 0) return;
  k.fuse = fuse; k.owner = owner;
  emit(w, 'ignite', k.x, k.z, owner, 1);
}

/** Set node i of trail tr alight and light kegs touching it. */
function lightNode(w: World, d: KegKaboomData, tr: Trail, i: number): void {
  if (tr.t[i] !== -1) return;
  tr.t[i] = 0;
  for (const k of d.kegs) if (k.fuse < 0 && Math.hypot(k.x - tr.x[i], k.z - tr.z[i]) < KEG_REACH) lightKeg(w, d, k, tr.slot);
}

export const kegKaboom: MiniGame = {
  id: 'kegKaboom',
  name: 'Keg Kaboom',
  description: 'Lay gunpowder trails to the powder kegs, light them and watch them blow. Gold and silver kegs are worth the most!',
  controls: 'Hold B: lay gunpowder (release to light it). A: jump (or shockwave).',
  maxTime: 90,

  setup(w, slots) {
    const d: KegKaboomData = {
      score: [0, 0, 0, 0], stun: [0, 0, 0, 0], invul: [0, 0, 0, 0], powder: [POWDER_MAX, POWDER_MAX, POWDER_MAX, POWDER_MAX],
      laying: [0, 0, 0, 0], shock: [0, 0, 0, 0], prevA: [false, false, false, false], kegs: [], trails: [], nextKeg: 0, nextItem: 14, nextId: 1,
    };
    w.data = d;
    for (const s of slots) {
      const [sx, sz] = KK_STARTS[s.slot];
      const sc = w.params.playerScale;
      const b = addBody(w, 'player', s.slot, sx * KK_START_AXIS, sz * KK_START_AXIS, 0.7 * sc, 3 * sc * sc);
      b.face = Math.atan2(-sx, -sz);
    }
    for (let i = 0; i < KEG_TARGET - 1; i++) spawnKeg(w, d);
    void MAX_SEATS;
  },

  step(w, inputs, dt) {
    const d = w.data as KegKaboomData;
    const ps = players(w);

    // keg supply
    for (const k of d.kegs) k.age += dt;
    d.nextKeg -= dt;
    if (d.nextKeg <= 0 && d.kegs.length < KEG_TARGET) { spawnKeg(w, d); d.nextKeg = 1.8 / w.params.spawnRate; }
    d.nextItem -= dt;
    if (d.nextItem <= 0) {
      if (!w.bodies.some((b) => b.kind === 'crate')) {
        const ca = rand(w) * Math.PI * 2, cr = Math.sqrt(rand(w)) * (KK_R - 2.4);
        const c = addBody(w, 'crate', -1, Math.cos(ca) * cr, Math.sin(ca) * cr, 0.9, 1);
        c.y = 9;
      }
      d.nextItem = 13 + rand(w) * 5;
    }

    // players: movement, powder laying, shockwave
    for (const p of ps) {
      const s = p.slot;
      const inp = inputs[s] ?? IDLE;
      d.stun[s] = Math.max(0, d.stun[s] - dt);
      d.invul[s] = Math.max(0, d.invul[s] - dt);
      const stunned = d.stun[s] > 0;
      const grounded = p.y <= 0.0001;
      const pressA = inp.a && !d.prevA[s] && !stunned;
      d.prevA[s] = inp.a;
      let a = inp.a;
      if (pressA && d.shock[s] > 0) {
        d.shock[s]--;
        a = false;
        emit(w, 'wave', p.x, p.z, s, WAVE_R);
        for (const k of d.kegs) {
          const dd = Math.hypot(k.x - p.x, k.z - p.z);
          if (dd < WAVE_R) lightKeg(w, d, k, s, KEG_FUSE + dd * 0.07);
        }
      } else if (d.shock[s] > 0 && inp.a) a = false;

      const wantLay = inp.b && !stunned && d.powder[s] >= 1;
      let tr = d.laying[s] ? d.trails.find((t) => t.id === d.laying[s]) : undefined;
      if (wantLay) {
        if (!tr && grounded) {
          tr = { id: d.nextId++, slot: s, x: [], z: [], t: [], done: false };
          d.trails.push(tr);
          d.laying[s] = tr.id;
          emit(w, 'lay', p.x, p.z, s, 1);
        }
        if (tr && grounded) {
          const n = tr.x.length;
          if (n === 0 || Math.hypot(tr.x[n - 1] - p.x, tr.z[n - 1] - p.z) >= NODE_D) {
            tr.x.push(p.x); tr.z.push(p.z); tr.t.push(-1);
            d.powder[s] -= 1;
          }
        }
      } else if (tr) {
        // released (or ran dry / was stunned): light the start
        tr.done = true;
        d.laying[s] = 0;
        if (tr.x.length >= 3) { lightNode(w, d, tr, 0); emit(w, 'light', tr.x[0], tr.z[0], s, tr.x.length); }
        else d.trails = d.trails.filter((t) => t !== tr);
      }
      if (!d.laying[s]) d.powder[s] = Math.min(POWDER_MAX, d.powder[s] + POWDER_REGEN * dt);

      movePlayer(w, p, stunned ? IDLE : { x: inp.x, y: inp.y, a, b: false }, dt, 14, d.laying[s] ? RUN_LAY : RUN);
    }

    // fire: burn nodes, spread along and across trails
    const lit: { tr: Trail; i: number }[] = [];
    for (const tr of d.trails) {
      for (let i = 0; i < tr.t.length; i++) {
        if (tr.t[i] < 0) continue;
        tr.t[i] += dt;
        if (tr.t[i] >= BURN_LIFE) { tr.t[i] = -2; continue; }
        lit.push({ tr, i });
      }
    }
    for (const { tr, i } of lit) {
      if (tr.t[i] < 0.04) continue;
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= tr.t.length || tr.t[j] !== -1) continue;
        if (Math.hypot(tr.x[j] - tr.x[i], tr.z[j] - tr.z[i]) <= NODE_D * 1.6) lightNode(w, d, tr, j);
      }
    }
    for (const { tr, i } of lit) {
      if (tr.t[i] > 0.3) continue;
      for (const o of d.trails) {
        if (o === tr) continue;
        for (let j = 0; j < o.t.length; j++) if (o.t[j] === -1 && Math.hypot(o.x[j] - tr.x[i], o.z[j] - tr.z[i]) < 0.6) lightNode(w, d, o, j);
      }
      for (const p of ps) {
        if (p.y > 0.5 || d.invul[p.slot] > 0) continue;
        if (Math.hypot(p.x - tr.x[i], p.z - tr.z[i]) < 0.85) {
          d.stun[p.slot] = 1.1; d.invul[p.slot] = 2.2; p.vx *= 0.2; p.vz *= 0.2; p.vy = 4;
          emit(w, 'burn', p.x, p.z, p.slot, 1, tr.slot);
        }
      }
    }
    d.trails = d.trails.filter((tr) => !(tr.done && !tr.t.some((t) => t >= 0)));

    // kegs
    for (const k of d.kegs.slice()) {
      if (k.fuse < 0) continue;
      k.fuse -= dt;
      if (k.fuse > 0) continue;
      d.kegs = d.kegs.filter((o) => o !== k);
      if (k.owner >= 0) d.score[k.owner] += k.v;
      emit(w, 'boom', k.x, k.z, k.owner, k.v, k.kind);
      for (const o of d.kegs) {
        const dd = Math.hypot(o.x - k.x, o.z - k.z);
        if (o.fuse < 0 && dd < BLAST_R + 0.9) lightKeg(w, d, o, k.owner, 0.18 + dd * 0.05);
      }
      for (const tr of d.trails) for (let j = 0; j < tr.t.length; j++) if (tr.t[j] === -1 && Math.hypot(tr.x[j] - k.x, tr.z[j] - k.z) < BLAST_R) lightNode(w, d, tr, j);
      for (const p of ps) {
        const dx = p.x - k.x, dz = p.z - k.z, dd = Math.hypot(dx, dz) || 1;
        if (dd < BLAST_R - 0.3 && d.invul[p.slot] <= 0) {
          d.stun[p.slot] = 0.8; d.invul[p.slot] = 1.5;
          p.vx = (dx / dd) * 9; p.vz = (dz / dd) * 9; p.vy = 5;
          emit(w, 'blast', p.x, p.z, p.slot, 1, k.owner);
        }
      }
    }

    // player collisions
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) collideCircles(ps[i], ps[j], 0.5, effMass(ps[i]), effMass(ps[j]));
    for (const p of ps) {
      for (const k of d.kegs) {
        const dx = p.x - k.x, dz = p.z - k.z, dd = Math.hypot(dx, dz);
        const lo = KK_KEG_R + p.r;
        if (dd < lo && p.y < 1.4) { const q = dd || 1; p.x = k.x + (dx / q) * lo; p.z = k.z + (dz / q) * lo; }
      }
      const lim = KK_R - p.r * 0.5, d2 = Math.hypot(p.x, p.z);
      if (d2 > lim) { const k = lim / d2; p.x *= k; p.z *= k; const vn = (p.vx * p.x + p.vz * p.z) / lim; if (vn > 0) { p.vx -= (p.x / lim) * vn; p.vz -= (p.z / lim) * vn; } }
    }

    // shockwave crate
    for (const c of w.bodies) {
      if (c.kind !== 'crate') continue;
      if (c.y > 0) { c.vy -= 20 * dt; c.y = Math.max(0, c.y + c.vy * dt); if (c.y === 0) c.vy = 0; continue; }
      for (const p of ps) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + c.r) {
          c.alive = false; d.shock[p.slot] = 1;
          emit(w, 'crate', c.x, c.z, p.slot, 1);
          break;
        }
      }
    }
    w.bodies = w.bodies.filter((b) => b.alive);
    void clamp;
  },

  isOver(w) {
    return w.time >= kegKaboom.maxTime;
  },

  placements(w) {
    const d = w.data as KegKaboomData;
    return [0, 1, 2, 3].sort((a, b) => d.score[b] - d.score[a] || a - b);
  },

  bot(w, slot): InputState {
    const d = w.data as KegKaboomData;
    const me = players(w).find((p) => p.slot === slot);
    const out: InputState = { x: 0, y: 0, a: false, b: false };
    if (!me || d.stun[slot] > 0) return out;
    const go = (tx: number, tz: number, k = 1) => {
      const dx = tx - me.x, dz = tz - me.z, l = Math.hypot(dx, dz) || 1;
      out.x = (dx / l) * k; out.y = (dz / l) * k;
    };
    const away = (fx: number, fz: number) => {
      const dx = me.x - fx, dz = me.z - fz, l = Math.hypot(dx, dz) || 1;
      // bend towards the middle when pinned against a wall
      out.x = dx / l - me.x * 0.04; out.y = dz / l - me.z * 0.04;
    };

    // 1. run from fire: any burning node close, or a keg about to blow
    let fireD = 1e9, fx = 0, fz = 0;
    for (const tr of d.trails) for (let i = 0; i < tr.t.length; i++) {
      if (tr.t[i] < 0) continue;
      const dd = Math.hypot(tr.x[i] - me.x, tr.z[i] - me.z);
      if (dd < fireD) { fireD = dd; fx = tr.x[i]; fz = tr.z[i]; }
    }
    for (const k of d.kegs) if (k.fuse >= 0) { const dd = Math.hypot(k.x - me.x, k.z - me.z) - 0.5; if (dd < fireD && dd < BLAST_R) { fireD = dd; fx = k.x; fz = k.z; } }
    if (fireD < 2.4 && !d.laying[slot]) {
      away(fx, fz);
      if (fireD < 1.3 && me.y <= 0.001) out.a = true;
      return out;
    }
    // 2. fresh trail of mine that has just been lit and is still unburnt next to me: step away from its end
    for (const tr of d.trails) {
      if (tr.slot !== slot || !tr.done) continue;
      const n = tr.x.length;
      if (n && Math.hypot(tr.x[n - 1] - me.x, tr.z[n - 1] - me.z) < 3.4) { away(tr.x[n - 1], tr.z[n - 1]); return out; }
      return out; // wait for the fire to do its work
    }

    // shockwave: zap the juiciest keg in reach
    if (d.shock[slot] > 0) {
      let tv = 0;
      for (const k of d.kegs) if (k.fuse < 0 && Math.hypot(k.x - me.x, k.z - me.z) < WAVE_R - 0.6) tv += k.v;
      if (tv >= 6 && w.tick % 3 === 0) { out.a = true; return out; }
    }
    // pickup crate nearby
    for (const c of w.bodies) if (c.kind === 'crate' && c.y < 0.3 && Math.hypot(c.x - me.x, c.z - me.z) < 6 && !d.laying[slot]) { go(c.x, c.z); return out; }

    // 3. pick a target keg: value / distance, prefer ones other trails are not already about to take
    let best: typeof d.kegs[number] | null = null, bs = -1;
    for (const k of d.kegs) {
      if (k.fuse >= 0) continue;
      const dd = Math.hypot(k.x - me.x, k.z - me.z);
      const s = k.v / (dd + 3);
      if (s > bs) { bs = s; best = k; }
    }
    if (!best) { go(0, 0, 0.3); return out; }
    const dist = Math.hypot(best.x - me.x, best.z - me.z);
    if (d.laying[slot]) {
      if (dist < KK_KEG_R + 0.7 + 0.3 || d.powder[slot] < 1.5) { out.b = false; away(best.x, best.z); return out; }
      go(best.x, best.z);
      out.b = true;
      return out;
    }
    if (dist < 4.5 && d.powder[slot] >= 20) {
      // back off to a run-up spot (inside the yard) about 5.6 from the keg
      let bx = 0, bz = 0, bd = 1e9;
      for (let a = 0; a < 12; a++) {
        const px = best.x + Math.cos(a * Math.PI / 6) * 5.6, pz = best.z + Math.sin(a * Math.PI / 6) * 5.6;
        if (Math.hypot(px, pz) > KK_R - 1.0) continue;
        const dd = Math.hypot(px - me.x, pz - me.z);
        if (dd < bd) { bd = dd; bx = px; bz = pz; }
      }
      if (bd < 1e8) go(bx, bz); else go(0, 0);
      return out;
    }
    if (d.powder[slot] < 20) { if (dist > 4.5) go(best.x, best.z, 0.5); return out; }
    if (dist > 9) { go(best.x, best.z); return out; }
    // begin a trail some way from the keg and run straight at it
    go(best.x, best.z);
    out.b = true;
    return out;
  },
};
