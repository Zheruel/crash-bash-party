// Mallet Mash view: the real tower stage (model 0617: round grass platform inside a castle tower), real mushrooms /
// crate / boots (pack 0343) and the per-character mallet models (848-862). Fixed camera fitted against the real game
// (docs/reference/malletMash).
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { MM_R, MM_S, MM_SLOTS, animStart, animStep, mmPose, mmX, mmZ, type MMData, type MMPlayer } from '../../shared/games/malletMash';
import { createCharacter } from '../characters';
import { getCatalog } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { preloadFx } from './realFx';
import { easeOutBack } from './partyBits';
import { applyPose as applyCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { scoreHud } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';

const S = 3.398;
/** Object pack 0343: effect scripts 0 mushroom blast, 1 smoke + stars, 2 crate shards, 3 gold sparkle (re/notes/malletMash.md). */
const PACK = 343;
/** Held-item height per look (table 0x800b9594 by engine char: crash coco tiny dingodile cortex brio koala rilla), game units. */
const HEAD = [576, 640, 768, 704, 512, 608, 640, 832];

/** Camera fitted to the real frame (image-difference search on the disc's own intro frame), in sim units (raw x 3.398). */
export const MM_CAM = { pos: [0.325, 8.477, 17.894] as [number, number, number], look: [0.339, 1.173, -0.106] as [number, number, number], fov: 43.2, aspect: 4 / 3 };

/** Hanging banners and the wooden hatch sit where the real game places them (found by overlaying on the real frame). */
const BANNERS: { prop: string; pos: [number, number, number]; yaw: number }[] = [
  { prop: 'mmBannerBlue', pos: [-1.03 * S, 0.08 * S, -4.03 * S], yaw: 0.28 },
  { prop: 'mmBannerRed', pos: [3.3 * S, 0.2 * S, -2.55 * S], yaw: -0.91 },
];
const LID = { pos: [3.8997 * S, -0.4362 * S, -1.8578 * S] as [number, number, number], yaw: 2.9437 };

const PROPS = [
  'mmMushroom', 'mmGold', 'mmCrate', 'mmBoots', 'mmShockIcon', 'mmRingB',
  'mmBannerBlue', 'mmBannerRed', 'mmLid', 'mmAura_crash', 'mmAura_coco', ...CHARACTERS.map((c) => 'mmMallet_' + c.id),
];

/**
 * Level sound bank 0178: the game's sound ids (FUN_80022660) map through the VAB tone table to sample n of this bank:
 * windup 0x719+p -> 7+p, swing event 0xc 0x721+p -> 15+p, swing lands 0x710+p -> 2+p, mushroom hit 0x71d+p -> 11+p (gold +0x72b -> 20),
 * wave 0x72f+p -> 23+p (power wave +0x72d -> 21), normal pop 0x528 -> 34, gold pop 0x72a -> 19, explosion 0x733.. -> 27,
 * hurt 0x446 -> 28, boots 0x41c -> 33, shock power 0x72e -> 22, crate smash 0x3f5.. -> 30/31.
 */
const BANK = (n: number) => `sfx/0178/${n}.mp3`;

interface MushV { group: THREE.Group; red: THREE.Object3D; gold: THREE.Object3D; gld: boolean }

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

export function createMalletMashView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const mush: MushV[] = [];
  const crates: (THREE.Object3D | null)[] = [];
  /** held power-up over the head (the game's held-item node): boots = pack part 18, shock = shared pack 0736 part 11 */
  const auras: { boots: THREE.Object3D; shock: THREE.Object3D | null }[] = [];
  const lost = new Set<number>();
  const charge = new Map<number, THREE.Object3D | null>();
  const waves: { obj: THREE.Object3D; t: number; s: number; target: number; yaw: number; done: boolean }[] = [];
  /** after the round ends the sim stops: the view keeps the winners cheering / losers shrinking with the real scripts */
  let endP: MMPlayer[] | null = null;
  let endAcc = 0;

  const prop = (name: string, scale = 1): THREE.Object3D | null => {
    const ref = getCatalog().props[name];
    const inst = catalogInstance(ref);
    if (!inst) return null;
    inst.root.scale.multiplyScalar(scale);
    return inst.root;
  };

  function fallbackMushroom(gold: boolean): THREE.Object3D {
    const g = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 0.8, 12), new THREE.MeshStandardMaterial({ color: 0xcfc4b0 }));
    stem.position.y = 0.4;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: gold ? 0xffc83a : 0xd83a3a }));
    cap.position.y = 0.8;
    g.add(stem, cap);
    return g;
  }

  function makeMushroom(): MushV {
    const group = new THREE.Group();
    const red = prop('mmMushroom') ?? fallbackMushroom(false);
    const gold = prop('mmGold') ?? fallbackMushroom(true);
    gold.visible = false;
    group.add(red, gold);
    group.visible = false;
    return { group, red, gold, gld: false };
  }

  let built: THREE.Group;
  function build() {
    built = new THREE.Group();
    kit.root.add(built);
    const R = built;
    // the level exactly as the real game places it (RAM object list of level 0x1d)
    const ref = getCatalog().arenas.malletMash;
    const lvl = ref ? levelStage(ref, placements, (r) => catalogInstance(r)?.root ?? null) : null;
    if (lvl) R.add(lvl);
    else {
      const arena = catalogInstance(ref);
      if (arena) R.add(arena.root);
      for (const b of BANNERS) {
        const o = prop(b.prop);
        if (!o) continue;
        o.position.set(...b.pos); o.rotation.y = b.yaw;
        R.add(o);
      }
      const lid = prop('mmLid');
      if (lid) { lid.position.set(...LID.pos); lid.rotation.y = LID.yaw; R.add(lid); }
    }
    mush.length = 0;
    for (let i = 0; i < MM_SLOTS; i++) { const m = makeMushroom(); R.add(m.group); mush.push(m); }
    crates.length = 0;
    auras.length = 0;
    for (let s = 0; s < 4; s++) {
      const boots = prop('mmBoots') ?? new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.7), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
      const shock = prop('mmShockIcon');
      boots.visible = false; R.add(boots);
      if (shock) { shock.visible = false; R.add(shock); }
      auras.push({ boots, shock });
    }
  }

  /** Mushroom pose from the game's own state: only the vertical scale animates (rise 0 -> 0xc00 in 13 frames, shake = random scale). */
  function mushPose(v: MushV, m: { st: number; ys: number; gold: boolean; x: number; z: number } | null) {
    const g = v.group;
    if (!m || !(m.st === 10 || m.st === 0xc || m.st === 0xd || m.st === 0xe)) { g.visible = false; return; }
    if (v.gld !== m.gold) { v.gld = m.gold; v.red.visible = !m.gold; v.gold.visible = m.gold; }
    g.visible = true;
    g.position.set(mmX(m.x), 0, mmZ(m.z));
    g.scale.set(1, m.st === 0xc ? 1 : Math.max(0.001, m.ys / 0xc00), 1);
  }

  function placeCamera(ctx: { camera: THREE.PerspectiveCamera }) {
    applyCam(ctx.camera, ps1Pose(LEVEL_CAMS[29], getCatalog().arenas.malletMash)); // the real camera (level 0x1d)
  }

  return {
    id: 'malletMash',
    async preload() { [placements] = await Promise.all([loadPlacements('L29'), preloadCatalogFor('malletMash', PROPS), preloadFx([PACK, 736, 732])]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'malletMash', { bg: 0x000000, hemi: [0xffffff, 0x888888, 1.6], sun: [4, 18, 8] });
      kit.realFx(S);
      lost.clear();
      build();
      placeCamera(ctx);
      endP = null; endAcc = 0;
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); charge.clear(); kit.root.remove(built); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as MMData;
      const t = ctx.time;
      // round over: continue the end animations locally (winner cheer script 0x39, losers idle script + shrink)
      if (d.over && !endP) {
        endP = d.p.map((P) => {
          const c = structuredClone(P);
          if (d.winner === -1) return c;
          const win = (c.fl & 0x200) !== 0;
          c.st = win ? 0x47 : 0x48;
          animStart(c, win ? 0x39 : 0x33);
          return c;
        });
        endAcc = 0;
      } else if (!d.over) endP = null;
      if (endP) {
        endAcc += dt * 30;
        while (endAcc >= 1) {
          endAcc -= 1;
          for (const c of endP) { if (c.st === 0x48 && c.sc !== 0) c.sc -= 0x80; if (c.st === 0x47 || c.st === 0x48) animStep(c); }
        }
      }
      const seen = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind !== 'player') continue;
        seen.add(b.id);
        const s = b.slot;
        const P: MMPlayer = d.p[s];
        const Pv: MMPlayer = endP && d.over ? endP[s] : P;
        const a = kit.actor(b, () => {
          const id = CHARACTERS[kit.look(s).char % CHARACTERS.length].id;
          const inst = catalogInstance(getCatalog().props['mmMallet_' + id]);
          // raw units, like the stage (the game draws every model at the level scale)
          return inst ? { inst, scale: 1, headY: 2.35, shadow: 0.92 } : { inst: createCharacter(kit.look(s), { ring: false }) };
        });
        if (!charge.has(b.id)) {
          const au = prop('mmAura_' + CHARACTERS[kit.look(s).char % CHARACTERS.length].id);
          if (au) { au.visible = false; a.yaw.add(au); }
          charge.set(b.id, au);
        }
        const gone = Pv.st === 0x48 && Pv.sc < 1;
        a.update(b, dt, { role: 'idle', freeze: true, keepYaw: false, hidden: gone || P.hid });
        const [clip, frame] = mmPose(Pv.an);
        applyPose(a.inst, clip, frame);
        a.holder.scale.setScalar(Pv.st === 0x48 ? Math.max(0.001, Pv.sc / 0x1000) : 1);
        const ch = charge.get(b.id);
        if (ch) ch.visible = P.st === 0x44;
        // power-up marker over the head (FUN_800b6e1c: at the player, y - HEAD[char], spins 0x38 per frame)
        const au = auras[s];
        const yaw = (d.g * 0x38 * Math.PI * 2) / 4096, hy = b.y + HEAD[kit.look(s).char % HEAD.length] / MM_S;
        for (const [o, on] of [[au.boots, P.pw === 0], [au.shock, P.pw === 1]] as const) {
          if (!o) continue;
          o.visible = on && !P.hid;
          if (o.visible) { o.position.set(b.x, hy, b.z); o.rotation.y = -yaw; }
        }
        // a loser shrinks away (0x80 / frame) and leaves the smoke-and-stars puff (script 1) when gone
        if (gone && !lost.has(s)) { lost.add(s); kit.real.play(PACK, 1, b.x, b.y, b.z); }
        else if (!gone) lost.delete(s);
      }
      kit.prune(seen);
      for (const id of charge.keys()) if (!seen.has(id)) charge.delete(id);

      d.mu.forEach((m, i) => { const v = mush[i]; if (v) mushPose(v, m); });
      // crates: scale 0 -> 1 in 17 frames while rising (state 10), fixed yaw
      for (let i = 0; i < d.cr.length; i++) {
        const c = d.cr[i];
        let o = crates[i];
        if (!c || !(c.st === 10 || c.st === 0xc)) { if (o) o.visible = false; continue; }
        if (!o) {
          o = prop('mmCrate', 1.5) ?? new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a3fd6 }));
          kit.root.add(o); crates[i] = o;
        }
        o.visible = true;
        o.position.set(mmX(c.x), 0, mmZ(c.z));
        o.rotation.y = -(c.yaw * Math.PI * 2) / 4096;
        o.scale.setScalar(Math.max(0.001, (c.st === 10 ? c.s : 0x1000) / 0x1000) * 1.5);
      }
      // shock rings (object 0x1a03, FUN_800b6380): x/z scale s += (target - (s - 0x800)) >> 1 per tick until it passes the target, yaw += 0x71
      for (let i = waves.length - 1; i >= 0; i--) {
        const wv = waves[i];
        wv.t += dt * 30;
        while (wv.t >= 1 && !wv.done) { wv.t -= 1; if (wv.s < wv.target) { wv.s += (wv.target - (wv.s - 0x800)) >> 1; wv.yaw += 0x71; } else wv.done = true; }
        if (wv.done) { kit.root.remove(wv.obj); waves.splice(i, 1); continue; }
        wv.obj.scale.set(wv.s / 0x1000, 1, wv.s / 0x1000);
        wv.obj.rotation.y = -(wv.yaw * Math.PI * 2) / 4096;
      }
      placeCamera(ctx);
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const real = kit.real;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'rise': // a gold one sparkles (script 3, 256 u up) once it is fully out, 13 ticks later
          if (e.v) real.play(PACK, 3, e.x, 0x100 / MM_S, e.z, { delay: 13 });
          if (!sfx.playFile(BANK(e.v ? 19 : 34), 0.7)) sfx.play(e.v ? 'tick' : 'whoosh', 0.5);
          break;
        case 'swing': // windup starts
          kit.actorForSlot(e.s)?.action();
          sfx.playFile(BANK(7 + (e.s & 3)), 0.6);
          break;
        case 'strike':
          sfx.playFile(BANK(15 + (e.s & 3)), 0.6);
          break;
        case 'hit': // mallet lands
          sfx.playFile(BANK(2 + (e.s & 3)), 0.8);
          break;
        case 'smash': { // mushroom state 4: script 1 (two smoke puffs + eight stars), its points float up (FUN_800b6b04)
          const gold = e.o === 1;
          real.play(PACK, 1, e.x, 0, e.z);
          real.number(e.v, e.x, 0, e.z);
          kit.shake(gold ? 0.35 : 0.14);
          kit.actorForSlot(e.s)?.squash.kick(0.2);
          sfx.playFile(BANK(11 + (e.s & 3)), 0.8);
          if (gold) sfx.playFile(BANK(20), 0.6);
          break;
        }
        case 'boom': // a mushroom explodes (state 5): script 0 (green ring, flash, green smoke)
          real.play(PACK, 0, e.x, 0, e.z);
          kit.shake(0.3);
          { const i = Math.floor(Math.random() * 4); sfx.playFile(BANK(27), 0.8, false, sfxRate('0178', 0x733 + i)); } // 0x733-0x736: one sample, four pitches
          break;
        case 'wave': { // object 0x1a03: the blue ring (part 19) 128 u over the floor, target scale 4 (power wave 8)
          const power = e.o === 1;
          const ring = prop('mmRingB');
          if (ring) { ring.position.set(e.x, 0x80 / MM_S, e.z); ring.scale.set(0.001, 1, 0.001); kit.root.add(ring); waves.push({ obj: ring, t: 0, s: 0, target: power ? 0x8000 : 0x4000, yaw: 0, done: false }); }
          kit.shake(power ? 0.8 : 0.6);
          if (power) sfx.playFile(BANK(21), 0.8);
          sfx.playFile(BANK(23 + (e.s & 3)), 0.8);
          break;
        }
        case 'stun':
          kit.actorForSlot(e.s)?.hit();
          sfx.playFile(BANK(28), 0.7);
          break;
        case 'cbreak': // crate state 4: script 2 (purple shards, smoke, stars)
          real.play(PACK, 2, e.x, 0, e.z);
          { const i = Math.floor(Math.random() * 4); sfx.playFile(BANK(30 + (i & 1)), 0.8, false, sfxRate('0178', 0x3f5 + i)); } // 0x3f5-0x3f8: two samples, two pitches
          break;
        case 'crate':
          sfx.playFile(BANK(e.v === 0 ? 33 : 22), 0.8);
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, (s) => (w.data as MMData).p?.[s]?.score ?? 0, (getGame('malletMash')?.maxTime ?? 90) - w.time, w.time);
    },

    hud(w, slot) {
      const d = w.data as MMData;
      const P = d.p?.[slot];
      return `${String(P?.score ?? 0).padStart(3, '0')}${P?.pw === 0 ? ' ›' : ''}${P?.pw === 1 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      mush.length = 0; crates.length = 0; auras.length = 0; waves.length = 0; lost.clear();
      kit.dispose();
      void ctx; void MM_R;
    },
  };
}
