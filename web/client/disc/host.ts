/** Where decoding runs: a Web Worker (default in browsers) or the calling thread (Node tests, fallback). */
import { Disc, type DiscInfo } from './disc';
import { decodeAsset, listTypes, type Payload } from './core';
import type { AssetKind } from './types';

export interface DecodeHost {
  open(file: Blob, onProgress?: (msg: string, done: number, total: number) => void): Promise<{ info: DiscInfo; fileTypes: number[] }>;
  decode(kind: AssetKind, index: number): Promise<Payload>;
  close(): void;
}

export class InlineHost implements DecodeHost {
  private disc: Disc | null = null;
  async open(file: Blob, onProgress?: (msg: string, done: number, total: number) => void) {
    this.disc = await Disc.open(file, onProgress);
    return { info: this.disc.info, fileTypes: await listTypes(this.disc) };
  }
  decode(kind: AssetKind, index: number): Promise<Payload> {
    if (!this.disc) throw new Error('disc not open');
    return decodeAsset(this.disc, kind, index);
  }
  close() { this.disc = null; }
}

// ---- worker protocol
export type WorkerRequest =
  | { id: number; op: 'open'; file: Blob }
  | { id: number; op: 'decode'; kind: AssetKind; index: number };
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string }
  | { id: number; progress: [string, number, number] };

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Re-created on the receiving side so DiscError survives the worker boundary. */
export class WorkerError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export class WorkerHost implements DecodeHost {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; progress?: (m: string, d: number, t: number) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if ('progress' in m) { p.progress?.(...m.progress); return; }
      this.pending.delete(m.id);
      if (m.ok) p.res(m.result);
      else p.rej(new WorkerError(m.error, m.code));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.rej(new Error(e.message || 'decoder worker crashed'));
      this.pending.clear();
    };
  }

  private call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, progress?: (m: string, d: number, t: number) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej, progress });
      this.worker.postMessage({ ...req, id });
    });
  }

  open(file: Blob, onProgress?: (msg: string, done: number, total: number) => void) {
    return this.call<{ info: DiscInfo; fileTypes: number[] }>({ op: 'open', file }, onProgress);
  }
  decode(kind: AssetKind, index: number) { return this.call<Payload>({ op: 'decode', kind, index }); }
  close() { this.worker.terminate(); this.pending.clear(); }
}
