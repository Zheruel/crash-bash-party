# PODIUM (level id 43; our final ceremony)

Source of truth: `re/out_podium/{all,ovl}.c` (overlay 0721.t6a at 0x800b32b4, shared with the warp rooms), RAM `re/dumps/L43.ram`
(all tied, frame +439) and `L43b.ram` (scores 1/3/0/2). Data: `tools/levels/podium.py` -> `assets/stages/podium.json` +
`assets/stages/placements/L43.json`. Port: `web/client/scene/podium.ts`, camera `web/client/scene/podiumCam.ts`.
References: `docs/reference/podium/` (`real_tie_*` all tied, `real_l0_*` scores 1/3/0/2, number = frame; `ours_*` the port at the same frames, `cmp_*.jpg` side by side).

## Getting there in the emulator
The level cheat only bites when a level loads. From the Adventure menu state: pin `8005A648 002B`, cross (New Game), cross x4
(players, character), wait for the Aku / Uka intro, Start then cross to skip it: the loader then loads level 43 instead of
warp room 1. The four seats are the last character-select state (P1's pick + three CPUs). Tournament points are the bytes
`0x8005a6b3..b6` (one per player): pin them with `3005A6B3 00xx` .. `3005A6B6 00xx` before the load to get a layout.
Frame 0 below = the frame camera mode `DAT_800ad12c` becomes 4.

## What is in the scene
- Level model = slot 205 = **0379** (the title-screen set, also level 40). Static objects (list at `*(level+0x1c)`): `0x5001`
  `extra_df8c` (podium disc, top at y 0, radius 1087, pillar below) and `0x5002` `extra_eb1c` (the two-armed machine), both at
  the origin, identity. Type-100 parts = sky layers: `part6` (purple sphere) and `part7` (stars). Others: pedestals
  `part11` / `part10` / `part8` (311 / 396 / 497 high), trophy `part9`, char-select pedestals `part3` / `part4`, logo `part0`.
- Shared pack **0377** (slot 213): firework heads `part32..38` (camera-facing glows), trail textures 0376 `tex007..012`.
- Characters = slots 214-221 = **758 crash, 756 coco, 754 cortex, 752 brio, 750 tiny, 748 (engine 6), 746 dingodile,
  744 (engine 8)**, picked by engine character 1..8 (`FUN_800b93b4`). Each holds only the clips the level asks for by name
  (`FUN_800165f8`: descriptor word +16 = name hash, sum of char * position): `WIN_BREATHE`, `WIN`, `LOSE`, `LOSE_BREATHE`
  (only 744 and 746 have the last one). The real players (0x8009d52c) sit hidden at the origin.
- HUD pack 0732: the score strip (object slot 6). Sound: bank 0181. Music t10 0288.
- Model 0135 (`props.podium`) and 0133 are not used here. 0051 (the Aku / Uka temple) is only left over from the intro.

## Setup (`FUN_800b875c` once, `FUN_800b88b8` per load)
- `FUN_800b8aa4` sorts the players by points, best first, into `0x8005a6bb..be` (stable: lower seat first).
  `FUN_800b8bc8` picks the layout from the ties (c1..c4 = sorted points): c1==c4 -> 7, c2==c4 -> 5, c1==c3 -> 6,
  c3==c4 and c1!=c2 -> 1, c2==c3 -> 2, c1==c2 -> 3 (4 when also c3==c4), else 0.
- Layout table `0x800bd210`, 8 x 4 x 12 bytes: x, z, pedestal 1..4, loser flag (x right, z away from the camera):
  0 `(0,0,4) (-768,0,3) (768,0,2) (640,-512,1)` · 1 `(0,0,4) (-768,0,3) (768,0,1) (448,-512,1)` · 2 `(0,0,4) (-768,0,3) (768,0,3) (640,-512,1)` ·
  3 `(0,0,4) (-768,0,4) (768,0,3) (640,-512,1)` · 4 `(0,0,4) (-768,0,4) (-384,-512,1) (640,-512,1)` · 5 `(0,0,4) (-640,-512,1) (0,-512,1) (640,-512,1)` ·
  6 `(0,0,4) (-768,0,4) (768,0,4) (640,-512,1)` · 7 `(-768,0,1) (-384,-512,1) (384,-512,1) (768,0,1)`. Pedestal 4 = winner (flag 0); in layout 7 nobody loses.
- `FUN_800ba9c8`: object 0x1f01 at (x, 0, z), yaw 0. Pedestal > 1 adds a second node: render id `0x800bd1f0[ped-1]`
  (2 -> part11, 3 -> part10, 4 -> part8) at the floor, and lifts the character by `0x800bd200[ped-1]` = 0 / 320 / 384 / 512.

## Characters (`FUN_800b92a0`, anim VM `FUN_800251a8`)
Script table per character `{win idle, win, 0, ->0, lose idle, lose, 0, ->4}`; ops `0x8011 n pose` = n frames forward from pose,
`0x8012` = backward, `0x8000` loop, `0x8001` next table entry; pose = `0x4000 + (clip << 7) + frame`, one frame per 30 Hz tick.
Everyone starts in win idle with counter 0. While in an idle script: counter 0 -> winners play `win` and reload the counter
(`rand(40)+10`; cortex `rand(30)+20`; brio `rand(60)+60`), losers play `lose` and reload `rand(40)`; otherwise counter - 1.
`win` returns to win idle, `lose` to lose idle (engine 8's `lose` loops by itself). Decoded scripts: podium.json `chars`
(keyed by engine character; `base` = the same character's in-game model, model slots 1-8).

## Camera (mode 4: `FUN_800b96f4`, then `FUN_80013f44` with divisors `0x800ad0f4` = 2,2,2 / 2,2,1 / 4,4,4)
Two paths in the level data (`*(level+0x28)` ids, `+0x2c` pointers): node 0 = look-at target, nodes 1.. = polyline with the
running distance. Path 1 target (7,-102,6), 13 nodes from (3557,-547,-1493) round to the front (1,-283,-2252), distance
3854..7752; path 2 target (0,301,9), (0,-281,-2254) -> (3,-627,-2859), 2263..2869.
Phases: 0 path 1 at 32 units / frame (122 frames) · 1 hold 60 · 2 path 2 (19 frames; the trophy appears) · 3 hold 240 counted from the phase start (the 40-frame rise included), strip
slides up 5 px / frame from 540 to 340, cross from any pad (`FUN_800bab40`) jumps to 4 at any time in phase 3 · 4 one frame · 5 strip down, 60 frames · 100 leave (frame 501). The strip moves on the phase the frame starts in.
Each frame: point on the path, target eased `>> 4`, then distance / yaw `atan2(-dx, dz)` / pitch `atan2(dy, horizontal)` are eased
into the camera block (H toward 512 by `(d + 4) >> 2`, so it settles on 513). The block starts from the loader's values
(all 0, H 320), and the level start runs the function twice. Final block: z 3004, target (2,286,6), pitch 200, yaw 0.
The port matches a 440-frame emulator trace to within 1 unit on every field.

## Sky (`FUN_80095258` registers, `FUN_8009440c` draws)
Layers rotate by `frame * speed >> 12` per axis, table `0x800a02d8` (20 bytes per layer): sphere (2043, 8131, 4000),
stars (8131, 4000, 2020). Drawn first with the backdrop camera: rotation only, H = 320 (the scene uses 512).

## Trophy (object init `FUN_800ba8ec`, update `FUN_800b9538`)
Part9 at (0,-1196,644), hidden until phase 2, then scale += (0x1000 - scale) >> 5 until 0xeff -> 0x1000. With t = level clock
`DAT_8005b690`: x += 280 sin(40t), y += 64 (sin(45t) + sin(80t)), rx = 256 sin(70t), ry = 64 + 128 sin(140t),
rz = 128 (sin(70t) + sin(100t)) (angles in 4096ths; checked against the trace).

## Fireworks (`FUN_800b8f50`; object 0x1628: `FUN_800b9d1c`, `FUN_800b9e90`, `FUN_800ba374`, `FUN_800ba1b4`)
Counter `0x800bd390` = 0x5a at load; each frame it counts down while >= 0 and fires on the frame it is -1: first burst on frame 92, then `rand(20)+10` + 2 = every 12-31 frames. RNG order: colour rand(2), bang rand(6), crackle rand(6), x rand(0x2000) twice, y rand(0x400), next wait rand(20). Position (rand(0x2000) - rand(0x2000), rand(0x400) - 0xc00, 0x1000); the
sparks sit 0x2000 further back. Colour = one of two by the winner's engine character: 3, 4, 6, 8 -> green / red, others ->
blue / white (heads part32 / 36 / 33 / 35 / 38 / 37, trails tex007 / 011 / 008 / 010 / 009 / 012 for colours 0..5).
12 sparks at 45 degree steps: start (64 sin, 64 cos - 1024), velocity 256 (sin, cos) +- 64, each frame vy = (vy + 6) * 230 >> 8,
vx = vx * 230 >> 8. Eight trail joints follow one frame behind each other, ribbon half-width 128 - 16 i, quads 2..7 drawn,
brightness 255 - 255 i / 8; from frame 20 it fades (x 220 / 256 per joint, heads darken by 1/8 per frame); gone after 30.
Sound: `0x355 + rand(6)` (bank samples 3,4,5,3,4,5) and `0x35b + rand(6)` (6,6,7,7,8,8).
Scene start (`FUN_800b96f4` first call) plays one crowd cue by the winner's character: 1, 2 -> 0x352 (sample 0); 5, 7 -> 0x353 (1); 3, 4, 6, 8 -> 0x354 (2). The samples carry VAG loop points (1.665 / 2.214 / 1.294 s) and nothing keys them off, so the crowd loops until the level ends. Every podium cue keys at volume 0x1000 and all bank 0181 tones are at volume 127, the same as the announcer's 0278 tones: the port plays them at the shared full level (`VOICE_VOL`).

## Score strip (`FUN_800b9b0c`)
HUD object 6 at x 40, y 540 (off screen): four faces in seat order with two-digit points (tournament points 0x8005a6b3..b6),
a trophy icon in the middle (HUD pack 0732 part0, the silver cup). Measured on `real_l0_300` (640x480 = 1.25 x 2 per native
pixel): additive frame (132,130,0) over lines 186-189 / 221-222 and columns 29-31 / 480-482 (it adds onto the scene: (0x63,0,0x94)
-> (0xE6,0x82,0x94)); faces 64x40 at x 35 / 121 / 305 / 391, line 187; digits (yellow (255,194,0) -> orange (255,138,0), black
outline) at x 81 / 171 / 350 / 440, lines 211-217; trophy centred at x 256, lines 185-207. Port: `PodiumScene.stripHud()` (HUD
sprites, frame on an additive layer) + the cup kept in front of the camera; phases 3-5 as the camera function runs them (up 5 a
frame for 240 frames from the phase start, a tap / key jumps to phase 4 like cross); the party's buttons come in at phase 100, where the game leaves.

## Port notes
- Scale 3 / 1024: the 744-758 models then stand as tall as the catalog heights.
- The party reveals places one at a time, which the game does not: pedestal and character pop in on `reveal()`, and the
  game's ending (path 2, trophy, fireworks, crowd, WIN / LOSE scripts) starts on `celebrate()`. Until then the camera runs
  phases 0-1 and holds. `playReal()` + `advance(n)` run the scene on the game's own clock (used for the comparison shots).
- Ties: equal points and trophies share a place (same key in `setup()`), so the eight layouts all occur.
- Start fade from black (the engine's generic level fade, not in the overlay), measured on the emulator at 4x slow motion:
  black, then 19 / 37 / 58 / 74 / 93 / 100 % brightness, one step per 30 Hz frame (the LOADING screen fades in the same
  way). Ported as a black cover over the 3D canvas (`PodiumScene.fade`). Firework sound pitch: ids 0x355-0x360 are keyed at note 60 (pitch arg 0x1e00 >> 7); SPU rate = 44100 * 2^((60 - centre + fine/128) / 12) (fine tune raises pitch: the crackle tones then land exactly on their VAGs' own rates 13011 / 12493). Bangs: three samples at 1 and 0.927; crackles 1 / 0.96 / 1 / 0.919 / 1 / 0.956. Checked on a 25 s emulator recording of the podium (OpenAL gain node -> MediaRecorder): matched filtering finds the bang samples at x1.00 and x0.93 and nowhere else (`bangRate` / `crackleRate`). The strip shows the party points (two digits).
  Big Stein uses podium model 9012 with a victory salute, a losing shrug and a breathing idle, keyed to the frame ranges of Cortex’s podium scripts.
- Name plates at the feet are ours. The winner line moved under the podium; the confetti is gone (the fireworks are real).
- (Resolved 2026-11-23: bodies, faces and engine ids were right and the two display names were swapped; engine 8 = Rilla Roo, the ape in striped trunks, face tex022 - the announcer's name call says so, see docs/audio.md. The ids `koala` / `rilla` stay as asset keys with the other's name.) Original note: catalog ids `koala` and `rilla` carry each other's body: the game shows engine 8 (base 978, podium 744, strip face 0731
  tex022) as the ape in striped shorts = Rilla Roo, and engine 6 (976 / 748) as the grey koala in red = Koala Kong. Our
  `koala` has Koala Kong's name and face (tex008) on the ape's model and engine id 8; `rilla` the reverse. The podium matches
  on the catalog entry's base model (`chars[n].base`), so it shows the same body as the rest of the app and follows a fix.
