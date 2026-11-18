// Keg Kaboom view: the real village yard (model 0609: dirt ring inside a low stone wall, houses and windmill on the hills),
// real powder kegs (pack 0738) and the per-character barrel-carrier models (864-878). Fixed camera fitted against the real
// game (docs/reference/kegKaboom).
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { KK_KEG_R, POWDER_MAX, type KegKaboomData } from '../../shared/games/kegKaboom';
import { createCharacter } from '../characters';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { Bar3D, glowTexture } from './partyBits';
import type { ClientMiniGame } from './types';

const S = 3.398;
const BURN_LIFE = 0.5;
const MAX_NODES = 1000;
/** Real kegs are drawn about 1.45x the raw model size (measured against the disc frame). */
const KEG_SCALE = 1.45;

/** Camera fitted to the real frame (image-difference search), arena recentred on its floor: sim units. */
export const KK_CAM = { pos: [1.2, 9.552, 17.82] as [number, number, number], look: [1.204, 1.688, -0.508] as [number, number, number], fov: 43.76, aspect: 4 / 3 };

/** Sky card (sunset gradient with the sun) hung far behind the hills. */
const SKY = { pos: [18, 3, -70] as [number, number, number], k: 2.6 };
const KEG_PROPS = ['kkBarrel', 'kkBarrelB', 'kkBarrelGold', 'kkBarrelSilver'];
const PROPS = [...KEG_PROPS, 'kkCrate', 'kkBlades', 'kkMill', 'kkSky', 'kkFlash', 'kkPuff', 'kkPuff2', 'kkComet', 'kkRing', 'kkSparks', 'kkDiamond', 'kkBolt', 'kkRingW', 'kkDebris', 'kkDebris2', 'kkShard', 'kkShard2', ...CHARACTERS.map((c) => 'kkCarry_' + c.id)];

/** Level sound bank 0177 (guessed from durations / levels): long blasts, short fuse ticks. */
const BANK = (n: number) => `sfx/0177/${n}.mp3`;

interface KegV { group: THREE.Group; body: THREE.Object3D; spark: THREE.Sprite; kind: number; landed: boolean }

export function createKegKaboomView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let built: THREE.Group;
  const kegs = new Map<number, KegV>();
  const crates = new Map<number, THREE.Object3D>();
  const bars: Bar3D[] = [];
  const auras: THREE.Mesh[] = [];
  let powderMesh: THREE.InstancedMesh, fireMesh: THREE.InstancedMesh;
  const blades: THREE.Object3D[] = [];
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  let glow: THREE.CanvasTexture;

  const prop = (name: string, scale = 1): THREE.Object3D | null => {
    const inst = catalogInstance(getCatalog().props[name]);
    if (!inst) return null;
    inst.root.scale.multiplyScalar(scale);
    return inst.root;
  };

  function fallbackKeg(kind: number): THREE.Object3D {
    const col = kind === 2 ? 0xffcf3a : kind === 1 ? 0xb8c4dc : 0x8a5a2a;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.5, 14), new THREE.MeshStandardMaterial({ color: col }));
    m.position.y = 0.75;
    const g = new THREE.Group();
    g.add(m);
    return g;
  }

  function makeKeg(kind: number, id: number): KegV {
    const group = new THREE.Group();
    const name = kind === 2 ? 'kkBarrelGold' : kind === 1 ? 'kkBarrelSilver' : id % 3 === 0 ? 'kkBarrelB' : 'kkBarrel';
    const body = prop(name, KEG_SCALE) ?? fallbackKeg(kind);
    const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffa030, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    spark.userData.keepMap = true;
    spark.scale.setScalar(0.9); spark.position.set(0.1, 1.9, 0); spark.visible = false;
    group.add(body, spark);
    kit.root.add(group);
    return { group, body, spark, kind, landed: false };
  }

  function build() {
    built = new THREE.Group();
    kit.root.add(built);
    const R = built;
    glow = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    const arena = catalogInstance(getCatalog().arenas.kegKaboom);
    if (arena) R.add(arena.root);
    blades.length = 0;
    // windmill on the far-left hill (placed by overlaying on the real frame) and the sky card behind everything
    const MILL: [number, number, number] = [-13.1, 3.1, -14.6], MILL_K = 0.55;
    const mill = prop('kkMill', MILL_K);
    if (mill) { mill.position.set(...MILL); R.add(mill); }
    blades.length = 0;
    const sails = prop('kkBlades', MILL_K);
    if (sails) { sails.position.set(MILL[0], MILL[1] + 1.35 * MILL_K * S, MILL[2] + 0.12 * MILL_K * S); R.add(sails); blades.push(sails); }
    const sky = prop('kkSky', SKY.k);
    if (sky) { sky.position.set(...SKY.pos); R.add(sky); }

    // ---- trail instancing
    powderMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.27, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2a2018 }), MAX_NODES);
    powderMesh.frustumCulled = false; powderMesh.count = 0;
    fireMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_NODES);
    fireMesh.frustumCulled = false; fireMesh.count = 0;
    fireMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3), 3);
    R.add(powderMesh, fireMesh);

    // ---- per-player gauge + shockwave aura
    bars.length = 0; auras.length = 0;
    for (let s = 0; s < 4; s++) {
      const b = new Bar3D(1.5, 0.16, kit.hex(s));
      b.group.visible = false;
      R.add(b.group); bars.push(b);
      const au = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc77bff, transparent: true, opacity: 0.85, depthWrite: false }));
      au.visible = false; R.add(au); auras.push(au);
    }
  }

  function placeCamera(ctx: { camera: THREE.PerspectiveCamera }) {
    const cam = ctx.camera;
    const tv = Math.tan((KK_CAM.fov * Math.PI) / 360);
    const fov = cam.aspect < KK_CAM.aspect ? (2 * Math.atan(tv * (KK_CAM.aspect / cam.aspect)) * 180) / Math.PI : KK_CAM.fov;
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.position.set(...KK_CAM.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(...KK_CAM.look);
  }

  return {
    id: 'kegKaboom',
    async preload() { await preloadCatalogFor('kegKaboom', PROPS); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'kegKaboom', { bg: 0x000000, hemi: [0xfff4e0, 0x8a7a5a, 1.5], sun: [8, 18, 6] });
      build();
      placeCamera(ctx);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); for (const v of kegs.values()) kit.root.remove(v.group); kegs.clear(); kit.root.remove(built); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as KegKaboomData;
      const t = ctx.time;
      blades.forEach((o) => { o.rotation.z = t * 0.6; });

      const seen = new Set<number>(), seenC = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const a = kit.actor(b, () => {
            const id = CHARACTERS[kit.look(s).char % CHARACTERS.length].id;
            const inst = catalogInstance(getCatalog().props['kkCarry_' + id]);
            return inst ? { inst, scale: 1, headY: 1.5, shadow: 0.95 } : { inst: createCharacter(kit.look(s), { ring: false }) };
          });
          const laying = (d.laying?.[s] ?? 0) > 0;
          a.update(b, dt, { role: (d.stun?.[s] ?? 0) > 0 ? 'hit' : undefined, blink: (d.invul?.[s] ?? 0) > 0 && (d.stun?.[s] ?? 0) <= 0 });
          const bar = bars[s];
          const pw = (d.powder?.[s] ?? POWDER_MAX) / POWDER_MAX;
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
          if (!o) { o = prop('kkCrate', 1.5) ?? new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a3fd6 })); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.05 + Math.sin(t * 3 + b.id) * 0.04, b.z);
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
        if (!v) { v = makeKeg(k.kind, k.id); kegs.set(k.id, v); }
        const fall = Math.max(0, 1 - k.age / 0.45);
        v.group.position.set(k.x, fall * fall * 9, k.z);
        if (!v.landed && k.age >= 0.45) { v.landed = true; kit.fx.dust(k.x, k.z, 0.9, 0xc9a070); kit.shake(0.05); }
        const lit = k.fuse >= 0;
        v.spark.visible = lit;
        v.group.rotation.set(0, 0, 0);
        v.group.scale.setScalar(1);
        if (lit) {
          v.spark.scale.setScalar(0.7 + Math.random() * 0.5);
          v.group.rotation.z = Math.sin(t * 50) * 0.05;
          v.group.scale.setScalar(1 + (0.5 - Math.max(0, k.fuse)) * 0.18);
          if (Math.random() < 0.7) kit.fx.sparks(k.x + 0.1, 1.9, k.z, [0xffe14a, 0xff8a20], 1, 3);
        } else if (v.kind === 2 && Math.random() < 0.03) kit.fx.sparks(k.x + (Math.random() - 0.5), 1.3, k.z + (Math.random() - 0.5), [0xffe14a, 0xffffff], 1, 1.5);
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
      placeCamera(ctx);
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
          if (!sfx.playFile(BANK(16), 0.5)) sfx.play('tick', 1.8);
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
          if (e.s >= 0) fx.text(e.x, 2.8, e.z, `${e.v}`, { color: e.o === 2 ? '#ffe14a' : '#ff9a2a', size: e.v >= 10 ? 2.2 : 1.6, life: 1.3 });
          kit.shake(big ? 0.75 : 0.5);
          if (!sfx.playFile(BANK(e.v >= 10 ? 13 : 5 + (e.v >> 1) % 4), 0.8)) sfx.play('boom', big ? 0.8 : 1);
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
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}${(d.shock?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      kegs.clear(); crates.clear(); bars.length = 0; auras.length = 0; blades.length = 0;
      kit.dispose();
      void ctx; void KK_KEG_R;
    },
  };
}
