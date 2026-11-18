import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ASSET_BASE } from './crash';

export interface AssetRequest {
  /** glTF/GLB paths relative to /assets, e.g. 'models/arena_ball_defence.glb' */
  models?: string[];
  /** PNG paths relative to /assets, e.g. 'textures/ice.png' */
  textures?: string[];
}

/**
 * Where game art comes from. Mini-game views ask for an asset by path and give a
 * placeholder factory; if the file is missing the placeholder is used.
 */
export interface AssetSource {
  preload(req: AssetRequest): Promise<void>;
  /** A fresh clone of the model at `path`, or `fallback()` if unavailable. */
  model(path: string, fallback: () => THREE.Object3D): THREE.Object3D;
  /** The texture at `path`, or null if unavailable. */
  texture(path: string): THREE.Texture | null;
  has(path: string): boolean;
}

/** Loads from `/assets/...` (served from the repo's assets/ folder). Missing files resolve to placeholders. */
export class HttpAssetSource implements AssetSource {
  private models = new Map<string, THREE.Object3D | null>();
  private textures = new Map<string, THREE.Texture | null>();
  private gltf = new GLTFLoader();
  private tex = new THREE.TextureLoader();

  constructor(private base = ASSET_BASE) {}

  async preload(req: AssetRequest): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const p of req.models ?? []) {
      if (this.models.has(p)) continue;
      jobs.push(
        this.gltf.loadAsync(this.base + p).then((g) => void this.models.set(p, g.scene), () => void this.models.set(p, null)),
      );
    }
    for (const p of req.textures ?? []) {
      if (this.textures.has(p)) continue;
      jobs.push(
        this.tex.loadAsync(this.base + p).then(
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.magFilter = THREE.NearestFilter; // crisp PS1-style texels
            this.textures.set(p, t);
          },
          () => void this.textures.set(p, null),
        ),
      );
    }
    await Promise.all(jobs);
  }

  model(path: string, fallback: () => THREE.Object3D): THREE.Object3D {
    const m = this.models.get(path);
    return m ? cloneSkinned(m) : fallback();
  }
  texture(path: string) {
    return this.textures.get(path) ?? null;
  }
  has(path: string) {
    return !!this.models.get(path) || !!this.textures.get(path);
  }
}
