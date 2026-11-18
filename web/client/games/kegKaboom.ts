// Keg Kaboom view: a wooden pier over the sea, powder kegs (normal / silver / gold), gunpowder trails and explosions.
import * as THREE from 'three';
import { KK_HALF, KK_KEG_R, POWDER_MAX, type KegKaboomData } from '../../shared/games/kegKaboom';
import { sfx } from '../shell/sound';
import { Kit, canvasTexture, labelSprite, preloadCatalogFor } from './kit';
import { Bar3D, SPECIAL_CRATE_REF, glowTexture, specialCrate } from './partyBits';
import type { ClientMiniGame } from './types';

const BURN_LIFE = 0.5;
const MAX_NODES = 1000;

interface KegV { group: THREE.Group; body: THREE.Mesh; fuse: THREE.Mesh; spark: THREE.Sprite; label: THREE.Sprite; kind: number; landed: boolean; mat: THREE.MeshStandardMaterial }

export function createKegKaboomView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const kegs = new Map<number, KegV>();
  const crates = new Map<number, THREE.Object3D>();
  const bars: Bar3D[] = [];
  const auras: THREE.Mesh[] = [];
  let powderMesh: THREE.InstancedMesh, fireMesh: THREE.InstancedMesh;
  let sea: THREE.Mesh, seaTex: THREE.CanvasTexture;
  const lanterns: THREE.Mesh[] = [];
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  let barrelGeo: THREE.LatheGeometry, bandGeo: THREE.TorusGeometry, glow: THREE.CanvasTexture;
  let flagPole: THREE.Group;

  function woodTex(base: string, dark: string, vertical: boolean, repeat: [number, number], n = 8) {
    return canvasTexture(128, (g, s) => {
      g.fillStyle = base; g.fillRect(0, 0, s, s);
      for (let i = 0; i < n; i++) {
        const o = (i * s) / n;
        g.fillStyle = i % 2 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.05)';
        vertical ? g.fillRect(o, 0, s / n, s) : g.fillRect(0, o, s, s / n);
        g.fillStyle = dark;
        vertical ? g.fillRect(o, 0, 2, s) : g.fillRect(0, o, s, 2);
      }
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (let i = 0; i < 24; i++) { const x = Math.random() * s, y = Math.random() * s; vertical ? g.fillRect(x, y, 1.5, 8 + Math.random() * 14) : g.fillRect(x, y, 8 + Math.random() * 14, 1.5); }
    }, repeat);
  }

  function makeKeg(kind: number, v: number): KegV {
    const group = new THREE.Group();
    const tex = kind === 0 ? woodTex('#b9763a', '#5a3318', true, [1, 1], 7) : null;
    const mat = new THREE.MeshStandardMaterial(
      kind === 0 ? { map: tex, roughness: 0.75 }
        : kind === 1 ? { color: 0xd4dbe6, roughness: 0.22, metalness: 0.85, emissive: 0x303844, emissiveIntensity: 0.3 }
          : { color: 0xffcf3a, roughness: 0.2, metalness: 0.9, emissive: 0x7a5200, emissiveIntensity: 0.6 },
    );
    const body = new THREE.Mesh(barrelGeo, mat);
    const bandMat = new THREE.MeshStandardMaterial({ color: kind === 0 ? 0x34343c : kind === 1 ? 0x77808f : 0xa8741a, roughness: 0.4, metalness: 0.7 });
    for (const y of [0.22, 0.98]) {
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.y = y; band.scale.setScalar(y < 0.5 ? 0.9 : 0.9);
      band.rotation.x = Math.PI / 2;
      group.add(band);
    }
    const lid = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: kind === 0 ? 0x9a602c : kind === 1 ? 0xbcc4d0 : 0xe8b020, roughness: 0.5, metalness: kind ? 0.8 : 0 }));
    lid.position.y = 1.205;
    // fuse
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0xe8d9a8, roughness: 0.9 }));
    fuse.position.set(0.08, 1.45, 0);
    fuse.rotation.z = -0.25;
    const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffa030, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    spark.userData.keepMap = true;
    spark.scale.setScalar(0.9); spark.position.set(0.16, 1.7, 0); spark.visible = false;
    // value tag
    const label = labelSprite(String(v), kind === 2 ? '#ffe14a' : kind === 1 ? '#e8f0ff' : '#ffffff', 0.95);
    label.position.set(0, 2.5, 0);
    group.add(body, lid, fuse, spark, label);
    kit.root.add(group);
    return { group, body, fuse, spark, label, kind, landed: false, mat };
  }

  function build() {
    const R = kit.root;
    glow = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    // barrel profile
    const prof: THREE.Vector2[] = [[0, 0], [0.56, 0], [0.66, 0.15], [0.74, 0.45], [0.74, 0.75], [0.66, 1.05], [0.58, 1.2]].map(([x, y]) => new THREE.Vector2(x, y));
    barrelGeo = new THREE.LatheGeometry(prof, 20);
    bandGeo = new THREE.TorusGeometry(0.72, 0.045, 6, 24);

    // ---- sea
    seaTex = canvasTexture(128, (g, s) => {
      g.fillStyle = '#1d6fa5'; g.fillRect(0, 0, s, s);
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 2;
      for (let i = 0; i < 9; i++) { g.beginPath(); const y = (i + 0.5) * (s / 9); g.moveTo(0, y); for (let x = 0; x <= s; x += 8) g.lineTo(x, y + Math.sin(x * 0.2 + i) * 3); g.stroke(); }
    }, [12, 12], false);
    sea = new THREE.Mesh(new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: seaTex, roughness: 0.4 }));
    sea.position.y = -1.6;
    R.add(sea);

    // ---- deck
    const H = KK_HALF;
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: woodTex('#a8703a', '#4a2a12', false, [1, 1], 11), roughness: 0.85 }));
    deck.material.map!.repeat.set(2, 2);
    R.add(deck);
    // plank seams (drawn lines to hint boards across the whole deck)
    const beams = new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.9 });
    for (const s of [-1, 1]) {
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 1.2, 0.5, 0.6), beams); b1.position.set(0, 0.0, s * (H + 0.3));
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, H * 2 + 1.2), beams); b2.position.set(s * (H + 0.3), 0.0, 0);
      R.add(b1, b2);
    }
    const under = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 1.2, 1.2, H * 2 + 1.2), new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 1 }));
    under.position.y = -0.7;
    R.add(under);
    // pier posts with rope + lanterns
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 1 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: 1 });
    const pts: [number, number][] = [];
    for (let i = -5; i <= 5; i++) { const k = (i / 5) * (H + 0.3); pts.push([k, -H - 0.3], [k, H + 0.3]); if (Math.abs(i) !== 5) pts.push([-H - 0.3, k], [H + 0.3, k]); }
    for (const [x, z] of pts) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 3.2, 8), postMat);
      p.position.set(x, 0.4, z);
      R.add(p);
    }
    for (const s of [-1, 1]) {
      for (const y of [1.2]) {
        const r1 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, (H + 0.3) * 2, 6).rotateZ(Math.PI / 2), ropeMat); r1.position.set(0, y, s * (H + 0.3));
        const r2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, (H + 0.3) * 2, 6).rotateX(Math.PI / 2), ropeMat); r2.position.set(s * (H + 0.3), y, 0);
        R.add(r1, r2);
      }
    }
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 3.2, 8), postMat);
      post.position.set(cx * (H + 0.3), 1.4, cz * (H + 0.3));
      const lan = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb040 }));
      lan.position.set(post.position.x, 3.2, post.position.z);
      R.add(post, lan);
      lanterns.push(lan);
    }
    // pirate flag at the far side
    flagPole = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 7, 6), postMat);
    pole.position.y = 3.5;
    const flagTex = canvasTexture(128, (g, s) => {
      g.fillStyle = '#17171d'; g.fillRect(0, 0, s, s);
      g.fillStyle = '#f2f2f2';
      g.beginPath(); g.arc(s / 2, s * 0.42, s * 0.2, 0, Math.PI * 2); g.fill(); g.fillRect(s * 0.4, s * 0.55, s * 0.2, s * 0.1);
      g.fillStyle = '#17171d'; g.beginPath(); g.arc(s * 0.42, s * 0.4, s * 0.05, 0, 7); g.arc(s * 0.58, s * 0.4, s * 0.05, 0, 7); g.fill();
      g.strokeStyle = '#f2f2f2'; g.lineWidth = 8; g.beginPath(); g.moveTo(s * 0.25, s * 0.75); g.lineTo(s * 0.75, s * 0.9); g.moveTo(s * 0.75, s * 0.75); g.lineTo(s * 0.25, s * 0.9); g.stroke();
    }, undefined, false);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.2), new THREE.MeshBasicMaterial({ map: flagTex, side: THREE.DoubleSide }));
    flag.position.set(1.6, 5.6, 0);
    flag.name = 'flag';
    flagPole.add(pole, flag);
    flagPole.position.set(-H - 3.2, -1.4, -H - 3.0);
    R.add(flagPole);
    // a few decorative barrels / crates floating off the pier
    for (let i = 0; i < 5; i++) {
      const a = 0.6 + i * 1.1;
      const m = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({ map: woodTex('#8a5a2a', '#3a2010', true, [1, 1], 7), roughness: 0.9 }));
      m.position.set(Math.cos(a) * (H + 6 + i), -1.7, Math.sin(a) * (H + 6 + i));
      m.rotation.set(0.5, a, 1.2);
      R.add(m);
    }

    // ---- trail instancing
    powderMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.27, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x22222a }), MAX_NODES);
    powderMesh.frustumCulled = false; powderMesh.count = 0;
    fireMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_NODES);
    fireMesh.frustumCulled = false; fireMesh.count = 0;
    fireMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3), 3);
    R.add(powderMesh, fireMesh);

    // ---- per-player gauge + shockwave aura
    for (let s = 0; s < 4; s++) {
      const b = new Bar3D(1.5, 0.16, kit.hex(s));
      b.group.visible = false;
      R.add(b.group); bars.push(b);
      const au = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc77bff, transparent: true, opacity: 0.85, depthWrite: false }));
      au.visible = false; R.add(au); auras.push(au);
    }
  }

  return {
    id: 'kegKaboom',
    async preload() { await preloadCatalogFor('kegKaboom', [], [SPECIAL_CRATE_REF]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'kegKaboom', { bg: 0x9ad4f2, fog: [70, 160], hemi: [0xfff4e0, 0x5a7a9a, 1.5], sun: [8, 18, 6] });
      build();
      ctx.frame(KK_HALF + 2.4);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) kit.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as KegKaboomData;
      const t = ctx.time;
      seaTex.offset.set(t * 0.012, t * 0.02);
      flagPole.getObjectByName('flag')!.rotation.y = Math.sin(t * 2) * 0.15;
      lanterns.forEach((l, i) => l.scale.setScalar(1 + Math.sin(t * 5 + i) * 0.08));

      const seen = new Set<number>(), seenC = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const a = kit.actor(b);
          a.update(b, dt, { role: (d.stun?.[s] ?? 0) > 0 ? 'hit' : undefined, blink: (d.invul?.[s] ?? 0) > 0 && (d.stun?.[s] ?? 0) <= 0 });
          const bar = bars[s];
          const pw = (d.powder?.[s] ?? POWDER_MAX) / POWDER_MAX;
          const laying = (d.laying?.[s] ?? 0) > 0;
          bar.group.visible = pw < 0.995 || laying;
          bar.group.position.set(b.x, b.y + a.headY + 0.45, b.z);
          bar.face(ctx.camera);
          bar.set(pw, pw < 0.2 ? 0xff5a4f : kit.hex(s));
          const au = auras[s];
          const has = (d.shock?.[s] ?? 0) > 0;
          au.visible = has;
          if (has) { au.position.set(b.x, 0.08 + b.y, b.z); const k = 1 + Math.sin(t * 8) * 0.12; au.scale.setScalar(k); au.rotation.y = t * 3; if (Math.random() < 0.3) kit.fx.sparks(b.x, 0.6 + Math.random(), b.z, 0xd9a6ff, 1, 1.5); }
          if (laying && b.y < 0.05 && Math.random() < 0.5) kit.fx.burst(b.x, 0.15, b.z, { shape: 'dot', color: 0x3a3a44, count: 1, speed: 0.6, size: 0.18, life: 0.35, gravity: 2 });
        } else if (b.kind === 'crate') {
          seenC.add(b.id);
          let o = crates.get(b.id);
          if (!o) { o = specialCrate(1.25); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.06 + Math.sin(t * 3 + b.id) * 0.05, b.z);
          o.rotation.y = t * 1.5;
        }
      }
      kit.prune(seen);
      for (const [id, o] of crates) if (!seenC.has(id)) { kit.root.remove(o); crates.delete(id); }

      // kegs
      const seenK = new Set<number>();
      for (const k of d.kegs ?? []) {
        seenK.add(k.id);
        let v = kegs.get(k.id);
        if (!v) { v = makeKeg(k.kind, k.v); kegs.set(k.id, v); }
        const fall = Math.max(0, 1 - k.age / 0.45);
        v.group.position.set(k.x, fall * fall * 9, k.z);
        if (!v.landed && k.age >= 0.45) { v.landed = true; kit.fx.dust(k.x, k.z, 0.9, 0xc9a070); kit.shake(0.05); }
        const lit = k.fuse >= 0;
        v.spark.visible = lit;
        if (lit) {
          const f = Math.floor(t * 18) % 2;
          v.mat.emissive.setHex(f ? 0xff2a10 : 0x000000);
          v.mat.emissiveIntensity = f ? 0.8 : 0;
          v.spark.scale.setScalar(0.7 + Math.random() * 0.5);
          v.group.rotation.z = Math.sin(t * 50) * 0.05;
          v.group.scale.setScalar(1 + (0.5 - Math.max(0, k.fuse)) * 0.18);
          if (Math.random() < 0.7) kit.fx.sparks(k.x + 0.16, 1.7, k.z, [0xffe14a, 0xff8a20], 1, 3);
        } else if (v.kind === 2) { v.mat.emissiveIntensity = 0.5 + Math.sin(t * 5 + k.id) * 0.2; if (Math.random() < 0.03) kit.fx.sparks(k.x + (Math.random() - 0.5), 1.3, k.z + (Math.random() - 0.5), [0xffe14a, 0xffffff], 1, 1.5); }
        v.label.position.y = 2.5 + Math.sin(t * 3 + k.id) * 0.06;
      }
      for (const [id, v] of kegs) if (!seenK.has(id)) { kit.root.remove(v.group); kegs.delete(id); }

      // trails: instanced
      let np = 0, nf = 0;
      for (const tr of d.trails ?? []) {
        for (let i = 0; i < tr.t.length; i++) {
          const tt = tr.t[i];
          if (tt === -2) continue;
          if (tt === -1) {
            if (np >= MAX_NODES) continue;
            tmpP.set(tr.x[i], 0.03, tr.z[i]); tmpQ.identity(); tmpS.set(1, 1, 1);
            powderMesh.setMatrixAt(np++, tmpM.compose(tmpP, tmpQ, tmpS));
          } else {
            if (nf >= MAX_NODES) continue;
            const k = 1 - tt / BURN_LIFE;
            const wob = 0.8 + 0.4 * Math.sin(t * 40 + i * 1.7);
            tmpP.set(tr.x[i], 0.25 + 0.2 * wob * k, tr.z[i]); tmpQ.identity(); tmpS.set(1.1 * k + 0.2, (1.3 * wob + 0.4) * k + 0.2, 1.1 * k + 0.2);
            fireMesh.setMatrixAt(nf, tmpM.compose(tmpP, tmpQ, tmpS));
            fireMesh.setColorAt(nf, tmpC.setHex(k > 0.6 ? 0xffe27a : k > 0.3 ? 0xff9a20 : 0xe04010));
            nf++;
            if (Math.random() < 0.14) kit.fx.burst(tr.x[i], 0.35, tr.z[i], { shape: 'soft', color: [0xff9a20, 0xffe27a], count: 1, speed: 0.8, size: 0.4, life: 0.4, up: 2, gravity: -2 });
            if (tt < 0.06 && Math.random() < 0.4) kit.fx.sparks(tr.x[i], 0.4, tr.z[i], [0xffe14a, 0xffffff], 2, 3);
          }
        }
      }
      powderMesh.count = np; powderMesh.instanceMatrix.needsUpdate = true;
      fireMesh.count = nf; fireMesh.instanceMatrix.needsUpdate = true;
      if (fireMesh.instanceColor) fireMesh.instanceColor.needsUpdate = true;
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'lay':
          fx.dust(e.x, e.z, 0.3, 0x555560);
          break;
        case 'light':
          fx.sparks(e.x, 0.4, e.z, [0xffe14a, 0xff8a20], 8, 4);
          fx.ring(e.x, e.z, { color: 0xffa030, radius: 1.3, life: 0.35 });
          sfx.play('tick', 1.8);
          break;
        case 'ignite':
          fx.sparks(e.x, 1.7, e.z, [0xffe14a, 0xff8a20], 6, 4);
          sfx.play('beep', 1.6);
          break;
        case 'boom': {
          const big = e.o >= 1;
          fx.burst(e.x, 0.9, e.z, { shape: 'soft', color: [0xfff2a0, 0xffa030, 0xff5a20], count: 30, speed: 8, size: 1.1, life: 0.7, up: 3, gravity: 3, grow: 1.6 });
          fx.burst(e.x, 0.8, e.z, { shape: 'chip', color: e.o === 2 ? [0xffe14a, 0xffb000] : e.o === 1 ? [0xe0e8f4, 0x8a96a8] : [0xb9763a, 0x5a3318], count: 16, speed: 7, size: 0.35, life: 1.0, up: 6, gravity: 12 });
          fx.smoke(e.x, 1.1, e.z, 10, 0x3a3a40);
          fx.sparks(e.x, 1, e.z, [0xffe14a, 0xffffff], 14, 9);
          fx.ring(e.x, e.z, { color: 0xffb040, radius: 4.8, life: 0.55 });
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2.8, life: 0.3 });
          if (e.s >= 0) fx.text(e.x, 2.8, e.z, `+${e.v}`, { color: e.o === 2 ? '#ffe14a' : kit.hex(e.s), size: e.v >= 10 ? 2.2 : 1.6, life: 1.3 });
          kit.shake(big ? 0.75 : 0.5);
          sfx.play('boom', big ? 0.8 : 1);
          if (e.o === 2) { fx.confetti(e.x, 1.5, e.z, 24, [0xffe14a, 0xffffff, 0xffb000]); sfx.play('coin', 1.2); }
          break;
        }
        case 'burn':
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff9a20, 0xffe27a], count: 12, speed: 3, size: 0.6, life: 0.6, up: 3, gravity: -1 });
          fx.stars(e.x, 1.4, e.z, 6);
          kit.actorForSlot(e.s)?.hit();
          kit.shake(0.2);
          sfx.play('bad', 1.3);
          break;
        case 'blast':
          kit.actorForSlot(e.s)?.hit();
          fx.stars(e.x, 1.4, e.z, 6);
          break;
        case 'wave':
          fx.ring(e.x, e.z, { color: 0xc77bff, radius: e.v, life: 0.6 });
          fx.ring(e.x, e.z, { color: 0xffffff, radius: e.v * 0.7, life: 0.4 });
          fx.burst(e.x, 0.4, e.z, { shape: 'soft', color: [0xc77bff, 0xffffff], count: 20, speed: e.v * 1.4, size: 0.7, life: 0.6, flat: true, gravity: 0 });
          kit.shake(0.3);
          sfx.play('chaos', 1.3);
          break;
        case 'crate':
          fx.confetti(e.x, 1, e.z, 20);
          fx.text(e.x, 2.5, e.z, 'SHOCKWAVE', { color: '#d9a6ff', size: 1.4, life: 1.3 });
          sfx.play('lucky');
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as KegKaboomData;
      return `${d.score?.[slot] ?? 0}${(d.shock?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      kegs.clear(); crates.clear(); bars.length = 0; auras.length = 0; lanterns.length = 0;
      kit.dispose();
      void ctx; void KK_KEG_R;
    },
  };
}
