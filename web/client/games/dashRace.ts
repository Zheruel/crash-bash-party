import * as THREE from 'three';
import { DR_K, DR_LAPS, DR_TRACKS, trackCentre, trackRadii } from '../../shared/games/dashRace';
import { CHARACTERS } from '../../shared/look';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { catalogInstance, disposeTree, HpBar, Kit, preloadCatalogFor, TextSprite } from './kit';
import type { ActorParts } from './kit';
import { createCharacter } from '../characters';
import type { ClientMiniGame } from './types';

/**
 * Crash Dash view. The four tracks are the real stages (assets/stages/dashRace.json, model units x DR_K, origin =
 * stage origin) seen from the real fixed camera, which is common to all four (fitted against the original frames):
 * a high three-quarter view of the whole ring from the south. Karts are the per-level vehicle models (hover pods
 * on Dot / Toxic / Dante, sea creatures on Splash).
 */

/** model-unit camera (x DR_K) */
const KART_S = 0.65;
const CAM = { p: [0, 4.2, 8.5] as const, pitch: 22.3, fov: 33.5 };

interface Look { bg: number; hemi: [number, number, number] }
const LOOKS: Record<string, Look> = {
  dot: { bg: 0x101830, hemi: [0xffffff, 0xc0c8e0, 1.5] },
  toxic: { bg: 0x0a1408, hemi: [0xffffff, 0xb8c8a8, 1.5] },
  splash: { bg: 0x0a2a58, hemi: [0xffffff, 0xb0c8e8, 1.5] },
  dante: { bg: 0x1a0a08, hemi: [0xffffff, 0xd8b8a0, 1.5] },
};
const ARENA: Record<string, string> = { dot: 'dotDash', toxic: 'toxicDash', splash: 'splashDash', dante: 'dantesDash' };

/** Per-level sound bank + sample numbers (guessed from sample lengths: short one-shots first). */
const BANK: Record<string, { bank: string; missile: number; hit: number; explode: number; pickup: number; extra: number }> = {
  dot: { bank: '0172', missile: 0, hit: 1, explode: 3, pickup: 2, extra: 8 },
  toxic: { bank: '0173', missile: 0, hit: 1, explode: 3, pickup: 2, extra: 16 },
  splash: { bank: '0174', missile: 0, hit: 1, explode: 3, pickup: 2, extra: 9 },
  dante: { bank: '0175', missile: 0, hit: 1, explode: 3, pickup: 2, extra: 10 },
};

function inst(name: string): THREE.Object3D | null {
  const i = catalogInstance(getCatalog().props[name]);
  return i ? i.root : null;
}

function makeFruit(): THREE.Group {
  const g = new THREE.Group();
  const f = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), new THREE.MeshBasicMaterial({ color: 0xf2801c }));
  f.scale.y = 1.12; f.position.y = 0.55;
  const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 6), new THREE.MeshBasicMaterial({ color: 0x3a9a2a }));
  leaf.position.y = 0.98;
  g.add(f, leaf);
  return g;
}

function makeItem(): THREE.Group {
  const g = new THREE.Group();
  const m = makeMissile();
  m.scale.setScalar(1.1); m.position.y = 0.6; m.rotation.y = 0.5;
  g.add(m);
  return g;
}

function makeMissile(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.8, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8e8f0 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe84a3a }));
  nose.position.z = 0.55;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.24), new THREE.MeshBasicMaterial({ color: 0xe84a3a }));
  fin.position.z = -0.35;
  g.add(body, nose, fin);
  return g;
}

function batModel(): THREE.Object3D {
  const b = inst('dashRace.dante.bat');
  if (!b) return new THREE.Group();
  const g = new THREE.Group();
  b.scale.multiplyScalar(0.5);
  g.add(b);
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

function makeField(): THREE.Object3D {
  const real = inst('dashRace.force');
  if (real) {
    real.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) for (const q of Array.isArray(m.material) ? m.material : [m.material]) { q.transparent = true; q.depthWrite = false; }
    });
    return real;
  }
  return new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x4af0ff, transparent: true, opacity: 0.35, depthWrite: false }));
}

export function createDashRaceView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'dot';
  const objs = new Map<number, THREE.Object3D>();
  const bars = new Map<number, HpBar>();
  const itemTxt = new Map<number, TextSprite>();
  const fields = new Map<number, THREE.Object3D>();
  const spin = new Map<number, number>();
  const boostT = [0, 0, 0, 0];
  let monster: THREE.Object3D | null = null;
  let monH = 3;
  const decor: { o: THREE.Object3D; kind: string }[] = [];

  const propNames = () => {
    const ids = CHARACTERS.map((c) => c.id);
    const v = variant;
    return [
      ...ids.map((i) => (v === 'splash' ? `dashRace.sea.${i}` : `dashRace.kart.${i}`)),
      'dashRace.force',
      ...(v === 'toxic' ? ['dashRace.toxic.monster', 'dashRace.toxic.barrel', 'dashRace.toxic.slime', 'dashRace.toxic.arrow'] : []),
      ...(v === 'splash' ? ['dashRace.splash.rod', 'dashRace.splash.weed', 'dashRace.splash.arrow'] : []),
      ...(v === 'dante' ? ['dashRace.dante.bat', 'dashRace.dante.grass', 'dashRace.dante.grass2', 'dashRace.dante.arrow', 'dashRace.dante.back'] : []),
      ...(v === 'dot' ? ['dashRace.dot.tower1', 'dashRace.dot.tower2', 'dashRace.dot.tower3', 'dashRace.dot.lamp', 'dashRace.dot.arrow'] : []),
    ];
  };

  /** yaw of an arrow template pointing along +z (or -x when `west`) so it points clockwise round (cx, cz) at (x, z) */
  const tanYaw = (x: number, z: number, cx: number, cz: number, west = false) => {
    const th = Math.atan2(z - cz, x - cx), tx = -Math.sin(th), tz = Math.cos(th);
    return west ? Math.atan2(tz, -tx) : Math.atan2(tx, tz);
  };

  function build() {
    const R = kit.root;
    decor.length = 0; monster = null;
    kit.addArena(ARENA[variant], 0);
    const place = (name: string, x: number, z: number, o: { y?: number; yaw?: number; s?: number } = {}) => {
      const m = inst(name);
      if (!m) return null;
      m.position.set(x * DR_K, o.y ?? 0, z * DR_K);
      m.rotation.y = o.yaw ?? 0;
      if (o.s) m.scale.setScalar(o.s);
      R.add(m);
      return m;
    };
    if (variant === 'dot') {
      for (const [ax, az] of [[-1.44, -1.63], [1.26, 1.85]]) place('dashRace.dot.arrow', ax, az, { y: 0.3, yaw: tanYaw(ax, az, 0, 0.95) });
      place('dashRace.dot.tower1', -3.9, 0.6, { y: -4.5 });
      place('dashRace.dot.tower2', -3.8, -3.2, { y: -3.5 });
      place('dashRace.dot.tower3', 4.0, -2.6, { y: -3 });
      place('dashRace.dot.lamp', 1.7, -4.2);
    } else if (variant === 'toxic') {
      place('dashRace.toxic.arrow', 0, 0, { y: 0.3 });
      [[-3.2, -0.4, 0.3], [-2.95, 0.25, 1.4], [-3.0, 1.3, 2.2]].forEach(([x, z, yaw]) => place('dashRace.toxic.barrel', x, z, { y: 0.6, yaw, s: 0.8 }));
      place('dashRace.toxic.slime', 0, 0, { y: 0.2 });
      const m = place('dashRace.toxic.monster', 0, 0);
      if (m) { monster = m; m.visible = false; }
    } else if (variant === 'splash') {
      place('dashRace.splash.arrow', 0, 0, { y: 0.3 });
      for (let i = 0; i < 2; i++) { const m = makeRod(); m.position.set(0, 0.55, 0); R.add(m); decor.push({ o: m, kind: 'rod' + i }); }
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
    const pr = (CAM.pitch * Math.PI) / 180;
    const [x, y, z] = CAM.p;
    cam.position.set(x * DR_K, y * DR_K, z * DR_K);
    cam.lookAt(x * DR_K, (y - Math.sin(pr) * 10) * DR_K, (z - Math.cos(pr) * 10) * DR_K);
    if (Math.abs(cam.fov - CAM.fov) > 1e-3) { cam.fov = CAM.fov; cam.updateProjectionMatrix(); }
  }

  const play = (n: number, vol = 0.45) => sfx.playFile(`sfx/${BANK[variant].bank}/${n}.mp3`, vol);

  return {
    id: 'dashRace',
    async preload() { await preloadCatalogFor('dashRace', propNames()); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'dot';
      const L = LOOKS[variant] ?? LOOKS.dot;
      objs.clear(); bars.clear(); itemTxt.clear(); fields.clear(); spin.clear(); boostT.fill(0);
      kit = new Kit(ctx, 'dashRace', { bg: L.bg, hemi: L.hemi });
      build();
      aim(ctx);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); build(); } });
    },

    render(ctx, w, dt) {
      aim(ctx);
      kit.checkOver(w);
      const d = w.data;
      const [hx, hz] = trackCentre(variant);
      // toxic monster: rises out of the hub
      if (monster) {
        const up = d.mon ?? 0;
        monster.visible = up > 0.02;
        monster.position.set(hx, -monH * (1 - up), hz);
        const rod = w.bodies.find((b) => b.kind === 'rod');
        if (rod) monster.rotation.y = -rod.face;
      }
      for (const dc of decor) {
        if (dc.kind.startsWith('rod')) {
          const rods = w.bodies.filter((b) => b.kind === 'rod');
          const r = rods[Number(dc.kind.slice(3))];
          if (r) dc.o.rotation.y = -r.face;
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
          if (stun) { const t = (spin.get(b.slot) ?? 0) + dt * 12; spin.set(b.slot, t); a.holder.rotation.y = t; } else a.holder.rotation.y = 0;
          a.holder.position.y = b.y + 0.12 + Math.sin(ctx.time * 5 + b.slot) * 0.03;
          if (turbo) {
            boostT[b.slot] -= dt;
            if (boostT[b.slot] <= 0) {
              boostT[b.slot] = 0.04;
              kit.fx.burst(b.x - Math.sin(b.face) * 0.7, 0.4, b.z - Math.cos(b.face) * 0.7, { shape: 'soft', color: [0x6ad0ff, 0xffffff], count: 2, speed: 0.6, size: 0.6, life: 0.35, gravity: 0, grow: 0.2, spread: 0.1 });
            }
          }
          // fuel bar + held item
          let bar = bars.get(b.slot);
          if (!bar) { bar = new HpBar(1.3); kit.root.add(bar.group); bars.set(b.slot, bar); }
          bar.group.visible = !kit.over.done && !fin;
          bar.group.position.set(b.x, a.headY + 0.9, b.z);
          const f = d.fuel?.[b.slot] ?? 0;
          bar.set(f);
          (bar.group.children[1] as THREE.Sprite).material.color.set(turbo ? 0xffffff : f > 0.3 ? 0x4ade80 : 0xf43f5e);
          let it = itemTxt.get(b.slot);
          if (!it) { it = new TextSprite('#ffffff', 0.7); kit.root.add(it.sprite); itemTxt.set(b.slot, it); }
          const item = d.item?.[b.slot] ?? 0;
          it.sprite.visible = item > 0 && !kit.over.done;
          if (item > 0) { it.set(item === 1 ? 'MISSILE' : 'SHIELD'); it.sprite.position.set(b.x, a.headY + 1.5, b.z); }
          // force field
          const sh = (d.shield?.[b.slot] ?? 0) > 0;
          let fld = fields.get(b.slot);
          if (sh && !fld) { fld = makeField(); fld.scale.setScalar(1); kit.root.add(fld); fields.set(b.slot, fld); }
          if (fld) { fld.visible = sh; fld.position.set(b.x, 0.4, b.z); fld.rotation.y += dt * 2; }
        } else if (b.kind === 'fruit' || b.kind === 'item' || b.kind === 'missile' || b.kind === 'bat') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'fruit' ? makeFruit() : b.kind === 'item' ? makeItem() : b.kind === 'missile' ? makeMissile() : batModel();
            kit.root.add(o);
            objs.set(b.id, o);
          }
          o.visible = !((b.kind === 'fruit' || b.kind === 'item') && b.cd > 0);
          if (b.kind === 'fruit' || b.kind === 'item') { o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.1, b.z); o.rotation.y += dt * 1.8; }
          else if (b.kind === 'missile') { o.position.set(b.x, 0.7, b.z); o.rotation.y = Math.atan2(b.vx, b.vz); kit.fx.trail(b.x, 0.7, b.z, 0xffb030, 0.4, 0.3); }
          else { o.position.set(b.x, b.y + Math.sin(ctx.time * 6 + b.id) * 0.15, b.z); o.rotation.y = Math.atan2(b.vx, b.vz); }
        }
      }
      for (const [id, o] of objs) if (!seenO.has(id)) { kit.root.remove(o); disposeTree(o); objs.delete(id); }
      kit.prune(seen);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const B = BANK[variant];
      const hex = e.s >= 0 ? kit.hex(e.s) : '#ffffff';
      switch (e.k) {
        case 'turbo':
          fx.ring(e.x, e.z, { color: 0x6ad0ff, radius: 2.2, life: 0.35 });
          fx.sparks(e.x, 0.5, e.z, [0x6ad0ff, 0xffffff], 10, 6);
          if (e.s === ctx.mySlot) kit.shake(0.08);
          break;
        case 'pickup':
          fx.stars(e.x, 1.0, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.2, e.z, e.v === 1 ? 'WEAPON!' : '+FUEL', { color: e.v === 1 ? '#ffe14a' : '#ff9a30', size: 0.8, life: 0.9 });
          play(B.pickup, 0.4);
          break;
        case 'missile':
          fx.smoke(e.x, 0.7, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.7, e.z, [0xffb030, 0xffffff], 8, 5);
          play(B.missile, 0.5);
          break;
        case 'shield':
          fx.ring(e.x, e.z, { color: 0x4af0ff, radius: 2, life: 0.5 });
          play(B.pickup, 0.4);
          break;
        case 'explode':
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 22, speed: 5, size: 1.0, life: 0.7, up: 3, grow: 1.6 });
          fx.smoke(e.x, 1, e.z, 8, 0x3a3a40);
          fx.ring(e.x, e.z, { color: 0xffb040, radius: 3.2, life: 0.5 });
          kit.shake(0.3);
          play(B.explode, 0.6);
          break;
        case 'hit':
          fx.stars(e.x, 1.4, e.z, 8);
          kit.actorForSlot(e.s)?.hit(1);
          if (e.s === ctx.mySlot) kit.shake(0.25);
          play(B.hit, 0.5);
          break;
        case 'hop':
          fx.dust(e.x, e.z, 0.6);
          break;
        case 'monster':
          if (e.v > 0) play(B.extra, 0.6);
          break;
        case 'lap': {
          const left = Math.round(e.v * DR_LAPS);
          if (left <= 1 && left >= 0 && e.s === ctx.mySlot) fx.text(e.x, 2.8, e.z, left === 0 ? 'FINISH!' : 'FINAL LAP!', { color: hex, size: 1.0, life: 1.2 });
          break;
        }
        case 'finish':
          fx.confetti(e.x, 1.5, e.z, 40);
          fx.ring(e.x, e.z, { color: hex, radius: 5, life: 0.8 });
          kit.shake(0.2);
          break;
      }
    },

    hud(w, slot) {
      const d = w.data;
      const left = Math.max(0, DR_LAPS - (d.lap?.[slot] ?? 0));
      if ((d.finish?.[slot] ?? -1) >= 0) return 'FINISHED';
      const it = d.item?.[slot] ?? 0;
      return `${String(left).padStart(2, '0')} LAPS LEFT · FUEL ${Math.round((d.fuel?.[slot] ?? 0) * 100)}%${it ? (it === 1 ? ' · MISSILE' : ' · SHIELD') : ''}`;
    },

    dispose() {
      for (const o of objs.values()) kit.root.remove(o);
      for (const b of bars.values()) kit.root.remove(b.group);
      for (const t of itemTxt.values()) kit.root.remove(t.sprite);
      for (const f of fields.values()) kit.root.remove(f);
      objs.clear(); bars.clear(); itemTxt.clear(); fields.clear();
      kit.dispose();
    },
  };
}

