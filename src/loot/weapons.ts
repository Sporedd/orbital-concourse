/**
 * Procedural weapon generator: archetype base stats × rarity budget × tier scaling,
 * randomised per-stat rolls, elements, perks and generated names. Pure sim code (uses
 * the provided rng only) so the host can generate deterministically.
 */
import * as THREE from 'three';
import {
  ELEMENT_COLORS, RARITY_COLORS, RARITY_ORDER,
  type Element, type Rarity, type WeaponArchetype, type WeaponDef, type WeaponPerk,
} from '@/core/types';
import { pick, randInt, randRange } from '@/core/rng';

type Rng = () => number;

// ---------------------------------------------------------------------------
// Archetypes (PLAN §5)
// ---------------------------------------------------------------------------
interface ArchetypeBase {
  damage: number; fireRate: number; auto: boolean; magSize: number; reloadTime: number;
  pellets: number; spread: number; range: number; critMultiplier: number;
}

export const ARCHETYPES: Record<WeaponArchetype, ArchetypeBase> = {
  pistol: { damage: 22, fireRate: 4, auto: false, magSize: 12, reloadTime: 1.2, pellets: 1, spread: 0.012, range: 120, critMultiplier: 2.0 },
  smg: { damage: 11, fireRate: 12, auto: true, magSize: 36, reloadTime: 1.6, pellets: 1, spread: 0.04, range: 70, critMultiplier: 1.6 },
  shotgun: { damage: 12, fireRate: 1.5, auto: false, magSize: 6, reloadTime: 2.0, pellets: 8, spread: 0.11, range: 35, critMultiplier: 1.5 },
  rifle: { damage: 17, fireRate: 7, auto: true, magSize: 30, reloadTime: 1.8, pellets: 1, spread: 0.022, range: 110, critMultiplier: 1.8 },
  sniper: { damage: 95, fireRate: 1, auto: false, magSize: 5, reloadTime: 2.4, pellets: 1, spread: 0.002, range: 250, critMultiplier: 3.0 },
};
export const ARCHETYPE_LIST: readonly WeaponArchetype[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];
export const ARCHETYPE_LABEL: Record<WeaponArchetype, string> = {
  pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', sniper: 'Sniper',
};

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------
export const RARITY_BUDGET: Record<Rarity, number> = {
  common: 1.0, uncommon: 1.12, rare: 1.25, epic: 1.4, legendary: 1.6,
};
const ELEMENT_CHANCE: Record<Rarity, number> = {
  common: 0, uncommon: 0.15, rare: 0.4, epic: 0.7, legendary: 1,
};
const PERK_COUNT: Record<Rarity, [number, number]> = {
  common: [0, 0], uncommon: [0, 0], rare: [1, 1], epic: [1, 2], legendary: [2, 2],
};

/** Rarity weights for a tier; the common weight falls and the high tiers grow as tier rises. */
export function rarityWeights(tier: number, boost = 0): Record<Rarity, number> {
  const t = Math.max(0, tier - 1);
  const b = THREE.MathUtils.clamp(boost, 0, 1);
  return {
    common: Math.max(8, 60 - 6 * t) * (1 - 0.8 * b),
    uncommon: 28 * (1 - 0.3 * b),
    rare: (9 + 2.2 * t) * (1 + 2 * b),
    epic: (2.5 + 1.1 * t) * (1 + 2.5 * b),
    legendary: (0.6 + 0.4 * t) * (1 + 3 * b),
  };
}

export function rollRarity(rng: Rng, tier: number, boost = 0, minRarity: Rarity = 'common'): Rarity {
  const w = rarityWeights(tier, boost);
  const minIdx = RARITY_ORDER.indexOf(minRarity);
  const pool = RARITY_ORDER.filter((_, i) => i >= minIdx);
  const total = pool.reduce((s, r) => s + w[r], 0);
  let roll = rng() * total;
  for (const r of pool) {
    roll -= w[r];
    if (roll <= 0) return r;
  }
  return pool[pool.length - 1];
}

// ---------------------------------------------------------------------------
// Perks — exactly the ids the player system implements
// ---------------------------------------------------------------------------
export const PERKS: readonly WeaponPerk[] = [
  { id: 'ricochet', name: 'Ricochet', description: 'Hits bounce to a nearby enemy for 50% damage' },
  { id: 'crit_refund', name: 'Sharp Eye', description: 'Critical hits refund 1 round' },
  { id: 'ramp_up', name: 'Spin-Up', description: 'Fire rate ramps up while firing' },
  { id: 'splash', name: 'Splash', description: 'Hits deal 30% area damage' },
  { id: 'lifesteal', name: 'Vampiric', description: 'Heal 3% of damage dealt' },
  { id: 'double_tap', name: 'Double Tap', description: '10% chance to fire twice' },
];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
const ELEMENT_PREFIX: Record<Exclude<Element, 'none'>, readonly string[]> = {
  fire: ['Molten', 'Blazing', 'Scorched', 'Cindered'],
  shock: ['Static', 'Crackling', 'Voltaic', 'Arcing'],
  ice: ['Glacial', 'Frostbit', 'Rimed', 'Wintry'],
};
/** Non-elemental prefix chosen by the weapon's best stat roll. */
const STAT_PREFIX: Record<string, readonly string[]> = {
  damage: ['Brutal', 'Heavy', 'Mean'],
  fireRate: ['Hasty', 'Twitchy', 'Rapid'],
  magSize: ['Hoarding', 'Bottomless', 'Fat'],
  reload: ['Nimble', 'Slick', 'Quick'],
  spread: ['Steady', 'True', 'Calm'],
};
const MANUFACTURERS = ['Jakko', 'Vexlin', 'Kord', 'Sable', 'Brisk', 'Dahlgren', 'Orvo', 'Tessaline', 'Grimwald'] as const;
const NOUNS: Record<WeaponArchetype, readonly string[]> = {
  pistol: ['Iron', 'Hand Cannon', 'Peashooter', 'Snubnose'],
  smg: ['Ripper', 'Hornet', 'Buzzsaw', 'Chatterbox'],
  shotgun: ['Boomstick', 'Mauler', 'Scattergun', 'Doorkicker'],
  rifle: ['Carbine', 'Stormer', 'Warden', 'Trooper'],
  sniper: ['Longshot', 'Needle', 'Farsight', 'Lancer'],
};
const LEGENDARY_FLAIR = [
  'Widowmaker', 'Headliner', 'Showstopper', 'Main Event', 'Crowd Pleaser', 'Bulkhead',
  'Floodlight', 'Encore', 'Eclipse', 'Grand Finale', 'Pit Boss', 'Last Light',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function blendColor(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** Damage per second ignoring crits/reloads: damage × pellets × fireRate. */
export function weaponDps(w: WeaponDef): number {
  return w.damage * w.pellets * w.fireRate;
}

/** 0..100 accuracy score derived from spread (for the weapon card). */
export function weaponAccuracy(w: WeaponDef): number {
  return Math.round(THREE.MathUtils.clamp(100 - (w.spread / 0.14) * 100, 0, 100));
}

export const tierDamageMult = (tier: number) => 1 + 0.18 * (Math.max(1, tier) - 1);

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
export interface GenerateOpts {
  archetype?: WeaponArchetype;
  rarity?: Rarity;
  rarityBoost?: number;
  minRarity?: Rarity;
  /** Force this element (sponsor "elementsOnly"); 'none' forces a plain gun. */
  element?: Element;
}

export function generateWeapon(rng: Rng, nextId: (p: string) => string, tier: number, opts: GenerateOpts = {}): WeaponDef {
  tier = Math.max(1, Math.floor(tier));
  const archetype = opts.archetype ?? pick(rng, ARCHETYPE_LIST);
  const rarity = opts.rarity ?? rollRarity(rng, tier, opts.rarityBoost ?? 0, opts.minRarity ?? 'common');
  const base = ARCHETYPES[archetype];
  const rIdx = RARITY_ORDER.indexOf(rarity);

  // ±15 % per-stat rolls
  const roll = () => randRange(rng, -0.15, 0.15);
  const rolls = { damage: randRange(rng, -0.08, 0.08), fireRate: roll(), magSize: roll(), reload: roll(), spread: roll() };

  const damage = base.damage * RARITY_BUDGET[rarity] * tierDamageMult(tier) * (1 + rolls.damage);
  const fireRate = base.fireRate * (1 + rolls.fireRate);
  const magSize = Math.max(2, Math.round(base.magSize * (1 + rolls.magSize)));
  const reloadTime = base.reloadTime * (1 - rolls.reload);
  const spread = base.spread * (1 - rolls.spread);

  // Element
  let element: Element = 'none';
  if (opts.element !== undefined) element = opts.element;
  else if (rng() < ELEMENT_CHANCE[rarity]) element = pick(rng, ['fire', 'shock', 'ice'] as const);
  const elementChance = element === 'none'
    ? 0
    : round2(THREE.MathUtils.clamp(0.25 + 0.0625 * rIdx + randRange(rng, -0.03, 0.03), 0.25, 0.5));

  // Perks
  const [pMin, pMax] = PERK_COUNT[rarity];
  const perkCount = randInt(rng, pMin, pMax);
  const pool = PERKS.slice();
  const perks: WeaponPerk[] = [];
  for (let i = 0; i < perkCount && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    perks.push({ ...pool.splice(idx, 1)[0] });
  }

  // Name
  const mfr = pick(rng, MANUFACTURERS);
  let prefix: string;
  if (element !== 'none') {
    prefix = pick(rng, ELEMENT_PREFIX[element]);
  } else {
    const best = (Object.keys(rolls) as (keyof typeof rolls)[]).reduce((a, b) => (rolls[b] > rolls[a] ? b : a));
    prefix = pick(rng, STAT_PREFIX[best]);
  }
  const name = rarity === 'legendary'
    ? `★ ${prefix} ${mfr} ${pick(rng, LEGENDARY_FLAIR)}`
    : `${prefix} ${mfr} ${pick(rng, NOUNS[archetype])}`;

  return {
    id: nextId('w'),
    name,
    archetype,
    rarity,
    element,
    level: tier,
    damage: round2(damage),
    fireRate: round2(fireRate),
    auto: base.auto,
    magSize,
    reloadTime: round2(reloadTime),
    pellets: base.pellets,
    spread: round3(spread),
    range: base.range,
    critMultiplier: base.critMultiplier,
    elementChance,
    perks,
    color: blendColor(RARITY_COLORS[rarity], ELEMENT_COLORS[element], 0.4),
  };
}

export function starterWeapon(nextId: (p: string) => string): WeaponDef {
  const b = ARCHETYPES.pistol;
  return {
    id: nextId('w'),
    name: 'Rusty Iron',
    archetype: 'pistol',
    rarity: 'common',
    element: 'none',
    level: 1,
    damage: b.damage,
    fireRate: b.fireRate,
    auto: b.auto,
    magSize: b.magSize,
    reloadTime: b.reloadTime,
    pellets: b.pellets,
    spread: b.spread,
    range: b.range,
    critMultiplier: b.critMultiplier,
    elementChance: 0,
    perks: [],
    color: 0x9a8f80,
  };
}
