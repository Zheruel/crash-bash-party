// POLAR PUSH effect objects the overlay codes by hand (re/notes/polarPush.md "Effect objects"):
//   0x1606 skid tracks, 0x1612 smoke puffs, 0x1613 the 17-tick smoke flip-book, 0x1614 the bolt's shards, 0x1604 pillar
//   chunks and the dash meshes 0x1615 / 0x1616. State is kept in disc units and stepped at 30 Hz like the objects.
// Node flag bits 5-6 are the GPU blend mode (FUN_80017b08): 0x21 B + F, 0x41 B - F, 0x61 B + F/4; node +0x76 darkens the
// colours (0x1000 = black), which is how all of these fade.
import * as THREE from 'three';
import { S_DASH, S_IDLE, S_WALK, U } from '../../shared/games/pushOff';
import { fxPartTemplate, ownMaterial } from './realFx';

const S = 1024 * U;
const A = Math.PI / 2048;
const PACK = 403;
/** 0x8009e198: flip-book of object 0x1613, one word per tick (the second word holds one more tick). */
const SMOKE_FRAMES = [26, 26, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41];
type Abr = 0 | 1 | 2 | 3;

interface Node { obj: THREE.Group; mats: THREE.MeshBasicMaterial[]; abr: Abr }

function makeNode(parent: THREE.Object3D, model: number, part: number, abr: Abr, order = 6): Node | null {
  const template = fxPartTemplate(model, part, S);
  if (!template) return null;
  const obj = new THREE.Group(), mats: THREE.MeshBasicMaterial[] = [];
  const copy = template.clone();
  copy.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = order;
    if (!abr) return;
    const own = (source: THREE.Material) => {
      const m = ownMaterial(source);
      m.transparent = true;
      m.blending = THREE.CustomBlending;
      m.blendEquation = abr === 2 ? THREE.ReverseSubtractEquation : THREE.AddEquation;
      m.blendSrc = m.blendDst = THREE.OneFactor;
      m.blendEquationAlpha = THREE.AddEquation;
      m.blendSrcAlpha = THREE.ZeroFactor;
      m.blendDstAlpha = THREE.OneFactor;
      mats.push(m);
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
  });
  obj.add(copy);
  obj.visible = false;
  obj.userData.shared = true;
  parent.add(obj);
  return { obj, mats, abr };
}
function dropNode(n: Node | null) {
  if (!n) return;
  n.obj.removeFromParent();
  for (const m of n.mats) m.dispose();
}
/** Node +0x76: 0 = the mesh's own colours, 0x1000 = black. */
function shade(n: Node, dark: number) {
  const v = Math.max(0, Math.min(1, 1 - dark / 0x1000)) * (n.abr === 3 ? 0.25 : 1);
  for (const m of n.mats) m.color.setScalar(v);
}
const place = (o: THREE.Object3D, x: number, y: number, z: number) => o.position.set(x * U, -y * U, -z * U);

export interface PolarRider { st: number; af: number; x: number; y: number; z: number; yaw: number; sc: number; md: number; ch: number }
interface Track { n: Node; on: boolean; dark: number }
interface Puff {
  n: Node; wisp: Node | null; x: number; y: number; z: number; scale: number; dark: number; phase: number;
  fadeIn: number; fadeOut: number; shrink: number; rise: number; baseX: number; r: number; dr: number; angle: number; drift: boolean;
}
interface Smoke { frames: (Node | null)[]; t: number; x: number; y: number; z: number; scale: number; owner: number }
interface Burst { nodes: Node[]; v: number[][]; p: number[][]; t: number; x: number; y: number; z: number }
interface Chunk { n: Node; x: number; y: number; z: number; v: number[]; rot: number[]; spin: number[]; floor: number }
interface DashMesh { n: Node | null; key: string }

export interface PuffOptions {
  scale?: number; fadeIn?: number; fadeOut?: number; shrink?: number;
  /** Object flag 1: rises `rise` per tick and circles its spawn x on a shrinking radius, drawn as mesh 0x202e. */
  rise?: number;
}

export class PolarFx {
  private readonly world = new THREE.Group();
  private readonly ice = new THREE.Group();
  private tracks: Track[][] = [[], [], [], []];
  private trackCount = [0, 0, 0, 0];
  private riders: (PolarRider | null)[] = [null, null, null, null];
  private puffs: Puff[] = [];
  private smokes: Smoke[] = [];
  private bursts: Burst[] = [];
  private chunks: Chunk[] = [];
  private dash: DashMesh[] = [0, 1, 2, 3].map(() => ({ n: null, key: '' }));
  private shadows = new Map<number, Node>();
  private acc = 0;

  /** `ice` objects carry entity flag 0x200000: they are drawn through the level's tilt matrix. */
  constructor(root: THREE.Object3D, platform: THREE.Object3D, private variant: string) {
    this.world.name = 'polarFx';
    this.ice.name = 'polarFxIce';
    root.add(this.world);
    platform.add(this.ice);
  }

  /**
   * One player update as object 0x1606 (FUN_800c01c8) and the dash object 0x1616 see it, i.e. after the rider's own tick:
   * a rider that moved leaves a track every other idle (sliding) tick and at walk-script pc 9.
   */
  riderTick(slot: number, q: PolarRider) {
    const last = this.riders[slot];
    const moved = !!last && (last.x !== q.x || last.z !== q.z);
    this.riders[slot] = { ...q };
    const list = this.tracks[slot];
    if (moved && q.md === 0) {
      let slide = false;
      if (q.st === S_IDLE) slide = (this.trackCount[slot]++ & 1) === 0;
      const print = q.st === S_WALK && ((q.af - 1) & 15) + 1 === 9;
      if (slide || print) {
        let t = list.find((track) => !track.on);
        if (!t && list.length < 16) {
          const manic = this.variant === 'manic';
          const n = makeNode(this.ice, PACK, manic ? 47 : 1, manic ? 1 : 3, 3);
          if (n) { t = { n, on: false, dark: 0 }; list.push(t); }
        }
        if (t) {
          t.on = true;
          t.dark = print ? 0 : 0x400;
          place(t.n.obj, q.x, q.y, q.z);
          t.n.obj.position.y += 6 * U; // the engine sorts it over the ice (node +0x51 = 2)
          t.n.obj.rotation.set(0, -(q.yaw + 0x800) * A, 0);
          t.n.obj.scale.setScalar(q.sc / 0x1000);
        }
      }
    }
    for (const t of list) {
      if (!t.on) continue;
      t.dark += 0x60;
      if (t.dark > 0xc00) t.on = false;
      t.n.obj.visible = t.on;
      if (t.on) shade(t.n, t.dark);
    }
    // FUN_800c4748: Cortex's and Brio's dash mesh drops one smoke puff that trails the bear
    if (q.st === S_DASH && q.md === 0 && (q.ch === 3 || q.ch === 4) && q.af === 12) {
      this.smoke(q.x, q.y - ((q.sc * 0x1a4) >> 12), q.z + 0x40, slot);
    }
  }

  /** Object 0x1612 (FUN_800ca424 / FUN_800c42a0). */
  puff(x: number, y: number, z: number, o: PuffOptions = {}) {
    const n = makeNode(this.world, PACK, 31, 2);
    if (!n) return;
    const drift = o.rise !== undefined;
    this.puffs.push({
      n, wisp: drift ? makeNode(this.world, PACK, 45, 2) : null, x, y, z, scale: o.scale ?? 0x1000, dark: 0x1000, phase: 0,
      fadeIn: o.fadeIn ?? 0x400, fadeOut: o.fadeOut ?? 200, shrink: o.shrink ?? 0x60, rise: o.rise ?? 0, baseX: x, r: 0x20, dr: 1,
      angle: Math.floor(Math.random() * 0x1000), drift,
    });
  }

  /** Object 0x1613 (FUN_8008cef8 / FUN_8008c368); with an owner it eases 1/16 of the way to the rider per tick. */
  smoke(x: number, y: number, z: number, owner = -1) {
    this.smokes.push({ frames: [], t: 0, x, y, z, scale: 0x1000, owner });
  }

  /** Object 0x1614 (FUN_800c4498 / FUN_800ca344): 17 shards, each with a velocity of rand(0x4c) - rand(0x4c) per axis. */
  burst(x: number, y: number, z: number) {
    const nodes: Node[] = [], v: number[][] = [], p: number[][] = [];
    const r = () => Math.floor(Math.random() * 0x4c) - Math.floor(Math.random() * 0x4c);
    for (let i = 0; i < 17; i++) {
      const n = makeNode(this.world, PACK, 51, 2);
      if (!n) break;
      nodes.push(n); v.push([r(), r(), r()]); p.push([0, 0, 0]);
    }
    if (nodes.length) this.bursts.push({ nodes, v, p, t: 0, x, y, z });
  }

  /** Three objects 0x1604 from a broken pillar (FUN_800c0888); `a` is the bear's angle from the centre after the bounce. */
  pillar(x: number, y: number, z: number, a: number) {
    const cos = (t: number) => Math.round(Math.cos(t * A) * 4096);
    const add = (vx: number, vy: number, vz: number, spin: number[]) => {
      const n = makeNode(this.world, PACK, 11, 0, 0);
      if (n) this.chunks.push({ n, x, y: y - 0x80, z, v: [vx, vy, vz], rot: [0, 0, 0], spin, floor: y - 0x80 + 0x400 });
    };
    add((cos(a - 0x200) * 0x11) >> 11, -0x20, (cos(a + 0x200) * 0x11) >> 11, [-0x100, -0x80, 0x100]);
    add((cos(a) * 0xb) >> 10, -0x2a, (cos(a + 0x400) * 0xb) >> 10, [0x100, 0x80, -0x100]);
    add((cos(a - 0x400) * 0xb) >> 10, -0x48, (cos(a) * 0xb) >> 10, [0x100, -0x80, 0x100]);
  }

  /**
   * The dash meshes, drawn from the rider's state alone. Dingodile and Rilla Roo (0x1615, FUN_800c45bc): a mesh of their
   * own bear model from script pc 7, turning 0x200 per tick at yaw - 0x400. Cortex and Brio (0x1616): pack mesh 0x2031
   * from pc 10. Both fade by 0x400 per tick late in the script (pc > 12 / pc > 23) and go with the dash.
   */
  dashMesh(slot: number, q: PolarRider | undefined, x: number, y: number, z: number, face: number, mesh: { model: number; part: number } | null) {
    const d = this.dash[slot];
    const spin = !!q && (q.ch === 7 || q.ch === 8), beam = !!q && (q.ch === 3 || q.ch === 4);
    const from = spin ? 8 : 11, fade = spin ? 12 : 23;
    const dark = q ? Math.max(0, q.af - fade) * 0x400 : 0;
    const on = !!q && q.st === S_DASH && q.md === 0 && (spin || beam) && q.af >= from && dark < 0x1000;
    if (!on || !q) { if (d.n) d.n.obj.visible = false; return; }
    const ref = spin ? mesh : { model: PACK, part: 48 };
    const key = ref ? `${ref.model}:${ref.part}` : '';
    if (d.key !== key) { dropNode(d.n); d.n = ref ? makeNode(this.ice, ref.model, ref.part, 1) : null; d.key = key; }
    if (!d.n) return;
    const lift = ((q.sc * (spin && q.ch === 7 ? 0x208 : 0x1a4)) >> 12) * U;
    d.n.obj.visible = true;
    d.n.obj.position.set(x, y + lift, z);
    d.n.obj.rotation.set(spin ? (q.af - from) * 0x200 * A : 0, face + (spin ? 0x400 * A : 0), 0, 'YXZ');
    d.n.obj.scale.setScalar(q.sc / 0x1000);
    shade(d.n, dark);
  }

  /**
   * The thrown bolt's second entity (FUN_800b4b04 / FUN_800b4c74): mesh 0x202f on the ice under it, drawn subtractive
   * at darkness 0x200, growing from 0xc00 as the bolt comes down. Call with every flying bolt, then `endShadows`.
   */
  boltShadow(id: number, x: number, y: number, z: number) {
    let n = this.shadows.get(id);
    if (!n) {
      const made = makeNode(this.world, PACK, 46, 2, 3);
      if (!made) return;
      this.shadows.set(id, n = made);
      shade(n, 0x200);
    }
    n.obj.userData.seen = true;
    n.obj.visible = true;
    place(n.obj, x, 0, z);
    n.obj.position.y += 6 * U;
    n.obj.scale.setScalar(((0x100 - Math.abs(y)) * 8 + 0xc00) / 0x1000);
  }
  endShadows() {
    for (const [id, n] of this.shadows) {
      if (n.obj.userData.seen) { n.obj.userData.seen = false; continue; }
      dropNode(n);
      this.shadows.delete(id);
    }
  }

  private tick() {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      if (p.drift) {
        p.y -= p.rise;
        p.x = p.baseX + ((p.r * Math.round(Math.sin(p.angle * A) * 4096)) >> 12);
        p.r = Math.max(0, p.r - p.dr);
        p.angle += 0x80;
      }
      if (p.phase === 0) {
        p.dark -= p.fadeIn;
        if (p.dark < 0) { p.dark = 0; p.phase = 1; }
      } else {
        p.dark += p.fadeOut;
        p.scale -= p.shrink;
        if (p.dark > 0xdac) { dropNode(p.n); dropNode(p.wisp); this.puffs.splice(i, 1); }
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      const owner = s.owner >= 0 ? this.riders[s.owner] : null;
      if (owner) {
        s.x += (owner.x - s.x) >> 4;
        s.z += (owner.z - s.z) >> 4;
        s.y = owner.y - ((owner.sc * 0x1a4) >> 12);
        s.scale = owner.sc;
      }
      if (++s.t >= SMOKE_FRAMES.length) { for (const f of s.frames) dropNode(f); this.smokes.splice(i, 1); }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t++;
      b.p.forEach((p, j) => { p[0] += b.v[j][0]; p[1] += b.v[j][1]; p[2] += b.v[j][2]; });
      if (b.t === 0x2d) { for (const n of b.nodes) dropNode(n); this.bursts.splice(i, 1); }
    }
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.x += c.v[0]; c.y += c.v[1]; c.z += c.v[2];
      c.v[1] += 3;
      for (let k = 0; k < 3; k++) c.rot[k] += c.spin[k];
      if (c.y >= c.floor) { dropNode(c.n); this.chunks.splice(i, 1); }
    }
  }

  update(dt: number, camera: THREE.Camera) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= 1 / 30) { this.acc -= 1 / 30; this.tick(); }
    const facing = camera.quaternion;
    for (const p of this.puffs) {
      const n = p.drift && p.wisp ? p.wisp : p.n;
      p.n.obj.visible = n === p.n;
      if (p.wisp) p.wisp.obj.visible = n === p.wisp;
      place(n.obj, p.x, p.y, p.z);
      n.obj.quaternion.copy(facing);
      n.obj.scale.setScalar(Math.max(0, p.scale) / 0x1000);
      shade(n, p.dark);
    }
    for (const s of this.smokes) {
      const part = SMOKE_FRAMES[Math.min(s.t, SMOKE_FRAMES.length - 1)], index = part - 26;
      s.frames[index] ??= makeNode(this.world, PACK, part, 2);
      s.frames.forEach((f, i) => { if (f) f.obj.visible = i === index; });
      const n = s.frames[index];
      if (!n) continue;
      place(n.obj, s.x, s.y, s.z);
      n.obj.quaternion.copy(facing);
      n.obj.scale.setScalar(s.scale / 0x1000);
      shade(n, 0);
    }
    for (const b of this.bursts) {
      b.nodes.forEach((n, j) => {
        const dark = b.t * 0x100, scale = 0x1000 - b.t * 0x80;
        n.obj.visible = dark < 0x1000 && scale > 0;
        if (!n.obj.visible) return;
        place(n.obj, b.x + b.p[j][0], b.y + b.p[j][1], b.z + b.p[j][2]);
        n.obj.quaternion.copy(facing);
        n.obj.scale.setScalar(scale / 0x1000);
        shade(n, dark);
      });
    }
    for (const c of this.chunks) {
      c.n.obj.visible = true;
      place(c.n.obj, c.x, c.y, c.z);
      c.n.obj.rotation.set(c.rot[0] * A, -c.rot[1] * A, -c.rot[2] * A); // entity mode 0: Rx Ry Rz (FUN_8003278c)
    }
  }

  dispose() {
    for (const list of this.tracks) for (const t of list) dropNode(t.n);
    for (const p of this.puffs) { dropNode(p.n); dropNode(p.wisp); }
    for (const s of this.smokes) for (const f of s.frames) dropNode(f);
    for (const b of this.bursts) for (const n of b.nodes) dropNode(n);
    for (const c of this.chunks) dropNode(c.n);
    for (const d of this.dash) dropNode(d.n);
    for (const n of this.shadows.values()) dropNode(n);
    this.shadows.clear();
    this.tracks = [[], [], [], []]; this.puffs = []; this.smokes = []; this.bursts = []; this.chunks = [];
    this.world.removeFromParent();
    this.ice.removeFromParent();
  }
}
