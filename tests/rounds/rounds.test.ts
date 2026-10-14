import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { INTERMISSION_SECONDS, SUB_WAVES, maxAliveForRound, mobsForRound } from '@/core/config';
import type {
  BossKind, DropOpts, Enemy, EnemyRegistry, LootDropSpec, LootItemState, LootSystem, MobKind, Progression, RoundManager, WeaponArchetype, WeaponDef,
} from '@/core/types';
import { starterWeapon } from '@/loot/weapons';
import { createPlayerRegistry } from '@/player';
import { createRoundManager } from '@/rounds';
import {
  callsOf, createFakeContext, createFakePlayer, fakeHud, recordEvents, type FakePlayer, type Recorder, type TestContext,
} from '../helpers/fakeContext';

// ---------------------------------------------------------------------------
// Controllable fakes
// ---------------------------------------------------------------------------
interface FE extends Enemy { alive: boolean; hits: number }

class FakeEnemies implements EnemyRegistry {
  all: FE[] = [];
  mobSpawns: { kind: string; position: THREE.Vector3; tier: number }[] = [];
  bossSpawns: { kind: string; position: THREE.Vector3; tier: number }[] = [];
  clears = 0;
  maxAliveMobsSeen = 0;
  private n = 0;
  constructor(private ctx: TestContext) {}

  private make(kind: MobKind | BossKind, isBoss: boolean, position: THREE.Vector3, tier: number): FE {
    const id = `${isBoss ? 'boss' : 'mob'}${++this.n}`;
    const e: FE = {
      id, isBoss, alive: true, hits: 0, object: new THREE.Group(), position: position.clone(), radius: 0.5, height: 2,
      state: {
        id, kind, isBoss, tier, position: position.clone(), yaw: 0, health: 10, maxHealth: 10, alive: true,
        phase: 0, anim: 'idle', statuses: [],
      },
      isCritPoint: () => false,
      // lethal hits kill (no killer: the pit stop's leftover sweep)
      damage: (amount: number) => {
        e.hits++;
        if (amount >= 1e6 && e.alive) this.kill(e, true, undefined);
        return amount;
      },
      applyStatus: () => {},
    };
    this.all.push(e);
    return e;
  }
  list() { return this.all; }
  get(id: string) { return this.all.find((e) => e.id === id); }
  spawnMob(kind: MobKind | 'random', position: THREE.Vector3, tier: number) {
    this.mobSpawns.push({ kind, position: position.clone(), tier });
    const e = this.make(kind === 'random' ? 'grunt' : kind, false, position, tier);
    this.maxAliveMobsSeen = Math.max(this.maxAliveMobsSeen, this.aliveMobs().length);
    return e;
  }
  spawnBoss(kind: BossKind | 'auto', position: THREE.Vector3, tier: number) {
    this.bossSpawns.push({ kind, position: position.clone(), tier });
    const k: BossKind = kind === 'auto' ? (['brute', 'summoner', 'artillery'] as const)[(tier - 1) % 3] : kind;
    return this.make(k, true, position, tier);
  }
  damageRadius() { return 0; }
  aliveCount() { return this.all.filter((e) => e.alive).length; }
  bossAlive() { return this.all.some((e) => e.isBoss && e.alive); }
  clear() { this.clears++; this.all = []; }
  update() {}
  aliveMobs() { return this.all.filter((e) => e.alive && !e.isBoss); }

  kill(e: FE, emit = true, killerId: string | undefined = 'p1'): void {
    e.alive = false;
    e.state.alive = false;
    if (emit) {
      this.ctx.events.emit('enemy:killed', {
        enemy: e, position: e.position.clone(), isBoss: e.isBoss, tier: e.state.tier, killerId,
      });
    }
  }
  killAllMobs(): number {
    const mobs = this.aliveMobs();
    for (const m of mobs) this.kill(m);
    return mobs.length;
  }
}

class FakeLoot implements LootSystem {
  drops: { position: THREE.Vector3; opts: DropOpts }[] = [];
  clears = 0;
  private n = 0;
  items(): LootItemState[] { return []; }
  dropLoot(position: THREE.Vector3, opts: DropOpts) { this.drops.push({ position: position.clone(), opts }); return []; }
  generateWeapon(): WeaponDef { return starterWeapon(() => `w${++this.n}`); }
  starterArchetypes: (WeaponArchetype | undefined)[] = [];
  starterWeapon(archetype?: WeaponArchetype): WeaponDef {
    this.starterArchetypes.push(archetype);
    return starterWeapon(() => `starter${++this.n}`, archetype);
  }
  dropItem(spec: LootDropSpec): LootItemState { return { ...spec, id: `drop${++this.n}`, ownerId: spec.ownerId ?? 'p1', age: 0 }; }
  remove() { return false; }
  clear() { this.clears++; }
  update() {}
}

// ---------------------------------------------------------------------------
let ctx: TestContext;
let enemies: FakeEnemies;
let loot: FakeLoot;
let player: FakePlayer;
let rounds: RoundManager;
let ev: Recorder;

function setup(): void {
  ctx = createFakeContext({ seed: 4242 });
  ev = recordEvents(ctx.events);
  ctx.players = createPlayerRegistry();
  player = createFakePlayer('p1', new THREE.Vector3(0, 0, 26));
  ctx.players.add(player);
  ctx.player = player;
  enemies = new FakeEnemies(ctx);
  loot = new FakeLoot();
  ctx.enemies = enemies;
  ctx.loot = loot;
  ctx.hud = fakeHud('none');
  rounds = createRoundManager(ctx);
}

/** Tick the manager in small steps for `seconds`. */
function run(seconds: number, dt = 0.1, each?: () => void): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    rounds.update(dt);
    each?.();
  }
}

function toWave(): void {
  rounds.start();
  run(INTERMISSION_SECONDS + 0.15);
  expect(rounds.state.phase).toBe('wave');
}

/** Clear one sub-wave: let everything spawn while killing as we go, until the sub-wave advances. */
function clearSubWave(): void {
  const sub = rounds.state.subWave;
  for (let i = 0; i < 2000 && rounds.state.subWave === sub && rounds.state.phase === 'wave'; i++) {
    rounds.update(0.1);
    enemies.killAllMobs();
  }
}

beforeEach(() => setup());

describe('RoundManager.start', () => {
  it('starts idle; start() resets systems and enters round 1 intermission', () => {
    expect(rounds.state.phase).toBe('idle');
    rounds.start();
    expect(rounds.state).toMatchObject({ round: 1, phase: 'intermission', kills: 0, totalKills: 0, killsRequired: mobsForRound(1) });
    expect(enemies.clears).toBe(1);
    expect(loot.clears).toBe(1);
    expect(callsOf(player, 'reset')).toHaveLength(1);
    expect(ev.of('round:intermission')[0]).toEqual({ round: 1, seconds: INTERMISSION_SECONDS });
    expect(ev.count('game:started')).toBe(1);
  });

  it('equips the starter weapon only when the player has no weapon', () => {
    rounds.start();
    expect(callsOf(player, 'equip')).toHaveLength(1);
    expect(player.weapons[0]!.name).toBe('Rusty Iron');
    rounds.start();
    expect(callsOf(player, 'equip')).toHaveLength(1);
  });

  it('the starter is the class starter archetype (classDef.starterArchetype), pistol without a class', () => {
    rounds.start();
    expect(loot.starterArchetypes).toEqual([undefined]);
    setup();
    ctx.progression = { classDef: { starterArchetype: 'shotgun' } } as unknown as Progression;
    rounds.start();
    expect(loot.starterArchetypes).toEqual(['shotgun']);
    expect(player.weapons[0]!.archetype).toBe('shotgun');
    expect(player.weapons[0]!.name).toBe('Rusty Doorkicker');
    expect(player.weapons[0]!.rarity).toBe('common');
  });

  it('does nothing on a non-host peer', () => {
    ctx.isHost = false;
    rounds.start();
    rounds.update(10);
    expect(rounds.state.phase).toBe('idle');
  });

  it('freezes the round clock while the pause or skills screen is open', () => {
    rounds.start();
    ctx.hud = fakeHud('pause');
    run(INTERMISSION_SECONDS * 2);
    expect(rounds.state.phase).toBe('intermission');
    expect(rounds.state.phaseTime).toBe(0);
    ctx.hud = fakeHud('none');
    run(INTERMISSION_SECONDS + 0.15);
    expect(rounds.state.phase).toBe('wave');
  });
});

describe('RoundManager wave phase', () => {
  it('intermission → wave after INTERMISSION_SECONDS with round:started', () => {
    rounds.start();
    run(INTERMISSION_SECONDS - 0.2);
    expect(rounds.state.phase).toBe('intermission');
    run(0.3);
    expect(rounds.state.phase).toBe('wave');
    expect(rounds.state.subWave).toBe(1);
    expect(ev.of('round:started')[0]).toEqual({ round: 1, killsRequired: mobsForRound(1) });
    expect(ev.of('round:subwave')[0]).toMatchObject({ subWave: 1, total: SUB_WAVES });
  });

  it('respects maxAliveForRound when nobody dies (round 5: sub-wave quota 20 > cap 18)', () => {
    rounds.start();
    rounds.state.round = 5; // jump ahead: beginWave() derives everything from state.round
    run(INTERMISSION_SECONDS + 0.15);
    expect(Math.floor(mobsForRound(5) / SUB_WAVES)).toBeGreaterThan(maxAliveForRound(5));
    run(120);
    expect(enemies.maxAliveMobsSeen).toBe(maxAliveForRound(5));
    expect(enemies.aliveMobs().length).toBe(maxAliveForRound(5));
    // killing frees slots and the trickle resumes
    enemies.kill(enemies.aliveMobs()[0]);
    run(3);
    expect(enemies.mobSpawns.length).toBe(maxAliveForRound(5) + 1);
  });

  it('spawns exactly the sub-wave quota, then waits for the sub-wave to die', () => {
    toWave();
    const total = mobsForRound(1);
    const q1 = Math.floor(total / SUB_WAVES);
    // kill as they come so the alive cap never blocks
    run(60, 0.1, () => enemies.killAllMobs());
    // quota for sub-wave 1 done and all dead → sub-wave advanced at least once
    expect(rounds.state.subWave).toBeGreaterThan(1);
    expect(enemies.mobSpawns.length).toBeGreaterThanOrEqual(q1);
  });

  it('quotas add up to mobsForRound, with the remainder on later sub-waves, then the boss spawns', () => {
    toWave();
    const perSub: number[] = [];
    for (let s = 1; s <= SUB_WAVES; s++) {
      const before = enemies.mobSpawns.length;
      clearSubWave();
      perSub.push(enemies.mobSpawns.length - before);
    }
    expect(perSub.reduce((a, b) => a + b, 0)).toBe(mobsForRound(1));
    for (let i = 1; i < perSub.length; i++) expect(perSub[i]).toBeGreaterThanOrEqual(perSub[i - 1]);
    expect(rounds.state.phase).toBe('boss');
    expect(rounds.state.kills).toBe(mobsForRound(1));
  });

  it('spawns mobs with the round as tier, away from the player', () => {
    toWave();
    run(5);
    expect(enemies.mobSpawns.length).toBeGreaterThan(0);
    for (const s of enemies.mobSpawns) {
      expect(s.kind).toBe('random');
      expect(s.tier).toBe(1);
      expect(s.position.distanceTo(player.position)).toBeGreaterThan(15);
    }
  });

  it('wave progress counts only wave kills; totalKills counts the whole run (FINDINGS #6) and emits round:progress', () => {
    rounds.start();
    const stray = enemies.spawnMob('grunt', new THREE.Vector3(), 1);
    enemies.kill(stray);
    expect(rounds.state.kills).toBe(0);
    expect(rounds.state.totalKills).toBe(1);
    run(INTERMISSION_SECONDS + 0.15);
    run(3);
    const first = enemies.aliveMobs()[0];
    enemies.kill(first);
    expect(rounds.state.kills).toBe(1);
    expect(rounds.state.totalKills).toBe(2);
    expect(ev.of('round:progress').at(-1)).toEqual({ kills: 1, killsRequired: mobsForRound(1) });
  });

  it('mob kills can roll drops (tier = round) through loot.dropLoot', () => {
    toWave();
    run(40, 0.1, () => enemies.killAllMobs());
    const mobDrops = loot.drops.filter((d) => !d.opts.rarityBoost);
    expect(mobDrops.length).toBeGreaterThan(0);
    for (const d of mobDrops) {
      expect(d.opts.tier).toBe(1);
      expect(d.opts.count).toBe(d.opts.guaranteed!.length);
    }
  });
});

describe('RoundManager boss / cleared', () => {
  function toBoss(): void {
    toWave();
    for (let s = 0; s < SUB_WAVES; s++) clearSubWave();
    expect(rounds.state.phase).toBe('boss');
  }

  it("spawns the boss at world.bossSpawn with 'auto' and the round tier", () => {
    toBoss();
    expect(enemies.bossSpawns).toHaveLength(1);
    expect(enemies.bossSpawns[0].kind).toBe('auto');
    expect(enemies.bossSpawns[0].tier).toBe(1);
    expect(enemies.bossSpawns[0].position.equals(ctx.world.bossSpawn)).toBe(true);
    expect(rounds.state.bossKind).toBe('brute');
    expect(ev.of('round:boss')[0]).toEqual({ round: 1, bossKind: 'brute' });
  });

  it('boss death → cleared with a boss loot shower (guaranteed weapon only, rarityBoost, 3..5 items)', () => {
    toBoss();
    const boss = enemies.all.find((e) => e.isBoss)!;
    boss.position.set(3, 0, -12);
    enemies.kill(boss);
    expect(rounds.state.totalKills).toBe(mobsForRound(1) + 1);
    rounds.update(0.1);
    expect(rounds.state.phase).toBe('cleared');
    const bossDrops = loot.drops.filter((d) => d.opts.rarityBoost);
    expect(bossDrops).toHaveLength(1);
    const d = bossDrops[0];
    expect(d.opts.guaranteed).toEqual(['weapon']); // gear is bought in the shop now (PLAN §13)
    expect(d.opts.rarityBoost).toBe(0.5);
    expect(d.opts.tier).toBe(1);
    expect(d.opts.count).toBeGreaterThanOrEqual(3);
    expect(d.opts.count).toBeLessThanOrEqual(5);
    expect(d.position.toArray()).toEqual([3, 0, -12]);
    expect(ev.of('round:cleared')).toEqual([{ round: 1 }]);
    expect(ev.of('ui:message').at(-1)!.style).toBe('legendary');
  });

  it('boss that vanishes without enemy:killed still clears (safety net)', () => {
    toBoss();
    enemies.kill(enemies.all.find((e) => e.isBoss)!, false);
    run(1.5);
    expect(rounds.state.phase).toBe('cleared');
  });

  it('a non-boss kill during the boss phase does not clear the round', () => {
    toBoss();
    const add = enemies.spawnMob('grunt', new THREE.Vector3(), 1);
    enemies.kill(add);
    rounds.update(0.1);
    expect(rounds.state.phase).toBe('boss');
  });

  it('pit stop: cleared never times out; continue() starts the next intermission', () => {
    toBoss();
    expect(rounds.continue!()).toBe(false); // not in the pit stop yet
    enemies.kill(enemies.all.find((e) => e.isBoss)!);
    rounds.update(0.1);
    run(120);
    expect(rounds.state.phase).toBe('cleared');
    expect(rounds.state.round).toBe(1);
    expect(ev.count('round:intermission')).toBe(1);
    expect(rounds.continue!()).toBe(true);
    expect(rounds.state.phase).toBe('intermission');
    expect(rounds.state.round).toBe(2);
    expect(ev.of('round:intermission').at(-1)).toEqual({ round: 2, seconds: INTERMISSION_SECONDS });
    expect(rounds.continue!()).toBe(false);
  });

  it('pit stop: only the host continues', () => {
    toBoss();
    enemies.kill(enemies.all.find((e) => e.isBoss)!);
    rounds.update(0.1);
    ctx.isHost = false;
    expect(rounds.continue!()).toBe(false);
    expect(rounds.state.phase).toBe('cleared');
  });

  it('pit stop: leftover minions are killed when it starts (no killer, so no drops)', () => {
    toBoss();
    const add = enemies.spawnMob('grunt', new THREE.Vector3(), 1);
    const dropsBefore = loot.drops.length;
    enemies.kill(enemies.all.find((e) => e.isBoss)!);
    rounds.update(0.1);
    expect(rounds.state.phase).toBe('cleared');
    expect(add.alive).toBe(false);
    expect(add.hits).toBe(1);
    expect(enemies.aliveMobs()).toHaveLength(0);
    // only the boss shower was dropped
    expect(loot.drops.length - dropsBefore).toBe(1);
  });

  it('cleared → continue → next round intermission; round 2 is bigger and gets the next boss', () => {
    toBoss();
    enemies.kill(enemies.all.find((e) => e.isBoss)!);
    rounds.update(0.1);
    run(8.1);
    expect(rounds.state.phase).toBe('cleared');
    rounds.continue!();
    expect(rounds.state.phase).toBe('intermission');
    expect(rounds.state.round).toBe(2);
    expect(rounds.state.kills).toBe(0);
    expect(rounds.state.killsRequired).toBe(mobsForRound(2));
    run(INTERMISSION_SECONDS + 0.15);
    for (let s = 0; s < SUB_WAVES; s++) clearSubWave();
    expect(rounds.state.phase).toBe('boss');
    expect(rounds.state.bossKind).toBe('summoner');
    expect(enemies.mobSpawns.filter((m) => m.tier === 2)).toHaveLength(mobsForRound(2));
  });

  it('cleared-phase kills count toward totalKills but not round kills', () => {
    toBoss();
    enemies.kill(enemies.all.find((e) => e.isBoss)!);
    rounds.update(0.1);
    const t = rounds.state.totalKills;
    enemies.kill(enemies.spawnMob('grunt', new THREE.Vector3(), 1));
    expect(rounds.state.totalKills).toBe(t + 1);
    expect(rounds.state.kills).toBe(mobsForRound(1));
  });
});

describe('RoundManager game over', () => {
  it('player:died with nobody else alive → gameover + game:over', () => {
    toWave();
    enemies.kill(enemies.spawnMob('grunt', new THREE.Vector3(), 1));
    player.alive = false;
    ctx.events.emit('player:died', { playerId: 'p1' });
    expect(rounds.state.phase).toBe('gameover');
    expect(ev.of('game:over')).toEqual([{ round: 1, kills: 1 }]);
    run(30);
    expect(rounds.state.phase).toBe('gameover');
  });

  it('no game over while another player is alive', () => {
    const p2 = createFakePlayer('p2', new THREE.Vector3(), false);
    ctx.players.add(p2);
    toWave();
    player.alive = false;
    ctx.events.emit('player:died', { playerId: 'p1' });
    expect(rounds.state.phase).toBe('wave');
    p2.alive = false;
    ctx.events.emit('player:died', { playerId: 'p2' });
    expect(rounds.state.phase).toBe('gameover');
  });

  it('ignores player:died while idle', () => {
    ctx.events.emit('player:died', { playerId: 'p1' });
    expect(rounds.state.phase).toBe('idle');
    expect(ev.count('game:over')).toBe(0);
  });

  it('start() after game over begins a fresh run', () => {
    toWave();
    ctx.events.emit('player:died', { playerId: 'p1' });
    rounds.start();
    expect(rounds.state).toMatchObject({ round: 1, phase: 'intermission', totalKills: 0 });
  });
});
