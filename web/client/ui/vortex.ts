import * as THREE from 'three';
import { instance, ready } from '../crash';

/**
 * The menu backdrop: the game's own vortex tunnel (model 0311 part1, the LOADING screen's tunnel) slowly turning behind
 * the title and lobby. Draws into #vortex over the CSS swirl, which stays as the fallback (no WebGL, reduced motion).
 * Only runs while a menu screen is up and the tab is visible, at 30 fps like the game.
 */
export class VortexBackdrop {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50);
  private tunnel: THREE.Object3D | null = null;
  private raf = 0;
  private last = 0;
  private t = 0;
  private on = false;

  constructor(private host: HTMLElement) {
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    void ready([{ model: 311 }]).then(() => {
      const mi = instance({ model: 311, parts: ['part1'] }, () => new THREE.Group());
      mi.root.traverse((o) => { if (o.name === 'part1') this.tunnel = o; });
      if (!this.tunnel) return;
      this.scene.add(mi.root);
      const canvas = document.createElement('canvas');
      canvas.className = 'vortex3d';
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      } catch { return; }
      this.host.appendChild(canvas);
      if (this.on) this.start();
    }).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else if (this.on) this.start(); });
  }

  /** Run while the menus show; stop under a mini-game. */
  set active(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    if (v) this.start(); else this.stop();
  }

  private start() {
    if (!this.renderer || this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }
  private stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (now - this.last < 1000 / 31) return;
    this.t += Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const r = this.renderer!, w = innerWidth, h = innerHeight;
    // the backdrop is blurred by design: render at half resolution and let the browser smooth it
    const pr = 0.5;
    const c = r.domElement;
    if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) { r.setPixelRatio(pr); r.setSize(w, h, false); }
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, -10);
    // slower than the LOADING screen: a backdrop, not a transition
    this.tunnel!.rotation.z = this.t * 0.35;
    r.render(this.scene, this.camera);
  };
}
