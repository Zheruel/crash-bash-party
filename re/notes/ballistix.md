# Ballistix (`ballDefence`, levels 14-17) - decoded from `re/out_ballistix/all.c`

Levels (`DAT_8005a648`): 0xe CRASHBALL, 0xf BEACH BALL, 0x10 N.BALLISM, 0x11 SKY BALLS. Logic runs at 30 Hz; 1 sim `step()` = 1 game frame, every constant is per frame.
Port: `web/shared/games/ballDefence.ts` (sim), `web/client/games/ballDefence.ts` (view). Engine basics in `engine.md`.

## Units / conventions
- 1024 u = 1 model unit, 256 u = 1 sim unit. sim x = u_x/256, sim z = -u_z/256. Game player p = our slot; p0 (0,-2176) bottom, p1 (0,2176) top, p2 (2176,0), p3 (-2176,0).
- Angles 0x1000 = 360 deg, 0 = +z, 0x400 = +x. A ball heading points backwards: `x -= spd*sin(h)>>12; z -= spd*cos(h)>>12`.
- Pad: 0x10 up, 0x20 right, 0x40 down, 0x80 left, shoulders 0xf00 boost, 0x4000 cross, 0x8000 square, 0x1000 triangle. AI injects fake pad bits.

## Function map
| addr | role |
|---|---|
| 0x800b558c / 0x800b58e8 | ship slide (crash/beach/n.ballism / sky ring) |
| 0x800b5c30 | per-frame ship update (move, face, then `FUN_800be4d4`) |
| 0x800b42f4 | push ship out of corner bumpers (bumper radius + 345) |
| 0x800b4efc | "ball clear of bumpers/box" test (state 6 -> 8) |
| 0x800b60fc | state trigger (cross -> 0x21 catch on beach, square -> 0x1f kick) |
| 0x800b8a68 | AI pad generator, 0x800b7c60 defence ray, 0x800b808c kick ray |
| 0x800b84b8 / 0x800b85dc / 0x800b8964 | choose opponent, check kick, check catch range |
| 0x800b77f8 / 0x800bb674 / 0x800bb924 | catch-state update, release, held-ball separation |
| 0x800b9e54 | ball state machine (states 0,0xc,6,8,1,2,4,0x11,99,0x12) |
| 0x800bb41c | shield push bends heading; 0x800bf2bc shield repulsion |
| 0x800bc0d8 | level controller: ball count ramp, N.Ballism post timer, sky tilt events |
| 0x800bd770 | N.Ballism post spawn; 0x800bd43c sky platform event |
| 0x800be4d4 | ship vs ball; 0x800be1c4 push ball back to a circle |
| 0x800befd4 | kick sweep |
| 0x800bf640 | ball vs ball |
| 0x800c1214 | corner pair after a goal `[0,1],[2,3],[1,3],[0,2]` |
| 0x800c1328 | `off` by ball count {16,8,4,2,1,0..}; 0x800c1980 AI error windows; 0x800c1440 post sequence |
| 0x800c1a88.. | per-player collision table (stride 0x28): body r 345, front r 414, front centre 132 u toward the wall |

## Rules (all levels)
- Score per player: CRASHBALL 15, BEACH 12, N.BALLISM 20, SKY 20. A ball over the goal line: score--, sfx 1400+p, `last-conceded = p`. At 0: goal walled up (bits 1=z-,2=z+,4=x-,8=x+, wall at +-0x800), ship dies (state 0x24 -> 0x25, sfx 1414). Last with score > 0 wins.
- Goal line +-0xa00 (far 0xb80). Sky radial 0x980 (far 0xc00). Sinking ball is clamped to +-0x600 laterally (= goal mouth width).
- Corner bumpers (centre, r): crash/beach (+-2048, 512); n.ballism (+-2128, 416); sky (+-1869, 464). All four stages use the ship’s flagged 345 u collision radius for the pushout. The engine checks again after ship contact.
- Ship (crash/beach/n.ballism): slide max 0x68 (0xa0 with a shoulder), accel 0x22 (p1 0x2a; boost 0x38), decay 0x12 when idle. Bumper-pushed adds +-(max>>1) to accel; push with no input zeroes vel; vel 0 while accelerating becomes +-1. p0/p1 slide on x, p2/p3 on game z.
  Sky: max 0x28 (0x48), accel 0xd (p1 0x15; boost 0x12), decay 6; ships orbit a ring of radius 2304 (angle += vel).
- Ball speed: `spd` moves toward `tgt` by acc (4) up / dec (1) down each frame, then position update. Hits raise `tgt` by 4 up to 0x90.
- Ball states: 0 new, 0xc waiting 15+1 frames at a corner, 6 falling in, 8 bouncing, 1 rolling, 2 held (beach), 4/0x11 sinking in goal (4 beach/n.ballism: speed halves, y drops 0x60/frame; 0x11 crash: timer 8 (4 from state 8) then sink += 0x200), 99 sky goal (timer 0x10, heading forced outward), 0x12 scored.
- Spawn: corner cooldown 0x1f frames (decremented every frame in 0x800bcb..), corner from `SPAWN_AFTER[last conceded]` (rand 2) else rand(4); aimed at the centre, jitter rand(0x1c7)-0xe3 applied when it clears the corner. Crash: y0 -256, v0 0x30, gravity 6, speed 0x20 -> tgt 0x50. Beach tgt 0x30. N.Ballism y0 -1280, v0 0x10, accel 3, bounce v>>2. Sky y0 -2048, v0 0x40, speed 0x50. Rest y = -96. sfx 1440 on spawn (not in sky).
- Ball count: `efc` starts 10, counts down; at 0 `ef8++`, target = ef8/300+1 (max 5; beach 4; 0 while the N.Gin machine runs); create when fewer, re-arm 30. (So +1 ball every 10 s.) `off` feeds the AI. The USA Beach table at 0x800c1328 is {10,8,4,2,1,0..}.
- Ball vs ball: overlap push and sfx 1408. Beach Ball uses the collision marker and the held-ball flag described below.

## Beach Ball ball contacts (0x800bf640)

- The USA 0762 ball marker has radius 89 u and spans y−127 to y+128. A pair needs horizontal separation below 178 u and vertical separation below 255 u. The disc computes the push from its Q6 square root and the native angle lookup.
- Ball movement callbacks run in entity-slot order. Each callback checks candidates newest first, including held balls and balls in other states whose collision markers overlap. A held ball runs its separate positioning routine. The shared pool below also orders goal barriers and knockout effects.
- With two ordinary balls, the caller moves out of the overlap and reflects its heading. The target gets the contact normal as its heading, and both speeds become the truncated average. If the overlap correction exceeds half the combined radius, the caller moves by the full combined radius. Target speeds remain in effect on subsequent updates.
- Bit `0x80` is set during the held update and persists after release. An ordinary caller still moves and reflects when the target has this bit, while the target keeps its heading and speed. A caller with the bit moves and reflects the first overlapping target by the uncapped overlap correction. Each contact emits sfx 1408.
- The native routine reproduced the frame-5964 hit by a released ball, the frame-6117 near miss at 224 u, and the frame-6475 reflection off a held ball. On frame 5964 the ordinary ball ends at (−9, −1646), heading 2226 and speed 48. On frame 6475 it ends at (1640, −771), heading 109 and speed 48.

## Ship vs ball (0x800be4d4) - verified against emulator traces
- The ship moves (`0x800b5c30`), then checks contact, then the ball travels. Beach uses the ship's updated slide velocity. In frame 5804 the ship slows from 42 to 8 u/frame and adds 8 to the ball's speed before the ball update subtracts 1. The earlier Crashball replay measured speed 80 + 112 (capped at 144).
- Body sphere r345 at the ship. The front sphere is r414 and sits at local x/z (2,132). The disc chooses it with the angle from the ball's previous position to hull marker 1 (local z=-67). Catch state (0x21) adds 0x80 to the front radius.
- The ball's collision marker has radius 89 u in all four RAM snapshots. Ship contact and kick sweep use this marker. All four stages use 89 for those checks. Arena bumpers, held-ball separation and the fallback arena collision radius still use 128 u.
- Hit: ball pushed back along its path to radius+8 (`FUN_800be1c4`); new heading = atan(spd*vec(n) + |vel|*vec(face)) then `va + clamp(adiff(h+0x800, va), +-0x3f0)` if |D| <= 0x400 (n = angle ball -> sphere centre). For larger differences the routine runs the vector sum again using `va` as the ball heading. Speed += |vel| (cap tgt+0x40). Ship contact adds 4 to tgt (to 0x90) when the hit cooldown is zero. Last toucher = player. Sfx 1404..1407 uses rand(4). Ship contacts traverse the newest-first ball list.
- Face = fixed quantised yaw (`(atan(x,z)+0x7f)&0xc00`) on crash/beach/n.ballism; on sky it follows the ring angle.
- Beach ship contact still tests a sinking ball against the hull. On seeded frame 5530 an idle seat 3 redirects a sinking ball, which stays in state 4 and ends the frame at (−2624, 1365), heading 1896 and speed 35.

## First serve at GO

At the first frame accepting input, all four arenas have already run 99 controller ticks. The hidden ball waits at (8192, 8192, 8192). Before the first playable step, `ef8=59`, `efa=1`, `efc=0`. The corner slot is selected on play tick 28 and the ball launches on tick 44. While waiting at the corner its y is −32 in Crashball and Beach Ball, −1280 in N. Ballism, and −2048 in Sky Balls. The simulation carries this initial wait in the round snapshot.

A live PCSX capture on each stage held right through input unlock. The opening 44 frames matched the ship’s x/z, ball state and height, absolute x/z distance from the center, ball-controller counters, and stage timers. The corner draw uses the online round’s seed. On N. Ballism the launcher countdown reads 291 immediately before input unlock and the first rise sound plays on tick 293. The first Sky Balls tilt timer reads 171.

## Crashball, N. Ballism and Sky Balls contact replays

The L14, L16 and L17 individual-versus snapshots contain the same 89-unit ball marker, with a vertical range from −127 to +128. Two balls need strictly less than 178 units of horizontal separation and 255 units of vertical separation. The callback scans newest first. A waiting, falling or sinking ball can be the target. Kicks have their own cooldown of 20 ticks on serve and four ticks on impact.

The ship’s front sphere offsets are fixed per seat, even on Sky Balls. The facing test uses the ball’s previous position and the hull marker at local (0, 0, −67). Contact uses the ship’s velocity for this tick. The fixed-point pushback leaves an exactly vertical path alone when its x step is zero. All ship bumpers use the 345-unit ship marker. Sky projects the pilot onto its ring, corrects the seat’s travel axis and projects again. Its closed-goal contact and sound can occur between successive corner checks.

Controlled replays used each stage’s loaded USA code and collision records. Per stage, 300 ball-pair tests and 300 kick tests compared positions, speeds, headings, cooldowns and sound calls. Another 400 ship-contact tests compared deflections with the hull pivot supplied from the disc marker, with zero ship roll. Eight hundred corner setups per stage each compared both the ship callback and the ball callback, including the closed-goal sound counter. These checks cover individual contacts. Entity allocation, whole-round random draws, and multi-actor update order outside Beach Ball still need uninterrupted match comparisons.

N. Gin’s launcher joins the collision list at spin-up and leaves it at retraction. Its body has radius 460 and vertical bounds −523 to +110 at the arena origin. A moving ball rebounds silently and keeps its speed. Four hundred controlled L16 machine contacts matched. A separate live PCSX recording followed the native rise, spin and firing states. Three launches from that recording match through the birth tick and the next four positions. At yaw 4078 the ball appears at (−12, −128, 415), rebounds to (−16, −96, 549), then reaches (−25, −96, 933) three ticks later.

## Kick (0x800befd4, state 0x1f)
4 frames; sweep radius `((kfr*0x600+0x1000)&0xffff)>>3` = 0x200, 0x2c0, 0x380, 0x440 (+89 ball radius) around the ship centre. Hits balls in state 1 or 8 with hit cooldown 0. Heading = angle(ship -> ball) + pointing back; cooldown 4; sfx 1413. Speed = old tgt + 0x40; new tgt 0x90 (crash/n.ballism), 0x40 (beach), 0x80 (sky). Penalty: on kick `kpen = min(kpen+30, 90)`, `kcd = kpen`; a hit zeroes `kcd`; `kcd` decrements first, then `kpen` (cannot kick while kcd > 0). Swing sfx 1409+p.

- The kick sweep uses the 89 u marker and scans newest first. The ball's kick cooldown lives at state component +0x20. It starts at 20 on serve and resets to 4 after a kick. The motion component's +0x32 cooldown serves a separate ship-contact check. On Hard replay frame 6473, the serve cooldown protects an unlanded ball within kick range.

## Per level
- **CRASHBALL (0xe)**: plain. Goal falling state 0x11. Bank 0157. Border strips cyan in game; floor steel plates.
- **BEACH BALL (0xf)**: cross starts state 0x21 and a 0x96-frame timeout. Catch uses a 631 u front contact radius (414 + 128 + 89). Held balls sit on a 503 u arc around the front marker with heading offset clamped to ±0x220. Launch aims away from hull marker 4 at local (0,2,145). Release after six catch updates sets speed and target speed to 224. Timeout releases at 48. Launch moves the ball once immediately and again on the ball update. Served balls target 48, max 4 balls. Bank 0156.
- **N.BALLISM (0x10)**: power-up post at a corner (`POST_SEQ[i]`, 180 frames, spawned when no post/shield, reload rand(90)+30). Pickup = shield 0xf0 frames that repels rolling balls within 0x859 (push (R-dist)>>4 bends heading). N.Gin machine at the centre: wait (rand(15)+8)*30 frames, rise, spin up 0x5a, spit 0x96 frames (a ball every 16 frames while < 8 balls: at 416*vec(yaw), heading = yaw, speed 0x80, yaw += 0x1c7/frame). Retract sets `efc = 0x19`. Bank 0155.
- **SKY BALLS (0x11)**: ring ships, radial goals, goal falling state 99, platform tilt events (ported, see below), ball y0 -2048. Bank 0154.

## AI (0x800b8a68)
- USA Party skill tables (`0x8009d900`, easy/normal/hard) are Crashball 2/10/18, Beach Ball 2/11/19, N.Ballism 2/11/18 and Sky Balls 6/14/20.
- Beach Ball stores an opponent, mode, roaming position, wait and catch countdown in the struct pointed to by `0x8009d54c + slot*0x6c`. An incoming rolling ball whose ray hits the wide defence line can move the CPU from roaming/waiting to defend. The shortest ball-to-intercept distance wins. Rays use the receiver's skill, the ball-count offset and one-sided random angle error. The disc quantizes the intersection to 16 u steps before interpolating on the line.
- The opponent pointers at `0x800c19c0` select the signed offset `[-64, 0, 64]` at `0x800c19f0`. Indexed by defending seat 0–3, the native opponent rows are `[3,1,2]`, `[2,0,3]`, `[0,3,1]`, and `[1,2,0]`. `FUN_800b8a68` applies the selected offset as +x, −x, −x, and −z respectively.
- The defending CPU steers using the pad octant table. It moves if `abs(lateral error) + (skill + off)*32 > 640` and adds shoulder boost if the ball-to-intercept distance is smaller than that sum.
- Kick range is `max(1, skill*16-off) + rand(max(1, skill*16-off)) + 256`. The CPU tries an aimed kick against the narrow goal mouth first, then catch, then a second kick probe with a blind fallback in Party mode. Catch considers any nearby ball inside 640 u and ±0x2aa, including bouncing and held balls. It starts a 90-frame CPU counter separate from the ship's 150-frame timer.
- Cross drops when the nearby-ball check fails or a held shot has a valid ray during the last 29 CPU ticks. A release ray tries the chosen opponent, then an alternate selected from the frame counter. Defend can re-arm cross on the same frame if the ball is still within catch range. A CPU ship that has armed its release needs two consecutive updates without cross.

## Beach Ball individual-versus frame order

- The engine advances the two RNG words with `FUN_800155fc`, then the arena controller updates. The player loop (`FUN_80083e8c`) draws rand(16) to select a row from the table at 0x8009d764. `FUN_80085650` builds each row with four swaps against random indices 0–3 at scene setup.
- For each seat in the selected order, the engine decrements the kick cooldown, runs the CPU for a CPU-controlled ship, then updates the ship and its contacts. A later CPU can see a ball moved by an earlier ship, and its random draws follow any intervening idle, taunt or hit draws. Ball updates follow the seat loop. Spawns, serve jitter, impacts and landings use the same RNG words.
- `FUN_800b8a68` writes the next raw pad through `FUN_80013c94`. The ship acts on the pad the engine already read for this frame. The shared sim stores the pending pad, CPU memory, RNG words and seat-order table in the world snapshot.
- The host requests CPU control for vacant or disconnected seats. Prediction uses the control state in the snapshot when a pad is missing. An explicit human pad takes over immediately and clears any pending CPU pad while the planner pauses.
- When no human remains in play, `FUN_80084788` latches spectator mode at the end of the seat pass. On the next frame `FUN_800b40ac` picks the first living seat with the lowest score. That seat gets skill 0 and opponent-selection weight 32. The other seats get skill 32 and weight 4. The target stays selected until it loses its last point. The second kick probe in spectator mode permits a blind kick only when the lapse is zero and rand(24) is at most the acting seat's skill.
- An eliminated CPU's planner runs until the hull has sunk out of sight. The 61-tick dying state ends with `FUN_800898ec` drawing three rand(10) smoke delays and rand(2) for sound 451 or 452. `FUN_80089be8` adds rand(2048) at each puff launch and rand(10) when it hits the floor or reaches its scale limit. The sim keeps the puff timers in the snapshot so these draws run before later seats in the same frame.

### Beach Ball entity pool and victory

- Balls (`0x1501`), closed-goal barriers (`0x1505`) and the knockout burst (`0x1605`) share the dynamic entity pool. `FUN_80022a3c` takes the free-list head and `FUN_80022fd4` pushes released slots onto it. The capture numbers dynamic slots from `0x801c91c8` at 0x70-byte intervals.
- The arena controller can allocate a ball before `FUN_8007906c` collects the ascending-slot callbacks. The seat pass can allocate barriers and bursts. Their initialization is immediate and their first queued callback runs on the following frame. The callback pass frees scored balls in slot order. A burst releases its slot after 23 ticks of pack 0762 script 0.
- The first barrier occupies slot 4 from frame 7063. The first burst takes slot 5 on 7124 and frees it on 7147. The second knockout frees ball slot 2 on 7692. Its barrier takes slot 2 on 7693, so the respawn on 7706 takes slot 5. This orders the callbacks as 0, 1, 3, 5. It preserves the ordinary ball's native (−153, −296) position on 7931.
- After the final point, the controller gets one more pass before the seat loop sets status `0x800`. The Hard and Normal recordings verify that the planners and ball callbacks continue during victory. The ship states finish their active kick or catch and then enter the dying or winner callback. The winner moves 32 u per frame toward the 1280 u line. The barriers free their slots 30 frames after status `0x800`, and score changes stop while remaining balls continue moving. The second character voice in the victory script sets the result flag. The world snapshot carries the pool and both victory timings for host and prediction.

## Sound effects (effect id -> bank sample; function `FUN_80022660(id, ...)`)
id = `(tone.max<<8)|tone.min` through the bank VAB. Same for the four banks up to 1426.
| id | sample | event |
|---|---|---|
| 1400..1403 | 0..3 | goal conceded by p0..p3 |
| 1404,1406 / 1405,1407 | 4 / 5 | ship hits ball |
| 1408 | 6 | ball vs ball |
| 1409..1412 | 7..10 | kick swing p0..p3 |
| 1413 | 11 | kick hits ball |
| 1414 | 12 | ship eliminated |
| 1415,1418 / 1416,1419 / 1417,1420 | 13 / 14 / 15 | wall/bumper bounce (rand 6) |
| 1421..1424 | 16 | ball lands (rand 4) |
| 1425 | 17 | goal wall closes |
| 1426 | 18 | - |
| 1440 | 19 | ball spawn (not sky) |
| 451 / 452 | crash 20/21, beach 29/30, n.ballism 24/25, sky 23/24 | generic |
Crash extras 1494..1498 -> 22; beach 1450..1464 -> 20..28; n.ballism machine 1470..1473 -> 20..23 (rise, spin, retract, spit); sky 1480..1485 -> 19..22. Shield 1496/1498 are not in the level banks (placeholder). Banks: CRASHBALL 0157, BEACH 0156, N.BALLISM 0155, SKY 0154; the view looks files up in `audio/index.json` by sample `n`.

## Animation states (ship char) - player state id at 0x8009d558
0x1c idle, 0x1d moving, 0x1e taunt, 0x1f kick, 0x21 catch, 0x24 dying, 0x25 gone. The idle callback `FUN_800b66d0` checks the Triangle press (0x1000) and enters 0x1e. `FUN_800b68c8` starts the character's taunt script and selects the voice. Per-state anim scripts (VM `FUN_8008502c`,
blocks of `0 0x8007 N pose 0x8000|0x8004 st|0x8005 x`, pose = 0x4000 + (clip<<7) + frame) at 0x800c1560 + 0x6c per character.
Block order: 0x1c, 0x1d, ?, 0x1e, 0x1f, loop, loop, dying. Clips idle/move/hit/catch/dying: crash 0/3/4/2/5, tiny 0/1/3/2/5,
dingodile 0/4/3/2/5, rilla 0/3/4/1/5, koala 0/1/4/5/2, coco/cortex/brio 0/4/3/2/5 (the last three by pattern). Kick keeps the idle clip.

- Beach Ball's idle callback (`FUN_800b66d0`) counts down only in script `0x19`. At zero it draws rand(600)+300 before handling movement, catch or kick. `FUN_800854c0` writes pose 0 of gesture `0x1b` and the normal VM update in that same callback writes pose 1 once the pilot has settled. The terminal opcode switches back to pose 0 of `0x19`. The timer resumes on the following frame. The USA VM confirms the gesture returns at age 108/40/59/55/45/59/30/74 for disc characters 1–8. Big Stein and Top G both use Cortex's 60-pose gesture and seated loop.

## Models (emulator RAM, render chain `d534[p]` -> +0x5c)
- Pilot: per-character model 896 + 2i (rilla, tiny, koala, dingodile, brio, cortex, coco, crash), animated, at the entity origin.
- Hull: model 766 part3 (cockpit tub toward the centre, closed back toward the own goal), same origin, level units (scale 4).
  The entity rides 128 u above the floor. A third object (766, scale pulsing 0x1000..0x2200) is the glow effect.
- Ball: model 762 native mesh 8 (render id 0x2009, sphere r110, texture 0761/tex008 used as an environment map).
  762 also holds the knocked-out goal lightning (meshes 0-7, 514 u strips, 8 frames) and the ball's floor glow (mesh 12).
- Goal strips (CRASHBALL): open = extra_d1cc/cb64/ce98/c810 (cyan lights, p0..p3), closed = native part26/24/25/23 (red).
- HUD: atlas t08 0731 (assets/textures/0731): faces tex002 coco, 003 crash, 004 cortex, 005 dingodile, 006 brio, 007 tiny,
  008 koala, 022 rilla; big digits tex009-018 (grey, drawn with an orange gouraud tint 239,178,0 -> 239,89,0). Ballistix layout:
  faces 64x32 at native x 32/128/320/416, y 20; two-digit score under each at x+13, y 45, glyphs ~14x10, 17 apart.

## Camera
Real camera per level in `LEVEL_CAMS` (web/client/games/ps1cam.ts), verified by edge correlation against native frames.

## USA individual-versus results

The USA disc ran in PCSX ReARMed with controlled final-score fixtures. Frame 0 below is the winner's entry into state `0x22`. In the four captures the verdict flag `0x800` arrived one frame earlier. The native seat and object callbacks ran through the result with audio call sites logged.

- On entry the winner keeps the previous pilot pose. Script `0x1f` starts at frame 1. The hull advances 32 u per tick along its goal axis toward the 1280 u line and keeps its lateral position after the slide coasts out. Yaw eases toward zero by one quarter of the signed difference. Sky Balls adds the remaining angular velocity as it decays by 6 u per tick. Its floor height follows `FUN_800bfd14`.
- Mode 7 remains fixed until the callback starts with the ship at or within the 1280 u line. Mode 1 then fits the tracked winner with horizontal half-width 256, height 960 and zero depth. A ship in `0x24` leaves the tracking list, stays visible in script `0x20` and disappears with the knock-out burst in `0x25`. The fixtures' last knockouts reached `0x25` 61 ticks after dying entry.
- Music ducks at winner entry. The character name starts at frame 31. The `0x1b0` “wins” and then the character cheer follow at the measured waits below. The cheer sets flag `0x1`. In the Crashball frame capture the native cup tally first appeared three frames later, over the still-animating ship. The web uses that start time for the existing cup tally.

| Arena and native winner | First fitted frame and camera translation | “Wins” / cheer |
|---|---|---|
| Crashball, seat 0 Koala Kong | 29, (−35, 16, 3216) | 58 / 89 |
| Beach Ball, seat 1 Cortex | 29, (−35, 127, 3101) | 58 / 89 |
| N.Ballism, seat 2 Rilla Roo | 29, (−79, 96, 3132) | 55 / 86 |
| Sky Balls, seat 3 Koala Kong | 31, (80, 133, 3168) | 58 / 89 |

The winner's position, angles, celebration pose words and fit matched 915 sampled frames from five native captures when initialized with the recorded ship and platform states. The two Sky Balls captures include opposite residual steering.

The previous view kept the play camera through results. Crashball's Z translation was still 3327 at winner frame 45, where the native and revised browser views give 2147. The previous renderer also switched to a generic celebration when the host froze the match. The new view samples the disc pilot tracks and steers the hull during the native sequence. Big Stein and Top G reuse the selected Ballistix models (9011 and 9111), the Cortex track, and their own recorded name and cheer. Their “wins” / cheer frames are 66 / 97 and 67 / 98.

In L14 an existing rolling ball hit the winning hull two frames into its script. In L16 the raised machine retracted with sound `0x5c0` as the verdict arrived and a rolling ball kept moving. In L17 active platform events and old balls continued past the verdict, with no new lurches. Closed-goal barriers stopped colliding 30 ticks after the verdict. The renderer advances this action on a private world, using the verified Beach callbacks and allocator when they are already in the snapshot. The host keeps control of scores, placements and trophies. A terminal-only spectator rebuilds the arena clock and skips expired one-shots.

The controlled captures start from the native verdict state. Unscripted movement and collisions in the other three arenas still inherit their existing physics approximations. The web keeps its own standings art and match-transition timings.

## Verification
- Emulator traces (`r1.json`, 752 frames of CRASHBALL with an idle P0 and 3 MEDIUM AIs): ball spawn, bounce and landing timing (state 12 -> 6 -> 8 -> 1, speeds 40/56/72/80), rolling trajectories (replayed ball matches the real one to 0 units for 31 frames and through a bumper/ship hit within 6 units), and the ship hit (pushback point exact, heading within 4 units).
- Goal rate: real 11 goals in 25 s (idle P0 5, AIs 0/4/1). Sim with the real ship tracks replayed: 11.2 goals per 25 s of 2 balls; all-idle 9.8; skill 10 bots + idle P0: P0 3.3, AIs about 1.2 each.
- Beach Ball used a level-15 gameplay save from the USA disc in `tools/emu` and raw PS1 RAM. The `0x800b3528..0x800c0b7b` code bytes match the Ballistix overlay backing the Ghidra decompilation. The skill table, goal lines, collision markers and ship offsets were read from the running stage.
- Controlled MIPS runs of `0x800b8a68` used the stage RAM with seeded RNG words, CPU state and ball lists. The shared `bot()` plus `stepWorld()` matched 2,652/2,652 effective pads and planner state transitions across four slots and all three skills (previous sim 509/2,652 pads). Comparison masked off directions ignored by the ship's slide axis. Cases include one and three balls, roaming, defence, catch, kick priority and held-shot release. The isolated MIPS run emulated the GTE leading-bit count used by the native distance routine.
- Live slot-0 pad replays matched all 178 sampled ball states through release or kick: three one-frame cross taps, a held-cross timeout and one square tap. Catch moved from frame 1 in the old sim to frame 2 on the disc and in the corrected sim. Fast release matched frame 7 at 224 u/frame, timeout matched frame 152 at 48 u/frame, and the 620 u kick contact moved from frame 2 to frame 3. Replay frame 1 is the button press. Run the focused fixtures with `cd web && npx tsx scripts/test-beach-cpu.ts`.
- Three instrumented USA scene replays started from the same frame-5705 gameplay checkpoint. The traces logged RNG call sites and CPU, ship and ball callbacks for 480 consecutive frames each. The seat configurations were an idle human with three Normal CPUs, two idle humans with two Easy CPUs, and four idle humans. The replay imported the native starting state, including the order table and RNG words. The comparison tracked effective CPU direction and action, ship position, velocity, cooldown and score, and ball position on the arena, heading, speed and state.

| Native scene | First divergence before frame-order port | First divergence before bias correction | Corrected uninterrupted replay |
|---|---|---|---|
| One idle human, three Normal CPUs | Frame 5706 RNG, frame 5726 steering | 476/480. Frame 6182 staged pad, frame 6183 ship and held-ball position | 480/480 through frame 6185 |
| Two idle humans, two Easy CPUs | Frame 5706 RNG, frame 5723 steering | None in 480 frames | 480/480 through frame 6185 |
| Four idle humans | Frame 5706 RNG, frame 5734 serve heading | None in 480 frames | 480/480 through frame 6185 |

- Executing the USA MIPS routine for seat 1 on frame 6182 gave defence ray intercept x=32, biased target x=96, and steering error 703 u. The reversed opponent row had put the target at x=−32 and reduced the error to 575 u. With the native row, the staged pad is `0x4020` (cross and right). The ship applies it on frame 6183 and reaches x=−321 with velocity −44 and held ball x=−308.
- The shared RNG words match all 1,440 frames in uninterrupted replay. The corrected planner also matches all 2,652 isolated decisions and state transitions with the native seed placed immediately before each decision. The focused tests cover frame-5759 seat ordering, the frame-6182 staged pad, and the frame-5964, 6117 and 6475 contacts. A 132-frame mixed prediction test includes ball contact, catches by both controllers, a human release, and a CPU releasing two balls at once. It compares the complete predicted and host worlds with three unacknowledged pads replayed on each reconciliation. A separate Party loopback verified that frames 5964–5965 match in client prediction and in the host's serialized snapshots.
- Crashball, N.Ballism and Sky Balls each matched their pre-change sim trace at all three skills over 2,400 frames per run, comparing inputs, world RNG, bodies, gameplay state and events.

### Extended USA mixed replays

All recordings start at frame 5705. The active runs feed the sampled human pads back into the sim and reach four balls. Prefixes compare both RNG words, effective CPU inputs, queued CPU directions and actions, ship x/z, velocity, kick cooldown and score, and ball x/z, heading, speed and state.

| Native scene | Prefix before contact port | Current uninterrupted prefix |
|---|---:|---|
| One idle human, three Normal CPUs | 769/799 | 799/799 through frame 6504 |
| Two idle humans, two Easy CPUs | 719/719 | 719/719 through frame 6424 |
| One active human, three Normal CPUs | 411/960 | 960/960 through frame 6665 |
| Two active humans, two Easy CPUs | 258/960 | 960/960 through frame 6665 |
| Two active humans, two Easy CPUs, longer capture | | 1680/1680 through frame 7385 |
| One idle human, three Normal CPUs, longer capture | | 1680/1680 through frame 7385 |

- The original active runs match all 3 and 12 native contact sound calls, respectively. The longer active run matches all 20 contact calls, with 23 human catches and releases, 14 CPU catches and 13 CPU releases. Contact counts include multiple calls on a single frame.
- Seat 0's first Tiny gesture starts on frame 6216 at render word `0x4201`. The native script returns to `0x4000` on frame 6261 at timer 635, then counts down on frame 6262. This puts rand(600) before seat 2's planner on frame 6897, which queues cross (`0x4000`). Both RNG words and all 21 contact sound calls now match in uninterrupted replay. The capture also verifies the spectator switch on frame 7064, the four knockout draws on frame 7124 and the first smoke heading draw on frame 7133.
- The previous 3,400-step recording now matches through frame 9105, including every ball slot and all 60 ball-contact calls, with the allocator running normally.

### Uninterrupted USA versus results

The fresh captures start at the first playable serve with all four seats on 12 points. The harness seeds the two native RNG words at the initial sample, then advances continuously. The checkpoint captures start later in a round. Comparison covers both RNG words, controller timers, ship motion and state, effective CPU actions and queued steering and actions during play, walls, ball motion and state, active pool slots and the first eight free slots, ball-contact sound calls, and the result frame. Headings are compared modulo 4096.

| Native scene | Starting RNG words | Consecutive steps matched | Result frame and score (seats 0–3) | Ball contacts |
|---|---|---:|---|---:|
| Fresh, one idle human and three Normal CPUs | 3901097, 19921761 | 3951/3951, 3275–7225 | 7126, [0, 0, 0, 5] | 36 |
| Fresh, one idle human and three Hard CPUs | 56891, 593135681 | 4192/4192, 3275–7466 | 7364, [0, 0, 8, 0] | 60 |
| Checkpoint, one idle human and three Normal CPUs | 2578326094, 4104266876 | 3756/3756, 5706–9461 | 9344, [0, 0, 8, 0] | 66 |
| Checkpoint, one idle human and three Hard CPUs | 56891, 593135681 | 4419/4419, 5706–10124 | 10022, [0, 0, 0, 6] | 61 |

- A 32-checkpoint regression covers allocation, free order, kick lockout, sinking-ball contact and victory. The original allocator fails the check on 7706. The Party host, wire snapshots and GameClient prediction match 7681–9344 in the Normal checkpoint replay, 3275–7126 in the fresh Normal round, and 3275–7364 in the fresh Hard round. Prediction also matches with three unacknowledged pads replayed after each reconciliation.

## Unknowns
- Sky Balls CPU routes and ball trajectories still need uninterrupted round comparisons.
- The four-stage opening test samples one human’s movement and arena counters. Countdown camera, CPU setup, timeout results, team and adventure rules remain outside those comparisons. The catch-loop sound starts in the renderer, so the shared events differ from the disc's sound log even where the gameplay matches.

### Crashball background flashes

The L14 arena callback at `0x800bc0d8` rolls once in 15 for a flash. Actor `0x1504` draws level model 0659 part 22 at a fixed position behind the ships. The callback at `0x800bfe70` samples five horizontal/vertical scale pairs, then removes the actor. Flashes can overlap during the countdown and play. The terminal replay lets existing flashes expire.

A USA capture contained 13 spawns in 230 frames. At native frame 4738 the first of two overlapping flashes spawned at (1896, −252, 4109). Hiding the mesh in a second run isolated the blue flash in the framebuffer. Chromium reproduced the spawn positions and scale sequence. WebGL and PS1 rasterization give slightly different pixel coverage at the edges. The multiplayer check compared flash positions on two WebRTC clients during a round.

### Corner and serve markers

`FUN_800bc564` registers two render nodes per corner (markers 20–23 and 30–33). Crashball contact writes 3 at `0x800c1e3a + 20*i`. The next arena update decrements it before selecting the meshes. A single contact keeps the resting artwork on the impact tick, selects the alternate mesh pair on the next two ticks, then restores the resting pair. A second contact extends the flash. The missing L14 resting nodes `0x501f` and `0x5022` share position (−3, 0, 1) and the identity matrix with the other corner nodes.

N.Ballism uses the post flag at `0x800c1e38 + 20*i` for the same mesh selection. The alternate pair marks the available shield. Beach Ball and Sky Balls have no corresponding art change. Crashball also cycles four meshes for each serve indicator, independently of rebounds. The first illuminated serve frame is the update on which the cooldown reaches 30. The cycle changes mesh at phase 4 and every four ticks thereafter, returning to rest when the cooldown reaches zero.

The WebGL comparisons covered 36 USA PCSX frames per arena, including repeat and simultaneous rebounds. Live and result updates selected the recorded mesh words in each case. An additional 34-frame capture covered all four serve markers. Each alternate corner pair changed visible pixels at the normal camera. Snapshots retain eight ticks of corner light selections so interpolation can show the two-tick pulse between regular network updates.

## Effects (decoded)
The overlay spawns one effect script: `FUN_800b79f4` (dying state) -> `FUN_8007a524(0, shipPos, 0762)` + sfx 0x586 = pack 0762 script 0
(ring part 13, flash 14, glow 15, smoke 16 / 17, six shards 18). Ball hits, bounces, serves, goals, catches and launches are sound only;
Crashball draws the six stored trail positions with mesh 12.
- N.Gin machine (`FUN_800bbc3c`/`FUN_800c00b0`): pack db 0x80054574 = disc **0764** (db entries are 0x38 apart; the first word points at
  {LBA, size}: 0x7051 sits between 0762 at 0x7042 and the ship 0766 at 0x7065). Render id 0x2001 = part0 (closed pod), 0x2006 = part5
  (open, while it spits); script 0 (parts 1-4: flash, rays, puffs) plays at the rise and the retract. Raised y = DAT_8005a5d8 = 0.
- N.Ballism post (`FUN_800bd770`): looping script 1 of the level model 0651 (parts 20-28: crystal, pentagons, lightning) at marker
  0x8005b2b8[i+4] = (1649,-373,1655), (1649,-373,-1640), (-1663,-373,1655), (-1646,-373,-1640) (read from the running level 16).
  Pickup (`FUN_800bdab8`) tests the ship against the bumper table 0x800c1a7c (x, z, r): r + 0x80 + 0x40.
- Hull render id (`FUN_800b5c30`): 0x2004 (766 part3) normally, 0x2006 (part5, the same hull with its bumper lights off) in state 0x21
  (catch) or while the kick cooldown +0x66 (0x8009d592) is set. Ported.

## Sky Balls platform (FUN_800bc0d8 sky part, FUN_800bd43c, FUN_800bd510, FUN_800bca38, FUN_800bb41c)
- Event timer 0x800c1c78: init 0x10e, then rand(9)*30 + 0x10e; index 0x800c1c7c (init rand(0x12)) steps through table 0x800c19fc
  (4 players) `1,2,3,2,3,1,3,1,2,1,2,3,2,3,1,3,1,2` (never player 1; 0x800c1a20 = 2,3,... when 0x8005a680 != 0). Read from the emulator.
- Event (bd43c) on player p (slot 0x800c1e78 + p*0x1c = pos, vel, max, accel+, accel-, dir, state, timer): timer rand(30)+60, state 1,
  accel- 0xa0, max 0x300, dir -1; sfx 0x5c9 + 0x5ca..0x5cd (rand 4). bd510 runs the lurch / rock-back state machine (states 1 -> 2 -> 3 -> 0);
  emulator: pos dips to about -8000 and rocks back over ~3 s.
- Tilt (bca38): base wobble rz = (sin(u*0x40)+cos(u*0x20))*11>>12, rx = sin(u*0x20)*5>>10, floor y = cos(u*0x20)*3>>7 (u = frame & 0x7f);
  each event adds t = atan(0xa00, pos>>4) - 0x400 along the player's diagonal (p0 rz+ rx-, p1 rz+ rx+, p2 rz- rx+, p3 rz- rx-).
  Applied as rx / rz of the disc nodes.
- Balls (bb41c, sky): push = |sin(rx)*5>>3| + |sin(rz)*5>>3| >> 6 toward the downhill side; it bends the heading only (replaces the ship push).
- The arena computes its tilt from the existing offsets, then advances the fan events. The affected fan cycles its eight model parts in states 1 and 2. The landscape and clouds use world coordinates.
- A ship orbits at radius 2304. Its height callback `800b5ec8` samples the floor after the pad's bumper probe and before the orbital step, then adds its hover. The hull keeps its world-space yaw and banks with its steering. Tilting its render origin with the platform displaced a hull by as much as 174 units in the L17 comparison.
- WebGL reproduced all 1,916 ship positions and rotations over 479 captured updates with the recorded pads and platform state, including sustained corner contact, idle bobbing and fan recovery. A second capture synchronized the engine clock to the web round and matched all 392 sampled countdown ship transforms. The web clock starts its own wobble phase. Two WebRTC clients using Top G and Big Stein agreed on all 185 common snapshots during the live test.
