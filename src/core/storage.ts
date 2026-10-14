/**
 * Boot-time storage helpers used by main.ts (kept out of main.ts so tests can import them).
 *
 * Every persistent key lives under `concourse.*`:
 *   concourse.progress.v1  progression (level, XP, skill tree, best round)
 *   concourse.standing.v1  standing score + lifetime stats
 *   concourse.sponsor.v1   last picked sponsor contract
 *   concourse.gear.v1      gear inventory (backpack + equipped)
 *   concourse.weapons.v1   the two weapon slots (kept across runs like gear)
 *   concourse.player.id    this browser profile's player id (co-op attribution)
 *   concourse.net.name     remembered lobby name
 */

/** Old SNOWBOUND key → Orbital Concourse key. */
export const STORAGE_MIGRATIONS: readonly (readonly [from: string, to: string, keepOld?: boolean])[] = [
  ['snowbound.progress.v1', 'concourse.progress.v1'],
  ['snowbound.standing.v1', 'concourse.standing.v1'],
  ['snowbound.sponsor.v1', 'concourse.sponsor.v1'],
  ['snowbound.gear.v1', 'concourse.gear.v1'],
  // keepOld: src/net/ui.ts (UI agent) still reads the old lobby-name key; drop the flag once it
  // reads NET_NAME_KEY (docs/INTEGRATION_NOTES.md).
  ['snowbound.net.name', 'concourse.net.name', true],
];

/** Keys that are simply dropped (session-only state). */
const DROPPED_KEYS = ['snowbound.probe', 'snowbound.audio.muted'];

export const WEAPONS_KEY = 'concourse.weapons.v1';
export const PLAYER_ID_KEY = 'concourse.player.id';

/**
 * One-time localStorage migration from the SNOWBOUND working title: copy each old key to its
 * Orbital Concourse key (unless the new key already exists), then drop the old one. Must run
 * before any system reads storage. Safe to call every boot (a no-op once migrated).
 */
export function migrateStorage(storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    for (const [from, to, keepOld] of STORAGE_MIGRATIONS) {
      const old = storage.getItem(from);
      if (old === null) continue;
      if (storage.getItem(to) === null) storage.setItem(to, old);
      if (!keepOld) storage.removeItem(from);
    }
    for (const k of DROPPED_KEYS) storage.removeItem(k);
  } catch {
    /* storage unavailable (private mode): nothing to migrate */
  }
}

const ID_RE = /^p-[a-z0-9]{4,16}$/;

/**
 * A unique, persisted local player id ('p-' + 8 base36 chars). Co-op uses it as-is on the host,
 * so no id remapping is needed (two tabs of one browser profile share it; the host then renames
 * the second one, see src/net/host.ts). Presentation-only randomness: Math.random is fine here.
 */
export function localPlayerId(storage: Storage | undefined = globalThis.localStorage): string {
  const fresh = () => 'p-' + Math.floor(Math.random() * 36 ** 8).toString(36).padStart(8, '0');
  try {
    let id = storage?.getItem(PLAYER_ID_KEY) ?? null;
    if (!id || !ID_RE.test(id)) {
      id = fresh();
      storage?.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch {
    return fresh();
  }
}

/**
 * Whether the simulation freezes this frame. Single-player: any open screen (start, pause,
 * skills, inventory, game over) freezes it. In a co-op session the sim keeps running for
 * everyone and the open screen only captures this peer's input (the HUD sets input.uiCaptured).
 */
export function simPaused(screen: string, inSession: boolean): boolean {
  return screen !== 'none' && !inSession;
}
