/**
 * Mobile performance preset (src/rendering/style.ts 'mobile', requested by src/mobile/quality.ts):
 * cheaper than 'low' everywhere, selected only when asked for, ?quality= still wins, and the
 * chain thinning keeps whole chains.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('mobile quality preset', () => {
  it('is cheaper than low: resolution 0.6–0.75, fewer fire lights, cheap bloom, smaller crowd/chains/particles', async () => {
    const { QUALITY_PRESETS } = await import('@/rendering/style');
    const m = QUALITY_PRESETS.mobile;
    const low = QUALITY_PRESETS.low;
    expect(m.renderScale).toBeGreaterThanOrEqual(0.6);
    expect(m.renderScale).toBeLessThanOrEqual(0.75);
    expect(m.fireLights).toBeLessThan(low.fireLights);
    expect(m.bloomScale).toBeLessThan(low.bloomScale);
    expect(m.maxSpots).toBeLessThanOrEqual(low.maxSpots);
    expect(m.shaftMotes).toBeLessThan(low.shaftMotes);
    expect(m.crowdScale).toBeLessThan(1);
    expect(m.chainScale).toBeLessThan(1);
    expect(m.particleScale).toBeLessThan(1);
    expect(m.cheapHaze).toBe(true);
    // desktop presets carry none of the mobile-only knobs
    for (const q of [QUALITY_PRESETS.high, low]) {
      expect(q.renderScale ?? q.crowdScale ?? q.chainScale ?? q.particleScale ?? q.cheapHaze).toBeUndefined();
    }
  });

  it('desktop keeps its preset: nothing selects mobile unless the mobile layer asks', async () => {
    const { STYLE, LEAGUE_STYLE } = await import('@/rendering/style');
    expect(STYLE.quality).toBe('high');
    expect(LEAGUE_STYLE.void.crowd).toBe(10000);
  });

  it('requestMobileQuality selects it (crowd scaled, spots capped), not persisted', async () => {
    const { STYLE, LEAGUE_STYLE } = await import('@/rendering/style');
    const { requestMobileQuality } = await import('@/mobile/quality');
    expect(requestMobileQuality('')).toBe('mobile');
    expect(STYLE.quality).toBe('mobile');
    expect(LEAGUE_STYLE.void.crowd).toBeLessThan(10000);
    expect(LEAGUE_STYLE.void.spots).toBeLessThanOrEqual(STYLE.q.maxSpots);
    expect(localStorage.getItem('concourse.quality')).toBeNull();
    // idempotent
    const crowd = LEAGUE_STYLE.void.crowd;
    requestMobileQuality('');
    expect(LEAGUE_STYLE.void.crowd).toBe(crowd);
  });

  it('?quality=high / low still override on a phone', async () => {
    const { STYLE } = await import('@/rendering/style');
    const { requestMobileQuality } = await import('@/mobile/quality');
    expect(requestMobileQuality('?quality=high')).toBe('high');
    expect(STYLE.quality).toBe('high');
  });

  it('thinChains keeps whole chains spread round the ring', async () => {
    const { thinChains } = await import('@/mobile/quality');
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 100);
    const m = new THREE.Matrix4();
    // 10 chains of 10 links, 0.2 m apart, chains 5 m apart
    for (let c = 0; c < 10; c++) for (let l = 0; l < 10; l++) mesh.setMatrixAt(c * 10 + l, m.makeTranslation(c * 5, -l * 0.2, 0));
    expect(thinChains(mesh, 0.5)).toBe(50);
    expect(mesh.count).toBe(50);
    const p = new THREE.Vector3();
    const xs = new Set<number>();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      xs.add(p.setFromMatrixPosition(m).x);
    }
    expect(xs.size).toBe(5); // five complete chains, not half of each
    expect([...xs].sort((a, b) => a - b)).toEqual([5, 15, 25, 35, 45]);
  });
});
