/**
 * System B — player + weapons.
 *
 * createPlayer() wires: Controller (movement/camera), Viewmodel (procedural gun on the camera),
 * WeaponSystem (slots, hitscan, recoil, perks), GrenadeSystem and melee into one PlayerState.
 */
import * as THREE from 'three';
import { PLAYER, accuracyFromSpread } from '@/core/config';
import { ELEMENT_COLORS } from '@/core/types';
import type { DamageOpts, Enemy, GameContext, PlayerRegistry, PlayerState, PlayerStats, WeaponArchetype, WeaponDef } from '@/core/types';
import type { Loadout } from '@/gear/types';
import { THROW_RELEASE } from './animations';
import { Controller } from './controller';
import { GrenadeSystem, GRENADE_SPEED, GRENADE_UP_SPEED } from './grenades';
import { meleeDamage, performMelee } from './melee';
import {
  DEFAULT_STATS, activeRunning, adsOf, clamp, classProgression, gearExtras, getStats, hasSkillHook, maxGrenades, skillExtras,
} from './shared';
import { Viewmodel } from './viewmodel';
import { WeaponSystem } from './weapons';

export interface Player extends PlayerState {
  update(dt: number): void;
}

const START_GRENADES = 2;
const GRENADE_COOLDOWN = 0.6;
const DAMAGE_FLASH_HEALTH = 0xff2a2a;
const DAMAGE_FLASH_SHIELD = 0x3fa0ff;
/**
 * Gear set hook 'bulwark_last_stand': damage reduction after the shield breaks. Tuned
 * (docs/INTEGRATION_NOTES.md): 40 % for 2.5 s covers the burst that broke the shield plus one
 * retreat, and a 12 s cooldown means it is not up for every shield break in a brawl.
 */
export const LAST_STAND_TIME = 2.5;
export const LAST_STAND_COOLDOWN = 12;
export const LAST_STAND_REDUCTION = 0.4;
/**
 * Gear set hook 'pitfighter_bloodlust': a melee kill restores a slice of the shield and refunds
 * a grenade on a cooldown. Tuned (docs/INTEGRATION_NOTES.md): a full refill per kill made melee
 * chains unkillable; 35 % of max shield per finisher rewards the risk without removing it, and
 * the grenade refund every 8 s at most keeps grenades a resource.
 */
export const BLOODLUST_SHIELD_FRACTION = 0.35;
export const BLOODLUST_GRENADE_COOLDOWN = 8;
/**
 * Shield Bash (Vanguard active, docs/SKILL_TREE.md §5.1 player:shieldBash): a 6 m dash along the
 * view over 0.25 s; every enemy the player passes within `reach` m takes `damage` × a melee hit
 * once and is knocked away from the dash line (mobs: a short stun + shove through their own
 * collision; bosses: a small nudge). The ability's duration (1 s) is the invulnerability window.
 */
export const SHIELD_BASH = { distance: 6, time: 0.25, damage: 1.5, reach: 1.0, knockSpeed: 36, stun: 0.4, bossNudge: 0.6, fallbackKnock: 2.5 } as const;
/** Deadeye (Marksman active): enemy + projectile time scale while it runs (every bullet crits). */
export const DEADEYE_TIME_SCALE = 0.5;
/** Second Wind (Pit P5): once per round, lethal damage leaves 1 HP, `shield` × max shield, `invuln` s. */
export const SECOND_WIND = { invuln: 2, shield: 0.5 } as const;
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
  const def = { ...(w as WeaponDef), perks: Array.isArray(w.perks) ? w.perks : [] };
  // weapons saved before accuracy/ADS existed: derive them (spread is the truth for accuracy)
  if (typeof def.accuracy !== 'number' || !Number.isFinite(def.accuracy)) def.accuracy = accuracyFromSpread(def.spread);
  const ads = adsOf(def);
  def.zoom = ads.zoom;
  def.adsSpread = ads.adsSpread;
  return def;
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
  let bloodlustCd = 0; // pitfighter_bloodlust grenade refund cooldown
  // skill tree hooks
  let invulnT = 0; // Shield Bash / Second Wind: damage is ignored while > 0
  let secondWindUsed = false; // once per round
  let bashT = 0; // Shield Bash sweep window
  const bashDir = new THREE.Vector3();
  const bashHit = new Set<string>();
  let deadeyeScaled = false; // this player set the enemy time scale
  let activeWasReady = false; // for active:ready
  let throwPending = 0; // s until the wound-up grenade leaves the hand (0 = none)

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
    bashT = 0;
    controller.forcedDashLeft = 0;
    throwPending = 0; // a grenade still in the hand is lost with the player
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
    // Pitfighter 3/3: melee kills restore part of the shield and refund a grenade (on cooldown).
    if (hit && !hit.alive && hasHook('pitfighter_bloodlust')) {
      p.shield = Math.min(p.maxShield, p.shield + p.maxShield * BLOODLUST_SHIELD_FRACTION);
      if (bloodlustCd <= 0 && p.grenades < grenadeCap()) {
        p.addGrenades(1);
        bloodlustCd = BLOODLUST_GRENADE_COOLDOWN;
      }
    }
    ctx.events.emit('player:melee', { playerId: opts.id, hit: !!hit });
  }

  // ---- class actives (the live part runs in progression useActive(); this is the player side) ---
  function startBash(invuln: number): void {
    bashDir.set(-Math.sin(controller.yaw), 0, -Math.cos(controller.yaw));
    controller.startForcedDash(bashDir.x, bashDir.z, SHIELD_BASH.distance, SHIELD_BASH.time);
    bashT = SHIELD_BASH.time + 0.05;
    bashHit.clear();
    invulnT = Math.max(invulnT, invuln > 0 ? invuln : 1);
    weapons.lock(SHIELD_BASH.time);
    viewmodel.bash();
    ctx.fx.shake(0.3);
    ctx.fx.flash(DAMAGE_FLASH_SHIELD, 0.25);
    ctx.audio.play('melee', { pitch: 0.7 });
    bashSweep();
  }

  /** Hit (once per bash) every enemy the dashing player reaches; knock it off the dash line. */
  function bashSweep(): void {
    const enemies = ctx.enemies;
    if (!enemies) return;
    const feet = controller.position;
    for (const e of enemies.list()) {
      if (!e.alive || bashHit.has(e.id)) continue;
      const dx = e.position.x - feet.x;
      const dz = e.position.z - feet.z;
      const dist = Math.hypot(dx, dz);
      if (dist - e.radius > PLAYER.radius + SHIELD_BASH.reach) continue;
      if (e.position.y > feet.y + PLAYER.height + 0.3 || e.position.y + e.height < feet.y - 0.3) continue;
      if (dist > 1e-3 && (dx * bashDir.x + dz * bashDir.z) / dist < -0.3) continue; // behind at the start
      bashHit.add(e.id);
      const point = new THREE.Vector3(e.position.x, Math.min(e.position.y + e.height * 0.6, feet.y + PLAYER.eyeHeight - 0.2), e.position.z);
      e.damage(meleeDamage(ctx) * SHIELD_BASH.damage, { point, element: 'none', crit: false, sourceId: opts.id, applyStatus: false, cause: 'melee' });
      ctx.fx.burst(point, 0xffffff, 14);
      if (e.alive) knockBack(e, dx, dz);
    }
  }

  function knockBack(e: Enemy, dx: number, dz: number): void {
    // away from the dash line, plus along the dash
    const along = dx * bashDir.x + dz * bashDir.z;
    let lx = dx - bashDir.x * along;
    let lz = dz - bashDir.z * along;
    const ll = Math.hypot(lx, lz);
    if (ll > 1e-3) { lx /= ll; lz /= ll; } else { lx = bashDir.z; lz = -bashDir.x; } // dead centre: to the right
    let kx = bashDir.x * 0.6 + lx;
    let kz = bashDir.z * 0.6 + lz;
    const kl = Math.hypot(kx, kz) || 1;
    kx /= kl;
    kz /= kl;
    // Real enemies (BaseEnemy) expose their velocity and stun: a stunned enemy brakes and slides
    // through its own world collision. Bosses ignore stun: they get a small nudge instead.
    const vel = (e as Partial<{ velocity: THREE.Vector3 }>).velocity;
    const st = e.state as Partial<{ stun: number }>;
    if (!e.isBoss && vel && typeof st.stun === 'number') {
      st.stun = Math.max(st.stun, SHIELD_BASH.stun);
      vel.x = kx * SHIELD_BASH.knockSpeed;
      vel.z = kz * SHIELD_BASH.knockSpeed;
      return;
    }
    const push = e.isBoss ? SHIELD_BASH.bossNudge : SHIELD_BASH.fallbackKnock;
    const target = new THREE.Vector3(e.position.x + kx * push, e.position.y, e.position.z + kz * push);
    const res = ctx.world.resolveCapsule(target, e.radius, e.height);
    if (Number.isFinite(res.position.x) && Number.isFinite(res.position.z)) {
      e.position.x = res.position.x;
      e.position.z = res.position.z;
    }
  }

  /** Deadeye: enemies (+ projectiles) at half speed while it runs; restore when it ends. */
  function updateDeadeye(): void {
    const en = (ctx as Partial<GameContext>).enemies;
    const on = activeRunning(ctx, 'deadeye');
    if (!en?.setTimeScale || (!on && !deadeyeScaled)) return;
    const want = on ? DEADEYE_TIME_SCALE : 1;
    if (en.timeScale !== want) en.setTimeScale(want);
    if (deadeyeScaled && !on) ctx.fx.flash(0xbfe6ff, 0.15);
    deadeyeScaled = on;
  }

  function restoreTimeScale(): void {
    if (!deadeyeScaled) return;
    deadeyeScaled = false;
    (ctx as Partial<GameContext>).enemies?.setTimeScale?.(1);
  }

  function useActiveKey(): void {
    const cp = classProgression(ctx);
    const a = cp?.activeAbility;
    if (!cp || !a) return;
    if (cp.useActive()) return; // effects.ts emits active:used → onActiveUsed
    if (!a.unlocked) ctx.events.emit('ui:message', { text: `${a.def.name.toUpperCase()} · UNLOCKS WITH YOUR FIRST KEYSTONE`, duration: 2, style: 'warning' });
    else ctx.audio.play('empty', { volume: 0.6 });
  }

  function onActiveUsed(abilityId: string, duration: number): void {
    switch (abilityId) {
      case 'shield_bash':
        if (alive) startBash(duration);
        break;
      case 'deadeye':
        ctx.fx.flash(0xbfe6ff, 0.35);
        ctx.audio.play('crit', { pitch: 0.5 });
        updateDeadeye();
        break;
      case 'shock_pulse':
        // effects.ts deals the nova, restores the shield and draws the explosion
        ctx.fx.flash(ELEMENT_COLORS.shock, 0.3);
        ctx.fx.burst(controller.position.clone().setY(controller.position.y + 1), ELEMENT_COLORS.shock, 24);
        ctx.audio.play('explosion', { pitch: 1.4 });
        ctx.audio.play('shield_recharge');
        break;
      case 'encore':
        // effects.ts refilled the magazine (+ a reserve load) and started the fire-rate buff
        ctx.fx.flash(0xffd34d, 0.3);
        ctx.audio.play('reload', { pitch: 1.3 });
        ctx.audio.play('pickup_weapon');
        break;
    }
  }

  /**
   * G: the grenade is spent and the cooldown starts at the key press; the viewmodel winds up and
   * the world grenade leaves the hand at THROW_RELEASE (origin/velocity from the camera then).
   */
  function throwGrenade(): void {
    if (p.grenades <= 0 || grenadeCooldown > 0 || throwPending > 0) return;
    grenadeCooldown = GRENADE_COOLDOWN;
    p.grenades -= 1;
    emitGrenades();
    weapons.lock(0.35);
    viewmodel.throwAnim();
    throwPending = THROW_RELEASE;
  }

  function releaseGrenade(): void {
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
    get aiming() {
      return weapons.aiming;
    },
    get zoom() {
      return weapons.zoom;
    },
    get spread() {
      return weapons.currentSpread();
    },
    get maxGrenades() {
      return grenadeCap();
    },
    get invulnerable() {
      return alive && invulnT > 0;
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
      if (invulnT > 0) return; // Shield Bash / Second Wind
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

      // Second Wind (Pit P5): once per round, lethal damage leaves 1 HP, half a shield, 2 s invuln
      if (p.health <= 0 && !secondWindUsed && hasSkillHook(ctx, 'player:secondWind')) {
        secondWindUsed = true;
        p.health = 1;
        p.shield = Math.max(p.shield, p.maxShield * SECOND_WIND.shield);
        invulnT = Math.max(invulnT, SECOND_WIND.invuln);
        ctx.events.emit('ui:message', { text: 'SECOND WIND', duration: 2, style: 'legendary' });
        ctx.fx.flash(0xffffff, 0.5);
        ctx.audio.play('shield_recharge', { pitch: 0.8 });
      }

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
      bloodlustCd = 0;
      invulnT = 0;
      secondWindUsed = false;
      bashT = 0;
      bashHit.clear();
      throwPending = 0;
      restoreTimeScale();
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
      if (bloodlustCd > 0) bloodlustCd -= dt;
      if (invulnT > 0) invulnT = Math.max(0, invulnT - dt);

      weapons.updateAim(dt, alive); // ADS first: look sensitivity, speed and FOV read it
      controller.look(alive);
      controller.dashEnabled = hasHook('voidrunner_dash');
      controller.move(dt, alive, stats.moveSpeedMult);
      if (controller.dashedThisFrame) ctx.fx.shake(0.1);
      controller.updateCamera(dt, alive);

      // Shield Bash: sweep the path while dashing
      if (bashT > 0) {
        bashT -= dt;
        if (alive) bashSweep();
      }

      // shield recharge
      if (alive) {
        if (shieldDelay > 0) {
          shieldDelay -= dt;
        } else if (p.shield < p.maxShield) {
          if (!recharging) {
            recharging = true;
            ctx.events.emit('player:shield', { playerId: opts.id, shield: p.shield, maxShield: p.maxShield, broken: false });
          }
          const regen = PLAYER.shieldRechargeRate * stats.shieldMult * gearExtras(ctx).shieldRegenMult * skillExtras(ctx).shieldRegenMult;
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
      if (throwPending > 0) {
        throwPending -= dt;
        if (throwPending <= 0) {
          throwPending = 0;
          if (alive) releaseGrenade();
        }
      }

      // class active (docs/SKILL_TREE.md §5.1 player:activeKey); justPressed is false while a screen captures input
      if (alive && input.justPressed('KeyQ')) useActiveKey();
      updateDeadeye();
      const ability = classProgression(ctx)?.activeAbility;
      const abilityReady = !!ability && ability.ready;
      if (abilityReady && !activeWasReady) {
        ctx.events.emit('active:ready', { playerId: opts.id, abilityId: ability!.def.id, name: ability!.def.name });
      }
      activeWasReady = abilityReady;

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
  ctx.events.on('active:used', (e) => {
    if (e.playerId === opts.id) onActiveUsed(e.abilityId, e.duration);
  });
  ctx.events.on('round:started', () => {
    secondWindUsed = false;
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
