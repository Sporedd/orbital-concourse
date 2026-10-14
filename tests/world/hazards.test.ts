import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYER } from '@/core/config';
import type { RoundState } from '@/core/types';
import { leagueById } from '@/standing/ranks';
import { createWorld } from '@/world';
import { HAZARD, hazardForLeague } from '@/world/hazards';
import { callsOf, createFakeContext, createFakePlayer, fakeHud } from '../helpers/fakeContext';

const DT = 1 / 30;

function setup(league: string, at: THREE.Vector3, phase: RoundState['phase'] = 'wave') {
  const ctx = createFakeContext({ seed: 7, world: 'none' });
  const world = createWorld(ctx);
  ctx.world = world;
  const player = createFakePlayer('p1', at.clone());
  ctx.player = player;
  ctx.hud = fakeHud('none');
  const state = { round: 1, phase, phaseTime: 0, killsRequired: 10, kills: 0, subWave: 1, totalKills: 0 } as RoundState;
  ctx.rounds = { state, start() {}, update() {} };
  world.setLeague(league);
  /** Advance `seconds`, pinning the player in place (hazards may push it). */
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      player.position.copy(at);
      world.update(DT);
    }
  };
  return { ctx, world, player, state, run };
}

describe('world hazards', () => {
  it('follow the league dressing in ranks.ts (none in Scrap)', () => {
    for (const id of ['scrap', 'iron', 'steel', 'star', 'void'] as const) {
      expect(hazardForLeague(id)).toBe(leagueById(id).dressing.hazard);
    }
    expect(hazardForLeague('scrap')).toBeNull();
    const { world } = setup('steel', new THREE.Vector3());
    expect(world.hazards.kind).toBe('laser_grids');
    world.setLeague('scrap');
    expect(world.hazards.kind).toBeNull();
  });

  it('Scrap: nothing touches the player', () => {
    const { player, run } = setup('scrap', new THREE.Vector3(0, 0, 0));
    run(60);
    expect(callsOf(player, 'takeDamage')).toHaveLength(0);
    expect(player.velocity.length()).toBe(0);
  });

  it('Steel laser grid: ≤ 8 shock per hit, at most one hit per 0.5 s, never lethal from full', () => {
    const { player, world } = setup('steel', new THREE.Vector3(0, 0, 0));
    const hits: { t: number; amount: number; element?: string }[] = [];
    let t = 0;
    const orig = player.takeDamage.bind(player);
    player.takeDamage = (amount, opts) => {
      hits.push({ t, amount, element: opts?.element });
      orig(amount, opts);
    };
    for (; t < 120; t += DT) {
      player.position.set(0, 0, 0);
      player.velocity.set(0, 0, 0);
      world.update(DT);
    }
    expect(hits.length).toBeGreaterThan(0); // the beam crosses the centre on every sweep
    for (const h of hits) {
      expect(h.amount).toBeLessThanOrEqual(HAZARD.laserDamage);
      expect(h.amount).toBeLessThan(PLAYER.maxHealth);
      expect(h.element).toBe('shock');
    }
    for (let i = 1; i < hits.length; i++) expect(hits[i].t - hits[i - 1].t).toBeGreaterThanOrEqual(HAZARD.tick - 1e-6);
    expect(player.alive).toBe(true);
  });

  it('a player standing on cover (above the beam) is safe from the laser', () => {
    const { player, run } = setup('steel', new THREE.Vector3(0, 0.6, 0)); // plinth top
    run(120);
    expect(callsOf(player, 'takeDamage')).toHaveLength(0);
  });

  it('Void shrinking ring damages outside the ring only, every 0.5 s', () => {
    const outside = setup('void', new THREE.Vector3(0, 0, 25));
    outside.run(40);
    const dmg = callsOf(outside.player, 'takeDamage');
    expect(dmg.length).toBeGreaterThan(5);
    for (const c of dmg) expect(c.args[0]).toBeLessThanOrEqual(HAZARD.ringDamage);
    const inside = setup('void', new THREE.Vector3(0, 0, 3));
    inside.run(40);
    expect(callsOf(inside.player, 'takeDamage')).toHaveLength(0);
  });

  it('Iron vents shove a player in the lane toward the centre (no damage)', () => {
    const a = THREE.MathUtils.degToRad(112.5);
    const at = new THREE.Vector3(Math.cos(a) * 26, 0, Math.sin(a) * 26);
    const { player, world } = setup('iron', at);
    world.update(DT); // hazard starts with the round
    world.hazards.trigger(1);
    let maxInward = 0;
    for (let t = 0; t < 4; t += DT) {
      player.position.copy(at);
      world.update(DT);
      maxInward = Math.max(maxInward, -(player.velocity.x * Math.cos(a) + player.velocity.z * Math.sin(a)));
    }
    expect(maxInward).toBeGreaterThan(2);
    expect(maxInward).toBeLessThanOrEqual(HAZARD.ventMaxSpeed + 1e-6);
    expect(callsOf(player, 'takeDamage')).toHaveLength(0);
  });

  it('hazards sleep outside rounds and while a screen is open', () => {
    const idle = setup('void', new THREE.Vector3(0, 0, 25), 'intermission');
    idle.run(60);
    expect(idle.world.hazards.active).toBe(false);
    expect(callsOf(idle.player, 'takeDamage')).toHaveLength(0);
    const paused = setup('void', new THREE.Vector3(0, 0, 25));
    paused.ctx.hud = fakeHud('pause');
    paused.run(60);
    expect(callsOf(paused.player, 'takeDamage')).toHaveLength(0);
  });
});
