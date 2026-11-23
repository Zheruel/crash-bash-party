// BALLISTIX sound, as the overlay calls FUN_80022660(id, handle, position, 0x1000, 0x1e00, 0):
// - every tone of banks 0154-0157 has volume 127 and centre pan, so the mix comes from the call alone;
// - a call without a position plays at the SPU's full level on both channels;
// - a call with a position goes through the stereo routine FUN_8002b210 (screen-x pan, distance box), which leaves
//   0.75 of the level on each channel at the centre of the screen;
// - a call with a handle owns one voice of an object: the next effect on that handle replaces it and the voice stops with
//   the object. The ball's handle carries the serve effect and then the landing effect, whose sample loops (the ball's roll).
import { BD_U, type BallistixData } from '../../shared/games/ballDefence';
import type { Body, GameEvent } from '../../shared/types';
import { discStereo } from '../shell/discStereo';
import { sfx, sfxRate } from '../shell/sound';
import type { PS1Cam } from './ps1cam';

/** Volume 0x1000 with the sound option at 100% is voice level 127 (FUN_8002b52c). The roster voices use the same gain. */
export const BD_FULL = 0.8;
/** sfx bank of each level (levelBanks in audio/index.json) */
export const BD_BANK: Record<string, string> = { crashball: '0157', beach: '0156', nballism: '0155', sky: '0154' };
/** effect id -> sample of the level's bank (tone id through the bank's VAB; same for the four banks up to 1426) */
const COMMON: Record<number, number> = {
  1400: 0, 1401: 1, 1402: 2, 1403: 3, 1404: 4, 1405: 5, 1406: 4, 1407: 5, 1408: 6, 1409: 7, 1410: 8, 1411: 9, 1412: 10, 1413: 11, 1414: 12,
  1415: 13, 1416: 14, 1417: 15, 1418: 13, 1419: 14, 1420: 15, 1421: 16, 1422: 16, 1423: 16, 1424: 16, 1425: 17, 1426: 18,
};
// Ids 1494-1498 (the N.Ballism shield) only exist as a silent stub tone in bank 0157; 1440 is missing from the Sky bank.
const EXTRA: Record<string, Record<number, number>> = {
  crashball: { 1440: 19, 451: 20, 452: 21 },
  beach: { 1440: 19, 1450: 20, 1451: 21, 1452: 22, 1453: 21, 1454: 22, 1455: 23, 1456: 24, 1457: 23, 1458: 24, 1459: 25, 1460: 26, 1461: 25, 1462: 26, 1463: 27, 1464: 28, 451: 29, 452: 30 },
  nballism: { 1440: 19, 1470: 20, 1471: 21, 1472: 22, 1473: 23, 451: 24, 452: 25 },
  sky: { 1480: 19, 1481: 20, 1482: 21, 1483: 22, 1484: 21, 1485: 22, 451: 23, 452: 24 },
};

/** Effects the overlay gives a world position (a copy of the ship's or the ball's entity position). */
const AT_SHIP = (id: number) => (id >= 1409 && id <= 1412) || id === 1414 || id === 451 || id === 452 || (id >= 1455 && id <= 1462);
const AT_BALL = (id: number) => id === 1408 || (id >= 1415 && id <= 1420) || id === 1440;
/** Effects that live on a handle and are rebuilt from the snapshot: ball roll, barrier, launcher motor, Sky fan. */
const ON_HANDLE = (id: number) => (id >= 1421 && id <= 1425) || id === 1471 || id === 1481;
/** The entity origins ride above the floor: ships 128 u, resting balls 96 u (disc y points down). */
const SHIP_Y = -128, BALL_Y = -96;
/**
 * Tones 1421-1424 (ADSR2 0x5244): the sustain falls linearly at rate 0x49, 7 of 0x7fff every 128 output samples.
 * The loop of the landing sample fades out over this many 30 Hz ticks.
 */
const ROLL_FADE = (0x7fff / 7) * 128 / 44100 * 30;

type Sample = NonNullable<ReturnType<typeof sfx.startSample>>;
interface Roll { id: number; at: number; sample: Sample }

export class BallistixAudio {
  private bank: Record<number, { file: string; loop: number | null }> = {};
  private queued: GameEvent[] = [];
  private rolls = new Map<number, Roll>();
  private catches = new Map<number, Sample>();
  private wall: Sample | null = null;
  private motor: Sample | null = null;
  private hum: { at: number; sample: Sample } | null = null;
  private dead = false;

  constructor(private variant: string) {}

  /** `samples` is the level bank's entry of audio/index.json: disc samples are shared between banks. */
  load(samples: { n: number; file?: string | null; loop?: number | null }[]) {
    for (const { n, file, loop } of samples) if (file) this.bank[n] = { file, loop: loop ?? null };
    const table = { ...COMMON, ...EXTRA[this.variant] };
    for (const n of new Set(Object.values(table))) if (this.bank[n]) sfx.preloadFile(this.bank[n].file);
  }

  private tone(id: number) {
    const n = EXTRA[this.variant]?.[id] ?? COMMON[id];
    const sample = n === undefined ? undefined : this.bank[n];
    return sample && { ...sample, rate: sfxRate(BD_BANK[this.variant], id) };
  }

  /** The two channel levels of a position in disc units. */
  private levels(camera: PS1Cam, x: number, y: number, z: number, gain = 1): [number, number] {
    const [left, right] = discStereo(camera, Math.round(x), Math.round(y), Math.round(z));
    return [left * gain, right * gain];
  }

  /** A roster voice at the ship (the Triangle taunt passes the ship's position). */
  voiceAt(camera: PS1Cam, e: GameEvent) {
    const stereo = this.levels(camera, e.x * BD_U, SHIP_Y, -e.z * BD_U);
    return (file: string, volume: number, rate: number) => { sfx.startSample(file, null, volume, rate, 0, stereo); };
  }

  /** One effect call. Snapshot-driven handles are skipped here and rebuilt by sync(). */
  play(e: GameEvent, camera: PS1Cam) {
    const id = e.o;
    if (ON_HANDLE(id)) return;
    const tone = this.tone(id);
    if (!tone) return;
    if (AT_SHIP(id) || AT_BALL(id)) {
      const stereo = this.levels(camera, e.x * BD_U, AT_SHIP(id) ? SHIP_Y : BALL_Y, -e.z * BD_U);
      sfx.startSample(tone.file, null, BD_FULL, tone.rate, 0, stereo);
    } else sfx.playFile(tone.file, BD_FULL, false, tone.rate);
  }

  /**
   * Snapshot events reach the client ahead of the interpolated picture. Hold an effect until the frame that
   * produced it is on screen, so a rebound sounds as the ball turns.
   */
  queue(e: GameEvent) { this.queued.push(e); }

  flush(frame: number, camera: PS1Cam) {
    if (!this.queued.length) return;
    const due = this.queued.filter(e => e.t < frame || e.t > frame + 12);
    if (!due.length) return;
    this.queued = this.queued.filter(e => !due.includes(e));
    for (const e of due) this.play(e, camera);
  }

  private stopRoll(id: number) {
    this.rolls.get(id)?.sample.stop();
    this.rolls.delete(id);
  }

  /** Voices that belong to an object: rebuilt from the world each frame so a late joiner hears them from the right place. */
  sync(d: BallistixData, bodies: Body[], frame: number, camera: PS1Cam, state: { catching: boolean[]; motorAge: number; wallAge: number; live: boolean }) {
    if (this.dead) return;
    // The ball's handle (entity +0x94): the landing effect replaces the serve and stops when the ball is freed.
    const live = new Set<number>();
    for (const ball of d.balls) {
      const roll = ball.roll;
      const body = bodies.find(b => b.kind === 'ball' && b.id === ball.id);
      if (!roll || !body || ball.st === -1 || ball.st === 0x12) continue;
      const age = frame - roll[1];
      const envelope = 1 - age / ROLL_FADE;
      if (age < 0 || envelope <= 0) continue;
      live.add(ball.id);
      const stereo = this.levels(camera, body.x * BD_U, -body.y * BD_U + BALL_Y, -body.z * BD_U, envelope);
      const playing = this.rolls.get(ball.id);
      if (playing && playing.id === roll[0] && playing.at === roll[1] && !playing.sample.ended) { playing.sample.setStereo(stereo); continue; }
      if (playing) this.stopRoll(ball.id);
      const tone = this.tone(roll[0]);
      if (!tone) continue;
      const sample = sfx.startSample(tone.file, tone.loop, BD_FULL, tone.rate, age * tone.rate / 30, stereo);
      if (sample) this.rolls.set(ball.id, { id: roll[0], at: roll[1], sample });
    }
    for (const id of [...this.rolls.keys()]) if (!live.has(id)) this.stopRoll(id);

    // BEACH BALL catch (FUN_800c02f8): effect 1451 + seat on the ship's handle, released with the ball or the state.
    state.catching.forEach((on, slot) => {
      const playing = this.catches.get(slot);
      if (playing && !on) { playing.stop(); this.catches.delete(slot); }
      if (playing || !on) return;
      const tone = this.tone(1451 + slot);
      const sample = tone && tone.loop !== null ? sfx.startSample(tone.file, tone.loop, BD_FULL, tone.rate) : null;
      if (sample) this.catches.set(slot, sample);
    });

    // Knocked-out goals share one barrier loop (handle 0x800c1c60).
    this.wall = this.loop(this.wall, state.wallAge, 1425);
    // N.Gin's launcher keeps effect 1471 on its handle from spin-up to retraction.
    this.motor = this.loop(this.motor, state.motorAge, 1471);

    // SKY BALLS: the setup starts effect 1480 on handle 0x800c1bc4. Each fan failure replaces it with 1481,
    // whose own loop then stays for the rest of the round.
    if (this.variant === 'sky' && state.live) {
      const failed = d.sky?.humAt;
      const at = failed === undefined || frame < failed ? -1 : failed;
      if (this.hum?.at !== at || this.hum.sample.ended) {
        this.hum?.sample.stop();
        this.hum = null;
        const tone = this.tone(at < 0 ? 1480 : 1481);
        const sample = tone && tone.loop !== null ? sfx.startSample(tone.file, tone.loop, BD_FULL, tone.rate, at < 0 ? 0 : (frame - at) * tone.rate / 30) : null;
        if (sample) this.hum = { at, sample };
      }
    }
  }

  /** A looping effect that is `age` ticks old (negative: silent). */
  private loop(playing: Sample | null, age: number, id: number): Sample | null {
    if (age < 0) { playing?.stop(); return null; }
    if (playing && !playing.ended) return playing;
    const tone = this.tone(id);
    if (!tone || tone.loop === null) return null;
    return sfx.startSample(tone.file, tone.loop, BD_FULL, tone.rate, age * tone.rate / 30);
  }

  dispose() {
    this.dead = true;
    this.queued.length = 0;
    for (const id of [...this.rolls.keys()]) this.stopRoll(id);
    for (const sample of this.catches.values()) sample.stop();
    this.catches.clear();
    this.wall?.stop(); this.motor?.stop(); this.hum?.sample.stop();
    this.wall = this.motor = this.hum = null;
  }
}
