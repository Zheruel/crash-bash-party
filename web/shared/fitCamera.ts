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
export function rotFx(c: PS1Cam): number[] {
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
  destination?: [number, number, number];
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
    this.destination = [nx, ny, nz];
    if (snap) { c.x = nx; c.y = ny; c.z = nz; return true; }
    this.approach(this.destination);
    return true;
  }

  approach([nx, ny, nz]: [number, number, number]) {
    const c = this.c;
    const k = nz < c.z ? 4 : 2;
    c.z += (nz - c.z) >> k;
    c.x += (nx - c.x) >> k;
    c.y += (ny - c.y) >> k;
  }
}
