/**
 * Orbital Concourse co-op relay. Zero game logic: rooms keyed by a 5-letter join code, the first
 * peer is the host, game frames are forwarded host → clients (one or all) and
 * client → host. If the host leaves, the room closes (no host migration).
 *
 *   npm run relay                 # port 8787
 *   npm run relay -- --port 9000  # or RELAY_PORT=9000
 *
 * Wire format: JSON text frames, see src/net/relayProtocol.ts.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { pathToFileURL } from 'node:url';
import {
  CODE_ALPHABET, CODE_LENGTH, MAX_PEERS, PROTOCOL_VERSION, RELAY_DEFAULT_PORT,
  cleanName, isValidCode, normalizeCode, type PeerInfo, type RelayDown, type RelayUp,
} from '../src/net/relayProtocol';

interface Conn {
  ws: WebSocket;
  peer: string;
  room: Room | null;
  info: PeerInfo | null;
  alive: boolean;
}

interface Room {
  code: string;
  host: Conn;
  clients: Map<string, Conn>;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Max frame size in bytes (default 1 MiB). */
  maxPayload?: number;
  log?: (msg: string) => void;
}

export interface RelayHandle {
  readonly port: number;
  rooms(): { code: string; peers: number }[];
  close(): Promise<void>;
}

export function startRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const log = opts.log ?? ((m: string) => console.log(`[relay] ${m}`));
  const rooms = new Map<string, Room>();
  const conns = new Set<Conn>();
  let peerCounter = 0;

  const wss = new WebSocketServer({ port: opts.port ?? RELAY_DEFAULT_PORT, host: opts.host, maxPayload: opts.maxPayload ?? 1 << 20 });

  const send = (c: Conn, msg: RelayDown) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const sendRaw = (c: Conn, raw: string) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  };

  function newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let s = '';
      for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(s)) return s;
    }
    throw new Error('no free room codes');
  }

  function peersOf(room: Room): PeerInfo[] {
    const out: PeerInfo[] = [];
    if (room.host.info) out.push(room.host.info);
    for (const c of room.clients.values()) if (c.info) out.push(c.info);
    return out;
  }

  function leaveRoom(c: Conn, reason: string): void {
    const room = c.room;
    if (!room) return;
    c.room = null;
    c.info = null;
    if (room.host === c) {
      rooms.delete(room.code);
      for (const cl of room.clients.values()) {
        cl.room = null;
        cl.info = null;
        send(cl, { t: 'closed', reason: 'host_left' });
      }
      room.clients.clear();
      log(`room ${room.code} closed (${reason})`);
    } else {
      room.clients.delete(c.peer);
      send(room.host, { t: 'peer-leave', peer: c.peer });
      for (const cl of room.clients.values()) send(cl, { t: 'peer-leave', peer: c.peer });
      log(`${c.peer} left ${room.code} (${reason})`);
    }
  }

  function handle(c: Conn, msg: RelayUp): void {
    switch (msg.t) {
      case 'ping':
        send(c, { t: 'pong', c: msg.c });
        return;
      case 'host': {
        if (msg.v !== PROTOCOL_VERSION) return send(c, { t: 'error', reason: 'version_mismatch' });
        if (c.room) leaveRoom(c, 'rehost');
        const code = newCode();
        c.info = { peer: c.peer, name: cleanName(msg.name), pid: String(msg.pid || 'p1').slice(0, 40), host: true };
        const room: Room = { code, host: c, clients: new Map() };
        rooms.set(code, room);
        c.room = room;
        send(c, { t: 'welcome', code, peer: c.peer, host: true, hostPeer: c.peer, peers: peersOf(room) });
        log(`${c.peer} hosts ${code}`);
        return;
      }
      case 'join': {
        if (msg.v !== PROTOCOL_VERSION) return send(c, { t: 'error', reason: 'version_mismatch' });
        const code = normalizeCode(String(msg.code ?? ''));
        if (!isValidCode(code)) return send(c, { t: 'error', reason: 'bad_code' });
        const room = rooms.get(code);
        if (!room) return send(c, { t: 'error', reason: 'no_such_room' });
        if (room.host === c || room.clients.has(c.peer)) return send(c, { t: 'error', reason: 'already_in_room' });
        if (room.clients.size + 1 >= MAX_PEERS) return send(c, { t: 'error', reason: 'room_full' });
        if (c.room) leaveRoom(c, 'rejoin');
        c.info = { peer: c.peer, name: cleanName(msg.name), pid: String(msg.pid || 'p1').slice(0, 40), host: false };
        c.room = room;
        const others = peersOf(room);
        room.clients.set(c.peer, c);
        send(c, { t: 'welcome', code, peer: c.peer, host: false, hostPeer: room.host.peer, peers: peersOf(room) });
        for (const o of others) {
          const oc = o.peer === room.host.peer ? room.host : room.clients.get(o.peer);
          if (oc) send(oc, { t: 'peer-join', peer: c.info });
        }
        log(`${c.peer} joined ${code} (${room.clients.size + 1}/${MAX_PEERS})`);
        return;
      }
      case 'leave':
        leaveRoom(c, 'leave');
        return;
      case 'g': {
        const room = c.room;
        if (!room) return;
        // Wrap without re-encoding the payload twice: d is re-serialised once per frame.
        const d = JSON.stringify(msg.d ?? null);
        const framed = `{"t":"g","from":${JSON.stringify(c.peer)},"d":${d}}`;
        if (room.host === c) {
          if (msg.to) {
            const target = room.clients.get(msg.to);
            if (target) sendRaw(target, framed);
          } else {
            for (const cl of room.clients.values()) sendRaw(cl, framed);
          }
        } else {
          sendRaw(room.host, framed);
        }
        return;
      }
      default:
        send(c, { t: 'error', reason: 'unknown_type' });
    }
  }

  wss.on('connection', (ws) => {
    const c: Conn = { ws, peer: `n${(++peerCounter).toString(36)}`, room: null, info: null, alive: true };
    conns.add(c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return send(c, { t: 'error', reason: 'binary_unsupported' });
      const raw = data.toString();
      let msg: RelayUp;
      try {
        msg = JSON.parse(raw) as RelayUp;
      } catch {
        return send(c, { t: 'error', reason: 'bad_json' });
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
        return send(c, { t: 'error', reason: 'bad_frame' });
      }
      handle(c, msg);
    });
    ws.on('close', () => {
      leaveRoom(c, 'disconnect');
      conns.delete(c);
    });
    ws.on('error', () => leaveRoom(c, 'error'));
  });

  // Drop dead sockets.
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 15000);

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? RELAY_DEFAULT_PORT);
      log(`listening on ws://${opts.host ?? 'localhost'}:${port}`);
      resolve({
        port,
        rooms: () => Array.from(rooms.values()).map((r) => ({ code: r.code, peers: r.clients.size + 1 })),
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

// ---- CLI ---------------------------------------------------------------------
function cliPort(): number {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  if (process.env.RELAY_PORT) return Number(process.env.RELAY_PORT);
  return RELAY_DEFAULT_PORT;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startRelay({ port: cliPort(), host: process.env.RELAY_HOST }).catch((err) => {
    console.error('[relay] failed to start:', err);
    process.exit(1);
  });
}
