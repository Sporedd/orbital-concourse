/**
 * Static collision: axis-aligned boxes for props/walls/platforms, triangle soups for the
 * (non-walkable) ice cliffs (raycasts only), the y=0 ground plane and the arena bounds.
 */
import * as THREE from 'three';
import type { CapsuleResult, RayHit } from '@/core/types';

export const STEP_HEIGHT = 0.5;
export const MAX_GROUND_PROP = 2.5;

interface TriSoup {
  center: THREE.Vector3;
  radius: number;
  pos: Float32Array; // world-space, non-indexed triangles
}

export class Collision {
  readonly boxes: THREE.Box3[] = [];
  private soups: TriSoup[] = [];
  // temporaries
  private dir = new THREE.Vector3();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  private pv = new THREE.Vector3();
  private tv = new THREE.Vector3();
  private qv = new THREE.Vector3();
  private bestN = new THREE.Vector3();
  private oc = new THREE.Vector3();
  private exits = [0, 0, 0, 0];
  private exitOrder = [0, 1, 2, 3];

  constructor(readonly half: number) {}

  addBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): THREE.Box3 {
    const b = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    this.boxes.push(b);
    return b;
  }

  /** Box by centre (x,z), footprint w×d, from y0 up to y0+h. */
  addBoxC(x: number, z: number, w: number, d: number, h: number, y0 = 0): THREE.Box3 {
    return this.addBox(x - w / 2, y0, z - d / 2, x + w / 2, y0 + h, z + d / 2);
  }

  /** Triangle soup in world space (raycast only). */
  addTriangles(geo: THREE.BufferGeometry): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const src = g.getAttribute('position') as THREE.BufferAttribute;
    const pos = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
      pos[i * 3] = src.getX(i);
      pos[i * 3 + 1] = src.getY(i);
      pos[i * 3 + 2] = src.getZ(i);
    }
    g.computeBoundingSphere();
    const s = g.boundingSphere!;
    this.soups.push({ center: s.center.clone(), radius: s.radius, pos });
  }

  groundHeight(x: number, z: number): number {
    let h = 0;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.min.y > 0.05) continue; // floating (roofs)
      if (b.max.y <= MAX_GROUND_PROP && b.max.y > h) h = b.max.y;
    }
    return h;
  }

  /** True if a vertical circle (x,z,r) intersects any box that overlaps [y0, y1]. */
  private blockedAt(x: number, z: number, r: number, y0: number, y1: number, ignore: THREE.Box3 | null): boolean {
    const r2 = r * r;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b === ignore) continue;
      if (y0 >= b.max.y - 1e-4 || y1 <= b.min.y + 1e-4) continue;
      const cx = x < b.min.x ? b.min.x : x > b.max.x ? b.max.x : x;
      const cz = z < b.min.z ? b.min.z : z > b.max.z ? b.max.z : z;
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  resolveCapsule(position: THREE.Vector3, radius: number, height: number): CapsuleResult {
    const p = position.clone();
    const r = radius;
    const r2 = r * r;
    const lim = this.half - r;
    if (p.x < -lim) p.x = -lim; else if (p.x > lim) p.x = lim;
    if (p.z < -lim) p.z = -lim; else if (p.z > lim) p.z = lim;

    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (p.y >= b.max.y - 1e-4 || p.y + height <= b.min.y + 1e-4) continue;
        const cx = p.x < b.min.x ? b.min.x : p.x > b.max.x ? b.max.x : p.x;
        const cz = p.z < b.min.z ? b.min.z : p.z > b.max.z ? b.max.z : p.z;
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;

        const up = b.max.y - p.y; // lift needed to stand on top
        const down = p.y + height - b.min.y; // push needed below the box (head bump)

        // step-up onto low boxes / stairs / landing from a fall
        if (up <= STEP_HEIGHT && !this.blockedAt(p.x, p.z, r * 0.95, b.max.y, b.max.y + height, b)) {
          p.y = b.max.y;
          moved = true;
          continue;
        }

        if (d2 > 1e-10) {
          // centre outside the footprint: push out along the closest-point normal
          const d = Math.sqrt(d2);
          const pen = r - d;
          if (p.y < b.min.y && down < pen) {
            p.y = b.min.y - height;
          } else {
            p.x += (dx / d) * pen;
            p.z += (dz / d) * pen;
          }
        } else {
          // centre inside the footprint: minimum-penetration axis (horizontal first)
          const pxn = p.x - b.min.x + r;
          const pxp = b.max.x - p.x + r;
          const pzn = p.z - b.min.z + r;
          const pzp = b.max.z - p.z + r;
          let best = pxn;
          let axis = 0;
          if (pxp < best) { best = pxp; axis = 1; }
          if (pzn < best) { best = pzn; axis = 2; }
          if (pzp < best) { best = pzp; axis = 3; }
          const minPen = best;
          // Adjacent solids (stair steps, stacked props): the minimum exit can land inside the
          // next box, which pushes straight back (ping-pong → stuck inside). Take the cheapest
          // exit that is clear at this height instead; fall back to the minimum if none is.
          const cand = this.exits;
          cand[0] = pxn; cand[1] = pxp; cand[2] = pzn; cand[3] = pzp;
          const order = this.exitOrder;
          order.sort((a, b) => cand[a] - cand[b]);
          for (let k = 0; k < 4; k++) {
            const ax = order[k];
            const nx = ax === 0 ? b.min.x - r : ax === 1 ? b.max.x + r : p.x;
            const nz = ax === 2 ? b.min.z - r : ax === 3 ? b.max.z + r : p.z;
            if (!this.blockedAt(nx, nz, r * 0.98, p.y + STEP_HEIGHT, p.y + height, b)) {
              best = cand[ax];
              axis = ax;
              break;
            }
          }
          if (up < minPen && up <= down) {
            p.y = b.max.y;
          } else if (down < best && p.y < b.min.y) {
            p.y = b.min.y - height;
          } else if (axis === 0) p.x = b.min.x - r;
          else if (axis === 1) p.x = b.max.x + r;
          else if (axis === 2) p.z = b.min.z - r;
          else p.z = b.max.z + r;
        }
        moved = true;
      }
      if (p.x < -lim) p.x = -lim; else if (p.x > lim) p.x = lim;
      if (p.z < -lim) p.z = -lim; else if (p.z > lim) p.z = lim;
      if (!moved) break;
    }

    // support: highest box top under the circle that we are at/above
    let support = 0;
    const rs = (r - 0.01) * (r - 0.01);
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.max.y > p.y + 1e-3 || b.max.y <= support) continue;
      const cx = p.x < b.min.x ? b.min.x : p.x > b.max.x ? b.max.x : p.x;
      const cz = p.z < b.min.z ? b.min.z : p.z > b.max.z ? b.max.z : p.z;
      const dx = p.x - cx;
      const dz = p.z - cz;
      if (dx * dx + dz * dz < rs) support = b.max.y;
    }
    let onGround = false;
    if (p.y <= support + 1e-3) {
      p.y = support;
      onGround = true;
    }
    return { position: p, onGround };
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, groundExtent: number): RayHit | null {
    const dir = this.dir.copy(direction);
    const len = dir.length();
    if (len < 1e-8) return null;
    dir.multiplyScalar(1 / len);
    let best = maxDistance;
    let hit = false;
    const n = this.bestN;

    // ground plane y = 0
    if (dir.y < -1e-6 && origin.y >= 0) {
      const t = -origin.y / dir.y;
      if (t <= best) {
        const x = origin.x + dir.x * t;
        const z = origin.z + dir.z * t;
        if (Math.abs(x) <= groundExtent && Math.abs(z) <= groundExtent) {
          best = t;
          n.set(0, 1, 0);
          hit = true;
        }
      }
    }

    // boxes (slab test)
    const ix = 1 / dir.x;
    const iy = 1 / dir.y;
    const iz = 1 / dir.z;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      let tmin: number, tmax: number, axis = 0, sign = 0;
      let t1 = (b.min.x - origin.x) * ix;
      let t2 = (b.max.x - origin.x) * ix;
      if (t1 > t2) { tmin = t2; tmax = t1; sign = 1; } else { tmin = t1; tmax = t2; sign = -1; }
      if (Number.isNaN(tmin)) { tmin = -Infinity; tmax = Infinity; }
      t1 = (b.min.y - origin.y) * iy;
      t2 = (b.max.y - origin.y) * iy;
      let lo: number, hi: number, s: number;
      if (t1 > t2) { lo = t2; hi = t1; s = 1; } else { lo = t1; hi = t2; s = -1; }
      if (!Number.isNaN(lo)) {
        if (lo > tmin) { tmin = lo; axis = 1; sign = s; }
        if (hi < tmax) tmax = hi;
      }
      t1 = (b.min.z - origin.z) * iz;
      t2 = (b.max.z - origin.z) * iz;
      if (t1 > t2) { lo = t2; hi = t1; s = 1; } else { lo = t1; hi = t2; s = -1; }
      if (!Number.isNaN(lo)) {
        if (lo > tmin) { tmin = lo; axis = 2; sign = s; }
        if (hi < tmax) tmax = hi;
      }
      if (tmax < tmin || tmin < 0 || tmin > best) continue;
      best = tmin;
      hit = true;
      n.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    }

    // triangle soups (cliffs)
    for (let s = 0; s < this.soups.length; s++) {
      const soup = this.soups[s];
      // ray-sphere reject
      const oc = this.oc.subVectors(soup.center, origin);
      const tc = oc.dot(dir);
      const d2 = oc.lengthSq() - tc * tc;
      if (d2 > soup.radius * soup.radius) continue;
      if (tc + soup.radius < 0 || tc - soup.radius > best) continue;
      const pos = soup.pos;
      for (let i = 0; i < pos.length; i += 9) {
        const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
        this.e1.set(pos[i + 3] - ax, pos[i + 4] - ay, pos[i + 5] - az);
        this.e2.set(pos[i + 6] - ax, pos[i + 7] - ay, pos[i + 8] - az);
        this.pv.crossVectors(dir, this.e2);
        const det = this.e1.dot(this.pv);
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        this.tv.set(origin.x - ax, origin.y - ay, origin.z - az);
        const u = this.tv.dot(this.pv) * inv;
        if (u < 0 || u > 1) continue;
        this.qv.crossVectors(this.tv, this.e1);
        const v = dir.dot(this.qv) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = this.e2.dot(this.qv) * inv;
        if (t < 0 || t > best) continue;
        best = t;
        hit = true;
        n.crossVectors(this.e1, this.e2).normalize();
        if (n.dot(dir) > 0) n.negate();
      }
    }

    if (!hit) return null;
    return {
      point: new THREE.Vector3().copy(origin).addScaledVector(dir, best),
      normal: n.clone(),
      distance: best,
    };
  }

  /** True if (x,z) lies inside any box footprint grown by margin. */
  isBlocked(x: number, z: number, margin: number): boolean {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (x > b.min.x - margin && x < b.max.x + margin && z > b.min.z - margin && z < b.max.z + margin) return true;
    }
    return false;
  }
}
