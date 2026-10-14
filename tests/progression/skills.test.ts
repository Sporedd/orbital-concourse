/**
 * Skill data integrity (docs/SKILL_TREE.md §1, §3): ids, membership, requires, gates, budget.
 */
import { describe, expect, it } from 'vitest';
import {
  BRANCHES, CAPSTONE_GATE, CLASSES, CLASS_IDS, PIT, SKILLS, TIER_GATE, classSkills, pitSkills, pointsBudget, rankValue,
  skillById, visibleSkills,
} from '@/progression';
import { WIRED_PLAYER_HOOKS, baseExtras, baseStats } from '@/progression/skills';

describe('skill data', () => {
  it('ids are unique and resolvable', () => {
    const ids = SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(skillById(id)?.id).toBe(id);
  });

  it('every node belongs to a known tree and branch', () => {
    const branchIds = new Set(BRANCHES.map((b) => b.id));
    for (const s of SKILLS) {
      expect(s.classId === PIT || CLASS_IDS.includes(s.classId as never), s.id).toBe(true);
      if (s.kind === 'capstone') expect(s.branch).toBe(`${s.classId}_cap`);
      else expect(branchIds.has(s.branch), `${s.id} → ${s.branch}`).toBe(true);
    }
  });

  it('each class: 3 branches × (2 passives per tier, keystones at tiers 2 and 3) + 1 capstone', () => {
    for (const c of CLASS_IDS) {
      const nodes = classSkills(c);
      expect(nodes).toHaveLength(19);
      expect(nodes.filter((n) => n.kind === 'capstone')).toHaveLength(1);
      for (const letter of ['a', 'b', 'c']) {
        const br = nodes.filter((n) => n.branch === `${c}_${letter}`);
        expect(br, `${c}_${letter}`).toHaveLength(6);
        for (const tier of [1, 2, 3]) {
          const row = br.filter((n) => n.tier === tier);
          expect(row.map((n) => n.col).sort()).toEqual([0, 1]);
          expect(row.filter((n) => n.kind === 'keystone')).toHaveLength(tier === 1 ? 0 : 1);
        }
        expect(br.filter((n) => n.kind === 'keystone').every((n) => n.maxRank === 1)).toBe(true);
      }
      // plinth codes are unique inside the visible tree
      const codes = visibleSkills(c).map((n) => n.code);
      expect(new Set(codes).size).toBe(codes.length);
      expect(CLASSES[c].branches).toHaveLength(3);
    }
  });

  it('points budget: class tree 40 + Pit 10 = 50', () => {
    for (const c of CLASS_IDS) expect(pointsBudget(classSkills(c))).toBe(40);
    expect(pointsBudget(pitSkills())).toBe(10);
  });

  it('requires point at an existing, lower-tier node of the same tree (or the Pit)', () => {
    for (const s of SKILLS) {
      if (!s.requires) continue;
      const r = skillById(s.requires);
      expect(r, `${s.id} requires ${s.requires}`).toBeDefined();
      expect(r!.classId === s.classId || r!.classId === PIT, s.id).toBe(true);
      expect(r!.tier).toBeLessThan(s.tier);
      expect(r!.implemented, `${s.id} should require a live node`).toBe(true);
    }
  });

  it('has no requirement cycles', () => {
    for (const s of SKILLS) {
      const seen = new Set<string>();
      let cur = s.requires;
      while (cur) {
        expect(seen.has(cur), `cycle at ${s.id}`).toBe(false);
        seen.add(cur);
        cur = skillById(cur)?.requires;
      }
    }
  });

  it('gates are reachable with live nodes only', () => {
    for (const c of CLASS_IDS) {
      const live = classSkills(c).filter((n) => n.implemented && n.kind !== 'capstone');
      expect(pointsBudget(live)).toBeGreaterThanOrEqual(CAPSTONE_GATE);
      for (const letter of ['a', 'b', 'c']) {
        const t1 = live.filter((n) => n.branch === `${c}_${letter}` && n.tier === 1);
        expect(pointsBudget(t1), `${c}_${letter} tier-1 points`).toBeGreaterThanOrEqual(TIER_GATE[2]);
      }
    }
  });

  it('hooks: player:* nodes are live once their hook is wired, everything else is live', () => {
    for (const s of SKILLS) {
      expect(s.implemented, s.id).toBe(!s.hook.startsWith('player:') || WIRED_PLAYER_HOOKS.has(s.hook));
    }
  });

  it('every node is wired (the 9 player-hook nodes included)', () => {
    const player = SKILLS.filter((s) => s.hook.startsWith('player:'));
    expect(player.map((s) => s.id).sort()).toEqual([
      'mar_breath', 'mar_ricochet', 'pit_bandolier', 'pit_second_wind', 'sho_curtain',
      'tec_ordnance', 'tec_overheat', 'tec_payload', 'tec_wide',
    ]);
    for (const s of SKILLS) expect(s.implemented, s.id).toBe(true);
  });

  it('descriptions with {value} have a value; flavour is present', () => {
    for (const s of SKILLS) {
      if (s.description.includes('{value}')) expect(s.value, s.id).not.toBe('');
      expect(s.flavour.length, s.id).toBeGreaterThan(3);
    }
  });

  it('stat nodes change PlayerStats; others leave them alone', () => {
    for (const s of SKILLS) {
      const st = baseStats();
      s.apply(st, s.maxRank);
      const changed = JSON.stringify(st) !== JSON.stringify(baseStats());
      if (s.hook === 'stat') expect(changed, s.id).toBe(true);
    }
    const st = baseStats();
    skillById('van_plating')!.apply(st, 3);
    expect(st.shieldMult).toBeCloseTo(1.24);
    const x = baseExtras();
    skillById('van_heavy_hands')!.extra!(x, 2);
    expect(x.meleeMult).toBeCloseTo(1.3);
  });

  it('rankValue formats totals', () => {
    expect(rankValue(skillById('van_plating')!, 2)).toBe('+16 %');
    expect(rankValue(skillById('reload')!, 3)).toBe('−18 %');
    expect(rankValue(skillById('van_overcharge')!, 1)).toBe('');
  });
});
