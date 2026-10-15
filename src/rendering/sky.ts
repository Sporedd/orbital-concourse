/**
 * Orbital sky (docs/ART_DIRECTION.md §6): near-black dome, white stars only (no aurora),
 * a pale desaturated planet seen through the roof oculus (size/visibility per league; Void
 * is an eclipse with a white corona) and one distant station spoke with lit windows.
 * Everything is parented to one group that follows the camera (infinitely far away).
 * The roof ring itself is world geometry (src/world/props.ts).
 */
import * as THREE from 'three';
import type { PlanetMode } from './style';

const NOISE = /* glsl */ `
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 5; i++ ) { v += a * vnoise( p ); p = p * 2.03 + vec2( 17.1, 9.2 ); a *= 0.5; }
  return v;
}
`;

const domeVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const domeFrag = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float h = clamp( d.y, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uZenith, pow( h, 0.6 ) );
  gl_FragColor = vec4( sky, 1.0 );
}
`;

const starVert = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vBright;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  float tw = 0.8 + 0.2 * sin( uTime * ( 0.35 + fract( aPhase * 7.1 ) * 0.6 ) + aPhase * 6.2831 );
  vec3 dir = normalize( position );
  vBright = tw * smoothstep( 0.05, 0.3, dir.y ) * ( 0.45 + aSize * 0.35 ) * 0.32;
  gl_PointSize = max( 1.0, aSize * uPixelRatio * 1.6 );
}
`;

const starFrag = /* glsl */ `
varying float vBright;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep( 0.0, 0.5, length( c ) );
  gl_FragColor = vec4( vec3( 1.0 ) * vBright * 1.6, a * min( vBright * 2.0, 1.0 ) );
}
`;

const planetVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** uMode: 1 = lit planet (optionally ringed), 2 = eclipse (black disc + white corona). */
const planetFrag = /* glsl */ `
uniform float uMode;
uniform float uRing;
uniform float uTime;
uniform vec2 uSun; // light direction in disc space
uniform float uLit;
varying vec2 vUv;
${NOISE}
void main() {
  vec2 p = ( vUv - 0.5 ) * 2.0 + vec2( 1e-4, 1.3e-4 ); // never exactly 0: normalize(0) is NaN and bloom spreads it
  float r = length( p );
  const float R = 0.62;
  float disc = 1.0 - smoothstep( R - 0.004, R, r );
  vec3 col = vec3( 0.0 );
  float a = 0.0;
  if ( uMode > 1.5 ) {
    // eclipse: black body, thin white corona (lum ~2, blooms)
    float rim = max( r - R, 0.0 );
    float corona = exp( -rim * 38.0 ) * 2.2 + exp( -rim * 7.0 ) * 0.35;
    float rays = 0.75 + 0.25 * fbm( vec2( atan( p.y, p.x ) * 3.0, uTime * 0.02 ) );
    corona *= rays * ( 1.0 - disc );
    col = vec3( 0.949, 0.941, 1.0 ) * corona;
    a = max( disc, clamp( corona, 0.0, 1.0 ) );
    col *= ( 1.0 - disc );
  } else {
    vec3 n = vec3( p / R, 0.0 );
    n.z = sqrt( max( 0.0, 1.0 - dot( n.xy, n.xy ) ) );
    float lat = n.y;
    float bands = fbm( vec2( lat * 9.0 + fbm( n.xy * 3.0 + uTime * 0.004 ) * 1.6, n.x * 1.4 ) );
    float cloud = smoothstep( 0.45, 0.8, fbm( n.xy * 5.0 + vec2( uTime * 0.003, 0.0 ) ) );
    vec3 c0 = vec3( 0.839, 0.863, 0.875 ); // #D6DCDF
    vec3 c1 = vec3( 0.561, 0.604, 0.631 ); // #8F9AA1
    vec3 c2 = vec3( 0.227, 0.255, 0.278 ); // #3A4147
    vec3 base = mix( c2, c1, smoothstep( 0.25, 0.55, bands ) );
    base = mix( base, c0, smoothstep( 0.55, 0.8, bands ) * 0.8 + cloud * 0.5 );
    float ndl = dot( n, normalize( vec3( uSun, 0.35 ) ) );
    float lit = smoothstep( -0.04, 0.04, ndl );
    // grimdark: a dead, ashen body. Lit side ≈ lum 0.3 (the brightest thing in the sky, still
    // below bloom), craters as dark blotches, an almost black night side
    float crater = smoothstep( 0.55, 0.75, fbm( n.xy * 7.0 + 3.1 ) );
    base = mix( vec3( dot( base, vec3( 0.333 ) ) ), base, 0.4 ) * ( 1.0 - crater * 0.35 );
    col = base * lit * 0.42 * uLit + base * 0.012;
    // thin atmosphere rim
    float rim = smoothstep( R - 0.03, R, r ) * ( 1.0 - smoothstep( R, R + 0.02, r ) );
    float atm = rim * 0.5 * smoothstep( -0.2, 0.3, dot( normalize( p ), normalize( uSun ) ) );
    col = mix( col, vec3( 0.788, 0.827, 0.847 ) * 0.6, atm * disc );
    a = disc;
    float halo = ( 1.0 - disc ) * exp( -max( r - R, 0.0 ) * 60.0 ) * 0.5 * smoothstep( -0.2, 0.4, dot( normalize( p ), normalize( uSun ) ) );
    col += vec3( 0.788, 0.827, 0.847 ) * halo * 0.4;
    a = max( a, halo );
    if ( uRing > 0.5 ) {
      // flat ring seen at a tilt: ellipse band, occluded by the disc in front half
      vec2 q = vec2( p.x, p.y * 3.2 + p.x * 0.6 );
      float rr = length( q );
      float band = smoothstep( 0.78, 0.8, rr ) * ( 1.0 - smoothstep( 0.98, 1.0, rr ) );
      band *= 0.55 + 0.45 * vnoise( vec2( rr * 60.0, 0.0 ) );
      float front = step( 0.0, -( p.y * 3.2 + p.x * 0.6 ) );
      float vis = disc > 0.5 ? front : 1.0;
      vec3 rc = vec3( 0.66, 0.68, 0.69 ) * 0.42 * band * vis;
      col = mix( col, rc, band * vis * 0.85 );
      a = max( a, band * vis * 0.9 );
    }
  }
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( col, a );
}
`;

export interface Sky {
  group: THREE.Group;
  update(dt: number, elapsed: number, cameraPos: THREE.Vector3, camera: THREE.Camera): void;
  setPixelRatio(pr: number): void;
  setPlanet(mode: PlanetMode): void;
}

export function createSky(rand: () => number): Sky {
  const group = new THREE.Group();
  group.name = 'sky';
  group.userData.noInk = true;

  // --- dome
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Color(0x07070a) },
      uZenith: { value: new THREE.Color(0x020203) },
    },
    vertexShader: domeVert,
    fragmentShader: domeFrag,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);

  // --- stars (white only)
  const STARS = 2200;
  const pos = new Float32Array(STARS * 3);
  const size = new Float32Array(STARS);
  const phase = new Float32Array(STARS);
  const v = new THREE.Vector3();
  for (let i = 0; i < STARS; i++) {
    const y = 0.08 + Math.pow(rand(), 0.7) * 0.92;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    v.set(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(290);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    const s = rand();
    size[i] = 0.6 + s * s * s * 2.2;
    phase[i] = rand();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: starVert,
    fragmentShader: starFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -999;
  group.add(stars);

  // --- planet (billboard disc)
  const planetDir = new THREE.Vector3(0.42, Math.sin(THREE.MathUtils.degToRad(62)), -0.38).normalize();
  const planetMat = new THREE.ShaderMaterial({
    uniforms: { uMode: { value: 0 }, uRing: { value: 0 }, uTime: { value: 0 }, uSun: { value: new THREE.Vector2(-0.8, 0.45) }, uLit: { value: 1 } },
    vertexShader: planetVert,
    fragmentShader: planetFrag,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const planet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planetMat);
  planet.frustumCulled = false;
  planet.renderOrder = -998;
  planet.visible = false;
  group.add(planet);

  // --- station spoke: long rail with lit window dots
  const spoke = new THREE.Group();
  const railMat = new THREE.MeshBasicMaterial({ color: 0x0c0d0f, fog: false });
  const winMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa552).multiplyScalar(0.22), fog: false, toneMapped: false });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), railMat);
  rail.scale.set(150, 3.2, 3.2);
  spoke.add(rail);
  const pod = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), railMat);
  pod.scale.set(16, 9, 9);
  pod.position.x = 64;
  spoke.add(pod);
  const winGeo = new THREE.BoxGeometry(1, 1, 1);
  const wins = new THREE.InstancedMesh(winGeo, winMat, 18);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 18; i++) {
    const x = -66 + i * 7.4 + (rand() - 0.5) * 2;
    m4.compose(new THREE.Vector3(x, (rand() - 0.5) * 1.2, 1.7), new THREE.Quaternion(), new THREE.Vector3(1.4, 0.7, 0.2));
    wins.setMatrixAt(i, m4);
  }
  wins.frustumCulled = false;
  spoke.add(wins);
  spoke.position.set(-95, 225, -40); // crosses the north-west part of the oculus, beside the planet
  spoke.lookAt(0, 0, 0);
  spoke.rotateZ(0.5);
  spoke.renderOrder = -997;
  spoke.traverse((o) => { o.frustumCulled = false; o.renderOrder = -997; });
  group.add(spoke);

  const tmp = new THREE.Vector3();
  let planetScale = 0;

  return {
    group,
    setPixelRatio(pr) {
      starMat.uniforms.uPixelRatio.value = pr;
    },
    setPlanet(mode) {
      planet.visible = mode !== 'none';
      planetMat.uniforms.uMode.value = mode === 'eclipse' ? 2 : 1;
      planetMat.uniforms.uRing.value = mode === 'large' ? 1 : 0;
      // quarter: small limb low in the oculus; half: medium; large: big + ringed; eclipse: big
      // north (over the boss gate, the direction the player faces from the entrance), 50–62°
      // elevation: seen through the oculus above the north rim from most of the floor
      // grimdark: smaller and dimmer than the brutalist spec; Scrap gets a small dead moon
      const sizes: Record<PlanetMode, number> = { none: 0, dead: 74, quarter: 105, half: 125, large: 160, eclipse: 140 };
      planetScale = sizes[mode];
      planetMat.uniforms.uSun.value.set(mode === 'quarter' ? -1.0 : mode === 'dead' ? -0.35 : -0.8, mode === 'quarter' ? 0.15 : 0.45);
      planetMat.uniforms.uLit.value = mode === 'dead' ? 1.15 : 1;
      const elev = mode === 'quarter' ? 50 : mode === 'half' || mode === 'dead' ? 54 : mode === 'large' ? 58 : 62;
      planetDir.set(0.3, 0, -0.95).normalize().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(elev)));
      planetDir.y = Math.sin(THREE.MathUtils.degToRad(elev));
      planetDir.normalize();
    },
    update(_dt, elapsed, cameraPos, camera) {
      group.position.copy(cameraPos);
      const t = elapsed % 10000;
      starMat.uniforms.uTime.value = t;
      planetMat.uniforms.uTime.value = t;
      if (planet.visible) {
        planet.position.copy(planetDir).multiplyScalar(260);
        planet.scale.setScalar(planetScale);
        camera.getWorldPosition(tmp);
        planet.lookAt(tmp);
      }
    },
  };
}
