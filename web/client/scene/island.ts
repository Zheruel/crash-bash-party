import * as THREE from 'three';
import { getCatalog, ModelInstance } from '../crash';
import { warpTex } from './tex';
import { canvasTex, glowTexture, FONT, strokeText } from './util';

const lambert = (c: number | THREE.Texture) => new THREE.MeshLambertMaterial(typeof c === 'number' ? { color: c } : { map: c });

export function skyTexture(): THREE.CanvasTexture {
  return canvasTex(8, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#2c7be0'); gr.addColorStop(0.45, '#6cc3ff'); gr.addColorStop(0.8, '#ffd9a0'); gr.addColorStop(1, '#ffb27a');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

function grassTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#69c944'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() < 0.5 ? '#5bb83a' : '#7ddb55';
      g.fillRect(Math.random() * w, Math.random() * h, 3 + Math.random() * 4, 3 + Math.random() * 4);
    }
  }, true);
}
function waterTexture() {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#1fa3d8'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#6fd6ff'; g.lineWidth = 4; g.globalAlpha = 0.55;
    for (let i = 0; i < 28; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 14, y - 6, x + 30, y); g.stroke();
      g.beginPath(); g.moveTo(x - w, y); g.quadraticCurveTo(x + 14 - w, y - 6, x + 30 - w, y); g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  return t;
}
function crateTex(kind: 'wood' | 'tnt') {
  return canvasTex(128, 128, (g, w, h) => {
    if (kind === 'wood') {
      g.fillStyle = '#b8742f'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 32) { g.fillStyle = y % 64 ? '#a8642a' : '#c68239'; g.fillRect(0, y, w, 30); g.fillStyle = '#5a3414'; g.fillRect(0, y + 30, w, 2); }
      g.lineWidth = 14; g.strokeStyle = '#6b3d16'; g.strokeRect(7, 7, w - 14, h - 14);
      g.beginPath(); g.moveTo(10, 10); g.lineTo(w - 10, h - 10); g.moveTo(w - 10, 10); g.lineTo(10, h - 10); g.lineWidth = 10; g.stroke();
    } else {
      g.fillStyle = '#d63a2a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#a82418'; for (let y = 0; y < h; y += 32) g.fillRect(0, y + 29, w, 3);
      g.lineWidth = 8; g.strokeStyle = '#3a0c08'; g.strokeRect(5, 5, w - 10, h - 10);
      g.font = `52px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      strokeText(g, 'TNT', 64, 68, '#fff3c0', '#3a0c08', 8);
    }
  }, true);
}

function palm(h = 3.4): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, h, 7), lambert(0x8a5a2a));
  trunk.position.y = h / 2;
  trunk.rotation.z = 0.12;
  g.add(trunk);
  const top = new THREE.Group();
  top.position.set(-0.2, h, 0);
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.4, 4), lambert(i % 2 ? 0x2fa83a : 0x45c24a));
    leaf.scale.z = 0.25;
    const a = (i / 7) * Math.PI * 2;
    const pivot = new THREE.Group();
    pivot.rotation.y = a;
    leaf.position.set(1.0, -0.2, 0);
    leaf.rotation.z = -Math.PI / 2 - 0.35;
    pivot.add(leaf);
    top.add(pivot);
  }
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), lambert(0x6a4020));
    c.position.set(Math.cos(i * 2.1) * 0.3, -0.2, Math.sin(i * 2.1) * 0.3);
    top.add(c);
  }
  g.add(top);
  return g;
}

function rock(s: number) {
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), lambert(0x8d8a96));
  m.scale.y = 0.7;
  return m;
}

export class Backdrop {
  readonly root = new THREE.Group();
  private water!: THREE.Mesh;
  private clouds: THREE.Sprite[] = [];
  /** true when the real warp-room model from the catalog is used */
  usesModel = false;

  constructor() {
    this.root.add(new THREE.HemisphereLight(0xffffff, 0x7a8a6a, 2.1));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
    sun.position.set(-8, 14, 10);
    this.root.add(sun);

    this.water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ map: waterTexture() }));
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -1.2;
    this.root.add(this.water);

    const ref = getCatalog().arenas?.board;
    if (ref) {
      const mi = new ModelInstance(ref);
      if (mi.build()) {
        this.root.add(mi.root);
        this.usesModel = true;
        const box = new THREE.Box3().setFromObject(mi.root);
        const size = box.getSize(new THREE.Vector3());
                this.addFloor((size.x + size.z) / 4, (box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2);
      }
    }
    if (!this.usesModel) this.buildIsland();

    const glow = glowTexture('#ffffff');
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
      s.scale.set(14 + Math.random() * 10, 5 + Math.random() * 3, 1);
      s.position.set(-70 + i * 24 + Math.random() * 10, 22 + Math.random() * 12, -50 - Math.random() * 40);
      this.clouds.push(s);
      this.root.add(s);
    }
  }

  /** The warp-room model has no floor of its own: lay a stone one under the path. */
  private addFloor(r: number, cx: number, cz: number) {
    const real = warpTex('029');
    const tex = canvasTex(64, 64, (g, w, h) => {
      g.imageSmoothingEnabled = false;
      if (real) g.drawImage(real, 0, 0, w, h);
      else { g.fillStyle = '#8a8478'; g.fillRect(0, 0, w, h); }
    }, true);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(r / 1.5, r / 1.5);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.5, 64), [lambert(0x5a554c), lambert(tex), lambert(0x3a362f)]);
    floor.position.set(cx, -0.26, cz);
    this.root.add(floor);
  }

  private buildIsland() {
    const grass = grassTexture();
    grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
    grass.repeat.set(10, 8);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.92, 1.6, 56), [lambert(0x9a6a3a), lambert(grass), lambert(0x6a4423)]);
    top.scale.set(21, 1, 15.5);
    top.position.y = -0.8;
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.9, 1.5, 56), [lambert(0xe9d08a), lambert(0xf3df9e), lambert(0xc9ae6a)]);
    sand.scale.set(23.4, 1, 17.8);
    sand.position.y = -0.85;
    this.root.add(sand, top);

    // decor around the edge and in the middle
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rnd(-0.12, 0.12);
      const r = rnd(0.9, 1.0);
      const p = palm(rnd(3, 4.4));
      p.position.set(Math.cos(a) * 21 * r, 0, Math.sin(a) * 15.5 * r);
      p.rotation.y = rnd(0, 6.28);
      this.root.add(p);
    }
    for (let i = 0; i < 9; i++) {
      const a = rnd(0, 6.28), r = rnd(0.95, 1.12);
      const k = rock(rnd(0.5, 1.2));
      k.position.set(Math.cos(a) * 21 * r, -0.2, Math.sin(a) * 15.5 * r);
      this.root.add(k);
    }
    const crates: [number, number, 'wood' | 'tnt', number][] = [[-3, -2, 'wood', 0], [-1.6, -2.4, 'wood', 0.5], [-2.3, -2.2, 'wood', 0.2], [2.5, 2, 'tnt', 0.3], [3.8, 1.5, 'wood', 0], [-4, 3, 'tnt', 0.8], [1, -3.5, 'wood', 0.4]];
    const tex = { wood: crateTex('wood'), tnt: crateTex('tnt') };
    crates.forEach(([x, z, k, ry], i) => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), new THREE.MeshBasicMaterial({ map: tex[k] }));
      c.position.set(x, 0.65 + (i === 2 ? 1.3 : 0), z);
      c.rotation.y = ry;
      this.root.add(c);
    });
    const mid = palm(4.2);
    mid.position.set(0.5, 0, 0.5);
    this.root.add(mid);
    const mid2 = palm(3.4);
    mid2.position.set(-5.5, 0, -0.5);
    this.root.add(mid2);
  }

  update(t: number) {
    const map = (this.water.material as THREE.MeshBasicMaterial).map!;
    map.offset.set((t * 0.004) % 1, (t * 0.006) % 1);
    this.clouds.forEach((c, i) => {
      c.position.x += 0.01 * (1 + (i % 3) * 0.5);
      if (c.position.x > 90) c.position.x = -90;
    });
  }
}
