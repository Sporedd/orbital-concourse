/**
 * Procedural enemy models: one armour kit for every enemy (src/enemies/armourKit.ts), the
 * layered olive-grey trooper plates the user picked from docs/concepts/C-brutalist.png.
 *
 * Every kind is a Kit blueprint, built once and shared by all instances: one merged geometry per
 * (pivot, material slot), plate tones as vertex colours (worn chamfer edges, black undersuit).
 * Per enemy there are only materials (so each enemy can flash/tint on its own):
 *   armour  toon, 'character' surface, vertex colours        (flashes / status tints)
 *   glow    orange visor / chest chevrons / status marks     (unlit, blooms)
 *   hot     THREAT red: weak points, muzzles, boss under-glow (unlit, blooms)
 *   accent  toon + THREAT emissive: tank window, payload, reactor (rig.accent, blinks/pulses)
 * Rank and threat read from glow colour, glow strength and plate count; bosses add plate tiers,
 * bigger crests, stronger glow and red under-glow.
 * Local space: feet at y=0, facing +Z.
 */
import * as THREE from 'three';
import type { MaterialFactory } from '@/core/types';
import { PALETTE, glowLum } from '@/rendering/style';
import { Kit, blueprint, helmet, trooper, type Blueprint, type Slot, type V3 } from './armourKit';

const THREAT = PALETTE.THREAT;
/** The accent orange of the HUD: visor slits, chest chevrons and status marks. */
export const ENEMY_GLOW = 0xff5f1f;
const UNDERSUIT = 0x161715;
/**
 * Visor / slit glow, by luminance target. The slits are a few pixels tall at 20–30 m; in the
 * dark arena (§15) they are the first thing you see. The grade's hue-preserving shoulder keeps
 * the orange orange (no yellow/white clip) up to lum ~3.5.
 */
const GLOW_MOB = glowLum(ENEMY_GLOW, 3.4, 16);
const GLOW_BOSS = glowLum(ENEMY_GLOW, 3.0, 16);
const HOT_MOB = glowLum(THREAT, 2.8, 16);
const HOT_BOSS = glowLum(THREAT, 3.2, 16);
/** Back-rim on enemies (spec max 0.5): a cool edge (LIGHT.rimColor) against the warm smoke. */
const ENEMY_RIM = 0.3;
/** Emissive multiplier that puts THREAT at a luminance target (grimdark: ×1.15 on every tier). */
const threatK = (lum: number) => glowLum(THREAT, lum * 1.15, 16);

/**
 * Boss rigs are built at mob proportions and scaled as a whole (art spec §7: bosses at 2.5–4×
 * grunt height; a grunt is 1.85 m). The EnemyConfig radius/height/centerHeight, the weak-point
 * radii and src/net/enemyMirror.ts KIND_INFO carry the same factors (keep them in sync).
 */
export const BOSS_SCALE = { brute: 1.35, summoner: 1.3, artillery: 1.3 } as const;

export interface Rig {
  root: THREE.Group;
  /** Uniform rig scale that the view applies to `root` every frame (1 for mobs, BOSS_SCALE for bosses). */
  scale: number;
  /** Torso pivot (bob / lean). */
  body: THREE.Group;
  bodyBaseY: number;
  head: THREE.Object3D | null;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  /**
   * Named extra parts (sac, bomb, mouth, weak point, mortar, halo...). Trooper rigs also carry
   * knee0/knee1 (under legs[i]) and elbow0/elbow1 (under arms[i]) for the run cycle (pose.ts).
   */
  parts: Record<string, THREE.Object3D>;
  /** Flashable toon materials and their resting emissive colour. */
  mats: THREE.MeshToonMaterial[];
  baseEmissive: THREE.Color[];
  /** The hot-accent toon material (blinks, pulses). */
  accent: THREE.MeshToonMaterial | null;
  /** Every material created for this rig (disposed on removal). */
  owned: THREE.Material[];
}

// ---- shared unit geometries (summoner ring/bubble, co-op mirror markers) --------------
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
export const RING_GEO = () => geo('ring', () => new THREE.RingGeometry(0.86, 1, 48));
export const DISC_GEO = () => geo('disc', () => new THREE.CircleGeometry(1, 40));
export const SPHERE_GEO = SPHERE;

class RigBuilder {
  readonly root = new THREE.Group();
  scale = 1;
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
    // matte 'character' surface (back-rim + readability fill); emissive is premultiplied so the
    // hit flash (emissive → BONE) lands at lum ~1 instead of whiting out threat parts.
    const m = this.mf.toon({ color, emissive, emissiveIntensity: 1, surface: 'character', rim: ENEMY_RIM });
    m.emissive.multiplyScalar(emissiveIntensity);
    this.mats.push(m);
    this.baseEmissive.push(m.emissive.clone());
    this.owned.push(m);
    return m;
  }

  glow(color: number, intensity = 2.2): THREE.MeshBasicMaterial {
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
      root: this.root, scale: this.scale, body: this.body, bodyBaseY: this.bodyBaseY, head: this.head,
      legs: this.legs, arms: this.arms, parts: this.parts, mats: this.mats,
      baseEmissive: this.baseEmissive, accent: this.accent, owned: this.owned,
    };
  }
}

interface MatOpts {
  glow?: number;
  hot?: number;
  /** accent emissive luminance target (THREAT); omitted = no accent slot */
  accent?: number;
}

/** Per-enemy materials for the four kit slots. */
function kitMaterials(b: RigBuilder, o: MatOpts): Partial<Record<Slot, THREE.Material>> {
  const armour = b.toon(0xffffff);
  armour.vertexColors = true;
  const glow = b.glow(ENEMY_GLOW, o.glow ?? GLOW_MOB);
  glow.vertexColors = true;
  const mats: Partial<Record<Slot, THREE.Material>> = { armour, glow };
  if (o.hot !== undefined) {
    const hot = b.glow(THREAT, o.hot);
    hot.vertexColors = true;
    mats.hot = hot;
  }
  if (o.accent !== undefined) {
    const accent = b.toon(UNDERSUIT, THREAT, threatK(o.accent));
    b.accent = accent;
    mats.accent = accent;
  }
  return mats;
}

/**
 * Build the rig's node tree from a blueprint: pivots (rig.body for 'body'), one mesh per
 * (pivot, slot), and the named empty nodes. Returns every node by name.
 */
function instantiate(b: RigBuilder, bp: Blueprint, mats: Partial<Record<Slot, THREE.Material>>): Record<string, THREE.Object3D> {
  const nodes: Record<string, THREE.Object3D> = { root: b.root };
  for (const p of bp.pivots) {
    const parent = nodes[p.parent];
    if (!parent) throw new Error(`enemy blueprint: pivot ${p.name} before its parent ${p.parent}`);
    let g: THREE.Group;
    if (p.name === 'body') {
      g = b.makeBody(p.pos[1]);
      g.position.set(p.pos[0], p.pos[1], p.pos[2]);
      if (parent !== b.root) parent.add(g);
    } else {
      g = b.pivot(parent, p.pos, p.rot);
    }
    if (p.rot) g.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
    g.name = p.name;
    g.userData.baseY = p.pos[1];
    nodes[p.name] = g;
  }
  const lod: GlowLod = { near: [], far: [], isFar: false };
  for (const m of bp.meshes) {
    const mat = mats[m.slot];
    if (!mat) throw new Error(`enemy blueprint: no material for slot ${m.slot}`);
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.castShadow = m.castShadow;
    if (m.lod) {
      mesh.userData.lod = m.lod;
      lod[m.lod].push(mesh);
      if (m.lod === 'far') {
        mesh.visible = false;
        mesh.raycast = noRaycast; // the thick twin must not widen the hitbox
      }
    }
    nodes[m.pivot].add(mesh);
  }
  if (lod.near.length) b.root.userData.glowLod = lod;
  for (const [name, n] of Object.entries(bp.nodes)) {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(n.pos[0], n.pos[1], n.pos[2]);
    nodes[n.pivot].add(o);
    nodes[name] = o;
  }
  return nodes;
}

const noRaycast = (): void => {};

interface GlowLod { near: THREE.Mesh[]; far: THREE.Mesh[]; isFar: boolean }

/** Beyond this distance (m) the thin glow slits swap to their thickened far twins. */
export const GLOW_LOD_DISTANCE = 18;

/**
 * Swap glow slits between near (thin) and far (thickened) meshes by camera distance, so the
 * visor and chest slits stay at least a pixel tall at 30 m. Call once per frame per rig (the
 * view does it in BaseEnemy.syncView; the co-op mirror can call it the same way).
 */
export function updateGlowLod(rig: Rig, camera: THREE.Vector3): void {
  const lod = rig.root.userData.glowLod as GlowLod | undefined;
  if (!lod) return;
  const d2 = rig.root.position.distanceToSquared(camera);
  const far = d2 > GLOW_LOD_DISTANCE * GLOW_LOD_DISTANCE;
  if (far === lod.isFar) return;
  lod.isFar = far;
  for (const m of lod.near) m.visible = !far;
  for (const m of lod.far) m.visible = far;
}

/** Wire the trooper pivots into the rig (legs, knees, arms, elbows, head). */
function wireTrooper(b: RigBuilder, n: Record<string, THREE.Object3D>): void {
  for (let i = 0; i < 2; i++) {
    if (n[`leg${i}`]) {
      b.legs.push(n[`leg${i}`]);
      b.parts[`knee${i}`] = n[`knee${i}`];
    }
    b.arms.push(n[`arm${i}`]);
    b.parts[`elbow${i}`] = n[`elbow${i}`];
  }
  b.head = n.head;
}

const SX = [-1, 1] as const;
const side = (prefix: string) => (sx: number) => `${prefix}${sx < 0 ? 0 : 1}`;

/** Triangle count of a kind's blueprint (tests / budgets). */
export function blueprintStats(kind: 'grunt' | 'spitter' | 'bomber' | 'brute' | 'summoner' | 'artillery'): { triangles: number; meshes: number } {
  const bp = BLUEPRINTS[kind]();
  return { triangles: bp.triangles, meshes: bp.meshes.length };
}

// ---- Grunt: the line trooper. Bracer blades for the lunge -----------------------------
const gruntBlueprint = () => blueprint('grunt', () => {
  const k = new Kit();
  trooper(k, { s: 1, w: 1.04 });
  // forearm blades (melee): gunmetal fins along the outer bracers, past the fist
  k.pair(side('elbow'), { at: [0.062, -0.24, 0.03], size: [0.007, 0.14, 0.02], c: 0.006, rot: [0.18, 0, 0], tone: 'steel' });
  // small hazard tab on the right pauldron (threat marking, non-emissive)
  k.plate('arm0', { at: [-0.06, 0.07, 0.08], size: [0.035, 0.012, 0.012], c: 0.004, rot: [0, 0, 0.3], tone: 'hazard' });
  return k.bake();
});

export function buildGrunt(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const n = instantiate(b, gruntBlueprint(), kitMaterials(b, {}));
  wireTrooper(b, n);
  return b.finish();
}

// ---- Spitter: tall, narrow, long wrap-around visor, back tank + shoulder launcher -------
const SPITTER_S = 1.03;
const spitterBlueprint = () => blueprint('spitter', () => {
  const s = SPITTER_S;
  const k = new Kit();
  trooper(k, { s, w: 0.9, visor: 1.75, crest: 0.8, forearm: 1.3 });
  const L = (v: number) => v * s;
  // back tank (rig.parts.sac: pulses, swells before a shot): a tall canister over the left
  // shoulder with THREAT windows, so the spitter's silhouette is asymmetric from the front
  k.pivot('sac', 'body', [L(0.08), L(0.52), L(-0.2)], [0, 0, -0.12], true);
  k.limb('sac', { at: [0, L(0.27), 0], len: L(0.54), r0: L(0.075), r1: L(0.085), sides: 8, tone: 'dark' });
  k.plate('sac', { at: [0, L(0.285), 0], size: [L(0.085), L(0.03), L(0.085)], c: L(0.025), tone: 'lit' });
  k.plate('sac', { at: [0, L(-0.27), 0], size: [L(0.095), L(0.03), L(0.095)], c: L(0.025), tone: 'lit' });
  k.plate('sac', { at: [0, L(0.0), 0], size: [L(0.092), L(0.02), L(0.092)], c: L(0.015), tone: 'plate' });
  for (const sx of SX) {
    k.plate('sac', { at: [L(0.07 * sx), L(0.13), L(-0.035)], size: [L(0.008), L(0.09), L(0.025)], c: 0, rot: [0, 0.6 * sx, 0], slot: 'accent' });
    k.plate('sac', { at: [L(0.07 * sx), L(-0.13), L(-0.035)], size: [L(0.008), L(0.09), L(0.025)], c: 0, rot: [0, 0.6 * sx, 0], slot: 'accent' });
  }
  k.limb('sac', { at: [0, L(0.33), 0], len: L(0.03), r0: L(0.05), r1: L(0.05), sides: 8, slot: 'accent' });
  // shoulder launcher over the right shoulder: housing, barrel past the face, red muzzle; fed from the tank
  const lx = L(-0.155);
  const ly = L(0.7);
  k.plate('body', { at: [lx, ly, L(-0.07)], size: [L(0.065), L(0.06), L(0.13)], c: L(0.03), taper: [-0.15, 0], tone: 'plate' });
  k.plate('body', { at: [lx, ly + L(0.055), L(-0.08)], size: [L(0.045), L(0.012), L(0.1)], c: L(0.008), tone: 'lit' });
  k.plate('body', { at: [lx - L(0.062), ly, L(-0.06)], size: [L(0.004), L(0.008), L(0.05)], c: 0, slot: 'glow', k: 0.6 });
  k.limb('body', { at: [lx, ly, L(0.04)], len: L(0.28), r0: L(0.032), r1: L(0.036), sides: 6, rot: [-Math.PI / 2, 0, 0], tone: 'steel' });
  k.plate('body', { at: [lx, ly, L(0.31)], size: [L(0.044), L(0.044), L(0.014)], c: L(0.01), tone: 'dark' });
  k.plate('body', { at: [lx, ly, L(0.326)], size: [L(0.024), L(0.024), L(0.004)], c: 0, slot: 'hot' });
  k.limb('body', { at: [L(0.0), L(0.62), L(-0.2)], len: L(0.17), r0: L(0.016), r1: L(0.016), sides: 5, rot: [0.4, 0, 1.2], tone: 'steel' });
  k.node('mouth', 'body', [lx, ly, L(0.35)]);
  return k.bake();
});

export function buildSpitter(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const n = instantiate(b, spitterBlueprint(), kitMaterials(b, { hot: HOT_MOB, accent: 1.6 }));
  wireTrooper(b, n);
  b.parts.sac = n.sac;
  b.parts.mouth = n.mouth;
  return b.finish();
}

// ---- Bomber: small, stocky sapper; glowing payload strapped across the chest -----------
const BOMBER_S = 0.7;
const bomberBlueprint = () => blueprint('bomber', () => {
  const s = BOMBER_S;
  const k = new Kit();
  trooper(k, { s, w: 1.18, crest: 0.6, chevrons: 0, marks: false });
  const L = (v: number) => v * s;
  // payload (rig.parts.bomb: swells and blinks on the fuse): a canister across the chest
  k.pivot('bomb', 'body', [0, L(0.38), L(0.2)]);
  k.limb('bomb', { at: [L(-0.17), 0, 0], len: L(0.34), r0: L(0.1), r1: L(0.1), sides: 8, rot: [0, 0, Math.PI / 2], tone: 'dark' });
  for (const sx of SX) {
    k.plate('bomb', { at: [L(0.17 * sx), 0, 0], size: [L(0.018), L(0.11), L(0.11)], c: L(0.02), tone: 'hazard' });
  }
  // the hot core: a wide window on the front + a band all round
  k.plate('bomb', { at: [0, 0, L(0.098)], size: [L(0.11), L(0.06), L(0.012)], c: L(0.008), slot: 'accent' });
  k.limb('bomb', { at: [L(-0.06), 0, 0], len: L(0.12), r0: L(0.104), r1: L(0.104), sides: 8, rot: [0, 0, Math.PI / 2], slot: 'accent' });
  // straps over the shoulders
  for (const sx of SX) k.plate('body', { at: [L(0.1 * sx), L(0.5), L(0.13)], size: [L(0.022), L(0.11), L(0.01)], c: L(0.006), rot: [-0.3, 0, 0], tone: 'suit' });
  // fuse antenna from the pack; the spark (rig.parts.spark) sits on its tip
  k.limb('body', { at: [L(0.06), L(0.78), L(-0.17)], len: L(0.26), r0: L(0.012), r1: L(0.016), sides: 4, tone: 'steel' });
  k.pivot('spark', 'body', [L(0.06), L(0.8), L(-0.17)]);
  k.plate('spark', { at: [0, 0, 0], size: [L(0.03), L(0.03), L(0.03)], c: L(0.012), slot: 'hot' });
  return k.bake();
});

export function buildBomber(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  const n = instantiate(b, bomberBlueprint(), kitMaterials(b, { hot: HOT_MOB, accent: 1.8 }));
  wireTrooper(b, n);
  b.parts.bomb = n.bomb;
  b.parts.spark = n.spark;
  return b.finish();
}

// ---- Brute: heavy assault trooper: extra plate tiers, hydraulic forearms, shield slab ---
const BRUTE_S = 2.0;
const bruteBlueprint = () => blueprint('brute', () => {
  const s = BRUTE_S;
  const w = 1.3;
  const k = new Kit();
  trooper(k, { s, w, tiers: 2, crest: 2.2, visor: 1.35, chevrons: 1.5, chestK: 0.7, markK: 0.7 });
  const L = (v: number) => v * s;
  // hydraulic forearms: a heavier bracer shell, pistons, armoured fists
  for (const sx of SX) {
    const el = side('elbow')(sx);
    k.plate(el, { at: [L(0.012 * sx) * w, L(-0.15), L(0.01)], size: [L(0.066) * w, L(0.1), L(0.066) * w], c: L(0.025), taper: [0.2, 0.15], tone: 'lit' });
    k.limb(el, { at: [L(-0.02 * sx) * w, L(-0.04), L(-0.07)], len: L(0.2), r0: L(0.014), r1: L(0.014), sides: 5, tone: 'steel' });
    k.plate(el, { at: [0, L(-0.3), L(0.02)], size: [L(0.052) * w, L(0.055), L(0.056) * w], c: L(0.02), tone: 'dark' });
  }
  // shield slab on the left forearm (+X): dark plate, hazard edge, a THREAT slit
  k.plate('elbow1', { at: [L(0.1) * w, L(-0.15), L(0.03)], size: [L(0.018), L(0.19), L(0.13)], c: L(0.012), rot: [0.1, 0, 0], tone: 'dark' });
  k.plate('elbow1', { at: [L(0.12) * w, L(-0.15), L(0.03)], size: [L(0.006), L(0.16), L(0.1)], c: L(0.006), rot: [0.1, 0, 0], tone: 'plate' });
  k.plate('elbow1', { at: [L(0.127) * w, L(-0.01), L(0.045)], size: [L(0.004), L(0.012), L(0.09)], c: 0, rot: [0.1, 0, 0], tone: 'hazard' });
  k.plate('elbow1', { at: [L(0.128) * w, L(-0.17), L(0.028)], size: [L(0.003), L(0.008), L(0.06)], c: 0, rot: [0.1, 0, 0], slot: 'hot', k: 0.8 });
  // reactor diamond on the sternum (rig.accent) + red under-glow vents along the belt line
  k.plate('body', { at: [0, L(0.41), L(0.165)], size: [L(0.03), L(0.03), L(0.012)], c: L(0.008), rot: [0, 0, Math.PI / 4], slot: 'accent' });
  for (const sx of SX) {
    k.plate('body', { at: [L(0.085 * sx) * w, L(-0.06), L(0.105)], size: [L(0.03), L(0.004), L(0.012)], c: 0, slot: 'hot', k: 0.9 });
    k.plate('body', { at: [L(0.13 * sx) * w, L(0.02), L(0)], size: [L(0.004), L(0.004), L(0.06)], c: 0, slot: 'hot', k: 0.9 });
    // boot heel vents
    k.plate(side('knee')(sx), { at: [0, L(-0.445), L(-0.088)], size: [L(0.035), L(0.012), L(0.004)], c: 0, slot: 'hot', k: 0.9 });
  }
  return k.bake();
});

export function buildBrute(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  b.scale = BOSS_SCALE.brute;
  const n = instantiate(b, bruteBlueprint(), kitMaterials(b, { glow: GLOW_BOSS, hot: HOT_BOSS, accent: 2.5 }));
  wireTrooper(b, n);
  b.parts.weak = n.head;
  return b.finish();
}

// ---- Summoner: floating commander; tiered plate skirt, red thruster, 4 orbiting slabs ---
const SUMMONER_S = 2.2;
const summonerBlueprint = () => blueprint('summoner', () => {
  const s = SUMMONER_S;
  const k = new Kit();
  trooper(k, { s, w: 0.95, tiers: 2, crest: 2.6, visor: 1.6, legs: false, chevrons: 1.3, chestK: 0.7, lift: 0.25 });
  const L = (v: number) => v * s;
  // crown: two swept fins either side of the crest
  for (const sx of SX) {
    k.plate('head', { at: [L(0.05 * sx), L(0.1), L(-0.06)], size: [L(0.008), L(0.035), L(0.08)], c: L(0.006), rot: [-0.45, 0, -0.35 * sx], tone: 'lit' });
  }
  // plate skirt: three tiers of eight tassets flaring out and down, red under-glow at the hem
  const tiers = [
    { y: -0.05, r: 0.14, h: 0.13, wd: 0.075, tilt: 0.16, tone: 'plate' as const },
    { y: -0.29, r: 0.175, h: 0.14, wd: 0.088, tilt: 0.2, tone: 'dark' as const },
    { y: -0.54, r: 0.21, h: 0.15, wd: 0.1, tilt: 0.24, tone: 'plate' as const },
  ];
  tiers.forEach((t, ti) => {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + (ti % 2) * (Math.PI / 9);
      // negative tilt about local X = the hem flares outward
      k.plate('body', {
        at: [Math.sin(a) * L(t.r), L(t.y), Math.cos(a) * L(t.r)], size: [L(t.wd), L(t.h), L(0.016)], c: L(0.012),
        rot: [-t.tilt, a, 0], order: 'YXZ', taper: [-0.12, 0], tone: t.tone,
      });
      if (ti === 2) {
        const rr = L(t.r + Math.sin(t.tilt) * t.h + 0.012);
        k.plate('body', {
          at: [Math.sin(a) * rr, L(t.y - t.h * Math.cos(t.tilt) + 0.006), Math.cos(a) * rr],
          size: [L(t.wd * 0.75), L(0.004), L(0.004)], c: 0, rot: [0, a, 0], order: 'YXZ', slot: 'hot', k: 0.9,
        });
      }
    }
  });
  k.limb('body', { at: [0, L(-0.05), 0], len: L(0.55), r0: L(0.12), r1: L(0.07), sides: 8, tone: 'suit' });
  // thruster under the skirt (the red under-glow)
  k.limb('body', { at: [0, L(-0.6), 0], len: L(0.05), r0: L(0.07), r1: L(0.08), sides: 8, tone: 'steel' });
  k.limb('body', { at: [0, L(-0.65), 0], len: L(0.006), r0: L(0.065), r1: L(0.065), sides: 8, slot: 'hot' });
  // core (rig.parts.weak): a THREAT gem in a reactor frame on the chest
  k.pivot('weak', 'body', [0, L(0.43), L(0.15)]);
  k.plate('weak', { at: [0, 0, 0], size: [L(0.035), L(0.035), L(0.03)], c: L(0.03), slot: 'hot' });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    k.plate('weak', {
      at: [Math.cos(a) * L(0.05), Math.sin(a) * L(0.05), L(-0.005)], size: [L(0.035), L(0.01), L(0.012)], c: L(0.005),
      rot: [0, 0, a + Math.PI / 2], slot: 'accent',
    });
  }
  // halo: four slabs orbiting the waist, each with an orange slit
  k.pivot('halo', 'body', [0, L(0.36), 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const at: V3 = [Math.sin(a) * 1.3, 0, Math.cos(a) * 1.3];
    k.plate('halo', { at, size: [0.15, 0.36, 0.055], c: 0.035, rot: [0.25, a, 0], order: 'YXZ', taper: [-0.2, 0], tone: 'lit' });
    k.plate('halo', {
      at: [Math.sin(a) * 1.36, 0.02, Math.cos(a) * 1.36], size: [0.012, 0.22, 0.006], c: 0, rot: [0.25, a, 0], order: 'YXZ',
      slot: 'glow', k: 0.85,
    });
  }
  return k.bake();
});

export function buildSummoner(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  b.scale = BOSS_SCALE.summoner;
  const n = instantiate(b, summonerBlueprint(), kitMaterials(b, { glow: GLOW_BOSS, hot: HOT_BOSS, accent: 1.8 }));
  wireTrooper(b, n);
  b.parts.weak = n.weak;
  b.parts.halo = n.halo;
  return b.finish();
}

// ---- Artillery: siege walker; armoured carapace on four legs, trooper helm, mortar mast --
const artilleryBlueprint = () => blueprint('artillery', () => {
  const k = new Kit();
  k.pivot('body', 'root', [0, 1.9, 0], undefined, true);
  const B = 'body';
  // hull: dark belly, three stacked carapace tiers, side skirts, front glacis, rear plate
  k.plate(B, { at: [0, -0.14, 0], size: [0.8, 0.22, 1.05], c: 0.12, tone: 'suit' });
  k.plate(B, { at: [0, 0.28, 0], size: [1.0, 0.34, 1.2], c: 0.2, taper: [-0.08, -0.05], tone: 'plate' });
  k.plate(B, { at: [0, 0.7, -0.12], size: [0.82, 0.16, 0.95], c: 0.13, taper: [-0.12, -0.08], tone: 'lit' });
  k.plate(B, { at: [0, 0.9, -0.3], size: [0.55, 0.08, 0.55], c: 0.07, tone: 'plate' });
  for (const sx of SX) {
    k.plate(B, { at: [1.02 * sx, 0.18, 0], size: [0.1, 0.36, 1.0], c: 0.06, rot: [0, 0, 0.16 * sx], taper: [0, -0.1], tone: 'dark' });
    k.plate(B, { at: [0.62 * sx, 0.52, 0.15], size: [0.3, 0.07, 0.72], c: 0.05, rot: [0, 0, -0.22 * sx], tone: 'dark' });
    // a row of overlapping side plates (plate count reads the rank)
    for (let j = 0; j < 3; j++) {
      k.plate(B, { at: [1.1 * sx, 0.3, 0.62 - j * 0.6], size: [0.05, 0.22, 0.3], c: 0.04, rot: [0, 0, 0.2 * sx], tone: j === 1 ? 'lit' : 'plate' });
    }
  }
  k.plate(B, { at: [0, 0.34, 1.17], size: [0.82, 0.36, 0.1], c: 0.07, rot: [0.5, 0, 0], taper: [-0.18, 0], tone: 'lit' });
  k.plate(B, { at: [0, 0.3, -1.2], size: [0.78, 0.3, 0.08], c: 0.05, rot: [-0.35, 0, 0], tone: 'dark' });
  // glacis chevrons (big orange slits) and hazard tabs
  for (const sx of SX) {
    k.plate(B, { at: [0.26 * sx, 0.44, 1.28], size: [0.17, 0.022, 0.012], c: 0, rot: [0.5, 0, -0.42 * sx], slot: 'glow', k: 0.9 });
    k.plate(B, { at: [0.62 * sx, 0.14, 1.2], size: [0.1, 0.03, 0.01], c: 0.005, rot: [0.5, 0, 0], tone: 'hazard' });
  }
  // red under-glow vents under the hull corners
  for (const sx of SX) for (const sz of [-1, 1]) {
    k.plate(B, { at: [0.55 * sx, -0.33, 0.7 * sz], size: [0.18, 0.006, 0.05], c: 0, slot: 'hot', k: 0.9 });
  }
  // head: a big trooper helm on a collar at the front
  k.pivot('head', B, [0, 0.78, 1.25]);
  k.plate('head', { at: [0, -0.22, -0.3], size: [0.36, 0.22, 0.3], c: 0.08, tone: 'suit' });
  helmet(k, 'head', { s: 4.4, w: 1.05, crest: 1.5, visor: 1.6, visorK: 0.6 });
  // mortar mast (rig.parts.mortar): mount, octagonal barrel with bands, THREAT muzzle ring
  k.pivot('mortar', B, [0, 0.8, 0.05], [0.35, 0, 0]);
  k.plate('mortar', { at: [0, 0.05, 0], size: [0.4, 0.24, 0.4], c: 0.16, tone: 'lit' });
  k.limb('mortar', { at: [0, 0.98, 0], len: 0.95, r0: 0.21, r1: 0.25, sides: 8, tone: 'plate' });
  for (const y of [0.32, 0.66]) k.limb('mortar', { at: [0, y + 0.06, 0], len: 0.12, r0: 0.28, r1: 0.28, sides: 8, tone: 'steel' });
  k.limb('mortar', { at: [0, 1.05, 0], len: 0.08, r0: 0.27, r1: 0.27, sides: 8, slot: 'accent' });
  k.node('muzzle', 'mortar', [0, 1.12, 0]);
  // core (rig.parts.weak) on its back: a big THREAT gem in a steel cage
  k.pivot('weak', B, [0, 0.95, -0.95]);
  k.plate('weak', { at: [0, 0, 0], size: [0.42, 0.42, 0.42], c: 0.38, slot: 'hot' });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    k.plate('weak', { at: [Math.sin(a) * 0.47, 0, Math.cos(a) * 0.47], size: [0.05, 0.5, 0.05], c: 0.02, rot: [0, a, 0], tone: 'steel' });
  }
  k.plate('weak', { at: [0, -0.48, 0], size: [0.45, 0.06, 0.45], c: 0.04, tone: 'dark' });
  // legs: order FL, FR, BL, BR (diagonal pairs 0/3 and 1/2). Pauldron-shell hips, knee caps,
  // shin guards, foot pads.
  let li = 0;
  for (const sz of [1, -1]) {
    for (const sx of SX) {
      const leg = `leg${li++}`;
      k.pivot(leg, 'root', [0.95 * sx, 1.9, 0.95 * sz], undefined, true);
      k.plate(leg, { at: [0.12 * sx, 0.05, 0], size: [0.22, 0.2, 0.22], c: 0.09, tone: 'suit' });
      // big rounded hip shell (the kit's pauldron) and a second band
      k.plate(leg, { at: [0.4 * sx, 0.2, 0], size: [0.38, 0.2, 0.3], c: 0.17, rot: [0, 0, 0.3 * sx], taper: [-0.2, -0.12], tone: 'lit' });
      k.plate(leg, { at: [0.55 * sx, 0.0, 0], size: [0.28, 0.1, 0.27], c: 0.07, rot: [0, 0, 0.42 * sx], tone: 'plate' });
      // knee cap
      k.plate(leg, { at: [0.82 * sx, -0.12, 0.04 * sz], size: [0.2, 0.2, 0.2], c: 0.1, tone: 'lit' });
      k.limb(leg, { at: [0.8 * sx, -0.1, 0], len: 1.7, r0: 0.12, r1: 0.09, sides: 6, rot: [0, 0, 0.04 * sx], caps: false });
      // shin guard, calf plate, status mark, ankle, foot pad
      k.plate(leg, { at: [0.85 * sx, -0.8, 0.1 * sz], size: [0.17, 0.52, 0.11], c: 0.07, rot: [-0.05 * sz, 0, 0.04 * sx], taper: [0.25, 0.15], tone: 'plate' });
      k.plate(leg, { at: [0.85 * sx, -0.7, -0.08 * sz], size: [0.13, 0.4, 0.08], c: 0.05, tone: 'dark' });
      k.plate(leg, { at: [0.92 * sx, -0.85, 0.2 * sz], size: [0.012, 0.06, 0.006], c: 0, slot: 'glow', k: 0.7 });
      k.plate(leg, { at: [0.88 * sx, -1.55, 0.06 * sz], size: [0.13, 0.15, 0.1], c: 0.05, tone: 'dark' });
      k.plate(leg, { at: [0.9 * sx, -1.8, 0], size: [0.26, 0.1, 0.32], c: 0.07, taper: [-0.15, -0.1], tone: 'dark' });
    }
  }
  return k.bake();
});

export function buildArtillery(mf: MaterialFactory): Rig {
  const b = new RigBuilder(mf);
  b.scale = BOSS_SCALE.artillery;
  const n = instantiate(b, artilleryBlueprint(), kitMaterials(b, { glow: GLOW_BOSS, hot: HOT_BOSS, accent: 1.8 }));
  for (let i = 0; i < 4; i++) b.legs.push(n[`leg${i}`]);
  b.head = n.head;
  b.parts.mortar = n.mortar;
  b.parts.muzzle = n.muzzle;
  b.parts.weak = n.weak;
  return b.finish();
}

const BLUEPRINTS = {
  grunt: gruntBlueprint, spitter: spitterBlueprint, bomber: bomberBlueprint,
  brute: bruteBlueprint, summoner: summonerBlueprint, artillery: artilleryBlueprint,
} as const;
