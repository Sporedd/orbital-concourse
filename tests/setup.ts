/**
 * Global test setup. In the 'node' environment there is no window/localStorage; a few sim
 * modules touch them (progression persists to localStorage and listens for beforeunload,
 * audio reads the mute flag). Provide minimal in-memory stand-ins so those modules import
 * and run headlessly. In 'jsdom' the real ones exist and are left alone (but cleared).
 */
import { beforeEach } from 'vitest';

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.localStorage === 'undefined') {
  g.localStorage = new MemoryStorage();
}

if (typeof g.window === 'undefined') {
  // Minimal window: event registration is a no-op sink (modules only ever add listeners).
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  g.window = {
    addEventListener(name: string, fn: (e: unknown) => void) {
      let s = listeners.get(name);
      if (!s) listeners.set(name, (s = new Set()));
      s.add(fn);
    },
    removeEventListener(name: string, fn: (e: unknown) => void) {
      listeners.get(name)?.delete(fn);
    },
    dispatchEvent(e: { type: string }) {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    localStorage: g.localStorage,
  };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
