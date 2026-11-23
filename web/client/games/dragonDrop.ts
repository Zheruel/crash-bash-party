// Dragon Drop view: the real meadow pit (model 0621): stone-walled bowl with x1/x2/x3/x5 floor bands, a bull's-eye target
// circling outside the wall, archery-range props, tent and castle backdrop; riders are the per-character dino models.
import * as THREE from 'three';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { createDragonDropResult, dragonCupFrame, dragonResultFrames, dragonRiderScript, RD_INTRO_GONG, RD_INTRO_TARGETS, RD_S, RD_TARGET_Y, type DragonDropData, type DragonTarget } from '../../shared/games/dragonDrop';
import type { Body } from '../../shared/types';
import { getCatalog } from '../crash';
import { discStereo } from '../shell/discStereo';
import { sfx, sfxRate } from '../shell/sound';
import { hitVoice, winnerVoice } from '../shell/voice';
import { Actor, Kit, catalogInstance, preloadCatalogFor } from './kit';
import { fxPartTemplate, PartBatch, pickupShadow, preloadFx } from './realFx';
import { makeJewel } from './partyBits';
import { applyPose, levelStage, loadPlacements, Ps1Follow, TRACK_CAMS, type Placements, type Tracked } from './ps1cam';
import { arenaClockSprites, scoreHud } from '../ui/ps1hud';
import type { ClientMiniGame } from './types';

/** clear colour = the hills' base colour (only seen in seams under the horizon, like the PS1 frame) */
const SKY = new THREE.Color(0x3a5929);
/** Stage scale; level model 0621 carries the one effect script (0: jewel-appear burst), smoke frames are shared pack 0619 parts 3-18. */
const S = 3.4, LEVEL = 621, SMOKE = 619;
const JEWEL_SHADOW_SCALE = 0x23e8 / 4096;
// The quad's vertices are at local y = -2 and its entity is at y = 128 in disc coordinates.
const JEWEL_SHADOW_Y = (2 * JEWEL_SHADOW_SCALE - 128) * RD_S;
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

/** Dragon Drop sound id -> [file, rate]: the level's VAB 0179 (the bank in the L28 RAM dump; every id resolves through table
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
/** Every Dragon Drop cue calls FUN_80022660 at volume 0x1000: SPU level 127 at the default effects option (as Polar Push). */
const FULL = 0.8;
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

// L28 script 0x56, engine characters 1–8: first render word, length, loop start, repeated loop-opening frame.
const WIN_POSES = [
  [0x4180, 31, 12, 1], [0x4200, 36, 0, 0], [0x4180, 31, 12, 1], [0x4175, 31, 12, 1],
  [0x4180, 47, 10, 0], [0x4180, 36, 0, 0], [0x4180, 31, 12, 1], [0x4180, 31, 12, 1],
] as const;
// 0x8008 commands from the same scripts: [script tick, sound id, repeat interval (0 = once)].
const WIN_CUES = [
  [[0, 0x6c5, 0], [12, 0x6a6, 0], [12, 0x6c5, 19]],
  [[0, 0x6c5, 36]],
  [[0, 0x6c4, 0], [13, 0x6c4, 19]],
  [[0, 0x6c7, 0], [12, 0x6a7, 19], [12, 0x6c7, 19]],
  [[10, 0x6c7, 0], [11, 0x6c7, 37]],
  [[0, 0x6c6, 36]],
  [[0, 0x6c4, 0], [13, 0x6c4, 19]],
  [[0, 0x6c7, 0], [13, 0x6c7, 19]],
] as const;
const WIN_START = 2; // second result tick; the update that enters 0x56 also advances it once

function winPose(char: number, tick: number): number | undefined {
  if (tick < 0) return;
  const [first, length, loop, hold] = WIN_POSES[char - 1];
  const frame = tick < loop ? tick : loop + (tick - loop) % (length - loop);
  return first + frame - (frame > loop ? hold : 0);
}

export function createDragonDropView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let target: THREE.Group;
  const jewels = new Map<number, { obj: THREE.Object3D; shadow: THREE.Object3D }>();
  const puffs = new Map<number, THREE.Group>();
  let tracks: PartBatch;
  const burstLosers = new Set<number>();
  let introTargetTick = -1;
  let result: { riders: ReturnType<typeof createDragonDropResult>; at: number; frame: number } | undefined;
  // Mode 1 fits the riders and the jewels currently on the engine's tracking list.
  let follow: Ps1Follow | null = null;
  const cam = () => (follow ??= new Ps1Follow(TRACK_CAMS[28], getCatalog().arenas.dragonDrop));

  const jewelObj = (ci: number, size: number) => catalogInstance({ model: SMOKE, parts: [`part${ci}`], scale: S })?.root
    ?? makeJewel(JEWEL_COLORS[ci % JEWEL_COLORS.length], size);
  const play = (id: number, late = false) => { const t = RD_SFX[id]; if (t) sfx.playFile(t[0], FULL, late, t[1]); };
  // FUN_800bc1bc keys the skid cue on the rider's handle (+0x94) at the rider's position; idle entry FUN_800bcac0 releases it.
  const held = new Map<number, { sample: NonNullable<ReturnType<typeof sfx.startSample>> }>();
  const lastState: number[] = [];
  const release = (slot: number) => { held.get(slot)?.sample.stop(); held.delete(slot); };
  const riderAt = (slot: number): [number, number, number] | null => {
    const p = (kit.world?.data as DragonDropData | undefined)?.P?.[slot];
    return p ? [p.x, 0, p.z] : null;
  };
  const levels = (at: [number, number, number] | null): [number, number] | undefined => {
    const c = follow?.camera;
    return c && at ? discStereo({ ...c, x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) }, ...at) : undefined;
  };

  function piece(name: string): THREE.Object3D | null {
    const inst = catalogInstance(getCatalog().props[name]);
    return inst ? inst.root : null;
  }

  let placements: Placements | null = null;

  function build() {
    const R = kit.root;
    tracks?.dispose();
    tracks = new PartBatch(R, LEVEL, 2, S, 64, { shadowDepthBias: LAYERS.length * 2 });
    puffs.clear();
    const ref = getCatalog().arenas.dragonDrop;
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
    const actor = inst ? kit.actor(b, () => ({ inst, scale: 1, steady: true, headY: 2.4 })) : kit.actor(b);
    const shadow = pickupShadow(SMOKE, 19, S, { brightness: 0.75, depthBias: LAYERS.length * 2 });
    if (shadow.children.length) {
      actor.shadow.mesh.removeFromParent();
      shadow.position.y = 0;
      actor.yaw.add(shadow);
    }
    return actor;
  }

  function showPuff(slot: number, puff?: { age: number; x: number; z: number }) {
    let group = puffs.get(slot);
    if (!puff || puff.age < 1) {
      if (group) group.visible = false;
      return;
    }
    if (!group) {
      group = new THREE.Group();
      for (const part of SMOKE_FRAMES) group.add(fxPartTemplate(SMOKE, part, S, true)?.clone() ?? new THREE.Group());
      puffs.set(slot, group);
      kit.root.add(group);
    }
    group.visible = true;
    group.position.set(puff.x * RD_S, 420 * RD_S, -puff.z * RD_S);
    const frame = puff.age <= 3 ? 0 : puff.age - 2;
    group.children.forEach((mesh, i) => { mesh.visible = i === frame; });
  }

  return {
    id: 'dragonDrop',
    async preload() {
      for (const file of new Set(Object.values(RD_SFX).map(([file]) => file))) sfx.preloadFile(file);
      sfx.preloadFile('sfx/0278/6.mp3');
      [placements] = await Promise.all([loadPlacements('L28'), preloadCatalogFor('dragonDrop', [...PIECES, 'rdTarget', ...RIDERS]), preloadFx([LEVEL, SMOKE])]);
      loaded = true;
    },

    init(ctx, world) {
      kit = new Kit(ctx, 'dragonDrop', { bg: 0x6a9ad8, hemi: [0xffffff, 0xb0b0b0, 1.6], sun: [4, 18, 8] });
      burstLosers.clear();
      lastState.length = 0;
      introTargetTick = -1;
      result = undefined;
      build();
      follow = null;
      applyPose(ctx.camera, cam().step(0, []));
      void world;
      kit.realFx(S);
      if (!loaded) this.preload!().then(() => { if (kit) { kit.reset(); kit.root.clear(); kit.realFx(S); build(); } });
    },

    render(ctx, w, dt) {
      kit.checkOver(w, false);
      const d = w.data as DragonDropData;
      const { done, winners } = kit.over;
      const decided = done && winners.size > 0;
      let frame = 0, previousFrame = -1, catchingUp = false;
      if (done) {
        const winner = winners.values().next().value;
        result ??= { riders: createDragonDropResult(w, winner), at: ctx.resultReplayAt ?? ctx.time, frame: -1 };
        const elapsed = Math.floor((ctx.time - result.at) * 30 + 1e-7);
        const end = dragonResultFrames(!decided, winner === undefined ? 0 : kit.look(winner).char);
        frame = Math.max(0, result.frame, Math.min(elapsed, end));
        catchingUp = result.frame < 0 && frame > 1;
        previousFrame = catchingUp ? frame : result.frame;
        result.frame = frame;
        const events = result.riders.advance(frame);
        if (!catchingUp) for (const e of events) this.onEvent?.(ctx, e);
        if (winner !== undefined) {
          if (catchingUp) sfx.enterRoundResult('winner');
          // The winning rider enters the result handler one update after ranking.
          const char = kit.look(winner).char;
          winnerVoice('dragonDrop', char, previousFrame - 1, frame - 1);
          const cup = dragonCupFrame(char);
          if (previousFrame < cup && frame >= cup) sfx.playFile('sfx/0278/6.mp3', 0.9, true, sfxRate('0278', 0x19d));
        } else if (previousFrame < 23 && frame >= 23) {
          sfx.playFile('sfx/0278/13.mp3', 0.9, true, sfxRate('0278', 0x1af));
        }
      } else {
        result = undefined;
        burstLosers.clear();
      }
      const seen = new Set<number>(), seenJ = new Set<number>();
      tracks.begin();
      const tracked: Tracked[] = [];
      const intro = ctx.countdownTicksLeft !== undefined && w.tick === 0
        ? Math.max(0, RD_INTRO_TARGETS.length - 1 - ctx.countdownTicksLeft) : undefined;
      for (const b of w.bodies) {
        if (b.kind === 'player') {
          const s = b.slot;
          const a = rider(b);
          seen.add(b.id);
          const playerData = (done ? d : kit.playerWorld(s).data) as DragonDropData;
          const p = result?.riders.players[s] ?? playerData.P[s];
          for (const mark of p?.tracks ?? []) {
            tracks.add(mark.x * RD_S, 0, -mark.z * RD_S, -mark.yaw * Math.PI / 2048, 0, 1, 1 - (1024 + 64 * mark.age) / 4096);
          }
          showPuff(s, p?.puff);
          const body = result && p ? { ...b, x: p.x * RD_S, z: -p.z * RD_S, y: 0,
            vx: p.vx * RD_S * 30, vz: -p.vz * RD_S * 30, face: -p.yaw * Math.PI / 2048 } : b;
          if (!decided || frame === 0 || winners.has(s)) {
            tracked.push({ pos: new THREE.Vector3(body.x, body.y, body.z), face: body.face });
          }
          if (done) a.face = body.face;
          if (decided) {
            // FUN_800bcf88 -> FUN_80085890: rider idle 0x4d, then winner script 0x56.
            const hidden = !winners.has(s);
            const char = DISC_CHARACTER[kit.look(s).char] ?? 1;
            const winTick = frame < WIN_START ? -1 : frame - WIN_START + 1;
            const verdict = frame === 0 ? p : undefined;
            a.update(body, dt, { script: verdict ? dragonRiderScript(verdict.st) : 0x4d,
              scriptFrame: verdict ? verdict.poseFrame : Math.max(0, frame - 1), renderWord: winPose(char, winTick), hidden, freeze: true, keepYaw: true });
            if (hidden && !burstLosers.has(s)) {
              // FUN_800b62d8 marks losers gone and spawns a one-shot level script 0 at each of them.
              burstLosers.add(s);
              kit.real.play(LEVEL, 0, b.x, b.y, b.z);
            }
            const playedWinThrough = previousFrame < WIN_START ? -1 : previousFrame - WIN_START + 1;
            if (!hidden && winTick > playedWinThrough) {
              for (const [at, sound, period] of WIN_CUES[char - 1]) {
                if (winTick < at) continue;
                const latest = period ? winTick - (winTick - at) % period : at;
                if (latest > playedWinThrough) play(sound, true);
              }
            }
            continue;
          }
          // states: 99 idle, 100 run, 101 throw, 102 barge (action via body.dash), 103 recoil
          const st = result?.riders.players[s]?.st ?? playerData.st?.[s] ?? 99;
          if (st === 99 && lastState[s] !== 99) release(s);
          lastState[s] = st;
          const role = st === 101 ? 'throw' : st === 103 ? 'hit' : st === 100 ? 'run' : st === 99 ? 'idle' : undefined;
          const script = dragonRiderScript(st);
          a.update(body, dt, { role, script, scriptFrame: intro ?? p?.poseFrame ?? (st === 101 ? p?.tt : undefined), freeze: true, keepYaw: done });
        } else if (b.kind === 'jewel' && (!done || frame === 0)) {
          seenJ.add(b.id);
          let v = jewels.get(b.id);
          if (!v) {
            v = { obj: jewelObj(b.slot, 0.45), shadow: pickupShadow(SMOKE, 19, S * JEWEL_SHADOW_SCALE,
              { brightness: 0.5, depthBias: LAYERS.length * 2 }) };
            kit.root.add(v.obj, v.shadow);
            jewels.set(b.id, v);
          }
          const j = d.J[b.slot];
          v.obj.visible = b.m !== 6 && intro !== 0;
          v.obj.scale.setScalar(b.m === 1 ? 0.5 : 1);
          v.obj.position.set(b.x, b.y, b.z);
          v.obj.rotation.y = intro === undefined ? b.face : -Math.max(0, intro - 1) * Math.PI / 64;
          v.shadow.visible = intro === undefined ? (j?.shadow?.visible ?? (b.m !== 1 && b.m < 6)) : b.slot < 2 && intro >= 2;
          const dx = j?.shadow ? (j.shadow.x - j.x) * RD_S : 0;
          const dz = j?.shadow ? (j.z - j.shadow.z) * RD_S : 0;
          v.shadow.position.set(b.x + dx, JEWEL_SHADOW_Y, b.z + dz);
          if (j?.tracked ?? (b.m !== 1)) tracked.push({ pos: v.obj.position, face: v.obj.rotation.y, r: 512, h: 512, f: 512 });
          if (intro !== undefined && b.slot < 2 && introTargetTick === 0 && intro > 0) {
            kit.real.play(LEVEL, 0, b.x, -192 * RD_S, b.z);
            play(SND.spawn, true);
          }
        }
      }
      kit.prune(seen);
      tracks.end();
      for (const [id, v] of jewels) if (!seenJ.has(id)) { kit.root.remove(v.obj, v.shadow); jewels.delete(id); }

      // target: swings on the rim (placed by the sim), faces the pit, rolls with the swing
      let swing: Readonly<DragonTarget> = d;
      if (intro !== undefined) {
        swing = RD_INTRO_TARGETS[intro];
        if (introTargetTick >= 0 && introTargetTick < RD_INTRO_GONG && intro >= RD_INTRO_GONG) play(SND.gong, true);
        introTargetTick = intro;
      }
      target.position.set(swing.tx * RD_S, -RD_TARGET_Y * RD_S, -swing.tz * RD_S);
      target.rotation.set(0, (-swing.tyaw * Math.PI * 2) / 4096, (-swing.troll * Math.PI * 2) / 4096);

      // camera
      ctx.scene.background = SKY;
      applyPose(ctx.camera, cam().step(dt, tracked, done));
      for (const smoke of puffs.values()) if (smoke.visible) smoke.quaternion.copy(ctx.camera.quaternion);
      // Preserve the projected footprint of the buried native quad while depth-testing riders and the rim.
      const eye = ctx.camera.position, floorY = 0.002;
      const rayScale = (eye.y - floorY) / (eye.y - JEWEL_SHADOW_Y);
      for (const { shadow } of jewels.values()) {
        if (!shadow.visible) continue;
        shadow.position.sub(eye).multiplyScalar(rayScale).add(eye);
        shadow.position.y = floorY - 2 * JEWEL_SHADOW_SCALE * RD_S * rayScale;
        shadow.scale.setScalar(rayScale);
      }
      for (const [slot, h] of held) {
        if (h.sample.ended) { held.delete(slot); continue; }
        const at = levels(riderAt(slot));
        if (at) h.sample.setStereo(at);
      }
      kit.real.update(catchingUp ? frame / 30 : dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      const s = e.s >= 0 ? e.s % 4 : 0;
      switch (e.k) {
        case 'gong':
          play(SND.gong);
          break;
        case 'score': {
          play(SND.score);
          play(SND.mult[e.v] ?? 0x6bb);
          if (e.v >= 5) play(0x6b2); // silent in the game's table
          break;
        }
        case 'throw': // FUN_800bc948
          play(SND.throw[s]);
          break;
        case 'barge': // FUN_800ba574
          play(SND.barge[s]);
          break;
        case 'bargesmoke':
          if (kit.world?.data.P?.[s]?.poseFrame !== undefined) break;
          { // barge state 102 (FUN_800ba724): smoke puff object 0x1903 trails the rider 420 u up, 16 frames at one per tick
            const who = e.s, at = () => { const a = kit.actorForSlot(who); return a ? { x: a.holder.position.x, y: a.holder.position.y + 420 * RD_S, z: a.holder.position.z } : null; };
            kit.real.sprite(SMOKE, SMOKE_FRAMES, e.x, 420 * RD_S, e.z, { life: 16 / 30, follow: at });
          }
          break;
        case 'bargesound': { // FUN_800bc1bc
          const t = RD_SFX[SND.bargeHit[s]];
          release(s);
          const sample = t && sfx.startSample(t[0], null, FULL, t[1], 0, levels(riderAt(s)));
          if (sample) held.set(s, { sample });
          break;
        }
        case 'recoil': // FUN_800b9e68 (anim 0x4d): hit voice rand(4) of the 0x8009e080 ids
          hitVoice('b', ctx.seats[e.s]?.look.char, 0.8, kit.world && !kit.world.data.random ? -1 : e.v, undefined, undefined, e.s);
          break;
        case 'bump':
          play(SND.bump[e.v & 3]);
          break;
        case 'wallbump':
          play(SND.bump[e.v & 3]);
          break;
        case 'step':
          play(SND.step[s][e.v & 1]);
          break;
        case 'jpick':
          play(SND.pick);
          break;
        case 'jbounce':
          play(SND.bounce[e.v & 3]);
          break;
        case 'jclash':
        case 'jdrop':
          play(SND.drop[e.v & 3]);
          break;
        case 'jspawn':
          kit.real.play(LEVEL, 0, e.x, -192 * RD_S, e.z); // jewel state 7: level script 0 at the jewel, 256 u lower (entity y -64)
          play(SND.spawn);
          break;
        case 'jwall':
          play(SND.wall);
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      const d = w.data as DragonDropData;
      return scoreHud(ctx.seats, s => (d.shown ?? d.score)?.[s] ?? 0, arenaClockSprites('dragonDrop', w));
    },

    hud(w, slot) {
      const d = w.data as DragonDropData;
      return `${String((d.shown ?? d.score)?.[slot] ?? 0).padStart(3, '0')}${(d.carry?.[slot] ?? -1) >= 0 ? '  \u25c6' : ''}`;
    },

    dispose(ctx) {
      for (const slot of [...held.keys()]) release(slot);
      jewels.clear();
      puffs.clear();
      tracks?.dispose();
      kit.dispose();
      void ctx;
    },
  };
}
