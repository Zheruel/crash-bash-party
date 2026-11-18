// Dragon Drop view: a coiled dragon in the middle spits balloons onto a slowly rotating lacquered ring.
import * as THREE from 'three';
import { DD_DRAGON, DD_IN, DD_MAX_AGE, DD_OUT, type DragonDropData } from '../../shared/games/dragonDrop';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { sfx } from '../shell/sound';
import { Kit, canvasTexture, preloadCatalogFor } from './kit';
import { SPECIAL_CRATE_REF, glowTexture, specialCrate } from './partyBits';
import type { ClientMiniGame } from './types';

const BLACK = 0x23202c;

interface BalloonV { obj: THREE.Group; body: THREE.Mesh; string: THREE.Line; shadow: BlobShadow; slot: number; y: number; x: number; z: number }

export function createDragonDropView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const balloons = new Map<number, BalloonV>();
  const crates = new Map<number, THREE.Object3D>();
  let ringGroup: THREE.Group;
  let head: THREE.Group, jaw: THREE.Mesh;
  let headYaw = 0, headTarget = 0, mouth = 0;
  const lanterns: THREE.Mesh[] = [];
  const hoverFx: THREE.Mesh[] = [];
  const magnetFx: THREE.Mesh[] = [];
  const clouds: THREE.Sprite[] = [];
  let sphereGeo: THREE.SphereGeometry, knotGeo: THREE.ConeGeometry;
  let ringAngle = 0;
  let lastDir = 1;
  let arrow: THREE.Mesh;

  function balloonMat(slot: number) {
    const c = new THREE.Color(slot < 0 ? BLACK : kit.hex(slot));
    return new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: slot < 0 ? 0.05 : 0.22, roughness: 0.18, metalness: 0.05 });
  }
  function makeBalloon(slot: number): BalloonV {
    const obj = new THREE.Group();
    const body = new THREE.Mesh(sphereGeo, balloonMat(slot));
    body.scale.set(0.5, 0.62, 0.5);
    const knot = new THREE.Mesh(knotGeo, body.material);
    knot.position.y = -0.64; knot.rotation.x = Math.PI;
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    shine.position.set(-0.16, 0.22, 0.3);
    const sg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.7, 0), new THREE.Vector3(0.05, -1.4, 0.02), new THREE.Vector3(-0.03, -2.1, 0)]);
    const string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xf4efe0, transparent: true, opacity: 0.8 }));
    obj.add(body, knot, shine, string);
    if (slot < 0) { // black balloons get a little white star mark
      const star = new THREE.Mesh(new THREE.CircleGeometry(0.17, 5), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
      star.position.set(0, 0.05, 0.5);
      obj.add(star);
      obj.userData.star = star;
    }
    kit.root.add(obj);
    return { obj, body, string, shadow: kit.fx.shadow(0.4, 0.3), slot, y: 0, x: 0, z: 0 };
  }

  function build() {
    const R = kit.root;
    sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    knotGeo = new THREE.ConeGeometry(0.1, 0.18, 8);

    // ---- ring platform (rotates)
    ringGroup = new THREE.Group();
    R.add(ringGroup);
    const topTex = canvasTexture(512, (g, s) => {
      const c = s / 2;
      g.fillStyle = '#6b1520'; g.fillRect(0, 0, s, s);
      const rr = (r: number) => (r / DD_OUT) * c;
      // scale pattern
      for (let ring = 0; ring < 3; ring++) {
        const r = DD_IN + 0.7 + ring * 2.0;
        const n = 28 + ring * 8;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + ring * 0.1;
          g.fillStyle = ring % 2 ? '#8a1c2a' : '#7a1826';
          g.beginPath(); g.arc(c + Math.cos(a) * rr(r), c + Math.sin(a) * rr(r), rr(1.05), 0, Math.PI * 2); g.fill();
          g.strokeStyle = 'rgba(255,200,90,0.5)'; g.lineWidth = 2; g.stroke();
        }
      }
      g.strokeStyle = '#f2c24a'; g.lineWidth = 9;
      for (const r of [DD_IN + 0.18, DD_OUT - 0.18]) { g.beginPath(); g.arc(c, c, rr(r), 0, Math.PI * 2); g.stroke(); }
      // clockwise chevrons
      g.fillStyle = 'rgba(255,225,120,0.85)';
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, rm = (DD_IN + DD_OUT) / 2;
        g.save(); g.translate(c + Math.cos(a) * rr(rm), c + Math.sin(a) * rr(rm)); g.rotate(a + Math.PI / 2);
        g.beginPath(); g.moveTo(0, -14); g.lineTo(13, 8); g.lineTo(0, 2); g.lineTo(-13, 8); g.closePath(); g.fill(); g.restore();
      }
    }, undefined, false);
    const top = new THREE.Mesh(new THREE.RingGeometry(DD_IN, DD_OUT, 80, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55 }));
    // RingGeometry UVs are planar; rebuild them so the square texture covers the outer circle
    const uv = top.geometry.attributes.uv as THREE.BufferAttribute, pos = top.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) / DD_OUT + 1) / 2, 1 - (pos.getZ(i) / DD_OUT + 1) / 2);
    ringGroup.add(top);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3d0e18, roughness: 0.7 });
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(DD_OUT, DD_OUT - 0.4, 1.3, 80, 1, true), wallMat);
    outer.position.y = -0.65;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(DD_IN + 0.4, DD_IN, 1.3, 64, 1, true), new THREE.MeshStandardMaterial({ color: 0x3d0e18, roughness: 0.7, side: THREE.BackSide }));
    inner.position.y = -0.65;
    const under = new THREE.Mesh(new THREE.RingGeometry(DD_IN, DD_OUT - 0.4, 64).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a0a12 }));
    under.position.y = -1.3;
    ringGroup.add(outer, inner, under);
    // gold rails + lanterns
    for (const [r, h] of [[DD_OUT + 0.12, 0.34], [DD_IN - 0.12, 0.34]] as [number, number][]) {
      const rail = new THREE.Mesh(new THREE.TorusGeometry(r, 0.18, 8, 96).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe0b043, metalness: 0.6, roughness: 0.35 }));
      rail.position.y = h;
      ringGroup.add(rail);
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const lan = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff5a3a : 0xffb040 }));
      lan.scale.y = 1.2;
      lan.position.set(Math.cos(a) * (DD_OUT + 0.12), 0.95, Math.sin(a) * (DD_OUT + 0.12));
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.7, 6), new THREE.MeshStandardMaterial({ color: 0xe0b043 }));
      post.position.set(lan.position.x, 0.5, lan.position.z);
      ringGroup.add(lan, post);
      lanterns.push(lan);
    }

    // ---- dragon pedestal + coils + head (static, the head turns)
    const dragon = new THREE.Group();
    R.add(dragon);
    const scaleTex = canvasTexture(128, (g, s) => {
      g.fillStyle = '#1f7a4a'; g.fillRect(0, 0, s, s);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#2f9a5a' : '#28884f';
        g.beginPath(); g.arc(x * 16 + (y % 2) * 8, y * 16 + 8, 10, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2; g.stroke();
      }
    }, [3, 2]);
    const scaleMat = new THREE.MeshStandardMaterial({ map: scaleTex, roughness: 0.5 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xe0b043, metalness: 0.6, roughness: 0.3 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(DD_DRAGON + 0.1, DD_DRAGON + 0.5, 0.7, 40), new THREE.MeshStandardMaterial({ color: 0x4a2a2a, roughness: 0.7 }));
    base.position.y = 0.35;
    dragon.add(base);
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(new THREE.TorusGeometry(1.45 - i * 0.12, 0.58, 12, 36).rotateX(Math.PI / 2), scaleMat);
      c.position.y = 0.9 + i * 0.85;
      c.rotation.y = i * 0.9;
      dragon.add(c);
    }
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.0, 1.4, 20), scaleMat);
    neck.position.y = 4.1;
    dragon.add(neck);
    head = new THREE.Group();
    head.position.set(0, 4.9, 0);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(1.05, 20, 14), scaleMat);
    skull.scale.set(1, 0.9, 1.1);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, 1.2), new THREE.MeshStandardMaterial({ color: 0x2f9a5a, roughness: 0.5 }));
    snout.position.set(0, -0.12, 1.1);
    jaw = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 1.1), new THREE.MeshStandardMaterial({ color: 0x23814b, roughness: 0.5 }));
    jaw.geometry.translate(0, 0, 0.55);
    jaw.position.set(0, -0.5, 0.55);
    const mouthIn = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.9), new THREE.MeshBasicMaterial({ color: 0x300808 }));
    mouthIn.position.set(0, -0.36, 1.1);
    head.add(skull, snout, jaw, mouthIn);
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.1, 8), gold);
      horn.position.set(sx * 0.6, 0.95, -0.2); horn.rotation.set(-0.4, 0, sx * 0.5);
      const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
      eyeW.position.set(sx * 0.55, 0.3, 0.7);
      const eyeP = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      eyeP.position.set(sx * 0.6, 0.32, 0.86);
      const nos = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0x113322 }));
      nos.position.set(sx * 0.25, 0.1, 1.68);
      const whisk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.01, 0.9, 5), new THREE.MeshStandardMaterial({ color: 0xffd23f }));
      whisk.position.set(sx * 0.85, -0.25, 1.3); whisk.rotation.set(0.3, 0, sx * 1.2);
      head.add(horn, eyeW, eyeP, nos, whisk);
    }
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 6), new THREE.MeshStandardMaterial({ color: 0xd8353a, roughness: 0.5 }));
      sp.position.set(0, 0.9 - i * 0.05, -0.5 - i * 0.3); sp.rotation.x = -0.9 - i * 0.12;
      head.add(sp);
    }
    dragon.add(head);

    // ---- misty clouds far below
    const gt = glowTexture('rgba(255,235,255,0.55)', 'rgba(255,235,255,0)');
    for (let i = 0; i < 18; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, transparent: true, opacity: 0.55, depthWrite: false }));
      sp.userData.keepMap = true;
      const a = (i / 18) * Math.PI * 2, r = 10 + (i % 3) * 5;
      sp.position.set(Math.cos(a) * r, -3.2 - (i % 4) * 0.5, Math.sin(a) * r);
      sp.scale.setScalar(10 + (i % 5) * 2);
      sp.renderOrder = -1;
      R.add(sp); clouds.push(sp);
    }
    const abyss = new THREE.Mesh(new THREE.CircleGeometry(90, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a2a68 }));
    abyss.position.y = -7;
    R.add(abyss);
    // direction arrow marker floating at the front of the ring
    arrow = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.0, depthWrite: false }));
    arrow.position.set(0, 2.6, DD_OUT + 1.6);
    R.add(arrow);
    // power-up rings
    for (let s = 0; s < 4; s++) {
      const hv = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.09, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x66e8ff, transparent: true, opacity: 0.9 }));
      hv.visible = false; R.add(hv); hoverFx.push(hv);
      const mg = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(s)), transparent: true, opacity: 0.8, depthWrite: false }));
      mg.visible = false; R.add(mg); magnetFx.push(mg);
    }
  }

  const nearestBalloon = (x: number, z: number) => {
    let best: BalloonV | null = null, bd = 0.9;
    for (const v of balloons.values()) { const dd = Math.hypot(v.x - x, v.z - z); if (dd < bd) { bd = dd; best = v; } }
    return best;
  };

  return {
    id: 'dragonDrop',
    async preload() { await preloadCatalogFor('dragonDrop', [], [SPECIAL_CRATE_REF]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'dragonDrop', { bg: 0x2a1a4a, fog: [50, 120], hemi: [0xffe9f2, 0x4a3a6a, 1.5], sun: [-5, 18, 10] });
      build();
      ctx.frame(DD_OUT + 2.4);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) kit.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as DragonDropData;
      const t = ctx.time;
      // ring rotation: same sense as the sim (x' = x cos - z sin ...  == rotation.y by -theta)
      if (d.ring !== undefined) {
        ringAngle -= d.ring * dt;
        ringGroup.rotation.y = ringAngle;
        const dir = d.dir ?? 1;
        if (dir !== lastDir) { lastDir = dir; }
      }
      const seen = new Set<number>(), seenB = new Set<number>(), seenC = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const hov = (d.hover?.[s] ?? 0) > 0;
          kit.actor(b).update(b, dt, { role: d.stun?.[s] > 0 ? 'hit' : undefined, hop: hov ? 0.35 + Math.sin(t * 6 + s) * 0.06 : 0 });
          const hf = hoverFx[s];
          hf.visible = hov;
          if (hov) { hf.position.set(b.x, b.y + 0.3 + Math.sin(t * 6 + s) * 0.06, b.z); hf.rotation.y = t * 4; hf.scale.setScalar(1 + Math.sin(t * 9) * 0.06); if (Math.random() < 0.5) kit.fx.trail(b.x, 0.25 + b.y, b.z, 0x66e8ff, 0.3, 0.3); }
          const mf = magnetFx[s];
          const mg = (d.magnet?.[s] ?? 0) > 0;
          mf.visible = mg;
          if (mg) { mf.position.set(b.x, 0.08, b.z); const k = 1 + ((t * 1.4 + s * 0.3) % 1) * 2.2; mf.scale.setScalar(k); (mf.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - (k - 1) / 2.2); }
        } else if (b.kind === 'balloon') {
          seenB.add(b.id);
          let v = balloons.get(b.id);
          if (!v) { v = makeBalloon(b.slot); balloons.set(b.id, v); }
          if (v.slot !== b.slot) { // recoloured by a black balloon
            v.slot = b.slot;
            (v.body.material as THREE.MeshStandardMaterial).dispose();
            const m = balloonMat(b.slot);
            v.body.material = m;
            kit.fx.burst(b.x, b.y, b.z, { shape: 'soft', color: m.color, count: 6, speed: 2, size: 0.5, life: 0.5, gravity: 0 });
          }
          v.x = b.x; v.z = b.z; v.y = b.y;
          const sway = Math.sin(t * 2 + b.id) * 0.08;
          v.obj.position.set(b.x, b.y, b.z);
          v.obj.rotation.set(sway, 0, -sway);
          const ageLeft = DD_MAX_AGE - b.cd;
          v.obj.visible = true;
          if (ageLeft < 3) v.obj.visible = Math.floor(t * 8) % 2 === 0 || ageLeft > 1.2;
          v.shadow.set(b.x, b.z, Math.max(0, b.y));
          v.shadow.mesh.visible = b.cd > 0.6;
          const star = v.obj.userData.star as THREE.Mesh | undefined;
          if (star) star.rotation.z = t * 2;
        } else if (b.kind === 'crate') {
          seenC.add(b.id);
          let o = crates.get(b.id);
          if (!o) { o = specialCrate(1.25); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.05 + Math.sin(t * 3 + b.id) * 0.04, b.z);
          o.rotation.y = t * 1.5;
        }
      }
      kit.prune(seen);
      for (const [id, v] of balloons) if (!seenB.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); balloons.delete(id); }
      for (const [id, o] of crates) if (!seenC.has(id)) { kit.root.remove(o); crates.delete(id); }

      // dragon: head tracks the last spit direction, mouth opens briefly
      headYaw += (headTarget - headYaw) * Math.min(1, dt * 5);
      head.rotation.y = headYaw + Math.sin(t * 0.6) * 0.1;
      mouth = Math.max(0, mouth - dt * 2.5);
      jaw.rotation.x = 0.1 + mouth * 0.6;
      head.position.y = 4.9 + Math.sin(t * 1.5) * 0.08;
      head.scale.setScalar(1 + mouth * 0.07);
      lanterns.forEach((l, i) => { l.scale.y = 1.2 + Math.sin(t * 3 + i) * 0.08; });
      clouds.forEach((c, i) => { c.position.x += Math.sin(t * 0.2 + i) * 0.01; });
      // direction arrow flash after a reversal is handled in onEvent via opacity
      (arrow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (arrow.material as THREE.MeshBasicMaterial).opacity - dt * 0.8);
      arrow.rotation.y = lastDir > 0 ? 0 : Math.PI;
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'spawn': {
          headTarget = Math.atan2(e.x, e.z);
          mouth = 1;
          fx.burst(Math.sin(headTarget) * 2.2, 4.5, Math.cos(headTarget) * 2.2, { shape: 'smoke', color: [0xffe0f0, 0xffffff], count: 4, speed: 1.4, size: 0.6, life: 0.7, gravity: -0.5 });
          break;
        }
        case 'pop': {
          const v = nearestBalloon(e.x, e.z);
          const y = v?.y ?? 2.2;
          const col = v ? (v.slot < 0 ? BLACK : new THREE.Color(kit.hex(v.slot)).getHex()) : 0xffffff;
          fx.burst(e.x, y, e.z, { shape: 'chip', color: [col, 0xffffff], count: 16, speed: 4.5, size: 0.3, life: 0.8, gravity: 7 });
          fx.ring(e.x, e.z, { color: col, radius: 1.6, life: 0.3, y });
          sfx.play('pop', e.v ? 1.0 : 0.7);
          if (v) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); for (const [id, bv] of balloons) if (bv === v) balloons.delete(id); }
          kit.actorForSlot(e.s)?.squash.kick(0.15);
          break;
        }
        case 'score':
          fx.text(e.x, 3.2, e.z, `+${e.v}`, { color: kit.hex(e.s), size: e.v > 1 ? 1.7 : 1.2 });
          if (e.v > 1) { fx.stars(e.x, 2.4, e.z, 6); sfx.play('coin', 1.3); }
          break;
        case 'black': {
          const names = ['POP THEM!', 'REVERSE!', 'MY COLOUR!'];
          fx.text(e.x, 3.6, e.z, names[e.v] ?? '?', { color: '#ffe14a', size: 1.7, life: 1.5 });
          fx.ring(e.x, e.z, { color: 0xffe14a, radius: 6, life: 0.6, y: 2 });
          kit.shake(0.4);
          sfx.play('chaos');
          break;
        }
        case 'reverse':
          (arrow.material as THREE.MeshBasicMaterial).opacity = 1;
          break;
        case 'crate': {
          fx.confetti(e.x, 1, e.z, 20);
          fx.text(e.x, 2.5, e.z, e.v === 1 ? 'HOVER BOOTS' : 'MAGNET', { color: '#9ff0ff', size: 1.3, life: 1.3 });
          sfx.play('lucky');
          break;
        }
        case 'punch': {
          if (e.v === 2) {
            fx.stars(e.x, 1.3, e.z, 8);
            kit.actorForSlot(e.s)?.hit();
            kit.shake(0.25);
            sfx.play('thud');
          } else { fx.ring(e.x, e.z, { color: 0xffffff, radius: 1.4, life: 0.25 }); sfx.play('whoosh', 1.4); }
          break;
        }
        case 'fade':
          fx.sparks(e.x, 6, e.z, 0xffffff, 4, 2);
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as DragonDropData;
      return `${d.score?.[slot] ?? 0}${(d.hover?.[slot] ?? 0) > 0 ? ' ▲' : ''}${(d.magnet?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      for (const v of balloons.values()) kit.fx.removeShadow(v.shadow);
      balloons.clear(); crates.clear();
      lanterns.length = 0; hoverFx.length = 0; magnetFx.length = 0; clouds.length = 0;
      ringAngle = 0; lastDir = 1; headYaw = 0; headTarget = 0; mouth = 0;
      kit.dispose();
      void ctx; void (null as unknown as Body);
    },
  };
}
