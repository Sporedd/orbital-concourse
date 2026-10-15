/**
 * Spitter: ranged. Keeps 10–14 m from its target, strafes sideways, and every 1.4 s
 * spits a glowing glob (speed 22, slight lead) for 10.
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { BaseEnemy, type EnemyConfig, type EnemySimState } from '../base';
import { buildSpitter } from '../models';
import { poseRun } from '../pose';

export interface SpitterState extends EnemySimState {
  mode: 'move' | 'charge';
  timer: number;
  fireTimer: number;
  strafeDir: number;
  strafeTimer: number;
}

const CFG: EnemyConfig = {
  kind: 'spitter', isBoss: false, radius: 0.6, height: 1.9, baseHealth: 45, mass: 1,
  burstColor: 0xff2238, headRadius: 0.24, centerHeight: 1.1,
};
const SPEED = 5.5;
const NEAR = 10;
const FAR = 14;
const INTERVAL = 1.4;
const CHARGE = 0.3;
const SHOT_SPEED = 22;
const DAMAGE = 10;

const _dir = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _aim = new THREE.Vector3();

export class Spitter extends BaseEnemy<SpitterState> {
  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    super(env, CFG, buildSpitter(env.ctx.materials), pos, tier, {
      mode: 'move', timer: 0, fireTimer: 0.8 + env.ctx.rng() * 0.8,
      strafeDir: env.ctx.rng() < 0.5 ? -1 : 1, strafeTimer: 1 + env.ctx.rng() * 2,
    });
    this.stride = 2.2;
  }

  protected think(dt: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    const p = this.findTarget();
    if (!p) {
      this.brake(dt, 4);
      this.moveAndCollide(dt);
      this.setAnim('idle');
      s.mode = 'move';
      return;
    }
    const dist = this.flatDirTo(p.position, _dir);

    s.strafeTimer -= dt;
    if (s.strafeTimer <= 0) {
      s.strafeTimer = 1.5 + ctx.rng() * 1.5;
      s.strafeDir = ctx.rng() < 0.5 ? -1 : 1;
    }
    let radial = 0;
    if (dist < NEAR) radial = -Math.min(1, (NEAR - dist) / 3 + 0.3);
    else if (dist > FAR) radial = Math.min(1, (dist - FAR) / 3 + 0.3);
    _mv.set(
      _dir.x * radial + -_dir.z * s.strafeDir * 0.85,
      0,
      _dir.z * radial + _dir.x * s.strafeDir * 0.85,
    );
    const ml = Math.hypot(_mv.x, _mv.z);
    if (ml > 1) _mv.multiplyScalar(1 / ml);
    this.steer(_mv, s.mode === 'charge' ? 1.5 : SPEED, dt, 6);
    const ratio = this.moveAndCollide(dt);
    if (ratio < 0.3) s.strafeDir = -s.strafeDir;
    this.faceDir(_dir.x, _dir.z, 7, dt);

    s.fireTimer -= dt;
    if (s.mode === 'move') {
      if (s.anim !== 'attack' || s.animTime > 0.55) this.setAnim('walk');
      if (s.fireTimer <= 0 && dist < 34) {
        if (this.hasLineOfSight(p, 1.6)) {
          s.mode = 'charge';
          s.timer = CHARGE;
          this.setAnim('attack');
        } else {
          s.fireTimer = 0.4;
          s.strafeTimer = Math.min(s.strafeTimer, 0.2);
        }
      }
    } else {
      s.timer -= dt;
      if (s.timer <= 0) {
        this.shoot(p.position, p.velocity, dist);
        s.mode = 'move';
        s.fireTimer = INTERVAL - CHARGE + ctx.rng() * 0.2;
      }
    }
  }

  private shoot(target: THREE.Vector3, targetVel: THREE.Vector3, dist: number): void {
    const ctx = this.env.ctx;
    const mouth = this.rig.parts.mouth;
    mouth.getWorldPosition(_origin);
    const lead = (dist / SHOT_SPEED) * 0.6;
    _aim.set(
      target.x + targetVel.x * lead,
      target.y + 1.1 + Math.max(-2, Math.min(2, targetVel.y * lead * 0.3)),
      target.z + targetVel.z * lead,
    );
    _aim.sub(_origin).normalize().multiplyScalar(SHOT_SPEED);
    this.env.projectiles.spit(_origin, _aim, DAMAGE * this.state.damageMult, this.id);
    ctx.audio.play('spitter_shot', { position: _origin.clone() });
    this.emitAttack('spit');
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const amp = s.alive ? Math.min(1, speed / 3) : 0;
    let bob = poseRun(r, this.walkPhase, amp, { stride: 0.7, arms: 0.7, bob: 0.045 });
    bob += Math.sin(s.age * 2.5) * 0.01;

    // charge: brace (lean back, tank swells); fire: the launcher kicks the shoulders back
    let swell = 0;
    let brace = 0;
    if (s.anim === 'attack') {
      const t = s.animTime;
      if (t < CHARGE) {
        swell = t / CHARGE;
        brace = 0.2 * swell;
      } else {
        brace = -0.25 * Math.max(0, 1 - (t - CHARGE) / 0.25);
      }
    }
    const sacS = 1 + 0.07 * Math.sin(s.age * 5) + 0.35 * swell;
    r.parts.sac.scale.setScalar(sacS);
    const lean = 0.06 + 0.24 * amp - brace - (s.hitTimer / 0.18) * 0.35 + (s.alive ? 0 : 0.3);
    r.body.position.y = r.bodyBaseY + bob;
    r.body.rotation.x = lean;
    r.arms[0].rotation.z = -0.1 - 0.1 * amp;
    r.arms[1].rotation.z = 0.1 + 0.1 * amp;
    r.body.rotation.z = Math.sin(this.walkPhase) * 0.05 * amp;
    if (r.head) r.head.rotation.x = -lean * 0.5;
  }
}
