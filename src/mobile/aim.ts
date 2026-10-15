/**
 * Auto-fire target test: is an enemy under the crosshair, within the weapon's range and not
 * behind a wall? The same queries the weapon hitscan uses (a THREE.Raycaster against the enemy
 * roots, then ctx.world.raycast for walls); this only decides whether to hold the trigger, the
 * shot itself is the weapon system's ordinary hitscan.
 */
import * as THREE from 'three';
import type { Enemy, GameContext } from '@/core/types';

const origin = new THREE.Vector3();
const dir = new THREE.Vector3();
const to = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const hits: THREE.Intersection[] = [];
const near: { e: Enemy; t: number }[] = [];

/** Hit distance along the ray to a visible mesh of `e`, or Infinity. */
function hitEnemy(e: Enemy, range: number): number {
  raycaster.set(origin, dir);
  raycaster.near = 0;
  raycaster.far = range;
  hits.length = 0;
  raycaster.intersectObject(e.object, true, hits);
  for (const h of hits) {
    if (!(h.object as THREE.Mesh).isMesh) continue;
    let o: THREE.Object3D | null = h.object;
    let visible = true;
    while (o && o !== e.object) {
      if (!o.visible) visible = false;
      o = o.parent;
    }
    if (visible && e.object.visible) return h.distance;
  }
  return Infinity;
}

export function enemyUnderCrosshair(ctx: GameContext, range: number): Enemy | null {
  const enemies = ctx.enemies;
  if (!enemies || !(range > 0)) return null;
  const cam = ctx.camera;
  cam.getWorldPosition(origin);
  cam.getWorldDirection(dir);
  near.length = 0;
  for (const e of enemies.list()) {
    if (!e.alive || !e.object) continue;
    // cheap cone reject before the mesh raycast: distance from the ray to the body centre
    to.copy(e.position).y += e.height * 0.5;
    to.sub(origin);
    const t = to.dot(dir);
    const reach = Math.max(e.radius, e.height * 0.6) + 0.4;
    if (t < 0 || t > range + reach) continue;
    if (to.addScaledVector(dir, -t).length() > reach) continue;
    near.push({ e, t });
  }
  near.sort((a, b) => a.t - b.t);
  for (const { e } of near) {
    const d = hitEnemy(e, range);
    if (!Number.isFinite(d)) continue;
    const wall = ctx.world.raycast(origin, dir, d);
    if (!wall || wall.distance >= d) return e;
    return null; // the nearest enemy on the ray is behind a wall: so is everything after it
  }
  return null;
}
