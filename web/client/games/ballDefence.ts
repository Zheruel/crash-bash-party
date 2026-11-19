// BALLISTIX view (shared/games/ballDefence.ts): the four real levels (CRASHBALL, BEACH BALL, N.BALLISM, SKY BALLS)
// seen through the real fixed camera. Stage pieces come from the disc models listed in assets/stages/ballDefence.json;
// floors and walls that the disc stores elsewhere are rebuilt here from the same level textures.
import * as THREE from 'three';
import { BD_HALF, BD_NORMALS, BD_U } from '../../shared/games/ballDefence';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { ASSET_BASE, getCatalog, type ModelRef } from '../crash';
import { createCharacter } from '../characters';
import { CHARACTERS } from '../../shared/look';

/** ship model 766 (stage file props.bdShip): level units, native facing (bumper and pilot toward the arena centre) */
const SHIP_SCALE = 4;
/** the player entity's height above the floor (y -128 u) */
const RIDE = (128 * SHIP_SCALE) / 1024;
import { sfx, sfxRate } from '../shell/sound';
import type { ActorParts } from './kit';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import { preloadFx } from './realFx';

/** Object pack 0762 at the stage scale: effect script 0 = a knocked-out ship's explosion (FUN_800b79f4). */
const FX_PACK = 762, FX_SCALE = 4;
/** N.Gin machine pack (db 0x80054574 = disc 0764: part0 render id 0x2001, part5 0x2006 while it spits, script 0 = rise / retract
 *  puff) and the N.Ballism level model, whose looping script 1 is the power-up post (FUN_800bd770 at the corner bumper) */
const MACH_PACK = 764, POST_PACK = 651;
/** post markers 0x8005b2b8[4..7] in the N.Ballism level (u, y down; read from the running level) */
const POST_AT = [[1649, -373, 1655], [1649, -373, -1640], [-1663, -373, 1655], [-1646, -373, -1640]];
import type { ClientMiniGame } from './types';
import { bigNumber, faceSprite, type HudSprite, SLOT_X } from '../ui/ps1hud';
import { applyPose, LEVEL_CAMS, asDecal, levelStage, loadPlacements, ps1Pose, type LevelStageOpts, type Placements } from './ps1cam';

const H = BD_HALF;
const GOAL_HALF = 6; // goal mouth half width: the ball is clamped to +-0x600 u while it sinks in
const SKY_R = 9.5; // SKY BALLS goal line radius (0x980 u)
const SKY_ANG = Math.asin(GOAL_HALF / SKY_R);
/** The real camera, fitted from emulator frames (native units x 4 = sim units). */
const cam = (y: number, z: number, pitch: number, fov: number) => ({ y: y * 4, z: z * 4, pitch: (pitch * Math.PI) / 180, fov, sx: 1.295 });
export const BD_CAMS: Record<string, ReturnType<typeof cam>> = {
  crashball: cam(3.989, 2.951, 52.5, 65),
  beach: cam(3.862, 3.021, 51.2, 65.8),
  nballism: cam(3.989, 2.951, 52.5, 65),
  sky: cam(4.06, 4.091, 46.87, 56.9), // fitted on the four engine fans
};
/** BALLISTIX level ids (cheat 0x0E-0x11) */
const LEVEL: Record<string, number> = { crashball: 14, beach: 15, nballism: 16, sky: 17 };
const placements = new Map<string, Placements | null>();
/** per-level stage options: the camera-side wall the game never draws, and native goal-floor strips missing from the object list */
const LEVEL_OPTS: Record<string, LevelStageOpts> = {
  crashball: { skip: ['extra_bc58', 'extra_c810', 'extra_cb64', 'extra_ce98'], decals: ['extra_8d38', 'extra_8e94', 'extra_8ff0', 'extra_914c'] },
};
const ARENA_KEY: Record<string, string> = { crashball: 'crashball', beach: 'beachBall', nballism: 'nballism', sky: 'skyBalls' };
const BG: Record<string, number> = { crashball: 0x000000, beach: 0x1a3440, nballism: 0x061a24, sky: 0x6aa6e6 };
const BALL_COL: Record<string, number> = { crashball: 0xe4eef8, beach: 0xb4703c, nballism: 0xe4ecf6, sky: 0xc8d0da };

/** sfx bank of each level (levelBanks in audio/index.json) */
const BANK_OF: Record<string, string> = { crashball: '0157', beach: '0156', nballism: '0155', sky: '0154' };
/** effect id -> sample of the level's bank (tone id through the bank's VAB; same for the four banks up to 1426) */
const COMMON: Record<number, number> = {
  1400: 0, 1401: 1, 1402: 2, 1403: 3, 1404: 4, 1405: 5, 1406: 4, 1407: 5, 1408: 6, 1409: 7, 1410: 8, 1411: 9, 1412: 10, 1413: 11, 1414: 12,
  1415: 13, 1416: 14, 1417: 15, 1418: 13, 1419: 14, 1420: 15, 1421: 16, 1422: 16, 1423: 16, 1424: 16, 1425: 17, 1426: 18,
};
const EXTRA: Record<string, Record<number, number>> = {
  crashball: { 1440: 19, 451: 20, 452: 21, 1494: 22, 1495: 22, 1496: 22, 1498: 22 },
  beach: { 1440: 19, 1450: 20, 1451: 21, 1452: 22, 1453: 21, 1454: 22, 1455: 23, 1456: 24, 1457: 23, 1458: 24, 1459: 25, 1460: 26, 1461: 25, 1462: 26, 1463: 27, 1464: 28, 451: 29, 452: 30 },
  nballism: { 1440: 19, 1470: 20, 1471: 21, 1472: 22, 1473: 23, 451: 24, 452: 25 },
  sky: { 1480: 19, 1481: 20, 1482: 21, 1483: 22, 1484: 21, 1485: 22, 451: 23, 452: 24 },
};
const sampleOf = (variant: string, id: number): number | undefined => EXTRA[variant]?.[id] ?? COMMON[id];
/** ball volume per effect (the disc plays most at full level; these keep the mix usable) */
const VOL = (id: number) => (id === 1408 ? 0.35 : id >= 1415 && id <= 1424 ? 0.4 : 0.6);

// ------------------------------------------------------------------ texture helpers

const loader = new THREE.TextureLoader();
function tex(path: string, repeat?: [number, number]): THREE.Texture {
  const t = loader.load(`${ASSET_BASE}textures/${path}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/** n x n grid of tiles drawn from level textures (random but deterministic), as one texture. */
function tileSheet(dir: string, ids: number[], n: number, tint?: string, seed = 5): THREE.CanvasTexture {
  const cell = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n * cell;
  const g = cv.getContext('2d')!;
  g.fillStyle = tint ?? '#777';
  g.fillRect(0, 0, cv.width, cv.height);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const id = ids[Math.floor(rnd() * ids.length)];
    const img = new Image();
    img.onload = () => {
      g.drawImage(img, x * cell, y * cell, cell, cell);
      if (tint) { g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = tint; g.fillRect(x * cell, y * cell, cell, cell); g.restore(); }
      t.needsUpdate = true;
    };
    img.src = `${ASSET_BASE}textures/${dir}/tex${String(id).padStart(3, '0')}.png`;
  }
  return t;
}

/** soft blotchy surface texture (the steel plate / ice look of the PS1 floors) */
function noiseTex(base: string, amp: number, seed: number): THREE.CanvasTexture {
  const n = 128, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  let s = seed * 7919;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 340; i++) {
    const v = (rnd() - 0.5) * amp * 2, r = 2 + rnd() * 7, x = rnd() * n, y = rnd() * n;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${Math.min(0.5, v / 100)})` : `rgba(0,0,0,${Math.min(0.5, -v / 100)})`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** pad / sprite texture with its flat grey backdrop cut away (keeps the black and green chevrons) */
function cutoutTex(path: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  const img = new Image();
  img.onload = () => {
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 64, 64);
    const px = g.getImageData(0, 0, 64, 64), d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2], lum = (r + gg + b) / 3;
      const green = gg > r + 30 && gg > b + 30;
      d[i + 3] = green || lum < 70 ? 255 : 0;
    }
    g.putImageData(px, 0, 0);
    t.needsUpdate = true;
  };
  img.src = `${ASSET_BASE}textures/${path}`;
  return t;
}

const flat = (w: number, d: number, mat: THREE.Material, y = 0.0, x = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
  m.position.set(x, y, z);
  return m;
};
const basic = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...o });

/** crashball's border lights are cyan in the real game; the decoded set carries the red palette of the same strips. */
function retintRed(root: THREE.Object3D) {
  const done = new Map<THREE.Texture, THREE.Texture>();
  const isRed = (r: number, g: number, b: number) => r > 0.2 && r > g * 1.5 && r > b * 1.5;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    const map = mat.map;
    if (!map) {
      // untextured glow panels: vertex colours carry the red palette
      const col = m.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!col) return;
      let any = false;
      for (let i = 0; i < col.count && !any; i++) any = isRed(col.getX(i), col.getY(i), col.getZ(i));
      if (!any) return;
      m.geometry = m.geometry.clone();
      const c2 = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c2.count; i++) {
        const r = c2.getX(i), g = c2.getY(i), b = c2.getZ(i);
        if (isRed(r, g, b)) c2.setXYZ(i, (g + b) / 2, r * 0.95, r);
      }
      return;
    }
    const img = map.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img || !img.width) return;
    let out = done.get(map);
    if (!out) {
      const cv = document.createElement('canvas');
      cv.width = img.width as number; cv.height = img.height as number;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, cv.width, cv.height), d = px.data;
      let changed = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        if (d[i + 3] > 8 && isRed(r / 255, gg / 255, b / 255)) { d[i] = (gg + b) / 2; d[i + 1] = Math.min(255, r * 1.25); d[i + 2] = Math.min(255, r * 1.3); changed++; }
      }
      if (changed > 3) {
        g.putImageData(px, 0, 0);
        const t = new THREE.CanvasTexture(cv);
        t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
        t.colorSpace = map.colorSpace; t.flipY = map.flipY;
        out = t;
      } else out = map;
      done.set(map, out);
    }
    if (out !== map) { const c = mat.clone(); c.map = out; m.material = c; }
  });
}

// ------------------------------------------------------------------ stage

interface Stage {
  group: THREE.Group;
  update(t: number): void;
  /** per player p: the goal-mouth strip while the goal is open (cyan lights) and once it is closed (red) */
  strips?: [THREE.Object3D | null, THREE.Object3D | null][];
}

/** goal strips per player (p0 near/-z, p1 far/+z, p2 +x, p3 -x): open = placed object, closed = native mesh */
const STRIPS: Record<string, [string, string][]> = {
  crashball: [['extra_d1cc', 'part26'], ['extra_cb64', 'part24'], ['extra_ce98', 'part25'], ['extra_c810', 'part23']],
};

function refOf(variant: string): (ModelRef & { extra?: ModelRef[] }) | undefined {
  const arenas = getCatalog().arenas as Record<string, ModelRef & { extra?: ModelRef[] }>;
  return arenas[`ballDefence:${ARENA_KEY[variant]}`] ?? arenas.ballDefence;
}

/**
 * Strip polygons that carry the floor texture itself (additive tex015) lie on the floor plane: the PS1 has no depth buffer and
 * its ordering table draws them before the floor, which covers them. With a z-buffer they flash as bright seams, so they go behind.
 */
function underFloor(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const q of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshBasicMaterial[]) {
      if (q.userData?.texture_index === FLOOR_TEX && q.userData?.semi_transparent) { q.polygonOffsetFactor = 1; q.polygonOffsetUnits = 4; }
    }
  });
}
const FLOOR_TEX = 15;

/**
 * The placed floor pieces meet with sub-unit cracks that the PS1 rasteriser closes. Each opaque floor piece gets a copy 1.5%
 * larger around its own centre, drawn behind it, so the cracks show floor instead of the black void.
 */
function fillCracks(root: THREE.Object3D) {
  const add: [THREE.Object3D, THREE.Mesh][] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const q = m.material as THREE.MeshBasicMaterial;
    if (q.userData?.texture_index !== FLOOR_TEX || q.userData?.semi_transparent) return;
    m.geometry.computeBoundingBox();
    const c = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
    const mat = q.clone();
    mat.defines = { ...q.defines }; mat.onBeforeCompile = q.onBeforeCompile; mat.customProgramCacheKey = q.customProgramCacheKey;
    mat.polygonOffset = true; mat.polygonOffsetFactor = 2; mat.polygonOffsetUnits = 8;
    const k = new THREE.Mesh(m.geometry, mat);
    k.scale.set(1.015, 1, 1.015);
    k.position.set(c.x * -0.015, 0, c.z * -0.015);
    add.push([m, k]);
  });
  for (const [m, k] of add) m.add(k);
}

function buildStage(variant: string): Stage {
  const group = new THREE.Group();
  const upd: ((t: number) => void)[] = [];
  const ref = refOf(variant);
  // the real level: every static object from the game's own object list, placed as the game does
  const lvl = ref ? levelStage(ref, placements.get(variant) ?? null, (r) => catalogInstance(r)?.root ?? null, LEVEL_OPTS[variant]) : null;
  if (lvl) {
    group.add(lvl);
    if (variant === 'crashball') fillCracks(lvl);
    const strips = STRIPS[variant]?.map(([open, closed]) => {
      const mk = (part: string) => {
        const m = ref ? catalogInstance({ model: ref.model, scale: ref.scale, offset: ref.offset, yaw: ref.yaw, parts: [part] }) : null;
        if (m) { asDecal(m.root); underFloor(m.root); group.add(m.root); }
        return m?.root ?? null;
      };
      return [mk(open), mk(closed)] as [THREE.Object3D | null, THREE.Object3D | null];
    });
    return { group, update: () => {}, strips };
  }
  const main = catalogInstance(ref);
  if (main) group.add(main.root);
  for (const ex of ref?.extra ?? []) { const m = catalogInstance(ex); if (m) group.add(m.root); }
  if (main && variant === 'crashball') retintRed(group);

  if (variant === 'crashball') {
    // floor between the border strips: the real steel plates
    group.add(flat(14.4, 14.4, basic({ map: noiseTex('#8a908f', 7, 7) })));
  } else if (variant === 'beach') {
    group.add(flat(2 * H + 1.2, 2 * H + 1.2, basic({ map: tileSheet('0654', [57, 58, 59, 60, 61, 62, 63, 64, 66, 68, 69, 70, 71, 74, 76, 78], 6, '#a08c70', 11) }), -0.01));
    // glass centre disc ringed in gold (the model's glow patch sits on top)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.1, 0.3, 8, 48).rotateX(Math.PI / 2), basic({ map: tex('0654/tex096.png'), color: 0xf0c860 }));
    ring.position.y = 0.12;
    group.add(ring);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(4.9, 40).rotateX(-Math.PI / 2), basic({ color: 0x7fb6b4 }));
    glass.position.y = 0.04;
    group.add(glass);
    // gold edge rails along the sides and the bottom
    const gold = basic({ color: 0xb8842c });
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 2 * H - 4), gold);
      rail.position.set(sx * (H + 0.35), 0.4, 0);
      group.add(rail);
    }
  } else if (variant === 'nballism') {
    const ids: number[] = []; for (let i = 24; i <= 60; i++) ids.push(i);
    group.add(flat(2 * H + 1.2, 2 * H + 1.2, basic({ map: tileSheet('0650', ids, 4, '#2a8a99', 3) }), -0.01));
    // cyan edge rails left, right and bottom
    const cy = basic({ map: tex('0650/tex014.png'), color: 0xbff8ff });
    const mkRail = (w: number, d: number, x: number, z: number) => { const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), cy); r.position.set(x, 0.35, z); group.add(r); };
    mkRail(0.8, 2 * H - 2, -H - 0.5, 0); mkRail(0.8, 2 * H - 2, H + 0.5, 0);
    mkRail(2 * H - 3, 0.8, 0, H + 0.5); mkRail(2 * H - 3, 0.8, 0, -H - 0.5);
    // lab backdrop: teal wall panels, a door and the console bank behind the top goal
    const wallTex = [tex('0650/tex002.png'), tex('0650/tex005.png'), tex('0650/tex008.png')];
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), basic({ map: wallTex[i % 3], color: 0x7fb0b8 }));
      w.position.set(-25 + i * 10, 5, -17);
      group.add(w);
    }
    const door = new THREE.Mesh(new THREE.PlaneGeometry(7, 9), basic({ map: tex('0650/tex012.png') }));
    door.position.set(0, 4.6, -16.9);
    group.add(door);
    for (const [i, x] of [16, 17, 18, 19].entries()) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), basic({ map: tex(`0650/tex0${x}.png`) }));
      c.position.set(-5.4 + i * 3.6, 3.2, -16.8);
      group.add(c);
    }
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), basic({ map: wallTex[1], color: 0x4f8a94 }));
      w.rotation.y = -sx * Math.PI / 2;
      w.position.set(sx * 22, 6, -2);
      group.add(w);
    }
  }
  if (variant === 'sky') {
    // farmland far below the floating disc (the model only carries the strip behind it)
    const f = flat(260, 200, basic({ map: tileSheet('0646', [65, 66, 67, 68, 69, 70], 8, '#c8c8b0', 4) }), -10.2, 0, 10);
    group.add(f);
  }
  // sky level: disc, engines and the far backdrop are in the model
  return { group, update: (t) => upd.forEach((f) => f(t)) };
}

// ------------------------------------------------------------------ view

interface Goal { slot: number; barrier: THREE.Mesh; barrierT: number; shield: THREE.Mesh; zap: THREE.Object3D[][] }

export function createBallDefenceView(): ClientMiniGame {
  let kit: Kit;
  let stage: Stage;
  const goals: Goal[] = [];
  const balls = new Map<number, { obj: THREE.Group; shadow: BlobShadow; halo: THREE.Mesh; mat: THREE.MeshBasicMaterial }>();
  let post: { x: number; y: number; z: number } | null = null;
  let machine: { idle: THREE.Object3D; spit: THREE.Object3D; g: THREE.Group } | null = null;
  let bankIdx: Record<number, string> = {};
  const bankFile = (n: number): string | undefined => bankIdx[n];
  let loaded = false;
  let variant = 'crashball';
  let bgColor = new THREE.Color(0);
  const axis = new THREE.Vector3();

  function setCamera(cam: THREE.PerspectiveCamera) {
    const lc = LEVEL_CAMS[LEVEL[variant]];
    if (lc && placements.get(variant)) { applyPose(cam, ps1Pose(lc, refOf(variant))); return; }
    const C = BD_CAMS[variant] ?? BD_CAMS.crashball;
    const a = cam.aspect, t0 = Math.tan((C.fov * Math.PI) / 360);
    const fov = a < 4 / 3 ? (2 * Math.atan((t0 * (4 / 3)) / a) * 180) / Math.PI : C.fov;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.projectionMatrix.elements[0] *= C.sx; // the PS1 projection is wider than tall: real x-stretch
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.position.set(0, C.y, C.z);
    cam.lookAt(0, C.y - Math.sin(C.pitch) * 10, C.z - Math.cos(C.pitch) * 10);
  }

  /**
   * Sky Balls: the disc's tilt and bob (FUN_800bca38: node rx 0x800c1c68, rz 0x800c1c6c, floor y 0x8005a5d8). The ships and
   * balls ride the disc, so the whole game root takes the transform and the far scenery (landscape, clouds) is held still.
   */
  const tiltM = new THREE.Matrix4(), tiltInv = new THREE.Matrix4();
  function skyTilt(t: number[]) {
    const R = kit.root;
    R.rotation.set((t[0] * Math.PI) / 2048, 0, (-t[1] * Math.PI) / 2048);
    R.position.y = -t[2] / BD_U;
    R.updateMatrix();
    tiltM.copy(R.matrix);
    tiltInv.copy(tiltM).invert();
    stage.group.traverse((o) => {
      const base = o.userData.farBase as THREE.Matrix4 | undefined;
      if (!base) return;
      o.matrix.multiplyMatrices(tiltInv, base);
      o.matrixWorldNeedsUpdate = true;
    });
  }
  /** far scenery of the sky level (L17: landscape 0x500c-e, clouds 0x5002/3/8/9): remembered so skyTilt can cancel the tilt on them */
  const SKY_FAR = ['extra_8b68', 'extra_8e70', 'extra_9114', 'extra_7800', 'extra_7a10', 'extra_8448', 'extra_861c'];
  function markFar(g: THREE.Object3D) {
    g.traverse((o) => {
      if (o.userData.ps1 && SKY_FAR.some((n) => o.name.endsWith(':' + n))) { o.userData.farBase = o.matrix.clone(); o.matrixAutoUpdate = false; }
    });
  }

  function build() {
    const R = kit.root;
    stage = buildStage(variant);
    R.add(stage.group);
    const disc = variant === 'sky';
    if (disc) markFar(stage.group);
    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const [nx, nz] = BD_NORMALS[s];
      const width = disc ? 2 * SKY_R * Math.sin(SKY_ANG) : 2 * GOAL_HALF;
      const edge = disc ? SKY_R : H;
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(width, 1.8, 1.0), basic({ color: variant === 'beach' ? 0xb8842c : variant === 'sky' ? 0x8fa0b8 : variant === 'nballism' ? 0x7a3fd0 : 0x6a7684 }));
      barrier.position.set(nx * (edge + 0.2), -1.0, nz * (edge + 0.2));
      barrier.rotation.y = Math.atan2(nx, nz);
      barrier.visible = false;
      const shield = new THREE.Mesh(new THREE.BoxGeometry(width, 2.6, 0.3), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, depthWrite: false }));
      shield.position.set(nx * (edge - 0.3), 1.3, nz * (edge - 0.3));
      shield.rotation.y = Math.atan2(nx, nz);
      shield.visible = false;
      R.add(barrier, shield);
      // knocked-out goal: the game's lightning strip (model 762 meshes 0-7, 514 u long, 8 frames) along the goal line
      const zap: THREE.Object3D[][] = [];
      const zg = new THREE.Group();
      zg.position.set(nx * edge, 0.02, nz * edge);
      zg.rotation.y = Math.atan2(nx, nz);
      const n = Math.max(1, Math.round(width / 2));
      for (let k = 0; k < n; k++) {
        const frames: THREE.Object3D[] = [];
        for (let f = 0; f < 8; f++) {
          const m = catalogInstance(getCatalog().props[`bdZap${f}`]);
          if (!m) continue;
          m.root.position.x = -width / 2 + (k * width) / n;
          m.root.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { const q = (me.material as THREE.MeshBasicMaterial).clone(); q.blending = THREE.AdditiveBlending; q.depthWrite = false; q.transparent = true; me.material = q; } });
          m.root.visible = false;
          zg.add(m.root);
          frames.push(m.root);
        }
        zap.push(frames);
      }
      R.add(zg);
      barrier.visible = false;
      goals.push({ slot: s, barrier, barrierT: 0, shield, zap });
    }
  }

  function ballObj(b: Body) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: BALL_COL[variant] ?? 0xffffff });
    // the real ball: model 762 native mesh 8 (render id 0x2009), level units
    const real = catalogInstance(getCatalog().props.bdBall);
    if (real) {
      // chrome: the game maps the ball texture by screen-space normal (environment map), so the pattern stays put
      real.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshBasicMaterial;
        m.material = new THREE.MeshMatcapMaterial({ matcap: src.map ?? undefined });
      });
      real.root.name = 'spin';
      real.root.position.y = b.r;
      const halo = new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.5, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.35, depthWrite: false }));
      halo.position.y = b.r;
      halo.visible = false;
      g.add(real.root, halo);
      kit.root.add(g);
      // floor glow instead of a dark blob: model 762 mesh 12 (radial disc), additive, the cyan the game shows under balls
      const glow = catalogInstance(getCatalog().props.bdGlow);
      const shadow = kit.fx.shadow(b.r * 1.4, 0.5);
      if (glow) {
        glow.root.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { const q = (me.material as THREE.MeshBasicMaterial).clone(); q.blending = THREE.AdditiveBlending; q.depthWrite = false; q.transparent = true; q.color = new THREE.Color(0x58c8e8); me.material = q; } });
        glow.root.scale.setScalar(2);
        kit.root.add(glow.root);
        const set = shadow.set.bind(shadow);
        shadow.set = (x: number, z: number, h: number) => { set(x, z, h); glow.root.position.set(x, 0.02, z); glow.root.visible = g.visible; };
        g.userData.glow = glow.root;
        (shadow as unknown as { mesh?: THREE.Object3D }).mesh?.removeFromParent();
      }
      return { obj: g, shadow, halo, mat };
    }
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
    sph.name = 'spin';
    // PS1-style shading: dark underside, bright top (vertex colours)
    const pos = sph.geometry.attributes.position, cols: number[] = [];
    for (let i = 0; i < pos.count; i++) { const k = 0.55 + 0.45 * ((pos.getY(i) + 1) / 2); cols.push(k, k, k); }
    sph.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    mat.vertexColors = true;
    sph.scale.setScalar(b.r);
    sph.position.y = b.r;
    const halo = new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.5, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.35, depthWrite: false }));
    halo.position.y = b.r;
    halo.visible = false;
    g.add(sph, halo);
    kit.root.add(g);
    return { obj: g, shadow: kit.fx.shadow(b.r * 1.4, 0.5), halo, mat };
  }

  function shipParts(slot: number): ActorParts {
    // Real assembly (emulator RAM): the per-character Ballistix pilot (896-910, animated) and the hull (766) share the player
    // entity's origin, which rides 128 u above the floor; level units, native facing.
    const id = CHARACTERS[kit.look(slot).char % CHARACTERS.length].id;
    const pilot = catalogInstance(getCatalog().props[`bdPilot.${id}`]);
    let inst: ReturnType<typeof createCharacter>;
    if (pilot) { inst = pilot; pilot.play('idle'); } else { inst = createCharacter(kit.look(slot), { ring: false }); inst.root.position.y = 0.6; }
    inst.root.position.y += RIDE;
    // seated over the cockpit tub (model 766 untextured interior, native z 27..365): centre z +196 u
    if (pilot) inst.root.position.z = (196 * SHIP_SCALE) / 1024;
    // hull: model 766 (render chain child, same origin)
    const ship = catalogInstance(getCatalog().props.bdShip);
    const extra = new THREE.Group();
    if (ship) {
      ship.root.position.y = RIDE; extra.add(ship.root);
      // FUN_800b5c30: render id 0x2004 (part3) normally, 0x2006 (part5, bumper lights off) while catching (state 0x21) or while the
      // kick recharges (+0x66)
      const dim = catalogInstance(getCatalog().props.bdShipDim);
      if (dim) { dim.root.position.y = RIDE; dim.root.visible = false; extra.add(dim.root); extra.userData.hull = [ship.root, dim.root]; }
    }
    else {
      const hull = new THREE.Mesh(new THREE.SphereGeometry(1.5, 20, 10).scale(1, 0.4, 1), basic({ color: 0x3a9a7a }));
      hull.position.y = 0.4;
      extra.add(hull);
    }
    return { inst, extra, shadow: 1.8, headY: 2.2, scale: 1, steady: true };
  }

  return {
    id: 'ballDefence',
    async preload() {
      await Promise.all([preloadCatalogFor('ballDefence', ['bdShip', 'bdShipDim', 'bdBall', 'bdGlow', 'bdMachine', 'bdMachineSpit', ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `bdZap${k}`), ...CHARACTERS.map((c) => `bdPilot.${c.id}`)]), preloadFx([FX_PACK, MACH_PACK, POST_PACK]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      variant = world.data.variant ?? 'crashball';
      bgColor = new THREE.Color(BG[variant] ?? 0);
      kit = new Kit(ctx, 'ballDefence', { bg: BG[variant] ?? 0, hemi: [0xffffff, 0x888899, 1.6] });
      kit.realFx(FX_SCALE);
      goals.length = 0; balls.clear(); post = null; machine = null; bankIdx = {};
      // samples are shared between banks on disc, so the file comes from audio/index.json
      void fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
        const smp: { n: number; file?: string | null }[] = j?.sfx?.banks?.[BANK_OF[variant]]?.samples ?? [];
        bankIdx = {};
        for (const x of smp) if (x.file) bankIdx[x.n] = x.file;
        const ids = new Set<number>(Object.values({ ...COMMON, ...EXTRA[variant] }));
        for (const n of ids) if (bankIdx[n]) sfx.playFile(bankIdx[n], 0); // preload
      }).catch(() => { /* silent */ });
      build();
      setCamera(ctx.camera);
      if (!loaded) this.preload!().then(() => { kit?.reset(); if (kit) { kit.root.remove(stage.group); disposeTree(stage.group); stage = buildStage(variant); kit.root.add(stage.group); if (variant === 'sky') markFar(stage.group); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      ctx.scene.background = bgColor;
      setCamera(ctx.camera);
      const d = w.data;
      if (d.tilt) skyTilt(d.tilt);
      const pls: any[] = d.pl ?? [];
      const seen = new Set<number>(), seenBalls = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const pl = pls[b.slot];
          const a = kit.actor(b, () => shipParts(b.slot));
          const dying = pl && pl.st >= 0x24; // 0x24 dying / 0x25 gone (anim state of the disc's ship)
          const catching = pl?.st === 0x21;
          const hull = a.extra?.userData.hull as THREE.Object3D[] | undefined;
          if (hull && pl) { const off = catching || pl.kcd > 0; hull[0].visible = !off; hull[1].visible = off; }
          a.update(b, dt, {
            hidden: !b.alive,
            hop: 0,
            // the game's anim scripts (per character): 0x1c idle, 0x1d move, 0x1e hit/boost, 0x1f kick (idle clip),
            // 0x21 catch, 0x24 dying
            role: dying ? 'lose' : catching ? 'action' : pl?.st === 0x1e ? 'hit' : pl?.st === 0x1d ? 'run' : 'idle',
            freeze: true,
            keepYaw: false,
          });
          a.pivot.rotation.z = THREE.MathUtils.lerp(a.pivot.rotation.z, -THREE.MathUtils.clamp(b.vx * 0.01, -0.3, 0.3), Math.min(1, dt * 10));
        } else if (b.kind === 'ball') {
          seenBalls.add(b.id);
          let v = balls.get(b.id);
          if (!v) { v = ballObj(b); balls.set(b.id, v); }
          const held = b.dash > 0;
          v.obj.visible = b.alive;
          const gy = Math.max(-1.2, b.y);
          v.obj.position.set(b.x, gy, b.z);
          const sp = Math.hypot(b.vx, b.vz);
          const spin = v.obj.getObjectByName('spin');
          if (spin && sp > 0.1) { axis.set(b.vz, 0, -b.vx).normalize(); spin.rotateOnWorldAxis(axis, (sp * dt) / b.r); }
          v.shadow.set(b.x, b.z, Math.max(0, gy));
          v.halo.visible = held;
          (v.halo.material as THREE.MeshBasicMaterial).color.set(0x9fe8ff);
          v.mat.color.set(BALL_COL[variant] ?? 0xffffff);
        }
      }
      kit.prune(seen);
      for (const [id, v] of balls) if (!seenBalls.has(id)) { kit.root.remove(v.obj); (v.obj.userData.glow as THREE.Object3D | undefined)?.removeFromParent(); kit.fx.removeShadow(v.shadow); disposeTree(v.obj); balls.delete(id); }

      // N.Ballism power-up post: the level's looping effect script 1 at its marker (FUN_800bd770); it ends with the post
      if (d.post) {
        const [cx, cy, cz] = POST_AT[d.post.i];
        if (!post) {
          const at = { x: cx / BD_U, y: -cy / BD_U, z: -cz / BD_U };
          post = at;
          kit.real.play(POST_PACK, 1, at.x, 0, at.z, { loop: true, at: () => (post === at ? at : null) });
        }
      } else post = null;
      // N.Gin machine in the middle of the arena (FUN_800bbc3c): pops up at the floor (y 0) after the rise puff, spins, and swaps
      // to the open mesh (0x2006) while it spits balls
      const m = d.mach;
      if (m && m.st >= 2) {
        if (!machine) {
          const g = new THREE.Group();
          const idle = catalogInstance(getCatalog().props.bdMachine)?.root ?? new THREE.Group();
          const spit = catalogInstance(getCatalog().props.bdMachineSpit)?.root ?? new THREE.Group();
          g.add(idle, spit);
          kit.root.add(g);
          machine = { idle, spit, g };
        }
        machine.g.visible = true;
        machine.idle.visible = m.st !== 4;
        machine.spit.visible = m.st === 4;
        machine.g.rotation.y = -(m.yaw * Math.PI * 2) / 4096;
      } else if (machine) machine.g.visible = false;

      for (const g of goals) {
        const pl = pls[g.slot];
        const closed = !pl || pl.score <= 0;
        g.barrierT = THREE.MathUtils.clamp(g.barrierT + (closed ? dt * 2.5 : -dt * 2.5), 0, 1);
        const st = stage.strips?.[g.slot];
        if (st) { if (st[0]) st[0].visible = !closed; if (st[1]) st[1].visible = closed; }
        const fr = Math.floor(ctx.time * 15) % 8;
        g.zap.forEach((frames, k) => frames.forEach((o, f) => { o.visible = closed && f === (fr + k * 3) % 8; }));
        const sh = (pl?.shield ?? 0) > 0;
        g.shield.visible = sh;
        if (sh) (g.shield.material as THREE.MeshBasicMaterial).opacity = (pl.shield < 45 && Math.floor(ctx.time * 12) % 2 ? 0.1 : 0.3 + Math.sin(ctx.time * 10) * 0.12);
      }
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'sfx': { // every sound the disc triggers, by effect id
          const n = sampleOf(variant, e.o);
          const f = n == null ? undefined : bankFile(n);
          if (f) sfx.playFile(f, VOL(e.o), false, sfxRate(BANK_OF[variant], e.o));
          break;
        }
        case 'hit': {
          const strong = e.v > 1.2;
          kit.actorForSlot(e.o)?.squash.kick(0.3);
          kit.shake((strong ? 0.2 : 0.1) + e.v * 0.1);
          break;
        }
        case 'kick':
          kit.actorForSlot(e.s)?.squash.kick(-0.4);
          break;
        case 'goal':
          kit.shake(0.45);
          break;
        case 'ko': {
          const p = kit.actorForSlot(e.s)?.holder.position;
          const x = p?.x ?? e.x, z = p?.z ?? e.z;
          kit.real.play(FX_PACK, 0, x, 128 / 256, z); // dying state: script 0 at the ship (it rides 128 u up), sfx 0x586
          kit.shake(0.9);
          break;
        }
        case 'launch':
          kit.shake(0.15);
          break;
        case 'machine':
          if (e.v === 1 || e.v === 5) kit.real.play(MACH_PACK, 0, 0, 0, 0); // rise / retract: script 0 at the machine
          if (e.v === 3) { kit.shake(0.2); }
          break;
      }
    },

    // the original HUD: four faces across the top (native x 32/128/320/416, y 20) with the score under each in the big
    // orange digits (measured on a native 512x240 frame of the real game)
    ps1Hud(w, ctx) {
      const out: HudSprite[] = [];
      SLOT_X.forEach((x, slot) => {
        const f = faceSprite(ctx.seats, slot);
        if (!f) return;
        out.push(f, ...bigNumber(Math.max(0, w.data.pl?.[slot]?.score ?? 0), x + 10, 38));
      });
      return out;
    },

    hud(w, slot) {
      const l = w.data.pl?.[slot]?.score ?? 0;
      return l > 0 ? String(l) : 'OUT';
    },

    dispose() {
      for (const v of balls.values()) kit.root.remove(v.obj);
      balls.clear(); goals.length = 0; post = null; machine = null;
      kit.dispose();
    },
  };
}

