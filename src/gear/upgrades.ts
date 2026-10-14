/**
 * Gear upgrades (PLAN §13, docs/ECONOMY.md): pure functions that return an upgraded COPY of a
 * piece (same id) or a reason why not. Costs live in ./economyMath (upgradeCost); the economy
 * system charges scrip and swaps the copy into the inventory (Inventory.replace → gear:changed).
 *
 *  - reinforce: item level +1 (cap ECONOMY.maxItemLevel). Every non-integer value is rescaled by
 *    affixLevelScale(L+1)/affixLevelScale(L); growth (the parametric model knob) and the league
 *    band are recomputed, so the paper doll / loot model visibly grows.
 *  - retune:    reroll ONE value (index 0 = implicit, 1.. = rolled affixes) inside its range at the
 *    piece's level and rarity (generator ranges, integer grenades 1..cap).
 *  - augment:   add one rolled affix (slot pools, no duplicate stat) while below AFFIX_COUNT[rarity].
 *  - ascend:    rarity +1 (legendary cap). Level += the rarity level bonus difference, values are
 *    rescaled by the rarity budget and level ratios, colours recomputed. No new affix: ascending
 *    raises the affix cap, so Augment becomes available.
 */
import { ECONOMY } from '@/core/config';
import { RARITY_ORDER, type Rarity } from '@/core/types';
import { randRange } from '@/core/rng';
import { RARITY_BUDGET } from '@/loot/weapons';
import {
  AFFIXES, AFFIX_COUNT, AFFIX_POOLS, IMPLICIT_SCALE, LEVEL_BONUS, affixLevelScale, growthForLevel, leagueForLevel, makeAffix,
} from './generator';
import { gearAccentColor, gearBodyColor } from './palette';
import type { GearAffix, GearDef, GearStat } from './types';
import type { UpgradeKind } from './economyMath';

type Rng = () => number;

export type UpgradeResult =
  | { ok: true; item: GearDef }
  | { ok: false; reason: string };

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const PRIMARY_CHANCE = 0.65;

/** Max grenades an integer affix can hold at a level/rarity (generator: 1 + ⌊L/12⌋, +1 legendary, ≤ 3). */
export const grenadeCap = (level: number, rarity: Rarity) =>
  Math.min(3, 1 + Math.floor(level / 12) + (rarity === 'legendary' ? 1 : 0));

/** Value range [min, max] of a stat at a level/rarity (implicits are ×0.6). */
export function affixRange(stat: GearStat, level: number, rarity: Rarity, implicit = false): [number, number] {
  const s = AFFIXES[stat];
  if (s.integer) return [1, grenadeCap(level, rarity)];
  const k = affixLevelScale(level) * RARITY_BUDGET[rarity] * (implicit ? IMPLICIT_SCALE : 1);
  return [round3(s.min * k), round3(s.max * k)];
}

function clone(d: GearDef): GearDef {
  return { ...d, implicit: { ...d.implicit }, affixes: d.affixes.map((a) => ({ ...a })) };
}

/** Recompute the presentation fields that derive from level/rarity. */
function refresh(d: GearDef): GearDef {
  d.league = leagueForLevel(d.level);
  d.growth = growthForLevel(d.level);
  d.color = gearBodyColor(d.rarity);
  d.accent = gearAccentColor(d.rarity, d.element);
  return d;
}

const rescale = (a: GearAffix, k: number): GearAffix =>
  AFFIXES[a.stat].integer ? makeAffix(a.stat, a.value) : makeAffix(a.stat, round3(a.value * k));

// ---- availability --------------------------------------------------------------------------
/** Why an upgrade is unavailable for a piece, or null when it can be applied. */
export function upgradeBlocker(kind: UpgradeKind, d: GearDef): string | null {
  switch (kind) {
    case 'reinforce': return d.level >= ECONOMY.maxItemLevel ? `MAX ILV ${ECONOMY.maxItemLevel}` : null;
    case 'retune': return null;
    case 'augment':
      if (d.affixes.length >= AFFIX_COUNT[d.rarity]) return `${d.rarity.toUpperCase()} CAP ${AFFIX_COUNT[d.rarity]} AFFIXES`;
      { const c = augmentCandidates(d); return c.primary.length + c.secondary.length ? null : 'NO AFFIX LEFT'; }
    case 'ascend': return d.rarity === 'legendary' ? 'LEGENDARY CAP' : null;
  }
}

// ---- reinforce -------------------------------------------------------------------------------
export function reinforce(d: GearDef): UpgradeResult {
  const why = upgradeBlocker('reinforce', d);
  if (why) return { ok: false, reason: why };
  const out = clone(d);
  const k = affixLevelScale(d.level + 1) / affixLevelScale(d.level);
  out.level = d.level + 1;
  out.implicit = rescale(out.implicit, k);
  out.affixes = out.affixes.map((a) => rescale(a, k));
  return { ok: true, item: refresh(out) };
}

// ---- retune ----------------------------------------------------------------------------------
/** Values a retune can target: 0 = implicit, then the rolled affixes in order. */
export const retuneTargets = (d: GearDef): GearAffix[] => [d.implicit, ...d.affixes];

export function retune(d: GearDef, index: number, rng: Rng): UpgradeResult {
  const targets = retuneTargets(d);
  if (!Number.isInteger(index) || index < 0 || index >= targets.length) return { ok: false, reason: 'PICK A STAT' };
  const out = clone(d);
  const cur = targets[index];
  const [lo, hi] = affixRange(cur.stat, d.level, d.rarity, index === 0);
  const value = AFFIXES[cur.stat].integer
    ? Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1)))
    : round3(randRange(rng, lo, hi));
  const next = makeAffix(cur.stat, value);
  if (index === 0) out.implicit = next;
  else out.affixes[index - 1] = next;
  return { ok: true, item: out };
}

// ---- augment ---------------------------------------------------------------------------------
/** Stats an augment may add: slot pools, no stat already rolled, status chance only on elemental pieces. */
export function augmentCandidates(d: GearDef): { primary: GearStat[]; secondary: GearStat[] } {
  const have = new Set(d.affixes.map((a) => a.stat));
  const ok = (s: GearStat) => !have.has(s) && (s !== 'elementChance' || !!d.element);
  return { primary: AFFIX_POOLS[d.slot].primary.filter(ok), secondary: AFFIX_POOLS[d.slot].secondary.filter(ok) };
}

export function augment(d: GearDef, rng: Rng): UpgradeResult {
  const why = upgradeBlocker('augment', d);
  if (why) return { ok: false, reason: why };
  const c = augmentCandidates(d);
  const from = c.primary.length && (rng() < PRIMARY_CHANCE || !c.secondary.length) ? c.primary : c.secondary;
  const stat = from[Math.floor(rng() * from.length)];
  const [lo, hi] = affixRange(stat, d.level, d.rarity);
  const value = AFFIXES[stat].integer ? Math.min(hi, lo + Math.floor(rng() * (hi - lo + 1))) : round3(randRange(rng, lo, hi));
  const out = clone(d);
  out.affixes.push(makeAffix(stat, value));
  return { ok: true, item: out };
}

// ---- ascend ----------------------------------------------------------------------------------
export function ascend(d: GearDef): UpgradeResult {
  const why = upgradeBlocker('ascend', d);
  if (why) return { ok: false, reason: why };
  const next = RARITY_ORDER[RARITY_ORDER.indexOf(d.rarity) + 1];
  const out = clone(d);
  const level = Math.min(ECONOMY.maxItemLevel, d.level + LEVEL_BONUS[next] - LEVEL_BONUS[d.rarity]);
  const k = (RARITY_BUDGET[next] / RARITY_BUDGET[d.rarity]) * (affixLevelScale(level) / affixLevelScale(d.level));
  out.rarity = next;
  out.level = level;
  out.implicit = rescale(out.implicit, k);
  out.affixes = out.affixes.map((a) => rescale(a, k));
  if (next === 'legendary' && !out.name.startsWith('★')) out.name = `★ ${out.name}`;
  return { ok: true, item: refresh(out) };
}

/** Apply one upgrade by kind (retune needs `index`). */
export function applyUpgrade(kind: UpgradeKind, d: GearDef, rng: Rng, index = 0): UpgradeResult {
  switch (kind) {
    case 'reinforce': return reinforce(d);
    case 'retune': return retune(d, index, rng);
    case 'augment': return augment(d, rng);
    case 'ascend': return ascend(d);
  }
}
