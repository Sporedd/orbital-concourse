/**
 * Billboard glows (grimdark revision, docs/ART_DIRECTION.md §15): one instanced, additive,
 * camera-facing quad batch for every small light source in the arena that is not a real light:
 * brazier and barrel flames, the soft halos that light the smoke around fires and lamps, and the
 * red warning lamps. One draw call; colours, intensities and flicker modes are per instance
 * attributes, the flicker itself runs in the shader.
 *
 * Kinds: 0 flame (noise tongue, rises), 1 halo (soft radial glow in the smoke), 2 dot (hard lamp
 * core). Flicker modes: 0 steady, 1 fire, 2 slow pulse, 3 failing lamp (random drop-outs).
 */
import * as THREE from 'three';

const vert = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aParm;   // width, height, kind, seed
attribute vec4 aColor;  // linear rgb * intensity, flicker mode
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying float vKind;
varying float vSeed;
float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
void main() {
  vUv = uv;
  vKind = aParm.z;
  vSeed = aParm.w;
  float t = uTime;
  float mode = aColor.w;
  float k = 1.0;
  if ( mode > 0.5 && mode < 1.5 ) {
    // fire: two incommensurate wobbles plus a fast crackle
    k = 0.82 + 0.12 * sin( t * 9.1 + vSeed * 40.0 ) + 0.08 * sin( t * 23.7 + vSeed * 13.0 ) + 0.06 * ( h11( floor( t * 14.0 ) + vSeed * 91.0 ) - 0.5 );
  } else if ( mode > 1.5 && mode < 2.5 ) {
    k = 0.7 + 0.3 * sin( t * 2.2 + vSeed * 6.28 );
  } else if ( mode > 2.5 ) {
    // failing lamp: mostly on, short random drop-outs
    float slot = floor( t * 7.0 + vSeed * 50.0 );
    k = h11( slot + vSeed * 17.0 ) < 0.12 ? 0.08 : 1.0;
  }
  vCol = aColor.rgb * k;
  // billboard: flames/halos face the camera around world Y (flames stay upright)
  vec2 d = normalize( cameraPosition.xz - aPos.xz + vec2( 1e-4 ) );
  vec3 right = vec3( d.y, 0.0, -d.x );
  vec3 up = vec3( 0.0, 1.0, 0.0 );
  if ( vKind > 0.5 ) {
    // halos and dots: full spherical billboard
    vec3 f = normalize( cameraPosition - aPos );
    right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), f ) );
    up = cross( f, right );
  }
  float sway = vKind < 0.5 ? 0.06 * sin( t * 3.3 + vSeed * 9.0 ) * position.y : 0.0;
  vec3 p = aPos + right * ( position.x + sway ) * aParm.x + up * position.y * aParm.y;
  vec4 mv = viewMatrix * vec4( p, 1.0 );
  // soft fade right at the camera (no full-screen additive blobs)
  vCol *= smoothstep( 0.4, 2.0, -mv.z );
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying float vKind;
varying float vSeed;
float h21( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float vn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), u.x ), mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), u.x ), u.y ); }
void main() {
  vec2 c = vUv - vec2( 0.5 );
  float a;
  if ( vKind < 0.5 ) {
    // flame: turbulent rising noise, displaced sideways more toward the top, breaking up into
    // tongues; hot yellow core low in the middle, dark red at the tips
    float y = vUv.y;
    float x = c.x;
    vec2 q = vec2( x * 3.2 + vSeed * 5.0, y * 2.2 - uTime * 2.6 + vSeed * 11.0 );
    float n = vn( q * 2.0 ) * 0.6 + vn( q * 4.7 + 7.3 ) * 0.4;
    float xd = x + ( n - 0.5 ) * 0.6 * y + sin( y * 7.0 - uTime * 6.0 + vSeed * 20.0 ) * 0.04 * y;
    float w = max( 0.24 * pow( 1.0 - y, 1.1 ) * ( 0.6 + 0.6 * n ), 1e-3 );
    float body = 1.0 - smoothstep( w * 0.35, w, abs( xd ) );
    body *= smoothstep( 0.0, 0.3, n * 1.45 - y * 1.15 + 0.2 );
    body *= smoothstep( 0.0, 0.12, y ) * ( 1.0 - smoothstep( 0.3, 0.48, abs( x ) ) );
    float heat = clamp( body * ( 1.15 - y * 1.1 ), 0.0, 1.0 );
    float I = max( vCol.r, max( vCol.g, vCol.b ) );
    vec3 col = I * ( mix( vec3( 0.5, 0.05, 0.008 ), vec3( 1.0, 0.32, 0.05 ), smoothstep( 0.0, 0.55, heat ) )
      + vec3( 0.9, 0.75, 0.45 ) * smoothstep( 0.45, 1.0, heat ) );
    a = body;
    if ( a < 0.01 ) discard;
    gl_FragColor = vec4( col * a, 1.0 );
    return;
  } else if ( vKind < 1.5 ) {
    float r = length( c ) * 2.0;
    a = pow( max( 0.0, 1.0 - r ), 2.2 );
  } else {
    float r = length( c ) * 2.0;
    a = 1.0 - smoothstep( 0.55, 1.0, r );
  }
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( vCol * a, 1.0 );
}
`;

export const GlowKind = { Flame: 0, Halo: 1, Dot: 2 } as const;
export type GlowKind = (typeof GlowKind)[keyof typeof GlowKind];
export const Flicker = { Steady: 0, Fire: 1, Pulse: 2, Failing: 3 } as const;
export type Flicker = (typeof Flicker)[keyof typeof Flicker];

export interface GlowSpec {
  pos: THREE.Vector3;
  width: number;
  height?: number;
  kind: GlowKind;
  /** sRGB colour; the intensity multiplies it (linear). */
  color: THREE.ColorRepresentation;
  intensity: number;
  flicker?: Flicker;
}

export interface Glows {
  readonly mesh: THREE.Mesh;
  /** Adds a glow; returns its index (stable). */
  add(spec: GlowSpec): number;
  /** Recolour / dim (intensity 0 hides it). */
  set(index: number, color: THREE.ColorRepresentation | null, intensity: number, flicker?: Flicker): void;
  update(dt: number): void;
}

export function createGlows(capacity = 192, rand: () => number = Math.random): Glows {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  const pos = new Float32Array(capacity * 3);
  const parm = new Float32Array(capacity * 4);
  const col = new Float32Array(capacity * 4);
  const aPos = new THREE.InstancedBufferAttribute(pos, 3);
  const aParm = new THREE.InstancedBufferAttribute(parm, 4);
  const aColor = new THREE.InstancedBufferAttribute(col, 4);
  aColor.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aParm', aParm);
  geo.setAttribute('aColor', aColor);
  geo.instanceCount = 0;
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  mat.userData.noInk = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'world-glows';
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;

  const base: { color: THREE.Color; flicker: number }[] = [];
  const tmp = new THREE.Color();
  let n = 0;
  let time = 0;
  const write = (i: number, color: THREE.Color, intensity: number, flicker: number) => {
    col[i * 4] = color.r * intensity;
    col[i * 4 + 1] = color.g * intensity;
    col[i * 4 + 2] = color.b * intensity;
    col[i * 4 + 3] = flicker;
    aColor.needsUpdate = true;
  };

  return {
    mesh,
    add(s) {
      if (n >= capacity) return -1;
      const i = n++;
      pos[i * 3] = s.pos.x;
      pos[i * 3 + 1] = s.pos.y;
      pos[i * 3 + 2] = s.pos.z;
      const halfUp = s.kind === GlowKind.Flame ? 0.5 : 0; // flames grow up from their base
      pos[i * 3 + 1] += (s.height ?? s.width) * halfUp;
      parm[i * 4] = s.width;
      parm[i * 4 + 1] = s.height ?? s.width;
      parm[i * 4 + 2] = s.kind;
      parm[i * 4 + 3] = rand();
      const c = new THREE.Color(s.color);
      base.push({ color: c, flicker: s.flicker ?? Flicker.Steady });
      write(i, c, s.intensity, s.flicker ?? Flicker.Steady);
      aPos.needsUpdate = true;
      aParm.needsUpdate = true;
      geo.instanceCount = n;
      return i;
    },
    set(i, color, intensity, flicker) {
      if (i < 0 || i >= n) return;
      const b = base[i];
      if (color !== null) b.color.set(color);
      if (flicker !== undefined) b.flicker = flicker;
      write(i, tmp.copy(b.color), intensity, b.flicker);
    },
    update(dt) {
      time += dt;
      uniforms.uTime.value = time % 1000;
    },
  };
}
