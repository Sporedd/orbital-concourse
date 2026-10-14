/**
 * Melee bash: hits the nearest enemy within range inside a cone in front of the player.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { Enemy, GameContext } from '@/core/types';
import { gearExtras, getStats, runDamageMult, skillExtras } from './shared';

const HALF_CONE = (30 * Math.PI) / 180; // ~60 degree cone

/** Returns the enemy that was hit (check `.alive` for a kill), or null. */
export function performMelee(
  ctx: GameContext,
  feet: THREE.Vector3,
  yaw: number,
  sourceId: string,
): Enemy | null {
  const enemies = ctx.enemies;
  if (!enemies) return null;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);

  let best: Enemy | null = null;
  let bestReach = Infinity;
  for (const e of enemies.list()) {
    if (!e.alive) continue;
    const dx = e.position.x - feet.x;
    const dz = e.position.z - feet.z;
    const dist = Math.hypot(dx, dz);
    const reach = dist - e.radius;
    if (reach > PLAYER.meleeRange) continue;
    // vertical overlap between player capsule and enemy
    if (e.position.y > feet.y + PLAYER.height + 0.3) continue;
    if (e.position.y + e.height < feet.y - 0.3) continue;
    if (dist > 1e-3) {
      const cos = (dx * fx + dz * fz) / dist;
      const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
      const allowance = Math.atan2(e.radius, dist);
      if (ang - allowance > HALF_CONE) continue;
    }
    if (reach < bestReach) {
      bestReach = reach;
      best = e;
    }
  }
  if (!best) return null;

  // point on the enemy's surface facing the player, around chest height
  const dx = best.position.x - feet.x;
  const dz = best.position.z - feet.z;
  const d = Math.max(1e-3, Math.hypot(dx, dz));
  const r = Math.min(best.radius * 0.8, d);
  const point = new THREE.Vector3(
    best.position.x - (dx / d) * r,
    Math.min(best.position.y + best.height * 0.6, feet.y + PLAYER.eyeHeight - 0.2),
    best.position.z - (dz / d) * r,
  );

  const amount = meleeDamage(ctx);
  best.damage(amount, { point, element: 'none', crit: false, sourceId, applyStatus: false, cause: 'melee' });
  ctx.fx.burst(point, 0xffffff, 12);
  return best;
}

/** One melee hit: base × stats.damageMult × gear meleeMult × skill meleeMult × run modifiers. */
export function meleeDamage(ctx: GameContext): number {
  return PLAYER.meleeDamage * getStats(ctx).damageMult * gearExtras(ctx).meleeMult * skillExtras(ctx).meleeMult * runDamageMult(ctx);
}
