// Title + lobby: characters standing on pads in the real Warp Room, camera slowly orbiting.
import * as THREE from 'three';
import { colorHex, type Look } from '../../shared/look';
import { createCharacter, teamRing } from '../characters';
import type { ModelInstance } from '../crash';
import type { Mode, Stage } from '../view';
import { warpTex } from './tex';
import { canvasTex } from './util';

interface Slot { root: THREE.Group; body: THREE.Group; mi: ModelInstance; key: string; bounce: number }

let padTex: THREE.Texture | null = null;
function padMaterials(hex: string) {
  if (!padTex) {
    const real = warpTex('029');
    padTex = canvasTex(64, 64, (g, w, h) => {
      g.imageSmoothingEnabled = false;
      if (real) g.drawImage(real, 0, 0, w, h); else { g.fillStyle = '#8a8478'; g.fillRect(0, 0, w, h); }
    }, true);
  }
  return [new THREE.MeshLambertMaterial({ color: 0x6f7b88 }), new THREE.MeshLambertMaterial({ map: padTex, color: new THREE.Color(0x9fb4d0) }), new THREE.MeshLambertMaterial({ color: 0x39424d })];
}

export class ShowcaseScene implements Mode {
  readonly root = new THREE.Group();
  /** transparent canvas: the CSS vortex (like the real menus) shows through */
  readonly background = null;
  private lit = false;
  private slots: (Slot | null)[] = [];
  private layout: 'title' | 'lobby' | 'between' | 'champ' = 'lobby';
  /** round winner shown alone in the 'champ' layout */
  private champ = -1;
  private viewX = 0.5;
  private viewY = 0.5;
  private az = 0;

  private ensureBackdrop() {
    if (this.lit) return;
    this.lit = true;
    this.root.add(new THREE.HemisphereLight(0xdfeaff, 0x20404a, 2.3));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(-6, 12, 10);
    this.root.add(sun);
  }

  setLayout(l: 'title' | 'lobby' | 'between', fx = 0.5, fy = 0.5) { this.layout = l; this.viewX = fx; this.viewY = fy; this.place(); }
  /** Round results on a wide screen: the winner alone, big, cheering on the left of the leaderboard. */
  setChamp(slot: number) { this.layout = 'champ'; this.champ = slot; this.place(); this.react(slot); }
  setSpin(_on: boolean) { /* the camera orbits instead */ }

  /** null entries leave the seat empty. */
  setLooks(looks: (Look | null)[]) {
    this.ensureBackdrop();
    looks.forEach((l, i) => {
      const key = l ? `${l.char}.${l.color}` : '';
      const cur = this.slots[i];
      if (cur && cur.key === key) return;
      if (cur) { this.root.remove(cur.root); this.slots[i] = null; }
      if (!l) return;
      const holder = new THREE.Group();
      const body = new THREE.Group();
      const mi = createCharacter(l, { ring: false });
      mi.play('idle');
      body.add(mi.root);
      const hex = colorHex(l);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.3, 24), padMaterials(hex));
      pad.position.y = -0.15;
      holder.add(pad, body);
      this.root.add(holder);
      this.slots[i] = { root: holder, body, mi, key, bounce: 0 };
    });
    for (let i = looks.length; i < this.slots.length; i++) { const s = this.slots[i]; if (s) this.root.remove(s.root); this.slots[i] = null; }
    this.place();
  }

  /** Round over: the winner cheers, everyone else sulks (or all go back to idle with null). */
  react(winner: number | null) {
    this.slots.forEach((s, i) => { if (s) s.mi.play(winner == null ? 'idle' : i === winner ? 'win' : 'lose'); });
    if (winner != null) this.bounce(winner);
  }

  bounce(slot: number) { const s = this.slots[slot]; if (s) s.bounce = 1; }

  private place() {
    this.slots.forEach((s, i) => s && (s.root.visible = this.layout !== 'champ' || i === this.champ));
    if (this.layout === 'champ') { this.slots.forEach((s) => s && s.root.position.set(0, 0, 0)); return; }
    if (this.layout === 'title') { this.slots.forEach((s) => s && s.root.position.set(0, 0, 0)); return; }
    this.slots.forEach((s, i) => s && s.root.position.set((i - 1.5) * 2.6, 0, i % 2 ? -0.3 : 0.3));
  }

  /** World position under a seat (for DOM name tags). */
  footPos(slot: number, out = new THREE.Vector3()) {
    const s = this.slots[slot];
    if (!s) return out.set(0, 0, 0);
    // a point in front of the pad (towards the camera) so the tag sits just below the character
    const dx = Math.sin(this.az), dz = Math.cos(this.az);
    return out.set(s.root.position.x + dx * 1.5, -0.45, s.root.position.z + dz * 1.5);
  }

  enter(stage: Stage) { this.place(); this.frame(stage, 0); }

  frame(stage: Stage, t: number) {
    const cam = stage.camera;
    cam.fov = 36;
    const fov = (cam.fov * Math.PI) / 360;
    if (this.layout === 'title') {
      this.az = t * 0.16;
      const dist = Math.max(6, 2.5 / Math.tan(fov) * (cam.aspect < 1 ? 1.95 : 1));
      cam.position.set(Math.sin(this.az) * dist, 2.0, Math.cos(this.az) * dist);
      cam.lookAt(0, 1.1, 0);
      cam.updateProjectionMatrix();
      const w = innerWidth, h = innerHeight;
      cam.setViewOffset(w, h, (0.5 - this.viewX) * w, (0.5 - this.viewY) * h, w, h);
    } else if (this.layout === 'champ') {
      this.az = Math.sin(t * 0.3) * 0.35;
      const dist = 9.5;
      cam.position.set(Math.sin(this.az) * dist, 2.4, Math.cos(this.az) * dist);
      cam.lookAt(0, 1.5, 0);
      cam.updateProjectionMatrix();
      const w = innerWidth, h = innerHeight;
      cam.setViewOffset(w, h, (0.5 - 0.24) * w, (0.5 - 0.52) * h, w, h);
    } else {
      this.az = Math.sin(t * 0.18) * 0.5;
      const between = this.layout === 'between';
      const halfW = between ? 6.6 : 5.8;
      const dist = Math.max(9, halfW / (Math.tan(fov) * cam.aspect));
      cam.position.set(Math.sin(this.az) * dist, 3.0 + dist * 0.05, Math.cos(this.az) * dist);
      cam.lookAt(0, 1.0, 0);
      cam.updateProjectionMatrix();
      const w = innerWidth, h = innerHeight;
      cam.setViewOffset(w, h, 0, (0.5 - (between ? 0.84 : h < 600 ? 0.4 : innerWidth < 700 ? 0.33 : 0.38)) * h, w, h);
    }
  }

  update(dt: number, t: number, stage: Stage) {
    this.frame(stage, t);
    this.slots.forEach((s, i) => {
      if (!s) return;
      s.bounce = Math.max(0, s.bounce - dt * 2.2);
      s.body.position.y = Math.sin(s.bounce * Math.PI) * 0.7 + 0.02;
      // face the camera (with a little personality)
      const want = this.az + (this.layout !== 'title' ? Math.sin(t * 0.8 + i * 1.7) * 0.18 : 0);
      s.body.rotation.y += (want - s.body.rotation.y) * (1 - Math.exp(-dt * 4));
      s.mi.update(dt);
    });
  }
}
