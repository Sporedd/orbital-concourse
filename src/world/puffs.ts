/**
 * Haze puffs: a pooled, shader-animated Points cloud for gate spawn puffs, the boss gate
 * entrance and vent blasts. Each particle is a soft round sprite (normal blending, HAZE_LIT,
 * low alpha) that drifts with drag, grows and fades. Emitting only rewrites the particle's
 * slot in a ring buffer; everything else runs on the GPU.
 */
import * as THREE from 'three';
import { PALETTE } from '@/rendering/style';

const MAX = 384;

const vert = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aVel;
attribute vec4 aParm; // t0, life, size0, grow
uniform float uTime;
uniform float uScale;
varying float vA;
#include <fog_pars_vertex>
void main() {
  float age = uTime - aParm.x;
  float life = aParm.y;
  if ( age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    gl_PointSize = 0.0;
    vA = 0.0;
    return;
  }
  float k = 1.6; // drag
  vec3 p = aStart + aVel * ( 1.0 - exp( -k * age ) ) / k;
  p.y += 0.25 * age; // warm haze rises a little
  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  float u = age / life;
  float size = aParm.z * ( 1.0 + aParm.w * sqrt( u ) );
  gl_PointSize = clamp( size * uScale / max( 0.5, -mvPosition.z ), 0.0, 512.0 );
  vA = smoothstep( 0.0, 0.12, u ) * ( 1.0 - smoothstep( 0.45, 1.0, u ) ) * smoothstep( 0.6, 2.5, -mvPosition.z );
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vA;
#include <fog_pars_fragment>
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = ( 1.0 - smoothstep( 0.2, 1.0, d ) ) * vA * uAlpha;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <fog_fragment>
}
`;

export interface Puffs {
  readonly points: THREE.Points;
  /**
   * Emit `n` puffs around `at` (spread radius `spread`), each moving along `dir` with
   * speed `speed` (± jitter), life ~`life` s, start size `size` m.
   */
  emit(at: THREE.Vector3, dir: THREE.Vector3, n: number, opts?: { spread?: number; speed?: number; life?: number; size?: number; up?: number }): void;
  update(dt: number): void;
}

export function createPuffs(rand: () => number): Puffs {
  const geo = new THREE.BufferGeometry();
  const start = new Float32Array(MAX * 3);
  const vel = new Float32Array(MAX * 3);
  const parm = new Float32Array(MAX * 4);
  for (let i = 0; i < MAX; i++) parm[i * 4] = -1000;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
  const aStart = new THREE.BufferAttribute(start, 3);
  const aVel = new THREE.BufferAttribute(vel, 3);
  const aParm = new THREE.BufferAttribute(parm, 4);
  aStart.setUsage(THREE.DynamicDrawUsage);
  aVel.setUsage(THREE.DynamicDrawUsage);
  aParm.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aStart', aStart);
  geo.setAttribute('aVel', aVel);
  geo.setAttribute('aParm', aParm);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 },
    uScale: { value: 500 },
    uColor: { value: new THREE.Color(PALETTE.HAZE_LIT).multiplyScalar(0.55) },
    uAlpha: { value: 0.28 },
  }]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  mat.userData.noInk = true;
  const points = new THREE.Points(geo, mat);
  points.name = 'world-puffs';
  points.frustumCulled = false;
  points.renderOrder = 7;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(size);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 75;
    uniforms.uScale.value = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
  };

  let head = 0;
  let time = 0;
  let dirty = false;

  return {
    points,
    emit(at, dir, n, o = {}) {
      const spread = o.spread ?? 1;
      const speed = o.speed ?? 2;
      const life = o.life ?? 1.6;
      const sz = o.size ?? 1.2;
      const up = o.up ?? 0.3;
      for (let k = 0; k < n; k++) {
        const i = head;
        head = (head + 1) % MAX;
        start[i * 3] = at.x + (rand() - 0.5) * 2 * spread;
        start[i * 3 + 1] = at.y + (rand() - 0.5) * spread;
        start[i * 3 + 2] = at.z + (rand() - 0.5) * 2 * spread;
        const s = speed * (0.6 + rand() * 0.8);
        vel[i * 3] = dir.x * s + (rand() - 0.5) * speed * 0.5;
        vel[i * 3 + 1] = dir.y * s + up * (0.5 + rand());
        vel[i * 3 + 2] = dir.z * s + (rand() - 0.5) * speed * 0.5;
        parm[i * 4] = time + rand() * 0.12;
        parm[i * 4 + 1] = life * (0.75 + rand() * 0.5);
        parm[i * 4 + 2] = sz * (0.7 + rand() * 0.6);
        parm[i * 4 + 3] = 1.8;
      }
      dirty = true;
    },
    update(dt) {
      time += dt;
      uniforms.uTime.value = time;
      if (dirty) {
        dirty = false;
        aStart.needsUpdate = true;
        aVel.needsUpdate = true;
        aParm.needsUpdate = true;
      }
    },
  };
}
