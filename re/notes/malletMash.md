# Mallet Mash (level 29, overlay family 0x10e) - decoded rules

Source: `re/out_malletMash/ovl.c`, `all.c`, RAM `re/dumps/L29.ram`. Sim: `web/shared/games/malletMash.ts` (+ `malletMashData.ts` anim scripts), view: `web/client/games/malletMash.ts`.
Units: game units, 1024 = 1 model unit, world = game/301.4 (`MM_S`), `world.z = -game.z`. Angles 0..0xfff, 0 = +z. 30 Hz.

## Function map
| addr | role |
|---|---|
| 0x800b33a4.. | overlay start; `FUN_800b34f8` spawner/stage timer |
| FUN_800b3d28 | random free spot (mushroom/crate) |
| FUN_800b4454 | nearest target (mushroom 0x100 / crate 0x200, reach/facing flags) |
| FUN_800b47c8 | owner hits mushroom (points) |
| FUN_800b4910 | shock wave (centre, radius, owner, flag 0x100 = smash mushrooms) |
| FUN_800b5820 | end: rank / win flags |
| FUN_800b5ba0 | AI |
| FUN_800b6e1c | power-up timer; FUN_800b6efc crate update |
| FUN_800b717c | pad -> control; FUN_800b7b48 player push; FUN_800b9054 arena clamp |
| FUN_800b8ef8 | hit: lose power-up |
| FUN_80083e8c | hit request / stun / blink; FUN_80085d2c physics |
| FUN_8008502c / 800854c0 | anim script interpreter / start; FUN_8008a200 cheer sequence |
State handler table `0x8009dca0`; anim scripts `0x8009d29c + char*4`; swing reach table `0x800b9580`; AI dir table `0x80051244`.

## Players
Struct `0x8009d52c + p*0x6c`. Start positions (game) (-1485,-1485) yaw 3584, (-1618,1539) 512, (1572,1606) 1536, (1467,-1509) 2560.
Look index -> engine char: `[1,2,5,7,3,4,8,6]` (shared/look DISC_CHARACTER; engine 5 tiny, 6 rilla roo, 7 dingodile, 8 koala kong). The earlier `[1,2,8,6,3,4,5,7]` mislabelled 5-8.
Walk speed 45 (0x2d), boots 80 for 180 frames. Yaw eases diff>>2/frame. Arena clamp 0x980 minus collision radius (table `[0,219,199,210,184,328,312,259,333]`). Players push each other apart (circle push).
Per-frame order: bookkeeping (hit/stun/blink) -> lock/blink decrement (hidden iff blink%3==0) -> AI -> input->control -> state -> physics -> clamp -> power timer. Mushrooms/crates update after players; AI pad acts one frame late.
Pad: Square 0x8000 = mallet; dpad 0x10 up, 0x20 right, 0x40 down, 0x80 left.

## States / anim (clip index = anim id - 0x33 within the char group)
0x33 idle, 0x34 run, 0x35 windup (state 0x43, 9 frames), 0x36 charge (0x44), 0x37 swing (state 0x45, event 0xc at the strike) then recovery 0x46, 0x38 hurt (state 0x42), 0x39 cheer (state 0x47). Losers enter state 0x48 with idle script 0x33.
Charge continues until anim event 8 AND button released. Shock wave if previous state was 0x44 or power type 1.
Scripts are decoded in `malletMashData.ts` (opcodes 0x8000 goto, 0x8003 n event, 0x8004 n state, 0x8007 n hold). 

### Opening poses

The L29 USA countdown holds input for 99 updates while script 0x33 advances. Coco, Cortex, Rilla and Koala matched all 396 captured pose words. At update 99 their idle frames were 15, 3, 3 and 19. The client samples the consecutive idle keys from each character's script, including Crash's clip 2. At GO the displayed frame agrees with the prepared authoritative snapshot for all ten roster looks. Two Chromium peers sampled the clips on Big Stein's and Top G's mallet models during the countdown. The local actor takes its predicted pose as soon as an action begins.

## Hits and waves
- Swing hits nearest mushroom in reach/facing (`FUN_800b4454`), points 2/3/5 by growth state; gold 10/15/20.
- Normal wave: radius 0x380, players only. Victim: knockback 0x50 (decays 4/frame), hits counter 0x14, loses power-ups, stun 30 frames (input zero) then blink 40.
- Power wave (shock power): radius 0x600, also smashes every mushroom in range for the owner; consumes power. Centre is tag 1 on the strike pose, rotated by actor yaw (FUN_80015780).
- Exploding mushroom (state 5): radius 0x380, owner -1, stuns.

## Mushrooms (10 slots)
States: 0 spot search, 2 wait (ticks only when intro flag clear), 10 rise (13 frames, ys +0x100 to 0xc00), 0xc wait `WAIT0[stage]+rn(WAITR[stage])`, 0xd shake 70 frames (ys 0xb00+rn(0x200)), 0xe shake 40 frames (ys 0x800+rn(0x800)), 5 explode, 4 hit, 6, 1 destroyed if cap < count.
Spot: random in +-0x800, rejected within 0x400 of players/mushrooms, 0x300 of crates; spawn clamp 0x880; spawn cooldown 0x14.
Stages (sec): [15,15,13,10,10]; caps [6,5,5,4,3]; gold timers [600,600,600,450,300], max 4 golds.

## Crates (2 slots)
First waits 30/120, later `rn(90)+90`; state 10 growth 17 frames; type `rn(2)`: 0 boots (180 frames), 1 shock power. Smashed only by the mallet. Pickups are timed via `FUN_800b6e1c`.

## Clock / end
The common BCD clock shows 0:00 and sounds the horn on play tick 2699. In a natural L29 versus replay the last points finished counting and the result flags appeared on 2701. The HUD reads field +0x52 and counts toward +0x50 once per four global updates, then once per update after the horn. All four counters must be equal to their awarded scores before ranking. The online HUD follows the opening phase from a controlled capture (1 modulo four).
Result: rank by score (ties lower slot first); top two equal = draw (flags 0x100); else winner 0x200, rest 0x400.

## AI
Versus difficulty selects [22,25,30] from 0x800b92c4. Speed `min(62,45+max(0,skill-15))`, boots `min(97,80+...)`, reaction delay `96-3*skill` frames; picks nearest mushroom/crate, holds charge for the power wave when it has a shock power.

## SFX (level bank 0178, `sfx/0178/<n>.mp3`)
The VAB stores one-based VAG numbers. Exported sample indices are zero-based.

| Action | Sound ID | Exported sample |
|---|---|---|
| Windup, swing, contact | 0x719+p, 0x721+p, 0x710+p | 6+p, 14+p, 1+p |
| Mushroom hit, gold bonus | 0x71d+p, 0x72b | 10+p, 19 |
| Wave, power wave | 0x72f+p, 0x72d | 22+p, 20 |
| Pop, gold pop, explosion | 0x528, 0x72a, 0x733–0x736 | 33, 18, 26 |
| Hurt, boots, shock pickup | 0x446, 0x41c, 0x72e | 27, 32, 21 |
| Crate break | 0x3f5–0x3f8 | 29, 30, 29, 30 |

The run handler plays character-bank offsets 10 and 11 on script markers 8 and 9. The HUD ticks on 5 through 1 and sounds the horn at 0. Bank 0277 maps 0x19b and 0x19c to samples 4 and 5.

## Camera

The in-play camera is fixed. The result uses the mode 1 fit from `FUN_8009608c` and `FUN_80078dd4`, with player half-width 256, height 960, no Z extent, and floor Y −16. A loser leaves the camera's tracked list on entry to state 0x48. A winner switches the camera on when entering state 0x47. On a draw the first player already in idle switches it on and starts turning toward yaw zero.

## USA individual versus result

Frame 0 is the snapshot where `FUN_800b5820` sets the result flags. The horn (sound 0x19c, bank 0277 sample 5) can precede that frame while the HUD is still counting. RAM and calls were sampled at 30 Hz in a separate USA emulator session using `re/dumps/L29.state`. Controlled fixtures set the clock and scores and, where needed, one or two player or mushroom states. The executable dispatched the results.

| Cue or transition | Frames from ranking |
|---|---|
| Standing winner | Entry at 1 with script 0x39 and music duck. Quarter-angle turn to yaw zero starts at 2. |
| Standing losers | Entry at 1 with script 0x33 and full scale. Scale drops 0x80 per frame from 2. At 33 the shadow clears and pack 0343 script 1 plays silently. |
| Hurt players | State 0x42 keeps running script 0x38 through idle. In the controlled hurt trace, Koala entered win at 28 and Coco entered lose at 22, then vanished at 54. |
| Draw | All four retain their models and scale. Idle keeps its phase. Running and mallet states return to idle, while hit finishes its script. TIE begins at 2 (scale 736), calls 0x1af at 23 (bank 0278 sample 13, scale 3914), and the native round restarts at 120. Music stays ducked through the draw. |
| Arena objects | In a win, eligible mushrooms can still rise or explode. The example expired mushroom called 0x733 at 5. From the tick after the last winner cue, waiting objects stop their timers. On a draw those timers hold from frame 1. The same expired mushroom makes a silent pack 0343 script 1 puff at 5. |

The winner sequence (`FUN_80089fa4` and `FUN_8008a200`) plays the name 31 ticks after entering 0x47, then 0x1b0 “wins” (bank 0278 sample 14), then the character's reaction 31 ticks later. The L29 bank family is `c`. For a standing winner:

| Character | Name ID at 32 | “Wins” frame | Reaction ID and frame |
|---|---:|---:|---:|
| Crash | 0x01 | 57 | 0x07 at 88 |
| Coco | 0x33 | 56 | 0x39 at 87 |
| Cortex | 0x65 | 59 | 0x6b at 90 |
| N. Brio | 0x97 | 56 | 0x9d at 87 |
| Tiny | 0x12d | 56 | 0x133 at 87 |
| Rilla Roo | 0x15f | 56 | 0x165 at 87 |
| Dingodile | 0xfb | 59 | 0x101 at 90 |
| Koala Kong | 0xc9 | 59 | 0xcf at 90 |

Live native sound hooks covered Koala, Coco, Cortex and Dingodile. The remaining four timings come from the executable's character switch and were checked in Chromium. All 56 stock animation scripts (794 words) match the L29 RAM tables. A hurt Koala's observed native name, “wins” and reaction were at 59, 86 and 117. Big Stein and Top G use Cortex's Mallet scripts and their own models (9009 and 9109) and recordings. From standing entry at frame 1 their browser cues were 32/67/98 and 32/68/99, respectively.

The pre-change client started result poses at 0, spawned standing-loser puffs at 32 and held the in-play camera at (0, 0, 3736). It started the TIE sequence two ticks early. In the controlled Koala win, native camera translation was (−28, 85, 3513) at frame 1 and (−448, 1372, 182) at 119. The updated shared replay matched player state, pose word, yaw, X/Z, scale, visibility, lock and power across 7,200 actor ticks, and integer translation across 1,800 camera ticks. That covers frames 0–119 in 14 controlled traces and one unforced playback from the L29 save. The unforced finish was 000/059/087/090, with Dingodile's cues at 32/59/90.

The replay uses a copy of the ranked snapshot. The browser uses its own stage RNG and particle renderer. For example, a respawn in the controlled win popped at 21 natively and at 27 in the browser replay, while the already-scheduled mushroom popped at 89 in both.

The party client holds a Mallet draw for 4 seconds and a win for 4.5 seconds before its results transition, when the configured phase allows it. Normal party rounds still use the party result and podium flow.

## Unknowns
Body radii are extracted from shape 0x40 of each mallet model. The versus skill table at 0x800b92c4 is 22/25/30. Remaining differences include timer and spawner order within a frame, RNG-dependent objects and particles, and the browser audio mix.

## Effects (decoded)
Pack 0343 (db 0x80053c7c): script 0 = bomb blast, 1 = smash (also the loser vanishing), 2 = crate break, 3 = gold sparkle (13 frames after the
rise). Shock wave = ring object 0x1a03 (part 19, 128 u up, `s += (target - (s - 0x800)) >> 1` to 0x4000 / 0x8000, yaw += 0x71). Smash score =
floating number (0x1409). Held icons: boots, shock (0736 part 11), spinning 0x38 / tick.
