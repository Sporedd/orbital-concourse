/**
 * Shop stock (PLAN §13, docs/ECONOMY.md): a rotating stock of ECONOMY.stockMin..stockMax gear
 * pieces generated with the gear generator at the player's tier, with rarity weights gated by
 * the standing league. Pure + rng-only (the economy system owns the state, fees and storage).
 *
 *   tier         = max(1, best round reached, live round)              (economyMath.shopTier)
 *   rarity cap   = SHOP_RARITY_CAP[leagueIndex]  Scrap: rare · Iron/Steel: epic · Star+: legendary
 *   rarity boost = 0.08 · leagueIndex on top of rarityWeights(tier)
 *   stock        = one piece per slot (helm, chest, boots, gloves, trinket), then random slots
 */
import { ECONOMY } from '@/core/config';
import { RARITY_ORDER, type Rarity } from '@/core/types';
import { randInt } from '@/core/rng';
import { rarityWeights } from '@/loot/weapons';
import { generateGear } from './generator';
import { sanitizeGear, type GearStorage } from './inventory';
import { GEAR_SLOTS, type GearDef, type GearSlot } from './types';

type Rng = () => number;

export const SHOP_STORAGE_KEY = 'concourse.shop.v1';
const VERSION = 1;

/** Highest rarity the shop stocks per league index (0 Scrap … 4 Void). */
export const SHOP_RARITY_CAP: readonly Rarity[] = ['rare', 'epic', 'epic', 'legendary', 'legendary'];
export const SHOP_LEAGUE_BOOST = 0.08;

export const shopRarityCap = (leagueIndex: number): Rarity =>
  SHOP_RARITY_CAP[Math.max(0, Math.min(SHOP_RARITY_CAP.length - 1, Math.floor(leagueIndex || 0)))];

/** Rarity weights the shop rolls with (zero above the league cap). */
export function shopRarityWeights(tier: number, leagueIndex: number): Record<Rarity, number> {
  const w = rarityWeights(tier, SHOP_LEAGUE_BOOST * Math.max(0, leagueIndex));
  const cap = RARITY_ORDER.indexOf(shopRarityCap(leagueIndex));
  for (let i = cap + 1; i < RARITY_ORDER.length; i++) w[RARITY_ORDER[i]] = 0;
  return w;
}

export function rollShopRarity(rng: Rng, tier: number, leagueIndex: number): Rarity {
  const w = shopRarityWeights(tier, leagueIndex);
  let r = rng() * RARITY_ORDER.reduce((s, k) => s + w[k], 0);
  for (const k of RARITY_ORDER) {
    r -= w[k];
    if (w[k] > 0 && r <= 0) return k;
  }
  return 'common';
}

export function generateStock(rng: Rng, nextId: (p: string) => string, tier: number, leagueIndex: number): GearDef[] {
  const n = randInt(rng, ECONOMY.stockMin, ECONOMY.stockMax);
  const out: GearDef[] = [];
  for (let i = 0; i < n; i++) {
    const slot: GearSlot = i < GEAR_SLOTS.length ? GEAR_SLOTS[i] : GEAR_SLOTS[Math.floor(rng() * GEAR_SLOTS.length)];
    out.push(generateGear(rng, nextId, tier, { slot, rarity: rollShopRarity(rng, tier, leagueIndex) }));
  }
  return out;
}

// ---- persistence -------------------------------------------------------------------------------
export interface ShopSave {
  tier: number;
  stock: GearDef[];
}

export function saveShop(storage: GearStorage | null, data: ShopSave, key = SHOP_STORAGE_KEY): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ v: VERSION, ...data }));
  } catch {
    /* not persisted */
  }
}

/** Load a saved stock (sanitized, fresh ids via reId). Null when absent or unusable. */
export function loadShop(storage: GearStorage | null, reId?: (p: string) => string, key = SHOP_STORAGE_KEY): ShopSave | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as { v?: number; tier?: unknown; stock?: unknown };
    if (!d || d.v !== VERSION || !Array.isArray(d.stock)) return null;
    const stock: GearDef[] = [];
    for (const r of d.stock.slice(0, ECONOMY.stockMax)) {
      const g = sanitizeGear(r);
      if (!g) continue;
      if (reId) g.id = reId('g');
      stock.push(g);
    }
    return {
      tier: Math.max(1, Math.floor(Number(d.tier) || 1)),
      stock,
    };
  } catch {
    return null;
  }
}
