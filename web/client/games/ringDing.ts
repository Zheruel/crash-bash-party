// Ring Ding view: the real meadow pit (model 0621): stone-walled bowl with x1/x2/x3/x5 floor bands, a bull's-eye target
// circling outside the wall, archery-range props, tent and castle backdrop; riders are the per-character dino models.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { RD_CHARGE, RD_MAX_JEWELS, RD_STARTS, RD_TARGET_PERIOD, rdBand, rdRange, rdSolve, rdTargetAngle, rdTargetPos, type RingDingData } from '../../shared/games/ringDing';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { Actor, Kit, catalogInstance, preloadCatalogFor } from './kit';
import { makeJewel } from './partyBits';
import type { ClientMiniGame } from './types';

const SKY = new THREE.Color(0x8fd4ff);
const JEWEL_COLORS = [0x4fe35a, 0xb060ff, 0xffe14a, 0x4fb8ff];
const PIECES = ['rdStand', 'rdFace', 'rdArrow', 'rdSpireB'];
/** Coplanar floor layers, drawn bottom to top (the game relies on draw order; we use polygon offset). */
const LAYERS = ['extra_132c', 'extra_4c04', 'extra_4948', 'extra_4ac8', 'extra_4d90', 'extra_4f50', 'extra_5148'];
/** Archery-range targets ringed outside the wall (x, z): they face the pit. */
const RANGE: [number, number][] = [[-16, -11], [-17.5, -2], [-15.5, 6], [-9, 15.5], [15, 11]];
const RIDERS = CHARACTERS.map((c) => 'rdRider_' + c.id);

/** Camera: fixed high view from the south rim, looking across the pit (fitted against the real game, see docs/reference/ringDing). */
export const RD_CAM = { pos: [0, 9, 21] as [number, number, number], look: [-1.5, 2.8, 0] as [number, number, number], fov: 48 };

/** Level sound bank 0180 (guessed from duration): short blips for pickup/shoot/score. */
const BANK = (n: number) => `sfx/0180/${n}.mp3`;

export function createRingDingView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let target: THREE.Group;
  const floor = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow }>();
  const shots = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow }>();
  const carried: THREE.Object3D[][] = [[], [], [], []];
  const aims: { group: THREE.Group; ring: THREE.Mesh; dots: THREE.Mesh[] }[] = [];
  let tgtPulse = 0;
  let camPos = new THREE.Vector3(...RD_CAM.pos);

  const jewelObj = (ci: number, size: number) => makeJewel(JEWEL_COLORS[ci % JEWEL_COLORS.length], size);

  function piece(name: string): THREE.Object3D | null {
    const inst = catalogInstance(getCatalog().props[name]);
    return inst ? inst.root : null;
  }

  function build() {
    const R = kit.root;
    const arena = catalogInstance(getCatalog().arenas.ringDing);
    if (arena) {
      R.add(arena.root);
      arena.root.traverse((o) => {
        const m = o as THREE.Mesh;
        const k = LAYERS.indexOf(m.name.replace(/_\d+$/, '')) >= 0 ? LAYERS.indexOf(m.name.replace(/_\d+$/, '')) : LAYERS.indexOf(m.parent?.name ?? '');
        if (!m.isMesh || k < 0) return;
        const mat = m.material as THREE.Material;
        mat.polygonOffset = true; mat.polygonOffsetFactor = -k * 2; mat.polygonOffsetUnits = -k * 2;
      });
    }
    // archery stands: stand + face + arrow
    for (const [x, z] of RANGE) {
      const g = new THREE.Group();
      for (const n of ['rdStand', 'rdFace', 'rdArrow']) { const o = piece(n); if (o) g.add(o); }
      g.position.set(x, 2.3 * 1.0 - 0.4, z);
      g.rotation.y = Math.atan2(-x, -z);
      R.add(g);
    }
    const tw = piece('rdSpireB');
    if (tw) { tw.scale.setScalar(2.1); tw.position.set(-1, -9, -55); R.add(tw); }
    target = new THREE.Group();
    const t = piece('rdTarget');
    if (t) target.add(t);
    R.add(target);

    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
      ring.renderOrder = 6;
      const dots: THREE.Mesh[] = [];
      for (let i = 0; i < 6; i++) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.1, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false })); d.renderOrder = 6; dots.push(d); group.add(d); }
      group.add(ring);
      group.visible = false;
      R.add(group);
      aims.push({ group, ring, dots });
    }
  }

  function carriedJewels(slot: number, n: number, b: Body | undefined, t: number) {
    const list = carried[slot];
    while (list.length < n) { const o = jewelObj(slot, 0.3); kit.root.add(o); list.push(o); }
    while (list.length > n) { const o = list.pop()!; kit.root.remove(o); }
    list.forEach((o, i) => {
      if (!b || !b.alive) { o.visible = false; return; }
      o.visible = true;
      o.position.set(b.x, b.y + 2.3 + i * 0.75 + Math.sin(t * 3 + i) * 0.08, b.z);
      o.rotation.y = t * 3;
    });
  }

  function rider(b: Body): Actor {
    const have = kit.actors.get(b.id);
    if (have) return have;
    const look = kit.look(b.slot);
    const inst = catalogInstance(getCatalog().props['rdRider_' + CHARACTERS[look.char % CHARACTERS.length].id]);
    return inst ? kit.actor(b, () => ({ inst, scale: 1, steady: true, headY: 2.4, shadow: 1.3 })) : kit.actor(b);
  }

  return {
    id: 'ringDing',
    async preload() { await preloadCatalogFor('ringDing', [...PIECES, 'rdTarget', ...RIDERS]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'ringDing', { bg: 0x6a9ad8, hemi: [0xffffff, 0xb0b0b0, 1.6], sun: [4, 18, 8] });
      build();
      ctx.camera.fov = RD_CAM.fov; ctx.camera.updateProjectionMatrix();
      ctx.camera.position.set(...RD_CAM.pos); ctx.camera.lookAt(...RD_CAM.look);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as RingDingData;
      const t = ctx.time;
      const seen = new Set<number>(), seenF = new Set<number>(), seenS = new Set<number>();
      const pl: (Body | undefined)[] = [];
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          pl[b.slot] = b;
          rider(b).update(b, dt, { role: d.stun?.[b.slot] > 0 ? 'hit' : undefined, freeze: d.charge?.[b.slot] > 0 });
        } else if (b.kind === 'jewel') {
          seenF.add(b.id);
          let v = floor.get(b.id);
          if (!v) { v = { obj: jewelObj(b.m, 0.45), shadow: kit.fx.shadow(0.4, 0.4) }; kit.root.add(v.obj); floor.set(b.id, v); }
          const air = b.y > 0.02;
          v.obj.position.set(b.x, b.y + (air ? 0 : 0.15 + Math.sin(t * 3 + b.id) * 0.08), b.z);
          v.obj.rotation.y = t * 1.8 + b.id;
          v.shadow.set(b.x, b.z, b.y);
        } else if (b.kind === 'shot') {
          seenS.add(b.id);
          let v = shots.get(b.id);
          if (!v) { v = { obj: jewelObj(b.m, 0.5), shadow: kit.fx.shadow(0.45, 0.45) }; kit.root.add(v.obj); shots.set(b.id, v); }
          v.obj.position.set(b.x, Math.max(b.y, 0.2), b.z);
          v.obj.rotation.y = t * 9; v.obj.rotation.z = t * 5;
          v.shadow.set(b.x, b.z, Math.max(0, b.y));
          kit.fx.trail(b.x, b.y, b.z, new THREE.Color(JEWEL_COLORS[b.m % 4]), 0.38, 0.3);
        }
      }
      kit.prune(seen);
      for (const [id, v] of floor) if (!seenF.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); floor.delete(id); }
      for (const [id, v] of shots) if (!seenS.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); shots.delete(id); }

      for (let s = 0; s < 4; s++) {
        const b = pl[s];
        carriedJewels(s, Math.min(RD_MAX_JEWELS, d.jewels?.[s] ?? 0), b, t);
        const a = aims[s];
        const ch = d.charge?.[s] ?? 0;
        if (b && ch > 0) {
          const range = rdRange(ch / RD_CHARGE);
          const sx = Math.sin(b.face), sz = Math.cos(b.face);
          const lx = b.x + sx * range, lz = b.z + sz * range;
          a.group.visible = true;
          a.ring.position.set(lx, 0.05, lz);
          a.ring.scale.setScalar(1 + Math.sin(t * 14) * 0.12);
          a.dots.forEach((dot, i) => { const f = (i + 1) / (a.dots.length + 1); dot.position.set(b.x + sx * range * f, 0.05, b.z + sz * range * f); });
        } else a.group.visible = false;
      }

      // target circling outside the wall, face toward the pit
      const [tx, tz] = rdTargetPos(w.time);
      target.position.set(tx, 2.6, tz);
      target.rotation.y = Math.atan2(-tx, -tz);
      tgtPulse = Math.max(0, tgtPulse - dt * 2.5);
      target.scale.setScalar(1 + tgtPulse * 0.12);

      // camera
      ctx.scene.background = SKY;
      const dv = RD_CAM;
      ctx.camera.position.copy(camPos.set(...dv.pos));
      ctx.camera.lookAt(...dv.look);
      if (ctx.camera.fov !== dv.fov) { ctx.camera.fov = dv.fov; ctx.camera.updateProjectionMatrix(); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'shoot':
          kit.actorForSlot(e.s)?.squash.kick(-0.3);
          fx.sparks(e.x, 1.0, e.z, [0xffffff, new THREE.Color(kit.hex(e.s)).getHex()], 6, 4);
          sfx.play('whoosh', 1.1 + e.v * 0.4);
          sfx.playFile(BANK(9 + (Math.floor(e.v * 7) % 8)), 0.35);
          break;
        case 'score': {
          const col = new THREE.Color(kit.hex(e.s));
          const big = e.v >= 3;
          fx.burst(e.x, 2.5, e.z, { shape: 'star', color: [0xffe14a, 0xffffff, col], count: big ? 22 : 10, speed: big ? 7 : 5, size: big ? 0.55 : 0.4, life: 0.9, up: 4, gravity: 8 });
          fx.text(e.x, 5, e.z, `+${e.v}`, { color: big ? '#ffe14a' : '#ffffff', size: big ? 2 : 1.4, life: 1.2 });
          kit.shake(big ? 0.25 : 0.1);
          tgtPulse = 1;
          sfx.play(big ? 'coin' : 'pop', big ? 1.3 : 1.1);
          sfx.playFile(BANK(big ? 22 : 21), 0.45);
          break;
        }
        case 'miss':
          fx.dust(e.x, e.z, 0.5, 0xd8c8a0);
          break;
        case 'pickup':
          fx.sparks(e.x, 0.8, e.z, JEWEL_COLORS, 8, 4);
          sfx.play('pop', 1.6);
          sfx.playFile(BANK(13 + (e.v % 3)), 0.3);
          break;
        case 'slam':
          fx.stars(e.x, 1.2, e.z, 8);
          kit.actorForSlot(e.s)?.hit();
          kit.actorForSlot(e.o)?.action();
          kit.shake(0.3);
          sfx.play('thud');
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as RingDingData;
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}  ◆${d.jewels?.[slot] ?? 0}`;
    },

    dispose(ctx) {
      for (const v of floor.values()) kit.fx.removeShadow(v.shadow);
      for (const v of shots.values()) kit.fx.removeShadow(v.shadow);
      floor.clear(); shots.clear();
      carried.forEach((c) => (c.length = 0));
      aims.length = 0;
      kit.dispose();
      void ctx; void RD_STARTS; void rdBand; void rdSolve; void rdTargetAngle; void RD_TARGET_PERIOD;
    },
  };
}
