/**
 * Host side of a co-op session. The host keeps running the full simulation (ctx.isHost
 * stays true); this runtime adds one RemotePlayer per client to ctx.players, drives it
 * from the client's input ticks, resolves the client's shots / hits / area damage /
 * pickups, runs revives, and sends each client a 20 Hz snapshot (enemy deltas, its own
 * loot, players, projectiles, fx and events).
 */
import * as THREE from 'three';
import { LOOT, PLAYER } from '@/core/config';
import type { Enemy, Fx, GameContext, PlayerState } from '@/core/types';
import type { PeerInfo } from './relayProtocol';
import {
  dec, diffEnemy, enc, q1, q2, qv, readWeaponStats, stubWeapon, avatarWeaponW,
  type ClientTickMsg, type EnemyW, type EvW, type FxW, type HostMsg, type LootW, type PlayerW, type ProjW,
  type RoundW, type SnapMsg, type WeaponStats,
} from './protocol';
import { RemotePlayer } from './remotePlayer';
import { Avatar } from './avatar';
import { ClockSync, SampleBuffer, makeSample, nowSeconds } from './interp';
import { HitscanTracer, applyClaim, hostHitscan, maxHitAmount } from './hitscan';
import { HEALTH_PICKUP } from './lootMirror';

export const SNAPSHOT_HZ = 20;
export const REVIVE_TIME = 3;
export const REVIVE_RADIUS = 2.2;
export const REVIVE_HEALTH = 0.35;
const MAX_FX_PER_SNAPSHOT = 80;
const MAX_FX_FROM_CLIENT = 48;
const MAX_HITS_PER_TICK = 64;

interface Link {
  info: PeerInfo;
  pid: string;
  player: RemotePlayer;
  avatar: Avatar | null;
  buf: SampleBuffer;
  clock: ClockSync;
  enemyBase: Map<string, EnemyW>;
  lootSent: Set<string>;
  events: EvW[];
  seq: number;
  use: boolean;
  weaponKey: string;
  lastWeapon: WeaponStats | null;
  lastMults: [number, number];
  promptT: number;
}

/** Fields some enemies carry beyond EnemyState (read structurally, see INTEGRATION.md). */
interface EnemyExtras { frozen?: number; shield?: number }
interface ShotLike { id: string; kind: string; active: boolean; position: THREE.Vector3; velocity: THREE.Vector3 }
interface ShellLike { id: string; active: boolean; from: THREE.Vector3; to: THREE.Vector3; t: number; duration: number; apex: number; radius: number }

type FxRec = { fx: FxW; by: string | null };

export interface HostRuntimeOptions {
  /** Build 3D avatars for clients (off in headless tests without materials). Default true. */
  avatars?: boolean;
}

export class HostRuntime {
  private readonly links = new Map<string, Link>();
  private readonly byPid = new Map<string, Link>();
  private readonly offs: (() => void)[] = [];
  private readonly tracer = new HitscanTracer();
  private readonly fxQueue: FxRec[] = [];
  private readonly reviveProgress = new Map<string, number>();
  private readonly fxRestore: (() => void)[] = [];
  private snapAcc = 0;
  /** Peer whose actions are being replayed (fx recorded with this tag are not echoed back to it). */
  private by: string | null = null;
  private suppressUi = false;
  private localPromptT = 0;
  private readonly tmpSample = makeSample();

  constructor(
    private readonly ctx: GameContext,
    private readonly send: (to: string, msg: HostMsg) => void,
    private readonly opts: HostRuntimeOptions = {},
  ) {
    this.wrapFx();
    this.subscribe();
  }

  get clientCount(): number {
    return this.links.size;
  }

  linkFor(pid: string): RemotePlayer | undefined {
    return this.byPid.get(pid)?.player;
  }

  // ---- peers -------------------------------------------------------------------
  addPeer(info: PeerInfo): void {
    if (this.links.has(info.peer)) return;
    const ctx = this.ctx;
    // Player ids are unique per browser profile ('p-' + base36, main.ts), so they normally pass
    // through unchanged. Two tabs of one profile share the id: rename the newcomer then.
    let pid = info.pid || info.peer;
    if (ctx.players.get(pid)) pid = `${pid}-${info.peer}`;
    const link: Link = {
      info, pid,
      player: undefined as unknown as RemotePlayer,
      avatar: null,
      buf: new SampleBuffer(16),
      clock: new ClockSync(),
      enemyBase: new Map(),
      lootSent: new Set(),
      events: [],
      seq: 0,
      use: false,
      weaponKey: '',
      lastWeapon: null,
      lastMults: [1, 1],
      promptT: 0,
    };
    link.player = new RemotePlayer(ctx, pid, info.name, {
      onHurt: (amount, element, from) => {
        link.events.push({ e: 'hu', a: q1(amount), el: enc.element(element), f: from ? qv(from) : undefined });
      },
      onDied: () => {},
    });
    if (this.opts.avatars !== false) link.avatar = new Avatar(ctx, pid, info.name);
    this.links.set(info.peer, link);
    this.byPid.set(pid, link);
    ctx.players.add(link.player);
    this.send(info.peer, { t: 'w', pid, hostPid: ctx.player.id, tm: nowSeconds() });
    this.broadcastUi(`${info.name} joined`, 3, 'info');
  }

  removePeer(peer: string): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    this.byPid.delete(link.pid);
    this.ctx.players.remove(link.pid);
    link.avatar?.dispose();
    this.reviveProgress.delete(link.pid);
    // drop the loot that only this player could see
    for (const it of this.ctx.loot.items().filter((x) => x.ownerId === link.pid)) this.ctx.loot.remove(it.id);
    this.broadcastUi(`${link.info.name} left`, 3, 'warning');
  }

  // ---- inbound -----------------------------------------------------------------
  onMessage(from: string, msg: unknown): void {
    const link = this.links.get(from);
    if (!link || !msg || typeof msg !== 'object') return;
    const m = msg as ClientTickMsg;
    if (m.t === 'c') this.applyTick(link, m);
  }

  private applyTick(link: Link, m: ClientTickMsg): void {
    const ctx = this.ctx;
    const p = link.player;
    const now = nowSeconds();
    link.clock.observe(m.tm, now);
    if (!Array.isArray(m.p) || m.p.some((v) => !Number.isFinite(v))) return;
    p.silence = 0;
    p.position.set(m.p[0], m.p[1], m.p[2]);
    if (Array.isArray(m.v)) p.velocity.set(m.v[0] || 0, m.v[1] || 0, m.v[2] || 0);
    p.yaw = Number(m.y) || 0;
    p.pitch = Number(m.pt) || 0;
    p.onGround = m.g === 1;
    link.use = m.u === 1;
    link.buf.push(m.tm, m.p[0], m.p[1], m.p[2], p.yaw, p.pitch);
    p.setMax(m.mh, m.ms);
    this.applyAvatarWeapon(link, m.w);

    this.by = link.info.peer;
    try {
      const eye = new THREE.Vector3(p.position.x, p.position.y + PLAYER.eyeHeight, p.position.z);
      let hitBudget = MAX_HITS_PER_TICK;
      for (const f of m.f ?? []) {
        if (!p.alive || !f || !Array.isArray(f.o) || !Array.isArray(f.d) || !Array.isArray(f.w)) continue;
        const stats = readWeaponStats(f.w);
        const dm = Array.isArray(f.m) ? Number(f.m[0]) || 1 : 1;
        const cm = Array.isArray(f.m) ? Number(f.m[1]) || 1 : 1;
        link.lastWeapon = stats;
        link.lastMults = [dm, cm];
        // Trust the reported eye only near where we have the player.
        const origin = new THREE.Vector3(f.o[0], f.o[1], f.o[2]);
        if (origin.distanceTo(eye) > 3) origin.copy(eye);
        const dir = new THREE.Vector3(f.d[0], f.d[1], f.d[2]);
        if (dir.lengthSq() < 1e-6) continue;
        dir.normalize();
        const weapon = stubWeapon(stats);
        link.avatar?.flash();
        let hits = 0;
        if (Array.isArray(f.h)) {
          const check = { eye: origin, range: stats.range, maxAmount: maxHitAmount(stats, dm, cm) };
          for (const claim of f.h) {
            if (hitBudget-- <= 0) break;
            if (Array.isArray(claim) && applyClaim(ctx, claim, check, link.pid)) hits++;
          }
        } else {
          const muzzle = link.avatar ? link.avatar.muzzleWorld(new THREE.Vector3()) : origin;
          const res = hostHitscan(ctx, this.tracer, link.pid, {
            origin, dir, weapon: stats, damageMult: dm, critMult: cm, spreadMult: Number(f.sm) || 1,
          }, true, muzzle);
          hits = res.hits;
        }
        ctx.events.emit('weapon:fired', { playerId: link.pid, weapon, origin: origin.clone(), direction: dir.clone(), hits });
      }
      // Hits not tied to a shot: melee (2.2 m) and chained/ricochet leftovers.
      if (Array.isArray(m.h) && p.alive) {
        const mdm = Array.isArray(m.mm) ? Number(m.mm[0]) || 1 : 1;
        const mmult = Array.isArray(m.mm) ? Number(m.mm[1]) || 1 : 1;
        const check = {
          eye,
          range: Math.max(PLAYER.meleeRange + 2, link.lastWeapon?.range ?? 0),
          maxAmount: maxHitAmount(link.lastWeapon, Math.max(link.lastMults[0], mdm), link.lastMults[1], mmult),
        };
        for (const claim of m.h) {
          if (hitBudget-- <= 0) break;
          if (Array.isArray(claim)) applyClaim(ctx, claim, check, link.pid);
        }
      }
      for (const a of m.ao ?? []) {
        if (!Array.isArray(a) || !p.alive) continue;
        const c = new THREE.Vector3(a[0], a[1], a[2]);
        if (c.distanceTo(p.position) > 70) continue;
        const r = Math.min(Math.max(0, a[3]), 8);
        const amount = Math.min(Math.max(0, a[4]), PLAYER.grenadeDamage * Math.max(1, link.lastMults[0]) * 2 + 50);
        ctx.enemies.damageRadius(c, r, amount, { sourceId: link.pid, element: dec.element(a[5]), point: c.clone() });
      }
      for (const id of m.pk ?? []) this.handlePickup(link, String(id));
      let fxLeft = MAX_FX_FROM_CLIENT;
      for (const f of m.fx ?? []) {
        if (fxLeft-- <= 0) break;
        if (Array.isArray(f)) replayFx(ctx.fx, f);
      }
      if (typeof m.hl === 'number' && m.hl > 0) p.heal(Math.min(m.hl, 60));
      for (const sd of m.sd ?? []) if (Array.isArray(sd)) p.applySelfDamage(Number(sd[0]) || 0, dec.element(sd[1]));
    } finally {
      this.by = null;
    }
  }

  private applyAvatarWeapon(link: Link, w: ClientTickMsg['w']): void {
    const key = Array.isArray(w) ? w.join(',') : 'none';
    if (key === link.weaponKey) return;
    link.weaponKey = key;
    if (Array.isArray(w)) {
      const arch = dec.arch(w[0]);
      const rarity = dec.rarity(w[2]);
      link.player.setActiveWeapon(stubWeapon({
        archetype: arch, rarity, element: 'none', color: w[1] >>> 0, damage: 0, pellets: 1, spread: 0,
        range: 0, critMultiplier: 1, elementChance: 0, fireRate: 1,
      }, `net_${link.pid}`));
      link.avatar?.setWeapon(arch, w[1] >>> 0, rarity);
    } else {
      link.player.setActiveWeapon(null);
      link.avatar?.setWeapon(null, 0, 'common');
    }
  }

  private handlePickup(link: Link, id: string): void {
    const item = this.ctx.loot.items().find((it) => it.id === id);
    const p = link.player;
    let ok = false;
    if (item && item.ownerId === link.pid && p.alive) {
      const dx = item.position.x - p.position.x;
      const dz = item.position.z - p.position.z;
      const reach = LOOT.pickupRadius + 2.5; // latency slack
      ok = dx * dx + dz * dz <= reach * reach && Math.abs(item.position.y - p.position.y) < 3.5;
    }
    if (item && ok) {
      this.ctx.loot.remove(id);
      link.lootSent.delete(id);
      if (item.kind === 'health') p.heal(HEALTH_PICKUP);
      this.ctx.events.emit('loot:pickup', { playerId: link.pid, item });
    }
    link.events.push({
      e: 'pk', i: id, ok: ok ? 1 : 0, k: item ? enc.loot(item.kind) : 0,
      w: ok && item?.weapon ? item.weapon : undefined,
      g: ok && item?.gear ? item.gear : undefined,
    });
  }

  // ---- per frame -----------------------------------------------------------------
  update(dt: number): void {
    const shieldMult = this.ctx.progression?.stats?.shieldMult ?? 1;
    for (const link of this.links.values()) {
      link.player.update(dt, shieldMult);
      if (link.avatar) {
        const t = link.clock.renderTime();
        const s = link.buf.sample(t, this.tmpSample);
        if (s) {
          link.avatar.setAlive(link.player.alive);
          link.avatar.health01 = link.player.maxHealth > 0 ? link.player.health / link.player.maxHealth : 0;
          link.avatar.shield01 = link.player.maxShield > 0 ? link.player.shield / link.player.maxShield : 0;
          const rv = this.reviveProgress.get(link.pid) ?? 0;
          link.avatar.status = link.player.alive ? '' : rv > 0 ? `REVIVING ${Math.round((rv / REVIVE_TIME) * 100)}%` : 'DOWN — hold E';
          link.avatar.update(dt, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch });
        }
      }
    }
    this.updateRevives(dt);
    if (!this.links.size) {
      this.fxQueue.length = 0;
      return;
    }
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAPSHOT_HZ) {
      this.snapAcc %= 1 / SNAPSHOT_HZ;
      this.sendSnapshots();
    }
  }

  // ---- revives -------------------------------------------------------------------
  private isUsing(p: PlayerState): boolean {
    if (p === this.ctx.player) return !!this.ctx.input?.isDown('KeyE');
    return this.byPid.get(p.id)?.use ?? false;
  }

  private updateRevives(dt: number): void {
    const ctx = this.ctx;
    const phase = ctx.rounds?.state.phase;
    const players = ctx.players.list();
    if (phase === 'gameover' || phase === 'idle' || players.length < 2) {
      this.reviveProgress.clear();
      return;
    }
    this.localPromptT -= dt;
    for (const l of this.links.values()) l.promptT -= dt;
    for (const down of players) {
      if (down.alive) {
        this.reviveProgress.delete(down.id);
        continue;
      }
      let reviving = false;
      for (const r of players) {
        if (r === down || !r.alive) continue;
        const d = Math.hypot(r.position.x - down.position.x, r.position.z - down.position.z);
        if (d > REVIVE_RADIUS || Math.abs(r.position.y - down.position.y) > 2) continue;
        if (this.isUsing(r)) reviving = true;
        else this.prompt(r, `Hold E to revive ${this.nameOf(down)}`);
      }
      let prog = this.reviveProgress.get(down.id) ?? 0;
      prog = reviving ? prog + dt : Math.max(0, prog - dt * 2);
      if (prog >= REVIVE_TIME) {
        this.reviveProgress.delete(down.id);
        this.revive(down);
      } else {
        this.reviveProgress.set(down.id, prog);
      }
    }
  }

  private nameOf(p: PlayerState): string {
    return this.byPid.get(p.id)?.info.name ?? p.name;
  }

  private prompt(p: PlayerState, text: string): void {
    if (p === this.ctx.player) {
      if (this.localPromptT > 0) return;
      this.localPromptT = 2.5;
      this.suppressUi = true;
      try {
        this.ctx.events.emit('ui:message', { text, duration: 2.2, style: 'info' });
      } finally {
        this.suppressUi = false;
      }
      return;
    }
    const link = this.byPid.get(p.id);
    if (!link || link.promptT > 0) return;
    link.promptT = 2.5;
    link.events.push({ e: 'ui', tx: text, d: 2.2, st: 'info' });
  }

  private revive(p: PlayerState): void {
    p.revive(REVIVE_HEALTH);
    for (const l of this.links.values()) l.events.push({ e: 'rv', i: p.id });
    this.broadcastUi(`${this.nameOf(p)} is back up!`, 3, 'legendary');
  }

  // ---- outbound ------------------------------------------------------------------
  private broadcastUi(text: string, duration: number, style: 'info' | 'warning' | 'legendary'): void {
    // ctx.events → our ui:message relay sends it to every client too
    this.ctx.events.emit('ui:message', { text, duration, style });
  }

  private pushAll(ev: EvW, except?: string): void {
    for (const l of this.links.values()) if (l.pid !== except) l.events.push(ev);
  }

  private subscribe(): void {
    const ev = this.ctx.events;
    const on = this.offs;
    on.push(ev.on('round:phase', (e) => this.pushAll({ e: 'rp', ph: enc.phase(e.phase), r: e.round })));
    on.push(ev.on('round:intermission', (e) => this.pushAll({ e: 'ri', r: e.round, s: e.seconds })));
    on.push(ev.on('round:started', (e) => this.pushAll({ e: 'rs', r: e.round, kr: e.killsRequired })));
    on.push(ev.on('round:subwave', (e) => this.pushAll({ e: 'rw', r: e.round, sw: e.subWave, tot: e.total })));
    on.push(ev.on('round:progress', (e) => this.pushAll({ e: 'rg', k: e.kills, kr: e.killsRequired })));
    on.push(ev.on('round:boss', (e) => this.pushAll({ e: 'rb', r: e.round, bk: enc.boss(e.bossKind) })));
    on.push(ev.on('round:cleared', (e) => this.pushAll({ e: 'rc', r: e.round })));
    on.push(ev.on('game:over', (e) => this.pushAll({ e: 'go', r: e.round, k: e.kills })));
    on.push(ev.on('game:started', () => {
      for (const l of this.links.values()) {
        l.player.reset();
        l.player.position.copy(this.ctx.world.playerStart);
      }
      this.reviveProgress.clear();
      this.pushAll({ e: 'gs' });
    }));
    on.push(ev.on('boss:spawned', (e) => this.pushAll({ e: 'bs', i: e.enemy.id, nm: e.name })));
    on.push(ev.on('boss:phase', (e) => this.pushAll({ e: 'bp', i: e.enemyId, ph: e.phase })));
    on.push(ev.on('enemy:killed', (e) => this.pushAll({
      e: 'ek', i: e.enemy.id, p: qv(e.position), b: e.isBoss ? 1 : 0, t: e.tier, k: e.killerId,
    })));
    on.push(ev.on('enemy:attack', (e) => this.pushAll({ e: 'ea', i: e.enemy.id, k: e.kind })));
    on.push(ev.on('damage:dealt', (e) => {
      const link = e.playerId ? this.byPid.get(e.playerId) : undefined;
      if (!link) return;
      link.events.push({
        e: 'dd', i: e.enemyId, a: q1(e.amount), c: e.crit ? 1 : 0, el: enc.element(e.element), p: qv(e.point), kl: e.killed ? 1 : 0,
      });
    }));
    on.push(ev.on('ui:message', (e) => {
      if (this.suppressUi) return;
      this.pushAll({ e: 'ui', tx: e.text, d: e.duration, st: e.style });
    }));
    on.push(ev.on('player:died', (e) => this.pushAll({ e: 'pd', i: e.playerId })));
    on.push(ev.on('weapon:fired', (e) => {
      // host's own shots + remote shots (re-broadcast to everyone but the shooter)
      this.pushAll({ e: 'sh', i: e.playerId, a: enc.arch(e.weapon.archetype), o: qv(e.origin), d: qv(e.direction) }, e.playerId);
    }));
  }

  /** Record fx calls so clients can replay them (shake/flash stay local). */
  private wrapFx(): void {
    const fx = this.ctx.fx as Fx | undefined;
    if (!fx) return;
    const rec = (f: FxW) => {
      if (!this.links.size) return;
      this.fxQueue.push({ fx: f, by: this.by });
      if (this.fxQueue.length > MAX_FX_PER_SNAPSHOT * 2) this.fxQueue.splice(0, this.fxQueue.length - MAX_FX_PER_SNAPSHOT * 2);
    };
    const tracer = fx.tracer;
    const impact = fx.impact;
    const explosion = fx.explosion;
    const burst = fx.burst;
    fx.tracer = (from, to, color, width) => {
      tracer.call(fx, from, to, color, width);
      rec(['t', q2(from.x), q2(from.y), q2(from.z), q2(to.x), q2(to.y), q2(to.z), color >>> 0, q2(width ?? 0)]);
    };
    fx.impact = (point, normal, color) => {
      impact.call(fx, point, normal, color);
      rec(['i', q2(point.x), q2(point.y), q2(point.z), q2(normal.x), q2(normal.y), q2(normal.z), color >>> 0]);
    };
    fx.explosion = (center, radius, color) => {
      explosion.call(fx, center, radius, color);
      rec(['x', q2(center.x), q2(center.y), q2(center.z), q2(radius), color >>> 0]);
    };
    fx.burst = (point, color, count) => {
      burst.call(fx, point, color, count);
      rec(['b', q2(point.x), q2(point.y), q2(point.z), color >>> 0, count ?? 8]);
    };
    this.fxRestore.push(() => {
      fx.tracer = tracer;
      fx.impact = impact;
      fx.explosion = explosion;
      fx.burst = burst;
    });
  }

  private roundW(): RoundW {
    const s = this.ctx.rounds?.state;
    if (!s) return [0, 0, 0, 0, 0, 0, 0, -1];
    return [s.round, enc.phase(s.phase), q1(s.phaseTime), s.killsRequired, s.kills, s.subWave, s.totalKills, enc.boss(s.bossKind)];
  }

  private enemyW(e: Enemy): EnemyW {
    const s = e.state;
    const x = s as unknown as EnemyExtras;
    return {
      i: e.id,
      k: enc.kind(s.kind),
      b: e.isBoss ? 1 : 0,
      t: s.tier,
      p: qv(s.position),
      y: q2(s.yaw),
      h: q1(Math.max(0, s.health)),
      m: Math.round(s.maxHealth),
      a: s.alive ? 1 : 0,
      ph: s.phase,
      an: s.anim,
      s: s.statuses.map((st) => [enc.element(st.element), q1(st.remaining)] as [number, number]),
      fz: (x.frozen ?? 0) > 0 ? 1 : 0,
      sh: (x.shield ?? 0) > 0 ? 1 : 0,
    };
  }

  private projectilesW(): ProjW | undefined {
    // ProjectileSystem keeps its pools private; read them structurally (contract gap, see INTEGRATION.md).
    const ps = (this.ctx.enemies as unknown as { projectiles?: { shots?: ShotLike[]; shells?: ShellLike[] } }).projectiles;
    if (!ps) return undefined;
    const out: ProjW = { s: [], m: [] };
    for (const s of ps.shots ?? []) {
      if (!s.active) continue;
      out.s.push([s.id, s.kind === 'orb' ? 1 : 0, q2(s.position.x), q2(s.position.y), q2(s.position.z), q2(s.velocity.x), q2(s.velocity.y), q2(s.velocity.z)]);
    }
    for (const m of ps.shells ?? []) {
      if (!m.active) continue;
      out.m.push([m.id, q2(m.from.x), q2(m.from.y), q2(m.from.z), q2(m.to.x), q2(m.to.y), q2(m.to.z), q2(m.t), q2(m.duration), q2(m.apex), q2(m.radius)]);
    }
    return out.s.length || out.m.length ? out : { s: [], m: [] };
  }

  private playersW(): PlayerW[] {
    const out: PlayerW[] = [];
    for (const p of this.ctx.players.list()) {
      const link = this.byPid.get(p.id);
      const rv = this.reviveProgress.get(p.id);
      out.push({
        i: p.id,
        n: link ? link.info.name : p.name,
        p: qv(p.position),
        y: q2(p.yaw),
        pt: q2(p.pitch),
        h: q1(p.health),
        mh: Math.round(p.maxHealth),
        s: q1(p.shield),
        ms: Math.round(p.maxShield),
        a: p.alive ? 1 : 0,
        w: avatarWeaponW(p.activeWeapon),
        rv: rv ? q2(rv / REVIVE_TIME) : undefined,
      });
    }
    return out;
  }

  private sendSnapshots(): void {
    const tm = nowSeconds();
    const r = this.roundW();
    const enemies = this.ctx.enemies.list().map((e) => this.enemyW(e));
    const ids = new Set(enemies.map((e) => e.i));
    const pr = this.projectilesW();
    const pl = this.playersW();
    const fxAll = this.fxQueue.splice(0);
    const items = this.ctx.loot.items();

    for (const link of this.links.values()) {
      const msg: SnapMsg = { t: 's', n: ++link.seq, tm, r, pl };
      // enemies (delta vs. what this client has)
      const e: SnapMsg['e'] = [];
      for (const w of enemies) {
        const d = diffEnemy(link.enemyBase.get(w.i), w);
        if (d) {
          e.push(d);
          link.enemyBase.set(w.i, w);
        }
      }
      const x: string[] = [];
      for (const id of link.enemyBase.keys()) {
        if (!ids.has(id)) x.push(id);
      }
      for (const id of x) link.enemyBase.delete(id);
      if (e.length) msg.e = e;
      if (x.length) msg.x = x;
      if (pr) msg.pr = pr;
      // loot owned by this client
      const la: LootW[] = [];
      const present = new Set<string>();
      for (const it of items) {
        if (it.ownerId !== link.pid) continue;
        present.add(it.id);
        if (link.lootSent.has(it.id)) continue;
        link.lootSent.add(it.id);
        la.push({ i: it.id, k: enc.loot(it.kind), r: enc.rarity(it.rarity), p: qv(it.position), ag: q1(it.age), w: it.weapon, g: it.gear });
      }
      const lr: string[] = [];
      for (const id of link.lootSent) if (!present.has(id)) lr.push(id);
      for (const id of lr) link.lootSent.delete(id);
      if (la.length) msg.la = la;
      if (lr.length) msg.lr = lr;
      // fx not caused by this client
      const fx: FxW[] = [];
      for (let i = fxAll.length - 1; i >= 0 && fx.length < MAX_FX_PER_SNAPSHOT; i--) {
        if (fxAll[i].by !== link.info.peer) fx.push(fxAll[i].fx);
      }
      if (fx.length) msg.fx = fx.reverse();
      if (link.events.length) msg.ev = link.events.splice(0);
      this.send(link.info.peer, msg);
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const r of this.fxRestore) r();
    this.fxRestore.length = 0;
    for (const peer of [...this.links.keys()]) {
      const link = this.links.get(peer)!;
      this.ctx.players.remove(link.pid);
      link.avatar?.dispose();
    }
    this.links.clear();
    this.byPid.clear();
  }
}

/** Replay one recorded fx call. */
export function replayFx(fx: Fx, f: FxW): void {
  const v = (a: unknown, b: unknown, c: unknown) => new THREE.Vector3(Number(a) || 0, Number(b) || 0, Number(c) || 0);
  switch (f[0]) {
    case 't':
      fx.tracer(v(f[1], f[2], f[3]), v(f[4], f[5], f[6]), Number(f[7]) >>> 0, f[8] ? Number(f[8]) : undefined);
      break;
    case 'i':
      fx.impact(v(f[1], f[2], f[3]), v(f[4], f[5], f[6]), Number(f[7]) >>> 0);
      break;
    case 'x':
      fx.explosion(v(f[1], f[2], f[3]), Math.min(12, Math.max(0, Number(f[4]) || 0)), Number(f[5]) >>> 0);
      break;
    case 'b':
      fx.burst(v(f[1], f[2], f[3]), Number(f[4]) >>> 0, Math.min(40, Math.max(1, Number(f[5]) || 6)));
      break;
  }
}

/** Revive a player in place (kept for callers of the old helper; PlayerState.revive does it now). */
export function reviveLocalPlayer(p: PlayerState, healthFraction: number): void {
  p.revive(healthFraction);
}

