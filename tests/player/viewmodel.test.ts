import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WeaponArchetype, WeaponDef } from '@/core/types';
import { createRng } from '@/core/rng';
import { generateWeapon } from '@/loot/weapons';
import { Controller } from '@/player/controller';
import { Viewmodel } from '@/player/viewmodel';
import { THROW_RELEASE, THROW_TIME, reloadClip, sample, shotgunShellCount } from '@/player/animations';
import { GUN_SIGHT_Y, gunBlueprint } from '@/player/weaponModels';
import { createFakeContext, type TestContext } from '../helpers/fakeContext';

const DT = 1 / 60;
let ctx: TestContext;
let vm: Viewmodel;
let ctl: Controller;
let ids = 0;
const nextId = (p: string) => `${p}_vm${++ids}`;

function gun(archetype: WeaponArchetype, level = 3): WeaponDef {
  const w = generateWeapon(createRng(7 + ids), nextId, 3, { archetype, rarity: level > 10 ? 'legendary' : 'rare' });
  w.level = level;
  return w;
}

function equip(w: WeaponDef): void {
  vm.setWeapon(w, false);
  step(0.5); // finish the raise
}

function step(seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) vm.update(DT, ctl);
}

/** The gun's animated part for an archetype (mag; the pump for the tube-fed shotgun). */
function animPart(archetype: WeaponArchetype): THREE.Object3D {
  let found: THREE.Object3D | null = null;
  const want = archetype === 'shotgun' ? 'pump' : 'mag';
  vm.root.traverse((o) => {
    if (found) return;
    if (o.userData.vmRole === want || o.userData.vmAnim === want) found = o;
  });
  if (!found) throw new Error(`no ${want} part on ${archetype}`);
  return found;
}

const named = (name: string) => vm.root.getObjectByName(name)!;
const pivot = () => vm.root.children[0];

interface Snap { pos: THREE.Vector3; quat: THREE.Quaternion; visible: boolean }
const snap = (o: THREE.Object3D): Snap => ({ pos: o.position.clone(), quat: o.quaternion.clone(), visible: o.visible });
function expectRest(o: THREE.Object3D, rest: Snap): void {
  expect(o.position.distanceTo(rest.pos)).toBeLessThan(1e-9);
  expect(o.quaternion.angleTo(rest.quat)).toBeLessThan(1e-6);
  expect(o.visible).toBe(rest.visible);
}

const ARCHETYPES: WeaponArchetype[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

beforeEach(() => {
  ctx = createFakeContext({ seed: 1 });
  vm = new Viewmodel(ctx);
  ctx.camera.add(vm.root);
  ctl = new Controller(ctx);
  ctl.onGround = true; // no air offset drifting the pose under the assertions
});

describe('viewmodel reload clips', () => {
  it.each(ARCHETYPES)('%s: the mag (pump) leaves its rest pose and returns to it', (archetype) => {
    equip(gun(archetype));
    const part = animPart(archetype);
    const rest = snap(part);
    const pivotRest = snap(pivot());
    const dur = 2.4;
    vm.startReload(dur);
    expect(vm.reloading).toBe(true);
    let maxMove = 0;
    let handSeen = false;
    for (let t = 0; t < dur - DT; t += DT) {
      vm.update(DT, ctl);
      maxMove = Math.max(maxMove, part.position.distanceTo(rest.pos));
      handSeen ||= named('vmOffHand').visible;
    }
    expect(maxMove).toBeGreaterThan(archetype === 'shotgun' ? 0.05 : 0.2);
    expect(handSeen).toBe(true);
    step(0.1);
    expect(vm.reloading).toBe(false);
    expectRest(part, rest);
    expect(named('vmOffHand').visible).toBe(false);
    expect(pivot().position.distanceTo(pivotRest.pos)).toBeLessThan(1e-6);
  });

  it('the pistol slide racks, the smg/rifle handle pulls, the sniper bolt lifts and comes back', () => {
    const cases: [WeaponArchetype, string][] = [['pistol', 'slide'], ['smg', 'handle'], ['rifle', 'handle'], ['sniper', 'bolt']];
    for (const [archetype, tag] of cases) {
      equip(gun(archetype));
      let part: THREE.Object3D | null = null;
      vm.root.traverse((o) => {
        if (!part && o.userData.vmAnim === tag) part = o;
      });
      expect(part, `${archetype} ${tag}`).not.toBeNull();
      const p = part as unknown as THREE.Object3D;
      const rest = snap(p);
      vm.startReload(1.6);
      let moved = 0;
      let turned = 0;
      for (let t = 0; t < 1.6; t += DT) {
        vm.update(DT, ctl);
        moved = Math.max(moved, p.position.z - rest.pos.z);
        turned = Math.max(turned, p.quaternion.angleTo(rest.quat));
      }
      step(0.1);
      expect(moved, `${archetype} ${tag} travel`).toBeGreaterThan(0.05);
      if (archetype === 'sniper') expect(turned).toBeGreaterThan(1);
      expectRest(p, rest);
    }
  });

  it('the shotgun feeds 2-4 shells one by one', () => {
    expect(shotgunShellCount(0.6)).toBe(2);
    expect(shotgunShellCount(2)).toBe(4);
    equip(gun('shotgun'));
    const shell = named('vmShell');
    vm.startReload(2);
    let shows = 0;
    let was = false;
    for (let t = 0; t < 2; t += DT) {
      vm.update(DT, ctl);
      if (shell.visible && !was) shows++;
      was = shell.visible;
    }
    expect(shows).toBe(4);
    expect(shell.visible).toBe(false);
  });

  it('the pistol mag hides once dropped and is back (seated) at the end', () => {
    equip(gun('pistol'));
    const mag = animPart('pistol');
    vm.startReload(1.2);
    let hidden = false;
    for (let t = 0; t < 1.2; t += DT) {
      vm.update(DT, ctl);
      hidden ||= !mag.visible;
    }
    step(0.1);
    expect(hidden).toBe(true);
    expect(mag.visible).toBe(true);
  });

  it.each(ARCHETYPES)('%s: an interrupted reload snaps back to rest within 0.1 s', (archetype) => {
    equip(gun(archetype));
    const part = animPart(archetype);
    const rest = snap(part);
    vm.startReload(2);
    // stop right in the middle of the busiest phase
    step(archetype === 'shotgun' ? 1.8 : 0.76);
    if (archetype !== 'shotgun') expect(part.position.distanceTo(rest.pos)).toBeGreaterThan(0.01);
    vm.cancelReload();
    vm.update(0.05, ctl);
    expect(vm.reloading).toBe(true); // still easing back
    vm.update(0.06, ctl);
    expect(vm.reloading).toBe(false);
    expectRest(part, rest);
    expect(named('vmOffHand').visible).toBe(false);
    expect(named('vmShell').visible).toBe(false);
  });

  it('death and swaps interrupt the reload; a reload started mid-swap binds to the new gun', () => {
    equip(gun('rifle'));
    const mag = animPart('rifle');
    const rest = snap(mag);
    vm.startReload(1.8);
    step(0.5);
    vm.setDead(true);
    step(0.15);
    expect(vm.reloading).toBe(false);
    expectRest(mag, rest);
    vm.setDead(false);
    step(0.5);

    // swap away mid-reload: snaps back during the lower, the new gun comes up clean
    vm.startReload(1.8);
    step(0.4);
    vm.setWeapon(gun('pistol'), true);
    step(0.12);
    expect(vm.reloading).toBe(false);
    step(0.5);
    // reload started while lowering re-binds to the pistol once it is built
    vm.setWeapon(gun('smg'), true);
    vm.startReload(1.6);
    step(0.3);
    expect(vm.reloading).toBe(true);
    const smgMag = animPart('smg');
    step(1.6);
    expect(vm.reloading).toBe(false);
    expect(smgMag.visible).toBe(true);
  });

  it('a grown (high item level) gun returns to its grown rest pose, not the builder pose', () => {
    equip(gun('smg', 3));
    const plain = snap(animPart('smg'));
    equip(gun('smg', 25));
    const mag = animPart('smg');
    const grown = snap(mag);
    expect(grown.pos.distanceTo(plain.pos)).toBeGreaterThan(0.01); // growth moved the mag down
    vm.startReload(1.6);
    step(1.7);
    expectRest(mag, grown);
  });

  it('reload while aiming: the sights pose is suppressed mid-reload and back at the end', () => {
    equip(gun('pistol'));
    ctl.aimBlend = 1;
    ctl.aimZoom = 1.2;
    step(0.2);
    const aimed = pivot().position.clone();
    vm.startReload(1.2);
    step(0.6);
    expect(pivot().position.distanceTo(aimed)).toBeGreaterThan(0.1);
    step(0.7);
    expect(pivot().position.distanceTo(aimed)).toBeLessThan(1e-6);
  });

  it('clips start and end at the rest pose for any duration', () => {
    for (const a of ARCHETYPES) {
      for (const dur of [0.2, 1, 1.79, 2.4, 4]) {
        const c = reloadClip(a, dur);
        for (const k of Object.values(c.gun)) {
          expect(sample(k, 0)).toBe(0);
          expect(sample(k, 1)).toBeCloseTo(0, 9);
        }
        for (const k of [c.magDrop, c.magTilt, c.slide, c.handle, c.pump, c.boltBack, c.boltLift]) {
          expect(sample(k, 1)).toBeCloseTo(0, 9);
        }
        expect(c.hand[0][1]).toBe('off');
        expect(c.hand[c.hand.length - 1][1]).toBe('off');
        const ts = c.hand.map((k) => k[0]);
        expect([...ts].sort((x, y) => x - y)).toEqual(ts);
      }
    }
  });
});

describe('viewmodel grenade throw', () => {
  it('the hand brings the grenade up, releases it ~0.25 s in, and everything returns', () => {
    equip(gun('rifle'));
    const pivotRest = snap(pivot());
    const hand = named('vmThrowHand');
    const nade = named('vmGrenade');
    vm.throwAnim();
    expect(vm.throwing).toBe(true);
    let releasedAt = -1;
    let gunDip = 0;
    let prevZ = 0;
    let handHighest = -Infinity;
    for (let t = DT; t < THROW_TIME - DT / 2; t += DT) {
      vm.update(DT, ctl);
      gunDip = Math.min(gunDip, pivot().position.y - pivotRest.pos.y);
      handHighest = Math.max(handHighest, hand.position.y);
      // after the release the grenade flies forward (-z) fast
      if (releasedAt < 0 && t > 0.1 && nade.position.z < prevZ - 0.06) releasedAt = t;
      prevZ = nade.position.z;
    }
    expect(releasedAt).toBeGreaterThan(0.2);
    expect(releasedAt).toBeLessThan(0.3);
    expect(Math.abs(releasedAt - THROW_RELEASE)).toBeLessThan(0.05);
    expect(gunDip).toBeLessThan(-0.1);
    expect(handHighest).toBeGreaterThan(0.2); // wind-up near the shoulder, on screen
    step(0.05);
    expect(vm.throwing).toBe(false);
    expect(hand.visible).toBe(false);
    expect(nade.visible).toBe(false);
    expect(pivot().position.distanceTo(pivotRest.pos)).toBeLessThan(1e-6);
  });

  it('the grenade is in the hand before the release', () => {
    equip(gun('pistol'));
    vm.throwAnim();
    step(0.16);
    const hand = named('vmThrowHand');
    const nade = named('vmGrenade');
    expect(nade.visible).toBe(true);
    expect(nade.position.distanceTo(hand.position)).toBeLessThan(0.08);
  });

  it('death interrupts the throw and snaps back within 0.1 s; it composes with a reload', () => {
    equip(gun('rifle'));
    const pivotRest = snap(pivot());
    vm.throwAnim();
    step(0.15);
    vm.setDead(true);
    vm.update(0.11, ctl);
    expect(vm.throwing).toBe(false);
    expect(named('vmGrenade').visible).toBe(false);
    vm.setDead(false);
    step(1);
    expect(pivot().position.distanceTo(pivotRest.pos)).toBeLessThan(1e-6);

    const mag = animPart('rifle');
    const rest = snap(mag);
    vm.startReload(1.8);
    step(0.3);
    vm.throwAnim();
    vm.bash();
    step(2);
    expect(vm.reloading || vm.throwing).toBe(false);
    expectRest(mag, rest);
    expect(pivot().position.distanceTo(pivotRest.pos)).toBeLessThan(1e-6);
  });
});

describe('viewmodel gun models', () => {
  it.each(ARCHETYPES)('%s: within budget (meshes, draw groups, triangles) with a lamp and a seam', (archetype) => {
    const bp = gunBlueprint(archetype);
    expect(bp.nodes.length).toBeLessThanOrEqual(12);
    const groups = bp.nodes.reduce((s, n) => s + n.slots.length, 0);
    expect(groups).toBeLessThanOrEqual(40);
    expect(bp.triangles).toBeLessThanOrEqual(6000);
    const slots = new Set(bp.nodes.flatMap((n) => n.slots));
    expect(slots.has('lamp')).toBe(true);
    expect(slots.has('accent')).toBe(true);
    expect(slots.has('screen')).toBe(archetype === 'rifle' || archetype === 'sniper');
    const lo = gunBlueprint(archetype, 'lo');
    expect(lo.nodes.length).toBe(1);
    expect(lo.triangles).toBeLessThan(bp.triangles);
  });

  it.each(ARCHETYPES)('%s: aiming down sights puts the sight line on the screen centre', (archetype) => {
    if (archetype === 'sniper') return; // scoped: the gun lowers and the HUD draws the scope
    equip(gun(archetype));
    ctl.aimBlend = 1;
    ctl.aimZoom = 1.2;
    step(0.3);
    const model = pivot().children.find((o) => o.name.startsWith('gun:'))!;
    const p = model.localToWorld(new THREE.Vector3(0, GUN_SIGHT_Y[archetype], -0.1));
    const local = ctx.camera.worldToLocal(p);
    expect(Math.abs(local.x)).toBeLessThan(1e-3);
    expect(Math.abs(local.y)).toBeLessThan(1e-3);
    expect(local.z).toBeLessThan(-0.1);
  });

  it('keeps the growth tags: chained barrels, a scope, mags with end parts', () => {
    const roles = (a: WeaponArchetype) => gunBlueprint(a).nodes.map((n) => n.userData.vmRole ?? n.userData.vmAnim);
    expect(roles('smg').filter((r) => r === 'barrel').length).toBe(2);
    expect(roles('rifle')).toEqual(expect.arrayContaining(['barrel', 'scope', 'mag', 'magEnd', 'handle']));
    expect(roles('sniper')).toEqual(expect.arrayContaining(['barrel', 'scope', 'mag', 'magEnd', 'bolt']));
    expect(roles('shotgun')).toEqual(expect.arrayContaining(['barrel', 'muzzle', 'pump']));
    expect(roles('pistol')).toEqual(expect.arrayContaining(['slide', 'mag', 'magPart', 'barrel']));
  });
});
