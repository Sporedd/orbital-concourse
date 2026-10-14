/**
 * Shared boss behaviour: named, weak-point crits, boss:health on every hit and
 * phase changes at 66 % / 33 % health (boss:phase).
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { BaseEnemy, type EnemyConfig, type EnemySimState } from '../base';
import type { Rig } from '../models';

const _w = new THREE.Vector3();
export const PHASE_THRESHOLDS = [0.66, 0.33] as const;

export abstract class BossBase<S extends EnemySimState = EnemySimState> extends BaseEnemy<S> {
  abstract readonly bossName: string;
  protected readonly weakObj: THREE.Object3D;
  protected readonly weakRadius: number;

  constructor(
    env: EnemyEnv, cfg: EnemyConfig, rig: Rig, pos: THREE.Vector3, tier: number,
    extra: Omit<S, keyof EnemySimState>, weakRadius: number,
  ) {
    super(env, cfg, rig, pos, tier, extra);
    this.weakObj = rig.parts.weak ?? rig.head ?? rig.body;
    this.weakRadius = weakRadius;
  }

  /** True while any hit should count as a crit (e.g. brute stunned after a wall hit). */
  protected critAnywhere(): boolean {
    return false;
  }

  isCritPoint(point: THREE.Vector3): boolean {
    const s = this.state;
    if (!s.alive) return false;
    if (s.frozen > 0 || this.critAnywhere()) return true;
    this.weakObj.getWorldPosition(_w);
    return _w.distanceToSquared(point) <= this.weakRadius * this.weakRadius;
  }

  /** World position of the weak point (for fx). */
  weakPoint(out: THREE.Vector3): THREE.Vector3 {
    return this.weakObj.getWorldPosition(out);
  }

  emitHealth(): void {
    const s = this.state;
    this.env.ctx.events.emit('boss:health', {
      enemyId: this.id, health: Math.max(0, s.health), maxHealth: s.maxHealth, phase: s.phase,
    });
  }

  protected afterDamage(_amount: number): void {
    const s = this.state;
    const frac = s.health / s.maxHealth;
    let target = 0;
    if (frac <= PHASE_THRESHOLDS[0]) target = 1;
    if (frac <= PHASE_THRESHOLDS[1]) target = 2;
    while (s.phase < target && s.health > 0) {
      s.phase++;
      this.env.ctx.events.emit('boss:phase', { enemyId: this.id, phase: s.phase });
      this.onPhase(s.phase);
    }
    this.emitHealth();
  }

  protected onPhase(_phase: number): void {}

  /** Pick a value by phase (0, 1, 2). */
  protected byPhase<T>(values: readonly [T, T, T]): T {
    return values[Math.min(2, Math.max(0, this.state.phase))];
  }
}
