// Web Worker entry: runs the authoritative Party for a host tab (PeerJS mode).
import { Party } from '../../shared/party';
import { pickGames, pickVariants, type WorkerIn, type WorkerOut } from '../net/hostCore';

const ctx = self as unknown as { postMessage(m: WorkerOut): void; onmessage: ((e: MessageEvent<WorkerIn>) => void) | null };
let party: Party | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

ctx.onmessage = (e) => {
  const m = e.data;
  switch (m.k) {
    case 'init':
      party = new Party(m.code, { rounds: m.rounds, timing: m.timing, games: pickGames(m.games), variants: pickVariants(m.games) });
      timer = setInterval(() => party!.update(performance.now()), 8);
      break;
    case 'open':
      party?.connect({ id: m.id, send: (d, u) => ctx.postMessage({ k: 'out', id: m.id, d, u: !!u }) });
      break;
    case 'msg':
      party?.message(m.id, m.d);
      break;
    case 'close':
      party?.disconnect(m.id);
      break;
    case 'stop':
      if (timer) clearInterval(timer);
      break;
  }
};
