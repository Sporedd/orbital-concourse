/**
 * The 25 ranks in 5 leagues (PLAN §12). Pure data + lookup helpers, no side effects.
 * threshold(i) = round(250 · i^1.6) — rank 0 (Fodder) is free, rank 24 (Eternal) ≈ 40k.
 */
import { LEAGUE_STYLE } from '@/rendering/style';
import type { League, LeagueDressing, LeagueId, RankDef, RankProgress } from './types';

export const rankThreshold = (index: number): number => Math.round(250 * Math.pow(Math.max(0, index), 1.6));

const css = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

interface LeagueSpec {
  id: LeagueId;
  name: string;
  accent: number;
  dressing: LeagueDressing;
  ranks: [name: string, unlock: string][];
}

const LEAGUE_SPECS: LeagueSpec[] = [
  {
    id: 'scrap', name: 'Scrap League', accent: LEAGUE_STYLE.scrap.accent,
    dressing: {
      crowdSizeMult: 0.25, floodlights: 2, lasers: false, holoBillboards: 0, hazard: null,
      hubFloor: 'Cargo bay (deck 0)',
      notes: 'Half-empty rusted stands, two sodium floodlights, bare scaffolding. Crowd is sparse and heckles.',
    },
    ranks: [
      ['Fodder', 'Hub: a bunk in a cargo bay with one flickering light'],
      ['Deckhand', 'Hub: a dented crate locker for your gear'],
      ['Brawler', 'Arena: your title appears on the scoreboard'],
      ['Scrapper', 'Hub: punching bag and a work lamp'],
      ['Pit Dog', 'Arena: a small fan section chants your name'],
    ],
  },
  {
    id: 'iron', name: 'Iron League', accent: LEAGUE_STYLE.iron.accent,
    dressing: {
      crowdSizeMult: 0.5, floodlights: 4, lasers: false, holoBillboards: 1, hazard: 'vent_pulls',
      hubFloor: 'Crew deck (deck 1)',
      notes: 'Stands half full, four floodlights, one holo-billboard with the round. Vent pulls unlock.',
    },
    ranks: [
      ['Rookie', 'Hub: steady light, a proper cot; Iron sponsors unlock'],
      ['Fighter', 'Hub: wall-mounted weapon hooks'],
      ['Contender', 'Hub: a real room with a gear rack and a window'],
      ['Bruiser', 'Arena: your colours on the entry gate'],
      ['Enforcer', 'Hub: trophy shelf for boss kills'],
    ],
  },
  {
    id: 'steel', name: 'Steel League', accent: LEAGUE_STYLE.steel.accent,
    dressing: {
      crowdSizeMult: 0.75, floodlights: 6, lasers: true, holoBillboards: 2, hazard: 'laser_grids',
      hubFloor: 'Officer deck (deck 2)',
      notes: 'Packed lower ring, six floodlights plus stage lasers, two holo-billboards. Laser grids unlock.',
    },
    ranks: [
      ['Veteran', 'Hub: officer-deck quarters; Steel sponsors unlock'],
      ['Duelist', 'Hub: sparring dummy and a mirror'],
      ['Gladiator', 'Arena: crowd banners in your accent colour'],
      ['Warlord', 'Hub: armour stand for your best gear'],
      ['Champion', 'Hub: lounge with a bar, trophies and a view of the arena'],
    ],
  },
  {
    id: 'star', name: 'Star League', accent: LEAGUE_STYLE.star.accent,
    dressing: {
      crowdSizeMult: 1, floodlights: 8, lasers: true, holoBillboards: 4, hazard: 'gravity_pulses',
      hubFloor: 'Promenade deck (deck 3)',
      notes: 'Full house, eight floodlights, laser show, four holo-billboards with your name. Gravity pulses unlock.',
    },
    ranks: [
      ['Starblade', 'Hub: promenade suite; Star sponsors unlock'],
      ['Conqueror', 'Hub: holo trophy wall'],
      ['Titan', 'Hub: a personal service drone'],
      ['Legend', 'Hub: penthouse with a holo-wall of your fights'],
      ['Immortal', 'Arena: a statue of you on the rim'],
    ],
  },
  {
    id: 'void', name: 'Void League', accent: LEAGUE_STYLE.void.accent,
    dressing: {
      crowdSizeMult: 1.25, floodlights: 10, lasers: true, holoBillboards: 6, hazard: 'shrinking_ring',
      hubFloor: 'Spire (top deck)',
      notes: 'Overflowing stands plus hover-boxes, ten floodlights, full holo-dome. Shrinking ring unlocks.',
    },
    ranks: [
      ['Myth', 'Hub: the spire; Void sponsors unlock'],
      ['Paragon', 'Hub: a private shuttle docked outside the window'],
      ['Ascendant', 'Hub: zero-g trophy vault'],
      ['Icon', 'Arena: the whole crowd wears your colours'],
      ['Eternal', 'Arena: your name engraved on the arena gate'],
    ],
  },
];

export const LEAGUES: readonly League[] = LEAGUE_SPECS.map((l, index) => ({
  id: l.id, name: l.name, index, accent: l.accent, accentCss: css(l.accent), dressing: l.dressing,
}));

export const RANKS: readonly RankDef[] = LEAGUE_SPECS.flatMap((l, li) =>
  l.ranks.map(([name, unlock], ti): RankDef => {
    const index = li * 5 + ti;
    return {
      id: `${l.id}_${ti + 1}_${name.toLowerCase().replace(/[^a-z]+/g, '')}`,
      name,
      league: l.id,
      leagueIndex: li,
      tier: ti + 1,
      index,
      threshold: rankThreshold(index),
      accent: l.accent,
      unlock,
    };
  }),
);

export const MAX_RANK = RANKS[RANKS.length - 1];

export function leagueById(id: LeagueId): League {
  return LEAGUES.find((l) => l.id === id) ?? LEAGUES[0];
}

export function leagueOf(rank: RankDef): League {
  return LEAGUES[rank.leagueIndex] ?? LEAGUES[0];
}

/** Highest rank whose threshold is <= standing. */
export function rankForStanding(standing: number): RankDef {
  const s = Number.isFinite(standing) ? standing : 0;
  let r = RANKS[0];
  for (const rank of RANKS) {
    if (s >= rank.threshold) r = rank;
    else break;
  }
  return r;
}

export function progressToNext(standing: number): RankProgress {
  const rank = rankForStanding(standing);
  const next = RANKS[rank.index + 1] ?? null;
  if (!next) return { rank, next: null, into: Math.max(0, standing - rank.threshold), span: 0, fraction: 1, remaining: 0 };
  const span = next.threshold - rank.threshold;
  const into = Math.max(0, standing - rank.threshold);
  return { rank, next, into, span, fraction: Math.min(1, into / span), remaining: Math.max(0, next.threshold - standing) };
}

/** Display name with league, e.g. "Iron League · Contender (III)". */
export function rankTitle(rank: RankDef): string {
  const roman = ['I', 'II', 'III', 'IV', 'V'][rank.tier - 1] ?? `${rank.tier}`;
  return `${leagueOf(rank).name} · ${rank.name} (${roman})`;
}

/**
 * Arena dressing for a rank: league base, with the crowd growing ~10 % per tier inside
 * the league so every rank is a visible step (world agent reads this).
 */
export function dressingForRank(rank: RankDef): LeagueDressing {
  const d = leagueOf(rank).dressing;
  return { ...d, crowdSizeMult: +(d.crowdSizeMult * (1 + 0.1 * (rank.tier - 1))).toFixed(3) };
}

/** Optional "better loot with standing" hook: small rarity boost per league (0 .. 0.12). */
export function leagueLootBoost(rank: RankDef): number {
  return 0.03 * rank.leagueIndex;
}
