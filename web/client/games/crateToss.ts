// CRATE CRUSH view (shared/games/crateToss.ts): the real Jungle / Space / Snow / Drain Bash stages, wood / TNT / Nitro crates.
import * as THREE from 'three';
import { CT_FLOOR_N, CT_HP, CT_RING_COUNT, CT_RING_GAP, CT_RING_TICKS,
  CT_U, CT_WEAPON_BLAST, ctActionTicks, ctRingScale, floorAt, spaceFloorIndex } from '../../shared/games/crateToss';
import type { Body, GameEvent } from '../../shared/types';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, hitVoice, spinVoice, tauntVoice, winnerVoice } from '../shell/voice';
import { poseTicks } from './playerPose';
import { createCharacter } from '../characters';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import type { ClientMiniGame } from './types';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import type { ModelInstance, ModelRef } from '../crash';
import { arenaClockSprites, hudFace, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { knockoutGhostRef, makeKnockoutGhost } from './knockoutGhost';
import { CrateTossResult } from './crateTossResult';

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
 * Real sound ids of the game (FUN_80022660 -> VAB tone) as sample numbers of each level's bank, order jungle / space / snow / drain.
 * `wood` / `tnt` / `nitro` are the lists the game picks from (0x3e8.., 0x3ec.., 0x3f1..); see re/notes/crateCrush.md.
 */
const SFX: Record<string, { beep: number; thump: number; whoosh: number; wood: number[]; tnt: number[]; nitro: number[] }> = {
  jungle: { beep: 13, thump: 18, whoosh: 19, wood: [9, 9, 9, 10], tnt: [11, 12, 11, 12], nitro: [14, 14, 14, 15] },
  space: { beep: 13, thump: 18, whoosh: 19, wood: [9, 9, 9, 10], tnt: [11, 12, 11, 12], nitro: [14, 14, 14, 15] },
  snow: { beep: 12, thump: 19, whoosh: 17, wood: [9, 9, 9, 10], tnt: [11, 11, 11, 11], nitro: [13, 13, 13, 14] },
  drain: { beep: 13, thump: 22, whoosh: 17, wood: [9, 9, 9, 10], tnt: [11, 12, 13, 12], nitro: [14, 14, 16, 17] },
};
const FRUIT_SFX = 0; // sound 0x1c2 = sample 0 of every bank
const SPACE_FALL_SFX = 20; // sound 0x410, bank 0166
/** the sound ids behind the rand-4 lists above (re/notes/crateCrush.md): some share a sample at a lower pitch (assets/audio/pitch.json) */
const WOOD_IDS = [0x3e8, 0x3e8, 0x3ea, 0x3eb], TNT_IDS = [0x3ec, 0x3ed, 0x3ee, 0x3ef], NITRO_IDS = [0x3f1, 0x3f1, 0x3f3, 0x3f4];
const WEAPON_SOUND = [[0, 0], [27, 0x43b], [28, 0x43c], [26, 0x43a]]; // Drain bank 0164, orb / missiles / ring
const WEAPON_PICKUP_SOUND = [[0, 0], [23, 0x437], [24, 0x438], [25, 0x439]];
const RING_HIT = [32, 0x446];

interface Vis {
  obj: THREE.Group;
  shadow: BlobShadow;
  kind: string;
  frames: THREE.Object3D[];
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
  const items = new Map<number, { obj: THREE.Group; frames: THREE.Object3D[] }>();
  const shots = new Map<number, ShotVis>();
  const weaponIcons = new Map<number, { kind: number; obj: THREE.Object3D }>();
  const ghosts = new Map<number, NonNullable<ReturnType<typeof makeKnockoutGhost>>>();
  const tiles: THREE.Object3D[] = [];
  const tileRims: THREE.Object3D[] = [];
  let arena: THREE.Group | null = null;
  let penguin: { obj: THREE.Group; inst: ReturnType<typeof catalogInstance>; z: THREE.Object3D } | null = null;
  let builtArena = false;
  /** short-lived effect pieces (the game's own blast / smoke / shard / dust meshes) */
  interface Piece { obj: THREE.Object3D; t: number; life: number; v: THREE.Vector3; g: number; s0: number; s1: number; spin: number; fade: boolean; frames?: THREE.Object3D[] }
  const pieces: Piece[] = [];

  // samples are shared between banks on disc, so the file comes from audio/index.json
  let bankIdx: Record<string, { file?: string | null }[]> | null = null;
  const bankIndexReady = fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    bankIdx = {};
    for (const [k, v] of Object.entries<{ samples: { file?: string | null }[] }>(j?.sfx?.banks ?? {})) bankIdx[k] = v.samples;
  }).catch(() => { /* silent */ });
  const sfxSet = () => SFX[variant];
  const playSample = (n: number, vol: number, rate = 1, late = false) => { const f = bankIdx?.[lv.bank]?.[n]?.file; if (f) sfx.playFile(f, vol, late, rate); };
  /** one of a rand-4 list, at that id's own pitch */
  const playPick = (l: number[], ids: number[], vol: number) => { const i = Math.floor(Math.random() * l.length); playSample(l[i], vol, sfxRate(lv.bank, ids[i])); };
  const preloadSfx = () => {
    const sx = SFX[variant];
    if (bankIdx) for (const n of [sx.beep, sx.thump, sx.whoosh, FRUIT_SFX, 1, 2, ...sx.wood, ...sx.tnt, ...sx.nitro]) playSample(n, 0);
    if (variant === 'space') playSample(SPACE_FALL_SFX, 0);
    if (variant === 'drain') for (const [n] of [...WEAPON_SOUND.slice(1), ...WEAPON_PICKUP_SOUND.slice(1), RING_HIT]) playSample(n, 0);
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

  function build() {
    buildArena();
    if (variant === 'snow') {
      const inst = catalogInstance(getCatalog().props.ctPenguin);
      const obj = new THREE.Group();
      if (inst) obj.add(inst.root);
      const z = propClone('ctZ');
      billboards.add(z);
      kit.root.add(obj, z);
      penguin = { obj, inst, z };
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

  function dust(x: number, z: number, n = 1) {
    const f = Array.from({ length: 11 }, (_, i) => `ctDust${i}`);
    for (let i = 0; i < n; i++) piece(f, x + rnd(0.3), 0.2, z + rnd(0.3), { life: 0.45, s0: 1, s1: 1.2, fade: false });
  }

  /** Real crate meshes (0796): animation frames + TNT countdown faces, toggled per frame. */
  function crateObj(kind: string): Vis {
    const obj = new THREE.Group();
    const names = kind === 'tnt' ? [0, 1, 2, 3, 4, 5, 6].map((i) => `ctTnt${i}`) : kind === 'nitro' ? [0, 1, 2, 3, 4, 5, 6].map((i) => `ctNitro${i}`) : kind === 'chest' ? ['ctChest'] : [variant === 'drain' ? 'ctDrainCrate' : 'ctWood'];
    const frames = names.map((n) => { const f = propClone(n); obj.add(f); return f; });
    const count = kind === 'tnt' ? ['ctTnt1', 'ctTnt2', 'ctTnt3'].map((n) => { const f = propClone(n); f.visible = false; obj.add(f); return f; }) : [];
    kit.root.add(obj);
    return { obj, shadow: kit.fx.shadow(0.9, 0.45), kind, frames, count };
  }

  const FRUIT = Array.from({ length: 14 }, (_, i) => `ctFruit${i}`);
  const ITEM: Record<string, string> = { boots: 'ctBoots', potion: 'ctSlow', mask: 'ctMask', weight: 'ctWeight' };
  function weaponIcon(kind: number) {
    if (kind === 0x19) return propClone('ctRocket', 'part10');
    return propClone(kind === 0x1c ? 'ctRing' : 'ctOrb');
  }

  function updateWeaponIcon(slot: number, weapon: number, char: number, x: number, y: number, z: number, tick: number) {
    let icon = weaponIcons.get(slot);
    if (icon?.kind !== weapon) {
      icon?.obj.removeFromParent();
      weaponIcons.delete(slot);
      if (!weapon) return;
      const obj = weaponIcon(weapon === 1 ? 0x1b : weapon === 2 ? 0x19 : 0x1c);
      obj.name = 'weapon-icon';
      kit.root.add(obj);
      icon = { kind: weapon, obj };
      weaponIcons.set(slot, icon);
    }
    // FUN_800bef00 uses the character head marker, with these base heights when the marker is absent.
    const height = (char <= 2 ? 384 : char <= 4 ? 512 : 640) + (weapon === 1 ? 96 : 0);
    icon.obj.position.set(x, y + height * CT_U, z);
    icon.obj.rotation.y = -(tick * 170 % 4096) * Math.PI / 2048;
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

  function playOut() {
    const take = Math.random() < 0.5 ? 0 : 1;
    playSample(1 + take, 0.65, sfxRate(lv.bank, 0x1c3 + take), true);
  }

  function crateEvent(ctx: Parameters<ClientMiniGame['render']>[0], e: GameEvent, audio: boolean) {
    switch (e.k) {
      case 'resultThrowVoice':
        if (audio) charVoice('c', ctx.seats[e.s]?.look.char, 0x10);
        return true;
      case 'smash':
        burst(e.s === 2 ? 'C' : 'W', e.x, e.z, 0);
        if (audio) playPick(sfxSet().wood, WOOD_IDS, 0.5);
        return true;
      case 'beep':
        if (audio) playSample(sfxSet().beep, 0.4);
        return true;
      case 'explode':
        burst(e.s === 1 ? 'N' : 'T', e.x, e.z, Math.max(1, e.v));
        if (audio) {
          kit.shake(0.5);
          if (e.s === 1) playPick(sfxSet().nitro, NITRO_IDS, 0.7);
          else playPick(sfxSet().tnt, TNT_IDS, 0.7);
        }
        return true;
      case 'resultLand':
        dust(e.x, e.z, 2);
        if (audio) charVoice('c', ctx.seats[e.s]?.look.char, 0xd);
        return true;
      case 'resultOut':
        if (audio) playOut();
        return true;
      case 'weaponBlast':
        if (audio && e.o >= 0) playSample(sfxSet().tnt[e.o], 0.65, sfxRate(lv.bank, TNT_IDS[e.o]), true);
        return true;
      default:
        return false;
    }
  }

  return {
    id: 'crateToss',
    async preload() {
      await Promise.all([bankIndexReady, preloadCatalogFor('crateToss', ['ctWood', 'ctFruit0', 'ctPenguin'], [CRATE_GHOST]), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'jungle';
      lv = LEVELS[variant] ?? LEVELS.jungle;
      void bankIndexReady.then(preloadSfx);
      kit = new Kit(ctx, 'crateToss', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      crates.clear(); items.clear(); shots.clear(); weaponIcons.clear(); tiles.length = 0; tileRims.length = 0; pieces.length = 0; billboards.clear(); arena = null; penguin = null; builtArena = false;
      follow = null;
      result = undefined;
      ghosts.clear();
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
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          const playerWorld = result ? w : kit.playerWorld(b.slot);
          const d = playerWorld.data;
          const carriedBody = playerWorld.bodies.find(c => c.cd === b.slot + 1 && ['crate', 'tnt', 'nitro', 'chest'].includes(c.kind));
          seen.add(b.id);
          const a = kit.actor(b, () => ({ inst: createCharacter(kit.look(b.slot), { ring: false }), scale: nativeCharScale(kit.look(b.slot), S), headY: 2.3, shadow: 0.8 }));
          if (result) {
            const state = result.scene.actors.get(b.slot)!;
            if (state.state === 'out') ghost(b, state.outAge);
            a.face = b.face;
            a.update(b, dt, result.actor(b, a.inst, !!carriedBody));
            if (b.fall || !floorAt(d, b.x, b.z)) a.shadow.visible = false;
            if (variant === 'drain') updateWeaponIcon(b.slot, b.alive ? (d.weapon?.[b.slot] ?? 0) : 0, d.char[b.slot], b.x, b.y, b.z, tick);
            continue;
          }
          const held = !!carriedBody;
          const stun = d.stun?.[b.slot] ?? 0;
          const action = d.act?.[b.slot] ?? 0;
          const taunt = d.tauntAt?.[b.slot] ?? -1;
          let role = taunt >= 0 ? 'taunt' : stun > 0 ? 'hit' : action > 0 ? 'action' : undefined;
          let pose: { clip: number; frame: number } | undefined;
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
              const frame = d.jh?.[b.slot] ? 10 * (1 - Math.min(1, vy / 108)) : 10 + 9 * Math.min(1, vy / 100);
              pose = { clip: held ? anims.carryJump : anims.jump, frame };
            } else if (held) {
              role = Math.hypot(b.vx, b.vz) > 0.7 ? 'carryRun' : 'carry';
            }
          }
          // invulnerable after a hit: the game flickers the model (40 ticks)
          const inv = (d.inv?.[b.slot] ?? 0) > 0 && b.alive && !b.fall;
          const character = d.char?.[b.slot] ?? 1;
          const moving = Math.hypot(b.vx, b.vz) > 0.7;
          const deadAge = b.alive ? 0 : kit.poseTick(b.slot) - d.elim[b.slot];
          const script = b.fall ? 7 : !b.alive ? 0x13 : stun ? 9 : action === 1 ? 0xf : action === 2 ? 0x12 : action === 3 ? 10
            : taunt >= 0 ? 2 : held ? (moving ? 0x11 : 0x10) : d.air[b.slot] ? (d.jh[b.slot] ? 6 : 7) : moving ? 5 : 1;
          const frame = !b.alive ? deadAge : action >= 1 && action <= 3 ? ctActionTicks(character, action) - d.stT[b.slot] : taunt >= 0 ? kit.poseTick(b.slot) - taunt : carriedBody ? d.cs?.[carriedBody.id]?.gripFrame : undefined;
          const hidden = !b.alive && (b.fall || deadAge >= poseTicks(0x13, character)) || (inv && (tick & 2) !== 0);
          a.update(b, dt, { hidden, role: b.fall ? 'jump' : b.alive ? role : 'lose', pose,
            script: anims?.carry != null || kit.over.done ? undefined : script, scriptFrame: b.fall ? undefined : frame });
          if (variant === 'space' && (b.fall || !floorAt(d, b.x, b.z))) a.shadow.visible = false;
          if (variant === 'drain') updateWeaponIcon(b.slot, b.alive ? (d.weapon?.[b.slot] ?? 0) : 0, character, b.x, b.y, b.z, kit.poseTick(b.slot));
        } else if (b.kind === 'crate' || b.kind === 'tnt' || b.kind === 'nitro' || b.kind === 'chest') {
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
          const cst = d.cs?.[b.id];
          v.obj.scale.setScalar(cst && cst.s === 0 ? Math.max(0.1, 1 - cst.t / 8) : 1); // grows in for 8 ticks
          const crateState = holderState.cs?.[b.id];
          v.obj.rotation.set(held && !grip ? crateState?.pitch ?? 0 : 0, grip && holder ? holder.face : b.face, 0, 'YXZ');
          const { x, y, z } = v.obj.position;
          v.shadow.set(x, z, held ? y + 0.5 : y);
          if (variant === 'space') v.shadow.visible = y >= 0 && floorAt(d, x, z);
          // frames: the anim cycles one frame per tick; a lit TNT shows its 3-2-1 face instead
          const lit = b.kind === 'tnt' && b.fall;
          const n = v.frames.length, f = n > 1 ? Math.floor(tick / 2 + b.id) % n : 0;
          v.frames.forEach((o, i) => (o.visible = !lit && i === f));
          v.count.forEach((o, i) => (o.visible = lit && i === Math.max(0, Math.min(2, Math.ceil(b.m) - 1))));
        } else if (b.kind === 'fruit' || b.kind === 'boots' || b.kind === 'potion' || b.kind === 'mask' || b.kind === 'weight' || b.kind === 'weapon') {
          seenI.add(b.id);
          let o = items.get(b.id);
          if (!o) { o = itemObj(b.kind, b); items.set(b.id, o); }
          o.obj.position.set(b.x, b.y + (b.kind === 'fruit' ? 0.35 : 0), b.z);
          if (o.frames.length) { const f = Math.floor(tick / 2 + b.id) % o.frames.length; o.frames.forEach((q, i) => (q.visible = i === f)); }
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
          const awake = (d.penguin ?? 0) > 0;
          penguin.obj.position.set(b.x, 0, b.z);
          penguin.obj.rotation.y = b.face;
          penguin.inst?.play(awake ? 'run' : 'idle');
          penguin.inst?.update(dt);
          penguin.z.visible = !awake;
          penguin.z.position.set(b.x + 0.5, 2.2 + ((ctx.time * 0.6) % 1) * 0.8, b.z);
        }
      }
      kit.prune(seen);
      for (const [id, v] of crates) if (!seenC.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); crates.delete(id); }
      for (const [id, o] of items) if (!seenI.has(id)) { kit.root.remove(o.obj); billboards.delete(o.obj); items.delete(id); }
      for (const [id, o] of shots) if (!seenS.has(id)) { removeShot(o); shots.delete(id); }
      if (!result) stepPieces(dt);
      for (const o of billboards) o.quaternion.copy(ctx.camera.quaternion);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      if (crateEvent(ctx, e, true)) return;
      switch (e.k) {
        case 'throw': case 'kick':
          playSample(e.k === 'kick' ? sfxSet().thump : sfxSet().whoosh, 0.45);
          if (e.k === 'kick') spinVoice('c', ctx.seats[e.s]?.look.char);
          if (e.k === 'throw') charVoice('c', ctx.seats[e.s]?.look.char, 0x10, 2); // throw clip 18: `0x8008 block*0x32+0x10` at frame 2-3
          break;
        case 'grab':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xf, 1); // pick-up clip 15: `0x8008 block*0x32+0xf` at frame 1
          break;
        case 'taunt':
          tauntVoice('c', ctx.seats[e.s]?.look.char);
          break;
        case 'bounce': case 'land':
          dust(e.x, e.z, 2);
          break;
        case 'hit':
          kit.actorForSlot(e.s)?.hit(1.2);
          playSample(sfxSet().thump, 0.5);
          if (e.v > 0) hitVoice('c', ctx.seats[e.s]?.look.char); // hurt enter (ovl 0x800bfd..): rand(4) of 0x8009e080
          break;
        case 'hole':
          playSample(SPACE_FALL_SFX, 0.65, sfxRate(lv.bank, 0x410));
          break;
        case 'pickup':
          if (e.v === 1) playSample(FRUIT_SFX, 0.45);
          else if (e.v >= 6 && e.v <= 8) {
            const [n, id] = WEAPON_PICKUP_SOUND[e.v - 5];
            playSample(n, 0.7, sfxRate(lv.bank, id), true);
          }
          break;
        case 'jump':
          dust(e.x, e.z, 1);
          charVoice('c', ctx.seats[e.s]?.look.char, 0xc, 1); // jump anim 6 (FUN_80087fc0): `0x8008 block*0x32+0xc`
          break;
        case 'weapon': {
          const [n, id] = WEAPON_SOUND[e.v] ?? WEAPON_SOUND[0];
          if (id) playSample(n, 0.7, sfxRate(lv.bank, id), true);
          break;
        }
        case 'weaponHit':
          playSample(RING_HIT[0], 0.65, sfxRate(lv.bank, RING_HIT[1]), true);
          break;
        case 'ko':
          if (variant !== 'space' || !kit.playerWorld(e.s).bodies.some((b) => b.kind === 'player' && b.slot === e.s && b.fall)) dust(e.x, e.z, 3);
          break;
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
      for (const shot of shots.values()) removeShot(shot);
      crates.clear(); items.clear(); shots.clear(); weaponIcons.clear(); tiles.length = 0; pieces.length = 0; billboards.clear();
      for (const ghost of ghosts.values()) ghost.dispose();
      ghosts.clear();
      result = undefined;
      kit.dispose();
    },
  };
}
