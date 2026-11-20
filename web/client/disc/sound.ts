/** t0c/t10/t14 sound banks: SPU-ADPCM samples + Sony VAB + SEQ. Port of tools/unpack.py; spec in docs/formats/arenas.md. */
import { FormatError, Reader } from './bytes';

const FILTERS: readonly (readonly [number, number])[] = [[0, 0], [60, 0], [115, -52], [98, -55], [122, -60]];
const MAX_FILE = 64 * 1024 * 1024;

export interface VabProgram { index: number; tones: number; vol: number; pan: number }
export interface VabTone {
  program: number;
  tone: number;
  /** sample index into SoundBankData.samples */
  vag: number;
  vol: number;
  pan: number;
  /** root note (MIDI-like) and fine tune */
  center: number;
  fine: number;
  min: number;
  max: number;
  adsr1: number;
  adsr2: number;
  mode: number;
}
export interface VabData {
  version: number;
  id: number;
  nPrograms: number;
  nTones: number;
  nVags: number;
  programs: VabProgram[];
  tones: VabTone[];
}

/** Sony SEQ header + events (MIDI-like; ticks are `resolution` per quarter note). */
export interface SeqEvent {
  tick: number;
  /** status byte high nibble: 0x80 note off, 0x90 note on, 0xB0 controller, 0xC0 program, 0xE0 pitch bend; 0xFF meta */
  type: number;
  channel: number;
  a: number;
  b: number;
}
export interface SeqData {
  version: number;
  resolution: number;
  /** microseconds per quarter note at the start */
  tempo: number;
  timeSig: [number, number];
  events: SeqEvent[];
  /** the raw 'pQES' bytes, for custom parsers */
  raw: Uint8Array;
}

export interface SampleData {
  index: number;
  /** raw SPU-ADPCM blocks (16 bytes each) */
  adpcm: Uint8Array;
  /** first sample of the loop (from the loop-start flag), or -1 */
  loopStart: number;
  /** true if the final block has the repeat flag */
  loops: boolean;
}

export interface SoundBankData {
  /** 0x0c (sfx/voice), 0x10 (music, 2 seqs) or 0x14 (music, 3 seqs) */
  kind: number;
  samples: SampleData[];
  vab: VabData;
  seqs: SeqData[];
}

interface Container { kind: number; vag: [number, number]; vab: [number, number]; seqs: [number, number][] }

export function parseContainer(d: Uint8Array): Container {
  const r = new Reader(d);
  if (d.length < 16 || d.length > MAX_FILE) throw new FormatError('bad size');
  const kind = r.u32(0);
  const nOff = kind === 0x0c ? 2 : kind === 0x10 ? 3 : kind === 0x14 ? 4 : 0;
  if (!nOff) throw new FormatError(`type 0x${kind.toString(16)} is not a sound container`);
  const offs: number[] = [];
  for (let i = 0; i < nOff; i++) offs.push(r.u32(4 + 4 * i));
  const vagStart = 4 * (1 + nOff);
  offs.push(d.length);
  for (let i = 0; i + 1 < offs.length; i++) if (!(vagStart <= offs[i] && offs[i] <= offs[i + 1] && offs[i + 1] <= d.length)) throw new FormatError('offsets not monotonic / in range');
  if (kind === 0x0c) return { kind, vag: [vagStart, offs[0]], vab: [offs[0], Math.min(offs[1], d.length)], seqs: [] };
  const seqs: [number, number][] = [];
  for (let i = 1; i < offs.length - 1; i++) seqs.push([offs[i], offs[i + 1]]);
  return { kind, vag: [vagStart, offs[0]], vab: [offs[0], offs[1]], seqs };
}

export function parseVab(d: Uint8Array, vo: number, ve: number): { vab: VabData; sizes: number[] } {
  const r = new Reader(d);
  if (vo + 32 > d.length || r.ascii(vo, 4) !== 'pBAV') throw new FormatError('no VAB magic');
  const version = r.u32(vo + 4), id = r.u32(vo + 8);
  const ps = r.u16(vo + 18), ts = r.u16(vo + 20), vs = r.u16(vo + 22);
  if (ps > 128 || ts > ps * 16 || vs > 254) throw new FormatError('implausible VAB counts');
  const progO = vo + 32;
  const toneO = progO + 128 * 16;
  const szO = toneO + ps * 16 * 32;
  if (szO + 2 * (vs + 1) > ve || ve > d.length) throw new FormatError('VAB truncated');
  const sizes: number[] = [];
  for (let i = 0; i <= vs; i++) sizes.push(r.u16(szO + 2 * i) * 8);
  const programs: VabProgram[] = [];
  for (let p = 0; p < ps; p++) {
    const b = progO + 16 * p;
    programs.push({ index: p, tones: r.u8(b), vol: r.u8(b + 1), pan: r.u8(b + 4) });
  }
  const tones: VabTone[] = [];
  for (let p = 0; p < ps; p++) {
    for (let t = 0; t < 16; t++) {
      const b = toneO + (p * 16 + t) * 32;
      const vag = r.i16(b + 22);
      if (vag <= 0 || vag > vs) continue;
      tones.push({
        program: p, tone: t, vag: vag - 1, vol: r.u8(b + 2), pan: r.u8(b + 3), center: r.u8(b + 4), fine: r.u8(b + 5), min: r.u8(b + 6), max: r.u8(b + 7),
        adsr1: r.u16(b + 16), adsr2: r.u16(b + 18), mode: r.u8(b + 1),
      });
    }
  }
  return { vab: { version, id, nPrograms: ps, nTones: ts, nVags: vs, programs, tones }, sizes: sizes.slice(1) };
}

/** Cut the ADPCM region (silence block first) into per-sample slices. */
export function vagSlices(start: number, end: number, sizes: number[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = start + 16;
  for (const s of sizes) {
    let e = pos + s;
    if (s % 16 || e > end + 16) e = Math.min(e, end); // table rounding: clamp to region end
    out.push([pos, Math.max(pos, e)]);
    pos = e;
  }
  return out;
}

/** SPU ADPCM -> int16 PCM. Stops after a block with the 'end' flag. */
export function decodeAdpcm(buf: Uint8Array): Int16Array {
  const out = new Int16Array(Math.floor(buf.length / 16) * 28);
  let n = 0, s1 = 0, s2 = 0;
  for (let b = 0; b + 16 <= buf.length; b += 16) {
    const head = buf[b], flags = buf[b + 1];
    let shift = head & 0xf;
    const filt = Math.min(head >> 4, 4);
    if (shift > 12) shift = 9;
    const [f0, f1] = FILTERS[filt];
    for (let i = 0; i < 28; i++) {
      const byte = buf[b + 2 + (i >> 1)];
      const nib = i & 1 ? byte >> 4 : byte & 0xf;
      let v = (nib << 12) & 0xffff;
      if (v & 0x8000) v -= 0x10000;
      v >>= shift;
      v += (s1 * f0 + s2 * f1 + 32) >> 6;
      v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      out[n++] = v;
      s2 = s1; s1 = v;
    }
    if (flags & 1) break;
  }
  return out.subarray(0, n);
}

function adpcmLoopInfo(buf: Uint8Array): { loopStart: number; loops: boolean } {
  let loopStart = -1, loops = false;
  for (let b = 0; b + 16 <= buf.length; b += 16) {
    const flags = buf[b + 1];
    if (flags & 4 && loopStart < 0) loopStart = (b / 16) * 28;
    if (flags & 1) { loops = !!(flags & 2); break; }
  }
  return { loopStart, loops };
}

/** Parse a Sony 'pQES' sequence. Events are decoded until the end-of-track meta or the data ends. */
export function parseSeq(raw: Uint8Array): SeqData {
  const r = new Reader(raw);
  if (raw.length < 15 || r.ascii(0, 4) !== 'pQES') throw new FormatError('bad SEQ');
  const version = (r.u8(4) << 24) | (r.u8(5) << 16) | (r.u8(6) << 8) | r.u8(7);
  const resolution = (r.u8(8) << 8) | r.u8(9);
  const tempo = (r.u8(10) << 16) | (r.u8(11) << 8) | r.u8(12);
  const events: SeqEvent[] = [];
  let o = 15, tick = 0, status = 0;
  const MAX_EVENTS = 1 << 20;
  while (o < raw.length && events.length < MAX_EVENTS) {
    let delta = 0;
    for (let i = 0; i < 4; i++) {
      if (o >= raw.length) return { version, resolution, tempo, timeSig: [r.u8(13), 1 << r.u8(14)], events, raw };
      const b = raw[o++];
      delta = (delta << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    tick += delta;
    if (o >= raw.length) break;
    if (raw[o] & 0x80) status = raw[o++];
    if (status === 0xff) {
      if (o + 2 > raw.length) break;
      const mtype = raw[o], len = raw[o + 1];
      o += 2;
      if (o + len > raw.length) break;
      let v = 0;
      for (let i = 0; i < len && i < 4; i++) v = (v << 8) | raw[o + i];
      events.push({ tick, type: 0xff, channel: 0, a: mtype, b: v });
      o += len;
      if (mtype === 0x2f) break;
      continue;
    }
    const type = status & 0xf0;
    const need = type === 0xc0 || type === 0xd0 ? 1 : 2;
    if (!(status & 0x80) || o + need > raw.length) break;
    events.push({ tick, type, channel: status & 0xf, a: raw[o], b: need === 2 ? raw[o + 1] : 0 });
    o += need;
  }
  return { version, resolution, tempo, timeSig: [r.u8(13), 1 << r.u8(14)], events, raw };
}

export function parseSoundBank(d: Uint8Array): SoundBankData {
  const c = parseContainer(d);
  const { vab, sizes } = parseVab(d, c.vab[0], c.vab[1] || d.length);
  const samples: SampleData[] = vagSlices(c.vag[0], c.vag[1], sizes).map(([a, b], index) => {
    const adpcm = d.slice(a, Math.min(b, d.length));
    return { index, adpcm, ...adpcmLoopInfo(adpcm) };
  });
  const seqs: SeqData[] = [];
  for (const [a, b] of c.seqs) {
    if (a + 4 <= d.length && new Reader(d).ascii(a, 4) === 'pQES') seqs.push(parseSeq(d.slice(a, Math.min(b, d.length))));
  }
  return { kind: c.kind, samples, vab, seqs };
}
