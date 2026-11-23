// Character voices, as the game plays them. Each character has a voice bank per game family (disc t0c 0182-0213, picked
// per level at load by FUN_80022140 from the exe table 0x80058f0c[family - 0x101][engineChar - 1]). A VAB tone carries
// its own sound id (FUN_8002aca0), and ids are block*0x32 + n per character. Hit voice = one of the four ids at
// 0x8009e080 + engineChar*8 (rand(4)), the same in every level dump. tools/sfx_pitch.py builds
// assets/audio/voices.json {families, ids} and pitch.json from the VABs. Proofs: docs/audio.md.
import { sfx, sfxRate } from './sound';
import { CHARACTERS, DISC_CHARACTER, WINNER_NAME_FRAME, winnerCheerFrame } from '../../shared/look';
import { ASSET_BASE } from '../crash';
export { winnerCheerFrame } from '../../shared/look';

/** Voice-bank family per game (exe table 0x80058f0c; banks 0182-, 0190-, 0198-, 0206-). */
export type VoiceFamily = 'tank' | 'a2' | 'b' | 'c';

/**
 * Every voice and announcer id keys at volume 0x1000 and pitch 0x1e00 without a position (FUN_8008a200, the anim
 * script op 0x8008, the title overlay): one level for all of them.
 */
export const VOICE_VOL = 0.9;

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
  /** Gain per cue (3 = the hit takes) that brings a recording to the stock roster's mean level for that cue. */
  level: Partial<Record<number, number>>;
}

// A custom character has a recording for every cue a stock character voices: 1 name, 2 taunt, 3-6 hit, 7 win, the
// family c set (0xc jump, 0xd land / spin, 0xe spin, 0xf pick-up, 0x10 throw) and the family b set (0x16 / 0x18 dash,
// 0x17, 0x19-0x1b the teeter yelps of Cortex's Polar scripts). The remaining ids are foley (0xa / 0xb footsteps, 0x11,
// the polar bear's 0x14 / 0x15 / 0x1c) and come from Cortex's bank, whose scripts both characters run.
const CUSTOM_VOICES: Partial<Record<string, CustomVoices>> = {
  'big-stein': {
    announcement: { file: 'sfx/custom/big-stein.mp3' },
    hits: [STEIN + 'hit-1.mp3', STEIN + 'hit-2.mp3'],
    cues: {
      2: STEIN + 'taunt.mp3',
      7: STEIN + 'win.mp3',
      0xc: STEIN + 'effort.mp3',
      0xd: STEIN + 'effort.mp3',
      0xe: STEIN + 'effort.mp3',
      0xf: STEIN + 'effort.mp3',
      0x10: STEIN + 'effort.mp3',
      0x16: STEIN + 'effort.mp3',
      0x17: STEIN + 'effort.mp3',
      0x18: STEIN + 'effort.mp3',
      0x19: STEIN + 'effort.mp3',
      0x1a: STEIN + 'effort.mp3',
      0x1b: STEIN + 'effort.mp3',
    },
    level: { 2: 1.2, 3: 1.8 },
  },
  'top-g': {
    announcement: { file: TOP_G + 'name.mp3' },
    hits: [TOP_G + 'hit-1.mp3', TOP_G + 'hit-2.mp3'],
    cues: {
      2: TOP_G + 'taunt.mp3',
      7: TOP_G + 'win.mp3',
      0xc: TOP_G + 'effort.mp3',
      0xd: TOP_G + 'effort.mp3',
      0xe: TOP_G + 'effort.mp3',
      0xf: TOP_G + 'pickup.mp3',
      0x10: TOP_G + 'effort.mp3',
      0x16: TOP_G + 'dash.mp3',
      0x17: TOP_G + 'effort.mp3',
      0x18: TOP_G + 'dash.mp3',
      0x19: TOP_G + 'effort.mp3',
      0x1a: TOP_G + 'effort.mp3',
      0x1b: TOP_G + 'effort.mp3',
    },
    level: { 2: 1.3, 3: 1.6, 7: 1.2 },
  },
};
const customVoices = (char: number) => CUSTOM_VOICES[characterId(char) ?? ''];
/** Cortex's bank keys hit ids 5 and 6 on the samples of 3 and 4 at this pitch (centre 87 + 66 / 128 against 86 + 38 / 128). */
const CUSTOM_HIT_RATE = 0.96;
/** The custom recording for cue `n` (block-relative id), its pitch and its level. */
function customCue(char: number, n: number): { file: string; rate: number; gain: number } | undefined {
  const custom = customVoices(char);
  if (!custom) return undefined;
  if (n === 1) return { file: custom.announcement.file, rate: 1, gain: 1 };
  if (n >= 3 && n <= 6) return { file: custom.hits[(n - 3) % custom.hits.length], rate: n >= 5 ? CUSTOM_HIT_RATE : 1, gain: custom.level[3] ?? 1 };
  const file = custom.cues[n];
  return file ? { file, rate: 1, gain: custom.level[n] ?? 1 } : undefined;
}
type PlayCue = (file: string, volume: number, rate: number) => void;
const playCue: PlayCue = (file, volume, rate) => { sfx.playFile(file, volume, true, rate); };

/** Play sound id `id` from the voice bank of the family that owns it (id / 0x32 = voice block). */
export function playVoiceId(family: VoiceFamily, id: number, vol = VOICE_VOL, play = playCue) {
  if (!data) { void load().then(() => { if (data) playVoiceId(family, id, vol, play); }); return; }
  const bank = data.families[family]?.[Math.floor(id / 0x32)];
  const f = bank && data.ids[bank]?.[String(id)];
  // the tone's own pitch for this id (several ids share a sample at different pitches, e.g. the last two hit voices)
  if (f) play(f, vol, sfxRate(bank, id));
}

/** The game's hit voice: rand(4) of the character's four hit ids (0x8009e080). */
export function hitVoice(family: VoiceFamily, char: number | undefined, vol = VOICE_VOL, variation = -1, play = playCue, stockCue?: () => void) {
  if (char == null) return;
  const take = variation >= 0 ? variation & 3 : Math.floor(Math.random() * 4);
  const custom = customCue(char, 3 + take);
  if (custom) {
    play(custom.file, vol * custom.gain, custom.rate);
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
export function charVoice(family: VoiceFamily, char: number | undefined, n: number, delay = 0, vol = VOICE_VOL, discId?: number, player = playCue) {
  if (char == null) return;
  const custom = customCue(char, n);
  const id = discId ?? voiceBlock(char) * 0x32 + n;
  const play = () => custom ? player(custom.file, vol * custom.gain, custom.rate) : playVoiceId(family, id, vol, player);
  if (delay > 0) setTimeout(play, (delay * 1000) / 30);
  else play();
}

/** A vehicle can supply a level-bank sound for stock pilots and a roster cue for custom pilots. */
export function vehicleVoice(char: number, cue: number, stock: () => void) {
  const custom = customCue(char, cue);
  if (custom) playCue(custom.file, VOICE_VOL * custom.gain, custom.rate);
  else stock();
}

/** Taunts use the custom line or the script's authored cue, if it has one. */
export function tauntVoice(family: VoiceFamily, char: number | undefined, discId?: number) {
  if (char != null && customCue(char, 2)) charVoice(family, char, 2);
  else if (discId != null) playVoiceId(family, discId);
}

const RESULT_BANK: Record<string, VoiceFamily> = {
  ballDefence: 'a2', tilePainter: 'a2', dashRace: 'a2', tankArena: 'tank',
  pushOff: 'b', ringDing: 'c', crateToss: 'c', dragonDrop: 'b', malletMash: 'c', kegKaboom: 'c',
};

/** The announcer's name call of the result sequence (id block*0x32 + 1, FUN_8008a200 case 0). */
export function announceHero(char: number, family: VoiceFamily = 'c') {
  charVoice(family, char, 1);
}

/**
 * Title overlay 0717, character select (FUN_800b5ca8): a human confirm keys the character's own line from the titles
 * bank 0273 (table 0x800b9b44, 0x28 per cell: engine char +4, sound id +0x20), not the announcer's name call.
 * Ids by engine character 1..8; the bank's sample is id - 898. Four are the win cheer (n 7), four the taunt (n 2).
 */
const SELECT_LINE = [0, 910, 911, 913, 912, 916, 917, 914, 915];

/** Confirming a character on the title screen. Custom characters play their taunt, as Cortex does. */
export function confirmHero(char: number) {
  const custom = customCue(char, 2);
  if (custom) { playCue(custom.file, VOICE_VOL * custom.gain, custom.rate); return; }
  const id = SELECT_LINE[engineOf(char)];
  playCue(`sfx/0273/${id - 898}.mp3`, VOICE_VOL, sfxRate('0273', id));
}

function stageCall(game: string, variant?: string | null) {
  return `sfx/custom/stages/${game}${variant ? '_' + variant : ''}.mp3`;
}

export function preloadStageCall(game: string, variant?: string | null) {
  sfx.preloadFile(stageCall(game, variant));
}

/** Ours: the disc has no stage-name recordings (banks 0276-0278 hold the whole announcer; see docs/audio.md). */
export function announceStage(game: string, variant?: string | null) {
  sfx.playFile(stageCall(game, variant), .85, true);
}

/** FUN_80089fa4 / FUN_8008a200, individual versus. A wait of N skips N whole updates. */
export function winnerVoice(game: string, char: number, previousFrame: number, frame: number) {
  const family = RESULT_BANK[game];
  if (!family) return;
  if (previousFrame < 0 && frame >= 0) sfx.enterRoundResult('winner');
  const cheerFrame = winnerCheerFrame(char);
  const crosses = (at: number) => previousFrame < at && at <= frame;
  if (crosses(WINNER_NAME_FRAME)) announceHero(char, family);
  if (crosses(cheerFrame - 31)) sfx.playFile(WINS, VOICE_VOL, true, sfxRate('0278', 0x1b0));
  if (crosses(cheerFrame)) charVoice(family, char, 7);
}
/** "wins", id 0x1b0 of the versus announcer bank 0278 */
const WINS = 'sfx/0278/14.mp3';

/** Warm the round's announcer cues before the match countdown. */
export function preloadRoundVoices(game: string, chars: number[]) {
  for (const index of [4, 5, 8, 9, 10, 11]) sfx.preloadFile(`sfx/0277/${index}.mp3`);
  sfx.preloadFile(WINS);
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
