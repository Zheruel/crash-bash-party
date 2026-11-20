// Character voices, as the game plays them. Each character has a voice bank per game family (disc t0c 0182-0213, picked
// per level at load; matched against the RAM dumps). A VAB tone carries its own sound id (FUN_8002aca0), and ids are
// block*0x32 + n per character. Hit voice = one of the four ids at 0x8009e080 + engineChar*8 (rand(4)), the same in
// every level dump. Built by the scratch vabids step into assets/audio/voices.json {families, ids}.
import { sfx, sfxRate } from './sound';
import { CHARACTERS, DISC_CHARACTER, WINNER_NAME_FRAME, winnerCheerFrame } from '../../shared/look';
import { ASSET_BASE } from '../crash';
export { winnerCheerFrame } from '../../shared/look';

/** Voice-bank family per game (from the level RAM dumps). */
export type VoiceFamily = 'tank' | 'a2' | 'b' | 'c';

/** engine character id (1..8) per CHARACTERS index (the canonical look -> engine table) */
const ENGINE = DISC_CHARACTER;
/** 0x8009e080: four hit-voice ids per engine character (index 1..8) */
const HIT: number[][] = [[], [3, 4, 5, 6], [0x35, 0x36, 0x37, 0x38], [0x67, 0x68, 0x69, 0x6a], [0x99, 0x9a, 0x9b, 0x9c],
  [0x12f, 0x130, 0x131, 0x132], [0x161, 0x162, 0x163, 0x164], [0xfd, 0xfe, 0xff, 0x100], [0xcb, 0xcc, 0xcd, 0xce]];

interface Voices { families: Record<VoiceFamily, string[]>; ids: Record<string, Record<string, string>> }
let data: Voices | null = null;
let loading: Promise<void> | null = null;
function load() {
  loading ??= fetch(`${ASSET_BASE}audio/voices.json`).then((r) => r.json()).then((j: Voices) => { data = j; }).catch(() => {});
  return loading;
}

const engineOf = (char: number) => ENGINE[((char % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length] ?? 1;
const characterId = (char: number) => CHARACTERS[char]?.id;

const TOP_G = 'sfx/custom/top-g/';
const STEIN = 'sfx/custom/big-stein/';
interface CustomVoices {
  announcement: { file: string };
  hits: string[];
  cues: Partial<Record<number, string>>;
}

const CUSTOM_VOICES: Partial<Record<string, CustomVoices>> = {
  'big-stein': {
    announcement: { file: 'sfx/custom/big-stein.mp3' },
    hits: [STEIN + 'hit-1.mp3', STEIN + 'hit-2.mp3'],
    cues: {
      2: STEIN + 'taunt.mp3',
      3: STEIN + 'hit-1.mp3',
      7: STEIN + 'win.mp3',
      0xc: STEIN + 'effort.mp3',
      0xd: STEIN + 'effort.mp3',
      0xe: STEIN + 'effort.mp3',
      0xf: STEIN + 'effort.mp3',
      0x10: STEIN + 'effort.mp3',
      0x18: STEIN + 'effort.mp3',
    },
  },
  'top-g': {
    announcement: { file: TOP_G + 'name.mp3' },
    hits: [TOP_G + 'hit-1.mp3', TOP_G + 'hit-2.mp3'],
    cues: {
      2: TOP_G + 'taunt.mp3',
      3: TOP_G + 'hit-1.mp3',
      7: TOP_G + 'win.mp3',
      0xc: TOP_G + 'effort.mp3',
      0xd: TOP_G + 'effort.mp3',
      0xe: TOP_G + 'effort.mp3',
      0xf: TOP_G + 'pickup.mp3',
      0x10: TOP_G + 'effort.mp3',
      0x18: TOP_G + 'dash.mp3',
    },
  },
};
const customVoices = (char: number) => CUSTOM_VOICES[characterId(char) ?? ''];
type PlayCue = (file: string, volume: number, rate: number) => void;
const playCue: PlayCue = (file, volume, rate) => { sfx.playFile(file, volume, true, rate); };

/** Play sound id `id` from the voice bank of the family that owns it (id / 0x32 = voice block). */
export function playVoiceId(family: VoiceFamily, id: number, vol = 0.8, play = playCue) {
  if (!data) { void load().then(() => { if (data) playVoiceId(family, id, vol, play); }); return; }
  const bank = data.families[family]?.[Math.floor(id / 0x32)];
  const f = bank && data.ids[bank]?.[String(id)];
  // the tone's own pitch for this id (several ids share a sample at different pitches, e.g. the last two hit voices)
  if (f) play(f, vol, sfxRate(bank, id));
}

/** The game's hit voice: rand(4) of the character's four hit ids (0x8009e080). */
export function hitVoice(family: VoiceFamily, char: number | undefined, vol = 0.8, variation = -1, play = playCue, stockCue?: () => void) {
  if (char == null) return;
  const take = variation >= 0 ? variation & 3 : Math.floor(Math.random() * 4);
  const hits = customVoices(char)?.hits;
  if (hits) {
    play(hits[take % hits.length], vol, 1);
    return;
  }
  if (stockCue) { stockCue(); return; }
  const ids = HIT[engineOf(char)];
  playVoiceId(family, ids[take], vol, play);
}

/** voice block (id / 0x32) of a character = the block its hit ids sit in */
export const voiceBlock = (char: number) => Math.floor(HIT[engineOf(char)][0] / 0x32);

/**
 * A voice from a character's anim script (`0x8008 id`, id = block*0x32 + n with the same n for every character),
 * optionally after `delay` 30 Hz ticks. Some original scripts use a different character's sound id.
 */
export function charVoice(family: VoiceFamily, char: number | undefined, n: number, delay = 0, vol = 0.8, discId?: number, player = playCue) {
  if (char == null) return;
  const file = customVoices(char)?.cues[n];
  const id = discId ?? voiceBlock(char) * 0x32 + n;
  const play = () => file ? player(file, vol, 1) : playVoiceId(family, id, vol, player);
  if (delay > 0) setTimeout(play, (delay * 1000) / 30);
  else play();
}

/** A vehicle can supply a level-bank sound for stock pilots and a roster cue for custom pilots. */
export function vehicleVoice(char: number, cue: number, stock: () => void) {
  const file = customVoices(char)?.cues[cue];
  if (file) playCue(file, 0.8, 1);
  else stock();
}

/** Taunts use the custom line or the script's authored cue, if it has one. */
export function tauntVoice(family: VoiceFamily, char: number | undefined, discId?: number) {
  if (char != null && customVoices(char)?.cues[2]) charVoice(family, char, 2);
  else if (discId != null) playVoiceId(family, discId);
}

const RESULT_BANK: Record<string, VoiceFamily> = {
  ballDefence: 'a2', tilePainter: 'a2', dashRace: 'a2', tankArena: 'tank',
  pushOff: 'b', ringDing: 'c', crateToss: 'c', dragonDrop: 'b', malletMash: 'c', kegKaboom: 'c',
};

/** Announce a confirmed character using the same recording as the result sequence. */
export function announceHero(char: number, family: VoiceFamily = 'c') {
  const announcement = customVoices(char)?.announcement;
  if (announcement) sfx.playFile(announcement.file, 0.8, true);
  else charVoice(family, char, 1);
}

/** FUN_80089fa4 / FUN_8008a200, individual versus. A wait of N skips N whole updates. */
export function winnerVoice(game: string, char: number, previousFrame: number, frame: number) {
  const family = RESULT_BANK[game];
  if (!family) return;
  if (previousFrame < 0 && frame >= 0) sfx.enterRoundResult('winner');
  const cheerFrame = winnerCheerFrame(char);
  const crosses = (at: number) => previousFrame < at && at <= frame;
  if (crosses(WINNER_NAME_FRAME)) announceHero(char, family);
  if (crosses(cheerFrame - 31)) sfx.playFile('sfx/0278/14.mp3', 0.9, true);
  if (crosses(cheerFrame)) charVoice(family, char, 7);
}

/** Warm the round's announcer cues before the match countdown. */
export function preloadRoundVoices(game: string, chars: number[]) {
  for (const index of [4, 5, 8, 9, 10, 11]) sfx.preloadFile(`sfx/0277/${index}.mp3`);
  sfx.preloadFile('sfx/0278/14.mp3');
  const family = RESULT_BANK[game];
  if (!family) return;
  const characters = new Set(chars);
  for (const char of characters) {
    const custom = customVoices(char);
    if (!custom) continue;
    sfx.preloadFile(custom.announcement.file);
    for (const file of new Set([...custom.hits, ...Object.values(custom.cues)])) {
      if (file) sfx.preloadFile(file);
    }
  }
  void load().then(() => {
    if (!data) return;
    for (const char of characters) {
      if (customVoices(char)) continue;
      const block = voiceBlock(char);
      const bank = data.families[family][block];
      const ids = [...HIT[engineOf(char)], block * 50 + 1, block * 50 + 7];
      if (game === 'ringDing') ids.push(...[2, 0xc, 0xd, 0xe].map(n => block * 50 + n));
      for (const id of ids) {
        const file = data.ids[bank]?.[id];
        if (file) sfx.preloadFile(file);
      }
    }
  });
}

/** Generic spin attack (exe states 8 / 10): engine chars 1-2 play `n 0xd` (anim 8), 3-4 `n 0xe` (anim 10), the others' spin clips are silent. */
export function spinVoice(family: VoiceFamily, char: number | undefined) {
  if (char == null) return;
  const e = engineOf(char);
  if (e <= 2) charVoice(family, char, 0xd, 1);
  else if (e <= 4) charVoice(family, char, 0xe, 1);
}
