/**
 * System D — progression: XP, levels, skill points, classes, the data-driven skill trees and
 * persistence (docs/SKILL_TREE.md).
 *
 * `stats` is a live object: the static part (class identity + stat nodes) is recomputed on every
 * invest; read-time modifiers and timed buffs (effects.ts) are folded in by its getters, so the
 * existing per-shot `getStats(ctx)` path picks them up without player changes.
 */
import { XP, xpForLevel } from '@/core/config';
import type { GameContext, PlayerStats, Progression } from '@/core/types';
import { CLASSES, PIT, isClassId, type ClassDef, type ClassId } from './classes';
import { createEffects, DYN_STATS, type ActiveAbilityState, type DynStat } from './effects';
import {
  CAPSTONE_GATE, LEGACY_IDS, SKILLS, TIER_GATE, baseExtras, baseStats, skillById, visibleSkills,
  type SkillDef, type SkillExtras,
} from './skills';

export { SKILLS, BRANCHES, describeSkill, rankValue, visibleSkills, classSkills, pitSkills, skillById, pointsBudget, TIER_GATE, CAPSTONE_GATE } from './skills';
export type { SkillDef, SkillExtras, BranchDef, NodeKind, HookKind } from './skills';
export { CLASSES, CLASS_IDS, CLASS_LIST, PIT, isClassId } from './classes';
export type { ClassDef, ClassId, ActiveAbilityDef, TreeId } from './classes';
export type { ActiveAbilityState } from './effects';

export const STORAGE_KEY = 'concourse.progress.v1';
/** Payload version inside STORAGE_KEY (1 = the 5-node placeholder tree, 2 = classes). */
export const VERSION = 2;
/** Dev flag: unimplemented nodes read "NEEDS WIRING" and can be bought. */
export const DEV_FLAG_KEY = 'concourse.dev';

export interface SavedProgress {
  version: number;
  level: number;
  xp: number;
  skillPoints: number;
  ranks: Record<string, number>;
  bestRound: number;
  classId: ClassId | null;
}

/** Progression with classes (docs §5). Cast `ctx.progression` to this to reach the extras. */
export interface ClassProgression extends Progression {
  readonly skills: SkillDef[];
  readonly classId: ClassId | null;
  readonly classDef: ClassDef | null;
  /** Non-PlayerStats numbers for the player code (neutral until it adopts them). */
  readonly extras: Readonly<SkillExtras>;
  /** Owned `player:*` hook ids (e.g. 'player:secondWind'). */
  readonly hooks: readonly string[];
  readonly activeAbility: ActiveAbilityState | null;
  readonly dev: boolean;
  setClass(id: ClassId): boolean;
  /** Refund every point (class tree + Pit). Free for now. */
  respec(): void;
  useActive(): boolean;
  /** Points invested in one branch / the whole class tree / everything. */
  pointsIn(branch: string): number;
  classPoints(): number;
  /** Why `id` can't be invested right now (null when it can, or it is maxed). */
  lockReason(id: string): string | null;
  /** The node's tier/class gates are open (ignores points and requires). */
  gateOpen(id: string): boolean;
}

export function isDev(): boolean {
  try {
    if (typeof location !== 'undefined' && /[?&]dev\b/.test(location.search)) return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem(DEV_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Read and sanitise the persisted progress (v1 or v2), or null. Ranks are not migrated here. */
export function readProgress(): SavedProgress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedProgress>;
    if (!d || (d.version !== 1 && d.version !== VERSION)) return null;
    return {
      version: d.version,
      level: Math.max(1, Math.floor(Number(d.level) || 1)),
      xp: Math.max(0, Number(d.xp) || 0),
      skillPoints: Math.max(0, Math.floor(Number(d.skillPoints) || 0)),
      ranks: typeof d.ranks === 'object' && d.ranks ? d.ranks : {},
      bestRound: Math.max(0, Math.floor(Number(d.bestRound) || 0)),
      classId: isClassId(d.classId) ? d.classId : null,
    };
  } catch {
    return null;
  }
}

export function readBestRound(): number {
  return readProgress()?.bestRound ?? 0;
}

/**
 * Turn saved ranks into valid ranks for `classId`: v1 saves keep only the ids that live on in
 * the Pit; unknown ids, other classes' nodes and ranks above maxRank are refunded.
 */
export function migrateRanks(
  saved: Record<string, unknown>, version: number, classId: ClassId | null,
): { ranks: Map<string, number>; refunded: number } {
  const ranks = new Map<string, number>();
  let refunded = 0;
  for (const [id, v] of Object.entries(saved)) {
    const r = Math.max(0, Math.floor(Number(v) || 0));
    if (r <= 0) continue;
    const node = skillById(id);
    const keep = node && (version >= 2 || LEGACY_IDS.includes(id)) && (node.classId === PIT || node.classId === classId);
    if (!node || !keep) {
      refunded += r;
      continue;
    }
    const k = Math.min(r, node.maxRank);
    refunded += r - k;
    ranks.set(id, k);
  }
  return { ranks, refunded };
}

export function createProgression(ctx: GameContext): ClassProgression {
  let level = 1;
  let xp = 0;
  let skillPoints = 0;
  let bestRound = 0;
  let classId: ClassId | null = null;
  const ranks = new Map<string, number>();
  const fixed: PlayerStats = baseStats();
  let extras: SkillExtras = baseExtras();
  let hooks: string[] = [];
  const dev = isDev();

  const playerId = () => (ctx.player ? ctx.player.id : 'p1');
  const rank = (id: string) => ranks.get(id) ?? 0;

  // ---- live stats: fixed part × effects ------------------------------------------------------
  const effects = createEffects(ctx, {
    rank,
    classId: () => classId,
    extras: () => extras,
    stats: () => stats,
    activeUnlocked: () => activeUnlocked(),
  });
  const stats = {} as PlayerStats;
  for (const k of Object.keys(fixed) as (keyof PlayerStats)[]) {
    const dyn = (DYN_STATS as readonly string[]).includes(k);
    Object.defineProperty(stats, k, {
      enumerable: true,
      get: dyn ? () => fixed[k] * effects.mult(k as DynStat) : () => fixed[k],
    });
  }

  function activeUnlocked(): boolean {
    if (!classId) return false;
    for (const [id, r] of ranks) {
      const n = skillById(id);
      if (r > 0 && n && n.classId === classId && n.kind === 'keystone') return true;
    }
    return false;
  }

  function recompute(): void {
    Object.assign(fixed, baseStats());
    extras = baseExtras();
    const h: string[] = [];
    if (classId) {
      const id = CLASSES[classId].identity;
      for (const k of Object.keys(id) as (keyof PlayerStats)[]) fixed[k] *= 1 + (id[k] ?? 0);
    }
    for (const [nid, r] of ranks) {
      const node = skillById(nid);
      if (!node || r <= 0) continue;
      node.apply(fixed, r);
      node.extra?.(extras, r);
      if (node.hook.startsWith('player:') && !h.includes(node.hook)) h.push(node.hook);
    }
    hooks = h;
  }

  function save(): void {
    const data: SavedProgress = {
      version: VERSION, level, xp, skillPoints, ranks: Object.fromEntries(ranks), bestRound, classId,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable (private mode) — progress just isn't persisted */
    }
  }

  function load(): void {
    const d = readProgress();
    ranks.clear();
    if (d) {
      level = d.level;
      xp = d.xp;
      bestRound = d.bestRound;
      classId = d.classId;
      const m = migrateRanks(d.ranks, d.version, classId);
      for (const [id, r] of m.ranks) ranks.set(id, r);
      skillPoints = d.skillPoints + m.refunded;
      if (d.version !== VERSION || m.refunded > 0) {
        recompute();
        save();
      }
    } else {
      level = 1; xp = 0; skillPoints = 0; bestRound = 0; classId = null;
    }
    recompute();
  }

  // ---- gates -----------------------------------------------------------------------------------
  function pointsIn(branch: string): number {
    let n = 0;
    for (const [id, r] of ranks) if (skillById(id)?.branch === branch) n += r;
    return n;
  }
  function classPoints(): number {
    let n = 0;
    for (const [id, r] of ranks) {
      const c = skillById(id)?.classId;
      if (c && c !== PIT) n += r;
    }
    return n;
  }
  function gateOpen(id: string): boolean {
    const node = skillById(id);
    if (!node) return false;
    if (node.classId !== PIT && node.classId !== classId) return false;
    if (node.kind === 'capstone') return classPoints() >= CAPSTONE_GATE;
    return pointsIn(node.branch) >= (TIER_GATE[node.tier] ?? 0);
  }
  const usable = (n: SkillDef) => n.implemented || dev;
  function requiresMet(node: SkillDef): boolean {
    if (!node.requires) return true;
    const req = skillById(node.requires);
    if (!req) return true;
    // An unimplemented prerequisite can't be bought, so it must not block live nodes.
    return rank(req.id) >= 1 || !usable(req);
  }

  function lockReason(id: string): string | null {
    const node = skillById(id);
    if (!node) return 'UNKNOWN';
    if (rank(id) >= node.maxRank) return null;
    if (node.classId !== PIT && node.classId !== classId) return 'OTHER CLASS';
    if (!usable(node)) return 'SOON';
    if (node.kind === 'capstone') {
      const have = classPoints();
      if (have < CAPSTONE_GATE) return `NEEDS ${CAPSTONE_GATE} CLASS POINTS (${have})`;
    } else {
      const gate = TIER_GATE[node.tier] ?? 0;
      const have = pointsIn(node.branch);
      if (have < gate) return `NEEDS ${gate} POINTS IN BRANCH (${have})`;
    }
    if (!requiresMet(node)) return `NEEDS ${skillById(node.requires!)!.name.toUpperCase()}`;
    if (skillPoints <= 0) return 'NO POINTS';
    return null;
  }

  function canUpgrade(id: string): boolean {
    const node = skillById(id);
    if (!node || skillPoints <= 0) return false;
    if (rank(id) >= node.maxRank) return false;
    return lockReason(id) === null;
  }

  function upgrade(id: string): boolean {
    if (!canUpgrade(id)) return false;
    const r = rank(id) + 1;
    ranks.set(id, r);
    skillPoints--;
    recompute();
    ctx.events.emit('skill:changed', { skillId: id, rank: r, stats });
    save();
    return true;
  }

  function addXp(amount: number): void {
    if (amount <= 0) return;
    xp += amount;
    let levelled = false;
    while (xp >= xpForLevel(level)) {
      xp -= xpForLevel(level);
      level++;
      skillPoints++;
      levelled = true;
      ctx.events.emit('level:up', { playerId: playerId(), level, skillPoints });
    }
    ctx.events.emit('xp:gained', { playerId: playerId(), amount, xp, xpToNext: xpForLevel(level), level });
    if (levelled || amount >= 50) save();
    else scheduleSave();
  }

  // Coalesce frequent small XP saves (one per mob kill) into at most one write per second.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 1000);
  }

  /** Refund ranks matching `which`; one skill:changed ('*') if anything changed. */
  function refund(which: (n: SkillDef | undefined) => boolean): number {
    let refunded = 0;
    for (const [id, r] of Array.from(ranks)) {
      if (!which(skillById(id))) continue;
      refunded += r;
      ranks.delete(id);
    }
    skillPoints += refunded;
    return refunded;
  }

  function resetTree(): void {
    refund(() => true);
    recompute();
    ctx.events.emit('skill:changed', { skillId: '*', rank: 0, stats });
    save();
  }

  function setClass(id: ClassId): boolean {
    if (!isClassId(id) || id === classId) return false;
    const previous = classId;
    refund((n) => !n || n.classId !== PIT);
    classId = id;
    effects.reset();
    recompute();
    ctx.events.emit('class:changed', { classId: id, previous });
    ctx.events.emit('skill:changed', { skillId: '*', rank: 0, stats });
    save();
    return true;
  }

  // ---- event wiring --------------------------------------------------------
  /** Crowd tier XP multiplier (system I); 1 without standing. */
  const xpMult = () => (ctx as Partial<GameContext>).standing?.xpMult() ?? 1;
  ctx.events.on('enemy:killed', (e) => {
    // only kills credited to a player give XP (a bomber blowing itself up has no killer)
    if (!ctx.isHost || !e.killerId || (ctx.players && !ctx.players.get(e.killerId))) return;
    addXp(Math.round((e.isBoss ? XP.boss : XP.mob) * xpMult()));
  });
  ctx.events.on('round:cleared', () => {
    if (!ctx.isHost) return;
    addXp(Math.round(XP.roundClear * xpMult()));
  });
  ctx.events.on('round:started', (e) => {
    // record progress as it happens, not only on death (closing the tab mid-run kept best = 0)
    if (e.round > bestRound) {
      bestRound = e.round;
      save();
    }
  });
  ctx.events.on('game:over', (e) => {
    if (e.round > bestRound) bestRound = e.round;
    save();
  });
  window.addEventListener('beforeunload', save);

  load();

  return {
    get level() { return level; },
    get xp() { return xp; },
    get xpToNext() { return xpForLevel(level); },
    get skillPoints() { return skillPoints; },
    stats,
    skills: SKILLS,
    get classId() { return classId; },
    get classDef() { return classId ? CLASSES[classId] : null; },
    get extras() { return extras; },
    get hooks() { return hooks; },
    get activeAbility() { return effects.active; },
    dev,
    rank,
    canUpgrade,
    upgrade,
    addXp,
    save,
    load,
    resetTree,
    respec: resetTree,
    setClass,
    useActive: () => effects.useActive(),
    pointsIn,
    classPoints,
    lockReason,
    gateOpen,
  };
}

/** Narrow a Progression (possibly a test fake) to the class API, or null. */
export function asClassProgression(p: Progression | undefined | null): ClassProgression | null {
  return p && typeof (p as Partial<ClassProgression>).setClass === 'function' ? (p as ClassProgression) : null;
}

