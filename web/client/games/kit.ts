// Shared machinery for the 3D mini-game views: scene setup, player actors, catalog helpers,
// procedural textures/props. Games compose these; they do not subclass.
import * as THREE from 'three';
import { CHARACTERS, colorHex, type Look } from '../../shared/look';
import { getGame } from '../../shared/registry';
import { SLOT_COLORS, type Body, type GameEvent, type MiniGame } from '../../shared/types';
import { characterRefs, createCharacter, isProcedural } from '../characters';
import { getCatalog, loadCatalog, ModelInstance, ready, type ModelRef } from '../crash';
import { Fx, lerpAngle, Squash, type BlobShadow } from '../fx';
import { RealFx } from './realFx';
import type { RenderContext, RenderWorld } from './types';

// ---------------------------------------------------------------- disposal

/** Dispose geometries/materials/textures under `o`, skipping subtrees flagged as shared catalog data. */
export function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh && !(c as THREE.Sprite).isSprite) return;
    for (let p: THREE.Object3D | null = c; p; p = p.parent) if (p.userData.shared) return;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      const t = x as THREE.MeshStandardMaterial;
      if (t.userData?.keepMap !== true) t.map?.dispose?.();
      x.dispose();
    }
  });
}

// ---------------------------------------------------------------- catalog helpers

/** Preload everything a view needs from the Crash Bash catalog. Safe when the catalog is missing. */
export async function preloadCatalogFor(arenaId: string, props: string[], extra: (ModelRef | undefined)[] = []): Promise<void> {
  await loadCatalog();
  const cat = getCatalog();
  const arenas = Object.entries(cat.arenas).filter(([k]) => k === arenaId || k.startsWith(arenaId + ':')).map(([, v]) => v);
  await ready([...characterRefs(), ...arenas, ...arenas.flatMap((a) => a.extra ?? []), ...props.map((p) => cat.props[p]), ...extra]);
}

/**
 * Actor scale that draws a character at the real game's size on a stage of `stageScale` (catalog characters are
 * normalised to a common height; the game draws every model in raw units, so all share the stage's units / 1024).
 */
export function nativeCharScale(look: Look, stageScale: number): number {
  const refs = getCatalog().characters as { id: string; scale?: number }[];
  const id = CHARACTERS[look.char % CHARACTERS.length]?.id;
  const sc = refs.find((c) => c.id === id)?.scale;
  return sc ? stageScale / sc : 1;
}

/** Built catalog instance, or null when the ref is missing / not preloaded. */
export function catalogInstance(ref: ModelRef | undefined): ModelInstance | null {
  if (!ref) return null;
  const m = new ModelInstance(ref);
  if (!m.build()) return null;
  m.root.userData.shared = true;
  return m;
}

/** Re-parent `obj` into a wrapper whose bounding box is scaled to `size` (largest of width/depth, or height) with feet on y=0 and centred on x/z. */
export function fitObject(obj: THREE.Object3D, size: number, mode: 'width' | 'height' = 'width'): THREE.Group {
  const wrap = new THREE.Group();
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) { wrap.add(obj); return wrap; }
  const d = box.getSize(new THREE.Vector3());
  const base = mode === 'height' ? d.y : Math.max(d.x, d.z);
  const k = base > 1e-6 ? size / base : 1;
  const c = box.getCenter(new THREE.Vector3());
  obj.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  obj.scale.multiplyScalar(k);
  wrap.add(obj);
  wrap.userData.height = d.y * k;
  return wrap;
}

/** Catalog prop fitted to `size`, or the procedural fallback. */
export function propObject(name: string, size: number, fallback: () => THREE.Object3D, mode: 'width' | 'height' = 'width'): THREE.Object3D {
  const inst = catalogInstance(getCatalog().props[name]);
  if (!inst) return fallback();
  return fitObject(inst.root, size, mode);
}
export const hasProp = (name: string) => !!getCatalog().props[name];

// ---------------------------------------------------------------- procedural textures

export function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat?: [number, number], nearest = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (nearest) { t.magFilter = THREE.NearestFilter; }
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/** Two-tone checker (n x n cells per texture). */
export function checkerTexture(a: string, b: string, n = 2, repeat: [number, number] = [1, 1]): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    const c = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? b : a; g.fillRect(x * c, y * c, c, c); }
  }, repeat);
}

/** Wooden Crash crate face. */
export function crateTexture(base = '#d79a45', frame = '#7a4a1c', mark: 'x' | 'tnt' | 'steel' | 'nitro' = 'x'): THREE.CanvasTexture {
  return canvasTexture(128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 1; i < 5; i++) g.fillRect(0, (i * s) / 5 - 1, s, 2);
    g.fillStyle = frame;
    const f = s * 0.12;
    g.fillRect(0, 0, s, f); g.fillRect(0, s - f, s, f); g.fillRect(0, 0, f, s); g.fillRect(s - f, 0, f, s);
    if (mark === 'x') {
      g.strokeStyle = frame; g.lineWidth = s * 0.1;
      g.beginPath(); g.moveTo(f, f); g.lineTo(s - f, s - f); g.moveTo(s - f, f); g.lineTo(f, s - f); g.stroke();
      g.fillStyle = '#f2c46a'; g.fillRect(s * 0.42, s * 0.42, s * 0.16, s * 0.16);
    } else if (mark === 'tnt') {
      g.fillStyle = '#fff'; g.font = `900 ${s * 0.34}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('TNT', s / 2, s / 2);
    } else if (mark === 'nitro') {
      g.fillStyle = '#e8ffd0'; g.font = `900 ${s * 0.2}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('NITRO', s / 2, s * 0.5);
      g.fillStyle = '#ff3a2a'; g.fillRect(s * 0.2, s * 0.7, s * 0.6, s * 0.06);
    } else {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      for (const [x, y] of [[0.22, 0.22], [0.78, 0.22], [0.22, 0.78], [0.78, 0.78]]) { g.beginPath(); g.arc(x * s, y * s, s * 0.05, 0, 7); g.fill(); }
    }
  });
}

export function makeCrate(size = 1.1, mark: 'x' | 'tnt' | 'steel' | 'nitro' = 'x'): THREE.Object3D {
  const g = new THREE.Group();
  const base = mark === 'tnt' ? '#d8402a' : mark === 'nitro' ? '#4cc43a' : mark === 'steel' ? '#9aa6b4' : '#d79a45';
  const frame = mark === 'tnt' ? '#7a1c10' : mark === 'nitro' ? '#1c6a1a' : mark === 'steel' ? '#5a6674' : '#7a4a1c';
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ map: crateTexture(base, frame, mark), roughness: 0.8 }));
  m.position.y = size / 2;
  g.add(m);
  return g;
}

export function makeBall(r: number): THREE.Object3D {
  const g = new THREE.Group();
  const tex = canvasTexture(128, (c, s) => {
    const cols = ['#ff4f5a', '#ffffff', '#3fa7ff', '#ffffff', '#ffd23f', '#ffffff'];
    const w = s / cols.length;
    cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(i * w, 0, w + 1, s); });
  }, undefined, false);
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, emissive: 0x221100, emissiveIntensity: 0.35 }));
  m.name = 'spin';
  m.position.y = r;
  g.add(m);
  return g;
}

// ---------------------------------------------------------------- labels

const labelCache = new Map<string, THREE.CanvasTexture>();
export function labelSprite(text: string, color = '#ffffff', size = 0.6): THREE.Sprite {
  const key = text + color;
  let t = labelCache.get(key);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d')!;
    g.font = '900 60px system-ui, "Arial Black", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 12; g.lineJoin = 'round'; g.strokeStyle = 'rgba(15,10,25,0.95)';
    g.strokeText(text, 128, 50);
    g.fillStyle = color;
    g.fillText(text, 128, 50);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    labelCache.set(key, t);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
  s.userData.keepMap = true;
  s.scale.set(size * (256 / 96), size, 1);
  s.renderOrder = 40;
  return s;
}

/** Bobbing arrow + "YOU" for the local player. */
export function youMarker(hex: string): THREE.Group {
  const g = new THREE.Group();
  const col = new THREE.Color(hex);
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.5, 4).rotateX(Math.PI),
    new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true }),
  );
  arrow.renderOrder = 41;
  arrow.rotation.y = Math.PI / 4;
  arrow.position.y = 0;
  const outline = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 0.68, 4).rotateX(Math.PI),
    new THREE.MeshBasicMaterial({ color: 0x120a1c, depthTest: false, transparent: true, opacity: 0.85 }),
  );
  outline.rotation.y = Math.PI / 4;
  outline.position.y = -0.04;
  outline.renderOrder = 40;
  const label = labelSprite('YOU', '#ffffff', 0.5);
  label.position.y = 0.6;
  g.add(outline, arrow, label);
  return g;
}

// ---------------------------------------------------------------- kit

export interface KitOpts {
  bg: number;
  fog?: [number, number];
  sun?: [number, number, number];
  hemi?: [number, number, number];
}

export class Over { done = false; winners = new Set<number>(); }

/** Per-view toolkit: root group, lights, fx, actors for players, round-over detection. */
export class Kit {
  readonly root = new THREE.Group();
  readonly fx: Fx;
  /** the real game's effect sprites; a view that uses them calls realFx(stage scale) once and real.update() per frame */
  real!: RealFx;
  readonly actors = new Map<number, Actor>();
  readonly game: MiniGame | undefined;
  readonly over = new Over();
  world!: RenderWorld;
  private bg: THREE.Scene['background'];
  private fog: THREE.Scene['fog'];
  private overChecked = 0;

  constructor(public ctx: RenderContext, public id: string, opts: KitOpts) {
    this.game = getGame(id);
    this.bg = ctx.scene.background;
    this.fog = ctx.scene.fog;
    ctx.scene.background = new THREE.Color(opts.bg);
    if (opts.fog) ctx.scene.fog = new THREE.Fog(opts.bg, opts.fog[0], opts.fog[1]);
    const h = opts.hemi ?? [0xdfe9ff, 0x4a4a62, 1.5];
    this.root.add(new THREE.HemisphereLight(h[0], h[1], h[2]));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    const sp = opts.sun ?? [6, 16, 9];
    sun.position.set(sp[0], sp[1], sp[2]);
    this.root.add(sun);
    ctx.scene.add(this.root);
    this.fx = new Fx(this.root);
  }

  /** Create the real-effects player for a stage drawn at `scale` world units per model unit. */
  realFx(scale: number): RealFx { this.real?.dispose(); return (this.real = new RealFx(this.root, scale)); }

  /** Add the real Crash Bash arena (per-variant if the catalog has it) as the environment; false if unavailable. */
  addArena(variant?: string, y = 0): THREE.Group | null {
    const a = catalogArena(this.id, variant);
    if (!a) return null;
    a.position.y = y;
    this.root.add(a);
    return a;
  }

  /** Hide arena meshes lying inside |x|,|z| < half (own props that clash with the procedural playfield) and big translucent sheets. */
  static clearFootprint(arena: THREE.Object3D, half: number, flatSheets = true) {
    arena.updateMatrixWorld(true);
    const box = new THREE.Box3(), sz = new THREE.Vector3(), c = new THREE.Vector3();
    arena.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      box.setFromObject(m); box.getSize(sz); box.getCenter(c);
      const inside = box.max.x < half && box.min.x > -half && box.max.z < half && box.min.z > -half;
      const overlaps = box.max.x > -half && box.min.x < half && box.max.z > -half && box.min.z < half;
      const near = box.max.x > -half - 6 && box.min.x < half + 6 && box.max.z > -half - 6 && box.min.z < half + 6;
      const overhead = (overlaps && box.min.y > 0.9) || (near && box.min.y > 2.5);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const transp = mats.some((q) => q.transparent && q.opacity < 0.95);
      if (inside || (flatSheets && overhead) || (flatSheets && ((transp && sz.x > 6 && sz.y < 1) || (sz.x > 20 && sz.y > 1.5 && (m.geometry.attributes.position?.count ?? 99) <= 16)))) m.visible = false;
    });
  }

  look(slot: number): Look { return this.ctx.seats[slot]?.look ?? { char: slot % 8, color: slot % 8 }; }
  hex(slot: number): string { const s = this.ctx.seats[slot]; return s ? colorHex(s.look) : SLOT_COLORS[slot] ?? '#ffffff'; }
  shake(a: number) { this.ctx.shake?.(a); }

  /** Round-over detection: sets this.over (winners = best placement(s)). */
  checkOver(w: RenderWorld) {
    this.world = w;
    if (!this.game) return;
    const done = this.game.isOver(w) || w.time >= this.game.maxTime;
    if (done && !this.over.done) {
      this.over.done = true;
      const pl = this.game.placements(w);
      this.over.winners = new Set([pl[0]]);
      this.overChecked = w.tick;
    } else if (!done) this.over.done = false;
  }

  /** Get-or-create the actor for a player body; the factory builds the model once. */
  actor(b: Body, make?: () => ActorParts): Actor {
    let a = this.actors.get(b.id);
    if (!a) {
      const parts = make ? make() : { inst: createCharacter(this.look(b.slot)) };
      a = new Actor(this, b, parts);
      this.actors.set(b.id, a);
    }
    return a;
  }

  /** Shared reactions to the events every game has (jump/land/dash/bump). Returns true if handled. */
  baseEvent(e: GameEvent): boolean {
    // Start the pose without consuming the event: each game still gets its own FX.
    switch (e.k) {
      case 'jump': case 'dash': case 'throw': case 'grab': case 'shoot': case 'boost':
        this.actorForSlot(e.s)?.action(); break;
      case 'hit': this.actorForSlot(e.o)?.action(); break;
      case 'goal': this.actorForSlot(e.s)?.hit(); break;
    }
    switch (e.k) {
      // the engine has no generic jump / land / run dust or bump sparks (re/notes/engine.md "Effect scripts"): poses and shake only
      // not consumed: games still play their own sounds / voices / effects for these (Dash bumps, Crate Crush jumps, Tank crate landings)
      case 'jump': this.actorForSlot(e.s)?.jump(); break;
      case 'land': this.shake(0.05 * e.v); break;
      case 'bump': this.shake(0.06 + e.v * 0.1); break;
    }
    return false;
  }

  /** Remove actors whose body id isn't in `seen`. */
  prune(seen: Set<number>) {
    for (const [id, a] of this.actors) if (!seen.has(id)) { a.dispose(); this.actors.delete(id); }
  }

  actorForSlot(slot: number): Actor | undefined {
    for (const a of this.actors.values()) if (a.slot === slot) return a;
    return undefined;
  }

  /** Rebuild every actor (e.g. once catalog models finish loading late). */
  reset() { for (const a of this.actors.values()) a.dispose(); this.actors.clear(); }

  dispose() {
    this.reset();
    this.real?.dispose();
    this.fx.dispose();
    this.ctx.scene.remove(this.root);
    disposeTree(this.root);
    this.ctx.scene.background = this.bg;
    this.ctx.scene.fog = this.fog;
  }
}

export interface ActorParts {
  inst: ModelInstance;
  /** extra visuals (vehicle etc.) parented to the actor's yaw group */
  extra?: THREE.Object3D;
  shadow?: number;
  /** model is a vehicle/steady object: skip run-lean and body animations */
  steady?: boolean;
  /** height of the head marker above the ground */
  headY?: number;
  /** uniform visual scale (default 1.25 so characters read from the high camera) */
  scale?: number;
}

export interface ActorState {
  /** override anim role */
  role?: string;
  /** vertical hop added on top of body.y */
  hop?: number;
  /** hide the actor */
  hidden?: boolean;
  /** blink (invulnerability) */
  blink?: boolean;
  /** do not lean/animate by speed */
  freeze?: boolean;
  /** extra spin (rad/s) while tumbling */
  tumble?: boolean;
  /** skip face update (keep current yaw) */
  keepYaw?: boolean;
}

export class Actor {
  readonly holder = new THREE.Group();
  readonly yaw = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly inst: ModelInstance;
  readonly slot: number;
  readonly squash: Squash;
  readonly shadow: BlobShadow;
  readonly headY: number;
  marker: THREE.Group | null = null;
  hitT = 0;
  private actionT = 0;
  face: number;
  private fx: Fx;
  private px: number; private pz: number; private py: number;
  private speed = 0;
  private proc: boolean;
  private steady: boolean;
  private tumbleA = 0;
  readonly extra?: THREE.Object3D;
  private t = Math.random() * 6;

  constructor(private kit: Kit, b: Body, parts: ActorParts) {
    this.slot = b.slot;
    this.inst = parts.inst;
    this.fx = kit.fx;
    this.proc = isProcedural(parts.inst);
    this.steady = !!parts.steady;
    this.extra = parts.extra;
    this.face = b.face;
    this.px = b.x; this.pz = b.z; this.py = b.y;
    this.pivot.add(parts.inst.root);
    if (parts.extra) this.pivot.add(parts.extra);
    this.yaw.add(this.pivot);
    this.holder.add(this.yaw);
    kit.root.add(this.holder);
    this.squash = new Squash(this.pivot, parts.scale ?? 1.25);
    this.shadow = kit.fx.shadow(parts.shadow ?? b.r * 1.1, 0.42);
    const box = new THREE.Box3().setFromObject(parts.inst.root);
    this.headY = (parts.headY ?? (box.isEmpty() ? 1.8 : THREE.MathUtils.clamp(box.max.y, 1.2, 3.6))) * (parts.scale ?? 1.25);
    if (kit.ctx.mySlot === b.slot && b.slot >= 0) {
      this.marker = youMarker(kit.hex(b.slot));
      kit.root.add(this.marker);
    }
    this.holder.position.set(b.x, b.y, b.z);
    this.yaw.rotation.y = b.face;
  }

  /** Per-frame update from the (interpolated) body. */
  update(b: Body, dt: number, st: ActorState = {}) {
    const over = this.kit.over;
    this.t += dt;
    const hidden = !!st.hidden;
    this.holder.visible = !hidden;
    this.shadow.visible = !hidden;
    if (this.marker) this.marker.visible = !hidden;
    if (hidden) { this.px = b.x; this.pz = b.z; this.py = b.y; return; }

    const hop = st.hop ?? 0;
    this.holder.position.set(b.x, b.y + hop, b.z);
    const mvx = b.vx, mvz = b.vz;
    let speed = Math.hypot(mvx, mvz);
    if (speed < 0.01 && dt > 0) speed = Math.hypot(b.x - this.px, b.z - this.pz) / dt;
    this.speed += (speed - this.speed) * Math.min(1, dt * 14);
    const grounded = b.y <= 0.06 && !b.fall;

    if (!st.keepYaw && !over.done) {
      this.face = lerpAngle(this.face, b.face, 1 - Math.exp(-18 * dt));
    } else if (over.done && grounded) {
      // celebrate / sulk facing the camera
      this.face = lerpAngle(this.face, 0.35 * Math.sin(this.t * 1.4), 1 - Math.exp(-8 * dt));
    }
    this.yaw.rotation.y = this.face;

    // role
    let role = st.role ?? (!grounded ? 'jump' : this.speed > 0.7 ? 'run' : 'idle');
    if (over.done) role = over.winners.has(b.slot) ? 'win' : 'lose';
    else if (this.hitT > 0 || role === 'hit') role = 'hit';
    else if (!this.steady && (role === 'idle' || role === 'run' || role === 'jump') && this.inst.ref?.anims?.action != null
      && (this.actionT > 0 || b.dash > 0 || role === 'jump')) role = 'action';
    this.hitT = Math.max(0, this.hitT - dt);
    this.actionT = Math.max(0, this.actionT - dt);
    this.inst.play(role);
    // vehicles play their clips at the game's fixed rate; walkers scale the run cycle with speed
    this.inst.update(dt * (role === 'run' && !this.steady ? Math.min(1.6, Math.max(0.7, this.speed / 5)) : 1));

    // squash & stretch
    if (!grounded && b.vy > 0.5 && this.py <= 0.06) { this.squash.kick(-0.45); }
    if (grounded && this.py > 0.12) this.squash.kick(0.55);
    if (b.dash > 0) this.squash.set(-0.12);
    this.squash.update(dt);

    // lean into the run, tumble when falling
    const lean = st.freeze || this.steady || over.done ? 0 : Math.min(this.speed * 0.035, 0.22) * (this.proc ? 0.5 : 1);
    this.pivot.rotation.x += ((st.tumble ? 0 : lean) - this.pivot.rotation.x) * Math.min(1, dt * 12);
    if (st.tumble) {
      this.tumbleA += dt * 7;
      this.pivot.rotation.x = this.tumbleA;
      this.pivot.rotation.z = Math.sin(this.tumbleA * 0.7) * 0.6;
    } else { this.pivot.rotation.z *= Math.exp(-10 * dt); this.tumbleA = 0; }

    if (st.blink) this.pivot.visible = Math.floor(this.t * 14) % 2 === 0;
    else this.pivot.visible = true;
    void this.extra;

    this.shadow.set(b.x, b.z, Math.max(0, b.y + hop));
    if (this.marker) {
      this.marker.position.set(b.x, b.y + hop + this.headY + 0.55 + Math.sin(this.t * 5) * 0.08, b.z);
    }
    this.px = b.x; this.pz = b.z; this.py = b.y;
  }

  /** React to getting hit: flinch + squash. */
  hit(strength = 1) {
    this.hitT = 0.45;
    this.squash.kick(0.7 * strength);
  }
  action() { this.actionT = 0.45; }
  jump() { this.squash.kick(-0.4); }

  dispose() {
    this.kit.root.remove(this.holder);
    if (this.marker) this.kit.root.remove(this.marker);
    this.kit.fx.removeShadow(this.shadow);
    disposeTree(this.holder);
    if (this.marker) disposeTree(this.marker);
  }
}

/** Convenience used by the views: standard HUD "♥♥♥" style strings. */
export const hearts = (n: number, max = 3) => (n > 0 ? '♥'.repeat(Math.min(n, max)) : 'OUT');

/** sim variant id -> catalog arena key suffix, where they differ */
const ARENA_ALIAS: Record<string, string> = { beach: 'beachBall', sky: 'skyBalls', tilt: 'tiltPanic', polar: 'polarPanic', melt: 'meltPanic', manic: 'manicPanic', pogo: 'pogoPainter', agogo: 'pogoAGogo', elpogoloco: 'elPogoLoco', padlock: 'pogoPadlock', dante: 'dantesDash' };

/**
 * Real Crash Bash arena for a game: per-variant entry (`gameId:variant`) if the catalog has one, else the
 * family arena, plus extras. Catalog arenas are already in sim units and centred on the origin, so it is
 * placed as-is. Returns null when the catalog has nothing usable.
 */
export function catalogArena(gameId: string, variant?: string): THREE.Group | null {
  const arenas = getCatalog().arenas as Record<string, ModelRef & { extra?: ModelRef[] }>;
  const cands = variant ? [ARENA_ALIAS[variant], variant, `${variant}Fox`, `${variant}Bash`, `${variant}Dash`] : [];
  const hit = cands.find((k) => k && arenas[`${gameId}:${k}`]);
  const entry = (hit && arenas[`${gameId}:${hit}`]) || arenas[gameId];
  const main = catalogInstance(entry);
  if (!entry || !main) return null;
  const g = new THREE.Group();
  g.add(main.root);
  for (const ex of entry.extra ?? []) { const m = catalogInstance(ex); if (m) g.add(m.root); }
  // decoded arenas carry posed/skinned effect parts (waterfalls, sky cards, props) that read as junk from above
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3(), sz = new THREE.Vector3();
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    bb.setFromObject(m).getSize(sz);
    if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh || ((sz.z < 0.15 || sz.x < 0.15) && sz.y > 0.8)) o.visible = false; // vertical cards
  });
  g.name = 'catalogArena';
  return g;
}

/** Billboard sprite whose text can change (scores, counters). Redraws only when the text changes. */
export class TextSprite {
  readonly sprite: THREE.Sprite;
  private c = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private cur = '';
  constructor(private color: string, size = 0.8, private font = '900 64px system-ui, "Arial Black", sans-serif') {
    this.c.width = 256; this.c.height = 96;
    this.g = this.c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false }));
    this.sprite.scale.set(size * (256 / 96), size, 1);
    this.sprite.renderOrder = 40;
    this.sprite.userData.keepMap = false;
  }
  set(text: string, color = this.color) {
    const key = text + color;
    if (key === this.cur) return;
    this.cur = key;
    const g = this.g;
    g.clearRect(0, 0, 256, 96);
    g.font = this.font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 12; g.lineJoin = 'round'; g.strokeStyle = 'rgba(15,10,25,0.95)';
    g.strokeText(text, 128, 50);
    g.fillStyle = color;
    g.fillText(text, 128, 50);
    this.tex.needsUpdate = true;
  }
}


/** Camera-facing health bar (two colour sprites). Add .group to the scene; call set(frac). */
export class HpBar {
  readonly group = new THREE.Group();
  private bar: THREE.Sprite;
  constructor(public w = 1.8) {
    const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x14141c, depthTest: false, transparent: true, opacity: 0.85 }));
    back.scale.set(w + 0.1, 0.34, 1); back.renderOrder = 40;
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x4ade80, depthTest: false }));
    this.bar.scale.set(w, 0.22, 1); this.bar.renderOrder = 41; this.bar.position.z = 0.01;
    this.group.add(back, this.bar);
  }
  set(f: number) {
    f = Math.max(0, Math.min(1, f));
    this.bar.scale.x = Math.max(0.001, this.w * f);
    this.bar.position.x = -this.w / 2 + (this.w / 2) * f;
    (this.bar.material as THREE.SpriteMaterial).color.set(f > 0.5 ? 0x4ade80 : f > 0.25 ? 0xfacc15 : 0xf43f5e);
  }
}
