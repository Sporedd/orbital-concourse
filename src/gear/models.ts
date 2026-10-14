/**
 * Parametric procedural gear models, built to docs/ART_DIRECTION.md §8 ("Gear growth"):
 * heavy rectilinear slabs with 45° chamfers, no organic horns. Item level (def.growth 0..1)
 * grows every piece continuously (bigger slabs, taller crests, thicker soles, longer cuffs)
 * and adds parts in discrete steps:
 *    ilvl 1  (growth 0)       base slabs
 *    ilvl 5  (STEP_RIBS)      + ribs / lames / knuckle studs
 *    ilvl 10 (STEP_FINS)      + fins (helm temple blades, chest heat sinks, boot heel fins, forearm fins)
 *    ilvl 20 (STEP_MASTS)     + antenna masts (helm, chest) and double plates (all)
 * Rarity is the only colour: emissive seams at lum 1.2 (uncommon..epic), lum 2.5 pulsing plus
 * slow motes for legendaries (animate(t)); commons have no seams. Visors glow BONE.
 *
 * Everything uses SHARED unit geometries (scaled per use), so a model owns no geometry;
 * materials are cached per MaterialFactory. A legendary owns its pulsing seam material, which
 * dispose() frees.
 *
 * Anchor conventions (metres; the paper doll and future co-op avatars attach to these):
 *  helm    origin = head centre (head ~0.2 x 0.24 x 0.22), face looks +Z
 *  chest   origin = torso centre (torso ~0.38 x 0.52 x 0.22), front +Z, shoulders at y ~ +0.21
 *  boots   each boot origin = ankle, foot points +Z, sole bottom at y = -(0.088 + soleThickness)
 *  gloves  each glove origin = wrist, hand hangs along -Y, back of the hand faces +Z
 *  trinket origin = charm centre (floats; the doll hovers it beside the hip)
 */
import * as THREE from 'three';
import type { MaterialFactory } from '@/core/types';
import { createRng } from '@/core/rng';
import { GEAR_PALETTE, GEAR_TOON_HATCH, RARITY_FINISH, VISOR_LUM, glowLum } from './palette';
import { growthForLevel, rarityIndex } from './generator';
import type { GearDef, GearSetId, GearSlot } from './types';

/** Discrete growth steps (ART_DIRECTION §8), as growth values of item levels 5 / 10 / 20. */
export const STEP_RIBS = growthForLevel(5);
export const STEP_FINS = growthForLevel(10);
export const STEP_MASTS = growthForLevel(20);

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------
export interface SharedGeo {
  box: THREE.BoxGeometry;
  /** Unit box (1 x 1 x 1, centred) with 45° chamfers on every edge. */
  chamfer: THREE.BufferGeometry;
  /** Unit cylinder, diameter 1, height 1, centred, axis Y (masts, rods). */
  cyl: THREE.CylinderGeometry;
  /** Cone, base diameter 1 at y=0, tip at y=1. */
  cone: THREE.ConeGeometry;
  sphere: THREE.SphereGeometry;
}

let shared: SharedGeo | null = null;

function makeChamferBox(c = 0.14): THREE.BufferGeometry {
  // Octagon cap (cut vertical edges) extruded with a 1-segment bevel (cut top/bottom edges).
  const h = 0.5 - c;
  const k = c * 0.7;
  const s = new THREE.Shape();
  s.moveTo(-h + k, -h);
  s.lineTo(h - k, -h);
  s.lineTo(h, -h + k);
  s.lineTo(h, h - k);
  s.lineTo(h - k, h);
  s.lineTo(-h + k, h);
  s.lineTo(-h, h - k);
  s.lineTo(-h, -h + k);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 1 - 2 * c, bevelEnabled: true, bevelThickness: c, bevelSize: c, bevelSegments: 1, curveSegments: 1,
  });
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  g.center();
  g.scale(1 / size.x, 1 / size.y, 1 / size.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function geo(): SharedGeo {
  if (shared) return shared;
  const cone = new THREE.ConeGeometry(0.5, 1, 4);
  cone.translate(0, 0.5, 0);
  shared = {
    box: new THREE.BoxGeometry(1, 1, 1),
    chamfer: makeChamferBox(),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
    cone,
    sphere: new THREE.SphereGeometry(0.5, 14, 10),
  };
  return shared;
}

// ---------------------------------------------------------------------------
// Materials (cached per factory)
// ---------------------------------------------------------------------------
const matCache = new WeakMap<MaterialFactory, Map<string, THREE.Material>>();

function cached(mf: MaterialFactory, key: string, make: () => THREE.Material): THREE.Material {
  let m = matCache.get(mf);
  if (!m) {
    m = new Map();
    matCache.set(mf, m);
  }
  let mat = m.get(key);
  if (!mat) {
    mat = make();
    m.set(key, mat);
  }
  return mat;
}

const q2 = (v: number) => Math.round(v * 100) / 100;
const toonMat = (mf: MaterialFactory, color: number) =>
  cached(mf, `t:${color}`, () => mf.toon({ color, surface: 'character', hatch: GEAR_TOON_HATCH }));
const glowMat = (mf: MaterialFactory, color: number, intensity: number) =>
  cached(mf, `g:${color}:${q2(intensity)}`, () => mf.glow(color, q2(intensity)));

interface GearMats {
  body: THREE.Material; // STEEL
  dark: THREE.Material; // STEEL_DARK
  plate: THREE.Material; // CONCRETE_LIT plates
  bone: THREE.Material; // BONE stencil plates
  /** Rarity seams; null for commons. Legendary: a per-model instance that pulses. */
  seam: THREE.Material | null;
  /** Legendary motes, else null. */
  mote: THREE.Material | null;
  visor: THREE.Material;
}

function makeMats(def: GearDef, mf: MaterialFactory, own: (m: THREE.Material) => void): GearMats {
  const f = RARITY_FINISH[def.rarity];
  let seam: THREE.Material | null = null;
  if (f.seamLum > 0) {
    const intensity = glowLum(def.accent, f.seamLum);
    if (f.pulse) {
      seam = mf.glow(def.accent, intensity);
      own(seam);
    } else {
      seam = glowMat(mf, def.accent, intensity);
    }
  }
  const visorLum = VISOR_LUM.min + (VISOR_LUM.max - VISOR_LUM.min) * def.growth;
  return {
    body: toonMat(mf, def.color),
    dark: toonMat(mf, GEAR_PALETTE.steelDark),
    plate: toonMat(mf, GEAR_PALETTE.concreteLit),
    bone: toonMat(mf, GEAR_PALETTE.bone),
    seam,
    mote: f.motes > 0 ? glowMat(mf, def.accent, glowLum(def.accent, f.seamLum)) : null,
    visor: glowMat(mf, GEAR_PALETTE.bone, glowLum(GEAR_PALETTE.bone, visorLum)),
  };
}

// ---------------------------------------------------------------------------
// Model object
// ---------------------------------------------------------------------------
export type GearModelParams =
  | ({ slot: 'helm' } & HelmParams)
  | ({ slot: 'chest' } & ChestParams)
  | ({ slot: 'boots' } & BootParams)
  | ({ slot: 'gloves' } & GloveParams)
  | ({ slot: 'trinket' } & TrinketParams);

export class GearModel extends THREE.Group {
  /** Boots/gloves: the left (-x) and right (+x) pieces, children of this group in the standalone layout. */
  left: THREE.Group | null = null;
  right: THREE.Group | null = null;
  private readonly animators: ((t: number) => void)[] = [];
  private readonly owned: THREE.Material[] = [];

  constructor(readonly def: GearDef, readonly params: GearModelParams) {
    super();
    this.name = `gear:${def.slot}:${def.id}`;
  }

  /** Idle animation hook (orbiting slabs, legendary seam pulse + motes). t = seconds. */
  animate(t: number): void {
    for (const a of this.animators) a(t);
  }

  /** @internal */
  addAnimator(fn: (t: number) => void): void {
    this.animators.push(fn);
  }

  /** @internal */
  own(m: THREE.Material): void {
    this.owned.push(m);
  }

  /** Per-instance materials this model frees on dispose (legendary pulse seam). */
  get ownedMaterials(): readonly THREE.Material[] {
    return this.owned;
  }

  /** Detach and free per-instance resources. Shared geometries/materials stay alive. */
  dispose(): void {
    this.removeFromParent();
    this.left?.removeFromParent();
    this.right?.removeFromParent();
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.animators.length = 0;
    this.left = this.right = null;
  }
}

function put(
  parent: THREE.Object3D, g: THREE.BufferGeometry, mat: THREE.Material,
  sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(g, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}
type Put = (parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x?: number, y?: number, z?: number, rx?: number, ry?: number, rz?: number) => THREE.Mesh;
const slab: Put = (p, m, ...r) => put(p, geo().chamfer, m, ...r);
const box: Put = (p, m, ...r) => put(p, geo().box, m, ...r);
const rod: Put = (p, m, ...r) => put(p, geo().cyl, m, ...r);

/** BONE stencil plate; set pieces carry their set mark (shape, not colour). */
function stencilPlate(parent: THREE.Object3D, mats: GearMats, w: number, h: number, x: number, y: number, z: number, setId?: GearSetId): void {
  box(parent, mats.bone, w, h, 0.008, x, y, z);
  const zf = z + 0.005;
  const bar = Math.max(0.006, h * 0.16);
  switch (setId) {
    case 'bulwark': // filled square
      box(parent, mats.dark, w * 0.42, h * 0.55, 0.004, x, y, zf);
      break;
    case 'voidrunner': // chevron
      box(parent, mats.dark, w * 0.42, bar, 0.004, x - w * 0.15, y, zf, 0, 0, -0.6);
      box(parent, mats.dark, w * 0.42, bar, 0.004, x + w * 0.15, y, zf, 0, 0, 0.6);
      break;
    case 'pitfighter': // cross
      box(parent, mats.dark, w * 0.6, bar, 0.004, x, y, zf, 0, 0, Math.PI / 4);
      box(parent, mats.dark, w * 0.6, bar, 0.004, x, y, zf, 0, 0, -Math.PI / 4);
      break;
    default: // serial bars
      for (let i = 0; i < 3; i++) box(parent, mats.dark, w * 0.12, h * 0.55, 0.004, x - w * 0.25 + i * w * 0.2, y, zf);
  }
}

/** Mast: base block, rod, tip (seam glow if any). Grows from (x, y, z) upward. */
function mast(parent: THREE.Object3D, mats: GearMats, len: number, x: number, y: number, z: number, lean: number): void {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.z = lean;
  parent.add(g);
  slab(g, mats.dark, 0.04, 0.03, 0.04, 0, 0.015, 0);
  rod(g, mats.dark, 0.011, len, 0.011, 0, 0.03 + len / 2, 0);
  box(g, mats.dark, 0.03, 0.006, 0.006, 0, 0.03 + len * 0.7, 0);
  box(g, mats.seam ?? mats.plate, 0.018, 0.018, 0.018, 0, 0.03 + len, 0);
}

// ---------------------------------------------------------------------------
// Growth knobs per slot (pure, exported for tests / UI / co-op avatars)
// ---------------------------------------------------------------------------
const clamp01 = (v: number) => (!Number.isFinite(v) || v < 0 ? 0 : v > 1 ? 1 : v);
const steps = (g: number) => ({ ribs: g >= STEP_RIBS, fins: g >= STEP_FINS, masts: g >= STEP_MASTS });

export interface HelmParams {
  shellScale: number; crestHeight: number; visorWidth: number; visorHeight: number; visorLum: number;
  ribCount: number; finCount: number; finLength: number; mastCount: number; mastLength: number; doublePlates: number;
}
export function helmParams(growth: number, rIdx: number): HelmParams {
  const g = clamp01(growth);
  const s = steps(g);
  return {
    shellScale: 1 + 0.1 * g,
    crestHeight: 0.03 + 0.13 * g,
    visorWidth: 0.15 + 0.06 * g,
    visorHeight: 0.016 + 0.012 * g,
    visorLum: VISOR_LUM.min + (VISOR_LUM.max - VISOR_LUM.min) * g,
    ribCount: s.ribs ? 2 + Math.round(2 * g) : 0,
    finCount: s.fins ? Math.min(3, 1 + Math.round((g - STEP_FINS) * 8)) : 0,
    finLength: 0.06 + 0.12 * g,
    mastCount: s.masts ? (rIdx >= 4 ? 2 : 1) : 0,
    mastLength: 0.18 + 0.22 * g,
    doublePlates: s.masts ? 1 : 0,
  };
}

export interface ChestParams {
  pauldronSize: number; plateLayers: number; ribCount: number; collarHeight: number; plateSize: number;
  finCount: number; finLength: number; mastCount: number; mastLength: number; doublePlates: number;
}
export function chestParams(growth: number, rIdx: number): ChestParams {
  const g = clamp01(growth);
  const s = steps(g);
  return {
    pauldronSize: 0.09 + 0.1 * g,
    plateLayers: 1 + Math.round(3 * g),
    ribCount: s.ribs ? 2 + Math.round(2 * g) : 1,
    collarHeight: 0.02 + 0.08 * g,
    plateSize: 0.05 + 0.06 * g,
    finCount: s.fins ? Math.min(5, 2 + Math.round((g - STEP_FINS) * 10)) : 0,
    finLength: 0.04 + 0.08 * g,
    mastCount: s.masts ? (rIdx >= 4 ? 2 : 1) : 0,
    mastLength: 0.22 + 0.2 * g,
    doublePlates: s.masts ? 1 : 0,
  };
}

export interface BootParams {
  soleThickness: number; greaveHeight: number; ribCount: number; finCount: number; finLength: number; doublePlates: number;
}
export function bootParams(growth: number, _rIdx: number): BootParams {
  const g = clamp01(growth);
  const s = steps(g);
  return {
    soleThickness: 0.025 + 0.05 * g,
    greaveHeight: 0.1 + 0.24 * g,
    ribCount: s.ribs ? 1 + Math.round(2 * g) : 0,
    finCount: s.fins ? (s.masts ? 2 : 1) : 0,
    finLength: 0.04 + 0.08 * g,
    doublePlates: s.masts ? 1 : 0,
  };
}

export interface GloveParams {
  knuckleStuds: number; studLength: number; gauntletLength: number; cuffFlare: number; backPlates: number;
  finCount: number; finLength: number; doublePlates: number;
}
export function gloveParams(growth: number, _rIdx: number): GloveParams {
  const g = clamp01(growth);
  const s = steps(g);
  return {
    knuckleStuds: s.ribs ? Math.min(4, 2 + Math.round(2 * g)) : 0,
    studLength: 0.012 + 0.03 * g,
    gauntletLength: 0.06 + 0.16 * g,
    cuffFlare: 1 + 0.4 * g,
    backPlates: 1 + Math.round(2 * g),
    finCount: s.fins ? Math.min(3, 1 + Math.round((g - STEP_FINS) * 6)) : 0,
    finLength: 0.02 + 0.04 * g,
    doublePlates: s.masts ? 1 : 0,
  };
}

export interface TrinketParams {
  /** Orbiting slabs (the brief's "orbs"). */
  orbCount: number; coreSize: number; orbSize: number; orbitRadius: number; orbitRings: number; spinSpeed: number;
}
export function trinketParams(growth: number, rIdx: number): TrinketParams {
  const g = clamp01(growth);
  return {
    orbCount: Math.min(7, 1 + Math.round(4 * g) + (rIdx >= 4 ? 1 : 0)),
    coreSize: 0.03 + 0.03 * g,
    orbSize: 0.014 + 0.016 * g,
    orbitRadius: 0.085 + 0.09 * g,
    orbitRings: g >= STEP_FINS || rIdx >= 3 ? 2 : 1,
    spinSpeed: 0.6 + 0.8 * g,
  };
}

export function gearModelParams(def: GearDef): GearModelParams {
  const r = rarityIndex(def.rarity);
  switch (def.slot) {
    case 'helm': return { slot: 'helm', ...helmParams(def.growth, r) };
    case 'chest': return { slot: 'chest', ...chestParams(def.growth, r) };
    case 'boots': return { slot: 'boots', ...bootParams(def.growth, r) };
    case 'gloves': return { slot: 'gloves', ...gloveParams(def.growth, r) };
    case 'trinket': return { slot: 'trinket', ...trinketParams(def.growth, r) };
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
function buildHelm(m: GearModel, mats: GearMats, p: HelmParams): void {
  const sc = p.shellScale;
  const front = 0.145 * sc;
  slab(m, mats.body, 0.27 * sc, 0.25 * sc, 0.29 * sc, 0, 0.025, -0.005); // shell monolith
  slab(m, mats.dark, 0.25 * sc, 0.075, 0.05, 0, -0.03, front - 0.01); // visor band
  box(m, mats.visor, p.visorWidth, p.visorHeight, 0.01, 0, -0.03, front + 0.016); // visor slit
  slab(m, mats.plate, 0.2, 0.06, 0.05, 0, -0.098, front - 0.02); // jaw plate
  slab(m, mats.body, 0.23, 0.08, 0.05, 0, -0.08, -0.15 * sc, 0.3); // neck guard
  for (const s of [-1, 1]) {
    slab(m, mats.body, 0.035, 0.13, 0.12, s * 0.142 * sc, -0.06, 0.05); // cheek slab
    if (p.doublePlates) slab(m, mats.plate, 0.02, 0.1, 0.1, s * (0.142 * sc + 0.026), -0.055, 0.05);
    for (let i = 0; i < p.ribCount; i++) {
      const z = p.ribCount === 1 ? 0 : THREE.MathUtils.lerp(0.02, -0.11, i / (p.ribCount - 1));
      box(m, mats.dark, 0.012, 0.15, 0.02, s * (0.135 * sc + 0.006), 0.04, z);
    }
    // temple fins: swept-back blades, the outermost edged with a seam
    for (let i = 0; i < p.finCount; i++) {
      const len = p.finLength * (1 - 0.18 * i);
      const fin = slab(m, i === 0 ? mats.plate : mats.dark, 0.014, len * 0.32, len,
        s * (0.137 * sc + 0.014 + 0.012 * i), 0.07 + 0.035 * i, -0.06 - 0.03 * i - len * 0.25, -0.3, 0, -s * 0.18);
      if (i === 0 && mats.seam) box(m, mats.seam, 0.016, 0.006, len * 0.9, fin.position.x, fin.position.y + len * 0.16, fin.position.z, -0.3, 0, -s * 0.18);
    }
  }
  // crest: the "1 slab" of ilvl 1, taller with level
  const top = 0.025 + 0.125 * sc;
  slab(m, mats.plate, 0.045, p.crestHeight, 0.2 * sc, 0, top + p.crestHeight / 2 - 0.006, -0.015);
  if (mats.seam) {
    box(m, mats.seam, 0.047, 0.007, 0.2 * sc, 0, top + p.crestHeight - 0.006, -0.015);
    box(m, mats.seam, 0.25 * sc, 0.007, 0.008, 0, 0.011, front + 0.016); // brow seam
  }
  for (let k = 0; k < p.mastCount; k++) {
    const s = k === 0 ? -1 : 1;
    mast(m, mats, p.mastLength * (1 - 0.25 * k), s * 0.075, top - 0.02, -0.09, -s * 0.12);
  }
}

function buildChest(m: GearModel, mats: GearMats, p: ChestParams, setId?: GearSetId): void {
  slab(m, mats.body, 0.42, 0.48, 0.26, 0, 0.02, 0); // core
  slab(m, mats.plate, 0.36, 0.2, 0.05, 0, 0.1, 0.14); // chest slab
  if (p.doublePlates) slab(m, mats.plate, 0.28, 0.13, 0.035, 0, 0.115, 0.178);
  for (let i = 0; i < p.ribCount; i++) {
    slab(m, i % 2 ? mats.dark : mats.body, 0.33 - 0.025 * i, 0.05, 0.035, 0, -0.04 - 0.06 * i, 0.135 - 0.004 * i);
  }
  slab(m, mats.dark, 0.22, 0.24, 0.07, 0, 0.06, -0.16); // back power cell
  slab(m, mats.dark, 0.26, p.collarHeight, 0.19, 0, 0.255 + p.collarHeight / 2, -0.005); // gorget

  for (const s of [-1, 1]) {
    const pd = new THREE.Group();
    pd.position.set(s * 0.25, 0.22, 0);
    pd.rotation.z = -s * 0.22;
    m.add(pd);
    const ps = p.pauldronSize;
    const th = 0.045 + 0.25 * ps;
    for (let i = 0; i < p.plateLayers; i++) {
      slab(pd, i === 0 ? mats.plate : mats.body, 2.2 * ps * (1 - 0.07 * i), th, 2 * ps * (1 - 0.05 * i),
        s * 0.014 * i, -th * 0.8 * i, 0, 0, 0, -s * 0.09 * i);
    }
    if (p.doublePlates) slab(pd, mats.plate, 1.4 * ps, th * 0.8, 1.6 * ps, s * 0.01, th * 0.9, 0);
    if (mats.seam) box(pd, mats.seam, 2.2 * ps * 0.92, 0.007, 0.008, 0, th * 0.25, ps + 0.002);
  }

  stencilPlate(m, mats, 2 * p.plateSize * 1.3, 2 * p.plateSize * 0.8, 0, 0.11, 0.169 + (p.doublePlates ? 0.03 : 0), setId);

  for (let i = 0; i < p.finCount; i++) {
    const x = p.finCount === 1 ? 0 : THREE.MathUtils.lerp(-0.08, 0.08, i / (p.finCount - 1));
    box(m, mats.dark, 0.012, 0.18, p.finLength, x, 0.06, -0.195 - p.finLength / 2);
  }
  for (let k = 0; k < p.mastCount; k++) {
    const s = k === 0 ? -1 : 1;
    mast(m, mats, p.mastLength * (1 - 0.2 * k), s * 0.085, 0.18, -0.17, -s * 0.08);
  }
  if (mats.seam) {
    for (const s of [-1, 1]) box(m, mats.seam, 0.007, 0.18, 0.006, s * 0.181, 0.1, 0.166);
    box(m, mats.seam, 0.34, 0.007, 0.006, 0, -0.002, 0.166);
    box(m, mats.seam, 0.15, 0.01, 0.008, 0, 0.13, -0.196); // power cell strip
  }
}

function buildBoot(parent: THREE.Group, mats: GearMats, p: BootParams): void {
  slab(parent, mats.body, 0.115, 0.08, 0.23, 0, -0.05, 0.045); // shoe
  slab(parent, mats.plate, 0.12, 0.055, 0.07, 0, -0.06, 0.15); // toe slab
  box(parent, mats.dark, 0.128, p.soleThickness, 0.26, 0, -0.088 - p.soleThickness / 2, 0.045); // sole
  const gh = p.greaveHeight;
  slab(parent, mats.body, 0.12, gh, 0.125, 0, gh / 2 - 0.02, 0); // greave
  slab(parent, mats.plate, 0.085, gh * 0.85, 0.025, 0, gh / 2 - 0.01, 0.068); // shin plate
  if (p.doublePlates) {
    slab(parent, mats.plate, 0.065, gh * 0.5, 0.02, 0, gh * 0.55, 0.088);
    slab(parent, mats.plate, 0.11, 0.07, 0.06, 0, gh + 0.015, 0.045); // knee plate
  }
  for (let i = 0; i < p.ribCount; i++) {
    const y = THREE.MathUtils.lerp(0.02, gh - 0.05, p.ribCount === 1 ? 0.5 : i / (p.ribCount - 1));
    box(parent, mats.dark, 0.09, 0.012, 0.012, 0, y, 0.083 + (p.doublePlates ? 0.012 : 0));
  }
  for (let i = 0; i < p.finCount; i++) {
    const x = p.finCount === 1 ? 0 : (i - 0.5) * 0.04;
    box(parent, mats.dark, 0.012, gh * 0.45, p.finLength, x, gh * 0.55, -0.0625 - p.finLength / 2, 0.25);
  }
  if (mats.seam) {
    box(parent, mats.seam, 0.131, 0.007, 0.262, 0, -0.086, 0.045); // sole edge
    for (const sx of [-1, 1]) box(parent, mats.seam, 0.006, gh * 0.75, 0.008, sx * 0.061, gh / 2 - 0.02, 0.03);
  }
}

function buildGlove(parent: THREE.Group, mats: GearMats, p: GloveParams, s: number): void {
  slab(parent, mats.body, 0.085, 0.09, 0.045, 0, -0.055, 0); // back of hand
  box(parent, mats.dark, 0.08, 0.05, 0.04, 0, -0.12, 0.005, 0.2); // fingers
  box(parent, mats.dark, 0.025, 0.05, 0.03, -s * 0.05, -0.05, -0.005, 0, 0, s * 0.3); // thumb
  slab(parent, mats.plate, 0.09, 0.03, 0.025, 0, -0.092, 0.028); // knuckle block
  for (let i = 0; i < p.knuckleStuds; i++) {
    const x = p.knuckleStuds === 1 ? 0 : THREE.MathUtils.lerp(-0.03, 0.03, i / (p.knuckleStuds - 1));
    box(parent, mats.dark, 0.016, 0.018, p.studLength, x, -0.092, 0.04 + p.studLength / 2);
  }
  for (let i = 0; i < p.backPlates; i++) box(parent, mats.plate, 0.07, 0.014, 0.012, 0, -0.025 - 0.022 * i, 0.027);
  const gl = p.gauntletLength;
  const cw = 0.1 * p.cuffFlare;
  const cd = 0.09 * p.cuffFlare;
  slab(parent, mats.body, cw, gl, cd, 0, gl / 2, 0); // cuff
  if (p.doublePlates) slab(parent, mats.plate, cw * 0.8, gl * 0.5, 0.02, 0, gl * 0.6, cd / 2 + 0.01);
  for (let i = 0; i < p.finCount; i++) {
    const x = p.finCount === 1 ? 0 : THREE.MathUtils.lerp(-0.025, 0.025, i / (p.finCount - 1));
    box(parent, mats.dark, 0.01, gl * 0.7, p.finLength, x, gl * 0.55, cd / 2 + (p.doublePlates ? 0.02 : 0) + p.finLength / 2);
  }
  if (mats.seam) box(parent, mats.seam, cw + 0.004, 0.008, cd + 0.004, 0, gl - 0.012, 0); // cuff seam
}

function buildTrinket(m: GearModel, mats: GearMats, p: TrinketParams, rIdx: number): void {
  const rng = createRng(m.def.seed);
  const cs = p.coreSize;
  const core = new THREE.Group();
  m.add(core);
  slab(core, rIdx >= 1 ? mats.plate : mats.body, 1.2 * cs, 3 * cs, 1.2 * cs); // obelisk
  slab(core, mats.dark, 1.5 * cs, 0.4 * cs, 1.5 * cs, 0, 1.6 * cs, 0); // cap
  slab(core, mats.dark, 1.5 * cs, 0.4 * cs, 1.5 * cs, 0, -1.6 * cs, 0); // foot
  if (mats.seam) box(core, mats.seam, 1.25 * cs, 0.008, 1.25 * cs, 0, 0.4 * cs, 0);
  const orbMat = rIdx >= 3 ? mats.plate : mats.dark;
  const orbits: THREE.Group[] = [];
  const phase0 = rng() * Math.PI * 2;
  for (let j = 0; j < p.orbitRings; j++) {
    const tilt = new THREE.Group();
    tilt.rotation.set(0.3 + 0.9 * j, 0, rng() * 0.5 - 0.25);
    m.add(tilt);
    const spin = new THREE.Group();
    tilt.add(spin);
    orbits.push(spin);
    const r = p.orbitRadius * (1 + 0.28 * j);
    const n = Math.floor(p.orbCount / p.orbitRings) + (j < p.orbCount % p.orbitRings ? 1 : 0); // round-robin split
    for (let i = 0; i < n; i++) {
      const a = phase0 + (i / n) * Math.PI * 2;
      slab(spin, orbMat, 2 * p.orbSize, 2.8 * p.orbSize, 2 * p.orbSize, Math.cos(a) * r, 0, Math.sin(a) * r, 0, -a, 0).userData.orb = true;
    }
  }
  const speed = p.spinSpeed;
  m.addAnimator((t) => {
    core.position.y = Math.sin(t * 1.4) * 0.008;
    core.rotation.y = t * 0.35;
    for (let j = 0; j < orbits.length; j++) orbits[j].rotation.y = t * speed * (j % 2 ? -1.3 : 1);
  });
}

/** Slow glowing motes rising through the piece's bounds (legendaries). */
function addMotes(model: GearModel, parent: THREE.Object3D, mat: THREE.Material, count: number, seed: number): void {
  parent.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(parent);
  if (b.isEmpty()) return;
  b.min.sub(parent.position);
  b.max.sub(parent.position);
  const rng = createRng(seed);
  const h = b.max.y - b.min.y + 0.1;
  const motes: { mesh: THREE.Mesh; y0: number; speed: number; phase: number }[] = [];
  for (let i = 0; i < count; i++) {
    const mesh = box(parent, mat, 0.008, 0.008, 0.008,
      THREE.MathUtils.lerp(b.min.x - 0.02, b.max.x + 0.02, rng()), 0, THREE.MathUtils.lerp(b.min.z - 0.02, b.max.z + 0.02, rng()));
    mesh.castShadow = false;
    motes.push({ mesh, y0: b.min.y, speed: 0.05 + 0.04 * rng(), phase: rng() * h });
  }
  model.addAnimator((t) => {
    for (const mo of motes) {
      const u = (mo.phase + t * mo.speed) % h;
      mo.mesh.position.y = mo.y0 + u;
      mo.mesh.visible = u > 0.02 && u < h - 0.02;
    }
  });
}

/** Number of meshes under a root (tests / perf budget checks). */
export function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

function addPulse(model: GearModel, seam: THREE.Material | null, phase: number): void {
  if (!seam || !(seam as THREE.MeshBasicMaterial).color) return;
  const mat = seam as THREE.MeshBasicMaterial;
  const base = mat.color.clone();
  model.addAnimator((t) => {
    mat.color.copy(base).multiplyScalar(0.8 + 0.2 * Math.sin(t * 1.6 + phase)); // lum ~2.0..2.5
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Build the third-person model of a gear piece. Origin/orientation per the anchor conventions above. */
export function buildGearModel(def: GearDef, materials: MaterialFactory): GearModel {
  const params = gearModelParams(def);
  const model = new GearModel(def, params);
  const mats = makeMats(def, materials, (m) => model.own(m));
  const finish = RARITY_FINISH[def.rarity];
  const rIdx = rarityIndex(def.rarity);

  switch (params.slot) {
    case 'helm': buildHelm(model, mats, params); break;
    case 'chest': buildChest(model, mats, params, def.setId); break;
    case 'trinket': buildTrinket(model, mats, params, rIdx); break;
    case 'boots':
    case 'gloves': {
      for (const s of [-1, 1]) {
        const side = new THREE.Group();
        side.name = s < 0 ? 'left' : 'right';
        if (params.slot === 'boots') buildBoot(side, mats, params);
        else buildGlove(side, mats, params, s);
        if (mats.mote) addMotes(model, side, mats.mote, Math.ceil(finish.motes / 2), def.seed + s);
        side.position.x = s * (params.slot === 'boots' ? 0.11 : 0.13);
        model.add(side);
        if (s < 0) model.left = side;
        else model.right = side;
      }
      break;
    }
  }
  if (mats.mote && params.slot !== 'boots' && params.slot !== 'gloves') addMotes(model, model, mats.mote, finish.motes, def.seed);
  if (finish.pulse) addPulse(model, mats.seam, (def.seed % 1000) / 159);
  return model;
}

/**
 * First-person glove for the viewmodel hand, in Viewmodel pivot space (before VM_SCALE). It
 * replaces the plain glove box + cuff of Viewmodel.buildArm(): fist around the grip at
 * (0,-0.075,0.035), forearm along (0.07,-0.2,0.34). Knuckle studs face +X / forward.
 */
export function buildGloveViewmodel(def: GearDef, materials: MaterialFactory): GearModel {
  const p = gloveParams(def.growth, rarityIndex(def.rarity));
  const model = new GearModel(def, { slot: 'gloves', ...p });
  model.name = `gear:gloves-vm:${def.id}`;
  const mats = makeMats(def, materials, (m) => model.own(m));

  const fist = new THREE.Group();
  fist.position.set(0, -0.075, 0.035);
  fist.rotation.x = -0.25;
  model.add(fist);
  slab(fist, mats.body, 0.085, 0.095, 0.105); // fist
  slab(fist, mats.plate, 0.016, 0.075, 0.09, 0.047, 0.005, -0.005); // knuckle plate (outer side)
  for (let i = 0; i < p.backPlates; i++) box(fist, mats.plate, 0.06, 0.012, 0.022, 0.005, 0.052, 0.03 - 0.028 * i);
  for (let i = 0; i < p.knuckleStuds; i++) {
    const z = p.knuckleStuds === 1 ? -0.01 : THREE.MathUtils.lerp(-0.035, 0.03, i / (p.knuckleStuds - 1));
    box(fist, mats.dark, p.studLength, 0.018, 0.014, 0.055 + p.studLength / 2, 0.02, z);
  }

  // cuff slab along the forearm
  const dir = new THREE.Vector3(0.07, -0.2, 0.34).normalize();
  const cuff = new THREE.Group();
  cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  cuff.position.set(0, -0.1, 0.07);
  model.add(cuff);
  const len = p.gauntletLength * 1.6;
  const w = 0.12 * p.cuffFlare;
  slab(cuff, mats.body, w, len, w, 0, len / 2, 0);
  if (p.doublePlates) slab(cuff, mats.plate, w * 0.7, len * 0.5, 0.02, 0, len * 0.55, w / 2 + 0.008);
  for (let i = 0; i < p.finCount; i++) {
    box(cuff, mats.dark, p.finLength, len * 0.6, 0.01, w / 2 + p.finLength / 2, len * 0.55, THREE.MathUtils.lerp(-0.025, 0.025, p.finCount === 1 ? 0.5 : i / (p.finCount - 1)));
  }
  if (mats.seam) box(cuff, mats.seam, w + 0.004, 0.008, w + 0.004, 0, len - 0.015, 0);

  model.traverse((o) => {
    o.castShadow = false;
  });
  if (RARITY_FINISH[def.rarity].pulse) addPulse(model, mats.seam, 0);
  return model;
}

/** Free the shared geometries and material caches (full teardown only — every model breaks after this). */
export function disposeGearSharedResources(materials?: MaterialFactory): void {
  if (shared) {
    for (const g of Object.values(shared)) (g as THREE.BufferGeometry).dispose();
    shared = null;
  }
  if (materials) {
    const m = matCache.get(materials);
    if (m) for (const mat of m.values()) mat.dispose();
    matCache.delete(materials);
  }
}

/** Shared unit geometries, for other gear modules (weapon growth add-ons, paper doll). */
export const gearGeometry = geo;
export type { GearSlot };
