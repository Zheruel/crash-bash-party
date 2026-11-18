// POGO PAINTER view (shared/games/tilePainter.ts): hop a 10x10 grid on pogo sticks, paint squares, bank at "?" crates.
import * as THREE from 'three';
import { TP_HALF, TP_N, TP_TILE, tileCenter } from '../../shared/games/tilePainter';
import { createCharacter, usedVariant } from '../characters';
import type { ActorParts } from './kit';
import { crateTexture, disposeTree, Kit, preloadCatalogFor, propObject, TextSprite } from './kit';
import type { ClientMiniGame } from './types';

const BLANK_A = new THREE.Color('#ece6d6');
const BLANK_B = new THREE.Color('#d9d1bd');
const ITEM_ICON = ['', '🚀', '➡', '👢'];

function makePogo(hex: string): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: 0.5, roughness: 0.35 });
  const team = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.5 });
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.1, 16), team);
  foot.position.y = 0.05;
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.035, 6, 14).rotateX(Math.PI / 2), steel);
    c.position.y = 0.12 + i * 0.07;
    g.add(c);
  }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), steel);
  post.position.y = 0.45;
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.09, 14), team);
  pad.position.y = 0.55;
  g.add(foot, post, pad);
  return g;
}

function makeRocket(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.7, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8e8f0, metalness: 0.3, roughness: 0.4 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff4a3a }));
  nose.position.z = 0.5;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb030 }));
  flame.position.z = -0.5;
  g.add(body, nose, flame);
  return g;
}

export function createTilePainterView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let variant = 'pogo';
  let tiles: THREE.InstancedMesh;
  const owner = new Array<number>(TP_N * TP_N).fill(-1);
  const cur: THREE.Color[] = [];
  const tgt: THREE.Color[] = [];
  const pop = new Float32Array(TP_N * TP_N);
  const wallMeshes: THREE.Mesh[] = [];
  let wallsKey = '';
  const m4 = new THREE.Matrix4();
  const pogoSprings = new Map<number, THREE.Object3D>();
  const objs = new Map<number, { obj: THREE.Object3D; icon?: TextSprite }>();
  const icons = new Map<number, TextSprite>();
  const stunT = new Map<number, number>();

  function build() {
    const R = kit.root;
    const base = TP_HALF * 2;
    const arena = kit.addArena(variant, variant === 'agogo' || variant === 'elpogoloco' ? -1.3 : -0.6);
    if (arena) Kit.clearFootprint(arena, TP_HALF + 1.6);
    if (!arena) {
      const island = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 0.55, 1, 4, 1, false, Math.PI / 4).scale(base * 0.78, 3.2, base * 0.78),
        new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1, flatShading: true }),
      );
      island.position.y = -2.5;
      R.add(island);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(base + 0.7, 0.7, base + 0.7), new THREE.MeshStandardMaterial({ color: 0x3a2c4a, roughness: 0.8 }));
    plate.position.y = -0.7;
    R.add(plate);
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xf4f0e6, roughness: 0.6 });
    for (const [x, z, w, d] of [[0, -TP_HALF - 0.2, base + 0.8, 0.4], [0, TP_HALF + 0.2, base + 0.8, 0.4], [-TP_HALF - 0.2, 0, 0.4, base], [TP_HALF + 0.2, 0, 0.4, base]]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), curbMat);
      c.position.set(x, 0.12, z);
      R.add(c);
    }
    for (let s = 0; s < 4; s++) {
      const cx = s % 2 ? 1 : -1, cz = s < 2 ? -1 : 1;
      const col = new THREE.Color(kit.hex(s));
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 1.1, 14), new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, emissive: col, emissiveIntensity: 0.2 }));
      p.position.set(cx * (TP_HALF + 0.3), 0.4, cz * (TP_HALF + 0.3));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), new THREE.MeshBasicMaterial({ color: col }));
      cap.position.set(p.position.x, 1.15, p.position.z);
      R.add(p, cap);
    }
    const geo = new THREE.BoxGeometry(TP_TILE * 0.93, 0.3, TP_TILE * 0.93);
    tiles = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.55 }), TP_N * TP_N);
    for (let i = 0; i < TP_N * TP_N; i++) {
      const c = ((i % TP_N) + Math.floor(i / TP_N)) % 2 ? BLANK_A : BLANK_B;
      cur.push(c.clone()); tgt.push(c.clone());
      tiles.setColorAt(i, c);
    }
    R.add(tiles);
  }

  function setWalls(list: number[]) {
    const key = list.join(',');
    if (key === wallsKey) return;
    wallsKey = key;
    for (const m of wallMeshes) { kit.root.remove(m); disposeTree(m); }
    wallMeshes.length = 0;
    for (const i of list) {
      const [x, z] = tileCenter(i);
      const t = crateTexture('#8a8f9c', '#4a5060', 'steel');
      const m = new THREE.Mesh(new THREE.BoxGeometry(TP_TILE * 0.95, 1.3, TP_TILE * 0.95), new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }));
      m.position.set(x, 0.65, z);
      kit.root.add(m);
      wallMeshes.push(m);
    }
  }

  function makeParts(slot: number): ActorParts {
    const hex = kit.hex(slot);
    const inst = createCharacter(kit.look(slot), { variant: 'pogo', ring: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 0.95, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.95, depthWrite: false }));
    ring.position.y = 0.03;
    if (usedVariant(inst)) return { inst, extra: ring, headY: 2.1, shadow: 0.7, scale: 1.2 };
    const pogo = makePogo(hex);
    inst.root.position.y = 0.55;
    pogoSprings.set(slot, pogo);
    const grp = new THREE.Group();
    grp.add(pogo, ring);
    return { inst, extra: grp, headY: 2.15, shadow: 0.8 };
  }

  function icon(slot: number): TextSprite {
    let t = icons.get(slot);
    if (!t) { t = new TextSprite('#ffffff', 0.7); kit.root.add(t.sprite); icons.set(slot, t); }
    return t;
  }

  return {
    id: 'tilePainter',
    async preload() { await preloadCatalogFor('tilePainter', ['crate', 'crateStar']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'pogo';
      const bg = variant === 'pogo' ? 0x2a1f46 : variant === 'padlock' ? 0x1c1c26 : 0x3a2a1c;
      kit = new Kit(ctx, 'tilePainter', { bg, fog: [60, 120], hemi: [0xfff0e0, 0x5a4a7a, 1.6] });
      owner.fill(-1); cur.length = 0; tgt.length = 0; pop.fill(0); pogoSprings.clear(); objs.clear(); icons.clear(); stunT.clear(); wallMeshes.length = 0; wallsKey = '';
      build();
      ctx.frame(TP_HALF + 3.4);
      if (!loaded) this.preload!().then(() => { for (const o of objs.values()) kit.root.remove(o.obj); objs.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data;
      setWalls(d.walls ?? []);
      const data: number[] = d.tiles ?? [];
      const col = new THREE.Color();
      for (let i = 0; i < TP_N * TP_N; i++) {
        const o = data[i] ?? -1;
        if (o !== owner[i]) {
          owner[i] = o;
          const alt = ((i % TP_N) + Math.floor(i / TP_N)) % 2;
          tgt[i].copy(o >= 0 ? new THREE.Color(kit.hex(o)).offsetHSL(0, 0, alt ? 0.04 : -0.03) : alt ? BLANK_A : BLANK_B);
          pop[i] = 1;
          if (o >= 0) cur[i].lerp(new THREE.Color(0xffffff), 0.8);
        }
        cur[i].lerp(tgt[i], Math.min(1, dt * 9));
        pop[i] = Math.max(0, pop[i] - dt * 3.5);
        const [x, z] = tileCenter(i);
        m4.makeTranslation(x, -0.15 + Math.sin(pop[i] * Math.PI) * 0.35, z);
        tiles.setMatrixAt(i, m4);
        col.copy(cur[i]);
        tiles.setColorAt(i, col);
      }
      tiles.instanceMatrix.needsUpdate = true;
      if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;

      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const air = b.y > 0.02;
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          a.update(b, dt, { role: kit.over.done ? undefined : stun ? 'hit' : air ? 'hop' : 'idle', freeze: true });
          const sp = pogoSprings.get(b.slot);
          if (sp) sp.scale.y = air ? 1 : 0.6;
          // held item icon + boots trail + stun stars
          const item = d.item?.[b.slot] ?? 0;
          const ic = icon(b.slot);
          ic.sprite.visible = item > 0 && !kit.over.done;
          if (item > 0) { ic.set(ITEM_ICON[item]); ic.sprite.position.set(b.x + 0.9, b.y + a.headY - 0.3, b.z); }
          if ((d.boots?.[b.slot] ?? 0) > 0 && air) kit.fx.trail(b.x, 0.3, b.z, 0xffe14a, 0.5, 0.3);
          if (stun) {
            const t = (stunT.get(b.slot) ?? 0) + dt * 6;
            stunT.set(b.slot, t);
            for (let i = 0; i < 3; i++) {
              const an = t + (i * Math.PI * 2) / 3;
              kit.fx.burst(b.x + Math.cos(an) * 0.7, b.y + a.headY - 0.1, b.z + Math.sin(an) * 0.7, { shape: 'star', color: 0xffe14a, count: 1, speed: 0, size: 0.34, life: 0.12, gravity: 0, spread: 0, grow: 1 });
            }
          }
        } else if (b.kind === 'crate' || b.kind === 'power' || b.kind === 'missile') {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) {
            let obj: THREE.Object3D;
            let ic: TextSprite | undefined;
            if (b.kind === 'crate') obj = propObject('crate', 1.25, () => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ map: crateTexture('#9a5fd0', '#4a2a7a', 'x'), roughness: 0.6 })); m.position.y = 0.6; g.add(m); return g; });
            else if (b.kind === 'power') {
              obj = propObject('crateStar', 1.1, () => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), new THREE.MeshStandardMaterial({ map: crateTexture('#e8c040', '#8a6a10', 'x'), roughness: 0.6 })); m.position.y = 0.5; g.add(m); return g; });
              ic = new TextSprite('#ffffff', 0.8); ic.set(ITEM_ICON[b.cd] ?? '?'); ic.sprite.position.y = 1.9; obj.add(ic.sprite);
            } else obj = makeRocket();
            kit.root.add(obj);
            o = { obj, icon: ic };
            objs.set(b.id, o);
          }
          if (b.kind === 'missile') { o.obj.position.set(b.x, b.y, b.z); o.obj.rotation.y = Math.atan2(b.vx, b.vz); kit.fx.trail(b.x, b.y, b.z, 0xffb030, 0.4, 0.3); }
          else { o.obj.position.set(b.x, Math.sin(ctx.time * 3 + b.id) * 0.06, b.z); o.obj.rotation.y = Math.sin(ctx.time * 1.5 + b.id) * 0.25; }
        }
      }
      kit.prune(seen);
      for (const [id, o] of objs) if (!seenO.has(id)) { kit.root.remove(o.obj); disposeTree(o.obj); objs.delete(id); }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const hex = e.s >= 0 ? kit.hex(e.s) : '#ffffff';
      switch (e.k) {
        case 'paint':
          fx.burst(e.x, 0.15, e.z, { shape: 'soft', color: [hex, 0xffffff], count: 4 + Math.round(e.v * 8), speed: 2 + e.v * 2, size: 0.4, life: 0.5, up: 3, gravity: 12, grow: 0.3 });
          if (e.v > 0.6) { fx.ring(e.x, e.z, { color: hex, radius: 3.4, life: 0.45 }); kit.shake(0.1); }
          if (e.o > 0) fx.stars(e.x, 0.5, e.z, 3, [0xffffff, hex]);
          break;
        case 'cash':
          fx.confetti(e.x, 1.2, e.z, 26);
          fx.wumpa(e.x, 1, e.z, 6);
          fx.burst(e.x, 0.8, e.z, { shape: 'chip', color: [0x9a5fd0, 0xd8b0ff], count: 14, speed: 5, size: 0.3, life: 0.8, up: 4, gravity: 12 });
          fx.ring(e.x, e.z, { color: hex, radius: 4, life: 0.6 });
          fx.text(e.x, 2.6, e.z, `+${Math.round(e.v)}`, { color: '#' + new THREE.Color(hex).getHexString(), size: 1.6, life: 1.4 });
          kit.shake(0.3);
          break;
        case 'crate': case 'power':
          fx.ring(e.x, e.z, { color: e.k === 'crate' ? 0xd8b0ff : 0xffe14a, radius: 2.4, life: 0.5 });
          fx.stars(e.x, 1.2, e.z, 6);
          break;
        case 'pickup':
          fx.stars(e.x, 1.4, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.8, e.z, ['', 'MISSILE!', 'ARROW!', 'BOOTS!'][Math.round(e.v)] ?? '', { color: '#ffe14a', size: 1.0, life: 1.1 });
          break;
        case 'missile':
          fx.smoke(e.x, 0.8, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.8, e.z, [0xffb030, 0xffffff], 8, 5);
          break;
        case 'arrow': {
          const a = kit.actorForSlot(e.s);
          const p = a?.holder.position;
          const px = p?.x ?? e.x, pz = p?.z ?? e.z;
          for (let i = -TP_N; i <= TP_N; i++) {
            if (e.v === 0) fx.sparks(px + i * TP_TILE * 0.5, 0.4, pz, hex, 1, 1);
            else fx.sparks(px, 0.4, pz + i * TP_TILE * 0.5, hex, 1, 1);
          }
          fx.text(px, 2.8, pz, 'SWOOSH!', { color: '#' + new THREE.Color(hex).getHexString(), size: 1.0 });
          kit.shake(0.15);
          break;
        }
        case 'hit':
          fx.sparks(e.x, 1, e.z, [0xffe14a, 0xff8a30], 14, 6);
          fx.ring(e.x, e.z, { color: 0xff9a40, radius: 2.4, life: 0.4 });
          kit.actorForSlot(e.s)?.hit(1);
          kit.shake(0.3);
          break;
        case 'stun':
          fx.text(e.x, 3, e.z, 'STUNNED!', { color: '#ffb040', size: 1.0, life: 1.2 });
          break;
        case 'wipe':
          fx.smoke(e.x, 0.8, e.z, 8, 0x886688);
          fx.text(e.x, 2.8, e.z, 'WIPED!', { color: '#ff6a5a', size: 1.3, life: 1.3 });
          kit.shake(0.2);
          break;
        case 'capture':
          fx.ring(e.x, e.z, { color: hex, radius: 4, life: 0.6 });
          fx.stars(e.x, 1, e.z, 10, [0xffffff, hex]);
          fx.text(e.x, 2.4, e.z, `CAPTURED ${Math.round(e.v)}`, { color: '#' + new THREE.Color(hex).getHexString(), size: 1.1, life: 1.3 });
          break;
        case 'fizzle':
          fx.smoke(e.x, 0.8, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.8, e.z, 0xffb030, 6, 4);
          break;
      }
    },

    hud(w, slot) {
      const d = w.data;
      let n = 0;
      for (const o of d.tiles ?? []) if (o === slot) n++;
      return `${d.score?.[slot] ?? 0} pts · ${n} sq`;
    },

    dispose() {
      for (const o of objs.values()) kit.root.remove(o.obj);
      for (const t of icons.values()) kit.root.remove(t.sprite);
      for (const m of wallMeshes) kit.root.remove(m);
      objs.clear(); icons.clear(); pogoSprings.clear(); stunT.clear(); wallMeshes.length = 0;
      tiles.dispose(); kit.dispose();
    },
  };
}
