// Player characters: catalog models (Crash Bash roster) with a team ring, or a colourful procedural stand-in.
import * as THREE from 'three';
import { CHARACTERS, colorHex, type Look } from '../shared/look';
import { charEntry, getCatalog, loadCatalog, ModelInstance, ready, type CharEntry, type ModelRef } from './crash';

export interface CharacterOpts {
  /** Per-game catalog variant (e.g. 'tank', 'pogo') if the character entry has `variants[variant]`. */
  variant?: string;
  /** Draw the team ring under the feet (default true). */
  ring?: boolean;
}

type WithVariants = CharEntry & { variants?: Record<string, ModelRef> };

function entryFor(look: Look): WithVariants | undefined {
  const id = CHARACTERS[look.char % CHARACTERS.length]?.id;
  return id ? charEntry(id) : undefined;
}

function refFor(look: Look, variant?: string): ModelRef | undefined {
  const e = entryFor(look);
  if (!e) return undefined;
  return (variant && e.variants?.[variant]) || e;
}

/** Everything createCharacter() may need, for preloading (call after loadCatalog()). */
export function characterRefs(): ModelRef[] {
  const out: ModelRef[] = [];
  for (const c of getCatalog().characters as WithVariants[]) {
    out.push(c);
    if (c.variants) out.push(...Object.values(c.variants));
  }
  return out;
}

/** Loads the catalog and all character models. Await before building boards/lobbies/games. */
export async function preloadCharacters(): Promise<void> {
  await loadCatalog();
  await ready(characterRefs());
}

/** True when a real per-game variant model (pogo/polarBear/tank: character + vehicle) was used. */
export const usedVariant = (m: ModelInstance) => m.root.userData.variantUsed === true;

/** True when the instance is the procedural stand-in (no real model/animations). */
export const isProcedural = (m: ModelInstance) => m.root.userData.proc === true;

/** Flat translucent disc + solid ring in the team colour, lying just above the floor. */
export function teamRing(hex: string, radius = 0.85): THREE.Group {
  const g = new THREE.Group();
  g.name = 'teamRing';
  const col = new THREE.Color(hex);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 36).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.86, radius, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  disc.position.y = 0.03;
  ring.position.y = 0.035;
  disc.renderOrder = 3;
  ring.renderOrder = 3;
  g.add(disc, ring);
  return g;
}

export function createCharacter(look: Look, opts: CharacterOpts = {}): ModelInstance {
  const hex = colorHex(look);
  const ref = refFor(look, opts.variant);
  const variantUsed = !!(opts.variant && ref && ref !== entryFor(look));
  let inst: ModelInstance;
  const real = ref ? new ModelInstance(ref) : null;
  if (real && real.build()) {
    inst = real;
    // Catalog clones share geometry/materials. The team ring added below is per-instance.
    for (const child of inst.root.children) child.userData.shared = true;
    inst.play('idle');
  } else {
    inst = new ProcCharacter(CHARACTERS[look.char % CHARACTERS.length].id, hex);
  }
  if (opts.ring !== false) inst.root.add(teamRing(hex));
  inst.root.userData.hex = hex;
  inst.root.userData.variantUsed = variantUsed && !isProcedural(inst);
  return inst;
}

// ---------------------------------------------------------------- procedural stand-in

interface Style {
  skin: string;
  pants: string;
  hair?: string;
  hairKind?: 'spikes' | 'ponytail' | 'wisps' | 'tuft';
  ears?: 'round' | 'point';
  earColor?: string;
  snout?: 'short' | 'long' | 'koala';
  belly?: string;
  size?: number;
  head?: number;
  arms?: number;
  eyeColor?: string;
}

const STYLES: Record<string, Style> = {
  crash: { skin: '#f08a2a', pants: '#2a5ad0', hair: '#5a2d14', hairKind: 'spikes', snout: 'short', belly: '#f6c98a' },
  coco: { skin: '#e8ae78', pants: '#c8527a', hair: '#6a3418', hairKind: 'ponytail', snout: 'short' },
  tiny: { skin: '#e8921a', pants: '#3b3f8f', hair: '#2a1a10', hairKind: 'tuft', size: 1.3, head: 0.85, arms: 1.3 },
  dingodile: { skin: '#c9a06a', pants: '#6a4a2a', ears: 'point', earColor: '#8a6a3a', snout: 'long', belly: '#e8d0a0' },
  cortex: { skin: '#d6e8a0', pants: '#6a3a8f', hair: '#e8e060', hairKind: 'wisps', head: 1.4, size: 0.85, eyeColor: '#d03030' },
  brio: { skin: '#8ed06c', pants: '#e8e8f0', hair: '#f0602a', hairKind: 'wisps', head: 1.1 },
  koala: { skin: '#8d9aab', pants: '#2f6a8f', ears: 'round', earColor: '#aab6c4', snout: 'koala', size: 1.2, arms: 1.2, belly: '#c8d2dc' },
  rilla: { skin: '#7a4a28', pants: '#2c7a4a', hair: '#3a2210', hairKind: 'tuft', size: 1.15, arms: 1.5, belly: '#a8764a', ears: 'round', earColor: '#5a3418' },
};

const sph = new THREE.SphereGeometry(1, 20, 14);
const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
const box = new THREE.BoxGeometry(1, 1, 1);
const cone = new THREE.ConeGeometry(1, 1, 10);

function mat(color: string, rough = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}
function mesh(geo: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.scale.set(sx, sy, sz);
  o.position.set(x, y, z);
  return o;
}

class ProcCharacter extends ModelInstance {
  private cur = 'idle';
  private t = Math.random() * 10;
  private flinch = 0;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private tail: THREE.Object3D | null = null;
  private wrap = new THREE.Group();

  constructor(id: string, teamHex: string) {
    super(null);
    const st = STYLES[id] ?? STYLES.crash;
    const skin = mat(st.skin, 0.75), pants = mat(st.pants), team = mat(teamHex, 0.5);
    const dark = mat('#1b1220', 0.4), white = mat('#ffffff', 0.3);
    const s = st.size ?? 1;
    const wrap = this.wrap;
    wrap.scale.setScalar(s);
    this.root.add(wrap);
    this.root.userData.proc = true;

    // legs
    for (const [leg, x] of [[this.legL, -0.2], [this.legR, 0.2]] as const) {
      leg.position.set(x, 0.55, 0);
      leg.add(mesh(cyl, pants, 0.14, 0.4, 0.14, 0, -0.2, 0));
      leg.add(mesh(sph, dark, 0.19, 0.12, 0.27, 0, -0.5, 0.06));
      wrap.add(leg);
    }
    // body
    this.body.position.y = 0.55;
    wrap.add(this.body);
    this.body.add(mesh(sph, team, 0.42, 0.45, 0.34, 0, 0.42, 0));
    if (st.belly) this.body.add(mesh(sph, mat(st.belly, 0.8), 0.27, 0.3, 0.12, 0, 0.4, 0.26));
    this.body.add(mesh(cyl, pants, 0.4, 0.08, 0.33, 0, 0.08, 0)); // belt/shorts band
    // arms
    const as = st.arms ?? 1;
    for (const [arm, x] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(x * 0.46 * Math.min(1.2, as), 0.62, 0);
      arm.add(mesh(cyl, skin, 0.1 * as, 0.38 * as, 0.1 * as, 0, -0.18, 0));
      arm.add(mesh(sph, skin, 0.14 * as, 0.14 * as, 0.14 * as, 0, -0.4 * as, 0));
      this.body.add(arm);
    }
    // head
    const hs = st.head ?? 1;
    this.head.position.y = 0.98;
    this.body.add(this.head);
    const hr = 0.36 * hs;
    this.head.add(mesh(sph, skin, hr, hr * 0.95, hr, 0, hr * 0.9, 0));
    const ey = hr * 1.05, ez = hr * 0.78;
    for (const x of [-1, 1]) {
      this.head.add(mesh(sph, white, hr * 0.28, hr * 0.34, hr * 0.2, x * hr * 0.36, ey, ez));
      this.head.add(mesh(sph, mat(st.eyeColor ?? '#14101a', 0.3), hr * 0.12, hr * 0.17, hr * 0.1, x * hr * 0.36, ey - 0.01, ez + hr * 0.14));
    }
    // mouth
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(hr * 0.2, hr * 0.04, 6, 12, Math.PI), dark);
    mouth.position.set(0, hr * 0.62, hr * 0.95);
    mouth.rotation.z = Math.PI;
    this.head.add(mouth);
    // snout
    if (st.snout === 'short') this.head.add(mesh(sph, mat(st.belly ?? st.skin, 0.8), hr * 0.5, hr * 0.38, hr * 0.42, 0, hr * 0.75, hr * 0.78));
    if (st.snout === 'long') {
      this.head.add(mesh(box, mat(st.belly ?? st.skin, 0.8), hr * 0.5, hr * 0.4, hr * 0.9, 0, hr * 0.72, hr * 1.1));
      this.head.add(mesh(sph, dark, hr * 0.12, hr * 0.1, hr * 0.1, 0, hr * 0.9, hr * 1.58));
    }
    if (st.snout === 'koala') this.head.add(mesh(sph, dark, hr * 0.26, hr * 0.34, hr * 0.2, 0, hr * 0.82, hr * 0.95));
    // ears
    if (st.ears) {
      for (const x of [-1, 1]) {
        if (st.ears === 'round') this.head.add(mesh(sph, mat(st.earColor ?? st.skin), hr * 0.34, hr * 0.34, hr * 0.14, x * hr * 0.85, hr * 1.5, 0));
        else { const e = mesh(cone, mat(st.earColor ?? st.skin), hr * 0.25, hr * 0.7, hr * 0.15, x * hr * 0.6, hr * 1.85, 0); e.rotation.z = -x * 0.25; this.head.add(e); }
      }
    }
    // hair
    if (st.hair) {
      const hm = mat(st.hair, 0.5);
      if (st.hairKind === 'spikes') for (let i = 0; i < 5; i++) {
        const a = (i / 4 - 0.5) * 1.5;
        const sp = mesh(cone, hm, hr * 0.22, hr * 0.8, hr * 0.22, Math.sin(a) * hr * 0.8, hr * 1.78 + Math.cos(a) * 0.04, -hr * 0.15);
        sp.rotation.z = -a * 0.9; sp.rotation.x = -0.25;
        this.head.add(sp);
      }
      if (st.hairKind === 'ponytail') {
        this.head.add(mesh(sph, hm, hr * 1.02, hr * 0.62, hr * 1.02, 0, hr * 1.5, -hr * 0.12));
        this.tail = new THREE.Group();
        this.tail.position.set(0, hr * 1.2, -hr * 0.95);
        this.tail.add(mesh(sph, hm, hr * 0.28, hr * 0.7, hr * 0.28, 0, -hr * 0.45, -hr * 0.1));
        this.head.add(this.tail);
      }
      if (st.hairKind === 'wisps') for (let i = 0; i < 3; i++) {
        const w = mesh(cone, hm, hr * 0.12, hr * 0.7, hr * 0.12, (i - 1) * hr * 0.35, hr * 1.9, 0);
        w.rotation.z = (i - 1) * -0.5;
        this.head.add(w);
      }
      if (st.hairKind === 'tuft') this.head.add(mesh(sph, hm, hr * 0.5, hr * 0.3, hr * 0.6, 0, hr * 1.85, -hr * 0.1));
    }
    if (id === 'cortex') { // the famous "N"
      const n = mesh(box, mat('#ffd23f', 0.5), hr * 0.45, hr * 0.28, hr * 0.06, 0, hr * 1.5, hr * 0.92);
      this.head.add(n);
    }
  }

  override play(role: string) {
    if (role === this.cur) return;
    if (role === 'hit') this.flinch = 0.45;
    this.cur = role;
  }

  override update(dt: number) {
    this.t += dt;
    const t = this.t;
    this.flinch = Math.max(0, this.flinch - dt);
    const r = this.cur;
    let legS = 0, armS = 0, bob = 0, lean = 0, up = 0, headTilt = 0, armUp = 0;
    if (r === 'run') { legS = Math.sin(t * 15) * 0.95; armS = -legS * 0.9; bob = Math.abs(Math.sin(t * 15)) * 0.07; lean = 0.22; }
    else if (r === 'jump') { legS = 0.5; armUp = 1.2; lean = -0.05; }
    else if (r === 'win') { up = Math.abs(Math.sin(t * 7)) * 0.3; armUp = 2.6; legS = Math.sin(t * 14) * 0.3; }
    else if (r === 'lose') { lean = 0.35; headTilt = 0.4; armS = 0.1; }
    else { bob = Math.sin(t * 3) * 0.015; armS = Math.sin(t * 2.4) * 0.12; }
    this.legL.rotation.x = legS;
    this.legR.rotation.x = -legS;
    this.armL.rotation.x = -armS - armUp * 0.8;
    this.armR.rotation.x = armS - armUp * 0.8;
    this.armL.rotation.z = -0.15 - armUp * 0.25;
    this.armR.rotation.z = 0.15 + armUp * 0.25;
    this.body.position.y = 0.55 + bob + up;
    this.body.rotation.x = lean;
    this.head.rotation.x = headTilt;
    const f = this.flinch / 0.45;
    this.wrap.rotation.z = Math.sin(f * 20) * f * 0.25;
    this.wrap.rotation.x = -f * 0.3;
    if (this.tail) this.tail.rotation.x = 0.3 + Math.sin(t * (r === 'run' ? 14 : 3)) * (r === 'run' ? 0.5 : 0.1);
  }
}
