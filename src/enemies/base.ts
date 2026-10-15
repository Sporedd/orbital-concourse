/**
 * BaseEnemy: the shared sim (state, statuses, damage, death, steering, collision) and the
 * shared view plumbing (sync root transform, hit flash, status tint, death fall/sink).
 * Subclasses implement think() (AI, mutates state) and animate() (pose, reads state).
 */
import * as THREE from 'three';
import {
  PLAYER, bossDamageMult, bossHealthMult, mobDamageMult, mobHealthMult, playerCountHealthMult,
} from '@/core/config';
import type {
  BossKind, DamageCause, DamageOpts, Element, Enemy, EnemyState, MobKind, PlayerState, RayHit, StatusEffect, Vec3,
} from '@/core/types';
import { ELEMENT_COLORS } from '@/core/types';
import { LUM, PALETTE, glowLum } from '@/rendering/style';
import type { EnemyEnv } from './common';
import { hitPlayer, noRaycast, turnTowards } from './common';
import { updateGlowLod, type Rig } from './models';

/** Serializable per-enemy sim state (EnemyState + the extra timers every enemy needs). */
export interface EnemySimState extends EnemyState {
  velocity: Vec3;
  age: number;
  animTime: number;
  flash: number;
  hitTimer: number;
  stun: number;
  frozen: number;
  iceStacks: number;
  iceWindow: number;
  burnTick: number;
  deathTime: number;
  damageMult: number;
  avoid: Vec3;
  probeTimer: number;
  targetId: string | null;
}

export interface EnemyConfig {
  kind: MobKind | BossKind;
  isBoss: boolean;
  radius: number;
  height: number;
  baseHealth: number;
  /** Relative mass for separation (heavier gets pushed less). */
  mass: number;
  /** Hit-burst colour (ice chips / blood). */
  burstColor: number;
  /** Seconds from death until the object is removed. */
  deathDuration?: number;
  /** Head sphere radius for crit tests (mobs). */
  headRadius?: number;
  /** Height of the torso centre above the feet (bursts, chain targets, splash points). */
  centerHeight?: number;
}

const _desired = new THREE.Vector3();
const _probeDir = new THREE.Vector3();
const _probeOrigin = new THREE.Vector3();
const _next = new THREE.Vector3();
const _head = new THREE.Vector3();
const _cam = new THREE.Vector3();
// hit flash: emissive BONE at lum 1.2 for a few frames (art spec §7: not a white-out)
const WHITE = new THREE.Color(PALETTE.BONE).multiplyScalar(glowLum(PALETTE.BONE, LUM.seam, 4));
const FROZEN_TINT = new THREE.Color(0xbff4ff);
const FIRE_TINT = new THREE.Color(ELEMENT_COLORS.fire);
const SHOCK_TINT = new THREE.Color(ELEMENT_COLORS.shock);
const ICE_TINT = new THREE.Color(ELEMENT_COLORS.ice);

export abstract class BaseEnemy<S extends EnemySimState = EnemySimState> implements Enemy {
  readonly id: string;
  readonly state: S;
  readonly object: THREE.Object3D;
  readonly isBoss: boolean;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly radius: number;
  readonly height: number;
  readonly mass: number;
  readonly burstColor: number;
  readonly deathDuration: number;
  readonly headRadius: number;
  readonly centerHeight: number;
  readonly rig: Rig;
  /** Non-hittable visuals that live directly in the scene (rings, bubbles). The manager adds/removes them. */
  readonly extras: THREE.Object3D[] = [];
  /** Set once the death animation is over; the manager then drops the enemy. */
  removable = false;

  protected readonly env: EnemyEnv;
  /** View-only: accumulated stride phase for limb swing. */
  protected walkPhase = 0;
  /** View-only: stride length factor. */
  protected stride = 1.6;

  constructor(
    env: EnemyEnv, cfg: EnemyConfig, rig: Rig, spawnPos: THREE.Vector3, tier: number,
    extra: Omit<S, keyof EnemySimState>,
  ) {
    const ctx = env.ctx;
    this.env = env;
    this.rig = rig;
    this.object = rig.root;
    this.isBoss = cfg.isBoss;
    this.radius = cfg.radius;
    this.height = cfg.height;
    this.mass = cfg.mass;
    this.burstColor = cfg.burstColor;
    this.deathDuration = cfg.deathDuration ?? (cfg.isBoss ? 3 : 2);
    this.headRadius = cfg.headRadius ?? 0.3;
    this.centerHeight = cfg.centerHeight ?? cfg.height * 0.55;
    this.id = ctx.nextId(cfg.isBoss ? 'boss' : 'mob');

    const t = Math.max(1, Math.floor(tier) || 1);
    const players = Math.max(1, ctx.players.list().length);
    const hpMult = (cfg.isBoss ? bossHealthMult(t) : mobHealthMult(t)) * playerCountHealthMult(players);
    const maxHealth = Math.round(cfg.baseHealth * hpMult);

    this.position = new THREE.Vector3(spawnPos.x, 0, spawnPos.z);
    const res = ctx.world.resolveCapsule(this.position, cfg.radius, cfg.height);
    this.position.set(res.position.x, 0, res.position.z);
    this.position.y = ctx.world.groundHeight(this.position.x, this.position.z);
    this.velocity = new THREE.Vector3();

    let yaw = 0;
    const p = ctx.players.nearest(this.position);
    if (p) yaw = Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z);

    const base: EnemySimState = {
      id: this.id,
      kind: cfg.kind,
      isBoss: cfg.isBoss,
      tier: t,
      // the live Vector3 doubles as the serializable {x,y,z}
      position: this.position,
      yaw,
      health: maxHealth,
      maxHealth,
      alive: true,
      phase: 0,
      anim: 'idle',
      statuses: [],
      velocity: this.velocity,
      age: 0,
      animTime: 0,
      flash: 0,
      hitTimer: 0,
      stun: 0,
      frozen: 0,
      iceStacks: 0,
      iceWindow: 0,
      burnTick: 0,
      deathTime: 0,
      damageMult: cfg.isBoss ? bossDamageMult(t) : mobDamageMult(t),
      avoid: { x: 0, y: 0, z: 0 },
      probeTimer: ctx.rng() * 0.2,
      targetId: null,
    };
    this.state = Object.assign(base, extra) as unknown as S;

    rig.root.position.copy(this.position);
    rig.root.rotation.y = yaw;
    rig.root.traverse((o) => { o.userData.enemyId = this.id; });
  }

  // ---- Enemy contract --------------------------------------------------------------
  get alive(): boolean {
    return this.state.alive;
  }

  isCritPoint(point: THREE.Vector3): boolean {
    const s = this.state;
    if (!s.alive) return false;
    if (s.frozen > 0) return true;
    if (point.y - this.position.y >= this.height * 0.88) return true;
    const head = this.rig.head;
    if (!head) return point.y - this.position.y >= this.height * 0.75;
    head.getWorldPosition(_head);
    const r = this.headRadius * 1.35;
    return _head.distanceToSquared(point) <= r * r;
  }

  damage(amount: number, opts?: DamageOpts): number {
    if (!this.state.alive || !(amount > 0)) return 0;
    return this.applyDamage(
      amount, opts?.crit ?? false, opts?.element ?? 'none', opts?.point, opts?.sourceId, true, opts?.applyStatus ?? false,
      opts?.cause ?? 'other',
    );
  }

  applyStatus(st: StatusEffect): void {
    const s = this.state;
    if (!s.alive || st.element === 'none' || this.isImmune()) return;
    const fx = this.env.ctx.fx;
    switch (st.element) {
      case 'fire':
        this.upsertStatus('fire', st.remaining, st.strength, st.sourceId);
        break;
      case 'shock':
        if (!this.isBoss) s.stun = Math.max(s.stun, st.remaining);
        this.upsertStatus('shock', Math.max(st.remaining, 0.3), 1, st.sourceId);
        // strength > 0 = damage to chain to the nearest other enemy
        if (st.strength > 0) this.chainShock(st.strength, st.sourceId);
        break;
      case 'ice': {
        this.upsertStatus('ice', st.remaining, Math.min(0.9, Math.max(0, st.strength)), st.sourceId);
        if (s.iceWindow <= 0) {
          s.iceStacks = 0;
          s.iceWindow = 4;
        }
        s.iceStacks++;
        if (s.iceStacks >= 3) {
          s.iceStacks = 0;
          s.iceWindow = 0;
          s.frozen = this.isBoss ? 1 : 2;
          this.velocity.set(0, 0, 0);
          fx.burst(this.centerPoint(new THREE.Vector3()), ELEMENT_COLORS.ice, 16);
          this.onFrozen();
        }
        break;
      }
    }
  }

  // ---- sim -------------------------------------------------------------------------
  update(dt: number): void {
    const s = this.state;
    s.age += dt;
    s.animTime += dt;
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dt);
    if (s.hitTimer > 0) s.hitTimer = Math.max(0, s.hitTimer - dt);
    if (s.alive) this.updateStatuses(dt);
    if (s.alive) {
      if (s.frozen > 0 || s.stun > 0) {
        this.brake(dt, 14);
        this.moveAndCollide(dt);
        this.onDisabled(dt);
      } else {
        this.think(dt);
      }
    } else {
      s.deathTime += dt;
      this.onDying(dt);
      if (s.deathTime >= this.deathDuration) this.removable = true;
    }
    this.syncView(dt);
  }

  /** AI step (only called while alive, not frozen, not stunned). */
  protected abstract think(dt: number): void;
  /** Pose the rig from state (view only). */
  protected abstract animate(dt: number): void;

  // hooks
  protected isImmune(): boolean { return false; }
  protected onBlocked(point: THREE.Vector3 | undefined): void { void point; }
  protected modifyIncoming(amount: number, point: THREE.Vector3 | undefined, crit: boolean): number {
    void point; void crit;
    return amount;
  }
  protected afterDamage(amount: number): void { void amount; }
  protected onDeath(killerId: string | undefined): void { void killerId; }
  protected onDying(dt: number): void { void dt; }
  protected onDisabled(dt: number): void { void dt; }
  protected onFrozen(): void {}
  protected customEmissive(): void {}

  protected setAnim(name: string): void {
    if (this.state.anim !== name) {
      this.state.anim = name;
      this.state.animTime = 0;
    }
  }

  /** Torso centre, world space. */
  centerPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.centerHeight, this.position.z);
  }

  /** Returns the damage applied (health actually removed, overkill excluded). */
  protected applyDamage(
    amount: number, crit: boolean, element: Element, point: THREE.Vector3 | undefined,
    sourceId: string | undefined, direct: boolean, rollStatus: boolean, cause: DamageCause = 'other',
  ): number {
    const s = this.state;
    if (!s.alive) return 0;
    const ctx = this.env.ctx;
    if (this.isImmune()) {
      this.onBlocked(point);
      return 0;
    }
    const raw = amount;
    amount = this.modifyIncoming(amount, point, crit);
    if (!(amount > 0)) return 0;
    const before = s.health;
    const p = point ? point.clone() : this.centerPoint(new THREE.Vector3());
    s.health -= amount;
    if (direct) {
      s.flash = 0.08;
      s.hitTimer = 0.18;
      ctx.fx.burst(p.clone(), this.burstColor, crit ? 10 : 6);
    }
    const killed = s.health <= 0;
    if (killed) s.health = 0;
    const applied = Math.max(0, before - s.health);
    ctx.events.emit('damage:dealt', {
      enemyId: this.id, playerId: sourceId, amount, crit, element, point: p, killed, cause,
    });
    this.afterDamage(amount);

    if (rollStatus && element !== 'none') {
      if (element === 'shock') this.chainShock(amount * 0.3, sourceId);
      if (!killed && s.alive) {
        if (element === 'fire') this.applyStatus({ element, remaining: 4, strength: raw * 0.15, sourceId });
        else if (element === 'shock') this.applyStatus({ element, remaining: 0.5, strength: 0, sourceId });
        else if (element === 'ice') this.applyStatus({ element, remaining: 3, strength: 0.35, sourceId });
      }
    }
    if (killed && s.alive) this.die(sourceId, cause);
    return applied;
  }

  protected die(killerId: string | undefined, cause?: DamageCause): void {
    const s = this.state;
    if (!s.alive) return;
    s.alive = false;
    s.health = 0;
    this.setAnim('die');
    s.deathTime = 0;
    s.statuses.length = 0;
    s.stun = 0;
    s.frozen = 0;
    this.velocity.set(0, 0, 0);
    // corpses no longer catch bullets
    this.rig.root.traverse((o) => { o.raycast = noRaycast; });
    this.onDeath(killerId);
    this.env.ctx.events.emit('enemy:killed', {
      enemy: this, position: this.position.clone(), isBoss: this.isBoss, tier: s.tier, killerId, cause,
    });
  }

  private upsertStatus(element: Element, remaining: number, strength: number, sourceId?: string): void {
    for (const x of this.state.statuses) {
      if (x.element === element) {
        x.remaining = Math.max(x.remaining, remaining);
        x.strength = Math.max(x.strength, strength);
        if (sourceId) x.sourceId = sourceId;
        return;
      }
    }
    this.state.statuses.push({ element, remaining, strength, sourceId });
  }

  private updateStatuses(dt: number): void {
    const s = this.state;
    if (s.frozen > 0) s.frozen = Math.max(0, s.frozen - dt);
    if (s.stun > 0) s.stun = Math.max(0, s.stun - dt);
    if (s.iceWindow > 0) {
      s.iceWindow -= dt;
      if (s.iceWindow <= 0) s.iceStacks = 0;
    }
    const list = s.statuses;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      st.remaining -= dt;
      if (st.element === 'fire') {
        s.burnTick += dt;
        while (s.burnTick >= 0.4 && s.alive) {
          s.burnTick -= 0.4;
          this.burnTick(st.strength * 0.4, st.sourceId);
        }
        if (!s.alive) return;
      }
      if (st.remaining <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
        if (st.element === 'fire') s.burnTick = 0;
      }
    }
  }

  private burnTick(amount: number, sourceId: string | undefined): void {
    if (!(amount > 0)) return;
    const p = this.centerPoint(new THREE.Vector3());
    p.x += (this.env.ctx.rng() - 0.5) * this.radius;
    p.z += (this.env.ctx.rng() - 0.5) * this.radius;
    if (!this.isImmune()) this.env.ctx.fx.burst(p.clone(), ELEMENT_COLORS.fire, 5);
    this.applyDamage(amount, false, 'fire', p, sourceId, false, false, 'status');
  }

  private chainShock(amount: number, sourceId: string | undefined): void {
    if (!(amount > 0)) return;
    let best: BaseEnemy | null = null;
    let bestD = 36; // 6 m
    for (const o of this.env.enemies) {
      if (o === (this as BaseEnemy) || !o.state.alive) continue;
      const dx = o.position.x - this.position.x;
      const dz = o.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = o;
      }
    }
    if (!best) return;
    const fx = this.env.ctx.fx;
    const from = this.centerPoint(new THREE.Vector3());
    const to = best.centerPoint(new THREE.Vector3());
    fx.tracer(from, to.clone(), ELEMENT_COLORS.shock, 0.08);
    fx.burst(to.clone(), ELEMENT_COLORS.shock, 8);
    best.damage(amount, { element: 'shock', crit: false, sourceId, point: to, applyStatus: false, cause: 'status' });
    best.applyStatus({ element: 'shock', remaining: 0.5, strength: 0, sourceId });
  }

  // ---- movement helpers ----------------------------------------------------------
  /** Multiplier from ice slow / freeze. */
  protected speedMult(): number {
    const s = this.state;
    if (s.frozen > 0) return 0;
    let m = 1;
    for (const st of s.statuses) if (st.element === 'ice') m = Math.min(m, 1 - st.strength);
    return Math.max(0.15, m);
  }

  protected findTarget(): PlayerState | undefined {
    const p = this.env.ctx.players.nearest(this.position);
    this.state.targetId = p ? p.id : null;
    return p;
  }

  /** Horizontal unit direction to a point in `out`; returns the horizontal distance. */
  protected flatDirTo(target: THREE.Vector3, out: THREE.Vector3): number {
    out.set(target.x - this.position.x, 0, target.z - this.position.z);
    const d = Math.hypot(out.x, out.z);
    if (d > 1e-5) out.multiplyScalar(1 / d);
    else out.set(0, 0, 1);
    return d;
  }

  /**
   * Steering: seek `dir` (horizontal, unit or zero) at `speed`, plus separation from other
   * enemies and wall avoidance (periodic world raycast probe), then accelerate towards it.
   */
  protected steer(dir: THREE.Vector3, speed: number, dt: number, accel = 10, separate = true): void {
    const s = this.state;
    const sm = this.speedMult();
    const desired = _desired.set(dir.x, 0, dir.z).multiplyScalar(speed * sm);
    if (separate) {
      const list = this.env.enemies;
      const push = Math.max(speed, 3);
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === (this as BaseEnemy) || !o.state.alive) continue;
        let dx = this.position.x - o.position.x;
        let dz = this.position.z - o.position.z;
        const min = this.radius + o.radius + 0.35;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          // perfectly stacked: push apart along a fixed axis, opposite signs for the pair
          const sgn = this.id < o.id ? 1 : -1;
          dx = 0.5 * sgn;
          dz = 0.5 * sgn;
          d = Math.hypot(dx, dz);
        }
        const w = (1 - d / min) * (o.mass / (o.mass + this.mass)) * 2 * push;
        desired.x += (dx / d) * w;
        desired.z += (dz / d) * w;
      }
    }
    s.probeTimer -= dt;
    if (s.probeTimer <= 0) {
      s.probeTimer = 0.18 + this.env.ctx.rng() * 0.06;
      this.probe(dir);
    }
    desired.x += s.avoid.x * speed * sm;
    desired.z += s.avoid.z * speed * sm;
    const k = Math.min(1, accel * dt);
    this.velocity.x += (desired.x - this.velocity.x) * k;
    this.velocity.z += (desired.z - this.velocity.z) * k;
    this.velocity.y = 0;
  }

  private probe(dir: THREE.Vector3): void {
    const s = this.state;
    if (dir.x * dir.x + dir.z * dir.z < 0.01) {
      s.avoid.x *= 0.5;
      s.avoid.z *= 0.5;
      return;
    }
    const d = _probeDir.set(dir.x, 0, dir.z).normalize();
    const world = this.env.ctx.world;
    const y = this.position.y + Math.min(0.8, this.height * 0.4);
    const dist = this.radius + 2.2;
    // Three feelers: centre plus both capsule edges, so wide bodies notice walls the centre
    // ray slips past. The nearest blocking hit drives the avoidance.
    const side = this.radius * 0.9;
    let best: RayHit | null = null;
    let bestOff = 0;
    let clearL = true;
    let clearR = true;
    for (let k = -1; k <= 1; k++) {
      const o = _probeOrigin.set(this.position.x - d.z * side * k, y, this.position.z + d.x * side * k);
      const hit = world.raycast(o, d, dist);
      if (!hit || Math.abs(hit.normal.y) > 0.7) continue;
      if (k < 0) clearL = false;
      if (k > 0) clearR = false;
      if (!best || hit.distance < best.distance) {
        best = hit;
        bestOff = k;
      }
    }
    if (!best) {
      // keep sliding for a moment after clearing an obstacle instead of turning straight
      // back into it (hysteresis against wall-hugging oscillation)
      s.avoid.x *= 0.6;
      s.avoid.z *= 0.6;
      return;
    }
    let nx = best.normal.x;
    let nz = best.normal.z;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    let tx = -nz;
    let tz = nx;
    // side choice: keep the current slide direction if there is one, else go towards the
    // clear feeler, else away from the side that hit first
    const prev = s.avoid.x * tx + s.avoid.z * tz;
    let sign: number;
    if (Math.abs(prev) > 0.05) sign = Math.sign(prev);
    else {
      // +k feeler sits at (-d.z, d.x) from the centre
      const lx = -d.z;
      const lz = d.x;
      const towards = clearR && !clearL ? 1 : clearL && !clearR ? -1 : bestOff !== 0 ? -bestOff : 1;
      sign = Math.sign((lx * tx + lz * tz) * towards) || 1;
    }
    tx *= sign;
    tz *= sign;
    const w = Math.max(0.35, 1 - best.distance / dist);
    s.avoid.x = (nx * 0.8 + tx * 1.2) * w;
    s.avoid.z = (nz * 0.8 + tz * 1.2) * w;
  }

  /**
   * Bodies don't overlap players: without this, lunging grunts ended up inside the camera
   * (hiding the viewmodel and the whole screen behind their mesh).
   */
  private pushOutOfPlayers(): void {
    const p = this.position;
    const players = this.env.ctx.players?.list();
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
      const pl = players[i];
      if (!pl.alive) continue;
      const pp = pl.position;
      if (pp.y > p.y + this.height || pp.y + PLAYER.height < p.y) continue;
      const min = this.radius + PLAYER.radius + 0.15;
      let dx = p.x - pp.x;
      let dz = p.z - pp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) {
        dx = -Math.sin(this.state.yaw);
        dz = -Math.cos(this.state.yaw);
        d = 1;
      }
      _next.set(pp.x + (dx / d) * min, p.y, pp.z + (dz / d) * min);
      const res = this.env.ctx.world.resolveCapsule(_next, this.radius, this.height);
      p.x = res.position.x;
      p.z = res.position.z;
      // kill the velocity component into the player
      const nx = dx / d;
      const nz = dz / d;
      const vn = this.velocity.x * nx + this.velocity.z * nz;
      if (vn < 0) {
        this.velocity.x -= vn * nx;
        this.velocity.z -= vn * nz;
      }
    }
  }

  /** Integrate velocity, resolve against the world, stick to the ground. Returns actual/intended step ratio. */
  protected moveAndCollide(dt: number): number {
    const world = this.env.ctx.world;
    const p = this.position;
    const v = this.velocity;
    const ix = v.x * dt;
    const iz = v.z * dt;
    _next.set(p.x + ix, p.y, p.z + iz);
    const res = world.resolveCapsule(_next, this.radius, this.height);
    const rx = res.position.x;
    const rz = res.position.z;
    if (!Number.isFinite(rx) || !Number.isFinite(rz)) return 1;
    const ax = rx - p.x;
    const az = rz - p.z;
    p.x = rx;
    p.z = rz;
    // Keep the stepped-up height while the capsule still rests on a box (stairs, altar
    // tiers). Snapping to groundHeight(centre) instead dropped big enemies back to y=0
    // every frame, so the next tier counted as a wall and pushed them back (brute stuck
    // at the altar).
    p.y = res.onGround ? res.position.y : world.groundHeight(p.x, p.z);
    this.pushOutOfPlayers();
    const intended = Math.hypot(ix, iz);
    if (intended < 1e-5) return 1;
    const ratio = Math.hypot(ax, az) / intended;
    if (ratio < 0.85 && dt > 0) {
      v.x = ax / dt;
      v.z = az / dt;
    }
    return ratio;
  }

  protected brake(dt: number, k = 8): void {
    const f = Math.max(0, 1 - k * dt);
    this.velocity.x *= f;
    this.velocity.z *= f;
  }

  protected faceYaw(target: number, rate: number, dt: number): void {
    this.state.yaw = turnTowards(this.state.yaw, target, rate * dt);
  }

  protected faceDir(x: number, z: number, rate: number, dt: number): void {
    if (x * x + z * z > 1e-6) this.faceYaw(Math.atan2(x, z), rate, dt);
  }

  protected faceMovement(dt: number, rate = 8): void {
    const v = this.velocity;
    if (v.x * v.x + v.z * v.z > 0.25) this.faceYaw(Math.atan2(v.x, v.z), rate, dt);
  }

  /** Clear line from this enemy's chest to the player's chest? */
  protected hasLineOfSight(p: PlayerState, fromHeight = this.centerHeight): boolean {
    const o = _probeOrigin.set(this.position.x, this.position.y + fromHeight, this.position.z);
    const d = _probeDir.set(p.position.x, p.position.y + 1.2, p.position.z).sub(o);
    const len = d.length();
    if (len < 1e-3) return true;
    d.multiplyScalar(1 / len);
    const hit = this.env.ctx.world.raycast(o, d, len);
    return !hit || hit.distance >= len - 0.4;
  }

  protected attackPlayer(p: PlayerState, amount: number, element: Element = 'none'): void {
    hitPlayer(p, amount * this.state.damageMult, this.id, this.position, element);
  }

  protected emitAttack(kind: string): void {
    this.env.ctx.events.emit('enemy:attack', { enemy: this, kind });
  }

  // ---- view ------------------------------------------------------------------------
  protected syncView(dt: number): void {
    const s = this.state;
    const root = this.rig.root;
    root.position.copy(this.position);
    root.rotation.set(0, s.yaw, 0);
    root.scale.setScalar(this.rig.scale);
    if (s.frozen <= 0) {
      if (s.alive) this.walkPhase += Math.hypot(this.velocity.x, this.velocity.z) * dt * this.stride;
      this.animate(dt);
    }
    if (!s.alive) this.applyDeathPose();
    this.updateEmissive();
    const cam = this.env.ctx.camera;
    if (cam) updateGlowLod(this.rig, _cam.setFromMatrixPosition(cam.matrixWorld));
  }

  private applyDeathPose(): void {
    const t = this.state.deathTime;
    const root = this.rig.root;
    const k = Math.min(1, t / 0.45);
    const fall = 1 - (1 - k) * (1 - k);
    if (this.isBoss) root.rotation.z = fall * 1.35;
    else root.rotation.x = -fall * 1.45;
    const sinkStart = this.deathDuration * 0.45;
    if (t > sinkStart) {
      const u = Math.min(1, (t - sinkStart) / (this.deathDuration - sinkStart));
      root.position.y -= u * this.height * 0.4;
      root.scale.setScalar(this.rig.scale * Math.max(0.05, 1 - 0.75 * u));
    }
  }

  private updateEmissive(): void {
    const s = this.state;
    const mats = this.rig.mats;
    const base = this.rig.baseEmissive;
    let tint: THREE.Color | null = null;
    let k = 0;
    if (s.alive) {
      if (s.flash > 0) {
        tint = WHITE;
        k = 1;
      } else if (s.frozen > 0) {
        tint = FROZEN_TINT;
        k = 0.75;
      } else if (s.statuses.length) {
        let fire = false;
        let shock = false;
        let ice = false;
        for (const st of s.statuses) {
          if (st.element === 'fire') fire = true;
          else if (st.element === 'shock') shock = true;
          else if (st.element === 'ice') ice = true;
        }
        if (fire) {
          tint = FIRE_TINT;
          k = 0.35 + 0.15 * Math.sin(s.age * 14);
        } else if (shock) {
          tint = SHOCK_TINT;
          k = Math.sin(s.age * 47) > 0 ? 0.65 : 0.25;
        } else if (ice) {
          tint = ICE_TINT;
          k = 0.35;
        }
      }
    }
    for (let i = 0; i < mats.length; i++) {
      const e = mats[i].emissive;
      e.copy(base[i]);
      if (tint) e.lerp(tint, k);
    }
    if (s.alive && s.flash <= 0 && s.frozen <= 0) this.customEmissive();
  }

  /** Remove per-enemy GPU resources (geometries are shared and kept). */
  dispose(): void {
    for (const m of this.rig.owned) m.dispose();
  }
}

