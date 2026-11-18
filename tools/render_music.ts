/**
 * Offline renderer for the Crash Bash (PS1) sound banks: Sony SEQ + VAB -> PCM -> MP3.
 * Reads disc/dat/NNNN.t{0c,10,14}.bin (extracted from the user's own disc), writes assets/audio/.
 *
 *   cd web && npx tsx ../tools/render_music.ts music   [--only 0296,0294]   # music tracks
 *   cd web && npx tsx ../tools/render_music.ts sfx                          # per-sample SFX / voice banks
 *   cd web && npx tsx ../tools/render_music.ts index                        # (re)write assets/audio/index.json
 *   cd web && npx tsx ../tools/render_music.ts all
 *
 * Needs ffmpeg (libmp3lame) on PATH. Details and caveats: docs/audio.md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSoundBank, parseContainer, decodeAdpcm, type SoundBankData, type SeqData } from '../web/client/disc/sound';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAT = path.join(ROOT, 'disc/dat');
const OUT = path.join(ROOT, 'assets/audio');
const SR = 44100; // SPU native rate; one output sample == one SPU tick

// ---------------------------------------------------------------- bank loading

interface Tone {
  program: number; tone: number; vag: number; vol: number; pan: number; center: number; fine: number;
  min: number; max: number; adsr1: number; adsr2: number; reverb: boolean; pbMin: number; pbMax: number;
  /** effective root note in semitones: the note that plays the VAG at 44.1 kHz (measured: center - fine/128) */
  root: number;
}
interface Bank {
  id: number; file: string; kind: number; b: SoundBankData; tones: Tone[]; pcm: Float32Array[]; loopStart: number[];
}

function datFile(n: number): string | null {
  const p = String(n).padStart(4, '0');
  const f = readdirSync(DAT).find((x) => x.startsWith(p + '.'));
  return f ?? null;
}

const bankCache = new Map<number, Bank | null>();
export function loadBank(n: number): Bank | null {
  if (bankCache.has(n)) return bankCache.get(n)!;
  const f = datFile(n);
  let bank: Bank | null = null;
  if (f && /\.t(0c|10|14)\./.test(f)) {
    try {
      const d = new Uint8Array(readFileSync(path.join(DAT, f)));
      const b = parseSoundBank(d);
      const c = parseContainer(d);
      const toneO = c.vab[0] + 32 + 128 * 16;
      const tones: Tone[] = b.vab.tones.map((t) => {
        const o = toneO + (t.program * 16 + t.tone) * 32;
        return {
          program: t.program, tone: t.tone, vag: t.vag, vol: t.vol, pan: t.pan, center: t.center, fine: t.fine, min: t.min, max: t.max,
          adsr1: t.adsr1, adsr2: t.adsr2, reverb: (d[o + 1] & 4) !== 0, pbMin: d[o + 12], pbMax: d[o + 13], root: t.center - t.fine / 128,
        };
      });
      const pcm: Float32Array[] = [];
      const loopStart: number[] = [];
      for (const s of b.samples) {
        const i16 = decodeAdpcm(s.adpcm);
        const f32 = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
        pcm.push(f32);
        loopStart.push(s.loops ? Math.max(0, s.loopStart) : -1);
      }
      bank = { id: n, file: f, kind: b.kind, b, tones, pcm, loopStart };
    } catch {
      bank = null; // text files that share the type id
    }
  }
  bankCache.set(n, bank);
  return bank;
}

// ---------------------------------------------------------------- SEQ -> notes

interface Pt { t: number; v: number }
interface ChanTimeline { vol: Pt[]; pan: Pt[]; expr: Pt[]; bend: Pt[] }
interface Note { start: number; end: number; ch: number; note: number; vel: number; prog: number }
interface SeqPlan {
  notes: Note[]; chans: ChanTimeline[]; loopStart: number | null; loopEnd: number; endSample: number; startSample: number;
}

/** tick -> output sample using the tempo map (none of the shipped SEQs change tempo, but support it). */
function makeTickMap(seq: SeqData): (tick: number) => number {
  const tempos: { tick: number; us: number }[] = [{ tick: 0, us: seq.tempo }];
  for (const e of seq.events) if (e.type === 0xff && e.a === 0x51) tempos.push({ tick: e.tick, us: e.b });
  const base: number[] = [0];
  for (let i = 1; i < tempos.length; i++) {
    base[i] = base[i - 1] + ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].us) / seq.resolution / 1e6;
  }
  return (tick) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].tick > tick) i--;
    return Math.round((base[i] + ((tick - tempos[i].tick) * tempos[i].us) / seq.resolution / 1e6) * SR);
  };
}

function planSeq(seq: SeqData): SeqPlan {
  const toS = makeTickMap(seq);
  // loop markers: CC99 = 20 loop start, 30 loop end (16 = data start). Event 0xff 0x2f = end of track.
  let ls: number | null = null, le: number | null = null, endTick = 0;
  for (const e of seq.events) {
    if (e.type === 0xb0 && e.a === 99) { if (e.b === 20) ls = e.tick; if (e.b === 30) le = e.tick; }
    if (e.type === 0xff && e.a === 0x2f) endTick = e.tick;
  }
  const stopTick = le ?? endTick ?? seq.events[seq.events.length - 1].tick;
  const chans: ChanTimeline[] = Array.from({ length: 16 }, () => ({ vol: [], pan: [], expr: [], bend: [] }));
  const prog = new Array(16).fill(0), pedal = new Array(16).fill(false);
  const held: Note[][][] = Array.from({ length: 16 }, () => Array.from({ length: 128 }, () => []));
  const deferred: Note[][] = Array.from({ length: 16 }, () => []);
  const notes: Note[] = [];
  const off = (n: Note, t: number) => { if (n.end < 0) n.end = t; };
  for (const e of seq.events) {
    if (e.tick >= stopTick) break;
    const t = toS(e.tick), ch = e.channel;
    if (e.type === 0xc0) prog[ch] = e.a;
    else if (e.type === 0xb0) {
      if (e.a === 7) chans[ch].vol.push({ t, v: e.b });
      else if (e.a === 10) chans[ch].pan.push({ t, v: e.b });
      else if (e.a === 11) chans[ch].expr.push({ t, v: e.b });
      else if (e.a === 64) {
        const down = e.b >= 64;
        if (!down && pedal[ch]) { for (const n of deferred[ch]) off(n, t); deferred[ch] = []; }
        pedal[ch] = down;
      }
    } else if (e.type === 0xe0) chans[ch].bend.push({ t, v: (e.a | (e.b << 7)) - 8192 });
    else if (e.type === 0x90 && e.b > 0) {
      const n: Note = { start: t, end: -1, ch, note: e.a, vel: e.b, prog: prog[ch] };
      held[ch][e.a].push(n); notes.push(n);
    } else if (e.type === 0x80 || (e.type === 0x90 && e.b === 0)) {
      const list = held[ch][e.a];
      for (const n of list) { if (pedal[ch]) deferred[ch].push(n); else off(n, t); }
      held[ch][e.a] = [];
    }
  }
  const endSample = toS(stopTick);
  for (const n of notes) off(n, endSample);
  return { notes, chans, loopStart: ls === null ? null : toS(ls), loopEnd: endSample, endSample, startSample: 0 };
}

// ---------------------------------------------------------------- voice rendering

const RATE_TAB_MAX = 0x7fff;

interface Mix { L: Float32Array; R: Float32Array; sL: Float32Array | null; sR: Float32Array | null }

/** Hardware-style ADSR stepper (PS1 SPU). Returns a closure advancing one 44.1 kHz tick. */
function makeEnv(adsr1: number, adsr2: number) {
  const aExp = (adsr1 >> 15) & 1, aShift = (adsr1 >> 10) & 31, aStep = 7 - ((adsr1 >> 8) & 3);
  const dShift = (adsr1 >> 4) & 15, sLevel = ((adsr1 & 15) + 1) * 0x800;
  const sExp = (adsr2 >> 15) & 1, sDec = (adsr2 >> 14) & 1, sShift = (adsr2 >> 8) & 31, sStepRaw = (adsr2 >> 6) & 3;
  const sStep = sDec ? -8 + sStepRaw : 7 - sStepRaw;
  const rExp = (adsr2 >> 5) & 1, rShift = adsr2 & 31;
  let level = 0, phase = 0 /*0 A,1 D,2 S,3 R,4 off*/, counter = 0;
  const run = (shift: number, step: number, exp: number): void => {
    let cycles = 1 << Math.max(0, shift - 11);
    let delta = step << Math.max(0, 11 - shift);
    if (exp && step > 0 && level > 0x6000) cycles *= 4;
    if (exp && step < 0) delta = (delta * level) >> 15;
    if (counter <= 0) { counter = cycles; level += delta; if (level < 0) level = 0; if (level > RATE_TAB_MAX) level = RATE_TAB_MAX; }
    counter--;
  };
  return {
    release() { if (phase < 3) { phase = 3; counter = 0; } },
    get done() { return phase === 4; },
    tick(): number {
      switch (phase) {
        case 0: run(aShift, aStep, aExp); if (level >= RATE_TAB_MAX) { phase = 1; counter = 0; } break;
        case 1: run(dShift, -8, 1); if (level <= sLevel) { phase = 2; counter = 0; } break;
        case 2: run(sShift, sStep, sExp); if (level <= 0 && sDec) phase = 4; break;
        case 3: run(rShift, -8, rExp); if (level <= 0) phase = 4; break;
      }
      return level;
    },
  };
}

function lookup(arr: Pt[], t: number, def: number, cur: { i: number }): number {
  while (cur.i + 1 < arr.length && arr[cur.i + 1].t <= t) cur.i++;
  if (!arr.length || arr[cur.i].t > t) return def;
  return arr[cur.i].v;
}

function renderVoice(bank: Bank, tone: Tone, n: Note, plan: SeqPlan, mix: Mix, progAttr: { vol: number; pan: number }, bendRangeDefault = 2): void {
  const pcm = bank.pcm[tone.vag];
  if (!pcm || pcm.length < 4) return;
  const loopStart = bank.loopStart[tone.vag];
  const loops = loopStart >= 0;
  const ct = plan.chans[n.ch];
  const cv = { i: 0 }, cp = { i: 0 }, ce = { i: 0 }, cb = { i: 0 };
  const env = makeEnv(tone.adsr1, tone.adsr2);
  const baseGain = (tone.vol / 127) * (progAttr.vol / 127) * (n.vel / 127);
  const toneAdj = (tone.pan - 64) + (progAttr.pan - 64);
  const bendUp = tone.pbMax || bendRangeDefault, bendDown = tone.pbMin || bendRangeDefault;
  const total = mix.L.length;
  let pos = 0, released = false;
  const bs = 32;
  const baseStep = Math.pow(2, (n.note - tone.root) / 12);
  let t = n.start;
  const last = pcm.length - 1;
  while (t < total) {
    const blockEnd = Math.min(total, t + bs);
    const vol = lookup(ct.vol, t, 100, cv) / 127, expr = lookup(ct.expr, t, 127, ce) / 127;
    const panv = Math.max(0, Math.min(127, lookup(ct.pan, t, 64, cp) - 64 + 64 + toneAdj)) / 127;
    const bend = lookup(ct.bend, t, 0, cb);
    const semis = bend >= 0 ? (bend / 8192) * bendUp : (bend / 8192) * bendDown;
    const step = baseStep * (semis ? Math.pow(2, semis / 12) : 1);
    const g = baseGain * vol * expr;
    const ang = panv * Math.PI * 0.5;
    const gl = g * Math.cos(ang) * Math.SQRT2, gr = g * Math.sin(ang) * Math.SQRT2;
    for (; t < blockEnd; t++) {
      if (!released && t >= n.end) { released = true; env.release(); }
      const lv = env.tick();
      if (env.done) return;
      if (pos >= last) {
        if (!loops) return;
        pos = loopStart + (pos - last);
      }
      const i = pos | 0, f = pos - i;
      const y0 = pcm[i > 0 ? i - 1 : 0], y1 = pcm[i], y2 = pcm[i + 1 <= last ? i + 1 : last], y3 = pcm[i + 2 <= last ? i + 2 : last];
      // Catmull-Rom cubic
      const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      const s = ((c3 * f + c2) * f + c1) * f + y1;
      const a = s * (lv / 32768);
      mix.L[t] += a * gl; mix.R[t] += a * gr;
      if (tone.reverb && mix.sL) { mix.sL[t] += a * gl; mix.sR![t] += a * gr; }
      pos += step;
    }
  }
}

/** Freeverb-style stereo reverb for the SPU "reverb on" send. */
function reverb(inL: Float32Array, inR: Float32Array, room = 0.8, damp = 0.35): [Float32Array, Float32Array] {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
  const n = inL.length;
  const run = (inp: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(n);
    for (const dl of combs) {
      const len = dl + spread, buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < n; i++) {
        const o = buf[idx];
        store = o * (1 - damp) + store * damp;
        buf[idx] = inp[i] * 0.015 + store * room;
        if (++idx >= len) idx = 0;
        out[i] += o;
      }
    }
    for (const dl of aps) {
      const len = dl + spread, buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const b = buf[idx], x = out[i];
        out[i] = -x + b;
        buf[idx] = x + b * 0.5;
        if (++idx >= len) idx = 0;
      }
    }
    return out;
  };
  return [run(inL, 0), run(inR, 23)];
}

// ---------------------------------------------------------------- music

export interface RenderedTrack {
  pcmL: Float32Array; pcmR: Float32Array; loopStart: number | null; loopEnd: number | null; seconds: number;
  peak: number; rms: number; notes: number; gain: number;
}

export function renderSeq(bank: Bank, seq: SeqData, opts: { wet?: number; target?: number } = {}): RenderedTrack {
  const plan = planSeq(seq);
  const tail = SR * 6;
  const total = plan.endSample + tail;
  const mix: Mix = { L: new Float32Array(total), R: new Float32Array(total), sL: new Float32Array(total), sR: new Float32Array(total) };
  const progs = bank.b.vab.programs;
  const byProg = new Map<number, Tone[]>();
  for (const t of bank.tones) { if (!byProg.has(t.program)) byProg.set(t.program, []); byProg.get(t.program)!.push(t); }
  let nNotes = 0;
  for (const n of plan.notes) {
    const tones = byProg.get(n.prog);
    if (!tones) continue;
    for (const t of tones) {
      if (n.note < t.min || n.note > t.max) continue;
      renderVoice(bank, t, n, plan, mix, { vol: progs[n.prog]?.vol ?? 127, pan: progs[n.prog]?.pan ?? 64 });
      nNotes++;
    }
  }
  // reverb send -> wet
  const [wl, wr] = reverb(mix.sL!, mix.sR!);
  const wet = opts.wet ?? 0.9;
  for (let i = 0; i < total; i++) { mix.L[i] += wl[i] * wet; mix.R[i] += wr[i] * wet; }
  let { L, R } = mix;
  let loopStart: number | null = null, loopEnd: number | null = null;
  let len = plan.endSample;
  if (plan.loopStart !== null) {
    // wrap-fold: whatever rings past the loop end belongs at the start of the loop
    const ls = plan.loopStart, le = plan.loopEnd;
    for (let i = 0; i < tail && ls + i < le; i++) { L[ls + i] += L[le + i]; R[ls + i] += R[le + i]; }
    loopStart = ls; loopEnd = le;
  } else {
    len = Math.min(total, plan.endSample + SR * 2);
    const fade = SR;
    for (let i = 0; i < fade; i++) { const g = 1 - i / fade; L[len - fade + i] *= g; R[len - fade + i] *= g; }
  }
  L = L.slice(0, len); R = R.slice(0, len);
  // trim leading digital silence (keep loop points consistent)
  let first = 0;
  while (first < len && Math.abs(L[first]) < 1e-4 && Math.abs(R[first]) < 1e-4) first++;
  first = Math.max(0, first - 200);
  if (loopStart !== null && first > loopStart) first = 0;
  if (first > 0) { L = L.slice(first); R = R.slice(first); if (loopStart !== null) { loopStart -= first; loopEnd! -= first; } }
  // loudness: RMS target, never above -0.5 dBFS peak
  let pk = 0, sq = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk) pk = a; if (b > pk) pk = b; sq += L[i] * L[i] + R[i] * R[i]; }
  const rms = Math.sqrt(sq / (2 * L.length));
  const target = opts.target ?? 0.12; // about -18 dBFS
  const gain = Math.min(target / (rms || 1), 0.94 / (pk || 1));
  for (let i = 0; i < L.length; i++) { L[i] *= gain; R[i] *= gain; }
  return { pcmL: L, pcmR: R, loopStart, loopEnd, seconds: L.length / SR, peak: pk * gain, rms: rms * gain, notes: nNotes, gain };
}

// ---------------------------------------------------------------- ffmpeg

function encodeMp3(pcm: Float32Array[], rate: number, file: string, kbps: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const ch = pcm.length, n = pcm[0].length;
  const buf = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, pcm[c][i]));
    buf.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(rate), '-ac', String(ch), '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-ar', String(rate), '-ac', String(ch), '-id3v2_version', '0', '-write_xing', '1', file];
  const r = spawnSync('ffmpeg', args, { input: buf, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr?.toString());
}

// ---------------------------------------------------------------- level / name mapping

interface LevelRec { name: string; music: number | null; sfx: number[] }
function loadLevels(): LevelRec[] {
  const a = JSON.parse(readFileSync(path.join(ROOT, 'assets/arenas.json'), 'utf8'));
  return a.levels.map((l: any) => ({
    name: l.name as string,
    music: l.files?.music_t10?.index ?? null,
    sfx: (l.files?.sfx_bank_t0c ?? []).map((x: any) => x.index as number),
  }));
}

/** requested key names -> level name in arenas.json (display name) */
const KEYS: [string, string][] = [
  ['warp', 'WARP ROOM 1'], ['title', 'TITLES'], ['podium', 'PODIUM'],
  ['crashball', 'CRASHBALL'], ['beachBall', 'BEACH BALL'], ['nballism', 'N.BALLISM'], ['skyBalls', 'SKY BALLS'],
  ['tiltPanic', 'TILT PANIC'], ['polarPanic', 'POLAR PANIC'], ['meltPanic', 'MELT PANIC'], ['manicPanic', 'MANIC PANIC'],
  ['pogoPainter', 'POGO PAINTER'], ['pogoAGogo', 'POGO-A-GOGO'], ['elPogoLoco', 'EL POGO LOCO'], ['pogoPadlock', 'POGO PADLOCK'],
  ['swampFox', 'SWAMP FOX'], ['desertFox', 'DESERT FOX'], ['jungleFox', 'JUNGLE FOX'], ['metalFox', 'METAL FOX'],
  ['jungleBash', 'JUNGLE BASH'], ['spaceBash', 'SPACE BASH'], ['snowBash', 'SNOW BASH'], ['drainBash', 'DRAIN BASH'],
  ['dotDash', 'DOT DASH'], ['toxicDash', 'TOXIC DASH'], ['splashDash', 'SPLASH DASH'], ['dantesDash', "DANTE'S DASH"],
  // extra (not requested): boss / bonus arenas
  ['papuPummel', 'PAPU PUMMEL'], ['bigBadFox', 'BIG BAD FOX'], ['bearminator', 'BEARMINATOR'], ['ringDing', 'RING DING'],
  ['dragonDrop', 'DRAGON DROP'], ['malletMash', 'MALLET MASH'], ['kegKaboom', 'KEG KABOOM'], ['oxideRide', 'OXIDE RIDE'],
  ['tieBreaker', 'TIE-BREAKER'],
];

const MUSIC_BITRATE = 96;

function musicPlan(levels: LevelRec[]) {
  const byName = new Map(levels.filter((l) => l.name).map((l) => [l.name, l]));
  const keys = KEYS.map(([key, name]) => ({ key, name, file: byName.get(name)?.music ?? null, sfx: byName.get(name)?.sfx ?? [] }));
  return keys;
}

function cmdMusic(only: Set<number> | null): Record<string, any> {
  const levels = loadLevels();
  const keys = musicPlan(levels);
  const files = new Map<number, string[]>(); // file index -> keys
  for (const k of keys) if (k.file !== null) { if (!files.has(k.file)) files.set(k.file, []); files.get(k.file)!.push(k.key); }
  const meta: Record<string, any> = {};
  const rendered: any[] = [];
  const jobs: { file: number; seq: number; name: string; keys: string[] }[] = [];
  for (const [file, ks] of files) {
    if (only && !only.has(file)) continue;
    if (file === 294) { jobs.push({ file, seq: 1, name: 'warp', keys: ks }); jobs.push({ file, seq: 2, name: 'warp2', keys: ['warp2'] }); }
    else jobs.push({ file, seq: 1, name: ks[0], keys: ks });
  }
  // unreferenced music banks: render as extras so nothing on the disc is lost
  const referenced = new Set(files.keys());
  for (let n = 279; n <= 303; n++) if (!referenced.has(n) && (!only || only.has(n))) { const b = loadBank(n); if (b && b.b.seqs.length > 1 && b.b.samples.length > 1) jobs.push({ file: n, seq: 1, name: `extra_${String(n).padStart(4, '0')}`, keys: [] }); }
  for (const j of jobs) {
    const bank = loadBank(j.file)!;
    const seq = bank.b.seqs[j.seq];
    if (!seq) { console.log('skip', j.file, 'no seq', j.seq); continue; }
    const t0 = Date.now();
    const r = renderSeq(bank, seq);
    const out = path.join(OUT, 'music', j.name + '.mp3');
    encodeMp3([r.pcmL, r.pcmR], SR, out, MUSIC_BITRATE);
    const info = {
      file: `music/${j.name}.mp3`, source: bank.file, seq: j.seq, seconds: +r.seconds.toFixed(3),
      loopStart: r.loopStart === null ? null : +(r.loopStart / SR).toFixed(4), loopEnd: r.loopEnd === null ? null : +(r.loopEnd / SR).toFixed(4),
      bpm: +(60e6 / seq.tempo).toFixed(1), peak: +r.peak.toFixed(3), rms: +r.rms.toFixed(4), notes: r.notes, bytes: statSync(out).size,
      keys: j.keys,
    };
    meta[j.name] = info;
    rendered.push(info);
    console.log(`${j.name.padEnd(14)} ${bank.file} seq${j.seq} ${info.seconds}s loop ${info.loopStart}-${info.loopEnd} peak ${info.peak} rms ${info.rms} ${(info.bytes / 1024) | 0}KB (${Date.now() - t0}ms)`);
  }
  writeFileSync(path.join(OUT, '.music-meta.json'), JSON.stringify(meta, null, 1));
  return meta;
}

// ---------------------------------------------------------------- sfx

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100];

function stats(x: Float32Array, rate: number) {
  let pk = 0, sq = 0, zc = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; sq += x[i] * x[i]; if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++; }
  const dur = x.length / rate;
  return { peak: +pk.toFixed(3), rms: +Math.sqrt(sq / Math.max(1, x.length)).toFixed(4), zcrHz: +(zc / 2 / Math.max(dur, 1e-6)).toFixed(0) };
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n), r = from / to, last = x.length - 1;
  for (let i = 0; i < n; i++) {
    const p = i * r, k = p | 0, f = p - k;
    const y0 = x[k > 0 ? k - 1 : 0], y1 = x[Math.min(k, last)], y2 = x[Math.min(k + 1, last)], y3 = x[Math.min(k + 2, last)];
    out[i] = (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
  }
  return out;
}

const sfxDone = new Map<string, string>(); // content hash -> relative path
function cmdSfx(): Record<string, any> {
  const banks: Record<string, any> = {};
  for (let n = 0; n < 992; n++) {
    const f = datFile(n);
    if (!f || !f.includes('.t0c.')) continue;
    const bank = loadBank(n);
    if (!bank) continue;
    const id = String(n).padStart(4, '0');
    const samples: any[] = [];
    for (let v = 0; v < bank.pcm.length; v++) {
      const tones = bank.tones.filter((t) => t.vag === v);
      const t0 = tones[0];
      const pcm = bank.pcm[v];
      // The game triggers these directly; middle C (note 60) is assumed. rate = 44.1k * 2^((60-root)/12), root = center - fine/128.
      const rate = t0 ? SR * Math.pow(2, (60 - t0.root) / 12) : 22050;
      const st = stats(pcm, rate);
      const entry: any = {
        n: v, tones: tones.map((t) => ({ program: t.program, tone: t.tone, vol: t.vol, pan: t.pan, center: t.center, fine: t.fine })),
        rate: Math.round(rate), samples: pcm.length, seconds: +(pcm.length / rate).toFixed(3), ...st,
        loop: bank.loopStart[v] >= 0 ? +(bank.loopStart[v] / rate).toFixed(4) : null,
      };
      if (st.peak < 0.002 || pcm.length < 64) { entry.file = null; entry.silent = true; samples.push(entry); continue; }
      const hash = createHash('sha1').update(Buffer.from(pcm.buffer)).update(String(Math.round(rate))).digest('hex');
      let rel = sfxDone.get(hash);
      if (!rel) {
        const target = MP3_RATES.find((r) => r >= rate * 0.97) ?? 44100;
        const x = resample(pcm, rate, target);
        const gain = st.peak > 0.97 ? 0.97 / st.peak : 1;
        if (gain !== 1) for (let i = 0; i < x.length; i++) x[i] *= gain;
        rel = `sfx/${id}/${v}.mp3`;
        encodeMp3([x], target, path.join(OUT, rel), target >= 22050 ? 56 : 40);
        sfxDone.set(hash, rel);
        entry.mp3Rate = target;
      } else entry.dupOf = rel;
      entry.file = rel;
      samples.push(entry);
    }
    banks[id] = { source: bank.file, samples };
    console.log(id, bank.pcm.length, 'samples');
  }
  writeFileSync(path.join(OUT, '.sfx-meta.json'), JSON.stringify(banks, null, 1));
  return banks;
}

// ---------------------------------------------------------------- index

const CHAR_ORDER = ['crash', 'coco', 'tiny', 'dingodile', 'cortex', 'nbrio', 'kongKoala', 'rillaRoo'];

function cmdIndex(): void {
  const levels = loadLevels();
  const musicMeta = JSON.parse(readFileSync(path.join(OUT, '.music-meta.json'), 'utf8'));
  const sfxMeta = JSON.parse(readFileSync(path.join(OUT, '.sfx-meta.json'), 'utf8'));
  const plan = musicPlan(levels);
  const music: Record<string, any> = {};
  const requested = new Set(KEYS.slice(0, 27).map((k) => k[0]));
  for (const m of Object.values<any>(musicMeta)) {
    const base = { seconds: m.seconds, loopStart: m.loopStart, loopEnd: m.loopEnd, bpm: m.bpm, source: m.source };
    const keys: string[] = m.keys.length ? m.keys : [path.basename(m.file, '.mp3')];
    for (const k of keys) {
      let file = m.file;
      // requested names get their own physical file even when the disc shares one track between levels
      if (requested.has(k) && file !== `music/${k}.mp3`) { copyFileSync(path.join(OUT, m.file), path.join(OUT, `music/${k}.mp3`)); file = `music/${k}.mp3`; }
      music[k] = { file, ...base };
    }
  }
  const levelsOut: Record<string, any> = {};
  for (const l of levels) if (l.name) levelsOut[l.name] = { musicFile: l.music, sfxBanks: l.sfx.map((x) => String(x).padStart(4, '0')) };
  // voice banks: 8 characters x 4 sets (182-189, 190-197, 198-205, 206-213). Position of a character inside the
  // 8-entry voice record is [212,213,211,210,207,206,209,208] = offsets [6,7,5,4,1,0,3,2] (character order assumed).
  const offs = [6, 7, 5, 4, 1, 0, 3, 2];
  const f0 = [278, 296, 183, 384, 280, 115, 333, 227]; // median f0 (Hz) measured per voice id, rough
  const voices: Record<string, any> = {};
  CHAR_ORDER.forEach((c, i) => {
    voices[c] = { voiceId: i, confidence: 'low (name assumed from record order; ids 0-7 are certain)', medianF0Hz: f0[i], banks: [182, 190, 198, 206].map((b) => String(b + offs[i]).padStart(4, '0')) };
  });
  const families = ['titles', 'warpPodium', 'ringDing', 'crateCrush', 'papuPummel', 'tankWars', 'pogoPainter', 'ballistix', 'polarPush', 'crashDash', 'dragonDrop', 'oxideRide', 'kegKaboom', 'malletMash'];
  const voiceSetOfFamily: Record<string, number> = {};
  const setSeq = [4, 4, 4, 4, 4, 1, 2, 2, 3, 2, 3, 1, 4, 4];
  families.forEach((f, i) => { voiceSetOfFamily[f] = setSeq[i] - 1; });
  const idx = {
    _notes: 'Rendered from the disc by tools/render_music.ts; see docs/audio.md. Times in seconds. Music files contain intro + ONE loop body; loop with AudioBufferSourceNode loopStart/loopEnd (null = play once).',
    music,
    sfx: {
      banks: Object.fromEntries(Object.entries<any>(sfxMeta).map(([id, b]) => [id, { source: b.source, samples: b.samples.map((x: any) => ({ n: x.n, file: x.file, seconds: x.seconds, rate: x.rate, peak: x.peak, loop: x.loop, ...(x.silent ? { silent: true } : {}) })) }])),
      levelBanks: levelsOut,
      ui: {
        banks: { titles: '0273', warp: '0272', podium: '0181', global: '0153' },
        // GUESSES from duration/spectrum only (not listened to): very short, sharp one-shots
        guesses: Object.fromEntries(Object.entries({ cursorMove: 7, cursorSelect: 9, cursorBack: 8, thudSmall: 19, tickSmall: 25, tickSmall2: 26 }).map(([k, n]) => [k, sfxMeta['0272'].samples[n].file])),
      },
    },
    voices: { characters: voices, setByFamily: voiceSetOfFamily, note: 'banks[i] = voice set i+1 (182-189, 190-197, 198-205, 206-213). Character names are an ASSUMPTION (see docs/audio.md); groups of 4 banks per character are certain.' },
  };
  writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(idx, null, 1));
  console.log('index.json written', Object.keys(music).length, 'music keys', Object.keys(sfxMeta).length, 'sfx banks');
  void plan;
}

// ---------------------------------------------------------------- cli

const [cmd, ...rest] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const onlyArg = rest.indexOf('--only');
const only = onlyArg >= 0 ? new Set(rest[onlyArg + 1].split(',').map(Number)) : null;
if (cmd === 'music' || cmd === 'all') cmdMusic(only);
if (cmd === 'sfx' || cmd === 'all') cmdSfx();
if (cmd === 'index' || cmd === 'all') cmdIndex();
if (!cmd) console.log('usage: render_music.ts music|sfx|index|all [--only 0296,0294]');
void existsSync; void copyFileSync;
