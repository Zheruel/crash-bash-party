// Ring Ding view: the real clock-tower arena (model 0627): a studded wooden ring turning around a stone hub,
// gears and a huge clock face behind, balloons floating above. The players use their on-foot models.
import * as THREE from 'three';
import { createCharacter } from '../characters';
import { createRingDingOpening, createRingDingResult, ddBalloonBob, ddHeldItem, DD_INTRO_TICKS, DD_LANDING_TICKS, DD_LOSE_SCALE_STEP, DD_S, type RingDingData } from '../../shared/games/ringDing';
import type { Body, GameEvent } from '../../shared/types';
import { getCatalog } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { charVoice, VOICE_VOL } from '../shell/voice';
import { discStereo } from '../shell/discStereo';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { onFootSpinGlow } from '../../shared/games/onFoot';
import { Actor, Kit, catalogInstance, nativeCharScale, preloadCatalogFor } from './kit';
import { poseTicks } from './playerPose';
import { fxPartTemplate, pickupShadow, preloadFx } from './realFx';
import { specialCrate } from './partyBits';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { arenaClockSprites, scoreHud } from '../ui/ps1hud';
import type { ClientMiniGame } from './types';

const BLACK = 0x23202c;
/** Ring Ding sound id -> [file, rate] from the level's VAB 0180 (identical to the bank in the L27 RAM dump, where every id
 *  resolves through table 0x80064508 to these tones). */
const DD_SFX: Record<number, [string, number]> = {
  0x5dc: ['sfx/0180/9.mp3', 1],
  0x5dd: ['sfx/0180/9.mp3', 1],
  0x5de: ['sfx/0180/10.mp3', 1],
  0x5df: ['sfx/0180/10.mp3', 1],
  0x5e0: ['sfx/0180/11.mp3', 1],
  0x5e1: ['sfx/0180/11.mp3', 1],
  0x5e2: ['sfx/0180/12.mp3', 1],
  0x5e3: ['sfx/0180/12.mp3', 1],
  0x5e4: ['sfx/0180/13.mp3', 1],
  0x5e5: ['sfx/0180/13.mp3', 1],
  0x5e6: ['sfx/0180/14.mp3', 1],
  0x5e7: ['sfx/0180/14.mp3', 1],
  0x5e8: ['sfx/0180/15.mp3', 1],
  0x5e9: ['sfx/0180/15.mp3', 1],
  0x5ea: ['sfx/0180/16.mp3', 1],
  0x5eb: ['sfx/0180/16.mp3', 1],
  0x5ec: ['sfx/0180/17.mp3', 1],
  0x5ed: ['sfx/0180/18.mp3', 1],
  0x5ee: ['sfx/0179/31.mp3', 1],
  0x5ef: ['sfx/0180/20.mp3', 1],
  0x5f0: ['sfx/0180/21.mp3', 1],
  0x5f1: ['sfx/0180/22.mp3', 1],
  0x5f2: ['sfx/0180/23.mp3', 1],
  0x5f3: ['sfx/0180/24.mp3', 1],
  0x3f5: ['sfx/0158/12.mp3', 1],
  0x3f7: ['sfx/0158/12.mp3', 0.919],
  0x3f8: ['sfx/0159/10.mp3', 0.919],
  0x3fa: ['sfx/0158/9.mp3', 1],
  0x446: ['sfx/0164/32.mp3', 1],
  0x447: ['sfx/0164/33.mp3', 1],
  0x448: ['sfx/0164/32.mp3', 0.944],
  0x449: ['sfx/0164/33.mp3', 0.944],
};
/** Script voices: jump 0x2c, taunt 2 and spin 10 use `0x800a` (the player's handle, no position; Koala's spin is a plain
 *  `0x8008`), landing 8 and hit 0x2b use `0x8009` (at the player). Footsteps (FUN_80087b8c) and the hit's 0x11 call
 *  (FUN_800b937c) are positional too. */
const POSE_VOICE: Record<string, number> = { jump: 0xc, land: 0xd, taunt: 2, hurt: 3, hitland: 0x11 };
const HANDLE_CUES = new Set([2, 0xc, 0xe]);
/** DAT_8005a5d8: the floor's native Y (Y points down). */
const FLOOR_Y = -16;
/** FUN_8002b210 reads the fixed level camera (level 0x1b). */
const SOUND_CAM = LEVEL_CAMS[27];
const nativeOrigin = (x: number, height: number, z: number): [number, number, number] =>
  [Math.round(x / DD_S), FLOOR_Y - Math.round(height / DD_S), Math.round(-z / DD_S)];
const stereoAt = (x: number, height: number, z: number) => discStereo(SOUND_CAM, ...nativeOrigin(x, height, z));
/** Balloon pack 0794: pop scripts by displayed colour (table 0x800bb89c = [3,2,0,1], black 4); crate pack 0796 script 2 = '?' crate break. */
const PACK = 794, CRATES = 796, PICKUPS = 736, POP_FX = [3, 2, 0, 1], S = 3.4;
// The native render words 0x2014 and 0x2015 are one-based part numbers.
const CRATE_MODELS = [
  { model: CRATES, scale: S, parts: ['part19'] },
  { model: PACK, scale: S, parts: ['part19'] },
  { model: PACK, scale: S, parts: ['part20'] },
];
// L27 script 8 advances twice on entry. These are the first visible landing words.
const LAND_POSE = [0x410d, 0x4191, 0x418e, 0x418b, 0x4192, 0x4293, 0x410d, 0x4112];
const CUSTOM_JUMP_FRAMES = 0.65 * 30; // authored jump clip on Big Stein and Top G
// L27 script 0x0d, engine characters 1–8: first render word, lead-in length, loop length, optional loop word.
const WIN_LOOPS: [number, number, number, number?][] = [
  [0x4480, 0, 34], [0x4500, 0, 100], [0x4480, 11, 22, 0x448a], [0x4580, 0, 24],
  [0x4500, 34, 44], [0x4580, 33, 46], [0x4580, 0, 76], [0x4600, 0, 118],
];
// FUN_80085890 switches after a disc load. L27 captures ranged from 12 to 15 ticks after entry.
const WIN_LOAD_TICKS = [15, 14, 12, 15, 15, 15, 15, 14];
const ANGLE = 2 * Math.PI / 4096;
const GEAR_RATES = [20, 20, 5, 10, -15];

function winLoopPose(char: number, tick: number): number | undefined {
  const wait = WIN_LOAD_TICKS[char - 1];
  if (tick < wait) return;
  const [first, lead, length, loop = first + lead] = WIN_LOOPS[char - 1];
  const frame = tick - wait + 1; // switch and advance the new script in the same update
  return frame < lead ? first + frame : loop + (frame - lead) % length;
}

/** FUN_8008a200 starts turning on the first update after entering state 0x36. */
function resultFace(face: number, tick: number): number {
  if (tick === 0) return face;
  let yaw = Math.round(-face / ANGLE) & 0xfff;
  for (let i = 0; i < Math.min(tick, 32); i++) {
    const diff = -yaw & 0xfff;
    yaw = (yaw + ((diff > 0x800 ? diff - 0x1000 : diff) >> 2)) & 0xfff;
  }
  return -yaw * ANGLE;
}

const SFX = { black: 0x5ed, recolour: 0x5ee, flash: 0x5ef, reverse: 0x5f0, popOthers: 0x5f1, magnet: 0x5f2, hover: 0x5f3, crate: 0x3fa };
/** Every 0180 tone and program has volume 127 and pan 64 and every call keys at 0x1000: no position = full level, centred. */
const play = (id: number, late = false) => { const t = DD_SFX[id]; if (t) sfx.playFile(t[0], 1, late, t[1]); };
/** A call with a position: FUN_8002b210 fades by distance from the camera target and pans by screen X. */
const playAt = (id: number, x: number, height: number, z: number) => {
  const t = DD_SFX[id];
  if (t) sfx.startSample(t[0], null, 1, t[1], 0, stereoAt(x, height, z));
};
const playBlack = (effect: number, late = false) => play(effect === 0 ? SFX.popOthers : effect === 1 ? SFX.reverse : SFX.recolour, late);
const DECOR = ['ddWall', 'ddClock', 'ddHands', 'ddGearA', 'ddGearB', 'ddGearC', 'ddShaft', 'ddArm', 'ddAxle'];

interface BalloonV { obj: THREE.Group; body: THREE.Object3D; shadow: THREE.Object3D; slot: number }
interface ItemV { obj: THREE.Object3D; kind: number }

export function createRingDingView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const balloons = new Map<number, BalloonV>();
  const crates = new Map<number, ItemV>();
  let ringGroup: THREE.Group;
  const itemsHeld: { hover: THREE.Object3D; magnet: THREE.Object3D }[] = [];
  const gears: { node: THREE.Object3D; index: number }[] = [];
  let sphereGeo: THREE.SphereGeometry;
  let result: ReturnType<typeof createRingDingResult> | undefined;
  let opening: ReturnType<typeof createRingDingOpening>;
  // FUN_800b9eec marks each loser gone on the tick that spawns its colour burst.
  const poppedLosers = new Set<number>();
  let stopClock: (() => void) | undefined;
  const equippedSounds = new Map<number, { kind: number; source?: number; stop: () => void; setStereo: (levels: [number, number]) => void }>();
  /** A voice or effect timed by the player's pose clock. `sfx` marks a level-bank id, otherwise `cue` is a script voice. */
  const poseCues: { tick: number; slot: number; cue: number; sfx?: boolean }[] = [];
  /** The `0x800a` handle at player +0x94: a new call cuts the last; FUN_800b92bc stops it on hit entry. */
  const voiceHandles = new Map<number, () => void>();
  function clockSound() {
    stopClock?.();
    stopClock = sfx.loopFile(DD_SFX[0x5ec][0], 0.0034, 1);
  }
  /** FUN_800b5a40 keys 0x5f3 / 0x5f2 on the item handle with its live origin, so the stereo follows the holder. */
  function equippedSound(slot: number, kind: number, source?: number, elapsed = 0, at?: [number, number, number]) {
    const current = equippedSounds.get(slot);
    if (current?.kind === kind && current.source === source) {
      if (at) current.setStereo(stereoAt(...at));
      return;
    }
    current?.stop();
    equippedSounds.delete(slot);
    if (!kind) return;
    const [file, rate] = DD_SFX[kind];
    const sample = sfx.startSample(file, kind === SFX.hover ? 0.315 : 1.067, 1, rate, elapsed / 30 * rate, at ? stereoAt(...at) : [1, 1]);
    if (sample) equippedSounds.set(slot, { kind, source, stop: sample.stop, setStereo: sample.setStereo });
  }
  function playCue(ctx: Parameters<ClientMiniGame['render']>[0], slot: number, cue: number, levelSound: boolean) {
    const a = kit.actorForSlot(slot);
    const at = a ? [a.holder.position.x, a.holder.position.y, a.holder.position.z] as const : undefined;
    if (levelSound) {
      if (at) playAt(cue, ...at); else play(cue);
      return;
    }
    const look = ctx.seats[slot]?.look.char;
    if (cue === 3) { voiceHandles.get(slot)?.(); voiceHandles.delete(slot); }
    const engine = look === undefined ? 1 : DISC_CHARACTER[look] ?? 1;
    const handle = HANDLE_CUES.has(cue) && !(cue === 0xe && engine === 8);
    const stereo: [number, number] | undefined = HANDLE_CUES.has(cue) || !at ? undefined : stereoAt(...at);
    charVoice('c', look, cue, 0, VOICE_VOL, undefined, (file, volume, rate) => {
      if (handle) voiceHandles.get(slot)?.();
      const stop = sfx.startSample(file, null, volume, rate, 0, stereo)?.stop;
      if (handle && stop) voiceHandles.set(slot, stop);
      return stop;
    });
  }

  /** the real balloon of pack 0794: parts 0-3 = blue / green / red / yellow, part 4 black; colour per owner from table 0x800bb89c */
  const balloonPart = (slot: number) => `part${slot < 0 ? 4 : POP_FX[slot % 4]}`;
  function balloonModel(slot: number): THREE.Object3D {
    const inst = catalogInstance({ model: PACK, scale: S, parts: [balloonPart(slot)] });
    if (inst) return inst.root;
    const c = new THREE.Color(slot < 0 ? BLACK : kit.hex(slot));
    return new THREE.Mesh(sphereGeo, new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.3, flatShading: true }));
  }
  /** FUN_800b5d3c: each balloon owns a pack 0736 render word 0x2001 shadow, subtractive with fade 0x800, on the ground below. */
  function makeBalloon(slot: number): BalloonV {
    const obj = new THREE.Group();
    obj.name = 'ringDingBalloon';
    const body = balloonModel(slot);
    obj.add(body);
    const shadow = pickupShadow(PICKUPS, 0, S, { brightness: 0.5 });
    kit.root.add(obj, shadow);
    return { obj, body, shadow, slot };
  }

  /** The burst uses the displayed colour. A colour pop's sound is the sim's 'popsfx'; a black balloon's 0x5ed has no position. */
  function playPop(e: GameEvent, black = e.o < 0, late = false) {
    kit.real.play(PACK, e.o < 0 ? 4 : POP_FX[e.o % 4], e.x, e.v, e.z);
    if (black) play(SFX.black, late);
  }

  function build() {
    const R = kit.root;
    sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    gears.length = itemsHeld.length = 0;
    seatDiscs.clear();
    // the clock tower exactly as the real level places it (RAM object list of level 0x1b); the rotating ring is ours
    const ref = getCatalog().arenas.ringDing;
    const lvl = ref ? levelStage(ref, placements, (r) => catalogInstance(r)?.root ?? null, { skip: ['extra_149c', 'extra_1f68'] }) : null;
    if (lvl) {
      R.add(lvl);
      for (const node of lvl.getObjectByName('placements')?.children ?? []) {
        const index = parseInt(node.name.split(':')[0], 16) - 0x5004;
        if (index < 0 || index > 4) continue;
        node.matrix.decompose(node.position, node.quaternion, node.scale);
        node.matrixAutoUpdate = true;
        gears.push({ node, index });
      }
    }
    else { const arena = catalogInstance(ref); if (arena) R.add(arena.root); }
    ringGroup = new THREE.Group();
    ringGroup.name = 'ringDingPlatform';
    const ring = catalogInstance(getCatalog().props.ddRing);
    if (ring) ringGroup.add(ring.root);
    const inner = catalogInstance({ model: 627, parts: ['extra_1f68'], scale: S });
    if (inner) ringGroup.add(inner.root);
    R.add(ringGroup);
    for (let s = 0; s < 4; s++) {
      const hover = crateModel(1);
      const magnet = crateModel(2);
      hover.visible = magnet.visible = false;
      R.add(hover, magnet);
      itemsHeld.push({ hover, magnet });
    }
  }

  function crateModel(kind: number): THREE.Object3D {
    const mesh = catalogInstance(CRATE_MODELS[kind])?.root
      ?? (kind === 0 ? specialCrate(256 * DD_S) : new THREE.Group());
    mesh.name = ['ringDingBox', 'ringDingHover', 'ringDingMagnet'][kind];
    return mesh;
  }

  function actor(b: Body): Actor {
    const have = kit.actors.get(b.id);
    if (have) return have;
    const look = kit.look(b.slot);
    const a = kit.actor(b, () => ({ inst: createCharacter(look, { ring: false }), scale: nativeCharScale(look, S), shadow: 0.9 }));
    a.shadow.mesh.removeFromParent(); // the level replaces the shadow with the seat's disc (FUN_800bb560)
    return a;
  }

  /** FUN_800bb560 swaps each player's shadow node (0x8009d538) for pack 0794 word DAT_800bc04c[seat] = [0x2013, 0x2012, 0x2010,
   *  0x2011], drawn additive (entity flags 0x8021). FUN_8008672c keeps it under the player on the ground each frame. */
  const seatDiscs = new Map<number, THREE.Object3D>();
  function seatDisc(slot: number) {
    let disc = seatDiscs.get(slot);
    if (!disc) {
      disc = fxPartTemplate(PACK, 15 + POP_FX[slot % 4], S, true)?.clone() ?? new THREE.Group();
      disc.name = 'ringDingSeatDisc';
      kit.root.add(disc);
      seatDiscs.set(slot, disc);
    }
    return disc;
  }

  /** FUN_8008900c: Cortex's and Brio's attack flashes part 1 of 0986 / 0984 at marker 0x40, additive and camera-facing. */
  const ATTACK_GLOW: Record<string, number> = { cortex: 986, brio: 984 };
  const attackGlows = new Map<number, THREE.Object3D>();
  const glowAt = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function updateAttackGlow(slot: number, frame: number | undefined, b: Body, face: number, camera: THREE.Camera) {
    const model = ATTACK_GLOW[CHARACTERS[kit.look(slot).char]?.id];
    const glow = model && frame !== undefined ? onFootSpinGlow(model === 986 ? 3 : 4, frame) : undefined;
    let obj = attackGlows.get(slot);
    if (!glow) { if (obj) obj.visible = false; return; }
    if (!obj) {
      const template = fxPartTemplate(model, 1, S, true);
      if (!template) return;
      obj = new THREE.Group();
      obj.add(template.clone());
      obj.name = 'attack-glow';
      kit.root.add(obj);
      attackGlows.set(slot, obj);
    }
    const [x, h, z] = glow.marker;
    glowAt.set(x, h, -z).multiplyScalar(DD_S).applyAxisAngle(UP, face);
    obj.position.set(b.x + glowAt.x, b.y + glowAt.y, b.z + glowAt.z);
    obj.scale.set(glow.scale[0] / 4096, glow.scale[1] / 4096, 1);
    obj.quaternion.copy(camera.quaternion);
    obj.visible = true;
  }

  return {
    id: 'ringDing',
    async preload() {
      for (const [file] of Object.values(DD_SFX)) sfx.preloadFile(file);
      placements = await loadPlacements('L27');
      await preloadCatalogFor('ringDing', ['ddRing', ...DECOR], CRATE_MODELS);
      await preloadFx([PACK, CRATES, PICKUPS, 986, 984]);
      loaded = true;
    },

    init(ctx, world) {
      kit = new Kit(ctx, 'ringDing', { bg: 0x1a1c28, hemi: [0xffffff, 0xc0b0b0, 1.6], sun: [-5, 18, 10] });
      poppedLosers.clear();
      attackGlows.clear();
      result = undefined;
      opening = undefined;
      poseCues.length = 0;
      build();
      clockSound();
      applyPose(ctx.camera, ps1Pose(LEVEL_CAMS[27], getCatalog().arenas.ringDing));
      void world;
      kit.realFx(S);
      if (!loaded) this.preload!().then(() => {
        if (kit) { kit.reset(); kit.root.clear(); crates.clear(); attackGlows.clear(); kit.realFx(S); build(); }
      });
    },

    render(ctx, w, dt) {
      const previousFrame = kit.over.done ? kit.over.frame : -1;
      kit.checkOver(w);
      const countdown = w.tick === 0 && w.data.openingRng !== undefined ? ctx.countdownTicksLeft : undefined;
      const introFrame = countdown === undefined ? undefined : Math.max(0, DD_INTRO_TICKS - countdown);
      if (introFrame !== undefined) opening ??= createRingDingOpening(w);
      else opening = undefined;
      const arena = opening && introFrame !== undefined ? opening.advance(introFrame) : w;
      const d = arena.data as RingDingData;
      const { done, frame, winners } = kit.over;
      const decided = done && winners.size > 0;
      // FUN_80082d90 plays the draw announcement when the result graphic reaches its size threshold.
      if (done && !decided && previousFrame < 23 && frame >= 23) sfx.playFile('sfx/0278/13.mp3', 0.9, true, sfxRate('0278', 0x1af));
      if (done) {
        result ??= createRingDingResult(w, winners.values().next().value);
        for (const e of result.advance(frame)) {
          if (e.k === 'pop') playPop(e, e.balloonType === 12, true);
          else if (e.k === 'black') playBlack(e.v, true);
          else this.onEvent?.(ctx, e);
        }
      } else {
        result = undefined;
        poppedLosers.clear();
      }
      // Online events can arrive ahead of the pose displayed for a remote seat.
      for (let i = 0; i < poseCues.length;) {
        const e = poseCues[i];
        if (kit.poseTick(e.slot) < e.tick) { i++; continue; }
        poseCues.splice(i, 1);
        playCue(ctx, e.slot, e.cue, !!e.sfx);
      }
      ctx.scene.background = new THREE.Color(0x1a1c28);
      const ringAngle = result?.angle ?? d.ang;
      ringGroup.rotation.y = ringAngle;
      const ringYaw = Math.round(-ringAngle / ANGLE);
      for (const { node, index } of gears) {
        const angle = -(ringYaw * GEAR_RATES[index] >> 4) * ANGLE;
        if (index < 2) node.rotation.set(0, angle, 0);
        else node.rotation.set(0, index === 2 ? -768 * ANGLE : 0, angle, 'YXZ');
      }
      const seen = new Set<number>(), seenSlots = new Set<number>(), seenB = new Set<number>(), seenC = new Set<number>();
      for (const b of arena.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const playerData = done ? d : kit.playerWorld(s).data as RingDingData;
          const ending = result?.players[s];
          const p = ending ?? playerData.P[s];
          const char = p?.id ?? 1;
          const a = actor(b);
          const st = ending?.st ?? playerData.st?.[s];
          const spin = st === 1, hit = st === 2, air = !!(ending?.ph ?? playerData.ph?.[s]), moving = p?.moving;
          const taunt = p?.tauntAt;
          const landing = p?.landing ?? 0;
          const script = hit ? 0x2b : spin ? 10 : air ? 0x2c : landing ? 8 : moving ? 5 : taunt !== undefined ? 2 : 1;
          const body = ending ? { ...b, x: ending.x * DD_S, z: -ending.z * DD_S, y: ending.h * DD_S,
            face: ending.face, vx: 0, vz: 0, vy: (ending.ph === 1 ? ending.vv : -ending.vv) * DD_S * 30 }
            : p ? { ...b, y: p.h * DD_S } : b;
          const resultState = ending && ending.entered >= 0;
          const win = decided && winners.has(s);
          if (resultState) {
            // FUN_800b9a04 / FUN_800b9ce0 stop the player handle (and the item handle) on win and lose entry.
            voiceHandles.get(s)?.();
            voiceHandles.delete(s);
            const resultTick = frame - ending.entered;
            const scale = win ? 0x1000 : 0x1000 - DD_LOSE_SCALE_STEP * resultTick;
            const hidden = ending.hidden;
            if (win) a.face = resultFace(body.face, resultTick);
            a.update(body, dt, { script: win ? 0xc : 1, scriptFrame: resultTick, renderWord: win ? winLoopPose(char, resultTick) : undefined, hidden, keepYaw: win });
            a.holder.scale.setScalar(hidden ? 1 : scale / 0x1000);
            if (hidden && !poppedLosers.has(s)) {
              poppedLosers.add(s);
              kit.real.play(PACK, POP_FX[s], body.x, 0, body.z);
            }
          } else {
            const tick = kit.poseTick(s);
            const tauntFrame = taunt === undefined ? undefined : Math.max(0, tick - taunt - 1);
            const keepTaunt = script === 2 && tauntFrame !== undefined && tauntFrame < poseTicks(2, char);
            const activeScript = done && script === 2 && !keepTaunt ? 1 : script;
            const jumpFrame = p?.jumpAt === undefined ? undefined : tick - p.jumpAt;
            const landFrame = DD_LANDING_TICKS[char - 1] - landing;
            const look = kit.look(s).char;
            const custom = look === 8 || look === 9 ? a.inst.ref?.anims : undefined;
            const spinFrame = spin && p ? poseTicks(10, char) - p.t : undefined;
            const flightFrame = (jumpFrame ?? 0) - (landing ? landFrame + 1 : 0);
            const flightProgress = 0.8 * Math.min(1, Math.max(0, flightFrame / (p?.bot ? 26 : 27)));
            const customProgress = landing ? flightProgress + (1 - flightProgress) * (landFrame + 1) / DD_LANDING_TICKS[char - 1]
              : flightProgress;
            const idleTick = !done && p?.idleAt === d.P[s]?.idleAt ? w.tick : tick;
            const idleFrame = activeScript === 1 && p?.idleAt !== undefined
              ? introFrame ?? (idleTick - p.idleAt) : undefined;
            let pose: { clip: number; frame: number; loop?: boolean } | undefined;
            if (idleFrame !== undefined && custom?.idle !== undefined) {
              pose = { clip: custom.idle, frame: idleFrame, loop: true };
            } else if (spinFrame !== undefined && custom?.spin !== undefined) {
              pose = { clip: custom.spin, frame: spinFrame };
            } else if (custom?.jump !== undefined && (script === 0x2c || script === 8)) {
              pose = { clip: custom.jump, frame: customProgress * CUSTOM_JUMP_FRAMES };
            } else if (activeScript === 2 && tauntFrame !== undefined && a.inst.ref?.anims?.taunt !== undefined) {
              pose = { clip: a.inst.ref.anims.taunt, frame: tauntFrame };
            }
            if (win) a.face = body.face;
            a.update(body, dt, { script: activeScript, keepYaw: win, pose,
              renderWord: script === 8 ? LAND_POSE[char - 1] + landFrame : undefined,
              scriptFrame: hit ? p?.hitFrame : spin ? spinFrame
                : script === 0x2c ? jumpFrame : activeScript === 2 ? tauntFrame
                : script === 5 && p?.runAt !== undefined ? tick - p.runAt : idleFrame, // run: the sim times footsteps on script 5
              role: hit ? 'hit' : taunt !== undefined ? 'taunt' : spin ? 'spin' : air ? 'jump' : moving ? 'run' : 'idle' });
            a.holder.scale.setScalar(1);
          }
          updateAttackGlow(s, !resultState && spin && p ? poseTicks(10, char) - p.t : undefined, body, a.face, ctx.camera);
          const disc = seatDisc(s);
          disc.position.set(body.x, 0, body.z);
          disc.visible = !ending?.hidden;
          seenSlots.add(s);
          const equip = itemsHeld[s];
          const carried = p && ddHeldItem(p, (ending ? result?.itemActors : playerData.itemActors)?.[s]);
          equip.hover.visible = !!carried?.visible && carried.kind === 1;
          equip.magnet.visible = !!carried?.visible && carried.kind === 2;
          const stopped = ending?.hidden || (resultState && !win && (carried?.elapsed ?? 0) > 0);
          const kind = stopped ? 0 : carried?.kind;
          equippedSound(s, kind === 1 ? SFX.hover : kind === 2 ? SFX.magnet : 0, carried?.source, carried?.elapsed,
            [body.x, body.y, body.z]); // FUN_800b6c50 keeps the item origin on the player; the 0x40 lift is in its render node
          if (carried?.kind) {
            const item = carried.kind === 1 ? equip.hover : equip.magnet;
            item.position.set(body.x, carried.height * DD_S, body.z);
            item.rotation.y = carried.yaw;
          }
        } else if (b.kind === 'balloon') {
          const ending = result?.balloons.get(b.id);
          if (result && !ending) continue;
          const slot = result && ending ? result.balloonSlot(ending) : b.slot;
          const x = ending ? ending.x * DD_S : b.x;
          const y = ending ? ending.hy * DD_S : b.y;
          const z = ending ? -ending.z * DD_S : b.z;
          seenB.add(b.id);
          let v = balloons.get(b.id);
          if (!v) { v = makeBalloon(slot); balloons.set(b.id, v); }
          if (v.slot !== slot) { // recoloured (black item): swap to that colour's model
            v.slot = slot;
            v.obj.remove(v.body);
            v.body = balloonModel(slot);
            v.obj.add(v.body);
          }
          const age = introFrame ?? w.tick + (d.openingRng === undefined ? 0 : DD_INTRO_TICKS) + (done ? frame : 0);
          const bob = ddBalloonBob(b.face, age);
          v.obj.position.set(x, y - bob * DD_S, z);
          v.obj.visible = true;
          v.shadow.position.set(x, 0, z);
          v.shadow.visible = true;
        } else if (b.kind === 'crate' || b.kind === 'item') {
          const c = result?.crates.get(b.id);
          if (result && !c) continue;
          seenC.add(b.id);
          const flight = c ? c.st === 13 : b.kind === 'item';
          const kind = flight ? (c ? c.item === 0x13 ? 1 : 2 : b.cd) : 0;
          let v = crates.get(b.id);
          if (v?.kind !== kind) {
            if (v) kit.root.remove(v.obj);
            v = { obj: crateModel(kind), kind };
            crates.set(b.id, v);
            kit.root.add(v.obj);
          }
          const { obj } = v;
          obj.position.set(c ? c.x * DD_S : b.x, c ? (flight ? c.g * DD_S : 0) : b.y, c ? -c.z * DD_S : b.z);
          obj.rotation.y = c ? -(c.yaw ?? 0) * ANGLE : b.face;
          obj.scale.y = flight ? 1 : (c ? c.g / 4096 : b.m);
        }
      }
      kit.prune(seen);
      for (const [slot, disc] of seatDiscs) if (!seenSlots.has(slot)) disc.visible = false;
      for (const [id, v] of balloons) if (!seenB.has(id)) { kit.root.remove(v.obj, v.shadow); balloons.delete(id); }
      for (const [id, v] of crates) if (!seenC.has(id)) { kit.root.remove(v.obj); crates.delete(id); }
      applyPose(ctx.camera, ps1Pose(LEVEL_CAMS[27], getCatalog().arenas.ringDing)); // the real camera (level 0x1b)
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const tick = e.t + (kit.over.done ? 0 : 1);
      const cue = e.k === 'footstep' ? e.v : POSE_VOICE[e.k];
      if (cue !== undefined) poseCues.push({ tick, slot: e.s, cue });
      if (e.k === 'hitsfx') poseCues.push({ tick, slot: e.s, cue: e.v, sfx: true });
      if (e.k === 'land' || e.k === 'footstep' || e.k === 'hitsfx' || e.k === 'hitland') return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'pop': {
          // s = popper (-1: popped by a black balloon), o = displayed colour (-1 black), v = height
          playPop(e);
          if (e.s >= 0) kit.actorForSlot(e.s)?.squash.kick(0.15);
          break;
        }
        case 'black': {
          playBlack(e.v);
          break;
        }
        case 'popsfx': // FUN_800b6044: rand(4) of the original type's ids, at the balloon
          playAt(e.o, e.x, e.y ?? 0, e.z);
          break;
        case 'cratespawn': // FUN_800b51a0, at the crate
          playAt(SFX.crate, e.x, 0, e.z);
          break;
        case 'cratehit':
          kit.real.play(CRATES, 2, e.x, 0, e.z); // shared crate break FUN_8008e27c, kind 2: shards, smoke, stars
          play(DD_SFX[e.o] ? e.o : 0x3f5, true);
          break;
        case 'reverse':
          clockSound();
          break;
        case 'flash': // recolour flicker, FUN_800b6044 / FUN_800b6608
          play(SFX.flash);
          break;
        case 'punch':
          if (e.v === 2) {
            kit.actorForSlot(e.s)?.hit();
            if (e.o >= 0) poseCues.push({ tick, slot: e.s, cue: 3 });
          } else poseCues.push({ tick, slot: e.s, cue: 0xe });
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      const d = w.data as RingDingData;
      return scoreHud(ctx.seats, s => (result?.shown ?? d.shown ?? d.score)[s] ?? 0, arenaClockSprites('ringDing', w));
    },

    hud(w, slot) {
      const d = w.data as RingDingData;
      return `${String((result?.shown ?? d.shown ?? d.score)[slot] ?? 0).padStart(3, '0')}${(d.hover?.[slot] ?? 0) > 0 ? ' ▲' : ''}${(d.magnet?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose() {
      stopClock?.();
      stopClock = undefined;
      for (const sound of equippedSounds.values()) sound.stop();
      equippedSounds.clear();
      for (const stop of voiceHandles.values()) stop();
      voiceHandles.clear();
      balloons.clear(); crates.clear();
      itemsHeld.length = gears.length = 0;
      kit.dispose();
    },
  };
}
