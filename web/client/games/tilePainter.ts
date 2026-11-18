// POGO PANDEMONIUM view (shared/games/tilePainter.ts): the real stages 675 / 671 / 667 / 663 with an 8x8 painted floor.
import * as THREE from 'three';
import { TP_N, TP_TILE, tileCenter } from '../../shared/games/tilePainter';
import { createCharacter, usedVariant } from '../characters';
import { ASSET_BASE, getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import type { ActorParts } from './kit';
import { canvasTexture, catalogInstance, disposeTree, Kit, preloadCatalogFor, TextSprite } from './kit';
import type { ClientMiniGame } from './types';

/** Player colours are the pad colours of the corners (yellow BL, red TL, blue TR, green BR), not the character colours. */
const PAD = ['#d8c81c', '#d02020', '#2438d0', '#1ea81e'];
const ITEM_ICON = ['', '🚀', '➡', '👢', '✚', '⚡', '🔒'];
const ITEM_NAME = ['', 'MISSILE!', 'ARROW!', 'BOOTS!', '4-WAY MISSILE!', 'ELECTRO STUN!', 'PADLOCK!'];

/** Per level: stage key, texture folder, fixed camera fitted to the real gameplay frames (model units -> x3.6 world). */
interface Level { arena: string; tex: string; neutral: number; colors: number[]; mode: 'tex' | 'hole' | 'sand'; bg: number; pos: [number, number, number]; pitch: number; fov: number; sfx: string }
const S = 3.6;
const LEVELS: Record<string, Level> = {
  pogo: { arena: 'tilePainter:pogoPainter', tex: '0674', neutral: 0, colors: [56, 53, 54, 55], mode: 'tex', bg: 0x1c2a16, pos: [0, 2.98 * S, 6.244 * S], pitch: 24.41, fov: 36.3, sfx: '0171' },
  agogo: { arena: 'tilePainter:pogoAGogo', tex: '', neutral: 0, colors: [], mode: 'hole', bg: 0x9ac4e8, pos: [0, 3.15 * S, 5.85 * S], pitch: 27.06, fov: 37.2, sfx: '0170' },
  elpogoloco: { arena: 'tilePainter:elPogoLoco', tex: '', neutral: 0, colors: [], mode: 'sand', bg: 0xb8806a, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0169' },
  padlock: { arena: 'tilePainter:pogoPadlock', tex: '0662', neutral: 0, colors: [41, 38, 39, 40], mode: 'tex', bg: 0x4a4a52, pos: [0, 3.217 * S, 5.928 * S], pitch: 27.06, fov: 37.2, sfx: '0168' },
};

const pad3 = (n: number) => String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, '0');
const sfxFile = (bank: string, n: number) => `sfx/${bank}/${n}.mp3`;
/** The common sound block starts at a different index in each level's bank. */
const COMMON: Record<string, number> = { '0171': 2, '0170': 3, '0169': 10, '0168': 13 };

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

function makeRocket(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.7, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8e8f0, metalness: 0.3, roughness: 0.4 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff4a3a }));
  nose.position.z = 0.5;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
  flame.position.z = -0.5;
  g.add(body, nose, flame);
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

function crateTex(base: string, rim: string, mark: string, markCol: string): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = rim; g.lineWidth = 6; g.strokeRect(3, 3, s - 6, s - 6);
    g.fillStyle = markCol; g.font = '900 40px system-ui, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(mark, s / 2, s / 2 + 2);
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
  const objs = new Map<number, { obj: THREE.Object3D; icon?: TextSprite }>();
  const icons = new Map<number, TextSprite>();
  const stunT = new Map<number, number>();
  let arena: THREE.Group | null = null;
  let lastCrateMat: THREE.MeshBasicMaterial | null = null;
  let itemCrateMat: THREE.MeshBasicMaterial | null = null;
  const bankN = (n: number) => sfxFile(lv.sfx, (COMMON[lv.sfx] ?? 0) + n);

  function tex(dir: string, n: number): THREE.Texture {
    const t = loader.load(`${ASSET_BASE}textures/${dir}/tex${String(n).padStart(3, '0')}.png`);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    return t;
  }

  function build() {
    const R = kit.root;
    const ref = getCatalog().arenas[lv.arena];
    const inst = catalogInstance(ref);
    if (inst) { arena = new THREE.Group(); arena.add(inst.root); R.add(arena); }
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
    // the corner start pads, drawn on the tiles at game start by the sim (owner = slot); crate materials
    lastCrateMat = new THREE.MeshBasicMaterial({ map: crateTex('#8a34c8', '#4c1480', '!', '#ffd820') });
    itemCrateMat = new THREE.MeshBasicMaterial({ map: crateTex('#f0a0d8', '#a04888', '?', '#ffffff') });
    void lastCrateMat; void itemCrateMat;
  }

  function makeParts(slot: number): ActorParts {
    const hex = PAD[slot];
    const inst = createCharacter(kit.look(slot), { variant: 'pogo', ring: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.95, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.95, depthWrite: false }));
    ring.position.y = 0.05;
    if (usedVariant(inst)) return { inst, extra: ring, headY: 2.1, shadow: 0.7, scale: 1.8 };
    const pogo = makePogo(hex);
    inst.root.position.y = 0.55;
    pogoSprings.set(slot, pogo);
    const grp = new THREE.Group();
    grp.add(pogo, ring);
    return { inst, extra: grp, headY: 2.15, shadow: 0.8 };
  }

  function icon(slot: number): TextSprite {
    let t = icons.get(slot);
    if (!t) { t = new TextSprite('#ffffff', 0.7); kit.root.add(t.sprite); icons.set(slot, t); }
    return t;
  }

  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0]) {
    const c = ctx.camera;
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
    async preload() { await preloadCatalogFor('tilePainter', []); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'pogo';
      lv = LEVELS[variant] ?? LEVELS.pogo;
      kit = new Kit(ctx, 'tilePainter', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      owner.fill(-2); capd.fill(0); pop.fill(0); pogoSprings.clear(); objs.clear(); icons.clear(); stunT.clear();
      tileMesh.length = 0; paintMesh.length = 0; mats.length = 0; paintMats.length = 0; arena = null;
      build();
      setCamera(ctx);
      if (!loaded) this.preload!().then(() => { if (!arena) { kit.root.clear(); tileMesh.length = 0; paintMesh.length = 0; mats.length = 0; paintMats.length = 0; build(); } });
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
          if (lv.mode === 'tex') tileMesh[i].material = mats[o >= 0 ? o : 4];
          else if (paintMesh[i]) {
            paintMesh[i].visible = o >= 0;
            if (o >= 0) paintMesh[i].material = paintMats[o];
          }
        }
        pop[i] = Math.max(0, pop[i] - dt * 3);
        const k = 1 + Math.sin(pop[i] * Math.PI) * 0.12;
        tileMesh[i].scale.set(k, 1, k);
        tileMesh[i].position.y = 0.03 + Math.sin(pop[i] * Math.PI) * 0.12;
      }

      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const air = b.y > 0.02;
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { role: kit.over.done ? undefined : stun ? 'hit' : air ? 'hop' : 'idle', freeze: true });
          const sp = pogoSprings.get(b.slot);
          if (sp) sp.scale.y = air ? 1 : 0.6;
          const item = d.item?.[b.slot] ?? 0;
          const ic = icon(b.slot);
          ic.sprite.visible = item > 0 && !kit.over.done;
          if (item > 0) { ic.set(ITEM_ICON[item]); ic.sprite.position.set(b.x + 1.0, b.y + a.headY - 0.3, b.z); }
          if ((d.boots?.[b.slot] ?? 0) > 0 && air) kit.fx.trail(b.x, 0.3, b.z, 0xffe14a, 0.5, 0.3);
          if ((d.lock?.[b.slot] ?? 0) > 0) kit.fx.trail(b.x, b.y + 1, b.z, 0xc0c8ff, 0.25, 0.2);
          if (stun) {
            const t = (stunT.get(b.slot) ?? 0) + dt * 6;
            stunT.set(b.slot, t);
            for (let i = 0; i < 3; i++) {
              const an = t + (i * Math.PI * 2) / 3;
              kit.fx.burst(b.x + Math.cos(an) * 0.7, b.y + a.headY - 0.1, b.z + Math.sin(an) * 0.7, { shape: 'star', color: 0xffe14a, count: 1, speed: 0, size: 0.34, life: 0.12, gravity: 0, spread: 0, grow: 1 });
            }
          }
        } else if (b.kind === 'crate' || b.kind === 'power' || b.kind === 'missile') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            let obj: THREE.Object3D;
            let ic: TextSprite | undefined;
            if (b.kind === 'crate' || b.kind === 'power') {
              const m = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.35, 1.35), b.kind === 'crate' ? lastCrateMat! : itemCrateMat!);
              m.position.y = 0.68;
              obj = new THREE.Group(); obj.add(m);
              if (b.kind === 'power') { ic = new TextSprite('#ffffff', 0.8); ic.set(ITEM_ICON[b.cd] ?? '?'); ic.sprite.position.y = 2.1; obj.add(ic.sprite); }
            } else obj = makeRocket();
            kit.root.add(obj);
            o = { obj, icon: ic };
            objs.set(b.id, o);
          }
          if (b.kind === 'missile') { o.obj.position.set(b.x, b.y, b.z); o.obj.rotation.y = Math.atan2(b.vx, b.vz); kit.fx.trail(b.x, b.y, b.z, 0xffb030, 0.4, 0.3); }
          else { o.obj.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.06, b.z); o.obj.rotation.y = Math.sin(ctx.time * 1.5 + b.id) * 0.25; }
        }
      }
      kit.prune(seen);
      for (const [id, o] of objs) if (!seenO.has(id)) { kit.root.remove(o.obj); disposeTree(o.obj); objs.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (e.k === 'jump' || e.k === 'land') return;
      if (kit.baseEvent(e)) return;
      const hex = e.s >= 0 ? PAD[e.s] ?? '#ffffff' : '#ffffff';
      const col = new THREE.Color(hex);
      switch (e.k) {
        case 'paint':
          fx.burst(e.x, 0.15, e.z, { shape: 'soft', color: [hex, 0xffffff], count: 3 + Math.round(e.v * 6), speed: 1.6 + e.v * 2, size: 0.35, life: 0.45, up: 2.5, gravity: 12, grow: 0.3 });
          if (e.s === ctx.mySlot) sfx.playFile(bankN(13), 0.3);
          if (e.o > 0) fx.stars(e.x, 0.5, e.z, 3, [0xffffff, hex]);
          break;
        case 'cash':
          fx.confetti(e.x, 1.2, e.z, 26);
          fx.wumpa(e.x, 1, e.z, 6);
          fx.burst(e.x, 0.8, e.z, { shape: 'chip', color: [0x9a5fd0, 0xd8b0ff], count: 14, speed: 5, size: 0.3, life: 0.8, up: 4, gravity: 12 });
          fx.ring(e.x, e.z, { color: hex, radius: 4, life: 0.6 });
          fx.text(e.x, 2.6, e.z, `+${Math.round(e.v)}`, { color: '#' + col.getHexString(), size: 1.6, life: 1.4 });
          kit.shake(0.3);
          sfx.playFile(bankN(20), 0.5);
          break;
        case 'crate': case 'power':
          fx.ring(e.x, e.z, { color: e.k === 'crate' ? 0xd8b0ff : 0xffb0e8, radius: 2.4, life: 0.5 });
          fx.stars(e.x, 1.2, e.z, 6);
          break;
        case 'pickup':
          fx.stars(e.x, 1.4, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.8, e.z, ITEM_NAME[Math.round(e.v)] ?? '', { color: '#ffe14a', size: 1.0, life: 1.1 });
          sfx.playFile(bankN(17), 0.5);
          break;
        case 'missile':
          fx.smoke(e.x, 0.8, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.8, e.z, [0xffb030, 0xffffff], 8, 5);
          sfx.playFile(bankN(19), 0.45);
          break;
        case 'beam': {
          const horiz = e.o < 2, sign = e.o === 0 || e.o === 2 ? 1 : -1;
          for (let i = 1; i <= TP_N; i++) fx.sparks(e.x + (horiz ? sign * i * TP_TILE : 0), 1, e.z + (horiz ? 0 : sign * i * TP_TILE), [0x80d0ff, 0xffffff], 2, 3);
          sfx.playFile(bankN(21), 0.5);
          break;
        }
        case 'lock':
          fx.ring(e.x, e.z, { color: 0xc0c8ff, radius: 3, life: 0.6 });
          fx.text(e.x, 2.8, e.z, 'LOCKED!', { color: '#c0c8ff', size: 1.0 });
          break;
        case 'arrow': {
          const a = kit.actorForSlot(e.s);
          const p = a?.holder.position;
          const px = p?.x ?? e.x, pz = p?.z ?? e.z;
          for (let i = -TP_N; i <= TP_N; i++) {
            if (e.v === 0) fx.sparks(px + i * TP_TILE * 0.5, 0.4, pz, hex, 1, 1);
            else fx.sparks(px, 0.4, pz + i * TP_TILE * 0.5, hex, 1, 1);
          }
          fx.text(px, 2.8, pz, 'SWOOSH!', { color: '#' + col.getHexString(), size: 1.0 });
          kit.shake(0.15);
          sfx.playFile(bankN(18), 0.5);
          break;
        }
        case 'hit':
          fx.sparks(e.x, 1, e.z, [0xffe14a, 0xff8a30], 14, 6);
          fx.ring(e.x, e.z, { color: 0xff9a40, radius: 2.4, life: 0.4 });
          kit.actorForSlot(e.s)?.hit(1);
          kit.shake(0.3);
          sfx.playFile(bankN(22), 0.5);
          break;
        case 'stun':
          fx.text(e.x, 3, e.z, 'STUNNED!', { color: '#ffb040', size: 1.0, life: 1.2 });
          break;
        case 'steal':
          fx.text(e.x, 3.4, e.z, `STOLE ${Math.round(e.v)}`, { color: '#' + col.getHexString(), size: 1.0, life: 1.2 });
          break;
        case 'wipe':
          fx.smoke(e.x, 0.8, e.z, 8, 0x886688);
          fx.text(e.x, 2.8, e.z, 'LOST!', { color: '#ff6a5a', size: 1.3, life: 1.3 });
          kit.shake(0.2);
          sfx.playFile(bankN(24), 0.5);
          break;
        case 'capture':
          fx.ring(e.x, e.z, { color: hex, radius: 4, life: 0.6 });
          fx.stars(e.x, 1, e.z, 10, [0xffffff, hex]);
          fx.text(e.x, 2.4, e.z, `+${Math.round(e.v)}`, { color: '#' + col.getHexString(), size: 1.4, life: 1.3 });
          sfx.playFile(bankN(20), 0.5);
          break;
        case 'fizzle':
          fx.smoke(e.x, 0.8, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.8, e.z, 0xffb030, 6, 4);
          break;
      }
    },

    hud(w, slot) {
      return pad3(w.data.score?.[slot] ?? 0);
    },

    dispose() {
      for (const o of objs.values()) kit.root.remove(o.obj);
      for (const t of icons.values()) kit.root.remove(t.sprite);
      objs.clear(); icons.clear(); pogoSprings.clear(); stunT.clear();
      for (const m of [...mats, ...paintMats]) m.dispose();
      kit.dispose();
    },
  };
}
