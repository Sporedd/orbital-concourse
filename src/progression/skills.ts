/**
 * Data-driven skill tree. Adding a node = adding one entry to SKILLS.
 * `value` is the human-readable per-rank amount substituted for {value} in descriptions.
 */
import type { PlayerStats, SkillNode } from '@/core/types';

export interface SkillDef extends SkillNode {
  /** Per-rank amount for {value} in the description, e.g. "8%". */
  value: string;
}

export const BRANCHES: { id: string; name: string; color: number }[] = [
  { id: 'gunplay', name: 'Gunplay', color: 0xff7a2f },
  { id: 'survival', name: 'Survival', color: 0x3fd0ff },
  { id: 'mobility', name: 'Mobility', color: 0x7dff6a },
];

/** Multiplicative-additive stat node: stats[key] *= 1 + sign·perRank·rank. */
function statNode(
  id: string, name: string, branch: string, key: keyof PlayerStats,
  perRank: number, description: string, maxRank = 5, requires?: string,
): SkillDef {
  return {
    id, name, branch, maxRank, requires, description,
    value: `${Math.round(Math.abs(perRank) * 100)}%`,
    apply(stats, rank) {
      stats[key] *= 1 + perRank * rank;
    },
  };
}

export const SKILLS: SkillDef[] = [
  statNode('damage', 'Deadeye', 'gunplay', 'damageMult', 0.08, '+{value} gun damage per rank'),
  statNode('fire_rate', 'Trigger Happy', 'gunplay', 'fireRateMult', 0.06, '+{value} fire rate per rank'),
  statNode('reload', 'Quick Hands', 'gunplay', 'reloadMult', -0.06, '-{value} reload time per rank'),
  statNode('shield', 'Bulwark', 'survival', 'shieldMult', 0.1, '+{value} shield capacity per rank'),
  statNode('speed', 'Fleet Foot', 'mobility', 'moveSpeedMult', 0.04, '+{value} movement speed per rank'),
];

export const baseStats = (): PlayerStats => ({
  damageMult: 1, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1,
});

export function describeSkill(node: SkillNode): string {
  const def = SKILLS.find((s) => s.id === node.id);
  return node.description.replace('{value}', def ? def.value : '');
}
