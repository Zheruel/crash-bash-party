// Keg Kaboom view: the real village yard (model 0609: dirt ring inside a low stone wall, houses and windmill on the hills),
// real powder kegs (pack 0738) and the per-character barrel-carrier models (864-878). Fixed camera fitted against the real
// game (docs/reference/kegKaboom). Everything drawn comes from the 30 Hz sim (`KKData`); players use the game's own anim scripts.
import * as THREE from 'three';
import { CHARACTERS, DISC_CHARACTER } from '../../shared/look';
import { kkFlamePosition, KK_FLAME_STEP, KK_INTRO_TICKS, KK_S, stepKegResultObjects, kkOpeningPoses, kkPose, kkX, kkZ, type KKData, type KKeg, type KNode, type KPick, type KSpark } from '../../shared/games/kegKaboom';
import type { World, GameEvent } from '../../shared/types';
import { createCharacter } from '../characters';
import { getCatalog } from '../crash';
import { sfx, sfxRate } from '../shell/sound';
import { discStereo } from '../shell/discStereo';
import { charVoice, hitVoice, winnerVoice } from '../shell/voice';
import { KegResultPlayer } from './kegKaboomResult';
import { Kit, catalogInstance, preloadCatalogFor } from './kit';
import { PartBatch, pickupShadow, preloadFx } from './realFx';
/** voice ids in the Keg Kaboom anim scripts per engine character (re/dumps/L30.ram, table 0x8009d29c): 0x65 jump rise and 0x67 land.
 *  The game's own data, quirks included (cortex jumps with tiny's id, dingodile lands with it). */
const KK_JUMP_VOICE: Record<number, number> = { 1: 0xc, 2: 0x3e, 3: 0x138, 4: 0xa2, 5: 0x138, 6: 0x16a, 7: 0x106, 8: 0xd4 };
const KK_LAND_VOICE: Record<number, number> = { 1: 0xd, 2: 0x3f, 3: 0x71, 4: 0xa3, 5: 0x139, 6: 0x16b, 7: 0x139, 8: 0xd5 };
import { applyPose as applyCam, FitCam, LEVEL_CAMS, levelStage, loadPlacements, ps1Pose, type Placements } from './ps1cam';
let placements: Placements | null = null;
import { arenaClockSprites, scoreHud } from '../ui/ps1hud';
import type { ClientMiniGame } from './types';

const S = 3.398;
const MAX_FIRE = 600;
const MAX_NODES = 1000;

/** Camera fitted to the real frame (image-difference search), arena recentred on its floor: sim units. */
export const KK_CAM = { pos: [1.2, 9.552, 17.82] as [number, number, number], look: [1.204, 1.688, -0.508] as [number, number, number], fov: 43.76, aspect: 4 / 3 };

/** Sky card (sunset gradient with the sun) hung far behind the hills. */
const SKY = { pos: [18, 3, -70] as [number, number, number], k: 2.6 };
const KEG_PROPS = ['kkBarrel', 'kkBarrelGold', 'kkBarrelSilver'];
const PROPS = [...KEG_PROPS, 'kkPickup', 'kkFlame', 'kkBlades', 'kkMill', 'kkSky', ...CHARACTERS.map((c) => 'kkCarry_' + c.id)];
/** Object pack 0738 (kegs, powder, sparks, blasts), shared pickups 0736, HUD digits 0732 (floating scores). */
const PACK = 738, PICKUPS = 736, DIGITS = 732;
const YAW = Math.PI / 2048;
const DRAW_SOUND = 'sfx/0278/13.mp3';

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

export function createKegKaboomView(): ClientMiniGame {
  let kit: Kit;
  let loaded = false;
  let built: THREE.Group;
  const kegs = new Map<number, KegV>();
  const picks = new Map<number, { group: THREE.Group; item: THREE.Object3D }>();
  /** the shock charge shows as the pickup over its holder's head (the game's held-item node, pack 0736 part 11) */
  const held: (THREE.Object3D | null)[] = [];
  /** powder falling (part 14) / lying (part 1), sparks (part 13): the pack's own meshes, instanced */
  let powderAir: PartBatch, powderFlat: PartBatch, sparkBatch: PartBatch;
  const flames: NonNullable<ReturnType<typeof catalogInstance>>[] = [];
  const openingPoses = new Map<number, ReturnType<typeof kkOpeningPoses>>();
  const blades: THREE.Object3D[] = [];
  /** floating scores of one chain appear 10 ticks apart (FUN_800b7df0: delay += 10 per keg) */
  const chain = new Map<number, { t: number; n: number }>();
  type Sample = NonNullable<ReturnType<typeof sfx.startSample>>;
  const fuseSounds = new Map<number, { start: number; variant: number; sample: Sample }>();
  const tails = new Map<Sample, [number, number, number]>();
  const soundCamera = { ...LEVEL_CAMS[30] };
  let result: {
    world: World;
    players: (KegResultPlayer | null)[];
    camera: FitCam;
    at: number;
    frame: number;
    audioFrom: number;
  } | undefined;

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

  function makeKeg(kind: number): KegV {
    const group = new THREE.Group();
    group.name = 'kegKaboomKeg';
    const name = kind === 2 ? 'kkBarrelGold' : kind === 1 ? 'kkBarrelSilver' : 'kkBarrel';
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
      inst.root.name = 'kegKaboomFlame';
      R.add(inst.root);
      flames.push(inst);
    }
    held.length = 0;
    for (let s = 0; s < 4; s++) {
      const m = prop('kkPickup');
      if (m) { m.visible = false; R.add(m); }
      held.push(m);
    }
  }

  function syncFuses(d: KKData, events: GameEvent[]) {
    for (const p of d.p) {
      if (!p) continue;
      const old = fuseSounds.get(p.slot);
      // Earlier snapshots carry the start event but no persistent sample selection.
      const legacy = p.fuseStart === undefined && p.fuseP ? [...events].reverse().find(e => e.k === 'fuse' && e.s === p.slot) : undefined;
      const start = p.fuseStart ?? (legacy ? legacy.t + KK_INTRO_TICKS : old?.start ?? d.g - 2);
      if (old && (!p.fuseP || old.start !== start)) { old.sample.stop(); fuseSounds.delete(p.slot); }
      // The sound object is allocated by the follower and keyed by the next mixer update.
      if (!p.fuseP || d.g < start + 2) continue;
      const variant = p.fuseVariant ?? legacy?.v ?? old?.variant ?? 0;
      const n = HISS_SAMPLE[variant & 3], rate = sfxRate('0177', 0x741 - (variant & 3));
      const origin = p.fuseMixOrigin ?? p.fuseOrigin;
      const levels = discStereo(soundCamera, origin?.[0] ?? p.x, 0, origin?.[1] ?? p.z);
      const offset = (d.g - 2 - start) * rate / 30;
      if (old?.start === start) {
        old.sample.setStereo(levels);
        old.sample.update(rate, offset);
      } else {
        const sample = sfx.startSample(BANK(n), n === 4 ? 0.6379 : 0.704, 1, rate, offset, levels);
        if (sample) fuseSounds.set(p.slot, { start, variant, sample });
      }
    }
  }

  function playSpatial(e: GameEvent, file: string, volume: number, rate: number) {
    if (!kit.root.parent) return;
    const origin: [number, number, number] = [Math.round(e.x * KK_S), Math.round(-(e.y ?? 0) * KK_S), Math.round(-e.z * KK_S)];
    const sample = sfx.startSample(file, null, volume, rate, 0, discStereo(soundCamera, ...origin));
    if (sample) tails.set(sample, origin);
  }

  function playAt(e: GameEvent, n: number, id: number) {
    playSpatial(e, BANK(n), 1, sfxRate('0177', id));
  }

  function kegEvent(e: GameEvent, audible: boolean) {
    switch (e.k) {
      case 'pick':
        if (audible) playAt(e, 20, 0x439);
        return true;
      case 'pop': { // a keg is set off: its value floats up (FUN_8008d5d4 at y -300), chain kegs 10 ticks apart
        const c = chain.get(e.s);
        const n = c && c.t === e.t ? c.n + 1 : 0;
        chain.set(e.s, { t: e.t, n });
        kit.real.number(e.v, e.x, 300 / KK_S, e.z, n * 10);
        if (audible) {
          const n = e.o === 2 ? 14 : e.o === 1 ? 13 : 9 + (e.s & 3);
          playAt(e, n, 0x750 + n - 9);
        }
        return true;
      }
      case 'boom': // the keg explodes the next frame: effect script 0 of the pack (ring, flash, six smoke puffs, sparks)
        kit.real.play(PACK, 0, e.x, 0, e.z);
        if (audible) playAt(e, BOOM_SAMPLE[e.v & 3], 0x745 - (e.v & 3));
        return true;
    }
    return false;
  }

  function placeCamera(ctx: { camera: THREE.PerspectiveCamera }, camera = LEVEL_CAMS[30]) {
    applyCam(ctx.camera, ps1Pose(camera, getCatalog().arenas.kegKaboom));
  }

  return {
    id: 'kegKaboom',
    async preload() {
      sfx.preloadFile(DRAW_SOUND);
      for (let n = 3; n <= 14; n++) sfx.preloadFile(BANK(n));
      sfx.preloadFile(BANK(20));
      sfx.preloadFile(BANK(21));
      [placements] = await Promise.all([loadPlacements('L30'), preloadCatalogFor('kegKaboom', PROPS), preloadFx([PACK, PICKUPS, DIGITS])]);
      loaded = true;
    },

    init(ctx, world) {
      kit = new Kit(ctx, 'kegKaboom', { bg: 0x000000, hemi: [0xfff4e0, 0x8a7a5a, 1.5], sun: [8, 18, 6] });
      kit.realFx(S);
      chain.clear();
      build();
      placeCamera(ctx);
      result = undefined;
      Object.assign(soundCamera, LEVEL_CAMS[30]);
      void world;
      if (!loaded) this.preload!().then(() => {
        if (!kit) return;
        kit.reset();
        for (const v of kegs.values()) kit.root.remove(v.group);
        for (const v of picks.values()) kit.root.remove(v.group);
        kegs.clear();
        picks.clear();
        kit.root.remove(built);
        build();
      });
    },

    render(ctx, w, dt) {
      kit.checkOver(w, false);
      let d = w.data as KKData;
      // The host has already run setup. Sample the visible lead-in using its settled snapshot.
      const remaining = w.tick === 0 ? ctx.countdownTicksLeft : undefined;
      const opening = remaining !== undefined && d.g === KK_INTRO_TICKS
        ? Math.max(0, Math.min(KK_INTRO_TICKS, Math.floor(KK_INTRO_TICKS - remaining)))
        : undefined;
      const t = ctx.time;
      blades.forEach((o) => { o.rotation.z = t * 0.6; });

      if (!kit.over.done) result = undefined;
      else {
        const at = result?.at ?? ctx.resultReplayAt ?? t;
        const frame = Math.max(0, Math.floor((t - at) * 30 + 1e-7));
        if (!result) {
          const winner = kit.over.winners.values().next().value;
          const world = { ...w, ev: [], data: structuredClone(d) };
          const players = (world.data as KKData).p.map((p) => p && new KegResultPlayer(p, winner === undefined ? 'draw' : winner === p.slot ? 'win' : 'lose'));
          // Rejoining clients rebuild the picture through the current frame without replaying earlier sounds.
          world.data.p = players.map(p => p?.player ?? null);
          result = { players, world, camera: new FitCam(LEVEL_CAMS[30]), at, frame: 0, audioFrom: frame + 1 };
        }
        while (result.frame < frame) {
          const tick = ++result.frame;
          Object.assign(soundCamera, result.camera.c);
          if (tick === 23 && tick >= result.audioFrom && kit.over.winners.size === 0) {
            sfx.playFile(DRAW_SOUND, 0.9, true, sfxRate('0278', 0x1af));
          }
          for (const entry of result.players) {
            if (!entry) continue;
            const p = entry.player;
            const cue = entry.step(tick);
            if (cue === 'burst') {
              // Loser entry spawns a silent 0x1605 with script 0 from pack 0738.
              kit.real.play(PACK, 0, kkX(p.x), 0, kkZ(p.z));
            }
            const char = kit.look(p.slot).char;
            if (tick >= result.audioFrom) {
              if (cue === 'land' || cue === 'hitLand') {
                const id = cue === 'hitLand' && p.ch === 7 ? 0x107 : KK_LAND_VOICE[p.ch];
                charVoice('c', char, 0xd, 0, 0.8, id);
              }
              if (entry.celebrating) {
                const age = entry.winnerAge(tick);
                winnerVoice('kegKaboom', char, age - 1, age);
              }
            } else if (cue === 'winner') sfx.enterRoundResult('winner');
          }
          const celebrating = result.players.some(p => p?.celebrating);
          result.world.ev.length = 0;
          stepKegResultObjects(result.world, celebrating);
          for (const e of result.world.ev) kegEvent(e, tick >= result.audioFrom);
          kit.real.update(1 / 30, ctx.camera);
          if (celebrating) {
            // Mode 1 tracks the winner and any player who hasn't entered 0x74.
            // FUN_80078dd4 uses half the usual radius, no z extent and 3/4 height on results.
            const tracked = result.players.flatMap((p) => p && !p.losing ? [{
              x: p.player.x, y: p.player.y, z: p.player.z, xl: 256, xr: 256, zn: 0, zf: 0, h: 960,
            }] : []);
            result.camera.update(tracked, false, false);
          }
        }
      }
      if (result) d = result.world.data as KKData;
      syncFuses(d, w.ev);
      for (const [sample, origin] of tails) {
        if (sample.ended) tails.delete(sample);
        else sample.setStereo(discStereo(soundCamera, ...origin));
      }
      const resultFrame = result?.frame ?? 0;
      const seen = new Set<number>();
      for (const b of w.bodies) {
        if (b.kind !== 'player') continue;
        seen.add(b.id);
        const s = b.slot;
        const entry = result?.players[s];
        const P = entry?.player ?? (kit.playerWorld(s).data as KKData).p[s];
        if (!P) continue;
        const a = kit.actor(b, () => {
          const id = CHARACTERS[kit.look(s).char % CHARACTERS.length].id;
          const inst = catalogInstance(getCatalog().props['kkCarry_' + id]);
          return inst ? { inst, scale: 1, headY: 1.5, shadow: 0.95 } : { inst: createCharacter(kit.look(s), { ring: false }) };
        });
        let [clip, frame] = kkPose(P.an);
        if (opening !== undefined) {
          let poses = openingPoses.get(P.ch);
          if (!poses) { poses = kkOpeningPoses(P.ch); openingPoses.set(P.ch, poses); }
          [clip, frame] = poses[opening];
        }
        const body = entry ? { ...b, x: kkX(P.x), y: -P.y / KK_S, z: kkZ(P.z), face: -P.yaw * YAW, vx: 0, vz: 0 } : b;
        if (entry) a.face = body.face;
        a.update(body, dt, { pose: { clip, frame }, role: 'idle', freeze: true, keepYaw: !!entry });
        a.holder.scale.setScalar(entry?.scale(resultFrame) ?? 1);
        if (entry?.losing) a.shadow.visible = false;
        const icon = held[s];
        if (icon) {
          icon.visible = P.shock > 0 && !entry?.enteredResult;
          icon.position.set(body.x, body.y + 0x300 / KK_S, body.z);
          icon.rotation.y = -((((opening ?? d.g) + 1) * 0x38) & 0xfff) * YAW;
        }
      }
      kit.prune(seen);

      // kegs: scale grows 1000 -> 6000 (of 4096) in 5 frames, then sits still until a spark or blast hits it
      const seenK = new Set<number>();
      for (const o of d.o) {
        if (o.t !== 1) continue;
        const k = o as KKeg;
        if (opening !== undefined && opening <= k.born) continue;
        seenK.add(k.id);
        let v = kegs.get(k.id);
        if (!v) { v = makeKeg(k.kind); kegs.set(k.id, v); }
        v.group.position.set(kkX(k.x), 0, kkZ(k.z));
        const scale = opening === undefined ? k.sc : Math.min(k.sc, (opening - k.born) * 1000);
        v.group.scale.setScalar(scale / 4096);
      }
      for (const [id, v] of kegs) if (!seenK.has(id)) { kit.root.remove(v.group); kegs.delete(id); }

      // shock pickup: hops on the spot
      const seenP = new Set<number>();
      for (const o of d.o) {
        if (o.t !== 4) continue;
        const k = o as KPick;
        seenP.add(k.id);
        let pickup = picks.get(k.id);
        if (!pickup) {
          const group = new THREE.Group();
          const item = prop('kkPickup') ?? new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a3fd6 }));
          group.add(item, pickupShadow(PICKUPS, 0, S));
          kit.root.add(group);
          pickup = { group, item };
          picks.set(k.id, pickup);
        }
        pickup.group.position.set(kkX(k.x), 0, kkZ(k.z));
        pickup.item.position.y = Math.max(0, -k.y / KK_S);
      }
      for (const [id, pickup] of picks) if (!seenP.has(id)) { kit.root.remove(pickup.group); picks.delete(id); }

      // powder (tumbles 0x44 / tick while it falls, then lies flat), sparks along the trail, two flames circling the rim
      powderAir.begin(); powderFlat.begin(); sparkBatch.begin();
      for (const o of d.o) {
        if (o.t === 2) {
          const n = o as KNode;
          const yaw = -(n.yaw ?? 0) * YAW;
          if (n.y < 0 || n.vy !== 0) {
            powderAir.add(kkX(n.x), -n.y / KK_S, kkZ(n.z), yaw, (0x400 + (n.vy / 12) * 0x44) * YAW);
          } else powderFlat.add(kkX(n.x), 0, kkZ(n.z), yaw);
        } else if (o.t === 5) {
          const sp = o as KSpark;
          sparkBatch.add(kkX(sp.x), 0, kkZ(sp.z), 0, 0, (sp.sc ?? 4096) / 4096);
        }
      }
      powderAir.end(); powderFlat.end(); sparkBatch.end();
      d.fl.forEach((a, i) => {
        const f = flames[i];
        if (!f) return;
        const age = opening ?? d.g;
        const angle = (a - (d.g - age) * KK_FLAME_STEP) & 0xfff;
        const ang = angle * YAW;
        const [x, z] = kkFlamePosition(angle);
        f.root.position.set(kkX(x), 0, kkZ(z));
        f.root.rotation.y = Math.PI / 2 - ang; // entity yaw = angle - 0x400
        f.pose(0, (age + 1) % 20); // FUN_800b8368: first drawn key is 1, then wraps through 0–19
      });
      placeCamera(ctx, result?.camera.c);
      if (!result) kit.real.update(dt, ctx.camera);
      kit.fx.update(dt);
    },

    onEvent(ctx, e) {
      if (!kit) return;
      if (e.k === 'jump' || e.k === 'land') { // voices from the anim scripts (0x65 jump rise / 0x67 land, op 0x8008 on frame 1), per engine
        // character; checked before baseEvent, which also handles jump / land and would swallow them
        const c = ctx.seats[e.s]?.look.char;
        if (c != null) {
          const eng = DISC_CHARACTER[c % DISC_CHARACTER.length];
          const jump = e.k === 'jump';
          const id = (jump ? KK_JUMP_VOICE : KK_LAND_VOICE)[eng];
          if (id != null) charVoice('c', c, jump ? 0xc : 0xd, 1, 0.8, id);
        }
      }
      // The L30 camera is fixed: the shared landing shake has no native counterpart.
      if ((e.k !== 'land' && kit.baseEvent(e)) || kegEvent(e, true)) return;
      switch (e.k) {
        case 'step': { // Native footfall 8 has an origin. Footfall 9 is centered.
          const char = ctx.seats[e.s]?.look.char;
          if (e.v & 1) charVoice('c', char, 0xb, 0, 1);
          else charVoice('c', char, 0xa, 0, 1, undefined, (file, volume, rate) => playSpatial(e, file, volume, rate));
          break;
        }
        case 'stun':
          hitVoice('c', ctx.seats[e.s]?.look.char, 1, e.v, (file, volume, rate) => playSpatial(e, file, volume, rate), undefined, e.s);
          break;
        case 'wave': // shock: script 3 (white ring out to ~5x) at the player
          kit.real.play(PACK, 3, e.x, kit.actorForSlot(e.s)?.holder.position.y ?? 0, e.z);
          playAt(e, 21, 0x43a);
          break;
      }
      void ctx;
    },

    /** Real HUD: faces, three-digit scores, clock. */
    ps1Hud(w, ctx) {
      const d = (result?.world.data ?? w.data) as KKData;
      return scoreHud(ctx.seats, s => d.shown?.[s] ?? d.p[s]?.score ?? 0, arenaClockSprites('kegKaboom', w));
    },

    hud(w, slot) {
      const d = (result?.world.data ?? w.data) as KKData;
      const P = d.p?.[slot];
      return `${String(d.shown?.[slot] ?? P?.score ?? 0).padStart(3, '0')}${(P?.shock ?? 0) > 0 ? ' ◎' : ''}`;
    },

    dispose(ctx) {
      for (const sound of fuseSounds.values()) sound.sample.stop();
      fuseSounds.clear();
      for (const sample of tails.keys()) sample.stop();
      tails.clear();
      kegs.clear(); picks.clear(); held.length = 0; flames.length = 0; blades.length = 0; chain.clear();
      powderAir?.dispose(); powderFlat?.dispose(); sparkBatch?.dispose();
      result = undefined;
      kit.dispose();
      void ctx;
    },
  };
}
