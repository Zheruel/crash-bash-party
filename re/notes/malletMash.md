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
Walk speed 45 (0x2d), boots 80 for 180 frames. Yaw eases diff>>2/frame. Arena clamp 0x980 minus collision radius (table `[0,199,199,184,184,328,328,333,333]`). Players push each other apart (circle push).
Per-frame order: bookkeeping (hit/stun/blink) -> lock/blink decrement (hidden iff blink%3==0) -> AI -> input->control -> state -> physics -> clamp -> power timer. Mushrooms/crates update after players; AI pad acts one frame late.
Pad: Square 0x8000 = mallet; dpad 0x10 up, 0x20 right, 0x40 down, 0x80 left.

## States / anim (clip index = anim id - 0x33 within the char group)
0x33 idle, 0x34 run, 0x35 windup (state 0x43, 9 frames), 0x36 charge (0x44), 0x37 swing (6 frames, event 0xc at the strike) then recovery 0x46 (16 frames; char 8 differs), 0x38 hurt (0x45 stun), 0x39 cheer (0x47 win), 0x48 lose (shrink 0x80/frame).
Charge continues until anim event 8 AND button released. Shock wave if previous state was 0x44 or power type 1.
Scripts are decoded in `malletMashData.ts` (opcodes 0x8000 goto, 0x8003 n event, 0x8004 n state, 0x8007 n hold). 

## Hits and waves
- Swing hits nearest mushroom in reach/facing (`FUN_800b4454`), points 2/3/5 by growth state; gold 10/15/20.
- Normal wave: radius 0x380, players only. Victim: knockback 0x50 (decays 4/frame), hits counter 0x14, loses power-ups, stun 30 frames (input zero) then blink 40.
- Power wave (shock power): radius 0x600, also smashes every mushroom in range for the owner; consumes power. Centre = player + 0.6*reach along yaw (estimate).
- Exploding mushroom (state 5): radius 0x380, owner -1, stuns.

## Mushrooms (10 slots)
States: 0 spot search, 2 wait (ticks only when intro flag clear), 10 rise (13 frames, ys +0x100 to 0xc00), 0xc wait `WAIT0[stage]+rn(WAITR[stage])`, 0xd shake 70 frames (ys 0xb00+rn(0x200)), 0xe shake 40 frames (ys 0x800+rn(0x800)), 5 explode, 4 hit, 6, 1 destroyed if cap < count.
Spot: random in +-0x800, rejected within 0x400 of players/mushrooms, 0x300 of crates; spawn clamp 0x880; spawn cooldown 0x14.
Stages (sec): [15,15,13,10,10]; caps [6,5,5,4,3]; gold timers [600,600,600,450,300], max 4 golds.

## Crates (2 slots)
First waits 30/120, later `rn(90)+90`; state 10 growth 17 frames; type `rn(2)`: 0 boots (180 frames), 1 shock power. Smashed only by the mallet. Pickups are timed via `FUN_800b6e1c`.

## Clock / end
BCD clock -2 per frame; end check sees 0:00 one call late: 2672 calls from frame 126. Intro flag clears at 99, timer starts at 126; sim starts at frame 99 (intro pre-simulated). `MM_END`=2697, `maxTime=(MM_END+1)/30`.
Result: rank by score (ties lower slot first); top two equal = draw (flags 0x100); else winner 0x200, rest 0x400.

## AI
Skill from difficulty (sim: level [12,19,25]). Speed `min(62,45+max(0,skill-15))`, boots `min(97,80+...)`, reaction delay `96-3*skill` frames; picks nearest mushroom/crate, holds charge for the power wave when it has a shock power.

## SFX (level bank 0178, `sfx/0178/<n>.mp3`)
windup 0x719+p -> 7+p; swing strike (anim event 0xc) 0x721+p -> 15+p; mallet lands 0x710+p -> 2+p; mushroom hit 0x71d+p -> 11+p (+gold 0x72b -> 20); wave 0x72f+p -> 23+p (power wave +0x72d -> 21); normal pop 0x528 -> 34; gold pop 0x72a -> 19; mushroom explosion 0x733-6 -> 27; hurt 0x446 -> 28; boots 0x41c -> 33; shock power 0x72e -> 22; crate smash 0x3f5-8 -> 30/31.
Unmapped: char voices (table 0x8009e080), footsteps, clock tick 0x19b, horn 0x19c (exe bank).

## Camera
`MM_CAM` in the view (fitted); fixed camera, horizontal FOV preserved on narrow screens.

## Unknowns
Shock-wave centre offset; second (mallet) collision sphere; radii for 4 chars; exact AI skill per difficulty label; timer/spawner order vs players inside a frame; voices/footsteps/tick/horn samples; cheer sequence `FUN_8008a200` timing beyond the local anim.

## Effects (decoded)
Pack 0343 (db 0x80053c7c): script 0 = bomb blast, 1 = smash (also the loser vanishing), 2 = crate break, 3 = gold sparkle (13 frames after the
rise). Shock wave = ring object 0x1a03 (part 19, 128 u up, `s += (target - (s - 0x800)) >> 1` to 0x4000 / 0x8000, yaw += 0x71). Smash score =
floating number (0x1409). Held icons: boots, shock (0736 part 11), spinning 0x38 / tick.
