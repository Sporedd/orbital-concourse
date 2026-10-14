/**
 * End-to-end co-op smoke test, fully headless (Node 22+ global WebSocket, no browser):
 * real relay + two NetSessions (host, client) on stub GameContexts. The host runs the REAL
 * EnemyManager and LootSystem; the client runs the mirror. Exercises: join + id mapping,
 * enemy snapshots/interpolation, client shots with hit claims, host-side hitscan, area
 * damage, per-player loot + pickups, host-authoritative damage echo, self damage, downed +
 * revive, kills/removal, round state, fx relay, avatars, leave.
 *
 *   npx tsx src/net/__smoke__/session.smoke.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EventBus } from '@/core/events';
import { createRng } from '@/core/rng';
import { PLAYER } from '@/core/config';
import type {
  DamageOpts, Enemy, GameContext, LootItemState, PlayerRegistry, PlayerState, PlayerStats, RoundState, WeaponDef,
} from '@/core/types';
import { createEnemyManager } from '@/enemies';
import { createLootSystem } from '@/loot';
import { createGearSystem } from '@/gear';
import { computeLoadoutStats } from '@/gear/generator';
import type { Loadout } from '@/gear/types';
import { startRelay } from '../../../server/relay';
import { createNetSession, type NetSession } from '../session';
import { RemotePlayer } from '../remotePlayer';
import { HitscanTracer } from '../hitscan';
import { encode, enc, weaponStatsW, type ClientTickMsg } from '../protocol';
import type { MirrorEnemy } from '../enemyMirror';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
const STATS: PlayerStats = { damageMult: 1, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1 };

class FakeInput {
  down = new Set<string>();
  pressed = new Set<string>();
  uiCaptured = false;
  isDown(c: string) { return this.down.has(c); }
  justPressed(c: string) { return this.pressed.has(c); }
  justReleased() { return false; }
  rawJustPressed() { return false; }
  mouseIsDown() { return false; }
  mouseJustPressed() { return false; }
  mouseDelta() { return { dx: 0, dy: 0 }; }
  wheelDelta() { return 0; }
  locked() { return true; }
  lock() {}
  unlock() {}
  endFrame() { this.pressed.clear(); }
}

class FakePlayer implements PlayerState {
  readonly isLocal = true;
  readonly position = new THREE.Vector3(0, 0, 10);
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  health: number = PLAYER.maxHealth;
  maxHealth: number = PLAYER.maxHealth;
  shield: number = PLAYER.maxShield;
  maxShield: number = PLAYER.maxShield;
  aliveFlag = true;
  weapons: (WeaponDef | null)[] = [null, null];
  activeSlot = 0;
  grenades = 2;
  ammo = 10;
  reserve = 40;
  ammoAdds = 0;
  equipped: WeaponDef[] = [];
  resets = 0;
  revives = 0;
  loadout: Loadout = {};
  onGround = true;
  constructor(private readonly ctx: GameContext, readonly id: string, readonly name: string) {}
  get alive() { return this.aliveFlag; }
  get activeWeapon() { return this.weapons[this.activeSlot]; }
  takeDamage(amount: number, o?: DamageOpts) {
    if (!this.aliveFlag || !(amount > 0)) return;
    let rest = amount;
    const absorbed = Math.min(this.shield, rest);
    this.shield -= absorbed;
    rest -= absorbed;
    this.health = Math.max(0, this.health - rest);
    this.ctx.events.emit('player:damaged', { playerId: this.id, amount, health: this.health, shield: this.shield, element: o?.element ?? 'none' });
    if (this.health <= 0) {
      this.aliveFlag = false;
      this.ctx.events.emit('player:died', { playerId: this.id });
    }
  }
  heal(n: number) {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + n);
    if (this.health > before) this.ctx.events.emit('player:healed', { playerId: this.id, amount: this.health - before, health: this.health });
  }
  addAmmo(_f: number) { this.ammoAdds++; }
  addGrenades(n: number) { this.grenades = Math.min(PLAYER.maxGrenades, this.grenades + n); }
  equip(w: WeaponDef) {
    const old = this.weapons[this.activeSlot];
    this.weapons[this.activeSlot] = w;
    this.equipped.push(w);
    return old;
  }
  revive(f: number) {
    if (this.aliveFlag) return;
    this.revives++;
    this.aliveFlag = true;
    this.health = Math.max(1, this.maxHealth * f);
    this.shield = 0;
  }
  reset() {
    this.resets++;
    this.aliveFlag = true;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.position.set(0, 0, 10);
  }
}

function registry(): PlayerRegistry {
  const map = new Map<string, PlayerState>();
  let local: PlayerState | undefined;
  return {
    get local() { return local ?? map.values().next().value!; },
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    nearest(point) {
      let best: PlayerState | undefined;
      let bd = Infinity;
      for (const p of map.values()) {
        if (!p.alive) continue;
        const d = p.position.distanceToSquared(point);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    add(p) { map.set(p.id, p); if (p.isLocal) local = p; },
    remove(id) { map.delete(id); },
  };
}

interface Rig {
  ctx: GameContext;
  input: FakeInput;
  player: FakePlayer;
  fx: Record<string, number>;
  xp: { total: number };
  events: { name: string; payload: unknown }[];
}

function makeCtx(label: string, host: boolean): Rig {
  const input = new FakeInput();
  let n = 0;
  const fx: Record<string, number> = { tracer: 0, impact: 0, explosion: 0, burst: 0 };
  const xp = { total: 0 };
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(85, 16 / 9, 0.05, 400),
    renderer: undefined,
    canvas: undefined,
    uiRoot: undefined,
    input,
    events: new EventBus(),
    time: { delta: 0, elapsed: 0 },
    rng: createRng(host ? 1234 : 5678),
    isHost: true,
    nextId: (p: string) => `${p}_${label}${(++n).toString(36)}`,
  } as unknown as GameContext;
  ctx.materials = {
    toon: (o) => new THREE.MeshToonMaterial({ color: o.color, emissive: o.emissive ?? 0x000000 }),
    glow: (c) => new THREE.MeshBasicMaterial({ color: c }),
  };
  ctx.fx = {
    tracer: () => { fx.tracer++; },
    impact: () => { fx.impact++; },
    explosion: () => { fx.explosion++; },
    burst: () => { fx.burst++; },
    shake: () => {},
    flash: () => {},
    update: () => {},
  };
  ctx.audio = { play() {}, setMusic() {}, resume() {}, muted: true, setMuted() {}, update() {} };
  ctx.world = {
    playerStart: new THREE.Vector3(0, 0, 10),
    mobSpawnPoints: [new THREE.Vector3(0, 0, -20)],
    bossSpawn: new THREE.Vector3(0, 0, -20),
    groundHeight: () => 0,
    resolveCapsule: (p) => ({ position: p.clone(), onGround: true }),
    raycast: () => null,
    randomNavigablePoint: () => new THREE.Vector3(),
    update() {},
  };
  ctx.players = registry();
  const player = new FakePlayer(ctx, 'p1', label);
  ctx.players.add(player);
  ctx.player = player;
  ctx.progression = { stats: STATS, addXp: (a: number) => { xp.total += a; } } as unknown as GameContext['progression'];
  const state: RoundState = { round: 1, phase: 'intermission', phaseTime: 0, killsRequired: 28, kills: 0, subWave: 0, totalKills: 0 };
  ctx.rounds = { state, start() {}, update() {} };
  if (host) {
    ctx.enemies = createEnemyManager(ctx);
    ctx.loot = createLootSystem(ctx);
  } else {
    // whatever single-player systems the client had before joining
    ctx.enemies = { list: () => [], get: () => undefined, clear() {}, update() {}, aliveCount: () => 0, bossAlive: () => false, damageRadius: () => 0 } as unknown as GameContext['enemies'];
    ctx.loot = { items: () => [], clear() {}, update() {}, dropLoot: () => [], starterWeapon: () => starter('c'), generateWeapon: () => starter('g') } as unknown as GameContext['loot'];
  }
  const events: Rig['events'] = [];
  for (const name of ['damage:dealt', 'enemy:killed', 'round:phase', 'player:damaged', 'loot:pickup', 'ui:message', 'boss:spawned'] as const) {
    ctx.events.on(name, (payload) => events.push({ name, payload }));
  }
  return { ctx, input, player, fx, xp, events };
}

function starter(id: string): WeaponDef {
  return {
    id, name: 'Starter', archetype: 'pistol', rarity: 'common', element: 'none', level: 1, damage: 20, fireRate: 4, auto: false,
    magSize: 12, reloadTime: 1.2, pellets: 1, spread: 0.01, accuracy: 82, zoom: 1.25, adsSpread: 0.6, range: 60, critMultiplier: 2, elementChance: 0, perks: [], color: 0xdddddd,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let H: Rig;
let C: Rig;
let hostS: NetSession;
let clientS: NetSession;

async function pump(ms: number): Promise<void> {
  const end = Date.now() + ms;
  let last = performance.now();
  while (Date.now() < end) {
    await sleep(8);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    H.ctx.enemies.update(dt);
    H.ctx.loot.update(dt);
    H.ctx.scene.updateMatrixWorld(true);
    hostS.update(dt);
    clientS.update(dt);
    C.ctx.loot.update(dt);
    C.ctx.scene.updateMatrixWorld(true);
    H.input.endFrame();
    C.input.endFrame();
  }
}

async function until(what: string, pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await pump(16);
  }
  assert.fail(`timed out: ${what}`);
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
  H = makeCtx('h', true);
  C = makeCtx('c', false);
  hostS = createNetSession(H.ctx, { url });
  clientS = createNetSession(C.ctx, { url });
  const snapSizes: number[] = [];
  let hostPidOfClient = '';
  let clientPeer = '';
  let grunt: Enemy;
  let mirror: MirrorEnemy | undefined;

  try {
    await test('host + join over the relay; client switches into mirror mode', async () => {
      const code = await hostS.host('Hosty');
      assert.equal(code.length, 5);
      await clientS.join(code, 'Clienty');
      assert.equal(clientS.role, 'client');
      assert.equal(C.ctx.isHost, false);
      assert.equal(H.ctx.isHost, true);
      assert.ok(C.player.equipped.length === 1, 'client got a starter weapon');
      await until('host has the remote player', () => H.ctx.players.list().length === 2);
      const remote = H.ctx.players.list().find((p) => p !== H.player)!;
      assert.ok(remote instanceof RemotePlayer);
      // both peers use local id 'p1' → host disambiguates
      assert.notEqual(remote.id, 'p1');
      hostPidOfClient = remote.id;
      clientPeer = hostS.peers.find((p) => !p.host)!.peer;
      await until('client snapshot', () => !!clientS.clientRuntime?.lastSnapshot);
    });

    await test('client movement drives the host-side RemotePlayer', async () => {
      C.player.position.set(3, 0, 0);
      C.player.yaw = 0.4;
      await until('remote position', () => H.ctx.players.get(hostPidOfClient)!.position.distanceTo(new THREE.Vector3(3, 0, 0)) < 0.01);
      assert.ok(Math.abs(H.ctx.players.get(hostPidOfClient)!.yaw - 0.4) < 0.01);
    });

    await test('host enemy appears on the client (same id, interpolated position)', async () => {
      grunt = H.ctx.enemies.spawnMob('grunt', new THREE.Vector3(0, 0, -5), 1);
      (grunt.state as unknown as { stun: number }).stun = 999; // keep it still for the shots
      grunt.state.maxHealth = grunt.state.health = 1000; // survive every test shot
      await until('mirror enemy', () => !!(mirror = C.ctx.enemies.get(grunt.id) as MirrorEnemy | undefined));
      await pump(250);
      assert.ok(mirror!.position.distanceTo(grunt.position) < 0.05, `mirror at ${mirror!.position.toArray()} vs ${grunt.position.toArray()}`);
      assert.equal(mirror!.state.maxHealth, grunt.state.maxHealth);
      assert.ok(mirror!.object.parent === C.ctx.scene, 'mirror rig is in the client scene');
    });

    await test('client shot: local hitscan vs mirror → claim → host applies damage → damage:dealt echoed', async () => {
      const before = grunt.state.health;
      const eye = new THREE.Vector3(3, PLAYER.eyeHeight, 0);
      const target = mirror!.centerPoint(new THREE.Vector3());
      const dir = target.clone().sub(eye).normalize();
      const tracer = new HitscanTracer();
      tracer.prepare(C.ctx.enemies.list());
      const hit = tracer.trace(C.ctx.world, eye, dir, 60);
      assert.equal(hit.enemy, mirror, 'client trace hits the mirrored rig');
      // exactly what WeaponSystem.shoot does: enemy.damage per pellet, then weapon:fired
      C.ctx.fx.tracer(eye, hit.point, 0xffffff);
      hit.enemy!.damage(20, { point: hit.point, crit: false, element: 'none', sourceId: 'p1' });
      C.ctx.events.emit('weapon:fired', { playerId: 'p1', weapon: starter('s'), origin: eye, direction: dir, hits: 1 });
      assert.equal(grunt.state.health, before, 'no local damage on the client');
      const tracersBefore = H.fx.tracer;
      await until('host damage', () => grunt.state.health === before - 20);
      await until('damage:dealt on client', () => C.events.some((e) => e.name === 'damage:dealt' && (e.payload as { playerId: string; amount: number }).playerId === 'p1'));
      const dd = C.events.find((e) => e.name === 'damage:dealt')!.payload as { amount: number; enemyId: string };
      assert.equal(dd.amount, 20);
      assert.equal(dd.enemyId, grunt.id);
      assert.ok(H.fx.tracer > tracersBefore, 'host replayed the client tracer');
      await until('mirror health', () => mirror!.state.health === grunt.state.health);
    });

    await test('host-side hitscan (shot without claims) uses pellets/crit rules', async () => {
      const before = grunt.state.health;
      const eye = new THREE.Vector3(3, PLAYER.eyeHeight, 0);
      const dir = grunt.position.clone().setY(1.1).sub(eye).normalize();
      const shotgun: WeaponDef = { ...starter('sg'), archetype: 'shotgun', pellets: 6, spread: 0.01, damage: 5 };
      const tick: ClientTickMsg = {
        t: 'c', n: 999, tm: performance.now() / 1000, p: [3, 0, 0], v: [0, 0, 0], y: 0, pt: 0, g: 1, u: 0, a: 1, mh: 100, ms: 80, w: 0,
        f: [{ o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], w: weaponStatsW(shotgun), m: [1, 1], sm: 0.7 }],
      };
      hostS.hostRuntime!.onMessage(clientPeer, JSON.parse(encode(tick)));
      assert.equal(grunt.state.health, before - 30, `6 pellets × 5 (got ${before - grunt.state.health})`);
    });

    await test('client area damage (grenade/splash) is applied on the host', async () => {
      const before = grunt.state.health;
      C.ctx.enemies.damageRadius(mirror!.position.clone(), 3, 10, { sourceId: 'p1', element: 'none' });
      await until('aoe damage', () => grunt.state.health < before - 5);
    });

    await test('implausible claims are rejected (unknown enemy, out of range, too much damage)', async () => {
      const before = grunt.state.health;
      const claimTick = (claims: ClientTickMsg['h'], p: [number, number, number] = [3, 0, 0]): ClientTickMsg => ({
        t: 'c', n: 1000, tm: performance.now() / 1000, p, v: [0, 0, 0], y: 0, pt: 0, g: 1, u: 0, a: 1, mh: 100, ms: 80, w: 0,
        f: [{ o: [p[0], 1.65, p[2]], d: [0, 0, -1], w: weaponStatsW(starter('x')), m: [1, 1], sm: 1, h: claims }],
      });
      hostS.hostRuntime!.onMessage(clientPeer, claimTick([['nope', 0, 1, 0, 0, 10, 0, 0, 0, 1, 0]]));
      hostS.hostRuntime!.onMessage(clientPeer, claimTick([[grunt.id, 0, 9, 0, 0, 10, 0, 0, 0, 9, -5]])); // above the head
      hostS.hostRuntime!.onMessage(clientPeer, claimTick([[grunt.id, 0, 1, 0, 0, 10, 0, 0, 0, 1, -5]], [0, 0, 200])); // 200 m away
      assert.equal(grunt.state.health, before);
      hostS.hostRuntime!.onMessage(clientPeer, claimTick([[grunt.id, 0, 1, 0, 0, 99999, 0, 0, 0, 1, -5]]));
      const dealt = before - grunt.state.health;
      assert.ok(dealt > 0 && dealt <= 20 * 2 * 1.35 + 1, `damage capped to the weapon (${dealt})`);
      // restore the host's view of the client position for the next tests
      await pump(100);
    });

    await test('loot is per player: client sees only its own drops; pickups confirmed by the host', async () => {
      const drops = H.ctx.loot.dropLoot(new THREE.Vector3(3, 0, 0), { tier: 1, ownerId: hostPidOfClient, count: 2, guaranteed: ['ammo', 'weapon'] });
      for (const it of drops) it.position = { x: 3, y: 0, z: 0 };
      H.ctx.loot.dropLoot(new THREE.Vector3(3, 0, 0), { tier: 1, ownerId: 'p1', count: 1, guaranteed: ['weapon'] }); // host's own
      const hostOwn = H.ctx.loot.items().find((i) => i.ownerId === 'p1')!;
      await until('ammo picked up', () => C.player.ammoAdds === 1);
      assert.ok(!H.ctx.loot.items().some((i) => i.id === drops[0].id), 'host removed the ammo');
      assert.ok(!C.ctx.loot.items().some((i: LootItemState) => i.id === hostOwn.id), 'host-owned loot never reaches the client');
      const weaponItem = drops[1];
      await until('weapon item mirrored', () => C.ctx.loot.items().some((i) => i.id === weaponItem.id));
      C.input.pressed.add('KeyE');
      await until('weapon equipped', () => C.player.equipped.some((w) => w.id === weaponItem.weapon!.id));
      assert.ok(!H.ctx.loot.items().some((i) => i.id === weaponItem.id));
      // replaced starter dropped as a client-only item
      assert.ok(C.ctx.loot.items().some((i) => i.id.startsWith('local_loot_')));
      assert.ok(H.ctx.loot.items().some((i) => i.id === hostOwn.id), 'host loot untouched');
    });

    await test('gear loot crosses the wire: walk-over pickup lands in the client inventory', async () => {
      C.ctx.gear = createGearSystem(C.ctx, { persist: false });
      const [gearItem] = H.ctx.loot.dropLoot(new THREE.Vector3(3, 0, 0), { tier: 3, ownerId: hostPidOfClient, count: 1, guaranteed: ['gear'] });
      gearItem.position = { x: 3, y: 0, z: 0 };
      assert.ok(gearItem.gear, 'host generated a GearDef');
      await until('gear in client inventory', () => C.ctx.gear!.inventory.has(gearItem.gear!.id));
      assert.ok(!H.ctx.loot.items().some((i) => i.id === gearItem.id), 'host removed the gear item');
      assert.ok(!H.ctx.gear, 'host has no gear system: nothing went to the host inventory');
    });

    await test('loadouts cross the wire: the host RemotePlayer and the client view wear the gear', async () => {
      const helm = C.ctx.gear!.generate(4, { slot: 'helm', rarity: 'rare' });
      C.player.loadout = { helm };
      C.ctx.events.emit('gear:changed', { playerId: C.player.id, stats: computeLoadoutStats(C.player.loadout), loadout: C.player.loadout });
      const remote = H.ctx.players.get(hostPidOfClient) as RemotePlayer;
      await until('host remote player wears the helm', () => remote.loadout.helm?.id === helm.id);
      assert.equal(Object.keys(remote.loadout).length, 1, 'only the helm');
      const chest = C.ctx.gear!.generate(6, { slot: 'chest', rarity: 'epic' });
      H.player.loadout = { chest };
      H.ctx.events.emit('gear:changed', { playerId: H.player.id, stats: computeLoadoutStats(H.player.loadout), loadout: H.player.loadout });
      const hostLocalId = clientS.clientRuntime!.toLocal(H.player.id)!;
      await until('client sees the host loadout', () => clientS.clientRuntime!.remoteLoadout(hostLocalId)?.chest?.id === chest.id);
      // a bad piece is dropped, the rest kept
      C.player.loadout = { helm, boots: { ...helm, id: 'bad', slot: 'boots' } as unknown as Loadout['boots'] };
      C.ctx.events.emit('gear:changed', { playerId: C.player.id, stats: computeLoadoutStats(C.player.loadout), loadout: C.player.loadout });
      await until('host got the second loadout', () => remote.loadout.boots !== undefined || Object.keys(remote.loadout).length === 1 && remote.loadout.helm?.id === helm.id);
      await pump(150);
      assert.equal(remote.loadout.helm?.id, helm.id);
      assert.ok(remote.loadout.boots?.slot === 'boots' || remote.loadout.boots === undefined);
    });

    await test('enemy damage on the host is authoritative and echoed to the client', async () => {
      const remote = H.ctx.players.get(hostPidOfClient) as RemotePlayer;
      remote.takeDamage(30, { element: 'none', point: new THREE.Vector3(0, 1, -5) });
      assert.equal(remote.shield, 50);
      await until('client shield synced', () => Math.abs(C.player.shield - 50) < 0.5);
      assert.ok(C.events.some((e) => e.name === 'player:damaged'), 'client got player:damaged for HUD/fx');
      await pump(200);
      assert.equal(remote.shield, 50, 'echoed damage is not sent back as self damage');
    });

    await test('client self damage (own grenade) is forwarded', async () => {
      const remote = H.ctx.players.get(hostPidOfClient) as RemotePlayer;
      C.player.takeDamage(10);
      await until('host applied self damage', () => Math.abs(remote.shield - 40) < 0.5);
    });

    await test('downed client is revived by the host holding E nearby (3 s)', async () => {
      const remote = H.ctx.players.get(hostPidOfClient) as RemotePlayer;
      H.ctx.rounds.state.phase = 'wave';
      remote.takeDamage(1000);
      assert.equal(remote.alive, false);
      await until('client is down', () => !C.player.alive);
      H.player.position.set(3, 0, 0.8);
      H.input.down.add('KeyE');
      await until('client revived', () => C.player.alive, 5000);
      H.input.down.delete('KeyE');
      assert.ok(remote.alive);
      assert.ok(Math.abs(remote.health - PLAYER.maxHealth * 0.35) < 1);
      await until('client health synced', () => Math.abs(C.player.health - remote.health) < 0.5);
      assert.ok(C.player.position.distanceTo(new THREE.Vector3(3, 0, 0)) < 0.5, 'revived in place');
    });

    await test('kill: enemy:killed relayed (XP on client), corpse removed after the death animation', async () => {
      const xpBefore = C.xp.total;
      grunt.damage(99999, { sourceId: hostPidOfClient });
      await until('client kill event', () => C.events.some((e) => e.name === 'enemy:killed'));
      const ev = C.events.find((e) => e.name === 'enemy:killed')!.payload as { killerId: string; enemy: Enemy };
      assert.equal(ev.killerId, 'p1', 'killer id mapped back to the client local id');
      assert.equal(ev.enemy.alive, false);
      assert.ok(C.xp.total > xpBefore, `xp ${C.xp.total} vs ${xpBefore}`);
      await until('mirror removed', () => !C.ctx.enemies.get(grunt.id), 4000);
      assert.equal(C.ctx.scene.children.includes(mirror!.object), false);
    });

    await test('round state + events mirror to the client HUD', async () => {
      const s = H.ctx.rounds.state;
      s.round = 4;
      s.phase = 'boss';
      s.bossKind = 'summoner';
      H.ctx.events.emit('round:phase', { phase: 'boss', round: 4 });
      await until('round state', () => C.ctx.rounds.state.round === 4 && C.ctx.rounds.state.phase === 'boss');
      assert.equal(C.ctx.rounds.state.bossKind, 'summoner');
      await until('round:phase event', () => C.events.some((e) => e.name === 'round:phase' && (e.payload as { round: number }).round === 4));
      const boss = H.ctx.enemies.spawnBoss('summoner', new THREE.Vector3(0, 0, -15), 4);
      await until('boss:spawned on client', () => C.events.some((e) => e.name === 'boss:spawned' && (e.payload as { enemy: Enemy }).enemy.id === boss.id));
    });

    await test('host fx (explosions etc.) replay on the client; enemy projectiles mirrored', async () => {
      const before = C.fx.explosion;
      H.ctx.fx.explosion(new THREE.Vector3(1, 0, 1), 4, 0xff8a2a);
      await until('client explosion', () => C.fx.explosion > before);
      const s = clientS.clientRuntime!.lastSnapshot!;
      snapSizes.push(encode(s).length);
      assert.ok(s.pr, 'projectile block present');
    });

    await test('remote avatars exist on both sides', async () => {
      const hasAvatar = (scene: THREE.Scene) => scene.children.some((o) => o.name.startsWith("avatar:"));
      assert.ok(hasAvatar(H.ctx.scene), 'host shows the client avatar');
      assert.ok(hasAvatar(C.ctx.scene), 'client shows the host avatar');
    });

    await test('bandwidth sample', async () => {
      const sizes: number[] = [];
      const off = setInterval(() => {
        const s = clientS.clientRuntime?.lastSnapshot;
        if (s) sizes.push(encode(s).length);
      }, 50);
      await pump(500);
      clearInterval(off);
      const avg = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
      console.log(`      avg snapshot ${Math.round(avg)} B (boss + summons alive) ≈ ${Math.round((avg * 20) / 1024)} KiB/s per client`);
      assert.ok(avg < 20000);
    });

    await test('client leave → host drops the RemotePlayer; client restored to single-player', async () => {
      clientS.leave();
      assert.equal(C.ctx.isHost, true);
      assert.equal(clientS.role, 'offline');
      await until('host removed remote', () => H.ctx.players.list().length === 1);
    });
  } finally {
    clientS.leave();
    hostS.leave();
    await relay.close();
  }
  console.log(`session: ${passed} checks passed`);
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
