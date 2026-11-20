import * as THREE from 'three';
import { discRandomState, drawDiscRandom } from '../../shared/physics';
import type { ModelRef } from '../crash';
import { ghostSparkFrames } from './ghostSparks';
import { catalogInstance } from './kit';
import { ownMaterial } from './realFx';

export const knockoutGhostRef = (scale: number): ModelRef => ({ model: 792, scale, parts: ['part0'] });

/** FUN_800898ec swaps the pilot for the common spirit and its camera-facing glow. */
export function makeKnockoutGhost(scale: number, seed: number, socketY: number, floor: number) {
  const ref = knockoutGhostRef(scale);
  const body = catalogInstance(ref);
  const glow = catalogInstance({ ...ref, parts: ['part1'] });
  if (!body || !glow) return;
  const root = new THREE.Group();
  root.name = 'knockout-ghost';
  root.add(body.root, glow.root);
  const random = discRandomState(seed);
  const frames = ghostSparkFrames(socketY, floor, n => drawDiscRandom(random, n));
  const unit = scale / 1024;
  const trails = [0, 1, 2].map(() => {
    const spark = catalogInstance({ ...ref, parts: ['part2'] });
    if (!spark) return;
    const materials: THREE.MeshBasicMaterial[] = [];
    spark.root.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const shade = (source: THREE.Material) => {
        const mat = ownMaterial(source, true);
        materials.push(mat);
        return mat;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(shade) : shade(mesh.material);
      mesh.renderOrder = 6;
    });
    root.add(spark.root);
    return { mesh: spark.root, materials };
  });
  const pose = (x: number, y: number, z: number, age: number, camera: THREE.Camera) => {
    const rise = age * 24 - socketY;
    root.visible = age >= 0 && rise < 2560 + 24;
    if (!root.visible) return;
    root.position.set(x, y + rise * unit, z);
    body.nativePose(0x4000 + Math.min(age, frames.length - 1) % 20);
    glow.root.quaternion.copy(camera.quaternion);
    for (const [i, trail] of trails.entries()) {
      if (!trail) continue;
      const sample = frames[age]?.[i];
      trail.mesh.visible = !!sample;
      if (!sample) continue;
      trail.mesh.quaternion.copy(camera.quaternion);
      trail.mesh.position.set(sample.x * unit, (-sample.y - rise) * unit, -sample.z * unit);
      for (const mat of trail.materials) mat.color.setScalar(1 - sample.fade / 4096);
    }
  };
  const dispose = () => { for (const trail of trails) trail?.materials.forEach(m => m.dispose()); };
  return { root, pose, dispose };
}
