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
  { id: 'big-stein', name: 'Big Stein', blurb: 'Silver hair, crooked grin', portrait: 'portraits/big-stein.png', hud: 'hud/big-stein-ps1.png' },
  { id: 'top-g', name: 'Top G', blurb: 'Andrew Tate in silver aviators', portrait: 'portraits/top-g.png', hud: 'hud/top-g-ps1.png' },
] as const;

/** Roster index to disc character for movement and animation tables. Both custom characters use Cortex. */
export const DISC_CHARACTER = [1, 2, 5, 7, 3, 4, 8, 6, 3, 3] as const;

/** Individual versus speaks the name at tick 31, then "wins", then the character reaction. */
export const WINNER_NAME_FRAME = 31;
export function winnerCheerFrame(char: number) {
  const id = CHARACTERS[char]?.id;
  const recordedWait = id === 'big-stein' ? 35 : id === 'top-g' ? 36 : undefined;
  const stockWait = [25, 24, 27, 24, 24, 24, 27, 27][(DISC_CHARACTER[char] ?? 1) - 1];
  return WINNER_NAME_FRAME + (recordedWait ?? stockWait) + 31;
}

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

export const EMOTE_LABELS = ['Thumbs up', 'Laugh', 'Angry', 'Wave'];
export const EMOTES = ['👍', '😂', '😡', '👋'];
