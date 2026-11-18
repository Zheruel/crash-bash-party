# Mini-game fidelity plan (lead's spec)

Goal: every mini-game looks, feels and plays like the real Crash Bash level it represents.

## Method (per game)
1. **Reference**: capture the real level in the emulator (tools/emu, cheat `8005A648 <level id hex4>` jumps to a level;
   see docs/stages-notes.md). Grab several gameplay frames per variant + a short frame sequence for timing (movement speed,
   ball/projectile speed, jump arcs, round length). Save best refs to docs/reference/<gameId>/.
2. **Stage**: identify the real stage models (group 29 = files 607–715; per-level props in groups 5–28) incl. all pieces
   (floor, walls, backdrop/sky). Record in `assets/stages/<gameId>.json` = `{ "arenas": { "<gameId>": ref, "<gameId>:<variant>": ref, ... }, "props": {...} }`
   (merged over catalog.json by client/crash.ts). Remove stand-in/procedural geometry wherever the real stage provides it.
3. **Camera**: match the real game's fixed camera (position, angle, FOV) per level from the reference frames.
4. **Feel**: match character scale relative to the stage, speeds, physics, timing, the action buttons, sounds (assets/audio,
   the level's sfx bank), music (already per level).
5. **Rules/HUD info**: match the real rules + what the real HUD shows (score/health per player in the corners).
6. **Verify**: side-by-side screenshots ours vs real for every variant; iterate until a Crash Bash player would not notice.

## Ownership (to avoid conflicts)
Each agent owns only: shared/games/<id>.ts, client/games/<id>.ts, assets/stages/<id>.json, docs/reference/<id>/.
Shared helpers (client/games/kit.ts, fx.ts, characters.ts, crash.ts, shared/physics.ts) are read-only — copy what you need
into your own file. Each agent runs its own emulator driver (DRV_PORT/EMU_OUT env) and own dev ports.
Keep sims deterministic (world.rng only) and `npm run test:loopback` passing.
