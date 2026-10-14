/**
 * Class definitions (docs/SKILL_TREE.md §2). A class is chosen once per profile (changeable, free
 * for now). It sets a small base-stat identity, a starter weapon archetype and one active ability.
 */
import type { PlayerStats, WeaponArchetype } from '@/core/types';

export type ClassId = 'vanguard' | 'marksman' | 'technician' | 'showman';
export const CLASS_IDS: readonly ClassId[] = ['vanguard', 'marksman', 'technician', 'showman'];
/** The shared tree's pseudo class id. */
export const PIT = 'pit' as const;
export type TreeId = ClassId | typeof PIT;

export interface ActiveAbilityDef {
  id: string;
  name: string;
  /** Key the player code binds (docs §5.1 player:activeKey). */
  key: string;
  /** Seconds, before skill cooldown reductions. */
  cooldown: number;
  /** Seconds the effect window lasts (0 = instant). */
  duration: number;
  description: string;
  /** Player hook(s) the full effect needs; the live part runs in effects.ts useActive(). */
  hook: string;
  /** True when the whole effect works once the key is bound (no extra player code). */
  liveEffect: boolean;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  /** One-word role tag for the card. */
  tag: string;
  blurb: string;
  /** Multiplicative identity, applied like a stat node: stats[k] *= 1 + v. */
  identity: Partial<Record<keyof PlayerStats, number>>;
  /** Extra identity lines shown on the card (non-PlayerStats parts). */
  identityText: string[];
  /** Hype gain bonus fraction (Showman). */
  hypeBonus?: number;
  starterArchetype: WeaponArchetype;
  /** Branch display names, A / B / C. */
  branches: [string, string, string];
  active: ActiveAbilityDef;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    tag: 'THE WALL',
    blurb: 'The wall the crowd paid to see break. Shields, health and melee finishers.',
    identity: { shieldMult: 0.2, healthMult: 0.1 },
    identityText: ['+20% shield capacity', '+10% max health'],
    starterArchetype: 'shotgun',
    branches: ['Bulwark', 'Brawler', 'Champion'],
    active: {
      id: 'shield_bash',
      name: 'Shield Bash',
      key: 'Q',
      cooldown: 12,
      duration: 1,
      description: 'Dash 6 m along your view. Enemies in the path take 150% melee damage and are knocked back. 1 s invulnerability.',
      hook: 'player:shieldBash',
      liveEffect: false,
    },
  },
  marksman: {
    id: 'marksman',
    name: 'Marksman',
    tag: 'THE EYE',
    blurb: 'The quiet one in the loud arena. Crits, patience, pistols and snipers.',
    identity: { critMult: 0.2 },
    identityText: ['+20% crit damage'],
    starterArchetype: 'pistol',
    branches: ['Precision', 'Long Game', 'Hunter'],
    active: {
      id: 'deadeye',
      name: 'Deadeye',
      key: 'Q',
      cooldown: 25,
      duration: 5,
      description: 'For 5 s time slows to 50% for everything but you, and every bullet crits.',
      hook: 'player:deadeye',
      liveEffect: false,
    },
  },
  technician: {
    id: 'technician',
    name: 'Technician',
    tag: 'THE RIG',
    blurb: 'Brought a toolbox to a gunfight. Elements, grenades and salvage.',
    identity: { reloadMult: -0.1, fireRateMult: 0.05 },
    identityText: ['−10% reload time', '+5% fire rate'],
    starterArchetype: 'rifle',
    branches: ['Elementalist', 'Demolitions', 'Salvage'],
    active: {
      id: 'shock_pulse',
      name: 'Shock Pulse',
      key: 'Q',
      cooldown: 14,
      duration: 0,
      description: '8 m shock nova for (80 + 20 × round) × gun damage. Shocks everything hit and restores 25% shield.',
      hook: 'player:activeKey',
      liveEffect: true,
    },
  },
  showman: {
    id: 'showman',
    name: 'Showman',
    tag: 'THE STAR',
    blurb: 'Plays to the stands. Hype, mobility, SMGs and shotguns up close, and loot luck.',
    identity: { moveSpeedMult: 0.08 },
    identityText: ['+8% move speed', '+10% hype gains'],
    hypeBonus: 0.1,
    starterArchetype: 'smg',
    branches: ['Spectacle', 'Knife-Edge', 'Luck'],
    active: {
      id: 'encore',
      name: 'Encore',
      key: 'Q',
      cooldown: 30,
      duration: 8,
      description: 'Refills your magazine and adds a reserve load. For 8 s: double hype gains and +20% fire rate.',
      hook: 'player:activeKey',
      liveEffect: true,
    },
  },
};

export const CLASS_LIST: readonly ClassDef[] = CLASS_IDS.map((id) => CLASSES[id]);

export const isClassId = (v: unknown): v is ClassId => typeof v === 'string' && (CLASS_IDS as readonly string[]).includes(v);
