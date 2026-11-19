// Ring Ding view: the real meadow pit (model 0621): stone-walled bowl with x1/x2/x3/x5 floor bands, a bull's-eye target
// circling outside the wall, archery-range props, tent and castle backdrop; riders are the per-character dino models.
import * as THREE from 'three';
import { CHARACTERS } from '../../shared/look';
import { RD_S, RD_TARGET_Y, type RingDingData } from '../../shared/games/ringDing';
import type { Body } from '../../shared/types';
import type { BlobShadow } from '../fx';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { hitVoice } from '../shell/voice';
import { Actor, Kit, catalogInstance, preloadCatalogFor } from './kit';
import { preloadFx } from './realFx';
import { makeJewel } from './partyBits';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import { scoreHud } from '../ui/ps1hud';
import { getGame } from '../../shared/registry';
import type { ClientMiniGame } from './types';

/** clear colour = the hills' base colour (only seen in seams under the horizon, like the PS1 frame) */
const SKY = new THREE.Color(0x3a5929);
/** Stage scale; level model 0621 carries the one effect script (0: jewel-appear burst), smoke frames are shared pack 0619 parts 3-18. */
const S = 3.4, LEVEL = 621, SMOKE = 619;
const SMOKE_FRAMES = Array.from({ length: 16 }, (_, i) => 3 + i);
/** sky backdrop wall: the PS1 draws it first, behind everything (no z-buffer) */
const BACKDROP = ['extra_3b94'];
const JEWEL_COLORS = [0x4fe35a, 0xb060ff, 0xffe14a, 0x4fb8ff];
const PIECES = ['rdStand', 'rdFace', 'rdArrow', 'rdSpireB'];
/** Coplanar floor layers, drawn bottom to top (the game relies on draw order; we use polygon offset). */
const LAYERS = ['extra_132c', 'extra_4c04', 'extra_4948', 'extra_4ac8', 'extra_4d90', 'extra_4f50', 'extra_5148'];
/** Archery-range targets ringed outside the wall (x, z): they face the pit. */
const RIDERS = CHARACTERS.map((c) => 'rdRider_' + c.id);

/** Camera: fixed high view from the south rim, looking across the pit (fitted against the real game, see docs/reference/ringDing). */
export const RD_CAM = { pos: [0, 9, 21] as [number, number, number], look: [-1.5, 2.8, 0] as [number, number, number], fov: 48 };

/** Ring Ding sound id -> [file, rate]: the level's VAB 0179 (the bank in the L28 RAM dump; every id resolves through table
 *  0x80064508 to these tones), rate = the tone's own pitch (tools/sfx_pitch.py). 0x6b2 and 0x6c8-0x6cb are silent. */
const RD_SFX: Record<number, [string, number]> = {
  0x6a4: ['sfx/0179/0.mp3', 1.0],
  0x6a5: ['sfx/0179/0.mp3', 0.903],
  0x6a6: ['sfx/0179/1.mp3', 1.0],
  0x6a7: ['sfx/0179/1.mp3', 0.883],
  0x6a8: ['sfx/0179/2.mp3', 1.0],
  0x6a9: ['sfx/0179/2.mp3', 0.875],
  0x6aa: ['sfx/0179/3.mp3', 1.0],
  0x6ab: ['sfx/0179/3.mp3', 0.891],
  0x6ac: ['sfx/0179/4.mp3', 1.0],
  0x6ad: ['sfx/0179/5.mp3', 1.0],
  0x6ae: ['sfx/0179/6.mp3', 1.0],
  0x6af: ['sfx/0179/7.mp3', 1.0],
  0x6b0: ['sfx/0179/8.mp3', 1.0],
  0x6b1: ['sfx/0179/9.mp3', 1.0],
  0x6b3: ['sfx/0179/11.mp3', 1.0],
  0x6b4: ['sfx/0179/12.mp3', 1.0],
  0x6b5: ['sfx/0179/13.mp3', 1.0],
  0x6b6: ['sfx/0179/14.mp3', 1.0],
  0x6b7: ['sfx/0179/15.mp3', 1.0],
  0x6b8: ['sfx/0179/16.mp3', 1.0],
  0x6b9: ['sfx/0179/15.mp3', 0.96],
  0x6ba: ['sfx/0179/16.mp3', 0.96],
  0x6bb: ['sfx/0179/17.mp3', 1.0],
  0x6bc: ['sfx/0179/18.mp3', 1.0],
  0x6bd: ['sfx/0179/19.mp3', 1.0],
  0x6be: ['sfx/0179/20.mp3', 1.0],
  0x6bf: ['sfx/0179/21.mp3', 1.0],
  0x6c0: ['sfx/0179/22.mp3', 1.0],
  0x6c1: ['sfx/0179/23.mp3', 1.0],
  0x6c2: ['sfx/0179/22.mp3', 0.956],
  0x6c3: ['sfx/0179/23.mp3', 0.956],
  0x6c4: ['sfx/0179/24.mp3', 1.0],
  0x6c5: ['sfx/0179/25.mp3', 1.0],
  0x6c6: ['sfx/0179/26.mp3', 1.0],
  0x6c7: ['sfx/0179/27.mp3', 1.0],
  0x6cc: ['sfx/0179/28.mp3', 1.0],
  0x6cd: ['sfx/0179/29.mp3', 1.0],
  0x6ce: ['sfx/0179/30.mp3', 1.0],
  0x6cf: ['sfx/0179/31.mp3', 1.0],
  0x6d0: ['sfx/0164/32.mp3', 1.0],
  0x6d1: ['sfx/0164/33.mp3', 1.0],
  0x6d2: ['sfx/0164/32.mp3', 0.935],
  0x6d3: ['sfx/0164/33.mp3', 0.935],
};
const SND = {
  gong: 0x6bf,
  score: 0x6b1, // on every target hit
  mult: { 1: 0x6bb, 2: 0x6bc, 3: 0x6bd, 5: 0x6be } as Record<number, number>, // (x5 also 0x6b2: silent)
  step: [[0x6a4, 0x6a5], [0x6a6, 0x6a7], [0x6a8, 0x6a9], [0x6aa, 0x6ab]], // 0x6a4+2*slot (tick 6) and +1 (tick 0x13)
  barge: [0x6c4, 0x6c5, 0x6c6, 0x6c7], // 0x6c4+slot
  bargeHit: [0x6ac, 0x6ad, 0x6ae, 0x6af], // 0x6ac+slot (anim frame 14)
  throw: [0x6b3, 0x6b4, 0x6b5, 0x6b6], // 0x6b3+slot
  bump: [0x6d0, 0x6d1, 0x6d2, 0x6d3], // player bump, barge into the wall (rand 4)
  bounce: [0x6b7, 0x6b8, 0x6b9, 0x6ba], // jewel bounce (rand 4)
  drop: [0x6c0, 0x6c1, 0x6c2, 0x6c3], // jewel knocked loose / clash (rand 4)
  pick: 0x6cd,
  spawn: 0x6ce,
  wall: 0x6cc,
};

export function createRingDingView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let target: THREE.Group;
  const jewels = new Map<number, { obj: THREE.Object3D; shadow: BlobShadow }>();
  let tgtPulse = 0;
  // camera mode 1: keeps every rider and the swinging target in frame (engine fit, 30 Hz)
  let follow: Ps1Follow | null = null;
  const cam = () => (follow ??= new Ps1Follow(TRACK_CAMS[28], getCatalog().arenas.ringDing));

  const jewelObj = (ci: number, size: number) => makeJewel(JEWEL_COLORS[ci % JEWEL_COLORS.length], size);
  const play = (id: number, vol = 0.5) => { const t = RD_SFX[id]; if (t) sfx.playFile(t[0], vol, false, t[1]); };

  function piece(name: string): THREE.Object3D | null {
    const inst = catalogInstance(getCatalog().props[name]);
    return inst ? inst.root : null;
  }

  let placements: Placements | null = null;

  function build() {
    const R = kit.root;
    const ref = getCatalog().arenas.ringDing;
    // the level exactly as the real game builds it (native mesh table + RAM object list of level 0x1c); the target is ours
    const lvl = ref ? levelStage(ref, placements, (r) => catalogInstance(r)?.root ?? null, { skip: ['extra_18b8'], backdrop: BACKDROP }) : null;
    if (lvl) {
      R.add(lvl);
      lvl.traverse((o) => {
        const m = o as THREE.Mesh;
        const k = LAYERS.indexOf(m.name.replace(/_\d+$/, '')) >= 0 ? LAYERS.indexOf(m.name.replace(/_\d+$/, '')) : LAYERS.indexOf(m.parent?.name ?? '');
        if (!m.isMesh || k < 0) return;
        const mat = m.material as THREE.Material;
        mat.polygonOffset = true; mat.polygonOffsetFactor = -k * 2; mat.polygonOffsetUnits = -k * 2;
      });
    } else {
      const arena = catalogInstance(ref);
      if (arena) R.add(arena.root);
    }
    target = new THREE.Group();
    const t = piece('rdTarget');
    if (t) target.add(t);
    R.add(target);
  }

  function rider(b: Body): Actor {
    const have = kit.actors.get(b.id);
    if (have) return have;
    const look = kit.look(b.slot);
    const inst = catalogInstance(getCatalog().props['rdRider_' + CHARACTERS[look.char % CHARACTERS.length].id]);
    return inst ? kit.actor(b, () => ({ inst, scale: 1, steady: true, headY: 2.4, shadow: 1.3 })) : kit.actor(b);
  }

  return {
    id: 'ringDing',
    async preload() { [placements] = await Promise.all([loadPlacements('L28'), preloadCatalogFor('ringDing', [...PIECES, 'rdTarget', ...RIDERS]), preloadFx([LEVEL, SMOKE])]); loaded = true; },

    init(ctx, world) {
      kit = new Kit(ctx, 'ringDing', { bg: 0x6a9ad8, hemi: [0xffffff, 0xb0b0b0, 1.6], sun: [4, 18, 8] });
      build();
      follow = null;
      applyPose(ctx.camera, cam().step(0, []));
      void world;
      kit.realFx(S);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); kit.realFx(S); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w);
      const d = w.data as RingDingData;
      const t = ctx.time;
      const seen = new Set<number>(), seenJ = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          seen.add(b.id);
          // states: 99 idle, 100 run, 101 throw, 102 barge (action via body.dash), 103 recoil
          const st = d.st?.[b.slot] ?? 99;
          const role = st === 101 ? 'throw' : st === 103 ? 'hit' : st === 100 ? 'run' : st === 99 ? 'idle' : undefined;
          rider(b).update(b, dt, { role, freeze: true });
        } else if (b.kind === 'jewel') {
          seenJ.add(b.id);
          let v = jewels.get(b.id);
          if (!v) { v = { obj: jewelObj(b.slot, 0.45), shadow: kit.fx.shadow(0.4, 0.4) }; kit.root.add(v.obj); jewels.set(b.id, v); }
          const hidden = b.m === 6; // the third jewel stays hidden until tick 1350
          v.obj.visible = !hidden;
          v.shadow.visible = !hidden;
          v.obj.position.set(b.x, b.y + 0.3, b.z);
          v.obj.rotation.y = b.face;
          v.shadow.set(b.x, b.z, Math.max(0, b.y));
        }
      }
      kit.prune(seen);
      for (const [id, v] of jewels) if (!seenJ.has(id)) { kit.root.remove(v.obj); kit.fx.removeShadow(v.shadow); jewels.delete(id); }

      // target: swings on the rim (placed by the sim), faces the pit, rolls with the swing
      target.position.set(d.tx * RD_S, -RD_TARGET_Y * RD_S, -d.tz * RD_S);
      target.rotation.set(0, (-d.tyaw * Math.PI * 2) / 4096, (-d.troll * Math.PI * 2) / 4096);
      tgtPulse = Math.max(0, tgtPulse - dt * 2.5);
      target.scale.setScalar(1 + tgtPulse * 0.08);

      // camera
      ctx.scene.background = SKY;
      const tracked: Tracked[] = [{ pos: target.position, face: target.rotation.y, r: 512, h: 512, f: 512 }];
      for (const a of kit.actors.values()) tracked.push({ pos: a.holder.position, face: a.yaw.rotation.y });
      applyPose(ctx.camera, cam().step(dt, tracked));
      kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const s = e.s >= 0 ? e.s % 4 : 0;
      switch (e.k) {
        case 'gong':
          play(SND.gong, 0.5);
          tgtPulse = 0.6;
          break;
        case 'score': {
          kit.shake(e.v >= 3 ? 0.2 : 0.08);
          tgtPulse = 1;
          play(SND.score, 0.6);
          play(SND.mult[e.v] ?? 0x6bb, 0.6);
          if (e.v >= 5) play(0x6b2, 0.6); // silent in the game's table
          break;
        }
        case 'throw':
          kit.actorForSlot(e.s)?.squash.kick(-0.3);
          play(SND.throw[s], 0.45);
          break;
        case 'barge':
          kit.actorForSlot(e.s)?.action();
          { // barge state 102 (FUN_800ba724): smoke puff object 0x1903 trails the rider 420 u up, 16 frames at one per tick
            const who = e.s, at = () => { const a = kit.actorForSlot(who); return a ? { x: a.holder.position.x, y: a.holder.position.y + 420 * RD_S, z: a.holder.position.z } : null; };
            kit.real.sprite(SMOKE, SMOKE_FRAMES, e.x, 420 * RD_S, e.z, { life: 16 / 30, follow: at });
          }
          play(SND.barge[s], 0.5);
          setTimeout(() => play(SND.bargeHit[s], 0.4), 470);
          break;
        case 'bargehit':
          kit.actorForSlot(e.s)?.hit();
          kit.shake(0.2);
          break;
        case 'recoil': // recoil enter (anim 0x4d): hit voice rand(4) of the 0x8009e080 ids
          kit.actorForSlot(e.s)?.hit();
          hitVoice('b', ctx.seats[e.s]?.look.char);
          break;
        case 'bump':
          play(SND.bump[e.v & 3], 0.45);
          break;
        case 'wallbump':
          kit.shake(0.1);
          play(SND.bump[e.v & 3], 0.45);
          break;
        case 'step':
          play(SND.step[s][e.v & 1], 0.25);
          break;
        case 'jpick':
          play(SND.pick, 0.45);
          break;
        case 'jbounce':
          play(SND.bounce[e.v & 3], 0.4);
          break;
        case 'jclash':
        case 'jdrop':
          play(SND.drop[e.v & 3], 0.4);
          break;
        case 'jspawn':
          kit.real.play(LEVEL, 0, e.x, -192 * RD_S, e.z); // jewel state 7: level script 0 at the jewel, 256 u lower (entity y -64)
          play(SND.spawn, 0.5);
          break;
        case 'jwall':
          play(SND.wall, 0.35);
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      return scoreHud(ctx.seats, (s) => (w.data as RingDingData).score?.[s] ?? 0, (getGame('ringDing')?.maxTime ?? 90) - w.time, w.time);
    },

    hud(w, slot) {
      const d = w.data as RingDingData;
      return `${String(d.score?.[slot] ?? 0).padStart(3, '0')}${(d.carry?.[slot] ?? -1) >= 0 ? '  \u25c6' : ''}`;
    },

    dispose(ctx) {
      for (const v of jewels.values()) kit.fx.removeShadow(v.shadow);
      jewels.clear();
      kit.dispose();
      void ctx;
    },
  };
}
