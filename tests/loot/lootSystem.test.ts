import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOOT, PLAYER } from '@/core/config';
import { RARITY_ORDER, type LootSystem } from '@/core/types';
import { createLootSystem } from '@/loot';
import { createPlayerRegistry } from '@/player';
import {
  callsOf, createFakeContext, createFakePlayer, recordEvents, type FakePlayer, type Recorder, type TestContext,
} from '../helpers/fakeContext';

let ctx: TestContext;
let p1: FakePlayer;
let p2: FakePlayer;
let loot: LootSystem;
let ev: Recorder;

const FAR = new THREE.Vector3(-25, 0, -25);

function setup(withSecond = true): void {
  ctx = createFakeContext({ seed: 777 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  p1 = createFakePlayer('p1', new THREE.Vector3(20, 0, 20), true);
  ctx.players.add(p1);
  ctx.player = p1;
  if (withSecond) {
    p2 = createFakePlayer('p2', new THREE.Vector3(-20, 0, 20), false);
    ctx.players.add(p2);
  }
  loot = createLootSystem(ctx);
}

/** Drop one item of a kind for p1 and place it exactly at (x,z). */
function dropAt(kind: 'ammo' | 'health' | 'grenade' | 'weapon', x: number, z: number) {
  const [item] = loot.dropLoot(FAR, { tier: 1, ownerId: 'p1', guaranteed: [kind] });
  item.position.x = x;
  item.position.y = 0;
  item.position.z = z;
  return item;
}

describe('LootSystem.dropLoot', () => {
  beforeEach(() => setup());

  it('instances loot per player: one copy per player, each owned by them', () => {
    const items = loot.dropLoot(FAR, { tier: 1, guaranteed: ['ammo'] });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.ownerId).sort()).toEqual(['p1', 'p2']);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(ev.count('loot:dropped')).toBe(2);
    expect(loot.items()).toHaveLength(2);
  });

  it('only the local player sees a view for their own items', () => {
    const before = ctx.scene.children.length;
    loot.dropLoot(FAR, { tier: 1, guaranteed: ['ammo'] });
    expect(ctx.scene.children.length).toBe(before + 1);
  });

  it('ownerId restricts the drop to one player', () => {
    const items = loot.dropLoot(FAR, { tier: 1, ownerId: 'p2', count: 3 });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.ownerId === 'p2')).toBe(true);
  });

  it('count is at least the number of guaranteed kinds; guaranteed kinds come first', () => {
    const items = loot.dropLoot(FAR, { tier: 2, ownerId: 'p1', count: 1, guaranteed: ['weapon', 'health', 'grenade'] });
    expect(items.map((i) => i.kind)).toEqual(['weapon', 'health', 'grenade']);
    expect(items[0].weapon).toBeDefined();
    expect(items[0].rarity).toBe(items[0].weapon!.rarity);
    expect(items[1].weapon).toBeUndefined();
  });

  it('boss drops (boost >= 0.5) give the first guaranteed weapon at least Rare', () => {
    for (let i = 0; i < 40; i++) {
      const [w] = loot.dropLoot(FAR, { tier: 1, ownerId: 'p1', rarityBoost: 0.5, count: 4, guaranteed: ['weapon'] });
      expect(RARITY_ORDER.indexOf(w.rarity)).toBeGreaterThanOrEqual(2);
    }
  });

  it('places items around the drop point, on the ground, inside the arena', () => {
    const items = loot.dropLoot(new THREE.Vector3(31.9, 0, -31.9), { tier: 1, ownerId: 'p1', count: 5 });
    for (const it of items) {
      expect(Math.abs(it.position.x)).toBeLessThanOrEqual(31);
      expect(Math.abs(it.position.z)).toBeLessThanOrEqual(31);
      expect(it.position.y).toBe(0);
      expect(Math.hypot(it.position.x - 31, it.position.z + 31)).toBeLessThan(6);
    }
  });

  it('generateWeapon/starterWeapon proxies work', () => {
    expect(loot.generateWeapon(5, 'epic').rarity).toBe('epic');
    expect(loot.starterWeapon().name).toBe('Rusty Iron');
  });

  it('clear() removes everything (items and views)', () => {
    const before = ctx.scene.children.length;
    loot.dropLoot(FAR, { tier: 1, count: 3 });
    loot.clear();
    expect(loot.items()).toHaveLength(0);
    expect(ctx.scene.children.length).toBe(before);
  });
});

describe('LootSystem.update: expiry', () => {
  beforeEach(() => setup());

  it('items expire after LOOT.lifetime and emit loot:expired', () => {
    const items = loot.dropLoot(FAR, { tier: 1, count: 2 });
    loot.update(LOOT.lifetime - 1);
    expect(ev.count('loot:expired')).toBe(0);
    loot.update(1.01);
    expect(ev.of('loot:expired').map((e) => e.itemId).sort()).toEqual(items.map((i) => i.id).sort());
    expect(loot.items()).toHaveLength(0);
  });
});

describe('LootSystem.update: auto pickups', () => {
  beforeEach(() => setup());

  it('ammo within pickupRadius is collected (addAmmo, loot:pickup)', () => {
    const it = dropAt('ammo', 21.5, 20);
    loot.update(0.016);
    expect(callsOf(p1, 'addAmmo')).toHaveLength(1);
    expect(ev.of('loot:pickup')[0]).toMatchObject({ playerId: 'p1', item: { id: it.id } });
    expect(loot.items().find((i) => i.id === it.id)).toBeUndefined();
  });

  it('ammo outside pickupRadius stays', () => {
    dropAt('ammo', 20 + LOOT.pickupRadius + 0.2, 20);
    loot.update(0.016);
    expect(callsOf(p1, 'addAmmo')).toHaveLength(0);
    expect(loot.items()).toHaveLength(1);
  });

  it('ignores items with too large a height difference', () => {
    const it = dropAt('ammo', 20.5, 20);
    it.position.y = 3;
    loot.update(0.016);
    expect(callsOf(p1, 'addAmmo')).toHaveLength(0);
  });

  it('health is only collected when hurt', () => {
    dropAt('health', 20.5, 20);
    loot.update(0.016);
    expect(callsOf(p1, 'heal')).toHaveLength(0);
    expect(loot.items()).toHaveLength(1);
    p1.health = 50;
    loot.update(0.016);
    expect(callsOf(p1, 'heal')).toHaveLength(1);
    expect(p1.health).toBeGreaterThan(50);
    expect(loot.items()).toHaveLength(0);
  });

  it('grenades are only collected below the cap', () => {
    p1.grenades = PLAYER.maxGrenades;
    dropAt('grenade', 20.5, 20);
    loot.update(0.016);
    expect(callsOf(p1, 'addGrenades')).toHaveLength(0);
    p1.grenades = 1;
    loot.update(0.016);
    expect(callsOf(p1, 'addGrenades')).toHaveLength(1);
    expect(p1.grenades).toBe(2);
  });

  it("never picks up another player's instance", () => {
    const [mine, theirs] = loot.dropLoot(FAR, { tier: 1, guaranteed: ['ammo'] });
    for (const it of [mine, theirs]) Object.assign(it.position, { x: 20, y: 0, z: 20 });
    loot.update(0.016);
    expect(callsOf(p1, 'addAmmo')).toHaveLength(1);
    const left = loot.items();
    expect(left).toHaveLength(1);
    expect(left[0].ownerId).toBe(mine.ownerId === 'p1' ? theirs.ownerId : mine.ownerId);
  });

  it('dead players pick nothing up', () => {
    dropAt('ammo', 20, 20);
    p1.alive = false;
    loot.update(0.016);
    expect(callsOf(p1, 'addAmmo')).toHaveLength(0);
  });
});

describe('LootSystem.update: weapons and loot:nearby', () => {
  beforeEach(() => setup());

  it('emits loot:nearby only when the closest weapon changes', () => {
    const w = dropAt('weapon', 21, 20);
    for (let i = 0; i < 5; i++) loot.update(0.016);
    const near = ev.of('loot:nearby');
    expect(near).toHaveLength(1);
    expect(near[0].item!.id).toBe(w.id);

    p1.position.set(0, 0, 0); // walk away
    loot.update(0.016);
    loot.update(0.016);
    expect(ev.of('loot:nearby')).toHaveLength(2);
    expect(ev.of('loot:nearby')[1].item).toBeNull();
  });

  it('chooses the closest weapon in range', () => {
    dropAt('weapon', 21.8, 20);
    const close = dropAt('weapon', 20.3, 20);
    loot.update(0.016);
    expect(ev.of('loot:nearby').at(-1)!.item!.id).toBe(close.id);
  });

  it('weapons are not picked up without KeyE', () => {
    dropAt('weapon', 20.5, 20);
    loot.update(0.016);
    expect(callsOf(p1, 'equip')).toHaveLength(0);
  });

  it('KeyE equips into an empty slot without dropping anything', () => {
    const w = dropAt('weapon', 20.5, 20);
    ctx.fakeInput.press('KeyE');
    loot.update(0.016);
    expect(callsOf(p1, 'equip')).toHaveLength(1);
    expect(p1.weapons[0]).toBe(w.weapon);
    expect(loot.items()).toHaveLength(0);
    expect(ev.of('loot:pickup')).toHaveLength(1);
  });

  it('KeyE with full slots swaps and drops the replaced weapon just in front of the player', () => {
    const old = loot.generateWeapon(1);
    p1.weapons[0] = old;
    p1.weapons[1] = loot.generateWeapon(1);
    p1.yaw = 0; // facing -Z
    const w = dropAt('weapon', 20.5, 20);
    ev.clear();
    ctx.fakeInput.press('KeyE');
    loot.update(0.016);
    expect(p1.weapons[0]).toBe(w.weapon);
    const items = loot.items();
    expect(items).toHaveLength(1);
    expect(items[0].weapon).toBe(old);
    expect(items[0].ownerId).toBe('p1');
    expect(items[0].rarity).toBe(old.rarity);
    expect(items[0].position.z).toBeCloseTo(19.4); // 0.6 m along the view direction
    expect(ev.of('loot:dropped')).toHaveLength(1);
    // prompt is cleared immediately
    expect(ev.of('loot:nearby').at(-1)!.item).toBeNull();
  });

  it('the dropped weapon can be picked back up next frame', () => {
    p1.weapons[0] = loot.generateWeapon(1);
    p1.weapons[1] = loot.generateWeapon(1);
    dropAt('weapon', 20.5, 20);
    ctx.fakeInput.press('KeyE');
    loot.update(0.016);
    ctx.fakeInput.endFrame();
    ev.clear();
    loot.update(0.016);
    expect(ev.of('loot:nearby')).toHaveLength(1);
    expect(ev.of('loot:nearby')[0].item).not.toBeNull();
  });

  it('expiring the highlighted item clears the prompt', () => {
    dropAt('weapon', 20.5, 20);
    loot.update(0.016);
    ev.clear();
    loot.update(LOOT.lifetime);
    expect(ev.of('loot:expired')).toHaveLength(1);
    expect(ev.of('loot:nearby')).toHaveLength(1);
    expect(ev.of('loot:nearby')[0].item).toBeNull();
  });
});
