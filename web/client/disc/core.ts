/** Decoding entry points shared by the worker and the in-thread fallback (no DOM / three.js here). */
import type { Disc } from './disc';
import { parseT08, type TextureSetData } from './t08';
import { decodeT29, type ModelData } from './t29';
import { parseSoundBank, type SoundBankData } from './sound';
import type { AssetKind } from './types';

/** Bump when decoder output changes; part of the cache key. */
export const DECODER_VERSION = 2;

export type Payload = TextureSetData | ModelData | SoundBankData;

export const KIND_OF_TYPE: Record<number, AssetKind> = { 0x08: 'textures', 0x29: 'model', 0x0c: 'sound', 0x10: 'sound', 0x14: 'sound' };

export async function decodeAsset(disc: Disc, kind: AssetKind, index: number): Promise<Payload> {
  const bytes = await disc.readFile(index);
  if (kind === 'textures') return parseT08(bytes);
  if (kind === 'sound') return parseSoundBank(bytes);
  // model: UVs are normalised by the paired texture set (file index - 1)
  let sizes: ([number, number] | null)[] = [];
  if (index > 0 && (await disc.fileType(index - 1)) === 8) {
    try {
      sizes = parseT08(await disc.readFile(index - 1)).textures.map((t) => (t.width && t.height ? [t.width, t.height] : null));
    } catch { /* unreadable texture set: fall back to 256x256 */ }
  }
  const m = decodeT29(bytes, sizes);
  if (!m) throw new Error(`model ${index} has no meshes`);
  return m;
}

export async function listTypes(disc: Disc): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < disc.files.length; i++) out.push(await disc.fileType(i));
  return out;
}

/** All ArrayBuffers inside a payload, for zero-copy transfer. */
export function collectBuffers(v: unknown, out = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); }
  else if (Array.isArray(v)) for (const x of v) collectBuffers(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectBuffers(x, out);
  return [...out];
}
