/**
 * Client-side LootSystem: shows the loot the host dropped for THIS player (snapshots carry
 * only items with ownerId = this client) through the regular loot view, runs the pickup
 * proximity checks locally and asks the host to confirm each pickup. Weapons replaced on
 * pickup are dropped as client-only items (the host never needs to know about them).
 */
import * as THREE from 'three';
import { LOOT, PLAYER } from '@/core/config';
import type { DropOpts, GameContext, LootDropSpec, LootItemState, LootSystem, Rarity, WeaponDef } from '@/core/types';
import { sanitizeGear } from '@/gear/inventory';
import type { GearDef } from '@/gear/types';
import { AMMO_PICKUP, HEALTH_PICKUP } from '@/loot';
import { createLootView, type LootView } from '@/loot/view';
import { generateWeapon as genWeapon, starterWeapon as makeStarter } from '@/loot/weapons';
import { dec, sanitizeWeapon, type LootW } from './protocol';

export { AMMO_PICKUP, HEALTH_PICKUP };
const REQUEST_RETRY = 1.0;

export class LootMirror implements LootSystem {
  private readonly list: LootItemState[] = [];
  private readonly local = new Set<string>();
  private readonly pending = new Map<string, number>();
  private readonly view: LootView;
  private nearbyId: string | null = null;
  private localCounter = 0;

  constructor(private readonly ctx: GameContext, private readonly requestPickup: (id: string) => void) {
    this.view = createLootView(ctx);
  }

  items(): LootItemState[] {
    return this.list;
  }

  dropLoot(_position: THREE.Vector3, _opts: DropOpts): LootItemState[] {
    return []; // host-authoritative
  }

  generateWeapon(tier: number, rarity?: Rarity): WeaponDef {
    return genWeapon(this.ctx.rng, this.ctx.nextId, tier, { rarity });
  }

  starterWeapon(): WeaponDef {
    return makeStarter(this.ctx.nextId);
  }

  /** Apply loot adds/removes from a snapshot. */
  apply(added: LootW[] | undefined, removed: string[] | undefined): void {
    for (const w of added ?? []) {
      if (!w || typeof w.i !== 'string' || this.list.some((it) => it.id === w.i)) continue;
      const kind = dec.loot(w.k);
      const weapon = kind === 'weapon' ? sanitizeWeapon(w.w) ?? undefined : undefined;
      if (kind === 'weapon' && !weapon) continue;
      const gear = kind === 'gear' ? sanitizeGear(w.g) ?? undefined : undefined;
      if (kind === 'gear' && !gear) continue;
      const item: LootItemState = {
        id: w.i,
        kind,
        rarity: dec.rarity(w.r),
        position: { x: w.p[0], y: w.p[1], z: w.p[2] },
        ownerId: this.ctx.player.id,
        weapon,
        gear,
        age: w.ag ?? 0,
      };
      this.list.push(item);
      this.view.add(item);
      this.ctx.events.emit('loot:dropped', { item });
    }
    for (const id of removed ?? []) this.remove(id);
  }

  /** Host answered a pickup request. */
  onPickResult(id: string, ok: boolean, weaponW?: unknown, gearW?: unknown): void {
    this.pending.delete(id);
    const item = this.list.find((it) => it.id === id);
    if (!ok) return;
    if (item) {
      this.remove(id);
      if (item.kind === 'gear') item.gear = sanitizeGear(gearW) ?? item.gear;
      this.grant(item, sanitizeWeapon(weaponW) ?? item.weapon ?? null);
    }
  }

  private grant(item: LootItemState, weapon: WeaponDef | null): void {
    const p = this.ctx.player;
    switch (item.kind) {
      case 'ammo':
        p.addAmmo(AMMO_PICKUP);
        break;
      case 'grenade':
        p.addGrenades(1);
        break;
      case 'health':
        // The host already healed us authoritatively; mirror it now for instant feedback
        // (direct write: no player:healed, so it is not forwarded back as a heal).
        p.health = Math.min(p.maxHealth, p.health + HEALTH_PICKUP);
        break;
      case 'weapon':
        if (weapon) {
          const replaced = p.equip(weapon);
          if (replaced) this.dropLocal(replaced);
        }
        break;
      case 'gear':
        // src/gear moves item.gear into the inventory on loot:pickup (below)
        break;
    }
    this.ctx.events.emit('loot:pickup', { playerId: p.id, item });
  }

  private dropLocal(weapon: WeaponDef): void {
    const p = this.ctx.player;
    const x = p.position.x - Math.sin(p.yaw) * 0.6;
    const z = p.position.z - Math.cos(p.yaw) * 0.6;
    this.dropItem({ kind: 'weapon', rarity: weapon.rarity, position: { x, y: this.ctx.world.groundHeight(x, z), z }, weapon });
  }

  /**
   * Client-only item (swapped-out weapon, gear dropped from the backpack): the host never hears
   * about it; it is picked up and expires locally.
   */
  dropItem(spec: LootDropSpec): LootItemState {
    const item: LootItemState = {
      ...spec,
      id: `local_loot_${++this.localCounter}`,
      ownerId: this.ctx.player.id,
      position: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
      rarity: spec.rarity ?? spec.weapon?.rarity ?? spec.gear?.rarity ?? 'common',
      age: spec.age ?? 0,
    };
    this.local.add(item.id);
    this.list.push(item);
    this.view.add(item);
    this.ctx.events.emit('loot:dropped', { item });
    return item;
  }

  remove(id: string): boolean {
    const i = this.list.findIndex((it) => it.id === id);
    if (i >= 0) this.list.splice(i, 1);
    this.local.delete(id);
    this.pending.delete(id);
    this.view.remove(id);
    if (id === this.nearbyId) this.setNearby(null);
    return i >= 0;
  }

  private setNearby(item: LootItemState | null): void {
    const id = item ? item.id : null;
    if (id === this.nearbyId) return;
    this.nearbyId = id;
    this.ctx.events.emit('loot:nearby', { playerId: this.ctx.player.id, item });
  }

  private take(item: LootItemState): void {
    if (this.local.has(item.id)) {
      this.remove(item.id);
      this.grant(item, item.weapon ?? null);
      return;
    }
    if (this.pending.has(item.id)) return;
    this.pending.set(item.id, REQUEST_RETRY);
    this.requestPickup(item.id);
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const it = this.list[i];
      it.age += dt;
      // host items are removed by the host; local ones expire here
      if (this.local.has(it.id) && it.age >= LOOT.lifetime) this.remove(it.id);
    }
    for (const [id, t] of this.pending) {
      if (t - dt <= 0) this.pending.delete(id);
      else this.pending.set(id, t - dt);
    }
    this.view.update(this.list, dt);

    const p = this.ctx.player;
    if (!p || !p.alive) {
      this.setNearby(null);
      return;
    }
    const r2 = LOOT.pickupRadius * LOOT.pickupRadius;
    let closest: LootItemState | null = null;
    let closestD = Infinity;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const it = this.list[i];
      const dx = it.position.x - p.position.x;
      const dz = it.position.z - p.position.z;
      if (Math.abs(it.position.y - p.position.y) > 2.2) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      switch (it.kind) {
        case 'ammo':
          this.take(it);
          break;
        case 'health':
          if (p.health < p.maxHealth) this.take(it);
          break;
        case 'grenade':
          if (p.grenades < (p.maxGrenades ?? (this.ctx.gear ? this.ctx.gear.maxGrenades(PLAYER.maxGrenades) : PLAYER.maxGrenades))) this.take(it);
          break;
        case 'gear':
          if (it.gear && this.ctx.gear?.canPickUp(it.gear as GearDef)) this.take(it);
          break;

        case 'weapon':
          if (d2 < closestD) {
            closestD = d2;
            closest = it;
          }
          break;
      }
    }
    this.setNearby(closest);
    if (closest && closest.weapon && this.ctx.input.justPressed('KeyE')) {
      const item = closest;
      this.take(item);
      if (!this.pending.has(item.id)) {
        this.nearbyId = null;
        this.ctx.events.emit('loot:nearby', { playerId: p.id, item: null });
      }
    }
  }

  clear(): void {
    for (const it of [...this.list]) this.view.remove(it.id);
    this.list.length = 0;
    this.local.clear();
    this.pending.clear();
    this.view.clear();
    this.setNearby(null);
  }
}
