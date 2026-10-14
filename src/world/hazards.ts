/**
 * Arena hazards (M9 start; docs/ART_DIRECTION.md §7 "Hazards", §12 "Hazard (M9)").
 * One hazard per league, gated by the league dressing in src/standing/ranks.ts:
 *   Scrap  — none
 *   Iron   — vent pulls: wall vents telegraph (THREAT lamp strobe, floor chevrons, haze
 *            trickle, 1.4 s) then blast for 1.3 s, shoving the player toward the centre.
 *   Steel  — laser grid: a THREAT beam at knee height (0.55 m, jump it or stand on cover)
 *            sweeps slowly across the floor; 1.2 s warning line first; 8 shock per 0.5 s.
 *   Star   — gravity pulse pads: accent ring pads charge (1.2 s) and pulse, popping a
 *            player standing on one upward. No damage.
 *   Void   — shrinking ring: accent ring + haze wall closes from r 29.5 to 12 after a 2 s
 *            warning, holds, and opens again; 6 damage per 0.5 s outside it.
 * Hazards only run during a round (wave/boss phase) while no screen is open, and only act on
 * the local player (each peer applies its own). No hit exceeds 8 damage.
 */
import * as THREE from 'three';
import type { GameContext, PlayerState } from '@/core/types';
import { makeGlow, makeSurface } from '@/rendering/materials';
import { LUM, PALETTE, glowLum, type LeagueStyle } from '@/rendering/style';
import { leagueById } from '@/standing/ranks';
import type { LeagueId } from '@/standing/types';
import type { Collision } from './collision';
import { DIM } from './props';
import type { Puffs } from './puffs';

export type HazardKind = 'vent_pulls' | 'laser_grids' | 'gravity_pulses' | 'shrinking_ring';

export const HAZARD_LABEL: Record<HazardKind, string> = {
  vent_pulls: 'VENT PULLS',
  laser_grids: 'LASER GRID',
  gravity_pulses: 'GRAVITY PULSE',
  shrinking_ring: 'SHRINKING RING',
};

/** Tuning (exported for tests). */
export const HAZARD = {
  laserDamage: 8,
  ringDamage: 6,
  tick: 0.5,
  laserY: 0.55,
  laserHalfWidth: 0.35,
  laserSpeed: 3,
  ventAcc: 75,
  ventMaxSpeed: 8,
  ventReach: 12,
  padRadius: 2.4,
  padLaunch: 7,
  ringMax: 29.5,
  ringMin: 12,
} as const;

export const VENT_ANGLES = [22.5, 112.5, 202.5, 292.5];

export interface Hazards {
  readonly group: THREE.Group;
  /** The current hazard (league, or forced), null when none. */
  readonly kind: HazardKind | null;
  /** True while the hazard is running (round in progress, nothing paused). */
  readonly active: boolean;
  /** Current phase of the running hazard, for debugging/UI ('idle', 'warn', 'live', …). */
  readonly phase: string;
  /** Void ring: current safe radius (Infinity when no ring is closing). */
  readonly safeRadius: number;
  /** Master switch (default on). */
  enabled: boolean;
  /** Dev / look-dev: run outside rounds and through the pause screen (window.__cam). */
  alwaysOn: boolean;
  /** Dev: force a hazard (or 'none'); null follows the league again. */
  force(kind: HazardKind | 'none' | null): void;
  /** Dev: skip the idle wait and trigger the next cycle now (vents: optional vent index). */
  trigger(index?: number): void;
  setLeague(ls: LeagueStyle): void;
  update(dt: number): void;
}

interface Impl {
  readonly kind: HazardKind;
  readonly group: THREE.Group;
  phase: string;
  /** Back to the start of the idle wait; hide transient visuals. */
  reset(firstDelay: number): void;
  trigger(index?: number): void;
  step(dt: number, time: number, p: PlayerState | null): void;
  setLeague(ls: LeagueStyle): void;
  safeRadius?(): number;
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------
const passVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function additive(frag: string, uniforms: Record<string, THREE.IUniform>, side: THREE.Side = THREE.FrontSide): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: passVert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    fog: false,
  });
  m.userData.noInk = true;
  return m;
}

const threatGlow = (lum: number) => new THREE.Color(PALETTE.THREAT).multiplyScalar(glowLum(PALETTE.THREAT, lum, 20));
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const FLOOR_QUAD = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** Ground contact (cheap): feet within 5 cm of the ground under them. */
function grounded(ctx: GameContext, p: PlayerState): boolean {
  const og = (p as { onGround?: unknown }).onGround;
  if (typeof og === 'boolean') return og;
  return p.position.y - ctx.world.groundHeight(p.position.x, p.position.z) < 0.05 && p.velocity.y <= 0.5;
}

// ---------------------------------------------------------------------------
// Iron: vent pulls
// ---------------------------------------------------------------------------
const chevronFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uTime;
uniform float uLen;
varying vec2 vUv;
void main() {
  // uv.x across the lane (0..1), uv.y from the vent (0) to the far end (1)
  float u = abs( vUv.x - 0.5 ) * 2.0;
  float along = vUv.y * uLen;
  float c = fract( ( along - u * 1.1 ) / 1.6 - uTime * 1.8 );
  float chev = smoothstep( 0.0, 0.06, c ) * ( 1.0 - smoothstep( 0.32, 0.4, c ) );
  float edge = 1.0 - smoothstep( 0.82, 1.0, u );
  float fade = 1.0 - smoothstep( 0.55, 1.0, vUv.y );
  float a = uI * chev * edge * fade;
  if ( a <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

function createVents(ctx: GameContext, puffs: Puffs, rand: () => number): Impl {
  const group = new THREE.Group();
  group.name = 'hazard-vents';
  const steelDark = makeSurface({ color: PALETTE.STEEL_DARK, surface: 'steel' });
  const steel = makeSurface({ color: PALETTE.STEEL, surface: 'steel' });
  const shadow = makeSurface({ color: PALETTE.SHADOW, surface: 'flat' });
  const idle = new THREE.Color(PALETTE.LAMP_IDLE).multiplyScalar(0.6);
  const hot = threatGlow(2.0);
  interface Vent { pos: THREE.Vector3; inward: THREE.Vector3; tangent: THREE.Vector3; lamp: THREE.MeshBasicMaterial; lane: THREE.ShaderMaterial }
  const vents: Vent[] = VENT_ANGLES.map((deg) => {
    const a = THREE.MathUtils.degToRad(deg);
    const F = new THREE.Group();
    const r = DIM.wallIn;
    F.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    F.rotation.y = -Math.PI / 2 - a; // local +z toward the centre
    const add = (mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number, rx = 0) => {
      const m = new THREE.Mesh(UNIT, mat);
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      m.rotation.x = rx;
      m.receiveShadow = true;
      F.add(m);
      return m;
    };
    add(steelDark, 0, 1.15, 0.06, 2.9, 1.8, 0.12); // frame
    add(shadow, 0, 1.15, 0.125, 2.5, 1.4, 0.01); // dark throat
    for (let k = 0; k < 6; k++) add(steel, 0, 0.6 + k * 0.22, 0.17, 2.5, 0.06, 0.16, -0.6); // louvres
    const lamp = makeGlow(0xffffff, 1);
    lamp.color.copy(idle);
    add(lamp, 0, 2.2, 0.07, 2.2, 0.12, 0.06);
    // floor grate in front of the vent
    const grate = add(steelDark, 0, 0.012, 0.9, 2.8, 0.024, 1.4);
    grate.receiveShadow = true;
    for (let k = 0; k < 7; k++) add(shadow, -1.2 + k * 0.4, 0.026, 0.9, 0.08, 0.004, 1.2);
    // lane chevrons (additive, only while the vent is hot)
    const lane = additive(chevronFrag, {
      uColor: { value: threatGlow(0.9) },
      uI: { value: 0 },
      uTime: { value: 0 },
      uLen: { value: HAZARD.ventReach },
    });
    const laneMesh = new THREE.Mesh(FLOOR_QUAD, lane);
    const reach = HAZARD.ventReach;
    // FLOOR_QUAD: uv.y runs toward local -z → rotate 180° so it runs inward (+z)
    laneMesh.rotation.y = Math.PI;
    laneMesh.position.set(0, 0.03, 1.7 + reach / 2);
    laneMesh.scale.set(3.4 + reach * 0.3, 1, reach);
    laneMesh.renderOrder = 5;
    F.add(laneMesh);
    group.add(F);
    return {
      pos: new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      inward: new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)),
      tangent: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)),
      lamp,
      lane,
    };
  });

  const WARN = 1.4;
  const BLAST = 1.3;
  let wait = 6;
  let t = -1; // time into the current cycle (−1 = waiting)
  let cur = 0;
  let pick = -1;
  let popped = false;
  let trickle = 0;
  const tmp = new THREE.Vector3();
  const at = new THREE.Vector3();

  const impl: Impl = {
    kind: 'vent_pulls',
    group,
    phase: 'idle',
    reset(firstDelay) {
      wait = firstDelay;
      t = -1;
      impl.phase = 'idle';
      for (const v of vents) {
        v.lamp.color.copy(idle);
        v.lane.uniforms.uI.value = 0;
      }
    },
    trigger(index) {
      wait = 0;
      pick = index ?? -1;
    },
    step(dt, time, p) {
      for (const v of vents) v.lane.uniforms.uTime.value = time;
      if (t < 0) {
        wait -= dt;
        if (wait > 0) return;
        cur = pick >= 0 && pick < vents.length ? pick : Math.floor(rand() * vents.length);
        pick = -1;
        t = 0;
        popped = false;
      }
      t += dt;
      const v = vents[cur];
      if (t < WARN) {
        impl.phase = 'warn';
        const on = Math.sin(time * Math.PI * 2 * 7) > 0 ? 1 : 0.12;
        v.lamp.color.copy(hot).multiplyScalar(on);
        v.lane.uniforms.uI.value = 0.35 + 0.65 * on * (t / WARN);
        trickle -= dt;
        if (trickle <= 0) {
          trickle = 0.12;
          at.copy(v.pos).addScaledVector(v.inward, 0.6).setY(1.0);
          puffs.emit(at, v.inward, 2, { spread: 0.8, speed: 1.2, life: 1.2, size: 0.7, up: 0.1 });
        }
      } else if (t < WARN + BLAST) {
        impl.phase = 'live';
        v.lamp.color.copy(hot);
        v.lane.uniforms.uI.value = 1;
        trickle -= dt;
        if (trickle <= 0) {
          trickle = 0.07;
          at.copy(v.pos).addScaledVector(v.inward, 0.8).setY(1.0);
          puffs.emit(at, v.inward, 5, { spread: 1.0, speed: 10, life: 1.5, size: 1.1, up: -0.1 });
        }
        if (p && p.alive) {
          tmp.subVectors(p.position, v.pos);
          const along = tmp.dot(v.inward);
          const lat = Math.abs(tmp.dot(v.tangent));
          if (along > 0 && along < HAZARD.ventReach && lat < 1.7 + along * 0.18 && p.position.y < 3) {
            const f = Math.pow(1 - along / HAZARD.ventReach, 0.7);
            const vAlong = p.velocity.dot(v.inward);
            const cap = HAZARD.ventMaxSpeed * f;
            if (vAlong < cap) p.velocity.addScaledVector(v.inward, Math.min(HAZARD.ventAcc * f * dt, cap - vAlong));
            if (!popped && grounded(ctx, p)) {
              popped = true;
              p.velocity.y = Math.max(p.velocity.y, 3.2 * f + 1);
            }
          }
        }
      } else {
        impl.phase = 'idle';
        v.lamp.color.copy(idle);
        v.lane.uniforms.uI.value = 0;
        t = -1;
        wait = 6 + rand() * 4;
      }
    },
    setLeague() { /* fixed look */ },
  };
  return impl;
}

// ---------------------------------------------------------------------------
// Steel: laser grid
// ---------------------------------------------------------------------------
const stripFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uDash;
varying vec2 vUv;
void main() {
  float u = abs( vUv.y - 0.5 ) * 2.0; // across the strip
  float core = 1.0 - smoothstep( 0.0, 1.0, u );
  float dash = uDash > 0.5 ? step( 0.5, fract( vUv.x * 30.0 ) ) : 1.0;
  float a = uI * core * core * dash;
  if ( a <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

function createLaser(ctx: GameContext, rand: () => number): Impl {
  const group = new THREE.Group();
  group.name = 'hazard-laser';
  const beamMat = makeGlow(0xffffff, 1);
  beamMat.color.copy(threatGlow(3));
  beamMat.fog = false;
  const beam = new THREE.Mesh(UNIT, beamMat);
  beam.renderOrder = 6;
  const haloMat = additive(stripFrag, { uColor: { value: threatGlow(0.6) }, uI: { value: 0 }, uDash: { value: 0 } }, THREE.DoubleSide);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat); // vertical soft glow sheet around the beam
  const floorMat = additive(stripFrag, { uColor: { value: threatGlow(1.0) }, uI: { value: 0 }, uDash: { value: 0 } });
  const floorStrip = new THREE.Mesh(FLOOR_QUAD, floorMat);
  const aheadMat = additive(stripFrag, { uColor: { value: threatGlow(0.7) }, uI: { value: 0 }, uDash: { value: 1 } });
  const ahead = new THREE.Mesh(FLOOR_QUAD, aheadMat);
  const emitMat = makeGlow(0xffffff, 1);
  emitMat.color.copy(threatGlow(2));
  const emitters = [0, 1].map(() => {
    const e = new THREE.Group();
    const housing = new THREE.Mesh(UNIT, makeSurface({ color: PALETTE.STEEL_DARK, surface: 'steel' }));
    housing.scale.set(0.5, 1.1, 0.5);
    housing.position.y = 0.55;
    const eye = new THREE.Mesh(UNIT, emitMat);
    eye.scale.set(0.54, 0.12, 0.54);
    eye.position.y = HAZARD.laserY;
    e.add(housing, eye);
    group.add(e);
    return e;
  });
  group.add(beam, halo, floorStrip, ahead);
  const live = [beam, halo, floorStrip, ahead, ...emitters];
  const hideAll = () => { for (const o of live) o.visible = false; };
  hideAll();

  const WARN = 1.2;
  const D = 25;
  let wait = 5;
  let t = -1;
  let theta = 0;
  let sign = 1;
  let cooldown = 0;
  const n = new THREE.Vector3();
  const tan = new THREE.Vector3();

  const place = (d: number) => {
    const R = DIM.floorR - 0.2;
    const L = Math.sqrt(Math.max(1, R * R - d * d));
    const cx = n.x * d, cz = n.z * d;
    const ry = Math.atan2(-tan.z, tan.x); // local +x along the tangent
    beam.position.set(cx, HAZARD.laserY, cz);
    beam.rotation.set(0, ry, 0);
    beam.scale.set(L * 2, 0.05, 0.05);
    halo.position.set(cx, HAZARD.laserY, cz);
    halo.rotation.set(0, ry, 0);
    halo.scale.set(L * 2, 0.5, 1);
    floorStrip.position.set(cx, 0.02, cz);
    floorStrip.rotation.set(0, ry, 0);
    floorStrip.scale.set(L * 2, 1, 0.7);
    for (let k = 0; k < 2; k++) {
      const s = k ? 1 : -1;
      emitters[k].position.set(cx + tan.x * L * s, 0, cz + tan.z * L * s);
      emitters[k].rotation.y = ry;
    }
    const da = d + sign * 2.5;
    const La = Math.sqrt(Math.max(1, R * R - da * da));
    ahead.position.set(n.x * da, 0.02, n.z * da);
    ahead.rotation.set(0, ry, 0);
    ahead.scale.set(La * 2, 1, 0.35);
  };

  const impl: Impl = {
    kind: 'laser_grids',
    group,
    phase: 'idle',
    reset(firstDelay) {
      wait = firstDelay;
      t = -1;
      impl.phase = 'idle';
      hideAll();
    },
    trigger() { wait = 0; },
    step(dt, time, p) {
      cooldown = Math.max(0, cooldown - dt);
      if (t < 0) {
        wait -= dt;
        if (wait > 0) return;
        theta = rand() * Math.PI * 2;
        sign = rand() < 0.5 ? -1 : 1;
        n.set(Math.cos(theta), 0, Math.sin(theta));
        tan.set(-n.z, 0, n.x);
        t = 0;
      }
      t += dt;
      const sweep = (2 * D) / HAZARD.laserSpeed;
      if (t < WARN) {
        impl.phase = 'warn';
        place(-sign * D);
        const on = Math.sin(time * Math.PI * 2 * 6) > 0 ? 1 : 0.1;
        floorStrip.visible = ahead.visible = true;
        emitters[0].visible = emitters[1].visible = true;
        beam.visible = halo.visible = false;
        floorMat.uniforms.uI.value = on;
        aheadMat.uniforms.uI.value = on * 0.8;
        emitMat.color.copy(threatGlow(2)).multiplyScalar(on);
        return;
      }
      if (t < WARN + sweep) {
        impl.phase = 'live';
        const k = (t - WARN) / sweep;
        const d = -sign * D + sign * 2 * D * k;
        place(d);
        for (const o of live) o.visible = true;
        const fadeIn = Math.min(1, (t - WARN) / 0.25);
        const flicker = 0.85 + 0.15 * Math.sin(time * 90);
        beamMat.color.copy(threatGlow(3)).multiplyScalar(fadeIn * flicker);
        haloMat.uniforms.uI.value = 0.5 * fadeIn;
        floorMat.uniforms.uI.value = 0.7 * fadeIn;
        aheadMat.uniforms.uI.value = 0.45 * fadeIn;
        emitMat.color.copy(threatGlow(2));
        if (p && p.alive && cooldown <= 0) {
          const dd = p.position.x * n.x + p.position.z * n.z - d;
          const feet = p.position.y;
          if (Math.abs(dd) < HAZARD.laserHalfWidth && feet < HAZARD.laserY + 0.03 && feet + 1.8 > HAZARD.laserY) {
            cooldown = HAZARD.tick;
            p.takeDamage(HAZARD.laserDamage, { element: 'shock', point: new THREE.Vector3(p.position.x, HAZARD.laserY, p.position.z) });
            // shove out of the beam, along its travel, so it does not keep cooking
            p.velocity.x += n.x * sign * 4;
            p.velocity.z += n.z * sign * 4;
          }
        }
        return;
      }
      impl.phase = 'idle';
      hideAll();
      t = -1;
      wait = 7 + rand() * 4;
    },
    setLeague() { /* THREAT only */ },
  };
  void ctx;
  return impl;
}

// ---------------------------------------------------------------------------
// Star: gravity pulse pads
// ---------------------------------------------------------------------------
const padFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uBase;
uniform float uCharge;
uniform float uWave;
varying vec2 vUv;
float ring( float r, float at, float w ) { return 1.0 - smoothstep( 0.0, w, abs( r - at ) ); }
void main() {
  float r = length( vUv - 0.5 ) * 2.0 * 5.0; // metres (quad is 10 m)
  float a = 0.0;
  a += ring( r, 1.75, 0.08 ) * uBase;
  a += ring( r, 2.35, 0.05 ) * uBase * 0.8;
  // inner tick marks
  float ang = atan( vUv.y - 0.5, vUv.x - 0.5 );
  a += step( 0.8, fract( ang / 6.2831853 * 16.0 ) ) * step( 1.95, r ) * step( r, 2.2 ) * uBase * 0.6;
  // charge: contracting ring + filling disc
  if ( uCharge > 0.0 ) {
    a += ring( r, mix( 2.35, 0.2, uCharge ), 0.12 ) * 1.6;
    a += ( 1.0 - smoothstep( 1.6, 1.75, r ) ) * uCharge * 0.25;
  }
  // pulse: expanding shock ring
  if ( uWave > 0.0 && uWave < 1.0 ) a += ring( r, 1.0 + uWave * 4.0, 0.25 ) * ( 1.0 - uWave ) * 1.8;
  if ( a <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

function createPads(ctx: GameContext, col: Collision, puffs: Puffs): Impl {
  const group = new THREE.Group();
  group.name = 'hazard-pads';
  // pick 4 free floor spots on a ring, near the diagonals
  const centres: THREE.Vector3[] = [];
  for (const base of [45, 135, 225, 315]) {
    let found: THREE.Vector3 | null = null;
    for (let tries = 0; tries < 60 && !found; tries++) {
      const da = ((tries % 12) - 6) * 4;
      const r = 14 + Math.floor(tries / 12) * 1.5;
      const a = THREE.MathUtils.degToRad(base + da);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!col.isBlocked(x, z, HAZARD.padRadius + 0.6)) found = new THREE.Vector3(x, 0, z);
    }
    if (found) centres.push(found);
  }
  const uColor = { value: new THREE.Color() };
  const uniforms = { uColor, uBase: { value: 1 }, uCharge: { value: 0 }, uWave: { value: 0 } };
  const mat = additive(padFrag, uniforms);
  for (const c of centres) {
    const m = new THREE.Mesh(FLOOR_QUAD, mat);
    m.position.set(c.x, 0.018, c.z);
    m.scale.set(10, 1, 10);
    m.renderOrder = 5;
    group.add(m);
  }
  let accent = 0xe8368f;
  const PERIOD = 8;
  const CHARGE = 1.2;
  const WAVE = 0.8;
  let wait = 5;
  let t = -1;
  const at = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const impl: Impl = {
    kind: 'gravity_pulses',
    group,
    phase: 'idle',
    reset(firstDelay) {
      wait = firstDelay;
      t = -1;
      impl.phase = 'idle';
      uniforms.uCharge.value = 0;
      uniforms.uWave.value = 0;
      uniforms.uBase.value = 1;
    },
    trigger() { wait = 0; },
    step(dt, _time, p) {
      if (t < 0) {
        wait -= dt;
        if (wait > 0) return;
        t = 0;
      }
      const prev = t;
      t += dt;
      if (t < CHARGE) {
        impl.phase = 'warn';
        uniforms.uCharge.value = t / CHARGE;
        uniforms.uBase.value = 1 + 0.8 * (t / CHARGE); // lum 1.1 → 2
      } else if (t < CHARGE + WAVE) {
        impl.phase = 'live';
        if (prev < CHARGE) {
          for (const c of centres) {
            at.copy(c).setY(0.3);
            puffs.emit(at, up, 10, { spread: 1.2, speed: 2.5, life: 1.0, size: 0.9, up: 1 });
          }
          if (p && p.alive) {
            for (const c of centres) {
              if (Math.hypot(p.position.x - c.x, p.position.z - c.z) < HAZARD.padRadius && p.position.y < 0.6) {
                p.velocity.y = Math.max(p.velocity.y, HAZARD.padLaunch);
              }
            }
          }
        }
        uniforms.uCharge.value = 0;
        uniforms.uWave.value = (t - CHARGE) / WAVE;
        uniforms.uBase.value = 1.8 - 0.8 * ((t - CHARGE) / WAVE);
      } else {
        impl.phase = 'idle';
        uniforms.uWave.value = 0;
        uniforms.uBase.value = 1;
        t = -1;
        wait = PERIOD - CHARGE - WAVE;
      }
      uColor.value.set(accent).multiplyScalar(glowLum(accent, LUM.accent));
    },
    setLeague(ls) {
      accent = ls.accent;
      uColor.value.set(accent).multiplyScalar(glowLum(accent, LUM.accent));
    },
  };
  void ctx;
  return impl;
}

// ---------------------------------------------------------------------------
// Void: shrinking ring
// ---------------------------------------------------------------------------
const wallFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uTime;
varying vec2 vUv;
varying vec3 vWorld;
float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
void main() {
  float v = vUv.y; // 0 at the floor, 1 at the top
  float ang = atan( vWorld.z, vWorld.x );
  float col = floor( ang * 48.0 );
  float streak = 0.5 + 0.5 * sin( v * 14.0 - uTime * 3.0 + h11( col ) * 20.0 );
  float haze = pow( 1.0 - v, 2.2 ) * ( 0.22 + 0.18 * streak );
  float base = 1.0 - smoothstep( 0.0, 0.035, v );
  float a = uI * ( haze + base * 1.4 );
  if ( a <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

const outsideFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uR;
uniform float uTime;
varying vec3 vWorld;
void main() {
  float r = length( vWorld.xz );
  if ( r < uR || r > 30.6 ) discard;
  float stripes = step( 0.5, fract( ( vWorld.x + vWorld.z ) * 0.5 - uTime * 0.4 ) );
  float near = 1.0 - smoothstep( 0.0, 2.5, r - uR );
  float a = uI * ( 0.015 + 0.022 * stripes + near * 0.1 );
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

function createRing(ctx: GameContext): Impl {
  const group = new THREE.Group();
  group.name = 'hazard-ring';
  const uColor = { value: new THREE.Color() };
  const uTime = { value: 0 };
  const wallUni = { uColor, uI: { value: 0 }, uTime };
  const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 128, 1, true).translate(0, 0.5, 0);
  const wall = new THREE.Mesh(wallGeo, additive(wallFrag, wallUni, THREE.DoubleSide));
  wall.renderOrder = 6;
  wall.frustumCulled = false;
  const outUni = { uColor, uI: { value: 0 }, uR: { value: HAZARD.ringMax as number }, uTime };
  const outside = new THREE.Mesh(FLOOR_QUAD, additive(outsideFrag, outUni));
  outside.scale.set(62, 1, 62);
  outside.position.y = 0.016;
  outside.renderOrder = 5;
  outside.frustumCulled = false;
  group.add(wall, outside);
  wall.visible = outside.visible = false;

  const WARN = 2;
  const SHRINK = 16;
  const HOLD = 8;
  const EXPAND = 5;
  let wait = 10;
  let t = -1;
  let R = Infinity;
  let cooldown = 0;
  let accent = 0x8c6cff;
  const setR = (r: number, vis: number) => {
    R = r;
    wall.scale.set(r, 3.6, r);
    outUni.uR.value = r;
    wallUni.uI.value = vis;
    outUni.uI.value = vis;
    wall.visible = outside.visible = vis > 0.001;
  };
  const sm = (x: number) => x * x * (3 - 2 * x);

  const impl: Impl = {
    kind: 'shrinking_ring',
    group,
    phase: 'idle',
    reset(firstDelay) {
      wait = firstDelay;
      t = -1;
      impl.phase = 'idle';
      setR(HAZARD.ringMax, 0);
      R = Infinity;
    },
    trigger() { wait = 0; },
    step(dt, time, p) {
      uTime.value = time;
      cooldown = Math.max(0, cooldown - dt);
      uColor.value.set(accent).multiplyScalar(glowLum(accent, LUM.accent));
      if (t < 0) {
        wait -= dt;
        if (wait > 0) return;
        t = 0;
        ctx.events.emit('ui:message', { text: 'RING CLOSING · GET INSIDE', duration: 2.5, style: 'warning' });
      }
      t += dt;
      const { ringMax: MAX, ringMin: MIN } = HAZARD;
      let damaging = true;
      if (t < WARN) {
        impl.phase = 'warn';
        const on = Math.sin(time * Math.PI * 2 * 4) > 0 ? 1 : 0.3;
        setR(MAX, on * Math.min(1, t / 0.4));
        damaging = false;
      } else if (t < WARN + SHRINK) {
        impl.phase = 'live';
        setR(MAX + (MIN - MAX) * sm((t - WARN) / SHRINK), 1);
      } else if (t < WARN + SHRINK + HOLD) {
        impl.phase = 'live';
        setR(MIN, 1);
      } else if (t < WARN + SHRINK + HOLD + EXPAND) {
        impl.phase = 'open';
        const k = (t - WARN - SHRINK - HOLD) / EXPAND;
        setR(MIN + (MAX - MIN) * sm(k), 1 - k * 0.6);
      } else {
        impl.phase = 'idle';
        setR(MAX, 0);
        R = Infinity;
        t = -1;
        wait = 16;
        return;
      }
      if (damaging && p && p.alive && cooldown <= 0) {
        const d = Math.hypot(p.position.x, p.position.z);
        if (d > R + 0.25) {
          cooldown = HAZARD.tick;
          p.takeDamage(HAZARD.ringDamage, { element: 'none', point: p.position.clone().setY(p.position.y + 1) });
        }
      }
    },
    setLeague(ls) {
      accent = ls.accent;
    },
    safeRadius: () => R,
  };
  return impl;
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------
export function hazardForLeague(id: string): HazardKind | null {
  const known = ['scrap', 'iron', 'steel', 'star', 'void'];
  if (!known.includes(id)) return null;
  return leagueById(id as LeagueId).dressing.hazard;
}

export function createHazards(ctx: GameContext, col: Collision, puffs: Puffs, rand: () => number): Hazards {
  const group = new THREE.Group();
  group.name = 'world-hazards';
  const impls: Record<HazardKind, Impl> = {
    vent_pulls: createVents(ctx, puffs, rand),
    laser_grids: createLaser(ctx, rand),
    gravity_pulses: createPads(ctx, col, puffs),
    shrinking_ring: createRing(ctx),
  };
  for (const k of Object.keys(impls) as HazardKind[]) {
    impls[k].group.visible = false;
    group.add(impls[k].group);
  }

  let leagueKind: HazardKind | null = null;
  let forced: HazardKind | 'none' | null = null;
  let shown: HazardKind | null = null;
  let running = false;
  let time = 0;
  let announced = false;
  ctx.events.on('game:started', () => { announced = false; });

  const current = (): HazardKind | null => (forced === 'none' ? null : forced ?? leagueKind);
  const show = (k: HazardKind | null) => {
    if (k === shown) return;
    if (shown) {
      impls[shown].reset(5);
      impls[shown].group.visible = false;
    }
    shown = k;
    running = false;
    if (k) {
      impls[k].reset(5);
      impls[k].group.visible = true;
    }
  };

  const api: Hazards = {
    group,
    get kind() { return current(); },
    get active() { return running; },
    get phase() { return shown ? impls[shown].phase : 'off'; },
    get safeRadius() { return running && shown ? impls[shown].safeRadius?.() ?? Infinity : Infinity; },
    enabled: true,
    alwaysOn: false,
    force(kind) {
      forced = kind;
      show(current());
    },
    trigger(index) {
      if (shown) impls[shown].trigger(index);
    },
    setLeague(ls) {
      leagueKind = hazardForLeague(ls.id);
      for (const k of Object.keys(impls) as HazardKind[]) impls[k].setLeague(ls);
      show(current());
    },
    update(dt) {
      const k = api.enabled ? current() : null;
      show(k);
      if (!k) return;
      const impl = impls[k];
      const paused = ctx.hud ? ctx.hud.screen !== 'none' : false;
      if (paused && !api.alwaysOn) return; // freeze in place
      const phase = ctx.rounds?.state?.phase;
      const inRound = phase === 'wave' || phase === 'boss';
      const live = inRound || api.alwaysOn;
      if (!live) {
        if (running) impl.reset(5);
        running = false;
        return;
      }
      if (!running) {
        running = true;
        impl.reset(api.alwaysOn ? 1 : 5);
        if (!announced && inRound) {
          announced = true;
          ctx.events.emit('ui:message', { text: `ARENA HAZARD · ${HAZARD_LABEL[k]}`, duration: 3, style: 'warning' });
        }
      }
      time += dt;
      const p = ctx.player && ctx.player.alive ? ctx.player : null;
      impl.step(dt, time, p);
    },
  };
  return api;
}
