// Character selection, party seats and between-round celebrations.
import * as THREE from 'three';
import { CHARACTERS, type Look } from '../../shared/look';
import { createCharacter } from '../characters';
import { ModelInstance } from '../crash';
import type { Mode, Stage } from '../view';

interface Slot { root: THREE.Group; body: THREE.Group; mi: ModelInstance; key: string; bounce: number }

// Title pack 0131: four steel pads with baked yellow, pink, green and red rims.
const padParts = ['part1', 'part2', 'part3', 'part4'];
const pedestals: THREE.Group[] = [];
function characterPedestal(slot: number) {
  if (!pedestals.length) {
    const model = new ModelInstance({ model: 131, parts: padParts, scale: 3 });
    if (model.build()) for (const name of padParts) {
      const group = new THREE.Group();
      const part = model.root.getObjectByName(name);
      if (part) group.attach(part);
      pedestals.push(group);
    }
  }
  return pedestals[slot]?.clone() ?? new THREE.Group();
}

// Groups 4–11 in the same pack are the eight character-select idle animations.
const selectPart: Record<string, number> = { coco: 14, crash: 15, cortex: 16, brio: 17, dingodile: 18, koala: 19, tiny: 20, rilla: 21 };
function showcaseCharacter(look: Look, selecting: boolean) {
  const part = selectPart[CHARACTERS[look.char].id];
  if (selecting && part) {
    const model = new ModelInstance({ model: 131, parts: [`part${part}`], scale: 3, anims: { idle: part - 10 } });
    if (model.build()) return model;
  }
  return createCharacter(look, { ring: false });
}

export class ShowcaseScene implements Mode {
  readonly root = new THREE.Group();
  /** transparent canvas: the CSS vortex (like the real menus) shows through */
  readonly background = null;
  private lit = false;
  private slots: (Slot | null)[] = [];
  private looks: (Look | null)[] = [];
  private layout: 'title' | 'lobby' | 'between' | 'champ' = 'lobby';
  /** round winner shown alone in the 'champ' layout */
  private champ = -1;
  private viewX = 0.5;
  private viewY = 0.5;
  private az = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  private ensureBackdrop() {
    if (this.lit) return;
    this.lit = true;
    this.root.add(new THREE.HemisphereLight(0xdfeaff, 0x20404a, 2.3));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(-6, 12, 10);
    this.root.add(sun);
  }

  setLayout(l: 'title' | 'lobby' | 'between', fx = 0.5, fy = 0.5) { this.layout = l; this.viewX = fx; this.viewY = fy; this.setLooks(this.looks); }
  /** Round results on a wide screen: the winner alone, big, cheering on the left of the leaderboard. */
  setChamp(slot: number) { this.layout = 'champ'; this.champ = slot; this.setLooks(this.looks); this.react(slot); }
  setSpin(_on: boolean) { /* the camera orbits instead */ }

  /** null entries leave the seat empty. */
  setLooks(looks: (Look | null)[], refresh = false) {
    this.ensureBackdrop();
    this.looks = looks;
    const selecting = this.layout === 'title' || this.layout === 'lobby';
    looks.forEach((l, i) => {
      const key = l ? `${l.char}.${l.color}.${selecting}` : '';
      const cur = this.slots[i];
      if (!refresh && cur && cur.key === key) return;
      if (cur) { this.root.remove(cur.root); this.slots[i] = null; }
      if (!l) return;
      const holder = new THREE.Group();
      const body = new THREE.Group();
      const mi = showcaseCharacter(l, selecting);
      mi.play('idle');
      body.add(mi.root);
      holder.add(characterPedestal(i), body);
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

  enter(stage: Stage) { this.place(); this.frame(stage, 0); }

  frame(stage: Stage, t: number) {
    if (this.reducedMotion.matches) t = 0;
    const cam = stage.camera;
    cam.fov = 36;
    const fov = (cam.fov * Math.PI) / 360;
    if (this.layout === 'title') {
      this.az = Math.sin(t * 0.16) * 0.35;
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
      this.az = Math.sin(t * 0.18) * 0.08;
      const between = this.layout === 'between';
      const halfW = between ? 6.6 : 5.8;
      const dist = Math.max(9, halfW / (Math.tan(fov) * cam.aspect));
      cam.position.set(Math.sin(this.az) * dist, 3.0 + dist * 0.05, Math.cos(this.az) * dist);
      cam.lookAt(0, 1.0, 0);
      cam.updateProjectionMatrix();
      const w = innerWidth, h = innerHeight;
      cam.setViewOffset(w, h, 0, (0.5 - (between ? 0.84 : h < 600 ? 0.4 : innerWidth < 700 ? 0.49 : 0.38)) * h, w, h);
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
