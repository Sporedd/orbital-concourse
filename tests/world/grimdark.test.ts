import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { GRIM, LEAGUE_ORDER, LEAGUE_STYLE, LIGHT, QUALITY_PRESETS, lumLinear } from '@/rendering/style';
import { createWorld } from '@/world';
import { BARREL_H, BARREL_SITES } from '@/world/fire';
import { createFakeContext } from '../helpers/fakeContext';

// Grimdark revision (docs/ART_DIRECTION.md §15): the numbers that keep the arena dark and the
// league dressing "more light sources, not more brightness".

describe('grimdark style data', () => {
  it('world albedos are black concrete and rusted steel (linear lum ≤ 0.06)', () => {
    for (const k of ['CONCRETE', 'CONCRETE_LIT', 'CONCRETE_DARK', 'FLOOR', 'STEEL', 'STEEL_DARK'] as const) {
      expect(lumLinear(GRIM[k])).toBeLessThanOrEqual(0.06);
    }
  });

  it('every league keeps the same total floodlight budget (towers × towerGain ≤ 2)', () => {
    const budgets = LEAGUE_ORDER.map((k) => LEAGUE_STYLE[k].towers * LEAGUE_STYLE[k].towerGain);
    for (const b of budgets) {
      expect(b).toBeGreaterThan(1.2);
      expect(b).toBeLessThanOrEqual(2.0001);
    }
  });

  it('higher leagues add light sources (fires, lamps, banners never decrease)', () => {
    for (let i = 1; i < LEAGUE_ORDER.length; i++) {
      const a = LEAGUE_STYLE[LEAGUE_ORDER[i - 1]];
      const b = LEAGUE_STYLE[LEAGUE_ORDER[i]];
      expect(b.fires).toBeGreaterThanOrEqual(a.fires);
      expect(b.redLamps).toBeGreaterThanOrEqual(a.redLamps);
      expect(b.wallLamps).toBeGreaterThanOrEqual(a.wallLamps);
      expect(b.banners).toBeGreaterThanOrEqual(a.banners);
      expect(b.towers).toBeGreaterThanOrEqual(a.towers);
    }
  });

  it('the fire light pool respects the quality cap', () => {
    expect(QUALITY_PRESETS.low.fireLights).toBeLessThan(QUALITY_PRESETS.high.fireLights);
    expect(QUALITY_PRESETS.high.fireLights).toBeLessThanOrEqual(8);
  });

  it('the grade crushes blacks (toe > 0) and the key is a faint cold fill', () => {
    expect(LIGHT.toe).toBeGreaterThan(0);
    expect(LIGHT.key).toBeLessThan(2);
    const c = new THREE.Color(LIGHT.keyColor);
    expect(c.b).toBeGreaterThan(c.r); // cold
  });
});

describe('grimdark dressing in the real arena (headless)', () => {
  const ctx = createFakeContext({ seed: 7, world: 'none' });
  ctx.rng = createRng(7);
  const world = createWorld(ctx);

  it('builds and updates in every league without WebGL', () => {
    for (const k of LEAGUE_ORDER) {
      world.setLeague(k);
      expect(() => world.update(0.016)).not.toThrow();
    }
    world.setLeague('scrap');
  });

  it('burn barrels are solid and stay clear of the player start and the mob spawn points', () => {
    for (const [x, z, y0] of BARREL_SITES) {
      // floor barrels are walkable-height props; roof barrels sit on the (too tall) containers
      if (y0 === 0) expect(world.groundHeight(x, z)).toBeCloseTo(BARREL_H, 3);
      else expect(world.raycast(new THREE.Vector3(x + 0.013, y0 + 3, z + 0.017), new THREE.Vector3(0, -1, 0), 5)?.point.y ?? 0).toBeCloseTo(y0 + BARREL_H, 2);
      expect(Math.hypot(x - world.playerStart.x, z - world.playerStart.z)).toBeGreaterThan(5);
      for (const p of world.mobSpawnPoints) expect(Math.hypot(x - p.x, z - p.z)).toBeGreaterThan(3);
    }
  });

  it('the fire PointLights never exceed the quality cap', () => {
    let points = 0;
    ctx.scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight && o.parent?.name === 'world-fire') points++; });
    expect(points).toBeLessThanOrEqual(QUALITY_PRESETS.high.fireLights);
    expect(points).toBeGreaterThan(0);
  });
});
