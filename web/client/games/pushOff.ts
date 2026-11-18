// POLAR PUSH view (shared/games/pushOff.ts): bears on a tilting / melting ice platform.
import * as THREE from 'three';
import { PO_RADIUS } from '../../shared/games/pushOff';
import { createCharacter, usedVariant } from '../characters';
import type { ActorParts } from './kit';
import { canvasTexture, disposeTree, Kit, preloadCatalogFor, propObject } from './kit';
import type { ClientMiniGame } from './types';

const WATER_Y = -3;
const TILT_K = 0.14; // slope per unit of sim tilt (must match the cosmetic platform rotation)

function iceTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, '#eaf8ff'); grad.addColorStop(0.7, '#cdeeff'); grad.addColorStop(1, '#a9dcf5');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 3;
    for (const r of [0.22, 0.45, 0.68, 0.9]) { g.beginPath(); g.arc(s / 2, s / 2, (s / 2) * r, 0, Math.PI * 2); g.stroke(); }
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.strokeStyle = 'rgba(120,180,220,0.7)'; g.lineWidth = 1.5;
    for (let i = 0; i < 16; i++) {
      let x = rnd() * s, y = rnd() * s;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * 50; y += (rnd() - 0.5) * 50; g.lineTo(x, y); }
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 40; i++) g.fillRect(rnd() * s, rnd() * s, 2, 2);
  }, undefined, false);
}

/** Stand-in polar bear (white body, head, ears) with the character riding on top. */
function makeBear(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1220 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14).scale(0.7, 0.55, 1.0), white);
  body.position.y = 0.6;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), white);
  head.position.set(0, 0.75, 0.95);
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8).scale(1, 0.8, 1.2), white);
  snout.position.set(0, 0.68, 1.3);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), dark);
  nose.position.set(0, 0.74, 1.5);
  g.add(body, head, snout, nose);
  for (const x of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), white);
    ear.position.set(x * 0.28, 1.1, 0.85);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), dark);
    eye.position.set(x * 0.16, 0.9, 1.28);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.4, 10), white);
    leg.position.set(x * 0.45, 0.2, 0.55);
    const leg2 = leg.clone(); leg2.position.z = -0.55;
    g.add(ear, eye, leg, leg2);
  }
  return g;
}

interface Bar { bg: THREE.Sprite; fg: THREE.Sprite }

export function createPushOffView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let platform: THREE.Group;
  let slab: THREE.Mesh;
  let edgeRing: THREE.Mesh;
  let water: THREE.Mesh;
  let beamObj: THREE.Group;
  const bolts = new Map<number, THREE.Mesh>();
  const bars = new Map<number, Bar>();
  const weights = new Map<number, THREE.Object3D>();
  const floes: THREE.Mesh[] = [];
  const splashed = new Set<number>();
  const hangText = new Map<number, number>();
  let chipT = 0, rippleT = 0, snowT = 0;
  let variant = 'tilt';
  let tilt: [number, number] = [0, 0];
  const up = new THREE.Vector3(0, 1, 0);

  function build() {
    const R = kit.root;
    const arena = kit.addArena(variant, -3.6);
    water = new THREE.Mesh(new THREE.PlaneGeometry(140, 140).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b5a8c, roughness: 0.25, metalness: 0.15, transparent: !!arena, opacity: arena ? 0.82 : 1 }));
    water.position.y = WATER_Y;
    R.add(water);

    platform = new THREE.Group();
    const iceTop = new THREE.MeshStandardMaterial({ map: iceTexture(), roughness: 0.18, metalness: 0.05 });
    const iceSide = new THREE.MeshStandardMaterial({ color: 0x7fc4ec, roughness: 0.4 });
    slab = new THREE.Mesh(new THREE.CylinderGeometry(PO_RADIUS, PO_RADIUS * 0.82, 1.6, 64), [iceSide, iceTop, iceSide]);
    slab.position.y = -0.8;
    platform.add(slab);
    const skirt = new THREE.Mesh(new THREE.TorusGeometry(PO_RADIUS, 0.16, 8, 80).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
    skirt.position.y = -0.02;
    skirt.name = 'skirt';
    platform.add(skirt);
    edgeRing = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 80).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0, depthWrite: false }));
    edgeRing.position.y = 0.04;
    platform.add(edgeRing);
    R.add(platform);

    if (!arena) {
      let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const floeMat = new THREE.MeshStandardMaterial({ color: 0xd8f1ff, roughness: 0.35 });
      for (let i = 0; i < 16; i++) {
        const a = rnd() * Math.PI * 2, d = 13 + rnd() * 20, r = 0.9 + rnd() * 1.8;
        const f = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 0.4, 7 + Math.floor(rnd() * 3)), floeMat);
        f.position.set(Math.cos(a) * d, WATER_Y + 0.05, Math.sin(a) * d);
        f.userData.ph = rnd() * 6;
        R.add(f);
        floes.push(f);
      }
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.4, d = 34 + rnd() * 6, h = 6 + rnd() * 6;
        const berg = new THREE.Mesh(new THREE.ConeGeometry(3 + rnd() * 2, h, 5), new THREE.MeshStandardMaterial({ color: 0xe6f6ff, roughness: 0.5, flatShading: true }));
        berg.position.set(Math.cos(a) * d, WATER_Y + h / 2 - 0.5, Math.sin(a) * d);
        R.add(berg);
      }
    }
    // power-up beam column (polar panic)
    beamObj = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 9, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    col.position.y = 4.5;
    const base = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    base.position.y = 0.05;
    beamObj.add(col, base);
    beamObj.visible = false;
    R.add(beamObj);
  }

  function bearParts(slot: number): ActorParts {
    const inst = createCharacter(kit.look(slot), { variant: 'polarBear', ring: false });
    if (usedVariant(inst)) {
      const r = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.42, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(slot)), transparent: true, opacity: 0.9, depthWrite: false }));
      r.position.y = 0.03;
      return { inst, extra: r, shadow: 1.1, scale: 1.0, headY: 2.4 };
    }
    // stand-in: bear body + character riding on its back
    inst.root.position.set(0, 0.95, -0.05);
    inst.root.scale.setScalar(0.6);
    const hex = kit.hex(slot);
    const bear = makeBear();
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.18, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
    ring.position.y = 0.03;
    bear.add(ring);
    return { inst, extra: bear, shadow: 1.1, scale: 1.0, headY: 2.0 };
  }

  function bar(slot: number): Bar {
    let b = bars.get(slot);
    if (!b) {
      const mk = (c: number) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: c, depthTest: false, transparent: true })); s.renderOrder = 44; kit.root.add(s); return s; };
      b = { bg: mk(0x14101c), fg: mk(0x5ad0ff) };
      b.fg.renderOrder = 45;
      bars.set(slot, b);
    }
    return b;
  }

  return {
    id: 'pushOff',
    async preload() { await preloadCatalogFor('pushOff', ['polarBear', 'weight']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'tilt';
      const bg = variant === 'manic' ? 0x1a1230 : 0x16324f;
      kit = new Kit(ctx, 'pushOff', { bg, fog: [60, 140], hemi: [0xe4f3ff, 0x3a5a7a, 1.6] });
      splashed.clear(); floes.length = 0; bolts.clear(); bars.clear(); weights.clear(); hangText.clear();
      chipT = rippleT = snowT = 0; tilt = [0, 0];
      build();
      ctx.frame(PO_RADIUS + 3.4);
      if (!loaded) this.preload!().then(() => kit?.reset());
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data;
      const R: number = d.radius ?? PO_RADIUS;
      const k = R / PO_RADIUS;
      tilt = d.tilt ?? [0, 0];
      // platform scale + slope
      platform.scale.set(k, 1, k);
      const n = new THREE.Vector3(TILT_K * tilt[0], 1, TILT_K * tilt[1]).normalize();
      platform.quaternion.setFromUnitVectors(up, n);
      const shrinking = R < PO_RADIUS - 0.3 && R > 3.25;
      const em = edgeRing.material as THREE.MeshBasicMaterial;
      edgeRing.scale.set(1, 1, 1);
      em.opacity = shrinking && !kit.over.done ? 0.5 + Math.sin(ctx.time * 8) * 0.3 : 0;
      for (const f of floes) f.position.y = WATER_Y + 0.05 + Math.sin(ctx.time * 0.8 + f.userData.ph) * 0.06;
      const surf = (x: number, z: number) => -TILT_K * (tilt[0] * x + tilt[1] * z);

      snowT -= dt;
      if (snowT <= 0) {
        snowT = 0.05;
        kit.fx.burst((Math.random() - 0.5) * 30, 9, (Math.random() - 0.5) * 22, { shape: 'soft', color: 0xffffff, count: 1, speed: 0.2, size: 0.18, life: 3.5, gravity: 0.8, up: -0.5, grow: 1, spread: 0 });
      }
      rippleT -= dt;
      if (rippleT <= 0) {
        rippleT = 0.5;
        const a = Math.random() * 6.28, dd = R + 1 + Math.random() * 6;
        kit.fx.ring(Math.cos(a) * dd, Math.sin(a) * dd, { color: 0x9fd2f5, radius: 1.8, life: 1.6, y: WATER_Y });
      }
      if (shrinking && !kit.over.done) {
        chipT -= dt;
        if (chipT <= 0) {
          chipT = 0.09;
          const a = Math.random() * 6.28;
          kit.fx.burst(Math.cos(a) * R, surf(Math.cos(a) * R, Math.sin(a) * R), Math.sin(a) * R, { shape: 'chip', color: 0xdff4ff, count: 2, speed: 1, size: 0.3, life: 0.9, gravity: 10, up: 0.5, vx: Math.cos(a) * 1.5, vz: Math.sin(a) * 1.5 });
        }
      }

      const seen = new Set<number>();
      const seenBolts = new Set<number>();
      let beam = false;
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => bearParts(b.slot));
          const hanging = (d.hang?.[b.slot] ?? 0) > 0 && !b.fall;
          const under = b.y < WATER_Y + 0.4;
          if (b.fall && under && !splashed.has(b.id)) {
            splashed.add(b.id);
            kit.fx.splash(b.x, WATER_Y, b.z, 1.2);
            kit.shake(0.25);
          }
          const sf = b.fall || hanging ? 0 : surf(b.x, b.z);
          const charging = b.dash > 0;
          a.update(b, dt, {
            hidden: !b.alive || b.y < WATER_Y - 0.3,
            hop: hanging ? -0.7 + Math.sin(ctx.time * 30) * 0.05 : sf,
            tumble: b.fall,
            role: b.fall ? 'jump' : hanging ? 'hit' : kit.over.done ? undefined : charging ? 'push' : 'idle',
            freeze: false,
          });
          if (b.fall || hanging) a.shadow.visible = false;
          // charge meter
          if (!b.fall && b.alive && !kit.over.done) {
            const m = Math.max(0, Math.min(1, d.meter?.[b.slot] ?? 0));
            const br = bar(b.slot);
            const y = b.y + a.headY + 0.1 + sf;
            br.bg.position.set(b.x, y, b.z); br.bg.scale.set(1.1, 0.2, 1);
            br.fg.scale.set(Math.max(0.001, 1.0 * m), 0.12, 1);
            br.fg.position.set(b.x - 0.5 * (1 - m), y, b.z);
            const zap = (d.zap?.[b.slot] ?? 0) > 0;
            (br.fg.material as THREE.SpriteMaterial).color.set(zap ? 0xffe14a : m >= 0.4 ? 0x5ad0ff : 0xff6a5a);
            br.bg.visible = br.fg.visible = true;
            if (zap && Math.random() < dt * 20) kit.fx.sparks(b.x, b.y + 1, b.z, [0xffe14a, 0xffffff], 2, 3);
          } else { const br = bars.get(b.slot); if (br) br.bg.visible = br.fg.visible = false; }
          // weight curse
          const wt = (d.weight?.[b.slot] ?? 0) > 0 && !b.fall && b.alive;
          let wo = weights.get(b.slot);
          if (wt && !wo) {
            wo = propObject('weight', 0.9, () => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 0.7, 12), new THREE.MeshStandardMaterial({ color: 0x3a3a4a, metalness: 0.5, roughness: 0.4 })); m.position.y = 0.35; g.add(m); return g; }, 'height');
            kit.root.add(wo);
            weights.set(b.slot, wo);
          }
          if (wo) { wo.visible = wt; wo.position.set(b.x, b.y + a.headY + 0.45 + sf, b.z); }
          if (hanging && b.slot === ctx.mySlot) {
            const t = (hangText.get(b.slot) ?? 0) - dt;
            if (t <= 0) { hangText.set(b.slot, 0.6); kit.fx.text(b.x, 2.4, b.z, 'MASH A!', { color: '#ff6a5a', size: 1.1, life: 0.7 }); } else hangText.set(b.slot, t);
          }
        } else if (b.kind === 'beam') {
          beam = true;
          beamObj.position.set(b.x, surf(b.x, b.z), b.z);
          beamObj.rotation.y += dt * 2;
          beamObj.scale.set(1 + Math.sin(ctx.time * 8) * 0.05, 1, 1 + Math.sin(ctx.time * 8) * 0.05);
        } else if (b.kind === 'bolt') {
          seenBolts.add(b.id);
          let m = bolts.get(b.id);
          if (!m) {
            m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3a5a, transparent: true, opacity: 0.8, depthWrite: false }));
            m.add(new THREE.Mesh(new THREE.CircleGeometry(0.85, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3a5a, transparent: true, opacity: 0.25, depthWrite: false })));
            kit.root.add(m);
            bolts.set(b.id, m);
          }
          m.position.set(b.x, surf(b.x, b.z) + 0.06, b.z);
          m.scale.setScalar(b.r * (0.8 + 0.2 * Math.sin(ctx.time * 20)));
        }
      }
      beamObj.visible = beam;
      kit.prune(seen);
      for (const [id, m] of bolts) if (!seenBolts.has(id)) { kit.root.remove(m); disposeTree(m); bolts.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'hit': {
          fx.sparks(e.x, 0.8, e.z, [0xffffff, 0xbfe9ff], 14, 6);
          fx.stars(e.x, 1.4, e.z, 5);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2.8, life: 0.45 });
          fx.text(e.x, 2.5, e.z, 'BONK!', { color: '#ffe14a', size: 1.2 });
          kit.actorForSlot(e.s)?.hit(e.v);
          kit.actorForSlot(e.o)?.squash.kick(0.35);
          kit.shake(0.3 + e.v * 0.25);
          break;
        }
        case 'ko':
          fx.burst(e.x, 0.6, e.z, { shape: 'soft', color: [0xffffff, 0xbfe9ff], count: 14, speed: 4, size: 0.5, life: 0.7, up: 4 });
          fx.text(e.x, 2.4, e.z, 'AAAH!', { color: '#ff6a5a', size: 1.3, life: 1.3 });
          kit.shake(0.35);
          break;
        case 'hang':
          fx.text(e.x, 2.2, e.z, 'HELP!', { color: '#ffb040', size: 1.1, life: 1 });
          fx.sparks(e.x, 0.4, e.z, 0xffffff, 6, 3);
          break;
        case 'climb':
          fx.stars(e.x, 0.8, e.z, 6);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2, life: 0.4 });
          break;
        case 'pickup': {
          const zap = e.v === 1;
          fx.stars(e.x, 1.2, e.z, 12, zap ? [0xffe14a, 0xffffff] : [0xb070ff, 0xffffff]);
          fx.text(e.x, 2.6, e.z, zap ? 'LIGHTNING!' : 'WEIGHT!', { color: zap ? '#ffe14a' : '#c090ff', size: 1.1, life: 1.2 });
          fx.ring(e.x, e.z, { color: zap ? 0xffe14a : 0xb070ff, radius: 3, life: 0.5 });
          break;
        }
        case 'weight':
          fx.text(e.x, 2.6, e.z, 'WEIGHT!', { color: '#c090ff', size: 1.0, life: 1 });
          break;
        case 'bolt':
          break;
        case 'strike': {
          fx.burst(e.x, 1, e.z, { shape: 'soft', color: [0xffffff, 0xff5a8a, 0xffe14a], count: 24, speed: 7, size: 0.8, life: 0.5, up: 4 });
          fx.sparks(e.x, 0.8, e.z, [0xffe14a, 0xffffff], 22, 9);
          fx.ring(e.x, e.z, { color: 0xff5a8a, radius: e.v * 1.6, life: 0.5 });
          kit.shake(0.55);
          break;
        }
      }
    },

    hud(w, slot) {
      const p = w.bodies.find((b) => b.kind === 'player' && b.slot === slot);
      if (!p || p.fall || !p.alive) return 'OUT';
      const d = w.data;
      const m = Math.round((d.meter?.[slot] ?? 0) * 100);
      return `${(d.zap?.[slot] ?? 0) > 0 ? '⚡ ' : ''}${(d.weight?.[slot] ?? 0) > 0 ? '⚓ ' : ''}${(d.hang?.[slot] ?? 0) > 0 ? 'HANGING' : `${m}%`}`;
    },

    dispose() {
      for (const m of bolts.values()) kit.root.remove(m);
      for (const b of bars.values()) { kit.root.remove(b.bg); kit.root.remove(b.fg); b.bg.material.dispose(); b.fg.material.dispose(); }
      for (const o of weights.values()) kit.root.remove(o);
      bolts.clear(); bars.clear(); weights.clear(); splashed.clear(); floes.length = 0; hangText.clear();
      kit.dispose();
    },
  };
}
