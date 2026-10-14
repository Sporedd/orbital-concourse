/**
 * Toon + glow material factory (Brutalist Arena, docs/ART_DIRECTION.md §2).
 *
 * toon(): MeshToonMaterial with a shared 2-band ramp (soft terminator, LinearFilter) and a
 * surface injection (onBeforeCompile) driven by one per-material `uSurf` vec4:
 *   x mottle  — two-octave world-space value noise on albedo (replaces hatching)
 *   y grime   — contact darkening toward the floor (y < 1.2 m)
 *   z sheen   — broad dull key-light highlight (steel, polished floor)
 *   w rim     — character back-rim in FLOODLIGHT (stays below lum 1, never blooms)
 * plus `uSurf2.x` = floor slab seams. Every surfaced material shares one program
 * (constant customProgramCacheKey); only the uniforms differ. No screen-space patterns.
 *
 * glow(): unlit MeshBasicMaterial with colour * intensity (>1 → blooms), toneMapped off.
 * Use glowLum() from style.ts to pick an intensity from a luminance target.
 */
import * as THREE from 'three';
import type { MaterialFactory, ToonOptions } from '@/core/types';
import { PALETTE } from './style';

export type SurfaceKind = 'concrete' | 'steel' | 'paint' | 'character' | 'flat';

/** Extra options for world builders (non-contract). */
export interface SurfaceOptions extends ToonOptions {
  surface?: SurfaceKind;
  mottle?: number;
  grime?: number;
  sheen?: number;
  rim?: number;
  /** Floor slab seams (0/1). */
  seams?: number;
  /** Face normals (architecture). Default: true for concrete/steel/paint, false otherwise. */
  flat?: boolean;
}

const KIND: Record<SurfaceKind, [number, number, number, number]> = {
  concrete: [0.06, 0.25, 0, 0],
  steel: [0.03, 0.15, 0.12, 0],
  paint: [0.08, 0, 0, 0],
  character: [0.02, 0, 0.08, 0.35],
  flat: [0, 0, 0, 0],
};

/** Shared uniforms for every surfaced toon material (values set by setupRendering). */
export const surfaceUniforms = {
  /** Direct-light luminance of a fully key-lit, albedo-1 surface (keyIntensity/π · lum(keyColor)). */
  uKeyRef: { value: 1.0 },
  uRimColor: { value: new THREE.Color(PALETTE.FLOODLIGHT) },
  /**
   * Low ground haze folded into every surfaced material (rgb = HAZE_LIT linear, a = strength):
   * thickest at the floor, gone by ~3 m, growing with distance. It does what the ground-haze
   * quads cannot do softly: distant feet, floor and plinth sink into dust without the hard
   * line a flat transparent quad draws across every leg it intersects.
   */
  uGroundHaze: { value: new THREE.Vector4(0.4, 0.41, 0.42, 0.24) },
};

/** @deprecated kept so old imports compile; hatching is gone. */
export const hatchUniforms = {
  uHatchRef: surfaceUniforms.uKeyRef,
  uHatchScale: { value: 1 },
  uHatchStrength: { value: 0 },
};

let sharedGradient: THREE.DataTexture | null = null;

/** 64-texel ramp: 0.16 below u=0.47, smoothstep to 1.0 by u=0.55. Two bands, no mid band. */
export function getToonGradient(): THREE.DataTexture {
  if (sharedGradient) return sharedGradient;
  const n = 64;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const t = THREE.MathUtils.smoothstep(u, 0.47, 0.55);
    const v = Math.round(41 + (255 - 41) * t);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  sharedGradient = tex;
  return tex;
}

const VERT_PARS = /* glsl */ `
varying vec3 vSbWorld;
`;
const VERT_MAIN = /* glsl */ `
#include <worldpos_vertex>
{
  vec4 sbW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    sbW = instanceMatrix * sbW;
  #endif
  vSbWorld = ( modelMatrix * sbW ).xyz;
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vSbWorld;
uniform vec4 uSurf;
uniform vec4 uSurf2;
uniform float uKeyRef;
uniform vec3 uRimColor;
uniform vec4 uGroundHaze;
float sbHash( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
float sbNoise( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  vec3 u = f * f * ( 3.0 - 2.0 * f );
  float a = mix( mix( sbHash( i ), sbHash( i + vec3( 1, 0, 0 ) ), u.x ), mix( sbHash( i + vec3( 0, 1, 0 ) ), sbHash( i + vec3( 1, 1, 0 ) ), u.x ), u.y );
  float b = mix( mix( sbHash( i + vec3( 0, 0, 1 ) ), sbHash( i + vec3( 1, 0, 1 ) ), u.x ), mix( sbHash( i + vec3( 0, 1, 1 ) ), sbHash( i + vec3( 1, 1, 1 ) ), u.x ), u.y );
  return mix( a, b, u.z );
}
`;

const FRAG_ALBEDO = /* glsl */ `
#include <color_fragment>
{
  float sbN = ( sbNoise( vSbWorld * 1.6 ) - 0.5 ) + ( sbNoise( vSbWorld * 0.25 + 7.3 ) - 0.5 );
  diffuseColor.rgb *= 1.0 + sbN * uSurf.x * 2.0;
  diffuseColor.rgb *= mix( 1.0 - uSurf.y, 1.0, smoothstep( 0.0, 1.2, vSbWorld.y ) );
  if ( uSurf2.x > 0.5 ) {
    // 4 m slab seams, 2 cm wide (anti-aliased), plus two darker expansion joints through the centre
    vec2 g = abs( fract( vSbWorld.xz / 4.0 + 0.5 ) - 0.5 ) * 4.0;
    vec2 fw = max( fwidth( vSbWorld.xz ), vec2( 1e-4 ) );
    vec2 ln = 1.0 - smoothstep( vec2( 0.01 ), vec2( 0.01 ) + fw * 1.2, g );
    float seam = max( ln.x, ln.y );
    vec2 j = abs( vSbWorld.xz );
    vec2 jl = 1.0 - smoothstep( vec2( 0.05 ), vec2( 0.05 ) + fw * 1.2, j );
    diffuseColor.rgb *= ( 1.0 - 0.2 * seam ) * ( 1.0 - 0.45 * max( jl.x, jl.y ) );
  }
}
`;

const FRAG_OUT = /* glsl */ `
{
  const vec3 SBW = vec3( 0.2126, 0.7152, 0.0722 );
  float sbLit = clamp( dot( reflectedLight.directDiffuse, SBW ) / ( max( dot( diffuseColor.rgb, SBW ), 0.03 ) * max( uKeyRef, 1e-4 ) ), 0.0, 1.0 );
  #if NUM_DIR_LIGHTS > 0
  if ( uSurf.z > 0.0 ) {
    vec3 sbH = normalize( directionalLights[ 0 ].direction + geometryViewDir + vec3( 0.0, 1e-4, 0.0 ) );
    outgoingLight += directionalLights[ 0 ].color * uSurf.z * pow( max( dot( normal, sbH ), 0.0 ), 12.0 ) * sbLit * 0.35;
  }
  #endif
  if ( uSurf.w > 0.0 ) {
    float sbF = 1.0 - clamp( dot( normal, geometryViewDir ), 0.0, 1.0 );
    outgoingLight += uRimColor * uSurf.w * smoothstep( 0.62, 0.92, sbF );
  }
  {
    float hzD = length( vSbWorld - cameraPosition );
    float hz = uGroundHaze.a * exp( -max( vSbWorld.y, 0.0 ) * 0.85 ) * ( 1.0 - exp( -hzD * 0.045 ) );
    outgoingLight = mix( outgoingLight, uGroundHaze.rgb, hz );
  }
}
#include <opaque_fragment>
`;

const CACHE_KEY = 'concourse-c-surface-v1';
const cacheKey = () => CACHE_KEY;

export interface SurfacedMaterial extends THREE.MeshToonMaterial {
  userData: { uSurf: { value: THREE.Vector4 }; uSurf2: { value: THREE.Vector4 }; [k: string]: unknown };
}

export function makeSurface(opts: SurfaceOptions): THREE.MeshToonMaterial {
  const kind: SurfaceKind = opts.surface ?? 'concrete';
  const d = KIND[kind] ?? KIND.concrete;
  const flat = opts.flat ?? (kind === 'concrete' || kind === 'steel' || kind === 'paint');
  const m = new THREE.MeshToonMaterial({
    color: opts.color,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    gradientMap: getToonGradient(),
  });
  // MeshToonMaterial has no typed flatShading, but WebGLPrograms honours the property (FLAT_SHADED)
  (m as unknown as { flatShading: boolean }).flatShading = flat;
  const uSurf = { value: new THREE.Vector4(opts.mottle ?? d[0], opts.grime ?? d[1], opts.sheen ?? d[2], opts.rim ?? d[3]) };
  const uSurf2 = { value: new THREE.Vector4(opts.seams ?? 0, 0, 0, 0) };
  m.userData.uSurf = uSurf;
  m.userData.uSurf2 = uSurf2;
  m.userData.surface = kind;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSurf = uSurf;
    shader.uniforms.uSurf2 = uSurf2;
    shader.uniforms.uKeyRef = surfaceUniforms.uKeyRef;
    shader.uniforms.uRimColor = surfaceUniforms.uRimColor;
    shader.uniforms.uGroundHaze = surfaceUniforms.uGroundHaze;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <worldpos_vertex>', VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_ALBEDO)
      .replace('#include <opaque_fragment>', FRAG_OUT);
  };
  m.customProgramCacheKey = cacheKey;
  return m;
}

/** Contract toon(): default surface 'concrete'. `hatch` is accepted and ignored. */
export function makeToon(opts: ToonOptions): THREE.MeshToonMaterial {
  return makeSurface(opts as SurfaceOptions);
}

export function makeGlow(color: THREE.ColorRepresentation, intensity = 2.2): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  m.color.multiplyScalar(intensity);
  m.toneMapped = false;
  m.userData.noInk = true;
  m.userData.glowIntensity = intensity;
  return m;
}

export function createMaterialFactoryImpl(): MaterialFactory {
  return {
    toon: makeToon,
    glow: makeGlow,
  };
}
