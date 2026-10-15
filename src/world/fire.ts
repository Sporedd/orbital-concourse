/**
 * Fire and warning lamps (grimdark revision, docs/ART_DIRECTION.md §15).
 *  - Fire sites: 4 burn barrels on the floor (always; their bodies and collision live in
 *    props.ts) plus braziers on the wall coping (more per league). Each lit site has two flame
 *    tongues and a smoke halo (glows.ts), rising embers, a dark smoke column (a Puffs pool) and,
 *    for floor barrels, an additive warm floor pool. A fixed pool of flickering PointLights
 *    (STYLE.q.fireLights) goes to the first sites: the floor barrels first, so the warm bounce
 *    lands where the player fights. Fixed light count per session: no shader recompiles.
 *  - Ash: slow grey flakes (a few hot embers among them) falling over the whole pit.
 *  - Red warning lamps on the pillars: hard red core + halo, a few of them failing.
 */
import * as THREE from 'three';
import { makeSurface } from '@/rendering/materials';
import { createPool, type LightPool } from '@/rendering/shafts';
import { GRIM, STYLE, glowLum, type LeagueStyle } from '@/rendering/style';
import { Flicker, GlowKind, type Glows } from './glows';
import { DIM } from './props';
import { createPuffs, type Puffs } from './puffs';

const polarXZ = (deg: number, r: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a) * r, Math.sin(a) * r];
};
/**
 * Burn barrels (x, z, base y), in lighting order: first one on each cargo container roof (fire in
 * the middle of the pit, so the warm bounce lands where the fights are), then four on the floor in
 * front of the sponsor plaques between the gates. Bodies + collision: props.ts burnBarrel().
 */
export const BARREL_SITES: readonly [number, number, number][] = [
  [-16.9, -9, 2.6], [16, 9.9, 2.6], [8.9, -19.5, 2.6], [-11.4, 16.5, 2.6],
  [...polarXZ(67.5, 29), 0], [...polarXZ(247.5, 29), 0], [...polarXZ(157.5, 29), 0], [...polarXZ(337.5, 29), 0],
];
export const BARREL_H = 0.95;
/** Coping braziers in lighting order (polar deg). */
const BRAZIER_ANGLES = [22.5, 202.5, 112.5, 292.5, 150, 330, 60, 240];
const BRAZIER_R = 31.15;
const BRAZIER_TOP = DIM.wallH + DIM.copingH + 0.85;
/** Red lamps on the pillar fronts, in lighting order (pillar index 0..23). */
const RED_ORDER = [0, 12, 6, 18, 3, 15, 9, 21, 1, 13, 7, 19, 4, 16, 10, 22, 2, 14, 8, 20, 5, 17, 11, 23];
/** Twin sodium wall lamps on the pillar fronts, in lighting order (pillar index). */
const SODIUM_ORDER = [1, 13, 7, 19, 4, 16, 10, 22, 2, 14, 8, 20, 5, 17, 11, 23, 0, 12, 6, 18, 3, 15, 9, 21];
const MAX_SITES = BARREL_SITES.length + BRAZIER_ANGLES.length;
const EMBERS_PER_SITE = 22;
const ASH = 700;

const FIRE_LIGHT = 40;
const FIRE_DIST = 13;

const emberVert = /* glsl */ `
attribute vec4 aSeed; // site, phase, speed, drift
uniform float uTime;
uniform vec4 uSites[ ${MAX_SITES} ];
uniform float uPR;
varying float vA;
float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
void main() {
  vec4 site = uSites[ int( aSeed.x ) ];
  float life = 2.2 + aSeed.z;
  float u = fract( aSeed.y + uTime / life );
  float ang = aSeed.y * 37.0;
  vec3 p = site.xyz + vec3( cos( ang ), 0.0, sin( ang ) ) * ( 0.15 + u * aSeed.w * 1.4 );
  p.y += u * u * 1.2 + u * 2.6;
  p.x += sin( uTime * 1.7 + aSeed.y * 20.0 ) * 0.25 * u;
  p.z += cos( uTime * 1.3 + aSeed.y * 13.0 ) * 0.25 * u;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float tw = 0.6 + 0.4 * sin( uTime * 23.0 + aSeed.y * 60.0 );
  vA = site.w * ( 1.0 - smoothstep( 0.4, 1.0, u ) ) * smoothstep( 0.0, 0.05, u ) * tw * smoothstep( 0.5, 2.0, -mv.z );
  gl_PointSize = max( 1.0, ( 2.4 / max( 1.0, -mv.z * 0.18 ) ) * uPR );
}
`;

const emberFrag = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.15, 0.5, d ) ) * vA;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

const ashVert = /* glsl */ `
attribute vec4 aSeed; // x, z, phase, size
uniform float uTime;
uniform float uPR;
varying float vA;
varying float vHot;
#include <fog_pars_vertex>
float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
void main() {
  float H = 22.0;
  float y = H - mod( uTime * ( 0.35 + aSeed.w * 0.25 ) + aSeed.z * H, H );
  vec3 p = vec3( aSeed.x, y, aSeed.y );
  p.x += sin( uTime * 0.6 + aSeed.z * 30.0 ) * 0.6;
  p.z += cos( uTime * 0.5 + aSeed.z * 21.0 ) * 0.6;
  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  vHot = step( 0.93, h11( aSeed.z * 97.0 ) );
  vA = smoothstep( 0.0, 1.5, y ) * smoothstep( 0.6, 2.5, -mvPosition.z );
  gl_PointSize = max( 1.0, ( 1.2 + aSeed.w * 1.6 ) * uPR * clamp( 6.0 / -mvPosition.z, 0.35, 1.6 ) );
  #include <fog_vertex>
}
`;

const ashFrag = /* glsl */ `
uniform vec3 uAsh;
uniform vec3 uHot;
varying float vA;
varying float vHot;
#include <fog_pars_fragment>
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.2, 0.5, d ) ) * vA;
  if ( a < 0.02 ) discard;
  gl_FragColor = vec4( mix( uAsh, uHot, vHot ), a * mix( 0.55, 1.0, vHot ) );
  #include <fog_fragment>
}
`;

interface Site {
  pos: THREE.Vector3;
  floor: boolean;
  flames: number[];
  halo: number;
  pool: LightPool | null;
  smokeT: number;
}

export interface Fire {
  readonly group: THREE.Group;
  setLeague(ls: LeagueStyle): void;
  update(dt: number): void;
}

export function createFire(glows: Glows, rand: () => number): Fire {
  const group = new THREE.Group();
  group.name = 'world-fire';
  const fireCol = new THREE.Color(GRIM.FIRE);

  // ---- sites ------------------------------------------------------------------------------
  const sites: Site[] = [];
  const mk = (pos: THREE.Vector3, floor: boolean, scale: number): Site => {
    const flames = [
      glows.add({ pos: pos.clone(), width: 1.0 * scale, height: 1.7 * scale, kind: GlowKind.Flame, color: GRIM.FIRE, intensity: 0, flicker: Flicker.Fire }),
      glows.add({ pos: pos.clone().add(new THREE.Vector3(0.14, 0, -0.08)), width: 0.75 * scale, height: 1.2 * scale, kind: GlowKind.Flame, color: 0xff8a2e, intensity: 0, flicker: Flicker.Fire }),
      glows.add({ pos: pos.clone().add(new THREE.Vector3(-0.16, -0.05, 0.1)), width: 0.65 * scale, height: 1.0 * scale, kind: GlowKind.Flame, color: 0xff5a1a, intensity: 0, flicker: Flicker.Fire }),
    ];
    const halo = glows.add({ pos: pos.clone().add(new THREE.Vector3(0, 0.7 * scale, 0)), width: 4.2 * scale, kind: GlowKind.Halo, color: GRIM.FIRE, intensity: 0, flicker: Flicker.Fire });
    let pool: LightPool | null = null;
    if (floor) {
      pool = createPool(pos.x, pos.z, pos.y > 2 ? 6 : 4.6, GRIM.FIRE, 0);
      group.add(pool.mesh);
    }
    return { pos, floor, flames, halo, pool, smokeT: rand() };
  };
  for (const [x, z, y0] of BARREL_SITES) sites.push(mk(new THREE.Vector3(x, y0 + BARREL_H - 0.05, z), true, 1));
  const brazierAt: THREE.Vector3[] = [];
  for (const deg of BRAZIER_ANGLES) {
    const a = THREE.MathUtils.degToRad(deg);
    const p = new THREE.Vector3(Math.cos(a) * BRAZIER_R, BRAZIER_TOP - 0.05, Math.sin(a) * BRAZIER_R);
    brazierAt.push(p);
    sites.push(mk(p, false, 1.25));
  }

  // brazier bodies: a rusted bowl on a squat stand, instanced (count follows the league)
  const bowl = new THREE.CylinderGeometry(0.62, 0.34, 0.5, 8, 1, false);
  bowl.translate(0, BRAZIER_TOP - 0.25, 0);
  const stand = new THREE.CylinderGeometry(0.16, 0.3, 0.4, 6);
  stand.translate(0, DIM.wallH + DIM.copingH + 0.2, 0);
  const bodyMat = makeSurface({ color: 0x2e2018, surface: 'steel', rust: 1, mottle: 0.12 });
  const bowls = new THREE.InstancedMesh(bowl, bodyMat, BRAZIER_ANGLES.length);
  const stands = new THREE.InstancedMesh(stand, bodyMat, BRAZIER_ANGLES.length);
  const m4 = new THREE.Matrix4();
  brazierAt.forEach((p, i) => {
    m4.makeTranslation(p.x, 0, p.z);
    bowls.setMatrixAt(i, m4);
    stands.setMatrixAt(i, m4);
  });
  bowls.count = stands.count = 0;
  group.add(bowls, stands);

  // ---- embers -------------------------------------------------------------------------------
  const siteU = Array.from({ length: MAX_SITES }, (_, i) => new THREE.Vector4(sites[i].pos.x, sites[i].pos.y, sites[i].pos.z, 0));
  const eN = MAX_SITES * EMBERS_PER_SITE;
  const eSeed = new Float32Array(eN * 4);
  for (let i = 0; i < eN; i++) {
    eSeed[i * 4] = Math.floor(i / EMBERS_PER_SITE);
    eSeed[i * 4 + 1] = rand();
    eSeed[i * 4 + 2] = rand() * 2.0;
    eSeed[i * 4 + 3] = rand();
  }
  const eGeo = new THREE.BufferGeometry();
  eGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(eN * 3), 3));
  eGeo.setAttribute('aSeed', new THREE.BufferAttribute(eSeed, 4));
  const eUni = {
    uTime: { value: 0 },
    uSites: { value: siteU },
    uPR: { value: typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1 },
    uColor: { value: new THREE.Color(0xff7a22).multiplyScalar(glowLum(0xff7a22, 2.2, 12)) },
  };
  const eMat = new THREE.ShaderMaterial({
    uniforms: eUni, vertexShader: emberVert, fragmentShader: emberFrag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  eMat.userData.noInk = true;
  const embers = new THREE.Points(eGeo, eMat);
  embers.frustumCulled = false;
  embers.renderOrder = 9;
  group.add(embers);

  // ---- ash ------------------------------------------------------------------------------------
  const aSeed = new Float32Array(ASH * 4);
  for (let i = 0; i < ASH; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 31;
    aSeed[i * 4] = Math.cos(a) * r;
    aSeed[i * 4 + 1] = Math.sin(a) * r;
    aSeed[i * 4 + 2] = rand();
    aSeed[i * 4 + 3] = rand();
  }
  const aGeo = new THREE.BufferGeometry();
  aGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ASH * 3), 3));
  aGeo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 4));
  const aUni = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 },
    uPR: { value: eUni.uPR.value },
    uAsh: { value: new THREE.Color(GRIM.ASH).multiplyScalar(0.16) },
    uHot: { value: new THREE.Color(0xff6a1c).multiplyScalar(1.6) },
  }]);
  const aMat = new THREE.ShaderMaterial({ uniforms: aUni, vertexShader: ashVert, fragmentShader: ashFrag, transparent: true, depthWrite: false, fog: true });
  aMat.userData.noInk = true;
  const ash = new THREE.Points(aGeo, aMat);
  ash.frustumCulled = false;
  ash.renderOrder = 8;
  group.add(ash);

  // ---- smoke --------------------------------------------------------------------------------------
  const smoke: Puffs = createPuffs(rand, { color: 0x2c231c, alpha: 0.32, max: 320 });
  group.add(smoke.points);

  // ---- lights -------------------------------------------------------------------------------------
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < STYLE.q.fireLights; i++) {
    const l = new THREE.PointLight(GRIM.FIRE, 0, FIRE_DIST, 2);
    l.castShadow = false;
    group.add(l);
    lights.push(l);
  }

  // ---- red warning lamps on the pillars ---------------------------------------------------------------
  const redCore = new THREE.Color(GRIM.WARN_RED);
  const redK = glowLum(GRIM.WARN_RED, 1.4, 20);
  const red: { dot: number; halo: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const deg = 7.5 + i * 15;
    const a = THREE.MathUtils.degToRad(deg);
    const r = DIM.pillarR - 0.86;
    // beside the accent strip, a little above the buttress cap
    const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.48);
    const p = new THREE.Vector3(Math.cos(a) * r, 10.4, Math.sin(a) * r).add(side);
    const fl = i % 5 === 2 ? Flicker.Failing : Flicker.Steady;
    red.push({
      dot: glows.add({ pos: p, width: 0.26, kind: GlowKind.Dot, color: redCore, intensity: 0, flicker: fl }),
      halo: glows.add({ pos: p, width: 3.2, kind: GlowKind.Halo, color: redCore, intensity: 0, flicker: fl }),
    });
  }

  // ---- twin sodium wall lamps on the pillars ------------------------------------------------------
  const sodium = new THREE.Color(GRIM.SODIUM_WARM);
  const sodK = glowLum(GRIM.SODIUM_WARM, 2.2, 20);
  const wall: number[][] = [];
  for (let i = 0; i < 24; i++) {
    const deg = 7.5 + i * 15;
    const a = THREE.MathUtils.degToRad(deg);
    const r = DIM.pillarR - 0.88;
    const lat = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    const c = new THREE.Vector3(Math.cos(a) * r, 13.4, Math.sin(a) * r);
    const fl = i % 7 === 3 ? Flicker.Failing : Flicker.Steady;
    wall.push([
      glows.add({ pos: c.clone().addScaledVector(lat, -0.24), width: 0.24, height: 0.16, kind: GlowKind.Dot, color: sodium, intensity: 0, flicker: fl }),
      glows.add({ pos: c.clone().addScaledVector(lat, 0.24), width: 0.24, height: 0.16, kind: GlowKind.Dot, color: sodium, intensity: 0, flicker: fl }),
      glows.add({ pos: c.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(-0.6)), width: 5.5, kind: GlowKind.Halo, color: sodium, intensity: 0, flicker: fl }),
    ]);
  }

  let active = 0;
  let time = 0;
  const lightSite: (Site | null)[] = lights.map(() => null);
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();

  return {
    group,
    setLeague(ls) {
      active = Math.min(MAX_SITES, ls.fires);
      const braziers = Math.max(0, active - BARREL_SITES.length);
      bowls.count = stands.count = braziers;
      sites.forEach((s, i) => {
        const on = i < active;
        siteU[i].w = on ? 1 : 0;
        glows.set(s.flames[0], null, on ? 2.6 : 0);
        glows.set(s.flames[1], null, on ? 2.0 : 0);
        glows.set(s.flames[2], null, on ? 1.8 : 0);
        glows.set(s.halo, null, on ? (s.floor ? 0.16 : 0.2) : 0);
        s.pool?.setIntensity(on ? 0.09 : 0);
      });
      lights.forEach((l, i) => {
        lightSite[i] = i < active ? sites[i] : null;
        if (lightSite[i]) l.position.copy(sites[i].pos).add(new THREE.Vector3(0, 1.7, 0));
        else l.intensity = 0;
      });
      const nRed = Math.min(24, ls.redLamps);
      for (let k = 0; k < 24; k++) {
        const on = RED_ORDER.indexOf(k) < nRed;
        glows.set(red[k].dot, null, on ? redK : 0);
        glows.set(red[k].halo, null, on ? 0.09 : 0);
      }
      const nSod = Math.min(24, ls.wallLamps);
      for (let k = 0; k < 24; k++) {
        const on = SODIUM_ORDER.indexOf(k) < nSod;
        glows.set(wall[k][0], null, on ? sodK : 0);
        glows.set(wall[k][1], null, on ? sodK : 0);
        glows.set(wall[k][2], null, on ? 0.16 : 0);
      }
    },
    update(dt) {
      time += dt;
      eUni.uTime.value = time % 1000;
      aUni.uTime.value = time % 1000;
      for (let i = 0; i < lights.length; i++) {
        const s = lightSite[i];
        if (!s) continue;
        const k = 0.8 + 0.12 * Math.sin(time * 9.1 + i * 3) + 0.08 * Math.sin(time * 23.7 + i) + 0.06 * (Math.random() - 0.5);
        lights[i].intensity = FIRE_LIGHT * (s.floor ? 1 : 1.6) * k;
      }
      for (let i = 0; i < active; i++) {
        const s = sites[i];
        s.smokeT -= dt;
        if (s.smokeT <= 0) {
          s.smokeT = 0.45 + rand() * 0.35;
          at.copy(s.pos).setY(s.pos.y + 1.3);
          smoke.emit(at, up, 1, { spread: 0.25, speed: 0.9, life: 6, size: 1.1, up: 0.5 });
        }
      }
      smoke.update(dt);
    },
  };
}
