/**
 * System I — standing, ranks, crowd favour (hype) and sponsors: shared types + events.
 *
 * The events below are not in core GameEvents yet. Until the lead applies the one-line
 * diff in INTEGRATION.md (`interface GameEvents extends StandingEvents`), use the typed
 * helpers `emitStanding` / `onStanding` — they work before and after the integration.
 */
import type { EventBus } from '@/core/events';
import type { Element, Vec3 } from '@/core/types';

// ---------------------------------------------------------------------------
// Ranks / leagues
// ---------------------------------------------------------------------------
export type LeagueId = 'scrap' | 'iron' | 'steel' | 'star' | 'void';

/** Arena + hub dressing per league, read by the world/hub builders (data only). */
export interface LeagueDressing {
  /** Multiplier on the instanced crowd count in the stands (1 = full house). */
  crowdSizeMult: number;
  /** Number of floodlight rigs around the pit. */
  floodlights: number;
  /** Stage lasers / holo-billboards switched on. */
  lasers: boolean;
  holoBillboards: number;
  /** Arena hazard unlocked in this league (M9), or null. */
  hazard: null | 'vent_pulls' | 'laser_grids' | 'gravity_pulses' | 'shrinking_ring';
  /** Station floor the hub (your quarters) lives on. */
  hubFloor: string;
  notes: string;
}

export interface League {
  id: LeagueId;
  name: string; // "Scrap League"
  index: number; // 0..4
  /** The ONE saturated accent colour of this league (Brutalist art direction). */
  accent: number;
  accentCss: string;
  dressing: LeagueDressing;
}

export interface RankDef {
  id: string; // 'scrap_1_fodder'
  name: string; // 'Fodder'
  league: LeagueId;
  leagueIndex: number; // 0..4
  tier: number; // 1..5 inside the league
  index: number; // 0..24 overall
  /** Standing needed to hold this rank. threshold(i) = round(250 · i^1.6). */
  threshold: number;
  accent: number;
  /** What visibly changes at this rank (hub prop / title / crowd) — for the hub + world agents. */
  unlock: string;
}

export interface RankProgress {
  rank: RankDef;
  next: RankDef | null;
  /** Standing earned inside the current rank. */
  into: number;
  /** Standing span of the current rank (0 at max rank). */
  span: number;
  /** 0..1 towards the next rank (1 at max rank). */
  fraction: number;
  /** Standing still missing for the next rank (0 at max rank). */
  remaining: number;
}

// ---------------------------------------------------------------------------
// Hype (crowd favour)
// ---------------------------------------------------------------------------
export type HypeTier = 'cold' | 'warm' | 'hot' | 'roaring';
export const HYPE_TIERS: readonly HypeTier[] = ['cold', 'warm', 'hot', 'roaring'];
export const HYPE_TIER_LABEL: Record<HypeTier, string> = { cold: 'COLD', warm: 'WARM', hot: 'HOT', roaring: 'ROARING' };

export type HypeGiftKind = 'crate' | 'buff' | 'bonuswave';

export type HypeReason =
  | 'kill' | 'crit' | 'crit_kill' | 'multi_kill' | 'melee_kill' | 'airborne_kill'
  | 'comeback_kill' | 'flawless_subwave' | 'boss_phase' | 'boss_kill'
  | 'damage_taken' | 'shield_break';

/**
 * Live, mutated-in-place effect values of the crowd. Other systems keep a reference and
 * read it whenever they need it (see INTEGRATION.md for each hook).
 */
export interface HypeModifiers {
  readonly value: number; // 0..100
  readonly tier: HypeTier;
  /** Added to DropOpts.rarityBoost (can be negative while booed; clamp the sum to >= 0). */
  readonly rarityBoost: number;
  /** Multiplier on XP gained. */
  readonly xpMult: number;
  /** Multiplier on player damage (1.3 during a crowd-gift buff, else 1). */
  readonly damageMult: number;
  /** Seconds left on the crowd-gift damage buff. */
  readonly buffRemaining: number;
  readonly booing: boolean;
}

// ---------------------------------------------------------------------------
// Sponsors
// ---------------------------------------------------------------------------
/** Rule changes for one run. Neutral values: mults 1, boosts 0, flags false/undefined. */
export interface RunModifiers {
  /** × mobs per round (rounds: killsRequired / sub-wave quotas). */
  enemyCountMult: number;
  /** × enemy max health (mobs and bosses). */
  enemyHealthMult: number;
  /** + DropOpts.rarityBoost on every drop. */
  lootRarityBoost: number;
  /** × number of items per drop (mob drops and boss showers). */
  lootCountMult: number;
  /** Every generated weapon gets this element. */
  elementsOnly?: Element;
  /** Player max shield forced to 0. */
  noShield?: boolean;
  /** × player damage (bullets, melee, grenades). */
  damageMult: number;
  /** Every sub-wave ends in a boss, not only the last one (the base loop already has one boss per round). */
  bossEveryRound?: boolean;
  /** No grenades: start with 0, grenade pickups never drop. */
  grenadeless?: boolean;
  /** × all standing earned during the run. */
  standingMult: number;
}

export interface SponsorContract {
  id: string;
  name: string; // sponsor brand
  title: string; // contract name shown on the card
  blurb: string;
  /** Short bullet lines for the card, derived from the rules (upsides first). */
  perks: string[];
  drawbacks: string[];
  rules: RunModifiers;
  /** League index (0 Scrap .. 4 Void) you must reach to sign this contract. */
  unlockLeague: number;
  /** Card accent (defaults to the unlock league's accent). */
  accent: number;
}

// ---------------------------------------------------------------------------
// Standing
// ---------------------------------------------------------------------------
export interface StandingGain {
  amount: number;
  reason: string; // 'round' | 'boss' | 'hype' | 'consolation' | custom
  label: string; // human-readable, e.g. "Round 3 cleared"
  standing: number; // total after the gain
  at: number; // Date.now()
}

export interface StandingLifetime {
  roundsCleared: number;
  bossesKilled: number;
  runs: number;
  bestRound: number;
  gifts: number;
}

// ---------------------------------------------------------------------------
// Events (add to GameEvents via `extends StandingEvents`, see INTEGRATION.md)
// ---------------------------------------------------------------------------
export interface StandingEvents {
  'standing:gained': { amount: number; standing: number; rank: RankDef; reason: string; label: string };
  'standing:rank': { rank: RankDef; league: League; previous: RankDef; leagueUp: boolean };
  /** On every tier change and every 0.5 s while the value is changing. */
  'hype:changed': { value: number; tier: HypeTier; previousTier: HypeTier; tierChanged: boolean };
  /** Every positive/negative crowd reaction, for the HUD ticker ("TRIPLE KILL +8"). */
  'hype:reaction': { reason: HypeReason; label: string; amount: number; value: number };
  /** ROARING crowd gift. 'bonuswave' is a suggestion for rounds: add `mobs` to the current sub-wave. */
  'hype:gift': { kind: HypeGiftKind; round: number; position?: Vec3; mobs?: number; buffSeconds?: number };
  'hype:boo': { seconds: number; rarityPenalty: number };
  'sponsor:chosen': { id: string; name: string; title: string; modifiers: RunModifiers };
}

export type StandingEventName = keyof StandingEvents;

type LooseBus = {
  emit(name: string, payload: unknown): void;
  on(name: string, handler: (payload: unknown) => void): () => void;
};

export function emitStanding<K extends StandingEventName>(bus: EventBus, name: K, payload: StandingEvents[K]): void {
  (bus as unknown as LooseBus).emit(name, payload);
}

export function onStanding<K extends StandingEventName>(
  bus: EventBus, name: K, handler: (payload: StandingEvents[K]) => void,
): () => void {
  return (bus as unknown as LooseBus).on(name, handler as (payload: unknown) => void);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}
