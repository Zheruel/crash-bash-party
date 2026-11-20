// BALLISTIX view (shared/games/ballDefence.ts): the four real levels (CRASHBALL, BEACH BALL, N.BALLISM, SKY BALLS)
// seen through the real play and result cameras. Stage pieces come from the disc models listed in assets/stages/ballDefence.json;
// floors and walls that the disc stores elsewhere are rebuilt here from the same level textures.
import * as THREE from 'three';
import { BALLISTIX_OPENING_TICKS, ballistixFloor, ballistixLauncherFrame, BD_BALL_R, BD_HALF, BD_NORMALS, BD_TRAIL_LENGTH, BD_POST_AT, BD_U, ballistixOpeningFrame, type BallistixData } from '../../shared/games/ballDefence';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { ASSET_BASE, getCatalog, type ModelRef } from '../crash';
import { createCharacter } from '../characters';
import { CHARACTERS } from '../../shared/look';

const SHIP_SCALE = 4;
const BALL_REST_Y = 96 / BD_U;
import { sfx, sfxRate } from '../shell/sound';
import { tauntVoice, winnerVoice } from '../shell/voice';
import { BallistixResult, ballistixResultEntry } from './ballDefenceResult';
import type { ActorParts } from './kit';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import { fxPartTemplate, preloadFx } from './realFx';

/** Object pack 0762 at the stage scale: effect script 0 = a knocked-out ship's explosion (FUN_800b79f4). */
const FX_PACK = 762, FX_SCALE = 4;
/** N.Gin machine pack (db 0x80054574 = disc 0764: part0 render id 0x2001, part5 0x2006 while it spits, script 0 = rise / retract
 *  puff) and the N.Ballism level model, whose looping script 1 is the power-up post (FUN_800bd770 at the corner bumper) */
const MACH_PACK = 764, POST_PACK = 651;
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
  beach: { decals: ['extra_5660'] }, // additive glass highlight is coplanar with the floor
  sky: { skip: ['extra_87f0', 'extra_89ac'] },
};
const ARENA_KEY: Record<string, string> = { crashball: 'crashball', beach: 'beachBall', nballism: 'nballism', sky: 'skyBalls' };
const BG: Record<string, number> = { crashball: 0x000000, beach: 0x1a3440, nballism: 0x061a24, sky: 0x6aa6e6 };
const BALL_COL: Record<string, number> = { crashball: 0xe4eef8, beach: 0xb4703c, nballism: 0xe4ecf6, sky: 0xc8d0da };
// FUN_800bfe70, table 800c1a44. Z stays at 1 throughout.
const FLASH_SCALE = [[5, 5], [4, 2], [1.5, 1], [0.5, 0.625], [0.125, 0.125]];

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
  cornerArt?: { corner: number; serve: boolean; frames: THREE.Mesh[][] }[];
  /** per player p: the goal-mouth strip while the goal is open (cyan lights) and once it is closed (red) */
  strips?: [THREE.Object3D | null, THREE.Object3D | null][];
  skyGates?: (THREE.Object3D | undefined)[];
  skyFans?: { slot: number; rest: THREE.Object3D; frames: (THREE.Object3D | undefined)[] }[];
}

/** goal strips per player (p0 near/-z, p1 far/+z, p2 +x, p3 -x): open = placed object, closed = native mesh */
const STRIPS: Record<string, [string, string][]> = {
  crashball: [['extra_d1cc', 'part26'], ['extra_cb64', 'part24'], ['extra_ce98', 'part25'], ['extra_c810', 'part23']],
};
// FUN_800bc564 registers two placed objects per corner and supplies their alternate mesh IDs.
// The rows are in collision order (+x/+z, +x/-z, -x/+z, -x/-z).
const CORNER_ART: Record<string, [string, number, string, number][]> = {
  crashball: [
    ['extra_c688', 15, 'extra_bac4', 21], ['extra_b51c', 17, 'extra_b7e0', 19],
    ['extra_c4f4', 14, 'extra_b940', 20], ['extra_b3bc', 16, 'extra_b680', 18],
  ],
  nballism: [
    ['extra_f9a8', 33, 'extra_106e8', 37], ['extra_fe0c', 31, 'extra_10d90', 35],
    ['extra_f530', 32, 'extra_10920', 36], ['extra_10284', 30, 'extra_10b58', 34],
  ],
};
// The four serve markers use a different corner order. Each has four consecutive alternate meshes.
const SERVE_MARKERS = [0x8ff0, 0x914c, 0x8d38, 0x8e94];

function cornerArt(level: THREE.Object3D, variant: string): Stage['cornerArt'] {
  const rows = CORNER_ART[variant];
  if (!rows) return;
  const art: NonNullable<Stage['cornerArt']> = [];
  const holders = level.getObjectByName('placements')?.children ?? [];
  function bind(corner: number, names: string[], serve = false) {
    const holder = holders.find(o => o.name.endsWith(':' + names[0]));
    if (!holder) return;
    const frames: THREE.Mesh[][] = names.map(() => []);
    holder.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const frame = names.indexOf(mesh.name);
      const index = frame >= 0 ? frame : names.indexOf(mesh.parent?.name ?? '');
      if (index >= 0) frames[index].push(mesh);
    });
    art.push({ corner, serve, frames });
  }
  rows.forEach(([a, altA, b, altB], i) => {
    bind(i, [a, 'part' + altA]);
    bind(i, [b, 'part' + altB]);
  });
  if (variant === 'crashball') SERVE_MARKERS.forEach((base, i) => {
    bind(i, Array.from({ length: 5 }, (_, frame) => 'extra_' + (base + frame * 0x34).toString(16)), true);
  });
  return art;
}
/** Sky Balls's native gate objects (marker 90..93) and fan objects (marker 81, 82), model 0647. */
const SKY_GATES = ['extra_7b98', 'extra_821c', 'extra_7ff0', 'extra_7dc4'];
const SKY_FANS = [
  { slot: 1, rest: 'extra_89ac', firstFrame: 32 },
  { slot: 2, rest: 'extra_87f0', firstFrame: 29 },
];
/** Cloud markers 100, 101, 103 and 104 in 0647 use these [speed, wrap start, wrap end] rows at 0x800c1348. */
const SKY_CLOUD_MOTION: Record<string, [number, number, number]> = {
  extra_7a10: [2, -14336, 16384],
  extra_7800: [4, -14336, 14336],
  extra_8448: [8, -14336, 14336],
  extra_861c: [15, -10240, 10240],
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
    if (variant === 'sky' && ref) {
      // These nodes all receive the live tilt from FUN_800bca38. Discard the tilt captured in placement RAM.
      const parts = new Map<string, THREE.Object3D>();
      lvl.traverse((o) => {
        if (!o.userData.ps1) return;
        const part = o.name.split(':')[1];
        if (part !== 'extra_56bc' && !SKY_GATES.includes(part)) return;
        o.matrix.set(1, 0, 0, o.matrix.elements[12], 0, 1, 0, 0, 0, 0, 1, o.matrix.elements[14], 0, 0, 0, 1);
        o.matrixWorldNeedsUpdate = true;
        parts.set(part, o);
      });
      const skyGates = SKY_GATES.map((part) => parts.get(part));
      for (const gate of skyGates) if (gate) gate.visible = false;
      const mesh = (part: string) => catalogInstance({ ...ref, parts: [part] })?.root;
      const skyFans: NonNullable<Stage['skyFans']> = [];
      for (const { slot, rest: part, firstFrame } of SKY_FANS) {
        const rest = mesh(part);
        if (!rest) continue;
        group.add(rest);
        const frames = Array.from({ length: 8 }, (_, i) => {
          const frame = firstFrame + i <= 34 ? mesh(`part${firstFrame + i}`) : undefined;
          if (frame) { frame.visible = false; group.add(frame); }
          return frame;
        });
        skyFans.push({ slot, rest, frames });
      }
      return { group, skyGates, skyFans };
    }
    return { group, strips, cornerArt: cornerArt(lvl, variant) };
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
  return { group };
}

// ------------------------------------------------------------------ view

interface Goal { slot: number; zap: THREE.Object3D[][] }
interface BallView {
  obj: THREE.Group;
  shadow?: BlobShadow;
  reflection?: THREE.Object3D;
  glow?: THREE.Object3D;
  trail?: THREE.Object3D[];
  materials?: THREE.Material[];
}

export function createBallDefenceView(): ClientMiniGame {
  let kit: Kit;
  let stage: Stage;
  const goals: Goal[] = [];
  const balls = new Map<number, BallView>();
  let post: { x: number; y: number; z: number } | null = null;
  let machine: ReturnType<typeof catalogInstance> = null;
  const spectatorSounds = new Map<number, string>();
  let bankIdx: Record<number, { file: string; loop?: number | null }> = {};
  let motor: ReturnType<typeof sfx.startSample> = null;
  let shieldMaterial: THREE.MeshBasicMaterial | undefined;
  const catchSounds = new Map<number, () => void>();
  const flashes: THREE.Object3D[] = [];
  let loaded = false;
  let active = false;
  let variant = 'crashball';
  let bgColor = new THREE.Color(0);
  let result: BallistixResult | undefined;
  const axis = new THREE.Vector3();
  const billboard = new THREE.Quaternion();
  const shadowFloor = new THREE.Vector3();

  function setCamera(cam: THREE.PerspectiveCamera) {
    const lc = result?.camera ?? LEVEL_CAMS[LEVEL[variant]];
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
   * Sky Balls platform nodes follow the tilt and bob from FUN_800bca38.
   * Cancel the platform transform on the landscape and advance each drifting cloud in world coordinates.
   */
  const tiltM = new THREE.Matrix4(), tiltInv = new THREE.Matrix4(), cloudM = new THREE.Matrix4();
  function skyTilt(t: number[], frame: number) {
    const R = kit.root;
    R.rotation.set((t[0] * Math.PI) / 2048, 0, (-t[1] * Math.PI) / 2048);
    R.position.y = -t[2] / BD_U;
    R.updateMatrix();
    tiltM.copy(R.matrix);
    tiltInv.copy(tiltM).invert();
    stage.group.traverse((o) => {
      const base = o.userData.farBase as THREE.Matrix4 | undefined;
      if (!base) return;
      const motion = o.userData.cloudMotion as [number, number, number] | undefined;
      if (motion) {
        const [speed, start, end] = motion;
        const x = o.userData.ps1[0] as number;
        const firstWrap = Math.floor((end - x) / speed) + 1;
        const cycle = Math.floor((end - start) / speed) + 1;
        const moved = frame < firstWrap ? x + frame * speed : start + (frame - firstWrap) % cycle * speed;
        cloudM.copy(base);
        cloudM.elements[12] = moved / BD_U;
        o.matrix.multiplyMatrices(tiltInv, cloudM);
      } else o.matrix.multiplyMatrices(tiltInv, base);
      o.matrixWorldNeedsUpdate = true;
    });
  }
  /** far scenery of the sky level (L17: landscape 0x500c-e, clouds 0x5002/3/8/9): remembered so skyTilt can cancel the tilt on them */
  const SKY_FAR = ['extra_8b68', 'extra_8e70', 'extra_9114', 'extra_7800', 'extra_7a10', 'extra_8448', 'extra_861c'];
  function markFar(g: THREE.Object3D) {
    const moving = new Map<string, THREE.Object3D>();
    g.traverse((o) => {
      const part = o.name.split(':')[1];
      if (!o.userData.ps1 || !SKY_FAR.includes(part)) return;
      o.userData.farBase = o.matrix.clone();
      o.matrixAutoUpdate = false;
      if (SKY_CLOUD_MOTION[part]) moving.set(part, o);
    });
    // The native marker table keeps the last object with a given id. Only one of the two 0x5002 placements drifts.
    for (const [part, cloud] of moving) cloud.userData.cloudMotion = SKY_CLOUD_MOTION[part];
  }

  function build() {
    const R = kit.root;
    stage = buildStage(variant);
    R.add(stage.group);
    const disc = variant === 'sky';
    if (disc) markFar(stage.group);
    for (let s = 0; s < 4; s++) {
      const [nx, nz] = BD_NORMALS[s];
      const width = disc ? 2 * SKY_R * Math.sin(SKY_ANG) : 2 * GOAL_HALF;
      const edge = disc ? SKY_R : H;
      // knocked-out goal: the game's lightning strip (model 762 meshes 0-7, 514 u long, 8 frames) along the goal line
      const zap: THREE.Object3D[][] = [];
      const zg = new THREE.Group();
      zg.position.set(nx * edge, 0.02, nz * edge);
      zg.rotation.y = Math.atan2(nx, nz);
      const n = disc ? 0 : Math.max(1, Math.round(width / 2));
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
      goals.push({ slot: s, zap });
    }
  }

  function ballObj(b: Body): BallView {
    const g = new THREE.Group();
    // FUN_800b9b6c: Beach Ball uses the copper-coloured mesh (0x2017), the others use 0x2009.
    const ballRef = getCatalog().props.bdBall;
    const beach = variant === 'beach';
    const real = catalogInstance(ballRef && beach ? { ...ballRef, parts: ['part22'] } : ballRef);
    if (real) {
      const materials: THREE.Material[] = [];
      // chrome: the game maps the ball texture by screen-space normal (environment map), so the pattern stays put
      real.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible) return;
        const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshBasicMaterial;
        // Each ball mesh has a uniform vertex tint (PS1 textured colours use 128 as neutral).
        const c = m.geometry.getAttribute('color');
        const color = new THREE.Color();
        if (c) color.setRGB(c.getX(0) * 255 / 128, c.getY(0) * 255 / 128, c.getZ(0) * 255 / 128, THREE.SRGBColorSpace);
        const shaded = new THREE.MeshMatcapMaterial({ matcap: src.map ?? undefined, color });
        m.material = shaded;
        materials.push(shaded);
      });
      real.root.name = 'spin';
      real.root.position.y = BALL_REST_Y;
      real.root.scale.multiplyScalar(b.r / BD_BALL_R);
      g.add(real.root);
      // The original attaches an additive billboard (render flag 0x20000000) at the ball's location.
      const reflection = ballRef ? catalogInstance({ ...ballRef, parts: [beach ? 'part21' : 'part10'] }) : null;
      if (reflection) {
        reflection.root.position.y = BALL_REST_Y;
        reflection.root.scale.multiplyScalar(b.r / BD_BALL_R);
        reflection.root.traverseVisible((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          asDecal(mesh);
          materials.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
        });
        g.add(reflection.root);
      }
      kit.root.add(g);
      // floor glow instead of a dark blob: model 762 mesh 12 (radial disc), additive, the cyan the game shows under balls
      const glow = variant === 'crashball' ? catalogInstance(getCatalog().props.bdGlow) : null;
      let trail: THREE.Object3D[] | undefined;
      if (glow) {
        // Crashball uses the same radial mesh for six afterimages, with scale decrement 0x180 and increasing fade.
        glow.root.updateMatrixWorld(true);
        const trailMeshes: THREE.Mesh[] = [];
        glow.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) trailMeshes.push(o as THREE.Mesh); });
        trail = Array.from({ length: BD_TRAIL_LENGTH }, (_, i) => {
          const point = new THREE.Group();
          point.userData.shared = true;
          const scale = (0x1000 - i * 0x180) / 0x1000;
          point.scale.set(scale, 1, scale);
          point.name = 'ball-trail';
          for (const sourceMesh of trailMeshes) {
            const mesh = sourceMesh.clone(false);
            mesh.matrix.copy(sourceMesh.matrixWorld);
            mesh.matrixAutoUpdate = false;
            const source = mesh.material as THREE.MeshBasicMaterial;
            const material = source.clone();
            material.defines = { ...source.defines };
            material.onBeforeCompile = source.onBeforeCompile;
            material.customProgramCacheKey = source.customProgramCacheKey;
            material.blending = THREE.CustomBlending;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneFactor;
            material.depthWrite = false;
            material.polygonOffset = true;
            material.polygonOffsetFactor = -1;
            material.polygonOffsetUnits = -8;
            material.transparent = true;
            material.color.multiplyScalar((scale - 0x180 / 0x1000) / 2);
            mesh.material = material;
            materials.push(material);
            point.add(mesh);
          }
          point.visible = false;
          g.add(point);
          return point;
        });
        glow.root.traverseVisible((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const glowMat = (mesh.material as THREE.MeshBasicMaterial).clone();
          glowMat.blending = THREE.AdditiveBlending;
          glowMat.depthWrite = false;
          glowMat.transparent = true;
          glowMat.color.setHex(0x58c8e8);
          mesh.material = glowMat;
          materials.push(glowMat);
        });
        glow.root.scale.setScalar(2);
        kit.root.add(glow.root);
      }
      return { obj: g, reflection: reflection?.root, glow: glow?.root, trail, materials };
    }
    const mat = new THREE.MeshBasicMaterial({ color: BALL_COL[variant] ?? 0xffffff });
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
    sph.name = 'spin';
    // PS1-style shading: dark underside, bright top (vertex colours)
    const pos = sph.geometry.attributes.position, cols: number[] = [];
    for (let i = 0; i < pos.count; i++) { const k = 0.55 + 0.45 * ((pos.getY(i) + 1) / 2); cols.push(k, k, k); }
    sph.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    mat.vertexColors = true;
    sph.scale.setScalar(b.r);
    sph.position.y = b.r;
    g.add(sph);
    kit.root.add(g);
    return { obj: g, shadow: kit.fx.shadow(b.r * 1.4, 0.5) };
  }

  function removeBall(v: BallView) {
    v.obj.removeFromParent();
    v.glow?.removeFromParent();
    if (v.shadow) kit.fx.removeShadow(v.shadow);
    v.materials?.forEach((m) => m.dispose());
    disposeTree(v.obj);
  }

  function shipParts(slot: number): ActorParts {
    // Real assembly (emulator RAM): the per-character Ballistix pilot (896-910, animated) and the hull (766) share the player
    // entity's origin, which rides 128 u above the floor; level units, native facing.
    const id = CHARACTERS[kit.look(slot).char % CHARACTERS.length].id;
    const pilot = catalogInstance(getCatalog().props[`bdPilot.${id}`]);
    let inst: ReturnType<typeof createCharacter>;
    if (pilot) { inst = pilot; pilot.play('idle'); } else { inst = createCharacter(kit.look(slot), { ring: false }); inst.root.position.y = 0.6; }
    // The native hull, pilot and ring each have zero local offset in the render chain.
    const shipRef = getCatalog().props.bdShip;
    const ship = shipRef ? catalogInstance({ ...shipRef, yaw: 0 }) : null;
    const extra = new THREE.Group();
    if (ship) {
      extra.add(ship.root);
      // FUN_800b5c30: render id 0x2004 (part3) normally, 0x2006 (part5, bumper lights off) while catching (state 0x21) or while the
      // kick recharges (+0x66)
      const dimRef = getCatalog().props.bdShipDim;
      const dim = dimRef ? catalogInstance({ ...dimRef, yaw: 0 }) : null;
      if (dim) { dim.root.visible = false; extra.add(dim.root); extra.userData.hull = [ship.root, dim.root]; }
      // Model 0766: the shockwave (render id 0x2001) and the Beach Ball capture ring (0x2003).
      const kick = catalogInstance({ model: 766, scale: SHIP_SCALE, parts: ['part0'] })?.root;
      const catchRing = catalogInstance({ model: 766, scale: SHIP_SCALE, parts: ['part2'] })?.root;
      for (const ring of [kick, catchRing]) if (ring) {
        ring.visible = false;
        extra.add(ring);
      }
      extra.userData.kick = kick;
      extra.userData.catchRing = catchRing;
    }
    else {
      const hull = new THREE.Mesh(new THREE.SphereGeometry(1.5, 20, 10).scale(1, 0.4, 1), basic({ color: 0x3a9a7a }));
      extra.add(hull);
    }
    if (variant === 'nballism') {
      const field = fxPartTemplate(FX_PACK, 19, FX_SCALE)?.clone();
      if (field) {
        field.traverseVisible(o => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          shieldMaterial ??= (mesh.material as THREE.MeshBasicMaterial).clone();
          mesh.material = shieldMaterial;
        });
        field.name = 'nballism-shield';
        field.visible = false;
        extra.add(field);
        extra.userData.field = field;
      }
    }
    return { inst, extra, shadow: 1.8, headY: 2.2, scale: 1, steady: true };
  }

  function catchSound(slot: number, active: boolean) {
    const stop = catchSounds.get(slot);
    if (stop) {
      if (!active) { stop(); catchSounds.delete(slot); }
      return;
    }
    if (!active) return;
    const id = 1451 + slot;
    const sample = bankIdx[EXTRA.beach[id]];
    if (sample?.loop != null) catchSounds.set(slot, sfx.loopFile(sample.file, sample.loop, VOL(id), sfxRate(BANK_OF.beach, id)));
  }

  function playSound(id: number) {
    const n = sampleOf(variant, id);
    const sample = n == null ? undefined : bankIdx[n];
    if (sample) sfx.playFile(sample.file, VOL(id), false, sfxRate(BANK_OF[variant], id));
  }

  return {
    id: 'ballDefence',
    async preload() {
      await Promise.all([preloadCatalogFor('ballDefence', ['bdShip', 'bdShipDim', 'bdBall', 'bdGlow', 'bdMachine', 'bdMachineSpit', ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `bdZap${k}`), ...CHARACTERS.map((c) => `bdPilot.${c.id}`)]), preloadFx([FX_PACK, MACH_PACK, POST_PACK]), ...Object.entries(LEVEL).map(async ([v, l]) => placements.set(v, await loadPlacements('L' + l)))]);
      loaded = true;
    },

    init(ctx, world) {
      active = true;
      variant = world.data.variant ?? 'crashball';
      spectatorSounds.clear();
      bgColor = new THREE.Color(BG[variant] ?? 0);
      kit = new Kit(ctx, 'ballDefence', { bg: BG[variant] ?? 0, hemi: [0xffffff, 0x888899, 1.6] });
      kit.realFx(FX_SCALE);
      goals.length = 0; balls.clear(); post = null; machine = null; bankIdx = {}; result = undefined;
      // samples are shared between banks on disc, so the file comes from audio/index.json
      void fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!active) return;
        for (const id of [0x194, 0x195]) {
          const file = j?.sfx?.banks?.['0277']?.samples[id - 0x192]?.file;
          if (file) { spectatorSounds.set(id, file); sfx.preloadFile(file); }
        }
        const smp: { n: number; file?: string | null; loop?: number | null }[] = j?.sfx?.banks?.[BANK_OF[variant]]?.samples ?? [];
        for (const { n, file, loop } of smp) if (file) bankIdx[n] = { file, loop };
        const ids = new Set<number>(Object.values({ ...COMMON, ...EXTRA[variant] }));
        for (const n of ids) if (bankIdx[n]) sfx.playFile(bankIdx[n].file, 0); // preload
      }).catch(() => { /* silent */ });
      build();
      setCamera(ctx.camera);
      if (!loaded) this.preload!().then(() => {
        if (!active) return;
        kit.reset();
        kit.root.remove(stage.group);
        disposeTree(stage.group);
        stage = buildStage(variant);
        kit.root.add(stage.group);
        if (variant === 'sky') markFar(stage.group);
      });
    },

    render(ctx, w, dt) {
      kit.checkOver(w, false);
      const d = w.data as BallistixData;
      if (!result) {
        const winner = w.finished ? kit.over.winners.values().next().value : d.pl.findIndex(p => p.score > 0);
        if (winner !== undefined && winner >= 0) {
          const entry = ballistixResultEntry(w, winner);
          if (entry !== undefined) {
            const late = d.f - entry > 6 || (ctx.resultReplayAt !== undefined && ctx.time - ctx.resultReplayAt > 0.2);
            result = new BallistixResult(w, winner, entry, LEVEL_CAMS[LEVEL[variant]], late);
          }
        }
      }
      const arena = result?.advance(w, ctx.time, ctx.resultReplayAt, e => this.onEvent?.(ctx, e)) ?? w;
      if (result && result.age >= 0 && result.audioAge !== result.age) {
        if (result.audioAge < 0) sfx.enterRoundResult('winner');
        if (result.audioAge >= 0 || !result.arrivedLate) {
          winnerVoice('ballDefence', kit.look(result.slot).char, Math.max(0, result.audioAge, result.age - 6), result.age);
        }
        result.audioAge = result.age;
      }
      const players = d.beachDecidedAt !== undefined ? arena : w;
      ctx.scene.background = bgColor;
      setCamera(ctx.camera);
      const stageData = arena.data as BallistixData;
      const markers = result ? undefined : w.ballistixMarkers;
      const lit = markers?.lights ?? stageData.bumperFrames ?? (stageData.post ? 1 << stageData.post.i : 0);
      for (const marker of stage.cornerArt ?? []) {
        const cooldown = (markers?.cool ?? stageData.cool)[marker.corner];
        const serveFrame = cooldown > 0 && cooldown < 31 ? 1 + (((31 - cooldown) >> 2) & 3) : 0;
        const frame = marker.serve ? serveFrame : (lit >> marker.corner) & 1;
        marker.frames.forEach((meshes, i) => { for (const mesh of meshes) mesh.visible = i === frame; });
      }
      const remaining = w.tick === 0 ? ctx.countdownTicksLeft : undefined;
      const opening = remaining === undefined ? undefined : ballistixOpeningFrame(remaining);
      const tilt = variant === 'sky' ? opening?.tilt ?? stageData.tilt : undefined;
      if (tilt) skyTilt(tilt, opening?.pose ?? BALLISTIX_OPENING_TICKS + stageData.f);
      kit.root.getWorldQuaternion(billboard).invert().multiply(ctx.camera.quaternion);
      if (variant === 'crashball') {
        const tick = opening ? opening.pose - BALLISTIX_OPENING_TICKS : markers?.tick ?? stageData.f;
        let used = 0;
        for (const flash of markers?.flashes ?? stageData.flashes ?? []) {
          const scale = FLASH_SCALE[tick - flash.tick];
          if (!scale) continue;
          let obj = flashes[used];
          if (!obj) {
            const template = fxPartTemplate(659, 22, FX_SCALE);
            if (!template) continue;
            obj = template.clone();
            obj.name = 'crashball-flash';
            flashes.push(obj);
            kit.root.add(obj);
          }
          used++;
          obj.visible = true;
          obj.position.set(flash.x / BD_U, -flash.y / BD_U, -flash.z / BD_U);
          obj.quaternion.copy(billboard);
          obj.scale.set(scale[0], scale[1], 1);
        }
        for (let i = used; i < flashes.length; i++) flashes[i].visible = false;
      }
      for (const fan of stage.skyFans ?? []) {
        const flicker = stageData.sky?.ev[fan.slot]?.st === 1 || stageData.sky?.ev[fan.slot]?.st === 2;
        fan.rest.visible = !flicker;
        fan.frames.forEach((o, i) => { if (o) o.visible = flicker && i === ((stageData.f >> 1) & 7); });
      }
      const pls: BallistixData['pl'] = players.data.pl;
      const rawBalls = stageData.balls;
      const seen = new Set<number>(), seenBalls = new Set<number>();
      const bodies = players === arena ? arena.bodies : [
        ...players.bodies.filter(b => b.kind === 'player'), ...arena.bodies.filter(b => b.kind === 'ball'),
      ];
      // FUN_800bdd94 uses one global 32-tick phase for shield scale and fade to black.
      const arenaTick = markers?.tick ?? stageData.f;
      const pulse = Math.round(4096 * Math.sin((arenaTick & 31) * Math.PI / 16)) >> 2;
      for (const b of bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const player = (result ? players.data : kit.playerWorld(b.slot).data) as BallistixData;
          const pl = player.pl?.[b.slot] ?? pls[b.slot];
          const a = kit.actor(b, () => shipParts(b.slot));
          const gone = pl.st === 0x25;
          const dying = pl.st === 0x24;
          const celebration = !!result && result.age >= 0;
          const winner = celebration && result!.slot === b.slot ? result!.winnerBody(b, stageData) : undefined;
          const seatedLoser = celebration && !winner && pl.score > 0;
          const catching = pl.st === 0x21 && !winner && !seatedLoser;
          const kicking = pl.st === 0x1f && !winner && !seatedLoser;
          const age = (player.f ?? d.f) - (pl?.stateAt ?? 0);
          const idleGesture = pl?.st === 0x1c && pl.idleAt >= 0;
          const hull = a.extra?.userData.hull as THREE.Object3D[] | undefined;
          if (hull && !dying) {
            const cooldown = winner && d.beachDecidedAt === undefined ? pl.kcd - result!.age : pl.kcd;
            const off = catching || cooldown > 0;
            hull[0].visible = !off;
            hull[1].visible = off;
          }
          const kick = a.extra?.userData.kick as THREE.Object3D | undefined;
          if (kick) {
            kick.visible = kicking;
            if (kicking) kick.scale.setScalar(1 + Math.max(0, pl.kfr - 1) * 0x600 / 0x1000);
          }
          const catchRing = a.extra?.userData.catchRing as THREE.Object3D | undefined;
          if (catchRing) {
            catchRing.visible = catching;
            if (catching) catchRing.scale.setScalar(1 + 0.125 * Math.sin((player.f - 8) * Math.PI / 16));
          }
          if (variant === 'beach') catchSound(b.slot, catching && !w.finished);
          if (celebration) a.face = winner?.body.face ?? b.face;
          const body = winner?.body ?? b;
          const openingShip = opening?.ships[b.slot];
          const hover = celebration ? -128 : openingShip?.y ?? pl.y ?? -128;
          a.update(body, dt, {
            hidden: gone,
            // The catch and kick enter handlers both start script 0x1d (the seated idle pose).
            script: dying ? 0x20 : seatedLoser ? 0x19 : catching || kicking ? 0x1d : pl.st === 0x1e ? 0x1c : pl.st === 0x1d ? 0x1a : idleGesture ? 0x1b : 0x19,
            scriptFrame: opening?.pose ?? (seatedLoser ? result!.age : idleGesture ? player.f - pl.idleAt : age),
            renderWord: winner?.pose,
            hop: -hover / BD_U,
            role: dying ? 'lose' : pl?.st === 0x1e ? 'hit' : pl?.st === 0x1d ? 'run' : 'idle',
            freeze: true,
            keepYaw: celebration,
          });
          if (tilt && !gone) {
            // L17 changes the hull height while leaving its horizontal position and axes in world space.
            const floor = ballistixFloor(tilt, Math.round(body.x * BD_U), Math.round(-body.z * BD_U));
            const sampledFloor = celebration || dying ? floor : openingShip?.skyFloor ?? pl.skyFloor ?? floor;
            const height = winner?.y ?? sampledFloor + hover;
            a.holder.position.set(body.x, -height / BD_U, body.z).applyMatrix4(tiltInv);
            a.holder.quaternion.setFromRotationMatrix(tiltInv);
            shadowFloor.set(body.x, -floor / BD_U, body.z).applyMatrix4(tiltInv);
            a.shadow.set(shadowFloor.x, shadowFloor.z, (floor - height) / BD_U);
          }
          a.pivot.rotation.z = -(winner?.roll ?? openingShip?.roll ?? pl.roll ?? 0) * Math.PI / 2048;
          const field = a.extra?.userData.field as THREE.Object3D | undefined;
          if (field) {
            const remaining = result ? stageData.pl[b.slot].shield : markers?.shields?.[b.slot] ?? pl.shield;
            field.visible = remaining > 0 && !dying;
            if (field.visible) {
              // The creation callback initializes a neutral transform. The next callback attaches it to its ship.
              const created = remaining === 241;
              if (created) field.quaternion.copy(a.yaw.quaternion).multiply(a.pivot.quaternion).invert();
              else field.quaternion.identity();
              field.scale.setScalar(created ? 1 : (0x1200 + pulse) / 4096);
              shieldMaterial?.color.setScalar(created ? 1 : 1 - (0x600 + pulse) / 4096);
            }
          }
        } else if (b.kind === 'ball') {
          seenBalls.add(b.id);
          let v = balls.get(b.id);
          if (!v) { v = ballObj(b); balls.set(b.id, v); }
          v.obj.visible = b.alive;
          v.obj.position.set(b.x, b.y, b.z);
          const ball = rawBalls.find(ball => ball.id === b.id);
          const spin = v.obj.getObjectByName('spin');
          if (spin && ball?.pitch !== undefined) {
            spin.rotation.set(ball.pitch * Math.PI / 2048, -(ball.yaw ?? 0) * Math.PI / 2048, 0, 'YXZ');
          } else if (spin) {
            const speed = Math.hypot(b.vx, b.vz);
            if (speed > 0.1) { axis.set(b.vz, 0, -b.vx).normalize(); spin.rotateOnWorldAxis(axis, speed * dt / b.r); }
          }
          if (tilt) {
            v.obj.position.applyMatrix4(tiltInv);
            v.obj.quaternion.setFromRotationMatrix(tiltInv);
            v.reflection?.quaternion.copy(ctx.camera.quaternion);
          } else {
            v.reflection?.quaternion.copy(billboard);
          }
          if (v.trail) {
            const points = ball?.trail;
            v.trail.forEach((segment, i) => {
              const p = points?.[i + 1];
              segment.visible = !!p;
              if (p) segment.position.set(p[0] / BD_U - b.x, -b.y, -p[1] / BD_U - b.z);
            });
          }
          if (v.glow) {
            v.glow.position.set(b.x, 0.02, b.z);
            v.glow.visible = v.obj.visible;
          }
          v.shadow?.set(b.x, b.z, Math.max(0, b.y));
        }
      }
      kit.prune(seen);
      for (const [id, v] of balls) if (!seenBalls.has(id)) { removeBall(v); balls.delete(id); }

      // N.Ballism power-up post: the level's looping effect script 1 at its marker (FUN_800bd770); it ends with the post
      if (stageData.post) {
        const [cx, cy, cz] = BD_POST_AT[stageData.post.i];
        if (!post || post.x !== cx / BD_U || post.z !== -cz / BD_U) {
          const at = { x: cx / BD_U, y: -cy / BD_U, z: -cz / BD_U };
          post = at;
          kit.real.play(POST_PACK, 1, at.x, 0, at.z, { loop: true, at: () => (post === at ? at : null) });
        }
      } else post = null;
      // N.Gin machine in the middle of the arena (FUN_800bbc3c): pops up at the floor (y 0) after the rise puff, spins, and swaps
      // to the open mesh (0x2006) while it spits balls
      const m = stageData.mach;
      const pose = m && ballistixLauncherFrame(m, arenaTick);
      if (pose && pose.motorAge >= 0) {
        const spin = bankIdx[EXTRA.nballism[1471]];
        if (!motor && spin?.loop != null) {
          const rate = sfxRate(BANK_OF.nballism, 1471);
          motor = sfx.startSample(spin.file, spin.loop, VOL(1471), rate, pose.motorAge * rate / 30);
        }
      } else if (motor) {
        motor.stop();
        motor = null;
      }
      if (pose) {
        if (!machine) {
          const ref = getCatalog().props.bdMachine;
          if (ref) machine = catalogInstance({ ...ref, parts: ['part0', 'part5'] });
          if (machine) kit.root.add(machine.root);
        }
        if (machine) {
          machine.nativePose(pose.word);
          machine.root.visible = true;
          machine.root.rotation.y = -pose.yaw * Math.PI / 2048;
        }
      } else if (machine) machine.root.visible = false;

      for (const g of goals) {
        const pl = pls[g.slot];
        const closed = !pl || pl.score <= 0;
        const gate = stage.skyGates?.[g.slot];
        if (gate) gate.visible = closed;
        const st = stage.strips?.[g.slot];
        if (st) { if (st[0]) st[0].visible = !closed; if (st[1]) st[1].visible = closed; }
        const barrier = result ? !!(stageData.walls & [1, 2, 8, 4][g.slot]) : closed;
        const fr = result ? stageData.f & 7 : Math.floor(ctx.time * 15) % 8;
        g.zap.forEach((frames, k) => frames.forEach((o, f) => { o.visible = barrier && f === (fr + k * 3) % 8; }));
      }
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'sfx': {
          const prompt = spectatorSounds.get(e.o);
          if (prompt) sfx.playFile(prompt, 1, true, sfxRate('0277', e.o));
          else if (e.o !== 1471) playSound(e.o);
          break;
        }
        case 'hit': {
          if (result) break;
          const strong = e.v > 1.2;
          kit.actorForSlot(e.o)?.squash.kick(0.3);
          kit.shake((strong ? 0.2 : 0.1) + e.v * 0.1);
          break;
        }
        case 'kick':
          kit.actorForSlot(e.s)?.squash.kick(-0.4);
          break;
        case 'taunt':
          tauntVoice('a2', ctx.seats[e.s]?.look.char, e.o);
          break;
        case 'goal':
          kit.shake(0.45);
          break;
        case 'gone':
          kit.real.play(FX_PACK, 0, e.x, e.v, e.z);
          if (!result) kit.shake(0.9);
          break;
        case 'launch':
          kit.shake(0.15);
          break;
        case 'machine':
          if (e.s === 1 || e.s === 5) kit.real.play(MACH_PACK, 0, 0, 0, 0); // rise / retract: script 0 at the machine
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
      active = false;
      flashes.length = 0;
      motor?.stop();
      motor = null;
      shieldMaterial?.dispose();
      shieldMaterial = undefined;
      for (const stop of catchSounds.values()) stop();
      catchSounds.clear();
      for (const v of balls.values()) removeBall(v);
      balls.clear(); goals.length = 0; post = null; machine = null;
      kit.dispose();
    },
  };
}

