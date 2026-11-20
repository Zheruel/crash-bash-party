import * as THREE from 'three';
import { U } from '../../shared/games/pushOff';
import type { ModelInstance, ModelRef } from '../crash';
import { catalogInstance } from './kit';
import { polarReflectionPose } from './playerPose';

export const POLAR_REFLECTION: ModelRef = { model: 484, scale: U * 1024, parts: ['part0'] };

export function bearReflectionWord(script: number, ch: number, frame: number, winning: boolean) {
  if (winning && script !== 0x46) return ch === 3 ? 0x4000 : 0x4180;
  const mapped = polarReflectionPose(script, ch, frame);
  if (mapped !== undefined) return mapped;
  if (script === 0x3a) return 0x4000 + frame % 20;
  if (script === 0x3b) return 0x4100 + frame % 16;
  return 0x4000;
}

/** The disc draws pack 0484 below the ice with additive blending and an ordering-table bias.
 * Test its depth at the ice surface so the opaque floor allows the reflection and a foreground rider occludes it. */
export class PolarReflections {
  private normal = { value: new THREE.Vector3(0, 1, 0) };
  private materials = new Map<THREE.Material, THREE.Material>();
  private bears = Array.from({ length: 4 }, () => catalogInstance(POLAR_REFLECTION));
  private snowballs: (ModelInstance | null)[];

  constructor(private platform: THREE.Group, snowball?: ModelRef) {
    this.snowballs = snowball ? Array.from({ length: 4 }, () => catalogInstance(snowball)) : [];
    for (const instance of [...this.bears, ...this.snowballs]) {
      if (!instance) continue;
      instance.root.traverseVisible(obj => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => this.iceMaterial(m)) : this.iceMaterial(mesh.material);
      });
      instance.root.visible = false;
      platform.add(instance.root);
    }
  }

  private iceMaterial(source: THREE.Material) {
    let material = this.materials.get(source);
    if (material) return material;
    material = source.clone();
    const compile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(source, shader, renderer);
      shader.uniforms.iceNormal = this.normal;
      shader.vertexShader = 'uniform vec3 iceNormal;\n' + shader.vertexShader.replace('#include <logdepthbuf_vertex>', `
        vec3 normalView = mat3(viewMatrix) * iceNormal;
        float incidence = dot(normalView, mvPosition.xyz);
        if (abs(incidence) > 0.00001) {
          float hit = dot(normalView, viewMatrix[3].xyz) / incidence;
          if (hit > 0.0) {
            vec4 ice = projectionMatrix * vec4(mvPosition.xyz * hit, 1.0);
            gl_Position.z = (ice.z / ice.w - 0.00001) * gl_Position.w;
          }
        }
        #include <logdepthbuf_vertex>`);
    };
    material.customProgramCacheKey = () => source.customProgramCacheKey() + '-polar-ice';
    this.materials.set(source, material);
    return material;
  }

  render(slot: number, visible: boolean, snow: boolean, x: number, y: number, z: number, face: number, scale: number, word: number) {
    const bear = this.bears[slot], ball = this.snowballs[slot];
    if (bear) bear.root.visible = visible && !snow;
    if (ball) ball.root.visible = visible && snow;
    const inst = snow ? ball : bear;
    if (!visible || !inst) return;
    this.normal.value.set(0, 1, 0).applyQuaternion(this.platform.quaternion);
    inst.root.position.set(x, y - (snow ? 0x298 * U : 0), z);
    inst.root.rotation.y = face;
    inst.root.scale.setScalar(scale);
    inst.nativePose(snow ? 0x2003 : word);
  }

  dispose() {
    for (const inst of [...this.bears, ...this.snowballs]) inst?.root.removeFromParent();
    for (const material of this.materials.values()) material.dispose();
  }
}
