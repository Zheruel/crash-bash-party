// CRATE CRUSH view (shared/games/crateToss.ts): the real Jungle / Space / Snow / Drain Bash stages, wood / TNT / Nitro crates.
import * as THREE from 'three';
import { CT_FLOOR_N, CT_HALF, CT_HP } from '../../shared/games/crateToss';
import { ASSET_BASE, getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import { sfx } from '../shell/sound';
import { createCharacter } from '../characters';
import { canvasTexture, catalogInstance, crateTexture, disposeTree, HpBar, Kit, makeCrate, preloadCatalogFor, TextSprite } from './kit';
import type { ClientMiniGame } from './types';

const H = CT_HALF;
const TILE = (H * 2) / CT_FLOOR_N;
const S = 3.6;

/** Per level: stage key, fixed camera fitted to the real gameplay frames (model units x3.6), sound bank. */
interface Level { arena: string; bg: number; pos: [number, number, number]; pitch: number; fov: number; bank: string }
const LEVELS: Record<string, Level> = {
  jungle: { arena: 'crateToss:jungleBash', bg: 0x14301c, pos: [0, 4.62 * S, 8.64 * S], pitch: 24.7, fov: 24.3, bank: '0167' },
  space: { arena: 'crateToss:spaceBash', bg: 0x2a1a4a, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0166' },
  snow: { arena: 'crateToss:snowBash', bg: 0x0a1a48, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0165' },
  drain: { arena: 'crateToss:drainBash', bg: 0x0a1020, pos: [0, 3.2 * S, 5.2 * S], pitch: 28, fov: 50, bank: '0164' },
};
/** First samples are common to every bank; these indices are guesses by length (long = blast, short = impacts). */
const SFX = { grab: 3, throw: 4, hit: 5, pickup: 7, smash: 8, bounce: 6, explode: 2 };

interface Vis { obj: THREE.Object3D; shadow: BlobShadow; glow: THREE.Mesh; kind: string; fuse?: TextSprite }

const hash = (i: number) => { let x = Math.imul(i + 1, 2654435761) >>> 0; x ^= x >>> 15; return (x >>> 0) / 4294967296; };

function woodCrate(size: number): THREE.Object3D {
  // the real "wood" crates are weathered grey-olive stone boxes
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ map: crateTexture('#8a8a6c', '#5a5a42', 'x'), roughness: 0.9 }));
  m.position.y = size / 2;
  g.add(m);
  return g;
}

function weaponCrate(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const tex = canvasTexture(64, (c, s) => {
    c.fillStyle = '#8a34c8'; c.fillRect(0, 0, s, s);
    c.strokeStyle = '#4c1480'; c.lineWidth = 6; c.strokeRect(3, 3, s - 6, s - 6);
    c.fillStyle = '#ffd820'; c.font = '900 44px system-ui, Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('?', s / 2, s / 2 + 2);
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.y = size / 2;
  g.add(m);
  return g;
}

function makePenguin(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a2a6a, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.7 });
  const beak = new THREE.MeshStandardMaterial({ color: 0xffa21a });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12).scale(0.95, 1.15, 0.85), dark);
  body.position.y = 1.15;
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.8, 14, 10).scale(0.9, 1.0, 0.6), white);
  belly.position.set(0, 1.05, 0.38);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), dark);
  head.position.set(0, 2.15, 0.05);
  const b = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 8).rotateX(Math.PI / 2), beak);
  b.position.set(0, 2.1, 0.58);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), white);
    eye.position.set(sx * 0.2, 2.25, 0.46);
    const fl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.4), dark);
    fl.position.set(sx * 1.0, 1.1, 0);
    fl.rotation.z = -sx * 0.4;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.6), beak);
    foot.position.set(sx * 0.35, 0.05, 0.25);
    g.add(eye, fl, foot);
  }
  g.add(body, belly, head, b);
  return g;
}

export function createCrateTossView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'jungle';
  let lv: Level = LEVELS.jungle;
  const crates = new Map<number, Vis>();
  const items = new Map<number, THREE.Object3D>();
  const shots = new Map<number, THREE.Object3D>();
  const bars = new Map<number, HpBar>();
  const tiles: (THREE.Mesh | null)[] = [];
  const starT = new Map<number, number>();
  let arena: THREE.Group | null = null;
  let penguin: THREE.Group | null = null;
  let zzz: TextSprite | null = null;
  let builtArena = false;

  const bankFile = (n: number) => `sfx/${lv.bank}/${n}.mp3`;

  function buildArena() {
    if (builtArena) return;
    const ref = getCatalog().arenas[lv.arena] as (ReturnType<typeof getCatalog>['arenas'][string] & { extra?: ReturnType<typeof getCatalog>['arenas'][string][] }) | undefined;
    const main = catalogInstance(ref);
    if (!main || !ref) return;
    builtArena = true;
    arena = new THREE.Group();
    arena.add(main.root);
    for (const ex of ref.extra ?? []) { const m = catalogInstance(ex); if (m) arena.add(m.root); }
    kit.root.add(arena);
  }

  function build() {
    const R = kit.root;
    buildArena();
    if (variant === 'space') {
      const mk = (n: number) => { const t = new THREE.TextureLoader().load(`${ASSET_BASE}textures/0710/tex${String(n).padStart(3, '0')}.png`); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; return new THREE.MeshBasicMaterial({ map: t }); };
      const plate = mk(0), haz = mk(1);
      const g = new THREE.PlaneGeometry(TILE * 0.995, TILE * 0.995).rotateX(-Math.PI / 2);
      for (let i = 0; i < CT_FLOOR_N * CT_FLOOR_N; i++) {
        const t = new THREE.Mesh(g, hash(i) < 0.12 ? haz : plate);
        t.position.set(-H + TILE * ((i % CT_FLOOR_N) + 0.5), 0.02, -H + TILE * (Math.floor(i / CT_FLOOR_N) + 0.5));
        R.add(t); tiles.push(t);
      }
    }
    if (variant === 'snow') {
      penguin = makePenguin();
      penguin.scale.setScalar(1.1);
      R.add(penguin);
      zzz = new TextSprite('#bfe4ff', 0.9);
      zzz.set('Zzz');
      R.add(zzz.sprite);
    }
  }

  function crateObj(kind: string): Vis {
    const obj = kind === 'tnt' ? makeCrate(1.2, 'tnt') : kind === 'nitro' ? makeCrate(1.2, 'nitro') : woodCrate(1.2);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: kind === 'nitro' ? 0x6aff3a : 0xff5a2a, transparent: true, opacity: 0.28, depthWrite: false }));
    glow.position.y = 0.6;
    glow.visible = false;
    obj.add(glow);
    kit.root.add(obj);
    return { obj, shadow: kit.fx.shadow(0.9, 0.45), glow, kind };
  }

  function itemObj(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    let col = 0xf08a1c;
    if (kind === 'weapon') {
      col = 0xb050ff;
      g.add(weaponCrate(1.3));
    } else if (kind === 'fruit') {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 12), new THREE.MeshStandardMaterial({ color: 0xf08a1c, roughness: 0.5, emissive: 0x602800, emissiveIntensity: 0.4 }));
      f.position.y = 0.7;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 6), new THREE.MeshStandardMaterial({ color: 0x3a9a2a }));
      leaf.position.y = 1.2;
      g.add(f, leaf);
    } else if (kind === 'boots') {
      col = 0xffd23f;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.9), new THREE.MeshStandardMaterial({ color: 0xe02a2a, roughness: 0.5 }));
      b.position.y = 0.8;
      const w = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 6).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      w.position.set(0, 0.8, -0.6);
      g.add(b, w);
    } else if (kind === 'mask') {
      col = 0xffd23f;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.3), new THREE.MeshStandardMaterial({ color: 0xc8782a, roughness: 0.6 }));
      m.position.y = 1.0;
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.05), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      eye.position.set(0, 1.15, 0.17);
      g.add(m, eye);
    } else if (kind === 'weight') {
      col = 0x9090a0;
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.75, 0.85, 12), new THREE.MeshStandardMaterial({ color: 0x70707c, roughness: 0.5, metalness: 0.4 }));
      w.position.y = 0.45;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.07, 6, 12), new THREE.MeshStandardMaterial({ color: 0x70707c }));
      ring.position.y = 1.0;
      g.add(w, ring);
    } else {
      col = 0xb060ff;
      const flask = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 12), new THREE.MeshStandardMaterial({ color: 0xb060ff, roughness: 0.2, emissive: 0x501080, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }));
      flask.position.y = 0.8;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0xddddff }));
      neck.position.y = 1.3;
      g.add(flask, neck);
    }
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false }));
    halo.position.y = 0.04;
    g.add(halo);
    kit.root.add(g);
    return g;
  }

  function shotObj(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'orb') {
      const o = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), new THREE.MeshBasicMaterial({ color: 0x7ad0ff }));
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 8), new THREE.MeshBasicMaterial({ color: 0x3a90ff, transparent: true, opacity: 0.35, depthWrite: false }));
      g.add(o, halo);
    } else {
      const r = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 8).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
      g.add(r);
    }
    kit.root.add(g);
    return g;
  }

  function setCamera(ctx: Parameters<ClientMiniGame['render']>[0]) {
    const c = ctx.camera;
    c.position.set(...lv.pos);
    c.rotation.set(-(lv.pitch * Math.PI) / 180, 0, 0, 'YXZ');
    const a = c.aspect || 4 / 3;
    let f = lv.fov;
    if (a < 4 / 3) f = (2 * Math.atan((Math.tan((lv.fov * Math.PI) / 360) * (4 / 3)) / a) * 180) / Math.PI;
    if (Math.abs(c.fov - f) > 1e-3 || c.far < 400) { c.fov = f; c.near = 0.5; c.far = 600; c.updateProjectionMatrix(); }
  }

  return {
    id: 'crateToss',
    async preload() { await preloadCatalogFor('crateToss', []); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'jungle';
      lv = LEVELS[variant] ?? LEVELS.jungle;
      kit = new Kit(ctx, 'crateToss', { bg: lv.bg, hemi: [0xffffff, 0xaaaaaa, 1.5] });
      crates.clear(); items.clear(); shots.clear(); bars.clear(); tiles.length = 0; starT.clear(); arena = null; penguin = null; zzz = null; builtArena = false;
      build();
      setCamera(ctx);
      if (!loaded) this.preload!().then(() => { buildArena(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      setCamera(ctx);
      const d = w.data;
      const seen = new Set<number>();
      const seenC = new Set<number>();
      const seenI = new Set<number>();
      const seenS = new Set<number>();
      if (variant === 'space' && d.floor?.length) {
        for (let i = 0; i < tiles.length; i++) { const t = tiles[i]; if (t) t.visible = d.floor[i] === 1; }
      }
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => ({ inst: createCharacter(kit.look(b.slot)), scale: 1.75, headY: 2.3, shadow: 0.8 }));
          const stun = d.stun?.[b.slot] ?? 0;
          const boots = (d.boots?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { hidden: !b.alive && !b.fall, tumble: b.fall ? true : undefined, role: kit.over.done ? undefined : stun > 0 ? 'hit' : undefined });
          if (boots && b.alive && Math.hypot(b.vx, b.vz) > 1) kit.fx.trail(b.x, 0.3, b.z, 0xffe14a, 0.4, 0.3);
          if ((d.mask?.[b.slot] ?? 0) > 0 && b.alive) kit.fx.trail(b.x, b.y + 1.2, b.z, 0xffe070, 0.35, 0.25);
          if ((d.slow?.[b.slot] ?? 0) > 0 && b.alive) kit.fx.trail(b.x, b.y + 1.2, b.z, 0xb060ff, 0.3, 0.25);
          if (b.fall) a.holder.scale.multiplyScalar(0.96);
          let bar = bars.get(b.slot);
          if (!bar) { bar = new HpBar(1.7); kit.root.add(bar.group); bars.set(b.slot, bar); }
          bar.group.visible = b.alive && !b.fall && !kit.over.done && (d.hp?.[b.slot] ?? CT_HP) < CT_HP;
          bar.group.position.set(b.x, a.headY + b.y + 0.55, b.z);
          bar.set((d.hp?.[b.slot] ?? CT_HP) / CT_HP);
          if (stun > 0 && !kit.over.done && b.alive) {
            const t = (starT.get(b.slot) ?? 0) + dt * 6;
            starT.set(b.slot, t);
            for (let i = 0; i < 3; i++) {
              const an = t + (i * Math.PI * 2) / 3;
              kit.fx.burst(b.x + Math.cos(an) * 0.7, b.y + a.headY - 0.15, b.z + Math.sin(an) * 0.7, { shape: 'star', color: 0xffe14a, count: 1, speed: 0, size: 0.34, life: 0.12, gravity: 0, spread: 0, grow: 1 });
            }
          }
        } else if (b.kind === 'crate' || b.kind === 'tnt' || b.kind === 'nitro') {
          seenC.add(b.id);
          let v = crates.get(b.id);
          if (!v) { v = crateObj(b.kind); crates.set(b.id, v); }
          const held = b.cd > 0;
          const flying = b.dash > 0 && !held;
          v.obj.position.set(b.x, b.y + (held ? 0.35 : 0), b.z);
          v.obj.rotation.y = b.face;
          v.obj.rotation.x = flying ? b.face * 0.5 : 0;
          v.glow.visible = flying || (b.kind === 'nitro' && Math.sin(ctx.time * 8 + b.id) > 0.3);
          v.shadow.set(b.x, b.z, held ? b.y + 0.5 : b.y);
          if (flying) kit.fx.trail(b.x, b.y + 0.5, b.z, b.kind === 'nitro' ? 0x6aff3a : 0xff7a3a, 0.5, 0.3);
          if (b.kind === 'nitro' && !held) v.obj.position.x += Math.sin(ctx.time * 30 + b.id) * 0.015;
          if (b.kind === 'tnt' && b.fall) { // lit: flash and count down
            const blink = Math.sin(ctx.time * (14 + (3 - b.m) * 6)) > 0;
            v.glow.visible = true;
            (v.glow.material as THREE.MeshBasicMaterial).color.set(blink ? 0xffffff : 0xff3a1a);
            v.obj.scale.setScalar(1 + (blink ? 0.08 : 0));
            if (!v.fuse) { v.fuse = new TextSprite('#ffffff', 0.9); v.obj.add(v.fuse.sprite); v.fuse.sprite.position.y = 2.3; }
            v.fuse.set(String(Math.max(1, Math.ceil(b.m))));
            kit.fx.sparks(b.x, b.y + 1.6, b.z, [0xffb030, 0xffffff], 1, 2);
          }
        } else if (b.kind === 'fruit' || b.kind === 'boots' || b.kind === 'potion' || b.kind === 'mask' || b.kind === 'weight' || b.kind === 'weapon') {
          seenI.add(b.id);
          let o = items.get(b.id);
          if (!o) { o = itemObj(b.kind); items.set(b.id, o); }
          o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.1, b.z);
          o.rotation.y += dt * 1.5;
        } else if (b.kind === 'orb' || b.kind === 'rocket') {
          seenS.add(b.id);
          let o = shots.get(b.id);
          if (!o) { o = shotObj(b.kind); shots.set(b.id, o); }
          o.position.set(b.x, b.y, b.z);
          o.rotation.y = Math.atan2(b.vx, b.vz);
          kit.fx.trail(b.x, b.y, b.z, b.kind === 'orb' ? 0x7ad0ff : 0xffb030, 0.35, 0.25);
        } else if (b.kind === 'penguin' && penguin) {
          const awake = (d.penguin ?? 0) > 0;
          penguin.position.set(b.x, 0, b.z);
          penguin.rotation.y = awake ? b.face : 0;
          penguin.rotation.x = awake ? Math.sin(ctx.time * 14) * 0.08 : -0.12;
          penguin.rotation.z = awake ? Math.sin(ctx.time * 12) * 0.15 : 0.1;
          if (zzz) { zzz.sprite.visible = !awake; zzz.sprite.position.set(b.x + 0.8, 3.4 + Math.sin(ctx.time * 2) * 0.15, b.z); }
        }
      }
      kit.prune(seen);
      for (const [id, v] of crates) if (!seenC.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); disposeTree(v.obj); crates.delete(id); }
      for (const [id, o] of items) if (!seenI.has(id)) { kit.root.remove(o); disposeTree(o); items.delete(id); }
      for (const [id, o] of shots) if (!seenS.has(id)) { kit.root.remove(o); disposeTree(o); shots.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const hexN = (s: number) => '#' + new THREE.Color(kit.hex(s)).getHexString();
      switch (e.k) {
        case 'grab':
          fx.sparks(e.x, 1, e.z, [0xffe14a, 0xffffff], 8, 3);
          fx.ring(e.x, e.z, { color: kit.hex(e.s), radius: 1.5, life: 0.3 });
          kit.actorForSlot(e.s)?.squash.kick(0.35);
          sfx.playFile(bankFile(SFX.grab), 0.45);
          break;
        case 'throw': case 'kick':
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2, life: 0.3 });
          fx.burst(e.x, 1, e.z, { shape: 'smoke', color: 0xffffff, count: 4, speed: 2, size: 0.5, life: 0.35, flat: true, grow: 2 });
          kit.actorForSlot(e.s)?.squash.kick(0.4);
          sfx.playFile(bankFile(SFX.throw), 0.45);
          break;
        case 'bounce': case 'land':
          fx.burst(e.x, 0.6, e.z, { shape: 'chip', color: [0xc98a3b, 0x7a4a1c], count: 5, speed: 3, size: 0.22, life: 0.6, up: 3, gravity: 12 });
          fx.dust(e.x, e.z, 0.4, 0xb0a890);
          if (e.k === 'bounce') sfx.playFile(bankFile(SFX.bounce), 0.3);
          break;
        case 'hit':
          fx.stars(e.x, 1.6, e.z, 10);
          fx.text(e.x, 3, e.z, `-${Math.max(1, Math.round(e.v * CT_HP))}`, { color: '#ff6a5a', size: 1.2 });
          if (e.o >= 0) {
            const t = kit.actorForSlot(e.o)?.holder.position;
            if (t) fx.text(t.x, 3.6, t.z, 'BONK!', { color: hexN(e.o), size: 1.0, life: 1.0 });
          }
          kit.actorForSlot(e.s)?.hit(1.2);
          kit.shake(0.4);
          sfx.playFile(bankFile(SFX.hit), 0.5);
          break;
        case 'smash':
          fx.burst(e.x, 0.9, e.z, { shape: 'chip', color: [0xb8b898, 0x5a5a42, 0x8a8a6c], count: 26, speed: 6, size: 0.3, life: 0.9, up: 5, gravity: 14, grow: 0.8 });
          fx.wumpa(e.x, 0.9, e.z, 4);
          fx.ring(e.x, e.z, { color: 0xffb347, radius: 3, life: 0.45 });
          kit.shake(0.35);
          sfx.playFile(bankFile(SFX.smash), 0.5);
          break;
        case 'lit':
          fx.text(e.x, 2.8, e.z, 'TNT!', { color: '#ff6a3a', size: 1.2, life: 1.0 });
          fx.sparks(e.x, 1.2, e.z, [0xffb030, 0xffffff], 8, 4);
          break;
        case 'explode': {
          const r = Math.max(2, e.v);
          fx.burst(e.x, 0.9, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 30, speed: 6, size: 1.2, life: 0.8, up: 3, grow: 1.8 });
          fx.smoke(e.x, 1, e.z, 10, 0x2a2a30);
          fx.sparks(e.x, 1, e.z, [0xffe08a, 0xffffff], 16, 9);
          fx.ring(e.x, e.z, { color: 0xffd060, radius: r * 1.3, life: 0.6 });
          kit.shake(0.7);
          sfx.playFile(bankFile(SFX.explode), 0.7);
          break;
        }
        case 'hole':
          fx.burst(e.x, 0.2, e.z, { shape: 'chip', color: [0x8a90b0, 0x4a5070], count: 14, speed: 4, size: 0.35, life: 0.8, up: 4, gravity: 14 });
          fx.smoke(e.x, 0.3, e.z, 4, 0x3a3a50);
          break;
        case 'pickup':
          fx.stars(e.x, 1.2, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.8, e.z, ['', '+HEALTH', 'SPEEDY BOOTS', 'SLOW-MO!', 'AKU AKU!', 'WEIGHT!', 'HOMING ORB x3', 'EIGHT-WAY x2', 'SONIC RING'][Math.round(e.v)] ?? '', { color: e.v === 3 || e.v === 5 ? '#c080ff' : '#ffe14a', size: 0.9, life: 1.1 });
          sfx.playFile(bankFile(SFX.pickup), 0.45);
          break;
        case 'weight':
          fx.text(e.x, 3, e.z, 'WEIGHT!', { color: '#c0c0d0', size: 1.0, life: 1.0 });
          fx.ring(e.x, e.z, { color: 0x9090a0, radius: 2.4, life: 0.4 });
          break;
        case 'weapon':
          fx.ring(e.x, e.z, { color: e.v === 3 ? 0xb0e0ff : 0xffe14a, radius: e.v === 3 ? 6 : 2.4, life: 0.5 });
          if (e.v === 3) kit.shake(0.3);
          break;
        case 'weaponHit':
          fx.burst(e.x, 1, e.z, { shape: 'soft', color: [0x7ad0ff, 0xffffff], count: 12, speed: 5, size: 0.8, life: 0.5, up: 2, grow: 1.4 });
          break;
        case 'penguinWake':
          fx.text(e.x, 4, e.z, '!', { color: '#ffe14a', size: 2, life: 1.0 });
          kit.shake(0.2);
          break;
        case 'penguinHit':
          fx.sparks(e.x, 1.2, e.z, [0xbfe4ff, 0xffffff], 10, 5);
          break;
        case 'ko':
          fx.burst(e.x, 1, e.z, { shape: 'star', color: [0xffffff, 0xffe14a], count: 14, speed: 6, size: 0.5, life: 0.9, up: 5, gravity: 10 });
          fx.text(e.x, 3, e.z, 'OUT!', { color: '#ff6a5a', size: 1.5, life: 1.4 });
          kit.shake(0.4);
          break;
      }
    },

    hud(w, slot) {
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'player' && b.slot === slot && b.alive);
      const wp = (w.data.weapon?.[slot] ?? 0) > 0 ? ` · ${['', 'ORB', 'MISSILES', 'RING'][w.data.weapon[slot]]} x${w.data.ammo[slot]}` : '';
      return alive ? `${hp}/${CT_HP} HP${wp}` : 'OUT';
    },

    dispose() {
      for (const v of crates.values()) kit.root.remove(v.obj);
      for (const o of items.values()) kit.root.remove(o);
      for (const o of shots.values()) kit.root.remove(o);
      for (const b of bars.values()) kit.root.remove(b.group);
      crates.clear(); items.clear(); shots.clear(); bars.clear(); tiles.length = 0; starT.clear();
      kit.dispose();
    },
  };
}
