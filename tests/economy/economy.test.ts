/**
 * Economy milestone (PLAN §13, docs/ECONOMY.md): salvage math, wallet persistence, shop stock
 * generation + league gating, the four gear upgrades, and the economy system wired to a real
 * loot system + gear inventory (expiry salvage, [F] salvage, bounty, buy, reroll, upgrade).
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { ECONOMY, LOOT } from '@/core/config';
import { createRng } from '@/core/rng';
import { RARITY_ORDER, type Rarity } from '@/core/types';
import {
  AFFIX_COUNT, LEVEL_BONUS, affixRange, ascend, augment, createGearSystem, gearPrice, generateGear, generateStock,
  growthForLevel, levelMult, loadShop, reinforce, rerollFee, retune, rollShopRarity, roundBounty, saveShop,
  salvageValue, shopRarityCap, shopRarityWeights, shopTier, upgradeBlocker, upgradeCost, Wallet, WALLET_STORAGE_KEY,
  gearPalette, type GearDef,
} from '@/gear';
import { createEconomy, type EconomySystem } from '@/gear/economy';
import { createLootSystem } from '@/loot';
import { generateWeapon, starterWeapon } from '@/loot/weapons';
import { createPlayerRegistry } from '@/player';
import { MemoryStorage } from '../setup';
import { createFakeContext, createFakePlayer, recordEvents, type Recorder, type TestContext } from '../helpers/fakeContext';

const ids = () => {
  let n = 0;
  return (p: string) => `${p}${++n}`;
};

// ---------------------------------------------------------------------------
describe('economy math', () => {
  it('salvage = 10 × rarity mult (1/2/4/8/16) × (1 + 0.15·(level − 1))', () => {
    expect(salvageValue('common', 1)).toBe(10);
    expect(salvageValue('uncommon', 1)).toBe(20);
    expect(salvageValue('rare', 1)).toBe(40);
    expect(salvageValue('epic', 1)).toBe(80);
    expect(salvageValue('legendary', 1)).toBe(160);
    expect(salvageValue('common', 5)).toBe(16); // 10 × 1.6
    expect(salvageValue('rare', 11)).toBe(100); // 40 × 2.5
    expect(salvageValue('common', 0)).toBe(10); // level clamps to 1
    for (let i = 1; i < RARITY_ORDER.length; i++) {
      expect(salvageValue(RARITY_ORDER[i], 3)).toBeGreaterThan(salvageValue(RARITY_ORDER[i - 1], 3));
    }
  });

  it('round bounty = 25 + 10·round', () => {
    expect(roundBounty(1)).toBe(35);
    expect(roundBounty(4)).toBe(65);
  });

  it('prices, reroll fee and upgrade costs follow the documented formulas', () => {
    expect(gearPrice({ rarity: 'common', level: 1 })).toBe(40);
    expect(gearPrice({ rarity: 'rare', level: 3 })).toBe(Math.round(40 * 4 * 1.3));
    expect(rerollFee(1)).toBe(15);
    expect(rerollFee(5)).toBe(24);
    expect(upgradeCost('reinforce', { rarity: 'common', level: 1 })).toBe(15);
    expect(upgradeCost('reinforce', { rarity: 'epic', level: 6 })).toBe(Math.round(15 * 8 * 1.18 ** 5));
    expect(upgradeCost('retune', { rarity: 'uncommon', level: 2 })).toBe(Math.round(10 * 2 * 1.15));
    expect(upgradeCost('augment', { rarity: 'rare', level: 3 })).toBe(Math.round(60 * 4 * 1.3));
    expect(upgradeCost('ascend', { rarity: 'epic', level: 5 })).toBe(Math.round(250 * 8 * 1.6));
    // reinforce cost grows with level
    for (let L = 2; L < 30; L++) {
      expect(upgradeCost('reinforce', { rarity: 'rare', level: L })).toBeGreaterThan(upgradeCost('reinforce', { rarity: 'rare', level: L - 1 }));
    }
    expect(levelMult(1)).toBe(1);
    expect(shopTier(0, 0)).toBe(1);
    expect(shopTier(7, 3)).toBe(7);
    expect(shopTier(2, 5)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('Wallet', () => {
  it('adds, spends, refuses overdrafts and persists to concourse.wallet.v1', () => {
    const storage = new MemoryStorage();
    const w = new Wallet(storage);
    const seen: [number, number, string][] = [];
    w.onChange((s, d, r) => seen.push([s, d, r]));
    expect(w.add(35, 'bounty')).toBe(35);
    expect(w.spend(50, 'purchase')).toBe(false);
    expect(w.spend(20, 'purchase')).toBe(true);
    expect(w.scrip).toBe(15);
    expect(w.add(-5)).toBe(0);
    expect(seen).toEqual([[35, 35, 'bounty'], [15, -20, 'purchase']]);
    expect(JSON.parse(storage.getItem(WALLET_STORAGE_KEY)!)).toMatchObject({ v: 1, scrip: 15, earned: 35 });

    const again = new Wallet(storage);
    expect(again.load()).toBe(true);
    expect(again.scrip).toBe(15);
    expect(again.earned).toBe(35);
  });

  it('a corrupt save loads as 0 without throwing', () => {
    const storage = new MemoryStorage();
    storage.setItem(WALLET_STORAGE_KEY, '{"v":1,"scrip":"lots"}');
    const w = new Wallet(storage);
    expect(w.load()).toBe(true);
    expect(w.scrip).toBe(0);
    storage.setItem(WALLET_STORAGE_KEY, 'not json');
    expect(new Wallet(storage).load()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('shop stock', () => {
  it('6–8 pieces at the tier, one per slot first', () => {
    const rng = createRng(99);
    for (let i = 0; i < 40; i++) {
      const stock = generateStock(rng, ids(), 4, 1);
      expect(stock.length).toBeGreaterThanOrEqual(ECONOMY.stockMin);
      expect(stock.length).toBeLessThanOrEqual(ECONOMY.stockMax);
      expect(stock.slice(0, 5).map((d) => d.slot)).toEqual(['helm', 'chest', 'boots', 'gloves', 'trinket']);
      for (const d of stock) expect(d.tier).toBe(4);
    }
  });

  it('rarity is gated by league: Scrap ≤ rare, Iron/Steel ≤ epic, Star+ legendary', () => {
    expect(shopRarityCap(0)).toBe('rare');
    expect(shopRarityCap(1)).toBe('epic');
    expect(shopRarityCap(2)).toBe('epic');
    expect(shopRarityCap(3)).toBe('legendary');
    expect(shopRarityCap(9)).toBe('legendary');
    expect(shopRarityWeights(10, 0).epic).toBe(0);
    expect(shopRarityWeights(10, 0).legendary).toBe(0);
    expect(shopRarityWeights(10, 1).legendary).toBe(0);
    const rng = createRng(5);
    const seen = (league: number) => {
      const s = new Set<Rarity>();
      for (let i = 0; i < 3000; i++) s.add(rollShopRarity(rng, 12, league));
      return s;
    };
    const scrap = seen(0);
    expect(scrap.has('epic') || scrap.has('legendary')).toBe(false);
    expect(scrap.has('rare')).toBe(true);
    const iron = seen(1);
    expect(iron.has('epic')).toBe(true);
    expect(iron.has('legendary')).toBe(false);
    expect(seen(3).has('legendary')).toBe(true);
  });

  it('save/load round-trips the stock with fresh ids', () => {
    const storage = new MemoryStorage();
    const stock = generateStock(createRng(1), ids(), 3, 0);
    saveShop(storage, { tier: 3, stock });
    const loaded = loadShop(storage, (p) => `${p}new`);
    expect(loaded!.tier).toBe(3);
    expect(loaded!.stock.map((d) => d.name)).toEqual(stock.map((d) => d.name));
    expect(loaded!.stock.every((d) => d.id === 'gnew')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('gear upgrades', () => {
  const piece = (rarity: Rarity, level = 3, seed = 7): GearDef =>
    generateGear(createRng(seed), ids(), Math.max(1, level - LEVEL_BONUS[rarity]), { rarity, slot: 'helm', setId: null });

  it('reinforce: +1 level, every value scales up, growth (the model knob) rises; same id', () => {
    const d = piece('rare', 4);
    const r = reinforce(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.id).toBe(d.id);
    expect(r.item.level).toBe(d.level + 1);
    expect(r.item.growth).toBe(growthForLevel(d.level + 1));
    expect(r.item.growth).toBeGreaterThan(d.growth);
    expect(r.item.implicit.value).toBeGreaterThan(d.implicit.value);
    r.item.affixes.forEach((a, i) => expect(a.value).toBeGreaterThanOrEqual(d.affixes[i].value));
    expect(d.level).toBe(4); // the original is untouched
    // capped at the max item level
    const maxed = { ...d, level: ECONOMY.maxItemLevel };
    expect(reinforce(maxed).ok).toBe(false);
    expect(upgradeBlocker('reinforce', maxed)).toMatch(/MAX/);
  });

  it('retune rerolls one value inside its range (implicit = index 0)', () => {
    const d = piece('epic', 6);
    const rng = createRng(3);
    for (let idx = 0; idx <= d.affixes.length; idx++) {
      for (let k = 0; k < 20; k++) {
        const r = retune(d, idx, rng);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        const a = idx === 0 ? r.item.implicit : r.item.affixes[idx - 1];
        const before = idx === 0 ? d.implicit : d.affixes[idx - 1];
        expect(a.stat).toBe(before.stat);
        const [lo, hi] = affixRange(a.stat, d.level, d.rarity, idx === 0);
        expect(a.value).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(a.value).toBeLessThanOrEqual(hi + 1e-9);
        // other values untouched
        if (idx !== 0) expect(r.item.implicit.value).toBe(d.implicit.value);
      }
    }
    expect(retune(d, 99, rng).ok).toBe(false);
  });

  it('augment adds an affix (no duplicate stat) up to the rarity cap', () => {
    let d = piece('rare', 3);
    d = { ...d, affixes: d.affixes.slice(0, 1) };
    const rng = createRng(11);
    const r = augment(d, rng);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.affixes).toHaveLength(2);
    expect(new Set(r.item.affixes.map((a) => a.stat)).size).toBe(2);
    expect(r.item.affixes.length).toBe(AFFIX_COUNT.rare);
    const again = augment(r.item, rng);
    expect(again.ok).toBe(false);
    expect(upgradeBlocker('augment', r.item)).toMatch(/CAP/);
  });

  it('ascend raises rarity one step (level bonus + budget), legendary is the cap', () => {
    const d = piece('uncommon', 3);
    const r = ascend(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.rarity).toBe('rare');
    expect(r.item.level).toBe(d.level + LEVEL_BONUS.rare - LEVEL_BONUS.uncommon);
    expect(r.item.implicit.value).toBeGreaterThan(d.implicit.value);
    expect(r.item.accent).toBe(gearPalette.gearAccentColor('rare', d.element));
    expect(upgradeBlocker('augment', r.item)).toBeNull(); // a free affix slot opened
    const leg = ascend({ ...piece('epic', 5) });
    expect(leg.ok && leg.item.rarity).toBe('legendary');
    expect(leg.ok && leg.item.name.startsWith('★')).toBe(true);
    if (leg.ok) expect(ascend(leg.item).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('class starter weapon', () => {
  it('starterWeapon(archetype) is a common level-1 gun of that archetype; default pistol', () => {
    const def = starterWeapon(ids());
    expect(def.archetype).toBe('pistol');
    expect(def.name).toBe('Rusty Iron');
    for (const a of ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'] as const) {
      const w = starterWeapon(ids(), a);
      expect(w.archetype).toBe(a);
      expect(w.rarity).toBe('common');
      expect(w.level).toBe(1);
      expect(w.perks).toEqual([]);
    }
    expect(starterWeapon(ids(), 'shotgun').pellets).toBeGreaterThan(1);
  });

  it('generateWeapon honours opts.archetype', () => {
    const rng = createRng(4);
    for (let i = 0; i < 20; i++) expect(generateWeapon(rng, ids(), 3, { archetype: 'sniper' }).archetype).toBe('sniper');
  });
});

// ---------------------------------------------------------------------------
describe('economy system (real loot + gear)', () => {
  let ctx: TestContext;
  let ev: Recorder;
  let eco: EconomySystem;
  let storage: MemoryStorage;

  function setup(): void {
    ctx = createFakeContext({ seed: 2024 });
    ev = recordEvents(ctx.events);
    ctx.players = createPlayerRegistry();
    const p = createFakePlayer('p1', new THREE.Vector3(0, 0, 0), true);
    ctx.players.add(p);
    ctx.player = p;
    ctx.loot = createLootSystem(ctx);
    ctx.gear = createGearSystem(ctx, { persist: false });
    storage = new MemoryStorage();
    eco = createEconomy(ctx, ctx.gear, { storage, bestRound: () => 3 });
    ctx.economy = eco;
  }
  beforeEach(setup);

  const dropWeaponAt = (x: number, z: number, ownerId = 'p1', rarity: Rarity = 'rare') => {
    const weapon = generateWeapon(ctx.rng, ctx.nextId, 2, { rarity });
    return ctx.loot.dropItem({ kind: 'weapon', rarity, weapon, position: { x, y: 0, z }, ownerId });
  };

  it('a local weapon that expires on the floor is salvaged into scrip; others are not', () => {
    const mine = dropWeaponAt(20, 20);
    dropWeaponAt(20, -20, 'p2');
    ctx.loot.update(LOOT.lifetime + 1);
    expect(ctx.loot.items()).toHaveLength(0);
    const value = salvageValue('rare', mine.weapon!.level);
    expect(eco.scrip).toBe(value);
    expect(ev.of('wallet:changed')).toEqual([{ scrip: value, delta: value, reason: 'expired' }]);
    expect(ev.of('loot:salvaged')[0]).toMatchObject({ itemId: mine.id, value, manual: false });
    expect(JSON.parse(storage.getItem(WALLET_STORAGE_KEY)!).scrip).toBe(value);
  });

  it('[F] on the weapon prompt salvages it (removes it, pays, clears the prompt)', () => {
    const item = dropWeaponAt(0.5, 0);
    ctx.loot.update(0.016); // → loot:nearby
    expect(eco.nearbyWeapon?.id).toBe(item.id);
    ctx.fakeInput.press('KeyF');
    eco.update(0.016);
    ctx.fakeInput.endFrame();
    expect(ctx.loot.items().some((i) => i.id === item.id)).toBe(false);
    expect(eco.scrip).toBe(salvageValue('rare', item.weapon!.level));
    expect(eco.nearbyWeapon).toBeNull();
    expect(ev.of('loot:salvaged').at(-1)).toMatchObject({ manual: true });
    expect(ev.of('loot:nearby').at(-1)!.item).toBeNull();
  });

  it('the pit stop (phase cleared) freezes loot ageing', () => {
    ctx.rounds = { state: { phase: 'cleared' } } as unknown as TestContext['rounds'];
    const item = dropWeaponAt(20, 20);
    ctx.loot.update(LOOT.lifetime * 2);
    expect(ctx.loot.items().some((i) => i.id === item.id)).toBe(true);
    expect(item.age).toBe(0);
    expect(eco.scrip).toBe(0);
  });

  it('round clear pays the bounty and restocks the shop for free', () => {
    const before = eco.stock.map((d) => d.id);
    ctx.events.emit('round:cleared', { round: 2 });
    expect(eco.scrip).toBe(roundBounty(2));
    expect(ev.of('wallet:changed').at(-1)).toMatchObject({ delta: 45, reason: 'bounty' });
    expect(eco.stock.map((d) => d.id)).not.toEqual(before);
    expect(eco.stockTier).toBe(3); // best round 3 > live round
  });

  it('buy: scrip is charged, the piece equips into an empty slot, then the backpack; poor/full refuse', () => {
    const [a] = eco.stock;
    expect(eco.buy(a.id)).toBe('poor');
    eco.wallet.set(100_000);
    expect(eco.buy(a.id)).toBe('ok');
    expect(eco.scrip).toBe(100_000 - gearPrice(a));
    expect(ctx.gear!.inventory.equipped(a.slot)?.id).toBe(a.id);
    expect(eco.stock.some((d) => d.id === a.id)).toBe(false);
    expect(ev.of('gear:changed').length).toBeGreaterThan(0);
    // same slot again → backpack
    const same = generateGear(ctx.rng, ctx.nextId, 3, { slot: a.slot });
    (eco.stock as GearDef[]).push(same);
    expect(eco.buy(same.id)).toBe('ok');
    expect(ctx.gear!.inventory.backpack.some((d) => d.id === same.id)).toBe(true);
    // fill the backpack → refused, nothing charged
    while (!ctx.gear!.inventory.isFull()) ctx.gear!.inventory.add(generateGear(ctx.rng, ctx.nextId, 1, { slot: a.slot }));
    const extra = generateGear(ctx.rng, ctx.nextId, 3, { slot: a.slot });
    (eco.stock as GearDef[]).push(extra);
    const scrip = eco.scrip;
    expect(eco.buy(extra.id)).toBe('full');
    expect(eco.scrip).toBe(scrip);
  });

  it('reroll charges the fee and replaces the stock', () => {
    const before = eco.stock.map((d) => d.id);
    expect(eco.reroll()).toBe(false);
    eco.wallet.set(1000);
    expect(eco.reroll()).toBe(true);
    expect(eco.scrip).toBe(1000 - rerollFee(3));
    expect(eco.stock.map((d) => d.id)).not.toEqual(before);
  });

  it('upgrade: charges the cost, swaps the piece in place and emits gear:changed with the new loadout', () => {
    const helm = generateGear(ctx.rng, ctx.nextId, 2, { slot: 'helm', rarity: 'uncommon', setId: null });
    ctx.gear!.inventory.pickUp(helm);
    expect(eco.upgrade('reinforce', helm.id).ok).toBe(false); // no scrip
    eco.wallet.set(5000);
    ev.clear();
    const cost = upgradeCost('reinforce', helm);
    const r = eco.upgrade('reinforce', helm.id);
    expect(r.ok).toBe(true);
    expect(eco.scrip).toBe(5000 - cost);
    const worn = ctx.gear!.inventory.equipped('helm')!;
    expect(worn.id).toBe(helm.id);
    expect(worn.level).toBe(helm.level + 1);
    const changed = ev.of('gear:changed').at(-1)!;
    expect(changed.loadout.helm!.level).toBe(helm.level + 1);
    expect(eco.upgrade('ascend', helm.id).ok).toBe(true);
    expect(ctx.gear!.inventory.equipped('helm')!.rarity).toBe('rare');
    expect(eco.upgrade('augment', helm.id).ok).toBe(true);
    expect(ctx.gear!.inventory.equipped('helm')!.affixes.length).toBe(AFFIX_COUNT.rare);
    expect(eco.upgrade('retune', 'nope').ok).toBe(false);
  });
});
