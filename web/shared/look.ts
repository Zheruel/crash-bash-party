// Player appearance: one of the Crash Bash characters + a team colour.

export interface Look {
  char: number; // index into CHARACTERS
  color: number; // index into COLORS
}

/** Crash Bash roster (models come from assets/catalog.json, keyed by id). */
export const CHARACTERS = [
  { id: 'crash', name: 'Crash', blurb: 'Spins first, thinks never' },
  { id: 'coco', name: 'Coco', blurb: 'Genius with a laptop and a grudge' },
  { id: 'tiny', name: 'Tiny', blurb: 'Tiny smash! Tiny win!' },
  { id: 'dingodile', name: 'Dingodile', blurb: 'Half dingo, half croc, all flamethrower' },
  { id: 'cortex', name: 'Cortex', blurb: 'Evil genius, mediocre athlete' },
  { id: 'brio', name: 'N. Brio', blurb: 'Bubbling with bad ideas' },
  { id: 'koala', name: 'Koala Kong', blurb: 'Muscles first, questions later' },
  { id: 'rilla', name: 'Rilla Roo', blurb: 'Bouncy, bonkers, unstoppable' },
] as const;

/** Roster index to disc character for movement tables and sounds. */
export const DISC_CHARACTER = [1, 2, 5, 7, 3, 4, 8, 6] as const;

export const COLORS = [
  { name: 'Tomato', hex: '#ff5a4f' },
  { name: 'Sky', hex: '#3fa7ff' },
  { name: 'Sun', hex: '#ffd23f' },
  { name: 'Lime', hex: '#4cd964' },
  { name: 'Grape', hex: '#a96bff' },
  { name: 'Peach', hex: '#ff9f6b' },
  { name: 'Mint', hex: '#3fe0c5' },
  { name: 'Candy', hex: '#ff6bc1' },
] as const;

export const colorHex = (look: Look) => COLORS[look.color % COLORS.length].hex;

export function sanitizeLook(l: unknown): Look {
  const o = (l ?? {}) as Partial<Look>;
  const n = (v: unknown, len: number) => (typeof v === 'number' && isFinite(v) ? ((Math.floor(v) % len) + len) % len : 0);
  return { char: n(o.char, CHARACTERS.length), color: n(o.color, COLORS.length) };
}

export const EMOTES = ['👍', '😂', '😡', '👋'];
