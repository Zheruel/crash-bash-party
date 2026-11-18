# Arena / level data in CRASHBSH.DAT

All findings come from the user's own disc (`SCUS_945.70`, `0991.code.bin`, `dat/*.bin`).
Reproduce with `tools/build_arenas.py` (-> `assets/arenas.json`) and `tools/unpack.py`.
Confidence: **H** verified (cross-checked), **M** strong inference, **L** guess.

## 1. Key correction: t0c / t10 / t14 are SOUND, not level data  (H)

| type | header (u32) | body |
|---|---|---|
| t0c | `0x0c, vab_off, end` | SPU-ADPCM, VAB, (no SEQ) |
| t10 | `0x10, vab_off, seq1, seq2` | SPU-ADPCM, VAB, 2x SEQ |
| t14 | `0x14, vab_off, seq1, seq2, seq3` | SPU-ADPCM, VAB, 3x SEQ |

* ADPCM body starts right after the u32 table (first 16-byte block is silence). Sample sizes from the
  VAB size table sum **exactly** to the ADPCM length in all 160 parsed files (strong check).
* VAB = Sony `pBAV` v7: 32 B header, 128 program attrs, 16 tones/program, then u16 sizes (x8 bytes).
  In t0c the size table is truncated to `vs+1` entries.
* SEQ = Sony `pQES` (all 55 sections have the magic).
* The "packed nibbles" are plain SPU ADPCM (filters 0-4, 28 samples per 16 B block). No LZ/RLE exists.
* The same type ids (0x07..0x12) are also used by 12 text files (0141-0152, plus 0143/0147 which
  collide with t10/t0c): `u32 type` + NUL-separated strings (objective/controls text). Not sound.
* Counts: 132 t0c banks (voices / per-arena SFX), 27 t10 + 1 t14 = 28 music tracks (the "28 arenas" hint).
* `tools/unpack.py split FILE OUT --wav` writes vab.bin, vagNN.vag/.wav, seqN.seq, info.json (tone->VAG,
  ADSR, center note). Sample rate is not stored per VAG (tone center/fine tune; default 22050 used).

## 2. Archive organisation  (H)

File-table at exe 0x8004e110 (992 x {sector,size}). **A second table at exe 0x80050010 holds 130
file *groups*** `{first_file, count, bytes}` -- the unit loaded from CD in one read (loader at exe
0x80012678/0x80012ac4 takes a group pointer). Full list in `arenas.json:groups`. Summary:

| group | files | content |
|---|---|---|
| 0 | 0-135 | global t08/t29 pairs (68) |
| 1 | 136-140 | 5 TGA |
| 2 | 141-152 | the 12 text files |
| 3 | 153-278 | 126 t0c banks (UI/voices/per-arena SFX) |
| 4 | 279-303 | 24 t10 + 1 t14 music |
| 5-18 | 304-445 | 14 arena groups of t08/t29 pairs (2-8 pairs each) |
| 19 | 446-487 | **Polar Push family** (all 5 levels): 16 pairs + 6 t0c + 3 t10 + t62 anim table |
| 20-28 | 488-605 | 9 arena groups |
| 29 | 606-715 | warp rooms / hub (55 pairs + the only t26) |
| 30 | 716-728 | 13 character animation tables (t5d-t6a) |
| 31 | 729-736 | 4 pairs; 32 | 737-798 | 31 pairs (composite of shared pieces) |
| 33-128 | 799-990 | 48 single-pair groups (models w/ per-pair records at ovl 0x8009fa14) |
| 129 | 991 | code overlay (maps at 0x80078c90, 0x5e4b8 bytes) |

Many t08/t29 files are byte-identical copies repeated in every arena group (shared props duplicated
so each group is a contiguous read; 57 duplicate sets). Group 32 duplicates the first pair of most
arena groups.

## 3. Level table  (H)

* Names: u32[45] at 0x8004dcbc -> strings (id 0 JUNGLE BASH ... 32 TIE-BREAKER, 33-37 warp rooms,
  38/39 DEMO HUB, 40 TITLES, 43 PODIUM, 44 SCRIPT STUFF).
* Level table 0x8004ddd0, 6 bytes/level: `{family 0x1xx, arena_variant, alt_variant}`.
  Families: 0x104 Crate Crush (ids 0-3, 32), 0x105 Papu Pummel, 0x106 Tank Wars (5-9),
  0x107 Pogo Painter (10-13), 0x108 Ballistix (14-17), 0x109 Polar Push (18-22), 0x10a Crash Dash
  (23-26), 0x103 Ring Ding, 0x10b Dragon Drop, 0x10e Mallet Mash, 0x10d Keg Kaboom, 0x10c Oxide Ride,
  0x102 warp/podium, 0x101 titles. `alt_variant` is used instead of `arena_variant` when flag 0x80 of
  0x8005a646 is set (exe 0x80023714) -- meaning unknown.
* Family record array (overlay 0x80098fa8.., 24 B): `{family, u16, u16, u16, u32, ptr, ptr, init_fn}`;
  init_fn lives in the overlay (family-specific code, 0x800b..0x800d). (M)
* Level -> text file by content (H): 0x104->0151, 0x105->0146, 0x106->0141, 0x107->0145, 0x108->0152,
  0x109->0144, 0x10a->0143, 0x103->0148, 0x10b->0142, 0x10e->0150, 0x10d->0149, 0x10c->0147.
* Level -> character animation table (M-H): array at ovl 0x8009f8e4 indexed by family-1:
  0x104->0728(t5d) ... 0x109->0487(t62, inside group 19) ... see arenas.json.

## 4. Sound per level  (M-H)

20-byte records at exe 0x80058b88 indexed by level id: `{ptr t10 music, 2, ptr t0c sfx, ptr t0c sfx, vol?}`
(consumer: exe 0x80022150). Warp rooms all use t14 0294 + 0272; TITLES uses 0303/0273; PODIUM 0288/0181.
Tie-Breaker reuses SPACE BASH's SFX bank (166). Records 45+ are 8-entry character-voice bank sets.

## 5. Geometry / spawn data  (what is where)

* Arena meshes and textures are t29/t08 pairs. A runtime *model slot* table (exe 0x80052a54,
  0x38 B/slot, `+0 -> t29 entry, +4 -> t08 entry`, 282 static slots) names the pairs; exported in
  `arenas.json:model_slots`. (H)
* Spawn/path/bounds data is NOT in the DAT: it is static data in the code overlay (0991). A per-level
  pointer table sits at ovl 0x800a001c (45 entries; levels 0-3 / 5-9 / 10-13 point at s16 coordinate
  arrays in 0x800b-0x800d, 33-39 share one block). Contents look like s16 (x,z) point lists; the
  consumer was not identified. (L)

## 6. Unknown / next steps

* **Level -> model groups** is only partly resolved. No table mapping level id to group 5-32 was found
  (group pointers appear only for groups 33-128, in overlay records `{group, slot, t29 entry, t08 entry}`
  at 0x8009fa14). Best inference: levels 18-22 -> group 19 (M); levels 23-31 -> groups 20-28 in order,
  Dash arenas pair up by shared files (20/21, 22/23) (M-L); levels 0-17 -> groups 5-18 (14 groups for 18
  levels, some must be shared) unresolved. Next step: emulate/trace the overlay init_fn per family
  (ptr at record +0x14) or break on the CD loader to log group ids per level.
* Meaning of the per-level s16 blocks (spawns? crate positions? paths?) and of `alt_variant`.
* t26 (0611) and group 31/32 purpose; sample rates for VAGs.
