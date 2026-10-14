/**
 * Cheap, always-on haze layers (docs/ART_DIRECTION.md §5.1, replaces snow):
 *  - two ground-haze quads over the play floor (fbm alpha scrolling at 0.02 m/s),
 *  - the stand haze band: inward-facing open cylinders from r = 32.5 m outward that separate the
 *    stands from the pit (alpha 0.18 in total at the bottom → 0 at the top). Three stacked layers
 *    at the tier radii make the haze grow with depth (front tier behind one layer, top tier
 *    behind all three), so the stands keep their value structure instead of going flat grey,
 *  - hazePuff(): explosions raise the ground-haze alpha locally for ~2 s.
 */
import * as THREE from 'three';
import { PALETTE } from './style';

const PUFFS = 4;
const puffData = Array.from({ length: PUFFS }, () => new THREE.Vector4(0, 0, 1, -100)); // x, z, radius, startTime
let puffHead = 0;
let hazeTime = 0;

/** Locally thicken the ground haze around (x,z) for ~2 s (explosions). */
export function hazePuff(x: number, z: number, radius: number): void {
  puffData[puffHead].set(x, z, Math.max(1.5, radius * 1.4), hazeTime);
  puffHead = (puffHead + 1) % PUFFS;
}

const groundVert = /* glsl */ `
varying vec3 vW;
varying float vDepth;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const groundFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uSeed;
uniform vec4 uPuff[ ${PUFFS} ];
varying vec3 vW;
varying float vDepth;
float h12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float vn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h12( i ), h12( i + vec2( 1, 0 ) ), u.x ), mix( h12( i + vec2( 0, 1 ) ), h12( i + vec2( 1, 1 ) ), u.x ), u.y ); }
float fbmG( vec2 p ) { float v = 0.0, a = 0.5; for ( int i = 0; i < 4; i++ ) { v += a * vn( p ); p = p * 2.02 + 17.3; a *= 0.5; } return v; }
void main() {
  vec2 p = vW.xz * 0.12 + vec2( uTime * 0.02 * 0.12, uTime * 0.012 * 0.12 ) + uSeed;
  float n = fbmG( p );
  float a = uAlpha * smoothstep( 0.25, 0.75, n );
  // a thin layer seen at a grazing angle is a longer path through the haze: thicker toward
  // the horizon, so distant floor (and enemy feet) sink into it like the concept frame
  float vy = abs( normalize( vW - cameraPosition ).y );
  a *= mix( 1.0, 1.3, 1.0 - smoothstep( 0.04, 0.45, vy ) );
  float r = length( vW.xz );
  a *= 1.0 - smoothstep( 26.0, 30.5, r ) * 0.4;
  float puff = 0.0;
  for ( int i = 0; i < ${PUFFS}; i++ ) {
    vec4 pf = uPuff[ i ];
    float age = uTime - pf.w;
    if ( age < 0.0 || age > 2.5 ) continue;
    float k = 1.0 - smoothstep( 0.0, 2.5, age );
    float d = length( vW.xz - pf.xy ) / ( pf.z * ( 1.0 + age * 0.4 ) );
    puff += k * ( 1.0 - smoothstep( 0.3, 1.0, d ) );
  }
  a += puff * 0.22 * ( 0.6 + 0.4 * n );
  a *= smoothstep( 0.6, 4.0, vDepth );
  gl_FragColor = vec4( uColor, clamp( a, 0.0, 0.6 ) );
}
`;

const bandVert = /* glsl */ `
varying vec3 vW;
varying float vDepth;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * One layer of the stand haze. Several layers at growing radii stack up with depth: the front
 * tier sits behind one layer, the top tier behind all of them, so haze grows with distance
 * instead of laying one flat grey sheet over the stands.
 */
const bandFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uH;
uniform float uTime;
varying vec3 vW;
varying float vDepth;
float h12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float vn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h12( i ), h12( i + vec2( 1, 0 ) ), u.x ), mix( h12( i + vec2( 0, 1 ) ), h12( i + vec2( 1, 1 ) ), u.x ), u.y ); }
void main() {
  float t = clamp( vW.y / uH, 0.0, 1.0 );
  // slow drifting density so the layer reads as haze, not a sheet
  vec2 q = vec2( atan( vW.z, vW.x ) * 9.0 + uTime * 0.015, vW.y * 0.22 - uTime * 0.01 );
  float n = 0.65 + 0.35 * ( vn( q ) * 0.65 + vn( q * 2.3 + 5.1 ) * 0.35 );
  float a = uAlpha * pow( 1.0 - t, 1.25 ) * n * smoothstep( 1.0, 6.0, vDepth );
  gl_FragColor = vec4( uColor, a );
}
`;

/** Stand haze layers: radius, height (alpha fades to 0 at the top), share of the band alpha. */
const BANDS: readonly [number, number, number][] = [
  [32.5, 14, 0.42],
  [37.6, 18, 0.36],
  [42.6, 23, 0.32],
];

export interface Haze {
  readonly group: THREE.Group;
  /** groundAlpha per ground quad; bandAlpha = total stand-haze alpha over the top tier. */
  setStrength(groundAlpha: number, bandAlpha: number): void;
  update(dt: number): void;
}

export function createHaze(): Haze {
  const group = new THREE.Group();
  group.name = 'haze';
  const color = new THREE.Color(PALETTE.HAZE_LIT);
  const groundMats: THREE.ShaderMaterial[] = [];
  const time = { value: 0 };
  const puffs = { value: puffData };
  const plane = new THREE.CircleGeometry(30.2, 48);
  plane.rotateX(-Math.PI / 2);
  for (const [y, seed] of [[0.3, 0], [0.9, 11.7]] as const) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uAlpha: { value: 0.08 }, uTime: time, uSeed: { value: seed }, uPuff: puffs },
      vertexShader: groundVert,
      fragmentShader: groundFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    mat.userData.noInk = true;
    groundMats.push(mat);
    const m = new THREE.Mesh(plane, mat);
    m.position.y = y;
    m.renderOrder = 6;
    m.frustumCulled = false;
    group.add(m);
  }

  const bandMats: THREE.ShaderMaterial[] = [];
  BANDS.forEach(([r, h], i) => {
    const geo = new THREE.CylinderGeometry(r, r, h, 72, 1, true);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uAlpha: { value: 0.18 * BANDS[i][2] }, uH: { value: h }, uTime: time },
      vertexShader: bandVert,
      fragmentShader: bandFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // inward-facing
      fog: false,
    });
    mat.userData.noInk = true;
    bandMats.push(mat);
    const band = new THREE.Mesh(geo, mat);
    band.renderOrder = 7 - i * 0.1; // far layers first
    band.frustumCulled = false;
    group.add(band);
  });

  return {
    group,
    setStrength(groundAlpha, bandAlpha) {
      for (const m of groundMats) m.uniforms.uAlpha.value = groundAlpha;
      bandMats.forEach((m, i) => { m.uniforms.uAlpha.value = bandAlpha * BANDS[i][2]; });
    },
    update(dt) {
      hazeTime += dt;
      time.value = hazeTime;
    },
  };
}
