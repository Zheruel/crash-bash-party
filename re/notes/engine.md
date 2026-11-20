# Crash Bash engine notes (from decompiled code)

## Images / tools
- `re/img_<game>.bin` = live PS1 RAM 0x80010000..0x80200000 dumped in-game (GTE cop2 commands patched to nop for the decompiler).
- `re/out_<game>/all.c` = Ghidra decompile of everything (exe + 0991 overlay + the game's overlay); `ovl.c` = only the game's overlay
  (`python3 re/split.py <game> 800b32b4 <end>`). Ghidra project: `re/proj_<game>` (analyzeHeadless; JAVA_HOME=openjdk@25).
- RAM dumps: `re/dumps/L<level>.ram` (2 MB, address A at offset A-0x80000000), screenshots g<level>.png.
- Mini-game overlay files (all load/link at 0x800b32b4):
  Crate Crush 0728.t5d · Tank Wars 0726.t5f · Pogo Painter 0725.t60 · Ballistix 0724.t61 · Polar Push 0487.t62 · Crash Dash 0723.t63 ·
  Ring Ding 0719.t65 · Dragon Drop 0720.t64 · Mallet Mash 0718.t66 · Keg Kaboom 0716.t68
  (file header = animation-name strings + absolute pointers; code follows).
- Level ids (DAT_8005a648): 0-3 Crate Crush (Jungle/Space/Snow/Drain), 5-8 Tank (Swamp/Desert/Jungle/Metal), 10-13 Pogo,
  14-17 Ballistix (0xe Crashball, 0xf Beach Ball, 0x10 N.Ballism, 0x11 Sky Balls), 18-21 Polar, 23-26 Crash Dash,
  27 = DRAGON DROP, 28 = RING DING (cheat-verified; the name table says the reverse), 29 Mallet Mash, 30 Keg Kaboom.

## Globals / conventions
- `DAT_8005a648` current level id; `DAT_8005a646` game-option flags (0x40, 0x80 seen in Ballistix setup: handicap / variant
  options); `DAT_8005a680` mode flag (adventure vs battle? — verify).
- Game callbacks set by the family init (e.g. Ballistix FUN_800c0b94): `PTR_FUN_8005aa70` = setup, `8005aa74/78` = per-frame update,
  `8005aa7c`, `8005aa84/88/94/98` (verify roles).
- Players: array based at `0x8009d52c` (pointer list `PTR_DAT_8009d52c`), stride 0x6c bytes (0x36 shorts). Player state id at
  `0x8009d558 + p*0x6c`, previous state at `0x8009d578 + p*0x6c`. `FUN_800868b4(p, state)` switches state and calls the handler
  `PTR_FUN_8009dca0[state*2]`. Per-game per-player callbacks are installed into `PTR_FUN_8009d6e8..` slots (see setup functions).
- Frame rate: game logic runs per video frame (NTSC 60 Hz field / likely 30 Hz logic — VERIFY via the main loop / vsync count).
  Our sim runs at 30 Hz (TICK_RATE in web/shared/types.ts): convert per-frame values accordingly.
- Units: angles 0..0x1000 = 360° (`FUN_8001463c` = atan2 → 0..0x1000, `FUN_800154a0(a,b)` = signed angle diff in ±0x800).
  Positions/speeds are fixed point (find the scale: compare arena extents in code with the stage model in assets/models;
  the gltf root scale is 1/1024 with y/z flipped).
- Helpers: `FUN_80015590(n)` = random 0..n-1 (LCG in DAT_800517b8/bc); `FUN_80032f3c` = abs; `FUN_800264e8(obj, mask)` = find
  child/attachment by type mask; `FUN_80022660(type, ...)` = allocate/spawn object (free list PTR_DAT_80059610);
  `FUN_800225c4(obj)` = free object; `FUN_80022fd4` = object update/destroy step.

## Facts found so far
- Ballistix starting points (player struct +0x50 short, set in FUN_800b3b20): CRASHBALL 15, BEACH BALL 12, N.BALLISM 20,
  SKY BALLS 20 (10 if option flag 0x80). Option flag 0x40 sets per-player handicaps (values 9/15/18/20/25/30 per slot).

## Verified engine facts (pogo/crate agents)
- Game logic = 30 Hz fixed step, no dt: main loop FUN_800272ac(DAT_8004e0e0) ends with VSync(DAT_8004e0e0) (FUN_800320ec(n) = VSync(n));
  DAT_8004e0e0 = 2 during gameplay (set in FUN_800102f8; 3 only in FUN_800945c0 loader). So 1 game frame = 2 NTSC vblanks = 1/30 s;
  every "per frame" constant in the code = per 30 Hz tick = our TICK_RATE. No delta time anywhere (DAT_8004e0e4 is written, never read).
- Level setup FUN_80079260 calls PTR_FUN_8005aa70 (game setup) once, then PTR_FUN_8005aa74 (game per-frame) every frame.

## Verified engine facts (Ballistix/Polar Push pass)
- **Game logic = 30 Hz**: main frame fn `FUN_800272ac(DAT_8004e0e0)` ends with `VSync(n)` (`FUN_800320ec`), `DAT_8004e0e0 = 2` (set in
  `FUN_80010158/800102f8`) -> max 30 frames/s on 60 Hz NTSC. `DAT_8004e0d8` = global frame counter (+1 per frame, FUN_80094b38/FUN_80092edc).
  All "per frame" constants below are per 30 Hz tick = exactly our TICK_RATE. (Slow frames just drop below 30.)
- Per-frame callbacks: `FUN_80079260` runs `PTR_FUN_8005aa70` (setup/once) ... then `PTR_FUN_8005aa74` (game per-frame).
- **Pad**: per player at `0x80051338 + p*0x58`: `+0x50` (=DAT_80051388) buttons held, `+0x54` (=DAT_8005138c) newly-pressed this frame.
  Bits: 0x10 up, 0x20 right, 0x40 down, 0x80 left, 0x100 L2, 0x200 R2, 0x400 L1, 0x800 R1, 0x1000 triangle, 0x2000 circle,
  0x4000 cross, 0x8000 square. (D-pad only in these games - digital; no analog.) `&DAT_80051338[p*0x16] & 1` = pad connected/human flag.
- Entity struct (`PTR_DAT_8009d530[p*0x1b]` = object of player p): +0x10 x, +0x14 y, +0x18 z (ints, game units; 1024 u = 1 model unit), +0x1e/+0x20 yaw (0x1000 = 360 deg). `PTR_DAT_8009d544[p*0x1b]` = per-player input/motion
  struct (+0x0c = lateral velocity in Ballistix). `PTR_DAT_8009d534` = render/anim sub-object (+0x74 = anim id).
- Sin table at `DAT_80068bd4`: `(&DAT_80068bd6)[(a & 0xfff)*2]` = sin(a) * 4096 as short; cos(a)=sin(a+0x400) (code writes `(a-0x400)&0xfff` etc.).
- `FUN_800868b4(p, state)`: player state switch (player struct stride 0x6c at 0x8009d52c; state id short at +0x2c => 0x8009d558).
- `FUN_80022660(id, ...)` spawns/plays an "effect object"; ids 0x592 etc. are sound/effect triggers (see per-game notes for sfx ids).

## Polar Push findings (overlay 0x800b32b4-0x800d8a00; details in polarPush.md)
- Player motion struct (`PTR_DAT_8009d544[p*0x1b]`): +0x20/+0x40 = vx/vz (units/frame), +0x24/+0x44 = target vx/vz, +0x28/+0x48 accel (2),
  +0x2a/+0x4a decel (1), +0x4e mass, +0x14 facing/target angle. Integrator `FUN_800b5788`: per axis v moves toward target by accel (target != 0)
  or decel (target == 0), no overshoot; then pos += v. Facing: yaw += shortestDiff(yaw, +0x14) >> 2 per frame (>>5 in state 0x52).
- Fixed point: 4096 = 1 turn, trig table at 0x80068bd6 stride 4 bytes (`T[a]` = cos(a), sin(a) = T[a-0x400]); `FUN_80032490(x)` = sqrt(x)*64 so
  `>>6` = plain sqrt; pad direction -> angle: up 0, right 0x400, down 0x800, left 0xc00 (diagonals 0x200 odd steps); up = +z, right = +x.
- Position units: 1024 = 1 native model unit, web world = units / 320 (stage scale 3.2). Platform hull radius ~2470-2900 units (7.7-9 world).
- Collision between players: `FUN_800bbf2c(p)` (called from every state update): other alive player closer than 256 units -> 1D elastic exchange per
  axis (`FUN_800cbbe8`: masses m, restitution 1, result clamped +-0x9600/256 = 150), then ONLY player p is pushed out by (266 - dist) along the
  contact normal (the other one is pushed by its own call, if still closer than 256). A dashing player (state 0x51) with scale > 4000 counts mass + 0x220.
- Sound: `FUN_80022660(id,...)`; table 0x80064508 + id*2 = {slot, prog<<4|tone}; slot 255 = unmapped (silent). Slot 1 = level bank.
  sample index = vag(tone)-1 of the level's t0c bank (see polarPush.md sfx table).
- Anim scripts: `FUN_8008502c` runs a per-state bytecode (0x8000 goto, 0x8004 = change state, 0x8005 = play clip `FUN_800854c0(p,clip)`, ...);
  state lengths (dash, hit, throw) live in these scripts (not decoded). `FUN_800854c0(p, 0x3a)` idle, 0x3d edge hang, 0x3e dash (0x45 in mode 1).
- Edge test `FUN_800b4260(pos, hull)`: all 40 half-planes (point + angle: inside iff (px-ex)cos a + (pz-ez) sin a >= 0, a in 4096/turn) of the level
  hull; level collision data = `*(PTR_PTR_80058ad0+0x10)`. TILT hull (40 edges) in re/dumps/L18.ram at 0x801cce94 (see polarPush.md).

## Dash: kart physics (Crash Dash, see crashDash.md)
- Dash: yaw target += +-S+0x160 per frame on left/right; yaw += (tgt-yaw)>>2; vel axes ramp independently toward speed*(T(yaw+0x400),T(yaw+0x800))>>12 <<8; pos += vel>>8; clamp 0xc800.
- Dash: FUN_800154a0(a,b)=signed shortest diff in +-0x800; FUN_8001463c(x,z)=atan2 in 4096 units from +z toward +x.
- Dash: world x = x_g*K/1024, z = -z_g*K/1024; face = -yaw*2pi/4096. Verified on L23.ram.
- Dash: PS1 pad bits 0x80 L, 0x20 R, 0x800 R1, 0x8000 square, 0x2000 circle, 0x200 R2, 0x4000 cross; AI sets bits via FUN_800b5360 (DAT_8005a670[p]).
- Dash: FUN_80022a3c(x,y,z,objId,flags) spawns objects (0x1701 missile, 0x1702 fruit, 0x1708 shield, 0x1605 effect).
- Dash: sfx FUN_80022660(id,0,0,pitch,vol,0); id -> 0x80064508 -> (program, tone) of level bank (Dot 0175 / Toxic 0174 / Splash 0173).

## Crate Crush engine facts (overlay 0728, see crateCrush.md)
- Crush: logic 30 Hz; angles 4096/turn; arena +-0x800 raw = +-7.2 wu (U = 7.2/2048); cells 256 raw; floor y=-16 raw (Drain 0); raw y is down-positive.
- Crush: level map `DAT_8005a648`: 0 Jungle, 1 Space, 2 Snow, 3 Drain. Match timer `FUN_8007b7fc` takes BCD (0x130 = 90 s). HP init 20, dead <= 0.
- Crush: player struct stride 0x6c at 0x8009d52c (state +0x2c, HP 0x8009d562, effect 0x8009d584, effect timer 0x8009d586, pass lock 0x8009d588, held crate 0x8009d550, entity ptr 0x8009d544).
- Crush: speed table 0x8009d318 (3 shorts/char), jump table 0x8009d354, throw table 0x8009e3b4, kick table 0x8009e3dc, damage table 0x8009d3b8 (8.8 fixed), ice speeds 0x800c3984.
- Crush: movement sets velocity directly each tick (walk 45, holding a crate 30, boots +20 raw/tick); facing is quantised to 8 directions, re-snaps when the stick is > 0x110 (24 deg) off.
- Crush: sfx ids go through table 0x80064508 + id*2 = {slot, prog<<4|tone}; sample = VAB tone `vag - 1`. Samples are shared between banks on disc: resolve files via audio/index.json `sfx.banks[bank].samples[n].file`. Ids 0x41a-0x43c and 0x452-0x455 are unmapped (silent).
- Crush: anim VM `FUN_8008502c`, per-char script table 0x8009d29c: 0x8007 n hold n ticks, 0x8003 n event, 0x8004 n change state, 0x8005 play clip.

## Pogo Pandemonium engine facts (overlay 0724-0727 / levels 10-13, see pogoPainter.md)
- Pogo: logic 30 Hz; timer `FUN_8007b7fc(0x130)` = 1:30 BCD = 2700 ticks; shown seconds `90 - ceil(f/30)`; level logic also runs during the intro countdown.
- Pogo: units: tile = 512, board -2048..2048, tile index `(pos+0x800)>>9`, centre `i*512-1792`; +x right, +z away from camera; heading 0 = -z, 0x400 = -x, 0x800 = +z, 0xc00 = +x.
- Pogo: pad masks 0x10 up(+z) 0x20 right(+x) 0x40 down(-z) 0x80 left(-x); square = word 0x8005138c & 0x8000. CPU flag `DAT_8005a670[p]`, difficulty `DAT_8005a64c` 0..2.
- Pogo: player anim states 0x39 idle, 0x3a hop, 0x3b stun (51 frames), 0x3c win, 0x3d lose, 0x3e draw, 0x3f tazing. Hop = counter c5372; land when it reaches 17, next decision the following frame = 18-frame period (10 boosted).
- Pogo: tile cell array base 0x800c53dc, idx `x*0xe0+z*0x1c`: +0 obj ptr, +2/+0xa owner (-1 none, 5 monster), +0xc flags (0x10 stepped), +0xe occupant, +0x10 reservation, +0x12 state, +0x14 timer, +0x16 prev owner.
- Pogo: sfx ids via `FUN_80022660`; level banks 0171 (lvl 10), 0170 (11), 0169 (12), 0168 (13); id -> sample map per bank is in pogoPainter.md.

## Mallet Mash engine facts (level 29, see malletMash.md)
- MM: 30 Hz; game units 1024 = 1 model unit, world = game/301.4, world.z = -game.z; angles 4096/turn, 0 = +z, atan2(dx,dz) `FUN_8001463c` (table 0x800517c0, `AT[i]=round(atan(i/2048)*4096/2pi)`), cos table 0x80068bd6 `round(4096 cos)`; sqrt `FUN_80032490`>>6 = floor sqrt.
- MM: player struct 0x8009d52c+p*0x6c; state handler table 0x8009dca0; per-frame: hit/stun/blink -> AI -> input -> state -> physics (yaw diff>>2, knockback -4/frame) -> clamp -> power timer; objects after players.
- MM: anim script VM `FUN_8008502c`: 0x8000 goto, 0x8003 n event, 0x8004 n set state, 0x8007 n hold (pose auto-advances each held frame); scripts at 0x8009d29c+char*4; clip index = anim id - 0x33 (group order in model).
- MM: level clock is BCD, -2/frame; end check one call late. SFX id -> sample: id table -> (program,tone), sample = vag-1 of the level bank (0178 for MM).
- MM: `SlotInfo` gained optional `char` and `level` (shared/types.ts, passed by shared/party.ts) so sims can pick the look-dependent engine char and AI skill.

## Ballistix engine facts (overlay 0x800b32b4.., details in ballistix.md)
- u <-> sim: 1024 u = 1 model unit, 256 u = 1 sim unit; sim x = u_x/256, sim z = -u_z/256 (game player 0 sits at u_z = -2176 = bottom ship = slot 0).
- Headings point *backwards*: a mover does `x -= spd*sin(h)>>12; z -= spd*cos(h)>>12`. Reflection: `h' = n + adiff(h+0x800, n)`, n = angle ball -> obstacle.
  `adiff(a,b)` (`FUN_800154a0`) = (b-a) wrapped to +-0x800. `(&DAT_80068bd6)[a*2]` = cos(a) (sin(a) = entry at a-0x400).
- `FUN_80032f3c` = abs. `FUN_80032490(x)>>6` = sqrt(x). `FUN_80015590(n)` = rand(n). `FUN_800be1c4` = push a ball back along its path to a circle (smallest non-negative root).
- Sound effect id -> sample: id = (tone.max<<8)|tone.min looked up through the level bank's VAB to a VAG (`audio/index.json` `sfx.banks[bank].samples[n]`, find by `n`, shared samples point into other bank dirs).
- Recorder pattern (emulator, RAM 0x80000000 = HEAPU8 offset 6176336): sample once per `DAT_8004e0d8` change. The snapshot shows state *before* that frame's ship-vs-ball collision (collision uses last frame's ship pos and velocity, then the ball moves).

## Keg Kaboom engine facts (level 30, see kegKaboom.md)
- KK: logic 30 Hz; unit 1/1024 gltf, arena scale 3.398 => world = game/301.4, worldZ = -gameZ; intro flag clears at frame 99, BCD clock -2/frame from 0x130, round ends at update 2813.
- KK: player states 0x71 idle, 0x72 run, 0x73 hit, 0x74 loser, 0x75 winner, 0x78 jump rise, 0x7a fall, 0x7b land; anim scripts `0x8009d29c+char*4`, ids 0x61..0x6b, pose word `0x4000+(clip<<7)+frame` (gltf clip frame at 30 fps).
- KK: pad bits held 0x80051388 / pressed 0x8005138c (+p*0x58): 0x10 up 0x20 right 0x40 down 0x80 left 0x2000 circle 0x4000 cross 0x8000 square 0x200 R2 0x800 R1; heading = d-pad angle + 0x800.
- KK: object update list 0x8005aa04 (+0x10 next), collidable list 0x8005aa2c; objects spawned in a frame are not updated in that frame. RAM base differs between emulator sessions, autodetect it.
- KK: jump table 0x8009d354 (speed, max fall, fall accel, rise decel); chars 1-4 = 108,114,8,10; chars 5-8 = 72,114,10,6. Player collision radius 120 for every char.
- KK: sfx ids via VAB of bank 0177: sample = vag-1; samples can sit in other bank dirs (index.json).

## Ring Ding engine facts (level 27, see ringDing.md)
- `FUN_80085650` starts each of the 16 rows at `0,1,2,3` and swaps each entry with `rand(4)`. `FUN_80083e8c` draws one row with `rand(16)` before updating the seats. Rival queries within each update still scan by seat number.
- Per-player hooks: `0x8009d708` = `b9930` (pad -> heading + target velocity), state handler `0x8009dca4[state*2]` (enter `0x8009dca0`), `0x8009d70c` = `b9778` (yaw smoothing adiff>>2, accel, move, wall), `d714` = `b96a0`, `d720` = `bd08c`. Order: lock-1, AI, b9930, handler, b9778.
- `FUN_80015590(n)` = rand(n). `FUN_80032490(n)>>6` is NOT floor(sqrt): table-free CORDIC (`FUN_8003233c`, 6 hyperbolic iterations with iteration 4 doubled, constant 0x5d50ad, normalised by LZCR). Port in `ringDing.ts` (`sq`); matters for exact wall clamps.
- Matrices: `80032cac` = Ry(-a) inverse, `8003278c` = Ry*Rz forward, `800330cc` = M*v >> 12.
- VAB tone lookup for sfx: tone index = (program*16 + tone), 32 bytes each from the tone table; sample = vag field - 1 (checked on 0179 and 0180).
- Char ids per slot look: [1,2,5,7,3,4,8,6]. Level ids: Ring Ding 27 (0x1b), Dragon Drop 28 (0x1c).
- Round clock in rows of recordings is the game tick counter; level phases that run during the intro (target swing: +97 ticks) are offset from it.

## Tank Wars engine facts (levels 5-8, see tankWars.md)
- Tank: game x,z in 1/512 tile (tile centre 0x100+0x200k), 1024 u = 1 model unit; world = (g - pen centre)*TA_K/1024, z flipped; yaw 0x1000 = turn. `sin(a)` = entry (a-0x400) of the cos/sin table 0x80068bd4 (= round(4096 sin)).
- Tank: pad bits 0x10 up(+z) 0x20 right 0x40 down 0x80 left 0x100 L2 0x200 R2 0x400 L1 0x800 R1 0x1000 tri 0x2000 circle 0x4000 cross 0x8000 square; AI writes its pad with `FUN_80013c94(pad,bits)`, bits persist until the next decision.
- Tank: `FUN_80015590(n)` = rand 0..n-1. Player states 0x69 hit (30 f), 0x6a die (41 f), 0x6b dead, 0x6c start, 0x6e run, 0x6f hull turn (8 f). Damage `FUN_800b6354`; AI damage scaled (((0x20-skill)*0x96>>5)+0x32)%; `DAT_8009d908` = no live human.
- Tank: level setup/AI/mine tables indexed level-5 (0x800b3370, 0x800b3300/3338, 0x800b3488); the sfx id table (0x80064508) is patched per level at load, so read each level's own dump.
- Dash (second pass): hit/fall/shield/wall deflection/AI/monster/volcano/spokes decoded, see crashDash.md `Decoded`. Hit 0x5d = 60 calls, vy -160, no shield immunity; fall clip 24 calls (Splash 32); `FUN_80032490(x)>>6` = isqrt, `FUN_80015590(n)` = rand(n).
- Host `bot()` for vacated human seats (Tank Wars, Crash Dash, Mallet, Keg): returns the CPU AI input, stamped so the sim uses it for that frame; must stay deterministic (hash, no Math.random).

## Polar Push engine facts (levels 0x12-0x15, see polarPush.md)
- Frame (`FUN_8007976c`): `FUN_8007906c` (level callback `PTR_FUN_8005aa7c` = bb810 + objects flagged 1), players (`FUN_80083e8c`: rand(16) order first), then the
  object list flagged 2 (`PTR_DAT_8005aa40`, e.g. the Uka mask): objects see the players' new positions. On TILT exactly one more rand happens before the rand(16) every frame.
- `FUN_80015590(n)`: `a += b; r = a % n (unsigned); b += a + (a >>> 31)` on `0x800517b8/bc`; n < 2 returns 0 without advancing. Recording both words lets a
  replay seed the sim's rng per tick and check rand-call counts (a mismatch shows as "short by k").
- CPU pads: the AI's bits go through `FUN_80013c94` (pad+0x30, +0x2c = 1); the next frame's pad reader `FUN_800136bc` builds a fake stick (0/0x80/0xff) and
  stores at2 of it at pad+0x38, so diagonal CPU angles are 0x203/0x5fd-style, not multiples of 0x200 (matters for exact facing).
- The CPU AI keeps running during the round intro with the pads zeroed (state 0x49, no level tick): its state at GO comes from ~112 ticks of thinking.
- Recorder tip: `window.requestAnimationFrame` wrap + sample on `DAT_8004e0d8` change; fast-forward is fine for coarse stats (round lengths) only.


## Camera modes (DAT_800ad12c, FUN_8009608c)
- Mode 0: fixed (translation x/y/z 0x80051640.., target 0x8005164c.., angles 0x80051694.., H 0x80051658). Tank Wars, Pogo, Crash Dash, Mallet, Keg.
- Mode 1: fit-all-tracked. FUN_80078dd4 builds boxes from list 0x8005aa34 (next +0x3c, flag +0x40 & 0x8000, r +0x42, h +0x44, reach +0x46 toward facing using -sin/-cos, z extents halved, entity +0x54 -> pos +0x10, yaw +0x1e); FUN_80096a08 rotates them (FUN_8003278c fixed-point matrix, FUN_800330cc ApplyMatrixLV) and keeps the frustum extremes (slopes 320/H, 240/H at z + 0x3000); FUN_800967e0 intersects the wedges; FUN_80096f98 sets target - apex, clamps x to +-0x514 and eases >>4 (moving in) / >>2. Crate Crush 0-3, Polar Push 18-21, Ring Ding 28. Port: web/client/games/ps1cam.ts (FitCam / Ps1Follow), bit-exact on emulator traces.
- Mode 7: fixed from an object (Ballistix).
- Projection centre: GTE OFY 175 + 8 black lines at the top of every frame -> line 183 (PS1_OFY).
- Native screenshots: EJS gameManager.functions.screenshot() writes /screenshot.png (512x240) but returns the frame of the previous call; take two.

## Character voices (decoded 2026-11)
- A VAB tone carries its own sound id in min/max (`FUN_8002aca0` fills table 0x80064508 from every loaded VAB), so each voice bank declares
  its ids. Character voice ids = block*0x32 + n; block per engine character: 1 crash 0, 2 coco 1, 3 cortex 2, 4 brio 3, 5 tiny 6, 6 rilla 7, 7 dingodile 5, 8 koala 4 (= hit ids / 0x32).
- Voice-bank families (disc t0c, matched in the level RAM dumps): 0182-0189 Tank Wars; 0190-0197 Pogo / Ballistix / Crash Dash;
  0198-0205 Polar Push; 0206-0213 Crate Crush / Ring Ding / Mallet Mash / Dragon Drop / Keg Kaboom. An id missing from the family's bank is silent.
  Built into assets/audio/voices.json {families: block -> bank, ids: bank -> id -> file}; client API web/client/shell/voice.ts.
- Hit voice: table 0x8009e080 + engineChar*8 = 4 ids (block*0x32 + 3..6), rand(4). Used by Crate Crush hurt-enter (ovl 0x800bfd..),
  Ring Ding recoil enter (anim 0x4d), Polar Push collision at speed^2 > 0x1000.
- Anim scripts (`FUN_8008502c`, per-char table 0x8009d29c) play `0x8008 id` inline. Generic exe anims: 2 (state 2) n=2, 6 jump n=0xc,
  8 spin (engine chars 1-2) n=0xd, 10 spin (chars 3-4) n=0xe; the 9 / 0xb spins have no voice.
  Crate Crush: 15 pick-up n=0xf, 17 hold-walk n=0xa/0xb (steps), 18 throw n=0x10. Polar Push: 0x3e dash n=0x18 (frame per char 16,15,31,31,24,13,17,17
  for engine 1-8; tiny also n=0x16), 0x43 n=0x15/0x14, 0x46 n=0x19/0x18 (states not mapped). Dragon Drop: 0x2b hit n=3, 0x2c jump n=0xc.
- Tank Wars taunt (Triangle in states 0x6c-0x6f, 90-tick cooldown; CPUs after 80 idle frames): id from 0x800c94a8[char-1] = block*0x32 + 2
  (ported: the sim emits `taunt`, the view plays `charVoice(tank, char, 2)`). FUN_80027f7c / FUN_80028018 are pad rumble, not voice.

## Effect scripts (object 0x1605) and effect sprites
Decoder: `tools/fxscripts.py` -> `web/client/games/fxScripts.ts`; player: `web/client/games/realFx.ts`.
- `FUN_80022660(id, ...)` is sound only. Effects are objects: `FUN_80022a3c(x, y, z, objId, flags)`.
- **0x1605** (init `FUN_8008b510`, update `FUN_8008bb48`) plays one effect script. Spawner pattern: `c+0xc = script`, `c+0x18 = 0x100` (rate),
  `c+0x20 = mode` (1 once, 0 loop, bit 4 = a db is given), node `+0x6c = db`. Without a db the script comes from the level model
  (`*DAT_80058ad0`). Helpers `FUN_8007a464(script, pos, db)` (loop) / `FUN_8007a524` (once).
- Script data sits in the t29 pack: `u32 +0x48` count, table `+0x4c` (self-relative, entries self-relative). Script = {tracks, nodes,
  duration, ...}, track pointers at `+0x1c`. Track type 0 = one mesh on keyframes (0x24 header, keys 0x50 bytes: time, -, render id,
  pos, rot, quat, scale, alpha); type 1 = particle emitter (struct at `+0x14`: pos, pool, rate, life, duration, speed range, mesh,
  radius, yaw / pitch ranges, accel, fade in / out, grow / shrink, spin; spawn `FUN_8001f604`, step `FUN_8002147c` / `FUN_8008ada4`).
  Render id = `0x2000 + part + 1`; time in 30 Hz frames; scale / alpha 0x1000 = 1. Alpha darkens the colours (node `+0x76`, flag 0x40000000).
- Part-table flag bit 17 (`0x60 + 0x34k`, 0x20000) = camera-facing sprite.
- Flip-book objects: `FUN_80024e30(obj, {0, clipTable, mode})` + `FUN_800250b0` per frame. Mode 2 lists are u32: low word = render id, high word =
  extra ticks to hold; 0x8003 = delete the object, 0x8000 = loop.
- Forced blending [inferred from the art: fire on black, fades by darkening]: spawners set node flag 0x20000000 on every node of some scripts
  (tank muzzle flashes, pogo touchdown dust) and 0x21 on flip-book nodes (0x1306, 0x1709, the pogo beam). The port draws those additive.
- Floating score: `FUN_8008d5d4(x, y, z, value, delay)` -> object 0x1409 (init 8008d570, update 8008d2bc): digits = HUD pack 0732 parts 13 + digit
  (tens 180 u left); waits `delay`, rises 32 u / tick for 416 u, bobs +-96 and grows 0x40 / tick for 30 ticks, then flies up 60 ticks shrinking
  toward 0.5. Used by Keg Kaboom, Mallet Mash and Pogo Painter only.
- There is NO generic jump / land / run dust and no bump sparks. Dust object 0x207 (pack 0736 parts 37-52) only spawns in Crate Crush; the smoke
  puffs 0x1613 / 0x1903 are 16-frame flip-books that ease toward their owner.
- Shared crate break `FUN_8008e27c` (pack 0796): kind 2 -> script 2, 3 -> 4, TNT -> 1, nitro -> 0, else 3.
- Pack db pointers: 0x80052f5c 0736, 0x80052f94 0796, 0x80052fcc 0794, 0x80053074 0732, 0x80053f8c 0738, 0x80053c7c 0343, 0x80054504 0762,
  0x80054f84 0760, 0x800546c4 0403, 0x80053b9c 0770, 0x8005365c 0786, 0x80053694 0784, 0x80055534 0619.

## Podium / shared engine facts (level 43, see podium.md)
- Anim clips are loaded by name: `FUN_800165f8(slot, name)` hashes the name (`FUN_8001534c`: sum of char * 1-based position) and matches word +16 of
  the model's 24-byte anim descriptors (count +0x40, table +0x44); the keyframes are then read from disc. Mode-1 anim scripts (`FUN_800251a8`):
  `0x8011 n pose` n frames forward, `0x8012 n pose` backward, `0x8000` loop, `0x8001` next entry of the script table (`FUN_80024fa4`, a 0 entry
  is followed by the index to jump to); `FUN_80025fac(comp, n)` starts entry n.
- Camera paths: `FUN_8001e48c(id)` finds a path of the level (`*(level+0x28)` ids, `+0x2c` self-relative pointers), `FUN_8001e21c(path, d, out)` =
  point at running distance d (28-byte nodes from +0x30: x, y, z, distance; node 0 is the look-at target). Camera mode 4 = the overlay's
  path camera, eased by `FUN_80013f44` (divisors 0x800ad0f4).
- Sky: level-model parts of type 100 (part table +4) are backdrop layers (`FUN_80095258`), drawn first by `FUN_8009440c` with H = 320 and a
  rotation of `frame * speed >> 12` per axis (table 0x800a02d8, 20 bytes per layer id).

## Character identity (fixed 2026-11)
- Engine ids (look.ts DISC_CHARACTER [1,2,5,7,3,4,8,6]): 1 crash, 2 coco, 3 cortex, 4 brio, 5 tiny, 6 rilla roo, 7 dingodile, 8 koala kong.
  Koala Kong = the pink-skinned ape in striped trunks with a gold belt (base 978, podium 744, HUD face 0731 tex022);
  Rilla Roo = the grey ape in a red vest (base 976, face tex008). Mallet Mash / Keg Kaboom used another order ([1,2,8,6,3,4,5,7]) and
  their character props were rotated; both now use DISC_CHARACTER and props matched by the models' looks.

## LOADING screen
- Model 0311 (= 0730): part0 the LOADING letters, part1 the vertex-coloured vortex tunnel. Loader `FUN_800945c0` (frame divider 3).
- Emulator capture: fades in from black in six 30 Hz steps (19/37/58/74/93/100 %), letters tumble (pitch ~0.8 s, drift ~1.1-2 s loops), tunnel spins. Port: `web/client/ui/loading.ts` (motion periods read off the capture, not the code).
- Match start (emulator, Ring Ding L28): no 3-2-1 / GO overlay; after the RULES card the level fades in and play starts with the clock at 1:30. The party's countdown is ours (it holds the round until every peer has the level), drawn in the game's lettering.
