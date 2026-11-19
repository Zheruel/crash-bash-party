// Dragon Drop view: the real clock-tower arena (model 0627): a studded wooden ring turning around a stone hub,
// gears and a huge clock face behind, balloons floating above. Per-character models 0928-0942.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { DD_IN, DD_OUT, type DragonDropData } from '../../shared/games/dragonDrop';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { charVoice, spinVoice } from '../shell/voice';
import { Actor, Kit, catalogInstance, preloadCatalogFor } from './kit';
import { preloadFx } from './realFx';
import { glowTexture, specialCrate, SPECIAL_CRATE_REF } from './partyBits';
import { applyPose, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { scoreHud } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';

const BLACK = 0x23202c;
/** Dragon Drop sound id -> [file, rate] from the level's VAB 0180 (identical to the bank in the L27 RAM dump, where every id
 *  resolves through table 0x80064508 to these tones). */
const DD_SFX: Record<number, [string, number]> = {
  0x5dc: ['sfx/0180/9.mp3', 1],
  0x5dd: ['sfx/0180/9.mp3', 1],
  0x5de: ['sfx/0180/10.mp3', 1],
  0x5df: ['sfx/0180/10.mp3', 1],
  0x5e0: ['sfx/0180/11.mp3', 1],
  0x5e1: ['sfx/0180/11.mp3', 1],
  0x5e2: ['sfx/0180/12.mp3', 1],
  0x5e3: ['sfx/0180/12.mp3', 1],
  0x5e4: ['sfx/0180/13.mp3', 1],
  0x5e5: ['sfx/0180/13.mp3', 1],
  0x5e6: ['sfx/0180/14.mp3', 1],
  0x5e7: ['sfx/0180/14.mp3', 1],
  0x5e8: ['sfx/0180/15.mp3', 1],
  0x5e9: ['sfx/0180/15.mp3', 1],
  0x5ea: ['sfx/0180/16.mp3', 1],
  0x5eb: ['sfx/0180/16.mp3', 1],
  0x5ec: ['sfx/0180/17.mp3', 1],
  0x5ed: ['sfx/0180/18.mp3', 1],
  0x5ee: ['sfx/0179/31.mp3', 1],
  0x5ef: ['sfx/0180/20.mp3', 1],
  0x5f0: ['sfx/0180/21.mp3', 1],
  0x5f1: ['sfx/0180/22.mp3', 1],
  0x5f2: ['sfx/0180/23.mp3', 1],
  0x5f3: ['sfx/0180/24.mp3', 1],
  0x3fa: ['sfx/0158/9.mp3', 1],
};
/** pops per balloon type 8..11: rand 4 of these ids (DAT_800bb8e8) */
const POP_SFX: Record<number, number[]> = { 8: [0x5dc, 0x5dd, 0x5de, 0x5df], 9: [0x5e0, 0x5e1, 0x5e2, 0x5e3], 10: [0x5e4, 0x5e5, 0x5e6, 0x5e7], 11: [0x5e8, 0x5e9, 0x5ea, 0x5eb] };
const SLOT_TYPE = [11, 8, 9, 10]; // player index -> balloon type
/** Balloon pack 0794: pop scripts by displayed colour (table 0x800bb89c = [3,2,0,1], black 4); crate pack 0796 script 2 = '?' crate break. */
const PACK = 794, CRATES = 796, POP_FX = [3, 2, 0, 1], S = 3.4;
const SFX = { black: 0x5ed, recolour: 0x5ee, flash: 0x5ef, reverse: 0x5f0, popOthers: 0x5f1, magnet: 0x5f2, hover: 0x5f3, crate: 0x3fa };
const play = (id: number, vol: number) => { const t = DD_SFX[id]; if (t) sfx.playFile(t[0], vol, false, t[1]); };
const DECOR = ['ddWall', 'ddClock', 'ddHands', 'ddGearA', 'ddGearB', 'ddGearC', 'ddShaft', 'ddArm', 'ddAxle'];
const CHAR_IDS = CHARACTERS.map((c) => 'ddChar_' + c.id);
/** Camera: low front view over the ring toward the clock face (fitted against docs/reference/dragonDrop). */
export const DD_CAM = { pos: [0, 7.4, 16.2] as [number, number, number], look: [0, 2.9, 0] as [number, number, number], fov: 48 };

interface BalloonV { obj: THREE.Group; body: THREE.Object3D; shadow: BlobShadow; slot: number; y: number; x: number; z: number }
interface ItemV { obj: THREE.Object3D; kind: number }

export function createDragonDropView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const balloons = new Map<number, BalloonV>();
  const crates = new Map<number, THREE.Object3D>();
  const items = new Map<number, ItemV>();
  let ringGroup: THREE.Group;
  const hoverFx: THREE.Mesh[] = [];
  const magnetFx: THREE.Mesh[] = [];
  let sphereGeo: THREE.SphereGeometry, knotGeo: THREE.ConeGeometry;
  let ringAngle = 0;
  let arrow: THREE.Mesh;

  /** the real balloon of pack 0794: parts 0-3 = blue / green / red / yellow, part 4 black; colour per owner from table 0x800bb89c */
  const balloonPart = (slot: number) => `part${slot < 0 ? 4 : POP_FX[slot % 4]}`;
  function balloonModel(slot: number): THREE.Object3D {
    const inst = catalogInstance({ model: PACK, scale: S, parts: [balloonPart(slot)] });
    if (inst) return inst.root;
    const c = new THREE.Color(slot < 0 ? BLACK : kit.hex(slot));
    return new THREE.Mesh(sphereGeo, new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.3, flatShading: true }));
  }
  function makeBalloon(slot: number): BalloonV {
    const obj = new THREE.Group();
    const body = balloonModel(slot);
    obj.add(body);
    kit.root.add(obj);
    return { obj, body, shadow: kit.fx.shadow(0.4, 0.3), slot, y: 0, x: 0, z: 0 };
  }

  function build() {
    const R = kit.root;
    sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    knotGeo = new THREE.ConeGeometry(0.12, 0.2, 8);
    // the clock tower exactly as the real level places it (RAM object list of level 0x1b); the rotating ring is ours
    const ref = getCatalog().arenas.dragonDrop;
    const lvl = ref ? levelStage(ref, placements, (r) => catalogInstance(r)?.root ?? null, { skip: ['extra_149c'] }) : null;
    if (lvl) R.add(lvl);
    else { const arena = catalogInstance(ref); if (arena) R.add(arena.root); }
    ringGroup = new THREE.Group();
    const ring = catalogInstance(getCatalog().props.ddRing);
    if (ring) ringGroup.add(ring.root);
    R.add(ringGroup);
    arrow = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 3).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0, depthWrite: false }));
    arrow.position.set(0, 2.6, DD_OUT + 1.6);
    R.add(arrow);
    for (let s = 0; s < 4; s++) {
      const hv = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.09, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x66e8ff, transparent: true, opacity: 0.9 }));
      hv.visible = false; R.add(hv); hoverFx.push(hv);
      const mg = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(kit.hex(s)), transparent: true, opacity: 0.8, depthWrite: false }));
      mg.visible = false; R.add(mg); magnetFx.push(mg);
    }
  }

  function actor(b: Body): Actor {
    const have = kit.actors.get(b.id);
    if (have) return have;
    const look = kit.look(b.slot);
    const inst = catalogInstance(getCatalog().props['ddChar_' + CHARACTERS[look.char % CHARACTERS.length].id]);
    return inst ? kit.actor(b, () => ({ inst, scale: 1, shadow: 0.9 })) : kit.actor(b);
  }

  return {
    id: 'dragonDrop',
    async preload() { placements = await loadPlacements('L27'); await preloadCatalogFor('dragonDrop', ['ddRing', 'ddHoverBoots', 'ddMagnet', ...DECOR, ...CHAR_IDS], [SPECIAL_CRATE_REF]); await preloadFx([PACK, CRATES]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'dragonDrop', { bg: 0x1a1c28, hemi: [0xffffff, 0xc0b0b0, 1.6], sun: [-5, 18, 10] });
      build();
      applyPose(ctx.camera, ps1Pose(LEVEL_CAMS[27], getCatalog().arenas.dragonDrop));
      void world; void glowTexture;
      kit.realFx(S);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); kit.realFx(S); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as DragonDropData;
      const t = ctx.time;
      ctx.scene.background = new THREE.Color(0x1a1c28);
      if (d.ang !== undefined) { ringAngle = d.ang; ringGroup.rotation.y = ringAngle; }
      const seen = new Set<number>(), seenB = new Set<number>(), seenC = new Set<number>(), seenI = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          const s = b.slot;
          const hov = (d.hover?.[s] ?? 0) > 0;
          const a = actor(b);
          const spin = d.st?.[s] === 1;
          a.update(b, dt, { role: d.st?.[s] === 2 ? 'hit' : spin ? 'action' : undefined, hop: hov ? 0.35 + Math.sin(t * 6 + s) * 0.06 : 0, keepYaw: spin });
          if (spin) { a.face = b.face; a.yaw.rotation.y = b.face; }
          const hf = hoverFx[s];
          hf.visible = hov;
          if (hov) { hf.position.set(b.x, b.y + 0.3 + Math.sin(t * 6 + s) * 0.06, b.z); hf.rotation.y = t * 4; hf.scale.setScalar(1 + Math.sin(t * 9) * 0.06); }
          const mf = magnetFx[s];
          const mg = (d.magnet?.[s] ?? 0) > 0;
          mf.visible = mg;
          if (mg) { mf.position.set(b.x, 0.08, b.z); const k = 1 + ((t * 1.4 + s * 0.3) % 1) * 2.2; mf.scale.setScalar(k); (mf.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - (k - 1) / 2.2); }
        } else if (b.kind === 'balloon') {
          seenB.add(b.id);
          let v = balloons.get(b.id);
          if (!v) { v = makeBalloon(b.slot); balloons.set(b.id, v); }
          if (v.slot !== b.slot) { // recoloured (black item): swap to that colour's model
            v.slot = b.slot;
            v.obj.remove(v.body);
            v.body = balloonModel(b.slot);
            v.obj.add(v.body);
          }
          v.x = b.x; v.z = b.z; v.y = b.y;
          const sway = Math.sin(t * 2 + b.id) * 0.08;
          v.obj.position.set(b.x, b.y + Math.sin(t * 1.7 + b.id) * 0.1, b.z); // the original only bobs the model (+-128 units)
          v.obj.rotation.set(sway, 0, -sway);
          v.obj.visible = true;
          v.shadow.set(b.x, b.z, Math.max(0, b.y));
          v.shadow.mesh.visible = true;
        } else if (b.kind === 'crate') {
          seenC.add(b.id);
          let o = crates.get(b.id);
          if (!o) { o = specialCrate(1.25); kit.root.add(o); crates.set(b.id, o); }
          o.position.set(b.x, b.y + 0.05, b.z);
          o.scale.setScalar(Math.max(0.05, b.m));
        } else if (b.kind === 'item') {
          seenI.add(b.id);
          let it = items.get(b.id);
          if (it && it.kind !== b.cd) { kit.root.remove(it.obj); items.delete(b.id); it = undefined; }
          if (!it) {
            const inst = catalogInstance(getCatalog().props[b.cd === 1 ? 'ddHoverBoots' : 'ddMagnet']);
            const obj = inst ? inst.root : new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0x66e8ff }));
            kit.root.add(obj);
            it = { obj, kind: b.cd };
            items.set(b.id, it);
          }
          it.obj.position.set(b.x, b.y, b.z);
          it.obj.rotation.y = t * 4;
        }
      }
      kit.prune(seen);
      for (const [id, v] of balloons) if (!seenB.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); balloons.delete(id); }
      for (const [id, o] of crates) if (!seenC.has(id)) { kit.root.remove(o); crates.delete(id); }
      for (const [id, it] of items) if (!seenI.has(id)) { kit.root.remove(it.obj); items.delete(id); }
      (arrow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (arrow.material as THREE.MeshBasicMaterial).opacity - dt * 0.8);
      arrow.rotation.y = (d.dir ?? 1) > 0 ? 0 : Math.PI;

      applyPose(ctx.camera, ps1Pose(LEVEL_CAMS[27], getCatalog().arenas.dragonDrop)); // the real camera (level 0x1b)
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (e.k === 'jump') charVoice('c', ctx.seats[e.s]?.look.char, 0xc, 1); // jump anim 0x2c: `0x8008 block*0x32+0xc`
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'pop': {
          // s = popper (-1: popped by a black balloon), o = displayed colour (-1 black), v = height
          // FUN_8007a524(table[colour], balloon): flash, three smoke puffs and six stars of that colour (black: purple burst)
          kit.real.play(PACK, e.o < 0 ? 4 : POP_FX[e.o % 4], e.x, e.v, e.z);
          if (e.o < 0) play(SFX.black, 0.7);
          else { const ids = POP_SFX[SLOT_TYPE[e.o % 4]]; play(ids[Math.floor(Math.random() * ids.length)], 0.7); }
          if (e.s >= 0) kit.actorForSlot(e.s)?.squash.kick(0.15);
          break;
        }
        case 'hurt': // hit state 0x33 enters anim 0x2b: `0x8008 block*0x32+3`
          charVoice('c', ctx.seats[e.s]?.look.char, 3, 1);
          break;
        case 'black': {
          kit.shake(0.4);
          play(e.v === 0 ? SFX.popOthers : e.v === 1 ? SFX.reverse : SFX.recolour, 0.8);
          break;
        }
        case 'reverse':
          (arrow.material as THREE.MeshBasicMaterial).opacity = 1;
          break;
        case 'cratehit':
          kit.real.play(CRATES, 2, e.x, 0, e.z); // shared crate break FUN_8008e27c, kind 2: shards, smoke, stars
          play(SFX.crate, 0.8);
          break;
        case 'crate':
          play(e.v === 1 ? SFX.hover : SFX.magnet, 0.8);
          break;
        case 'punch':
          if (e.v === 2) {
            kit.actorForSlot(e.s)?.hit();
            kit.shake(0.25);
          } else spinVoice('c', ctx.seats[e.s]?.look.char); // spin states 8 / 10 (the level bank has no swing / hit sound)
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, (s) => (w.data as DragonDropData).score?.[s] ?? 0, (getGame('dragonDrop')?.maxTime ?? 90) - w.time, w.time);
    },

    hud(w, slot) {
      const d = w.data as DragonDropData;
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}${(d.hover?.[slot] ?? 0) > 0 ? ' ▲' : ''}${(d.magnet?.[slot] ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      for (const v of balloons.values()) kit.fx.removeShadow(v.shadow);
      balloons.clear(); crates.clear(); items.clear();
      hoverFx.length = 0; magnetFx.length = 0;
      ringAngle = 0;
      kit.dispose();
      void ctx; void DD_IN;
    },
  };
}
