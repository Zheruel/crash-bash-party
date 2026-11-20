// Final scene = the real game's PODIUM level (id 43): the title-screen podium disc and machine (model 0379), the real
// pedestals by placing, the 744-758 podium characters on their own WIN / LOSE anim scripts, the trophy, the fireworks
// and the level's camera paths. Data: assets/stages/podium.json (tools/levels/podium.py), notes: re/notes/podium.md.
// The party adds one thing the game does not have: places are revealed one at a time (FinalOverlay), so pedestals
// and characters pop in on reveal() and the game's own ending (pull back, trophy, fireworks) starts on celebrate().
import * as THREE from 'three';
import { CHARACTERS, DISC_CHARACTER, colorHex, type Look } from '../../shared/look';
import { createCharacter } from '../characters';
import { ASSET_BASE, charEntry, getCatalog, loadCatalog, ModelInstance, ps1Material, ready, type ModelRef } from '../crash';
import { applyPose, ps1Pose } from '../games/ps1cam';
import { sfx } from '../shell/sound';
import type { Mode, Stage } from '../view';
import { PodiumCam, type CamData, type CamOut } from './podiumCam';
import { clamp01, ease, labelSprite } from './util';
import { hudFace, type HudSprite } from '../ui/ps1hud';

interface Script { seg: number[][]; loop: boolean }
interface PodChar {
  /** engine character 1..8, its in-game model (what the catalog entry points at) and its podium model */
  engine: number; base: number; model: number; clips: string[]; winWait: number[]; loseWait: number[]; cheer: number; sparks: number[];
  scripts: { winIdle: Script; win: Script; loseIdle: Script; lose: Script };
}
interface PodiumData {
  scale: number;
  /** 8 tie patterns x 4 places (best first): x, z, pedestal 1..4, loser flag */
  layouts: number[][][];
  pedestalHeight: number[];
  trophy: { pos: number[] };
  camera: CamData;
  sky: { H: number; layers: { prop: string; speed: number[] }[] };
  fireworks: { first: number; wait: number[]; life: number; x: number; y: number[]; z: number; heads: string[]; trails: string[]; bang: string[]; crackle: string[]; bangRate?: number[]; crackleRate?: number[] };
  cheer: string[];
  chars: Record<string, PodChar>;
}

let data: PodiumData | null = null;
let loading: Promise<boolean> | null = null;
/** Fetch the scene data and its models (podium set 0379, spark pack 0377, the eight podium characters). */
export function preloadPodium(): Promise<boolean> {
  loading ??= (async () => {
    await loadCatalog();
    const j = await fetch(`${ASSET_BASE}stages/podium.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!j?.podium) return false;
    const cat = getCatalog();
    await ready([cat.arenas.podium, ...Object.keys(cat.props).filter((k) => k.startsWith('podium')).map((k) => cat.props[k])]);
    data = j.podium as PodiumData;
    return true;
  })();
  return loading;
}

const TICK = 1 / 30;
const rnd = (n: number) => Math.floor(Math.random() * n);
/** cos table of the engine (0x80068bd6): 4096 * cos(a), a in 4096ths of a turn */
const T = (a: number) => Math.round(4096 * Math.cos(((a & 0xfff) * Math.PI) / 2048));
const SIN = (a: number) => T(a - 0x400);
/** PS1 node rotation (rx, ry, rz in 4096ths) in our mirrored world (x, -y, -z). */
const ps1Euler = (rx: number, ry: number, rz: number, out: THREE.Euler) => out.set((rx * Math.PI) / 2048, (-ry * Math.PI) / 2048, (-rz * Math.PI) / 2048, 'XYZ');

/** One podium character's animation, as the overlay runs it (FUN_800b92a0 + the anim VM FUN_800251a8). */
class Actor {
  /** script table index: 0 win idle, 1 win, 4 lose idle, 5 lose */
  state = 0;
  clip = 0; frame = 0; prevClip = -1; prevFrame = 0;
  lose = false;
  /** false until the celebration: breathe only */
  live = false;
  private cnt = 0;
  private seg = -1; private left = 0; private dir = 1;
  constructor(private c: PodChar) { this.step(); }

  private script() { const s = this.c.scripts; return this.state === 0 ? s.winIdle : this.state === 1 ? s.win : this.state === 4 ? s.loseIdle : s.lose; }
  private start(state: number) { this.state = state; this.seg = -1; this.left = 0; }

  tick() {
    if (this.live && (this.state === 0 || this.state === 4)) {
      if (this.cnt === 0) {
        const w = this.lose ? this.c.loseWait : this.c.winWait;
        this.start(this.lose ? 5 : 1);
        this.cnt = rnd(w[0]) + w[1];
      } else this.cnt--;
    }
    this.prevClip = this.clip; this.prevFrame = this.frame;
    this.step();
  }

  private step() {
    if (this.left > 0) { this.frame += this.dir; this.left--; return; }
    let sc = this.script();
    if (++this.seg >= sc.seg.length) {
      if (!sc.loop) { this.state = this.state === 1 ? 0 : 4; sc = this.script(); }
      this.seg = 0;
    }
    const [dir, n, clip, f0] = sc.seg[this.seg];
    this.dir = dir; this.left = n - 1; this.clip = clip; this.frame = f0;
  }

  /** frame to show `a` of the way into the current tick (in-between frames only inside one run of a clip) */
  at(a: number) { return this.prevClip === this.clip && Math.abs(this.frame - this.prevFrame) === 1 ? this.prevFrame + (this.frame - this.prevFrame) * a : this.frame; }
}

interface Entry {
  rank: number; slot: number;
  holder: THREE.Group;
  mi: ModelInstance;
  actor: Actor | null;
  t: number; revealed: boolean;
  /** the layout's own loser flag (everyone below the top pedestal) */
  lose: boolean;
  /** head height above the floor, world units */
  top: number;
}

const SPARKS = 12, SEGS = 8, QUADS = SEGS - 2;
/** One rocket burst (object 0x1628: init FUN_800b9d1c / FUN_800b9e90, per frame FUN_800ba374 / FUN_800ba1b4). */
class Firework {
  readonly group = new THREE.Group();
  private age = 0;
  private fading = false;
  private bright = 0;
  private dark = 0;
  private x: Float32Array; private y: Float32Array; private px: Float32Array; private py: Float32Array; private ang: Float32Array;
  private vx: number[] = []; private vy: number[] = [];
  private heads: THREE.Mesh[] = [];
  private headMat: THREE.Material | null = null;
  private trail: THREE.Mesh;

  constructor(private k: number, private ox: number, private oy: number, private oz: number, head: THREE.Mesh | null, trailMat: THREE.Material) {
    const n = SPARKS * SEGS;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.px = new Float32Array(n); this.py = new Float32Array(n); this.ang = new Float32Array(n);
    for (let s = 0; s < SPARKS; s++) {
      const a = (SPARKS - s) * 0x200;
      for (let i = 0; i < SEGS; i++) { this.x[s * SEGS + i] = SIN(a) >> 6; this.y[s * SEGS + i] = (T(a) >> 6) - 0x400; }
      this.vy.push((T(a) >> 4) + rnd(0x40) - rnd(0x40));
      this.vx.push((SIN(a) >> 4) + rnd(0x40) - rnd(0x40));
    }
    if (head) {
      this.headMat = ps1Material(head.material as THREE.Material);
      for (let s = 0; s < SPARKS; s++) {
        const m = new THREE.Mesh(head.geometry, this.headMat);
        m.scale.set(k, -k, -k);
        m.renderOrder = 6;
        this.heads.push(m);
        this.group.add(m);
      }
    }
    const g = new THREE.BufferGeometry();
    const q = SPARKS * QUADS;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(q * 12), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(q * 12), 3));
    const uv = new Float32Array(q * 8), idx: number[] = [];
    for (let i = 0; i < q; i++) { uv.set([0, 1, 1, 1, 0, 0, 1, 0], i * 8); idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.trail = new THREE.Mesh(g, trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 5;
    this.group.add(this.trail);
    this.tick();
  }

  /** false when the burst is over */
  tick(): boolean {
    const { x, y, px, py, ang, k } = this;
    if (++this.age === 20) this.fading = true;
    if (this.fading) this.dark = Math.min(1, this.dark + 0x200 / 0x1000);
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const wz = -this.oz * k;
    const put = (v: number, lx: number, ly: number) => pos.setXYZ(v, (this.ox + lx) * k, -(this.oy + ly) * k, wz);
    for (let s = 0; s < SPARKS; s++) {
      const o = s * SEGS;
      let ax = 0, ay = 0, bx = 0, by = 0;
      for (let i = 0; i < SEGS; i++) {
        const j = o + i;
        if (i === 0) {
          px[j] = x[j]; py[j] = y[j];
          this.vy[s] = ((this.vy[s] + 6) * 0xe6) >> 8;
          this.vx[s] = (this.vx[s] * 0xe6) >> 8;
          x[j] += this.vx[s]; y[j] += this.vy[s];
        } else {
          const nx = px[j - 1], ny = py[j - 1];
          px[j] = x[j]; py[j] = y[j];
          x[j] = nx; y[j] = ny;
          ang[j] = Math.atan2(px[j] - x[j], py[j] - y[j]);
        }
        // the game keeps one brightness word per spark: a ramp along the trail, then a x0.86 cascade once fading
        this.bright = this.fading ? (this.bright * 0xdc) >> 8 : 0xff - ((i * 0xff) >> 3);
        // cross-section of the ribbon at this joint (the game's own, lopsided, pair of offsets)
        const w = 0x80 - 16 * i, c = Math.cos(ang[j]), sn = Math.sin(ang[j]);
        const nax = i === 0 ? x[j] + 0x80 : x[j] + w * c, nay = i === 0 ? y[j] + 0x80 : y[j] - w * sn;
        const nbx = i === 0 ? x[j] + 0x80 : x[j] + w * sn, nby = i === 0 ? y[j] - 0x80 : y[j] - w * c;
        if (i >= 2) {
          const v = (s * QUADS + i - 2) * 4, b = this.bright / 128;
          put(v, bx, by); put(v + 1, nbx, nby); put(v + 2, ax, ay); put(v + 3, nax, nay);
          for (let n = 0; n < 4; n++) col.setXYZ(v + n, b, b, b);
        }
        ax = nax; ay = nay; bx = nbx; by = nby;
      }
      this.heads[s]?.position.set((this.ox + x[o]) * k, -(this.oy + y[o]) * k, wz);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    (this.headMat as THREE.MeshBasicMaterial | null)?.color.setScalar(1 - this.dark);
    return this.age < 30;
  }

  face(q: THREE.Quaternion) { for (const h of this.heads) h.quaternion.copy(q); }
  dispose() { this.trail.geometry.dispose(); this.headMat?.dispose(); }
}

export class PodiumScene implements Mode {
  readonly root = new THREE.Group();
  readonly background = new THREE.Color(0x000000); // the level's own sky sphere covers the frame
  private entries: Entry[] = [];
  private built = false;
  private pending: (() => void) | null = null;
  private k = 3 / 1024;
  private cam: PodiumCam | null = null;
  private prev: CamOut | null = null;
  private acc = 0;
  private frame = 0;
  private skyRoot = new THREE.Group();
  private sky: { g: THREE.Group; speed: number[] }[] = [];
  private trophy: THREE.Group | null = null;
  private trophyOn = false;
  private trophyScale = 0;
  private live = false;
  /** run the camera as the game does (no waiting for the party's reveal) */
  private auto = false;
  private fwTimer = 0;
  private fwColors = [0, 1];
  private fwHeads: (THREE.Mesh | null)[] = [];
  private fwMats: THREE.Material[] = [];
  private fireworks: Firework[] = [];
  private fwGroup = new THREE.Group();
  private actors = new THREE.Group();
  private cheer = '';
  /** score strip (FUN_800b9b0c, HUD object 6): y in the HUD's half-line units, 540 = off screen, 340 = up */
  private stripY = 540;
  /** Black cover for the level fade from black (one step per game frame, measured on the real game). */
  private fadeEl: HTMLDivElement | null = null;
  /** frames left in the 240-frame hold once up (then it slides back down, phases 4-5); -1 = not up yet */
  private stripHold = -1;
  private stripSeen = false;
  private stripLooks: Look[] = [];
  private stripPts: number[] = [];
  /** the strip's spinning trophy (HUD pack 0732 part0), kept in front of the camera at the strip's centre */
  private stripTrophy: THREE.Group | null = null;
  private stripTrophyH = 1;

  constructor() {
    // only the stand-in characters are lit; the PS1 models carry their own vertex lighting
    this.root.add(new THREE.HemisphereLight(0xdfeaff, 0x20404a, 2.2));
    const sun = new THREE.DirectionalLight(0xfff0d0, 2);
    sun.position.set(2, 8, 8);
    this.root.add(sun, this.skyRoot, this.actors, this.fwGroup);
    this.skyRoot.matrixAutoUpdate = false;
  }

  /** Stage, sky, trophy and the spark parts: once, when the data and models are there. */
  private build(d: PodiumData) {
    if (this.built) return;
    this.built = true;
    this.k = d.scale / 1024;
    const cat = getCatalog();
    const inst = (ref: ModelRef | undefined) => { const m = new ModelInstance(ref ?? null); return m.build() ? m : null; };
    const stage = inst(cat.arenas.podium);
    if (stage) this.root.add(stage.root);
    for (const l of d.sky.layers) {
      const m = inst(cat.props[l.prop]);
      if (!m) continue;
      // drawn first, behind everything, like the game's backdrop pass
      m.root.traverse((o) => {
        const me = o as THREE.Mesh;
        if (!me.isMesh || !me.visible) return;
        const mats = (Array.isArray(me.material) ? me.material : [me.material]).map((x) => { const c = ps1Material(x); c.depthTest = false; c.depthWrite = false; return c; });
        me.material = Array.isArray(me.material) ? mats : mats[0];
        me.renderOrder = -20 + this.sky.length;
        me.frustumCulled = false;
      });
      const g = new THREE.Group();
      g.add(m.root);
      this.skyRoot.add(g);
      this.sky.push({ g, speed: l.speed });
    }
    const tr = inst(cat.props.podiumTrophy);
    if (tr) {
      this.trophy = new THREE.Group();
      this.trophy.add(tr.root);
      this.trophy.visible = false;
      this.root.add(this.trophy);
    }
    const st = inst(cat.props.podiumStripTrophy);
    if (st) {
      st.root.traverse((o) => {
        const me = o as THREE.Mesh;
        if (!me.isMesh) return;
        const mats = (Array.isArray(me.material) ? me.material : [me.material]).map((x) => { const c = ps1Material(x); c.depthTest = false; c.depthWrite = false; return c; });
        me.material = Array.isArray(me.material) ? mats : mats[0];
        me.renderOrder = 60;
        me.frustumCulled = false;
      });
      // size from the drawn part only (the pack's other parts sit hidden in the same root)
      const box = new THREE.Box3();
      st.root.updateMatrixWorld(true);
      st.root.traverse((o) => { const me = o as THREE.Mesh; let v = true; for (let q: THREE.Object3D | null = me; q; q = q.parent) v &&= q.visible; if (me.isMesh && v) box.expandByObject(me); });
      const c = box.getCenter(new THREE.Vector3());
      st.root.position.sub(c);
      this.stripTrophyH = Math.max(1e-4, box.max.y - box.min.y);
      this.stripTrophy = new THREE.Group();
      this.stripTrophy.add(st.root);
      this.stripTrophy.visible = false;
      this.root.add(this.stripTrophy);
    }
    const sp = inst(cat.props.podiumSparks);
    const meshes: THREE.Mesh[] = [];
    sp?.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    this.fwHeads = d.fireworks.heads.map((name) => meshes.find((me) => me.name === name || me.parent?.name === name) ?? null);
    const loader = new THREE.TextureLoader();
    this.fwMats = d.fireworks.trails.map((p) => {
      const map = loader.load(ASSET_BASE + p);
      map.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    });
  }

  /** order = slots best-first; key[slot] = standing (equal keys share a place, as tied scores do in the game). */
  setup(order: number[], looks: Look[], names: string[], key?: number[]) {
    this.pending = () => this.place(order, looks, names, key ?? order.map((_, i) => -order.indexOf(i)));
    if (data) this.pending(); else void preloadPodium().then((ok) => { if (ok) this.pending?.(); });
  }

  private place(order: number[], looks: Look[], names: string[], key: number[]) {
    const d = data!;
    this.pending = null;
    this.build(d);
    this.reset(d);
    for (const e of this.entries) this.actors.remove(e.holder);
    const k = this.k, cat = getCatalog(), chars = Object.values(d.chars);
    // FUN_800b8bc8: which of the eight tie patterns
    const [c1, c2, c3, c4] = order.map((s) => key[s]);
    const L = c1 === c4 ? 7 : c2 === c4 ? 5 : c1 === c3 ? 6 : c3 === c4 && c1 !== c2 ? 1 : c2 === c3 ? 2 : c1 === c2 ? (c3 !== c4 ? 3 : 4) : 0;
    this.entries = order.map((slot, rank) => {
      const [x, z, ped, lose] = d.layouts[L][rank];
      const look = looks[slot] ?? { char: 0, color: 0 };
      const id = CHARACTERS[look.char % CHARACTERS.length].id;
      const custom = cat.props[`podiumChar_${id}`];
      const pc = custom ? chars.find((c) => c.engine === DISC_CHARACTER[look.char]) : chars.find((c) => c.base === charEntry(id)?.model);
      const h = d.pedestalHeight[Math.min(4, Math.max(1, ped)) - 1] * k;
      const holder = new THREE.Group();
      holder.position.set(x * k, 0, -z * k);
      holder.visible = false;
      if (ped > 1) {
        const p = new ModelInstance(cat.props[`podiumPed${Math.min(4, ped)}`] ?? null);
        if (p.build()) holder.add(p.root);
      }
      let mi = new ModelInstance(custom ?? (pc ? cat.props[`podiumChar_${pc.engine}`] : null) ?? null);
      let actor: Actor | null = null;
      if (pc && mi.build()) actor = new Actor(pc);
      else { mi = createCharacter(look, { ring: false }); mi.play('idle'); }
      mi.root.position.y = h;
      holder.add(mi.root);
      // name plate at the feet: the trophy and the fireworks own the space above the heads
      const label = labelSprite(names[slot] ?? '', colorHex(look));
      label.scale.set(1.5, 0.375, 1);
      label.position.set(0, ped > 1 ? h - 0.24 : 0.22, ped > 1 ? 0.84 : 0.7);
      holder.add(label);
      this.actors.add(holder);
      return { rank, slot, holder, mi, actor, t: 0, revealed: false, lose: !!lose, top: h + (charEntry(id)?.height ?? 1.8) };
    });
    const w = looks[order[0]] ?? { char: 0, color: 0 };
    const eng = DISC_CHARACTER[w.char % DISC_CHARACTER.length];
    const wc = chars.find((c) => c.base === charEntry(CHARACTERS[w.char % CHARACTERS.length].id)?.model) ?? chars.find((c) => c.engine === eng);
    this.fwColors = wc?.sparks ?? [0, 1];
    this.cheer = d.cheer[wc?.cheer ?? 0] ?? '';
    for (const e of this.entries) this.poseOf(e, 1);
  }

  private reset(d: PodiumData) {
    this.cam = new PodiumCam(d.camera);
    this.prev = { ...this.cam.out };
    this.frame = 0;
    this.acc = 0;
    this.live = false;
    this.auto = false;
    this.trophyOn = false;
    this.trophyScale = 0;
    if (this.trophy) this.trophy.visible = false;
    this.fwTimer = 0;
    this.stripY = 540;
    this.stripHold = -1;
    this.stripSeen = false;
    for (const f of this.fireworks) { this.fwGroup.remove(f.group); f.dispose(); }
    this.fireworks = [];
  }

  reveal(rank: number) {
    const e = this.entries.find((x) => x.rank === rank);
    if (e && !e.revealed) { e.revealed = true; e.t = 0; e.holder.visible = true; }
  }
  revealed(rank: number) { return !!this.entries.find((x) => x.rank === rank)?.revealed; }

  /** The game's ending: winners cheer, the rest sulk, the camera pulls back, the trophy and the fireworks appear. */
  celebrate(winners: number[]) {
    for (const e of this.entries) {
      this.reveal(e.rank);
      const win = winners.includes(e.slot);
      if (e.actor) { e.actor.lose = !win; e.actor.live = true; } else e.mi.play(win ? 'win' : 'lose');
    }
    this.cam?.pullBack();
    this.trophyOn = true;
    this.live = true;
    this.fwTimer = 10;
    if (this.cheer) sfx.playFile(this.cheer, 0.7, true);
  }

  /** The scene exactly as the game plays it: everyone in place from the first frame, camera and fireworks on the game's clock. */
  playReal(elapsedFrames = 0) {
    if (!data) return;
    this.reset(data);
    for (const e of this.entries) {
      e.revealed = true; e.t = 1; e.holder.visible = true;
      if (e.actor) { e.actor.lose = e.lose; e.actor.live = true; } else e.mi.play(e.lose ? 'lose' : 'win');
    }
    this.auto = true;
    this.live = true;
    this.fwTimer = data.fireworks.first;
    if (this.cheer && elapsedFrames < 2) sfx.playFile(this.cheer, 0.7, true);
    for (let i = 0; i < elapsedFrames; i++) this.tick(data, false);
  }

  /** The engine's level fade-in: black, then 19 / 37 / 58 / 74 / 93 / 100 % over six 30 Hz frames (emulator capture). */
  private fade(stage: Stage, f: number) {
    if (!this.fadeEl) {
      const el = document.createElement('div');
      el.className = 'scene-fade';
      stage.renderer.domElement.after(el);
      this.fadeEl = el;
    }
    const lit = [0, 0.19, 0.37, 0.58, 0.74, 0.93][f] ?? 1;
    this.fadeEl.style.opacity = String(1 - lit);
  }

  /** Run n game frames at once (reference comparisons). */
  advance(n: number) { if (data && this.cam) for (let i = 0; i < n; i++) this.tick(data); }

  /** World point above a slot's head, for UI anchors. */
  headOf(slot: number, out = new THREE.Vector3()) {
    const e = this.entries.find((x) => x.slot === slot);
    return e ? out.set(e.holder.position.x, e.top + 0.4, e.holder.position.z) : out.set(0, 3, 0);
  }

  leave(stage: Stage) {
    if (this.fadeEl) this.fadeEl.style.opacity = '0';
    // applyPose leaves the off-centre PS1 frustum behind: hand the camera back square
    stage.camera.aspect = innerWidth / Math.max(1, innerHeight);
  }

  private poseOf(e: Entry, a: number) { if (e.actor) e.mi.pose(e.actor.clip, e.actor.at(a)); }

  /** One 30 Hz game frame. */
  private tick(d: PodiumData, audible = true) {
    this.frame++;
    this.prev = { ...this.cam!.out };
    this.cam!.step(this.auto);
    if (this.cam!.phase >= 2) this.trophyOn = true;
    // phase 3: the score strip slides up 5 a frame from 540 to 340 (the party holds there: no phase 4/5 slide-out)
    if (this.cam!.phase >= 3) {
      if (this.stripHold < 0) {
        this.stripSeen = true;
        this.stripY = Math.max(340, this.stripY - 5);
        if (this.stripY === 340) this.stripHold = 240;
      } else if (this.stripHold > 0) this.stripHold--;
      else this.stripY = Math.min(540, this.stripY + 5);
    }
    for (const e of this.entries) if (e.revealed) e.actor?.tick();
    if (this.trophyOn && this.trophyScale < 0x1000) {
      // FUN_800b9538: grows from nothing, 1/32 of the rest per frame
      this.trophyScale += (0x1000 - this.trophyScale) >> 5;
      if (this.trophyScale > 0xeff) this.trophyScale = 0x1000;
    }
    this.fireworks = this.fireworks.filter((f) => { if (f.tick()) return true; this.fwGroup.remove(f.group); f.dispose(); return false; });
    if (this.live && --this.fwTimer < 0) {
      // FUN_800b8f50: a burst somewhere over the back of the scene every 10-29 frames, one of the winner's two colours
      const fw = d.fireworks, c = this.fwColors[rnd(2)];
      const f = new Firework(this.k, rnd(fw.x) - rnd(fw.x), rnd(fw.y[1]) + fw.y[0], fw.z + 0x2000, this.fwHeads[c] ?? null, this.fwMats[c]);
      this.fireworks.push(f);
      this.fwGroup.add(f.group);
      const a = rnd(6), b = rnd(6);
      // six ids each over three samples: the second three are the same bangs pitched down (tone centre notes, VAB 0181)
      if (audible) {
        sfx.playFile(fw.bang[a % 3], 0.45, false, fw.bangRate?.[a] ?? 1);
        sfx.playFile(fw.crackle[b >> 1], 0.45, false, fw.crackleRate?.[b] ?? 1);
      }
      this.fwTimer = rnd(fw.wait[0]) + fw.wait[1];
    }
  }

  update(dt: number, _t: number, stage: Stage) {
    const d = data;
    this.fade(stage, d && this.cam ? this.frame : 0);
    if (!d || !this.cam || !this.prev) return;
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= TICK) { this.acc -= TICK; this.tick(d); }
    const a = this.acc / TICK, k = this.k;
    // camera: the engine block, eased between the two last game frames
    const p = this.prev, o = this.cam.out;
    const mix = (x: number, y: number) => x + (y - x) * a;
    const cam = stage.camera;
    applyPose(cam, ps1Pose({ x: 0, y: 0, z: mix(p.z, o.z), tx: mix(p.tx, o.tx), ty: mix(p.ty, o.ty), tz: mix(p.tz, o.tz), pitch: mix(p.pitch, o.pitch), yaw: mix(p.yaw, o.yaw), H: mix(p.H, o.H) }, { scale: d.scale }));
    cam.updateMatrixWorld();
    // sky layers: centred on the camera, tumbling, seen through the game's wider backdrop lens (H 320 against 512)
    const f = this.frame + a, s = d.sky.H / mix(p.H, o.H);
    const q = cam.quaternion, m = this.skyRoot.matrix;
    m.compose(cam.position, q, new THREE.Vector3(s, s, 1)).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q.clone().invert()));
    this.skyRoot.matrixWorldNeedsUpdate = true;
    for (const l of this.sky) ps1Euler((f * l.speed[0]) / 4096, (f * l.speed[1]) / 4096, (f * l.speed[2]) / 4096, l.g.rotation);
    // trophy: bobbing and rocking on the level clock
    if (this.trophy) {
      this.trophy.visible = this.trophyOn && this.trophyScale > 0;
      const t = f, tp = d.trophy.pos;
      const x = tp[0] + (SIN(t * 0x28) * 0x118) / 4096, y = tp[1] + (SIN(t * 0x2d) + SIN(t * 0x50)) / 64;
      this.trophy.position.set(x * k, -y * k, -tp[2] * k);
      ps1Euler(SIN(t * 0x46) / 16, (SIN(t * 0x8c) + 0x800) / 32, (SIN(t * 0x46) + SIN(t * 100)) / 32, this.trophy.rotation);
      this.trophy.scale.setScalar(this.trophyScale / 4096);
    }
    for (const e of this.entries) {
      if (!e.revealed) continue;
      e.t += dt;
      e.holder.scale.setScalar(Math.max(0.001, ease.back(clamp01(e.t / 0.35))));
      if (e.actor) this.poseOf(e, a); else e.mi.update(dt);
    }
    for (const fw of this.fireworks) fw.face(q);
    this.placeStripTrophy(cam, f);
  }

  /** What the strip shows: the seats' looks and points (the game's tournament points, two digits). */
  setStrip(looks: Look[], points: number[]) { this.stripLooks = looks; this.stripPts = points; }

  /** The strip has come up (it may have left again since). */
  get stripShown() { return this.stripSeen; }
  /** The strip has come up and gone again (the game's phase 5). */
  get stripDone() { return this.stripSeen && this.stripHold === 0 && this.stripY >= 540; }
  /** Cross skips the hold, as in the game. */
  skipStrip() { if (this.stripHold > 0) this.stripHold = 0; }

  /** Strip lines below their resting place (0 = up, 100 = off screen). */
  private get stripDrop() { return (this.stripY - 340) / 2; }

  /**
   * The score strip as the game lays it out (measured on native frames at frame 300): an additive frame (132,130,0)
   * round lines 186-222, the four faces in seat order with their two-digit points, the spinning trophy in the middle.
   * Native 512x240 HUD units (y without the picture's 8-line offset); null while it is off screen.
   */
  stripHud(): HudSprite[] | null {
    if (this.stripY >= 540 || !this.stripLooks.length) return null;
    const dy = this.stripDrop, edge = `${ASSET_BASE}hud/stripEdge.png`;
    const out: HudSprite[] = [
      { tex: edge, x: 29, y: 178 + dy, w: 453, h: 4, add: true },
      { tex: edge, x: 29, y: 213 + dy, w: 453, h: 2, add: true },
      { tex: edge, x: 29, y: 182 + dy, w: 3, h: 31, add: true },
      { tex: edge, x: 479, y: 182 + dy, w: 3, h: 31, add: true },
    ];
    const FACE_X = [35, 121, 305, 391], NUM_X = [81, 171, 350, 440];
    for (let i = 0; i < 4; i++) {
      const look = this.stripLooks[i];
      if (!look) continue;
      out.push({ tex: hudFace(look.char), x: FACE_X[i], y: 179 + dy, w: 64, h: 40 });
      const n = String(Math.max(0, Math.min(99, Math.floor(this.stripPts[i] ?? 0)))).padStart(2, '0');
      [...n].forEach((c, j) => out.push({ tex: `${ASSET_BASE}hud/sm${c}.png`, x: NUM_X[i] + j * 12, y: 201 + dy, w: 20, h: 13 }));
    }
    return out;
  }

  /** Keep the strip's trophy in front of the camera at the strip centre (x 256, line 196, ~22 lines tall), spinning. */
  private placeStripTrophy(cam: THREE.PerspectiveCamera, f: number) {
    const tr = this.stripTrophy;
    if (!tr) return;
    tr.visible = this.stripY < 540 && this.stripLooks.length > 0;
    if (!tr.visible) return;
    const W = innerWidth, H = Math.max(1, innerHeight);
    const h43 = Math.min(H, (W * 3) / 4);
    const py = (H - h43) / 2 + ((196 + this.stripDrop) / 240) * h43;
    const D = 10, P5 = cam.projectionMatrix.elements[5];
    const p = new THREE.Vector3(0, 1 - (2 * py) / H, 0.5).unproject(cam);
    p.sub(cam.position).normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    tr.position.copy(cam.position).addScaledVector(p, D / Math.max(1e-3, p.dot(fwd)));
    tr.scale.setScalar((((22 / 240) * h43) / H) * ((2 * D) / P5) / this.stripTrophyH);
    tr.quaternion.copy(cam.quaternion);
    tr.rotateY((f * 0x40 * Math.PI) / 2048);
  }
}
