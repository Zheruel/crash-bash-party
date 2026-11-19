# Crate Crush (overlay 0728.t5d, levels 0-3) - decoded rules

Source: `re/out_crateCrush/ovl.c`, `all.c`. Units: raw = game units (arena +-2048 raw = +-7.2 wu, `U = 7.2/2048`), rates per 30 Hz tick, angles 4096/turn.
Implemented in `web/shared/games/crateToss.ts` (sim), `web/client/games/crateToss.ts` (view).

## Levels
`DAT_8005a648`: 0 Jungle (bank 0167), 1 Space (0166), 2 Snow (0165), 3 Drain (0164). Match 90 s, HP 20, out at <= 0.
Timeout `FUN_800b6f0c`: highest HP alive wins, all other alive players are killed. Game also ends with one player left.

## Pad (digital, 8-way)
Circle 0x2000 pick up / throw; Cross 0x4000 jump; Square 0x8000 spin attack; Triangle 0x1000.
Web has only A / B: A = Circle, B = spin if a crate / rival is in reach, else jump (documented deviation).

## Movement (`FUN_800859d4`, `80085d2c`)
- Velocity set directly per tick (no accel): walk 45, holding crate 30, boots +20 (chars 5-8 hold at 40). Table 0x8009d318.
- Facing `[0x18]` quantised to 8 directions; changes only when stick > 0x110 off. Throw / kick use it. Visual yaw turns diff/4 per tick.
- Snow (ice, `800bb2bc`): velocity approaches target (walk 180, hold 120, boots +80; table 0x800c3984) by 8 per tick, decel 4. (180 looks fast - unverified.)
- Arena clamp radius `[+0x8a]` = 153/122/132/122 by character. Player-player push moves only the mover. Player vs crate radius 0x78 = 120.
- Jump (`800860d4`, `87fc0`), table 0x8009d354: ids 0-4 v0 108, max fall 114, fall accel 8, decel 10; ids 5-8 72/114/10/6.
  Rising: v -= 10 (40 if Cross released and v > 64); falling: v += 8 capped 114. Peak ~530 raw (1.86 wu), ~22 ticks airtime. Air steering allowed.

## Actions
- Spin (Square, `FUN_80088794`): yaw -0x155/tick, clip 9 ~26 ticks, event at ~tick 11. Player hit: 1 HP (`0x8001`), knock 0x30/tick, only if victim not hurt / invulnerable. Crates in hull get flag 2 + owner and are kicked. Clip state by char: 1-2 -> 8, 3-4 -> 10, 7-8 -> 9, else 0xb.
- Pick up (Circle, `FUN_80086fcc` -> `c1848`): centre 256 raw in front of quantised facing, radius 256, angle +-0x280; crate needs flag 1 and no rider. Circle pressed within 5 ticks of release with nothing found still plays the animation (clip 15, ~11 ticks -> state 0xf hold idle). Picking up TNT lights it.
- Throw (clip 18, ~16 ticks; event 0x12 ~tick 2, release 0x13 ~tick 9). Table 0x8009e3b4 char 1: horizontal v0 113, max 128, decel 6; vertical 32 rising, max 80, rise decel 9 then fall accel 9. Integrator `FUN_8007a26c`: v += accel - decel, clamp [0,max]. Ground contact: wood breaks, TNT / nitro explode.
- Kick (crate state 0xb): table 0x8009e3dc char 1: speed 112, max 128, decel 4 (~28 ticks, ~1568 raw). 8-way direction `(angle+0x100)&0xe00`. Hits a player after 2-tick grace -> break / explode. Wall: kinds 3/4 break, others stop. Kicked TNT is lit (90 ticks); kicked nitro explodes at once (mode 0: hurts everyone incl. kicker).

## Crate kinds (`FUN_800bba14`)
1/2 special (2 = Drain "?" chest: pickable + hittable, pops an item); 3 Drain wood (3 HP, anim 0x2008); 4 wood (5 HP, 0x2013); 5 TNT (0x2009, flag 0x100, fuse `[0x22]` = 90 ticks, beep sfx 0x3f0 every 30 ticks); 6 nitro (0x2001, flags 2|8, not pickable, explodes on touch); 7 lit TNT.
States: 0 init, 1 idle, 2 carried, 6 spawn-grow (+0x200 scale/tick, 8 ticks), 7 TNT lit, 8 thrown, 9 kicked -> 0xb slide, 10 chain-delay (10 ticks), 0xc/0xe/0xf/0xd item pop-out.
Player landing on TNT lights it; landing on nitro explodes it.

## Damage (`FUN_80084e04`, table 0x8009d3b8, 8.8 fixed, handicap 0)
- Types: 3 -> 3 HP, 5 -> 5 HP, 8 -> 8 HP. Wood type 5 (Drain kind 3 -> type 3), TNT / nitro type 8.
- Break / explosion (`8e27c` -> `8dec8`): radius 0x280 = 640 raw for ALL kinds. Mode 1 skips thrower / kicker `[0x16]`; mode 0 hits all. Height tolerance 0xa0 (nitro none); jumpers well above are safe.
- Knockback (non-ice): (640 - dist) >> 3 away from blast, decays 4/tick. Ice sets velocity vectors.
- Chain: TNT / nitro (flag 0x100) within 640 and |dy| < 0x80 explode 10 ticks later.
- Only the largest pending damage per tick applies.
- Hurt 30 ticks (`d574` = 0x1e, clip 10 ~15 ticks), then 40 ticks flicker invulnerability (`d570`). During invulnerability damage passes only if its class (`d56a & 0x300`) exceeds the previous: crate / explosion 0x200, spin / penguin 0. Held crate is dropped on hurt and breaks.
- Aku absorbs one hit: no HP loss, effect ends, no invulnerability.

## Effects (`FUN_800bef00`, `bede8`, `be9d0`)
0x12 Aku 300 ticks; 0x13 boots 240 (+20 speed); 0x14 weight 240 (pass by player contact: receiver timer +10, receiver lock 30 ticks, giver cleared; KO at 0); 0x15 slow 240 (player updates every other tick). Fruit +1 HP (cap 20), sfx 0x1c2 = sample 0.
Power-ups (Space and Snow only): when nobody has an effect, kind 0x12 + rand(4), random cell, falls from the sky; initial timer (rand(10)+10)*30; next 10-20 s after spawn, 5-15 s if someone has an effect; lifetime 120 ticks after landing. Fruit lifetime ~150 ticks.

## Spawner (`b710c`, `b7358`, `b7d20`, `b7e74`, `b8040`)
- 16x16 cell grid, centres -0x780 + 0x100*i, shuffled with 600 swaps (Drain uses the inner 12x12). Deck of 64 shuffled with 600 swaps, start index rand(32)+20.
- Deck (wood / TNT / nitro): Jungle 40/12/12, Space 40/16/8, Snow 40/12/12, Drain 56/8/0 (Drain wood -> kind 3).
- Initial crates: 8 (Jungle, Snow), 10 (Space), 6 (Drain).
- Floor cap by player count 2/3/4: Jungle and Snow 12/10/8, Space 14/12/10, Drain 6. Nitro cap `p*p7/16+1`: Jungle 3/2/2, Space 2/2/2; at cap nitro becomes wood.
- Tick: counter 0 and count >= cap -> counter rand(40)+5; deficit < 4 -> n = rand(deficit)+1, counter rand(20)+8; else n = 4, counter rand(10)+2.
- Free cell: first from cursor that is unoccupied with 0 occupied 8-neighbours; after 9 tries the least crowded.
- Fruit: single spawner when floor fruit < 3, every rand(30)+10 ticks. Bursts (not Drain): first after (rand(10)+10)*30, each rand(4)+6 fruits 2-5 ticks apart, next in (rand(20)+30)*30; skipped when fruit >= 5.
- Drain: 4 chests (kind 2) at the edges, one weapon from list 0x800c46c0: 0x19 missile (ammo 2, cd 20), 0x1b orb (ammo 3, cd 20), 0x1c ring (ammo 1, cd 40). Taking a weapon removes the other chests; next chest after (rand(6)+2)*30. Initial timer rand(30)+30.

## Hazards
- Snow penguin: contact 5 HP (`0x8005`), knock 0x60/tick, pushes and triggers crates.
- Space: 8x8 stage-object tiles of 512 raw; a missing tile is a permanent hole (ground height 0x7fffffff) -> fall. Layout: set once at load (cells with no floor object get flag 0x100; nothing removes tiles later; `FUN_800bad70` marks them occupied so nothing spawns there). Emulator dump (rows = game x cell, cols = game z cell, # hole): `........|........|#..#....|..#..#..|.....#.#|....#..#|.#....#.|..#.....` (11 holes). Sim `SPACE_HOLES`; falling = KO.

## Sound (`FUN_80022660`; sample numbers of the level bank, Jungle / Space / Snow / Drain)
- 0x3f0 TNT beep 13/13/12/13; 0x3f9 kick thump 18/18/19/22; 0x3fa 19/19/17/17; 0x409 32/32/33/33; 0x1c2 fruit 0 (all).
- Wood break list (`e444`: 0x3e8,0x3e8,0x3ea,0x3eb): 9,9,9,10 (all banks).
- TNT blast (`e424`: 0x3ec-0x3ef): 11,12,11,12; Snow 11,11,11,11; Drain 11,12,13,12.
- Nitro blast (`e434`: 0x3f1,0x3f1,0x3f3,0x3f4): 14,14,14,15; Snow 13,13,13,14; Drain 14,14,16,17.
- Break variant (`e454`: 0x3f5,0x3f5,0x3f7,0x3f8): 16,16,16,17; Snow 15,15,17,18; Drain 18,18,20,21.
- Hit voice per player (`e2b4` 0x442-0x445), Jungle 33-36.

## Anim clips (char 1)
0 idle default, 1 idle (loop 21), 5 walk (loop ~20, footsteps 8/9), 6 jump up (~46 ticks -> state 5), 7 air, 8 ~27 ticks, 9 spin / kick, 10 hurt (15), 11 ~20, 12 KO (56), 13 34, 15 pick up (11 -> state 0xf), 16 hold idle (loop 20), 17 hold walk (loop 21, footsteps 10/11), 18 throw, 19 43.

## Not decoded / assumptions
AI per difficulty (`FUN_800b4ab0`, ~600 lines; existing bot kept, adapted); camera (fitted cameras kept); exact weapon damage (orb 3 / missile 2 / ring 5 placeholders); crate hull height (~240 raw), carry height (~560 raw), spin hit radius (330 raw) are estimates; Space tile layout; ice speed sanity; crate kind 1.
Emulator verification: not completed (see report).

## Presentation (verified against native frames)
- Camera: mode 1 (fit-all, FUN_80096f98) on the living players, r 512 / h 1280 / reach 1024; pitch 402 (L0, L3), 403 (L1), 428 (L2), H 512, target 0. Port `Ps1Follow` is bit-exact on 30 Hz emulator traces of all four levels.
- Sim raw units = PS1 units (x, y; z mirrored), so the stage is the level's placements (L0-L3) at scale 3.6, offset 0. Characters are drawn at native raw size (entity scale 0x1000).
- Models in RAM: crates / blasts 0796 (0-6 nitro anim, 7 Drain crate, 8-14 TNT anim, 15-17 TNT 1/2/3, 18 stone crate, 19 '?' chest, 20 blast cylinder, 22/30/44 flashes, smoke 23/24 32/33 40/41, shards 25-27 34-39 45-48, 42 star, 43 rock); pickups 0736 (0 shadow, 1 weight, 8 slow-mo, 9 boots, 12 Aku Aku, 13/10 missiles, 11 ring, 14 orb, 23-36 wumpa spin, 37-47 dust); Snow penguin 0798 (part0, 3 clips; part2 = sleep 'Z').
- HUD: faces (0731) at x 32/128/320/416, wumpa icon (0735 tex000) at x-8, health bar x+16 y 47, 52 px = 20 HP (green #84FB42..#396910 rows over red #C60000); clock M:SS in the big orange glyphs at x 205/238/261, colon at 226 blinking.
