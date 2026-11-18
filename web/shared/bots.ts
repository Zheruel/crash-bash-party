import type { InputState, MiniGame, World } from './types';
import { IDLE } from './types';

export const BOT_LEVELS = ['Easy', 'Normal', 'Hard'] as const;

interface Cfg { period: number; strength: number; noise: number; press: number }
const CFG: Cfg[] = [
  { period: 10, strength: 0.55, noise: 0.35, press: 0.35 }, // easy: slow reactions, sloppy, rarely uses buttons
  { period: 5, strength: 0.85, noise: 0.14, press: 0.75 },
  { period: 1, strength: 1, noise: 0, press: 1 }, // hard: the game's bot as written
];

/**
 * Wraps a game's bot AI (written to play well) and degrades it for lower levels:
 * it only re-decides every few ticks (reaction time), moves a bit slower, adds
 * stick noise and sometimes misses button presses. Host-side only, not deterministic.
 */
export class BotBrain {
  private cur = new Map<number, InputState>();
  private next = new Map<number, number>();
  private cfg: Cfg;

  constructor(level: number) {
    this.cfg = CFG[Math.max(0, Math.min(2, level | 0))];
  }

  input(game: MiniGame, w: World, slot: number): InputState {
    if (!game.bot) return IDLE;
    const c = this.cfg;
    const due = (this.next.get(slot) ?? 0) <= w.tick;
    if (!due) {
      const held = this.cur.get(slot) ?? IDLE;
      return { ...held, a: false, b: false }; // buttons are one-shot on decision ticks
    }
    this.next.set(slot, w.tick + c.period + (c.period > 1 ? Math.floor(Math.random() * 3) : 0));
    const raw = game.bot(w, slot);
    const nx = (Math.random() - 0.5) * 2 * c.noise, ny = (Math.random() - 0.5) * 2 * c.noise;
    const out: InputState = {
      x: Math.max(-1, Math.min(1, raw.x * c.strength + nx)),
      y: Math.max(-1, Math.min(1, raw.y * c.strength + ny)),
      a: raw.a && Math.random() < c.press,
      b: raw.b && Math.random() < c.press,
    };
    this.cur.set(slot, out);
    return out;
  }
}
