/**
 * Procedural gear generator + loadout stat math. Mirrors src/loot/weapons.ts: same rarity
 * roll (rollRarity / rarityWeights), same RARITY_BUDGET, rng-only randomness, generated names.
 * Pure sim code: only the provided rng is used.
 */
import { RARITY_ORDER, type Element, type PlayerStats, type Rarity, type WeaponDef } from '@/core/types';
import { pick, randRange } from '@/core/rng';
import { RARITY_BUDGET, rollRarity } from '@/loot/weapons';
import { gearAccentColor, gearBodyColor } from './palette';
import {
  GEAR_SLOTS,
  type ActiveSet, type ExtraGearStat, type GearAffix, type GearDef, type GearSetDef, type GearSetId,
  type GearSlot, type GearStat, type GearStats, type League, type Loadout, type SetBonus,
} from './types';

type Rng = () => number;

// ---------------------------------------------------------------------------
// Level, growth, rarity tables
// ---------------------------------------------------------------------------
/** Item level bonus per rarity (PLAN §11: level = tier + rarity bonus). */
export const LEVEL_BONUS: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 5 };
/** Rolled affix count per rarity (the implicit comes on top). */
export const AFFIX_COUNT: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
const ELEMENT_CHANCE: Record<Rarity, number> = { common: 0, uncommon: 0.1, rare: 0.25, epic: 0.45, legendary: 0.7 };
/** Chance a piece belongs to a set (only if its slot is in one). */
export const SET_CHANCE: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0.18, epic: 0.32, legendary: 0.5 };

/** Growth curve shared by gear and weapon viewmodels: fast early change, saturates ~level 25. */
export const GROWTH_RATE = 9;
export function growthForLevel(level: number): number {
  const g = 1 - Math.exp(-Math.max(0, level - 1) / GROWTH_RATE);
  return Math.round(g * 1000) / 1000;
}
export const itemLevel = (tier: number, rarity: Rarity) => Math.max(1, Math.floor(tier)) + LEVEL_BONUS[rarity];
/** Same curve for weapons (WeaponDef.level is the tier). */
export const weaponGrowth = (w: Pick<WeaponDef, 'level' | 'rarity'>) => growthForLevel(itemLevel(w.level, w.rarity));

export function leagueForLevel(level: number): League {
  if (level <= 4) return 'scrap';
  if (level <= 9) return 'iron';
  if (level <= 15) return 'steel';
  if (level <= 22) return 'star';
  return 'void';
}

// ---------------------------------------------------------------------------
// Affix table
// ---------------------------------------------------------------------------
interface AffixSpec {
  name: string;
  /** Level-1 roll range before rarity budget. */
  min: number;
  max: number;
  /** "+{v} gun damage"; {v} is formatted as a percentage (or a count for integers). */
  text: string;
  integer?: boolean;
}

export const AFFIXES: Record<GearStat, AffixSpec> = {
  damageMult: { name: 'Gun Damage', min: 0.03, max: 0.06, text: '+{v} gun damage' },
  fireRateMult: { name: 'Fire Rate', min: 0.03, max: 0.05, text: '+{v} fire rate' },
  reloadMult: { name: 'Reload Speed', min: 0.04, max: 0.07, text: '-{v} reload time' },
  critMult: { name: 'Crit Damage', min: 0.06, max: 0.1, text: '+{v} critical damage' },
  healthMult: { name: 'Max Health', min: 0.06, max: 0.1, text: '+{v} max health' },
  shieldMult: { name: 'Shield Capacity', min: 0.08, max: 0.12, text: '+{v} shield capacity' },
  moveSpeedMult: { name: 'Move Speed', min: 0.025, max: 0.045, text: '+{v} movement speed' },
  shieldRegen: { name: 'Shield Recharge', min: 0.08, max: 0.14, text: '+{v} shield recharge rate' },
  elementalResist: { name: 'Elemental Resist', min: 0.04, max: 0.07, text: '-{v} elemental damage taken' },
  meleeMult: { name: 'Melee Damage', min: 0.1, max: 0.18, text: '+{v} melee damage' },
  elementChance: { name: 'Status Chance', min: 0.03, max: 0.05, text: '+{v} elemental status chance' },
  grenades: { name: 'Grenade Capacity', min: 1, max: 1, text: '+{v} max grenades', integer: true },
};
export const GEAR_STATS = Object.keys(AFFIXES) as GearStat[];

/** Level scaling of affix values: +7 % per level, capped at ×3 (reached ~level 30). */
export const AFFIX_LEVEL_RATE = 0.07;
export const AFFIX_LEVEL_CAP = 3;
export const affixLevelScale = (level: number) => Math.min(1 + AFFIX_LEVEL_RATE * Math.max(0, level - 1), AFFIX_LEVEL_CAP);
/** Implicits are smaller than rolled affixes. */
export const IMPLICIT_SCALE = 0.6;

/** Primary pool per slot (PLAN/brief), then a secondary pool used to fill higher affix counts. */
export const AFFIX_POOLS: Record<GearSlot, { primary: readonly GearStat[]; secondary: readonly GearStat[] }> = {
  helm: { primary: ['critMult', 'reloadMult'], secondary: ['shieldMult', 'elementalResist', 'healthMult'] },
  chest: { primary: ['healthMult', 'shieldMult'], secondary: ['elementalResist', 'shieldRegen', 'damageMult'] },
  boots: { primary: ['moveSpeedMult', 'shieldRegen'], secondary: ['healthMult', 'reloadMult', 'elementalResist'] },
  gloves: { primary: ['fireRateMult', 'damageMult'], secondary: ['reloadMult', 'critMult', 'meleeMult'] },
  trinket: {
    primary: ['grenades', 'elementalResist', 'elementChance'],
    secondary: ['damageMult', 'fireRateMult', 'reloadMult', 'critMult', 'healthMult', 'shieldMult', 'moveSpeedMult', 'shieldRegen', 'meleeMult'],
  },
};
/** Chance each affix draw comes from the primary pool while primaries remain. */
const PRIMARY_CHANCE = 0.65;

export const IMPLICIT_STAT: Record<GearSlot, GearStat> = {
  helm: 'shieldMult', chest: 'healthMult', boots: 'moveSpeedMult', gloves: 'damageMult', trinket: 'shieldRegen',
};

/** Max grenades an affix can grant at a given level. */
const grenadeCount = (rng: Rng, level: number, rarity: Rarity) =>
  Math.min(3, 1 + Math.floor(level / 12) + (rarity === 'legendary' && rng() < 0.5 ? 1 : 0));

/** Inclusive value bounds for an affix (used by tests and tooltips). */
export function affixBounds(stat: GearStat, level: number, rarity: Rarity, implicit = false): [number, number] {
  const s = AFFIXES[stat];
  if (s.integer) return [1, 3];
  const k = affixLevelScale(level) * RARITY_BUDGET[rarity] * (implicit ? IMPLICIT_SCALE : 1);
  return [round3(s.min * k) - 0.0005, round3(s.max * k) + 0.0005];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function formatAffixValue(stat: GearStat, value: number): string {
  if (AFFIXES[stat].integer) return String(Math.round(value));
  const pct = value * 100;
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}

export function makeAffix(stat: GearStat, value: number): GearAffix {
  const s = AFFIXES[stat];
  return {
    id: `aff_${stat}`,
    name: s.name,
    stat,
    value,
    description: s.text.replace('{v}', formatAffixValue(stat, value)),
  };
}

function rollAffix(rng: Rng, stat: GearStat, level: number, rarity: Rarity, implicit = false): GearAffix {
  const s = AFFIXES[stat];
  if (s.integer) return makeAffix(stat, grenadeCount(rng, level, rarity));
  const k = affixLevelScale(level) * RARITY_BUDGET[rarity] * (implicit ? IMPLICIT_SCALE : 1);
  return makeAffix(stat, round3(randRange(rng, s.min, s.max) * k));
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------
export const GEAR_SETS: Record<GearSetId, GearSetDef> = {
  voidrunner: {
    id: 'voidrunner',
    name: 'Voidrunner',
    slots: ['helm', 'boots', 'gloves'],
    bonuses: [
      { pieces: 2, description: '+10% movement speed, -10% reload time', stats: { moveSpeedMult: 0.1, reloadMult: 0.1 } },
      {
        pieces: 3,
        description: '+12% fire rate. Sprint + jump becomes a short blink dash (4s cooldown)',
        stats: { fireRateMult: 0.12 },
        hook: 'voidrunner_dash',
      },
    ],
  },
  bulwark: {
    id: 'bulwark',
    name: 'Bulwark',
    slots: ['helm', 'chest', 'boots'],
    bonuses: [
      { pieces: 2, description: '+20% shield capacity, +20% shield recharge rate', stats: { shieldMult: 0.2, shieldRegen: 0.2 } },
      {
        pieces: 3,
        description: '+15% max health. When your shield breaks, take 50% less damage for 2s (10s cooldown)',
        stats: { healthMult: 0.15 },
        hook: 'bulwark_last_stand',
      },
    ],
  },
  pitfighter: {
    id: 'pitfighter',
    name: 'Pitfighter',
    slots: ['chest', 'gloves', 'trinket'],
    bonuses: [
      { pieces: 2, description: '+10% gun damage, +40% melee damage', stats: { damageMult: 0.1, meleeMult: 0.4 } },
      {
        pieces: 3,
        description: '+15% critical damage. Melee kills refill your shield and refund a grenade',
        stats: { critMult: 0.15 },
        hook: 'pitfighter_bloodlust',
      },
    ],
  },
};
export const GEAR_SET_LIST: readonly GearSetDef[] = Object.values(GEAR_SETS);
export const setsForSlot = (slot: GearSlot) => GEAR_SET_LIST.filter((s) => s.slots.includes(slot));

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
const LEAGUE_WORDS: Record<League, readonly string[]> = {
  scrap: ['Scrap', 'Rusted', 'Salvaged'],
  iron: ['Iron', 'Riveted', 'Cast'],
  steel: ['Steel', 'Forged', 'Tempered'],
  star: ['Star', 'Plasma', 'Orbital'],
  void: ['Void', 'Null', 'Eclipse'],
};
const SLOT_NOUNS: Record<GearSlot, readonly string[]> = {
  helm: ['Helm', 'Visor', 'Warhelm', 'Skullcap', 'Crown'],
  chest: ['Cuirass', 'Carapace', 'Breastplate', 'Hauberk', 'Plate'],
  boots: ['Treads', 'Greaves', 'Stompers', 'Sabatons'],
  gloves: ['Gauntlets', 'Grips', 'Knuckles', 'Fists'],
  trinket: ['Charm', 'Orrery', 'Talisman', 'Sigil', 'Totem'],
};
const FLAVOUR: Record<GearStat, readonly string[]> = {
  damageMult: ['Ruin', 'Carnage', 'the Butcher'],
  fireRateMult: ['Haste', 'Frenzy', 'the Trigger'],
  reloadMult: ['Quickhands', 'Reflex', 'the Loader'],
  critMult: ['Precision', 'the Eye', 'the Headsman'],
  healthMult: ['Vigor', 'Endurance', 'the Ox'],
  shieldMult: ['Warding', 'the Bastion', 'Aegis'],
  moveSpeedMult: ['Swiftness', 'Pursuit', 'the Wind'],
  shieldRegen: ['Renewal', 'Recovery', 'the Dynamo'],
  elementalResist: ['Grounding', 'Insulation', 'the Null'],
  meleeMult: ['Bruising', 'the Brawler', 'the Pit'],
  elementChance: ['Catalysis', 'Infusion', 'the Conduit'],
  grenades: ['Demolition', 'Shrapnel', 'the Sapper'],
};
const LEGENDARY_FLAIR = [
  'Seven Suns', 'the Headliner', 'the Last Gate', 'the Red Sand', 'the Grand Finale', 'the Pit King',
  'No Mercy', 'the Eternal Crowd', 'Dead Orbit', 'the Final Bell',
] as const;

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------
/** Points per unit of value: a mid level-1 affix is worth ~5 points. */
export function statScoreWeight(stat: GearStat): number {
  const s = AFFIXES[stat];
  return 5 / ((s.min + s.max) / 2);
}

/** Single-number quality of a piece, for compare cards and standing ("gear quality worn"). */
export function gearScore(def: GearDef): number {
  let s = def.implicit.value * statScoreWeight(def.implicit.stat);
  for (const a of def.affixes) s += a.value * statScoreWeight(a.stat);
  if (def.setId) s += 4;
  return Math.round(s);
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
export interface GenerateGearOpts {
  slot?: GearSlot;
  rarity?: Rarity;
  rarityBoost?: number;
  minRarity?: Rarity;
  /** Force a set (ignored if the slot is not part of it), or null to forbid sets. */
  setId?: GearSetId | null;
}

export function generateGear(rng: Rng, nextId: (p: string) => string, tier: number, opts: GenerateGearOpts = {}): GearDef {
  tier = Math.max(1, Math.floor(tier));
  const slot = opts.slot ?? pick(rng, GEAR_SLOTS);
  const rarity = opts.rarity ?? rollRarity(rng, tier, opts.rarityBoost ?? 0, opts.minRarity ?? 'common');
  const level = itemLevel(tier, rarity);
  const league = leagueForLevel(level);

  // Element
  let element: Exclude<Element, 'none'> | undefined;
  if (rng() < ELEMENT_CHANCE[rarity]) element = pick(rng, ['fire', 'shock', 'ice'] as const);

  // Implicit + affixes (no duplicate stats)
  const implicit = rollAffix(rng, IMPLICIT_STAT[slot], level, rarity, true);
  const pools = AFFIX_POOLS[slot];
  const allowed = (s: GearStat) => s !== 'elementChance' || !!element;
  const primary = pools.primary.filter(allowed);
  const secondary = pools.secondary.filter(allowed);
  const affixes: GearAffix[] = [];
  const count = AFFIX_COUNT[rarity];
  for (let i = 0; i < count; i++) {
    const from = primary.length && (rng() < PRIMARY_CHANCE || !secondary.length) ? primary : secondary;
    if (!from.length) break;
    const stat = from.splice(Math.floor(rng() * from.length), 1)[0];
    affixes.push(rollAffix(rng, stat, level, rarity));
  }

  // Set
  let setId: GearSetId | undefined;
  if (opts.setId !== null) {
    const candidates = setsForSlot(slot);
    if (opts.setId && GEAR_SETS[opts.setId].slots.includes(slot)) setId = opts.setId;
    else if (opts.setId === undefined && candidates.length && rng() < SET_CHANCE[rarity]) setId = pick(rng, candidates).id;
  }

  // Name: "[league/material word] [slot noun] of [flavour]"; set name replaces the material word.
  const lead = setId ? GEAR_SETS[setId].name : pick(rng, LEAGUE_WORDS[league]);
  const noun = pick(rng, SLOT_NOUNS[slot]);
  const best = affixes.length
    ? affixes.reduce((a, b) => (b.value * statScoreWeight(b.stat) > a.value * statScoreWeight(a.stat) ? b : a))
    : implicit;
  const name = rarity === 'legendary'
    ? `★ ${lead} ${noun} of ${pick(rng, LEGENDARY_FLAIR)}`
    : `${lead} ${noun} of ${pick(rng, FLAVOUR[best.stat])}`;

  return {
    id: nextId('g'),
    name,
    slot,
    rarity,
    ...(element ? { element } : {}),
    tier,
    level,
    implicit,
    affixes,
    ...(setId ? { setId } : {}),
    league,
    color: gearBodyColor(rarity),
    accent: gearAccentColor(rarity, element),
    growth: growthForLevel(level),
    seed: Math.floor(rng() * 0x7fffffff),
  };
}

// ---------------------------------------------------------------------------
// Loadout stats
// ---------------------------------------------------------------------------
/** Caps on the summed additive totals (after set bonuses). */
export const GEAR_CAPS: Record<GearStat, number> = {
  damageMult: 1.0,
  fireRateMult: 0.6,
  reloadMult: 0.5, // reload time never below 50 %
  critMult: 1.0,
  healthMult: 1.5,
  shieldMult: 1.5,
  moveSpeedMult: 0.4,
  shieldRegen: 1.5,
  elementalResist: 0.6,
  meleeMult: 2.0,
  elementChance: 0.25,
  grenades: 4,
};

const zeroTotals = (): Record<GearStat, number> =>
  Object.fromEntries(GEAR_STATS.map((s) => [s, 0])) as Record<GearStat, number>;

export function neutralStats(): PlayerStats {
  return { damageMult: 1, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1 };
}

export function loadoutPieces(loadout: Loadout): GearDef[] {
  const out: GearDef[] = [];
  for (const s of GEAR_SLOTS) {
    const d = loadout[s];
    if (d && d.slot === s) out.push(d);
  }
  return out;
}

export function activeSets(loadout: Loadout): ActiveSet[] {
  const counts = new Map<GearSetId, number>();
  for (const d of loadoutPieces(loadout)) if (d.setId) counts.set(d.setId, (counts.get(d.setId) ?? 0) + 1);
  const out: ActiveSet[] = [];
  for (const [id, pieces] of counts) {
    const def = GEAR_SETS[id];
    if (!def) continue;
    out.push({ setId: id, name: def.name, pieces, active: def.bonuses.filter((b: SetBonus) => pieces >= b.pieces) });
  }
  return out;
}

const PLAYER_STAT_KEYS: readonly (keyof PlayerStats)[] = [
  'damageMult', 'fireRateMult', 'reloadMult', 'critMult', 'healthMult', 'shieldMult', 'moveSpeedMult',
];

export function computeLoadoutStats(loadout: Loadout): GearStats {
  const totals = zeroTotals();
  const pieces = loadoutPieces(loadout);
  let score = 0;
  for (const d of pieces) {
    totals[d.implicit.stat] += d.implicit.value;
    for (const a of d.affixes) totals[a.stat] += a.value;
    score += gearScore(d);
  }
  const sets = activeSets(loadout);
  const hooks: string[] = [];
  for (const s of sets) {
    for (const b of s.active) {
      if (b.stats) for (const k of Object.keys(b.stats) as GearStat[]) totals[k] += b.stats[k] ?? 0;
      if (b.hook) hooks.push(b.hook);
    }
  }
  for (const k of GEAR_STATS) totals[k] = round3(Math.min(Math.max(0, totals[k]), GEAR_CAPS[k]));
  totals.grenades = Math.floor(totals.grenades);

  const stats = neutralStats();
  for (const k of PLAYER_STAT_KEYS) stats[k] = k === 'reloadMult' ? round3(1 - totals[k]) : round3(1 + totals[k]);

  return {
    stats,
    extraGrenades: totals.grenades,
    shieldRegenMult: round3(1 + totals.shieldRegen),
    elementalResist: totals.elementalResist,
    meleeMult: round3(1 + totals.meleeMult),
    elementChanceBonus: totals.elementChance,
    totals,
    sets,
    hooks,
    score,
  };
}

/** progression stats × gear stats, key by key (both are multipliers). */
export function mergeStats(base: PlayerStats, gear: PlayerStats, out: PlayerStats = neutralStats()): PlayerStats {
  for (const k of PLAYER_STAT_KEYS) out[k] = base[k] * gear[k];
  return out;
}

export const isExtraStat = (s: GearStat): s is ExtraGearStat => !(PLAYER_STAT_KEYS as readonly string[]).includes(s);
export const rarityIndex = (r: Rarity) => RARITY_ORDER.indexOf(r);
