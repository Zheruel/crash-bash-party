// USA Polar Push objects 0x1601/0x160a and their 0x1605 scripts (re/notes/polarPush.md).
import * as THREE from 'three';
import { MASK_HEIGHT, polarEmitterIntro, U, type PolarEmitterPose } from '../../shared/games/pushOff';
import type { Body, GameEvent } from '../../shared/types';
import { ModelInstance, ready } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { FX_PACKS } from './fxScripts';
import { RealFx, type FxTrack } from './realFx';

const S = 1024 * U;
const ANGLE = Math.PI / 2048;
const FLOOR = -94 * U;
const VARIANTS = {
  tilt: { model: 486, beam: 1, halo: 1, target: 2, pickup: 3, bank: '0450' },
  polar: { model: 478, beam: 0, halo: 4, target: 3, pickup: 3, bank: '0451' },
  melt: { model: 474, beam: 0, halo: null, target: 3, pickup: null, bank: '0448' },
  manic: { model: 466, beam: 0, halo: 4, target: 3, pickup: 2, bank: '0447' },
} as const;

const cueFiles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19].map(sample => `sfx/0447/${sample}.mp3`);
export function preloadPolarItemEmitter() {
  [...cueFiles, 'sfx/0448/20.mp3', 'sfx/0448/21.mp3'].forEach(file => sfx.preloadFile(file));
  return ready([403, ...Object.values(VARIANTS).map(v => v.model)].map(model => ({ model })));
}

function mesh(model: number, part: number): THREE.Group {
  const inst = new ModelInstance({ model, scale: S, parts: [`part${part}`] });
  inst.build();
  const hidden: THREE.Object3D[] = [];
  inst.root.traverse(o => { if ((o as THREE.Mesh).isMesh && !o.visible) hidden.push(o); });
  for (const o of hidden) o.removeFromParent();
  inst.root.userData.shared = true;
  return inst.root;
}

/** The script darkens the disc's additive vertex colours, and its position stays in PS1 space. */
class EmitterTrack {
  readonly obj: THREE.Group;
  private mats: THREE.MeshBasicMaterial[] = [];

  constructor(parent: THREE.Group, model: number, private track: FxTrack, order: number, floor = false) {
    this.obj = mesh(model, track.part!);
    this.obj.visible = false;
    this.obj.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const own = (mat: THREE.Material) => {
        const copy = mat.clone() as THREE.MeshBasicMaterial;
        if (floor) {
          // Replicate the floor effect's priority over the ice while keeping its projected position.
          // Keep depth testing against the opaque scene.
          const compile = copy.onBeforeCompile, bias = (0x200 * U).toFixed(3);
          copy.onBeforeCompile = (shader, renderer) => {
            compile.call(copy, shader, renderer);
            shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
              gl_Position.z += projectionMatrix[3][2] * ${bias} / max(0.01, gl_Position.w - ${bias});`);
          };
          copy.customProgramCacheKey = () => `${mat.customProgramCacheKey()}-polar-target`;
        }
        this.mats.push(copy);
        return copy;
      };
      m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
      m.renderOrder = order;
    });
    parent.add(this.obj);
  }

  show(age: number, x: number, y: number, z: number) {
    const keys = this.track.keys!;
    this.obj.visible = age >= 0 && age <= keys[keys.length - 1][0];
    if (!this.obj.visible) return;
    let i = 0;
    while (i < keys.length - 2 && age >= keys[i + 1][0]) i++;
    const a = keys[i], b = keys[i + 1];
    const f = (age - a[0]) / (b[0] - a[0]);
    const lerp = (j: number) => a[j] + (b[j] - a[j]) * f;
    this.obj.position.set(x + lerp(1) * U, y - lerp(2) * U, z - lerp(3) * U);
    this.obj.rotation.set(lerp(4) * ANGLE, -lerp(5) * ANGLE, -lerp(6) * ANGLE, 'ZYX');
    this.obj.scale.set(lerp(7) / 4096, lerp(8) / 4096, lerp(9) / 4096);
    for (const m of this.mats) m.color.setScalar(lerp(10) / 4096);
  }

  dispose() { for (const m of this.mats) m.dispose(); }
}

interface EmitterData {
  over?: boolean;
  maskView?: PolarEmitterPose;
  beam?: number;
  mState?: number;
  mTarget?: number;
  mk?: number;
  mh?: number;
  c6c?: number;
  t68?: number;
  t70?: number;
  k18?: number[];
}

// 0x452 uses VAB centre note 95 and fine tune 58 in every Polar bank. The USA
// sound driver (80042a20) multiplies two truncated pitch tables, then rounds the SPU word.
const FUSE_BASE_PITCH = 4096 * 2 ** ((60 - 95 + 58 / 128) / 12);
function fuseRamp() {
  const frames = [];
  let offset = 0;
  for (let age = 0; age < 300; age++) {
    const bend = 58 + Math.floor(age * 0xf00 / 300);
    const note = 60 - 95 + Math.floor(bend / 128);
    const octave = Math.floor(note / 12);
    const coarse = Math.floor(32768 * 2 ** ((note - octave * 12) / 12));
    const fine = Math.floor(32768 * 2 ** ((bend % 128) / (12 * 128)));
    const word = Math.round(Math.floor(coarse * fine / 65536) / 2 ** (2 - octave));
    const rate = word / FUSE_BASE_PITCH;
    frames.push({ rate, offset });
    offset += rate / 30;
  }
  return frames;
}
const FUSE_RAMP = fuseRamp();

export class PolarItemEmitter {
  readonly root = new THREE.Group();
  private readonly model: THREE.Group;
  private readonly halo: EmitterTrack | null;
  private readonly target: EmitterTrack;
  private readonly beam: EmitterTrack;
  private readonly pickup: RealFx;
  private readonly config: typeof VARIANTS[keyof typeof VARIANTS];
  private intro: ReturnType<typeof polarEmitterIntro> | null = null;
  private loop: { sample: number; stop: () => void } | null = null;
  private fuse: ReturnType<typeof sfx.startSample> = null;
  private pickupStart = -1;
  private pickupAge = 0;
  private readonly cameraLocal = new THREE.Quaternion();

  constructor(parent: THREE.Group, private readonly variant: string) {
    this.config = VARIANTS[variant as keyof typeof VARIANTS] ?? VARIANTS.tilt;
    const { model, halo, target, beam } = this.config;
    this.root.name = 'polarItemEmitter';
    this.root.visible = false;
    parent.add(this.root);
    this.model = mesh(variant === 'melt' ? model : 403, variant === 'melt' ? 11 : 18);
    this.model.name = 'polarItemEmitterModel';
    this.root.add(this.model);
    const attach = (name: string, pack: number, script: number, order: number, floor = false) => {
      const track = new EmitterTrack(this.root, pack, FX_PACKS[pack].scripts[script].tracks[0], order, floor);
      track.obj.name = name;
      return track;
    };
    this.target = attach('polarItemTarget', 403, target, 4, true);
    this.beam = attach('polarItemBeam', model, beam, 5);
    this.halo = halo === null ? null : attach('polarItemHalo', 403, halo, 6);
    this.pickup = new RealFx(this.root, S);
  }

  introFrame(countdownLeft: number | undefined, slots: number[], target: number) {
    if (countdownLeft === undefined) return null;
    this.intro ??= polarEmitterIntro(this.variant, slots, target);
    return this.intro[Math.max(0, this.intro.length - 1 - countdownLeft)];
  }

  render(body: Body | undefined, data: EmitterData, camera: THREE.Camera, ice: THREE.Quaternion, endFrames: number,
    countdownLeft: number | undefined, slots: number[]) {
    const intro = this.introFrame(countdownLeft, slots, data.mTarget ?? 0);
    const ended = endFrames > 0 || data.over;
    const pose = intro?.pose ?? data.maskView;
    this.root.visible = !!body?.alive;
    if (this.variant === 'tilt') this.root.quaternion.copy(ice);
    const effect = pose?.effect;
    const holder = data.mh ?? -1;
    const meltPickup = this.variant === 'melt' && effect?.kind === 'pickup';
    const armed = meltPickup && data.mk === 5 && (data.c6c ?? 5) !== 5;
    const meltBeam = this.variant === 'melt' && !!effect && effect.age < 60 && !armed;
    const carrying = holder >= 0 && (data.mk === 5 || data.mk === 6);
    const melt = this.variant === 'melt';
    const fuseAge = (data.c6c ?? 5) === 5 ? 14 - (data.t70 ?? 14) : (melt ? 15 : 14) + 299 - (data.t68 ?? 299);
    this.updateFuse(body?.alive && !ended && carrying ? fuseAge : -1, melt);
    if (body?.alive && !ended) {
      if ((data.beam ?? 0) > 0 || (meltBeam && (!meltPickup || (data.k18?.[holder] ?? -1) !== -1))) this.setLoop(0, 1.1382, 0x44c);
      else if (!melt && data.mk === 6 && carrying && fuseAge >= 1) this.setLoop(18, 0.002, 0x465, (fuseAge - 1) / 30);
      else this.stopAudio();
    } else this.stopAudio();
    if (!body?.alive) return;

    const height = -(pose?.y ?? MASK_HEIGHT[this.variant] ?? MASK_HEIGHT.tilt) * U + Math.floor(endFrames) * 16 * U;
    const x = intro ? intro.x * U : body.x, z = intro ? -intro.z * U : body.z;
    this.model.position.set(x, height, z);
    this.model.rotation.set((pose?.pitch ?? 0) * ANGLE, -(pose?.yaw ?? 0) * ANGLE, -(pose?.roll ?? 0) * ANGLE,
      this.variant === 'melt' ? 'XYZ' : 'ZYX');

    const tick = pose?.tick ?? 0;
    const period = this.variant === 'tilt' ? 39 : 40;
    const pulse = tick > 0 ? (tick - 1) % period + 1 : -1;
    this.cameraLocal.copy(this.root.quaternion).invert().multiply(camera.quaternion);
    if (this.halo) {
      this.halo.show(pulse, x, height + (this.variant === 'tilt' ? 64 : 96) * U, z);
      this.halo.obj.quaternion.copy(this.cameraLocal);
    }

    const leaving = this.variant === 'melt' && data.mState === 2;
    this.target.show(ended || leaving ? -1 : pulse, x, FLOOR, z);
    const beamTicks = data.beam ?? 0;
    const beamAge = ended ? -1 : effect && (effect.kind === 'beam' || meltBeam) ? effect.age : beamTicks > 0 ? 119 - beamTicks : -1;
    const beamDuration = this.variant === 'melt' ? 60 : 120;
    // Mode 2 uses the column's world orientation. At the edge of the view it leans in perspective.
    this.beam.show(beamAge > 0 && beamAge < beamDuration ? beamAge : -1, effect ? effect.x * U : x, FLOOR, effect ? -effect.z * U : z);

    const { model, pickup } = this.config;
    if (!ended && pickup !== null && effect?.kind === 'pickup') {
      const start = tick - effect.age;
      if (start !== this.pickupStart) {
        this.pickup.clear();
        this.pickupStart = start;
        this.pickupAge = effect.age;
        this.pickup.play(model, pickup, effect.x * U, FLOOR, -effect.z * U, { delay: -effect.age / 2, speed: 0.5 });
      }
      this.pickup.update(Math.max(0, effect.age - this.pickupAge) / 30, camera);
      this.pickupAge = effect.age;
    } else if (this.pickupStart !== -1) {
      this.pickup.clear();
      this.pickupStart = -1;
    }
  }

  event(e: GameEvent) {
    const { bank } = this.config;
    const cue = (id: number, sample: number, from = '0447') =>
      sfx.playFile(`sfx/${from}/${sample}.mp3`, 0.7, false, sfxRate(bank, id));
    switch (e.k) {
      case 'beamWarn': cue(0x463, 16); break; // all four banks alias this sample
      case 'beamEnd': cue(0x44d, 1); break;
      case 'zap': cue(0x466, 19); break;
      case 'melt': cue(0x489, 20, '0448'); break;
      case 'pickup':
        switch (e.v) {
          case 1: cue(0x44e, 2); break;
          case 2: cue(0x44f, 3); break;
          case 3: cue(0x451, 5); break;
          case 4: cue(0x450, 4); break;
          case 5: cue(0x464, 17); break;
          case 6: cue(0x48a, 21, '0448'); break;
        }
        break;
    }
  }

  private stopAudio() {
    this.loop?.stop();
    this.loop = null;
  }

  private updateFuse(age: number, melt: boolean) {
    if (age < 1) {
      this.fuse?.stop();
      this.fuse = null;
      return;
    }
    // The voice keys on one tick after pickup. MELT arms one tick later and
    // updates pitch before decrementing its timer. Other arenas decrement first.
    const rampStart = melt ? 16 : 14;
    const frame = FUSE_RAMP[Math.min(299, Math.max(0, age - rampStart))];
    const offset = Math.min(age - 1, rampStart - 1) * FUSE_RAMP[0].rate / 30 + frame.offset;
    if (this.fuse) this.fuse.update(frame.rate, offset);
    else this.fuse = sfx.startSample('sfx/0447/6.mp3', 28 / 5995, 0.6, frame.rate, offset);
  }

  private setLoop(sample: number, start: number, id: number, offset = 0) {
    if (this.loop?.sample === sample) return;
    this.stopAudio();
    const source = sfx.startSample(`sfx/0447/${sample}.mp3`, start, 0.6, sfxRate(this.config.bank, id), offset);
    if (source) this.loop = { sample, stop: source.stop };
  }

  dispose() {
    this.stopAudio();
    this.fuse?.stop();
    this.fuse = null;
    this.halo?.dispose();
    this.target.dispose();
    this.beam.dispose();
    this.pickup.dispose();
    this.root.removeFromParent();
  }
}
