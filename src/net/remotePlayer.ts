/**
 * Host-side stand-in for a client's player. Position/yaw/pitch are driven by the client's
 * input ticks; health/shield/alive are authoritative here (enemies hit it like any other
 * PlayerState) and every hit is echoed back to the client through `onHurt`.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { DamageOpts, Element, GameContext, PlayerState, WeaponDef } from '@/core/types';
import type { Loadout } from '@/gear/types';

export interface RemotePlayerHooks {
  onHurt(amount: number, element: Element, from: THREE.Vector3 | undefined): void;
  onDied(): void;
  onEquip?(weapon: WeaponDef): void;
  onAddAmmo?(fraction: number): void;
  onAddGrenades?(n: number): void;
}

export class RemotePlayer implements PlayerState {
  readonly isLocal = false;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  health: number = PLAYER.maxHealth;
  maxHealth: number = PLAYER.maxHealth;
  shield: number = PLAYER.maxShield;
  maxShield: number = PLAYER.maxShield;
  grenades = 2;
  ammo = 0;
  reserve = 0;
  readonly weapons: (WeaponDef | null)[] = [null, null];
  activeSlot = 0;
  onGround = true;
  /** Equipped gear for avatars. Not on the wire yet (see docs/INTEGRATION_NOTES.md): stays empty. */
  loadout: Readonly<Loadout> = {};
  /** Seconds since the last input tick (stale connection detection). */
  silence = 0;

  private aliveFlag = true;
  private shieldDelay = 0;

  constructor(
    private readonly ctx: GameContext,
    readonly id: string,
    readonly name: string,
    private readonly hooks: RemotePlayerHooks,
  ) {
    this.position.copy(ctx.world.playerStart);
  }

  get alive(): boolean {
    return this.aliveFlag;
  }

  get activeWeapon(): WeaponDef | null {
    return this.weapons[this.activeSlot] ?? null;
  }

  /** Avatar weapon from the client's tick (only what the avatar needs). */
  setActiveWeapon(w: WeaponDef | null): void {
    this.weapons[0] = w;
    this.activeSlot = 0;
  }

  takeDamage(amount: number, o?: DamageOpts): void {
    if (!this.aliveFlag || !(amount > 0)) return;
    const element = o?.element ?? 'none';
    // Same shield/health split as the local player (shock ×2 vs shields).
    let rest = amount;
    if (this.shield > 0) {
      const mult = element === 'shock' ? 2 : 1;
      const absorbed = Math.min(this.shield, rest * mult);
      this.shield -= absorbed;
      rest -= absorbed / mult;
      if (this.shield <= 0.001) this.shield = 0;
    }
    rest = Math.max(0, rest);
    if (rest > 0) this.health = Math.max(0, this.health - rest);
    this.shieldDelay = PLAYER.shieldRechargeDelay;
    this.hooks.onHurt(amount, element, o?.point);
    this.ctx.events.emit('player:damaged', {
      playerId: this.id, amount, health: this.health, shield: this.shield, element,
      from: o?.point ? o.point.clone() : undefined,
    });
    if (this.health <= 0) this.die();
  }

  /** Self damage reported by the client (own grenade): no echo back. */
  applySelfDamage(amount: number, element: Element): void {
    if (!this.aliveFlag || !(amount > 0)) return;
    let rest = Math.min(amount, 500);
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, rest);
      this.shield -= absorbed;
      rest -= absorbed;
    }
    if (rest > 0) this.health = Math.max(0, this.health - rest);
    this.shieldDelay = PLAYER.shieldRechargeDelay;
    void element;
    if (this.health <= 0) this.die();
  }

  heal(amount: number): void {
    if (!this.aliveFlag || !(amount > 0)) return;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    const got = this.health - before;
    if (got > 0) this.ctx.events.emit('player:healed', { playerId: this.id, amount: got, health: this.health });
  }

  addAmmo(fraction: number): void {
    this.hooks.onAddAmmo?.(fraction);
  }

  addGrenades(n: number): void {
    this.grenades = Math.min(PLAYER.maxGrenades, this.grenades + Math.floor(n));
    this.hooks.onAddGrenades?.(n);
  }

  equip(weapon: WeaponDef): WeaponDef | null {
    const old = this.activeWeapon;
    this.setActiveWeapon(weapon);
    this.hooks.onEquip?.(weapon);
    return old;
  }

  reset(): void {
    this.aliveFlag = true;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.shieldDelay = 0;
    this.grenades = 2;
  }

  /** Bring a downed player back with a fraction of max health. */
  revive(fraction: number): void {
    if (this.aliveFlag) return;
    this.aliveFlag = true;
    this.health = Math.max(1, this.maxHealth * Math.min(1, Math.max(0, fraction)));
    this.shield = 0;
    this.shieldDelay = PLAYER.shieldRechargeDelay;
    this.ctx.events.emit('player:revived', { playerId: this.id, health: this.health });
  }

  /** Max values come from the client's own skill tree. */
  setMax(maxHealth: number, maxShield: number): void {
    if (!(maxHealth > 0) || !(maxShield >= 0)) return;
    const mh = Math.min(maxHealth, 5000);
    const ms = Math.min(maxShield, 5000);
    if (this.aliveFlag) {
      if (mh > this.maxHealth) this.health += mh - this.maxHealth;
      if (ms > this.maxShield) this.shield += ms - this.maxShield;
    }
    this.maxHealth = mh;
    this.maxShield = ms;
    this.health = Math.min(this.health, mh);
    this.shield = Math.min(this.shield, ms);
  }

  update(dt: number, shieldMult = 1): void {
    this.silence += dt;
    if (!this.aliveFlag) return;
    if (this.shieldDelay > 0) this.shieldDelay -= dt;
    else if (this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + PLAYER.shieldRechargeRate * shieldMult * dt);
    }
  }

  private die(): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.health = 0;
    this.hooks.onDied();
    this.ctx.events.emit('player:died', { playerId: this.id });
  }
}
