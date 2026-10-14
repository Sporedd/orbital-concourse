/**
 * Floodlight haze (docs/ART_DIRECTION.md §5.1): additive open-cone light shafts with drifting
 * dust motes inside them, and additive floor light pools. Cheap: one cone + one Points per
 * tower, everything animated in shaders.
 */
import * as THREE from 'three';

const shaftVert = /* glsl */ `
uniform float uH;
varying float vV;
varying vec3 vN;
varying vec3 vViewPos;
void main() {
  vV = clamp( -position.y / uH, 0.0, 1.0 );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewPos = mv.xyz;
  vN = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;

const shaftFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uGain;
varying float vV;
varying vec3 vN;
varying vec3 vViewPos;
void main() {
  vec3 V = normalize( -vViewPos + vec3( 0.0, 0.0, 1e-4 ) );
  vec3 Nn = vN + vec3( 0.0, 1e-4, 0.0 );
  float facing = pow( clamp( abs( dot( normalize( Nn ), V ) ), 0.0, 1.0 ), 1.5 );
  float a = uI * pow( 1.0 - vV, 1.5 ) * facing * ( 1.0 - smoothstep( 0.85, 1.0, vV ) ) * smoothstep( 0.5, 3.0, -vViewPos.z );
  // uGain: the spec's uI is a per-surface alpha; a thin open cone only covers the background
  // with two such surfaces, so a global gain turns it into a visible volume. Hot at the lamp head.
  a *= uGain * ( 1.0 + 1.5 * ( 1.0 - smoothstep( 0.0, 0.12, vV ) ) );
  // NaN/negative guard: one bad fragment here spreads through the bloom mips as a black block
  a = ( a >= 0.0 && a < 100.0 ) ? a : 0.0;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

const moteVert = /* glsl */ `
attribute vec4 aSeed; // v, angle, radial, speed
uniform float uTime;
uniform float uH;
uniform float uR;
uniform float uPR;
varying float vA;
void main() {
  float v = fract( aSeed.x + uTime * aSeed.w / uH );
  float rad = uR * v * aSeed.z;
  float ang = aSeed.y + uTime * 0.03;
  vec3 p = vec3( cos( ang ) * rad, -v * uH, sin( ang ) * rad );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = ( 2.0 + fract( aSeed.y * 13.7 ) ) * uPR;
  vA = smoothstep( 0.05, 0.25, v ) * ( 1.0 - smoothstep( 0.8, 0.98, v ) ) * smoothstep( 1.0, 4.0, -mv.z );
}
`;

const moteFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
varying float vA;
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.2, 0.5, d ) ) * vA;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( uColor * uI * a, 1.0 );
}
`;

const poolVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const poolFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
varying vec2 vUv;
void main() {
  float r = length( vUv - 0.5 ) * 2.0;
  float a = pow( 1.0 - smoothstep( 0.0, 1.0, r ), 1.6 );
  gl_FragColor = vec4( uColor * uI * a, 1.0 );
}
`;

export interface Shaft {
  readonly group: THREE.Group;
  setColor(c: THREE.ColorRepresentation): void;
  setIntensity(i: number): void;
  /** Re-aim at a floor point (lamp stays put). */
  aim(target: THREE.Vector3): void;
  setPixelRatio(pr: number): void;
  update(time: number): void;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Shared by every shaft (tuned in style.ts SHAFT_GAIN; quality presets may lower it). */
export const shaftShared = {
  uGain: { value: 2.6 },
  /** Dust motes per shaft that are drawn (0..30). */
  motes: 30,
};

/** Cone from `lamp` to `target` with radius `floorRadius` at the far end (apex at the lamp). */
export function createShaft(lamp: THREE.Vector3, target: THREE.Vector3, floorRadius: number, color: THREE.ColorRepresentation, intensity: number, rand: () => number): Shaft {
  const group = new THREE.Group();
  group.name = 'shaft';
  group.position.copy(lamp);
  let h = lamp.distanceTo(target);
  const geo = new THREE.ConeGeometry(floorRadius, 1, 24, 1, true);
  geo.translate(0, -0.5, 0); // apex at y=0, base at y=-1
  const uniforms = {
    uH: { value: h },
    uColor: { value: new THREE.Color(color) },
    uI: { value: intensity },
    uGain: shaftShared.uGain,
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: shaftVert,
    fragmentShader: shaftFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  mat.userData.noInk = true;
  const cone = new THREE.Mesh(geo, mat);
  cone.scale.set(1, h, 1);
  cone.renderOrder = 8;
  cone.frustumCulled = false;
  // the shader's uH is in local units of the scaled geometry: position.y ∈ [-1, 0] → use uH = 1
  uniforms.uH.value = 1;
  group.add(cone);

  // dust motes
  const N = 30;
  // (drawRange below honours shaftShared.motes for the low preset)
  const seeds = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    seeds[i * 4] = rand();
    seeds[i * 4 + 1] = rand() * Math.PI * 2;
    seeds[i * 4 + 2] = Math.sqrt(rand()) * 0.85;
    seeds[i * 4 + 3] = 0.06 + rand() * 0.08;
  }
  const mgeo = new THREE.BufferGeometry();
  mgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  mgeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const muni = {
    uTime: { value: 0 },
    uH: { value: h },
    uR: { value: floorRadius },
    uPR: { value: 1 },
    uColor: uniforms.uColor,
    uI: { value: 0.6 },
  };
  const mmat = new THREE.ShaderMaterial({
    uniforms: muni,
    vertexShader: moteVert,
    fragmentShader: moteFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  mgeo.setDrawRange(0, Math.max(0, Math.min(N, shaftShared.motes)));
  const motes = new THREE.Points(mgeo, mmat);
  motes.frustumCulled = false;
  motes.renderOrder = 9;
  // motes live in an un-scaled child pointing the same way
  const moteFrame = new THREE.Group();
  moteFrame.add(motes);
  group.add(moteFrame);

  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const aim = (t: THREE.Vector3) => {
    dir.subVectors(t, group.position);
    h = Math.max(1, dir.length());
    dir.normalize();
    q.setFromUnitVectors(UP.clone().negate(), dir);
    group.quaternion.copy(q);
    cone.scale.set(1, h, 1);
    muni.uH.value = h;
  };
  aim(target);

  return {
    group,
    setColor(c) {
      uniforms.uColor.value.set(c);
    },
    setIntensity(i) {
      uniforms.uI.value = i;
      muni.uI.value = 0.6 * Math.min(1, i / 0.12);
    },
    aim,
    setPixelRatio(pr) {
      muni.uPR.value = pr;
    },
    update(time) {
      muni.uTime.value = time % 3600;
    },
  };
}

export interface LightPool {
  readonly mesh: THREE.Mesh;
  setColor(c: THREE.ColorRepresentation): void;
  setIntensity(i: number): void;
  setPosition(x: number, z: number): void;
}

const poolGeo = new THREE.PlaneGeometry(1, 1);
poolGeo.rotateX(-Math.PI / 2);

/** Additive radial floor decal (lum ≈ uI). */
export function createPool(x: number, z: number, radius: number, color: THREE.ColorRepresentation, intensity = 0.15): LightPool {
  const uniforms = { uColor: { value: new THREE.Color(color) }, uI: { value: intensity } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: poolVert,
    fragmentShader: poolFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: false,
  });
  const mesh = new THREE.Mesh(poolGeo, mat);
  mesh.position.set(x, 0.01, z);
  mesh.scale.set(radius * 2, 1, radius * 2);
  mesh.renderOrder = 4;
  return {
    mesh,
    setColor(c) { uniforms.uColor.value.set(c); },
    setIntensity(i) { uniforms.uI.value = i; },
    setPosition(px, pz) { mesh.position.set(px, 0.01, pz); },
  };
}
