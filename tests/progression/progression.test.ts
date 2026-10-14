import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XP, xpForLevel } from '@/core/config';
import type { Enemy, Progression } from '@/core/types';
import {
  STORAGE_KEY, SKILLS, createProgression, describeSkill, readBestRound, readProgress,
} from '@/progression';
import { baseStats } from '@/progression/skills';
import { createFakeContext, recordEvents, type Recorder, type TestContext } from '../helpers/fakeContext';

let ctx: TestContext;
let prog: Progression;
let ev: Recorder;

function boot(): void {
  ctx = createFakeContext();
  ev = recordEvents(ctx.events);
  prog = createProgression(ctx);
}

const killed = (isBoss: boolean) => ({
  enemy: {} as Enemy, position: new THREE.Vector3(), isBoss, tier: 1, killerId: 'p1',
});

describe('xp curve', () => {
  it('matches 100·L^1.4 and is strictly increasing', () => {
    expect(xpForLevel(1)).toBe(100);
    expect(xpForLevel(2)).toBe(Math.round(100 * 2 ** 1.4));
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

  it('starts at level 1 with neutral stats', () => {
    expect(prog.level).toBe(1);
    expect(prog.xp).toBe(0);
    expect(prog.skillPoints).toBe(0);
    expect(prog.xpToNext).toBe(100);
    expect(prog.stats).toEqual(baseStats());
    expect(prog.skills).toBe(SKILLS);
  });

  it('addXp below the threshold accumulates and emits xp:gained', () => {
    prog.addXp(40);
    expect(prog.level).toBe(1);
    expect(prog.xp).toBe(40);
    expect(ev.of('xp:gained')[0]).toMatchObject({ amount: 40, xp: 40, xpToNext: 100, level: 1 });
    expect(ev.count('level:up')).toBe(0);
  });

  it('level:up emits and grants a skill point; excess carries over', () => {
    prog.addXp(130);
    expect(prog.level).toBe(2);
    expect(prog.xp).toBe(30);
    expect(prog.skillPoints).toBe(1);
    expect(ev.of('level:up')).toEqual([{ playerId: 'p1', level: 2, skillPoints: 1 }]);
    expect(prog.xpToNext).toBe(xpForLevel(2));
  });

  it('a large grant can pass several levels at once', () => {
    prog.addXp(xpForLevel(1) + xpForLevel(2) + xpForLevel(3) + 5);
    expect(prog.level).toBe(4);
    expect(prog.skillPoints).toBe(3);
    expect(prog.xp).toBe(5);
    expect(ev.count('level:up')).toBe(3);
  });

  it('ignores zero / negative xp', () => {
    prog.addXp(0);
    prog.addXp(-50);
    expect(prog.xp).toBe(0);
    expect(ev.count('xp:gained')).toBe(0);
  });

  it('grants XP for kills and round clears (host only)', () => {
    ctx.events.emit('enemy:killed', killed(false));
    expect(prog.xp).toBe(XP.mob);
    ctx.events.emit('enemy:killed', killed(true));
    ctx.events.emit('round:cleared', { round: 1 });
    expect(prog.level * 1000 + prog.xp).toBe(
      (() => { let l = 1; let x = XP.mob + XP.boss + XP.roundClear; while (x >= xpForLevel(l)) { x -= xpForLevel(l); l++; } return l * 1000 + x; })(),
    );
    const before = prog.xp;
    ctx.isHost = false;
    ctx.events.emit('enemy:killed', killed(false));
    expect(prog.xp).toBe(before);
  });

  it('canUpgrade needs points, respects maxRank and requirements', () => {
    expect(prog.canUpgrade('damage')).toBe(false); // no points
    expect(prog.upgrade('damage')).toBe(false);
    prog.addXp(10_000);
    expect(prog.canUpgrade('damage')).toBe(true);
    expect(prog.canUpgrade('nope')).toBe(false);
    const node = SKILLS.find((s) => s.id === 'damage')!;
    for (let i = 0; i < node.maxRank; i++) expect(prog.upgrade('damage')).toBe(true);
    expect(prog.rank('damage')).toBe(node.maxRank);
    expect(prog.canUpgrade('damage')).toBe(false);
    expect(prog.upgrade('damage')).toBe(false);
  });

  it('requires: a node with a prerequisite needs rank >= 1 there first', () => {
    // inject a temporary dependent node (the tree is data-driven)
    SKILLS.push({ ...SKILLS[0], id: 'test_child', requires: 'fire_rate', value: '1%' });
    try {
      prog.addXp(10_000);
      expect(prog.canUpgrade('test_child')).toBe(false);
      prog.upgrade('fire_rate');
      expect(prog.canUpgrade('test_child')).toBe(true);
    } finally {
      SKILLS.pop();
    }
  });

  it('upgrade recomputes stats, spends a point and emits skill:changed', () => {
    prog.addXp(10_000);
    const pts = prog.skillPoints;
    const statsRef = prog.stats;
    prog.upgrade('damage');
    prog.upgrade('damage');
    prog.upgrade('fire_rate');
    prog.upgrade('reload');
    expect(prog.stats).toBe(statsRef); // same object, mutated in place
    expect(prog.stats.damageMult).toBeCloseTo(1.16);
    expect(prog.stats.fireRateMult).toBeCloseTo(1.06);
    expect(prog.stats.reloadMult).toBeCloseTo(0.94);
    expect(prog.skillPoints).toBe(pts - 4);
    expect(ev.of('skill:changed').at(-1)).toMatchObject({ skillId: 'reload', rank: 1 });
  });

  it('resetTree refunds every point and restores base stats', () => {
    prog.addXp(10_000);
    const pts = prog.skillPoints;
    prog.upgrade('damage');
    prog.upgrade('shield');
    prog.upgrade('speed');
    ev.clear();
    prog.resetTree();
    expect(prog.skillPoints).toBe(pts);
    expect(prog.stats).toEqual(baseStats());
    for (const s of SKILLS) expect(prog.rank(s.id)).toBe(0);
    expect(ev.count('skill:changed')).toBe(SKILLS.length);
  });

  it('persists level/xp/points/ranks and restores them in a new instance', () => {
    prog.addXp(xpForLevel(1) + xpForLevel(2) + 7);
    prog.upgrade('damage');
    prog.save();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw).toMatchObject({ version: 1, level: 3, xp: 7, skillPoints: 1, ranks: { damage: 1 } });

    const again = createProgression(createFakeContext());
    expect(again.level).toBe(3);
    expect(again.xp).toBe(7);
    expect(again.skillPoints).toBe(1);
    expect(again.rank('damage')).toBe(1);
    expect(again.stats.damageMult).toBeCloseTo(1.08);
  });

  it('load() clamps ranks above maxRank and ignores unknown skills', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, level: 5, xp: 3, skillPoints: 2, ranks: { damage: 99, ghost: 3 }, bestRound: 4,
    }));
    prog.load();
    expect(prog.rank('damage')).toBe(5);
    expect(prog.rank('ghost')).toBe(0);
    expect(prog.stats.damageMult).toBeCloseTo(1.4);
  });

  it('corrupt or wrong-version storage falls back to defaults', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(readProgress()).toBeNull();
    prog.load();
    expect(prog.level).toBe(1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999, level: 9 }));
    expect(readProgress()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, level: -3, xp: 'x', skillPoints: 2.7 }));
    expect(readProgress()).toMatchObject({ level: 1, xp: 0, skillPoints: 2, bestRound: 0, ranks: {} });
  });

  it('saves bestRound on game:over (and never lowers it)', () => {
    expect(readBestRound()).toBe(0);
    ctx.events.emit('game:over', { round: 7, kills: 100 });
    expect(readBestRound()).toBe(7);
    ctx.events.emit('game:over', { round: 3, kills: 10 });
    expect(readBestRound()).toBe(7);
    expect(createProgression(createFakeContext()) && readBestRound()).toBe(7);
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
    const d = describeSkill(SKILLS.find((s) => s.id === 'damage')!);
    expect(d).toContain('8%');
    expect(d).not.toContain('{value}');
  });
});
