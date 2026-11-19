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
* `sfx/<bank>/<n>.mp3` - one mono mp3 per VAG of each t0c bank (132 banks, 1649 samples, 755 unique files, ~10 MB). Samples that are
  byte-identical to one in an earlier bank have `file` pointing at that earlier file (so a path in the index may name another bank's
  directory). Silent/stub VAGs (e.g. vag0, 84 samples) have `file: null`.
  Per sample the index gives duration, assumed playback rate, peak, loop start (seconds; null = one-shot).
* `voices.characters.<name>.banks[0..3]` = 4 voice sets per character; `voices.setByFamily` maps minigame family -> set index.

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

## SFX / voice caveats
* Playback rate is not stored. Banks are played by the game with explicit pitch; assumed note 60: `rate = 44100 * 2^((60 - root)/12)`.
  This gives round rates (11025, 22050, 12000...) and round durations (the 10.0 s / 20.0 s single-sample banks 0226-0271 come out at
  exactly 22050 Hz), so it is likely right, but unverified by ear. `rate` is in the index so a client can resample.
* Banks 0214-0271 are single long samples (10-20 s, tone center 72/73): probably narration/commentary or long ambience; not identified.
* UI sounds (`sfx.ui.guesses`) are guesses from duration/spectrum only (short sharp one-shots in 0272/0273).
* Level SFX banks are in `sfx.levelBanks[<level name>]`; global banks: 0153, titles 0273, warp rooms 0272, podium 0181.

## Character voices (partial)
Banks 0182-0213 are 4 sets x 8 voices: set k = banks `182+8k .. 189+8k`; voice id i uses offset `[6,7,5,4,1,0,3,2][i]` inside a set
(the exe record at 0x80058b88+20*45 is 14 rows of 8 banks in this order; row = minigame family 0x101..0x10e, set per row:
4,4,4,4,4,1,2,2,3,2,3,1,4,4). Pitch analysis confirms 8 distinct speakers consistent across all 4 sets. **Which id is which character is
not established**: names in the index (crash, coco, tiny, dingodile, cortex, nbrio, kongKoala, rillaRoo) are assigned in that assumed
order and the rough f0 per voice (115-384 Hz) does not match expectations (e.g. id 5 = 115 Hz would be N. Brio), so treat names as
unverified and listen once to fix the mapping (edit `CHAR_ORDER` / `offs` in cmdIndex).

## Not rendered / unknown
* seq0 of every t10/t14 (identical 786-event single-channel sequence, program 0 of each bank, 12384 ticks): purpose unknown.
* Bank 0301 (SCRIPT STUFF music) is empty (1 stub sample).
* Real PS1 SPU reverb, Gaussian interpolation and exact volume curve are approximated, so timbre/level balance differ slightly from hardware.

## Per-id pitch (tools/sfx_pitch.py -> assets/audio/pitch.json)
Every effect and voice id is keyed at note 60 (FUN_80022660 pitch 0x1e00 >> 7) against its VAB tone's centre note and fine
tune, which raises the pitch: SPU rate = 44100 * 2^((60 - centre + fine/128) / 12). The game often reuses one sample for
several ids at different pitches (504 ids in 70 banks are not at x1, e.g. the last two of every hit voice at ~0.956, mushroom
explosions 1 / 0.919 / 0.844 / 0.782). `sfxRate(bank, id)` in web/client/shell/sound.ts returns the rate; voices apply it in
`playVoiceId`, the games pass it where they know the id (Tank, Dash, Ballistix, Pogo, Ring Ding, Dragon Drop, Mallet, Polar Push, Crate Crush, podium).
Checked on an emulator recording of the podium: matched filtering finds the firework bangs at x1.00 and x0.93 only, and with
this formula the crackle tones land exactly on their VAGs' own rates (13011 / 12493 Hz).
Level banks verified on the RAM dumps (loaded tone table == disc bank): Crate Crush 0167, Tank 0159/0162/0160/0161, Pogo 0171,
Ballistix 0157, Polar (TILT) 0450, Crash Dash 0175, Dragon Drop 0180, Ring Ding 0179, Mallet 0178, Keg 0177, podium 0181; plus 0278
shared in every level. index.json levelBanks has Ring Ding / Dragon Drop (and the Polar levels) under the wrong names; both games
now use their verified bank.
Crate Crush passes the ids of its rand-4 wood / TNT / nitro lists (0x3e8.., 0x3ec-0x3ef, 0x3f1..).
A/B check (2026-11-19): 25 s of the real podium (emulator OpenAL gain -> MediaRecorder) and 25 s of ours (app AudioContext ->
MediaRecorder), same matched-filter search over playback rates 0.82-1.02: both find each bang sample (0181/3-5) at x1.00 and x0.93
and nowhere else.
