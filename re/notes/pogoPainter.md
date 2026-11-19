# Pogo Pandemonium (Pogo Painter, Pogo-a-gogo, El Pogo Loco, Pogo Padlock) - levels 10..13

Source of truth: `re/out_pogoPainter/ovl.c` (overlay). Sim: `web/shared/games/tilePainter.ts`, view: `web/client/games/tilePainter.ts`.
Engine facts (units, pads, tile cell layout, timer) are in `engine.md`. Everything is per 30 Hz frame.

## Common rules
- 4 players on an 8x8 board; slots start BL yellow (0), TL red (1), TR blue (2), BR green (3). Match 1:30 (2700 frames). Highest score wins; a tie for the top draws.
- Score (short, player +0x50) changes only in `FUN_800b7990`.
- Hop (`FUN_800b574c` decision, `FUN_800b5ee4` landing): hold a direction; cnt starts 0, +1 per frame (+2 with speed). Move window starts at S and lasts M frames; land at cnt 17 (the snap to the tile centre); next decision on the following frame = 18 frame period (10 boosted). Per character family (1..8) S/M: fam1 3/9 (56 u/frame), fam5 5/12, fam6 5/12 (42 u/frame), fam8 5/13 (39 u/frame). Tables pre c502c, post c5050, total c5074.
- Landing: reservation cleared; sfx 0x55e+fam (`FUN_800b8af8`); if owner != p sfx 0x55a+p (`FUN_800b8dfc`) and flag 0x10 set; own tile: nothing; foreign tile only stolen in state 1 or 3 (0 flipping, 7, 10 are not); state 5 = mine -> explode (`FUN_800b8180`). Paint (`FUN_800b7b1c`): state 1, or state 10 / timer 240 while holding the shield, then capture check.
- Can move (`FUN_800bdcb8`): in board, unoccupied (occupant incl. monster), reservation 0 or own; CPUs also refuse state 5/6 tiles (humans may walk onto mines).
- Stun 51 frames (`FUN_800b6f34`, anim 0x3b): item cleared, shield unlocked. Mine blast = every player within Chebyshev 1 of the mine tile.
- Tile states: 0 flip-in (timer then 1), 1 normal, 3 cash flip (timer 10 then neutral), 5 mine (timer 120 -> explode, neutral), 6 hazard (adventure), 7 cross tile, 10 locked (timer 240 -> 1).
- Cash (`FUN_800b788c`/`c2338`): all tiles of p -> neutral state 3 timer 10, score += n.
- Capture (`FUN_800c1a18`, levels 11/12 only): flood fill (8-connected, `FUN_800c1840`) from edge seeds through every tile not owned by p; unreached unoccupied non-5/6/7 tiles become p (state 0, timer 10), sfx 0x51d. Level 11 then cashes immediately (`FUN_800bbb08`).
- Pickups (`FUN_800b935c`, `FUN_800ba018`) are handled on the decision frame when the crate is fully grown (grows 16 frames, +0x100 scale/frame). Pickup replaces the held item. Item ids: 1 missile (stun), 2 four-way missile, 3 electro beam, 4 steal gun (kind-3 missile), 5 speed (240 frames), 6 shield (240 frames).
- Fire = square (`FUN_800c2cbc`): item 1 `FUN_800bc184(p,0)`, 4 `(p,1)`, 2 `FUN_800bc314`, 3 `FUN_800ba51c`. Projectile object 0x1404 (`FUN_800bc5bc`): starts at the shooter's tile centre, 144 u/frame, hit radius 160 u, dies outside -2560..2048; consumed on any hit but only affects a non-stunned victim. Steal (`FUN_800bb724`): all victim tiles -> shooter state 0 timer 10, sfx 0x552. Beam (object 0x1405): stuns everyone on the line ahead, shooter in state 0x3f (duration not read; sim uses 24 frames).
- Arrow crate (`FUN_800b9c10`): timer arT starts -1 (about 24 at tick 0), set 40+rand(70) when count < table `c38d8`; at <= 4 spawn; after spawn arT = -1 if count > `c38e8` else 40+rand(70). Counts lvl 10..13: 2,2,2,0. Type 7 (line one way) on 10; on 11 rand(3)!=0 -> 7 else 8 (both directions). Direction counter starts 1 when ready, +1 per ~32 frames mod 4 (0 +z, 1 +x, 2 -z, 3 -x). Lines (`FUN_800b8660`) start at the crate tile: state 0, timer 6+4k, skip states 5/6/7; sfx 0x515; then capture.
- Item crate (`FUN_800b9d64`): itT starts -1 (about 28 at tick 0); stays -1 while count >= `c38b8` (2,2,1,1), else 60+rand(60); spawn at <= 1; after: -1 if count > `c38c8` (3,3,1,2) else 60+rand(60). Types: lvl 10 two thirds 1 / one third 5; lvl 11 rand(5): 0->3, 1-2->5, 3-4->2; lvl 12 rand(2): 1 / 5; lvl 13 type 4 or 5.
- Free tile (`FUN_800c165c`): up to 10 random tries of `FUN_800bc04c` (unoccupied, unreserved, no object, state not 5/6).
- Cash crates (`FUN_800bb12c`): 2 on lvl 10, 3 on lvl 12, 2 on lvl 13, none on 11. First appears about tick 48; state 0 wait, 1 place (sfx 0x3fa), 2 grow 16, 3 ready, 4 used -> wait 40+rand(40). Pickup sfx 0x514 + cash.

## Per level
- Lvl 10 Pogo Painter: tiles paint only; arrows (type 7), item crates, 2 cash crates. No capture.
- Lvl 11 Pogo-a-gogo (flags: border): coloured ring around the board (table 0x800c3c14, row 0 `00001111111122222222333333330000`, row r = shift by r). Left side i0..7 (x=0, z=i), top i8..15, right i16..23 (z 7..0), bottom i24..31 (x 7..0). Flood seeds from edge segment i unless the segment is the player's colour (`FUN_800bb840`), except at ends of the run. Rotation at remaining 75, 60, 45, 30, 15 s: type rand(4)+1 (cw 8, cw 16, ccw 8, ccw 16 steps) one step per 8 frames, sfx 0x534 at start, beeps 0x532 (the two seconds before), step 0x533; each step recaptures for all players. No cash crates; captured tiles are cashed on capture.
- Lvl 12 El Pogo Loco: monster object 0x1406 (`FUN_800beea4`, walks `FUN_800bfc6c`, hop cycle 14 frames `FUN_800c0cf4`): start at (3,8), waits ~18 frames, patrols the outer rim (2 cells per hop) for 100+rand(60) frames, then runs an action from table `0x800c468c` [6,6,6,7,6,7,6,7,6,6,8,8,6,8]. Walk: hops 2 tiles inward (+rand(3)-1 sideways), leaves a mine (state 5, timer 120, owner 5) on each landing; action 7 makes the bf4-th landing (rand(3)+1) a cross tile (state 7). Action 8 ends in a spin (140 frames) firing missiles that hit everybody. sfx 0x542/0x543 at action start. Landing on a cross tile (`FUN_800c1ea8`) paints the row and column (state 0 ripple) and captures, sfx 0x515. Capture rules as lvl 11 but edge seeds on all four sides and cash crates cash it.
- Lvl 13 Pogo Padlock: landing on your own tile (flag 0x10 clear) wipes all own tiles (sfx 0x54b, `FUN_800b8f94`, no paint); landing on a locked tile plays 0x54e+p. Padlock object 0x1408 (`FUN_800c0584`): waits ~100, appears on a random free tile (sfx 0x3fa), grows 16 frames, waits `c5334[stage]` = [1,4,7,10,14,19,23,28] frames, then hops to a random adjacent tile (18 frames, 1/6 of the distance per frame); hops per stage `c530c` = [18,16,14,13,12,10,8,7], then stage+1. Pickup by landing: shield 240 frames, all own state-1 tiles -> state 10 (240) sfx 0x54c; padlock hides 120 frames then respawns (stage kept). Shield end: state 10 -> 1, sfx 0x54d. Item crates 4 / 5; scoring via 2 cash crates only.

## AI (`FUN_800bd10c`)
- Target (`FUN_800bdf60`, `FUN_800ba110`, re-evaluated every frame): nearest (squared) unoccupied/unreserved tile holding a ready object (type != 0xb, timer +0x64 == 0) that beats the held item (item id < object type; items 1-5, arrows 7/8, cash 10), or a state-7 tile / the padlock. None: random (rand(8), rand(8)) tile.
- Steer (`FUN_800bd790`): among allowed directions minimise squared distance to target; order +z, -z, +x, -x, strict <; pass 1 avoids own tiles on lvl 13.
- Fire (`FUN_800bd378`): items 1/3/4 if another player is strictly ahead on the facing line; item 2 (`FUN_800bd520`) if any player shares row or column. Reaction delay after pickup (`FUN_800c0fac`, `+0x24`) = 96 - 3*idx frames, crates are ignored until their ready timer (96 - 3*idx) expires. idx by difficulty easy/medium/hard (0x800c3678, 3724, 37bc, 3854): lvl 10 [1,12,20], lvl 11 [1,16,24], lvl 12 [1,16,28], lvl 13 [1,16,24].
- Lvl 11/12 loop strategies (`FUN_800c0f08`, `FUN_800be864`, `FUN_800be6c4`, `FUN_800bea34`, `FUN_800beb6c`): only partly decoded; the sim goes to a free tile touching 2 own tiles as an approximation.

## SFX (original id -> sample n in the level bank, file via audio/index.json)
- Run 0x55a..0x565 (0x55a+slot foreign-tile step, 0x55e+fam landing): 0171 -> 13.., 0170 -> 14.., 0169 -> 21.., 0168 -> 24..
- 0171: 514->2 515->3 51d->5 51e->7 51f->8 520->9 522->11 438->6 43c->12 41c->34 3fa->35. 0170: 514->3 515->4 51d->6 51e->8 51f->9 520->10 522->12 438->7 43c->13 41c->35 3fa->36 532->0 533->1 534->2.
- 0169: 514->10 515->11 51d->13 51e->15 51f->16 520->17 522->19 438->14 43c->20 41c->42 3fa->43 3ec..3ef->5,6,5,6 3f1..3f4->8,9,8,9 542->3 543->4. 0168: 514->13 515->14 51d->16 51e->18 51f->19 520->20 522->22 438->17 43c->23 41c->45 3fa->46 54b..54d->5..7 54e..551->8..11 552->12.
- Pickup ids: type 1 -> 0x51f, 2 -> 0x438, 3 -> 0x51e, 4 -> 0x51f, 5 -> 0x41c. Fire: single 0x522, four-way 0x43c, beam 0x520. Cash 0x514, arrow 0x515, capture 0x51d, crate spawn 0x3fa, mine blast 0x3ec..0x3ef.

## Animation / camera
- Player states 0x39 idle, 0x3a hop, 0x3b stun, 0x3c win, 0x3d lose, 0x3e draw, 0x3f tazing. Pickup anim ids 0x200d (item 1), 0x201b (2), 0x2002 (3), 0x2040 (4), 0x200c (speed), 0x2042 (shield). View roles: idle / hop / hit (stun) / action (tazing) / win / lose.
- Camera: per level fixed cameras (`FUN_800c3148`) already fitted in the view LEVELS table.

## Verified in the emulator
- Hop period 18 frames with a held pad; land at counter 17; stun 4341 -> 4392 (51 frames); mine timer 120 then explode; boss (lvl 12) starts at frame 0, patrol from 18, first action at 186 (ours: 22 + 100..160); mines about 4 per action.

## Unknowns
- Beam duration, lvl 11/12 loop AI, monster walk bounds and the state-6 hazard (adventure only), exact padlock initial wait, character -> family mapping (sim default families [1,5,6,8]), clip indices per state, adventure-only flags 0x20/0x40/0x80.

## Effects (decoded)
Pack 0770 (db 0x80053b9c). Level 12's model 0667 has its own scripts.
- Hop clip 0x2e (17 frames): event 0x14 after frame 13 -> `FUN_800b741c` = script 4 at the player, random yaw, nodes flagged 0x20000000
  (touchdown dust); event 0x12 after frame 16 = the landing. Events 0x11 (script 6) / 0x13 (script 4) and `FUN_800c2674` (script 7) belong to
  other hop states (not mapped, not ported).
- Stun: entry `FUN_800b6960` = script 0 at the player; while spinning `FUN_800b6ae0` = script 2 every 4 frames.
- Projectile 0x1404 (`FUN_800bc5bc`): script 0 where it ends. No launch effect, no trail.
- Beam `FUN_800ba51c`: object 0x1405 = one node per tile, render id `((frame + i) & 7) + 0x2003` (parts 2-9), flag 0x21; script 8 at the far end, 128 u up.
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
- Cash crate (`FUN_800bad74`): 0x200b (part10, the purple "!" crate). Padlock (`FUN_800c0444`): 0x2041 (part64). Projectile: 0x200d.
- El Pogo Loco monster (`FUN_800beb6c`): pack db 0x80053bd4 = disc 0768 (db entries 0x38 apart; LBA 0x706b sits between 0766 and 0770),
  render id 0x2001, clips 0 (21 f), 1 (26 f), 2 (14 f = the hop cycle).
- Characters are drawn in raw units like the stage: actor scale = stage units per 1024 u / catalog scale of the pogo variant.
