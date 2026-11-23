# Ring Ding (level 27)

Source: `re/out_dragonDrop/ovl.c` (+ exe parts in `all.c`), checked against the emulator (`re/dumps/L27.*`, recordings of 4 bots over 78 s).
Implementation: `web/shared/games/ringDing.ts` (PS1 integer units, 30 Hz), view `web/client/games/ringDing.ts`.
The simulation uses native X/Z coordinates and 30 Hz ticks. World bodies scale by `S = 3.4/1024` and mirror Z. `FUN_8001463c(dx,dz)` returns a bearing in 4096 units per turn, with zero along native +Z. A polar point is `(r*T[a-0x400] >> 12, r*T[a] >> 12)` using the cosine table at `0x80068bd6`. Actor yaw points backward, so movement subtracts the two fixed-point components.

## Level
- 90 s: timer `DAT_80099178` starts at `0x130<<8` (1:30; byte0 frames, -2/tick), ends at 0 (`FUN_800b4144`/`FUN_800b3edc`).
- Floor `DAT_8005a5d8 = -16` (y is up-negative). Hub radius ~838, ring top radius 896..2318, rim 2559. Outer limit radius `0x980` = 2432 for players and balloons (`FUN_800b8f48`).
- Score = short at player struct +0x50 (`0x8009d57c`, stride 0x6c). Plain mode only (flags 0x40/0x80 clear, team mode off).
- End: sort by score (bubble, stable); top two equal -> everyone draws (flag 0x100), else winner 0x200, others 0x400.
- Per-frame order `FUN_800b9048`: `FUN_80086f78`, `FUN_800b4ba4` (grid + counts), `FUN_80086d88` (players into grid), `FUN_800b4970` (timers/spawns), `FUN_800b3a3c` (ring).

### Score and clock at the horn

L27 processes balloon awards before the shared timer. On play tick 2699 a balloon already in state 9 can turn a tie into a win. In a controlled USA replay it awarded one point, HUD field +0x52 counted to one, and the winner flag appeared on tick 2700. With the scores already level and no award at the horn, the draw flag appeared on 2699.

The score HUD normally counts one point per four logic ticks. The online cadence uses the recorded opening phase (global tick at GO minus one, modulo four, was 3). At expiry the HUD counts once per tick until every slot matches. The clock checks all four counters before each increment. The next update sets the result flags. After the first extra pending update the input lock clears both pad words. The host sends both totals in snapshots. Run `web/node_modules/.bin/tsx web/scripts/test-versus-tally.ts` from the repository root to replay the boundary cases.

## Ring (`FUN_800b3a3c`)
- Speed `DAT_800bc018` moves 1 per tick toward `dir*13` (`DAT_800bc01c` starts at +1 and flips sign on reverse). From rest it reaches +13 in 13 ticks. A reversal takes 26 ticks.
  Max 13 units/tick = 0.0199 rad/tick = 0.598 rad/s. Visual angle `DAT_800bc010` accumulates the speed. A second visual "gear" speed (+-0x18, `DAT_800bc01a`) has no gameplay effect.
- Carry: a player is carried if alive, grounded (`y >= floor`), no hover boots (power-up 0x13), and `0xc4000 < r^2 < 0x640001` (r 896..2560):
  `r' = (sqrt64(r^2)+0x20)>>6`, `a' = atan2 + speed`, `x = r'*T[a'-0x400]>>12`, `z = r'*T[a']>>12`; facing also += speed.
  Same for crates (list `8005aa24`, polar `+0x26/+0x28`). Balloons are airborne: not carried.
  Verified: 1173/1499 ticks exact, 96% within 2 units for an idle player (`ddCarry`).

## Players
- Char id (+0x2a) 1..8: 1 crash, 2 coco, 3 cortex, 4 brio, 5 tiny, 6 rilla, 7 dingodile, 8 koala (NOT the look.ts order: look.ts index -> id is `[1,2,5,7,3,4,8,6]`).
- Buttons 0x1000 triangle (taunt pose, no effect), 0x2000 circle, 0x4000 cross jump, 0x8000 square spin attack.
- Run: instant velocity `speed` in the d-pad direction, 0 when released, full air control, diagonals not faster. Speed table `0x800bb80c` `[50,50,55]` per char indexed by gear (+0x1a): humans gear 0 = 50, bots gear 2 = `50 + (skill>>2)` = 55 at skill 20.
- Jump (cross, ground states only; hook `FUN_800bb5f0` -> state 0x34 / anim 0x2c): table `0x800bb7bc` 8 bytes per char `[v0, v0, gd, gu]`:
  chars 1-4 `128,6,11`; chars 5-8 `128,8,13`; bots (index 0) `136,9,11`. Rise subtracts `gu` and integrates while `v >= 0`. Releasing Cross as a human while `v > 64` subtracts 40 for that update. The first negative velocity switches to fall (state 0x35) with `v = 0` and holds the apex. Fall adds `gd` up to `v0` and subtracts that velocity from height after the state handler. The floor probe reads the previous origin. A normal jump spends one update below the floor in 0x35 before the next update snaps to the floor and enters 7.
- X on keyboard (Square) starts script 10 on the ground. In engine ID order the lengths are 16, 16, 19, 13, 12, 16, 14 and 14 ticks. Crash and Coco can keep running during the spin and rotate their native yaw by −341 units each update. The other actors stop driving on the following tick. Dingodile and Koala finish in landing script 8.
  Hits rivals (hitbox mask 0x400, `FUN_800864cc`) and opens crates (`FUN_800ba098(p,2,0x400,0)`). Reach measured: hits at 167-322 (some up to 530), some misses at 200-250 (cone/timing); the port uses the per-frame shape 0x400 against each rival’s body cylinder. The player body can touch a balloon during a spin.
- Hit (state 0x33, `FUN_800b92bc/937c`): 37 ticks, no moving/jumping/attacking, ring carry applies. Caused by a spin hit (knockback 52 away from the attacker, -4.3/tick, 12 ticks) or by popping a wrong-colour balloon (no knockback). An airborne victim keeps its jump arc.
- Win/lose/dead states 0x36/0x37/0x38.
- Player-player collision `FUN_800ba514`: circles ~120 each (sum 240), pushed apart; measured minimum distance 210-240.
- Individual versus hub starts in seat order, as (X, Z, yaw): (-4, -646, 4), (667, -5, 3077), (-697, -19, 1006), (7, 682, 2055). All four face outward. The USA countdown held these origins at floor height −16. The saved L27 stage objects independently contain all four X/Z pairs.
- Bot gear 2 set in setup (`+0x1a = 2` when `DAT_8005a670[i]` != 0).

## Opening countdown

Two USA L27 starts held the player input lock and round clock for 99 arena updates. The platform started at yaw 1, reached 312 at frame 30 and 1209 at frame 99. Four coloured balloons appeared at frame 31 and eight were present at GO. The crate and black-balloon timers reached 201 and 301 on the last locked frame. Idle script 1 continued across GO. Four stock actors matched all 396 countdown render words.

Replaying each capture's birth choices matched all 908 balloon samples on integer position, height, state, drift and avoidance. In those captures live balloons advanced in birth order. Their proximity scan reads the newest first and sees positions already changed earlier in the same frame. The signed visual bob also matched 456 captured offsets when supplied the console's global frame. The online renderer uses round age for that phase. Its seeded arena can choose different spawn slots and drift from a particular console session.

The host stores the opening RNG after shuffling the slots and runs the 99 updates before accepting input. Each client replays the opening from that state against the room deadline. The rules clear before the first numeral. Two WebRTC peers rendered the 0/4/8 balloon sequence with identical positions on shared sample ticks. The opening leaves the clock, players and scores untouched. Big Stein and Top G use their own idle clips on the same animation clock.

## Balloons (object type 0x1802, attr +0x14 type 8..11 colour, 12 black; owner +0x24: 8->p1, 9->p2, 10->p3, 11->p0)
- Spawn `FUN_800b5d3c`: slot `(angle k*256, radius 0x500+0x140*r)` (16 angles x radii 1280/1600/1920/2240); height `floor - 0x600 - rand(128)`; drift speed `+0xe = rand(8)+4`;
  drift angle `+0x16 = (a + 0x800 - dir*0x200) & 0xfff` (straight tangential line); black stores outcome `rand(3)+4` at +0x24. States 3 -> 0 -> 1. Drift and vertical easing start on the birth update. The outer clamp starts using the 128-unit object radius on entering state 1.
- Slot picker `FUN_800b4f7c`: table `0x800bbe10` (64 slots, 300 random swaps at start), cursor `DAT_800bbd5e`. Occupancy grid 20x20 of 256-unit cells (objects mark 2x2 cells around x/z +-0x80, players 3x3). QUIRK: the slot test treats (angle, radius) as (x, z): col `(a>>8)+10`, row `9-(r>>8)`. Walk from the cursor; skip occupied; accept the first slot with an empty 6x6 window; else best of 10 tries.
- Per tick (state 1, `FUN_800b6608`): flag 2|8 -> state 9; `+0x22 = 4`, `+0x2a = atan(-x,-z) + ringSpeed`; drift `d` along `+0x16`; outer limit (clamped: `+0x16 -= dir*0x200`);
  `FUN_800b6ec0`: magnet pull (below); scan balloons newest-first (types 8..12, other height strictly between this height −299 and +252): dist < 0x100 hard push `0xff-dist` away; else dist < 0x400: `+0x22 = (0x400-dist)>>6` along the angle to the other; then pos -= `+0x22` along `+0x2a` (net: outward push of 4/tick);
  vertical ease: `diff = y + 0x300 - floor; if |diff| > 16: y -= diff>>6` (settles at y -784..-800, i.e. 768-784 above the floor; ~64 tick time constant). Render bob +-128 only.
- Pop touch (`FUN_800ba514`, `FUN_800baf1c`): the object's radius 128 plus fixed player probe radius 120 gives a strict horizontal limit of 248. Both squared distance and the fixed-point square root must pass. The balloon's height interval is `[hy - 43, hy + 252]` and must strictly overlap the character's body cylinder. The query runs before either player integrator, including during idle and spin when the body reaches low balloons. The full handler shoves a moving player and the idle handler shoves a stationary one.
- Attribution and pop (`FUN_800b6608`, `FUN_800b6044`): the last overlapping player in update order writes toucher `+0x16` while state 1 accepts the touch flag. The balloon update that frame enters state 9, clears the acceptance mask, and finishes its movement. Its cylinder can still shove a moving player on the next frame. The state-9 update then emits the pop at the stored origin, awards the point or applies the wrong-colour hit, and removes the balloon.
- Scoring (43/43 on the emulator): recolour timer `DAT_800bbd64 == 0`: popper +1 if owner == popper else hit (0x33). Recolour active: popper +1 if popper == `DAT_800bbd62`, else hit. Toucher -1 or > 3: nothing.
- Black effect `FUN_800b697c`, rerolled at pop time from the popper's skill s (`DAT_8009d87c[p*3]`, 0..32, default 20) with table `0x800bb848` = `T[0..7]=16, T[8..23]=15..0, 0 beyond`:
  `u1=T[s]`, `u2=T[32-s]`; human `u3=u1,u4=u2,iv=(u2>>1)+1`; bot `u3=u2,u4=u1,iv=(u1>>1)+1`; `r = rand(u3+1+u4+1+iv)` (argument inferred); outcome 4 (recolour) if `r <= u4+1`, 5 (pop others) if `r > u4+1`, 6 (reverse) if `r > u4+1+iv`.
  Human at skill 20: 59% recolour / 27% pop others / 14% reverse; bot: 28% / 11% / 61%.
  4: `DAT_800bbd64 = 150`, owner `DAT_800bbd62 = popper` (balloons show the popper's colour; last 30 ticks flicker, sfx 0x5ef). 5: every colour balloon with owner != popper is popped with toucher -1 (no score/hit). 6: `dir = -dir`, loop sfx restarted.
- Magnet (power-up 0x17): balloons of that player's colour (all colours while he owns an active recolour with >= 30 ticks left) move `dist/8` toward him per tick when within 5632 (the vertical part only acts within 16 units, i.e. practically not).

## Spawn timers (`FUN_800b4970`, runs when the game is active)
- Init (`FUN_800b359c`): crate timer `0x800bbd54 = 300`, black timer `bbd56 = 400`, balloon timer `bbd58 = 30`, colour index `bbd5a = 0`, recolour 0.
- Crate: if no crate object (states 0/1/3/6/7) and nobody holds the magnet: timer-1; at 0 spawn one crate and timer = 90 + rand(60).
- Black: if no black balloon: timer counts down from 400 (never reset); at 0 spawn one and set the crate timer to 90 + rand(60) (so a black balloon respawns the tick after it is popped).
- Colour balloons: count = four colour counts; max 8 (10 while a magnet is active, timer capped at 30). At timer 0: count < max: `max-count < 4` -> n = rand(max-count)+1, timer = 30 + rand(20); else n = 4, timer = 20 + rand(10); count >= max: timer = 60 + rand(30).
  Each balloon: colour index `(i+1)&3` -> type `[11,8,9,10]`; skipped if that colour already has 2; after the first 10 s a HUMAN colour with 0 balloons only spawns if `rand(skill+1) < 9`, with 1 balloon `< 7`, else the whole batch is abandoned. With a magnet holder: ONE balloon of the holder's colour per call.

## Crates and power-ups (`FUN_800b51a0`, `FUN_800b54cc`)

- Type 0x1801, attribute 2, spawns in state 6 with vertical scale 0x40. The spawn update adds 0x200, so the first visible scale is 0x240. It grows vertically to 0x1000 on its eighth update, then becomes solid on the next update. Its initial item roll is `[0x17, 0x13][rand(2)]`.
- A spin queues flag 2 and state 9. The next update runs pack 0796 script 2 and enters state 12 with the box mesh still present. One update later it swaps from pack 0796 word 0x2014 to pack 0794 word 0x2014 (boots) or 0x2015 (magnet). The item re-roll uses `rand(32) <= 32 - skill` for humans and `rand(32) <= skill` for CPUs to choose the magnet.
- State 13 starts on the floor with upward velocity 96. `FUN_8007a26c` subtracts 4 before each integration. There are 23 positive displacements and a zero-speed update at height 1104. The first homing update follows that apex. A crate on the ring is carried through the last floor update. In flight the item adds 0x71 yaw each update.
- `FUN_80015780` transforms marker 0x80 of the recipient's current pose into world coordinates. A pose without the marker targets the player origin plus 0x180 height. State 13 subtracts each signed X/Z delta shifted right by two, eases height with the same native Y-down shift, checks contact, then integrates falling speed (4 per update, capped at 240). Pickup can come from the recipient's cylinder, floor contact, or both pre-move planar deltas shifting to zero at `>> 3`, even above the cylinder. The full player contact handler can shove against the low item during launch. Once the first homing update enables mask 8, another player's full contact can take ownership and collect it.
- Collection awards boots for 240 updates or magnet for 300. The carried mesh becomes visible on the next upkeep update. `FUN_800b6c50` centers it on the actor and positions it 0x40 above the marker height, with class offsets 0x180/0x200/0x280 when the marker is absent. The carried mesh rotates by 0xaa per upkeep. Big Stein and Top G use Cortex's marker tracks and collision geometry.
- USA VAB 0180 uses 0x3fa at spawn and the shared break table `[0x3f5, 0x3f5, 0x3f7, 0x3f8]` at the burst. IDs 0x3f5 and 0x3f7 share sample 29 at different pitches. ID 0x3f8 uses sample 30. Boots and magnet start the 0x5f3 and 0x5f2 loops at pickup. The snapshot preserves item progress and the equipped loop resumes at its saved age.

PCSX ReARMed ran the USA frame loop with controlled placements and inputs. The crate test matches 183 sampled transforms, visibility states and item timers across ten live and result traces, plus the nine spawn and growth updates. It covers ordinary Square opening, ring release, running, a jump with a missing marker, recipient transfer, signed reach, floor collection, and flight through a draw, a win and a loss. A separate 420-update run from the unmodified L27 save showed a natural opening and a 300-tick magnet award to Cortex. The web test also checks live JSON resume and terminal replay, and runs three full CPU rounds with both power-ups collected. Chromium WebGL exercised both custom human seats, both item meshes, crate-break audio and effects, equipped loops, mid-flight reload, and terminal display. Run `npx tsx scripts/test-ring-ding-crates.ts` from `web/`.

The result renderer hides the item as soon as native rendering clears its flag. The disc can retain the invisible object in its list after that point. Its result player floor step can briefly use an item as a platform. The port uses that height for the item target and pickup probe while leaving the existing result character presentation in place. Result animation-bank timing can vary with native disc loading. Players use the shuffled update order below.

## CPU targeting and actions

US disc overlay `0720.t64.bin` loads at `0x800b32b4` in L27. Party difficulty rows at `0x800bb748` give skills 12, 20 and 24 for Easy, Normal and Hard. `FUN_80086918` sets those skills and an equal fallback rival weight of 16 for every seat.

- `FUN_800b7508` holds an object pointer (+0xc) or rival seat (+0x10) across ticks. Modes (+0x20) are search, object chase, rival chase, wait, jump and taunt (1, 2, 3, 6, 13, 21). A missing or inactive target restarts search. Hit clears the target and pad. Ordinary target acquisition runs from native idle and writes a neutral pad on the selection tick.
- `FUN_800b85a4` takes one shared `rand(4096)` roll per scan. It maximizes `abs((sqrtFixed(dx²+dz²) >> 6) - roll) * weight`. The base weights are `(skill+20)*4` for own colour, 30 for crate or black, and `skill*8` for a taunting or equipped rival. The power-up and recolour branches change these weights. Colour candidates still require the CPU's original colour and eligibility under the recolour. The scan uses horizontal distance, so a balloon can be selected before it can be popped. A previous crate or black target and a previous rival choice apply the overlay's four-bit score penalties. The newest object wins object ties and a rival wins an object–rival tie.
- Aim rolls both offsets each tick from `noise*16 - rand(noise*32)`, with `noise = 33 - skill`. Grounded CPUs without hover boots change their aim when the target is ahead of the rotating ring. They rotate the target by `-noise*dir` inside the lead window and subtract `trunc(noise*8192/360)` from the grounded object-chase heading. `FUN_800b8294` writes two occupancy strips that this controller never reads.
- `FUN_800bb230` chooses the closest active object within 1024 units. For crates it measures within 256 units of a point 256 units ahead, using actor yaw. A nearer foreign balloon can block a Cross press even during the CPU's own recolour. A matching colour in object chase starts an eight-tick Cross timer. Black or a different colour type that is eligible keeps the current timer in object chase. Rival chase sets eight ticks for either eligible balloon. Jump mode holds Cross through native rise/fall while the target survives. The body overlap probe `FUN_800864cc(0x40)` can also request Square, with different chances for an incidental rival in object and rival chase. Square takes precedence when both buttons are newly pressed.
- With no target candidate, `FUN_800b8b5c` picks a random eligible rival. The skill roll can taunt instead. A separate distance test in `FUN_800b8c74` can taunt after the initial 30–89 tick cooldown, past `1024 + 32*skill` from the nearest rival. Its cooldown becomes `30*(skill+8)`. The fallback taunt has a 300-tick cooldown.
- The shared step saves target body IDs, CPU modes and timers, latched pad, steering yaw and the two-word `FUN_80015590` RNG state. The arena has its own stream. `FUN_800136bc` latches the preceding pad and `FUN_800b90d0` uses the current exact heading when that pad has a direction bit. CPU walking applies the signed fixed-point movement and turns actor yaw by a quarter of the angular difference. Prediction and authoritative play run the same step. The host's bot hook also signals a disconnected human takeover and the snapshot carries it through prediction until a human pad resumes.

### Validation and residuals

- Executed the controller and its selection and proximity helpers in Unicorn from L27 RAM. The compared code and skill-table ranges exactly match the US disc. Twenty-five fixed scenarios at every difficulty and both mixed and all-CPU masks gave **450/450** matches on target, mode, timers, heading, emitted pad and final RNG words. Actors and objects were held in place and the overlap helper used fixed body cylinders. Cases included high and wrong-colour balloons, both recolour owners, black and crates, hover and magnet, rival overlap, both ring directions, taunt, and interruption on disappearance or hit.
- Loaded the L27 state in PCSX ReARMed and ran 300 ticks per difficulty and seat mask, with fixed seat order and an idle human in mixed rooms. All **847** nonzero effective CPU pads matched the previous tick's raw pad. The continuous ground-run sample matched signed displacement and quarter-turn facing in **272/277** cases. On the five other updates the native actor held its origin and facing despite a movement pad. These occurred on the same captured tick in the all-CPU trials. The native captures also showed the engine clearing some latched pads under its own control locks.
- Eight ordinary completed native CPU jumps stayed in rise/fall for **26 ticks** and reached **774 units**. The web jump previously cleared fall on the 26th airborne sample. It now keeps that sample and enters landing on the next update. The object probe uses live web crates and balloons and the web character cylinders, so pickup phase and contact differences can change when an action fires. The web hit timer still approximates the native hit-lock sequence.
- Whole-round outcomes depend on the CPU and scheduler streams and the existing spawn, contact and animation models. After the touchdown correction, the fixed-order build produced **282 points in 417 jumps** and averaged **5.75 colour balloons** after the first ten seconds in three all-CPU rounds (seeds 7, 432, 1234).
- `npx tsx scripts/test-ring-ding-cpu.ts` from `web/` checks native pad examples, the frame when an action takes effect, and snapshot replay across both room masks, all difficulties and mirrored controls. It also covers takeover and human input resumption.

## Sound (level bank 0179; table `0x80064508 + id*2` = {slot, tone}; sample n = `assets/audio/sfx/0179/n.mp3`)
| id | meaning | sample |
|---|---|---|
| 0x5dc-0x5df | pop type 8 (rand 4 per pop, `DAT_800bb8e8`) | 7, 8, 9, 10 (10 = empty stub) |
| 0x5e0-0x5e3 | pop type 9 | 11, 12, 13, 14 |
| 0x5e4-0x5e7 | pop type 10 | 15, 16, 15, 16 |
| 0x5e8-0x5eb | pop type 11 | 17, 18, 19, 20 |
| 0x5ec | ring loop (restarted on reverse) | 21 (5.9 s) |
| 0x5ed | any black pop | 22 |
| 0x5ee | recolour | 23 |
| 0x5ef | recolour flicker | 22 |
| 0x5f0 | reverse | 23 |
| 0x5f1 | pop others | 24 |
| 0x5f2 | magnet | 25 |
| 0x5f3 | hover boots | 26 |
| 0x3fa | crate spawn | 31 in bank 0180 |
| 0x3f0, 0x41c | silent (slot 255) | - |
Pop particle effect id `DAT_800bb89c[owner] = [3,2,0,1,4]` (`FUN_8007a524`). Hit/jump voices live in the character voice banks (not mapped here). The client has no looping sfx API, so the ring loop (21) is not played.

## Animation
On-foot character models. Common scripts 1, 5 and 10 drive idle, run and spin. The overlay uses 0x2b for hit and 0x2c for jump.

### Jump and touchdown in normal play

PCSX ReARMed captures from the US L27 save state, with tick 0 at the first rise update. Heights here are `-16 - native_y`. Native pose words come from the render object at `+0x74`; the jump cap and rise flag come from the movement struct at `+0x34/+0x3c`.

| Profile | Takeoff height | First fall tick | Apex | Last fall height | Touchdown tick |
| --- | ---: | ---: | ---: | ---: | ---: |
| CPU, Koala | 125 | 12 | 774 | -45 | 26 |
| Human, Coco, held | 117 | 11 | 682 | -38 | 27 |
| Human, Koala, held | 115 | 9 | 567 | -57 | 22 |
| Human, Coco, one-tick press | 117 | 6 | 276 | -54 | 17 |
| Human, Koala, one-tick press | 115 | 5 | 256 | -32 | 14 |

- `FUN_800860d4` leaves an exact zero velocity in rise for one update. The next update changes the rise flag from -1 to 0 while the cap stays nonzero. The falling handler lands at an exact floor origin as well as below it. The ring carries by origin height, so an unbooted player is carried on takeoff and on the touchdown update. With hover boots the same held and tapped arcs kept the same origin in X/Z across both updates.
- A rival placed beside Koala on descent pushed his origin horizontally and left the full vertical and pose traces identical to the plain jump. The rise and fall contact handlers read the origin before vertical integration. The port keeps its existing collision shapes and samples that height for body and balloon contact.
- Entering a hit during rise clears equipped items and the human Cross pad. The active vertical integrator continues under script 0x2b. In the hit fixture after three normal Koala rise samples, height peaked at 424, reached -16 on tick 17 and snapped on tick 18 with the hit pose still active. That touchdown has no script 8 cue. The web hit and contact models retain their existing stun and horizontal approximations.
- In an ordinary jump, script 0x2c starts at its first pose word and stays active through the below-floor sample. On touchdown `FUN_80088450` starts script 8 and `FUN_800b971c` advances it again in the same update. Koala shows `0x4112` and Coco `0x4191` on that first visible landing frame. Uninterrupted script 8 shows 26/10/5/3/10/8/14/6 frames for engine IDs 1–8. Direction or a new Cross press can interrupt it on the following tick.
- Script 0x2c plays voice offset `0x0c` through opcode `0x800a` at takeoff. Script 8 plays `0x0d` through `0x8009` at touchdown. L27's loaded tone table matches family `c` for the captured seats. The client holds an authoritative cue until the displayed tick for that seat reaches the action. Big Stein and Top G use Cortex's human arc and landing duration with their authored jump animation and effort cues.
- `npx tsx scripts/test-ring-ding-jump.ts` from `web/` checks the captured height/phase sequences, all four CPU and human slots, hover carry, contact and hit behavior, and one-shot event ticks. It also checks the exact-floor and zero-rise boundaries.
- A normal Chromium LAN match exercised Big Stein, Coco, Koala and Top G in slots 0–3. The sampled stock pose words matched the Coco and Koala captures, and all seats dispatched both voice cues. In a normal local CPU match with controlled balloon targets, all three CPU opponents landed after 26 updates. Top G held the same X/Z through takeoff and touchdown with hover boots.

### Versus result

- `FUN_800b4144` marks a sole winner with `0x200`, losers with `0x400`, or all players with `0x100` on a tie. A draw leaves their existing state handlers in charge with the pads cleared. Players finish their current action and settle to idle. The draw cue is sound `0x1af` (0278 sample 13), from the shared draw sequence in `FUN_80082d90`.
- States `0x36` / `0x37` generally start one tick after ranking. An existing hit or jump can postpone entry. `FUN_800b9a04` starts winner script `0x0c`. `FUN_80085718` requests the alternate clip and `FUN_80085890` switches to `0x0d` once it is available. Both scripts use the standard character model. The winner eases toward yaw zero under `FUN_8008a200`.
- `FUN_800b9ce0` starts native idle `0x01` and resets loser scale to `0x1000`. `FUN_800b9eec` subtracts `0x60` each update. After 34 decrements scale is `0x340`. On the 35th decrement the candidate falls below `0x301`, and the player disappears with a silent, one-shot `FUN_8007a524` pop at floor level (pack 0794, scripts `[3,2,0,1]` by slot). Equipped effects and their loop sounds end on entry to the win/lose states.
- Replayed forced scores and a near-zero timer in the L27 save state. Koala and Coco switched to `0x0d` 14 ticks after winner entry, Cortex after 12 and Dingodile after 15. The view uses those waits and 15 ticks for the four characters without captures. The terminal pose words and loop points for all eight came from RAM. L27 loads voice family `c`. The shared winner calls use the same samples and pitches in families `b` and `c`.
- `FUN_800b3a3c` zeroes the direction target on either outcome. From speed 13 the ring runs at 12, 11, …, 1, 0 over ticks 1–13. It keeps projecting grounded draw players and visible losers onto the ring even at zero speed, which can move an origin a few units through fixed-point rounding. Winners and hover boots are excluded. Ground crates follow their stored polar coordinates.
- Cleared pads stop running. Existing jumps finish in place unless contacts displace them. `FUN_800860d4` holds the apex through zero velocity and integrates through the floor before `FUN_800b971c` snaps down on the following update. `FUN_800ba514` can separate players during a spin, jump or hit with knockback. `FUN_800baf1c` pushes ground-idle and hit players away from crates. A spin that is still active in a draw can write knockback `0x30` while the result flag suppresses the new hit state. The engine applies each knockback update, then reduces its magnitude by 4. The view continues these steps on a copy and uses the terminal snapshot's hit and jump state to time pose entry.
- Captured all four origins for a draw and a win in each slot, plus fixed-order captures with collisions, jumps, an active spin and residual knockback. In the unseeded draw, slot 0 went from `(-938,-16,-433)` to `(-984,-16,-319)`, slots 1 and 2 stayed put on the hub, and slot 3 landed on tick 1 and rode the ring to `(0,-16,-1335)` on tick 13. With slot 3 winning, it kept `(x,z)=(166,-1319)` through its landing. Replaying 44 ticks per capture matched 1,332 of 1,408 position samples exactly. The remaining samples differ by at most two PS1 units near the carried crate.
- The view uses the online result for ranking. The chosen character model stays on the actor throughout, including Top G and Big Stein.

## Camera: unchanged (`DD_CAM` fitted to `docs/reference/dragonDrop` frames; not read from code).

## Unknowns
Exact spin hit shape (cone vs disc) and range, knockback for the 0xb/9/10 attacks (measured on 8/10 only), black-outcome rand argument, hover boots' extra effects, ordering between balloon and crate callbacks, exact item pickup range.

## Function map
`FUN_800b3428` callbacks, `b359c` level setup, `b382c` slot shuffle, `b3938` prop binding, `b3a3c` ring, `b3edc` ranking, `b4144` end, `b4970` timers, `b4ba4` grid/counts, `b4dc4` balloon batch, `b4f7c` slot picker, `b51a0` crate spawn, `b54cc` crate update, `b5d3c` balloon spawn,
`b6044` balloon update/pop, `b6608` balloon move, `b697c` black effect, `b6c50` power-up upkeep, `b6ec0` magnet/avoid, `b7508` AI, `b85a4`/`b8b5c`/`b8c74`/`b8294` AI helpers, `b8e64` crate batch, `b8f48` outer limit, `b9048` per frame, `b9088` family init, `b90d0` input,
`b92bc`/`b937c` hit state, `b9608`/`bb52c` jump, `b971c` fall, `b9a04`/`b9bf8` win, `b9ce0`/`b9eec` lose, `b9804`/`b98b8` dead, `ba098` attack vs objects, `ba344` pickup range, `ba514` player collision/pop touch, `bb230`, `bb37c`, `bb5f0` cross->jump hook.
Exe: state handlers 0 idle `87428/874ec`, 2 `8a99c/8795c`, 3 run `8a924/87b8c`, 4 `87fc0/8a8f0`, spins `88708/88794`, `88bac/88c28`, `88f78/8900c`; `86fcc` buttons, `871e4` ground check, `863d0` floor snap, `8502c`/`854c0` anim scripts, `86d88` players into grid, `868b4` set hit.

## Effects (decoded)
Pack 0794 (db 0x80052fcc): balloon pop = script 3 / 2 / 0 / 1 by owner colour, black balloon = script 4 (parts 5-14). Crate hit = shared crate
pack 0796 script 2 (parts 37-42). No score number object in this game.

## Sound bank correction (2026-11-19)
The level loads VAB **0180** (L27 RAM dump: loaded tone table == disc 0180, ids resolve 1:1). The sample numbers in the table
above were read against 0179 (Dragon Drop's bank) and are superseded by `DD_SFX` in web/client/games/ringDing.ts:
pops 0x5dc-0x5eb = two ids per sample (9,9,10,10 / 11,11,12,12 / 13,13,14,14 / 15,15,16,16), ring loop 0x5ec = 17,
black 0x5ed = 18, recolour 0x5ee, reverse 0x5f0 = 21, pop others 0x5f1 = 22, magnet 0x5f2 = 23, hover 0x5f3 = 24, crate spawn 0x3fa = 31.

## Sound audit (2026-11-23)
`re/audit/ringDing` is generated from `re/out_ringDing`, which holds the Dragon Drop overlay (the level 27/28 name swap). Ring Ding's
overlay is `re/out_dragonDrop`, so its sound list is `re/audit/dragonDrop/sfx.md`. Its 0x6xx ids belong to our `dragonDrop` game.
Every literal id in the real Ring Ding overlay, checked against the L27 tone table (`0x80064508 + id*2`) and VAB 0180:
- Wired: 0x5ec-0x5f3, 0x3fa and the break table 0x3f5/0x3f7/0x3f8 (literal in `DD_SFX`). The winner calls in `FUN_8008a200` come from
  `winnerVoice` in voice.ts (name block*0x32+1, 0x1b0, block*0x32+7).
- Added: 0x5ef. `FUN_800b6044` / `FUN_800b6608` play it without a position. In the last 30 recolour ticks, each colour balloon's update
  checks bit 1 of the timer. A clear bit resets flag `DAT_800bbd68`. A set bit plays 0x5ef once while the flag is clear. With colour
  balloons live, the cue plays at timer 27, 23, 19, 15, 11, 7 and 3. The sim emits `flash` and stores the flag as `rcCue`.
  `scripts/test-ring-ding-sfx.ts` checks this.
- Silent: 0x3f0 (crate kind 5) and 0x41c (hover-boot pickup) have slot 0xff in L27 and no tone in VAB 0180.
- Unreachable: 0x1a4/0x1a5/0x1ae (team), 0x1b1/0x1b2 (level 0x20), 0x1b8-0x1ba (flag 0x1e0 modes) in `FUN_8008a200`.
- All tones and programs in 0180 use volume 127 and pan 64. The view's 0.7 (pops), 0.8 (black, crates, flash) and 0.55 (ring loop) levels
  are its own mix. The original scales positional calls by camera distance.

## Horizontal contact and result motion

US L27 RAM matches disc overlay `0720.t64.bin` for ring, crate, contact and limit routines. The scheduler, movement, attack query and all four spin handlers match `0991.code.bin`. The RAM cosine and bearing tables match the shared fixed-point math.

- `FUN_80085d2c` applies the signed shifted drive and knockback after the active seat's contacts. Spins write magnitude `0x30` and the integrator subtracts 4 after each of the 12 displacements. Crash, Coco, Dingodile and Koala use the bearing from victim to attacker. Cortex, Brio, Tiny and Rilla require a strict `0x200` cone, use their movement yaw for the impulse, and set the victim's target yaw 180° away. `FUN_800864cc` returns the first intersecting seat using the current attack cylinder. Hit entry and script `0x2b` happen on the victim's next update. A draw suppresses new hit entry while an active spin can still write an impulse. The terminal yaw lock keeps draw actors facing their pre-result direction for the first 98 updates, apart from the explicit Crash and Coco spin rotation. Win and lose handlers take over yaw on their own schedules.
- `FUN_800ba514` separates the active player using each character's cylinder and strict vertical overlap. In versus, a stationary actor's full contact handler yields to a rival with nonzero drive speed. Two grounded idle players can overlap. Ground idle and hit states use `FUN_800baf1c` against solid crates with combined radius 248. The squared distance and the fixed-point root both have to be below the threshold. The second test accounted for the last two-unit result error in the carried-crate fixtures.
- `FUN_800b3a3c` reprojects player origins and rotates crates from their stored radius and bearing. The snapshot keeps that crate pair through live play and result braking. Older snapshots recover the spawn radius and a bearing that reproduces the saved origin when available. `FUN_800b8f48` clamps solid origins to `2432 - cylinder radius`. Ring contact uses height before the vertical update, including on takeoff and touchdown. In a result, winners and hover boots skip carry, while grounded draw players, visible losers and crates still project at zero speed.

PCSX ReARMed samples below use native `(x,z,height)` and fixed seat order 0–3.

| Sample | Observed |
| --- | --- |
| Cortex hits earlier-seat Koala | `(205,75,0)` stays on the spin query, with magnitude 48 queued. The hit update moves to `(253,75,0)`, magnitude 44, yaw 1689, pose `0x4201`. Twelve displacements end at `(517,75,0)` with yaw target 1024. |
| Koala hits later-seat Cortex | On the query's tick, `(205,75,0)` goes to `(251,92,0)`, magnitude 44, bearing 2843, unchanged facing 1911 and pose `0x4001`. It ends at `(505,189,0)`. |
| Airborne Koala | Shove moves `(205,75,189)` to `(269,99,221)`. The hit moves to `(317,99,240)`. Touchdown at `(581,99,0)` still shows `0x2b`. |
| Walk, jump and edge | A runner shoves off a stationary rival to `(-177,80,0)`. The stationary jumper keeps `(-150,100,115)` on takeoff and separates to `(-227,80,217)` on the following update. Koala's outer clamp lands at `(2279,-8,0)`. |
| Solid crate | A hub crate moves a stationary Koala from `(-130,40,0)` to `(-237,74,0)`. With knockback in the same fixture the first post-contact origin is `(-227,122,0)`. At ring speed 13, the crate at `(1280,0,0)` becomes `(1279,-26,0)` and the nearby player ends at `(1063,99,0)`. |
| Result | The seeded draw spin moves Coco from `(-170,-100,0)` to `(24,-507,0)` by tick 16. The movement yaw changes to 1769, while actor yaw stays 3413 and the idle pose continues. In the slot 1 win replay, Koala settles at `(-967,-380,0)` and the crate at `(-1179,-499,0)`. |

The controlled live replays matched 1,188 sampled player origins and the eight existing 44-tick result replays matched all 1,408 player origins. The new contact test exercises all ten roster looks, including Big Stein and Top G with Cortex contact data, through both CPU and human input in every slot. Run `npx tsx scripts/test-ring-ding-contact.ts` from `web/`.

The renderer uses the stock hit pose by snapshot frame and the custom animation fallback for both web-only looks.

### Shuffled versus seat dispatch

USA `FUN_80085650` builds the 16 rows at `0x8009d764` with 64 draws from `FUN_80015590`. Each row starts at `0,1,2,3`, then each entry swaps with any of the four seats. `FUN_80083e8c` draws one row per update in play and results. The RNG code and starting words match `SCUS_945.70`. Replaying the disc code in Unicorn from eight starting pairs matched all 128 rows, 64 subsequent choices, and both final RNG words against the shared implementation.

PCSX ReARMed ran the USA L27 frame loop with the initialized table and seeded the first row draw. The replay logged the actual movement calls and verified their order on 80 updates. The web's matches against the same deciding samples went from **6/16 to 16/16**. Balloon attribution and pop matched 2/4 before and 4/4 after. Crate attribution and break matched 2/4 and 4/4. Live spin contact and draw spin motion each matched 1/4 and 4/4.

| Round seed | First native order | Balloon and crate claimant | Live target after both spin queries `(x,z,impulse)` |
| --- | --- | --- | --- |
| 0 | 1, 0, 3, 2 | Seat 0 | `48,48,44` |
| 1 | 2, 3, 1, 0 | Seat 0 | `0,40,48` |
| 7 | 2, 0, 1, 3 | Seat 1 | `-47,48,44` |
| 432 | 2, 3, 0, 1 | Seat 1 | `0,40,48` |

Seat 1 owned the balloon in all four trials. Seat 0's claims produced a wrong-colour hit. The two spin queries aimed at seat 3 from opposite sides. When seat 3 had already updated, its impulse remained queued at 48 until its next update. In the draw replay, the same seat order resolved motion with the native suppression of new hit entry.

The native frame runs arena preparation before the scheduler and queued object callbacks after it. Each CPU decision runs within that seat's update before movement, as seen in 40 calls across 20 mixed-input updates. The CPU sees earlier seats' new origins, and its emitted pad applies on its next update. Rival queries scan by seat number and CPU object ties follow the newest-first candidate list.

The L27 executable queues balloon and crate callbacks together in ascending object-pool slot order at `80079138–80079230`. The allocator at `80022adc` takes the head of the free list, which `80023110` updates when an object is released. The result fixture's two drifting balloons occupied slots 5 and 8, so slot 5 moved first even though it was born later. The web now keeps a separate callback slot for each balloon and crate, reuses freed slots last-freed first, and saves the slots with the snapshot. The focused regression interleaves a crate callback between two pops and checks the point and wrong-colour hit when the black balloon recolours before or after the other pop. It covers the live and result passes and checks reuse on the next spawn.

The web pool accounts for gameplay balloons and crates. Native particles and other actors also occupy slots and the disc shares RNG across systems, so full console rounds can still diverge.

The web saves the table and the two dispatch RNG words in each snapshot. Prediction and reconnect continue from that state. Result animation advances a copy of the RNG. Snapshots that predate dispatch seed it from the saved arena RNG. Fixed-order geometry fixtures still run against their recorded row, and the seeded contact regression exercises CPU and human input in all ten roster looks.

A production-built Chromium match used WebRTC data channels with local signaling, two human inputs (Big Stein and Top G), and two CPUs. The guest reclaimed its seat from CPU control after reconnecting. Both clients reached the same tick-2699 terminal snapshot, dispatch RNG and placements. The normal-timing loopback also matched terminal state and the first 60 result updates for a reconnect and a late spectator.

### Balloon contact replay

The contact and pop code ranges from the US L27 save matched the bytes in disc overlay `0720.t64.bin`. PCSX ReARMed fixtures seeded origins, pads, and the clock, then ran the native frame loop. The web replay fed the captured pads through `createWorld` and `stepWorld` with matching starting origins and balloon drift. Nineteen live fixtures and five expiry fixtures matched all **180** compared frames on balloon state and toucher, live balloon coordinates, participating player origins, raw score, and wrong-colour hit entry. The expiry fixtures were compared through the first zero clock frame.

| Native sample | Outcome |
| --- | --- |
| Strict boundaries | At horizontal distance 247 and actor height 200, Koala touches at balloon height 960 and misses at 961. Coco touches at 861 and misses at 862. Cortex, at distance 245, touches at 776 and misses at 777. Distance 248 misses. At Koala height 600 the lower contact edge misses at balloon height 352 and touches at 353. |
| Moving Koala | Player origins over three frames are `(-225,35,415)`, `(-187,38,517)`, and `(-173,49,606)`. The first frame steps into range, the second tags the balloon, and the third shoves against its cylinder and awards the pop. |
| Two contenders | With order 0, 1, 2, 3, slot 1 tags last and scores. Reversing the first two native updates gives slot 0 the touch and a wrong-colour hit at pop. A slot 1 that first overlaps on the pop frame leaves the slot 0 claim and point intact. |
| Wrong colour | Touch marks state 9 on frame 1. On frame 2 the balloon disappears and Coco enters `0x33` at height 436, with zero horizontal impulse and zero points. Holding Cross in the Koala case carries the ordinary rise through the pop frame and shortens it on the following update. |
| Expiry | Touch on `0x100 → 0x58` awards on `0x58 → 0` and can decide the winner. First touch on `0x58 → 0` enters state 9 before ranking, with the tied scores still producing a draw. The disc resolves that pending balloon after dispatch and increments the raw counter without reopening the draw. The web stops its authoritative step at dispatch. A native balloon still moving after dispatch clears its toucher and pops without an award. |

The replay controlled object placement and seat order. Mixed crate and balloon contacts use separate passes on the web, and overlapping balloons can take different avoidance trajectories. `npx tsx scripts/test-ring-ding-contact.ts` covers the geometry boundaries, contention, moving and stationary contact, wrong-colour hit entry, and the two expiry contact frames.

### Balloon cleanup after dispatch

Tick 0 is the L27 frame that records the win or draw. `FUN_800b6044` handles a balloon already in state 9 on tick 1 and keeps its saved toucher. A matching colour increments the HUD tally. A wrong colour can put a player into hit script `0x2b`, including a grounded winner who has just entered the win pose. The player flags assigned at tick 0 still control the result. In the captured win, seat 1 won at 005 to 004 and remained the winner when seat 0's late pop brought the displayed scores to 005 apiece.

An untouched balloon continues drifting on ticks 1 and 2. The first update clears the toucher and queues the forced pop. The second enters state 9, and the third bursts at the last origin. Contact on the first result tick can move that burst up to tick 2 without a point. The two-ball L27 win and draw fixtures both kept their balloons at `(1,-12,798)` and `(584,2,798)` on tick 1 and burst at `(2,-18,797)` and `(600,3,797)` on tick 3. Coordinates are native `(x,z,height)`.

The captured calls use pack 0794 with the balloon's owner colour for forced bursts. A credited pop under an active recolour uses the recolour owner's burst. Sound IDs still come from the original type. For example, the yellow state-9 pop called script 3 and sound `0x5e8` on tick 1. The black balloon called script 4, its `0x5ed` pop, and the sound for its stored power. The loser shrink bursts remain silent.

The Ring Ding view advances a private copy of the terminal snapshot and uses its tally for the arena HUD. A comparison against PCSX ReARMed matched all 61 sampled frames across ten fixtures on balloon state, origin, removal and displayed score. The native video captures trail the logic counters by about two updates. Chromium WebGL rendered the corresponding mesh removals and bursts and played the type-specific audio files. The particle scatter and choice within each pop's sound group use the browser's existing presentation randomness.

### Spin recovery and keyboard interrupts

The USA player scheduler at `80083e8c` decrements the seat's spin lock at player offset `+0x66`. Once that timer is clear, each further tick reduces the recovery cost at `+0x68`. Entering script 10 adds 15 to the cost, capped at 40, and copies it to the lock. On a blocked attack from a ground state, `80086fcc` clears Square in the previous pad. A fresh press held through that rejection retries until it succeeds. Holding the original attack continuously produces one swing.

In controlled L27 captures, X on frames 3 and 23 starts attacks with locks of 15 and 25. Pressing X again on frame 44 and holding it starts the third attack on frame 48 with a lock of 40. Jump or taunt interrupts a spin immediately. Pressing jump and attack together from idle starts the attack. The previous state's movement setting applies on the transition frame, including Crash and Coco's last moving step into a taunt. Online snapshots carry both timers, pad history and remaining spin frames.

Across 22 PCSX ReARMed recordings, 8,800 two-seat actor updates matched the web simulation on action state and both recovery timers. All 2,141 spin pose words matched. The captures used all eight engine character IDs, controlled starting states and fixed seat order. The web uses Cortex's 19-tick timing for Big Stein and Top G, sampling their own 19-frame spins from the snapshot. These measurements cover isolated inputs, moving attacks and interruptions. Human right-arrow movement advanced 50 raw units on the hub. One Tiny touchdown in the moving fixture also displaced the actor in the emulator. The web replay did not reproduce that displacement.

All eight L27 script-10 tracks request the character's voice block plus 14 on entry. Script 2 requests offset 2. Script 8 requests offset 13, including Dingodile and Koala's follow-through. The stage uses the 0206–0213 family. The full 32-byte disc tones for Coco (ID 64), Cortex (114), Koala (214), and Dingodile (264) match L27 RAM at offsets 0x1c2290, 0x1c11e4, 0x1c364c and 0x1c0048 respectively.
