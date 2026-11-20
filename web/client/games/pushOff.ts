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
import { charVoice, hitVoice, winnerCheerFrame, winnerVoice } from '../shell/voice';
import { arenaClockSprites, hudFace, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import type { ActorParts } from './kit';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import { BOMB_RIDER_HIDE_TICK, PolarBombExpiryView } from './polarBombExpiry';
import { PolarItemEmitter, preloadPolarItemEmitter } from './polarItemEmitter';
import { addTiltScenery } from './polarScenery';
import { applyPose, levelStage, loadPlacements, ps1Pose, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
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

/**
 * Real sound table (re/notes/polarPush.md): the code plays sound ids; table 0x80064508 gives slot/program/tone, the level bank (slot 1) maps
 * that to a sample. Resolved to files here (the index aliases duplicate samples to earlier banks).
 */
const SND = {
  /** 0x446-0x449: collision thump (only TILT PANIC's bank has these tones). */
  thump: { tilt: ['sfx/0164/32.mp3', 'sfx/0164/33.mp3', 'sfx/0164/32.mp3', 'sfx/0164/33.mp3'], polar: [], melt: [], manic: [] } as Record<string, string[]>,
  /** 0x456-0x45b: skid when going idle at speed > 32. */
  skid: {
    tilt: ['sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/0.mp3', 'sfx/0446/1.mp3'],
    polar: ['sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/2.mp3', 'sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/2.mp3'],
    melt: ['sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/2.mp3', 'sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/2.mp3'],
    manic: ['sfx/0446/0.mp3', 'sfx/0446/1.mp3', 'sfx/0446/2.mp3', 'sfx/0447/13.mp3', 'sfx/0446/0.mp3', 'sfx/0446/1.mp3'],
  } as Record<string, string[]>,
  slip: 'sfx/0446/3.mp3', // 0x45c: slipping over the edge
  boom: 'sfx/0447/7.mp3', // 0x453: weight spawned at fuse expiry
  pass: 'sfx/0447/8.mp3', // 0x454: bomb or zap handed on
  splash: 'sfx/0446/4.mp3', // 0x45d on entry to state 0x50
  /** MANIC PANIC bolt (bank 0447): 0x3fa appears, 0x48e taken, 0x48f lands / explodes, 0x490-0x493 hits a bear */
  boltSpawn: 'sfx/0158/9.mp3', boltGrab: 'sfx/0158/48.mp3', boltLand: 'sfx/0159/48.mp3', boltHit: 'sfx/0447/23.mp3',
};
/** Bank 0450 maps IDs 0x46f–0x47a to eight seal and fish samples. */
const SEAL_SAMPLES = [19, 19, 19, 19, 20, 21, 22, 23, 23, 24, 25, 26];
function playSealSound(id: number) {
  const sample = SEAL_SAMPLES[id - 0x46f];
  if (sample !== undefined) sfx.playFile(`sfx/0450/${sample}.mp3`, 0.8, false, sfxRate('0450', id));
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
/** Level banks have separate tone and pitch tables. */
const PO_BANK: Record<string, string> = { tilt: '0450', polar: '0451', melt: '0448', manic: '0447' };

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

/** Frame of the dash voice in each character's dash script (L18 RAM), by disc character. */
const DASH_VOICE_FRAME = [0, 15, 14, 30, 30, 23, 12, 16, 16];

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
  const splashed = new Set<number>();
  const slips = new Map<number, { tick: number; stop: () => void }>();
  let variant = 'tilt';
  let voiceAge: number | undefined;
  let resultAt: number | undefined;
  let follow: Ps1Follow | null = null;
  interface Piece { obj: THREE.Object3D; t: number; life: number; v: THREE.Vector3; g: number; frames?: THREE.Object3D[] }
  const pieces: Piece[] = [];
  const billboards = new Set<THREE.Object3D>();
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
      // FUN_800d2248: a burnt rider becomes flat shared mesh 0x202d.
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

  function piece(names: string[], x: number, y: number, z: number, life: number, v = new THREE.Vector3(), g = 0, bill = true) {
    const obj = new THREE.Group();
    const frames = names.map((n) => { const f = propClone(n); obj.add(f); return f; });
    frames.forEach((f, i) => (f.visible = i === 0));
    obj.position.set(x, y, z);
    if (bill) billboards.add(obj);
    kit.root.add(obj);
    pieces.push({ obj, t: 0, life, v, g, frames: frames.length > 1 ? frames : undefined });
  }
  const SMOKE = Array.from({ length: 16 }, (_, i) => `poSmoke${i}`);
  const smoke = (x: number, y: number, z: number) => piece(SMOKE, x, y, z, 0.55);
  function chunks(x: number, y: number, z: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2.5;
      piece([`poChunk${i % 9}`], x, y, z, 0.9, new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 3, Math.sin(a) * sp), 12, false);
    }
  }
  function stepPieces(dt: number) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      p.t += dt;
      p.v.y -= p.g * dt;
      p.obj.position.addScaledVector(p.v, dt);
      if (p.g) p.obj.rotation.x += dt * 6;
      if (p.frames) { const f = Math.min(p.frames.length - 1, Math.floor((p.t / p.life) * p.frames.length)); p.frames.forEach((o, j) => (o.visible = j === f)); }
      if (p.t >= p.life) { kit.root.remove(p.obj); billboards.delete(p.obj); pieces.splice(i, 1); }
    }
  }

  function playSlip(slot: number, tick: number, age: number) {
    const existing = slips.get(slot);
    if (existing && existing.tick >= tick) return;
    existing?.stop();
    const rate = sfxRate(PO_BANK[variant], 0x45c);
    const voice = sfx.startSample(SND.slip, null, 0.6, rate, Math.max(0, age) * rate / 30);
    if (voice) slips.set(slot, { tick, stop: voice.stop });
  }

  return {
    id: 'pushOff',
    async preload() {
      sfx.preloadFile(SND.slip);
      sfx.preloadFile(SND.splash);
      const riders = Object.values(POLAR_RIDERS).flatMap(r => [riderRef(r.melt), riderRef(r.foot)]);
      await Promise.all([preloadCatalogFor('pushOff', ['poMeltSector', 'poSeal', 'poSmoke0', 'poBomb', 'poZap'], [POLAR_REFLECTION, ...riders]), preloadPolarItemEmitter(), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'tilt';
      kit = new Kit(ctx, 'pushOff', { bg: BG[variant] ?? 0, hemi: [0xe4f3ff, 0x3a5a7a, 1.6] });
      splashed.clear(); bolts.clear(); flyBears.clear(); pieces.length = 0; billboards.clear();
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
        if (age > voiceAge) winnerVoice('pushOff', kit.look(winner).char, voiceAge, age);
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
          if (q?.st === S_SLIP && q.slipSoundTick !== undefined) {
            playSlip(b.slot, q.slipSoundTick, playerWorld.tick - q.slipSoundTick);
          } else if (q?.st === S_IDLE && q.pst === S_SLIP) {
            slips.get(b.slot)?.stop();
            slips.delete(b.slot);
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
          if (b.fall && b.y < WATER[variant] + 0.4 && !splashed.has(b.id)) {
            splashed.add(b.id);
            smoke(b.x, WATER[variant] + 0.3, b.z);
          }
          if (win) a.face = b.face;
          a.update(b, dt, {
            hidden, role, script, scriptFrame, keepYaw: win, pose: frozenClip == null ? undefined : { clip: frozenClip, frame: 0 },
          });
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
            snowball.root.rotation.y = b.face;
          }
          if (b.fall || hanging || reflections) a.shadow.visible = false;
          a.holder.scale.setScalar(win ? 1 : playerData.scale?.[b.slot] ?? 1);
          if (reflections && q) {
            reflections.render(b.slot, !hidden && q.st !== S_SLIP, !!snowball,
              b.x, b.y, b.z, b.face, a.holder.scale.x, bearReflectionWord(script, q.ch, scriptFrame, win));
          }
          const { bomb, zap, burn } = hazards[b.slot];
          burn.visible = b.alive && q?.st === S_BURN;
          if (burn.visible) burn.position.set(b.x, 0.01, b.z);
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
          const bolt = (d.bolts as { id: number; k: number; st: number }[] | undefined)?.find((bl) => bl.id === b.id);
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
        }
      }
      kit.prune(seen);
      for (const [id, m] of bolts) if (!seenBolts.has(id)) { kit.root.remove(m); bolts.delete(id); }
      for (const [id, f] of flyBears) if (!seenBolts.has(id)) { kit.root.remove(f.inst.root); flyBears.delete(id); }
      stepPieces(dt);
      for (const o of billboards) o.quaternion.copy(ctx.camera.quaternion);
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
      emitter?.render(w.bodies.find(b => b.kind === 'mask'), d, ctx.camera, platform.quaternion, 0,
        countdownLeft, slots);
      kit.fx.update(dt);
    },

    onEvent(ctx, e0) {
      if (!kit) return;
      const e: GameEvent = { ...e0, z: -e0.z };
      if (e.k === 'dash' && e.v === 1) { // Mounted dash clip 0x3e is voiced. On-foot dash 0x45 is silent.
        const c = ctx.seats[e.s]?.look.char;
        if (c != null) {
          const engine = DISC_CHARACTER[c] ?? 1;
          charVoice('b', c, 0x18, DASH_VOICE_FRAME[engine]);
          if (engine === 8) charVoice('b', c, 0x16, 1);
        }
      }
      if (kit.baseEvent(e)) return;
      emitter?.event(e);
      switch (e.k) {
        case 'seal':
        case 'sealSound': sealCue(e); break;
        case 'thump': { // 0x446-0x449 (TILT PANIC bank only)
          const l = SND.thump[variant] ?? [], i = Math.floor(Math.random() * l.length), f = l[i], rate = sfxRate(PO_BANK[variant], 0x446 + i);
          if (f) sfx.playFile(f, 0.6, false, rate);
          break;
        }
        case 'hit': // collision at speed^2 > 0x1000: hit voice rand(4) of 0x8009e080 (the sim's ri(w, 4))
          kit.actorForSlot(e.s)?.hit(e.v);
          hitVoice('b', ctx.seats[e.s]?.look.char);
          break;
        case 'skid': { // entering idle at speed > 32
          const l = SND.skid[variant] ?? [], i = e.v, f = l[i], rate = sfxRate(PO_BANK[variant], 0x456 + i);
          if (f) sfx.playFile(f, 0.45, false, rate);
          break;
        }
        case 'hang': // state 0x4e: anim 0x3d + sfx 0x45c
          playSlip(e.s, e.t + 1, 0);
          break;
        case 'climb':
          slips.get(e.s)?.stop();
          slips.delete(e.s);
          break;
        case 'splash':
          sfx.playFile(SND.splash, 0.65, false, sfxRate(PO_BANK[variant], 0x45d));
          break;
        case 'bomb': // bomb handed on (0x454)
          sfx.playFile(SND.pass, 0.7);
          break;
        case 'boom':
          sfx.playFile(SND.boom, 0.8);
          break;
        case 'melt':
          chunks(e.x, 0.3, e.z, 6);
          break;
        case 'pillar':
          sfx.playFile(`sfx/0451/${20 + e.v}.mp3`, 0.7, false, sfxRate('0451', 0x46a + e.v));
          chunks(e.x, 0.8, e.z, 3);
          break;
        case 'strike': // the thrown bolt lands / explodes (0x48f)
          sfx.playFile(SND.boltLand, 0.7);
          smoke(e.x, 0.6, e.z);
          kit.shake(0.4);
          break;
        case 'bolt': sfx.playFile(SND.boltSpawn, 0.5); break; // a bolt appears on the ice (0x3fa)
        case 'grab': sfx.playFile(SND.boltGrab, 0.6); break; // a bear takes it (0x48e)
        case 'zapped': // hit by a bolt (0x490-0x493): v 1 = knocked off the bear, 2 = out
          sfx.playFile(SND.boltHit, 0.8);
          kit.actorForSlot(e.s)?.hit(1.5);
          break;
      }
      void ctx;
    },

    /** Real HUD (as Crate Crush): face, orange arrow and the push meter per player, clock in the middle. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      SLOT_X.forEach((x, slot) => {
        const seat = ctx.seats[slot];
        if (!seat) return;
        out.push({ tex: hudFace(seat.look.char), x, y: 10, w: 64, h: 40 });
        const m = Math.max(0, Math.min(1, (resultWorld?.data.meter ?? w.data.meter)?.[slot] ?? 0));
        const g = Math.round(52 * m);
        out.push({ tex: `${ASSET_BASE}hud/barR.png`, x: x + 16, y: 39, w: 52, h: 6 });
        if (g > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + 16, y: 39, w: g, h: 6 });
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
      for (const voice of slips.values()) voice.stop();
      slips.clear();
      reflections?.dispose();
      reflections = undefined;
      emitter?.dispose();
      emitter = null;
      bombExpiry?.dispose();
      bombExpiry = null;
      for (const m of bolts.values()) kit.root.remove(m);
      bolts.clear(); splashed.clear(); pieces.length = 0; billboards.clear();
      kit.dispose();
    },
  };
}
