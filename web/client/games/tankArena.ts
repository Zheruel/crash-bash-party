import * as THREE from 'three';
import { BOAT_IDLE_SPIN, BOAT_ROTOR_AT_GO, TA_HP, TA_K, TA_MAPS, TANK_INTRO_TICKS, TANK_HIT_TICKS, TANK_WRECK_TICKS, tankArena, swampShieldFrame, taWorld } from '../../shared/games/tankArena';
import { JungleStatueView } from './tankJungleStatues';
import { initialMetalWalls } from '../../shared/games/tankArenaMetalWalls';
import { TANK_STOCK_WEAPON, tankGunIdle } from '../../shared/games/tankWeaponPose';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { createCharacter } from '../characters';
import type { ActorParts } from './kit';
import { canvasTexture, catalogInstance, disposeTree, hasProp, Kit, makeCrate, preloadCatalogFor, propObject } from './kit';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx, sfxRate } from '../shell/sound';
import { TANK_SFX } from './tankArenaSfx';
/** level sfx bank per variant (the id -> tone table and its pitches are per level) */
const TANK_BANK: Record<string, string> = { swamp: '0159', desert: '0162', jungle: '0160', metal: '0161' };
import { arenaClockSprites, barRow, faceSprite, FRUIT_ICON, SLOT_X, type HudSprite } from '../ui/ps1hud';
import { cloneWorld, stepWorld } from '../../shared/sim';
import type { ClientMiniGame, RenderWorld } from './types';
import { applyPose, FitCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
import type { ModelRef } from '../crash';
import { fxPartTemplate, pickupShadow, preloadFx } from './realFx';
import { TankSupplyPickup } from './tankSupplies';
import { createTankShell } from './tankShell';
import { charVoice, hitVoice, winnerVoice } from '../shell/voice';
import { knockoutGhostRef, makeKnockoutGhost } from './knockoutGhost';
import { MetalWallView } from './tankArenaMetalWalls';

type TankPaint = {
  color: readonly [number, number, number];
  materials: WeakMap<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial>;
};
// Measured seven- or eight-update waits for the victory animation bank.
const CHEER_LOAD_TICKS = [7, 8, 7, 8, 7, 8, 7, 8];
const TANK_ARMOR = new Set(['tex0', 'tex1', 'tex4', 'tex14', 'tex16', 'tex17', 'tex18']);
const TANK_PAINT: Partial<Record<string, TankPaint>> = {
  'top-g': { color: [1, 0.77, 0.59], materials: new WeakMap() },
  'big-stein': { color: [0.64, 0.68, 1.32], materials: new WeakMap() },
};

function paintTank(root: THREE.Object3D, paint: TankPaint) {
  const coat = (source: THREE.MeshBasicMaterial) => {
    if (!TANK_ARMOR.has(source.name)) return source;
    let material = paint.materials.get(source);
    if (!material) {
      material = source.clone();
      material.color.setRGB(...paint.color);
      paint.materials.set(source, material);
    }
    return material;
  };
  root.traverse(o => {
    const mesh = o as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial | THREE.MeshBasicMaterial[]>;
    if (!mesh.isMesh || !mesh.visible) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(coat) : coat(mesh.material);
  });
}

/**
 * Real effects (re/notes/tankWars.md "Effects"): object pack 0786's effect scripts, by weapon id (8, 9, 10, 11 = the
 * character guns, 2 = double shot): muzzle flash at the shell's start, trail, and the burst where the shell ends
 * (FUN_800b77e8 / FUN_800baffc); pack 0784 parts 24-32 = the smoke puff (object 0x1306) left where a shell ends on levels 6-8.
 */
const PACK = 786, SMOKE = 784, U = TA_K / 1024;
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

interface TankVis { group: THREE.Group; treads: ReturnType<typeof catalogInstance>; gun: ReturnType<typeof catalogInstance>; rotor: ReturnType<typeof catalogInstance> }

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

/** The L5 shield draws pack 0774 part 14 at the origin of each pulse. */
function boatShield() {
  const root = fxPartTemplate(774, 14, TA_K)?.clone();
  if (!root) return null;
  const materials: THREE.MeshBasicMaterial[] = [];
  const own = (source: THREE.MeshBasicMaterial) => {
    const mat = source.clone();
    mat.depthWrite = false;
    materials.push(mat);
    return mat;
  };
  root.traverse(node => {
    const mesh = node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial | THREE.MeshBasicMaterial[]>;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    mesh.renderOrder = 6;
  });
  root.name = 'swampShield';
  return { root, materials };
}

export function createTankArenaView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let replay: RenderWorld | undefined;
  let replaySource = -1;
  let voiceAge: number | undefined;
  let winnerCam: FitCam | undefined;
  let camAge = -1;
  let variant = 'swamp';
  let metalWalls: MetalWallView | null = null;
  let statues: JungleStatueView | undefined;
  const ghosts = new Map<number, NonNullable<ReturnType<typeof makeKnockoutGhost>>>();
  const missileSounds = new Map<number, () => void>();
  const shields = new Map<number, NonNullable<ReturnType<typeof boatShield>>>();
  const tanks = new Map<number, TankVis>();
  const shells = new Map<number, { art: ReturnType<typeof createTankShell>; born: number }>();
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

  function makeParts(slot: number, char: number): ActorParts {
    const L = LOOKS[variant] ?? LOOKS.metal;
    const look = kit.look(slot);
    // pilot: the character's in-tank model, drawn at the stage's raw scale (same 2.6 units as the level)
    const inst = createCharacter(look, { variant: 'tank', ring: false });
    // The extracted tank models already face the muzzle direction. Use the native pilot socket.
    if (inst.root.userData.variantUsed) inst.root.position.y = -(inst.ref?.offset?.[1] ?? 0) - (variant === 'swamp' ? 72 * U : 0);
    const vis = new THREE.Group(); // hull (counter-rotated to the hull yaw below)
    const cat = getCatalog().props;
    let treads: ReturnType<typeof catalogInstance> = null;
    if (variant === 'swamp') treads = cat.taHover && catalogInstance({
      ...cat.taHover, parts: ['part0', 'part1', 'part2', 'part3'],
    });
    else treads = catalogInstance(cat.taTreads);
    if (treads) vis.add(treads.root);
    else vis.add(makeTank(L.tank, variant === 'swamp'));
    const holder = new THREE.Group();
    holder.add(vis);
    // Pack 0774 combines the boat and its gun. Pack 0784 has a separate turret node.
    const gun = variant === 'swamp' ? treads : cat.taTurret8 && catalogInstance({
      ...cat.taTurret8, parts: [7, 8, 9, 10, 11, 15, 16, 17].map(part => `part${part}`),
    });
    if (gun && gun !== treads) holder.add(gun.root);
    const rotor = variant === 'swamp' && cat.taHover ? catalogInstance({ ...cat.taHover, parts: ['part4', 'part5'] }) : null;
    if (rotor) {
      rotor.root.position.y = 256 * U;
      vis.add(rotor.root);
    }
    const paint = TANK_PAINT[CHARACTERS[look.char]?.id];
    if (paint) paintTank(holder, paint);
    gun?.nativePose(tankGunIdle(LEVEL[variant], TANK_STOCK_WEAPON[char - 1]));
    tanks.set(slot, { group: vis, treads, gun, rotor });
    return { inst, extra: holder, steady: true, shadow: 0.9, headY: 1.3, scale: 1 };
  }

  /** the crate-dropping drone (levels 5-7): pack 0784 animated part13 (anim 0x4080 = clip 1), shadow part14 under it */
  function dropper(): THREE.Group {
    const g = new THREE.Group();
    const inst = catalogInstance(getCatalog().props.taDropper);
    const body = new THREE.Group();
    if (inst) { body.add(inst.root); g.userData.inst = inst; }
    const shadow = pickupShadow(784, 14, TA_K);
    g.add(body, shadow);
    g.userData.shadow = shadow;
    g.userData.body = body;
    return g;
  }
  function mineModel(slot: number) {
    if (variant === 'swamp') {
      if (slot < 0) return new THREE.Group(); // The neutral mine's model bank is unloaded on L5.
      const mine = fxPartTemplate(695, 0, TA_K)?.clone() ?? makeMine(kit.hex(slot));
      mine.name = 'floatingMine';
      return mine;
    }
    const ref = getCatalog().props.taMine0;
    const inst = ref && catalogInstance({ ...ref, parts: ['part1', 'part2', 'part3', 'part4'] });
    if (!inst) return makeMine(kit.hex(slot));
    inst.root.userData.inst = inst;
    return inst.root;
  }
  function aim(ctx: { camera: THREE.PerspectiveCamera }, w?: RenderWorld) {
    const lc = LEVEL_CAMS[LEVEL[variant]];
    const ref = stageRef(variant);
    if (lc && ref && placements.get(variant)) {
      const result = w?.data.result;
      if (w && result?.poseAt !== undefined) {
        const age = w.data.f - result.poseAt;
        const tank = w.data.tk[result.winner];
        if (!winnerCam || age < camAge) { winnerCam = new FitCam(lc); camAge = -1; }
        while (camAge < age) {
          winnerCam.update([{ x: tank.x, y: 0, z: tank.z, xl: 256, xr: 256, zn: 0, zf: 0, h: 960 }], false, false);
          camAge++;
        }
        applyPose(ctx.camera, ps1Pose(winnerCam.c, ref));
      } else applyPose(ctx.camera, ps1Pose(lc, ref));
      return;
    }
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
      await Promise.all([preloadCatalogFor('tankArena', ['taTreads', 'taHover', 'taTurret8', 'taMine0', 'taCrate', 'taDropper', 'tank', ...BOMB_FRAMES, ...FLAME_FRAMES], [knockoutGhostRef(TA_K)]), preloadFx([PACK, SMOKE, 695, 736, 776]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'swamp';
      const L = LOOKS[variant] ?? LOOKS.metal;
      kit = new Kit(ctx, 'tankArena', { bg: L.bg, hemi: [0xffffff, 0xffffff, 1.2] });
      kit.realFx(TA_K);
      for (const n of [23, 24]) sfx.preloadFile('sfx/0154/' + n + '.mp3');
      for (const file of new Set(Object.values(TANK_SFX[variant] ?? {}))) sfx.preloadFile(file);
      tanks.clear(); shells.clear(); objs.clear(); lastHp.fill(TA_HP);
      build(world);
      statues = variant === 'jungle' ? new JungleStatueView(kit.root, {
        sound: id => {
          const file = TANK_SFX.jungle[id];
          if (file) sfx.playFile(file, 0.4, false, sfxRate(TANK_BANK.jungle, id));
        },
        slam: (x, z) => {
          const [wx, wz] = taWorld('jungle', x, z);
          kit.real.play(776, 0, wx, -300 * U, wz);
        },
        crushPickup: () => {},
      }) : undefined;
      metalWalls = variant === 'metal' ? new MetalWallView(kit.root) : null;
      aim(ctx);
      if (!loaded) this.preload!().then(() => { tanks.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      let nativeResult = w.data.result;
      kit.checkOver(w, !nativeResult, 120 * 1000 / 30);
      const betweenSnaps = Math.max(0, Math.floor(w.time * 30 + 1e-6) - w.tick);
      if (nativeResult && (kit.over.done || betweenSnaps > 0)) {
        const elapsed = kit.over.done
          ? Math.max(kit.over.frame, Math.floor((ctx.time - (ctx.resultReplayAt ?? ctx.time)) * 30))
          : betweenSnaps;
        const target = w.tick + Math.min(123, elapsed);
        if (!replay || replaySource !== w.tick || target < replay.tick) {
          const { predicted, ...terminal } = w;
          replay = cloneWorld(terminal);
          replaySource = w.tick;
        }
        const audible = kit.over.done && target - replay.tick < 5;
        while (replay.tick < target) {
          const nextEvent = replay.evId;
          stepWorld(replay, tankArena, []);
          if (audible) for (const e of replay.ev) if (e.id >= nextEvent) this.onEvent?.(ctx, e);
        }
        kit.world = w = replay;
        nativeResult = w.data.result;
      }
      if (nativeResult?.poseAt !== undefined) {
        const age = w.data.f - nativeResult.poseAt;
        // Joining partway through a celebration should only play cues still ahead.
        if (voiceAge === undefined) {
          voiceAge = age <= 5 ? -1 : age - 1;
          if (voiceAge >= 0) sfx.enterRoundResult('winner');
        }
        if (age > voiceAge) {
          winnerVoice('tankArena', kit.look(nativeResult.winner).char, voiceAge, age);
          voiceAge = age;
        }
      }
      aim(ctx, w);
      const d = w.data;
      if (statues && d.jungleStatues) {
        const frame = nativeResult && kit.over.done ? 0 : kit.over.done
          ? Math.max(kit.over.frame, Math.floor((ctx.time - (ctx.resultReplayAt ?? ctx.time)) * 30))
          : Math.max(0, Math.floor(w.time * 30 + 1e-6) - w.tick);
        statues.render(d.jungleStatues, d.tk, w.tick, frame, !!d.over || kit.over.done, kit.over.done);
      }
      if (metalWalls && d.metalWalls) {
        const tick = w.tick === 0 ? -(ctx.countdownTicksLeft ?? 0) : w.tick;
        metalWalls.render(tick < 0 ? initialMetalWalls(d.tk, tick) : d.metalWalls, tick, stageRef('metal'));
      }
      const seen = new Set<number>();
      const seenShell = new Set<number>();
      const seenObj = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'tank') {
          const d = nativeResult ? w.data : kit.playerWorld(b.slot).data;
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot, d.tk?.[b.slot]?.char ?? DISC_CHARACTER[kit.look(b.slot).char]));
          const tk = d.tk?.[b.slot];
          const st = tk?.st ?? 0x6e;
          const tick = nativeResult ? w.tick : kit.playerWorld(b.slot).tick;
          // The sim restarts the pilot script as the overlay does (FUN_800854c0 / FUN_800b6ed8).
          const age = Math.max(0, tick - (tk?.animAt ?? 0));
          const action = tk?.anim ?? 0x59;
          // FUN_800babcc / FUN_800bacd4: the winner spins the pilot and turret;
          // on the tracked tanks the hull counter-rotates to keep its bearing.
          const win = nativeResult ? nativeResult.winner === b.slot && nativeResult.poseAt !== undefined
            : kit.over.done && kit.over.winners.has(b.slot);
          const endFrame = !nativeResult && kit.over.done ? kit.over.frame : 0;
          const winAge = nativeResult && win ? d.f - nativeResult.poseAt : endFrame;
          const loadTicks = CHEER_LOAD_TICKS[(tk?.char ?? 1) - 1];
          const leadScript = nativeResult?.recovered ? 0x59 : 0x5a;
          const face = nativeResult && tk ? -tk.yaw * Math.PI / 2048 : b.face;
          const spin = win ? endFrame * 0x15 * Math.PI / 2048 : 0;
          let damageState = st, damageFrame = tk?.stT ?? 0;
          if (endFrame && !win && tk?.hp <= 0) {
            damageFrame += endFrame;
            if (damageState === 0x69 && damageFrame >= TANK_HIT_TICKS[tk.char - 1]) { damageState = 0x6a; damageFrame -= TANK_HIT_TICKS[tk.char - 1]; }
            if (damageState === 0x6a && damageFrame >= TANK_WRECK_TICKS[tk.char - 1]) damageState = 0x6b;
          }
          let ghost = ghosts.get(b.slot);
          if (damageState === 0x6b && tk.ghostAt !== undefined) {
            const age = d.f + endFrame - tk.ghostAt;
            if (!ghost && age <= 110) {
              ghost = makeKnockoutGhost(TA_K, tk.ghostAt * 4 + b.slot, variant === 'swamp' ? 72 : 0, 0);
              if (ghost) { ghosts.set(b.slot, ghost); kit.root.add(ghost.root); }
            }
            ghost?.pose(b.x, b.y, b.z, age, ctx.camera);
          } else if (ghost) ghost.root.visible = false;
          const pulse = tk?.shield;
          const frame = pulse ? swampShieldFrame(d.f + endFrame - pulse.start) : -1;
          let shield = shields.get(b.slot);
          if (!shield && frame > 0) {
            shield = boatShield() ?? undefined;
            if (shield) { shields.set(b.slot, shield); kit.root.add(shield.root); }
          }
          if (shield) {
            shield.root.visible = frame > 0;
            if (frame > 0) {
              const [x, z] = taWorld(variant, pulse.x, pulse.z);
              shield.root.position.set(x, (88 - 22 * frame - pulse.y) * U, z);
              shield.root.scale.y = (2238 + Math.trunc(1858 * frame / 4)) / 4096;
              for (const mat of shield.materials) mat.color.setScalar(frame / 4);
            }
          }
          const hit = damageState === 0x69 || damageState === 0x6a;
          a.update(b, dt, { hidden: damageState === 0x6b, role: hit ? 'hit' : 'idle', freeze: true, keepYaw: win,
            script: win ? (winAge < loadTicks ? leadScript : 0x5c) : damageState === 0x69 ? 0x57 : damageState === 0x6a ? 0x58 : action,
            scriptFrame: win ? (winAge < loadTicks ? winAge : winAge - loadTicks) : hit ? damageFrame : tk?.anim !== undefined ? age : undefined });
          if (win) { a.yaw.rotation.y = face - spin; a.holder.position.y = 0; }
          if (variant === 'swamp') a.pivot.rotation.z = -(tk?.bank ?? 0) * 2 * Math.PI / 4096;
          const t = tanks.get(b.slot);
          if (t && tk) {
            const remaining = tick === 0 ? Math.min(TANK_INTRO_TICKS, Math.max(0, ctx.countdownTicksLeft ?? 0)) : 0;
            if (variant !== 'swamp') {
              // Jungle stores the tread yaw relative to the turret. The grid arenas store it in world space.
              t.group.position.y = Math.trunc((tk.hy ?? 0) / 2) * U;
              const hullAngle = tk.hull * Math.PI / 2048;
              t.group.rotation.y = (variant === 'jungle' ? -hullAngle : Math.PI - hullAngle - face) + spin;
              const treadFrame = ((4 + tick + endFrame - remaining) % 6 + 6) % 6;
              t.treads?.nativePose(0x4300 + treadFrame);
            }
            if (t.rotor) {
              const angle = ((tk.rotor ?? BOAT_ROTOR_AT_GO) + (remaining - endFrame) * BOAT_IDLE_SPIN) & 0xfff;
              t.rotor.root.rotation.z = -angle * Math.PI / 2048;
              t.rotor.nativePose(!remaining && !endFrame && (tk.pad & 0xa00) ? 0x2006 : 0x2005);
            }
            const gunPose = variant === 'swamp' && remaining
              ? tankGunIdle(5, tk.wpn, (TANK_INTRO_TICKS - remaining) % 6)
              : tk.gunPose ?? tankGunIdle(LEVEL[variant], tk.wpn);
            t.gun?.nativePose(gunPose);
          }
          a.holder.scale.setScalar(1);
        } else if (b.kind === 'mine' || b.kind === 'pickup' || b.kind === 'bomb' || b.kind === 'flame' || b.kind === 'dropper') {
          seenObj.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'mine' ? mineModel(b.slot) : b.kind === 'bomb' ? makeBomb() : b.kind === 'flame' ? makeFlame() : b.kind === 'dropper' ? dropper() : new TankSupplyPickup(Math.round(b.cd), variant === 'metal', () => makePickup(Math.round(b.cd)));
            kit.root.add(o);
            objs.set(b.id, o);
            if (b.kind === 'bomb') o.userData.sh = kit.fx.shadow(0.4, 0.45);
          }
          if (b.kind === 'bomb') {
            o.position.set(b.x, b.y + 0.4, b.z);
            if (!stepFlipBook(o, ctx.time + b.id, 15)) o.rotation.x += dt * 6;
            (o.userData.sh as BlobShadow).set(b.x, b.z, b.y);
          } else if (b.kind === 'mine') {
            o.position.set(b.x, b.y, b.z);
            o.userData.inst?.nativePose(0x2002 + Math.min(3, Math.floor(Math.max(b.cd, 0) / 30)));
            const light = o.getObjectByName('light') as THREE.Mesh | undefined;
            const urgent = b.cd <= 30;
            if (light) (light.material as THREE.MeshBasicMaterial).color.set(Math.sin(ctx.time * (urgent ? 22 : 9)) > 0 ? 0xff3a2a : 0x661810);
            o.scale.setScalar(1);
          } else if (b.kind === 'flame') {
            o.position.set(b.x, 0.3, b.z);
            if (stepFlipBook(o, ctx.time + b.id * 0.13, 20)) o.quaternion.copy(ctx.camera.quaternion);
            else o.scale.setScalar(0.8 + Math.sin(ctx.time * 30 + b.id) * 0.2);
          } else if (b.kind === 'dropper' && d.dropper) {
            const q = d.dropper;
            const age = q.born === undefined ? Math.abs((q.vx < 0 ? 6144 : -2048) - q.x) / 64 : d.f - q.born;
            o.position.set(b.x, 0, b.z);
            const yaw = q.vx > 0 ? Math.PI / 2 : -Math.PI / 2;
            o.userData.body.rotation.y = yaw;
            o.userData.shadow.rotation.y = age > 0 ? yaw : 0;
            o.userData.body.position.y = b.y;
            o.userData.inst?.nativePose(0x4080 + (-age & 7));
          } else if (o instanceof TankSupplyPickup) {
            const k = d.pickups.find((pickup: { id: number }) => pickup.id === b.id);
            if (k) { o.position.set(b.x, 0, b.z); o.pose(k, d.f, b.y, ctx.camera); }
          }
        } else if (b.kind === 'bullet') {
          seenShell.add(b.id);
          let s = shells.get(b.id);
          const shot = w.data.shells?.find((q: { id: number }) => q.id === b.id);
          const yaw = shot?.yaw === undefined ? Math.atan2(b.vx, b.vz) : -shot.yaw * Math.PI / 2048;
          if (!s) {
            const wpn = Math.round(b.dash);
            const art = createTankShell(wpn, kit.hex(b.slot));
            kit.root.add(art.root);
            s = { art, born: shot?.born ?? w.data.f };
            shells.set(b.id, s);
          }
          s.art.root.position.set(b.x, b.y, b.z);
          s.art.pose(Math.max(0, w.data.f - s.born), yaw, ctx.camera);

        }
      }
      kit.prune(seen);
      for (const [id, s] of shells) if (!seenShell.has(id)) {
        kit.root.remove(s.art.root); disposeTree(s.art.root); shells.delete(id);
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
        if (f && e.v === 0x522 && e.o >= 0) {
          const sound = sfx.startSample(f, null, 0.4, sfxRate(TANK_BANK[variant], e.v));
          if (sound) missileSounds.set(e.o, sound.stop);
        } else if (f) sfx.playFile(f, 0.4, false, sfxRate(TANK_BANK[variant], e.v));
        return;
      }
      switch (e.k) {
        case 'statueSlam':
          kit.real.play(776, 0, e.x, e.v, e.z);
          break;
        case 'lob':
          kit.real.play(PACK, 0, e.x, 0, e.z, { add: true }); // FUN_800b71f8: script 0 at the tank as the bomb leaves
          break;
        case 'floatingMineBlast':
          kit.real.play(PACK, 16, e.x, e.v, e.z);
          break;
        case 'explode': // timed mine: script 16
          kit.real.play(PACK, 16, e.x, 0, e.z);
          break;
        case 'bombBlast': // FUN_800bc27c: script 1 at the bomb
          kit.real.play(PACK, 1, e.x, e.v, e.z);
          break;
        case 'trapCatch':
          if (variant !== 'swamp') kit.real.sprite(SMOKE, SMOKE_FRAMES, e.x, e.v, e.z, { life: 9 / 30, add: true });
          kit.real.play(PACK, 3, e.x, e.v, e.z);
          break;
        case 'crateBreak':
        case 'crateLand':
          kit.real.play(PACK, 3, e.x, e.v, e.z);
          break;
        case 'taunt': // Triangle taunt (clip 0x5a): voice id 0x800c94a8[char-1] = block*0x32 + 2, from the Tank Wars voice banks
          charVoice('tank', ctx.seats[e.s]?.look.char, 2);
          break;
        case 'hitVoice': // FUN_800ba964: 0x800c9428[char][rand(4)]
          hitVoice('tank', ctx.seats[e.s]?.look.char, undefined, e.v);
          break;
        case 'shellMuzzle':
          kit.real.play(PACK, e.o, e.x, e.v, e.z, { yaw: e.yaw, add: true });
          break;
        case 'shellTrail':
          kit.real.play(PACK, e.o, e.x, e.v, e.z);
          break;
        case 'shellImpact':
          kit.real.play(PACK, e.o, e.x, e.v, e.z);
          if (e.o !== 10 && variant !== 'swamp') kit.real.sprite(SMOKE, SMOKE_FRAMES, e.x, e.v, e.z, { life: 9 / 30, add: true });
          break;
        case 'doubleImpact':
          missileSounds.get(e.o)?.();
          missileSounds.delete(e.o);
          kit.real.sprite(SMOKE, SMOKE_FRAMES, e.x, e.v, e.z, { life: 9 / 30, add: true });
          break;
        case 'pkhit': // FUN_800bf548: a shot pickup goes up in script 16
          kit.real.play(PACK, 16, e.x, e.v, e.z);
          break;
        case 'boom': {
          const take = e.id % 2;
          sfx.playFile('sfx/0154/' + (23 + take) + '.mp3', 0.65, true, sfxRate(TANK_BANK[variant], 0x1c3 + take));
          kit.real.play(PACK, 14, e.x, 0, e.z); // the wreck blows up when the dying clip ends (script 14, sfx 0x4f0)
          break;
        }
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
      out.push(...arenaClockSprites('tankArena', w));
      return out;
    },

    hud(w, slot) {
      const t = w.data.tk?.[slot];
      if (!t) return '';
      const wp = t.wpn === 2 ? ` · double ${t.ammo}` : t.wpn === 3 ? ` · bomb ${t.ammo}` : '';
      return t.hp > 0 ? `${t.hp}/${TA_HP} HP · ${t.kills} kills · ${t.mines} mines${wp}` : `OUT · ${t.kills} kills`;
    },

    dispose() {
      for (const stop of missileSounds.values()) stop();
      missileSounds.clear();
      for (const ghost of ghosts.values()) ghost.dispose();
      ghosts.clear();
      metalWalls?.dispose();
      statues = undefined;
      for (const shield of shields.values()) for (const mat of shield.materials) mat.dispose();
      shields.clear();
      for (const o of objs.values()) { kit.root.remove(o); if (o.userData.sh) kit.fx.removeShadow(o.userData.sh); }
      objs.clear();
      tanks.clear();
      shells.clear();
      kit.dispose();
    },
  };
}
