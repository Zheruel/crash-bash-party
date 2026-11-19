// The real game's camera (engine globals 0x80051640.., read per level from emulator RAM), placed on our stages.
//
// Engine (FUN_80014540 / FUN_800143f0): camera space c = R(pitch,yaw,roll) * (p - target) + (x, y, z), PS1 axes
// (x right, y down, z forward). Framebuffer 512x240 shown at 4:3 => square-pixel focal = H / 2 on a 320x240 frame:
// vertical FOV = 2 atan(240 / H). Stage meshes are exported as world = (x, -y, -z) / 1024 * arena.scale (tools/t29.py),
// so the same mapping places the camera.
import * as THREE from 'three';
import type { ModelRef } from '../crash';

export interface PS1Cam {
  /** camera-space translation (engine 0x80051640/44/48) */
  x: number; y: number; z: number;
  /** world target (0x8005164c/50/54) */
  tx?: number; ty?: number; tz?: number;
  /** angles 4096/turn (0x80051694/96/98) */
  pitch: number; yaw?: number; roll?: number;
  /** projection plane distance (GTE H, 0x80051658) */
  H: number;
}

const A = (a: number) => (a * Math.PI * 2) / 4096;

/** PS1 rotation matrix rows (RotMatrix: R = Rx * Ry * Rz). */
function rot(c: PS1Cam): THREE.Matrix3 {
  const rx = new THREE.Matrix3().set(1, 0, 0, 0, Math.cos(A(c.pitch)), -Math.sin(A(c.pitch)), 0, Math.sin(A(c.pitch)), Math.cos(A(c.pitch)));
  const y = A(c.yaw ?? 0), z = A(c.roll ?? 0);
  const ry = new THREE.Matrix3().set(Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y));
  const rz = new THREE.Matrix3().set(Math.cos(z), -Math.sin(z), 0, Math.sin(z), Math.cos(z), 0, 0, 0, 1);
  return rx.multiply(ry).multiply(rz);
}

/** PS1 world point -> our world, using the stage's model transform. */
export function ps1ToWorld(ref: Pick<ModelRef, 'scale' | 'offset' | 'yaw'> | undefined, x: number, y: number, z: number, out = new THREE.Vector3()) {
  const s = (ref?.scale ?? 1) / 1024;
  out.set(x * s, -y * s, -z * s);
  if (ref?.yaw) out.applyAxisAngle(new THREE.Vector3(0, 1, 0), ref.yaw);
  if (ref?.offset) out.add(new THREE.Vector3(...ref.offset));
  return out;
}

export interface CamPose { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number }

/** Resolve a PS1 camera to a world-space pose (position, a look-at point, up vector, vertical FOV at 4:3). */
export function ps1Pose(c: PS1Cam, ref: Pick<ModelRef, 'scale' | 'offset' | 'yaw'> | undefined): CamPose {
  const m = rot(c).transpose(); // world <- camera
  const e = m.elements; // column-major: column k = world direction of camera axis k
  const col = (k: number) => new THREE.Vector3(e[k * 3], e[k * 3 + 1], e[k * 3 + 2]);
  const t = new THREE.Vector3(c.tx ?? 0, c.ty ?? 0, c.tz ?? 0);
  const p0 = t.clone().sub(new THREE.Vector3(c.x, c.y, c.z).applyMatrix3(m));
  const fwd = col(2), down = col(1);
  const pos = ps1ToWorld(ref, p0.x, p0.y, p0.z);
  const f = p0.clone().addScaledVector(fwd, 1024);
  const d = p0.clone().addScaledVector(down, 1024);
  const look = ps1ToWorld(ref, f.x, f.y, f.z);
  const up = pos.clone().sub(ps1ToWorld(ref, d.x, d.y, d.z)).normalize();
  return { pos, look, up, fov: (2 * Math.atan(240 / c.H) * 180) / Math.PI };
}

/** GTE OFY = 0xaf (FUN_8002aee0), but the real picture starts 8 lines down (rows 0-7 of every emulator frame are black), so the
 * projection centre sits at line 183 of the 240 shown. Verified by edge correlation on Ballistix and Mallet Mash frames. */
export const PS1_OFY = 183;

/**
 * Put a three camera on a pose, reproducing the PS1 frame: focal H/2 on a 320x240 picture with the projection
 * centre at line PS1_OFY. Wider than 4:3 keeps the 240 lines (more of the stage at the sides); narrower than 4:3
 * keeps the 320 columns (taller picture, the original frame centred).
 */
export function applyPose(cam: THREE.PerspectiveCamera, p: CamPose, aspect = innerWidth / Math.max(1, innerHeight), ofy = PS1_OFY) {
  cam.position.copy(p.pos);
  cam.up.copy(p.up);
  cam.lookAt(p.look);
  const fl = 120 / Math.tan((p.fov * Math.PI) / 360); // focal in lines
  const V = aspect >= 4 / 3 ? 240 : 320 / aspect;
  const W = V * aspect;
  const row = (V - 240) / 2 + ofy;
  const F = 2 * Math.max(row, V - row);
  const fov = (2 * Math.atan(F / 2 / fl) * 180) / Math.PI;
  const offY = F / 2 - row;
  const v = cam.view;
  if (Math.abs(cam.fov - fov) > 1e-4 || Math.abs(cam.aspect - W / F) > 1e-6 || !v || !v.enabled || Math.abs(v.offsetY - offY) > 1e-4 || Math.abs(v.fullHeight - F) > 1e-4) {
    cam.fov = fov;
    cam.aspect = W / F;
    cam.setViewOffset(W, F, 0, offY, W, V); // calls updateProjectionMatrix
  }
}

/** Real cameras per level id (DAT_8005a648), read at play time from emulator RAM. Tracking cameras are noted. */
export const LEVEL_CAMS: Record<number, PS1Cam> = {
  // Tank Wars (fixed)
  5: { x: 0, y: 0, z: 3736, tx: 2352, ty: 144, tz: 448, pitch: 512, H: 512 },
  6: { x: 0, y: 0, z: 3736, tx: 2048, ty: 144, tz: 672, pitch: 512, H: 512 },
  7: { x: 0, y: 0, z: 3736, tx: 2048, ty: 0, tz: 544, pitch: 490, H: 512 },
  8: { x: 0, y: 0, z: 3736, tx: 2352, ty: 144, tz: 448, pitch: 512, H: 512 },
  // Pogo Painter (fixed, all four)
  10: { x: 0, y: 0, z: 3736, tz: -1616, pitch: 446, H: 512 },
  11: { x: 0, y: 0, z: 3736, tz: -1616, pitch: 446, H: 512 },
  12: { x: 0, y: 0, z: 3736, tz: -1616, pitch: 446, H: 512 },
  13: { x: 0, y: 0, z: 3736, tz: -1616, pitch: 446, H: 512 },
  // Ballistix (fixed)
  14: { x: 0, y: 0, z: 3327, ty: -263, tz: -1778, pitch: 498, yaw: -2, H: 512 },
  15: { x: 0, y: 0, z: 3327, ty: -263, tz: -1778, pitch: 498, yaw: -2, H: 512 },
  16: { x: 0, y: 0, z: 3327, ty: -263, tz: -1778, pitch: 498, yaw: -2, H: 512 },
  17: { x: 0, y: 0, z: 3405, ty: -542, tz: -2564, pitch: 569, yaw: -2, H: 512 },
  // Crash Dash (fixed)
  23: { x: -97, y: -1054, z: 6741, pitch: 354, H: 555 },
  24: { x: -180, y: -829, z: 6432, pitch: 371, H: 555 },
  25: { x: 128, y: -931, z: 7252, pitch: 371, H: 600 },
  26: { x: 30, y: -997, z: 6816, pitch: 382, H: 555 },
  // Dragon Drop / Ring Ding / Mallet Mash / Keg Kaboom (fixed; 27/28 from re/dumps, 29/30 from re/dumps)
  27: { x: 0, y: 0, z: 2595, tx: -5, ty: -414, tz: -2414, pitch: 295, yaw: 2, H: 512 },
  28: { x: 223, y: -1038, z: 6943, pitch: 368, H: 600 },
  29: { x: 0, y: 0, z: 3736, tx: 96, ty: 32, tz: -1632, pitch: 402, H: 512 },
  30: { x: 0, y: 0, z: 3736, ty: -272, tz: -1904, pitch: 424, H: 512 },
};

// ---------------------------------------------------------------- level objects
/** One static level object as the real level places it (tools/levels/place.py). */
export interface Placement { id: string; part: string; drawn: boolean; pos: [number, number, number]; scale: [number, number, number]; m: number[] }
export interface Placements { model: number; objects: Placement[] }

const placementCache = new Map<string, Promise<Placements | null>>();
/** assets/stages/placements/<name>.json (e.g. L28) */
export function loadPlacements(name: string): Promise<Placements | null> {
  let p = placementCache.get(name);
  if (!p) {
    p = fetch(`${(import.meta.env?.BASE_URL ?? '/')}assets/stages/placements/${name}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    placementCache.set(name, p);
  }
  return p;
}

/**
 * Build the level's static objects: each one is its sub-mesh (object space) under M * v + pos, in PS1 units, mapped
 * like the stage (ref.scale / 1024, (x,-y,-z)). `make(part)` returns the model instance root restricted to that part.
 */
export function buildPlacements(pl: Placements, ref: Pick<ModelRef, 'scale' | 'offset' | 'yaw'>, make: (part: string) => THREE.Object3D | null, skip: (o: Placement) => boolean = () => false): THREE.Group {
  const g = new THREE.Group();
  g.name = 'placements';
  const k = (ref.scale ?? 1) / 1024;
  const D = new THREE.Matrix4().makeScale(1, -1, -1);
  for (const o of pl.objects) {
    if (skip(o)) continue;
    const obj = make(o.part);
    if (!obj) continue;
    const m = o.m;
    const M = new THREE.Matrix4().set(m[0] * o.scale[0], m[1] * o.scale[1], m[2] * o.scale[2], 0, m[3] * o.scale[0], m[4] * o.scale[1], m[5] * o.scale[2], 0, m[6] * o.scale[0], m[7] * o.scale[1], m[8] * o.scale[2], 0, 0, 0, 0, 1);
    const X = D.clone().multiply(M).multiply(D);
    X.setPosition(o.pos[0] * k, -o.pos[1] * k, -o.pos[2] * k);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(X);
    holder.name = o.id + ':' + o.part;
    holder.userData.ps1 = o.pos;
    holder.add(obj);
    g.add(holder);
  }
  if (ref.yaw) g.rotation.y = ref.yaw;
  if (ref.offset) g.position.set(...ref.offset);
  return g;
}

/** Make meshes under `root` draw first and never occlude (PS1 ordering-table backdrops: sky walls, far hills). */
export function asBackdrop(root: THREE.Object3D, order = -10) {
  root.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.renderOrder = order;
    const own = (mat: THREE.Material) => {
      const c = mat.clone();
      (c as THREE.MeshBasicMaterial).defines = { ...(mat as THREE.MeshBasicMaterial).defines };
      c.onBeforeCompile = mat.onBeforeCompile;
      c.customProgramCacheKey = () => 'ps1bg';
      c.depthWrite = false;
      c.depthTest = false;
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
  });
}

export interface LevelStageOpts {
  /** object parts the view draws itself (moving objects driven by the sim) */
  skip?: string[];
  /** parts drawn first without depth (sky walls etc.) */
  backdrop?: string[];
  /** native mesh-table entries to draw in level space (default none: those are usually props the views place) */
  native?: string[];
  /** only objects the game itself draws from this camera (flag 0x2000000): drops the camera-side walls it hides */
  drawnOnly?: boolean;
  /** parts kept even when not flagged drawn (sim-driven objects the camera culled at capture time) */
  keep?: string[];
  /** coplanar floor decals (pads, strips): drawn over the floor like the PS1's ordering table, no z-fighting */
  decals?: string[];
}

/** Pull a decal's depth toward the camera so it wins against the coplanar floor under it. */
export function asDecal(root: THREE.Object3D, k = 1) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const own = (q: THREE.Material) => { const c = q.clone(); c.defines = { ...(q as THREE.MeshBasicMaterial).defines }; c.onBeforeCompile = q.onBeforeCompile; c.customProgramCacheKey = q.customProgramCacheKey; c.polygonOffset = true; c.polygonOffsetFactor = -1 * k; c.polygonOffsetUnits = -4 * k; return c; };
    m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
  });
}

/**
 * The level as the real game builds it: the model's native mesh table (level space) + every placed static object
 * (RAM object list), mapped with the stage ref. Returns null when the placements are missing.
 */
export function levelStage(ref: ModelRef, pl: Placements | null, make: (r: ModelRef) => THREE.Object3D | null, opts: LevelStageOpts = {}): THREE.Group | null {
  if (!pl) return null;
  const g = new THREE.Group();
  g.name = 'level';
  if (opts.native?.length) {
    const nat = make({ model: ref.model, scale: ref.scale, offset: ref.offset, yaw: ref.yaw, parts: opts.native });
    if (nat) g.add(nat);
  }
  const objs = buildPlacements(pl, ref, (part) => make({ model: ref.model, scale: ref.scale, parts: [part] }), (o) => !!opts.skip?.includes(o.part) || (!!opts.drawnOnly && !o.drawn && !opts.keep?.includes(o.part)));
  g.add(objs);
  if (opts.backdrop?.length) for (const h of objs.children) if (opts.backdrop.some((b) => h.name.endsWith(':' + b))) asBackdrop(h);
  if (opts.decals?.length) for (const h of objs.children) if (opts.decals.some((b) => h.name.endsWith(':' + b))) asDecal(h);
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// The engine's "keep everyone in frame" camera (camera mode 1: FUN_80078dd4 -> FUN_80096a08 -> FUN_800967e0 ->
// FUN_80096f98). Every tracked object is a box around its entity position (PS1 units); the boxes are rotated into the
// camera frame around the target, the extreme left/right (slope 320/H) and top/bottom (slope 240/H) frustum lines through
// the box corners are intersected, and the camera translation eases towards target - apex.

/** A tracked box: entity position plus extents (x-, x+, z-, z+, height), as FUN_80078dd4 builds them. */
export interface TrackBox { x: number; y: number; z: number; xl: number; xr: number; zn: number; zf: number; h: number }

const tr = Math.trunc;

/**
 * FUN_80078dd4: box of a tracked object with radius r (+0x42), height h (+0x44) and reach f (+0x46) toward its facing
 * yaw (0x1000 = turn). The reach widens the box on the facing side; the z extents are halved (the view is tilted).
 */
export function trackBox(x: number, y: number, z: number, yaw: number, r: number, h: number, f = 0): TrackBox {
  // reach toward the facing (rcossin table, >>12); angle 0 faces -z in this frame
  const ux = (-isin(yaw) * f) >> 12, uz = (-icos(yaw) * f) >> 12;
  let xl = r, xr = r, zn = r, zf = r;
  if (ux < 0) { if (r < -ux) xl = -ux; } else if (r < ux) xr = ux;
  if (uz < 0) { if (r < -uz) zn = -uz; } else if (r < uz) zf = uz;
  return { x, y, z, xl, xr, zn: zn >> 1, zf: zf >> 1, h };
}

/** rcossin_tbl: round(4096 sin), 4096 steps per turn */
const isin = (a: number) => Math.round(4096 * Math.sin(((a & 0xfff) * Math.PI) / 2048));
const icos = (a: number) => Math.round(4096 * Math.cos(((a & 0xfff) * Math.PI) / 2048));
const sgnSin = (a: number) => (a < 0 ? -isin(-a) : isin(a));
const sgnCos = (a: number) => (a < 0 ? icos(-a) : icos(a));
const s16 = (v: number) => (v << 16) >> 16;

/** FUN_8003278c: the engine's fixed-point rotation matrix from (pitch, yaw, roll), row-major 4.12. */
function rotFx(c: PS1Cam): number[] {
  const a = c.pitch, b = c.yaw ?? 0, g = c.roll ?? 0;
  const s1 = sgnSin(a), c1 = sgnCos(a), c2 = sgnCos(b), s2 = sgnSin(b), s3 = sgnSin(g), c3 = sgnCos(g);
  const m = new Array<number>(9);
  m[2] = s2;
  m[5] = s16(-(c2 * s1) >> 12);
  m[8] = s16((c2 * c1) >> 12);
  m[0] = s16((c3 * c2) >> 12);
  m[1] = s16(-(s3 * c2) >> 12);
  const t = (c3 * -s2) >> 12;
  m[3] = s16(((s3 * c1) >> 12) - ((t * s1) >> 12));
  m[6] = s16(((s3 * s1) >> 12) + ((t * c1) >> 12));
  const u = (s3 * -s2) >> 12;
  m[4] = s16(((c3 * c1) >> 12) + ((u * s1) >> 12));
  m[7] = s16(((c3 * s1) >> 12) - ((u * c1) >> 12));
  return m;
}

/** FUN_800330cc (ApplyMatrixLV): 32-bit vector through the GTE in 15-bit halves. */
function applyLV(m: number[], v: [number, number, number]): [number, number, number] {
  const hi = v.map((q) => (q < 0 ? -((-q) >> 15) : q >> 15));
  const lo = v.map((q) => (q < 0 ? -((-q) & 0x7fff) : q & 0x7fff));
  const row = (i: number, w: number[]) => (m[i * 3] * w[0] + m[i * 3 + 1] * w[1] + m[i * 3 + 2] * w[2]) >> 12;
  return [0, 1, 2].map((i) => row(i, lo) + row(i, hi) * 8) as [number, number, number];
}

/** Segment intersection of FUN_80096280 / FUN_80096530 on two coordinates (a, b): p1->p2 against p3->p4. */
function segX(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): [number, number] | null {
  const [a1, b1] = p1, [a2, b2] = p2, [a3, b3] = p3, [a4, b4] = p4;
  if (b1 < b3 && b2 < b3 && b1 < b4 && b2 < b4) return null;
  if (!(b1 <= b3 || b2 <= b3 || b1 <= b4 || b2 <= b4)) return null;
  if (a1 < a3 && a2 < a3 && a1 < a4 && a2 < a4) return null;
  if (a3 < a1 && a2 > a3 && a1 > a4 && a2 > a4) return null;
  const i3 = (b3 - b4) >> 4, i8 = (a1 - a3) >> 4, i5 = (b1 - b3) >> 4, i2 = (a3 - a4) >> 4, i7 = (b2 - b1) >> 4, i6 = (a2 - a1) >> 4;
  const d = i7 * i2 - i6 * i3, n = i3 * i8 - i2 * i5;
  if (d < 1) { if (n < d || n > 0) return null; } else if (d < n || n < 0) return null;
  const m = i6 * i5 - i7 * i8;
  if (d < 1 ? !(d <= m && m < 1) : !(m <= d && m > -1)) return null;
  if (d === 0) return null;
  const t = tr((n * 256) / d);
  return [a1 + ((a2 - a1) * t >> 8), b1 + ((b2 - b1) * t >> 8)];
}

/** Camera mode 1 for one level: call update() each 30 Hz frame with the tracked boxes, read pose(). */
export class FitCam {
  readonly c: PS1Cam;
  private M: number[];
  constructor(base: PS1Cam) { this.c = { ...base }; this.M = rotFx(base); }

  /** FUN_80096f98 (snap = the first frame / a cut). Returns false when nothing is tracked. */
  update(boxes: TrackBox[], snap = false, clampX = true): boolean {
    if (!boxes.length) return false;
    const c = this.c, H = c.H, tx = c.tx ?? 0, ty = c.ty ?? 0, tz = c.tz ?? 0;
    let L = Infinity, Rr = -Infinity, T = Infinity, Bt = -Infinity;
    let A: [number, number] = [0, 0], B: [number, number] = [0, 0], C: [number, number] = [0, 0], D: [number, number] = [0, 0];
    for (const b of boxes) {
      const q = applyLV(this.M, [b.x - tx, b.y - ty, b.z - tz]);
      const X = q[0] + tx, Y = q[1] + ty, Z = q[2] + tz;
      for (const z of [Z - b.zn, Z + b.zf]) {
        const kx = tr(((z + 0x3000) * 0x140) / H), ky = tr(((z + 0x3000) * 0xf0) / H);
        const l = X - b.xl + kx; if (l < L) { L = l; A = [X - b.xl, z]; }
        const r = X + b.xr - kx; if (r > Rr) { Rr = r; B = [X + b.xr, z]; }
        const t = Y - b.h + ky; if (t < T) { T = t; C = [Y - b.h, z]; }
        const d = Y + b.h - ky; if (d > Bt) { Bt = d; D = [Y + b.h, z]; }
      }
    }
    // FUN_800967e0: apex of the vertical (y,z) and horizontal (x,z) frustum wedges
    const vy = tr(0x2d0000 / H), hx = tr(0x3c0000 / H);
    const v = segX(C, [C[0] + vy, C[1] - 0x3000], D, [D[0] - vy, D[1] - 0x3000]);
    let h = segX(A, [A[0] + hx, A[1] - 0x3000], B, [B[0] - hx, B[1] - 0x3000]);
    if (!h) h = A[1] < B[1] ? [A[0], A[1] - 0x600] : [B[0], B[1] - 0x600];
    const ax = h[0];
    const ay = v ? v[0] : ty - c.y;
    const az = v ? Math.min(v[1], h[1]) : h[1];
    let nx = tx - ax;
    const ny = ty - ay, nz = tz - az;
    if (clampX) nx = Math.max(-0x514, Math.min(0x514, nx));
    if (snap) { c.x = nx; c.y = ny; c.z = nz; return true; }
    const k = nz < c.z ? 4 : 2;
    c.z += (nz - c.z) >> k;
    c.x += (nx - c.x) >> k;
    c.y += (ny - c.y) >> k;
    return true;
  }
}

/** Our world point -> PS1 world units for the stage's model transform (inverse of ps1ToWorld). */
export function worldToPs1(ref: Pick<ModelRef, 'scale' | 'offset' | 'yaw'> | undefined, p: THREE.Vector3): [number, number, number] {
  const v = p.clone();
  if (ref?.offset) v.sub(new THREE.Vector3(...ref.offset));
  if (ref?.yaw) v.applyAxisAngle(new THREE.Vector3(0, 1, 0), -ref.yaw);
  const s = 1024 / (ref?.scale ?? 1);
  return [Math.round(v.x * s), Math.round(-v.y * s), Math.round(-v.z * s)];
}

/** Something the tracking camera keeps in frame: our world position and facing (rotation.y), box sizes in PS1 units. */
export interface Tracked { pos: THREE.Vector3; face?: number; r?: number; h?: number; f?: number }

/** Real tracking-camera bases (mode 1): angles + projection read in play; target is the origin, x/y/z start values. */
export const TRACK_CAMS: Record<number, PS1Cam> = {
  // Crate Crush
  0: { x: 1186, y: -712, z: 5349, pitch: 402, H: 512 },
  1: { x: 1185, y: -790, z: 5227, pitch: 403, H: 512 },
  2: { x: 294, y: -606, z: 4842, pitch: 428, H: 512 },
  3: { x: 1144, y: -871, z: 4969, pitch: 402, H: 512 },
  // Polar Push
  18: { x: 172, y: -573, z: 4580, pitch: 227, H: 512 },
  19: { x: 430, y: -605, z: 4679, pitch: 227, H: 512 },
  20: { x: 976, y: -671, z: 4436, pitch: 257, H: 512 },
  21: { x: 128, y: -525, z: 4766, pitch: 227, H: 512 },
  // Ring Ding
  28: { x: 345, y: -851, z: 6416, pitch: 368, H: 600 },
};

/**
 * Camera mode 1 driven from our scene: steps the engine's 30 Hz fit (bit-exact with the emulator traces of levels
 * 0-3, 18-21 and 28) and interpolates between steps for smooth display at any frame rate.
 */
export class Ps1Follow {
  private fit: FitCam;
  private prev: PS1Cam;
  private acc = 0;
  private started = false;
  constructor(base: PS1Cam, private ref: Pick<ModelRef, 'scale' | 'offset' | 'yaw'> | undefined) {
    this.fit = new FitCam(base);
    this.prev = { ...base };
  }

  /** Advance by dt seconds with the current tracked set; returns the pose to show. */
  step(dt: number, objs: Tracked[]): CamPose {
    const boxes = objs.map((o) => {
      const [x, y, z] = worldToPs1(this.ref, o.pos);
      const a = Math.round((-((o.face ?? 0) - (this.ref?.yaw ?? 0)) * 4096) / (Math.PI * 2)) & 0xfff;
      return trackBox(x, y, z, a, o.r ?? 512, o.h ?? 1280, o.f ?? 1024);
    });
    if (!this.started) {
      if (boxes.length) { this.fit.update(boxes, true); this.started = true; }
      this.prev = { ...this.fit.c };
      this.acc = 0;
    } else {
      this.acc = Math.min(this.acc + dt, 0.25);
      while (this.acc >= 1 / 30) {
        this.prev = { ...this.fit.c };
        this.fit.update(boxes);
        this.acc -= 1 / 30;
      }
    }
    const k = this.acc * 30, p = this.prev, c = this.fit.c;
    const cur: PS1Cam = { ...c, x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k, z: p.z + (c.z - p.z) * k };
    return ps1Pose(cur, this.ref);
  }

  /** Jump straight to the fit next step (new round / cut). */
  reset() { this.started = false; }
}
