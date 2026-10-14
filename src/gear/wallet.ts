/**
 * Scrip wallet (PLAN §13): one persistent integer balance per peer, in localStorage
 * 'concourse.wallet.v1' ({ v, scrip, earned }). No DOM, no THREE; storage is injectable for tests.
 * Co-op: each browser keeps its own wallet (salvage and bounties are paid locally).
 */
import type { WalletReason } from '@/core/events';
import type { GearStorage } from './inventory';

export const WALLET_STORAGE_KEY = 'concourse.wallet.v1';
const VERSION = 1;
/** Sanity cap so a corrupted save cannot overflow the UI. */
export const MAX_SCRIP = 9_999_999;

function defaultStorage(): GearStorage | null {
  try {
    return (globalThis as { localStorage?: GearStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

const toInt = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_SCRIP, Math.max(0, n)) : 0;
};

export type WalletListener = (scrip: number, delta: number, reason: WalletReason) => void;

export class Wallet {
  private value = 0;
  private lifetime = 0;
  private listeners = new Set<WalletListener>();

  constructor(private readonly storage: GearStorage | null = defaultStorage(), private readonly key = WALLET_STORAGE_KEY) {}

  get scrip(): number {
    return this.value;
  }

  /** Lifetime scrip earned (stats / docs). */
  get earned(): number {
    return this.lifetime;
  }

  onChange(fn: WalletListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  canAfford(cost: number): boolean {
    return cost <= this.value;
  }

  /** Add scrip (rounded down, ignored when ≤ 0). Returns the amount added. */
  add(amount: number, reason: WalletReason = 'other'): number {
    const n = Math.min(toInt(amount), MAX_SCRIP - this.value);
    if (n <= 0) return 0;
    this.value += n;
    this.lifetime = Math.min(MAX_SCRIP, this.lifetime + n);
    this.commit(n, reason);
    return n;
  }

  /** Spend scrip; false (nothing changes) when the balance is short. A 0 cost always succeeds. */
  spend(cost: number, reason: WalletReason = 'other'): boolean {
    const n = toInt(cost);
    if (n > this.value) return false;
    if (n === 0) return true;
    this.value -= n;
    this.commit(-n, reason);
    return true;
  }

  /** Replace the balance (tests / dev tools). */
  set(scrip: number): void {
    const before = this.value;
    this.value = toInt(scrip);
    this.commit(this.value - before, 'other');
  }

  load(): boolean {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return false;
      const d = JSON.parse(raw) as { v?: number; scrip?: unknown; earned?: unknown };
      if (!d || typeof d !== 'object' || d.v !== VERSION) return false;
      this.value = toInt(d.scrip);
      this.lifetime = Math.max(this.value, toInt(d.earned));
      for (const l of this.listeners) l(this.value, 0, 'load');
      return true;
    } catch {
      return false;
    }
  }

  save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify({ v: VERSION, scrip: this.value, earned: this.lifetime }));
    } catch {
      /* storage unavailable — scrip just isn't persisted */
    }
  }

  private commit(delta: number, reason: WalletReason): void {
    this.save();
    for (const l of Array.from(this.listeners)) {
      try {
        l(this.value, delta, reason);
      } catch (err) {
        console.error('[wallet] listener threw', err);
      }
    }
  }
}
