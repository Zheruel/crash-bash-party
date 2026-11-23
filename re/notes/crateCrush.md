# Crate Crush (overlay 0728.t5d, levels 0-3) - decoded rules

Source: `re/out_crateCrush/ovl.c`, `all.c`. Units: raw = game units (arena +-2048 raw = +-7.2 wu, `U = 7.2/2048`), rates per 30 Hz tick, angles 4096/turn.
Implemented in `web/shared/games/crateToss.ts` (sim), `web/client/games/crateToss.ts` (view).

## Levels
`DAT_8005a648`: 0 Jungle (bank 0167), 1 Space (0166), 2 Snow (0165), 3 Drain (0164). Match 90 s, HP 20, out at <= 0.
At the buzzer, `FUN_80084788` ranks surviving players by remaining HP. Equal leaders produce a TIE. The round also ends when one player remains. `FUN_800b6f0c` is the spectator force-victory callback. It keeps the first highest-HP survivor and knocks out the others.

## Pad (digital, 8-way)
Circle 0x2000 pick up / throw; Cross 0x4000 jump; Square 0x8000 spin attack; Triangle 0x1000.
On the default arrow-key layout, Z picks up or throws, X attacks, C jumps empty-handed and V taunts while stationary. Square takes priority over Circle, then Cross. A failed pickup can still lead to a jump on the same update. A button held through GO supplies no fresh press.

## Movement (`FUN_800859d4`, `80085d2c`)
- Velocity set directly per tick (no accel): walk 45, holding crate 30, boots +20 (chars 5-8 hold at 40). Table 0x8009d318.
- Facing `[0x18]` quantised to 8 directions; changes only when stick > 0x110 off. Throw / kick use it. Visual yaw turns diff/4 per tick.
- Snow uses quarter-unit velocity. The walk target is 180, or 45 raw units per update. Ground acceleration is 2 raw units, coasting deceleration is 1, and either rate becomes 32 above the floor. The L2 callback `800b44b0` shifts each signed native axis right by two before adding it to the position. Both velocity components matched 182 consecutive USA updates including a reversal, diagonal steering and a jump.
- Arena clamp radius `[+0x8a]` = 128/122/132/127/179/119/122/153 in engine character order, from each base model's part 0 shape 0x40. Player-player push moves only the mover. Player vs crate (`FUN_800c1a30`, `c284c`): distance 120 + crate radius 128 = 248, crate height 256 (0796 marker 0x40|0x10). The player is pushed only while moving, except on ice (`DAT_8005a5dc` = 3) or while hurt. The Snow elastic exchange is dead code because motion mass `+0x4e` is 0.
- Jump (`800860d4`, `80087fc0`): human characters 1–4 start at 108 and decelerate by 10. Characters 5–8 start at 72 and decelerate by 6. Releasing jump above velocity 64 subtracts 40. CPUs use the first row and run the full rise. A held jump peaks at 530 or 396 raw units. Fall entry (`800880e0`) resets speed to 8, adds 10 per update and caps at 112. Coco finishes her rise animation one update earlier. Touchdown tests the previous height and starts landing script 8 at frame 1.
- Across all eight stock characters, tap and hold traces matched the original height, script and render word on 431 samples. The custom characters use Cortex movement with their own jump animations.

### Ground animations and audio

The versus countdown advances idle script 1 on each of 99 locked updates. The four original actors matched all 396 render words in each L0–L3 opening. Number meshes 3, 2 and 1 become visible at updates 15, 43 and 71 and disappear for the last update of each interval. GO and the first playable pad arrive at update 99.

Snow Bash checks the previous velocity in `800874ec`. Releasing a direction enters idle script 1, frame 0. If either axis still has velocity on the next update, the player enters slide script 14 at frame 1. Returning to rest starts idle at frame 1. Renewed steering starts run script 5 at frame 0. Carrying uses scripts 16 and 17 even on the ice. The character and the carried crate use the same script phase.

The Snow bank maps all six scrape IDs (0x456–0x45b) to sample 34. The selected ID supplies the pitch. Walking uses the two foot markers in script 5 and positions their sound at the character. Carrying plays the two centered sounds embedded in script 17. Under the slowing potion, walking substitutes stage cue 0x41e for the first contact and skips the second. Jump and pickup sound on entry. Landing script 8 plays at the actor's position. Tiny's throw cue plays four updates before crate release.

Across eight controlled Snow runs, 1,078 movement render words matched. This comparison covers running, releasing, steering and restarting. Where a native arena hazard interrupted the fixture, comparison resumed at the next run entry. Two additional Cortex and Dingodile recordings matched all 364 poses and all 22 footfall, scrape, jump and landing cue times without interruption. Scrape pitch follows the web round's random draw. WebGL checked slide meshes for all eight original characters and sampled both custom models with their own clips.

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
- Hurt entry (`FUN_800bfd2c`) sets the pad lock `d574` = 30, which zeroes the pad in `80083e8c`. When it expires, the 40-update flicker `d570` starts. Entry ends the boots and empties a Drain weapon. The damage sound `d56c` (0x446 for spin, penguin and ring) plays when damage applies. Hurt script 9 lengths by engine character: 30,30,30,30,30,29,30,34. A lethal hit (`FUN_800bff1c`) stays in script 9 until event 8 (frames 11,14,19,15,19,19,11,10), which sets the out flag and switches to script 0x13; the voice plays at frames 11,14,13,13,19,19,11,10 (Cortex and Brio use event 9). The spirit (`FUN_800898ec`, 0x1c3/0x1c4) starts when script 0x13 ends. During invulnerability damage passes only if its class (`d56a & 0x300`) exceeds the previous: crate / explosion 0x200, spin / penguin 0. Held crate is dropped on hurt and breaks.
- Aku absorbs one hit: no HP loss, the hurt script runs without a pad lock, the effect ends with 0x421, no invulnerability. The `80084e04` handicap is disabled in versus (`DAT_8005a646&3` = 1).

## Effects (`FUN_800bef00`, `bede8`, `be9d0`)
0x12 Aku 300 ticks; 0x13 boots 240 (+20 speed); 0x14 weight 240 (pass by player contact: receiver timer +10, receiver lock 30 ticks, giver cleared; KO at 0); 0x15 slow 240 (player updates every other tick). Fruit +1 HP (cap 20), sfx 0x1c2 = sample 0.
Weight timeout (`FUN_800c09f4`, `c0bac`): 0x453, the holder is out at once and stays in idle script 1; the weight (0736 part1) drops 4096 raw at 256 per update, plays 0x455 on impact at update 16 and flattens the holder to 1/16 height; the spirit starts at update 44. The 0x452 loop pitch rises with (300-t)*0xf00/300. Passing plays 0x454. The head icon (`FUN_800bef00`) uses the pickup mesh (Aku part12, boots part9, weight part16, slow part8) and spins 0xaa per update.
Power-ups (Space and Snow only, `FUN_800b7358`): when no power-up is on the floor, kind 0x12 + rand(4), random cell, falls from the sky. If that kind is held by a player or the cell is taken, it retries next update. 0x41f on appearing, 0x420 on landing, then 0x41b Aku / 0x41c boots / 0x41d slow / 0x41a weight. Collection spawns dust 0x207 (0736 parts 37-52 flipbook); initial timer (rand(10)+10)*30; next 10-20 s after spawn, 5-15 s if someone has an effect; lifetime 120 ticks after landing. Ordinary Wumpa fruit persists until collection. A free reward from a thrown Drain chest expires after 150 updates.

## Spawner (`b710c`, `b7358`, `b7d20`, `b7e74`, `b8040`)
- 16x16 cell grid, centres -0x780 + 0x100*i, shuffled with 600 swaps (Drain uses the inner 12x12). Deck of 64 shuffled with 600 swaps, start index rand(32)+20.
- Deck (wood / TNT / nitro): Jungle 40/12/12, Space 40/16/8, Snow 40/12/12, Drain 56/8/0 (Drain wood -> kind 3).
- Initial crates: 8 (Jungle, Snow), 10 (Space), 6 (Drain).
- Floor cap by player count 2/3/4: Jungle and Snow 12/10/8, Space 14/12/10, Drain 6. Nitro cap `p*p7/16+1`: Jungle 3/2/2, Space 2/2/2; at cap nitro becomes wood.
- In four fresh USA versus recordings, the initial crates were visible at opening tick 0 with scale (4096, 512, 4096). Only Y grew, by 512 each update. They reached full height at 7 and became interactive at 8, well before GO at 99. Unlit TNT and Nitro kept mesh words 0x2009 and 0x2001. The online host runs the spawners through the locked opening and sends object birth ticks for countdown playback.
- `FUN_800bb7e8` counts crate kinds 1–12 toward the limit, including the four Drain question crates. Fruit, power-ups and weapons share a separate pickup count. The cap and Nitro tables are indexed by surviving players, including CPUs.
- Tick: counter 0 and count >= cap -> counter rand(40)+5; deficit < 4 -> n = rand(deficit)+1, counter rand(20)+8; else n = 4, counter rand(10)+2.
- Free cell: first from cursor that is unoccupied with 0 occupied 8-neighbours; after 9 tries the least crowded.
- Fruit: single spawner when floor fruit < 3, every rand(30)+10 ticks. Bursts (not Drain): first after (rand(10)+10)*30, each rand(4)+6 fruits 2-5 ticks apart, next in (rand(20)+30)*30; skipped when fruit >= 5.
- Drain: 4 chests (kind 2) at the edges, one weapon from list 0x800c46c0: 0x19 missile (ammo 2, cd 20), 0x1b orb (ammo 3, cd 20), 0x1c ring (ammo 1, cd 40). Taking a weapon removes the other chests; next chest after (rand(6)+2)*30. Initial timer rand(30)+30.

Drain uses one offset for the four edges. Each edge probes alternate cells around that offset for a free spot. One chest receives the next weapon in the 18-entry table at `0x800c46c0`. The initial table index and the winning chest use seeded draws.

Ground Wumpa persist until collected or lost through a hole. `FUN_8008d6c8` launches them at 64 raw units with gravity 8. Their rise repeats every 15 updates, peaking 224 units above the floor on updates 7 and 8. `FUN_8008da78` selects one of 14 sprite frames every two updates. The native rotation clock starts from the global display counter. The web clock starts at the arena opening. Two-client WebRTC and WebGL tests covered crate growth, Wumpa bounce, and the first playable pickup. Arena layouts and fruit appearance times depend on the web RNG.

## Drain weapons (`FUN_800b95f0`–`FUN_800ba8a4`)

- Missiles start 224 raw above the owner in eight 512-angle increments. Speed starts at 32, rises by 8 up to 160, and fall speed rises by 1 each tick. Floor contact or a player hull starts a floor blast.
- The orb starts 384 raw above the owner and locks once to the rival closest to its launch heading. It turns 1/8 of the error, with a minimum 64-angle correction, and approaches the target's height plus 160 within 512 raw. It detonates on hull or floor contact or after 101 updates, and leaves silently beyond ±4096 raw.
- Seven sonic waves start five ticks apart. Each uses mesh 0796 part20, expands in X and Z by 1280 per tick in 4.12 scale, and follows its owner at +256 raw. The probe uses the previous origin and the largest active wave's scale divided by 32, plus 64 raw. The last expansion still collides after the mesh is hidden. A hit queues 8 HP, damage class 0, and knockback 48.
- Both projectile blasts use the five scale triples from `0x800c3b08` on 0736 part15. The second update queues 8 HP in class 2 within 640 raw, skipping the owner and ignoring height. The web records the owner for match statistics. The projectile and ring probes use the exported character hulls and the web's grounded crate proxy.
- The pickup and held meshes are 0736 parts 10 (missiles), 14 (orb), and 11 (ring). Weapon icons use the game's character-specific fallback height. Drain bank 0164 pairs sample 23/24/25 with pickup ids `0x437`–`0x439`, sample 26/27/28 with ring/orb/missile launch ids `0x43a`–`0x43c`, and sample 32 with ring hit id `0x446`.

## Hazards
- Snow penguin (`FUN_800baa1c`, `b879c`, `b8c9c`; 0798.t29 body 212 raw, height 622): it sleeps in a 60-frame loop (snore 0x424 at 38) until a moving crate (`bf404`) or a spin (`c159c`) strikes it. Touching it or an explosion does not wake it. Waking plays 0x426 and 0x428 at frame 26, cancels a fruit burst and adds 600 to the burst timer; the run starts at frame 73. The run (mesh 0x2002, reach 384) uses t = 0x800 decreasing by 4, r = min(0x500, sin(t)*3>>3), angle += ((0x500-|r|)>>6)+0x28, and loops 0x427. The return script is 54 frames with 0x425 at 14. Contact: 5 HP, class 0, knock 0x60, sound 0x446. Crates are pushed out to 512, nitro explodes, idle and sliding crates are kicked outward with slot 0's kick row, a carried crate breaks.
- Snow glints (`FUN_800bab04`, `b8694`, type 0x1101): 9 quads of 0707 part0 within ±0x780; each shows rand(3)+1 updates and hides rand(15)+1.
- A crate struck by a moving crate with no owner: nitro explodes, TNT lights, wood stays. Lit TNT beeps when the fuse reaches 60, 30 and 0 and explodes on the next update.
- Space: `FUN_800b8314` populates an 8×8 grid of 512-unit floor tiles. The descriptors in `0711.t29` include each label `10*x + z` for `x=1..8`, `z=0..7`, giving 64 intact tiles at round start. Descriptor 5 (`0x5002`) is the caution skirt. `LAB_800bae98`, called by `FUN_8008e27c`, clears the one tile under a floor-height type 5–7 blast (TNT or Nitro). `FUN_800bac5c` returns `0x7fffffff` for that tile and `FUN_800bad70` marks its four spawn cells occupied. `FUN_800b8578` displays a skirt on an intact tile beside a hole along game X or toward game Z−.
- On dropping below a hole, `FUN_800882dc` snaps the player to its center, releases their crate, plays script 7 and sound `0x410` (Space bank 0166 sample 20), and starts a downward velocity of 8, acceleration 10, cap 112. `FUN_8008a854` advances the out state past 384 units below the floor. The native object integrator also lets crates and pickups descend through holes. The web view hides their floor shadows and the sim discards these objects after they fall below the arena.
- The Space opening rules screenshot (`docs/reference/crateToss/cc1_r1.png`) shows the intact floor and explains that explosive crates destroy it. The mid-round `assets/stages/placements/L1.json` capture has nine missing tops and 19 visible skirts, all matching the original neighbor rule.

## Sound (`FUN_80022660`, volume 0x1000, pitch 0x1e00)
Calls pass a sound id. Each level bank's VAB tones carry their own ids, so the id resolves per bank (0167 Jungle, 0166 Space, 0165 Snow, 0164 Drain); `BANK_IDS` in `web/client/games/crateToss.ts` holds the full tables. An id the bank does not declare is silent. Calls with a position are panned and attenuated.
- Break lists (`8e27c`, rand(4)): wood `e444` 0x3e8,0x3e8,0x3ea,0x3eb; TNT `e424` 0x3ec-0x3ef; nitro `e434` 0x3f1,0x3f1,0x3f3,0x3f4; Drain crates and chests `e454` 0x3f5,0x3f5,0x3f7,0x3f8.
- 0x3f0 TNT beep / light, 0x3f9 kick of wood or lit TNT, 0x3fa fruit spawn, 0x409 sky crate, 0x1c2 fruit, 0x1c3/0x1c4 spirit.
- Kick voice per kicker slot (`e2b4` 0x442-0x445), then 0x3f9 or 0x3f0. Damage 0x446.
- Power-ups 0x41a-0x421 and 0x452-0x455 (Space, Snow); penguin 0x424-0x428 (Snow bank 0165 declares only 0x426 and 0x427, so the rest are silent); weapons 0x437-0x43c (Drain).
- There is no throw whoosh, hit thump or dust on jump, land or knockout.

## Anim clips (char 1)
0 idle default, 1 idle (loop 22), 5 walk (footsteps 8/9), 6 jump rise, 7 descent, 8 landing, 9 hurt, 10 spin/kick, 11 ghost, 12 winner entry, 13 loaded celebration, 15 pickup, 16 hold idle, 17 hold walk, 18 throw, 19 lethal hit follow-through.

## CPU (`FUN_800b4ab0`)

- Port: `crushController` in `web/shared/games/crateToss.ts`. It works in game units (web Z = minus game Z) and 12-bit angles. Each update runs the `FUN_800b432c` hook first: it rebuilds the 20x20 grid at `0x8009d90c` (clear, object kinds, player marks `p<<5|0x80` on 3x3 cells, then 0xff for missing Space tiles or 0xf0 for the Snow rock with the penguin's 0x40). Then each CPU slot runs the controller in seat order. The native dispatch order is shuffled, and the port does not model that.
- Draws come from `FUN_80015590` on `d.cpuRandom` (the disc LCG, seeded at setup). Human seats run the controller on a copy, so a seat that drops to bot control keeps a route without changing the CPU stream. Polling (`crateToss.bot`) replays the pass on copies.
- Controller block `0x8009d54c`: `+0x0c` object, `+0x10` target (-1, slot, 6 penguin, 7..15 station), `+0x20` state, `+0x22` saved state, `+0x24` back-off, `+0x26` taunt cooldown, `+0x30` / `+0x32` timers, `+0x2a` pad heading, lane bytes `+0x34` / `+0x3c`. Motion yaw is `0x8009d544+0x14`, facing `+0x18`. Both equal the bearing plus 0x800.
- Each update draws `FUN_80015590(0x100)` first. Hurt (0xd) or out (0x13) forces state 6. States:
  - 1 search: only from player state 0 (idle). Taunt (state 21) when `+0x30` and `+0x26` are clear and the nearest opponent is farther than `skill*32+0x400`. Otherwise Drain fire, then `FUN_800b62ec` when `+0x32` is clear.
  - 2 object, 3 opponent, 4 station or penguin: flee heading (`FUN_800b46b8`), lane check (`FUN_800b6138`), fire (`FUN_800b4848`; Drain only in state 2), contact (`FUN_800864cc`; Square on a 1-in-3 draw in state 2, on the target or `(roll & 0x10) == 0` in state 3), and the object ahead (`FUN_800c2b60`). The target object ahead gives Circle (crates, fruit, Aku Aku, boots) or Square (chest, lit TNT, penguin). Obstacles give Square (crates, lit TNT, penguin), nothing (fruit, Aku Aku, boots) or Cross. Within 128 of a station, state 4 taunts.
  - 5 retreat: walks along `+0x14` until `+0x32` runs out. A fresh blockage only turns.
  - 6 / 7 hurt recovery: wait 5 updates, then hold L2 (yaw -0x100 per update) until `FUN_800bb100` finds the first three samples clear, then retreat 20 updates with a 180-update taunt cooldown.
  - 10 / 12 / 13 carry: draw a victim (`FUN_800b6da4`: the resting penguin on 1 in 10, else by weight), approach, then throw with Circle from carry idle or walk once the facing is within 0x155. State 12 throws when touching a player, when an object is ahead, inside the 256-unit band past `STANDOFF[slot] + (16-skill)*32`, or when the fuse of lit TNT is below a 4-way draw. Too close, it backs off for 10 updates away from the edge, or throws when facing outward.
  - 21 taunt: 4 updates, then one step toward the victim. It ends early when a CPU targeting this slot is within 1536.
- `FUN_800b6138` blocks on 0xff / 0xfe / kinds 6, 7, 0x14, 0x15 in the first three samples. A carrier switches to state 13. With a later sample also blocked, the yaw turns +0x31c and state 5 starts for 30 updates with the old state saved. The pad still heads for the target that update, so the turn is lost and the next update saves state 5. An isolated block presses Cross.
- `FUN_800b62ec` draws 0x100, 0x1000 (bias) and the stage's roam chance (Jungle 6, Space 3, Snow 4, Drain 8; one more 0x400 when `+0x30` is set). Object kinds: 1/3/4/5 resting crates `(0x1000-|d-bias|)*40`, chest 2 `|d-bias|*400` (>>8 while powered), penguin 0xe like an opponent, fruit 0x11 by health, 0x12/0x13/weapons `|d-bias|*250`. The current target is shifted down (8, 4, 8, 12, 8; opponents 6). Opponent interest accumulates over the slot loop and resets on an empty-handed opponent. A taunting opponent adds 0x20. Saved state 2/3/4 zeroes the object, opponent or roam score. Roam must beat both. Otherwise the object wins when strictly ahead, and the opponent when at least 0x15. The roam scan takes the first station farther than 0x7fffff squared from every other slot, eliminated ones included.
- Skills: Party rows at `0x8009d900` give 1/16/32 (Drain 1/16/28). Weights are 16. In Party, once only CPUs remain (`0x8009d908`), the hook gives every slot skill 26 and weight 16. It draws a live focus that gets skill 8 and weight 48. An eliminated focus is cleared, and a new one is drawn the next update.
- Inferred: `FUN_800c2b60` matches flags `& 3`, and a carried crate keeps bit 2, so a carrier in state 12 usually sees its own crate ahead and goes to the throw state at once. The AI's `FUN_800864cc` weight-passing side effect is left to the player bump. `+0x30` is never set in the overlay.
- Regressions: `web/scripts/test-crate-cpu.ts` (draw order and count, seeded replays, polling purity, and the lane, flee, hurt, L2, station taunt, throw and focus paths on all four stages).

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

### Drain Bash question crates

Spinning the question crate advances it through native states 9, 0xc and 0xd. The contents rise by 1,104 raw units and home toward marker 0x80 on the opener's current animation. Throwing it uses states 8, 0xe and 0xf. The crate releases at the hand on the event frame and first moves on the following update. Its reward bounces and any player can collect it on the descent. An unclaimed free reward expires after 150 updates. Collecting a weapon shrinks the other waiting chests over eight updates.

In the USA Brio capture, the crate released at frame 154, broke at 167, and snapped to the launch cell at 168. A second player intercepted it at frame 200. The traced missile and fruit throws both matched from release through collection. The original grip calculation differed by one height unit on the frame before release. Brio and Rilla Roo also threw past the arena edge and their crates broke on landing. Crowded player/crate contacts and whole-round RNG synchronization remain unverified.

Diagonal carry and throw traces exposed rounding before and after release. The grip now rotates each hand in 4.12 before calculating the crate transform. The throw integrates each signed component separately with the native shift. Rilla Roo's diagonal throw matched all 12 recorded positions from release to ground impact. Brio's opposite diagonal matched through the frame before a crate-on-crate contact. The same fixed-point length routine used on the disc supplies the hand tilt and reproduces the previously off-by-one Brio carry pose.

### Thrown crates landing on other crates

The descending ballistic callback asks `FUN_800bac5c` and `FUN_80025e00` for the closest surface in height. The 0796 support marker has radius 128 and the floor query adds 64. The moving crate snaps to that surface before the impact handler. A Drain reward starts at this impact height. Brio's thrown question crate landed at native (−774, −256, −506) even though it was 172 units from the supporting crate's centre. The old centre probe missed it. Replays with Brio and Cortex each matched 91 consecutive positions from release through the reveal and bounce. The Cortex setup placed the supporting crate during flight.

### Equal-health timeout

With the clock advanced to expiry and health set to 8 / 16 / 16 / 8, the USA game set its draw flag without marking any player a winner. The live characters remained visible while their current actions settled. The common TIE cue `0x1af` fired 23 updates after dispatch. Jungle reset after 120 updates. The web result leaves the Party and Cup awards at zero and keeps the arena visible for four seconds with the two-update TIE lead-in.

## Player object 0x8009d540 and the player grid

- `FUN_80083708` gives each player a second type-3 child (`0x8009d540`, 4 nodes) drawn with the character pack. Engine characters 3 and 4 use render word 0x2002 (part 1 of 0986 Cortex / 0984 Brio: a 16 px camera-facing additive glow); the others use word 0, which draws nothing. The engine clears its visible bit at the start of every player update.
- The crate states place its root node at model marker 0x40 (Cortex's ray-gun muzzle, Brio's flask; no other character has the marker). Pickup `800c013c` stores the raw bytes of 0x800c4790 as scale (X = byte 2, Y = byte 1, so about 2 %, effectively invisible). Carry `800c02d4` / `800c05a8` pulse X and Y by 1 + sin(((frame & 15) * 0x100 - 0x400)) / 8. Throw `800c07f4` uses 0x8009dc68 (X = column 2, Y = column 1: 5x, 4x/2x, 1.5x/1x, 0.5x/0.625x, 1/8x) for five updates, then hides it. The spin `8008900c` uses the same table with additive flag 0x20000000. Port: `web/client/games/crateToss.ts` `updateGlow`, markers `ON_FOOT_GLOW_MARKERS` from `tools/player_poses.py`.
- `FUN_80086d88` ORs `0x80 | slot << 5` into the 3x3 grid cells around every player each update (after `800bb7e8` marks objects). Crate, fruit and power-up spawns need an empty cell, so nothing spawns beside a player.
