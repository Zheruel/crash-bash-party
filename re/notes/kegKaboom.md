# Keg Kaboom (level 30, overlay 0x800b32b4..0x800bede8, bank 0177)

Sources: `re/out_kegKaboom/ovl.c`, emulator traces (all-CPU 90 s, human idle/run/jump traces), RAM dump `re/dumps/L30.ram`.
Sim: `web/shared/games/kegKaboom.ts` (+ `kegKaboomData.ts` anim scripts). View: `web/client/games/kegKaboom.ts`.

## Units and clock
- Logic 30 Hz. Angles 0..0xFFF. `T(a)` = cos table Q12 (`T(a-0x400)` = sin a); movement `x -= v*T(h-0x400)>>12`, `z -= v*T(h)>>12`.
- 1 game unit = 1/1024 gltf root unit; arena scale 3.398 => world = game/301.4 (`KK_S`). Real +z is screen up, so worldZ = -gameZ.
- Intro flag (0x4000000) clears at frame 99 (input and AI start); timer starts at 126; BCD clock -2 per frame from 0x130 (1:30); win/lose flags set at update 2813 (`END_G`). Sim pre-simulates the 99 intro frames in `setup`; `maxTime = (2814-99)/30`.
- Start positions (x,z,yaw): P0 (-933,-1176,0xe00), P1 (-1141,1343,0x200), P2 (1059,1295,0x600), P3 (1038,-1145,0xa00).

## Function map
| addr | role |
|---|---|
| FUN_800b37c8 | CPU AI |
| FUN_800b7948 | lay powder node |
| FUN_800b7b80 | spark scan (claim next node) |
| FUN_800b7df0 | keg chain scoring (pop) |
| FUN_800b8e10 | fuse follower (obj 0x1d09), combo reset |
| FUN_800b85d0 | hop/lunge object (0x756-0x75a sounds), never spawned in traces |
| FUN_800ba220 | round end: rank, win/lose flags |
| FUN_800ba694 / FUN_800bb010 | shock wave: charge consume / stun in box |
| FUN_80022660 | play sound id; FUN_80022a3c spawn object; FUN_8008502c anim script VM |

## Player (struct 0x8009d52c + p*0x6c)
- States: 0x71 idle (anim 0x61), 0x72 run (0x64), 0x73 hit (0x68), 0x74 loser (0x61), 0x75 winner (0x6b), 0x78 jump rise (0x65), 0x7a fall (0x66), 0x7b land (0x67). State changes come from script op 0x8004.
- Input (held 0x80051388, pressed 0x8005138c, +p*0x58): 0x10 up, 0x20 right, 0x40 down, 0x80 left, 0x2000 circle, 0x4000 cross (jump), 0x8000 square (lay powder), 0x200 R2, 0x800 R1. Heading = d-pad angle + 0x800; octant table {0x10:2048, 0x30:2557, 0x20:3072, 0x60:3584, 0x40:4096, 0xc0:4611, 0x80:5120, 0x90:5632}.
- Speed: human 35 laying / 60 running; CPU skill-scaled: 33/57 (Easy), 37/63 (Medium), 39/67 (Hard). Yaw eases `yaw += diff>>2` (not in 0x74/0x75).
- Jump (exe table 0x8009d354): chars 1-4 (crash, coco, cortex, brio): speed 108, max fall 114, fall accel 8, rise decel 10; chars 5-8 (tiny, rilla, dingodile, koala): 72, 114, 10, 6. Landing script state 0x7b.
- Radius 120 for every character (pair-distance histogram); kegs push players out to effective radius 224 (FUN `kegFrame`).
- Arena radius 2360 (0x938), box fast path 0x684.
- Shock: hold circle/R2/R1 (0x2a00) with a charge, on the ground (y >= -0x31): sound 0x43a, chain (base 0, box +-0x380) and stun everyone else within +-0x380 (hit state, per-char script length, charge cleared).
- Hit state: duration = per-char script 0x68 length; shock charge is lost.
- Flags `fl`: 0x100 draw, 0x200 winner, 0x400 loser; 0xc000 = out/dead (ignored by spawners).

## Powder (FUN_800b7948)
- A node every frame while Square is held and y >= -0x31, if the player has no node yet or is more than sqrt(0x3ff) (~32 units) from the last one. Grid 128 units (40x40, offset 0xa00, clamped +-0x9ff); an existing node in the cell is replaced.
- Node life 60 (CPU: 60*skill>>4). Position = player + (dist, yaw+angle offset): per char (dist, angle, yOff): 1:130,-900,220; 2:100,-1200,250; 3:100,1100,200; 4:100,1100,200; 5:130,-1500,250; 6:130,-1500,300; 7:130,-1100,300; 8:130,-1100,300. Node falls from yOff with gravity 12/frame.
- Two flames circle at radius 2304 (rim), +12 angle per frame, second 0x800 apart (first angle random). Each frame a flame ignites powder nodes in its 8 neighbour cells (table 0x800bc1b0): 2 sparks per node (owner = node owner), node removed.
- Spark (FUN_800b7b80 scan): speed 20/frame along the trail, claims next node (8 neighbours), spawns branch sparks; sparks chain-ignite kegs within +-300 (box). Life 15 frames idle.
- Combo (per player): `combo = min(10, combo + total)` on each spark chain; reset 10 frames after the last spark (fuse follower 0x1d09, FUN_800b8e10) or when not laying.

## Kegs and score
- Spawner: timer starts 59, reloads `5*n+1` (n = live kegs, so a spawn every 5n+2 frames; none if n >= 8), max 8 slots at 0x800bc424. Position `(rand(8)-4)*0x200` on both axes, within radius 0x800, not within +-0x200 of a live player, not on another keg. Every 8th keg silver, every 32nd gold. Grows 1000 -> 6000 (of 4096 => ~1.46) in 5 frames, cannot be ignited while growing.
- Value: normal `min(10, base + total + 2)`, silver 10, gold 20. Recursion box +-0x120 for chain, `total += 2 + sub`. Score added to the owner of the spark/shock.
- Keg explodes the frame after it is hit (explosion object 0x1605).
- Shock pickup: every 600 frames (first 599), only if none exists, position `(rand(14)-7)*0x100`, charge rand(2)+1 (1..2, effectively a boolean). Hops (vy -0x28, +8 per frame). Picked up when within +-0x100 box.
- Result (FUN_800ba220): rank by score, ties lower slot first; equal top two = draw (all flags 0x100); else winner 0x200, rest 0x400. Real scores are all even.
- HUD: scores roll up digit by digit (that explains "9" / "12" seen in HUD frame captures; real scores are always even). View shows +1 per 2 frames.

## AI (FUN_800b37c8; per CPU, skill 14 / 19 / 22 for Easy / Medium / Hard)
Modes: 1 idle, 4 random walk (target `rand(0x1100)-0x880`), 5 go to pickup (within 0xf00 Manhattan, 0x96 frames), 6 go to a keg (60 frames, re-pick with chance skill/32), 7 go to the rim (angle of own position), 8 circle the rim. Re-pick when the timer runs out: `rand(0x40) <= skill+0x20` => pickup > rim (if burn counter 0) > nearest keg (claimed by another counts double, silver 2/3, gold 1/2); else idle/random walk. Aim point is offset 0x5a angle (side by char) and 0x100/16 from the target; weaving offset {-200,0,200,0} by timer. Holds Square while heading to kegs.

## Animation (script interpreter FUN_8008502c / FUN_800854c0)
- Script table `0x8009d29c + char*4`, anim ids 0x61..0x6b; pose word `0x4000 + (clip<<7) + frame`, clip = gltf animation index, 30 fps. Ops: 0x8000 jump, 0x8002/0x8003 event (8/9 = footfall), 0x8004 set state, 0x8005 play anim, 0x8007 hold n, 0x8018 set delay. Extracted to `kegKaboomData.ts` for chars 1..8 (crash, coco, cortex, brio, tiny, rilla, dingodile, koala).

## SFX (bank 0177; id -> VAB tone -> vag; sample = vag - 1; shared samples live in other bank dirs)
| id | sample | use |
|---|---|---|
| 0x750-0x753 | 9-12 | keg chain pop by owner p |
| 0x754 / 0x755 | 13 / 14 | silver / gold keg pop |
| 0x742-0x745 (table 0x800bb9ec, rand 4) | 5,6,7,8 | keg explosion (table gives 0x745,0x744,0x743,0x742) |
| 0x73e-0x741 (table 0x800bb9fc, rand 4) | 3,4 | fuse hiss (looped samples) |
| 0x439 | 20 (sfx/0164/25) | shock pickup |
| 0x43a | 21 (sfx/0164/26) | shock wave |
| 0x756-0x75a | 15-19 | used only by FUN_800b85d0 (hop/lunge object, never seen in any trace; treated as dead code) |
| 0x410, 0x3fa, 0x95c-table | other banks | hit / jump (not mapped) |
| voices | 0206-0213 | anim 0x65 jump rise / 0x67 land play `0x8008 id` on frame 1: engine 1-8 jump 0xc 0x3e 0x138 0xa2 0x138 0x16a 0x106 0xd4, land 0xd 0x3f 0x71 0xa3 0x139 0x16b 0x139 0xd5 (ported) |
Index: sample 0 = sfx/0154/23, 1 = sfx/0154/24, 19 = sfx/0165/14.

## Camera
Fixed. `KK_CAM` in the view: pos (1.2, 9.552, 17.82), look (1.204, 1.688, -0.508), fov 43.76 (4:3), horizontal FOV kept on narrow screens.

## Validation
- 400-frame human trace (idle, run, jump, laying) vs emulator: 0 mismatches (state, x, y, z, yaw, speed) with real CPU/keg rows injected.
- Powder node positions match frame by frame; node life matches except occasional +-1 near flame ignition.
- All-CPU 90 s (12 runs): keg count 122-159, scores 122-346, per-player mean about 230.

## Unknowns
- HUD roll-up speed; loser/winner end pose (winner anim 0x6b assumed, losers idle 0x61).
- Pickup charge rand argument; keg-jump vertical collision (ignored); update order of objects vs players inside a frame (players first assumed).
- Per-char human speed (35/60 assumed for all); exact RNG (sim uses `world.rng`).
- Flame first angle; hit while airborne; footstep / voice samples; the 0x756-0x75a object.

## Effects (decoded)
Pack 0738 (db 0x80053f8c): keg blast = script 0, shock wave = script 3; powder = part 14 falling / part 1 lying, sparks part 13, flame part 23
(animated clip). Pickup = pack 0736 part 11. Chain pops score with the floating number (object 0x1409, 10 ticks apart per chain step).
Nothing for spawns, ignition, stuns or laying powder.
