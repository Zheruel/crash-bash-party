# Tank Wars (`tankArena`, levels 5-8) - from the decompiled overlay (0726.t5f, base 0x800b32b4)

Sim: `web/shared/games/tankArena.ts`. View: `web/client/games/tankArena.ts`. Sound map: `web/client/games/tankArenaSfx.ts` (generated).
Status tags: [exact] read from the code (and mostly checked in a live recording), [est] estimated / simplified.

## Units and conventions
- 30 Hz, one update per frame (frame counter 0x8004e0d8). Positions 1/512 tile, tile centre 0x100+0x200k, 1024 u = 1 model unit, +z away from camera.
- Pen centres (game units): L5 (0x900,0x800), L6/L7 (0x800,0x800), L8 (0x900,0x700). World = (g-c)*TA_K/1024, world z = -(gz-cz)*TA_K/1024.
- Angles 0x1000 = turn. Shell direction = (-sin h, -cos h) with h the turret yaw (+0x1e). Hull movement direction (sin t, cos t), t = yaw + hull child. Visual face of the turret = -h*2pi/4096.
- Level -> variant: 5 swamp (bank 0159), 6 desert (0162), 7 jungle (0160), 8 metal (0161). Sample = vag(tone)-1 of the level bank; id table patched per level (`TANK_SFX`). Silent ids in L5: 0x4e9 0x501 0x51f 0x522 0x4be-0x4c5 0x4d2-0x4d7; L8: 0x51f 0x522.
- Level tables (indexed level-5): setup 0x800b3370, AI decide 0x800b3300 / 0x800b3338 (L5/7/9 "a", L6/8 "b" variant), mine blast 0x800b3488 (L5/7/9 area 0x800bd710, L6/8 flames 0x800bd6b0).

## Rules [exact unless noted]
- 4 tanks, hp 99, 3 mines at start, weapon by character (engine char 1,2 -> 9; 3,4 -> 11; 5,6 -> 10; 7,8 -> 8), ammo 999. look.ts index -> engine char [1,2,5,7,3,4,8,6]. Speed chars 1..8 = 28,28,24,24,26,26,24,24 (L5: x3/2).
- Timer 1:30 (0x130 BCD). Timeout `FUN_800b62a4`: highest hp wins (lowest index on ties); the rest are killed. Last tank standing ends the round (game over flag stops damage and pickups). Round reset ~210 f after the last kill in the disc; we end 60 f after.
- Spawns (x, z, yaw): L5-7 (256,768,0x800) (768,3840,0xc00) (3840,3328,0) (3328,256,0x400); L8 (256,768,0x800) (768,3328,0xc00) (4352,2816,0) (3840,256,0x400).
- Maps (tile blocks, cacb4 movement layer = cacfc projectile layer): L5 open 9x8 (bounds 0x1100,0xf00); L6 8x8 rows{1,3,4,6} x cols{1,3,4,6}; L7 8x8 rows{3,4} x cols{3,4}; L8 9x7 rows{1,3,5} x cols{1,3,5,7}.
- Damage entry `FUN_800b6354`: ignored if game over, invulnerability counter, dead, or state 0x69. AI target with a live human: dmg*(((0x20-skill)*0x96>>5)+0x32)/100 (dmg<400). No live human (`DAT_8009d908`): dmg*3 [est: only x3], AI skill 30. Hit -> state 0x69 for 30 f, hp<=0 -> dying -> 0x6a (41 f) -> 0x6b, sound 0x4f0.

## Movement
- L6/L8 grid (0x800b9e20): no d-pad = no move. dir 0 -z,1 -x,2 +z,3 +x. At a centre ((x&0x1ff)==0x100 both) tests right,left,up,down in that order for a free neighbour tile: opposite dir flips instantly, perpendicular starts state 0x6f (hull +-0x80 x 8 f, then steps if held). Mid-tile reversal instant. Step = speed, boxes vs other tanks (dir 0 |dx|<=0x1c0,|dz-sp|<0x1c0; dir 1 |dx-sp|<0x1c1; dir 2/3 margin 0x1c0-sp), wall tile via cacb4 with half-speed look-ahead, then snap to the 0x100 grid when within half a step. Initial dir = spawn shell direction [est].
- L7 free (0x800b993c): d-pad -> target heading (0,0x200,..); hull c flips 0x800 while |diff|>0x400, then c += diff/4; step speed*sin/cos>>12, probe tile at +(sin>>4, cos>>4), tank box 0x1c1/0x1c0, pedestal clamp, centre blockers at (2048,2048) box 0x15e.
- L5 boat (0x800b9430): left/right yaw +-speed*3/2, bank +-0x14 (clamp 200, decay 10); R1/R2 thrust v += -(speed*sin>>12)>>2, clamp +-speed, per axis decay 1, bounce at 0x100 / bound, tank bump exchanges velocity (other += v/2, me v/4) without moving.
- Turret (non-L5): disc rotates it with L1/R1 (+-0x40/f); the port auto-slews to the stick direction at 0x40/f [deviation]. AI aims with aim assist yaw += diff/4.

## Weapons [exact unless noted]
- Fire (0x800b77e8): square edge, cd==0, not busy, <3 own shells. cd 10 (60 bomb), anim lock 13 f (double 39) [est], ammo-1, ammo<1 -> char weapon, ammo 999, cd 30. Spawn 400 ahead (+tank v on L5). Sounds 0x4ca..0x4d0 by char [est for char 7], 0x522 double.
- Shells (`FUN_800baffc`): w11 dmg 20 speed 74 life 90; w8 20/54/63; w10 lob 30/44/75 (vy+12, ground hop at y>-0x65); w9 20/44/135; w2 double 60 speed 200 [life est 30]. Wall reflect on cacfc dominant axis, arena edge reflect, owner takes half, pickups in a 0x1ff box destroyed (0x4b8), hit box 0x10f/0x10e, shields absorb within 0xe1. L5 AI dodge: no shot if rand(32)<skill and shield ready.
- Bomb (weapon 3, 0x800bc27c): speed 125, vy -91 +12/f, direct hit box 0x181 hits all, landing hits first tank in 0x180; 60 dmg.
- Mine: circle edge, cd 120 f (L5 30), fuse 120 f, sounds 0x4e9 + 0x4ec+p, tick 0x4eb per 30 f, blast sound 0x4ea. L5/L7: area +-0x300 for 60; L6/L8: 4 flames of 500 u/f stopping at walls/players (60 dmg). Owner is hurt too. L5: circle = cross shield for AI only in the port.
- Pickups: dropper (L5-7) crosses every 180-299 f, one drop attempt per grid column (31%), max 3; L8 spawner picks one of 41 table spots. Types: 2 double (L7), 3 bomb (L8), 4 +20 hp (cap 99), 5 mine, 6 bad crate (-30; chance grows with dead players). Hop gravity 8, collect box 0x12d/0x12c.

## AI (struct 0x800caffc + p*0x2c)
- Skill by difficulty: L5 [1,16,26]; L6-8 [16,24,32] (30 when no human lives). Shoot gate `FUN_800b3f44`: rand(101) > (skill*0x55>>5)+5 -> no shot while a human lives; LOS = free tile 0x200 ahead. L6-8 per frame `FUN_800b5228`, decide `FUN_800b4a28`: target random alive enemy, rand(8): 0 idle if rand(skill+1)<13, 1 pickup seek, 2 lay mine, else approach (cd<5) or move away; wander on free neighbour tiles; mine avoidance `FUN_800b4490`. L5 `FUN_800b4fac`/`FUN_800b4688`: modes 6 face target, 4 go to pickup / one of 9 points, 7 flee, idle. Octant table 0x80051244 [est: rounded angle].

## Animation / sfx / camera
- Clips (`FUN_800854c0`): 0x58/0x59 idle, 0x5a taunt, 0x5b mine, 0x5d-0x5f fire. View roles: idle / hit (0x69, 0x6a). Camera: fixed per level (see CAMS in the view), unchanged [est].
- `FUN_80027f7c(p,10,0xf0)` on a hit is pad vibration (human pads only), not a voice. Human taunt (ovl ~0x800b8da0): Triangle held (0x80051388 & 0x1000), cooldown +0x800cadd8 < 1, state 0x6c / 0x6e / 0x6f -> cooldown 0x5a, clip 0x5a, taunt voice; ported as input `c` (keyboard E, gamepad Y). CPU taunt: `FUN_800b8ec4` (enter of the idle state 0x6c) calls `FUN_800b6ed8`, which counts idle entries per CPU (+0x800cadcc, starts rand(30)) and taunts past 0x4f (counter back to 0). Emulator check (L6, RAM 0x800cadcc + i*0xa4): CPU counters climb ~1 per second (11 -> 36 in 25 s) and restart at rand(30) each round, so a taunt is rare in the game too; our sim climbs at the same rate. Emulator rounds lasted ~30-45 s and the counters peaked ~45 before resetting, so a CPU taunt needs an unusually long round; 0 taunts in 100 simulated matches is consistent with that. Taunt voice = 0x800c94a8[char-1] = block*0x32 + 2 (Tank Wars banks 0182-0189), played on the taunt event.

## Not code-exact / left
- Turret control, human fire is tap-only like the disc; AI branches simplified in L5 mode choice; pickup drop height; double-shot life; bomb anim delay (4 f); no start countdown; `params.bounces` ignored; options 0x40/0x80 not ported; no emulator side-by-side comparison done for the port (only the L8 recording used for timings).
- `bot()` (web/shared/games/tankArena.ts) now returns the CPU AI input for a vacated human seat: it runs `aiFrame` for that slot and sets `t.bot = d.f + 1`, so `step()` applies the AI output that frame. Real CPU slots still run the AI inside `step()`.

## Effects (decoded)
Pack 0786 (db 0x8005365c, 19 scripts); 0784 (db 0x80053694, levels 6-8) parts 24-32 = smoke puff object 0x1306 (9 frames, node flag 0x21).
| weapon | shell object | muzzle (at the shell start, tank yaw, nodes flagged 0x20000000) | in flight | end (`FUN_800baffc` arg) |
|---|---|---|---|---|
| 11 | 0x130c | script 7 | - | script 10 |
| 8 | 0x130d | script 8 | script 2 every 8 frames | script 12 + 0x1306 |
| 9 | 0x130f | script 15 | - | script 13 + 0x1306 |
| 10 lob | 0x130e | script 6 | ground hop: script 9 (level 5: script 18 + splash sfx) | script 11 + 0x1306 |
| 2 double | 0x1302 | - | script 17 every 2 frames | 0x1306 (+ a level-db script 0, not resolved) |
- Bomb: script 0 at the tank on throw-clip frame 4 (`FUN_800b71f8`, object 0x130b); it lands in script 1 (`FUN_800bc27c`).
- Mine blast `FUN_800bd384`: script 16. Crate 0x1308 (`FUN_800be988`): script 3 when taken and when it lands on levels 5-7 (mode 5 descent, see "Pickups").
- Pickups (`FUN_800be7dc` init, `FUN_800be988`): every pickup starts in mode 5 as the 0786 part42 crate (shadow part41), y += 0x14 per tick; at y > -300 mines within 0x100 go off, levels 5-7 play script 3 + sfx 0x4b4 + rand(4) (levels 8-9 draw nothing), y = 0, vy = -0x28, mode 0 (bounce, gravity 8). Landed model by type: 2 0784 0x2007 (part6, spins +0x28), 3 0736 0x200c (part11), 4 0736 0x2018-0x2025 flip-book (blended), else 0784 0x2013 (part18); 6 spawns object 0x1303 instead.
- Wreck: script 14 + sfx 0x4f0 when the dying list ends. Read in `FUN_800c5620` (the level-9 boss tanks); assumed the same for players.
- `FUN_800bf548`: a shell touching one of the 3 pickups (slots 0x800cad44, box +-0xff on x/y/z) destroys it: script 16 + sfx 0x4b8 (ported: sim event `pkhit`). Shooting, wall bounces and laying a mine are sound only.

## Dropper (levels 5-7, `FUN_800be234`)
- Model: pack 0784's animated model, anim id 0x4080 = clip 1 = `group1_part13` (green rotor drone with a claw); child node 0x200f (part14)
  is its floor shadow (flags 0x40000041). Rides y = -0x400, yaw 0xc00 going +x (from x -0x800, vx 0x40) / 0x400 going -x (from 0x1800).
- Lane z = table 0x800ca600[level-5][rand(4)]: L5-7 {0x100, 0x500, 0xb00, 0xf00}, L8 {0x100, 0x500, 0x900, 0xd00}, L9 {0x300, 0x500, 0x900, 0xd00}.
  The rand(4) is drawn at spawn, before sfx 0x4f6.
