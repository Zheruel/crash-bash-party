// Mallet Mash view: the real tower stage (model 0617: round grass platform inside a castle tower), real mushrooms /
// crate / boots (pack 0343) and the per-character mallet models (848-862). Fixed camera fitted against the real game
// (docs/reference/malletMash).
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { MM_S, MM_SLOTS, createMalletMashResult, mmFace, mmOpeningPose, mmPose, mmX, mmZ, type MMData } from '../../shared/games/malletMash';
import type { GameEvent } from '../../shared/types';
import { createCharacter } from '../characters';
import { charEntry, getCatalog } from '../crash';
import { charVoice, hitVoice, winnerVoice } from '../shell/voice';
import { sfx, sfxRate } from '../shell/sound';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { preloadFx } from './realFx';
import { applyPose as applyCam, FitCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { arenaClockSprites, scoreHud } from '../ui/ps1hud';
import type { ClientMiniGame } from './types';

const S = 3.398;
/** Object pack 0343: effect scripts 0 mushroom blast, 1 smoke + stars, 2 crate shards, 3 gold sparkle (re/notes/malletMash.md). */
const PACK = 343;
/** Held-item height per look (table 0x800b9594 by engine char: crash coco tiny dingodile cortex brio koala rilla), game units. */
const HEAD: Partial<Record<string, number>> = {
  crash: 576, coco: 640, tiny: 768, dingodile: 704, cortex: 512, brio: 608, koala: 640, rilla: 832, 'big-stein': 608,
};

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

/** Zero-based sample index in the level VAB (0178). */
const BANK = (n: number) => `sfx/0178/${n}.mp3`;

/** The native draw runs for 120 ticks. A hurt winner can deliver the final cue past four seconds. */
export const malletMashResultHoldMs = (draw: boolean) => draw ? 4000 : 4500;

interface MushV { group: THREE.Group; red: THREE.Object3D; gold: THREE.Object3D; gld: boolean }

export function createMalletMashView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  const mush: MushV[] = [];
  const crates: (THREE.Object3D | null)[] = [];
  /** held power-up over the head (the game's held-item node): boots = pack part 18, shock = shared pack 0736 part 11 */
  const auras: { boots: THREE.Object3D; shock: THREE.Object3D | null }[] = [];
  const charge = new Map<number, THREE.Object3D | null>();
  const waves: { obj: THREE.Object3D; t: number; s: number; target: number; yaw: number; done: boolean }[] = [];
  let result: {
    scene: ReturnType<typeof createMalletMashResult>;
    camera: FitCam;
    at: number;
    frame: number;
    renderedAt: number;
    winnerAt: number;
  } | undefined;

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
    applyCam(ctx.camera, ps1Pose(result?.camera.c ?? LEVEL_CAMS[29], getCatalog().arenas.malletMash));
  }

  function mushroomEvent(e: GameEvent, delay: number, audio: boolean) {
    if (e.k === 'rise') {
      if (e.v) kit.real.play(PACK, 3, e.x, 0x100 / MM_S, e.z, { delay: delay + 13 });
      if (audio) sfx.playFile(BANK(e.v ? 18 : 33), 0.7, true, sfxRate('0178', e.v ? 0x72a : 0x528));
    } else {
      kit.real.play(PACK, 0, e.x, 0, e.z, { delay });
      if (audio) sfx.playFile(BANK(26), 0.8, true, sfxRate('0178', 0x733 + (e.v & 3)));
    }
  }

  return {
    id: 'malletMash',
    async preload() { [placements] = await Promise.all([loadPlacements('L29'), preloadCatalogFor('malletMash', PROPS), preloadFx([PACK, 736, 732])]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'malletMash', { bg: 0x000000, hemi: [0xffffff, 0x888888, 1.6], sun: [4, 18, 8] });
      kit.realFx(S);
      result = undefined;
      build();
      placeCamera(ctx);
      void world;
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); charge.clear(); kit.root.remove(built); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w, false, malletMashResultHoldMs(true));
      const t = ctx.time;
      let fxDt = dt;
      if (!kit.over.done) result = undefined;
      else {
        const winner = kit.over.winners.values().next().value;
        const at = result?.at ?? ctx.resultReplayAt ?? t;
        const frame = Math.max(0, Math.floor((t - at) * 30 + 1e-7));
        const audioFrom = result ? 0 : frame + 1;
        result ??= { scene: createMalletMashResult(w, winner), camera: new FitCam(LEVEL_CAMS[29]), at, frame: 0, renderedAt: t - dt, winnerAt: -1 };
        fxDt = Math.max(0, t - result.renderedAt);
        result.renderedAt = t;
        while (result.frame < frame) {
          const tick = ++result.frame;
          const audio = tick >= audioFrom;
          const delay = fxDt * 30 - (frame - tick);
          for (const e of result.scene.step()) {
            if (e.k === 'resultWinner') {
              result.winnerAt = tick;
              if (!audio) sfx.enterRoundResult('winner');
            } else if (e.k === 'resultBurst') kit.real.play(PACK, 1, e.x, 0, e.z, { delay });
            else if (e.k === 'rise' || e.k === 'boom') mushroomEvent(e, delay, audio);
          }
          if (audio && winner !== undefined && result.winnerAt >= 0) {
            const age = tick - result.winnerAt;
            winnerVoice('malletMash', kit.look(winner).char, age - 1, age);
          }
          if (result.scene.cameraActive) {
            // FUN_80078dd4 uses half width and 3/4 height on results. Loser entry removes the actor from the tracked list.
            const boxes = result.scene.data.p.filter(p => p.st !== 0x48).map(p => ({
              x: p.x, y: -16, z: p.z, xl: 256, xr: 256, zn: 0, zf: 0, h: 960,
            }));
            result.camera.update(boxes, false, false);
          }
        }
      }
      const d = result?.scene.data ?? w.data as MMData;
      const seen = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind !== 'player') continue;
        seen.add(b.id);
        const s = b.slot;
        const Pv = result ? d.p[s] : (kit.playerWorld(s).data as MMData).p[s];
        const body = result ? { ...b, x: mmX(Pv.x), z: mmZ(Pv.z), face: mmFace(Pv.yaw), vx: 0, vz: 0 } : b;
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
        // Keep a stationary local actor on the arena clock until its predicted action starts.
        const idle = Pv.st === 0x40 && d.p[s].st === 0x40;
        const [clip, frame] = w.tick === 0 && ctx.countdownTicksLeft !== undefined
          ? mmOpeningPose(Pv.ch, ctx.countdownTicksLeft) : mmPose(idle ? d.p[s].an : Pv.an);
        if (result) a.face = body.face;
        a.update(body, dt, { pose: { clip, frame }, role: 'idle', freeze: true, keepYaw: !!result, hidden: gone || Pv.hid });
        a.holder.scale.setScalar(Pv.sc / 0x1000);
        if (result && Pv.hid && !gone) {
          a.shadow.set(body.x, body.z, body.y);
          a.shadow.visible = true;
        }
        const ch = charge.get(b.id);
        if (ch) ch.visible = Pv.st === 0x44;
        // power-up marker over the head (FUN_800b6e1c: at the player, y - HEAD[char], spins 0x38 per frame)
        const au = auras[s];
        const id = CHARACTERS[kit.look(s).char].id;
        const nativeHeight = HEAD[id];
        const hy = body.y + (nativeHeight == null ? (charEntry(id)?.height ?? a.headY) + 0.1 : nativeHeight / MM_S);
        const yaw = (d.g * 0x38 * Math.PI * 2) / 4096;
        for (const [o, on] of [[au.boots, Pv.pw === 0], [au.shock, Pv.pw === 1]] as const) {
          if (!o) continue;
          o.visible = on && !Pv.hid;
          if (o.visible) { o.position.set(body.x, hy, body.z); o.rotation.y = -yaw; }
        }
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
      kit.real.update(fxDt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const real = kit.real;
      if (kit.baseEvent(e)) return;
      switch (e.k) {
        case 'rise': // a gold one sparkles when it is fully out, 13 ticks later
          mushroomEvent(e, 0, true);
          break;
        case 'footstep':
          charVoice('c', ctx.seats[e.s]?.look.char, e.v);
          break;
        case 'swing': // windup starts
          kit.actorForSlot(e.s)?.action();
          sfx.playFile(BANK(6 + (e.s & 3)), 0.6, true);
          break;
        case 'strike':
          sfx.playFile(BANK(14 + (e.s & 3)), 0.6, true);
          break;
        case 'hit': // mallet lands
          sfx.playFile(BANK(1 + (e.s & 3)), 0.8, true);
          break;
        case 'smash': { // mushroom state 4: script 1 (two smoke puffs + eight stars), its points float up (FUN_800b6b04)
          const gold = e.o === 1;
          real.play(PACK, 1, e.x, 0, e.z);
          real.number(e.v, e.x, 0, e.z);
          sfx.playFile(BANK(10 + (e.s & 3)), 0.8, true);
          if (gold) sfx.playFile(BANK(19), 0.6, true);
          break;
        }
        case 'boom': // a mushroom explodes (state 5): script 0 (green ring, flash, green smoke)
          mushroomEvent(e, 0, true);
          break;
        case 'wave': { // object 0x1a03: the blue ring (part 19) 128 u over the floor, target scale 4 (power wave 8)
          const power = e.o === 1;
          const ring = prop('mmRingB');
          if (ring) { ring.position.set(e.x, 0x80 / MM_S, e.z); ring.scale.set(0.001, 1, 0.001); kit.root.add(ring); waves.push({ obj: ring, t: 0, s: 0, target: power ? 0x8000 : 0x4000, yaw: 0, done: false }); }
          if (power) sfx.playFile(BANK(20), 0.8, true);
          sfx.playFile(BANK(22 + (e.s & 3)), 0.8, true);
          break;
        }
        case 'stun': // FUN_800b4910: hit request with 0x446, then one of the victim's four hit voices
          sfx.playFile(BANK(27), 0.7, true);
          hitVoice('c', ctx.seats[e.s]?.look.char, undefined, e.v);
          break;
        case 'cbreak': // crate state 4: script 2 (purple shards, smoke, stars)
          real.play(PACK, 2, e.x, 0, e.z);
          { const i = e.v & 3; sfx.playFile(BANK(29 + (i & 1)), 0.8, true, sfxRate('0178', 0x3f5 + i)); } // 0x3f5-0x3f8: two samples, two pitches
          break;
        case 'crate':
          sfx.playFile(BANK(e.v === 0 ? 32 : 21), 0.8, true);
          break;
      }
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      const d = w.data as MMData;
      return scoreHud(ctx.seats, s => d.shown?.[s] ?? d.p[s]?.score ?? 0, arenaClockSprites('malletMash', w));
    },

    hud(w, slot) {
      const d = w.data as MMData;
      const P = d.p?.[slot];
      return `${String(d.shown?.[slot] ?? P?.score ?? 0).padStart(3, '0')}${P?.pw === 0 ? ' ›' : ''}${P?.pw === 1 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      mush.length = 0; crates.length = 0; auras.length = 0; waves.length = 0; charge.clear();
      result = undefined;
      kit.dispose();
      void ctx;
    },
  };
}
