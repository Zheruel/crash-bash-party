# Dragon Drop (overlay level id 28; our id `dragonDrop`)

Source of truth: `re/out_ringDing/{all,ovl}.c`, RAM `re/dumps/L28.ram`. Sim: `web/shared/games/dragonDrop.ts`, view `web/client/games/dragonDrop.ts`, stage `assets/stages/dragonDrop.json`.
Verification: real-game traces (emulator, `rec_passive.json` 750 ticks, `rec_throw_0.08.json`) replayed tick by tick from the recorded state with the recorded pads: every player/jewel/target field matched exactly except (a) random knock directions (rng differs) and (b) test-injection artifacts (unknown hold length, yaw target). Wall clamp is bit exact thanks to the CORDIC sqrt port.

## Units
PS1 fixed point, 30 Hz, no dt. World x = ps1.x*S, z = -ps1.z*S, y = -ps1.y*S, S = 3.4/1024. Angles 0..0xfff; `T(a)=round(4096cos)`, `SIN(a)=T(a-0x400)`. Yaw h moves along (-sin h, -cos h); `body.face = -h*2pi/4096`. atan2 = `FUN_8001463c`. `FUN_80032490(n)>>6` is an inexact CORDIC sqrt (`FUN_8003233c`), ported bit exact (`sq`). Floor radius 0xb00 (wall pushes to 0xafe), the 1:30 clock reaches zero at play tick 2699.

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

The opening pair appear on the first **locked** level update. Their yaw reaches 3136 before input unlocks and 3168 on the first playable update. C appears on playable tick 1350. All three use bank 0619, words `2001–2003`. Pickup sets scale 2048 immediately. Throw and knock-loose set it back to 4096.

Each jewel also has a separate ground quad (`800bb23c`, word `2014`, part 19). Its entity stays at native y = 128 with zero rotation, scale 9192, and brightness 2048. Removing the word in PCSX confirmed subtractive drawing. The quad appears one tick after jewel spawn. On pickup it stays behind for one frame at its previous position and then disappears. A fifth bounce also skips one position update. Both the jewel and the ground node were sampled for 360 consecutive USA updates, including a throw, a barge loss, catches, and a five-bounce landing.

## Target (`b7aa0`, collision `b8a40`)
Phase advances 0xc per tick for 99 level updates before control is released. At play tick zero the next phase is 1188, swing angle 747, placed yaw 750, target X/Z (2570,1148), and gong cooldown 71. The countdown view samples the captured swing and rings the gong on level tick 80. th = SIN(phase)*3/16 & 0xfff (swing +-0x2f7). Placed at (SIN(th), T(th))*11/16 (units: orbit 2816), yaw th, roll 2*th, height ps1 y -1061. Gong (sfx 0x6bf) when th crosses 0x2f7/0xd09 with cooldown 0x5a. Hit box local x -886..900, z -3..196, top y -893, inflated 0x180, normal rotated by the target matrix; jewel reflects about the target's inward normal, gets cooldown 0x14, moves once more, score += mult.
Placements: score desc, index asc; draw only if the top two tie.

`800b8a40` uses yaw alone for its local contact test, then applies the full `8003278c` matrix to push the jewel away from the rolled surface. The signed product must be negated before shifting to fixed point. At yaw 17, a top-edge hit followed by rim contact ended at (352, −2350, 2790), heading 3586 and velocity (118, −118). The former matrix gave z = 2791 and heading 3584. The shared simulation matched position, heading, velocity, score and hit cooldown for 108 USA emulator probes around the box and 104 additional rolled-edge contacts.

## Bot AI (`aiTick`, handlers b3a38.. b4d6c)
Versus skills 8 / 16 / 20 were read from all four slots after executing `FUN_80086918` in L28 at each difficulty. Handlers: 1 jewel hunt, 2 chase carrier, 3 direct throw, 4 to the x5 spot, 5 in zone, 6 evade (rival radius 250; barge-chance circle 200). Ray tests `b4268`/`b4474` use int32 wraparound. Victim selection, barge chances, collision sounds and jewel deflections use the shared native two-word RNG. Native `FUN_80085650` matched all 16 seat-order permutations and both final RNG words for each of four seeds. The online seed is mixed into the executable’s first starting word.

At GO each CPU has already chosen an opening jewel. The engine advances the RNG once before the arena update (`80010394` → `800155fc`), then selects the seat order. Each CPU starts with an empty physical pad. A handler can switch from evading to aiming without writing any directions that tick. Retaining its previous pad made the rider coast in the wrong direction at its first pickup. The third jewel appears at tick 1350. Its burst consumes another 28, 28, 28 and 12 draws after gameplay on the next four updates.

Three USA recordings ran for 2,699 consecutive gameplay updates each. Starting with the recorded RNG and order table at GO, the shared sim matched every rider's position, velocity, heading, state, effective input, cooldown and possession, every jewel's position, state and owner, all scores, and both RNG words. The Normal round ended 0–43–17–25 and Hard ended 0–22–38–23. A four-human directional-input recording ended in a scoreless draw. The Hard comparison used the recorded physical directions through knockback because the recoil handler clears the pad after reading it. The regression in `web/scripts/test-dragon-drop.ts` replays all three captures.

## Arena and character sounds

Dragon Drop loads VAB 0179. Bank 0180 belongs to Ring Ding. The live L28 tone table at `0x80064508` resolves all Dragon Drop IDs to the samples and pitches in `RD_SFX`. Steps use the two short blips for each seat at run ticks 6 and 19, the gong uses sample 21, and `0x6b2` and `0x6c8–0x6cb` are silent. Barge and throw cues also follow the rider's seat.

Recoil entry `FUN_800b9e68` makes one shared `rand(4)` draw and plays that character's hit ID from family B. Executing the original handler for all eight characters, four seats and four variations confirmed all 128 IDs. The host sends this draw in the recoil event. Both custom riders resolve it against their own recordings.

## Clock and scoring

A full individual-versus capture displayed 1:30 through play tick 28, then changed to 1:29 at 29. The final five warning ticks were 2549, 2579, 2609, 2639 and 2669. The horn and ordinary result arrived at 2699. All 1,560 sampled clock frames matched. The separator stays lit (`0x81c0`).

The score HUD (`FUN_8007d4d0`) counts one point when the global logic clock is divisible by four. The online phase is anchored to the captured opening. At zero `FUN_8007b8d4` checks whether the counters have caught up, then the HUD updates. A backlog counts every tick under flag `0x200`. A forced five-point backlog took five extra ticks to dispatch the winner. Both current and displayed scores travel in snapshots.

## Animation (rider models 832–846)

Scripts `0x4d` (idle/recoil), `0x4e` (run), `0x4f` (throw) and `0x50` (barge) select the model groups. Cortex swaps idle and run; Coco uses group 3 for throw instead of group 4.

### Versus result

- `FUN_800b62d8` sets `0x200` on the winner and `0x8400` on each loser. The three losers vanish immediately with one silent `0x1605` burst each at their current positions, using the default level database's script 0 (model 0621, same script as jewel appearance, origin at rider height).
- The winner stays on the rider model. Enter handler `FUN_800bcf88` starts `0x4d`, requests the winner clip with `FUN_80085718`, and sets the winner announcement state. On the next update `FUN_800bcf44` enters `0x56` via `FUN_80085890` once the clip is available and advances it one pose. L28 replay confirmed the switch at result tick 2 for Koala, Coco, Cortex and Dingodile. The render words and `0x8008` sound commands are decoded from L28 RAM for all characters. They use level bank 0179, with IDs in the range `0x6c4`–`0x6c7` plus `0x6a6` / `0x6a7` on two tracks.
- On a tie `FUN_800b62d8` gives every rider flag `0x100` and clears the pads through the engine's player update. Riders stay visible, finish their current actions and return to native idle. `FUN_800bb3ec` frees the jewels under either result flag. The target stops under the same flags in `FUN_800b7aa0`. The shared draw sequence plays `0x1af` (0278 sample 13).
- `FUN_800b9930` zeros the winner's current and target velocity on the first update, including a rider caught mid-barge. The entry tick can still run its previous state handler. Thereafter state `0x68` turns the rider toward yaw zero without running rider collisions. Losers skip the player update as soon as they disappear. All four origins stay at floor height through either outcome.
- The draw continues `FUN_800b9778` with zero target velocity. Coast deceleration is 9 per axis, or 6 while barging. Rider contacts still transfer velocity and recoil, and the rim can stop a barge. The view advances these handlers on copies of the riders using the snapshot's shuffled orders and a local RNG copy. Positions and poses are visual only. Scores and outcomes come from the terminal snapshot.
- Captured a draw and wins in each slot from L28. In the fixed-order seeded draw, the four origins reached `(-2138,0,305)`, `(-998,0,324)`, `(-223,0,300)` and `(2800,0,295)` by tick 21 and held there. With slot 1 winning from horizontal velocity `(-130,0)`, it stopped on tick 1 at `(-820,0,300)`. Starting the loser in slot 0 within collision range moved the winner to `(-850,0,321)` on the entry tick, then the winner held that position through tick 43. The port matched all 1,408 position samples across eight 44-tick captures.
- The view uses the measured two-tick winner switch across the roster. Brio's lead-in references eleven words beyond the extracted rider's group 2 frame range, so the view holds the rider on the idle script until the first valid group 3 frame. L28 loads voice family `b`. The shared winner calls use the same samples and pitches in families `b` and `c`.

## Camera
The camera fits the riders and jewels on the list at `8005aa34`. Each jewel starts registered, including hidden C. Pickup unlinks it, and throw or knock-loose registers it again. A thrown jewel unlinks on its fifth bounce. A knocked-loose jewel stays registered when it settles. Registered jewels use a 512-unit radius, height, and reach. The swinging target has no entry.

With sampled USA positions, fitting the riders and target gave zero exact translations in 433 consecutive-frame comparisons. Using the recorded list matched all 433. A win and a draw also matched all 70 compared updates apiece with the result boxes from `80078dd4`. On the verdict update the camera still includes the active list. From the next update it fits the surviving riders. WebGL replays used both custom riders. The browser interpolates the 30 Hz fit between render frames.

## Unknowns
Analog stick deadzone, additional rosters and difficulties, and the RNG phase from boot through GO remain to be compared directly.

## Effects (decoded)
Level model 0621 script 0 = jewel spawn burst (192 u up; parts 0, 1, 4, 5). Barge = smoke puff object 0x1903: pack 0619 parts 3-18, 16 frames,
easing 1/6 toward the player; one per barge (`FUN_800ba724` spawns it on the tick the barge counter at player +0x1c node +0x1e reads 2). Nothing for scoring, throws, pickups, clashes, bumps or steps.
