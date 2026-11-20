import type { Body, GameEvent, InputState, World } from './types';

export const GRAVITY = 20;
export const JUMP_SPEED = 7;

/** Deterministic PRNG (mulberry32) whose state lives in the world. */
export function rand(w: World): number {
  let t = (w.rng = (w.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The two starting words in the USA executable. Online rooms mix their round seed into the first. */
export function discRandomState(seed: number): [number, number] {
  return [(0x00c587c1 ^ seed) >>> 0, 0x0573cec9];
}

/** FUN_80015590. Original snapshots without this pair keep their previous deterministic stream. */
export function discRandomInt(w: World, limit: number): number {
  const state: [number, number] | undefined = w.data.random;
  if (!state) return Math.floor(rand(w) * limit);
  return drawDiscRandom(state, limit);
}

export function drawDiscRandom(state: [number, number], limit: number): number {
  if (limit < 2) return 0;
  const sum = (state[0] + state[1]) >>> 0;
  state[0] = sum;
  state[1] = (state[1] + sum + (sum >>> 31)) >>> 0;
  return sum % limit;
}

/** Record a one-shot event for clients (sound / particles / shake). */
export function emit(w: World, k: string, x: number, z: number, s = -1, v = 1, o = -1, yaw?: number, y?: number): void {
  const event: GameEvent = { id: w.evId++, t: w.tick, k, x, z, s, o, v };
  if (yaw !== undefined) event.yaw = yaw;
  if (y !== undefined) event.y = y;
  w.ev.push(event);
}

export function addBody(w: World, kind: string, slot: number, x: number, z: number, r: number, m: number): Body {
  const b: Body = {
    id: w.nextId++, kind, slot, x, y: 0, z, vx: 0, vy: 0, vz: 0, r, m,
    face: 0, alive: true, fall: false, cd: 0, dash: 0,
  };
  w.bodies.push(b);
  return b;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Shared player locomotion: stick -> velocity with grip, jump (a), dash (b).
 * `grip` is how quickly velocity follows the stick (low = icy).
 */
export function movePlayer(w: World, b: Body, inp: InputState, dt: number, grip: number, baseSpeed: number): void {
  const p = w.params;
  const grounded = b.y <= 0.0001 && !b.fall;
  let ix = inp.x, iz = inp.y;
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  const mag = Math.min(len, 1);
  const sp = baseSpeed * p.speed;

  if (!b.fall) {
    const k = grip * p.friction * (grounded ? 1 : 0.25);
    const t = 1 - Math.exp(-k * dt);
    b.vx += (ix * sp - b.vx) * t;
    b.vz += (iz * sp - b.vz) * t;
    if (mag > 0.15) b.face = Math.atan2(ix, iz);
    if (inp.a && grounded) { b.vy = JUMP_SPEED; emit(w, 'jump', b.x, b.z, b.slot); }
    if (inp.b && b.cd <= 0 && grounded) {
      const dx = mag > 0.15 ? ix / mag : Math.sin(b.face);
      const dz = mag > 0.15 ? iz / mag : Math.cos(b.face);
      b.vx = dx * sp * 2.4;
      b.vz = dz * sp * 2.4;
      b.dash = 0.22;
      b.cd = 1.1;
      emit(w, 'dash', b.x, b.z, b.slot, 1, -1);
    }
  }
  b.cd = Math.max(0, b.cd - dt);
  b.dash = Math.max(0, b.dash - dt);

  b.vy -= GRAVITY * p.gravity * dt;
  b.y += b.vy * dt;
  if (!b.fall && b.y <= 0) {
    if (b.vy < -6) emit(w, 'land', b.x, b.z, b.slot, Math.min(1, -b.vy / 14));
    b.y = 0;
    if (b.vy < 0) b.vy = 0;
  }
  b.x += b.vx * dt;
  b.z += b.vz * dt;
}

/** Closing speed of the most recent collideCircles() contact (for impact effects). */
export const lastContact = { impact: 0 };

/** Circle-vs-circle collision with positional correction + impulse. Returns true on contact. */
export function collideCircles(a: Body, b: Body, e: number, ma = a.m, mb = b.m): boolean {
  let dx = b.x - a.x, dz = b.z - a.z;
  const rs = a.r + b.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rs * rs) return false;
  let d = Math.sqrt(d2);
  if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
  const nx = dx / d, nz = dz / d;
  const pen = rs - d;
  const tm = ma + mb;
  a.x -= nx * pen * (mb / tm); a.z -= nz * pen * (mb / tm);
  b.x += nx * pen * (ma / tm); b.z += nz * pen * (ma / tm);
  const vn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  lastContact.impact = vn < 0 ? -vn : 0;
  if (vn < 0) {
    const j = (-(1 + e) * vn) / (1 / ma + 1 / mb);
    a.vx -= (j * nx) / ma; a.vz -= (j * nz) / ma;
    b.vx += (j * nx) / mb; b.vz += (j * nz) / mb;
  }
  return true;
}

/** Effective mass: dashing players hit like a truck. */
export const effMass = (b: Body) => (b.dash > 0 ? b.m * 3 : b.m);
