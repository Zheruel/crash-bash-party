// CRATE CRUSH view (shared/games/crateToss.ts): the real Jungle / Space / Snow / Drain Bash stages, wood / TNT / Nitro crates.
import * as THREE from 'three';
import { CT_CHEST_REVEAL, CT_CHEST_SHRINK, CT_FLOOR_N, CT_HP, CT_OPENING_TICKS, CT_RING_COUNT, CT_RING_GAP, CT_RING_TICKS,
  CT_PENGUIN_LOOP, CT_PENGUIN_RETURN, CT_PENGUIN_WAKE, type CtPenguin, CT_U, CT_WEAPON_BLAST, CT_WEIGHT_DROP, CT_WEIGHT_OUT, ctActionTicks, ctHurtTicks, ctFruitRise, ctRingScale, floorAt, spaceFloorIndex } from '../../shared/games/crateToss';
import type { Body, GameEvent } from '../../shared/types';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, hitVoice, spinVoice, tauntVoice, winnerVoice } from '../shell/voice';
import { discStereo } from '../shell/discStereo';
import { poseTicks } from './playerPose';
import { createCharacter } from '../characters';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import type { ClientMiniGame } from './types';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import type { ModelInstance, ModelRef } from '../crash';
import { arenaClockSprites, hudFace, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { knockoutGhostRef, makeKnockoutGhost } from './knockoutGhost';
import { CrateTossResult } from './crateTossResult';
import { fxPartTemplate, preloadFx } from './realFx';
import { onFootGlowMarker } from '../../shared/games/onFoot';
import { CHARACTERS } from '../../shared/look';

const S = 3.6;
const CRATE_GHOST = knockoutGhostRef(S);

/** Real level ids (DAT_8005a648) and stage models; the sim's raw units map 1:1 onto PS1 units (z mirrored, see ps1ToWorld). */
const LEVEL_ID: Record<string, number> = { jungle: 0, space: 1, snow: 2, drain: 3 };
const LEVEL_MODEL: Record<string, number> = { jungle: 715, space: 711, snow: 707, drain: 703 };
const simRef = (v: string): ModelRef => ({ model: LEVEL_MODEL[v] ?? 715, scale: S, offset: [0, 0, 0], yaw: 0 });
const placements = new Map<string, Placements | null>();

/** Per level: stage key, fixed camera fitted to the real gameplay frames (model units x3.6), sound bank. */
interface Level { arena: string; bg: number; pos: [number, number, number]; pitch: number; fov: number; bank: string }
const LEVELS: Record<string, Level> = {
  jungle: { arena: 'crateToss:jungleBash', bg: 0x14301c, pos: [0, 4.62 * S, 8.64 * S], pitch: 24.7, fov: 24.3, bank: '0167' },
  space: { arena: 'crateToss:spaceBash', bg: 0x2a1a4a, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0166' },
  snow: { arena: 'crateToss:snowBash', bg: 0x0a1a48, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0165' },
  drain: { arena: 'crateToss:drainBash', bg: 0x0a1020, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0164' },
};
/**
 * Sound id -> sample of each level bank, read from the VAB tones (each tone carries its id, FUN_8002aca0 fills
 * table 0x80064508 from them). An id the bank does not declare is silent on the disc.
 */
const BANK_IDS: Record<string, Record<number, number>> = {
  '0167': {0x1c2: 0, 0x1c3: 1, 0x1c4: 2, 0x3e8: 9, 0x3e9: 10, 0x3ea: 9, 0x3eb: 10, 0x3ec: 11, 0x3ed: 12, 0x3ee: 11, 0x3ef: 12, 0x3f0: 13, 0x3f1: 14, 0x3f2: 15, 0x3f3: 14, 0x3f4: 15, 0x3f5: 16, 0x3f6: 17, 0x3f7: 16, 0x3f8: 17, 0x3f9: 18, 0x3fa: 19, 0x409: 32, 0x442: 33, 0x443: 34, 0x444: 35, 0x445: 36, 0x446: 37},
  '0166': {0x1c2: 0, 0x1c3: 1, 0x1c4: 2, 0x3e8: 9, 0x3e9: 10, 0x3ea: 9, 0x3eb: 10, 0x3ec: 11, 0x3ed: 12, 0x3ee: 11, 0x3ef: 12, 0x3f0: 13, 0x3f1: 14, 0x3f2: 15, 0x3f3: 14, 0x3f4: 15, 0x3f5: 16, 0x3f6: 17, 0x3f7: 16, 0x3f8: 17, 0x3f9: 18, 0x3fa: 19, 0x410: 20, 0x41a: 21, 0x41b: 22, 0x41c: 23, 0x41d: 28, 0x41e: 29, 0x41f: 30, 0x420: 31, 0x421: 32, 0x442: 33, 0x443: 34, 0x444: 35, 0x445: 36, 0x446: 37, 0x452: 24, 0x453: 25, 0x454: 26, 0x455: 27},
  '0165': {0x1c2: 0, 0x1c3: 1, 0x1c4: 2, 0x3e8: 9, 0x3e9: 10, 0x3ea: 9, 0x3eb: 10, 0x3ec: 11, 0x3ed: 11, 0x3ee: 11, 0x3ef: 11, 0x3f0: 12, 0x3f1: 13, 0x3f2: 14, 0x3f3: 13, 0x3f4: 14, 0x3f9: 15, 0x3fa: 16, 0x41a: 17, 0x41b: 18, 0x41c: 19, 0x41d: 24, 0x41e: 25, 0x41f: 26, 0x420: 27, 0x421: 28, 0x426: 31, 0x427: 32, 0x442: 35, 0x443: 35, 0x444: 36, 0x445: 36, 0x446: 37, 0x452: 20, 0x453: 21, 0x454: 22, 0x455: 23, 0x456: 34, 0x457: 34, 0x458: 34, 0x459: 34, 0x45a: 34, 0x45b: 34},
  '0164': {0x1c2: 0, 0x1c3: 1, 0x1c4: 2, 0x3ec: 9, 0x3ed: 10, 0x3ee: 9, 0x3ef: 10, 0x3f0: 11, 0x3f5: 12, 0x3f6: 13, 0x3f7: 12, 0x3f8: 13, 0x3f9: 14, 0x3fa: 15, 0x437: 23, 0x438: 24, 0x439: 25, 0x43a: 26, 0x43b: 27, 0x43c: 28, 0x442: 30, 0x443: 30, 0x444: 31, 0x445: 31, 0x446: 32},
};
/** FUN_8008e27c's rand(4) lists: 0x8009e444 wood, 0x8009e424 TNT, 0x8009e434 nitro, 0x8009e454 Drain crates and chests */
const WOOD_IDS = [0x3e8, 0x3e8, 0x3ea, 0x3eb], TNT_IDS = [0x3ec, 0x3ed, 0x3ee, 0x3ef], NITRO_IDS = [0x3f1, 0x3f1, 0x3f3, 0x3f4];
const CHEST_IDS = [0x3f5, 0x3f5, 0x3f7, 0x3f8];
const WEAPON_SOUND = [0, 0x43b, 0x43c, 0x43a]; // FUN_800b9dd8 orb, 800b9a34 missiles, 800ba354 ring
const WEAPON_PICKUP_SOUND = [0, 0x437, 0x438, 0x439]; // FUN_800b94c4
/** FUN_800be9d0: boots, slow motion, Aku Aku, weight (sim pickup codes 2..5) */
const POWER_SOUND: Record<number, number> = { 2: 0x41c, 3: 0x41d, 4: 0x41b, 5: 0x41a };
/** FUN_800be370..800be838 pickup meshes; FUN_800be9d0 copies them to the effect icon over the head */
const EFFECT_ICON: Record<number, string> = { 0x12: 'ctMask', 0x13: 'ctBoots', 0x14: 'ctWeight', 0x15: 'ctSlow' };

interface Vis {
  obj: THREE.Group;
  shadow: BlobShadow;
  mesh: THREE.Object3D;
  count: THREE.Object3D[];
  heldBy?: number;
  pickupFrom?: THREE.Vector3;
}

interface ShotVis {
  obj: THREE.Group;
  billboard?: THREE.Object3D;
  pulses?: { mesh: THREE.Object3D; materials: THREE.MeshBasicMaterial[] }[];
}

/** A prop's mesh as a lean template (only the visible part), cloned per use (shared geometry / materials). */
const templates = new Map<string, THREE.Object3D | null>();
function propClone(name: string, part?: string): THREE.Object3D {
  const key = part ? `${name}:${part}` : name;
  let t = templates.get(key);
  if (t === undefined) {
    const ref = getCatalog().props[name];
    const inst = catalogInstance(ref && part ? { ...ref, parts: [part] } : ref);
    t = inst ? inst.root : null;
    if (t) {
      const drop: THREE.Object3D[] = [];
      t.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.visible) drop.push(o); });
      for (const o of drop) o.removeFromParent();
    }
    templates.set(key, t);
  }
  return t ? t.clone() : new THREE.Group();
}

/** Flat PS1 sprites (quads in the model's xy plane) turned to face the camera every frame. */
const billboards = new Set<THREE.Object3D>();

export function createCrateTossView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'jungle';
  let lv: Level = LEVELS.jungle;
  const crates = new Map<number, Vis>();
  let lastOpeningFrame: number | undefined;
  const items = new Map<number, { obj: THREE.Group; frames: THREE.Object3D[] }>();
  const shots = new Map<number, ShotVis>();
  const weaponIcons = new Map<number, { kind: number; obj: THREE.Object3D }>();
  const ghosts = new Map<number, NonNullable<ReturnType<typeof makeKnockoutGhost>>>();
  const tiles: THREE.Object3D[] = [];
  const tileRims: THREE.Object3D[] = [];
  let arena: THREE.Group | null = null;
  let penguin: { obj: THREE.Group; inst: ReturnType<typeof catalogInstance> } | null = null;
  /** Object 0x1102 render words: script entries 0 (sleep), 1 (wake) and 2 (return) of 0x800c3654, mesh 0x2002 while sliding. */
  function penguinWord(pg: CtPenguin | undefined, opening?: number) {
    if (!pg) return 0x4015;
    if (pg.s === 3) return 0x2002;
    if (pg.s === 2) {
      const i = Math.min(pg.f, CT_PENGUIN_WAKE - 1);
      return i < 26 ? 0x4100 + i : i < 30 ? 0x4119 + i - 26 : i < 40 ? 0x411d : i < 57 ? 0x411e + i - 40 : i < 67 ? 0x412e : 0x412f + i - 67;
    }
    if (pg.e === 2) { const i = Math.min(pg.f, CT_PENGUIN_RETURN - 1); return i < 14 ? 0x4080 + i : 0x408d + i - 14; }
    const i = (opening ?? pg.f) % CT_PENGUIN_LOOP;
    return i < 38 ? 0x4015 + i : 0x4000 + i - 38;
  }
  /** 0x427 loops on the penguin's handle while it slides (FUN_800b879c state 3). */
  let penguinLoop: NonNullable<ReturnType<typeof sfx.startSample>> | undefined;
  function syncPenguinLoop(at: Body | undefined) {
    if (!at) { penguinLoop?.stop(); penguinLoop = undefined; return; }
    const camera = follow?.camera;
    const stereo = camera ? discStereo(camera, Math.round(at.x / CT_U), -16, -Math.round(at.z / CT_U)) : undefined;
    if (penguinLoop && !penguinLoop.ended) { if (stereo) penguinLoop.setStereo(stereo); return; }
    const file = idFile(0x427);
    const loop = bankIdx?.[lv.bank]?.[BANK_IDS[lv.bank]?.[0x427]]?.loop ?? null;
    penguinLoop = file ? sfx.startSample(file, loop, 1, sfxRate(lv.bank, 0x427), 0, stereo ?? [1, 1]) ?? undefined : undefined;
  }
  let builtArena = false;
  /** short-lived effect pieces (the game's own blast / smoke / shard / dust meshes) */
  interface Piece { obj: THREE.Object3D; t: number; life: number; v: THREE.Vector3; g: number; s0: number; s1: number; spin: number; fade: boolean; frames?: THREE.Object3D[] }
  const pieces: Piece[] = [];

  // samples are shared between banks on disc, so the file comes from audio/index.json
  let bankIdx: Record<string, { file?: string | null; loop?: number | null }[]> | null = null;
  const bankIndexReady = fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    bankIdx = {};
    for (const [k, v] of Object.entries<{ samples: { file?: string | null; loop?: number | null }[] }>(j?.sfx?.banks ?? {})) bankIdx[k] = v.samples;
  }).catch(() => { /* silent */ });
  const idFile = (id: number) => { const n = BANK_IDS[lv.bank]?.[id]; return n === undefined ? undefined : bankIdx?.[lv.bank]?.[n]?.file ?? undefined; };
  /** FUN_80022660(id, handle, pos, 0x1000, 0x1e00): full volume at the tone's pitch, panned and attenuated when it has a position. */
  const playId = (id: number, at?: GameEvent) => {
    const file = idFile(id);
    if (!file) return;
    if (at) spatialCue(at)(file, 1, sfxRate(lv.bank, id));
    else sfx.playFile(file, 1, true, sfxRate(lv.bank, id));
  };
  /** one of a rand-4 list (presentation only, not the sim rng) */
  const playPick = (ids: number[], at?: GameEvent) => playId(ids[Math.floor(Math.random() * ids.length)], at);
  let weightLoop: { slot: number; sound: NonNullable<ReturnType<typeof sfx.startSample>> } | undefined;
  /** FUN_800bef00 bends the 0x452 loop on handle 0x800c4780 up by (300 - timer) * 0xf00 / 300 pitch units. */
  function syncWeightLoop(slot: number, ticks: number) {
    if (slot < 0) { weightLoop?.sound.stop(); weightLoop = undefined; return; }
    const rate = sfxRate(lv.bank, 0x452) * 2 ** (Math.trunc((300 - Math.min(299, ticks)) * 0xf00 / 300) / 128 / 12);
    if (weightLoop) { weightLoop.sound.update(rate, 0); return; }
    const file = idFile(0x452);
    const sound = file ? sfx.startSample(file, bankIdx?.[lv.bank]?.[BANK_IDS[lv.bank][0x452]]?.loop ?? 0, 1, rate) : null;
    if (sound) weightLoop = { slot, sound };
  }
  type Scrape = { id: number; frame: number; sound: NonNullable<ReturnType<typeof sfx.startSample>> };
  const scrapes = new Map<number, Scrape>();
  function syncScrape(slot: number, id?: number, frame = 0) {
    const current = scrapes.get(slot);
    if (current && current.id === id && frame >= current.frame) { current.frame = frame; return; }
    current?.sound.stop();
    scrapes.delete(slot);
    const file = bankIdx?.['0165']?.[34]?.file;
    if (id === undefined || !file) return;
    const rate = sfxRate('0165', id);
    const sound = sfx.startSample(file, null, 1, rate, Math.max(0, frame - 1) * rate / 30);
    if (sound) scrapes.set(slot, { id, frame, sound });
  }
  const preloadSfx = () => {
    for (const id of Object.keys(BANK_IDS[lv.bank] ?? {})) { const file = idFile(Number(id)); if (file) sfx.preloadFile(file); }
  };
  const pickOf = (l: number[]) => l[Math.floor(Math.random() * l.length)]; // presentation only (not the sim rng)

  function buildArena() {
    if (builtArena) return;
    const pl = placements.get(variant);
    if (!pl) return;
    const lvl = levelStage(simRef(variant), pl, (r) => catalogInstance(r)?.root ?? null);
    if (!lvl) return;
    builtArena = true;
    arena = lvl;
    kit.root.add(arena);
    if (variant === 'space') {
      for (const pg of lvl.children) for (const h of pg.children) {
        // Model 0711 uses 0x5002 for the caution skirt and 0x5001, 0x5003–0x5041 for the tile tops.
        const id = parseInt(h.name, 16);
        if (!Number.isFinite(id) || id < 0x5001 || id > 0x5041) continue;
        const e = h.matrix.elements, x = e[12], z = e[14];
        const i = spaceFloorIndex(x, z);
        if (i < 0) continue;
        if (id === 0x5002) { tileRims[i] = h; h.visible = false; }
        else tiles[i] = h;
      }
    }
  }

  /** Object 0x1101 (FUN_800bab04 / 800b8694): nine glints of level part 0x2001 on the ice. Each shows at a random
   * point within +-0x780 for rand(3) + 1 updates and hides for rand(15) + 1. Presentation randomness only. */
  const glints: { obj: THREE.Object3D; shown: boolean; t: number }[] = [];
  let glintTick = -1;
  function stepGlints(tick: number) {
    if (glintTick < 0 || tick < glintTick || tick - glintTick > 60) glintTick = tick;
    for (; glintTick < tick; glintTick++) for (const g of glints) {
      if (!g.shown) {
        if (g.t === 0) {
          g.obj.position.set((Math.floor(Math.random() * 0xf00) - 0x780) * CT_U, 16 * CT_U, -(Math.floor(Math.random() * 0xf00) - 0x780) * CT_U);
          g.obj.visible = true;
          g.t = Math.floor(Math.random() * 3);
          g.shown = true;
        } else { g.t--; g.obj.visible = false; }
      } else if (g.t === 0) { g.t = Math.floor(Math.random() * 15); g.shown = false; }
      else g.t--;
    }
  }

  function build() {
    buildArena();
    glints.length = 0;
    glintTick = -1;
    if (variant === 'snow') {
      for (let i = 0; i < 9; i++) {
        const obj = propClone('ctGlint');
        obj.visible = false;
        obj.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (mesh.isMesh) mesh.material = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((q) => {
            const c = q.clone(); c.blending = THREE.AdditiveBlending; c.depthWrite = false; c.transparent = true; return c;
          });
        });
        kit.root.add(obj);
        glints.push({ obj, shown: false, t: Math.floor(Math.random() * 15) });
      }
      const inst = catalogInstance(getCatalog().props.ctPenguin);
      const obj = new THREE.Group();
      if (inst) obj.add(inst.root);
      kit.root.add(obj);
      penguin = { obj, inst };
    }
  }

  /** Spawn an effect piece (prop name or a list of frames to flip through). */
  function piece(name: string | string[], x: number, y: number, z: number, o: Partial<Omit<Piece, 'obj' | 't' | 'frames'>> & { bill?: boolean } = {}) {
    const obj = new THREE.Group();
    const frames = (Array.isArray(name) ? name : [name]).map((n) => { const f = propClone(n); obj.add(f); return f; });
    frames.forEach((f, i) => (f.visible = i === 0));
    obj.traverse((m) => { const mm = m as THREE.Mesh; if (mm.isMesh) { mm.material = (Array.isArray(mm.material) ? mm.material : [mm.material]).map((q) => { const c = q.clone(); c.transparent = true; c.depthWrite = false; return c; }); } });
    obj.position.set(x, y, z);
    const p: Piece = { obj, t: 0, life: o.life ?? 0.5, v: o.v ?? new THREE.Vector3(), g: o.g ?? 0, s0: o.s0 ?? 1, s1: o.s1 ?? 1, spin: o.spin ?? 0, fade: o.fade ?? true, frames: frames.length > 1 ? frames : undefined };
    obj.scale.setScalar(p.s0);
    if (o.bill !== false) billboards.add(obj);
    kit.root.add(obj);
    pieces.push(p);
    return p;
  }

  function stepPieces(dt: number) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.life);
      p.v.y -= p.g * dt;
      p.obj.position.addScaledVector(p.v, dt);
      p.obj.scale.setScalar(p.s0 + (p.s1 - p.s0) * k);
      if (p.spin) p.obj.rotation.z += p.spin * dt;
      if (p.frames) p.frames.forEach((f, j) => (f.visible = j === Math.min(p.frames!.length - 1, Math.floor(k * p.frames!.length))));
      if (p.fade) p.obj.traverse((m) => { const mm = m as THREE.Mesh; if (mm.isMesh) for (const q of mm.material as THREE.Material[]) q.opacity = 1 - k * k; });
      if (p.t >= p.life) { kit.root.remove(p.obj); billboards.delete(p.obj); pieces.splice(i, 1); }
    }
  }

  const rnd = (a: number) => (Math.random() * 2 - 1) * a; // presentation only (not the sim rng)
  /** Crate break / blast as the game draws it: flash, smoke puffs, flying shards (per crate colour), dust. */
  function burst(kind: 'T' | 'N' | 'W' | 'C', x: number, z: number, blast: number) {
    if (blast > 0) {
      piece(kind === 'N' ? 'ctFlashN' : 'ctFlash', x, 0.6, z, { life: 0.35, s0: 1.5, s1: 5 });
      const ring = piece('ctBlastRing', x, 0.05, z, { life: 0.4, s0: 1, s1: blast / 0.45, bill: false });
      ring.obj.scale.y = 0.4;
    }
    const smoke = kind === 'T' ? ['ctSmokeT0', 'ctSmokeT1'] : kind === 'N' ? ['ctSmokeN0', 'ctSmokeN1'] : ['ctSmokeW0', 'ctSmokeW1'];
    for (let i = 0; i < (blast > 0 ? 8 : 4); i++) {
      const a = (i / 8) * Math.PI * 2;
      piece(smoke[i % 2], x + Math.cos(a) * 0.3, 0.5 + Math.random() * 0.4, z + Math.sin(a) * 0.3, { life: 0.6 + Math.random() * 0.3, v: new THREE.Vector3(Math.cos(a) * 1.4, 0.8, Math.sin(a) * 1.4), s0: 0.8, s1: 2.2, spin: rnd(2) });
    }
    const shards = { T: ['ctShardT0', 'ctShardT1', 'ctShardT2'], N: ['ctShardN0', 'ctShardN1', 'ctShardN2'], C: ['ctShardC0', 'ctShardC1', 'ctShardC2'], W: variant === 'drain' ? ['ctShardW0', 'ctShardW1', 'ctShardW2', 'ctShardW3'] : ['ctRock', 'ctRock', 'ctShardW1'] }[kind];
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 3;
      piece(shards[i % shards.length], x, 0.45, z, { life: 0.8, v: new THREE.Vector3(Math.cos(a) * sp, 4 + Math.random() * 3, Math.sin(a) * sp), g: 14, s0: 0.8, s1: 0.6, spin: rnd(10), fade: false });
    }
  }

  /** Object 0x207 (FUN_8008dd40): 0736 parts 37-52, one per update, spawned 256 raw above a collected power-up. */
  function dust(x: number, y: number, z: number) {
    const f = Array.from({ length: 16 }, (_, i) => `ctDust${i}`);
    piece(f, x, y + 256 * CT_U, z, { life: 16 / 30, fade: false });
  }

  /** 0796 uses a fixed mesh for each unlit crate and separate faces for lit TNT. */
  function crateObj(kind: string): Vis {
    const obj = new THREE.Group();
    const name = kind === 'tnt' ? 'ctTnt0' : kind === 'nitro' ? 'ctNitro0' : kind === 'chest' ? 'ctChest' : variant === 'drain' ? 'ctDrainCrate' : 'ctWood';
    const mesh = propClone(name);
    obj.add(mesh);
    const count = kind === 'tnt' ? ['ctTnt1', 'ctTnt2', 'ctTnt3'].map((n) => { const f = propClone(n); f.visible = false; obj.add(f); return f; }) : [];
    kit.root.add(obj);
    return { obj, shadow: kit.fx.shadow(0.9, 0.45), mesh, count };
  }

  const FRUIT = Array.from({ length: 14 }, (_, i) => `ctFruit${i}`);
  const ITEM: Record<string, string> = { boots: 'ctBoots', potion: 'ctSlow', mask: 'ctMask', weight: 'ctWeight' };
  function weaponIcon(kind: number) {
    if (kind === 0x19) return propClone('ctRocket', 'part10');
    return propClone(kind === 0x1c ? 'ctRing' : 'ctOrb');
  }

  /** The effect object 0x8009d53c: a Drain weapon (0x19 / 0x1b / 0x1c) or a power-up (0x12..0x15) over the head. */
  function updateWeaponIcon(slot: number, kind: number, char: number, x: number, y: number, z: number, tick: number) {
    let icon = weaponIcons.get(slot);
    if (icon?.kind !== kind) {
      icon?.obj.removeFromParent();
      weaponIcons.delete(slot);
      if (!kind) return;
      const obj = new THREE.Group();
      const mesh = kind >= 0x19 ? weaponIcon(kind) : propClone(EFFECT_ICON[kind]);
      obj.add(mesh);
      obj.name = 'weapon-icon';
      kit.root.add(obj);
      icon = { kind, obj };
      weaponIcons.set(slot, icon);
    }
    // FUN_800bef00 uses the character head marker, with these base heights when the marker is absent.
    // The orb sits 96 higher. Aku Aku is offset by half the height along the spinning icon's Z axis.
    const height = (char <= 2 ? 384 : char <= 4 ? 512 : 640) + (kind === 0x1b ? 96 : 0);
    icon.obj.position.set(x, y + height * CT_U, z);
    icon.obj.children[0].position.z = kind === 0x12 ? (height >> 1) * CT_U : 0;
    icon.obj.rotation.y = -(tick * 170 % 4096) * Math.PI / 2048;
  }
  const headIcon = (d: { weapon?: number[]; eff?: number[] }, slot: number) => {
    const weapon = d.weapon?.[slot] ?? 0;
    if (weapon) return weapon === 1 ? 0x1b : weapon === 2 ? 0x19 : 0x1c;
    const eff = d.eff?.[slot] ?? 0;
    return EFFECT_ICON[eff] ? eff : 0;
  };
  /**
   * The player object 0x8009d540 (FUN_80083708: render word 0x2002 of the character pack for engine characters 3 and 4,
   * none for the others): part 1 of Cortex's and Brio's models, a camera-facing additive glow. The crate states put it
   * at model marker 0x40 (the ray gun's muzzle, Brio's flask). FUN_800c013c (pickup) scales it by the raw bytes of
   * 0x800c4790, a 2% speck the original never shows at full size; FUN_800c02d4 / 800c05a8 (carry) pulse X and Y by
   * 1 + sin/8 on the frame counter's 16-frame cycle; FUN_800c07f4 (throw) flashes it through 0x8009dc68 (5x to 1/8)
   * for five updates. The engine hides it at the start of every player update, so it shows only in these states.
   */
  const GLOW_MODEL: Record<string, number> = { cortex: 986, brio: 984 };
  const PICKUP_GLOW = [[80, 48], [56, 48], [24, 32], [16, 16], [8, 10], [10, 10], [16, 8], [10, 10], [8, 16], [10, 10], [16, 8],
    [10, 10], [8, 16], [10, 10], [16, 8], [10, 10], [8, 16], [10, 10], [16, 8], [10, 10], [8, 16], [10, 10]];
  const THROW_GLOW = [[20480, 20480], [16384, 8192], [6144, 4096], [2048, 2560], [512, 512]];
  const glows = new Map<number, THREE.Object3D>();
  const glowAt = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function updateGlow(slot: number, script: number, frame: number | undefined, tick: number, b: Body, face: number) {
    const model = GLOW_MODEL[CHARACTERS[kit.look(slot).char]?.id];
    const character = model === 986 ? 3 : 4;
    const marker = model && frame !== undefined && script >= 0xf && script <= 0x12 ? onFootGlowMarker(character, script, frame) : undefined;
    // The handler's counter starts at 0 on the first update after the state's init has shown script frame 0.
    const index = (frame ?? 0) - 1;
    const scale = !marker ? undefined : script === 0xf ? PICKUP_GLOW[Math.max(0, index)]
      : script === 0x12 ? THROW_GLOW[Math.max(0, index)]
      : [4096 + (Math.round(4096 * Math.sin(((((tick & 15) * 256 - 1024) & 4095) * Math.PI) / 2048)) >> 3)];
    let obj = glows.get(slot);
    if (!marker || !scale) { if (obj) obj.visible = false; return; }
    if (!obj) {
      const template = fxPartTemplate(model, 1, S);
      if (!template) return;
      obj = new THREE.Group();
      obj.add(template.clone());
      obj.name = 'carry-glow';
      kit.root.add(obj);
      billboards.add(obj);
      glows.set(slot, obj);
    }
    const [x, h, z] = marker;
    glowAt.set(x, h, -z).multiplyScalar(CT_U).applyAxisAngle(UP, face);
    obj.position.set(b.x + glowAt.x, b.y + glowAt.y, b.z + glowAt.z);
    obj.scale.set(scale[0] / 4096, (scale[1] ?? scale[0]) / 4096, 1);
    obj.visible = true;
  }

  /** FUN_800c09f4 / 800c0bac: the dropped weight (0736 part 1) falls 4096 raw at 256 per update onto the holder. */
  const weightDrops = new Map<number, THREE.Object3D>();
  const spiritCue = new Map<number, number>();
  function updateWeightDrop(slot: number, age: number | undefined, x: number, z: number) {
    let obj = weightDrops.get(slot);
    if (age === undefined || age >= CT_WEIGHT_OUT) { if (obj) obj.visible = false; return; }
    if (!obj) { obj = propClone('ctWeightDrop'); kit.root.add(obj); weightDrops.set(slot, obj); }
    obj.visible = true;
    obj.position.set(x, Math.max(0, 4096 - 256 * age) * CT_U, z);
  }

  function itemObj(kind: string, b: { slot: number }): { obj: THREE.Group; frames: THREE.Object3D[] } {
    const obj = new THREE.Group();
    let frames: THREE.Object3D[] = [];
    if (kind === 'fruit') {
      frames = FRUIT.map((n) => { const f = propClone(n); obj.add(f); return f; });
      billboards.add(obj);
    } else obj.add(kind === 'weapon' ? weaponIcon(b.slot) : propClone(ITEM[kind] ?? 'ctGem'));
    kit.root.add(obj);
    return { obj, frames };
  }

  function shotObj(kind: string): ShotVis {
    const obj = new THREE.Group();
    obj.name = kind;
    const vis: ShotVis = { obj };
    if (kind === 'ring') {
      vis.pulses = Array.from({ length: CT_RING_COUNT }, () => {
        const mesh = propClone('ctBlastRing');
        mesh.position.y = 256 * CT_U;
        mesh.visible = false;
        obj.add(mesh);
        const materials: THREE.MeshBasicMaterial[] = [];
        mesh.traverse((node) => {
          const part = node as THREE.Mesh;
          if (!part.isMesh) return;
          const src = part.material as THREE.MeshBasicMaterial;
          const mat = src.clone();
          mat.defines = { ...src.defines };
          mat.onBeforeCompile = src.onBeforeCompile;
          mat.customProgramCacheKey = src.customProgramCacheKey;
          part.material = mat;
          materials.push(mat);
        });
        return { mesh, materials };
      });
    } else if (kind === 'weaponBlast' || kind === 'orb') {
      if (kind === 'orb') obj.add(propClone('ctOrb'));
      vis.billboard = propClone('ctGem'); // 0736 part15, the additive flash shared by the orb and both explosions
      if (kind === 'orb') vis.billboard.scale.setScalar(4);
      billboards.add(vis.billboard);
      obj.add(vis.billboard);
    } else obj.add(propClone('ctRocket'));
    kit.root.add(obj);
    return vis;
  }

  function removeShot(shot: ShotVis) {
    shot.obj.removeFromParent();
    if (shot.billboard) billboards.delete(shot.billboard);
    for (const pulse of shot.pulses ?? []) for (const mat of pulse.materials) mat.dispose();
  }

  // camera mode 1: the engine's fit-everyone camera on the living players (bit-exact port, see ps1cam)
  let follow: Ps1Follow | null = null;
  let result: CrateTossResult | undefined;
  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0], dt = 0, w?: Parameters<ClientMiniGame['render']>[1]) {
    follow ??= new Ps1Follow(TRACK_CAMS[LEVEL_ID[variant] ?? 0], simRef(variant));
    const tracked: Tracked[] = [];
    for (const b of w?.bodies ?? []) if (b.kind === 'player' && b.alive) tracked.push({ pos: new THREE.Vector3(b.x, b.y, b.z), face: b.face });
    applyPose(ctx.camera, follow.step(dt, tracked));
    const c = ctx.camera;
    if (c.far < 400) { c.near = 0.5; c.far = 600; c.updateProjectionMatrix(); }
  }

  function spatialCue(e: GameEvent) {
    const camera = follow?.camera;
    const stereo = camera && discStereo(camera, Math.round(e.x / CT_U), (variant === 'drain' ? 0 : -16) - Math.round((e.y ?? 0) / CT_U), -Math.round(e.z / CT_U));
    return (file: string, volume: number, rate: number) => { sfx.startSample(file, null, volume, rate, 0, stereo); };
  }

  function ghost(b: Body, age: number) {
    let vis = ghosts.get(b.slot);
    if (age >= 106) {
      if (vis) vis.root.visible = false;
      return;
    }
    if (!vis) {
      vis = makeKnockoutGhost(S, b.id, 0, -16);
      if (!vis) return;
      kit.root.add(vis.root);
      ghosts.set(b.slot, vis);
    }
    vis.pose(b.x, b.y, b.z, age + 1, kit.ctx.camera);
  }

  /** FUN_800898ec: 0x1c3 or 0x1c4 at the actor when the spirit starts */
  function playOut(at?: GameEvent) {
    playId(Math.random() < 0.5 ? 0x1c3 : 0x1c4, at);
  }

  function crateEvent(ctx: Parameters<ClientMiniGame['render']>[0], e: GameEvent, audio: boolean) {
    switch (e.k) {
      case 'throwVoice': case 'resultThrowVoice':
        if (audio) charVoice('c', ctx.seats[e.s]?.look.char, 0x10);
        return true;
      case 'pickup':
        if (POWER_SOUND[e.v]) dust(e.x, e.y ?? 0, e.z);
        if (!audio) return true;
        if (e.v === 1) playId(0x1c2, e);
        else if (POWER_SOUND[e.v]) playId(POWER_SOUND[e.v], e);
        else if (e.v >= 6 && e.v <= 8) playId(WEAPON_PICKUP_SOUND[e.v - 5]);
        return true;
      case 'cue':
        if (audio) playId(e.v, e.o ? e : undefined);
        return true;
      case 'chestBreak':
        burst('C', e.x, e.z, 0);
        if (audio) playPick(CHEST_IDS);
        return true;
      case 'smash':
        burst(e.s === 2 ? 'C' : 'W', e.x, e.z, 0);
        // FUN_8008e27c: Drain's kind 3 crates use the 0x8009e454 list, wood the 0x8009e444 list.
        if (audio) playPick(variant === 'drain' ? CHEST_IDS : WOOD_IDS);
        return true;
      case 'beep':
        if (audio) playId(0x3f0, e);
        return true;
      case 'explode':
        burst(e.s === 1 ? 'N' : 'T', e.x, e.z, Math.max(1, e.v));
        if (audio) {
          playPick(e.s === 1 ? NITRO_IDS : TNT_IDS);
        }
        return true;
      case 'resultLand':
        if (audio) charVoice('c', ctx.seats[e.s]?.look.char, 0xd, 0, 1, undefined, spatialCue(e)); // script 8 op 0x8009
        return true;
      case 'resultOut':
        if (audio) playOut(e);
        return true;
      case 'weaponBlast':
        if (audio && e.o >= 0) playId(TNT_IDS[e.o]);
        return true;
      default:
        return false;
    }
  }

  return {
    id: 'crateToss',
    async preload() {
      await Promise.all([bankIndexReady, preloadCatalogFor('crateToss', ['ctWood', 'ctFruit0', 'ctPenguin'], [CRATE_GHOST]), preloadFx([986, 984]), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'jungle';
      lv = LEVELS[variant] ?? LEVELS.jungle;
      void bankIndexReady.then(preloadSfx);
      kit = new Kit(ctx, 'crateToss', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      weightDrops.clear(); spiritCue.clear();
      crates.clear(); items.clear(); shots.clear(); weaponIcons.clear(); glows.clear(); tiles.length = 0; tileRims.length = 0; pieces.length = 0; billboards.clear(); arena = null; penguin = null; builtArena = false;
      follow = null;
      result = undefined;
      ghosts.clear();
      lastOpeningFrame = undefined;
      build();
      setCamera(ctx, 0, world);
      if (!loaded) this.preload!().then(() => { buildArena(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w, false);
      if (kit.over.done) {
        const winner = kit.over.winners.values().next().value;
        const at = result?.at ?? ctx.resultReplayAt ?? ctx.time;
        const frame = Math.max(0, Math.floor((ctx.time - at) * 30 + 1e-7));
        const base = TRACK_CAMS[LEVEL_ID[variant] ?? 0];
        if (!result) {
          result = new CrateTossResult(w, winner, at, frame, base, simRef(variant), follow!.step(0, []));
          if (frame === 0) for (const p of result.scene.actors.values()) if (p.state === 'out' && p.outAge === 0) playOut();
        }
        while (result.frame < frame) {
          stepPieces(1 / 30);
          const events = result.step();
          const audio = result.frame >= result.audioFrom;
          for (const e of events) crateEvent(ctx, e, audio);
          const age = result.winnerAge;
          if (winner !== undefined && age >= 0) {
            if (audio) winnerVoice('crateToss', kit.look(winner).char, age - 1, age);
            else if (age === 0) sfx.enterRoundResult('winner');
          }
        }
        applyPose(ctx.camera, result.camera);
        w = result.world;
      } else {
        if (result) for (const inst of ghosts.values()) inst.root.visible = false;
        result = undefined;
        setCamera(ctx, dt, w);
      }
      const d = w.data;
      const seen = new Set<number>();
      const seenC = new Set<number>();
      const seenI = new Set<number>();
      const seenS = new Set<number>();
      if (variant === 'space' && d.floor?.length) {
        // FUN_800b8578 shows the skirt of an intact tile if a left, right or camera-side neighbor is missing.
        for (let i = 0; i < d.floor.length; i++) {
          const solid = d.floor[i] === 1;
          if (tiles[i]) tiles[i].visible = solid;
          const column = i % CT_FLOOR_N;
          if (tileRims[i]) tileRims[i].visible = solid && (
            (column > 0 && d.floor[i - 1] === 0) ||
            (column < CT_FLOOR_N - 1 && d.floor[i + 1] === 0) ||
            d.floor[i + CT_FLOOR_N] === 0
          );
        }
      }
      const tick = w.tick;
      const openingFrame = tick === 0 && ctx.countdownTicksLeft !== undefined
        ? CT_OPENING_TICKS - ctx.countdownTicksLeft : undefined;
      for (const b of w.bodies) {
        const state = d.cs?.[b.id];
        const reward = b.kind === 'chest' && state?.s === CT_CHEST_REVEAL && state.t >= 0;
        const born = d.openingSpawns?.[b.id];
        const openingAge = born !== undefined && openingFrame !== undefined ? openingFrame - born : undefined;
        if (openingAge !== undefined && openingAge < 0) continue;
        if (b.kind === 'player') {
          const playerWorld = result ? w : kit.playerWorld(b.slot);
          const d = playerWorld.data;
          const carriedBody = playerWorld.bodies.find(c => c.cd === b.slot + 1 && ['crate', 'tnt', 'nitro', 'chest'].includes(c.kind));
          seen.add(b.id);
          const a = kit.actor(b, () => ({ inst: createCharacter(kit.look(b.slot), { ring: false }), scale: nativeCharScale(kit.look(b.slot), S), headY: 2.3, shadow: 0.8 }));
          const ground = d.groundPose?.[b.slot];
          syncScrape(b.slot, !result && b.alive && ground?.script === 14 ? ground.scrape : undefined, ground?.frame);
          if (result) {
            const state = result.scene.actors.get(b.slot)!;
            if (state.state === 'out') ghost(b, state.outAge);
            updateGlow(b.slot, -1, undefined, tick, b, b.face);
            a.face = b.face;
            a.update(b, dt, result.actor(b, a.inst, !!carriedBody));
            if (b.fall || !floorAt(d, b.x, b.z)) a.shadow.visible = false;
            updateWeaponIcon(b.slot, b.alive ? headIcon(d, b.slot) : 0, d.char[b.slot], b.x, b.y, b.z, tick);
            continue;
          }
          const held = !!carriedBody;
          const character = d.char?.[b.slot] ?? 1;
          const touchdown = d.landedAt?.[b.slot] ?? -1;
          const landingFrame = touchdown < 0 ? 0 : playerWorld.tick - touchdown + 1;
          const landing = ground ? ground.script === 8 : landingFrame > 0 && landingFrame < poseTicks(8, character);
          const groundFrame = playerWorld.tick === 0 && ctx.countdownTicksLeft !== undefined
            ? Math.min(CT_OPENING_TICKS, Math.max(0, CT_OPENING_TICKS + 1 - ctx.countdownTicksLeft)) : ground?.frame;
          const jumpFrame = d.jumpFrame?.[b.slot];
          const stun = d.stun?.[b.slot] ?? 0;
          const action = d.act?.[b.slot] ?? 0;
          const taunt = d.tauntAt?.[b.slot] ?? -1;
          let role = taunt >= 0 ? 'taunt' : stun > 0 ? 'hit' : action > 0 ? 'action' : undefined;
          let pose: { clip: number; frame: number; loop?: boolean } | undefined;
          const anims = a.inst.ref?.anims;
          if (!kit.over.done && !b.fall && !stun && anims?.carry != null) {
            const scriptedRole = action === 1 ? 'lift' : action === 2 ? 'throw' : action === 3 ? 'spin' : null;
            if (scriptedRole) {
              const remaining = d.stT?.[b.slot] ?? 0;
              const total = ctActionTicks(d.char?.[b.slot] ?? 3, action);
              pose = { clip: anims[scriptedRole], frame: total - remaining };
              if (scriptedRole === 'spin') a.face = b.face;
            } else if (taunt >= 0) {
              pose = { clip: anims.taunt, frame: kit.poseTick(b.slot) - taunt };
            } else if (d.air?.[b.slot]) {
              const vy = d.vy[b.slot] ?? 0;
              const frame = d.jh?.[b.slot] ? Math.min(10, jumpFrame ?? 10 * (1 - Math.min(1, vy / 108)))
                : 10 + Math.min(9, jumpFrame ?? 9 * Math.min(1, vy / 100));
              pose = { clip: held ? anims.carryJump : anims.jump, frame };
            } else if (held) {
              const grip = d.cs?.[carriedBody.id];
              role = grip?.gripScript === 17 ? 'carryRun' : 'carry';
              if (grip) {
                const clip = anims[role];
                const phase = grip.gripFrame / poseTicks(grip.gripScript, character);
                pose = { clip, frame: phase * a.inst.clipTicks(clip), loop: true };
              }
            } else if (ground && groundFrame !== undefined) {
              // Both custom rigs use Cortex's movement family. His slide uses the idle model track.
              if (landing) pose = { clip: anims.jump, frame: 19 };
              else if (ground.script === 5) {
                const phase = groundFrame / poseTicks(5, character);
                pose = { clip: anims.run, frame: phase * a.inst.clipTicks(anims.run), loop: true };
              } else if (ground.script) pose = { clip: anims.idle, frame: groundFrame, loop: true };
            }
          }
          // invulnerable after a hit: the game flickers the model (40 ticks)
          const inv = (d.inv?.[b.slot] ?? 0) > 0 && b.alive && !b.fall;
          const moving = Math.hypot(b.vx, b.vz) > 0.7;
          const deadAge = b.alive ? 0 : kit.poseTick(b.slot) - d.elim[b.slot];
          // A weight knockout keeps the idle script under the falling weight (FUN_800c09f4). A lethal hit plays 0x13.
          const crushed = !b.alive && d.outBy?.[b.slot] === 1;
          const spiritAt = crushed ? CT_WEIGHT_OUT : poseTicks(0x13, character);
          const script = b.fall ? 7 : crushed ? 1 : !b.alive ? 0x13 : stun ? 9 : action === 1 ? 0xf : action === 2 ? 0x12 : action === 3 ? 10
            : taunt >= 0 ? 2 : held ? (d.cs?.[carriedBody.id]?.gripScript ?? (moving ? 0x11 : 0x10)) : d.air[b.slot] ? (d.jh[b.slot] ? 6 : 7) : ground?.script || (landing ? 8 : moving ? 5 : 1);
          const frame = !b.alive ? deadAge : action >= 1 && action <= 3 ? ctActionTicks(character, action) - d.stT[b.slot]
            : stun ? ctHurtTicks(character) - d.stT[b.slot] - 1 : taunt >= 0 ? kit.poseTick(b.slot) - taunt : carriedBody ? d.cs?.[carriedBody.id]?.gripFrame
            : d.air[b.slot] ? jumpFrame : groundFrame ?? (landing ? landingFrame : undefined);
          const hidden = !b.alive && (b.fall || deadAge >= spiritAt) || (inv && (tick & 2) !== 0);
          if (crushed && !hidden && !anims?.carry) pose = undefined;
          a.update(b, dt, { hidden, role: b.fall ? 'jump' : b.alive ? role : crushed ? 'idle' : 'lose', pose,
            script: anims?.carry != null || kit.over.done ? undefined : script, scriptFrame: b.fall ? undefined : frame });
          updateGlow(b.slot, kit.over.done || !b.alive || b.fall ? -1 : script, frame, tick, b, a.face);
          // FUN_800c0bac flattens the holder to 1/16 height once the weight reaches the floor.
          if (crushed && deadAge >= CT_WEIGHT_DROP) a.pivot.scale.y /= 16;
          updateWeightDrop(b.slot, crushed ? deadAge : undefined, b.x, b.z);
          if (crushed && deadAge === CT_WEIGHT_DROP && spiritCue.get(b.slot) !== -CT_WEIGHT_DROP) {
            spiritCue.set(b.slot, -CT_WEIGHT_DROP);
            playId(0x455);
          }
          // FUN_800c0de4 / 800898ec: the spirit rises when script 0x13 (or the weight's countdown) ends.
          if (!b.alive && !b.fall && deadAge >= spiritAt) {
            ghost(b, deadAge - spiritAt);
            if (spiritCue.get(b.slot) !== d.elim[b.slot]) {
              spiritCue.set(b.slot, d.elim[b.slot]);
              if (deadAge === spiritAt) playOut({ x: b.x, z: b.z, y: b.y } as GameEvent);
            }
          }
          if (variant === 'space' && (b.fall || !floorAt(d, b.x, b.z))) a.shadow.visible = false;
          updateWeaponIcon(b.slot, b.alive ? headIcon(d, b.slot) : 0, character, b.x, b.y, b.z, kit.poseTick(b.slot));
        } else if (b.kind === 'crate' || b.kind === 'tnt' || b.kind === 'nitro' || (b.kind === 'chest' && !reward)) {
          seenC.add(b.id);
          let v = crates.get(b.id);
          const previous = v;
          if (!v) { v = crateObj(b.kind); crates.set(b.id, v); }
          const held = b.cd > 0;
          const slot = b.cd - 1;
          const holder = held ? kit.actorForSlot(slot) : undefined;
          const grip = holder?.inst.root.getObjectByName('CrateGrip');
          const holderState = held && !result ? kit.playerWorld(slot).data : d;
          const picking = grip && holderState.act?.[slot] === 1;
          if (picking && previous && v.heldBy !== b.cd) v.pickupFrom = v.obj.position.clone();
          if (!picking) v.pickupFrom = undefined;
          v.heldBy = b.cd;
          v.obj.position.set(b.x, b.y, b.z);
          if (holder && grip) {
            grip.getWorldPosition(v.obj.position);
            kit.root.worldToLocal(v.obj.position);
            v.obj.position.y = Math.max(holder.holder.position.y, v.obj.position.y);
            if (v.pickupFrom) {
              const ticks = ctActionTicks(holderState.char?.[slot] ?? 3, 1);
              const elapsed = ticks - (holderState.stT?.[slot] ?? 0);
              v.obj.position.lerp(v.pickupFrom, 1 - THREE.MathUtils.smoothstep(elapsed, 0, ticks / 2));
            }
          }
          v.obj.scale.y = openingAge !== undefined ? Math.min(1, (openingAge + 1) / 8)
            : state?.s === CT_CHEST_SHRINK ? state.t / 8 : state?.s === 0 ? Math.max(0, 1 - state.t / 8) : 1;
          const crateState = holderState.cs?.[b.id];
          v.obj.rotation.set(held && !grip ? crateState?.pitch ?? 0 : 0, grip && holder ? holder.face : b.face, 0, 'YXZ');
          const { x, y, z } = v.obj.position;
          v.shadow.set(x, z, held ? y + 0.5 : y);
          if (variant === 'space') v.shadow.visible = y >= 0 && floorAt(d, x, z);
          const lit = b.kind === 'tnt' && b.fall;
          v.mesh.visible = !lit;
          v.count.forEach((o, i) => (o.visible = lit && i === Math.max(0, Math.min(2, Math.ceil(b.m) - 1))));
        } else if (reward || b.kind === 'fruit' || b.kind === 'boots' || b.kind === 'potion' || b.kind === 'mask' || b.kind === 'weight' || b.kind === 'weapon') {
          if (b.kind === 'fruit' && born !== undefined && openingFrame !== undefined
            && born > (lastOpeningFrame ?? openingFrame - 1)) playId(0x3fa);
          seenI.add(b.id);
          let o = items.get(b.id);
          if (!o) {
            o = reward ? itemObj(state.item ? 'weapon' : 'fruit', { slot: state.item }) : itemObj(b.kind, b);
            items.set(b.id, o);
          }
          const rise = b.kind === 'fruit' && b.y === 0 ? ctFruitRise(openingAge ?? (b.cd - 1)) : 0;
          o.obj.position.set(b.x, b.y + rise, b.z);
          if (o.frames.length) {
            const f = reward ? state.fruitFrame ?? 0 : Math.floor(((openingFrame ?? (tick + CT_OPENING_TICKS - 1)) + 1) / 2);
            o.frames.forEach((q, i) => (q.visible = i === f % o.frames.length));
          } else if (reward) o.obj.rotation.y = b.face;
          else o.obj.rotation.y += dt * 2;
        } else if (b.kind === 'orb' || b.kind === 'rocket' || b.kind === 'ring' || b.kind === 'weaponBlast') {
          seenS.add(b.id);
          let shot = shots.get(b.id);
          if (!shot) { shot = shotObj(b.kind); shots.set(b.id, shot); }
          shot.obj.position.set(b.x, b.y, b.z);
          if (b.kind === 'rocket') shot.obj.rotation.y = b.face + Math.PI / 2; // 0736 part13 points along local -X
          if (shot.pulses) shot.pulses.forEach(({ mesh, materials }, i) => {
            const age = b.cd - i * CT_RING_GAP;
            // The last expansion still probes collisions after the native render flags clear.
            mesh.visible = age >= 0 && age < CT_RING_TICKS - 1;
            if (!mesh.visible) return;
            const scale = ctRingScale(age) / 4096;
            mesh.scale.set(scale, 1, scale);
            for (const mat of materials) mat.color.setScalar(1 - (age + 1) / 16);
          });
          if (b.kind === 'weaponBlast' && shot.billboard) {
            const scale = CT_WEAPON_BLAST[b.cd];
            shot.obj.visible = !!scale;
            if (scale) shot.billboard.scale.set(scale[0] / 4096, scale[1] / 4096, scale[2] / 4096);
          }
        } else if (b.kind === 'penguin' && penguin) {
          const pg = d.peng as CtPenguin | undefined;
          penguin.obj.position.set(b.x, 0, b.z);
          penguin.obj.rotation.y = b.face;
          const word = penguinWord(pg, openingFrame);
          if (!penguin.inst?.nativePose(word)) penguin.inst?.play((d.penguin ?? 0) > 0 ? 'run' : 'idle');
          syncPenguinLoop(!result && pg?.s === 3 ? b : undefined);
        }
      }
      const weightHolder = result ? -1 : d.weight ?? -1;
      syncWeightLoop(weightHolder, weightHolder >= 0 ? d.effT?.[weightHolder] ?? 0 : 0);
      kit.prune(seen);
      for (const [id, v] of crates) if (!seenC.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); crates.delete(id); }
      for (const [id, o] of items) if (!seenI.has(id)) { kit.root.remove(o.obj); billboards.delete(o.obj); items.delete(id); }
      for (const [id, o] of shots) if (!seenS.has(id)) { removeShot(o); shots.delete(id); }
      if (openingFrame !== undefined) lastOpeningFrame = Math.max(lastOpeningFrame ?? -1, openingFrame);
      if (!result) stepPieces(dt);
      if (glints.length) stepGlints(tick);
      for (const o of billboards) o.quaternion.copy(ctx.camera.quaternion);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      if (crateEvent(ctx, e, true)) return;
      switch (e.k) {
        case 'kick':
          spinVoice('c', ctx.seats[e.s]?.look.char);
          break;
        case 'fruitSpawn':
          playId(0x3fa); // FUN_8008d824
          break;
        case 'grab':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xf);
          break;
        case 'taunt':
          tauntVoice('c', ctx.seats[e.s]?.look.char);
          break;
        case 'carryStep':
          charVoice('c', ctx.seats[e.s]?.look.char, e.v === 0 ? 0xa : 0xb, 0, 1);
          break;
        case 'step': {
          const play = spatialCue(e);
          if (e.o === 0x41e) {
            const file = idFile(0x41e);
            if (file) play(file, 1, sfxRate(lv.bank, e.o));
          } else charVoice('c', ctx.seats[e.s]?.look.char, e.v === 0 ? 0xa : 0xb, 0, 1, undefined, play);
          break;
        }
        case 'land':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xd, 0, 1, undefined, spatialCue(e));
          break;
        case 'hit':
          kit.actorForSlot(e.s)?.hit(1.2);
          hitVoice('c', ctx.seats[e.s]?.look.char, undefined, -1, undefined, undefined, e.s); // FUN_800bfd2c: rand(4) of 0x8009e080, Aku hits included
          break;
        case 'thud':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xd, 0, 1, undefined, spatialCue(e)); // FUN_800bff1c
          break;
        case 'hole':
          playId(0x410, e);
          break;
        case 'jump':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xc);
          break;
        case 'weapon': {
          const id = WEAPON_SOUND[e.v] ?? 0;
          if (id) playId(id, e);
          break;
        }
      }
    },

    /** Real HUD: face, wumpa icon and health bar per player (52 px = 20 HP), clock in the middle. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      SLOT_X.forEach((x, slot) => {
        const seat = ctx.seats[slot];
        if (!seat) return;
        out.push({ tex: hudFace(seat.look.char), x, y: 10, w: 64, h: 40 });
        const hp = Math.max(0, Math.min(CT_HP, (result?.world ?? w).data.hp?.[slot] ?? 0));
        const g = Math.round((52 * hp) / CT_HP);
        out.push({ tex: `${ASSET_BASE}hud/barR.png`, x: x + 16, y: 47 - 8, w: 52, h: 6 });
        if (g > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + 16, y: 47 - 8, w: g, h: 6 });
        out.push({ tex: `${ASSET_BASE}textures/0735/tex000.png`, x: x - 8, y: 33, w: 26, h: 20 });
      });
      out.push(...arenaClockSprites('crateToss', w));
      return out;
    },

    hud(w, slot) {
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'player' && b.slot === slot && b.alive);
      const wp = (w.data.weapon?.[slot] ?? 0) > 0 ? ` · ${['', 'ORB', 'MISSILES', 'RING'][w.data.weapon[slot]]} x${w.data.ammo[slot]}` : '';
      return alive ? `${hp}/${CT_HP} HP${wp}` : 'OUT';
    },

    dispose() {
      for (const playing of scrapes.values()) playing.sound.stop();
      syncWeightLoop(-1, 0);
      syncPenguinLoop(undefined);
      scrapes.clear();
      for (const shot of shots.values()) removeShot(shot);
      crates.clear(); items.clear(); shots.clear(); weaponIcons.clear(); glows.clear(); tiles.length = 0; pieces.length = 0; billboards.clear();
      for (const ghost of ghosts.values()) ghost.dispose();
      ghosts.clear();
      result = undefined;
      kit.dispose();
    },
  };
}
