/**
 * Pooled particle systems for effects.
 *
 * SparkSystem: one Points object, ring buffer of GPU-integrated particles (position =
 *   start + drag-damped velocity + gravity, all in the vertex shader). Spawning writes a
 *   few floats into the ring buffer; nothing is allocated per particle. Additive (hot
 *   sparks, embers) or normal-blended (grey concrete dust puffs, soft dithered edges).
 * DebrisSystem: one InstancedMesh of small flat-shaded concrete chips with simple CPU
 *   physics (gravity, floor bounce, tumble, shrink-out).
 */
import * as THREE from 'three';
import type { MaterialFactory } from '@/core/types';

const sparkVert = /* glsl */ `
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec4 aTime; // birth, life, gravityScale, drag
attribute float aSize;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aTime.x;
  float k = age / aTime.y;
  if ( age < 0.0 || k >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3( 0.0 );
    return;
  }
  float d = max( aTime.w, 0.001 );
  vec3 p = position + aVel * ( 1.0 - exp( -d * age ) ) / d;
  p.y -= 4.9 * aTime.z * age * age;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float size = aSize * ( 1.0 - k * 0.6 );
  gl_PointSize = clamp( size * uScale / max( -mv.z, 0.05 ), 1.0, 64.0 );
  vColor = aColor;
  vAlpha = 1.0 - k * k;
}
`;

const sparkFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.1, 0.5, d ) ) * vAlpha;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( vColor * a, a );
}
`;

/** Normal-blended dust: soft round sprite, edge dithered (no banding), alpha from colour.a. */
const dustFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.15, 0.5, d + ( ign( gl_FragCoord.xy ) - 0.5 ) * 0.08 ) ) * vAlpha * 0.7;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( vColor, a );
}
`;

export class SparkSystem {
  readonly points: THREE.Points;
  private readonly cap: number;
  private head = 0;
  private time = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private pos: THREE.BufferAttribute;
  private vel: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private tim: THREE.BufferAttribute;
  private siz: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  private attrs: THREE.BufferAttribute[];

  constructor(capacity = 3000, dust = false) {
    this.cap = capacity;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    const t = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      t[i * 4] = -1000;
      t[i * 4 + 1] = 1;
    }
    this.tim = new THREE.BufferAttribute(t, 4);
    this.siz = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.attrs = [this.pos, this.vel, this.col, this.tim, this.siz];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aColor', this.col);
    geo.setAttribute('aTime', this.tim);
    geo.setAttribute('aSize', this.siz);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 } },
      vertexShader: sparkVert,
      fragmentShader: dust ? dustFrag : sparkFrag,
      transparent: true,
      depthWrite: false,
      blending: dust ? THREE.NormalBlending : THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.mat.userData.noInk = true;
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = dust ? 12 : 20;
    this.points.name = dust ? 'fx-dust' : 'fx-sparks';
  }

  setScale(heightPx: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = (heightPx * 0.5) / Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
  }

  /** color components are linear and may exceed 1 (bloom). */
  spawn(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, size: number, gravity = 1, drag = 2,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const p = this.pos.array as Float32Array;
    const v = this.vel.array as Float32Array;
    const c = this.col.array as Float32Array;
    const t = this.tim.array as Float32Array;
    const s = this.siz.array as Float32Array;
    p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    t[i * 4] = this.time; t[i * 4 + 1] = life; t[i * 4 + 2] = gravity; t[i * 4 + 3] = drag;
    s[i] = size;
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  update(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (this.dirtyMax < 0) return;
    const start = this.dirtyMin;
    const count = this.dirtyMax - this.dirtyMin + 1;
    const attrs = this.attrs;
    for (let k = 0; k < attrs.length; k++) {
      const a = attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }
}

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private head = 0;
  private active = 0;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private life: Float32Array; private maxLife: Float32Array; private size: Float32Array;
  private floor: Float32Array; private spin: Float32Array;
  private ax: Float32Array; private ay: Float32Array; private az: Float32Array;
  private alive: Uint8Array;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private c = new THREE.Color();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(materials: MaterialFactory, capacity = 320) {
    this.cap = capacity;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = materials.toon({ color: 0xffffff, surface: 'concrete', mottle: 0.04 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'fx-debris';
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, this.c.set(0xffffff));
    }
    const f = () => new Float32Array(capacity);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f(); this.size = f(); this.floor = f(); this.spin = f();
    this.ax = f(); this.ay = f(); this.az = f();
    this.alive = new Uint8Array(capacity);
  }

  spawn(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    color: number, size: number, life: number, floorY: number, rnd: () => number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (!this.alive[i]) this.active++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.floor[i] = floorY;
    this.spin[i] = 4 + rnd() * 10;
    this.axis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    if (this.axis.lengthSq() < 1e-4) this.axis.set(0, 1, 0);
    this.axis.normalize();
    this.ax[i] = this.axis.x; this.ay[i] = this.axis.y; this.az[i] = this.axis.z;
    this.mesh.setColorAt(i, this.c.setHex(color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.active === 0) return;
    const g = -18;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        this.active--;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      this.vy[i] += g * dt;
      const drag = Math.exp(-1.2 * dt);
      this.vx[i] *= drag; this.vz[i] *= drag;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const r = this.size[i];
      if (this.py[i] < this.floor[i] + r * 0.5) {
        this.py[i] = this.floor[i] + r * 0.5;
        if (this.vy[i] < 0) this.vy[i] *= -0.35;
        this.vx[i] *= 0.6; this.vz[i] *= 0.6;
        this.spin[i] *= 0.7;
      }
      const age = this.maxLife[i] - this.life[i];
      this.axis.set(this.ax[i], this.ay[i], this.az[i]);
      this.q.setFromAxisAngle(this.axis, age * this.spin[i]);
      const k = this.life[i] / this.maxLife[i];
      const sc = r * Math.min(1, k * 4);
      this.s.set(sc, sc, sc);
      this.v.set(this.px[i], this.py[i], this.pz[i]);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
