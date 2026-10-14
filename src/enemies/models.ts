/**
 * Procedural enemy models. Every kind is built from a handful of shared unit geometries
 * (scaled per part) and per-enemy toon materials (so each enemy can flash/tint on its own).
 * Local space: feet at y=0, facing +Z.
 */
import * as THREE from 'three';
import type { MaterialFactory } from '@/core/types';
import { PALETTE, glowLum } from '@/rendering/style';

// Brutalist Arena enemy palette (docs/ART_DIRECTION.md §1.4, §8): matte olive-grey plates,
// THREAT emissive only on what you should shoot (visor slits, cores, weak points).
const ARMOUR = PALETTE.ARMOUR;
const ARMOUR_LIT = PALETTE.ARMOUR_LIT;
const UNDERSUIT = PALETTE.UNDERSUIT;
const STEEL_DARK = PALETTE.STEEL_DARK;
const THREAT = PALETTE.THREAT;
/**
 * Visor / eye glow: lum 2.0 (threat band 1.5–2.5). The slits are only a few pixels tall at
 * 20–30 m, so they sit at the upper-middle of the band to bloom into a readable red dash.
 */
const VISOR = glowLum(THREAT, 2.0, 12);
/** Back-rim on enemies (spec max 0.5): FLOODLIGHT edge so the olive plates separate from concrete. */
const ENEMY_RIM = 0.38;
/** Emissive multiplier that puts THREAT at a luminance target. */
const threatK = (lum: number) => glowLum(THREAT, lum, 12);

export interface Rig {
  root: THREE.Group;
  /** Torso pivot (bob / lean). */
  body: THREE.Group;
  bodyBaseY: number;
  head: THREE.Object3D | null;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  /** Named extra parts (sac, bomb, mouth, weak point, mortar, halo...). */
  parts: Record<string, THREE.Object3D>;
  /** Flashable toon materials and their resting emissive colour. */
  mats: THREE.MeshToonMaterial[];
  baseEmissive: THREE.Color[];
  /** The hot-accent toon material (blinks, pulses). */
  accent: THREE.MeshToonMaterial | null;
  /** Every material created for this rig (disposed on removal). */
  owned: THREE.Material[];
}

type V3 = [number, number, number];

// ---- shared unit geometries --------------------------------------------------------
const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
const SPHERE = () => geo('sphere', () => new THREE.SphereGeometry(1, 12, 9));
const ICO = () => geo('ico', () => new THREE.IcosahedronGeometry(1, 0));
const BOX = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
const CYL = () => geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 8));
const CONE = () => geo('cone', () => new THREE.ConeGeometry(1, 1, 7));
const TORUS = () => geo('torus', () => new THREE.TorusGeometry(1, 0.12, 6, 20));
export const RING_GEO = () => geo('ring', () => new THREE.RingGeometry(0.86, 1, 48));
export const DISC_GEO = () => geo('disc', () => new THREE.CircleGeometry(1, 40));
export const SPHERE_GEO = SPHERE;

class RigBuilder {
  readonly root = new THREE.Group();
  body: THREE.Group = new THREE.Group();
  bodyBaseY = 0;
  head: THREE.Object3D | null = null;
  legs: THREE.Object3D[] = [];
  arms: THREE.Object3D[] = [];
  parts: Record<string, THREE.Object3D> = {};
  mats: THREE.MeshToonMaterial[] = [];
  baseEmissive: THREE.Color[] = [];
  owned: THREE.Material[] = [];
  accent: THREE.MeshToonMaterial | null = null;

  constructor(private readonly mf: MaterialFactory) {
    this.root.rotation.order = 'YXZ';
  }

  toon(color: number, emissive = 0x000000, emissiveIntensity = 1): THREE.MeshToonMaterial {
    // Brutalist look: matte 'character' surface (back-rim); emissive is premultiplied so the
    // hit flash (emissive → white) lands at lum ~1 instead of whiting out threat parts.
    const m = this.mf.toon({ color, emissive, emissiveIntensity: 1, surface: 'character', rim: ENEMY_RIM });
    m.emissive.multiplyScalar(emissiveIntensity);
    this.mats.push(m);
    this.baseEmissive.push(m.emissive.clone());
    this.owned.push(m);
    return m;
  }

  glow(color: number, intensity = 2.2): THREE.Material {
    const m = this.mf.glow(color, intensity);
    this.owned.push(m);
    return m;
  }

  pivot(parent: THREE.Object3D, p: V3, r?: V3): THREE.Group {
    const g = new THREE.Group();
    g.position.set(p[0], p[1], p[2]);
    if (r) g.rotation.set(r[0], r[1], r[2]);
    parent.add(g);
    return g;
  }

  makeBody(y: number): THREE.Group {
    this.body = this.pivot(this.root, [0, y, 0]);
    this.bodyBaseY = y;
    return this.body;
  }

  finish(): Rig {
    return {
      root: this.root, body: this.body, bodyBaseY: this.bodyBaseY, head: this.head,
      legs: this.legs, arms: this.arms, parts: this.parts, mats: this.mats,
      baseEmissive: this.baseEmissive, accent: this.accent, owned: this.owned,
    };
  }
}

const SHADOW_MIN_SIZE = 0.27;

function add(
  parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, p: V3, s: V3 | number, r?: V3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(p[0], p[1], p[2]);
  if (typeof s === 'number') mesh.scale.setScalar(s);
  else mesh.scale.set(s[0], s[1], s[2]);
  if (r) mesh.rotation.set(r[0], r[1], r[2]);
  // Perf: only body-sized parts cast shadows. Claws/eyes/teeth add a shadow-pass draw call
  // each (20 grunts = ~200 extra calls) for shadows a few texels wide.
  if (!g.boundingSphere) g.computeBoundingSphere();
  const size = (g.boundingSphere?.radius ?? 1) * Math.max(mesh.scale.x, mesh.scale.y, mesh.scale.z);
  mesh.castShadow = !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && size >= SHADOW_MIN_SIZE;
  parent.add(mesh);
  return mesh;
}

const SIDES = [-1, 1] as const;

// ---- Grunt: broad armoured brawler, olive plates, THREAT visor slit ------------------
export function buildGrunt(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const fur = b.toon(ARMOUR);
  const dark = b.toon(UNDERSUIT);
  const ice = b.toon(ARMOUR_LIT);
  const hot = b.toon(STEEL_DARK);
  b.accent = hot;
  const eye = b.glow(THREAT, VISOR);

  for (const sx of SIDES) {
    const leg = b.pivot(b.root, [0.2 * sx, 0.8, 0]);
    add(leg, BOX(), dark, [0, -0.38, 0], [0.22, 0.78, 0.26]);
    add(leg, BOX(), dark, [0, -0.76, 0.08], [0.26, 0.1, 0.38]);
    b.legs.push(leg);
  }
  const body = b.makeBody(0.8);
  add(body, SPHERE(), fur, [0, 0.33, 0.02], [0.46, 0.46, 0.38], [0.35, 0, 0]);
  add(body, SPHERE(), dark, [0, 0.04, 0], [0.36, 0.2, 0.3]);
  add(body, CONE(), ice, [0, 0.62, -0.24], [0.1, 0.42, 0.1], [-0.7, 0, 0]);
  add(body, CONE(), ice, [0.18, 0.5, -0.28], [0.08, 0.32, 0.08], [-0.8, 0, -0.3]);
  add(body, CONE(), ice, [-0.18, 0.5, -0.28], [0.08, 0.32, 0.08], [-0.8, 0, 0.3]);

  const head = b.pivot(body, [0, 0.72, 0.24]);
  add(head, ICO(), fur, [0, 0.04, 0], [0.27, 0.24, 0.28]);
  add(head, BOX(), dark, [0, -0.13, 0.1], [0.3, 0.1, 0.28]);
  add(head, BOX(), eye, [0, 0.05, 0.25], [0.3, 0.045, 0.05]); // horizontal visor slit
  add(head, CONE(), ice, [0, 0.28, -0.05], [0.08, 0.26, 0.08], [-0.35, 0, 0]);
  b.head = head;

  for (const sx of SIDES) {
    const arm = b.pivot(body, [0.44 * sx, 0.52, 0.06]);
    add(arm, CYL(), fur, [0, -0.34, 0], [0.09, 0.68, 0.09]);
    add(arm, SPHERE(), dark, [0, -0.7, 0], 0.12);
    for (const cx of [-0.06, 0, 0.06]) add(arm, CONE(), hot, [cx, -0.88, 0.03], [0.035, 0.22, 0.035], [Math.PI, 0, 0]);
    b.arms.push(arm);
  }
  return b.finish();
}

// ---- Spitter: tall walker, THREAT glow window in its tank ----------------------------
export function buildSpitter(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const skin = b.toon(ARMOUR);
  const dark = b.toon(UNDERSUIT);
  const pale = b.toon(ARMOUR_LIT);
  const hot = b.toon(UNDERSUIT, THREAT, threatK(1.5)); // tank glow window
  b.accent = hot;
  const eye = b.glow(THREAT, VISOR);

  // 4 legs, pivots at the hip ring; splayed outward
  for (const sz of SIDES) {
    for (const sx of SIDES) {
      const leg = b.pivot(b.root, [0.32 * sx, 1.0, 0.3 * sz]);
      add(leg, CYL(), dark, [0.29 * sx, -0.48, 0], [0.06, 1.12, 0.06], [0, 0, 0.55 * sx]);
      add(leg, SPHERE(), pale, [0.18 * sx, -0.3, 0], 0.08);
      b.legs.push(leg);
    }
  }
  const body = b.makeBody(1.0);
  add(body, SPHERE(), skin, [0, 0, -0.1], [0.55, 0.42, 0.72]);
  add(body, SPHERE(), dark, [0, 0.22, 0.14], [0.42, 0.18, 0.42]);
  const sac = b.pivot(body, [0, 0.3, -0.38]);
  add(sac, SPHERE(), hot, [0, 0, 0], [0.36, 0.32, 0.4]);
  b.parts.sac = sac;
  const neck = b.pivot(body, [0, 0.15, 0.5], [0.6, 0, 0]);
  add(neck, CYL(), pale, [0, 0.3, 0], [0.1, 0.62, 0.1]);
  b.parts.neck = neck;

  const head = b.pivot(body, [0, 0.66, 0.85]);
  add(head, SPHERE(), skin, [0, 0.04, -0.02], 0.2);
  add(head, CONE(), pale, [0, 0, 0.2], [0.17, 0.42, 0.17], [Math.PI / 2, 0, 0]);
  add(head, BOX(), eye, [0, 0.1, 0.12], [0.26, 0.04, 0.06]); // visor slit
  const mouth = new THREE.Object3D();
  mouth.position.set(0, 0, 0.45);
  head.add(mouth);
  b.parts.mouth = mouth;
  b.head = head;
  return b.finish();
}

// ---- Bomber: squat hull with a big bright THREAT core --------------------------------
export function buildBomber(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const shell = b.toon(ARMOUR);
  const dark = b.toon(UNDERSUIT);
  const ice = b.toon(ARMOUR_LIT);
  const hot = b.toon(UNDERSUIT, THREAT, threatK(2.5)); // big bright core
  b.accent = hot;
  const eye = b.glow(THREAT, VISOR);
  const spark = b.glow(THREAT, glowLum(THREAT, 2.5, 12));

  for (const sx of SIDES) {
    const leg = b.pivot(b.root, [0.2 * sx, 0.38, 0]);
    add(leg, BOX(), dark, [0, -0.18, 0.02], [0.15, 0.36, 0.2]);
    b.legs.push(leg);
  }
  const body = b.makeBody(0.38);
  add(body, SPHERE(), shell, [0, 0.42, -0.08], [0.48, 0.44, 0.46]);
  const bomb = b.pivot(body, [0, 0.36, 0.2]);
  add(bomb, SPHERE(), hot, [0, 0, 0], [0.36, 0.36, 0.3]);
  b.parts.bomb = bomb;
  const head = b.pivot(body, [0, 0.82, 0.12]);
  add(head, SPHERE(), shell, [0, 0, 0], 0.22);
  add(head, BOX(), eye, [0, 0.04, 0.2], [0.22, 0.035, 0.05]); // visor slit
  b.head = head;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    add(body, CONE(), ice, [Math.sin(a) * 0.3, 0.72, Math.cos(a) * 0.3 - 0.08], [0.07, 0.24, 0.07], [Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5]);
  }
  add(body, CYL(), dark, [0, 1.02, -0.04], [0.03, 0.22, 0.03]);
  const sp = b.pivot(body, [0, 1.15, -0.04]);
  add(sp, SPHERE(), spark, [0, 0, 0], 0.07);
  b.parts.spark = sp;
  for (const sx of SIDES) {
    const arm = b.pivot(body, [0.46 * sx, 0.5, 0.05]);
    add(arm, CONE(), shell, [0, -0.15, 0], [0.08, 0.3, 0.08], [Math.PI, 0, 0]);
    b.arms.push(arm);
  }
  return b.finish();
}

// ---- Brute: bulkhead torso, THREAT chest panel + visor -------------------------------
export function buildBrute(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  // bosses sit a value step darker than mobs (ARMOUR slab, UNDERSUIT joints) so the back-rim,
  // the THREAT panel and the core light carry them: heavier, and they never read as concrete
  const fur = b.toon(ARMOUR);
  const dark = b.toon(UNDERSUIT);
  const ice = b.toon(ARMOUR_LIT);
  const hot = b.toon(UNDERSUIT, THREAT, threatK(2.5)); // chest weak-point panel
  b.accent = hot;
  const eye = b.glow(THREAT, VISOR);

  for (const sx of SIDES) {
    const leg = b.pivot(b.root, [0.6 * sx, 1.3, 0]);
    add(leg, BOX(), dark, [0, -0.55, 0], [0.62, 1.1, 0.66]);
    add(leg, BOX(), dark, [0, -1.2, 0.15], [0.72, 0.22, 0.95]);
    add(leg, CONE(), ice, [0, -0.5, 0.36], [0.12, 0.38, 0.12], [1.2, 0, 0]);
    b.legs.push(leg);
  }
  const body = b.makeBody(1.3);
  add(body, BOX(), dark, [0, 0.1, 0], [1.35, 0.5, 0.85]);
  add(body, SPHERE(), fur, [0, 1.0, 0.05], [1.15, 0.95, 0.85]);
  add(body, BOX(), hot, [0, 1.0, 0.86], [0.42, 0.42, 0.06], [0, 0, Math.PI / 4]);
  for (const sx of SIDES) {
    add(body, CONE(), ice, [0.85 * sx, 1.75, -0.15], [0.22, 0.75, 0.22], [-0.3, 0, -0.4 * sx]);
  }
  add(body, CONE(), ice, [0, 1.55, -0.72], [0.2, 0.7, 0.2], [-0.9, 0, 0]);
  add(body, CONE(), ice, [0.4, 1.2, -0.75], [0.16, 0.5, 0.16], [-1.0, 0, -0.3]);
  add(body, CONE(), ice, [-0.4, 1.2, -0.75], [0.16, 0.5, 0.16], [-1.0, 0, 0.3]);

  const head = b.pivot(body, [0, 1.9, 0.5]);
  add(head, BOX(), fur, [0, 0.12, 0], [0.8, 0.62, 0.72]);
  add(head, BOX(), dark, [0, 0.32, 0.3], [0.85, 0.16, 0.2]);
  add(head, BOX(), dark, [0, -0.2, 0.12], [0.7, 0.22, 0.62]);
  add(head, BOX(), eye, [0, 0.18, 0.37], [0.62, 0.07, 0.06]); // visor slit
  for (const sx of SIDES) add(head, CONE(), dark, [0.42 * sx, 0.45, -0.05], [0.12, 0.6, 0.12], [-0.3, 0, -0.6 * sx]);
  b.head = head;
  b.parts.weak = head;

  for (const sx of SIDES) {
    const arm = b.pivot(body, [1.15 * sx, 1.55, 0.05]);
    add(arm, CYL(), fur, [0, -0.55, 0], [0.32, 1.1, 0.32]);
    add(arm, CYL(), dark, [0, -1.35, 0.05], [0.38, 0.8, 0.38]);
    add(arm, ICO(), dark, [0, -1.9, 0.1], 0.5);
    add(arm, CONE(), ice, [0.2 * sx, -1.95, 0.35], [0.1, 0.35, 0.1], [1.0, 0, 0]);
    b.arms.push(arm);
  }
  return b.finish();
}

// ---- Summoner: floating obelisk, orbiting slabs, THREAT core -------------------------
export function buildSummoner(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const robe = b.toon(UNDERSUIT);
  const robeDark = b.toon(STEEL_DARK);
  const trim = b.toon(ARMOUR_LIT);
  const ice = b.toon(ARMOUR);
  const hot = b.toon(UNDERSUIT, THREAT, threatK(1.5));
  b.accent = hot;
  const coreGlow = b.glow(THREAT, glowLum(THREAT, 2.5, 12));
  const eye = b.glow(THREAT, VISOR);

  const body = b.makeBody(1.7);
  add(body, CONE(), robe, [0, 0.75, 0], [0.95, 1.7, 0.95]);
  add(body, SPHERE(), robe, [0, 1.55, 0], [0.55, 0.62, 0.45]);
  add(body, TORUS(), trim, [0, 1.05, 0], 0.62, [Math.PI / 2, 0, 0]);
  add(body, SPHERE(), trim, [0, 1.88, 0], [0.8, 0.25, 0.55]);
  const core = b.pivot(body, [0, 1.55, 0.42]);
  add(core, ICO(), coreGlow, [0, 0, 0], 0.26);
  add(core, TORUS(), hot, [0, 0, 0], 0.36);
  b.parts.weak = core;

  const head = b.pivot(body, [0, 2.25, 0]);
  add(head, CONE(), robeDark, [0, 0.15, -0.05], [0.45, 0.85, 0.45]);
  add(head, SPHERE(), robeDark, [0, -0.04, 0.1], [0.32, 0.32, 0.28]);
  add(head, BOX(), eye, [0, 0, 0.34], [0.3, 0.045, 0.05]); // visor slit
  b.head = head;

  for (const sx of SIDES) {
    const arm = b.pivot(body, [0.7 * sx, 1.82, 0]);
    add(arm, CYL(), trim, [0, -0.55, 0], [0.08, 1.1, 0.08]);
    add(arm, ICO(), ice, [0, -1.15, 0], 0.13);
    add(arm, CONE(), ice, [0, -1.42, 0], [0.08, 0.36, 0.08], [Math.PI, 0, 0]);
    b.arms.push(arm);
  }
  const halo = b.pivot(body, [0, 1.4, 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(halo, CONE(), ice, [Math.sin(a) * 1.35, 0, Math.cos(a) * 1.35], [0.12, 0.5, 0.12], [0.3, 0, 0]);
  }
  b.parts.halo = halo;
  return b.finish();
}

// ---- Artillery: bunker on four legs, mortar mast, THREAT core on its back ------------
export function buildArtillery(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const steel = b.toon(ARMOUR);
  const dark = b.toon(STEEL_DARK);
  const frost = b.toon(ARMOUR_LIT);
  const hot = b.toon(UNDERSUIT, THREAT, threatK(1.5));
  b.accent = hot;
  const coreGlow = b.glow(THREAT, glowLum(THREAT, 2.5, 12));
  const eye = b.glow(THREAT, VISOR);

  // legs: order FL, FR, BL, BR (diagonal pairs 0/3 and 1/2)
  for (const sz of [1, -1]) {
    for (const sx of SIDES) {
      const leg = b.pivot(b.root, [1.0 * sx, 1.9, 1.0 * sz]);
      add(leg, BOX(), steel, [0.425 * sx, 0.05, 0], [0.86, 0.32, 0.38], [0, 0, 0.12 * sx]);
      add(leg, SPHERE(), dark, [0.85 * sx, 0.1, 0], 0.22);
      add(leg, CYL(), dark, [0.925 * sx, -0.875, 0], [0.16, 1.96, 0.16], [0, 0, 0.077 * sx]);
      add(leg, CYL(), steel, [1.0 * sx, -1.85, 0], [0.32, 0.12, 0.32]);
      b.legs.push(leg);
    }
  }
  const body = b.makeBody(1.9);
  add(body, BOX(), steel, [0, 0.35, 0], [2.2, 1.0, 2.6]);
  add(body, BOX(), dark, [0, -0.2, 0], [1.6, 0.3, 2.0]);
  for (const sx of SIDES) add(body, BOX(), dark, [1.15 * sx, 0.35, 0], [0.2, 0.8, 2.3]);
  add(body, BOX(), dark, [0, 0.95, 1.15], [2.3, 1.3, 0.25]);
  add(body, BOX(), frost, [0, 1.62, 1.15], [2.0, 0.08, 0.3]);
  const head = b.pivot(body, [0, 0.2, 1.5]);
  add(head, BOX(), steel, [0, 0, 0], [1.0, 0.6, 0.6]);
  for (const ex of [-0.25, 0, 0.25]) add(head, SPHERE(), eye, [ex, 0.02, 0.31], 0.07);
  b.head = head;

  const mortar = b.pivot(body, [0, 1.0, 0.3], [0.35, 0, 0]);
  add(mortar, SPHERE(), steel, [0, 0, 0], 0.5);
  add(mortar, CYL(), dark, [0, 0.7, 0], [0.34, 1.4, 0.34]);
  add(mortar, TORUS(), hot, [0, 1.4, 0], 0.38, [Math.PI / 2, 0, 0]);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 1.55, 0);
  mortar.add(muzzle);
  b.parts.mortar = mortar;
  b.parts.muzzle = muzzle;

  const core = b.pivot(body, [0, 1.05, -0.85]);
  add(core, SPHERE(), coreGlow, [0, 0, 0], 0.62);
  add(core, TORUS(), dark, [0, 0, 0], 0.72, [Math.PI / 2, 0, 0]);
  add(core, TORUS(), dark, [0, 0, 0], 0.72, [0, Math.PI / 2, 0]);
  b.parts.weak = core;
  for (const sx of SIDES) add(body, CONE(), frost, [0.75 * sx, 0.95, -1.15], [0.14, 0.6, 0.14], [-0.8, 0, -0.3 * sx]);
  return b.finish();
}
