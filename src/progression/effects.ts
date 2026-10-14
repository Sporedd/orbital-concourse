/**
 * Live skill effects (docs/SKILL_TREE.md §4–5): read-time stat modifiers ("cond"), timed buffs
 * ("buff"), event listeners ("event") and the class active abilities.
 *
 * Only existing contracts are used: ctx.player (heal / addAmmo / addGrenades and the writable
 * shield / ammo fields), ctx.enemies (get / list / damageRadius / bossAlive, Enemy.damage /
 * applyStatus), ctx.loot.dropLoot, ctx.standing (hype.add, standing.award), ctx.fx and ui:message.
 * Every listener checks the node's rank when the event fires, so nothing is (un)subscribed on
 * invest/respec.
 */
import * as THREE from 'three';
import { ELEMENT_COLORS, type Element, type Enemy, type GameContext, type LootKind, type PlayerState, type PlayerStats } from '@/core/types';
import { AMMO_PICKUP, HEALTH_PICKUP } from '@/loot';
import { HYPE } from '@/standing/hype';
import { HYPE_TIERS, type HypeReason } from '@/standing/types';
import { CLASSES, type ActiveAbilityDef, type ClassId } from './classes';
import type { SkillExtras } from './skills';

/** Stats that read-time modifiers and buffs may touch (never health/shield: their maxima only update on events). */
export type DynStat = 'damageMult' | 'fireRateMult' | 'reloadMult' | 'critMult' | 'moveSpeedMult';
export const DYN_STATS: readonly DynStat[] = ['damageMult', 'fireRateMult', 'reloadMult', 'critMult', 'moveSpeedMult'];

/**
 * Heavy Hands / Executioner: deal the melee bonus as a follow-up hit until the player multiplies
 * melee damage by extras.meleeMult itself (docs §5.2). Off: src/player/melee.ts meleeDamage()
 * reads extras.meleeMult (Executioner's +50 % vs bosses stays a follow-up hit).
 */
export const MELEE_BRIDGE = false;

export interface EffectHost {
  rank(id: string): number;
  classId(): ClassId | null;
  extras(): Readonly<SkillExtras>;
  /** The live (dynamic) stats object, for scaling ability damage. */
  stats(): PlayerStats;
  /** True when the class active is unlocked (any class keystone owned). */
  activeUnlocked(): boolean;
}

export interface ActiveAbilityState {
  readonly def: ActiveAbilityDef;
  readonly unlocked: boolean;
  readonly ready: boolean;
  readonly cooldownLeft: number;
  readonly cooldown: number;
  readonly activeLeft: number;
  readonly active: boolean;
}

export interface Effects {
  /** Product of every read-time modifier and live buff on `stat` (1 = neutral). */
  mult(stat: DynStat): number;
  /** The current class's active ability, or null without a class. */
  readonly active: ActiveAbilityState | null;
  useActive(): boolean;
  /** Clear buffs, stacks and cooldowns (new run). */
  reset(): void;
}

// ---- tuning (docs §3) -------------------------------------------------------
const T = {
  scarTissueCd: 6,
  overchargeCd: 15,
  overchargeShield: 0.4,
  crowdWorkCd: 4,
  crowdWorkHype: 6,
  executeBelow: 0.25,
  executionerBoss: 0.5,
  showboatRange: 6,
  centerRingRange: 8,
  centerRingCount: 3,
  patienceDelay: 1,
  perfectFormMax: 15,
  perfectFormTime: 6,
  catalystRadius: 3,
  meltdownRadius: 4,
  meltdownFrac: 0.25,
  clusterRadius: 3,
  salvageChance: 0.06,
  pointBlankRange: 5,
  fanServiceCd: 20,
  sponsorBoost: 0.3,
  pulseRadius: 8,
  pulseBase: 80,
  pulsePerRound: 20,
  pulseShield: 0.25,
  encoreFireRate: 0.2,
} as const;

const MULTI_KILL = /TRIPLE KILL|MULTI-KILL/;
const SMG_SHOTGUN = (a?: string) => a === 'smg' || a === 'shotgun';
const PISTOL_SNIPER = (a?: string) => a === 'pistol' || a === 'sniper';

type Cond = (rank: number, stat: DynStat) => number;

export function createEffects(ctx: GameContext, host: EffectHost): Effects {
  const now = () => ctx.time?.elapsed ?? 0;
  const rank = host.rank;
  const player = (): PlayerState | undefined => (ctx as Partial<GameContext>).player;
  const isMe = (id?: string) => !!id && !!player() && id === player()!.id;
  const hypeSys = () => (ctx as Partial<GameContext>).standing?.hype;
  const tierIdx = () => {
    const h = hypeSys();
    return h ? HYPE_TIERS.indexOf(h.tier) : 0;
  };
  const round = (fallback = 1) => Math.max(1, (ctx as Partial<GameContext>).rounds?.state.round || fallback);
  const runDamage = () => (ctx as Partial<GameContext>).standing?.damageMult() ?? 1;

  // ---- small actions ---------------------------------------------------------------------------
  const cds = new Map<string, number>();
  /** True (and starts the cooldown) when `id` is off cooldown. */
  function ready(id: string, cd: number): boolean {
    const t = now();
    if (t < (cds.get(id) ?? -Infinity)) return false;
    cds.set(id, t + cd);
    return true;
  }
  function addShield(frac: number): void {
    const p = player();
    if (!p || !p.alive || !(p.maxShield > 0)) return;
    p.shield = Math.min(p.maxShield, p.shield + p.maxShield * frac);
  }
  function healFrac(frac: number): void {
    const p = player();
    if (p && p.alive) p.heal(p.maxHealth * frac);
  }
  function refillMag(): void {
    const p = player();
    if (p && p.alive && p.activeWeapon) p.ammo = 1e9; // the setter clamps to the magazine
  }
  let ownHype = false;
  function addHype(amount: number, reason: HypeReason, label = ''): void {
    const h = hypeSys();
    if (!h || !(amount > 0)) return;
    ownHype = true;
    try {
      h.add(amount, reason, label);
    } finally {
      ownHype = false;
    }
  }
  function drop(pos: THREE.Vector3 | { x: number; y: number; z: number }, tier: number, opts: { kinds?: LootKind[]; boost?: number } = {}): void {
    const p = player();
    if (!ctx.isHost || !ctx.loot || !p) return;
    ctx.loot.dropLoot(new THREE.Vector3(pos.x, pos.y, pos.z), {
      tier, count: 1, ownerId: p.id, guaranteed: opts.kinds, rarityBoost: opts.boost ?? 0,
    });
  }
  const say = (text: string, style: 'info' | 'legendary' = 'info') => ctx.events.emit('ui:message', { text, duration: 2, style });

  // ---- buffs -------------------------------------------------------------------------------------
  const buffs = new Map<string, { until: number; mods: Partial<Record<DynStat, number>> }>();
  const buff = (id: string, seconds: number, mods: Partial<Record<DynStat, number>>) => buffs.set(id, { until: now() + seconds, mods });
  let formStacks = 0;
  let formUntil = -Infinity;

  // ---- read-time modifiers -------------------------------------------------------------------
  let lastFired = -Infinity;
  const weapon = () => player()?.activeWeapon ?? null;
  const airborne = () => {
    const p = player();
    return !!p && p.alive && p.onGround === false;
  };
  const healthFrac = () => {
    const p = player();
    return p && p.maxHealth > 0 ? p.health / p.maxHealth : 1;
  };
  function enemiesWithin(range: number): number {
    const p = player();
    const list = (ctx as Partial<GameContext>).enemies?.list();
    if (!p || !list) return 0;
    const r2 = range * range;
    let n = 0;
    for (const e of list) {
      if (!e.alive) continue;
      const dx = e.position.x - p.position.x;
      const dz = e.position.z - p.position.z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  const CONDS: Record<string, Cond> = {
    van_hold_line: (r, s) => {
      const p = player();
      return s === 'damageMult' && p && p.maxShield > 0 && p.shield >= p.maxShield - 0.5 ? 0.06 * r : 0;
    },
    van_last_stand: (r, s) => (s === 'damageMult' && healthFrac() < 0.35 ? 0.1 * r : 0),
    van_center_ring: (_r, s) =>
      (s === 'damageMult' || s === 'fireRateMult') && enemiesWithin(T.centerRingRange) >= T.centerRingCount ? 0.2 : 0,
    mar_patience: (r, s) => (s === 'critMult' && now() - lastFired >= T.patienceDelay ? 0.12 * r : 0),
    mar_scoped: (r, s) => (s === 'damageMult' && player()?.aiming ? 0.05 * r : 0),
    mar_specialist: (r, s) => (s === 'damageMult' && PISTOL_SNIPER(weapon()?.archetype) ? 0.08 * r : 0),
    mar_one_shot: (_r, s) => {
      if (!PISTOL_SNIPER(weapon()?.archetype)) return 0;
      return s === 'damageMult' || s === 'critMult' ? 0.3 : s === 'fireRateMult' ? -0.2 : 0;
    },
    mar_vantage: (r, s) => (s === 'critMult' && airborne() ? 0.08 * r : 0),
    mar_big_game: (_r, s) => (s === 'damageMult' ? ((ctx as Partial<GameContext>).enemies?.bossAlive() ? 0.2 : -0.1) : 0),
    tec_affinity: (r, s) => {
      const w = weapon();
      return s === 'damageMult' && w && w.element !== 'none' ? 0.08 * r : 0;
    },
    tec_kitted: (r, s) => {
      if (s !== 'damageMult') return 0;
      const lo = player()?.loadout;
      const pieces = lo ? Object.values(lo).filter(Boolean).length : 0;
      return 0.015 * Math.min(5, pieces) * r;
    },
    sho_spray: (r, s) => (s === 'fireRateMult' && SMG_SHOTGUN(weapon()?.archetype) ? 0.05 * r : 0),
    sho_feed: (r, s) => (s === 'damageMult' ? 0.03 * r * tierIdx() : 0),
    sho_in_your_face: (r, s) => (s === 'damageMult' && SMG_SHOTGUN(weapon()?.archetype) ? 0.06 * r : 0),
    sho_point_blank: (_r, s) =>
      (s === 'damageMult' || s === 'critMult') && enemiesWithin(T.pointBlankRange) > 0 ? 0.25 : 0,
    sho_aerialist: (r, s) => (s === 'damageMult' && airborne() ? 0.08 * r : 0),
    sho_daredevil: (_r, s) => ((s === 'damageMult' || s === 'fireRateMult') && healthFrac() < 0.5 ? 0.2 : 0),
    sho_ovation: (_r, s) => {
      if (tierIdx() !== 3) return 0;
      return s === 'damageMult' || s === 'fireRateMult' ? 0.25 : s === 'moveSpeedMult' ? 0.15 : 0;
    },
  };
  const condIds = Object.keys(CONDS);

  function mult(stat: DynStat): number {
    let m = 1;
    for (const id of condIds) {
      const r = rank(id);
      if (r > 0) {
        const v = CONDS[id](r, stat);
        if (v) m *= 1 + v;
      }
    }
    const t = now();
    for (const b of buffs.values()) {
      if (b.until > t) {
        const v = b.mods[stat];
        if (v) m *= 1 + v;
      }
    }
    if (stat === 'critMult' && formStacks > 0 && formUntil > t) m *= 1 + 0.02 * formStacks;
    return Math.max(0.05, m);
  }

  // ---- active ability ------------------------------------------------------------------------
  let activeReadyAt = -Infinity;
  let activeUntil = -Infinity;
  const activeDef = () => {
    const c = host.classId();
    return c ? CLASSES[c].active : null;
  };
  const activeCooldown = () => (activeDef()?.cooldown ?? 0) * host.extras().abilityCooldownMult;
  const encoreOn = () => host.classId() === 'showman' && activeUntil > now();

  const activeState: ActiveAbilityState = {
    get def() { return activeDef()!; },
    get unlocked() { return host.activeUnlocked(); },
    get ready() { return host.activeUnlocked() && now() >= activeReadyAt; },
    get cooldownLeft() { return Math.max(0, activeReadyAt - now()); },
    get cooldown() { return activeCooldown(); },
    get activeLeft() { return Math.max(0, activeUntil - now()); },
    get active() { return activeUntil > now(); },
  };

  function shockPulse(): void {
    const p = player();
    if (!p) return;
    const center = p.position.clone();
    center.y += 1;
    const dmg = (T.pulseBase + T.pulsePerRound * round()) * host.stats().damageMult * runDamage();
    ctx.enemies?.damageRadius(center, T.pulseRadius, dmg, { element: 'shock', applyStatus: true, sourceId: p.id, point: center.clone(), cause: 'explosion' });
    addShield(T.pulseShield);
    ctx.fx?.explosion(center, T.pulseRadius, ELEMENT_COLORS.shock);
    ctx.fx?.shake(0.25);
  }

  /** Run the class active (cooldown bookkeeping included). `force` skips the unlock check (capstones). */
  function fireActive(force: boolean): boolean {
    const def = activeDef();
    const p = player();
    if (!def || !p || !p.alive) return false;
    if (!force && !host.activeUnlocked()) return false;
    const t = now();
    if (t < activeReadyAt) return false;
    activeReadyAt = t + activeCooldown();
    activeUntil = t + def.duration;
    switch (def.id) {
      // Shield Bash (dash, path hits, knockback, invulnerability) and Deadeye (forced crits,
      // enemy time scale) are player-side: src/player reacts to active:used and reads `active`.
      case 'shield_bash':
      case 'deadeye':
        break;
      case 'shock_pulse':
        shockPulse();
        break;
      case 'encore':
        refillMag();
        p.addAmmo(1);
        buff('encore', def.duration, { fireRateMult: T.encoreFireRate });
        break;
    }
    say(def.name.toUpperCase(), 'legendary');
    ctx.events.emit('active:used', {
      playerId: p.id, abilityId: def.id, name: def.name, cooldown: activeCooldown(), duration: def.duration, forced: force,
    });
    return true;
  }

  // ---- melee (bridge + Knuckles + Executioner) ---------------------------------------------------
  let bridging = false;
  function onMeleeHit(e: { enemyId: string; playerId?: string; amount: number; killed: boolean; point: THREE.Vector3 }): void {
    const kn = rank('van_knuckles');
    if (kn > 0) addShield(0.04 * kn);
    const enemy: Enemy | undefined = ctx.enemies?.get(e.enemyId);
    if (!enemy || e.killed || !enemy.alive) return;
    let bonus = MELEE_BRIDGE ? host.extras().meleeMult - 1 : 0;
    const exec = rank('van_executioner') > 0;
    if (exec && enemy.isBoss) bonus += T.executionerBoss;
    const opts = { point: e.point, element: 'none' as Element, crit: false, sourceId: e.playerId, applyStatus: false, cause: 'melee' as const };
    bridging = true;
    try {
      if (bonus > 0) enemy.damage(e.amount * bonus, opts);
      if (exec && !enemy.isBoss && enemy.alive && enemy.state.health <= enemy.state.maxHealth * T.executeBelow) {
        enemy.damage(enemy.state.health + 1, opts);
        ctx.fx?.burst(e.point, 0xffffff, 18);
      }
    } finally {
      bridging = false;
    }
  }

  // ---- hype bonus ------------------------------------------------------------------------------
  function hypeBonus(): number {
    const c = host.classId();
    let b = c ? CLASSES[c].hypeBonus ?? 0 : 0;
    b += 0.1 * rank('sho_crowd_fav');
    if (encoreOn()) b += 1;
    return b;
  }

  // ---- event listeners -------------------------------------------------------------------------
  const ev = ctx.events;
  let shotCrit = false;
  let shotBody = false;
  let bullseyeUsed = false;

  ev.on('weapon:fired', (e) => {
    if (!isMe(e.playerId)) return;
    lastFired = now();
    if (rank('mar_perfect_form') > 0 && shotBody && !shotCrit) formStacks = Math.max(0, formStacks - 3);
    shotCrit = false;
    shotBody = false;
    bullseyeUsed = false;
  });

  ev.on('damage:dealt', (e) => {
    if (!isMe(e.playerId) || bridging) return;
    if (e.cause === 'melee') {
      onMeleeHit(e);
      return;
    }
    const bullet = e.cause === 'bullet';
    const enemy = ctx.enemies?.get(e.enemyId);

    if (bullet) {
      if (e.crit) {
        shotCrit = true;
        if (rank('mar_bullseye') > 0 && !bullseyeUsed) {
          bullseyeUsed = true;
          const p = player();
          if (p && p.activeWeapon) p.ammo = p.ammo + 1;
        }
        if (rank('mar_perfect_form') > 0) {
          formStacks = Math.min(T.perfectFormMax, formStacks + 1);
          formUntil = now() + T.perfectFormTime;
        }
        const sp = rank('mar_spotter');
        if (sp > 0 && !e.killed && enemy?.alive && ctx.rng() < 0.1 * sp) {
          enemy.applyStatus({ element: 'shock', remaining: 0.5, strength: e.amount * 0.25, sourceId: e.playerId });
        }
      } else {
        shotBody = true;
      }
      const cd = rank('tec_conductor');
      if (cd > 0 && e.element !== 'none' && !e.killed && enemy?.alive && ctx.rng() < 0.05 * cd) {
        if (e.element === 'fire') enemy.applyStatus({ element: 'fire', remaining: 4, strength: e.amount * 0.15, sourceId: e.playerId });
        else if (e.element === 'shock') enemy.applyStatus({ element: 'shock', remaining: 0.5, strength: e.amount * 0.3, sourceId: e.playerId });
        else enemy.applyStatus({ element: 'ice', remaining: 3, strength: 0.35, sourceId: e.playerId });
      }
    }

    if (e.crit && e.killed) {
      const hh = rank('mar_headhunter');
      if (hh > 0) buff('mar_headhunter', 5, { damageMult: 0.05 * hh });
      const rp = rank('mar_reposition');
      if (rp > 0) buff('mar_reposition', 3, { moveSpeedMult: 0.05 * rp });
      const jp = rank('sho_jackpot');
      if (jp > 0 && ctx.rng() < 0.03 * jp) drop(e.point, round(enemy?.state.tier), { kinds: ['weapon'] });
    }

    if (e.killed && e.cause !== 'explosion' && enemy && !enemy.isBoss) {
      const cat = rank('tec_catalyst');
      if (cat > 0 && e.element !== 'none') {
        ctx.enemies.damageRadius(e.point, T.catalystRadius, enemy.state.maxHealth * 0.1 * cat, {
          element: e.element, sourceId: e.playerId, excludeId: enemy.id, point: e.point.clone(), cause: 'explosion',
        });
        ctx.fx?.explosion(e.point, T.catalystRadius, ELEMENT_COLORS[e.element]);
      }
      if (rank('tec_meltdown') > 0 && enemy.state.statuses.some((s) => s.element === 'fire')) {
        ctx.enemies.damageRadius(e.point, T.meltdownRadius, enemy.state.maxHealth * T.meltdownFrac, {
          element: 'fire', applyStatus: true, sourceId: e.playerId, excludeId: enemy.id, point: e.point.clone(), cause: 'explosion',
        });
        ctx.fx?.explosion(e.point, T.meltdownRadius, ELEMENT_COLORS.fire);
      }
    }
  });

  ev.on('enemy:killed', (e) => {
    if (e.isBoss && rank('sho_sponsor') > 0 && player()?.alive) {
      drop(e.position, round(e.tier), { boost: T.sponsorBoost });
    }
    if (!isMe(e.killerId)) return;
    const p = player()!;
    const melee = e.cause === 'melee';
    const grenade = e.cause === 'grenade';
    let r: number;

    // Vanguard
    if (melee) {
      if ((r = rank('van_finisher')) > 0) healFrac(0.05 * r);
      if (rank('van_crowd_work') > 0) {
        if (ready('van_crowd_work', T.crowdWorkCd)) p.addGrenades(1);
        addHype(T.crowdWorkHype, 'melee_kill', 'CROWD WORK');
      }
      if ((r = rank('van_momentum')) > 0) buff('van_momentum', 4, { moveSpeedMult: 0.08 * r });
    }
    if ((r = rank('van_showboat')) > 0 && p.position.distanceTo(e.position) <= T.showboatRange) addHype(2 * r, 'kill');
    if ((r = rank('van_bloodlust')) > 0) buff('van_bloodlust', 4, { fireRateMult: 0.04 * r });
    if (rank('van_unbroken') > 0) {
      if (p.shield > 0) addShield(0.08);
      else healFrac(0.04);
    }

    // Technician
    if (grenade) {
      if ((r = rank('tec_recycler')) > 0 && ctx.rng() < 0.15 * r) p.addGrenades(1);
      if ((r = rank('tec_cluster')) > 0) {
        const at = e.position.clone();
        at.y += 0.5;
        ctx.enemies.damageRadius(at, T.clusterRadius, 30 * r * host.stats().damageMult * runDamage(), {
          element: 'none', sourceId: p.id, excludeId: e.enemy.id, point: at.clone(), cause: 'explosion',
        });
        ctx.fx?.explosion(at, T.clusterRadius, 0xffa040);
      }
    }
    if (!e.isBoss && rank('tec_salvage') > 0 && ctx.rng() < T.salvageChance) drop(e.position, round(e.tier));
    if (e.cause === 'status' && rank('tec_siphon') > 0) addShield(0.1);

    // Showman
    if (!e.isBoss) {
      const hb = hypeBonus();
      if (hb > 0) addHype(HYPE.gain.kill * hb, 'kill');
    }
    if ((r = rank('sho_hit_run')) > 0) buff('sho_hit_run', 3, { moveSpeedMult: 0.04 * r });
    if ((r = rank('sho_lucky')) > 0 && ctx.rng() < 0.02 * r) {
      const kinds: LootKind[] = ['ammo', 'health', 'grenade'];
      drop(e.position, round(e.tier), { kinds: [kinds[Math.floor(ctx.rng() * kinds.length) % kinds.length]] });
    }
    if ((r = rank('sho_high_roller')) > 0 && ctx.rng() < 0.05 * r) refillMag();
    if (rank('sho_glory') > 0 && tierIdx() >= 2) {
      healFrac(0.03);
      addShield(0.05);
    }
  });

  ev.on('player:shield', (e) => {
    if (!e.broken || !isMe(e.playerId)) return;
    const st = rank('van_scar_tissue');
    if (st > 0 && ready('van_scar_tissue', T.scarTissueCd)) healFrac(0.04 * st);
    if (rank('van_overcharge') > 0 && ready('van_overcharge', T.overchargeCd)) {
      const p = player()!;
      p.shield = Math.max(p.shield, p.maxShield * T.overchargeShield);
      say('OVERCHARGE CELL');
    }
    if (rank('tec_storm_engine') > 0 && host.classId() === 'technician') fireActive(true);
  });

  ev.on('loot:pickup', (e) => {
    if (!isMe(e.playerId)) return;
    const p = player()!;
    let r: number;
    if (e.item.kind === 'ammo' && (r = rank('tec_scrounger')) > 0) p.addAmmo(AMMO_PICKUP * 0.2 * r);
    if (e.item.kind === 'health' && (r = rank('tec_field_medic')) > 0) p.heal(HEALTH_PICKUP * 0.15 * r);
  });

  const resupply = () => {
    const p = player();
    if (!p || !p.alive || rank('tec_resupply') <= 0) return;
    p.addGrenades(99); // clamped to the player's cap
    p.addAmmo(0.5);
  };
  ev.on('round:started', resupply);
  ev.on('boss:phase', resupply);
  ev.on('round:cleared', () => {
    const p = player();
    if (!p || !p.alive || rank('pit_pack_mule') <= 0) return;
    p.addGrenades(1);
    p.addAmmo(0.5);
  });

  ev.on('hype:reaction', (e) => {
    if (ownHype || !(e.amount > 0)) return;
    const hb = hypeBonus();
    if (hb > 0) addHype(e.amount * hb, e.reason);
    if (rank('sho_showstopper') > 0 && MULTI_KILL.test(e.label)) refillMag();
  });

  ev.on('hype:changed', (e) => {
    if (!e.tierChanged || rank('sho_fan_service') <= 0) return;
    const up = HYPE_TIERS.indexOf(e.tier) > HYPE_TIERS.indexOf(e.previousTier);
    if (!up || (e.tier !== 'hot' && e.tier !== 'roaring') || !ready('sho_fan_service', T.fanServiceCd)) return;
    const p = player();
    if (!p || !p.alive) return;
    p.addGrenades(99);
    healFrac(0.25);
    addShield(1);
    say('FAN SERVICE', 'legendary');
  });

  ev.on('standing:gained', (e) => {
    const st = (ctx as Partial<GameContext>).standing?.standing;
    if (!st || e.reason === 'skill') return;
    if (e.reason === 'boss' && rank('mar_trophy') > 0) st.award(e.amount * 0.5, 'skill', 'Trophy Hunter', true);
    const tj = rank('sho_tip_jar');
    if (e.reason === 'hype' && tj > 0) st.award(e.amount * 0.15 * tj, 'skill', 'Tip Jar', true);
  });

  function reset(): void {
    buffs.clear();
    cds.clear();
    formStacks = 0;
    formUntil = -Infinity;
    lastFired = -Infinity;
    activeReadyAt = -Infinity;
    activeUntil = -Infinity;
  }
  ev.on('game:started', reset);

  return {
    mult,
    get active() { return activeDef() ? activeState : null; },
    useActive: () => fireActive(false),
    reset,
  };
}
