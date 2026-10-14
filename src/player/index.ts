/**
 * System B — player + weapons.
 *
 * createPlayer() wires: Controller (movement/camera), Viewmodel (procedural gun on the camera),
 * WeaponSystem (slots, hitscan, recoil, perks), GrenadeSystem and melee into one PlayerState.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { DamageOpts, GameContext, PlayerRegistry, PlayerState, PlayerStats, WeaponArchetype, WeaponDef } from '@/core/types';
import type { Loadout } from '@/gear/types';
import { Controller } from './controller';
import { GrenadeSystem, GRENADE_SPEED, GRENADE_UP_SPEED } from './grenades';
import { performMelee } from './melee';
import { DEFAULT_STATS, clamp, gearExtras, getStats, maxGrenades } from './shared';
import { Viewmodel } from './viewmodel';
import { WeaponSystem } from './weapons';

export interface Player extends PlayerState {
  update(dt: number): void;
}

const START_GRENADES = 2;
const GRENADE_COOLDOWN = 0.6;
const DAMAGE_FLASH_HEALTH = 0xff2a2a;
const DAMAGE_FLASH_SHIELD = 0x3fa0ff;
/** Gear set hook 'bulwark_last_stand': damage reduction after the shield breaks. */
const LAST_STAND_TIME = 2;
const LAST_STAND_COOLDOWN = 10;
const LAST_STAND_REDUCTION = 0.5;
const EMPTY_LOADOUT: Readonly<Loadout> = Object.freeze({});

export interface CreatePlayerOptions {
  id: string;
  name: string;
  /**
   * localStorage key to persist the two weapon slots under (weapons are kept across runs and
   * sessions, like gear and the skill tree). Omit for no persistence (tests).
   */
  persistKey?: string;
}

// ---------------------------------------------------------------------------
// Weapon persistence
// ---------------------------------------------------------------------------
const ARCHETYPES: readonly WeaponArchetype[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

function validWeapon(raw: unknown): WeaponDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Partial<WeaponDef>;
  const nums = [w.damage, w.fireRate, w.magSize, w.reloadTime, w.pellets, w.spread, w.range, w.critMultiplier, w.elementChance, w.level, w.color];
  if (typeof w.name !== 'string' || !ARCHETYPES.includes(w.archetype as WeaponArchetype)) return null;
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (!(w.damage! > 0) || !(w.fireRate! > 0) || !(w.magSize! >= 1)) return null;
  return { ...(w as WeaponDef), perks: Array.isArray(w.perks) ? w.perks : [] };
}

export function loadWeapons(key: string): (WeaponDef | null)[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const d = JSON.parse(raw) as { version?: number; slots?: unknown[] };
    if (!d || d.version !== 1 || !Array.isArray(d.slots)) return [];
    return d.slots.slice(0, PLAYER.weaponSlots).map(validWeapon);
  } catch {
    return [];
  }
}

function saveWeapons(key: string, weapons: readonly (WeaponDef | null)[], active: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, active, slots: weapons }));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export function createPlayerRegistry(): PlayerRegistry {
  const map = new Map<string, PlayerState>();
  let local: PlayerState | undefined;
  return {
    get local() {
      return local ?? map.values().next().value!;
    },
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    nearest(point) {
      let best: PlayerState | undefined;
      let bestD = Infinity;
      for (const p of map.values()) {
        if (!p.alive) continue;
        const d = p.position.distanceToSquared(point);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    },
    add(p) {
      map.set(p.id, p);
      if (p.isLocal) local = p;
    },
    remove(id) {
      const p = map.get(id);
      map.delete(id);
      if (p && p === local) {
        local = undefined;
        for (const q of map.values()) if (q.isLocal) local = q;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Local player
// ---------------------------------------------------------------------------
export function createPlayer(ctx: GameContext, opts: CreatePlayerOptions): Player {
  // The viewmodel is a camera child, so the camera must be part of the scene graph.
  if (!ctx.camera.parent) ctx.scene.add(ctx.camera);

  const controller = new Controller(ctx);
  const viewmodel = new Viewmodel(ctx);
  ctx.camera.add(viewmodel.root);

  let alive = true;
  let shieldDelay = 0;
  let recharging = false;
  let meleeCooldown = 0;
  let grenadeCooldown = 0;
  let lastStandT = 0; // bulwark_last_stand window
  let lastStandCd = 0;

  /** Sponsor contract of the current run (system I); undefined without standing. */
  const run = () => (ctx as Partial<GameContext>).standing?.sponsors.active;
  const hasHook = (id: string) => gearExtras(ctx).hooks.includes(id);
  const grenadeCap = () => maxGrenades(ctx, PLAYER.maxGrenades);

  const weapons = new WeaponSystem(ctx, {
    id: opts.id,
    controller,
    viewmodel,
    heal: (n) => p.heal(n),
  });

  const grenades = new GrenadeSystem(ctx, {
    id: opts.id,
    position: controller.position,
    get alive() {
      return alive;
    },
    takeDamage: (amount, o) => p.takeDamage(amount, { point: o.point, element: 'none', sourceId: opts.id }),
  });

  const emitGrenades = () => ctx.events.emit('player:grenades', { playerId: opts.id, count: p.grenades });

  /** Recompute max health/shield from stats; grows current values along with the max. */
  function applyMaxStats(stats: PlayerStats, fill: boolean): void {
    const mh = PLAYER.maxHealth * stats.healthMult;
    const ms = run()?.noShield ? 0 : PLAYER.maxShield * stats.shieldMult;
    if (fill) {
      p.maxHealth = mh;
      p.maxShield = ms;
      p.health = mh;
      p.shield = ms;
      return;
    }
    if (alive) {
      if (mh > p.maxHealth) p.health += mh - p.maxHealth;
      if (ms > p.maxShield) p.shield += ms - p.maxShield;
    }
    p.maxHealth = mh;
    p.maxShield = ms;
    p.health = Math.min(p.health, mh);
    p.shield = Math.min(p.shield, ms);
  }

  function yawTowardsCenter(start: THREE.Vector3): number {
    // forward is (-sin yaw, -cos yaw); arena centre is the origin
    const dx = -start.x;
    const dz = -start.z;
    if (Math.hypot(dx, dz) < 1e-3) return 0;
    return Math.atan2(-dx, -dz);
  }

  function die(): void {
    if (!alive) return;
    alive = false;
    p.health = 0;
    weapons.resetState();
    controller.velocity.x *= 0.2;
    controller.velocity.z *= 0.2;
    viewmodel.setDead(true);
    ctx.events.emit('player:died', { playerId: opts.id });
  }

  function doMelee(): void {
    meleeCooldown = PLAYER.meleeCooldown;
    weapons.lock(0.3);
    viewmodel.bash();
    const hit = performMelee(ctx, controller.position, controller.yaw, opts.id);
    ctx.fx.shake(hit ? 0.25 : 0.06);
    // Pitfighter 3/3: melee kills refill the shield and refund a grenade.
    if (hit && !hit.alive && hasHook('pitfighter_bloodlust')) {
      p.shield = p.maxShield;
      p.addGrenades(1);
    }
    ctx.events.emit('player:melee', { playerId: opts.id, hit: !!hit });
  }

  function throwGrenade(): void {
    if (p.grenades <= 0 || grenadeCooldown > 0) return;
    grenadeCooldown = GRENADE_COOLDOWN;
    p.grenades -= 1;
    emitGrenades();

    const cam = ctx.camera;
    cam.updateMatrixWorld(true);
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    // spawn slightly ahead/right/below the eye, but never inside a wall
    let ahead = 0.6;
    const block = ctx.world.raycast(eye, fwd, ahead + 0.2);
    if (block) ahead = Math.max(0, block.distance - 0.25);
    const origin = eye.clone().addScaledVector(fwd, ahead).addScaledVector(right, 0.12);
    origin.y -= 0.12;

    const vel = fwd.clone().multiplyScalar(GRENADE_SPEED);
    vel.y += GRENADE_UP_SPEED;
    vel.x += controller.velocity.x * 0.5;
    vel.z += controller.velocity.z * 0.5;
    grenades.throw(origin, vel);

    weapons.lock(0.35);
    viewmodel.throwAnim();
    ctx.events.emit('player:grenade', { playerId: opts.id, position: origin.clone() });
  }

  const p: Player = {
    id: opts.id,
    name: opts.name,
    isLocal: true,
    position: controller.position,
    velocity: controller.velocity,
    get yaw() {
      return controller.yaw;
    },
    get pitch() {
      return controller.pitch;
    },
    health: PLAYER.maxHealth,
    maxHealth: PLAYER.maxHealth,
    shield: PLAYER.maxShield,
    maxShield: PLAYER.maxShield,
    get alive() {
      return alive;
    },
    weapons: weapons.weapons,
    get activeSlot() {
      return weapons.active;
    },
    get activeWeapon() {
      return weapons.activeWeapon;
    },
    get loadout() {
      const g = (ctx as Partial<GameContext>).gear;
      return g ? g.inventory.loadout : EMPTY_LOADOUT;
    },
    get onGround() {
      return controller.onGround;
    },
    grenades: START_GRENADES,
    get ammo() {
      return weapons.ammo;
    },
    set ammo(v: number) {
      weapons.ammo = v;
    },
    get reserve() {
      return weapons.reserve;
    },
    set reserve(v: number) {
      weapons.reserve = v;
    },

    takeDamage(amount: number, o?: DamageOpts) {
      if (!alive || !(amount > 0)) return;
      const element = o?.element ?? 'none';
      if (element !== 'none') amount *= 1 - gearExtras(ctx).elementalResist;
      if (lastStandT > 0) amount *= 1 - LAST_STAND_REDUCTION;
      let rest = amount;
      if (p.shield > 0) {
        const mult = element === 'shock' ? 2 : 1;
        const absorbed = Math.min(p.shield, rest * mult);
        p.shield -= absorbed;
        rest -= absorbed / mult;
        if (p.shield <= 0.001) {
          p.shield = 0;
          ctx.events.emit('player:shield', { playerId: opts.id, shield: 0, maxShield: p.maxShield, broken: true });
          // Bulwark 3/3: a short damage-reduction window when the shield breaks.
          if (lastStandCd <= 0 && hasHook('bulwark_last_stand')) {
            lastStandT = LAST_STAND_TIME;
            lastStandCd = LAST_STAND_COOLDOWN;
          }
        }
      }
      rest = Math.max(0, rest);
      if (rest > 0) p.health = Math.max(0, p.health - rest);
      shieldDelay = PLAYER.shieldRechargeDelay;
      recharging = false;

      const hitHealth = rest > 0.01;
      ctx.fx.flash(hitHealth ? DAMAGE_FLASH_HEALTH : DAMAGE_FLASH_SHIELD, clamp(0.15 + amount / 60, 0.15, 0.6));
      ctx.fx.shake(clamp(amount / 50, 0.06, 0.6));
      ctx.events.emit('player:damaged', {
        playerId: opts.id,
        amount,
        health: p.health,
        shield: p.shield,
        element,
        from: o?.point ? o.point.clone() : undefined,
      });
      if (p.health <= 0) die();
    },

    heal(amount: number) {
      if (!alive || !(amount > 0)) return;
      const before = p.health;
      p.health = Math.min(p.maxHealth, p.health + amount);
      const got = p.health - before;
      if (got > 0) ctx.events.emit('player:healed', { playerId: opts.id, amount: got, health: p.health });
    },

    addAmmo(fraction: number) {
      weapons.addAmmo(fraction);
    },

    addGrenades(n: number) {
      if (n > 0 && run()?.grenadeless) return;
      const before = p.grenades;
      p.grenades = clamp(p.grenades + Math.floor(n), 0, grenadeCap());
      if (p.grenades !== before) emitGrenades();
    },

    equip(weapon: WeaponDef) {
      return weapons.equip(weapon);
    },

    reset() {
      alive = true;
      applyMaxStats(getStats(ctx), true);
      shieldDelay = 0;
      recharging = false;
      meleeCooldown = 0;
      grenadeCooldown = 0;
      lastStandT = 0;
      lastStandCd = 0;
      p.grenades = run()?.grenadeless ? 0 : START_GRENADES;
      const start = ctx.world.playerStart;
      controller.resetTo(start, yawTowardsCenter(start));
      weapons.resetState();
      weapons.refillAll();
      grenades.clear();
      viewmodel.setDead(false);
      viewmodel.setGloves((ctx as Partial<GameContext>).gear?.inventory.equipped('gloves') ?? null);
      emitGrenades();
    },

    revive(healthFraction: number) {
      if (alive) return;
      alive = true;
      p.health = Math.max(1, p.maxHealth * clamp(healthFraction, 0, 1));
      p.shield = 0;
      shieldDelay = PLAYER.shieldRechargeDelay;
      recharging = false;
      weapons.resetState();
      viewmodel.setDead(false);
      ctx.events.emit('player:revived', { playerId: opts.id, health: p.health });
    },

    update(dt: number) {
      const input = ctx.input;
      const stats = getStats(ctx);

      if (alive && input.mouseJustPressed(0) && !input.locked()) input.lock();

      if (lastStandT > 0) lastStandT -= dt;
      if (lastStandCd > 0) lastStandCd -= dt;

      controller.look(alive);
      controller.dashEnabled = hasHook('voidrunner_dash');
      controller.move(dt, alive, stats.moveSpeedMult);
      if (controller.dashedThisFrame) ctx.fx.shake(0.1);
      controller.updateCamera(dt, alive);

      // shield recharge
      if (alive) {
        if (shieldDelay > 0) {
          shieldDelay -= dt;
        } else if (p.shield < p.maxShield) {
          if (!recharging) {
            recharging = true;
            ctx.events.emit('player:shield', { playerId: opts.id, shield: p.shield, maxShield: p.maxShield, broken: false });
          }
          const regen = PLAYER.shieldRechargeRate * stats.shieldMult * gearExtras(ctx).shieldRegenMult;
          p.shield = Math.min(p.maxShield, p.shield + regen * dt);
        } else {
          recharging = false;
        }
      }

      // melee + grenades
      meleeCooldown -= dt;
      grenadeCooldown -= dt;
      if (alive && input.justPressed('KeyV') && meleeCooldown <= 0) doMelee();
      if (alive && input.justPressed('KeyG')) throwGrenade();

      viewmodel.update(dt, controller);
      weapons.update(dt, alive);
      grenades.update(dt);
    },
  };

  // initial state (progression has not booted yet: neutral stats)
  applyMaxStats(DEFAULT_STATS, true);
  controller.resetTo(ctx.world.playerStart, yawTowardsCenter(ctx.world.playerStart));

  // skill:changed carries progression-only stats: fold the gear in (same as getStats).
  ctx.events.on('skill:changed', (e) => {
    const g = (ctx as Partial<GameContext>).gear;
    const base = e.stats ?? getStats(ctx);
    applyMaxStats(g && e.stats ? g.mergedStats(e.stats) : base, false);
  });
  ctx.events.on('gear:changed', (e) => {
    if (e.playerId !== opts.id) return;
    applyMaxStats(getStats(ctx), false);
    viewmodel.setGloves(e.loadout.gloves ?? null);
    if (p.grenades > grenadeCap()) {
      p.grenades = grenadeCap();
      emitGrenades();
    }
  });
  // A contract picked between runs (noShield) applies at once, not only at the next reset().
  ctx.events.on('sponsor:chosen', () => applyMaxStats(getStats(ctx), false));

  // Weapons persist across runs and sessions (like gear and the skill tree).
  if (opts.persistKey) {
    const key = opts.persistKey;
    for (const w of loadWeapons(key)) if (w) weapons.equip({ ...w, id: ctx.nextId('weapon') });
    ctx.events.on('weapon:equipped', (e) => {
      if (e.playerId === opts.id) saveWeapons(key, weapons.weapons, weapons.active);
    });
  }

  return p;

}
