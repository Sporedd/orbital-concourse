/**
 * System I — standing, ranks, crowd favour and sponsors (milestones M5 + M7 logic).
 *
 *   const standing = createStandingSystem(ctx);   // boot: after progression, before hud
 *   standing.update(dt);                          // inside the !paused block
 *
 * Read the combined effects through the getters below (see INTEGRATION.md for hooks).
 */
import type { GameContext } from '@/core/types';
import { createHype, type Hype } from './hype';
import { leagueLootBoost } from './ranks';
import { clampBoost, createSponsors, type Sponsors } from './sponsors';
import { createStanding, type Standing } from './standing';
import type { KeyValueStore } from './types';

export * from './types';
export {
  RANKS, LEAGUES, MAX_RANK, rankThreshold, rankForStanding, progressToNext, rankTitle,
  leagueById, leagueOf, dressingForRank, leagueLootBoost,
} from './ranks';
export { HYPE, tierIndexFor, nextTierIndex, type Hype } from './hype';
export { STANDING_KEY, STANDING_RULES, type Standing } from './standing';
export {
  SPONSOR_KEY, SPONSORS, FREE_AGENT, ALL_CONTRACTS, NEUTRAL_MODIFIERS, contractById,
  modifiers, composeModifiers, describeRules, scaleEnemyCount, scaleLootCount, clampBoost,
  type Sponsors, type SponsorEntry,
} from './sponsors';
export {
  createHypeMeter, createStandingPanel,
  type HypeMeterWidget, type StandingPanelWidget, type StandingPanelOptions,
} from './hud';

export interface StandingSystem {
  readonly standing: Standing;
  readonly hype: Hype;
  readonly sponsors: Sponsors;
  /**
   * Total extra rarity for a drop, to ADD to the drop's own boost: sponsor + hype (incl.
   * boo penalty) + league bonus. Use `clampBoost(base, sys.rarityBoost())` at the call site.
   */
  rarityBoost(): number;
  /** Player damage multiplier: sponsor × crowd-gift buff. */
  damageMult(): number;
  /** XP multiplier from the crowd tier. */
  xpMult(): number;
  /** Convenience: final DropOpts.rarityBoost for a drop whose own boost is `base`. */
  dropBoost(base?: number): number;
  update(dt: number): void;
}

export interface StandingSystemOptions {
  storage?: KeyValueStore;
  /** Include the small per-league loot bonus (0 .. 0.12) in rarityBoost(). Default true. */
  leagueLoot?: boolean;
}

export function createStandingSystem(ctx: GameContext, opts: StandingSystemOptions = {}): StandingSystem {
  // sponsors needs the league (from standing) and standing needs the sponsor multiplier,
  // so standing reads sponsors lazily.
  let sponsors: Sponsors | null = null;
  const standing = createStanding(ctx, {
    storage: opts.storage,
    multiplier: () => (sponsors ? sponsors.active.standingMult : 1),
  });
  sponsors = createSponsors(ctx, { storage: opts.storage, leagueIndex: () => standing.rank.leagueIndex });
  const sp = sponsors;
  const hype = createHype(ctx, {
    onMilestone: (amount, label) => {
      standing.award(amount, 'hype', label);
    },
  });
  const leagueLoot = opts.leagueLoot ?? true;

  const rarityBoost = () =>
    sp.active.lootRarityBoost + hype.modifiers.rarityBoost + (leagueLoot ? leagueLootBoost(standing.rank) : 0);

  return {
    standing,
    hype,
    sponsors: sp,
    rarityBoost,
    damageMult: () => sp.active.damageMult * hype.modifiers.damageMult,
    xpMult: () => hype.modifiers.xpMult,
    dropBoost: (base = 0) => clampBoost(base, rarityBoost()),
    update(dt: number) {
      hype.update(dt);
    },
  };
}
