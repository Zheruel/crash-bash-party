# Dragon Drop (overlay level id 27; "Ring Ding" is 28 in the swapped name table)

Source: `re/out_dragonDrop/ovl.c` (+ exe parts in `all.c`), checked against the emulator (`re/dumps/L27.*`, recordings of 4 bots over 78 s).
Implementation: `web/shared/games/dragonDrop.ts` (PS1 integer units, 30 Hz), view `web/client/games/dragonDrop.ts`.
Units are PS1 units per 30 Hz tick unless stated. Angles 4096/turn. World scale `S = 3.4/1024` (1 PS1 unit = 0.00332 world); ours: `x = x_ps1`, `z = -z_ps1`.
A point at angle a, radius r is `(x,z) = r*(-cos a, sin a)` (`FUN_8001463c(dx,dz)` returns the a for which this points along (dx,dz)).
`T[a]` = fixed sin table `DAT_80068bd6`; `x -= d*T[a-0x400]>>12; z -= d*T[a]>>12` moves along `-u(a)`.

## Level
- 90 s: timer `DAT_80099178` starts at `0x130<<8` (1:30; byte0 frames, -2/tick), ends at 0 (`FUN_800b4144`/`FUN_800b3edc`).
- Floor `DAT_8005a5d8 = -16` (y is up-negative). Hub radius ~838, ring top radius 896..2318, rim 2559. Outer limit radius `0x980` = 2432 for players and balloons (`FUN_800b8f48`).
- Score = short at player struct +0x50 (`0x8009d57c`, stride 0x6c). Plain mode only (flags 0x40/0x80 clear, team mode off).
- End: sort by score (bubble, stable); top two equal -> everyone draws (flag 0x100), else winner 0x200, others 0x400.
- Per-frame order `FUN_800b9048`: `FUN_80086f78`, `FUN_800b4ba4` (grid + counts), `FUN_80086d88` (players into grid), `FUN_800b4970` (timers/spawns), `FUN_800b3a3c` (ring).

## Ring (`FUN_800b3a3c`)
- Speed `DAT_800bc018` moves 1 per tick toward `dir*-13` (`DAT_800bc01c`, start +1, reverse `dir = -dir`): 0 -> -13 in 13 ticks, a reversal takes 26 ticks.
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
  chars 1-4 `128,6,11`; chars 5-8 `128,8,13`; bots (index 0) `136,9,11`. Rise: `v -= gu; if v > 0: h += v` else fall (state 0x35) with `v = 0`; fall: `v += gd; h -= v`; land at h <= 0.
  Apex 682 (chars 1-4), 567 (5-8), 774 (bots); airtime 23-26 ticks. Measured on the emulator (same numbers).
- Spin attack (square, ground only, no walking while spinning; ring still carries): crash/coco state 8 = 16 ticks, cortex/brio state 10 = 19, dingodile/koala state 9 = 14, tiny/rilla state 0xb (not measured, we use 18). Facing += 0x155/tick (states 8/9).
  Hits rivals (hitbox mask 0x400, `FUN_800864cc`) and opens crates (`FUN_800ba098(p,2,0x400,0)`). Reach measured: hits at 167-322 (some up to 530), some misses at 200-250 (cone/timing); we use a 300 disc (crates 330). It never pops balloons.
- Hit (state 0x33, `FUN_800b92bc/937c`): 37 ticks, no moving/jumping/attacking, ring carry applies. Caused by a spin hit (knockback 52 away from the attacker, -4.3/tick, 12 ticks) or by popping a wrong-colour balloon (no knockback). An airborne victim keeps its jump arc.
- Win/lose/dead states 0x36/0x37/0x38.
- Player-player collision `FUN_800ba514`: circles ~120 each (sum 240), pushed apart; measured minimum distance 210-240.
- Start: all four in the hub (radius ~300), facing the centre (`atan2 + 0x800`); real positions come from level data (picture `docs/reference/dragonDrop/real_start_p1.png`).
- Bot gear 2 set in setup (`+0x1a = 2` when `DAT_8005a670[i]` != 0).

## Balloons (object type 0x1802, attr +0x14 type 8..11 colour, 12 black; owner +0x24: 8->p1, 9->p2, 10->p3, 11->p0)
- Spawn `FUN_800b5d3c`: slot `(angle k*256, radius 0x500+0x140*r)` (16 angles x radii 1280/1600/1920/2240); height `floor - 0x600 - rand(128)`; drift speed `+0xe = rand(8)+4`;
  drift angle `+0x16 = (a + 0x800 - dir*0x200) & 0xfff` (straight tangential line); black stores outcome `rand(3)+4` at +0x24. States 3 -> 0 -> 1 (moving from the 3rd tick).
- Slot picker `FUN_800b4f7c`: table `0x800bbe10` (64 slots, 300 random swaps at start), cursor `DAT_800bbd5e`. Occupancy grid 20x20 of 256-unit cells (objects mark 2x2 cells around x/z +-0x80, players 3x3). QUIRK: the slot test treats (angle, radius) as (x, z): col `(a>>8)+10`, row `9-(r>>8)`. Walk from the cursor; skip occupied; accept the first slot with an empty 6x6 window; else best of 10 tries.
- Per tick (state 1, `FUN_800b6608`): flag 2|8 -> state 9; `+0x22 = 4`, `+0x2a = atan(-x,-z) + ringSpeed`; drift `d` along `+0x16`; outer limit (clamped: `+0x16 -= dir*0x200`);
  `FUN_800b6ec0`: magnet pull (below); other balloons (types 8..12) within +-256 height: dist < 0x100 hard push `0xff-dist` away; else dist < 0x400: `+0x22 = (0x400-dist)>>6` along the angle to the other; then pos -= `+0x22` along `+0x2a` (net: outward push of 4/tick);
  vertical ease: `diff = y + 0x300 - floor; if |diff| > 16: y -= diff>>6` (settles at y -784..-800, i.e. 768-784 above the floor; ~64 tick time constant). Render bob +-128 only.
- Pop touch (`FUN_800ba514`): jumping player, horizontal distance < 248, balloon centre above the player origin by 0..720. Last toucher in a tick (highest index) wins; pop resolved in state 9 one tick after the flag.
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
- Type 0x1801 attr 2, at a slot on the floor, grows 8 ticks, item pre-roll `[23,19][rand(2)]`. Opened only by a spin hit (flag 2): states 1 -> 9 -> 12 -> 13 (the crate flies to the player as the item, 1/4 of the way per tick to player y + 0x180, collected when within 8>>3 or touched).
- State 12 re-rolls from the toucher skill s: threshold `a = 32-s` (human) or `s` (bot); `rand(32) <= a` -> magnet (0x17) else hover boots (0x13). Human at skill 20: 41% magnet / 59% hover; bot 66% magnet.
- Hover boots 0x13: 240 ticks (sfx 0x5f3), the ring does not carry you. Magnet 0x17: 300 ticks (sfx 0x5f2). Upkeep `FUN_800b6c50`.

## Bot AI (`FUN_800b7508`, `FUN_800b85a4`, `FUN_800b8b5c`, `FUN_800b8c74`, `FUN_800b8294`) - ours is a simplified port
- Synthesises a pad. Skill s 0..32, noise `0x21 - s`. Target by weighted random: own-colour balloons `(s+20)*4`, crates 30, black 30, rivals that attack or hold a power-up `s*8`; score `|dist - rand(4096)| * weight`, highest wins. A foreign recolour zeroes the own-balloon weight; magnet raises balloon weights (`s<<5`), hover raises rivals/black.
- Modes (+0x20): 2 chase object, 3 chase rival, 0xd jump/attack (cross held 8 ticks), 6 wait, 0x15 triangle taunt (300). Jumps within 0x400 of an own/black balloon, spins near a crate or an adjacent rival; leads the target by the ring rotation; target jitter +-noise*16.
- Ours (`dragonDrop.bot`, stateless, uses a hash instead of `world.rng`): value `weight/(dist+400)` (own 10, black 2, crate 2 while empty-handed), balloons reachable by a jump only, aim lead for the drift, jitter `+-(0x21-20)*16` re-rolled per second, jump within 420, spin crates within 280 and rivals within 260 that are not behind in score.
  Our bots score ~0.86 per jump (real ~0.5) and keep ~5.0 colour balloons up (real 5.8): a little too good.

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
| 0x3fa | crate opened | 33 |
| 0x3f0, 0x41c | silent (slot 255) | - |
Pop particle effect id `DAT_800bb89c[owner] = [3,2,0,1,4]` (`FUN_8007a524`). Hit/jump voices live in the character voice banks (not mapped here). The client has no looping sfx API, so the ring loop (21) is not played.

## Animation clips (per-character models 928..942, 5 clips): idle 0, run 1, jump/action 2, hit 3, win/lose 4. Spin attack: no own clip in these models (client uses clip 2 while spinning the yaw by 0x155/tick). Real jump enters exe anim 0x2c.
## Camera: unchanged (`DD_CAM` fitted to `docs/reference/dragonDrop` frames; not read from code).

## Unknowns
Exact spin hit shape (cone vs disc) and range, tiny/rilla spin length, knockback for the 0xb/9/10 attacks (measured on 8/10 only), pop vertical window (transition 700-750, we use 720) and radius (~248), black-outcome rand argument, whether a tie for first only (we assume yes) draws, real start positions, hover boots' extra effects, human run speed (table says 50, never measured with a human), balloon-vs-balloon vertical overlap box (we use 256), exact item pickup range, full bot AI.

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
above were read against 0179 (Ring Ding's bank) and are superseded by `DD_SFX` in web/client/games/dragonDrop.ts:
pops 0x5dc-0x5eb = two ids per sample (9,9,10,10 / 11,11,12,12 / 13,13,14,14 / 15,15,16,16), ring loop 0x5ec = 17,
black 0x5ed = 18, recolour 0x5ee, reverse 0x5f0 = 21, pop others 0x5f1 = 22, magnet 0x5f2 = 23, hover 0x5f3 = 24, crate 0x3fa.
