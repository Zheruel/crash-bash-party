import * as THREE from 'three';
import { DR_BARRELS, DR_K, DR_LAPS, DR_TRACKS, trackCentre, trackRadii } from '../../shared/games/dashRace';
import { CHARACTERS } from '../../shared/look';
import { getCatalog, type ModelInstance, type ModelRef } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { DASH_SFX } from './dashRaceSfx';
const DASH_BANK: Record<string, string> = { dot: '0175', toxic: '0174', splash: '0173', dante: '0172' };
import { catalogInstance, disposeTree, HpBar, Kit, preloadCatalogFor, TextSprite } from './kit';
import type { ActorParts } from './kit';
import { preloadFx } from './realFx';
import { createCharacter } from '../characters';
import { barRow, bigClock, bigNumber, faceSprite, hudTex, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type LevelStageOpts, type Placements } from './ps1cam';

/**
 * Crash Dash view. The four tracks are the real stages (assets/stages/dashRace.json, model units x DR_K, origin =
 * stage origin) seen from the real fixed camera, which is common to all four (fitted against the original frames):
 * a high three-quarter view of the whole ring from the south. Karts are the per-level vehicle models (hover pods
 * on Dot / Toxic / Dante, sea creatures on Splash).
 */

/** model-unit camera (x DR_K) */
const KART_S = 1; // karts are in level units (3.4 per 1024 u), like the stage
const CAM = { p: [0, 4.2, 8.5] as const, pitch: 22.3, fov: 33.5 };

interface Look { bg: number; hemi: [number, number, number] }
const LOOKS: Record<string, Look> = {
  dot: { bg: 0x101830, hemi: [0xffffff, 0xc0c8e0, 1.5] },
  toxic: { bg: 0x0a1408, hemi: [0xffffff, 0xb8c8a8, 1.5] },
  splash: { bg: 0x0a2a58, hemi: [0xffffff, 0xb0c8e8, 1.5] },
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
  dante: { skip: ['extra_96cc'], native: ['part54'] },
};
/**
 * Real effects (re/notes/crashDash.md "Effects"): the level model carries the effect scripts (9 = respawn burst, 5 = Splash
 * respawn bubble, 8 = shield ring, 4 / 10 / 3 / 1 = Dante volcano blast / rock fire / smoke / explosion, 10 = Toxic spit);
 * object pack 0760 has the missile trail (script 0), the explosion (script 1) and the exhaust flip-books.
 */
const FX_LEVEL: Record<string, number> = { dot: 643, toxic: 639, splash: 641, dante: 637 };
const PACK = 760, POLAR = 403, U = DR_K / 1024;
const seq = (a: number, n: number) => Array.from({ length: n }, (_, i) => a + i);
/** exhaust puffs, one part per 30 Hz tick: 0x170a boost fire, 0x1709 run smoke (first frame held 3 ticks), 0x1711 Splash spray */
const EX_BOOST = seq(40, 16), EX_RUN = [26, 26, 26, ...seq(28, 14)], EX_SEA = seq(56, 16);
const placements = new Map<string, Placements | null>();
const arenaRef = (v: string) => (getCatalog().arenas as Record<string, ModelRef>)[`dashRace:${ARENA[v]}`];

function inst(name: string): THREE.Object3D | null {
  const i = catalogInstance(getCatalog().props[name]);
  return i ? i.root : null;
}

/** the spinning wumpa fruit sprite of the shared pack 0736 (14 frames, parts 23-36), played as a billboard flip-book */
const FRUIT_FRAMES = Array.from({ length: 14 }, (_, i) => `dashRace.fruit${i}`);
function makeFruit(): THREE.Group {
  const frames = FRUIT_FRAMES.map((n) => inst(n));
  if (frames.every((f) => f)) {
    const g = new THREE.Group();
    const bb = new THREE.Group();
    bb.name = 'bb';
    bb.position.y = 0.55;
    frames.forEach((f, i) => { f!.visible = i === 0; bb.add(f!); });
    g.add(bb);
    g.userData.frames = frames;
    return g;
  }
  const g = new THREE.Group();
  const f = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), new THREE.MeshBasicMaterial({ color: 0xf2801c }));
  f.scale.y = 1.12; f.position.y = 0.55;
  const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 6), new THREE.MeshBasicMaterial({ color: 0x3a9a2a }));
  leaf.position.y = 0.98;
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
  const bars = new Map<number, HpBar>();
  const itemTxt = new Map<number, TextSprite>();
  const spin = new Map<number, number>();
  /** exhaust counters (S+0x48 boost, S+0x4c run), 30 Hz ticks; missile trail counters and rock fire loops by body id */
  const exB = [0, 0, 0, 0], exR = [0, 0, 0, 0];
  const trailT = new Map<number, number>();
  let rockTick = -1;
  let monster: THREE.Object3D | null = null;
  let barrels: THREE.Object3D[] = [];
  let monH = 3;
  const decor: { o: THREE.Object3D; kind: string; inst?: ModelInstance }[] = [];

  // everything for every track: preload() can run before init() has picked the variant
  const propNames = () => [
    ...CHARACTERS.flatMap((c) => [`dashRace.kart.${c.id}`, `dashRace.sea.${c.id}`]),
    'dashRace.missile', 'dashRace.star', 'dashRace.dante.rock', ...FRUIT_FRAMES,
        'dashRace.toxic.monster', 'dashRace.toxic.barrel', 'dashRace.toxic.slime', 'dashRace.toxic.arrow',
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
    decor.length = 0; monster = null; barrels = [];
    const ref = arenaRef(variant);
    // the real level: every static object from the game's own object list (towers, lamps, arrows, backdrops, grass)
    const lvl = ref ? levelStage(ref, placements.get(variant) ?? null, (r) => catalogInstance(r)?.root ?? null, OPTS[variant]) : null;
    if (lvl) {
      // Splash's start line object sits 79 units under the floor; the PS1 has no depth buffer and its ordering table
      // draws it over the floor anyway, so lift it to floor level (then the decal offset wins the coplanar fight)
      const line = lvl.getObjectByName('0x5002:extra_57e4');
      if (line && variant === 'splash') { line.matrix.elements[13] += (79 * (ref?.scale ?? 1)) / 1024; line.matrixWorldNeedsUpdate = true; }
      R.add(lvl);
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
      // the game's 11 barrels (array at 0x800c6f88, game units); a hit barrel disappears for ~3 s
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
      place('dashRace.toxic.slime', 0, 0, { y: 0.2 });
      const m = place('dashRace.toxic.monster', 0, 0);
      if (m) { monster = m; m.visible = false; }
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

  function aim(ctx: { camera: THREE.PerspectiveCamera }) {
    const cam = ctx.camera;
    const lc = LEVEL_CAMS[LEVEL[variant]];
    if (lc && placements.get(variant)) { applyPose(cam, ps1Pose(lc, arenaRef(variant))); return; }
    const pr = (CAM.pitch * Math.PI) / 180;
    const [x, y, z] = CAM.p;
    cam.position.set(x * DR_K, y * DR_K, z * DR_K);
    cam.lookAt(x * DR_K, (y - Math.sin(pr) * 10) * DR_K, (z - Math.cos(pr) * 10) * DR_K);
    if (Math.abs(cam.fov - CAM.fov) > 1e-3) { cam.fov = CAM.fov; cam.updateProjectionMatrix(); }
  }

  /** real game sfx id -> the level bank's sample (ids >= 0x661 are unmapped = silent in the original) */
  const play = (id: number, vol = 0.45) => { const f = DASH_SFX[variant]?.[id]; if (f) sfx.playFile(f, vol, false, sfxRate(DASH_BANK[variant], id)); };

  return {
    id: 'dashRace',
    async preload() {
      await Promise.all([preloadCatalogFor('dashRace', propNames()), preloadFx([PACK, POLAR, ...Object.values(FX_LEVEL)]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'dot';
      const L = LOOKS[variant] ?? LOOKS.dot;
      objs.clear(); bars.clear(); itemTxt.clear(); spin.clear(); exB.fill(0); exR.fill(0); trailT.clear(); rockTick = -1;
      kit = new Kit(ctx, 'dashRace', { bg: L.bg, hemi: L.hemi });
      kit.realFx(DR_K);
      build();
      aim(ctx);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); kit.realFx(DR_K); build(); } });
    },

    render(ctx, w, dt) {
      aim(ctx);
      kit.checkOver(w);
      const d = w.data;
      const [hx, hz] = trackCentre(variant);
      for (let i = 0; i < barrels.length; i++) if (barrels[i]) barrels[i].visible = (d.bar?.[i]?.t ?? 0) <= 0;
      // toxic monster: rises out of the hub
      if (monster) {
        const up = d.mon ?? 0;
        monster.visible = up > 0.02;
        monster.position.set(hx, -monH * (1 - up), hz);
      }
      for (const dc of decor) {
        if (dc.kind.startsWith('rod')) {
          const rods = w.bodies.filter((b) => b.kind === 'rod');
          const r = rods[Number(dc.kind.slice(3))];
          if (r && dc.inst) { dc.o.rotation.y = -(r.cd * Math.PI * 2) / 4096; dc.inst.pose(0, Math.max(0, Math.min(29, r.vy / 16))); dc.o.visible = true; }
          else if (r) { dc.o.rotation.y = Math.PI - r.face; dc.o.position.y = -0.7 + 1.4 * r.y; dc.o.visible = r.y > 0.02; }
        }
      }
      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const turbo = !!d.turbo?.[b.slot];
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          const fin = (d.finish?.[b.slot] ?? -1) >= 0;
          a.update(b, dt, { role: stun ? 'hit' : 'run', freeze: true, keepYaw: stun });
          a.holder.rotation.y = 0;
          a.holder.position.y = b.y + 0.12 + Math.sin(ctx.time * 5 + b.slot) * 0.03;
          // exhaust (FUN_800ba278): a puff 200 u behind the kart every 5 ticks boosting (0x170a), every 7 running (0x1709)
          const sp = Math.hypot(b.vx, b.vz), run = !turbo && !stun && !fin && sp > 40 * U * 30;
          if (turbo || run) {
            const T = turbo ? exB : exR;
            T[b.slot] -= dt * 30;
            if (T[b.slot] <= 0) {
              T[b.slot] += turbo ? 5 : 7;
              const sea = variant === 'splash', fr = sea ? EX_SEA : turbo ? EX_BOOST : EX_RUN;
              kit.real.sprite(sea || turbo ? PACK : POLAR, fr, b.x - Math.sin(b.face) * 200 * U, 256 * U, b.z - Math.cos(b.face) * 200 * U, { life: fr.length / 30, add: !sea && !turbo }); // 0x1709 sets node flag 0x21 (blended); the fire and spray frames do not
            }
          } else { exB[b.slot] = exR[b.slot] = 0; }
          // fuel bar + held item
          let bar = bars.get(b.slot);
          if (!bar) { bar = new HpBar(1.3); kit.root.add(bar.group); bars.set(b.slot, bar); }
          bar.group.visible = false; // the real game shows fuel only in the HUD (ps1Hud bar row)
          bar.group.position.set(b.x, a.headY + 0.9, b.z);
          const f = (d.fuel?.[b.slot] ?? 0) / 0x10000;
          bar.set(f);
          (bar.group.children[1] as THREE.Sprite).material.color.set(turbo ? 0xffffff : f > 0.3 ? 0x4ade80 : 0xf43f5e);
          let it = itemTxt.get(b.slot);
          if (!it) { it = new TextSprite('#ffffff', 0.7); kit.root.add(it.sprite); itemTxt.set(b.slot, it); }
          const item = d.item?.[b.slot] ?? 0;
          it.sprite.visible = false; // no word label over the kart in the real game
          if (item > 0) { it.set(item === 1 ? 'MISSILE' : 'SHIELD'); it.sprite.position.set(b.x, a.headY + 1.5, b.z); }
        } else if (b.kind === 'fruit' || b.kind === 'item' || b.kind === 'missile' || b.kind === 'rock') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'fruit' ? makeFruit() : b.kind === 'item' ? makeItem(b.dash === 5) : b.kind === 'missile' ? makeMissile() : rockModel();
            kit.root.add(o);
            objs.set(b.id, o);
          }
          o.visible = !((b.kind === 'fruit' || b.kind === 'item') && b.cd > 0);
          if (b.kind === 'fruit' && o.userData.frames) { // flip-book at 15 fps, facing the camera
            o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.1, b.z);
            const fr = o.userData.frames as THREE.Object3D[], k = Math.floor(ctx.time * 15 + b.id) % fr.length;
            fr.forEach((f, i) => (f.visible = i === k));
            o.getObjectByName('bb')!.quaternion.copy(ctx.camera.quaternion);
          } else if (b.kind === 'fruit' || b.kind === 'item') { o.position.set(b.x, 0, b.z); o.rotation.y -= dt * 30 * 0x80 * Math.PI * 2 / 4096; }
          else if (b.kind === 'missile') { o.position.set(b.x, 0.7, b.z); o.rotation.y = Math.atan2(b.vx, b.vz); 
            // trail: pack script 0 every 3 ticks (FUN_800bf460)
            const t = (trailT.get(b.id) ?? 0) - dt * 30;
            trailT.set(b.id, t <= 0 ? t + 3 : t);
            if (t <= 0) kit.real.play(PACK, 0, b.x, 0.7, b.z);
          } else {
            o.position.set(b.x, b.y, b.z); o.rotation.y += dt * 6;
            if (!trailT.has(b.id)) {
              trailT.set(b.id, 0);
              const first = Math.abs(w.tick - rockTick) > 30;
              if (first) rockTick = w.tick;
              if (variant === 'dante') {
                // FUN_800c2388: blast (script 4) at the crater on launch, fire (script 10, looping) riding each rock
                if (first) kit.real.play(FX_LEVEL.dante, 4, 0, 0, 0);
                kit.real.play(FX_LEVEL.dante, 10, b.x, b.y, b.z, { loop: true, at: () => objs.get(b.id)?.position ?? null });
              } else if (first) kit.real.play(FX_LEVEL.toxic, 10, -512 * U, 668 * U, 512 * U); // FUN_800c2e10: the monster's spit
            }
            if (variant === 'dante') { // a smoke puff (script 3) every 8-10 ticks in flight
              const t = trailT.get(b.id)! - dt * 30;
              trailT.set(b.id, t <= 0 ? t + 9 : t);
              if (t <= 0) kit.real.play(FX_LEVEL.dante, 3, b.x, b.y, b.z);
            }
          }
        }
      }
      for (const [id, o] of objs) if (!seenO.has(id)) {
        // a Dante rock ends in the level's explosion (script 1)
        if (variant === 'dante' && trailT.has(id) && !kit.over.done) kit.real.play(FX_LEVEL.dante, 1, o.position.x, o.position.y, o.position.z);
        trailT.delete(id);
        kit.root.remove(o); disposeTree(o); objs.delete(id);
      }
      kit.prune(seen);
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      const lvl = FX_LEVEL[variant] ?? FX_LEVEL.dot;
      switch (e.k) {
        case 'turbo':
          play(0x648 + e.s, 0.35);
          if (e.s === ctx.mySlot) kit.shake(0.08);
          break;
        case 'pickup':
          play(e.v === 1 ? 0x51f : 0x1c2, 0.4);
          break;
        case 'missile':
          play(0x522, 0.5);
          break;
        case 'shield': {
          // 0x1708: the level's script 8, a ring closing on the kart over 15 frames
          const a = kit.actorForSlot(e.s);
          kit.real.play(lvl, 8, e.x, 256 * U, e.z, { at: () => (a ? { x: a.holder.position.x, y: 256 * U, z: a.holder.position.z } : null) });
          break;
        }
        case 'barrel':
          // FUN_800b6474: a hit barrel blows up (pack script 1, 210 u up); it comes back in the level's burst (script 9)
          if (e.v === 1) kit.real.play(PACK, 1, e.x, 210 * U, e.z);
          else kit.real.play(lvl, 9, e.x, 0, e.z);
          break;
        case 'explode':
          kit.real.play(PACK, 1, e.x, 0.7, e.z); // FUN_800bf460: pack script 1 at the missile
          kit.shake(0.3);
          play(0x43d, 0.6);
          break;
        case 'hit':
          kit.actorForSlot(e.s)?.hit(1);
          if (e.s === ctx.mySlot) kit.shake(0.25);
          play(0x654, 0.5);
          break;
        case 'fall':
          play(e.v === 1 ? 0x650 + e.s : 0x655, 0.5);
          // FUN_800bafc8: the kart comes back 1400 u up in the level's burst (script 9; Splash script 5)
          if (e.v === 2) kit.real.play(lvl, variant === 'splash' ? 5 : 9, e.x, 1400 * U, e.z);
          break;
        case 'wall':
          play(0x64c + (e.id & 3), 0.25);
          break;
        case 'bump':
          if (e.s < 0 && e.v > 0.15) play(0x640 + ((e.id & 3) as number), 0.3 * e.v + 0.1);
          break;
        case 'lap': {
          play(0x656 + e.s, 0.4);
          break;
        }
        case 'finish':
          kit.shake(0.2);
          break;
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
      out.push(...bigClock((getGame('dashRace')?.maxTime ?? 90) - w.time, Math.floor(w.time * 2) % 2 === 1));
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
      for (const o of objs.values()) kit.root.remove(o);
      for (const b of bars.values()) kit.root.remove(b.group);
      for (const t of itemTxt.values()) kit.root.remove(t.sprite);
      objs.clear(); bars.clear(); itemTxt.clear();
      kit.dispose();
    },
  };
}

