import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { RARITY_ORDER, type Rarity, type WeaponArchetype, type WeaponDef } from '@/core/types';
import {
  ARCHETYPES, ARCHETYPE_LIST, PERKS, RARITY_BUDGET, generateWeapon, rarityWeights, rollRarity, starterWeapon,
  tierDamageMult, weaponAccuracy, weaponDps,
} from '@/loot/weapons';

const PERK_IDS = new Set(PERKS.map((p) => p.id));
const PERK_COUNT: Record<Rarity, [number, number]> = {
  common: [0, 0], uncommon: [0, 0], rare: [1, 1], epic: [1, 2], legendary: [2, 2],
};

function makeIds() {
  let n = 0;
  return (p: string) => `${p}_${++n}`;
}

/** 1000 weapons for each tier 1..10, seeded. */
function corpus(): { tier: number; w: WeaponDef }[] {
  const rng = createRng(0xbeef);
  const ids = makeIds();
  const out: { tier: number; w: WeaponDef }[] = [];
  for (let tier = 1; tier <= 10; tier++) {
    for (let i = 0; i < 1000; i++) out.push({ tier, w: generateWeapon(rng, ids, tier) });
  }
  return out;
}

const ALL = corpus();
const EPS = 0.011;

describe('generateWeapon invariants (10 000 weapons, tiers 1..10)', () => {
  it('ids are unique and level equals the tier', () => {
    expect(new Set(ALL.map((x) => x.w.id)).size).toBe(ALL.length);
    expect(ALL.filter(({ tier, w }) => w.level !== tier).length).toBe(0);
  });

  it('archetype-fixed stats come straight from the archetype table', () => {
    const bad = ALL.filter(({ w }) => {
      const b = ARCHETYPES[w.archetype];
      return w.pellets !== b.pellets || w.range !== b.range || w.critMultiplier !== b.critMultiplier || w.auto !== b.auto;
    });
    expect(bad.length).toBe(0);
  });

  it('rolled stats stay within the per-archetype × rarity × tier ranges', () => {
    const bad: string[] = [];
    for (const { tier, w } of ALL) {
      const b = ARCHETYPES[w.archetype];
      const dmgBase = b.damage * RARITY_BUDGET[w.rarity] * tierDamageMult(tier);
      const checks: [string, number, number, number][] = [
        ['damage', w.damage, dmgBase * 0.92 - EPS, dmgBase * 1.08 + EPS],
        ['fireRate', w.fireRate, b.fireRate * 0.85 - EPS, b.fireRate * 1.15 + EPS],
        ['magSize', w.magSize, Math.max(2, Math.round(b.magSize * 0.85)), Math.round(b.magSize * 1.15)],
        ['reloadTime', w.reloadTime, b.reloadTime * 0.85 - EPS, b.reloadTime * 1.15 + EPS],
        ['spread', w.spread, b.spread * 0.85 - 0.0006, b.spread * 1.15 + 0.0006],
      ];
      for (const [name, val, lo, hi] of checks) {
        if (!(val >= lo && val <= hi)) bad.push(`${w.archetype}/${w.rarity}/t${tier} ${name}=${val} not in [${lo}, ${hi}]`);
      }
      if (!Number.isInteger(w.magSize)) bad.push(`magSize not integer: ${w.magSize}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('every archetype and every rarity actually occurs', () => {
    const arch = new Set(ALL.map((x) => x.w.archetype));
    const rar = new Set(ALL.map((x) => x.w.rarity));
    expect([...arch].sort()).toEqual([...ARCHETYPE_LIST].sort());
    expect([...rar].sort()).toEqual([...RARITY_ORDER].sort());
  });

  it('perks: known ids only, no duplicates, count by rarity', () => {
    const bad: string[] = [];
    for (const { w } of ALL) {
      const ids = w.perks.map((p) => p.id);
      if (!ids.every((id) => PERK_IDS.has(id))) bad.push(`unknown perk in ${ids}`);
      if (new Set(ids).size !== ids.length) bad.push(`duplicate perk in ${ids}`);
      const [lo, hi] = PERK_COUNT[w.rarity];
      if (ids.length < lo || ids.length > hi) bad.push(`${w.rarity} has ${ids.length} perks`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('perk objects are copies (mutating one weapon does not touch the PERKS table)', () => {
    const w = ALL.find((x) => x.w.perks.length > 0)!.w;
    const before = PERKS.find((p) => p.id === w.perks[0].id)!.name;
    w.perks[0].name = 'mutated';
    expect(PERKS.find((p) => p.id === w.perks[0].id)!.name).toBe(before);
    w.perks[0].name = before;
  });

  it('element rules: common never elemental, legendary always; chance 0 iff none, else 0.25..0.5', () => {
    const bad: string[] = [];
    for (const { w } of ALL) {
      if (w.rarity === 'common' && w.element !== 'none') bad.push('elemental common');
      if (w.rarity === 'legendary' && w.element === 'none') bad.push('plain legendary');
      if (w.element === 'none' && w.elementChance !== 0) bad.push(`none with chance ${w.elementChance}`);
      if (w.element !== 'none' && !(w.elementChance >= 0.25 && w.elementChance <= 0.5)) bad.push(`chance ${w.elementChance}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // higher rarity → more elemental weapons
    const frac = (r: Rarity) => {
      const of = ALL.filter((x) => x.w.rarity === r);
      return of.filter((x) => x.w.element !== 'none').length / of.length;
    };
    expect(frac('uncommon')).toBeLessThan(frac('rare'));
    expect(frac('rare')).toBeLessThan(frac('epic'));
  });

  it('names: non-empty three-part names; legendaries (and only they) carry ★', () => {
    const bad = ALL.map((x) => x.w).filter((w) =>
      w.name.trim().length === 0
      || (w.rarity === 'legendary') !== w.name.startsWith('★ ')
      || (w.rarity !== 'legendary' && w.name.includes('★'))
      || w.name.split(' ').length < 3).map((w) => `${w.rarity}: "${w.name}"`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('colour is a valid 24-bit integer', () => {
    const bad = ALL.filter(({ w }) => !Number.isInteger(w.color) || w.color < 0 || w.color > 0xffffff);
    expect(bad.length).toBe(0);
  });

  it('damage relative to the archetype base grows monotonically with tier on average', () => {
    const avg: number[] = [];
    for (let t = 1; t <= 10; t++) {
      const of = ALL.filter((x) => x.tier === t);
      avg.push(of.reduce((s, x) => s + x.w.damage / ARCHETYPES[x.w.archetype].damage, 0) / of.length);
    }
    for (let i = 1; i < avg.length; i++) expect(avg[i]).toBeGreaterThan(avg[i - 1]);
  });

  it('is deterministic for a given rng seed', () => {
    const a = generateWeapon(createRng(5), makeIds(), 4);
    const b = generateWeapon(createRng(5), makeIds(), 4);
    expect(a).toEqual(b);
  });

  it('honours forced archetype and rarity, and clamps tier to >= 1 integer', () => {
    const rng = createRng(1);
    const ids = makeIds();
    for (const archetype of ARCHETYPE_LIST) {
      const w = generateWeapon(rng, ids, 3, { archetype, rarity: 'epic' });
      expect(w.archetype).toBe(archetype);
      expect(w.rarity).toBe('epic');
    }
    expect(generateWeapon(rng, ids, 0).level).toBe(1);
    expect(generateWeapon(rng, ids, 3.7).level).toBe(3);
  });

  it('minRarity is a floor', () => {
    const rng = createRng(3);
    const ids = makeIds();
    for (let i = 0; i < 300; i++) {
      const w = generateWeapon(rng, ids, 1, { minRarity: 'rare' });
      expect(RARITY_ORDER.indexOf(w.rarity)).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('rarity weights', () => {
  it('common weight falls and higher tiers rise as tier increases', () => {
    let prev = rarityWeights(1);
    for (let t = 2; t <= 12; t++) {
      const w = rarityWeights(t);
      expect(w.common).toBeLessThanOrEqual(prev.common);
      expect(w.rare).toBeGreaterThan(prev.rare);
      expect(w.epic).toBeGreaterThan(prev.epic);
      expect(w.legendary).toBeGreaterThan(prev.legendary);
      prev = w;
    }
    expect(rarityWeights(50).common).toBeGreaterThan(0); // floored, never negative
  });

  it('rarityBoost shifts weight from common/uncommon to rare+ (and is clamped to 0..1)', () => {
    const a = rarityWeights(3, 0);
    const b = rarityWeights(3, 0.5);
    expect(b.common).toBeLessThan(a.common);
    expect(b.uncommon).toBeLessThan(a.uncommon);
    expect(b.rare).toBeGreaterThan(a.rare);
    expect(b.legendary).toBeGreaterThan(a.legendary);
    expect(rarityWeights(3, 5)).toEqual(rarityWeights(3, 1));
    expect(rarityWeights(3, -1)).toEqual(rarityWeights(3, 0));
  });

  it('rolled distribution moves up with tier and boost', () => {
    const share = (tier: number, boost: number) => {
      const rng = createRng(tier * 31 + Math.round(boost * 100));
      let hi = 0;
      for (let i = 0; i < 4000; i++) if (RARITY_ORDER.indexOf(rollRarity(rng, tier, boost)) >= 2) hi++;
      return hi / 4000;
    };
    expect(share(10, 0)).toBeGreaterThan(share(1, 0) + 0.1);
    expect(share(1, 0.5)).toBeGreaterThan(share(1, 0) + 0.1);
  });

  it('rollRarity never returns below minRarity', () => {
    const rng = createRng(11);
    for (let i = 0; i < 500; i++) expect(rollRarity(rng, 1, 0, 'epic')).toMatch(/epic|legendary/);
  });

  it('rollRarity handles rng() edge values', () => {
    expect(rollRarity(() => 0, 1)).toBe('common');
    expect(rollRarity(() => 0.999999999, 1)).toBe('legendary');
  });
});

describe('starterWeapon & helpers', () => {
  it('starter is a fixed common pistol', () => {
    const w = starterWeapon(makeIds());
    expect(w).toMatchObject({
      name: 'Rusty Iron', archetype: 'pistol', rarity: 'common', element: 'none', level: 1,
      damage: ARCHETYPES.pistol.damage, fireRate: ARCHETYPES.pistol.fireRate, magSize: ARCHETYPES.pistol.magSize,
      elementChance: 0, perks: [],
    });
    const again = starterWeapon(makeIds());
    expect({ ...again, id: '' }).toEqual({ ...w, id: '' });
  });

  it('weaponDps / weaponAccuracy', () => {
    const w = starterWeapon(makeIds());
    expect(weaponDps(w)).toBeCloseTo(22 * 1 * 4);
    expect(weaponAccuracy({ ...w, spread: 0 })).toBe(100);
    expect(weaponAccuracy({ ...w, spread: 1 })).toBe(0);
    const arch: WeaponArchetype[] = ['sniper', 'pistol', 'rifle', 'smg', 'shotgun'];
    const acc = arch.map((a) => weaponAccuracy({ ...w, spread: ARCHETYPES[a].spread }));
    for (let i = 1; i < acc.length; i++) expect(acc[i]).toBeLessThanOrEqual(acc[i - 1]);
  });
});
