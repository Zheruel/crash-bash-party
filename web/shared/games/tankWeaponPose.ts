/** Gun render words and table lengths from the Tank Wars overlay (FUN_800b71f8). */
export const TANK_STOCK_WEAPON = [9, 9, 11, 11, 10, 10, 8, 8];

const SWAMP_IDLE: Record<number, number> = { 8: 0x4100, 9: 0x4300, 10: 0x4000, 11: 0x4200 };
const TRACKED_IDLE: Record<number, number> = { 2: 0x200b, 3: 0x2008, 8: 0x2009, 9: 0x2010, 10: 0x2012, 11: 0x2011 };
// At 0x800c987c..0x800c99b4 (tracked), 0x800c9a70..0x800c9b60 (Swamp Fox).
const TRACKED_FIRE: Record<number, number> = { 3: 0x4000, 8: 0x4200, 9: 0x4180, 10: 0x4100, 11: 0x4280 };
const SWAMP_FIRE: Record<number, number> = { 8: 0x4180, 9: 0x4380, 10: 0x4080, 11: 0x4280 };

export const TANK_BOMB_RELEASE_POSE = 0x4004;

export function tankGunIdle(level: number, weapon: number, frame = 0): number {
  if (level !== 5) return TRACKED_IDLE[weapon] ?? TRACKED_IDLE[9];
  return (SWAMP_IDLE[weapon] ?? SWAMP_IDLE[9]) + frame;
}

/** Undefined is the ROM's zero terminator. Double's 39 entries all select the same mesh. */
export function tankGunFire(level: number, weapon: number, frame: number): number | undefined {
  if (weapon === 2) return frame < 39 ? 0x200c : undefined;
  const start = (level === 5 ? SWAMP_FIRE : TRACKED_FIRE)[weapon];
  const first = start ?? TRACKED_FIRE[weapon];
  return first !== undefined && frame < 12 ? first + frame : undefined;
}
