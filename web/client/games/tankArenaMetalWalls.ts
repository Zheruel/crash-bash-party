import * as THREE from 'three';
import { TA_K, taWorld } from '../../shared/games/tankArena';
import { metalWallPulse, type MetalWall, type MetalWalls } from '../../shared/games/tankArenaMetalWalls';
import type { ModelInstance, ModelRef } from '../crash';
import { catalogInstance, disposeTree, makeCrate } from './kit';

interface WallVisual {
  root: THREE.Group;
  platform: THREE.Object3D;
  pulse: ModelInstance | null;
}

const U = TA_K / 1024;

export class MetalWallView {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, WallVisual>();

  constructor(parent: THREE.Group) {
    this.root.name = 'metal-fox-walls';
    parent.add(this.root);
  }

  private create(wall: MetalWall, ref: ModelRef | undefined): WallVisual {
    // Both actors use the L8 stage pack. The extracted meshes already face level space.
    const platform = catalogInstance(ref && { model: ref.model, scale: ref.scale, parts: [`part${wall.part}`] })?.root
      ?? makeCrate(TA_K / 2, 'steel');
    if (!platform.userData.shared) platform.scale.y = 183 / 512;
    const pulse = catalogInstance(ref && { model: ref.model, scale: ref.scale, parts: ['part34'] });
    const root = new THREE.Group();
    const [x, z] = taWorld('metal', wall.x, wall.z);
    root.position.set(x, 0, z);
    root.name = `metal-wall-${wall.x >> 9}-${wall.z >> 9}`;
    root.add(platform);
    if (pulse) {
      pulse.root.position.y = 2 * U; // Keep the coplanar pulse above the stage floor.
      root.add(pulse.root);
    }
    this.root.add(root);
    return { root, platform, pulse };
  }

  render(map: MetalWalls, tick: number, ref: ModelRef | undefined) {
    const seen = new Set<string>();
    for (const wall of map.walls) {
      const key = `${wall.born}:${wall.x}:${wall.z}`;
      seen.add(key);
      let visual = this.visuals.get(key);
      if (!visual) {
        visual = this.create(wall, ref);
        this.visuals.set(key, visual);
      }
      visual.platform.position.y = -wall.y * U;
      visual.platform.visible = wall.phase !== 'waiting' && wall.phase !== 'cleared';
      if (visual.pulse) {
        const frame = metalWallPulse(wall, tick);
        visual.pulse.root.visible = frame !== undefined;
        if (frame !== undefined) visual.pulse.nativePose(0x4000 + frame);
      }
    }
    for (const [key, visual] of this.visuals) {
      if (seen.has(key)) continue;
      this.root.remove(visual.root);
      disposeTree(visual.root);
      this.visuals.delete(key);
    }
  }

  dispose() {
    this.root.removeFromParent();
    disposeTree(this.root);
    this.visuals.clear();
  }
}
