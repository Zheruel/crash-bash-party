import { rotFx, type PS1Cam } from '../../shared/fitCamera';
import { ps1SqrtQ6 } from '../../shared/ps1Sqrt';

/** The PS1 geometry engine's 17-bit reciprocal used to project a sound onto the 512-pixel screen. */
function projectionRatio(h: number, z: number) {
  if (z <= 0 || h >= 2 * z) return 0x1ffff;
  const shift = Math.clz32(z) - 16;
  const d = z << shift;
  const index = (d - 0x7fc0) >> 7;
  const seed = Math.max(0x101, (Math.floor(0x40000 / (index + 0x100)) + 1) >> 1);
  const correction = (0x2000080 - d * seed) >> 8;
  const reciprocal = (0x80 + correction * seed) >> 8;
  return Math.min(0x1ffff, Math.floor(((h << shift) * reciprocal + 0x8000) / 65536));
}

/** FUN_8002b210 and FUN_8002b52c, with the USA game's stereo and SFX level at 100%. */
export function discStereo(camera: PS1Cam, x: number, y: number, z: number): [number, number] {
  const m = rotFx(camera);
  const dx = ((x - (camera.tx ?? 0)) << 16) >> 16;
  const dy = ((y - (camera.ty ?? 0)) << 16) >> 16;
  const dz = ((z - (camera.tz ?? 0)) << 16) >> 16;
  // The native 512x240 frame scales camera-space X by 3276/4096 and Y by 1/2.
  const axis = (row: number, scale: number, translation: number) => {
    const a = m[row] * scale >> 12, b = m[row + 1] * scale >> 12, c = m[row + 2] * scale >> 12;
    return ((a * dx + b * dy + c * dz) >> 12) + (translation * scale >> 12);
  };
  const vx = axis(0, 3276, camera.x), vy = axis(3, 2048, camera.y), vz = axis(6, 4096, camera.z);
  const excess = (n: number, near: number, far: number) =>
    Math.trunc(Math.max(0, Math.abs(Math.max(-32768, Math.min(32767, n))) - near) * 4096 / (far - near));
  const ax = excess(vx, 1024, 2560), ay = excess(vy, 4096, 4608), az = excess(vz, 3840, 10240);
  const distance = ps1SqrtQ6((ax * ax + ay * ay + az * az) | 0) >> 6;
  const volume = Math.min(4096, Math.max(0, 4096 - distance) * 0x1450 >> 12);
  const screenX = 256 + Math.floor(Math.max(-32768, Math.min(32767, vx)) * projectionRatio(camera.H, Math.min(vz, 65535)) / 65536);
  const pan = Math.max(0, Math.min(512, screenX));
  const channel = (pixels: number) => {
    const level = Math.trunc(((512 * 512 - pixels * pixels) * volume) / (512 * 512));
    return (level * 127 >> 12) / 127;
  };
  return [channel(pan), channel(512 - pan)];
}
