/**
 * Static geometry batcher: collects transformed primitives per material and merges each
 * group into one mesh (BufferGeometryUtils.mergeGeometries) → a handful of draw calls
 * for the whole arena.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

interface Group {
  material: THREE.Material;
  geos: THREE.BufferGeometry[];
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface AddOpts {
  /** Recompute per-face normals (faceted look). */
  flat?: boolean;
}

export class StaticBatcher {
  private groups = new Map<string, Group>();

  /** Register a material under a key; castShadow/receiveShadow apply to the merged mesh. */
  material(key: string, material: THREE.Material, castShadow = true, receiveShadow = true): void {
    if (!this.groups.has(key)) this.groups.set(key, { material, geos: [], castShadow, receiveShadow });
  }

  /** Add a geometry transformed by `matrix`. The source geometry is not modified. */
  add(key: string, geo: THREE.BufferGeometry, matrix: THREE.Matrix4, opts: AddOpts = {}): void {
    const g = this.groups.get(key);
    if (!g) throw new Error(`[world] unknown batch material ${key}`);
    let out = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(out.attributes)) {
      if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
    }
    out.morphAttributes = {};
    out.clearGroups();
    out.applyMatrix4(matrix);
    if (opts.flat || !out.getAttribute('normal')) out.computeVertexNormals();
    g.geos.push(out);
  }

  build(parent: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, g] of this.groups) {
      if (g.geos.length === 0) continue;
      const merged = mergeGeometries(g.geos, false);
      for (const geo of g.geos) geo.dispose();
      g.geos.length = 0;
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, g.material);
      mesh.name = `world-${key}`;
      mesh.castShadow = g.castShadow;
      mesh.receiveShadow = g.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}

// ---- matrix helpers -----------------------------------------------------------
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** TRS matrix with Euler rotation (radians, XYZ order). */
export function trs(
  x: number, y: number, z: number,
  sx = 1, sy = 1, sz = 1,
  rx = 0, ry = 0, rz = 0,
): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Matrix that maps a unit box (centred) onto a beam from a to b. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, width: number, thick: number, up: THREE.Vector3): THREE.Matrix4 {
  const len = a.distanceTo(b);
  const rot = new THREE.Matrix4().lookAt(a, b, up);
  _q.setFromRotationMatrix(rot);
  _p.copy(a).add(b).multiplyScalar(0.5);
  _s.set(width, thick, len);
  return new THREE.Matrix4().compose(_p, _q, _s);
}
