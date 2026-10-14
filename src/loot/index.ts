/**
 * System D — loot: weapon generation, drop tables, per-player loot instancing,
 * pickups (auto for consumables and gear, [E] for weapons) and the loot view.
 * Gear is meta progression (shop + upgrades, PLAN §13): no table rolls 'gear' any more, but
 * dropItem() still places existing pieces (backpack drops, co-op) and they are walk-over pickups.
 * Weapons do not age while the round sits in the pit stop (phase 'cleared'); an expiring
 * weapon is salvaged into scrip by src/gear/economy.ts (loot:expired carries the item).
 *
 * Run modifiers (system I): every drop's rarity boost gets sponsor + crowd + league added
 * (ctx.standing.dropBoost); the sponsor can force an element on weapons and turn grenade
 * drops into ammo.
 */
import * as THREE from 'three';
import { ARENA, LOOT, PLAYER } from '@/core/config';
import {
  type DropOpts, type GameContext, type LootDropSpec, type LootItemState, type LootKind, type LootSystem, type Rarity, type WeaponDef,
} from '@/core/types';
import { randRange } from '@/core/rng';
import { generateGear } from '@/gear/generator';
import { generateWeapon as genWeapon, starterWeapon as makeStarter } from './weapons';
import type { WeaponArchetype } from '@/core/types';
import { createLootView } from './view';

export { weaponDps, weaponAccuracy, ARCHETYPE_LABEL, PERKS } from './weapons';

export const HEALTH_PICKUP = 35;
export const AMMO_PICKUP = 0.5;
/** Weights for random (non-guaranteed) drop kinds. */
const KIND_WEIGHTS: [LootKind, number][] = [['weapon', 0.3], ['ammo', 0.36], ['health', 0.2], ['grenade', 0.14]];

export function createLootSystem(ctx: GameContext): LootSystem {
  const list: LootItemState[] = [];
  const view = createLootView(ctx);
  let nearbyId: string | null = null;
  const tmp = new THREE.Vector3();

  const isLocalOwned = (item: LootItemState) => !!ctx.player && item.ownerId === ctx.player.id;

  function rollKind(): LootKind {
    let r = ctx.rng() * KIND_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of KIND_WEIGHTS) {
      r -= w;
      if (r <= 0) return k;
    }
    return 'ammo';
  }

  function placeAround(center: THREE.Vector3, index: number, count: number): THREE.Vector3 {
    const spread = count > 1 ? 0.9 + 0.35 * count : randRange(ctx.rng, 0.2, 0.7);
    const ang = (index / Math.max(1, count)) * Math.PI * 2 + randRange(ctx.rng, -0.5, 0.5);
    const dist = count > 1 ? randRange(ctx.rng, 0.6, 1) * spread : spread;
    const lim = ARENA.halfSize - 1;
    const x = THREE.MathUtils.clamp(center.x + Math.cos(ang) * dist, -lim, lim);
    const z = THREE.MathUtils.clamp(center.z + Math.sin(ang) * dist, -lim, lim);
    return new THREE.Vector3(x, ctx.world.groundHeight(x, z), z);
  }

  function addItem(item: LootItemState): void {
    list.push(item);
    if (isLocalOwned(item)) view.add(item);
    ctx.events.emit('loot:dropped', { item });
  }

  function removeItem(id: string): boolean {
    const i = list.findIndex((it) => it.id === id);
    if (i >= 0) list.splice(i, 1);
    view.remove(id);
    if (id === nearbyId) setNearby(null);
    return i >= 0;
  }

  function makeItem(kind: LootKind, pos: THREE.Vector3, ownerId: string, tier: number, rarity?: Rarity, boost = 0, minRarity?: Rarity): LootItemState {
    const run = ctx.standing?.sponsors.active;
    if (kind === 'grenade' && run?.grenadeless) kind = 'ammo';
    const weapon = kind === 'weapon'
      ? genWeapon(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity, element: run?.elementsOnly })
      : undefined;
    const gear = kind === 'gear'
      ? generateGear(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity })
      : undefined;
    return {
      id: ctx.nextId('loot'),
      kind,
      rarity: weapon ? weapon.rarity : gear ? gear.rarity : 'common',
      position: { x: pos.x, y: pos.y, z: pos.z },
      ownerId,
      weapon,
      gear,
      age: 0,
    };
  }

  function dropLoot(position: THREE.Vector3, opts: DropOpts): LootItemState[] {
    const guaranteed = opts.guaranteed ?? [];
    const count = Math.max(opts.count ?? 1, guaranteed.length);
    const baseBoost = opts.rarityBoost ?? 0;
    // sponsor + crowd (hype, boos) + league bonus, clamped 0..1. The boss floors below stay keyed
    // on the caller's own boost, so a ROARING crowd does not turn every mob weapon into a Rare+.
    const boost = ctx.standing ? ctx.standing.dropBoost(baseBoost) : baseBoost;
    const owners = opts.ownerId ? [opts.ownerId] : ctx.players.list().map((p) => p.id);
    const out: LootItemState[] = [];

    for (const ownerId of owners) {
      let bossWeaponFloorUsed = false;
      for (let i = 0; i < count; i++) {
        const kind = i < guaranteed.length ? guaranteed[i] : rollKind();
        // Boss-level drops (boost >= 0.5): the first guaranteed weapon is at least Rare.
        let minRarity: Rarity | undefined;
        if (kind === 'weapon' && baseBoost >= 0.5 && i < guaranteed.length && !bossWeaponFloorUsed) {
          minRarity = 'rare';
          bossWeaponFloorUsed = true;
        }
        // ... and the guaranteed boss gear piece is at least Uncommon.
        if (kind === 'gear' && baseBoost >= 0.5 && i < guaranteed.length) minRarity = 'uncommon';
        const item = makeItem(kind, placeAround(position, i, count), ownerId, opts.tier, undefined, boost, minRarity);
        addItem(item);
        out.push(item);
      }
    }
    return out;
  }

  function dropItem(spec: LootDropSpec): LootItemState {
    const item: LootItemState = {
      ...spec,
      id: spec.id ?? ctx.nextId('loot'),
      ownerId: spec.ownerId ?? (ctx.player ? ctx.player.id : 'p1'),
      position: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
      age: spec.age ?? 0,
    };
    if (!item.rarity) item.rarity = item.weapon?.rarity ?? item.gear?.rarity ?? 'common';
    addItem(item);
    return item;
  }

  function setNearby(item: LootItemState | null): void {
    const id = item ? item.id : null;
    if (id === nearbyId) return;
    nearbyId = id;
    if (ctx.player) ctx.events.emit('loot:nearby', { playerId: ctx.player.id, item });
  }

  function pickup(item: LootItemState): void {
    removeItem(item.id);
    ctx.events.emit('loot:pickup', { playerId: ctx.player.id, item });
  }

  function update(dt: number): void {
    // Age + expiry (sim). The pit stop (phase 'cleared') freezes the clock: loot stays put.
    const aging = ctx.rounds?.state.phase !== 'cleared';
    for (let i = list.length - 1; i >= 0 && aging; i--) {
      const it = list[i];
      it.age += dt;
      if (it.age >= LOOT.lifetime) {
        list.splice(i, 1);
        view.remove(it.id);
        if (it.id === nearbyId) setNearby(null);
        ctx.events.emit('loot:expired', { itemId: it.id, item: it });
      }
    }

    view.update(list, dt);

    // Pickups for the local player
    const p = ctx.player;
    if (!p || !p.alive) {
      setNearby(null);
      return;
    }
    const r2 = LOOT.pickupRadius * LOOT.pickupRadius;
    let closest: LootItemState | null = null;
    let closestD = Infinity;

    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it.ownerId !== p.id) continue;
      tmp.set(it.position.x, it.position.y, it.position.z);
      const dx = tmp.x - p.position.x;
      const dz = tmp.z - p.position.z;
      const dy = tmp.y - p.position.y;
      if (Math.abs(dy) > 2.2) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;

      switch (it.kind) {
        case 'ammo':
          p.addAmmo(AMMO_PICKUP);
          pickup(it);
          break;
        case 'health':
          if (p.health < p.maxHealth) {
            p.heal(HEALTH_PICKUP);
            pickup(it);
          }
          break;
        case 'grenade':
          // player cap includes gear + skill slots (Bandolier / Ordnance Bay)
          if (p.grenades < (p.maxGrenades ?? (ctx.gear ? ctx.gear.maxGrenades(PLAYER.maxGrenades) : PLAYER.maxGrenades))) {
            p.addGrenades(1);
            pickup(it);
          }
          break;
        case 'gear':
          // walk-over: empty slot -> equipped, else backpack; a full backpack leaves it on the
          // ground (src/gear moves item.gear into the inventory on loot:pickup)
          if (it.gear && ctx.gear?.canPickUp(it.gear)) pickup(it);
          break;
        case 'weapon':
          if (d2 < closestD) {
            closestD = d2;
            closest = it;
          }
          break;
      }
    }

    setNearby(closest);

    if (closest && closest.weapon && ctx.input.justPressed('KeyE')) {
      const item = closest;
      const replaced = p.equip(item.weapon!);
      pickup(item);
      nearbyId = null; // force a fresh loot:nearby next frame
      ctx.events.emit('loot:nearby', { playerId: p.id, item: null });
      if (replaced) {
        const yaw = p.yaw;
        const x = p.position.x - Math.sin(yaw) * 0.6;
        const z = p.position.z - Math.cos(yaw) * 0.6;
        dropItem({
          kind: 'weapon',
          rarity: replaced.rarity,
          position: { x, y: ctx.world.groundHeight(x, z), z },
          ownerId: p.id,
          weapon: replaced,
        });
      }
    }
  }

  function clear(): void {
    list.length = 0;
    view.clear();
    setNearby(null);
  }

  return {
    items: () => list,
    dropLoot,
    generateWeapon: (tier: number, rarity?: Rarity): WeaponDef => genWeapon(ctx.rng, ctx.nextId, tier, { rarity }),
    starterWeapon: (archetype?: WeaponArchetype) => makeStarter(ctx.nextId, archetype),
    dropItem,
    remove: removeItem,
    clear,

    update,
  };
}

