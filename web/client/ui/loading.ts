import * as THREE from 'three';
import { instance, ready } from '../crash';

/** The real LOADING screen: model 0311 (part0 the LOADING letters, part1 the vertex-coloured vortex tunnel). */
const MODEL = { model: 311 };
/** The engine's level fade, measured on the emulator: brightness per 30 Hz frame from black. */
const FADE = [0, 0.19, 0.37, 0.58, 0.74, 0.93, 1];
const FRAME = 1000 / 30;
/** camera on the tunnel axis, 3 units in front of the letters: the letters span ~42 % of a 4:3 frame as in the game */
const CAM_Z = 3;

/**
 * Full-screen LOADING card shown while a level loads. It fades in from black like the game (six steps), spins the
 * tunnel, tumbles the letters, and on hide() fades back to black and then lifts the black off the new scene.
 */
export class LoadingScreen {
  private el: HTMLDivElement | null = null;
  private cover!: HTMLDivElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.05, 50);
  private text: THREE.Object3D | null = null;
  private tunnel: THREE.Object3D | null = null;
  private raf = 0;
  private t0 = 0;
  /** fade state: +1 fading in, -1 fading to black, -2 lifting the black, 0 steady */
  private dir = 0;
  private fadeT = 0;
  private shownAt = 0;
  private onDone: (() => void) | null = null;
  private loaded: Promise<boolean> | null = null;

  /** Fetch the model ahead of time (cheap: one small file). */
  preload() {
    this.loaded ??= ready([MODEL]).then(() => {
      const mi = instance(MODEL, () => new THREE.Group());
      const inner = mi.root.children[0];
      if (!inner) return false;
      inner.traverse((o) => {
        // pivot the letters on their own centre (bbox centre -13, -178, 4 in model units)
        if (o.name === 'part0') { this.text = o; (o as THREE.Mesh).geometry?.translate(13, 178, -4); }
        if (o.name === 'part1') this.tunnel = o;
      });
      this.scene.add(mi.root);
      return !!(this.text && this.tunnel);
    }).catch(() => false);
    return this.loaded;
  }

  get visible() { return !!this.el && this.el.style.display !== 'none'; }

  /** Fade in over black. Resolves when fully lit. */
  show() {
    void this.preload();
    this.mount();
    const el = this.el!;
    el.style.display = '';
    this.cover.style.opacity = '1';
    this.cover.style.background = '#000';
    this.dir = 1;
    this.fadeT = performance.now();
    this.shownAt = this.fadeT;
    this.t0 = this.fadeT;
    this.onDone = null;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Fade to black, then off the scene underneath. Waits at least `minMs` from show() so it never just flickers. */
  hide(minMs = 0): Promise<void> {
    if (!this.visible) return Promise.resolve();
    return new Promise((res) => {
      const go = () => {
        if (!this.visible) return res();
        this.dir = -1;
        this.fadeT = performance.now();
        this.onDone = res;
      };
      const left = this.shownAt + minMs - performance.now();
      if (left > 0) setTimeout(go, left); else go();
    });
  }

  /** Drop it at once (leaving the party, errors). */
  cancel() {
    cancelAnimationFrame(this.raf);
    if (this.el) this.el.style.display = 'none';
    this.onDone?.();
    this.onDone = null;
    this.dir = 0;
  }

  private mount() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'loadscr';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Loading');
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    this.cover = document.createElement('div');
    this.cover.className = 'loadscr-cover';
    el.appendChild(this.cover);
    document.body.appendChild(el);
    this.el = el;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setClearColor(0x000000, 1);
    } catch { this.renderer = null; }
  }

  private loop = (now: number) => {
    if (!this.el) return;
    this.raf = requestAnimationFrame(this.loop);
    const steps = Math.floor((now - this.fadeT) / FRAME);
    const lit = FADE[Math.min(FADE.length - 1, steps)];
    if (this.dir === 1) {
      this.cover.style.opacity = String(1 - lit);
      if (lit >= 1) this.dir = 0;
    } else if (this.dir === -1) {
      this.cover.style.opacity = String(lit);
      if (lit >= 1) { this.dir = -2; this.fadeT = now; }
    } else if (this.dir === -2) {
      // the scene under us fades in from black the same way: drop the tunnel, keep a black cover and lift it
      this.el.style.background = 'transparent';
      (this.el.firstElementChild as HTMLElement).style.visibility = 'hidden';
      this.cover.style.opacity = String(1 - lit);
      if (lit >= 1) {
        cancelAnimationFrame(this.raf);
        this.el.style.display = 'none';
        this.el.style.background = '';
        (this.el.firstElementChild as HTMLElement).style.visibility = '';
        this.dir = 0;
        const d = this.onDone; this.onDone = null; d?.();
        return;
      }
    }
    if (this.dir !== -2) this.draw((now - this.t0) / 1000);
  };

  private draw(t: number) {
    const r = this.renderer;
    if (!r || !this.text || !this.tunnel) return;
    const w = innerWidth, h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const c = r.domElement;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { r.setPixelRatio(dpr); r.setSize(w, h, false); }
    // the game is 4:3: keep its vertical view and widen it for wide screens so the tunnel still fills the frame
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 0, CAM_Z);
    this.camera.lookAt(0, 0, -10);
    // the tunnel spins about the view axis; the letters tumble (pitch every ~0.8 s, roll and drift on ~1.1-2.4 s loops),
    // timings read off the emulator capture
    this.tunnel.rotation.z = t * 1.1;
    const k = Math.PI * 2;
    this.text.rotation.set(0.55 * Math.sin((k * t) / 0.8), 0.18 * Math.sin((k * t) / 1.6), 0.26 * Math.sin((k * t) / 2.4));
    this.text.position.set(-13 + 60 * Math.sin((k * t) / 1.07), -178 + 40 * Math.sin((k * t) / 1.9), 4);
    // narrower than 4:3 (phones held upright): shrink the letters so the word stays on screen
    this.text.scale.setScalar(Math.min(1, this.camera.aspect / (4 / 3)));
    r.render(this.scene, this.camera);
  }
}
