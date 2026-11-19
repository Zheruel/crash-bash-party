import * as THREE from 'three';
import { TA_HP, TA_K, TA_MAPS } from '../../shared/games/tankArena';
import { createCharacter } from '../characters';
import type { ActorParts } from './kit';
import { canvasTexture, catalogInstance, disposeTree, hasProp, Kit, makeCrate, preloadCatalogFor, propObject } from './kit';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx, sfxRate } from '../shell/sound';
import { TANK_SFX } from './tankArenaSfx';
/** level sfx bank per variant (the id -> tone table and its pitches are per level) */
const TANK_BANK: Record<string, string> = { swamp: '0159', desert: '0162', jungle: '0160', metal: '0161' };
import { barRow, bigClock, faceSprite, FRUIT_ICON, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
import type { ModelRef } from '../crash';
import { preloadFx } from './realFx';
import { charVoice } from '../shell/voice';

/**
 * Real effects (re/notes/tankWars.md "Effects"): object pack 0786's effect scripts, by weapon id (8, 9, 10, 11 = the
 * character guns, 2 = double shot): muzzle flash at the shell's start, trail, and the burst where the shell ends
 * (FUN_800b77e8 / FUN_800baffc); pack 0784 parts 24-32 = the smoke puff (object 0x1306) left where a shell ends on levels 6-8.
 */
const PACK = 786, SMOKE = 784, U = TA_K / 1024;
const MUZZLE: Record<number, number> = { 11: 7, 8: 8, 9: 15, 10: 6 };
const SHELL_END: Record<number, number> = { 11: 10, 8: 12, 9: 13, 10: 11 };
/** [script, every n ticks] */
const SHELL_TRAIL: Record<number, [number, number]> = { 8: [2, 8], 2: [17, 2] };
const SMOKE_FRAMES = Array.from({ length: 9 }, (_, i) => 24 + i);

/**
 * Tank Wars view. The four pens are the real Crash Bash stages (assets/stages/tankArena.json, scale TA_K, centred on
 * the origin) seen from the real fixed camera: a high fixed three-quarter view of the whole pen, fitted per level
 * against the original frames (camera in stage model units relative to the pen centre).
 */

interface Cam { p: [number, number, number]; pitch: number; fov: number }
interface Look { bg: number; fog?: [number, number]; tank: number; tint: [number, number, number] }
/** model-unit camera, relative to the pen centre (multiplied by TA_K below) */
/** TANK WARS level ids (cheat 5-8) and the stage refs */
const LEVEL: Record<string, number> = { swamp: 5, desert: 6, jungle: 7, metal: 8 };
const STAGE: Record<string, string> = { swamp: 'swampFox', desert: 'desertFox', jungle: 'jungleFox', metal: 'metalFox' };
const placements = new Map<string, Placements | null>();
const stageRef = (v: string) => (getCatalog().arenas as Record<string, ModelRef>)[`tankArena:${STAGE[v]}`];
const CAMS: Record<string, Cam> = {
  metal: { p: [0.043, 3.067, 4.642], pitch: 32.83, fov: 40.66 },
  desert: { p: [0.027, 3.56, 4.665], pitch: 37.54, fov: 38.64 },
  jungle: { p: [-0.146, 2.749, 3.876], pitch: 35.81, fov: 53.46 },
  swamp: { p: [-0.1, 2.749, 4.08], pitch: 35.81, fov: 53.46 },
};
const LOOKS: Record<string, Look> = {
  swamp: { bg: 0x08140d, tank: 0x8e969a, tint: [1, 1, 1] },
  desert: { bg: 0xd6b878, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
  jungle: { bg: 0x030a05, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
  metal: { bg: 0x0a0d18, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
};

interface TankVis { group: THREE.Group; treads: ReturnType<typeof catalogInstance> }

function plankTexture(base: string, dark: string): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = dark;
    for (let i = 0; i < 12; i++) g.fillRect(0, (i * s) / 12 + ((i * 7) % 5), s, 1 + (i % 2));
    for (let i = 0; i < 10; i++) g.fillRect((i * 37) % s, 0, 1, s);
  }, [1, 1]);
}

/** Swamp Fox: no stage model was extracted, so build it from the original frames: black water pit, wooden fence, forest wall. */
function buildSwamp(R: THREE.Group, hx: number, hz: number) {
  const pit = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2 + 9, hz * 2 + 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x010403 }));
  pit.position.y = -0.04;
  R.add(pit);
  // sunken muddy bank outside the fence
  const bank = new THREE.Mesh(new THREE.PlaneGeometry(90, 60).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b1a10 }));
  bank.position.set(0, -0.5, -22);
  R.add(bank);
  const wood = new THREE.MeshBasicMaterial({ map: plankTexture('#6b5a45', '#33281c') });
  const moss = new THREE.MeshBasicMaterial({ color: 0x3d5a34 });
  const fx = hx + 0.5, fz = hz + 0.5;
  const post = (x: number, z: number, h: number, lean: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.2), wood);
    m.position.set(x, h / 2 - 0.1, z); m.rotation.z = lean; m.rotation.x = lean * 0.6;
    R.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.24), moss);
    cap.position.set(x, h - 0.12, z);
    R.add(cap);
  };
  const rail = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.12), wood);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    R.add(m);
  };
  const side = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.1));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      post(x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, 1.1 + ((i * 37) % 5) * 0.06, (((i * 13) % 7) - 3) * 0.02);
    }
    rail(x0, z0, x1, z1, 0.55);
    rail(x0, z0, x1, z1, 0.9);
  };
  side(-fx, -fz, fx, -fz); side(fx, -fz, fx, fz); side(fx, fz, -fx, fz); side(-fx, fz, -fx, -fz);
  // forest wall: thick mossy trunks, hanging green mist
  const bark = new THREE.MeshBasicMaterial({ map: canvasTexture(64, (g, s) => {
    g.fillStyle = '#2d3a22'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) { g.fillStyle = i % 3 ? '#1d2616' : '#4a5a30'; g.fillRect((i * 29) % s, 0, 2 + (i % 3), s); }
  }, [2, 3]) });
  for (let i = 0; i < 16; i++) {
    const x = -22 + i * 3 + ((i * 7) % 5) * 0.4, z = -hz - 6 - ((i * 5) % 4) * 1.4;
    const r = 0.9 + ((i * 3) % 4) * 0.35;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, 22, 8), bark);
    t.position.set(x, 8, z);
    R.add(t);
  }
  const mist = new THREE.Mesh(new THREE.PlaneGeometry(80, 10), new THREE.MeshBasicMaterial({ color: 0x1f4a2a, transparent: true, opacity: 0.5, depthWrite: false }));
  mist.position.set(0, 3, -hz - 5.2);
  R.add(mist);
}

/** Procedural pen used only when the catalog stage is missing */
function buildFallback(R: THREE.Group, hx: number, hz: number, variant: string) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: variant === 'desert' ? 0xcaa868 : variant === 'jungle' ? 0x6a5a30 : 0x3a4254 }));
  R.add(floor);
  for (const [x, z, w, d] of [[0, -hz - 0.15, hx * 2 + 0.6, 0.3], [0, hz + 0.15, hx * 2 + 0.6, 0.3], [-hx - 0.15, 0, 0.3, hz * 2], [hx + 0.15, 0, 0.3, hz * 2]]) {
    const wl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), new THREE.MeshBasicMaterial({ color: 0x6a6f7e }));
    wl.position.set(x, 0.35, z);
    R.add(wl);
  }
  for (const [cx, cz, hw, hd] of TA_MAPS[variant].blocks) {
    const c = makeCrate(1, 'steel');
    c.scale.set(hw * 2, 0.5, hd * 2);
    c.position.set(cx, 0, cz);
    R.add(c);
  }
}

/** Spiked ball mine (the real mines are black balls with spikes) */
function makeMine(hex: string): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshBasicMaterial({ color: 0x2a2c34 }));
  body.position.y = 0.26;
  g.add(body);
  const spike = new THREE.ConeGeometry(0.06, 0.18, 5);
  const sm = new THREE.MeshBasicMaterial({ color: 0x6a6e7a });
  const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.7, 0, 0.7], [-0.7, 0, -0.7], [0.7, 0, -0.7], [-0.7, 0, 0.7]];
  for (const d of dirs) {
    const s = new THREE.Mesh(spike, sm);
    const v = new THREE.Vector3(...d).normalize();
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    s.position.copy(v).multiplyScalar(0.27).add(new THREE.Vector3(0, 0.26, 0));
    g.add(s);
  }
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
  top.position.y = 0.5; top.name = 'light';
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
  ring.position.y = 0.02;
  g.add(top, ring);
  return g;
}

/** lit-fuse bomb flip-book (0786 parts 11-18) and the mine-blast fire flip-book (0784 parts 24-32) */
const BOMB_FRAMES = Array.from({ length: 8 }, (_, i) => `taBomb${i}`);
const FLAME_FRAMES = Array.from({ length: 9 }, (_, i) => `taFlame${i}`);
/** the 0736 wumpa flip-book (render ids 0x2018-0x2025) */
const TA_FRUIT = Array.from({ length: 14 }, (_, i) => `taFruit${i}`);
function flipBook(names: string[]): THREE.Group | null {
  const fr = names.map((n) => catalogInstance(getCatalog().props[n])?.root ?? null);
  if (!fr.every((f) => f)) return null;
  const g = new THREE.Group();
  fr.forEach((f, i) => { f!.visible = i === 0; g.add(f!); });
  g.userData.frames = fr;
  return g;
}
function stepFlipBook(o: THREE.Object3D, t: number, fps: number) {
  const fr = o.userData.frames as THREE.Object3D[] | undefined;
  if (!fr) return false;
  const k = Math.floor(t * fps) % fr.length;
  fr.forEach((f, i) => (f.visible = i === k));
  return true;
}
function makeFlame(): THREE.Group {
  const fb = flipBook(FLAME_FRAMES);
  if (fb) return fb;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.9 })));
  return g;
}


function makeBomb(): THREE.Group {
  const fb = flipBook(BOMB_FRAMES);
  if (fb) return fb;
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 12), new THREE.MeshBasicMaterial({ color: 0x24242c }));
  const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
  fuse.position.y = 0.36;
  g.add(b, fuse);
  return g;
}

/** pickup types: 2 double shot, 3 bomb, 4 wumpa fruit (+20 hp), 5 mine, 6 bad crate (-30 hp) */
function makePickup(kind: number): THREE.Group {
  const g = new THREE.Group();
  if (kind === 4) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), new THREE.MeshBasicMaterial({ color: 0xf0801c }));
    f.position.y = 0.55;
    f.scale.y = 1.12;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 6), new THREE.MeshBasicMaterial({ color: 0x3a9a2a }));
    leaf.position.y = 0.95;
    g.add(f, leaf);
  } else if (kind === 6) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial({ color: 0xc0302a }));
    c.position.y = 0.5;
    g.add(c);
  } else if (kind === 2) {
    const m = new THREE.Group();
    for (const x of [-0.14, 0.14]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 8).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23f })); b.position.x = x; m.add(b); }
    m.position.y = 0.55;
    g.add(m);
  } else {
    const m = kind === 3 ? makeBomb() : makeMine('#ffe14a');
    m.position.y = 0.3; m.scale.setScalar(1.25);
    g.add(m);
  }
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.58, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.8, depthWrite: false }));
  halo.position.y = 0.03;
  g.add(halo);
  return g;
}

/** Fallback hover tank when the catalog model is missing, also used for the Swamp Fox airboat look */
function makeTank(hex: number, boat: boolean): THREE.Group {
  const g = new THREE.Group();
  const team = new THREE.MeshBasicMaterial({ color: hex });
  const dark = new THREE.MeshBasicMaterial({ color: 0x23252e });
  const steel = new THREE.MeshBasicMaterial({ color: 0xa8b0bc });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.34, 1.5), team);
  hull.position.y = 0.3;
  g.add(hull);
  if (boat) {
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.4), team); bow.position.set(0, 0.26, 0.85); bow.rotation.x = -0.3;
    const fan = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 14), steel); fan.position.set(0, 0.75, -0.7);
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12).rotateX(Math.PI / 2), dark); cage.position.set(0, 0.75, -0.72);
    g.add(bow, fan, cage);
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 8).rotateX(Math.PI / 2), steel);
  barrel.position.set(0, 0.62, 0.75);
  g.add(barrel);
  return g;
}

export function createTankArenaView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'swamp';
  const tanks = new Map<number, TankVis>();
  const shells = new Map<number, { obj: THREE.Group; slot: number; wpn: number; t: number }>();
  const lastHp: number[] = [3, 3, 3, 3];
  const objs = new Map<number, THREE.Object3D>();

  function build(world: { data: Record<string, any> }) {
    const R = kit.root;
    const { hx, hz } = TA_MAPS[variant];
    // the real level: the game's own static objects, placed as the game does
    const ref = stageRef(variant);
    const lvl = ref ? levelStage(ref, placements.get(variant) ?? null, (r) => catalogInstance(r)?.root ?? null) : null;
    if (lvl) R.add(lvl);
    const arena = lvl ?? kit.addArena(variant, 0);
    if (!arena) { if (variant === 'swamp') buildSwamp(R, hx, hz); else buildFallback(R, hx, hz, variant); }
    if (variant === 'jungle' && !lvl) { // fallback: leaf sprays dotted round the clearing
      const ref = getCatalog().props['tankArena.foliage'];
      const spots: [number, number, number, number][] = [[-3.0, -2.2, 0.4, 0.5], [-2.0, -3.1, 1.2, 0.8], [0.3, -3.2, 2.4, 0.7], [2.2, -3.1, 3.6, 0.8], [3.6, -1.9, 4.5, 0.6], [-3.4, 0.2, 5.5, 0.7], [3.7, 1.2, 0.9, 0.6], [-3.1, 2.4, 2.1, 0.6]];
      for (const [x, z, yaw, sc] of spots) {
        const f = catalogInstance(ref);
        if (!f) break;
        f.root.position.set(x * TA_K, 0.15, z * TA_K);
        f.root.rotation.y = yaw;
        f.root.scale.setScalar(sc);
        R.add(f.root);
      }
    }
  }

  /** turret part by the character's own weapon (engine char 1,2 -> 9; 3,4 -> 11; 5,6 -> 10; 7,8 -> 8) */
  const TURRET: Record<number, number> = { 1: 9, 2: 9, 3: 11, 4: 11, 5: 10, 6: 10, 7: 8, 8: 8 };
  function makeParts(slot: number, char: number): ActorParts {
    const L = LOOKS[variant] ?? LOOKS.metal;
    // pilot: the character's in-tank model, drawn at the stage's raw scale (same 2.6 units as the level)
    const inst = createCharacter(kit.look(slot), { variant: 'tank', ring: false });
    inst.root.rotation.y = Math.PI; // the tank set (pilot, treads, turret) faces PS1 +z like every 0784 part
    const vis = new THREE.Group(); // hull (counter-rotated to the hull yaw below)
    const cat = getCatalog().props;
    let treads: ReturnType<typeof catalogInstance> = null;
    if (variant === 'swamp') treads = catalogInstance(cat.taHover);
    else treads = catalogInstance(cat.taTreads);
    if (treads) { treads.root.rotation.y = Math.PI; vis.add(treads.root); treads.play('idle'); }
    else vis.add(makeTank(L.tank, variant === 'swamp'));
    const holder = new THREE.Group();
    holder.add(vis);
    if (variant !== 'swamp') {
      const tur = catalogInstance(cat[`taTurret${TURRET[char] ?? 9}`]);
      if (tur) { tur.root.rotation.y = Math.PI; holder.add(tur.root); }
    }
    tanks.set(slot, { group: vis, treads });
    return { inst, extra: holder, steady: true, shadow: 0.9, headY: 1.3, scale: 1 };
  }

  /** the crate-dropping drone (levels 5-7): pack 0784 animated part13 (anim 0x4080 = clip 1), shadow part14 under it */
  function dropper(): THREE.Group {
    const g = new THREE.Group();
    const inst = catalogInstance(getCatalog().props.taDropper);
    const body = new THREE.Group();
    if (inst) { inst.root.rotation.y = Math.PI; body.add(inst.root); inst.play('idle'); g.userData.inst = inst; }
    g.add(body);
    g.userData.body = body;
    const sh = catalogInstance(getCatalog().props.taDropperShadow);
    if (sh) { // node flags 0x40000041: the shadow is drawn subtractive on the floor
      sh.root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; const q = (m.material as THREE.MeshBasicMaterial).clone(); q.blending = THREE.SubtractiveBlending; q.transparent = true; q.depthWrite = false; m.material = q; m.renderOrder = 2; });
      sh.root.position.y = 0.02;
      g.add(sh.root);
    }
    return g;
  }
  /** a pickup: the descending crate (0786 part42) and the landed item by type: 2 double 0784 part6, 3 bomb 0736 part11, 4 +20 hp
   *  0736 wumpa flip-book (parts 23-36, blended), else (mine / bad crate) 0784 part18 */
  function tankPickup(kind: number): THREE.Group {
    const g = new THREE.Group();
    const fall = realProp('taDrop');
    if (fall) { g.add(fall); g.userData.fall = fall; }
    const item = kind === 4 ? flipBook(TA_FRUIT) : realProp(kind === 2 ? 'taDouble' : kind === 3 ? 'taBombPick' : 'taMinePick');
    const it = item ?? makePickup(kind);
    g.add(it); g.userData.item = it;
    return g;
  }
  function realProp(name: string): THREE.Group | null {
    const inst = catalogInstance(getCatalog().props[name]);
    if (!inst) return null;
    const g = new THREE.Group();
    inst.root.rotation.y = Math.PI;
    g.add(inst.root);
    return g;
  }

  /** shell: the game's missile mesh (0784 part6), nose along the flight direction */
  function makeShell(slot: number): THREE.Group {
    const real = realProp('taMissile');
    if (real) return real;
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(slot)) }));
    g.add(core);
    return g;
  }

  function aim(ctx: { camera: THREE.PerspectiveCamera }) {
    const lc = LEVEL_CAMS[LEVEL[variant]];
    const ref = stageRef(variant);
    if (lc && ref && placements.get(variant)) { applyPose(ctx.camera, ps1Pose(lc, ref)); return; }
    const c = CAMS[variant] ?? CAMS.metal;
    const cam = ctx.camera;
    const pr = (c.pitch * Math.PI) / 180;
    cam.position.set(c.p[0] * TA_K, c.p[1] * TA_K, c.p[2] * TA_K);
    cam.lookAt(c.p[0] * TA_K, (c.p[1] - Math.sin(pr) * 10) * TA_K, (c.p[2] - Math.cos(pr) * 10) * TA_K);
    if (Math.abs(cam.fov - c.fov) > 1e-3) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
  }

  return {
    id: 'tankArena',
    async preload() {
      await Promise.all([preloadCatalogFor('tankArena', ['taTreads', 'taHover', 'taTurret8', 'taMine0', 'taCrate', 'taMissile', 'taDropper', 'taDropperShadow', 'taDrop', 'taDouble', 'taBombPick', 'taMinePick', ...TA_FRUIT, 'tank', ...BOMB_FRAMES, ...FLAME_FRAMES]), preloadFx([PACK, SMOKE]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'swamp';
      const L = LOOKS[variant] ?? LOOKS.metal;
      kit = new Kit(ctx, 'tankArena', { bg: L.bg, hemi: [0xffffff, 0xffffff, 1.2] });
      kit.realFx(TA_K);
      tanks.clear(); shells.clear(); objs.clear(); lastHp.fill(TA_HP);
      build(world);
      aim(ctx);
      if (!loaded) this.preload!().then(() => { tanks.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      aim(ctx);
      kit.checkOver(w);
      const d = w.data;
      const seen = new Set<number>();
      const seenShell = new Set<number>();
      const seenObj = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'tank') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot, d.tk?.[b.slot]?.char ?? b.slot + 1));
          const tk = d.tk?.[b.slot];
          const st = tk?.st ?? 0x6e;
          const inv = (tk?.inv ?? 0) > 0;
          a.update(b, dt, { hidden: st === 0x6b, blink: inv, role: kit.over.done ? undefined : st === 0x69 || st === 0x6a ? 'hit' : 'idle', freeze: true });
          const t = tanks.get(b.slot);
          if (t) {
            if (tk) t.group.rotation.y = Math.PI - (tk.hull * Math.PI * 2) / 4096 - b.face;
            const sp = Math.hypot(b.vx, b.vz);
            t.treads?.play(sp > 0.3 ? 'run' : 'idle');
            if (sp > 0.3) t.treads?.update(dt);
          }
          a.holder.scale.setScalar(1);
        } else if (b.kind === 'mine' || b.kind === 'pickup' || b.kind === 'bomb' || b.kind === 'flame' || b.kind === 'dropper') {
          seenObj.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'mine' ? realProp(`taMine${b.slot & 3}`) ?? makeMine(kit.hex(b.slot)) : b.kind === 'bomb' ? makeBomb() : b.kind === 'flame' ? makeFlame() : b.kind === 'dropper' ? dropper() : tankPickup(Math.round(b.cd));
            kit.root.add(o);
            objs.set(b.id, o);
            if (b.kind === 'bomb') o.userData.sh = kit.fx.shadow(0.4, 0.45);
          }
          if (b.kind === 'bomb') {
            o.position.set(b.x, b.y + 0.4, b.z);
            if (!stepFlipBook(o, ctx.time + b.id, 15)) o.rotation.x += dt * 6;
            (o.userData.sh as BlobShadow).set(b.x, b.z, b.y);
          } else if (b.kind === 'mine') {
            o.position.set(b.x, 0, b.z);
            const light = o.getObjectByName('light') as THREE.Mesh | undefined;
            const urgent = b.cd <= 30;
            if (light) (light.material as THREE.MeshBasicMaterial).color.set(Math.sin(ctx.time * (urgent ? 22 : 9)) > 0 ? 0xff3a2a : 0x661810);
            o.scale.setScalar(1);
          } else if (b.kind === 'flame') {
            o.position.set(b.x, 0.3, b.z);
            if (stepFlipBook(o, ctx.time + b.id * 0.13, 20)) o.quaternion.copy(ctx.camera.quaternion);
            else o.scale.setScalar(0.8 + Math.sin(ctx.time * 30 + b.id) * 0.2);
          } else if (b.kind === 'dropper') { // faces its travel (yaw 0x400 / 0xc00), rotor clip loops; shadow node 0x200f on the floor
            o.position.set(b.x, 0, b.z);
            const prev = o.userData.px as number | undefined;
            if (prev != null && Math.abs(b.x - prev) > 1e-4) o.rotation.y = b.x > prev ? Math.PI / 2 : -Math.PI / 2;
            o.userData.px = b.x;
            const body = o.userData.body as THREE.Object3D | undefined;
            if (body) body.position.y = b.y;
            (o.userData.inst as { update(dt: number): void } | undefined)?.update(dt);
          } else { // pickup (FUN_800be988): descends as the 0786 part42 crate (dash 5), then shows its item; type 2 spins +0x28 / tick,
            // type 4 is the 0736 wumpa flip-book (+1 frame / tick)
            o.position.set(b.x, Math.max(0, b.y), b.z);
            const fall = o.userData.fall as THREE.Object3D | undefined, item = o.userData.item as THREE.Object3D | undefined;
            const down = b.dash === 5;
            if (fall) fall.visible = down;
            if (item) {
              item.visible = !down || !fall;
              if (Math.round(b.cd) === 2) item.rotation.y -= dt * 30 * 0x28 * Math.PI * 2 / 4096;
              if (Math.round(b.cd) === 4 && stepFlipBook(item, ctx.time, 30)) item.quaternion.copy(ctx.camera.quaternion);
            }
          }
        } else if (b.kind === 'bullet') {
          seenShell.add(b.id);
          let s = shells.get(b.id);
          const yaw = Math.atan2(b.vx, b.vz);
          if (!s) {
            const g = makeShell(b.slot); kit.root.add(g);
            const wpn = Math.round(b.dash);
            s = { obj: g, slot: b.slot, wpn, t: 0 }; shells.set(b.id, s);
            const m = MUZZLE[wpn];
            if (m !== undefined) kit.real.play(PACK, m, b.x, b.y, b.z, { yaw, add: true }); // muzzle flash where the shell starts
          }
          s.obj.position.set(b.x, b.y, b.z);
          s.obj.rotation.y = yaw;
          const tr = SHELL_TRAIL[s.wpn];
          if (tr) { s.t -= dt * 30; if (s.t <= 0) { s.t += tr[1]; kit.real.play(PACK, tr[0], b.x, b.y, b.z); } }
        }
      }
      kit.prune(seen);
      for (const [id, s] of shells) if (!seenShell.has(id)) {
        // FUN_800baffc: the weapon's burst where the shell ends, plus the smoke puff object on levels 6-8
        const p = s.obj.position, end = SHELL_END[s.wpn];
        if (!kit.over.done) {
          if (end !== undefined) kit.real.play(PACK, end, p.x, p.y, p.z);
          if (s.wpn !== 11 && variant !== 'swamp') kit.real.sprite(SMOKE, SMOKE_FRAMES, p.x, p.y, p.z, { life: 9 / 30, add: true });
        }
        kit.root.remove(s.obj); disposeTree(s.obj); shells.delete(id);
      }
      for (const [id, o] of objs) if (!seenObj.has(id)) { kit.root.remove(o); disposeTree(o); if (o.userData.sh) kit.fx.removeShadow(o.userData.sh); objs.delete(id); }
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      if (e.k === 'sfx') {
        // the lobbed shell's ground hops (FUN_800bba9c): sparks (script 9), a splash ring on the swamp (script 18)
        if (e.v >= 0x4d2 && e.v <= 0x4d7) kit.real.play(PACK, 9, e.x, 160 * U, e.z);
        else if (e.v >= 0x4f7 && e.v <= 0x4fa) kit.real.play(PACK, 18, e.x, 160 * U, e.z);
        const f = TANK_SFX[variant]?.[e.v];
        if (f) sfx.playFile(f, 0.4, false, sfxRate(TANK_BANK[variant], e.v));
        return;
      }
      switch (e.k) {
        case 'shoot':
          kit.actorForSlot(e.s)?.squash.kick(0.12);
          kit.shake(e.s === ctx.mySlot ? 0.05 : 0.015);
          break;
        case 'lob':
          kit.real.play(PACK, 0, e.x, 0, e.z, { add: true }); // FUN_800b71f8: script 0 at the tank as the bomb leaves
          break;
        case 'explode':
          // mine: script 16 (FUN_800bd384); thrown bomb: script 1 (FUN_800bc27c)
          kit.real.play(PACK, e.v > 1.3 ? 1 : 16, e.x, 0, e.z);
          kit.shake(0.35);
          break;
        case 'pickup':
          kit.real.play(PACK, 3, e.x, 0, e.z); // FUN_800be988: the crate breaks (script 3)
          break;
        case 'land': // FUN_800be988 mode 5 -> 0 on levels 5-7: the crate lands (script 3)
          kit.real.play(PACK, 3, e.x, 0, e.z);
          break;
        case 'taunt': // Triangle taunt (clip 0x5a): voice id 0x800c94a8[char-1] = block*0x32 + 2, from the Tank Wars voice banks
          charVoice('tank', ctx.seats[e.s]?.look.char, 2);
          break;
        case 'hit':
          kit.actorForSlot(e.s)?.hit(0.8);
          kit.shake(0.25);
          break;
        case 'pkhit': // FUN_800bf548: a shot pickup goes up in script 16
          kit.real.play(PACK, 16, e.x, 0, e.z);
          break;
        case 'boom':
          kit.real.play(PACK, 14, e.x, 0, e.z); // the wreck blows up when the dying clip ends (script 14, sfx 0x4f0)
          kit.shake(0.7);
          break;
      }
    },

    /** Real HUD: face, wumpa + health bar, mines left (strip of up to three), clock. */
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      for (let slot = 0; slot < 4; slot++) {
        const f = faceSprite(ctx.seats, slot);
        const t = w.data.tk?.[slot];
        if (!f || !t) continue;
        out.push(f, ...barRow(slot, t.hp / TA_HP, FRUIT_ICON));
        const m = Math.max(0, Math.min(3, t.mines ?? 0));
        if (m > 0) out.push({ tex: `${ASSET_BASE}hud/mines${m}.png`, x: SLOT_X[slot] + 8, y: 41, w: m === 3 ? 32 : 11 * m, h: 16 });
      }
      out.push(...bigClock((getGame('tankArena')?.maxTime ?? 90) - w.time, Math.floor(w.time * 2) % 2 === 1));
      return out;
    },

    hud(w, slot) {
      const t = w.data.tk?.[slot];
      if (!t) return '';
      const wp = t.wpn === 2 ? ` · double ${t.ammo}` : t.wpn === 3 ? ` · bomb ${t.ammo}` : '';
      return t.hp > 0 ? `${t.hp}/${TA_HP} HP · ${t.kills} kills · ${t.mines} mines${wp}` : `OUT · ${t.kills} kills`;
    },

    dispose() {
      for (const o of objs.values()) { kit.root.remove(o); if (o.userData.sh) kit.fx.removeShadow(o.userData.sh); }
      objs.clear();
      tanks.clear();
      for (const s of shells.values()) kit.root.remove(s.obj);
      shells.clear();
      kit.dispose();
    },
  };
}
