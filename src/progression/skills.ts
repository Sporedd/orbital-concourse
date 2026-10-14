/**
 * Data-driven skill trees (docs/SKILL_TREE.md §3): four class trees (3 branches × 6 nodes + a
 * capstone) and the shared Pit tree. Adding a node = adding one entry below.
 *
 * Node behaviour lives in one of three places:
 *  - `apply()` (and `extra()`) here: static stats, recomputed on every invest;
 *  - effects.ts CONDITIONALS / buffs: PlayerStats modifiers evaluated whenever stats are read;
 *  - effects.ts event listeners: everything triggered by kills, hits, pickups, the crowd…
 * Nodes that need player code carry `hook: 'player:<name>'`; they are live once that hook is in
 * WIRED_PLAYER_HOOKS (the player code reads it), otherwise `implemented: false` (SOON).
 */
import type { PlayerStats, SkillNode } from '@/core/types';
import { CLASSES, CLASS_IDS, PIT, type ClassId, type TreeId } from './classes';

export type NodeKind = 'passive' | 'keystone' | 'capstone';
/** stat = apply(); cond = read-time modifier; buff = timed modifier; event = listener; player:* = needs player code. */
export type HookKind = 'stat' | 'cond' | 'buff' | 'event' | `player:${string}`;
export type Tier = 1 | 2 | 3 | 4;

/** Non-PlayerStats numbers (docs §5). Mirrors GearStats conventions; neutral = baseExtras(). */
export interface SkillExtras {
  meleeMult: number;
  extraGrenades: number;
  grenadeDamageMult: number;
  grenadeRadiusMult: number;
  adsSpreadMult: number;
  shieldRegenMult: number;
  abilityCooldownMult: number;
}

export const baseExtras = (): SkillExtras => ({
  meleeMult: 1, extraGrenades: 0, grenadeDamageMult: 1, grenadeRadiusMult: 1, adsSpreadMult: 1, shieldRegenMult: 1, abilityCooldownMult: 1,
});

export interface SkillDef extends SkillNode {
  /** Class tree the node belongs to, or 'pit' (shared). */
  classId: TreeId;
  /** 'vanguard_a' … 'showman_c', 'pit', or '<class>_cap' for the capstone. */
  branch: string;
  tier: Tier;
  /** Grid hint: column inside the branch (0 / 1); the capstone is centred. */
  col: number;
  kind: NodeKind;
  /** Plinth label: A1…C6, P1…P5, CX. */
  code: string;
  flavour: string;
  /** Per-rank amount for {value} in the description, e.g. "8%". */
  value: string;
  /** Numeric per-rank amount for rank totals (with `unit`/`sign`); undefined = no total. */
  perRank?: number;
  unit: string;
  sign: '+' | '−' | '';
  hook: HookKind;
  /** False until every part of the node works in game (rendered dimmed "SOON"). */
  implemented: boolean;
  /** Non-PlayerStats static effects. */
  extra?(extras: SkillExtras, rank: number): void;
}

export interface BranchDef {
  id: string;
  name: string;
  classId: TreeId;
  letter: string;
  color: number;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
/** Points needed in the node's own branch to open a tier (index = tier). */
export const TIER_GATE: readonly number[] = [0, 0, 3, 6];
/** Points needed in the class tree to open the capstone. */
export const CAPSTONE_GATE = 25;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
interface NodeOpts {
  flavour: string;
  description: string;
  perRank?: number;
  unit?: string;
  sign?: '+' | '−' | '';
  /** Override the {value} text (default derived from perRank/unit). */
  value?: string;
  hook: HookKind;
  requires?: string;
  apply?: (stats: PlayerStats, rank: number) => void;
  extra?: (x: SkillExtras, rank: number) => void;
  implemented?: boolean;
}

const fmtNum = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

const LETTER = { a: 'A', b: 'B', c: 'C' } as const;

/** `player:*` hooks the player code implements (docs §5.1). Nodes on any other player hook are SOON. */
export const WIRED_PLAYER_HOOKS: ReadonlySet<string> = new Set([
  'player:activeKey', // src/player/index.ts (Q → useActive)
  'player:secondWind', // src/player/index.ts takeDamage
  'player:overheat', // src/player/weapons.ts heat
  'player:ricochetDoctrine', // src/player/weapons.ts doctrineTarget
  'player:extras', // grenades.ts / shared.ts maxGrenades
  'player:extras.extraGrenades',
  'player:extras.grenadeDamageMult',
  'player:extras.grenadeRadiusMult',
  'player:extras.adsSpreadMult', // weapons.ts currentSpread
]);

function make(
  classId: TreeId, slot: 'a' | 'b' | 'c' | 'pit' | 'cap', tier: Tier, col: number, code: string,
  id: string, name: string, kind: NodeKind, maxRank: number, o: NodeOpts,
): SkillDef {
  const unit = o.unit ?? (o.perRank !== undefined ? '%' : '');
  const sign = o.sign ?? (o.perRank !== undefined ? '+' : '');
  const value = o.value ?? (o.perRank !== undefined ? `${fmtNum(o.perRank)}${unit}` : '');
  const branch = slot === 'pit' ? PIT : `${classId}_${slot}`;
  const implemented = o.implemented ?? (!o.hook.startsWith('player:') || WIRED_PLAYER_HOOKS.has(o.hook));
  return {
    id, name, branch, classId, tier, col, kind, code, maxRank,
    requires: o.requires,
    description: o.description,
    flavour: o.flavour,
    value,
    perRank: o.perRank,
    unit,
    sign,
    hook: o.hook,
    implemented,
    apply: o.apply ?? (() => {}),
    extra: o.extra,
  };
}

/** stats[key] *= 1 + v·rank (v negative for reductions). */
const mul = (key: keyof PlayerStats, v: number) => (s: PlayerStats, r: number) => {
  s[key] *= 1 + v * r;
};
/** Several fixed (rank-1) multipliers at once (keystones). */
const fixed = (m: Partial<Record<keyof PlayerStats, number>>) => (s: PlayerStats) => {
  for (const k of Object.keys(m) as (keyof PlayerStats)[]) s[k] *= 1 + (m[k] ?? 0);
};

/** Branch node: code = letter + 1..6 from (tier, col). */
function bn(
  classId: ClassId, slot: 'a' | 'b' | 'c', tier: 1 | 2 | 3, col: 0 | 1,
  id: string, name: string, kind: NodeKind, maxRank: number, o: NodeOpts,
): SkillDef {
  return make(classId, slot, tier, col, `${LETTER[slot]}${(tier - 1) * 2 + col + 1}`, id, name, kind, maxRank, o);
}
const cap = (classId: ClassId, id: string, name: string, o: NodeOpts) =>
  make(classId, 'cap', 4, 0, 'CX', id, name, 'capstone', 1, o);
const pit = (tier: 1 | 2 | 3, col: number, n: number, id: string, name: string, maxRank: number, o: NodeOpts) =>
  make(PIT, 'pit', tier, col, `P${n}`, id, name, 'passive', maxRank, o);

// ---------------------------------------------------------------------------
// Vanguard
// ---------------------------------------------------------------------------
const VANGUARD: SkillDef[] = [
  bn('vanguard', 'a', 1, 0, 'van_plating', 'Reinforced Plating', 'passive', 3, {
    flavour: 'Bolted on between bouts. Rattles when you walk. Holds when it counts.',
    description: '+{value} shield capacity per rank (recharge scales with it).',
    perRank: 8, hook: 'stat', apply: mul('shieldMult', 0.08),
  }),
  bn('vanguard', 'a', 1, 1, 'van_constitution', 'Iron Constitution', 'passive', 3, {
    flavour: 'Three meals a day, all of them protein paste.',
    description: '+{value} max health per rank.',
    perRank: 6, hook: 'stat', apply: mul('healthMult', 0.06),
  }),
  bn('vanguard', 'a', 2, 0, 'van_scar_tissue', 'Scar Tissue', 'passive', 3, {
    flavour: 'Every break leaves something harder behind.',
    description: 'When your shield breaks, heal {value} of max health per rank (6 s cooldown).',
    perRank: 4, hook: 'event', requires: 'van_plating',
  }),
  bn('vanguard', 'a', 2, 1, 'van_overcharge', 'Overcharge Cell', 'keystone', 1, {
    flavour: 'Illegal in three leagues. The crowd loves it in all of them.',
    description: 'When your shield breaks it snaps back to 40% at once (15 s cooldown).',
    value: '40%', hook: 'event', requires: 'van_plating',
  }),
  bn('vanguard', 'a', 3, 0, 'van_hold_line', 'Hold the Line', 'passive', 2, {
    flavour: 'Untouched is a statement.',
    description: '+{value} gun damage per rank while your shield is full.',
    perRank: 6, hook: 'cond', requires: 'van_scar_tissue',
  }),
  bn('vanguard', 'a', 3, 1, 'van_immovable', 'Immovable', 'keystone', 1, {
    flavour: 'You do not dodge. Things bounce.',
    description: '+35% shield capacity, −10% move speed.',
    hook: 'stat', requires: 'van_overcharge', apply: fixed({ shieldMult: 0.35, moveSpeedMult: -0.1 }),
  }),

  bn('vanguard', 'b', 1, 0, 'van_heavy_hands', 'Heavy Hands', 'passive', 3, {
    flavour: 'The gun is for the ones too far away to punch.',
    description: '+{value} melee damage per rank.',
    perRank: 15, hook: 'event', extra: (x, r) => { x.meleeMult *= 1 + 0.15 * r; },
  }),
  bn('vanguard', 'b', 1, 1, 'van_knuckles', 'Iron Knuckles', 'passive', 3, {
    flavour: 'Capacitor plates in the gloves. Every punch tops you up.',
    description: 'Melee hits restore {value} of max shield per rank.',
    perRank: 4, hook: 'event',
  }),
  bn('vanguard', 'b', 2, 0, 'van_finisher', 'Finisher', 'passive', 3, {
    flavour: 'Close the show yourself.',
    description: 'Melee kills heal {value} of max health per rank.',
    perRank: 5, hook: 'event', requires: 'van_heavy_hands',
  }),
  bn('vanguard', 'b', 2, 1, 'van_crowd_work', 'Crowd Work', 'keystone', 1, {
    flavour: 'Put one down by hand and the stands throw you a present.',
    description: 'Melee kills refund a grenade (4 s cooldown) and add 6 hype.',
    hook: 'event', requires: 'van_knuckles',
  }),
  bn('vanguard', 'b', 3, 0, 'van_momentum', 'Momentum', 'passive', 2, {
    flavour: 'Keep moving or they start counting.',
    description: 'Melee kills give +{value} move speed per rank for 4 s.',
    perRank: 8, hook: 'buff', requires: 'van_finisher',
  }),
  bn('vanguard', 'b', 3, 1, 'van_executioner', 'Executioner', 'keystone', 1, {
    flavour: 'Thumbs down.',
    description: 'Melee hits finish non-boss enemies below 25% health. Bosses take +50% melee damage.',
    value: '25%', hook: 'event', requires: 'van_crowd_work',
  }),

  bn('vanguard', 'c', 1, 0, 'van_brute_force', 'Brute Force', 'passive', 3, {
    flavour: 'Aim is a suggestion.',
    description: '+{value} gun damage per rank.',
    perRank: 4, hook: 'stat', apply: mul('damageMult', 0.04),
  }),
  bn('vanguard', 'c', 1, 1, 'van_showboat', 'Showboat', 'passive', 3, {
    flavour: 'Up close, where the cameras are.',
    description: 'Kills within 6 m add {value} hype per rank.',
    perRank: 2, unit: '', hook: 'event',
  }),
  bn('vanguard', 'c', 2, 0, 'van_bloodlust', 'Bloodlust', 'passive', 3, {
    flavour: 'One down. The trigger finger wants more.',
    description: 'Kills give +{value} fire rate per rank for 4 s.',
    perRank: 4, hook: 'buff', requires: 'van_brute_force',
  }),
  bn('vanguard', 'c', 2, 1, 'van_juggernaut', 'Juggernaut', 'keystone', 1, {
    flavour: 'Shields are for people who plan on getting hit less.',
    description: '+30% max health, −30% shield capacity.',
    hook: 'stat', requires: 'van_showboat', apply: fixed({ healthMult: 0.3, shieldMult: -0.3 }),
  }),
  bn('vanguard', 'c', 3, 0, 'van_last_stand', 'Last Stand', 'passive', 2, {
    flavour: 'The crowd goes quiet. You get loud.',
    description: '+{value} gun damage per rank while below 35% health.',
    perRank: 10, hook: 'cond', requires: 'van_bloodlust',
  }),
  bn('vanguard', 'c', 3, 1, 'van_center_ring', 'Center Ring', 'keystone', 1, {
    flavour: 'Surrounded is just another word for target-rich.',
    description: 'While 3+ enemies are within 8 m: +20% gun damage and fire rate.',
    value: '20%', hook: 'cond', requires: 'van_juggernaut',
  }),
  cap('vanguard', 'van_unbroken', 'Unbroken', {
    flavour: 'They brought the whole wave. You brought a wall.',
    description: 'Kills restore 8% of max shield. While the shield is down they heal 4% of max health instead.',
    hook: 'event',
  }),
];

// ---------------------------------------------------------------------------
// Marksman
// ---------------------------------------------------------------------------
const MARKSMAN: SkillDef[] = [
  bn('marksman', 'a', 1, 0, 'mar_steady', 'Steady Hand', 'passive', 3, {
    flavour: 'Breathe out. Squeeze. Collect.',
    description: '+{value} crit damage per rank.',
    perRank: 10, hook: 'stat', apply: mul('critMult', 0.1),
  }),
  bn('marksman', 'a', 1, 1, 'mar_calibre', 'Heavy Calibre', 'passive', 3, {
    flavour: 'Hand-loaded the night before.',
    description: '+{value} gun damage per rank.',
    perRank: 4, hook: 'stat', apply: mul('damageMult', 0.04),
  }),
  bn('marksman', 'a', 2, 0, 'mar_headhunter', 'Headhunter', 'passive', 3, {
    flavour: 'One clean shot sharpens the next.',
    description: 'Crit kills give +{value} gun damage per rank for 5 s.',
    perRank: 5, hook: 'buff', requires: 'mar_steady',
  }),
  bn('marksman', 'a', 2, 1, 'mar_bullseye', 'Bullseye', 'keystone', 1, {
    flavour: 'The perfect shot pays for itself.',
    description: 'Crit hits put a round back in the magazine (once per shot).',
    hook: 'event', requires: 'mar_calibre',
  }),
  bn('marksman', 'a', 3, 0, 'mar_patience', 'Patience', 'passive', 2, {
    flavour: 'The crowd counts down with you.',
    description: '+{value} crit damage per rank on the first shot after 1 s without firing.',
    perRank: 12, hook: 'cond', requires: 'mar_headhunter',
  }),
  bn('marksman', 'a', 3, 1, 'mar_glass_jaw', 'Glass Jaw', 'keystone', 1, {
    flavour: 'Hit first, hit hard, never get hit.',
    description: '+25% gun damage, −40% shield capacity (and recharge).',
    hook: 'stat', requires: 'mar_bullseye', apply: fixed({ damageMult: 0.25, shieldMult: -0.4 }),
  }),

  bn('marksman', 'b', 1, 0, 'mar_breath', 'Breath Control', 'passive', 3, {
    flavour: 'Slow the heart, still the sights.',
    description: '−{value} spread per rank while aiming down sights.',
    perRank: 10, sign: '−', hook: 'player:extras.adsSpreadMult', extra: (x, r) => { x.adsSpreadMult *= 1 - 0.1 * r; },
  }),
  bn('marksman', 'b', 1, 1, 'mar_quickdraw', 'Quickdraw', 'passive', 3, {
    flavour: 'Practised until the hands forgot to be slow.',
    description: '−{value} reload time per rank.',
    perRank: 5, sign: '−', hook: 'stat', apply: mul('reloadMult', -0.05),
  }),
  bn('marksman', 'b', 2, 0, 'mar_scoped', 'Scoped In', 'passive', 3, {
    flavour: 'The arena shrinks to one circle.',
    description: '+{value} gun damage per rank while aiming down sights.',
    perRank: 5, hook: 'cond', requires: 'mar_quickdraw',
  }),
  bn('marksman', 'b', 2, 1, 'mar_ricochet', 'Ricochet Doctrine', 'keystone', 1, {
    flavour: 'Close counts. You made sure of it.',
    description: 'Bullets that miss within 2 m of an enemy curve into it for 70% damage (once per shot).',
    value: '2 m', hook: 'player:ricochetDoctrine', requires: 'mar_quickdraw',
  }),
  bn('marksman', 'b', 3, 0, 'mar_specialist', 'Specialist', 'passive', 2, {
    flavour: 'Two guns. Thousands of hours.',
    description: '+{value} gun damage per rank with a pistol or sniper.',
    perRank: 8, hook: 'cond', requires: 'mar_scoped',
  }),
  bn('marksman', 'b', 3, 1, 'mar_one_shot', 'One Shot, One Kill', 'keystone', 1, {
    flavour: 'Why fire twice?',
    description: 'Pistols and snipers: +30% gun damage and crit damage, −20% fire rate.',
    hook: 'cond', requires: 'mar_scoped',
  }),

  bn('marksman', 'c', 1, 0, 'mar_light_step', 'Light Step', 'passive', 3, {
    flavour: 'Never where the last shot came from.',
    description: '+{value} move speed per rank.',
    perRank: 3, hook: 'stat', apply: mul('moveSpeedMult', 0.03),
  }),
  bn('marksman', 'c', 1, 1, 'mar_vantage', 'Vantage', 'passive', 3, {
    flavour: 'Mid-air, the whole pit lines up.',
    description: '+{value} crit damage per rank while airborne.',
    perRank: 8, hook: 'cond',
  }),
  bn('marksman', 'c', 2, 0, 'mar_reposition', 'Reposition', 'passive', 3, {
    flavour: 'Shoot. Move. Let them guess.',
    description: 'Crit kills give +{value} move speed per rank for 3 s.',
    perRank: 5, hook: 'buff', requires: 'mar_light_step',
  }),
  bn('marksman', 'c', 2, 1, 'mar_trophy', 'Trophy Hunter', 'keystone', 1, {
    flavour: 'Headliners only. The rest is warm-up.',
    description: 'Boss kills grant ×1.5 standing.',
    value: '×1.5', hook: 'event', requires: 'mar_vantage',
  }),
  bn('marksman', 'c', 3, 0, 'mar_spotter', 'Spotter', 'passive', 2, {
    flavour: 'Tagged rounds. Live current.',
    description: 'Crits have a {value} chance per rank to shock the target, chaining 25% of the hit.',
    perRank: 10, hook: 'event', requires: 'mar_reposition',
  }),
  bn('marksman', 'c', 3, 1, 'mar_big_game', 'Big Game', 'keystone', 1, {
    flavour: 'You came for the headliner. The rest is noise.',
    description: '+20% gun damage while a boss is alive, −10% otherwise.',
    hook: 'cond', requires: 'mar_trophy',
  }),
  cap('marksman', 'mar_perfect_form', 'Perfect Form', {
    flavour: 'The scoreboard stops counting misses because there are none.',
    description: 'Every crit hit gives +2% crit damage for 6 s, up to 15 stacks. A shot with only body hits removes 3.',
    hook: 'event',
  }),
];

// ---------------------------------------------------------------------------
// Technician
// ---------------------------------------------------------------------------
const TECHNICIAN: SkillDef[] = [
  bn('technician', 'a', 1, 0, 'tec_conductor', 'Conductor', 'passive', 3, {
    flavour: 'Better wiring, worse burns. For them.',
    description: 'Elemental hits have an extra {value} chance per rank to apply their status.',
    perRank: 5, hook: 'event',
  }),
  bn('technician', 'a', 1, 1, 'tec_overclock', 'Overclock', 'passive', 3, {
    flavour: 'Warranty void.',
    description: '+{value} fire rate per rank.',
    perRank: 4, hook: 'stat', apply: mul('fireRateMult', 0.04),
  }),
  bn('technician', 'a', 2, 0, 'tec_catalyst', 'Catalyst', 'passive', 3, {
    flavour: 'What goes in charged comes out loud.',
    description: 'Elemental kills burst for {value} of the victim\'s max health per rank in 3 m.',
    perRank: 10, hook: 'event', requires: 'tec_conductor',
  }),
  bn('technician', 'a', 2, 1, 'tec_overheat', 'Overheat', 'keystone', 1, {
    flavour: 'Hold it down until the barrel glows.',
    description: 'Fire rate ramps up to +40% over 1.5 s of sustained fire; spread grows up to +50%.',
    value: '40%', hook: 'player:overheat', requires: 'tec_overclock',
  }),
  bn('technician', 'a', 3, 0, 'tec_affinity', 'Elemental Affinity', 'passive', 2, {
    flavour: 'You tune the element, the element tunes you.',
    description: '+{value} gun damage per rank with an elemental weapon.',
    perRank: 8, hook: 'cond', requires: 'tec_catalyst',
  }),
  bn('technician', 'a', 3, 1, 'tec_meltdown', 'Meltdown', 'keystone', 1, {
    flavour: 'Everything that burns, burns twice.',
    description: 'Burning enemies explode on death: 25% of their max health as fire damage in 4 m, igniting what survives.',
    value: '25%', hook: 'event', requires: 'tec_catalyst',
  }),

  bn('technician', 'b', 1, 0, 'tec_payload', 'Bigger Payload', 'passive', 3, {
    flavour: 'More boom per gram.',
    description: '+{value} grenade damage per rank.',
    perRank: 12, hook: 'player:extras.grenadeDamageMult', extra: (x, r) => { x.grenadeDamageMult *= 1 + 0.12 * r; },
  }),
  bn('technician', 'b', 1, 1, 'tec_recycler', 'Recycler', 'passive', 3, {
    flavour: 'Pins, spoons, casings. It all goes back in the bag.',
    description: 'Grenade kills have a {value} chance per rank to refund a grenade.',
    perRank: 15, hook: 'event',
  }),
  bn('technician', 'b', 2, 0, 'tec_cluster', 'Cluster Charge', 'passive', 3, {
    flavour: 'One grenade, several opinions.',
    description: 'Grenade kills set off a 3 m blast for {value} damage per rank (× gun damage).',
    perRank: 30, unit: '', hook: 'event', requires: 'tec_recycler',
  }),
  bn('technician', 'b', 2, 1, 'tec_resupply', 'Field Resupply', 'keystone', 1, {
    flavour: 'A crate with your name stencilled on it, every round.',
    description: 'Round start and every boss phase break: grenades to max and +50% of a reserve load.',
    hook: 'event', requires: 'tec_recycler',
  }),
  bn('technician', 'b', 3, 0, 'tec_wide', 'Wide Spread', 'passive', 2, {
    flavour: 'Shaped charges, shaped wide.',
    description: '+{value} grenade radius per rank.',
    perRank: 15, hook: 'player:extras.grenadeRadiusMult', requires: 'tec_cluster', extra: (x, r) => { x.grenadeRadiusMult *= 1 + 0.15 * r; },
  }),
  bn('technician', 'b', 3, 1, 'tec_ordnance', 'Ordnance Bay', 'keystone', 1, {
    flavour: 'You stopped carrying spare mags.',
    description: '+2 max grenades and +30% grenade damage, −10% gun damage.',
    hook: 'player:extras', requires: 'tec_resupply',
    apply: fixed({ damageMult: -0.1 }),
    extra: (x) => { x.extraGrenades += 2; x.grenadeDamageMult *= 1.3; },
  }),

  bn('technician', 'c', 1, 0, 'tec_scrounger', 'Scrounger', 'passive', 3, {
    flavour: 'Half the arena is loose rounds if you know where to look.',
    description: 'Ammo pickups give {value} more per rank.',
    perRank: 20, hook: 'event',
  }),
  bn('technician', 'c', 1, 1, 'tec_field_medic', 'Field Medic', 'passive', 3, {
    flavour: 'Read the label. Then double it.',
    description: 'Health pickups heal {value} more per rank.',
    perRank: 15, hook: 'event',
  }),
  bn('technician', 'c', 2, 0, 'tec_kitted', 'Kitted Out', 'passive', 3, {
    flavour: 'Every piece talks to every other piece.',
    description: '+{value} gun damage per equipped gear piece per rank.',
    perRank: 1.5, hook: 'cond', requires: 'tec_scrounger',
  }),
  bn('technician', 'c', 2, 1, 'tec_salvage', 'Salvage Rights', 'keystone', 1, {
    flavour: 'Signed, stamped, and very much in your favour.',
    description: 'Your kills have a 6% chance to drop an extra item.',
    value: '6%', hook: 'event', requires: 'tec_field_medic',
  }),
  bn('technician', 'c', 3, 0, 'tec_tuning', 'Shield Tuning', 'passive', 2, {
    flavour: 'Recalibrated between rounds, on the floor of the airlock.',
    description: '+{value} shield capacity per rank.',
    perRank: 8, hook: 'stat', requires: 'tec_kitted', apply: mul('shieldMult', 0.08),
  }),
  bn('technician', 'c', 3, 1, 'tec_siphon', 'Power Siphon', 'keystone', 1, {
    flavour: 'Their current, your capacitor.',
    description: 'Kills by elemental status (burn ticks, shock chains) restore 10% of max shield.',
    value: '10%', hook: 'event', requires: 'tec_salvage',
  }),
  cap('technician', 'tec_storm_engine', 'Storm Engine', {
    flavour: 'The rig decides when it has had enough.',
    description: 'Shock Pulse fires on its own when your shield breaks (if ready), and its cooldown is 30% shorter.',
    hook: 'event', extra: (x) => { x.abilityCooldownMult *= 0.7; },
  }),
];

// ---------------------------------------------------------------------------
// Showman
// ---------------------------------------------------------------------------
const SHOWMAN: SkillDef[] = [
  bn('showman', 'a', 1, 0, 'sho_crowd_fav', 'Crowd Favourite', 'passive', 3, {
    flavour: 'They know your name. They chant it wrong. They chant it loud.',
    description: '+{value} hype gains per rank.',
    perRank: 10, hook: 'event',
  }),
  bn('showman', 'a', 1, 1, 'sho_spray', 'Spray and Pray', 'passive', 3, {
    flavour: 'Accuracy is for people with fewer bullets.',
    description: '+{value} fire rate per rank with an SMG or shotgun.',
    perRank: 5, hook: 'cond',
  }),
  bn('showman', 'a', 2, 0, 'sho_feed', 'Feed Off the Crowd', 'passive', 3, {
    flavour: 'Louder stands, harder hits.',
    description: '+{value} gun damage per rank for every crowd tier above Cold.',
    perRank: 3, hook: 'cond', requires: 'sho_crowd_fav',
  }),
  bn('showman', 'a', 2, 1, 'sho_showstopper', 'Showstopper', 'keystone', 1, {
    flavour: 'Three at once, and the band plays you a fresh mag.',
    description: 'Multi-kills refill your magazine.',
    hook: 'event', requires: 'sho_spray',
  }),
  bn('showman', 'a', 3, 0, 'sho_curtain', 'Curtain Call', 'passive', 2, {
    flavour: 'Always leave them wanting more. Soon.',
    description: '−{value} Encore cooldown per rank.',
    perRank: 15, sign: '−', hook: 'player:activeKey', requires: 'sho_feed', extra: (x, r) => { x.abilityCooldownMult *= 1 - 0.15 * r; },
  }),
  bn('showman', 'a', 3, 1, 'sho_sponsor', 'Sponsor\'s Favourite', 'keystone', 1, {
    flavour: 'The logo on your chest is paying for the drinks.',
    description: 'Bosses drop one extra item for you, with a rarity boost.',
    value: '+1', hook: 'event', requires: 'sho_showstopper',
  }),

  bn('showman', 'b', 1, 0, 'sho_footwork', 'Footwork', 'passive', 3, {
    flavour: 'Dance like the floor is armed. It sometimes is.',
    description: '+{value} move speed per rank.',
    perRank: 4, hook: 'stat', apply: mul('moveSpeedMult', 0.04),
  }),
  bn('showman', 'b', 1, 1, 'sho_in_your_face', 'In Your Face', 'passive', 3, {
    flavour: 'Close enough to read the serial number.',
    description: '+{value} gun damage per rank with an SMG or shotgun.',
    perRank: 6, hook: 'cond',
  }),
  bn('showman', 'b', 2, 0, 'sho_hit_run', 'Hit and Run', 'passive', 3, {
    flavour: 'Take a bow on the way out.',
    description: 'Kills give +{value} move speed per rank for 3 s.',
    perRank: 4, hook: 'buff', requires: 'sho_footwork',
  }),
  bn('showman', 'b', 2, 1, 'sho_point_blank', 'Point Blank', 'keystone', 1, {
    flavour: 'Personal space is a myth the gate crew tells rookies.',
    description: 'While an enemy is within 5 m: +25% gun damage and crit damage.',
    value: '25%', hook: 'cond', requires: 'sho_in_your_face',
  }),
  bn('showman', 'b', 3, 0, 'sho_aerialist', 'Aerialist', 'passive', 2, {
    flavour: 'The best seats look up.',
    description: '+{value} gun damage per rank while airborne.',
    perRank: 8, hook: 'cond', requires: 'sho_hit_run',
  }),
  bn('showman', 'b', 3, 1, 'sho_daredevil', 'Daredevil', 'keystone', 1, {
    flavour: 'Bleeding is just stage makeup with commitment.',
    description: '−15% max health. Below 50% health: +20% gun damage and fire rate.',
    value: '20%', hook: 'cond', requires: 'sho_point_blank', apply: fixed({ healthMult: -0.15 }),
  }),

  bn('showman', 'c', 1, 0, 'sho_lucky', 'Lucky Break', 'passive', 3, {
    flavour: 'Some nights the floor just gives.',
    description: 'Kills have a {value} chance per rank to drop an ammo, health or grenade pickup.',
    perRank: 2, hook: 'event',
  }),
  bn('showman', 'c', 1, 1, 'sho_tip_jar', 'Tip Jar', 'passive', 3, {
    flavour: 'The front row pays extra.',
    description: '+{value} standing from crowd milestones per rank.',
    perRank: 15, hook: 'event',
  }),
  bn('showman', 'c', 2, 0, 'sho_jackpot', 'Jackpot', 'passive', 3, {
    flavour: 'Line up the headshot. Pull the lever.',
    description: 'Crit kills have a {value} chance per rank to drop a weapon.',
    perRank: 3, hook: 'event', requires: 'sho_lucky',
  }),
  bn('showman', 'c', 2, 1, 'sho_fan_service', 'Fan Service', 'keystone', 1, {
    flavour: 'Give the people what they want, and they give it back.',
    description: 'When the crowd reaches HOT or ROARING: grenades to max, heal 25% and fill your shield (20 s cooldown).',
    value: '25%', hook: 'event', requires: 'sho_tip_jar',
  }),
  bn('showman', 'c', 3, 0, 'sho_high_roller', 'High Roller', 'passive', 2, {
    flavour: 'Double or nothing, every trigger pull.',
    description: 'Kills have a {value} chance per rank to refill your magazine.',
    perRank: 5, hook: 'event', requires: 'sho_jackpot',
  }),
  bn('showman', 'c', 3, 1, 'sho_glory', 'Glory Hound', 'keystone', 1, {
    flavour: 'The roar is better than any medkit.',
    description: 'Kills while the crowd is HOT or louder heal 3% of max health and restore 5% of max shield.',
    hook: 'event', requires: 'sho_fan_service',
  }),
  cap('showman', 'sho_ovation', 'Standing Ovation', {
    flavour: 'Forty thousand people on their feet, and every one of them is yours.',
    description: 'While the crowd is ROARING: +25% gun damage, +25% fire rate, +15% move speed.',
    hook: 'cond',
  }),
];

// ---------------------------------------------------------------------------
// The Pit (shared)
// ---------------------------------------------------------------------------
const PIT_NODES: SkillDef[] = [
  pit(1, 0, 1, 'reload', 'Quick Hands', 3, {
    flavour: 'Mag out, mag in, before the echo.',
    description: '−{value} reload time per rank.',
    perRank: 6, sign: '−', hook: 'stat', apply: mul('reloadMult', -0.06),
  }),
  pit(1, 1, 2, 'speed', 'Fleet Foot', 3, {
    flavour: 'The pit floor is hot. Keep your feet light.',
    description: '+{value} movement speed per rank.',
    perRank: 4, hook: 'stat', apply: mul('moveSpeedMult', 0.04),
  }),
  pit(2, 0, 3, 'pit_bandolier', 'Bandolier', 2, {
    flavour: 'One more loop on the strap.',
    description: '+{value} max grenades per rank.',
    perRank: 1, unit: '', hook: 'player:extras.extraGrenades', requires: 'reload', extra: (x, r) => { x.extraGrenades += r; },
  }),
  pit(2, 1, 4, 'pit_pack_mule', 'Pack Mule', 1, {
    flavour: 'Every round you walk out with more than you walked in with.',
    description: 'Round clears give +1 grenade and 50% of a reserve load.',
    hook: 'event', requires: 'speed',
  }),
  pit(3, 0, 5, 'pit_second_wind', 'Second Wind', 1, {
    flavour: 'Not yet.',
    description: 'Once per round, lethal damage leaves you at 1 HP with half a shield and 2 s of invulnerability.',
    value: '2 s', hook: 'player:secondWind', requires: 'pit_pack_mule',
  }),
];

export const SKILLS: SkillDef[] = [...VANGUARD, ...MARKSMAN, ...TECHNICIAN, ...SHOWMAN, ...PIT_NODES];

export const BRANCHES: BranchDef[] = [
  ...CLASS_IDS.flatMap((c) => CLASSES[c].branches.map((name, i) => ({
    id: `${c}_${'abc'[i]}`, name, classId: c as TreeId, letter: 'ABC'[i], color: 0xecEae4,
  }))),
  { id: PIT, name: 'The Pit', classId: PIT, letter: 'P', color: 0xecEae4 },
];

/** Ids from the v1 placeholder tree that live on in the Pit (same id, same name). */
export const LEGACY_IDS: readonly string[] = ['reload', 'speed'];

const BY_ID = new Map<string, SkillDef>();
export function skillById(id: string): SkillDef | undefined {
  // rebuilt lazily so tests can push temporary nodes into SKILLS
  if (BY_ID.size !== SKILLS.length) {
    BY_ID.clear();
    for (const s of SKILLS) BY_ID.set(s.id, s);
  }
  return BY_ID.get(id);
}

/** Nodes of one class tree (without the Pit). */
export const classSkills = (classId: ClassId) => SKILLS.filter((s) => s.classId === classId);
export const pitSkills = () => SKILLS.filter((s) => s.classId === PIT);
/** Nodes a player of `classId` can see: the class tree + the Pit (only the Pit without a class). */
export const visibleSkills = (classId: ClassId | null) =>
  SKILLS.filter((s) => s.classId === PIT || (classId !== null && s.classId === classId));

/** Total ranks of a list of nodes (the points budget). */
export const pointsBudget = (nodes: readonly SkillDef[]) => nodes.reduce((n, s) => n + s.maxRank, 0);

export const baseStats = (): PlayerStats => ({
  damageMult: 1, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1,
});

/** Description with {value} substituted (per-rank amount). */
export function describeSkill(node: SkillNode): string {
  const def = skillById(node.id);
  return node.description.replace('{value}', def ? def.value : '');
}

/** Total effect at a rank, e.g. "+16%" (or "" when the node has no per-rank number). */
export function rankValue(node: SkillDef, rank: number): string {
  if (node.perRank === undefined) return '';
  return `${node.sign}${fmtNum(node.perRank * rank)}${node.unit === '%' ? ' %' : node.unit ? ` ${node.unit}` : ''}`;
}
