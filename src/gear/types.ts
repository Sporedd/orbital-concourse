/**
 * System G — gear contracts (local to src/gear until the lead lifts the pieces it needs into
 * src/core/types.ts, see INTEGRATION.md). Plain serializable data only.
 */
import type { Element, PlayerStats, Rarity } from '@/core/types';

export type GearSlot = 'helm' | 'chest' | 'boots' | 'gloves' | 'trinket';
export const GEAR_SLOTS: readonly GearSlot[] = ['helm', 'chest', 'boots', 'gloves', 'trinket'];
export const GEAR_SLOT_LABEL: Record<GearSlot, string> = {
  helm: 'Helm', chest: 'Chest', boots: 'Boots', gloves: 'Gloves', trinket: 'Trinket',
};

/** Stats that do not exist in PlayerStats and need gameplay hooks (see INTEGRATION.md). */
export type ExtraGearStat =
  | 'grenades' // +N max grenades (integer)
  | 'shieldRegen' // +x shield recharge rate (fraction)
  | 'elementalResist' // x less damage from elemental sources (fraction)
  | 'meleeMult' // +x melee damage (fraction)
  | 'elementChance'; // +x added to WeaponDef.elementChance (fraction)

export type GearStat = keyof PlayerStats | ExtraGearStat;

export interface GearAffix {
  /** Stable id of the affix type, e.g. 'aff_damageMult'. */
  id: string;
  /** Short label, e.g. "Gun Damage". */
  name: string;
  stat: GearStat;
  /**
   * Fractions for every stat (0.06 = +6 %), except `grenades` (integer count).
   * reloadMult is a *reduction* (0.06 = 6 % faster reload).
   */
  value: number;
  /** Human readable, e.g. "+6.2% gun damage". */
  description: string;
}

export type GearSetId = 'voidrunner' | 'bulwark' | 'pitfighter';
export type League = 'scrap' | 'iron' | 'steel' | 'star' | 'void';

export interface GearDef {
  id: string;
  name: string; // "Iron Greaves of Haste", "★ Voidrunner Visor of Seven Suns"
  slot: GearSlot;
  rarity: Rarity;
  /** Elemental pieces tint their glow and can roll the elementChance affix. */
  element?: Exclude<Element, 'none'>;
  /** Tier (round) it dropped at. */
  tier: number;
  /** Item level = tier + rarity bonus (common 0, uncommon 1, rare 2, epic 3, legendary 5). */
  level: number;
  /** Base stat every piece carries (commons have only this). */
  implicit: GearAffix;
  /** Rolled affixes: common 0, uncommon 1, rare 2, epic 3, legendary 4. */
  affixes: GearAffix[];
  setId?: GearSetId;
  /** League band of the item level (drives the material word in the name). */
  league: League;
  /** Body colour (steel tinted by rarity). */
  color: number;
  /** Glow colour (element or rarity). */
  accent: number;
  /** 0..1 derived from level; drives the parametric model. */
  growth: number;
  /** Per-item seed for cosmetic model variation (models never consume ctx.rng). */
  seed: number;
}

export type Loadout = Partial<Record<GearSlot, GearDef>>;

export interface SetBonus {
  pieces: 2 | 3;
  description: string;
  /** Additive contributions, same units as affix values. Implemented by computeLoadoutStats. */
  stats?: Partial<Record<GearStat, number>>;
  /** Gameplay hook id that needs code outside src/gear (documented in INTEGRATION.md). */
  hook?: string;
}

export interface GearSetDef {
  id: GearSetId;
  name: string;
  slots: readonly GearSlot[];
  bonuses: readonly SetBonus[];
}

export interface ActiveSet {
  setId: GearSetId;
  name: string;
  pieces: number;
  active: SetBonus[];
}

/** Result of computeLoadoutStats(). */
export interface GearStats {
  /** Multipliers to multiply into progression stats (mergeStats). */
  stats: PlayerStats;
  /** Extra max grenades (integer). */
  extraGrenades: number;
  /** Multiplier on the shield recharge rate. */
  shieldRegenMult: number;
  /** 0..cap fraction of elemental damage ignored. */
  elementalResist: number;
  /** Multiplier on melee damage. */
  meleeMult: number;
  /** Added to the weapon's elementChance on hit. */
  elementChanceBonus: number;
  /** Raw additive totals per stat (after caps), for tooltips. */
  totals: Record<GearStat, number>;
  sets: ActiveSet[];
  /** Gameplay hook ids that are active (e.g. 'voidrunner_dash'). */
  hooks: string[];
  /** Sum of the equipped pieces' gear scores. */
  score: number;
}
