/**
 * Small helpers shared by the player modules.
 */
import type { GameContext, PlayerStats } from '@/core/types';

export const DEFAULT_STATS: PlayerStats = {
  damageMult: 1,
  fireRateMult: 1,
  reloadMult: 1,
  critMult: 1,
  healthMult: 1,
  shieldMult: 1,
  moveSpeedMult: 1,
};

/**
 * THE stat path for the local player: skill tree (progression) × equipped gear (affixes + set
 * stats). Safe before progression/gear have booted (neutral stats). With gear present this is a
 * reused object: read it, don't keep it across frames. Run-level modifiers (sponsor contract,
 * crowd-gift buff) are not PlayerStats; they multiply damage via runDamageMult() below.
 */
export function getStats(ctx: GameContext): PlayerStats {
  const prog = ctx.progression as GameContext['progression'] | undefined;
  const base = (prog && prog.stats) || DEFAULT_STATS;
  const gear = (ctx as Partial<GameContext>).gear;
  return gear ? gear.mergedStats(base) : base;
}

/** Run-level damage multiplier: sponsor contract × crowd-gift buff (1 when standing is absent). */
export function runDamageMult(ctx: GameContext): number {
  const s = (ctx as Partial<GameContext>).standing;
  return s ? s.damageMult() : 1;
}

/** Everything that scales outgoing gun damage: stats.damageMult × run modifiers (co-op sends this). */
export function effectiveDamageMult(ctx: GameContext): number {
  return getStats(ctx).damageMult * runDamageMult(ctx);
}

/** Gear extras (neutral without gear). */
export function gearExtras(ctx: GameContext): {
  meleeMult: number; shieldRegenMult: number; elementalResist: number; elementChanceBonus: number; hooks: readonly string[];
} {
  const g = (ctx as Partial<GameContext>).gear;
  return g ? g.gearStats : NO_GEAR;
}
const NO_GEAR = { meleeMult: 1, shieldRegenMult: 1, elementalResist: 0, elementChanceBonus: 0, hooks: [] as readonly string[] };

/** Max grenades including gear bonuses. */
export function maxGrenades(ctx: GameContext, base: number): number {
  const g = (ctx as Partial<GameContext>).gear;
  return g ? g.maxGrenades(base) : base;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
