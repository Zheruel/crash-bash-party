# Crash Dash (levels 23 Dot, 24 Toxic, 25 Splash, 26 Dante) — decompile facts
Overlay `0723.t63.bin` @0x800b32b4; decompile `re/out_crashDash/ovl.c` (+ `all.c` for engine). 30 Hz logic. Units 1024 = 1 model unit;
world x = x_g*3.4/1024, world z = -z_g*3.4/1024. Yaw 0..0xFFF; world face = -yaw*2pi/4096. Valid live dump: `re/dumps/L23.ram` (Dot only).
Structs per player p: obj `PTR_DAT_8009d530[p*27]` (pos +0x10,+0x14(y),+0x18), sub-engine S = obj+0x58, input obj544 `PTR_DAT_8009d544[p*27]`.

## Input (FUN_800b8fd8 / 800b980c / 800b48ec)
Pad 0x80 left, 0x20 right, 0x800 R1 run, 0x8000 square boost, 0x2000 circle / 0x200 R2 use item, 0x4000 cross Splash hop.
AI (DAT_8005a670[p]!=0): FUN_800b5360 -> 800b4edc writes pad; always 0x8000|0x800, steers by look-ahead tests.
- tgtYaw(obj544+0x14) -= S+0x160 on left, += on right (every frame). yaw += (tgt-yaw)>>2 (FUN_800b48ec).
- Target velocity = speed*(T(yaw+0x400), T(yaw+0x800))>>12 ; per-axis ramp to target<<8: accel when target!=0 else decel; |v|<=0xc800; pos += v>>8.
- Defaults (data 0x800c66cc): runAccel 768 (S+0x15c), boostAccel 2048 (+0x158), decel 160 (+0x150), run speed 80 (+0x14c), boost speed 160 (+0x154), turn 128 (+0x160), restitution 0x100.
- Splash (FUN_800b8f04): accel 600, boostAccel 1600, decel 125, run 62, boost 125, turn 100.
- AI accel (skill>=0x17) from DAT_800c6be4 [384,414,444,474,504,584,634,684,734,784,896]; fuel refund DAT_800c6c10 [0,25,..,225,256].
- Boost: square + fuel(S+0x58)>0. Fuel -0x180/frame (not in state 0x61), clamp 0 -> run. Max 0x10000, start 0. Fruit +0x2000.

## Level / world
- Fall: Toxic r>3072, Dante r>3328 (r = |pos| game units, origin hub). Dot/Splash: FUN_800b7190(pos,aux,200,1,0) group-1 segments.
  Wall step radius 0xdc=220; push (0x3702-d)*n>>18 (FUN_800b6dbc). Convex test: ((x-x0)T(-a)>>12)-((z-z0)T(-a-0x400)>>12)>=0.
- Dot start (0x8005b2b8): (963,-8,560) (1463,8,248) (1835,5,-120) (2336,19,-455), yaw 0 (facing -z_g).
- Laps: FUN_800c0218. Line z_g=-493 for x>0, crossed toward -z_g. S+0x30 +/-1 clamp; first fwd crossing sets S+0x148=1 (no lap); later crossings S+0x34++, sfx 0x656+p. 10 laps. Remaining laps at DAT_8009d57c+p*0x6c.
- Race end FUN_800bd99c: individual = fewest laps remaining wins. Equal leaders at timeout draw. The first tenth lap processed in the engine's shuffled player order calls the result immediately. Team = laps*0x1000 + progress (0x152c-atan2(x,z))&0xfff.
- Individual versus starts at 1:30. The shared HUD routine at `8007b8d4` handles the BCD clock. On Dot the draw flag was set on play tick 2,699.

## Pickups (FUN_800c04ec fruit, FUN_800c0cb4 crates)
16 slots at angle slot*0x100, radius fruit 2200 (Splash 1500), crates 2200+rand(100). Random free slot probe from rand(16). Slot 2 initially occupied.
Spawners start when DAT_800c6bb0 (60) < 0; DAT_800c692c = frame.
- Fruit (obj 0x1702): cooldown 30 frames only decrements while fruitCount+cap != 6; cap 3 (f1..900), 2 (901..1800), 1 after => target 3,4,5 fruits.
- Crates (type 0; type 5 on Toxic): cooldown 30; on-track + held items target 2 (f<=1800), then 3. Not on Splash.
- Collect FUN_800bfd84: dist^2<0x24000 (r384), |dy|<0x200, lowest p wins; a shielded first contact consumes the pickup without an award or slot release.
  fruit: fuel+0x2000, sfx 0x1c2. crate0 -> item 1 sfx 0x51f. crate5 -> item 0x20 (shield) sfx 0x439.
- Use item FUN_800bc984 (0x2200): item1 -> missile 0x1701 (FUN_800c5154); 0x20 shield (0x1708, S+0x130=1, see Decoded). (Earlier guess of 900 frames / 0x1ffc was wrong.)
- Missile 0x1701 (FUN_800bf2b8, sfx 0x522; handler 800bf460): spawns 128 u above the kart, then travels straight at 140 u/frame on the kart's launch plane. Hit (800bf0f8): other kart outside state 0x61, d^2<0x24000, |dy|<=0x180 -> victim 0x5d, explode sfx 0x43d. FUN_800b7190 checks groups 0 and 2 on Dot, group 0 on Dante, radius 150. Three reflections or leaving radius 3840 ends the shot. Trail every 3 frames at the previous missile position.
- Kart-kart (FUN_800bebc0): |dy|<0x181, d<0x180: push (0x188-d), exchange (800be914, equal mass, e=1, clamp boost speed). Bump sfx 0x640..0x643 (Splash 0x675..0x678) if speed^2>0x62e08 (Splash 0x10d2a4). Slower kart (v^2<half) when half-speed^2>810000 -> I am stunned 0x5d sfx 0x654.

## States (table 0x8009dca0)
0x5b drive (engine sfx run 0x644+p anim 0x48/0x49, boost 0x648+p anim 0x49 hmm; exhaust 0x1709 run /3f, 0x170a boost /4f)
0x5c square hop 21f; 0x5d hit: see Decoded below; 0x5e Splash cross-jump vy -0x44 g 5/10;
0x60 spin 45f + 16 stop; 0x61 fall: see Decoded below; 0x62 finished.
Anim calls FUN_800854c0(p,id): 0x48 idle, 0x49 run/boost, 0x4a, 0x4b fall, 0x52-0x54 Splash.

## Hazards
- Toxic (800b5f04/6474/6108): barrels (model 0x5006): contact r384 -> kart 0x5d, sfx 0x663/0x664; barrel stays hidden until round reset. Monster 0x170b at (0,0xc4,0) sfx 0x42e (handler 800c2e10 unread). Crates are shields.
- Splash (800b5d14/5a70, patterns 0x800c6b70): 6 spokes (model 0x4000) turn +4 angle units per update for patterns 1 and 2, and −4 for the others. Pattern rand(0..4) each 180f: P0 delays 10,20,29,40,50,60 hold 10; P1,2 spoke0 hold 120; P3,4 spokes 0&3 hold 120; peak height 17..28, +2/f. sfx 0x672 start, 0x673 rise, 0x674 fall. Splash AI edge r^2>0x640000.
- Dante: lava; objs 0x1707/0x170e (handlers 800c2388/800c3f68 unread); fall r>3328.
- Dot: pits/off-track via 800b7190 groups 0,3.

## AI tables (shorts; FUN_80086918 -> DAT_8009d87c[p*3+{0,1,2}] skill,?,weight)
Dot 0x800c63fc [4,1,1,1,10,26,20,16,16,28], 0x800c6410 [6,3,1,1,14,28,22,5,5,30], 0x800c6424/30/48 (16), 0x800c645c (32). Toxic 0x800c64b0/c4. Dante 0x800c6564/78. Splash 0x800c6618/2c.

## sfx banks (FUN_80022660 id -> 0x80064508 -> VAB tone): Dot 0175, Toxic 0174, Splash 0173, Dante 0172.
Ids: 0x644-47 run, 0x648-4b boost, 0x64c-4f wall, 0x650-53 fall voice, 0x654 bonk, 0x655 fall splash, 0x656-59 lap, 0x65e-60 missile bounce, 0x663/64 barrel, 0x640-43 bump, 0x1c2 fruit, 0x51f crate, 0x439 shield, 0x43a shield on, 0x466 shield pop, 0x522 fire, 0x43d explode, 0x672-74 Splash spokes, 0x679-84 Splash voices.

## Decoded (second pass; ported in web/shared/games/dashRace.ts)
Trig table T(a) = cos(a)*4096 (sin a = T(a-0x400)); kart forward = (-sin yaw, -cos yaw); FUN_80032490(x)>>6 = isqrt(x); FUN_80015590(n) = rand 0..n-1;
FUN_8001463c(x,z) = angle a with (sin a, cos a) along (x,z); FUN_800154a0 = signed 12-bit difference. Ground (kart origin) y = DAT_800c6930 = -256, y grows downward.

### Drive (FUN_800b8fd8 input, FUN_800b980c move, FUN_800b48ec yaw)
- Every frame: targets (+0x24/+0x44) reset to 0. Skipped when state is 0x60; in 0x5d / 0x61 (DAT_8009d576 = 2) the input block and yaw smoothing are off.
- Left (0x80) / right (0x20): tgtYaw -= / += S+0x160 each frame, regardless of run (both = cancel).
- Boost: pad 0x8000 and fuel S+0x58 > 0: accel S+0x158, target speed S+0x154 along forward (T(yaw+0x400)*sp>>12, T(yaw+0x800)*sp>>12); fuel -= 0x180 (AI with skill >= 0x17 gets table 0x800c6c10[skill-0x16] back); fuel < 0 -> 0 and boost off that frame.
- Run (R1 0x800, not boosting): accel S+0x15c, speed S+0x14c. AI only: accel = 768 + (skill-16)*64 (min 0x200) when skill < 0x16, else 768 + table 0x800c6be4[skill-0x16] ([384,414,444,474,504,584,634,684,734,784,896]). Splash AI also uses 768 (not 600).
- Velocity (S+0x13c/0x140, <<8 units): per axis toward target<<8, step = accel if target != 0 else decel (S+0x150), no overshoot, clamp +-0xc800; pos += v>>8. yaw += (tgt-yaw)>>2 at the end of the frame (uses the old yaw for the targets).
- Wall (FUN_800b6dbc, radius 220, called before and after the move): after the move, if a wall was touched with normal angle n: h = atan2(v>>8); d = (h-n)&0xfff; u = d < 0x801 ? n+0x338 : n-0x338; |v| = isqrt(vx^2+vz^2)*200>>8 (78%); v = |v|*(sin u, cos u); tgtYaw = u+0x800. Wall sfx 0x64c+rand(4) if 0x600 < d < 0xa00.
- Fall trigger (post-wall position, not when flags&0x200): Toxic r^2 > 0x900000 (3072), Dante r^2 > 0xa90000 (3328), Dot and Splash test within 200 units of a forward-facing segment in collision group 1. The sim uses the courses’ recorded segments and each active wall mesh’s triangles and normals.
- Splash spokes: if FUN_800b82fc(spoke, pos, 0, &pos) == 4 (the -z face of the spoke box) and that spoke's state (DAT_800ca560 + i*0x1c) == 1 (rising): v = 0x6000 * unit(pushedPos - prevPos) (a kick at speed 96). Model 0641 group 0 gives a collision descriptor per frame. The box has half-width 176, a fixed back at -778 and a tip extending from -945 to -2295. Object Y is -151. Five origins are at X/Z (0,0) and the sixth is at (106,9). The player and AI use the same oriented boxes.

### Hit 0x5d (enter FUN_800bba04, per frame FUN_800bc0a4)
Enter: counter S+0xc = 60, vy = -160, gravity +10 while vy < 0 else +20. No speed cut (pad zeroed -> only decel 160/frame). Per frame: vy += g (g chosen by the old vy), y += vy; if vy > 0 and y > ground: y = ground, roll halves, yaw += 0x100 (EVERY frame after the first landing, ~frame 27 on: ~36 spin steps); else roll += 0x80. Then c = counter--; if c < 0 -> state 0x5b (62 calls). Yaw is not smoothed meanwhile.
Sources: missile FUN_800bf0f8 (not owner, not 0x61, |dy| <= 0x180, d^2 < 0x24000), barrels, blobs, rocks, kart-kart. NO shield immunity anywhere (the old port had one).

### Fall 0x61 (enter FUN_800bad54, per frame FUN_800bafc8)
Enter: S+0x54 = atan2(x,z), item (S+0x18) cleared, anim 0x4b (Splash 0x54). Phase 0: velocity zeroed while the clip runs (character scripts in re/dumps/L23.ram, identical for all 8 characters: clip 0x4b = 24 frames, Splash clip 0x54 = 32 frames; transition on the 24th / 32nd handler call). Phase 1 entry: pos -= 512 toward the origin (T(S54-0x400)>>3, T(S54)>>3), y = -1400 (1144 above ground), sfx 0x655, effect 0x1605 (type 9; Splash 5). Phase 1 per frame: yaw = tgt = (S54-0x200) as signed 12 bit; FUN_800c467c: vy += 0x300, y += vy>>8; when y > ground: y = ground, vy = -(vy*100>>8) (bounce); landing counter S+0x88++; second landing -> 0x5b. (First landing after 28 frames, second ~22 later.)

### Shield (item 0x20, Toxic crates; FUN_800bc984 -> 0x1708, FUN_800c1cfc)
Sets S+0x130 = 1 (blocks pickup collection). The object starts its ring and sound on the update after use. On the next 15 updates it selects the first other kart within 900 units of its moving owner. The impulse points away from the fixed launch position and uses the native angle and trig tables. The last push clears the shield flag.

### Bot AI (FUN_800b4708 per frame; skill = table d900[difficulty]: Dot 1/11/22, Toxic 1/10/20, Splash 1/10/20, Dante 1/11/22)
1. pad = 0. Nearest pickup (FUN_800c5c64); if d^2 < 0x271000 and kart polar angle < pickup polar angle -> chase (FUN_800b5528): diff = sext12(atan2(me-pickup) - yaw); > 500 -> right (clear left), < -500 -> left (clear right); run only (no boost bit).
2. Else FUN_800b5360: pad |= 0x8000|0x800 (ALWAYS run + boost; the boost clears inside 4edc are re-ORed) plus FUN_800b4edc: near probe starts at 512 units and grows by 384 per 80 units above the speed threshold of 80 (speed from shifted Q8 products and the Q6 square root). Inside every group-0 edge plane -> left; far probe = pos + 1936*forward: Dot not inside group-3 polygon (outer wall) / Toxic r^2 > 0x510000 / Splash, Dante r^2 > 0x640000 -> right. Both can be set (cancel).
3. Not Dot: FUN_800b442c kart avoidance: others with sext12(polar(other)-polar(me)) > 99 and on the forward ray (1524 long, circle r 0x180; the game feeds FUN_800b3e60 the backward vector but its quadratic solves for the mirrored circle, so it is a forward test) -> if other r^2 < 0x310001 left (clear right) else right (clear left).
4. Non-Splash FUN_800b41dc: item 1 (missile): random weighted target (FUN_800b35cc: one rand(0x1000) threshold, equal weights = 1/3 per call, 3 calls a frame), ahead (> 99) and on the 2048 ray -> circle 0x2000. Toxic FUN_800b406c: item 0x20 -> use when the picked kart is within 768.
5. Splash FUN_800b372c: hop (0x4000) when a spoke is within 256 of the point 64 ahead (not on its -z side).
6. Toxic only: FUN_800b3890 nearest live barrel ahead (polar compare after -0x400) on the 4096 forward ray -> barrel r^2 < 0x400000 ? left : right, boost off; FUN_800b3bc0 same for the nearest blob (blob r^2 < my r^2 ? left : right).

### Toxic (FUN_800b5f04 barrels, FUN_800c4774/2e10 monster, FUN_800c3738/3934 blobs)
- 11 barrels (array 0x800c6f88, positions read from the emulator): (-1577,2173) (-1142,2253) (1529,2189) (1158,2446) (-2493,-719) (-2155,-1053) (-2173,-1572) (-2618,-230) (-2618,236) (-321,-2639) (-257,-1428). Contact d^2 < 0x24000: kart pushed to 384, FUN_800be7b4 exchanges velocity at kart/barrel masses 256/128. Kart enters 0x5d unless already falling or hit. The destroyed barrel stores 180+rand(60) in state 0 and stays hidden for the round. Measured on the emulator (medium CPU, 18 s): 9 barrel hits, CPUs 3-4 hit entries each.
- Monster 0x170b at (0,0xc4,0) starts hidden with timer rand(90)+240. Once the old timer is negative and the race is live, the next hidden delay is set to rand(150)+450. The USA versus capture measured 111 updates rising, 43 attacking and 32 sinking. Attack update 22 plays sound 0x668 and spawns three blobs and level effect script 10 at (-512,-668,-512). The script's emitter consumes 16 RNG draws on each of the next three updates as it fills its 12 slots.
- Blobs 0x170d launch at speed 64 with gravity 16 towards (T(a+0x600)*7>>4, 0, T(a+0xa00)*7>>4), where a = -0x200*k and k cycles through 0, 1 and 2. FUN_8008c5c4 uses the Q6 square root and FUN_8001463c heading. The three blobs reach Y=0 after 17, 22 and 31 movement updates. A landed or crawling blob touching a kart within 256 units in X/Z enters the kart's hit state and removes the blob. This also applies to a falling kart. After 92 calls on the ground, the blob consumes rand(4096) and starts crawling. Its next update replaces that heading with a tangent to the hub. It turns in quarter steps towards the tangent until the polar angle wraps into [0xc00,0xfff], then moves along +Z at 32 units per update until r² exceeds 0x790000.

### Splash (FUN_800b5d14 / 800b5a70, patterns 0x800c6b70)
Spokes are model 0x4000 objects with initial yaw i*0x2aa; every frame yaw -= 4 (+= 4 when the current pattern index is 1 or 2). Start wait 180 frames, then pattern index = rand(5) (6 rands at setup), each pattern runs 180 calls (pattern 5 = race over, 1800, all retract). Per spoke [hold, delay]: P0 [10,10] [10,20] [10,29] [10,40] [10,50] [10,60]; P1/P2 spoke 0 [120,0]; P3/P4 spokes 0 and 3 [120,0]; others -1 (unused). At each pattern end: extension max = rand(12)+17 (first pattern uses 17), all spokes un-started. A spoke starts when its counter reaches the delay: state 1 rise ext += 2 until > max -> state 3 hold (counter > hold, i.e. hold+2 frames) -> state 2 fall ext -= 2 -> 0 -> idle. Model param +0x74 = ext + 0x4000. sfx 0x673 on start, 0x674 on fall.

### Dante volcano (0x1707 init FUN_800c2284 / update FUN_800c2388; 0x170e = alternate, option 0x80, not ported)
The first eruption waits 450 updates and rumbles at 60. At launch `u = rand(0x1000)`. Each rock takes speed `12 - rand(3)`, a target 600 units from the crater at angle `u`, then advances `u` by `0x555 + rand(0x200)`. `FUN_8008c5c4` uses the PS1 square root and heading table to set planar velocity and starting vertical velocity. The rock bounces at Y = −256 inside radius 768 and snaps each nonzero planar velocity component to ±20. Outside this radius it bounces at Y = −128. The radial checks use the pre-move position and remove the rock beyond radius 3072.

Each mesh starts with a trail timer of zero and retains its timer and roll across eruptions. On a flight update with a negative timer before decrement, the stage attempts to emit script 3 and resets the timer to `8 + rand(3)`. The first three smoke puffs advance the shared RNG on stage update 454. Each rock tests all four seats for three-dimensional distance squared below 160,000. It can put a falling driver into hit state `0x5d`. Contact hides the rock and resets its Y to zero before the next seat test. When the next rock pass sees all three hidden, the post-decrement countdown resumes from 20, followed by the 300-update wait. The rolling ball `0x170c` is never called.

## Start slots (table 0x8005b2b8, read from the emulator after the level cheat; yaw 0)
Dot (963,560) (1463,248) (1835,-120) (2336,-455); Toxic (1020,1000) (1520,687) (1892,318) (2406,-28); Splash (931,1053) (1430,740) (1803,371) (2304,37); Dante (950,900) (1450,588) (1822,219) (2323,-115).

## Estimated / not decoded (flag if the emulator disagrees)
- Controls mapping (stick x = L/R, up = R1 run, a = Square boost, b = Circle item / Splash hop); the 0x5c square hop is dead code (its entry test `FUN_800c55a4`, square press -> 0x5c, is referenced nowhere: no pointer to it in the L23 RAM), so there is nothing to port.
- The generated course polygons include hub group 0 and the Dot/Splash perimeter. Model 0641 supplies all 30 spoke tip positions.
- Toxic monster rise visual (mon 0..1 over 60 frames) and anim frame counts (+-1), blob/rock visual heights.
- Each CPU uses the selected course difficulty, including the acceleration table.

## Course sound banks

The level loader fills the tone lookup at `0x80064508` from the active course’s VAB. Dot uses 0175, Toxic 0174, Splash 0173 and Dante 0172. The per-course bindings in `web/client/games/dashRaceSfx.ts` resolve the VAG sample through the audio manifest. Identical samples can live under another bank’s directory. Each tone uses its own playback pitch.

The four kart impacts are `0x640–643` on road courses and `0x675–678` on water. A hard hit also requests `0x654`. Toxic’s barrel and shield, Splash’s spokes, hops and pilot reactions, and Dante’s rumble and rock breaks use their own stage tones. Original drivers use the level’s pilot cue on water and their four shared hurt takes on land. Custom drivers resolve their own recorded cues from the seat’s roster identity.

## Effects (decoded)
Packs: 0760 (db 0x80054f84), 0403 (0x800546c4); level models 0643 Dot / 0639 Toxic / 0641 Splash / 0637 Dante carry the level scripts.
- Exhaust (`FUN_800ba278`): 200 u behind the kart at kart height (-256). Boosting: object 0x170a every 5 frames = 0760 parts 40-55 (16 frames);
  running (R1): 0x1709 every 7 frames = 0403 parts 26 (3 ticks), 28-41, node flag 0x21; Splash: 0x1711 = 0760 parts 56-71.
  (0x170f / 0x1710, green puffs 0760 parts 24-39 / 0-15, belong to a Toxic special mode; not ported.)
- Missile 0x1701 (`FUN_800bf460`): 0760 script 0 every 3 frames as trail; script 1 + sfx 0x43d where it ends. Firing is sound only.
- Fall (`FUN_800bafc8`): when the clip ends the kart is put back 1400 u up with level script 9 (Splash: 5) + sfx 0x655.
- Shield 0x1708: level script 8 (ring closing over 15 frames). Toxic barrel hit: 0760 script 1 at (x, -210, z); barrel respawn: level script 9.
- Toxic monster: level script 10 at (-512, -668, -512) on attack frame 22. Dante volcano (`FUN_800c2388`): script 4 at the crater on launch,
  script 10 looping on each rock, script 3 every 10–12 updates after its first puff, and script 1 where a rock ends.
- Nothing for boost start, pickups, kart bumps, hops, laps or the finish. TNT 0x1703 (0796 script 1) and lightning 0x1706 (0403 script 0) belong to pickup types 1, 2 and 4, which the versus spawner (`FUN_800c04ec`: types 3, 5, 0 only) never makes.

## Objects (verified from the overlay)
- Pickup object 0x1702 (`FUN_800bfc38` init: pack 0760; update `FUN_800bfd84`): type 0 crate = 0x2011 (0760 part16, the missile model),
  type 5 Toxic shield = 0x2017 (part22, pink star), type 3 fruit = 0x2049 + (k % 14) flip-book, type 1 = 0796 0x2009 at scale 0xc00,
  type 2 = level part4. Yaw += 0x80 per frame. Wumpa advances one part each tick. FUN_800c467c launches and bounces the pickup at Y=0 with initial 8.8 vy=-0x2000, gravity +0x200, and velocity reversal. Splash leaves the fruit at Y=0.
- Splash spokes: anim id 0x4000 + ext = clip 0 of the level model 0641's animated part24 (30-frame morph), posed at frame ext. The arm
  reaches along the model's -z from the hub (z +573 .. -2294 u), so at yaw a it points (-sin a, -cos a) in game space; the sim's
  collision arm follows that.

- Splash start line (object 0x5002, part extra_57e4) sits at y +79 (under the floor); the PS1 ordering table draws it over the floor anyway. The port lifts it to floor level and draws it as a decal. Spoke rotation sense checked on the emulator (pattern 1 turns clockwise seen from above, same as the port).

## Individual versus result and moving objects (USA PCSX)

- The finishing decision comes from `FUN_800c0218 → FUN_800bd99c`. The winner gets flag 0x200 and the losers get 0x8400. The losers and their shadows disappear on the decision tick. A timeout draw gives all four flag 0x100, and they keep their current states and poses under the tie overlay.
- `FUN_800c5400 → FUN_800bcdac` enters 0x62, stops the winner and starts script 0x48. Splash's `FUN_800bc4b0` completes both bounces before 0x62. A kart entering from hit finishes that handler's vertical update after entering 0x62. `FUN_800b48ec` still applies steering until the first `FUN_800c53bc → FUN_8008a200` call sets the result steering flag. That call and later calls turn the kart towards yaw zero using the signed error shifted right by two. The winner stays where the result triggered after any required landing. `FUN_80085718/85890` starts script 0x4c on hover karts and 0x55 on Splash when the cheer data arrives. PCSX showed 7–8 ticks from entry for hover karts and 12 for the sampled Splash Crash winner. The client uses 7 for Crash, 8 for other hover karts and 12 for Splash. Both custom drivers use the Cortex script and their own vehicle mesh.
- `FUN_800b8d68` switches to engine camera mode 1 after the decision. `FUN_80078dd4/96f98` fits a 256-unit horizontal half-width, 960-unit half-height and zero depth extent per surviving driver. Draws retain the arena's two fixed fit points. The port starts from the gameplay camera and eases at 1/16 while moving in or 1/4 while moving out. The result advances a copy of the terminal scene so its objects and camera keep updating during the tally.
- Splash's hub object 0x5005 rotates with the spokes, which retract on the result. Dante's lava object 0x4000 cycles through 96 frames with two ticks per frame. Active rocks disappear at the result; each rolls by -0x80 per tick in flight. Toxic's spit uses 0639 group 2, part 58. It holds frame zero in flight, then cycles through 28 frames on landing and turns as it crawls. The active spit disappears when the race ends.
- Dot's active missile advances on the tenth-lap update and the winner's CPU still evaluates its held item during the result. The first three result updates matched the USA mixed race on kart transforms, missile position and both RNG words. The Toxic and Splash recordings also matched their first result update, including a falling Toxic winner and a Splash winner still in the hit handler.
- Native comparisons used the USA disc in PCSX ReARMed with clock, laps and driver positions set just before the normal result routines ran. Dot missile captures matched the first-tick launch height, straight motion, two reflected headings and eventual removal. The camera matched through four wins, a Dot draw with a falling driver and a Splash draw with a hopping rider. The Toxic blob samples matched 198 positions and morph frames, and the Dante rock samples matched 240 positions and rotations. Run the focused regression with `npx tsx scripts/test-dash-race.ts` from `web`.

### Same-update tenth lap (USA individual versus)

- `FUN_80085650` builds 16 dispatch rows at `0x8009d764` during player setup. It starts each row at `0,1,2,3` and swaps each of those four entries in turn with `FUN_80015590(4)`. Duplicate rows are possible. `FUN_80083e8c` picks one row with `FUN_80015590(16)` and runs the players in that order.
- In each dispatch, `FUN_800b980c` moves the player and calls `FUN_800c0218`. The tenth lap writes zero to the player's remaining-lap counters and immediately calls `FUN_800bd99c(-1, flags)`. The result routine ranks the stored remaining counts, sets the sole leader's `0x200` flag and gives the other players `0x8400`. Players already processed can bank a lap on that update. The engine skips movement for the remaining losers, whose counters still hold their previous values. Neither within-tick crossing distance nor pad/character identity enters the result comparison.
- PCSX ReARMed replays on the USA disc covered 42 cases per course. The harness set the karts' positions, velocities and laps, then seeded the native RNG immediately before its row draw. It retained the native movement and result callbacks and logged their inputs. Each course ran all 16 rows with four racers on lap nine and repeated those rows from lap eight to confirm that all four could cross on the same update. Four pairs and four solo finishes covered every winning slot. One replay confirmed an earlier slot could bank lap nine before another slot won. A tied timeout gave all four racers `0x100`. The shared step and predictor matched lap counts, placements and dispatched slots across all 168 replays.
- The shared web step builds the same kind of table from the round seed and draws a row each race update. The table and its two RNG words travel in the world snapshot, so prediction resumes from the same draw. The dispatcher shares that pair with the stage, item targeting and gameplay events. An older live snapshot without dispatch state initializes from its saved world RNG on its first step. Terminal snapshots retain the recorded result.
- In the web loopback, Top G won the first race and Big Stein won the rematch on each course. The real Party result, all four client predictors and the late spectator's terminal snapshot agreed in all eight races. The custom drivers are web-only. In 28,324 pre-finish bot updates across the four variants, the old and new sims matched on movement, objects, RNG and event contents. A separate contested fruit fixture still awarded the fruit to the lower seat while the higher seat moved first.

Four-racer examples from row 0 in the captured table for each course. Slots are zero-based. In each case, the racer that started nearest the line was scheduled last.

| Course | Dispatch order | Winner | Terminal laps by slot |
| --- | --- | --- | --- |
| Dot | 2, 1, 3, 0 | 2 | 9, 9, 10, 9 |
| Toxic | 3, 0, 1, 2 | 3 | 9, 9, 9, 10 |
| Splash | 1, 2, 0, 3 | 1 | 9, 10, 9, 9 |
| Dante | 1, 0, 3, 2 | 1 | 9, 10, 9, 9 |

Matching the row sequence of an uninstrumented console session requires accounting for the native RNG draws shared with the rest of the engine. Disc-read latency, result collisions, and the random choices of object spawners can still differ.

## Individual versus CPU steering and Toxic barrel replay

The shared race step runs each CPU immediately before its own kart in the shuffled player order. In the USA dispatcher, slot callback `8009d720` runs `800b4708`, which writes the pad at `80051388 + slot*0x58`. Slot callback `8009d708` then runs movement. Remote predictors use the CPU seat mask in the snapshot, including disconnected seats. The next human input takes control back.

The obstacle test at `800b3e60` shifts the quadratic coefficients by 12, takes the native Q6 square root and truncates both roots in units of 1/256 of the sight line. The inner and outer course queries at `8008c4c8` test each authored edge plane with separately rounded products. Dot uses group 3 for the outer query. `tools/dash_collision.py` extracts these planes from the course models.

| Course | Previous steering and boost matches | Current matches |
| --- | ---: | ---: |
| Dot | 1,198/1,200 | 1,200/1,200 |
| Toxic | 1,099/1,200 | 1,200/1,200 |
| Splash | 1,199/1,200 | 1,200/1,200 |
| Dante | 1,168/1,200 | 1,200/1,200 |

The comparison ran the native CPU callback on USA stage RAM with controlled rival positions, pickups, headings and velocities. Toxic cases included the eleven placed barrels and near-tangent monster shots. The Splash comparison covered driving and boost. Its separate hop callback was excluded. Item targeting is measured below. That steering comparison covered isolated decisions.

For Toxic barrel impacts, 400 controlled calls to `800b6108` matched all four karts’ resulting X/Z positions and velocities. The set included 730 contacts and 226 cases where multiple karts hit the same barrel. The caller checks seats in index order. A second kart receives velocity from the barrel left by the first. The stage contact pass runs before player movement.

In a PCSX individual-versus race, the barrel at (-321,-2639) was already hidden by game frame 1369 with timer 198. That timer held until all eleven barrels were active again at the next round reset around frame 4109. The timer decrement in `800b6474` applies only to state 2. Breaking a barrel enters state 0.

## Kart contact and recovery in USA individual versus

`800bebc0` checks the other seats in index order inside each shuffled driver update, after pad targets and before state and movement. The height difference can be at most 384. A horizontal distance below 384 separates only the active driver to a radius of 392. `800be914` clamps each input velocity axis to the course boost limit and drops eight fractional bits. The equal masses and restitution of 256 then exchange both axes. The velocity and newly entered hit state are visible to the next driver immediately.

`800bc0a4` pitches the kart by 128 per airborne update. On landing it halves the pitch and spins the yaw by 256 each tick. The input lock lasts one additional update after leaving the hit handler. During normal steering, `800b48ec` eases towards the speed-dependent bank by one quarter for a human and one eighth for the CPU. Splash tests its spoke against the pre-wall driver origin and adds the push to the wall-corrected destination.

Across 2,240 controlled invocations of the native contact pass, all four seats matched on X/Z, velocity and resulting state. The cases exercised 4,990 contacts. Under the same four-way variation draws, all impact sound IDs matched in sequence. Separately, 24 PCSX race fixtures covered rear, glancing, piled-up, sideways, vertically separated and steering karts. The web simulation matched 75 consecutive ticks for all four seats per fixture on position, velocity, heading, target heading, pitch, bank, state and hit counter. Angles were compared modulo one turn. The comparison seeded the recorded seat orders and the initial Splash spoke state. These measured sequences do not establish whole-race RNG, countdown, rasterization or mix parity.

### Run and boost sound handles

On Dot, Toxic and Dante, the run input keys `644+slot` and boost keys `648+slot`. The two can stay active together. `800ba278` skips the run switch on the tick it emits a boost puff. Releasing the corresponding button stops that handle. Entering the fall handler or dispatching the verdict also releases the motors. Splash has no engine tones at those IDs. The active loop origin for run follows the kart. The boost origin at `S+0xa4` was zero throughout the four recordings.

PCSX produced 62 ticks per course with successive run, simultaneous run and boost, boost alone, release and restart. The simulation matched both handles on all 248 ticks. Chromium Web Audio captured both starts and both releases from keyboard input on two WebRTC peers. A late spectator joined during a sustained run and began at the current sample offset. SPU output levels and voice stealing have not been compared sample by sample.

### Starting grid and clock in USA individual versus

The USA individual-versus mode word at `8005a646` is `0801`. All four tracks hold the grid for 112 stage updates. Dot first shows the arena on update 4. The shared mesh at `8009ae08` draws **3** on update 29 (`2004`), **2** on 57 (`2003`), **1** on 85 (`2002`) and **GO** on 113 (`2005`). The original voice clips in bank 0277 are 10, 9, 8 and 11 in that order. Each numeral is hidden on its last tick. The earlier stage-warp fixture used a different match mode and unlocked on update 100.

| Course | State on the last locked individual-versus update |
| --- | --- |
| Dot | All four hoverkart idle scripts have advanced 112 updates. |
| Toxic | In the recorded opening the hidden monster's timer reached 160. Stage sound `42e` loops. |
| Splash | Recorded pattern 4 reached yaw 3648, with 68 updates left before the spokes activate. Stage sound `672` loops. |
| Dante | The volcano has 338 updates left in its initial 450-update wait. |

On the first playable update a held accelerator moves a human driver three position units. The pickup wait counter at `800c6bb0` first drops to 59. A held hop across the Splash countdown requires release and a fresh press. The clock at `80099178` first changes from `13000` to `12958` on stage update 140. The Toxic and Dante recordings reached zero on update 2811, play tick 2699. In separate controlled expiry runs on all four tracks, a driver crossed from Z = −475 with one update left and won.

## Held items and pickup replay on the USA versus tracks

The first road crate spawns on play tick 61 and the first fruit on tick 90 (individual-versus stage updates 173 and 202). Fresh road pickups already stand 30 units above the ground when drawn. At the bottom of a bounce they spend two draws on the floor. Splash fruit stays on its spawn plane. The fruit routine samples a slot every eligible update. The crate routine samples a radius and a slot for each missing weapon, including during cooldown.

The held item uses pack 0760 part 16 for a missile and part 22 for the Toxic shield. It draws at half scale, 512 units above the driver, with yaw increasing by 128 per update. The stage copies the driver's position before movement. The marker persists through the tick that releases the item. On the following tick a missile copies its moving owner's new origin and heading before advancing 140 units. A human Splash driver needs a fresh hop press. The road item handlers inspect the held pad.

For each rival, `800b35cc` consumes a four-seat draw and a 4096-way threshold draw. The threshold is integer-divided by the number of eligible opponents. A successful draw scans forward from the selected seat to the next eligible opponent. The caller can stop at the first rival that passes its range and aiming checks. Stage spawns, dispatch and item decisions advance the same two random words. The kart respawn effect emits seven, seven, seven and three particles on its first four updates, consuming four draws per particle.

Direct calls to the missile and shield routines matched the web fire decision and both random words in all 4,800 cases. Starting at a recorded GO checkpoint, 206 consecutive play updates per track matched the four kart origins and planar velocities, pickup and missile transforms, and both random words. The road recordings included a moving launch or shield activation. Two additional PCSX runs matched held-mesh selection, visibility, position and yaw in 952 seat samples. Two human WebRTC players using Big Stein and Top G and a late spectator rendered the held items on Dot and Toxic. Holding X through a second pickup consumed it on the next update.

A separate Dot race in `0801` used the disc's Normal skill, one human and three CPUs. From the first playable update 113 through the tenth lap on 2194, all four kart positions, velocities, headings, states, held items and both RNG words matched for 2,082 consecutive updates. Both games awarded slot 3 the win. A newly hit driver can use the acceleration calculated before its first hit handler. The last respawn landing leaves one more input-locked update. An earlier capture with neutral skill 16 also matched all 1,903 playable updates through its slot 2 win.

Two Splash Normal races matched from the recorded GO state through the tenth lap. The first ran for 2,266 updates and ended on stage frame 2378 with seat 1 winning. In a second run the human held the accelerator, steered right and used hop and boost at recurring intervals. It ran for 2,547 updates and ended on frame 2659 with seat 3 winning. On each update, all four driver positions, planar velocities, headings, gameplay states, animation render words and held items matched the native recording, along with both RNG words.

At the end of the second hop bounce, `800bc4b0` re-enters the drive state and clears both speed targets before movement. In the first recording seat 1 landed on update 253. Its two velocity components dropped by 125 even with the accelerator held. Above a spoke, `800b82fc` applies vertical penetration to the working collision point. The second wall query in `800b980c` uses this height while the boat continues on its own jump arc. On update 418 the airborne seat 2 passed the island wall at (−489, −521, −1207) in native XYZ.

Toxic's mixed Normal race matched for all 2,699 playable updates, through the timeout victory for seat 3. The comparison covered the four drivers, their animation render words, pickups, held items and both RNG words. The stage-specific monster and blob timings are described above.

A second Dot race with the human steering, boosting and firing matched all 2,088 updates through seat 1's tenth lap. The shallow second reflection on update 1391 leaves the missile at (1118, 2866), heading 74. The contact and reflection routines use the fixed-point square root and angle lookup. The third bounce ends the missile on update 1412.

In a second Toxic race the human used the shield control while steering and accelerating. Native and web positions, velocities, poses, pickups and RNG matched all 2,699 updates through seat 1's timeout win. A hit can interrupt a falling driver and send them straight back into the fall state beyond the arena edge. The last respawn landing also runs the edge test immediately.

### Dante effect allocation and race outcomes

USA L26 reserves 30,720 bytes for actor components. The four karts and volcano occupy the first 7,572 bytes at GO. Each temporary component has a 24-byte header. `800232b0` takes the first free block that fits and keeps a split remainder in the same free-list position. `80023404` coalesces adjacent blocks on release. The kart update runs before the volcano and the numbered object callbacks. Destroyed object slots are reused in last-freed order.

Exhaust uses a 156-byte transform and 44-byte animation component. Level and missile effects use a 156-byte transform and 956-byte script component. Pickups and missiles request 80 and 120 bytes of gameplay data respectively, then a second transform for the reflection. Controlled MIPS calls to all four constructors distinguished a failed effect, a transform-only object and a working pickup or missile missing its reflection.

In the mixed Normal race, seat 3 begins its respawn on update 1922. Its transform fits, but the largest remaining block is 724 bytes. The native constructor releases the transform. The respawn still sounds and the driver drops. Skipping the burst also skips 96 random draws over the next four updates. Both the game and the shared simulation finish with lap counts 0, 8, 8 and 8. In the separate active-input race both finish with 2, 9, 9 and 9.

The free block offsets and sizes matched PCSX on all 2,699 playable updates of each race. The kart states, poses, pickups, held items and RNG matched through both draws and nine further recorded updates in the active race. At the verdict the volcano hides its rock meshes and leaves their fire actors in place. The serialized component pool lets a recovering client continue the same allocation sequence.

### Live driver animation and exhaust

Driver snapshots carry the current animation script and its elapsed frames. The drive state restarts the idle script. A hop advances the current boat script. A boat holds its current mesh throughout a hit, while a road kart advances its hit animation. A new boost pose can start on the input-locked update after a respawn. Both custom drivers use the Cortex animation timing on their own vehicle meshes.

`800ba278` stores separate boost and run exhaust counters. They advance on a powered input and keep their values on release. A boost puff skips the run check for that update. Spawn positions use the current steering angle and pre-movement origin, 200 units behind the driver. In `800bafc8` a boost held after the first respawn bounce can emit road smoke at a 256-unit offset, even on water. The normal road smoke draws 17 frames, and the boost flame and water spray draw 16. Each first appears on the update after allocation.

Four active-input recordings covered 3,399 stage updates and 27,495 exhaust object samples. Each puff's type, position and lifetime matched the captured object list. An additional 2,451 object samples on Dot and Splash matched the selected mesh words, including the initial hidden tick. The live renderer samples those same frames by stage tick, including when a spectator joins mid-effect.
