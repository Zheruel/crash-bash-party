// CRATE CRUSH view (shared/games/crateToss.ts): wood / TNT / Nitro crates, health bars, last one standing.
import * as THREE from 'three';
import { CT_FLOOR_N, CT_HALF, CT_HP } from '../../shared/games/crateToss';
import type { BlobShadow } from '../fx';
import { checkerTexture, disposeTree, HpBar, Kit, makeCrate, preloadCatalogFor, propObject, TextSprite } from './kit';
import type { ClientMiniGame } from './types';

const H = CT_HALF;
const TILE = (H * 2) / CT_FLOOR_N;

const LOOKS: Record<string, { a: string; b: string; bg: number; wall: number; trim: number }> = {
  jungle: { a: '#e0c183', b: '#d2b072', bg: 0x1d4a3a, wall: 0xa8957a, trim: 0xff8a2a },
  space: { a: '#6a7090', b: '#5a6080', bg: 0x080818, wall: 0x4a5070, trim: 0x6ad0ff },
  snow: { a: '#eef6ff', b: '#d6e8f8', bg: 0x7aa8d0, wall: 0xc8d8ea, trim: 0x6ab0ff },
  drain: { a: '#7a8a6a', b: '#6c7c5c', bg: 0x1a2a1a, wall: 0x6a7a5a, trim: 0x9aff3a },
};

interface Vis { obj: THREE.Object3D; shadow: BlobShadow; glow: THREE.Mesh; kind: string; fuse?: TextSprite }

export function createCrateTossView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'jungle';
  const crates = new Map<number, Vis>();
  const items = new Map<number, THREE.Object3D>();
  const bars = new Map<number, HpBar>();
  const tiles: (THREE.Mesh | null)[] = [];
  const starT = new Map<number, number>();

  function build() {
    const R = kit.root;
    const W = H * 2;
    const L = LOOKS[variant] ?? LOOKS.jungle;
    const arena = kit.addArena(variant, -0.08);
    if (arena) Kit.clearFootprint(arena, H - 0.4);
    if (variant === 'space') {
      const m = new THREE.MeshStandardMaterial({ map: checkerTexture(L.a, L.b, 2, [1, 1]), roughness: 0.8 });
      const g = new THREE.BoxGeometry(TILE * 0.98, 0.5, TILE * 0.98);
      for (let i = 0; i < CT_FLOOR_N * CT_FLOOR_N; i++) {
        const t = new THREE.Mesh(g, m);
        t.position.set(-H + TILE * ((i % CT_FLOOR_N) + 0.5), -0.25, -H + TILE * (Math.floor(i / CT_FLOOR_N) + 0.5));
        R.add(t); tiles.push(t);
      }
    } else {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, W).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: checkerTexture(L.a, L.b, 2, [W / 3, W / 3]), roughness: variant === 'snow' ? 0.25 : 0.95, metalness: variant === 'snow' ? 0.2 : 0 }));
      R.add(floor);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 1.4, 1.2, W + 1.4), new THREE.MeshStandardMaterial({ color: new THREE.Color(L.b).multiplyScalar(0.5), roughness: 1 }));
      slab.position.y = -0.62;
      R.add(slab);
    }
    if (!arena) {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: L.bg, roughness: 1 }));
      ground.position.y = variant === 'space' ? -6 : -1.3;
      R.add(ground);
    }
    // low wall with trim
    const stone = new THREE.MeshStandardMaterial({ color: L.wall, roughness: 0.9 });
    const trim = new THREE.MeshStandardMaterial({ color: L.trim, roughness: 0.6, emissive: variant === 'space' ? L.trim : 0, emissiveIntensity: 0.4 });
    for (const [x, z, w, d] of [[0, -H - 0.35, W + 1.4, 0.7], [0, H + 0.35, W + 1.4, 0.7], [-H - 0.35, 0, 0.7, W], [H + 0.35, 0, 0.7, W]]) {
      const wl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), stone);
      wl.position.set(x, 0.45, z);
      const t = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.14, d + 0.02), trim);
      t.position.set(x, 0.95, z);
      R.add(wl, t);
    }
    // corner pads + totems
    const c = H - 2;
    [[-c, -c], [c, -c], [-c, c], [c, c]].forEach(([x, z], s) => {
      const col = new THREE.Color(kit.hex(s));
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, depthWrite: false }));
      pad.position.set(x, 0.02, z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
      ring.position.set(x, 0.03, z);
      R.add(pad, ring);
      const tot = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 0.9 }));
      const sx = Math.sign(x), sz = Math.sign(z);
      tot.position.set(sx * (H + 0.35), 0.95, sz * (H + 0.35));
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: col }));
      eye.position.set(tot.position.x - sx * 0.3, 1.6, tot.position.z - sz * 0.3);
      R.add(tot, eye);
    });
    // backdrop trees only when there is no catalog arena
    if (!arena && variant === 'jungle') {
      let seed = 21; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const trunkM = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 });
      const leafM = new THREE.MeshStandardMaterial({ color: 0x2f8a3a, roughness: 0.9, flatShading: true });
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + rnd() * 0.2, d = H * 1.75 + rnd() * 10;
        const tr = new THREE.Group();
        const hgt = 2.5 + rnd() * 2;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, hgt, 7), trunkM);
        trunk.position.y = hgt / 2;
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.6, 7), leafM);
        top.position.y = hgt + 0.6;
        tr.add(trunk, top);
        tr.position.set(Math.cos(a) * d, -1.3, Math.sin(a) * d);
        R.add(tr);
      }
    }
  }

  function crateObj(kind: string): Vis {
    const obj = kind === 'tnt' ? makeCrate(1.1, 'tnt') : kind === 'nitro' ? makeCrate(1.1, 'nitro') : propObject('crate', 1.1, () => makeCrate(1.1));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 8), new THREE.MeshBasicMaterial({ color: kind === 'nitro' ? 0x6aff3a : 0xff5a2a, transparent: true, opacity: 0.28, depthWrite: false }));
    glow.position.y = 0.55;
    glow.visible = false;
    obj.add(glow);
    kit.root.add(obj);
    return { obj, shadow: kit.fx.shadow(0.7, 0.45), glow, kind };
  }

  function itemObj(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    let col = 0xf08a1c;
    if (kind === 'fruit') {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 12), new THREE.MeshStandardMaterial({ color: 0xf08a1c, roughness: 0.5, emissive: 0x602800, emissiveIntensity: 0.4 }));
      f.position.y = 0.85;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 6), new THREE.MeshStandardMaterial({ color: 0x3a9a2a }));
      leaf.position.y = 1.32;
      g.add(f, leaf);
    } else if (kind === 'boots') {
      col = 0xffd23f;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.8), new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5 }));
      b.position.y = 0.9;
      const w = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 6).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      w.position.set(0, 0.9, -0.6);
      g.add(b, w);
    } else {
      col = 0xb060ff;
      const flask = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), new THREE.MeshStandardMaterial({ color: 0xb060ff, roughness: 0.2, emissive: 0x501080, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }));
      flask.position.y = 0.8;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0xddddff }));
      neck.position.y = 1.3;
      g.add(flask, neck);
    }
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false }));
    halo.position.y = 0.04;
    g.add(halo);
    kit.root.add(g);
    return g;
  }

  return {
    id: 'crateToss',
    async preload() { await preloadCatalogFor('crateToss', ['crate']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'jungle';
      kit = new Kit(ctx, 'crateToss', { bg: (LOOKS[variant] ?? LOOKS.jungle).bg, fog: [45, 100], hemi: [0xfff6e0, 0x5a6a4a, 1.5] });
      crates.clear(); items.clear(); bars.clear(); tiles.length = 0; starT.clear();
      build();
      ctx.frame(H + 2.8);
      if (!loaded) this.preload!().then(() => { for (const v of crates.values()) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); } crates.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data;
      const seen = new Set<number>();
      const seenC = new Set<number>();
      const seenI = new Set<number>();
      // space bash: holes
      if (variant === 'space' && d.floor?.length) {
        for (let i = 0; i < tiles.length; i++) { const t = tiles[i]; if (t) t.visible = d.floor[i] === 1; }
      }
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b);
          const stun = d.stun?.[b.slot] ?? 0;
          const boots = (d.boots?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { hidden: !b.alive && !b.fall, tumble: b.fall ? true : undefined, role: kit.over.done ? undefined : stun > 0 ? 'hit' : undefined });
          if (boots && b.alive && Math.hypot(b.vx, b.vz) > 1) kit.fx.trail(b.x, 0.3, b.z, 0xffe14a, 0.4, 0.3);
          if (b.fall) a.holder.scale.multiplyScalar(0.96);
          let bar = bars.get(b.slot);
          if (!bar) { bar = new HpBar(1.6); kit.root.add(bar.group); bars.set(b.slot, bar); }
          bar.group.visible = b.alive && !b.fall && !kit.over.done;
          bar.group.position.set(b.x, a.headY + b.y + 0.55, b.z);
          bar.set((d.hp?.[b.slot] ?? CT_HP) / CT_HP);
          if (stun > 0 && !kit.over.done && b.alive) {
            const t = (starT.get(b.slot) ?? 0) + dt * 6;
            starT.set(b.slot, t);
            for (let i = 0; i < 3; i++) {
              const an = t + (i * Math.PI * 2) / 3;
              kit.fx.burst(b.x + Math.cos(an) * 0.7, b.y + a.headY - 0.15, b.z + Math.sin(an) * 0.7, { shape: 'star', color: 0xffe14a, count: 1, speed: 0, size: 0.34, life: 0.12, gravity: 0, spread: 0, grow: 1 });
            }
          }
        } else if (b.kind === 'crate' || b.kind === 'tnt' || b.kind === 'nitro') {
          seenC.add(b.id);
          let v = crates.get(b.id);
          if (!v) { v = crateObj(b.kind); crates.set(b.id, v); }
          const held = b.cd > 0;
          const flying = b.dash > 0 && !held;
          v.obj.position.set(b.x, b.y + (held ? 0.35 : 0), b.z);
          v.obj.rotation.y = b.face;
          v.obj.rotation.x = flying ? b.face * 0.5 : 0;
          v.glow.visible = flying || (b.kind === 'nitro' && Math.sin(ctx.time * 8 + b.id) > 0.3);
          v.shadow.set(b.x, b.z, held ? b.y + 0.5 : b.y);
          if (flying) kit.fx.trail(b.x, b.y + 0.5, b.z, b.kind === 'nitro' ? 0x6aff3a : 0xff7a3a, 0.5, 0.3);
          if (b.kind === 'nitro' && !held) v.obj.position.x += Math.sin(ctx.time * 30 + b.id) * 0.015;
          if (b.kind === 'tnt' && b.fall) { // lit: flash and count down
            const blink = Math.sin(ctx.time * (14 + (3 - b.m) * 6)) > 0;
            v.glow.visible = true;
            (v.glow.material as THREE.MeshBasicMaterial).color.set(blink ? 0xffffff : 0xff3a1a);
            v.obj.scale.setScalar(1 + (blink ? 0.08 : 0));
            if (!v.fuse) { v.fuse = new TextSprite('#ffffff', 0.9); v.obj.add(v.fuse.sprite); v.fuse.sprite.position.y = 1.8; }
            v.fuse.set(String(Math.max(1, Math.ceil(b.m))));
            kit.fx.sparks(b.x, b.y + 1.15, b.z, [0xffb030, 0xffffff], 1, 2);
          }
        } else if (b.kind === 'fruit' || b.kind === 'boots' || b.kind === 'potion') {
          seenI.add(b.id);
          let o = items.get(b.id);
          if (!o) { o = itemObj(b.kind); items.set(b.id, o); }
          o.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.1, b.z);
          o.rotation.y += dt * 1.5;
        }
      }
      kit.prune(seen);
      for (const [id, v] of crates) if (!seenC.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); disposeTree(v.obj); crates.delete(id); }
      for (const [id, o] of items) if (!seenI.has(id)) { kit.root.remove(o); disposeTree(o); items.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const hexN = (s: number) => '#' + new THREE.Color(kit.hex(s)).getHexString();
      switch (e.k) {
        case 'grab':
          fx.sparks(e.x, 1, e.z, [0xffe14a, 0xffffff], 8, 3);
          fx.ring(e.x, e.z, { color: kit.hex(e.s), radius: 1.5, life: 0.3 });
          kit.actorForSlot(e.s)?.squash.kick(0.35);
          break;
        case 'throw': case 'kick':
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 2, life: 0.3 });
          fx.burst(e.x, 1, e.z, { shape: 'smoke', color: 0xffffff, count: 4, speed: 2, size: 0.5, life: 0.35, flat: true, grow: 2 });
          kit.actorForSlot(e.s)?.squash.kick(0.4);
          break;
        case 'bounce': case 'land':
          fx.burst(e.x, 0.6, e.z, { shape: 'chip', color: [0xc98a3b, 0x7a4a1c], count: 5, speed: 3, size: 0.22, life: 0.6, up: 3, gravity: 12 });
          fx.dust(e.x, e.z, 0.4, 0xb0a890);
          break;
        case 'hit':
          fx.stars(e.x, 1.6, e.z, 10);
          fx.text(e.x, 3, e.z, `-${Math.max(1, Math.round(e.v * CT_HP))}`, { color: '#ff6a5a', size: 1.2 });
          if (e.o >= 0) {
            const t = kit.actorForSlot(e.o)?.holder.position;
            if (t) fx.text(t.x, 3.6, t.z, 'BONK!', { color: hexN(e.o), size: 1.0, life: 1.0 });
          }
          kit.actorForSlot(e.s)?.hit(1.2);
          kit.shake(0.4);
          break;
        case 'smash':
          fx.burst(e.x, 0.9, e.z, { shape: 'chip', color: [0xd79a45, 0x7a4a1c, 0xf2c46a], count: 26, speed: 6, size: 0.3, life: 0.9, up: 5, gravity: 14, grow: 0.8 });
          fx.wumpa(e.x, 0.9, e.z, 4);
          fx.ring(e.x, e.z, { color: 0xffb347, radius: 3, life: 0.45 });
          kit.shake(0.35);
          break;
        case 'lit':
          fx.text(e.x, 2.8, e.z, 'TNT!', { color: '#ff6a3a', size: 1.2, life: 1.0 });
          fx.sparks(e.x, 1.2, e.z, [0xffb030, 0xffffff], 8, 4);
          break;
        case 'explode': {
          const r = Math.max(2, e.v);
          fx.burst(e.x, 0.9, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 30, speed: 6, size: 1.2, life: 0.8, up: 3, grow: 1.8 });
          fx.smoke(e.x, 1, e.z, 10, 0x2a2a30);
          fx.sparks(e.x, 1, e.z, [0xffe08a, 0xffffff], 16, 9);
          fx.ring(e.x, e.z, { color: 0xffd060, radius: r * 1.3, life: 0.6 });
          kit.shake(0.7);
          break;
        }
        case 'hole':
          fx.burst(e.x, 0.2, e.z, { shape: 'chip', color: [0x8a90b0, 0x4a5070], count: 14, speed: 4, size: 0.35, life: 0.8, up: 4, gravity: 14 });
          fx.smoke(e.x, 0.3, e.z, 4, 0x3a3a50);
          break;
        case 'pickup':
          fx.stars(e.x, 1.2, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.8, e.z, ['', '+HEALTH', 'SPEEDY BOOTS', 'SLOW-MO!'][Math.round(e.v)] ?? '', { color: e.v === 3 ? '#c080ff' : '#ffe14a', size: 0.9, life: 1.1 });
          break;
        case 'ko':
          fx.burst(e.x, 1, e.z, { shape: 'star', color: [0xffffff, 0xffe14a], count: 14, speed: 6, size: 0.5, life: 0.9, up: 5, gravity: 10 });
          fx.text(e.x, 3, e.z, 'OUT!', { color: '#ff6a5a', size: 1.5, life: 1.4 });
          kit.shake(0.4);
          break;
      }
    },

    hud(w, slot) {
      const hp = Math.max(0, w.data.hp?.[slot] ?? 0);
      const alive = w.bodies.some((b) => b.kind === 'player' && b.slot === slot && b.alive);
      return alive ? `${hp}/${CT_HP} HP · ${w.data.score?.[slot] ?? 0} hits` : `OUT · ${w.data.score?.[slot] ?? 0} hits`;
    },

    dispose() {
      for (const v of crates.values()) kit.root.remove(v.obj);
      for (const o of items.values()) kit.root.remove(o);
      for (const b of bars.values()) kit.root.remove(b.group);
      crates.clear(); items.clear(); bars.clear(); tiles.length = 0; starT.clear();
      kit.dispose();
    },
  };
}
