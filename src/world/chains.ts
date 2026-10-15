/**
 * Hanging chains (grimdark revision, docs/ART_DIRECTION.md §15): one InstancedMesh of flat
 * links (alternating 90° about the chain axis, so the silhouette beads like a real chain).
 * Swags sag between the pillar fronts at two heights; straight hangers drop from the oculus
 * trusses and the roof lip and end in a heavy hook. Decoration only (no collision), ≈ 3 k links,
 * one draw call.
 */
import * as THREE from 'three';
import { makeSurface } from '@/rendering/materials';
import { DIM } from './props';

const LINK = 0.2;

export function createChains(rand: () => number): THREE.InstancedMesh {
  const mats: THREE.Matrix4[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const roll = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const big = new THREE.Vector3(1.9, 1.7, 1.9);

  const along = (pts: THREE.Vector3[], hook = false) => {
    let k = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = a.distanceTo(b);
      const n = Math.max(1, Math.round(len / LINK));
      dir.subVectors(b, a).normalize();
      q.setFromUnitVectors(up, dir);
      for (let j = 0; j < n; j++) {
        mid.lerpVectors(a, b, (j + 0.5) / n);
        roll.setFromAxisAngle(up, (k++ % 2) * Math.PI / 2);
        mats.push(new THREE.Matrix4().compose(mid.clone(), q.clone().multiply(roll), one));
      }
    }
    if (hook) {
      const end = pts[pts.length - 1];
      mats.push(new THREE.Matrix4().compose(end.clone().add(new THREE.Vector3(0, -0.25, 0)), new THREE.Quaternion(), big));
      mats.push(new THREE.Matrix4().compose(end.clone().add(new THREE.Vector3(0.08, -0.55, 0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7), big));
    }
  };
  const swag = (a: THREE.Vector3, b: THREE.Vector3, sag: number, seg = 16) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const p = new THREE.Vector3().lerpVectors(a, b, t);
      p.y -= 4 * sag * t * (1 - t);
      pts.push(p);
    }
    along(pts);
  };
  const polar = (deg: number, r: number, y: number) => {
    const a = THREE.MathUtils.degToRad(deg);
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  };

  // swags between neighbouring pillar fronts (high), and long double-span swags (lower)
  const pr = DIM.pillarR - 0.85;
  for (let i = 0; i < 24; i++) {
    const d0 = 7.5 + i * 15;
    swag(polar(d0, pr, 21.5), polar(d0 + 15, pr, 21.5), 2.2 + rand() * 1.4);
    if (i % 2 === 0) swag(polar(d0, pr, 17.2), polar(d0 + 30, pr, 17.2), 3.6 + rand() * 1.6, 24);
  }
  // hangers from the oculus trusses (two spans at 22.5° and 112.5°) and from the roof lip
  const trussY = DIM.roofY - 1 - 1.7;
  for (const deg of [22.5, 112.5]) {
    const a = -THREE.MathUtils.degToRad(deg);
    for (const t of [-24, -15, -7, 9, 18, 26]) {
      const x = Math.cos(a) * t, z = -Math.sin(a) * t;
      const len = 5 + rand() * 7;
      along([new THREE.Vector3(x, trussY, z), new THREE.Vector3(x, trussY - len, z)], true);
    }
  }
  for (let i = 0; i < 12; i++) {
    const deg = 15 + i * 30 + (rand() - 0.5) * 8;
    const top = polar(deg, DIM.roofIn - 0.5, DIM.roofY - 1.1);
    along([top, top.clone().setY(top.y - (4 + rand() * 5))], true);
  }

  const geo = new THREE.BoxGeometry(0.075, LINK * 1.25, 0.022);
  const mat = makeSurface({ color: 0x2a221d, surface: 'steel', rust: 0.8, sheen: 0.15, grime: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'world-chains';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
