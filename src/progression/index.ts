/**
 * System D — progression: XP, levels, skill points, data-driven skill tree, persistence.
 */
import { XP, xpForLevel } from '@/core/config';
import type { GameContext, PlayerStats, Progression } from '@/core/types';
import { SKILLS, baseStats } from './skills';

export { SKILLS, BRANCHES, describeSkill } from './skills';

export const STORAGE_KEY = 'concourse.progress.v1';
const VERSION = 1;

export interface SavedProgress {
  version: number;
  level: number;
  xp: number;
  skillPoints: number;
  ranks: Record<string, number>;
  bestRound: number;
}

/** Read the persisted progress (or null). Used by the UI for "best round". */
export function readProgress(): SavedProgress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedProgress>;
    if (!d || d.version !== VERSION) return null;
    return {
      version: VERSION,
      level: Math.max(1, Math.floor(Number(d.level) || 1)),
      xp: Math.max(0, Number(d.xp) || 0),
      skillPoints: Math.max(0, Math.floor(Number(d.skillPoints) || 0)),
      ranks: typeof d.ranks === 'object' && d.ranks ? d.ranks : {},
      bestRound: Math.max(0, Math.floor(Number(d.bestRound) || 0)),
    };
  } catch {
    return null;
  }
}

export function readBestRound(): number {
  return readProgress()?.bestRound ?? 0;
}

export function createProgression(ctx: GameContext): Progression {
  let level = 1;
  let xp = 0;
  let skillPoints = 0;
  let bestRound = 0;
  const ranks = new Map<string, number>();
  const stats: PlayerStats = baseStats();

  const playerId = () => (ctx.player ? ctx.player.id : 'p1');
  const rank = (id: string) => ranks.get(id) ?? 0;

  function recompute(): void {
    Object.assign(stats, baseStats());
    for (const node of SKILLS) {
      const r = rank(node.id);
      if (r > 0) node.apply(stats, r);
    }
  }

  function save(): void {
    const data: SavedProgress = {
      version: VERSION, level, xp, skillPoints, ranks: Object.fromEntries(ranks), bestRound,
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
      skillPoints = d.skillPoints;
      bestRound = d.bestRound;
      for (const node of SKILLS) {
        const r = Math.floor(Number(d.ranks[node.id]) || 0);
        if (r > 0) ranks.set(node.id, Math.min(r, node.maxRank));
      }
    } else {
      level = 1; xp = 0; skillPoints = 0; bestRound = 0;
    }
    recompute();
  }

  function canUpgrade(id: string): boolean {
    const node = SKILLS.find((s) => s.id === id);
    if (!node || skillPoints <= 0) return false;
    if (rank(id) >= node.maxRank) return false;
    if (node.requires && rank(node.requires) < 1) return false;
    return true;
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

  function resetTree(): void {
    let refunded = 0;
    for (const [, r] of ranks) refunded += r;
    ranks.clear();
    skillPoints += refunded;
    recompute();
    for (const node of SKILLS) ctx.events.emit('skill:changed', { skillId: node.id, rank: 0, stats });
    save();
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
    rank,
    canUpgrade,
    upgrade,
    addXp,
    save,
    load,
    resetTree,
  };
}
