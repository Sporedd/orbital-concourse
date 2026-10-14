/**
 * Thrown grenades: arcing projectile that bounces off ground and walls, explodes after a fuse.
 */
import * as THREE from 'three';
import { PLAYER } from '@/core/config';
import type { GameContext } from '@/core/types';
import { getStats, runDamageMult, skillExtras } from './shared';

export const GRENADE_SPEED = 16;
export const GRENADE_UP_SPEED = 3;
const FUSE = 2.2;
const RADIUS = 0.13;
const RESTITUTION = 0.4;
const SELF_DAMAGE_FACTOR = 0.4;
const SUBSTEPS = 2;
const EXPLOSION_COLOR = 0xffa040;

interface Grenade {
  mesh: THREE.Group;
  spark: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fuse: number;
}

export interface GrenadeHost {
  readonly id: string;
  readonly position: THREE.Vector3; // feet
  readonly alive: boolean;
  takeDamage(amount: number, opts: { point: THREE.Vector3 }): void;
}

export class GrenadeSystem {
  private readonly list: Grenade[] = [];
  private readonly bodyGeo = new THREE.SphereGeometry(RADIUS, 12, 10);
  private readonly capGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.06, 8);
  private readonly sparkGeo = new THREE.SphereGeometry(0.045, 8, 6);
  private readonly bodyMat: THREE.Material;
  private readonly capMat: THREE.Material;
  private readonly sparkMat: THREE.Material;
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly ctx: GameContext, private readonly host: GrenadeHost) {
    this.bodyMat = ctx.materials.toon({ color: 0x4d5e3a });
    this.capMat = ctx.materials.toon({ color: 0x2a2e38 });
    this.sparkMat = ctx.materials.glow(EXPLOSION_COLOR, 2.5);
  }

  throw(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    body.castShadow = true;
    const cap = new THREE.Mesh(this.capGeo, this.capMat);
    cap.position.y = RADIUS + 0.01;
    const spark = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    spark.position.y = RADIUS + 0.06;
    mesh.add(body, cap, spark);
    mesh.position.copy(origin);
    this.ctx.scene.add(mesh);
    this.list.push({ mesh, spark, pos: origin.clone(), vel: velocity.clone(), fuse: FUSE });
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      const h = dt / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) this.step(g, h);
      g.mesh.position.copy(g.pos);
      const hs = Math.hypot(g.vel.x, g.vel.z);
      g.mesh.rotation.x -= hs * dt * 4;
      g.mesh.rotation.z += g.vel.x * dt * 2;

      g.fuse -= dt;
      const elapsed = FUSE - g.fuse;
      const freq = 8 + elapsed * elapsed * 10;
      g.spark.scale.setScalar(1 + 0.6 * Math.max(0, Math.sin(elapsed * freq)));

      if (g.fuse <= 0) {
        this.explode(g);
        this.remove(i);
      }
    }
  }

  private step(g: Grenade, h: number): void {
    const world = this.ctx.world;
    g.vel.y += PLAYER.gravity * h;
    const speed = g.vel.length();
    const dist = speed * h;
    if (dist > 1e-6) {
      this.dir.copy(g.vel).divideScalar(speed);
      const hit = world.raycast(g.pos, this.dir, dist + RADIUS);
      if (hit) {
        g.pos.copy(hit.point).addScaledVector(hit.normal, RADIUS + 0.01);
        const vn = g.vel.dot(hit.normal);
        if (vn < 0) g.vel.addScaledVector(hit.normal, -(1 + RESTITUTION) * vn);
        g.vel.multiplyScalar(0.85);
        // settle on floors instead of micro-bouncing
        if (hit.normal.y > 0.6 && Math.abs(g.vel.dot(hit.normal)) < 1.2) {
          const vn2 = g.vel.dot(hit.normal);
          g.vel.addScaledVector(hit.normal, -vn2);
        }
      } else {
        g.pos.addScaledVector(g.vel, h);
      }
    }

    const gh = world.groundHeight(g.pos.x, g.pos.z);
    if (g.pos.y - RADIUS < gh) {
      g.pos.y = gh + RADIUS;
      if (g.vel.y < 0) g.vel.y = -g.vel.y * RESTITUTION;
      g.vel.x *= 0.75;
      g.vel.z *= 0.75;
      if (Math.abs(g.vel.y) < 1.2) g.vel.y = 0;
    }
    // rolling friction when touching the ground
    if (g.pos.y - RADIUS - gh < 0.03) {
      const k = Math.exp(-2.5 * h);
      g.vel.x *= k;
      g.vel.z *= k;
    }
  }

  private explode(g: Grenade): void {
    const ctx = this.ctx;
    const pos = g.pos;
    // skill extras: Bigger Payload / Ordnance Bay (damage), Wide Spread (radius)
    const x = skillExtras(ctx);
    const R = PLAYER.grenadeRadius * Math.max(0.1, x.grenadeRadiusMult);
    const stats = getStats(ctx);
    ctx.enemies?.damageRadius(pos, R, PLAYER.grenadeDamage * stats.damageMult * x.grenadeDamageMult * runDamageMult(ctx), {
      sourceId: this.host.id,
      point: pos.clone(),
      element: 'none',
      cause: 'grenade',
    });
    ctx.fx.explosion(pos.clone(), R, EXPLOSION_COLOR);
    ctx.fx.shake(0.6);
    ctx.audio.play('explosion', { position: pos.clone() });

    // self damage (no skill multiplier), linear falloff from the centre of the body
    if (this.host.alive) {
      const body = this.tmp.copy(this.host.position);
      body.y += PLAYER.height * 0.5;
      const d = body.distanceTo(pos);
      if (d < R) {
        const falloff = 1 - (d / R) * 0.7;
        this.host.takeDamage(PLAYER.grenadeDamage * SELF_DAMAGE_FACTOR * falloff, { point: pos.clone() });
      }
    }
  }

  private remove(i: number): void {
    const g = this.list[i];
    g.mesh.removeFromParent();
    this.list.splice(i, 1);
  }

  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
  }
}
