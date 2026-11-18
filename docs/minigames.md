# Mini-games (web/shared/games)

The six party mini-games follow the real Crash Bash (PS1, 2000) games. Game ids are unchanged so clients keep working;
names, rules, controls and level variants follow the disc (text files 0141-0152, level names from `arenas.md` §3).

| id | Real game | Levels (variant ids) | maxTime |
|---|---|---|---|
| `ballDefence` | Ballistix | `crashball` CRASHBALL, `beach` BEACH BALL, `nballism` N.BALLISM, `sky` SKY BALLS | 120 s |
| `pushOff` | Polar Push | `tilt` TILT PANIC, `polar` POLAR PANIC, `melt` MELT PANIC, `manic` MANIC PANIC | 90 s |
| `tilePainter` | Pogo Painter | `pogo` POGO PAINTER, `agogo` POGO-A-GOGO, `elpogoloco` EL POGO LOCO, `padlock` POGO PADLOCK | 75 s |
| `tankArena` | Tank Wars | `swamp` SWAMP FOX, `desert` DESERT FOX, `jungle` JUNGLE FOX, `metal` METAL FOX | 90 s |
| `crateToss` | Crate Crush | `jungle` JUNGLE BASH, `space` SPACE BASH, `snow` SNOW BASH, `drain` DRAIN BASH | 100 s |
| `dashRace` | Crash Dash | `dot` DOT DASH, `toxic` TOXIC DASH, `splash` SPLASH DASH, `dante` DANTE'S DASH | 100 s |

(Boss levels BIG BAD FOX, BEARMINATOR and the TIE-BREAKER are not part of the party.)

## Common conventions

* `MiniGame.variants: {id, name}[]`. `setup()` picks one from `world.rng` and stores the id in `world.data.variant`.
  For tests/dev pages, set `world.data.variant = '<id>'` before calling `setup()` and it is honoured
  (`pickVariant` in `games/common.ts`). Variant display names are in the exported `*_VARIANTS` arrays
  (`BD_`, `PO_`, `TP_`, `TA_`, `CT_`, `DR_`).
* Deterministic: only `world.rng` (via `rand`) is used. Bots (`bot()`) are pure functions of the world.
* Buttons: `a` = Space, `b` = Shift. Each game's `controls` string says what they do. Both are used as edge-triggered
  "presses" by the sims (hold-to-fire only where noted).
* Elimination games keep dead players' bodies in `world.bodies` with `alive = false` (and `fall = true` while falling).
* Events: `GameEvent {k, x, z, s, o, v}`; `s` = affected slot, `o` = other/attacker slot, `v` = magnitude. `hit` with `s,o >= 0`
  and `ko` with `s,o >= 0` feed party stats (damage dealt / knockouts), so only emit those with real attackers.
* Modifiers (`shared/modifiers.ts`) now only apply where they make sense; see table at the end.

## Ballistix (`ballDefence`)

Four hover-ships guard a goal on each side of a square arena (`BD_HALF` 10, goal mouth half-width `BD_GOAL` 3.2).
Slot goals: 0 south (+z), 1 north (-z), 2 west (-x), 3 east (+x) (`BD_NORMALS`). Every ball in your goal costs 1 point of
`BD_START` = 15; at 0 your goal is closed and your ship removed; last ship left wins (timeout: highest score).
Ships are confined to a 5.5-deep strip along their own wall. **A** = kick (0.2 s swing, 0.45 s cooldown, hits balls
hard and always inwards). **B** = hold for speed (Beach Ball: hold = magnet catches nearby balls, release fires them
along your facing, never into your own goal; auto-release 2.5 s).

Variants: **crashball** plain. **beach** magnet. **nballism** N.Gin lobs an extra fast ball at a random alive goal every
~8 s (`ngin` event), and a force-field post sits in each ship's corner (6 s shield closes your goal; respawns after 14 s).
**sky** ship engines randomly stall for 1.1 s (`stall`).
Balls: 3 at the start (more join at 6/16/30 s), speed ramps up over time; a scored ball respawns 1.5 s later (not N.Gin balls).

`world.data`: `variant`, `lives[4]` (score left, starts 15), `elim[4]` (tick or -1), `shield[4]` (s), `held[4]` (ball id in
magnet, 0 none), `holdT[4]`, `stall[4]` (s). Internal: `pending`, `ginT`, `stallT`, `prevA`, `kicked`.
Bodies: `player` (ship; `dash` > 0 during the kick swing, `cd` kick cooldown), `ball` (`cd` = last toucher + 1; `dash` = 1 for an N.Gin ball),
`post` (nballism corner post, `slot` owner, `cd` > 0 while respawning).
Events: `hit` (ship batted ball; `o` = slot), `kick` (`s`), `bounce`, `goal` (`s` scored on, `o` last toucher or -1), `ko`, `pickup`, `shield`
(`v` 1 on / 0 off), `magnet`, `launch`, `ngin` (`s` target, x/z goal), `stall`.

## Polar Push (`pushOff`)

Bears on a floating ice platform (`PO_RADIUS` 8). **B** = charge (costs `PO_CHARGE_COST` 0.4 of a 0..1 meter; regen 0.22/s; empty = no
charge), **A** = jump. A bear pushed past the edge first *hangs on* (1.5 s): mash **A** 4 times to climb back (then 0.9 s grace where
the next slip is a real fall); a charging bear that touches a hanging one knocks it off. Last bear on the ice wins. All levels also
shrink after 40 s so rounds end.

Variants: **tilt** the platform tips toward the centre of weight (everyone slides). **polar** a beam drops a power-up: lightning (8 s of free,
stronger charges) or weight (8 s slow; passes to the bear you ram). **melt** the platform steadily shrinks. **manic** energy bolts: a marker
for 1 s, then a strike flings bears within 2.4 units; mild tilt, slow melt.

`world.data`: `variant`, `radius` (current platform radius, use this), `tilt [x,z]` (-1..1, direction the ice slopes down; [0,0] if none),
`meter[4]`, `hang[4]` (s of edge grip left, 0 = not hanging), `zap[4]`, `weight[4]`, `elim[4]`. Internal: `by`, `byTick`, `taps`, `grace`, `prevA`, `nextBeam`, `nextBolt`.
Bodies: `player` (`fall` once lost; `dash` > 0 while charging; hanging bears sit at radius `radius + 0.2`), `beam` (r 1.1, `cd` = fade timer), `bolt` (r 2.4, `cd` = time to strike).
Events: `jump`, `dash`, `land`, `hit` (charge landed; `s` victim, `o` attacker), `bump`, `ko` (`o` = last shover), `hang`, `climb`, `pickup`
(`v` 1 lightning / 2 weight), `weight` (`s` new holder, `o` old), `bolt` (warning), `strike` (`v` radius).
`platformRadius(time)` is still exported (melt formula) but renderers should read `data.radius`.

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

Arena (`TA_HALF` 10) with obstacles per map (`TA_MAPS[variant]` = `data.blocks`, `TA_BLOCKS` = swamp). Health bar `TA_HP` = 16.
Steer with the stick (tank faces where you steer and fires that way). **A** = shell (hold; 1 s reload; 2 dmg; explodes on walls - the "Super Bounce"
modifier makes it ricochet 3 times), **B** = lay a mine (start with 3, max 6; arms after 1 s; 5 dmg, radius 1.9; shells set mines off; hurts the owner too).
Pickups: extra mines (+3), wumpa fruit (+4 health), lobbing bomb (2 shots; **A** lobs it 7 units ahead over obstacles, 5 dmg, radius 2.1).
Destroyed tanks are out (no respawn). Last tank standing wins; on timeout the most health wins.

`world.data`: `variant`, `blocks[[cx,cz,hw,hd]]`, `hp[4]`, `kills[4]`, `deaths[4]`, `elim[4]`, `mines[4]`, `bomb[4]`, `stun[4]`, `inv[4]` (spawn protection).
Bodies: `tank` (`alive=false` when destroyed; `cd` reload), `bullet` (`dash` = wall bounces left), `mine` (`cd` > 0 while arming), `pickup` (`cd` 1 mines / 2 fruit / 3 bomb),
`bomb` (lobbed, `y` is arc height).
Events: `shoot`, `lob`, `mine`, `explode` (`v` radius, `o` owner), `hit` (`s` tank, `o` attacker or -1, `v` = dmg/`TA_HP`), `ko`, `bounce`, `fizzle`, `pickup` (`v` 1/2/3).
Removed: `spawn` event and respawning (kills/deaths now stay in `data` only for stats).

## Crate Crush (`crateToss`)

Arena `CT_HALF` 9, health bar `CT_HP` = 10. **A** picks up the nearest crate, press again to throw (small aim assist); **B** kicks a crate in front
of you, otherwise jumps (jump over thrown crates). Crate kinds rain from the sky: `crate` (wood; 2 dmg, smashes on hit), `tnt` (3 s fuse starts when picked up,
thrown or kicked; explodes wherever it is, also in your hands; 4 dmg radius 2.6), `nitro` (explodes on impact - hit, wall, landing after a throw/kick, or when dropped by a player
who gets hurt; 5 dmg radius 3). Explosions chain. Hurt players are stunned 1 s and drop what they carry. Pickups: wumpa fruit (+3 hp), speedy boots (8 s),
slow-motion potion (drain only, 6 s). Last standing wins; timeout: most health.

Variants: **jungle** plain. **space** explosions blow holes in a 9x9 floor (`data.floor`); stand over a hole and you fall out. **snow** slippery floor.
**drain** slow-motion potions.

`world.data`: `variant`, `hp[4]`, `score[4]` (hits landed), `taken[4]`, `elim[4]`, `stun[4]`, `boots[4]`, `slow[4]`, `floor[]` (space: 81 flags, 1 = floor, 0 = hole; `[]` elsewhere; use `floorAt(data, x, z)`).
Bodies: `player` (`fall` in a hole), `crate` / `tnt` / `nitro` (`cd` = holder slot + 1, `dash` > 0 = thrown/kicked and dangerous, `slot` last thrower; tnt: `fall` = fuse lit, `m` = fuse seconds left),
`fruit`, `boots`, `potion`. **Note**: crates are now three different body kinds.
Events: `grab`, `throw`, `kick`, `hit` (`s` victim, `o` attacker or -1, `v` = dmg/`CT_HP`), `smash`, `bounce`, `land`, `explode` (`v` radius), `lit`, `pickup` (`v` 1 fruit / 2 boots / 3 potion), `ko`, `hole` (x/z of destroyed floor square), `jump`.

## Crash Dash (`dashRace`)

Circular track (`DR_INNER` 6, `DR_OUTER` 10.5), `DR_LAPS` = 5 counter-clockwise laps, start line at angle 0. First across wins; others get 9 s more, then progress decides.
**A** (hold) = turbo (x1.5 speed, burns fuel at 0.4/s; fuel regens slowly and +0.35 per wumpa fruit), **B** = fire the held item (from weapon crates: missile that homes on the nearest
rival ahead, or a mine dropped behind). A hit spins the victim out for 0.9-1.2 s (no control). Boost pads (`DR_PADS`) still give a short speed kick. Crates respawn after 6 s, fruit after 8 s.

Variants: **dot** clean track. **toxic** sludge puddles halve your speed. **splash** four push rods pop in and out of the track walls (solid while extended). **dante**
five winged demons orbit the track and spin you out on contact.

`world.data`: `variant`, `ang[4]` (unwrapped progress, race = `DR_LAPS`*2pi), `lap[4]`, `finish[4]` (s or -1), `first`, `fuel[4]`, `turbo[4]` (bool), `boost[4]`, `item[4]` (0 none, 1 missile, 2 mine), `stun[4]`.
Bodies: `player`, `crate` (`DR_CRATES` spots, `cd` > 0 respawning), `fruit` (`DR_FRUIT` spots), `missile`, `mine` (`cd` > 0 arming), `sludge` (`DR_SLUDGE`), `rod` (`DR_RODS`, `dash` = 1 extended), `bat` (moving).
Events: `boost`, `turbo`, `pickup` (`v` 1 crate / 2 fruit), `missile`, `mine`, `explode`, `hit` (`s` spun out, `o` attacker or -1), `lap`, `finish`, `bump`, `sludge`.

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
* **ballDefence**: `lives` now starts at 15 (a score, not hearts). New: ship kick (`dash` > 0), `shield`, `held`, `stall`, `post` bodies, N.Gin balls (`dash` = 1), events `kick/shield/magnet/launch/ngin/stall/pickup`.
* **pushOff**: use `data.radius` and `data.tilt`; `hang`/`climb`/`strike`/`bolt`/`pickup`/`weight` events; `beam`, `bolt` bodies; `meter`, `zap`, `weight` for HUD.
* **tilePainter**: movement is now hopping (body already arcs); `data.score` is the real score, `tiles` only painted-unbanked squares; `walls`; `crate`/`power`/`missile` bodies; events `cash/capture/wipe/arrow/missile/pickup/stun`.
* **tankArena**: `TA_HP` 16; use `data.blocks`; no respawns (`alive=false` stays); `mine`, `pickup`, `bomb` bodies; `data.mines/bomb`; `explode/mine/lob/pickup` events; the `spawn` event is gone.
* **crateToss**: crate kinds `crate`/`tnt`/`nitro` (tnt `fall` = lit, `m` = fuse); `data.hp` health bars (`CT_HP`), `floor` holes (space); `fruit/boots/potion` bodies; events `kick/explode/lit/hole/pickup/ko`.
* **dashRace**: `DR_LAPS` 5; `fuel`, `turbo`, `item`, `stun` in data; `crate/fruit/missile/mine/sludge/rod/bat` bodies; events `turbo/pickup/missile/mine/explode/hit/sludge`.
