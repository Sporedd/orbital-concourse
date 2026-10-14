/**
 * Enemy projectiles: spitter globs (straight), summoner orbs (gentle homing) and artillery
 * mortar shells (ballistic arc onto a telegraphed ground marker). Pooled meshes, plain state.
 */
import * as THREE from 'three';
import type { GameContext, PlayerState } from '@/core/types';
import { hurtPlayersInRadius, noRaycast, playerCapsuleDistance, shakeFrom } from './common';
import { DISC_GEO, RING_GEO, SPHERE_GEO } from './models';

type ShotKind = 'spit' | 'orb';

interface Shot {
  id: string;
  kind: ShotKind;
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  life: number;
  damage: number;
  radius: number;
  color: number;
  sourceId: string;
  targetId: string | null;
  mesh: THREE.Mesh;
}

interface Shell {
  id: string;
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  duration: number;
  apex: number;
  damage: number;
  radius: number;
  sourceId: string;
  shell: THREE.Mesh;
  ring: THREE.Mesh;
  disc: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  discMat: THREE.MeshBasicMaterial;
}

const SPIT_COLOR = 0xff2238; // THREAT
const ORB_COLOR = 0xff2238;
const SHELL_COLOR = 0xff2238;

const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _want = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class ProjectileSystem {
  private readonly shots: Shot[] = [];
  private readonly shells: Shell[] = [];
  private spitMat: THREE.Material | null = null;
  private orbMat: THREE.Material | null = null;
  private shellMat: THREE.Material | null = null;

  constructor(private readonly ctx: GameContext) {}

  /** Straight glob; `velocity` already includes the speed. */
  spit(origin: THREE.Vector3, velocity: THREE.Vector3, damage: number, sourceId: string): void {
    if (!this.spitMat) this.spitMat = this.ctx.materials.glow(SPIT_COLOR, 2.6);
    const s = this.allocShot('spit', this.spitMat, 0.22);
    s.position.copy(origin);
    s.velocity.copy(velocity);
    s.speed = velocity.length();
    s.life = 3;
    s.damage = damage;
    s.color = SPIT_COLOR;
    s.sourceId = sourceId;
    s.targetId = null;
    s.mesh.position.copy(origin);
  }

  /** Homing orb (speed 12, gentle turn). */
  orb(origin: THREE.Vector3, dir: THREE.Vector3, damage: number, sourceId: string, targetId: string | null): void {
    if (!this.orbMat) this.orbMat = this.ctx.materials.glow(ORB_COLOR, 2.8);
    const s = this.allocShot('orb', this.orbMat, 0.38);
    s.position.copy(origin);
    s.speed = 12;
    s.velocity.copy(dir).normalize().multiplyScalar(s.speed);
    s.life = 5;
    s.damage = damage;
    s.color = ORB_COLOR;
    s.sourceId = sourceId;
    s.targetId = targetId;
    s.mesh.position.copy(origin);
  }

  /** Mortar shell from `origin` landing on `target` (ground) after `flight` seconds. */
  mortar(origin: THREE.Vector3, target: THREE.Vector3, damage: number, radius: number, sourceId: string, flight = 1.2): void {
    const sh = this.allocShell();
    sh.from.copy(origin);
    sh.to.copy(target);
    sh.t = 0;
    sh.duration = flight;
    sh.apex = 8 + origin.distanceTo(target) * 0.25;
    sh.damage = damage;
    sh.radius = radius;
    sh.sourceId = sourceId;
    sh.shell.visible = true;
    sh.shell.position.copy(origin);
    sh.ring.visible = true;
    sh.disc.visible = true;
    sh.ring.position.set(target.x, target.y + 0.06, target.z);
    sh.disc.position.set(target.x, target.y + 0.05, target.z);
    sh.ring.scale.setScalar(radius);
    sh.disc.scale.setScalar(0.01);
  }

  update(dt: number): void {
    for (const s of this.shots) if (s.active) this.updateShot(s, dt);
    for (const sh of this.shells) if (sh.active) this.updateShell(sh, dt);
  }

  clear(): void {
    for (const s of this.shots) {
      s.active = false;
      s.mesh.visible = false;
    }
    for (const sh of this.shells) {
      sh.active = false;
      sh.shell.visible = false;
      sh.ring.visible = false;
      sh.disc.visible = false;
    }
  }

  // ---- internals -----------------------------------------------------------------
  private allocShot(kind: ShotKind, mat: THREE.Material, radius: number): Shot {
    let s = this.shots.find((x) => !x.active && x.kind === kind);
    if (!s) {
      const mesh = new THREE.Mesh(SPHERE_GEO(), mat);
      mesh.raycast = noRaycast;
      mesh.scale.setScalar(radius);
      this.ctx.scene.add(mesh);
      s = {
        id: '', kind, active: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), speed: 0,
        life: 0, damage: 0, radius, color: 0, sourceId: '', targetId: null, mesh,
      };
      this.shots.push(s);
    }
    s.id = this.ctx.nextId('proj');
    s.active = true;
    s.mesh.visible = true;
    return s;
  }

  private allocShell(): Shell {
    let sh = this.shells.find((x) => !x.active);
    if (!sh) {
      if (!this.shellMat) this.shellMat = this.ctx.materials.glow(SHELL_COLOR, 3);
      const shell = new THREE.Mesh(SPHERE_GEO(), this.shellMat);
      shell.scale.setScalar(0.3);
      const ringMat = this.ctx.materials.glow(SHELL_COLOR, 2.2);
      ringMat.transparent = true;
      ringMat.depthWrite = false;
      ringMat.side = THREE.DoubleSide;
      const discMat = this.ctx.materials.glow(SHELL_COLOR, 1.4);
      discMat.transparent = true;
      discMat.depthWrite = false;
      discMat.opacity = 0.3;
      discMat.side = THREE.DoubleSide;
      const ring = new THREE.Mesh(RING_GEO(), ringMat);
      const disc = new THREE.Mesh(DISC_GEO(), discMat);
      ring.rotation.x = -Math.PI / 2;
      disc.rotation.x = -Math.PI / 2;
      ring.renderOrder = 2;
      disc.renderOrder = 1;
      for (const m of [shell, ring, disc]) {
        m.raycast = noRaycast;
        m.visible = false;
        this.ctx.scene.add(m);
      }
      sh = {
        id: '', active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, duration: 1.2, apex: 8,
        damage: 0, radius: 3.5, sourceId: '', shell, ring, disc, ringMat, discMat,
      };
      this.shells.push(sh);
    }
    sh.id = this.ctx.nextId('shell');
    sh.active = true;
    return sh;
  }

  private killShot(s: Shot): void {
    s.active = false;
    s.mesh.visible = false;
  }

  private updateShot(s: Shot, dt: number): void {
    const ctx = this.ctx;
    s.life -= dt;
    if (s.kind === 'orb') {
      const target: PlayerState | undefined =
        (s.targetId ? ctx.players.get(s.targetId) : undefined) ?? ctx.players.nearest(s.position);
      if (target && target.alive) {
        _want.set(target.position.x, target.position.y + 1.1, target.position.z).sub(s.position).normalize();
        _dir.copy(s.velocity).normalize();
        _dir.lerp(_want, Math.min(1, 1.6 * dt)).normalize();
        s.velocity.copy(_dir).multiplyScalar(s.speed);
      }
      const pulse = 1 + 0.15 * Math.sin(s.life * 18);
      s.mesh.scale.setScalar(s.radius * pulse);
    }
    const step = s.speed * dt;
    _dir.copy(s.velocity).normalize();

    // players: sample along the step
    let hitPlayer: PlayerState | null = null;
    let hitT = 2;
    for (const p of ctx.players.list()) {
      if (!p.alive) continue;
      for (let k = 1; k <= 3; k++) {
        const t = k / 3;
        _probe.copy(s.position).addScaledVector(s.velocity, dt * t);
        if (playerCapsuleDistance(p, _probe) < s.radius) {
          if (t < hitT) {
            hitT = t;
            hitPlayer = p;
          }
          break;
        }
      }
    }
    const hit = ctx.world.raycast(s.position, _dir, step + s.radius * 0.5);
    if (hitPlayer && (!hit || hit.distance >= step * hitT - 0.05)) {
      const at = s.position.clone().addScaledVector(s.velocity, dt * hitT);
      hitPlayer.takeDamage(s.damage, { element: 'none', sourceId: s.sourceId, point: at.clone() });
      ctx.fx.burst(at, s.color, 10);
      this.killShot(s);
      return;
    }
    if (hit) {
      ctx.fx.impact(hit.point.clone(), hit.normal.clone(), s.color);
      this.killShot(s);
      return;
    }
    s.position.addScaledVector(s.velocity, dt);
    const g = ctx.world.groundHeight(s.position.x, s.position.z);
    if (s.position.y < g) {
      s.position.y = g;
      ctx.fx.impact(s.position.clone(), UP.clone(), s.color);
      this.killShot(s);
      return;
    }
    if (s.life <= 0) {
      ctx.fx.burst(s.position.clone(), s.color, 6);
      this.killShot(s);
      return;
    }
    s.mesh.position.copy(s.position);
  }

  private updateShell(sh: Shell, dt: number): void {
    const ctx = this.ctx;
    sh.t += dt;
    const u = Math.min(1, sh.t / sh.duration);
    sh.shell.position.lerpVectors(sh.from, sh.to, u);
    sh.shell.position.y += sh.apex * 4 * u * (1 - u);
    sh.ringMat.opacity = 0.55 + 0.4 * Math.sin(sh.t * 22);
    sh.disc.scale.setScalar(Math.max(0.01, sh.radius * u));
    if (u < 1) return;

    sh.active = false;
    sh.shell.visible = false;
    sh.ring.visible = false;
    sh.disc.visible = false;
    const c = sh.to.clone();
    c.y += 0.2;
    ctx.fx.explosion(c, sh.radius, SHELL_COLOR);
    ctx.audio.play('explosion', { position: c.clone(), volume: 0.55 });
    shakeFrom(ctx, c, 0.45, sh.radius * 4);
    hurtPlayersInRadius(ctx, c, sh.radius, sh.damage, sh.sourceId, 'none');
  }
}

