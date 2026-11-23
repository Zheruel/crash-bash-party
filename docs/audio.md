# Audio (music + SFX) rendered from the disc

Output: `assets/audio/` (index: `assets/audio/index.json`). Tool: `tools/render_music.ts`
(`cd web && npx tsx ../tools/render_music.ts music|sfx|index|all [--only 0296,0294]`; needs ffmpeg with libmp3lame).
Sources: `disc/dat/NNNN.t10|t14|t0c.bin` (format: `docs/formats/arenas.md` section 1). Level -> bank mapping: `assets/arenas.json`
(= exe table 0x80058b88).

## Layout
* `music/<key>.mp3` - 44.1 kHz stereo, 96 kbps CBR, ~35 MB total. Each file = intro + **one** loop body. `index.json` gives
  `loopStart`/`loopEnd` (seconds); use `AudioBufferSourceNode.loop = true; loopStart; loopEnd`. Tail reverb/release of the loop end is
  folded onto the loop start, so the wrap is seamless (MP3 encoder delay is covered by the LAME/Xing header; browsers trim it, but
  gapless looping of MP3 is a decoder feature, re-check on Safari).
* Keys: warp, warp2 (2nd warp-room tune), title, podium, the 27 requested names plus extras (papuPummel, bigBadFox, bearminator, ringDing,
  dragonDrop, malletMash, kegKaboom, oxideRide, tieBreaker) and `extra_0300` (unreferenced bank 0300, 12 s). The game itself shares
  tracks between levels (e.g. 0298 = meltPanic + drainBash, 0286 = nballism + pogoAGogo, 0283 = swampFox + dantesDash + dragonDrop,
  0285 = dotDash + splashDash + oxideRide, 0290 = papuPummel + tieBreaker, 0280 = metalFox + bigBadFox, 0279 = tiltPanic + ringDing,
  0292 = malletMash + kegKaboom). Requested names have their own file copies; extras alias the primary file in the index.
* `sfx/<bank>/<n>.mp3` - one mono mp3 per VAG of each t0c bank (132 banks, 1649 samples, 755 unique files, ~12 MB), 44.1 kHz,
  64 kbps, rendered as an SPU voice plays it (see "SFX rendering"). Samples that are
  byte-identical to one in an earlier bank have `file` pointing at that earlier file (so a path in the index may name another bank's
  directory). Silent/stub VAGs (e.g. vag0, 84 samples) have `file: null`.
  Per sample the index gives duration, playback rate at note 60, peak, loop start (seconds; null = one-shot).
* `voices.characters.<name>.banks[0..3]` = 4 voice sets per character; `voices.setByFamily` maps minigame family -> set index
  (informational; the client reads `voices.json`).

## How music is rendered
1. `parseSoundBank` (web/client/disc/sound.ts) decodes ADPCM, VAB, SEQ. Extra VAB tone bytes (reverb flag = mode 4, pitch-bend range) read directly.
2. SEQ playback: note on/off, program change, CC7 volume, CC10 pan, CC11 expression, CC64 sustain, pitch bend (tone bend range, default +-2).
   One note triggers every tone of its program whose key range matches (layers/stereo pairs). Tempo meta supported (none used on disc).
   Loop markers: CC99 = 20 loop start, 30 loop end (16 = data start); the section before loop start is the intro.
3. Voices: Catmull-Rom resampling at 44.1 kHz, pitch = 2^((note - root)/12) with **root = center - fine/128** (measured: autocorrelating
   160 looping samples against their VAB center/fine gives mean error 0.17 semitone for this sign vs 1.03 for `+`), ADPCM loop flags honoured,
   hardware-style PS1 ADSR (attack/decay/sustain/release shifts and steps from the raw SPU register words), per-tone/program volume x velocity x CC7 x CC11,
   equal-power pan from CC10 + tone/program pan.
4. Reverb: tones flagged "reverb on" feed a Freeverb-style stereo reverb (wet 0.9 of a small send). **Not** the real SPU reverb (preset
   unknown), so the room sound is approximate.
5. Loudness: each track normalised to RMS 0.12 (-18 dBFS) with a peak ceiling of 0.94 (all tracks end at -0.6 to -2.5 dBFS after mp3). No clipping.

Checks done: pitch pipeline (rendered a note at a tone's root and measured f0: within 0.4 semitone of the sample's own measured pitch);
no silent tracks, no clipping; lengths 28-149 s plausible for bpm / tick counts (e.g. crashball 160 bpm 6/4, 105216 ticks = 102.7 s).
Nothing was listened to by a human.

## SFX rendering
* A sample's rate is `44100 * 2^((60 - centre + fine/128) / 12)` of the first tone that uses it (the index `rate`; other tones on
  the same sample are in `pitch.json`, below). `render_music.ts sfx` steps the decoded ADPCM at that rate through the SPU's four-point
  Gaussian interpolation (`spuVoice`; the hardware table as listed in the PSX-SPX hardware documentation, "4-Point Gaussian
  Interpolation") and encodes the 44.1 kHz result. Against a band-limited resample this rolls off the top octave (-1.7 dB at a
  quarter of the source rate, about -7 dB at half) and keeps the images above it (7-28 dB down), which is how the console plays
  its 6-22 kHz voices and effects. Durations are unchanged (60 files checked: max 0.5 ms).
  The old files were Catmull-Rom resamples at 8-32 kHz: flat to their Nyquist and empty above it.
* Emulator check (2026-11-23, pcsx_rearmed in EmulatorJS, music option poked to 0, OpenAL gain node -> ScriptProcessor PCM):
  "one" / "GO" from bank 0278 correlate 0.98 / 0.91 with our files. The capture has energy above the sample's Nyquist (33 / 27 /
  25 dB in 6-8 / 8-10 / 10-12 kHz against 58 dB in 500-1000 Hz for "one") where the old files had none. That core uses its
  "simple" interpolation, which is brighter than the hardware's Gaussian (no top-octave droop, stronger images), so the rendered
  files sit between the old ones and that capture above 6 kHz and 2-6 dB under it in 3-6 kHz.
* Tone ADSR is not applied (all voice and announcer tones are 0x800f / 0x1fc4: instant attack, full sustain).
* `sfx.ui.guesses` in index.json are unused guesses; the client plays the menu ids listed under Announcer.
* Level SFX banks are in `sfx.levelBanks[<level name>]`; global banks: 0153, titles 0273, warp rooms 0272, podium 0181.
* Banks 0214-0271 are single 10-20 s samples: the Aku Aku / Uka Uka narration of the adventure mode (warp-room progress lines and
  the intro / ending dialogue; transcribed with faster-whisper, e.g. 0217 "...you must defeat the mighty Papu Papu", 0268 "Crash,
  Cortex, welcome..."). Nothing in them names an arena.

## How a sound id is played (exe)
* `FUN_80022660(id, handle, pos, volume, pitch, flags)` queues a sound; `FUN_8002235c` keys it on the next sound update through
  `FUN_8002b5b0` -> `SsUtKeyOn(vab, program, tone, note = pitch >> 7, fine = pitch & 0x7f, voll, volr)` (`FUN_800374cc`).
  Table `0x80064508 + id*2` = {VAB slot, program << 4 | tone}; `FUN_8002aca0` fills it from every loaded VAB, whose tones carry their
  own id in the min / max note bytes. 0xff = not loaded = silent.
* Volume: `voll = volume * effectsOption(0x8005a608, 0-100) * 0x7f / 0x64000`, so 0x1000 at option 100 = 127. `FUN_80042b4c`
  (SpuVmKeyOnNow) turns it into the SPU level `0x3fff * voll/127 * VAB master/127 * program volume/127 * tone volume/127`, with
  tone / program / call pan. It is linear for `SsUtKeyOn` voices; only sequence notes are squared. Every voice and announcer tone
  has volume 127 and pan 64, so all of them play at one level.
* With a position (`pos != 0`) `FUN_8002b210` scales the volume by distance from the camera target (box `0x80064478`) and, in stereo
  (`0x8005a60c`), pans by screen x. Without one both channels get `volume`.
* Pitch: `FUN_80042a20` = `2^((note - centre + (fine + shift) / 128) / 12)` from two tables. Every announcer and voice call passes
  0x1e00 (note 60, fine 0); the only other pitch found in the arena overlays is the Polar Push engine loop (`0x1d80 + speed`).
* Anim script ops (`FUN_8008502c`): `0x8008 id` plain, `0x8009 id` at the player's position, `0x800a id` on the player's handle
  (a new one stops the previous), `0x800b` stop the handle; all at 0x1000 / 0x1e00.
* Options defaults read from RAM at the game options screen: music 70, effects 100, stereo on.

## Character voices
* Engine character ids: 1 Crash, 2 Coco, 3 Cortex, 4 N. Brio, 5 Tiny, 6 Koala Kong, 7 Dingodile, 8 Rilla Roo. Proof:
  * The title overlay's character-select table (`0x800b9b44`, 0x28 per cell, read from a title-screen RAM dump) lists engine ids
    1, 2, 5, 7 / 3, 4, 6, 8 for the two rows the game shows as Crash, Coco, Tiny, Dingodile / Cortex, Brio, Koala Kong (grey koala
    portrait), Rilla Roo (pink face, brown quiff). Confirming the eighth cell writes 8 to `0x8005a664` and puts the ape in striped
    trunks on the pedestal; a CPU with id 6 is the grey koala in the red vest (emulator screenshots).
  * The announcer's name call of each voice block (`FUN_8008a200` case 0: engine 1-8 -> ids 1, 0x33, 0x65, 0x97, 0x12d, 0x15f, 0xfb,
    0xc9) transcribes as Crash, Coco, Cortex, Brio, Tiny, "Kong", Dingodile, "Rilla Roo" (faster-whisper large-v3).
  * Model slots (`assets/arenas.json`): engine 6 = model 976, engine 8 = model 978.

  The roster ids `koala` (model 978, engine 8) and `rilla` (976, engine 6) were named the wrong way round; `shared/look.ts` now
  gives them the right display names (the ids stay as asset keys).
* Voice block of an engine character = id / 0x32: 1 -> 0, 2 -> 1, 3 -> 2, 4 -> 3, 5 -> 6, 6 -> 7, 7 -> 5, 8 -> 4 (the name-call switch
  above and the hit table `0x8009e080 + char*8`, identical in all 15 level dumps).
* Bank per family and character: `FUN_80022140` loads `0x80058f0c[(family - 0x101) * 8 + char - 1]` for each of the four players
  (families 0x101 titles and 0x102 warp / podium load none). Rows: 0x103 Ring Ding, 0x104 Crate Crush, 0x105, 0x10d Keg Kaboom,
  0x10e Mallet Mash = 0206-0213 (`c`); 0x106 Tank Wars, 0x10c = 0182-0189 (`tank`); 0x107 Pogo, 0x108 Ballistix, 0x10a Crash Dash =
  0190-0197 (`a2`); 0x109 Polar Push, 0x10b Dragon Drop = 0198-0205 (`b`). Inside a set the order is Koala Kong, Tiny, Rilla Roo,
  Dingodile, Brio, Cortex, Crash, Coco. The loaded id table of every level dump agrees (L28 Dragon Drop holds ids 0x14-0x1a, L43
  podium holds no voice ids).
* The same function loads the announcer: 0276 for titles / warp / podium, 0278 in versus (mode word `0x8005a646 & 0x1e0 == 0`),
  0277 otherwise, next to the level bank.
* Ids a bank holds (n = id - block*0x32), and who keys them:

  | n | sound | family | keyed by |
  |---|---|---|---|
  | 1 | announcer: the character's name | all | `FUN_8008a200` case 0, 31 updates after the winner's entry |
  | 2 | taunt | all | generic script 2 (`0x800a`); Tank Wars table `0x800c94a8[char - 1]` at the tank; Ballistix taunt |
  | 3-6 | hit: two takes at two pitches (5 / 6 = 3 / 4 at x0.95-0.96; Tank bank: one take at 1, 1.011, 0.95, 0.947) | all | rand(4) of `0x8009e080` (Crate Crush hurt, Polar bump, Crash Dash, Dragon Drop); Tank `0x800c9428` and Keg `0x800bb95c` (same ids, at the player); n 3 alone from Ring Ding script 0x2b and the Pogo stun |
  | 7 | win reaction | all | `FUN_8008a200` case 2 |
  | 0xa, 0xb | footsteps | c | Crate Crush hold-walk script 0x11; Keg Kaboom steps |
  | 0xc | jump | c | generic script 6, Ring Ding 0x2c, Keg 0x65 |
  | 0xd | land / spin swish | c | generic script 8 (`0x8009`), Keg 0x67 |
  | 0xe | spin | c | generic script 10 |
  | 0xf | pick-up | c | Crate Crush script 0xf |
  | 0x10 | throw | c | Crate Crush script 0x12 (Pogo asks for it too, but the `a2` banks have no such tone) |
  | 0x11 | swish (unvoiced) | c | not found in a script |
  | 0x14, 0x15, 0x1a | on-foot footsteps (one sample at 1, 0.871, 0.667) | b | Polar script 0x43 |
  | 0x16 | dash start | b | Polar script 0x3e, engine 8 only (tick 1) |
  | 0x17 | short call | b | not found in a script |
  | 0x18 | dash | b | Polar script 0x3e at tick 15, 14, 30, 30, 23, 12, 16, 16 for engine 1-8; script 0x46 |
  | 0x19-0x1b (0x1a, 0x1b for Cortex), 0x1c | win cheers; 0x1c is Cortex's on-foot dash | b | Polar script 0x46 |

  All tones: volume 127, pan 64, no reverb. `tools/sfx_pitch.py` writes `voices.json` and `pitch.json` from the VABs and the exe table.
* Scripts can name another character's id (Keg Kaboom: Cortex's jump is Tiny's 0x138, Dingodile's landing is Tiny's 0x139).

## Announcer
* Banks 0276 (menus), 0277 (adventure), 0278 (versus) share ids 0x190-0x195 (menu blips), 0x19b-0x19f (horn, cup jingles) and
  0x1a4-0x1a7 = "one", "two", "three", "GO". 0277 adds 0x1b8-0x1bb "you", "win", "lose", "time up"; 0278 adds 0x1ae "team", 0x1af
  "tie" (the draw call), 0x1b0 "wins", 0x1b1, 0x1b2. Transcribed with faster-whisper; there is no other speech in them.
* Countdown (`FUN_80082d90`): 0x1a6, 0x1a5, 0x1a4 with the numeral meshes 0x2004-0x2002, then 0x1a7 with GO. Emulator capture of
  Jungle Bash: "three" / "two" / "one" / "GO" on frames +18 / +46 / +74 / +103 after the rules card (28 updates apart), each at the
  same level (gain 0.19 per channel against the sample; the character lines on the title screen measure the same).
* Winner (`FUN_80089fa4` / `FUN_8008a200`): name on update 31, "wins" (0x1b0) after 24-27 further updates by character (the switch
  stores 0x17 / 0x18 / 0x1a), the win reaction 31 later. Headless capture of `winnerVoice` at 30 Hz for six characters: name /
  "wins" / reaction on frames 31 / 31 + wait / 62 + wait within 0.4 of a frame, all at one level.
* Character select (title overlay 0717.t67, `FUN_800b5ca8`): moving the cursor keys `0x800b9cb4[seat]` = 901-904, a human confirm
  keys the cell's line `0x800b9b64 + cell*0x28` and the seat's `0x800b9ca4[seat]` = 905-908 on the same update, a taken cell keys
  0x38d. CPUs get the seat sound only. The line is the character's own voice from the titles bank 0273, not the announcer:
  engine 1-8 -> ids 910, 911, 913, 912, 916, 917, 914, 915 = the win reaction of Crash, Coco, Tiny and Koala Kong and the taunt of
  Cortex, Brio, Dingodile and Rilla Roo. Emulator captures of all eight confirms match these samples (correlation 0.4-0.75 under the
  menu music, on the press); `confirmHero` plays them, and the capture of our app correlates 0.69-0.77 with the emulator's.
* Menu blips (`Sfx` in `sound.ts`): the titles / level-select / options code (`FUN_800babec`, `FUN_8008f554`, `FUN_80090e20`) keys
  0x190 on every cursor step, 0x192 on a confirm and 0x195 on back, all at 0x1000 / 0x1e00 without a position. They are the
  one-shot samples `sfx/0274/1.mp3`, `sfx/0274/2.mp3` and `sfx/0272/7.mp3`. The client plays exactly these for its own menus
  (buttons, stage vote, stage reel). Every other party-UI cue (points tally, emotes, wheel whoosh, awards, "AND THE WINNER IS")
  has no original counterpart and is silent; the podium scene brings its own bank-0181 cues.
* Stage names: the disc has no recording of an arena name. The arena is named in text on the CHOOSE LEVEL screen and the rules
  card. A 40 s capture from the game options screen through loading to the rules card contains no speech. Nothing announces a
  stage. Ours does on purpose (party feature, by request): `announceStage` plays a custom call from `sfx/custom/stages` when the reel
  lands, and on round 1 of a host-picked stage. The reel clicks use warp-room samples 0272/7 (tick) and 0272/9 (landing).
* Nothing is synthesised: `sound.ts` has no oscillator or noise code.
* Podium (family 0x102): no character bank is loaded. The winner's crowd cheer is 0x352 (engine 1, 2), 0x354 (3, 4, 6, 8) or 0x353
  (5, 7) from bank 0181.

## Mix
* Emulator captures at the disc's default options: a full-level effect measures 0.19 per channel against its sample; the music of
  Pogo Painter, Crashball, Tilt Panic and Jungle Bash measures 0.025, 0.023, 0.021 and 0.030-0.037 RMS. Against that ratio our
  default sliders (music 0.6, effects 0.8) had the music 1.3-7.5 dB low (mean 3.9 dB), so `sound.ts` trims the buses by 1.25 and 0.8.
  The spread between tracks is real: the tracks are normalised to one RMS when rendered.
* `VOICE_VOL` is the one level of every voice and announcer cue in `voice.ts`.

## Custom characters (Big Stein, Top G)
Both run Cortex's scripts (engine 3). `CUSTOM_VOICES` gives each its own original line set (generated locally by
`tools/generate_custom_voices.py`, no real recordings or quotes) for every voiced id: 1 name, 2 taunt, 3-6 hit, 7 win, 0xc jump, 0xd land,
0xe spin, 0xf pick-up, 0x10 throw (Pogo included), 0x16 dash start, 0x17 call, 0x18 dash, 0x19-0x1b win cheers. Cues with several takes
pick one at random; each take is level-matched to the stock roster's mean for that cue. Foley ids (0xa, 0xb, 0x11, 0x14, 0x15, 0x1c)
come from Cortex's bank. Lose and draw takes exist on disk but are unused, as the original never voices a loser or a draw. Character
select plays the name call (`announceHero`).

## Not rendered / unknown
* seq0 of every t10/t14 (identical 786-event single-channel sequence, program 0 of each bank, 12384 ticks): purpose unknown.
* Bank 0301 (SCRIPT STUFF music) is empty (1 stub sample).
* Music: the real SPU reverb is approximated and the voices are Catmull-Rom resampled (the SFX use the SPU's Gaussian kernel), so the music's timbre differs slightly from hardware.

## Per-id pitch (tools/sfx_pitch.py -> assets/audio/pitch.json)
Every effect and voice id is keyed at note 60 (FUN_80022660 pitch 0x1e00 >> 7) against its VAB tone's centre note and fine
tune (`FUN_80042a20`), which raises the pitch: SPU rate = 44100 * 2^((60 - centre + fine/128) / 12). The game often reuses one sample for
several ids at different pitches (504 ids in 70 banks are not at x1, e.g. the last two of every hit voice at ~0.956, mushroom
explosions 1 / 0.919 / 0.844 / 0.782). `sfxRate(bank, id)` in web/client/shell/sound.ts returns the rate; voices apply it in
`playVoiceId`, the games pass it where they know the id (Tank, Dash, Ballistix, Pogo, Ring Ding, Dragon Drop, Mallet, Polar Push, Crate Crush, podium).
Checked on an emulator recording of the podium: matched filtering finds the firework bangs at x1.00 and x0.93 only, and with
this formula the crackle tones land exactly on their VAGs' own rates (13011 / 12493 Hz).
Level banks verified on the RAM dumps (loaded tone table == disc bank): Crate Crush 0167, Tank 0159/0162/0160/0161, Pogo 0171,
Ballistix 0157, Polar (TILT) 0450, Crash Dash 0175, Ring Ding 0180, Dragon Drop 0179, Mallet 0178, Keg 0177, podium 0181; plus 0278
shared in every level.
Crate Crush passes the ids of its rand-4 wood / TNT / nitro lists (0x3e8.., 0x3ec-0x3ef, 0x3f1..).
A/B check (2026-11-19): 25 s of the real podium (emulator OpenAL gain -> MediaRecorder) and 25 s of ours (app AudioContext ->
MediaRecorder), same matched-filter search over playback rates 0.82-1.02: both find each bang sample (0181/3-5) at x1.00 and x0.93
and nowhere else.

## Individual versus result music

* Pogo's winner entry (`FUN_800c2a8c`) calls the shared announcer setup (`FUN_80089fa4`) as soon as the winner enters the pose, after
  any exit hop. That setup sets the duck flag before the 30-tick name wait. The Pogo loser does not set it (`FUN_800b6960`), so all
  players hear the same music change when the winner enters. The other arena overlays use the same announcer setup for their winners.
* The shared draw handler (`FUN_8007d9dc`) sets the flag on a draw (`FUN_8002c29c`) and arms its 120-tick result timer. States `0xc`/`0xe`
  only clear the flag (`FUN_8002c290`) once that timer reaches zero, on the tick the round leaves, so a draw stays ducked through the
  whole result, the same as a win. The Draw logo cue comes as its scale reaches the threshold in `FUN_80082d90`.
* `FUN_8002bea8` applies the flag on the next sound update. The volume codes are `floor(setting * 0x55 / 100)` while ducked and
  `floor(setting * 0x7f / 100)` normally. `FUN_800447dc` squares the scaled voice level for the SPU, so the web gain uses
  `(0x55 / 0x7f)^2`, about 0.448 (−7.0 dB), with a continuous user slider. `FUN_8002c1c0(100, 5)` sets the sequence tempo back to
  its level value in five sound ticks (`FUN_8003868c` / `FUN_800436fc`). The duck itself changes in one step.
* A win stays ducked through the result until the round resets or leaves. The web applies the multiplier to the arena track and
  carries it through that track's outgoing crossfade. The incoming menu or podium track uses the normal level. The player volume
  and master mute apply independently.
