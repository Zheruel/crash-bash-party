// Reusable "juice" for the mini-game views: particles, floating text, shockwave rings,
// blob shadows and squash-and-stretch. Everything is procedural (canvas textures), no assets.
import * as THREE from 'three';

type Shape = 'dot' | 'soft' | 'star' | 'spark' | 'chip' | 'wumpa' | 'smoke';
const texCache = new Map<Shape, THREE.CanvasTexture>();

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shapeTex(shape: Shape): THREE.CanvasTexture {
  let t = texCache.get(shape);
  if (t) return t;
  t = canvasTex(64, (g, s) => {
    const h = s / 2;
    g.fillStyle = '#fff';
    if (shape === 'dot' || shape === 'soft' || shape === 'smoke') {
      const grad = g.createRadialGradient(h, h, 0, h, h, h);
      if (shape === 'dot') { grad.addColorStop(0, '#fff'); grad.addColorStop(0.7, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)'); }
      else if (shape === 'soft') { grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)'); }
      else { grad.addColorStop(0, 'rgba(255,255,255,0.9)'); grad.addColorStop(0.55, 'rgba(255,255,255,0.5)'); grad.addColorStop(1, 'rgba(255,255,255,0)'); }
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    } else if (shape === 'star') {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? h * 0.42 : h * 0.95;
        g.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
    } else if (shape === 'spark') {
      g.beginPath();
      g.moveTo(h, 1); g.quadraticCurveTo(h + 3, h - 3, s - 1, h); g.quadraticCurveTo(h + 3, h + 3, h, s - 1);
      g.quadraticCurveTo(h - 3, h + 3, 1, h); g.quadraticCurveTo(h - 3, h - 3, h, 1);
      g.fill();
    } else if (shape === 'chip') {
      g.fillRect(h * 0.35, h * 0.55, h * 1.3, h * 0.9);
    } else if (shape === 'wumpa') {
      g.fillStyle = '#ff7a1a';
      g.beginPath(); g.ellipse(h, h + 3, h * 0.72, h * 0.8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffb04a';
      g.beginPath(); g.ellipse(h - 8, h - 4, 8, 11, 0.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3fbf3f';
      g.beginPath(); g.ellipse(h + 4, 8, 7, 4, -0.5, 0, Math.PI * 2); g.fill();
    }
  });
  texCache.set(shape, t);
  return t;
}

export interface BurstOpts {
  color?: THREE.ColorRepresentation | THREE.ColorRepresentation[];
  count?: number;
  speed?: number;
  size?: number;
  life?: number;
  /** extra upward kick (m/s) */
  up?: number;
  gravity?: number;
  /** emit horizontally in a ring instead of a sphere */
  flat?: boolean;
  /** scatter radius at spawn */
  spread?: number;
  /** direction bias (adds to velocity) */
  vx?: number;
  vz?: number;
  grow?: number; // end size multiplier
  shape?: Shape;
}

interface Particle {
  sp: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  vx: number; vy: number; vz: number;
  g: number; drag: number;
  life: number; max: number;
  s0: number; s1: number;
  spin: number;
  active: boolean;
}

interface Floater { sp: THREE.Sprite; mat: THREE.SpriteMaterial; vy: number; life: number; max: number; size: number; pop: number }
interface Ring { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number; r0: number; r1: number }

const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
ringGeo.rotateX(-Math.PI / 2);

const tmp = new THREE.Color();
const pick = <T,>(a: T | T[]): T => (Array.isArray(a) ? a[Math.floor(Math.random() * a.length)] : a);

/** One per game view. Owns a group under `parent`; call update(dt) every frame and dispose() at the end. */
export class Fx {
  readonly root = new THREE.Group();
  private parts: Particle[] = [];
  private cursor = 0;
  private floaters: Floater[] = [];
  private rings: Ring[] = [];
  private blobs: BlobShadow[] = [];

  constructor(public parent: THREE.Object3D, maxParticles = 360) {
    this.root.name = 'fx';
    parent.add(this.root);
    for (let i = 0; i < maxParticles; i++) {
      const mat = new THREE.SpriteMaterial({ map: shapeTex('dot'), transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      this.root.add(sp);
      this.parts.push({ sp, mat, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, life: 0, max: 1, s0: 1, s1: 0, spin: 0, active: false });
    }
  }

  /** Generic particle burst. */
  burst(x: number, y: number, z: number, o: BurstOpts = {}) {
    const n = o.count ?? 10;
    const speed = o.speed ?? 3;
    for (let i = 0; i < n; i++) {
      const p = this.parts[this.cursor];
      this.cursor = (this.cursor + 1) % this.parts.length;
      const a = Math.random() * Math.PI * 2;
      const e = o.flat ? 0 : Math.random() * 0.9 + 0.1;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const sr = o.spread ?? 0.15;
      p.sp.position.set(x + (Math.random() - 0.5) * sr * 2, y, z + (Math.random() - 0.5) * sr * 2);
      p.vx = Math.cos(a) * sp * (o.flat ? 1 : Math.cos(e)) + (o.vx ?? 0);
      p.vz = Math.sin(a) * sp * (o.flat ? 1 : Math.cos(e)) + (o.vz ?? 0);
      p.vy = (o.flat ? 0 : Math.sin(e) * sp) + (o.up ?? 0) * (0.6 + Math.random() * 0.6);
      p.g = o.gravity ?? 9;
      p.drag = 1.2;
      p.max = p.life = (o.life ?? 0.6) * (0.7 + Math.random() * 0.6);
      p.s0 = (o.size ?? 0.25) * (0.7 + Math.random() * 0.6);
      p.s1 = p.s0 * (o.grow ?? 0.1);
      p.spin = (Math.random() - 0.5) * 8;
      p.mat.map = shapeTex(o.shape ?? 'dot');
      p.mat.color.set(pick(o.color ?? 0xffffff));
      p.mat.opacity = 1;
      p.mat.rotation = Math.random() * 6;
      p.sp.scale.set(p.s0, p.s0, 1);
      p.sp.visible = true;
      p.active = true;
    }
  }

  /** Ground dust puff (strength 0..1). */
  dust(x: number, z: number, strength = 1, color: THREE.ColorRepresentation = 0xd9cfb8) {
    this.burst(x, 0.12, z, { shape: 'smoke', color, count: Math.ceil(2 + strength * 5), speed: 1.2 + strength * 1.5, size: 0.5 + strength * 0.4, life: 0.55, up: 0.8, gravity: -0.5, flat: true, grow: 2.2, spread: 0.2 });
  }
  sparks(x: number, y: number, z: number, color: THREE.ColorRepresentation | THREE.ColorRepresentation[] = [0xfff2a0, 0xffb347], count = 12, speed = 5) {
    this.burst(x, y, z, { shape: 'spark', color, count, speed, size: 0.32, life: 0.45, gravity: 8, grow: 0.2 });
  }
  stars(x: number, y: number, z: number, count = 8, color: THREE.ColorRepresentation | THREE.ColorRepresentation[] = [0xffe14a, 0xffffff]) {
    this.burst(x, y, z, { shape: 'star', color, count, speed: 4.5, size: 0.42, life: 0.8, up: 3, gravity: 9, grow: 0.3 });
  }
  wumpa(x: number, y: number, z: number, count = 6) {
    this.burst(x, y, z, { shape: 'wumpa', color: 0xffffff, count, speed: 2.5, size: 0.5, life: 0.9, up: 6, gravity: 14, grow: 0.7 });
  }
  confetti(x: number, y: number, z: number, count = 30, colors: THREE.ColorRepresentation[] = [0xff5a4f, 0x3fa7ff, 0xffd23f, 0x4cd964, 0xa96bff]) {
    this.burst(x, y, z, { shape: 'chip', color: colors, count, speed: 3.5, size: 0.28, life: 1.6, up: 7, gravity: 6, grow: 0.9, spread: 0.4 });
  }
  splash(x: number, y: number, z: number, strength = 1) {
    this.burst(x, y, z, { shape: 'soft', color: [0xffffff, 0xbfe6ff], count: Math.ceil(10 * strength), speed: 3, size: 0.4, life: 0.8, up: 6 * strength, gravity: 14, grow: 0.4 });
    this.ring(x, z, { color: 0xffffff, radius: 2.2 * strength, life: 0.7, y });
  }
  smoke(x: number, y: number, z: number, count = 6, color: THREE.ColorRepresentation = 0x555555) {
    this.burst(x, y, z, { shape: 'smoke', color, count, speed: 1.4, size: 0.7, life: 0.9, up: 1.5, gravity: -1, grow: 2.5 });
  }
  /** Single tiny trail dot (call every frame from a moving projectile). */
  trail(x: number, y: number, z: number, color: THREE.ColorRepresentation = 0xffffff, size = 0.3, life = 0.3) {
    this.burst(x, y, z, { shape: 'soft', color, count: 1, speed: 0.2, size, life, gravity: 0, spread: 0.02, grow: 0 });
  }

  /** Floating text popup ("+1", "BONK!"). */
  text(x: number, y: number, z: number, str: string, o: { color?: string; size?: number; life?: number; rise?: number } = {}) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d')!;
    let px = 64;
    g.font = `900 ${px}px system-ui, "Arial Black", sans-serif`;
    const tw = g.measureText(str).width + 24;
    if (tw > 256) { px = Math.floor((64 * 256) / tw); g.font = `900 ${px}px system-ui, "Arial Black", sans-serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 12; g.lineJoin = 'round';
    g.strokeStyle = 'rgba(20,12,30,0.95)';
    g.strokeText(str, 128, 50);
    g.fillStyle = o.color ?? '#ffe14a';
    g.fillText(str, 128, 50);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z);
    sp.renderOrder = 50;
    const size = o.size ?? 1.2;
    sp.scale.set(size * (256 / 96), size, 1);
    this.root.add(sp);
    this.floaters.push({ sp, mat, vy: o.rise ?? 1.6, life: o.life ?? 1.1, max: o.life ?? 1.1, size, pop: 0 });
  }

  /** Expanding ground ring (shockwave). */
  ring(x: number, z: number, o: { color?: THREE.ColorRepresentation; radius?: number; life?: number; y?: number; from?: number } = {}) {
    const mat = new THREE.MeshBasicMaterial({ color: o.color ?? 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.position.set(x, (o.y ?? 0) + 0.06, z);
    mesh.renderOrder = 4;
    this.root.add(mesh);
    const life = o.life ?? 0.5;
    this.rings.push({ mesh, mat, life, max: life, r0: o.from ?? 0.2, r1: o.radius ?? 2 });
  }

  /** Soft blob shadow; place with shadow.set(x, z, height). */
  shadow(radius = 0.8, opacity = 0.4): BlobShadow {
    const b = new BlobShadow(radius, opacity);
    this.root.add(b.mesh);
    this.blobs.push(b);
    return b;
  }
  removeShadow(b: BlobShadow) {
    this.root.remove(b.mesh);
    b.dispose();
    const i = this.blobs.indexOf(b);
    if (i >= 0) this.blobs.splice(i, 1);
  }

  update(dt: number) {
    for (const p of this.parts) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; p.sp.visible = false; continue; }
      const k = 1 - p.life / p.max;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vz *= d;
      p.vy -= p.g * dt;
      p.sp.position.x += p.vx * dt;
      p.sp.position.y += p.vy * dt;
      p.sp.position.z += p.vz * dt;
      const s = p.s0 + (p.s1 - p.s0) * k;
      p.sp.scale.set(s, s, 1);
      p.mat.opacity = Math.min(1, (1 - k) * 2);
      p.mat.rotation += p.spin * dt;
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) { this.root.remove(f.sp); f.mat.map?.dispose(); f.mat.dispose(); this.floaters.splice(i, 1); continue; }
      const k = 1 - f.life / f.max;
      f.sp.position.y += f.vy * dt * (1 - k * 0.7);
      f.pop = Math.min(1, f.pop + dt * 8);
      const s = f.size * (0.6 + 0.4 * easeOutBack(f.pop));
      f.sp.scale.set(s * (256 / 96), s, 1);
      f.mat.opacity = Math.min(1, f.life / (f.max * 0.35));
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) { this.root.remove(r.mesh); r.mat.dispose(); this.rings.splice(i, 1); continue; }
      const k = 1 - r.life / r.max;
      const s = r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k));
      r.mesh.scale.set(s, 1, s);
      r.mat.opacity = (1 - k) * 0.9;
    }
  }

  clear() {
    for (const p of this.parts) { p.active = false; p.sp.visible = false; }
    for (const f of this.floaters) { this.root.remove(f.sp); f.mat.map?.dispose(); f.mat.dispose(); }
    for (const r of this.rings) { this.root.remove(r.mesh); r.mat.dispose(); }
    this.floaters = []; this.rings = [];
  }

  dispose() {
    this.clear();
    for (const p of this.parts) p.mat.dispose();
    for (const b of this.blobs) b.dispose();
    this.parts = []; this.blobs = [];
    this.parent.remove(this.root);
  }
}

const easeOutBack = (t: number) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

let blobTex: THREE.CanvasTexture | null = null;
const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** Flat dark disc under something; shrinks and fades as the thing rises. */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  constructor(public radius: number, public opacity: number) {
    blobTex ??= canvasTex(64, (g, s) => {
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    });
    this.mat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity });
    this.mesh = new THREE.Mesh(blobGeo, this.mat);
    this.mesh.renderOrder = 2;
  }
  set(x: number, z: number, height = 0, groundY = 0.02) {
    const h = Math.max(0, height);
    const s = this.radius * 2 * (1 / (1 + h * 0.25));
    this.mesh.position.set(x, groundY, z);
    this.mesh.scale.set(s, 1, s);
    this.mat.opacity = this.opacity / (1 + h * 0.35);
  }
  set visible(v: boolean) { this.mesh.visible = v; }
  dispose() { this.mat.dispose(); }
}

/**
 * Critically-damped-ish spring driving a squash/stretch scale on an object.
 * kick(+) squashes (wider, shorter), kick(-) stretches (taller, thinner).
 */
export class Squash {
  private v = 0;
  private x = 0;
  constructor(private target: THREE.Object3D, private base = 1, private stiffness = 260, private damping = 14) {}
  kick(amount: number) { this.v += amount * 12; }
  set(amount: number) { this.x = amount; }
  update(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / 0.016));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += (-this.stiffness * this.x - this.damping * this.v) * h;
      this.x += this.v * h;
    }
    const a = Math.max(-0.6, Math.min(0.6, this.x));
    const b = this.base;
    this.target.scale.set(b * (1 + a * 0.6), b * (1 - a), b * (1 + a * 0.6));
  }
}

/** Helper: smooth angle approach (shortest way round). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, t);
}

export const colorOf = (c: THREE.ColorRepresentation) => tmp.set(c).clone();
