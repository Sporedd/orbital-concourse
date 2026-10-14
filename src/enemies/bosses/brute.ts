/**
 * Hullbreaker the Brute. Slow walker with two attacks:
 * - Charge: 0.8 s roar telegraph, then an 18 m/s straight rush for up to 2 s, 30 contact
 *   damage (once per player per charge). Hitting a wall stuns it for 1.5 s: crits anywhere.
 * - Ground slam when the target is within 4 m: windup, radius 6, 25 damage with falloff.
 * Phase 1+: a charge that ends without hitting a wall chains into a quick slam.
 * Phase 2: every slam is followed by a wider aftershock.
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { hurtPlayersInRadius, playerCapsuleDistance, shakeFrom } from '../common';
import type { EnemyConfig, EnemySimState } from '../base';
import { buildBrute } from '../models';
import { BossBase } from './boss';
import type { Vec3 } from '@/core/types';

type BruteMode = 'walk' | 'telegraph' | 'charge' | 'stunned' | 'recover' | 'slamWindup' | 'slamRecover';

export interface BruteState extends EnemySimState {
  mode: BruteMode;
  timer: number;
  windup: number;
  chargeCd: number;
  slamCd: number;
  chargeDir: Vec3;
  chargeHits: string[];
  aftershock: number;
}

const CFG: EnemyConfig = {
  kind: 'brute', isBoss: true, radius: 1.4, height: 3.7, baseHealth: 1400, mass: 8,
  burstColor: 0xff2238, centerHeight: 2.3,
};
const WALK = 4;
const CHARGE_SPEED = 18;
const CHARGE_TIME = 2;
const CHARGE_DAMAGE = 30;
const STUN = 1.5;
const SLAM_RANGE = 4;
const SLAM_RADIUS = 6;
const SLAM_DAMAGE = 25;
const SLAM_COLOR = 0xff2238;

const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _probeO = new THREE.Vector3();
const _chest = new THREE.Vector3();

export class Brute extends BossBase<BruteState> {
  readonly bossName = 'Hullbreaker the Brute';

  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    super(env, CFG, buildBrute(env.ctx.materials), pos, tier, {
      mode: 'walk', timer: 0, windup: 0.6, chargeCd: 3, slamCd: 1, chargeDir: { x: 0, y: 0, z: 1 },
      chargeHits: [], aftershock: -1,
    }, 0.65);
    this.stride = 1.1;
  }

  protected critAnywhere(): boolean {
    return this.state.mode === 'stunned';
  }

  protected think(dt: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    s.chargeCd -= dt;
    s.slamCd -= dt;
    const p = this.findTarget();
    const dist = p ? this.flatDirTo(p.position, _dir) : 99;

    switch (s.mode) {
      case 'walk': {
        if (!p) {
          this.brake(dt, 4);
          this.moveAndCollide(dt);
          this.setAnim('idle');
          break;
        }
        if (dist <= SLAM_RANGE && s.slamCd <= 0) {
          this.startSlam(this.byPhase([0.6, 0.5, 0.42]));
        } else if (dist > 7 && dist < 45 && s.chargeCd <= 0 && this.hasLineOfSight(p, 1.5)) {
          s.mode = 'telegraph';
          s.timer = this.byPhase([0.8, 0.8, 0.65]);
          this.setAnim('roar');
          ctx.audio.play('boss_roar', { position: this.position.clone() });
          shakeFrom(ctx, this.position, 0.3, 30);
          this.emitAttack('charge');
        } else {
          this.steer(_dir, WALK, dt, 4);
          this.moveAndCollide(dt);
          this.faceMovement(dt, 3);
          this.setAnim('walk');
        }
        break;
      }
      case 'telegraph': {
        this.brake(dt, 10);
        this.moveAndCollide(dt);
        if (p) this.faceDir(_dir.x, _dir.z, 5, dt);
        s.timer -= dt;
        if (s.timer <= 0) {
          s.chargeDir.x = Math.sin(s.yaw);
          s.chargeDir.z = Math.cos(s.yaw);
          if (p) {
            s.chargeDir.x = _dir.x;
            s.chargeDir.z = _dir.z;
          }
          s.mode = 'charge';
          s.timer = CHARGE_TIME;
          s.chargeHits.length = 0;
          this.setAnim('charge');
          shakeFrom(ctx, this.position, 0.35, 25);
        }
        break;
      }
      case 'charge': {
        const sm = this.speedMult();
        this.velocity.set(s.chargeDir.x * CHARGE_SPEED * sm, 0, s.chargeDir.z * CHARGE_SPEED * sm);
        this.faceDir(s.chargeDir.x, s.chargeDir.z, 20, dt);
        const ratio = this.moveAndCollide(dt);
        this.chargeContact();
        // wall probe straight ahead
        _probeO.set(this.position.x, this.position.y + 1.0, this.position.z);
        _probe.set(s.chargeDir.x, 0, s.chargeDir.z);
        const hit = ctx.world.raycast(_probeO, _probe, this.radius + 0.5);
        if ((hit && Math.abs(hit.normal.y) < 0.7) || (ratio < 0.45 && sm > 0.2)) {
          this.wallStun();
          break;
        }
        s.timer -= dt;
        if (s.timer <= 0) {
          s.chargeCd = this.byPhase([7, 5.5, 4]);
          if (s.phase >= 1) this.startSlam(0.35);
          else {
            s.mode = 'recover';
            s.timer = 0.5;
            this.setAnim('idle');
          }
        }
        break;
      }
      case 'stunned': {
        this.brake(dt, 10);
        this.moveAndCollide(dt);
        s.timer -= dt;
        if (s.timer <= 0) {
          s.mode = 'recover';
          s.timer = 0.4;
          this.setAnim('idle');
        }
        break;
      }
      case 'recover': {
        this.brake(dt, 8);
        this.moveAndCollide(dt);
        s.timer -= dt;
        if (s.timer <= 0) s.mode = 'walk';
        break;
      }
      case 'slamWindup': {
        this.brake(dt, 10);
        this.moveAndCollide(dt);
        if (p) this.faceDir(_dir.x, _dir.z, 4, dt);
        s.timer -= dt;
        if (s.timer <= 0) {
          this.doSlam(SLAM_RADIUS, SLAM_DAMAGE, 0.8);
          s.aftershock = s.phase >= 2 ? 0.45 : -1;
          s.mode = 'slamRecover';
          s.timer = 0.65;
          s.slamCd = this.byPhase([2.5, 2.0, 1.5]);
        }
        break;
      }
      case 'slamRecover': {
        this.brake(dt, 10);
        this.moveAndCollide(dt);
        if (s.aftershock > 0) {
          s.aftershock -= dt;
          if (s.aftershock <= 0) this.doSlam(SLAM_RADIUS + 2, SLAM_DAMAGE * 0.7, 0.5);
        }
        s.timer -= dt;
        if (s.timer <= 0 && s.aftershock <= 0) s.mode = 'walk';
        break;
      }
    }
  }

  private startSlam(windup: number): void {
    const s = this.state;
    s.mode = 'slamWindup';
    s.timer = windup;
    s.windup = windup;
    this.setAnim('slam');
    this.emitAttack('slam');
  }

  private doSlam(radius: number, damage: number, shake: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    const c = new THREE.Vector3(
      this.position.x + Math.sin(s.yaw) * 1.6,
      this.position.y + 0.3,
      this.position.z + Math.cos(s.yaw) * 1.6,
    );
    ctx.fx.explosion(c.clone(), radius, SLAM_COLOR);
    ctx.fx.burst(c.clone(), 0x8e8c86, 24);
    ctx.audio.play('explosion', { position: c.clone(), volume: 0.9, pitch: 0.7 });
    shakeFrom(ctx, c, shake, radius * 4);
    hurtPlayersInRadius(ctx, c, radius, damage * s.damageMult, this.id, 'none');
  }

  private chargeContact(): void {
    const s = this.state;
    this.centerPoint(_chest);
    _chest.y = this.position.y + 1.2;
    for (const p of this.env.ctx.players.list()) {
      if (!p.alive || s.chargeHits.includes(p.id)) continue;
      if (playerCapsuleDistance(p, _chest) < this.radius + 0.3) {
        s.chargeHits.push(p.id);
        this.attackPlayer(p, CHARGE_DAMAGE);
        this.env.ctx.fx.shake(0.6);
      }
    }
  }

  private wallStun(): void {
    const s = this.state;
    const ctx = this.env.ctx;
    s.mode = 'stunned';
    s.timer = STUN;
    s.chargeCd = this.byPhase([7, 5.5, 4]);
    this.velocity.set(0, 0, 0);
    this.setAnim('stunned');
    const front = new THREE.Vector3(
      this.position.x + s.chargeDir.x * this.radius,
      this.position.y + 2,
      this.position.z + s.chargeDir.z * this.radius,
    );
    ctx.fx.burst(front, 0x8e8c86, 28);
    ctx.audio.play('explosion', { position: front.clone(), volume: 0.6, pitch: 0.6 });
    shakeFrom(ctx, front, 0.7, 30);
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const amp = s.alive ? Math.min(1, speed / 3) : 0;
    const sw = Math.sin(this.walkPhase) * 0.55 * amp;
    r.legs[0].rotation.x = sw;
    r.legs[1].rotation.x = -sw;
    let lean = 0.1 + 0.1 * amp;
    let armXL = -sw * 0.7;
    let armXR = sw * 0.7;
    let armZ = 0.12;
    let headX = 0;
    let headZ = 0;
    let bob = Math.abs(Math.sin(this.walkPhase)) * 0.12 * amp;
    const t = s.animTime;
    switch (s.anim) {
      case 'roar': {
        const k = Math.min(1, t / 0.25);
        lean = -0.3 * k;
        armZ = 0.12 + 1.1 * k;
        armXL = armXR = -0.6 * k;
        headX = -0.45 * k + Math.sin(t * 40) * 0.04;
        bob = Math.abs(Math.sin(t * 9)) * 0.15; // stomping
        break;
      }
      case 'charge': {
        lean = 0.6;
        armXL = armXR = 0.8;
        armZ = 0.3;
        headX = -0.4;
        const run = Math.sin(s.age * 16);
        r.legs[0].rotation.x = run * 0.9;
        r.legs[1].rotation.x = -run * 0.9;
        bob = Math.abs(run) * 0.2;
        break;
      }
      case 'stunned': {
        lean = 0.45;
        armXL = armXR = 0.2;
        armZ = 0.05;
        headX = 0.4;
        headZ = Math.sin(t * 6) * 0.3;
        break;
      }
      case 'slam': {
        const w = Math.max(0.01, s.windup);
        if (t < w) {
          const k = t / w;
          lean = -0.35 * k;
          armXL = armXR = -2.9 * k;
          armZ = 0.12 - 0.05 * k;
        } else {
          const k = Math.min(1, (t - w) / 0.08);
          const settle = Math.max(0, 1 - (t - w - 0.25) / 0.4);
          lean = 0.55 * k * settle + 0.1;
          armXL = armXR = -2.9 + 3.3 * k;
          if (settle < 1) armXL = armXR = 0.4 * settle;
        }
        break;
      }
      default:
        bob += Math.sin(s.age * 1.8) * 0.03;
    }
    if (!s.alive) {
      armXL = armXR = -0.6;
      armZ = 0.8;
    }
    lean -= (s.hitTimer / 0.18) * 0.12;
    r.body.position.y = r.bodyBaseY + bob;
    r.body.rotation.x = lean;
    r.arms[0].rotation.set(armXL, 0, -armZ);
    r.arms[1].rotation.set(armXR, 0, armZ);
    if (r.head) r.head.rotation.set(headX - lean * 0.5, 0, headZ);
  }
}
