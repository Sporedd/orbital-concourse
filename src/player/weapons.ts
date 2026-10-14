/**
 * Weapon slots, firing (hitscan pellets with spread), recoil, reload, swapping and perks.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import { ELEMENT_COLORS } from '@/core/types';
import type { Enemy, GameContext, PlayerStats, WeaponArchetype, WeaponDef } from '@/core/types';
import type { Controller } from './controller';
import { SWAP_TIME, type Viewmodel } from './viewmodel';
import { damp, gearExtras, getStats, runDamageMult } from './shared';
import { createRng } from '@/core/rng';

// ---- tunables ---------------------------------------------------------------
const RESERVE_MAGS = 4; // fresh weapon / addAmmo unit
const RESERVE_CAP_MAGS = 10;
const TRIGGER_BUFFER = 0.12; // semi-auto press buffered this long while on cooldown
const RECOIL_RECOVER_DELAY = 0.06; // recoil only recovers after this long without a shot
const MAX_RECOIL_PITCH = 0.18;
const RICOCHET_RANGE = 8;
const RICOCHET_FACTOR = 0.5;
const SPLASH_RADIUS = 2;
const SPLASH_FACTOR = 0.3;
const LIFESTEAL_FACTOR = 0.03;
const RAMP_WINDOW = 0.5;
const RAMP_PER_STACK = 0.03;
const RAMP_MAX_STACKS = 10;
const DOUBLE_TAP_CHANCE = 0.1;

interface RecoilProfile {
  pitch: number; // camera kick, rad
  yaw: number; // random horizontal jitter, rad
  vmKick: number; // viewmodel push back
  vmRot: number; // viewmodel muzzle climb
  shake: number; // fx.shake per shot
  recover: number; // 1/s
}

const RECOIL: Record<WeaponArchetype, RecoilProfile> = {
  pistol: { pitch: 0.022, yaw: 0.006, vmKick: 0.07, vmRot: 0.12, shake: 0.05, recover: 11 },
  smg: { pitch: 0.009, yaw: 0.008, vmKick: 0.035, vmRot: 0.05, shake: 0.03, recover: 9 },
  shotgun: { pitch: 0.06, yaw: 0.012, vmKick: 0.16, vmRot: 0.3, shake: 0.22, recover: 7 },
  rifle: { pitch: 0.012, yaw: 0.005, vmKick: 0.05, vmRot: 0.07, shake: 0.04, recover: 9 },
  sniper: { pitch: 0.085, yaw: 0.01, vmKick: 0.2, vmRot: 0.35, shake: 0.3, recover: 5 },
};

interface Slot {
  def: WeaponDef;
  ammo: number;
  reserve: number;
}

interface TraceHit {
  enemy: Enemy | null;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null; // world hits only
}

export interface WeaponHost {
  readonly id: string;
  readonly controller: Controller;
  readonly viewmodel: Viewmodel;
  heal(amount: number): void;
}

/** Presentation-only randomness (recoil jitter): keeps the sim RNG (ctx.rng) deterministic. */
const presRng = createRng(0x2ec011);

const hasPerk = (def: WeaponDef, id: string) => def.perks.some((p) => p.id === id);

export class WeaponSystem {
  /** Exposed as PlayerState.weapons (same array instance, mutated in place). */
  readonly weapons: (WeaponDef | null)[];
  private readonly slots: (Slot | null)[];
  active = 0;

  private cooldown = 0;
  private reloadLeft = 0;
  private swapLeft = 0;
  private lockLeft = 0;
  private triggerBuffer = 0;
  private time = 0;
  private lastShot = -10;
  private rampStacks = 0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly hitBuf: THREE.Intersection[] = [];
  private readonly targets: THREE.Object3D[] = [];
  private readonly rootMap = new Map<THREE.Object3D, Enemy>();
  private readonly vOrigin = new THREE.Vector3();
  private readonly vFwd = new THREE.Vector3();
  private readonly vRight = new THREE.Vector3();
  private readonly vUp = new THREE.Vector3();
  private readonly vDir = new THREE.Vector3();
  private readonly vMuzzle = new THREE.Vector3();

  constructor(private readonly ctx: GameContext, private readonly host: WeaponHost) {
    const n = PLAYER.weaponSlots;
    this.weapons = new Array<WeaponDef | null>(n).fill(null);
    this.slots = new Array<Slot | null>(n).fill(null);
  }

  // ---- accessors ------------------------------------------------------------
  get activeWeapon(): WeaponDef | null {
    return this.slots[this.active]?.def ?? null;
  }
  get ammo(): number {
    return this.slots[this.active]?.ammo ?? 0;
  }
  set ammo(v: number) {
    const s = this.slots[this.active];
    if (s) {
      s.ammo = Math.max(0, Math.min(s.def.magSize, Math.floor(v)));
      this.emitAmmo();
    }
  }
  get reserve(): number {
    return this.slots[this.active]?.reserve ?? 0;
  }
  set reserve(v: number) {
    const s = this.slots[this.active];
    if (s) {
      s.reserve = Math.max(0, Math.floor(v));
      this.emitAmmo();
    }
  }
  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  emitAmmo(): void {
    const s = this.slots[this.active];
    this.ctx.events.emit('weapon:ammo', {
      playerId: this.host.id,
      ammo: s?.ammo ?? 0,
      reserve: s?.reserve ?? 0,
      magSize: s?.def.magSize ?? 0,
    });
  }

  // ---- inventory ------------------------------------------------------------
  equip(weapon: WeaponDef): WeaponDef | null {
    let slot = this.active;
    if (this.slots[slot]) {
      const empty = this.slots.findIndex((s) => s === null);
      if (empty >= 0) slot = empty;
    }
    const old = this.slots[slot]?.def ?? null;
    this.slots[slot] = { def: weapon, ammo: weapon.magSize, reserve: weapon.magSize * RESERVE_MAGS };
    this.weapons[slot] = weapon;
    if (slot === this.active) this.onActiveChanged(true);
    this.ctx.events.emit('weapon:equipped', { playerId: this.host.id, weapon, slot });
    this.emitAmmo();
    return old;
  }

  addAmmo(fraction: number): void {
    let s = this.slots[this.active];
    if (!s) s = this.slots.find((x) => x !== null) ?? null;
    if (!s || !(fraction > 0)) return;
    const cap = s.def.magSize * RESERVE_CAP_MAGS;
    const add = Math.max(1, Math.round(fraction * s.def.magSize * RESERVE_MAGS));
    s.reserve = Math.max(s.reserve, Math.min(cap, s.reserve + add));
    this.emitAmmo();
  }

  refillAll(): void {
    for (const s of this.slots) {
      if (!s) continue;
      s.ammo = s.def.magSize;
      s.reserve = Math.max(s.reserve, s.def.magSize * RESERVE_MAGS);
    }
    this.emitAmmo();
  }

  /** Clear transient state (new run / death). */
  resetState(): void {
    this.cancelReload();
    this.cooldown = 0;
    this.swapLeft = 0;
    this.lockLeft = 0;
    this.triggerBuffer = 0;
    this.rampStacks = 0;
    this.host.controller.recoilPitch = 0;
    this.host.controller.recoilYaw = 0;
  }

  /** Block firing for a moment (melee, grenade throw). */
  lock(seconds: number): void {
    this.lockLeft = Math.max(this.lockLeft, seconds);
  }

  switchTo(slot: number): void {
    if (slot === this.active || slot < 0 || slot >= this.slots.length) return;
    const s = this.slots[slot];
    if (!s) return;
    this.active = slot;
    this.onActiveChanged(true);
    this.ctx.events.emit('weapon:equipped', { playerId: this.host.id, weapon: s.def, slot });
    this.emitAmmo();
  }

  private cycle(dir: number): void {
    const n = this.slots.length;
    for (let i = 1; i < n; i++) {
      const idx = (((this.active + dir * i) % n) + n) % n;
      if (this.slots[idx]) {
        this.switchTo(idx);
        return;
      }
    }
  }

  private onActiveChanged(animate: boolean): void {
    this.cancelReload();
    this.rampStacks = 0;
    this.triggerBuffer = 0;
    this.cooldown = 0;
    this.host.viewmodel.setWeapon(this.activeWeapon, animate);
    this.swapLeft = animate ? SWAP_TIME : 0;
  }

  // ---- reload ---------------------------------------------------------------
  startReload(): boolean {
    const s = this.slots[this.active];
    if (!s || this.reloadLeft > 0 || s.ammo >= s.def.magSize || s.reserve <= 0) return false;
    const dur = Math.max(0.2, s.def.reloadTime * getStats(this.ctx).reloadMult);
    this.reloadLeft = dur;
    this.host.viewmodel.startReload(dur);
    this.ctx.events.emit('weapon:reload', { playerId: this.host.id, weapon: s.def, duration: dur });
    return true;
  }

  cancelReload(): void {
    if (this.reloadLeft > 0) this.host.viewmodel.cancelReload();
    this.reloadLeft = 0;
  }

  private finishReload(): void {
    this.reloadLeft = 0;
    const s = this.slots[this.active];
    if (!s) return;
    const take = Math.min(s.def.magSize - s.ammo, s.reserve);
    s.ammo += take;
    s.reserve -= take;
    this.emitAmmo();
  }

  // ---- per frame --------------------------------------------------------------
  update(dt: number, canAct: boolean): void {
    const input = this.ctx.input;
    this.time += dt;
    this.cooldown -= dt;
    if (this.swapLeft > 0) this.swapLeft -= dt;
    if (this.lockLeft > 0) this.lockLeft -= dt;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.finishReload();
    }

    // recoil recovery
    const ctl = this.host.controller;
    const prof = RECOIL[this.activeWeapon?.archetype ?? 'rifle'] ?? RECOIL.rifle;
    if (this.time - this.lastShot > RECOIL_RECOVER_DELAY) {
      const k = damp(prof.recover, dt);
      ctl.recoilPitch -= ctl.recoilPitch * k;
      ctl.recoilYaw -= ctl.recoilYaw * k;
    }

    if (!canAct) {
      this.triggerBuffer = 0;
      if (this.cooldown < 0) this.cooldown = 0;
      return;
    }

    // swapping
    if (input.justPressed('Digit1')) this.switchTo(0);
    else if (input.justPressed('Digit2')) this.switchTo(1);
    const wheel = input.wheelDelta();
    if (wheel !== 0) this.cycle(wheel > 0 ? 1 : -1);

    const slot = this.slots[this.active];
    if (!slot) {
      if (this.cooldown < 0) this.cooldown = 0;
      return;
    }
    if (input.justPressed('KeyR')) this.startReload();

    const pressed = input.mouseJustPressed(0);
    if (pressed) this.triggerBuffer = TRIGGER_BUFFER;
    else this.triggerBuffer -= dt;
    const def = slot.def;
    const want = def.auto ? input.mouseIsDown(0) || this.triggerBuffer > 0 : this.triggerBuffer > 0;
    const blocked = this.swapLeft > 0 || this.lockLeft > 0 || this.reloadLeft > 0;

    if (!want || blocked || this.cooldown > 0) {
      if (!want && this.cooldown < 0) this.cooldown = 0;
      return;
    }

    if (slot.ammo <= 0) {
      this.triggerBuffer = 0;
      if (slot.reserve > 0) this.startReload();
      else if (pressed) this.ctx.audio.play('empty');
      this.cooldown = 0.2;
      return;
    }

    const stats = getStats(this.ctx);
    const ramp = hasPerk(def, 'ramp_up');
    const doubleTap = hasPerk(def, 'double_tap');
    let shots = 0;
    while (this.cooldown <= 0 && slot.ammo > 0 && shots < 3) {
      if (this.time - this.lastShot < RAMP_WINDOW) this.rampStacks = Math.min(RAMP_MAX_STACKS, this.rampStacks + 1);
      else this.rampStacks = 0;
      this.lastShot = this.time;

      slot.ammo--;
      this.shoot(slot, stats, false);
      if (doubleTap && this.ctx.rng() < DOUBLE_TAP_CHANCE) this.shoot(slot, stats, true);

      const rampMult = ramp ? 1 + RAMP_PER_STACK * this.rampStacks : 1;
      const rate = Math.max(0.1, def.fireRate * stats.fireRateMult * rampMult);
      this.cooldown += 1 / rate;
      shots++;
      if (!def.auto) {
        this.triggerBuffer = 0;
        break;
      }
    }
    if (this.cooldown < 0) this.cooldown = 0;
    this.emitAmmo();
  }

  // ---- shooting ---------------------------------------------------------------
  private spreadMult(): number {
    const c = this.host.controller;
    if (!c.onGround) return 1.8;
    const s = Math.min(1.5, c.horizontalSpeed / PLAYER.walkSpeed);
    return 0.7 + 0.45 * s; // rest 0.7, walk 1.15, sprint ~1.36
  }

  private buildTargets(): void {
    this.targets.length = 0;
    this.rootMap.clear();
    const enemies = this.ctx.enemies;
    if (!enemies) return;
    for (const e of enemies.list()) {
      if (!e.alive || !e.object) continue;
      this.targets.push(e.object);
      this.rootMap.set(e.object, e);
    }
  }

  /** Nearest enemy or wall along a ray. Enemy roots must be prepared with buildTargets(). */
  private trace(origin: THREE.Vector3, dir: THREE.Vector3, range: number, exclude: Enemy | null): TraceHit {
    let enemyHit: Enemy | null = null;
    let enemyDist = Infinity;
    let enemyPoint: THREE.Vector3 | null = null;
    if (this.targets.length > 0) {
      this.raycaster.set(origin, dir);
      this.raycaster.near = 0;
      this.raycaster.far = range;
      this.hitBuf.length = 0;
      this.raycaster.intersectObjects(this.targets, true, this.hitBuf);
      for (const h of this.hitBuf) {
        if (!(h.object as THREE.Mesh).isMesh) continue;
        let o: THREE.Object3D | null = h.object;
        let visible = true;
        while (o && !this.rootMap.has(o)) {
          if (!o.visible) visible = false;
          o = o.parent;
        }
        if (!o || !visible || !o.visible) continue;
        const e = this.rootMap.get(o)!;
        if (e === exclude || !e.alive) continue;
        enemyHit = e;
        enemyDist = h.distance;
        enemyPoint = h.point.clone();
        break;
      }
    }
    const wall = this.ctx.world.raycast(origin, dir, range);
    if (enemyHit && enemyPoint && (!wall || enemyDist <= wall.distance)) {
      return { enemy: enemyHit, point: enemyPoint, normal: null };
    }
    if (wall) return { enemy: null, point: wall.point.clone(), normal: wall.normal.clone() };
    return { enemy: null, point: origin.clone().addScaledVector(dir, range), normal: null };
  }

  private coneDir(fwd: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
    const rng = this.ctx.rng;
    const theta = spread * Math.sqrt(rng());
    const phi = rng() * Math.PI * 2;
    const st = Math.sin(theta);
    return out
      .copy(fwd)
      .multiplyScalar(Math.cos(theta))
      .addScaledVector(this.vRight, Math.cos(phi) * st)
      .addScaledVector(this.vUp, Math.sin(phi) * st)
      .normalize();
  }

  private shoot(slot: Slot, stats: PlayerStats, extra: boolean): void {
    const ctx = this.ctx;
    const def = slot.def;
    const cam = ctx.camera;
    cam.updateMatrixWorld(true);
    const origin = cam.getWorldPosition(this.vOrigin);
    const fwd = cam.getWorldDirection(this.vFwd);
    this.vRight.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    this.vUp.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const muzzle = this.host.viewmodel.muzzleWorld(this.vMuzzle);

    const color = ELEMENT_COLORS[def.element] ?? ELEMENT_COLORS.none;
    const spread = Math.max(0, def.spread) * this.spreadMult();
    const pellets = Math.max(1, Math.round(def.pellets));
    const baseDmg = def.damage * stats.damageMult * runDamageMult(ctx);
    const ricochet = hasPerk(def, 'ricochet');
    const critRefund = hasPerk(def, 'crit_refund');
    const splash = hasPerk(def, 'splash');
    const lifesteal = hasPerk(def, 'lifesteal');
    const statusChance = def.elementChance + gearExtras(ctx).elementChanceBonus;
    const rollStatus = () => def.element !== 'none' && def.elementChance > 0 && ctx.rng() < statusChance;

    this.buildTargets();
    let hits = 0;
    let dealt = 0;
    let refunded = false;

    for (let i = 0; i < pellets; i++) {
      const dir = this.coneDir(fwd, spread, this.vDir);
      const hit = this.trace(origin, dir, def.range, null);
      ctx.fx.tracer(muzzle, hit.point, color);

      if (hit.enemy) {
        const enemy = hit.enemy;
        const crit = enemy.isCritPoint(hit.point);
        const amount = crit ? baseDmg * def.critMultiplier * stats.critMult : baseDmg;
        const applied = enemy.damage(amount, {
          point: hit.point.clone(),
          element: def.element,
          crit,
          sourceId: this.host.id,
          applyStatus: rollStatus(),
          cause: 'bullet',
        });
        // Immune targets (shielded Summoner) swallow the hit: no hit count, lifesteal, refund
        // or on-hit perks off damage that never landed.
        if (applied <= 0) {
          ctx.fx.burst(hit.point, color, 3);
          continue;
        }
        hits++;
        dealt += applied;

        if (crit && critRefund && !refunded) {
          refunded = true;
          slot.ammo = Math.min(def.magSize, slot.ammo + 1);
        }
        if (splash) {
          ctx.enemies.damageRadius(hit.point, SPLASH_RADIUS, amount * SPLASH_FACTOR, {
            point: hit.point.clone(),
            element: def.element,
            sourceId: this.host.id,
            excludeId: enemy.id, // splash is for the enemies around the target, not the target
            cause: 'bullet',
          });
          ctx.fx.burst(hit.point, color, 6);
          dealt += amount * SPLASH_FACTOR * 0.5; // rough share for lifesteal
        }
        if (ricochet) dealt += this.ricochet(enemy, hit.point, amount * RICOCHET_FACTOR, def, color, rollStatus);
      } else if (hit.normal) {
        ctx.fx.impact(hit.point, hit.normal, color);
      }
    }

    if (lifesteal && dealt > 0) this.host.heal(dealt * LIFESTEAL_FACTOR);

    ctx.events.emit('weapon:fired', {
      playerId: this.host.id,
      weapon: def,
      origin: origin.clone(),
      direction: fwd.clone(),
      hits,
    });

    // recoil + presentation
    const prof = RECOIL[def.archetype] ?? RECOIL.rifle;
    const scale = extra ? 0.5 : 1;
    const ctl = this.host.controller;
    ctl.recoilPitch = Math.min(MAX_RECOIL_PITCH, ctl.recoilPitch + prof.pitch * scale * (0.85 + presRng() * 0.3));
    ctl.recoilYaw += (presRng() - 0.5) * 2 * prof.yaw * scale;
    ctl.sprintBlock = 0.35;
    this.host.viewmodel.kick(prof.vmKick * scale, prof.vmRot * scale);
    this.host.viewmodel.flash();
    ctx.fx.shake(prof.shake * scale);
  }

  /** Bounce to the nearest other living enemy within range. Returns damage dealt. */
  private ricochet(
    from: Enemy,
    point: THREE.Vector3,
    amount: number,
    def: WeaponDef,
    color: number,
    rollStatus: () => boolean,
  ): number {
    let best: Enemy | null = null;
    let bestD = RICOCHET_RANGE;
    const aim = new THREE.Vector3();
    const bestAim = new THREE.Vector3();
    for (const e of this.ctx.enemies.list()) {
      if (e === from || !e.alive) continue;
      aim.copy(e.position);
      aim.y += e.height * 0.5;
      const d = aim.distanceTo(point);
      if (d < bestD) {
        bestD = d;
        best = e;
        bestAim.copy(aim);
      }
    }
    if (!best) return 0;
    const dir = bestAim.clone().sub(point).normalize();
    const wall = this.ctx.world.raycast(point, dir, bestD);
    if (wall && wall.distance < bestD - 0.3) return 0;
    const applied = best.damage(amount, {
      point: bestAim.clone(),
      element: def.element,
      crit: false,
      sourceId: this.host.id,
      applyStatus: rollStatus(),
      cause: 'bullet',
    });
    this.ctx.fx.tracer(point, bestAim, color);
    return applied;
  }
}
