// POLAR PUSH view (shared/games/pushOff.ts): the four real levels (TILT, POLAR, MELT, MANIC PANIC) as the game builds them
// (level placements 18-21, the platform as its own group so it can tilt and shrink), seen through the engine's fit-all
// camera (mode 1). The sim keeps PS1 axes unmirrored (world z = +PS1 z), so this view mirrors z once on the way in.
import * as THREE from 'three';
import { bearReflectionWord, POLAR_REFLECTION, PolarReflections } from './polarReflection';
import {
  POLAR_INTRO_TICKS, POLAR_PILLARS, PO_RADIUS, U, S_BALL, S_BLAST, S_BURN, S_DASH, S_FOOTWALK, S_FROZEN,
  S_IDLE, S_OFF, S_SLIP, S_STUN, S_THROW, S_WALK, S_WIN, POLAR_DRAW_TICKS, POLAR_WIN_TALLY_TICKS, stepPolarResultMotion, type PoP, type Seal,
} from '../../shared/games/pushOff';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import type { Body, GameEvent, World } from '../../shared/types';
import { createCharacter } from '../characters';
import { ASSET_BASE, charEntry, getCatalog, ModelInstance, type ModelRef } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, VOICE_VOL, voiceBlock, winnerCheerFrame, winnerVoice } from '../shell/voice';
import { arenaClockSprites, hudFace, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import type { ActorParts } from './kit';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import { PO_FULL, PolarAudio, preloadPolarAudio } from './polarAudio';
import { BOMB_RIDER_HIDE_TICK, PolarBombExpiryView } from './polarBombExpiry';
import { PolarFx } from './polarFx';
import { PolarItemEmitter, preloadPolarItemEmitter } from './polarItemEmitter';
import { addTiltScenery } from './polarScenery';
import { applyPose, levelStage, loadPlacements, ps1Pose, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import { RealFx } from './realFx';
import type { ClientMiniGame, RenderWorld } from './types';

const S = 1024 * U; // stage scale: sim raw units are PS1 units
const LEVEL_ID: Record<string, number> = { tilt: 18, polar: 19, melt: 20, manic: 21 };
const LEVEL_MODEL: Record<string, number> = { tilt: 486, polar: 478, melt: 474, manic: 466 };
/** the ice the bears stand on (tilts / shrinks with the sim); everything else is static level */
const PLATFORM: Record<string, string[]> = {
  tilt: ['extra_18e4', 'extra_34e8'],
  polar: ['extra_16b0', 'extra_3a68'],
  melt: ['extra_db54'], // the melting disc is 16 copies of the native wedge (0474 part1), one per sim sector
  manic: ['extra_2338'],
};
const BG: Record<string, number> = { tilt: 0x6f8fb8, polar: 0x05060f, melt: 0x000000, manic: 0x78b4d8 };
const WATER: Record<string, number> = { tilt: -2.4, polar: -3, melt: -4, manic: -3 };
const stageRef = (v: string): ModelRef => ({ model: LEVEL_MODEL[v] ?? 486, scale: S, offset: [0, 0, 0], yaw: 0 });
const placements = new Map<string, Placements | null>();
/** Original graphics by roster identity. Custom riders provide their own catalog variants. */
const POLAR_RIDERS: Record<string, { melt: number; foot: number }> = {
  crash: { melt: 926, foot: 942 }, coco: { melt: 924, foot: 940 }, cortex: { melt: 922, foot: 938 },
  brio: { melt: 916, foot: 932 }, tiny: { melt: 920, foot: 936 }, rilla: { melt: 912, foot: 930 },
  dingodile: { melt: 918, foot: 934 }, koala: { melt: 914, foot: 928 },
};
const riderRef = (model: number): ModelRef => ({ model, scale: S, parts: ['part0'] });
/** Static mesh words in the MELT stage model (FUN_800d14cc). */
const SNOWBALL_PART = ['', 'part3', 'part5', 'part6', 'part4', 'part8', 'part9', 'part7', 'part10'];

// Measured ticks from entry into state 0x58 to the first streamed cheer word.
const BEAR_WIN_LOAD = [0, 13, 12, 16, 14, 13, 13, 13, 15];
const FOOT_WIN_LOAD = [0, 12, 14, 14, 12, 14, 13, 15, 15];

function riderScript(st: number | undefined, onFoot: boolean): number {
  switch (st) {
    case S_DASH: return onFoot ? 0x45 : 0x3e;
    case S_WALK: return 0x3b;
    case S_FOOTWALK: return 0x43;
    case S_OFF: return 0x3f;
    case S_STUN: return onFoot ? 0x3c : 0x44;
    case S_WIN: return onFoot ? 0x47 : 0x46;
    default: return onFoot ? 0x42 : 0x3a;
  }
}

/** FUN_800c358c flip-book groups and frames (L18 RAM 0x800d5498 to 0x800d5584). */
function sealPose(sl: Seal): number {
  if (sl.pose !== undefined) return sl.pose;
  switch (sl.st) {
    case 3: return 0x4000 + Math.max(0, sl.pc - 6);
    case 4: return 0x4013;
    case 1: return 0x4014 + sl.pc;
    case 5: return 0x4080 + sl.pc;
    case 7: return 0x4100 + sl.pc;
    default: return 0x4000;
  }
}

/** Bank 0450 maps IDs 0x46f–0x47a to eight seal and fish samples. */
const SEAL_SAMPLES = [19, 19, 19, 19, 20, 21, 22, 23, 23, 24, 25, 26];
function playSealSound(id: number) {
  const sample = SEAL_SAMPLES[id - 0x46f];
  if (sample !== undefined) sfx.playFile(`sfx/0450/${sample}.mp3`, PO_FULL, false, sfxRate('0450', id));
}
function sealCue(e: GameEvent) {
  if (e.k === 'sealSound') { playSealSound(e.v); return; }
  if (e.k !== 'seal') return;
  switch (e.v) {
    case 2: playSealSound(0x478); break;
    case 3: playSealSound(0x473); break;
    case 1: playSealSound(0x475); playSealSound(0x46f + Math.max(0, e.o)); break;
    case 7: playSealSound(0x474); break;
  }
}
/** Sim world -> view world: mirror z (and facing) so the PS1 stage and camera map exactly. */
function mirrorBody(b: Body): Body { return { ...b, z: -b.z, vz: -b.vz, face: Math.PI - b.face }; }
function mirrorWorld(w: RenderWorld): RenderWorld { return { ...w, bodies: w.bodies.map(mirrorBody) }; }

/** A prop's mesh as a lean template (only the visible part), cloned per use. */
const templates = new Map<string, THREE.Object3D>();
function propClone(name: string): THREE.Object3D {
  let t = templates.get(name);
  if (t === undefined) {
    t = catalogInstance(getCatalog().props[name])?.root;
    if (t) {
      const drop: THREE.Object3D[] = [];
      t.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.visible) drop.push(o); });
      for (const o of drop) o.removeFromParent();
      templates.set(name, t);
    }
  }
  return t ? t.clone() : new THREE.Group();
}

/** Mounted dash script 0x3e: tick of its voice cue n 0x18 per engine character (L18 RAM). Engine 8 also keys n 0x16 at tick 1. */
const DASH_VOICE_FRAME = [0, 15, 14, 30, 30, 23, 12, 16, 16];
/** Mounted win script 0x46: its voice cues [tick, n] and loop length per engine character (0 = the script ends on a held pose). */
const WIN_CUES: { cues: [number, number][]; period: number }[] = [
  { cues: [], period: 0 },
  { cues: [[8, 0x19], [24, 0x18]], period: 40 },
  { cues: [[19, 0x19]], period: 0 },
  { cues: [[2, 0x19], [20, 0x1a], [39, 0x1b]], period: 79 },
  { cues: [[8, 0x19]], period: 0 },
  { cues: [[16, 0x19], [48, 0x18]], period: 61 }, // Tiny's bank has no 0x19: only the second cue sounds
  { cues: [[5, 0x19]], period: 46 },
  { cues: [[1, 0x19], [22, 0x18]], period: 36 },
  { cues: [[4, 0x19]], period: 38 },
];
/** FUN_800ce664: the pose a mounted rider holds from stun tick 32 on, while the bear turns. */
const DAZED_WORD = [0, 0x4100, 0x4000, 0x4100, 0x4080, 0x4000, 0x4000, 0x4000, 0x4000];
/** Object 0x1615 draws a static part of the rider's own bear model (the MELT models keep it under another index). */
/**
 * FUN_800cde8c: a stunned rider's node gets flag 0x400000 and +0x8e = 0x2002 (Brio mounted 0x2001): the animated frames keep
 * their vertices and take static part 1's darker faces (part 0's own for Brio). Idle, item, knock-off, win and the stun's end
 * clear it, a slip does not. The custom riders have no such part: their materials are halved instead.
 */
const stunWord = (ch: number, onFoot: boolean) => (ch === 4 && !onFoot ? 0x2001 : 0x2002);
const darkMaterials = new WeakMap<THREE.Material, THREE.Material>();
function darkMaterial(m: THREE.Material): THREE.Material {
  let dark = darkMaterials.get(m);
  if (!dark) {
    dark = m.clone();
    (dark as THREE.MeshBasicMaterial).color?.multiplyScalar(0.5);
    darkMaterials.set(m, dark);
  }
  return dark;
}
function stunSkin(inst: ModelInstance, word: number | null) {
  const skinned = inst.staticSkin(word);
  const dark = word !== null && !skinned;
  if (!!inst.root.userData.stunDark === dark) return;
  inst.root.userData.stunDark = dark;
  inst.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (dark) {
      mesh.userData.lit = mesh.material;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(darkMaterial) : darkMaterial(mesh.material);
    } else if (mesh.userData.lit) { mesh.material = mesh.userData.lit; delete mesh.userData.lit; }
  });
}
function dashPart(ch: number, melt: boolean): { model: number; part: number } | null {
  if (ch === 7) return melt ? { model: 918, part: 1 } : { model: 950, part: 2 };
  if (ch === 8) return melt ? { model: 914, part: 2 } : { model: 944, part: 2 };
  return null;
}

export function createPushOffView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let platform: THREE.Group;
  let stage: THREE.Group | null = null;
  let emitter: PolarItemEmitter | null = null;
  let bombExpiry: PolarBombExpiryView | null = null;
  const hazards: { bomb: THREE.Object3D; zap: THREE.Object3D; burn: THREE.Object3D }[] = [];
  const snowballs: (ModelInstance | null)[] = [];
  let seal: { obj: THREE.Group; inst: ReturnType<typeof catalogInstance> } | null = null;
  let fish: ModelInstance | null = null;
  let resultWorld: World | null = null;
  let reflections: PolarReflections | undefined;
  let moveScenery: ReturnType<typeof addTiltScenery> | undefined;
  const bolts = new Map<number, THREE.Object3D>();
  /** knocked-off bears (object 0x1611): the MANIC level model's animated part4, clip 0 frames 0-6 then held (script 0x800d569c) */
  const flyBears = new Map<number, { inst: ModelInstance; t: number }>();
  /** tick of the last ledge slip keyed per slot (0x45c also restarts from a snapshot) */
  const slips = new Map<number, number>();
  let audio: PolarAudio | null = null;
  let pfx: PolarFx | null = null;
  /** effect scripts (object 0x1605) drawn through the level's tilt, and the ones without entity flag 0x200000 */
  let tiltFx: RealFx | null = null;
  let worldFx: RealFx | null = null;
  /** the HUD's forced-victory cues 0x194 / 0x195 (bank 0277) */
  const promptSounds = new Map<number, string>();
  const tiltCamera = new THREE.PerspectiveCamera();
  const riders: (PoP | undefined)[] = [];
  const riderTick: number[] = [];
  /** snowball roll (entity +0x1c): speed >> 6 per tick */
  const roll: number[] = [0, 0, 0, 0];
  let variant = 'tilt';
  let voiceAge: number | undefined;
  let resultAt: number | undefined;
  let follow: Ps1Follow | null = null;
  const sectors: ModelInstance[] = [];
  /** POLAR pillars: the placed stage holder of each sim pillar (same PS1 position), hidden once it breaks */
  let pillarObjs: (THREE.Object3D | null)[] = [];

  function buildStage() {
    const R = kit.root;
    if (stage) R.remove(stage);
    if (platform) R.remove(platform);
    const pl = placements.get(variant) ?? null;
    const ref = stageRef(variant);
    const plat = PLATFORM[variant] ?? [];
    const make = (r: ModelRef) => catalogInstance(r)?.root ?? null;
    stage = levelStage(ref, pl, make, { skip: plat }) ?? new THREE.Group();
    moveScenery = variant === 'tilt' ? addTiltScenery(stage, S, make) : undefined;
    R.add(stage);
    pillarObjs = [];
    if (variant === 'polar') {
      const held: THREE.Object3D[] = [];
      stage.traverse((o) => { if (o.userData.ps1) held.push(o); });
      pillarObjs = POLAR_PILLARS.map(([x, z]) => held.find((h) => h.userData.ps1[0] === x && h.userData.ps1[2] === z) ?? null);
    }
    platform = new THREE.Group();
    sectors.length = 0;
    if (variant === 'melt') {
      for (let i = 0; i < 16; i++) {
        const wedge = catalogInstance(getCatalog().props.poMeltSector);
        if (!wedge) break;
        // The native wedge points along PS1 +z. FUN_800c0e94 assigns yaw (i+1)*0x100 to sector i.
        wedge.root.rotation.y = -(i + 1) * Math.PI / 8;
        platform.add(wedge.root);
        sectors.push(wedge);
      }
    } else {
      const ice = pl ? levelStage(ref, { ...pl, objects: pl.objects.filter((o) => plat.includes(o.part)) }, make) : null;
      if (ice) platform.add(ice);
    }
    R.add(platform);
    pfx?.dispose();
    pfx = new PolarFx(R, platform, variant);
    tiltFx?.dispose();
    tiltFx = new RealFx(platform, S);
    worldFx?.dispose();
    worldFx = new RealFx(R, S);
    reflections?.dispose();
    reflections = variant === 'manic' ? undefined : new PolarReflections(platform,
      variant === 'melt' ? { ...ref, parts: ['part2'] } : undefined);
    emitter?.dispose();
    emitter = new PolarItemEmitter(R, variant);
    bombExpiry?.dispose();
    bombExpiry = new PolarBombExpiryView(R);
    for (const { bomb, zap, burn } of hazards) R.remove(bomb, zap, burn);
    hazards.length = 0;
    for (let slot = 0; slot < 4; slot++) {
      const bomb = propClone('poBomb'), zap = propClone('poZap');
      // FUN_800d2248: a burnt rider's entity draws shared mesh 0x202d.
      const burn = variant === 'manic' ? catalogInstance({ model: 403, scale: S, parts: ['part44'] })?.root ?? new THREE.Group() : new THREE.Group();
      bomb.visible = zap.visible = burn.visible = false;
      zap.scale.setScalar(0.5);
      R.add(bomb, zap, burn);
      hazards.push({ bomb, zap, burn });
    }
    for (const snowball of snowballs) if (snowball) R.remove(snowball.root);
    snowballs.length = 0;
    if (variant === 'melt') for (const part of SNOWBALL_PART) {
      const snowball = part ? catalogInstance({ ...ref, parts: [part] }) : null;
      if (snowball) { snowball.root.visible = false; R.add(snowball.root); }
      snowballs.push(snowball);
    }
    seal?.obj.removeFromParent();
    fish?.root.removeFromParent();
    seal = null;
    fish = null;
    if (variant === 'tilt') {
      const ref = getCatalog().props.poSeal;
      const inst = ref ? catalogInstance({ ...ref, parts: ['part0'] }) : null;
      const obj = new THREE.Group();
      if (inst) obj.add(inst.root);
      obj.visible = false;
      obj.scale.setScalar(8000 / 4096);
      platform.add(obj);
      seal = { obj, inst };
      fish = ref ? catalogInstance({ ...ref, parts: ['part1'] }) : null;
      if (fish) {
        fish.root.visible = false;
        fish.root.scale.copy(obj.scale);
        platform.add(fish.root);
      }
      for (const sample of new Set(SEAL_SAMPLES)) sfx.preloadFile(`sfx/0450/${sample}.mp3`);
    }
  }

  function bearParts(slot: number): ActorParts {
    const look = kit.look(slot);
    const character = CHARACTERS[look.char];
    const rider = POLAR_RIDERS[character.id];
    const hasMelt = !!(character && charEntry(character.id)?.variants?.polarMelt);
    const melt = variant === 'melt' && !hasMelt && rider ? catalogInstance(riderRef(rider.melt)) : null;
    const variantKey = variant === 'melt' && hasMelt ? 'polarMelt' : 'polarBear';
    const model = charEntry(character.id)?.variants?.[variantKey];
    const mounted = model && !melt ? catalogInstance({ ...model, scale: S, offset: [0, 0, 0] }) : null;
    const inst = melt ?? mounted ?? createCharacter(look, { variant: variantKey, ring: false });
    const sc = inst.ref?.scale;
    return { inst, shadow: 1.6, scale: sc ? S / sc : 1, headY: 1.5 };
  }

  function footParts(slot: number): ActorParts {
    const look = kit.look(slot);
    const character = CHARACTERS[look.char];
    const rider = POLAR_RIDERS[character.id];
    if (character && charEntry(character.id)?.variants?.polarFoot) {
      const inst = createCharacter(look, { variant: 'polarFoot', ring: false });
      return { inst, shadow: 1, scale: S / (inst.ref?.scale ?? S), headY: 1.1 };
    }
    const native = rider ? catalogInstance(riderRef(rider.foot)) : null;
    const inst = native ?? createCharacter(look, { ring: false });
    return { inst, shadow: 1, scale: native ? 1 : nativeCharScale(look, S), headY: 1.1 };
  }

  /** Sound 0x45c on the rider's handle, `age` ticks in. */
  function playSlip(slot: number, tick: number, age: number) {
    if ((slips.get(slot) ?? -1) >= tick) return;
    slips.set(slot, tick);
    audio?.hold(slot, 0x45c, undefined, 0x1e00, Math.max(0, age) / 30);
  }
  const riderPlace = (slot: number): [number, number, number] | null => {
    const q = riders[slot];
    return q ? [q.x, q.y, q.z] : null;
  };
  /** Script 0x46's voice cues between two ages of the winner's state 0x58. */
  function winCues(char: number, ch: number, from: number, to: number) {
    const { cues, period } = WIN_CUES[ch] ?? WIN_CUES[0];
    for (let k = Math.max(from + 1, to - 3); k <= to; k++) {
      const frame = k - BEAR_WIN_LOAD[ch] + 1;
      for (const [at, n] of cues) if (frame >= at && (period ? (frame - at) % period === 0 : frame === at)) charVoice('b', char, n);
    }
  }

  return {
    id: 'pushOff',
    async preload() {
      const riders = Object.values(POLAR_RIDERS).flatMap(r => [riderRef(r.melt), riderRef(r.foot)]);
      await Promise.all([preloadCatalogFor('pushOff', ['poMeltSector', 'poSeal', 'poSmoke0', 'poBomb', 'poZap'], [POLAR_REFLECTION, ...riders]), preloadPolarItemEmitter(), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'tilt';
      kit = new Kit(ctx, 'pushOff', { bg: BG[variant] ?? 0, hemi: [0xe4f3ff, 0x3a5a7a, 1.6] });
      bolts.clear(); flyBears.clear(); slips.clear();
      riders.length = riderTick.length = 0;
      roll.fill(0);
      audio?.dispose();
      audio = new PolarAudio(variant);
      preloadPolarAudio(variant);
      // samples are shared between banks on disc, so the file comes from audio/index.json
      if (!promptSounds.size) void fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
        for (const id of [0x194, 0x195]) {
          const file = j?.sfx?.banks?.['0277']?.samples?.[id - 0x192]?.file;
          if (file) { promptSounds.set(id, file); sfx.preloadFile(file); }
        }
      }).catch(() => { /* silent */ });
      voiceAge = resultAt = undefined;
      resultWorld = null;
      follow = null;
      buildStage();
      applyPose(ctx.camera, (follow = new Ps1Follow(TRACK_CAMS[LEVEL_ID[variant] ?? 18], stageRef(variant))).step(0, []));
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); buildStage(); } });
    },

    render(ctx, w0, dt) {
      let w = mirrorWorld(w0);
      kit.checkOver(w, false, POLAR_DRAW_TICKS * 1000 / 30);
      const draw = kit.over.done && kit.over.winners.size === 0;
      const winner = kit.over.winners.values().next().value;
      const cheerTick = winner === undefined ? 0 : winnerCheerFrame(kit.look(winner).char);
      if (kit.over.done) resultAt ??= ctx.time;
      else { resultAt = undefined; voiceAge = undefined; }
      const age = resultAt === undefined ? 0 : Math.max(kit.over.frame, (ctx.time - (ctx.resultReplayAt ?? resultAt)) * 30);
      const resultFrame = Math.floor(age + 1e-7);
      const countdownLeft = w.tick === 0 ? ctx.countdownTicksLeft : undefined;
      moveScenery?.(Math.max(0, POLAR_INTRO_TICKS - (countdownLeft ?? 0)) + w.tick + resultFrame);
      if (kit.over.done) {
        resultWorld ??= structuredClone(w0);
        const target = w0.tick + Math.min(resultFrame, draw ? POLAR_DRAW_TICKS : cheerTick + POLAR_WIN_TALLY_TICKS);
        // A reconnect replays the motion immediately and only voices newly reached cues.
        const audibleFrom = resultWorld.tick + 6 < target ? target - 1 : resultWorld.tick;
        while (resultWorld.tick < target) {
          stepPolarResultMotion(resultWorld, winner ?? true, cheerTick);
          if (resultWorld.tick > audibleFrom) {
            for (const e of resultWorld.ev) {
              this.onEvent?.(ctx, e);
            }
          }
        }
        kit.world = w = mirrorWorld(resultWorld);
      } else resultWorld = null;
      const d = w.data;
      const sl: Seal | undefined = d.seal;
      if (kit.over.done && winner !== undefined && d.P[winner]?.st === S_WIN) {
        const age: number = d.P[winner].k;
        if (voiceAge === undefined) {
          voiceAge = age <= 5 ? -1 : age - 1;
          if (voiceAge >= 0) sfx.enterRoundResult('winner');
        }
        if (age > voiceAge) {
          winnerVoice('pushOff', kit.look(winner).char, voiceAge, age);
          if (!((d.foot?.[winner] ?? 0) > 0)) winCues(kit.look(winner).char, d.P[winner].ch, voiceAge, age);
        }
        voiceAge = age;
      }
      const R: number = d.radius ?? PO_RADIUS;
      const k = R / PO_RADIUS;
      // FUN_8001daf8 applies Rx(az) * Rz(-ax) about the ice origin in web coordinates.
      platform.rotation.set(d.tiltRad?.[1] ?? 0, 0, -(d.tiltRad?.[0] ?? 0));
      const pil: [number, number, number][] | undefined = d.pillars;
      if (pil) pillarObjs.forEach((o, i) => { if (o) o.visible = (pil[i]?.[2] ?? 1) !== 0; });
      if (sectors.length) sectors.forEach((wedge, i) => wedge.nativePose(0x4000 + (d.secAnim?.[i] ?? 0) * 128 + (d.secT?.[i] ?? 0)));
      else platform.scale.set(k, 1, k);

      const seen = new Set<number>();
      const seenBolts = new Set<number>();
      const useSnapshotCamera = d.camera && (resultWorld !== null || w.tick > 0);
      const tracked: Tracked[] = [];
      for (const snowball of snowballs) if (snowball) snowball.root.visible = false;
      if (fish) {
        const f = sl?.fish;
        fish.root.visible = !!f;
        if (f) {
          fish.root.position.set(f.x * U, -f.y * U, -f.z * U);
          fish.root.rotation.set(f.pitch * Math.PI / 2048, -f.yaw * Math.PI / 2048, 0);
          fish.nativePose(f.frame < 0 ? 0x2002 : 0x4180 + f.frame);
        }
      }
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          const playerWorld = kit.over.done ? w : kit.playerWorld(b.slot);
          const playerData = playerWorld.data;
          const q: PoP | undefined = playerData.P?.[b.slot];
          riders[b.slot] = q;
          if (q?.st === S_SLIP && q.slipSoundTick !== undefined) playSlip(b.slot, q.slipSoundTick, playerWorld.tick - q.slipSoundTick);
          if (q && playerWorld.tick !== riderTick[b.slot]) { // one update of the objects that watch the rider
            riderTick[b.slot] = playerWorld.tick;
            pfx?.riderTick(b.slot, { st: q.st, af: q.af, x: q.x, y: q.y, z: q.z, yaw: q.yaw, sc: q.sc, md: q.md, ch: q.ch });
            const rolling = q.st === S_BALL || (q.st === S_SLIP && q.pst === S_BALL);
            roll[b.slot] = rolling ? (roll[b.slot] + (Math.floor(Math.hypot(q.vx, q.vz)) >> 6)) & 0xfff : 0;
          }
          const onFoot = (playerData.foot?.[b.slot] ?? 0) > 0;
          const ab = onFoot ? { ...b, id: b.id + 100000 } : b;
          seen.add(ab.id);
          const a = kit.actor(ab, () => (onFoot ? footParts(b.slot) : bearParts(b.slot)));
          const win = q?.st === S_WIN;
          const blast = q?.st === S_BLAST;
          const expiry = blast ? q.bombExpiry : undefined;
          const blastAge = blast ? (expiry ? playerWorld.tick - expiry.tick : q.k) : -1;
          bombExpiry?.render(b.slot, blastAge, expiry ?? q);
          const hanging = q?.st === S_SLIP && !b.fall;
          const holdPose = q?.st === S_THROW || blast || q?.st === S_SLIP;
          const poseState = holdPose ? q.pst : q?.st;
          const hangClip = (q?.st === S_SLIP || (blast && poseState === S_SLIP)) && q.clip === 2 && !q.ac;
          const fidget = !win && (blast ? expiry?.fidget : q?.st === S_IDLE ? playerData.fid?.[b.slot] : 0);
          const loadTicks = (onFoot ? FOOT_WIN_LOAD : BEAR_WIN_LOAD)[q?.ch ?? 0];
          const loadingWin = win && q.k < loadTicks;
          const script = win ? (loadingWin ? (onFoot ? 0x42 : 0x3a) : riderScript(S_WIN, onFoot)) : hangClip ? 0x3d : fidget ? 0x41
            : riderScript(poseState, onFoot);
          const scriptFrame = win ? (loadingWin ? q.k : q.k - loadTicks + 1) : fidget ? fidget : expiry ? expiry.frame
            : q?.st === S_DASH || q?.st === S_STUN ? q.k : Math.max(0, (q?.af ?? 1) - 1);
          const snowball = !win && (q?.st === S_BALL || (q?.st === S_SLIP && q.pst === S_BALL)) ? snowballs[q.ch] : null;
          const frozen = !win && (q?.st === S_FROZEN || (q?.st === S_SLIP && q.pst === S_FROZEN));
          const frozenClip = frozen ? a.inst.ref?.anims?.frozen : undefined;
          const hidden = !b.alive || b.y < WATER[variant] - 0.3 || (!win && blastAge >= BOMB_RIDER_HIDE_TICK) || q?.st === S_BURN;
          // The mounted hang track lowers the rider past the rim by itself.
          const role = win ? 'win' : hanging || q?.st === S_STUN || q?.st === S_OFF ? 'hit' : q?.st === S_DASH ? (onFoot ? 'action' : 'push')
            : q?.st === S_WALK || q?.st === S_FOOTWALK ? 'run' : 'idle';
          if (win) a.face = b.face;
          const dazed = q?.st === S_STUN && !onFoot && q.k >= 32;
          a.update(b, dt, {
            hidden, role, script, scriptFrame, renderWord: dazed ? DAZED_WORD[q.ch] : undefined, keepYaw: win,
            pose: frozenClip == null ? undefined : { clip: frozenClip, frame: 0 },
          });
          const stunned = q?.st === S_STUN || (q?.st === S_SLIP && q.pst === S_STUN);
          stunSkin(a.inst, stunned && !win ? stunWord(q.ch, onFoot) : null);
          pfx?.dashMesh(b.slot, hidden || win ? undefined : q, b.x, b.y, b.z, b.face, q ? dashPart(q.ch, variant === 'melt') : null);
          if (variant === 'tilt' && !hidden) {
            a.holder.position.applyQuaternion(platform.quaternion);
            a.holder.quaternion.copy(platform.quaternion);
            a.shadow.mesh.position.applyQuaternion(platform.quaternion);
            a.shadow.mesh.quaternion.copy(platform.quaternion);
          }
          a.inst.root.visible = !snowball;
          if (frozen && frozenClip == null && !hidden) a.inst.nativePose(q.ch === 7 ? 0x2003 : 0x2002);
          if (snowball && !hidden) {
            snowball.root.visible = true;
            snowball.root.position.copy(a.holder.position);
            snowball.root.rotation.set(roll[b.slot] * Math.PI / 2048, b.face, 0, 'ZYX'); // entity mode 2: it rolls about its own x axis
          }
          if (b.fall || hanging || reflections) a.shadow.visible = false;
          a.holder.scale.setScalar(win ? 1 : playerData.scale?.[b.slot] ?? 1);
          if (reflections && q) {
            reflections.render(b.slot, !hidden && q.st !== S_SLIP, !!snowball,
              b.x, b.y, b.z, b.face, a.holder.scale.x, q.st === S_STUN || q.st === S_FROZEN ? 0x4000 : bearReflectionWord(script, q.ch, scriptFrame, win));
          }
          const { bomb, zap, burn } = hazards[b.slot];
          burn.visible = b.alive && q?.st === S_BURN;
          if (burn.visible) { // the rider's own entity: its place and yaw (0x800 from the hit), rotation order 2
            burn.position.set(b.x, b.y, b.z);
            burn.rotation.set(0, b.face, 0);
          }
          const item = playerData.item?.[b.slot];
          const showItem = !hidden && !b.fall && !win && playerData.c6c === b.slot && (item === 3 || item === 5);
          bomb.visible = showItem && item === 3;
          zap.visible = showItem && item === 5;
          if (showItem) {
            const object = item === 3 ? bomb : zap;
            const height = q?.ch === 1 ? 600 : item === 3 && variant !== 'melt' && (q?.ch === 7 || q?.ch === 8) ? 868 : 768;
            object.position.set(b.x, b.y + height * U, b.z).applyQuaternion(platform.quaternion);
            object.rotation.y = ctx.time * 30 * Math.PI / 16;
          }
          if (!useSnapshotCamera && (draw ? b.alive && b.y >= 0 : !hidden && !b.fall)) tracked.push({ pos: new THREE.Vector3(b.x, b.y, b.z), face: b.face });
        } else if (b.kind === 'seal' && seal && sl) {
          seal.obj.visible = sl.st !== 0 && sl.st !== 2;
          seal.obj.position.set(b.x, b.y, b.z); // y: the jump out of the water (0x400 below the ice at the start)
          seal.obj.rotation.y = b.face;
          seal.inst?.nativePose(sealPose(sl));
        } else if (b.kind === 'flybear') {
          seenBolts.add(b.id);
          let fb = flyBears.get(b.id);
          if (!fb) {
            const inst = new ModelInstance({ model: LEVEL_MODEL.manic, scale: S, parts: ['part4'] });
            if (inst.build()) { inst.root.userData.shared = true; kit.root.add(inst.root); }
            fb = { inst, t: 0 }; flyBears.set(b.id, fb);
          }
          fb.t += dt * 30;
          fb.inst.pose(0, Math.min(6, fb.t));
          fb.inst.root.position.set(b.x, b.y, b.z);
          fb.inst.root.rotation.set(fb.t * Math.PI / 8, b.face, 0, 'YXZ');
          fb.inst.root.visible = fb.t < 31;
        } else if (b.kind === 'bolt') {
          seenBolts.add(b.id);
          const bolt = (d.bolts as { id: number; k: number; st: number; x: number; y: number; z: number }[] | undefined)?.find((bl) => bl.id === b.id);
          let m = bolts.get(b.id);
          // The pickup (0x2018) and projectile (0x201a) are different meshes in the shared prop model.
          if (!m) {
            m = bolt?.k === 1 ? catalogInstance({ model: 403, scale: S, parts: ['part25'] })?.root ?? new THREE.Group() : propClone('poBomb');
            kit.root.add(m);
            bolts.set(b.id, m);
          }
          m.position.set(b.x, b.y, b.z); // y: carried above the head / thrown arc
          m.scale.setScalar(bolt?.k === 0 && bolt.st === 1 ? 0.5 : 1);
          m.rotation.set(bolt?.k === 1 ? ctx.time * 30 * Math.PI / 8 : 0, b.face, 0, 'YXZ');
          // FUN_800b4c74: the thrown bolt and its mark on the ice are hidden for the 31 ticks its blast lasts
          m.visible = !(bolt?.k === 1 && bolt.st === 1);
          if (bolt?.k === 1 && bolt.st === 0) pfx?.boltShadow(b.id, bolt.x, bolt.y, bolt.z);
        }
      }
      kit.prune(seen);
      for (const [id, m] of bolts) if (!seenBolts.has(id)) { kit.root.remove(m); bolts.delete(id); }
      for (const [id, f] of flyBears) if (!seenBolts.has(id)) { kit.root.remove(f.inst.root); flyBears.delete(id); }
      pfx?.endShadows();
      const slots = ctx.seats.map((_, slot) => slot);
      if (!useSnapshotCamera && variant === 'melt' && (!kit.over.done || resultFrame === 0)) {
        const intro = emitter?.introFrame(countdownLeft, slots, d.mTarget ?? 0);
        const [x, z] = intro ? [intro.x, intro.z] : d.meltCamera ?? [d.mx, d.mz];
        tracked.push({ pos: new THREE.Vector3(x * U, x || z ? -256 * U : 0, -z * U), h: 512, f: 512 });
      }
      if (useSnapshotCamera) {
        let [x, y, z] = d.camera;
        if (resultWorld && d.cameraTarget) {
          const [tx, ty, tz] = d.cameraTarget;
          const shift = tz < z ? 4 : 2, fraction = Math.max(0, age - resultFrame);
          x += ((tx - x) >> shift) * fraction;
          y += ((ty - y) >> shift) * fraction;
          z += ((tz - z) >> shift) * fraction;
        }
        const base = TRACK_CAMS[LEVEL_ID[variant] ?? 18];
        applyPose(ctx.camera, ps1Pose({ ...base, x, y, z }, stageRef(variant)));
      } else if (follow) applyPose(ctx.camera, follow.step(dt, tracked, draw));
      if (audio) { // positioned voices pan through the camera of the frame (FUN_8002b210)
        const c = useSnapshotCamera ? { ...TRACK_CAMS[LEVEL_ID[variant] ?? 18], x: d.camera[0], y: d.camera[1], z: d.camera[2] } : follow?.camera;
        audio.camera = c ? { ...c, x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) } : null;
        audio.update();
      }
      pfx?.update(dt, ctx.camera);
      tiltCamera.quaternion.copy(platform.quaternion).invert().multiply(ctx.camera.quaternion);
      tiltFx?.update(dt, tiltCamera);
      worldFx?.update(dt, ctx.camera);
      // FUN_800d257c: after a forced victory the winner's enter hides MELT's mask nodes
      const mask = variant === 'melt' && d.skip ? undefined : w.bodies.find(b => b.kind === 'mask');
      emitter?.render(mask, d, ctx.camera, platform.quaternion, 0,
        countdownLeft, slots);
      kit.fx.update(dt);
    },

    onEvent(ctx, e0) {
      if (!kit) return;
      const e: GameEvent = { ...e0, z: -e0.z };
      const char = e.s >= 0 ? ctx.seats[e.s]?.look.char : undefined;
      // the event's place in disc units (y down)
      const px = e0.x / U, py = -(e0.y ?? 0) / U, pz = e0.z / U;
      if (kit.baseEvent(e)) return;
      emitter?.event(e);
      switch (e.k) {
        case 'seal':
        case 'sealSound': sealCue(e); break;
        case 'voice': { // a voice keyed from code: v = the disc sound id (voice block * 0x32 + n)
          // a bank is in memory only for the characters of the match (the bolt keys Dingodile's id for Koala Kong too)
          const block = Math.floor(e.v / 0x32);
          if (!ctx.seats.some((seat) => seat && voiceBlock(seat.look.char) === block)) break;
          // Cortex's bank holds the on-foot dash voice as n 0x1c; the custom riders record it as n 0x1a like the stock roster
          const n = e.v % 0x32;
          charVoice('b', char, n === 0x1c ? 0x1a : n, 0, VOICE_VOL, e.v);
          break;
        }
        case 'quiet': audio?.release(e.s); break; // entering idle, walk and their on-foot twins frees the rider's handle
        case 'step': // the bear's footfall, one tone per player (0x4a0 while shrunk), on the handle and positioned
          audio?.hold(e.s, e.v ? 0x4a0 : 0x49c + e.s, () => riderPlace(e.s));
          break;
        case 'skid': audio?.hold(e.s, 0x456 + e.v, undefined, 0x1d80 + Math.max(0, e.o)); break;
        case 'thump': audio?.play(0x446 + (Math.max(0, e.o) >> 2)); break;
        case 'snowbump': audio?.play(0x48b); break;
        case 'dash':
          audio?.release(e.s);
          if (e.v === 1 && char != null) { // the mounted dash script 0x3e voices itself; the on-foot one (0x45) has no cue
            const engine = DISC_CHARACTER[char] ?? 1;
            charVoice('b', char, 0x18, DASH_VOICE_FRAME[engine]);
            if (engine === 8) charVoice('b', char, 0x16, 1);
          }
          break;
        case 'stun': // FUN_800cde8c: 0x467 and the shared pack's script 0 at twice the rate, where the rider stood
          audio?.play(0x467);
          tiltFx?.play(403, 0, e.x, e.y ?? 0, e.z, { speed: 2 });
          break;
        case 'dazed': // FUN_800ce664: two wisps beside the head every 24-31 ticks
          for (const side of [0x60, -0x60]) pfx?.puff(px + side, py - 0x180, pz, { rise: 10, fadeIn: 0x100, fadeOut: 0x50, shrink: -0x40 });
          break;
        case 'hang': playSlip(e.s, e.t + 1, 0); break; // state 0x4e: script 0x3d + 0x45c
        case 'climb': audio?.release(e.s); break;
        case 'splash': audio?.play(0x45d); break;
        case 'sfx': { // the forced-victory prompt (FUN_8007d5ec) and its acceptance (FUN_8007d6d0)
          const file = promptSounds.get(e.o);
          if (file) sfx.playFile(file, 1, true, sfxRate('0277', e.o));
          break;
        }
        case 'skipOut': worldFx?.play(403, 5, e.x, e.y ?? 0, e.z); break; // FUN_800b5910: each rider it puts out
        case 'bomb': audio?.play(0x454); break; // bomb or zap handed on
        case 'boom': audio?.play(0x453); break;
        case 'pillar': // FUN_800c0888: 0x46a + rand(3) and three chunks (0x1604)
          audio?.play(0x46a + e.v);
          pfx?.pillar(px, 0, pz, Math.max(0, e.o));
          break;
        case 'burn': // FUN_800d2248 / FUN_800d2334: smoke at the start and on ticks 2 and 4, then the shards
          if (e.v === 0) pfx?.smoke(px + 0x80, py - 0x200, pz);
          else if (e.v === 2) pfx?.smoke(px + 0x80, py - 0x180, pz);
          else { pfx?.smoke(px - 0x80, py - 0x100, pz); pfx?.burst(px, py - 0x100, pz); }
          break;
        case 'puff': // object 0x1612: 1 = the burnt rider's two wisps, 2 = the thrown bolt's trail, 3 = a bear knocked off its feet
          if (e.v === 1) {
            pfx?.puff(px + 0x40, py - 0x40, pz, { rise: 10, fadeIn: 0x400, fadeOut: 0x50, shrink: -0x40 });
            pfx?.puff(px - 0x40, py - 0x40, pz, { rise: 10, fadeIn: 600, fadeOut: 0x50, shrink: -0x40 });
          } else if (e.v === 2) pfx?.puff(px, py, pz, { scale: 0x5dc, fadeIn: 0x400, fadeOut: 200, shrink: 0x10 });
          else pfx?.puff(px, py, pz);
          break;
        case 'boltLand': // FUN_800b4c74: 0x48f on the ice, 0x494 in the water; a landing plays the level's effect script 1
          audio?.play(e.v ? 0x48f : 0x494);
          if (e.o === 1) tiltFx?.play(LEVEL_MODEL.manic, 1, e.x, e.y ?? 0, e.z);
          break;
        case 'strike': pfx?.burst(px, py, pz); break; // the blast's first tick: 17 shards (0x1614)
        case 'bolt': audio?.play(0x3fa); break; // a bolt appears on the ice
        case 'grab': audio?.play(0x48e); break; // a bear takes it
        case 'zapped': // hit by a bolt: 0x490 + rand(4)
          audio?.play(0x490 + (e.v >> 2));
          break;
      }
    },

    /** Real HUD (as Crate Crush): face, orange arrow and the push meter per player, clock in the middle. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      SLOT_X.forEach((x, slot) => {
        const seat = ctx.seats[slot];
        if (!seat) return;
        out.push({ tex: hudFace(seat.look.char), x, y: 10, w: 64, h: 40 });
        const m = Math.max(0, Math.min(1, (resultWorld?.data.meter ?? w.data.meter)?.[slot] ?? 0));
        // FUN_8007ce50: the green quad is gauge >> 2 of the bar's 0x40 HUD units (at most 0x3f), the red one the rest
        const units = Math.min(0x3f, Math.round(m * 0x100) >> 2), g = Math.round(units * 52 / 0x40);
        if (units < 0x3f) out.push({ tex: `${ASSET_BASE}hud/barR.png`, x: x + 16 + g, y: 39, w: 52 - g, h: 6 });
        if (units > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + 16, y: 39, w: g, h: 6 });
        out.push({ tex: hudTex(33), x: x - 8, y: 33, w: 24, h: 18 });
      });
      out.push(...arenaClockSprites('pushOff', w));
      return out;
    },

    hud(w, slot) {
      const p = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
      if (!p || p.fall || !p.alive) return 'OUT';
      return `${Math.round((w.data.meter?.[slot] ?? 0) * 100)}%`;
    },

    dispose() {
      slips.clear();
      audio?.dispose();
      audio = null;
      pfx?.dispose();
      pfx = null;
      tiltFx?.dispose();
      tiltFx = null;
      worldFx?.dispose();
      worldFx = null;
      reflections?.dispose();
      reflections = undefined;
      emitter?.dispose();
      emitter = null;
      bombExpiry?.dispose();
      bombExpiry = null;
      for (const m of bolts.values()) kit.root.remove(m);
      bolts.clear();
      kit.dispose();
    },
  };
}
