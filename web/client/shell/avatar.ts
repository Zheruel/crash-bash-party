// Character helpers: portraits rendered from the 3D models (cached), plus a fallback letter badge.
import * as THREE from 'three';
import { CHARACTERS, type Look } from '../../shared/look';
import { createCharacter } from '../characters';
import { getCatalog, ModelInstance } from '../crash';
import { ASSET_BASE } from '../crash';

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<number, string>();
const SIZE = 160;

export function initPortraits(r: THREE.WebGLRenderer) { renderer = r; cache.clear(); }
export function resetPortraits() { cache.clear(); faceCache.clear(); iconCache.clear(); }

/** Data URL of the character's head and shoulders (transparent PNG), or '' if it can't be rendered. */
export function portrait(char: number): string {
  const key = ((char % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
  const character = CHARACTERS[key];
  if ('portrait' in character) return ASSET_BASE + character.portrait;
  const hit = cache.get(key);
  if (hit != null) return hit;
  let url = '';
  try { url = render(key); } catch (e) { console.warn('portrait failed', e); }
  // keep failures uncached only until models load; cache real ones
  if (url) cache.set(key, url);
  return url;
}

function render(char: number, face = false): string {
  const mi = createCharacter({ char, color: 0 }, { ring: false });
  mi.play('idle');
  mi.update(0.05);
  return shot(mi.root, face ? 'face' : 'bust');
}

const faceCache = new Map<number, string>();
/** Tight head shot (like the character-select icons), transparent PNG, rendered from the real 3D model. */
export function faceShot(char: number): string {
  const key = ((char % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
  const character = CHARACTERS[key];
  if ('portrait' in character) return ASSET_BASE + character.portrait;
  const hit = faceCache.get(key);
  if (hit != null) return hit;
  let url = '';
  try { url = render(key, true); } catch (e) { console.warn('face failed', e); }
  if (url) faceCache.set(key, url);
  return url;
}

const iconCache = new Map<string, string>();
/** Icon rendered from a catalog prop model (e.g. 'wumpa', 'crystal'); '' when the catalog has no such prop. */
export function propIcon(name: string): string {
  const hit = iconCache.get(name);
  if (hit != null) return hit;
  let url = '';
  const ref = getCatalog().props?.[name];
  if (ref) {
    try {
      const mi = new ModelInstance(ref);
      if (mi.build()) url = shot(mi.root, 'prop');
    } catch (e) { console.warn('icon failed', name, e); }
  }
  if (url) iconCache.set(name, url);
  return url;
}

type ShotKind = 'bust' | 'face' | 'prop';
function shot(model: THREE.Object3D, kind: ShotKind): string {
  const head = kind !== 'prop', face = kind === 'face';
  const r = renderer;
  if (!r) return '';
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  scene.add(model);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  if (!isFinite(size.y) || size.y <= 0) return '';
  const top = box.max.y, h = size.y;
  const regionH = face ? h * 0.37 : head ? h * 0.5 : Math.max(h, size.x, size.z);
  const cy = face ? top - regionH * 0.6 : head ? top - regionH * 0.52 : (box.min.y + box.max.y) / 2;
  const cx = (box.min.x + box.max.x) / 2;
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const dist = (Math.max(regionH, head ? size.x * (face ? 0.5 : 0.75) : 0) * 0.5) / Math.tan((28 * Math.PI) / 360) * 1.12;
  cam.position.set(cx + dist * 0.18, cy + dist * 0.1, (box.min.z + box.max.z) / 2 + dist);
  cam.lookAt(cx, cy, (box.min.z + box.max.z) / 2);

  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const prevRT = r.getRenderTarget();
  const prevAlpha = r.getClearAlpha();
  const prevColor = new THREE.Color();
  r.getClearColor(prevColor);
  r.setRenderTarget(rt);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.render(scene, cam);
  const buf = new Uint8Array(SIZE * SIZE * 4);
  r.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
  r.setRenderTarget(prevRT);
  r.setClearColor(prevColor, prevAlpha);
  rt.dispose();

  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) img.data.set(buf.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
  g.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

export function avatarHtml(look: Look, cls = ''): string {
  const url = faceShot(look.char) || portrait(look.char);
  const c = CHARACTERS[look.char % CHARACTERS.length];
  return url ? `<img class="av ${cls}" src="${url}" alt="${c.name}">` : `<span class="av fb ${cls}">${c.name[0]}</span>`;
}
