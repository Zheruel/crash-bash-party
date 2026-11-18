import * as THREE from 'three';
import { DR_INNER, DR_LAPS, DR_OUTER, DR_PAD_R, DR_PADS, padPos } from '../../shared/games/dashRace';
import type { Body } from '../../shared/types';
import { createCharacter } from '../characters';
import { canvasTexture, checkerTexture, disposeTree, HpBar, Kit, preloadCatalogFor, propObject, TextSprite } from './kit';
import type { ActorParts } from './kit';
import type { ClientMiniGame } from './types';

const TAU = Math.PI * 2;
const SEG = 120;

/** Flat annulus with u = along the track, v = across it. */
function annulus(r0: number, r1: number, uRepeat: number, y = 0): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * TAU, c = Math.cos(a), s = Math.sin(a);
    pos.push(c * r0, y, s * r0, c * r1, y, s * r1);
    uv.push((i / SEG) * uRepeat, 0, (i / SEG) * uRepeat, 1);
    if (i < SEG) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point up
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

const THEMES: Record<string, { ground: number; infield: number; track: string; bg: number; curbA: string; curbB: string; trees: boolean }> = {
  dot: { ground: 0x2e6b3a, infield: 0x3f9a4a, track: '#4b4f5e', bg: 0x16253f, curbA: '#f4f0e6', curbB: '#e0453a', trees: true },
  toxic: { ground: 0x2a3a1a, infield: 0x4a7a2a, track: '#4a5040', bg: 0x10200c, curbA: '#c8ff4a', curbB: '#2a3a2a', trees: false },
  splash: { ground: 0x1c5a9a, infield: 0x2a7ab0, track: '#5a6a80', bg: 0x0e3a6a, curbA: '#ffffff', curbB: '#3fa7ff', trees: false },
  dante: { ground: 0x3a0e0a, infield: 0x4a1a14, track: '#3a3038', bg: 0x1a0606, curbA: '#ff8a2a', curbB: '#2a1818', trees: false },
};
let curTrack = '#4b4f5e';

function trackTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (g, s) => {
    g.fillStyle = curTrack; g.fillRect(0, 0, s, s);
    let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},0.06)`; g.fillRect(rnd() * s, rnd() * s, 3, 3); }
    // dashed lane lines at 1/3 and 2/3 across
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (const v of [1 / 3, 2 / 3]) g.fillRect(0, s * v - 1.5, s * 0.5, 3);
  }, undefined, false);
}

function padTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,230,90,0.95)'); gr.addColorStop(0.8, 'rgba(255,160,40,0.9)'); gr.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, TAU); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 9; g.lineJoin = 'miter';
    for (const dy of [-0.2, 0.08]) {
      g.beginPath(); g.moveTo(s * 0.26, s * (0.52 + dy)); g.lineTo(s * 0.5, s * (0.3 + dy)); g.lineTo(s * 0.74, s * (0.52 + dy)); g.stroke();
    }
  }, undefined, false);
}

export function createDashRaceView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const pads: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; flash: number }[] = [];
  let crowd: THREE.InstancedMesh | null = null;
  const crowdPhase: number[] = [];
  const crowdBase: THREE.Vector3[] = [];
  const finished = new Set<number>();
  const prevLap = [0, 0, 0, 0];
  const boostT = [0, 0, 0, 0];
  const m4 = new THREE.Matrix4();
  let variant = 'dot';
  const objs = new Map<number, THREE.Object3D>();
  const bars = new Map<number, HpBar>();
  const itemTxt = new Map<number, TextSprite>();
  const spinT = new Map<number, number>();

  function build() {
    const R = kit.root;
    const T = THEMES[variant] ?? THEMES.dot;
    curTrack = T.track;
    // ground
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(180, 180).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.ground, roughness: variant === 'splash' ? 0.3 : 1, metalness: variant === 'splash' ? 0.2 : 0 }));
    grass.position.y = -0.3;
    R.add(grass);
    // track
    const track = new THREE.Mesh(annulus(DR_INNER, DR_OUTER, 40), new THREE.MeshStandardMaterial({ map: trackTexture(), roughness: 0.9 }));
    track.position.y = 0.01;
    R.add(track);
    const base = new THREE.Mesh(new THREE.RingGeometry(DR_INNER - 0.3, DR_OUTER + 0.3, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2c36 }));
    base.position.y = -0.04;
    R.add(base);
    // infield
    const inner = new THREE.Mesh(new THREE.CircleGeometry(DR_INNER - 0.3, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: T.infield, roughness: 1 }));
    inner.position.y = 0.0;
    R.add(inner);
    const inner2 = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.9, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    inner2.position.y = 0.02;
    R.add(inner2);

    // curbs (alternating red/white blocks)
    const curbGeo = new THREE.BoxGeometry(1, 0.5, 0.55);
    const N = 72;
    const curbs = new THREE.InstancedMesh(curbGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), N * 2);
    const col = new THREE.Color();
    let k = 0;
    for (const rr of [DR_INNER - 0.1, DR_OUTER + 0.1]) {
      const len = (TAU * rr) / N;
      for (let i = 0; i < N; i++) {
        const a = ((i + 0.5) / N) * TAU;
        m4.compose(new THREE.Vector3(Math.cos(a) * rr, 0.22, Math.sin(a) * rr), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, 0)), new THREE.Vector3(len * 1.01, 1, 1));
        curbs.setMatrixAt(k, m4);
        curbs.setColorAt(k, col.set(i % 2 ? T.curbA : T.curbB));
        k++;
      }
    }
    R.add(curbs);

    // start / finish line + gantry at angle 0
    const mid = (DR_INNER + DR_OUTER) / 2, wdt = DR_OUTER - DR_INNER;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.3, wdt).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: checkerTexture('#ffffff', '#111118', 2, [1, wdt / 1.3 * 0.5 + 1]) }));
    line.position.set(mid, 0.03, 0);
    R.add(line);
    const postM = new THREE.MeshStandardMaterial({ color: 0xe8ecf6, roughness: 0.5 });
    for (const r of [DR_INNER - 0.4, DR_OUTER + 0.4]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 3.6, 10), postM);
      p.position.set(r, 1.8, 0);
      R.add(p);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, wdt + 1), new THREE.MeshStandardMaterial({ map: checkerTexture('#ffffff', '#15151f', 4, [6, 1]), roughness: 0.6 }));
    banner.position.set(mid, 3.6, 0);
    R.add(banner);

    // boost pads
    const pt = padTexture();
    DR_PADS.forEach((p, i) => {
      const [x, z] = padPos(i);
      const mat = new THREE.MeshBasicMaterial({ map: pt, transparent: true, depthWrite: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(DR_PAD_R * 2.3, DR_PAD_R * 2.3).rotateX(-Math.PI / 2), mat);
      m.position.set(x, 0.045, z);
      m.rotation.y = Math.PI - p.a;
      R.add(m);
      pads.push({ mesh: m, mat, flash: 0 });
    });

    // infield decor: palm trees + rocks + flag
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x7a5530, roughness: 1 });
    const leafM = new THREE.MeshStandardMaterial({ color: 0x2f9a3e, roughness: 0.9, flatShading: true });
    for (let i = 0; i < (T.trees ? 7 : 0); i++) {
      const a = (i / 7) * TAU + 0.3, d = 3.2 + (i % 3) * 0.5;
      const g = new THREE.Group();
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 2.2, 7), trunkM);
      tr.position.y = 1.1; tr.rotation.z = 0.12;
      g.add(tr);
      for (let l = 0; l < 6; l++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.5, 4), leafM);
        leaf.position.set(Math.cos(l) * 0.45, 2.3, Math.sin(l) * 0.45);
        leaf.rotation.set(Math.sin(l) * 1.2, 0, -Math.cos(l) * 1.2);
        g.add(leaf);
      }
      g.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
      R.add(g);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4, 8), postM);
    pole.position.y = 2;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ color: 0xff8a2a, side: THREE.DoubleSide }));
    flag.position.set(0.7, 3.5, 0);
    flag.name = 'flag';
    R.add(pole, flag);

    // grandstand crowd (instanced fans on three stepped rings)
    const fans: THREE.Vector3[] = [];
    for (let row = 0; row < 3; row++) {
      const rr = DR_OUTER + 2 + row * 1.0;
      const n = 70 + row * 12;
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(rr + 0.55, rr + 0.55, 0.5 + row * 0.6, 72, 1, true), new THREE.MeshStandardMaterial({ color: 0x59607a, roughness: 0.9, side: THREE.DoubleSide }));
      stand.position.y = (0.5 + row * 0.6) / 2;
      R.add(stand);
      for (let i = 0; i < n; i++) {
        const a = ((i + (row % 2) * 0.5) / n) * TAU;
        fans.push(new THREE.Vector3(Math.cos(a) * rr, 0.85 + row * 0.6, Math.sin(a) * rr));
      }
    }
    crowd = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshStandardMaterial({ roughness: 0.7 }), fans.length);
    const pal = ['#ff5a4f', '#3fa7ff', '#ffd23f', '#4cd964', '#a96bff', '#ff9f6b', '#ffffff'];
    fans.forEach((f, i) => {
      crowd!.setColorAt(i, col.set(pal[(i * 7 + (i >> 3)) % pal.length]));
      crowdBase.push(f);
      crowdPhase.push(Math.random() * 6);
      m4.makeTranslation(f.x, f.y, f.z);
      crowd!.setMatrixAt(i, m4);
    });
    R.add(crowd);
    // lamps
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2, rr = DR_OUTER + 6.2;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 4, 8), postM);
      p.position.set(Math.cos(a) * rr, 2, Math.sin(a) * rr);
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff0b0 }));
      l.position.set(p.position.x, 4.2, p.position.z);
      R.add(p, l);
    }
  }

  function makeParts(slot: number): ActorParts {
    const hex = kit.hex(slot);
    const inst = createCharacter(kit.look(slot), { ring: false });
    const g = new THREE.Group();
    const team = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.4, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.75, 0.28, 18), team);
    body.position.y = 0.22;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8ecf6, roughness: 0.3, metalness: 0.4 }));
    dome.position.y = 0.34; dome.scale.y = 0.6;
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.85, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.7, depthWrite: false }));
    glow.position.y = 0.04;
    g.add(body, dome, glow);
    inst.root.position.y = 0.3;
    return { inst, extra: g, shadow: 0.9, headY: 1.9, scale: 1.05 };
  }

  function makeObj(b: Body): THREE.Object3D {
    const g = new THREE.Group();
    switch (b.kind) {
      case 'crate': {
        const c = propObject('crateStar', 1.0, () => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0xe8c040 })); m.position.y = 0.45; return m; });
        const q = new TextSprite('#ffffff', 0.9); q.set('?'); q.sprite.position.y = 1.4;
        g.add(c, q.sprite);
        break;
      }
      case 'fruit': {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), new THREE.MeshStandardMaterial({ color: 0xf08a1c, roughness: 0.5, emissive: 0x602800, emissiveIntensity: 0.4 }));
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), new THREE.MeshStandardMaterial({ color: 0x3a9a2a }));
        leaf.position.y = 0.34;
        g.add(f, leaf);
        break;
      }
      case 'missile': {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.7, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8e8f0, metalness: 0.3, roughness: 0.4 }));
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: new THREE.Color(kit.hex(b.slot)) }));
        nose.position.z = 0.5;
        g.add(body, nose);
        break;
      }
      case 'mine': {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.22, 16), new THREE.MeshStandardMaterial({ color: 0x2a2c34, roughness: 0.5, metalness: 0.4 }));
        body.position.y = 0.11;
        const top = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
        top.position.y = 0.26; top.name = 'light';
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.72, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(b.slot)), transparent: true, opacity: 0.9, depthWrite: false }));
        ring.position.y = 0.03;
        g.add(body, top, ring);
        break;
      }
      case 'sludge': {
        const col = variant === 'toxic' ? 0x8aff2a : 0x6a8a2a;
        const p = new THREE.Mesh(new THREE.CircleGeometry(1.25, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false }));
        p.position.y = 0.05;
        const rim = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd8ff7a, transparent: true, opacity: 0.8, depthWrite: false }));
        rim.position.y = 0.06;
        g.add(p, rim);
        break;
      }
      case 'rod': {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.9, 0.12, 18), new THREE.MeshStandardMaterial({ color: 0x3a4050, roughness: 0.6 }));
        base.position.y = 0.06;
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.4, 14), new THREE.MeshStandardMaterial({ color: 0xff8a2a, roughness: 0.5, emissive: 0x401800, emissiveIntensity: 0.4 }));
        rod.name = 'rod'; rod.position.y = -0.35;
        g.add(rod, base);
        break;
      }
      case 'bat': {
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), new THREE.MeshStandardMaterial({ color: 0x5a1a2a, roughness: 0.6 }));
        const wings = new THREE.Group(); wings.name = 'wings';
        const wm = new THREE.MeshStandardMaterial({ color: 0x8a1a3a, side: THREE.DoubleSide, roughness: 0.7 });
        for (const sx of [-1, 1]) { const w = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6), wm); w.position.x = sx * 0.7; wings.add(w); }
        const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
        eyes.position.set(0, 0.08, 0.36);
        g.add(body, wings, eyes);
        break;
      }
    }
    return g;
  }

  const ord = (n: number) => ['1ST', '2ND', '3RD', '4TH'][n] ?? `${n + 1}TH`;
  const rankOf = (d: any, slot: number) => {
    const fin: number[] = d.finish ?? [];
    const ang: number[] = d.ang ?? [];
    let r = 0;
    for (let s = 0; s < 4; s++) {
      if (s === slot) continue;
      const fa = fin[slot] >= 0, fb = fin[s] >= 0;
      if (fb && !fa) r++;
      else if (fa && fb) { if (fin[s] < fin[slot] || (fin[s] === fin[slot] && s < slot)) r++; }
      else if (!fa && !fb && (ang[s] ?? 0) > (ang[slot] ?? 0)) r++;
    }
    return r;
  };

  return {
    id: 'dashRace',
    async preload() { await preloadCatalogFor('__none__', ['crate', 'crateStar']); loaded = true; },

    init(ctx, world) {
      variant = world.data.variant ?? 'dot';
      objs.clear(); bars.clear(); itemTxt.clear(); spinT.clear();
      kit = new Kit(ctx, 'dashRace', { bg: (THEMES[variant] ?? THEMES.dot).bg, fog: [45, 110], hemi: [0xfff4e0, 0x4a6a5a, 1.55], sun: [-6, 16, 8] });
      pads.length = 0; crowd = null; crowdPhase.length = 0; crowdBase.length = 0; finished.clear(); prevLap.fill(0); boostT.fill(0);
      build();
      ctx.frame(DR_OUTER + 5.5);
      if (!loaded) this.preload!().then(() => { for (const o of objs.values()) kit.root.remove(o); objs.clear(); kit?.reset(); });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data;
      pads.forEach((p, i) => {
        p.flash = Math.max(0, p.flash - dt * 2);
        p.mat.opacity = 0.75 + Math.sin(ctx.time * 6 + i * 1.7) * 0.2 + p.flash * 0.25;
        p.mesh.scale.setScalar(1 + p.flash * 0.25 + Math.sin(ctx.time * 6 + i) * 0.03);
      });
      if (crowd) {
        const cheer = kit.over.done ? 1.6 : 1;
        crowdBase.forEach((f, i) => {
          m4.makeTranslation(f.x, f.y + Math.abs(Math.sin(ctx.time * 5 * cheer + crowdPhase[i])) * 0.18 * cheer, f.z);
          crowd!.setMatrixAt(i, m4);
        });
        crowd.instanceMatrix.needsUpdate = true;
      }
      const flag = kit.root.getObjectByName('flag');
      if (flag) flag.rotation.y = Math.sin(ctx.time * 3) * 0.3;

      const seen = new Set<number>();
      const seenO = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const a = kit.actor(b, () => makeParts(b.slot));
          const boosting = (d.boost?.[b.slot] ?? 0) > 0;
          const turbo = !!d.turbo?.[b.slot];
          const stun = (d.stun?.[b.slot] ?? 0) > 0;
          const fin = (d.finish?.[b.slot] ?? -1) >= 0;
          a.update(b, dt, { role: fin && !kit.over.done ? 'win' : stun ? 'hit' : 'run', freeze: false, keepYaw: false });
          if (stun) { const t = (spinT.get(b.slot) ?? 0) + dt * 14; spinT.set(b.slot, t); a.holder.rotation.y = t; }
          if (boosting || turbo) {
            boostT[b.slot] -= dt;
            if (boostT[b.slot] <= 0) {
              boostT[b.slot] = 0.04;
              kit.fx.burst(b.x - b.vx * 0.06, 0.45, b.z - b.vz * 0.06, { shape: 'soft', color: turbo ? [0x6ad0ff, 0xffffff] : [0xffe14a, 0xff8a2a, 0xffffff], count: 2, speed: 0.6, size: 0.6, life: 0.35, gravity: 0, grow: 0.2, spread: 0.1 });
            }
          }
          // fuel bar + held item
          let bar = bars.get(b.slot);
          if (!bar) { bar = new HpBar(1.3); kit.root.add(bar.group); bars.set(b.slot, bar); (bar.group.children[1] as THREE.Sprite).material.color.set(0x38bdf8); }
          bar.group.visible = !kit.over.done && !fin;
          bar.group.position.set(b.x, a.headY + 0.5, b.z);
          const f = d.fuel?.[b.slot] ?? 0;
          bar.set(f);
          (bar.group.children[1] as THREE.Sprite).material.color.set(turbo ? 0xffffff : 0x38bdf8);
          let it = itemTxt.get(b.slot);
          if (!it) { it = new TextSprite('#ffffff', 0.7); kit.root.add(it.sprite); itemTxt.set(b.slot, it); }
          const item = d.item?.[b.slot] ?? 0;
          it.sprite.visible = item > 0 && !kit.over.done;
          if (item > 0) { it.set(item === 1 ? '🚀' : '💣'); it.sprite.position.set(b.x, a.headY + 1.1, b.z); }
        } else if (['crate', 'fruit', 'missile', 'mine', 'sludge', 'rod', 'bat'].includes(b.kind)) {
          seenO.add(b.id);
          let o = objs.get(b.id);
          if (!o) { o = makeObj(b); kit.root.add(o); objs.set(b.id, o); }
          o.visible = !((b.kind === 'crate' || b.kind === 'fruit') && b.cd > 0);
          o.position.set(b.x, 0, b.z);
          if (b.kind === 'crate' || b.kind === 'fruit') { o.position.y = 0.5 + Math.sin(ctx.time * 3 + b.id) * 0.12; o.rotation.y += dt * 1.8; }
          else if (b.kind === 'missile') { o.position.y = 0.7; o.rotation.y = Math.atan2(b.vx, b.vz); kit.fx.trail(b.x, 0.7, b.z, 0xffb030, 0.4, 0.3); }
          else if (b.kind === 'mine') { const arming = b.cd > 0; o.scale.setScalar(arming ? 0.8 : 1); const l = o.getObjectByName('light') as THREE.Mesh; (l.material as THREE.MeshBasicMaterial).color.set(arming ? 0x553030 : Math.sin(ctx.time * 9) > 0 ? 0xff3a2a : 0x661810); }
          else if (b.kind === 'rod') { const ext = b.dash > 0; const rod = o.getObjectByName('rod')!; rod.position.y += ((ext ? 1.0 : -0.35) - rod.position.y) * Math.min(1, dt * 14); }
          else if (b.kind === 'bat') { o.position.y = 1.4 + Math.sin(ctx.time * 6 + b.id) * 0.2; o.rotation.y = Math.atan2(b.vx, b.vz); const wing = o.getObjectByName('wings')!; wing.rotation.z = Math.sin(ctx.time * 18) * 0.5; }
          else if (b.kind === 'sludge') { o.scale.setScalar(1 + Math.sin(ctx.time * 2 + b.id) * 0.04); }
        }
      }
      for (const [id, o] of objs) if (!seenO.has(id)) { kit.root.remove(o); disposeTree(o); objs.delete(id); }
      kit.prune(seen);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const fx = kit.fx;
      if (kit.baseEvent(e)) return;
      const hex = e.s >= 0 ? kit.hex(e.s) : '#ffffff';
      switch (e.k) {
        case 'boost': {
          fx.ring(e.x, e.z, { color: 0xffd060, radius: 2.6, life: 0.4 });
          fx.sparks(e.x, 0.5, e.z, [0xffe14a, 0xff8a2a, 0xffffff], 14, 6);
          kit.actorForSlot(e.s)?.squash.kick(-0.5);
          let bi = -1, bd = 1e9;
          pads.forEach((p, i) => { const dd = Math.hypot(p.mesh.position.x - e.x, p.mesh.position.z - e.z); if (dd < bd) { bd = dd; bi = i; } });
          if (bi >= 0 && bd < 3) pads[bi].flash = 1;
          if (e.s === ctx.mySlot) kit.shake(0.12);
          break;
        }
        case 'lap': {
          const lap = Math.round(e.v * DR_LAPS);
          fx.text(e.x, 3, e.z, lap >= DR_LAPS - 1 ? 'FINAL LAP!' : `LAP ${lap + 1}`, { color: hex, size: 1.1, life: 1.3 });
          fx.sparks(e.x, 1, e.z, hex, 10, 4);
          break;
        }
        case 'turbo':
          fx.ring(e.x, e.z, { color: 0x6ad0ff, radius: 2.2, life: 0.35 });
          fx.sparks(e.x, 0.5, e.z, [0x6ad0ff, 0xffffff], 10, 6);
          if (e.s === ctx.mySlot) kit.shake(0.1);
          break;
        case 'pickup':
          fx.stars(e.x, 1.0, e.z, 8, [0xffe14a, 0xffffff]);
          fx.text(e.x, 2.4, e.z, e.v === 1 ? 'WEAPON!' : '+FUEL', { color: e.v === 1 ? '#ffe14a' : '#ff9a30', size: 0.9, life: 1.0 });
          break;
        case 'missile':
          fx.smoke(e.x, 0.7, e.z, 4, 0x888899);
          fx.sparks(e.x, 0.7, e.z, [0xffb030, 0xffffff], 8, 5);
          break;
        case 'mine':
          fx.ring(e.x, e.z, { color: hex, radius: 1.4, life: 0.3 });
          break;
        case 'explode':
          fx.burst(e.x, 0.8, e.z, { shape: 'soft', color: [0xff5a20, 0xffb030, 0xffe070], count: 22, speed: 5, size: 1.0, life: 0.7, up: 3, grow: 1.6 });
          fx.smoke(e.x, 1, e.z, 8, 0x3a3a40);
          fx.ring(e.x, e.z, { color: 0xffb040, radius: 3.2, life: 0.5 });
          kit.shake(0.4);
          break;
        case 'hit':
          fx.stars(e.x, 1.4, e.z, 8);
          fx.text(e.x, 2.6, e.z, 'SPUN OUT!', { color: '#ff6a5a', size: 1.0, life: 1.1 });
          kit.actorForSlot(e.s)?.hit(1);
          if (e.s === ctx.mySlot) kit.shake(0.3);
          break;
        case 'sludge':
          fx.burst(e.x, 0.3, e.z, { shape: 'soft', color: [0x8aff2a, 0x4a7a1a], count: 10, speed: 2.5, size: 0.5, life: 0.6, up: 2, gravity: 8 });
          fx.text(e.x, 2.2, e.z, 'YUCK!', { color: '#a8ff4a', size: 0.9, life: 0.9 });
          break;
        case 'finish': {
          const rk = rankOf(kit.world.data, e.s);
          fx.confetti(e.x, 1.5, e.z, 40);
          fx.text(e.x, 3.2, e.z, `${ord(rk)}!`, { color: '#ffe14a', size: 1.7, life: 2 });
          fx.ring(e.x, e.z, { color: hex, radius: 5, life: 0.8 });
          kit.shake(0.3);
          break;
        }
      }
    },

    hud(w, slot) {
      const d = w.data;
      if ((d.finish?.[slot] ?? -1) >= 0) return `${ord(rankOf(d, slot))} DONE`;
      return `${ord(rankOf(d, slot))} · L${Math.min(DR_LAPS, (d.lap?.[slot] ?? 0) + 1)}/${DR_LAPS}`;
    },

    dispose() {
      pads.length = 0; crowd = null;
      for (const o of objs.values()) kit.root.remove(o);
      for (const b of bars.values()) kit.root.remove(b.group);
      for (const t of itemTxt.values()) kit.root.remove(t.sprite);
      objs.clear(); bars.clear(); itemTxt.clear();
      kit.dispose();
    },
  };
}

