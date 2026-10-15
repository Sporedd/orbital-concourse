/**
 * Armour kit: the shared plate vocabulary of every enemy (the trooper armour the user picked
 * from docs/concepts/C-brutalist.png).
 *
 * A Kit records pivots and pieces (chamfered plates, undersuit limbs, glow slits) and bakes them
 * into ONE merged geometry per (pivot, material slot). Plates carry their tone as vertex colour:
 * the main faces get the plate colour, the 45° chamfers a lighter worn-edge colour (the light
 * draws the edges, no outlines), undersuit pieces a matte black rubber. So a whole limb segment
 * is one draw call on one toon material, and the blueprint is built once per enemy kind and
 * shared by every instance (only the materials are per enemy, for hit flash and tints).
 *
 * Local space: feet at y=0, facing +Z, +X is the enemy's left.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];
/** Material slots: armour (toon, vertex colours), glow (orange visor/slits), hot (THREAT red glow), accent (toon + THREAT emissive, blinks/pulses). */
export type Slot = 'armour' | 'glow' | 'hot' | 'accent';
export const SLOTS: readonly Slot[] = ['armour', 'glow', 'hot', 'accent'];

/**
 * Tones (sRGB): [face, worn edge]. Desaturated olive-grey/gunmetal green plates (chroma ≤ 11 %: the
 * warm fill, sodium light and the grade's low-light desaturation pull them back to olive-grey),
 * a lighter worn edge on every chamfer, matte black rubber undersuit.
 */
export const TONES = {
  /** main plate */
  plate: [0x313f2c, 0x475641],
  /** pauldrons, crest, top plates (catch the light first) */
  lit: [0x3b4a36, 0x52624b],
  /** lower / back plates, boots */
  dark: [0x222a1f, 0x343e31],
  /** undersuit: matte black rubber at neck, elbows, hips, knees */
  suit: [0x0f110e, 0x1b1e19],
  /** visor housing, recesses */
  black: [0x080908, 0x171816],
  /** gunmetal: blades, barrels, pistons */
  steel: [0x24272a, 0x444a50],
  /** small hazard-paint threat marks (non-emissive) */
  hazard: [0x8a6c16, 0xa88a24],
  /** white: glow/accent pieces (vertex colour = brightness multiplier) */
  white: [0xffffff, 0xffffff],
} as const satisfies Record<string, readonly [number, number]>;
export type Tone = keyof typeof TONES;

interface PivotDef {
  name: string;
  parent: string;
  pos: V3;
  rot?: V3;
  shadow: boolean;
}

export interface BlueprintMesh {
  pivot: string;
  slot: Slot;
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  /**
   * Glow LOD: 'near' meshes hold the thin slits, 'far' the same slits thickened to stay at least
   * a pixel tall at 30 m (no MSAA: a 1.5 cm slit is sub-pixel there and would vanish). One of
   * the two is visible at a time (updateGlowLod in models.ts). Undefined = always visible.
   */
  lod?: 'near' | 'far';
}

export interface Blueprint {
  pivots: readonly PivotDef[];
  meshes: readonly BlueprintMesh[];
  /** Named empty nodes (projectile origins, ...): name → [pivot, position]. */
  nodes: Readonly<Record<string, { pivot: string; pos: V3 }>>;
  /** triangles drawn at a time (far glow LODs replace their near twins, so they are not added) */
  triangles: number;
}

/** Far glow LOD: thin glow pieces grow to at least this half size (rig units). */
export const FAR_GLOW_MIN_HALF = 0.024;
/** Brightness of a near slit relative to its far twin (the material is set for the far one). */
export const NEAR_GLOW_K = 0.7;

export interface PlateOpts {
  /** centre (pivot space) */
  at: V3;
  /** half extents */
  size: V3;
  rot?: V3;
  /** chamfer (m); default 30 % of the smallest half extent; 0 = plain box */
  c?: number;
  tone?: Tone;
  slot?: Slot;
  /** scale of x / z at the top (+t) and bottom (-t): x *= 1 + taper[0]·t (t = y/hy) */
  taper?: [number, number];
  /** z offset at the top (and -shear at the bottom), metres: leans the plate forward */
  shear?: number;
  /** x offset at the top (and minus at the bottom), metres */
  shearX?: number;
  /** brightness multiplier on the vertex colour (glow pieces: < 1 is dimmer than the visor) */
  k?: number;
  /** Euler order of rot (default XYZ; YXZ = tilt about local X, then turn about Y) */
  order?: THREE.EulerOrder;
  /** glow pieces: also add a thickened far-LOD twin (default true; tiny marks skip it) */
  far?: boolean;
}

export interface LimbOpts {
  /** top centre (pivot space); the limb runs down -Y from here before rot */
  at: V3;
  len: number;
  r0: number;
  r1: number;
  sides?: number;
  rot?: V3;
  tone?: Tone;
  slot?: Slot;
  /** squash the cross-section in z (1 = round) */
  zs?: number;
  /** end caps (default true; undersuit limbs bury their ends in plates and skip them) */
  caps?: boolean;
}

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();

interface Buf { pos: number[]; nrm: number[]; col: number[] }

function matrixOf(at: V3, rot?: V3, order: THREE.EulerOrder = 'XYZ'): THREE.Matrix4 {
  _e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, order);
  _q.setFromEuler(_e);
  return _m.compose(_v.set(at[0], at[1], at[2]), _q, _w.set(1, 1, 1));
}

/** Linear rgb of an sRGB hex, times k. */
function lin(hex: number, k: number): [number, number, number] {
  _c.setHex(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}

export class Kit {
  private readonly pivotDefs: PivotDef[] = [];
  private readonly bufs = new Map<string, Buf>();
  private readonly nodeDefs: Record<string, { pivot: string; pos: V3 }> = {};

  /** Declare a pivot (parent 'root' or another pivot). 'body' is the torso pivot (rig.body). */
  pivot(name: string, parent: string, pos: V3, rot?: V3, shadow = false): this {
    this.pivotDefs.push({ name, parent, pos, rot, shadow });
    return this;
  }

  node(name: string, pivot: string, pos: V3): this {
    this.nodeDefs[name] = { pivot, pos };
    return this;
  }

  /** keys whose far glow differs from the near one */
  private readonly enlarged = new Set<string>();

  private buf(pivot: string, slot: Slot, far = false): Buf {
    const key = `${pivot}|${slot}|${far ? 'far' : ''}`;
    let b = this.bufs.get(key);
    if (!b) {
      b = { pos: [], nrm: [], col: [] };
      this.bufs.set(key, b);
    }
    return b;
  }

  /** A chamfered (optionally tapered / sheared) box: 44 tris, worn-edge colour on the chamfers. */
  plate(pivot: string, o: PlateOpts): this {
    const slot = o.slot ?? 'armour';
    const lod = (slot === 'glow' || slot === 'hot') && o.far !== false;
    // with a far twin, the near slit runs a step dimmer: up close it should be a sharp line, not a bloom blob
    this.plateImpl(pivot, lod ? { ...o, k: (o.k ?? 1) * NEAR_GLOW_K } : o, false);
    if (lod) {
      const m = FAR_GLOW_MIN_HALF;
      const far: V3 = [Math.max(o.size[0], m), Math.max(o.size[1], m), Math.max(o.size[2], m)];
      if (far.some((v, i) => v !== o.size[i])) this.enlarged.add(`${pivot}|${slot}|`);
      this.plateImpl(pivot, { ...o, size: far, c: 0 }, true);
    }
    return this;
  }

  private plateImpl(pivot: string, o: PlateOpts, far: boolean): void {
    const [hx, hy, hz] = o.size;
    const minH = Math.min(hx, hy, hz);
    const c = Math.min(o.c ?? minH * 0.3, minH * 0.95);
    const slot = o.slot ?? 'armour';
    const tone = TONES[o.tone ?? (slot === 'armour' ? 'plate' : 'white')];
    const k = o.k ?? 1;
    const face = lin(tone[0], k);
    const edge = lin(tone[1], k);
    const tx = o.taper?.[0] ?? 0;
    const tz = o.taper?.[1] ?? 0;
    const sh = o.shear ?? 0;
    const shx = o.shearX ?? 0;
    const h: V3 = [hx, hy, hz];
    // P(axis, signs): the point of corner `s` on the face normal to `axis`
    const P = (axis: number, s: V3): V3 => {
      const p: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) p[a] = s[a] * (a === axis ? h[a] : h[a] - c);
      const t = p[1] / hy;
      return [p[0] * (1 + tx * t) + shx * t, p[1], p[2] * (1 + tz * t) + sh * t];
    };
    const tris: Array<[V3, V3, V3, [number, number, number]]> = [];
    const quad = (a: V3, b: V3, cc: V3, d: V3, col: [number, number, number]) => {
      tris.push([a, b, cc, col], [a, cc, d, col]);
    };
    const S = [-1, 1];
    if (c <= 1e-6) {
      // plain box: main faces only
      for (let axis = 0; axis < 3; axis++) {
        const b1 = (axis + 1) % 3;
        const b2 = (axis + 2) % 3;
        for (const sg of S) {
          const corner = (u: number, v: number): V3 => {
            const s: V3 = [0, 0, 0];
            s[axis] = sg;
            s[b1] = u;
            s[b2] = v;
            return P(axis, s);
          };
          quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), face);
        }
      }
    } else {
      for (let axis = 0; axis < 3; axis++) {
        const b1 = (axis + 1) % 3;
        const b2 = (axis + 2) % 3;
        for (const sg of S) {
          const corner = (u: number, v: number): V3 => {
            const s: V3 = [0, 0, 0];
            s[axis] = sg;
            s[b1] = u;
            s[b2] = v;
            return P(axis, s);
          };
          quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), face);
        }
        // edge faces between `axis` and `b1` (each axis pair once)
        for (const sa of S) {
          for (const sb of S) {
            const s0: V3 = [0, 0, 0];
            const s1: V3 = [0, 0, 0];
            s0[axis] = s1[axis] = sa;
            s0[b1] = s1[b1] = sb;
            s0[b2] = -1;
            s1[b2] = 1;
            quad(P(axis, s0), P(b1, s0), P(b1, s1), P(axis, s1), edge);
          }
        }
      }
      for (const sx of S) for (const sy of S) for (const sz of S) {
        const s: V3 = [sx, sy, sz];
        tris.push([P(0, s), P(1, s), P(2, s), edge]);
      }
    }
    // orient every triangle outward (the deformed box is still convex)
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const t of tris) for (let i = 0; i < 3; i++) {
      cx += t[i][0]; cy += t[i][1]; cz += t[i][2]; n++;
    }
    cx /= n; cy /= n; cz /= n;
    const b = this.buf(pivot, slot, far);
    const m = matrixOf(o.at, o.rot, o.order);
    _n.getNormalMatrix(m);
    const a = new THREE.Vector3(), bb = new THREE.Vector3(), cc = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();
    for (const t of tris) {
      a.set(...t[0]); bb.set(...t[1]); cc.set(...t[2]);
      nn.crossVectors(e1.subVectors(bb, a), e2.subVectors(cc, a));
      if (nn.lengthSq() < 1e-14) continue; // degenerate (zero chamfer on a thin axis)
      const mx = (a.x + bb.x + cc.x) / 3 - cx, my = (a.y + bb.y + cc.y) / 3 - cy, mz = (a.z + bb.z + cc.z) / 3 - cz;
      if (nn.x * mx + nn.y * my + nn.z * mz < 0) {
        const tmp = bb.clone();
        bb.copy(cc);
        cc.copy(tmp);
        nn.negate();
      }
      nn.normalize().applyMatrix3(_n).normalize();
      for (const p of [a, bb, cc]) {
        p.applyMatrix4(m);
        b.pos.push(p.x, p.y, p.z);
        b.nrm.push(nn.x, nn.y, nn.z);
        b.col.push(t[3][0], t[3][1], t[3][2]);
      }
    }
  }

  /** Mirrored pair of plates (x negated, rot y/z negated) for sx = -1 and +1. */
  pair(pivotOf: (sx: number) => string, o: PlateOpts): this {
    for (const sx of [-1, 1]) {
      this.plate(pivotOf(sx), {
        ...o,
        at: [o.at[0] * sx, o.at[1], o.at[2]],
        rot: o.rot ? [o.rot[0], o.rot[1] * sx, o.rot[2] * sx] : undefined,
        shearX: o.shearX !== undefined ? o.shearX * sx : undefined,
      });
    }
    return this;
  }

  /** Tapered faceted cylinder (undersuit limbs, tanks, barrels), smooth sides. Glow/accent slots take tone 'white'. */
  limb(pivot: string, o: LimbOpts): this {
    const sides = o.sides ?? 6;
    const slot = o.slot ?? 'armour';
    const tone = TONES[o.tone ?? (slot === 'armour' ? 'suit' : 'white')];
    const col = lin(tone[0], 1);
    const capCol = lin(tone[1], 1);
    const zs = o.zs ?? 1;
    const m = matrixOf(o.at, o.rot);
    _n.getNormalMatrix(m);
    const bufs = slot === 'glow' || slot === 'hot' ? [this.buf(pivot, slot), this.buf(pivot, slot, true)] : [this.buf(pivot, slot)];
    const ring = (r: number, y: number, i: number): THREE.Vector3 => {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r * zs);
    };
    const nrm = (i: number): THREE.Vector3 => {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      const slope = (o.r1 - o.r0) / o.len;
      return new THREE.Vector3(Math.cos(a), -slope, (Math.sin(a)) / zs).normalize();
    };
    // tris: [p0, n0, p1, n1, p2, n2, colour]; wound outward against the frustum centre
    const center = new THREE.Vector3(0, -o.len / 2, 0);
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), gn = new THREE.Vector3(), mid = new THREE.Vector3();
    const tri = (
      p0: THREE.Vector3, n0: THREE.Vector3, p1: THREE.Vector3, n1: THREE.Vector3, p2: THREE.Vector3, n2: THREE.Vector3,
      c: [number, number, number],
    ) => {
      gn.crossVectors(e1.subVectors(p1, p0), e2.subVectors(p2, p0));
      mid.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3).sub(center);
      const verts = gn.dot(mid) < 0 ? [[p0, n0], [p2, n2], [p1, n1]] : [[p0, n0], [p1, n1], [p2, n2]];
      for (const [p, n] of verts) {
        const q = p.clone().applyMatrix4(m);
        const nn = n.clone().applyMatrix3(_n).normalize();
        for (const b of bufs) {
          b.pos.push(q.x, q.y, q.z);
          b.nrm.push(nn.x, nn.y, nn.z);
          b.col.push(c[0], c[1], c[2]);
        }
      }
    };
    const up = new THREE.Vector3(0, 1, 0);
    const dn = new THREE.Vector3(0, -1, 0);
    const top = new THREE.Vector3(0, 0, 0);
    const bot = new THREE.Vector3(0, -o.len, 0);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const t0 = ring(o.r0, 0, i), t1 = ring(o.r0, 0, j), b0 = ring(o.r1, -o.len, i), b1 = ring(o.r1, -o.len, j);
      tri(t0, nrm(i), t1, nrm(j), b1, nrm(j), col);
      tri(t0, nrm(i), b1, nrm(j), b0, nrm(i), col);
      if (o.caps !== false) {
        tri(top, up, t1, up, t0, up, capCol);
        tri(bot, dn, b0, dn, b1, dn, capCol);
      }
    }
    return this;
  }

  bake(): Blueprint {
    const meshes: BlueprintMesh[] = [];
    let triangles = 0;
    const shadowOf = new Map(this.pivotDefs.map((p) => [p.name, p.shadow]));
    for (const [key, b] of this.bufs) {
      if (!b.pos.length) continue;
      const [pivot, slot, farTag] = key.split('|') as [string, Slot, string];
      const far = farTag === 'far';
      const nearKey = `${pivot}|${slot}|`;
      const hasLod = this.enlarged.has(nearKey);
      if (far && !hasLod) continue; // nothing thickened: the near mesh serves every distance
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      if (!far) triangles += b.pos.length / 9;
      meshes.push({
        pivot, slot, geometry: g, castShadow: slot === 'armour' && (shadowOf.get(pivot) ?? false),
        lod: hasLod ? (far ? 'far' : 'near') : undefined,
      });
    }
    return { pivots: this.pivotDefs.slice(), meshes, nodes: { ...this.nodeDefs }, triangles };
  }
}

const blueprints = new Map<string, Blueprint>();
/** Build a kind's blueprint once; every later instance shares its geometries. */
export function blueprint(key: string, make: () => Blueprint): Blueprint {
  let bp = blueprints.get(key);
  if (!bp) {
    bp = make();
    blueprints.set(key, bp);
  }
  return bp;
}

// ---- the trooper ------------------------------------------------------------------------

export interface TrooperOpts {
  /** overall scale (1 = grunt, 1.85 m) */
  s: number;
  /** bulk: multiplies widths and depths of the torso and limbs */
  w?: number;
  /** extra plate tiers (0 mobs, 1–2 bosses): stacked pauldrons, gorget, tassets, double shins */
  tiers?: number;
  /** crest size multiplier */
  crest?: number;
  /** visor slit width multiplier (1.0 = front only, 1.5+ wraps toward the cheeks) */
  visor?: number;
  /** false: no legs (floating summoner); the torso still gets hip plates */
  legs?: boolean;
  /** chest chevron size multiplier (0 = none) */
  chevrons?: number;
  /** forearm bracer length multiplier */
  forearm?: number;
  /** small orange status marks on one forearm and one thigh */
  marks?: boolean;
  /** brightness multipliers (vertex colour on the glow material) */
  chestK?: number;
  markK?: number;
  /** raise the body pivot (m, rig units): the floating summoner */
  lift?: number;
}

export interface HelmetOpts {
  s: number;
  w?: number;
  crest?: number;
  visor?: number;
  /** visor brightness (vertex colour on the glow material) */
  visorK?: number;
}

/**
 * Angular full-face helmet around the pivot origin (= head centre): no face, a crest fin
 * front-to-back, a swept-back skull, a black face plate with a narrow glowing visor slit.
 */
export function helmet(k: Kit, pivot: string, o: HelmetOpts): void {
  const s = o.s;
  const w = o.w ?? 1;
  const crest = o.crest ?? 1;
  const visor = o.visor ?? 1;
  const P = (x: number, y: number, z: number): V3 => [x * s * w, y * s, z * s * Math.sqrt(w)];
  const H = P;
  const L = (v: number) => v * s;
  const R = (v: number) => v * s * w;
  const Hd = pivot;
  k.limb(Hd, { at: [0, L(-0.05), L(-0.01)], len: L(0.08), r0: R(0.05), r1: R(0.05), tone: 'suit', caps: false });
  k.plate(Hd, { at: P(0, 0.02, -0.005), size: H(0.088, 0.095, 0.1), c: L(0.05), taper: [0.16, 0.06], tone: 'plate' });
  // swept-back skull
  k.plate(Hd, { at: P(0, 0.055, -0.07), size: H(0.076, 0.065, 0.088), c: L(0.048), rot: [-0.42, 0, 0], taper: [-0.1, 0], tone: 'plate' });
  // black visor band, brow ridge over it
  k.plate(Hd, { at: P(0, 0.016, 0.092), size: H(0.08, 0.02, 0.028), c: L(0.01), taper: [0.05, 0], tone: 'black' });
  k.plate(Hd, { at: P(0, 0.048, 0.094), size: H(0.084, 0.014, 0.03), c: L(0.012), rot: [0.35, 0, 0], tone: 'lit' });
  // angular face guard: two plates meeting in a forward ridge, narrowing to the chin
  for (const sx of [-1, 1]) {
    k.plate(Hd, {
      at: P(0.036 * sx, -0.032, 0.09), size: H(0.042, 0.036, 0.018), c: L(0.012), rot: [0.12, 0.42 * sx, 0],
      taper: [0.25, 0], shearX: L(0.012 * sx), tone: 'lit',
    });
  }
  k.plate(Hd, { at: P(0, -0.075, 0.075), size: H(0.03, 0.02, 0.03), c: L(0.012), taper: [0.4, 0.2], tone: 'plate' });
  // cheek plates
  for (const sx of [-1, 1]) k.plate(Hd, { at: P(0.086 * sx, -0.01, 0.025), size: H(0.018, 0.058, 0.06), c: L(0.014), rot: [0, -0.25 * sx, 0], tone: 'dark' });
  // crest: a raised fin front-to-back over the top, rising toward the back, on a dark base
  k.plate(Hd, { at: P(0, 0.112, -0.01), size: [L(0.02), L(0.012), L(0.1)], c: L(0.008), rot: [-0.12, 0, 0], tone: 'dark' });
  k.plate(Hd, {
    at: P(0, 0.135 + 0.012 * (crest - 1), -0.025), size: [L(0.011 + 0.004 * (crest - 1)), L(0.034 * crest), L(0.115 + 0.025 * (crest - 1))],
    c: L(0.008), rot: [-0.2, 0, 0], taper: [0, -0.3], shear: L(-0.025), tone: 'lit',
  });
  // visor slit
  const vk = o.visorK ?? 1;
  k.plate(Hd, { at: P(0, 0.015, 0.119), size: [L(0.055 * visor) * w, L(0.0075), L(0.005)], c: 0, slot: 'glow', k: vk });
  if (visor > 1.2) {
    // wrap-around ends angled back along the cheeks
    for (const sx of [-1, 1]) {
      k.plate(Hd, { at: P(0.07 * sx, 0.015, 0.1), size: [L(0.022), L(0.0065), L(0.005)], c: 0, rot: [0, 0.6 * sx, 0], slot: 'glow', k: 0.85 * vk });
    }
  }
}

/** Proportions of the 1.85 m trooper (grunt units, multiplied by s). */
export const TROOPER = {
  hipY: 0.94,
  hipX: 0.105,
  thigh: 0.45,
  shoulderY: 0.53,
  shoulderX: 0.215,
  upperArm: 0.29,
  headY: 0.74,
} as const;

/**
 * The shared trooper body: pivots leg0/leg1 (+ knee0/knee1), body, head, arm0/arm1
 * (+ elbow0/elbow1). Index 0 is the sx = -1 side (the enemy's right).
 */
export function trooper(k: Kit, o: TrooperOpts): void {
  const s = o.s;
  const w = o.w ?? 1;
  const tiers = o.tiers ?? 0;
  const crest = o.crest ?? 1;
  const visor = o.visor ?? 1;
  const legs = o.legs ?? true;
  const chev = o.chevrons ?? 1;
  const fa = o.forearm ?? 1;
  const marks = o.marks ?? true;
  const chestK = o.chestK ?? 0.65;
  const markK = o.markK ?? 0.5;
  /** position: x scaled by bulk */
  const P = (x: number, y: number, z: number): V3 => [x * s * w, y * s, z * s * Math.sqrt(w)];
  /** half size */
  const H = (x: number, y: number, z: number): V3 => [x * s * w, y * s, z * s * Math.sqrt(w)];
  const L = (v: number) => v * s;
  const R = (v: number) => v * s * w;
  const SX = [-1, 1] as const;
  const idx = (sx: number) => (sx < 0 ? 0 : 1);

  // ---- pivots
  k.pivot('body', 'root', [0, L(TROOPER.hipY) + (o.lift ?? 0), 0], undefined, true);
  if (legs) {
    for (const sx of SX) {
      const i = idx(sx);
      k.pivot(`leg${i}`, 'root', [TROOPER.hipX * sx * s * w, L(TROOPER.hipY), 0], undefined, true);
      k.pivot(`knee${i}`, `leg${i}`, [0, -L(TROOPER.thigh), 0], [0.12, 0, 0], true);
    }
  }
  k.pivot('head', 'body', [0, L(TROOPER.headY), L(0.015)], undefined, false);
  for (const sx of SX) {
    const i = idx(sx);
    k.pivot(`arm${i}`, 'body', [TROOPER.shoulderX * sx * s * w, L(TROOPER.shoulderY), 0], [0, 0, 0.08 * sx], true);
    k.pivot(`elbow${i}`, `arm${i}`, [0, -L(TROOPER.upperArm), 0], [-0.35, 0, 0], false);
  }

  // ---- legs
  if (legs) {
    for (const sx of SX) {
      const i = idx(sx);
      const leg = `leg${i}`;
      const knee = `knee${i}`;
      k.limb(leg, { at: [0, L(0.02), 0], len: L(0.47), r0: R(0.085), r1: R(0.062), caps: false });
      // thigh plate (front-outer), tapering to the knee
      k.plate(leg, { at: P(0.012 * sx, -0.21, 0.03), size: H(0.07, 0.165, 0.06), c: L(0.045), taper: [0.25, 0.15], tone: 'plate' });
      // outer thigh shell
      k.plate(leg, { at: P(0.06 * sx, -0.17, -0.005), size: H(0.03, 0.13, 0.07), c: L(0.025), taper: [0.2, 0.2], rot: [0, 0, 0.05 * sx], tone: 'dark' });
      // hip plate flaring out over the joint
      k.plate(leg, { at: P(0.055 * sx, -0.015, 0.0), size: H(0.065, 0.055, 0.095), c: L(0.042), taper: [-0.2, -0.1], rot: [0, 0, 0.32 * sx], tone: 'lit' });
      if (marks && sx > 0) {
        k.plate(leg, { at: P(0.035, -0.13, 0.092), size: H(0.02, 0.005, 0.006), c: 0, slot: 'glow', k: markK, far: false });
        k.plate(leg, { at: P(0.035, -0.152, 0.091), size: H(0.02, 0.005, 0.006), c: 0, slot: 'glow', k: markK, far: false });
      }
      // knee cap
      k.plate(knee, { at: P(0, 0.005, 0.062), size: H(0.05, 0.055, 0.04), c: L(0.036), tone: 'lit' });
      k.limb(knee, { at: [0, L(0.03), 0], len: L(0.44), r0: R(0.062), r1: R(0.044), caps: false });
      // shin guard, leaning forward, narrower at the ankle
      k.plate(knee, { at: P(0, -0.2, 0.04), size: H(0.055, 0.15, 0.044), c: L(0.036), taper: [0.22, 0.1], shear: L(0.008), tone: 'plate' });
      k.plate(knee, { at: P(0, -0.16, -0.035), size: H(0.048, 0.11, 0.035), c: L(0.028), taper: [0.2, 0.2], tone: 'dark' });
      if (tiers >= 1) {
        // heavy legs: a second thigh shell, outer shin plate, bigger boots
        k.plate(leg, { at: P(0.035 * sx, -0.27, 0.05), size: H(0.06, 0.08, 0.05), c: L(0.035), rot: [0.1, 0, 0], tone: 'lit' });
        k.plate(knee, { at: P(0.048 * sx, -0.18, 0.012), size: H(0.022, 0.13, 0.055), c: L(0.016), tone: 'lit' });
        k.plate(knee, { at: P(0, -0.4, 0.03), size: H(0.07, 0.04, 0.12), c: L(0.03), tone: 'plate' });
      }
      // boot + toe cap; sole at y = 0
      k.plate(knee, { at: P(0, -0.445, 0.03), size: H(0.058, 0.045, 0.115), c: L(0.032), taper: [-0.15, 0], tone: 'dark' });
      k.plate(knee, { at: P(0, -0.455, 0.115), size: H(0.052, 0.035, 0.045), c: L(0.03), tone: 'plate' });
    }
  }

  // ---- torso
  const B = 'body';
  // pelvis + undersuit core
  k.plate(B, { at: P(0, 0.02, 0), size: H(0.13, 0.08, 0.1), c: 0, tone: 'suit' });
  k.plate(B, { at: P(0, 0.27, -0.005), size: H(0.12, 0.18, 0.09), c: 0, taper: [0.15, 0], tone: 'suit' });
  // groin plate (V)
  k.plate(B, { at: P(0, -0.015, 0.09), size: H(0.062, 0.065, 0.025), c: L(0.022), taper: [0.4, 0], tone: 'plate' });
  // abdomen segments
  for (let j = 0; j < 3; j++) {
    const y = 0.11 + j * 0.065;
    k.plate(B, { at: P(0, y, 0.035 + j * 0.008), size: H(0.096 + j * 0.012, 0.026, 0.082), c: L(0.024), tone: j === 2 ? 'plate' : 'dark' });
  }
  // chest: two pectoral shells over a dark core, a seam down the middle
  k.plate(B, { at: P(0, 0.45, -0.01), size: H(0.16, 0.13, 0.1), c: 0, tone: 'suit' });
  for (const sx of SX) {
    k.plate(B, {
      at: P(0.092 * sx, 0.46, 0.055), size: H(0.096, 0.115, 0.075), c: L(0.055),
      rot: [-0.08, 0.22 * sx, 0.06 * sx], taper: [0.22, 0.12], tone: 'plate',
    });
  }
  // lower ribs (wrap under the pecs)
  // back plate + pack
  k.plate(B, { at: P(0, 0.45, -0.105), size: H(0.16, 0.13, 0.05), c: L(0.04), taper: [0.2, 0], tone: 'dark' });
  k.plate(B, { at: P(0, 0.4, -0.165), size: H(0.09, 0.1, 0.045), c: L(0.035), tone: 'dark' });
  // gorget / neck (undersuit shows)
  k.limb(B, { at: [0, L(0.67), L(0.01)], len: L(0.1), r0: R(0.048), r1: R(0.06), tone: 'suit', caps: false });
  k.plate(B, { at: P(0, 0.585, -0.02), size: H(0.11, 0.035, 0.085), c: L(0.02), tone: 'dark' });
  // chest chevrons: two short glowing slits on the upper chest plates
  if (chev > 0) {
    for (const sx of SX) {
      k.plate(B, {
        at: P(0.075 * sx, 0.505, 0.133), size: [L(0.033 * chev) * w, L(0.0055 * Math.sqrt(chev)), L(0.006)], c: 0,
        rot: [-0.08, 0.2 * sx, -0.42 * sx], slot: 'glow', k: chestK,
      });
    }
  }
  if (tiers >= 1) {
    // gorget collar plates and tassets
    for (const sx of SX) k.plate(B, { at: P(0.1 * sx, 0.6, 0.0), size: H(0.06, 0.05, 0.09), c: L(0.02), rot: [0, 0, 0.5 * sx], tone: 'lit' });
    k.plate(B, { at: P(0, -0.08, 0.1), size: H(0.08, 0.07, 0.02), c: L(0.012), rot: [-0.15, 0, 0], tone: 'dark' });
    k.plate(B, { at: P(0, -0.06, -0.11), size: H(0.11, 0.07, 0.02), c: L(0.012), rot: [0.18, 0, 0], tone: 'dark' });
  }
  if (tiers >= 2) {
    // sternum overlay + back power stack
    k.plate(B, { at: P(0, 0.4, 0.13), size: H(0.06, 0.08, 0.03), c: L(0.02), taper: [-0.3, 0], tone: 'lit' });
    for (const sx of SX) k.plate(B, { at: P(0.07 * sx, 0.55, -0.2), size: H(0.035, 0.1, 0.035), c: L(0.012), tone: 'steel' });
  }

  // ---- head
  helmet(k, 'head', { s, w, crest, visor });

  // ---- arms
  for (const sx of SX) {
    const i = idx(sx);
    const arm = `arm${i}`;
    const el = `elbow${i}`;
    // big rounded pauldron, then a second band under it
    k.plate(arm, { at: P(0.035 * sx, 0.03, 0), size: H(0.098, 0.07, 0.105), c: L(0.066), rot: [0, 0, -0.32 * sx], taper: [-0.2, -0.12], tone: 'lit' });
    k.plate(arm, { at: P(0.07 * sx, -0.045, 0), size: H(0.068, 0.034, 0.09), c: L(0.032), rot: [0, 0, -0.45 * sx], tone: 'plate' });
    if (tiers >= 1) k.plate(arm, { at: P(0.04 * sx, 0.095, -0.005), size: H(0.07, 0.03, 0.085), c: L(0.025), rot: [0, 0, -0.25 * sx], tone: 'plate' });
    if (tiers >= 2) k.plate(arm, { at: P(0.09 * sx, -0.1, 0), size: H(0.05, 0.03, 0.075), c: L(0.018), rot: [0, 0, -0.55 * sx], tone: 'dark' });
    k.limb(arm, { at: [0, L(-0.02), 0], len: L(0.28), r0: R(0.052), r1: R(0.045), caps: false });
    k.plate(arm, { at: P(0.012 * sx, -0.175, 0.008), size: H(0.046, 0.075, 0.048), c: L(0.036), taper: [0.12, 0.1], tone: 'plate' });
    // elbow joint (rubber), forearm, bracer flaring toward the elbow, glove
    k.plate(el, { at: P(0, 0, 0), size: H(0.042, 0.04, 0.042), c: 0, rot: [0, Math.PI / 4, 0], tone: 'suit' });
    k.limb(el, { at: [0, L(-0.01), 0], len: L(0.25 * fa), r0: R(0.046), r1: R(0.038), caps: false });
    k.plate(el, { at: P(0.004 * sx, -0.125 * fa, 0.004), size: H(0.048, 0.095 * fa, 0.048), c: L(0.032), taper: [0.22, 0.15], tone: 'plate' });
    k.plate(el, { at: P(0, -0.025, -0.04), size: H(0.035, 0.03, 0.022), c: L(0.01), tone: 'dark' });
    if (marks && sx < 0) {
      for (let j = 0; j < 2; j++) {
        k.plate(el, { at: P(-0.053, -0.09 * fa - j * 0.03, 0.012), size: [L(0.005), L(0.006), L(0.02)], c: 0, slot: 'glow', k: markK, far: false });
      }
    }
    k.plate(el, { at: P(0, -0.25 * fa - 0.045, 0.012), size: H(0.036, 0.048, 0.042), c: L(0.026), tone: 'suit' });
  }
}
