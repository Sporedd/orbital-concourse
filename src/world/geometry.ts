/**
 * Geometry helpers for the Brutalist Arena kit (docs/ART_DIRECTION.md §3): chamfered slabs,
 * jersey-barrier sections, octagonal prisms, hazard stripe bands and polar helpers.
 * All geometries are cached and centred (x/z), base at y = -h/2 .. top at +h/2.
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

const cache = new Map<string, THREE.BufferGeometry>();
const cached = (key: string, make: () => THREE.BufferGeometry) => {
  let g = cache.get(key);
  if (!g) {
    g = make();
    cache.set(key, g);
  }
  return g;
};

/**
 * Box w×h×d with 45° chamfers (size c) on the four top edges and the four vertical edges.
 * About 44 triangles; with flat normals the chamfer catches the key light as a thin strip.
 */
export function chamferBox(w: number, h: number, d: number, c = 0.1): THREE.BufferGeometry {
  const cc = Math.min(c, w * 0.3, d * 0.3, h * 0.45);
  const key = `cb:${w.toFixed(3)}:${h.toFixed(3)}:${d.toFixed(3)}:${cc.toFixed(3)}`;
  return cached(key, () => {
    const pts: THREE.Vector3[] = [];
    const hw = w / 2, hd = d / 2, hh = h / 2;
    const oct = (y: number, inset: number) => {
      const x = hw - inset, z = hd - inset, k = cc;
      pts.push(
        new THREE.Vector3(x - k, y, z), new THREE.Vector3(x, y, z - k),
        new THREE.Vector3(x, y, -z + k), new THREE.Vector3(x - k, y, -z),
        new THREE.Vector3(-x + k, y, -z), new THREE.Vector3(-x, y, -z + k),
        new THREE.Vector3(-x, y, z - k), new THREE.Vector3(-x + k, y, z),
      );
    };
    oct(-hh, 0);
    oct(hh - cc, 0);
    oct(hh, cc);
    return new ConvexGeometry(pts);
  });
}

/** Jersey barrier: trapezoid section (wide foot, narrow top), length along x. */
export function jerseyGeo(len: number, h = 1.1, base = 0.8, top = 0.26): THREE.BufferGeometry {
  return cached(`jb:${len}:${h}:${base}:${top}`, () => {
    const pts: THREE.Vector3[] = [];
    const hl = len / 2;
    const prof: [number, number][] = [[base / 2, 0], [base / 2, 0.08], [base * 0.32, 0.32], [top / 2, h - 0.04], [top / 2 - 0.04, h]];
    for (const sx of [-1, 1]) {
      for (const [z, y] of prof) {
        pts.push(new THREE.Vector3(sx * hl, y - h / 2, z), new THREE.Vector3(sx * hl, y - h / 2, -z));
      }
      // chamfered end corners
      pts.push(new THREE.Vector3(sx * (hl + 0), h / 2 - 0.02, 0));
    }
    return new ConvexGeometry(pts);
  });
}

/** Regular octagonal prism, flat-to-flat width w, height h, optional top chamfer. */
export function octPrism(w: number, h: number, c = 0): THREE.BufferGeometry {
  return cached(`oct:${w}:${h}:${c}`, () => {
    const R = w / 2 / Math.cos(Math.PI / 8);
    const pts: THREE.Vector3[] = [];
    const ring = (y: number, r: number) => {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
    };
    ring(-h / 2, R);
    if (c > 0) {
      ring(h / 2 - c, R);
      ring(h / 2, R - c * 1.08);
    } else ring(h / 2, R);
    return new ConvexGeometry(pts);
  });
}

/**
 * Hazard stripes in a plane: band of width w (x) and height h (y) at z=0, facing +z,
 * 45° stripes with `pitch` (only the painted half of each pitch is emitted).
 */
export function stripeBand(w: number, h: number, pitch = 0.4): THREE.BufferGeometry {
  return cached(`sb:${w}:${h}:${pitch}`, () => {
    const pos: number[] = [];
    const half = pitch / 2;
    const x0 = -w / 2, x1 = w / 2;
    for (let s = x0 - h; s < x1; s += pitch) {
      // parallelogram from (s, -h/2) to (s+half, -h/2) skewed by h (45°)
      const quad: [number, number][] = [
        [s, -h / 2], [s + half, -h / 2], [s + half + h, h / 2], [s + h, h / 2],
      ];
      // clip to [x0, x1] by clamping x (cheap; slight distortion at the ends is invisible)
      const q = quad.map(([x, y]) => [Math.min(x1, Math.max(x0, x)), y] as [number, number]);
      if (Math.abs(q[1][0] - q[0][0]) < 1e-4 && Math.abs(q[2][0] - q[3][0]) < 1e-4) continue;
      pos.push(q[0][0], q[0][1], 0, q[1][0], q[1][1], 0, q[2][0], q[2][1], 0);
      pos.push(q[0][0], q[0][1], 0, q[2][0], q[2][1], 0, q[3][0], q[3][1], 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  });
}

/** Flat ring (annulus) on the floor plane, facing up. */
export function floorRing(inner: number, outer: number, seg = 128): THREE.BufferGeometry {
  return cached(`fr:${inner}:${outer}:${seg}`, () => {
    const g = new THREE.RingGeometry(inner, outer, seg, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

/** 45° stripes inside a floor annulus (painted stripes only), facing up. */
export function floorStripeRing(inner: number, outer: number, pitch = 0.4): THREE.BufferGeometry {
  return cached(`fsr:${inner}:${outer}:${pitch}`, () => {
    const pos: number[] = [];
    const rm = (inner + outer) / 2;
    const width = outer - inner;
    const circ = Math.PI * 2 * rm;
    const n = Math.round(circ / pitch);
    const da = (Math.PI * 2) / n;
    const skew = width / rm; // 45° → tangential offset = width
    const P = (a: number, r: number) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    for (let i = 0; i < n; i++) {
      const a0 = i * da;
      const a1 = a0 + da / 2;
      const v0 = P(a0, inner), v1 = P(a1, inner), v2 = P(a1 + skew, outer), v3 = P(a0 + skew, outer);
      // CCW seen from above (+y): order so the normal points up
      pos.push(...v0, ...v1, ...v2, ...v0, ...v2, ...v3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  });
}

/** Warning triangle decal (equilateral, side s) on the floor, apex toward local -z. */
export function triangleGeo(s: number): THREE.BufferGeometry {
  return cached(`tri:${s}`, () => {
    const h = (s * Math.sqrt(3)) / 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -h * 2 / 3, -s / 2, 0, h / 3, s / 2, 0, h / 3], 3));
    g.computeVertexNormals();
    if (g.getAttribute('normal').getY(0) < 0) {
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -h * 2 / 3, s / 2, 0, h / 3, -s / 2, 0, h / 3], 3));
      g.computeVertexNormals();
    }
    return g;
  });
}

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

/** Polar → xz. */
export const polar = (deg: number, r: number): [number, number] => {
  const a = THREE.MathUtils.degToRad(deg);
  return [Math.cos(a) * r, Math.sin(a) * r];
};

/** Y rotation that points local +z radially outward at angle `deg`. */
export const outwardRy = (deg: number) => Math.PI / 2 - THREE.MathUtils.degToRad(deg);
/** Y rotation that points local +z toward the arena centre at angle `deg`. */
export const inwardRy = (deg: number) => -Math.PI / 2 - THREE.MathUtils.degToRad(deg);
