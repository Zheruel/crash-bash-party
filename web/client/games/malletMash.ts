// Mallet Mash view: a fenced meadow with 16 mushroom holes, wooden mallets, shock waves.
import * as THREE from 'three';
import { MM_HALF, MM_STARTS, type MalletMashData } from '../../shared/games/malletMash';
import { sfx } from '../shell/sound';
import { Kit, canvasTexture, checkerTexture, preloadCatalogFor } from './kit';
import { SPECIAL_CRATE_REF, easeOutBack, specialCrate } from './partyBits';
import type { ClientMiniGame } from './types';

const RISE = 0.38, SHAKE = 0.85, DUCK = 0.3;
const WAVE_FULL = 0.9;

interface MushV { group: THREE.Group; cap: THREE.Mesh; stem: THREE.Mesh; face: THREE.Group; gold: boolean; glint: THREE.Mesh; star: THREE.Mesh }
interface MalletV { pivot: THREE.Group; t: number }

export function createMalletMashView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const mush: MushV[] = [];
  const crates = new Map<number, THREE.Object3D>();
  const mallets = new Map<number, MalletV>();
  const chargeRings: THREE.Mesh[] = [];
  const bootsFx: THREE.Object3D[] = [];
  const swingT = [0, 0, 0, 0];
  let capTexRed: THREE.CanvasTexture, capTexGold: THREE.CanvasTexture;

  function makeMushroom(gold: boolean): MushV {
    const group = new THREE.Group();
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.52, 1.0, 16),
      new THREE.MeshStandardMaterial({ color: gold ? 0xfff0a0 : 0xf5ead2, roughness: 0.7 }),
    );
    stem.position.y = 0.5;
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshStandardMaterial({ map: gold ? capTexGold : capTexRed, roughness: gold ? 0.25 : 0.55, metalness: gold ? 0.6 : 0, emissive: gold ? 0x6a4a00 : 0x000000, emissiveIntensity: gold ? 0.5 : 0 }),
    );
    cap.position.y = 0.95;
    cap.scale.set(1, 0.85, 1);
    // little angry face on the stem
    const face = new THREE.Group();
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshBasicMaterial({ color: 0x1a1020 }));
      eye.position.set(sx * 0.17, 0.62, 0.43);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.045, 0.04), new THREE.MeshBasicMaterial({ color: 0x1a1020 }));
      brow.position.set(sx * 0.17, 0.73, 0.43); brow.rotation.z = -sx * 0.4;
      face.add(eye, brow);
    }
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
    star.visible = false;
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    glint.position.set(-0.4, 1.35, 0.5);
    glint.visible = gold;
    group.add(stem, cap, face, glint, star);
    return { group, cap, stem, face, gold, glint, star };
  }

  function makeMallet(): MalletV {
    const pivot = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8), new THREE.MeshStandardMaterial({ color: 0xa8743a, roughness: 0.7 }));
    handle.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.85, 14), new THREE.MeshStandardMaterial({ color: 0xc9893f, roughness: 0.6 }));
    head.rotation.z = Math.PI / 2;
    head.position.y = 1.55;
    for (const sx of [-1, 1]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.355, 0.355, 0.1, 14), new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.5, metalness: 0.4 }));
      band.rotation.z = Math.PI / 2; band.position.set(sx * 0.3, 1.55, 0);
      pivot.add(band);
    }
    pivot.add(handle, head);
    return { pivot, t: 0 };
  }

  function build() {
    const R = kit.root;
    capTexRed = canvasTexture(128, (g, s) => {
      g.fillStyle = '#d83a3a'; g.fillRect(0, 0, s, s);
      g.fillStyle = '#ffffff';
      for (const [x, y, r] of [[0.2, 0.3, 0.1], [0.55, 0.2, 0.08], [0.8, 0.45, 0.11], [0.35, 0.7, 0.09], [0.7, 0.8, 0.1], [0.05, 0.85, 0.07], [0.92, 0.12, 0.07], [0.5, 0.5, 0.07]]) {
        g.beginPath(); g.arc(x * s, y * s, r * s, 0, Math.PI * 2); g.fill();
      }
    }, undefined, false);
    capTexGold = canvasTexture(128, (g, s) => {
      const gr = g.createLinearGradient(0, 0, s, s);
      gr.addColorStop(0, '#ffe680'); gr.addColorStop(0.5, '#e8b020'); gr.addColorStop(1, '#ffe680');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (const [x, y, r] of [[0.2, 0.3, 0.08], [0.6, 0.25, 0.06], [0.8, 0.6, 0.09], [0.35, 0.75, 0.07]]) { g.beginPath(); g.arc(x * s, y * s, r * s, 0, Math.PI * 2); g.fill(); }
    }, undefined, false);

    // ---- meadow
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(MM_HALF * 2, MM_HALF * 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: checkerTexture('#58b04a', '#4ba03e', 2, [8, 8]), roughness: 1 }));
    R.add(grass);
    const earth = new THREE.Mesh(new THREE.BoxGeometry(MM_HALF * 2 + 1.6, 1.4, MM_HALF * 2 + 1.6), new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 }));
    earth.position.y = -0.72;
    R.add(earth);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(140, 140).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 1 }));
    outer.position.y = -1.45;
    R.add(outer);

    // ---- holes (dark pit + dirt mound ring)
    const holes = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) holes.push([(i - 1.5) * 3.4, (j - 1.5) * 3.4]);
    for (const [x, z] of holes) {
      const mound = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.3, 8, 24).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 1 }));
      mound.position.set(x, 0.06, z);
      mound.scale.y = 0.75;
      const pit = new THREE.Mesh(new THREE.CircleGeometry(0.95, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1b0f08 }));
      pit.position.set(x, 0.035, z);
      R.add(mound, pit);
      const mv = makeMushroom(false);
      mv.group.position.set(x, 0, z);
      R.add(mv.group);
      mush.push(mv);
    }

    // ---- fence
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9b6a3a, roughness: 0.9 });
    const rail = new THREE.MeshStandardMaterial({ color: 0xb88345, roughness: 0.9 });
    const L = MM_HALF + 0.5;
    for (let s = 0; s < 4; s++) {
      const g = new THREE.Group();
      g.rotation.y = (s * Math.PI) / 2;
      for (let i = -5; i <= 5; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.5, 0.34), postMat);
        p.position.set((i / 5) * L, 0.75, L);
        g.add(p);
      }
      for (const y of [0.55, 1.1]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(L * 2, 0.16, 0.14), rail);
        r.position.set(0, y, L);
        g.add(r);
      }
      R.add(g);
    }
    // trees + bushes outside
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.3, r = L + 4 + (i % 3) * 1.5;
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2, 8), new THREE.MeshStandardMaterial({ color: 0x6a4224 }));
      trunk.position.y = 1;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 10), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2f8a3a : 0x3a9a44, roughness: 1 }));
      crown.position.y = 3.2; crown.scale.y = 0.9;
      tree.add(trunk, crown);
      tree.position.set(Math.cos(a) * r * 1.05, -1.4, Math.sin(a) * r * 1.05);
      R.add(tree);
    }
    // power ring fx
    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const cr = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      cr.visible = false; cr.renderOrder = 5;
      R.add(cr); chargeRings.push(cr);
      const bf = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.07, 6, 20).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
      bf.visible = false; R.add(bf); bootsFx.push(bf);
    }
    // start corner marks
    for (let s = 0; s < 4; s++) {
      const [sx, sz] = MM_STARTS[s];
      const m = new THREE.Mesh(new THREE.CircleGeometry(1.2, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(s)), transparent: true, opacity: 0.4 }));
      m.position.set(sx * (MM_HALF - 1.6), 0.02, sz * (MM_HALF - 1.6));
      R.add(m);
    }
  }

  function mushPose(v: MushV, st: number, tm: number, gold: boolean, t: number) {
    const g = v.group;
    if (v.gold !== gold) {
      v.gold = gold;
      (v.cap.material as THREE.MeshStandardMaterial).map = gold ? capTexGold : capTexRed;
      (v.cap.material as THREE.MeshStandardMaterial).emissive.setHex(gold ? 0x6a4a00 : 0);
      (v.cap.material as THREE.MeshStandardMaterial).emissiveIntensity = gold ? 0.5 : 0;
      (v.cap.material as THREE.MeshStandardMaterial).metalness = gold ? 0.6 : 0;
      (v.cap.material as THREE.MeshStandardMaterial).needsUpdate = true;
      (v.stem.material as THREE.MeshStandardMaterial).color.setHex(gold ? 0xfff0a0 : 0xf5ead2);
      v.glint.visible = gold;
    }
    g.rotation.set(0, 0, 0);
    g.scale.set(1, 1, 1);
    v.star.visible = false;
    if (st === 0) { g.visible = false; return; }
    g.visible = true;
    let h = 1;
    if (st === 1) h = easeOutBack(Math.min(1, tm / RISE));
    else if (st === 3) {
      h = 1;
      const k = Math.min(1, tm / SHAKE);
      const a = 0.1 + k * 0.17;
      g.rotation.z = Math.sin(t * 46) * a; g.rotation.x = Math.cos(t * 41) * a * 0.7;
      g.scale.set(1 + Math.sin(t * 30) * 0.04, 1, 1 + Math.sin(t * 30) * 0.04);
    } else if (st === 4) h = 1 - Math.min(1, tm / DUCK);
    else if (st === 5) {
      const k = Math.min(1, tm / 0.5);
      g.scale.set(1.35 + k * 0.2, Math.max(0.12, 0.35 - k * 0.2), 1.35 + k * 0.2);
      h = 1;
      v.star.visible = true;
      v.star.position.set(Math.sin(t * 12) * 0.6, 1.6, Math.cos(t * 12) * 0.6);
    }
    g.position.y = -1.15 + h * 1.15;
  }

  return {
    id: 'malletMash',
    async preload() { await preloadCatalogFor('malletMash', [], [SPECIAL_CRATE_REF]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'malletMash', { bg: 0x8fd0ff, fog: [60, 140], hemi: [0xffffff, 0x6a8a5a, 1.6], sun: [-6, 18, 10] });
      build();
      ctx.frame(MM_HALF + 2.2);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) kit.reset(); mallets.clear(); });
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
          const a = kit.actor(b);
          let m = mallets.get(b.id);
          if (!m) { m = makeMallet(); a.yaw.add(m.pivot); mallets.set(b.id, m); m.pivot.position.set(0.62, 1.0, 0.1); }
          const stunned = (d.stun?.[s] ?? 0) > 0;
          a.update(b, dt, { role: stunned ? 'hit' : undefined });
          // mallet animation: rest on the shoulder, swing forward on 'swing', raise while charging
          swingT[s] = Math.max(0, swingT[s] - dt);
          const hold = d.hold?.[s] ?? 0;
          let rx = -2.1; // resting back
          if (swingT[s] > 0) { const k = 1 - swingT[s] / 0.26; rx = -2.4 + (k < 0.45 ? k / 0.45 * 3.5 : 1.1 - (k - 0.45) * 0.5); }
          else if (hold > 0.2) rx = -2.7 + Math.sin(t * 30) * 0.05 * Math.min(1, hold);
          else if (stunned) rx = -0.4;
          m.pivot.rotation.set(rx, 0, -0.15);
          m.pivot.scale.setScalar(0.95);
          // charge ring
          const cr = chargeRings[s];
          if (hold > 0.25 && !stunned) {
            const f = Math.min(1, hold / WAVE_FULL);
            const R = (d.power?.[s] ?? 0) > 0 ? 5.4 : 2.9;
            cr.visible = true;
            cr.position.set(b.x, 0.08, b.z);
            cr.scale.setScalar(Math.max(0.3, R * (0.25 + f * 0.75)));
            (cr.material as THREE.MeshBasicMaterial).color.set(f >= 1 ? 0xffe14a : kit.hex(s));
            (cr.material as THREE.MeshBasicMaterial).opacity = 0.35 + f * 0.5 + (f >= 1 ? Math.sin(t * 20) * 0.15 : 0);
            if (f >= 1 && Math.random() < 0.5) kit.fx.sparks(b.x + (Math.random() - 0.5) * 1.2, 0.5, b.z + (Math.random() - 0.5) * 1.2, 0xffe14a, 1, 2);
          } else cr.visible = false;
          // boots trail / power aura
          const bf = bootsFx[s];
          const sp = (d.boots?.[s] ?? 0) > 0, pw = (d.power?.[s] ?? 0) > 0;
          bf.visible = sp || pw;
          if (bf.visible) {
            bf.position.set(b.x, 0.25 + Math.sin(t * 8) * 0.05, b.z); bf.rotation.y = t * 5;
            (bf as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.setHex(pw ? 0xb86bff : 0xffe14a);
            if (sp && Math.hypot(b.vx, b.vz) > 3 && Math.random() < 0.6) kit.fx.trail(b.x - b.vx * 0.05, 0.3, b.z - b.vz * 0.05, 0xffe14a, 0.35, 0.3);
          }
        } else if (b.kind === 'crate') {
          seenC.add(b.id);
          let o = crates.get(b.id);
          if (!o) { o = specialCrate(1.25); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.06 + Math.sin(t * 3 + b.id) * 0.05, b.z);
          o.rotation.y = t * 1.6;
        }
      }
      kit.prune(seen);
      for (const [id, o] of crates) if (!seenC.has(id)) { kit.root.remove(o); crates.delete(id); }
      for (const [id, m] of mallets) if (!seen.has(id)) mallets.delete(id);

      const holes = d.holes ?? [];
      holes.forEach((h, i) => { if (mush[i]) mushPose(mush[i], h.st, h.t, h.gold, t); });
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'rise':
          fx.dust(e.x, e.z, 0.5, 0x8a6a42);
          fx.burst(e.x, 0.3, e.z, { shape: 'dot', color: 0x6a4a2a, count: 5, speed: 2, size: 0.18, life: 0.5, up: 2, gravity: 10 });
          if (e.v) { fx.sparks(e.x, 1.4, e.z, [0xffe14a, 0xffffff], 8, 3); sfx.play('tick', 2); }
          break;
        case 'swing':
          swingT[e.s] = 0.26;
          kit.actorForSlot(e.s)?.action();
          sfx.play('whoosh', 0.9);
          break;
        case 'whiff':
          fx.dust(e.x, e.z, 0.6, 0x8a9a6a);
          break;
        case 'smash': {
          const gold = e.o === 1;
          const col = gold ? [0xffe14a, 0xffffff, 0xffb000] : [0xd83a3a, 0xffffff, 0xffd0a0];
          fx.burst(e.x, 0.9, e.z, { shape: 'chip', color: col, count: gold ? 24 : 14, speed: 5, size: 0.3, life: 0.8, up: 3, gravity: 9 });
          fx.stars(e.x, 1.2, e.z, gold ? 10 : 5);
          fx.ring(e.x, e.z, { color: gold ? 0xffe14a : 0xffffff, radius: gold ? 3.2 : 2, life: 0.4 });
          fx.text(e.x, 2.3, e.z, `+${e.v}`, { color: gold ? '#ffe14a' : kit.hex(e.s), size: e.v >= 10 ? 2.1 : e.v >= 5 ? 1.6 : 1.2, life: 1.1 });
          kit.shake(gold ? 0.35 : 0.14);
          kit.actorForSlot(e.s)?.squash.kick(0.2);
          sfx.play(gold ? 'coin' : 'thud', gold ? 1.2 : 1.4);
          break;
        }
        case 'wave': {
          fx.ring(e.x, e.z, { color: 0xffffff, radius: e.v, life: 0.55 });
          fx.ring(e.x, e.z, { color: new THREE.Color(kit.hex(e.s)), radius: e.v * 0.75, life: 0.45 });
          fx.burst(e.x, 0.3, e.z, { shape: 'smoke', color: 0xd9cfb8, count: 18, speed: e.v * 1.4, size: 0.8, life: 0.7, flat: true, gravity: -0.2, grow: 2.2 });
          kit.shake(0.6);
          sfx.play('boom', 1.1);
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
          sfx.play('lucky');
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as MalletMashData;
      return `${d.score?.[slot] ?? 0}${(d.boots?.[slot] ?? 0) > 0 ? ' ›' : ''}${(d.power?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      mush.length = 0; crates.clear(); mallets.clear(); chargeRings.length = 0; bootsFx.length = 0;
      swingT.fill(0);
      kit.dispose();
      void ctx;
    },
  };
}
