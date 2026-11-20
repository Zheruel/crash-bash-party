import * as THREE from 'three';
import { CT_U, createCrateCrushResult } from '../../shared/games/crateToss';
import type { Body, World } from '../../shared/types';
import type { ModelInstance, ModelRef } from '../crash';
import type { ActorState } from './kit';
import { playerPose } from './playerPose';
import { FitCam, ps1Pose, type CamPose, type PS1Cam } from './ps1cam';

export const CRATE_RESULT_HOLD_MS = 5000;

// Script 0x08 starts at these pose words. Script 0x0d loops at the recorded pose.
const LAND = [[0x410c, 27], [0x4190, 11], [0x418d, 6], [0x418a, 4], [0x4191, 11], [0x4292, 9], [0x410c, 15], [0x4111, 7]];
const CHEER = [
  [0x4480, 34, 0], [0x4500, 100, 0], [0x4480, 33, 11], [0x4580, 24, 0],
  [0x4500, 78, 34], [0x4580, 79, 33], [0x4580, 76, 0], [0x4600, 118, 0],
];

// FUN_80085890 switches to 0x0d when the celebration morph finishes loading.
// Use the measured stage delays with the web's preloaded morphs.
const CHEER_DELAY: Record<string, { typical: number; byChar: Record<number, number> }> = {
  jungle: { typical: 11, byChar: { 2: 15, 3: 12 } },
  space: { typical: 13, byChar: { 2: 14, 5: 14 } },
  snow: { typical: 15, byChar: { 1: 13 } },
  drain: { typical: 13, byChar: { 1: 12 } },
};

function cheerPose(char: number, elapsed: number) {
  const [start, length, loop] = CHEER[char - 1];
  const frame = elapsed < length ? elapsed : loop + (elapsed - loop) % (length - loop);
  return start + frame - (char === 3 && frame >= 11 ? 1 : 0);
}

export class CrateTossResult {
  readonly scene: ReturnType<typeof createCrateCrushResult>;
  private fit: FitCam;
  frame = 0;
  readonly audioFrom: number;

  constructor(terminal: World, readonly winner: number | undefined, readonly at: number,
              elapsed: number, base: PS1Cam, private ref: ModelRef, opening: CamPose) {
    this.scene = createCrateCrushResult(terminal, winner);
    this.audioFrom = elapsed + 1;
    const x = opening.pos.x / CT_U, y = -opening.pos.y / CT_U, z = -opening.pos.z / CT_U;
    const pitch = base.pitch * Math.PI / 2048;
    this.fit = new FitCam({
      ...base, x: Math.round(-x), y: Math.round(Math.sin(pitch) * z - Math.cos(pitch) * y),
      z: Math.round(-Math.cos(pitch) * z - Math.sin(pitch) * y),
    });
    this.fitResult();
  }

  get world() { return this.scene.world; }
  get camera() { return ps1Pose(this.fit.c, this.ref); }
  get winnerAge() { return this.scene.winnerAt < 0 ? -1 : this.frame - this.scene.winnerAt; }

  step() {
    this.frame++;
    const events = this.scene.step();
    this.fitResult();
    return events;
  }

  private fitResult() {
    const floor = this.world.data.variant === 'drain' ? 0 : -16;
    const boxes = this.world.bodies.flatMap(b => {
      const p = b.kind === 'player' && this.scene.actors.get(b.slot);
      if (!p || p.state === 'out' || p.state === 'loser') return [];
      return [{ x: Math.round(b.x / CT_U), y: floor - Math.round(b.y / CT_U), z: Math.round(-b.z / CT_U),
        xl: 256, xr: 256, zn: 0, zf: 0, h: 960 }];
    });
    this.fit.update(boxes, false, false);
  }

  actor(b: Body, inst: ModelInstance, held: boolean): ActorState {
    const p = this.scene.actors.get(b.slot)!;
    const char = this.world.data.char[b.slot] as number;
    const { state, script, elapsed } = p;
    const timing = CHEER_DELAY[this.world.data.variant] ?? CHEER_DELAY.jungle;
    const delay = timing.byChar[char] ?? timing.typical;
    const cheer = state === 'winner' ? elapsed - delay + 1 : 0;
    const hidden = state === 'out';
    const anims = inst.ref?.anims;
    const base = { hidden, keepYaw: true, freeze: true };
    if (anims?.carry != null) {
      const role = cheer > 0 ? 'win' : state === 'rise' || state === 'fall' || state === 'hole' || state === 'land'
        ? (held ? 'carryJump' : 'jump') : script === 0x12 ? 'throw' : script === 0xf ? 'lift'
          : script === 9 ? 'hit' : script === 0xa ? 'spin' : script === 5 ? 'run' : held ? 'carry' : 'idle';
      const idleCycle = inst.ref?.model === 9001 ? 78 : 80;
      const frame = role === 'win' ? (cheer - 1) % 43 : role === 'idle' ? elapsed % idleCycle
        : role === 'jump' || role === 'carryJump' ? (state === 'land' ? 19 : state === 'rise' ? elapsed : 10 + elapsed) : elapsed;
      return { ...base, pose: { clip: anims[role], frame } };
    }
    const land = LAND[char - 1];
    const renderWord = cheer > 0 ? cheerPose(char, cheer)
      : script === 8 ? land[0] + Math.min(elapsed, land[1] - 1) : playerPose(script, char, elapsed);
    return { ...base, renderWord };
  }
}
