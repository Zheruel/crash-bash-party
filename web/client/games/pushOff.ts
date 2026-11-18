// POLAR PUSH view (shared/games/pushOff.ts): the four real levels (TILT, POLAR, MELT, MANIC PANIC) seen through the real
// low fixed camera. Backdrops and platforms come from the disc models listed in assets/stages/pushOff.json; the platform
// is a separate prop so it can tilt and shrink under the bears.
import * as THREE from 'three';
import { PO_RADIUS } from '../../shared/games/pushOff';
import { createCharacter, usedVariant } from '../characters';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import type { ActorParts } from './kit';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor, propObject } from './kit';
import type { ClientMiniGame } from './types';

const TILT_K = 0.14; // slope per unit of sim tilt (must match the cosmetic platform rotation)

/** Real cameras (native units x scale; fitted by eye against emulator frames), x-stretch 1.295. */
const cam = (y: number, z: number, pitch: number, fov: number, scale: number, x = 0) => ({ x: x * scale, y: y * scale, z: z * scale, pitch: (pitch * Math.PI) / 180, fov, sx: 1.295 });
export const PO_CAMS: Record<string, ReturnType<typeof cam>> = {
  tilt: cam(2.6, 4.9, 20, 65, 3.2, -1.1),
  polar: cam(1.7, 4.3, 7, 65, 3.2),
  melt: cam(2.1, 4.4, 10, 65, 3.2),
  manic: cam(2.6, 5.0, 16, 65, 3.2),
};
const KEY: Record<string, string> = { tilt: 'tiltPanic', polar: 'polarPanic', melt: 'meltPanic', manic: 'manicPanic' };
const PLAT: Record<string, string> = { tilt: 'poPlatTilt', polar: 'poPlatPolar', melt: 'poPlatMelt', manic: 'poPlatManic' };
const BG: Record<string, number> = { tilt: 0x6f8fb8, polar: 0x05060f, melt: 0x000000, manic: 0x78b4d8 };
/** TILT PANIC's sky: deep blue overhead fading to a lilac-pink horizon (the disc stores it as vertex colours we do not have). */
function skyGradient(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 4; c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#2f63a0'); gr.addColorStop(0.55, '#5f8cc0'); gr.addColorStop(0.82, '#a99ac0'); gr.addColorStop(1, '#c9a8bf');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const WATER: Record<string, number> = { tilt: -2.4, polar: -3, melt: -4, manic: -3 };
/** Level sound cue (banks 0449/0450 TILT, 0451 POLAR, 0448 MELT, 0447 MANIC) plus the shared polar pool. */
const SND = {
  hit: 'sfx/0447/1.mp3', ko: 'sfx/0446/0.mp3', splash: 'sfx/0165/20.mp3', pickup: 'sfx/0447/16.mp3', strike: 'sfx/0447/20.mp3', climb: 'sfx/0447/17.mp3',
  level: { tilt: 'sfx/0449/20.mp3', polar: 'sfx/0451/20.mp3', melt: 'sfx/0448/20.mp3', manic: 'sfx/0447/19.mp3' } as Record<string, string>,
};

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

/** POLAR PANIC's rim: a ring of chunky ice blocks around the platform (the disc stores it as animated tiles we cannot place). */
function iceRim(): THREE.Group {
  const g = new THREE.Group();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const h = 0.55 + rnd() * 0.5, w = 1.5 + rnd() * 0.5;
    const geo = new THREE.BoxGeometry(w, h, 0.9);
    const pos = geo.attributes.position, col: number[] = [];
    const t = 0.4 + rnd() * 0.3;
    for (let k = 0; k < pos.count; k++) { const top = pos.getY(k) > 0; const c = top ? t * 1.15 : t * 0.7; col.push(c * 0.92, c * 0.97, Math.min(1, c)); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // squash the top edge in so each block reads as a chunk of ice, not a crate
    for (let k = 0; k < pos.count; k++) if (pos.getY(k) > 0) pos.setXYZ(k, pos.getX(k) * 0.7, pos.getY(k), pos.getZ(k) * 0.6);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    m.position.set(Math.sin(a) * (PO_RADIUS + 0.2), h * 0.5 - 0.05, Math.cos(a) * (PO_RADIUS + 0.2));
    m.rotation.set((rnd() - 0.5) * 0.2, a + (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.2);
    g.add(m);
  }
  return g;
}

export function createPushOffView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let platform: THREE.Group;
  let edgeRing: THREE.Mesh;
  let water: THREE.Mesh | null = null;
  let backdrop: THREE.Group;
  let beamObj: THREE.Group;
  const bolts = new Map<number, THREE.Mesh>();
  const bars = new Map<number, Bar>();
  const weights = new Map<number, THREE.Object3D>();
  const splashed = new Set<number>();
  const hangText = new Map<number, number>();
  let chipT = 0, meltCue = false;
  let variant = 'tilt';
  let tilt: [number, number] = [0, 0];
  let bgColor = new THREE.Color(0);
  let bgTex: THREE.CanvasTexture | null = null;
  const up = new THREE.Vector3(0, 1, 0);

  function setCamera(cam: THREE.PerspectiveCamera) {
    const C = PO_CAMS[variant] ?? PO_CAMS.tilt;
    const a = cam.aspect, t0 = Math.tan((C.fov * Math.PI) / 360);
    cam.fov = a < 4 / 3 ? (2 * Math.atan((t0 * (4 / 3)) / a) * 180) / Math.PI : C.fov;
    cam.updateProjectionMatrix();
    cam.projectionMatrix.elements[0] *= C.sx; // the PS1 projection is wider than tall: real x-stretch
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.position.set(C.x, C.y, C.z);
    cam.lookAt(C.x, C.y - Math.sin(C.pitch) * 10, C.z - Math.cos(C.pitch) * 10);
  }

  function buildStage() {
    const R = kit.root;
    if (backdrop) { R.remove(backdrop); disposeTree(backdrop); }
    if (water) { R.remove(water); water = null; }
    if (platform) { R.remove(platform); disposeTree(platform); }
    backdrop = new THREE.Group();
    const cat = getCatalog();
    const arena = catalogInstance(cat.arenas['pushOff:' + KEY[variant]]);
    if (arena) backdrop.add(arena.root);
    R.add(backdrop);
    platform = new THREE.Group();
    const plat = catalogInstance(cat.props[PLAT[variant]]);
    if (plat) platform.add(plat.root);
    if (variant === 'polar') platform.add(iceRim());
    edgeRing = new THREE.Mesh(new THREE.RingGeometry(0.93 * PO_RADIUS, PO_RADIUS, 80).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0, depthWrite: false }));
    edgeRing.position.y = 0.05;
    platform.add(edgeRing);
    R.add(platform);
    if (!arena) {
      // model not loaded yet (preload still running): plain sea so the level is never blank
      water = new THREE.Mesh(new THREE.PlaneGeometry(140, 140).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1b5a8c }));
      water.position.y = WATER[variant];
      R.add(water);
    }
    // power-up beam column (Uka Uka's beam)
    beamObj = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 9, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xff7ad0, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
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
      return { inst, extra: r, shadow: 1.6, scale: 2.0, headY: 1.5 };
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
    async preload() { await preloadCatalogFor('pushOff', ['polarBear', 'weight', ...Object.values(PLAT)]); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'tilt';
      bgColor = new THREE.Color(BG[variant] ?? 0);
      bgTex = variant === 'tilt' ? skyGradient() : null;
      kit = new Kit(ctx, 'pushOff', { bg: BG[variant] ?? 0, hemi: [0xe4f3ff, 0x3a5a7a, 1.6] });
      splashed.clear(); bolts.clear(); bars.clear(); weights.clear(); hangText.clear();
      chipT = 0; meltCue = false; tilt = [0, 0];
      buildStage();
      setCamera(ctx.camera);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); buildStage(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      ctx.scene.background = bgTex ?? bgColor;
      setCamera(ctx.camera);
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
      em.opacity = shrinking && !kit.over.done ? 0.5 + Math.sin(ctx.time * 8) * 0.3 : 0;
      const surf = (x: number, z: number) => -TILT_K * (tilt[0] * x + tilt[1] * z);

      if (shrinking && !meltCue) { meltCue = true; sfx.playFile(SND.level[variant], 0.6); }
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
          const under = b.y < WATER[variant] + 0.4;
          if (b.fall && under && !splashed.has(b.id)) {
            splashed.add(b.id);
            kit.fx.splash(b.x, WATER[variant], b.z, 1.2);
            sfx.playFile(SND.splash, 0.5);
            kit.shake(0.25);
          }
          const sf = b.fall || hanging ? 0 : surf(b.x, b.z);
          const charging = b.dash > 0;
          a.update(b, dt, {
            hidden: !b.alive || b.y < WATER[variant] - 0.3,
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
          sfx.playFile(SND.hit, 0.7);
          kit.actorForSlot(e.o)?.squash.kick(0.35);
          kit.shake(0.3 + e.v * 0.25);
          break;
        }
        case 'ko':
          fx.burst(e.x, 0.6, e.z, { shape: 'soft', color: [0xffffff, 0xbfe9ff], count: 14, speed: 4, size: 0.5, life: 0.7, up: 4 });
          fx.text(e.x, 2.4, e.z, 'AAAH!', { color: '#ff6a5a', size: 1.3, life: 1.3 });
          sfx.playFile(SND.ko, 0.7);
          kit.shake(0.35);
          break;
        case 'hang':
          fx.text(e.x, 2.2, e.z, 'HELP!', { color: '#ffb040', size: 1.1, life: 1 });
          sfx.playFile(SND.level[variant], 0.4);
          fx.sparks(e.x, 0.4, e.z, 0xffffff, 6, 3);
          break;
        case 'climb':
          fx.stars(e.x, 0.8, e.z, 6);
          sfx.playFile(SND.climb, 0.6);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2, life: 0.4 });
          break;
        case 'pickup': {
          const zap = e.v === 1;
          sfx.playFile(SND.pickup, 0.7);
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
          sfx.playFile(SND.strike, 0.8);
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
      bgTex?.dispose();
      for (const b of bars.values()) { kit.root.remove(b.bg); kit.root.remove(b.fg); b.bg.material.dispose(); b.fg.material.dispose(); }
      for (const o of weights.values()) kit.root.remove(o);
      bolts.clear(); bars.clear(); weights.clear(); splashed.clear(); hangText.clear();
      kit.dispose();
    },
  };
}
