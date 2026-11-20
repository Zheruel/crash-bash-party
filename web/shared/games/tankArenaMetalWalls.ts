// Metal Fox's 0x1310 spawner and 0x1311 platforms (USA Tank Wars overlay 0726).
// The 32-entry pointer table at 0x800ca8c4 repeats these four waves.
const WAVES = [
  [[1, 2, 17], [1, 4, 18], [3, 2, 22], [3, 4, 23], [5, 2, 27], [5, 4, 28], [7, 2, 32], [7, 4, 33]],
  [[2, 1, 19], [4, 1, 24], [6, 1, 29], [2, 3, 20], [4, 3, 25], [6, 3, 30], [2, 5, 21], [4, 5, 26], [6, 5, 31]],
  [[2, 1, 19], [1, 2, 17], [2, 5, 21], [1, 4, 18], [6, 1, 29], [7, 2, 32], [6, 5, 31], [7, 4, 33], [4, 3, 25]],
  [[3, 2, 22], [3, 4, 23], [5, 2, 27], [5, 4, 28], [4, 3, 25]],
] as const;
const FIRST_WAVE = -10; // Frames relative to the end of the USA versus countdown
const WAVE_COUNT = 32;
const LIFETIME = 180;
const WAVE_INTERVAL = LIFETIME + 70;
const RETRACTED_Y = 184; // PS1 +y is down
const RISE_PULSE = [0, 7, 11, 15];
const SINK_PULSE = [3, 7, 11, 15];

export interface MetalWall {
  x: number; z: number; part: number; born: number; y: number; life: number;
  phase: 'waiting' | 'rising' | 'raised' | 'sinking' | 'cleared';
  ticks: number;
  firstLaterId: number;
  collisionChangedAt?: number;
}

export interface MetalWalls {
  wave: number;
  walls: MetalWall[];
}

interface TankPosition { x: number; z: number }

interface WallUpdate {
  firstLaterId?: number;
  onWave?: () => void;
  onRise?: (wall: MetalWall) => void;
}

function solid(wall: MetalWall): boolean {
  return wall.phase === 'rising' || wall.phase === 'raised' || wall.phase === 'sinking';
}

/** Both 0x800cacb4 (drive) and 0x800cacfc (shot) have the same occupied tiles in L8. */
export function metalWallAt(map: MetalWalls | undefined, col: number, row: number, tick?: number, objectId?: number): boolean {
  return map?.walls.some(wall => {
    if ((wall.x >> 9) !== col || (wall.z >> 9) !== row) return false;
    // Native object callbacks run in allocation order. Older objects still see the prior tile on the change tick.
    const before = objectId !== undefined && objectId < wall.firstLaterId && wall.collisionChangedAt === tick;
    return before ? !solid(wall) : solid(wall);
  }) ?? false;
}

/** The floor animation is object 0x1312, group 0 on the level's own model (0689). */
export function metalWallPulse(wall: MetalWall, tick: number): number | undefined {
  return wall.phase === 'cleared' ? SINK_PULSE[wall.ticks - 1] : RISE_PULSE[tick - wall.born];
}

export function stepMetalWalls(
  map: MetalWalls, tick: number, tanks: readonly TankPosition[], over: boolean,
  { firstLaterId = 0, onWave, onRise }: WallUpdate = {},
) {
  for (let i = 0; i < map.walls.length;) {
    const wall = map.walls[i];
    switch (wall.phase) {
      case 'waiting':
        if (--wall.ticks !== 0) break;
        if (tanks.some(tank => Math.abs(tank.x - wall.x) < 0x200 && Math.abs(tank.z - wall.z) < 0x1ff)) {
          wall.life = Math.max(1, wall.life - 1);
          wall.ticks = 1;
          break;
        }
        if (metalWallAt(map, wall.x >> 9, wall.z >> 9)) {
          map.walls.splice(i, 1);
          continue;
        }
        wall.phase = 'rising';
        wall.collisionChangedAt = tick;
        onRise?.(wall);
        break;
      case 'rising':
        wall.y = Math.max(0, wall.y - 30);
        if (wall.y === 0) wall.phase = 'raised';
        break;
      case 'raised':
        if (!over && --wall.life === 0) wall.phase = 'sinking';
        break;
      case 'sinking':
        wall.y += 30;
        if (wall.y >= RETRACTED_Y) {
          wall.phase = 'cleared';
          wall.ticks = 4;
          wall.collisionChangedAt = tick;
        }
        break;
      case 'cleared':
        if (--wall.ticks === 0) {
          map.walls.splice(i, 1);
          continue;
        }
        break;
    }
    i++;
  }
  if (!over && map.wave < WAVE_COUNT && tick >= FIRST_WAVE + map.wave * WAVE_INTERVAL) {
    const wave = WAVES[map.wave++ % WAVES.length];
    for (const [col, row, part] of wave) {
      map.walls.push({
        x: col * 512 + 256, z: row * 512 + 256, part, born: tick,
        y: RETRACTED_Y, life: LIFETIME, phase: 'waiting', ticks: 6, firstLaterId,
      });
    }
    onWave?.();
  }
}

/** Play starts with the platforms already rising. The view can also sample the preceding countdown. */
export function initialMetalWalls(tanks: readonly TankPosition[], tick = 0): MetalWalls {
  const map: MetalWalls = { wave: 0, walls: [] };
  for (let frame = FIRST_WAVE; frame <= tick; frame++) stepMetalWalls(map, frame, tanks, false);
  return map;
}
