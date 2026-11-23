import { ON_FOOT_GLOW_MARKERS, ON_FOOT_MARKERS } from './onFootItemMarkers';
import { CRATE_ATTACK } from './crateGripData';

/** Script 2 in the eight common on-foot models, in 30 Hz ticks. */
export const TAUNT_TICKS = [56, 66, 40, 40, 47, 60, 40, 39];

/** Offsets in world-facing, Y-up game coordinates. Shape 0x400 changes with the attack pose. */
export function attackHull(character: number, frame: number, facing: number) {
  const track = CRATE_ATTACK[character - 1];
  const [x, z, radius, bottom, top] = track[Math.max(0, Math.min(track.length - 1, frame))];
  const sin = Math.sin(facing), cos = Math.cos(facing);
  return { x: x*cos + z*sin, z: z*cos - x*sin, radius, bottom, top };
}

export function onFootItemMarker(character: number, script: number, elapsed: number) {
  return markerAt(ON_FOOT_MARKERS[script]?.[character - 1], elapsed);
}

/** Marker 0x40 (FUN_80015780 tag 0x40) of crate scripts 0xf-0x12; only Cortex and Brio carry it. */
export function onFootGlowMarker(character: number, script: number, elapsed: number) {
  return markerAt(ON_FOOT_GLOW_MARKERS[script]?.[character - 1], elapsed);
}

function markerAt(track: (typeof ON_FOOT_MARKERS)[number][number] | undefined, elapsed: number) {
  if (!track) return;
  const length = track.length - 1;
  const loop = track[0];
  const frame = elapsed < length ? elapsed : loop < 0 ? length - 1 : loop + (elapsed - loop) % (length - loop);
  const marker = track[frame + 1];
  if (typeof marker !== 'number') return marker;
}
