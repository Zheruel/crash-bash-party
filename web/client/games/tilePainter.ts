// POGO PANDEMONIUM view (shared/games/tilePainter.ts): the real stages 675 / 671 / 667 / 663 with an 8x8 painted floor.
import * as THREE from 'three';
import { borderColor, TP_N, TP_TILE, tileCenter, tileWorld } from '../../shared/games/tilePainter';
import { createCharacter, usedVariant } from '../characters';
import { ASSET_BASE, getCatalog, ModelInstance } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import type { ActorParts } from './kit';
import { canvasTexture, catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
import { scoreHud } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import { CHARACTERS } from '../../shared/look';
import type { ClientMiniGame } from './types';
import { PartBatch, preloadFx } from './realFx';

/**
 * Real effects (re/notes/pogoPainter.md "Effects"): object pack 0770's effect scripts (0 explosion, 1 pickup puff, 2 stun
 * puff, 3 crate break, 4 touchdown dust, 8 beam end), its beam segment frames (parts 2-9), the HUD digits (0732) for the
 * cash-in score and El Pogo Loco's own mine blast (level model 0667 script 1).
 */
/** El Pogo Loco's monster (object 0x1406): pack db 0x80053bd4 = disc 0768 (render id 0x2001, three clips: 0 wait 21 f,
 *  1 spin 26 f, 2 hop 14 f = the hop cycle of FUN_800c0cf4) */
const MONSTER = 768;
const PACK = 770, DIGITS = 732, LOCO = 667, K = TP_TILE * 2, U = K / 1024;

/** Player colours are the pad colours of the corners (yellow BL, red TL, blue TR, green BR), not the character colours. */
const PAD = ['#d8c81c', '#d02020', '#2438d0', '#1ea81e'];
/** item ids from the sim (c5360): 1 missile, 2 four-way, 3 electro, 4 steal gun, 5 speed, 6 shield */
/** pack 0770 part per item id, as the item lies on its tile (FUN_800ba25c) and rides the player's held-item node
 *  (FUN_800b935c): 1 missile 0x200d, 2 four-way 0x201b, 3 beam 0x2002, 4 steal gun 0x2040, 5 speed shoes 0x200c, 6 shield 0x2042 */
const ITEM_PART = [-1, 12, 26, 1, 63, 11, 65];

/** Per level: stage key, texture folder, fixed camera fitted to the real gameplay frames (model units -> x3.6 world). */
interface Level { level: number; arena: string; tex: string; neutral: number; colors: number[]; mode: 'tex' | 'hole' | 'sand'; bg: number; pos: [number, number, number]; pitch: number; fov: number; sfx: string }
const S = 3.6;
const LEVELS: Record<string, Level> = {
  pogo: { level: 10, arena: 'tilePainter:pogoPainter', tex: '0674', neutral: 0, colors: [56, 53, 54, 55], mode: 'tex', bg: 0x1c2a16, pos: [0, 2.98 * S, 6.244 * S], pitch: 24.41, fov: 36.3, sfx: '0171' },
  agogo: { level: 11, arena: 'tilePainter:pogoAGogo', tex: '', neutral: 0, colors: [], mode: 'hole', bg: 0x9ac4e8, pos: [0, 3.15 * S, 5.85 * S], pitch: 27.06, fov: 37.2, sfx: '0170' },
  elpogoloco: { level: 12, arena: 'tilePainter:elPogoLoco', tex: '', neutral: 0, colors: [], mode: 'sand', bg: 0xb8806a, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0169' },
  padlock: { level: 13, arena: 'tilePainter:pogoPadlock', tex: '0662', neutral: 0, colors: [41, 38, 39, 40], mode: 'tex', bg: 0x4a4a52, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0168' },
};

const placements = new Map<number, Placements | null>();
/** The board's 64 tile objects: a run of 64 sub-meshes 0x7c apart (the view draws its own paintable tiles). */
function boardTiles(pl: Placements | null): string[] {
  if (!pl) return [];
  const offs = [...new Set(pl.objects.map((o) => o.part).filter(Boolean))].map((p) => parseInt(p.slice(6), 16)).sort((a, b) => a - b);
  for (let i = 0; i + 64 <= offs.length; i++) if (offs[i + 63] - offs[i] === 63 * 0x7c) return offs.slice(i, i + 64).map((o) => 'extra_' + o.toString(16));
  return [];
}
const pad3 = (n: number) => String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, '0');
/**
 * Original sound id (FUN_80022660 arg) -> sample index n in the level's sfx bank (VAB tone -> vag - 1; see re/notes/pogoPainter.md).
 * 0x55a..0x565 (foreign-tile steps 55a-55d, landing per character 55e-565) are a contiguous run starting at RUN[bank].
 */
const RUN: Record<string, number> = { '0171': 13, '0170': 14, '0169': 21, '0168': 24 };
const SND: Record<string, Record<number, number>> = {
  '0171': { 0x514: 2, 0x515: 3, 0x51d: 5, 0x51e: 7, 0x51f: 8, 0x520: 9, 0x522: 11, 0x438: 6, 0x43c: 12, 0x41c: 34, 0x41f: 36, 0x3fa: 35, 0x529: 1, 0x1c2: 33 },
  '0170': { 0x514: 3, 0x515: 4, 0x51d: 6, 0x51e: 8, 0x51f: 9, 0x520: 10, 0x522: 12, 0x438: 7, 0x43c: 13, 0x41c: 35, 0x41f: 37, 0x3fa: 36, 0x532: 0, 0x533: 1, 0x534: 2, 0x1c2: 34 },
  '0169': { 0x514: 10, 0x515: 11, 0x51d: 13, 0x51e: 15, 0x51f: 16, 0x520: 17, 0x522: 19, 0x438: 14, 0x43c: 20, 0x41c: 42, 0x41f: 44, 0x3fa: 43, 0x3ec: 5, 0x3ed: 6, 0x3ee: 5, 0x3ef: 6, 0x3f1: 8, 0x3f2: 9, 0x3f3: 8, 0x3f4: 9, 0x542: 3, 0x543: 4, 0x1c2: 41 },
  '0168': { 0x514: 13, 0x515: 14, 0x51d: 16, 0x51e: 18, 0x51f: 19, 0x520: 20, 0x522: 22, 0x438: 17, 0x43c: 23, 0x41c: 45, 0x41f: 47, 0x3fa: 46, 0x54b: 5, 0x54c: 6, 0x54d: 7, 0x54e: 8, 0x54f: 9, 0x550: 10, 0x551: 11, 0x552: 12, 0x1c2: 44 },
};

function makePogo(hex: string): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: 0.5, roughness: 0.35 });
  const team = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.5 });
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.1, 16), team);
  foot.position.y = 0.05;
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.035, 6, 14).rotateX(Math.PI / 2), steel);
    c.position.y = 0.12 + i * 0.07;
    g.add(c);
  }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), steel);
  post.position.y = 0.45;
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.09, 14), team);
  pad.position.y = 0.55;
  g.add(foot, post, pad);
  return g;
}

// ---------------------------------------------------------------- canvas art (the real tile/splat textures are not in the stage models)
const hash = (i: number) => { let x = Math.imul(i + 1, 2654435761) >>> 0; x ^= x >>> 15; return (x >>> 0) / 4294967296; };

function blobTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.fillStyle = '#fff';
    g.beginPath();
    const lobes = 6;
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const r = s * (0.36 + 0.05 * Math.sin(a * lobes + 1) + 0.03 * Math.sin(a * 3 + 2));
      const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.16, 0, Math.PI * 2); g.fill();
  }, undefined, false);
}

function holeTileTexture(): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.fillStyle = '#8e8c7e'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#a6a496'; g.fillRect(1, 1, s - 2, 2); g.fillRect(1, 1, 2, s - 2);
    g.fillStyle = '#5e5c50'; g.fillRect(1, s - 3, s - 2, 2); g.fillRect(s - 3, 1, 2, s - 2);
    g.fillStyle = '#3c3c34'; g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.36, s * 0.36, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6a685c'; g.beginPath(); g.ellipse(s / 2, s / 2 + 2, s * 0.3, s * 0.28, 0, 0, Math.PI * 2); g.fill();
  });
}

function sandGridTexture(): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(90,50,30,0.45)'; g.lineWidth = 3;
    g.strokeRect(1, 1, s - 2, s - 2);
    g.strokeStyle = 'rgba(255,220,180,0.18)'; g.lineWidth = 2;
    g.strokeRect(4, 4, s - 8, s - 8);
  });
}

export function createTilePainterView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'pogo';
  let lv: Level = LEVELS.pogo;
  const loader = new THREE.TextureLoader();
  const owner = new Array<number>(TP_N * TP_N).fill(-2);
  const capd = new Array<number>(TP_N * TP_N).fill(0);
  const pop = new Float32Array(TP_N * TP_N);
  const tileMesh: THREE.Mesh[] = [];
  const paintMesh: THREE.Mesh[] = [];
  const mats: THREE.MeshBasicMaterial[] = []; // 0..3 owner, 4 neutral
  const paintMats: THREE.MeshBasicMaterial[] = [];
  const pogoSprings = new Map<number, THREE.Object3D>();
  const objs = new Map<number, { obj: THREE.Object3D; boom?: boolean; yaw?: number; mon?: ModelInstance; t?: number }>();
  /** held item per slot: the pack part on the player's held-item node */
  const icons = new Map<number, { item: number; obj: THREE.Object3D | null }>();
  /** one pack 0770 part at the stage scale (render id 0x2000 + part + 1) */
  const packPart = (part: number): THREE.Object3D => catalogInstance({ model: PACK, scale: K, parts: [`part${part}`] })?.root ?? new THREE.Group();
  const stunT = new Map<number, number>();
  /** last hop counter per slot (touchdown dust at 14), beam segment batches (parts 2-9), current level */
  const lastCnt = [-1, -1, -1, -1];
  let beams: PartBatch[] = [];
  let gameLvl = 10;
  const mkBeams = () => { for (const b of beams) b.dispose(); beams = Array.from({ length: 8 }, (_, i) => new PartBatch(kit.root, PACK, 2 + i, K, 16, true)); };
  const ovMesh: THREE.Mesh[] = []; // per-tile overlay: mine / cross tile / locked
  const ovMats: Record<string, THREE.MeshBasicMaterial> = {};
  const stripMesh: THREE.Mesh[] = []; // lvl 11 rotating border (32 segments)
  let stripKey = -1;
  const stN = new Array<number>(TP_N * TP_N).fill(-1);
  let arena: THREE.Group | null = null;
  // samples are shared between banks on disc, so the file comes from audio/index.json
  let bankIdx: Record<string, { file?: string | null }[]> | null = null;
  void fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    bankIdx = {};
    for (const [k, v] of Object.entries<{ samples: { file?: string | null }[] }>(j?.sfx?.banks ?? {})) bankIdx[k] = v.samples;
  }).catch(() => { /* silent */ });
  function playId(id: number, vol = 0.55) {
    let n = SND[lv.sfx]?.[id];
    if (n === undefined && id >= 0x55a && id <= 0x565) n = RUN[lv.sfx] + (id - 0x55a);
    if (n === undefined) return;
    const f = bankIdx?.[lv.sfx]?.[n]?.file;
    if (f) sfx.playFile(f, vol, false, sfxRate(lv.sfx, id));
  }

  function tex(dir: string, n: number): THREE.Texture {
    const t = loader.load(`${ASSET_BASE}textures/${dir}/tex${String(n).padStart(3, '0')}.png`);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    return t;
  }

  function build() {
    const R = kit.root;
    const ref = getCatalog().arenas[lv.arena];
    // the level as the real game builds it (RAM object list); the 64 board tiles are ours (paintable)
    const pl = placements.get(lv.level) ?? null;
    const lvl = ref ? levelStage(ref, pl, (r) => catalogInstance(r)?.root ?? null, { skip: boardTiles(pl) }) : null;
    if (lvl) { arena = lvl; R.add(lvl); }
    else {
      const inst = catalogInstance(ref);
      if (inst) {
        arena = new THREE.Group(); arena.add(inst.root);
        for (const ex of (ref as { extra?: (typeof ref)[] } | undefined)?.extra ?? []) { const m = catalogInstance(ex); if (m) arena.add(m.root); }
        R.add(arena);
      }
    }
    if (!lvl && lv.mode !== 'tex') { // fallback only: without the real level objects the ground ends early
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: lv.mode === 'hole' ? 0xb4803c : 0xa0644a }));
      apron.position.y = -0.03;
      R.add(apron);
    }
    const geo = new THREE.PlaneGeometry(TP_TILE * 0.995, TP_TILE * 0.995).rotateX(-Math.PI / 2);
    const mk = (map: THREE.Texture | null, color = 0xffffff, transparent = false) => new THREE.MeshBasicMaterial({ map, color, transparent, alphaTest: transparent ? 0.02 : 0, depthWrite: !transparent });
    if (lv.mode === 'tex') {
      for (let s = 0; s < 4; s++) mats.push(mk(tex(lv.tex, lv.colors[s])));
      mats.push(mk(tex(lv.tex, lv.neutral)));
    } else if (lv.mode === 'hole') {
      const n = holeTileTexture();
      for (let s = 0; s < 4; s++) mats.push(mk(n));
      mats.push(mk(n));
    } else {
      const n = sandGridTexture();
      for (let s = 0; s < 5; s++) mats.push(mk(n, 0xffffff, true));
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(TP_N * TP_TILE, TP_N * TP_TILE).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xa87250 }));
      floor.position.y = 0.01;
      R.add(floor);
    }
    if (lv.mode !== 'tex') {
      const b = blobTexture();
      for (let s = 0; s < 4; s++) paintMats.push(mk(b, new THREE.Color(PAD[s]).getHex(), true));
    }
    for (let i = 0; i < TP_N * TP_N; i++) {
      const m = new THREE.Mesh(geo, mats[4]);
      const [x, z] = tileCenter(i);
      m.position.set(x, 0.03, z);
      R.add(m);
      tileMesh.push(m);
      if (lv.mode !== 'tex') {
        const p = new THREE.Mesh(geo, paintMats[0]);
        p.position.set(x, 0.06, z);
        p.rotation.y = hash(i) * Math.PI * 2;
        p.scale.setScalar(0.95 + hash(i + 99) * 0.15);
        p.visible = false;
        R.add(p);
        paintMesh.push(p);
      }
    }
    for (const [k, c] of [['mine', 0xff2a1a], ['cross', 0xffd020], ['lock', 0xb8c4ff]] as [string, number][]) ovMats[k] = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, depthWrite: false });
    const ovGeo = new THREE.PlaneGeometry(TP_TILE * 0.8, TP_TILE * 0.8).rotateX(-Math.PI / 2);
    for (let i = 0; i < TP_N * TP_N; i++) {
      const m = new THREE.Mesh(ovGeo, ovMats.mine);
      const [x, z] = tileCenter(i);
      m.position.set(x, 0.09, z);
      m.visible = false;
      R.add(m);
      ovMesh.push(m);
    }
    if (variant === 'agogo') { // the colour border around the arena (FUN_800bb840 reads the same ring)
      const sg = new THREE.PlaneGeometry(TP_TILE * 0.96, 0.7).rotateX(-Math.PI / 2);
      for (let k = 0; k < 32; k++) {
        const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x888888 }));
        const side = Math.floor(k / 8), seg = k % 8;
        const [x, z] = side === 0 ? tileWorld(-0.95, seg) : side === 1 ? tileWorld(seg, 7.95) : side === 2 ? tileWorld(7.95, 7 - seg) : tileWorld(7 - seg, -0.95);
        m.position.set(x, 0.05, z);
        if (side === 0 || side === 2) m.rotation.y = Math.PI / 2;
        R.add(m);
        stripMesh.push(m);
      }
    }
  }

  function makeParts(slot: number): ActorParts {
    const hex = PAD[slot];
    const inst = createCharacter(kit.look(slot), { variant: 'pogo', ring: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.95, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.95, depthWrite: false }));
    ring.position.y = 0.05;
    if (usedVariant(inst)) {
      // the game draws the pogo model in raw units like the stage (K per 1024 u): actor scale = K / the variant's catalog scale
      const sc = K / ((getCatalog().characters as { id: string; variants?: Record<string, { scale?: number }> }[]).find((c) => c.id === CHARACTERS[kit.look(slot).char % CHARACTERS.length].id)?.variants?.pogo?.scale ?? K);
      ring.scale.setScalar(1.8 / sc); // keep the slot ring's world size
      return { inst, extra: ring, headY: 2.1, shadow: 0.7 * 1.8 / sc, scale: sc };
    }
    const pogo = makePogo(hex);
    inst.root.position.y = 0.55;
    pogoSprings.set(slot, pogo);
    const grp = new THREE.Group();
    grp.add(pogo, ring);
    return { inst, extra: grp, headY: 2.15, shadow: 0.8 };
  }

  function heldItem(slot: number, item: number): THREE.Object3D | null {
    let h = icons.get(slot);
    if (h && h.item !== item) { if (h.obj) { kit.root.remove(h.obj); disposeTree(h.obj); } h = undefined; }
    if (!h) { const obj = item > 0 && ITEM_PART[item] >= 0 ? packPart(ITEM_PART[item]) : null; if (obj) kit.root.add(obj); h = { item, obj }; icons.set(slot, h); }
    return h.obj;
  }

  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0]) {
    const c = ctx.camera;
    const real = LEVEL_CAMS[lv.level], ref = getCatalog().arenas[lv.arena];
    if (real && ref) { applyPose(c, ps1Pose(real, ref)); return; } // the real camera
    c.position.set(...lv.pos);
    c.rotation.set(-(lv.pitch * Math.PI) / 180, 0, 0, 'YXZ');
    // the real game is 4:3; on narrower screens keep the same horizontal view
    const a = c.aspect || 4 / 3;
    let f = lv.fov;
    if (a < 4 / 3) f = (2 * Math.atan((Math.tan((lv.fov * Math.PI) / 360) * (4 / 3)) / a) * 180) / Math.PI;
    if (Math.abs(c.fov - f) > 1e-3 || c.far < 400) { c.fov = f; c.near = 0.5; c.far = 600; c.updateProjectionMatrix(); }
  }

  return {
    id: 'tilePainter',
    async preload() { await Promise.all([preloadCatalogFor('tilePainter', []), preloadFx([PACK, DIGITS, LOCO, MONSTER]), ...Object.values(LEVELS).map((l) => loadPlacements('L' + l.level).then((p) => { placements.set(l.level, p); }))]); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'pogo';
      lv = LEVELS[variant] ?? LEVELS.pogo;
      kit = new Kit(ctx, 'tilePainter', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      kit.realFx(K); beams = []; mkBeams(); lastCnt.fill(-1);
      owner.fill(-2); capd.fill(0); pop.fill(0); pogoSprings.clear(); objs.clear(); icons.clear(); stunT.clear();
      tileMesh.length = 0; paintMesh.length = 0; mats.length = 0; paintMats.length = 0; ovMesh.length = 0; stripMesh.length = 0; stripKey = -1; stN.fill(-1); arena = null;
      build();
      setCamera(ctx);
      if (!loaded) this.preload!().then(() => { if (!arena) { kit.root.clear(); kit.realFx(K); tileMesh.length = 0; paintMesh.length = 0; mats.length = 0; paintMats.length = 0; ovMesh.length = 0; stripMesh.length = 0; stripKey = -1; stN.fill(-1); build(); } if (kit) mkBeams(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      setCamera(ctx);
      const d = w.data;
      const data: number[] = d.tiles ?? [];
      const cap: number[] = d.cap ?? [];
      for (let i = 0; i < TP_N * TP_N; i++) {
        const o = data[i] ?? -1;
        const cp = cap[i] ?? 0;
        if (o !== owner[i] || cp !== capd[i]) {
          if (owner[i] !== -2 && o >= 0) pop[i] = 1;
          owner[i] = o; capd[i] = cp;
          const ob = o >= 0 && o < 4;
          if (lv.mode === 'tex') tileMesh[i].material = mats[ob ? o : 4];
          else if (paintMesh[i]) {
            paintMesh[i].visible = ob;
            if (ob) paintMesh[i].material = paintMats[o];
          }
        }
        const stv = d.st?.[i] ?? 1;
        const key = stv === 5 || stv === 7 || stv === 10 ? stv : 0;
        if (key !== stN[i]) {
          stN[i] = key;
          const ov = ovMesh[i];
          if (ov) { ov.visible = key > 0; if (key) ov.material = ovMats[key === 5 ? 'mine' : key === 7 ? 'cross' : 'lock']; }
        }
        if (key === 5 && ovMesh[i]) ovMats.mine.opacity = 0.35 + 0.3 * Math.sin(ctx.time * 12);
        pop[i] = Math.max(0, pop[i] - dt * 3);
        const k = 1 + Math.sin(pop[i] * Math.PI) * 0.12;
        tileMesh[i].scale.set(k, 1, k);
        tileMesh[i].position.y = 0.03 + Math.sin(pop[i] * Math.PI) * 0.12;
      }

      if (stripMesh.length && d.border !== stripKey) {
        stripKey = d.border;
        for (let k = 0; k < 32; k++) (stripMesh[k].material as THREE.MeshBasicMaterial).color.set(PAD[borderColor(d.border, Math.floor(k / 8), k % 8)]);
      }
      const seen = new Set<number>();
      const seenO = new Set<number>();
      gameLvl = d.lvl ?? gameLvl;
      for (const b of beams) b.begin();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const air = b.y > 0.02;
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          const taz = (d.taz?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { role: kit.over.done ? undefined : stun ? 'hit' : taz ? 'action' : air ? 'hop' : 'idle', freeze: true });
          const sp = pogoSprings.get(b.slot);
          if (sp) sp.scale.y = air ? 1 : 0.6;
          const item = d.item?.[b.slot] ?? 0;
          const held = heldItem(b.slot, kit.over.done ? 0 : item);
          if (held) { held.position.set(b.x, b.y + a.headY + 0.2, b.z); held.rotation.y += dt * 0x38 * 30 * Math.PI * 2 / 4096; }
          // hop clip event 0x14 (three frames before the landing snap): touchdown dust, script 4 at a random yaw (FUN_800b741c)
          const cnt = d.cnt?.[b.slot] ?? -1;
          if (cnt >= 14 && lastCnt[b.slot] < 14 && lastCnt[b.slot] >= 0) kit.real.play(PACK, 4, b.x, 0, b.z, { yaw: Math.random() * Math.PI * 2, add: true });
          lastCnt[b.slot] = cnt;
          if (stun) { // stun state (FUN_800b6ae0): a smoke puff (script 2) every 4 frames on the spinning player
            const t = (stunT.get(b.slot) ?? 0) - dt * 30;
            stunT.set(b.slot, t <= 0 ? t + 4 : t);
            if (t <= 0) kit.real.play(PACK, 2, b.x, b.y, b.z);
          } else stunT.delete(b.slot);
        } else if (b.kind === 'crate' || b.kind === 'power' || b.kind === 'arrow' || b.kind === 'missile' || b.kind === 'monster' || b.kind === 'padlock' || b.kind === 'beam') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            let obj: THREE.Object3D;
            let mon: ModelInstance | undefined;
            if (b.kind === 'monster') {
              mon = new ModelInstance({ model: MONSTER, scale: K, parts: ['part0'] });
              obj = mon.build() ? mon.root : new THREE.Group();
              obj.userData.shared = true; // geometry belongs to the model cache
            } else if (b.kind === 'beam') obj = new THREE.Group();
            // real objects (pack 0770): padlock 0x2041, cash crate 0x200b, arrow 0x2001 / double arrow 0x200e, item on its tile,
            // projectile 0x200d (steal gun 0x2040)
            else if (b.kind === 'padlock') obj = packPart(64);
            else if (b.kind === 'crate') obj = packPart(10);
            else if (b.kind === 'arrow') obj = packPart(b.m === 8 ? 13 : 0);
            else if (b.kind === 'power') obj = packPart(ITEM_PART[b.cd] ?? 12);
            else obj = packPart(b.cd === 3 ? 63 : 12);
            kit.root.add(obj);
            o = { obj, mon, t: 0 };
            objs.set(b.id, o);
          }
          if (b.kind === 'missile') { o.obj.position.set(b.x, b.y, b.z); o.obj.rotation.y = b.face; o.boom = true; }
          else if (b.kind === 'beam') { // FUN_800ba51c: electro sparks along the whole line ahead of the shooter
            const dx = b.cd === 0 ? 1 : b.cd === 1 ? -1 : 0, dz = b.cd === 2 ? -1 : b.cd === 3 ? 1 : 0; // world z is flipped
            const n = Math.round(b.dash);
            // object 0x1405 (FUN_800ba994): one segment per tile, frame = (game frame + segment) & 7 of parts 2-9
            for (let k = 1; k <= n; k++) beams[(w.tick + k) & 7]?.add(b.x + dx * k * TP_TILE, 128 * U, b.z + dz * k * TP_TILE, dz ? Math.PI / 2 : 0, 0, 1);
          } else if (b.kind === 'monster') { // state in vx (1 wait, 2 patrol, 3/4 walk, 5 spin): clip 0 wait, 2 hop cycle, 1 spin
            o.t = (o.t ?? 0) + dt * 30;
            const clip = b.vx === 1 ? 0 : b.vx === 5 ? 1 : 2;
            o.mon?.pose(clip, o.t % [21, 26, 14][clip]);
            o.obj.position.set(b.x, 0, b.z);
            o.obj.rotation.y = b.vx === 5 ? b.dash : b.face;
          } else if (b.kind === 'padlock') {
            const g = Math.min(1, b.vx);
            o.obj.scale.setScalar(Math.max(0.01, g));
            o.obj.position.set(b.x, Math.abs(Math.sin(ctx.time * 6)) * 0.15, b.z);
            o.obj.rotation.y = Math.sin(ctx.time * 2) * 0.3;
          } else {
            o.obj.scale.setScalar(Math.max(0.05, Math.min(1, b.dash / 16))); // crates grow in over 16 frames (+0x100 / frame)
            o.obj.position.set(b.x, 0, b.z);
            if (b.kind === 'arrow') { // FUN_800baba8: yaw eases 1/8 per frame toward dir * 0x400
              // the 0770 arrow mesh's tip is on its gltf +z, so add a half turn: the arrow then points along its fill
              // (checked on the emulator: dir 2 = yaw 0x800 points at the camera, game -z)
              const tgt = Math.PI - (b.cd & 3) * Math.PI / 2;
              o.yaw ??= tgt;
              const dy = Math.atan2(Math.sin(tgt - o.yaw), Math.cos(tgt - o.yaw));
              o.yaw += dy * (1 - Math.pow(7 / 8, dt * 30));
              o.obj.rotation.y = o.yaw;
            } else if (b.kind === 'power' && (b.cd === 1 || b.cd === 2 || b.cd === 4)) o.obj.rotation.y += dt * 0x38 * 30 * Math.PI * 2 / 4096; // FUN_800baef0: missiles spin
          }
        }
      }
      kit.prune(seen);
      for (const [id, o] of objs) if (!seenO.has(id)) {
        // a projectile ends in the pack's explosion (script 0, FUN_800bc5bc)
        if (o.boom && !kit.over.done) kit.real.play(PACK, 0, o.obj.position.x, o.obj.position.y, o.obj.position.z);
        kit.root.remove(o.obj); disposeTree(o.obj); objs.delete(id);
      }
      for (const b of beams) b.end();
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (e.k === 'jump' || e.k === 'land') return;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'sfx': playId(e.v); break;
        case 'cash':
          // FUN_800b788c -> FUN_8008d5d4: the tiles cashed float up as a number over the tile; the "!" crate breaks (script 3)
          kit.real.number(e.v, e.x, 256 * U, e.z + 256 * U, 0);
          if (gameLvl !== 11) kit.real.play(PACK, 3, e.x, 0, e.z);
          kit.shake(0.3);
          break;
        case 'pickup': case 'line': case 'cross':
          kit.real.play(PACK, 1, e.x, 0, e.z); // FUN_800b935c: every other pickup goes in script 1
          if (e.k === 'cross') kit.shake(0.2);
          break;
        case 'beam': {
          // FUN_800ba51c: script 8 at the far end of the line, 128 u up
          const dir = Math.round(e.v), n = Math.max(1, Math.round(e.o));
          const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0, dz = dir === 2 ? -1 : dir === 3 ? 1 : 0; // world z is flipped
          kit.real.play(PACK, 8, e.x + dx * n * TP_TILE, 128 * U, e.z + dz * n * TP_TILE);
          break;
        }
        case 'hit':
          kit.real.play(PACK, 0, e.x, 0, e.z); // stun entry (FUN_800b6960): the explosion at the victim
          kit.actorForSlot(e.s)?.hit(1);
          kit.shake(0.3);
          break;
        case 'wipe':
          kit.shake(0.2);
          break;
        case 'boom':
          kit.real.play(LOCO, 1, e.x, 0, e.z); // mine tile (FUN_800b8180): the level's script 1
          kit.shake(0.35);
          break;
      }
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, (s) => w.data.score?.[s] ?? 0, (getGame('tilePainter')?.maxTime ?? 90) - w.time, w.time);
    },

    hud(w, slot) {
      return pad3(w.data.score?.[slot] ?? 0);
    },

    dispose() {
      for (const o of objs.values()) kit.root.remove(o.obj);
      for (const t of icons.values()) if (t.obj) kit.root.remove(t.obj);
      objs.clear(); icons.clear(); pogoSprings.clear(); stunT.clear();
      for (const m of [...mats, ...paintMats]) m.dispose();
      for (const b of beams) b.dispose();
      beams = [];
      kit.dispose();
    },
  };
}

