/**
 * Gear inventory data model: a limited backpack + one equipped piece per slot, compare
 * helpers for gear cards, and localStorage persistence. No DOM, no THREE: safe in the sim
 * and in headless tests. Emits its own small typed events (GameEvents has no gear events
 * yet; see INTEGRATION.md for the bridge).
 */
import { RARITY_ORDER, type Rarity } from '@/core/types';
import {
  AFFIXES, GEAR_SETS, computeLoadoutStats, gearScore, growthForLevel, leagueForLevel, makeAffix, statScoreWeight,
} from './generator';
import { gearAccentColor, gearBodyColor } from './palette';
import { GEAR_SLOTS, type GearAffix, type GearDef, type GearSlot, type GearStat, type GearStats, type Loadout } from './types';

export const BACKPACK_CAPACITY = 12;
export const GEAR_STORAGE_KEY = 'concourse.gear.v1';
/** Pre-rename key (SNOWBOUND); main.ts migrateStorage() moves it to GEAR_STORAGE_KEY once. */
export const LEGACY_GEAR_STORAGE_KEY = 'snowbound.gear.v1';
const SAVE_VERSION = 1;

// ---------------------------------------------------------------------------
// Tiny typed emitter
// ---------------------------------------------------------------------------
export class Emitter<E extends { [K in keyof E]: unknown }> {
  private handlers = new Map<keyof E, Set<(p: never) => void>>();

  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn as (p: never) => void);
    return () => this.off(name, fn);
  }

  off<K extends keyof E>(name: K, fn: (payload: E[K]) => void): void {
    this.handlers.get(name)?.delete(fn as (p: never) => void);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        (h as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(`[gear] handler for ${String(name)} threw`, err);
      }
    }
  }
}

export interface InventoryEvents {
  /** Anything changed (equip, unequip, add, remove, load). */
  'gear:changed': { loadout: Readonly<Loadout>; backpack: readonly GearDef[]; stats: GearStats };
  'gear:equipped': { slot: GearSlot; item: GearDef; replaced: GearDef | null };
  'gear:unequipped': { slot: GearSlot; item: GearDef };
  'gear:added': { item: GearDef };
  'gear:removed': { item: GearDef };
  /** add() refused because the backpack is full. */
  'gear:full': { item: GearDef };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
export interface GearCompareLine {
  stat: GearStat;
  label: string;
  a: number;
  b: number;
  /** a - b in the stat's own units (positive = a is better for every stat). */
  delta: number;
  /** "+2.1%" style, for the card. */
  deltaText: string;
}

export interface GearComparison {
  scoreA: number;
  scoreB: number;
  /** scoreA - scoreB (positive = a is the upgrade). */
  delta: number;
  lines: GearCompareLine[];
  /** Set note for the card, e.g. "Completes Bulwark (3/3)". */
  setNote?: string;
}

/** Sum of a piece's stat contributions (implicit + affixes). */
export function pieceTotals(def: GearDef): Partial<Record<GearStat, number>> {
  const t: Partial<Record<GearStat, number>> = {};
  for (const a of [def.implicit, ...def.affixes]) t[a.stat] = (t[a.stat] ?? 0) + a.value;
  return t;
}

function fmtDelta(stat: GearStat, d: number): string {
  if (AFFIXES[stat].integer) return `${d >= 0 ? '+' : ''}${Math.round(d)}`;
  const pct = Math.round(d * 1000) / 10;
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/**
 * Compare candidate `a` against `b` (usually the equipped piece; null = empty slot).
 * Pass the current loadout to get set-completion notes.
 */
export function compareGear(a: GearDef, b: GearDef | null | undefined, loadout?: Loadout): GearComparison {
  const ta = pieceTotals(a);
  const tb = b ? pieceTotals(b) : {};
  const stats = new Set<GearStat>([...(Object.keys(ta) as GearStat[]), ...(Object.keys(tb) as GearStat[])]);
  const lines: GearCompareLine[] = [];
  for (const stat of stats) {
    const va = ta[stat] ?? 0;
    const vb = tb[stat] ?? 0;
    const delta = Math.round((va - vb) * 1000) / 1000;
    lines.push({ stat, label: AFFIXES[stat].name, a: va, b: vb, delta, deltaText: fmtDelta(stat, delta) });
  }
  lines.sort((x, y) => Math.abs(y.delta * statScoreWeight(y.stat)) - Math.abs(x.delta * statScoreWeight(x.stat)));
  const scoreA = gearScore(a);
  const scoreB = b ? gearScore(b) : 0;
  let setNote: string | undefined;
  if (a.setId && loadout) {
    const set = GEAR_SETS[a.setId];
    let n = 1;
    for (const s of set.slots) if (s !== a.slot && loadout[s]?.setId === a.setId) n++;
    setNote = `${set.name} (${n}/${set.slots.length})`;
  }
  return { scoreA, scoreB, delta: scoreA - scoreB, lines, setNote };
}

// ---------------------------------------------------------------------------
// Sanitising (persistence / network)
// ---------------------------------------------------------------------------
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeAffix(raw: unknown): GearAffix | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<GearAffix>;
  if (typeof r.stat !== 'string' || !(r.stat in AFFIXES) || !isNum(r.value)) return null;
  return makeAffix(r.stat as GearStat, r.value);
}

/**
 * Validate a GearDef from untrusted JSON (localStorage, network). Derived presentation fields
 * (growth, league, colours, affix texts) are recomputed, so palette or curve changes apply to
 * old saves. Returns null when the shape is wrong.
 */
export function sanitizeGear(raw: unknown): GearDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<GearDef>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.slot !== 'string' || !GEAR_SLOTS.includes(r.slot as GearSlot)) return null;
  if (typeof r.rarity !== 'string' || !RARITY_ORDER.includes(r.rarity as Rarity)) return null;
  if (!isNum(r.level) || !isNum(r.tier)) return null;
  const implicit = sanitizeAffix(r.implicit);
  if (!implicit) return null;
  const affixes = Array.isArray(r.affixes) ? r.affixes.map(sanitizeAffix).filter((a): a is GearAffix => !!a) : [];
  const element = r.element === 'fire' || r.element === 'shock' || r.element === 'ice' ? r.element : undefined;
  const setId = r.setId && r.setId in GEAR_SETS && GEAR_SETS[r.setId].slots.includes(r.slot as GearSlot) ? r.setId : undefined;
  const rarity = r.rarity as Rarity;
  const level = Math.max(1, Math.floor(r.level));
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Salvaged Gear',
    slot: r.slot as GearSlot,
    rarity,
    ...(element ? { element } : {}),
    tier: Math.max(1, Math.floor(r.tier)),
    level,
    implicit,
    affixes: affixes.slice(0, 4),
    ...(setId ? { setId } : {}),
    league: leagueForLevel(level),
    color: gearBodyColor(rarity),
    accent: gearAccentColor(rarity, element),
    growth: growthForLevel(level),
    seed: isNum(r.seed) ? Math.floor(Math.abs(r.seed)) % 0x7fffffff : 1,
  };
}

interface SaveData {
  v: number;
  backpack: unknown[];
  loadout: Partial<Record<GearSlot, unknown>>;
}

/** Minimal storage interface (localStorage-compatible), injectable for tests. */
export interface GearStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): GearStorage | null {
  try {
    const ls = (globalThis as { localStorage?: GearStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
export class Inventory {
  readonly events = new Emitter<InventoryEvents>();
  private bag: GearDef[] = [];
  private worn: Loadout = {};
  private cachedStats: GearStats = computeLoadoutStats({});

  constructor(readonly capacity = BACKPACK_CAPACITY, private readonly storageKey = GEAR_STORAGE_KEY) {}

  get backpack(): readonly GearDef[] {
    return this.bag;
  }

  get loadout(): Readonly<Loadout> {
    return this.worn;
  }

  /** Loadout stats (cached; recomputed on every change). */
  get stats(): GearStats {
    return this.cachedStats;
  }

  equipped(slot: GearSlot): GearDef | null {
    return this.worn[slot] ?? null;
  }

  isFull(): boolean {
    return this.bag.length >= this.capacity;
  }

  freeSlots(): number {
    return Math.max(0, this.capacity - this.bag.length);
  }

  has(id: string): boolean {
    return this.find(id) !== null;
  }

  find(id: string): { where: 'backpack' | 'equipped'; item: GearDef } | null {
    const b = this.bag.find((d) => d.id === id);
    if (b) return { where: 'backpack', item: b };
    for (const s of GEAR_SLOTS) if (this.worn[s]?.id === id) return { where: 'equipped', item: this.worn[s]! };
    return null;
  }

  /** Put a piece in the backpack. False if full or already owned. */
  add(item: GearDef): boolean {
    if (this.has(item.id)) return false;
    if (this.isFull()) {
      this.events.emit('gear:full', { item });
      return false;
    }
    this.bag.push(item);
    this.events.emit('gear:added', { item });
    this.changed();
    return true;
  }

  /**
   * Pickup flow: equip straight into an empty slot, otherwise into the backpack.
   * Returns where it went ('full' = refused, leave it on the ground).
   */
  pickUp(item: GearDef): 'equipped' | 'backpack' | 'full' | 'duplicate' {
    if (this.has(item.id)) return 'duplicate';
    if (!this.worn[item.slot]) {
      this.worn[item.slot] = item;
      this.events.emit('gear:equipped', { slot: item.slot, item, replaced: null });
      this.changed();
      return 'equipped';
    }
    return this.add(item) ? 'backpack' : 'full';
  }

  /** Remove a backpack piece (drop / salvage). Equipped pieces must be unequipped first. */
  remove(id: string): GearDef | null {
    const i = this.bag.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const [item] = this.bag.splice(i, 1);
    this.events.emit('gear:removed', { item });
    this.changed();
    return item;
  }

  /** Equip a backpack piece; the previously worn piece takes its backpack spot. */
  equip(id: string): boolean {
    const i = this.bag.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const item = this.bag[i];
    const replaced = this.worn[item.slot] ?? null;
    if (replaced) this.bag[i] = replaced;
    else this.bag.splice(i, 1);
    this.worn[item.slot] = item;
    this.events.emit('gear:equipped', { slot: item.slot, item, replaced });
    this.changed();
    return true;
  }

  /** Move the worn piece into the backpack. False if the slot is empty or the backpack full. */
  unequip(slot: GearSlot): boolean {
    const item = this.worn[slot];
    if (!item || this.isFull()) return false;
    delete this.worn[slot];
    this.bag.push(item);
    this.events.emit('gear:unequipped', { slot, item });
    this.changed();
    return true;
  }

  /**
   * Swap an owned piece for an updated copy with the same id (gear upgrades). The copy stays
   * where the original was (equipped slot or backpack position). False if the id is not owned
   * or the slot changed.
   */
  replace(item: GearDef): boolean {
    const i = this.bag.findIndex((d) => d.id === item.id);
    if (i >= 0) {
      this.bag[i] = item;
      this.changed();
      return true;
    }
    const worn = this.worn[item.slot];
    if (worn && worn.id === item.id) {
      this.worn[item.slot] = item;
      this.changed();
      return true;
    }
    return false;
  }

  /** Compare a piece with what is worn in its slot. */
  compareToEquipped(item: GearDef): GearComparison {
    return compareGear(item, this.worn[item.slot] ?? null, this.worn);
  }

  clear(): void {
    this.bag = [];
    this.worn = {};
    this.changed();
  }

  // ---- persistence ---------------------------------------------------------
  serialize(): string {
    const data: SaveData = { v: SAVE_VERSION, backpack: this.bag, loadout: this.worn };
    return JSON.stringify(data);
  }

  /**
   * Replace the contents from serialize() output. Invalid entries are dropped. Pass `reId`
   * (e.g. ctx.nextId) to give loaded pieces fresh session ids so they cannot collide with
   * ids generated this session. Returns false when the JSON is unusable.
   */
  deserialize(json: string, reId?: (prefix: string) => string): boolean {
    let data: SaveData;
    try {
      data = JSON.parse(json) as SaveData;
    } catch {
      return false;
    }
    if (!data || typeof data !== 'object' || data.v !== SAVE_VERSION) return false;
    const seen = new Set<string>();
    const accept = (raw: unknown): GearDef | null => {
      const d = sanitizeGear(raw);
      if (!d) return null;
      if (reId) d.id = reId('g');
      if (seen.has(d.id)) return null;
      seen.add(d.id);
      return d;
    };
    const worn: Loadout = {};
    if (data.loadout && typeof data.loadout === 'object') {
      for (const s of GEAR_SLOTS) {
        const d = accept(data.loadout[s]);
        if (d && d.slot === s) worn[s] = d;
      }
    }
    const bag: GearDef[] = [];
    if (Array.isArray(data.backpack)) {
      for (const raw of data.backpack) {
        if (bag.length >= this.capacity) break;
        const d = accept(raw);
        if (d) bag.push(d);
      }
    }
    this.worn = worn;
    this.bag = bag;
    this.changed();
    return true;
  }

  save(storage: GearStorage | null = defaultStorage()): void {
    if (!storage) return;
    try {
      storage.setItem(this.storageKey, this.serialize());
    } catch {
      /* storage unavailable (private mode / quota) — gear just isn't persisted */
    }
  }

  load(storage: GearStorage | null = defaultStorage(), reId?: (prefix: string) => string): boolean {
    if (!storage) return false;
    try {
      const raw = storage.getItem(this.storageKey);
      return raw ? this.deserialize(raw, reId) : false;
    } catch {
      return false;
    }
  }

  private changed(): void {
    this.cachedStats = computeLoadoutStats(this.worn);
    this.events.emit('gear:changed', { loadout: this.worn, backpack: this.bag, stats: this.cachedStats });
  }
}

export function createInventory(capacity = BACKPACK_CAPACITY, storageKey = GEAR_STORAGE_KEY): Inventory {
  return new Inventory(capacity, storageKey);
}
