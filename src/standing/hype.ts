/**
 * Crowd favour ("hype") meter, 0..100, per run.
 *
 * Gains come from style (crits, multi-kills, melee / airborne / comeback kills, flawless
 * sub-waves, boss phase breaks); it decays slowly, faster while idling, and drops when
 * you get hit. Tiers Cold / Warm / Hot / ROARING drive `HypeModifiers` (loot rarity, XP,
 * gift buff) that other systems read. ROARING throws a crowd gift every 25 s; a Cold
 * crowd for > 20 s boos (worse drops).
 *
 * Call `update(dt)` only while the sim runs (inside the `!paused` block in main.ts).
 */
import type * as THREE from 'three';
import { ARENA } from '@/core/config';
import type { GameContext } from '@/core/types';
import {
  HYPE_TIERS, emitStanding,
  type HypeGiftKind, type HypeModifiers, type HypeReason, type HypeTier,
} from './types';

/** All hype tuning in one place. */
export const HYPE = {
  max: 100,
  start: 10,
  /** Lower bounds of Warm / Hot / ROARING. */
  tierBounds: [25, 50, 75] as const,
  /** Points below a tier's lower bound before dropping out of it (stops flicker). */
  hysteresis: 2,

  decayPerSec: 2,
  /** Seconds without dealing damage (during wave/boss) before the idle penalty kicks in. */
  idleAfter: 5,
  idleDecayPerSec: 3,
  /** Decay multiplier outside wave/boss (intermission, loot-up). */
  inactiveDecayMult: 0.5,

  gain: {
    kill: 1,
    critHit: 0.5,
    critKill: 4,
    multiKill: 8, // the 3rd kill inside the window
    multiKillExtra: 3, // every further kill while the chain holds
    meleeKill: 8,
    airborneKill: 5,
    comebackKill: 6,
    flawlessSubwave: 15,
    bossPhase: 10,
    bossKill: 12,
  },
  critHitCooldown: 0.2,
  multiKillWindow: 2,
  multiKillCount: 3,
  comebackHealthFrac: 0.25,
  airborneHeight: 0.45,

  loss: { perDamage: 0.12, min: 1, max: 6, shieldBreak: 4 },

  rarityBoost: { cold: 0, warm: 0.1, hot: 0.25, roaring: 0.5 } as Record<HypeTier, number>,
  xpMult: { cold: 1, warm: 1.1, hot: 1.25, roaring: 1.5 } as Record<HypeTier, number>,

  giftInterval: 25,
  giftWeights: { crate: 0.5, buff: 0.35, bonuswave: 0.15 } as Record<HypeGiftKind, number>,
  crateRarityBoost: 0.35,
  buffSeconds: 10,
  buffDamageMult: 1.3,
  bonusWaveMobs: (round: number) => 4 + 2 * round,

  booAfter: 20,
  booRarityPenalty: 0.1,

  emitInterval: 0.5,

  /** Standing awarded for crowd milestones (before the sponsor multiplier). */
  standing: { hot: 15, roaring: 30, gift: 10, flawless: 10, multiKill: 5 },
} as const;

const TIER_MESSAGES: Record<HypeTier, { up: string; down: string }> = {
  cold: { up: '', down: 'The crowd has gone quiet…' },
  warm: { up: 'The crowd is warming up', down: 'The crowd is cooling off' },
  hot: { up: 'The crowd is on its feet!', down: 'The crowd settles down' },
  roaring: { up: 'The crowd is roaring!', down: '' },
};

export interface Hype {
  readonly value: number;
  readonly tier: HypeTier;
  /** Live effects object (same reference forever). */
  readonly modifiers: HypeModifiers;
  /** Add (or remove, if negative) hype directly — debug, mutators, scripted moments. */
  add(amount: number, reason: HypeReason, label?: string): void;
  /** Back to the run start value (called on game:started). */
  reset(): void;
  update(dt: number): void;
}

export interface HypeOptions {
  /** Crowd milestones worth standing (wired to standing.award by createStandingSystem). */
  onMilestone?: (amount: number, label: string) => void;
}

export function tierIndexFor(value: number): number {
  const b = HYPE.tierBounds;
  return value >= b[2] ? 3 : value >= b[1] ? 2 : value >= b[0] ? 1 : 0;
}

/** Tier with hysteresis: rises immediately, drops only `hysteresis` points below the bound. */
export function nextTierIndex(value: number, current: number): number {
  const raw = tierIndexFor(value);
  if (raw >= current) return raw;
  let t = current;
  while (t > 0 && value < HYPE.tierBounds[t - 1] - HYPE.hysteresis) t--;
  return t;
}

export function createHype(ctx: GameContext, opts: HypeOptions = {}): Hype {
  let value: number = HYPE.start;
  let tierIdx = tierIndexFor(value);
  let clock = 0; // own sim clock (pauses with the sim)

  // emission bookkeeping
  let emitT = 0;
  let lastEmitted = value;

  // style trackers
  const killTimes: number[] = [];
  let chainActive = false;
  let lastCritHit = -Infinity;
  let critKillId: string | null = null;
  let frameKills = 0; // kills since the last update() (melee detection, see onMelee)
  let idleT = 0;
  let subDamaged = false;
  let subKills = 0;

  // tier timers
  let giftT = 0;
  let coldT = 0;
  let booing = false;
  let buffT = 0;
  const reachedThisRound = new Set<HypeTier>();

  const mods = {
    value, tier: HYPE_TIERS[tierIdx], rarityBoost: 0, xpMult: 1, damageMult: 1, buffRemaining: 0, booing: false,
  };

  const tier = () => HYPE_TIERS[tierIdx];
  const localId = () => (ctx.player ? ctx.player.id : 'p1');
  const isLocal = (id?: string) => id === undefined || id === localId();
  const phase = () => (ctx.rounds ? ctx.rounds.state.phase : 'wave');
  const active = () => {
    const ph = phase();
    return ph === 'wave' || ph === 'boss';
  };
  const currentRound = () => Math.max(1, ctx.rounds ? ctx.rounds.state.round : 1);

  function refreshMods(): void {
    const t = tier();
    mods.value = value;
    mods.tier = t;
    mods.rarityBoost = HYPE.rarityBoost[t] - (booing ? HYPE.booRarityPenalty : 0);
    mods.xpMult = HYPE.xpMult[t];
    mods.buffRemaining = Math.max(0, buffT);
    mods.damageMult = buffT > 0 ? HYPE.buffDamageMult : 1;
    mods.booing = booing;
  }

  function emitChanged(previousTier: HypeTier, tierChanged: boolean): void {
    emitT = 0;
    lastEmitted = value;
    emitStanding(ctx.events, 'hype:changed', { value, tier: tier(), previousTier, tierChanged });
  }

  function setValue(next: number): void {
    value = Math.max(0, Math.min(HYPE.max, next));
    const prevIdx = tierIdx;
    tierIdx = nextTierIndex(value, tierIdx);
    if (tierIdx === prevIdx) return;
    const prev = HYPE_TIERS[prevIdx];
    const now = tier();
    const up = tierIdx > prevIdx;
    if (now !== 'cold') {
      coldT = 0;
      booing = false;
    }
    refreshMods();
    emitChanged(prev, true);
    const text = up ? TIER_MESSAGES[now].up : TIER_MESSAGES[now].down;
    if (text) ctx.events.emit('ui:message', { text, duration: 3, style: now === 'roaring' ? 'legendary' : now === 'cold' ? 'warning' : 'info' });
    if (up && (now === 'hot' || now === 'roaring') && !reachedThisRound.has(now)) {
      reachedThisRound.add(now);
      opts.onMilestone?.(HYPE.standing[now], now === 'roaring' ? 'Crowd roaring' : 'Crowd on its feet');
    }
  }

  function add(amount: number, reason: HypeReason, label = ''): void {
    if (!amount) return;
    setValue(value + amount);
    if (label) emitStanding(ctx.events, 'hype:reaction', { reason, label, amount, value });
  }

  // ---- gifts -----------------------------------------------------------------
  function pickGift(): HypeGiftKind {
    const allowWave = phase() === 'wave';
    const entries = (Object.entries(HYPE.giftWeights) as [HypeGiftKind, number][])
      .filter(([k]) => allowWave || k !== 'bonuswave');
    let r = ctx.rng() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return 'crate';
  }

  /** ~3 m in front of the local player, on the ground, inside the arena. */
  function giftPosition(): THREE.Vector3 | undefined {
    const p = ctx.player;
    if (!p) return undefined;
    const pos = p.position.clone();
    const yaw = p.yaw || 0;
    const lim = ARENA.halfSize - 1.5;
    pos.x = Math.max(-lim, Math.min(lim, pos.x - Math.sin(yaw) * 3));
    pos.z = Math.max(-lim, Math.min(lim, pos.z - Math.cos(yaw) * 3));
    pos.y = ctx.world ? ctx.world.groundHeight(pos.x, pos.z) : pos.y;
    return pos;
  }

  function gift(): void {
    const kind = pickGift();
    const round = currentRound();
    if (kind === 'crate') {
      const pos = giftPosition();
      if (pos && ctx.loot && ctx.player) {
        ctx.loot.dropLoot(pos, {
          tier: round,
          // the loot hook (INTEGRATION.md §5a) adds sponsor + hype + league on top of this
          rarityBoost: HYPE.crateRarityBoost,
          count: 3,
          guaranteed: ['weapon', 'ammo', 'health'],
          ownerId: ctx.player.id,
        });
      }
      emitStanding(ctx.events, 'hype:gift', { kind, round, position: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined });
      ctx.events.emit('ui:message', { text: 'The crowd throws you a supply crate!', duration: 3.5, style: 'legendary' });
    } else if (kind === 'buff') {
      buffT = HYPE.buffSeconds;
      refreshMods();
      emitStanding(ctx.events, 'hype:gift', { kind, round, buffSeconds: HYPE.buffSeconds });
      ctx.events.emit('ui:message', { text: `Crowd frenzy! Damage ×${HYPE.buffDamageMult} for ${HYPE.buffSeconds}s`, duration: 3.5, style: 'legendary' });
    } else {
      const mobs = HYPE.bonusWaveMobs(round);
      emitStanding(ctx.events, 'hype:gift', { kind, round, mobs });
      ctx.events.emit('ui:message', { text: 'The crowd wants more — bonus wave!', duration: 3.5, style: 'legendary' });
    }
    opts.onMilestone?.(HYPE.standing.gift, 'Crowd gift');
  }

  // ---- events ----------------------------------------------------------------
  ctx.events.on('damage:dealt', (e) => {
    if (!isLocal(e.playerId)) return;
    idleT = 0;
    if (e.crit && e.killed) critKillId = e.enemyId;
    else if (e.crit && clock - lastCritHit >= HYPE.critHitCooldown) {
      lastCritHit = clock;
      add(HYPE.gain.critHit, 'crit');
    }
  });

  ctx.events.on('enemy:killed', (e) => {
    if (e.isBoss) {
      add(HYPE.gain.bossKill, 'boss_kill', 'HEADLINER DOWN');
      return;
    }
    if (!isLocal(e.killerId)) return;
    // With a cause on the event, melee finishers are exact; without one (old emitters) they are
    // inferred from player:melee in the same frame (below).
    if (e.cause === undefined) frameKills++;
    subKills++;
    let gain = HYPE.gain.kill;
    const labels: string[] = [];
    if (e.cause === 'melee') {
      gain += HYPE.gain.meleeKill;
      labels.push('MELEE FINISH');
    }

    if (critKillId === e.enemy.id) {
      gain += HYPE.gain.critKill;
      labels.push('CRITICAL');
    }
    critKillId = null;

    // multi-kill: >= 3 kills inside a sliding 2 s window
    killTimes.push(clock);
    while (killTimes.length && clock - killTimes[0] > HYPE.multiKillWindow) killTimes.shift();
    if (killTimes.length >= HYPE.multiKillCount) {
      if (!chainActive) {
        chainActive = true;
        gain += HYPE.gain.multiKill;
        labels.push(killTimes.length === 3 ? 'TRIPLE KILL' : `MULTI-KILL ×${killTimes.length}`);
        opts.onMilestone?.(HYPE.standing.multiKill, 'Multi-kill');
      } else {
        gain += HYPE.gain.multiKillExtra;
        labels.push(`MULTI-KILL ×${killTimes.length}`);
      }
    } else {
      chainActive = false;
    }

    const p = ctx.player;
    if (p && p.alive) {
      const ground = ctx.world ? ctx.world.groundHeight(p.position.x, p.position.z) : 0;
      const height = p.position.y - ground;
      // exact when the player reports onGround; a small height floor ignores step-downs
      const airborne = typeof p.onGround === 'boolean' ? !p.onGround && height > 0.2 : height > HYPE.airborneHeight;
      if (airborne) {
        gain += HYPE.gain.airborneKill;
        labels.push('AIRBORNE');
      }
      if (p.maxHealth > 0 && p.health < p.maxHealth * HYPE.comebackHealthFrac) {
        gain += HYPE.gain.comebackKill;
        labels.push('COMEBACK');
      }
    }
    const reason: HypeReason = labels.includes('MELEE FINISH') ? 'melee_kill'
      : labels.includes('COMEBACK') ? 'comeback_kill'

      : labels.includes('AIRBORNE') ? 'airborne_kill'
      : labels.some((l) => l.includes('KILL')) ? 'multi_kill'
      : labels.includes('CRITICAL') ? 'crit_kill' : 'kill';
    add(gain, reason, labels.join(' · '));
  });

  // Melee: player:melee is emitted right after the melee damage resolved, so kills that
  // happened since the last update() were (almost certainly) melee kills. See the
  // `cause` field proposal in INTEGRATION.md for an exact version.
  ctx.events.on('player:melee', (e) => {
    if (!isLocal(e.playerId) || !e.hit || frameKills <= 0) return;
    add(HYPE.gain.meleeKill * frameKills, 'melee_kill', frameKills > 1 ? `MELEE FINISH ×${frameKills}` : 'MELEE FINISH');
    frameKills = 0;
  });

  ctx.events.on('player:damaged', (e) => {
    if (!isLocal(e.playerId) || !(e.amount > 0)) return;
    subDamaged = true;
    const loss = Math.min(HYPE.loss.max, Math.max(HYPE.loss.min, e.amount * HYPE.loss.perDamage));
    add(-loss, 'damage_taken');
  });

  ctx.events.on('player:shield', (e) => {
    if (!isLocal(e.playerId) || !e.broken) return;
    add(-HYPE.loss.shieldBreak, 'shield_break', 'SHIELD DOWN');
  });

  ctx.events.on('boss:phase', () => {
    add(HYPE.gain.bossPhase, 'boss_phase', 'PHASE BREAK');
  });

  const flawlessCheck = () => {
    if (!subDamaged && subKills > 0) {
      add(HYPE.gain.flawlessSubwave, 'flawless_subwave', 'FLAWLESS WAVE');
      opts.onMilestone?.(HYPE.standing.flawless, 'Flawless wave');
    }
    subDamaged = false;
    subKills = 0;
  };
  ctx.events.on('round:started', () => {
    reachedThisRound.clear();
    subDamaged = false;
    subKills = 0;
    idleT = 0;
  });
  ctx.events.on('round:subwave', (e) => {
    if (e.subWave > 1) flawlessCheck();
    else {
      subDamaged = false;
      subKills = 0;
    }
  });
  ctx.events.on('round:boss', () => flawlessCheck());
  ctx.events.on('game:started', () => reset());

  // ---- API -------------------------------------------------------------------
  function reset(): void {
    const prev = tier();
    value = HYPE.start;
    tierIdx = tierIndexFor(value);
    killTimes.length = 0;
    chainActive = false;
    critKillId = null;
    frameKills = 0;
    idleT = 0;
    subDamaged = false;
    subKills = 0;
    giftT = 0;
    coldT = 0;
    booing = false;
    buffT = 0;
    reachedThisRound.clear();
    refreshMods();
    emitChanged(prev, prev !== tier());
  }

  function update(dt: number): void {
    if (!(dt > 0)) return;
    clock += dt;
    frameKills = 0;
    const isActive = active();

    // decay (+ idle penalty)
    let decay = HYPE.decayPerSec * (isActive ? 1 : HYPE.inactiveDecayMult);
    if (isActive) {
      idleT += dt;
      if (idleT > HYPE.idleAfter) decay += HYPE.idleDecayPerSec;
    }
    if (value > 0) setValue(value - decay * dt);

    // buff
    if (buffT > 0) buffT = Math.max(0, buffT - dt);

    // ROARING gifts (timer only runs while roaring, keeps partial progress)
    if (isActive && tier() === 'roaring') {
      giftT += dt;
      if (giftT >= HYPE.giftInterval) {
        giftT -= HYPE.giftInterval;
        gift();
      }
    }

    // boos
    if (isActive && tier() === 'cold') {
      coldT += dt;
      if (coldT > HYPE.booAfter && !booing) {
        booing = true;
        refreshMods();
        emitStanding(ctx.events, 'hype:boo', { seconds: coldT, rarityPenalty: HYPE.booRarityPenalty });
        ctx.events.emit('ui:message', { text: 'The crowd is booing! Sponsors cut the drops', duration: 3.5, style: 'warning' });
      }
    } else if (tier() !== 'cold') {
      coldT = 0;
      booing = false;
    }

    refreshMods();

    // periodic change event
    emitT += dt;
    if (emitT >= HYPE.emitInterval) {
      if (Math.abs(value - lastEmitted) > 0.01) emitChanged(tier(), false);
      else emitT = 0;
    }
  }

  refreshMods();

  return {
    get value() { return value; },
    get tier() { return tier(); },
    modifiers: mods,
    add,
    reset,
    update,
  };
}

