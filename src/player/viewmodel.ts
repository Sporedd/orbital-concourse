/**
 * Procedural first-person gun. Built from boxes/cylinders per archetype, parented to the
 * camera, animated with sway, bob, recoil kick, reload, swap, melee bash and grenade throw.
 *
 * Reloads and the grenade throw are keyframe clips (./animations.ts) played on the gun's tagged
 * parts (`userData.vmRole` from weaponGrowth, `userData.vmAnim` for slide/handle/pump/bolt), an
 * off-hand and a hand-held grenade/shell. They compose additively on top of the procedural pose;
 * part rest poses are read when a clip starts, so grown (item-level) mags and barrels just work.
 *
 * The whole viewmodel is built at "real" size and then scaled by VM_SCALE while sitting
 * proportionally closer to the eye: identical on screen, but it pokes into walls far less.
 */
import * as THREE from 'three';
import { createRng } from '@/core/rng';
import { ADS } from '@/core/config';
import { ELEMENT_COLORS, RARITY_COLORS } from '@/core/types';
import { PALETTE, glowLum } from '@/rendering/style';
import type { GameContext, WeaponArchetype, WeaponDef } from '@/core/types';
import { applyWeaponGrowth } from '@/gear/weaponGrowth';
import { buildGloveViewmodel, type GearModel } from '@/gear/models';
import type { GearDef } from '@/gear/types';
import type { Controller } from './controller';
import { clamp, damp, smooth } from './shared';
import {
  THROW_CLIP, THROW_RELEASE, THROW_TIME, inSpans, reloadClip, sample, sampleHand,
  type Anchor, type PoseTracks, type ReloadClip,
} from './animations';

/** Presentation-only randomness (kick roll, muzzle flash): keeps the sim RNG (ctx.rng) deterministic. */
const presRng = createRng(0x7e3a1);

const VM_SCALE = 0.5;
const VM_BASE = new THREE.Vector3(0.16, -0.15, -0.28); // camera-local
const SWAP_LOWER = 0.14;
const SWAP_RAISE = 0.2;
/** Total time a weapon swap blocks firing. */
export const SWAP_TIME = SWAP_LOWER + SWAP_RAISE;
const BASH_TIME = 0.32;
/** An interrupted reload/throw snaps back to the pose over this long. */
const ANIM_CANCEL_TIME = 0.1;
/** Off-hand parking spot below the screen (pivot units) and the throw hand's (root units). */
const OFF_HAND_PARK = new THREE.Vector3(-0.35, -0.6, 0.1);
const THROW_HAND_PARK = new THREE.Vector3(-0.72, -0.6, 0.06);
/** Grenade in the throwing palm (throw-hand local). */
const GRENADE_IN_HAND = new THREE.Vector3(0.0, 0.035, -0.035);
/** Loading port / ejection port the off-hand pushes shells or rounds into (model space). */
const PORTS: Partial<Record<WeaponArchetype, THREE.Vector3>> = {
  shotgun: new THREE.Vector3(0, -0.035, -0.07),
  sniper: new THREE.Vector3(0.02, 0.1, -0.03),
};
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const FLASH_TIME = 0.055;
const FLASH_LIGHT_INTENSITY = 10;
/** The flash light sits ahead of the muzzle (camera-local metres): it lights the world, not the gun. */
const FLASH_LIGHT_AHEAD = 1.1;
/**
 * ADS "sights" pose: the pivot offset (pivot units) that puts the gun's sight line on the screen
 * centre. x cancels VM_BASE.x, y lifts the sight (model y = SIGHT_Y) to the eye line.
 */
const SIGHT_Y: Record<WeaponArchetype, number> = { pistol: 0.108, smg: 0.118, shotgun: 0.1, rifle: 0.166, sniper: 0.145 };
const ADS_X = -VM_BASE.x / VM_SCALE;
const ADS_Y = -VM_BASE.y / VM_SCALE;
/** Pivot z offset while aimed: pushed a little forward so the zoomed FOV doesn't blow the gun up. */
const ADS_PULL = -0.12;
/** Sway/bob that remains while fully aimed. */
const ADS_STEADY = 0.25;

// Brutalist Arena gun (docs/ART_DIRECTION.md §8): STEEL receiver, STEEL_DARK polymer, a rarity
// (or element) seam as the only colour, matte character surfaces.
const STEEL = PALETTE.STEEL;
const DARK = PALETTE.STEEL_DARK;
const SLEEVE = 0x3a3d38;
const GLOVE = 0x1e1f1c;
/** Hand-held grenade: the world grenade's look (src/player/grenades.ts), copied, not imported. */
const GRENADE_BODY = 0x4d5e3a;
const GRENADE_CAP = 0x2a2e38;
const GRENADE_SPARK = 0xffa040;

/** Small builder that tracks geometries for disposal. */
class Parts {
  constructor(private readonly group: THREE.Group, private readonly geoms: THREE.BufferGeometry[]) {}

  box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d);
    this.geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = false;
    m.receiveShadow = false;
    this.group.add(m);
    return m;
  }

  /** Cylinder along the Z axis (barrels, scopes). */
  cyl(r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, seg = 10, r2 = r): THREE.Mesh {
    const g = new THREE.CylinderGeometry(r2, r, len, seg);
    g.rotateX(Math.PI / 2); // axis Y -> Z: radius r at -Z, r2 at +Z
    this.geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    this.group.add(m);
    return m;
  }

  sphere(r: number, mat: THREE.Material, x: number, y: number, z: number, seg = 10): THREE.Mesh {
    const g = new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.75)));
    this.geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    this.group.add(m);
    return m;
  }

  /** A sub-group at (x, y, z) with its own builder (moving assemblies: the sniper bolt). */
  child(x: number, y: number, z: number): [THREE.Group, Parts] {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.group.add(g);
    return [g, new Parts(g, this.geoms)];
  }
}

interface GunMats {
  body: THREE.Material;
  dark: THREE.Material;
  accent: THREE.Material;
}

type GunBuilder = (p: Parts, m: GunMats) => THREE.Vector3; // returns muzzle position

const BUILDERS: Record<WeaponArchetype, GunBuilder> = {
  pistol(p, m) {
    p.box(0.065, 0.07, 0.3, m.body, 0, 0.05, -0.1).userData.vmAnim = 'slide'; // slide
    p.box(0.06, 0.045, 0.22, m.dark, 0, 0.0, -0.08); // frame
    p.box(0.055, 0.15, 0.075, m.dark, 0, -0.08, 0.02, -0.25); // grip
    // magazine inside the grip (hidden while seated; animation-only tag, so weapon growth leaves it)
    p.box(0.044, 0.135, 0.058, m.dark, 0, -0.085, 0.022, -0.25).userData.vmAnim = 'mag';
    p.box(0.012, 0.05, 0.05, m.dark, 0, -0.035, -0.06); // trigger guard
    p.cyl(0.017, 0.06, m.dark, 0, 0.05, -0.27).userData.vmRole = 'barrel';
    p.box(0.07, 0.012, 0.2, m.accent, 0, 0.068, -0.1).userData.vmAnim = 'slide'; // glow strip
    p.box(0.012, 0.022, 0.02, m.accent, 0, 0.095, -0.22).userData.vmAnim = 'slide'; // front sight
    p.box(0.058, 0.02, 0.02, m.accent, 0, -0.15, 0.04, -0.25).userData.vmAnim = 'magPart'; // grip cap = mag base plate
    return new THREE.Vector3(0, 0.05, -0.31);
  },
  smg(p, m) {
    p.box(0.08, 0.1, 0.34, m.body, 0, 0.04, -0.12); // receiver
    p.cyl(0.026, 0.14, m.dark, 0, 0.05, -0.36, 8).userData.vmRole = 'barrel'; // shroud
    p.cyl(0.014, 0.06, m.dark, 0, 0.05, -0.46).userData.vmRole = 'barrel'; // chained after the shroud
    p.box(0.045, 0.26, 0.06, m.dark, 0, -0.13, -0.17, 0.12).userData.vmRole = 'mag'; // long mag
    p.box(0.05, 0.022, 0.066, m.accent, 0, -0.22, -0.18, 0.12).userData.vmRole = 'magEnd'; // mag band
    p.box(0.05, 0.13, 0.07, m.dark, 0, -0.07, 0.03, -0.25); // grip
    p.box(0.05, 0.06, 0.1, m.dark, 0, 0.04, 0.09); // stub stock
    p.box(0.084, 0.016, 0.26, m.accent, 0, 0.065, -0.12); // side strip
    p.box(0.02, 0.03, 0.04, m.dark, 0, 0.1, -0.02); // rear sight
    p.box(0.024, 0.02, 0.032, m.dark, -0.05, 0.07, -0.2).userData.vmAnim = 'handle'; // left cocking knob
    return new THREE.Vector3(0, 0.05, -0.5);
  },
  shotgun(p, m) {
    p.box(0.1, 0.11, 0.26, m.body, 0, 0.03, -0.04); // receiver
    p.cyl(0.025, 0.52, m.dark, -0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
    p.cyl(0.025, 0.52, m.dark, 0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
    p.box(0.1, 0.06, 0.18, m.body, 0, 0.01, -0.34).userData.vmAnim = 'pump'; // forend
    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.098, -0.62).userData.vmRole = 'muzzle'; // muzzle band
    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.032, -0.62).userData.vmRole = 'muzzle';
    p.box(0.104, 0.018, 0.2, m.accent, 0, 0.05, -0.04); // receiver strip
    p.box(0.07, 0.1, 0.24, m.body, 0, -0.02, 0.21, 0.14); // stock
    p.box(0.05, 0.12, 0.07, m.dark, 0, -0.07, 0.06, -0.3); // grip
    return new THREE.Vector3(0, 0.065, -0.69);
  },
  rifle(p, m) {
    p.box(0.08, 0.11, 0.42, m.body, 0, 0.04, -0.12); // receiver
    p.box(0.072, 0.075, 0.18, m.dark, 0, 0.035, -0.4); // handguard
    p.cyl(0.018, 0.24, m.dark, 0, 0.06, -0.5).userData.vmRole = 'barrel';
    p.box(0.05, 0.17, 0.08, m.dark, 0, -0.09, -0.13, 0.25).userData.vmRole = 'mag'; // mag
    p.box(0.05, 0.13, 0.07, m.dark, 0, -0.07, 0.05, -0.25); // grip
    p.box(0.06, 0.1, 0.2, m.body, 0, 0.02, 0.19); // stock
    p.box(0.03, 0.016, 0.26, m.dark, 0, 0.103, -0.12); // scope rail
    p.box(0.045, 0.05, 0.06, m.dark, 0, 0.135, -0.08).userData.vmRole = 'scope'; // red-dot housing
    p.box(0.032, 0.032, 0.006, m.accent, 0, 0.138, -0.112).userData.vmRole = 'scope'; // lens
    p.box(0.084, 0.016, 0.3, m.accent, 0, 0.06, -0.14); // side strip
    p.box(0.076, 0.012, 0.02, m.accent, 0, 0.07, -0.47); // handguard band
    p.box(0.07, 0.014, 0.018, m.dark, 0, 0.1, 0.085).userData.vmAnim = 'handle'; // T charging handle
    return new THREE.Vector3(0, 0.06, -0.63);
  },
  sniper(p, m) {
    p.box(0.08, 0.1, 0.46, m.body, 0, 0.04, -0.1); // receiver
    p.cyl(0.017, 0.52, m.dark, 0, 0.055, -0.58).userData.vmRole = 'barrel'; // long barrel
    p.box(0.045, 0.036, 0.07, m.dark, 0, 0.055, -0.86).userData.vmRole = 'muzzle'; // muzzle brake
    p.box(0.05, 0.012, 0.074, m.accent, 0, 0.075, -0.86).userData.vmRole = 'muzzle';
    p.cyl(0.032, 0.28, m.dark, 0, 0.145, -0.1, 12).userData.vmRole = 'scope'; // scope tube
    p.cyl(0.04, 0.05, m.dark, 0, 0.145, -0.25, 12).userData.vmRole = 'scope'; // objective bell
    p.cyl(0.034, 0.008, m.accent, 0, 0.145, -0.278, 12).userData.vmRole = 'scope'; // front lens
    p.cyl(0.026, 0.008, m.accent, 0, 0.145, 0.042, 12).userData.vmRole = 'scope'; // eyepiece
    p.box(0.02, 0.05, 0.02, m.dark, 0, 0.105, -0.18).userData.vmRole = 'scope'; // scope rings
    p.box(0.02, 0.05, 0.02, m.dark, 0, 0.105, -0.02).userData.vmRole = 'scope';
    p.box(0.065, 0.12, 0.26, m.body, 0, 0.0, 0.25); // stock
    p.box(0.05, 0.08, 0.08, m.dark, 0, -0.04, -0.07).userData.vmRole = 'mag'; // mag
    p.box(0.05, 0.13, 0.07, m.dark, 0, -0.07, 0.06, -0.25); // grip
    // bolt: body on the bore line (slides out the back when open), handle + knob out to the right
    const [bolt, bp] = p.child(0.005, 0.07, 0.03);
    bolt.userData.vmAnim = 'bolt';
    bolt.userData.knob = new THREE.Vector3(0.075, 0, 0);
    bp.cyl(0.018, 0.1, m.dark, 0, 0, 0, 8);
    bp.box(0.07, 0.014, 0.014, m.dark, 0.035, 0, 0);
    bp.sphere(0.016, m.dark, 0.075, 0, 0, 8);
    p.box(0.084, 0.014, 0.36, m.accent, 0, 0.065, -0.1); // side strip
    return new THREE.Vector3(0, 0.055, -0.9);
  },
};

interface PartRest {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  visible: boolean;
}

/** The current gun's animated parts with their rest transforms (read when a clip starts). */
interface Rig {
  all: PartRest[];
  mag: PartRest[];
  slide: PartRest[];
  handle: PartRest[];
  pump: PartRest[];
  bolt: PartRest[];
  /** Magazine down axis, top-front hinge and bottom (hand grip point), model space. */
  magDown: THREE.Vector3;
  magHinge: THREE.Vector3;
  magBottom: THREE.Vector3 | null;
  slideAt: THREE.Vector3 | null;
  handleAt: THREE.Vector3 | null;
  pumpAt: THREE.Vector3 | null;
  knob: THREE.Vector3 | null;
  port: THREE.Vector3 | null;
}

interface ReloadState {
  t: number;
  dur: number;
  u: number;
  /** >= 0 while snapping back after an interruption. */
  cancelT: number;
  clip: ReloadClip | null;
  rig: Rig | null;
}

function meshSize(o: THREE.Object3D): THREE.Vector3 {
  const g = (o as THREE.Mesh).geometry;
  if (!g) return new THREE.Vector3();
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!.getSize(new THREE.Vector3()).multiply(o.scale);
}

/** Collect the animated parts of a built (and grown) gun; their CURRENT transforms are the rest pose. */
function buildRig(model: THREE.Group, archetype: WeaponArchetype): Rig {
  const rest = (o: THREE.Object3D): PartRest => ({ obj: o, pos: o.position.clone(), quat: o.quaternion.clone(), visible: o.visible });
  const rig: Rig = {
    all: [], mag: [], slide: [], handle: [], pump: [], bolt: [],
    magDown: new THREE.Vector3(0, -1, 0), magHinge: new THREE.Vector3(), magBottom: null,
    slideAt: null, handleAt: null, pumpAt: null, knob: null, port: PORTS[archetype]?.clone() ?? null,
  };
  let primary: THREE.Object3D | null = null;
  const growth: THREE.Object3D[] = [];
  for (const o of model.children) {
    const role = o.userData.vmRole as string | undefined;
    const anim = o.userData.vmAnim as string | undefined;
    if (anim === 'mag' || role === 'mag') {
      primary ??= o;
      rig.mag.push(rest(o));
    } else if (anim === 'magPart' || role === 'magEnd') rig.mag.push(rest(o));
    else if (role === 'growth') growth.push(o);
    else if (anim === 'slide') rig.slide.push(rest(o));
    else if (anim === 'handle') rig.handle.push(rest(o));
    else if (anim === 'pump') rig.pump.push(rest(o));
    else if (anim === 'bolt') rig.bolt.push(rest(o));
  }
  if (primary) {
    const s = meshSize(primary);
    rig.magDown.set(0, -1, 0).applyQuaternion(primary.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(primary.quaternion);
    const bottom = primary.position.clone().addScaledVector(rig.magDown, s.y / 2);
    rig.magHinge.copy(primary.position).addScaledVector(rig.magDown, -s.y / 2).addScaledVector(fwd, s.z / 2);
    // the growth mag extension (weaponGrowth) sits on the mag bottom: it rides along
    let ext = false;
    for (const g of growth) {
      if (g.position.distanceTo(bottom) < 0.035) {
        rig.mag.push(rest(g));
        ext = true;
      }
    }
    rig.magBottom = bottom.addScaledVector(rig.magDown, ext ? 0.03 : 0);
  }
  if (rig.slide.length) {
    const main = rig.slide[0].obj;
    rig.slideAt = main.position.clone().add(new THREE.Vector3(0, 0, Math.max(0, meshSize(main).z / 2 - 0.04)));
  }
  if (rig.handle.length) rig.handleAt = rig.handle[0].obj.position.clone();
  if (rig.pump.length) rig.pumpAt = rig.pump[0].obj.position.clone();
  if (rig.bolt.length) rig.knob = (rig.bolt[0].obj.userData.knob as THREE.Vector3 | undefined)?.clone() ?? new THREE.Vector3();
  rig.all = [...rig.mag, ...rig.slide, ...rig.handle, ...rig.pump, ...rig.bolt];
  return rig;
}

function restoreRig(rig: Rig): void {
  for (const p of rig.all) {
    p.obj.position.copy(p.pos);
    p.obj.quaternion.copy(p.quat);
    p.obj.visible = p.visible;
  }
}

export class Viewmodel {
  /** Camera child. */
  readonly root = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private model: THREE.Group | null = null;
  private geoms: THREE.BufferGeometry[] = [];
  private readonly persistentGeoms: THREE.BufferGeometry[] = [];

  private current: WeaponDef | null = null;
  private target: WeaponDef | null = null;
  private swapPhase: 'none' | 'lower' | 'raise' = 'none';
  private swapT = 0;
  private hasModel = false;

  // muzzle flash
  private readonly flashGroup = new THREE.Group();
  private readonly flashVisual = new THREE.Group();
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly flashLight: THREE.PointLight;
  private flashT = 0;

  // animation state
  private swayX = 0;
  private swayY = 0;
  private kickZ = 0;
  private kickRot = 0;
  private kickRoll = 0;
  private sprintT = 0;
  private airT = 0;
  private reload: ReloadState | null = null;
  private bashT = -1;
  private throwT = -1;
  /** >= 0 while the throw snaps back after an interruption (death). */
  private throwCancelT = -1;
  /** Additive pose from the reload/throw clips, this frame. */
  private readonly animPos = new THREE.Vector3();
  private readonly animRot = new THREE.Vector3();
  private adsSuppress = 0;

  // off-hand (reload), throwing hand + hand-held grenade, a shotgun shell in the off-hand
  private readonly offHand: THREE.Group;
  private readonly shell: THREE.Group;
  private readonly throwHand: THREE.Group;
  private readonly grenade: THREE.Group;
  // current clip values the hand anchors resolve against
  private curDrop = 0;
  private curSlide = 0;
  private curHandle = 0;
  private curPump = 0;
  private curBoltBack = 0;
  private curBoltLift = 0;
  private readonly qTilt = new THREE.Quaternion();
  private readonly qTmp = new THREE.Quaternion();
  private readonly vDown = new THREE.Vector3();
  private readonly vHand = new THREE.Vector3();
  private readonly vTmp = new THREE.Vector3();
  private readonly eTmp = new THREE.Euler();
  private dead = false;
  private deadT = 0;
  /** Lowered behind a scope (ADS with zoom ≥ ADS.scopeZoom): tracers start at the eye instead. */
  private scopedDown = false;

  // first-person gloves (gear): replaces the plain glove box + cuff while equipped
  private defaultHand: THREE.Object3D[] = [];
  private gloveModel: GearModel | null = null;

  private readonly toonCache = new Map<number, THREE.Material>();
  private readonly glowCache = new Map<string, THREE.Material>();

  constructor(private readonly ctx: GameContext) {
    this.root.name = 'viewmodel';
    this.root.userData.viewmodel = this; // debug handle (console / headless captures)
    this.root.position.copy(VM_BASE);
    this.root.scale.setScalar(VM_SCALE);
    this.root.add(this.pivot);

    this.buildArm();
    this.offHand = this.buildHand('vmOffHand', new THREE.Vector3(-0.6, -0.65, 0.45));
    this.pivot.add(this.offHand);
    this.shell = this.buildShell();
    this.offHand.add(this.shell);
    this.throwHand = this.buildHand('vmThrowHand', new THREE.Vector3(-0.2, -0.8, 0.55));
    this.root.add(this.throwHand);
    this.grenade = this.buildGrenade();
    this.root.add(this.grenade);

    // muzzle flash (§11): a flat 4-point star at lum 6.5 in the element tint, a pinpoint core and
    // a short thin forward spike; small, so bloom makes the glow rather than the geometry
    this.flashMat = ctx.materials.glow(ELEMENT_COLORS.none, glowLum(ELEMENT_COLORS.none, 6.5, 12));
    this.flashMat.side = THREE.DoubleSide;
    const starShape = new THREE.Shape();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 === 0 ? 0.13 : 0.018;
      if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const star = new THREE.ShapeGeometry(starShape);
    const core = new THREE.SphereGeometry(0.018, 8, 6);
    const cone = new THREE.ConeGeometry(0.02, 0.14, 6);
    cone.rotateX(-Math.PI / 2); // point along -Z
    cone.translate(0, 0, -0.07);
    this.persistentGeoms.push(core, star, cone);
    this.flashVisual.add(new THREE.Mesh(core, this.flashMat), new THREE.Mesh(star, this.flashMat), new THREE.Mesh(cone, this.flashMat));
    this.flashVisual.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    this.flashVisual.visible = false;
    this.flashGroup.add(this.flashVisual);
    this.flashLight = new THREE.PointLight(ELEMENT_COLORS.none, 0, 8, 2);
    this.flashLight.castShadow = false;
    // The light lives on the always-visible root (toggling a light's visibility would change the
    // scene's light count and force a shader recompile); it follows the muzzle every frame.
    this.root.add(this.flashLight);
    this.pivot.add(this.flashGroup);

    this.pivot.visible = false;
  }

  // ---- materials ------------------------------------------------------------
  private toonMat(color: number): THREE.Material {
    let m = this.toonCache.get(color);
    if (!m) {
      m = this.ctx.materials.toon({ color, surface: 'character', rim: 0.12 });
      this.toonCache.set(color, m);
    }
    return m;
  }

  private glowMat(color: number, intensity: number): THREE.Material {
    const key = `${color}:${intensity}`;
    let m = this.glowCache.get(key);
    if (!m) {
      m = this.ctx.materials.glow(color, intensity);
      this.glowCache.set(key, m);
    }
    return m;
  }

  private buildArm(): void {
    const group = new THREE.Group();
    const parts = new Parts(group, this.persistentGeoms);
    const glove = this.toonMat(GLOVE);
    const sleeve = this.toonMat(SLEEVE);
    const fist = parts.box(0.08, 0.09, 0.1, glove, 0.0, -0.075, 0.035, -0.25);
    const dir = new THREE.Vector3(0.07, -0.2, 0.34).normalize();
    const len = 0.46;
    const arm = parts.cyl(0.048, len, sleeve, 0, 0, 0, 10, 0.055);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    arm.position.set(0.0, -0.1, 0.07).addScaledVector(dir, len / 2);
    const cuff = parts.cyl(0.056, 0.05, glove, 0, 0, 0, 10);
    cuff.quaternion.copy(arm.quaternion);
    cuff.position.set(0.0, -0.1, 0.07).addScaledVector(dir, 0.02);
    this.defaultHand = [fist, cuff];
    this.pivot.add(group);
  }

  /**
   * Off-hand: origin = the palm's contact point (the fist hangs below it), sleeve running off-screen
   * along sleeveDir. Hidden until a clip uses it.
   */
  private buildHand(name: string, sleeveDir: THREE.Vector3): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    const parts = new Parts(group, this.persistentGeoms);
    const glove = this.toonMat(GLOVE);
    const sleeve = this.toonMat(SLEEVE);
    parts.box(0.085, 0.07, 0.1, glove, -0.005, -0.04, 0.01); // fist / palm
    parts.box(0.028, 0.026, 0.06, glove, 0.04, -0.012, -0.012); // thumb
    const dir = sleeveDir.clone().normalize();
    const wrist = new THREE.Vector3(-0.01, -0.06, 0.06);
    const q = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, dir);
    const cuff = parts.cyl(0.05, 0.05, glove, 0, 0, 0, 10);
    cuff.quaternion.copy(q);
    cuff.position.copy(wrist).addScaledVector(dir, 0.02);
    const len = 0.55;
    const arm = parts.cyl(0.044, len, sleeve, 0, 0, 0, 10, 0.052);
    arm.quaternion.copy(q);
    arm.position.copy(wrist).addScaledVector(dir, 0.04 + len / 2);
    group.visible = false;
    return group;
  }

  /** Shotgun shell held in the off-hand palm (along the tube axis). */
  private buildShell(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'vmShell';
    const parts = new Parts(g, this.persistentGeoms);
    parts.cyl(0.013, 0.05, this.toonMat(PALETTE.HAZARD_PAINT), 0, 0, 0, 8);
    parts.cyl(0.0145, 0.012, this.toonMat(STEEL), 0, 0, 0.028, 8);
    g.position.set(0, 0.012, 0);
    g.visible = false;
    return g;
  }

  /** The hand-held grenade: the world grenade's sphere + fuse cap + spark, at hand scale. */
  private buildGrenade(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'vmGrenade';
    const parts = new Parts(g, this.persistentGeoms);
    const r = 0.055;
    parts.sphere(r, this.toonMat(GRENADE_BODY), 0, 0, 0, 12);
    const capGeo = new THREE.CylinderGeometry(0.02, 0.022, 0.026, 8);
    this.persistentGeoms.push(capGeo);
    const cap = new THREE.Mesh(capGeo, this.toonMat(GRENADE_CAP));
    cap.position.y = r + 0.006;
    cap.castShadow = false;
    g.add(cap);
    parts.sphere(0.012, this.glowMat(GRENADE_SPARK, 2.5), 0, r + 0.03, 0, 6);
    g.visible = false;
    return g;
  }

  /** Show equipped gloves on the first-person hand (null = the plain default glove). */
  setGloves(def: GearDef | null): void {
    if ((this.gloveModel?.def.id ?? null) === (def?.id ?? null)) return;
    if (this.gloveModel) {
      this.gloveModel.removeFromParent();
      this.gloveModel.dispose();
    }
    this.gloveModel = def ? buildGloveViewmodel(def, this.ctx.materials) : null;
    if (this.gloveModel) this.pivot.add(this.gloveModel);
    for (const o of this.defaultHand) o.visible = !this.gloveModel;
  }

  // ---- weapon model ---------------------------------------------------------
  /** Show a weapon (null hides the gun). With animate, lowers the old one first. */
  setWeapon(def: WeaponDef | null, animate: boolean): void {
    if (def === this.target && (this.swapPhase !== 'none' || def === this.current)) return;
    this.target = def;
    this.cancelReload();
    if (!animate || !this.current || !this.hasModel) {
      this.applyTarget();
      this.swapPhase = 'raise';
      this.swapT = 0;
    } else if (this.swapPhase !== 'lower') {
      // if mid-raise, lower from roughly where we are
      const startLower = this.swapPhase === 'raise' ? 1 - smooth(this.swapT / SWAP_RAISE) : 0;
      this.swapPhase = 'lower';
      this.swapT = startLower * SWAP_LOWER;
    }
  }

  private applyTarget(): void {
    const def = this.target;
    // a reload snapping back finishes now; one started mid-swap re-binds to the new gun below
    if (this.reload && (this.reload.cancelT >= 0 || !def)) this.endReload();
    else if (this.reload?.rig) restoreRig(this.reload.rig);
    this.disposeModel();
    this.current = def;
    if (!def) {
      this.hasModel = false;
      return;
    }
    const group = new THREE.Group();
    const parts = new Parts(group, this.geoms);
    const element = def.element;
    // rarity seam; the element tints the seam and the muzzle; common reads as a dim BONE strip
    const seam = element !== 'none' ? ELEMENT_COLORS[element] : def.rarity === 'common' ? PALETTE.BONE : RARITY_COLORS[def.rarity];
    const mats: GunMats = {
      body: this.toonMat(STEEL),
      dark: this.toonMat(DARK),
      accent: this.glowMat(seam, def.rarity === 'common' && element === 'none' ? glowLum(seam, 0.45, 12) : glowLum(seam, 1.2, 12)),
    };
    const builder = BUILDERS[def.archetype] ?? BUILDERS.rifle;
    const muzzle = builder(parts, mats);
    // gear §6a: barrel/mag/optic grow with item level, fins + brake stages at high levels
    const grownMuzzle = applyWeaponGrowth(group, def, { dark: mats.dark, body: mats.body, seam: def.rarity === 'common' ? null : mats.accent }, muzzle);
    this.model = group;
    this.pivot.add(group);
    this.flashGroup.position.copy(grownMuzzle);
    const fc = ELEMENT_COLORS[element];
    this.flashMat.color.setHex(fc).multiplyScalar(glowLum(fc, 6.5, 12));
    this.flashLight.color.setHex(fc);
    this.hasModel = true;
    this.bindReload();
  }

  private disposeModel(): void {
    if (this.model) {
      this.model.removeFromParent();
      this.model = null;
    }
    for (const g of this.geoms) g.dispose();
    this.geoms = [];
  }

  // ---- triggers -------------------------------------------------------------
  kick(back: number, rot: number): void {
    this.kickZ = Math.min(this.kickZ + back, 0.28);
    this.kickRot = Math.min(this.kickRot + rot, 0.7);
    this.kickRoll = clamp(this.kickRoll + (presRng() - 0.5) * rot * 0.5, -0.2, 0.2);
  }

  flash(): void {
    this.flashT = FLASH_TIME;
    this.flashVisual.visible = true;
    this.flashVisual.rotation.z = presRng() * Math.PI;
    this.flashVisual.scale.setScalar(0.8 + presRng() * 0.5);
    this.flashLight.intensity = FLASH_LIGHT_INTENSITY;
  }

  /**
   * Play the current archetype's reload over `duration` seconds (the weapon system's reloadTime x
   * stats). The gun parts' current transforms are the rest pose the clip returns to.
   */
  startReload(duration: number): void {
    this.endReload();
    this.reload = { t: 0, dur: Math.max(0.05, duration), u: 0, cancelT: -1, clip: null, rig: null };
    this.bindReload();
  }

  /** Interrupt the reload (swap, death, ...): the parts and the hand snap back over 0.1 s. */
  cancelReload(): void {
    if (this.reload && this.reload.cancelT < 0) this.reload.cancelT = 0;
  }

  /** True while a reload clip (or its snap-back) is playing. */
  get reloading(): boolean {
    return !!this.reload;
  }

  /** True while the grenade throw clip (or its snap-back) is playing. */
  get throwing(): boolean {
    return this.throwT >= 0;
  }

  bash(): void {
    this.bashT = 0;
  }

  /** Grenade throw: the gun dips away, the off-hand winds up and releases at THROW_RELEASE. */
  throwAnim(): void {
    this.throwT = 0;
    this.throwCancelT = -1;
  }

  /** Interrupt the throw: everything snaps back over 0.1 s. */
  cancelThrow(): void {
    if (this.throwT >= 0 && this.throwCancelT < 0) this.throwCancelT = 0;
  }

  setDead(dead: boolean): void {
    this.dead = dead;
    if (dead) {
      this.cancelReload();
      this.cancelThrow();
    } else this.deadT = 0;
  }

  private bindReload(): void {
    const r = this.reload;
    if (!r) return;
    if (!this.model || !this.current) {
      r.clip = null;
      r.rig = null;
      return;
    }
    r.rig = buildRig(this.model, this.current.archetype);
    r.clip = reloadClip(this.current.archetype, r.dur);
  }

  private endReload(): void {
    if (this.reload?.rig) restoreRig(this.reload.rig);
    this.reload = null;
    this.offHand.visible = false;
    this.shell.visible = false;
    this.curDrop = this.curSlide = this.curHandle = this.curPump = this.curBoltBack = this.curBoltLift = 0;
  }

  private addPose(tr: PoseTracks, t: number, w: number): void {
    this.animPos.x += sample(tr.px, t) * w;
    this.animPos.y += sample(tr.py, t) * w;
    this.animPos.z += sample(tr.pz, t) * w;
    this.animRot.x += sample(tr.rx, t) * w;
    this.animRot.y += sample(tr.ry, t) * w;
    this.animRot.z += sample(tr.rz, t) * w;
  }

  /** Current (animated) rig point an off-hand key is relative to. */
  private readonly resolveAnchor = (a: Anchor, out: THREE.Vector3): THREE.Vector3 => {
    const rig = this.reload?.rig;
    switch (a) {
      case 'mag':
        if (rig?.magBottom) {
          return out.copy(rig.magBottom).sub(rig.magHinge).applyQuaternion(this.qTilt).add(rig.magHinge)
            .addScaledVector(this.vDown, this.curDrop);
        }
        break;
      case 'slide':
        if (rig?.slideAt) return out.copy(rig.slideAt).setZ(rig.slideAt.z + this.curSlide);
        break;
      case 'handle':
        if (rig?.handleAt) return out.copy(rig.handleAt).setZ(rig.handleAt.z + this.curHandle);
        break;
      case 'pump':
        if (rig?.pumpAt) return out.copy(rig.pumpAt).setZ(rig.pumpAt.z + this.curPump);
        break;
      case 'bolt':
        if (rig?.knob && rig.bolt.length) {
          const b = rig.bolt[0].obj;
          return out.copy(rig.knob).applyQuaternion(b.quaternion).add(b.position);
        }
        break;
      case 'port':
        if (rig?.port) return out.copy(rig.port);
        break;
      default:
        break;
    }
    return out.copy(OFF_HAND_PARK);
  };

  /** Pose the rig at clip time u, blended by w (1 = full clip, 0 = rest; < 1 while snapping back). */
  private applyReload(r: ReloadState, u: number, w: number): void {
    const { clip, rig } = r;
    if (!clip || !rig) return;
    // magazine: rock about the top-front hinge, then travel along its (rocked) down axis
    this.curDrop = sample(clip.magDrop, u) * w;
    this.qTilt.setFromAxisAngle(AXIS_X, sample(clip.magTilt, u) * w);
    this.vDown.copy(rig.magDown).applyQuaternion(this.qTilt);
    const magHidden = w > 0.5 && inSpans(clip.magHidden, u);
    for (const p of rig.mag) {
      p.obj.position.copy(p.pos).sub(rig.magHinge).applyQuaternion(this.qTilt).add(rig.magHinge).addScaledVector(this.vDown, this.curDrop);
      p.obj.quaternion.copy(this.qTilt).multiply(p.quat);
      p.obj.visible = p.visible && !magHidden;
    }
    // sliding parts: rear travel along +z; the sniper bolt also lifts about the bore axis
    this.curSlide = sample(clip.slide, u) * w;
    this.curHandle = sample(clip.handle, u) * w;
    this.curPump = sample(clip.pump, u) * w;
    this.curBoltBack = sample(clip.boltBack, u) * w;
    this.curBoltLift = sample(clip.boltLift, u) * w;
    for (const p of rig.slide) p.obj.position.copy(p.pos).setZ(p.pos.z + this.curSlide);
    for (const p of rig.handle) p.obj.position.copy(p.pos).setZ(p.pos.z + this.curHandle);
    for (const p of rig.pump) p.obj.position.copy(p.pos).setZ(p.pos.z + this.curPump);
    for (const p of rig.bolt) {
      p.obj.position.copy(p.pos).setZ(p.pos.z + this.curBoltBack);
      p.obj.quaternion.copy(p.quat).multiply(this.qTmp.setFromAxisAngle(AXIS_Z, this.curBoltLift));
    }
    this.addPose(clip.gun, u, w);
    this.adsSuppress = Math.max(this.adsSuppress, w * clamp(Math.min(u / 0.08, (1 - u) / 0.1), 0, 1));
    // off-hand follows its anchors; parks below the screen as w -> 0
    sampleHand(clip.hand, u, this.resolveAnchor, this.vHand);
    this.offHand.position.copy(OFF_HAND_PARK).lerp(this.vHand, w);
    const hr = clip.handRot;
    this.offHand.rotation.set(sample(hr?.rx, u) * w, sample(hr?.ry, u) * w, sample(hr?.rz, u) * w);
    this.offHand.visible = true;
    this.shell.visible = w > 0.5 && inSpans(clip.shells, u);
  }

  private throwHandAt(t: number, w: number, pos: THREE.Vector3, rot: THREE.Euler): void {
    const h = THROW_CLIP.hand;
    this.vTmp.set(sample(h.px, t), sample(h.py, t), sample(h.pz, t));
    pos.lerpVectors(THROW_HAND_PARK, this.vTmp, w);
    rot.set(sample(h.rx, t) * w, sample(h.ry, t) * w, sample(h.rz, t) * w);
  }

  private applyThrow(t: number, w: number): void {
    this.addPose(THROW_CLIP.gun, t, w);
    this.throwHandAt(t, w, this.throwHand.position, this.throwHand.rotation);
    this.throwHand.visible = true;
    const g = this.grenade;
    if (t < THROW_RELEASE) {
      g.position.copy(GRENADE_IN_HAND).applyEuler(this.throwHand.rotation).add(this.throwHand.position);
      g.rotation.set(0, 0, 0);
      g.visible = w > 0.5;
    } else {
      // released: a short ballistic arc toward the camera forward, then the world grenade takes over
      const ft = t - THROW_RELEASE;
      this.throwHandAt(THROW_RELEASE, 1, g.position, this.eTmp);
      g.position.add(this.vHand.copy(GRENADE_IN_HAND).applyEuler(this.eTmp));
      g.position.addScaledVector(THROW_CLIP.velocity, ft);
      g.position.y += 0.5 * THROW_CLIP.gravity * ft * ft;
      g.rotation.set(-ft * 14, ft * 3, 0);
      g.visible = w > 0.5 && ft < THROW_CLIP.flight;
    }
  }

  private endThrow(): void {
    this.throwT = -1;
    this.throwCancelT = -1;
    this.throwHand.visible = false;
    this.grenade.visible = false;
  }

  /** World position of the muzzle (falls back to just in front of the camera). */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.hasModel && this.pivot.visible && !this.scopedDown) return this.flashGroup.getWorldPosition(out);
    const cam = this.ctx.camera;
    cam.getWorldPosition(out);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    return out.addScaledVector(dir, 0.3);
  }

  // ---- per frame ------------------------------------------------------------
  update(dt: number, c: Controller): void {
    // swap state machine
    let swapLower = 0;
    if (this.swapPhase === 'lower') {
      this.swapT += dt;
      swapLower = smooth(this.swapT / SWAP_LOWER);
      if (this.swapT >= SWAP_LOWER) {
        this.applyTarget();
        this.swapPhase = 'raise';
        this.swapT = 0;
        swapLower = 1;
      }
    } else if (this.swapPhase === 'raise') {
      this.swapT += dt;
      swapLower = 1 - smooth(this.swapT / SWAP_RAISE);
      if (this.swapT >= SWAP_RAISE) this.swapPhase = 'none';
    }

    // aim down sights: blend toward the centred sights pose (scoped guns lower out of view)
    const aim = this.current ? c.aimBlend : 0;
    const scoped = aim > 0 && c.aimZoom >= ADS.scopeZoom;
    const steady = 1 - aim * (1 - ADS_STEADY);

    // sway from mouse movement
    const tx = clamp(-c.lookDX * 0.0006, -0.05, 0.05) * steady;
    const ty = clamp(c.lookDY * 0.0006, -0.05, 0.05) * steady;
    this.swayX += (tx - this.swayX) * damp(9, dt);
    this.swayY += (ty - this.swayY) * damp(9, dt);

    // bob
    const amt = c.moveAmount * (c.sprinting ? 1.4 : 1) * steady;
    const bx = Math.cos(c.bobPhase) * 0.02 * amt;
    const by = -Math.abs(Math.sin(c.bobPhase)) * 0.022 * amt;

    this.sprintT += ((c.sprinting && c.horizontalSpeed > 3 ? 1 : 0) - this.sprintT) * damp(8, dt);
    this.airT += ((c.onGround ? 0 : 1) - this.airT) * damp(6, dt);

    // recoil recovery
    this.kickZ -= this.kickZ * damp(14, dt);
    this.kickRot -= this.kickRot * damp(11, dt);
    this.kickRoll -= this.kickRoll * damp(10, dt);

    // reload / throw clips: additive pose + rig parts (snap back over ANIM_CANCEL_TIME when cut)
    this.animPos.set(0, 0, 0);
    this.animRot.set(0, 0, 0);
    this.adsSuppress = 0;
    const r = this.reload;
    if (r) {
      if (r.cancelT >= 0) {
        r.cancelT += dt;
        if (r.cancelT >= ANIM_CANCEL_TIME) this.endReload();
        else this.applyReload(r, r.u, 1 - smooth(r.cancelT / ANIM_CANCEL_TIME));
      } else {
        r.t += dt;
        r.u = r.t / r.dur;
        if (r.u >= 1) this.endReload();
        else this.applyReload(r, r.u, 1);
      }
    }
    if (this.throwT >= 0) {
      if (this.throwCancelT >= 0) {
        this.throwCancelT += dt;
        if (this.throwCancelT >= ANIM_CANCEL_TIME) this.endThrow();
        else this.applyThrow(this.throwT, 1 - smooth(this.throwCancelT / ANIM_CANCEL_TIME));
      } else {
        this.throwT += dt;
        if (this.throwT >= THROW_TIME) this.endThrow();
        else this.applyThrow(this.throwT, 1);
      }
    }

    // melee bash
    let bash = 0;
    if (this.bashT >= 0) {
      this.bashT += dt;
      const p = this.bashT / BASH_TIME;
      if (p >= 1) this.bashT = -1;
      else bash = p < 0.3 ? smooth(p / 0.3) : 1 - smooth((p - 0.3) / 0.7);
    }

    // death: lower the gun out of view
    if (this.dead) this.deadT = Math.min(1, this.deadT + dt * 2.5);
    else this.deadT = Math.max(0, this.deadT - dt * 4);
    const deadLower = smooth(this.deadT);

    // a reload visually leaves the sights (and returns at its end) even if aimBlend lingers
    const aimVis = aim * (1 - this.adsSuppress);
    const lower = Math.max(swapLower, deadLower, scoped ? aimVis : 0);
    // sights pose (not for scopes: those drop away and the HUD draws the scope)
    const sights = scoped ? 0 : aimVis;
    this.scopedDown = scoped && aim > 0.5;
    const sightY = SIGHT_Y[this.current?.archetype ?? 'rifle'] ?? SIGHT_Y.rifle;

    const ap = this.animPos;
    const ar = this.animRot;
    this.pivot.position.set(
      this.swayX + bx - bash * 0.1 - this.sprintT * 0.03 + sights * ADS_X + ap.x,
      this.swayY + by - lower * 0.45 - this.sprintT * 0.05 + this.airT * 0.015 * steady + sights * (ADS_Y - sightY) + ap.y,
      this.kickZ * steady - bash * 0.32 + sights * ADS_PULL + ap.z,
    );
    this.pivot.rotation.set(
      this.kickRot - lower * 0.9 - this.sprintT * 0.25 + this.airT * 0.04 + ar.x,
      this.swayX * 2.5 + this.sprintT * 0.55 + bash * 0.45 + ar.y,
      -this.swayX * 1.5 + bash * 0.9 + this.kickRoll + ar.z,
    );

    this.gloveModel?.animate(this.ctx.time.elapsed);

    // muzzle flash decay
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(0, this.flashT / FLASH_TIME);
      this.flashLight.intensity = FLASH_LIGHT_INTENSITY * k;
      if (this.flashT <= 0) {
        this.flashVisual.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    this.pivot.visible = this.hasModel && !(this.dead && this.deadT >= 1);
    this.pivot.updateMatrix();
    this.flashLight.position.copy(this.flashGroup.position).applyMatrix4(this.pivot.matrix);
    this.flashLight.position.z -= FLASH_LIGHT_AHEAD / VM_SCALE;
  }

  dispose(): void {
    this.disposeModel();
    this.gloveModel?.dispose();

    for (const g of this.persistentGeoms) g.dispose();
    this.root.removeFromParent();
  }
}
