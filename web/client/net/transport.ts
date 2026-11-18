import type { Conn } from '../../shared/party';
import type { C2S } from '../../shared/protocol';

/**
 * Client side of a connection to a party host.
 *  - PeerTransport  : WebRTC data channels via PeerJS (static hosting, host = a browser tab)
 *  - WsTransport    : WebSocket to the Node server (LAN)
 *  - LoopbackTransport : in-process, used by the host's own tab and by tests
 * Messages are JSON strings; `fast` marks traffic that may be dropped/reordered (inputs).
 */
export interface ClientTransport {
  readonly kind: 'peer' | 'ws' | 'local';
  /** Open the connection. Rejects with a TransportError. */
  connect(): Promise<void>;
  send(msg: C2S, fast?: boolean): void;
  onMessage: (raw: string) => void;
  /** Called once if an established connection drops. */
  onClose: () => void;
  close(): void;
}

export type TransportErrorCode = 'no-host' | 'unreachable' | 'failed';
export class TransportError extends Error {
  constructor(public code: TransportErrorCode, message: string) {
    super(message);
  }
}

/** The host side of the same wire: a bridge between connections and a Party. */
export interface HostCore {
  open(connId: number, send: Conn['send']): void;
  message(connId: number, data: string): void;
  close(connId: number): void;
  destroy(): void;
}
