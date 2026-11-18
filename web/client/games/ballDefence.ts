// BALLISTIX view (shared/games/ballDefence.ts): the four real levels (CRASHBALL, BEACH BALL, N.BALLISM, SKY BALLS)
// seen through the real fixed camera. Stage pieces come from the disc models listed in assets/stages/ballDefence.json;
// floors and walls that the disc stores elsewhere are rebuilt here from the same level textures.
import * as THREE from 'three';
import { BD_GOAL, BD_GOAL_ANG, BD_HALF, BD_NORMALS, BD_PADS, BD_R } from '../../shared/games/ballDefence';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { ASSET_BASE, getCatalog, type ModelRef } from '../crash';
import { createCharacter } from '../characters';
import { sfx } from '../shell/sound';
import type { ActorParts } from './kit';
import { catalogInstance, disposeTree, Kit, preloadCatalogFor } from './kit';
import type { ClientMiniGame } from './types';

const H = BD_HALF;
/** The real camera, fitted from emulator frames (native units x 4 = sim units). */
const cam = (y: number, z: number, pitch: number, fov: number) => ({ y: y * 4, z: z * 4, pitch: (pitch * Math.PI) / 180, fov, sx: 1.295 });
export const BD_CAMS: Record<string, ReturnType<typeof cam>> = {
  crashball: cam(3.989, 2.951, 52.5, 65),
  beach: cam(3.862, 3.021, 51.2, 65.8),
  nballism: cam(3.989, 2.951, 52.5, 65),
  sky: cam(4.06, 4.091, 46.87, 56.9), // fitted on the four engine fans
};
const ARENA_KEY: Record<string, string> = { crashball: 'crashball', beach: 'beachBall', nballism: 'nballism', sky: 'skyBalls' };
const BG: Record<string, number> = { crashball: 0x000000, beach: 0x1a3440, nballism: 0x061a24, sky: 0x6aa6e6 };
const BALL_COL: Record<string, number> = { crashball: 0xe4eef8, beach: 0xb4703c, nballism: 0xe4ecf6, sky: 0xc8d0da };
const BANK = (n: number) => `sfx/0154/${n}.mp3`;

// ------------------------------------------------------------------ texture helpers

const loader = new THREE.TextureLoader();
function tex(path: string, repeat?: [number, number]): THREE.Texture {
  const t = loader.load(`${ASSET_BASE}textures/${path}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/** n x n grid of tiles drawn from level textures (random but deterministic), as one texture. */
function tileSheet(dir: string, ids: number[], n: number, tint?: string, seed = 5): THREE.CanvasTexture {
  const cell = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n * cell;
  const g = cv.getContext('2d')!;
  g.fillStyle = tint ?? '#777';
  g.fillRect(0, 0, cv.width, cv.height);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const id = ids[Math.floor(rnd() * ids.length)];
    const img = new Image();
    img.onload = () => {
      g.drawImage(img, x * cell, y * cell, cell, cell);
      if (tint) { g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = tint; g.fillRect(x * cell, y * cell, cell, cell); g.restore(); }
      t.needsUpdate = true;
    };
    img.src = `${ASSET_BASE}textures/${dir}/tex${String(id).padStart(3, '0')}.png`;
  }
  return t;
}

/** soft blotchy surface texture (the steel plate / ice look of the PS1 floors) */
function noiseTex(base: string, amp: number, seed: number): THREE.CanvasTexture {
  const n = 128, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  let s = seed * 7919;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 340; i++) {
    const v = (rnd() - 0.5) * amp * 2, r = 2 + rnd() * 7, x = rnd() * n, y = rnd() * n;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${Math.min(0.5, v / 100)})` : `rgba(0,0,0,${Math.min(0.5, -v / 100)})`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** pad / sprite texture with its flat grey backdrop cut away (keeps the black and green chevrons) */
function cutoutTex(path: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  const img = new Image();
  img.onload = () => {
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 64, 64);
    const px = g.getImageData(0, 0, 64, 64), d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2], lum = (r + gg + b) / 3;
      const green = gg > r + 30 && gg > b + 30;
      d[i + 3] = green || lum < 70 ? 255 : 0;
    }
    g.putImageData(px, 0, 0);
    t.needsUpdate = true;
  };
  img.src = `${ASSET_BASE}textures/${path}`;
  return t;
}

const flat = (w: number, d: number, mat: THREE.Material, y = 0.0, x = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
  m.position.set(x, y, z);
  return m;
};
const basic = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...o });

/** crashball's border lights are cyan in the real game; the decoded set carries the red palette of the same strips. */
function retintRed(root: THREE.Object3D) {
  const done = new Map<THREE.Texture, THREE.Texture>();
  const isRed = (r: number, g: number, b: number) => r > 0.2 && r > g * 1.5 && r > b * 1.5;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    const map = mat.map;
    if (!map) {
      // untextured glow panels: vertex colours carry the red palette
      const col = m.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!col) return;
      let any = false;
      for (let i = 0; i < col.count && !any; i++) any = isRed(col.getX(i), col.getY(i), col.getZ(i));
      if (!any) return;
      m.geometry = m.geometry.clone();
      const c2 = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c2.count; i++) {
        const r = c2.getX(i), g = c2.getY(i), b = c2.getZ(i);
        if (isRed(r, g, b)) c2.setXYZ(i, (g + b) / 2, r * 0.95, r);
      }
      return;
    }
    const img = map.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img || !img.width) return;
    let out = done.get(map);
    if (!out) {
      const cv = document.createElement('canvas');
      cv.width = img.width as number; cv.height = img.height as number;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, cv.width, cv.height), d = px.data;
      let changed = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        if (d[i + 3] > 8 && isRed(r / 255, gg / 255, b / 255)) { d[i] = (gg + b) / 2; d[i + 1] = Math.min(255, r * 1.25); d[i + 2] = Math.min(255, r * 1.3); changed++; }
      }
      if (changed > 3) {
        g.putImageData(px, 0, 0);
        const t = new THREE.CanvasTexture(cv);
        t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
        t.colorSpace = map.colorSpace; t.flipY = map.flipY;
        out = t;
      } else out = map;
      done.set(map, out);
    }
    if (out !== map) { const c = mat.clone(); c.map = out; m.material = c; }
  });
}

// ------------------------------------------------------------------ stage

interface Stage {
  group: THREE.Group;
  pads: THREE.Mesh[];
  padMats: THREE.MeshBasicMaterial[];
  update(t: number): void;
}

function refOf(variant: string): (ModelRef & { extra?: ModelRef[] }) | undefined {
  const arenas = getCatalog().arenas as Record<string, ModelRef & { extra?: ModelRef[] }>;
  return arenas[`ballDefence:${ARENA_KEY[variant]}`] ?? arenas.ballDefence;
}

function buildStage(variant: string): Stage {
  const group = new THREE.Group();
  const pads: THREE.Mesh[] = [];
  const padMats: THREE.MeshBasicMaterial[] = [];
  const upd: ((t: number) => void)[] = [];
  const ref = refOf(variant);
  const main = catalogInstance(ref);
  if (main) group.add(main.root);
  for (const ex of ref?.extra ?? []) { const m = catalogInstance(ex); if (m) group.add(m.root); }
  if (main && variant === 'crashball') retintRed(group);

  if (variant === 'crashball') {
    // floor between the border strips: the real steel plates
    group.add(flat(14.4, 14.4, basic({ map: noiseTex('#8a908f', 7, 7) })));
    const chev = [10, 11, 12, 13, 14].map((i) => cutoutTex(`0658/tex0${i}.png`));
    for (const [x, z] of BD_PADS) {
      const mat = basic({ map: chev[0], transparent: true, depthWrite: false });
      const m = flat(2.6, 2.6, mat, 0.03, x, z);
      group.add(m);
      pads.push(m); padMats.push(mat);
    }
  } else if (variant === 'beach') {
    group.add(flat(2 * H + 1.2, 2 * H + 1.2, basic({ map: tileSheet('0654', [57, 58, 59, 60, 61, 62, 63, 64, 66, 68, 69, 70, 71, 74, 76, 78], 6, '#a08c70', 11) }), -0.01));
    // glass centre disc ringed in gold (the model's glow patch sits on top)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.1, 0.3, 8, 48).rotateX(Math.PI / 2), basic({ map: tex('0654/tex096.png'), color: 0xf0c860 }));
    ring.position.y = 0.12;
    group.add(ring);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(4.9, 40).rotateX(-Math.PI / 2), basic({ color: 0x7fb6b4 }));
    glass.position.y = 0.04;
    group.add(glass);
    // gold edge rails along the sides and the bottom
    const gold = basic({ color: 0xb8842c });
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 2 * H - 4), gold);
      rail.position.set(sx * (H + 0.35), 0.4, 0);
      group.add(rail);
    }
  } else if (variant === 'nballism') {
    const ids: number[] = []; for (let i = 24; i <= 60; i++) ids.push(i);
    group.add(flat(2 * H + 1.2, 2 * H + 1.2, basic({ map: tileSheet('0650', ids, 4, '#2a8a99', 3) }), -0.01));
    // cyan edge rails left, right and bottom
    const cy = basic({ map: tex('0650/tex014.png'), color: 0xbff8ff });
    const mkRail = (w: number, d: number, x: number, z: number) => { const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), cy); r.position.set(x, 0.35, z); group.add(r); };
    mkRail(0.8, 2 * H - 2, -H - 0.5, 0); mkRail(0.8, 2 * H - 2, H + 0.5, 0);
    mkRail(2 * H - 3, 0.8, 0, H + 0.5); mkRail(2 * H - 3, 0.8, 0, -H - 0.5);
    // lab backdrop: teal wall panels, a door and the console bank behind the top goal
    const wallTex = [tex('0650/tex002.png'), tex('0650/tex005.png'), tex('0650/tex008.png')];
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), basic({ map: wallTex[i % 3], color: 0x7fb0b8 }));
      w.position.set(-25 + i * 10, 5, -17);
      group.add(w);
    }
    const door = new THREE.Mesh(new THREE.PlaneGeometry(7, 9), basic({ map: tex('0650/tex012.png') }));
    door.position.set(0, 4.6, -16.9);
    group.add(door);
    for (const [i, x] of [16, 17, 18, 19].entries()) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), basic({ map: tex(`0650/tex0${x}.png`) }));
      c.position.set(-5.4 + i * 3.6, 3.2, -16.8);
      group.add(c);
    }
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), basic({ map: wallTex[1], color: 0x4f8a94 }));
      w.rotation.y = -sx * Math.PI / 2;
      w.position.set(sx * 22, 6, -2);
      group.add(w);
    }
  }
  if (variant === 'sky') {
    // farmland far below the floating disc (the model only carries the strip behind it)
    const f = flat(260, 200, basic({ map: tileSheet('0646', [65, 66, 67, 68, 69, 70], 8, '#c8c8b0', 4) }), -10.2, 0, 10);
    group.add(f);
  }
  // sky level: disc, engines and the far backdrop are in the model
  return { group, pads, padMats, update: (t) => upd.forEach((f) => f(t)) };
}

// ------------------------------------------------------------------ view

interface Goal { slot: number; barrier: THREE.Mesh; barrierT: number; shield: THREE.Mesh }

export function createBallDefenceView(): ClientMiniGame {
  let kit: Kit;
  let stage: Stage;
  const goals: Goal[] = [];
  const balls = new Map<number, { obj: THREE.Group; shadow: BlobShadow; halo: THREE.Mesh; mat: THREE.MeshBasicMaterial }>();
  const posts = new Map<number, THREE.Object3D>();
  const padFlash = [0, 0, 0, 0];
  let loaded = false;
  let variant = 'crashball';
  let last: number[] = [];
  let bgColor = new THREE.Color(0);
  const axis = new THREE.Vector3();

  function setCamera(cam: THREE.PerspectiveCamera) {
    const C = BD_CAMS[variant] ?? BD_CAMS.crashball;
    const a = cam.aspect, t0 = Math.tan((C.fov * Math.PI) / 360);
    const fov = a < 4 / 3 ? (2 * Math.atan((t0 * (4 / 3)) / a) * 180) / Math.PI : C.fov;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.projectionMatrix.elements[0] *= C.sx; // the PS1 projection is wider than tall: real x-stretch
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.position.set(0, C.y, C.z);
    cam.lookAt(0, C.y - Math.sin(C.pitch) * 10, C.z - Math.cos(C.pitch) * 10);
  }

  function build() {
    const R = kit.root;
    stage = buildStage(variant);
    R.add(stage.group);
    const disc = variant === 'sky';
    for (let s = 0; s < 4; s++) {
      const col = new THREE.Color(kit.hex(s));
      const [nx, nz] = BD_NORMALS[s];
      const width = disc ? 2 * BD_R * Math.sin(BD_GOAL_ANG) : 2 * BD_GOAL;
      const edge = disc ? BD_R : H;
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(width, 1.8, 1.0), basic({ color: variant === 'beach' ? 0xb8842c : variant === 'sky' ? 0x8fa0b8 : variant === 'nballism' ? 0x7a3fd0 : 0x6a7684 }));
      barrier.position.set(nx * (edge + 0.2), -1.0, nz * (edge + 0.2));
      barrier.rotation.y = Math.atan2(nx, nz);
      barrier.visible = false;
      const shield = new THREE.Mesh(new THREE.BoxGeometry(width, 2.6, 0.3), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, depthWrite: false }));
      shield.position.set(nx * (edge - 0.3), 1.3, nz * (edge - 0.3));
      shield.rotation.y = Math.atan2(nx, nz);
      shield.visible = false;
      R.add(barrier, shield);
      goals.push({ slot: s, barrier, barrierT: 0, shield });
    }
  }

  function ballObj(b: Body) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: BALL_COL[variant] ?? 0xffffff });
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
    sph.name = 'spin';
    // PS1-style shading: dark underside, bright top (vertex colours)
    const pos = sph.geometry.attributes.position, cols: number[] = [];
    for (let i = 0; i < pos.count; i++) { const k = 0.55 + 0.45 * ((pos.getY(i) + 1) / 2); cols.push(k, k, k); }
    sph.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    mat.vertexColors = true;
    sph.scale.setScalar(b.r);
    sph.position.y = b.r;
    const halo = new THREE.Mesh(new THREE.SphereGeometry(b.r * 1.5, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.35, depthWrite: false }));
    halo.position.y = b.r;
    halo.visible = false;
    g.add(sph, halo);
    kit.root.add(g);
    return { obj: g, shadow: kit.fx.shadow(b.r * 1.4, 0.5), halo, mat };
  }

  function shipParts(slot: number): ActorParts {
    const inst = createCharacter(kit.look(slot), { variant: 'tank', ring: false });
    inst.root.position.set(0, 0.5, 0.8);
    inst.root.scale.setScalar(2.1);
    const ship = catalogInstance(getCatalog().props.bdShip);
    const extra = new THREE.Group();
    if (ship) extra.add(ship.root);
    else {
      const hull = new THREE.Mesh(new THREE.SphereGeometry(1.5, 20, 10).scale(1, 0.4, 1), basic({ color: 0x3a9a7a }));
      hull.position.y = 0.4;
      extra.add(hull);
    }
    return { inst, extra, shadow: 1.8, headY: 2.2, scale: 1, steady: true };
  }

  return {
    id: 'ballDefence',
    async preload() { await preloadCatalogFor('ballDefence', ['bdShip']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'crashball';
      bgColor = new THREE.Color(BG[variant] ?? 0);
      kit = new Kit(ctx, 'ballDefence', { bg: BG[variant] ?? 0, hemi: [0xffffff, 0x888899, 1.6] });
      goals.length = 0; balls.clear(); posts.clear();
      last = (world.data.lives ?? []).slice();
      build();
      setCamera(ctx.camera);
      if (!loaded) this.preload!().then(() => { kit?.reset(); if (kit) { kit.root.remove(stage.group); disposeTree(stage.group); stage = buildStage(variant); kit.root.add(stage.group); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      ctx.scene.background = bgColor;
      setCamera(ctx.camera);
      const d = w.data;
      const seen = new Set<number>(), seenBalls = new Set<number>(), seenPosts = new Set<number>();
      const heldIds = new Set<number>((d.held ?? []).filter((x: number) => x));
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => shipParts(b.slot));
          const stalled = (d.stall?.[b.slot] ?? 0) > 0;
          a.update(b, dt, {
            hidden: !b.alive,
            hop: 0.15 + Math.sin(ctx.time * 3 + b.slot * 1.7) * 0.06 + (stalled ? -0.12 : 0) + (b.dash > 0 ? 0.15 : 0),
            role: 'idle',
            freeze: true,
            keepYaw: false,
          });
          const speed = Math.hypot(b.vx, b.vz);
          a.pivot.rotation.z = THREE.MathUtils.lerp(a.pivot.rotation.z, -THREE.MathUtils.clamp(b.vx * 0.04, -0.3, 0.3), Math.min(1, dt * 10));
          if (speed > 8.5 && !stalled) kit.fx.trail(b.x - b.vx * 0.06, 0.3, b.z - b.vz * 0.06, 0x9fe8ff, 0.5, 0.2);
          if (stalled && Math.random() < dt * 14) kit.fx.sparks(b.x, 0.8, b.z, [0xffe14a, 0xff8a2a], 2, 3);
        } else if (b.kind === 'ball') {
          seenBalls.add(b.id);
          let v = balls.get(b.id);
          if (!v) { v = ballObj(b); balls.set(b.id, v); }
          const held = heldIds.has(b.id);
          v.obj.position.set(b.x, held ? 0.6 : 0.25, b.z);
          const sp = Math.hypot(b.vx, b.vz);
          const spin = v.obj.getObjectByName('spin');
          if (spin && sp > 0.1) { axis.set(b.vz, 0, -b.vx).normalize(); spin.rotateOnWorldAxis(axis, (sp * dt) / b.r); }
          v.shadow.set(b.x, b.z, held ? 0.6 : 0.25);
          const gin = b.dash > 0;
          v.halo.visible = gin || held;
          (v.halo.material as THREE.MeshBasicMaterial).color.set(held ? 0x9fe8ff : 0xff5a2a);
          v.mat.color.set(gin ? 0xff9a6a : BALL_COL[variant] ?? 0xffffff);
          if (gin) kit.fx.burst(b.x, 0.5, b.z, { shape: 'soft', color: [0xff5a20, 0xffb030], count: 1, speed: 0.5, size: 0.7, life: 0.35, gravity: -1, grow: 0.3 });
          else if (sp > 12) kit.fx.trail(b.x, b.r + 0.1, b.z, variant === 'crashball' ? 0x7fd8ff : 0xffffff, 0.35, 0.25);
        } else if (b.kind === 'post') {
          seenPosts.add(b.id);
          let o = posts.get(b.id);
          if (!o) {
            const g = new THREE.Group();
            const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(b.slot)) }));
            m.position.y = 1.6;
            g.add(m);
            o = g;
            kit.root.add(o);
            posts.set(b.id, o);
          }
          o.visible = b.cd <= 0;
          o.position.set(b.x, Math.sin(ctx.time * 3 + b.slot) * 0.25, b.z);
          o.rotation.y += dt * 2;
        }
      }
      kit.prune(seen);
      for (const [id, v] of balls) if (!seenBalls.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); disposeTree(v.obj); balls.delete(id); }
      for (const [id, o] of posts) if (!seenPosts.has(id)) { kit.root.remove(o); disposeTree(o); posts.delete(id); }

      const score: number[] = d.lives ?? [];
      for (const g of goals) {
        const closed = (score[g.slot] ?? 1) <= 0;
        g.barrierT = THREE.MathUtils.clamp(g.barrierT + (closed ? dt * 2.5 : -dt * 2.5), 0, 1);
        g.barrier.position.y = -1.0 + g.barrierT * 1.7;
        g.barrier.visible = g.barrierT > 0.01;
        const sh = (d.shield?.[g.slot] ?? 0) > 0;
        g.shield.visible = sh;
        if (sh) (g.shield.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(ctx.time * 10) * 0.12;
      }
      // boost pads flash green when a ball crosses them
      for (let i = 0; i < stage.pads.length; i++) {
        padFlash[i] = Math.max(0, padFlash[i] - dt);
        const f = padFlash[i] > 0 ? 1 + (Math.floor(ctx.time * 20) % 4) : 0;
        const mats = stage.padMats[i];
        const t = (mats.userData.frames ??= [10, 11, 12, 13, 14].map((i) => cutoutTex(`0658/tex0${i}.png`))) as THREE.Texture[];
        if (mats.map !== t[f]) { mats.map = t[f]; mats.needsUpdate = true; }
      }
      last = score.slice();
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
          sfx.playFile(BANK(strong ? 1 : (e.s + 4) % 3), 0.5);
          break;
        }
        case 'kick':
          kit.actorForSlot(e.s)?.squash.kick(-0.4);
          fx.ring(e.x, e.z, { color: kit.hex(e.s), radius: 2.2, life: 0.25 });
          sfx.playFile(BANK(0), 0.4);
          break;
        case 'bounce':
          fx.sparks(e.x, 0.5, e.z, 0xcfe0ff, 4, 3);
          sfx.playFile(BANK(4 + (e.id % 3)), 0.25);
          break;
        case 'pad':
          padFlash[e.s] = 0.5;
          sfx.playFile(BANK(14), 0.4);
          break;
        case 'goal': {
          const col = new THREE.Color(kit.hex(e.s));
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff5030, 0xffb040, col], count: 22, speed: 6, size: 0.7, life: 0.7, up: 3 });
          fx.ring(e.x, e.z, { color: col, radius: 4, life: 0.6 });
          fx.text(e.x, 2.4, e.z, '-1', { color: '#ff6a5a', size: 1.6 });
          kit.shake(0.45);
          sfx.playFile(BANK(7 + (e.s % 4)), 0.6);
          break;
        }
        case 'ko': {
          const p = kit.actorForSlot(e.s)?.holder.position;
          const x = p?.x ?? e.x, z = p?.z ?? e.z;
          fx.stars(x, 1.6, z, 14);
          fx.smoke(x, 0.8, z, 10, 0x333344);
          fx.ring(x, z, { color: 0xffe14a, radius: 5, life: 0.8 });
          fx.text(x, 3.0, z, 'OUT!', { color: '#ff6a5a', size: 2, life: 1.5 });
          kit.shake(0.9);
          sfx.playFile(BANK(12), 0.6);
          break;
        }
        case 'pickup':
          fx.stars(e.x, 0.8, e.z, 8, [0x9fe8ff, 0xffffff]);
          fx.text(e.x, 2.2, e.z, 'FORCE FIELD', { color: '#9fe8ff', size: 1.2 });
          sfx.playFile(BANK(11), 0.5);
          break;
        case 'shield':
          if (e.v === 0) fx.ring(e.x, e.z, { color: 0x9fe8ff, radius: 2, life: 0.3 });
          break;
        case 'magnet':
          fx.ring(e.x, e.z, { color: 0x9fe8ff, radius: 2.2, life: 0.35 });
          fx.sparks(e.x, 0.6, e.z, [0x9fe8ff, 0xffffff], 8, 3);
          sfx.playFile(BANK(13), 0.4);
          break;
        case 'launch':
          fx.ring(e.x, e.z, { color: 0xffffff, radius: 3, life: 0.35 });
          fx.sparks(e.x, 0.6, e.z, [0xfff2a0, 0xffffff], 12, 6);
          kit.shake(0.15);
          sfx.playFile(BANK(15), 0.5);
          break;
        case 'ngin':
          fx.ring(e.x, e.z, { color: 0xff3a2a, radius: 4, life: 0.8 });
          fx.text(e.x - BD_NORMALS[e.s][0] * 3, 3, e.z - BD_NORMALS[e.s][1] * 3, 'N.GIN!', { color: '#ff6a5a', size: 1.6, life: 1.4 });
          kit.shake(0.2);
          break;
        case 'stall':
          fx.smoke(e.x, 0.8, e.z, 5, 0x555566);
          fx.text(e.x, 2.8, e.z, 'ENGINE FAIL', { color: '#ffb040', size: 1.1 });
          sfx.playFile(BANK(18), 0.4);
          break;
      }
    },

    hud(w, slot) {
      const l = w.data.lives?.[slot] ?? 0;
      return l > 0 ? String(l) : 'OUT';
    },

    dispose() {
      for (const v of balls.values()) kit.root.remove(v.obj);
      balls.clear(); posts.clear(); goals.length = 0;
      kit.dispose();
    },
  };
}

