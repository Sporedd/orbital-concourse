import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { EnemyManager } from '@/enemies';
import type { BaseEnemy } from '@/enemies';
import {
  BOSS_SCALE, blueprintStats, buildArtillery, buildBomber, buildBrute, buildGrunt, buildSpitter, buildSummoner, type Rig,
} from '@/enemies/models';
import { GLOW_LOD_DISTANCE, updateGlowLod } from '@/enemies/models';
import { poseRun } from '@/enemies/pose';
import { createPlayerRegistry } from '@/player';
import { createFakeContext, createFakeMaterials, createFakePlayer, type TestContext } from '../helpers/fakeContext';

const MOBS = ['grunt', 'spitter', 'bomber'] as const;
const BOSSES = ['brute', 'summoner', 'artillery'] as const;
const ALL = [...MOBS, ...BOSSES] as const;
type Kind = (typeof ALL)[number];

const BUILD: Record<Kind, typeof buildGrunt> = {
  grunt: buildGrunt, spitter: buildSpitter, bomber: buildBomber, brute: buildBrute, summoner: buildSummoner, artillery: buildArtillery,
};

function meshes(rig: Rig): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  rig.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}

/** Meshes drawn at a time: far glow LODs replace their near twins. */
function drawn(rig: Rig): THREE.Mesh[] {
  return meshes(rig).filter((m) => m.userData.lod !== 'far');
}

function tris(rig: Rig): number {
  let n = 0;
  for (const m of drawn(rig)) {
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  return n;
}

describe('enemy models: armour kit', () => {
  const mf = createFakeMaterials();

  it('every kind builds without throwing, twice (cached blueprint)', () => {
    for (const k of ALL) {
      expect(() => BUILD[k](mf), k).not.toThrow();
      expect(() => BUILD[k](mf), k).not.toThrow();
    }
  });

  it('triangle and draw budgets: mobs ≤ 3k tris, bosses ≤ 8k; few draw groups', () => {
    for (const k of ALL) {
      const rig = BUILD[k](mf);
      const t = tris(rig);
      const draws = drawn(rig).length;
      const boss = (BOSSES as readonly string[]).includes(k);
      expect(t, `${k} tris`).toBeLessThanOrEqual(boss ? 8000 : 3000);
      expect(t, `${k} tris`).toBeGreaterThan(boss ? 1500 : 800); // it is the plated kit, not a placeholder
      expect(draws, `${k} draws`).toBeLessThanOrEqual(boss ? 26 : 18);
      expect(blueprintStats(k)).toEqual({ triangles: t, meshes: meshes(rig).length });
      if (process.env.ENEMY_STATS) console.log(k, { tris: t, draws, shadow: drawn(rig).filter((m) => m.castShadow).length });
    }
  });

  it('instances share geometry, own their materials', () => {
    for (const k of ALL) {
      const a = BUILD[k](mf);
      const b = BUILD[k](mf);
      const ga = meshes(a).map((m) => m.geometry);
      const gb = meshes(b).map((m) => m.geometry);
      expect(gb, k).toEqual(ga);
      for (let i = 0; i < ga.length; i++) expect(gb[i], k).toBe(ga[i]);
      for (const m of a.owned) expect(b.owned, k).not.toContain(m);
      // every material the meshes use is owned (disposed with the enemy)
      for (const m of meshes(a)) expect(a.owned, k).toContain(m.material);
    }
  });

  it('armour is one vertex-coloured toon material; glows are vertex coloured too', () => {
    for (const k of ALL) {
      const rig = BUILD[k](mf);
      const toon = meshes(rig).map((m) => m.material as THREE.Material).filter((m) => (m as THREE.MeshToonMaterial).isMeshToonMaterial);
      const armour = toon.filter((m) => m.vertexColors);
      expect(new Set(armour).size, k).toBe(1);
      expect(rig.mats, k).toContain(armour[0]);
      for (const m of meshes(rig)) expect(m.geometry.getAttribute('color'), k).toBeTruthy();
    }
  });

  it('required rig hooks and part tags', () => {
    const need: Record<Kind, string[]> = {
      grunt: [], spitter: ['sac', 'mouth'], bomber: ['bomb', 'spark'],
      brute: ['weak'], summoner: ['weak', 'halo'], artillery: ['weak', 'mortar', 'muzzle'],
    };
    const legs: Record<Kind, number> = { grunt: 2, spitter: 2, bomber: 2, brute: 2, summoner: 0, artillery: 4 };
    const arms: Record<Kind, number> = { grunt: 2, spitter: 2, bomber: 2, brute: 2, summoner: 2, artillery: 0 };
    for (const k of ALL) {
      const rig = BUILD[k](mf);
      expect(rig.head, k).toBeTruthy();
      expect(rig.body.parent, k).toBe(rig.root);
      expect(rig.legs.length, k).toBe(legs[k]);
      expect(rig.arms.length, k).toBe(arms[k]);
      for (const p of need[k]) expect(rig.parts[p], `${k}.${p}`).toBeInstanceOf(THREE.Object3D);
      for (let i = 0; i < rig.legs.length && legs[k] === 2; i++) expect(rig.parts[`knee${i}`]?.parent, k).toBe(rig.legs[i]);
      for (let i = 0; i < rig.arms.length; i++) expect(rig.parts[`elbow${i}`]?.parent, k).toBe(rig.arms[i]);
      for (const p of Object.values(rig.parts)) {
        let o: THREE.Object3D | null = p;
        while (o && o !== rig.root) o = o.parent;
        expect(o, `${k} part attached`).toBe(rig.root);
      }
      expect(rig.mats.length, k).toBe(rig.baseEmissive.length);
      expect(rig.scale, k).toBe(k in BOSS_SCALE ? BOSS_SCALE[k as keyof typeof BOSS_SCALE] : 1);
      // bosses carry a THREAT accent; the bomber and spitter too (payload, tank window)
      if (k !== 'grunt') expect(rig.accent, k).toBeTruthy();
    }
  });

  it('glow LOD: thin slits near, thickened twins beyond GLOW_LOD_DISTANCE, never both', () => {
    for (const k of MOBS) {
      const rig = BUILD[k](mf);
      const near = meshes(rig).filter((m) => m.userData.lod === 'near');
      const far = meshes(rig).filter((m) => m.userData.lod === 'far');
      expect(near.length, k).toBeGreaterThan(0);
      expect(far.length, k).toBe(near.length);
      const cam = new THREE.Vector3(0, 1.6, 5);
      updateGlowLod(rig, cam);
      expect(near.every((m) => m.visible) && far.every((m) => !m.visible), k).toBe(true);
      updateGlowLod(rig, new THREE.Vector3(0, 1.6, GLOW_LOD_DISTANCE + 15));
      expect(near.every((m) => !m.visible) && far.every((m) => m.visible), k).toBe(true);
      // the far twins are thicker, and do not catch bullets
      for (let i = 0; i < far.length; i++) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        near[i].geometry.boundingBox!.getSize(a);
        far[i].geometry.boundingBox!.getSize(b);
        expect(b.y, k).toBeGreaterThanOrEqual(a.y);
        const hits: THREE.Intersection[] = [];
        far[i].raycast(new THREE.Raycaster(new THREE.Vector3(0, 1.7, 5), new THREE.Vector3(0, 0, -1)), hits);
        expect(hits.length, k).toBe(0);
      }
    }
  });

  it('the run cycle drives hips, knees, shoulders and elbows', () => {
    const rig = buildGrunt(mf);
    poseRun(rig, -0.5, 1); // leg 0 mid-swing
    expect(Math.abs(rig.legs[0].rotation.x)).toBeGreaterThan(0.3);
    expect(rig.legs[0].rotation.x).toBeCloseTo(-rig.legs[1].rotation.x);
    expect(rig.arms[0].rotation.x).toBeCloseTo(-rig.legs[0].rotation.x * (0.85 / 0.8), 5);
    expect(rig.parts.elbow1.rotation.x).toBeLessThan(-1);
    const knees = [rig.parts.knee0.rotation.x, rig.parts.knee1.rotation.x];
    expect(Math.max(...knees)).toBeGreaterThan(0.5);
    for (const kx of knees) expect(kx).toBeGreaterThanOrEqual(0.1);
  });
});

describe('enemy models: bounds match the gameplay capsule', () => {
  let ctx: TestContext;
  let mgr: EnemyManager;
  beforeEach(() => {
    ctx = createFakeContext({ seed: 7 });
    ctx.players = createPlayerRegistry();
    // far away, so nobody attacks during the pose frame
    const p = createFakePlayer('p1', new THREE.Vector3(0, 0, 30), true);
    ctx.players.add(p);
    ctx.player = p;
    mgr = new EnemyManager(ctx);
    ctx.enemies = mgr;
  });

  function spawn(k: Kind): BaseEnemy {
    const e = (MOBS as readonly string[]).includes(k)
      ? mgr.spawnMob(k as (typeof MOBS)[number], new THREE.Vector3(0, 0, 0), 1)
      : mgr.spawnBoss(k as (typeof BOSSES)[number], new THREE.Vector3(0, 0, 0), 1);
    const be = e as unknown as BaseEnemy;
    // rest pose: zero the animated joints, apply the view scale
    be.rig.root.scale.setScalar(be.rig.scale);
    be.rig.root.updateMatrixWorld(true);
    return be;
  }

  it.each(ALL)('%s: height and footprint fit the capsule', (k) => {
    const e = spawn(k);
    const box = new THREE.Box3().setFromObject(e.object);
    const h = box.max.y - e.position.y;
    expect(h, `${k} height`).toBeGreaterThan(e.height * 0.9);
    expect(h, `${k} height`).toBeLessThan(e.height * 1.1);
    // standing / hovering enemies start near the floor (the summoner floats ~0.5 m up)
    expect(box.min.y - e.position.y, `${k} feet`).toBeLessThan(k === 'summoner' ? 1.2 : 0.05);
    expect(box.min.y - e.position.y, `${k} feet`).toBeGreaterThan(-0.05);
    const halfW = Math.max(Math.abs(box.min.x - e.position.x), Math.abs(box.max.x - e.position.x));
    const halfD = Math.max(Math.abs(box.min.z - e.position.z), Math.abs(box.max.z - e.position.z));
    // body within the capsule (+30 %: pauldrons / weapons / the summoner's orbiting slabs poke out)
    const slack = k === 'summoner' ? 1.6 : 1.3;
    expect(Math.min(halfW, halfD), `${k} footprint`).toBeLessThan(e.radius * slack);
    expect(Math.max(halfW, halfD), `${k} footprint`).toBeGreaterThan(e.radius * 0.5);
  });

  it.each(ALL)('%s: head / weak point sits where the crit test expects it', (k) => {
    const e = spawn(k);
    const p = new THREE.Vector3();
    if (e.isBoss) {
      e.rig.parts.weak.getWorldPosition(p);
      expect(e.isCritPoint(p), k).toBe(true);
    } else {
      e.rig.head!.getWorldPosition(p);
      // the head is in the top band of the capsule and is a crit
      expect(p.y - e.position.y, k).toBeGreaterThan(e.height * 0.78);
      expect(e.isCritPoint(p), k).toBe(true);
      expect(e.isCritPoint(new THREE.Vector3(e.position.x, e.position.y + e.height * 0.45, e.position.z)), k).toBe(false);
    }
  });

  it('animated rigs stay finite while running', () => {
    for (const k of ALL) {
      const e = spawn(k);
      e.velocity.set(0, 0, 5);
      for (let i = 0; i < 30; i++) mgr.update(1 / 30);
      e.object.updateMatrixWorld(true);
      e.object.traverse((o) => {
        for (const v of [o.position.x, o.position.y, o.position.z, o.rotation.x, o.rotation.y, o.rotation.z]) {
          expect(Number.isFinite(v), k).toBe(true);
        }
      });
      mgr.clear();
    }
  });
});
