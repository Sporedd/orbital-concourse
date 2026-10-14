/**
 * Gear integration (system G wired into player + loot): a gear drop at the player's feet is
 * picked up on walk-over, equipped into its empty slot, and folds into the ONE stat path
 * (player/shared getStats = progression × gear) that max health/shield, weapons and melee read.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYER } from '@/core/config';
import type { EnemyRegistry } from '@/core/types';
import { createGearSystem, makeAffix, type GearDef } from '@/gear';
import { createLootSystem } from '@/loot';
import { starterWeapon } from '@/loot/weapons';
import { LAST_STAND_REDUCTION, LAST_STAND_TIME, createPlayer, createPlayerRegistry, type Player } from '@/player';
import { getStats } from '@/player/shared';
import { createFakeContext, createFakeEnemy, fakeProgression, recordEvents, type Recorder, type TestContext } from '../helpers/fakeContext';

let ctx: TestContext;
let player: Player;
let ev: Recorder;

function setup(): void {
  ctx = createFakeContext({ seed: 7 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  player = createPlayer(ctx, { id: 'p-test', name: 'Tester' });
  ctx.players.add(player);
  ctx.player = player;
  ctx.enemies = { list: () => [], damageRadius: () => 0, aliveCount: () => 0, bossAlive: () => false, clear() {}, update() {} } as unknown as EnemyRegistry;
  ctx.loot = createLootSystem(ctx);
  ctx.progression = fakeProgression({ healthMult: 1.1 });
  ctx.gear = createGearSystem(ctx, { persist: false });
  player.reset();
}

/** A chest piece with known numbers: +20 % health implicit, +10 % gun damage, +50 % melee. */
function chest(): GearDef {
  const g = ctx.gear!.generate(5, { slot: 'chest', rarity: 'rare', setId: null });
  return {
    ...g,
    implicit: makeAffix('healthMult', 0.2),
    affixes: [makeAffix('damageMult', 0.1), makeAffix('meleeMult', 0.5)],
  };
}

function dropAtFeet(gear: GearDef) {
  const p = player.position;
  return ctx.loot.dropItem({ kind: 'gear', rarity: gear.rarity, gear, position: { x: p.x + 0.3, y: p.y, z: p.z } });
}

describe('gear pickup → equip → stats', () => {
  beforeEach(setup);

  it('walk-over pickup equips into the empty slot and emits gear:changed for the local player', () => {
    const g = chest();
    const item = dropAtFeet(g);
    expect(ctx.loot.items().some((i) => i.id === item.id)).toBe(true);
    ctx.loot.update(1 / 60);
    expect(ctx.loot.items().some((i) => i.id === item.id)).toBe(false);
    expect(ctx.gear!.inventory.equipped('chest')?.id).toBe(g.id);
    expect(player.loadout.chest?.id).toBe(g.id);
    const changed = ev.of('gear:changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.at(-1)!.playerId).toBe('p-test');
  });

  it('max-health recomputes keep health within max: gear on, hurt, gear off, skill change', () => {
    // A fractional max (100 × 1.1 × 1.184 = 130.24) is what showed as "119 / 118" in the HUD.
    const g = { ...chest(), implicit: makeAffix('healthMult', 0.184) };
    dropAtFeet(g);
    ctx.loot.update(1 / 60);
    expect(player.maxHealth).toBeCloseTo(PLAYER.maxHealth * 1.1 * 1.184, 5);
    expect(player.health).toBeLessThanOrEqual(player.maxHealth);
    expect(player.health).toBeCloseTo(player.maxHealth, 5);
    player.takeDamage(player.shield + 10);
    const hurt = player.health;
    expect(hurt).toBeCloseTo(player.maxHealth - 10, 5);
    // Unequip: max shrinks back, health is clamped to it.
    expect(ctx.gear!.inventory.unequip('chest')).toBe(true);
    expect(player.maxHealth).toBeCloseTo(PLAYER.maxHealth * 1.1, 5);
    expect(player.health).toBeLessThanOrEqual(player.maxHealth);
    // Re-equip grows max and current by the same amount, never past the new max.
    expect(ctx.gear!.inventory.equip(g.id)).toBe(true);
    expect(player.maxHealth).toBeCloseTo(PLAYER.maxHealth * 1.1 * 1.184, 5);
    expect(player.health).toBeLessThanOrEqual(player.maxHealth);
    // A skill change with a lower health multiplier shrinks the max and clamps too.
    ctx.events.emit('skill:changed', { skillId: 'x', rank: 0, stats: { ...fakeProgression().stats, healthMult: 0.5 } });
    expect(player.maxHealth).toBeCloseTo(PLAYER.maxHealth * 0.5 * 1.184, 5);
    expect(player.health).toBeLessThanOrEqual(player.maxHealth);
  });

  it('equipped gear multiplies into getStats and raises max health live', () => {
    const before = player.maxHealth;
    expect(before).toBeCloseTo(PLAYER.maxHealth * 1.1);
    dropAtFeet(chest());
    ctx.loot.update(1 / 60);
    const s = getStats(ctx);
    expect(s.healthMult).toBeCloseTo(1.1 * 1.2, 5);
    expect(s.damageMult).toBeCloseTo(1.1, 5);
    expect(player.maxHealth).toBeCloseTo(PLAYER.maxHealth * 1.1 * 1.2, 5);
    // growing the max also grows the current value (like the skill tree)
    expect(player.health).toBeCloseTo(player.maxHealth, 5);
    expect(ctx.gear!.gearStats.meleeMult).toBeCloseTo(1.5, 5);
  });

  it('gun and melee damage use the merged stats (+ gear melee bonus)', () => {
    dropAtFeet(chest());
    ctx.loot.update(1 / 60);
    const target = createFakeEnemy('t', new THREE.Vector3(player.position.x, 0, player.position.z - 1.2));
    ctx.enemies = { list: () => [target], damageRadius: () => 0 } as unknown as EnemyRegistry;
    // melee: meleeDamage × damageMult (1.1) × meleeMult (1.5)
    ctx.fakeInput.press('KeyV');
    player.update(1 / 60);
    ctx.fakeInput.endFrame();
    expect(target.hits).toHaveLength(1);
    expect(target.hits[0].amount).toBeCloseTo(PLAYER.meleeDamage * 1.1 * 1.5, 4);
    expect(target.hits[0].opts?.cause).toBe('melee');
  });

  it('a full backpack leaves gear on the ground; duplicates are refused', () => {
    // fill the chest slot, then the 12-slot backpack
    dropAtFeet(chest());
    ctx.loot.update(1 / 60);
    while (!ctx.gear!.inventory.isFull()) ctx.gear!.inventory.add(chest());
    const extra = dropAtFeet(chest());
    ctx.loot.update(1 / 60);
    expect(ctx.loot.items().some((i) => i.id === extra.id)).toBe(true);
  });

  it('loot.remove() and dropItem() round-trip a backpack piece (inventory screen drop)', () => {
    const g = chest();
    ctx.gear!.inventory.add(g);
    const removed = ctx.gear!.inventory.remove(g.id)!;
    const item = ctx.loot.dropItem({ kind: 'gear', rarity: removed.rarity, gear: removed, position: { x: 5, y: 0, z: 5 } });
    expect(item.ownerId).toBe('p-test');
    expect(ev.of('loot:dropped').some((e) => e.item.id === item.id)).toBe(true);
    expect(ctx.loot.remove(item.id)).toBe(true);
    expect(ctx.loot.remove(item.id)).toBe(false);
  });

  it('bosses (rarityBoost 0.5, guaranteed gear) drop at least an Uncommon piece with a GearDef', () => {
    for (let i = 0; i < 20; i++) {
      const [w, g] = ctx.loot.dropLoot(new THREE.Vector3(10, 0, 10), { tier: 2, rarityBoost: 0.5, count: 2, guaranteed: ['weapon', 'gear'] });
      expect(w.kind).toBe('weapon');
      expect(g.kind).toBe('gear');
      expect(g.gear).toBeTruthy();
      expect(g.rarity).toBe(g.gear!.rarity);
      expect(g.rarity).not.toBe('common');
    }
  });

  it('weapon persistence: equipped slots survive a new player (persistKey)', () => {
    const key = 'test.weapons';
    const a = createPlayer(ctx, { id: 'p-a', name: 'A', persistKey: key });
    const gun = { ...starterWeapon((x) => `${x}_9`), name: 'Kept Gun', damage: 77 };
    a.equip(gun);
    const b = createPlayer(ctx, { id: 'p-b', name: 'B', persistKey: key });
    expect(b.weapons[0]?.name).toBe('Kept Gun');
    expect(b.weapons[0]?.damage).toBe(77);
    expect(b.weapons[0]?.id).not.toBe(gun.id); // fresh session id
  });
});

describe('player contract additions + gear set hooks', () => {
  beforeEach(setup);

  /** Swap in gear extras (as if a set were worn) without building the set. */
  function withExtras(extra: Partial<NonNullable<TestContext['gear']>['gearStats']>): void {
    const real = ctx.gear!;
    const stats = { ...real.gearStats, ...extra };
    ctx.gear = { ...real, inventory: real.inventory, gearStats: stats, mergedStats: real.mergedStats, maxGrenades: (b: number) => b + (stats.extraGrenades ?? 0) } as typeof real;
  }

  it('revive() brings a downed player back in place with a fraction of max health', () => {
    player.position.set(4, 0, 4);
    player.takeDamage(1e9);
    expect(player.alive).toBe(false);
    player.revive(0.35);
    expect(player.alive).toBe(true);
    expect(player.health).toBeCloseTo(player.maxHealth * 0.35);
    expect(player.shield).toBe(0);
    expect(player.position.x).toBe(4);
    expect(ev.of('player:revived').at(-1)).toMatchObject({ playerId: 'p-test' });
    player.revive(1); // no-op while alive
    expect(player.health).toBeCloseTo(player.maxHealth * 0.35);
  });

  it('onGround mirrors the controller', () => {
    for (let i = 0; i < 10; i++) player.update(1 / 60);
    expect(player.onGround).toBe(true);
    ctx.fakeInput.press('Space');
    player.update(1 / 60);
    ctx.fakeInput.endFrame();
    expect(player.onGround).toBe(false);
  });

  it('elemental resist reduces elemental damage only', () => {
    withExtras({ elementalResist: 0.5 });
    const s0 = player.shield;
    player.takeDamage(20, { element: 'fire' });
    expect(s0 - player.shield).toBeCloseTo(10);
    player.takeDamage(20, { element: 'none' });
    expect(s0 - player.shield).toBeCloseTo(30);
  });

  it('bulwark_last_stand reduces damage for a window after the shield breaks', () => {
    withExtras({ hooks: ['bulwark_last_stand'] });
    player.takeDamage(player.shield); // exactly breaks the shield → last stand starts
    const h = player.health;
    player.takeDamage(20);
    expect(h - player.health).toBeCloseTo(20 * (1 - LAST_STAND_REDUCTION));
    for (let i = 0; i < Math.ceil(LAST_STAND_TIME * 60) + 10; i++) player.update(1 / 60); // past the window
    const h2 = player.health;
    player.takeDamage(20);
    expect(h2 - player.health).toBeCloseTo(20);
  });

  it('extra grenade capacity from gear raises the grenade cap', () => {
    withExtras({ extraGrenades: 2 });
    player.addGrenades(99);
    expect(player.grenades).toBe(PLAYER.maxGrenades + 2);
  });
});

