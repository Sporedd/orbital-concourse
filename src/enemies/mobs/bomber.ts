/**
 * Bomber: fast suicide runner. Within 3.5 m it lights a 0.8 s fuse (blinking), then
 * explodes for 35 (falloff, 4 m) on players. Killed before that, it pops with a small
 * blast that hurts other ENEMIES within 3 m for 40 (chain reactions), never players.
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { hurtPlayersInRadius, shakeFrom } from '../common';
import { BaseEnemy, type EnemyConfig, type EnemySimState } from '../base';
import { buildBomber } from '../models';

export interface BomberState extends EnemySimState {
  fusing: boolean;
  fuse: number;
  exploded: boolean;
  popTimer: number;
  popKiller: string | null;
  zig: number;
}

const CFG: EnemyConfig = {
  kind: 'bomber', isBoss: false, radius: 0.5, height: 1.3, baseHealth: 35, mass: 0.8,
  burstColor: 0xff2238, headRadius: 0.25, centerHeight: 0.75,
};
const SPEED = 9.5;
const TRIGGER = 3.5;
const FUSE = 0.8;
const BLAST_RADIUS = 4;
const BLAST_DAMAGE = 35;
const POP_RADIUS = 3;
const POP_DAMAGE = 40;
const COLOR = 0xff2238;

const _dir = new THREE.Vector3();

export class Bomber extends BaseEnemy<BomberState> {
  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    super(env, CFG, buildBomber(env.ctx.materials), pos, tier, {
      fusing: false, fuse: FUSE, exploded: false, popTimer: -1, popKiller: null, zig: env.ctx.rng() * 10,
    });
    this.stride = 2.6;
  }

  protected think(dt: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    const p = this.findTarget();
    if (!p && !s.fusing) {
      this.brake(dt, 4);
      this.moveAndCollide(dt);
      this.setAnim('idle');
      return;
    }
    const dist = p ? this.flatDirTo(p.position, _dir) : 99;

    if (!s.fusing) {
      if (p && dist < TRIGGER && Math.abs(p.position.y - this.position.y) < 2.5) {
        s.fusing = true;
        s.fuse = FUSE;
        this.setAnim('attack');
        ctx.audio.play('bomber_fuse', { position: this.position.clone() });
        this.emitAttack('fuse');
      } else if (p) {
        if (dist > 6) {
          const w = Math.sin(s.age * 4 + s.zig) * 0.35;
          const fx = _dir.x;
          _dir.x += -_dir.z * w;
          _dir.z += fx * w;
          _dir.normalize();
        }
        this.steer(_dir, SPEED, dt, 7);
        this.moveAndCollide(dt);
        this.faceMovement(dt, 12);
        this.setAnim('walk');
        return;
      }
    }
    // fusing: keep shuffling towards the target, then blow
    if (p) {
      this.steer(_dir, 4, dt, 6);
      this.faceDir(_dir.x, _dir.z, 10, dt);
    } else {
      this.brake(dt, 6);
    }
    this.moveAndCollide(dt);
    s.fuse -= dt;
    if (s.fuse <= 0) this.explode();
  }

  private explode(): void {
    const s = this.state;
    const ctx = this.env.ctx;
    s.exploded = true;
    const c = this.centerPoint(new THREE.Vector3());
    ctx.fx.explosion(c.clone(), BLAST_RADIUS, COLOR);
    ctx.audio.play('explosion', { position: c.clone() });
    shakeFrom(ctx, c, 0.7, 16);
    this.emitAttack('explode');
    hurtPlayersInRadius(ctx, c, BLAST_RADIUS, BLAST_DAMAGE * s.damageMult, this.id, 'none');
    this.die(undefined, 'explosion');
    // gone in a flash: hide and remove almost immediately
    this.rig.root.visible = false;
    s.deathTime = this.deathDuration - 0.05;
  }

  protected onDeath(killerId: string | undefined): void {
    const s = this.state;
    if (!s.exploded) {
      s.popTimer = 0.12;
      s.popKiller = killerId ?? null;
    }
  }

  protected onDying(dt: number): void {
    const s = this.state;
    if (s.popTimer <= 0) return;
    s.popTimer -= dt;
    if (s.popTimer > 0) return;
    const ctx = this.env.ctx;
    const c = this.centerPoint(new THREE.Vector3());
    ctx.fx.explosion(c.clone(), POP_RADIUS, 0xff2238);
    ctx.audio.play('explosion', { position: c.clone(), volume: 0.6, pitch: 1.3 });
    shakeFrom(ctx, c, 0.35, 12);
    this.env.damageRadius(c, POP_RADIUS, POP_DAMAGE * s.damageMult, {
      element: 'none', crit: false, sourceId: s.popKiller ?? undefined,
    });
    this.rig.root.visible = false;
    s.deathTime = Math.max(s.deathTime, this.deathDuration - 0.05);
  }

  protected customEmissive(): void {
    const s = this.state;
    const a = this.rig.accent;
    if (!a) return;
    if (s.fusing) {
      const prog = 1 - Math.max(0, s.fuse) / FUSE;
      const on = Math.sin(prog * prog * 70 + prog * 12) > 0;
      if (on) a.emissive.setRGB(1, 0.92, 0.88).multiplyScalar(2.5);
    } else {
      a.emissive.multiplyScalar(0.75 + 0.25 * Math.sin(s.age * 4));
    }
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const amp = s.alive ? Math.min(1, speed / 5) : 0;
    const sw = Math.sin(this.walkPhase);
    r.legs[0].rotation.x = sw * 0.7 * amp;
    r.legs[1].rotation.x = -sw * 0.7 * amp;
    r.arms[0].rotation.z = -0.4 - Math.abs(sw) * 0.5 * amp;
    r.arms[1].rotation.z = 0.4 + Math.abs(sw) * 0.5 * amp;
    r.body.rotation.z = sw * 0.18 * amp;
    r.body.position.y = r.bodyBaseY + Math.abs(Math.cos(this.walkPhase)) * 0.1 * amp;
    let bombS = 1;
    if (s.fusing && s.alive) {
      const prog = 1 - Math.max(0, s.fuse) / FUSE;
      bombS = 1 + 0.35 * prog + 0.05 * Math.sin(s.age * 50);
      r.body.rotation.z += Math.sin(s.age * 60) * 0.06;
      r.body.rotation.x = 0.1 * Math.sin(s.age * 47);
    } else {
      r.body.rotation.x = 0.2 * amp - (s.hitTimer / 0.18) * 0.35;
    }
    r.parts.bomb.scale.setScalar(bombS);
    r.parts.spark.scale.setScalar(0.8 + 0.5 * Math.abs(Math.sin(s.age * 25)));
  }
}
