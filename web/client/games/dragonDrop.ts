// Dragon Drop view: the real clock-tower arena (model 0627): a studded wooden ring turning around a stone hub,
// gears and a huge clock face behind, balloons floating above. Per-character models 0928-0942.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { DD_IN, DD_MAX_AGE, DD_OUT, type DragonDropData } from '../../shared/games/dragonDrop';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { Actor, Kit, catalogInstance, preloadCatalogFor } from './kit';
import { glowTexture, specialCrate, SPECIAL_CRATE_REF } from './partyBits';
import type { ClientMiniGame } from './types';

const BLACK = 0x23202c;
const BANK = (n: number) => `sfx/0179/${n}.mp3`;
const DECOR = ['ddWall', 'ddClock', 'ddHands', 'ddGearA', 'ddGearB', 'ddGearC', 'ddShaft', 'ddArm', 'ddAxle'];
const CHAR_IDS = CHARACTERS.map((c) => 'ddChar_' + c.id);
/** Camera: low front view over the ring toward the clock face (fitted against docs/reference/dragonDrop). */
export const DD_CAM = { pos: [0, 7.4, 16.2] as [number, number, number], look: [0, 2.9, 0] as [number, number, number], fov: 48 };

interface BalloonV { obj: THREE.Group; body: THREE.Mesh; string: THREE.Line; shadow: BlobShadow; slot: number; y: number; x: number; z: number }

export function createDragonDropView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const balloons = new Map<number, BalloonV>();
  const crates = new Map<number, THREE.Object3D>();
  let ringGroup: THREE.Group;
  const hoverFx: THREE.Mesh[] = [];
  const magnetFx: THREE.Mesh[] = [];
  let sphereGeo: THREE.SphereGeometry, knotGeo: THREE.ConeGeometry;
  let ringAngle = 0;
  let arrow: THREE.Mesh;

  function balloonMat(slot: number) {
    const c = new THREE.Color(slot < 0 ? BLACK : kit.hex(slot));
    // flat PS1-style shading like the original balloons (no glossy PBR)
    return new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: slot < 0 ? 0.05 : 0.35, flatShading: true });
  }
  function makeBalloon(slot: number): BalloonV {
    const obj = new THREE.Group();
    const body = new THREE.Mesh(sphereGeo, balloonMat(slot));
    body.scale.set(0.62, 0.78, 0.62);
    const knot = new THREE.Mesh(knotGeo, body.material);
    knot.position.y = -0.8; knot.rotation.x = Math.PI;
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    shine.position.set(-0.2, 0.28, 0.38);
    const sg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.88, 0), new THREE.Vector3(0.05, -1.6, 0.02), new THREE.Vector3(-0.03, -2.3, 0)]);
    const string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xf4efe0, transparent: true, opacity: 0.8 }));
    obj.add(body, knot, shine, string);
    obj.scale.setScalar(0.55); // original balloons are about head-sized next to the riders
    kit.root.add(obj);
    return { obj, body, string, shadow: kit.fx.shadow(0.4, 0.3), slot, y: 0, x: 0, z: 0 };
  }

  function build() {
    const R = kit.root;
    sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    knotGeo = new THREE.ConeGeometry(0.12, 0.2, 8);
    const arena = catalogInstance(getCatalog().arenas.dragonDrop);
    if (arena) R.add(arena.root);
    // clock-tower decor: the game places these object-space pieces around the ring (positions fitted to the real frames)
    const place = (name: string, x: number, y: number, z: number, o: { s?: number; rx?: number; ry?: number; rz?: number } = {}) => {
      const inst = catalogInstance(getCatalog().props[name]);
      if (!inst) return;
      const g = new THREE.Group();
      g.add(inst.root);
      g.position.set(x, y, z); g.scale.setScalar(o.s ?? 1);
      g.rotation.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
      R.add(g);
    };
    place('ddWall', 0, 12.9, -27, { s: 1.4 });
    place("ddClock", 0, 6.3, -22, { s: 1.12 });
    place("ddHands", 0, 6.3, -21.9, { s: 1.12 });
    place('ddGearA', -15, 6, -24);
    place('ddGearB', 15, 8, -24);
    place('ddGearA', 20, -2, -26);
    place('ddGearC', -8, 17, -23, { rx: Math.PI / 2 });
    place('ddAxle', -19, 3.5, -14, { rz: -Math.PI / 2 });
    place('ddArm', 16, 0, -10, { rx: Math.PI / 2 });
    ringGroup = new THREE.Group();
    const ring = catalogInstance(getCatalog().props.ddRing);
    if (ring) ringGroup.add(ring.root);
    R.add(ringGroup);
    arrow = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0, depthWrite: false }));
    arrow.position.set(0, 2.6, DD_OUT + 1.6);
    R.add(arrow);
    for (let s = 0; s < 4; s++) {
      const hv = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.09, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x66e8ff, transparent: true, opacity: 0.9 }));
      hv.visible = false; R.add(hv); hoverFx.push(hv);
      const mg = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(s)), transparent: true, opacity: 0.8, depthWrite: false }));
      mg.visible = false; R.add(mg); magnetFx.push(mg);
    }
  }

  function actor(b: Body): Actor {
    const have = kit.actors.get(b.id);
    if (have) return have;
    const look = kit.look(b.slot);
    const inst = catalogInstance(getCatalog().props['ddChar_' + CHARACTERS[look.char % CHARACTERS.length].id]);
    return inst ? kit.actor(b, () => ({ inst, scale: 1, shadow: 0.9 })) : kit.actor(b);
  }

  const nearestBalloon = (x: number, z: number) => {
    let best: BalloonV | null = null, bd = 0.9;
    for (const v of balloons.values()) { const dd = Math.hypot(v.x - x, v.z - z); if (dd < bd) { bd = dd; best = v; } }
    return best;
  };

  return {
    id: 'dragonDrop',
    async preload() { await preloadCatalogFor('dragonDrop', ['ddRing', 'ddHoverBoots', 'ddMagnet', ...DECOR, ...CHAR_IDS], [SPECIAL_CRATE_REF]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'dragonDrop', { bg: 0x1a1c28, hemi: [0xffffff, 0xc0b0b0, 1.6], sun: [-5, 18, 10] });
      build();
      ctx.camera.fov = DD_CAM.fov; ctx.camera.updateProjectionMatrix();
      void world; void glowTexture;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as DragonDropData;
      const t = ctx.time;
      ctx.scene.background = new THREE.Color(0x1a1c28);
      if (d.ring !== undefined) { ringAngle -= d.ring * dt; ringGroup.rotation.y = ringAngle; }
      const seen = new Set<number>(), seenB = new Set<number>(), seenC = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const hov = (d.hover?.[s] ?? 0) > 0;
          actor(b).update(b, dt, { role: d.stun?.[s] > 0 ? 'hit' : undefined, hop: hov ? 0.35 + Math.sin(t * 6 + s) * 0.06 : 0 });
          const hf = hoverFx[s];
          hf.visible = hov;
          if (hov) { hf.position.set(b.x, b.y + 0.3 + Math.sin(t * 6 + s) * 0.06, b.z); hf.rotation.y = t * 4; hf.scale.setScalar(1 + Math.sin(t * 9) * 0.06); }
          const mf = magnetFx[s];
          const mg = (d.magnet?.[s] ?? 0) > 0;
          mf.visible = mg;
          if (mg) { mf.position.set(b.x, 0.08, b.z); const k = 1 + ((t * 1.4 + s * 0.3) % 1) * 2.2; mf.scale.setScalar(k); (mf.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - (k - 1) / 2.2); }
        } else if (b.kind === 'balloon') {
          seenB.add(b.id);
          let v = balloons.get(b.id);
          if (!v) { v = makeBalloon(b.slot); balloons.set(b.id, v); }
          if (v.slot !== b.slot) {
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
      (arrow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (arrow.material as THREE.MeshBasicMaterial).opacity - dt * 0.8);
      arrow.rotation.y = (d.dir ?? 1) > 0 ? 0 : Math.PI;

      const dv = DD_CAM;
      ctx.camera.position.set(...dv.pos);
      ctx.camera.lookAt(...dv.look);
      if (ctx.camera.fov !== dv.fov) { ctx.camera.fov = dv.fov; ctx.camera.updateProjectionMatrix(); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'pop': {
          const v = nearestBalloon(e.x, e.z);
          const y = v?.y ?? 2.2;
          const col = v ? (v.slot < 0 ? BLACK : new THREE.Color(kit.hex(v.slot)).getHex()) : 0xffffff;
          fx.burst(e.x, y, e.z, { shape: 'chip', color: [col, 0xffffff], count: 16, speed: 4.5, size: 0.3, life: 0.8, gravity: 7 });
          fx.ring(e.x, e.z, { color: col, radius: 1.6, life: 0.3, y });
          sfx.play('pop', e.v ? 1.0 : 0.7);
          sfx.playFile(BANK(11 + (e.s % 4)), 0.4);
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
        case 'crate':
          fx.confetti(e.x, 1, e.z, 20);
          fx.text(e.x, 2.5, e.z, e.v === 1 ? 'HOVER BOOTS' : 'MAGNET', { color: '#9ff0ff', size: 1.3, life: 1.3 });
          sfx.play('lucky');
          break;
        case 'punch':
          if (e.v === 2) {
            fx.stars(e.x, 1.3, e.z, 8);
            kit.actorForSlot(e.s)?.hit();
            kit.shake(0.25);
            sfx.play('thud');
          } else { fx.ring(e.x, e.z, { color: 0xffffff, radius: 1.4, life: 0.25 }); sfx.play('whoosh', 1.4); }
          break;
        case 'fade':
          fx.sparks(e.x, 6, e.z, 0xffffff, 4, 2);
          break;
      }
      void ctx;
    },

    hud(w, slot) {
      const d = w.data as DragonDropData;
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}${(d.hover?.[slot] ?? 0) > 0 ? ' ▲' : ''}${(d.magnet?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      for (const v of balloons.values()) kit.fx.removeShadow(v.shadow);
      balloons.clear(); crates.clear();
      hoverFx.length = 0; magnetFx.length = 0;
      ringAngle = 0;
      kit.dispose();
      void ctx; void DD_IN;
    },
  };
}
