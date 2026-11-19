# Polar Push (overlay 0x800b32b4-0x800d8a00, decompile: re/out_polarPush/ovl.c)

Levels (`DAT_8005a648`): 0x12 TILT PANIC, 0x13 POLAR PANIC, 0x14 MELT PANIC, 0x15 MANIC PANIC (0x16 = boss, not covered). Game logic 30 Hz.
Verified = read from code; **est.** = estimate; **unk.** = not decoded. Replay-exact = also checked tick for tick against the emulator (all four levels, see "Replay verification"). Option flag `DAT_8005a646 & 0x80` = alternate rules (not covered).
Setup: `FUN_800b5ac4` (callbacks), `FUN_800bafa0` (init), `FUN_800bb810` (per frame), `FUN_800b3aa0` (tilt). Per-level jump table 0x800b3360.

## Rules (all levels)
- 4 players; each one is a character (id 1-8 = CHARACTERS index 0-7). Last one standing wins: round ends (`DAT_800d4dec = 1`) when 3 players are
  in state 0x50 (out), or a player has flag 0x200. No timer. Order of finishing = order of elimination.
- Buttons: D-pad move, **Square (0x8000) = dash/charge** (needs gauge >= cost), **Circle (0x2000) = throw** (only if holding a bolt, `+0x28`, MANIC),
  Square mash = climb back from the edge. (No jump.)
- Walk (`FUN_800cccb8`, `FUN_800b5788`): target v = speed * dir(pad) (8 directions, full speed diagonally, not normalised); v approaches the
  target by 2/frame (target != 0) or 1/frame (target == 0); pos += v. Max speed `DAT_800d6924[p]` = table 0x800d5408[char*6]: chars 1-4 **55**, 5-8
  **40** units/frame (55 u/f = 5.2 world/s). Mass (`FUN_800b5684`): chars 1-4 **0x100**, 5-8 **0x180**; the Uka SHRINK/GROW items override mass+speed.
  Facing yaw += shortest diff / 4 each frame.
- Collision (`FUN_800bbf2c`, `FUN_800cbbe8`): dist < **256** units -> per-axis elastic exchange (restitution 1, mass-weighted, +0x220 mass while
  dashing), clamp +-150 u/f; then this player alone is pushed by (266 - dist). Post-exchange speed^2 > 0x400 (32 u/f): thump sfx (4 random), > 0x1000
  (64 u/f): hit voice of the character (+ rumble). No stun on collision.
- Gauge (`+0x20` of mount data): +4 per frame in idle/walk, cap 0x100 (starts **full**, 0x100, recorded). Dash needs gauge >= cost (`FUN_800d05a8`): chars 1,2,7,8 **0x80**, chars 3,4
  **0x100**, chars 5,6 **0xb4**; cost is subtracted when the dash starts (`FUN_800d0808`).
- Dash (state 0x51, `FUN_800d0a6c`): velocity zeroed on entry; at anim frame f the velocity is set to `d * dir(facing)`: chars 1,2: f=1, d=**90**; chars 3,4: f=10, d=**130**,
  accel 6/decel 3 afterwards; chars 5,6: f=6, d=**105**; chars 7,8: f=1, d=**75** (mode 1 / item: 70). Length = the dash anim script (anim VM `FUN_8008502c`,
  scripts at `0x8009d29c + id*4`, one word per tick, `0x8008 n` sfx, `0x8004 n` set state): ids 1-8 = 21, 21, 38, 38, 27, 23, 24, 26 frame words (lengths replay-exact).
- Edge (`FUN_800cd214`): centre outside the level hull -> state 0x4e (slip). On entry (`FUN_800cfc58`): if speed < 0x4a (74 u/f) and not already flagged: hang
  on the edge (anim 0x3d, sfx 0x45c), velocity 0, mash Square: 5th press (`+0x14 > 4`) -> climb back (`FUN_800cff44`: facing inward, velocity 74 u/f inward, state 0x49);
  if the hang anim reaches frame 0x21 (33 frames) first, or entering at speed >= 74: fall (flag 0x2000 eliminated, y += 0x60/frame, out (0x50) once y > 0x400).
  The hang script is 42 ticks (ids 3, 4: 40) ending in `0x8004 0x50`. TILT: touching the seal while slipping (`FUN_800cac20`) sets pc 0x21 = no hang.
  CPU climb (`FUN_800b6258`): with a rival within 512 in front, or at pc 0x1e: rand(0x1000) < T5364[skill]*128 (+0x400 on TILT); no rival and pc 0x1e: climbs;
  **no human left (`DAT_8009d908`): never climbs** (recorded: 13/13 CPU hangs fell in all-CPU rounds).
  A hanging player hit by a bump gets pushed off the hull normally. Falls also happen in frozen/hit states (no hang).
- Hull (`FUN_800b4260(pos, n)`): edge list n of the level collision data `c = *(PTR_PTR_80058ad0+0x10)`: `t = c + *(c+0x14) + 0x18` holds offsets
  (count at `t-4`), hull = `t + n*4 + *(t+n*4)`, edge count at hull+0x38, edges stride 0x38: x +0x48, z +0x50, angle +0x64. Inside iff
  (px-x)cos a+(pz-z)sin a >= 0 for every edge (a/4096 turn). Read from RAM of each level (verified data, tables in web/shared/games/pushOff.ts):
  TILT 1 hull, 40 edges (L18 0x801ccaf4, r 2470-2900); POLAR 1 hull, 40 edges (L19 0x801c9a28, r 2500-2970); MELT 4 hulls (L20: 0 = disc, 16 edges,
  r 2580-2740, 0x801d1f00; 1 = inner disc, 16 edges, r 1815-1930, 0x801d22bc; 2, 3 = triangles, 0x801d2678 / 0x801d275c); MANIC 1 hull, 26 edges
  (L21 0x801d12d4, r 2950-3710). The edge test is replay-exact on all four levels (MELT: sector states 1-4 and both triangles).
- Camera: **unk.** (client PO_CAMS kept).

## Levels
- **TILT PANIC (0x12)**: `FUN_800b3aa0`: tilt angles (4096/turn) `ax` (x) and `az` (z) from players that are not eliminated:
  `ax_target = clamp(sum(x*mass)>>10 / 15, +-0x80)`, `az_target = clamp(-sum(z*mass)>>10 >>4, +-0x40)`; `a -= (a - target)/4` per frame. Drift added to every
  player's target velocity (`FUN_800cccb8`): `vx += (mass*3>>3) * sin(ax)`, `vz -= (mass*3>>3) * sin(az)` per frame (even without input; in dash state the target accumulates).
  Everyone slides towards the weighted centre. Uka mask item system (0x1601) active; sfx bank 0449/0450.
  - **Seal** (object 0x160c, `FUN_800c32a4` init / `FUN_800c358c` update, `PTR_DAT_800d5494`; not in boss mode) - replay-exact. Data comp: +0xc state,
    +0x10 timer, +0x18 jump started, +0x28 vy, +0x48/+0x4c jump vx/vz, +0x68/+0x70 landing point, +0x74.. start, +0x88 speed, +0x8c target speed,
    +0x90 target yaw; motion comp (0x20000000) vx/vz/mass 0x400; flip-book pc (scripts 0x800d5498 / 5500 / 5508 / 5540 / 5584). Rim point for
    `DAT_800d563c` = base (first 0x240): (sin, cos)(base) * 0x307 >> 10 (3100 out), y 0x400 (under the ice); landing point * 0x7d >> 8 (2000 out).
    - 0 wait: timer (first rand(8)*30 + 270); leaves when timer-- < 0, round not over, mask in orbit (state 1) with no holder -> 2 (sets `DAT_800d544c`).
    - 2 warning (object 0x1610 at the landing point), 91 ticks -> 3. 3 / 4 jump: `FUN_8008c5c4` speed 0x28, gravity 0x10, floor 0 (3 until the flip-book pc is 0x18, then 4
      until it lands, 27 ticks in all); landing: rand(4) (bark), state 1.
    - 1 landed, 12 ticks; `obj+0x5c = 1`: from here bears collide with it. -> 5: target yaw = yaw + 0x800, speed 16 at once.
    - 5 walk: yaw -= ((yaw - target) << 20) >> 24 per tick, pos -= 16 * (sin, cos)(yaw); motion velocity 0. When the point (sin, cos)(yaw) >> 5 (128 u,
      on the +yaw side = behind its motion) is outside the hull -> 7.
    - 7 dive, 38 ticks -> 6: timer = rand(900) + 90, base += 0x800 (opposite rim), state 0, collision off.
    - Collision (`FUN_800c2ecc`, obstacle list `PTR_DAT_800d5454`, called at the end of `FUN_800bbf2c`): bear in the seal's frame (Ry(-yaw)), box
      +-200 x +-0x180; distance to the box < 0x100 -> pushed out by (0x100 - dist) along the face normal (corners: 45 deg normal, CORDIC distance);
      a centre inside the box is not touched. Then `FUN_800ca930`: per-axis elastic exchange with the seal's motion velocity (mass 0x400, no clamp):
      a walking seal (v 0) is a heavy wall, a jumping one shoves.
    - Slip test (`FUN_800cac20`): the same box with r 300 at the slip enter -> anim pc 0x21 (no hang). AI: flag 0x100 while the seal is in state 1 / 5
      and within dist^2 0xb0644 -> handler 12.
- **POLAR PANIC (0x13)**: no tilt. **40 breakable ice pillars fence the whole rim** (`FUN_800c0888`; list `DAT_800d6010` built by `FUN_800ca770` from the
  stage sub-objects with collision, models 0x5003-0x500a, flag 0x8000 = standing; positions read from L19 RAM, r 2400-2620, i.e. on the hull edge, so
  nobody can fall until a pillar is gone). Contact: |dx|,|dz| < 331 and dist^2 < 0x1a964 (330): bear put back to 332 along the contact normal, velocity =
  half its speed **toward the centre** (angle at2(new x, new z); `-(spd * sin/cos) >> 13`); the pillar breaks (flag cleared, 3 ice chunks 0x1604, one
  rand(3) for sfx 0x46a-c = bank 0451 samples 20-22) if `speed * mass > tableSpeed(char) * 192` (light: speed > 41, heavy: > 20). First hit only per call.
  Called from idle / walk / dash / stun / frozen / snowball / on-foot states. Uka mask (0x1601) spawn point (-403, -70). Bank 0451.
- **MELT PANIC (0x14)** (mask = object 0x160a, `FUN_800c121c` init / `FUN_800c1584` update; `PTR_DAT_800d5254`): 16 sectors,
  sector = ((atan2(x,z) - 0x7d) & 0xfff) >> 8. Sector record (+0xb8 + s*0x10): +0 melt count, +4 state, +8 timer (+4/tick to 0x74), +0xc anim base.
  - Edge test: sector state 1 -> the whole test uses hull 1 (at once, no timer). State 3 / 2 with timer > 0x71 (29 ticks): out if inside triangle hull 2 /
    hull 3 (`FUN_800b4094`: the triangle is given for sector 15 with outward normals and turned by (sector+1)*0x100 with the Ry matrix; out iff all 3
    edge tests < 0). State 4: either triangle. Hull 2 = the outer third next to sector+1, hull 3 = next to sector-1 (both only r > ~2000).
  - `FUN_800c0fe8(s)`: count 0: s -> 1, next: 0 -> 2 / 3 -> 4, prev: 0 -> 3 / 2 -> 4. Count 1: s (2 or 3) -> 1, then prev / next as before. Count 2: 4 -> 1.
  - Mask: starts at (0,0), state +0x14 = 4 for 92 ticks (+0x64 = 0x5a), first target angle rand(4) of -0x100 / 0x300 / 0x700 / 0xb00. State 0: 0x20 units/tick
    per axis toward the target point (sin, cos)(angle) * 0x115 >> 9 (r 2216); within dist^2 <= 0xfff: rand(0x1000), state 1, melt sector
    ((atan2(pos at tick start) + 1) & 0xfff) >> 8, next target = (i+1)*0x100 - 0x40 where i = first sector from the random index whose state != 1
    (all melted -> state 2, flies off). State 1: 61 ticks, back to 0. One rand(4) every tick (start slot of the item loop).
  - Items: no beam. While +0x64 < 0 (and state != 1, no holder) the first bear from the random slot with dist^2 < 0x19000 gets kind
    `0x800d5480[rand(4)]` = **0 shrink, 8 snowball, 2 freeze, 5 bomb** (no grow, no zap, no no-human remap); state 3, 0x4f, 15-tick flourish (+0x70).
    Shrink: mass 0x50, speed 0x40, clock rand(60)+150. Snowball (debug string "snow"): **mass 400, speed 0x10** (this is the "grown 400"), state 0x52
    (`FUN_800d14cc/d17e8`: no dash, yaw turns diff>>5, y -0x14c, starts at 64 u/tick toward the centre, slips = falls), clock rand(60)+300. Freeze: state 0x4c
    (`FUN_800cf9ec/cfb7c`: pad off, yaw +0x10/tick, still bumps and slips = falls), clock rand(60)+90. Bomb: fuse 300, pass on contact, clock 0x14a then 0xd2.
    The clock +0x64 only runs while an item is active, so **after a bomb the mask gives nothing more** (as coded). 61 ticks after the hand-out the mask
    drifts to the centre (0x18/tick per axis) until the item ends. Bank 0448 (0x489 -> sample 20, 0x48a snowball -> 21, 0x48b snowball bump -> 22).
- **MANIC PANIC (0x15)**: Uka mask as on TILT (spawn point (-141, 312)), plus the **bolt**:
  - Spawner 0x160e (`FUN_800cb9dc` init: timer 0xb4; `FUN_800cb8a4`): one bolt out at a time (+0x18). Count < 1 and timer-- < 0 -> timer 0x5a, next tick a pickup
    0x160f at (rand(0x800)-rand(0x800), rand(0x800)-rand(0x800)), sfx 0x3fa (bank 0447 sample 25).
  - Pickup 0x160f (`FUN_800cb798`, `FUN_800b5074`, list `DAT_800d5294`): first bear (slot order, not out) with dist^2 < 90000 takes it (mount +0x28 = 1, sfx 0x48e
    = sample 21); the bomb / zap carrier just destroys it. Destroyed (count--) when the carrier is out, wins, gets the bomb / zap, or has thrown it.
    **Picking up the mask's bomb / zap item drops the bolt** (`FUN_800bd67c` sets +0x28 = 0 on the pickup tick; shrink / grow keep it).
    The winner flag 0x200 is set after the bears and before the objects, so the winner's bolt goes on that tick.
  - Throw: Circle (0x2000) with +0x28 set (`FUN_800d10a0`) -> state 0x53 for one tick (`FUN_800d1188/d2eb0`): projectile 0x160d from 0x100 above the bear
    toward 0x700 ahead at 86 u/tick (chars 1-4) / 0x800 at 106 (5-8). `FUN_800b4c74` + `FUN_8008c5c4` (n = dist/speed ticks, vy0 = 0x100/n - (n>>1)*2,
    gravity 2, lands when y >= floor and vy > 0: 22 / 20 ticks, ~1900 / 2120 units). Off the hull the floor is 0x100 (water, sfx 0x494 = sample 24).
    Each flying tick: `FUN_800b44b4(r^2 = 90000)`; on landing / hit: explosion 0x1614 next tick with r^2 0x35ee4 (470), gone after 31 ticks (sfx 0x48f = sample 22).
    A new object first updates on the tick after it was made. Rng: trail spark 0x1612 every 2-3 ticks = rand(0x1000) (spark init `FUN_800ca424`) then
    rand(2); the burst 0x1614 (`FUN_800c4498`) = 17 shards x 6 rand(0x4c) = 102 draws, before the blast's hit test.
  - Hit (`FUN_800b44b4`, first bear in slot order, not the thrower, player +0x44 == 0, not 0x4d / 0x50): riding -> **knocked off the bear**: state 0x56
    (`FUN_800d2044/d2d9c`, clip 0x3f = 19/19/26/20/30/29/30/27 ticks then 0x54), mode +0x24 = 1, mass -0x46, +0x44 = 60 ticks immune, faces yaw+0x800; the bear
    flies off as object 0x1611 (`FUN_800ca628/ca514`: from the bear's place 3000 units along the bolt's heading, `FUN_8008c5c4` speed 50, gravity 2, floor
    0x100, ~64 ticks; a spark every rand(7)+1 ticks = rand(0x1000) + rand(7), first after 5). **If the 0x1611 cannot spawn the hit does nothing** (only the
    sfx). On foot (mode 1) -> state 0x57 (`FUN_800d2248/d2334`): eliminated, out after 60 ticks; tick 4: a burst 0x1614 (102 draws); every rand(7)+1
    ticks two sparks (rand(7), 2 x rand(0x1000)). sfx 0x490-3 = sample 23. One rand(4) per hit (sfx pick).
  - On foot: states 0x54 idle (`FUN_800d191c/d1c14`, accel 4 / decel 2) and 0x55 walk (`FUN_800d2e00/d1db4`); dash cost 0x80, speed 70, clip 0x45 = 20 ticks;
    same table speed; **no edge hang** (0x4e falls at once); mass reset keeps -0x46 (`FUN_800b5684`, base mass from the selection table `DAT_8005a664`).
    Anim 0x42 / 0x43 loop (no state word). On foot every "back to idle" goes to 0x54 instead of 0x49: mask item end, stun end (`FUN_800ce664`), 0x4f, 0x53.
    A stunned bear on foot does not spin (yaw += 0x10 only in mode 0).
  - AI: flag 0x400 = carries a bolt (+0x54 counts decide() calls), 0x800 = being knocked off. Rival with 0x400 closer than 2248 -> attack it; own 0x800 /
    0x200 (MELT snowball) -> evade. Behaviour 4 (`FUN_800b98ac`, table +0x3f) and "on foot + bolt free + idle" -> state 0xd `FUN_800b6fec` (walk to the
    bolt, then attack a rival). Throw `FUN_800b6eb4`: target < 2000 away, +0x54 >= 0x1f, in front -> Circle; called from the attack / mask / wait / evade /
    centre handlers. Bank 0447. Quirk in the wait handler `FUN_800b7224`: with a bolt, `FUN_800cb178` leaves the nearest rival's distance in the local the
    "nearest bear" loop starts from, so the loop finds nobody nearer: the bear faces slot 0 (and evades "from" slot 0 when a rival is within 1024).
  - 0x161b / 0x1619-0x1624 (`FUN_800c4a3c..`) belong to the boss level 0x16, not to MANIC.

## Uka mask items (`FUN_800bd67c`; MELT mask `FUN_800c1584` moves differently) - replay-exact
- Object runs in the post-player object list (a pickup zeroes v after that tick's integration). State +0x14 (1 orbit, 2 beam), clock +0x58, next beam +100
  (init rand(0x5a)+0xd2), beam length +0x60 = 0x78. Orbit: pos = spawn point (+0x88/+0x90; TILT (108,-8)) + 1500*(sin(sin(a/2)), cos(cos(a/2))), a += 8 (`DAT_800d5474`).
  The clock does not run while the TILT seal is out (`DAT_800d544c`, set when the seal starts 0->2, cleared 7->6).
- Beam: kind = table 0x800d5458[rand(4)] = 0 shrink, 1 grow, 6 zap, 5 bomb; with no human (`DAT_8009d908`) 0 -> 6, 1 -> 5. First bear (slot order) without 0x2000
  within dist^2 < 0x19000 while no holder gets it: state 0x4f (enter `FUN_800d034c` = idle enter, then v = 0).
- Shrink / grow: mass 0x50 / 600, speed 0x40 / 0x20 (MELT has no grow: its 400 / 0x10 is the snowball, see above), scale -/+0x100 per tick to 0xa00 / >6000 then idle; after 180 ticks scale back, then normal mass/speed.
  Next beam rand(0x3c)+0xd2 after the end.
- Bomb (5) / zap (6): 15-tick flourish (+0x70; the holder is set idle when it ends), then fuse +0x68 = 300 (299 shown that tick). The carrier +0x6c passes on contact
  (`FUN_800bbf2c`, either direction, 15-tick lockout +0x48[i]). Bomb at 0: carrier gets 0x2000 + state 0x4d (velocity kept that tick, zeroed by the handler); next beam 210.
  Zap at 0: every other bear without 0x2000 and not 0x50 -> 0x4b (stun); next beam 330. Ends early if the carrier is out.
- Stun 0x4b (`FUN_800cde8c` enter / `FUN_800ce664`): v 0, mass 0x200, pad zeroed, lock 2; collisions, edge test and pillars still run; yaw += 0x10 per tick
  after tick 31; leaves after 182 ticks (+0x1c > 0xb5 -> mass reset, 0x49). Star objects every 25-32 ticks (rand(8)+0x18, consumes 3 rands).
- AI flags from the mask: carrier |= 2 (bomb) / 0x40 (zap); shrink/grow holder |= 8 / 4.
- Pickup effect: object 0x1605, script 3 (MANIC 2, boss 7) of the level model, rate 0x80. Only POLAR's script has a particle emitter: 25 rands per tick
  on 4 ticks, after the mask's own draws (the rand(0x3c) of shrink / grow comes first). It starts on the pickup tick, or one tick later when the
  effect object lands in a pool slot that is not updated any more that tick (5 of 31 pickups in one recording; the sim always starts at once).
- FREEZE (2, state 0x4c) is only in the MELT table (0x800d5480). Table 0x800d5458 = 0,1,6,5 on TILT, POLAR and MANIC (read from each dump). Throw (Circle, state 0x53) = the MANIC bolt.

## AI (`FUN_800cad60` per CPU inside the player loop) - replay-exact
- AI struct (obj+0x58): +0xc/+0x14 target x/z, +0x18/+0x20 own x/z, +0x24 counter, +0x28 target, +0x2c evade-from, +0x30 state, +0x34 flags,
  +0x3c pad-angle refresh period, +0x40 evade dir, +0x44 handler, +0x4c, +0x58, +0x5c dash countdown. Pad struct +0x20 on, +0x24 refresh counter, +0x2a angle, +0x2c bits.
- Tick: bits = 0; `FUN_800b9d48` (flags, climb roll `b6258`, dash `b60b8`, reactions, behaviour pick from rand(5) start when idle: b94b8 attack a weighted-random
  rival (`b3740`, table 0x800d4e0c), b9600 item hunt, b9714 wander to a random point r=1800, b9994 help, b98ac); handler (+0x44): 1 attack b6708, 2 mask b782c,
  6 evade b7f70, 7 b767c, 8 b6d74, 9 wander b7520, 10 wait b7224, 11 centre b90c0, 12 seal b889c; `FUN_80013c94` stores bits for the next tick's pad read.
- Steering `b5ebc`: 8-way bits from target vs own position; the pad angle refreshes every +0x3c+1 ticks from the bits table. The engine pad reader
  (`FUN_800136bc`) turns the stored bits into a fake stick (0/0x80/0xff) and stores at2 of it at pad+0x38 (diagonals are 0x203 etc., not 0x200).
- Real CPUs start the round in attack on a random rival (the AI already runs during the 112-tick intro) - hence the diagonal walk through the middle.
- Skill `DAT_8009d87c` = 16 for every CPU at normal (recorded). Dash countdown 0x40 - T52E0[skill]; behaviour weights `9d880` all 16.
- `FUN_800bcc9c`: cosmetic idle fidget. `DAT_800d4e08` = level tick (reset at round start). After 0xd1 ticks, a CPU bear in state 0x49 whose AI handler is 6 (evade) or 9 (wander), engine character 1-4 or 7, gets an anim script once (flag +0x50, cleared when it leaves 0x49). Scripts (L18 RAM): e1 0x800d3bb4 clip 4 f0-19 loop; e2 0x800d3c74 clip 5 f0-8 then 0x8001; e3 0x800d3edc clip 5 f0-8, f8 x13, f9-19 loop; e4 0x800d4820 clip 5 f0-2 then 0x8001; e7 0x800d4174 clip 3 f0-19 loop (e5/6/8 tables exist but the filter excludes them). Ported (sim `fid`, view `FIDGET`).

## Replay verification (emulator, 2026-11)
- Recorder `window.PR` (scratchpad `pv/rec3.js`) snapshots per game tick (`DAT_8004e0d8`): players, movement block, anim pc, AI struct words, pad struct,
  rng (`0x800517b8/bc`), order table 0x8009d764 (64 int32), mask struct, pillar flags, every pool object (id, slot, entity, data / motion comp).
  Harness `pv/replay.ts`: loads row t into the sim, steps one tick with the game's LCG (`FUN_80015590`: a += b; r = a % n; b += a + (a >> 31)), compares
  with row t+1 (bears, AI, mask, pillars, sectors, bolts, seal, rng state). The frame makes **one extra rand before the player loop** - ported.
- Results, play ticks exact / total (+ intro ticks), final sim:

| level | session | chars | play | intro |
|---|---|---|---|---|
| TILT | all CPU | 1,3,4,6 | 2441 / 2441 | 766 / 766 |
| TILT | human bot in slot 0 (seeks the seal) | 5,2,3,8 | 3849 / 3849 | 432 / 432 |
| TILT | human bot, 20 min, several matches | 6,4,1,7 and others | 23399 / 23399 | 4319 / 4319 |
| POLAR | all CPU | 8,2,5,7 | 8179 / 8179 | 654 / 654 |
| POLAR | human bot, 12 min | 1,3,4,6 and others | 19211 / 19211 | 987 / 987 |
| MELT | all CPU | 1,3,4,6 | 890 / 890 | 432 / 432 |
| MELT | human bot, 25 min | 2,5,7,8 and others | 30108 / 30108 | 5205 / 5205 |
| MANIC | all CPU, 25 min | 1,3,4,6 and others | 33127 / 33127 | 4095 / 4095 |
| MANIC | human bot (fetches and throws bolts), 12 min | 2,5,7,8 and others | 17099 / 17099 | 1542 / 1542 |

  Counted as exact with refused cosmetic spawns (see below): TILT 1 tick, POLAR 5, MANIC 54 + 60. Not counted: 13 round-skip presses (MELT),
  21 round-reset ticks (MANIC).
- Free run (state and rng loaded once at the round reset, then no reseeding; recorded pad for the human): whole rounds reproduced tick for tick incl.
  the rng state: TILT 3 of 3 all-CPU rounds and 4 of 4 with the human and the seal (714-1313 ticks), POLAR 3 of 3 all-CPU (2085-2608 ticks) and 2 of 4
  with the human (the others: late pickup effect; a harness limit at GO), MELT 3 of 3 all-CPU and 3 of 4 with the human (the other: round skip),
  MANIC 3 of 4 all-CPU and 1 of 4 with the human (the others stop at a truncated burst / a failed spawn, i.e. the node pool).

- Coverage: TILT 25+ seal cycles (bears next to the seal 109 ticks in state 1, 217 in 5, 7 in 7), all four mask kinds, 57 climbs. POLAR 185 pillar
  breaks, slips through gaps, human hang / climb, 31 + 12 pickups of all four kinds. MELT 59 pickups (17 shrink, 13 snowball, 17 freeze, 12 bomb),
  ~370 sector state changes incl. both wedge states, 60 climbs. MANIC 108 throws (34 by the human), 64 knock-offs, 15 burns, on-foot states, bolt
  lost to the mask, all four mask kinds with a human in.
- Not counted as mismatches (each explained):
  - **Render-node pool.** Free list `PTR_DAT_80058acc`, about 22-29 nodes free in a quiet MANIC scene. `FUN_80022a3c(.., flags 0x11)` returns 0 when the
    entity gets no node, and `FUN_80018f3c` (the burst's 16 extra shards) takes what is left. Then sparks, bursts (0..17 shards) and their rng draws are
    missing, and the later draws of that tick shift. The sim always draws all of them; the harness re-runs such a tick with the cosmetic spawns refused
    (`poTest.fx`) and counts it when that matches exactly (MANIC 54-60 ticks per recording, TILT 1, POLAR 5). Gameplay objects fail the same way:
    seen once each: a bolt hit with no effect (0x1611 not spawned) and **a bolt pickup that never appeared - the spawner count stays 1, so no bolt
    for the rest of that round**. Not ported (would need the whole pool).
  - Round reset tick: the engine's round init runs inside it (old objects still listed); on MANIC that one tick differs. The tick after is exact.
  - `FUN_8007d6d0`: with every human out, Cross on a human pad ends the round at once (`PTR_FUN_8005aa98`; seen: one rand, one CPU goes to 0x58, the
    other out). Engine feature, not in the sim (13 presses by the recorder in one MELT session).
  - Emulator artefacts: a pad plugged into a CPU's port keeps the pad path on while the AI is off (`pc`); after "replay this arena" the engine ids
    (`DAT_8009d55a`) can differ from the cheat-pinned selection table (`DAT_8005a664`, used only by the mass reset: `sel`).
- Fixes found by the replays: bomb victim stays in 0x4d (out flag after 123 ticks); MELT evade test uses hull 1; MELT item release when out; seal walk
  speed / box / exchange; on-foot idle after item / stun; no spin on foot; bolt dropped at the bomb / zap pickup; winner flag before the objects;
  wait-handler quirk with a bolt; intro: a waiting CPU already turns (yaw eases toward the nearest bear); spark / burst / bear / emitter rng draws;
  a button held through GO is not a press (the pad's previous bits keep tracking during the intro).
- Older TILT runs (rec.js / replay2.ts): physics with recorded pads 1630/1630; free run from the round reset reproduces whole all-CPU rounds.
- Round lengths, all-CPU TILT, normal, from GO: real n=26 (emulator, chars 8/2/5/7): mean 14.7 s, median 15.4, 27% under 10 s, p75 17.6, p90 20.8, max 26.1.
  (The sim numbers quoted here before were measured with the estimated seal; not re-measured.)

## Sfx (slot 1 = level bank; sample n = `assets/audio/sfx/<bank>/<n>.mp3`)
| id | meaning | TILT 0450 | POLAR 0451 | MELT 0448 | MANIC 0447 |
|---|---|---|---|---|---|
| 0x446/0x448 | thump (speed>32) | 32 | - | - | - |
| 0x447/0x449 | thump | 33 | - | - | - |
| 0x44c | mask appears / sector melt | 0 | 0 | 0 | 0 |
| 0x44e/0x450/0x451/0x452 | item shrink / freeze / bomb | 2/4/5/6 | 2/4/5/6 | 2/4/5/6 | 2/4/5/6 |
| 0x454 | bomb passed | 8 | 8 | 8 | 8 |
| 0x456-0x45a | skid on entering idle at speed>32 (random of 6) | 10,11,10,11,10 | 12,10,11,12,... | see t0c | see t0c |
| 0x45c | edge slip | 12 | 13 | 13 | 14 |
| 0x46a-c | pillar breaks | - | 20,21,22 | - | - |
| 0x489 / 0x48a / 0x48b | sector melt / snowball / snowball bump | - | - | 20/21/22 | - |
| 0x3fa / 0x48e / 0x48f / 0x490-3 / 0x494 | bolt appears / taken / lands / hits / splash | - | - | - | 25/21/22/23/24 |
| 0x47e-82 | unmapped on TILT (option-flag rules) | | | | |
The id table 0x80064508 is patched per level: read each level's own dump.
Char voices: hit voice ids per char (3-6, 0x35-38, 0x67-6a, 0x99-9c, ...), dash voices 0x16,0x48,0x7a,0xac,0x142,0x174,0x110,0xde (chars 1-8) in the voice bank.
Anim clips (`FUN_800854c0`): 0x3a idle, 0x3d edge hang, 0x3e dash (0x45 mode 1); states 0x49 idle, 0x4a walk, 0x4b hit, 0x4c frozen, 0x4d blast, 0x4e slip/fall, 0x4f item, 0x50 out, 0x51 dash, 0x53 throw.

## Status of POLAR / MELT / MANIC
Replay-checked like TILT (table above). Client gaps (sim data is there): the knocked-off rider's bear flying away (`world.data` bolts with k = 2 are
not sent as bodies), snowball / frozen models, half-melted sectors are shown sunk 40% (est. visual).

## Unknowns
Easy / hard skill values, camera, the extra per-frame rand's owner (present on all four levels, replay), the render-node pool (see Replay), which
resource the failed bolt pickup ran out of (10 objects alive at the time), `FUN_800bcc9c` idle anims, option-flag (0x80) rule sets, team mode
(`DAT_8005a680`, `FUN_800bcf08` / `FUN_800b7cdc`), what happens at 0:00 on the clock, object 0x1606 (`FUN_800ca890` / 0x800c01c8, one per player, not
decompiled), the seal's dive animation height (state 7; y is left at 0), the round-reset tick on MANIC (which objects the engine's round init
still sees), POLAR / MANIC / MELT free runs longer than one round.

- Client (2026-11): broken POLAR pillars hide their placed stage holder (matched by PS1 position); a MANIC rider knocked off (data.foot) is drawn as the plain character. Bomb victims now get their `ko` / elimination tick (the 0x2000 flag is set by eliminate() on the S_BLAST enter, same tick).

## Flying bear (MANIC, object 0x1611)
- `FUN_800ca628`: node pack = the level model (0466), flip-book `FUN_80024e30(obj, {0, 0x800d56c4, 0x402})`: script 0x800d569c = anim ids
  0x4000..0x4006 (clip 0 frames 0-6 of the animated part4, the riderless bear) then 0x8001 -> script 0x800d56bc = 0x4006 looped (held).
  The port draws it as the sim's 'flybear' body.
