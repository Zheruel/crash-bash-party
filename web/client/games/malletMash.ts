// Mallet Mash view: the real tower stage (model 0617: round grass platform inside a castle tower), real mushrooms /
// crate / boots (pack 0343) and the per-character mallet models (848-862). Fixed camera fitted against the real game
// (docs/reference/malletMash).
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { MM_R, type MalletMashData } from '../../shared/games/malletMash';
import { createCharacter } from '../characters';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { easeOutBack } from './partyBits';
import type { ClientMiniGame } from './types';

const RISE = 0.38, SHAKE = 0.85, DUCK = 0.3;
const WAVE_FULL = 0.9;
const S = 3.398;

/** Camera fitted to the real frame (image-difference search on the disc's own intro frame), in sim units (raw x 3.398). */
export const MM_CAM = { pos: [0.325, 8.477, 17.894] as [number, number, number], look: [0.339, 1.173, -0.106] as [number, number, number], fov: 43.2, aspect: 4 / 3 };

/** Hanging banners and the wooden hatch sit where the real game places them (found by overlaying on the real frame). */
const BANNERS: { prop: string; pos: [number, number, number]; yaw: number }[] = [
  { prop: 'mmBannerBlue', pos: [-1.03 * S, 0.08 * S, -4.03 * S], yaw: 0.28 },
  { prop: 'mmBannerRed', pos: [3.3 * S, 0.2 * S, -2.55 * S], yaw: -0.91 },
];
const LID = { pos: [3.8997 * S, -0.4362 * S, -1.8578 * S] as [number, number, number], yaw: 2.9437 };

const PROPS = [
  'mmMushroom', 'mmGold', 'mmCrate', 'mmBoots', 'mmShock', 'mmRingW', 'mmRingG', 'mmRingB', 'mmStar', 'mmFlash', 'mmSpark', 'mmSmoke', 'mmSmoke2',
  'mmBannerBlue', 'mmBannerRed', 'mmLid', 'mmAura_crash', 'mmAura_coco', ...CHARACTERS.map((c) => 'mmMallet_' + c.id),
];

/** Level sound bank 0178 (guessed from durations): short bonks, longer jingles. */
const BANK = (n: number) => `sfx/0178/${n}.mp3`;

interface MushV { group: THREE.Group; red: THREE.Object3D; gold: THREE.Object3D; star: THREE.Object3D | null; gld: boolean }

export function createMalletMashView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const mush: MushV[] = [];
  const crates = new Map<number, THREE.Object3D>();
  const chargeRings: THREE.Object3D[] = [];
  const auras: THREE.Object3D[] = [];
  const swingT = [0, 0, 0, 0];
  const charge = new Map<number, THREE.Object3D | null>();
  const waves: { obj: THREE.Object3D; t: number; r: number }[] = [];

  const prop = (name: string, scale = 1): THREE.Object3D | null => {
    const ref = getCatalog().props[name];
    const inst = catalogInstance(ref);
    if (!inst) return null;
    inst.root.scale.multiplyScalar(scale);
    return inst.root;
  };

  function fallbackMushroom(gold: boolean): THREE.Object3D {
    const g = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.8, 12), new THREE.MeshStandardMaterial({ color: 0xcfc4b0 }));
    stem.position.y = 0.4;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: gold ? 0xffc83a : 0xd83a3a }));
    cap.position.y = 0.8;
    g.add(stem, cap);
    return g;
  }

  function makeMushroom(): MushV {
    const group = new THREE.Group();
    const red = prop('mmMushroom') ?? fallbackMushroom(false);
    const gold = prop('mmGold') ?? fallbackMushroom(true);
    gold.visible = false;
    group.add(red, gold);
    group.visible = false;
    return { group, red, gold, star: null, gld: false };
  }

  let built: THREE.Group;
  function build() {
    built = new THREE.Group();
    kit.root.add(built);
    const R = built;
    const arena = catalogInstance(getCatalog().arenas.malletMash);
    if (arena) R.add(arena.root);
    for (const b of BANNERS) {
      const o = prop(b.prop);
      if (!o) continue;
      o.position.set(...b.pos); o.rotation.y = b.yaw;
      R.add(o);
    }
    const lid = prop('mmLid');
    if (lid) { lid.position.set(...LID.pos); lid.rotation.y = LID.yaw; R.add(lid); }
    mush.length = 0;
    for (let i = 0; i < 14; i++) { const m = makeMushroom(); R.add(m.group); mush.push(m); }
    chargeRings.length = 0; auras.length = 0;
    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      ring.visible = false; ring.renderOrder = 5;
      R.add(ring); chargeRings.push(ring);
      const boots = prop('mmBoots', 0.9) ?? new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.7), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
      boots.visible = false; R.add(boots); auras.push(boots);
    }
  }

  function mushPose(v: MushV, st: number, tm: number, gold: boolean, t: number) {
    const g = v.group;
    if (v.gld !== gold) { v.gld = gold; v.red.visible = !gold; v.gold.visible = gold; }
    g.rotation.set(0, 0, 0);
    g.scale.set(1, 1, 1);
    if (st === 0) { g.visible = false; return; }
    g.visible = true;
    let h = 1;
    if (st === 1) h = easeOutBack(Math.min(1, tm / RISE));
    else if (st === 3) {
      const k = Math.min(1, tm / SHAKE);
      const a = 0.1 + k * 0.17;
      g.rotation.z = Math.sin(t * 46) * a; g.rotation.x = Math.cos(t * 41) * a * 0.7;
    } else if (st === 4) h = 1 - Math.min(1, tm / DUCK);
    else if (st === 5) {
      const k = Math.min(1, tm / 0.5);
      g.scale.set(1.35 + k * 0.2, Math.max(0.12, 0.35 - k * 0.2), 1.35 + k * 0.2);
    }
    g.position.y = -1.4 + h * 1.4;
  }

  function placeCamera(ctx: { camera: THREE.PerspectiveCamera }) {
    const cam = ctx.camera;
    // keep the real horizontal field of view when the screen is narrower than the PS1's 4:3
    const tv = Math.tan((MM_CAM.fov * Math.PI) / 360);
    const fov = cam.aspect < MM_CAM.aspect ? (2 * Math.atan(tv * (MM_CAM.aspect / cam.aspect)) * 180) / Math.PI : MM_CAM.fov;
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.position.set(...MM_CAM.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(...MM_CAM.look);
  }

  return {
    id: 'malletMash',
    async preload() { await preloadCatalogFor('malletMash', PROPS); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'malletMash', { bg: 0x000000, hemi: [0xffffff, 0x888888, 1.6], sun: [4, 18, 8] });
      build();
      placeCamera(ctx);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); charge.clear(); kit.root.remove(built); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as MalletMashData;
      const t = ctx.time;
      const seen = new Set<number>(), seenC = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const a = kit.actor(b, () => {
            const id = CHARACTERS[kit.look(s).char % CHARACTERS.length].id;
            const inst = catalogInstance(getCatalog().props['mmMallet_' + id]);
            return inst ? { inst, scale: 1.25, headY: 2.35, shadow: 1.15 } : { inst: createCharacter(kit.look(s), { ring: false }) };
          });
          if (!charge.has(b.id)) {
            const au = prop('mmAura_' + CHARACTERS[kit.look(s).char % CHARACTERS.length].id);
            if (au) { au.visible = false; a.yaw.add(au); }
            charge.set(b.id, au);
          }
          const stunned = (d.stun?.[s] ?? 0) > 0;
          const hold = d.hold?.[s] ?? 0;
          swingT[s] = Math.max(0, swingT[s] - dt);
          a.update(b, dt, { role: stunned ? 'hit' : hold > 0.2 ? 'charge' : undefined });
          const ch = charge.get(b.id);
          if (ch) ch.visible = hold > 0.2 && !stunned;
          // charge ring
          const cr = chargeRings[s];
          if (hold > 0.25 && !stunned) {
            const f = Math.min(1, hold / WAVE_FULL);
            const R = (d.power?.[s] ?? 0) > 0 ? 5.4 : 2.9;
            cr.visible = true;
            cr.position.set(b.x, 0.08, b.z);
            cr.scale.setScalar(Math.max(0.3, R * (0.25 + f * 0.75)));
            (cr as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.set(f >= 1 ? 0xffe14a : kit.hex(s));
            (cr as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity = 0.35 + f * 0.5 + (f >= 1 ? Math.sin(t * 20) * 0.15 : 0);
            if (f >= 1 && Math.random() < 0.5) kit.fx.sparks(b.x + (Math.random() - 0.5) * 1.2, 0.5, b.z + (Math.random() - 0.5) * 1.2, 0xffe14a, 1, 2);
          } else cr.visible = false;
          // power-up marker over the head
          const au = auras[s];
          const sp = (d.boots?.[s] ?? 0) > 0, pw = (d.power?.[s] ?? 0) > 0;
          au.visible = sp || pw;
          if (au.visible) {
            au.position.set(b.x, b.y + a.headY + 0.7 + Math.sin(t * 6) * 0.1, b.z); au.rotation.y = t * 4;
            au.scale.setScalar(pw && !sp ? 0.7 : 0.9);
            if (sp && Math.hypot(b.vx, b.vz) > 2 && Math.random() < 0.6) kit.fx.trail(b.x - b.vx * 0.05, 0.3, b.z - b.vz * 0.05, 0xffe14a, 0.35, 0.3);
          }
        } else if (b.kind === 'crate') {
          seenC.add(b.id);
          let o = crates.get(b.id);
          if (!o) { o = prop('mmCrate', 1.5) ?? new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a3fd6 })); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.05 + Math.sin(t * 3 + b.id) * 0.04, b.z);
          o.rotation.y = t * 1.6;
        }
      }
      kit.prune(seen);
      for (const id of charge.keys()) if (!seen.has(id)) charge.delete(id);
      for (const [id, o] of crates) if (!seenC.has(id)) { kit.root.remove(o); crates.delete(id); }

      const holes = d.holes ?? [];
      holes.forEach((h, i) => {
        const m = mush[i];
        if (!m) return;
        m.group.position.x = h.x; m.group.position.z = h.z;
        mushPose(m, h.st, h.t, h.gold, t);
      });
      // expanding shock bands
      for (let i = waves.length - 1; i >= 0; i--) {
        const wv = waves[i];
        wv.t += dt;
        const k = wv.t / 0.55;
        if (k >= 1) { kit.root.remove(wv.obj); waves.splice(i, 1); continue; }
        wv.obj.scale.set(wv.r * (0.3 + k * 0.7) / 0.43, 1.2 * (1 - k * 0.6), wv.r * (0.3 + k * 0.7) / 0.43);
      }
      placeCamera(ctx);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'rise':
          fx.dust(e.x, e.z, 0.5, 0x8a6a42);
          fx.burst(e.x, 0.3, e.z, { shape: 'dot', color: 0x3a5a2a, count: 5, speed: 2, size: 0.18, life: 0.5, up: 2, gravity: 10 });
          if (e.v) { fx.sparks(e.x, 1.4, e.z, [0xffe14a, 0xffffff], 8, 3); sfx.play('tick', 2); }
          break;
        case 'swing':
          swingT[e.s] = 0.26;
          kit.actorForSlot(e.s)?.action();
          if (!sfx.playFile(BANK(6 + (e.s % 4)), 0.5)) sfx.play('whoosh', 0.9);
          break;
        case 'whiff':
          fx.dust(e.x, e.z, 0.6, 0x4a7a3a);
          break;
        case 'smash': {
          const gold = e.o === 1;
          const col = gold ? [0xffe14a, 0xffffff, 0xffb000] : [0xd83a3a, 0xffffff, 0xffd0a0];
          fx.burst(e.x, 0.9, e.z, { shape: 'chip', color: col, count: gold ? 24 : 14, speed: 5, size: 0.3, life: 0.8, up: 3, gravity: 9 });
          fx.stars(e.x, 1.2, e.z, gold ? 10 : 5);
          fx.ring(e.x, e.z, { color: gold ? 0xffe14a : 0xffffff, radius: gold ? 3.2 : 2, life: 0.4 });
          fx.text(e.x, 2.3, e.z, `${e.v}`, { color: gold ? '#ffe14a' : '#ff9a2a', size: e.v >= 10 ? 2.1 : e.v >= 5 ? 1.6 : 1.2, life: 1.1 });
          kit.shake(gold ? 0.35 : 0.14);
          kit.actorForSlot(e.s)?.squash.kick(0.2);
          if (!sfx.playFile(BANK(1 + (e.v % 4)), 0.8)) sfx.play(gold ? 'coin' : 'thud', gold ? 1.2 : 1.4);
          if (gold) sfx.playFile(BANK(10), 0.6);
          break;
        }
        case 'wave': {
          fx.ring(e.x, e.z, { color: 0xffffff, radius: e.v, life: 0.55 });
          fx.ring(e.x, e.z, { color: new THREE.Color(kit.hex(e.s)), radius: e.v * 0.75, life: 0.45 });
          fx.burst(e.x, 0.3, e.z, { shape: 'smoke', color: 0xd9cfb8, count: 18, speed: e.v * 1.4, size: 0.8, life: 0.7, flat: true, gravity: -0.2, grow: 2.2 });
          const band = prop('mmShock');
          if (band) { band.position.set(e.x, 0, e.z); kit.root.add(band); waves.push({ obj: band, t: 0, r: e.v }); }
          kit.shake(0.6);
          if (!sfx.playFile(BANK(18), 0.8)) sfx.play('boom', 1.1);
          swingT[e.s] = 0.26;
          break;
        }
        case 'stun':
          fx.stars(e.x, 1.4, e.z, 10);
          kit.actorForSlot(e.s)?.hit();
          sfx.play('thud', 0.8);
          break;
        case 'crate':
          fx.confetti(e.x, 1, e.z, 20);
          fx.text(e.x, 2.5, e.z, e.v === 1 ? 'SPEEDY BOOTS' : 'EXTRA POWER', { color: e.v === 1 ? '#ffe14a' : '#d9a6ff', size: 1.3, life: 1.3 });
          if (!sfx.playFile(BANK(11), 0.8)) sfx.play('lucky');
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as MalletMashData;
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}${(d.boots?.[slot] ?? 0) > 0 ? ' ›' : ''}${(d.power?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      mush.length = 0; crates.clear(); chargeRings.length = 0; auras.length = 0; waves.length = 0;
      swingT.fill(0);
      kit.dispose();
      void ctx; void MM_R;
    },
  };
}
