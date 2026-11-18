// Small shared helpers for the Ring Ding / Dragon Drop / Mallet Mash / Keg Kaboom views.
import * as THREE from 'three';
import type { ModelRef } from '../crash';
import { canvasTexture, catalogInstance, fitObject } from './kit';

/**
 * The purple "?" special crate of the disc (power-up crate). Lives in the Mallet Mash / Keg Kaboom file groups
 * (t29 0569 / 0583, identical to 0355 / 0333 elsewhere). Models 0569 / 0583 are the same mesh; 0569 is used here.
 */
export const SPECIAL_CRATE_REF: ModelRef = { model: 569 };

/** Procedural stand-in for the special crate. */
function proceduralCrate(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const tex = canvasTexture(128, (c, s) => {
    c.fillStyle = '#8a3fd6'; c.fillRect(0, 0, s, s);
    c.strokeStyle = '#4b1f86'; c.lineWidth = s * 0.1; c.strokeRect(s * 0.05, s * 0.05, s * 0.9, s * 0.9);
    c.fillStyle = '#ffe14a'; c.font = `900 ${s * 0.7}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('?', s / 2, s * 0.56);
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
  m.position.y = size / 2;
  g.add(m);
  return g;
}

export function specialCrate(size = 1.3): THREE.Object3D {
  const inst = catalogInstance(SPECIAL_CRATE_REF);
  return inst ? fitObject(inst.root, size) : proceduralCrate(size);
}

/** Flat pie slice in the XZ plane, angles measured so that (cos a, sin a) = (x, z). */
export function wedgeGeometry(r0: number, r1: number, a0: number, a1: number, segs = 24): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pos.push(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * r1, 0, Math.sin(a) * r1);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // up-facing regardless of winding: draw double sided where used
  return g;
}

/** Faceted jewel (octahedron) with a glossy emissive material. */
export function makeJewel(color: THREE.ColorRepresentation, size = 0.5): THREE.Object3D {
  const g = new THREE.Group();
  const col = new THREE.Color(color);
  const m = new THREE.Mesh(
    new THREE.OctahedronGeometry(size, 0),
    new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0.2, flatShading: true }),
  );
  m.scale.set(0.8, 1.15, 0.8);
  m.name = 'spin';
  m.position.y = size * 1.15;
  g.add(m);
  return g;
}

/** Floor-aligned camera-facing bar (for powder / charge gauges). */
export class Bar3D {
  readonly group = new THREE.Group();
  private fill: THREE.Mesh;
  constructor(public w = 1.5, public h = 0.17, color: THREE.ColorRepresentation = 0xffffff) {
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.1, h + 0.1), new THREE.MeshBasicMaterial({ color: 0x120a1c, transparent: true, opacity: 0.8, depthTest: false }));
    this.fill = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    this.fill.position.z = 0.001;
    back.renderOrder = 42; this.fill.renderOrder = 43;
    this.group.add(back, this.fill);
  }
  set(frac: number, color?: THREE.ColorRepresentation) {
    const f = Math.max(0.0001, Math.min(1, frac));
    this.fill.scale.x = f;
    this.fill.position.x = -(this.w * (1 - f)) / 2;
    if (color !== undefined) (this.fill.material as THREE.MeshBasicMaterial).color.set(color);
  }
  face(camera: THREE.Camera) { this.group.quaternion.copy(camera.quaternion); }
}

/** Radial gradient glow sprite texture (shared per call site). */
export function glowTexture(inner = 'rgba(255,255,255,0.9)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }, undefined, false);
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
