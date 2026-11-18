// BALLISTIX view (shared/games/ballDefence.ts): four hover-ships guard goals; 15 points each, balls cost 1.
import * as THREE from 'three';
import { BD_GOAL, BD_HALF, BD_NORMALS, BD_START } from '../../shared/games/ballDefence';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { getCatalog } from '../crash';
import { createCharacter } from '../characters';
import type { ActorParts } from './kit';
import { checkerTexture, disposeTree, hasProp, Kit, makeBall, preloadCatalogFor, propObject, TextSprite } from './kit';
import type { ClientMiniGame } from './types';

const H = BD_HALF;

interface Goal {
  slot: number;
  group: THREE.Group;
  barrier: THREE.Mesh;
  barrierT: number;
  shield: THREE.Mesh;
  shieldT: number;
  caps: THREE.Mesh[];
  score: TextSprite;
  label: THREE.Sprite | THREE.Object3D;
  last: number;
}

interface Ship { pad: THREE.Group; glow: THREE.Mesh; ring: THREE.Mesh }

export function createBallDefenceView(): ClientMiniGame {
  let kit: Kit;
  const goals: Goal[] = [];
  const balls = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow; spin: THREE.Object3D; halo: THREE.Mesh }>();
  const posts = new Map<number, THREE.Object3D>();
  const ships = new Map<number, Ship>();
  let loaded = false;
  let variant = 'crashball';
  const axis = new THREE.Vector3();

  function build() {
    const R = kit.root;
    const arena = kit.addArena(variant, -0.04);
    if (!arena) {
      const floorTex = checkerTexture('#3d5a8a', '#355079', 2, [5, 5]);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(H * 2, 0.8, H * 2), [
        new THREE.MeshStandardMaterial({ color: 0x24344f }), new THREE.MeshStandardMaterial({ color: 0x24344f }),
        new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x1c2740 }),
        new THREE.MeshStandardMaterial({ color: 0x24344f }), new THREE.MeshStandardMaterial({ color: 0x24344f }),
      ]);
      floor.position.y = -0.4;
      R.add(floor);
      const pit = new THREE.Mesh(new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x141b2e, roughness: 1 }));
      pit.position.y = -2.2;
      R.add(pit);
    } else {
      // real arena floor can be uneven: lay a faint translucent play-field over it so the lines read
      const field = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false }));
      field.position.y = 0.01;
      R.add(field);
    }
    const med = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.45, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }));
    med.position.y = 0.03;
    R.add(med);

    const wallMat = new THREE.MeshStandardMaterial({ color: arena ? 0x8a6a3e : 0x9aa7c4, roughness: 0.7 });
    const capMat = new THREE.MeshStandardMaterial({ color: arena ? 0xb08a52 : 0xcfd8ee, roughness: 0.6 });
    const seg = H - BD_GOAL;

    for (let s = 0; s < 4; s++) {
      const hex = kit.hex(s);
      const col = new THREE.Color(hex);
      const [nx, nz] = BD_NORMALS[s];
      const g = new THREE.Group();
      g.rotation.y = Math.atan2(nx, nz);
      R.add(g);
      // side walls (low rails) either side of the goal mouth
      for (const side of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(seg + 0.8, 0.9, 0.7), wallMat);
        w.position.set(side * (BD_GOAL + seg / 2 + 0.4), 0.45, H + 0.35);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(seg + 0.8, 0.14, 0.85), capMat);
        cap.position.set(w.position.x, 0.95, H + 0.35);
        g.add(w, cap);
      }
      const alcove = new THREE.Mesh(new THREE.BoxGeometry(BD_GOAL * 2, 0.8, 2.4), new THREE.MeshStandardMaterial({ color: 0x0b0f1c, roughness: 1 }));
      alcove.position.set(0, -0.4, H + 1.1);
      g.add(alcove);
      const back = new THREE.Mesh(new THREE.BoxGeometry(BD_GOAL * 2 + 1, 1.8, 0.4), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4, roughness: 0.6 }));
      back.position.set(0, 0.8, H + 2.3);
      g.add(back);
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(BD_GOAL * 2, 1.7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, depthWrite: false }));
      mat.position.set(0, 0.035, H - 0.85);
      g.add(mat);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(BD_GOAL * 2, 0.16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col }));
      line.position.set(0, 0.04, H - 0.1);
      g.add(line);
      const caps: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 1.7, 12), new THREE.MeshStandardMaterial({ color: 0xe8eefc, roughness: 0.5 }));
        post.position.set(side * BD_GOAL, 0.85, H + 0.4);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), new THREE.MeshBasicMaterial({ color: col }));
        cap.position.set(side * BD_GOAL, 1.95, H + 0.4);
        g.add(post, cap);
        caps.push(cap);
      }
      // score readout + name above the goal (billboards, parented to root)
      const score = new TextSprite(hex, 1.0);
      score.set(String(BD_START));
      score.sprite.position.set(nx * (H + 1.6), 3.0, nz * (H + 1.6));
      R.add(score.sprite);
      const name = new TextSprite(hex, 0.55);
      name.set(kit.ctx.seats[s]?.name ?? `P${s + 1}`);
      name.sprite.position.set(nx * (H + 1.6), 3.95, nz * (H + 1.6));
      R.add(name.sprite);
      // closing barrier (goal shut when eliminated)
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(BD_GOAL * 2, 1.5, 0.8), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.3, roughness: 0.5 }));
      barrier.position.set(0, -0.8, H + 0.3);
      g.add(barrier);
      // force field (N.Ballism): translucent dome across the mouth
      const shield = new THREE.Mesh(new THREE.BoxGeometry(BD_GOAL * 2, 2.2, 0.25), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false }));
      shield.position.set(0, 1.1, H - 0.2);
      shield.visible = false;
      g.add(shield);
      goals.push({ slot: s, group: g, barrier, barrierT: 0, shield, shieldT: 0, caps, score, label: name.sprite, last: BD_START });
    }
  }

  function ballObj(b: Body) {
    const obj = propObject('ball', b.r * 2, () => makeBall(b.r));
    kit.root.add(obj);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.5, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.35, depthWrite: false }));
    halo.position.y = b.r;
    halo.visible = false;
    obj.add(halo);
    return { obj, shadow: kit.fx.shadow(b.r * 1.3, 0.45), spin: obj.getObjectByName('spin') ?? obj, halo };
  }

  function shipParts(slot: number): ActorParts {
    const hex = kit.hex(slot);
    const col = new THREE.Color(hex);
    const inst = createCharacter(kit.look(slot), { ring: false });
    inst.root.position.y = 0.38;
    const pad = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.SphereGeometry(0.85, 24, 12).scale(1, 0.32, 1), new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.3 }));
    hull.position.y = 0.22;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.07, 8, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.4 }));
    rim.position.y = 0.2;
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55, depthWrite: false }));
    glow.position.y = 0.04;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.1, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.position.y = 0.03;
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 4).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    fin.position.set(0, 0.3, 0.8);
    pad.add(hull, rim, glow, ring, fin);
    ships.set(slot, { pad, glow, ring });
    return { inst, extra: pad, shadow: 1.0, headY: 2.0, scale: 1.2 };
  }

  return {
    id: 'ballDefence',
    async preload() { await preloadCatalogFor('ballDefence', ['ball', 'crystal']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'crashball';
      const bg = variant === 'sky' ? 0x5aa8e8 : variant === 'nballism' ? 0x1a1030 : variant === 'beach' ? 0x58b8d8 : 0x10301c;
      kit = new Kit(ctx, 'ballDefence', { bg, fog: [50, 120], hemi: [0xeaf2ff, 0x56607a, 1.6] });
      goals.length = 0; balls.clear(); posts.clear(); ships.clear();
      build();
      ctx.frame(H + 4);
      if (!loaded) this.preload!().then(() => kit?.reset());
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data;
      const seen = new Set<number>();
      const seenBalls = new Set<number>();
      const seenPosts = new Set<number>();
      const heldIds = new Set<number>((d.held ?? []).filter((x: number) => x));
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => shipParts(b.slot));
          const stalled = (d.stall?.[b.slot] ?? 0) > 0;
          const moving = Math.hypot(b.vx, b.vz) > 0.8;
          a.update(b, dt, {
            hidden: !b.alive,
            hop: 0.12 + Math.sin(ctx.time * 5 + b.slot) * 0.04 + (stalled ? -0.08 : 0),
            role: kit.over.done ? undefined : stalled ? 'hit' : b.dash > 0 ? 'jump' : moving ? 'run' : 'idle',
            freeze: true,
          });
          const sh = ships.get(b.slot);
          if (sh) {
            (sh.glow.material as THREE.MeshBasicMaterial).opacity = stalled ? 0.1 : 0.45 + Math.sin(ctx.time * 12 + b.slot) * 0.15;
            const boost = moving && (b.dash > 0 || Math.hypot(b.vx, b.vz) > 8.2);
            sh.ring.scale.setScalar(boost ? 1.15 : 1);
            if (boost) kit.fx.trail(b.x - Math.sin(b.face) * 0.7, 0.25, b.z - Math.cos(b.face) * 0.7, 0x9fe8ff, 0.4, 0.25);
          }
          if (stalled && Math.random() < dt * 14) kit.fx.sparks(b.x, 0.6, b.z, [0xffe14a, 0xff8a2a], 2, 3);
        } else if (b.kind === 'ball') {
          seenBalls.add(b.id);
          let v = balls.get(b.id);
          if (!v) { v = ballObj(b); balls.set(b.id, v); }
          const held = heldIds.has(b.id);
          v.obj.position.set(b.x, held ? 0.55 : 0, b.z);
          const sp = Math.hypot(b.vx, b.vz);
          if (sp > 0.1) {
            axis.set(b.vz, 0, -b.vx).normalize();
            v.spin.rotateOnWorldAxis(axis, (sp * dt) / b.r);
          }
          v.shadow.set(b.x, b.z, held ? 0.5 : 0);
          const gin = b.dash > 0;
          v.halo.visible = gin || held;
          (v.halo.material as THREE.MeshBasicMaterial).color.set(held ? 0x9fe8ff : 0xff5a2a);
          if (gin) kit.fx.burst(b.x, 0.5, b.z, { shape: 'soft', color: [0xff5a20, 0xffb030], count: 1, speed: 0.5, size: 0.7, life: 0.35, gravity: -1, grow: 0.3 });
          else if (sp > 11) kit.fx.trail(b.x, b.r, b.z, 0xffffff, 0.35, 0.25);
        } else if (b.kind === 'post') {
          seenPosts.add(b.id);
          let o = posts.get(b.id);
          if (!o) {
            o = propObject('crystal', 1.1, () => {
              const g = new THREE.Group();
              const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(b.slot)) }));
              m.position.y = 0.8;
              g.add(m);
              return g;
            });
            kit.root.add(o);
            posts.set(b.id, o);
          }
          o.visible = b.cd <= 0;
          o.position.set(b.x, 0.25 + Math.sin(ctx.time * 3 + b.slot) * 0.12, b.z);
          o.rotation.y += dt * 2;
        }
      }
      kit.prune(seen);
      for (const [id, v] of balls) if (!seenBalls.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); disposeTree(v.obj); balls.delete(id); }
      for (const [id, o] of posts) if (!seenPosts.has(id)) { kit.root.remove(o); posts.delete(id); }

      const score: number[] = d.lives ?? [];
      for (const g of goals) {
        const l = Math.max(0, score[g.slot] ?? BD_START);
        if (l !== g.last) { g.score.sprite.scale.multiplyScalar(1.35); g.last = l; }
        g.score.sprite.scale.lerp(new THREE.Vector3(1.0 * (256 / 96), 1.0, 1), Math.min(1, dt * 8));
        g.score.set(l > 0 ? String(l) : 'OUT', l <= 3 ? '#ff6a5a' : kit.hex(g.slot));
        const closed = l <= 0;
        g.barrierT = THREE.MathUtils.clamp(g.barrierT + (closed ? dt * 2.5 : -dt * 2.5), 0, 1);
        g.barrier.position.y = -0.8 + g.barrierT * 1.55;
        g.barrier.visible = g.barrierT > 0.01;
        const sh = (d.shield?.[g.slot] ?? 0) > 0;
        g.shield.visible = sh;
        if (sh) (g.shield.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(ctx.time * 10) * 0.12;
        const pulse = 0.9 + Math.sin(ctx.time * 4 + g.slot) * 0.15;
        for (const c of g.caps) c.scale.setScalar(closed ? 0.5 : pulse);
        (g.label as THREE.Sprite).material.opacity = closed ? 0.35 : 1;
      }
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'hit': {
          const strong = e.v > 1.2;
          fx.sparks(e.x, 0.7, e.z, [0xfff2a0, 0xffffff], strong ? 16 : 10, strong ? 7 : 5);
          fx.ring(e.x, e.z, { color: 0xffffff, radius: strong ? 2.4 : 1.6, life: 0.3 });
          kit.actorForSlot(e.o)?.squash.kick(0.3);
          kit.shake((strong ? 0.2 : 0.1) + e.v * 0.1);
          break;
        }
        case 'kick': {
          const a = kit.actorForSlot(e.s);
          a?.squash.kick(-0.4);
          fx.ring(e.x, e.z, { color: kit.hex(e.s), radius: 2.2, life: 0.25 });
          break;
        }
        case 'bounce':
          fx.sparks(e.x, 0.5, e.z, 0xcfe0ff, 4, 3);
          break;
        case 'goal': {
          const [nx, nz] = BD_NORMALS[e.s] ?? [0, 0];
          const col = new THREE.Color(kit.hex(e.s));
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff5030, 0xffb040, col], count: 22, speed: 6, size: 0.7, life: 0.7, up: 3 });
          fx.ring(e.x, e.z, { color: col, radius: 4, life: 0.6 });
          fx.text(nx * (H - 1.5), 1.8, nz * (H - 1.5), '-1', { color: '#ff6a5a', size: 1.5 });
          kit.shake(0.45);
          break;
        }
        case 'ko': {
          const p = kit.actorForSlot(e.s)?.holder.position;
          const x = p?.x ?? e.x, z = p?.z ?? e.z;
          fx.stars(x, 1.2, z, 14);
          fx.smoke(x, 0.8, z, 10, 0x333344);
          fx.ring(x, z, { color: 0xffe14a, radius: 5, life: 0.8 });
          fx.text(x, 2.6, z, 'OUT!', { color: '#ff6a5a', size: 1.8, life: 1.5 });
          kit.shake(0.9);
          break;
        }
        case 'pickup':
          fx.stars(e.x, 0.8, e.z, 8, [0x9fe8ff, 0xffffff]);
          fx.text(e.x, 1.8, e.z, 'SHIELD!', { color: '#9fe8ff', size: 1.1 });
          break;
        case 'shield':
          if (e.v === 0) fx.ring(e.x, e.z, { color: 0x9fe8ff, radius: 2, life: 0.3 });
          break;
        case 'magnet': {
          fx.ring(e.x, e.z, { color: 0x9fe8ff, radius: 2.2, life: 0.35 });
          fx.sparks(e.x, 0.6, e.z, [0x9fe8ff, 0xffffff], 8, 3);
          break;
        }
        case 'launch':
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 3, life: 0.35 });
          fx.sparks(e.x, 0.6, e.z, [0xfff2a0, 0xffffff], 12, 6);
          kit.shake(0.15);
          break;
        case 'ngin':
          fx.ring(e.x, e.z, { color: 0xff3a2a, radius: 4, life: 0.8 });
          fx.text(e.x - BD_NORMALS[e.s][0] * 2, 2.4, e.z - BD_NORMALS[e.s][1] * 2, 'N.GIN!', { color: '#ff6a5a', size: 1.4, life: 1.4 });
          kit.shake(0.2);
          break;
        case 'stall':
          fx.smoke(e.x, 0.8, e.z, 5, 0x555566);
          fx.text(e.x, 2.6, e.z, 'STALL!', { color: '#ffb040', size: 1.0 });
          break;
      }
    },

    hud(w, slot) {
      const l = w.data.lives?.[slot] ?? 0;
      return l > 0 ? `${l} pts` : 'OUT';
    },

    dispose() {
      for (const v of balls.values()) kit.root.remove(v.obj);
      balls.clear(); posts.clear(); ships.clear(); goals.length = 0;
      kit.dispose();
    },
  };
}
