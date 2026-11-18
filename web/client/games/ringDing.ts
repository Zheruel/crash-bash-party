// Ring Ding view: round teal arena, jewel target on a pedestal in the middle with a flashing zone, jewels to collect.
import * as THREE from 'three';
import { RD_CHARGE, RD_HUB, RD_MAX_JEWELS, RD_R, RD_STARTS, RD_TARGET, RD_ZONE_HALF, rdRange, type RingDingData } from '../../shared/games/ringDing';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { sfx } from '../shell/sound';
import { Kit, canvasTexture, labelSprite, preloadCatalogFor, propObject } from './kit';
import { SPECIAL_CRATE_REF, makeJewel, wedgeGeometry } from './partyBits';
import type { ClientMiniGame } from './types';

const PED_H = 0.6;
const JEWEL_COLORS = [0x4fe3ff, 0xff6ad5, 0xffe14a, 0x7dff7a, 0xff8a4a];

export function createRingDingView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const floor = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow; col: number }>();
  const shots = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow; px: number; pz: number }>();
  const carried: THREE.Object3D[][] = [[], [], [], []];
  const aims: { group: THREE.Group; ring: THREE.Mesh; line: THREE.Line; dots: THREE.Mesh[] }[] = [];
  let zoneMesh: THREE.Mesh, zoneEdge: THREE.Mesh, zoneAngle = -999, zoneFlash = 0;
  let targetGlow: THREE.Mesh, pedestal: THREE.Group;
  let tgtPulse = 0;
  const rings: THREE.Object3D[] = [];
  const posts: THREE.Mesh[] = [];

  const jewelObj = (colorIdx: number, size: number) => propObject('crystal', size * 1.5, () => makeJewel(JEWEL_COLORS[colorIdx % JEWEL_COLORS.length], size), 'height');

  function build() {
    const R = kit.root;
    // ---- main floor: engraved teal disc
    const tex = canvasTexture(512, (g, s) => {
      const c = s / 2;
      const grd = g.createRadialGradient(c, c, 0, c, c, c);
      grd.addColorStop(0, '#0e3d46'); grd.addColorStop(0.55, '#14646a'); grd.addColorStop(1, '#1b7d78');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
      const rr = (r: number) => (r / (RD_R + 0.2)) * c;
      // sector tiles
      for (let i = 0; i < 24; i++) {
        const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2;
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.10)';
        g.beginPath(); g.moveTo(c, c); g.arc(c, c, rr(RD_R + 0.2), a0, a1); g.closePath(); g.fill();
      }
      g.strokeStyle = 'rgba(255,222,120,0.75)'; g.lineWidth = 5;
      for (const r of [RD_HUB + 0.2, 6.6, 9.4, RD_R - 0.2]) { g.beginPath(); g.arc(c, c, rr(r), 0, Math.PI * 2); g.stroke(); }
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2;
      for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.beginPath(); g.moveTo(c + Math.cos(a) * rr(RD_HUB + 0.2), c + Math.sin(a) * rr(RD_HUB + 0.2)); g.lineTo(c + Math.cos(a) * rr(RD_R - 0.2), c + Math.sin(a) * rr(RD_R - 0.2)); g.stroke(); }
      // diamond studs between rings
      g.fillStyle = 'rgba(255,230,140,0.55)';
      for (let i = 0; i < 24; i++) { const a = ((i + 0.5) / 24) * Math.PI * 2; for (const r of [8.0]) { g.save(); g.translate(c + Math.cos(a) * rr(r), c + Math.sin(a) * rr(r)); g.rotate(a + Math.PI / 4); g.fillRect(-5, -5, 10, 10); g.restore(); } }
    }, undefined, false);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(RD_R + 0.2, 72).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
    R.add(disc);
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(RD_R + 0.4, RD_R + 0.7, 1.4, 72), new THREE.MeshStandardMaterial({ color: 0x0c2b33, roughness: 0.8 }));
    slab.position.y = -0.72;
    R.add(slab);

    // ---- player pads
    for (let s = 0; s < 4; s++) {
      const [nx, nz] = RD_STARTS[s];
      const col = new THREE.Color(kit.hex(s));
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.35, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4 }));
      pad.position.set(nx * (RD_R - 2.2), 0.02, nz * (RD_R - 2.2));
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.35, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
      ring.position.copy(pad.position); ring.position.y = 0.03;
      R.add(pad, ring);
    }

    // ---- rim: golden torus with glowing posts
    const rim = new THREE.Mesh(new THREE.TorusGeometry(RD_R + 0.45, 0.3, 10, 96).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe9c25a, roughness: 0.35, metalness: 0.6 }));
    rim.position.y = 0.35;
    R.add(rim);
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.0, 8), new THREE.MeshStandardMaterial({ color: 0xcfa642, roughness: 0.4, metalness: 0.6 }));
      post.position.set(Math.cos(a) * (RD_R + 0.45), 0.7, Math.sin(a) * (RD_R + 0.45));
      const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.26), new THREE.MeshBasicMaterial({ color: JEWEL_COLORS[i % 5] }));
      cap.position.set(post.position.x, 1.45, post.position.z);
      R.add(post, cap);
      posts.push(cap);
    }

    // ---- target pedestal
    pedestal = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(RD_HUB, RD_HUB + 0.25, PED_H, 48), new THREE.MeshStandardMaterial({ color: 0x8aa4ad, roughness: 0.35, metalness: 0.7 }));
    base.position.y = PED_H / 2;
    const step = new THREE.Mesh(new THREE.TorusGeometry(RD_HUB - 0.05, 0.12, 8, 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe9c25a, metalness: 0.6, roughness: 0.3 }));
    step.position.y = PED_H;
    const tgtTex = canvasTexture(256, (g, s) => {
      const c = s / 2;
      const cols = ['#ffffff', '#e5384a', '#ffffff', '#e5384a', '#ffd23f'];
      for (let i = 0; i < 5; i++) { g.fillStyle = cols[i]; g.beginPath(); g.arc(c, c, c * (1 - i * 0.2), 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = '#2a1030'; g.lineWidth = 4; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(c, c, c * (1 - i * 0.2) - 2, 0, Math.PI * 2); g.stroke(); }
    }, undefined, false);
    const target = new THREE.Mesh(new THREE.CircleGeometry(RD_TARGET, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tgtTex, roughness: 0.5, emissive: 0x331018, emissiveIntensity: 0.4 }));
    target.position.y = PED_H + 0.01;
    // flashing zone wedge
    zoneMesh = new THREE.Mesh(wedgeGeometry(0, RD_TARGET, -RD_ZONE_HALF, RD_ZONE_HALF, 20), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
    zoneMesh.position.y = PED_H + 0.04;
    zoneMesh.renderOrder = 3;
    zoneEdge = new THREE.Mesh(wedgeGeometry(RD_TARGET - 0.12, RD_TARGET + 0.1, -RD_ZONE_HALF, RD_ZONE_HALF, 20), new THREE.MeshBasicMaterial({ color: 0xfff6b0, side: THREE.DoubleSide }));
    zoneEdge.position.y = PED_H + 0.06;
    targetGlow = new THREE.Mesh(new THREE.RingGeometry(RD_TARGET, RD_TARGET + 0.7, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0, depthWrite: false }));
    targetGlow.position.y = PED_H + 0.05;
    pedestal.add(base, step, target, zoneMesh, zoneEdge, targetGlow);
    R.add(pedestal);

    // ---- surroundings: big slow floating rings out in the void
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(19 + i * 7, 0.35 + i * 0.1, 8, 64), new THREE.MeshStandardMaterial({ color: [0x1c5c60, 0x3a2a78, 0x7a5a20, 0x1c3f78][i], emissive: [0x041c1c, 0x0c0624, 0x241800, 0x040e28][i], roughness: 0.7 }));
      t.position.y = -3 - i * 1.2;
      t.rotation.x = Math.PI / 2 + (i % 2 ? 0.12 : -0.1);
      R.add(t);
      rings.push(t);
    }
    const void_ = new THREE.Mesh(new THREE.CircleGeometry(80, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07131c }));
    void_.position.y = -6;
    R.add(void_);

    // ---- aim markers
    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const group = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
      ring.renderOrder = 6;
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthTest: false }));
      line.renderOrder = 6;
      const dots: THREE.Mesh[] = [];
      for (let i = 0; i < 6; i++) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.1, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false })); d.renderOrder = 6; dots.push(d); group.add(d); }
      group.add(ring);
      group.visible = false;
      R.add(group);
      aims.push({ group, ring, line, dots });
    }
  }

  function carriedJewels(slot: number, n: number, b: Body | undefined, t: number) {
    const list = carried[slot];
    while (list.length < n) { const o = jewelObj(slot, 0.26); kit.root.add(o); list.push(o); }
    while (list.length > n) { const o = list.pop()!; kit.root.remove(o); }
    list.forEach((o, i) => {
      if (!b || !b.alive) { o.visible = false; return; }
      o.visible = true;
      const a = t * 2.2 + (i / Math.max(1, n)) * Math.PI * 2;
      o.position.set(b.x + Math.cos(a) * 0.95, b.y + 1.15 + Math.sin(t * 3 + i) * 0.1, b.z + Math.sin(a) * 0.95);
      o.rotation.y = t * 3;
    });
  }

  return {
    id: 'ringDing',
    async preload() { await preloadCatalogFor('ringDing', ['crystal'], [SPECIAL_CRATE_REF]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'ringDing', { bg: 0x07131c, fog: [45, 110], hemi: [0xcfeeff, 0x2a3a4a, 1.5], sun: [4, 18, 8] });
      build();
      ctx.frame(RD_R + 2.2);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) kit.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as RingDingData;
      const t = ctx.time;
      const seen = new Set<number>();
      const seenF = new Set<number>();
      const seenS = new Set<number>();
      const pl: (Body | undefined)[] = [];
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          pl[b.slot] = b;
          kit.actor(b).update(b, dt, { role: d.stun?.[b.slot] > 0 ? 'hit' : undefined, freeze: d.charge?.[b.slot] > 0 });
        } else if (b.kind === 'jewel') {
          seenF.add(b.id);
          let v = floor.get(b.id);
          if (!v) {
            const ci = Math.abs(b.id) % JEWEL_COLORS.length;
            v = { obj: jewelObj(ci, 0.5), shadow: kit.fx.shadow(0.4, 0.4), col: ci };
            kit.root.add(v.obj); floor.set(b.id, v);
          }
          const air = b.y > 0.02;
          v.obj.position.set(b.x, b.y + (air ? 0 : 0.18 + Math.sin(t * 3 + b.id) * 0.1), b.z);
          v.obj.rotation.y = t * 1.8 + b.id;
          v.shadow.set(b.x, b.z, b.y);
        } else if (b.kind === 'shot') {
          seenS.add(b.id);
          let v = shots.get(b.id);
          if (!v) { v = { obj: jewelObj(b.slot, 0.45), shadow: kit.fx.shadow(0.45, 0.45), px: b.x, pz: b.z }; kit.root.add(v.obj); shots.set(b.id, v); }
          const rr = Math.hypot(b.x, b.z);
          const over = PED_H * Math.min(1, Math.max(0, (RD_HUB + 0.4 - rr) / 0.8));
          v.obj.position.set(b.x, Math.max(b.y, 0.2) + over - 0.2, b.z);
          v.obj.rotation.y = t * 9; v.obj.rotation.z = t * 5;
          v.shadow.set(b.x, b.z, Math.max(0, b.y - over));
          kit.fx.trail(b.x, b.y, b.z, new THREE.Color(kit.hex(b.slot)), 0.38, 0.3);
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
          const hit = Math.hypot(lx, lz) < RD_TARGET;
          (a.ring.material as THREE.MeshBasicMaterial).color.set(hit ? 0xffe14a : kit.hex(s));
          a.ring.scale.setScalar(1 + Math.sin(t * 14) * 0.12 + (hit ? 0.25 : 0));
          a.dots.forEach((dot, i) => { const f = (i + 1) / (a.dots.length + 1); dot.position.set(b.x + sx * range * f, 0.05 + (1 - Math.pow(2 * f - 1, 2)) * 0.15, b.z + sz * range * f); });
        } else a.group.visible = false;
      }

      // flashing zone
      if (d.zone !== undefined) {
        if (Math.abs(d.zone - zoneAngle) > 1e-4) { if (zoneAngle > -900) zoneFlash = 1; zoneAngle = d.zone; }
        zoneMesh.rotation.y = -d.zone; zoneEdge.rotation.y = -d.zone;
        zoneFlash = Math.max(0, zoneFlash - dt * 1.5);
        const blink = 0.5 + 0.5 * Math.sin(t * 9);
        (zoneMesh.material as THREE.MeshBasicMaterial).opacity = 0.45 + blink * 0.4 + zoneFlash * 0.3;
        (zoneMesh.material as THREE.MeshBasicMaterial).color.setHex(blink > 0.5 ? 0xffe14a : 0xff9a2a);
      }
      tgtPulse = Math.max(0, tgtPulse - dt * 2.5);
      (targetGlow.material as THREE.MeshBasicMaterial).opacity = tgtPulse;
      targetGlow.scale.setScalar(1 + (1 - tgtPulse) * 0.4);
      posts.forEach((p, i) => { p.rotation.y = t * 2 + i; p.scale.setScalar(0.9 + 0.2 * Math.sin(t * 3 + i)); });
      rings.forEach((r, i) => { r.rotation.z += dt * (0.05 + i * 0.03) * (i % 2 ? 1 : -1); });
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'shoot': {
          const a = kit.actorForSlot(e.s);
          a?.squash.kick(-0.3);
          fx.sparks(e.x, 1.0, e.z, [0xffffff, new THREE.Color(kit.hex(e.s)).getHex()], 6, 4);
          sfx.play('whoosh', 1.1 + e.v * 0.4);
          break;
        }
        case 'score': {
          const col = new THREE.Color(kit.hex(e.s));
          const big = e.v >= 3;
          fx.burst(e.x, PED_H + 0.4, e.z, { shape: 'star', color: [0xffe14a, 0xffffff, col], count: big ? 22 : 10, speed: big ? 7 : 5, size: big ? 0.55 : 0.4, life: 0.9, up: 4, gravity: 8 });
          fx.ring(e.x, e.z, { color: big ? 0xffe14a : col, radius: big ? 4.4 : 2.6, life: 0.6, y: PED_H });
          fx.text(e.x, PED_H + 2.2, e.z, `+${e.v}`, { color: big ? '#ffe14a' : '#ffffff', size: big ? 2 : 1.4, life: 1.2 });
          kit.shake(big ? 0.35 : 0.12);
          tgtPulse = 1;
          sfx.play(big ? 'coin' : 'pop', big ? 1.3 : 1.1);
          if (big) sfx.play('crystal', 1.2);
          break;
        }
        case 'miss':
          fx.dust(e.x, e.z, 0.5, 0x9fd8d0);
          fx.sparks(e.x, 0.3, e.z, new THREE.Color(kit.hex(e.s)), 4, 2.5);
          break;
        case 'pickup':
          fx.sparks(e.x, 0.8, e.z, JEWEL_COLORS, 8, 4);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 1.2, life: 0.3 });
          sfx.play('pop', 1.6);
          break;
        case 'slam': {
          fx.stars(e.x, 1.2, e.z, 8);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2, life: 0.35 });
          kit.actorForSlot(e.s)?.hit();
          kit.actorForSlot(e.o)?.action();
          kit.shake(0.3);
          sfx.play('thud');
          break;
        }
        case 'zone':
          fx.ring(0, 0, { color: 0xffe14a, radius: RD_TARGET + 1.6, life: 0.5, y: PED_H });
          sfx.play('tick', 1.5);
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as RingDingData;
      return `${d.score?.[slot] ?? 0}  ◆${d.jewels?.[slot] ?? 0}`;
    },

    dispose(ctx) {
      for (const v of floor.values()) kit.fx.removeShadow(v.shadow);
      for (const v of shots.values()) kit.fx.removeShadow(v.shadow);
      floor.clear(); shots.clear();
      carried.forEach((c) => (c.length = 0));
      aims.length = 0; rings.length = 0; posts.length = 0;
      zoneAngle = -999;
      kit.dispose();
      void ctx; void labelSprite;
    },
  };
}
