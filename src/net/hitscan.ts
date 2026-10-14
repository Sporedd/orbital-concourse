/**
 * Host-side hitscan for remote shooters, kept consistent with src/player/weapons.ts:
 * pellets in a cone (sqrt-uniform), spread × movement multiplier, nearest enemy mesh vs
 * nearest wall, crit via enemy.isCritPoint, damage = weapon.damage × damageMult and
 * × critMultiplier × critMult on crits, element status rolled per hit.
 *
 * Two entry points:
 *  - hostHitscan(): the host traces the shot itself (used when a client sends no claims).
 *  - validateClaim(): a client's own weapon code produced a hit against its mirrored enemy;
 *    the host checks it is plausible (enemy alive, in range, not through a wall, damage
 *    within the weapon's cap) and applies it. This hides the 100 ms interpolation delay +
 *    latency that a pure host trace would punish the client with.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { Element, Enemy, GameContext, WorldQuery } from '@/core/types';
import { ELEMENT_COLORS } from '@/core/types';
import type { HitW, WeaponStats } from './protocol';
import { dec } from './protocol';

export interface TraceHit {
  enemy: Enemy | null;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  distance: number;
}

/** Reusable trace state (raycaster + enemy root lookup). */
export class HitscanTracer {
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly targets: THREE.Object3D[] = [];
  private readonly rootMap = new Map<THREE.Object3D, Enemy>();

  prepare(enemies: readonly Enemy[]): void {
    this.targets.length = 0;
    this.rootMap.clear();
    for (const e of enemies) {
      if (!e.alive || !e.object) continue;
      this.targets.push(e.object);
      this.rootMap.set(e.object, e);
    }
  }

  /** Nearest enemy or wall along a ray (same rules as WeaponSystem.trace). */
  trace(world: WorldQuery, origin: THREE.Vector3, dir: THREE.Vector3, range: number, exclude: Enemy | null = null): TraceHit {
    let enemyHit: Enemy | null = null;
    let enemyDist = Infinity;
    let enemyPoint: THREE.Vector3 | null = null;
    if (this.targets.length) {
      this.raycaster.set(origin, dir);
      this.raycaster.near = 0;
      this.raycaster.far = range;
      this.hits.length = 0;
      this.raycaster.intersectObjects(this.targets, true, this.hits);
      for (const h of this.hits) {
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
    const wall = world.raycast(origin, dir, range);
    if (enemyHit && enemyPoint && (!wall || enemyDist <= wall.distance)) {
      return { enemy: enemyHit, point: enemyPoint, normal: null, distance: enemyDist };
    }
    if (wall) return { enemy: null, point: wall.point.clone(), normal: wall.normal.clone(), distance: wall.distance };
    return { enemy: null, point: origin.clone().addScaledVector(dir, range), normal: null, distance: range };
  }
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Random direction in a cone around `fwd` (sqrt-uniform like WeaponSystem.coneDir). */
export function coneDir(rng: () => number, fwd: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
  _right.crossVectors(fwd, WORLD_UP);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(_right, fwd).normalize();
  const theta = spread * Math.sqrt(rng());
  const phi = rng() * Math.PI * 2;
  const st = Math.sin(theta);
  return out
    .copy(fwd)
    .multiplyScalar(Math.cos(theta))
    .addScaledVector(_right, Math.cos(phi) * st)
    .addScaledVector(_up, Math.sin(phi) * st)
    .normalize();
}

export interface ShotSpec {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  weapon: WeaponStats;
  damageMult: number;
  critMult: number;
  /** Movement spread multiplier (0.7 standing … 1.8 airborne). */
  spreadMult: number;
}

export interface ShotResult {
  hits: number;
  /** Tracer end points, one per pellet. */
  ends: THREE.Vector3[];
  dealt: number;
}

const clampMult = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1);

/** Full host-side trace of one shot from a remote player. Applies damage with sourceId. */
export function hostHitscan(ctx: GameContext, tracer: HitscanTracer, shooterId: string, spec: ShotSpec, drawTracers = true, muzzle?: THREE.Vector3): ShotResult {
  const w = spec.weapon;
  const dmgMult = clampMult(spec.damageMult, 0.1, 20);
  const critMult = clampMult(spec.critMult, 0.1, 20);
  const spread = Math.max(0, w.spread) * clampMult(spec.spreadMult, 0.5, 2);
  const pellets = Math.max(1, Math.round(w.pellets));
  const base = w.damage * dmgMult;
  const fwd = spec.dir.clone().normalize();
  const color = ELEMENT_COLORS[w.element] ?? ELEMENT_COLORS.none;
  const dir = new THREE.Vector3();
  tracer.prepare(ctx.enemies.list());
  const res: ShotResult = { hits: 0, ends: [], dealt: 0 };
  for (let i = 0; i < pellets; i++) {
    coneDir(ctx.rng, fwd, spread, dir);
    const hit = tracer.trace(ctx.world, spec.origin, dir, w.range);
    res.ends.push(hit.point.clone());
    if (drawTracers) ctx.fx.tracer(muzzle ?? spec.origin, hit.point, color);
    if (hit.enemy) {
      const crit = hit.enemy.isCritPoint(hit.point);
      const amount = crit ? base * w.critMultiplier * critMult : base;
      const status = w.element !== 'none' && w.elementChance > 0 && ctx.rng() < w.elementChance;
      hit.enemy.damage(amount, { point: hit.point.clone(), element: w.element, crit, sourceId: shooterId, applyStatus: status });
      res.hits++;
      res.dealt += amount;
    } else if (hit.normal && drawTracers) {
      ctx.fx.impact(hit.point, hit.normal, color);
    }
  }
  return res;
}

/** Upper bound for one claimed hit from a weapon (crit + ramp-up perk headroom). */
export function maxHitAmount(w: WeaponStats | null, damageMult: number, critMult: number, meleeMult = 1): number {
  const dm = clampMult(damageMult, 0.1, 20);
  const cm = clampMult(critMult, 0.1, 20);
  const gun = w ? w.damage * dm * Math.max(1, w.critMultiplier * cm) * 1.35 : 0;
  // dm carries skill tree × gear × sponsor/crowd; meleeMult is the gear melee bonus (≤ ×3, GEAR_CAPS)
  const melee = PLAYER.meleeDamage * dm * clampMult(meleeMult, 1, 3) * 1.1;
  return Math.max(gun, melee) + 1;
}

export interface ClaimCheck {
  /** Shooter's eye position (host view of the shooter). */
  eye: THREE.Vector3;
  /** Max weapon range (+ tolerance added inside). */
  range: number;
  maxAmount: number;
}

export interface AppliedHit {
  enemy: Enemy;
  point: THREE.Vector3;
  amount: number;
  crit: boolean;
  element: Element;
}

const _abs = new THREE.Vector3();
const _to = new THREE.Vector3();

/** How far (m) the host's view of an enemy may differ from the client's interpolated one. */
export const LAG_TOLERANCE = 4;

/**
 * Validate one client hit claim (see HitW). The line-of-sight check uses the absolute point
 * the client hit; range and body checks use the host's current view of the enemy.
 */
export function validateClaim(ctx: GameContext, claim: HitW, check: ClaimCheck): AppliedHit | null {
  const [id, rx, ry, rz, crit, amount] = claim;
  if (typeof id !== 'string' || !(amount > 0)) return null;
  const enemy = ctx.enemies.get(id);
  if (!enemy || !enemy.alive) return null;
  // Point must lie on (or near) the body in the enemy's local frame.
  const horiz = Math.hypot(rx, rz);
  if (!(horiz <= enemy.radius * 1.8 + 0.8) || !(ry >= -0.8 && ry <= enemy.height + 1)) return null;
  const point = new THREE.Vector3(enemy.position.x + rx, enemy.position.y + ry, enemy.position.z + rz);
  // Range: measured to where the host has the enemy now (with lag tolerance).
  const dist = point.distanceTo(check.eye);
  if (dist > check.range * 1.05 + LAG_TOLERANCE) return null;
  // Line of sight: from the eye to the point the client actually hit (its view).
  const target = Number.isFinite(claim[8]) ? _abs.set(claim[8], claim[9], claim[10]) : point;
  _to.copy(target).sub(check.eye);
  const len = _to.length();
  if (len > 1e-3) {
    _to.multiplyScalar(1 / len);
    const wall = ctx.world.raycast(check.eye, _to, len);
    if (wall && wall.distance < len - 0.6) return null;
  }
  return {
    enemy,
    point,
    amount: Math.min(amount, check.maxAmount),
    crit: crit === 1,
    element: dec.element(claim[6]),
  };
}

/** Validate + apply. Returns the applied hit (or null when rejected). */
export function applyClaim(ctx: GameContext, claim: HitW, check: ClaimCheck, shooterId: string): AppliedHit | null {
  const ok = validateClaim(ctx, claim, check);
  if (!ok) return null;
  ok.enemy.damage(ok.amount, {
    point: ok.point.clone(),
    element: ok.element,
    crit: ok.crit,
    sourceId: shooterId,
    applyStatus: claim[7] === 1,
  });
  return ok;
}
