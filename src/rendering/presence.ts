/**
 * Boss presence (docs/ART_DIRECTION.md §8 "architecture that walks"): every live boss gets
 *  - a soft dark contact shadow under its footprint (the key shadow alone reads thin on the
 *    bright concrete and vanishes inside the floodlight pools),
 *  - a THREAT ground pool (additive radial decal, lum ≈ 0.3 pulsing with the core),
 *  - one pooled THREAT PointLight in front of the chest that rakes the floor and its front plates.
 * Everything is allocated once (fixed light count: no shader recompiles); presentation only.
 */
import * as THREE from 'three';
import type { GameContext } from '@/core/types';
import { PALETTE } from './style';

const SLOTS = 2;

const decalVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
`;

/** Contact shadow: dark radial blob, normal blending. */
const shadowFrag = /* glsl */ `
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float r = length( vUv - 0.5 ) * 2.0;
  float a = uAlpha * pow( 1.0 - smoothstep( 0.15, 1.0, r ), 1.4 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( 0.043, 0.047, 0.051, a );
}
`;

/** THREAT pool: additive radial glow with a faint slab-grid modulation (reads as light on concrete). */
const poolFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
varying vec2 vUv;
void main() {
  vec2 p = ( vUv - 0.5 ) * 2.0;
  float r = length( p );
  float a = pow( 1.0 - smoothstep( 0.0, 1.0, r ), 2.0 ) * ( 0.75 + 0.25 * smoothstep( 0.35, 0.6, r ) );
  gl_FragColor = vec4( uColor * uI * a, 1.0 );
}
`;

interface Slot {
  id: string | null;
  shadow: THREE.Mesh;
  shadowMat: THREE.ShaderMaterial;
  pool: THREE.Mesh;
  poolMat: THREE.ShaderMaterial;
  fade: number;
}

export interface Presence {
  update(dt: number, time: number): void;
}

export function createPresence(ctx: GameContext): Presence {
  const group = new THREE.Group();
  group.name = 'boss-presence';
  ctx.scene.add(group);
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const threat = new THREE.Color(PALETTE.THREAT);

  const slots: Slot[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 } },
      vertexShader: decalVert,
      fragmentShader: shadowFrag,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: threat.clone() }, uI: { value: 0 } },
      vertexShader: decalVert,
      fragmentShader: poolFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
    });
    shadowMat.userData.noInk = poolMat.userData.noInk = true;
    const shadow = new THREE.Mesh(geo, shadowMat);
    const pool = new THREE.Mesh(geo, poolMat);
    shadow.renderOrder = 3;
    pool.renderOrder = 4;
    shadow.visible = pool.visible = false;
    shadow.frustumCulled = pool.frustumCulled = false;
    group.add(shadow, pool);
    slots.push({ id: null, shadow, shadowMat, pool, poolMat, fade: 0 });
  }

  // one pooled core light (always present, intensity 0 when idle → constant light count)
  const light = new THREE.PointLight(PALETTE.THREAT, 0, 9, 2);
  light.castShadow = false;
  group.add(light);
  const fwd = new THREE.Vector3();

  return {
    update(dt, time) {
      const enemies = ctx.enemies;
      const list = enemies ? enemies.list() : [];
      // claim slots for new bosses
      for (const e of list) {
        if (!e.isBoss || !e.alive) continue;
        if (slots.some((s) => s.id === e.id)) continue;
        const free = slots.find((s) => s.id === null || s.fade <= 0);
        if (free) {
          free.id = e.id;
          free.fade = 0;
        }
      }
      let lightUsed = false;
      for (const s of slots) {
        if (!s.id) continue;
        const e = enemies?.get(s.id);
        const alive = !!e && e.alive;
        s.fade = THREE.MathUtils.clamp(s.fade + (alive ? dt / 0.5 : -dt / 0.6), 0, 1);
        if (!e || (!alive && s.fade <= 0)) {
          s.id = null;
          s.shadow.visible = s.pool.visible = false;
          continue;
        }
        const p = e.position;
        const gy = ctx.world ? ctx.world.groundHeight(p.x, p.z) : 0;
        const r = Math.max(1, e.radius);
        s.shadow.visible = s.pool.visible = true;
        s.shadow.position.set(p.x, gy + 0.012, p.z);
        s.shadow.scale.set(r * 3.0, 1, r * 3.0);
        s.shadowMat.uniforms.uAlpha.value = 0.55 * s.fade;
        s.pool.position.set(p.x, gy + 0.016, p.z);
        s.pool.scale.set(r * 6.5, 1, r * 6.5);
        const pulse = 0.8 + 0.2 * Math.sin(time * 3.1 + p.x);
        // grimdark under-glow: THREAT lum ≈ 0.23 per unit: ×2.2 → ≈ 0.5 at the centre (a red
        // pool the boss stands in, still below bloom)
        s.poolMat.uniforms.uI.value = 3.0 * pulse * s.fade;
        if (!lightUsed && alive) {
          lightUsed = true;
          // grimdark under-glow: low in front of the boss (local +Z), so it lights the floor and
          // the plates from below and the silhouette reads against the dark
          e.object.getWorldDirection(fwd);
          fwd.y = 0;
          if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
          fwd.normalize();
          light.position.set(p.x + fwd.x * (r + 0.5), gy + 0.7, p.z + fwd.z * (r + 0.5));
          light.intensity = 30 * pulse * s.fade;
        }
      }
      if (!lightUsed) light.intensity = 0;
    },
  };
}
