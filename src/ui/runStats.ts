/**
 * Per-run numbers for the death recap: damage dealt (sum of the local player's damage:dealt),
 * kills, the highest-DPS weapon equipped during the run, time survived (unpaused play time)
 * and the standing rank at the start of the run.
 */
import type { GameContext, WeaponDef } from '@/core/types';
import { weaponDps } from '@/loot/weapons';

export interface RunStats {
  readonly damage: number;
  readonly kills: number;
  readonly bestWeapon: WeaponDef | null;
  readonly bestDps: number;
  /** Seconds of unpaused play. */
  readonly time: number;
  /** Date.now() when the run started (filters standing history). */
  readonly startedAt: number;
  /** Standing rank index when the run started (-1 without a standing system). */
  readonly rankAtStart: number;
  readonly standingAtStart: number;
  /** Call every frame with whether the sim is running. */
  update(dt: number, running: boolean): void;
}

export function createRunStats(ctx: GameContext): RunStats {
  let damage = 0;
  let kills = 0;
  let best: WeaponDef | null = null;
  let bestDps = 0;
  let time = 0;
  let startedAt = Date.now();
  let rankAtStart = -1;
  let standingAtStart = 0;
  let lastActive = '';

  const isLocal = (id?: string) => id === undefined || (!!ctx.player && id === ctx.player.id);

  const consider = (w: WeaponDef | null | undefined) => {
    if (!w) return;
    const d = weaponDps(w);
    if (d > bestDps) {
      bestDps = d;
      best = w;
    }
  };

  ctx.events.on('game:started', () => {
    damage = 0;
    kills = 0;
    best = null;
    bestDps = 0;
    time = 0;
    lastActive = '';
    startedAt = Date.now();
    const s = ctx.standing?.standing;
    rankAtStart = s ? s.rank.index : -1;
    standingAtStart = s ? s.standing : 0;
    consider(ctx.player?.activeWeapon);
  });
  ctx.events.on('damage:dealt', (e) => {
    if (!isLocal(e.playerId)) return;
    if (Number.isFinite(e.amount) && e.amount > 0) damage += e.amount;
  });
  ctx.events.on('enemy:killed', (e) => {
    if (e.killerId !== undefined && !isLocal(e.killerId)) return;
    kills++;
  });
  ctx.events.on('weapon:equipped', (e) => {
    if (isLocal(e.playerId)) consider(e.weapon);
  });

  return {
    get damage() { return damage; },
    get kills() { return kills; },
    get bestWeapon() { return best; },
    get bestDps() { return bestDps; },
    get time() { return time; },
    get startedAt() { return startedAt; },
    get rankAtStart() { return rankAtStart; },
    get standingAtStart() { return standingAtStart; },
    update(dt: number, running: boolean) {
      if (!running) return;
      time += dt;
      const w = ctx.player?.activeWeapon;
      const id = w ? w.id : '';
      if (id !== lastActive) {
        lastActive = id;
        consider(w);
      }
    },
  };
}

/** 754 → "12:34"; ≥ 1 h → "1:02:03". */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m).padStart(2, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

/** 12345 → "12 345" (thin grouping, mono friendly). */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
}
