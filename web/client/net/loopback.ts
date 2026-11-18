import type { C2S } from '../../shared/protocol';
import type { ClientTransport, HostCore } from './transport';

let nextLoopId = 1_000_000;

/** In-process transport onto a HostCore. Used by the host's own tab and by tests (optionally lossy). */
export class LoopbackTransport implements ClientTransport {
  readonly kind = 'local' as const;
  onMessage: (raw: string) => void = () => {};
  onClose: () => void = () => {};
  readonly id = nextLoopId++;
  private open = false;

  constructor(private core: HostCore, private opts: { dropFast?: number } = {}) {}

  async connect() {
    this.core.open(this.id, (d, unreliable) => {
      if (unreliable && this.opts.dropFast && Math.random() < this.opts.dropFast) return;
      queueMicrotask(() => { if (this.open) this.onMessage(d); });
    });
    this.open = true;
  }
  send(msg: C2S) {
    const s = JSON.stringify(msg);
    queueMicrotask(() => { if (this.open) this.core.message(this.id, s); });
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.core.close(this.id);
  }
  /** Simulate a network drop: host sees a disconnect, client sees onClose. */
  drop() {
    if (!this.open) return;
    this.close();
    this.onClose();
  }
}
