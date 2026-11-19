// CRATE CRUSH view (shared/games/crateToss.ts): the real Jungle / Space / Snow / Drain Bash stages, wood / TNT / Nitro crates.
import * as THREE from 'three';
import { CT_FLOOR_N, CT_HALF, CT_HP } from '../../shared/games/crateToss';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, hitVoice, spinVoice } from '../shell/voice';
import { createCharacter } from '../characters';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import type { ClientMiniGame } from './types';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import type { ModelRef } from '../crash';
import { bigClock, HUD, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { CHARACTERS } from '../../shared/look';
import { getGame } from '../../shared/registry';

const H = CT_HALF;
const TILE = (H * 2) / CT_FLOOR_N;
const S = 3.6;

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
/** the sound ids behind the rand-4 lists above (re/notes/crateCrush.md): some share a sample at a lower pitch (assets/audio/pitch.json) */
const WOOD_IDS = [0x3e8, 0x3e8, 0x3ea, 0x3eb], TNT_IDS = [0x3ec, 0x3ed, 0x3ee, 0x3ef], NITRO_IDS = [0x3f1, 0x3f1, 0x3f3, 0x3f4];

interface Vis { obj: THREE.Group; shadow: BlobShadow; kind: string; frames: THREE.Object3D[]; count: THREE.Object3D[] }

/** A prop's mesh as a lean template (only the visible part), cloned per use (shared geometry / materials). */
const templates = new Map<string, THREE.Object3D | null>();
function propClone(name: string): THREE.Object3D {
  let t = templates.get(name);
  if (t === undefined) {
    const inst = catalogInstance(getCatalog().props[name]);
    t = inst ? inst.root : null;
    if (t) {
      const drop: THREE.Object3D[] = [];
      t.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.visible) drop.push(o); });
      for (const o of drop) o.removeFromParent();
    }
    templates.set(name, t);
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
  const shots = new Map<number, THREE.Object3D>();
  /** Space Bash: the placed floor pieces of each grid cell (row-major z*N+x, sim frame) so holes can drop them */
  const tiles: THREE.Object3D[][] = [];
  let arena: THREE.Group | null = null;
  let penguin: { obj: THREE.Group; inst: ReturnType<typeof catalogInstance>; z: THREE.Object3D } | null = null;
  let builtArena = false;
  /** short-lived effect pieces (the game's own blast / smoke / shard / dust meshes) */
  interface Piece { obj: THREE.Object3D; t: number; life: number; v: THREE.Vector3; g: number; s0: number; s1: number; spin: number; fade: boolean; frames?: THREE.Object3D[] }
  const pieces: Piece[] = [];

  // samples are shared between banks on disc, so the file comes from audio/index.json
  let bankIdx: Record<string, { file?: string | null }[]> | null = null;
  void fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    bankIdx = {};
    for (const [k, v] of Object.entries<{ samples: { file?: string | null }[] }>(j?.sfx?.banks ?? {})) bankIdx[k] = v.samples;
    preloadSfx();
  }).catch(() => { /* silent */ });
  const sfxSet = () => SFX[variant];
  const playSample = (n: number, vol: number, rate = 1) => { const f = bankIdx?.[lv.bank]?.[n]?.file; if (f) sfx.playFile(f, vol, false, rate); };
  /** one of a rand-4 list, at that id's own pitch */
  const playPick = (l: number[], ids: number[], vol: number) => { const i = Math.floor(Math.random() * l.length); playSample(l[i], vol, sfxRate(lv.bank, ids[i])); };
  const preloadSfx = () => {
    const sx = SFX[variant];
    if (bankIdx) for (const n of [sx.beep, sx.thump, sx.whoosh, FRUIT_SFX, ...sx.wood, ...sx.tnt, ...sx.nitro]) playSample(n, 0);
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
    if (variant === 'space') { // each 512-raw cell carries two placed pieces; holes drop both
      tiles.length = 0;
      for (const pg of lvl.children) for (const h of pg.children) {
        const e = h.matrix.elements, x = e[12], z = e[14];
        if (Math.abs(e[13]) > 0.05 || Math.abs(x) > H || Math.abs(z) > H) continue;
        const c = Math.floor((x + H) / TILE), r = Math.floor((z + H) / TILE);
        (tiles[r * CT_FLOOR_N + c] ??= []).push(h);
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
  const WEAPON = ['ctOrb', 'ctOrb', 'ctRocket', 'ctRing'];
  function itemObj(kind: string, b: { slot: number }): { obj: THREE.Group; frames: THREE.Object3D[] } {
    const obj = new THREE.Group();
    let frames: THREE.Object3D[] = [];
    if (kind === 'fruit') {
      frames = FRUIT.map((n) => { const f = propClone(n); obj.add(f); return f; });
      billboards.add(obj);
    } else obj.add(propClone(kind === 'weapon' ? WEAPON[b.slot] ?? 'ctOrb' : ITEM[kind] ?? 'ctGem'));
    kit.root.add(obj);
    return { obj, frames };
  }

  function shotObj(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    g.add(propClone(kind === 'orb' ? 'ctOrb' : kind === 'ring' ? 'ctRing' : 'ctRocket'));
    kit.root.add(g);
    return g;
  }

  // camera mode 1: the engine's fit-everyone camera on the living players (bit-exact port, see ps1cam)
  let follow: Ps1Follow | null = null;
  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0], dt = 0, w?: Parameters<ClientMiniGame['render']>[1]) {
    follow ??= new Ps1Follow(TRACK_CAMS[LEVEL_ID[variant] ?? 0], simRef(variant));
    const tracked: Tracked[] = [];
    for (const b of w?.bodies ?? []) if (b.kind === 'player' && b.alive) tracked.push({ pos: new THREE.Vector3(b.x, b.y, b.z), face: b.face });
    applyPose(ctx.camera, follow.step(dt, tracked));
    const c = ctx.camera;
    if (c.far < 400) { c.near = 0.5; c.far = 600; c.updateProjectionMatrix(); }
  }

  return {
    id: 'crateToss',
    async preload() {
      await Promise.all([preloadCatalogFor('crateToss', ['ctWood', 'ctFruit0', 'ctPenguin']), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'jungle';
      lv = LEVELS[variant] ?? LEVELS.jungle;
      preloadSfx();
      kit = new Kit(ctx, 'crateToss', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      crates.clear(); items.clear(); shots.clear(); tiles.length = 0; pieces.length = 0; billboards.clear(); arena = null; penguin = null; builtArena = false;
      follow = null;
      build();
      setCamera(ctx, 0, world);
      if (!loaded) this.preload!().then(() => { buildArena(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      setCamera(ctx, dt, w);
      const d = w.data;
      const seen = new Set<number>();
      const seenC = new Set<number>();
      const seenI = new Set<number>();
      const seenS = new Set<number>();
      if (variant === 'space' && d.floor?.length) {
        for (let i = 0; i < tiles.length; i++) for (const t of tiles[i] ?? []) t.visible = d.floor[i] === 1;
      }
      const tick = Math.floor(ctx.time * 30);
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => ({ inst: createCharacter(kit.look(b.slot), { ring: false }), scale: nativeCharScale(kit.look(b.slot), S), headY: 2.3, shadow: 0.8 }));
          const stun = d.stun?.[b.slot] ?? 0;
          const action = d.act?.[b.slot] ?? 0;
          let role = stun > 0 ? 'hit' : action > 0 ? 'action' : undefined;
          if (!stun && a.inst.ref?.anims?.carry != null) {
            if (action === 1) role = 'lift';
            else if (action === 2) role = 'throw';
            else if (w.bodies.some((c) => c.cd === b.slot + 1 && ['crate', 'tnt', 'nitro', 'chest'].includes(c.kind))) {
              role = Math.hypot(b.vx, b.vz) > 0.7 ? 'carryRun' : 'carry';
            }
          }
          // invulnerable after a hit: the game flickers the model (40 ticks)
          const inv = (d.inv?.[b.slot] ?? 0) > 0 && b.alive;
          a.update(b, dt, { hidden: (!b.alive && !b.fall) || (inv && (tick & 2) !== 0), tumble: b.fall ? true : undefined, role: kit.over.done ? undefined : role });
          if (b.fall) a.holder.scale.multiplyScalar(0.96);
        } else if (b.kind === 'crate' || b.kind === 'tnt' || b.kind === 'nitro' || b.kind === 'chest') {
          seenC.add(b.id);
          let v = crates.get(b.id);
          if (!v) { v = crateObj(b.kind); crates.set(b.id, v); }
          const held = b.cd > 0;
          v.obj.position.set(b.x, b.y, b.z);
          if (held && kit.actorForSlot(b.cd - 1)?.inst.ref?.anims?.carry != null) {
            v.obj.position.x += Math.sin(b.face) * 0.86;
            v.obj.position.z += Math.cos(b.face) * 0.86;
          }
          const cst = d.cs?.[b.id];
          v.obj.scale.setScalar(cst && cst.s === 0 ? Math.max(0.1, 1 - cst.t / 8) : 1); // grows in for 8 ticks
          v.obj.rotation.y = b.face;
          v.shadow.set(b.x, b.z, held ? b.y + 0.5 : b.y);
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
        } else if (b.kind === 'orb' || b.kind === 'rocket' || b.kind === 'ring') {
          seenS.add(b.id);
          let o = shots.get(b.id);
          if (!o) { o = shotObj(b.kind); shots.set(b.id, o); }
          o.position.set(b.x, b.y, b.z);
          o.rotation.y = Math.atan2(b.vx, b.vz);
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
      for (const [id, o] of shots) if (!seenS.has(id)) { kit.root.remove(o); shots.delete(id); }
      stepPieces(dt);
      for (const o of billboards) o.quaternion.copy(ctx.camera.quaternion);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'throw': case 'kick':
          playSample(e.k === 'kick' ? sfxSet().thump : sfxSet().whoosh, 0.45);
          if (e.k === 'kick') spinVoice('c', ctx.seats[e.s]?.look.char);
          if (e.k === 'throw') charVoice('c', ctx.seats[e.s]?.look.char, 0x10, 2); // throw clip 18: `0x8008 block*0x32+0x10` at frame 2-3
          break;
        case 'grab':
          charVoice('c', ctx.seats[e.s]?.look.char, 0xf, 1); // pick-up clip 15: `0x8008 block*0x32+0xf` at frame 1
          break;
        case 'bounce': case 'land':
          dust(e.x, e.z, 2);
          break;
        case 'hit':
          kit.actorForSlot(e.s)?.hit(1.2);
          playSample(sfxSet().thump, 0.5);
          if (e.v > 0) hitVoice('c', ctx.seats[e.s]?.look.char); // hurt enter (ovl 0x800bfd..): rand(4) of 0x8009e080
          break;
        case 'smash':
          burst(e.s === 2 ? 'C' : 'W', e.x, e.z, 0);
          playPick(sfxSet().wood, WOOD_IDS, 0.5);
          break;
        case 'beep':
          playSample(sfxSet().beep, 0.4);
          break;
        case 'explode':
          burst(e.s === 1 ? 'N' : 'T', e.x, e.z, Math.max(1, e.v));
          kit.shake(0.5);
          if (e.s === 1) playPick(sfxSet().nitro, NITRO_IDS, 0.7); else playPick(sfxSet().tnt, TNT_IDS, 0.7);
          break;
        case 'hole':
          dust(e.x, e.z, 3);
          break;
        case 'pickup':
          if (e.v === 1) playSample(FRUIT_SFX, 0.45);
          break;
        case 'jump':
          dust(e.x, e.z, 1);
          charVoice('c', ctx.seats[e.s]?.look.char, 0xc, 1); // jump anim 6 (FUN_80087fc0): `0x8008 block*0x32+0xc`
          break;
        case 'weaponHit':
          burst('N', e.x, e.z, 0);
          break;
        case 'ko':
          dust(e.x, e.z, 3);
          break;
      }
    },

    /** Real HUD: face, wumpa icon and health bar per player (52 px = 20 HP), clock in the middle. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      SLOT_X.forEach((x, slot) => {
        const seat = ctx.seats[slot];
        if (!seat) return;
        const id = CHARACTERS[seat.look.char % CHARACTERS.length].id;
        out.push({ tex: hudTex(HUD.face[id] ?? 3), x, y: 10, w: 64, h: 40 });
        const hp = Math.max(0, Math.min(CT_HP, w.data.hp?.[slot] ?? 0));
        const g = Math.round((52 * hp) / CT_HP);
        out.push({ tex: `${ASSET_BASE}hud/barR.png`, x: x + 16, y: 47 - 8, w: 52, h: 6 });
        if (g > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + 16, y: 47 - 8, w: g, h: 6 });
        out.push({ tex: `${ASSET_BASE}textures/0735/tex000.png`, x: x - 8, y: 33, w: 26, h: 20 });
      });
      const left = (getGame('crateToss')?.maxTime ?? 90) - w.time;
      out.push(...bigClock(left, Math.floor(w.time * 2) % 2 === 1));
      return out;
    },

    hud(w, slot) {
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'player' && b.slot === slot && b.alive);
      const wp = (w.data.weapon?.[slot] ?? 0) > 0 ? ` · ${['', 'ORB', 'MISSILES', 'RING'][w.data.weapon[slot]]} x${w.data.ammo[slot]}` : '';
      return alive ? `${hp}/${CT_HP} HP${wp}` : 'OUT';
    },

    dispose() {
      crates.clear(); items.clear(); shots.clear(); tiles.length = 0; pieces.length = 0; billboards.clear();
      kit.dispose();
    },
  };
}
