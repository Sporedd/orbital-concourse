/**
 * System C — enemies + bosses.
 * Mobs: Grunt (melee rusher), Spitter (ranged), Bomber (suicide runner).
 * Bosses: Brute (charge + slam), Summoner (grunts, orbs, shields), Artillery (mortars, weak point).
 */
import type { GameContext } from '@/core/types';
import { EnemyManager } from './manager';

export { EnemyManager, BOSS_ROTATION, mobWeights } from './manager';
export type { BaseEnemy, EnemySimState } from './base';

export function createEnemyManager(ctx: GameContext): EnemyManager {
  return new EnemyManager(ctx);
}
