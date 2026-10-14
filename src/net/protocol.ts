/**
 * Game protocol (rides inside the relay's `{ t: 'g', d }` envelope).
 *
 * JSON with a compact key scheme; floats quantised to 2 decimals (q2) on the way out.
 * Host → client: one targeted snapshot per client at 20 Hz ('s'), plus a welcome ('w').
 *   Enemies are delta-compressed against what that client last received (the WebSocket is
 *   reliable + ordered, so no acks are needed); loot is filtered by ownerId and sent as
 *   add/remove deltas; one-shot events and fx ride in the same snapshot so they are applied
 *   after the entity state they refer to.
 * Client → host: one tick at 30 Hz ('c') carrying input + everything that happened since the
 *   last tick (shots with hit claims, melee hits, area damage, pickup requests, fx, heals).
 */
import type {
  BossKind, Element, LootKind, MobKind, Rarity, RoundPhase, WeaponArchetype, WeaponDef,
} from '@/core/types';
import { ADS, accuracyFromSpread } from '@/core/config';
import { GEAR_SLOTS, type GearDef, type Loadout } from '@/gear/types';
import { sanitizeGear } from '@/gear/inventory';

// ---------------------------------------------------------------------------
// Enum tables (index on the wire)
// ---------------------------------------------------------------------------
export const KINDS: readonly (MobKind | BossKind)[] = ['grunt', 'spitter', 'bomber', 'brute', 'summoner', 'artillery'];
export const PHASES: readonly RoundPhase[] = ['idle', 'intermission', 'wave', 'boss', 'cleared', 'gameover'];
export const ELEMENTS: readonly Element[] = ['none', 'fire', 'shock', 'ice'];
export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const ARCHETYPES: readonly WeaponArchetype[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];
/** Append-only (indices are on the wire). */
export const LOOT_KINDS: readonly LootKind[] = ['weapon', 'ammo', 'health', 'grenade', 'gear'];
export const BOSS_KINDS: readonly BossKind[] = ['brute', 'summoner', 'artillery'];

const idx = <T>(table: readonly T[], v: T): number => Math.max(0, table.indexOf(v));
const at = <T>(table: readonly T[], i: unknown): T => table[typeof i === 'number' && i >= 0 && i < table.length ? i : 0];

export const enc = {
  kind: (k: MobKind | BossKind) => idx(KINDS, k),
  phase: (p: RoundPhase) => idx(PHASES, p),
  element: (e: Element) => idx(ELEMENTS, e),
  rarity: (r: Rarity) => idx(RARITIES, r),
  arch: (a: WeaponArchetype) => idx(ARCHETYPES, a),
  loot: (k: LootKind) => idx(LOOT_KINDS, k),
  boss: (b: BossKind | undefined) => (b ? BOSS_KINDS.indexOf(b) : -1),
};
export const dec = {
  kind: (i: unknown) => at(KINDS, i),
  phase: (i: unknown) => at(PHASES, i),
  element: (i: unknown) => at(ELEMENTS, i),
  rarity: (i: unknown) => at(RARITIES, i),
  arch: (i: unknown) => at(ARCHETYPES, i),
  loot: (i: unknown) => at(LOOT_KINDS, i),
  boss: (i: unknown): BossKind | undefined => (typeof i === 'number' && i >= 0 ? at(BOSS_KINDS, i) : undefined),
};

// ---------------------------------------------------------------------------
// Quantisation
// ---------------------------------------------------------------------------
/** Round to 2 decimals (and kill -0 / NaN). */
export const q2 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};
export const q1 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
};
export type V3 = [number, number, number];
export const qv = (v: { x: number; y: number; z: number }): V3 => [q2(v.x), q2(v.y), q2(v.z)];

// ---------------------------------------------------------------------------
// Wire records
// ---------------------------------------------------------------------------
/** [round, phaseIdx, phaseTime, killsRequired, kills, subWave, totalKills, bossKindIdx | -1] */
export type RoundW = [number, number, number, number, number, number, number, number];

/** One enemy. In a delta only `i` plus the changed keys are present. */
export interface EnemyW {
  i: string;
  k: number; // kind
  b: 0 | 1; // isBoss
  t: number; // tier
  p: V3; // feet position
  y: number; // yaw
  h: number; // health (1 decimal)
  m: number; // maxHealth
  a: 0 | 1; // alive
  ph: number; // phase
  an: string; // anim
  s: [number, number][]; // statuses [elementIdx, remaining]
  fz: 0 | 1; // frozen
  sh: 0 | 1; // shielded / immune (summoner bubble)
}
export type EnemyDeltaW = Partial<EnemyW> & { i: string };

export interface PlayerW {
  i: string;
  n: string;
  p: V3;
  y: number;
  pt: number;
  h: number;
  mh: number;
  s: number;
  ms: number;
  a: 0 | 1;
  /** Active weapon for the avatar: [archetypeIdx, color, rarityIdx], or 0 when unarmed. */
  w: [number, number, number] | 0;
  /** Revive progress 0..1 while downed and someone is holding E. */
  rv?: number;
  /** Loadout version (host-side counter). A client that has a different version gets SnapMsg.ld. */
  lv?: number;
}

/**
 * A player's equipped gear (avatars wear it). Sent once per version per client in SnapMsg.ld,
 * not every snapshot: 5 GearDefs are 1–2 KiB. Validated with sanitizeLoadout on receipt.
 */
export interface LoadoutW {
  i: string;
  v: number;
  l: Loadout;
}

export interface LootW {
  i: string;
  k: number;
  r: number;
  p: V3;
  ag: number;
  w?: WeaponDef;
  /** Gear piece (kind 'gear'); validated with sanitizeGear on the client. */
  g?: GearDef;
}

/** Enemy projectiles: straight/homing shots and mortar shells. */
export interface ProjW {
  /** [id, kind(0 spit,1 orb), x,y,z, vx,vy,vz] */
  s: [string, number, number, number, number, number, number, number][];
  /** [id, fromX,fromY,fromZ, toX,toY,toZ, t, duration, apex, radius] */
  m: [string, number, number, number, number, number, number, number, number, number, number][];
}

/** Presentation fx replay. */
export type FxW =
  | ['t', number, number, number, number, number, number, number, number] // tracer from, to, color, width
  | ['i', number, number, number, number, number, number, number] // impact point, normal, color
  | ['x', number, number, number, number, number] // explosion center, radius, color
  | ['b', number, number, number, number, number]; // burst point, color, count

/** One-shot events (host → client). Player ids are host-side ids. */
export type EvW =
  | { e: 'rp'; ph: number; r: number } // round:phase
  | { e: 'ri'; r: number; s: number } // round:intermission
  | { e: 'rs'; r: number; kr: number } // round:started
  | { e: 'rw'; r: number; sw: number; tot: number } // round:subwave
  | { e: 'rg'; k: number; kr: number } // round:progress
  | { e: 'rb'; r: number; bk: number } // round:boss
  | { e: 'rc'; r: number } // round:cleared
  | { e: 'gs' } // game:started
  | { e: 'go'; r: number; k: number } // game:over
  | { e: 'bs'; i: string; nm: string } // boss:spawned
  | { e: 'bp'; i: string; ph: number } // boss:phase
  | { e: 'ek'; i: string; p: V3; b: 0 | 1; t: number; k?: string } // enemy:killed
  | { e: 'ea'; i: string; k: string } // enemy:attack
  | { e: 'dd'; i: string; a: number; c: 0 | 1; el: number; p: V3; kl: 0 | 1 } // damage:dealt (by this client)
  | { e: 'ui'; tx: string; d?: number; st?: 'info' | 'warning' | 'legendary' }
  | { e: 'pd'; i: string } // player:died
  | { e: 'hu'; a: number; el: number; f?: V3 } // this client got hurt (host applied it)
  | { e: 'pk'; i: string; ok: 0 | 1; k: number; w?: WeaponDef; g?: GearDef } // pickup result

  | { e: 'sh'; i: string; a: number; o: V3; d: V3 } // someone else fired (audio + avatar flash)
  | { e: 'rv'; i: string }; // player revived

export interface SnapMsg {
  t: 's';
  /** Sequence number (per client). */
  n: number;
  /** Host clock (seconds). */
  tm: number;
  r: RoundW;
  /** Enemies: full records for new ones, deltas for known ones, omitted when unchanged. */
  e?: EnemyDeltaW[];
  /** Enemy ids removed since the last snapshot. */
  x?: string[];
  pr?: ProjW;
  pl: PlayerW[];
  /** Loot added for this client / removed ids. */
  la?: LootW[];
  lr?: string[];
  fx?: FxW[];
  ev?: EvW[];
  /** Loadouts this client has not seen at their current version (see LoadoutW). */
  ld?: LoadoutW[];
}

export interface WelcomeMsg {
  t: 'w';
  /** The id the host uses for this client's player (may differ from the client's local id). */
  pid: string;
  /** The host's own player id. */
  hostPid: string;
  tm: number;
}

/** Weapon stats sent with every shot: [arch, rarity, element, color, damage, pellets, spread, range, critMultiplier, elementChance, fireRate] */
export type WeaponStatsW = [number, number, number, number, number, number, number, number, number, number, number];

/**
 * A hit the client's own weapon code produced against a mirrored enemy:
 * [enemyId, relX, relY, relZ (point minus the enemy's feet position as the client saw it), crit, amount, element,
 *  rollStatus, absX, absY, absZ (the world point the client hit, for the host's line-of-sight check)]
 */
export type HitW = [string, number, number, number, 0 | 1, number, number, 0 | 1, number, number, number];

export interface FireW {
  o: V3; // eye origin
  d: V3; // aim direction
  w: WeaponStatsW;
  /** [damageMult, critMult] from the client's skill tree. */
  m: [number, number];
  /** Movement spread multiplier the client used (0.7 .. 1.8). */
  sm: number;
  /** Hit claims for this shot (pellets + ricochets). Omitted → the host runs the hitscan itself. */
  h?: HitW[];
}

/** Area damage from the client (grenades, splash perk): [cx,cy,cz, radius, amount, element] */
export type AoeW = [number, number, number, number, number, number];

export interface ClientTickMsg {
  t: 'c';
  n: number;
  tm: number;
  p: V3;
  v: V3;
  y: number;
  pt: number;
  g: 0 | 1; // on ground
  u: 0 | 1; // holding use (E) — revives
  a: 0 | 1; // locally alive
  /** [damageMult, gear meleeMult] for validating melee claims (fires carry their own `m`). */
  mm?: [number, number];
  /** Max health/shield from the client's own skill tree. */
  mh: number;
  ms: number;
  /** Active weapon for the avatar [arch, color, rarity] or 0. */
  w: [number, number, number] | 0;
  f?: FireW[];
  /** Hits not attached to a shot (melee, chained). */
  h?: HitW[];
  ao?: AoeW[];
  pk?: string[];
  fx?: FxW[];
  /** Local heals (lifesteal) to apply on the host. */
  hl?: number;
  /** Self damage (own grenades): [amount, element] */
  sd?: [number, number][];
  /** Equipped gear, sent on the first tick and whenever gear:changed fires (versioned by the host). */
  ld?: Loadout;
}

export interface ByeMsg { t: 'bye'; reason: string }

export type HostMsg = SnapMsg | WelcomeMsg | ByeMsg;
export type ClientMsg = ClientTickMsg | ByeMsg;
export type GameMsg = HostMsg | ClientMsg;

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------
export function encode(msg: GameMsg): string {
  return JSON.stringify(msg);
}

const MSG_TYPES = new Set(['s', 'w', 'c', 'bye']);

/** Parse + minimal shape check. Returns null for anything that is not a game message. */
export function decode(data: unknown): GameMsg | null {
  let v: unknown = data;
  if (typeof data === 'string') {
    try {
      v = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const t = (v as { t?: unknown }).t;
  if (typeof t !== 'string' || !MSG_TYPES.has(t)) return null;
  if (t === 's') {
    const s = v as SnapMsg;
    if (!Array.isArray(s.r) || !Array.isArray(s.pl) || typeof s.tm !== 'number') return null;
  } else if (t === 'c') {
    const c = v as ClientTickMsg;
    if (!Array.isArray(c.p) || c.p.length !== 3 || typeof c.tm !== 'number') return null;
  }
  return v as GameMsg;
}

// ---------------------------------------------------------------------------
// Delta compression (enemies)
// ---------------------------------------------------------------------------
const ENEMY_KEYS = ['k', 'b', 't', 'p', 'y', 'h', 'm', 'a', 'ph', 'an', 's', 'fz', 'sh'] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  return false;
}

/** Changed fields of `next` relative to `prev` (full record when prev is undefined); null when identical. */
export function diffEnemy(prev: EnemyW | undefined, next: EnemyW): EnemyDeltaW | null {
  if (!prev) return next;
  const out: EnemyDeltaW = { i: next.i };
  let changed = false;
  for (const k of ENEMY_KEYS) {
    if (!sameValue(prev[k], next[k])) {
      (out as Record<string, unknown>)[k] = next[k];
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Apply a delta onto a base record (creates a new object; base may be undefined for a full record). */
export function applyEnemyDelta(base: EnemyW | undefined, delta: EnemyDeltaW): EnemyW {
  const out: EnemyW = base
    ? { ...base }
    : { i: delta.i, k: 0, b: 0, t: 1, p: [0, 0, 0], y: 0, h: 0, m: 1, a: 1, ph: 0, an: 'idle', s: [], fz: 0, sh: 0 };
  for (const k of ENEMY_KEYS) {
    const v = (delta as Record<string, unknown>)[k];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weapon helpers
// ---------------------------------------------------------------------------
export function weaponStatsW(w: WeaponDef): WeaponStatsW {
  return [
    enc.arch(w.archetype), enc.rarity(w.rarity), enc.element(w.element), w.color >>> 0,
    q2(w.damage), Math.max(1, Math.round(w.pellets)), Math.round(w.spread * 10000) / 10000, q1(w.range),
    q2(w.critMultiplier), q2(w.elementChance), q2(w.fireRate),
  ];
}

export interface WeaponStats {
  archetype: WeaponArchetype;
  rarity: Rarity;
  element: Element;
  color: number;
  damage: number;
  pellets: number;
  spread: number;
  range: number;
  critMultiplier: number;
  elementChance: number;
  fireRate: number;
}

export function readWeaponStats(w: WeaponStatsW): WeaponStats {
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    archetype: dec.arch(w[0]),
    rarity: dec.rarity(w[1]),
    element: dec.element(w[2]),
    color: num(w[3], 0, 0xffffff, 0xcccccc),
    damage: num(w[4], 0, 100000, 10),
    pellets: Math.round(num(w[5], 1, 24, 1)),
    spread: num(w[6], 0, 0.6, 0.02),
    range: num(w[7], 1, 400, 80),
    critMultiplier: num(w[8], 1, 10, 2),
    elementChance: num(w[9], 0, 1, 0),
    fireRate: num(w[10], 0.1, 40, 4),
  };
}

/** Stand-in WeaponDef built from wire stats (avatars, 'weapon:fired' on the host for audio). */
export function stubWeapon(s: WeaponStats, id = 'net_weapon'): WeaponDef {
  return {
    id,
    name: '',
    archetype: s.archetype,
    rarity: s.rarity,
    element: s.element,
    level: 1,
    damage: s.damage,
    fireRate: s.fireRate,
    auto: s.archetype === 'smg' || s.archetype === 'rifle',
    magSize: 10,
    reloadTime: 1,
    pellets: s.pellets,
    spread: s.spread,
    accuracy: accuracyFromSpread(s.spread),
    zoom: ADS.archetype[s.archetype].zoom,
    adsSpread: ADS.archetype[s.archetype].adsSpread,
    range: s.range,
    critMultiplier: s.critMultiplier,
    elementChance: s.elementChance,
    perks: [],
    color: s.color,
  };
}

export function avatarWeaponW(w: WeaponDef | null): [number, number, number] | 0 {
  return w ? [enc.arch(w.archetype), w.color >>> 0, enc.rarity(w.rarity)] : 0;
}

/** Light validation of a WeaponDef that arrived over the wire (pickup results). */
export function sanitizeWeapon(w: unknown): WeaponDef | null {
  if (!w || typeof w !== 'object') return null;
  const d = w as Partial<WeaponDef>;
  if (typeof d.id !== 'string' || typeof d.damage !== 'number' || typeof d.archetype !== 'string') return null;
  if (!ARCHETYPES.includes(d.archetype as WeaponArchetype)) return null;
  return {
    ...(d as WeaponDef),
    perks: Array.isArray(d.perks) ? d.perks : [],
  };
}

// ---------------------------------------------------------------------------
// Loadouts (gear on avatars)
// ---------------------------------------------------------------------------
/** Validate a loadout from the wire: each piece through sanitizeGear, in the slot it claims. */
export function sanitizeLoadout(raw: unknown): Loadout {
  const out: Loadout = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const slot of GEAR_SLOTS) {
    const def = sanitizeGear((raw as Record<string, unknown>)[slot]);
    if (def && def.slot === slot) out[slot] = def;
  }
  return out;
}
