import * as THREE from 'three';
import { TA_HP, TA_K, TA_MAPS } from '../../shared/games/tankArena';
import { createCharacter } from '../characters';
import type { ActorParts } from './kit';
import { canvasTexture, catalogInstance, disposeTree, hasProp, Kit, makeCrate, preloadCatalogFor, propObject } from './kit';
import { getCatalog } from '../crash';
import type { BlobShadow } from '../fx';
import type { ClientMiniGame } from './types';

/**
 * Tank Wars view. The four pens are the real Crash Bash stages (assets/stages/tankArena.json, scale TA_K, centred on
 * the origin) seen from the real fixed camera: a high fixed three-quarter view of the whole pen, fitted per level
 * against the original frames (camera in stage model units relative to the pen centre).
 */

interface Cam { p: [number, number, number]; pitch: number; fov: number }
interface Look { bg: number; fog?: [number, number]; tank: number; tint: [number, number, number] }
/** model-unit camera, relative to the pen centre (multiplied by TA_K below) */
const CAMS: Record<string, Cam> = {
  metal: { p: [0.043, 3.067, 4.642], pitch: 32.83, fov: 40.66 },
  desert: { p: [0.027, 3.56, 4.665], pitch: 37.54, fov: 38.64 },
  jungle: { p: [-0.146, 2.749, 3.876], pitch: 35.81, fov: 53.46 },
  swamp: { p: [-0.1, 2.749, 4.08], pitch: 35.81, fov: 53.46 },
};
const LOOKS: Record<string, Look> = {
  swamp: { bg: 0x08140d, tank: 0x8e969a, tint: [1, 1, 1] },
  desert: { bg: 0xd6b878, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
  jungle: { bg: 0x030a05, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
  metal: { bg: 0x0a0d18, tank: 0x6aa63a, tint: [0.62, 1, 0.5] },
};

interface TankVis { group: THREE.Group; bar: THREE.Sprite; back: THREE.Sprite; pipGroup: THREE.Group }

function plankTexture(base: string, dark: string): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = dark;
    for (let i = 0; i < 12; i++) g.fillRect(0, (i * s) / 12 + ((i * 7) % 5), s, 1 + (i % 2));
    for (let i = 0; i < 10; i++) g.fillRect((i * 37) % s, 0, 1, s);
  }, [1, 1]);
}

/** Swamp Fox: no stage model was extracted, so build it from the original frames: black water pit, wooden fence, forest wall. */
function buildSwamp(R: THREE.Group, hx: number, hz: number) {
  const pit = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2 + 9, hz * 2 + 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x010403 }));
  pit.position.y = -0.04;
  R.add(pit);
  // sunken muddy bank outside the fence
  const bank = new THREE.Mesh(new THREE.PlaneGeometry(90, 60).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b1a10 }));
  bank.position.set(0, -0.5, -22);
  R.add(bank);
  const wood = new THREE.MeshBasicMaterial({ map: plankTexture('#6b5a45', '#33281c') });
  const moss = new THREE.MeshBasicMaterial({ color: 0x3d5a34 });
  const fx = hx + 0.5, fz = hz + 0.5;
  const post = (x: number, z: number, h: number, lean: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.2), wood);
    m.position.set(x, h / 2 - 0.1, z); m.rotation.z = lean; m.rotation.x = lean * 0.6;
    R.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.24), moss);
    cap.position.set(x, h - 0.12, z);
    R.add(cap);
  };
  const rail = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.12), wood);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    R.add(m);
  };
  const side = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.1));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      post(x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, 1.1 + ((i * 37) % 5) * 0.06, (((i * 13) % 7) - 3) * 0.02);
    }
    rail(x0, z0, x1, z1, 0.55);
    rail(x0, z0, x1, z1, 0.9);
  };
  side(-fx, -fz, fx, -fz); side(fx, -fz, fx, fz); side(fx, fz, -fx, fz); side(-fx, fz, -fx, -fz);
  // forest wall: thick mossy trunks, hanging green mist
  const bark = new THREE.MeshBasicMaterial({ map: canvasTexture(64, (g, s) => {
    g.fillStyle = '#2d3a22'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) { g.fillStyle = i % 3 ? '#1d2616' : '#4a5a30'; g.fillRect((i * 29) % s, 0, 2 + (i % 3), s); }
  }, [2, 3]) });
  for (let i = 0; i < 16; i++) {
    const x = -22 + i * 3 + ((i * 7) % 5) * 0.4, z = -hz - 6 - ((i * 5) % 4) * 1.4;
    const r = 0.9 + ((i * 3) % 4) * 0.35;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, 22, 8), bark);
    t.position.set(x, 8, z);
    R.add(t);
  }
  const mist = new THREE.Mesh(new THREE.PlaneGeometry(80, 10), new THREE.MeshBasicMaterial({ color: 0x1f4a2a, transparent: true, opacity: 0.5, depthWrite: false }));
  mist.position.set(0, 3, -hz - 5.2);
  R.add(mist);
}

/** Procedural pen used only when the catalog stage is missing */
function buildFallback(R: THREE.Group, hx: number, hz: number, variant: string) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: variant === 'desert' ? 0xcaa868 : variant === 'jungle' ? 0x6a5a30 : 0x3a4254 }));
  R.add(floor);
  for (const [x, z, w, d] of [[0, -hz - 0.15, hx * 2 + 0.6, 0.3], [0, hz + 0.15, hx * 2 + 0.6, 0.3], [-hx - 0.15, 0, 0.3, hz * 2], [hx + 0.15, 0, 0.3, hz * 2]]) {
    const wl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), new THREE.MeshBasicMaterial({ color: 0x6a6f7e }));
    wl.position.set(x, 0.35, z);
    R.add(wl);
  }
  for (const [cx, cz, hw, hd] of TA_MAPS[variant].blocks) {
    const c = makeCrate(1, 'steel');
    c.scale.set(hw * 2, 0.5, hd * 2);
    c.position.set(cx, 0, cz);
    R.add(c);
  }
}

/** Spiked ball mine (the real mines are black balls with spikes) */
function makeMine(hex: string): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshBasicMaterial({ color: 0x2a2c34 }));
  body.position.y = 0.26;
  g.add(body);
  const spike = new THREE.ConeGeometry(0.06, 0.18, 5);
  const sm = new THREE.MeshBasicMaterial({ color: 0x6a6e7a });
  const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.7, 0, 0.7], [-0.7, 0, -0.7], [0.7, 0, -0.7], [-0.7, 0, 0.7]];
  for (const d of dirs) {
    const s = new THREE.Mesh(spike, sm);
    const v = new THREE.Vector3(...d).normalize();
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    s.position.copy(v).multiplyScalar(0.27).add(new THREE.Vector3(0, 0.26, 0));
    g.add(s);
  }
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
  top.position.y = 0.5; top.name = 'light';
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
  ring.position.y = 0.02;
  g.add(top, ring);
  return g;
}

function makeBomb(): THREE.Group {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 12), new THREE.MeshBasicMaterial({ color: 0x24242c }));
  const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
  fuse.position.y = 0.36;
  g.add(b, fuse);
  return g;
}

function makePickup(kind: number): THREE.Group {
  const g = new THREE.Group();
  if (kind === 2) { // wumpa fruit
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), new THREE.MeshBasicMaterial({ color: 0xf0801c }));
    f.position.y = 0.55;
    f.scale.y = 1.12;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 6), new THREE.MeshBasicMaterial({ color: 0x3a9a2a }));
    leaf.position.y = 0.95;
    g.add(f, leaf);
  } else {
    const m = kind === 3 ? makeBomb() : makeMine('#ffe14a');
    m.position.y = 0.3; m.scale.setScalar(1.25);
    g.add(m);
  }
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.58, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.8, depthWrite: false }));
  halo.position.y = 0.03;
  g.add(halo);
  return g;
}

/** Fallback hover tank when the catalog model is missing, also used for the Swamp Fox airboat look */
function makeTank(hex: number, boat: boolean): THREE.Group {
  const g = new THREE.Group();
  const team = new THREE.MeshBasicMaterial({ color: hex });
  const dark = new THREE.MeshBasicMaterial({ color: 0x23252e });
  const steel = new THREE.MeshBasicMaterial({ color: 0xa8b0bc });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.34, 1.5), team);
  hull.position.y = 0.3;
  g.add(hull);
  if (boat) {
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.4), team); bow.position.set(0, 0.26, 0.85); bow.rotation.x = -0.3;
    const fan = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 14), steel); fan.position.set(0, 0.75, -0.7);
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12).rotateX(Math.PI / 2), dark); cage.position.set(0, 0.75, -0.72);
    g.add(bow, fan, cage);
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 8).rotateX(Math.PI / 2), steel);
  barrel.position.set(0, 0.62, 0.75);
  g.add(barrel);
  return g;
}

export function createTankArenaView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'swamp';
  const tanks = new Map<number, TankVis>();
  const shells = new Map<number, { obj: THREE.Group; slot: number }>();
  const lastHp: number[] = [3, 3, 3, 3];
  const objs = new Map<number, THREE.Object3D>();

  function build(world: { data: Record<string, any> }) {
    const R = kit.root;
    const { hx, hz } = world.data;
    if (variant === 'swamp') { buildSwamp(R, hx, hz); return; }
    const arena = kit.addArena(variant, 0);
    if (!arena) buildFallback(R, hx, hz, variant);
    if (variant === 'jungle') { // leaf sprays dotted round the clearing (the stage file keeps them at the origin)
      const ref = getCatalog().props['tankArena.foliage'];
      const spots: [number, number, number, number][] = [[-3.0, -2.2, 0.4, 0.5], [-2.0, -3.1, 1.2, 0.8], [0.3, -3.2, 2.4, 0.7], [2.2, -3.1, 3.6, 0.8], [3.6, -1.9, 4.5, 0.6], [-3.4, 0.2, 5.5, 0.7], [3.7, 1.2, 0.9, 0.6], [-3.1, 2.4, 2.1, 0.6]];
      for (const [x, z, yaw, sc] of spots) {
        const f = catalogInstance(ref);
        if (!f) break;
        f.root.position.set(x * TA_K, 0.15, z * TA_K);
        f.root.rotation.y = yaw;
        f.root.scale.setScalar(sc);
        R.add(f.root);
      }
    }
  }

  function makeParts(slot: number): ActorParts {
    const hex = kit.hex(slot);
    const L = LOOKS[variant] ?? LOOKS.metal;
    const inst = createCharacter(kit.look(slot), { variant: 'tank', ring: false });
    inst.root.position.set(0, 0.42, -0.1);
    inst.root.scale.setScalar(0.9);
    const vis = new THREE.Group();
    const real = hasProp('tankArena.tank') && variant !== 'swamp';
    let body: THREE.Object3D;
    if (real) {
      body = propObject('tankArena.tank', 1.65, () => new THREE.Group());
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !L.tint) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const q of mats) (q as THREE.MeshBasicMaterial).color?.setRGB(...L.tint);
      });
    } else body = makeTank(L.tank, variant === 'swamp');
    vis.add(body);
    // team ring under the tank
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 0.95, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
    ring.position.y = 0.03;
    vis.add(ring);
    // health bar (sprites follow the camera)
    const pipGroup = new THREE.Group();
    const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x14141c, depthTest: false, transparent: true, opacity: 0.85 }));
    back.scale.set(1.5, 0.28, 1); back.renderOrder = 40;
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x4ade80, depthTest: false }));
    bar.scale.set(1.4, 0.18, 1); bar.renderOrder = 41; bar.position.z = 0.01;
    pipGroup.add(back, bar);
    kit.root.add(pipGroup);
    tanks.set(slot, { group: vis, bar, back, pipGroup });
    return { inst, extra: vis, steady: true, shadow: 0.9, headY: 1.3, scale: 1 };
  }

  function makeShell(slot: number): THREE.Group {
    const g = new THREE.Group();
    const col = new THREE.Color(kit.hex(slot));
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
    g.add(core, halo);
    return g;
  }

  function aim(ctx: { camera: THREE.PerspectiveCamera }) {
    const c = CAMS[variant] ?? CAMS.metal;
    const cam = ctx.camera;
    const pr = (c.pitch * Math.PI) / 180;
    cam.position.set(c.p[0] * TA_K, c.p[1] * TA_K, c.p[2] * TA_K);
    cam.lookAt(c.p[0] * TA_K, (c.p[1] - Math.sin(pr) * 10) * TA_K, (c.p[2] - Math.cos(pr) * 10) * TA_K);
    if (Math.abs(cam.fov - c.fov) > 1e-3) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
  }

  return {
    id: 'tankArena',
    async preload() { await preloadCatalogFor('tankArena', ['tankArena.tank', 'tank']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'swamp';
      const L = LOOKS[variant] ?? LOOKS.metal;
      kit = new Kit(ctx, 'tankArena', { bg: L.bg, hemi: [0xffffff, 0xffffff, 1.2] });
      tanks.clear(); shells.clear(); objs.clear(); lastHp.fill(TA_HP);
      build(world);
      aim(ctx);
      if (!loaded) this.preload!().then(() => { for (const t of tanks.values()) kit.root.remove(t.pipGroup); tanks.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      aim(ctx);
      kit.checkOver(w);
      const d = w.data;
      const seen = new Set<number>();
      const seenShell = new Set<number>();
      const seenObj = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'tank') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const inv = (d.inv?.[b.slot] ?? 0) > 0;
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { hidden: !b.alive, blink: inv, role: kit.over.done ? undefined : stun ? 'hit' : 'idle', freeze: true });
          const t = tanks.get(b.slot);
          if (t) {
            t.pipGroup.visible = b.alive && !kit.over.done;
            t.pipGroup.position.set(b.x, 1.9, b.z + 0.1);
            const hp = d.hp?.[b.slot] ?? TA_HP;
            const f = Math.max(0, Math.min(1, hp / TA_HP));
            t.bar.scale.x = 1.4 * f; t.bar.position.x = -0.7 + 0.7 * f;
            (t.bar.material as THREE.SpriteMaterial).color.set(f > 0.5 ? 0x4ade80 : f > 0.25 ? 0xfacc15 : 0xf43f5e);
            const sp = Math.hypot(b.vx, b.vz);
            t.group.position.y = 0.04 + Math.sin(ctx.time * 6 + b.slot) * 0.02 + (sp > 0.5 ? Math.sin(ctx.time * 40) * 0.01 : 0);
            if (sp > 1 && Math.random() < dt * 8) kit.fx.dust(b.x - Math.sin(b.face) * 0.6, b.z - Math.cos(b.face) * 0.6, 0.2, variant === 'swamp' ? 0x3a5a48 : 0x9a9486);
          }
          a.holder.scale.setScalar(1);
        } else if (b.kind === 'mine' || b.kind === 'pickup' || b.kind === 'bomb') {
          seenObj.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'mine' ? makeMine(kit.hex(b.slot)) : b.kind === 'bomb' ? makeBomb() : makePickup(Math.round(b.cd));
            kit.root.add(o);
            objs.set(b.id, o);
            if (b.kind === 'bomb') o.userData.sh = kit.fx.shadow(0.4, 0.45);
          }
          if (b.kind === 'bomb') {
            o.position.set(b.x, b.y + 0.4, b.z);
            o.rotation.x += dt * 6;
            (o.userData.sh as BlobShadow).set(b.x, b.z, b.y);
            kit.fx.trail(b.x, b.y + 0.4, b.z, 0xffb030, 0.2, 0.3);
          } else if (b.kind === 'mine') {
            o.position.set(b.x, 0, b.z);
            const arming = b.cd > 0;
            const light = o.getObjectByName('light') as THREE.Mesh | undefined;
            if (light) (light.material as THREE.MeshBasicMaterial).color.set(arming ? 0x553030 : Math.sin(ctx.time * 9) > 0 ? 0xff3a2a : 0x661810);
            o.scale.setScalar(arming ? 0.8 : 1);
          } else {
            o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.06, b.z);
            o.rotation.y += dt * 1.5;
          }
        } else if (b.kind === 'bullet') {
          seenShell.add(b.id);
          let s = shells.get(b.id);
          if (!s) { const g = makeShell(b.slot); kit.root.add(g); s = { obj: g, slot: b.slot }; shells.set(b.id, s); }
          s.obj.position.set(b.x, b.y, b.z);
          s.obj.rotation.y = Math.atan2(b.vx, b.vz);
          kit.fx.trail(b.x, b.y, b.z, kit.hex(b.slot), 0.22, 0.28);
        }
      }
      kit.prune(seen);
      for (const [id, s] of shells) if (!seenShell.has(id)) { kit.root.remove(s.obj); disposeTree(s.obj); shells.delete(id); }
      for (const [id, o] of objs) if (!seenObj.has(id)) { kit.root.remove(o); disposeTree(o); if (o.userData.sh) kit.fx.removeShadow(o.userData.sh); objs.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const hex = e.s >= 0 ? kit.hex(e.s) : 0xffffff;
      switch (e.k) {
        case 'shoot': {
          const a = kit.actorForSlot(e.s);
          const f = a?.face ?? 0;
          const mx = e.x + Math.sin(f) * 1.1, mz = e.z + Math.cos(f) * 1.1;
          fx.sparks(mx, 0.7, mz, [0xfff2a0, 0xffffff, hex], 6, 3);
          fx.burst(mx, 0.7, mz, { shape: 'soft', color: 0xfff2a0, count: 2, speed: 0.4, size: 0.6, life: 0.12, gravity: 0 });
          a?.squash.kick(0.12);
          kit.shake(e.s === ctx.mySlot ? 0.05 : 0.015);
          break;
        }
        case 'bounce':
          fx.sparks(e.x, 0.5, e.z, [0xffe08a, 0xffffff], 5, 2.5);
          break;
        case 'fizzle':
          fx.smoke(e.x, 0.5, e.z, 3, 0x9aa0b0);
          break;
        case 'lob':
          fx.smoke(e.x, 0.8, e.z, 4, 0x888899);
          fx.text(e.x, 1.9, e.z, 'BOMB!', { color: '#ffb030', size: 0.6, life: 0.8 });
          break;
        case 'mine':
          fx.ring(e.x, e.z, { color: hex, radius: 0.9, life: 0.3 });
          fx.dust(e.x, e.z, 0.3, 0x9a9486);
          break;
        case 'explode': {
          const r = Math.max(1, e.v);
          fx.burst(e.x, 0.6, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 20, speed: 3.5, size: 0.8, life: 0.7, up: 2.5, grow: 1.6 });
          fx.smoke(e.x, 0.8, e.z, 7, 0x3a3a40);
          fx.sparks(e.x, 0.6, e.z, [0xffe08a, 0xffffff], 12, 6);
          fx.ring(e.x, e.z, { color: 0xffb040, radius: r * 1.2, life: 0.5 });
          kit.shake(0.35);
          break;
        }
        case 'pickup': {
          const t = ['', '+MINES', '+HEALTH', 'BOMB!'][Math.round(e.v)] ?? '';
          fx.stars(e.x, 0.9, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.0, e.z, t, { color: e.v === 2 ? '#7ef08a' : '#ffe14a', size: 0.7, life: 1.1 });
          break;
        }
        case 'hit': {
          fx.sparks(e.x, 0.7, e.z, [0xffe08a, 0xff8a30], 12, 5);
          fx.ring(e.x, e.z, { color: 0xff9a40, radius: 1.5, life: 0.35 });
          fx.text(e.x, 1.9, e.z, `-${Math.max(1, Math.round(e.v * TA_HP))}`, { color: '#ff6a5a', size: 0.7, life: 0.9 });
          kit.actorForSlot(e.s)?.hit(0.8);
          kit.shake(0.25);
          break;
        }
        case 'ko': {
          fx.burst(e.x, 0.7, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 24, speed: 4.5, size: 0.9, life: 0.8, up: 3, grow: 1.6 });
          fx.smoke(e.x, 0.8, e.z, 9, 0x2a2a30);
          fx.sparks(e.x, 0.8, e.z, [0xffe08a, 0xffffff], 16, 7);
          fx.ring(e.x, e.z, { color: 0xffd060, radius: 3.5, life: 0.7 });
          fx.text(e.x, 2.2, e.z, 'BOOM!', { color: '#ff9a40', size: 1.2, life: 1.4 });
          kit.shake(0.7);
          break;
        }
        case 'spawn':
          fx.ring(e.x, e.z, { color: hex, radius: 1.8, life: 0.6 });
          fx.stars(e.x, 0.9, e.z, 8, [0xffffff, hex]);
          break;
      }
    },

    hud(w, slot) {
      const k = w.data.kills?.[slot] ?? 0;
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'tank' && b.slot === slot && b.alive);
      return alive ? `${hp}/${TA_HP} HP · ${k} kills · ${w.data.mines?.[slot] ?? 0} mines${(w.data.bomb?.[slot] ?? 0) > 0 ? ` · ${w.data.bomb[slot]} bombs` : ''}` : `OUT · ${k} kills`;
    },

    dispose() {
      for (const t of tanks.values()) kit.root.remove(t.pipGroup);
      for (const o of objs.values()) { kit.root.remove(o); if (o.userData.sh) kit.fx.removeShadow(o.userData.sh); }
      objs.clear();
      tanks.clear();
      for (const s of shells.values()) kit.root.remove(s.obj);
      shells.clear();
      kit.dispose();
    },
  };
}
