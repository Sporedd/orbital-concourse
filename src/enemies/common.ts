/**
 * Shared helpers for the enemy system: the internal environment the enemies talk to,
 * angle math, player-damage helpers and camera shake by distance.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { DamageOpts, Element, GameContext, MobKind, PlayerState } from '@/core/types';
import type { BaseEnemy } from './base';
import type { ProjectileSystem } from './projectiles';

/** What an individual enemy can reach: the context plus a narrow slice of the manager. */
export interface EnemyEnv {
  readonly ctx: GameContext;
  readonly enemies: readonly BaseEnemy[];
  readonly projectiles: ProjectileSystem;
  spawnMob(kind: MobKind, position: THREE.Vector3, tier: number): BaseEnemy;
  damageRadius(center: THREE.Vector3, radius: number, amount: number, opts?: DamageOpts): number;
  aliveCount(): number;
}

export const TAU = Math.PI * 2;

/** Assign to Object3D.raycast to make an object invisible to hitscan. */
export const noRaycast = (): void => {};

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/** Rotate `cur` towards `target` by at most `maxStep` radians. */
export function turnTowards(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

/** Distance from a point to the surface of a player's capsule (negative when inside). */
export function playerCapsuleDistance(p: PlayerState, point: THREE.Vector3): number {
  const f = p.position;
  const r = PLAYER.radius;
  const cy = clamp(point.y, f.y + r, f.y + PLAYER.height - r);
  const dx = point.x - f.x;
  const dy = point.y - cy;
  const dz = point.z - f.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Damage one player, attributing it to an enemy. */
export function hitPlayer(p: PlayerState, amount: number, sourceId: string, from: THREE.Vector3, element: Element = 'none'): void {
  if (!p.alive || !(amount > 0)) return;
  p.takeDamage(amount, { element, sourceId, point: from.clone() });
}

/** Area damage to players with linear falloff to 25 % at the edge. Returns players hit. */
export function hurtPlayersInRadius(
  ctx: GameContext, center: THREE.Vector3, radius: number, amount: number, sourceId: string, element: Element = 'none',
): number {
  let n = 0;
  for (const p of ctx.players.list()) {
    if (!p.alive) continue;
    const d = Math.max(0, playerCapsuleDistance(p, center));
    if (d > radius) continue;
    const f = 1 - 0.75 * (d / radius);
    p.takeDamage(amount * f, { element, sourceId, point: center.clone() });
    n++;
  }
  return n;
}

/** Camera shake on the local player, scaled down with distance. */
export function shakeFrom(ctx: GameContext, center: THREE.Vector3, amount: number, range: number): void {
  const lp = ctx.players.local;
  if (!lp) return;
  const d = lp.position.distanceTo(center);
  if (d >= range) return;
  ctx.fx.shake(clamp(amount * (1 - d / range), 0, 1));
}
