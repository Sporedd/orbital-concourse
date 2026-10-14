/**
 * System G — gear (milestone M4). Public surface + the runtime facade registered as ctx.gear
 * in main.ts (right after progression). Persists the inventory in 'concourse.gear.v1'; gear is
 * kept across runs like the skill tree.
 */
import type { GameContext, PlayerStats } from '@/core/types';
import { computeLoadoutStats, generateGear, mergeStats, neutralStats, type GenerateGearOpts } from './generator';
import { createInventory, type Inventory } from './inventory';
import type { GearDef, GearStats } from './types';

export * from './types';
export * from './generator';
export {
  buildGearModel, buildGloveViewmodel, disposeGearSharedResources, gearModelParams, countMeshes, GearModel,
  helmParams, chestParams, bootParams, gloveParams, trinketParams, STEP_RIBS, STEP_FINS, STEP_MASTS,
} from './models';
export type { GearModelParams, HelmParams, ChestParams, BootParams, GloveParams, TrinketParams } from './models';
export { createPaperDoll, type PaperDoll, type PaperDollOptions } from './paperDoll';
export {
  BACKPACK_CAPACITY, GEAR_STORAGE_KEY, LEGACY_GEAR_STORAGE_KEY, Emitter, Inventory, compareGear, createInventory, pieceTotals, sanitizeGear,
} from './inventory';
export type { GearComparison, GearCompareLine, GearStorage, InventoryEvents } from './inventory';
export { applyWeaponGrowth, weaponGrowthParams, type WeaponGrowthParams } from './weaponGrowth';
export { createInventoryScreen, type InventoryScreen, type InventoryScreenOptions } from './inventoryScreen';
export * as gearPalette from './palette';

export interface GearSystem {
  readonly inventory: Inventory;
  /** Current loadout stats (multipliers + extras + sets + hooks). */
  readonly gearStats: GearStats;
  /** progression stats × gear stats; returns a reused object (do not keep a reference across frames). */
  mergedStats(base: PlayerStats): PlayerStats;
  generate(tier: number, opts?: GenerateGearOpts): GearDef;
  /** Pickup policy for the loot system: true if the piece has somewhere to go. */
  canPickUp(item: GearDef): boolean;
  pickUp(item: GearDef): 'equipped' | 'backpack' | 'full' | 'duplicate';
  /** Max grenades including gear bonuses. */
  maxGrenades(base: number): number;
}

export function createGearSystem(ctx: GameContext, opts: { persist?: boolean } = {}): GearSystem {
  const persist = opts.persist ?? true;
  const inventory = createInventory();
  const merged = neutralStats();
  if (persist) inventory.load(undefined, ctx.nextId);

  inventory.events.on('gear:changed', (e) => {
    if (persist) inventory.save();
    // Bridge onto the game bus (the inventory's other events stay local).
    ctx.events.emit('gear:changed', {
      playerId: ctx.player ? ctx.player.id : 'p1',
      stats: e.stats,
      loadout: e.loadout,
    });
  });
  inventory.events.on('gear:full', (e) => {
    ctx.events.emit('ui:message', { text: `Backpack full: ${e.item.name}`, duration: 2.5, style: 'warning' });
  });

  function pickUp(item: GearDef) {
    const where = inventory.pickUp(item);
    if (where === 'equipped') {
      ctx.events.emit('ui:message', {
        text: `Equipped ${item.name}`, duration: 2.5, style: item.rarity === 'legendary' ? 'legendary' : 'info',
      });
    } else if (where === 'backpack') {
      ctx.events.emit('ui:message', { text: `${item.name} → backpack [I]`, duration: 2.5, style: 'info' });
    }
    return where;
  }

  ctx.events.on('loot:pickup', (e) => {
    const item = e.item;
    if (item.kind !== 'gear' || !item.gear) return;
    if (ctx.player && e.playerId !== ctx.player.id) return;
    pickUp(item.gear);
  });

  return {
    inventory,
    get gearStats() {
      return inventory.stats;
    },
    mergedStats: (base) => mergeStats(base, inventory.stats.stats, merged),
    generate: (tier, o) => generateGear(ctx.rng, ctx.nextId, tier, o),
    canPickUp: (item) => !inventory.has(item.id) && (!inventory.equipped(item.slot) || !inventory.isFull()),
    pickUp,
    maxGrenades: (base) => base + inventory.stats.extraGrenades,
  };
}

/** Convenience for code that only has a loadout (co-op avatars, standing "gear quality worn"). */
export const loadoutStats = computeLoadoutStats;
