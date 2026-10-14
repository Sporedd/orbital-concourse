import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XP, xpForLevel } from '@/core/config';
import type { Enemy } from '@/core/types';
import {
  CLASSES, DEV_FLAG_KEY, STORAGE_KEY, SKILLS, VERSION, createProgression, describeSkill, migrateRanks, readBestRound,
  readProgress, skillById, type ClassProgression,
} from '@/progression';
import { baseStats } from '@/progression/skills';
import { createFakeContext, createFakePlayer, recordEvents, type Recorder, type TestContext } from '../helpers/fakeContext';

let ctx: TestContext;
let prog: ClassProgression;
let ev: Recorder;

function boot(): void {
  ctx = createFakeContext();
  ctx.player = createFakePlayer('p1');
  ev = recordEvents(ctx.events);
  prog = createProgression(ctx);
}

/** Invest `times` points into `id` (asserting each one lands). */
function buy(id: string, times = 1): void {
  for (let i = 0; i < times; i++) expect(prog.upgrade(id), `${id} #${i + 1}: ${prog.lockReason(id)}`).toBe(true);
}

const killed = (isBoss: boolean) => ({
  enemy: {} as Enemy, position: new THREE.Vector3(), isBoss, tier: 1, killerId: 'p1',
});

describe('xp curve', () => {
  it('matches 100·L^1.1 (docs/SKILL_TREE.md pacing) and is strictly increasing', () => {
    expect(xpForLevel(1)).toBe(100);
    expect(xpForLevel(2)).toBe(Math.round(100 * 2 ** 1.1));
    expect(xpForLevel(0)).toBe(100); // clamped: a broken save never asks for 0 XP
    for (let l = 2; l < 60; l++) expect(xpForLevel(l)).toBeGreaterThan(xpForLevel(l - 1));
  });
});

describe('Progression', () => {
  // Fake timers everywhere: small XP grants schedule a 1 s delayed save that would
  // otherwise fire during a later test and overwrite its storage fixture.
  beforeEach(() => {
    vi.useFakeTimers();
    boot();
  });
  afterEach(() => vi.useRealTimers());

  it('starts at level 1 with neutral stats and no class', () => {
    expect(prog.level).toBe(1);
    expect(prog.xp).toBe(0);
    expect(prog.skillPoints).toBe(0);
    expect(prog.xpToNext).toBe(100);
    expect(prog.stats).toEqual(baseStats());
    expect(prog.skills).toBe(SKILLS);
    expect(prog.classId).toBeNull();
    expect(prog.activeAbility).toBeNull();
  });

  it('addXp accumulates, levels up and grants one point per level', () => {
    prog.addXp(40);
    expect(prog.xp).toBe(40);
    expect(ev.of('xp:gained')[0]).toMatchObject({ amount: 40, xp: 40, xpToNext: 100, level: 1 });
    prog.addXp(90);
    expect(prog.level).toBe(2);
    expect(prog.xp).toBe(30);
    expect(prog.skillPoints).toBe(1);
    expect(ev.of('level:up')).toEqual([{ playerId: 'p1', level: 2, skillPoints: 1 }]);
    prog.addXp(0);
    prog.addXp(-50);
    expect(prog.xp).toBe(30);
  });

  it('grants XP for kills and round clears (host only)', () => {
    ctx.events.emit('enemy:killed', killed(false));
    expect(prog.xp).toBe(XP.mob);
    ctx.events.emit('round:cleared', { round: 1 });
    expect(prog.xp).toBe(XP.mob + XP.roundClear);
    ctx.isHost = false;
    ctx.events.emit('enemy:killed', killed(false));
    expect(prog.xp).toBe(XP.mob + XP.roundClear);
  });

  it('setClass applies the identity, emits class:changed and exposes the active', () => {
    expect(prog.setClass('vanguard')).toBe(true);
    expect(prog.classId).toBe('vanguard');
    expect(prog.stats.shieldMult).toBeCloseTo(1.2);
    expect(prog.stats.healthMult).toBeCloseTo(1.1);
    expect(ev.of('class:changed')).toEqual([{ classId: 'vanguard', previous: null }]);
    expect(ev.of('skill:changed').at(-1)).toMatchObject({ skillId: '*' });
    expect(prog.activeAbility?.def.id).toBe(CLASSES.vanguard.active.id);
    expect(prog.activeAbility?.unlocked).toBe(false);
    expect(prog.setClass('vanguard')).toBe(false); // same class: no-op
  });

  it('only the current class tree and the Pit can be invested', () => {
    prog.addXp(1e6);
    expect(prog.canUpgrade('reload')).toBe(true); // Pit is open without a class
    expect(prog.canUpgrade('van_plating')).toBe(false);
    expect(prog.lockReason('van_plating')).toBe('OTHER CLASS');
    prog.setClass('marksman');
    expect(prog.canUpgrade('van_plating')).toBe(false);
    expect(prog.canUpgrade('mar_steady')).toBe(true);
    expect(prog.canUpgrade('nope')).toBe(false);
  });

  it('tier gates, requires and max rank are enforced', () => {
    prog.addXp(1e6);
    prog.setClass('vanguard');
    // tier 2 needs 3 points in the branch
    expect(prog.lockReason('van_scar_tissue')).toMatch(/NEEDS 3 POINTS/);
    buy('van_constitution', 3);
    // gate open, but requires Reinforced Plating
    expect(prog.lockReason('van_scar_tissue')).toMatch(/NEEDS REINFORCED PLATING/);
    buy('van_plating');
    buy('van_scar_tissue', 3);
    expect(prog.canUpgrade('van_scar_tissue')).toBe(false); // maxed
    expect(prog.upgrade('van_scar_tissue')).toBe(false);
    // capstone needs 25 class points
    expect(prog.lockReason('van_unbroken')).toMatch(/NEEDS 25 CLASS POINTS/);
  });

  it('unimplemented nodes are SOON (not buyable) but do not block their dependants', () => {
    // every node is wired today: mark two unimplemented for the test
    const breath = skillById('mar_breath')!;
    const quick = skillById('mar_quickdraw')!;
    breath.implemented = false;
    quick.implemented = false;
    try {
      prog.addXp(1e6);
      prog.setClass('marksman');
      expect(prog.lockReason('mar_breath')).toBe('SOON');
      expect(prog.canUpgrade('mar_breath')).toBe(false);
      expect(prog.lockReason('mar_quickdraw')).toBe('SOON');
      // Scoped In requires Quickdraw (SOON): an unbuyable prerequisite counts as met
      skillById('mar_breath')!.implemented = true;
      buy('mar_breath', 3);
      buy('mar_scoped');
    } finally {
      breath.implemented = true;
      quick.implemented = true;
    }
  });

  it('the 9 player-hook nodes are buyable without the dev flag', () => {
    prog.addXp(1e6);
    prog.setClass('technician');
    buy('tec_payload', 3);
    expect(prog.hooks).toContain('player:extras.grenadeDamageMult');
    expect(prog.extras.grenadeDamageMult).toBeCloseTo(1.36);
    buy('reload', 3);
    buy('pit_bandolier', 2);
    expect(prog.extras.extraGrenades).toBe(2);
    buy('speed');
    buy('pit_pack_mule');
    buy('pit_second_wind');
    expect(prog.hooks).toContain('player:secondWind');
  });

  it('the dev flag makes unimplemented nodes buyable and lists their hooks', () => {
    localStorage.setItem(DEV_FLAG_KEY, '1');
    boot();
    expect(prog.dev).toBe(true);
    prog.addXp(1e6);
    prog.setClass('marksman');
    buy('mar_breath');
    expect(prog.hooks).toContain('player:extras.adsSpreadMult');
    expect(prog.extras.adsSpreadMult).toBeCloseTo(0.9);
  });

  it('upgrade recomputes stats in place, spends a point and emits skill:changed', () => {
    prog.addXp(1e6);
    prog.setClass('marksman');
    const pts = prog.skillPoints;
    const statsRef = prog.stats;
    buy('mar_calibre', 2);
    buy('reload');
    buy('mar_steady');
    expect(prog.stats).toBe(statsRef);
    expect(prog.stats.damageMult).toBeCloseTo(1.08);
    expect(prog.stats.reloadMult).toBeCloseTo(0.94);
    expect(prog.stats.critMult).toBeCloseTo(1.2 * 1.1); // identity × Steady Hand
    expect(prog.skillPoints).toBe(pts - 4);
    expect(ev.of('skill:changed').at(-1)).toMatchObject({ skillId: 'mar_steady', rank: 1 });
  });

  it('the first keystone unlocks the active ability', () => {
    prog.addXp(1e6);
    prog.setClass('technician');
    buy('tec_scrounger', 3);
    expect(prog.activeAbility!.unlocked).toBe(false);
    expect(prog.useActive()).toBe(false);
    buy('tec_field_medic');
    buy('tec_salvage'); // keystone
    expect(prog.activeAbility!.unlocked).toBe(true);
    expect(prog.activeAbility!.ready).toBe(true);
  });

  it('respec refunds every point with one skill:changed', () => {
    prog.addXp(1e6);
    prog.setClass('showman');
    const pts = prog.skillPoints;
    buy('sho_footwork', 2);
    buy('speed');
    ev.clear();
    prog.respec();
    expect(prog.skillPoints).toBe(pts);
    expect(prog.classPoints()).toBe(0);
    expect(prog.rank('speed')).toBe(0);
    expect(prog.stats.moveSpeedMult).toBeCloseTo(1.08); // class identity stays
    expect(ev.of('skill:changed')).toHaveLength(1);
  });

  it('switching class refunds the class tree and keeps the Pit', () => {
    prog.addXp(1e6);
    prog.setClass('vanguard');
    const pts = prog.skillPoints;
    buy('van_plating', 3);
    buy('reload', 2);
    prog.setClass('showman');
    expect(prog.rank('van_plating')).toBe(0);
    expect(prog.rank('reload')).toBe(2);
    expect(prog.skillPoints).toBe(pts - 2);
    expect(prog.stats.shieldMult).toBeCloseTo(1);
  });

  it('persists level/xp/points/ranks/class and restores them in a new instance', () => {
    prog.addXp(xpForLevel(1) + xpForLevel(2) + xpForLevel(3) + 7);
    prog.setClass('vanguard');
    buy('van_plating');
    prog.save();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw).toMatchObject({ version: VERSION, level: 4, xp: 7, skillPoints: 2, ranks: { van_plating: 1 }, classId: 'vanguard' });

    const again = createProgression(createFakeContext());
    expect(again.level).toBe(4);
    expect(again.skillPoints).toBe(2);
    expect(again.classId).toBe('vanguard');
    expect(again.rank('van_plating')).toBe(1);
    expect(again.stats.shieldMult).toBeCloseTo(1.2 * 1.08);
  });

  it('migrates a v1 save: Pit ids survive (clamped), everything else is refunded', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, level: 20, xp: 3, skillPoints: 2, bestRound: 4,
      ranks: { damage: 3, fire_rate: 2, reload: 5, speed: 1, shield: 4, ghost: 2 },
    }));
    prog.load();
    expect(prog.level).toBe(20);
    expect(prog.rank('reload')).toBe(3); // maxRank 3, 2 refunded
    expect(prog.rank('speed')).toBe(1);
    expect(prog.rank('damage')).toBe(0);
    // refunded: damage 3 + fire_rate 2 + reload excess 2 + shield 4 + ghost 2 = 13
    expect(prog.skillPoints).toBe(2 + 13);
    expect(prog.stats.reloadMult).toBeCloseTo(1 - 0.18);
    // written back as v2, so the refund happens once
    expect(readProgress()).toMatchObject({ version: VERSION, skillPoints: 15, classId: null });
    prog.load();
    expect(prog.skillPoints).toBe(15);
  });

  it('migrateRanks drops nodes of other classes', () => {
    const m = migrateRanks({ van_plating: 2, mar_steady: 1, reload: 1 }, 2, 'marksman');
    expect(Object.fromEntries(m.ranks)).toEqual({ mar_steady: 1, reload: 1 });
    expect(m.refunded).toBe(2);
  });

  it('corrupt or wrong-version storage falls back to defaults', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(readProgress()).toBeNull();
    prog.load();
    expect(prog.level).toBe(1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999, level: 9 }));
    expect(readProgress()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, level: -3, xp: 'x', skillPoints: 2.7, classId: 'bard' }));
    expect(readProgress()).toMatchObject({ level: 1, xp: 0, skillPoints: 2, bestRound: 0, ranks: {}, classId: null });
  });

  it('saves bestRound on game:over (and never lowers it)', () => {
    expect(readBestRound()).toBe(0);
    ctx.events.emit('game:over', { round: 7, kills: 100 });
    expect(readBestRound()).toBe(7);
    ctx.events.emit('game:over', { round: 3, kills: 10 });
    expect(readBestRound()).toBe(7);
  });

  it('small XP grants are coalesced into one delayed save; level-ups save immediately', () => {
    prog.addXp(10);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    prog.addXp(10);
    vi.advanceTimersByTime(1000);
    expect(readProgress()!.xp).toBe(20);
    prog.addXp(100);
    expect(readProgress()!.level).toBe(2);
  });

  it('survives a throwing localStorage', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => prog.save()).not.toThrow();
    spy.mockRestore();
  });

  it('describeSkill substitutes {value}', () => {
    const d = describeSkill(skillById('van_plating')!);
    expect(d).toContain('8%');
    expect(d).not.toContain('{value}');
  });
});
