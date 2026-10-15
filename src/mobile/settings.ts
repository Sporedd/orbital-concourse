/**
 * Mobile-only settings, persisted in localStorage 'concourse.mobile.v1'
 * ({ version: 1, autoFire, lookSensitivity }). Shown as extra rows in the SETTINGS panels of the
 * start and pause screens (src/mobile/overlay.ts adds them; desktop never sees them).
 */

export const MOBILE_SETTINGS_KEY = 'concourse.mobile.v1';

export interface MobileSettings {
  /** Hold fire while the crosshair rests on an enemy (default on). */
  autoFire: boolean;
  /** Multiplier on the touch look speed (0.3 .. 3, default 1). */
  lookSensitivity: number;
}

export const LOOK_SENS_RANGE = { min: 0.3, max: 3, step: 0.05 } as const;
export const MOBILE_DEFAULTS: Readonly<MobileSettings> = { autoFire: true, lookSensitivity: 1 };

const clampSens = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return MOBILE_DEFAULTS.lookSensitivity;
  return Math.min(LOOK_SENS_RANGE.max, Math.max(LOOK_SENS_RANGE.min, n));
};

export function loadMobileSettings(storage: Storage | undefined = globalThis.localStorage): MobileSettings {
  try {
    const raw = storage?.getItem(MOBILE_SETTINGS_KEY);
    if (!raw) return { ...MOBILE_DEFAULTS };
    const d = JSON.parse(raw) as Partial<MobileSettings>;
    return {
      autoFire: typeof d.autoFire === 'boolean' ? d.autoFire : MOBILE_DEFAULTS.autoFire,
      lookSensitivity: clampSens(d.lookSensitivity ?? MOBILE_DEFAULTS.lookSensitivity),
    };
  } catch {
    return { ...MOBILE_DEFAULTS };
  }
}

export function saveMobileSettings(s: MobileSettings, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(MOBILE_SETTINGS_KEY, JSON.stringify({ version: 1, autoFire: s.autoFire, lookSensitivity: clampSens(s.lookSensitivity) }));
  } catch {
    /* storage unavailable: session-only */
  }
}

/** Live settings object with change listeners (the overlay rows and the touch layer share it). */
export function createMobileSettings(storage?: Storage) {
  const current = loadMobileSettings(storage);
  const listeners = new Set<(s: Readonly<MobileSettings>) => void>();
  return {
    get: (): Readonly<MobileSettings> => current,
    set<K extends keyof MobileSettings>(key: K, value: MobileSettings[K]): void {
      current[key] = (key === 'lookSensitivity' ? clampSens(value) : value) as MobileSettings[K];
      saveMobileSettings(current, storage);
      for (const fn of listeners) fn(current);
    },
    onChange(fn: (s: Readonly<MobileSettings>) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
export type MobileSettingsStore = ReturnType<typeof createMobileSettings>;
