// Keg Kaboom view: the real village yard (model 0609: dirt ring inside a low stone wall, houses and windmill on the hills),
// real powder kegs (pack 0738) and the per-character barrel-carrier models (864-878). Fixed camera fitted against the real
// game (docs/reference/kegKaboom). Everything drawn comes from the 30 Hz sim (`KKData`); players use the game's own anim scripts.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { KK_FLAME_R, KK_S, animStart, animStep, kkPose, kkX, kkZ, type KKData, type KKeg, type KNode, type KPick, type KSpark } from '../../shared/games/kegKaboom';
import { createCharacter } from '../characters';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { PartBatch, preloadFx } from './realFx';
import { playVoiceId } from '../shell/voice';
import { DISC_CHARACTER } from '../../shared/look';
/** voice ids in the Keg Kaboom anim scripts per engine character (re/dumps/L30.ram, table 0x8009d29c): 0x65 jump rise and 0x67 land.
 *  The game's own data, quirks included (cortex jumps with tiny's id, dingodile lands with it). */
const KK_JUMP_VOICE: Record<number, number> = { 1: 0xc, 2: 0x3e, 3: 0x138, 4: 0xa2, 5: 0x138, 6: 0x16a, 7: 0x106, 8: 0xd4 };
const KK_LAND_VOICE: Record<number, number> = { 1: 0xd, 2: 0x3f, 3: 0x71, 4: 0xa3, 5: 0x139, 6: 0x16b, 7: 0x139, 8: 0xd5 };
import { applyPose as applyCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { scoreHud } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';

const S = 3.398;
const MAX_FIRE = 600;
const MAX_NODES = 1000;
/** height of the held-item node over the feet (estimate: just above the carried barrel) */
const HELD_Y = 2.6;

/** Camera fitted to the real frame (image-difference search), arena recentred on its floor: sim units. */
export const KK_CAM = { pos: [1.2, 9.552, 17.82] as [number, number, number], look: [1.204, 1.688, -0.508] as [number, number, number], fov: 43.76, aspect: 4 / 3 };

/** Sky card (sunset gradient with the sun) hung far behind the hills. */
const SKY = { pos: [18, 3, -70] as [number, number, number], k: 2.6 };
const KEG_PROPS = ['kkBarrel', 'kkBarrelB', 'kkBarrelGold', 'kkBarrelSilver'];
const PROPS = [...KEG_PROPS, 'kkPickup', 'kkFlame', 'kkBlades', 'kkMill', 'kkSky', ...CHARACTERS.map((c) => 'kkCarry_' + c.id)];
/** Object pack 0738 (kegs, powder, sparks, blasts), shared pickups 0736, HUD digits 0732 (floating scores). */
const PACK = 738, PICKUPS = 736, DIGITS = 732;

/**
 * Level sound bank 0177: the game's sound ids (FUN_80022660) map through the VAB tone table to sample (vag - 1).
 * keg chain pop 0x750+p -> 9+p (silver 0x754 -> 13, gold 0x755 -> 14); keg explosion table 0x9ec rand(4) -> 8,7,6,5;
 * fuse hiss table 0x9fc rand(4) -> 4,3,4,3; shock pickup 0x439 -> 20, shock wave 0x43a -> 21 (those two live in bank 0164).
 */
const SAMPLE_FILE: Record<number, string> = { 0: 'sfx/0154/23.mp3', 1: 'sfx/0154/24.mp3', 19: 'sfx/0165/14.mp3', 20: 'sfx/0164/25.mp3', 21: 'sfx/0164/26.mp3' };
const BANK = (n: number) => SAMPLE_FILE[n] ?? `sfx/0177/${n}.mp3`;
const BOOM_SAMPLE = [8, 7, 6, 5];
const HISS_SAMPLE = [4, 3, 4, 3];

interface KegV { group: THREE.Group; body: THREE.Object3D; kind: number }

/** Drive a model instance to an exact keyframe: clip = gltf animation (group), frame = logic frame (the clips are sampled at 30 fps). */
function applyPose(inst: { root: THREE.Object3D }, clip: number, frame: number) {
  const o = inst as unknown as { mixer: THREE.AnimationMixer | null; clips: THREE.AnimationClip[] };
  const mx = o.mixer, c = o.clips?.[clip];
  if (!mx || !c) return;
  const act = mx.clipAction(c);
  for (const a of (mx as unknown as { _actions: THREE.AnimationAction[] })._actions) if (a !== act) a.setEffectiveWeight(0);
  act.enabled = true; act.setEffectiveWeight(1); act.play();
  act.time = Math.min(c.duration, frame / 30);
  mx.update(0);
}

export function createKegKaboomView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let built: THREE.Group;
  const kegs = new Map<number, KegV>();
  const picks = new Map<number, THREE.Object3D>();
  /** the shock charge shows as the pickup over its holder's head (the game's held-item node, pack 0736 part 11) */
  const held: (THREE.Object3D | null)[] = [];
  /** powder falling (part 14) / lying (part 1), sparks (part 13): the pack's own meshes, instanced */
  let powderAir: PartBatch, powderFlat: PartBatch, sparkBatch: PartBatch;
  const flames: { root: THREE.Object3D; update(dt: number): void }[] = [];
  const blades: THREE.Object3D[] = [];
  /** floating scores of one chain appear 10 ticks apart (FUN_800b7df0: delay += 10 per keg) */
  const chain = new Map<number, { t: number; n: number }>();
  /** HUD score counters roll up one point per 2 logic frames (the real HUD counts up digit by digit) */
  const shown = [0, 0, 0, 0];
  let rollAcc = 0;
  /** after the round ends the sim stops: the view keeps the winner cheering / the rest idling with the real scripts */
  let endP: KKData['p'] | null = null;
  let endAcc = 0;

  const prop = (name: string, scale = 1): THREE.Object3D | null => {
    const inst = catalogInstance(getCatalog().props[name]);
    if (!inst) return null;
    inst.root.scale.multiplyScalar(scale);
    return inst.root;
  };

  function fallbackKeg(kind: number): THREE.Object3D {
    const col = kind === 2 ? 0xffcf3a : kind === 1 ? 0xb8c4dc : 0x8a5a2a;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.5, 14), new THREE.MeshStandardMaterial({ color: col }));
    m.position.y = 0.75;
    const g = new THREE.Group();
    g.add(m);
    return g;
  }

  function makeKeg(kind: number, id: number): KegV {
    const group = new THREE.Group();
    const name = kind === 2 ? 'kkBarrelGold' : kind === 1 ? 'kkBarrelSilver' : id % 3 === 0 ? 'kkBarrelB' : 'kkBarrel';
    const body = prop(name) ?? fallbackKeg(kind);
    group.add(body);
    kit.root.add(group);
    return { group, body, kind };
  }

  function build() {
    built = new THREE.Group();
    kit.root.add(built);
    const R = built;
    // the level exactly as the real game places it (RAM object list of level 0x1e)
    const ref = getCatalog().arenas.kegKaboom;
    const lvl = ref ? levelStage(ref, placements, (r) => catalogInstance(r)?.root ?? null, { backdrop: ['extra_2000'] }) : null;
    blades.length = 0;
    if (lvl) {
      R.add(lvl);
      // the windmill sails (extra_281c, a flat cross in the xy plane) turn about their hub at PS1 (-23, -828)
      const k = (ref?.scale ?? 1) / 1024;
      lvl.traverse((h) => {
        if (!h.name.endsWith(':extra_281c') || !h.children[0]) return;
        const mesh = h.children[0];
        const pivot = new THREE.Group();
        pivot.position.set(-23 * k, 828 * k, 100 * k);
        mesh.position.sub(pivot.position);
        h.add(pivot);
        pivot.add(mesh);
        blades.push(pivot);
      });
    }
    else {
    const arena = catalogInstance(ref);
    if (arena) R.add(arena.root);
    // windmill on the far-left hill (placed by overlaying on the real frame) and the sky card behind everything
    const MILL: [number, number, number] = [-13.1, 3.1, -14.6], MILL_K = 0.55;
    const mill = prop('kkMill', MILL_K);
    if (mill) { mill.position.set(...MILL); R.add(mill); }
    const sails = prop('kkBlades', MILL_K);
    if (sails) { sails.position.set(MILL[0], MILL[1] + 1.35 * MILL_K * S, MILL[2] + 0.12 * MILL_K * S); R.add(sails); blades.push(sails); }
    const sky = prop('kkSky', SKY.k);
    if (sky) { sky.position.set(...SKY.pos); R.add(sky); }
    }

    // ---- powder nodes, sparks, the two rim flames (animated part 23), shock indicators
    powderAir = new PartBatch(R, PACK, 14, S, MAX_NODES);
    powderFlat = new PartBatch(R, PACK, 1, S, MAX_NODES);
    sparkBatch = new PartBatch(R, PACK, 13, S, MAX_FIRE);
    flames.length = 0;
    for (let i = 0; i < 2; i++) {
      const inst = catalogInstance(getCatalog().props.kkFlame);
      if (!inst) break;
      inst.play('idle', 0);
      R.add(inst.root);
      flames.push({ root: inst.root, update: (dt) => inst.update(dt) });
    }
    held.length = 0;
    for (let s = 0; s < 4; s++) {
      const m = prop('kkPickup');
      if (m) { m.visible = false; R.add(m); }
      held.push(m);
    }
  }

  function placeCamera(ctx: { camera: THREE.PerspectiveCamera }) {
    applyCam(ctx.camera, ps1Pose(LEVEL_CAMS[30], getCatalog().arenas.kegKaboom)); // the real camera (level 0x1e)
  }

  return {
    id: 'kegKaboom',
    async preload() { [placements] = await Promise.all([loadPlacements('L30'), preloadCatalogFor('kegKaboom', PROPS), preloadFx([PACK, PICKUPS, DIGITS])]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'kegKaboom', { bg: 0x000000, hemi: [0xfff4e0, 0x8a7a5a, 1.5], sun: [8, 18, 6] });
      kit.realFx(S);
      chain.clear();
      build();
      placeCamera(ctx);
      endP = null; endAcc = 0; rollAcc = 0; shown.fill(0);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); for (const v of kegs.values()) kit.root.remove(v.group); kegs.clear(); picks.clear(); kit.root.remove(built); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as KKData;
      const t = ctx.time;
      blades.forEach((o) => { o.rotation.z = t * 0.6; });

      // round over: the winner plays the cheer script (0x6b), the others keep their idle script
      if (d.over && !endP) {
        endP = d.p.map((P) => {
          if (!P) return null;
          const c = structuredClone(P);
          animStart(c, c.fl & 0x200 ? 0x6b : 0x61);
          return c;
        });
        endAcc = 0;
      } else if (!d.over) endP = null;
      if (endP) {
        endAcc += dt * 30;
        while (endAcc >= 1) { endAcc -= 1; for (const c of endP) if (c) animStep(c); }
      }
      rollAcc += dt * 15;
      while (rollAcc >= 1) { rollAcc -= 1; for (let i = 0; i < 4; i++) { const sc = d.p[i]?.score ?? 0; if (shown[i] < sc) shown[i]++; else if (shown[i] > sc) shown[i] = sc; } }

      const seen = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind !== 'player') continue;
        seen.add(b.id);
        const s = b.slot;
        const P = d.p[s];
        if (!P) continue;
        const Pv = (endP && endP[s]) || P;
        const a = kit.actor(b, () => {
          const id = CHARACTERS[kit.look(s).char % CHARACTERS.length].id;
          const inst = catalogInstance(getCatalog().props['kkCarry_' + id]);
          return inst ? { inst, scale: 1, headY: 1.5, shadow: 0.95 } : { inst: createCharacter(kit.look(s), { ring: false }) };
        });
        a.update(b, dt, { role: 'idle', freeze: true, keepYaw: false });
        const [clip, frame] = kkPose(Pv.an);
        applyPose(a.inst, clip, frame);
        const icon = held[s];
        if (icon) { icon.visible = P.shock > 0 && !d.over; icon.position.set(b.x, b.y + HELD_Y, b.z); }
      }
      kit.prune(seen);

      // kegs: scale grows 1000 -> 6000 (of 4096) in 5 frames, then sits still until a spark or blast hits it
      const seenK = new Set<number>();
      for (const o of d.o) {
        if (o.t !== 1) continue;
        const k = o as KKeg;
        seenK.add(k.id);
        let v = kegs.get(k.id);
        if (!v) { v = makeKeg(k.kind, k.id); kegs.set(k.id, v); }
        v.group.position.set(kkX(k.x), 0, kkZ(k.z));
        v.group.scale.setScalar(k.sc / 4096);
      }
      for (const [id, v] of kegs) if (!seenK.has(id)) { kit.root.remove(v.group); kegs.delete(id); }

      // shock pickup: hops on the spot
      const seenP = new Set<number>();
      for (const o of d.o) {
        if (o.t !== 4) continue;
        const k = o as KPick;
        seenP.add(k.id);
        let m = picks.get(k.id);
        if (!m) { m = prop('kkPickup') ?? new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a3fd6 })); kit.root.add(m); picks.set(k.id, m); }
        m.position.set(kkX(k.x), Math.max(0, -k.y / KK_S), kkZ(k.z));
      }
      for (const [id, m] of picks) if (!seenP.has(id)) { kit.root.remove(m); picks.delete(id); }

      // powder (tumbles 0x44 / tick while it falls, then lies flat), sparks along the trail, two flames circling the rim
      powderAir.begin(); powderFlat.begin(); sparkBatch.begin();
      for (const o of d.o) {
        if (o.t === 2) {
          const n = o as KNode;
          if (n.y < 0) powderAir.add(kkX(n.x), -n.y / KK_S, kkZ(n.z), 0, t * 30 * 0x44 * (Math.PI / 2048) + n.id);
          else powderFlat.add(kkX(n.x), 0.02, kkZ(n.z));
        } else if (o.t === 5) {
          const sp = o as KSpark;
          sparkBatch.add(kkX(sp.x), 0, kkZ(sp.z));
        }
      }
      powderAir.end(); powderFlat.end(); sparkBatch.end();
      d.fl.forEach((a, i) => {
        const f = flames[i];
        if (!f) return;
        const ang = (a * Math.PI * 2) / 4096;
        f.root.position.set(Math.sin(ang) * KK_FLAME_R, 0, -Math.cos(ang) * KK_FLAME_R);
        f.root.rotation.y = Math.PI / 2 - ang; // entity yaw = angle - 0x400
        f.update(dt);
      });
      placeCamera(ctx);
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (e.k === 'jump' || e.k === 'land') { // voices from the anim scripts (0x65 jump rise / 0x67 land, op 0x8008 on frame 1), per engine
        // character; checked before baseEvent, which also handles jump / land and would swallow them
        const c = ctx.seats[e.s]?.look.char;
        if (c != null) { const eng = DISC_CHARACTER[c % DISC_CHARACTER.length]; const id = (e.k === 'jump' ? KK_JUMP_VOICE : KK_LAND_VOICE)[eng]; if (id != null) setTimeout(() => playVoiceId('c', id), 1000 / 30); }
      }
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'fuse': // first spark of a chain: hiss
          sfx.playFile(BANK(HISS_SAMPLE[e.v & 3]), 0.4);
          break;
        case 'pop': { // a keg is set off: its value floats up (FUN_8008d5d4 at y -300), chain kegs 10 ticks apart
          const c = chain.get(e.s);
          const n = c && c.t === e.t ? c.n + 1 : 0;
          chain.set(e.s, { t: e.t, n });
          kit.real.number(e.v, e.x, 300 / KK_S, e.z, n * 10);
          sfx.playFile(BANK(e.o === 2 ? 14 : e.o === 1 ? 13 : 9 + (e.s & 3)), 0.7);
          break;
        }
        case 'boom': // the keg explodes the next frame: effect script 0 of the pack (ring, flash, six smoke puffs, sparks)
          kit.real.play(PACK, 0, e.x, 0, e.z);
          kit.shake(e.o >= 1 ? 0.6 : 0.35);
          sfx.playFile(BANK(BOOM_SAMPLE[e.v & 3]), 0.8);
          break;
        case 'wave': // shock: script 3 (white ring out to ~5x) at the player
          kit.real.play(PACK, 3, e.x, kit.actorForSlot(e.s)?.holder.position.y ?? 0, e.z);
          kit.shake(0.3);
          sfx.playFile(BANK(21), 0.8);
          break;
        case 'pick':
          sfx.playFile(BANK(20), 0.8);
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, (s) => shown[s] ?? 0, (getGame('kegKaboom')?.maxTime ?? 90) - w.time, w.time);
    },

    hud(w, slot) {
      const d = w.data as KKData;
      const P = d.p?.[slot];
      return `${String(shown[slot] ?? 0).padStart(3, '0')}${(P?.shock ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      kegs.clear(); picks.clear(); held.length = 0; flames.length = 0; blades.length = 0; chain.clear();
      powderAir?.dispose(); powderFlat?.dispose(); sparkBatch?.dispose();
      kit.dispose();
      void ctx;
    },
  };
}
