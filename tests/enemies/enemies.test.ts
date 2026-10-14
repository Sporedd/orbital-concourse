import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { bossHealthMult, mobHealthMult, playerCountHealthMult } from '@/core/config';
import { EnemyManager, BOSS_ROTATION, mobWeights } from '@/enemies';
import type { BaseEnemy } from '@/enemies';
import { PHASE_THRESHOLDS } from '@/enemies/bosses/boss';
import type { Brute } from '@/enemies/bosses/brute';
import type { Summoner } from '@/enemies/bosses/summoner';
import type { Artillery } from '@/enemies/bosses/artillery';
import { createPlayerRegistry } from '@/player';
import {
  createFakeContext, createFakePlayer, createFlatWorld, recordEvents, type FakePlayer, type Recorder, type TestContext,
} from '../helpers/fakeContext';

let ctx: TestContext;
let mgr: EnemyManager;
let ev: Recorder;
let player: FakePlayer;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function setup(opts: { players?: number; playerPos?: THREE.Vector3 } = {}): void {
  ctx = createFakeContext({ seed: 9001 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  const n = opts.players ?? 1;
  for (let i = 0; i < n; i++) {
    const p = createFakePlayer(`p${i + 1}`, (opts.playerPos ?? v(0, 0, 30)).clone().add(v(i * 2, 0, 0)), i === 0);
    ctx.players.add(p);
    if (i === 0) player = p;
  }
  ctx.player = player;
  mgr = new EnemyManager(ctx);
  ctx.enemies = mgr;
}

/** Advance the manager by `seconds` in fixed steps. */
function step(seconds: number, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) mgr.update(dt);
}

describe('spawning and scaling', () => {
  beforeEach(() => setup());

  it('spawnMob creates consistent state and emits enemy:spawned', () => {
    const g = mgr.spawnMob('grunt', v(5, 0, 5), 1);
    expect(g.state).toMatchObject({ kind: 'grunt', isBoss: false, tier: 1, alive: true, phase: 0 });
    expect(g.state.health).toBe(g.state.maxHealth);
    expect(g.state.maxHealth).toBe(60);
    expect(g.id).toBe(g.state.id);
    expect(g.state.position).toBe(g.position); // live vector doubles as state
    expect(mgr.list()).toContain(g);
    expect(mgr.get(g.id)).toBe(g);
    expect(ctx.scene.children).toContain(g.object);
    expect(ev.of('enemy:spawned')[0].enemy).toBe(g);
    expect(mgr.aliveCount()).toBe(1);
    expect(mgr.bossAlive()).toBe(false);
  });

  it('every mob kind spawns', () => {
    for (const k of ['grunt', 'spitter', 'bomber'] as const) {
      expect(mgr.spawnMob(k, v(0, 0, 0), 1).state.kind).toBe(k);
    }
  });

  it('health scales with tier', () => {
    for (const t of [1, 2, 5, 10]) {
      const g = mgr.spawnMob('grunt', v(0, 0, 0), t);
      expect(g.state.maxHealth).toBe(Math.round(60 * mobHealthMult(t)));
    }
    expect(mgr.spawnMob('grunt', v(0, 0, 0), 0).state.tier).toBe(1);
  });

  it('health scales with the player count', () => {
    setup({ players: 3 });
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 2);
    expect(g.state.maxHealth).toBe(Math.round(60 * mobHealthMult(2) * playerCountHealthMult(3)));
    const b = mgr.spawnBoss('brute', v(0, 0, 0), 2);
    expect(b.state.maxHealth).toBe(Math.round(1400 * bossHealthMult(2) * playerCountHealthMult(3)));
  });

  it("spawnBoss 'auto' rotates Brute → Summoner → Artillery by tier", () => {
    const kinds = [1, 2, 3, 4, 5, 6].map((t) => mgr.spawnBoss('auto', v(0, 0, -14), t).state.kind);
    expect(kinds).toEqual([...BOSS_ROTATION, ...BOSS_ROTATION]);
  });

  it('spawnBoss emits boss:spawned and an initial boss:health', () => {
    const b = mgr.spawnBoss('summoner', v(0, 0, -14), 1);
    expect(ev.of('boss:spawned')[0]).toMatchObject({ enemy: b, name: 'Veyra the Summoner' });
    expect(ev.of('boss:health')[0]).toEqual({ enemyId: b.id, health: b.state.maxHealth, maxHealth: b.state.maxHealth, phase: 0 });
    expect(b.isBoss).toBe(true);
    expect(mgr.bossAlive()).toBe(true);
  });

  it('spawn positions are resolved into the arena and onto the ground', () => {
    const g = mgr.spawnMob('grunt', v(100, 5, -100), 1);
    expect(Math.abs(g.position.x)).toBeLessThanOrEqual(32);
    expect(Math.abs(g.position.z)).toBeLessThanOrEqual(32);
    expect(g.position.y).toBe(0);
  });

  it('spawned enemies face the nearest player', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1); // player at (0,0,30): +Z
    expect(g.state.yaw).toBeCloseTo(0);
  });

  it('mobWeights: probabilities sum to 1 and shift away from grunts with tier', () => {
    for (const t of [1, 3, 6, 20]) {
      const w = mobWeights(t);
      expect(w.grunt + w.spitter + w.bomber).toBeCloseTo(1);
      expect(w.grunt).toBeGreaterThan(0);
    }
    expect(mobWeights(6).grunt).toBeLessThan(mobWeights(1).grunt);
  });

  it("'random' picks follow the tier weights roughly", () => {
    const counts = { grunt: 0, spitter: 0, bomber: 0 } as Record<string, number>;
    for (let i = 0; i < 600; i++) counts[mgr.spawnMob('random', v(0, 0, 0), 1).state.kind]++;
    expect(counts.grunt / 600).toBeGreaterThan(0.55);
    expect(counts.spitter).toBeGreaterThan(0);
    expect(counts.bomber).toBeGreaterThan(0);
  });

  it('clear() removes everything from the list and the scene', () => {
    const before = ctx.scene.children.length;
    mgr.spawnMob('grunt', v(0, 0, 0), 1);
    mgr.spawnBoss('summoner', v(0, 0, -10), 1);
    mgr.clear();
    expect(mgr.list()).toHaveLength(0);
    expect(ctx.scene.children.length).toBe(before);
  });
});

describe('damage and death', () => {
  beforeEach(() => setup());

  it('damage emits damage:dealt with attribution, crit and element', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    const pt = v(0, 1, 0);
    g.damage(10, { sourceId: 'p1', crit: true, element: 'fire', point: pt });
    expect(g.state.health).toBe(50);
    expect(ev.of('damage:dealt')[0]).toMatchObject({
      enemyId: g.id, playerId: 'p1', amount: 10, crit: true, element: 'fire', killed: false,
    });
    expect(ev.of('damage:dealt')[0].point.equals(pt)).toBe(true);
    expect(ev.of('damage:dealt')[0].point).not.toBe(pt);
  });

  it('ignores non-positive / NaN damage', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    g.damage(0);
    g.damage(-5);
    g.damage(NaN);
    expect(g.state.health).toBe(60);
    expect(ev.count('damage:dealt')).toBe(0);
  });

  it('lethal damage emits enemy:killed once with killerId, and the corpse ignores further hits', () => {
    const g = mgr.spawnMob('grunt', v(3, 0, 4), 2);
    g.damage(1000, { sourceId: 'p1' });
    expect(g.alive).toBe(false);
    expect(g.state.health).toBe(0);
    const k = ev.of('enemy:killed');
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ enemy: g, isBoss: false, tier: 2, killerId: 'p1' });
    expect(k[0].position.toArray()).toEqual([3, 0, 4]);
    expect(ev.of('damage:dealt')[0].killed).toBe(true);
    g.damage(10, { sourceId: 'p1' });
    expect(ev.count('enemy:killed')).toBe(1);
    expect(ev.count('damage:dealt')).toBe(1);
    expect(g.isCritPoint(v(3, 1.8, 4))).toBe(false);
  });

  it('dead mobs are removed from the list after the death animation (2 s)', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    g.damage(1000);
    step(1.9);
    expect(mgr.list()).toContain(g);
    expect(mgr.aliveCount()).toBe(0);
    step(0.2);
    expect(mgr.list()).not.toContain(g);
    expect(ctx.scene.children).not.toContain(g.object);
  });

  it('dead bosses linger 3 s', () => {
    const b = mgr.spawnBoss('brute', v(0, 0, -10), 1);
    b.damage(1e7);
    expect(mgr.bossAlive()).toBe(false);
    step(2.9);
    expect(mgr.list()).toContain(b);
    step(0.2);
    expect(mgr.list()).not.toContain(b);
  });

  it('mob head shots are crits, body shots are not; frozen makes everything a crit', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    mgr.update(0.016); // pose the rig
    g.object.updateMatrixWorld(true);
    expect(g.isCritPoint(v(0, g.height * 0.95, 0))).toBe(true);
    expect(g.isCritPoint(v(0, 0.8, 0))).toBe(false);
    g.state.frozen = 1;
    expect(g.isCritPoint(v(0, 0.2, 0))).toBe(true);
  });
});

describe('damage contract: applied amount + cause', () => {
  beforeEach(() => setup());

  it('damage() returns the health actually removed (overkill and dead targets excluded)', () => {
    const g = mgr.spawnMob('grunt', v(5, 0, 5), 1);
    expect(g.damage(20, { sourceId: 'p1' })).toBe(20);
    expect(g.damage(1000, { sourceId: 'p1' })).toBe(40); // 60 max health
    expect(g.alive).toBe(false);
    expect(g.damage(10, { sourceId: 'p1' })).toBe(0);
    expect(g.damage(-5)).toBe(0);
  });

  it('cause rides on damage:dealt and enemy:killed (default other, burn ticks status)', () => {
    const a = mgr.spawnMob('grunt', v(5, 0, 5), 1);
    a.damage(10, { sourceId: 'p1' });
    expect(ev.of('damage:dealt').at(-1)!.cause).toBe('other');
    a.damage(1e6, { sourceId: 'p1', cause: 'melee' });
    expect(ev.of('enemy:killed').at(-1)!.cause).toBe('melee');
    const b = mgr.spawnMob('grunt', v(-5, 0, 5), 1);
    b.applyStatus({ element: 'fire', remaining: 4, strength: 40, sourceId: 'p1' });
    step(1);
    expect(ev.of('damage:dealt').filter((d) => d.enemyId === b.id).every((d) => d.cause === 'status')).toBe(true);
  });

  it('the sponsor enemyHealthMult scales mobs and bosses at spawn (boss bar shows it)', () => {
    ctx.standing = { sponsors: { active: { enemyHealthMult: 1.5 } } } as unknown as TestContext['standing'];
    const g = mgr.spawnMob('grunt', v(5, 0, 5), 1);
    expect(g.state.maxHealth).toBe(90);
    expect(g.state.health).toBe(90);
    const boss = mgr.spawnBoss('brute', v(0, 0, -10), 1);
    const bar = ev.of('boss:health').at(-1)!;
    expect(bar.maxHealth).toBe(boss.state.maxHealth);
    ctx.standing = undefined;
    expect(mgr.spawnBoss('brute', v(0, 0, -12), 1).state.maxHealth).toBeCloseTo(boss.state.maxHealth / 1.5, -1);
  });
});

describe('damageRadius', () => {
  beforeEach(() => setup());

  it('linear falloff to 25 % at the edge, measured to the enemy surface', () => {
    const a = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    const b = mgr.spawnMob('grunt', v(3.5, 0, 0), 1);
    const c = mgr.spawnMob('grunt', v(10, 0, 0), 1);
    const n = mgr.damageRadius(v(0, 0, 0), 4, 40, { sourceId: 'p1' });
    expect(n).toBe(2);
    expect(a.state.maxHealth - a.state.health).toBeCloseTo(40);
    const d = 3.5 - b.radius;
    expect(b.state.maxHealth - b.state.health).toBeCloseTo(40 * (1 - 0.75 * (d / 4)));
    expect(c.state.health).toBe(c.state.maxHealth);
    expect(ev.of('damage:dealt').every((e) => e.playerId === 'p1')).toBe(true);
  });

  it('skips dead enemies and rejects bad radius/amount', () => {
    const a = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    a.damage(1000);
    expect(mgr.damageRadius(v(0, 0, 0), 5, 50)).toBe(0);
    mgr.spawnMob('grunt', v(1, 0, 0), 1);
    expect(mgr.damageRadius(v(0, 0, 0), 0, 50)).toBe(0);
    expect(mgr.damageRadius(v(0, 0, 0), 5, 0)).toBe(0);
  });

  it('uses the vertical extent of the enemy (explosion above the head)', () => {
    const a = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    expect(mgr.damageRadius(v(0, a.height + 1, 0), 1.5, 30)).toBe(1);
    expect(mgr.damageRadius(v(0, a.height + 3, 0), 1.5, 30)).toBe(0); // out of reach
  });
});

describe('status effects', () => {
  beforeEach(() => setup({ players: 0 }));

  it('fire burns in 0.4 s ticks of strength·0.4 until it expires', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1) as BaseEnemy;
    g.applyStatus({ element: 'fire', remaining: 2, strength: 10, sourceId: 'p1' });
    expect(g.state.statuses.map((s) => s.element)).toEqual(['fire']);
    step(1.0, 0.1);
    const ticks1 = ev.of('damage:dealt').filter((e) => e.element === 'fire');
    expect(ticks1.length).toBe(2);
    expect(ticks1[0].amount).toBeCloseTo(4);
    expect(ticks1[0].playerId).toBe('p1');
    step(3, 0.1);
    const total = ev.of('damage:dealt').filter((e) => e.element === 'fire').length;
    expect(total).toBe(5);
    expect(g.state.statuses).toHaveLength(0);
    expect(g.state.health).toBeCloseTo(60 - 20);
  });

  it('a burn tick can kill and credits the burner', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    g.damage(58);
    g.applyStatus({ element: 'fire', remaining: 4, strength: 10, sourceId: 'p7' });
    step(0.5, 0.1);
    expect(g.alive).toBe(false);
    expect(ev.of('enemy:killed')[0].killerId).toBe('p7');
  });

  it('elemental hits with applyStatus apply the matching status', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    g.damage(5, { element: 'fire', applyStatus: true, sourceId: 'p1' });
    g.damage(5, { element: 'ice', applyStatus: true, sourceId: 'p1' });
    expect(g.state.statuses.map((s) => s.element).sort()).toEqual(['fire', 'ice']);
    const before = g.state.statuses.length;
    g.damage(5, { element: 'fire', applyStatus: false });
    expect(g.state.statuses.length).toBe(before);
  });

  it('ice slows, and the third application within the window freezes', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1) as BaseEnemy;
    const ice = { element: 'ice' as const, remaining: 3, strength: 0.35 };
    g.applyStatus(ice);
    expect(g.state.statuses.find((s) => s.element === 'ice')!.strength).toBeCloseTo(0.35);
    expect(g.state.frozen).toBe(0);
    g.applyStatus(ice);
    expect(g.state.frozen).toBe(0);
    g.applyStatus(ice);
    expect(g.state.frozen).toBe(2);
    expect(g.state.iceStacks).toBe(0);
    expect(g.isCritPoint(v(0, 0.1, 0))).toBe(true); // shatter crit
    step(2.1);
    expect(g.state.frozen).toBe(0);
  });

  it('ice stacks reset once the 4 s window lapses', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    const ice = { element: 'ice' as const, remaining: 3, strength: 0.35 };
    g.applyStatus(ice);
    g.applyStatus(ice);
    step(4.2);
    g.applyStatus(ice);
    expect(g.state.frozen).toBe(0);
  });

  it('frozen bosses thaw faster (1 s)', () => {
    const b = mgr.spawnBoss('brute', v(0, 0, -10), 1);
    for (let i = 0; i < 3; i++) b.applyStatus({ element: 'ice', remaining: 3, strength: 0.35 });
    expect(b.state.frozen).toBe(1);
  });

  it('ice slows movement towards a player', () => {
    setup({ players: 1, playerPos: v(0, 0, 25) });
    const a = mgr.spawnMob('grunt', v(-6, 0, 0), 1);
    const b = mgr.spawnMob('grunt', v(6, 0, 0), 1);
    b.applyStatus({ element: 'ice', remaining: 10, strength: 0.6 });
    step(1.0);
    const da = a.position.distanceTo(v(-6, 0, 0));
    const db = b.position.distanceTo(v(6, 0, 0));
    expect(da).toBeGreaterThan(2);
    expect(db).toBeLessThan(da * 0.7);
  });

  it('shock stuns mobs and chains 30 % of the hit to the nearest other enemy within 6 m', () => {
    const a = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    const b = mgr.spawnMob('grunt', v(3, 0, 0), 1);
    const far = mgr.spawnMob('grunt', v(0, 0, 15), 1);
    a.damage(20, { element: 'shock', applyStatus: true, sourceId: 'p1' });
    expect(a.state.maxHealth - a.state.health).toBeCloseTo(20);
    expect(b.state.maxHealth - b.state.health).toBeCloseTo(6);
    expect(far.state.health).toBe(far.state.maxHealth);
    expect(a.state.stun).toBeGreaterThan(0);
    expect(b.state.stun).toBeGreaterThan(0);
    expect(b.state.statuses.some((s) => s.element === 'shock')).toBe(true);
    expect(ctx.fx.count('tracer')).toBeGreaterThan(0);
    const chained = ev.of('damage:dealt').find((e) => e.enemyId === b.id)!;
    expect(chained.playerId).toBe('p1');
    expect(chained.element).toBe('shock');
  });

  it('applyStatus with element none is a no-op; dead enemies take no status', () => {
    const g = mgr.spawnMob('grunt', v(0, 0, 0), 1);
    g.applyStatus({ element: 'none', remaining: 3, strength: 1 });
    expect(g.state.statuses).toHaveLength(0);
    g.damage(1000);
    g.applyStatus({ element: 'fire', remaining: 3, strength: 1 });
    expect(g.state.statuses).toHaveLength(0);
  });
});

describe('bosses', () => {
  beforeEach(() => setup());

  it('weak point hits are crits, feet are not', () => {
    for (const k of BOSS_ROTATION) {
      const b = mgr.spawnBoss(k, v(0, 0, -10), 1) as unknown as Brute;
      mgr.update(0.016);
      const wp = b.weakPoint(new THREE.Vector3());
      expect(b.isCritPoint(wp), k).toBe(true);
      expect(b.isCritPoint(v(b.position.x + 0.1, 0.05, b.position.z + 3)), k).toBe(false);
      mgr.clear();
    }
  });

  it('boss phases advance at 66 % and 33 % with boss:phase and boss:health on every hit', () => {
    const b = mgr.spawnBoss('brute', v(0, 0, -10), 1);
    const max = b.state.maxHealth;
    ev.clear();
    b.damage(max * (1 - PHASE_THRESHOLDS[0]) + 1);
    expect(b.state.phase).toBe(1);
    b.damage(10);
    expect(b.state.phase).toBe(1);
    b.damage(max * 0.5);
    expect(b.state.phase).toBe(2);
    expect(ev.of('boss:phase').map((e) => e.phase)).toEqual([1, 2]);
    expect(ev.count('boss:health')).toBe(3);
    expect(ev.of('boss:health').at(-1)!.health).toBe(b.state.health);
  });

  it('a single huge hit skips straight to phase 2 (both events fire)', () => {
    const b = mgr.spawnBoss('brute', v(0, 0, -10), 1);
    b.damage(b.state.maxHealth * 0.8);
    expect(ev.of('boss:phase').map((e) => e.phase)).toEqual([1, 2]);
  });

  it('brute: a stunned brute takes crits anywhere', () => {
    const b = mgr.spawnBoss('brute', v(0, 0, -10), 1) as unknown as Brute;
    const feet = v(b.position.x, 0.1, b.position.z + 1.5);
    expect(b.isCritPoint(feet)).toBe(false);
    b.state.mode = 'stunned';
    expect(b.isCritPoint(feet)).toBe(true);
  });

  it('brute: charging into a wall stuns it', () => {
    setup({ playerPos: v(0, 0, 0) });
    ctx.world = createFlatWorld(() => ctx.rng(), [[-5, 0, -20.5, 5, 3, -19.5]]); // wall behind the brute
    mgr = new EnemyManager(ctx);
    const b = mgr.spawnBoss('brute', v(0, 0, -16), 1) as unknown as Brute;
    // force a charge away from the player into the wall
    b.state.mode = 'charge';
    b.state.timer = 2;
    b.state.chargeDir = { x: 0, y: 0, z: -1 };
    b.state.yaw = Math.PI;
    let stunned = false;
    for (let i = 0; i < 60 && !stunned; i++) {
      mgr.update(0.02);
      stunned = (b.state.mode as string) === 'stunned';
    }
    expect(stunned).toBe(true);
    expect(b.isCritPoint(v(b.position.x, 0.2, b.position.z))).toBe(true);
  });

  it('summoner: losing 25 % raises a 4 s shield; shielded hits do nothing; then the next threshold', () => {
    const s = mgr.spawnBoss('summoner', v(0, 0, -10), 1) as unknown as Summoner;
    const max = s.state.maxHealth;
    s.damage(max); // capped at the 75 % threshold
    expect(s.state.health).toBeCloseTo(max * 0.75);
    expect(s.alive).toBe(true);
    expect(s.state.shield).toBeGreaterThan(0);
    ev.clear();
    s.damage(100);
    expect(s.state.health).toBeCloseTo(max * 0.75);
    expect(ev.count('damage:dealt')).toBe(0);
    // statuses are ignored while immune
    s.applyStatus({ element: 'fire', remaining: 3, strength: 10 });
    expect(s.state.statuses).toHaveLength(0);
    step(4.1);
    expect(s.state.shield).toBe(0);
    s.damage(max);
    expect(s.state.health).toBeCloseTo(max * 0.5);
    expect(s.state.shield).toBeGreaterThan(0);
  });

  it('summoner: after the last shield (25 %) it can be killed', () => {
    const s = mgr.spawnBoss('summoner', v(0, 0, -10), 1) as unknown as Summoner;
    for (let i = 0; i < 3; i++) {
      s.damage(s.state.maxHealth);
      s.state.shield = 0; // skip the waiting
    }
    expect(s.state.health).toBeCloseTo(s.state.maxHealth * 0.25);
    s.damage(s.state.maxHealth);
    expect(s.alive).toBe(false);
    expect(ev.of('enemy:killed').at(-1)!.isBoss).toBe(true);
  });

  it('summoner summons grunts of its tier', () => {
    setup({ playerPos: v(0, 0, 4) });
    const s = mgr.spawnBoss('summoner', v(0, 0, -10), 3);
    step(6);
    const grunts = mgr.list().filter((e) => e.state.kind === 'grunt');
    expect(grunts.length).toBeGreaterThanOrEqual(3);
    expect(grunts.every((g) => g.state.tier === 3)).toBe(true);
    expect(s.alive).toBe(true);
  });

  it('artillery: half damage off the weak point, full damage on it', () => {
    const a = mgr.spawnBoss('artillery', v(0, 0, -10), 1) as unknown as Artillery;
    mgr.update(0.016);
    const max = a.state.maxHealth;
    a.damage(100, { point: v(a.position.x, 0.2, a.position.z) });
    expect(max - a.state.health).toBeCloseTo(50);
    a.damage(100, { point: a.weakPoint(new THREE.Vector3()) });
    expect(max - a.state.health).toBeCloseTo(150);
    a.damage(100); // no point → armoured
    expect(max - a.state.health).toBeCloseTo(200);
  });
});

describe('AI smoke', () => {
  it('a grunt next to a player eventually hurts them', () => {
    setup({ playerPos: v(0, 0, 0) });
    mgr.spawnMob('grunt', v(0, 0, 3), 1);
    step(3);
    expect(player.calls.some((c) => c.method === 'takeDamage')).toBe(true);
    const dmg = player.calls.find((c) => c.method === 'takeDamage')!;
    expect((dmg.args[1] as { sourceId: string }).sourceId).toMatch(/^mob_/);
  });

  it('enemies with no living player idle without throwing', () => {
    setup({ players: 0 });
    for (const k of ['grunt', 'spitter', 'bomber'] as const) mgr.spawnMob(k, v(0, 0, 0), 1);
    for (const k of BOSS_ROTATION) mgr.spawnBoss(k, v(10, 0, 0), 1);
    expect(() => step(5)).not.toThrow();
  });

  it('every enemy kind runs 10 s against a player without NaNs', () => {
    setup({ playerPos: v(0, 0, 10) });
    for (const k of ['grunt', 'spitter', 'bomber'] as const) mgr.spawnMob(k, v(-10, 0, -10), 3);
    for (const k of BOSS_ROTATION) mgr.spawnBoss(k, v(10, 0, -10), 3);
    step(10);
    for (const e of mgr.list()) {
      expect(Number.isFinite(e.position.x) && Number.isFinite(e.position.z)).toBe(true);
    }
  });
});
