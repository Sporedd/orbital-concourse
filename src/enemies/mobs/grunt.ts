/**
 * Grunt: fast melee rusher. Zig-zags when far, lunges when within 1.9 m
 * (0.35 s windup leaning back, then a claw swipe for 12 if still in range).
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { BaseEnemy, type EnemyConfig, type EnemySimState } from '../base';
import { buildGrunt } from '../models';

export interface GruntState extends EnemySimState {
  mode: 'chase' | 'windup' | 'recover';
  timer: number;
  cooldown: number;
  zig: number;
}

const CFG: EnemyConfig = {
  kind: 'grunt', isBoss: false, radius: 0.5, height: 1.85, baseHealth: 60, mass: 1,
  burstColor: 0xff2238, headRadius: 0.3, centerHeight: 1.1,
};
const SPEED = 6.5;
const RANGE = 1.9;
const WINDUP = 0.35;
const DAMAGE = 12;
const COOLDOWN = 0.9;

const _dir = new THREE.Vector3();

export class Grunt extends BaseEnemy<GruntState> {
  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    super(env, CFG, buildGrunt(env.ctx.materials), pos, tier, {
      mode: 'chase', timer: 0, cooldown: 0.4, zig: env.ctx.rng() * 10,
    });
  }

  protected think(dt: number): void {
    const s = this.state;
    s.cooldown = Math.max(0, s.cooldown - dt);
    const p = this.findTarget();
    if (!p) {
      s.mode = 'chase';
      this.brake(dt, 4);
      this.moveAndCollide(dt);
      this.setAnim('idle');
      return;
    }
    const dist = this.flatDirTo(p.position, _dir);
    const dy = Math.abs(p.position.y - this.position.y);

    switch (s.mode) {
      case 'chase': {
        if (dist < RANGE && dy < 1.6 && s.cooldown <= 0) {
          s.mode = 'windup';
          s.timer = WINDUP;
          this.setAnim('attack');
          this.emitAttack('lunge');
          break;
        }
        const fx = _dir.x;
        const fz = _dir.z;
        if (dist > 8) {
          const w = Math.sin(s.age * 3.2 + s.zig) * 0.6;
          _dir.x += -fz * w;
          _dir.z += fx * w;
          _dir.normalize();
        }
        const speed = dist < 1.3 ? 1.5 : SPEED;
        this.steer(_dir, speed, dt, 9);
        this.moveAndCollide(dt);
        if (dist < 3) this.faceDir(fx, fz, 12, dt);
        else this.faceMovement(dt, 10);
        this.setAnim('walk');
        break;
      }
      case 'windup': {
        s.timer -= dt;
        this.brake(dt, 10);
        this.moveAndCollide(dt);
        this.faceDir(_dir.x, _dir.z, 12, dt);
        if (s.timer <= 0) {
          // lunge forward and swipe
          const sm = this.speedMult();
          this.velocity.x += _dir.x * 7 * sm;
          this.velocity.z += _dir.z * 7 * sm;
          if (dist <= RANGE + 0.5 && dy < 1.6) this.attackPlayer(p, DAMAGE);
          s.mode = 'recover';
          s.timer = 0.3;
          s.cooldown = COOLDOWN;
        }
        break;
      }
      case 'recover': {
        s.timer -= dt;
        this.brake(dt, 6);
        this.moveAndCollide(dt);
        if (s.timer <= 0) s.mode = 'chase';
        break;
      }
    }
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const amp = s.alive ? Math.min(1, speed / 4) : 0;
    const sw = Math.sin(this.walkPhase) * 0.8 * amp;
    r.legs[0].rotation.x = sw;
    r.legs[1].rotation.x = -sw;
    let lean = 0.15 + 0.25 * amp;
    let armL = -sw * 0.9;
    let armR = sw * 0.9;
    let bob = Math.abs(Math.sin(this.walkPhase)) * 0.07 * amp;
    if (s.anim === 'idle') bob += Math.sin(s.age * 2.2) * 0.02;
    if (s.anim === 'attack') {
      const t = s.animTime;
      if (t < WINDUP) {
        const k = t / WINDUP;
        lean = -0.4 * k;
        armL = armR = -2.8 * k;
      } else {
        const k = Math.min(1, (t - WINDUP) / 0.1);
        const settle = Math.max(0, 1 - (t - WINDUP - 0.1) / 0.3);
        lean = 0.6 * k * settle + 0.2 * (1 - settle);
        armL = armR = -2.8 + 2.4 * k;
      }
    }
    if (!s.alive) {
      armL = armR = -1.2;
      lean = -0.2;
    }
    lean -= (s.hitTimer / 0.18) * 0.4;
    r.body.position.y = r.bodyBaseY + bob;
    r.body.rotation.x = lean;
    r.arms[0].rotation.x = armL;
    r.arms[1].rotation.x = armR;
    r.arms[0].rotation.z = -0.15;
    r.arms[1].rotation.z = 0.15;
    if (r.head) r.head.rotation.x = -lean * 0.6;
  }
}
