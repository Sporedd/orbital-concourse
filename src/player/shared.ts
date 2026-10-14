/**
 * Small helpers shared by the player modules.
 */
import { ADS } from '@/core/config';
import type { GameContext, PlayerStats, WeaponDef } from '@/core/types';
import type { ClassProgression, SkillExtras } from '@/progression';

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

/** Max grenades including skill (extras.extraGrenades) and gear bonuses. */
export function maxGrenades(ctx: GameContext, base: number): number {
  const b = base + Math.max(0, Math.floor(skillExtras(ctx).extraGrenades || 0));
  const g = (ctx as Partial<GameContext>).gear;
  return g ? g.maxGrenades(b) : b;
}

// ---- skill tree (docs/SKILL_TREE.md §5) ---------------------------------------------------
/** The class progression API, or null (test fakes / before boot). Type-only import: no cycle. */
export function classProgression(ctx: GameContext): ClassProgression | null {
  const p = (ctx as Partial<GameContext>).progression as Partial<ClassProgression> | undefined;
  return p && typeof p.useActive === 'function' ? (p as ClassProgression) : null;
}

const NO_SKILL_EXTRAS: Readonly<SkillExtras> = Object.freeze({
  meleeMult: 1, extraGrenades: 0, grenadeDamageMult: 1, grenadeRadiusMult: 1, adsSpreadMult: 1, shieldRegenMult: 1, abilityCooldownMult: 1,
});

/** Skill-tree extras (neutral without a class progression). Multiply next to gearExtras(). */
export function skillExtras(ctx: GameContext): Readonly<SkillExtras> {
  return classProgression(ctx)?.extras ?? NO_SKILL_EXTRAS;
}

/** The player owns a node wired through `player:<name>` (e.g. 'player:secondWind'). */
export function hasSkillHook(ctx: GameContext, hook: string): boolean {
  return classProgression(ctx)?.hooks.includes(hook) ?? false;
}

/** The class active `abilityId` is running right now (its effect window). */
export function activeRunning(ctx: GameContext, abilityId: string): boolean {
  const a = classProgression(ctx)?.activeAbility;
  return !!a && a.active && a.def.id === abilityId;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * ADS optic of a weapon: its own zoom/adsSpread, falling back to the archetype table for defs
 * saved or sent before ADS existed (and clamped against bad data).
 */
export function adsOf(def: WeaponDef): { zoom: number; adsSpread: number } {
  const base = ADS.archetype[def.archetype] ?? ADS.archetype.rifle;
  const zoom = typeof def.zoom === 'number' && Number.isFinite(def.zoom) ? clamp(def.zoom, 1, 6) : base.zoom;
  const adsSpread = typeof def.adsSpread === 'number' && Number.isFinite(def.adsSpread) ? clamp(def.adsSpread, 0.05, 1) : base.adsSpread;
  return { zoom, adsSpread };
}
