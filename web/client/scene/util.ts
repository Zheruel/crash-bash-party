import * as THREE from 'three';

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, nearest = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  t.anisotropy = 4;
  return t;
}

export const FONT = '"Luckiest Guy", "Titan One", "Arial Rounded MT Bold", Impact, sans-serif';

export function strokeText(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, stroke = '#1a0f05', lw = 8) {
  g.lineJoin = 'round';
  g.lineWidth = lw;
  g.strokeStyle = stroke;
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
}

/** Name plate sprite (always faces the camera). */
export function labelSprite(text: string, hex: string): THREE.Sprite {
  const tex = canvasTex(512, 128, (g, w, h) => {
    g.font = `64px ${FONT}`;
    const tw = Math.min(w - 40, g.measureText(text).width + 56);
    const x = (w - tw) / 2;
    g.fillStyle = 'rgba(20,12,4,.85)';
    g.beginPath(); g.roundRect(x, 14, tw, h - 28, 30); g.fill();
    g.lineWidth = 8; g.strokeStyle = hex; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(text, w / 2, h / 2 + 3, w - 80);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(3.2, 0.8, 1);
  s.renderOrder = 10;
  return s;
}

const numCache = new Map<number, THREE.CanvasTexture>();
/** Round badge with a number, used for "steps left". */
export function numberSprite(n: number): THREE.Sprite {
  let tex = numCache.get(n);
  if (!tex) {
    tex = canvasTex(128, 128, (g) => {
      g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2);
      g.fillStyle = '#ffd21f'; g.fill();
      g.lineWidth = 10; g.strokeStyle = '#1a0f05'; g.stroke();
      g.font = `70px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#1a0f05';
      g.fillText(String(n), 64, 70);
    });
    numCache.set(n, tex);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.1, 1.1, 1);
  s.renderOrder = 11;
  return s;
}

export function glowTexture(color = '#ffffff'): THREE.CanvasTexture {
  return canvasTex(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, color); r.addColorStop(0.35, color + '99'); r.addColorStop(1, color + '00');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  });
}

export const ease = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
  });
}
