// Character voices, as the game plays them. Each character has a voice bank per game family (disc t0c 0182-0213, picked
// per level at load; matched against the RAM dumps). A VAB tone carries its own sound id (FUN_8002aca0), and ids are
// block*0x32 + n per character. Hit voice = one of the four ids at 0x8009e080 + engineChar*8 (rand(4)), the same in
// every level dump. Built by the scratch vabids step into assets/audio/voices.json {families, ids}.
import { sfx, sfxRate } from './sound';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { ASSET_BASE } from '../crash';

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

/** Play sound id `id` from the voice bank of the family that owns it (id / 0x32 = voice block). */
export function playVoiceId(family: VoiceFamily, id: number, vol = 0.8) {
  if (!data) { void load().then(() => { if (data) playVoiceId(family, id, vol); }); return; }
  const bank = data.families[family]?.[Math.floor(id / 0x32)];
  const f = bank && data.ids[bank]?.[String(id)];
  // the tone's own pitch for this id (several ids share a sample at different pitches, e.g. the last two hit voices)
  if (f) sfx.playFile(f, vol, true, sfxRate(bank, id));
}

/** The game's hit voice: rand(4) of the character's four hit ids (0x8009e080). */
export function hitVoice(family: VoiceFamily, char: number | undefined, vol = 0.8) {
  if (char == null) return;
  const ids = HIT[engineOf(char)];
  playVoiceId(family, ids[Math.floor(Math.random() * 4)], vol);
}

/** voice block (id / 0x32) of a character = the block its hit ids sit in */
export const voiceBlock = (char: number) => Math.floor(HIT[engineOf(char)][0] / 0x32);

/**
 * A voice from a character's anim script (`0x8008 id`, id = block*0x32 + n with the same n for every character),
 * optionally after `delay` 30 Hz ticks (the script frame it sits on).
 */
export function charVoice(family: VoiceFamily, char: number | undefined, n: number, delay = 0, vol = 0.8) {
  if (char == null) return;
  const id = voiceBlock(char) * 0x32 + n;
  if (delay > 0) setTimeout(() => playVoiceId(family, id, vol), (delay * 1000) / 30);
  else playVoiceId(family, id, vol);
}

/** Preload the voice table (and the given characters' hit samples). */
export function preloadVoices(family: VoiceFamily, chars: number[]) {
  void load().then(() => {
    if (!data) return;
    for (const c of chars) for (const id of HIT[engineOf(c)]) {
      const bank = data.families[family]?.[Math.floor(id / 0x32)], f = bank && data.ids[bank]?.[String(id)];
      if (f) sfx.playFile(f, 0); // warms the cache (silent)
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
