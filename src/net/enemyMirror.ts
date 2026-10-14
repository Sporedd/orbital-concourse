/**
 * Client-side enemy mirror: displays the host's enemies without running their AI.
 *
 * MirrorEnemy builds the same procedural rig as the real enemy (src/enemies/models.ts),
 * interpolates its transform between snapshots (INTERP_DELAY behind the host), animates a
 * generic walk/attack/death cycle and tints by hit flash / status. It implements the Enemy
 * contract so the local weapon code (hitscan, melee, splash) works unchanged against it:
 * damage() does NOT apply damage, it forwards a hit claim to the host via the sink.
 *
 * MirrorEnemyRegistry implements EnemyRegistry and replaces ctx.enemies on a client.
 * Enemy projectiles are mirrored by ProjectileMirror (simple glow spheres + mortar markers).
 */
import * as THREE from 'three';
import type {
  BossKind, DamageOpts, Element, Enemy, EnemyRegistry, EnemyState, GameContext, MaterialFactory, MobKind, StatusEffect,
} from '@/core/types';
import { ELEMENT_COLORS } from '@/core/types';
import { LUM, PALETTE, glowLum } from '@/rendering/style';
import {
  DISC_GEO, RING_GEO, SPHERE_GEO,
  buildArtillery, buildBomber, buildBrute, buildGrunt, buildSpitter, buildSummoner, type Rig,
} from '@/enemies/models';
import { applyEnemyDelta, dec, type EnemyDeltaW, type EnemyW, type ProjW } from './protocol';
import { SampleBuffer, makeSample } from './interp';

type Kind = MobKind | BossKind;

/** Per-kind collision + crit geometry. Mirrors the EnemyConfig values in src/enemies (keep in sync). */
interface KindInfo {
  build: (mf: MaterialFactory) => Rig;
  radius: number;
  height: number;
  centerHeight: number;
  /** Mobs: head sphere radius. Bosses: weak point radius. */
  critRadius: number;
  burstColor: number;
  deathDuration: number;
}

export const KIND_INFO: Record<Kind, KindInfo> = {
  grunt: { build: buildGrunt, radius: 0.5, height: 1.85, centerHeight: 1.1, critRadius: 0.3, burstColor: 0xbfe6ff, deathDuration: 2 },
  spitter: { build: buildSpitter, radius: 0.6, height: 1.9, centerHeight: 1.1, critRadius: 0.24, burstColor: 0xff6aa0, deathDuration: 2 },
  bomber: { build: buildBomber, radius: 0.5, height: 1.3, centerHeight: 0.75, critRadius: 0.25, burstColor: 0xffc060, deathDuration: 2 },
  brute: { build: buildBrute, radius: 1.9, height: 5.0, centerHeight: 3.1, critRadius: 0.88, burstColor: 0xd8f0ff, deathDuration: 3 },
  summoner: { build: buildSummoner, radius: 1.3, height: 5.85, centerHeight: 4.15, critRadius: 0.62, burstColor: 0xc8a8ff, deathDuration: 3 },
  artillery: { build: buildArtillery, radius: 2.35, height: 4.95, centerHeight: 3.0, critRadius: 1.17, burstColor: 0xffb070, deathDuration: 3 },
};

export interface ClaimSink {
  /** The local weapon/melee code hit a mirrored enemy. */
  hit(enemy: MirrorEnemy, amount: number, opts: DamageOpts | undefined): void;
  /** Area damage (grenade / splash) requested locally. */
  area(center: THREE.Vector3, radius: number, amount: number, opts: DamageOpts | undefined): void;
}

const noRaycast = (): void => {};
/** Anim names (set by the real enemies) that raise the arms on the mirror. */
const ATTACK_ANIMS = new Set(['attack', 'slam', 'cast', 'summon', 'roar', 'fire', 'aim', 'stomp', 'charge']);
// hit flash: same as src/enemies/base.ts (BONE at lum 1.2, art spec §7)
const WHITE = new THREE.Color(PALETTE.BONE).multiplyScalar(glowLum(PALETTE.BONE, LUM.seam, 4));
const FROZEN_TINT = new THREE.Color(0xbff4ff);
const FIRE_TINT = new THREE.Color(ELEMENT_COLORS.fire);
const SHOCK_TINT = new THREE.Color(ELEMENT_COLORS.shock);
const ICE_TINT = new THREE.Color(ELEMENT_COLORS.ice);
const _w = new THREE.Vector3();

export class MirrorEnemy implements Enemy {
  readonly id: string;
  readonly state: EnemyState;
  readonly object: THREE.Object3D;
  readonly isBoss: boolean;
  readonly position = new THREE.Vector3();
  readonly radius: number;
  readonly height: number;
  readonly rig: Rig;
  readonly info: KindInfo;
  /** Latest full record from the host. */
  record: EnemyW;
  frozen = false;
  shielded = false;

  private readonly buffer = new SampleBuffer(10);
  private readonly sampleTmp = makeSample();
  private readonly prevPos = new THREE.Vector3();
  private speed = 0;
  private walkPhase = 0;
  private flash = 0;
  private deathTime = 0;
  private age = 0;

  constructor(private readonly ctx: GameContext, w: EnemyW, tm: number, private readonly sink: ClaimSink) {
    const kind = dec.kind(w.k);
    this.info = KIND_INFO[kind];
    this.id = w.i;
    this.isBoss = w.b === 1;
    this.radius = this.info.radius;
    this.height = this.info.height;
    this.rig = this.info.build(ctx.materials);
    this.object = this.rig.root;
    this.position.set(w.p[0], w.p[1], w.p[2]);
    this.prevPos.copy(this.position);
    this.state = {
      id: w.i, kind, isBoss: this.isBoss, tier: w.t, position: this.position, yaw: w.y,
      health: w.h, maxHealth: w.m, alive: w.a === 1, phase: w.ph, anim: w.an, statuses: [],
    };
    this.record = w;
    this.object.position.copy(this.position);
    this.object.rotation.y = w.y;
    this.object.traverse((o) => { o.userData.enemyId = this.id; });
    if (!this.state.alive) this.object.traverse((o) => { o.raycast = noRaycast; });
    ctx.scene.add(this.object);
    this.apply(w, tm);
  }

  get alive(): boolean {
    return this.state.alive;
  }

  /** Take a full record from a snapshot taken at host time `tm`. */
  apply(w: EnemyW, tm: number): void {
    const s = this.state;
    if (w.h < s.health - 0.01 && s.alive) this.flash = 0.08;
    s.tier = w.t;
    s.health = w.h;
    s.maxHealth = w.m;
    s.phase = w.ph;
    s.anim = w.an;
    s.statuses = (w.s ?? []).map(([el, rem]): StatusEffect => ({ element: dec.element(el), remaining: rem, strength: 0 }));
    this.frozen = w.fz === 1;
    this.shielded = w.sh === 1;
    if (s.alive && w.a === 0) this.kill();
    this.record = w;
    this.buffer.push(tm, w.p[0], w.p[1], w.p[2], w.y);
  }

  /** Mark dead now (enemy:killed arrived) — corpses stop catching bullets. */
  kill(): void {
    if (!this.state.alive) return;
    this.state.alive = false;
    this.state.health = 0;
    this.state.statuses = [];
    this.deathTime = 0;
    this.object.traverse((o) => { o.raycast = noRaycast; });
  }

  // ---- Enemy contract ------------------------------------------------------------
  isCritPoint(point: THREE.Vector3): boolean {
    if (!this.state.alive) return false;
    if (this.frozen) return true;
    if (this.isBoss) {
      const weak = this.rig.parts.weak ?? this.rig.head ?? this.rig.body;
      weak.getWorldPosition(_w);
      return _w.distanceToSquared(point) <= this.info.critRadius * this.info.critRadius;
    }
    if (point.y - this.position.y >= this.height * 0.88) return true;
    const head = this.rig.head;
    if (!head) return point.y - this.position.y >= this.height * 0.75;
    head.getWorldPosition(_w);
    const r = this.info.critRadius * 1.35;
    return _w.distanceToSquared(point) <= r * r;
  }

  /** Records a hit claim; returns the PREDICTED damage (0 while shielded) so local perks/hit counts work. */
  damage(amount: number, opts?: DamageOpts): number {
    if (!this.state.alive || !(amount > 0)) return 0;
    // Prediction: flash + a small burst now; numbers/kill come back from the host.
    this.flash = 0.08;
    if (!this.shielded) this.ctx.fx.burst(opts?.point ? opts.point.clone() : this.centerPoint(new THREE.Vector3()), this.info.burstColor, opts?.crit ? 6 : 3);
    this.sink.hit(this, amount, opts);
    return this.shielded ? 0 : Math.min(amount, Math.max(0, this.state.health));
  }

  applyStatus(_status: StatusEffect): void {
    // host-authoritative; statuses arrive with the next snapshot
  }

  centerPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.info.centerHeight, this.position.z);
  }

  // ---- view ----------------------------------------------------------------------
  update(renderTime: number, dt: number): void {
    this.age += dt;
    const smp = this.buffer.sample(renderTime, this.sampleTmp);
    if (smp && this.state.alive) {
      this.position.set(smp.x, smp.y, smp.z);
      this.state.yaw = smp.yaw;
    }
    if (dt > 0) {
      const sp = Math.hypot(this.position.x - this.prevPos.x, this.position.z - this.prevPos.z) / dt;
      this.speed += (Math.min(sp, 25) - this.speed) * Math.min(1, dt * 12);
    }
    this.prevPos.copy(this.position);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);

    const rig = this.rig;
    const root = rig.root;
    root.position.copy(this.position);
    root.rotation.set(0, this.state.yaw, 0);
    root.scale.setScalar(rig.scale);
    if (!this.frozen) this.animate(dt);
    if (!this.state.alive) {
      this.deathTime += dt;
      this.deathPose();
    }
    this.tint();
  }

  private animate(dt: number): void {
    const rig = this.rig;
    const s = this.state;
    const kind = s.kind;
    if (s.alive) this.walkPhase += this.speed * dt * (this.isBoss ? 0.9 : 1.6);
    const k = Math.min(1, this.speed / 4);
    const sw = Math.sin(this.walkPhase);
    const legAmp = kind === 'artillery' ? 0.25 : kind === 'spitter' ? 0.35 : 0.6;
    for (let i = 0; i < rig.legs.length; i++) {
      // biped: alternate; quadruped: diagonal pairs (0/3, 1/2)
      const sign = rig.legs.length === 4 ? (i === 0 || i === 3 ? 1 : -1) : i % 2 === 0 ? 1 : -1;
      rig.legs[i].rotation.x = sw * legAmp * k * sign;
    }
    const attacking = ATTACK_ANIMS.has(s.anim);
    for (let i = 0; i < rig.arms.length; i++) {
      const sign = i % 2 === 0 ? -1 : 1;
      const target = attacking ? -1.3 : sw * 0.5 * k * sign;
      const a = rig.arms[i];
      a.rotation.x += (target - a.rotation.x) * Math.min(1, dt * 14);
    }
    let bob = Math.abs(Math.cos(this.walkPhase)) * 0.05 * k;
    if (kind === 'summoner') bob = Math.sin(this.age * 1.6) * 0.15;
    rig.body.position.y = rig.bodyBaseY + bob;
    if (rig.parts.halo) rig.parts.halo.rotation.y += dt * 0.8;
    if (rig.parts.spark) rig.parts.spark.scale.setScalar(0.8 + 0.4 * Math.abs(Math.sin(this.age * 20)));
    if (rig.parts.sac) rig.parts.sac.scale.setScalar(1 + 0.06 * Math.sin(this.age * 6));
  }

  /** Same fall + sink as BaseEnemy.applyDeathPose. */
  private deathPose(): void {
    const t = this.deathTime;
    const root = this.rig.root;
    const dur = this.info.deathDuration;
    const k = Math.min(1, t / 0.45);
    const fall = 1 - (1 - k) * (1 - k);
    if (this.isBoss) root.rotation.z = fall * 1.35;
    else root.rotation.x = -fall * 1.45;
    const sinkStart = dur * 0.45;
    if (t > sinkStart) {
      const u = Math.min(1, (t - sinkStart) / (dur - sinkStart));
      root.position.y -= u * this.height * 0.4;
      root.scale.setScalar(this.rig.scale * Math.max(0.05, 1 - 0.75 * u));
    }
  }

  private tint(): void {
    const s = this.state;
    const mats = this.rig.mats;
    const base = this.rig.baseEmissive;
    let tint: THREE.Color | null = null;
    let k = 0;
    if (s.alive) {
      if (this.flash > 0) {
        tint = WHITE;
        k = 1;
      } else if (this.frozen) {
        tint = FROZEN_TINT;
        k = 0.75;
      } else if (s.statuses.length) {
        const has = (e: Element) => s.statuses.some((x) => x.element === e);
        if (has('fire')) {
          tint = FIRE_TINT;
          k = 0.35 + 0.15 * Math.sin(this.age * 14);
        } else if (has('shock')) {
          tint = SHOCK_TINT;
          k = Math.sin(this.age * 47) > 0 ? 0.65 : 0.25;
        } else if (has('ice')) {
          tint = ICE_TINT;
          k = 0.35;
        }
      } else if (this.shielded) {
        tint = SHOCK_TINT;
        k = 0.3 + 0.1 * Math.sin(this.age * 6);
      }
    }
    for (let i = 0; i < mats.length; i++) {
      const e = mats[i].emissive;
      e.copy(base[i]);
      if (tint) e.lerp(tint, k);
    }
  }

  dispose(): void {
    this.ctx.scene.remove(this.object);
    for (const m of this.rig.owned) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------
const SPIT_COLOR = 0xff3d7a;
const ORB_COLOR = 0xc65aff;
const SHELL_COLOR = 0xff8a2a;

interface ShotView { mesh: THREE.Mesh; vel: THREE.Vector3; seen: number }
interface ShellView {
  shell: THREE.Mesh; ring: THREE.Mesh; disc: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; discMat: THREE.MeshBasicMaterial;
  from: THREE.Vector3; to: THREE.Vector3; t: number; duration: number; apex: number; radius: number; seen: number;
}

export class ProjectileMirror {
  private readonly shots = new Map<string, ShotView>();
  private readonly shells = new Map<string, ShellView>();
  private mats: Record<string, THREE.MeshBasicMaterial> = {};
  private gen = 0;

  constructor(private readonly ctx: GameContext) {}

  private mat(key: string, color: number, intensity: number): THREE.MeshBasicMaterial {
    if (!this.mats[key]) this.mats[key] = this.ctx.materials.glow(color, intensity);
    return this.mats[key];
  }

  apply(pr: ProjW | undefined): void {
    this.gen++;
    const g = this.gen;
    for (const [id, kind, x, y, z, vx, vy, vz] of pr?.s ?? []) {
      let v = this.shots.get(id);
      if (!v) {
        const orb = kind === 1;
        const mesh = new THREE.Mesh(SPHERE_GEO(), this.mat(orb ? 'orb' : 'spit', orb ? ORB_COLOR : SPIT_COLOR, orb ? 2.8 : 2.6));
        mesh.raycast = noRaycast;
        mesh.scale.setScalar(orb ? 0.38 : 0.22);
        this.ctx.scene.add(mesh);
        v = { mesh, vel: new THREE.Vector3(), seen: g };
        this.shots.set(id, v);
      }
      v.mesh.position.set(x, y, z);
      v.vel.set(vx, vy, vz);
      v.seen = g;
    }
    for (const [id, fx, fy, fz, tx, ty, tz, t, duration, apex, radius] of pr?.m ?? []) {
      let v = this.shells.get(id);
      if (!v) {
        const shell = new THREE.Mesh(SPHERE_GEO(), this.mat('shell', SHELL_COLOR, 3));
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
          this.ctx.scene.add(m);
        }
        v = {
          shell, ring, disc, ringMat, discMat, from: new THREE.Vector3(), to: new THREE.Vector3(),
          t: 0, duration: 1.2, apex: 8, radius: 3.5, seen: g,
        };
        this.shells.set(id, v);
      }
      v.from.set(fx, fy, fz);
      v.to.set(tx, ty, tz);
      v.t = t;
      v.duration = Math.max(0.1, duration);
      v.apex = apex;
      v.radius = radius;
      v.seen = g;
      v.ring.position.set(tx, ty + 0.06, tz);
      v.disc.position.set(tx, ty + 0.05, tz);
      v.ring.scale.setScalar(radius);
    }
    for (const [id, v] of this.shots) {
      if (v.seen !== g) {
        this.ctx.scene.remove(v.mesh);
        this.shots.delete(id);
      }
    }
    for (const [id, v] of this.shells) {
      if (v.seen !== g) this.removeShell(id, v);
    }
  }

  update(dt: number): void {
    for (const v of this.shots.values()) v.mesh.position.addScaledVector(v.vel, dt);
    for (const v of this.shells.values()) {
      v.t += dt;
      const u = Math.min(1, v.t / v.duration);
      v.shell.position.lerpVectors(v.from, v.to, u);
      v.shell.position.y += v.apex * 4 * u * (1 - u);
      v.ringMat.opacity = 0.55 + 0.4 * Math.sin(v.t * 22);
      v.disc.scale.setScalar(Math.max(0.01, v.radius * u));
    }
  }

  private removeShell(id: string, v: ShellView): void {
    for (const m of [v.shell, v.ring, v.disc]) this.ctx.scene.remove(m);
    v.ringMat.dispose();
    v.discMat.dispose();
    this.shells.delete(id);
  }

  clear(): void {
    for (const v of this.shots.values()) this.ctx.scene.remove(v.mesh);
    this.shots.clear();
    for (const [id, v] of this.shells) this.removeShell(id, v);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export class MirrorEnemyRegistry implements EnemyRegistry {
  private readonly map = new Map<string, MirrorEnemy>();
  private readonly arr: MirrorEnemy[] = [];
  private readonly records = new Map<string, EnemyW>();
  readonly projectiles: ProjectileMirror;

  constructor(private readonly ctx: GameContext, private readonly sink: ClaimSink) {
    this.projectiles = new ProjectileMirror(ctx);
  }

  list(): Enemy[] {
    return this.arr;
  }

  get(id: string): MirrorEnemy | undefined {
    return this.map.get(id);
  }

  spawnMob(_kind: MobKind | 'random', _position: THREE.Vector3, _tier: number): Enemy {
    throw new Error('[net] spawnMob called on a client: enemies are host-authoritative');
  }

  spawnBoss(_kind: BossKind | 'auto', _position: THREE.Vector3, _tier: number): Enemy {
    throw new Error('[net] spawnBoss called on a client: enemies are host-authoritative');
  }

  damageRadius(center: THREE.Vector3, radius: number, amount: number, opts?: DamageOpts): number {
    if (!(radius > 0) || !(amount > 0)) return 0;
    this.sink.area(center, radius, amount, opts);
    // Estimated hit count (the host decides the real one).
    let n = 0;
    for (const e of this.arr) {
      if (!e.alive) continue;
      const d = Math.max(0, e.position.distanceTo(center) - e.radius);
      if (d <= radius) n++;
    }
    return n;
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.arr) if (e.alive) n++;
    return n;
  }

  bossAlive(): boolean {
    for (const e of this.arr) if (e.isBoss && e.alive) return true;
    return false;
  }

  clear(): void {
    for (const e of this.arr) e.dispose();
    this.arr.length = 0;
    this.map.clear();
    this.records.clear();
    this.projectiles.clear();
  }

  /** Driven by the net session (render time in host seconds); the main loop's call is a no-op. */
  update(_dt: number): void {}

  tick(renderTime: number, dt: number): void {
    for (const e of this.arr) e.update(renderTime, dt);
    this.projectiles.update(dt);
  }

  /** Apply the enemy part of a snapshot. Returns the newly created enemies. */
  applySnapshot(tm: number, deltas: EnemyDeltaW[] | undefined, removed: string[] | undefined): MirrorEnemy[] {
    const created: MirrorEnemy[] = [];
    for (const d of deltas ?? []) {
      if (!d || typeof d.i !== 'string') continue;
      const full = applyEnemyDelta(this.records.get(d.i), d);
      this.records.set(d.i, full);
      const e = this.map.get(d.i);
      if (e) e.apply(full, tm);
      else {
        const ne = new MirrorEnemy(this.ctx, full, tm, this.sink);
        this.map.set(ne.id, ne);
        this.arr.push(ne);
        created.push(ne);
      }
    }
    // Known enemies that did not change still need a fresh sample so interpolation keeps time.
    const touched = new Set((deltas ?? []).map((d) => d.i));
    for (const e of this.arr) if (!touched.has(e.id)) e.apply(e.record, tm);
    for (const id of removed ?? []) this.remove(id);
    return created;
  }

  remove(id: string): void {
    const e = this.map.get(id);
    this.records.delete(id);
    if (!e) return;
    e.dispose();
    this.map.delete(id);
    const i = this.arr.indexOf(e);
    if (i >= 0) this.arr.splice(i, 1);
  }
}
