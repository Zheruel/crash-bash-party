import * as THREE from 'three';
import { TA_HALF, TA_HP, TA_MAPS } from '../../shared/games/tankArena';
import { createCharacter } from '../characters';
import type { ActorParts } from './kit';
import { canvasTexture, checkerTexture, crateTexture, disposeTree, hasProp, Kit, preloadCatalogFor, propObject } from './kit';
import type { BlobShadow } from '../fx';
import type { ClientMiniGame } from './types';

const H = TA_HALF;

function hazardTexture(): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.fillStyle = '#f2c230'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#26262e';
    for (let i = -2; i < 4; i++) { g.beginPath(); g.moveTo(i * 24, 0); g.lineTo(i * 24 + 14, 0); g.lineTo(i * 24 + 14 + s, s); g.lineTo(i * 24 + s, s); g.fill(); }
  }, [14, 1]);
}

interface TankVis { group: THREE.Group; bar: THREE.Sprite; back: THREE.Sprite; pipGroup: THREE.Group; barrel: THREE.Object3D | null }
type Look = { floorA: string; floorB: string; wall: number; bg: number; block: string; blockDark: string };
const LOOKS: Record<string, Look> = {
  swamp: { floorA: '#4a6a5c', floorB: '#42604f', wall: 0x6a8a6a, bg: 0x10201c, block: '#7a9a78', blockDark: '#3e5a44' },
  desert: { floorA: '#d8b878', floorB: '#cfae6c', wall: 0xb88a50, bg: 0x6a4a2a, block: '#c89a5a', blockDark: '#8a6430' },
  jungle: { floorA: '#4a8a3a', floorB: '#427e34', wall: 0x4a6a3a, bg: 0x0e2a14, block: '#6a7a5a', blockDark: '#3a4a30' },
  metal: { floorA: '#5c6376', floorB: '#505769', wall: 0x8b94aa, bg: 0x161a26, block: '#8a95aa', blockDark: '#4a5468' },
};

function makeTree(): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.6, 8), new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 1 }));
  trunk.position.y = 0.8;
  g.add(trunk);
  const leaf = new THREE.MeshStandardMaterial({ color: 0x2f8a2a, roughness: 0.9, flatShading: true });
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.95 - i * 0.2, 1.1, 9), leaf);
    c.position.y = 1.6 + i * 0.65;
    g.add(c);
  }
  return g;
}

function makeCactus(): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x3a9a4a, roughness: 0.8, flatShading: true });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.9, 8), m);
  body.position.y = 0.95;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.8, 8), m);
  arm.position.set(0.45, 1.3, 0); arm.rotation.z = 0.5;
  const arm2 = arm.clone(); arm2.position.x = -0.45; arm2.rotation.z = -0.5; arm2.position.y = 1.0;
  g.add(body, arm, arm2);
  return g;
}

function makeMine(hex: string): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.22, 16), new THREE.MeshStandardMaterial({ color: 0x2a2c34, roughness: 0.5, metalness: 0.4 }));
  body.position.y = 0.11;
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
  top.position.y = 0.26; top.name = 'light';
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.72, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
  ring.position.y = 0.03;
  g.add(body, top, ring);
  return g;
}

function makeBomb(): THREE.Group {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), new THREE.MeshStandardMaterial({ color: 0x24242c, roughness: 0.4, metalness: 0.5 }));
  const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
  fuse.position.y = 0.55;
  g.add(b, fuse);
  return g;
}

function makePickup(kind: number): THREE.Group {
  const g = new THREE.Group();
  if (kind === 2) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), new THREE.MeshStandardMaterial({ color: 0xf08a1c, roughness: 0.5, emissive: 0x602800, emissiveIntensity: 0.4 }));
    f.position.y = 0.9;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 6), new THREE.MeshStandardMaterial({ color: 0x3a9a2a }));
    leaf.position.y = 1.4;
    g.add(f, leaf);
  } else {
    const m = kind === 3 ? makeBomb() : makeMine('#ffe14a');
    m.position.y = 0.6; m.scale.setScalar(1.3);
    g.add(m);
  }
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.8, depthWrite: false }));
  halo.position.y = 0.04;
  g.add(halo);
  return g;
}

function makeTank(hex: string): { group: THREE.Group; barrel: THREE.Object3D } {
  const g = new THREE.Group();
  const team = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.45, metalness: 0.15 });
  const light = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex).offsetHSL(0, -0.1, 0.15), roughness: 0.4, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23252e, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3b4, roughness: 0.35, metalness: 0.6 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.45, 1.7), team);
  hull.position.y = 0.45;
  const prow = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.5), light);
  prow.position.set(0, 0.38, 0.95); prow.rotation.x = 0.35;
  for (const x of [-1, 1]) {
    const tr = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 1.95), dark);
    tr.position.set(x * 0.68, 0.28, 0);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.36, 12).rotateZ(Math.PI / 2), steel);
    wheel.position.set(x * 0.68, 0.3, 0.8);
    const wheel2 = wheel.clone(); wheel2.position.z = -0.8;
    g.add(tr, wheel, wheel2);
  }
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 0.34, 18), light);
  turret.position.y = 0.88;
  const barrel = new THREE.Group();
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.2, 10).rotateX(Math.PI / 2), steel);
  tube.position.z = 0.65;
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 10).rotateX(Math.PI / 2), dark);
  muzzle.position.z = 1.3;
  barrel.add(tube, muzzle);
  barrel.position.y = 0.9;
  // antenna flag
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6), dark);
  ant.position.set(-0.4, 1.35, -0.6);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), side: THREE.DoubleSide }));
  flag.position.set(-0.4, 1.65, -0.8);
  flag.rotation.y = Math.PI / 2;
  g.add(hull, prow, turret, barrel, ant, flag);
  return { group: g, barrel };
}

export function createTankArenaView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const tanks = new Map<number, TankVis>();
  const shells = new Map<number, { obj: THREE.Group; slot: number }>();
  const lastHp: number[] = [3, 3, 3, 3];
  const objs = new Map<number, THREE.Object3D>();

  function build(variant: string, blocks: number[][]) {
    const R = kit.root;
    const W = H * 2;
    const L = LOOKS[variant] ?? LOOKS.metal;
    const arena = kit.addArena(variant, -0.08);
    if (arena) Kit.clearFootprint(arena, H - 0.4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, W).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: checkerTexture(L.floorA, L.floorB, 2, [W / 4, W / 4]), roughness: 0.85 }));
    R.add(floor);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 1, W + 1.6), new THREE.MeshStandardMaterial({ color: new THREE.Color(L.floorB).multiplyScalar(0.4) }));
    slab.position.y = -0.52;
    R.add(slab);
    if (!arena) {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: L.bg, roughness: 1 }));
      ground.position.y = -1.2;
      R.add(ground);
    }
    // centre cross-hair lines + spawn pads
    const line = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
    for (const [w, d] of [[W, 0.1], [0.1, W]]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), line); l.position.y = 0.01; R.add(l); }
    const c = H - 2;
    [[-c, -c], [c, -c], [-c, c], [c, c]].forEach(([x, z], s) => {
      const col = new THREE.Color(kit.hex(s));
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(3, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, depthWrite: false }));
      pad.position.set(x, 0.02, z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.4, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
      ring.position.set(x, 0.03, z);
      R.add(pad, ring);
    });
    // low walls
    const wallMat = new THREE.MeshStandardMaterial({ color: L.wall, roughness: 0.7 });
    const stripe = new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.7 });
    for (const [x, z, w, d] of [[0, -H - 0.4, W + 1.6, 0.8], [0, H + 0.4, W + 1.6, 0.8], [-H - 0.4, 0, 0.8, W], [H + 0.4, 0, 0.8, W]]) {
      const wl = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, d), wallMat);
      wl.position.set(x, 0.5, z);
      const m = stripe.clone(); m.map = hazardTexture(); m.map.repeat.set(d < w ? 14 : 1, d < w ? 1 : 14);
      const st = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.22, d + 0.02), m);
      st.position.set(x, 0.9, z);
      R.add(wl, st);
    }
    // obstacles (positions from the sim), styled per map
    for (const [cx, cz, hw, hd] of blocks) {
      if (variant === 'jungle') { const t = makeTree(); t.position.set(cx, 0, cz); t.scale.setScalar(Math.max(1, hw * 1.6)); R.add(t); continue; }
      if (variant === 'desert' && hw < 1) { const t = makeCactus(); t.position.set(cx, 0, cz); R.add(t); continue; }
      const mk = (rx: number, ry: number) => {
        const t = crateTexture(L.block, L.blockDark, 'steel');
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(rx, ry);
        return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: variant === 'metal' ? 0.3 : 0 });
      };
      const hgt = variant === 'desert' ? 2.2 : 1.5;
      const mats = [mk(hd * 2 / 1.5, 1), mk(hd * 2 / 1.5, 1), mk(hw * 2 / 1.5, hd * 2 / 1.5), mk(1, 1), mk(hw * 2 / 1.5, 1), mk(hw * 2 / 1.5, 1)];
      const bl = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, hgt, hd * 2), mats);
      bl.position.set(cx, hgt / 2, cz);
      R.add(bl);
    }
    // corner lamps
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2.2, 10), wallMat);
      p.position.set(x * (H + 0.5), 1.1, z * (H + 0.5));
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
      l.position.set(p.position.x, 2.4, p.position.z);
      R.add(p, l);
    }
  }

  function makeParts(slot: number): ActorParts {
    const hex = kit.hex(slot);
    const inst = createCharacter(kit.look(slot), { variant: 'tank', ring: false });
    inst.root.position.set(0, 0.66, -0.1);
    inst.root.scale.setScalar(0.55);
    const vis = new THREE.Group();
    const tank = hasProp('tank') ? (() => {
      const g = new THREE.Group();
      g.add(propObject('tank', 1.9, () => new THREE.Group()));
      return { group: g, barrel: null as THREE.Object3D | null };
    })() : makeTank(hex);
    vis.add(tank.group);
    // team ring under the tank
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.9, depthWrite: false }));
    ring.position.y = 0.03;
    vis.add(ring);
    // health bar (sprites follow the camera)
    const pipGroup = new THREE.Group();
    const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x14141c, depthTest: false, transparent: true, opacity: 0.85 }));
    back.scale.set(1.9, 0.34, 1); back.renderOrder = 40;
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x4ade80, depthTest: false }));
    bar.scale.set(1.8, 0.22, 1); bar.renderOrder = 41; bar.position.z = 0.01;
    pipGroup.add(back, bar);
    kit.root.add(pipGroup);
    tanks.set(slot, { group: vis, bar, back, pipGroup, barrel: tank.barrel });
    return { inst, extra: vis, steady: true, shadow: 1.1, headY: 1.5, scale: 1.15 };
  }

  function makeShell(slot: number): THREE.Group {
    const g = new THREE.Group();
    const col = new THREE.Color(kit.hex(slot));
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
    nose.position.z = 0.2;
    g.add(core, halo, nose);
    return g;
  }

  return {
    id: 'tankArena',
    async preload() { await preloadCatalogFor('tankArena', ['tank']); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'tankArena', { bg: (LOOKS[world.data.variant] ?? LOOKS.metal).bg, fog: [45, 110], hemi: [0xe6ecff, 0x40455a, 1.5] });
      tanks.clear(); shells.clear(); objs.clear(); lastHp.fill(TA_HP);
      const variant: string = world.data.variant ?? 'swamp';
      build(variant, world.data.blocks ?? TA_MAPS[variant] ?? TA_MAPS.swamp);
      ctx.frame(H + 2.6);
      if (!loaded) this.preload!().then(() => { for (const t of tanks.values()) kit.root.remove(t.pipGroup); tanks.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
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
            t.pipGroup.position.set(b.x, 2.5, b.z + 0.1);
            const hp = d.hp?.[b.slot] ?? TA_HP;
            const f = Math.max(0, Math.min(1, hp / TA_HP));
            t.bar.scale.x = 1.8 * f; t.bar.position.x = -0.9 + 0.9 * f;
            (t.bar.material as THREE.SpriteMaterial).color.set(f > 0.5 ? 0x4ade80 : f > 0.25 ? 0xfacc15 : 0xf43f5e);
            // little engine rumble
            const sp = Math.hypot(b.vx, b.vz);
            t.group.position.y = sp > 0.5 ? Math.sin(ctx.time * 40) * 0.012 : 0;
            if (sp > 1 && Math.random() < dt * 8) kit.fx.dust(b.x - Math.sin(b.face) * 0.9, b.z - Math.cos(b.face) * 0.9, 0.3, 0x9a9486);
          }
          a.holder.scale.setScalar(1);
        } else if (b.kind === 'mine' || b.kind === 'pickup' || b.kind === 'bomb') {
          seenObj.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            o = b.kind === 'mine' ? makeMine(kit.hex(b.slot)) : b.kind === 'bomb' ? makeBomb() : makePickup(Math.round(b.cd));
            kit.root.add(o);
            objs.set(b.id, o);
            if (b.kind === 'bomb') o.userData.sh = kit.fx.shadow(0.6, 0.45);
          }
          if (b.kind === 'bomb') {
            o.position.set(b.x, b.y + 0.4, b.z);
            o.rotation.x += dt * 6;
            (o.userData.sh as BlobShadow).set(b.x, b.z, b.y);
            kit.fx.trail(b.x, b.y + 0.4, b.z, 0xffb030, 0.3, 0.3);
          } else if (b.kind === 'mine') {
            o.position.set(b.x, 0, b.z);
            const arming = b.cd > 0;
            const light = o.getObjectByName('light') as THREE.Mesh | undefined;
            if (light) (light.material as THREE.MeshBasicMaterial).color.set(arming ? 0x553030 : Math.sin(ctx.time * 9) > 0 ? 0xff3a2a : 0x661810);
            o.scale.setScalar(arming ? 0.8 : 1);
          } else {
            o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.1, b.z);
            o.rotation.y += dt * 1.5;
          }
        } else if (b.kind === 'bullet') {
          seenShell.add(b.id);
          let s = shells.get(b.id);
          if (!s) { const g = makeShell(b.slot); kit.root.add(g); s = { obj: g, slot: b.slot }; shells.set(b.id, s); }
          s.obj.position.set(b.x, b.y, b.z);
          s.obj.rotation.y = Math.atan2(b.vx, b.vz);
          kit.fx.trail(b.x, b.y, b.z, kit.hex(b.slot), 0.32, 0.28);
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
          const mx = e.x + Math.sin(f) * 1.6, mz = e.z + Math.cos(f) * 1.6;
          fx.sparks(mx, 0.9, mz, [0xfff2a0, 0xffffff, hex], 8, 4);
          fx.burst(mx, 0.9, mz, { shape: 'soft', color: 0xfff2a0, count: 2, speed: 0.5, size: 0.9, life: 0.12, gravity: 0 });
          a?.squash.kick(0.18);
          kit.shake(e.s === ctx.mySlot ? 0.06 : 0.02);
          break;
        }
        case 'bounce':
          fx.sparks(e.x, 0.6, e.z, [0xffe08a, 0xffffff], 6, 3.5);
          break;
        case 'fizzle':
          fx.smoke(e.x, 0.6, e.z, 3, 0x9aa0b0);
          break;
        case 'lob':
          fx.smoke(e.x, 1, e.z, 4, 0x888899);
          fx.text(e.x, 2.6, e.z, 'BOMB!', { color: '#ffb030', size: 0.8, life: 0.8 });
          break;
        case 'mine':
          fx.ring(e.x, e.z, { color: hex, radius: 1.4, life: 0.3 });
          fx.dust(e.x, e.z, 0.4, 0x9a9486);
          break;
        case 'explode': {
          const r = Math.max(1.5, e.v);
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 22, speed: 5, size: 1.0, life: 0.7, up: 3, grow: 1.6 });
          fx.smoke(e.x, 1, e.z, 8, 0x3a3a40);
          fx.sparks(e.x, 0.8, e.z, [0xffe08a, 0xffffff], 14, 8);
          fx.ring(e.x, e.z, { color: 0xffb040, radius: r * 1.2, life: 0.5 });
          kit.shake(0.45);
          break;
        }
        case 'pickup': {
          const t = ['', '+MINES', '+HEALTH', 'BOMB!'][Math.round(e.v)] ?? '';
          fx.stars(e.x, 1.2, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.8, e.z, t, { color: e.v === 2 ? '#7ef08a' : '#ffe14a', size: 0.9, life: 1.1 });
          break;
        }
        case 'hit': {
          fx.sparks(e.x, 0.9, e.z, [0xffe08a, 0xff8a30], 14, 6);
          fx.ring(e.x, e.z, { color: 0xff9a40, radius: 2.2, life: 0.35 });
          fx.text(e.x, 2.4, e.z, `-${Math.max(1, Math.round(e.v * TA_HP))}`, { color: '#ff6a5a', size: 0.9, life: 0.9 });
          kit.actorForSlot(e.s)?.hit(0.8);
          kit.shake(0.3);
          break;
        }
        case 'ko': {
          fx.burst(e.x, 0.9, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 26, speed: 6, size: 1.1, life: 0.8, up: 4, grow: 1.6 });
          fx.smoke(e.x, 1, e.z, 10, 0x2a2a30);
          fx.sparks(e.x, 1, e.z, [0xffe08a, 0xffffff], 18, 8);
          fx.ring(e.x, e.z, { color: 0xffd060, radius: 5, life: 0.7 });
          fx.text(e.x, 2.8, e.z, 'BOOM!', { color: '#ff9a40', size: 1.6, life: 1.4 });
          kit.shake(0.8);
          break;
        }
        case 'spawn':
          fx.ring(e.x, e.z, { color: hex, radius: 2.6, life: 0.6 });
          fx.stars(e.x, 1.2, e.z, 8, [0xffffff, hex]);
          break;
      }
    },

    hud(w, slot) {
      const k = w.data.kills?.[slot] ?? 0;
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'tank' && b.slot === slot && b.alive);
      return alive ? `${hp}/${TA_HP} HP · ${k} kills · ${w.data.mines?.[slot] ?? 0} mines` : `OUT · ${k} kills`;
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

