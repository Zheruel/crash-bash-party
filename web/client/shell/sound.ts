// WebAudio: disc samples (menu blips, announcer, voices, effects) plus lazily-streamed Crash Bash music (assets/audio)
// with seamless loops and crossfades. Nothing here is synthesised: every sound is a sample the game itself plays.
import { ASSET_BASE } from '../crash';

interface MusicMeta { file: string; loopStart: number | null; loopEnd: number | null }
interface AudioIndex { music: Record<string, MusicMeta>; sfx?: { banks?: Record<string, { samples: { file?: string | null }[] }> } }

// FUN_8002bea8 changes SEQ volume from 0x7f to 0x55. FUN_800447dc squares it for the SPU.
const RESULT_MUSIC_GAIN = (0x55 / 0x7f) ** 2;
// The disc's default balance (music option 70, effects 100), measured on emulator captures of four arenas: against a
// full-level effect (FUN_80022660 volume 0x1000) the music sits 1.3-7.5 dB (mean 3.9 dB) above what our RMS-normalised
// tracks gave at the default sliders. The two trims move the default mix there and keep the summed peak where it was.
const MUSIC_TRIM = 1.25, SFX_TRIM = 0.8;
// FUN_8007d9dc ducks a draw (FUN_8002c29c) and only clears it (FUN_8002c290) when its 120-tick result timer runs out, on the
// tick the round leaves, so a draw stays ducked through the whole result like a win.
const DRAW_DUCK_MS = Infinity;

/**
 * The menu blips of the announcer banks 0276 / 0277 / 0278 (all three hold the same tones; the titles, level-select and
 * options code keys them: 0x190 on every cursor step, 0x192 on a confirm, 0x195 on back / cancel). Every one keys at
 * volume 0x1000, pitch 0x1e00, no position.
 */
export type Sfx = 'move' | 'select' | 'back';
const MENU: Record<Sfx, { id: number; file: string }> = {
  move: { id: 0x190, file: 'sfx/0274/1.mp3' },
  select: { id: 0x192, file: 'sfx/0274/2.mp3' },
  back: { id: 0x195, file: 'sfx/0272/7.mp3' },
};
const MENU_VOL = 0.9;

class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  muted = false;
  vol = { music: 0.6, sfx: 0.8 };
  // music
  private want: string | null = null;
  private wantRoundMusic = false;
  private cur: { key: string; src: AudioBufferSourceNode; gain: GainNode; resultGain: GainNode } | null = null;
  private resultDuckUntil: number | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private index: Promise<AudioIndex | null> | null = null;
  private applying = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('cbp-muted') === '1';
      const m = parseFloat(localStorage.getItem('cbp-vol-music') ?? ''), f = parseFloat(localStorage.getItem('cbp-vol-sfx') ?? '');
      if (isFinite(m)) this.vol.music = Math.min(1, Math.max(0, m));
      if (isFinite(f)) this.vol.sfx = Math.min(1, Math.max(0, f));
    } catch { /* no storage */ }
  }

  private loadIndex() {
    this.index ??= fetch(ASSET_BASE + 'audio/index.json').then((r) => (r.ok ? (r.json() as Promise<AudioIndex>) : null)).catch(() => null);
    return this.index;
  }
  /** Bank samples are de-duplicated on disc: 'sfx/<bank>/<n>.mp3' may live in another bank (audio/index.json). */
  private async resolve(path: string): Promise<string | null> {
    const m = /^sfx\/(\d{4})\/(\d+)\.mp3$/.exec(path);
    if (!m) return path;
    const idx = await this.loadIndex();
    const smp = idx?.sfx?.banks?.[m[1]]?.samples?.[+m[2]];
    if (!smp) return path;
    return smp.file ?? null;
  }
  private loadBuffer(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = this.resolve(path)
        .then((f) => (f ? fetch(ASSET_BASE + 'audio/' + f) : null))
        .then((r) => (r && r.ok ? r.arrayBuffer() : null))
        .then((ab) => (ab && this.ctx ? this.ctx.decodeAudioData(ab) : null))
        .catch(() => null);
      this.buffers.set(path, p);
    }
    return p;
  }

  /** Does the audio index know this music key (case/punctuation-insensitive prefix match)? Returns the real key. */
  async musicKey(want: string): Promise<string | null> {
    const idx = await this.loadIndex();
    if (!idx) return null;
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const w = norm(want);
    const keys = Object.keys(idx.music);
    return keys.find((k) => norm(k) === w) ?? keys.find((k) => norm(k).startsWith(w)) ?? null;
  }

  /** Switch background music (null = silence). Only arena music takes the round-result gain. */
  music(key: string | null, scope?: 'round') {
    this.want = key;
    this.wantRoundMusic = scope === 'round';
    this.updateResultGain();
    void this.applyMusic();
  }

  /** An individual win ducks until the round leaves. A draw may specify its own duck duration. */
  enterRoundResult(outcome: 'winner' | 'draw', at = performance.now(), drawDuckMs = DRAW_DUCK_MS) {
    if (this.resultDuckUntil !== null) return;
    this.resultDuckUntil = outcome === 'draw' ? at + drawDuckMs : Infinity;
    this.updateResultGain();
  }

  /** Start a fresh round, including a replay of the same arena track. */
  clearRoundResult() {
    if (this.resultDuckUntil === null) return;
    this.resultDuckUntil = null;
    this.updateResultGain();
  }

  private updateResultGain() {
    if (this.cur && this.cur.key === this.want) this.setResultGain(this.cur.resultGain.gain);
  }

  private setResultGain(gain: AudioParam) {
    const t = this.ctx!.currentTime;
    const remaining = this.wantRoundMusic && this.resultDuckUntil !== null ? this.resultDuckUntil - performance.now() : 0;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(remaining > 0 ? RESULT_MUSIC_GAIN : 1, t);
    if (remaining > 0 && Number.isFinite(remaining)) gain.setValueAtTime(1, t + remaining / 1000);
  }

  private async applyMusic() {
    if (this.applying || !this.ctx) return;
    this.applying = true;
    try {
      for (let guard = 0; guard < 4; guard++) {
        const key = this.want;
        if (key === (this.cur?.key ?? null)) break;
        let buf: AudioBuffer | null = null, meta: MusicMeta | undefined;
        if (key) {
          const idx = await this.loadIndex();
          meta = idx?.music[key];
          if (meta) buf = await this.loadBuffer(meta.file);
          if (this.want !== key) continue; // changed while loading
        }
        this.crossfadeTo(key, buf, meta);
        if (!buf && key) break; // nothing to play for this key
      }
    } finally { this.applying = false; }
  }

  private crossfadeTo(key: string | null, buf: AudioBuffer | null, meta?: MusicMeta) {
    const c = this.ctx!, bus = this.musicBus!;
    const t = c.currentTime, fade = 1.3;
    const old = this.cur;
    if (old) {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + fade);
      try { old.src.stop(t + fade + 0.05); } catch { /* already stopped */ }
      this.cur = null;
    }
    if (!key || !buf || !meta) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    if (meta.loopStart != null && meta.loopEnd != null) { src.loop = true; src.loopStart = meta.loopStart; src.loopEnd = meta.loopEnd; }
    const g = c.createGain();
    const resultGain = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + fade);
    this.setResultGain(resultGain.gain);
    src.connect(g).connect(resultGain).connect(bus);
    src.start(t);
    this.cur = { key, src, gain: g, resultGain };
    src.onended = () => { if (this.cur?.src === src) this.cur = null; };
  }

  setVolume(kind: 'music' | 'sfx', v: number) {
    this.vol[kind] = Math.min(1, Math.max(0, v));
    try { localStorage.setItem('cbp-vol-' + kind, String(this.vol[kind])); } catch { /* ignore */ }
    if (kind === 'music' && this.musicBus) this.musicBus.gain.value = this.vol.music * MUSIC_TRIM;
    if (kind === 'sfx' && this.sfxBus) this.sfxBus.gain.value = this.vol.sfx * SFX_TRIM;
  }

  /**
   * A short sample from the disc's sound banks (e.g. 'sfx/0272/9.mp3'). Returns false if it isn't loaded yet; with `late`
   * it then plays as soon as it has loaded (one-off voices that should not be skipped the first time).
   */
  playFile(path: string, vol = 0.8, late = false, rate = 1): boolean {
    const c = this.ctx;
    if (!c || this.muted || !this.sfxBus) return false;
    let p = this.buffers.get(path);
    if (!p) { const q = this.loadBuffer(path); if (!late) return false; p = q; }
    void p.then((b) => {
      if (!b || !this.sfxBus) return;
      const s = c.createBufferSource(), g = c.createGain();
      s.buffer = b; g.gain.value = vol;
      if (rate !== 1) s.playbackRate.value = rate;
      s.connect(g).connect(this.sfxBus);
      s.start();
    });
    return true;
  }

  /** Decode once while the arena loads so the first cue keeps its place in the sequence. */
  preloadFile(path: string) {
    if (this.ctx) void this.loadBuffer(path);
  }

  /** Start a disc sample with its loop point. The returned function also cancels a pending load. */
  loopFile(path: string, loopStart: number, vol = 0.8, rate = 1): () => void {
    return this.startSample(path, loopStart, vol, rate)?.stop ?? (() => {});
  }

  /** Offset is in source seconds. An optional cue window uses performance.now() milliseconds. */
  startSample(path: string, loopStart: number | null, vol: number, rate: number, offset = 0, stereo?: [number, number],
    schedule?: { at: number; until: number }) {
    const ctx = this.ctx, bus = this.sfxBus;
    if (!ctx || !bus) return null;
    const audioOrigin = schedule ? ctx.currentTime - performance.now() / 1000 : 0;
    const startAt = schedule ? audioOrigin + schedule.at / 1000 : 0;
    const stopAt = schedule ? audioOrigin + schedule.until / 1000 : undefined;
    let stopped = false;
    let source: AudioBufferSourceNode | undefined;
    let channels: [GainNode, GainNode] | undefined;
    const setStereo = (levels: [number, number]) => {
      stereo = levels;
      if (channels) {
        channels[0].gain.value = levels[0];
        channels[1].gain.value = levels[1];
      }
    };
    void this.loadBuffer(path).then((buffer) => {
      const expired = stopAt !== undefined && (ctx.currentTime >= stopAt || ctx.currentTime - startAt > .25);
      if (stopped || expired || !buffer || (loopStart ?? offset) >= buffer.duration) { stopped = true; return; }
      const gain = ctx.createGain();
      gain.gain.value = vol;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loopStart !== null;
      if (loopStart !== null) source.loopStart = loopStart;
      source.playbackRate.value = rate;
      let merger: ChannelMergerNode | undefined;
      source.connect(gain);
      if (stereo) {
        // The disc sends a mono voice to two independently controlled SPU channels.
        merger = ctx.createChannelMerger(2);
        channels = [ctx.createGain(), ctx.createGain()];
        channels.forEach((channel, i) => gain.connect(channel).connect(merger!, 0, i));
        setStereo(stereo);
        merger.connect(bus);
      } else gain.connect(bus);
      source.onended = () => {
        stopped = true;
        source?.disconnect();
        gain.disconnect();
        channels?.forEach(channel => channel.disconnect());
        merger?.disconnect();
        source = undefined;
      };
      const position = loopStart !== null && offset >= buffer.duration
        ? loopStart + (offset - loopStart) % (buffer.duration - loopStart) : offset;
      source.start(Math.max(0, startAt), position);
      if (stopAt !== undefined) source.stop(stopAt);
    });
    return {
      get ended() { return stopped; },
      setStereo,
      update(nextRate: number, nextOffset: number) {
        offset = nextOffset;
        if (nextRate === rate) return;
        rate = nextRate;
        if (source) source.playbackRate.value = rate;
      },
      stop() {
        if (stopped) return;
        stopped = true;
        source?.stop();
      },
    };
  }

  /** Call from a user gesture. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.vol.sfx * SFX_TRIM;
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.vol.music * MUSIC_TRIM;
      this.musicBus.connect(this.master);
      for (const m of Object.values(MENU)) void this.loadBuffer(m.file);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    void this.applyMusic();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('cbp-muted', m ? '1' : '0'); } catch { /* ignore */ }
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  /** A menu blip of the announcer banks (see MENU). */
  play(name: Sfx) {
    const m = MENU[name];
    this.playFile(m.file, MENU_VOL, true, sfxRate('0276', m.id));
  }
}

export const sfx = new SoundSystem();

/**
 * The game's pitch for a sound id: every effect keys note 60 against its VAB tone's centre + fine tune, and one sample
 * often serves several ids at different pitches (tools/sfx_pitch.py -> assets/audio/pitch.json {bank: {id: rate}}).
 */
let pitchTable: Record<string, Record<string, number>> | null = null;
void fetch(ASSET_BASE + 'audio/pitch.json').then((r) => (r.ok ? r.json() : null)).then((j) => { pitchTable = j; }).catch(() => {});
export const sfxRate = (bank: string | undefined, id: number): number => (bank && pitchTable?.[bank]?.[String(id)]) || 1;
