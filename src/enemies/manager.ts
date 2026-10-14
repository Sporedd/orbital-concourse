/**
 * EnemyManager: owns every enemy and enemy projectile. Implements the EnemyRegistry
 * contract plus the narrow EnemyEnv the enemies use to reach each other.
 */
import * as THREE from 'three';
import type { BossKind, DamageOpts, Enemy, EnemyRegistry, GameContext, MobKind } from '@/core/types';
import type { BaseEnemy } from './base';
import type { EnemyEnv } from './common';
import { ProjectileSystem } from './projectiles';
import { Grunt } from './mobs/grunt';
import { Spitter } from './mobs/spitter';
import { Bomber } from './mobs/bomber';
import type { BossBase } from './bosses/boss';
import { Brute } from './bosses/brute';
import { Summoner } from './bosses/summoner';
import { Artillery } from './bosses/artillery';

export const BOSS_ROTATION: readonly BossKind[] = ['brute', 'summoner', 'artillery'];

/** Mob mix by tier: grunt-heavy early, more spitters/bombers later. */
export function mobWeights(tier: number): Record<MobKind, number> {
  const t = Math.max(0, tier - 1);
  const spitter = Math.min(0.2 + 0.05 * t, 0.35);
  const bomber = Math.min(0.1 + 0.05 * t, 0.3);
  return { grunt: 1 - spitter - bomber, spitter, bomber };
}

const _c = new THREE.Vector3();

export class EnemyManager implements EnemyRegistry, EnemyEnv {
  readonly enemies: BaseEnemy[] = [];
  readonly projectiles: ProjectileSystem;
  /** Sim time scale for enemies + projectiles (Deadeye sets 0.5). update() scales its dt by it. */
  private scale = 1;

  constructor(readonly ctx: GameContext) {
    this.projectiles = new ProjectileSystem(ctx);
  }

  list(): Enemy[] {
    return this.enemies;
  }

  get(id: string): Enemy | undefined {
    for (const e of this.enemies) if (e.id === id) return e;
    return undefined;
  }

  spawnMob(kind: MobKind | 'random', position: THREE.Vector3, tier: number): BaseEnemy {
    const k = kind === 'random' ? this.pickMob(tier) : kind;
    let e: BaseEnemy;
    switch (k) {
      case 'spitter': e = new Spitter(this, position, tier); break;
      case 'bomber': e = new Bomber(this, position, tier); break;
      default: e = new Grunt(this, position, tier); break;
    }
    this.add(e);
    return e;
  }

  spawnBoss(kind: BossKind | 'auto', position: THREE.Vector3, tier: number): BaseEnemy {
    const k = kind === 'auto' ? BOSS_ROTATION[(Math.max(1, Math.floor(tier) || 1) - 1) % BOSS_ROTATION.length] : kind;
    let b: BossBase;
    switch (k) {
      case 'summoner': b = new Summoner(this, position, tier); break;
      case 'artillery': b = new Artillery(this, position, tier); break;
      default: b = new Brute(this, position, tier); break;
    }
    this.add(b);
    this.ctx.events.emit('boss:spawned', { enemy: b, name: b.bossName });
    b.emitHealth();
    return b;
  }

  damageRadius(center: THREE.Vector3, radius: number, amount: number, opts?: DamageOpts): number {
    if (!(radius > 0) || !(amount > 0)) return 0;
    let n = 0;
    const list = this.enemies;
    const len = list.length;
    for (let i = 0; i < len; i++) {
      const e = list[i];
      if (!e.state.alive || (opts?.excludeId && e.id === opts.excludeId)) continue;
      const p = e.position;
      const cy = Math.min(Math.max(center.y, p.y), p.y + e.height);
      const dx = p.x - center.x;
      const dy = cy - center.y;
      const dz = p.z - center.z;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - e.radius);
      if (d > radius) continue;
      const f = 1 - 0.75 * (d / radius);
      e.centerPoint(_c);
      e.damage(amount * f, { ...opts, point: _c.clone() });
      n++;
    }
    return n;
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.state.alive) n++;
    return n;
  }

  bossAlive(): boolean {
    for (const e of this.enemies) if (e.isBoss && e.state.alive) return true;
    return false;
  }

  clear(): void {
    for (const e of this.enemies) this.removeObjects(e);
    this.enemies.length = 0;
    this.projectiles.clear();
    this.scale = 1;
  }

  get timeScale(): number {
    return this.scale;
  }

  setTimeScale(scale: number): void {
    this.scale = Number.isFinite(scale) ? Math.max(0, Math.min(4, scale)) : 1;
  }

  update(dt: number): void {
    dt *= this.scale;
    const list = this.enemies;
    // index loop: summoners may append grunts mid-update (they update this frame too)
    for (let i = 0; i < list.length; i++) list[i].update(dt);
    this.projectiles.update(dt);
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removable) this.removeObjects(e);
      else list[w++] = e;
    }
    list.length = w;
  }

  // ---- internals -----------------------------------------------------------------
  private add(e: BaseEnemy): void {
    // Sponsor contract (system I): × max health for mobs and bosses. spawnBoss emits the
    // boss bar after add(), so it shows the scaled value.
    const hm = this.ctx.standing?.sponsors.active.enemyHealthMult ?? 1;
    if (hm !== 1 && hm > 0) {
      e.state.maxHealth = Math.round(e.state.maxHealth * hm);
      e.state.health = e.state.maxHealth;
    }
    this.enemies.push(e);
    this.ctx.scene.add(e.object);
    for (const x of e.extras) this.ctx.scene.add(x);
    this.ctx.events.emit('enemy:spawned', { enemy: e });
  }

  private removeObjects(e: BaseEnemy): void {
    this.ctx.scene.remove(e.object);
    for (const x of e.extras) this.ctx.scene.remove(x);
    e.dispose();
  }

  private pickMob(tier: number): MobKind {
    const w = mobWeights(tier);
    const r = this.ctx.rng();
    if (r < w.spitter) return 'spitter';
    if (r < w.spitter + w.bomber) return 'bomber';
    return 'grunt';
  }
}
