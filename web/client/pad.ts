// Standard Gamepad API indices match the four PlayStation face positions and shoulders.
export type Button = 'a' | 'b' | 'c' | 'd' | 'l' | 'r';
type Layout = Partial<Record<Button, number>>;
export const PAD_LABEL = ['×', '○', '□', '△', 'L1', 'R1'] as const;
const layouts: Record<string, Layout> = {
  ballDefence: { a: 2, c: 3, r: 5 }, pushOff: { a: 2, b: 1 }, tilePainter: { a: 2 },
  tankArena: { a: 2, b: 1, c: 3, l: 4, r: 5 }, crateToss: { a: 1, b: 2, c: 0, d: 3 },
  dashRace: { a: 2, b: 1, r: 5 }, dragonDrop: { a: 2 }, ringDing: { a: 0, b: 2, d: 3 },
  malletMash: { a: 2 }, kegKaboom: { a: 0, b: 2, c: 1 },
};
export function padLayout(game: string, variant?: string): Layout {
  if (game === 'tankArena' && variant === 'swamp') return { a: 2, b: 1, c: 3, d: 0, r: 5 };
  if (game === 'ballDefence' && variant === 'beach') return { a: 2, b: 0, c: 3, r: 5 };
  if (game === 'dashRace' && variant === 'splash') return { a: 2, b: 0, r: 5 };
  return layouts[game] ?? { a: 0, b: 1 };
}
