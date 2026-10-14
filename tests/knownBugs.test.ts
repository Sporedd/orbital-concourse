/**
 * Known bugs, written as `it.fails`: each test asserts the CORRECT behaviour and is expected
 * to fail today. When someone fixes the bug the test starts passing, which makes `it.fails`
 * report it — then change `it.fails` to `it` and delete the entry in tests/FINDINGS.md.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { DamageOpts, EnemyRegistry } from '@/core/types';
import { EnemyManager } from '@/enemies';
import { PERKS, starterWeapon } from '@/loot/weapons';
import { createPlayer, createPlayerRegistry } from '@/player';
import { createProgression } from '@/progression';
import { createFakeContext, createFakeEnemy, createFakePlayer, fakeProgression } from './helpers/fakeContext';

describe('known bugs (see tests/FINDINGS.md)', () => {
  it('FINDINGS #1: a bomber that blows itself up on the player grants no XP', () => {
    const ctx = createFakeContext();
    ctx.players = createPlayerRegistry();
    const p = createFakePlayer('p1', new THREE.Vector3(0, 0, 0));
    ctx.players.add(p);
    ctx.player = p;
    const mgr = new EnemyManager(ctx);
    ctx.enemies = mgr;
    const prog = createProgression(ctx);
    mgr.spawnMob('bomber', new THREE.Vector3(0, 0, 2.5), 1);
    for (let i = 0; i < 120; i++) mgr.update(1 / 60);
    expect(p.health).toBeLessThan(100); // it did explode on us
    expect(prog.xp).toBe(0);
  });

  it('FINDINGS #2: crit_refund does not refund ammo when the hit was blocked (immune target)', () => {
    const ctx = createFakeContext();
    ctx.players = createPlayerRegistry();
    ctx.progression = fakeProgression();
    const player = createPlayer(ctx, { id: 'p1', name: 'T' });
    ctx.players.add(player);
    ctx.player = player;
    // an immune target (e.g. a shielded Summoner): damage() is swallowed, every point is its core
    const e = createFakeEnemy('shielded', new THREE.Vector3(0, 0, 20), 0);
    e.damage = (_a: number, _o?: DamageOpts) => 0; // swallowed: nothing applied
    ctx.enemies = { list: () => [e], damageRadius: () => 0 } as unknown as EnemyRegistry;
    const w = { ...starterWeapon((x) => `${x}_1`), spread: 0, perks: [{ ...PERKS.find((x) => x.id === 'crit_refund')! }] };
    player.equip(w);
    for (let i = 0; i < 30; i++) { player.update(1 / 60); ctx.fakeInput.endFrame(); }
    ctx.fakeInput.mousePress(0);
    player.update(1 / 60);
    expect(player.ammo).toBe(w.magSize - 1);
  });
});
