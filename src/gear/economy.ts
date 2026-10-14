/**
 * Economy system (PLAN §13, docs/ECONOMY.md), registered as ctx.economy in main.ts after gear:
 *  - scrip wallet of the LOCAL peer ('concourse.wallet.v1'), bridged to 'wallet:changed'
 *  - salvage: a local weapon that expires on the floor pays its salvage value; [F] on a weapon
 *    pickup prompt salvages it by hand (removes it from the floor, emits 'loot:salvaged')
 *  - round-clear bounty (25 + 10·round) on 'round:cleared'
 *  - shop stock (./shop): persists ('concourse.shop.v1') until rerolled (fee) or the round is
 *    cleared (free restock); buying equips into an empty slot, else the backpack
 *  - gear upgrades (./upgrades): reinforce / retune / augment / ascend for scrip
 *
 * Every action is local to this peer (co-op: each player has their own wallet, shop and gear).
 */
import type { WalletReason } from '@/core/events';
import type { GameContext, LootItemState } from '@/core/types';
import { readBestRound } from '@/progression';
import {
  UPGRADE_KINDS, gearPrice, rerollFee, roundBounty, shopTier, upgradeCost, weaponSalvageValue, type UpgradeKind,
} from './economyMath';
import type { GearSystem } from './index';
import type { GearStorage } from './inventory';
import { generateStock, loadShop, saveShop, shopRarityCap } from './shop';
import type { GearDef } from './types';
import { applyUpgrade, upgradeBlocker } from './upgrades';
import { Wallet } from './wallet';

export type BuyResult = 'ok' | 'poor' | 'full' | 'missing';
export type UpgradeOutcome = { ok: true; item: GearDef; cost: number } | { ok: false; reason: string };

export interface EconomySystem {
  readonly wallet: Wallet;
  readonly scrip: number;
  /** Current shop stock (generated lazily on first read). */
  readonly stock: readonly GearDef[];
  /** Tier the current stock was generated at. */
  readonly stockTier: number;
  /** Tier the next restock will use. */
  shopTier(): number;
  /** Standing league index (0 Scrap … 4 Void) and the rarity cap it allows in the shop. */
  leagueIndex(): number;
  rarityCap(): GearDef['rarity'];
  price(def: GearDef): number;
  rerollCost(): number;
  reroll(): boolean;
  /** New stock at the current tier, no fee. */
  restock(): void;
  buy(stockId: string): BuyResult;
  upgradeCost(kind: UpgradeKind, def: GearDef): number;
  /** Why the upgrade cannot be bought right now (cap or scrip), or null. */
  upgradeBlocker(kind: UpgradeKind, def: GearDef): string | null;
  upgrade(kind: UpgradeKind, itemId: string, index?: number): UpgradeOutcome;
  /** The weapon pickup currently in reach of the local player (for the [F] SALVAGE prompt). */
  readonly nearbyWeapon: LootItemState | null;
  salvageValue(item: LootItemState): number;
  /** Salvage a local weapon on the floor by hand. Returns the scrip paid (0 = nothing done). */
  salvage(item: LootItemState): number;
  update(dt: number): void;
}

export interface EconomyOptions {
  storage?: GearStorage | null;
  /** Best round reached (default: progression save). */
  bestRound?: () => number;
}

function defaultStorage(): GearStorage | null {
  try {
    return (globalThis as { localStorage?: GearStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function createEconomy(ctx: GameContext, gear: GearSystem, opts: EconomyOptions = {}): EconomySystem {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const wallet = new Wallet(storage);
  wallet.load();
  wallet.onChange((scrip, delta, reason: WalletReason) => {
    if (reason === 'load') return;
    ctx.events.emit('wallet:changed', { scrip, delta, reason });
  });

  const bestRound = opts.bestRound ?? readBestRound;
  const localId = () => (ctx.player ? ctx.player.id : 'p1');
  const leagueIndex = () => Math.max(0, ctx.standing?.standing.rank.leagueIndex ?? 0);
  const tierNow = () => shopTier(bestRound(), ctx.rounds?.state.round ?? 0);

  // ---- shop stock ------------------------------------------------------------------------------
  let stock: GearDef[] = [];
  let stockTier = 1;
  let stocked = false;
  const saved = loadShop(storage, ctx.nextId);
  if (saved && saved.stock.length) {
    stock = saved.stock;
    stockTier = saved.tier;
    stocked = true;
  }
  const persistShop = () => saveShop(storage, { tier: stockTier, stock });

  function restock(): void {
    stockTier = tierNow();
    stock = generateStock(ctx.rng, ctx.nextId, stockTier, leagueIndex());
    stocked = true;
    persistShop();
  }
  const ensureStock = () => {
    if (!stocked) restock();
  };

  function buy(id: string): BuyResult {
    ensureStock();
    const item = stock.find((d) => d.id === id);
    if (!item) return 'missing';
    if (!gear.canPickUp(item)) {
      ctx.events.emit('ui:message', { text: 'Backpack full: make room first [I]', duration: 2.5, style: 'warning' });
      return 'full';
    }
    if (!wallet.spend(gearPrice(item), 'purchase')) return 'poor';
    stock = stock.filter((d) => d !== item);
    persistShop();
    gear.pickUp(item);
    return 'ok';
  }

  function reroll(): boolean {
    if (!wallet.spend(rerollFee(tierNow()), 'reroll')) return false;
    restock();
    return true;
  }

  // ---- upgrades --------------------------------------------------------------------------------
  function blocker(kind: UpgradeKind, def: GearDef): string | null {
    return upgradeBlocker(kind, def) ?? (wallet.canAfford(upgradeCost(kind, def)) ? null : 'NOT ENOUGH SCRIP');
  }

  function upgrade(kind: UpgradeKind, itemId: string, index = 0): UpgradeOutcome {
    if (!UPGRADE_KINDS.includes(kind)) return { ok: false, reason: 'UNKNOWN UPGRADE' };
    const found = gear.inventory.find(itemId);
    if (!found) return { ok: false, reason: 'NOT OWNED' };
    const why = blocker(kind, found.item);
    if (why) return { ok: false, reason: why };
    const cost = upgradeCost(kind, found.item);
    const res = applyUpgrade(kind, found.item, ctx.rng, index);
    if (!res.ok) return res;
    if (!wallet.spend(cost, 'upgrade')) return { ok: false, reason: 'NOT ENOUGH SCRIP' };
    gear.inventory.replace(res.item); // → gear:changed (stats, paper doll, avatar)
    return { ok: true, item: res.item, cost };
  }

  // ---- salvage + bounty ------------------------------------------------------------------------
  let nearby: LootItemState | null = null;
  const salvageValue = (item: LootItemState) => (item.kind === 'weapon' && item.weapon ? weaponSalvageValue(item.weapon) : 0);

  function pay(item: LootItemState, manual: boolean): number {
    const value = salvageValue(item);
    if (value <= 0 || !item.weapon) return 0;
    wallet.add(value, manual ? 'salvage' : 'expired');
    ctx.events.emit('loot:salvaged', { playerId: localId(), itemId: item.id, weapon: item.weapon, value, manual });
    return value;
  }

  function salvage(item: LootItemState): number {
    if (item.kind !== 'weapon' || !item.weapon || item.ownerId !== localId()) return 0;
    if (!ctx.loot.remove(item.id)) return 0;
    if (nearby?.id === item.id) {
      nearby = null;
      ctx.events.emit('loot:nearby', { playerId: localId(), item: null });
    }
    ctx.audio?.play('pickup', { volume: 0.7, pitch: 0.8 });
    return pay(item, true);
  }

  ctx.events.on('loot:nearby', (e) => {
    if (e.playerId !== localId()) return;
    nearby = e.item && e.item.kind === 'weapon' && e.item.weapon ? e.item : null;
  });
  ctx.events.on('loot:expired', (e) => {
    const it = e.item;
    if (!it || it.kind !== 'weapon' || it.ownerId !== localId()) return;
    if (nearby?.id === it.id) nearby = null;
    pay(it, false);
  });
  ctx.events.on('round:cleared', (e) => {
    wallet.add(roundBounty(e.round), 'bounty');
    restock(); // the pit stop brings fresh stock for free
  });

  function update(): void {
    if (nearby && ctx.player?.alive && ctx.input.justPressed('KeyF')) salvage(nearby);
  }

  return {
    wallet,
    get scrip() { return wallet.scrip; },
    get stock() { ensureStock(); return stock; },
    get stockTier() { return stockTier; },
    shopTier: tierNow,
    leagueIndex,
    rarityCap: () => shopRarityCap(leagueIndex()),
    price: gearPrice,
    rerollCost: () => rerollFee(tierNow()),
    reroll,
    restock,
    buy,
    upgradeCost,
    upgradeBlocker: blocker,
    upgrade,
    get nearbyWeapon() { return nearby; },
    salvageValue,
    salvage,
    update,
  };
}
