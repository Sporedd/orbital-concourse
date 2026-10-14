/** localStorage access that never throws (private mode, node smoke tests). */
import type { KeyValueStore } from './types';

const memory = new Map<string, string>();
const memoryStore: KeyValueStore = {
  getItem: (k) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

/** The browser's localStorage when usable, else an in-memory fallback. */
export function defaultStore(): KeyValueStore {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (ls && typeof ls.getItem === 'function') {
      ls.getItem('concourse.probe');
      return ls;
    }
  } catch {
    /* fall through */
  }
  return memoryStore;
}

export function readJson<T>(store: KeyValueStore, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / unavailable — standing just isn't persisted */
  }
}

/** Run `fn` on page unload when there is a window (no-op headless). */
export function onUnload(fn: () => void): void {
  const w = (globalThis as { window?: { addEventListener?: (n: string, f: () => void) => void } }).window;
  if (w && typeof w.addEventListener === 'function') w.addEventListener('beforeunload', fn);
}
