import { describe, expect, it } from 'vitest';
import { PLAYER_ID_KEY, STORAGE_MIGRATIONS, localPlayerId, migrateStorage, simPaused } from '@/core/storage';
import { GEAR_STORAGE_KEY, LEGACY_GEAR_STORAGE_KEY } from '@/gear';

describe('storage migration (SNOWBOUND → concourse.*)', () => {
  it('copies every old key to its new key once and drops the old one', () => {
    localStorage.setItem('snowbound.progress.v1', '{"p":1}');
    localStorage.setItem(LEGACY_GEAR_STORAGE_KEY, '{"g":1}');
    localStorage.setItem('snowbound.audio.muted', '1');
    migrateStorage();
    expect(localStorage.getItem('concourse.progress.v1')).toBe('{"p":1}');
    expect(localStorage.getItem(GEAR_STORAGE_KEY)).toBe('{"g":1}');
    expect(GEAR_STORAGE_KEY).toBe('concourse.gear.v1');
    expect(localStorage.getItem('snowbound.progress.v1')).toBeNull();
    expect(localStorage.getItem(LEGACY_GEAR_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('snowbound.audio.muted')).toBeNull();
  });

  it('never overwrites an existing new key', () => {
    localStorage.setItem('concourse.gear.v1', 'new');
    localStorage.setItem('snowbound.gear.v1', 'old');
    migrateStorage();
    expect(localStorage.getItem('concourse.gear.v1')).toBe('new');
  });

  it('moves the lobby name too (old key kept while src/net/ui.ts still reads it)', () => {
    localStorage.setItem('snowbound.net.name', 'Ana');
    migrateStorage();
    expect(localStorage.getItem('concourse.net.name')).toBe('Ana');
    expect(STORAGE_MIGRATIONS.some(([f, t]) => f === 'snowbound.net.name' && t === 'concourse.net.name')).toBe(true);
  });
});

describe('local player id', () => {
  it('is p- + 8 base36 chars, persisted, and regenerated when junk', () => {
    const a = localPlayerId();
    expect(a).toMatch(/^p-[a-z0-9]{8}$/);
    expect(localPlayerId()).toBe(a);
    localStorage.setItem(PLAYER_ID_KEY, 'p1 <script>');
    const b = localPlayerId();
    expect(b).toMatch(/^p-[a-z0-9]{8}$/);
  });
});

describe('simPaused (host pause policy)', () => {
  it('single-player: any screen pauses; co-op session: nothing pauses', () => {
    expect(simPaused('none', false)).toBe(false);
    for (const s of ['start', 'pause', 'skills', 'inventory', 'gameover']) {
      expect(simPaused(s, false)).toBe(true);
      expect(simPaused(s, true)).toBe(false);
    }
  });
});
