/**
 * Sponsor contracts: pre-run rule changes with trade-offs, unlocked by league.
 * Data-driven; `createSponsors(ctx)` keeps the chosen contract for the run (persists the
 * last choice in 'concourse.sponsor.v1') and exposes `active: RunModifiers`, a live
 * object other systems read at the hook points listed in INTEGRATION.md.
 */
import type { GameContext } from '@/core/types';
import { LEAGUES } from './ranks';
import { defaultStore, readJson, writeJson } from './storage';
import { emitStanding, type KeyValueStore, type RunModifiers, type SponsorContract } from './types';

export const SPONSOR_KEY = 'concourse.sponsor.v1';

export const NEUTRAL_MODIFIERS: Readonly<RunModifiers> = Object.freeze({
  enemyCountMult: 1,
  enemyHealthMult: 1,
  lootRarityBoost: 0,
  lootCountMult: 1,
  damageMult: 1,
  standingMult: 1,
});

/** Build a full RunModifiers from a partial (missing fields neutral). */
export function modifiers(partial: Partial<RunModifiers> = {}): RunModifiers {
  return { ...NEUTRAL_MODIFIERS, ...partial };
}

/**
 * Combine several rule sets (sponsor + future M6 round mutators): mults multiply,
 * boosts add, flags OR, the first defined `elementsOnly` wins.
 */
export function composeModifiers(...parts: Partial<RunModifiers>[]): RunModifiers {
  const out = modifiers();
  for (const p of parts) {
    if (!p) continue;
    if (p.enemyCountMult !== undefined) out.enemyCountMult *= p.enemyCountMult;
    if (p.enemyHealthMult !== undefined) out.enemyHealthMult *= p.enemyHealthMult;
    if (p.lootCountMult !== undefined) out.lootCountMult *= p.lootCountMult;
    if (p.damageMult !== undefined) out.damageMult *= p.damageMult;
    if (p.standingMult !== undefined) out.standingMult *= p.standingMult;
    if (p.lootRarityBoost !== undefined) out.lootRarityBoost += p.lootRarityBoost;
    if (p.elementsOnly !== undefined && out.elementsOnly === undefined) out.elementsOnly = p.elementsOnly;
    if (p.noShield) out.noShield = true;
    if (p.bossEveryRound) out.bossEveryRound = true;
    if (p.grenadeless) out.grenadeless = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hook helpers (pure) — use these at the integration points so rounding is uniform.
// ---------------------------------------------------------------------------
/** Mobs per round / per sub-wave quota. */
export const scaleEnemyCount = (n: number, m: RunModifiers) => Math.max(1, Math.round(n * m.enemyCountMult));
/** Items per drop (keeps at least `min`, e.g. the guaranteed kinds). */
export const scaleLootCount = (n: number, m: RunModifiers, min = 1) => Math.max(min, Math.round(n * m.lootCountMult));
/** Sum of rarity boosts, clamped to the DropOpts range 0..1. */
export const clampBoost = (...boosts: number[]) => Math.max(0, Math.min(1, boosts.reduce((s, b) => s + b, 0)));

/** Card bullet lines from rules (upsides, downsides) — used to keep card text honest. */
export function describeRules(r: RunModifiers): { perks: string[]; drawbacks: string[] } {
  const perks: string[] = [];
  const drawbacks: string[] = [];
  const pct = (m: number) => `${m > 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;
  if (r.standingMult !== 1) (r.standingMult > 1 ? perks : drawbacks).push(`Standing ×${r.standingMult}`);
  if (r.lootRarityBoost) (r.lootRarityBoost > 0 ? perks : drawbacks).push(`Loot rarity ${r.lootRarityBoost > 0 ? '+' : '−'}${Math.round(Math.abs(r.lootRarityBoost) * 100)}`);
  if (r.lootCountMult !== 1) (r.lootCountMult > 1 ? perks : drawbacks).push(`Loot drops ×${r.lootCountMult}`);
  if (r.damageMult !== 1) (r.damageMult > 1 ? perks : drawbacks).push(`Your damage ${pct(r.damageMult)}`);
  if (r.enemyCountMult !== 1) (r.enemyCountMult > 1 ? drawbacks : perks).push(`Enemies ×${r.enemyCountMult}`);
  if (r.enemyHealthMult !== 1) (r.enemyHealthMult > 1 ? drawbacks : perks).push(`Enemy health ${pct(r.enemyHealthMult)}`);
  if (r.elementsOnly) drawbacks.push(`Only ${r.elementsOnly} weapons drop`);
  if (r.noShield) drawbacks.push('No shield');
  if (r.grenadeless) drawbacks.push('No grenades');
  if (r.bossEveryRound) drawbacks.push('A boss ends every sub-wave');
  return { perks, drawbacks };
}

interface ContractSpec {
  id: string;
  name: string;
  title: string;
  blurb: string;
  unlockLeague: number;
  rules: Partial<RunModifiers>;
}

function contract(spec: ContractSpec): SponsorContract {
  const rules = modifiers(spec.rules);
  const { perks, drawbacks } = describeRules(rules);
  return {
    id: spec.id, name: spec.name, title: spec.title, blurb: spec.blurb,
    perks, drawbacks, rules, unlockLeague: spec.unlockLeague,
    accent: (LEAGUES[spec.unlockLeague] ?? LEAGUES[0]).accent,
  };
}

/** No sponsor: neutral rules. Always available, the default. */
export const FREE_AGENT: SponsorContract = contract({
  id: 'free_agent', name: 'Free Agent', title: 'No contract',
  blurb: 'Fight for yourself. No rules, no bonuses, no strings.',
  unlockLeague: 0, rules: {},
});

/** The 8 sponsor contracts, ordered by unlock league. */
export const SPONSORS: readonly SponsorContract[] = [
  contract({
    id: 'safety_first', name: 'Halcyon Mutual', title: 'Safety First',
    blurb: 'An insurer pays to keep its client alive. Softer opponents, thinner purse, sad crowd.',
    unlockLeague: 0,
    rules: { enemyHealthMult: 0.8, lootRarityBoost: -0.1, standingMult: 0.7 },
  }),
  contract({
    id: 'double_trouble', name: 'Grubb’s Scrapyard', title: 'Double Trouble',
    blurb: 'Twice the bodies, twice the junk. Grubb sells whatever you leave behind.',
    unlockLeague: 0,
    rules: { enemyCountMult: 2, lootCountMult: 2, enemyHealthMult: 0.9, standingMult: 1.3 },
  }),
  contract({
    id: 'glass_cannon', name: 'Kessler Munitions', title: 'Glass Cannon',
    blurb: 'Kessler strips your shield generator to fit a bigger power cell. Hit first.',
    unlockLeague: 1,
    rules: { noShield: true, damageMult: 1.4, standingMult: 1.35 },
  }),
  contract({
    id: 'pyre', name: 'Pyre Syndicate', title: 'Burn It All',
    blurb: 'The Syndicate only ships fire. The crowd loves a bonfire; the mobs come tougher.',
    unlockLeague: 1,
    rules: { elementsOnly: 'fire', lootRarityBoost: 0.1, enemyHealthMult: 1.15, standingMult: 1.15 },
  }),
  contract({
    id: 'bare_knuckle', name: 'Brass Knuckle Promotions', title: 'Bare Knuckle',
    blurb: 'Explosives are “bad for the brand”. Fight close, get paid in better guns.',
    unlockLeague: 2,
    rules: { grenadeless: true, lootRarityBoost: 0.15, damageMult: 1.1, standingMult: 1.2 },
  }),
  contract({
    id: 'headliner', name: 'Headliner Network', title: 'Prime Time',
    blurb: 'Ratings demand a headliner every segment. Fewer mobs, more bosses, big payouts.',
    unlockLeague: 2,
    rules: { bossEveryRound: true, enemyCountMult: 0.75, lootRarityBoost: 0.2, standingMult: 1.5 },
  }),
  contract({
    id: 'frostbyte', name: 'Frostbyte Cryonics', title: 'Cold Open',
    blurb: 'Ice-only arsenal for a sold-out crowd. More of them, better of yours.',
    unlockLeague: 3,
    rules: { elementsOnly: 'ice', enemyCountMult: 1.3, lootRarityBoost: 0.25, standingMult: 1.4 },
  }),
  contract({
    id: 'blood_sport', name: 'The Abyssal Choir', title: 'Blood Sport',
    blurb: 'No shield, no grenades, monsters on stimulants. The Void pays in legends.',
    unlockLeague: 4,
    rules: {
      noShield: true, grenadeless: true, enemyHealthMult: 1.5, enemyCountMult: 1.25,
      damageMult: 1.25, lootRarityBoost: 0.4, standingMult: 2,
    },
  }),
];

export const ALL_CONTRACTS: readonly SponsorContract[] = [FREE_AGENT, ...SPONSORS];

export function contractById(id: string): SponsorContract | undefined {
  return ALL_CONTRACTS.find((c) => c.id === id);
}

export interface SponsorEntry {
  contract: SponsorContract;
  unlocked: boolean;
  selected: boolean;
}

export interface Sponsors {
  /** Live rules of the current contract (same object forever; mutated on choose()). */
  readonly active: RunModifiers;
  readonly contract: SponsorContract;
  /** True while a run is in progress: the contract is fixed until game over. */
  readonly locked: boolean;
  /** Every contract (Free Agent first) with unlock + selection state for the picker. */
  list(): SponsorEntry[];
  isUnlocked(id: string): boolean;
  /** Pick a contract for the next run. False when locked, unknown or not unlocked. */
  choose(id: string): boolean;
}

export interface SponsorOptions {
  storage?: KeyValueStore;
  /** Current league index (0..4) of the local player; from standing. */
  leagueIndex: () => number;
}

export function createSponsors(ctx: GameContext, opts: SponsorOptions): Sponsors {
  const store = opts.storage ?? defaultStore();
  const active: RunModifiers = modifiers();
  let current: SponsorContract = FREE_AGENT;
  let locked = false;

  const isUnlocked = (id: string) => {
    const c = contractById(id);
    return !!c && c.unlockLeague <= opts.leagueIndex();
  };

  function apply(c: SponsorContract): void {
    current = c;
    // reset optional flags, then copy the rules in (keeps the object reference stable)
    delete active.elementsOnly;
    delete active.noShield;
    delete active.bossEveryRound;
    delete active.grenadeless;
    Object.assign(active, c.rules);
  }

  function choose(id: string): boolean {
    if (locked) return false;
    const c = contractById(id);
    if (!c || !isUnlocked(id)) return false;
    apply(c);
    writeJson(store, SPONSOR_KEY, { version: 1, lastId: c.id });
    emitStanding(ctx.events, 'sponsor:chosen', { id: c.id, name: c.name, title: c.title, modifiers: { ...active } });
    return true;
  }

  // restore last choice (falls back to Free Agent if it is no longer unlocked)
  const saved = readJson<{ version?: number; lastId?: string }>(store, SPONSOR_KEY);
  const restored = saved && saved.lastId ? contractById(saved.lastId) : undefined;
  apply(restored && isUnlocked(restored.id) ? restored : FREE_AGENT);

  ctx.events.on('game:started', () => {
    // standing might have dropped after a reset; never run an unlocked-out contract
    if (!isUnlocked(current.id)) apply(FREE_AGENT);
    locked = true;
    if (current.id !== FREE_AGENT.id) {
      ctx.events.emit('ui:message', { text: `Sponsor: ${current.name} — “${current.title}”`, duration: 4, style: 'info' });
    }
  });
  ctx.events.on('game:over', () => {
    locked = false;
  });

  return {
    active,
    get contract() { return current; },
    get locked() { return locked; },
    list: () => ALL_CONTRACTS.map((contract) => ({
      contract, unlocked: contract.unlockLeague <= opts.leagueIndex(), selected: contract.id === current.id,
    })),
    isUnlocked,
    choose,
  };
}
