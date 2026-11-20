/** Type-0x08 texture sets (CLUTs + 4/8bpp indexed textures). Port of tools/t08.py; spec in docs/formats/t08.md. */
import { FormatError, Reader } from './bytes';

const MAX_TEX = 4096;
const MAX_CLUT = 4096;

export interface TextureData {
  index: number;
  width: number;
  height: number;
  bpp: 4 | 8;
  /** index into `cluts` of this texture's own palette */
  clut: number;
  clutRefRaw: number;
  clutIsLastAlias: boolean;
  flags: number;
  /** >1 = head of an animation (frames may live in `anim` blocks or the unsupported extra section) */
  frames: number;
  /** tight bbox of non-zero-index pixels, in the raw units of the file */
  cropXBytes: number;
  cropY: number;
  cropWBytes: number;
  cropH: number;
  /** block index of the animation head this block belongs to, else null */
  animHead: number | null;
  /** for heads: the member block indices */
  animBlocks?: number[];
  /** palette indices, row-major, width*height bytes */
  indices: Uint8Array;
}

export interface TextureSetData {
  numTextures: number;
  numCluts: number;
  /** PS1 BGR555 colours; length 16 or 256 each */
  cluts: Uint16Array[];
  textures: TextureData[];
  /** raw extra section (animated-texture tables, not decoded), if present */
  extra: Uint8Array | null;
  extraKind: number | null;
}

/** PS1 colour -> RGBA bytes. 0x0000 is fully transparent. */
export function bgr555ToRgba(c: number, out: Uint8Array, o: number): void {
  if (c === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 3) | (g >> 2);
  out[o + 2] = (b << 3) | (b >> 2);
  out[o + 3] = 255;
}

/** Render a texture through a palette (its own by default) to RGBA8 (width*height*4). */
export function renderRgba(t: TextureData, clut: Uint16Array): Uint8Array {
  const pal = new Uint8Array(clut.length * 4);
  for (let i = 0; i < clut.length; i++) bgr555ToRgba(clut[i], pal, i * 4);
  const out = new Uint8Array(t.indices.length * 4);
  const n = clut.length;
  for (let i = 0; i < t.indices.length; i++) {
    const v = t.indices[i];
    if (v < n) { const p = v * 4; out[i * 4] = pal[p]; out[i * 4 + 1] = pal[p + 1]; out[i * 4 + 2] = pal[p + 2]; out[i * 4 + 3] = pal[p + 3]; }
  }
  return out;
}

export function parseT08(d: Uint8Array): TextureSetData {
  const r = new Reader(d);
  if (d.length < 0x20) throw new FormatError('file too short');
  const typ = r.u32(0), size = r.u32(4), ntex = r.u16(8), nclut = r.u16(10), off = r.u32(12), extraOff = r.u32(0x18);
  if (typ !== 8) throw new FormatError(`type id ${typ} != 8`);
  if (size !== d.length) throw new FormatError(`size field ${size} != file length ${d.length}`);
  if (!(ntex > 0 && ntex <= MAX_TEX && nclut > 0 && nclut <= MAX_CLUT)) throw new FormatError('implausible counts (not a texture set)');

  let o = 0x20;
  const cluts: Uint16Array[] = [];
  for (let i = 0; i < nclut; i++) {
    if (o + 4 > d.length) throw new FormatError(`CLUT ${i} header out of bounds`);
    const n = r.u32(o);
    if ((n !== 16 && n !== 256) || o + 4 + 2 * n > d.length) throw new FormatError(`CLUT ${i} bad entry count ${n}`);
    const c = new Uint16Array(n);
    for (let k = 0; k < n; k++) c[k] = r.u16(o + 4 + 2 * k);
    cluts.push(c);
    o += 4 + 2 * n;
  }
  if (o !== off + 12) throw new FormatError('CLUT section end mismatch');

  const textures: TextureData[] = [];
  for (let i = 0; i < ntex; i++) {
    if (o + 20 > d.length) throw new FormatError(`texture ${i} header out of bounds`);
    const w16 = r.u16(o), h = r.u16(o + 2);
    const ref = r.u32(o + 12);
    const frames = r.u32(o + 16);
    const clutRef = ref & 0xffff;
    const bpp: 4 | 8 = clutRef & 1 ? 8 : 4;
    const clutIdx = clutRef === 0xfffe ? nclut - 1 : clutRef >> 1;
    const nbytes = w16 * 2 * h;
    if (o + 20 + nbytes > d.length) throw new FormatError(`texture ${i} pixel data out of bounds`);
    if (clutIdx >= nclut || cluts[clutIdx].length !== (bpp === 8 ? 256 : 16)) throw new FormatError(`texture ${i} CLUT ref 0x${ref.toString(16)} invalid for bpp ${bpp}`);
    const raw = d.subarray(o + 20, o + 20 + nbytes);
    let indices: Uint8Array;
    if (bpp === 8) indices = raw.slice();
    else {
      indices = new Uint8Array(nbytes * 2);
      for (let k = 0; k < nbytes; k++) { indices[2 * k] = raw[k] & 15; indices[2 * k + 1] = raw[k] >> 4; } // low nibble = left pixel
    }
    textures.push({
      index: i, width: w16 * 2 * (bpp === 4 ? 2 : 1), height: h, bpp, clut: clutIdx, clutRefRaw: ref, clutIsLastAlias: clutRef === 0xfffe,
      flags: ref >>> 16, frames, cropXBytes: r.u8(o + 4), cropY: r.u8(o + 5), cropWBytes: r.u8(o + 6), cropH: r.u8(o + 7), animHead: null, indices,
    });
    o += 20 + nbytes;
  }
  const texEnd = o;

  let extra: Uint8Array | null = null;
  let extraKind: number | null = null;
  if (extraOff) {
    if (extraOff !== texEnd) throw new FormatError('extra_offset != end of textures');
    extra = d.slice(extraOff);
    extraKind = extra.length >= 4 ? new Reader(extra).u32(0) : null;
  } else {
    const trailer = d.length - texEnd;
    if (trailer !== 4 && trailer !== 8 && trailer !== 12) throw new FormatError(`unexpected trailer of ${trailer} bytes`);
    for (let k = texEnd; k < d.length; k++) if (d[k]) throw new FormatError('non-zero trailer');
  }

  // animation grouping: a block with frames>1 is followed by frames-1 blocks sharing its CLUT ref
  const same = (a: number, b: number) => (textures[a].clutRefRaw & 0xffff) === (textures[b].clutRefRaw & 0xffff);
  for (let i = 0; i < textures.length;) {
    const t = textures[i];
    if (t.frames > 1) {
      const n = t.frames;
      const members: number[] = [];
      for (let j = i; j < Math.min(i + n, textures.length); j++) members.push(j);
      if (members.every((j) => same(j, i) && (j === i || textures[j].frames === 1)) && i + n <= textures.length && i + 1 < textures.length && same(i + 1, i)) {
        for (const j of members) textures[j].animHead = i;
        t.animBlocks = members;
        i += n;
        continue;
      }
    }
    i++;
  }
  return { numTextures: ntex, numCluts: nclut, cluts, textures, extra, extraKind };
}
