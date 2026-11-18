import * as THREE from 'three';
import type { GameEvent } from '../shared/types';
import { HttpAssetSource } from './assets';
import type { ClientMiniGame, RenderContext, RenderWorld } from './games/types';
import { sfx } from './shell/sound';

/** One "place" the canvas can show outside of a mini-game (title, lobby, board, podium). */
export interface Mode {
  root: THREE.Object3D;
  /** scene background, or null for a transparent canvas (CSS backdrop shows through) */
  background: THREE.Color | THREE.Texture | null;
  enter?(stage: Stage): void;
  leave?(stage: Stage): void;
  update(dt: number, t: number, stage: Stage): void;
}

/** Owns the renderer, scene and camera; shows one Mode at a time or the active mini-game view. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  readonly assets = new HttpAssetSource();
  readonly ctx: RenderContext;
  private modes: Mode[] = [];
  private mode: Mode | null = null;
  private game: ClientMiniGame | null = null;
  private gameShown = false;
  private gameRadius = 12;
  private token = 0;
  private shakeAmt = 0;
  private hitUntil = 0;
  private lastWorld: RenderWorld | null = null;
  private gameBg: THREE.Color | THREE.Texture | null = null;
  onResize: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
    this.ctx = {
      scene: this.scene, camera: this.camera, assets: this.assets, mySlot: null, seats: [], time: 0,
      frame: (r) => this.frame(r),
      shake: (a) => this.shake(a),
    };
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  get aspect() { return this.camera.aspect; }
  get width() { return innerWidth; }
  get height() { return innerHeight; }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.gameShown) this.frame(this.gameRadius);
    this.onResize?.();
  }

  // ---- modes ----
  register(m: Mode) {
    m.root.visible = false;
    this.scene.add(m.root);
    this.modes.push(m);
  }

  show(m: Mode | null) {
    if (this.gameShown) this.hideGame();
    if (m === this.mode) return;
    this.mode?.leave?.(this);
    for (const x of this.modes) x.root.visible = x === m;
    this.mode = m;
    this.camera.clearViewOffset();
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
    this.scene.background = m?.background ?? null;
    m?.enter?.(this);
  }
  get current() { return this.mode; }

  // ---- camera helpers ----
  /** Aim the camera so a play area of this radius fits (tilted top-down); used by mini-game views via ctx.frame. */
  frame(radius: number) {
    this.gameRadius = radius;
    const fov = (this.camera.fov * Math.PI) / 180;
    const vh = radius / Math.tan(fov / 2);
    const hh = radius / (Math.tan(fov / 2) * this.camera.aspect);
    const dist = Math.max(vh, hh) * 1.05;
    const tilt = 0.95;
    this.camera.position.set(0, Math.sin(tilt) * dist, Math.cos(tilt) * dist);
    this.camera.lookAt(0, 0, 0);
  }

  /** Screen position (CSS px) of a world point. */
  project(v: THREE.Vector3, out = { x: 0, y: 0, visible: true }) {
    this.camera.updateMatrixWorld();
    const p = v.clone().project(this.camera);
    out.x = (p.x * 0.5 + 0.5) * innerWidth;
    out.y = (-p.y * 0.5 + 0.5) * innerHeight;
    out.visible = p.z < 1 && p.z > -1;
    return out;
  }

  shake(a: number) { this.shakeAmt = Math.min(1.5, Math.max(this.shakeAmt, a)); }
  hitStop(ms: number) { this.hitUntil = performance.now() + Math.min(ms, 250); }

  // ---- mini-game view ----
  /** Load and show a mini-game view. Resolves false if superseded by a newer load/unload. */
  async loadGame(view: ClientMiniGame, world: RenderWorld, mySlot: number | null, seats: RenderContext['seats']): Promise<boolean> {
    this.unloadGame();
    const token = ++this.token;
    this.ctx.mySlot = mySlot;
    this.ctx.seats = seats;
    try {
      await Promise.all([this.assets.preload(view.assets ?? {}), view.preload?.().catch(() => {})]);
    } catch { /* placeholders */ }
    if (token !== this.token) return false;
    try {
      this.gameBg = this.scene.background;
      this.preGame = new Set(this.scene.children);
      view.init(this.ctx, world);
    } catch (e) {
      console.error('mini-game init failed', e);
      return false;
    }
    this.game = view;
    // A round announcement can precede the first snapshot, so game-specific data
    // (laps, lives, etc.) may not exist until render() receives a real world.
    this.lastWorld = world.bodies.length ? world : null;
    this.showGame();
    return true;
  }

  private showGame() {
    this.mode?.leave?.(this);
    for (const x of this.modes) x.root.visible = false;
    this.mode = null;
    this.gameShown = true;
    this.camera.clearViewOffset();
    this.camera.fov = 40;
    this.camera.updateProjectionMatrix();
    this.scene.background = new THREE.Color(0x0e1424);
    this.frame(this.gameRadius);
  }
  private preGame: Set<THREE.Object3D> | null = null;
  private hideGame() { this.gameShown = false; }

  unloadGame() {
    this.token++;
    if (this.game) {
      try { this.game.dispose(this.ctx); } catch (e) { console.error(e); }
    }
    this.game = null;
    this.lastWorld = null;
    // Safety net: drop anything a view left in the scene after dispose.
    if (this.preGame) {
      for (const c of [...this.scene.children]) if (!this.preGame.has(c)) { this.scene.remove(c); }
      this.preGame = null;
    }
    if (this.gameShown) { this.gameShown = false; this.scene.background = this.gameBg; }
  }

  get activeGame() { return this.gameShown ? this.game : null; }
  get gameVisible() { return this.gameShown && !!this.game; }

  /** Forward a sim event to the view (or apply sensible defaults when the view doesn't handle events). */
  gameEvent(e: GameEvent) {
    if (!this.game || !this.gameShown) return;
    if (this.game.onEvent) {
      try { this.game.onEvent(this.ctx, e); } catch (err) { console.error(err); }
    } else if (e.k === 'hit') { sfx.play('thud'); this.shake(0.2 * (e.v || 0.5)); }
    else if (e.k === 'ko') { sfx.play('boom'); this.shake(0.7); this.hitStop(70); }
    if (e.k === 'ko' && this.game.onEvent) this.hitStop(60);
  }

  // ---- frame ----
  render(world: RenderWorld | null, dt: number, t: number) {
    this.ctx.time = t;
    const frozen = performance.now() < this.hitUntil;
    if (this.gameShown && this.game) {
      if (world) this.lastWorld = world;
      const w = this.lastWorld;
      if (w && !frozen) {
        try { this.game.render(this.ctx, w, dt); } catch (e) { console.error('mini-game render failed', e); }
      }
    } else if (this.mode) {
      this.mode.update(dt, t, this);
    }
    let off: THREE.Vector3 | null = null;
    if (this.shakeAmt > 0.01) {
      const a = this.shakeAmt * 0.6;
      off = new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
      this.camera.position.add(off);
      this.shakeAmt *= Math.exp(-dt * 7);
    } else this.shakeAmt = 0;
    this.renderer.render(this.scene, this.camera);
    if (off) this.camera.position.sub(off);
  }
}
