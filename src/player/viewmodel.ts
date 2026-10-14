/**
 * Procedural first-person gun. Built from boxes/cylinders per archetype, parented to the
 * camera, animated with sway, bob, recoil kick, reload, swap, melee bash and grenade throw.
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

/** Presentation-only randomness (kick roll, muzzle flash): keeps the sim RNG (ctx.rng) deterministic. */
const presRng = createRng(0x7e3a1);

const VM_SCALE = 0.5;
const VM_BASE = new THREE.Vector3(0.16, -0.15, -0.28); // camera-local
const SWAP_LOWER = 0.14;
const SWAP_RAISE = 0.2;
/** Total time a weapon swap blocks firing. */
export const SWAP_TIME = SWAP_LOWER + SWAP_RAISE;
const BASH_TIME = 0.32;
const THROW_TIME = 0.45;
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
}

interface GunMats {
  body: THREE.Material;
  dark: THREE.Material;
  accent: THREE.Material;
}

type GunBuilder = (p: Parts, m: GunMats) => THREE.Vector3; // returns muzzle position

const BUILDERS: Record<WeaponArchetype, GunBuilder> = {
  pistol(p, m) {
    p.box(0.065, 0.07, 0.3, m.body, 0, 0.05, -0.1); // slide
    p.box(0.06, 0.045, 0.22, m.dark, 0, 0.0, -0.08); // frame
    p.box(0.055, 0.15, 0.075, m.dark, 0, -0.08, 0.02, -0.25); // grip
    p.box(0.012, 0.05, 0.05, m.dark, 0, -0.035, -0.06); // trigger guard
    p.cyl(0.017, 0.06, m.dark, 0, 0.05, -0.27).userData.vmRole = 'barrel';
    p.box(0.07, 0.012, 0.2, m.accent, 0, 0.068, -0.1); // glow strip
    p.box(0.012, 0.022, 0.02, m.accent, 0, 0.095, -0.22); // front sight
    p.box(0.058, 0.02, 0.02, m.accent, 0, -0.15, 0.04, -0.25); // grip cap
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
    return new THREE.Vector3(0, 0.05, -0.5);
  },
  shotgun(p, m) {
    p.box(0.1, 0.11, 0.26, m.body, 0, 0.03, -0.04); // receiver
    p.cyl(0.025, 0.52, m.dark, -0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
    p.cyl(0.025, 0.52, m.dark, 0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
    p.box(0.1, 0.06, 0.18, m.body, 0, 0.01, -0.34); // forend
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
    p.cyl(0.012, 0.07, m.dark, 0.05, 0.06, 0.02, 6); // bolt handle
    p.box(0.084, 0.014, 0.36, m.accent, 0, 0.065, -0.1); // side strip
    return new THREE.Vector3(0, 0.055, -0.9);
  },
};

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
  private reloadT = 0;
  private reloadDur = 0;
  private bashT = -1;
  private throwT = -1;
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
    this.root.position.copy(VM_BASE);
    this.root.scale.setScalar(VM_SCALE);
    this.root.add(this.pivot);

    this.buildArm();

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
    this.reloadDur = 0;
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

  startReload(duration: number): void {
    this.reloadDur = Math.max(0.05, duration);
    this.reloadT = 0;
  }

  cancelReload(): void {
    this.reloadDur = 0;
  }

  bash(): void {
    this.bashT = 0;
  }

  throwAnim(): void {
    this.throwT = 0;
  }

  setDead(dead: boolean): void {
    this.dead = dead;
    if (!dead) this.deadT = 0;
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

    // reload: drop + rotate, with a little mag-slap jolt
    let drop = 0;
    let jolt = 0;
    if (this.reloadDur > 0) {
      this.reloadT += dt;
      const p = this.reloadT / this.reloadDur;
      if (p >= 1) {
        this.reloadDur = 0;
      } else {
        drop = p < 0.2 ? smooth(p / 0.2) : p > 0.8 ? smooth((1 - p) / 0.2) : 1;
        jolt = Math.exp(-(((p - 0.55) / 0.06) ** 2));
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

    // grenade throw (gun dips out of the way)
    let throwLower = 0;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const p = this.throwT / THROW_TIME;
      if (p >= 1) this.throwT = -1;
      else throwLower = Math.sin(p * Math.PI) * 0.7;
    }

    // death: lower the gun out of view
    if (this.dead) this.deadT = Math.min(1, this.deadT + dt * 2.5);
    else this.deadT = Math.max(0, this.deadT - dt * 4);
    const deadLower = smooth(this.deadT);

    const lower = Math.max(swapLower, throwLower, deadLower, scoped ? aim : 0);
    // sights pose (not for scopes: those drop away and the HUD draws the scope)
    const sights = scoped ? 0 : aim;
    this.scopedDown = scoped && aim > 0.5;
    const sightY = SIGHT_Y[this.current?.archetype ?? 'rifle'] ?? SIGHT_Y.rifle;

    this.pivot.position.set(
      this.swayX + bx - bash * 0.1 - this.sprintT * 0.03 + sights * ADS_X,
      this.swayY + by - lower * 0.45 - drop * 0.12 - this.sprintT * 0.05 + this.airT * 0.015 * steady + jolt * 0.025 + sights * (ADS_Y - sightY),
      this.kickZ * steady - bash * 0.32 + drop * 0.05 + sights * ADS_PULL,
    );
    this.pivot.rotation.set(
      this.kickRot - lower * 0.9 - drop * 0.35 - this.sprintT * 0.25 + jolt * 0.12 + this.airT * 0.04,
      this.swayX * 2.5 + this.sprintT * 0.55 + bash * 0.45,
      -this.swayX * 1.5 + drop * 0.8 + bash * 0.9 + this.kickRoll,
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
