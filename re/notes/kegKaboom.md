# Keg Kaboom (level 30, overlay 0x800b32b4..0x800bede8, bank 0177)

Sources: `re/out_kegKaboom/ovl.c`, emulator traces (all-CPU 90 s, human idle/run/jump traces), RAM dump `re/dumps/L30.ram`.
Sim: `web/shared/games/kegKaboom.ts` (+ `kegKaboomData.ts` anim scripts). View: `web/client/games/kegKaboom.ts`.

## Units and clock
- Logic 30 Hz. Angles 0..0xFFF. `T(a)` = cos table Q12 (`T(a-0x400)` = sin a); movement `x -= v*T(h-0x400)>>12`, `z -= v*T(h)>>12`.
- 1 game unit = 1/1024 gltf root unit; arena scale 3.398 => world = game/301.4 (`KK_S`). Real +z is screen up, so worldZ = -gameZ.
- The sim advances the 99 intro frames in `setup`. The BCD clock starts 27 updates after control is released and sounds the horn at play tick 2699. A natural L30 versus replay with settled counters dispatched the outcome on 2699. The end frame varies when scores are still counting.
- Start positions (x,z,yaw): P0 (-933,-1176,0xe00), P1 (-1141,1343,0x200), P2 (1059,1295,0x600), P3 (1038,-1145,0xa00).

## Normal versus opening (USA L30)

Three EmulatorJS/PCSX ReARMed captures used the USA disc and the versus menu, with the level selector redirected to L30. The game ran the rules dismissal and countdown. In the capture below, age 0 is global logic tick 939, the first L30 scene update with the intro lock. Age 99 is tick 1038, when the lock clears. The BCD clock stays at 0x13000 across those samples.

| Age | Arena and HUD | Keg scales (Q12) | Flame 0 yaw / pose word | Rilla idle word |
|---|---|---|---|---|
| 0 | Rules panel still drawn over the arena | — | 2707 / 0x4001 | 0x4201 |
| 4 | Rules gone, arena visible without a digit | — | 2755 / 0x4005 | 0x4205 |
| 18 | 3 visible | — | 2923 / 0x4013 | 0x4213 |
| 59 | No kegs yet | — | 3415 / 0x4000 | 0x421c |
| 60 | First keg appears | 1000 | 3427 / 0x4001 | 0x421d |
| 62 | Second keg appears | 3000, 1000 | 3451 / 0x4003 | 0x421f |
| 65 | First keg reaches full scale | 6000, 4000 | 3487 / 0x4006 | 0x4202 |
| 81 | Fourth keg appears | 6000, 6000, 6000, 1000 | 3679 / 0x4002 | 0x4212 |
| 98 | Fifth keg appears | 6000, 6000, 6000, 6000, 1000 | 3883 / 0x4013 | 0x4203 |
| 99 | Input lock clears | 6000, 6000, 6000, 6000, 2000 | 3895 / 0x4000 | 0x4204 |

- Keg births were at ages 60, 62, 69, 81 and 98. Each gained 1000 scale per tick until 6000, so the fifth was still growing at the handoff. In the capture that continued through GO, the fifth keg was already growing at lock release (age 99), the CPUs first moved at age 100, and GO was visible at age 101.
- Both flames stayed 0x800 apart and advanced 12 angle units per tick. `FUN_800b8368` cycles the flame render word through 0x4000–0x4013, with 0x4001 already visible on the first arena update. Absolute flame angle and keg positions depend on the RNG.
- The four players stayed at their starting positions while script 0x61 visibly advanced. The first sampled idle words were 0x4201, 0x4001, 0x4001 and 0x4081 for Rilla, Crash, Tiny and Dingodile. Sampling the script after one initial idle update matches all 400 pose words across ages 0–99.
- The web view derives the opening age from the room phase deadline. It reads keg births, positions and flame angles from the prepared tick-zero snapshot, then samples the locked idle and flame keys at that age. Live snapshots supply the active-round state, including the fifth keg's remaining growth. The custom Big Stein and Top G carriers use Cortex's keys. The shared shell now dismisses the rules at age 4 and shows the arena for 11 ticks before the numbered sequence begins. Two Chromium peers rendered all 95 visible ticks and played the four original countdown calls once each.

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
- The player collision check reads the cached 0x40 cylinder from the carrier model at the pose in 0x800bc188. The radii are Crash 204, Cortex 153, Tiny 179, Rilla Roo 119 and Dingodile 332. Coco, Brio and Koala have no such cylinder in either their initialization pose or their animation frames. Vertical overlap is strict. Big Stein and Top G inherit Cortex's cylinder. Each keg tests nearby players in its own callback (within 224 units).
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
- HUD: scores roll up digit by digit (that explains "9" / "12" seen in HUD frame captures; real scores are always even). The common HUD counts one point every fourth global update during play and one every update while settling. The host and prediction send both awarded and displayed points. The controlled L30 opening phase was 3 modulo four. At expiry a five-point backlog took five additional ticks to announce the winner.

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
| 0xa / 0xb within each character's 0x32-ID block | family `c`, 0206–0213 and shared samples | run footfalls, from `FUN_800b5e84` and script 0x64 events 8 / 9 |
| voices | 0206-0213 | anim 0x65 jump rise / 0x67 land play `0x8008 id` on frame 1: engine 1-8 jump 0xc 0x3e 0x138 0xa2 0x138 0x16a 0x106 0xd4, land 0xd 0x3f 0x71 0xa3 0x139 0x16b 0x139 0xd5 (ported) |
Index: sample 0 = sfx/0154/23, 1 = sfx/0154/24, 19 = sfx/0165/14.

Run footfall IDs in engine character order are `0x0a/0x0b`, `0x3c/0x3d`, `0x6e/0x6f`, `0xa0/0xa1`,
`0x136/0x137`, `0x168/0x169`, `0x104/0x105`, `0xd2/0xd3`. The view uses the simulation's `step` event, the roster's voice block, and the existing VAB pitch table.
The first footfall is positional. The second uses a null origin and plays in the center. Both use the character's tone and pitch in the web mixer.
The counter/state `player + 0x58 == 0x15` selects `0x41e` for the first footfall and suppresses the second. That branch is
outside ordinary play in the port. `0x41e` is unmapped in the L30 versus dump.

## Camera
Play and draws use the fixed L30 camera. Winner entry switches to mode 1 (`DAT_800ad12c`), and loser entry removes that actor from the camera list. The result boxes in `FUN_80078dd4` have horizontal radius 256, height 960 and zero z extents. A loser still in flight stays in the fit until entering 0x74.

## Result presentation
- With the verdict as frame 0, idle, running and landing players enter 0x75 (winner) or 0x74 (loser) on the next update. Rise, fall and hit finish first. Draws keep the current idle animation, settle runners into idle and complete any jump or hit. If a shock interrupts jump rise, the apex dispatches generic fall (state 5, script 7), followed by generic land (state 7, script 8). A shock during descent keeps the hit script and settles to the floor without a landing animation or voice.
- Winner entry `FUN_800b6c84` starts 0x6b and asks `FUN_80085718` to load the clip in the table at 0x800bb93c, which selects 0x6a. The update `FUN_800b6e84` advances the script on the tick it loads, so the first visible key is frame 1. USA captures took 11–13 ticks from entry. The web uses fixed delays because its clips are preloaded.
- Loser entry `FUN_800b6f6c` starts 0x61, removes the shadow and spawns one silent 0x1605 burst at ground level using pack 0738 script 0. `FUN_800b722c` subtracts 300 from the initial scale of 4096 each later tick, reaching 3 on entry +14.
- Landing plays its voice on the landing update. The rise and fall fixtures landed at verdict +12 and +6 respectively, with a win or loss on the next tick. The announcer begins at winner entry +31, plays 0x1b0 after the name's wait and plays the character's win voice 31 ticks later. The shared clock supplies the horn. The Keg view plays 0x1af for a draw at verdict +23.
- The view replays the result from a private copy of the terminal snapshot. Big Stein and Top G use their existing Keg models and voices with the Cortex scripts.
- After a rising shock hit on a draw, the generic idle script can request keys beyond its Keg carrier clip. The model sampler holds the last exported key on those frames.

### Powder, fuses and pickups through the verdict

The L30 powder emitter copies the carrier's facing when dropping a piece. Pack 0738 part 14 starts at pitch 0x400 and advances by 0x44 each falling update. Ground contact swaps to part 1 at pitch zero while retaining yaw. The keg initializer selects part 0 for every ordinary keg, part 22 for silver and part 21 for gold. The two rim flames use the same truncated Q12 positions for rendering and ignition.

Each player's fuse follower allocates one loop when its counter first becomes positive. The mixer keys the voice on the next update. Table 0x800bb9fc chooses IDs 0x741, 0x740, 0x73f and 0x73e (samples 4, 3, 4 and 3). Each surviving spark writes its X and Z to its current owner's follower. The mixer reads the position and camera before the next round update. The snapshot preserves the tone, start tick and both positions so reconnecting clients can resume at the same point in the sample and the stereo field.

The US stereo routine 0x8002b210 projects the origin in the original 512-pixel frame. It uses the near box (1024, 4096, 3840), far box (2560, 4608, 10240), a fixed-point distance and a separate quadratic gain for each speaker. At ground level with the play camera, a fuse at X = −2048, Z = 0 gave channel levels (82, 30) out of 127. Moving to X = +2048 gave (30, 82). At the center the levels were (91, 91), falling to (60, 60) at Z = 2048. Keg blasts, point pops, shock pickups, shock waves and the first running footfall use the same stereo routine. The listener follows the native result camera independently of browser aspect ratio.

Controlled PCSX captures matched 1,200 pairs of settled SPU voice registers across fixed and moving cameras. WebGL replay matched the seven-bit levels of 86 active voices sampled through a win and a draw, including starting the replay seven ticks late. Web Audio uses the settled channel levels from note onset. The original SPU's first keyed update can have a slightly different low-channel gain before the first volume write.

In a crossed-trail replay, seat 0's spark found a powder node with 16 ticks left laid by seat 1. Routine 0x800b7b80 changed the spark owner to 1 and its scale to 2116/4096. Routine 0x800b8114 then read seat 1's four-point combo and awarded six for a nearby ordinary keg. Seat 1's fuse followed the spark through X = 0, 20, 40, 60, 80 and 128 while seat 0's score and fuse stayed zero.

Pickup collection includes the two X edges at ±256 and excludes the two Z edges at ±256. The same asymmetry applies to the 512-unit exclusion area when spawning kegs and pickups. The bouncing shock pickup casts the subtractive pack 0736 part 0 shadow at its spawn position. Once carried, the indicator tracks the player's height plus 768 units and turns by 56 angle units per update. A fresh USA opening had yaw 56 on the first scene update and 5600 when the input lock cleared 99 updates later.

Two controlled USA finishes started with lit powder and moving sparks. Winner entry sets the arena lock at 0x800bc444. A draw leaves it clear, allowing the spawners and trail searches to continue. Existing sparks can still ignite kegs after ranking. In the win capture, a losing player's score went from 10 to 12 on verdict +1. The displayed digits reached 11 at +4 and 12 at +8. The draw capture also awarded the two late points without revisiting the verdict. The web view runs these updates on a private copy for the arena HUD, effects and sound.

Starting from the native terminal state and object order, the shared result update reproduced 114 consecutive updates in each capture, including 762 powder samples, 912 fuse-counter pairs, both flame angles and both score tracks. The comparison excluded new random spawns in the draw. Uninterrupted seeded play and the newer object scheduler are covered below.

## Seeded L30 replays

The US executable initializes four generic seat timers with rand(60), makes four swaps in each of 16 player-order rows, then draws the first flame angle with rand(4096). Each visible update advances both RNG words once in 0x800155fc and draws a row in 0x80083e8c. Keg and pickup placement, CPU choices, fuse and impact sounds all consume this stream. The shock charge initializer at 0x800b8fc0 draws rand(2) + 1. The first displayed flame is already 12 angle units past its initial heading. For online play the loading interval consumes the 31 intervening raw advances measured in the full seed-19 capture. Original disc loading and rules dismissal can take different lengths.

The callback list at 0x8005aa40 stores occupied object addresses before the seat pass. A new particle or keg can reuse an address already in that list and run on its birth tick. Slots 13–103 serve powder, sparks, kegs, pickups, floating scores and effect scripts. Routine 0x800b7948 allocates new powder before freeing the node it replaces. Each player's last-node pointer can then refer to a different occupant. During a seed-71 three-CPU game, slot 26 changed from powder to a keg on age 120 and the keg reached scale 2000 that tick. A spark in slot 40 notified the CPU of live fire on age 145. The host snapshots the free list, the two RNG words, the 16 rows and the next CPU pads. A disconnected human's controller uses the same pass, and the next actual human pad takes effect immediately.

Seed 19 matched 2,700 consecutive USA samples from GO through the horn with idle human pads. The comparison checked both RNG words, flame headings, keg locations, growth and metal variants, shock pickup and character positions and render words. With the same loading interval imposed at scene entry, a second individual-versus human recording matched all 716 samples, including running, laying powder and jumping. Three-CPU comparisons also recorded generated and applied pads, arena scores, and which object occupied each slot. A Hard recording with one active human and three CPUs matched all 2,736 consecutive samples from GO to the native winner flag on play tick 2735. Seed 54 used Coco, Brio, Rilla Roo and Koala Kong. The native rand(4) selected Coco's hit voice during a three-keg blast before the explosion sounds, affecting subsequent stage spawns. Raw scores at the horn were 0, 286, 176 and 354. A live spark awarded Rilla two more on play tick 2717 while the score digits were settling. The original and web scores at the verdict were 0, 286, 178 and 354. A finite Easy recording matched all 895 samples from GO. The Normal trace first differed in a spark's route on age 598. A freed last-powder pointer on the disc can read reused component memory independently of the object slot. The web preserves the live slot relationship and falls back to the last coordinates when the slot is vacant.

## Validation
- 400-frame human trace (idle, run, jump, laying) vs emulator: 0 mismatches (state, x, y, z, yaw, speed) with real CPU/keg rows injected.
- Powder node positions match frame by frame; node life matches except occasional +-1 near flame ignition.
- All-CPU 90 s (12 runs): keg count 122-159, scores 122-346, per-player mean about 230.

## Unknowns
- The separate component heap can change powder spacing when a player still holds a freed node address. Full-match parity across seeds and rosters remains open.
- Per-character human speeds, airborne-hit behavior and the 0x756–0x75a object need more captures.

## Effects (decoded)
Pack 0738 (db 0x80053f8c): keg blast = script 0, shock wave = script 3; powder = part 14 falling / part 1 lying, sparks part 13, flame part 23
(animated clip). Pickup = pack 0736 part 11. Chain pops score with the floating number (object 0x1409, 10 ticks apart per chain step).
Nothing for spawns, ignition, stuns or laying powder. The L30 camera has no shake: keg blasts, shock waves and landings leave it still.

State table 0x8009dca0 also maps 0x76 (respawn), 0x77 (knockout) and 0x79 (hole fall, 0x410). Only adventure objects or a missing floor reach them, so the port leaves them out. Generic air-hit scripts 7 and 8 name clip 5 for Rilla Roo, which the five-clip carrier lacks; the view holds the previous key there.
