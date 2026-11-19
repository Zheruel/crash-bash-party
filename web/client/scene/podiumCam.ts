// The PODIUM level's camera (engine camera mode 4, overlay FUN_800b96f4 + exe FUN_80013f44), one step per 30 Hz tick.
// Path 1 sweeps round the podium, a hold, then path 2 pulls back and up to the final framing. Integer maths as the
// game does it; checked against an emulator trace (re/notes/podium.md).

export interface CamPath { target: number[]; nodes: number[][]; end: number }
export interface CamData { paths: Record<string, CamPath>; speed: number; hold: number; H: number; div: number[] }
/** Engine camera block 0x80051640: translation z, look-at target, projection distance, angles (4096 = turn). */
export interface CamOut { z: number; tx: number; ty: number; tz: number; H: number; pitch: number; yaw: number }

const trunc = Math.trunc;
/** FUN_800154a0: b - a wrapped to +-0x800 */
const adiff = (a: number, b: number) => (((b - a + 0x800) % 0x1000) + 0x1000) % 0x1000 - 0x800;
/** FUN_8001463c(x, z): angle from +z toward +x, 0..0xfff */
const at2 = (x: number, z: number) => Math.round((Math.atan2(x, z) * 4096) / (2 * Math.PI)) & 0xfff;

/** FUN_8001e21c: point at distance t along the polyline (linear between nodes, integer division). */
function along(p: CamPath, t: number): number[] {
  const n = p.nodes;
  let i = 0;
  while (i + 1 < n.length && n[i + 1][3] <= t) i++;
  if (i + 1 >= n.length) return n[n.length - 1];
  const a = n[i], b = n[i + 1], d = t - a[3], len = b[3] - a[3];
  return [0, 1, 2].map((k) => a[k] + trunc(((b[k] - a[k]) * d) / len));
}

export class PodiumCam {
  /** 0 sweep, 1 hold, 2 pull back, 3 final framing */
  phase = 0;
  private timer = 0;
  private t = 0;
  private tg = [0, 0, 0];
  /** what the level before leaves in the block: the loader's camera */
  out: CamOut = { z: 0, tx: 0, ty: 0, tz: 0, H: 320, pitch: 0, yaw: 0 };
  /** true once the game would start path 2 by itself (the hold has run out) */
  held = false;

  constructor(private d: CamData) {
    const p = d.paths['1'];
    this.t = p.nodes[0][3];
    this.tg = [...p.target];
    this.step(); // the level start runs the camera once before the first frame
  }

  /** Start path 2 (the game does it when the hold ends; the party does it when the winner is announced). */
  pullBack() {
    if (this.phase >= 2) return;
    this.phase = 2;
    this.t = this.d.paths['2'].nodes[0][3];
  }

  step(auto = false) {
    const d = this.d, o = this.out;
    const p = d.paths[this.phase < 2 ? '1' : '2'];
    const pos = along(p, this.t);
    for (let k = 0; k < 3; k++) this.tg[k] += (p.target[k] - this.tg[k]) >> 4;
    const dx = this.tg[0] - pos[0], dy = this.tg[1] - pos[1], dz = this.tg[2] - pos[2];
    const dist = Math.floor(Math.sqrt(dx * dx + dy * dy + dz * dz));
    const yaw = at2(-dx, dz), pitch = at2(dy, Math.floor(Math.sqrt(dx * dx + dz * dz)));
    if (this.phase === 0) {
      this.t += d.speed;
      if (this.t >= p.end) { this.t = p.end; this.phase = 1; this.timer = d.hold; }
    } else if (this.phase === 1) {
      if (--this.timer < 1) { this.held = true; if (auto) this.pullBack(); }
    } else if (this.phase === 2) {
      this.t += d.speed;
      if (this.t >= p.end) { this.t = p.end; this.phase = 3; }
    }
    // FUN_80013f44: ease the live block toward the new values (divisors 0x800ad0f4)
    const v = d.div;
    o.H += (d.H - o.H + 4) >> 2;
    o.tx += trunc((this.tg[0] - o.tx + (v[0] >> 1)) / v[0]);
    o.ty += trunc((this.tg[1] - o.ty + (v[1] >> 1)) / v[1]);
    o.tz += trunc((this.tg[2] - o.tz + (v[2] >> 1)) / v[2]);
    o.z += trunc((dist - o.z) / v[8]);
    o.pitch += trunc(adiff(o.pitch & 0xfff, pitch) / v[3]);
    o.yaw += trunc(adiff(o.yaw & 0xfff, yaw) / v[4]);
  }
}
