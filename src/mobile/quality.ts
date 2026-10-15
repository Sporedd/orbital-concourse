/**
 * Mobile performance preset. requestMobileQuality() runs before the world and the render
 * pipeline are built (main.ts awaits the mobile module first) and selects the 'mobile' preset
 * of src/rendering/style.ts unless the URL names one (?quality=high / low still win).
 * applyMobileRendering() runs right after boot, before the first frame:
 *  - renderer pixel ratio = preset renderScale (internal resolution ≈ 0.7 of CSS pixels)
 *  - plain PCF shadows instead of PCF-soft (no program has compiled yet, so no recompile)
 *  - chain links drawn × chainScale, particle bursts × particleScale, the cheap haze path
 * The preset itself also caps spots, fire lights, shadow map, shaft motes and the bloom
 * resolution (the cheap bloom path), and scales the crowd (applied here to LEAGUE_STYLE before
 * the world reads it, the way style.ts applies its spot cap).
 */
import * as THREE from 'three';
import type { GameContext } from '@/core/types';
import { LEAGUE_ORDER, LEAGUE_STYLE, STYLE, type Quality } from '@/rendering/style';

/** Pick the preset. Returns the quality now in effect. */
export function requestMobileQuality(search: string = typeof location !== 'undefined' ? location.search : ''): Quality {
  let q: string | null = null;
  try {
    q = new URLSearchParams(search).get('quality');
  } catch {
    q = null;
  }
  if (q === 'high' || q === 'low') return STYLE.quality; // explicit choice (style.ts already read it)
  if (STYLE.quality === 'mobile') return 'mobile'; // idempotent
  STYLE.quality = 'mobile'; // not persisted: the same browser on ?mobile=0 keeps its own choice
  const p = STYLE.q;
  for (const k of LEAGUE_ORDER) {
    const ls = LEAGUE_STYLE[k];
    ls.spots = Math.min(ls.spots, p.maxSpots);
    if (p.crowdScale !== undefined) ls.crowd = Math.max(200, Math.round(ls.crowd * p.crowdScale));
  }
  return 'mobile';
}

/** Post-boot render settings for the mobile preset (a no-op for high / low). */
export function applyMobileRendering(ctx: GameContext): void {
  const p = STYLE.q;
  if (STYLE.quality !== 'mobile') return;
  const r = ctx.renderer;
  r.shadowMap.type = THREE.PCFShadowMap;
  if (p.renderScale) {
    r.setPixelRatio(p.renderScale);
    // main.ts resizes the renderer and the composer (it re-reads the pixel ratio)
    window.dispatchEvent(new Event('resize'));
  }
  if (p.chainScale !== undefined) {
    const chains = ctx.scene.getObjectByName('world-chains') as THREE.InstancedMesh | undefined;
    if (chains && chains.isInstancedMesh) thinChains(chains, p.chainScale);
  }
  if (p.cheapHaze) {
    // haze.ts: [ground 0.3 m, ground 0.9 m, band 32.5 m, band 37.6 m, band 42.6 m]; drop the upper
    // ground quad and the middle band (full-screen transparent overdraw with per-pixel noise)
    const haze = ctx.scene.getObjectByName('haze');
    if (haze && haze.children.length === 5) {
      haze.children[1].visible = false;
      haze.children[3].visible = false;
    }
  }
  if (p.particleScale !== undefined && ctx.fx) {
    const scale = p.particleScale;
    const burst = ctx.fx.burst.bind(ctx.fx);
    ctx.fx.burst = (point, color, count = 14) => burst(point, color, Math.max(3, Math.round(count * scale)));
  }
}

/**
 * Keep `fraction` of the chains (whole chains, spread evenly round the arena): links of one chain
 * sit ~0.2 m apart, so a jump > 0.6 m between consecutive instances starts the next chain. The
 * kept matrices are packed to the front and the draw count is cut. Returns the links kept.
 */
export function thinChains(mesh: THREE.InstancedMesh, fraction: number): number {
  const n = mesh.count;
  if (!(fraction < 1) || n === 0) return n;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const kept: THREE.Matrix4[] = [];
  let chain = -1;
  let keep = false;
  for (let i = 0; i < n; i++) {
    mesh.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    if (i === 0 || p.distanceTo(prev) > 0.6) {
      chain++;
      keep = Math.floor((chain + 1) * fraction) > Math.floor(chain * fraction);
    }
    prev.copy(p);
    if (keep) kept.push(m.clone());
  }
  kept.forEach((k, i) => mesh.setMatrixAt(i, k));
  mesh.count = kept.length;
  mesh.instanceMatrix.needsUpdate = true;
  return kept.length;
}
