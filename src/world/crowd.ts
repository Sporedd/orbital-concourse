/**
 * Instanced crowd (docs/ART_DIRECTION.md §7 "Crowd"): one InstancedBufferGeometry of
 * camera-facing (Y-axis) quads on the stand treads. The fragment shader draws a
 * head-and-shoulders SDF (alpha-tested), unlit dark colour per instance with fog, so they
 * read as silhouettes against the stand haze. Vertex animation from uniforms: idle bob,
 * hype cheer-jumps (3 Hz), a wave travelling around the ring, and camera flashes (a 1–2
 * frame white square at lum 4) on kills. Void: accent wristband dots.
 */
import * as THREE from 'three';
import { PALETTE, glowLum, type LeagueStyle } from '@/rendering/style';
import { seatRows } from './props';

export const CROWD_MAX = 10000;
const W = 0.62;
const H = 0.95;
const FLASH_SLOTS = 4;

const vert = /* glsl */ `
attribute vec3 aSeat;
attribute vec4 aSeed; // seed, shade, angle (rad), scale
uniform float uTime;
uniform float uHype;
uniform float uWaveAngle;
uniform float uWaveAmp;
uniform vec4 uFlash[ ${FLASH_SLOTS} ]; // t0, fraction, seq, -
varying vec2 vUv;
varying float vShade;
varying float vFlash;
varying float vSeed;
varying float vLighter;
uniform float uLighters;
#include <fog_pars_vertex>
float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
void main() {
  vUv = uv;
  float s = aSeed.x;
  float t = uTime;
  float bob = 0.02 * sin( t * 2.1 + s * 40.0 );
  float cheer = uHype * ( 0.04 + 0.11 * h11( s * 91.7 ) ) * max( 0.0, sin( t * 18.85 + s * 4.0 ) );
  float da = mod( aSeed.z - uWaveAngle + 3.14159265, 6.2831853 ) - 3.14159265;
  float wave = uWaveAmp * 0.38 * exp( -da * da * 30.0 );
  vec2 d = normalize( cameraPosition.xz - aSeat.xz + vec2( 1e-4 ) );
  vec3 right = vec3( d.y, 0.0, -d.x );
  float sc = aSeed.w;
  vec3 p = aSeat + right * position.x * ${W.toFixed(2)} * sc + vec3( 0.0, position.y * ${H.toFixed(2)} * sc + bob + cheer + wave, 0.0 );
  float fl = 0.0;
  for ( int i = 0; i < ${FLASH_SLOTS}; i++ ) {
    vec4 f = uFlash[ i ];
    if ( h11( s * 17.0 + f.z * 3.1 ) < f.y ) {
      float at = f.x + h11( s * 5.3 + f.z ) * 0.45;
      if ( t >= at && t < at + 0.04 ) fl = 1.0;
    }
  }
  vFlash = fl;
  // grimdark: a few lighters / hand torches held up in the dark stands (flickering)
  vLighter = h11( s * 53.1 ) < uLighters ? ( 0.75 + 0.25 * sin( t * 17.0 + s * 90.0 ) * sin( t * 6.3 + s * 40.0 ) ) : 0.0;
  vShade = aSeed.y;
  vSeed = s;
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
uniform vec3 uDark;
uniform vec3 uLight;
uniform vec3 uWrist;
uniform float uFlashI;
uniform vec3 uFlame;
varying vec2 vUv;
varying float vShade;
varying float vFlash;
varying float vSeed;
varying float vLighter;
#include <fog_pars_fragment>
float sdEll( vec2 p, vec2 r ) { float k = length( p / r ); return ( k - 1.0 ) * min( r.x, r.y ); }
void main() {
  vec2 q = vec2( ( vUv.x - 0.5 ) * ${W.toFixed(2)}, vUv.y * ${H.toFixed(2)} );
  float head = length( q - vec2( 0.0, 0.76 ) ) - 0.11;
  float sh = sdEll( q - vec2( 0.0, 0.48 ), vec2( 0.27, 0.13 ) );
  vec2 bq = abs( q - vec2( 0.0, 0.24 ) ) - vec2( 0.22, 0.26 );
  float body = length( max( bq, 0.0 ) ) + min( max( bq.x, bq.y ), 0.0 );
  float dd = min( head, min( sh, body ) );
  // raised arm + flame for lighter holders
  float fl = 1e3;
  if ( vLighter > 0.0 ) {
    float side = sign( fract( vSeed * 3.0 ) - 0.5 );
    vec2 ab = abs( q - vec2( 0.2 * side, 0.68 ) ) - vec2( 0.035, 0.16 );
    float arm = length( max( ab, 0.0 ) ) + min( max( ab.x, ab.y ), 0.0 );
    dd = min( dd, arm );
    fl = length( ( q - vec2( 0.2 * side, 0.89 ) ) * vec2( 1.0, 0.6 ) ) - 0.03 * ( 0.8 + 0.4 * fract( vSeed * 11.0 ) );
    dd = min( dd, fl );
  }
  if ( dd > 0.0 ) discard;
  vec3 col = mix( uDark, uLight, vShade );
  if ( fl <= 0.0 ) col = uFlame * vLighter;
  if ( vFlash > 0.5 && abs( q.x ) < 0.07 && abs( q.y - 0.7 ) < 0.07 ) col = vec3( uFlashI );
  if ( uWrist.r + uWrist.g + uWrist.b > 0.0 && length( q - vec2( 0.17 * sign( fract( vSeed * 7.0 ) - 0.5 ), 0.2 ) ) < 0.035 ) col = uWrist;
  gl_FragColor = vec4( col, 1.0 );
  #include <fog_fragment>
}
`;

export interface Crowd {
  readonly mesh: THREE.Mesh;
  setCount(n: number): void;
  setLeague(ls: LeagueStyle): void;
  /** 0..1 */
  setHype(v: number): void;
  /** Camera flashes on `fraction` of the crowd (spread over ~0.45 s). */
  flash(fraction: number): void;
  /** A burst: `count` flash volleys of `fraction`, `interval` s apart (boss entrance, big moments). */
  burst(fraction: number, count: number, interval: number): void;
  /** Everyone on their feet: full cheer-jump for `seconds`, whatever the hype. */
  surge(seconds: number): void;
  wave(): void;
  update(dt: number): void;
}

export function createCrowd(rand: () => number): Crowd {
  const rows = seatRows();
  const weights = rows.map((r) => r.r);
  const total = weights.reduce((a, b) => a + b, 0);
  const seat = new Float32Array(CROWD_MAX * 3);
  const seed = new Float32Array(CROWD_MAX * 4);
  for (let i = 0; i < CROWD_MAX; i++) {
    let pick = rand() * total;
    let ri = 0;
    while (ri < rows.length - 1 && pick > weights[ri]) pick -= weights[ri++];
    const row = rows[ri];
    let deg = rand() * 360;
    // keep the boss gatehouse front clear on the lowest tier
    if (row.tier === 0 && Math.abs(deg - 270) < 20) deg = (deg + 40) % 360;
    const a = THREE.MathUtils.degToRad(deg);
    const r = row.r + (rand() - 0.5) * 0.25;
    seat[i * 3] = Math.cos(a) * r;
    seat[i * 3 + 1] = row.y;
    seat[i * 3 + 2] = Math.sin(a) * r;
    seed[i * 4] = rand();
    seed[i * 4 + 1] = Math.min(1, row.tier * 0.3 + rand() * 0.45);
    seed[i * 4 + 2] = a;
    seed[i * 4 + 3] = 0.88 + rand() * 0.24;
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  geo.setAttribute('aSeat', new THREE.InstancedBufferAttribute(seat, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = 1500;

  const flashes = Array.from({ length: FLASH_SLOTS }, () => new THREE.Vector4(-100, 0, 0, 0));
  let flashHead = 0;
  let flashSeq = 0;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 },
    uHype: { value: 0 },
    uWaveAngle: { value: 0 },
    uWaveAmp: { value: 0 },
    uFlash: { value: flashes },
    uDark: { value: new THREE.Color(0x0a0a0a) },
    uLight: { value: new THREE.Color(0x1b1a19) },
    uLighters: { value: 0.012 },
    uFlame: { value: new THREE.Color(0xff8a2e).multiplyScalar(5) },
    uWrist: { value: new THREE.Color(0, 0, 0) },
    uFlashI: { value: 4 },
  }]);
  // merge() clones values: keep the flash array by reference
  uniforms.uFlash.value = flashes;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'world-crowd';
  mesh.frustumCulled = false;

  let time = 0;
  let hype = 0;
  let shownHype = 0;
  let waveT = -1;
  let surgeT = 0;
  const volleys: { at: number; fraction: number }[] = [];
  const fire = (fraction: number) => {
    const f = flashes[flashHead];
    flashHead = (flashHead + 1) % FLASH_SLOTS;
    f.set(time, THREE.MathUtils.clamp(fraction, 0, 0.2), ++flashSeq % 97, 0);
  };

  return {
    mesh,
    setCount(n) {
      geo.instanceCount = Math.max(0, Math.min(CROWD_MAX, Math.round(n)));
    },
    setLeague(ls) {
      if (ls.id === 'void') uniforms.uWrist.value.set(ls.accent).multiplyScalar(glowLum(ls.accent, 1.2));
      else uniforms.uWrist.value.setRGB(0, 0, 0);
      uniforms.uFlashI.value = 4;
      void PALETTE;
    },
    setHype(v) {
      hype = THREE.MathUtils.clamp(v, 0, 1);
    },
    flash(fraction) {
      fire(fraction);
    },
    burst(fraction, count, interval) {
      for (let i = 0; i < count; i++) volleys.push({ at: time + i * interval, fraction });
    },
    surge(seconds) {
      surgeT = Math.max(surgeT, seconds);
    },
    wave() {
      waveT = 0;
    },
    update(dt) {
      time += dt;
      uniforms.uTime.value = time;
      surgeT = Math.max(0, surgeT - dt);
      const want = surgeT > 0 ? 1 : hype;
      shownHype += (want - shownHype) * Math.min(1, dt * (surgeT > 0 ? 8 : 3));
      for (let i = volleys.length - 1; i >= 0; i--) {
        if (volleys[i].at <= time) {
          fire(volleys[i].fraction);
          volleys.splice(i, 1);
        }
      }
      uniforms.uHype.value = shownHype;
      if (waveT >= 0) {
        waveT += dt;
        const dur = 4.5;
        uniforms.uWaveAngle.value = (waveT / dur) * Math.PI * 2 * 1.25 - Math.PI / 2;
        uniforms.uWaveAmp.value = Math.sin(Math.min(1, waveT / dur) * Math.PI);
        if (waveT > dur) {
          waveT = -1;
          uniforms.uWaveAmp.value = 0;
        }
      }
    },
  };
}
