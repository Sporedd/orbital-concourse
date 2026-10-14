/**
 * Persistent standing score ('concourse.standing.v1') → rank → league.
 * Earns from round clears, boss kills, hype milestones (via award()) and a small
 * once-per-run consolation on game over. Emits 'standing:gained' and 'standing:rank'.
 */
import type { GameContext } from '@/core/types';
import { leagueOf, progressToNext, rankForStanding, rankTitle } from './ranks';
import { defaultStore, onUnload, readJson, writeJson } from './storage';
import {
  emitStanding, onStanding, type KeyValueStore, type League, type RankDef, type RankProgress,
  type StandingGain, type StandingLifetime,
} from './types';

export const STANDING_KEY = 'concourse.standing.v1';
const VERSION = 1;
const HISTORY_MAX = 20;

/** Tuning (PLAN §12). Amounts are before the sponsor standing multiplier. */
export const STANDING_RULES = {
  roundBase: 40,
  roundPerRound: 15, // round:cleared → 40 + 15·round
  bossBase: 60,
  bossPerTier: 20, // boss kill → 60 + 20·tier
  consolationPerRound: 5, // game:over → 5·round, once per run
  gearScorePerPoint: 0.1, // round:cleared → gear score worn / 10 (PLAN §12 "gear quality worn")
} as const;

interface SavedStanding {
  version: number;
  standing: number;
  lifetime: StandingLifetime;
  history: StandingGain[];
}

export interface Standing {
  readonly standing: number;
  readonly rank: RankDef;
  readonly league: League;
  readonly accentColor: number;
  readonly accentCss: string;
  readonly progress: RankProgress;
  readonly title: string;
  /** Most recent gains, newest last (max 20, persisted). */
  readonly history: readonly StandingGain[];
  readonly lifetime: Readonly<StandingLifetime>;
  /**
   * Add standing. `base` is scaled by the run multiplier (sponsor) unless `raw`.
   * Returns the amount actually added (rounded, 0 if nothing).
   */
  award(base: number, reason: string, label?: string, raw?: boolean): number;
  save(): void;
  load(): void;
  /** Debug: wipe standing + lifetime stats. */
  resetAll(): void;
}

export interface StandingOptions {
  storage?: KeyValueStore;
  /** Multiplier applied to every award (sponsor standingMult). Default 1. */
  multiplier?: () => number;
}

const emptyLifetime = (): StandingLifetime => ({ roundsCleared: 0, bossesKilled: 0, runs: 0, bestRound: 0, gifts: 0 });

export function createStanding(ctx: GameContext, opts: StandingOptions = {}): Standing {
  const store = opts.storage ?? defaultStore();
  const mult = opts.multiplier ?? (() => 1);

  let standing = 0;
  let lifetime = emptyLifetime();
  const history: StandingGain[] = [];
  let rank = rankForStanding(0);
  let consoled = false;

  function save(): void {
    const data: SavedStanding = { version: VERSION, standing, lifetime, history: history.slice(-10) };
    writeJson(store, STANDING_KEY, data);
  }

  function load(): void {
    const d = readJson<Partial<SavedStanding>>(store, STANDING_KEY);
    history.length = 0;
    if (d && d.version === VERSION) {
      standing = Math.max(0, Math.floor(Number(d.standing) || 0));
      const lt = (d.lifetime ?? {}) as Partial<StandingLifetime>;
      const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
      lifetime = {
        roundsCleared: n(lt.roundsCleared), bossesKilled: n(lt.bossesKilled), runs: n(lt.runs),
        bestRound: n(lt.bestRound), gifts: n(lt.gifts),
      };
      if (Array.isArray(d.history)) {
        for (const g of d.history.slice(-HISTORY_MAX)) {
          if (g && typeof g.amount === 'number') history.push(g);
        }
      }
    } else {
      standing = 0;
      lifetime = emptyLifetime();
    }
    rank = rankForStanding(standing);
  }

  function award(base: number, reason: string, label = reason, raw = false): number {
    if (!(base > 0)) return 0;
    const m = raw ? 1 : Math.max(0, mult());
    const amount = Math.round(base * m);
    if (amount <= 0) return 0;
    const previous = rank;
    standing += amount;
    rank = rankForStanding(standing);
    const gain: StandingGain = { amount, reason, label, standing, at: Date.now() };
    history.push(gain);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    save();
    emitStanding(ctx.events, 'standing:gained', { amount, standing, rank, reason, label });
    if (rank.index > previous.index) {
      const league = leagueOf(rank);
      const leagueUp = rank.leagueIndex > previous.leagueIndex;
      emitStanding(ctx.events, 'standing:rank', { rank, league, previous, leagueUp });
      ctx.events.emit('ui:message', {
        text: leagueUp ? `PROMOTED to the ${league.name}! Rank: ${rank.name}` : `Rank up — ${rank.name}`,
        duration: leagueUp ? 5 : 3.5,
        style: 'legendary',
      });
    }
    return amount;
  }

  // ---- event wiring --------------------------------------------------------
  ctx.events.on('round:cleared', (e) => {
    lifetime.roundsCleared++;
    if (e.round > lifetime.bestRound) lifetime.bestRound = e.round;
    award(STANDING_RULES.roundBase + STANDING_RULES.roundPerRound * e.round, 'round', `Round ${e.round} cleared`);
    const worn = Math.round((ctx.gear?.gearStats.score ?? 0) * STANDING_RULES.gearScorePerPoint);
    if (worn > 0) award(worn, 'gear', 'Gear worn');
  });
  ctx.events.on('enemy:killed', (e) => {
    if (!e.isBoss) return;
    lifetime.bossesKilled++;
    const tier = Math.max(1, Math.floor(e.tier) || 1);
    award(STANDING_RULES.bossBase + STANDING_RULES.bossPerTier * tier, 'boss', 'Headliner down');
  });
  ctx.events.on('game:started', () => {
    consoled = false;
  });
  ctx.events.on('game:over', (e) => {
    if (consoled) return;
    consoled = true;
    lifetime.runs++;
    if (e.round > lifetime.bestRound) lifetime.bestRound = e.round;
    const got = award(STANDING_RULES.consolationPerRound * Math.max(0, e.round), 'consolation', `Crowd tips · round ${e.round}`);
    if (!got) save();
  });
  onStanding(ctx.events, 'hype:gift', () => {
    lifetime.gifts++;
  });
  onUnload(save);

  load();

  return {
    get standing() { return standing; },
    get rank() { return rank; },
    get league() { return leagueOf(rank); },
    get accentColor() { return leagueOf(rank).accent; },
    get accentCss() { return leagueOf(rank).accentCss; },
    get progress() { return progressToNext(standing); },
    get title() { return rankTitle(rank); },
    history,
    get lifetime() { return lifetime; },
    award,
    save,
    load,
    resetAll() {
      standing = 0;
      lifetime = emptyLifetime();
      history.length = 0;
      rank = rankForStanding(0);
      save();
    },
  };
}

