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
- Race end FUN_800bd99c: individual = fewest laps remaining wins; tie among top = draw. Team = laps*0x1000 + progress (0x152c-atan2(x,z))&0xfff.
- Time 1:30 (flag 0x40 shortens). Timer code not located.

## Pickups (FUN_800c04ec fruit, FUN_800c0cb4 crates)
16 slots at angle slot*0x100, radius fruit 2200 (Splash 1500), crates 2200+rand(100). Random free slot probe from rand(16). Slot 2 initially occupied.
Spawners start when DAT_800c6bb0 (60) < 0; DAT_800c692c = frame.
- Fruit (obj 0x1702): cooldown 30 frames only decrements while fruitCount+cap != 6; cap 3 (f1..900), 2 (901..1800), 1 after => target 3,4,5 fruits.
- Crates (type 0; type 5 on Toxic): cooldown 30; on-track + held items target 2 (f<=1800), then 3. Not on Splash.
- Collect FUN_800bfd84: dist^2<0x24000 (r384), |dy|<0x200, lowest p wins; skipped if S+0x130!=0 or item==0x10.
  fruit: fuel+0x2000, sfx 0x1c2. crate0 -> item 1 sfx 0x51f. crate5 -> item 0x20 (shield) sfx 0x439.
- Use item FUN_800bc984 (0x2200): item1 -> missile 0x1701 (FUN_800c5154); 0x20 shield (0x1708, S+0x130=1, see Decoded). (Earlier guess of 900 frames / 0x1ffc was wrong.)
- Missile 0x1701 (FUN_800bf2b8, sfx 0x522; handler 800bf460): orbits origin, 140 u/frame, radius = spawn radius, angular rate +-(140<<8)/r, dir from shooter yaw. Hit (800bf0f8): other kart not 0x61, d^2<0x24000, |dy|<=0x180 -> victim 0x5d, explode sfx 0x43d. Wall reflect (group1, r 0x96, |pos|>>6<0xf01) sfx 0x65e-0x660; 3 bounces -> explode. Trail every 3 frames.
- Kart-kart (FUN_800bebc0): |dy|<0x181, d<0x180: push (0x188-d), exchange (800be914, equal mass, e=1, clamp boost speed). Bump sfx 0x640..0x643 (Splash 0x675..0x678) if speed^2>0x62e08 (Splash 0x10d2a4). Slower kart (v^2<half) when half-speed^2>810000 -> I am stunned 0x5d sfx 0x654.

## States (table 0x8009dca0)
0x5b drive (engine sfx run 0x644+p anim 0x48/0x49, boost 0x648+p anim 0x49 hmm; exhaust 0x1709 run /3f, 0x170a boost /4f)
0x5c square hop 21f; 0x5d hit: see Decoded below; 0x5e Splash cross-jump vy -0x44 g 5/10;
0x60 spin 45f + 16 stop; 0x61 fall: see Decoded below; 0x62 finished.
Anim calls FUN_800854c0(p,id): 0x48 idle, 0x49 run/boost, 0x4a, 0x4b fall, 0x52-0x54 Splash.

## Hazards
- Toxic (800b5f04/6474/6108): barrels (model 0x5006): contact r384 -> kart 0x5d, sfx 0x663/0x664; barrel hides then respawns 180+rand(60) f. Monster 0x170b at (0,0xc4,0) sfx 0x42e (handler 800c2e10 unread). Crates are shields.
- Splash (800b5d14/5a70, patterns 0x800c6b70): 6 spokes (model 0x4000) rotate 4/f (-4 if DAT_800c69ac 1|2). Pattern rand(0..4) each 180f: P0 delays 10,20,29,40,50,60 hold 10; P1,2 spoke0 hold 120; P3,4 spokes 0&3 hold 120; peak height 17..28, +2/f. sfx 0x672 start, 0x673 rise, 0x674 fall. Splash AI edge r^2>0x640000.
- Dante: lava; objs 0x1707/0x170e (handlers 800c2388/800c3f68 unread); fall r>3328.
- Dot: pits/off-track via 800b7190 groups 0,3.

## AI tables (shorts; FUN_80086918 -> DAT_8009d87c[p*3+{0,1,2}] skill,?,weight)
Dot 0x800c63fc [4,1,1,1,10,26,20,16,16,28], 0x800c6410 [6,3,1,1,14,28,22,5,5,30], 0x800c6424/30/48 (16), 0x800c645c (32). Toxic 0x800c64b0/c4. Dante 0x800c6564/78. Splash 0x800c6618/2c.

## sfx banks (FUN_80022660 id -> 0x80064508 -> VAB tone): Dot 0175, Toxic 0174, Splash 0173, Dante 0172(?).
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
- Fall trigger (post-wall position, not when flags&0x200): Toxic r^2 > 0x900000 (3072), Dante r^2 > 0xa90000 (3328), Dot/Splash FUN_800b7190 group 1 (Dot has none; Splash radius not decoded, port uses 2944).
- Splash spokes: if FUN_800b82fc(spoke, pos, 0, &pos) == 4 (the -z face of the spoke box) and that spoke's state (DAT_800ca560 + i*0x1c) == 1 (rising): v = 0x6000 * unit(pushedPos - prevPos) (a kick at speed 96). The box comes from the model (FUN_8008ce20) and is NOT decoded: the port uses an estimated arm (1000..2700 long, half width 120, height = ext*16).

### Hit 0x5d (enter FUN_800bba04, per frame FUN_800bc0a4)
Enter: counter S+0xc = 60, vy = -160, gravity +10 while vy < 0 else +20. No speed cut (pad zeroed -> only decel 160/frame). Per frame: vy += g (g chosen by the old vy), y += vy; if vy > 0 and y > ground: y = ground, roll halves, yaw += 0x100 (EVERY frame after the first landing, ~frame 27 on: ~36 spin steps); else roll += 0x80. Then c = counter--; if c < 0 -> state 0x5b (62 calls). Yaw is not smoothed meanwhile.
Sources: missile FUN_800bf0f8 (not owner, not 0x61, |dy| <= 0x180, d^2 < 0x24000), barrels, blobs, rocks, kart-kart. NO shield immunity anywhere (the old port had one).

### Fall 0x61 (enter FUN_800bad54, per frame FUN_800bafc8)
Enter: S+0x54 = atan2(x,z), item (S+0x18) cleared, anim 0x4b (Splash 0x54). Phase 0: velocity zeroed while the clip runs (character scripts in re/dumps/L23.ram, identical for all 8 characters: clip 0x4b = 24 frames, Splash clip 0x54 = 32 frames; transition on the 24th / 32nd handler call). Phase 1 entry: pos -= 512 toward the origin (T(S54-0x400)>>3, T(S54)>>3), y = -1400 (1144 above ground), sfx 0x655, effect 0x1605 (type 9; Splash 5). Phase 1 per frame: yaw = tgt = (S54-0x200) as signed 12 bit; FUN_800c467c: vy += 0x300, y += vy>>8; when y > ground: y = ground, vy = -(vy*100>>8) (bounce); landing counter S+0x88++; second landing -> 0x5b. (First landing after 28 frames, second ~22 later.)

### Shield (item 0x20, Toxic crates; FUN_800bc984 -> 0x1708, FUN_800c1cfc)
Sets S+0x130 = 1 (blocks pickup collection). Object life counter 14 -> ends when < 0 (~15 frames, not 900). Each frame it finds the FIRST other kart in index order with d^2 < 810000 and sets its velocity to 0x8000 * unit(other - shield) (targets zeroed). Only one kart per frame.

### Bot AI (FUN_800b4708 per frame; skill = table d900[difficulty]: Dot 1/11/22, Toxic 1/10/20, Splash 1/10/20, Dante 1/11/22)
1. pad = 0. Nearest pickup (FUN_800c5c64); if d^2 < 0x271000 and kart polar angle < pickup polar angle -> chase (FUN_800b5528): diff = sext12(atan2(me-pickup) - yaw); > 500 -> right (clear left), < -500 -> left (clear right); run only (no boost bit).
2. Else FUN_800b5360: pad |= 0x8000|0x800 (ALWAYS run + boost; the boost clears inside 4edc are re-ORed) plus FUN_800b4edc: near probe = pos + 512*forward: inside group-0 polygon (the hub) -> left; far probe = pos + 1936*forward: Dot not inside group-3 polygon (outer wall) / Toxic r^2 > 0x510000 / Splash, Dante r^2 > 0x640000 -> right. Both can be set (cancel).
3. Not Dot: FUN_800b442c kart avoidance: others with sext12(polar(other)-polar(me)) > 99 and on the forward ray (1524 long, circle r 0x180; the game feeds FUN_800b3e60 the backward vector but its quadratic solves for the mirrored circle, so it is a forward test) -> if other r^2 < 0x310001 left (clear right) else right (clear left).
4. Non-Splash FUN_800b41dc: item 1 (missile): random weighted target (FUN_800b35cc: one rand(0x1000) threshold, equal weights = 1/3 per call, 3 calls a frame), ahead (> 99) and on the 2048 ray -> circle 0x2000. Toxic FUN_800b406c: item 0x20 -> use when the picked kart is within 768.
5. Splash FUN_800b372c: hop (0x4000) when a spoke is within 256 of the point 64 ahead (not on its -z side).
6. Toxic only: FUN_800b3890 nearest live barrel ahead (polar compare after -0x400) on the 4096 forward ray -> barrel r^2 < 0x400000 ? left : right, boost off; FUN_800b3bc0 same for the nearest blob (blob r^2 < my r^2 ? left : right).

### Toxic (FUN_800b5f04 barrels, FUN_800c4774/2e10 monster, FUN_800c3738/3934 blobs)
- 11 barrels (array 0x800c6f88, positions read from the emulator): (-1577,2173) (-1142,2253) (1529,2189) (1158,2446) (-2493,-719) (-2155,-1053) (-2173,-1572) (-2618,-230) (-2618,236) (-321,-2639) (-257,-1428). Contact d^2 < 0x24000: kart pushed to 384, FUN_800be7b4 velocity exchange (port: mirror bounce), kart 0x5d (unless 0x61/0x5d), barrel hidden 180+rand(60) frames. Measured on the emulator (medium CPU, 18 s): 9 barrel hits, CPUs 3-4 hit entries each.
- Monster 0x170b at (0,0xc4,0): hidden timer rand(90)+240 first; state 3 hidden (timer-- ; when < 0 and race running: timer = rand(150)+450, anim 0, state 0); 0 rise (model 639 anim 0 = 119 frames); 1 attack (anim 1 = 42 frames, at the 22nd call: sfx + 3 blobs at (-512,-668,-512)); 2 sink (anim 3 = 35 frames); then hidden for timer+1 frames. Anim lengths measured from assets/models/0639.gltf.
- Blobs 0x170d (3 per attack, spawn index k cycles 0,1,2): ballistic (gravity 16, speed 64/frame) to (T(a+0x600)*7>>4, 0, T(a+0xa00)*7>>4) with a = -0x200*k (landing 16/21/30 frames, ground y = 0); landed: any kart within 256 (2D) -> 0x5d and the blob goes; else after 92 calls it crawls tangentially (x -= T(p)>>7, z -= T(p+0x400)>>7, p = polar angle, against the lap direction) until p in [0xc00,0xfff], then z += 32/frame until r^2 > 0x790000. Hit test (r < 256) in the landed and crawling states only.

### Splash (FUN_800b5d14 / 800b5a70, patterns 0x800c6b70)
Spokes are model 0x4000 objects with initial yaw i*0x2aa; every frame yaw -= 4 (+= 4 when the current pattern index is 1 or 2). Start wait 180 frames, then pattern index = rand(5) (6 rands at setup), each pattern runs 180 calls (pattern 5 = race over, 1800, all retract). Per spoke [hold, delay]: P0 [10,10] [10,20] [10,29] [10,40] [10,50] [10,60]; P1/P2 spoke 0 [120,0]; P3/P4 spokes 0 and 3 [120,0]; others -1 (unused). At each pattern end: extension max = rand(12)+17 (first pattern uses 17), all spokes un-started. A spoke starts when its counter reaches the delay: state 1 rise ext += 2 until > max -> state 3 hold (counter > hold, i.e. hold+2 frames) -> state 2 fall ext -= 2 -> 0 -> idle. Model param +0x74 = ext + 0x4000. sfx 0x673 on start, 0x674 on fall (silent).

### Dante volcano (0x1707 init FUN_800c2284 / update FUN_800c2388; 0x170e = alternate, option 0x80, not ported)
State 0: timer 450 (300 after a cycle), rumble sfx at 60, launch when < 0. Launch: u = rand(0x1000); per rock: speed = 12 - rand(3) (12/11/10), target (T(u-0x400)*0x4b>>9, 0, T(u)*0x4b>>9) = 600 units out, u += 0x555 + rand(0x200). Rocks start at (0,0,0), ballistic like blobs (gravity 4, frames = 600/speed -> 50/54/60, vy0 = -(frames>>1)*4, y positive down). Per frame (r^2 measured before the move): move; if r < 768: bounce when y > -0x100 and vy > 0 (vy = -(vy*0x94>>8), vx, vz snap to +-20); else bounce on y = -0x80; removed when r^2 > 0x900000 (r > 3072). Kart hit: 3D d^2 < 160000 (kart y = -256 - height) -> 0x5d, rock removed. When all 3 are gone the timer (20 after launch) counts down < 0 -> 300 and state 0. The rolling ball 0x170c (FUN_800c5b94 every 181 frames) is never called: dead code.

## Start slots (table 0x8005b2b8, read from the emulator after the level cheat; yaw 0)
Dot (963,560) (1463,248) (1835,-120) (2336,-455); Toxic (1020,1000) (1520,687) (1892,318) (2406,-28); Splash (931,1053) (1430,740) (1803,371) (2304,37); Dante (950,900) (1450,588) (1822,219) (2323,-115).

## Estimated / not decoded (flag if the emulator disagrees)
- Controls mapping (stick x = L/R, up = R1 run, a = Square boost, b = Circle item / Splash hop); the 0x5c square hop is dead code (its entry test `FUN_800c55a4`, square press -> 0x5c, is referenced nowhere: no pointer to it in the L23 RAM), so there is nothing to port.
- Hub radius of Toxic/Splash/Dante (from the stage meshes, group-0 polygon not extracted), Splash fall boundary (2944), Splash spoke collision box, FUN_800be7b4 barrel bounce, kart-kart bounce details.
- Toxic monster rise visual (mon 0..1 over 60 frames) and anim frame counts (+-1), blob/rock visual heights.
- BotBrain degrades the hardest AI for Easy/Normal instead of using skill 1/11 (accel table) - the real difficulty also changes accel.

## Sfx resolved (id -> sample), table 0x80064508 is static: only ids 0x640-0x660, 0x1c2, 0x43d, 0x51f, 0x522 are mapped; 0x439/0x43a/0x466/0x663-0x684/0x69a-0x69f are SILENT in the real game
Level banks (index.json levelBanks): Dot 0175, Toxic 0174, Splash 0173, Dante 0172. Sample = vag(tone)-1, file via audio/index.json banks[bank].samples[n].file.
Generated per-level id->file map: `web/client/games/dashRaceSfx.ts` (DASH_SFX). Dot: run 0x644+p -> 4,4,5,5; boost 0x648+p -> 6,6,7,7; bump 0x640..43 -> 0..3; fruit 0x1c2 -> 7; crate 0x51f -> 11; fire 0x522 -> 1; explode 0x43d -> 2 (bank 0172 files).

## Effects (decoded)
Packs: 0760 (db 0x80054f84), 0403 (0x800546c4); level models 0643 Dot / 0639 Toxic / 0641 Splash / 0637 Dante carry the level scripts.
- Exhaust (`FUN_800ba278`): 200 u behind the kart at kart height (-256). Boosting: object 0x170a every 5 frames = 0760 parts 40-55 (16 frames);
  running (R1): 0x1709 every 7 frames = 0403 parts 26 (3 ticks), 28-41, node flag 0x21; Splash: 0x1711 = 0760 parts 56-71.
  (0x170f / 0x1710, green puffs 0760 parts 24-39 / 0-15, belong to a Toxic special mode; not ported.)
- Missile 0x1701 (`FUN_800bf460`): 0760 script 0 every 3 frames as trail; script 1 + sfx 0x43d where it ends. Firing is sound only.
- Fall (`FUN_800bafc8`): when the clip ends the kart is put back 1400 u up with level script 9 (Splash: 5) + sfx 0x655.
- Shield 0x1708: level script 8 (ring closing over 15 frames). Toxic barrel hit: 0760 script 1 at (x, -210, z); barrel respawn: level script 9.
- Toxic monster: level script 10 at (-512, -668, -512) on attack frame 22. Dante volcano (`FUN_800c2388`): script 4 at the crater on launch,
  script 10 looping on each rock, script 3 every 8-10 frames in flight, script 1 where a rock ends.
- Nothing for boost start, pickups, kart bumps, hops, laps or the finish. TNT 0x1703 (0796 script 1) and lightning 0x1706 (0403 script 0) belong to pickup types 1, 2 and 4, which the versus spawner (`FUN_800c04ec`: types 3, 5, 0 only) never makes.

## Objects (verified from the overlay)
- Pickup object 0x1702 (`FUN_800bfc38` init: pack 0760; update `FUN_800bfd84`): type 0 crate = 0x2011 (0760 part16, the missile model),
  type 5 Toxic shield = 0x2017 (part22, pink star), type 3 fruit = 0x2049 + (k % 14) flip-book, type 1 = 0796 0x2009 at scale 0xc00,
  type 2 = level part4. Yaw += 0x80 per frame; falls to the ground (FUN_800c467c).
- Splash spokes: anim id 0x4000 + ext = clip 0 of the level model 0641's animated part24 (30-frame morph), posed at frame ext. The arm
  reaches along the model's -z from the hub (z +573 .. -2294 u), so at yaw a it points (-sin a, -cos a) in game space; the sim's
  collision arm follows that.

- Splash start line (object 0x5002, part extra_57e4) sits at y +79 (under the floor); the PS1 ordering table draws it over the floor anyway. The port lifts it to floor level and draws it as a decal. Spoke rotation sense checked on the emulator (pattern 1 turns clockwise seen from above, same as the port).
