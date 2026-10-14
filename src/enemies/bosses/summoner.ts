/**
 * Veyra the Summoner. Floats ~2 m up, keeps 12–16 m away and drifts sideways.
 * - Summons 3 grunts (same tier) every 12 / 10 / 8 s by phase, with a glowing ground ring.
 * - Homing orbs every 2.5 / 2.2 / 1.8 s (speed 12, damage 14); two at once in phase 2.
 * - Shield: each time it loses another 25 % of its health it becomes immune for 4 s
 *   (glow bubble). Weak point: the glowing core in its chest.
 */
import * as THREE from 'three';
import type { EnemyEnv } from '../common';
import { noRaycast } from '../common';
import type { EnemyConfig, EnemySimState } from '../base';
import { buildSummoner, RING_GEO, SPHERE_GEO } from '../models';
import { BossBase } from './boss';

export interface SummonerState extends EnemySimState {
  mode: 'drift' | 'summon';
  timer: number;
  summonTimer: number;
  orbTimer: number;
  driftDir: number;
  driftTimer: number;
  shield: number;
  shieldThreshold: number;
}

const CFG: EnemyConfig = {
  kind: 'summoner', isBoss: true, radius: 1.0, height: 4.5, baseHealth: 1100, mass: 6,
  burstColor: 0xff2238, centerHeight: 3.2,
};
const SPEED = 4;
const NEAR = 12;
const FAR = 16;
const SUMMON_CAST = 1.0;
const SHIELD_TIME = 4;
const ORB_DAMAGE = 14;
const ACCENT = 0xff2238;
const SHIELD_COLOR = 0xeceae4;
const MAX_ALIVE_FOR_SUMMON = 22;

const _dir = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _core = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _spawn = new THREE.Vector3();

export class Summoner extends BossBase<SummonerState> {
  readonly bossName = 'Veyra the Summoner';
  private readonly bubble: THREE.Mesh;
  private readonly bubbleMat: THREE.MeshBasicMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;

  constructor(env: EnemyEnv, pos: THREE.Vector3, tier: number) {
    const rng = env.ctx.rng;
    super(env, CFG, buildSummoner(env.ctx.materials), pos, tier, {
      mode: 'drift', timer: 0, summonTimer: 4, orbTimer: 2, driftDir: rng() < 0.5 ? -1 : 1,
      driftTimer: 3 + rng() * 2, shield: 0, shieldThreshold: 0.75,
    }, 0.48);
    this.stride = 0;

    const mf = env.ctx.materials;
    this.bubbleMat = mf.glow(SHIELD_COLOR, 1.4);
    this.bubbleMat.transparent = true;
    this.bubbleMat.opacity = 0.28;
    this.bubbleMat.depthWrite = false;
    this.bubble = new THREE.Mesh(SPHERE_GEO(), this.bubbleMat);
    this.bubble.raycast = noRaycast;
    this.bubble.visible = false;
    this.bubble.renderOrder = 3;

    this.ringMat = mf.glow(ACCENT, 2.4);
    this.ringMat.transparent = true;
    this.ringMat.depthWrite = false;
    this.ringMat.side = THREE.DoubleSide;
    this.ring = new THREE.Mesh(RING_GEO(), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.raycast = noRaycast;
    this.ring.visible = false;
    this.extras.push(this.bubble, this.ring);
    this.rig.owned.push(this.bubbleMat, this.ringMat);
  }

  protected isImmune(): boolean {
    return this.state.shield > 0;
  }

  protected onBlocked(point: THREE.Vector3 | undefined): void {
    const p = point ? point.clone() : this.centerPoint(new THREE.Vector3());
    this.env.ctx.fx.burst(p, SHIELD_COLOR, 5);
  }

  /** Big hits stop at the next shield threshold so every shield phase happens. */
  protected modifyIncoming(amount: number): number {
    const s = this.state;
    if (s.shieldThreshold <= 0) return amount;
    const floor = s.shieldThreshold * s.maxHealth;
    if (s.health > floor && s.health - amount < floor) return s.health - floor;
    return amount;
  }

  protected afterDamage(amount: number): void {
    const s = this.state;
    if (s.shieldThreshold > 0 && s.health > 0 && s.health <= s.shieldThreshold * s.maxHealth + 0.01) {
      s.shield = SHIELD_TIME;
      s.shieldThreshold = Math.max(0, s.shieldThreshold - 0.25);
      if (s.shieldThreshold < 0.01) s.shieldThreshold = 0;
      this.env.ctx.fx.burst(this.centerPoint(new THREE.Vector3()), SHIELD_COLOR, 24);
    }
    super.afterDamage(amount);
  }

  protected onDisabled(dt: number): void {
    // shield keeps ticking down while frozen
    const s = this.state;
    s.shield = Math.max(0, s.shield - dt);
  }

  protected think(dt: number): void {
    const s = this.state;
    const ctx = this.env.ctx;
    s.shield = Math.max(0, s.shield - dt);
    s.summonTimer -= dt;
    s.orbTimer -= dt;
    const p = this.findTarget();
    if (!p) {
      this.brake(dt, 3);
      this.moveAndCollide(dt);
      if (s.mode !== 'summon') this.setAnim('idle');
    }
    const dist = p ? this.flatDirTo(p.position, _dir) : 0;

    if (p) {
      s.driftTimer -= dt;
      if (s.driftTimer <= 0) {
        s.driftTimer = 3 + ctx.rng() * 2;
        s.driftDir = -s.driftDir;
      }
      let radial = 0;
      if (dist < NEAR) radial = -1;
      else if (dist > FAR) radial = 1;
      _mv.set(_dir.x * radial - _dir.z * s.driftDir * 0.8, 0, _dir.z * radial + _dir.x * s.driftDir * 0.8);
      const ml = Math.hypot(_mv.x, _mv.z);
      if (ml > 1) _mv.multiplyScalar(1 / ml);
      this.steer(_mv, s.mode === 'summon' ? 1 : SPEED, dt, 2.5);
      if (this.moveAndCollide(dt) < 0.3) s.driftDir = -s.driftDir;
      this.faceDir(_dir.x, _dir.z, 3, dt);
    }

    if (s.mode === 'summon') {
      s.timer -= dt;
      if (s.timer <= 0) {
        this.doSummon();
        s.mode = 'drift';
        s.summonTimer = this.byPhase([12, 10, 8]);
        this.setAnim('idle');
      }
      return;
    }
    if (!p) return;
    if (s.summonTimer <= 0) {
      if (this.env.aliveCount() < MAX_ALIVE_FOR_SUMMON) {
        s.mode = 'summon';
        s.timer = SUMMON_CAST;
        this.setAnim('summon');
        ctx.audio.play('boss_roar', { position: this.position.clone(), pitch: 1.25 });
        this.emitAttack('summon');
        return;
      }
      s.summonTimer = 3;
    }
    if (s.orbTimer <= 0) {
      if (this.hasLineOfSight(p, this.centerHeight)) {
        this.fireOrbs(p.id, p.position);
        s.orbTimer = this.byPhase([2.5, 2.2, 1.8]);
        this.setAnim('cast');
      } else {
        s.orbTimer = 0.5;
      }
    }
    if (s.anim === 'cast' && s.animTime > 0.45) this.setAnim('idle');
  }

  private doSummon(): void {
    const s = this.state;
    const ctx = this.env.ctx;
    for (let i = 0; i < 3; i++) {
      const a = s.yaw + (i / 3) * Math.PI * 2 + (ctx.rng() - 0.5) * 0.6;
      const r = 2.8 + ctx.rng() * 1.2;
      _spawn.set(this.position.x + Math.sin(a) * r, this.position.y, this.position.z + Math.cos(a) * r);
      const res = ctx.world.resolveCapsule(_spawn, 0.5, 1.85);
      const at = new THREE.Vector3(res.position.x, ctx.world.groundHeight(res.position.x, res.position.z), res.position.z);
      this.env.spawnMob('grunt', at, s.tier);
      at.y += 0.8;
      ctx.fx.burst(at, ACCENT, 14);
    }
    ctx.fx.explosion(this.position.clone().setY(this.position.y + 0.3), 3.5, ACCENT);
  }

  private fireOrbs(targetId: string, target: THREE.Vector3): void {
    const s = this.state;
    this.weakPoint(_core);
    _aim.set(target.x, target.y + 1.1, target.z).sub(_core).normalize();
    const count = s.phase >= 2 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const spread = count === 1 ? 0 : (i === 0 ? -0.35 : 0.35);
      const dir = _aim.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, spread);
      this.env.projectiles.orb(_core, dir, ORB_DAMAGE * s.damageMult, this.id, targetId);
    }
    this.emitAttack('orb');
  }

  protected animate(_dt: number): void {
    const s = this.state;
    const r = this.rig;
    const t = s.animTime;
    r.body.position.y = r.bodyBaseY + Math.sin(s.age * 1.5) * 0.22;
    r.body.rotation.x = 0.08 - (s.hitTimer / 0.18) * 0.12;
    r.parts.halo.rotation.y = s.age * (s.anim === 'summon' ? 4 : 1.2);
    const corePulse = 1 + 0.12 * Math.sin(s.age * 6);
    r.parts.weak.scale.setScalar(corePulse);
    let armX = -0.15 + Math.sin(s.age * 1.3) * 0.08;
    let armZ = 0.2;
    let armXR = armX;
    if (s.anim === 'summon') {
      const k = Math.min(1, t / 0.3);
      armX = armXR = -1.2 * k;
      armZ = 0.2 + 1.0 * k;
    } else if (s.anim === 'cast') {
      const k = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.3);
      armXR = -1.5 * k;
    }
    if (!s.alive) {
      armX = armXR = 0.3;
      armZ = 0.6;
    }
    r.arms[0].rotation.set(armX, 0, -armZ);
    r.arms[1].rotation.set(armXR, 0, armZ);
    if (r.head) r.head.rotation.x = Math.sin(s.age * 0.9) * 0.08;

    // non-hittable extras live in world space
    const shielded = s.alive && s.shield > 0;
    this.bubble.visible = shielded;
    if (shielded) {
      this.bubble.position.set(this.position.x, this.position.y + r.body.position.y + 1.3, this.position.z);
      const flick = s.shield < 1 ? (Math.sin(s.age * 30) > 0 ? 1 : 0.4) : 1;
      this.bubble.scale.setScalar(2.2 + 0.08 * Math.sin(s.age * 8));
      this.bubbleMat.opacity = 0.26 * flick;
    }
    const summoning = s.alive && s.anim === 'summon';
    this.ring.visible = summoning;
    if (summoning) {
      const k = Math.min(1, t / SUMMON_CAST);
      this.ring.position.set(this.position.x, this.position.y + 0.06, this.position.z);
      this.ring.scale.setScalar(1 + 3 * k);
      this.ring.rotation.z = s.age * 2;
      this.ringMat.opacity = 0.5 + 0.45 * Math.sin(s.age * 18);
    }
  }
}
