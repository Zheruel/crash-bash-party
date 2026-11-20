import type { InputState, MiniGame, World } from './types';
import { IDLE } from './types';

export const BOT_LEVELS = ['Easy', 'Normal', 'Hard'] as const;

/** Difficulty and reaction state belong to the minigame and advance once per simulation tick. */
export function botInput(game: MiniGame, w: World, slot: number): InputState {
  return game.bot?.(w, slot) ?? IDLE;
}
