// WebRTC transport via PeerJS (pinned in package.json). The free public PeerJS cloud broker is used
// for signalling only; game traffic flows peer-to-peer over data channels:
//   - a reliable+ordered channel for lobby events, and
//   - an unordered channel for inputs and snapshots (PeerJS cannot request maxRetransmits, so it is
//     "unordered" rather than lossy, which is what avoids head-of-line blocking).
import Peer, { type DataConnection } from 'peerjs';
import type { C2S } from '../../shared/protocol';
import { TransportError, type ClientTransport, type HostCore } from './transport';

export const PEER_PREFIX = 'pbash1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const newRoomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const rid = () => Math.random().toString(36).slice(2, 10);

const peerOpts = { debug: 0 } as const;

function waitOpen(c: DataConnection, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (c.open) return resolve();
    const t = setTimeout(() => reject(new TransportError('failed', 'Connection timed out')), ms);
    c.on('open', () => { clearTimeout(t); resolve(); });
    c.on('error', (e) => { clearTimeout(t); reject(new TransportError('failed', String(e))); });
    c.on('close', () => { clearTimeout(t); reject(new TransportError('failed', 'Connection closed')); });
  });
}

/** Joiner side: connects to the host tab's peer id derived from the room code. */
export class PeerTransport implements ClientTransport {
  readonly kind = 'peer' as const;
  onMessage: (raw: string) => void = () => {};
  onClose: () => void = () => {};
  private peer: Peer | null = null;
  private rel: DataConnection | null = null;
  private fast: DataConnection | null = null;
  private closedByUs = false;

  constructor(private code: string) {}

  async connect(): Promise<void> {
    const peer = new Peer(peerOpts);
    this.peer = peer;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new TransportError('unreachable', 'Could not reach the matchmaking server')), 10000);
      peer.on('open', () => { clearTimeout(t); resolve(); });
      peer.on('error', (e: { type?: string }) => {
        clearTimeout(t);
        reject(new TransportError('unreachable', 'Could not reach the matchmaking server' + (e.type ? ` (${e.type})` : '')));
      });
    });
    const link = rid();
    const target = PEER_PREFIX + this.code.toUpperCase();
    // peer-unavailable is reported on the Peer, not the connection
    const unavailable = new Promise<never>((_, reject) => {
      peer.on('error', (e: { type?: string }) => { if (e.type === 'peer-unavailable') reject(new TransportError('no-host', `Room ${this.code} not found`)); });
    });
    const rel = peer.connect(target, { reliable: true, serialization: 'raw', metadata: { link, ch: 'r' } });
    this.rel = rel;
    await Promise.race([waitOpen(rel, 12000), unavailable]);
    rel.on('data', (d) => this.onMessage(d as string));
    rel.on('close', () => { if (!this.closedByUs) this.onClose(); });
    rel.on('error', () => {});
    // optional unordered channel for inputs/snapshots; fine to run without it
    const fast = peer.connect(target, { reliable: false, serialization: 'raw', metadata: { link, ch: 'f' } });
    try {
      await waitOpen(fast, 5000);
      this.fast = fast;
      fast.on('data', (d) => this.onMessage(d as string));
      fast.on('close', () => { if (this.fast === fast) this.fast = null; });
    } catch {
      this.fast = null;
    }
  }

  send(msg: C2S, fast = false) {
    const s = JSON.stringify(msg);
    const c = fast && this.fast?.open ? this.fast : this.rel;
    if (c?.open) c.send(s);
  }

  close() {
    this.closedByUs = true;
    this.peer?.destroy();
    this.peer = null;
  }
}

/** Host side: owns the broker registration and bridges incoming data channels into a HostCore. */
export class PeerHost {
  private peer: Peer | null = null;
  private links = new Map<string, { id: number; rel: DataConnection; fast: DataConnection | null }>();
  private nextId = 1;
  onPeerCount: (n: number) => void = () => {};
  onFatal: (msg: string) => void = () => {};

  constructor(public code: string, private core: HostCore) {}

  /** Register `pbash1-CODE` with the broker; picks a new code if it is taken. Resolves with the final code. */
  async start(): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.register();
        return this.code;
      } catch (e) {
        if (e instanceof TransportError && e.code === 'failed') this.code = newRoomCode(); // id taken
        else throw e;
      }
    }
    throw new TransportError('failed', 'Could not allocate a room code');
  }

  private register(): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_PREFIX + this.code, peerOpts);
      const t = setTimeout(() => { peer.destroy(); reject(new TransportError('unreachable', 'Could not reach the matchmaking server')); }, 10000);
      peer.on('open', () => {
        clearTimeout(t);
        this.peer = peer;
        peer.on('connection', (c) => this.onConnection(c));
        peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
        peer.on('error', (e: { type?: string; message?: string }) => {
          if (e.type === 'peer-unavailable' || e.type === 'webrtc' || e.type === 'network') return; // a joiner's problem
          this.onFatal(e.message ?? String(e.type));
        });
        resolve();
      });
      peer.on('error', (e: { type?: string }) => {
        clearTimeout(t);
        peer.destroy();
        reject(e.type === 'unavailable-id' ? new TransportError('failed', 'taken') : new TransportError('unreachable', 'Could not reach the matchmaking server' + (e.type ? ` (${e.type})` : '')));
      });
    });
  }

  private onConnection(c: DataConnection) {
    const meta = (c.metadata ?? {}) as { link?: string; ch?: string };
    if (!meta.link) { c.close(); return; }
    c.on('open', () => {
      if (meta.ch === 'f') {
        const l = this.links.get(meta.link!);
        if (!l) { c.close(); return; }
        l.fast = c;
        c.on('data', (d) => this.core.message(l.id, d as string));
        c.on('close', () => { if (l.fast === c) l.fast = null; });
        return;
      }
      const id = this.nextId++;
      const link = { id, rel: c, fast: null as DataConnection | null };
      this.links.set(meta.link!, link);
      this.core.open(id, (d, unreliable) => {
        const f = link.fast;
        if (unreliable && f?.open) {
          if ((f.dataChannel?.bufferedAmount ?? 0) > 64 * 1024) return; // congested: drop this snapshot
          f.send(d);
        } else if (c.open) c.send(d);
      });
      c.on('data', (d) => this.core.message(id, d as string));
      c.on('close', () => {
        this.links.delete(meta.link!);
        link.fast?.close();
        this.core.close(id);
        this.onPeerCount(this.links.size);
      });
      c.on('error', () => {});
      this.onPeerCount(this.links.size);
    });
  }

  stop() {
    this.peer?.destroy();
    this.peer = null;
    for (const l of this.links.values()) this.core.close(l.id);
    this.links.clear();
  }
}
