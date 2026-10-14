/**
 * System D — round state machine (PLAN §2):
 * idle → intermission → wave (SUB_WAVES sub-waves, trickle spawns) → boss → cleared → intermission …
 * any → gameover on death. Host-only sim; emits events for HUD/audio.
 *
 * Run modifiers (sponsor contract, system I): enemy count, loot count, no grenade drops and
 * "a headliner closes every sub-wave" (bossEveryRound). The ROARING crowd's "bonus wave" gift
 * extends the current sub-wave. A run keeps the player's weapons and gear (start() only adds a
 * starter gun when both slots are empty).
 */
import * as THREE from 'three';
import { INTERMISSION_SECONDS, LOOT, SUB_WAVES, maxAliveForRound, mobsForRound } from '@/core/config';
import { randInt, randRange } from '@/core/rng';
import type { BossKind, GameContext, LootKind, RoundManager, RoundPhase, RoundState } from '@/core/types';
import { scaleEnemyCount, scaleLootCount } from '@/standing/sponsors';

const CLEARED_SECONDS = 8;
const SUBWAVE_BREAK = 2.5;
const BOSS_NAMES: Record<BossKind, string> = { brute: 'Brute', summoner: 'Summoner', artillery: 'Artillery' };
const BOSS_CYCLE: readonly BossKind[] = ['brute', 'summoner', 'artillery'];
/** Sponsor mid-sub-wave headliner: a small shower that does not end the round. */
const MID_BOSS_DROPS = 2;

export function createRoundManager(ctx: GameContext): RoundManager {
  const state: RoundState = {
    round: 0, phase: 'idle', phaseTime: 0, killsRequired: 0, kills: 0, subWave: 0, totalKills: 0,
  };

  // Internal wave bookkeeping
  let quotas: number[] = [];
  let spawnedInSub = 0;
  let spawnTimer = 0;
  let subBreak = 0; // pause before the next sub-wave starts spawning
  let bossId: string | null = null;
  let bossDead = false;
  let midBossSpawned = false; // sponsor bossEveryRound: a boss closes every sub-wave but the last
  const bossPos = new THREE.Vector3();

  const run = () => ctx.standing?.sponsors.active;
  const mobsThisRound = (round: number) => {
    const m = run();
    return m ? scaleEnemyCount(mobsForRound(round), m) : mobsForRound(round);
  };
  /** In a co-op session the host's menus must not freeze the shared simulation. */
  const inSession = () => !!ctx.net?.inSession;

  function setPhase(phase: RoundPhase): void {
    state.phase = phase;
    state.phaseTime = 0;
    ctx.events.emit('round:phase', { phase, round: state.round });
  }

  function beginIntermission(): void {
    state.kills = 0;
    state.killsRequired = mobsThisRound(state.round);
    state.subWave = 0;
    state.bossKind = undefined;
    setPhase('intermission');
    ctx.events.emit('round:intermission', { round: state.round, seconds: INTERMISSION_SECONDS });
  }

  function splitQuotas(total: number): number[] {
    const base = Math.floor(total / SUB_WAVES);
    const q = new Array(SUB_WAVES).fill(base) as number[];
    // remainder goes to the later (harder) sub-waves
    for (let i = 0; i < total - base * SUB_WAVES; i++) q[SUB_WAVES - 1 - i]++;
    return q;
  }

  function beginWave(): void {
    state.killsRequired = mobsThisRound(state.round);
    state.kills = 0;
    state.subWave = 0;
    state.bossKind = undefined;
    quotas = splitQuotas(state.killsRequired);
    bossId = null;
    bossDead = false;
    setPhase('wave');
    ctx.events.emit('round:started', { round: state.round, killsRequired: state.killsRequired });
    ctx.events.emit('round:progress', { kills: 0, killsRequired: state.killsRequired });
    beginSubWave();
  }

  function beginSubWave(): void {
    state.subWave++;
    spawnedInSub = 0;
    midBossSpawned = false;
    spawnTimer = 0.4;
    subBreak = state.subWave > 1 ? SUBWAVE_BREAK : 0;
    ctx.events.emit('round:subwave', { round: state.round, subWave: state.subWave, total: SUB_WAVES });
  }

  function pickSpawnPoint(): THREE.Vector3 {
    const pts = ctx.world.mobSpawnPoints;
    const from = ctx.player ? ctx.player.position : new THREE.Vector3();
    // co-op: rank points by the distance to the NEAREST living player
    const living = ctx.players ? ctx.players.list().filter((pl) => pl.alive) : [];
    const minDist2 = (p: THREE.Vector3) => {
      if (!living.length) return p.distanceToSquared(from);
      let m = Infinity;
      for (const pl of living) m = Math.min(m, p.distanceToSquared(pl.position));
      return m;
    };
    const sorted = pts
      .map((p) => ({ p, d: minDist2(p) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 4);
    const base = sorted.length ? sorted[Math.floor(ctx.rng() * sorted.length)].p : ctx.world.randomNavigablePoint(from, 15);
    const x = base.x + randRange(ctx.rng, -1, 1);
    const z = base.z + randRange(ctx.rng, -1, 1);
    return new THREE.Vector3(x, ctx.world.groundHeight(x, z), z);
  }

  function aliveMobs(): number {
    let n = 0;
    for (const e of ctx.enemies.list()) if (e.alive && !e.isBoss) n++;
    return n;
  }

  function updateWave(dt: number): void {
    if (subBreak > 0) {
      subBreak -= dt;
      return;
    }
    const quota = quotas[state.subWave - 1] ?? 0;
    if (spawnedInSub < quota) {
      spawnTimer -= dt;
      if (spawnTimer <= 0 && aliveMobs() < maxAliveForRound(state.round)) {
        ctx.enemies.spawnMob('random', pickSpawnPoint(), state.round);
        spawnedInSub++;
        spawnTimer = randRange(ctx.rng, 0.6, 1.2);
      }
      return;
    }
    // Quota spawned: sub-wave ends when everything is dead.
    if (aliveMobs() > 0) return;
    if (run()?.bossEveryRound && state.subWave < SUB_WAVES) {
      if (!midBossSpawned) {
        midBossSpawned = true;
        const kind = BOSS_CYCLE[(state.round + state.subWave) % BOSS_CYCLE.length];
        ctx.enemies.spawnBoss(kind, ctx.world.bossSpawn, state.round);
        ctx.events.emit('ui:message', { text: 'Sponsor segment: a headliner enters!', duration: 3, style: 'warning' });
        return;
      }
      if (ctx.enemies.bossAlive()) return;
    }
    if (state.subWave < SUB_WAVES) beginSubWave();
    else beginBoss();
  }

  function beginBoss(): void {
    const boss = ctx.enemies.spawnBoss('auto', ctx.world.bossSpawn, state.round);
    bossId = boss.id;
    bossDead = false;
    const kind = (['brute', 'summoner', 'artillery'] as const).includes(boss.state.kind as BossKind)
      ? (boss.state.kind as BossKind)
      : 'brute';
    state.bossKind = kind;
    setPhase('boss');
    ctx.events.emit('round:boss', { round: state.round, bossKind: kind });
  }

  function updateBoss(): void {
    // Safety net: boss vanished without an enemy:killed event.
    if (!bossDead && state.phaseTime > 1 && !ctx.enemies.bossAlive()) {
      const b = bossId ? ctx.enemies.get(bossId) : undefined;
      bossPos.copy(b ? b.position : ctx.world.bossSpawn);
      bossDead = true;
    }
    if (bossDead) beginCleared();
  }

  function beginCleared(): void {
    setPhase('cleared');
    const drops = randInt(ctx.rng, LOOT.bossDrops.min, LOOT.bossDrops.max);
    const m = run();
    ctx.loot.dropLoot(bossPos.clone(), {
      tier: state.round,
      rarityBoost: 0.5,
      count: m ? scaleLootCount(drops, m, 2) : drops,
      guaranteed: ['weapon', 'gear'],
    });
    ctx.events.emit('round:cleared', { round: state.round });
    const bossName = state.bossKind ? BOSS_NAMES[state.bossKind] : 'Boss';
    ctx.events.emit('ui:message', { text: `${bossName} down! Grab the loot`, duration: 4, style: 'legendary' });
  }

  function rollMobDrops(position: THREE.Vector3): void {
    const kinds: LootKind[] = [];
    const m = run();
    // lootCountMult 2 → roll the table twice; the fractional part is the chance of one more roll
    const mult = m ? Math.max(0, m.lootCountMult) : 1;
    const rolls = Math.floor(mult) + (ctx.rng() < mult % 1 ? 1 : 0);
    for (let r = 0; r < rolls; r++) {
      if (ctx.rng() < LOOT.mobWeaponDropChance) kinds.push('weapon');
      if (ctx.rng() < LOOT.mobAmmoDropChance) kinds.push('ammo');
      if (ctx.rng() < LOOT.mobHealthDropChance) kinds.push('health');
      if (!m?.grenadeless && ctx.rng() < LOOT.mobGrenadeDropChance) kinds.push('grenade');
      if (ctx.rng() < LOOT.mobGearDropChance) kinds.push('gear');
    }
    if (!kinds.length) return;
    const ground = ctx.world.groundHeight(position.x, position.z);
    ctx.loot.dropLoot(new THREE.Vector3(position.x, ground, position.z), {
      tier: Math.max(1, state.round),
      count: kinds.length,
      guaranteed: kinds,
    });
  }

  // ---- events --------------------------------------------------------------
  ctx.events.on('enemy:killed', (e) => {
    if (!ctx.isHost) return;
    if (state.phase === 'idle' || state.phase === 'gameover') return;
    // every kill of the run counts (summoner adds can survive into the intermission)
    state.totalKills++;
    if (e.isBoss) {
      // sponsor mid-sub-wave headliner (wave phase): small shower, does not end the round
      if (state.phase === 'wave') {
        ctx.loot.dropLoot(e.position.clone(), { tier: state.round, rarityBoost: 0.3, count: MID_BOSS_DROPS, guaranteed: ['weapon'] });
        return;
      }
      if (state.phase === 'boss' && (!bossId || e.enemy.id === bossId) && !bossDead) {
        bossPos.copy(e.position);
        bossDead = true;
      }
      return;
    }
    // no drops for self-detonations / kills nobody earned; they still count for the wave
    if (e.killerId) rollMobDrops(e.position);
    if (state.phase === 'wave') {
      state.kills = Math.min(state.kills + 1, state.killsRequired);
      ctx.events.emit('round:progress', { kills: state.kills, killsRequired: state.killsRequired });
    }
  });

  ctx.events.on('player:died', ({ playerId }) => {
    if (!ctx.isHost) return;
    if (state.phase === 'idle' || state.phase === 'gameover') return;
    const othersAlive = ctx.players.list().some((p) => p.id !== playerId && p.alive);
    if (othersAlive) return;
    setPhase('gameover');
    ctx.events.emit('game:over', { round: state.round, kills: state.totalKills });
  });

  // Crowd gift "bonus wave" (system I): extend the current sub-wave.
  ctx.events.on('hype:gift', (g) => {
    if (!ctx.isHost || g.kind !== 'bonuswave' || state.phase !== 'wave' || !g.mobs || state.subWave < 1) return;
    quotas[state.subWave - 1] = (quotas[state.subWave - 1] ?? 0) + g.mobs;
    state.killsRequired += g.mobs;
    ctx.events.emit('round:progress', { kills: state.kills, killsRequired: state.killsRequired });
  });

  // ---- API -----------------------------------------------------------------
  function start(): void {
    if (!ctx.isHost) return;
    ctx.enemies.clear();
    ctx.loot.clear();
    // Weapons and gear are KEPT across runs (design decision); reset() restores vitals/ammo and
    // reads the sponsor contract, which choose() has already applied.
    ctx.player.reset();
    if (!ctx.player.weapons.some((w) => !!w)) ctx.player.equip(ctx.loot.starterWeapon());
    state.round = 1;
    state.totalKills = 0;
    state.kills = 0;
    state.killsRequired = mobsThisRound(1);
    state.subWave = 0;
    state.bossKind = undefined;
    quotas = [];
    bossId = null;
    bossDead = false;
    midBossSpawned = false;
    beginIntermission();
    ctx.events.emit('game:started', {});
  }

  function update(dt: number): void {
    if (!ctx.isHost) return;
    // Freeze the round clock while a menu is open (single-player only: in a co-op session the
    // host's menus must not stop the shared simulation).
    const screen = ctx.hud ? ctx.hud.screen : 'none';
    if ((screen === 'pause' || screen === 'skills' || screen === 'inventory') && !inSession()) return;

    state.phaseTime += dt;
    switch (state.phase) {
      case 'intermission':
        if (state.phaseTime >= INTERMISSION_SECONDS) beginWave();
        break;
      case 'wave':
        updateWave(dt);
        break;
      case 'boss':
        updateBoss();
        break;
      case 'cleared':
        if (state.phaseTime >= CLEARED_SECONDS) {
          state.round++;
          beginIntermission();
        }
        break;
      default:
        break;
    }
  }

  return { state, start, update };
}
