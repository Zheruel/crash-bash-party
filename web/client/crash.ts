// Crash Bash asset access for the game client. Everything visual that comes from the disc goes
// through here, driven by assets/catalog.json (see docs/catalog.md). Missing entries -> fallbacks.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Where /assets lives (works under a GitHub Pages sub-path). */
export const ASSET_BASE = (import.meta.env?.BASE_URL ?? '/') + 'assets/';

export interface ModelRef {
  /** model file number, e.g. 776 -> assets/models/0776.gltf */
  model: number;
  /** uniform scale applied after unit conversion (1 = as decoded) */
  scale?: number;
  /** offset applied after scaling, world units */
  offset?: [number, number, number];
  /** yaw in radians so the model faces +z at rest */
  yaw?: number;
  /** animation clip indices by role (idle, run, win, lose, ...) */
  anims?: Record<string, number>;
  /** only show these mesh part names (e.g. ["part0","part3"]) */
  parts?: string[];
}

export interface CharEntry extends ModelRef {
  id: string; // matches shared/look.ts CHARACTERS[].id
  name: string;
  /** height in world units after scale (for camera/labels) */
  height?: number;
  /** optional portrait image path relative to assets/ */
  portrait?: string;
  /** per-minigame model variants of this character: pogo, polarBear, tank (tank = driver bust only) */
  variants?: Record<string, ModelRef>;
}

export interface Catalog {
  characters: CharEntry[];
  /** keyed by MiniGame id (ballDefence, pushOff, tilePainter, tankArena, crateToss, dashRace) and 'board' */
  arenas: Record<string, ModelRef & { extra?: ModelRef[] }>;
  /** crate, ball, tank, wumpa, crystal, trophy, ... */
  props: Record<string, ModelRef>;
  /** music / sfx file references (optional) */
  audio?: Record<string, string>;
}

const EMPTY: Catalog = { characters: [], arenas: {}, props: {} };
let catalog: Catalog = EMPTY;
let catalogP: Promise<Catalog> | null = null;
const cache = new Map<number, Promise<{ scene: THREE.Object3D; anims: THREE.AnimationClip[] } | null>>();
const loader = new GLTFLoader();

/** One stage file per mini-game, owned by whoever tunes that game. Missing files are fine. */
const STAGE_FILES = ['ballDefence', 'pushOff', 'tilePainter', 'tankArena', 'crateToss', 'dashRace', 'ringDing', 'dragonDrop', 'malletMash', 'kegKaboom'];

export function loadCatalog(): Promise<Catalog> {
  catalogP ??= fetch(ASSET_BASE + 'catalog.json')
    .then((r) => (r.ok ? r.json() : EMPTY))
    .catch(() => EMPTY)
    .then(async (c: Catalog) => {
      // per-game stage files (assets/stages/<gameId>.json: { arenas?, props? }) override catalog.json
      const parts = await Promise.all(STAGE_FILES.map((id) => fetch(`${ASSET_BASE}stages/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      const merged: Catalog = { ...EMPTY, ...c, arenas: { ...(c.arenas ?? {}) }, props: { ...(c.props ?? {}) } };
      for (const p of parts) {
        if (!p) continue;
        Object.assign(merged.arenas, p.arenas ?? {});
        Object.assign(merged.props, p.props ?? {});
      }
      return (catalog = merged);
    });
  return catalogP;
}
export const getCatalog = () => catalog;
export const charEntry = (id: string) => catalog.characters.find((c) => c.id === id);

/**
 * PS1-faithful material (unlit). Colour maths happens in "PS1 space": raw 8-bit values as the GPU saw them.
 *  - texture PNGs are raw (NoColorSpace), COLOR_0 is the raw PS1 vertex colour / 255 (0x80 = neutral);
 *  - textured: out = clamp(texel * vc / 128) (x2 modulation, so vc up to 255 over-brightens);
 *    untextured Gouraud: out = vc;
 *  - the result is converted to linear only when the renderer outputs sRGB, so the pixel on screen equals the
 *    PS1 value either way (sRGB output or LinearSRGB pass-through as the asset viewer uses). Blending then
 *    happens on the encoded framebuffer, i.e. in PS1 space too;
 *  - semi-transparent parts (material extras semi_transparent/abr) use the four GPU blend modes.
 */
export function ps1Material(src: THREE.Material): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  const x = (src.userData ?? {}) as { textured?: boolean; semi_transparent?: boolean; abr?: number };
  if (s.map) {
    s.map.colorSpace = THREE.NoColorSpace;
    s.map.magFilter = THREE.NearestFilter;
    s.map.minFilter = THREE.NearestFilter;
    s.map.generateMipmaps = false;
  }
  const m = new THREE.MeshBasicMaterial({ map: s.map ?? null, vertexColors: true, side: THREE.DoubleSide, alphaTest: s.map ? 0.5 : 0 });
  m.name = src.name;
  m.userData = { ...src.userData, hadMap: !!s.map };
  if (x.semi_transparent) {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    switch (x.abr ?? 0) {
      case 1: // B + F
        m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; break;
      case 2: // B - F
        m.blendEquation = THREE.ReverseSubtractEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; break;
      case 3: // B + 0.25 F
        m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.ConstantAlphaFactor; m.blendDst = THREE.OneFactor; m.blendAlpha = 0.25; break;
      default: // 0.5 B + 0.5 F
        m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.ConstantAlphaFactor; m.blendDst = THREE.ConstantAlphaFactor; m.blendAlpha = 0.5;
    }
  }
  // textured without a texture (bit-15 ids past the paired t08, source unknown): treat the texel as mid grey
  m.defines = { PS1_X2: x.textured && s.map ? '(255.0 / 128.0)' : '1.0' };
  m.onBeforeCompile = (sh, renderer) => {
    const srgbOut = renderer.outputColorSpace === THREE.SRGBColorSpace;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n diffuseColor.rgb *= vColor.rgb * PS1_X2;\n#endif')
      .replace('#include <opaque_fragment>', `outgoingLight = clamp( outgoingLight, 0.0, 1.0 );
${srgbOut ? 'outgoingLight = mix( pow( outgoingLight * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), outgoingLight * 0.0773993808, vec3( lessThanEqual( outgoingLight, vec3( 0.04045 ) ) ) );' : ''}
#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'ps1';
  return m;
}

function loadModel(id: number) {
  let p = cache.get(id);
  if (!p) {
    p = loader
      .loadAsync(`${ASSET_BASE}models/${String(id).padStart(4, '0')}.gltf`)
      .then((g) => {
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map(ps1Material) : ps1Material(m.material);
        });
        return { scene: g.scene, anims: g.animations };
      })
      .catch(() => null);
    cache.set(id, p);
  }
  return p;
}

/** A placed model instance. `root` is what you add to the scene; play() switches animation roles. */
export class ModelInstance {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private action: THREE.AnimationAction | null = null;
  private role = '';
  constructor(public ref: ModelRef | null) {}

  /** Fill from cache (must be preloaded) or return false so the caller can show a fallback. */
  build(): boolean {
    const loaded = peeked.get(this.ref?.model ?? -1) ?? null;
    if (!loaded || !this.ref) return false;
    const inner = cloneSkinned(loaded.scene);
    if (this.ref.parts) inner.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.visible = this.ref!.parts!.includes(o.name) || this.ref!.parts!.includes(o.parent?.name ?? ''); });
    const s = this.ref.scale ?? 1;
    inner.scale.multiplyScalar(s);
    if (this.ref.offset) inner.position.set(...this.ref.offset);
    inner.rotation.y = this.ref.yaw ?? 0;
    this.root.add(inner);
    this.clips = loaded.anims;
    if (this.clips.length) this.mixer = new THREE.AnimationMixer(inner);
    return true;
  }

  play(role: string, fade = 0.15) {
    if (!this.mixer || role === this.role) return;
    const idx = this.ref?.anims?.[role];
    const clip = idx != null ? this.clips[idx] : undefined;
    if (!clip) return;
    this.role = role;
    const next = this.mixer.clipAction(clip);
    next.reset().fadeIn(fade).play();
    this.action?.fadeOut(fade);
    this.action = next;
  }

  update(dt: number) {
    this.mixer?.update(dt);
  }
}

// loadModel() resolves into this map so build() can be synchronous after preload().
const peeked = new Map<number, { scene: THREE.Object3D; anims: THREE.AnimationClip[] }>();
async function track(id: number) {
  const v = await loadModel(id);
  if (v) peeked.set(id, v);
  return v;
}

/** Convenience: instance of a catalog ref, or `fallback()` wrapped in a ModelInstance-like group. */
export function instance(ref: ModelRef | undefined, fallback: () => THREE.Object3D): ModelInstance {
  const mi = new ModelInstance(ref ?? null);
  if (!mi.build()) mi.root.add(fallback());
  return mi;
}

/** Preload a set of refs so instance() can build synchronously. */
export async function ready(refs: (ModelRef | undefined)[]): Promise<void> {
  await loadCatalog();
  await Promise.all(refs.filter((r): r is ModelRef => !!r).map((r) => track(r.model)));
}
