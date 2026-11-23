// POLAR PUSH sound, as the overlay calls FUN_80022660(id, handle, position, 0x1000, pitch, 0) (re/notes/polarPush.md):
// - every tone of banks 0447 / 0448 / 0450 / 0451 has volume 127 and centre pan, so every effect keys at one level;
// - a call with a position goes through the stereo routine FUN_8002b210 (screen-x pan, distance box);
// - a call with a handle owns the rider's one voice (entity +0x94): footfalls, skids and the ledge slip replace each
//   other, and entering idle, walk or dash releases it (FUN_800225c4).
import type { PS1Cam } from '../../shared/fitCamera';
import { discStereo } from '../shell/discStereo';
import { sfx, sfxRate } from '../shell/sound';

/** Volume 0x1000 with the sound option at 100 is SPU voice level 127; the same gain as the Ballistix effects. */
export const PO_FULL = 0.8;
export const PO_BANK: Record<string, string> = { tilt: '0450', polar: '0451', melt: '0448', manic: '0447' };

/** Sound id -> sample of the level's bank (the VAB tone that carries the id; tools/sfx_pitch.py reads the same field). */
const TONES: Record<string, Record<number, number>> = {
  tilt: { 0x446: 32, 0x447: 33, 0x448: 32, 0x449: 33, 0x44c: 0, 0x44d: 1, 0x44e: 2, 0x44f: 3, 0x450: 4, 0x451: 5, 0x452: 6, 0x453: 7, 0x454: 8, 0x455: 9, 0x456: 10, 0x457: 11, 0x458: 10, 0x459: 11, 0x45a: 10, 0x45b: 11, 0x45c: 12, 0x45d: 13, 0x463: 14, 0x464: 15, 0x465: 16, 0x466: 17, 0x467: 18, 0x46f: 19, 0x470: 19, 0x471: 19, 0x472: 19, 0x473: 20, 0x474: 21, 0x475: 22, 0x476: 23, 0x477: 23, 0x478: 24, 0x479: 25, 0x47a: 26, 0x49c: 27, 0x49d: 28, 0x49e: 29, 0x49f: 30, 0x4a0: 31 },
  polar: { 0x446: 29, 0x447: 30, 0x448: 29, 0x449: 30, 0x44c: 0, 0x44d: 1, 0x44e: 2, 0x44f: 3, 0x450: 4, 0x451: 5, 0x452: 6, 0x453: 7, 0x454: 8, 0x455: 9, 0x456: 10, 0x457: 11, 0x458: 12, 0x459: 10, 0x45a: 11, 0x45b: 12, 0x45c: 13, 0x45d: 14, 0x463: 15, 0x464: 16, 0x465: 17, 0x466: 18, 0x467: 19, 0x46a: 20, 0x46b: 21, 0x46c: 22, 0x46d: 23, 0x49c: 24, 0x49d: 25, 0x49e: 26, 0x49f: 27, 0x4a0: 28 },
  melt: { 0x446: 28, 0x447: 29, 0x448: 28, 0x449: 29, 0x44c: 0, 0x44d: 1, 0x44e: 2, 0x44f: 3, 0x450: 4, 0x451: 5, 0x452: 6, 0x453: 7, 0x454: 8, 0x455: 9, 0x456: 10, 0x457: 11, 0x458: 12, 0x459: 10, 0x45a: 11, 0x45b: 12, 0x45c: 13, 0x45d: 14, 0x463: 15, 0x464: 16, 0x465: 17, 0x466: 18, 0x467: 19, 0x488: 0, 0x489: 20, 0x48a: 21, 0x48b: 22, 0x49c: 23, 0x49d: 24, 0x49e: 25, 0x49f: 26, 0x4a0: 27 },
  manic: { 0x3fa: 25, 0x446: 31, 0x447: 32, 0x448: 31, 0x449: 32, 0x44c: 0, 0x44d: 1, 0x44e: 2, 0x44f: 3, 0x450: 4, 0x451: 5, 0x452: 6, 0x453: 7, 0x454: 8, 0x455: 9, 0x456: 10, 0x457: 11, 0x458: 12, 0x459: 13, 0x45a: 10, 0x45b: 11, 0x45c: 14, 0x45d: 15, 0x463: 16, 0x464: 17, 0x465: 18, 0x466: 19, 0x467: 20, 0x48e: 21, 0x48f: 22, 0x490: 23, 0x491: 23, 0x492: 23, 0x493: 23, 0x494: 24, 0x49c: 26, 0x49d: 27, 0x49e: 28, 0x49f: 29, 0x4a0: 30 },
};

type Sample = NonNullable<ReturnType<typeof sfx.startSample>>;
interface Held { sample: Sample; at: number; pos?: () => [number, number, number] | null }

/** The file and playback rate of sound `id` on `variant`'s bank, or null when its bank has no such tone (silent on the disc too). */
export function polarTone(variant: string, id: number, pitch = 0x1e00): { file: string; rate: number } | null {
  const bank = PO_BANK[variant], n = TONES[variant]?.[id];
  if (bank === undefined || n === undefined) return null;
  // pitch: note = p >> 7, fine = p & 0x7f (FUN_8002b5b0); 0x1e00 is the tone's own rate
  return { file: `sfx/${bank}/${n}.mp3`, rate: sfxRate(bank, id) * 2 ** ((pitch - 0x1e00) / (128 * 12)) };
}

export function preloadPolarAudio(variant: string) {
  const bank = PO_BANK[variant];
  for (const n of new Set(Object.values(TONES[variant] ?? {}))) sfx.preloadFile(`sfx/${bank}/${n}.mp3`);
}

export class PolarAudio {
  /** The fit-all camera of the frame being drawn. */
  camera: PS1Cam | null = null;
  private held = new Map<number, Held>();

  constructor(private variant: string) {}

  private levels(x: number, y: number, z: number): [number, number] | undefined {
    return this.camera ? discStereo(this.camera, Math.round(x), Math.round(y), Math.round(z)) : undefined;
  }

  /** One effect. `pos` is in disc units (y down). */
  play(id: number, pos?: [number, number, number], pitch = 0x1e00): Sample | null {
    const tone = polarTone(this.variant, id, pitch);
    if (!tone) return null;
    return sfx.startSample(tone.file, null, PO_FULL, tone.rate, 0, pos ? this.levels(...pos) : undefined);
  }

  /** An effect on the rider's handle: it replaces the voice the handle holds. `pos` follows the rider while it sounds. */
  hold(slot: number, id: number, pos?: () => [number, number, number] | null, pitch = 0x1e00, offset = 0): Sample | null {
    this.release(slot);
    const tone = polarTone(this.variant, id, pitch);
    if (!tone) return null;
    const at = pos?.();
    const sample = sfx.startSample(tone.file, null, PO_FULL, tone.rate, offset * tone.rate, at ? this.levels(...at) : pos ? [0, 0] : undefined);
    if (sample) this.held.set(slot, { sample, at: performance.now(), pos });
    return sample;
  }

  /** FUN_800225c4 on the rider's handle. A voice keyed within the last `grace` ms belongs to the state being entered. */
  release(slot: number, grace = 0) {
    const h = this.held.get(slot);
    if (!h || performance.now() - h.at < grace) return;
    h.sample.stop();
    this.held.delete(slot);
  }

  holding(slot: number) {
    const h = this.held.get(slot);
    return !!h && !h.sample.ended;
  }

  /** Positioned voices take their levels from the rider's current place on every sound update. */
  update() {
    for (const [slot, h] of this.held) {
      if (h.sample.ended) { this.held.delete(slot); continue; }
      const at = h.pos?.();
      if (at) { const levels = this.levels(...at); if (levels) h.sample.setStereo(levels); }
    }
  }

  dispose() {
    for (const h of this.held.values()) h.sample.stop();
    this.held.clear();
  }
}
