/**
 * Weapon viewmodel growth (PLAN §11 "Weapons too", ART_DIRECTION §8 "Viewmodel guns"): item
 * level lengthens and thickens the barrel shroud, grows the magazine and the optic, adds
 * chamfered heat-sink fins and a stacked muzzle brake (seam-edged, not seam-coloured). Same growth curve as gear
 * (weaponGrowth = growthForLevel(level + rarity bonus)). A level-20 legendary (item level 25,
 * growth ~0.93) gets a x1.56 barrel, x1.74 mag, 5 fins, a 4-stage brake and a mag extension.
 *
 * Works on a built viewmodel gun whose meshes are tagged with `mesh.userData.vmRole`
 * (the gun models in src/player/weaponModels.ts tag their nodes):
 *   'barrel'  Z-axis cylinder (gun points -Z). Grows forward from its rear end. Barrels in
 *             series (shroud -> tip) are chained: a barrel starting where another ends is
 *             pushed forward by that one's growth. Parallel barrels (shotgun) grow together.
 *   'muzzle'  part at the front of the barrel (brake, muzzle band): moves with the barrel tip.
 *   'mag'     grows along its own (possibly tilted) down axis from its top.
 *   'magEnd'  part at the bottom of the mag (band, base plate): moves with the mag bottom.
 *   'scope'   all scope parts scale together about their common centre.
 * Added parts are tagged `vmRole = 'growth'`, use the SHARED gear geometries (never dispose
 * them) and the materials passed in (the viewmodel's cached ones), so nothing leaks per swap.
 */
import * as THREE from 'three';
import type { WeaponArchetype, WeaponDef } from '@/core/types';
import { weaponGrowth } from './generator';
import { gearGeometry } from './models';

export interface WeaponGrowthParams {
  growth: number;
  barrelScale: number;
  barrelRadius: number;
  magScale: number;
  scopeScale: number;
  fins: number;
  finHeight: number;
  brakeStages: number;
  magExtension: boolean;
}

/** How strongly each archetype's barrel lengthens (snipers are already long). */
const BARREL_K: Record<WeaponArchetype, number> = { pistol: 1, smg: 1, shotgun: 0.8, rifle: 0.9, sniper: 0.6 };

export function weaponGrowthParams(w: Pick<WeaponDef, 'level' | 'rarity' | 'archetype'>): WeaponGrowthParams {
  const g = weaponGrowth(w);
  return {
    growth: g,
    barrelScale: 1 + 0.6 * g * BARREL_K[w.archetype],
    barrelRadius: 1 + 0.3 * g,
    magScale: 1 + 0.8 * g,
    scopeScale: 1 + 0.5 * g,
    fins: g < 0.25 ? 0 : Math.min(5, 1 + Math.floor((g - 0.25) * 6)),
    finHeight: 0.012 + 0.03 * g,
    brakeStages: g < 0.5 ? 0 : Math.min(3, 1 + Math.floor((g - 0.5) * 5)) + (w.rarity === 'legendary' ? 1 : 0),
    magExtension: g >= 0.7,
  };
}

function localSize(mesh: THREE.Mesh): THREE.Vector3 {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  return geom.boundingBox!.getSize(new THREE.Vector3());
}

/** A thin seam strip along the top of a (non-uniformly scaled) part, as its child. */
function seamStrip(box: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Vector3, h: number): THREE.Mesh {
  const m = new THREE.Mesh(box, mat);
  m.userData.vmRole = 'growth';
  m.scale.set(1 + 0.002 / parent.x, h / parent.y, 1.03);
  m.position.y = 0.5 + h / parent.y / 2 - 0.0005 / parent.y;
  return m;
}

/** A thin seam band around the middle of a (non-uniformly scaled) part, as its child. */
function seamBand(box: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Vector3): THREE.Mesh {
  const m = new THREE.Mesh(box, mat);
  m.userData.vmRole = 'growth';
  m.scale.set(1 + 0.003 / parent.x, 1 + 0.003 / parent.y, 0.004 / parent.z);
  return m;
}

interface BarrelInfo { mesh: THREE.Mesh; len: number; r: number; rear: number; front: number; shift: number }

/**
 * Grow a built gun in place. `muzzle` is the builder's muzzle position (gun-group space);
 * returns the new muzzle position. `mats.seam` (rarity seam glow) edges the last fin and bands
 * the front brake stage (child meshes, so the gun's child count is fins + stages + extension);
 * pass null for commons.
 */
export function applyWeaponGrowth(
  gun: THREE.Group, w: WeaponDef, mats: { dark: THREE.Material; body?: THREE.Material; seam?: THREE.Material | null },
  muzzle: THREE.Vector3,
): THREE.Vector3 {
  const p = weaponGrowthParams(w);
  const out = muzzle.clone();
  if (p.growth <= 0) return out;
  const geo = gearGeometry();
  const body = mats.body ?? mats.dark;
  const EPS = 0.012;

  const byRole = new Map<string, THREE.Mesh[]>();
  gun.traverse((o) => {
    const role = o.userData.vmRole as string | undefined;
    if (!role || !(o as THREE.Mesh).isMesh) return;
    let list = byRole.get(role);
    if (!list) byRole.set(role, (list = []));
    list.push(o as THREE.Mesh);
  });
  const role = (r: string) => byRole.get(r) ?? [];

  // ---- barrels: grow from the rear, chained front-to-back ------------------
  const barrels: BarrelInfo[] = role('barrel').map((mesh) => {
    const s = localSize(mesh);
    const len = s.z;
    return { mesh, len, r: Math.max(s.x, s.y) / 2, rear: mesh.position.z + len / 2, front: mesh.position.z - len / 2, shift: 0 };
  });
  barrels.sort((a, b) => b.rear - a.rear); // closest to the player first
  for (const b of barrels) {
    // pushed forward by any barrel that ends where this one starts
    for (const a of barrels) {
      if (a === b || a.rear <= b.rear) continue;
      if (Math.abs(a.front - b.rear) <= EPS) b.shift = Math.max(b.shift, a.shift + a.len * (p.barrelScale - 1));
    }
    const rear = b.rear - b.shift;
    b.mesh.scale.x *= p.barrelRadius;
    b.mesh.scale.y *= p.barrelRadius;
    b.mesh.scale.z *= p.barrelScale;
    b.mesh.position.z = rear - (b.len * p.barrelScale) / 2;
  }
  let frontShift = 0;
  let frontTip = out.z;
  let frontX = out.x;
  let frontY = out.y;
  let frontR = 0.02;
  let frontSpan = 0;
  if (barrels.length) {
    const oldFront = Math.min(...barrels.map((b) => b.front));
    const newTips = barrels.map((b) => b.mesh.position.z - (b.len * p.barrelScale) / 2);
    frontTip = Math.min(...newTips);
    frontShift = frontTip - oldFront; // negative = forward
    const lead = barrels.filter((_, i) => newTips[i] <= frontTip + EPS);
    const xs = lead.map((b) => b.mesh.position.x);
    frontX = xs.reduce((s, x) => s + x, 0) / xs.length;
    frontY = lead.reduce((s, b) => s + b.mesh.position.y, 0) / lead.length;
    frontR = Math.max(...lead.map((b) => b.r)) * p.barrelRadius;
    frontSpan = Math.max(...xs) - Math.min(...xs);
  }
  for (const m of role('muzzle')) m.position.z += frontShift;
  out.z += frontShift;

  // ---- magazine: grow along its own down axis from the top ------------------
  const up = new THREE.Vector3();
  let magDrop: THREE.Vector3 | null = null;
  let magBottom: { pos: THREE.Vector3; q: THREE.Quaternion; size: THREE.Vector3 } | null = null;
  for (const m of role('mag')) {
    const s = localSize(m);
    up.set(0, 1, 0).applyQuaternion(m.quaternion);
    const top = m.position.clone().addScaledVector(up, s.y / 2);
    m.scale.y *= p.magScale;
    m.position.copy(top).addScaledVector(up, (-s.y * p.magScale) / 2);
    if (!magDrop) {
      magDrop = up.clone().multiplyScalar(-s.y * (p.magScale - 1));
      magBottom = { pos: top.clone().addScaledVector(up, -s.y * p.magScale), q: m.quaternion.clone(), size: s };
    }
  }
  if (magDrop) for (const m of role('magEnd')) m.position.add(magDrop);
  if (magBottom && p.magExtension) {
    const ext = new THREE.Mesh(geo.chamfer, body);
    ext.userData.vmRole = 'growth';
    ext.scale.set(magBottom.size.x * 1.35, 0.03, magBottom.size.z * 1.35);
    ext.quaternion.copy(magBottom.q);
    up.set(0, 1, 0).applyQuaternion(magBottom.q);
    ext.position.copy(magBottom.pos).addScaledVector(up, -0.012);
    gun.add(ext);
  }

  // ---- scope: scale the assembly about its centre ---------------------------
  const scope = role('scope');
  if (scope.length) {
    const c = new THREE.Vector3();
    for (const m of scope) c.add(m.position);
    c.divideScalar(scope.length);
    for (const m of scope) {
      m.position.sub(c).multiplyScalar(p.scopeScale).add(c);
      m.scale.multiplyScalar(p.scopeScale);
    }
  }

  // ---- added parts -----------------------------------------------------------
  // heat-sink fins on top of the front barrel(s): chamfered plates, the last one seam-edged
  // (a thin glowing strip along its top, not a glowing block)
  for (let i = 0; i < p.fins; i++) {
    const h = p.finHeight * (1 - 0.12 * i);
    const fin = new THREE.Mesh(geo.chamfer, mats.dark);
    fin.userData.vmRole = 'growth';
    fin.scale.set(0.008 + frontSpan * 0.5, h, 0.035);
    fin.position.set(frontX, frontY + frontR + h / 2, frontTip + 0.03 + 0.05 * i);
    gun.add(fin);
    if (i === p.fins - 1 && mats.seam) fin.add(seamStrip(geo.box, mats.seam, fin.scale, 0.003));
  }
  // muzzle brake: stacked rectangular stages past the tip, the front one seam-edged
  const stage = 0.026;
  for (let i = 0; i < p.brakeStages; i++) {
    const s = new THREE.Mesh(geo.chamfer, mats.dark);
    s.userData.vmRole = 'growth';
    const k = 1 + 0.12 * i;
    s.scale.set((frontR * 3 + frontSpan) * k, frontR * 2.6 * k, stage);
    s.position.set(frontX, frontY, frontTip - stage / 2 - i * (stage + 0.008));
    gun.add(s);
    if (i === p.brakeStages - 1 && mats.seam) s.add(seamBand(geo.box, mats.seam, s.scale));
  }
  if (p.brakeStages) out.z -= p.brakeStages * (stage + 0.008);
  gun.traverse((o) => {
    o.castShadow = false;
  });
  return out;
}
