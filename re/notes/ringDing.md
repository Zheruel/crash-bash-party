# Ring Ding (overlay level id 28; our id `ringDing`)

Source of truth: `re/out_ringDing/{all,ovl}.c`, RAM `re/dumps/L28.ram`. Sim: `web/shared/games/ringDing.ts`, view `web/client/games/ringDing.ts`, stage `assets/stages/ringDing.json`.
Verification: real-game traces (emulator, `rec_passive.json` 750 ticks, `rec_throw_0.08.json`) replayed tick by tick from the recorded state with the recorded pads: every player/jewel/target field matched exactly except (a) random knock directions (rng differs) and (b) test-injection artifacts (unknown hold length, yaw target). Wall clamp is bit exact thanks to the CORDIC sqrt port.

## Units
PS1 fixed point, 30 Hz, no dt. World x = ps1.x*S, z = -ps1.z*S, y = -ps1.y*S, S = 3.4/1024. Angles 0..0xfff; `T(a)=round(4096cos)`, `SIN(a)=T(a-0x400)`. Yaw h moves along (-sin h, -cos h); `body.face = -h*2pi/4096`. atan2 = `FUN_8001463c`. `FUN_80032490(n)>>6` is an inexact CORDIC sqrt (`FUN_8003233c`), ported bit exact (`sq`). Floor radius 0xb00 (wall pushes to 0xafe), round = 2700 ticks (90 s).

## Tick order (`FUN_800b85dc` + engine loop at 0x80084xxx)
1. Target `FUN_800b7aa0` (placement from old swing angle, jewel-vs-target collisions, new swing angle, gong).
2. Barge cooldown -1 per tick (`b85dc`); tick++; third jewel appears at tick 0x546 (1350).
3. Players in a **random order**: `FUN_80085650` builds 16 shuffled permutations of 0..3 at level start; each tick `rand(16)` picks one (`all.c` 0x80084xxx). Order matters (who sees whose moved position, who recoils when both barge). Sim: `d.ord`.
   Per player: lock-1 -> AI (bots) -> `b9930` (pad -> heading / target velocity, speed 84 human walk, 106 carrying, bot table `0x800bdc1c[skill>>1]`) -> state handler (`0x8009dca4`, stride 8) -> `b9778` (yaw += adiff>>2 unless locked, accelerate 9 (barge 10/6), move, wall).
4. Jewels A, B, C `FUN_800bb3ec`.

## Players
Start P0..P3 (ps1 x,z): (-1280,-1740), (-1280,1740), (972,1740), (972,-1740); yaw = atan2(x,z). Char ids [1,2,5,7,3,4,8,6].
States (`0x8009dca0` enter / `dca4` update): 99 idle, 100 run, 101 throw, 102 barge, 103 recoil, 104 end.
- Run: sc counter, step sfx at sc==6 and 0x13, wraps >0x19. Pad angle from d-pad (up 0, right 0x400, down 0x800, left 0xc00, diagonals 0x200 steps); heading = angle+0x800.
- Throw 101: 15 ticks, target velocity 0, jewel -> state 2.
- Barge 102: pressed with square while empty-handed and cooldown 0; cooldown 30 set at press; enter v=178 along yaw, accel 10 / decel 6; ends when |v|<0x20 or on wall (stops dead).
- Recoil 103: 9 ticks (rt 7..-1), yaw +0x80/tick, handler zeroes pad and sets lock=2 each tick (pad effective only on the 2nd tick), carried jewel -> state 5 (knocked loose).
- Player collision (`FUN_800ba960`): dist<0x19c; equal-mass velocity swap; push 0x19e-dist along the line; a barging player sends the other to recoil and goes idle; bump sfx if speed^2>0x1000.

## Jewels (`FUN_800bb3ec`)
States: 0 rest (spin +0x20 yaw, jewel-jewel clash <0x200 swaps velocities, friction 2/tick, pickup if |y|<=0x200, dist<0x200), 1 carried (pos = owner, y -0x400), 2 throw init (y -0x200, v 210 along yaw, multiplier from the thrower's zone, hold 4), 3 flight (hold boost vy -0x1800 clamp -0x6000 for 4 ticks while square held / always for bots; gravity 0x800; y += vy>>8; bounce halves v and vy; 5th bounce rests), 4 knocked loose (random heading, speed 64, vy -0x60, gravity 8), 5 knock init, 6 hidden, 7 appear. Start A (1024,-64,0) B (-1024,-64,0) at tick 1, C (0,-64,512) at tick 1350.
Zones (`FUN_8008c4c8`, half-plane intersections, tables in sim): throw from zone 1 = x5, 2 = x3, 3 = x2, else x1.

## Target (`b7aa0`, collision `b8a40`)
phase advances 0xc/tick and runs **97 ticks ahead of the round clock** (measured: phase = 12 t + 1164). th = SIN(phase)*3/16 & 0xfff (swing +-0x2f7). Placed at (SIN(th), T(th))*11/16 (units: orbit 2816), yaw th, roll 2*th, height ps1 y -1061. Gong (sfx 0x6bf) when th crosses 0x2f7/0xd09 with cooldown 0x5a. Hit box local x -886..900, z -3..196, top y -893, inflated 0x180, normal rotated by the target matrix; jewel reflects about the target's inward normal, gets cooldown 0x14, moves once more, score += mult.
Placements: score desc, index asc; draw only if the top two tie.

## Bot AI (`aiTick`, handlers b3a38.. b4d6c)
Skill by level 8 / 16 / 20 (`0x800bd970`; normal 16 verified; easy/hard assumed by table order). Handlers: 1 jewel hunt, 2 chase carrier, 3 direct throw, 4 to the x5 spot, 5 in zone, 6 evade (rival radius 250; barge-chance circle 200). Ray tests `b4268`/`b4474` use int32 wraparound. Victim pick / barge chance use `rand`; same structure and constants as the decompile, but rng sequences cannot match the real game.

## Sound (level bank 0180; table `0x80064508 + id*2` = {slot, prog<<4|tone}; sample = tone vag - 1; offset (prog*16+tone)*32 in the VAB)
| id | event | sample n |
|---|---|---|
| 0x6bf | gong | 17 (1.8 s) |
| 0x6b1 | any target hit | 10 |
| 0x6bb/6bc/6bd/6be (+0x6b2 for x5) | mult 1/2/3/5 | 15/15/16/16 (+10) |
| 0x6a4,a6,a8,aa / 0x6a5,a7,a9,ab | step ticks 6 / 0x13, player 0..3 | 0,2,4,6 / 1,3,5,7 (1 and 2 map to 1.8 s / 3 s shared samples: suspicious, muted) |
| 0x6c4+p | barge start | 22..25 |
| 0x6ac+p | barge strike frame 14 | 8,4,5,9 |
| 0x6b3+p | throw | 11,11,12,12 |
| 0x6d0..d3 (rand 4) | player bump, barge into wall | 28,27,28,29 |
| 0x6b7..ba (rand 4) | jewel bounce | 13,13,14,14 |
| 0x6c0..c3 (rand 4) | jewel clash / knocked loose | 18..21 |
| 0x6cd / 0x6ce / 0x6cc | jewel pickup / appear / wall hit | 25 / 26 / 26 |
| 0x6cf | countdown | 27 |
Samples 0-8, 19, 27-29 live in other bank dirs (`index.json`). Recoil plays the hit voice (rand(4) of 0x8009e080, voice family b). The level's clips carry no other voices (L28 anim scripts: only the generic slots 2 / 6 / 8 / 10, which Ring Ding never enters).

## Animation (rider models 832-846, 5 clips; roles in stage JSON)
idle 0, run 1 (cortex: idle 1, run 0), barge = `action` 2 (body.dash), throw (custom role `throw`) 4 (coco 3), recoil = `hit` 0, win 3 (coco 4), lose 4. Role from state: 101 throw, 103 hit, 100 run, 99 idle. Clip choice is estimated, not read from the anim scripts.

## Camera
Fixed high view from the south rim (`RD_CAM`), fitted by eye against screenshots; not read from code.

## Unknowns
Initial target phase offset exact at tick 0 (fit from t>=518 traces); difficulty skill values for easy/hard; human d-pad diagonals and stick deadzone (0.4); hold-boost length for human throws (button hold); x-edge target push tilt from roll (untested); rng-dependent AI choices; character voices; anim clip mapping and camera; round-end off-by-one.

## Effects (decoded)
Level model 0621 script 0 = jewel spawn burst (192 u up; parts 0, 1, 4, 5). Barge = smoke puff object 0x1903: pack 0619 parts 3-18, 16 frames,
easing 1/6 toward the player; one per barge (`FUN_800ba724` spawns it on the tick the barge counter at player +0x1c node +0x1e reads 2). Nothing for scoring, throws, pickups, clashes, bumps or steps.

## Sound bank correction (2026-11-19)
The level loads VAB **0179**, not 0180 (L28 RAM dump: the loaded bank's tone table equals disc 0179; every Ring Ding id resolves
through 0x80064508 to its tones, 0 mismatches). The earlier sample table above used 0180 (Dragon Drop's bank) and is
superseded: `RD_SFX` in web/client/games/ringDing.ts maps id -> 0179 sample + pitch. The step ticks are short 0.2 s blips
(0x6a4-0x6ab, odd ids pitched 0.875-0.903), the gong 0x6bf is the 5.9 s sample 21; 0x6b2 and 0x6c8-0x6cb are silent.
