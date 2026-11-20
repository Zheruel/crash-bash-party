import { POSES, POLAR_REFLECTION_POSES } from './playerPoseData';

export function poseTicks(script: number, character: number): number {
  return POSES[script]?.[character - 1]?.[0] ?? 0;
}

/** Sample the original character's 30 Hz animation script, including its held frames and loop point. */
export function playerPose(script: number, character: number, elapsed: number): number | undefined {
  return sampleTrack(POSES[script]?.[character - 1], elapsed);
}

/** Road boost returns to idle on the tick that the animation interpreter signals its end. */
export function dashKartPose(script: number, char: number, frame: number) {
  if (script === 0x49) {
    const idleAge = frame - (poseTicks(script, char) - 1);
    if (idleAge >= 0) return playerPose(0x48, char, idleAge);
  }
  return playerPose(script, char, frame);
}

export function polarReflectionPose(script: number, character: number, elapsed: number): number | undefined {
  return sampleTrack(POLAR_REFLECTION_POSES[script]?.[character - 1], elapsed);
}

function sampleTrack(track: number[] | undefined, elapsed: number): number | undefined {
  if (!track) return;
  const [length, loop] = track;
  let frame = Math.max(0, Math.floor(elapsed));
  if (frame >= length) frame = loop < 0 ? length - 1 : loop + (frame - loop) % (length - loop);
  for (let i = 2; i < track.length; i += 3) {
    if (frame < track[i + 1]) return track[i] + frame * track[i + 2];
    frame -= track[i + 1];
  }
}
