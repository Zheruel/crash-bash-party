// Pad vibration as the game drives it (FUN_80028018(p, frames) = small motor on, FUN_80027f7c(p, frames, level) = big motor),
// mapped onto the sim events at the same moments, for the local player's gamepad (Gamepad.vibrationActuator).
import type { GameEvent } from '../../shared/types';

/** [small motor frames, big motor frames, big motor level 0..255] per game event */
type R = [number, number, number];
const TABLE: Record<string, Record<string, R>> = {
  tankArena: { hit: [0, 10, 0xf0] }, // FUN_800b6354 damage
  dashRace: { hit: [10, 10, 0xff] }, // FUN_800bba04 enter of the hit state 0x5d
  dragonDrop: { recoil: [10, 10, 0xff] }, // FUN_800b9e68 recoil enter (anim 0x4d)
  pushOff: { hit: [10, 10, 0xff] }, // FUN_800bbf2c collision with impact > 0x1000
  malletMash: { stun: [15, 0, 0], wave: [5, 0, 0] }, // FUN_800b4910 shock wave on a player; FUN_80028018(owner, 5) on a power wave
  kegKaboom: { stun: [0, 10, 0xf0] }, // FUN_800bb010 shock wave stun
  tilePainter: { stun: [30, 0, 0] }, // FUN_800b6df4 stun enter
  ballDefence: { ko: [0, 12, 0xff] }, // FUN_800be4d4 goal walled up, ship state 0x25
};

export function rumbleFor(game: string, e: GameEvent, mySlot: number | null) {
  if (mySlot == null) return;
  const r = TABLE[game]?.[e.k];
  if (!r) return;
  if (game === 'malletMash' && e.k === 'wave' && e.o !== 1) return;
  if (e.s !== mySlot && !(game === 'pushOff' && e.o === mySlot)) return;
  const pad = (navigator.getGamepads?.() ?? []).find((g) => g && g.connected) as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | undefined;
  const act = pad?.vibrationActuator;
  if (!act?.playEffect) return;
  const ms = (Math.max(r[0], r[1]) * 1000) / 30;
  void act.playEffect('dual-rumble', { duration: ms, strongMagnitude: r[2] / 255, weakMagnitude: r[0] ? 1 : 0 }).catch(() => {});
}
