import { GAMES } from '../../shared/registry';
import { Party, type PartyOptions, type Timing } from '../../shared/party';
import type { HostCore } from './transport';

/** Runs a Party on the current thread, driven by a timer (or manually via step() in tests). */
export class InlineHostCore implements HostCore {
  readonly party: Party;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(code: string, opts: PartyOptions & { auto?: boolean } = {}) {
    this.party = new Party(code, opts);
    if (opts.auto !== false) this.timer = setInterval(() => this.party.update(performance.now()), 8);
  }
  step(now: number) {
    this.party.update(now);
  }
  open(connId: number, send: (data: string, unreliable?: boolean) => void) {
    this.party.connect({ id: connId, send });
  }
  message(connId: number, data: string) {
    this.party.message(connId, data);
  }
  close(connId: number) {
    this.party.disconnect(connId);
  }
  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Same API, but the Party lives in a Web Worker so the simulation is not throttled
 * when the host's tab is in the background. Falls back to InlineHostCore if Workers fail.
 */
export type WorkerIn = { k: 'init'; code: string; rounds?: number; timing?: Timing; games?: string[]; dev?: PartyOptions['dev'] } | { k: 'open'; id: number } | { k: 'msg'; id: number; d: string } | { k: 'close'; id: number } | { k: 'stop' };
export type WorkerOut = { k: 'out'; id: number; d: string; u: boolean };

/** Resolve a game id filter to the registry entries (null/empty -> all). */
export function pickGames(ids?: string[]) {
  const want = ids?.map((x) => x.split(':')[0]);
  const g = want?.length ? GAMES.filter((x) => want.includes(x.id)) : [];
  return g.length ? g : undefined;
}
/** `id:variant` entries of the filter -> forced variants */
export function pickVariants(ids?: string[]) {
  const out: Record<string, string> = {};
  for (const x of ids ?? []) { const [g, v] = x.split(':'); if (v) out[g] = v; }
  return out;
}

export class WorkerHostCore implements HostCore {
  private sends = new Map<number, (d: string, u?: boolean) => void>();
  constructor(private worker: Worker, code: string, rounds?: number, timing?: Timing, games?: string[], dev?: PartyOptions['dev']) {
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.k === 'out') this.sends.get(m.id)?.(m.d, m.u);
    };
    worker.postMessage({ k: 'init', code, rounds, timing, games, dev } satisfies WorkerIn);
  }
  open(id: number, send: (d: string, u?: boolean) => void) {
    this.sends.set(id, send);
    this.worker.postMessage({ k: 'open', id } satisfies WorkerIn);
  }
  message(id: number, d: string) {
    this.worker.postMessage({ k: 'msg', id, d } satisfies WorkerIn);
  }
  close(id: number) {
    this.sends.delete(id);
    this.worker.postMessage({ k: 'close', id } satisfies WorkerIn);
  }
  destroy() {
    this.worker.postMessage({ k: 'stop' } satisfies WorkerIn);
    this.worker.terminate();
  }
}

/** `games`: optional mini-game id filter for the rotation (dev: ?game=ringDing,tankArena) */
export function createHostCore(code: string, rounds?: number, timing?: Timing, games?: string[], dev?: PartyOptions['dev']): HostCore {
  if (typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('../host/hostWorker.ts', import.meta.url), { type: 'module' });
      return new WorkerHostCore(w, code, rounds, timing, games, dev);
    } catch (e) {
      console.warn('Worker unavailable, simulating on the main thread', e);
    }
  }
  return new InlineHostCore(code, { rounds, timing, games: pickGames(games), variants: pickVariants(games), dev });
}
