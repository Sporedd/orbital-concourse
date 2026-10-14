/**
 * Live skill effects (src/progression/effects.ts) against the fake context: kill/hit listeners,
 * timed buffs, read-time modifiers and the active abilities.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DamageCause, Enemy, EnemyRegistry, GameContext } from '@/core/types';
import { createProgression, type ClassId, type ClassProgression } from '@/progression';
import { AMMO_PICKUP } from '@/loot';
import {
  callsOf, createFakeContext, createFakeEnemy, createFakePlayer, type FakeEnemy, type FakePlayer, type TestContext,
} from '../helpers/fakeContext';

let ctx: TestContext;
let prog: ClassProgression;
let player: FakePlayer;
let enemies: FakeEnemy[];
let radius: ReturnType<typeof vi.fn>;

function boot(classId: ClassId): void {
  vi.useFakeTimers();
  ctx = createFakeContext();
  player = createFakePlayer('p1');
  ctx.player = player;
  enemies = [];
  radius = vi.fn(() => 1);
  ctx.enemies = {
    list: () => enemies,
    get: (id: string) => enemies.find((e) => e.id === id),
    damageRadius: radius,
    bossAlive: () => enemies.some((e) => e.isBoss && e.alive),
  } as unknown as EnemyRegistry;
  prog = createProgression(ctx);
  prog.addXp(1e6);
  prog.setClass(classId);
}

function buy(id: string, times = 1): void {
  for (let i = 0; i < times; i++) expect(prog.upgrade(id), `${id}: ${prog.lockReason(id)}`).toBe(true);
}

const kill = (cause: DamageCause = 'bullet', pos = new THREE.Vector3(0, 0, -3), isBoss = false) =>
  ctx.events.emit('enemy:killed', { enemy: { id: 'e_dead' } as Enemy, position: pos, isBoss, tier: 1, killerId: 'p1', cause });

describe('skill effects', () => {
  beforeEach(() => vi.useRealTimers());

  it('Crowd Work: melee kills refund a grenade on a cooldown', () => {
    boot('vanguard');
    buy('van_knuckles', 3);
    buy('van_crowd_work');
    player.grenades = 0;
    kill('melee');
    expect(player.grenades).toBe(1);
    kill('melee'); // same instant: cooldown
    expect(player.grenades).toBe(1);
    kill('bullet'); // not a melee kill
    ctx.time.elapsed = 5;
    kill('melee');
    expect(player.grenades).toBe(2);
    expect(prog.activeAbility!.unlocked).toBe(true); // a keystone unlocks the active
  });

  it('Finisher heals on melee kills only', () => {
    boot('vanguard');
    buy('van_heavy_hands');
    buy('van_knuckles', 2);
    buy('van_finisher', 2);
    player.health = 50;
    kill('bullet');
    expect(player.health).toBe(50);
    kill('melee');
    expect(player.health).toBeCloseTo(50 + 100 * 0.1);
  });

  it('Heavy Hands bridges the melee bonus as a follow-up hit; Executioner finishes low targets', () => {
    boot('vanguard');
    buy('van_heavy_hands', 3);
    buy('van_knuckles', 3);
    buy('van_crowd_work');
    buy('van_executioner');
    const e = createFakeEnemy('e1', new THREE.Vector3(0, 0, -2), 99, 100);
    enemies.push(e);
    const emitHit = (amount: number) => ctx.events.emit('damage:dealt', {
      enemyId: 'e1', playerId: 'p1', amount, crit: false, element: 'none', point: new THREE.Vector3(), killed: false, cause: 'melee',
    });
    e.health = 90;
    emitHit(10);
    expect(e.hits[0].amount).toBeCloseTo(10 * 0.45); // +45% at rank 3
    expect(e.hits[0].opts?.cause).toBe('melee');
    e.health = 20; // below 25 %: Executioner finishes it
    e.state.health = 20;
    emitHit(10);
    expect(e.health).toBeLessThanOrEqual(0);
  });

  it('Bloodlust: kills buff fire rate for 4 s', () => {
    boot('vanguard');
    buy('van_brute_force', 3);
    buy('van_bloodlust', 2);
    const base = prog.stats.fireRateMult;
    kill();
    expect(prog.stats.fireRateMult).toBeCloseTo(base * 1.08);
    ctx.time.elapsed = 4.5;
    expect(prog.stats.fireRateMult).toBeCloseTo(base);
  });

  it('Overcharge Cell snaps a broken shield back to 40 % (15 s cooldown)', () => {
    boot('vanguard');
    buy('van_plating', 3);
    buy('van_overcharge');
    player.shield = 0;
    ctx.events.emit('player:shield', { playerId: 'p1', shield: 0, maxShield: player.maxShield, broken: true });
    expect(player.shield).toBeCloseTo(player.maxShield * 0.4);
    player.shield = 0;
    ctx.events.emit('player:shield', { playerId: 'p1', shield: 0, maxShield: player.maxShield, broken: true });
    expect(player.shield).toBe(0);
  });

  it('Last Stand is a read-time modifier on low health', () => {
    boot('vanguard');
    buy('van_brute_force', 3);
    buy('van_bloodlust', 3);
    buy('van_last_stand', 2);
    const full = prog.stats.damageMult;
    player.health = 30;
    expect(prog.stats.damageMult).toBeCloseTo(full * 1.2);
  });

  it('Bullseye puts a round back on a crit, once per shot', () => {
    boot('marksman');
    buy('mar_calibre', 3);
    buy('mar_bullseye');
    player.weapons[0] = { magSize: 12 } as never;
    player.ammo = 5;
    const crit = () => ctx.events.emit('damage:dealt', {
      enemyId: 'x', playerId: 'p1', amount: 10, crit: true, element: 'none', point: new THREE.Vector3(), killed: false, cause: 'bullet',
    });
    crit();
    crit();
    expect(player.ammo).toBe(6);
    ctx.events.emit('weapon:fired', { playerId: 'p1', weapon: {} as never, origin: new THREE.Vector3(), direction: new THREE.Vector3(), hits: 2 });
    crit();
    expect(player.ammo).toBe(7);
  });

  it('Trophy Hunter adds 50 % to boss standing', () => {
    boot('marksman');
    buy('mar_light_step', 3);
    buy('mar_vantage');
    buy('mar_trophy');
    const award = vi.fn();
    (ctx as Partial<GameContext>).standing = { standing: { award } } as never;
    ctx.events.emit('standing:gained', { amount: 200, standing: 200, rank: {} as never, reason: 'boss', label: 'Headliner down' });
    expect(award).toHaveBeenCalledWith(100, 'skill', 'Trophy Hunter', true);
    award.mockClear();
    ctx.events.emit('standing:gained', { amount: 100, standing: 300, rank: {} as never, reason: 'skill', label: 'Trophy Hunter' });
    expect(award).not.toHaveBeenCalled(); // no recursion
  });

  it('Scrounger tops up ammo pickups', () => {
    boot('technician');
    buy('tec_scrounger', 2);
    ctx.events.emit('loot:pickup', { playerId: 'p1', item: { kind: 'ammo' } as never });
    expect(callsOf(player, 'addAmmo')[0].args[0]).toBeCloseTo(AMMO_PICKUP * 0.4);
  });

  it('Shock Pulse: the active hits everything in 8 m, restores shield and goes on cooldown', () => {
    boot('technician');
    buy('tec_scrounger', 3);
    buy('tec_field_medic');
    buy('tec_salvage');
    player.shield = 0;
    expect(prog.useActive()).toBe(true);
    expect(radius).toHaveBeenCalledTimes(1);
    const [, r, , opts] = radius.mock.calls[0];
    expect(r).toBe(8);
    expect(opts).toMatchObject({ element: 'shock', applyStatus: true, sourceId: 'p1' });
    expect(player.shield).toBeCloseTo(player.maxShield * 0.25);
    expect(prog.useActive()).toBe(false);
    expect(prog.activeAbility!.cooldownLeft).toBeCloseTo(14);
    ctx.time.elapsed = 15;
    expect(prog.activeAbility!.ready).toBe(true);
  });

  it('Encore refills the magazine, buffs fire rate and doubles hype gains', () => {
    boot('showman');
    buy('sho_footwork', 3);
    buy('sho_in_your_face');
    buy('sho_point_blank');
    const add = vi.fn();
    (ctx as Partial<GameContext>).standing = { hype: { add, tier: 'cold' } } as never;
    player.weapons[0] = { magSize: 30 } as never;
    player.ammo = 3;
    const fr = prog.stats.fireRateMult;
    expect(prog.useActive()).toBe(true);
    expect(player.ammo).toBe(1e9); // fake player has no clamp; the real setter clamps to the mag
    expect(prog.stats.fireRateMult).toBeCloseTo(fr * 1.2);
    ctx.events.emit('hype:reaction', { reason: 'multi_kill', label: 'TRIPLE KILL', amount: 10, value: 50 });
    // identity +10 % and Encore +100 %
    expect(add).toHaveBeenCalledWith(expect.closeTo(11, 5), 'multi_kill', '');
  });

  it('game:started clears buffs and cooldowns', () => {
    boot('vanguard');
    buy('van_brute_force', 3);
    buy('van_bloodlust', 1);
    const base = prog.stats.fireRateMult;
    kill();
    expect(prog.stats.fireRateMult).toBeGreaterThan(base);
    ctx.events.emit('game:started', {});
    expect(prog.stats.fireRateMult).toBeCloseTo(base);
  });
});
