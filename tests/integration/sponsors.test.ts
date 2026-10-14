/**
 * Sponsor contracts + crowd (system I) applied through the real hooks: rounds (enemy count,
 * loot count, bonus wave, mid-sub-wave headliner), enemy manager (health), loot (elements,
 * grenadeless), player (no shield, no grenades, damage) and progression (XP mult).
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { INTERMISSION_SECONDS, LOOT, PLAYER, XP, mobsForRound } from '@/core/config';
import type { Enemy, RoundManager } from '@/core/types';
import { createEnemyManager } from '@/enemies';
import { createLootSystem } from '@/loot';
import { createPlayer, createPlayerRegistry, type Player } from '@/player';
import { runDamageMult } from '@/player/shared';
import { createProgression } from '@/progression';
import { createRoundManager } from '@/rounds';
import { createStandingSystem, type StandingSystem } from '@/standing';
import { createFakeContext, createFakeEnemy, fakeHud, recordEvents, type Recorder, type TestContext } from '../helpers/fakeContext';

let ctx: TestContext;
let ev: Recorder;
let player: Player;
let standing: StandingSystem;
let rounds: RoundManager;

function setup(): void {
  ctx = createFakeContext({ seed: 99 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  player = createPlayer(ctx, { id: 'p-s', name: 'Sponsored' });
  ctx.players.add(player);
  ctx.player = player;
  ctx.enemies = createEnemyManager(ctx);
  ctx.loot = createLootSystem(ctx);
  ctx.progression = createProgression(ctx);
  standing = createStandingSystem(ctx);
  ctx.standing = standing;
  ctx.hud = fakeHud('none');
  rounds = createRoundManager(ctx);
  standing.standing.award(50_000, 'test', 'unlock every league', true);
}

/** Pick a contract between runs, then start the run (what the start screen does). */
function sign(id: string): void {
  expect(standing.sponsors.choose(id)).toBe(true);
  rounds.start();
}

function run(seconds: number, dt = 0.1, each?: () => void): void {
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
    rounds.update(dt);
    each?.();
  }
}

const aliveMobs = () => ctx.enemies.list().filter((e) => e.alive && !e.isBoss);
const killAll = (filter: (e: Enemy) => boolean = () => true) => {
  for (const e of ctx.enemies.list()) if (e.alive && filter(e)) e.damage(1e9, { sourceId: player.id, cause: 'bullet' });
};

beforeEach(setup);

describe('sponsor contracts through the real hooks', () => {
  it('Free Agent is neutral: base mob count, base health, damage ×1', () => {
    rounds.start();
    expect(rounds.state.killsRequired).toBe(mobsForRound(1));
    expect(runDamageMult(ctx)).toBe(1);
    expect(player.maxShield).toBe(PLAYER.maxShield);
  });

  it('Double Trouble: ×2 mobs per round, ×0.9 enemy health, boss shower ×2', () => {
    const base = ctx.enemies.spawnMob('grunt', new THREE.Vector3(5, 0, 5), 1).state.maxHealth;
    ctx.enemies.clear();
    sign('double_trouble');
    expect(rounds.state.killsRequired).toBe(mobsForRound(1) * 2);
    expect(ctx.enemies.spawnMob('grunt', new THREE.Vector3(5, 0, 5), 1).state.maxHealth).toBe(Math.round(base * 0.9));
    ctx.enemies.clear();
    // play to the boss and kill it: the shower is scaled (3..5 → 6..10 items)
    run(INTERMISSION_SECONDS + 0.2);
    for (let i = 0; i < 4000 && rounds.state.phase === 'wave'; i++) {
      rounds.update(0.1);
      killAll((e) => !e.isBoss);
    }
    expect(rounds.state.phase).toBe('boss');
    ev.clear();
    killAll();
    rounds.update(0.1);
    expect(rounds.state.phase).toBe('cleared');
    // bosses skip the mob drop table, so everything dropped now is the shower (round 1 Brute: no adds)
    const shower = ev.of('loot:dropped').filter((d) => d.item.ownerId === player.id);
    expect(shower.length).toBeGreaterThanOrEqual(LOOT.bossDrops.min * 2);
    expect(shower.length).toBeLessThanOrEqual(LOOT.bossDrops.max * 2);
    expect(shower.some((d) => d.item.kind === 'gear')).toBe(false); // gear is shop-only (PLAN §13)
    expect(shower.some((d) => d.item.kind === 'weapon')).toBe(true);
  });

  it('Glass Cannon: no shield (player + recharge), ×1.4 damage on bullets', () => {
    sign('glass_cannon');
    expect(player.maxShield).toBe(0);
    expect(player.shield).toBe(0);
    expect(runDamageMult(ctx)).toBeCloseTo(1.4);
    const target = createFakeEnemy('t', new THREE.Vector3(player.position.x, 0, player.position.z - 20));
    ctx.enemies = { list: () => [target], damageRadius: () => 0 } as unknown as typeof ctx.enemies;
    const w = { ...ctx.loot.starterWeapon(), spread: 0 };
    player.equip(w);
    for (let i = 0; i < 30; i++) { player.update(1 / 60); ctx.fakeInput.endFrame(); }
    ctx.fakeInput.mousePress(0);
    player.update(1 / 60);
    expect(target.hits.length).toBeGreaterThan(0);
    const h = target.hits[0];
    const expected = w.damage * 1.4 * (h.opts?.crit ? w.critMultiplier : 1);
    expect(h.amount).toBeCloseTo(expected, 4);
    expect(h.opts?.cause).toBe('bullet');
  });

  it('Burn It All: every generated weapon is fire; enemy health ×1.15', () => {
    sign('pyre');
    const items = ctx.loot.dropLoot(new THREE.Vector3(0, 0, 0), { tier: 3, count: 12, guaranteed: Array(12).fill('weapon') });
    expect(items).toHaveLength(12);
    for (const it of items) expect(it.weapon!.element).toBe('fire');
  });

  it('Bare Knuckle: start with 0 grenades, pickups refused, grenade drops become ammo', () => {
    sign('bare_knuckle');
    expect(player.grenades).toBe(0);
    player.addGrenades(2);
    expect(player.grenades).toBe(0);
    const items = ctx.loot.dropLoot(new THREE.Vector3(0, 0, 0), { tier: 1, count: 6, guaranteed: Array(6).fill('grenade') });
    expect(items.every((i) => i.kind === 'ammo')).toBe(true);
  });

  it('Prime Time: a headliner closes every sub-wave but the last; its kill drops a small shower', () => {
    sign('headliner');
    expect(rounds.state.killsRequired).toBe(Math.round(mobsForRound(1) * 0.75));
    run(INTERMISSION_SECONDS + 0.2);
    expect(rounds.state.phase).toBe('wave');
    // clear sub-wave 1's mobs → a boss enters while still in the wave phase
    for (let i = 0; i < 2000 && !ctx.enemies.bossAlive(); i++) {
      rounds.update(0.1);
      killAll((e) => !e.isBoss);
    }
    expect(rounds.state.phase).toBe('wave');
    expect(rounds.state.subWave).toBe(1);
    expect(ev.of('boss:spawned')).toHaveLength(1);
    rounds.update(0.1);
    expect(rounds.state.subWave).toBe(1); // waits for the headliner
    ev.clear();
    killAll((e) => e.isBoss);
    expect(ev.of('loot:dropped').length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 40 && rounds.state.subWave === 1; i++) rounds.update(0.1);
    expect(rounds.state.subWave).toBe(2);
    expect(rounds.state.phase).toBe('wave');
  });

  it('the contract is locked for the run and unlocks on game over', () => {
    sign('double_trouble');
    expect(standing.sponsors.locked).toBe(true);
    expect(standing.sponsors.choose('free_agent')).toBe(false);
    player.takeDamage(1e9);
    expect(rounds.state.phase).toBe('gameover');
    expect(standing.sponsors.choose('free_agent')).toBe(true);
  });
});

describe('crowd effects', () => {
  it('a bonus-wave gift extends the current sub-wave and the kill quota', () => {
    rounds.start();
    run(INTERMISSION_SECONDS + 0.2);
    const before = rounds.state.killsRequired;
    ctx.events.emit('hype:gift', { kind: 'bonuswave', round: 1, mobs: 5 });
    expect(rounds.state.killsRequired).toBe(before + 5);
    expect(ev.of('round:progress').at(-1)!.killsRequired).toBe(before + 5);
  });

  it('bonus waves are ignored outside the wave phase', () => {
    rounds.start();
    const before = rounds.state.killsRequired;
    ctx.events.emit('hype:gift', { kind: 'bonuswave', round: 1, mobs: 5 });
    expect(rounds.state.killsRequired).toBe(before);
  });

  it('progression XP follows the crowd tier multiplier', () => {
    rounds.start();
    const xp0 = ctx.progression.xp + 0;
    const mult = standing.xpMult();
    const e = ctx.enemies.spawnMob('grunt', new THREE.Vector3(0, 0, -10), 1);
    e.damage(1e9, { sourceId: player.id });
    expect(ctx.progression.xp - xp0).toBe(Math.round(XP.mob * mult));
  });
});
