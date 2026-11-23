# Pogo Pandemonium (Pogo Painter, Pogo-a-gogo, El Pogo Loco, Pogo Padlock) - levels 10..13

Source of truth: `re/out_pogoPainter/ovl.c` (overlay). Sim: `web/shared/games/tilePainter.ts`, view: `web/client/games/tilePainter.ts`.
Engine facts (units, pads, tile cell layout, timer) are in `engine.md`. Everything is per 30 Hz frame.

## Common rules
- 4 players on an 8x8 board; slots start BL yellow (0), TL red (1), TR blue (2), BR green (3), facing up, right, down and left (`FUN_800b3808`). Match clock starts at 1:30. Highest score wins; a tie for the top draws.
- Score (short, player +0x50) changes only in `FUN_800b7990`.
- Hop (`FUN_800b574c` decision, `FUN_800b5ee4` landing): hold a direction; cnt starts 0, +1 per frame (+2 with speed). Move window starts at S and lasts M frames; land at cnt 17 (the snap to the tile centre); next decision on the following frame = 18 frame period (10 boosted). Per character family (1..8) S/M: fam1 3/9 (56 u/frame), fam5 5/12, fam6 5/12 (42 u/frame), fam8 5/13 (39 u/frame). Tables pre c502c, post c5050, total c5074.
- Landing: reservation cleared; sfx 0x55e+fam (`FUN_800b8af8`); if owner != p sfx 0x55a+p (`FUN_800b8dfc`) and flag 0x10 set; own tile: nothing; foreign tile only stolen in state 1 or 3 (0 flipping, 7, 10 are not); state 5 = mine -> explode (`FUN_800b8180`). Paint (`FUN_800b7b1c`): state 1, or state 10 / timer 240 while holding the shield, then capture check.
- Can move (`FUN_800bdcb8`): in board, unoccupied (occupant incl. monster), reservation 0 or own; CPUs also refuse state 5/6 tiles (humans may walk onto mines).
- Stun 51 frames (`FUN_800b6f34`, anim 0x3b): item cleared, shield unlocked. Mine blast = every player within Chebyshev 1 of the mine tile.
- Tile states: 0 flip-in (timer then 1), 1 normal, 3 cash flip (timer 10 then neutral), 5 mine (timer 120 -> explode, neutral), 6 hazard (adventure), 7 cross tile, 10 locked (timer 240 -> 1).
- Cash (`FUN_800b788c`/`c2338`): all tiles of p -> neutral state 3 timer 10, score += n.
- Capture (`FUN_800c1a18`, levels 11/12 only): flood fill (8-connected, `FUN_800c1840`) from edge seeds through every tile not owned by p; unreached unoccupied non-5/6/7 tiles become p (state 0, timer 10), sfx 0x51d. Level 11 then cashes immediately (`FUN_800bbb08`).
- Pickups (`FUN_800b935c`, `FUN_800ba018`) are handled before the state handler once the object is in state 3: an arrow after 16 growth updates, an item crate on its landing update 32, a cash crate after 16. Pickup replaces the held item. Item ids: 1 missile (stun), 2 four-way missile, 3 electro beam, 4 steal gun (kind-3 missile), 5 speed (240 frames), 6 shield (240 frames).
- Fire = square (`FUN_800c2cbc`): item 1 `FUN_800bc184(p,0)`, 4 `(p,1)`, 2 `FUN_800bc314`, 3 `FUN_800ba51c`. Projectile object 0x1404 (`FUN_800bc5bc`): starts at the shooter's tile centre, moves 144 u/frame on a cardinal heading, and hits within 160 u. Both axes use the inclusive bounds −2560 to 2048 u (−1.5 to 7.5 tiles) during play and after timeout. Contact consumes the shot and affects a victim whose hit flag is clear. Steal (`FUN_800bb724`): all victim tiles -> shooter state 0 timer 10, sfx 0x552. Beam (object 0x1405): stuns everyone on the line ahead, shooter in state 0x3f (20-tick counter from `FUN_800c2be8`).
- Arrow crate (`FUN_800b9c10`): timer arT starts -1 and runs through the pre-roll, set 40+rand(70) when count < table `c38d8`; at <= 4 spawn; after spawn arT = -1 if count > `c38e8` else 40+rand(70). Counts lvl 10..13: 2,2,2,0. Type 7 (line one way) on 10; on 11 rand(3)!=0 -> 7 else 8 (both directions). Start direction `rand(4)` (0 +z, 1 +x, 2 -z, 3 -x), drawn after the tile and the type; it steps on the first ready update and then every 35 updates as the yaw catches up. Lines (`FUN_800b8660`) start at the crate tile: state 0, timer 6+4k, skip states 5/6/7; sfx 0x515; then capture.
- Item crate (`FUN_800b9d64`): itT starts -1 and runs through the 112-update pre-roll; stays -1 while count >= `c38b8` (2,2,1,1), else 60+rand(60); spawn at <= 1; after: -1 if count > `c38c8` (3,3,1,2) else 60+rand(60). Types: lvl 10 two thirds 1 / one third 5; lvl 11 rand(5): 0->3, 1-2->5, 3-4->2; lvl 12 rand(2): 1 / 5; lvl 13 type 4 or 5.
- Free tile (`FUN_800c165c`): up to 10 random tries of `FUN_800bc04c` (unoccupied, unreserved, no object, state not 5/6).
- Cash crates (`FUN_800bb12c`): 2 on lvl 10, 3 on lvl 12, 2 on lvl 13, none on 11. First timer `60 + rand(60)` (`FUN_800c1b7c`) from the pre-roll; state 0 wait, 1 place (sfx 0x3fa), 2 grow 16, 3 ready, 4 used -> wait 40+rand(40). Pickup sfx 0x514 + cash.

## Per level
- Lvl 10 Pogo Painter: tiles paint only; arrows (type 7), item crates, 2 cash crates. No capture.
- Lvl 11 Pogo-a-gogo (flags: border): coloured ring around the board (table 0x800c3c14, row 0 `00001111111122222222333333330000`, row r = shift by r). Left side i0..7 (x=0, z=i), top i8..15, right i16..23 (z 7..0), bottom i24..31 (x 7..0). Flood seeds from edge segment i unless the segment is the player's colour (`FUN_800bb840`), except at ends of the run. Rotation at remaining 75, 60, 45, 30, 15 s: type rand(4)+1 (cw 8, cw 16, ccw 8, ccw 16 steps) one step per 8 frames, sfx 0x534 at start, beeps 0x532 (the two seconds before), step 0x533; each step recaptures for all players. No cash crates; captured tiles are cashed on capture.
- Lvl 12 El Pogo Loco: monster object 0x1406 (`FUN_800beea4`, walks `FUN_800bfc6c`, hop cycle 14 frames `FUN_800c0cf4`): start at (3,8), starts play at timer 49 and enters patrol on tick 48, patrols the outer rim (2 cells per hop) for 100+rand(60) frames, then runs an action from table `0x800c468c` [6,6,6,7,6,7,6,7,6,6,8,8,6,8]. Walk: hops 2 tiles inward (+rand(3)-1 sideways), leaves a mine (state 5, timer 120, owner 5) on each landing; action 7 makes the bf4-th landing (rand(3)+1) a cross tile (state 7). Action 8 ends in a spin (140 frames) firing missiles that hit everybody. sfx 0x542/0x543 at action start. Landing on a cross tile (`FUN_800c1ea8`) paints the row and column (state 0 ripple) and captures, sfx 0x515. Capture rules as lvl 11 but edge seeds on all four sides and cash crates cash it.
- Lvl 13 Pogo Padlock: landing on your own tile (flag 0x10 clear) wipes all own tiles (sfx 0x54b, `FUN_800b8f94`, no paint); landing on a locked tile plays 0x54e+p. Padlock object 0x1408 (`FUN_800c0584`): appears silently on a free tile after 128 play ticks, grows 16 frames, waits `c5334[stage]` = [1,4,7,10,14,19,23,28] frames, then hops to a random adjacent tile (18 frames, 1/6 of the distance per frame); hops per stage `c530c` = [18,16,14,13,12,10,8,7], then stage+1. Pickup by landing: shield 240 frames, all own state-1 tiles -> state 10 (240) sfx 0x54c; padlock hides 120 frames then respawns at stage zero. Shield end: state 10 -> 1, sfx 0x54d. Item crates 4 / 5; scoring via 2 cash crates only.

### Versus board artwork

Each stage has 64 placed quads. Their sub-mesh records are 0x7c bytes apart, ordered by X then Z. The overlay replaces the UV corners, texture page and CLUT while preserving the positions and vertex colours. The browser draws the same corners as a single mesh. Run `python3 tools/build_pogo_board.py` to rebuild the atlas from the four USA T08 packs.

| Stage | Neutral | Paint and special cells |
|---|---|---|
| Pogo Painter · 0674 | 60 | Texture 60 with the CLUT from 56, 53, 54 or 55 in seat order |
| Pogo-a-gogo · 0670 | 82 | Textures 82–97 with CLUTs from 77, 74, 75 or 76 |
| El Pogo Loco · 0666 | 53 | Texture 78 with CLUTs from 68, 67, 65 or 66. From a fresh mine through its final 29 ticks the images are 54, 63, 62 and 61. The cross uses 64. |
| Pogo Padlock · 0662 | 0 | Texture 38 for paint and 49 for a lock, with CLUTs from 41, 38, 39 or 40 |

`FUN_800bbc94` selects Pogo-a-gogo's paint shape by matching the tile owner in four directions. The bits are left 1, −Z 2, right 4 and +Z 8. The rim supplies the neighbour at the board edge. Its 32 phases select model 0671's `extra_1d044` followed by parts 11–41, using the render-word table at 0x800c3b14. Changing the rim updates the connections to edge tiles.

The board callback expires flips, cash flashes and mines as the timer falls below two. All 134 sampled live expiry transitions reached native state 1 on that tick. The result view uses the same timer callback. Cashing updates the score immediately and retains the prior tile face at timer 10. The host sends that face for reconnects. The first mine from a monster crossing plays 0x3f0 (bank 0169, sample 7) at 90, 60, 30, 20 and 10. Its two crossing cries use samples 3 and 4.

Four USA runs provided 451 consecutive frames per stage. Comparing just the sampled tile state with the GPU packets matched 114,911 of 115,456 tile materials. The remaining 545 include paint, cash and mine transitions where the packet and current tile state differ. The port derives the board from the online snapshot and round clock. It does not reproduce the order of every native tile draw callback. Chromium rendered all 32 rim phases and all four mine images. A two-peer Pogo-a-gogo run compared 468 rendered boards, including a reconnect. `web/scripts/test-pogo-board.ts` covers all 64 coloured joins, a cashed lock and the five warning cues.

### Player rockets and hit reactions

`FUN_800bc184` resolves a held diagonal in the order Up, Right, Down, Left. Movement separately chooses a legal vertical hop, falling back to the horizontal hop if blocked. Down + Right can therefore fire right while the rider moves down. With no direction held the shot uses the current heading. A four-way shot (`FUN_800bc314`) allocates Left, Right, Down, Up in that order, skipping outward directions at the rim.

The first frame shows the head at the rounded shooter tile, at native Y −400. Movement and contact begin on the next object update. A shot fired from (3, 3) towards a rider on (5, 3) spawned on frame 1, hit on frame 8, and put the victim in state 0x3b on frame 9. Frame 60 returned the victim to idle. Stun entry cancels the victim’s beam, snaps an interrupted hop to the nearest tile and reserves that tile. Ordinary stuns use character script 0x31. The explosion at the projectile endpoint is script 0. The smoke from script 2 belongs to the result loser. A steal transfers painted tiles before the victim drops the shield.

The firing routine requests character cue block × 50 + 0x10 before the launch sound. The eight stock Pogo voice banks have no tone for that cue. Big Stein and Top G supply their own effort take. The stun handler requests the first hit voice in the character's block (offset 3). The launch and hit dispatch both use the acting seat’s roster identity online.

Twelve controlled USA replays (single, four-way and steal on all four stages) and the normal sim agreed for 768 updates on active projectiles, including their order and positions, and all four riders’ hit flags and stun states. All 24 shot endpoints matched. Additional L10 captures exercised blocked diagonals, an off-centre hit and the two victims' full 51-frame pose sequences. MIPS calls to idle, hop and beam handlers checked the priority of a pending hit against the three verdict flags. `web/scripts/test-pogo-rockets.ts` covers launch, tile transfer, stun timing, snapshot replay and a post-timeout hit during a hop. The fixtures grant items directly; pickup selection and whole-round random sequences remain separate.

### Pogo-a-gogo electro beam

In L11, a stationary rider can turn into an open hop on the firing frame. The beam starts half a tile from the rider’s original position and the rider takes one stride. A blocked input retains the previous heading. A rider already hopping keeps the hop heading, releases the reservation and eases to the nearest tile. On each of the next 20 ticks, state 0x3f removes a quarter of the remaining displacement in whole PS1 units and turns by an eighth of the signed heading error. Firing out of the board keeps the item.

Object 0x1405 stays fixed at native Y −80. Its one to seven segments start at local X 0 and advance by 512 units. The initial mesh is 0x2005. On each callback the render words become 0x2003 + ((global frame + segment) & 7). The strike includes the rounded muzzle tile and every tile ahead in that row or column. The rider’s script 0x30 starts a pack 0770 script 7 spark at each event 0x14. Script 8 starts half a tile beyond the last tile centre at the board edge for a stationary shot. When fired from a hop it retains the shooter's sub-tile offset. Its origin is Y −144.

The engine builds an object callback queue before dispatching players. A loose pickup allocates its puff, then frees its queued slot. A beam allocated into that slot animates and hits on the firing tick. An ordinary allocation waits for the next tick. A USA capture with the same rider firing right showed both timings by moving the pickup. A speed pickup taken by another rider before the shot also produced an immediate callback. The host and prediction now use the original shuffled player rows and retain the dispatch RNG in snapshots. The row draws and texture phase are relative to the web round. Exact alignment with an uninterrupted console session depends on the console’s shared RNG and frame clock.

Across 461 controlled USA updates, the sim matched shooter position, yaw, item, timer, hit flags and stun states. This included 240 beam poses, the matching segment words and 60 rider sparks. A separate draw-packet capture found 72 textured triangles using opcode 0x36, CLUT 0x577b and texture page 0x003e or 0x003f. All visible colours in that palette set STP and all packets select additive blending. The browser uses the same blend for the eight beam meshes.

### El Pogo Loco's spin

Two held-input L12 captures showed the first player hop with monster timer 48 and pose 0x4087. The last waiting tick shows 0x4082, followed by the 14-frame hop clip. Each hop advances on frames 2 through 11 by a whole PS1-unit delta per axis, truncated towards zero. The remaining distance can be several units. `FUN_800bf8e4` eases yaw halfway to the target from `FUN_800c0d44` each update. The shadow uses pack 0770 part 40, scale 0x15c0 at Y −16, and takes the monster's position before movement.

Action 8 finishes its entry hop at word 0x410d. From that frame the next 140 updates turn the monster by 22 units each and cycle through words 0x4000–0x4014. The shot cue 0x522 and projectile constructor run on 0x4012, at ages 19, 40, 61, 82, 103 and 124. A timeout still processes the current animation event and then ends the spin. The six hop sounds 0x53c–0x541 select bank 0169 samples 0, 1 and 2 at two pitches.

Each projectile appears at the monster's exact X/Z, at Y −528, and moves on its next object callback. On each axis the engine negates the arithmetic right shift of the fixed-point sine or cosine times nine by eight bits. In one capture the first shot's yaw was 118 and its first step moved (254, 264) to (229, 123).

Three controlled USA runs took action 8 through the normal encounter dispatch at different headings. Replaying the captured spin entry and rider positions matched 420 monster poses and 285 active projectile positions. One seeded approach also matched the entry hop and the turn back to walking. `web/scripts/test-pogo-monster.ts` covers that approach, the first projectile hitting either custom rider, and a timeout on a shot frame.

### El Pogo Loco's route and landing tiles

The monster moves two tiles along its current heading. On the rim, reaching a corner turns the following hop. Overshooting folds the current hop one tile onto the adjoining side (`FUN_800bfa14`). During a crossing, `FUN_800bfc6c` adds a sideways offset of −1, 0 or +1. A rider, a rider's reservation or any crate blocks the destination. After five rejected draws it picks a new heading. On exit, the sideways offset is kept. If the monster overshoots the outer rim it also moves one cell towards the middle of the edge. The exit heading depends on frame parity.

The occupied tile uses the rounded position **before** movement. The movement callback marks the selected destination with reservation 5 on the tick after a new target is chosen. A spinning monster keeps its landing reserved until it moves again. Returning to patrol clears the reservation on the decision frame. In a USA L12 replay, frame 3523 released tile (7, 7) while the monster was still standing on it and selected (5, 8) as the exit.

Controlled calls to the USA overlay and the normal web step agreed on 144 rim decisions, 512 crossing decisions and 100 blocked routes, including random draw consumption. Replaying the movement between the recorded USA crossing choices matched 2,648 poses and occupancy samples, all 134 deterministic patrol turns/hops, and 2,597 reservation samples outside the random crossing decisions. The port uses round-relative frame parity and a seeded room RNG. If all twelve destinations are blocked it waits one hop before retrying so the online simulation can advance.

### Pogo Padlock pickup and floor

The USA L13 object starts with a 240-update timer. In two PCSX runs its first 112 updates preceded playable input. A held direction started a hop on update 113. The lock appeared on update 240 (play tick 128), 100 ticks after the clock started. Each object update adds 0x38 to yaw, including while hidden. The lock and its ground shadow start at native Y −16. Pack 0770 part 64 grows only on Y, in 16 increments of 0x100. Part 40 is the stationary, full-size shadow. Both follow the same X/Z origin until collection.

Each glide takes 18 updates. Both axes close one sixth of their remaining distance, truncated to whole native units, before snapping to the destination. On the recorded glide from X 768 to 1280 the first three positions were 853, 924 and 983. Players check the rounded tile before the object advances. Collection removes both meshes and places one burst at the lock. Sound 0x54c plays for a player who actually locks paint. A respawn resets the hop count to 18.

For locked tiles, `FUN_800b7c3c` selects texture 49 in 0662 with the palette of that seat’s paint texture (41, 38, 39, 40 in seat order). These give CLUTs 39, 36, 37 and 38. The board atlas applies each of those four palettes to the same texture indices. Capturing and cashing tiles alternate the old and new tile materials on successive frames.

The held-item callback `FUN_800b76cc` adds 0x71 to the pilot's item node while occupied and keeps that angle when empty. For the final 90 shield ticks it hides the mesh on global frames with bit 2 set. A third L13 run sampled all four node angles for 457 play ticks. With the recorded slots and pickup timers, the web matched all 1,828 angles. The WebGL shield on Top G matched the recorded 42 visible and 30 hidden frames.

Two trace replays matched 874 consecutive object updates from GO with the native spawn, directional choices and collection frames supplied. The web room still chooses destinations with its own RNG. The L13 opening anchors rotation and tile flicker phase. WebGL checks covered all four locked palettes, both meshes, growth between snapshots and playback from a terminal snapshot.

## AI (`FUN_800bd10c`)
- Target (`FUN_800bdf60`, `FUN_800ba110`, re-evaluated every frame): nearest (squared) unoccupied/unreserved tile holding a ready object (type != 0xb, timer +0x64 == 0) that beats the held item (item id < object type; items 1-5, arrows 7/8, cash 10), or a state-7 tile / the padlock. None: random (rand(8), rand(8)) tile.
- Steer (`FUN_800bd790`): among allowed directions minimise squared distance to target; order +z, -z, +x, -x, strict <; pass 1 avoids own tiles on lvl 13.
- Fire (`FUN_800bd378`): items 1/3/4 if another player is strictly ahead on the facing line; item 2 (`FUN_800bd520`) if any player shares row or column. Reaction delay after pickup (`FUN_800c0fac`, `+0x24`) = 96 - 3*idx frames, crates are ignored until their ready timer (96 - 3*idx) expires. idx by difficulty easy/medium/hard (0x800c3678, 3724, 37bc, 3854): lvl 10 [1,12,20], lvl 11 [1,16,24], lvl 12 [1,16,28], lvl 13 [1,16,24].
- All four stages run the same states: 1 search, 3 wander (rand(8), rand(8)), 4 pickup, and 5-7 routes. Lvl 11/12 route dispatch (`FUN_800bde24`) tries the line, flood and square in that order before checking pickups. The search timer starts at 3–5 landings. A change of steering direction on a landing resets it to 2–3. An active route holds its target between CPU updates, including when a pickup becomes available.
- Line (state 7, `FUN_800c0f08` → `FUN_800be158`): scan one tile farther at a time, forward, left, then right. Each ray looks for owned paint past a non-owned tile. Pogo-a-gogo can also reconnect to its own ring segment, which sends the CPU to the adjacent board tile. If the first match is occupied the entire line probe fails.
- Flood (state 6, `FUN_800be864` → `FUN_800bea34` / `FUN_800beb6c`): Pogo-a-gogo only. The vacant, non-owned candidate needs two matching cardinal neighbours, including ring segments. Mark it as owned for the same eight-connected outside flood used by capture. It qualifies when an enclosed, unoccupied tile outside the mine, hazard and cross states remains. Pick the nearest candidate by squared distance, scanning x then z for ties.
- Square (state 5, `FUN_800be6c4` and `FUN_800bd790`): both stages require at least nine owned tiles. Tables `800c45bc` and `800c457c` give two hops per side. The starting quadrant selects the first side and frame parity selects the direction around the square. Advance once the CPU's rounded position reaches each waypoint and exit after eight hops or when the next waypoint is blocked.

The original USA overlay 0725 ran under MIPS emulation against 158 decisions and steering continuations based on pre-timeout match snapshots, plus 111 controlled cases. On native frame 5998 Pogo-a-gogo slot 1 chose `(7, 6)` at ring offset 8, and El Pogo Loco slot 1 chose `(2, 3)`. The controlled cases exercised true and false flood closures, occupied cells, mines, route priority, both square directions in every quadrant, and blocked waypoints. Run `npx tsx scripts/test-pogo-routes.ts` from `web/` to replay representative targets and both complete square routes.

The sim uses round-tick parity for the square and snapshot-derived random draws for search delays and wandering. Native phase and the global random stream can shift which route arises in a full match. The pickup readiness estimate, firing logic and board update order can also affect the match trajectory.

## SFX (original id -> sample n in the level bank, file via audio/index.json)
- Run 0x55a..0x56d (0x55a + slot foreign-tile step, 0x55e + family - 1 landing, 0x566 + family - 1 cheer): 0171 -> 13.., 0170 -> 14.., 0169 -> 21.., 0168 -> 24..
- 0171: 514->2 515->3 51d->5 51e->7 51f->8 520->9 522->11 438->6 43c->12 41c->34 3fa->35. 0170: 514->3 515->4 51d->6 51e->8 51f->9 520->10 522->12 438->7 43c->13 41c->35 3fa->36 532->0 533->1 534->2.
- 0169: 514->10 515->11 51d->13 51e->15 51f->16 520->17 522->19 438->14 43c->20 41c->42 3fa->43 3ec..3ef->5,6,5,6 3f1..3f4->8,9,8,9 542->3 543->4. 0168: 514->13 515->14 51d->16 51e->18 51f->19 520->20 522->22 438->17 43c->23 41c->45 3fa->46 54b..54d->5..7 54e..551->8..11 552->12.
- Pickup ids: type 1 -> 0x51f, 2 -> 0x438, 3 -> 0x51e, 4 -> 0x51f, 5 -> 0x41c. Fire: single 0x522, four-way 0x43c, beam 0x520. Cash 0x514, arrow 0x515, capture 0x51d, crate spawn 0x3fa, mine blast 0x3ec..0x3ef.

## Animation / camera
- Player states 0x39 idle, 0x3a hop, 0x3b stun, 0x3c win, 0x3d lose, 0x3e draw, 0x3f tazing. Pickup anim ids 0x200d (item 1), 0x201b (2), 0x2002 (3), 0x2040 (4), 0x200c (speed), 0x2042 (shield).
- Camera: per level fixed cameras (`FUN_800c3148`) already fitted in the view LEVELS table.

## Individual versus results, levels 10–13

- All four use overlay 0725 and timeout dispatch `FUN_800c2e50` → `FUN_800b53cc`. `FUN_800c2f50` starts the common BCD clock at `0x130` (1:30). The shared intro releases input 27 ticks before the clock starts. `FUN_8007b8d4` checks and draws the whole seconds before subtracting two subframes, so the 2,672nd clock update triggers timeout at play tick 2,699. The common bank plays `0x19b` as each of the last five seconds appears and `0x19c` on timeout.
- Stable descending banked score sets flags `0x200` for the winner and `0x400` for each loser. Equal top scores set `0x100` for all four. An active hop reaches its landing before the flag is consumed (`FUN_800b5ee4`). Idle, stun and taze consume the flag on their next update. The result entries cancel the beam, then the handlers clear the held item and unlock any Padlock tiles.
- Win `0x3c` enters at `800c2a8c` and updates at `800b6790` with script `0x32`. Each update applies the signed shortest error to yaw zero shifted by two (`FUN_8008a200`), then adds one eighth of the unsigned shortest distance to zero (`FUN_80015480(0,yaw)`). Event `0x12` runs both landing handlers, `0x11` plays pack 0770 script 6 and `0x14` plays script 4. Script 6 reuses script 4's key times and transforms with parts 23/25 and adds part 33, which keeps its own material blend. `FUN_80089fa4` starts a separate announcer sequence on winner entry. It waits 30 ticks, then plays the name, “wins”, and character voice 7.
- Lose `0x3d` enters at `800b6960` and updates at `800b6ae0`. It snaps to the nearest tile centre, hides the shadow and spawns pack 0770 script 0. It holds the opening pose of script `0x2e`, spins by `+0xe3` yaw per tick and rises by `0x30` units per tick with no vertical deceleration (`FUN_800860d4`). Script 2 spawns at the actor's current height when `(globalFrame + slot) & 3` is zero.
- Draw `0x3e` enters at `800c28fc` and updates at `800c286c`. All players loop `0x2e` in place with its script events ignored. Facing adds the unsigned one-eighth correction each tick. The common Draw logo triggers sound `0x1af` (0278 sample 13) once its remaining scale error falls below `0x100` (`FUN_80082d90`).

Winner cues decoded from the original player VM table in `re/dumps/L10.ram`. Frames are zero-based within the loop. A cue at the loop length plays as it wraps. Tiny's frame-zero landing event is discarded on entry and handled on subsequent loops.

| Engine family | Loop | Cheer sound frame | Landing `0x12` | Dust `0x14` | Dust + flash `0x11` |
|---|---:|---:|---|---|---|
| 1 | 37 | 11 | 4, 27 | 31 | |
| 2 | 60 | 0 | 23, 39, 56 | 26, 43, 60 | |
| 3 | 87 | 0 | | | |
| 4 | 93 | 0 | | | |
| 5 | 19 | 0 | 19 | | |
| 6 | 60 | 0 | 20, 39, 57 | 19, 38, 56 | |
| 7 | 36 | 0 | 1, 19, 33 | | 3, 23 |
| 8 | 35 | 2 | 1, 19 | | 4, 21 |

### Last-second pickups and score display

On L10–13 the pre-state callback first checks the actor’s rounded tile, including during a hop. A ripe crate can be collected on an unreserved tile or one reserved by the same player. Padlock pickups bypass reservation. The cash handler paints the pickup tile before banking on L10–12. The crate breaks even when zero tiles score.

All four stages use the common score counters. During play each counter moves one point on every fourth global update. At the horn all counters with a backlog move one point per update before the winner is announced. The horn plays once when the clock reaches zero. The first four stage captures had opening phases of 0, 0, 1 and 0 relative to the global clock. The web uses these phases for regular HUD counts. Console menu timing can change that initial offset.

In an L10 replay a ready cash crate was placed on the player’s current tile with the hop counter at 9, two bankable tiles and the clock at zero seconds. The next update awarded three points, including the pickup tile. The HUD showed 1, 2, then 3 at hop counters 10, 11 and 12. The winner flag arrived at counter 13. With the same setup the host and guest retained the three-point total and the terminal snapshot on tick 2702. An additional four-stage disc trace measured score counting through expiry and the subsequent input lock.

### Arena after timeout

- `FUN_800b3e34` keeps updating the board via `FUN_800b87dc`. Result flags `0x800` (win) or `0x1` (draw) gate the same routine's item and arrow spawners, timed-item countdown, and Pogo-a-gogo border updates. Existing arrows still turn, dropped items bounce every 15 ticks, and cash crates have an independent update (`FUN_800bb12c`) that can finish a respawn.
- `FUN_800b574c` checks pickups before dispatching the player's state handler. A player can consume an object as their exit hop crosses onto its tile. The arrow paints its line, and the cash crate clears tiles and breaks. `FUN_800b7990` gates the score award and floating number once a result flag is set.
- `FUN_800bc5bc` continues to move each active shot 144 units per tick. A shot ends on contact or outside the inclusive native bounds −2560 to 2048 on either axis (−1.5 to 7.5 in sim tile coordinates). It hides the missile and starts pack 0770 script 0 and sound `0x521` at its endpoint. A Padlock steal shot can still transfer tiles to the shooter. A result actor retains the native hit flag after its first hit, and its result handler keeps running. Player result entries cancel their electro beams.
- El Pogo Loco's current monster action and mine timers continue. A patrolling monster's action countdown holds at its timeout value while it keeps hopping. An active spin exits on the first result update (`FUN_800beea4`); a walk can complete and return to patrol. The Padlock object continues to glide, turn and run its own respawn timer (`FUN_800c0584`).
- The native board keeps updating through the fade handoff. Draw reaches it at timeout +120 ticks. A winner starts the handoff 208–211 ticks after entering the win pose, depending on the character's name cue (`FUN_8008a200` plus the common 2-, 90- and 30-tick timers). Pending hops can delay winner entry. Both the host and native `FUN_8007e894` wait for the displayed score to catch up before ranking.
- The view advances a private copy of the terminal snapshot at 30 Hz through that window. On reconnect it replays the host's elapsed result ticks before the first rendered frame and skips expired sound cues. Win and draw snapshots on all four stages produced identical arena state to uninterrupted playback at ticks 25, 63, 94 and 130. The shell reserves the result window before standings or podium loading, and the host leaves time for standings afterward. The transition estimates the pending hop from the terminal counter. A late projectile that interrupts the hop can start the pose sooner. Big Stein and Top G use their own longer name-cue waits.

The result simulation reuses the port's monster route and padlock occupancy rules. It estimates arrow yaw and settled item bounce phase from crate age. Projectile contact clears held items and transfers steal tiles. The result copy keeps the existing exit-hop behavior. The shared result-music duck is applied when the winner enters the pose or the draw begins (see docs/audio.md).

## Verified in the emulator
- Hop period 18 frames with a held pad; land at counter 17; stun 4341 -> 4392 (51 frames); mine timer 120 then explode; boss (lvl 12) starts at frame 0, patrol from 18, first action at 186 (ours: 22 + 100..160); mines about 4 per action.
- USA disc trace in EmulatorJS/PCSX ReARMed. Read the BCD clock at `0x80099178`, game flags at `0x8005a644`, and the active object list at `0x8005aa04` (link +0x10 and type index +0x6c into the table at `0x8005aa6c`). The controlled trials gave the shooter an item and set both the banked and displayed scores (player +0x50 and +0x52) so score counting would leave the native timeout dispatch on its usual tick. The controlled Painter trial sought the clock forward. Normal clock runs were also sampled.

| Stage | Observed frames after the timeout callback |
|---|---|
| Pogo Painter | A single shot moved 144 units per tick and crossed the +2048 bound at +22. A waiting cash crate reappeared at +10 and reached full scale at +26. |
| Pogo-a-gogo | Two shots from a corner four-way pickup stayed active. One hit a result actor at +9 and the other crossed the boundary at +22. An exit hop consumed an arrow at +5. The ring and spawner timers held. |
| El Pogo Loco | A single shot crossed the boundary at +22. In a normal run the monster's patrol timer was already zero at timeout. It began its queued walk at +9, laid mines from +23 to +65, and those mines expired from +142 to +184. |
| Pogo Padlock | A steal shot hit at +5 and transferred the victim's tiles with a 10-tick flip timer. The padlock respawned at +115 and began an 18-tick glide at +134. |

## Unknowns
- The state-6 hazard (adventure only), character -> family mapping (sim default families [1,5,6,8]), clip indices per state, adventure-only flags 0x20/0x40/0x80.

## Effects (decoded)
Pack 0770 (db 0x80053b9c). Level 12's model 0667 has its own scripts.
- Hop clip 0x2e (17 frames): event 0x14 after frame 13 -> `FUN_800b741c` = script 4 at the player, random yaw, nodes flagged 0x20000000
  (touchdown dust). Event 0x12 after frame 16 triggers the landing. State 0x3f uses `FUN_800c2674` for its script 7 sparks.
- Loser: entry `FUN_800b6960` = script 0 at the player; while spinning `FUN_800b6ae0` = script 2 every 4 frames. Stun is separate state `0x3b` (`FUN_800b6df4` / `FUN_800b6f34`).
- Projectile 0x1404 (`FUN_800bc5bc`): one head and eight child slots. The counter advances on odd global frames and enables one child every second increment, starting on callback 3 or 4. Each child starts 144 u behind the head and its local offset increases with the head's movement, leaving it at its original world position. Its scale runs from 0x1000 to 0 in steps of 0x100 per tick. The callback hides the head and plays script 0 and sound 0x521 at the endpoint, and the children keep shrinking at their last positions. The port uses round-tick parity and carries the visible trail points into the private result copy.
- Trail render id 0x2018 is pack 0770 part 23, a 256×256 u billboard with vertex modulation `0x94` and texture 13 of pack 0769. CLUT 6 has a transparent zero and 15 STP grayscale entries (`0x8421`–`0xbdef`). The polys use ABR 2 (background minus foreground), with no per-node opacity ramp. The port batches the disc mesh with its existing subtractive material.
- The USA 0725 overlay in MIPS emulation held each axis at both inclusive bounds for one tick before culling in all four stages, with and without result flags. The player, four-way, steal and monster constructors use the same child geometry and cadence. A shot that hit on an emission tick left that full-sized child while the head disappeared.
- Beam `FUN_800ba51c` uses object 0x1405 and pack 0770 parts 2–9. See the L11 electro beam traces above.
- Pickups `FUN_800b935c`: object kind 10 (the "!" crate) -> script 3, anything else -> script 1.
- Score: `FUN_800b788c` -> `FUN_8008d5d4(tx*0x200 - 0x700, floor - 0x100, tz*0x200 - 0x800, n, 0)` (floating number, see engine.md).
- Mine tile (state 5) `FUN_800b8180`: level script 1; state 6 `FUN_800b83ac`: level script 2 - only set by monster mode 10 (`FUN_800beea4`), which comes from the adventure action table 0x800c46c8; the versus table 0x800c468c holds 6/7/8 only, so it never happens in versus. Padlock `FUN_800c0584` state 6 (taken): pack 0770 script 1, played through the pickup event.
- Nothing for painting a tile, captures, lines, wipes or crate spawns.

## Objects (render ids, pack 0770 unless noted; render id = 0x2000 + part + 1)
- Item on its tile (`FUN_800ba25c`, object 0x1402, grows +0x100 / frame): item 1 missile 0x200d (part12), 2 four-way 0x201b (part26),
  3 beam 0x2002 (part1), 4 steal gun 0x2040 (part63), 5 speed shoes 0x200c (part11). There is no "?" crate. `FUN_800baef0`: items 1, 2, 4
  spin +0x38 / frame, 3 and 5 stay still. On pickup (`FUN_800b935c`) the player's held-item node takes the same render id; the padlock's
  shield is 0x2042 (part65).
- Arrow (`FUN_800ba3e0`, object 0x1401): type 7 0x2001 (part0), type 8 0x200e (part13); `FUN_800baba8` eases yaw 1/8 per frame toward dir<<10. Emulator check (level 10, tile grid 0x800c53dc, object +0x60 dir, node +0x1e yaw): an arrow at yaw 0x800 (dir 2) points at the camera (game -z), i.e. along its fill; the gltf mesh's tip is on +z, so the port adds a half turn.
- Cash crate (`FUN_800bad74`): 0x200b (part10, the purple "!" crate). Padlock (`FUN_800c0444`): 0x2041 (part64). Projectile heads point toward local −X: 0x200d (single and monster), 0x201b (four-way), 0x2040 (steal). The player constructor `FUN_800c11c4` puts the shot 384 u above the ground reference. Four USA stage captures show Y −400. Monster callbacks `FUN_800bfff4` (spin) and `FUN_800c02ac` (aimed) use 512 and 640 u. The versus spin shot inherits its current yaw and is drawn at native Y −528 (floor −16).
- El Pogo Loco monster (`FUN_800bed3c`): pack db 0x80053bd4 = disc 0768 (db entries 0x38 apart; LBA 0x706b sits between 0766 and 0770),
  render id 0x2001, clips 0 (21-frame spin), 1 (26-frame wait), 2 (14-frame hop).
- Characters are drawn in raw units like the stage: actor scale = stage units per 1024 u / catalog scale of the pogo variant.

## Fidelity audit (2026-11)

Function-by-function pass over `re/out_pogoPainter/ovl.c` against `web/shared/games/tilePainter.ts` (sim) and
`web/client/games/tilePainter.ts` (view). V = checked on an emulator trace (level 10, Cortex + 3 CPUs), C = from the code only.
Line numbers are as of commit 0899c646. Play tick T = 0 is the frame of the GO sound (0x1a7); 112 level/object updates run before it.

### Coverage

| Function | Role | Ours | Status |
|---|---|---|---|
| `FUN_800b3e34` | level tick: tiles, item timers, spawners, border | sim `step` | done (item timers run in the player loop; edge order only) |
| `FUN_800b574c` | pre-state: pickup, direction, reservation, input lock | sim `pickup`, `hopDirection`, `decide` | done; 9-frame lock after a stun added (V) |
| `FUN_800b6370` / `800b6438` | idle entry / idle update (script 0x2e, 0x2f; events 0x11-0x14) | sim `enterIdle`, `tickIdle` :676 | done (V): bounce landing sound + re-landing + dust, per family; view uses `d.idle` as script frame |
| `FUN_800c2dcc` | hop entry: silent landing on the tile left | sim `decide` | done (C) |
| `FUN_800b5ee4` | hop update: counter, stride window, shadow, dust, landing | sim `advanceHop`, `hopPos` | done (V); the view draws `d.shadow` with pack 0770 part 40 (`FUN_800c32e8`, start 0x1a00 from `FUN_800b3808`). Every part 40 shadow (rider, item, padlock, monster) uses node mode 2, background minus foreground, at alpha 0x800; the glTF material is opaque. Chromium showed dark shadows, the falling item with its shrinking shadow and the jet under Big Stein |
| `FUN_800b5b1c` | jet flame under families 3 and 4 (Cortex, Brio; also Big Stein, Top G) | sim `tickJet`, view `jetFlame` | done (C): part 32 at marker 0x200, tilt +5 in a hop to 45, -2 to 5 otherwise, Y scale `800c44d8[idx]`. The index is shared per family (`800c52e4` / `800c52e0`): hop = capped counter, idle = idle word minus 0x4000 / 0x4080, stun toggles 0/20, beam keeps it. Any index except 0 and 20 draws `rand(16)` from the shared RNG every update, so the sim draws it too. Euler order YXZ is assumed |
| `FUN_800b6c14` / `6df4` / `6f34` | hit, stun entry, stun update | sim `enterStun`, `step` | done (C): a mine stun while holding speed under 0x2f leaves the rider in idle for one update (`stun = -1`) and stuns on the next without a second cry |
| `FUN_800c1cf0` | drop item; speed under script 0x2f re-enters idle | sim `clearItem`, `stopHop` :426 | done (V): hop aborts on the nearest tile, stale move flag gives one extra stride (`d.carry`) |
| `FUN_800b662c` / `c2be8` / `ba51c` / `ba994` | beam state, beam object | sim `fire` :482, `advanceBeam`, `stepProj` | matches (prior work) |
| `FUN_800b6790` / `6960` / `6ae0` / `c28fc` | win, lose, draw states | view `tickResult` | matches (prior work) |
| `FUN_800b76cc` | held item on model marker 0x80 minus `800c4484[fam]` | view `placeAtMarker` | done (C): markers per pose word in `pogoMarkerData.ts` (`re/notes/pogoPainter-markers.py`), lift [80, 80, 112, 96, 112, 112, 112, 112], 0x280 above the rider when the pose has no marker |
| `FUN_800b7b1c` / `788c` / `c2338` | paint, cash-in | sim `paintTile`, `cashIn` | matches |
| `FUN_800b8660` / `87dc` | line ripple, tile timers, notes 0x516-0x51c | sim `line`, `tickPogoTiles` | done (V): notes added; view maps them to the sample after 0x515 |
| `FUN_800c1ea8` | cross tile | sim `applyLanding` | done (C): arms start on the centre tile |
| `FUN_800b8af8` / `8be4` / `8dfc` / `c1da4` | landing sound, tile resolve, L13 rules | sim `land`, `applyLanding` | done; silent variant added |
| `FUN_800b8180` / `83ac` | mine blast | sim `boom` | matches |
| `FUN_800b8f94` / `9080` / `91e8` | wipe, lock, unlock | sim `wipe`, `lockAll`, `unlockAll` | matches |
| `FUN_800b935c` / `ba018` | pickup | sim `pickup` :607 | matches |
| `FUN_800b9c10` + `ba3e0` + `baba8` | arrow spawner, arrow object | sim `spawnArrow`, `turnArrow`, pickup dir; view draws the node yaw (`vz`) | done (C): free tile, type, `rand(4)` start dir; 0x3fa on update 1; growth 0x100 per update to state 3 on update 16; then `yaw += err>>3` and `dir+1` when the step is below 2 (update 17, then every 35). El Pogo Loco runs the timer and draws the tile without spawning |
| `FUN_800b9d64` + `ba25c` + `bad74` + `baef0` | item spawner, item object | sim `spawnItem`, `pogoItemHeight`, pickup ready check, `aiPickupTile`; view | done (C): 0x41f at spawn, fall `+14` to 160 (`FUN_8007a26c`), lands on update 32 with 0x420 (VAB tone after 0x41f: 0171 37, 0170 38, 0169 45, 0168 48), pickable from crate age 33, AI ready at 33 + delay, bounce of 15 updates peaking at 224, part 40 shadow `0x1000 - 6h` below 0x200 |
| `FUN_800c1b7c` / `bb12c` | cash crate | sim `tickArenaCrates`, setup | done: first timer `60 + rand(60)`, counted through the pre-roll |
| pre-roll (112 updates before GO) | spawners and crates run under the countdown | sim setup | done: both spawners start at -1 and 112 spawner/crate ticks run in `setup` with their events dropped |
| `FUN_800bc184` / `c314` / `c490` / `c5bc` | rockets, four-way, projectile | sim `fire`, `spawnProj`, `stepProj` | matches |
| `FUN_800bcb4c` | L11 border | sim `tickBorder` | matches; the unused `rand(200)` is now drawn at init (`FUN_800c10f8`) and after each rotation |
| `FUN_800bd10c` / `bde24` | CPU state machine | sim `planPogoRoute`, `bot` | done (C): one state machine on every stage; line/flood/square and the wait counter only on L11/12; the wander wrapper is gone |
| `FUN_800bd378` / `bd520` | CPU fire check | sim `bot` | done (C): rounded position of both riders and the rider's yaw quadrant (`yaw >> 10`) |
| `FUN_800bdf60` / `ba110` | CPU pickup target | sim `pogoPickupTarget`, `aiPickupTile` | done (C): x-then-z scan keeps the first of equal distances; occupancy and reservation for every object on every stage; the padlock is accepted before those checks |
| `FUN_800bdcb8` | move legality | sim `canMove` | done (C): the L13 own-tile pass exempts a cash-crate tile |
| `FUN_800bd790`, `be158`..`beb6c`, `c0f08` | steering, line / flood / square routes | sim `steerPogoBot`, `lineRoute`, `floodRoute` | matches (prior work) |
| `FUN_800beea4`..`c0164` | monster | sim `tickMonster` | matches |
| `FUN_800c0584` | padlock | sim `tickPad` | matches |
| countdown | riders bounce with landing sounds under 3-2-1 | view `playIntro` | done (C): the view runs the idle clock from `112 - countdownTicksLeft` and plays 0x55e + family on each 0x12, the first one with 0x55a + seat (the start tile is painted then), plus the dust events. No shell change |
| `FUN_800b3808` | versus start | sim `START_HD` | fixed (C): yaws 0x800, 0xc00, 0, 0x400 face up, right, down and left; the port had up, down, down, up |
| `FUN_800b3ff0` / `c2ee0` | CPU delay indices | sim `AI_IDX` | match: in `L10.ram` (medium) the human's entry [2] and the CPUs' entry [0] of `8009d87c` are 12, as are `800c5bb8` and `800c5bbc`. A room without a human would keep the fire index at 0x10 |

### Throw voice
`FUN_800bc490` requests voice n 0x10 before sfx 0x522. Stock banks have no tone for it, so the disc is silent. Big Stein and Top G keep
their own throw take (view `case 'missile'` calls `charVoice('a2', char, 0x10)`), as decided for the custom characters.

Per-function status: `re/notes/pogoPainter-audit.tsv` (220 rows).
