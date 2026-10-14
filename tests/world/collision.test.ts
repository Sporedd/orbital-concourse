import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARENA, PLAYER } from '@/core/config';
import { createRng } from '@/core/rng';
import { Collision, MAX_GROUND_PROP, STEP_HEIGHT } from '@/world/collision';
import { createWorld } from '@/world';
import { createFakeContext } from '../helpers/fakeContext';

const R = PLAYER.radius;
const H = PLAYER.height;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('Collision.resolveCapsule', () => {
  it('clamps the capsule inside the arena bounds (minus radius)', () => {
    const col = new Collision(ARENA.halfSize);
    const res = col.resolveCapsule(v(100, 0, -100), R, H);
    expect(res.position.x).toBeCloseTo(ARENA.halfSize - R);
    expect(res.position.z).toBeCloseTo(-(ARENA.halfSize - R));
    expect(res.onGround).toBe(true);
  });

  it('does not mutate the input vector', () => {
    const col = new Collision(32);
    const p = v(100, 0, 0);
    col.resolveCapsule(p, R, H);
    expect(p.x).toBe(100);
  });

  it('pushes out of a tall box when the centre is outside the footprint', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 2, 1);
    const res = col.resolveCapsule(v(1.2, 0, 0), R, H);
    expect(res.position.x).toBeCloseTo(1 + R);
    expect(res.position.z).toBeCloseTo(0);
    expect(res.position.y).toBe(0);
  });

  it('pushes out along the minimum-penetration axis when the centre is inside', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 2, 1);
    const a = col.resolveCapsule(v(0.9, 0, 0.1), R, H);
    expect(a.position.x).toBeCloseTo(1 + R);
    const b = col.resolveCapsule(v(0.1, 0, -0.85), R, H);
    expect(b.position.z).toBeCloseTo(-1 - R);
  });

  it('pushes diagonally out of a box corner', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 2, 1);
    const res = col.resolveCapsule(v(1.2, 0, 1.2), R, H);
    const d = Math.hypot(res.position.x - 1, res.position.z - 1);
    expect(d).toBeCloseTo(R, 4);
  });

  it(`steps up onto boxes up to ${STEP_HEIGHT} m`, () => {
    const col = new Collision(32);
    col.addBox(1, 0, -1, 3, 0.45, 1);
    const res = col.resolveCapsule(v(1.2, 0, 0), R, H);
    expect(res.position.y).toBeCloseTo(0.45);
    expect(res.position.x).toBeCloseTo(1.2);
    expect(res.onGround).toBe(true);
  });

  it('steps up when only the capsule edge overlaps a low box', () => {
    const col = new Collision(32);
    col.addBox(1, 0, -1, 3, 0.5, 1);
    const res = col.resolveCapsule(v(0.8, 0, 0), R, H);
    expect(res.position.y).toBeCloseTo(0.5);
  });

  it(`does not step up boxes taller than ${STEP_HEIGHT} m (pushed back instead)`, () => {
    const col = new Collision(32);
    col.addBox(1, 0, -1, 3, 0.6, 1);
    const res = col.resolveCapsule(v(0.8, 0, 0), R, H);
    expect(res.position.y).toBe(0);
    expect(res.position.x).toBeCloseTo(1 - R);
  });

  it('does not step up when the space above the step is blocked', () => {
    const col = new Collision(32);
    col.addBox(1, 0, -1, 3, 0.4, 1); // step
    col.addBox(1, 0.4, -1, 3, 1.5, 1); // wall standing on it
    const res = col.resolveCapsule(v(0.8, 0, 0), R, H);
    expect(res.position.y).toBe(0);
    expect(res.position.x).toBeLessThanOrEqual(1 - R + 1e-6);
  });

  it('lands on a box top when falling slightly into it and reports onGround', () => {
    const col = new Collision(32);
    col.addBox(-2, 0, -2, 2, 2, 2);
    const res = col.resolveCapsule(v(0, 1.8, 0), R, H);
    expect(res.position.y).toBeCloseTo(2);
    expect(res.onGround).toBe(true);
  });

  it('is airborne above a box and grounded exactly on it', () => {
    const col = new Collision(32);
    col.addBox(-2, 0, -2, 2, 2, 2);
    expect(col.resolveCapsule(v(0, 2.5, 0), R, H).onGround).toBe(false);
    const on = col.resolveCapsule(v(0, 2, 0), R, H);
    expect(on.onGround).toBe(true);
    expect(on.position.y).toBe(2);
  });

  it('snaps to the floor when at or below y = 0', () => {
    const col = new Collision(32);
    const res = col.resolveCapsule(v(0, -0.3, 0), R, H);
    expect(res.position.y).toBe(0);
    expect(res.onGround).toBe(true);
  });

  it('bumps the head under a floating slab', () => {
    const col = new Collision(32);
    col.addBox(-5, 2, -5, 5, 3, 5); // roof slab
    const res = col.resolveCapsule(v(0, 0.5, 0), R, H); // head at 2.3
    expect(res.position.y).toBeCloseTo(2 - H);
  });
});

describe('Collision.groundHeight', () => {
  it('returns box tops for walkable props and 0 elsewhere', () => {
    const col = new Collision(32);
    col.addBoxC(5, 5, 2, 2, 1.2);
    expect(col.groundHeight(5, 5)).toBeCloseTo(1.2);
    expect(col.groundHeight(7, 7)).toBe(0);
  });

  it('takes the highest of stacked boxes', () => {
    const col = new Collision(32);
    col.addBoxC(0, 0, 4, 4, 0.5);
    col.addBoxC(0, 0, 2, 2, 1.0, 0.5); // y0 = 0.5 → floating per the 0.05 rule
    col.addBoxC(0, 0, 1, 1, 1.4);
    expect(col.groundHeight(0, 0)).toBeCloseTo(1.4);
    expect(col.groundHeight(1.5, 1.5)).toBeCloseTo(0.5);
  });

  it(`ignores floating boxes and props taller than ${MAX_GROUND_PROP} m`, () => {
    const col = new Collision(32);
    col.addBox(-1, 2, -1, 1, 3, 1); // roof
    col.addBox(4, 0, 4, 6, 4, 6); // wall
    expect(col.groundHeight(0, 0)).toBe(0);
    expect(col.groundHeight(5, 5)).toBe(0);
  });
});

describe('Collision.raycast', () => {
  const EXT = 72;

  it('hits the ground plane with an up normal', () => {
    const col = new Collision(32);
    const hit = col.raycast(v(3, 5, 4), v(0, -1, 0), 50, EXT)!;
    expect(hit).not.toBeNull();
    expect(hit.distance).toBeCloseTo(5);
    expect(hit.point.y).toBeCloseTo(0);
    expect(hit.normal.toArray()).toEqual([0, 1, 0]);
  });

  it('misses when the target is beyond maxDistance, and when pointing up', () => {
    const col = new Collision(32);
    expect(col.raycast(v(0, 10, 0), v(0, -1, 0), 5, EXT)).toBeNull();
    expect(col.raycast(v(0, 1, 0), v(0, 1, 0), 100, EXT)).toBeNull();
    expect(col.raycast(v(0, 1, 0), v(0, 0, 0), 100, EXT)).toBeNull(); // zero direction
  });

  it('hits box sides with the correct outward normal', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 2, 1);
    const px = col.raycast(v(-10, 1, 0), v(1, 0, 0), 50, EXT)!;
    expect(px.distance).toBeCloseTo(9);
    expect(px.normal.toArray()).toEqual([-1, 0, 0]);
    const nz = col.raycast(v(0, 1, 10), v(0, 0, -1), 50, EXT)!;
    expect(nz.point.z).toBeCloseTo(1);
    expect(nz.normal.toArray()).toEqual([0, 0, 1]);
  });

  it('hits a box top (before the ground) with an up normal', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 2, 1);
    const hit = col.raycast(v(0, 10, 0), v(0, -1, 0), 50, EXT)!;
    expect(hit.distance).toBeCloseTo(8);
    expect(hit.normal.y).toBe(1);
  });

  it('returns the nearest of several boxes and normalises the direction', () => {
    const col = new Collision(32);
    col.addBox(5, 0, -1, 6, 2, 1);
    col.addBox(2, 0, -1, 3, 2, 1);
    const hit = col.raycast(v(0, 1, 0), v(7, 0, 0), 50, EXT)!; // unnormalised dir
    expect(hit.distance).toBeCloseTo(2);
    expect(hit.point.x).toBeCloseTo(2);
  });

  it('does not report boxes behind the origin', () => {
    const col = new Collision(32);
    col.addBox(-6, 0, -1, -5, 2, 1);
    expect(col.raycast(v(0, 1, 0), v(1, 0, 0), 20, EXT)).toBeNull();
  });

  it('hits triangle soups with a normal facing the ray', () => {
    const col = new Collision(32);
    const wall = new THREE.PlaneGeometry(10, 10); // faces +Z at z=0
    wall.translate(0, 5, -8);
    col.addTriangles(wall);
    const hit = col.raycast(v(0, 3, 0), v(0, 0, -1), 50, EXT)!;
    expect(hit.distance).toBeCloseTo(8);
    expect(hit.normal.z).toBeCloseTo(1);
    // from behind: normal flipped to face the ray
    const back = col.raycast(v(0, 3, -20), v(0, 0, 1), 50, EXT)!;
    expect(back.distance).toBeCloseTo(12);
    expect(back.normal.z).toBeCloseTo(-1);
  });

  it('ground hits are limited to groundExtent', () => {
    const col = new Collision(32);
    expect(col.raycast(v(100, 5, 0), v(0, -1, 0), 50, EXT)).toBeNull();
  });
});

describe('Collision.isBlocked', () => {
  it('honours the margin', () => {
    const col = new Collision(32);
    col.addBox(-1, 0, -1, 1, 1, 1);
    expect(col.isBlocked(0, 0, 0)).toBe(true);
    expect(col.isBlocked(1.5, 0, 0)).toBe(false);
    expect(col.isBlocked(1.5, 0, 0.6)).toBe(true);
  });
});

describe('createWorld (real arena layout, headless)', () => {
  const ctx = createFakeContext({ seed: 2024, world: 'none' });
  ctx.rng = createRng(2024);
  const world = createWorld(ctx);

  it('builds without WebGL and exposes spawn data', () => {
    expect(world.mobSpawnPoints.length).toBeGreaterThan(8);
    expect(world.playerStart.z).toBeGreaterThan(0);
    expect(() => world.update(0.016)).not.toThrow();
  });

  it('player start and mob spawn points are free of obstacles', () => {
    const res = world.resolveCapsule(world.playerStart.clone(), R, H);
    expect(res.position.distanceTo(world.playerStart)).toBeLessThan(1e-6);
    for (const p of world.mobSpawnPoints) {
      const r = world.resolveCapsule(p.clone(), 1.1, 2);
      expect(Math.hypot(r.position.x - p.x, r.position.z - p.z)).toBeLessThan(1e-6);
    }
  });

  it('randomNavigablePoint never lands inside a blocked cell (500 seeded samples)', () => {
    const lim = ARENA.halfSize - 2;
    for (let i = 0; i < 500; i++) {
      const p = world.randomNavigablePoint();
      expect(Math.abs(p.x)).toBeLessThanOrEqual(lim);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(lim);
      expect(p.y).toBe(0);
      expect(world.groundHeight(p.x, p.z)).toBe(0);
      // isBlocked(x,z,0.9) false ⇒ a 0.85 m capsule standing there is not pushed anywhere
      const r = world.resolveCapsule(p.clone(), 0.85, 2);
      expect(r.position.distanceTo(p)).toBeLessThan(1e-6);
    }
  });

  it('randomNavigablePoint respects minDistFrom/minDist', () => {
    const from = v(0, 0, 0);
    for (let i = 0; i < 200; i++) {
      const p = world.randomNavigablePoint(from, 12);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(12);
    }
  });

  it('randomNavigablePoint returns a fresh vector each call', () => {
    const a = world.randomNavigablePoint();
    const b = world.randomNavigablePoint();
    expect(a).not.toBe(b);
  });

  it('never leaves a capsule standing inside adjacent stair steps (deck stairs)', () => {
    // centres inside the step footprints at floor level: the minimum-penetration exit of one
    // step lands inside the next, which used to ping-pong the capsule and leave it inside
    for (const [x, z] of [[-17, 2], [-16.5, 2], [-16, 2.5], [-15.6, 3.5], [17, -2], [16.5, -1], [16, -3]]) {
      const r = world.resolveCapsule(v(x, 0, z), R, H);
      const gh = world.groundHeight(r.position.x, r.position.z);
      expect(gh - r.position.y, `at ${x},${z}`).toBeLessThanOrEqual(STEP_HEIGHT + 1e-6);
    }
  });

  it('the arena is enclosed: horizontal rays from the centre hit something', () => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const hit = world.raycast(v(0, 1.2, 0), v(Math.cos(a), 0, Math.sin(a)), 120);
      expect(hit, `ray ${i}`).not.toBeNull();
      expect(hit!.distance).toBeLessThan(ARENA.halfSize * 1.5 + 2);
    }
  });
});
