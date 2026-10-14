import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAYER } from '@/core/config';
import type { DamageOpts, EnemyRegistry, PlayerStats, WeaponDef, WeaponPerk } from '@/core/types';
import { EnemyManager } from '@/enemies';
import { PERKS, generateWeapon, starterWeapon } from '@/loot/weapons';
import { createPlayer, createPlayerRegistry, type Player } from '@/player';
import { Controller } from '@/player/controller';
import { Viewmodel } from '@/player/viewmodel';
import { createRng } from '@/core/rng';
import {
  createFakeContext, createFakeEnemy, createFlatWorld, fakeProgression, recordEvents, type FakeEnemy, type Recorder, type TestContext,
} from '../helpers/fakeContext';

// ---------------------------------------------------------------------------
let ctx: TestContext;
let player: Player;
let ev: Recorder;
let targets: FakeEnemy[];
let radiusCalls: { center: THREE.Vector3; radius: number; amount: number; opts?: DamageOpts }[];
let ids = 0;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const nextId = (p: string) => `${p}_t${++ids}`;
const perk = (id: string): WeaponPerk => ({ ...PERKS.find((p) => p.id === id)! });

/** Deterministic weapon: zero spread, everything else from the pistol unless overridden. */
function weapon(over: Partial<WeaponDef> = {}): WeaponDef {
  return { ...starterWeapon(nextId), spread: 0, ...over, id: nextId('w') };
}

function setup(stats: Partial<PlayerStats> = {}, seed = 1): void {
  ctx = createFakeContext({ seed });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  ctx.progression = fakeProgression(stats);
  player = createPlayer(ctx, { id: 'p1', name: 'Tester' });
  ctx.players.add(player);
  ctx.player = player;
  targets = [];
  radiusCalls = [];
  ctx.enemies = {
    list: () => targets,
    get: (id: string) => targets.find((t) => t.id === id),
    damageRadius: (center: THREE.Vector3, radius: number, amount: number, opts?: DamageOpts) => {
      radiusCalls.push({ center: center.clone(), radius, amount, opts });
      return 0;
    },
    aliveCount: () => targets.filter((t) => t.alive).length,
    bossAlive: () => false,
    spawnMob: () => { throw new Error('n/a'); },
    spawnBoss: () => { throw new Error('n/a'); },
    clear: () => { targets = []; },
    update: () => {},
  } as unknown as EnemyRegistry;
}

/** One game frame for the player (main.ts order: update, then input.endFrame). */
function frame(dt = 1 / 60): void {
  player.update(dt);
  ctx.fakeInput.endFrame();
}
function frames(seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) frame(dt);
}

/** Equip and wait for the swap animation so the gun can fire. */
function ready(w: WeaponDef): WeaponDef {
  player.equip(w);
  frames(0.5);
  return w;
}

function click(): void {
  ctx.fakeInput.mousePress(0);
  frame();
  ctx.fakeInput.mouseRelease(0);
}

/** Fake enemy 6 m in front of the start position (player faces -Z from z = 26). */
function enemyAhead(critAbove = 10, x = 0, z = 20): FakeEnemy {
  const e = createFakeEnemy(`e${targets.length + 1}`, v(x, 0, z), critAbove);
  targets.push(e);
  return e;
}

beforeEach(() => setup());

// ---------------------------------------------------------------------------
describe('player health & shield', () => {
  it('starts full at playerStart, facing the arena centre', () => {
    expect(player.health).toBe(PLAYER.maxHealth);
    expect(player.shield).toBe(PLAYER.maxShield);
    expect(player.alive).toBe(true);
    expect(player.position.equals(ctx.world.playerStart)).toBe(true);
    expect(player.yaw).toBeCloseTo(0);
    expect(player.grenades).toBe(2);
    expect(ctx.camera.parent).toBe(ctx.scene);
  });

  it('shield absorbs damage first', () => {
    player.takeDamage(30);
    expect(player.shield).toBe(50);
    expect(player.health).toBe(100);
    expect(ev.of('player:damaged')[0]).toMatchObject({ playerId: 'p1', amount: 30, health: 100, shield: 50, element: 'none' });
  });

  it('overflow goes to health and breaks the shield', () => {
    player.takeDamage(100);
    expect(player.shield).toBe(0);
    expect(player.health).toBe(80);
    expect(ev.of('player:shield')).toEqual([{ playerId: 'p1', shield: 0, maxShield: 80, broken: true }]);
  });

  it('shock deals double damage to the shield (not to health)', () => {
    player.takeDamage(30, { element: 'shock' });
    expect(player.shield).toBe(20);
    expect(player.health).toBe(100);
    player.takeDamage(30, { element: 'shock' }); // 20 shield = 10 shock damage, 20 to health
    expect(player.shield).toBe(0);
    expect(player.health).toBe(80);
  });

  it('shield recharges only after the delay, at the recharge rate', () => {
    player.takeDamage(60);
    expect(player.shield).toBe(20);
    frames(PLAYER.shieldRechargeDelay - 0.1);
    expect(player.shield).toBe(20);
    frames(1.1);
    expect(player.shield).toBeGreaterThan(20 + PLAYER.shieldRechargeRate * 0.8);
    expect(player.shield).toBeLessThan(20 + PLAYER.shieldRechargeRate * 1.2);
    frames(3);
    expect(player.shield).toBe(PLAYER.maxShield);
    expect(ev.of('player:shield').some((e) => !e.broken)).toBe(true);
  });

  it('taking damage during the recharge restarts the delay', () => {
    player.takeDamage(60);
    frames(PLAYER.shieldRechargeDelay + 0.5);
    const s = player.shield;
    player.takeDamage(1);
    frames(2);
    expect(player.shield).toBeCloseTo(s - 1);
  });

  it('death: health 0, alive false, player:died once; further damage/heal ignored', () => {
    player.takeDamage(1000);
    expect(player.health).toBe(0);
    expect(player.alive).toBe(false);
    expect(ev.count('player:died')).toBe(1);
    player.takeDamage(10);
    player.heal(50);
    expect(ev.count('player:died')).toBe(1);
    expect(player.health).toBe(0);
  });

  it('dead players do not recharge their shield', () => {
    player.takeDamage(1000);
    frames(8);
    expect(player.shield).toBe(0);
  });

  it('heal caps at maxHealth and reports the real amount', () => {
    player.takeDamage(110); // 30 to health
    player.heal(100);
    expect(player.health).toBe(100);
    expect(ev.of('player:healed')[0]).toMatchObject({ amount: 30, health: 100 });
    player.heal(10);
    expect(ev.count('player:healed')).toBe(1);
  });

  it('ignores non-positive damage', () => {
    player.takeDamage(0);
    player.takeDamage(-5);
    expect(ev.count('player:damaged')).toBe(0);
  });

  it('skill:changed with a shield bonus raises max and current shield', () => {
    const stats = { ...ctx.progression.stats, shieldMult: 1.5 };
    ctx.events.emit('skill:changed', { skillId: 'shield', rank: 5, stats });
    expect(player.maxShield).toBe(120);
    expect(player.shield).toBe(120);
  });
});

describe('inventory', () => {
  it('equip fills the active slot, then the empty slot, then replaces the active one', () => {
    const a = weapon();
    const b = weapon();
    const c = weapon();
    expect(player.equip(a)).toBeNull();
    expect(player.weapons).toEqual([a, null]);
    expect(player.activeWeapon).toBe(a);
    expect(player.equip(b)).toBeNull();
    expect(player.weapons).toEqual([a, b]);
    expect(player.activeSlot).toBe(0);
    expect(player.equip(c)).toBe(a);
    expect(player.weapons).toEqual([c, b]);
    expect(ev.of('weapon:equipped').map((e) => e.slot)).toEqual([0, 1, 0]);
  });

  it('a fresh weapon comes with a full mag and 4 mags reserve', () => {
    const w = weapon({ magSize: 10 });
    player.equip(w);
    expect(player.ammo).toBe(10);
    expect(player.reserve).toBe(40);
  });

  it('number keys switch slots', () => {
    const a = ready(weapon());
    const b = weapon();
    player.equip(b);
    ctx.fakeInput.press('Digit2');
    frame();
    expect(player.activeSlot).toBe(1);
    expect(player.activeWeapon).toBe(b);
    ctx.fakeInput.press('Digit1');
    frame();
    expect(player.activeWeapon).toBe(a);
  });

  it('addAmmo adds fraction·mag·4 rounds, capped at 10 mags', () => {
    player.equip(weapon({ magSize: 10 }));
    player.addAmmo(0.5);
    expect(player.reserve).toBe(60);
    for (let i = 0; i < 20; i++) player.addAmmo(0.5);
    expect(player.reserve).toBe(100);
    player.addAmmo(0);
    player.addAmmo(-1);
    expect(player.reserve).toBe(100);
  });

  it('addAmmo without a weapon is a no-op', () => {
    expect(() => player.addAmmo(1)).not.toThrow();
    expect(player.reserve).toBe(0);
  });

  it('addGrenades caps at maxGrenades', () => {
    player.addGrenades(10);
    expect(player.grenades).toBe(PLAYER.maxGrenades);
    expect(ev.of('player:grenades').at(-1)!.count).toBe(PLAYER.maxGrenades);
  });

  it('reset() restores health, shield, grenades, position and refills ammo', () => {
    const w = ready(weapon({ magSize: 10 }));
    player.ammo = 2;
    player.reserve = 0;
    player.takeDamage(150);
    player.grenades = 0;
    player.position.set(5, 0, 5);
    player.reset();
    expect(player.health).toBe(PLAYER.maxHealth);
    expect(player.shield).toBe(PLAYER.maxShield);
    expect(player.grenades).toBe(2);
    expect(player.alive).toBe(true);
    expect(player.position.equals(ctx.world.playerStart)).toBe(true);
    expect(player.ammo).toBe(w.magSize);
    expect(player.reserve).toBe(w.magSize * 4);
    expect(player.weapons[0]).toBe(w); // weapons are kept
  });

  it('reset() after death revives', () => {
    player.takeDamage(1000);
    player.reset();
    expect(player.alive).toBe(true);
    player.takeDamage(1000);
    expect(ev.count('player:died')).toBe(2);
  });
});

describe('movement', () => {
  it('stands on the ground and walks forward with W', () => {
    frames(0.2);
    const z0 = player.position.z;
    ctx.fakeInput.press('KeyW');
    frames(1);
    expect(player.position.z).toBeLessThan(z0 - PLAYER.walkSpeed * 0.7);
    expect(player.position.y).toBe(0);
  });

  it('jumps with Space and lands again', () => {
    frames(0.2);
    ctx.fakeInput.press('Space');
    frame();
    ctx.fakeInput.release('Space');
    frames(0.2);
    expect(player.position.y).toBeGreaterThan(0.5);
    frames(1.5);
    expect(player.position.y).toBe(0);
  });

  it('moveSpeedMult scales walking speed', () => {
    setup({ moveSpeedMult: 1.5 });
    frames(0.2);
    const z0 = player.position.z;
    ctx.fakeInput.press('KeyW');
    frames(1);
    const fast = z0 - player.position.z;
    setup();
    frames(0.2);
    const z1 = player.position.z;
    ctx.fakeInput.press('KeyW');
    frames(1);
    const slow = z1 - player.position.z;
    expect(fast / slow).toBeGreaterThan(1.35);
  });
});

describe('weapon firing (fake enemy in front of the camera)', () => {
  it('hits the enemy for the weapon damage with attribution', () => {
    const w = ready(weapon());
    const e = enemyAhead();
    click();
    expect(e.hits).toHaveLength(1);
    expect(e.hits[0].amount).toBeCloseTo(w.damage);
    expect(e.hits[0].opts).toMatchObject({ crit: false, sourceId: 'p1', element: 'none', applyStatus: false });
    expect(e.hits[0].opts!.point!.z).toBeCloseTo(20.5, 1);
    const fired = ev.of('weapon:fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].hits).toBe(1);
    expect(player.ammo).toBe(w.magSize - 1);
    expect(ctx.fx.count('tracer')).toBe(1);
  });

  it('crit on the head point multiplies by critMultiplier × stats.critMult', () => {
    setup({ critMult: 1.5, damageMult: 2 });
    const w = ready(weapon());
    const e = enemyAhead(1.0); // everything above 1 m is "head"
    click();
    expect(e.hits[0].opts!.crit).toBe(true);
    expect(e.hits[0].amount).toBeCloseTo(w.damage * 2 * w.critMultiplier * 1.5);
  });

  it('misses an enemy that is out of range or behind the camera', () => {
    ready(weapon({ range: 3 }));
    const e = enemyAhead();
    const behind = enemyAhead(10, 0, 30);
    click();
    expect(e.hits).toHaveLength(0);
    expect(behind.hits).toHaveLength(0);
    expect(ev.of('weapon:fired')[0].hits).toBe(0);
  });

  it('a wall in between blocks the shot', () => {
    ctx.world = createFlatWorld(() => ctx.rng(), [[-2, 0, 22, 2, 3, 23]]);
    ready(weapon());
    const e = enemyAhead();
    click();
    expect(e.hits).toHaveLength(0);
    expect(ctx.fx.count('impact')).toBe(1);
  });

  it('shotgun pellets each roll a hit', () => {
    ready(weapon({ archetype: 'shotgun', pellets: 8, spread: 0.02, damage: 5 }));
    const e = enemyAhead();
    click();
    expect(e.hits).toHaveLength(8);
    expect(ev.of('weapon:fired')[0].hits).toBe(8);
  });

  it('semi-auto fires once per click even when held', () => {
    ready(weapon());
    enemyAhead();
    ctx.fakeInput.mousePress(0);
    frames(1);
    expect(ev.count('weapon:fired')).toBe(1);
  });

  it('a click during the cooldown is buffered briefly', () => {
    ready(weapon({ fireRate: 4 }));
    click();
    frames(0.2);
    click(); // 0.2 s after: still on cooldown (0.25 s), buffered 0.12 s
    frames(0.15);
    expect(ev.count('weapon:fired')).toBe(2);
  });

  it('auto fire rate follows weapon.fireRate × stats.fireRateMult', () => {
    const count = (mult: number) => {
      setup({ fireRateMult: mult });
      ready(weapon({ archetype: 'smg', auto: true, fireRate: 10, magSize: 100 }));
      ctx.fakeInput.mousePress(0);
      frames(1);
      return ev.count('weapon:fired');
    };
    const base = count(1);
    const fast = count(2);
    expect(base).toBeGreaterThanOrEqual(10);
    expect(base).toBeLessThanOrEqual(11);
    expect(fast).toBeGreaterThanOrEqual(20);
    expect(fast).toBeLessThanOrEqual(21);
  });

  it('dead players cannot fire', () => {
    ready(weapon());
    player.takeDamage(1000);
    click();
    expect(ev.count('weapon:fired')).toBe(0);
  });

  it('elemental weapons request a status roll by elementChance', () => {
    ready(weapon({ element: 'fire', elementChance: 1 }));
    const e = enemyAhead();
    click();
    expect(e.hits[0].opts).toMatchObject({ element: 'fire', applyStatus: true });
  });
});

describe('reload', () => {
  it('KeyR reloads after reloadTime × reloadMult, moving rounds from reserve', () => {
    setup({ reloadMult: 0.5 });
    const w = ready(weapon({ magSize: 12, reloadTime: 2 }));
    for (let i = 0; i < 3; i++) { click(); frames(0.3); }
    expect(player.ammo).toBe(9);
    ctx.fakeInput.press('KeyR');
    frame();
    const r = ev.of('weapon:reload');
    expect(r).toHaveLength(1);
    expect(r[0].duration).toBeCloseTo(1);
    frames(0.9);
    expect(player.ammo).toBe(9);
    frames(0.15);
    expect(player.ammo).toBe(12);
    expect(player.reserve).toBe(w.magSize * 4 - 3);
  });

  it('cannot fire while reloading', () => {
    ready(weapon({ reloadTime: 1 }));
    click();
    frames(0.3);
    ctx.fakeInput.press('KeyR');
    frame();
    ev.clear();
    click();
    expect(ev.count('weapon:fired')).toBe(0);
  });

  it('no reload with a full mag or an empty reserve', () => {
    ready(weapon());
    ctx.fakeInput.press('KeyR');
    frame();
    expect(ev.count('weapon:reload')).toBe(0);
    click();
    frames(0.3);
    player.reserve = 0;
    ctx.fakeInput.press('KeyR');
    frame();
    expect(ev.count('weapon:reload')).toBe(0);
  });

  it('pulling the trigger on an empty mag starts a reload; empty reserve clicks', () => {
    ready(weapon());
    player.ammo = 0;
    click();
    expect(ev.count('weapon:fired')).toBe(0);
    expect(ev.count('weapon:reload')).toBe(1);
    frames(2);
    player.ammo = 0;
    player.reserve = 0;
    frames(0.3);
    click();
    expect(ctx.audio.played).toContain('empty');
  });

  it('reload is never shorter than 0.2 s', () => {
    setup({ reloadMult: 0.01 });
    ready(weapon({ reloadTime: 1 }));
    click();
    frames(0.3);
    ctx.fakeInput.press('KeyR');
    frame();
    expect(ev.of('weapon:reload')[0].duration).toBeCloseTo(0.2);
  });
});

describe('perks', () => {
  it('ricochet bounces 50 % damage to the nearest other enemy', () => {
    const w = ready(weapon({ perks: [perk('ricochet')] }));
    const a = enemyAhead();
    const b = enemyAhead(10, 3, 18);
    const far = enemyAhead(10, 25, 0);
    click();
    expect(a.hits).toHaveLength(1);
    expect(b.hits).toHaveLength(1);
    expect(b.hits[0].amount).toBeCloseTo(w.damage * 0.5);
    expect(b.hits[0].opts).toMatchObject({ crit: false, sourceId: 'p1' });
    expect(far.hits).toHaveLength(0);
  });

  it('without ricochet nothing bounces', () => {
    ready(weapon());
    enemyAhead();
    const b = enemyAhead(10, 3, 18);
    click();
    expect(b.hits).toHaveLength(0);
  });

  it('crit_refund gives the round back on a crit (not on a body shot)', () => {
    ready(weapon({ perks: [perk('crit_refund')], magSize: 12 }));
    const e = enemyAhead(1.0);
    click();
    expect(e.hits[0].opts!.crit).toBe(true);
    expect(player.ammo).toBe(12);
    e.critAbove = 10;
    frames(0.3);
    click();
    expect(player.ammo).toBe(11);
  });

  it('double_tap fires a free extra shot when the roll succeeds (rng < 0.1)', () => {
    ready(weapon({ perks: [perk('double_tap')], magSize: 12 }));
    const e = enemyAhead();
    ctx.rng = () => 0.05;
    click();
    expect(ev.count('weapon:fired')).toBe(2);
    expect(e.hits).toHaveLength(2);
    expect(player.ammo).toBe(11);
    ctx.rng = () => 0.5;
    frames(0.3);
    click();
    expect(ev.count('weapon:fired')).toBe(3);
  });

  it('lifesteal heals 3 % of damage dealt', () => {
    const w = ready(weapon({ perks: [perk('lifesteal')], damage: 100 }));
    enemyAhead();
    player.takeDamage(130); // shield 0, health 50
    click();
    expect(player.health).toBeCloseTo(50 + w.damage * 0.03);
  });

  it('splash deals 30 % area damage around the hit', () => {
    const w = ready(weapon({ perks: [perk('splash')] }));
    enemyAhead();
    click();
    expect(radiusCalls).toHaveLength(1);
    expect(radiusCalls[0].radius).toBe(2);
    expect(radiusCalls[0].amount).toBeCloseTo(w.damage * 0.3);
    expect(radiusCalls[0].opts!.sourceId).toBe('p1');
  });

  it('ramp_up shortens the cooldown while firing continuously', () => {
    const shots = (perks: WeaponPerk[]) => {
      setup();
      ready(weapon({ archetype: 'smg', auto: true, fireRate: 10, magSize: 200, perks }));
      ctx.fakeInput.mousePress(0);
      frames(3);
      return ev.count('weapon:fired');
    };
    expect(shots([perk('ramp_up')])).toBeGreaterThan(shots([]) + 3);
  });
});

describe('melee & grenades', () => {
  it('V melees the enemy in front for meleeDamage × damageMult', () => {
    setup({ damageMult: 1.5 });
    frames(0.1);
    const e = createFakeEnemy('m', v(0, 0, 24.5));
    targets.push(e);
    ctx.fakeInput.press('KeyV');
    frame();
    expect(e.hits).toHaveLength(1);
    expect(e.hits[0].amount).toBeCloseTo(PLAYER.meleeDamage * 1.5);
    expect(ev.of('player:melee')[0]).toEqual({ playerId: 'p1', hit: true });
  });

  it('melee whiffs on enemies behind the player', () => {
    frames(0.1);
    const e = createFakeEnemy('m', v(0, 0, 27.5));
    targets.push(e);
    ctx.fakeInput.press('KeyV');
    frame();
    expect(e.hits).toHaveLength(0);
    expect(ev.of('player:melee')[0].hit).toBe(false);
  });

  it('G throws a grenade that explodes into damageRadius after its fuse', () => {
    frames(0.1);
    ctx.fakeInput.press('KeyG');
    frame();
    expect(player.grenades).toBe(1);
    expect(ev.count('player:grenade')).toBe(1);
    frames(2.5);
    expect(radiusCalls).toHaveLength(1);
    expect(radiusCalls[0].amount).toBe(PLAYER.grenadeDamage);
    expect(radiusCalls[0].radius).toBe(PLAYER.grenadeRadius);
    expect(ctx.fx.count('explosion')).toBe(1);
  });

  it('no grenade without grenades', () => {
    player.grenades = 0;
    ctx.fakeInput.press('KeyG');
    frame();
    expect(ev.count('player:grenade')).toBe(0);
  });
});

describe('viewmodel & real enemies (headless)', () => {
  it('builds every archetype without WebGL and keeps a finite muzzle position', () => {
    const vm = new Viewmodel(ctx);
    ctx.camera.add(vm.root);
    const ctl = new Controller(ctx);
    const rng = createRng(3);
    for (const archetype of ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'] as const) {
      for (const element of ['none', 'fire', 'shock', 'ice'] as const) {
        const w = generateWeapon(rng, nextId, 5, { archetype });
        w.element = element;
        expect(() => vm.setWeapon(w, true)).not.toThrow();
        for (let i = 0; i < 40; i++) vm.update(1 / 60, ctl);
        vm.kick(0.1, 0.1);
        vm.flash();
        vm.startReload(1);
        vm.bash();
        vm.throwAnim();
        for (let i = 0; i < 10; i++) vm.update(1 / 60, ctl);
        const m = vm.muzzleWorld(new THREE.Vector3());
        expect(Number.isFinite(m.x + m.y + m.z)).toBe(true);
      }
    }
    vm.setWeapon(null, false);
    vm.setDead(true);
    expect(() => vm.update(0.1, ctl)).not.toThrow();
    vm.dispose();
  });

  it('a pistol shot at eye level crits a real grunt standing in front', () => {
    const mgr = new EnemyManager(ctx);
    ctx.enemies = mgr;
    const w = ready(weapon());
    const g = mgr.spawnMob('grunt', v(0, 0, 20), 1);
    mgr.update(0.016);
    ctx.scene.updateMatrixWorld(true); // the renderer does this every frame in the game
    click();
    const dealt = ev.of('damage:dealt');
    expect(dealt).toHaveLength(1);
    expect(dealt[0]).toMatchObject({ enemyId: g.id, playerId: 'p1', crit: true });
    expect(dealt[0].amount).toBeCloseTo(w.damage * w.critMultiplier);
  });

  it('aiming lower hits the grunt body for normal damage', () => {
    const mgr = new EnemyManager(ctx);
    ctx.enemies = mgr;
    const w = ready(weapon());
    mgr.spawnMob('grunt', v(0, 0, 20), 1);
    mgr.update(0.016);
    ctx.scene.updateMatrixWorld(true);
    ctx.fakeInput.dy = 0.135 / 0.0022; // pitch down 0.135 rad → ~0.9 m high (torso) at ~5.6 m
    frame();
    click();
    const dealt = ev.of('damage:dealt');
    expect(dealt).toHaveLength(1);
    expect(dealt[0].crit).toBe(false);
    expect(dealt[0].amount).toBeCloseTo(w.damage);
  });
});
