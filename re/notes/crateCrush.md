# Crate Crush (overlay 0728.t5d, levels 0-3) - decoded rules

Source: `re/out_crateCrush/ovl.c`, `all.c`. Units: raw = game units (arena +-2048 raw = +-7.2 wu, `U = 7.2/2048`), rates per 30 Hz tick, angles 4096/turn.
Implemented in `web/shared/games/crateToss.ts` (sim), `web/client/games/crateToss.ts` (view).

## Levels
`DAT_8005a648`: 0 Jungle (bank 0167), 1 Space (0166), 2 Snow (0165), 3 Drain (0164). Match 90 s, HP 20, out at <= 0.
Timeout `FUN_800b6f0c`: highest HP alive wins, all other alive players are killed. Game also ends with one player left.

## Pad (digital, 8-way)
Circle 0x2000 pick up / throw; Cross 0x4000 jump; Square 0x8000 spin attack; Triangle 0x1000.
On the default arrow-key layout, Z picks up or throws, X attacks, C jumps empty-handed and V taunts while stationary. Square takes priority over Circle, then Cross. A failed pickup can still lead to a jump on the same update. A button held through GO supplies no fresh press.

## Movement (`FUN_800859d4`, `80085d2c`)
- Velocity set directly per tick (no accel): walk 45, holding crate 30, boots +20 (chars 5-8 hold at 40). Table 0x8009d318.
- Facing `[0x18]` quantised to 8 directions; changes only when stick > 0x110 off. Throw / kick use it. Visual yaw turns diff/4 per tick.
- Snow uses quarter-unit velocity. The walk target is 180, or 45 raw units per update. Ground acceleration is 2 raw units, coasting deceleration is 1, and either rate becomes 32 above the floor. The L2 callback `800b44b0` shifts each signed native axis right by two before adding it to the position. Both velocity components matched 182 consecutive USA updates including a reversal, diagonal steering and a jump.
- Arena clamp radius `[+0x8a]` = 128/122/132/127/179/119/122/153 in engine character order, from each base model's part 0 shape 0x40. Player-player push moves only the mover. Player vs crate radius 0x78 = 120.
- Jump (`800860d4`, `80087fc0`): human characters 1–4 start at 108 and decelerate by 10. Characters 5–8 start at 72 and decelerate by 6. Releasing jump above velocity 64 subtracts 40. CPUs use the first row and run the full rise. A held jump peaks at 530 or 396 raw units. Fall entry (`800880e0`) resets speed to 8, adds 10 per update and caps at 112. Coco finishes her rise animation one update earlier. Touchdown tests the previous height and starts landing script 8 at frame 1.
- Across all eight stock characters, tap and hold traces matched the original height, script and render word on 431 samples. The custom characters use Cortex movement with their own jump animations.

## Actions
- Spin (Square, `FUN_80088794`): yaw -0x155/tick, clip 9 ~26 ticks, event at ~tick 11. Player hit: 1 HP (`0x8001`), knock 0x30/tick, only if victim not hurt / invulnerable. Crates in hull get flag 2 + owner and are kicked. Clip state by char: 1-2 -> 8, 3-4 -> 10, 7-8 -> 9, else 0xb.
- Pick up (Circle, `FUN_80086fcc` -> `c1848`): centre 256 raw in front of quantised facing, radius 256, angle +-0x280; crate needs flag 1 and no rider. On an empty reach, the handler clears the previous Circle bit. A held button retries on the next update without entering the lift animation. In L0–L3 recordings, Circle was held for 21 updates before a wooden crate moved within reach. Each pickup started on the first eligible update. Picking up TNT lights it.
- Cross leaves a carrier grounded in carry idle and carry walk. A stationary human needs a fresh Circle press to throw. The carry-walk handler tests the held bit, so moving with Circle held enters the throw on the next update.
- Throw (clip 18, ~16 ticks; event 0x12 ~tick 2, release 0x13 ~tick 9). Table 0x8009e3b4 char 1: horizontal v0 113, max 128, decel 6; vertical 32 rising, max 80, rise decel 9 then fall accel 9. Integrator `FUN_8007a26c`: v += accel - decel, clamp [0,max]. Ground contact: wood breaks, TNT / nitro explode.
- Kick (crate state 0xb): table 0x8009e3dc char 1: speed 112, max 128, decel 4 (~28 ticks, ~1568 raw). 8-way direction `(angle+0x100)&0xe00`. Hits a player after 2-tick grace -> break / explode. Wall: kinds 3/4 break, others stop. Kicked TNT is lit (90 ticks); kicked nitro explodes at once (mode 0: hurts everyone incl. kicker).

Held crate transforms come from each character pose's model markers (FUN_80015780). The crate handler uses the two-hand tags 0x10 and 0x20 for translation, pitch and yaw, or tag 1 directly. The exported grip tracks cover all eight characters' pickup, idle, moving and throw scripts.

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

## Drain weapons (`FUN_800b95f0`–`FUN_800ba8a4`)

- Missiles start 224 raw above the owner in eight 512-angle increments. Speed starts at 32, rises by 8 up to 160, and fall speed rises by 1 each tick. Floor contact or a player hull starts a floor blast.
- The orb starts 384 raw above the owner and locks once to the rival closest to its launch heading. It turns 1/8 of the error, with a minimum 64-angle correction, and approaches the target's height plus 160 within 512 raw. It detonates on hull or floor contact or after 101 updates, and leaves silently beyond ±4096 raw.
- Seven sonic waves start five ticks apart. Each uses mesh 0796 part20, expands in X and Z by 1280 per tick in 4.12 scale, and follows its owner at +256 raw. The probe uses the previous origin and the largest active wave's scale divided by 32, plus 64 raw. The last expansion still collides after the mesh is hidden. A hit queues 8 HP, damage class 0, and knockback 48.
- Both projectile blasts use the five scale triples from `0x800c3b08` on 0736 part15. The second update queues 8 HP in class 2 within 640 raw, skipping the owner and ignoring height. The web records the owner for match statistics. The projectile and ring probes use the exported character hulls and the web's grounded crate proxy.
- The pickup and held meshes are 0736 parts 10 (missiles), 14 (orb), and 11 (ring). Weapon icons use the game's character-specific fallback height. Drain bank 0164 pairs sample 23/24/25 with pickup ids `0x437`–`0x439`, sample 26/27/28 with ring/orb/missile launch ids `0x43a`–`0x43c`, and sample 32 with ring hit id `0x446`.

## Hazards
- Snow penguin: contact 5 HP (`0x8005`), knock 0x60/tick, pushes and triggers crates.
- Space: `FUN_800b8314` populates an 8×8 grid of 512-unit floor tiles. The descriptors in `0711.t29` include each label `10*x + z` for `x=1..8`, `z=0..7`, giving 64 intact tiles at round start. Descriptor 5 (`0x5002`) is the caution skirt. `LAB_800bae98`, called by `FUN_8008e27c`, clears the one tile under a floor-height type 5–7 blast (TNT or Nitro). `FUN_800bac5c` returns `0x7fffffff` for that tile and `FUN_800bad70` marks its four spawn cells occupied. `FUN_800b8578` displays a skirt on an intact tile beside a hole along game X or toward game Z−.
- On dropping below a hole, `FUN_800882dc` snaps the player to its center, releases their crate, plays script 7 and sound `0x410` (Space bank 0166 sample 20), and starts a downward velocity of 8, acceleration 10, cap 112. `FUN_8008a854` advances the out state past 384 units below the floor. The native object integrator also lets crates and pickups descend through holes. The web view hides their floor shadows and the sim discards these objects after they fall below the arena.
- The Space opening rules screenshot (`docs/reference/crateToss/cc1_r1.png`) shows the intact floor and explains that explosive crates destroy it. The mid-round `assets/stages/placements/L1.json` capture has nine missing tops and 19 visible skirts, all matching the original neighbor rule.

## Sound (`FUN_80022660`; sample numbers of the level bank, Jungle / Space / Snow / Drain)
- 0x3f0 TNT beep 13/13/12/13; 0x3f9 kick thump 18/18/19/22; 0x3fa 19/19/17/17; 0x409 32/32/33/33; 0x1c2 fruit 0 (all).
- Wood break list (`e444`: 0x3e8,0x3e8,0x3ea,0x3eb): 9,9,9,10 (all banks).
- TNT blast (`e424`: 0x3ec-0x3ef): 11,12,11,12; Snow 11,11,11,11; Drain 11,12,13,12.
- Nitro blast (`e434`: 0x3f1,0x3f1,0x3f3,0x3f4): 14,14,14,15; Snow 13,13,13,14; Drain 14,14,16,17.
- Break variant (`e454`: 0x3f5,0x3f5,0x3f7,0x3f8): 16,16,16,17; Snow 15,15,17,18; Drain 18,18,20,21.
- Hit voice per player (`e2b4` 0x442-0x445), Jungle 33-36.

## Anim clips (char 1)
0 idle default, 1 idle (loop 22), 5 walk (footsteps 8/9), 6 jump rise, 7 descent, 8 landing, 9 hurt, 10 spin/kick, 11 ghost, 12 winner entry, 13 loaded celebration, 15 pickup, 16 hold idle, 17 hold walk, 18 throw, 19 lethal hit follow-through.

## CPU (`FUN_800b4ab0`)

- The Party rows pointed to by `0x8009d900` give Easy/Normal/Hard skills of 1/16/32 in Jungle, Space and Snow, and 1/16/28 in Drain.
- `FUN_800b62ec` compares object, opponent and roaming scores. Roaming must strictly beat both other scores. The opponent wins a tie with an object if the opponent score is at least 21.
- The roaming scan checks IDs 7–15 at `0x800c3a58`, including the center. It selects the first station at least `0x7fffff` squared raw units from every other slot. The scan uses eliminated slots' positions and can leave the target empty. Floor hazards are handled on approach. Within 128 raw of a station, state 4 chooses a taunt target through `FUN_800b6da4` and enters state 21 with a four-tick wait.
- The two forward lanes at ±120 raw check distances 352, 608 and 864 along the current heading (`FUN_800b5e28` / `FUN_800b6138`). An isolated blockage triggers a held jump. With the first sample and at least one later sample blocked, an empty-handed CPU clears both targets, saves the previous route state at `+0x22`, and retreats for 30 ticks. On expiry it returns to search. State 2 suppresses the object score, 3 suppresses the opponent score, and 4 suppresses roaming. A failed search retains the saved state. A successful search clears it, even if the station scan came back empty. Another blockage during the retreat restarts the timer with saved state 5, which suppresses no score.
- In Party, the elimination check `FUN_80084788` sets `0x8009d908` when only CPUs remain in play. This also takes the first elimination in a room that starts with four CPUs. `FUN_800b432c` gives every slot skill 26 and weight 16, then draws a live focus slot and gives it skill 8 and weight 48. The skill feeds regular decisions. The weight is used by `FUN_800b6da4` for opponent draws while carrying and when taunting. When the focus goes out, the hook clears it and draws again on the following tick.
- A carried crate changes the target to a live opponent, or sometimes the resting Snow penguin. Throw range starts at 1280/1024/1024/1536 by slot plus `(16-skill)*32`, followed by a 256-unit aim band. The bot backs off for ten ticks when too close and aims for five ticks before throwing within a 30-degree cone. A grounded long-range taunt has a 300-tick cooldown.
- Bots steer away from the active penguin within 1536 raw and opponents holding the weight within 1024 raw. Drain bots seek chests and weapon pickups, with short-range ring and aimed projectile checks.
- Verification used controlled MIPS replays against the US disc's L0–L3 RAM snapshots with all three Party skill rows and mixed and all-CPU seat masks. The replays held actor positions fixed while stepping the native controller, seeded the native RNG for branch coverage, and isolated contact and rendering calls. Web regressions replay the resulting decisions through `web/scripts/test-crate-cpu.ts`. The port uses deterministic per-decision draws and web hazard, steering and collision geometry. Whole-match shared RNG parity remains unverified.

## Not decoded / assumptions
Crate hull height (256 raw) and per-pose spin cylinders come from the model shapes. Crate kind 1 still needs verification.
Full-match frame agreement is still unverified.

## Presentation (verified against native frames)
- Camera: mode 1 (fit-all, FUN_80096f98) on the living players, r 512 / h 1280 / reach 1024; pitch 402 (L0, L3), 403 (L1), 428 (L2), H 512, target 0. Port `Ps1Follow` is bit-exact on 30 Hz emulator traces of all four levels.
- Sim raw units = PS1 units (x, y; z mirrored), so the stage is the level's placements (L0-L3) at scale 3.6, offset 0. Characters are drawn at native raw size (entity scale 0x1000).
- Models in RAM: crates / blasts 0796 (0-6 nitro anim, 7 Drain crate, 8-14 TNT anim, 15-17 TNT 1/2/3, 18 stone crate, 19 '?' chest, 20 blast cylinder, 22/30/44 flashes, smoke 23/24 32/33 40/41, shards 25-27 34-39 45-48, 42 star, 43 rock); pickups 0736 (0 shadow, 1 weight, 8 slow-mo, 9 boots, 12 Aku Aku, 13/10 missiles, 11 ring, 14 orb, 23-36 wumpa spin, 37-47 dust); Snow penguin 0798 (part0, 3 clips; part2 = sleep 'Z').
- HUD: faces (0731) at x 32/128/320/416, wumpa icon (0735 tex000) at x-8, health bar x+16 y 47, 52 px = 20 HP (green #84FB42..#396910 rows over red #C60000); clock M:SS in the big orange glyphs at x 205/238/261, colon at 226 blinking.

## USA individual versus result

Frame 0 is the first 30 Hz update with the verdict flag 0x800. The USA disc was run in PCSX ReARMed. Controlled fixtures in L0–L3 set the clock and health or queued lethal damage, then let the original result dispatcher run. The jump and carried-crate cases used native pad input or a seeded grip state before the verdict.

| Native case | Winner entry | Script 0x0d | Name / wins / reaction |
| --- | ---: | ---: | ---: |
| Jungle, standing Koala | 1 | 12 | 32 / 59 / 90 |
| Space, standing Crash | 1 | 14 | 32 / 57 / 88 |
| Snow, standing Koala | 1 | 16 | 32 / 59 / 90 |
| Drain, standing Rilla | 1 | 14 | 32 / 56 / 87 |
| Jungle, airborne Koala | 19 | 31 | 50 / 77 / 108 |
| Jungle, carrying Koala | 28 | 39 | 59 / 86 / 117 |

- Winner entry `FUN_800c0f14` starts state 0x14 and script 0x0c and ducks music. The next update starts the quarter-angle turn toward yaw zero. `FUN_80085890` switches to script 0x0d when the celebration data arrives. Measured loading delays were 11–15 updates after entry, with a one-update difference between Koala captures on Jungle.
- Airborne actors finish the rise, descent and landing. The Jungle Koala switched to script 7 at frame 9, contacted the floor and played script 8 and sound 0xd5 at 18, and entered the result at 19. The Space Tiny replay also entered at 19. Snow Dingodile and Drain Crash entered at 18.
- The carry-idle and carry-run handlers route result flags into the normal throw script (0x12). Jungle Koala entered the throw at 1 and released at 7. Space Coco and the Snow and Drain Crash captures released at 9. Coco entered the win at 18 and Crash at 17. A generic descent can detach the crate through the native state-4 drop path. Crates in flight continue moving and can break or detonate after the decision.
- Timeout losers keep playing until they can enter state 0x0c with idle script 1. They remain visible in the arena and leave the camera list on entry. The Space trace removed its three losers at 16, 22 and 34 while they cleared their carry and throw routines. Eliminated players use model 0792 and loop ghost script 0x0b, rise by 24 raw units per update and leave the fit. The knockout trace played 0x1c3 or 0x1c4 for each of the three eliminated players.
- The result stays in camera mode 1. `FUN_80078dd4` gives each tracked actor 256 horizontal half-width, 960 half-height and zero depth extent from frame 0. With the recorded tracking lists and positions, the port matched all three native translation components for 1,765 updates across 15 captures. Space moved from (280, −626, 5052) to (1732, −967, 3426) by frame 119. Drain moved from (292, −659, 5013) to (1732, −978, 3418).

Before the change, the normal Jungle client left a test winner at 1.51 world units above the floor with the crate attached and all four actors still in the fit. The announcer sequence started from the verdict at approximately frames 31, 56 and 87. The updated client starts it from winner entry and advances poses, objects and the camera in a private copy of the terminal snapshot. Its arena holds for five seconds in normal match timing. The shared score and placement messages still come from the host.

The replay matched winner entry and vertical position across 16 native fixtures initialized from the recorded actor state. The normal browser client ran all four stages, including Top G landing in Space with a separate airborne crate, Big Stein throwing in Snow, and a Top G win with knockout ghosts in Drain. The custom characters use Cortex's timing with their own models, grip markers and voice recordings. The worker-hosted Space test delivered equal terminal snapshots, placements and scores to a late spectator.

The web uses measured delays for preloaded celebration assets. Arbitrary disc streaming times, the console RNG sequence for spirit sparks, and exact crate collision and hazard trajectories during the result remain outside the verified match. The web assembles the opening camera from its own view history or a terminal-position fit on late join.
