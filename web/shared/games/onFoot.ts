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

/** 0x8009dc68 as [X, Y] (columns 2 and 1): the throw (FUN_800c07f4) and attack (FUN_8008900c) flashes of the player object. */
export const ON_FOOT_FLASH_GLOW: readonly (readonly [number, number])[] = [[20480, 20480], [16384, 8192], [6144, 4096], [2048, 2560], [512, 512]];

/**
 * FUN_8008900c, the attack state 10 of engine characters 3 and 4: after the anim VM, each update that finds marker
 * 0x40 shows the player object there (drawn additive, flag 0x20000000) at the counter's row of 0x8009dc68, then
 * advances the counter. FUN_80088f78 starts the counter at -2 for Cortex and 0 for Brio. The zero row hides it.
 * Elapsed counts handler updates since the state's entry update.
 */
export function onFootSpinGlow(character: number, elapsed: number) {
  if (character !== 3 && character !== 4) return;
  let counter = character === 3 ? -2 : 0;
  for (let update = 1; update <= elapsed; update++) {
    const marker = onFootGlowMarker(character, 0x0a, update);
    if (!marker) continue;
    const scale = counter >= 0 ? ON_FOOT_FLASH_GLOW[counter] : undefined;
    if (update === elapsed) return scale && { marker, scale };
    if (counter < ON_FOOT_FLASH_GLOW.length) counter++;
  }
}

function markerAt(track: (typeof ON_FOOT_MARKERS)[number][number] | undefined, elapsed: number) {
  if (!track) return;
  const length = track.length - 1;
  const loop = track[0];
  const frame = elapsed < length ? elapsed : loop < 0 ? length - 1 : loop + (elapsed - loop) % (length - loop);
  const marker = track[frame + 1];
  if (typeof marker !== 'number') return marker;
}
