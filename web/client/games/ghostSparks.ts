export interface GhostSpark { x: number; y: number; z: number; fade: number }

/** Three nodes on the common spirit glow, FUN_800898ec and FUN_80089be8. */
export function ghostSparkFrames(socketY: number, floor: number, random: (limit: number) => number) {
  const sparks = [0, 1, 2].map(i => ({
    wait: random(10) + 3 * i, flying: false, x: 0, y: 0, z: 0,
    sin: 0, cos: 0, speed: 0, vy: 0, fade: 0,
  }));
  const frames: (GhostSpark | null)[][] = [[null, null, null]];
  for (let y = socketY - 24; y >= -2560; y -= 24) {
    frames.push(sparks.map(s => {
      if (!s.flying) {
        if (s.wait > 0) { s.wait--; return null; }
        const angle = (random(2048) + 1024) * Math.PI / 2048;
        s.sin = Math.round(4096 * Math.sin(angle));
        s.cos = Math.round(4096 * Math.cos(angle));
        s.flying = true;
        s.x = s.z = 0;
        s.y = y;
        s.speed = 48;
        s.vy = -64;
        s.fade = 256;
        return null;
      }
      s.speed = Math.max(0, s.speed - 3);
      s.x += (s.speed * s.sin) >> 12;
      s.z += (s.speed * s.cos) >> 12;
      s.vy = Math.min(48, s.vy + 4);
      s.y += s.vy;
      s.fade += 96;
      if (s.y > floor || s.fade >= 4096) {
        s.wait = random(10) + 2;
        s.flying = false;
        return null;
      }
      return { x: s.x, y: s.y, z: s.z, fade: s.fade };
    }));
  }
  return frames;
}
