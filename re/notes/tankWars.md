# Tank Wars (`tankArena`, levels 5-8) - from the decompiled overlay (0726.t5f, base 0x800b32b4)

Sim: `web/shared/games/tankArena.ts`. View: `web/client/games/tankArena.ts`. Sound map: `web/client/games/tankArenaSfx.ts` (generated).
Status tags: [exact] read from the code (and mostly checked in a live recording), [est] estimated / simplified.

## Units and conventions
- 30 Hz, one update per frame (frame counter 0x8004e0d8). Positions 1/512 tile, tile centre 0x100+0x200k, 1024 u = 1 model unit, +z away from camera.
- Pen centres (game units): L5 (0x900,0x800), L6/L7 (0x800,0x800), L8 (0x900,0x700). World = (g-c)*TA_K/1024, world z = -(gz-cz)*TA_K/1024.
- Angles 0x1000 = turn. Shell direction = (-sin h, -cos h) with h the turret yaw (+0x1e). Hull movement direction (sin t, cos t), t = yaw + hull child. Visual face of the turret = -h*2pi/4096.
- Level -> variant: 5 swamp (bank 0159), 6 desert (0162), 7 jungle (0160), 8 metal (0161). Each VAB tone carries its sound id; the table at 0x80064508 in every level's RAM dump routes the id to that (program, tone) in slot 1, and the sample is vag-1 of the level bank. `TANK_SFX` is generated that way and also lists loop starts. The earlier table sent most ids from 0x1c2 and 0x48e-0x4f3 to the wrong samples and missed 0x490-0x493 and 0x50b-0x50f. Silent ids in L5: 0x4e9 0x4fd-0x500 0x501 0x51f 0x522 0x4be-0x4c5 0x4d2-0x4d7; L6 0x501 0x51f 0x522; L7 0x4fd-0x501; L8 0x4b4-0x4b7 0x51f 0x522.
- Level tables (indexed level-5): setup 0x800b3370, AI decide 0x800b3300 / 0x800b3338 (L5/7/9 "a", L6/8 "b" variant), mine blast 0x800b3488 (L5/7/9 area 0x800bd710, L6/8 flames 0x800bd6b0).

## Rules [exact unless noted]
- 4 tanks, hp 99, 3 mines at start, weapon by character (engine char 1,2 -> 9; 3,4 -> 11; 5,6 -> 10; 7,8 -> 8), ammo 999. look.ts index -> engine char [1,2,5,7,3,4,8,6]. Speed chars 1..8 = 28,28,24,24,26,26,24,24 (L5: x3/2).
- Individual versus uses the shared health ranking at timeout. A unique highest HP wins, tied leaders draw, and the survivors retain their health and models. Four simultaneous knockouts also draw. The lowest-seat tie break in overlay helper `FUN_800b62a4` does not describe the observed versus path.
- Spawns (x, z, yaw): L5-7 (256,768,0x800) (768,3840,0xc00) (3840,3328,0) (3328,256,0x400); L8 (256,768,0x800) (768,3328,0xc00) (4352,2816,0) (3840,256,0x400).
- Permanent tile blocks (cacb4 movement layer = cacfc projectile layer): L5 open 9x8 (bounds 0x1100,0xf00); L6 8x8 rows{1,3,4,6} x cols{1,3,4,6}; L7 8x8 rows{3,4} x cols{3,4}; L8 9x7 rows{1,3,5} x cols{1,3,5,7}. Metal Fox also has the timed platforms below.
- Damage entry `FUN_800b6354`: ignored if game over, invulnerability counter, dead, or state 0x69. AI target with a live human: dmg*(((0x20-skill)*0x96>>5)+0x32)/100 (dmg<400). No live human (`DAT_8009d908`): dmg*3 [est: only x3], AI skill 30. Hit state 0x69 grants 60 ticks of immunity and launches the pilot with velocity −100 and gravity +12. The chassis offsets by half the hop. The lengths of hit and wreck states follow scripts 0x57 and 0x58 for that pilot.

## Input at GO

Eight USA recordings compared the same slot holding Right, Square, Circle, Cross and Triangle from the countdown with pressing them on the first playable update. On all four stages, sample 99 read held mask `0xf020` in both runs. The held run had an empty pressed mask, kept all three mines and left the gun ready. The fresh press spent one mine and set the stock gun cooldown to 10. Swamp Fox also set the shield timer to 60. Both runs started the 90-tick taunt. Releasing and pressing again on sample 110 fired the held run’s gun. The host and client prediction prime the three edge-triggered actions from the last countdown sample.

The CPU starts with a gun cooldown of 150. Four mixed-room recordings counted it down to 52 on the last locked update and 51 on the first playable update. In CPU-only Swamp Fox and Metal Fox runs it reached zero on locked update 75. The human gun starts ready. The original setup at `800b6890` reads each character’s speed, applies Swamp’s 3/2 multiplier and then scales CPU speed by `(84 + skill) / 100` with integer truncation. The simulation matched 768 native speed initializations covering four seats, eight native characters, all four arenas, three skills and both control types.

A human fire press with three stock shells still in flight plays `0x4f1` at the tank. The gun must be idle and its cooldown zero. Holding the button, pressing during recoil, and a CPU's rejected shot produce no cue. These gates matched 32 controlled calls to the original weapon routine on L5–L8.

## Individual versus results on L5–L8

A full four-human idle Jungle Fox recording reached GO at sample 99 and a draw at sample 2797, or 2698 ticks later. The TIE mesh grew at +2, crossed its sound threshold at +23 and reset at +121. Metal Fox's duck flag at 800655ac stayed set through draw tick 119. Controlled two-way, four-way and simultaneous-knockout draws retained the four seat scores.

A Jungle Fox shell reduced Crash to zero on sample 253. The verdict arrived at 254. The surviving Koala's state 0x70 began at 255, the name at 286, “wins” at 313 and the reaction at 344. Crash followed the hit through 279, the wreck through 337 and became a rising spirit on 338. A second capture hit Coco on 253 with 79 HP left. The clock expired on 255 and her winner state began at 275, the update that completed her hit animation.

`FUN_800babcc` switches camera mode, removes living losers from the tracking list and starts the announcer and the pilot's lead-in. `FUN_80078dd4` uses its result box, half-width 256 and half-height 960 with zero Z extent. The camera eases from the stage camera each tick. `FUN_800bacd4` rotates the turret by 21 angle units each tick. The tracked chassis holds its world heading and the Swamp boat turns with its pilot. Pilot script 0x5c loops after 0x5a while the original loads the cheer. Recovery calls 0x59 after entering victory, giving a hurt winner the idle lead-in. The browser uses measured seven- or eight-tick lead-ins. Disc load variance can shift that switch by one tick.

The host sends the win result on the reaction tick. It sends a draw at the verdict. Both freeze the ranking. Clients continue a private arena copy during the result, including in-flight shells, wrecks and supply objects. The WebGL spirit uses the native mesh, pose cycle, socket offset and 24-unit rise. The three sparks use the original part, staggered launches, fixed-point velocities, fade and floor cut-off. Six spirits in Swamp and Jungle matched 1,953 native spark samples with the recorded random draws. Online spark directions and audio takes use deterministic local variation.

## Metal Fox platforms in USA versus

- L8 setup at `800b5d40` always creates the `0x1310` wave controller. `800c0348` reads the table at `800ca8c4` from overlay 0726. The table repeats four layouts, 250 frames apart. In the USA versus capture, the first wave spawns 10 frames before GO.
- `0x1311` waits six frames, then `800c04e0` writes both collision layers if the tile is clear. A tank less than 512 units away on x and 511 on z delays the platform and costs it a frame of raised time, down to a minimum of one. The platform rises from y=184 at 30 units per tick, holds for up to 180 frames, then sinks. It clears both layers at y=210, independently of weapon impacts.
- `0x1311` uses model 0689 parts 17–33. The ground pulse is `0x1312`, model 0689 group 0. Its four birth frames are 0, 7, 11, and 15. The clear pulse uses 15, 11, 7, and 3.
- The changing tiles affect the grid turn and movement probes, CPU routes and line of sight, stock shell ricochets, mine flames, and pickup cleanup. A stock shell fired too close to a wall backs out along its launch path and can hit the shooter. Shells already in flight when a wave spawns read the previous tile state on the tick it changes, following native object update order. Thrown lob bombs can pass over the platforms.
- The web map in `tankArenaMetalWalls.ts` matched 565 live free-for-all frames and 274 controlled-route frames for occupied tiles, platform height, timer state, and pulse frames. A separate replay matched the stock pilot's route and shell positions through the wall's rise and clear.

## Movement
- L6/L8 grid (0x800b9e20): no d-pad = no move. dir 0 -z,1 -x,2 +z,3 +x. At a centre ((x&0x1ff)==0x100 both) tests right,left,up,down in that order for a free neighbour tile: opposite dir flips instantly, perpendicular starts state 0x6f (hull +-0x80 x 8 f, then steps if held). Mid-tile reversal instant. Step = speed, boxes vs other tanks (dir 0 |dx|<=0x1c0,|dz-sp|<0x1c0; dir 1 |dx-sp|<0x1c1; dir 2/3 margin 0x1c0-sp), wall tile via cacb4 with half-speed look-ahead, then snap to the 0x100 grid when within half a step. Initial dir = spawn shell direction [est].
- L7 free (0x800b993c): d-pad -> target heading (0,0x200,..); hull c flips 0x800 while |diff|>0x400, then c += diff/4; step speed*sin/cos>>12, probe tile at +(sin>>4, cos>>4), tank box 0x1c1/0x1c0, pedestal clamp, and directional input blocking within 0x15e units of each moving statue on both axes.
- L5 boat (0x800b9430): left/right yaw +-speed*3/2, bank +-0x14 (clamp 200, decay 10); R1/R2 thrust v += -(speed*sin>>12)>>2, clamp +-speed, per axis decay 1, bounce at 0x100 / bound, tank bump exchanges velocity (other += v/2, me v/4) without moving.
- Q and E turn the tracked turret by 64 angle units per tick. In Jungle Fox the chassis node counter-rotates by the same amount before the driving update. Its world heading follows the arrow keys. The outer rail clamps the tank origin at 256 or the far bound and permits travel parallel to the rail. CPU aim applies one quarter of the signed error and releases when the applied step is at most three units.
- On the grid stages, reversing changes the direction of travel while preserving the direction of the treads. Selecting reverse at a tile centre uses one tick. Mid-tile reversal moves on that tick. A right-angle change turns by 128 units on each of eight updates. In the Desert trace the chassis goes from 2048 to 1024 while the turret turns through zero.
- Swamp Fox decays the old bank by 10 before adding the steering input. Nineteen held ticks reach the limit of 200. The propeller coasts by 179 angle units per tick in pack 0774 part 4. Thrust selects part 5 and advances by 679. Its native y offset is −256, and the pilot sits at +72. Tracked pilots have zero offset. The model export already converts the PS1 axes.
- In a four-human USA recording, the first Swamp Fox render update selected rotor angle 3917. Input unlocked 99 ticks later at angle 2580 and boat idle frame 3. The tracked chassis cycles through six tread words even at rest. The first unlocked tread word was `0x4304` on all three grid and free-driving captures.
- Six steering recordings matched the slot-zero position, turret yaw and chassis heading on all 992 sampled ticks. All eight compared state fields, including both velocity components, matched on 991 ticks. A simultaneous Swamp Fox boat contact left a different end-of-tick impulse on one tick. Both simulations agreed again on the next tick.
- A Chromium model replay checked all four seats against 3,048 native seat frames. It compared rendered turret headings and gun words on all four stages, tread headings and words on the tracked stages, and propeller angle and selected mesh on Swamp. Two WebRTC clients also drove Big Stein and Top G on every stage. Keyboard controls are arrows to drive, Q/E to rotate the tracked turret, Z to fire, X to lay a mine, C to taunt, and V for the Swamp Fox shield.

## Weapons [exact unless noted]
- Fire (`FUN_800b77e8`): Square edge, zero cooldown, idle gun and fewer than three registered stock shells. The double pair and lob bombs do not occupy those slots. Stock ammo stays at 999. At the default fire rate, stock and double start a 10-tick cooldown and bombs start a 60-tick cooldown. The input gate checks the old value before decrementing it.
- `FUN_800b71f8` runs after the player state callback, so the trigger tick already shows the first gun pose. Ages below count from that tick.

| Gun | L5 first fire / idle word | L6–8 first fire / idle word |
|---|---|---|
| 8 | `4180 / 4100` | `4200 / 2009` |
| 9 | `4380 / 4300` | `4180 / 2010` |
| 10 | `4080 / 4000` | `4100 / 2012` |
| 11 | `4280 / 4200` | `4280 / 2011` |
| Double | — | `200c / 200b` |
| Bomb | — | `4000 / 2008` |

- The ROM tables at `800c987c..800c99b4` and `800c9a54..800c9b60` supply 12 consecutive recoil poses for stock and bomb, and 39 copies of the double fire mesh. A zero terminator clears busy at age 12 or 39, after that tick's input gate. L5 uses the animated boat-and-gun model in pack 0774 and cycles six idle entries. The terminator writes idle pose zero and the next update reads it again from the idle table. L6–8 select gun parts or groups in pack 0784.
- Double releases both parallel shells and spends one charge at age 0. The offsets use turret yaw minus each entry of `800c93ac` (`-0x104`, `0x104`). The bomb spends one charge and emits launch FX at age 4, gun word `4004`, using the tank's position and yaw on that tick. If the last charge was spent, the terminator restores the stock gun and sets cooldown to 30. A regular weapon pickup replaces the gun and clears busy on collection, canceling any unreleased bomb.
- Jungle Fox's double shells use a dedicated callback at `800bc7d8`. Both appear at their muzzle positions on the trigger tick. They travel 200 units per update until they reach a solid tile, the arena edge, a moving statue, or another tank. They pass the firer and deal 60 damage to a rival. On impact the game creates smoke object `1306` at the attempted position and plays sound `43d` (L7 bank 0160, tone 5). The four pedestal cells had zero destructible-object pointers in the L7 match dump.
- Three four-human PCSX shots confirmed both shell paths. From (768,768), a pair hit a tank parked at z=3840 on update 13, leaving 39 HP. From (1800,768), both hit the pedestal at z=1537 on update 2. Against a tank parked at z=2400, both hit at z=2137 on update 5. The regression also exercises shots leaving the arena. In two Chromium peers, a keyboard-fired pair against the pedestal started and stopped both flight samples and played both impact samples.
- Controlled native replay executed the original MIPS fire and post-state routines from the L5–L8 RAM dumps in Unicorn. Allocation, audio and pilot animation dispatch were stubbed. Twenty cases matched the web simulation for 1,400 ticks of gun word, busy, weapon, ammo, cooldown and projectile creation. The weapon regression runs with `cd web && npx tsx scripts/test-tank-weapons.ts`. WebGL renders exercised all four stock guns and both Cortex-based custom pilots, Big Stein and Top G, including the L7 double and L8 bomb release and stock return.

- Shells (`FUN_800baffc`): w11 dmg 20 speed 74 life 90; w8 20/54/63; w10 lob 30/44/75 (vy+12, ground hop at y>-0x65); w9 20/44/135; the separate double-shot callback is documented above. Wall reflect on cacfc dominant axis, arena edge reflect, owner takes half, pickups in a 0x1ff box destroyed (0x4b8), hit box 0x10f/0x10e, shields absorb within 0xe1. L5 AI dodge: no shot if rand(32)<skill and shield ready.
- Bomb (weapon 3, 0x800bc27c): speed 125, vy -91 +12/f, direct hit box 0x181 hits all, landing hits first tank in 0x180; 60 dmg.
- Tracked tanks lay timed mines with a 120-frame cooldown and fuse. Deployment plays 0x4e9 and 0x4ec+p, the fuse ticks at 30-frame intervals with 0x4eb, and the blast plays 0x4ea. L7 applies 60 area damage. L6 and L8 launch four flames at 500 units per frame. The blast can hit the owner. Bad crates also drop timed mines on L5.
- Wumpa fruit restores 20 HP up to 99, ammo pickups add one mine or two special rounds, and a trap crate deals 30 damage on contact. The supply schedule and object traces are below.

## Swamp Fox floating mines and shields

- X drops object `131d` at the boat’s pre-drive position. Its initializer `800c7598` selects L5 pack 0695 part 0 at y = −20. The mine drifts seven units along a heading that advances four angle units per tick and bobs on the 16-value table at `800ca44c`. The disc takes its initial heading from the global frame counter. Online uses the round clock including the intro, so a console session can start a mine on a different heading.
- `800bd084` arms the mine once all boats clear its box (|dx| ≤ 400 and |dz| < 400). Re-entry by any boat triggers the mine, stops that boat and deals 60 damage. Script 16 plays at the mine’s actual height. The blast also deals 60 damage to other eligible boats within 768 units on x and 767 on z. Each player can have one floating mine out. The cooldown is 30 ticks. Deployment plays 0x50a and 0x4ec+p.
- V starts 10 ticks of protection. The human cooldown checks its previous value, so the earliest second activation is 61 ticks later. Object `1321` emits shield pulses at ages 1, 5, 10 and 15. Each pulse samples the owner’s position and plays the first four frames of script 4 from pack 0774, part 14. The pulse origin and the mine’s drift state travel in the round snapshot.
- Two four-human USA PCSX replays matched 170 stationary and 171 driving updates after synchronizing the frame-counter phase. Across both traces, 317 floating-mine positions, 64 shield samples, two direct hits, repeat drops and both cooldowns matched. A moving boat advanced 36 units per tick while each shield pulse stayed at its emission point. The focused regression also covers collateral damage, mines surviving past 120 ticks and snapshot reload. Two Chromium WebRTC matches exercised X and V with stock pilots and both custom pilots.

## AI (struct 0x800caffc + p*0x2c)
- L5 `800b4fac` turns to face a rival above 70 angle units and steers toward a waypoint above 40. Its waypoint arrival check uses only x, inclusive ±99. The independent firing gate at `800b3f44` allows signed heading errors of −99 through +99. A controlled replay executed the native controller and angle routine for 1,248 pad and timer comparisons spanning all seats, both waypoint modes, facing mode and wraparound.
- Skill by difficulty: L5 [1,16,26]; L6-8 [16,24,32] (30 when no human lives). Shoot gate `FUN_800b3f44`: rand(101) > (skill*0x55>>5)+5 -> no shot while a human lives; LOS = free tile 0x200 ahead. L6-8 per frame `FUN_800b5228`, decide `FUN_800b4a28`: target random alive enemy, rand(8): 0 idle if rand(skill+1)<13, 1 pickup seek, 2 lay mine, else approach (cd<5) or move away; wander on free neighbour tiles; mine avoidance `FUN_800b4490`. L5 `FUN_800b4fac`/`FUN_800b4688`: modes 6 face target, 4 go to pickup / one of 9 points, 7 flee, idle. Octant table 0x80051244 indexes the floor of the 12-bit angle divided by 512.

## Animation / sfx / camera
- Player states (table 0x8009dca0, enter / update): 0x69 `800ba964` / `800baab0`, 0x6a `800c7d24` / `800badb8`, 0x6b `800baf64` / `800c7d04`, 0x6c `800b8ec4` / `800c7ef8`, 0x6e `800c7db8` / `800b9e20`, 0x6f `800b906c` / `800b9170`, 0x70 `800babcc` / `800bacd4`. The 0x6e and 0x6f updates run the weapon routine, advance the pilot script (`8008502c`) and call `800b6ed8` when it ends: a CPU adds one to its counter and taunts at 80 (drawing rand(30)), otherwise idle 0x59 restarts. Entering 0x6e restarts idle; entering 0x6f also plays 0x4fd + seat. Hit recovery returns to the previous state through its enter callback, so a hit mid-turn resumes the turn.
- Clips (`FUN_800854c0`): 0x57 hit, 0x58 wreck, 0x59 idle, 0x5a taunt, 0x5b mine, 0x5d fire (`800b77e8` switches on rand(4) for cases 5-7, so 0x5e/0x5f never play but the draw happens). View roles: idle / hit (0x69, 0x6a). Camera: fixed per level (see CAMS in the view), unchanged [est].
- `FUN_80027f7c(p,10,0xf0)` on a hit is pad vibration (human pads only), not a voice. Human taunt (ovl ~0x800b8da0): Triangle held (0x80051388 & 0x1000), cooldown +0x800cadd8 < 1, state 0x6c / 0x6e / 0x6f -> cooldown 0x5a, clip 0x5a, taunt voice; ported as input `c` (keyboard C, gamepad Y). CPU taunt: `FUN_800b6ed8` runs whenever a pilot script ends in states 0x6e/0x6f (and once from the setup's 0x6c enter). It counts per CPU (+0x800cadcc, seeded rand(30) at setup) and taunts at 80. The idle script lasts 19-20 ticks, which matches the emulator's roughly one count per second once hits, turns and actions are included. Setup draws rand(0x96) for the 0x8009d57a timer before seeding the counter. Taunt voice = 0x800c94a8[char-1] = block*0x32 + 2 (Tank Wars banks 0182-0189), played on the taunt event.

## Loops, wake and level cues

- `800b6c24` (player post-state hook) keeps two looping channels per seat. On L6-L8 the tread loop 0x4c2 + seat runs while the tank moved this tick and the turret loop 0x4be + seat runs until one tick after a manual L1/R1 turn (countdown 0x800cad94 = 2). On L5 the thrust loop 0x50b + seat runs while R1 is held. `800b5fc4` silences a tank with no health. The Swamp Fox setup starts the 0x50f ambience loop without a handle.
- `800b6658` creates object 0x1320 per boat on L5: pack 0774 part 6 (additive) on the water, copying the boat's position and heading, deleted when the health mirror reaches zero.
- `800b96f4` queues the boat bump cue; the next level frame plays 0x4b9 at that boat and holds the cue for 60 ticks. A Metal Fox platform that starts to sink sets a two-frame countdown, then the level frame plays 0x501.
- Bomb `800bc27c`: direct hit if |dx| < 0x181 and |dz| < 0x180 (owner excluded), damaging every tank in the 0x181 box. Otherwise it lands when vy > 0 and y >= -0x103, snaps to y = -0x104 and damages the first tank in the box, owner included. Script 1 plays at the bomb's height. There is no arena bound.
- No Tank Wars routine moves the camera, so the view has no shakes.

## Not code-exact / left
- AI branches simplified in L5 mode choice; `params.bounces` ignored; options 0x40/0x80 not ported; full emulator side-by-side gameplay comparison pending.
- `bot()` (web/shared/games/tankArena.ts) now returns the CPU AI input for a vacated human seat: it runs `aiFrame` for that slot and sets `t.bot = d.f + 1`, so `step()` applies the AI output that frame. Real CPU slots still run the AI inside `step()`.

In individual versus, Desert and Metal Fox call `800b3c7c` to start a four-seat scan at a random seat. A living human within 999 units on either axis qualifies immediately. A CPU also needs a 256-way draw above 210. When the scan finds no preferred rival, all surviving rivals have weight 16. Jungle and Swamp Fox call `800b3b24` directly and use those weights without the lane scan. The three land arenas use the integer angle lookup to aim. `800b3f44` probes 512 units along the next quarter-turn toward the target. Its flat collision array includes empty end padding and can wrap a horizontal probe into the adjoining row.

Land drivers scan eight mine slots in rotation and can keep watching one mine until it disappears. The retreat starts on the radial octant and can add a perpendicular direction based on map clearance and distance from the edge. The pickup route reads three slots in order and tests `abs(dx) + (driver.z - item.z) < 1536`. Swamp boats use the same pickup test for waypoints. Their retreat uses the average origin of all three rivals, including knockout positions.

The full `800b5228` callback matched 1,600 controlled USA comparisons per arena (6,400 total), covering target, submitted buttons, aim, route timer, waypoints, watched mine and random draw consumption. Each native invocation received the web random stream and matched starting state. The earlier isolated target-selector comparison did not exercise the stage dispatch. Whole-match Tank Wars random timing and CPU behavior remain unverified.

## Stock shell contacts and trap crates in USA versus

Each stock gun calls `800baffc` with its own impact script. A hit plays the hit sound, applies damage, and emits the burst at the shell's final coordinates and height. A nonlethal hit does not run the wreck script. The host sends the muzzle flash, trail and impact events so a guest can see a shot's effects even when its snapshots in flight are lost. Trail cadence uses the round clock. The first trail can differ in phase from the disc's global clock.

| Weapon | Ricochet sound range | End sound | Burst script |
|---|---|---|---|
| 8 | `4e1–4e3` | `4e4` | 12 |
| 9 | `4db–4dd` | `4e6` | 13 |
| 10 | `4de–4e0` | `4e5` | 11 |
| 11 | `4d8–4da` | `4e7` | 10 |

When a ricochet and a hit or expiry coincide, only weapon 11 also plays the ricochet sound. New shots back out of an obstructed muzzle on all four stages. The tile collision chooses its axis from the previous position. Lob ground effects and weapon 8's trail use the position before the horizontal step. PCSX showed weapon 8's smoke object advancing through words `2019–2021` for nine ticks. Swamp creates the object but leaves its mesh bank unloaded.

The original MIPS callbacks and the shared simulation agreed in 176 controlled cases on the final position, velocity, retirement, effect locations, damage, and sound families. The comparison fixed the native random selection within each sound family. In a two-client Desert Fox match, deliberately losing all thirteen snapshots containing the shot still delivered its muzzle, both trails and one impact at the same positions on both clients.

Trap crate type 6 in `800be988` deals 30 damage when caught in free-for-all. It emits a smoke object and crate-break script 3 at the crate height. If the crate's downward step takes its raw y from −319 to −299, landing takes precedence over contact. It spawns an unowned mine at y = −20. Initializer `800c7614` gives it a 120-tick fuse. On the tracked stages, mine mesh words `2005` through `2002` show the remaining fuse. The final second uses `2002`. The simulation matched 48 native catch and landing cases and 480 fuse updates. Chromium checked the visible mine part for all 120 frames on Desert, Jungle and Metal Fox.

## Effects (decoded)
Pack 0786 (db 0x8005365c, 19 scripts); 0784 (db 0x80053694, levels 6-8) parts 24-32 = smoke puff object 0x1306 (9 frames, node flag 0x21).
| weapon | shell object | muzzle (at the shell start, tank yaw, nodes flagged 0x20000000) | in flight | end (`FUN_800baffc` arg) |
|---|---|---|---|---|
| 11 | 0x130c | script 7 | - | script 10 |
| 8 | 0x130d | script 8 | script 2 every 8 frames | script 12 + 0x1306 |
| 9 | 0x130f | script 15 | - | script 13 + 0x1306 |
| 10 lob | 0x130e | script 6 | ground hop: script 9 (level 5: script 18 + splash sfx) | script 11 + 0x1306 |
| 2 double | 0x1302 | - | script 17 every 2 frames | 0x1306 (level script 0 only for a registered destructible tile, absent on the four USA versus pedestals) |
- The stock shots have individual model nodes in pack 0786. Weapon 11 draws parts 32 and 34 with a spinning billboard. Weapon 8 rolls part 46 by 150 angle units per update. Weapon 10 pitches part 21 by 85 while following its arc. Weapon 9 spins the glow in part 55 and two instances of part 47, one with its own rotation. The double pair uses pack 0784 part 6. The trigger frame places shells at the muzzle before their first flight update.
- The Swamp Fox callback at `800c7c08` multiplies each rounded stock horizontal velocity component by 3/2 and the lifetime by 2/3, truncating toward zero. With a stationary boat facing 2048, weapon 11 moved 111 units per tick in Swamp and 74 in Desert, Jungle and Metal. Chromium matched positions, visible mesh parts and body rotations for 121 shell samples across these four stages and all five projectile models.
- Bomb: script 0 at the tank on throw-clip frame 4 (`FUN_800b71f8`, object 0x130b); it lands in script 1 (`FUN_800bc27c`).
- Mine blasts use script 16. A supply crate landing on Desert or Jungle Fox plays script 3. Collecting a regular item plays its pickup sound. Trap contact and an item crushed in a blocked tile use the break effect.
- Wreck: script 14 + sfx 0x4f0 when the dying list ends. Read in `FUN_800c5620` (the level-9 boss tanks); assumed the same for players.
- `FUN_800bf548`: a shell touching one of the 3 pickups (slots 0x800cad44, box +-0xff on x/y/z) destroys it: script 16 + sfx 0x4b8 (ported: sim event `pkhit`). Shooting, wall bounces and laying a mine are sound only.

## Supply drops in individual versus

The USA recordings on L6–L8 showed supply controller `1309` at timer 140 on GO. The first wave starts on play tick 141. Later waves start one tick after the reset timer reaches zero (181–300 ticks apart). The L5 stage has no supply controller in its loaded objects, and its 657-frame opening capture contained no drones or pickups.

- Desert and Jungle start the drone at x = 6144, y = −1024. It crosses at −64 units per tick, leaves at −2112, and the next flight goes the other way. The rotor plays pack 0784 group 1 in reverse order. Each flight can release one crate. The crate starts at y = −1224, 200 units above the drone, and 60 units farther along z. It falls 20 units per tick and opens on update 47. The shadow moves opposite the crate’s roll and grows as it approaches the floor. At verdict the drone rises by 50 units per tick.
- Metal Fox checks each empty slot in a three-item registry. One wave can place several pickups. It stops the wave if the chosen position is occupied by a tank or matches the first registered pickup. The disc can therefore place two items in the same square. A shot tests slots in order and breaks the first item it hits. New items appear at y = 0 with their own mesh. On the next update they enter the bouncing state.
- The double shot uses pack 0784 part 6 and rotates 40 angle units per tick. The bomb uses 0786 part 11, fruit cycles 0736 parts 23–36, and mine ammo uses 0784 part 18. Crate and item shadows use their own disc meshes, scale and heading. Native sound IDs `4b0–4b3` announce spawns. IDs `4b4–4b7` announce airborne landings on Desert and Jungle. The Metal Fox bank has no mapping for the landing IDs.
- With corresponding random decisions, the web sim matched 557 consecutive play ticks on each of L5, L6 and L7. A separate controlled MIPS replay of `800bdc50` matched the web for 800 Metal Fox seed and registry combinations. A Chromium render replay compared 1,793 recorded pickup poses and shadows across L6–L8, including descent, opening, fruit animation and double-shot rotation. Full matches still draw randomness independently of a console session.
- Two WebRTC clients playing Big Stein and Top G agreed on supply positions and collection in Desert, Jungle and Metal Fox. Both clients played the stage's decoded supply sounds at the expected pitch.

## Jungle Fox statues in individual versus

- Controller `131a` starts both statues stacked at (2048, 2048). Object `131b` starts 660 units above the floor, `131c` starts 330 units above it. The controller releases them after 900 and 1,200 arena updates when both landing zones stay clear. It checks live tanks within 512 units of (1424, 1024), then (2624, 1088), and retries on the next tick if blocked. The second delay starts when the first statue actually launches.
- Both use model 0776. Callback `800c0f24` drives the launch, bounces, a 16-waypoint patrol, and the slam. A hard landing or the slam's script marker triggers effect 0 at the **previous** x/z, with a raw y of 300. Tanks within 768 units on both axes take 60 base damage. Adjacent tanks block the statue's horizontal step. The statue can crush an item, absorb a stock shell or double shot, and restrict steering into its footprint even while airborne.
- Live poses in order are `4180–419b` (start), `4080–4092` (travel), `4200–420d` (brake), `4000–401b` (slam) and `2004` (rest). The slam marker occurs before pose `4011`. Sounds `504–507` use bank 0160 samples 7–10. Client playback fills animation ticks between snapshots and advances a private copy during results.
- One four-human USA recording matched the web simulation for both statues on 2,700 consecutive frames from GO, including 18 shockwaves. A second replay held tanks in each launch zone. Release was delayed to arena ages 931 and 1,261, and the simulations matched all 1,421 frames from GO, including eight shockwaves and player health. Chromium checked 5,400 rendered poses on a three-tick snapshot interval. These captures used individual versus rules. The alternate stationary turret in the disc's `0x80` rules uses different scripts.
- Firing into a resting statue from (932, 1350) matched the native stock-shell hit at (932, 580) and double-shot hits at (777, 582) and (1088, 582). Two WebRTC clients playing Big Stein and Top G agreed on 277 snapshots across a blocked launch, release and slam. Both rendered all 90 observed pose words and played the four stage cues at their bank pitches.

## Versus winner

The versus winner enters pilot script `0x5a` at ground height (`FUN_800babcc`). Each result update adds `0x15` to the pilot yaw and subtracts `0x15` from the nested chassis yaw outside Swamp Fox (`FUN_800bacd4`). The web view advances both turns at 30 Hz after the terminal snapshot. A tank still in its hit/death sequence completes that sequence before being hidden.
