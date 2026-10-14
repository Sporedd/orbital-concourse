/**
 * Ironhowl the Artillery. Heavy four-legged walker that keeps 15+ m away.
 * - Mortar barrage every 5 / 4 / 3 s by phase: 5 / 6 / 8 shells at the target with
 *   scatter radius 4; each shell telegraphs a glowing ground ring for 1.2 s, then blasts
 *   radius 3.5 for 20 (falloff).
 * - Stomp if a player gets within 5 m (punishes hugging it).
 * - Armour: anything but the weak point takes half damage. The weak point is the large
 *   glowing core on its back; it only occasionally turns to face its target, so flank it.
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { hurtPlayersInRadius, shakeFrom } from '../common';
import type { EnemyConfig, EnemySimState } from '../base';
import { buildArtillery } from '../models';
import { BossBase } from './boss';

type ArtilleryMode = 'walk' | 'aim' | 'barrage' | 'stomp';

export interface ArtilleryState extends EnemySimState {
  mode: ArtilleryMode;
  timer: number;
  barrageTimer: number;
  shellsLeft: number;
  shellTimer: number;
  turnTimer: number;
  turning: number;
  stompCd: number;
  strafeDir: number;
  strafeTimer: number;
  recoil: number;
}

const CFG: EnemyConfig = {
  kind: 'artillery', isBoss: true, radius: 2.35, height: 4.95, baseHealth: 1600, mass: 10,
  burstColor: 0xff2238, centerHeight: 3.0,
};
const SHELL_RADIUS = 3.5;
const SHELL_DAMAGE = 20;
const SCATTER = 4;
const AIM_TIME = 0.6;
const STOMP_RANGE = 5;
const STOMP_RADIUS = 5;
const STOMP_DAMAGE = 15;

const _dir = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _target = new THREE.Vector3();

export class Artillery extends BossBase<ArtilleryState> {
  readonly bossName = 'Ironhowl the Artillery';

  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    const rng = env.ctx.rng;
    super(env, CFG, buildArtillery(env.ctx.materials), pos, tier, {
      mode: 'walk', timer: 0, barrageTimer: 3, shellsLeft: 0, shellTimer: 0, turnTimer: 3 + rng() * 2,
      turning: 0, stompCd: 2, strafeDir: rng() < 0.5 ? -1 : 1, strafeTimer: 4, recoil: 0,
    }, 1.17);
    this.stride = 0.9;
  }

  /** Armour: half damage unless the hit lands on the weak point (or it is frozen). */
  protected modifyIncoming(amount: number, point: THREE.Vector3 | undefined): number {
    if (point && this.isCritPoint(point)) return amount;
    return amount * 0.5;
  }

  protected think(dt: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    s.barrageTimer -= dt;
    s.stompCd -= dt;
    s.turnTimer -= dt;
    s.recoil = Math.max(0, s.recoil - dt * 4);
    const p = this.findTarget();
    if (!p) {
      this.brake(dt, 3);
      this.moveAndCollide(dt);
      this.setAnim('idle');
      s.mode = 'walk';
      return;
    }
    const dist = this.flatDirTo(p.position, _dir);

    // facing: only occasionally swings round to face the target
    if (s.turning > 0) {
      s.turning -= dt;
      this.faceDir(_dir.x, _dir.z, this.byPhase([0.9, 1.1, 1.3]), dt);
    } else if (s.turnTimer <= 0) {
      s.turning = 1.8;
      s.turnTimer = 4 + ctx.rng() * 3;
    }

    switch (s.mode) {
      case 'walk': {
        s.strafeTimer -= dt;
        if (s.strafeTimer <= 0) {
          s.strafeTimer = 3 + ctx.rng() * 3;
          s.strafeDir = -s.strafeDir;
        }
        let radial = 0;
        if (dist < 15) radial = -1;
        else if (dist > 24) radial = 0.7;
        _mv.set(_dir.x * radial - _dir.z * s.strafeDir * 0.5, 0, _dir.z * radial + _dir.x * s.strafeDir * 0.5);
        const ml = Math.hypot(_mv.x, _mv.z);
        if (ml > 1) _mv.multiplyScalar(1 / ml);
        this.steer(_mv, this.byPhase([2.5, 2.5, 3.2]), dt, 2);
        if (this.moveAndCollide(dt) < 0.3) s.strafeDir = -s.strafeDir;
        this.setAnim(Math.hypot(this.velocity.x, this.velocity.z) > 0.4 ? 'walk' : 'idle');

        if (dist < STOMP_RANGE && s.stompCd <= 0) {
          s.mode = 'stomp';
          s.timer = 0.9;
          this.setAnim('stomp');
          this.emitAttack('stomp');
        } else if (s.barrageTimer <= 0) {
          s.mode = 'aim';
          s.timer = AIM_TIME;
          this.setAnim('aim');
          ctx.audio.play('boss_roar', { position: this.position.clone(), pitch: 1.4, volume: 0.6 });
          this.emitAttack('barrage');
        }
        break;
      }
      case 'aim': {
        this.brake(dt, 6);
        this.moveAndCollide(dt);
        s.timer -= dt;
        if (s.timer <= 0) {
          s.mode = 'barrage';
          s.shellsLeft = this.byPhase([5, 6, 8]);
          s.shellTimer = 0;
          this.setAnim('fire');
        }
        break;
      }
      case 'barrage': {
        this.brake(dt, 6);
        this.moveAndCollide(dt);
        s.shellTimer -= dt;
        if (s.shellTimer <= 0 && s.shellsLeft > 0) {
          this.fireShell(p.position, s.shellsLeft === this.byPhase([5, 6, 8]));
          s.shellsLeft--;
          s.shellTimer = 0.12;
        }
        if (s.shellsLeft <= 0 && s.shellTimer <= 0) {
          s.mode = 'walk';
          s.barrageTimer = this.byPhase([5, 4, 3]);
        }
        break;
      }
      case 'stomp': {
        this.brake(dt, 8);
        this.moveAndCollide(dt);
        s.timer -= dt;
        if (s.timer <= 0) {
          const c = this.position.clone();
          c.y += 0.2;
          ctx.fx.explosion(c.clone(), STOMP_RADIUS, 0xff2238);
          ctx.fx.burst(c.clone(), 0x8e8c86, 20);
          ctx.audio.play('explosion', { position: c.clone(), volume: 0.8, pitch: 0.6 });
          shakeFrom(ctx, c, 0.6, 20);
          hurtPlayersInRadius(ctx, c, STOMP_RADIUS, STOMP_DAMAGE * s.damageMult, this.id, 'none');
          s.stompCd = 4;
          s.mode = 'walk';
        }
        break;
      }
    }
  }

  private fireShell(target: THREE.Vector3, first: boolean): void {
    const s = this.state;
    const ctx = this.env.ctx;
    const scatter = first ? 1.5 : SCATTER;
    const a = ctx.rng() * Math.PI * 2;
    const r = Math.sqrt(ctx.rng()) * scatter;
    _target.set(target.x + Math.sin(a) * r, 0, target.z + Math.cos(a) * r);
    _target.y = ctx.world.groundHeight(_target.x, _target.z);
    this.rig.parts.muzzle.getWorldPosition(_muzzle);
    this.env.projectiles.mortar(_muzzle, _target, SHELL_DAMAGE * s.damageMult, SHELL_RADIUS, this.id, 1.2);
    ctx.fx.burst(_muzzle.clone(), 0xff2238, 8);
    s.recoil = 1;
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const amp = s.alive ? Math.min(1, speed / 1.5) : 0;
    const a = Math.sin(this.walkPhase) * 0.35 * amp;
    // legs FL, FR, BL, BR → diagonal pairs 0/3 and 1/2
    r.legs[0].rotation.x = a;
    r.legs[3].rotation.x = a;
    r.legs[1].rotation.x = -a;
    r.legs[2].rotation.x = -a;
    let y = r.bodyBaseY + Math.abs(Math.cos(this.walkPhase)) * 0.08 * amp + Math.sin(s.age * 1.4) * 0.03;
    let pitch = 0;
    let mortar = 0.35;
    const t = s.animTime;
    if (s.anim === 'aim') {
      const k = Math.min(1, t / AIM_TIME);
      y -= 0.3 * k;
      mortar = 0.35 - 0.3 * k;
      pitch = -0.08 * k;
    } else if (s.anim === 'fire') {
      y -= 0.3;
      mortar = 0.05;
      pitch = -0.08 + s.recoil * 0.05;
    } else if (s.anim === 'stomp') {
      const k = t < 0.7 ? t / 0.7 : Math.max(0, 1 - (t - 0.7) / 0.15);
      y += 0.5 * k;
      pitch = -0.15 * k;
      r.legs[0].rotation.x = -0.5 * k;
      r.legs[1].rotation.x = -0.5 * k;
    }
    pitch -= (s.hitTimer / 0.18) * 0.04;
    r.body.position.y = y;
    r.body.rotation.x = pitch;
    r.parts.mortar.rotation.x = mortar;
    r.parts.mortar.scale.y = 1 - s.recoil * 0.15;
    r.parts.weak.scale.setScalar(1 + 0.08 * Math.sin(s.age * 5));
  }
}
