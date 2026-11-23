import * as THREE from 'three';
import { dashRideHeight, dashSpokeTurn, type DashExhaust, type DashMotor, DR_ANGLE, DR_BARRELS, DR_K, DR_LAPS, DR_TRACKS, stepDashResult, trackRadii } from '../../shared/games/dashRace';
import { dashKartPose, poseTicks } from './playerPose';
import { dashCheerPose, fitDashResult } from './dashRaceResult';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { getCatalog, type ModelInstance, type ModelRef } from '../crash';
import { discStereo } from '../shell/discStereo';
import { sfx, sfxRate } from '../shell/sound';
import { hitVoice, vehicleVoice } from '../shell/voice';
import { DASH_SFX } from './dashRaceSfx';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import type { ActorParts } from './kit';
import { PartBatch, pickupShadow, preloadFx } from './realFx';
import { createCharacter } from '../characters';
import { arenaClockSprites, barRow, bigNumber, faceSprite, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import type { ClientMiniGame, RenderWorld } from './types';
import { applyPose, FitCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type LevelStageOpts, type Placements, type PS1Cam } from './ps1cam';

/**
 * Crash Dash view. The four tracks are the real stages (assets/stages/dashRace.json, model units x DR_K, origin =
 * stage origin) seen from the real fixed camera, which is common to all four (fitted against the original frames):
 * a high three-quarter view of the whole ring from the south. Karts are the per-level vehicle models (hover pods
 * on Dot / Toxic / Dante, sea creatures on Splash).
 */

const DASH_BANK: Record<string, string> = { dot: '0175', toxic: '0174', splash: '0173', dante: '0172' };
const AMBIENCE: Partial<Record<string, { id: number; loopStart: number }>> = {
  toxic: { id: 0x42e, loopStart: 0.0035 },
  splash: { id: 0x672, loopStart: 0.2849 },
};
// Loop-start seconds from the four road engine VAGs in the audio manifest.
const MOTOR_LOOPS = [0.5714, 0.5714, 0.5714, 0.5714, 0.1981, 0.1981, 0.1905, 0.1905];
/** Every FUN_80022660 call in the overlay keys volume 0x1000, and every tone of banks 0172-0175, 0154, 0158, 0160 and 0164
 *  has volume 127 and centre pan, so all effects share one level (the same gain as the Ballistix and Polar Push effects). */
const DASH_FULL = 0.8;

/** model-unit camera (x DR_K) */
const KART_S = 1; // karts are in level units (3.4 per 1024 u), like the stage
const CAM = { p: [0, 4.2, 8.5] as const, pitch: 22.3, fov: 33.5 };

interface Look { bg: number; hemi: [number, number, number] }
const LOOKS: Record<string, Look> = {
  dot: { bg: 0x101830, hemi: [0xffffff, 0xc0c8e0, 1.5] },
  toxic: { bg: 0x0a1408, hemi: [0xffffff, 0xb8c8a8, 1.5] },
  // The cavern's translucent layers add their colour over the disc's black clear.
  splash: { bg: 0x000000, hemi: [0xffffff, 0xb0c8e8, 1.5] },
  dante: { bg: 0x1a0a08, hemi: [0xffffff, 0xd8b8a0, 1.5] },
};
const ARENA: Record<string, string> = { dot: 'dotDash', toxic: 'toxicDash', splash: 'splashDash', dante: 'dantesDash' };
/** CRASH DASH level ids (cheat 0x17-0x1a) */
const LEVEL: Record<string, number> = { dot: 23, toxic: 24, splash: 25, dante: 26 };
/**
 * Level options: only what the game draws (it keeps alternate pieces such as the grey centre rings hidden), Dante's lava
 * sea from the native mesh table, and Toxic's 11 barrels (extra_aac0) kept for the sim to hide/show.
 */
const OPTS: Record<string, LevelStageOpts> = {
  dot: { skip: ['extra_7d80'] },
  toxic: { skip: ['extra_a610'] },
  splash: { skip: ['extra_5890'], decals: ['extra_57e4'] },
  dante: { skip: ['extra_96cc'] },
};
/**
 * Real effects (re/notes/crashDash.md "Effects"): the level model carries the effect scripts (9 = respawn burst, 5 = Splash
 * respawn bubble, 8 = shield ring, 4 / 10 / 3 / 1 = Dante volcano blast / rock fire / smoke / explosion, 10 = Toxic spit);
 * object pack 0760 has the missile trail (script 0), the explosion (script 1) and the exhaust flip-books.
 */
const FX_LEVEL: Record<string, number> = { dot: 643, toxic: 639, splash: 641, dante: 637 };
const PACK = 760, POLAR = 403, U = DR_K / 1024;
const seq = (a: number, n: number) => Array.from({ length: n }, (_, i) => a + i);
/** exhaust puffs, one part per 30 Hz tick: 0x170a boost fire (FUN_800c5048 / FUN_800c5028), 0x1709 run smoke, first frame held
 *  3 ticks (FUN_800c4cb8 / FUN_800c4c98, pack 0403, node flag 0x21), 0x1711 Splash spray (FUN_800c4638 / FUN_800c4618) */
const EX_BOOST = seq(40, 16), EX_RUN = [26, 26, 26, ...seq(28, 14)], EX_SEA = seq(56, 16);
const placements = new Map<string, Placements | null>();
const arenaRef = (v: string) => (getCatalog().arenas as Record<string, ModelRef>)[`dashRace:${ARENA[v]}`];

function inst(name: string): THREE.Object3D | null {
  const i = catalogInstance(getCatalog().props[name]);
  return i ? i.root : null;
}

/** The Dash pickup's render words 0x2049–0x2056 select parts 72–85 in pack 0760. */
const FRUIT_PARTS = seq(72, 14);
function makeFruit(): THREE.Group {
  const frames = FRUIT_PARTS.map((p) => catalogInstance({ model: PACK, scale: DR_K, parts: [`part${p}`] })?.root);
  if (frames.every((f) => f)) {
    const g = new THREE.Group();
    const bb = new THREE.Group();
    bb.name = 'bb';
    frames.forEach((f, i) => { f!.visible = i === 0; bb.add(f!); });
    g.add(bb);
    g.userData.frames = frames;
    return g;
  }
  const g = new THREE.Group();
  const f = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), new THREE.MeshBasicMaterial({ color: 0xf2801c }));
  f.scale.y = 1.12; f.position.y = 0.22;
  const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 6), new THREE.MeshBasicMaterial({ color: 0x3a9a2a }));
  leaf.position.y = 0.62;
  g.add(f, leaf);
  return g;
}

/** pickup object 0x1702 (FUN_800bfc38 / 800bfd84, pack 0760): crate type 0 = the missile 0x2011 (part16), Toxic type 5 = the
 *  shield star 0x2017 (part22); spins 0x80 / frame on the ground */
function makeItem(shield: boolean): THREE.Group {
  const g = new THREE.Group();
  const star = shield ? inst('dashRace.star') : null;
  g.add(star ?? makeMissile());
  return g;
}

function makeMissile(): THREE.Group {
  const real = inst('dashRace.missile'); // 0760 part16, the game's own missile
  if (real) { const g = new THREE.Group(); g.add(real); return g; }
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.8, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8e8f0 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe84a3a }));
  nose.position.z = 0.55;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.24), new THREE.MeshBasicMaterial({ color: 0xe84a3a }));
  fin.position.z = -0.35;
  g.add(body, nose, fin);
  return g;
}

function rockModel(): THREE.Object3D {
  const real = inst('dashRace.dante.rock'); // 637 part24: the volcano's lava rock
  if (real) { const g = new THREE.Group(); g.add(real); return g; }
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshBasicMaterial({ color: 0xe8541a }));
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Splash Dash sweeping push rod (blue steel pole with a white band), pointing along local +x */
function makeRod(): THREE.Group {
  const g = new THREE.Group();
  const len = trackRadii('splash', 0)[1] - 0.6, r0 = trackRadii('splash', 0)[0] - 0.4;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, len - r0, 12).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a62c8 }));
  body.position.x = (len + r0) / 2;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.5, 12).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8f0ff }));
  band.position.x = len - 0.5;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0x3a62c8 }));
  cap.position.x = len;
  g.add(body, band, cap);
  return g;
}

export function createDashRaceView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'dot';
  const objs = new Map<number, THREE.Object3D>();
  const heldItems = new Map<number, THREE.Group>();
  const shadows = new Map<number, THREE.Object3D>();
  const exhaust = new Map<number, PartBatch>();
  const billboard = new THREE.Euler(0, 0, 0, 'YXZ');
  const rockIds = new Set<number>();
  let rockTick = -1;
  let monster: ModelInstance | null = null;
  let lava: ModelInstance | null = null;
  let splashHub: THREE.Object3D | undefined;
  let barrels: THREE.Object3D[] = [];
  let result: { world: RenderWorld; frame: number; camera: FitCam } | undefined;
  const blobModels = new Map<number, ModelInstance>();

  const engines = new Map<number, { start: number; sample: NonNullable<ReturnType<typeof sfx.startSample>> }>();

  function drawExhaust(puffs: DashExhaust[], tick: number, camera: THREE.Camera) {
    billboard.setFromQuaternion(camera.quaternion, 'YXZ');
    for (const batch of exhaust.values()) batch.begin();
    for (const p of puffs) {
      const frames = p.kind === 'run' ? EX_RUN : p.kind === 'boost' ? EX_BOOST : EX_SEA;
      const part = frames[tick - p.born - 1];
      if (part === undefined) continue;
      const model = p.kind === 'run' ? POLAR : PACK;
      const key = model * 128 + part;
      let batch = exhaust.get(key);
      if (!batch) {
        batch = new PartBatch(kit.root, model, part, DR_K, 16, p.kind === 'run');
        exhaust.set(key, batch);
      }
      batch.add(p.x * U, p.y * U, -p.z * U, billboard.y, billboard.x);
    }
    for (const batch of exhaust.values()) batch.end();
  }

  function syncEngine(slot: number, kind: 'run' | 'boost', motor: DashMotor | undefined, world: RenderWorld) {
    const index = slot + (kind === 'boost' ? 4 : 0);
    const id = 0x644 + index, start = kit.over.done ? -1 : motor?.[kind] ?? -1;
    const old = engines.get(index);
    if (old && start !== old.start) { old.sample.stop(); engines.delete(index); }
    if (start < 0) return;
    const file = DASH_SFX[variant]?.[id];
    if (!file) return;
    const d = world.data, cam = LEVEL_CAMS[LEVEL[variant]];
    const levels = kind === 'run' ? discStereo(cam, d.gx[slot], -dashRideHeight(variant) - d.gy[slot], d.gz[slot]) : discStereo(cam, 0, 0, 0);
    const rate = sfxRate(DASH_BANK[variant], id), offset = Math.max(0, world.tick - start) * rate / 30;
    if (old?.start === start) {
      old.sample.setStereo(levels);
      old.sample.update(rate, offset);
    } else {
      const sample = sfx.startSample(file, MOTOR_LOOPS[index], DASH_FULL, rate, offset, levels);
      if (sample) engines.set(index, { start, sample });
    }
  }

  let ambience: ReturnType<typeof sfx.startSample> = null;

  const decor: { o: THREE.Object3D; kind: string; inst?: ModelInstance }[] = [];

  // everything for every track: preload() can run before init() has picked the variant
  const propNames = () => [
    ...CHARACTERS.flatMap((c) => [`dashRace.kart.${c.id}`, `dashRace.sea.${c.id}`]),
    'dashRace.missile', 'dashRace.star', 'dashRace.dante.rock',
    'dashRace.toxic.monster', 'dashRace.toxic.barrel', 'dashRace.toxic.arrow',
    'dashRace.splash.rod', 'dashRace.splash.weed', 'dashRace.splash.arrow',
    'dashRace.dante.grass', 'dashRace.dante.grass2', 'dashRace.dante.arrow', 'dashRace.dante.back',
    'dashRace.dot.tower1', 'dashRace.dot.tower2', 'dashRace.dot.tower3', 'dashRace.dot.lamp', 'dashRace.dot.arrow',
  ];

  /** yaw of an arrow template pointing along +z (or -x when `west`) so it points clockwise round (cx, cz) at (x, z) */
  const tanYaw = (x: number, z: number, cx: number, cz: number, west = false) => {
    const th = Math.atan2(z - cz, x - cx), tx = -Math.sin(th), tz = Math.cos(th);
    return west ? Math.atan2(tz, -tx) : Math.atan2(tx, tz);
  };

  function build() {
    const R = kit.root;
    heldItems.clear();
    shadows.clear();
    decor.length = 0; monster = lava = null; splashHub = undefined; barrels = [];
    const ref = arenaRef(variant);
    // the real level: every static object from the game's own object list (towers, lamps, arrows, backdrops, grass)
    const lvl = ref ? levelStage(ref, placements.get(variant) ?? null, (r) => catalogInstance(r)?.root ?? null, OPTS[variant]) : null;
    if (lvl) {
      // Splash's start line object sits 79 units under the floor; the PS1 has no depth buffer and its ordering table
      // draws it over the floor anyway, so lift it to floor level (then the decal offset wins the coplanar fight)
      const line = lvl.getObjectByName('0x5002:extra_57e4');
      if (line && variant === 'splash') { line.matrix.elements[13] += (79 * (ref?.scale ?? 1)) / 1024; line.matrixWorldNeedsUpdate = true; }
      R.add(lvl);
      if (variant === 'splash') {
        splashHub = lvl.getObjectByName('0x5005:extra_5eac');
        if (splashHub) {
          splashHub.matrix.decompose(splashHub.position, splashHub.quaternion, splashHub.scale);
          splashHub.matrixAutoUpdate = true;
        }
      } else if (variant === 'dante' && ref) {
        lava = catalogInstance({ ...ref, parts: ['part54'] });
        if (lava) R.add(lava.root);
      }
    } else kit.addArena(ARENA[variant], 0);
    const place = (name: string, x: number, z: number, o: { y?: number; yaw?: number; s?: number } = {}) => {
      const m = inst(name);
      if (!m) return null;
      m.position.set(x * DR_K, o.y ?? 0, z * DR_K);
      m.rotation.y = o.yaw ?? 0;
      if (o.s) m.scale.setScalar(o.s);
      R.add(m);
      return m;
    };
    if (lvl && variant !== 'toxic' && variant !== 'splash') {
      // all static decor is in the level
    } else if (variant === 'dot') {
      for (const [ax, az] of [[-1.44, -1.63], [1.26, 1.85]]) place('dashRace.dot.arrow', ax, az, { y: 0.3, yaw: tanYaw(ax, az, 0, 0.95) });
      place('dashRace.dot.tower1', -3.9, 0.6, { y: -4.5 });
      place('dashRace.dot.tower2', -3.8, -3.2, { y: -3.5 });
      place('dashRace.dot.tower3', 4.0, -2.6, { y: -3 });
      place('dashRace.dot.lamp', 1.7, -4.2);
    } else if (variant === 'toxic') {
      if (!lvl) place('dashRace.toxic.arrow', 0, 0, { y: 0.3 });
      // the game's 11 barrels (array at 0x800c6f88, game units); struck barrels disappear for the rest of the race
      if (lvl) {
        // the game's own barrel objects: match each sim barrel to the placed one at its spot
        const held: THREE.Object3D[] = [];
        lvl.traverse((o) => { if (o.name.endsWith(':extra_aac0')) held.push(o); });
        const p = new THREE.Vector3();
        DR_BARRELS.forEach(([gx, gz], i) => {
          let best: THREE.Object3D | undefined, bd = Infinity;
          for (const h of held) { p.setFromMatrixPosition(h.matrix); const d = Math.hypot(p.x - (gx / 1024) * DR_K, p.z + (gz / 1024) * DR_K); if (d < bd) { bd = d; best = h; } }
          if (best) barrels[i] = best;
        });
      } else DR_BARRELS.forEach(([gx, gz], i) => { const m = place('dashRace.toxic.barrel', gx / 1024, -gz / 1024, { y: 0.6, yaw: i * 1.3, s: 0.8 }); if (m) barrels[i] = m; });
      monster = catalogInstance(getCatalog().props['dashRace.toxic.monster']);
      if (monster) { monster.root.position.y = -196 * U; monster.root.visible = false; R.add(monster.root); }
    } else if (variant === 'splash') {
      if (!lvl) place('dashRace.splash.arrow', 0, 0, { y: 0.3 });
      // spokes: level model 0641's animated part24 (anim id 0x4000 + ext = clip 0 posed at frame ext), yaw i*0x2aa + rot
      for (let i = 0; i < 6; i++) {
        const real = catalogInstance(getCatalog().props['dashRace.splash.rod']);
        const m = real?.root ?? makeRod();
        R.add(m); decor.push({ o: m, kind: 'rod' + i, inst: real ?? undefined });
      }
    } else if (variant === 'dante') {
      const patch = new THREE.Mesh(new THREE.CircleGeometry(DR_TRACKS.dante.rIn[0] * DR_K + 0.3, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a3a1c }));
      patch.position.y = 0.04;
      R.add(patch);
      const back = place('dashRace.dante.back', 0, -8.5, { y: -4.8, s: 1.5 });
      back?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) for (const q of Array.isArray(m.material) ? m.material : [m.material]) (q as THREE.MeshBasicMaterial).color?.setRGB(0.5, 0.55, 0.4); });
      [[-3.4, 0], [-2.4, 1], [-1.3, 0], [-0.2, 1], [1.0, 0], [2.0, 1], [3.0, 0]].forEach(([x, k]) => place(k ? 'dashRace.dante.grass2' : 'dashRace.dante.grass', x, -4.7, { y: k ? 0 : 1.4, s: 1.15 }));
      place('dashRace.dante.arrow', -1.6, 1.4, { y: 0.1, yaw: tanYaw(-1.6, 1.4, 0, 0, true) });
    }
  }

  function makeParts(slot: number): ActorParts {
    const id = CHARACTERS[kit.look(slot).char % CHARACTERS.length].id;
    const name = variant === 'splash' ? `dashRace.sea.${id}` : `dashRace.kart.${id}`;
    const m = catalogInstance(getCatalog().props[name]);
    if (!m) return { inst: createCharacter(kit.look(slot)), scale: 1.25 };
    return { inst: m, steady: true, shadow: 0.9, headY: 0.8, scale: KART_S };
  }

  function aim(ctx: { camera: THREE.PerspectiveCamera }, resultCamera?: PS1Cam) {
    const cam = ctx.camera;
    const lc = resultCamera ?? LEVEL_CAMS[LEVEL[variant]];
    if (lc && placements.get(variant)) { applyPose(cam, ps1Pose(lc, arenaRef(variant))); return; }
    const pr = (CAM.pitch * Math.PI) / 180;
    const [x, y, z] = CAM.p;
    cam.position.set(x * DR_K, y * DR_K, z * DR_K);
    cam.lookAt(x * DR_K, (y - Math.sin(pr) * 10) * DR_K, (z - Math.cos(pr) * 10) * DR_K);
    if (Math.abs(cam.fov - CAM.fov) > 1e-3) { cam.fov = CAM.fov; cam.updateProjectionMatrix(); }
  }

  /** Resolve IDs against the currently loaded level bank, as the game does. */
  const play = (id: number) => { const f = DASH_SFX[variant]?.[id]; if (f) sfx.playFile(f, DASH_FULL, false, sfxRate(DASH_BANK[variant], id)); };

  return {
    id: 'dashRace',
    async preload() {
      await Promise.all([preloadCatalogFor('dashRace', propNames()), preloadFx([PACK, POLAR, ...Object.values(FX_LEVEL)]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'dot';
      for (const file of new Set(Object.values(DASH_SFX[variant] ?? {}))) sfx.preloadFile(file);
      const L = LOOKS[variant] ?? LOOKS.dot;
      objs.clear(); blobModels.clear(); rockIds.clear(); rockTick = -1;
      result = undefined;
      kit = new Kit(ctx, 'dashRace', { bg: L.bg, hemi: L.hemi });
      kit.realFx(DR_K);
      build();
      aim(ctx);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); kit.realFx(DR_K); build(); } });
    },

    render(ctx, snapshot, dt) {
      kit.checkOver(snapshot);
      const winner = kit.over.winners.values().next().value;
      let w = snapshot;
      if (kit.over.done) {
        result ??= { world: structuredClone(snapshot), frame: 0, camera: new FitCam(LEVEL_CAMS[LEVEL[variant]]) };
        const replayAge = ctx.resultReplayAt === undefined ? 0 : Math.floor((ctx.time - ctx.resultReplayAt) * 30 + 1e-7);
        const frame = Math.max(kit.over.frame, replayAge);
        while (result.frame < frame) {
          stepDashResult(result.world, winner);
          fitDashResult(result.camera, result.world, winner);
          result.frame++;
          if (frame - result.frame < 3) for (const e of result.world.ev) this.onEvent?.(ctx, e);
        }
        w = result.world;
      } else result = undefined;
      aim(ctx, result?.camera.c);
      const d = w.data;
      const left = w.tick === 0 ? ctx.countdownTicksLeft : undefined;
      const opening = left !== undefined && d.openingTicks !== undefined
        ? Math.max(0, Math.min(d.openingTicks, d.openingTicks + 1 - left)) : undefined;
      const stageTick = opening ?? d.f;
      const rotation = opening === undefined ? d.rot : opening * dashSpokeTurn(d.pat) & 4095;
      if (lava) lava.pose(0, (Math.max(0, stageTick - 1) % 192) >> 1); // FUN_800b8d68: word 0x4000 + (t >> 8), t += 0x80 below 0x6000
      if (splashHub) splashHub.rotation.y = -rotation * DR_ANGLE;
      const loop = AMBIENCE[variant];
      if (stageTick > 0 && loop) {
        const rate = sfxRate(DASH_BANK[variant], loop.id), offset = (stageTick - 1) * rate / 30;
        // FUN_800b8890 passes both channels at full volume and no spatial origin.
        ambience ??= sfx.startSample(DASH_SFX[variant][loop.id], loop.loopStart, DASH_FULL, rate, offset);
        ambience?.update(rate, offset);
      }
      for (let i = 0; i < barrels.length; i++) if (barrels[i]) barrels[i].visible = (d.bar?.[i]?.t ?? 0) <= 0;
      // toxic monster: rises out of the hub
      if (monster) {
        monster.root.visible = d.monS < 3;
        if (monster.root.visible) monster.pose(d.monS, d.monT);
      }
      for (const dc of decor) {
        if (dc.kind.startsWith('rod')) {
          const rods = w.bodies.filter((b) => b.kind === 'rod');
          const i = Number(dc.kind.slice(3)), r = rods[i];
          const yaw = (rotation + i * 0x2aa) & 4095;
          if (r && dc.inst) { dc.o.position.set(r.x, 151 * U, r.z); dc.o.rotation.y = -yaw * DR_ANGLE; dc.inst.pose(0, Math.max(0, Math.min(29, r.vy / 16))); dc.o.visible = true; }
          else if (r) { dc.o.rotation.y = Math.PI * 1.5 - yaw * DR_ANGLE; dc.o.position.y = -0.7 + 1.4 * r.y; dc.o.visible = r.y > 0.02; }
        }
      }
      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          const playerWorld = kit.over.done ? w : kit.playerWorld(b.slot);
          const d = playerWorld.data;
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          // FUN_8008b29c / FUN_8008b418: the kart's shadow is pack 0403 mesh 0x202f at scale 0x2000 and shade 0x400, drawn
          // subtractive on the floor (Y 0 on all four courses) with the kart's yaw, and hidden with the loser flags 0xa400.
          let shadow = shadows.get(b.id);
          if (!shadow) {
            shadow = pickupShadow(POLAR, 46, DR_K * 2, { brightness: 0.75, depthBias: 2 });
            if (shadow.children.length) { a.shadow.mesh.removeFromParent(); kit.root.add(shadow); }
            shadows.set(b.id, shadow);
          }
          syncEngine(b.slot, 'run', d.motors?.[b.slot], playerWorld);
          syncEngine(b.slot, 'boost', d.motors?.[b.slot], playerWorld);
          const turbo = !!d.turbo?.[b.slot];
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          const sea = variant === 'splash', state = d.state?.[b.slot];
          const char = DISC_CHARACTER[kit.look(b.slot).char] ?? 1;
          const age = d.st?.[b.slot] ?? 0;
          const kartPose = d.kartPose?.[b.slot];
          let script = sea ? 0x52 : 0x48;
          let scriptFrame: number | undefined;
          let renderWord: number | undefined;
          if (state === 0x62) {
            script = 0x48;
            scriptFrame = age + 1;
            renderWord = dashCheerPose(variant, char, age);
          } else if (kartPose) {
            renderWord = dashKartPose(kartPose.script, char, opening ?? kartPose.frame);
          } else {
            // Older snapshots carry the boost time and state age.
            const boostAge = playerWorld.tick - (d.boostAt?.[b.slot] ?? -1000);
            if (state === 0x61 && !d.fph?.[b.slot]) script = sea ? 0x54 : 0x4b;
            else if (state === 0x5d && !sea) { script = 0x4a; scriptFrame = age; }
            else if (boostAge < poseTicks(sea ? 0x53 : 0x49, char) || (sea && turbo)) {
              script = sea ? 0x53 : 0x49;
              scriptFrame = boostAge;
            } else if (state === 0x5b && age === d.openingTicks + playerWorld.tick && (d.boostAt?.[b.slot] ?? -1) < 0) {
              scriptFrame = opening ?? age;
            }
          }
          const hidden = kit.over.done && winner !== undefined && b.slot !== winner;
          const marker = d.itemMarkers?.[b.slot];
          let icon = heldItems.get(b.slot);
          if (marker?.item && !icon) {
            icon = makeItem(variant === 'toxic');
            icon.name = 'dash-held-item-' + b.slot;
            icon.scale.setScalar(0.5);
            kit.root.add(icon);
            heldItems.set(b.slot, icon);
          }
          if (icon) {
            icon.visible = !!marker?.item && !hidden;
            if (icon.visible) {
              icon.position.set(marker.x * U, marker.y * U, -marker.z * U);
              icon.rotation.y = -marker.yaw * DR_ANGLE;
            }
          }
          a.face = b.face;
          a.update(b, dt, { role: stun ? 'hit' : 'run', freeze: true, keepYaw: true, hidden, script, scriptFrame, renderWord });
          a.pivot.rotation.set((d.pitch?.[b.slot] ?? 0) * DR_ANGLE, 0, -(d.bank?.[b.slot] ?? 0) * DR_ANGLE);
          shadow.visible = !hidden;
          shadow.position.set(b.x, shadow.position.y, b.z);
          shadow.rotation.y = b.face;
          // The collision body stores height relative to the ride height (180 in Dante, 256 elsewhere).
          if (!hidden) a.holder.position.y += dashRideHeight(variant) * U;
        } else if (b.kind === 'fruit' || b.kind === 'item' || b.kind === 'missile' || b.kind === 'rock') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            if (b.kind === 'rock' && variant === 'toxic') {
              const blob = catalogInstance({ model: FX_LEVEL.toxic, scale: DR_K, parts: ['part58'] });
              if (blob) { blobModels.set(b.id, blob); o = blob.root; }
            }
            o ??= b.kind === 'fruit' ? makeFruit() : b.kind === 'item' ? makeItem(b.dash === 5) : b.kind === 'missile' ? makeMissile() : rockModel();
            kit.root.add(o);
            objs.set(b.id, o);
          }
          o.position.set(b.x, b.y, b.z);
          if (b.kind === 'fruit' && o.userData.frames) {
            const fr = o.userData.frames as THREE.Object3D[], k = Math.max(0, b.cd - 1) % fr.length;
            fr.forEach((f, i) => (f.visible = i === k));
            o.getObjectByName('bb')!.quaternion.copy(ctx.camera.quaternion);
          } else if (b.kind === 'fruit' || b.kind === 'item') o.rotation.y = b.face;
          else if (b.kind === 'missile') o.rotation.y = b.face;
          else {
            o.rotation.y = b.face;
            if (variant === 'dante') {
              o.visible = !d.rocksHidden;
              o.rotation.x = b.cd * DR_ANGLE;
            }
            else blobModels.get(b.id)?.nativePose(0x4100 + b.cd % 28);
            if (!rockIds.has(b.id)) {
              rockIds.add(b.id);
              const first = Math.abs(w.tick - rockTick) > 30;
              if (first) rockTick = w.tick;
              if (variant === 'dante') {
                // FUN_800c2388: blast (script 4) at the crater on launch, fire (script 10, looping) riding each rock
                if (!d.dantePool && first) kit.real.play(FX_LEVEL.dante, 4, 0, 0, 0);
                if (d.rocks?.find((rock: { id: number }) => rock.id === b.id)?.fireActor === 0) continue;
                kit.real.play(FX_LEVEL.dante, 10, b.x, 0, b.z, { loop: true, at: () => {
                  const pos = objs.get(b.id)?.position;
                  return pos ? { x: pos.x, y: 0, z: pos.z } : null;
                } });
              } else if (first) kit.real.play(FX_LEVEL.toxic, 10, -512 * U, 668 * U, 512 * U); // FUN_800c2e10: the monster's spit
            }
          }
        }
      }
      for (const [id, o] of objs) if (!seenO.has(id)) {
        // a Dante rock ends in the level's explosion (script 1)
        if (variant === 'dante' && !d.dantePool && rockIds.has(id) && !kit.over.done) kit.real.play(FX_LEVEL.dante, 1, o.position.x, o.position.y, o.position.z);
        rockIds.delete(id);
        blobModels.delete(id);
        kit.root.remove(o); disposeTree(o); objs.delete(id);
      }
      if (loaded) drawExhaust(d.exhaust ?? [], d.f, ctx.camera);
      kit.prune(seen);
      for (const [id, o] of shadows) if (!seen.has(id)) { o.removeFromParent(); shadows.delete(id); }
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      const lvl = FX_LEVEL[variant] ?? FX_LEVEL.dot;
      switch (e.k) {
        case 'turbo': {
          if (variant === 'splash') {
            const char = kit.look(e.s).char;
            const driver = DISC_CHARACTER[char];
            play(0x679 + e.s);
            vehicleVoice(char, 0x18, () => {
              if (driver === 1 || driver === 3 || driver === 5 || driver === 7) play(driver === 7 ? 0x684 : 0x67c + driver);
            });
          }
          break;
        }
        case 'pickup':
          play(e.v === 1 ? (variant === 'toxic' ? 0x439 : 0x51f) : 0x1c2);
          break;
        case 'missile':
          play(0x522);
          break;
        case 'missileTrail':
          kit.real.play(PACK, 0, e.x, e.v, e.z);
          break;
        case 'craterBlast':
          kit.real.play(FX_LEVEL.dante, 4, 0, 0, 0);
          break;
        case 'rockBurst':
          kit.real.play(FX_LEVEL.dante, 1, e.x, e.v, e.z);
          break;
        case 'rockTrail':
          kit.real.play(FX_LEVEL.dante, 3, e.x, e.y ?? 0, e.z);
          break;
        case 'shield': {
          play(0x43a);
          // 0x1708: the level's script 8, a ring closing on the kart over 15 frames
          const spawn = { x: e.x, y: e.y ?? 160 * U, z: e.z };
          kit.real.play(lvl, 8, spawn.x, spawn.y, spawn.z, { at: () => {
            const actor = kit.actorForSlot(e.s);
            return actor && kit.poseTick(e.s) > e.t + 1 ? actor.holder.position : spawn;
          } });
          break;
        }
        case 'barrel':
          // FUN_800b6474: a hit barrel blows up (pack script 1, 210 u up). Legacy reappearance events use level script 9.
          if (e.v === 1) kit.real.play(PACK, 1, e.x, 210 * U, e.z);
          else kit.real.play(lvl, 9, e.x, 0, e.z);
          break;
        case 'explode':
        case 'missilePop':
          if (e.k === 'explode') kit.real.play(PACK, 1, e.x, e.v, e.z); // FUN_800bf460: pack script 1 at the missile
          play(0x43d);
          break;
        case 'missileBounce':
          play(e.v);
          break;
        case 'raceSound':
          play(e.v);
          break;
        case 'hop':
          play(0x68d + e.s);
          break;
        case 'spoke':
          if (e.v > 0) play(e.v === 1 ? 0x673 : 0x674);
          break;
        case 'monster':
          if (e.v === 1) play(variant === 'dante' ? 0x69b : 0x665);
          break;
        case 'hit': {
          const char = kit.look(e.s).char;
          const seaHit = [0x687, 0x686, 0x688, 0x685, 0x68c, 0x68a, 0x68b, 0x689][DISC_CHARACTER[char] - 1];
          hitVoice('a2', char, DASH_FULL, e.v, undefined, variant === 'splash' ? () => play(seaHit) : undefined);
          break;
        }
        case 'fall':
          play(e.v === 1 ? 0x650 + e.s : 0x655);
          // FUN_800bafc8: the kart comes back 1400 u up in the level's burst (script 9; Splash script 5)
          if (e.v === 2) kit.real.play(lvl, variant === 'splash' ? 5 : 9, e.x, 1400 * U, e.z);
          break;
        case 'lap': {
          play(0x656 + e.s);
          break;
        }
      }
    },

    /** Real HUD: face, orange arrow + fuel bar, laps left (two big digits), clock. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      const d = w.data;
      for (let slot = 0; slot < 4; slot++) {
        const f = faceSprite(ctx.seats, slot);
        if (!f) continue;
        out.push(f, ...barRow(slot, (d.fuel?.[slot] ?? 0) / 0x10000, hudTex(33), 30, 24, -19, 32, 5));
        out.push(...bigNumber(Math.max(0, DR_LAPS - (d.lap?.[slot] ?? 0)), SLOT_X[slot] + 14, 44, 2, 19, 21));
      }
      out.push(...arenaClockSprites('dashRace', w));
      return out;
    },

    hud(w, slot) {
      const d = w.data;
      const left = Math.max(0, DR_LAPS - (d.lap?.[slot] ?? 0));
      if ((d.finish?.[slot] ?? -1) >= 0) return 'FINISHED';
      const it = d.item?.[slot] ?? 0;
      return `${String(left).padStart(2, '0')} LAPS LEFT · FUEL ${Math.round(((d.fuel?.[slot] ?? 0) / 0x10000) * 100)}%${it ? (it === 1 ? ' · MISSILE' : ' · SHIELD') : ''}`;
    },

    dispose() {
      for (const batch of exhaust.values()) batch.dispose();
      exhaust.clear();
      ambience?.stop(); ambience = null;
      for (const engine of engines.values()) engine.sample.stop();
      engines.clear();
      for (const o of objs.values()) kit.root.remove(o);
      for (const o of shadows.values()) o.removeFromParent();
      shadows.clear();
      objs.clear();
      blobModels.clear();
      result = undefined;
      heldItems.clear();
      kit.dispose();
    },
  };
}

