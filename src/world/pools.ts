/**
 * Floodlight floor pools (docs/ART_DIRECTION.md §5 "Light pools"). One additive floor quad per
 * tower, stretched into the ellipse the spot cone makes on the floor (long axis away from
 * the tower), with a soft radial falloff: a bright core, a flat lit plateau and a soft
 * penumbra edge. The pool carries the "lit zone" read on its own, so towers without a real
 * SpotLight still light the floor. Additive and depthWrite off: props and characters
 * standing in the pool occlude it naturally.
 */
import * as THREE from 'three';

const vert = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uFogDensity;
varying vec2 vUv;
varying vec3 vWorld;
float h21( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), f.x ), mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), f.x ), f.y );
}
void main() {
  vec2 q = ( vUv - 0.5 ) * 2.0; // ellipse-normalised: r = 1 at the cone edge
  float r = length( q );
  if ( r > 1.0 ) discard;
  float plateau = 1.0 - smoothstep( 0.72, 1.0, r );
  float core = exp( -r * r * 4.0 );
  // near side (toward the tower, +y in uv) is a touch brighter: shorter throw
  float throwF = 1.0 + 0.18 * q.y;
  // faint dust/unevenness so it reads as light, not as a painted disc
  float n = 0.9 + 0.2 * vnoise( vWorld.xz * 0.7 );
  float a = ( plateau * 0.8 + core * 0.35 ) * throwF * n;
  float dist = length( cameraPosition - vWorld );
  float fogF = exp( -uFogDensity * uFogDensity * dist * dist );
  a *= uI * fogF;
  a = ( a >= 0.0 && a < 100.0 ) ? a : 0.0;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

export interface FloorPool {
  readonly mesh: THREE.Mesh;
  setColor(c: THREE.ColorRepresentation): void;
  setIntensity(i: number): void;
  setFog(density: number): void;
  /** Re-aim: the ellipse follows the floor point the lamp points at. */
  aim(target: THREE.Vector3): void;
}

const geo = new THREE.PlaneGeometry(1, 1);
geo.rotateX(-Math.PI / 2); // uv.y runs along -z → +z

/**
 * Pool for a lamp at `lamp` aimed at floor point `target`. `coneRadius` is the cone radius
 * perpendicular to its axis at the floor (the shaft radius).
 */
export function createFloorPool(lamp: THREE.Vector3, target: THREE.Vector3, coneRadius: number, color: THREE.ColorRepresentation, intensity: number): FloorPool {
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uI: { value: intensity },
    uFogDensity: { value: 0.012 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: false,
  });
  mat.userData.noInk = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'world-pool';
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;

  const aim = (t: THREE.Vector3) => {
    const dx = t.x - lamp.x;
    const dz = t.z - lamp.z;
    const hd = Math.max(1e-3, Math.hypot(dx, dz));
    const len = Math.hypot(hd, lamp.y - t.y);
    const cosI = THREE.MathUtils.clamp((lamp.y - t.y) / len, 0.25, 1); // incidence vs. the floor normal
    const minor = coneRadius;
    const major = coneRadius / cosI;
    // the ellipse centre sits a little beyond the aim point (the far half is stretched more)
    const shift = (major - minor) * 0.18;
    mesh.position.set(t.x + (dx / hd) * shift, 0.012, t.z + (dz / hd) * shift);
    // local +z (uv.y up) points away from the tower
    mesh.rotation.set(0, Math.atan2(dx, dz), 0);
    mesh.scale.set(minor * 2, 1, major * 2);
  };
  aim(target);

  return {
    mesh,
    setColor(c) { uniforms.uColor.value.set(c); },
    setIntensity(i) { uniforms.uI.value = i; },
    setFog(d) { uniforms.uFogDensity.value = d; },
    aim,
  };
}
