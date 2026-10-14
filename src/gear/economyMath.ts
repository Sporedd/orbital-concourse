/**
 * Economy formulas (docs/ECONOMY.md). Pure functions over config ECONOMY: salvage values, the
 * round bounty, shop prices + reroll fee, and the four gear upgrade costs. No state, no DOM.
 *
 *   levelMult(L)      = 1 + 0.15·(L − 1)
 *   salvage(r, L)     = round(10 × rarityMult(r) × levelMult(L))            rarityMult 1/2/4/8/16
 *   bounty(round)     = 25 + 10·round
 *   price(r, L)       = round(40 × rarityMult(r) × levelMult(L))
 *   reroll(tier)      = round(15 × levelMult(tier))
 *   reinforce(r, L)   = round(15 × rarityMult(r) × 1.18^(L − 1))
 *   retune(r, L)      = round(10 × rarityMult(r) × levelMult(L))
 *   augment(r, L)     = round(60 × rarityMult(r) × levelMult(L))
 *   ascend(r, L)      = round(250 × rarityMult(r) × levelMult(L))
 */
import { ECONOMY } from '@/core/config';
import type { Rarity, WeaponDef } from '@/core/types';
import type { GearDef } from './types';

export type UpgradeKind = 'reinforce' | 'retune' | 'augment' | 'ascend';
export const UPGRADE_KINDS: readonly UpgradeKind[] = ['reinforce', 'retune', 'augment', 'ascend'];

const lvl = (level: number) => Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));

export const rarityMult = (r: Rarity) => ECONOMY.rarityMult[r] ?? 1;
export const levelMult = (level: number) => 1 + ECONOMY.levelRate * (lvl(level) - 1);

/** Scrip for salvaging a weapon of this rarity and item level (manual [F] or floor expiry). */
export function salvageValue(rarity: Rarity, level: number): number {
  return Math.round(ECONOMY.salvageBase * rarityMult(rarity) * levelMult(level));
}
export const weaponSalvageValue = (w: Pick<WeaponDef, 'rarity' | 'level'>) => salvageValue(w.rarity, w.level);

/** Scrip bounty paid on round clear. */
export function roundBounty(round: number): number {
  return ECONOMY.bountyBase + ECONOMY.bountyPerRound * Math.max(1, Math.floor(round));
}

/** Shop price of a gear piece. */
export function gearPrice(def: Pick<GearDef, 'rarity' | 'level'>): number {
  return Math.round(ECONOMY.priceBase * rarityMult(def.rarity) * levelMult(def.level));
}

/** Fee to reroll the shop stock at a tier. */
export function rerollFee(tier: number): number {
  return Math.round(ECONOMY.rerollBase * levelMult(tier));
}

/** Scrip cost of one upgrade on a piece, at its current rarity and level. */
export function upgradeCost(kind: UpgradeKind, def: Pick<GearDef, 'rarity' | 'level'>): number {
  const m = rarityMult(def.rarity);
  const L = lvl(def.level);
  switch (kind) {
    case 'reinforce': return Math.round(ECONOMY.reinforceBase * m * Math.pow(ECONOMY.reinforceGrowth, L - 1));
    case 'retune': return Math.round(ECONOMY.retuneBase * m * levelMult(L));
    case 'augment': return Math.round(ECONOMY.augmentBase * m * levelMult(L));
    case 'ascend': return Math.round(ECONOMY.ascendBase * m * levelMult(L));
  }
}

/** Shop tier (gear tier of the stock): best round reached, at least the live round, min 1. */
export const shopTier = (bestRound: number, currentRound = 0) =>
  Math.max(1, Math.floor(Math.max(bestRound || 0, currentRound || 0)));

/** "¤ 1 240" (thin-space grouping, Martian Mono friendly). */
export const fmtScrip = (n: number) => `¤ ${Math.max(0, Math.floor(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
