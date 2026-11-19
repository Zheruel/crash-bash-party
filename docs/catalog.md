# Asset catalog (`assets/catalog.json`)

Everything below was identified by rendering the decoded models (contact sheets in `docs/catalog/`).
Confidence: **H** seen and unambiguous, **M** likely, **L** guess. Fix mistakes in `assets/catalog.json`
(and this table). World units: characters stand on y=0, face +z at yaw 0; arenas are scaled to about 22 wide
and centred on the floor (floor y=0).

Sheets: `characters.png` (base / pogo / polar bear / tank rows), `animations.png` (clip per role),
`arenas.png`, `props.png`, `warp_arenas.png` (all 54 warp/hub models), `verify_arenas.png` (loaded through `crash.ts`).

## Characters (model N pairs with texture set N-1; use mesh `part0` only, `part1` is a duplicate shadow/LOD mesh)

| id | base model | pogo | polar bear | tank (driver bust) | T-pose | conf |
|---|---|---|---|---|---|---|
| crash | 990 | 974 | 958 | 894 | 758 | H |
| coco | 988 | 972 | 956 | 892 | 756 | H |
| tiny | 982 | 966 | 952 | 888 | 750 | H |
| dingodile | 980 | 962 | 950 | 884 | 746 | H |
| cortex | 986 | 970 | 954 | 890 | 754 | H |
| brio | 984 | 968 | 948 | 886 | 752 | H |
| koala | 978 | 960 | 944 | 880 | 744 | H |
| rilla | 976 | 964 | 946 | 882 | 748 | H |

Model slots 1-8 in `arenas.json:model_slots` are exactly the base models (990, 988, 986, 984, 982, 976, 980, 978);
slots 9-22 are pogo/polar variants. Other per-minigame sets exist (not catalogued, same 8 characters):
928-942 (5 clips, riding a bear/other, `part1` present), 818-846 and 848-878 (5-7 clips, per-minigame "bust" poses),
896-910 (6 clips, driver busts of the other tank sets). All 8 base models have 13-14 clips (976-990).

Variants live in `characters[].variants` (`pogo`, `polarBear`, `tank`). `tank` is only the driver; place it with
`props.tank` (model 774 teal hover tank body, same scale 2.6 and same origin).

### Clip roles (derived from motion analysis of every clip plus frame strips; frames @30 fps)

| id | idle | run | jump | hit | lose | win |
|---|---|---|---|---|---|---|
| crash 990 | 0 | 1 | 9 | 3 | 8 | 12 |
| coco 988 | 0 | 2 | 5 | 1 | 11 | 12 |
| tiny 982 | 0 | 2 | 3 | 1 | 12 | 13 |
| dingodile 980 | 0 | 1 | 4 | 3 | 9 | 13 |
| cortex 986 | 1 | 2 | 3 | 0 | 11 | 12 |
| brio 984 | 0 | 1 | 3 | 2 | 8 | 13 |
| koala 978 | 0 | 1 | 4 | 3 | 5 | 13 |
| rilla 976 | 1 | 0 | 2 | 3 | 4 | 13 |

Confidence: idle H, run H (M for cortex/brio), win M (clip 12/13 are the long celebration, last clip), hit M, lose M, jump M
(rilla jump L). Other clips seen: second idle/fidget (e.g. crash 5, 10, 11), tantrum/spin attack, fall/get-up.
Pogo variant anims: `idle`/`hop` = hop cycle, `jump` = big jump. Polar variant: `idle`, `push`. Tank: `idle`.

Heights (`height`): crash 1.5, coco 1.6, cortex 1.5, brio 1.7, dingodile/rilla 1.8, tiny/koala 1.9 (relative game sizes, not all equal).

## Arenas (`arenas[gameId]` = first variant; `arenas["gameId:variant"]` for each level)

Level-to-model mapping is not in the disc tables (arenas.json: "unresolved"), so these come from visual identification
plus level order within each family. Tank/Pogo/Crate/Ballistix levels share groups 5-18 (arena models 661-715), so variant
assignment inside a family is **L** unless noted.

| game id | variant | model | notes | conf |
|---|---|---|---|---|
| ballDefence | crashball | 691 | jungle huts, log fence, centre pedestal | M |
| | beachBall | 681 | village + sky backdrop | L |
| | nballism | 703 | blue tech arena | L |
| | skyBalls | 685 | grey sky platform, renders mostly dark | L |
| pushOff | tiltPanic | 466 | ice rink, ice backdrop (group 19, Polar Push) | H |
| | polarPanic | 460 | ice rink with walls | M |
| | meltPanic | 458 | ice cave, water pool | M |
| | manicPanic | 478 | dark ice with pink pole | L |
| tilePainter | pogoPainter | 679 | domed metal 4x4 tile grid | M |
| | pogoAGogo | 683 | desert tile blocks | L |
| | elPogoLoco | 693 | desert variant (same mesh, different texture) | L |
| | pogoPadlock | 689 | dark industrial tile grid | L |
| tankArena | metalFox | 663 | brick room with green tank and crates | M |
| | swampFox | 661 | | L |
| | desertFox | 671 | desert shack + sky | M |
| | jungleFox | 675 | mossy ruin square | M |
| crateToss | snowBash | 707 | snow, house, trees | H |
| | jungleBash | 713 | jungle cliffs | M |
| | spaceBash | 701 | tech floor, tall wall | L |
| | drainBash | 709 | sewer/ice pit | L |
| dashRace | dotDash | 647 | huge green field (scaled 0.4) | L |
| | toxicDash | 653 | stone course | L |
| | splashDash | 655 | rocky course with fruit piles | L |
| | dantesDash | 645 | dark rock field (scaled 0.4) | L |
| board | | 617 | round stone warp room, green arena (rotunda) | M |

Sky/backdrop is baked into each arena model (curved sky strips), so `extra` is empty. Alternative arenas seen
(not catalogued): 697 lava pit, 711 totem tower, 665/667 desert/Papu-style tank sets, 677/687 dark boss-like rooms, 685, 715, 649/657 (four-pad tower, Ring Ding),
472/476/486/456 (extra Polar Push meshes), 669 (white dome), 699/377/113/119/123 (purple skybox spheres).

Warp rooms / hub (group 29, models 607-715 odd): 607 (storm tower), 609 (desert), 613 (purple dungeon), 615 (snow castle),
617 (stone rotunda, used as `board`), 621 (green hill), 623 (stone ring), 629 (teal cave), 631 (canyon),
633 (volcano), 635 (green slime), 637, 641. Title screen: 379-393 (logo + level collage, 379 = CRASH BASH logo).
Podium (level 43, H): level model 379 = podium disc `extra_df8c` + machine `extra_eb1c`, sky `part6` / `part7`, pedestals `part11` / `part10` / `part8`,
trophy `part9`; fireworks from pack 377; characters 744-758. See `assets/stages/podium.json`, `re/notes/podium.md`. `props.podium` = 135 and `props.logo` = 133 are not part of it.

## Props (`props[...]`)

| key | model | what | conf |
|---|---|---|---|
| crate | 796 (=355) | purple "?" crate on base | M |
| crateStar | 333 | crate with yellow star burst | L |
| padlockCrate | 521 (=770) | padlock crate | M |
| ball | 307 | dark faceted ball/gem (candidate Ballistix ball) | L |
| crystal | 345 (=619) | white crystal, black fuzz backdrop | M |
| gem | 794 (=353) | red/blue/white gem-like pickup | L |
| tank | 774 (=537) | teal hover-tank body | M |
| tankAlt | 489 | metal turret/tank body | L |
| polarBear | 464 | polar bear | M |
| akuAku | 399 | Aku Aku mask in magenta burst | M |
| bonusStar | 405 | star in green wreath (bonus icon) | L |
| penguin | 581 | wrapped penguin | L |
| papuPapu | 567 | Papu Papu | M |
| weight | 309 | 50 lbs weight | H |
| podium | 135 | pedestal disc | L |
| logo | 133 | CRASH BASH logo | H |

Not found: TNT crate, Nitro crate, wumpa fruit, trophy, relic (the disc models for those may live in
unrendered groups; 311/730 "LOADING" vortex and 313 "FAIL" text are also available).
Also seen: 317 (Pinstripe-like gunner on pad), 319 (ship on pad), 417/462 (grey wolf-like boss in ball), 519/768 (blue top-hat roo/ripper), 468 walrus, 470 (hazard drum), 551/784 (propeller pilot), 565/788 (orange-striped boss), 744-758 T-pose characters (clips 3-4).

Duplicate models (identical bytes) exist in many groups: 307=323=495=509..., 309=325=335..., 355=401=569=583=595=796, etc.

## Caveats

- Animations are vertex morphs (no bones). Frame rate assumed 30 fps.
- Animated bounds change per clip; `offset.y` places the idle pose's lowest vertex at y=0.
