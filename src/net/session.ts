/**
 * createNetSession(ctx): connection + lifecycle for co-op.
 *   session.host(name)        → creates a room on the relay, resolves with the join code
 *   session.join(code, name)  → joins a room (this peer becomes a client)
 *   session.update(dt)        → call every frame (also while paused)
 *   session.leave()           → back to single-player
 */
import type { GameContext } from '@/core/types';
import {
  PROTOCOL_VERSION, RELAY_DEFAULT_PORT, cleanName, isValidCode, normalizeCode,
  type PeerInfo, type RelayDown, type RelayUp,
} from './relayProtocol';
import { decode, encode, type ClientMsg, type HostMsg } from './protocol';
import { HostRuntime } from './host';
import { ClientRuntime } from './client';

export type NetRole = 'offline' | 'host' | 'client';
export type NetStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

/** Minimal WebSocket surface (browser WebSocket, Node 22+ global WebSocket, or `ws`). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface NetSessionOptions {
  /** Relay URL. Default: ?relay=… query param, else ws://<page host>:8787. */
  url?: string;
  socket?: SocketFactory;
  /** Build 3D avatars (default true; tests turn it off). */
  avatars?: boolean;
}

export interface NetSession {
  readonly role: NetRole;
  readonly status: NetStatus;
  readonly code: string | null;
  readonly error: string | null;
  readonly peers: readonly PeerInfo[];
  /** This connection's relay peer id. */
  readonly peerId: string | null;
  /** Round-trip time to the relay in ms (ping/pong every 2 s). */
  readonly rtt: number;
  url: string;
  host(name?: string): Promise<string>;
  join(code: string, name?: string): Promise<void>;
  leave(): void;
  update(dt: number): void;
  onChange(cb: () => void): () => void;
  /**
   * The lobby overlay, set by main.ts after mountLobby() (UI buttons call `ctx.net?.lobby?.show()`).
   * Absent in headless tests.
   */
  lobby?: { readonly visible: boolean; show(): void; hide(): void; toggle(): void };
  /** True while hosting or joined (role !== 'offline'): the host's menus then do not pause the sim. */
  readonly inSession: boolean;
  /** Internals (debugging / tests). */
  readonly hostRuntime: HostRuntime | null;
  readonly clientRuntime: ClientRuntime | null;
}

const OPEN = 1;

/** localStorage key for the remembered lobby name (was 'snowbound.net.name'; migrated in main.ts). */
export const NET_NAME_KEY = 'concourse.net.name';
export const LEGACY_NET_NAME_KEY = 'snowbound.net.name';

export function defaultRelayUrl(): string {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('relay');
    if (q) return q;
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.VITE_RELAY_URL) return env.VITE_RELAY_URL;
    const loc = globalThis.location;
    if (loc && loc.hostname) return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.hostname}:${RELAY_DEFAULT_PORT}`;
  } catch {
    /* non-browser */
  }
  return `ws://localhost:${RELAY_DEFAULT_PORT}`;
}

const REASONS: Record<string, string> = {
  no_such_room: 'No room with that code',
  room_full: 'That room is full',
  bad_code: 'Codes are 5 letters',
  version_mismatch: 'Game versions differ',
  host_left: 'The host left the game',
  connect_failed: 'Could not reach the relay',
};
export const describeNetError = (r: string | null) => (r ? REASONS[r] ?? r : '');

export function createNetSession(ctx: GameContext, opts: NetSessionOptions = {}): NetSession {
  const makeSocket: SocketFactory = opts.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  let ws: SocketLike | null = null;
  let role: NetRole = 'offline';
  let status: NetStatus = 'idle';
  let code: string | null = null;
  let error: string | null = null;
  let peerId: string | null = null;
  let hostPeer: string | null = null;
  let peers: PeerInfo[] = [];
  let rtt = 0;
  let pingT = 0;
  let hostRt: HostRuntime | null = null;
  let clientRt: ClientRuntime | null = null;
  const listeners = new Set<() => void>();
  let pending: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;

  const changed = () => {
    for (const l of Array.from(listeners)) {
      try { l(); } catch (err) { console.error('[net] listener threw', err); }
    }
    ctx.events.emit('net:changed', { role, status, code, peers: peers.length, error });
  };

  const raw = (msg: RelayUp) => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  };

  function teardown(reason: string | null, finalStatus: NetStatus): void {
    hostRt?.dispose();
    clientRt?.dispose();
    const wasClient = !!clientRt;
    hostRt = null;
    clientRt = null;
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try { s.close(); } catch { /* ignore */ }
    }
    role = 'offline';
    status = finalStatus;
    code = null;
    peers = [];
    peerId = null;
    hostPeer = null;
    if (reason) error = reason;
    if (pending) {
      pending.reject(new Error(reason ?? 'closed'));
      pending = null;
    }
    if (wasClient && reason) ctx.events.emit('ui:message', { text: describeNetError(reason) || 'Disconnected', duration: 4, style: 'warning' });
    changed();
  }

  function onRelay(msg: RelayDown): void {
    switch (msg.t) {
      case 'welcome': {
        code = msg.code;
        peerId = msg.peer;
        hostPeer = msg.hostPeer;
        peers = msg.peers.slice();
        status = 'connected';
        error = null;
        if (msg.host) {
          role = 'host';
          hostRt = new HostRuntime(ctx, (to, m: HostMsg) => {
            if (ws && ws.readyState === OPEN) ws.send(`{"t":"g","to":${JSON.stringify(to)},"d":${encode(m)}}`);
          }, { avatars: opts.avatars });
        } else {
          role = 'client';
          clientRt = new ClientRuntime(ctx, (m: ClientMsg) => {
            if (ws && ws.readyState === OPEN) ws.send(`{"t":"g","d":${encode(m)}}`);
          }, { avatars: opts.avatars });
          clientRt.start();
        }
        pending?.resolve(msg.code);
        pending = null;
        changed();
        break;
      }
      case 'peer-join':
        peers = peers.filter((p) => p.peer !== msg.peer.peer).concat(msg.peer);
        hostRt?.addPeer(msg.peer);
        changed();
        break;
      case 'peer-leave':
        peers = peers.filter((p) => p.peer !== msg.peer);
        hostRt?.removePeer(msg.peer);
        changed();
        break;
      case 'closed':
        teardown(msg.reason, 'closed');
        break;
      case 'error':
        if (pending) teardown(msg.reason, 'error');
        else {
          error = msg.reason;
          changed();
        }
        break;
      case 'pong':
        rtt = Math.max(0, performance.now() - msg.c);
        break;
      case 'g': {
        const m = decode(msg.d);
        if (!m) return;
        if (hostRt) hostRt.onMessage(msg.from, m);
        else if (clientRt && msg.from === hostPeer) clientRt.onMessage(m);
        break;
      }
    }
  }

  function connect(first: RelayUp): Promise<string> {
    if (ws) teardown(null, 'idle');
    error = null;
    status = 'connecting';
    changed();
    return new Promise<string>((resolve, reject) => {
      pending = { resolve, reject };
      let s: SocketLike;
      try {
        s = makeSocket(session.url);
      } catch {
        teardown('connect_failed', 'error');
        return;
      }
      ws = s;
      s.onopen = () => raw(first);
      s.onmessage = (ev) => {
        let msg: RelayDown;
        try {
          msg = JSON.parse(String(ev.data)) as RelayDown;
        } catch {
          return;
        }
        if (msg && typeof msg === 'object') onRelay(msg);
      };
      s.onerror = () => {
        if (status === 'connecting') teardown('connect_failed', 'error');
      };
      s.onclose = () => {
        if (ws === s) teardown(status === 'connecting' ? 'connect_failed' : 'disconnected', 'closed');
      };
    });
  }

  const playerName = (name?: string) => cleanName(name ?? ctx.player?.name);

  const session: NetSession = {
    get role() { return role; },
    get status() { return status; },
    get code() { return code; },
    get error() { return error; },
    get peers() { return peers; },
    get peerId() { return peerId; },
    get rtt() { return rtt; },
    get inSession() { return role !== 'offline'; },
    url: opts.url ?? defaultRelayUrl(),
    get hostRuntime() { return hostRt; },
    get clientRuntime() { return clientRt; },

    host(name?: string) {
      return connect({ t: 'host', name: playerName(name), pid: ctx.player.id, v: PROTOCOL_VERSION });
    },

    async join(joinCode: string, name?: string) {
      const c = normalizeCode(joinCode);
      if (!isValidCode(c)) {
        error = 'bad_code';
        changed();
        throw new Error('bad_code');
      }
      await connect({ t: 'join', code: c, name: playerName(name), pid: ctx.player.id, v: PROTOCOL_VERSION });
    },

    leave() {
      if (!ws) return;
      raw({ t: 'leave' });
      teardown(null, 'idle');
    },

    update(dt: number) {
      if (!ws) return;
      pingT -= dt;
      if (pingT <= 0 && status === 'connected') {
        pingT = 2;
        raw({ t: 'ping', c: performance.now() });
      }
      hostRt?.update(dt);
      clientRt?.update(dt);
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return session;
}
