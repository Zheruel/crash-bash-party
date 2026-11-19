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
| 0x800b42f4 | push ship out of corner bumpers (r+0x80) |
| 0x800b4efc | "ball clear of bumpers/box" test (state 6 -> 8) |
| 0x800b60fc | state trigger (cross -> 0x21 catch on beach, square -> 0x1f kick) |
| 0x800b8a68 | AI pad generator; 0x800b7c60 ray predict |
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
- Corner bumpers (centre, r): crash/beach (+-2048, 512); n.ballism (+-2128, 416); sky (+-1869, 464). Ships are pushed out of them.
- Ship (crash/beach/n.ballism): slide max 0x68 (0xa0 with a shoulder), accel 0x22 (p1 0x2a; boost 0x38), decay 0x12 when idle. Bumper-pushed adds +-(max>>1) to accel; push with no input zeroes vel; vel 0 while accelerating becomes +-1. p0/p1 slide on x, p2/p3 on game z.
  Sky: max 0x28 (0x48), accel 0xd (p1 0x15; boost 0x12), decay 6; ships orbit a ring of radius 2304 (angle += vel).
- Ball speed: `spd` moves toward `tgt` by acc (4) up / dec (1) down each frame, then position update. Hits raise `tgt` by 4 up to 0x90.
- Ball states: 0 new, 0xc waiting 15+1 frames at a corner, 6 falling in, 8 bouncing, 1 rolling, 2 held (beach), 4/0x11 sinking in goal (4 beach/n.ballism: speed halves, y drops 0x60/frame; 0x11 crash: timer 8 (4 from state 8) then sink += 0x200), 99 sky goal (timer 0x10, heading forced outward), 0x12 scored.
- Spawn: corner cooldown 0x1f frames (decremented every frame in 0x800bcb..), corner from `SPAWN_AFTER[last conceded]` (rand 2) else rand(4); aimed at the centre, jitter rand(0x1c7)-0xe3 applied when it clears the corner. Crash: y0 -256, v0 0x30, gravity 6, speed 0x20 -> tgt 0x50. Beach tgt 0x30. N.Ballism y0 -1280, v0 0x10, accel 3, bounce v>>2. Sky y0 -2048, v0 0x40, speed 0x50. Rest y = -96. sfx 1440 on spawn (not in sky).
- Ball count: `efc` starts 10, counts down; at 0 `ef8++`, target = ef8/300+1 (max 5; beach 4; 0 while the N.Gin machine runs); create when fewer, re-arm 30. (So +1 ball every 10 s.) `off` = {16,8,4,2,1,0..}[count] feeds the AI.
- Ball vs ball: overlap push, heading along the line, speeds averaged, sfx 1408.

## Ship vs ball (0x800be4d4) - verified against emulator traces
- Order in a frame: ship moves (`0x800b5c30`), then collision, then the ball moves (so a hit ball also travels that frame). The push uses the ship velocity from the start of the frame (the `|vel|` before this frame's decay/accel) - trace: speed 80 + 112 (capped 144).
- Body sphere r345 at the ship; front sphere r414 at 132 u toward the wall; front used when |adiff(face, angle(ship - ball_prev))| < 0x38f. Ball radius 128 added. Catch state (0x21) adds 0x80 to the front radius.
- Hit: ball pushed back along its path to radius+8 (`FUN_800be1c4`); new heading = atan(spd*vec(n) + |vel|*vec(face)) then `va + clamp(adiff(h+0x800, va), +-0x3f0)` if |D| <= 0x400 else `va` (n = angle ball -> sphere centre). speed += |vel| (cap tgt+0x40); tgt += 4 (to 0x90); last toucher = player. sfx 1404..1407 (rand 4).
- Face = fixed quantised yaw (`(atan(x,z)+0x7f)&0xc00`) on crash/beach/n.ballism; on sky it follows the ring angle.

## Kick (0x800befd4, state 0x1f)
4 frames; sweep radius `((kfr*0x600+0x1000)&0xffff)>>3` = 0x200, 0x2c0, 0x380, 0x440 (+128 ball radius) around the ship centre. Hits balls in state 1 or 8 with hit cooldown 0. Heading = angle(ship -> ball) + pointing back; cooldown 4; sfx 1413. Speed = old tgt + 0x40; new tgt 0x90 (crash/n.ballism), 0x40 (beach), 0x80 (sky). Penalty: on kick `kpen = min(kpen+30, 90)`, `kcd = kpen`; a hit zeroes `kcd`; `kcd` decrements first, then `kpen` (cannot kick while kcd > 0). Swing sfx 1409+p.

## Per level
- **CRASHBALL (0xe)**: plain. Goal falling state 0x11. Bank 0157. Border strips cyan in game; floor steel plates.
- **BEACH BALL (0xf)**: cross = catch (state 0x21, hold timer 0x96). Front sphere +0x80; ball becomes state 2 (held) sitting on the front sphere at offset `hoff` (+-0x220). Release when cross is let go after 6 frames: speed 0xe0 (fast), 0x30 on timeout. Ball tgt 0x30, max 4 balls. Bank 0156.
- **N.BALLISM (0x10)**: power-up post at a corner (`POST_SEQ[i]`, 180 frames, spawned when no post/shield, reload rand(90)+30). Pickup = shield 0xf0 frames that repels rolling balls within 0x859 (push (R-dist)>>4 bends heading). N.Gin machine at the centre: wait (rand(15)+8)*30 frames, rise, spin up 0x5a, spit 0x96 frames (a ball every 16 frames while < 8 balls: at 416*vec(yaw), heading = yaw, speed 0x80, yaw += 0x1c7/frame). Retract sets `efc = 0x19`. Bank 0155.
- **SKY BALLS (0x11)**: ring ships, radial goals, goal falling state 99, platform tilt events (ported, see below), ball y0 -2048. Bank 0154.

## AI (0x800b8a68)
- Skill table: EASY 2, MEDIUM 10 (read live: 10), HARD 18. Aim error: `WIN[(0x20-skill)-off]`, error = rand(win)-win (always negative).
- Ray of length 4096 u from the ball with the error heading, intersected with the defence segment (z = +-1952 / x = +-1952, +-2048). Target = ball with the smallest dist^2 to its intercept.
- Move: pad bits from octant table [0x10,0x30,0x20,0x60,0x40,0xc0,0x80,0x90] by `(angle>>9)&7`; dead band when `|diff| + (skill+off)*0x20 > 0x280`; boost when the ball's distance to the intercept is under that value.
- Kick: ball within `skill*16 - off + rand + 0x100`; blind-kick lapse probability skill/32 with a 39-frame timer; a ray that hits the line overrides the lapse. Beach: catch when a ball is within 640 and +-0x2aa of facing.
- Port: memoryless; randomness from a hash of (tick, slot, ball id) so `bot()` is deterministic and never touches `w.rng`.

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
0x1c idle, 0x1d moving, 0x1e hit/boost, 0x1f kick, 0x21 catch, 0x24 dying, 0x25 gone. Per-state anim scripts (VM `FUN_8008502c`,
blocks of `0 0x8007 N pose 0x8000|0x8004 st|0x8005 x`, pose = 0x4000 + (clip<<7) + frame) at 0x800c1560 + 0x6c per character.
Block order: 0x1c, 0x1d, ?, 0x1e, 0x1f, loop, loop, dying. Clips idle/move/hit/catch/dying: crash 0/3/4/2/5, tiny 0/1/3/2/5,
dingodile 0/4/3/2/5, rilla 0/3/4/1/5, koala 0/1/4/5/2, coco/cortex/brio 0/4/3/2/5 (the last three by pattern). Kick keeps the idle clip.

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

## Verification
- Emulator traces (`r1.json`, 752 frames of CRASHBALL with an idle P0 and 3 MEDIUM AIs): ball spawn, bounce and landing timing (state 12 -> 6 -> 8 -> 1, speeds 40/56/72/80), rolling trajectories (replayed ball matches the real one to 0 units for 31 frames and through a bumper/ship hit within 6 units), and the ship hit (pushback point exact, heading within 4 units).
- Goal rate: real 11 goals in 25 s (idle P0 5, AIs 0/4/1). Sim with the real ship tracks replayed: 11.2 goals per 25 s of 2 balls; all-idle 9.8; skill 10 bots + idle P0: P0 3.3, AIs about 1.2 each.

## Unknowns
- Sky Balls: tilt push, platform events, ring face angle details; bot is approximate.
- Beach held-ball placement and catch/launch sfx ids (placeholder 1417); beach AI simplified.
- Ball vs ship skips states 4/0x11/99 (sinking balls).
- Clip index mapping for the ship character; corner-bumper flash timing (it shares the spawn cooldown counter at 0x800c1cfa).

## Effects (decoded)
The overlay spawns one effect script: `FUN_800b79f4` (dying state) -> `FUN_8007a524(0, shipPos, 0762)` + sfx 0x586 = pack 0762 script 0
(ring part 13, flash 14, glow 15, smoke 16 / 17, six shards 18). Ball hits, bounces, serves, goals, catches and launches are sound only;
no trail objects.
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
- Tilt (bca38): base wobble rz = (sin(u*0x40)+cos(u*0x40))*11>>12, rx = sin(u*0x20)*5>>10, floor y = cos(u*0x40)*3>>7 (u = frame & 0x7f);
  each event adds t = atan(0xa00, pos>>4) - 0x400 along the player's diagonal (p0 rz+ rx-, p1 rz+ rx+, p2 rz- rx+, p3 rz- rx-).
  Applied as rx / rz of the disc nodes.
- Balls (bb41c, sky): push = |sin(rx)*5>>3| + |sin(rz)*5>>3| >> 6 toward the downhill side; it bends the heading only (replaces the ship push).
- Port: sim `skyPlatform` + `applyPush`; view tilts the whole game root (disc, ships, balls ride it) and holds the landscape / clouds still.
  Direction checked against the emulator (player 3's event lifts the same side). Not ported: the fan flicker on the event player's side.
