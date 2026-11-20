import { dashRideHeight, DR_K } from '../../shared/games/dashRace';
import type { World } from '../../shared/types';
import type { FitCam, TrackBox } from './ps1cam';

// USA L23 RAM, scripts 0x4c and 0x55. The numbers are the first render word
// and length of the loop in engine character order (1–8).
const HOVER_CHEER = [[0x4200, 72], [0x4200, 64], [0x4200, 82], [0x4200, 75],
  [0x4200, 32], [0x4200, 63], [0x4200, 30], [0x4200, 64]];
const SPLASH_CHEER = [[0x4180, 72], [0x4200, 66], [0x4180, 37], [0x4200, 64],
  [0x4180, 54], [0x4200, 36], [0x4180, 32], [0x4200, 64]];

/** FUN_800bcdac starts 0x48 while FUN_80085890 waits for the cheer asset from disc. */
export function dashCheerPose(variant: string, char: number, age: number): number | undefined {
  const splash = variant === 'splash';
  const delay = splash ? 12 : char === 1 ? 7 : 8;
  if (age < delay) return;
  const [first, length] = (splash ? SPLASH_CHEER : HOVER_CHEER)[char - 1];
  return first + (age - delay + 1) % length;
}

// The two fixed fit points kept by FUN_80078dd4 on a draw.
const DRAW_ANCHORS: Record<string, number[][]> = {
  dot: [[-1407, 21, -4319], [1654, 95, -4307]],
  toxic: [[-1075, 21, -3852], [1343, -403, -3815]],
  splash: [[-1766, 1, -4216], [1561, 74, -4211]],
  dante: [[-1562, 21, -4157], [1528, 95, -4144]],
};

export function fitDashResult(camera: FitCam, w: World, winner: number | undefined) {
  const variant = w.data.variant;
  const scale = 1024 / DR_K;
  const boxes: TrackBox[] = [];
  for (const b of w.bodies) {
    if (b.kind !== 'player' || (winner !== undefined && b.slot !== winner)) continue;
    boxes.push({ x: Math.round(b.x * scale), y: -dashRideHeight(variant) - Math.round(b.y * scale),
      z: -Math.round(b.z * scale), xl: 256, xr: 256, zn: 0, zf: 0, h: 960 });
  }
  if (winner === undefined) for (const [x, y, z] of DRAW_ANCHORS[variant] ?? []) {
    boxes.push({ x, y, z, xl: 128, xr: 128, zn: 0, zf: 0, h: 128 });
  }
  camera.update(boxes, false, false);
}
