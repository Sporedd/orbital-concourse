/**
 * Procedural gun models (docs/concepts/E-weapon-sheet.png): chamfered matte-black plates over
 * round steel cylinders, vented shrouds, rails, bolts/rivets, rubber grips with finger grooves,
 * exposed cables, one orange indicator lamp per gun and cyan micro-readouts on the rifle/sniper.
 *
 * A gun is a BLUEPRINT: a few nodes, each one merged BufferGeometry with one group per material
 * SLOT (plate, worn edge, steel, rubber, ...). Bevels on plates/slabs are split into the 'edge'
 * slot automatically, so every chamfer catches the light as a worn highlight. Blueprints are
 * built once per archetype and cached (never disposed); consumers map slots to materials:
 *   - the first-person viewmodel (src/player/viewmodel.ts): 'vm' detail, animated parts are
 *     separate nodes tagged with userData.vmAnim / vmRole (src/player/animations.ts,
 *     src/gear/weaponGrowth.ts) and keep the same rest-pose semantics as before;
 *   - loot icons (src/loot/view.ts) and co-op avatars (src/net/avatar.ts): 'lo' detail, the
 *     whole gun flattened into ONE mesh (no rivets/slots/teeth/cables).
 *
 * Space: metres, the gun points -Z, +Y up, +X right; the camera sees the LEFT side (-X) and the
 * top, so lamps, readouts, cables and the SMG charging knob sit on the left. Origin ≈ the grip.
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponArchetype } from '@/core/types';

// ---- slots / colours ---------------------------------------------------------
export type GunSlot =
  | 'plate' | 'edge' | 'metal' | 'rubber' | 'void' | 'wire'
  | 'accent' | 'lamp' | 'screen' | 'lens' | 'reticle';

/** Draw/merge order (opaque first, then glows, then the transparent lens). */
const SLOT_ORDER: readonly GunSlot[] = ['plate', 'edge', 'metal', 'rubber', 'void', 'wire', 'accent', 'lamp', 'screen', 'reticle', 'lens'];

/** Slot colours (sRGB). `accent` is the rarity/element seam and comes from the weapon. */
export const GUN_COLORS = {
  /** matte black plates */
  plate: 0x2c2f33,
  /** worn edges: bare steel showing through on every chamfer */
  edge: 0x4b5157,
  /** round steel: barrels, bolts, rivets */
  metal: 0x4a5158,
  rubber: 0x1c1d20,
  /** vent slots, bores, grooves, readout text */
  void: 0x09090a,
  /** oxide-red insulated wire */
  wire: 0x5a2a1f,
  /** the one orange indicator lamp */
  lamp: 0xff7a1e,
  /** cyan micro-readouts */
  screen: 0x36e6dc,
  /** holo-sight reticle */
  reticle: 0x7af7ff,
  /** optic glass tint (additive, transparent) */
  lens: 0x1f8c99,
} as const;

/** Target luminances for the glow slots (style.ts LUM tiers). */
export const GUN_LUM = { lamp: 3.0, screen: 1.1, reticle: 2.4, lens: 0.18 } as const;

/** Which slot a bevel of a given slot turns into. */
const EDGE_OF: Partial<Record<GunSlot, GunSlot>> = { plate: 'edge', metal: 'edge' };

// ---- blueprint types ---------------------------------------------------------
export interface GunNode {
  name: string;
  /** Merged geometry, one group per entry of `slots` (materialIndex = index). Shared: never dispose. */
  geometry: THREE.BufferGeometry;
  slots: GunSlot[];
  position: THREE.Vector3;
  rotation: THREE.Euler;
  userData: Record<string, unknown>;
}

export interface GunBlueprint {
  archetype: WeaponArchetype;
  nodes: GunNode[];
  /** Muzzle point (gun space) for flashes/tracers. */
  muzzle: THREE.Vector3;
  /** Height of the sight line (iron sights / optic axis) above the gun origin; x = 0. */
  sightY: number;
  triangles: number;
}

export type GunDetail = 'vm' | 'lo';

type V3 = readonly [number, number, number];
/** Side-profile point: [z, y] in gun space. */
type P2 = readonly [number, number];

const vec = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

// ---- geometry primitives -----------------------------------------------------
/** Keep position + normal only, non-indexed, no groups (so everything merges). */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  g.dispose();
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  out.clearGroups();
  return out;
}

/** Box with every edge chamfered (convex hull of three inset boxes): 44 triangles. */
function bevelBoxGeo(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const cc = Math.max(1e-4, Math.min(c, w * 0.45, h * 0.45, d * 0.45));
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(
          new THREE.Vector3(sx * (hw - cc), sy * (hh - cc), sz * hd),
          new THREE.Vector3(sx * (hw - cc), sy * hh, sz * (hd - cc)),
          new THREE.Vector3(sx * hw, sy * (hh - cc), sz * (hd - cc)),
        );
      }
    }
  }
  return new ConvexGeometry(pts);
}

/**
 * Side profile ([z, y] polygon, optional holes) extruded across x with a 45° chamfer on both
 * faces; the silhouette is exactly the profile.
 */
function slabGeo(profile: readonly P2[], width: number, bevel: number, holes?: readonly (readonly P2[])[]): THREE.BufferGeometry {
  const toV = (p: P2) => new THREE.Vector2(-p[0], p[1]);
  const shape = new THREE.Shape(profile.map(toV));
  for (const h of holes ?? []) shape.holes.push(new THREE.Path(h.map(toV)));
  const bt = Math.max(0, Math.min(bevel, width * 0.3));
  const depth = width - 2 * bt;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bt > 0, bevelThickness: bt, bevelSize: bt, bevelOffset: -bt, bevelSegments: 1, steps: 1, curveSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2); // shape x (= -z) -> gun z, extrusion -> gun x
  return g;
}

/**
 * Split a non-indexed geometry by face normal: [faces where test() is false, faces where true].
 */
function splitFaces(g: THREE.BufferGeometry, test: (n: THREE.Vector3) => boolean): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const a: number[][] = [[], []];
  const b: number[][] = [[], []];
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    p0.fromBufferAttribute(pos, i);
    p1.fromBufferAttribute(pos, i + 1);
    p2.fromBufferAttribute(pos, i + 2);
    n.subVectors(p2, p1).cross(p0.clone().sub(p1)).normalize();
    const dst = test(n) ? b : a;
    for (let k = 0; k < 3; k++) {
      dst[0].push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      dst[1].push(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k));
    }
  }
  const make = (d: number[][]) => {
    if (!d[0].length) return null;
    const o = new THREE.BufferGeometry();
    o.setAttribute('position', new THREE.Float32BufferAttribute(d[0], 3));
    o.setAttribute('normal', new THREE.Float32BufferAttribute(d[1], 3));
    return o;
  };
  g.dispose();
  return [make(a), make(b)];
}

/** Box chamfer faces: no normal component close to 1. */
const isBevelOfBox = (n: THREE.Vector3) => Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) < 0.96;
/** Slab chamfer faces: tilted between the side face (±x) and the rim. */
const isBevelOfSlab = (n: THREE.Vector3) => Math.abs(n.x) > 0.2 && Math.abs(n.x) < 0.96;

// ---- the kit -----------------------------------------------------------------
interface Piece { geo: THREE.BufferGeometry; slot: GunSlot }

interface PlaceOpts { slot?: GunSlot; rot?: V3 }

/**
 * Part builder: every call adds transformed, merge-ready pieces. `hi` = viewmodel detail
 * (rivets, slots, rail teeth, cables, readout text); off for loot icons / avatars.
 */
export class GunKit {
  readonly pieces: Piece[] = [];
  constructor(readonly hi: boolean) {}

  private put(g: THREE.BufferGeometry, slot: GunSlot, pos: V3, rot?: V3, bevelTest?: (n: THREE.Vector3) => boolean): void {
    const geo = prep(g);
    const m = new THREE.Matrix4().compose(
      vec(pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0)),
      new THREE.Vector3(1, 1, 1),
    );
    geo.applyMatrix4(m);
    const edge = EDGE_OF[slot];
    if (edge && bevelTest) {
      const [flat, bev] = splitFaces(geo, bevelTest);
      if (flat) this.pieces.push({ geo: flat, slot });
      if (bev) this.pieces.push({ geo: bev, slot: edge });
    } else this.pieces.push({ geo, slot });
  }

  /** Plain box (inlays: slots, seams, screens, text). */
  box(size: V3, pos: V3, slot: GunSlot, rot?: V3): void {
    this.put(new THREE.BoxGeometry(size[0], size[1], size[2]), slot, pos, rot);
  }

  /** Chamfered plate (all 12 edges); the chamfers become worn edges. */
  plate(size: V3, pos: V3, o: PlaceOpts & { c?: number } = {}): void {
    const c = o.c ?? Math.min(size[0], size[1], size[2]) * 0.18;
    this.put(bevelBoxGeo(size[0], size[1], size[2], c), o.slot ?? 'plate', pos, o.rot, isBevelOfBox);
  }

  /** Side profile extruded across x (centred on `x`), chamfered faces. */
  slab(profile: readonly P2[], width: number, o: { x?: number; bevel?: number; slot?: GunSlot; holes?: readonly (readonly P2[])[] } = {}): void {
    this.put(slabGeo(profile, width, o.bevel ?? 0.005, o.holes), o.slot ?? 'plate', [o.x ?? 0, 0, 0], undefined, isBevelOfSlab);
  }

  /**
   * Cylinder along an axis (default z). `rf` = radius at the -axis end (front), default r.
   * `flat` rotates the facets so one sits flat on top (and on the sides for seg % 4 == 0).
   */
  cyl(r: number, len: number, pos: V3, o: PlaceOpts & { seg?: number; rf?: number; axis?: 'x' | 'y' | 'z'; flat?: boolean } = {}): void {
    const seg = o.seg ?? 12;
    const g = new THREE.CylinderGeometry(r, o.rf ?? r, len, seg, 1, false, o.flat ? Math.PI / seg : 0);
    const axis = o.axis ?? 'z';
    if (axis === 'z') g.rotateX(Math.PI / 2); // +y (radius r) -> +z (rear)
    else if (axis === 'x') g.rotateZ(-Math.PI / 2); // +y -> +x
    this.put(g, o.slot ?? 'metal', pos, o.rot);
  }

  sphere(r: number, pos: V3, slot: GunSlot = 'metal', seg = 10): void {
    this.put(new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7))), slot, pos);
  }

  /** Flat disc/ring facing +z (reticles). */
  ring(inner: number, outer: number, pos: V3, slot: GunSlot, seg = 20): void {
    const g = inner > 0 ? new THREE.RingGeometry(inner, outer, seg) : new THREE.CircleGeometry(outer, seg);
    this.put(g, slot, pos);
  }

  /**
   * Inset slots on a z-axis cylinder of radius r (centre axis cx, cy; facets as cyl(seg, flat)).
   * phi = angle from the top, + toward -x (the visible left side). Each slot is a thin dark box
   * just proud of the facet: reads as a cut, no booleans.
   */
  ventSlots(cx: number, cy: number, r: number, seg: number, phis: readonly number[], zs: readonly number[], len: number, w: number): void {
    if (!this.hi) return;
    const a = r * Math.cos(Math.PI / seg);
    for (const phiDeg of phis) {
      const phi = (phiDeg * Math.PI) / 180;
      const rr = a - 0.0004;
      for (const z of zs) this.box([w, 0.002, len], [cx - Math.sin(phi) * rr, cy + Math.cos(phi) * rr, z], 'void', [0, 0, phi]);
    }
  }

  /** Picatinny-style rail from z0 to z1 sitting on y (base + cross teeth). */
  rail(z0: number, z1: number, y: number, w: number): void {
    const len = Math.abs(z1 - z0);
    const zc = (z0 + z1) / 2;
    this.plate([w, 0.007, len], [0, y + 0.0035, zc], { c: 0.0015 });
    if (!this.hi) return;
    const n = Math.max(2, Math.floor(len / 0.0125));
    const step = len / n;
    const zMin = Math.min(z0, z1);
    for (let i = 0; i < n; i++) this.box([w + 0.003, 0.004, step * 0.5], [0, y + 0.009, zMin + (i + 0.5) * step], 'plate');
  }

  /** Hex screw head along an axis (default x, on side plates). */
  rivet(pos: V3, axis: 'x' | 'y' | 'z' = 'x', r = 0.0042): void {
    if (!this.hi) return;
    this.cyl(r, 0.004, pos, { seg: 6, axis, slot: 'metal' });
  }

  /** Cable along a smooth curve through `points`. */
  cable(points: readonly V3[], r: number, slot: GunSlot = 'rubber'): void {
    if (!this.hi) return;
    const curve = new THREE.CatmullRomCurve3(points.map(vec));
    this.put(new THREE.TubeGeometry(curve, Math.max(8, points.length * 4), r, 5, false), slot, [0, 0, 0]);
  }

  /** The orange indicator lamp: a small housing on a side face (side -1 = left) and a lens. */
  lamp(pos: V3, side = -1): void {
    const [x, y, z] = pos;
    this.plate([0.006, 0.015, 0.015], [x + side * 0.002, y, z], { c: 0.0018 });
    this.cyl(0.0045, 0.004, [x + side * 0.0055, y, z], { axis: 'x', seg: 10, slot: 'lamp' });
  }

  /** Cyan micro-readout on a side face centred at pos (side -1 = left): bezel, screen, text. */
  readout(pos: V3, w: number, h: number, side = -1): void {
    const [x, y, z] = pos;
    this.plate([0.005, h + 0.008, w + 0.008], [x + side * 0.0025, y, z], { c: 0.0018 });
    this.box([0.0016, h, w], [x + side * 0.0055, y, z], 'screen');
    if (!this.hi) return;
    const lines: [number, number][] = [[0.3, 0.7], [0.0, 0.45], [-0.3, 0.8]];
    for (const [fy, fw] of lines) {
      const lw = w * fw * 0.86;
      this.box([0.0012, h * 0.11, lw], [x + side * 0.0066, y + fy * h, z + (w * 0.86 - lw) / 2 - 0.0], 'void');
    }
    // a small block "gauge" on the right of the screen
    this.box([0.0012, h * 0.5, w * 0.08], [x + side * 0.0066, y - h * 0.1, z - w * 0.4], 'void');
  }
}

// ---- profiles ----------------------------------------------------------------
/**
 * Pistol-grip side profile: top centre `top` ([z, y]), length along the raked down axis,
 * front-to-back depth, rake (rad, bottom swings back), finger grooves on the front strap,
 * a palm swell at the back and a flared heel. `inset` shrinks it (rubber panels).
 */
function gripProfile(top: P2, len: number, depth: number, rake: number, grooves: number, inset = 0, n = 9): P2[] {
  const s = Math.sin(rake), c = Math.cos(rake);
  const pt = (t: number, side: number, extra: number): P2 => {
    const along = t * len;
    const off = side * (depth / 2 - inset + extra);
    return [top[0] + s * along - c * off, top[1] - c * along - s * off];
  };
  const t0 = -0.16 + inset / len;
  const t1 = 1 - inset / len;
  const ridge = (t: number) => (grooves > 0 && t > 0.12 && t < 0.95 ? 0.0055 * 0.5 * (1 - Math.cos((2 * Math.PI * grooves * (t - 0.12)) / 0.83)) : 0);
  const flare = (t: number) => 0.004 * THREE.MathUtils.smoothstep(t, 0.82, 1);
  const swell = (t: number) => (t > 0 ? 0.005 * Math.sin(Math.PI * Math.min(1, t)) : 0);
  const ta = Math.max(t0, 0.02);
  const ts = Array.from({ length: n + 1 }, (_, i) => ta + ((t1 - ta) * i) / n);
  const pts: P2[] = [pt(t0, -1, 0), pt(t0, 1, 0)];
  for (const t of ts) pts.push(pt(t, 1, ridge(t) + flare(t)));
  for (let i = ts.length - 1; i >= 0; i--) pts.push(pt(ts[i], -1, swell(ts[i]) + flare(ts[i])));
  return pts;
}

/** Plate grip core with finger grooves + inset rubber side panels with two screws. */
function grip(k: GunKit, top: P2, len: number, depth: number, rake: number, width: number): void {
  k.slab(gripProfile(top, len, depth, rake, 3, 0, k.hi ? 9 : 5), width - 0.008, { bevel: 0.004 });
  k.slab(gripProfile(top, len, depth, rake, 0, 0.007, k.hi ? 6 : 4), width, { bevel: 0.004, slot: 'rubber' });
  if (k.hi) {
    const s = Math.sin(rake), c = Math.cos(rake);
    for (const t of [0.2, 0.78]) k.rivet([-(width / 2 + 0.001), top[1] - c * t * len, top[0] + s * t * len], 'x', 0.0035);
  }
}

/** Squared trigger guard (with its opening) and a curved trigger blade. */
function triggerGroup(k: GunKit, zFront: number, zBack: number, yTop: number, yBot: number): void {
  const t = 0.0055;
  const outer: P2[] = [[zBack, yTop], [zFront, yTop], [zFront, yBot + 0.012], [zFront + 0.012, yBot], [zBack, yBot]];
  const hole: P2[] = [[zBack - t, yTop - 0.004], [zFront + t, yTop - 0.004], [zFront + t, yBot + t + 0.008], [zFront + t + 0.008, yBot + t], [zBack - t, yBot + t]];
  k.slab(outer, 0.013, { bevel: 0.0025, holes: [hole] });
  const zt = zFront + (zBack - zFront) * 0.45;
  k.slab([[zt, yTop], [zt + 0.008, yTop], [zt + 0.004, yTop - 0.02], [zt - 0.002, yTop - 0.032], [zt - 0.008, yTop - 0.03], [zt - 0.002, yTop - 0.018]], 0.008, { bevel: 0.0015, slot: 'metal' });
}

/** Curved (banana) magazine profile in mag-local [z, y]: top at y = 0, bulging forward. */
function curvedMag(len: number, depthTop: number, depthBot: number, curve: number, n = 5): P2[] {
  const front: P2[] = [];
  const back: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = (depthTop + (depthBot - depthTop) * t) / 2;
    const off = -curve * t * t;
    front.push([off - d, -len * t]);
    back.push([off + d, -len * t]);
  }
  return [...front, ...back.reverse()];
}

// ---- blueprint builder ---------------------------------------------------------
interface NodeOpts {
  tags?: Record<string, unknown>;
  /** Origin [x, y] on this axis (z = bbox centre): barrels, scopes, bolts scale/turn about it. */
  axis?: readonly [number, number];
  /** Explicit origin (gun space). */
  origin?: V3;
  /** Pieces are built in a local frame placed at pos, rotated about X (tilted mags). */
  frame?: { pos: V3; rotX: number };
}

function mergeBySlot(pieces: Piece[]): { geometry: THREE.BufferGeometry; slots: GunSlot[] } {
  const slots: GunSlot[] = [];
  const parts: THREE.BufferGeometry[] = [];
  for (const slot of SLOT_ORDER) {
    const list = pieces.filter((p) => p.slot === slot).map((p) => p.geo);
    if (!list.length) continue;
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false)!;
    if (list.length > 1) for (const g of list) g.dispose();
    slots.push(slot);
    parts.push(merged);
  }
  const geometry = mergeGeometries(parts, true)!;
  for (const g of parts) g.dispose();
  return { geometry, slots };
}

class BlueprintBuilder {
  readonly nodes: GunNode[] = [];
  private readonly flatPieces: Piece[] = [];
  constructor(readonly hi: boolean, readonly flat: boolean) {}

  node(name: string, build: (k: GunKit) => void, o: NodeOpts = {}): void {
    const k = new GunKit(this.hi);
    build(k);
    if (!k.pieces.length) return;
    const frameM = o.frame
      ? new THREE.Matrix4().compose(vec(o.frame.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(o.frame.rotX, 0, 0)), new THREE.Vector3(1, 1, 1))
      : null;
    if (this.flat) {
      for (const p of k.pieces) {
        if (frameM) p.geo.applyMatrix4(frameM);
        this.flatPieces.push(p);
      }
      return;
    }
    const { geometry, slots } = mergeBySlot(k.pieces);
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const origin = o.origin ? vec(o.origin) : o.axis ? new THREE.Vector3(o.axis[0], o.axis[1], centre.z) : centre;
    geometry.translate(-origin.x, -origin.y, -origin.z);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const position = frameM ? origin.clone().applyMatrix4(frameM) : origin;
    this.nodes.push({ name, geometry, slots, position, rotation: new THREE.Euler(o.frame?.rotX ?? 0, 0, 0), userData: { ...o.tags } });
  }

  finish(archetype: WeaponArchetype, muzzle: V3, sightY: number): GunBlueprint {
    if (this.flat && this.flatPieces.length) {
      const { geometry, slots } = mergeBySlot(this.flatPieces);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      this.nodes.push({ name: 'gun', geometry, slots, position: new THREE.Vector3(), rotation: new THREE.Euler(), userData: {} });
    }
    const triangles = this.nodes.reduce((s, n) => s + n.geometry.getAttribute('position').count / 3, 0);
    return { archetype, nodes: this.nodes, muzzle: vec(muzzle), sightY, triangles };
  }
}

interface GunMeta { muzzle: V3; sightY: number }
type GunDesign = (b: BlueprintBuilder) => GunMeta;

// ---- the five guns -------------------------------------------------------------
/** Sight-line heights, also used by the viewmodel's ADS pose. */
export const GUN_SIGHT_Y: Record<WeaponArchetype, number> = { pistol: 0.104, smg: 0.125, shotgun: 0.104, rifle: 0.161, sniper: 0.152 };

/** Heavy pistol: slab slide over a round barrel bushing, exposed hammer, accessory block. */
const pistol: GunDesign = (b) => {
  const Y = 0.055; // bore axis
  b.node('slide', (k) => {
    k.slab([[0.075, 0.022], [0.075, 0.078], [0.065, 0.088], [-0.212, 0.088], [-0.245, 0.068], [-0.245, 0.022]], 0.062, { bevel: 0.006 });
    if (k.hi) {
      for (let i = 0; i < 5; i++) for (const s of [-1, 1]) k.box([0.002, 0.04, 0.0035], [s * 0.0312, 0.053, 0.024 + i * 0.009], 'void');
      for (let i = 0; i < 3; i++) k.box([0.002, 0.024, 0.008], [-0.0312, 0.058, -0.168 - i * 0.015], 'void');
    }
    k.box([0.0632, 0.0025, 0.17], [0, 0.03, -0.1], 'accent'); // seam
    // rear sight: base + two ears (top 0.104); front post (top 0.104)
    k.plate([0.038, 0.008, 0.016], [0, 0.092, 0.055], { c: 0.002 });
    for (const s of [-1, 1]) k.plate([0.012, 0.016, 0.016], [s * 0.013, 0.096, 0.055], { c: 0.002 });
    k.plate([0.008, 0.018, 0.012], [0, 0.095, -0.2], { c: 0.002 });
  }, { tags: { vmAnim: 'slide' } });

  b.node('barrel', (k) => {
    k.cyl(0.021, 0.014, [0, Y, -0.244], { seg: 14 }); // bushing
    k.cyl(0.015, 0.05, [0, Y, -0.262], { seg: 12 });
    k.cyl(0.0095, 0.003, [0, Y, -0.2875], { seg: 10, slot: 'void' }); // bore
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });

  b.node('body', (k) => {
    // frame + under-barrel accessory block
    k.slab([[0.09, 0.022], [-0.236, 0.022], [-0.244, 0.014], [-0.244, -0.026], [-0.234, -0.036], [-0.105, -0.036], [-0.092, -0.014], [0.06, -0.014], [0.09, 0.0]], 0.054, { bevel: 0.005 });
    if (k.hi) for (let i = 0; i < 4; i++) k.box([0.002, 0.018, 0.008], [-0.0275, -0.014, -0.135 - i * 0.022], 'void');
    k.lamp([-0.027, 0.006, -0.222]);
    // exposed hammer
    k.slab([[0.078, 0.02], [0.078, 0.058], [0.09, 0.079], [0.105, 0.077], [0.097, 0.06], [0.093, 0.02]], 0.014, { slot: 'metal', bevel: 0.002 });
    grip(k, [0.012, 0.004], 0.15, 0.072, 0.25, 0.054);
    triggerGroup(k, -0.086, -0.012, -0.012, -0.064);
    k.rivet([-0.0275, 0.006, 0.04]);
    k.rivet([-0.0275, 0.006, -0.07]);
  });

  // magazine inside the grip (hidden while seated) + base plate = the grip butt
  const frame = { pos: [0, 0.004, 0.012] as V3, rotX: -0.25 };
  b.node('mag', (k) => {
    k.plate([0.04, 0.13, 0.05], [0, -0.085, 0], { c: 0.004 });
    k.cyl(0.006, 0.03, [0, -0.017, -0.004], { seg: 8 }); // top round
  }, { tags: { vmAnim: 'mag' }, frame });
  b.node('magBase', (k) => {
    k.plate([0.05, 0.012, 0.074], [0, -0.156, 0.003], { c: 0.003 });
  }, { tags: { vmAnim: 'magPart' }, frame });
  return { muzzle: [0, Y, -0.29], sightY: GUN_SIGHT_Y.pistol };
};

/** Compact SMG: railed receiver, vented handguard, flash hider, curved mag, side knob, skeleton stock. */
const smg: GunDesign = (b) => {
  const Y = 0.044;
  b.node('body', (k) => {
    k.slab([[0.078, 0.0], [0.078, 0.068], [0.064, 0.084], [-0.2, 0.084], [-0.2, 0.0]], 0.066, { bevel: 0.006 });
    k.slab([[0.07, 0.002], [0.07, -0.012], [-0.088, -0.012], [-0.095, -0.046], [-0.168, -0.046], [-0.175, -0.034], [-0.178, 0.002]], 0.058, { bevel: 0.005 });
    // handguard with vent slots
    k.slab([[-0.198, 0.004], [-0.198, 0.082], [-0.318, 0.082], [-0.336, 0.066], [-0.336, 0.018], [-0.322, 0.004]], 0.06, { bevel: 0.006 });
    if (k.hi) for (const s of [-1, 1]) for (let i = 0; i < 3; i++) k.box([0.002, 0.012, 0.022], [s * 0.0302, Y, -0.228 - i * 0.03], 'void');
    k.rail(0.062, -0.31, 0.084, 0.026);
    // sights: rear ears to 0.125 over a deep notch, hooded front post to 0.125
    k.plate([0.03, 0.012, 0.018], [0, 0.099, 0.045], { c: 0.002 });
    for (const s of [-1, 1]) k.plate([0.009, 0.02, 0.018], [s * 0.0105, 0.115, 0.045], { c: 0.002 });
    k.plate([0.026, 0.012, 0.016], [0, 0.099, -0.298], { c: 0.002 });
    k.box([0.005, 0.02, 0.008], [0, 0.115, -0.298], 'plate');
    for (const s of [-1, 1]) k.plate([0.005, 0.026, 0.014], [s * 0.012, 0.118, -0.298], { c: 0.0015 });
    // knob track, raised side plate, lamp, seam
    k.box([0.002, 0.008, 0.11], [-0.0332, 0.058, -0.13], 'void');
    k.plate([0.004, 0.03, 0.09], [-0.034, 0.026, -0.02], { c: 0.0012 });
    k.rivet([-0.0365, 0.026, -0.055]);
    k.rivet([-0.0365, 0.026, 0.015]);
    k.lamp([-0.033, 0.062, 0.04]);
    k.box([0.0672, 0.0025, 0.16], [0, 0.074, -0.09], 'accent');
    // skeleton stock folded along the right side: hinge block, two struts, rubber butt
    k.plate([0.07, 0.06, 0.024], [0.004, 0.04, 0.088], { c: 0.005 });
    for (const y of [0.062, 0.014]) k.cyl(0.0065, 0.17, [0.042, y, 0.0], { seg: 8 });
    k.plate([0.014, 0.1, 0.034], [0.046, 0.032, -0.092], { slot: 'rubber', c: 0.004 });
    grip(k, [0.025, -0.004], 0.12, 0.058, 0.28, 0.048);
    triggerGroup(k, -0.086, -0.006, -0.008, -0.056);
  });
  b.node('barrel', (k) => {
    k.cyl(0.012, 0.066, [0, Y, -0.363], { seg: 10 });
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });
  b.node('hider', (k) => {
    k.cyl(0.018, 0.06, [0, Y, -0.426], { seg: 8, flat: true });
    k.ventSlots(0, Y, 0.018, 8, [0, 90, -90], [-0.43], 0.03, 0.006);
    k.cyl(0.0085, 0.003, [0, Y, -0.4565], { seg: 8, slot: 'void' });
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });

  const frame = { pos: [0, 0.0, -0.131] as V3, rotX: 0.1 };
  b.node('mag', (k) => {
    k.slab(curvedMag(0.22, 0.054, 0.06, 0.028), 0.04, { bevel: 0.004 });
    if (k.hi) for (const t of [0.35, 0.5, 0.65]) k.box([0.002, 0.004, 0.036], [-0.0202, -0.22 * t, -0.028 * t * t], 'void');
  }, { tags: { vmRole: 'mag' }, frame });
  b.node('magEnd', (k) => {
    k.plate([0.046, 0.012, 0.068], [0, -0.225, -0.028], { c: 0.003 });
    k.box([0.0472, 0.0025, 0.0692], [0, -0.222, -0.028], 'accent');
  }, { tags: { vmRole: 'magEnd' }, frame });

  b.node('knob', (k) => {
    k.cyl(0.006, 0.014, [-0.039, 0.058, -0.17], { axis: 'x', seg: 8 });
    k.cyl(0.0105, 0.008, [-0.05, 0.058, -0.17], { axis: 'x', seg: 10, slot: 'plate' });
  }, { tags: { vmAnim: 'handle' } });
  return { muzzle: [0, Y, -0.46], sightY: GUN_SIGHT_Y.smg };
};

/** Double-barrel pump: twin round barrels over a shell tube, grooved forend, bead + notch. */
const shotgun: GunDesign = (b) => {
  const BY = 0.064; // barrel axis
  const TY = 0.012; // tube axis
  b.node('body', (k) => {
    // receiver: sloped back toward the grip, a breech block the barrels plug into
    k.slab([[0.092, -0.012], [0.092, 0.046], [0.06, 0.08], [-0.12, 0.09], [-0.15, 0.09], [-0.15, -0.024], [-0.14, -0.034], [-0.02, -0.034], [0.012, -0.016]], 0.078, { bevel: 0.007 });
    k.slab([[-0.146, -0.03], [-0.146, 0.088], [-0.156, 0.097], [-0.186, 0.097], [-0.192, 0.088], [-0.192, -0.022], [-0.182, -0.03]], 0.108, { bevel: 0.006 });
    k.cyl(0.009, 0.112, [0, 0.03, -0.168], { axis: 'x', seg: 8 }); // hinge pin
    k.box([0.044, 0.002, 0.08], [0, -0.0345, -0.08], 'void'); // loading port
    k.plate([0.005, 0.044, 0.11], [-0.04, 0.03, -0.05], { c: 0.0014 });
    if (k.hi) k.box([0.002, 0.012, 0.07], [-0.0431, 0.03, -0.05], 'void');
    for (const [y, z] of [[0.014, -0.096], [0.014, -0.004], [0.046, -0.096], [0.046, -0.004]] as const) k.rivet([-0.0435, y, z]);
    k.lamp([-0.039, 0.07, -0.11]);
    k.box([0.0792, 0.0025, 0.15], [0, 0.058, -0.045], 'accent');
    // rear sight tower on the sloped receiver (notch floor 0.104)
    k.plate([0.034, 0.024, 0.016], [0, 0.092, 0.03], { c: 0.003 });
    for (const s of [-1, 1]) k.plate([0.009, 0.012, 0.016], [s * 0.0125, 0.108, 0.03], { c: 0.002 });
    k.plate([0.06, 0.056, 0.016], [0, 0.018, 0.098], { slot: 'rubber', c: 0.006 }); // rear buffer
    // shell tube + cap, mid clamp
    k.cyl(0.017, 0.43, [0, TY, -0.385], { seg: 12 });
    k.cyl(0.019, 0.02, [0, TY, -0.61], { seg: 12, slot: 'plate' });
    k.cyl(0.008, 0.008, [0, TY, -0.624], { seg: 8 });
    k.plate([0.1, 0.07, 0.022], [0, 0.03, -0.47], { c: 0.005 });
    k.rivet([-0.051, 0.03, -0.47]);
    grip(k, [0.038, -0.012], 0.13, 0.064, 0.35, 0.05);
    triggerGroup(k, -0.062, 0.0, -0.02, -0.074);
  });
  for (const x of [-0.025, 0.025]) {
    b.node('barrel', (k) => {
      k.cyl(0.024, 0.51, [x, BY, -0.415], { seg: 14 });
      k.cyl(0.017, 0.003, [x, BY, -0.6705], { seg: 12, slot: 'void' });
    }, { tags: { vmRole: 'barrel' }, axis: [x, BY] });
  }
  b.node('muzzleBand', (k) => {
    k.plate([0.104, 0.056, 0.022], [0, BY, -0.648], { c: 0.005 });
    k.box([0.1055, 0.004, 0.024], [0, BY + 0.008, -0.648], 'accent');
    k.cyl(0.0045, 0.012, [0, 0.098, -0.648], { axis: 'y', seg: 8 }); // bead, top 0.104
  }, { tags: { vmRole: 'muzzle' } });
  b.node('pump', (k) => {
    k.slab([[-0.235, -0.014], [-0.235, 0.034], [-0.247, 0.042], [-0.408, 0.042], [-0.42, 0.034], [-0.42, -0.014], [-0.408, -0.024], [-0.247, -0.024]], 0.064, { bevel: 0.006 });
    k.slab([[-0.256, -0.016], [-0.256, 0.032], [-0.398, 0.032], [-0.398, -0.016]], 0.072, { bevel: 0.004, slot: 'rubber' });
    if (k.hi) for (const s of [-1, 1]) for (let i = 0; i < 5; i++) k.box([0.002, 0.032, 0.008], [s * 0.0362, 0.008, -0.27 - i * 0.029], 'void');
  }, { tags: { vmAnim: 'pump' } });
  return { muzzle: [0, BY, -0.675], sightY: GUN_SIGHT_Y.shotgun };
};

/** Assault rifle: vented octagonal shroud, rails, holo optic, angled foregrip, cables, readout. */
const rifle: GunDesign = (b) => {
  const Y = 0.056;
  const SY = GUN_SIGHT_Y.rifle;
  b.node('body', (k) => {
    k.slab([[0.125, 0.0], [0.125, 0.09], [0.11, 0.105], [-0.2, 0.105], [-0.2, 0.0]], 0.074, { bevel: 0.007 });
    k.slab([[0.1, 0.004], [0.1, -0.02], [0.055, -0.024], [-0.062, -0.024], [-0.066, -0.052], [-0.174, -0.052], [-0.182, -0.04], [-0.186, 0.004]], 0.064, { bevel: 0.006 });
    k.rail(0.09, -0.195, 0.105, 0.03);
    // raised left side panel with the readout, four screws
    k.plate([0.004, 0.055, 0.15], [-0.039, 0.055, -0.06], { c: 0.0012 });
    k.readout([-0.041, 0.064, -0.064], 0.06, 0.022);
    for (const [y, z] of [[0.034, -0.128], [0.034, 0.008], [0.076, 0.008], [0.034, -0.03]] as const) k.rivet([-0.0425, y, z]);
    k.lamp([-0.037, 0.086, -0.176]);
    k.box([0.002, 0.026, 0.06], [0.0375, 0.06, -0.03], 'void'); // ejection port (right)
    k.box([0.0752, 0.0025, 0.24], [0, 0.016, -0.05], 'accent');
    // cables: a heavy one looping down the left side into the shroud, a thin wire off the readout
    k.cable([[-0.036, 0.03, 0.095], [-0.047, 0.006, 0.04], [-0.05, -0.012, -0.05], [-0.05, 0.0, -0.16], [-0.046, 0.03, -0.212], [-0.039, 0.046, -0.236]], 0.0055);
    k.cable([[-0.044, 0.07, -0.03], [-0.048, 0.08, 0.025], [-0.045, 0.074, 0.075], [-0.036, 0.06, 0.105]], 0.0032, 'wire');
    grip(k, [0.03, -0.02], 0.125, 0.058, 0.3, 0.05);
    triggerGroup(k, -0.062, -0.004, -0.02, -0.068);
    // stock: the viewmodel shows the adaptor only (the rest is behind the eye);
    // icons/avatars get the full skeleton stock with its butt pad
    k.slab([[0.12, 0.09], [0.165, 0.084], [0.178, 0.07], [0.178, 0.004], [0.165, -0.008], [0.12, -0.01]], 0.056, { bevel: 0.006 });
    if (!k.hi) {
      k.slab([[0.2, 0.09], [0.34, 0.082], [0.385, 0.072], [0.392, 0.055], [0.392, -0.09], [0.38, -0.104], [0.345, -0.104], [0.2, -0.008]], 0.05, {
        bevel: 0.006, holes: [[[0.235, 0.066], [0.34, 0.06], [0.36, 0.048], [0.36, -0.06], [0.345, -0.07], [0.235, 0.016]]],
      });
      k.plate([0.056, 0.2, 0.02], [0, -0.01, 0.4], { slot: 'rubber', c: 0.006 });
    }
    // angled foregrip under the shroud
    k.plate([0.038, 0.012, 0.1], [0, 0.02, -0.345], { c: 0.003 });
    k.slab([[-0.3, 0.016], [-0.388, 0.016], [-0.384, 0.004], [-0.352, -0.062], [-0.33, -0.064], [-0.322, -0.05], [-0.31, 0.004]], 0.034, { bevel: 0.005, slot: 'rubber' });
  });
  b.node('shroud', (k) => {
    k.cyl(0.042, 0.238, [0, Y, -0.319], { seg: 8, flat: true, slot: 'plate' });
    k.cyl(0.045, 0.012, [0, Y, -0.444], { seg: 8, flat: true, slot: 'plate' });
    k.ventSlots(0, Y, 0.042, 8, [45, 90, -45, -90], [-0.235, -0.29, -0.345, -0.4], 0.036, 0.009);
    k.rail(-0.205, -0.43, Y + 0.042 * Math.cos(Math.PI / 8), 0.026);
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });
  b.node('barrel', (k) => {
    k.cyl(0.014, 0.08, [0, Y, -0.49], { seg: 10 });
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });
  b.node('comp', (k) => {
    k.cyl(0.02, 0.062, [0, Y, -0.561], { seg: 8, flat: true });
    k.ventSlots(0, Y, 0.02, 8, [0, 45, -45], [-0.556], 0.028, 0.006);
    k.cyl(0.022, 0.008, [0, Y, -0.596], { seg: 8, flat: true, slot: 'plate' });
    k.cyl(0.0085, 0.003, [0, Y, -0.6005], { seg: 8, slot: 'void' });
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });

  // holo sight: base block, open window (walls + roof), glass, reticle ring + dot on the axis
  b.node('optic', (k) => {
    k.plate([0.05, 0.022, 0.07], [0, 0.127, -0.03], { c: 0.004 });
    for (const s of [-1, 1]) k.plate([0.008, 0.046, 0.062], [s * 0.029, SY, -0.031], { c: 0.0025 });
    k.plate([0.066, 0.009, 0.062], [0, 0.1885, -0.031], { c: 0.003 });
    k.box([0.05, 0.046, 0.0015], [0, SY, -0.058], 'lens');
    k.ring(0.0047, 0.0058, [0, SY, -0.0565], 'reticle');
    k.ring(0, 0.0011, [0, SY, -0.0565], 'reticle', 8);
    if (k.hi) {
      k.box([0.004, 0.007, 0.011], [-0.026, 0.127, -0.042], 'metal');
      k.box([0.004, 0.007, 0.011], [-0.026, 0.127, -0.026], 'metal');
    }
    k.cyl(0.005, 0.014, [0.029, 0.124, -0.012], { axis: 'x', seg: 8 }); // mount lever (right)
  }, { tags: { vmRole: 'scope' }, axis: [0, SY] });

  const frame = { pos: [0, 0.0, -0.12] as V3, rotX: 0.2 };
  b.node('mag', (k) => {
    k.slab(curvedMag(0.175, 0.068, 0.076, 0.025), 0.04, { bevel: 0.004 });
    if (k.hi) for (const t of [0.45, 0.6, 0.75]) k.box([0.002, 0.004, 0.05], [-0.0202, -0.175 * t, -0.025 * t * t], 'void');
  }, { tags: { vmRole: 'mag' }, frame });
  b.node('magEnd', (k) => {
    k.plate([0.046, 0.012, 0.08], [0, -0.181, -0.025], { c: 0.003 });
  }, { tags: { vmRole: 'magEnd' }, frame });

  b.node('chargingHandle', (k) => {
    k.plate([0.088, 0.01, 0.014], [0, 0.112, 0.108], { c: 0.003 });
  }, { tags: { vmAnim: 'handle' } });
  return { muzzle: [0, Y, -0.605], sightY: SY };
};

/** Bolt-action sniper: long fluted barrel + suppressor, big optic, bolt, folded bipod, readout. */
const sniper: GunDesign = (b) => {
  const Y = 0.05;
  const SY = GUN_SIGHT_Y.sniper;
  b.node('body', (k) => {
    k.slab([[0.105, 0.0], [0.105, 0.084], [0.092, 0.098], [-0.2, 0.098], [-0.2, 0.0]], 0.072, { bevel: 0.007 });
    k.slab([[0.1, 0.004], [0.1, -0.02], [0.06, -0.024], [-0.056, -0.024], [-0.06, -0.04], [-0.15, -0.04], [-0.156, -0.03], [-0.158, 0.004]], 0.062, { bevel: 0.005 });
    // free-float handguard with a row of slots
    k.slab([[-0.198, 0.002], [-0.198, 0.098], [-0.488, 0.098], [-0.502, 0.084], [-0.502, 0.016], [-0.488, 0.002]], 0.066, { bevel: 0.008 });
    if (k.hi) {
      for (let i = 0; i < 6; i++) k.box([0.002, 0.01, 0.026], [-0.0332, 0.062, -0.235 - i * 0.042], 'void');
      k.box([0.002, 0.09, 0.003], [-0.0362, 0.05, -0.199], 'void');
    }
    k.rail(0.085, 0.01, 0.098, 0.028);
    k.rail(-0.07, -0.49, 0.098, 0.028);
    k.box([0.022, 0.002, 0.06], [0.016, 0.0985, -0.032], 'void'); // ejection port (PORTS.sniper)
    k.box([0.002, 0.014, 0.03], [0.0365, 0.07, 0.09], 'void'); // bolt handle slot (right)
    k.readout([-0.0362, 0.062, -0.1], 0.056, 0.022);
    k.lamp([-0.0362, 0.064, -0.045]);
    for (const [y, z] of [[0.02, 0.06], [0.02, -0.17], [0.084, 0.06], [0.084, -0.17]] as const) k.rivet([-0.0382, y, z]);
    k.box([0.0732, 0.0025, 0.24], [0, 0.018, -0.06], 'accent');
        grip(k, [0.03, -0.022], 0.125, 0.058, 0.32, 0.05);
    triggerGroup(k, -0.054, -0.004, -0.02, -0.066);
    // stock (open over the bolt's travel): the viewmodel keeps the wrist, icons/avatars get the
    // full skeleton stock with cheek and butt pads
    if (k.hi) k.slab([[0.1, 0.045], [0.2, 0.045], [0.22, 0.03], [0.22, -0.03], [0.205, -0.034], [0.1, -0.022]], 0.052, { bevel: 0.006 });
    else {
      k.slab([[0.1, 0.045], [0.215, 0.045], [0.235, 0.098], [0.405, 0.098], [0.425, 0.084], [0.43, -0.09], [0.415, -0.106], [0.365, -0.106], [0.24, -0.034], [0.1, -0.022]], 0.052, {
        bevel: 0.006, holes: [[[0.265, 0.07], [0.39, 0.07], [0.4, 0.06], [0.4, -0.066], [0.37, -0.066], [0.265, -0.004]]],
      });
      k.plate([0.056, 0.2, 0.022], [0, -0.004, 0.44], { slot: 'rubber', c: 0.006 });
      k.plate([0.056, 0.014, 0.13], [0, 0.1, 0.33], { slot: 'rubber', c: 0.004 });
    }
    // folded bipod under the handguard
    k.plate([0.044, 0.016, 0.03], [0, -0.006, -0.47], { c: 0.003 });
    for (const x of [-0.013, 0.013]) {
      k.cyl(0.006, 0.17, [x, -0.016, -0.385], { seg: 8 });
      k.cyl(0.008, 0.015, [x, -0.016, -0.42], { seg: 8, slot: 'plate' });
      k.plate([0.016, 0.014, 0.022], [x, -0.016, -0.295], { slot: 'rubber', c: 0.003 });
    }
    // cables: an oxide wire looping under the receiver into the handguard, a rubber lead to the rear
    k.cable([[-0.028, -0.022, -0.14], [-0.03, -0.045, -0.18], [-0.03, -0.05, -0.24], [-0.028, -0.03, -0.29], [-0.024, 0.004, -0.31]], 0.004, 'wire');
    k.cable([[-0.038, 0.05, -0.132], [-0.044, 0.034, -0.06], [-0.044, 0.03, 0.03], [-0.037, 0.045, 0.098]], 0.0045);
  });
  b.node('barrel', (k) => {
    k.cyl(0.016, 0.62, [0, Y, -0.51], { seg: 12 });
    k.ventSlots(0, Y, 0.0162, 12, [0, 45, 90, -45], [-0.66], 0.25, 0.003);
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });
  b.node('suppressor', (k) => {
    k.cyl(0.034, 0.168, [0, Y, -0.904], { seg: 16, slot: 'plate' });
    k.cyl(0.038, 0.022, [0, Y, -0.832], { seg: 6 }); // hex nut
    k.ventSlots(0, Y, 0.034, 16, [60, 90, 120], [-0.955], 0.026, 0.008);
    k.cyl(0.03, 0.006, [0, Y, -0.989], { seg: 14 });
    k.cyl(0.01, 0.003, [0, Y, -0.9925], { seg: 10, slot: 'void' });
  }, { tags: { vmRole: 'barrel' }, axis: [0, Y] });

  b.node('scope', (k) => {
    k.cyl(0.021, 0.2, [0, SY, -0.06], { seg: 16, slot: 'plate' });
    k.cyl(0.021, 0.04, [0, SY, -0.18], { seg: 16, rf: 0.035, slot: 'plate' });
    k.cyl(0.035, 0.06, [0, SY, -0.23], { seg: 16, slot: 'plate' });
    k.cyl(0.037, 0.008, [0, SY, -0.256], { seg: 16 });
    k.cyl(0.03, 0.002, [0, SY, -0.2605], { seg: 16, slot: 'lens' });
    k.cyl(0.028, 0.03, [0, SY, 0.055], { seg: 16, rf: 0.021, slot: 'plate' });
    k.cyl(0.028, 0.045, [0, SY, 0.0925], { seg: 16, slot: 'plate' });
    k.cyl(0.03, 0.012, [0, SY, 0.121], { seg: 16, slot: 'rubber' });
    k.cyl(0.022, 0.002, [0, SY, 0.1275], { seg: 14, slot: 'void' });
    // turrets + power ring
    k.cyl(0.012, 0.024, [0, SY + 0.033, -0.07], { axis: 'y', seg: 10 });
    k.cyl(0.013, 0.006, [0, SY + 0.046, -0.07], { axis: 'y', seg: 10, slot: 'plate' });
    k.cyl(0.011, 0.022, [-0.032, SY, -0.07], { axis: 'x', seg: 10 });
    k.cyl(0.023, 0.012, [0, SY, 0.03], { seg: 16 });
    // rings: tall blocks down to the rails, steel caps over the tube
    for (const z of [0.03, -0.13]) {
      k.plate([0.05, 0.062, 0.018], [0, 0.139, z], { c: 0.004 });
      k.cyl(0.0245, 0.018, [0, SY, z], { seg: 16 });
    }
  }, { tags: { vmRole: 'scope' }, axis: [0, SY] });

  b.node('mag', (k) => {
    k.plate([0.048, 0.08, 0.085], [0, -0.05, -0.105], { c: 0.004 });
  }, { tags: { vmRole: 'mag' } });
  b.node('magEnd', (k) => {
    k.plate([0.054, 0.012, 0.09], [0, -0.094, -0.105], { c: 0.003 });
  }, { tags: { vmRole: 'magEnd' } });

  // bolt: body on the bore line (slides out the back when open), handle + knob out to the right;
  // origin on the bolt axis (the lift turns about it)
  const BO: V3 = [0.004, 0.07, 0.06];
  b.node('bolt', (k) => {
    k.cyl(0.016, 0.09, [BO[0], BO[1], 0.055], { seg: 12 });
    k.cyl(0.019, 0.014, [BO[0], BO[1], 0.104], { seg: 12, slot: 'plate' });
    k.cyl(0.0055, 0.064, [0.048, BO[1] - 0.003, 0.09], { axis: 'x', seg: 8 });
    k.sphere(0.013, [0.087, BO[1] - 0.004, 0.09], 'plate', 10);
  }, { tags: { vmAnim: 'bolt', knob: new THREE.Vector3(0.083, -0.004, 0.03) }, origin: BO });
  return { muzzle: [0, Y, -0.995], sightY: SY };
};

const DESIGNS: Record<WeaponArchetype, GunDesign> = { pistol, smg, shotgun, rifle, sniper };

const cache = new Map<string, GunBlueprint>();

/**
 * The cached blueprint for an archetype. 'vm' = viewmodel (tagged moving parts, full detail);
 * 'lo' = one flattened low-detail mesh (loot icons, co-op avatars).
 */
export function gunBlueprint(archetype: WeaponArchetype, detail: GunDetail = 'vm'): GunBlueprint {
  const arch = DESIGNS[archetype] ? archetype : 'rifle';
  const key = `${arch}:${detail}`;
  let bp = cache.get(key);
  if (!bp) {
    const b = new BlueprintBuilder(detail === 'vm', detail === 'lo');
    const meta = DESIGNS[arch](b);
    bp = b.finish(arch, meta.muzzle, meta.sightY);
    cache.set(key, bp);
  }
  return bp;
}

/**
 * Instantiate a blueprint: one mesh per node with its slot materials. Geometries are shared
 * with the cache (never dispose them); userData is copied (Vector3 values cloned).
 */
export function instantiateGun(bp: GunBlueprint, mats: Record<GunSlot, THREE.Material>, castShadow = false): THREE.Group {
  const group = new THREE.Group();
  group.name = `gun:${bp.archetype}`;
  for (const n of bp.nodes) {
    const list = n.slots.map((s) => mats[s]);
    const mesh = new THREE.Mesh(n.geometry, list.length === 1 ? list[0] : list);
    mesh.name = n.name;
    mesh.position.copy(n.position);
    mesh.rotation.copy(n.rotation);
    for (const [k, v] of Object.entries(n.userData)) mesh.userData[k] = v instanceof THREE.Vector3 ? v.clone() : v;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}

/** Slot -> material map from a toon factory (opaque slots) and a glow factory (lit slots). */
export function gunSlotMaterials(
  toon: (color: number) => THREE.Material,
  glow: (color: number, lum: number) => THREE.Material,
  accent: THREE.Material,
  lens: THREE.Material,
): Record<GunSlot, THREE.Material> {
  return {
    plate: toon(GUN_COLORS.plate),
    edge: toon(GUN_COLORS.edge),
    metal: toon(GUN_COLORS.metal),
    rubber: toon(GUN_COLORS.rubber),
    void: toon(GUN_COLORS.void),
    wire: toon(GUN_COLORS.wire),
    accent,
    lamp: glow(GUN_COLORS.lamp, GUN_LUM.lamp),
    screen: glow(GUN_COLORS.screen, GUN_LUM.screen),
    reticle: glow(GUN_COLORS.reticle, GUN_LUM.reticle),
    lens,
  };
}
