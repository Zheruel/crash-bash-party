# Mini-games (web/shared/games)

The ten party mini-game families follow the real Crash Bash (PS1, 2000) games. Game ids are unchanged so clients keep working;
names, rules, controls and level variants follow the disc (text files 0141-0152, level names from `arenas.md` §3).

| id | Real game | Levels (variant ids) | maxTime |
|---|---|---|---|
| `ballDefence` | Ballistix | `crashball` CRASHBALL, `beach` BEACH BALL, `nballism` N.BALLISM, `sky` SKY BALLS | 240 s |
| `pushOff` | Polar Push | `tilt` TILT PANIC, `polar` POLAR PANIC, `melt` MELT PANIC, `manic` MANIC PANIC | 90 s |
| `tilePainter` | Pogo Painter | `pogo` POGO PAINTER, `agogo` POGO-A-GOGO, `elpogoloco` EL POGO LOCO, `padlock` POGO PADLOCK | 90 s |
| `tankArena` | Tank Wars | `swamp` SWAMP FOX, `desert` DESERT FOX, `jungle` JUNGLE FOX, `metal` METAL FOX | 90 s |
| `crateToss` | Crate Crush | `jungle` JUNGLE BASH, `space` SPACE BASH, `snow` SNOW BASH, `drain` DRAIN BASH | 90 s |
| `dashRace` | Crash Dash | `dot` DOT DASH, `toxic` TOXIC DASH, `splash` SPLASH DASH, `dante` DANTE'S DASH | 90 s |
| `ringDing` | Ring Ding | Clock tower, balloons | 90 s |
| `dragonDrop` | Dragon Drop | Dinosaur riders, jewel target | 90 s |
| `malletMash` | Mallet Mash | Mallets and mushrooms | 90 s |
| `kegKaboom` | Keg Kaboom | Gunpowder trails and kegs | 90 s |

(Boss levels BIG BAD FOX, BEARMINATOR and the TIE-BREAKER are not part of the party.)

## Common conventions

* `MiniGame.variants: {id, name}[]`. `setup()` picks one from `world.rng` and stores the id in `world.data.variant`.
  For tests/dev pages, set `world.data.variant = '<id>'` before calling `setup()` and it is honoured
  (`pickVariant` in `games/common.ts`). Variant display names are in the exported `*_VARIANTS` arrays
  (`BD_`, `PO_`, `TP_`, `TA_`, `CT_`, `DR_`).
* Deterministic: only `world.rng` (via `rand`) is used. Each CPU runs its game’s decision routine once per simulation tick.
* On PC, use the arrow keys to move and Z, X, C and V for actions `a` through `d`. Q and E operate `l` and `r`.
  WASD also works with J, K, L and H for actions and I and O for the shoulders. Space, Shift and F also activate `a`, `b` and `c`.
  Each stage’s rules and pause menu show its bindings as keycaps. Touch players see the corresponding pad glyphs.
* Elimination games keep dead players' bodies in `world.bodies` with `alive = false` (and `fall = true` while falling).
* Events: `GameEvent {k, x, z, s, o, v}`; `s` = affected slot, `o` = other/attacker slot, `v` = magnitude. `hit` with `s,o >= 0`
  and `ko` with `s,o >= 0` feed party stats (damage dealt / knockouts), so only emit those with real attackers.
* Modifiers (`shared/modifiers.ts`) now only apply where they make sense; see table at the end.

## Ballistix (`ballDefence`)

Ported from the real code (`re/notes/ballistix.md`), 30 Hz, all constants per frame in disc units (256 u = 1 sim unit, sim z = -game z).
Four ships guard a goal each: slot 0 bottom, 1 top, 2 right, 3 left (`BD_NORMALS`). A ball over your line costs 1 point (start score: CRASHBALL 15,
BEACH BALL 12, N.BALLISM 20, SKY BALLS 20); at 0 your goal is walled up and your ship dies; last ship with points wins (timeout 240 s: most points).
Ship slides along its wall (max 0x68/frame, 0xa0 with a shoulder button; accel 0x22, decay 0x12) and is pushed out of the corner bumpers.
On a QWERTY keyboard, use **← / →** at the top and bottom goals or **↑ / ↓** at either side goal. Hold **E** to boost on all four stages. **Z** kicks (4-frame sweep, cooldown grows 30 frames per kick up to 90, a hit clears it). **C** taunts from idle. In Beach Ball, hold **X** to catch and release it to fire (0xe0, auto-release after 0x96 frames).
Ships also bat balls: the ball's speed gains the ship's velocity and the heading is the ball-ship normal mixed with the ship's facing.
Balls: spawn at a corner, fall in, bounce, roll (speed 0x50, target rises 4 per hit up to 0x90); count = 1 + 1 per 10 s (max 5, beach 4).

Variants: **crashball** plain. **beach** catch/release and independent shoulder boost. **nballism** power-up post (shield 8 s that repels balls) and the N.Gin machine spitting balls from the centre. **sky** ships orbit a ring, goals are radial, and engine events tilt the platform and bend ball trajectories.

`world.data`: `variant`, `f`, `pl[4]` (`x,z` u, `vel`, `face`, `score`, `kcd`, `kpen`, `st` ship state 0x1c idle/0x1d move/0x1f kick/0x21 catch/0x24 dying/0x25 gone, `shield` frames, `dead` frame), `balls[]` (`st` ball state, `x,y,z,h,spd,tgt,who`), `post`, `mach`, `walls`.
Bodies: `player` (`dash` > 0 while kicking, `cd` = kick cooldown s), `ball` (`cd` = last toucher + 1, `dash` = 1 held, `face` = ball state, `y` height).
Events: `sfx` (`o` = real effect id, see ballistix.md), `hit` (`o` = slot), `kick`, `bounce`, `spawn`, `goal` (`s` scored on), `ko`, `pickup`, `shield`, `catch`, `launch`, `machine`, `post`, `gone`.

## Polar Push (`pushOff`)

Rules decoded from the real code (`re/notes/polarPush.md`), 30 Hz, no timer. Bears slide on slippery ice (accel 2 / decel 1 units per frame, max speed 55
or 40 by character, 1024 units = 1 model unit, world = units / 320), 8-direction movement. **A/B (Square)** = dash (gauge +4/frame to 0x100; costs 0x80 / 0x100 / 0xb4
by character; dash speed 90 / 130 / 105 / 75). Bears collide at 256 units with mass-weighted elastic exchange (mass 256 / 384, +544 while dashing); speed over 32 thumps,
over 64 "hits". The edge is the level hull: centre outside -> slip; slower than 74 units/frame the bear **hangs on** (mash 5x within 33 frames to climb back at 74 units/frame
inwards), otherwise it falls at once. The round ends when 3 bears are out. Characters are slots 0-3 (heroes) unless `world.data.chars` is preset.

Variants: **tilt** the platform tips towards the mass-weighted centre of the bears (`ax = sum(x*m)>>10/15` clamp +-0x80, `az` clamp +-0x40, smoothed /4 per frame) and adds
`(mass*3>>3)*sin(tilt)` to every bear's target velocity. **polar** 40 breakable ice pillars fence the rim (`POLAR_PILLARS`, from RAM): a hard hit breaks one and opens the edge. **melt** the mask flies round the ring, melts the sector under it and half-melts its
neighbours (hulls from RAM); touching it gives shrink / snowball / freeze / bomb. **manic** a bolt pickup appears on the ice; B throws it: a hit knocks the rider off the bear (on foot: lighter, no edge hang), a hit on
foot eliminates. Uka masks give SHRINK / GROW / FREEZE / BOMB items (bomb passes on contact, explodes after 300-330 frames).

`world.data`: `variant`, `radius`, `tilt [x,z]` (-1..1), `tiltRad [x,z]` (radians), `meter[4]` (gauge 0..1), `hang[4]` (s left), `item[4]` (0 none, 1 shrink, 2 grow, 3 bomb, 4 frozen),
`itemT[4]`, `elim[4]`, `melt[16]`, `pillars`, internal per-player state `p[]` (game units).
Bodies: `player` (`fall` once lost; `dash` > 0 while dashing), `mask`, `bolt`. Events: `dash`, `thump`, `hit`, `skid`, `ko`, `hang`, `climb`, `pickup`, `bomb`, `boom`, `freeze`, `thaw`, `melt`, `pillar`, `bolt`, `strike`.
Replay-exact: TILT PANIC only. POLAR / MELT / MANIC are ported from the code and RAM tables but not replay-checked (see `re/notes/polarPush.md`).

## Pogo Painter (`tilePainter`)

10x10 grid (`TP_N`, `TP_TILE` 1.8). Players **hop one square per hop** (stick direction; tap = one hop, hold = continuous; 0.34 s per hop),
painting the square they land on (stealing rivals' squares). Painted squares are worth nothing until banked: land on a cash crate ("?")
to break it - all your painted squares become points and reset to neutral. Highest banked score at time-up wins (tie: most painted squares).
Power crates (`power`): missile (stuns first rival in the row/column you face for 2 s), arrow (paints the whole row/column you face), speedy boots (8 s).
**A or B** fires the held item. Bodies never collide; a hop onto an occupied/reserved square or wall is blocked (stays in place, `bump`).

Variants: **pogo** plain. **agogo** pockets of <= 20 squares walled in by your colour (arena edge counts) are captured (`capture`).
**elpogoloco** hopping onto a square of your own colour wipes all your painted squares (`wipe`) (except onto a crate). **padlock** stone blocks
(`data.walls`) - not hoppable, stop missiles.

`world.data`: `variant`, `tiles[100]` (owner slot or -1; unbanked), `walls[]` (indices), `score[4]` (banked points), `item[4]` (0 none, 1 missile, 2 arrow),
`boots[4]`, `stun[4]`, `dir[4]` (last hop dir: 0 +x, 1 -x, 2 +z, 3 -z), `to[4]` (square index being hopped to / stood on). Internal: `from`, `hopT`, `buf`, `prevAct`, `prevFire`, `nextCash`, `nextPower`.
Bodies: `player` (x/z/y already follow the hop arc, `face` = hop direction), `crate` (cash), `power` (`cd` 1 missile / 2 arrow / 3 boots), `missile`.
Events: `paint` (`s`, `v` size, `o` = 1 if it stole), `cash` (`s`, `v` squares banked), `crate`, `power`, `pickup` (`v` item), `missile`, `arrow`
(`v` 0 row / 1 column), `hit` (missile; `o` owner), `stun`, `wipe`, `capture`, `fizzle`, `bump`.
HUD: banked `score[slot]`, painted `tileCounts(data)[slot]`.

## Tank Wars (`tankArena`)

Real-code port (`re/notes/tankWars.md`): game units (1/512 tile, 30 Hz frames), world = (g - pen centre) * `TA_K`/1024, z flipped. Levels: swamp = 5 (hover boats,
open pen), desert = 6 (4x4 crates, grid driving, mines throw 4 flames), jungle = 7 (free driving, centre pedestal, area mines), metal = 8 (4x3 crates, grid, flames).
On PC, arrows drive, Z fires, X drops a mine, and C taunts. Q and E turn the turret on tracked tanks.
In Swamp Fox, Left and Right steer, Up or E accelerates, and V shields the boat. Each pilot starts with three mines.
A floating mine arms once every boat has moved clear. Each pilot can have one in the water at a time.
Desert and Jungle Fox receive supply crates by air. Metal Fox spawns its mines, fruit and bombs on the floor.
Fruit restores 20 HP. Jungle Fox also offers double shots. Two statues jump from its central pedestal and patrol the arena. Their slams deal 60 base damage. An unopened bad crate leaves a timed mine when it lands.
Each tank starts at 99 HP. At the 90-second timeout, a sole health leader wins. Tied leaders draw and keep their remaining health. A knockout win follows the surviving pilot as the destroyed tank finishes its wreck animation. CPU tanks run the original AI inside `step()` (difficulty = `SlotInfo.level`); `bot()` drives a vacated human seat (a disconnected player) with the same AI input (`aiFrame`, stamped `t.bot = f + 1` so `step()` uses it for that frame).

`world.data`: `variant`, `lv` (0..3 = level 5..8), `f` (frame), `over`, `hum`, `tk[4]` (x z yaw hull st hp mines wpn ammo cd inv kills elim ... in game units; st 0x69 hit,
0x6a dying, 0x6b dead), `shells`, `mines`, `flames`, `bombs`, `pickups`, `dropper`. Bodies (world units): `tank` (`face` = turret), `bullet` (`dash` = weapon),
`mine` (`cd` counts down for timed mines, and `data.mines[].drift` tracks floating mines), `flame`, `bomb`, `pickup` (`cd` = type 2 double / 3 bomb / 4 fruit / 5 mine / 6 bad crate), `dropper`.
Events: `sfx` (`v` = game sound id, mapped per level by `TANK_SFX`), `shoot`, `mine`, `explode`, `boom`, `hit` (`v` = dmg/`TA_HP`), `ko`, `bounce`, `fizzle`, `pickup` (`v` type),
`spawn`, `shield`, `floatingMineBlast`, `taunt`. Not honoured: `params.bounces` (shells live a fixed number of frames); `params.fireRate` shortens the cooldown.

## Crate Crush (`crateToss`)

Players start with 20 HP. Circle lifts or throws a crate, Square attacks or kicks, and Cross jumps. Holding Cross gives a higher jump. Pickup, release, and attack timing vary by character. A wooden crate deals 5 damage (3 in Drain Bash). TNT and nitro deal 8 and can trigger nearby crates. Wumpa fruit restores 1 HP. The last player standing wins, or the player with the most health when time runs out.

Variants: **jungle** plain. **space** has permanent holes in an 8×8 floor. Standing over a hole eliminates the player. **snow** slippery floor.
**drain** slow-motion potions.

`world.data`: `variant`, `hp[4]`, `score[4]` (hits landed), `taken[4]`, `elim[4]`, `stun[4]`, `boots[4]`, `slow[4]`, `floor[]` (space: 64 flags, 1 = floor, 0 = hole; `[]` elsewhere; use `floorAt(data, x, z)`).
Bodies: `player` (`fall` in a hole), `crate` / `tnt` / `nitro` (`cd` = holder slot + 1, `dash` > 0 = thrown/kicked and dangerous, `slot` last thrower; tnt: `fall` = fuse lit, `m` = fuse seconds left),
`fruit`, `boots`, `potion`. **Note**: crates are now three different body kinds.
Events: `grab`, `throw`, `kick`, `hit` (`s` victim, `o` attacker or -1, `v` = dmg/`CT_HP`), `smash`, `bounce`, `land`, `explode` (`v` radius), `lit`, `pickup` (`v` 1 fruit / 2 boots / 3 potion), `ko`, `hole` (x/z of destroyed floor square), `jump`.

## Crash Dash (`dashRace`)

Real-code port (`re/notes/crashDash.md`): game units (1024 = 1 model unit, world = units * `DR_K` / 1024, z flipped), 30 Hz, 10 laps (`DR_LAPS`), real start slots.
**← / →** steer. Hold **↑** or **E** to accelerate and **Z** to boost with fruit. Hold **X** to use a missile or Toxic shield as soon as you collect it. The equipped item spins above your kart. On Splash, tap **X** for each hop. You can hold the accelerator through the rules screen for a running start at GO.

Steering adjusts the target yaw by up to S+0x160 per frame. Velocity ramps per axis (accel/decel), clamp 0xc800. Walls deflect (78 % speed, normal +-0x338). A hit (missile, barrel, blob, rock, kart) is state 0x5d:
60 frames (hop vy -160, spin), no speed cut, no shield immunity. Leaving the ring (Toxic 3072, Dante 3328, Splash course boundary) = fall: 24 (Splash 32) frames clip, then dropped back in
512 toward the centre (two bounces), item lost. Shield (Toxic crate) = 15 frames pushing the first other kart within 900 away.

Variants: **dot** plain track (real wall polygons). **toxic** monster at the centre (rise 119 / attack 42 / sink 35 frames, spits 3 blobs that crawl round the track), 11 barrels
(`DR_BARRELS`, broken barrels stay down for the race), shield crates. **splash** 6 rotating spokes to hop over. **dante** volcano (every 450/300 frames,
3 rocks bounce out to 600 units, hit = 0x5d).

`world.data`: `variant`, `f`, `gx/gz/gy/vy` (game units, `gy` = height above ground), `yaw`, `tgt`, `vx/vz`, `fuel`, `item` (0 none, 1 missile, 2 shield), `shield`, `state` (0x5b drive, 0x5d hit,
0x5e hop, 0x61 fall), `lap`, `finish`, `mon*`, `blobs`, `bar`, `sp` (spokes), `vs/vt`, `rocks`, `mis` (missiles). Bodies: `player`, `crate`, `fruit`, `missile`, `rock`, `blob`.
Events: `turbo`, `pickup` (`v` 1 crate / 2 fruit), `missile`, `shield`, `hit` (`s` victim, `o` attacker or -1), `fall`, `wall`, `bump`, `explode`, `lap`, `finish`, `hop`, `barrel`, `monster`, `spoke`.
CPU karts and `bot()` (vacated seats) run the decoded AI (pickup chase, edge probes, kart/barrel/blob avoidance, missile/shield/hop use); the selected difficulty comes from the level’s skill table.
Course walls and CPU hub polygons come from the level data. Splash uses the stored perimeter and the animated spoke tip. Barrel bounce and rock heights still need frame comparisons.

## Modifiers (`shared/modifiers.ts`)

| id | applies to |
|---|---|
| `lowGravity` Moon Bounce | pushOff, crateToss |
| `doubleSpeed` Double Time | ballDefence, tilePainter (faster hops), tankArena, crateToss, dashRace |
| `giantBall` | ballDefence |
| `slippery` Ice Rink | pushOff, ballDefence, crateToss, dashRace |
| `mirrored` | all six |
| `bigPlayers` Sumo Size | pushOff, ballDefence, crateToss |
| `ricochet` Super Bounce | tankArena (`params.bounces` 5; shells ricochet `bounces - 2` = 3 times, default 0) |
| `rapidFire` | tankArena |
| `bigBrush` | tilePainter (landing paints 3x3) |
| `crateStorm` | crateToss |
| `boostFrenzy` | dashRace |

## Renderer checklist (what changed vs the old sims)

* Names/descriptions/controls strings; read `world.data.variant` (+ `game.variants`) for the level.
* **ballDefence**: real-code port; state in `data.pl/balls/post/mach` (no more `lives/shield/held/stall`), all sounds via `sfx` events (effect ids).
* **pushOff**: use `data.radius` and `data.tilt`; `hang`/`climb`/`strike`/`bolt`/`grab`/`throw`/`zapped`/`pickup`/`weight` events; `beam`, `bolt` bodies; `meter`, `zap`, `weight` for HUD.
* **tilePainter**: movement is now hopping (body already arcs); `data.score` is the real score, `tiles` only painted-unbanked squares; `walls`; `crate`/`power`/`missile` bodies; events `cash/capture/wipe/arrow/missile/pickup/stun`.
* **tankArena**: real-code port: `TA_HP` 99, state in `data.tk[]` (game units), `TA_MAPS[variant]` blocks in world units, per-level `TANK_SFX` via `sfx` events; `bomb`/`flame`/`dropper` bodies.
* **crateToss**: crate kinds `crate`/`tnt`/`nitro` (tnt `fall` = lit, `m` = fuse); `data.hp` health bars (`CT_HP`), `floor` holes (space); `fruit/boots/potion` bodies; events `kick/explode/lit/hole/pickup/ko`.
* **dashRace**: `DR_LAPS` 10; `fuel`, `turbo`, `item`, `state` in data; `crate/fruit/missile/rock/blob` bodies; events `turbo/pickup/missile/shield/explode/hit/fall/wall`.
