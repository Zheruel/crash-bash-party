// POLAR PUSH view (shared/games/pushOff.ts): the four real levels (TILT, POLAR, MELT, MANIC PANIC) as the game builds them
// (level placements 18-21, the platform as its own group so it can tilt and shrink), seen through the engine's fit-all
// camera (mode 1). The sim keeps PS1 axes unmirrored (world z = +PS1 z), so this view mirrors z once on the way in.
import * as THREE from 'three';
import { POLAR_PILLARS, PO_RADIUS, U } from '../../shared/games/pushOff';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { getGame } from '../../shared/registry';
import type { Body, GameEvent } from '../../shared/types';
import { createCharacter } from '../characters';
import { ASSET_BASE, getCatalog, ModelInstance, type ModelRef } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, hitVoice } from '../shell/voice';
import { bigClock, HUD, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import type { ActorParts } from './kit';
import { catalogInstance, Kit, nativeCharScale, preloadCatalogFor } from './kit';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import type { ClientMiniGame, RenderWorld } from './types';

/** idle fidget scripts by engine character (FUN_800bcc9c): clip, frame sequence, loops (0x8000) or holds (0x8001) */
const seq = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const FIDGET: Record<number, { clip: number; frames: number[]; loop: boolean }> = {
  1: { clip: 4, frames: seq(0, 19), loop: true },
  2: { clip: 5, frames: seq(0, 8), loop: false },
  3: { clip: 5, frames: [...seq(0, 8), ...Array(13).fill(8), ...seq(9, 19)], loop: true },
  4: { clip: 5, frames: seq(0, 2), loop: false },
  7: { clip: 3, frames: seq(0, 19), loop: true },
};
const fidT: (number | undefined)[] = [];

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
  mask: 'sfx/0447/0.mp3', // 0x44c: mask appears / sector melts
  shrink: 'sfx/0447/2.mp3', // 0x44e
  freeze: 'sfx/0447/4.mp3', // 0x450
  bomb: 'sfx/0165/17.mp3', // 0x451
  boom: 'sfx/0165/20.mp3', // 0x452 (also used for the blast, est.)
  pass: 'sfx/0165/22.mp3', // 0x454: bomb handed on
  splash: 'sfx/0165/20.mp3',
  /** MANIC PANIC bolt (bank 0447): 0x3fa appears, 0x48e taken, 0x48f lands / explodes, 0x490-0x493 hits a bear */
  boltSpawn: 'sfx/0158/9.mp3', boltGrab: 'sfx/0158/48.mp3', boltLand: 'sfx/0159/48.mp3', boltHit: 'sfx/0447/23.mp3',
};
/** each level's id bank (the id -> tone table, and so the pitches, differ per level) */
const PO_BANK: Record<string, string> = { tilt: '0450', polar: '0451', melt: '0448', manic: '0447' };
const pick = <T,>(a: T[]): T | undefined => (a.length ? a[Math.floor(Math.random() * a.length)] : undefined);

/** Sim world -> view world: mirror z (and facing) so the PS1 stage and camera map exactly. */
function mirrorBody(b: Body): Body { return { ...b, z: -b.z, vz: -b.vz, face: Math.PI - b.face }; }
function mirrorWorld(w: RenderWorld): RenderWorld { return { ...w, bodies: w.bodies.map(mirrorBody) }; }

/** A prop's mesh as a lean template (only the visible part), cloned per use. */
const templates = new Map<string, THREE.Object3D | null>();
function propClone(name: string): THREE.Object3D {
  let t = templates.get(name);
  if (t === undefined) {
    const inst = catalogInstance(getCatalog().props[name]);
    t = inst ? inst.root : null;
    if (t) { const drop: THREE.Object3D[] = []; t.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.visible) drop.push(o); }); for (const o of drop) o.removeFromParent(); }
    templates.set(name, t);
  }
  return t ? t.clone() : new THREE.Group();
}

/** frame of the dash voice in each character's dash script (L18 RAM), per CHARACTERS index */
const DASH_VOICE_FRAME = [16, 15, 24, 17, 31, 31, 17, 13];

export function createPushOffView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let platform: THREE.Group;
  let stage: THREE.Group | null = null;
  let drone: THREE.Object3D;
  let beam: THREE.Object3D;
  let seal: { obj: THREE.Group; inst: ReturnType<typeof catalogInstance> } | null = null;
  const bolts = new Map<number, THREE.Group>();
  /** knocked-off bears (object 0x1611): the MANIC level model's animated part4, clip 0 frames 0-6 then held (script 0x800d569c) */
  const flyBears = new Map<number, { inst: ModelInstance; t: number }>();
  const splashed = new Set<number>();
  let variant = 'tilt';
  let tilt: [number, number] = [0, 0];
  const up = new THREE.Vector3(0, 1, 0);
  let follow: Ps1Follow | null = null;
  interface Piece { obj: THREE.Object3D; t: number; life: number; v: THREE.Vector3; g: number; frames?: THREE.Object3D[] }
  const pieces: Piece[] = [];
  const billboards = new Set<THREE.Object3D>();
  const sectors: THREE.Object3D[] = [];
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
      // sector i spans angles i*256 + 0x7d .. (sectorOf): the wedge points along PS1 +z, so it turns by -(centre angle)
      for (let i = 0; i < 16; i++) {
        const w = propClone('poMeltSector');
        w.rotation.y = (-(i * 256 + 0x7d + 128) * Math.PI * 2) / 4096;
        platform.add(w);
        sectors.push(w);
      }
    } else {
      const ice = pl ? levelStage(ref, { ...pl, objects: pl.objects.filter((o) => plat.includes(o.part)) }, make) : null;
      if (ice) platform.add(ice);
    }
    R.add(platform);
    drone = propClone('poDrone');
    drone.visible = false;
    beam = propClone('poBeam');
    beam.visible = false;
    R.add(drone, beam);
    seal = null;
    if (variant === 'tilt') {
      const inst = catalogInstance(getCatalog().props.poSeal);
      const obj = new THREE.Group();
      if (inst) obj.add(inst.root);
      obj.visible = false;
      R.add(obj);
      seal = { obj, inst };
    }
  }

  function bearParts(slot: number): ActorParts {
    const inst = createCharacter(kit.look(slot), { variant: 'polarBear', ring: false });
    const sc = inst.ref?.scale;
    return { inst, shadow: 1.6, scale: sc ? S / sc : 1, headY: 1.5 };
  }

  function footParts(slot: number): ActorParts {
    const look = kit.look(slot);
    const inst = createCharacter(look, { ring: false });
    return { inst, shadow: 1, scale: nativeCharScale(look, S), headY: 1.1 };
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

  return {
    id: 'pushOff',
    async preload() {
      await Promise.all([preloadCatalogFor('pushOff', ['poMeltSector', 'polarBear', 'poDrone', 'poBeam', 'poSeal', 'poSmoke0', 'poBolt0']), ...Object.entries(LEVEL_ID).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'tilt';
      kit = new Kit(ctx, 'pushOff', { bg: BG[variant] ?? 0, hemi: [0xe4f3ff, 0x3a5a7a, 1.6] });
      splashed.clear(); bolts.clear(); flyBears.clear(); pieces.length = 0; billboards.clear();
      tilt = [0, 0];
      follow = null;
      buildStage();
      applyPose(ctx.camera, (follow = new Ps1Follow(TRACK_CAMS[LEVEL_ID[variant] ?? 18], stageRef(variant))).step(0, []));
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); buildStage(); } });
    },

    render(ctx, w0, dt) {
      const w = mirrorWorld(w0);
      kit.checkOver(w);
      const d = w.data;
      const R: number = d.radius ?? PO_RADIUS;
      const k = R / PO_RADIUS;
      const t0 = d.tiltRad?.[0] ?? 0, t1 = -(d.tiltRad?.[1] ?? 0); // z mirrored
      tilt = [t0, t1];
      const pil: [number, number, number][] | undefined = w0.data.pillars;
      if (pil) pillarObjs.forEach((o, i) => { if (o) o.visible = (pil[i]?.[2] ?? 1) !== 0; });
      if (sectors.length) sectors.forEach((o, i) => { const m = d.melt?.[i] ?? 0; o.visible = m < 0.99; o.position.y = -m * 0.8; });
      else platform.scale.set(k, 1, k);
      platform.quaternion.setFromUnitVectors(up, new THREE.Vector3(Math.tan(t0), 1, Math.tan(t1)).normalize());
      const surf = (x: number, z: number) => -(Math.tan(tilt[0]) * x + Math.tan(tilt[1]) * z);

      const seen = new Set<number>();
      const seenBolts = new Set<number>();
      const tracked: Tracked[] = [];
      let mask = false;
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          // MANIC: a bolt hit knocks the rider off the bear (data.foot): the character goes on alone
          const onFoot = (w0.data.foot?.[b.slot] ?? 0) > 0;
          const ab = onFoot ? { ...b, id: b.id + 100000 } : b;
          seen.add(ab.id);
          const a = kit.actor(ab, () => (onFoot ? footParts(b.slot) : bearParts(b.slot)));
          const hanging = (d.hang?.[b.slot] ?? 0) > 0 && !b.fall;
          if (b.fall && b.y < WATER[variant] + 0.4 && !splashed.has(b.id)) {
            splashed.add(b.id);
            smoke(b.x, WATER[variant] + 0.3, b.z);
            sfx.playFile(SND.splash, 0.5);
          }
          const sf = b.fall || hanging ? 0 : surf(b.x, b.z);
          a.update(b, dt, {
            hidden: !b.alive || b.y < WATER[variant] - 0.3,
            hop: hanging ? -0.7 : sf,
            tumble: b.fall,
            role: b.fall ? 'jump' : hanging ? 'hit' : kit.over.done ? undefined : b.dash > 0 ? 'push' : 'idle',
            freeze: false,
          });
          // FUN_800bcc9c: a CPU's idle fidget, the level's own scripts (L18 RAM 0x800d3bb4 ...): pose 0x4000 + clip<<7 + frame
          if (d.fid?.[b.slot] && !onFoot) {
            const eng = DISC_CHARACTER[(ctx.seats[b.slot]?.look.char ?? 0) % 8];
            const f = FIDGET[eng];
            if (f) {
              const st = (fidT[b.slot] ??= ctx.time);
              const n = Math.floor((ctx.time - st) * 30);
              a.inst.pose(f.clip, f.frames[f.loop ? n % f.frames.length : Math.min(n, f.frames.length - 1)]);
            }
          } else fidT[b.slot] = undefined;
          if (b.fall || hanging) a.shadow.visible = false;
          a.holder.scale.setScalar(d.scale?.[b.slot] ?? 1); // Uka shrink (0.625) / grow (1.5)
          if (b.alive && !b.fall) tracked.push({ pos: new THREE.Vector3(b.x, b.y, b.z), face: b.face });
        } else if (b.kind === 'seal' && seal) {
          seal.obj.visible = b.alive;
          seal.obj.position.set(b.x, surf(b.x, b.z) + b.y, b.z); // y: the jump out of the water (0x400 below the ice at the start)
          seal.obj.rotation.y = b.face;
          seal.inst?.play('run');
          seal.inst?.update(dt);
        } else if (b.kind === 'mask') {
          mask = true;
          drone.position.set(b.x, 2.6, b.z);
          drone.rotation.y += dt * 2;
          beam.visible = (d.beam ?? 0) > 0;
          if (beam.visible) beam.position.set(b.x, surf(b.x, b.z), b.z);
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
          fb.inst.root.position.set(b.x, surf(b.x, b.z) + b.y, b.z);
          fb.inst.root.rotation.y = Math.PI - b.face; // b.face = yaw + 0x800 (faceOf); a raw model at game yaw a turns by -a
        } else if (b.kind === 'bolt') {
          seenBolts.add(b.id);
          let m = bolts.get(b.id);
          if (!m) { m = new THREE.Group(); for (let i = 0; i < 4; i++) m.add(propClone(`poBolt${i}`)); kit.root.add(m); bolts.set(b.id, m); }
          m.position.set(b.x, surf(b.x, b.z) + b.y, b.z); // y: carried above the head / thrown arc
          const f = Math.floor(ctx.time * 20) % 4;
          m.children.forEach((c, i) => (c.visible = i === f));
          m.quaternion.copy(ctx.camera.quaternion);
        }
      }
      drone.visible = mask;
      if (!mask) beam.visible = false;
      kit.prune(seen);
      for (const [id, m] of bolts) if (!seenBolts.has(id)) { kit.root.remove(m); bolts.delete(id); }
      for (const [id, f] of flyBears) if (!seenBolts.has(id)) { kit.root.remove(f.inst.root); flyBears.delete(id); }
      stepPieces(dt);
      for (const o of billboards) o.quaternion.copy(ctx.camera.quaternion);
      if (follow) applyPose(ctx.camera, follow.step(dt, tracked));
      kit.fx.update(dt);
    },

    onEvent(ctx, e0) {
      if (!kit) return;
      const e: GameEvent = { ...e0, z: -e0.z };
      if (e.k === 'dash') { // dash clip 0x3e: `0x8008 block*0x32+0x18` at a per-character frame (engine 8 = Koala Kong also 0x16 at 2)
        const c = ctx.seats[e.s]?.look.char;
        if (c != null) {
          charVoice('b', c, 0x18, DASH_VOICE_FRAME[c % DASH_VOICE_FRAME.length]);
          if (CHARACTERS[c % CHARACTERS.length]?.id === 'koala') charVoice('b', c, 0x16, 2);
        }
      }
      if (kit.baseEvent(e)) return;
      switch (e.k) {
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
          const l = SND.skid[variant] ?? [], i = Math.floor(Math.random() * l.length), f = l[i], rate = sfxRate(PO_BANK[variant], 0x456 + i);
          if (f) sfx.playFile(f, 0.45, false, rate);
          break;
        }
        case 'hang': // state 0x4e: anim 0x3d + sfx 0x45c
          sfx.playFile(SND.slip, 0.6);
          break;
        case 'pickup': // v: 1 shrink, 2 grow, 3 bomb, 4 freeze
          sfx.playFile(e.v === 1 ? SND.shrink : e.v === 4 ? SND.freeze : e.v === 3 ? SND.bomb : SND.mask, 0.7);
          break;
        case 'beam': case 'zap': // mask beams an item down (0x44c) / zap goes off (0x466)
          sfx.playFile(SND.mask, 0.6);
          break;
        case 'bomb': // bomb handed on (0x454)
          sfx.playFile(SND.pass, 0.7);
          break;
        case 'boom':
          sfx.playFile(SND.boom, 0.8);
          smoke(e.x, 1, e.z);
          kit.shake(0.4);
          break;
        case 'melt': // the mask melts a sector (0x44c)
          sfx.playFile(SND.mask, 0.5);
          chunks(e.x, 0.3, e.z, 6);
          break;
        case 'pillar':
          chunks(e.x, 0.8, e.z, 8);
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
        const id = CHARACTERS[seat.look.char % CHARACTERS.length].id;
        out.push({ tex: hudTex(HUD.face[id] ?? 3), x, y: 10, w: 64, h: 40 });
        const m = Math.max(0, Math.min(1, w.data.meter?.[slot] ?? 0));
        const g = Math.round(52 * m);
        out.push({ tex: `${ASSET_BASE}hud/barR.png`, x: x + 16, y: 39, w: 52, h: 6 });
        if (g > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + 16, y: 39, w: g, h: 6 });
        out.push({ tex: hudTex(33), x: x - 8, y: 33, w: 24, h: 18 });
      });
      out.push(...bigClock((getGame('pushOff')?.maxTime ?? 90) - w.time, Math.floor(w.time * 2) % 2 === 1));
      return out;
    },

    hud(w, slot) {
      const p = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
      if (!p || p.fall || !p.alive) return 'OUT';
      return `${Math.round((w.data.meter?.[slot] ?? 0) * 100)}%`;
    },

    dispose() {
      for (const m of bolts.values()) kit.root.remove(m);
      bolts.clear(); splashed.clear(); pieces.length = 0; billboards.clear();
      kit.dispose();
    },
  };
}
