import { Disc } from './disc';
import { DiscError } from './bytes';
import { collectBuffers, decodeAsset, listTypes } from './core';
import type { WorkerRequest, WorkerResponse } from './host';

let disc: Disc | null = null;
// no webworker lib types (they clash with DOM): minimal structural view of the worker scope
const scope = self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };
const post = (m: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.op === 'open') {
      disc = await Disc.open(req.file, (msg, done, total) => post({ id: req.id, progress: [msg, done, total] }));
      post({ id: req.id, ok: true, result: { info: disc.info, fileTypes: await listTypes(disc) } });
    } else {
      if (!disc) throw new Error('disc not open');
      const payload = await decodeAsset(disc, req.kind, req.index);
      post({ id: req.id, ok: true, result: payload }, collectBuffers(payload));
    }
  } catch (err) {
    post({ id: req.id, ok: false, error: (err as Error).message, code: err instanceof DiscError ? err.code : undefined });
  }
};
