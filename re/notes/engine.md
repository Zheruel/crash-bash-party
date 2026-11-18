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
