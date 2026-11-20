import { Group, Mesh, MeshBasicMaterial, SphereGeometry, type Camera } from 'three';
import { TA_K } from '../../shared/games/tankArena';
import { fxPartTemplate } from './realFx';

// Render nodes of L5–L8 objects 130c..130f and 1302. Parts 34 and 55 face the camera.
const PARTS: Record<number, number[]> = { 11: [32, 34], 8: [46], 9: [55, 47, 47], 10: [21], 2: [6] };
const RAD = Math.PI / 2048;

export function createTankShell(weapon: number, color: string) {
  const root = new Group(), body = new Group();
  root.name = 'tankShell';
  root.add(body);
  let glow: Group | undefined, inner: Group | undefined;
  for (const [i, part] of (PARTS[weapon] ?? []).entries()) {
    const model = fxPartTemplate(weapon === 2 ? 784 : 786, part, TA_K, part === 55);
    if (!model) continue;
    const node = new Group();
    node.add(model.clone(true));
    if (part === 34 || part === 55) {
      root.add(node);
      glow = node;
    } else {
      body.add(node);
      if (weapon === 9 && i === 1) inner = node;
    }
  }
  if (!body.children.length && !glow) body.add(new Mesh(new SphereGeometry(0.14, 8, 6), new MeshBasicMaterial({ color })));
  return {
    root,
    pose(age: number, yaw: number, camera: Camera) {
      const pitch = weapon === 9 ? 380 : weapon === 10 ? 85 : 0;
      const roll = weapon === 9 ? 180 : weapon === 8 ? 150 : 0;
      body.rotation.set(age * pitch * RAD, yaw, -age * roll * RAD, 'YXZ');
      inner?.rotation.set(age * 70 * RAD, -age * 140 * RAD, -age * 210 * RAD, 'YXZ');
      if (glow) {
        glow.quaternion.copy(camera.quaternion);
        glow.rotateZ(-age * (weapon === 11 ? 50 : roll) * RAD);
      }
    },
  };
}
