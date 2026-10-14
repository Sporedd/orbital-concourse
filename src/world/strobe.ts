/**
 * Boss entrance floor strobe: THREAT light chasing along the hazard paint, out of the boss
 * gate around the striped ring (both ways) and down a chevron lane to the plinth. One
 * additive mesh; every vertex carries its path distance from the gate (metres) and the
 * shader lights repeating bands that run away from the gate, with a hard strobe on top.
 */
import * as THREE from 'three';
import { PALETTE, glowLum } from '@/rendering/style';

const vert = /* glsl */ `
attribute float aS;
varying float vS;
void main() {
  vS = aS;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uHead;
uniform float uStrobe;
varying float vS;
void main() {
  float behind = uHead - vS;
  if ( behind < 0.0 ) discard; // the front has not reached this piece yet
  float ph = fract( behind / 7.0 );
  float band = smoothstep( 0.0, 0.08, ph ) * ( 1.0 - smoothstep( 0.32, 0.5, ph ) );
  float a = uI * band * uStrobe;
  if ( a <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

export interface FloorStrobe {
  readonly mesh: THREE.Mesh;
  /** Start the chase (seconds). */
  play(seconds: number): void;
  update(dt: number): void;
}

/** `gateDeg`: polar angle of the boss gate. */
export function createFloorStrobe(gateDeg: number): FloorStrobe {
  const pos: number[] = [];
  const sAttr: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, sa: number, sb: number) => {
    // a-b at path distance sa, d-c at sb
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    sAttr.push(sa, sa, sb, sa, sb, sb);
  };
  const y = 0.02;
  const g0 = THREE.MathUtils.degToRad(gateDeg);
  // ring segments over the striped paint ring (r 27.8–28.2), both directions from the gate
  const r0 = 27.75, r1 = 28.25, rm = 28;
  const seg = 72;
  for (const dirSign of [-1, 1]) {
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI;
      const t1 = ((i + 0.62) / seg) * Math.PI; // gaps between segments
      const a0 = g0 + dirSign * t0;
      const a1 = g0 + dirSign * t1;
      const p = (a: number, r: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      quad(p(a0, r0), p(a0, r1), p(a1, r1), p(a1, r0), t0 * rm + 2.5, t1 * rm + 2.5);
    }
  }
  // chevron lane from the gate (r 27) to the plinth edge (r 5.6): V shapes pointing inward
  const out = new THREE.Vector3(Math.cos(g0), 0, Math.sin(g0));
  const side = new THREE.Vector3(-out.z, 0, out.x);
  const n = 14;
  for (let k = 0; k < n; k++) {
    const r = 26.4 - k * ((26.4 - 6.2) / (n - 1));
    const s = 27 - r + 1.5;
    const tip = out.clone().multiplyScalar(r - 0.55).setY(y);
    for (const sg of [-1, 1]) {
      const wing = out.clone().multiplyScalar(r + 0.35).addScaledVector(side, sg * 1.25).setY(y);
      const w = 0.16;
      const dir = new THREE.Vector3().subVectors(wing, tip).normalize();
      const nrm = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(w);
      quad(tip.clone().sub(nrm), tip.clone().add(nrm), wing.clone().add(nrm), wing.clone().sub(nrm), s, s + 0.4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(sAttr, 1));
  const uniforms = {
    uColor: { value: new THREE.Color(PALETTE.THREAT).multiplyScalar(glowLum(PALETTE.THREAT, 1.7, 12)) },
    uI: { value: 0 },
    uHead: { value: 0 },
    uStrobe: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    fog: false,
  });
  mat.userData.noInk = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'world-bossStrobe';
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  mesh.visible = false;

  let t = -1;
  let dur = 0;
  return {
    mesh,
    play(seconds) {
      t = 0;
      dur = seconds;
      mesh.visible = true;
    },
    update(dt) {
      if (t < 0) return;
      t += dt;
      uniforms.uHead.value = t * 20;
      uniforms.uStrobe.value = Math.sin(t * 52) > -0.2 ? 1 : 0.15;
      uniforms.uI.value = Math.min(1, t / 0.15) * (1 - THREE.MathUtils.smoothstep(t, dur - 0.6, dur));
      if (t >= dur) {
        t = -1;
        mesh.visible = false;
        uniforms.uI.value = 0;
      }
    },
  };
}
