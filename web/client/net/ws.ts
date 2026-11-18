import type { C2S } from '../../shared/protocol';
import { TransportError, type ClientTransport } from './transport';

/** WebSocket transport to the Node LAN server (server/index.ts). */
export class WsTransport implements ClientTransport {
  readonly kind = 'ws' as const;
  onMessage: (raw: string) => void = () => {};
  onClose: () => void = () => {};
  private ws: WebSocket | null = null;

  constructor(private url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => { opened = true; resolve(); };
      ws.onerror = () => { if (!opened) reject(new TransportError('unreachable', 'Could not reach the LAN server')); };
      ws.onclose = () => { if (opened) this.onClose(); else reject(new TransportError('unreachable', 'Could not reach the LAN server')); };
      ws.onmessage = (e) => this.onMessage(e.data as string);
    });
  }
  send(m: C2S) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.close(); }
  }
}
