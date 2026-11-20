/**
 * Bring-your-own-disc asset loading for Crash Bash (USA).
 *
 *   const assets = await loadDisc(fileFromInput);      // .bin | .iso | .zip(bin+cue); throws DiscError
 *   const model = await assets.getModel(776);          // paired textures are file 775
 *   const group = model.instantiate({ textures: await assets.getTextures(775) });
 *
 * All decoding happens client-side (Web Worker by default); decoded payloads are cached in IndexedDB.
 * No game data is shipped with the site: only the file-index metadata in levels.ts.
 */
import { DiscError } from './bytes';
import { DECODER_VERSION, KIND_OF_TYPE, type Payload } from './core';
import type { DiscInfo } from './disc';
import { InlineHost, WorkerError, WorkerHost, type DecodeHost } from './host';
import { openCache, type AssetCache } from './cache';
import { FILE_GROUPS, LEVELS } from './levels';
import { DiscModel, SoundBank, TextureSet } from './objects';
import type { SoundBankData } from './sound';
import type { TextureSetData } from './t08';
import type { ModelData } from './t29';
import type { AssetKind, DecodeStats, FileGroup, LevelInfo } from './types';

export { DiscError, FormatError } from './bytes';
export { DECODER_VERSION } from './core';
export { LEVELS, FILE_GROUPS } from './levels';
export { DiscModel, DiscTexture, SoundBank, SoundSample, TextureSet } from './objects';
export type { InstantiateOptions } from './objects';
export type { AssetKind, DecodeStats, FileGroup, LevelInfo } from './types';
export type { DiscInfo } from './disc';
export type { TextureData, TextureSetData } from './t08';
export type { AnimData, MaterialData, ModelData, PartData } from './t29';
export type { SampleData, SeqData, SeqEvent, SoundBankData, VabData, VabTone, VabProgram } from './sound';
export { decodeAdpcm } from './sound';

export interface LoadOptions {
  /** 'auto' = Web Worker when available, else the calling thread */
  host?: 'auto' | 'worker' | 'inline';
  /** use the IndexedDB cache (default true; silently off when unavailable) */
  cache?: boolean;
  onProgress?: (message: string, done: number, total: number) => void;
}

export class DiscAssets {
  readonly levels: readonly LevelInfo[] = LEVELS;
  readonly fileGroups: readonly FileGroup[] = FILE_GROUPS;
  private mem = new Map<string, Promise<unknown>>();

  constructor(
    readonly info: DiscInfo,
    private readonly fileTypes: number[],
    private readonly host: DecodeHost,
    private readonly cache: AssetCache | null,
  ) {}

  get fileCount() { return this.fileTypes.length; }
  /** Raw CRASHBSH.DAT type id (first u16) of file `index`. */
  fileType(index: number): number { return this.fileTypes[index]; }
  /** What decoder applies to a file, or null (text, code, TGA, animation tables, ...). */
  fileKind(index: number): AssetKind | null { return KIND_OF_TYPE[this.fileTypes[index]] ?? null; }
  /** True if an IndexedDB cache is in use. */
  get cached() { return this.cache !== null; }

  /** Texture set (t08) at file `index`. */
  getTextures(index: number): Promise<TextureSet> {
    return this.get('textures', index, (d) => new TextureSet(index, d as TextureSetData));
  }
  /** Model (t29) at file `index`; its textures are file `index - 1`. */
  getModel(index: number): Promise<DiscModel> {
    return this.get('model', index, (d) => new DiscModel(index, d as ModelData));
  }
  /** Sound bank (t0c/t10/t14) at file `index`. */
  getSoundBank(index: number): Promise<SoundBank> {
    return this.get('sound', index, (d) => new SoundBank(index, d as SoundBankData));
  }

  /** Free memory held for an asset (GPU textures/geometries must be disposed by the owner of the wrapper). */
  forget(kind: AssetKind, index: number) { this.mem.delete(`${kind}:${index}`); }

  private key(kind: AssetKind, index: number) { return `${this.info.id}:v${DECODER_VERSION}:${kind}:${index}`; }

  private get<T>(kind: AssetKind, index: number, wrap: (p: Payload) => T): Promise<T> {
    const mk = `${kind}:${index}`;
    let p = this.mem.get(mk) as Promise<T> | undefined;
    if (!p) {
      p = this.payload(kind, index).then(wrap);
      this.mem.set(mk, p);
      p.catch(() => this.mem.delete(mk));
    }
    return p;
  }

  private async payload(kind: AssetKind, index: number): Promise<Payload> {
    if (!Number.isInteger(index) || index < 0 || index >= this.fileTypes.length) throw new RangeError(`file index ${index} out of range`);
    if (this.fileKind(index) !== kind) throw new RangeError(`file ${index} (type 0x${this.fileTypes[index].toString(16)}) is not a ${kind}`);
    const key = this.key(kind, index);
    const hit = await this.cache?.get(key);
    if (hit) return hit as Payload;
    const out = await this.host.decode(kind, index);
    void this.cache?.put(key, out);
    return out;
  }

  /**
   * Decode every texture set, model and sound bank (filling the cache). Payloads are not kept in memory.
   * Undecodable files (text tables etc.) are counted as skipped.
   */
  async decodeAll(onProgress?: (done: number, total: number) => void): Promise<DecodeStats> {
    const t0 = performance.now();
    const st: DecodeStats = { textures: 0, models: 0, soundBanks: 0, skipped: 0, cached: 0, ms: 0 };
    const todo = this.fileTypes.map((_, i) => i).filter((i) => this.fileKind(i));
    st.skipped = this.fileTypes.length - todo.length;
    let done = 0;
    const puts: Promise<void>[] = [];
    for (const i of todo) {
      const kind = this.fileKind(i)!;
      const key = this.key(kind, i);
      try {
        if (this.cache && (await this.cache.get(key))) st.cached++;
        else {
          const out = await this.host.decode(kind, i);
          if (this.cache) puts.push(this.cache.put(key, out));
        }
        if (kind === 'textures') st.textures++; else if (kind === 'model') st.models++; else st.soundBanks++;
      } catch {
        st.skipped++; // e.g. text files that share a sound type id
      }
      onProgress?.(++done, todo.length);
    }
    await Promise.all(puts);
    st.ms = performance.now() - t0;
    return st;
  }

  /** Forget the decoded cache for all discs. */
  async clearCache() { await this.cache?.clear(); }

  close() { this.host.close(); this.cache?.close(); this.mem.clear(); }
}

/**
 * Open a disc image chosen by the player. Validates it is Crash Bash (USA) and throws a DiscError whose
 * `message` can be shown directly. The file is read lazily; nothing is uploaded anywhere.
 */
export async function loadDisc(file: File | Blob, opts: LoadOptions = {}): Promise<DiscAssets> {
  const mode = opts.host ?? 'auto';
  let host: DecodeHost;
  if (mode === 'inline' || (mode === 'auto' && typeof Worker === 'undefined')) host = new InlineHost();
  else {
    try { host = new WorkerHost(); } catch { host = new InlineHost(); }
  }
  let opened;
  try {
    opened = await host.open(file, opts.onProgress);
  } catch (e) {
    host.close();
    if (e instanceof WorkerError) throw new DiscError((e.code as DiscError['code']) ?? 'corrupt', e.message);
    throw e;
  }
  let cache: AssetCache | null = null;
  if (opts.cache !== false) {
    cache = await openCache();
    await cache?.prune(`${opened.info.id}:v${DECODER_VERSION}:`);
  }
  return new DiscAssets(opened.info, opened.fileTypes, host, cache);
}
