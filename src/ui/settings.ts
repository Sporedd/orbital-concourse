/**
 * Player settings (persisted in localStorage 'concourse.settings.v1').
 *
 *   import { getSettings } from '@/ui/settings';
 *   getSettings().mouseSensitivity   // multiplier on the controller's MOUSE_SENSITIVITY (1 = default)
 *
 * Also exposed as `window.__settings` ({ get, set, onChange }) for code that should not import
 * src/ui. Until the player controller reads the multiplier itself, src/ui/index.ts installs
 * `installSensitivityHook(ctx.input)`, which scales Input.mouseDelta() on the instance. When the
 * controller reads `getSettings().mouseSensitivity`, remove that one call (or the scale applies twice).
 */
import type { Input } from '@/core/input';

export const SETTINGS_KEY = 'concourse.settings.v1';

export interface Settings {
  /** Multiplier on the base mouse sensitivity (0.2 .. 3, default 1). */
  mouseSensitivity: number;
}

export const SENSITIVITY_RANGE = { min: 0.2, max: 3, step: 0.05 } as const;

const DEFAULTS: Settings = { mouseSensitivity: 1 };

type Listener = (s: Readonly<Settings>) => void;
const listeners = new Set<Listener>();
let current: Settings = load();

function clampSens(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.mouseSensitivity;
  return Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, n));
}

function load(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    if (!raw) return { ...DEFAULTS };
    const d = JSON.parse(raw) as Partial<Settings> & { version?: number };
    return { mouseSensitivity: clampSens(d.mouseSensitivity ?? DEFAULTS.mouseSensitivity) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, ...current }));
  } catch {
    /* storage unavailable: settings stay session-only */
  }
}

export function getSettings(): Readonly<Settings> {
  return current;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const next = { ...current, [key]: key === 'mouseSensitivity' ? clampSens(value) : value };
  if (next[key] === current[key]) return;
  current = next;
  save();
  for (const l of Array.from(listeners)) l(current);
}

export function onSettingsChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Re-read storage (tests / another tab). */
export function reloadSettings(): void {
  current = load();
}

const hooked = new WeakSet<object>();

/**
 * Interim hook: scale Input.mouseDelta() by the sensitivity multiplier on this instance only.
 * Remove the call once the controller multiplies MOUSE_SENSITIVITY by getSettings().mouseSensitivity.
 */
export function installSensitivityHook(input: Input): void {
  if (!input || hooked.has(input) || typeof input.mouseDelta !== 'function') return;
  hooked.add(input);
  const base = input.mouseDelta.bind(input);
  input.mouseDelta = () => {
    const d = base();
    const m = current.mouseSensitivity;
    return m === 1 ? d : { dx: d.dx * m, dy: d.dy * m };
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __settings?: unknown }).__settings = {
    get: getSettings,
    set: setSetting,
    onChange: onSettingsChange,
    get mouseSensitivity() { return current.mouseSensitivity; },
  };
}
