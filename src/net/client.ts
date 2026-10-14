/**
 * Client side of a co-op session.
 *
 * On start it flips ctx.isHost to false (rounds/progression/loot sims are gated by it),
 * swaps ctx.enemies for a MirrorEnemyRegistry and ctx.loot for a LootMirror, and keeps the
 * local Player fully local (movement, weapons, viewmodel). The local weapon code still
 * traces against the mirrored enemies; their damage() turns into hit claims that are sent
 * to the host with each shot. Enemies, loot, round state and other players come from
 * 20 Hz snapshots rendered 100 ms in the past; health/shield/alive of the local player are
 * overwritten by the host's authoritative values.
 */
import * as THREE from 'three';
import { PLAYER, XP } from '@/core/config';
import type {
  DamageOpts, EnemyRegistry, Fx, GameContext, LootSystem, PlayerState, RoundState,
} from '@/core/types';
import {
  avatarWeaponW, dec, enc, q1, q2, qv, stubWeapon, weaponStatsW,
  type AoeW, type ClientMsg, type ClientTickMsg, type EvW, type FireW, type FxW, type HitW, type PlayerW, type SnapMsg,
  sanitizeLoadout,
} from './protocol';
import { MirrorEnemyRegistry, type ClaimSink, type MirrorEnemy } from './enemyMirror';
import { LootMirror } from './lootMirror';
import { Avatar } from './avatar';
import { ClockSync, SampleBuffer, makeSample, nowSeconds, INTERP_DELAY } from './interp';
import { replayFx, reviveLocalPlayer } from './host';
import { effectiveDamageMult, gearExtras, getStats } from '@/player/shared';
import type { Loadout } from '@/gear/types';

export const CLIENT_TICK_HZ = 30;
const MAX_FX_UP = 48;

interface RemoteView {
  avatar: Avatar | null;
  buf: SampleBuffer;
  seen: number;
  /** Loadout version + gear as last received (SnapMsg.ld), for the avatar. */
  lv: number;
  loadout: Loadout;
}

export interface ClientRuntimeOptions {
  avatars?: boolean;
}

export class ClientRuntime {
  readonly mirror: MirrorEnemyRegistry;
  readonly loot: LootMirror;
  private readonly clock = new ClockSync();
  private readonly offs: (() => void)[] = [];
  private readonly fxRestore: (() => void)[] = [];
  private readonly remotes = new Map<string, RemoteView>();
  private readonly tmpSample = makeSample();
  private origEnemies: EnemyRegistry | null = null;
  private origLoot: LootSystem | null = null;
  private origIsHost = true;
  private started = false;
  private welcomed = false;
  /** Host-side id of this client's player. */
  private myHostPid = '';
  private hostPid = '';
  private seq = 0;
  private tickAcc = 0;
  private snapGen = 0;
  private replaying = false;
  /** Send the local loadout in the next tick (first tick after welcome, then on gear:changed). */
  private loadoutDirty = true;
  private suppressLocal = false;
  /** Outbox for the next tick. */
  private pendingHits: HitW[] = [];
  private fires: FireW[] = [];
  private aoes: AoeW[] = [];
  private picks: string[] = [];
  private fxUp: FxW[] = [];
  private heal = 0;
  private selfDmg: [number, number][] = [];
  lastSnapshot: SnapMsg | null = null;

  constructor(
    private readonly ctx: GameContext,
    private readonly send: (msg: ClientMsg) => void,
    private readonly opts: ClientRuntimeOptions = {},
  ) {
    const sink: ClaimSink = {
      hit: (enemy, amount, o) => this.onLocalHit(enemy, amount, o),
      area: (center, radius, amount, o) => {
        this.aoes.push([q2(center.x), q2(center.y), q2(center.z), q2(radius), q1(amount), enc.element(o?.element ?? 'none')]);
      },
    };
    this.mirror = new MirrorEnemyRegistry(ctx, sink);
    this.loot = new LootMirror(ctx, (id) => this.picks.push(id));
  }

  get localId(): string {
    return this.ctx.player.id;
  }

  /** The local crowd tier's XP multiplier (system I), like the host's progression applies. */
  private xpMult(): number {
    return this.ctx.standing?.xpMult() ?? 1;
  }

  /** Switch the context into client mode. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const ctx = this.ctx;
    this.origIsHost = ctx.isHost;
    this.origEnemies = ctx.enemies;
    this.origLoot = ctx.loot;
    ctx.isHost = false;
    try { this.origEnemies?.clear(); } catch { /* ignore */ }
    try { this.origLoot?.clear(); } catch { /* ignore */ }
    ctx.enemies = this.mirror;
    ctx.loot = this.loot;
    const rs = ctx.rounds?.state as RoundState | undefined;
    if (rs) Object.assign(rs, { round: 0, phase: 'idle', phaseTime: 0, killsRequired: 0, kills: 0, subWave: 0, totalKills: 0, bossKind: undefined });
    this.ensureWeapon();
    this.wrapFx();
    this.subscribe();
  }

  private ensureWeapon(): void {
    const p = this.ctx.player;
    if (p && !p.weapons.some((w) => !!w)) p.equip(this.loot.starterWeapon());
  }

  // ---- id mapping (host ids ↔ local ids) -------------------------------------------
  /** Host-side player id → id as seen locally. */
  /** The gear a remote player (local id) wears, as last received. */
  remoteLoadout(id: string): Readonly<Loadout> | undefined {
    return this.remotes.get(id)?.loadout;
  }

  toLocal(id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    if (id === this.myHostPid) return this.localId;
    if (id === this.localId) return `~${id}`; // host (or another peer) shares our local id
    return id;
  }

  // ---- local → outbox ----------------------------------------------------------------
  private onLocalHit(enemy: MirrorEnemy, amount: number, o: DamageOpts | undefined): void {
    const pt = o?.point ?? enemy.centerPoint(new THREE.Vector3());
    this.pendingHits.push([
      enemy.id,
      q2(pt.x - enemy.position.x), q2(pt.y - enemy.position.y), q2(pt.z - enemy.position.z),
      o?.crit ? 1 : 0, q1(amount), enc.element(o?.element ?? 'none'), o?.applyStatus ? 1 : 0,
      q2(pt.x), q2(pt.y), q2(pt.z),
    ]);
  }

  private spreadMult(p: PlayerState): number {
    if (Math.abs(p.velocity.y) > 0.5) return 1.8;
    const s = Math.min(1.5, Math.hypot(p.velocity.x, p.velocity.z) / PLAYER.walkSpeed);
    return 0.7 + 0.45 * s;
  }

  private subscribe(): void {
    const ev = this.ctx.events;
    this.offs.push(ev.on('weapon:fired', (e) => {
      if (e.playerId !== this.localId || this.replaying) return;
      // full outgoing multipliers: skill tree × gear × sponsor/crowd (the host caps claims with these)
      const stats = getStats(this.ctx);
      this.fires.push({
        o: qv(e.origin),
        d: [Math.round(e.direction.x * 1e4) / 1e4, Math.round(e.direction.y * 1e4) / 1e4, Math.round(e.direction.z * 1e4) / 1e4],
        w: weaponStatsW(e.weapon),
        m: [q2(effectiveDamageMult(this.ctx)), q2(stats.critMult)],
        sm: q2(this.spreadMult(this.ctx.player)),
        h: this.pendingHits.splice(0),
      });
    }));
    this.offs.push(ev.on('gear:changed', (e) => {
      if (e.playerId === this.localId) this.loadoutDirty = true;
    }));
    this.offs.push(ev.on('player:healed', (e) => {
      if (e.playerId === this.localId && !this.suppressLocal) this.heal += e.amount;
    }));
    this.offs.push(ev.on('player:damaged', (e) => {
      // only self-inflicted damage originates here (enemies run on the host)
      if (e.playerId === this.localId && !this.suppressLocal) this.selfDmg.push([q1(e.amount), enc.element(e.element)]);
    }));
  }

  private wrapFx(): void {
    const fx = this.ctx.fx as Fx | undefined;
    if (!fx) return;
    const rec = (f: FxW) => {
      if (this.replaying || this.fxUp.length >= MAX_FX_UP) return;
      this.fxUp.push(f);
    };
    const tracer = fx.tracer;
    const impact = fx.impact;
    const explosion = fx.explosion;
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
    this.fxRestore.push(() => {
      fx.tracer = tracer;
      fx.impact = impact;
      fx.explosion = explosion;
    });
  }

  // ---- inbound -------------------------------------------------------------------
  onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { t?: string };
    if (m.t === 'w') {
      const w = msg as { pid: string; hostPid: string; tm: number };
      this.myHostPid = String(w.pid);
      this.hostPid = String(w.hostPid);
      this.clock.observe(Number(w.tm) || 0);
      this.welcomed = true;
      this.loadoutDirty = true;
    } else if (m.t === 's') {
      this.applySnapshot(msg as SnapMsg);
    }
  }

  private applySnapshot(s: SnapMsg): void {
    if (!this.started) return;
    const ctx = this.ctx;
    this.clock.observe(s.tm);
    this.lastSnapshot = s;

    // round state (the HUD reads it every frame)
    const rs = ctx.rounds?.state as RoundState | undefined;
    if (rs && Array.isArray(s.r)) {
      rs.round = s.r[0];
      rs.phase = dec.phase(s.r[1]);
      rs.phaseTime = s.r[2];
      rs.killsRequired = s.r[3];
      rs.kills = s.r[4];
      rs.subWave = s.r[5];
      rs.totalKills = s.r[6];
      rs.bossKind = dec.boss(s.r[7]);
    }

    this.mirror.applySnapshot(s.tm, s.e, s.x);
    this.mirror.projectiles.apply(s.pr);
    this.loot.apply(s.la, s.lr);
    for (const e of s.ev ?? []) this.applyEvent(e);
    this.applyPlayers(s.tm, s.pl);
    for (const e of s.ld ?? []) {
      if (!e || typeof e !== 'object') continue;
      const id = this.toLocal(e.i);
      if (!id || id === this.localId) continue;
      const rv = this.remotes.get(id);
      if (!rv) continue;
      rv.lv = Number(e.v) || 0;
      rv.loadout = sanitizeLoadout(e.l);
      rv.avatar?.setLoadout(rv.loadout);
    }
    if (s.fx?.length) {
      this.replaying = true;
      try {
        for (const f of s.fx) {
          if (!Array.isArray(f)) continue;
          replayFx(ctx.fx, f);
          // enemy code plays explosion audio directly on the host; voice replayed blasts here
          if (f[0] === 'x') ctx.audio?.play('explosion', { position: new THREE.Vector3(f[1], f[2], f[3]), volume: 0.7 });
        }
      } finally {
        this.replaying = false;
      }
    }
  }

  private applyPlayers(tm: number, list: PlayerW[]): void {
    const gen = ++this.snapGen;
    const p = this.ctx.player;
    for (const w of list ?? []) {
      const id = this.toLocal(w.i)!;
      if (id === this.localId) {
        this.syncLocal(p, w);
        continue;
      }
      let rv = this.remotes.get(id);
      if (!rv) {
        rv = { avatar: this.opts.avatars === false ? null : new Avatar(this.ctx, id, w.n), buf: new SampleBuffer(16), seen: gen, lv: -1, loadout: {} };
        this.remotes.set(id, rv);
      }
      rv.seen = gen;
      rv.buf.push(tm, w.p[0], w.p[1], w.p[2], w.y, w.pt);
      const a = rv.avatar;
      if (a) {
        a.name = w.n;
        a.setAlive(w.a === 1);
        a.health01 = w.mh > 0 ? w.h / w.mh : 0;
        a.shield01 = w.ms > 0 ? w.s / w.ms : 0;
        a.status = w.a === 1 ? '' : w.rv ? `REVIVING ${Math.round(w.rv * 100)}%` : 'DOWN — hold E';
        if (Array.isArray(w.w)) a.setWeapon(dec.arch(w.w[0]), w.w[1] >>> 0, dec.rarity(w.w[2]));
        else a.setWeapon(null, 0, 'common');
      }
    }
    for (const [id, rv] of this.remotes) {
      if (rv.seen !== gen) {
        rv.avatar?.dispose();
        this.remotes.delete(id);
      }
    }
  }

  private syncLocal(p: PlayerState, w: PlayerW): void {
    if (w.a === 0 && p.alive) {
      this.suppressLocal = true;
      try { p.takeDamage(1e9, { element: 'none' }); } finally { this.suppressLocal = false; }
    } else if (w.a === 1 && !p.alive) {
      this.suppressLocal = true;
      try { reviveLocalPlayer(p, w.mh > 0 ? w.h / w.mh : 0.35); } finally { this.suppressLocal = false; }
    }
    if (p.alive) {
      p.health = Math.min(p.maxHealth, Math.max(0, w.h));
      p.shield = Math.min(p.maxShield, Math.max(0, w.s));
    }
  }

  private applyEvent(e: EvW): void {
    const ctx = this.ctx;
    const ev = ctx.events;
    switch (e.e) {
      case 'rp': ev.emit('round:phase', { phase: dec.phase(e.ph), round: e.r }); break;
      case 'ri': ev.emit('round:intermission', { round: e.r, seconds: e.s }); break;
      case 'rs': ev.emit('round:started', { round: e.r, killsRequired: e.kr }); break;
      case 'rw': ev.emit('round:subwave', { round: e.r, subWave: e.sw, total: e.tot }); break;
      case 'rg': ev.emit('round:progress', { kills: e.k, killsRequired: e.kr }); break;
      case 'rb': ev.emit('round:boss', { round: e.r, bossKind: dec.boss(e.bk) ?? 'brute' }); break;
      case 'rc':
        ev.emit('round:cleared', { round: e.r });
        ctx.progression?.addXp(Math.round(XP.roundClear * this.xpMult()));
        break;
      case 'gs': {
        const p = ctx.player;
        this.suppressLocal = true;
        try { p.reset(); } finally { this.suppressLocal = false; }
        this.ensureWeapon();
        this.loot.clear();
        ev.emit('game:started', {});
        break;
      }
      case 'go': ev.emit('game:over', { round: e.r, kills: e.k }); break;
      case 'bs': {
        const enemy = this.mirror.get(e.i);
        if (enemy) ev.emit('boss:spawned', { enemy, name: e.nm });
        break;
      }
      case 'bp': ev.emit('boss:phase', { enemyId: e.i, phase: e.ph }); break;
      case 'ek': {
        const enemy = this.mirror.get(e.i);
        if (!enemy) break;
        enemy.kill();
        ev.emit('enemy:killed', {
          enemy, position: new THREE.Vector3(e.p[0], e.p[1], e.p[2]), isBoss: e.b === 1, tier: e.t, killerId: this.toLocal(e.k),
        });
        // Shared XP like the host's progression (every kill counts for everyone).
        ctx.progression?.addXp(Math.round((e.b === 1 ? XP.boss : XP.mob) * this.xpMult()));
        break;
      }
      case 'ea': {
        const enemy = this.mirror.get(e.i);
        if (enemy) ev.emit('enemy:attack', { enemy, kind: e.k });
        break;
      }
      case 'dd':
        ev.emit('damage:dealt', {
          enemyId: e.i, playerId: this.localId, amount: e.a, crit: e.c === 1, element: dec.element(e.el),
          point: new THREE.Vector3(e.p[0], e.p[1], e.p[2]), killed: e.kl === 1,
        });
        break;
      case 'ui': ev.emit('ui:message', { text: e.tx, duration: e.d, style: e.st }); break;
      case 'pd': {
        const id = this.toLocal(e.i)!;
        if (id !== this.localId) ev.emit('player:died', { playerId: id });
        break;
      }
      case 'hu': {
        const p = ctx.player;
        this.suppressLocal = true;
        try {
          p.takeDamage(e.a, { element: dec.element(e.el), point: e.f ? new THREE.Vector3(e.f[0], e.f[1], e.f[2]) : undefined });
        } finally {
          this.suppressLocal = false;
        }
        break;
      }
      case 'pk': this.loot.onPickResult(e.i, e.ok === 1, e.w, e.g); break;
      case 'sh': {
        const id = this.toLocal(e.i)!;
        if (id === this.localId) break;
        this.remotes.get(id)?.avatar?.flash();
        const arch = dec.arch(e.a);
        this.replaying = true;
        try {
          ev.emit('weapon:fired', {
            playerId: id,
            weapon: stubWeapon({ archetype: arch, rarity: 'common', element: 'none', color: 0, damage: 0, pellets: 1, spread: 0, range: 0, critMultiplier: 1, elementChance: 0, fireRate: 1 }),
            origin: new THREE.Vector3(e.o[0], e.o[1], e.o[2]),
            direction: new THREE.Vector3(e.d[0], e.d[1], e.d[2]),
            hits: 0,
          });
        } finally {
          this.replaying = false;
        }
        break;
      }
      case 'rv': break;
    }
  }

  // ---- per frame -------------------------------------------------------------------
  update(dt: number): void {
    if (!this.started) return;
    const t = this.clock.renderTime(INTERP_DELAY);
    this.mirror.tick(t, dt);
    for (const rv of this.remotes.values()) {
      const s = rv.buf.sample(t, this.tmpSample);
      if (s && rv.avatar) rv.avatar.update(dt, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch });
    }
    this.tickAcc += dt;
    if (this.tickAcc >= 1 / CLIENT_TICK_HZ) {
      this.tickAcc %= 1 / CLIENT_TICK_HZ;
      this.sendTick();
    }
  }

  /** Build + send the 30 Hz tick (exposed for tests). */
  sendTick(): void {
    if (!this.welcomed) return;
    const p = this.ctx.player;
    const msg: ClientTickMsg = {
      t: 'c',
      n: ++this.seq,
      tm: nowSeconds(),
      p: qv(p.position),
      v: qv(p.velocity),
      y: q2(p.yaw),
      pt: q2(p.pitch),
      g: p.onGround ? 1 : 0,
      u: this.ctx.input?.isDown('KeyE') ? 1 : 0,
      a: p.alive ? 1 : 0,
      mh: Math.round(p.maxHealth),
      ms: Math.round(p.maxShield),
      mm: [q2(effectiveDamageMult(this.ctx)), q2(gearExtras(this.ctx).meleeMult)],
      w: avatarWeaponW(p.activeWeapon),
    };
    if (this.fires.length) msg.f = this.fires.splice(0);
    if (this.pendingHits.length) msg.h = this.pendingHits.splice(0);
    if (this.aoes.length) msg.ao = this.aoes.splice(0);
    if (this.picks.length) msg.pk = this.picks.splice(0);
    if (this.fxUp.length) msg.fx = this.fxUp.splice(0);
    if (this.heal > 0) {
      msg.hl = q1(this.heal);
      this.heal = 0;
    }
    if (this.selfDmg.length) msg.sd = this.selfDmg.splice(0);
    if (this.loadoutDirty) {
      msg.ld = { ...p.loadout };
      this.loadoutDirty = false;
    }
    this.send(msg);
  }

  /** Restore single-player mode. */
  dispose(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const r of this.fxRestore) r();
    this.fxRestore.length = 0;
    for (const rv of this.remotes.values()) rv.avatar?.dispose();
    this.remotes.clear();
    this.mirror.clear();
    this.loot.clear();
    const ctx = this.ctx;
    if (this.origEnemies) ctx.enemies = this.origEnemies;
    if (this.origLoot) ctx.loot = this.origLoot;
    ctx.isHost = this.origIsHost;
    const rs = ctx.rounds?.state as RoundState | undefined;
    if (rs) Object.assign(rs, { phase: 'idle', phaseTime: 0 });
    void this.hostPid;
  }
}
