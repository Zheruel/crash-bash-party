# Polar Push (overlay 0x800b32b4-0x800d8a00, decompile: re/out_polarPush/ovl.c)

Levels (`DAT_8005a648`): 0x12 TILT PANIC, 0x13 POLAR PANIC, 0x14 MELT PANIC, 0x15 MANIC PANIC (0x16 = boss, not covered). Game logic 30 Hz.
Verified = read from code; **est.** = estimate; **unk.** = not decoded. Replay-exact = also checked tick for tick against the emulator (all four levels, see "Replay verification"). Option flag `DAT_8005a646 & 0x80` = alternate rules (not covered).
Setup: `FUN_800b5ac4` (callbacks), `FUN_800bafa0` (init), `FUN_800bb810` (per frame), `FUN_800b3aa0` (tilt). Per-level jump table 0x800b3360.

## Rules (all levels)
- 4 players; each one is a character (id 1-8 = CHARACTERS index 0-7). Last one standing wins: round ends (`DAT_800d4dec = 1`) when 3 players are
  in state 0x50 (out), or a player has flag 0x200. At 1:30 the shared clock ranks the remaining riders. Two or more survivors draw. Eliminated riders finish in reverse order of elimination.
- Buttons: D-pad move, **Square (0x8000) = dash/charge** (needs gauge >= cost), **Circle (0x2000) = throw** (only if holding a bolt, `+0x28`, MANIC),
  Square mash = climb back from the edge. (No jump.)
- USA Polar Panic, four cardinal inputs held separately from GO. The first ten updates moved the rider
  2, 6, 12, 20, 30, 42, 56, 72, 90 and 110 units from spawn. Up (`0x10`) increased Z, Down
  (`0x40`) decreased Z, Left (`0x80`) decreased X and Right (`0x20`) increased X. The stage camera
  projects positive native Z toward the top of the screen.
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
- Camera: see the scenery comparison below.

## Tilt Panic scenery (USA L18)

- The four static render nodes in level model 0486 cover the sky, sea, and two platform pieces. Five scenery actors (object `0x1607`) come from
  the level's actor table at file offset `0x489c` in `0486.t29`. `FUN_800c06d0` selects meshes `0x200d–0x200f` from the shared pack at
  `0x800546c4` (0403, byte-identical to 0480). These are parts 12–14. Part 13 has a half-turn local yaw.
- `FUN_800ca850` adds 2, 3, 1, 1, and 2 PS1 units to the five actors' x coordinates per 30 Hz tick. At x ≥ 6901 each resets to -7300.
  The web countdown starts at scenery tick 28 and reaches GO at tick 112. On USA frame 2502 the actors' X positions are 17, -3961, -4489, 4168, and -7336. The riders first move on frame 2503. WebGL matched all five X positions for 110 consecutive countdown and play ticks and retained the scenery phase after a late join during results.
- At native tick 2454 the mode-1 camera has H 512, pitch 227, zero target/yaw/roll, and translation (172, -573, 4580) before framebuffer scaling.
  The same 4:3 projection shows the restored silhouettes on the sea horizon. Disabling the five native render nodes removes the silhouettes.
  The USA actor tables for Polar, Melt, and Manic Panic have no corresponding scenery records.

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
  - Items: no timed pickup window. While +0x64 < 0 (and state != 1, no holder) the first bear from the random slot with dist^2 < 0x19000 gets kind
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

### Emitter rendering (USA levels 0x12–0x15)

- TILT, POLAR and MANIC use shared pack 0403, render word `0x2013` (part18). The unscaled entity's base Y is −1380, −1246 and −1301 raw units respectively. Each orbit tick adds `sin(phase * 0x10) >> 6` before advancing the phase by 8. The nearest eligible rider is selected before the orbit step. The emitter aims from its updated position and eases over one quarter of the signed 12-bit angular difference. The pitch uses the rider's Y with a 450-unit offset. While beaming, position and bob freeze and pitch eases toward `0x400`. TILT's emitter and effects use the arena's tilted transform.
- MELT uses level pack 0474, render word `0x200c` (part11), with base Y −1094. It bobs by up to 64 units and rocks on three axes. The tilt targets depend on a phase stepping −64 or +64 with the flight direction. The angles ease toward zero during the sector pause. Object `0x160b` follows the travel point at raw Y +256 and its render word is zero. The visible target is the separate `0x1605` script at raw Y +94.
- TILT runs 0403 scripts 1 and 2 (part42), a camera-facing halo at Y −64 relative to the emitter and a flat target at +94 absolute. POLAR and MANIC run scripts 4 and 3 (parts 43 and 56) with the halo at Y −96 and the target at +94. MELT uses only script 3 for its persistent target. The scripts pulse in scale and additive brightness over 39 or 40 ticks. The WebGL view applies a depth bias to the target to approximate the PS1 ordering table and keep the glow visible over the ice.
- The active column uses TILT 0486 script 1 (part9), POLAR 0478 script 0 (part6), and MANIC 0466 script 0 (part0) from the point under the emitter. Its upright plane leans in projection near the sides of the screen. The script starts showing on its first update, flickers through its authored keys, and ends after 120 ticks. Taking an item removes it immediately and starts a separate half-speed pickup script at the emitter's ground point (TILT/POLAR script 3, MANIC script 2). POLAR's script also emits particles. MELT uses 0474 script 0 (part0), a 60-tick column on sector arrival or item award. It has no 120-tick pickup window.
- Standard beam cues are `0x463` 15 ticks before activation, loop `0x44c` during the window, and `0x44d` on expiry. Pickup and zap use the respective item cues from the level VAB tables. The renderer restores the active visual and loop on snapshot resume. POLAR uses local randomness for the spark positions. The alternate `0x80` rules remain unported.
- Motion was compared over 639 recorded USA transitions per arena (99 intro plus 540 play). One-step replays matched the integer height and all three rotation words on those frames. USA and WebGL captures cover the three standard columns and MELT's sector column. The native capture setup advanced the standard mask timer and placed a rider beneath the second column to exercise its pickup. WebGL checks exercised countdown, beam expiry, pickup and snapshot resume using the regular view with Big Stein and Top G. The captures are under `/tmp/cb-polar-emitter`.

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
  Harness `pv/replay.ts`: loads row t into the sim, steps one tick with the game's generator (`FUN_80015590`: a += b; r = a % n; b += a + (a >>> 31), all words unsigned), compares
  with row t+1 (bears, AI, mask, pillars, sectors, bolts, seal, rng state). The frame makes **one extra rand before the player loop** - ported.
- Online Polar Push uses this generator from arena setup onwards. The executable's starting words are `0x00c587c1` and `0x0573cec9`. Online rounds mix their seed into the first word and keep both words in snapshots. Across the four arenas, three seeds and mixed/all-CPU lineups, 30,475 draws and their simulation states matched replay with the original MIPS routine supplying the draws, including after a snapshot resume. Menu activity on a console can advance its stream before a stage starts.
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

In four controlled USA Tilt Panic openings, the countdown flag cleared at sample 99. Square held from sample 91 or 98 left the rider idle. Square first read on 99 set the pressed word to `0x8000` and entered dash state `0x51` on 99. Pressing one sample later moved both to 100. The same fresh press started the dash on 99 in Polar, Melt and Manic Panic. The host and local prediction use the last countdown pad as the previous input for the first playable step.
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
| 0x453 / 0x455 | 500 lb weight spawns / hits ice | 7/9 | 7/9 | 7/9 | 7/9 |
| 0x456-0x45a | skid on entering idle at speed>32 (random of 6) | 10,11,10,11,10 | 12,10,11,12,... | see t0c | see t0c |
| 0x45c | edge slip | 12 | 13 | 13 | 14 |
| 0x45d | rider enters the out state | 13 | 14 | 14 | 15 |
| 0x46a-c | pillar breaks | - | 20,21,22 | - | - |
| 0x489 / 0x48a / 0x48b | sector melt / snowball / snowball bump | - | - | 20/21/22 | - |
| 0x3fa / 0x48e / 0x48f / 0x490-3 / 0x494 | bolt appears / taken / lands / hits / splash | - | - | - | 25/21/22/23/24 |
| 0x47e-82 | unmapped on TILT (option-flag rules) | | | | |
The id table 0x80064508 is patched per level: read each level's own dump.
Char voices: hit voice ids per char (3-6, 0x35-38, 0x67-6a, 0x99-9c, ...), dash voices 0x16,0x48,0x7a,0xac,0x142,0x174,0x110,0xde (chars 1-8) in the voice bank.
Anim clips (`FUN_800854c0`): 0x3a idle, 0x3d edge hang, 0x3e dash (0x45 mode 1); states 0x49 idle, 0x4a walk, 0x4b hit, 0x4c frozen, 0x4d blast, 0x4e slip/fall, 0x4f item, 0x50 out, 0x51 dash, 0x53 throw.

## Status of POLAR / MELT / MANIC
The client renders the Manic flying bear from its own body, Melt's per-character snowballs and frozen riders, and the sixteen animated ice wedges from the sector state. The replay coverage above measures the simulation.

## Unknowns
Easy / hard skill values, camera, the extra per-frame rand's owner (present on all four levels, replay), the render-node pool (see Replay), which
resource the failed bolt pickup ran out of (10 objects alive at the time), `FUN_800bcc9c` idle anims, option-flag (0x80) rule sets, team mode
(`DAT_8005a680`, `FUN_800bcf08` / `FUN_800b7cdc`), what happens at 0:00 on the clock, object 0x1606 (`FUN_800ca890` / 0x800c01c8, one per player, not
decompiled), the round-reset tick on MANIC (which objects the engine's round init
still sees), POLAR / MANIC / MELT free runs longer than one round.

- Client (2026-11): broken POLAR pillars hide their placed stage holder (matched by PS1 position); a MANIC rider knocked off (data.foot) is drawn as the plain character. Bomb victims now get their `ko` / elimination tick (the 0x2000 flag is set by eliminate() on the S_BLAST enter, same tick).

## Flying bear (MANIC, object 0x1611)
- `FUN_800ca628`: node pack = the level model (0466), flip-book `FUN_80024e30(obj, {0, 0x800d56c4, 0x402})`: script 0x800d569c = anim ids
  0x4000..0x4006 (clip 0 frames 0-6 of the animated part4, the riderless bear) then 0x8001 -> script 0x800d56bc = 0x4006 looped (held).
  The port draws it as the sim's 'flybear' body.

## Tilt Panic seal and fish (USA L18)

Object 0x1610 is the fish the seal follows. Both use pack 0468 and entity scale 8000/4096. The fish uses render word 0x2002 in flight. At tick 27 it lands, then advances through words 0x4180–0x418f while it skids. The two rim fixtures settled at (1063, 0, 913) and (−1122, 0, −967). The seal removes the fish on entering its walk at tick 131. Its dive keeps the origin at y=0 and animates the mesh through 0x4126, visible through state 6. The render transform uses the level tilt matrix for the platform, riders, seal and fish (entity flag 0x200000, FUN_8001daf8). The local fish matrix uses Rx(pitch) × Ry(yaw) in PS1 coordinates.

FUN_800c3e6c and FUN_800c40b8 initialize and update the fish. FUN_800c358c supplies the seal's pose and sound markers. In both cycles sound 0x478 accompanied the fish launch. 0x479 accompanied the landing at tick 27. At 92 the seal jumped with 0x473, then at 119 the landing 0x475 and one bark (0x46f–0x472) played together. Footfalls 0x476/0x477 use the same sample at rates 1 and 1.103. 0x47a played at 161, with 0x474 on diving at 211 or 213 depending on the rim.

Two PCSX traces matched 251 and 253 consecutive simulation states through disappearance. Each trace supplied 17 sound calls. The room RNG selects the bark tone. With the result flag set during the warning, the fish completes its flight and flaps while the seal's warning timer holds. With the result flag set after the seal launches, the seal finishes landing and walking. The client advances these objects on a private terminal world, including when entering the result late. A two-player WebRTC match reproduced the fish's position, rotation, and pose in 132 snapshots. Whole-round rasterization and audio mixing remain unverified.

## Bomb expiry visuals (USA L18–L21)

Both mask handlers spawn object `0x1602` at the carrier's X/Z and raw Y −2200. `FUN_800cab8c` selects shared pack 0403 word `0x2003` (part2, the 500 lb weight) at unit scale with zero rotation. The weight stays in world space when Tilt Panic's ice rotates.

In the USA L18 PCSX traces, age 0 is the spawn tick. The weight holds for one update, then falls with initial raw Y velocity +64 and acceleration +8 per tick. `FUN_800bfa98` clamps it to the carrier's launch Y at age 19 and rebounds with `-vy >> 3` on the first four contacts. The rider holds its last pose and both render entities clear visibility at age 17. The weight hides at age 63. The object keeps ticking during results, and the out flag is set at age 123.

The web view reconstructs the drop from the snapshot origin and expiry tick, then advances it using the result clock. Chromium matched 504 visible positions and 600 visibility samples across the four stages in live and terminal playback, including a view rebuilt mid-result. Big Stein and Top G kept their custom models, including Top G on foot in Manic Panic. Two-client WebRTC matches showed impact and disappearance in Tilt Panic play and Manic Panic results.

### Carried fuse audio

Both the weight and the zap key `0x452` on pickup. This loops sample 6 from PCM sample 28. The zap also keys a separate continuous `0x465` electrical sound. A handoff keys `0x454` and preserves both the fuse timer and its playing voice. Expiry keys `0x453` for a weight or `0x466` for a zap. The weight's first ground contact keys `0x455` 19 ticks after spawn.

The item handler sends `0x1e00 + floor(elapsed * 0xf00 / 300)` to `FUN_800228a4`. The voice driver applies the bend on its next update. All four banks use centre note 95, fine tune 58. `FUN_80042a20` multiplies the truncated coarse and fine tables at `0x8006dfac` and `0x8006dfc4`, then rounds to the SPU pitch register. MELT arms one tick later and sends the bend before decrementing the fuse. In the three other stages, a pickup at tick 0 starts the voice at tick 1, first changes its pitch at tick 15, and expires at tick 313. MELT first changes pitch at tick 17 and expires at tick 314.

Seven controlled USA recordings covered each available item on each stage. Chromium's decoded fuse source reproduced all 2,185 active pitch registers, including consecutive ticks before and after a transfer. Rebuilding the view mid-fuse resumed at the corresponding loop position. These checks cover sample selection, pitch and timing. Positional mixing and the SPU release envelope remain unverified.

In a two-browser WebRTC match, Big Stein passed the weight to Top G. Both browsers reproduced all 299 armed timer values and played the spawn and impact cues. A second match disconnected the guest while Top G held the weight. The resumed guest started at the current loop offset and matched the host's pitch again.

### Ledge recovery and water-entry audio

On all four stages a slow mounted slip keys `0x45c` on entry to state `0x4e`. The normal hang script can reach state `0x50` with the entity's raw Y still at zero. `FUN_800d0470` keys the water sound `0x45d` at that state transition. In the captured fixtures this occurred 42 ticks after the initial slip on TILT (engine character 8) and 40 ticks later on the other three stages (engine character 4). WebGL matched the visible hang poses and exit ticks. After ranking, an eliminated rider's hang or fall can finish on the client's private world and play the cue once.

Five successful recovery presses run `FUN_800cff44` and release the hanging sound. In the controlled TILT recording, presses on alternating updates returned the rider to idle at tick 12 and cleared the voice. Real Chromium Z-key input reproduced that cutoff with Big Stein and Top G on all four stages.

### Individual versus timeout and TIE (USA L18–L21)

An uninterrupted Polar Panic capture reached GO on sample 99. The riders had already taken their first movement step. The BCD timer first decremented on sample 126 and dispatched the result on sample 2797 (simulation update 2699). On all four stages the ranking routine at `80084788` reads the same value, 20, at rider offset `+0x36` for every survivor. It excludes eliminated riders. A hanging rider can still count. Distance from the center and remaining dash charge do not enter the comparison.

In the accelerated Tilt Panic recording, all four counted at the buzzer, including two hanging riders. During TIE the engine suppressed pad input and held the ice inclination. The two remaining mounted riders slid from (−1514, 1222) and (654, 936) to (−1994, 142) and (−66, −744) at tick +120. The hanging riders both fell out. Flat-stage captures with two or four survivors also drew. Across the four fixtures the port matched 3744 samples of position, rider state and elimination flags, including 1920 post-buzzer samples. Chromium WebGL matched all 1274 visible rider pose words during the four TIE sequences, including after rebuilding each view at draw tick 58.

The result camera halves the tracked width, removes forward reach, and uses three quarters of the tracking height (`80078dd4`). Melt Panic's extra tracked entity `160b` follows the moving mask at raw Y 256 and leaves the tracking list one update after the clock dispatches. Replaying the recorded tracking inputs from the pre-buzzer camera matched all 484 sampled camera positions. The client interpolates the fit at display refresh rate. Snapshots include the eased camera translation and its last target. A late join reconstructs the riders and camera from that snapshot.

The TIE mesh begins at +2 and triggers sample `0x1af` at +23. The music duck clears at +120 and the original round resets at +121. Two real WebRTC clients with Big Stein and Top G agreed on the terminal snapshot and zero awards in both Cup and Party play. A Melt Panic guest disconnected during TIE and restored the same snapshot and result without repeating the cue. A lone Top G on Manic Panic received one cup and played his name, “wins,” and character reaction.

### Individual versus victory (USA L18–L21)

On the update before state `0x58`, the remaining rider receives flag `0x200` and all tracked boxes shrink. On entry the other riders and arena hazards leave the camera list. If the surviving rider is hanging outside the hull, the list becomes empty and the camera continues toward its last target. Otherwise it fits the winner. A standing Crash in L18 took the camera from (−438, −266, 9908) at entry to (758, 612, 439) at +67. A hanging Koala on the same arena kept a wide shot, from (206, −665, 10490) to (192, −668, 9931). Tilt continues to update until the character reaction.

`FUN_800d257c` starts idle script 0x3a mounted or 0x42 on foot. The winner turns toward yaw zero by a quarter of the signed difference per tick. The first visible word of the streamed cheer is frame 1 of script 0x46 mounted or 0x47 on foot. In disc character order 1–8, the measured load delays were 13/12/16/14/13/13/13/15 mounted and 12/14/14/12/14/13/15/15 on foot. The implementation uses these measured delays for repeatable online playback. The reset followed the spoken reaction by 123 updates. Cup standings use the common versus tally timing, three updates after the reaction.

Sixteen controlled PCSX runs covered all eight original winners mounted and on foot. Three opponents started outside the rim. The on-foot fixtures set the native mount component before the result. Melt used the recorded opening mask target. Across 3,364 result updates, Chromium matched the native winner pose word, facing, and camera position through the last frame before reset. Every view was rebuilt at +67 from the serialized terminal state. Big Stein mounted and Top G on foot used their own Manic Panic models and matched Cortex's pose words and facing on 424 further updates.

Two production WebRTC matches exercised keyboard input and rim knockouts. In Manic Panic, Top G won a cup and the tally opened at tick 101. A guest disconnected after hearing his name, received the same terminal world when it rejoined, and heard his reaction once. In Polar Panic, both clients played Big Stein's three victory cues and awarded him four Party points. The normal points phase lasted 8.53 seconds, including 1.2 seconds for the standings.

### Ice reflections (USA L18–L20)

The second rider entity at player record offset +12 uses model slot 0x80054654 (DAT 0484, textures 0483). It contains the bear's additive reflection below the ice plane. FUN_800cc3b4 selects an independent pose for idle, walk, dash and victory. It hides the reflection on an edge hang or elimination and skips Manic Panic. Melt Panic swaps in stage word 0x2003 at raw Y +664 for a snowball. The web reuses those meshes and blend modes. For a WebGL depth buffer, it tests the reflection against the tilted ice surface so riders and pillars can occlude it. The mounted model also uses its disc origin, including Crash and Koala.

Three PCSX recordings matched 750 idle and winner reflection words, accounting for the measured load time in each run. Two Polar Panic recordings matched another 440 idle, walk and dash words. On the Tilt Panic comparison image, the screenshot taken at RAM sample 246 most closely matched web sample 244. The WebGL comparison shows the arena pass before the shell HUD. GPU ordering, rasterization and the display buffer can produce pixel and timing differences.

## Fidelity audit (2026-11)

Scope of this pass: sound, voice and effect-object presentation. The simulation (physics, items, AI, seal, bolts) is replay-exact per the sections above and was only spot-checked; the edits below add events and leave every random draw in place (state parity with the previous sim over 49,734 all-CPU ticks, 4 arenas x 5 seeds x 3 rosters). Status: **done** = ported in this pass, **ok** = confirmed unchanged, **todo** = open.

Corrections to earlier sections:
- Thumps `0x446-0x449` exist in all four level banks (0450 / 0451 / 0448 / 0447), not only TILT. Every tone of those banks has volume 127 and centre pan and every `FUN_80022660` call in the overlay passes volume 0x1000, so all effects key at one level (`PO_FULL`).
- Engine character 6 is Rilla Roo and 8 is Koala Kong (`DISC_CHARACTER`); 7 is Dingodile.
- Voice ids: n 0x16 = mounted dash start (keyed from code, `FUN_800d0808`), n 0x18 = dash script 0x3e cue, n 0x17 = throw (code), n 0x1a = on-foot dash start (Cortex's bank holds it as 0x1c), n 0x15 / 0x14 = the two footsteps of on-foot walk script 0x43, n 0x19 / 0x18 (Cortex 0x19 / 0x1a / 0x1b) = cues of the mounted win script 0x46. On-foot win 0x47 and on-foot dash 0x45 carry no cue.
- Rider sound handle = entity +0x94: footfalls, skid and ledge slip replace each other on it; entering idle, walk, dash, on-foot idle / walk and the climb release it (`FUN_800225c4`).
- Object table 0x80098984: 0x1604 pillar chunk, 0x1606 skid tracks, 0x1612 puff, 0x1613 smoke flip-book, 0x1614 shards, 0x1615 / 0x1616 dash meshes. Node flag bits 5-6 = GPU blend (0x21 add, 0x41 subtract, 0x61 add quarter), node +0x76 darkens (fade). Entity +0x5d: 0 = Rx Ry Rz, 2 = Rz Ry Rx.

| Function | Role | Ours | Status |
|---|---|---|---|
| `FUN_800cd594` / `FUN_800d191c` | idle enter (mounted / on foot): release handle, skid `0x456 + rand(6)` at pitch `0x1d80 + rand(0x100)` on the handle | sim `pushOff.ts` setState S_IDLE / S_FOOT (`skid`, `quiet`); view `pushOff.ts:572` | done |
| `FUN_800d31a0` / `FUN_800d2e00` | walk enter: release handle; on foot script 0x43 | sim setState S_WALK / S_FOOTWALK (`quiet`, `voice`) | done |
| `FUN_800cdbd0` | walk tick: footfall `0x49c + slot` (0x4a0 shrunk) at script pc 4, on the handle with position | sim stateTick (`step`); view `pushOff.ts:568`, `polarAudio.ts` hold | done |
| script 0x43 (anim VM) | on-foot footsteps n 0x15 / 0x14 | sim stateTick `FOOT_STEP` (`voice`) | done |
| `FUN_800d0808` | dash enter: release handle, voice n 0x16 (on foot n 0x1a / Cortex 0x1c) | sim setState S_DASH (`voice`); view `pushOff.ts:558`, dash case | done |
| script 0x3e (anim VM) | dash cue n 0x18 per character, engine 8 also n 0x16 at tick 1 | view `DASH_VOICE_FRAME` | ok |
| `FUN_800bbf2c` | collision: thump `0x446 + rand(4)`, snowball 0x48b (twice above 64 u/tick), hit voice rand(4), rumble | sim `collide` (`thump`, `snowbump`, `voice`, `hit`); `shell/rumble.ts` | done |
| `FUN_800cde8c` | stun enter: 0x467, first hit voice, pack 0403 script 0 at rate 0x200 (tilt-flagged), stun skin (node flag 0x400000, +0x8e) | sim S_STUN (`stun`, `voice`); view `stunSkin`, `ModelInstance.staticSkin` | done |
| `FUN_800ce664` | stun tick: two rising wisps every 24-31 ticks; mounted pose word held from tick 32 | sim (`dazed`); view `DAZED_WORD` `pushOff.ts:437` | done |
| `FUN_800d10a0` + state 0x53 | throw: voice n 0x17 | sim setState S_THROW (`voice`) | done |
| `FUN_800cfc58` / `FUN_800d0060` / `FUN_800cff44` | slip 0x45c on the handle, climb releases it, splash 0x45d | view `playSlip`, `hang` / `climb` / `splash` | done (through the handle) |
| `FUN_800c0888` | pillar: `0x46a + rand(3)`, three chunks 0x1604 (`FUN_800caa90` / `FUN_800caa60` / `FUN_800bfd38`) | sim `pillars` (`pillar`, o = angle); `polarFx.ts` `pillar` | done (its `FUN_800320ec(1)` is VSync(1), a non-blocking h-count read: no hit-stop) |
| `FUN_800ca890` / `FUN_800c01c8` | skid tracks 0x1606 (17 nodes per rider) | `polarFx.ts` `riderTick` | done, from the disassembly of 0x800c01c8 |
| `FUN_800ca424` / `FUN_800c42a0` | puff 0x1612 | `polarFx.ts` `puff` | done, checked from the code |
| `FUN_8008cef8` / `FUN_8008c368` | smoke flip-book 0x1613 | `polarFx.ts` `smoke` | done, checked from the code |
| `FUN_800c4498` / `FUN_800ca344` | 17 shards 0x1614 | `polarFx.ts` `burst` | done, checked from the code |
| `FUN_800ca2b8` / `FUN_800c45bc`, `FUN_800ca220` / `FUN_800c4748` | dash meshes 0x1615 (engines 7, 8) / 0x1616 (engines 3, 4 and the custom riders) | `polarFx.ts` `dashMesh`, view `dashPart` | done, checked from the code (inits disassembled) |
| `FUN_800d17e8` / `FUN_800d14cc` | snowball: rolls `speed >> 6` per tick, rotation order 2; its reflection copies the yaw only (`FUN_800cc3b4`) | view snowball branch (rolled in the view, one tick behind) | done |
| `FUN_800b4b04` / `FUN_800b4c74` | thrown bolt: trail puffs, ice mark 0x202f, 0x48f / 0x494, level script 1 on landing, hidden for the 31 blast ticks, shards | sim `boltTick` (`puff`, `boltLand`, `strike`); `polarFx.ts` `boltShadow`; view bolt branch | done, checked from the code |
| `FUN_800b44b4` | bolt hit: `0x490 + rand(4)`, first hit voice (engine 8 keys Dingodile's 0xfd, engine 6 none) | sim `boltHit` (`voice`, `zapped` v >> 2 = take) | done |
| `FUN_800d2248` / `FUN_800d2334` | burnt rider: smoke at enter and ticks 2 / 4, shards, two wisps every 1-7 ticks; mesh 0x202d on the rider's entity | sim S_BURN (`burn`, `puff`); view burn mesh at the rider place and yaw | done |
| `FUN_800ca514` | flying bear: puff every 1-7 ticks, hidden at tick 31 | sim (`puff` v 3); view flybear branch | done |
| script 0x46 (anim VM) | mounted win cheer cues after the stream load | view `WIN_CUES` / `winCues` `pushOff.ts:299` | done |
| `FUN_800bd67c` / `FUN_800c1584` | mask items and their sounds | `polarItemEmitter.ts` (now at `PO_FULL`) | ok |
| `FUN_800c32a4` / `FUN_800c358c` | seal and fish cues | view `sealCue` | ok |
| `FUN_800d3170` + object 0x1602 | bomb expiry 0x453 / 0x455, pass 0x454 | `polarBombExpiry.ts`, view `boom` / `bomb` | ok |
| `FUN_800cad60` | CPU | sim `aiTick` | ok: the replays compare the AI struct word for word every tick; helper rows in `polarPush-audit.tsv` |
| `FUN_800b5910` + `FUN_8007d5ec` / `FUN_8007d6d0` | forced victory: 240 ticks after every human is out the HUD shows object 5 (0x194); a fresh Cross (B) keys 0x195, from slot rand(4) the first rider in wins (0x58, no 0x200), the rest go out under 0403 script 5 without 0x45d; two presses on one tick run it twice | sim `forcedVictory` / `roundSkip`; view `sfx` / `skipOut`; `app.ts` prompt | done (`test-polar-skip.ts`) |
| camera mode 1, HUD, countdown, timeout, draw, winner tally | shared engine (`FUN_8007cc80` / `FUN_8007ce50` HUD) | view `ps1Hud`, `Ps1Follow`, `stepPolarResultMotion` | ok per `test-polar-timeout.ts` and the recorded camera / countdown fixtures; meter fill now `gauge >> 2` of 0x40 units, at most 0x3f |

Remaining todo (for a follow-up pass):
1. The hit voice has its own handle in the original (a new take cuts the last); ours overlap. Needs a per-player voice handle in `client/shell/voice.ts` (audio agent).
2. `preloadRoundVoices` (`client/shell/voice.ts`) does not warm the family b ids n 0x14-0x1c, so the first dash / throw / step voice of a round can land late.
3. HUD bar placement: `FUN_8007cc80` builds every bar from `*(short *)0x8009925c` + 0x10..0x50 (x) and 0x37..0x43 (y) in HUD units (about 0.8 x / 0.5 y of our 512x240 frame, as Crate Crush's measured bar). The node's own offset is set elsewhere; the position (x + 16, y 39) is the Crate Crush one and was not re-measured.
4. Emulator A/B (not run: the playwright-core in `tools/emu/node_modules` has no package entry in this checkout): the dash mesh's first frame (spawned at pc 7 / 10, drawn before its first update?), the skid tracks' absence on MANIC (code: the reflection entity never moves there), the sort bias of tracks and the bolt mark.
5. Not ported: the alternate / adventure rules (`DAT_8005a646 & 0x80`, ids 0x46d / 0x47e-0x482, state 0x5a), the boss level 0x16 objects 0x1617-0x1625, team mode (`DAT_8005a680`). Rows in `polarPush-audit.tsv`.
