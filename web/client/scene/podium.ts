// Final scene: a podium with the four characters; blocks rise one rank at a time.
import * as THREE from 'three';
import { colorHex, type Look } from '../../shared/look';
import { createCharacter, teamRing } from '../characters';
import { getCatalog, instance, type ModelInstance } from '../crash';
import type { Mode, Stage } from '../view';
import { canvasTex, clamp01, ease, FONT, glowTexture, labelSprite, strokeText } from './util';

const HEIGHTS = [2.2, 1.5, 1.0, 0.5]; // by rank
const XS = [0, -2.9, 2.9, 5.8]; // by rank: 1st centre, 2nd left, 3rd right, 4th far right
const FACE = ['#ffd21f', '#d6dde6', '#d88a4a', '#a8743c'];

interface Entry {
  rank: number;
  slot: number;
  block: THREE.Mesh;
  holder: THREE.Group;
  mi: ModelInstance;
  label: THREE.Sprite;
  t: number;
  revealed: boolean;
  win: boolean;
  lose: boolean;
  celebrate: number;
}

function sky() {
  return canvasTex(8, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#2a0f55'); gr.addColorStop(0.55, '#b3306a'); gr.addColorStop(1, '#ff9a3c');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

export class PodiumScene implements Mode {
  readonly root = new THREE.Group();
  readonly background = sky();
  private entries: Entry[] = [];
  private rays: THREE.Mesh[] = [];
  private lights = new THREE.Group();
  private time = 0;

  constructor() {
    this.root.add(new THREE.HemisphereLight(0xffffff, 0x7a5a8a, 2.2));
    const sun = new THREE.DirectionalLight(0xfff0d0, 2);
    sun.position.set(2, 8, 8);
    this.root.add(sun);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(11, 11.4, 0.4, 48), new THREE.MeshLambertMaterial({ color: 0x3a1a5a }));
    floor.position.y = -0.2;
    this.root.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(10.8, 0.14, 6, 64).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd21f }));
    this.root.add(ring);
    const ref = getCatalog().props?.podium;
    if (ref) {
      const mi = instance(ref, () => new THREE.Group());
      mi.root.position.z = -4;
      this.root.add(mi.root);
    }
    // stage lights
    const glow = glowTexture('#fff0b0');
    for (let i = 0; i < 4; i++) {
      const beam = new THREE.Mesh(new THREE.ConeGeometry(2.2, 14, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.position.set(XS[i], 7, 0);
      this.rays.push(beam);
      this.lights.add(beam);
    }
    void glow;
    this.root.add(this.lights);
  }

  /** order = slots best-first. */
  setup(order: number[], looks: Look[], names: string[]) {
    for (const e of this.entries) this.root.remove(e.holder, e.block);
    this.entries = order.map((slot, rank) => {
      const h = HEIGHTS[rank];
      const tex = canvasTex(128, 128, (g, w, hh) => {
        g.fillStyle = FACE[rank]; g.fillRect(0, 0, w, hh);
        g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, hh - 16, w, 16);
        g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.35)'; g.strokeRect(4, 4, w - 8, hh - 8);
        g.font = `84px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        strokeText(g, String(rank + 1), 64, 64, '#fff', '#2a1608', 9);
      }, true);
      const plain = new THREE.MeshLambertMaterial({ color: FACE[rank] });
      const block = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1, 2.2), [plain, plain, new THREE.MeshLambertMaterial({ color: FACE[rank] }), plain, new THREE.MeshBasicMaterial({ map: tex }), plain]);
      block.position.set(XS[rank], 0, 0);
      block.scale.y = 0.001;
      const holder = new THREE.Group();
      const mi = createCharacter(looks[slot], { ring: false });
      mi.play('idle');
      holder.add(mi.root, teamRing(colorHex(looks[slot]), 0.8));
      holder.position.set(XS[rank], 0, 0);
      holder.visible = false;
      const label = labelSprite(names[slot] ?? '', colorHex(looks[slot]));
      label.position.set(0, 3.3, 0);
      holder.add(label);
      void h;
      this.root.add(block, holder);
      return { rank, slot, block, holder, mi, label, t: 0, revealed: false, win: false, lose: false, celebrate: 0 };
    });
  }

  reveal(rank: number) {
    const e = this.entries.find((x) => x.rank === rank);
    if (e) { e.revealed = true; e.t = 0; e.holder.visible = true; }
  }
  revealed(rank: number) { return !!this.entries.find((x) => x.rank === rank)?.revealed; }

  celebrate(winners: number[]) {
    for (const e of this.entries) {
      if (winners.includes(e.slot)) { e.win = true; e.mi.play('win'); } else { e.lose = true; e.mi.play('lose'); }
      e.celebrate = 0;
    }
    this.rays.forEach((r, i) => { const w = this.entries.find((e) => e.rank === i); (r.material as THREE.MeshBasicMaterial).opacity = w?.win ? 0.18 : 0.0; });
  }

  /** World point above a slot's head, for UI anchors. */
  headOf(slot: number, out = new THREE.Vector3()) {
    const e = this.entries.find((x) => x.slot === slot);
    return e ? out.set(XS[e.rank], HEIGHTS[e.rank] + 3, 0) : out.set(0, 3, 0);
  }

  enter() { this.time = 0; }

  update(dt: number, t: number, stage: Stage) {
    this.time += dt;
    const cam = stage.camera;
    const fov = (cam.fov * Math.PI) / 360;
    const dist = Math.max(14, 9.6 / (Math.tan(fov) * cam.aspect));
    cam.position.set(Math.sin(t * 0.25) * 1.2, 4.6 + dist * 0.08, dist);
    cam.lookAt(1.2, 1.9, 0);
    for (const e of this.entries) {
      e.t += dt;
      const h = HEIGHTS[e.rank];
      const k = e.revealed ? clamp01(e.t / 0.5) : 0;
      e.block.visible = e.revealed;
      e.block.scale.y = Math.max(0.001, h * ease.back(k));
      e.block.position.y = (h * ease.back(k)) / 2;
      let y = h * ease.out(k);
      if (e.revealed) {
        const drop = clamp01(e.t / 0.6);
        y = h + (1 - ease.out(drop)) * 5;
      }
      if (e.win) { e.celebrate += dt; y += Math.abs(Math.sin(e.celebrate * 5)) * 0.9; }
      else if (e.lose) { e.celebrate += dt; }
      e.holder.position.y = y;
      e.holder.rotation.y = e.win ? Math.sin(e.celebrate * 3) * 0.4 : Math.sin(t + e.rank) * 0.1;
      e.mi.update(dt);
    }
    this.rays.forEach((r, i) => { r.rotation.z = Math.sin(t * 0.7 + i) * 0.12; });
  }
}
