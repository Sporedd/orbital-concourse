/**
 * Skill-tree player hooks (docs/SKILL_TREE.md §5.1) with the real player + real progression:
 * the Q key, Shield Bash, Deadeye, Second Wind, Overheat, Ricochet Doctrine and the extras.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYER } from '@/core/config';
import type { DamageOpts, EnemyRegistry, WeaponDef } from '@/core/types';
import { EnemyManager } from '@/enemies';
import { starterWeapon } from '@/loot/weapons';
import { createPlayer, createPlayerRegistry, DEADEYE_TIME_SCALE, SHIELD_BASH, type Player } from '@/player';
import { createProgression, type ClassId, type ClassProgression } from '@/progression';
import {
  createFakeContext, createFakeEnemy, recordEvents, type FakeEnemy, type Recorder, type TestContext,
} from '../helpers/fakeContext';

let ctx: TestContext;
let player: Player;
let prog: ClassProgression;
let ev: Recorder;
let targets: FakeEnemy[];
let radiusCalls: { radius: number; amount: number; opts?: DamageOpts }[];
let timeScale: number;
let ids = 0;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const nextId = (p: string) => `${p}_s${++ids}`;
function weapon(over: Partial<WeaponDef> = {}): WeaponDef {
  return { ...starterWeapon(nextId), spread: 0, ...over, id: nextId('w') };
}

function setup(classId: ClassId | null): void {
  localStorage.clear();
  ctx = createFakeContext({ seed: 3 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  player = createPlayer(ctx, { id: 'p1', name: 'Tester' });
  ctx.players.add(player);
  ctx.player = player;
  targets = [];
  radiusCalls = [];
  timeScale = 1;
  ctx.enemies = {
    list: () => targets,
    get: (id: string) => targets.find((t) => t.id === id),
    damageRadius: (_c: THREE.Vector3, radius: number, amount: number, opts?: DamageOpts) => {
      radiusCalls.push({ radius, amount, opts });
      return 0;
    },
    aliveCount: () => targets.filter((t) => t.alive).length,
    bossAlive: () => false,
    clear: () => { targets = []; },
    update: () => {},
    get timeScale() { return timeScale; },
    setTimeScale: (s: number) => { timeScale = s; },
  } as unknown as EnemyRegistry;
  prog = createProgression(ctx);
  ctx.progression = prog;
  prog.addXp(1e6);
  if (classId) prog.setClass(classId);
  player.reset();
}

function buy(id: string, times = 1): void {
  for (let i = 0; i < times; i++) expect(prog.upgrade(id), `${id}: ${prog.lockReason(id)}`).toBe(true);
}

/** One frame: the player, then the sim clock (main.ts ticks ctx.time) and input.endFrame. */
function frame(dt = 1 / 60): void {
  player.update(dt);
  ctx.time.elapsed += dt;
  ctx.fakeInput.endFrame();
}
function frames(seconds: number, dt = 1 / 60): void {
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) frame(dt);
}
function pressQ(): void {
  ctx.fakeInput.press('KeyQ');
  frame();
  ctx.fakeInput.release('KeyQ');
}
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
function enemyAt(x: number, z: number, critAbove = 10): FakeEnemy {
  const e = createFakeEnemy(`e${targets.length + 1}`, v(x, 0, z), critAbove);
  targets.push(e);
  return e;
}

beforeEach(() => setup(null));

describe('player:activeKey (Q)', () => {
  it('Q fires the class active once, then respects the cooldown', () => {
    setup('technician');
    buy('tec_overclock', 3);
    buy('tec_overheat'); // first keystone unlocks Shock Pulse
    frame();
    expect(ev.of('active:ready')).toHaveLength(1);
    pressQ();
    expect(ev.of('active:used')).toHaveLength(1);
    expect(ev.of('active:used')[0]).toMatchObject({ playerId: 'p1', abilityId: 'shock_pulse', forced: false });
    expect(radiusCalls.filter((c) => c.radius === 8)).toHaveLength(1); // the 8 m nova
    expect(ctx.audio.played).toContain('explosion');
    expect(prog.activeAbility!.cooldownLeft).toBeGreaterThan(13);
    frames(1);
    pressQ(); // still cooling down
    expect(ev.of('active:used')).toHaveLength(1);
    expect(ctx.audio.played).toContain('empty');
    frames(13.5);
    expect(ev.of('active:ready')).toHaveLength(2);
    pressQ();
    expect(ev.of('active:used')).toHaveLength(2);
  });

  it('Q does nothing while locked, dead or while a screen captures input', () => {
    setup('technician');
    pressQ(); // no keystone yet
    expect(ev.of('active:used')).toHaveLength(0);
    expect(ev.of('ui:message').at(-1)?.text).toMatch(/UNLOCKS WITH YOUR FIRST KEYSTONE/);
    buy('tec_overclock', 3);
    buy('tec_overheat');
    ctx.fakeInput.uiCaptured = true;
    pressQ();
    ctx.fakeInput.uiCaptured = false;
    expect(ev.of('active:used')).toHaveLength(0);
    player.takeDamage(1e4);
    pressQ();
    expect(ev.of('active:used')).toHaveLength(0);
  });

  it('Encore: magazine refilled through the real ammo setter (clamped), reserve load added, fire rate buffed', () => {
    setup('showman');
    buy('sho_spray', 3);
    buy('sho_showstopper'); // keystone
    const w = ready(weapon({ magSize: 12 }));
    player.ammo = 2;
    const reserve = player.reserve;
    const fr = prog.stats.fireRateMult;
    pressQ();
    expect(player.ammo).toBe(w.magSize);
    expect(player.reserve).toBeGreaterThan(reserve);
    expect(prog.stats.fireRateMult).toBeCloseTo(fr * 1.2);
  });
});

describe('player:shieldBash (Vanguard)', () => {
  beforeEach(() => {
    setup('vanguard');
    buy('van_plating', 3);
    buy('van_overcharge'); // keystone
  });

  it('dashes 6 m along the view, hits each enemy in the path once at 150 % melee and knocks it aside', () => {
    const start = player.position.clone();
    const e = enemyAt(0.3, start.z - 3);
    const ex = e.position.x;
    pressQ();
    frames(0.4);
    const moved = start.distanceTo(player.position);
    expect(moved).toBeGreaterThan(SHIELD_BASH.distance - 0.4);
    expect(moved).toBeLessThan(SHIELD_BASH.distance + 0.8);
    expect(player.position.z).toBeLessThan(start.z); // forward is -Z at the start
    expect(e.hits).toHaveLength(1);
    expect(e.hits[0].opts?.cause).toBe('melee');
    expect(e.hits[0].amount).toBeCloseTo(PLAYER.meleeDamage * SHIELD_BASH.damage * prog.stats.damageMult);
    expect(e.position.x).toBeGreaterThan(ex + 1); // knocked off the dash line (to its side)
  });

  it('ignores damage for 1 s (the ability window), then takes it again', () => {
    pressQ();
    expect(player.invulnerable).toBe(true);
    const h = player.health;
    const s = player.shield;
    frames(0.5);
    player.takeDamage(500);
    expect(player.health).toBe(h);
    expect(player.shield).toBe(s);
    frames(0.6);
    expect(player.invulnerable).toBe(false);
    player.takeDamage(30);
    expect(player.shield).toBeLessThan(s);
  });
});

describe('player:deadeye (Marksman)', () => {
  beforeEach(() => {
    setup('marksman');
    buy('mar_calibre', 3);
    buy('mar_bullseye'); // keystone
  });

  it('every bullet crits while it runs, and enemies run at half speed until it ends', () => {
    const w = ready(weapon({ damage: 10, critMultiplier: 2 }));
    const e = enemyAt(0, player.position.z - 6, 10); // body only: never a natural crit
    click();
    expect(e.hits.at(-1)!.opts?.crit).toBe(false);
    frames(1);
    pressQ();
    expect(timeScale).toBe(DEADEYE_TIME_SCALE);
    click();
    const hit = e.hits.at(-1)!;
    expect(hit.opts?.crit).toBe(true);
    expect(hit.amount).toBeCloseTo(w.damage * prog.stats.damageMult * w.critMultiplier * prog.stats.critMult);
    frames(5.2);
    expect(timeScale).toBe(1);
    frames(0.5);
    click();
    expect(e.hits.at(-1)!.opts?.crit).toBe(false);
  });

  it('EnemyManager scales the dt of enemies and projectiles by its time scale', () => {
    const mgr = new EnemyManager(ctx);
    const upd = vi.fn();
    (mgr.enemies as unknown[]).push({ update: upd, removable: false, object: new THREE.Object3D(), extras: [], dispose() {} });
    const proj = vi.spyOn(mgr.projectiles, 'update');
    mgr.setTimeScale(0.5);
    mgr.update(0.1);
    expect(upd).toHaveBeenCalledWith(0.05);
    expect(proj).toHaveBeenCalledWith(0.05);
    expect(mgr.timeScale).toBe(0.5);
    mgr.clear();
    expect(mgr.timeScale).toBe(1);
  });
});

describe('player:secondWind (Pit P5)', () => {
  beforeEach(() => {
    buy('reload', 3);
    buy('speed', 2);
    buy('pit_pack_mule');
    buy('pit_second_wind');
  });

  it('lethal damage leaves 1 HP, half a shield and 2 s invulnerability, once per round', () => {
    player.takeDamage(1e4);
    expect(player.alive).toBe(true);
    expect(player.health).toBe(1);
    expect(player.shield).toBeCloseTo(player.maxShield * 0.5);
    expect(ev.of('ui:message').some((m) => m.text === 'SECOND WIND')).toBe(true);
    frames(1.5);
    player.takeDamage(1e4); // still invulnerable
    expect(player.alive).toBe(true);
    frames(0.6);
    player.takeDamage(1e4); // used this round
    expect(player.alive).toBe(false);
    expect(ev.count('player:died')).toBe(1);
  });

  it('round:started resets it', () => {
    player.takeDamage(1e4);
    frames(2.1);
    ctx.events.emit('round:started', { round: 2, killsRequired: 10 });
    player.takeDamage(1e4);
    expect(player.alive).toBe(true);
    expect(player.health).toBe(1);
  });

  it('without the node lethal damage kills', () => {
    prog.respec();
    player.takeDamage(1e4);
    expect(player.alive).toBe(false);
  });
});

describe('player:overheat (Technician A4)', () => {
  function shotsWhileHolding(seconds: number): number {
    const before = ev.count('weapon:fired');
    frames(seconds);
    return ev.count('weapon:fired') - before;
  }

  it('fire rate ramps with sustained fire and resets after release', () => {
    setup('technician');
    buy('tec_overclock', 3);
    buy('tec_overheat');
    ready(weapon({ auto: true, fireRate: 30, magSize: 1000 }));
    ctx.fakeInput.mousePress(0);
    const first = shotsWhileHolding(0.5);
    shotsWhileHolding(1.0);
    const hot = shotsWhileHolding(0.5);
    expect(hot / first).toBeGreaterThan(1.2);
    expect(hot / first).toBeLessThan(1.5);
    ctx.fakeInput.mouseRelease(0);
    frames(0.6); // drains in 0.5 s
    ctx.fakeInput.mousePress(0);
    const again = shotsWhileHolding(0.5);
    ctx.fakeInput.mouseRelease(0);
    expect(again).toBeLessThanOrEqual(first + 1);
  });

  it('spread grows with heat', () => {
    setup('technician');
    buy('tec_overclock', 3);
    buy('tec_overheat');
    ready(weapon({ auto: true, fireRate: 12, magSize: 1000, spread: 0.02 }));
    ctx.fakeInput.mousePress(0);
    frames(1.6);
    const hot = player.spread!;
    ctx.fakeInput.mouseRelease(0);
    frames(3); // heat and bloom drain
    const cold = player.spread!;
    expect(hot).toBeGreaterThan(cold * 1.4);
  });

  it('without the keystone the fire rate is flat', () => {
    setup('technician');
    ready(weapon({ auto: true, fireRate: 12, magSize: 1000 }));
    ctx.fakeInput.mousePress(0);
    const first = shotsWhileHolding(0.5);
    shotsWhileHolding(1.0);
    const later = shotsWhileHolding(0.5);
    expect(Math.abs(later - first)).toBeLessThanOrEqual(1);
  });
});

describe('player:ricochetDoctrine (Marksman B4)', () => {
  it('a miss passing within 2 m of an enemy curves into it for 70 % (bent tracer); farther misses do not', () => {
    setup('marksman');
    buy('mar_quickdraw', 3);
    ready(weapon({ damage: 10 }));
    const near = enemyAt(1.2, player.position.z - 8);
    click();
    expect(near.hits).toHaveLength(0); // not yet owned
    buy('mar_ricochet');
    const tracers = ctx.fx.count('tracer');
    frames(1);
    click();
    expect(near.hits).toHaveLength(1);
    expect(near.hits[0].amount).toBeCloseTo(10 * prog.stats.damageMult * 0.7);
    expect(near.hits[0].opts?.cause).toBe('bullet');
    expect(ctx.fx.count('tracer') - tracers).toBe(2);
    near.position.x = 3.5; // > 2 m from the ray
    frames(1);
    click();
    expect(near.hits).toHaveLength(1);
  });
});

describe('player:extras', () => {
  it('Bandolier + Ordnance Bay raise the grenade cap; grenade damage uses grenadeDamageMult', () => {
    setup('technician');
    buy('tec_recycler', 3);
    buy('tec_resupply');
    buy('tec_payload', 2);
    buy('tec_ordnance');
    buy('reload', 3);
    buy('pit_bandolier', 2);
    expect(player.maxGrenades).toBe(PLAYER.maxGrenades + 4);
    player.addGrenades(99);
    expect(player.grenades).toBe(PLAYER.maxGrenades + 4);
    ctx.fakeInput.press('KeyG');
    frame();
    frames(3);
    const blast = radiusCalls.find((c) => c.opts?.cause === 'grenade')!;
    expect(blast).toBeDefined();
    expect(blast.radius).toBeCloseTo(PLAYER.grenadeRadius);
    expect(blast.amount).toBeCloseTo(PLAYER.grenadeDamage * prog.stats.damageMult * prog.extras.grenadeDamageMult);
    expect(prog.extras.grenadeDamageMult).toBeCloseTo(1.24 * 1.3);
  });

  it('Wide Spread scales the grenade radius', () => {
    setup('technician');
    buy('tec_recycler', 3);
    buy('tec_cluster', 3);
    buy('tec_wide', 2);
    ctx.fakeInput.press('KeyG');
    frame();
    frames(3);
    const blast = radiusCalls.find((c) => c.opts?.cause === 'grenade')!;
    expect(blast.radius).toBeCloseTo(PLAYER.grenadeRadius * 1.3);
  });

  it('Breath Control tightens the aimed spread only', () => {
    setup('marksman');
    ready(weapon({ spread: 0.05 }));
    const hip = player.spread!;
    ctx.fakeInput.mousePress(2);
    frames(0.5);
    const aimed = player.spread!;
    buy('mar_breath', 3);
    expect(player.spread!).toBeCloseTo(aimed * 0.7);
    ctx.fakeInput.mouseRelease(2);
    frames(0.5);
    expect(player.spread!).toBeCloseTo(hip);
  });

  it('Heavy Hands multiplies melee damage in the player (no bridge follow-up hit)', () => {
    setup('vanguard');
    buy('van_heavy_hands', 3);
    const e = enemyAt(0, player.position.z - 1.5);
    ctx.fakeInput.press('KeyV');
    frame();
    expect(e.hits).toHaveLength(1);
    expect(e.hits[0].amount).toBeCloseTo(PLAYER.meleeDamage * prog.stats.damageMult * 1.45);
  });
});
