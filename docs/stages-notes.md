# Stage research notes

## Facts
- Stage models are in group 29 (files 607–715), NOT in the per-level groups. Groups 5–28 hold per-level props
  (vehicles, crates, LOADING/FAIL text, weights, sky sphere 377).
- No level→model table found in exe/overlay yet (model_slots at exe 0x80052a54, 0x38 B/slot; overlay level records at
  0x80098f48 hold coordinates + text pointers). Match visually against emulator captures.
- Hints from slot order: Crate Crush pairs (main, backdrop) alphabetical: (711,709) Drain, (715,713) Jungle, (707,705) Snow,
  (703,701) Space, (699,697) Tie-Breaker?. Twins (same mesh, different texture): 683/693, 685/695, 649/651.
  Tank stage slots 71–78: 675 671 667 663 | 673 669 665 661.
- Confirmed: 691 = JUNGLE FOX (Tank Wars), 478 = POLAR PANIC. Ring Ding likely 625 (627 brown-wall twin).
  Real CRASHBALL arena is neon teal (docs/reference). Pogo-a-gogo = construction site grid ~10×7; El Pogo Loco = pink desert
  sand grid; Pogo Padlock = warehouse with hazard stripes; Pogo Painter = jungle temple stone grid.
- Level ids: 0–3 Crate Crush (Jungle, Space, Snow, Drain), 4 Papu Pummel, 5–9 Tank (Swamp, Desert, Jungle, Metal, Big Bad),
  10–13 Pogo, 14–17 Ballistix (Crashball, Beach Ball, N.Ballism, Sky Balls), 18–22 Polar (Tilt, Polar, Melt, Manic, Bearminator),
  23–26 Dash (Dot, Toxic, Splash, Dante's), 27 Ring Ding, 28 Dragon Drop, 29 Mallet Mash, 30 Keg Kaboom.

## Emulator (tools/emu)
- Serve project root on :8080 (`python3 -m http.server 8080` from the repo root; EmulatorJS index.html loads rom/crash-bash.zip).
- `DRV_PORT=<port> EMU_OUT=<dir>/ node tools/emu/drv.mjs` → headless Chromium driver with /eval?js=, /shot?f=name, /key, /wait.
  Needs playwright-core (in the scratchpad node_modules: run with NODE_PATH or from there).
- Boot ~45 s (~12 s with `EJS_emulator.gameManager.functions.setFastForwardRatio(8)` + `toggleFastForward(1)`).
- Input: `tools/emu/pad.sh <cross|circle|up|down|left|right|start> [n] [gap]` (simulateInput; keyboard is unreliable).
- Menu: Down, cross (Battle Mode) → cross (players) → cross ×3 → Game Options. Save state there:
  `window.S0 = EJS_emulator.gameManager.getState()`; load with `EJS_emulator.gameManager.loadState(window.S0)`.
- **Cheat `8005A648 <level id hex4>` jumps into that level** (verified 0–13). `tools/emu/lvl.sh <hex4> <name>`, `lvl2.sh <dec>`
  (Rules screen + a gameplay frame). RAM dump: `getstate.mjs` (RASTATE; RAM A at offset 0x9035 + (A − 0x80000000)).
- Existing captures: scratchpad/emu/lv/L<n>.png (rules screens 0–13), scratchpad/emu/lv2/ (R<n> rules, G<n> gameplay; loop in progress).

# HD pipeline: tools/upscale_all.py <sets> (gpt-image -> assets/hd-raw), then tools/hd_colorfix.sh (-> assets/hd, original colours)
