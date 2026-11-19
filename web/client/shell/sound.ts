// WebAudio: synthesised SFX, plus lazily-streamed Crash Bash music (assets/audio) with seamless loops and crossfades.
import { ASSET_BASE } from '../crash';
type Wave = OscillatorType;

interface MusicMeta { file: string; loopStart: number | null; loopEnd: number | null }
interface AudioIndex { music: Record<string, MusicMeta>; sfx?: { ui?: { guesses?: Record<string, string> }; banks?: Record<string, { samples: { file?: string | null }[] }> } }

export type Sfx =
  | 'click' | 'pop' | 'turn' | 'roll' | 'land' | 'step' | 'coin' | 'bad' | 'lucky' | 'chaos' | 'crystal'
  | 'beep' | 'go' | 'tick' | 'whoosh' | 'win' | 'lose' | 'thud' | 'boom' | 'emote' | 'reveal' | 'drum';

class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  vol = { music: 0.6, sfx: 0.8 };
  private lastPlay = new Map<string, number>();
  // music
  private want: string | null = null;
  private cur: { key: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
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

  /** Switch background music (null = silence). Crossfades; loads on demand. Safe to call before unlock(). */
  music(key: string | null) {
    this.want = key;
    void this.applyMusic();
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
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + fade);
    src.connect(g).connect(bus);
    src.start(t);
    this.cur = { key, src, gain: g };
    src.onended = () => { if (this.cur?.src === src) this.cur = null; };
  }

  setVolume(kind: 'music' | 'sfx', v: number) {
    this.vol[kind] = Math.min(1, Math.max(0, v));
    try { localStorage.setItem('cbp-vol-' + kind, String(this.vol[kind])); } catch { /* ignore */ }
    if (kind === 'music' && this.musicBus) this.musicBus.gain.value = this.vol.music;
    if (kind === 'sfx' && this.sfxBus) this.sfxBus.gain.value = this.vol.sfx;
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
      this.sfxBus.gain.value = this.vol.sfx;
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.vol.music;
      this.musicBus.connect(this.master);
      // menu blips from the disc (small files)
      void this.loadIndex().then((idx) => { for (const p of Object.values(idx?.sfx?.ui?.guesses ?? {})) void this.loadBuffer(p.replace(/^sfx\//, 'sfx/')); });
      const n = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, n, n);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    void this.applyMusic();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('cbp-muted', m ? '1' : '0'); } catch { /* ignore */ }
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  private uiFiles: Record<string, string> = { cursorSelect: 'sfx/0272/9.mp3' };
  private uiFile(k: string) { return this.uiFiles[k]; }

  private tone(f: number, dur: number, type: Wave = 'square', vol = 0.2, slide = 0, delay = 0) {
    const c = this.ctx, m = this.master;
    if (!c || !m) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus ?? m);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol = 0.2, freq = 1200, q = 1, delay = 0, sweepTo = 0) {
    const c = this.ctx, m = this.master;
    if (!c || !m || !this.noiseBuf) return;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.sfxBus ?? m);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  play(name: Sfx, pitch = 1) {
    if (this.muted || !this.ctx) return;
    // rate limit identical sounds a little
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? 0) < 35) return;
    this.lastPlay.set(name, now);
    const p = pitch;
    switch (name) {
      case 'click': if (!this.playFile(this.uiFile('cursorSelect'), 0.7)) this.tone(660 * p, 0.06, 'square', 0.12); break;
      case 'pop': this.tone(420 * p, 0.12, 'sine', 0.25, 500); break;
      case 'turn': this.tone(784, 0.1, 'triangle', 0.25); this.tone(1175, 0.18, 'triangle', 0.25, 0, 0.09); break;
      case 'roll':
        for (let i = 0; i < 9; i++) { this.noise(0.05, 0.25, 900 + Math.random() * 1400, 2, i * 0.055); this.tone(140 + Math.random() * 80, 0.05, 'square', 0.1, 0, i * 0.055); }
        break;
      case 'land': this.tone(180, 0.18, 'sine', 0.4, -110); this.noise(0.1, 0.3, 500, 1); break;
      case 'step': this.tone(320 * p, 0.07, 'sine', 0.22, -120); this.noise(0.03, 0.1, 2500, 2); break;
      case 'coin': this.tone(988, 0.07, 'square', 0.16); this.tone(1319, 0.22, 'square', 0.16, 0, 0.07); break;
      case 'bad': this.tone(330, 0.3, 'sawtooth', 0.2, -200); this.tone(220, 0.35, 'sawtooth', 0.18, -120, 0.12); break;
      case 'lucky': [659, 784, 988, 1319].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.25, 0, i * 0.07)); break;
      case 'chaos': for (let i = 0; i < 6; i++) this.tone(300 + (i % 2) * 180, 0.09, 'sawtooth', 0.14, 60, i * 0.07); this.noise(0.4, 0.15, 400, 1, 0, 2000); break;
      case 'crystal':
        [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, i === 6 ? 0.7 : 0.14, 'square', 0.17, 0, i * 0.1));
        [1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.9, 'triangle', 0.12, 0, 0.7 + i * 0.01));
        break;
      case 'beep': this.tone(520, 0.16, 'square', 0.22); break;
      case 'go': this.tone(1040, 0.5, 'square', 0.25); this.tone(1560, 0.5, 'triangle', 0.15); break;
      case 'tick': this.tone(1500 * p, 0.025, 'square', 0.09); break;
      case 'whoosh': this.noise(0.35, 0.25, 300, 0.8, 0, 3000); break;
      case 'win':
        [523, 659, 784, 1047, 0, 784, 1047, 1319].forEach((f, i) => f && this.tone(f, 0.2, 'square', 0.18, 0, i * 0.13));
        this.tone(1568, 0.9, 'triangle', 0.18, 0, 1.1);
        break;
      case 'lose': [392, 349, 311, 262].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.22, -15, i * 0.16)); break;
      case 'thud': this.tone(120, 0.12, 'sine', 0.4, -60); this.noise(0.06, 0.2, 800, 1); break;
      case 'boom': this.tone(90, 0.4, 'sawtooth', 0.35, -60); this.noise(0.45, 0.35, 600, 0.8, 0, 120); break;
      case 'emote': this.tone(880, 0.07, 'triangle', 0.2); this.tone(1175, 0.1, 'triangle', 0.2, 0, 0.06); break;
      case 'reveal': this.tone(523, 0.12, 'square', 0.15); this.tone(784, 0.3, 'square', 0.15, 0, 0.1); break;
      case 'drum': for (let i = 0; i < 8; i++) { this.noise(0.06, 0.25, 220, 1.5, i * 0.07); this.tone(110, 0.06, 'sine', 0.3, 0, i * 0.07); } break;
    }
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
