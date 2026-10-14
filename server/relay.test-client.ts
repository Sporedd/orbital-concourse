/**
 * Headless relay test: starts the relay in-process on a free port and drives it with `ws`
 * clients (host + clients): host/join/welcome, peer join/leave announcements, host → all,
 * host → one, client → host routing with sender ids, game snapshot + fire messages encoded
 * with the real protocol, error cases, room capacity, host leaving closes the room.
 *
 *   npx tsx server/relay.test-client.ts
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startRelay } from './relay';
import { MAX_PEERS, PROTOCOL_VERSION, type RelayDown, type RelayUp } from '../src/net/relayProtocol';
import { decode, encode, enc, weaponStatsW, type ClientTickMsg, type SnapMsg } from '../src/net/protocol';

class TestClient {
  readonly ws: WebSocket;
  private readonly inbox: RelayDown[] = [];
  private waiters: { pred: (m: RelayDown) => boolean; resolve: (m: RelayDown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(url: string, readonly label: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayDown;
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  send(msg: RelayUp | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  next<T extends RelayDown['t']>(t: T, pred: (m: Extract<RelayDown, { t: T }>) => boolean = () => true, ms = 2000): Promise<Extract<RelayDown, { t: T }>> {
    const p = (m: RelayDown) => m.t === t && pred(m as Extract<RelayDown, { t: T }>);
    const i = this.inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<RelayDown, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: timed out waiting for '${t}'`)), ms);
      this.waiters.push({ pred: p, resolve: resolve as (m: RelayDown) => void, reject, timer });
    });
  }

  /** Assert nothing matching arrives within `ms`. */
  async none(t: RelayDown['t'], ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    assert.ok(!this.inbox.some((m) => m.t === t), `${this.label}: unexpected '${t}'`);
  }

  close(): void {
    this.ws.close();
  }
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0, log: () => {} });
  const url = `ws://localhost:${relay.port}`;
  console.log(`relay on ${url}`);
  const all: TestClient[] = [];
  const mk = async (label: string) => {
    const c = new TestClient(url, label);
    all.push(c);
    await c.open();
    return c;
  };

  try {
    const host = await mk('host');
    const a = await mk('a');
    const b = await mk('b');
    let code = '';
    let hostPeer = '';
    let aPeer = '';
    let bPeer = '';

    await test('host creates a room with a 5-letter code', async () => {
      host.send({ t: 'host', name: 'Hosty', pid: 'p1', v: PROTOCOL_VERSION });
      const w = await host.next('welcome');
      assert.match(w.code, /^[A-HJ-NP-Z]{5}$/);
      assert.equal(w.host, true);
      assert.equal(w.peers.length, 1);
      code = w.code;
      hostPeer = w.peer;
    });

    await test('clients join; everyone hears peer-join', async () => {
      a.send({ t: 'join', code: code.toLowerCase(), name: 'Alice', pid: 'p1', v: PROTOCOL_VERSION });
      const wa = await a.next('welcome');
      assert.equal(wa.host, false);
      assert.equal(wa.hostPeer, hostPeer);
      assert.deepEqual(wa.peers.map((p) => p.name), ['Hosty', 'Alice']);
      aPeer = wa.peer;
      const pj = await host.next('peer-join');
      assert.equal(pj.peer.name, 'Alice');
      assert.equal(pj.peer.pid, 'p1');

      b.send({ t: 'join', code, name: 'Bob<script>', pid: 'p1', v: PROTOCOL_VERSION });
      const wb = await b.next('welcome');
      bPeer = wb.peer;
      assert.equal(wb.peers.length, 3);
      assert.equal((await host.next('peer-join')).peer.name, 'Bobscript');
      assert.equal((await a.next('peer-join')).peer.peer, bPeer);
    });

    await test('host broadcast reaches every client with the sender id', async () => {
      const snap: SnapMsg = {
        t: 's', n: 1, tm: 10.5, r: [1, enc.phase('wave'), 3.2, 28, 4, 1, 4, -1],
        e: [{ i: 'mob_1', k: 0, b: 0, t: 1, p: [1, 0, -3], y: 0.5, h: 60, m: 60, a: 1, ph: 0, an: 'walk', s: [], fz: 0, sh: 0 }],
        pl: [{ i: 'p1', n: 'Hosty', p: [0, 0, 0], y: 0, pt: 0, h: 100, mh: 100, s: 80, ms: 80, a: 1, w: 0 }],
      };
      host.send(`{"t":"g","d":${encode(snap)}}`);
      for (const c of [a, b]) {
        const g = await c.next('g');
        assert.equal(g.from, hostPeer);
        assert.deepEqual(decode(g.d), snap);
      }
    });

    await test('host → one client is targeted', async () => {
      host.send({ t: 'g', to: bPeer, d: { t: 'w', pid: 'p1-x', hostPid: 'p1', tm: 1 } });
      const g = await b.next('g');
      assert.equal((g.d as { pid: string }).pid, 'p1-x');
      await a.none('g');
    });

    await test('client tick (with a fire) goes only to the host, tagged with the client', async () => {
      const tick: ClientTickMsg = {
        t: 'c', n: 3, tm: 11, p: [2, 0, 2], v: [0, 0, 0], y: 0, pt: 0, g: 1, u: 0, a: 1, mh: 100, ms: 80, w: 0,
        f: [{
          o: [2, 1.65, 2], d: [0, 0, -1], m: [1, 1], sm: 0.7,
          w: weaponStatsW({
            id: 'w', name: '', archetype: 'rifle', rarity: 'rare', element: 'shock', level: 1, damage: 12, fireRate: 7, auto: true,
            magSize: 30, reloadTime: 2, pellets: 1, spread: 0.02, range: 80, critMultiplier: 2, elementChance: 0.2, perks: [], color: 0x3b8bff,
          }),
          h: [['mob_1', 0, 1.2, 0, 0, 12, 2, 0, 1, 1.2, -3]],
        }],
      };
      a.send({ t: 'g', d: tick });
      const g = await host.next('g');
      assert.equal(g.from, aPeer);
      const back = decode(g.d) as ClientTickMsg;
      assert.equal(back.f![0].h![0][0], 'mob_1');
      await b.none('g');
    });

    await test('ping/pong', async () => {
      a.send({ t: 'ping', c: 42 });
      assert.equal((await a.next('pong')).c, 42);
    });

    await test('errors: bad code, unknown room, bad json, version', async () => {
      const c = await mk('c');
      c.send({ t: 'join', code: 'AB', name: 'x', pid: 'p', v: PROTOCOL_VERSION });
      assert.equal((await c.next('error')).reason, 'bad_code');
      c.send({ t: 'join', code: 'ZZZZZ', name: 'x', pid: 'p', v: PROTOCOL_VERSION });
      assert.equal((await c.next('error')).reason, 'no_such_room');
      c.send('{nope');
      assert.equal((await c.next('error')).reason, 'bad_json');
      c.send({ t: 'join', code, name: 'x', pid: 'p', v: PROTOCOL_VERSION + 99 });
      assert.equal((await c.next('error')).reason, 'version_mismatch');
      // a peer outside any room cannot inject game frames
      c.send({ t: 'g', d: { t: 'c' } });
      await host.none('g');
      c.close();
    });

    await test(`room capacity is ${MAX_PEERS}`, async () => {
      const c = await mk('c3');
      c.send({ t: 'join', code, name: 'Cat', pid: 'p1', v: PROTOCOL_VERSION });
      await c.next('welcome');
      await host.next('peer-join');
      const d = await mk('d');
      d.send({ t: 'join', code, name: 'Dan', pid: 'p1', v: PROTOCOL_VERSION });
      assert.equal((await d.next('error')).reason, 'room_full');
      c.close();
      await host.next('peer-leave');
      await a.next('peer-leave');
    });

    await test('client leave is announced', async () => {
      b.send({ t: 'leave' });
      assert.equal((await host.next('peer-leave')).peer, bPeer);
      assert.equal((await a.next('peer-leave')).peer, bPeer);
    });

    await test('host leaving closes the room', async () => {
      host.close();
      assert.equal((await a.next('closed')).reason, 'host_left');
      assert.equal(relay.rooms().length, 0);
      a.send({ t: 'join', code, name: 'Alice', pid: 'p1', v: PROTOCOL_VERSION });
      assert.equal((await a.next('error')).reason, 'no_such_room');
    });
  } finally {
    for (const c of all) c.close();
    await relay.close();
  }
  console.log(`relay: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
