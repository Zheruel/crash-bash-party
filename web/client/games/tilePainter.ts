// POGO PANDEMONIUM view (shared/games/tilePainter.ts): the real stages 675 / 671 / 667 / 663 with an 8x8 painted floor.
import * as THREE from 'three';
import { BEAM_FRAMES, createPogoResult, enterPogoResult, finishPogoHop, pogoResultPickup, pogoResultWindowTicks, pogoWinnerLand, pogoWinnerTailTicks, PADLOCK_INTRO_TICKS, POGO_TRAIL_FRAMES, tickPogoResultObjects, tickPogoTiles, TP_TILE, tileWorld, type PogoProjectileTrail } from '../../shared/games/tilePainter';
import type { World } from '../../shared/types';
import { createCharacter, usedVariant } from '../characters';
import { ASSET_BASE, getCatalog, ModelInstance } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, hitVoice, winnerVoice } from '../shell/voice';
import { FX_PACKS } from './fxScripts';
import type { ActorParts } from './kit';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
import { POGO_HOP } from './playerPoseData';
import { poseTicks } from './playerPose';
import { arenaClockSprites, scoreHud } from '../ui/ps1hud';
import { CHARACTERS } from '../../shared/look';
import type { ClientMiniGame } from './types';
import { PogoBoard, POGO_RIM_PARTS } from './pogoBoard';
import { PartBatch, preloadFx } from './realFx';

/**
 * Real effects (re/notes/pogoPainter.md "Effects"): object pack 0770's effect scripts (0 explosion, 1 pickup puff, 2 loser
 * smoke, 3 crate break, 4 touchdown dust, 7 cast spark, 8 beam end), its beam segment frames (parts 2-9), the HUD digits (0732) for the
 * cash-in score and El Pogo Loco's own mine blast (level model 0667 script 1).
 */
/** El Pogo Loco's monster (object 0x1406): pack db 0x80053bd4 = disc 0768 (render id 0x2001, three clips: 0 spin 21 f,
 *  1 wait 26 f, 2 hop 14 f = the hop cycle of FUN_800c0cf4) */
const MONSTER = 768;
const PACK = 770, DIGITS = 732, LOCO = 667, K = TP_TILE * 2, U = K / 1024;
const YAW_UNIT = 2 * Math.PI / 4096;
const WIN_SCRIPT = 0x32, RESULT_HOP_SCRIPT = 0x2e;
const TIME_UP_SOUND = 'sfx/0277/5.mp3', DRAW_SOUND = 'sfx/0278/13.mp3';

interface PogoResult {
  world: World;
  at: number;
  entered: number[];
  lastFrame: number;
}

// VM cues from L10.ram's script 0x32. Frames are relative to the first rendered pose.
const CHEER_SOUND_FRAME = [11, 0, 0, 0, 0, 0, 0, 2];
const CHEER_EVENTS: ReadonlyArray<Record<number, number>> = [
  { 4: 0x12, 27: 0x12, 31: 0x14 },
  { 23: 0x12, 26: 0x14, 39: 0x12, 43: 0x14, 56: 0x12, 60: 0x14 },
  {},
  {},
  { 19: 0x12 }, // the event at the beginning of Tiny's script is ignored on entry and handled on each loop
  { 19: 0x14, 20: 0x12, 38: 0x14, 39: 0x12, 56: 0x14, 57: 0x12 },
  { 1: 0x12, 3: 0x11, 19: 0x12, 23: 0x11, 33: 0x12 },
  { 1: 0x12, 4: 0x11, 19: 0x12, 21: 0x11 },
];

// Disc pack 0770 script 6 reuses script 4's keys with different meshes. FUN_800b72b0 blends
// the dust and leaves render id 0x2022 (part 33) in its own material mode.
const DUST_FLASH = -6;
const pogoFx = FX_PACKS[PACK].scripts;
pogoFx[6] = { dur: 11, tracks: pogoFx[4].tracks.map((t, i) => ({ ...t, part: i % 2 === 0 ? 23 : 25 })) };
pogoFx[DUST_FLASH] = { dur: 11, tracks: [{ part: 33, end: 11, keys: [
  [0, 1, -71, -3, 0, 0, 0, 4096, 4096, 4096, 921],
  [2, 0, -76, -6, 0, 0, 0, 7051, 7051, 7051, 4096],
  [4, 0, -74, -6, 0, 0, 0, 10007, 10007, 10007, 4096],
  [11, -1, -74, -1, 0, 0, 0, 13623, 13623, 13623, 0],
] }] };

/** Player colours are the pad colours of the corners (yellow BL, red TL, blue TR, green BR), not the character colours. */
const PAD = ['#d8c81c', '#d02020', '#2438d0', '#1ea81e'];
/** item ids from the sim (c5360): 1 missile, 2 four-way, 3 electro, 4 steal gun, 5 speed, 6 shield */
/** pack 0770 part per item id, as the item lies on its tile (FUN_800ba25c) and rides the player's held-item node
 *  (FUN_800b935c): 1 missile 0x200d, 2 four-way 0x201b, 3 beam 0x2002, 4 steal gun 0x2040, 5 speed shoes 0x200c, 6 shield 0x2042 */
const ITEM_PART = [-1, 12, 26, 1, 63, 11, 65];

/** Per level: stage key, texture folder, fixed camera fitted to the real gameplay frames (model units -> x3.6 world). */
interface Level { level: number; arena: string; bg: number; pos: [number, number, number]; pitch: number; fov: number; sfx: string }
const S = 3.6;
const LEVELS: Record<string, Level> = {
  pogo: { level: 10, arena: 'tilePainter:pogoPainter', bg: 0x1c2a16, pos: [0, 2.98 * S, 6.244 * S], pitch: 24.41, fov: 36.3, sfx: '0171' },
  agogo: { level: 11, arena: 'tilePainter:pogoAGogo', bg: 0x9ac4e8, pos: [0, 3.15 * S, 5.85 * S], pitch: 27.06, fov: 37.2, sfx: '0170' },
  elpogoloco: { level: 12, arena: 'tilePainter:elPogoLoco', bg: 0xb8806a, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0169' },
  padlock: { level: 13, arena: 'tilePainter:pogoPadlock', bg: 0x4a4a52, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0168' },
};

const placements = new Map<number, Placements | null>();
/** The board's 64 tile objects: a run of 64 sub-meshes 0x7c apart (the view draws its own paintable tiles). */
function boardTiles(pl: Placements | null): string[] {
  if (!pl) return [];
  const offs = [...new Set(pl.objects.map((o) => o.part).filter(Boolean))].map((p) => parseInt(p.slice(6), 16)).sort((a, b) => a - b);
  for (let i = 0; i + 64 <= offs.length; i++) if (offs[i + 63] - offs[i] === 63 * 0x7c) return offs.slice(i, i + 64).map((o) => 'extra_' + o.toString(16));
  return [];
}
const pad3 = (n: number) => String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, '0');
/**
 * Original sound id (FUN_80022660 arg) -> sample index n in the level's sfx bank (VAB tone -> vag - 1; see re/notes/pogoPainter.md).
 * 0x55a..0x56d (foreign-tile steps, landings, cheers) are a contiguous run starting at RUN[bank].
 */
const RUN: Record<string, number> = { '0171': 13, '0170': 14, '0169': 21, '0168': 24 };
const SND: Record<string, Record<number, number>> = {
  '0171': { 0x514: 2, 0x515: 3, 0x51d: 5, 0x51e: 7, 0x51f: 8, 0x520: 9, 0x521: 10, 0x522: 11, 0x438: 6, 0x43c: 12, 0x41c: 34, 0x41f: 36, 0x3fa: 35, 0x529: 1, 0x1c2: 33 },
  '0170': { 0x514: 3, 0x515: 4, 0x51d: 6, 0x51e: 8, 0x51f: 9, 0x520: 10, 0x521: 11, 0x522: 12, 0x438: 7, 0x43c: 13, 0x41c: 35, 0x41f: 37, 0x3fa: 36, 0x532: 0, 0x533: 1, 0x534: 2, 0x1c2: 34 },
  '0169': { 0x514: 10, 0x515: 11, 0x51d: 13, 0x51e: 15, 0x51f: 16, 0x520: 17, 0x521: 18, 0x522: 19, 0x438: 14, 0x43c: 20, 0x41c: 42, 0x41f: 44, 0x3fa: 43, 0x3ec: 5, 0x3ed: 6, 0x3ee: 5, 0x3ef: 6, 0x3f0: 7, 0x3f1: 8, 0x3f2: 9, 0x3f3: 8, 0x3f4: 9, 0x53c: 0, 0x53d: 1, 0x53e: 2, 0x53f: 0, 0x540: 1, 0x541: 2, 0x542: 3, 0x543: 4, 0x1c2: 41 },
  '0168': { 0x514: 13, 0x515: 14, 0x51d: 16, 0x51e: 18, 0x51f: 19, 0x520: 20, 0x521: 21, 0x522: 22, 0x438: 17, 0x43c: 23, 0x41c: 45, 0x41f: 47, 0x3fa: 46, 0x54b: 5, 0x54c: 6, 0x54d: 7, 0x54e: 8, 0x54f: 9, 0x550: 10, 0x551: 11, 0x552: 12, 0x1c2: 44 },
};

function makePogo(hex: string): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: 0.5, roughness: 0.35 });
  const team = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.5 });
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.1, 16), team);
  foot.position.y = 0.05;
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.035, 6, 14).rotateX(Math.PI / 2), steel);
    c.position.y = 0.12 + i * 0.07;
    g.add(c);
  }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), steel);
  post.position.y = 0.45;
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.09, 14), team);
  pad.position.y = 0.55;
  g.add(foot, post, pad);
  return g;
}

const hash = (i: number) => { let x = Math.imul(i + 1, 2654435761) >>> 0; x ^= x >>> 15; return (x >>> 0) / 4294967296; };

export function createTilePainterView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'pogo';
  let lv: Level = LEVELS.pogo;
  const boardTexture = new THREE.Texture();
  const boardReady = new THREE.ImageLoader().loadAsync(ASSET_BASE + 'textures/pogo-board.png').then(image => {
    boardTexture.image = image;
    boardTexture.needsUpdate = true;
  });
  let board: PogoBoard | null = null;
  const pogoSprings = new Map<number, THREE.Object3D>();
  const objs = new Map<number, { obj: THREE.Object3D; yaw?: number; lock?: THREE.Object3D; mon?: ModelInstance; shadow?: THREE.Object3D }>();
  /** held item per slot: the pack part on the player's held-item node */
  const icons = new Map<number, { item: number; obj: THREE.Object3D | null }>();
  /** one pack 0770 part at the stage scale (render id 0x2000 + part + 1) */
  const packPart = (part: number): THREE.Object3D => catalogInstance({ model: PACK, scale: K, parts: [`part${part}`] })?.root ?? new THREE.Group();
  let beams: PartBatch[] = [];
  let missileTrail: PartBatch;
  const trailFacing = new THREE.Euler(0, 0, 0, 'YXZ');
  let lastImpact = 0;
  let result: PogoResult | null = null;
  let catchingUp = false;
  const mkBeams = () => { for (const b of beams) b.dispose(); beams = Array.from({ length: 8 }, (_, i) => new PartBatch(kit.root, PACK, 2 + i, K, 28, true)); };
  function mkMissileTrail() {
    missileTrail?.dispose();
    // Render id 0x2018. Keep the disc's ABR 2 subtractive material and texture palette.
    missileTrail = new PartBatch(kit.root, PACK, 23, K, 128);
  }

  function drawMissileTrail(w: World, camera: THREE.Camera) {
    trailFacing.setFromQuaternion(camera.quaternion);
    missileTrail.begin();
    const trail: PogoProjectileTrail[] = w.data.projTrail ?? [];
    for (const { x, y, z, tick } of trail) {
      const size = 1 - (w.tick - tick) / POGO_TRAIL_FRAMES;
      missileTrail.add(x, y, z, trailFacing.y, trailFacing.x, size);
    }
    missileTrail.end();
  }
  let arena: THREE.Group | null = null;
  // samples are shared between banks on disc, so the file comes from audio/index.json
  let bankIdx: Record<string, { file?: string | null }[]> | null = null;
  const bankReady = fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    bankIdx = {};
    for (const [k, v] of Object.entries<{ samples: { file?: string | null }[] }>(j?.sfx?.banks ?? {})) bankIdx[k] = v.samples;
  }).catch(() => { /* silent */ });
  function playId(id: number, vol = 0.55) {
    if (catchingUp) return;
    let n = SND[lv.sfx]?.[id];
    if (n === undefined && id >= 0x55a && id <= 0x56d) n = RUN[lv.sfx] + (id - 0x55a);
    if (n === undefined) return;
    const f = bankIdx?.[lv.sfx]?.[n]?.file;
    if (f) sfx.playFile(f, vol, kit.over.done, sfxRate(lv.sfx, id));
  }

  function playProjectileImpacts(w: World) {
    // Use the displayed snapshot so an impact lines up with the interpolated head's removal.
    for (const e of w.ev) {
      if (e.k !== 'pogoProjectileEnd' || e.id <= lastImpact) continue;
      lastImpact = e.id;
      kit.real.play(PACK, 0, e.x, e.v, e.z);
      playId(0x521);
    }
  }

  function playDust(script: number, x: number, z: number, random = Math.random()) {
    const yaw = Math.floor(random * 360) * Math.PI / 180;
    kit.real.play(PACK, script, x, 0, z, { yaw, add: true });
    if (script === 6) kit.real.play(PACK, DUST_FLASH, x, 0, z, { yaw });
  }

  function tickResult(state: PogoResult, frame: number) {
    const { world: w, entered } = state;
    w.tick++;
    const draw = kit.over.winners.size === 0;
    // FUN_80082d90: 0x1af plays once the draw logo reaches its size threshold.
    if (draw && frame === 23 && !catchingUp) sfx.playFile(DRAW_SOUND, 0.9, true, sfxRate('0278', 0x1af));
    tickPogoTiles(w);
    for (const p of w.bodies) {
      if (p.kind !== 'player') continue;
      const slot = p.slot, win = kit.over.winners.has(slot), lose = !draw && !win;
      pogoResultPickup(w, p, entered[slot] >= 0);
      if (entered[slot] < 0) {
        if (finishPogoHop(w, p)) continue;
        enterPogoResult(w, p, lose);
        entered[slot] = frame;
        if (win) state.lastFrame = frame + pogoWinnerTailTicks(kit.look(slot).char);
        if (lose) kit.real.play(PACK, 0, p.x, 0, p.z);
      }
      const age = frame - entered[slot];
      if (age > 0) {
        let yaw = Math.round(-p.face / YAW_UNIT) & 0xfff;
        if (lose) yaw += 0xe3; // FUN_800b6ae0
        else {
          if (win) { // FUN_8008a200: signed quarter-turn correction before the Pogo handler's unsigned correction
            const diff = -yaw & 0xfff;
            yaw = (yaw + ((diff > 0x800 ? diff - 0x1000 : diff) >> 2)) & 0xfff;
          }
          yaw += Math.min(yaw, 0x1000 - yaw) >> 3; // FUN_80015480(0, yaw) is unsigned
        }
        p.face = -(yaw & 0xfff) * YAW_UNIT;
        if (lose && ((w.tick + slot) & 3) === 0) kit.real.play(PACK, 2, p.x, p.y, p.z);
      }
      // FUN_800b6960 sets a constant upward speed. Physics runs after the result handler,
      // so the first rise is on entry and each smoke puff uses the preceding height.
      if (lose) p.y += 0x30 * U;
      if (win) {
        const family = w.data.fam[slot];
        const period = poseTicks(WIN_SCRIPT, family);
        if (period && age % period === CHEER_SOUND_FRAME[family - 1]) playId(0x566 + family - 1);
        const event = age > 0 && period ? CHEER_EVENTS[family - 1][1 + (age - 1) % period] : undefined;
        if (event === 0x12) pogoWinnerLand(w, slot);
        if (event === 0x11 || event === 0x14) playDust(event === 0x11 ? 6 : 4, p.x, p.z, hash(w.tick * 4 + slot));
        if (!catchingUp) winnerVoice('tilePainter', kit.look(slot).char, age - 1, age);
        else if (age === 0) sfx.enterRoundResult('winner');
      }
    }
    tickPogoResultObjects(w);
  }

  function build() {
    const R = kit.root;
    const ref = getCatalog().arenas[lv.arena];
    // the level as the real game builds it (RAM object list); the 64 board tiles are ours (paintable)
    const pl = placements.get(lv.level) ?? null;
    const tileParts = boardTiles(pl);
    const skip = variant === 'agogo' ? [...tileParts, ...POGO_RIM_PARTS] : tileParts;
    const lvl = ref ? levelStage(ref, pl, r => catalogInstance(r)?.root ?? null, { skip }) : null;
    if (lvl) { arena = lvl; R.add(lvl); }
    else {
      const inst = catalogInstance(variant === 'agogo' && ref ? { ...ref, parts: ref.parts?.filter(p => p !== 'extra_1d044') } : ref);
      if (inst) {
        arena = new THREE.Group(); arena.add(inst.root);
        for (const ex of (ref as { extra?: (typeof ref)[] } | undefined)?.extra ?? []) { const m = catalogInstance(ex); if (m) arena.add(m.root); }
        R.add(arena);
      }
    }
    const tiles = pl?.objects.filter(o => tileParts.includes(o.part)).sort((a, b) => parseInt(a.part.slice(6), 16) - parseInt(b.part.slice(6), 16)) ?? [];
    board?.dispose();
    board = new PogoBoard(lv.level, pl?.model ?? ref?.model, tiles, boardTexture);
    R.add(board.root);
  }

  function makeParts(slot: number): ActorParts {
    const inst = createCharacter(kit.look(slot), { variant: 'pogo', ring: false });
    if (usedVariant(inst)) {
      // the game draws the pogo model in raw units like the stage (K per 1024 u): actor scale = K / the variant's catalog scale
      const sc = K / ((getCatalog().characters as { id: string; variants?: Record<string, { scale?: number }> }[]).find((c) => c.id === CHARACTERS[kit.look(slot).char % CHARACTERS.length].id)?.variants?.pogo?.scale ?? K);
      return { inst, headY: 2.1, shadow: 0.7 * 1.8 / sc, scale: sc };
    }
    const pogo = makePogo(PAD[slot]);
    inst.root.position.y = 0.55;
    pogoSprings.set(slot, pogo);
    return { inst, extra: pogo, headY: 2.15, shadow: 0.8 };
  }

  function heldItem(slot: number, item: number): THREE.Object3D | null {
    let h = icons.get(slot);
    if (h && h.item !== item) { if (h.obj) { kit.root.remove(h.obj); disposeTree(h.obj); } h = undefined; }
    if (!h) { const obj = item > 0 && ITEM_PART[item] >= 0 ? packPart(ITEM_PART[item]) : null; if (obj) kit.root.add(obj); h = { item, obj }; icons.set(slot, h); }
    return h.obj;
  }

  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0]) {
    const c = ctx.camera;
    const real = LEVEL_CAMS[lv.level], ref = getCatalog().arenas[lv.arena];
    if (real && ref) { applyPose(c, ps1Pose(real, ref)); return; } // the real camera
    c.position.set(...lv.pos);
    c.rotation.set(-(lv.pitch * Math.PI) / 180, 0, 0, 'YXZ');
    // the real game is 4:3; on narrower screens keep the same horizontal view
    const a = c.aspect || 4 / 3;
    let f = lv.fov;
    if (a < 4 / 3) f = (2 * Math.atan((Math.tan((lv.fov * Math.PI) / 360) * (4 / 3)) / a) * 180) / Math.PI;
    if (Math.abs(c.fov - f) > 1e-3 || c.far < 400) { c.fov = f; c.near = 0.5; c.far = 600; c.updateProjectionMatrix(); }
  }

  return {
    id: 'tilePainter',
    async preload() { await Promise.all([boardReady, bankReady, preloadCatalogFor('tilePainter', []), preloadFx([PACK, DIGITS, LOCO, MONSTER]), ...Object.values(LEVELS).map((l) => loadPlacements('L' + l.level).then((p) => { placements.set(l.level, p); }))]); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'pogo';
      lv = LEVELS[variant] ?? LEVELS.pogo;
      result = null;
      lastImpact = 0;
      for (const e of world.ev) if (e.k === 'pogoProjectileEnd' && e.t < world.tick - 1) lastImpact = e.id;
      sfx.preloadFile(TIME_UP_SOUND);
      sfx.preloadFile(DRAW_SOUND);
      const bank = lv.sfx;
      void bankReady.then(() => {
        const samples = bankIdx?.[bank];
        for (const sample of samples?.slice(RUN[bank], RUN[bank] + 20) ?? []) {
          if (sample.file) sfx.preloadFile(sample.file);
        }
        const cueIds = [0x520, 0x521, 0x522, 0x43c];
        if (lv.level === 12) cueIds.push(0x53c, 0x53d, 0x53e, 0x542, 0x543);
        for (const id of cueIds) {
          const file = samples?.[SND[bank][id]]?.file;
          if (file) sfx.preloadFile(file);
        }
      });
      kit = new Kit(ctx, 'tilePainter', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      kit.realFx(K); beams = []; mkBeams(); mkMissileTrail();
      pogoSprings.clear(); objs.clear(); icons.clear();
      arena = null;
      build();
      setCamera(ctx);
      if (!loaded) this.preload!().then(() => { if (!arena) { kit.root.clear(); kit.realFx(K); build(); } if (kit) { mkBeams(); mkMissileTrail(); } });
    },

    render(ctx, w, dt) {
      if (!result) {
        catchingUp = ctx.resultReplayAt !== undefined && ctx.time - ctx.resultReplayAt >= 1 / 30;
        playProjectileImpacts(w);
        kit.checkOver(w);
        if (kit.over.done) {
          const winner = kit.over.winners.values().next().value;
          const lastFrame = pogoResultWindowTicks(undefined, winner, winner === undefined ? 0 : kit.look(winner).char);
          result = { world: createPogoResult(w), at: ctx.resultReplayAt ?? ctx.time, entered: [-1, -1, -1, -1], lastFrame };
        }
      }
      if (result) {
        w = result.world;
        kit.world = w;
        const frame = Math.floor((ctx.time - result.at) * 30 + 1e-7);
        while (kit.over.frame < frame && kit.over.frame < result.lastFrame) {
          tickResult(result, ++kit.over.frame);
          playProjectileImpacts(w);
          for (const e of w.ev) this.onEvent!(ctx, e);
          w.ev.length = 0;
          kit.real.update(1 / 30, ctx.camera);
        }
      }
      catchingUp = false;
      setCamera(ctx);
      const d = w.data;
      const arenaTick = result ? w.tick : Math.max(w.tick, Math.floor(w.time * 30 + 1e-6));
      board?.update(d, arenaTick);
      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of beams) b.begin();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          const slot = b.slot, playerWorld = result ? w : kit.playerWorld(slot), d = playerWorld.data;
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(slot));
          const entered = result?.entered[slot] ?? -1;
          const win = kit.over.winners.has(slot);
          const lose = entered >= 0 && !win && kit.over.winners.size > 0;
          const air = b.y > 0.02;
          const stun = (d.stun?.[slot] ?? 0) > 0;
          const taz = (d.taz?.[slot] ?? 0) > 0;
          const counter = d.cnt?.[slot] ?? -1, fast = d.item?.[slot] === 5;
          const playScript = stun ? 0x31 : taz ? 0x30 : fast ? 0x2f : 0x2e;
          const script = entered < 0 ? playScript : win ? WIN_SCRIPT : RESULT_HOP_SCRIPT;
          // The loser spins on the first pose. FUN_800b6ae0 never advances its script.
          const scriptFrame = entered < 0 ? (stun ? d.stun[slot] - 1 : taz ? BEAM_FRAMES - d.taz[slot] : undefined)
            : lose ? 0 : kit.over.frame - entered;
          if (result) a.face = b.face;
          a.update(b, dt, { role: stun ? 'hit' : taz ? 'action' : air ? 'hop' : 'idle', freeze: true,
            keepYaw: !!result, script, scriptFrame,
            renderWord: counter >= 0 && entered < 0 && !stun && !taz ? POGO_HOP[d.fam[slot] - 1]?.[Math.floor(counter)] : undefined });
          if (lose) a.shadow.visible = false;
          // The pogo model contains the vertical hop. The body height also drives gameplay and shadows.
          if (a.inst.ref && !stun && !taz && !lose) a.holder.position.y = 0;
          const sp = pogoSprings.get(slot);
          if (sp) sp.scale.y = air ? 1 : 0.6;
          const held = heldItem(slot, d.item?.[slot] ?? 0);
          if (held) {
            const tick = Math.max(arenaTick, playerWorld.tick);
            const between = tick - playerWorld.tick;
            const yaw = d.itemYaw?.[slot] ?? d.itemAge[slot] * 0x71;
            // In the L13 opening global frame 3271 was play tick 1. The sim counts the pickup tick in itemT.
            held.visible = d.item[slot] !== 6 || d.itemT[slot] + 1 - between > 90 || ((tick + 6) & 4) === 0;
            held.position.set(b.x, b.y + a.headY + 0.2, b.z);
            held.rotation.y = -((yaw + between * 0x71) & 0xfff) * YAW_UNIT;
          }
        } else if (b.kind === 'crate' || b.kind === 'power' || b.kind === 'arrow' || b.kind === 'missile' || b.kind === 'monster' || b.kind === 'padlock' || b.kind === 'beam') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            let obj: THREE.Object3D;
            let mon: ModelInstance | undefined;
            let lock: THREE.Object3D | undefined, shadow: THREE.Object3D | undefined;
            if (b.kind === 'monster') {
              mon = new ModelInstance({ model: MONSTER, scale: K, parts: ['part0'] });
              obj = new THREE.Group();
              shadow = packPart(40);
              shadow.scale.setScalar(0x15c0 / 4096);
              obj.add(shadow);
              if (mon.build()) {
                mon.root.userData.shared = true;
                obj.add(mon.root);
              }
            } else if (b.kind === 'beam') obj = new THREE.Group();
            // real objects (pack 0770): padlock 0x2041, cash crate 0x200b, arrow 0x2001 / double arrow 0x200e, item on its tile,
            // projectile 0x200d (steal gun 0x2040)
            else if (b.kind === 'padlock') {
              obj = new THREE.Group();
              lock = packPart(64);
              obj.add(packPart(40), lock); // 0x2029 ground shadow does not turn or grow with 0x2041
            }
            else if (b.kind === 'crate') obj = packPart(10);
            else if (b.kind === 'arrow') obj = packPart(b.m === 8 ? 13 : 0);
            else if (b.kind === 'power') obj = packPart(ITEM_PART[b.cd] ?? 12);
            else obj = packPart(b.cd === 3 ? 63 : b.cd === 2 ? 26 : 12);
            kit.root.add(obj);
            o = { obj, mon, lock, shadow };
            objs.set(b.id, o);
          }
          if (b.kind === 'missile') { o.obj.position.set(b.x, b.y, b.z); o.obj.rotation.y = b.face + Math.PI / 2; } // pack 0770 missile noses point along local -x
          else if (b.kind === 'beam') { // FUN_800ba51c: electro sparks along the whole line ahead of the shooter
            const dx = b.cd === 0 ? 1 : b.cd === 1 ? -1 : 0;
            const dz = b.cd === 2 ? -1 : b.cd === 3 ? 1 : 0;
            const yaw = [0, Math.PI, Math.PI / 2, -Math.PI / 2][b.cd];
            const firstTick = d.beams.find((beam: { id: number }) => beam.id === b.id)?.firstTick;
            for (let k = 0; k < b.dash; k++) {
              const frame = w.tick < (firstTick ?? 0) ? 2 : (w.tick + k) & 7;
              const distance = (firstTick === undefined ? k + 0.5 : k) * TP_TILE;
              beams[frame]?.add(b.x + dx * distance, 80 * U, b.z + dz * distance, yaw, dx ? Math.PI / 2 : 0);
            }
          } else if (b.kind === 'monster') {
            const m = d.mon;
            // A legacy snapshot has no render word. Recover its pose from the same arena timers.
            const spin = m.st === 5;
            const word = spin ? 0x4000 + (Math.max(0, 139 - m.tm) % 21)
              : m.st === 1 ? 0x4080 + ((159 - m.tm + 26) % 26) : 0x4100 + ((m.cyc + 13) % 14);
            o.mon?.nativePose(m.pose ?? word);
            if (o.mon) {
              o.mon.root.position.set(b.x, 0, b.z);
              o.mon.root.rotation.y = m.yaw === undefined && spin ? b.dash : b.face;
            }
            if (o.shadow) {
              const [x, z] = tileWorld(m.shadowX ?? m.x, m.shadowZ ?? m.z);
              o.shadow.position.set(x, 16 * U, z);
            }
          } else if (b.kind === 'padlock' && o.lock) {
            o.obj.position.set(b.x, 16 * U, b.z);
            o.lock.scale.y = Math.min(1, b.vx + (arenaTick - w.tick) / 16);
            o.lock.rotation.y = -((PADLOCK_INTRO_TICKS + arenaTick) * 0x38 & 0xfff) * YAW_UNIT;
          } else {
            o.obj.scale.setScalar(Math.max(0.05, Math.min(1, b.dash / 16))); // crates grow in over 16 frames (+0x100 / frame)
            // FUN_800baef0: after landing, +56 units of upward speed, then -8 per tick until the next bounce.
            const bounce = b.kind === 'power' ? Math.max(0, b.dash - 17) % 15 : 0;
            o.obj.position.set(b.x, 4 * bounce * (15 - bounce) * U, b.z);
            if (b.kind === 'arrow') { // FUN_800baba8: yaw eases 1/8 per frame toward dir * 0x400
              // the 0770 arrow mesh's tip is on its gltf +z, so add a half turn: the arrow then points along its fill
              // (checked on the emulator: dir 2 = yaw 0x800 points at the camera, game -z)
              const tgt = Math.PI - (b.cd & 3) * Math.PI / 2;
              if (result) {
                // Reconstruct the turn from crate age so a replay needs no prior render frames.
                const readyAge = b.dash - 17;
                o.yaw = readyAge < 32 ? tgt : tgt + Math.PI / 2 * Math.pow(7 / 8, readyAge % 32 + 1);
              } else {
                o.yaw ??= tgt;
                const dy = Math.atan2(Math.sin(tgt - o.yaw), Math.cos(tgt - o.yaw));
                o.yaw += dy * (1 - Math.pow(7 / 8, dt * 30));
              }
              o.obj.rotation.y = o.yaw;
            } else if (b.kind === 'power' && (b.cd === 1 || b.cd === 2 || b.cd === 4)) {
              o.obj.rotation.y = (b.dash * 0x38 & 0xfff) * YAW_UNIT;
            }
          }
        }
      }
      kit.prune(seen);
      for (const [id, o] of objs) if (!seenO.has(id)) {
        kit.root.remove(o.obj); disposeTree(o.obj); objs.delete(id);
      }
      for (const b of beams) b.end();
      drawMissileTrail(w, ctx.camera);
      if (!result) kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (e.k === 'jump' || e.k === 'land' || e.k === 'hit') return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'sfx': if (e.v !== 0x521) playId(e.v); break;
        case 'pogoDust':
          playDust(e.v, e.x, e.z, result ? hash(e.t * 4 + e.s) : undefined);
          break;
        case 'pogoCashCrate':
          kit.real.play(PACK, 3, e.x, 0, e.z);
          break;
        case 'cash':
          // FUN_800b788c -> FUN_8008d5d4: banked tiles float up as a number.
          kit.real.number(e.v, e.x, 256 * U, e.z + 256 * U, 0);
          kit.shake(0.3);
          break;
        case 'pickup': case 'line': case 'cross':
          kit.real.play(PACK, 1, e.x, 0, e.z); // FUN_800b935c: every other pickup goes in script 1
          if (e.k === 'cross') kit.shake(0.2);
          break;
        case 'pogoBeamSpark':
          kit.real.play(PACK, 7, e.x, 80 * U, e.z);
          break;
        case 'beam': {
          const dir = Math.round(e.v), n = Math.max(1, Math.round(e.o));
          const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? -1 : dir === 3 ? 1 : 0; // world z is flipped
          kit.real.play(PACK, 8, e.x + dx * (n + 0.5) * TP_TILE, 144 * U, e.z + dz * (n + 0.5) * TP_TILE);
          break;
        }
        case 'missile':
          if (!catchingUp) charVoice('a2', kit.look(e.s).char, 0x10);
          break;
        case 'stun':
          if (!catchingUp) hitVoice('a2', kit.look(e.s).char, 0.8, 0);
          break;
        case 'wipe':
          kit.shake(0.2);
          break;
        case 'boom':
          kit.real.play(LOCO, 1, e.x, 0, e.z); // mine tile (FUN_800b8180): the level's script 1
          kit.shake(0.35);
          break;
      }
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, s => (w.data.shown ?? w.data.score)?.[s] ?? 0, arenaClockSprites('tilePainter', w));
    },

    hud(w, slot) {
      return pad3((w.data.shown ?? w.data.score)?.[slot] ?? 0);
    },

    dispose() {
      for (const o of objs.values()) kit.root.remove(o.obj);
      for (const t of icons.values()) if (t.obj) kit.root.remove(t.obj);
      objs.clear(); icons.clear(); pogoSprings.clear();
      board?.dispose(); board = null;
      boardTexture.dispose();
      for (const b of beams) b.dispose();
      beams = [];
      missileTrail?.dispose();
      result = null;
      kit.dispose();
    },
  };
}

