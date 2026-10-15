/**
 * Static arena kit (docs/ART_DIRECTION.md §7): the orbital colosseum. Every visual piece goes
 * into the StaticBatcher (merged per material, flat normals); every solid piece registers
 * AABBs in Collision. Round walls/doors use short arc sub-boxes so their AABBs hug the curve.
 * Dynamic parts (doors, lamps, towers, boards, crowd) live in stage.ts / crowd.ts / boards.ts.
 */
import * as THREE from 'three';
import { makeGlow, makeSurface } from '@/rendering/materials';
import { GRIM, LUM, PALETTE, glowLum, type LeagueStyle } from '@/rendering/style';
import { StaticBatcher, trs } from './batcher';
import { Collision } from './collision';
import {
  UNIT_BOX, barrelGeo, chamferBox, floorRing, floorStripeRing, inwardRy, jerseyGeo, octPrism, outwardRy, polar, stripeBand, triangleGeo, wedgeGeo,
} from './geometry';

export type Rand = () => number;

/** Arena dimensions (§7). */
export const DIM = {
  floorR: 30.5,
  wallIn: 30.5,
  wallOut: 32,
  wallH: 4,
  copingH: 0.35,
  pillarR: 33,
  standIn: 33,
  standOut: 48,
  backR: 48,
  roofY: 28,
  roofIn: 30,
  roofOut: 60,
  towerR: 46,
  panels: 32,
} as const;

export interface GateDef {
  /** Polar angle (deg): x = cos·r, z = sin·r. 270 = north (−z). */
  angle: number;
  kind: 'mob' | 'boss' | 'player';
}

/** Gates every 45°: N boss, S player entrance, six mob airlocks. */
export const GATES: GateDef[] = [
  { angle: 0, kind: 'mob' },
  { angle: 45, kind: 'mob' },
  { angle: 90, kind: 'player' },
  { angle: 135, kind: 'mob' },
  { angle: 180, kind: 'mob' },
  { angle: 225, kind: 'mob' },
  { angle: 270, kind: 'boss' },
  { angle: 315, kind: 'mob' },
];

/** Stand tiers: front face radius, face top y; 5 rows of 1 m × 0.8 m. */
export const TIERS = [
  { r0: 33, faceBottom: 0, faceTop: 5 },
  { r0: 38, faceBottom: 8.2, faceTop: 10 },
  { r0: 43, faceBottom: 13.2, faceTop: 15 },
] as const;
export const ROW_DEPTH = 1;
export const ROW_RISE = 0.8;
export const ROWS = 5;

/** Seat rows for the crowd: radius (row centre) + tread height. */
export function seatRows(): { r: number; y: number; tier: number }[] {
  const out: { r: number; y: number; tier: number }[] = [];
  TIERS.forEach((t, ti) => {
    for (let k = 0; k < ROWS; k++) out.push({ r: t.r0 + ROW_DEPTH * (k + 0.55), y: t.faceTop + ROW_RISE * k, tier: ti });
  });
  return out;
}

/**
 * Angular ranges [a0, a1] (deg) of a full ring with the gate openings cut out.
 * `mobHalf`/`bossHalf`: half-width of the cut (deg) for mob/player gates and the boss gate.
 */
export function ringRangesWithoutGates(mobHalf: number, bossHalf: number): [number, number][] {
  const gs = [...GATES].sort((a, b) => a.angle - b.angle);
  const half = (g: GateDef) => (g.kind === 'boss' ? bossHalf : mobHalf);
  const out: [number, number][] = [];
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    const n = gs[(i + 1) % gs.length];
    const a0 = g.angle + half(g);
    const a1 = n.angle + (i + 1 === gs.length ? 360 : 0) - half(n);
    if (a1 > a0 + 0.01) out.push([a0, a1]);
  }
  return out;
}

export class ArenaBuilder {
  readonly batch = new StaticBatcher();
  readonly mats: Record<string, THREE.Material> = {};
  private tmpM = new THREE.Matrix4();

  constructor(readonly col: Collision, readonly rand: Rand) {
    const b = this.batch;
    const def = (key: string, m: THREE.Material, cast = true, receive = true) => {
      this.mats[key] = m;
      b.material(key, m, cast, receive);
    };
    // grimdark (§15): black concrete, rusted steel, oil-stained floor with grated sections
    def('floor', makeSurface({ color: GRIM.FLOOR, surface: 'concrete', grime: 0, seams: 1, oil: 1, grate: 1, mottle: 0.09 }), false, true);
    def('concrete', makeSurface({ color: GRIM.CONCRETE, surface: 'concrete', rust: 0.35, mottle: 0.09 }));
    def('concreteLit', makeSurface({ color: GRIM.CONCRETE_LIT, surface: 'concrete', rust: 0.25, mottle: 0.08 }));
    def('concreteDark', makeSurface({ color: GRIM.CONCRETE_DARK, surface: 'concrete', grime: 0.1, rust: 0.3 }));
    def('standFace', makeSurface({ color: 0x1a1816, surface: 'concrete', grime: 0, rust: 0.3 }), false, true);
    def('standRiser', makeSurface({ color: GRIM.CONCRETE_DARK, surface: 'concrete', grime: 0, mottle: 0.04 }), false, true);
    def('steel', makeSurface({ color: GRIM.STEEL, surface: 'steel', rust: 0.7, mottle: 0.08 }));
    def('steelDark', makeSurface({ color: GRIM.STEEL_DARK, surface: 'steel', rust: 0.45 }));
    def('roof', makeSurface({ color: 0x0f0e0d, surface: 'flat' }), false, false);
    def('shadow', makeSurface({ color: GRIM.SHADOW, surface: 'flat' }), false, true);
    def('paint', makeSurface({ color: 0x8a6c1c, surface: 'paint', mottle: 0.14 }), false, true);
    def('paintDark', makeSurface({ color: GRIM.SHADOW, surface: 'paint' }), false, true);
    def('bone', makeSurface({ color: 0x9a978f, surface: 'paint', mottle: 0.1 }), false, true);
    def('cable', makeSurface({ color: GRIM.CABLE, surface: 'steel', sheen: 0.2, mottle: 0, grime: 0 }), false, false);
    def('barrel', makeSurface({ color: 0x3a2a20, surface: 'steel', rust: 1, mottle: 0.12 }));
    // accent strips (league colour, lum 1.1, fog on)
    def('accent', makeGlow(0xffffff, 1), false, false);
    def('ribbon', makeGlow(0xffffff, 1), false, false);
    def('inlay', makeGlow(0xffffff, 1), false, false);
    def('floorRing', makeGlow(0xffffff, 1), false, false);
    // paint is a decal: never z-fight the floor
    for (const k of ['paint', 'paintDark'] as const) {
      const m = this.mats[k];
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
    }
  }

  /** Recolour everything that follows the league (accent glows, concrete albedo, floor polish). */
  applyLeague(ls: LeagueStyle): void {
    const k = glowLum(ls.accent, LUM.accent);
    for (const key of ['accent', 'ribbon', 'inlay', 'floorRing']) {
      (this.mats[key] as THREE.MeshBasicMaterial).color.set(ls.accent).multiplyScalar(k);
    }
    const concrete = ls.concrete;
    const shade = (hex: number, f: number) => new THREE.Color(hex).multiplyScalar(f);
    (this.mats.floor as THREE.MeshToonMaterial).color.set(ls.id === 'void' ? concrete : GRIM.FLOOR);
    (this.mats.concrete as THREE.MeshToonMaterial).color.set(concrete);
    const dark = ls.id === 'void' ? shade(concrete, 0.7) : new THREE.Color(GRIM.CONCRETE_DARK);
    (this.mats.concreteDark as THREE.MeshToonMaterial).color.copy(dark);
    (this.mats.standRiser as THREE.MeshToonMaterial).color.copy(dark);
    (this.mats.standFace as THREE.MeshToonMaterial).color.copy(dark).multiplyScalar(0.62);
    const lit = ls.id === 'void' ? shade(concrete, 1.5) : new THREE.Color(GRIM.CONCRETE_LIT);
    (this.mats.concreteLit as THREE.MeshToonMaterial).color.copy(lit);
    const fu = (this.mats.floor as THREE.MeshToonMaterial).userData.uSurf as { value: THREE.Vector4 } | undefined;
    if (fu) fu.value.z = ls.floorSheen;
  }

  add(key: string, geo: THREE.BufferGeometry, m: THREE.Matrix4, flat = true): void {
    this.batch.add(key, geo, m, { flat });
  }

  /** Chamfered slab, centre (x, y, z), rotation ry. */
  slab(key: string, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0, c = 0.1): void {
    this.add(key, chamferBox(w, h, d, c), trs(x, y, z, 1, 1, 1, 0, ry, 0));
  }

  box(key: string, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0): void {
    this.add(key, UNIT_BOX, trs(x, y, z, w, h, d, 0, ry, 0));
  }

  /** Box in a parent frame. */
  boxLocal(key: string, parent: THREE.Matrix4, x: number, y: number, z: number, w: number, h: number, d: number, rx = 0, ry = 0, rz = 0): void {
    this.add(key, UNIT_BOX, this.tmpM.multiplyMatrices(parent, trs(x, y, z, w, h, d, rx, ry, rz)).clone());
  }

  slabLocal(key: string, parent: THREE.Matrix4, x: number, y: number, z: number, w: number, h: number, d: number, ry = 0, c = 0.1): void {
    this.add(key, chamferBox(w, h, d, c), this.tmpM.multiplyMatrices(parent, trs(x, y, z, 1, 1, 1, 0, ry, 0)).clone());
  }

  /** Frame at polar angle `deg`, radius r: local +z points to the arena centre, +x along the arc. */
  frame(deg: number, r: number, y = 0): THREE.Matrix4 {
    const [x, z] = polar(deg, r);
    return trs(x, y, z, 1, 1, 1, 0, inwardRy(deg), 0);
  }

  /**
   * Collision for a curved slab: from angle a0..a1 (deg), radius r0..r1, height y0..y1, as
   * short sub-boxes (tangential length ≤ seg) whose AABBs hug the curve.
   */
  arcBoxes(a0: number, a1: number, r0: number, r1: number, y0: number, y1: number, seg = 0.75): void {
    const rm = (r0 + r1) / 2;
    const span = THREE.MathUtils.degToRad(a1 - a0);
    const n = Math.max(1, Math.ceil((Math.abs(span) * rm) / seg));
    const ht = (Math.abs(span) * rm) / n / 2;
    const hr = (r1 - r0) / 2;
    for (let i = 0; i < n; i++) {
      const a = THREE.MathUtils.degToRad(a0) + (span * (i + 0.5)) / n;
      const c = Math.cos(a), s = Math.sin(a);
      const cx = c * rm, cz = s * rm;
      const hx = Math.abs(c) * hr + Math.abs(s) * ht;
      const hz = Math.abs(s) * hr + Math.abs(c) * ht;
      this.col.addBox(cx - hx, y0, cz - hz, cx + hx, y1, cz + hz);
    }
  }

  /**
   * Surface of revolution from an (r, y) profile, split per edge into material keys.
   * Edges traversed inner→outer / low→high face the centre and up.
   */
  revolve(profile: [number, number, string | null][], seg = 96, a0 = 0, a1 = 360): void {
    const byKey = new Map<string, number[]>();
    const da = (a1 - a0) / seg;
    for (let i = 0; i < profile.length - 1; i++) {
      const [ra, ya, key] = profile[i];
      const [rb, yb] = profile[i + 1];
      if (!key) continue;
      let arr = byKey.get(key);
      if (!arr) byKey.set(key, (arr = []));
      for (let s = 0; s < seg; s++) {
        const p0 = THREE.MathUtils.degToRad(a0 + s * da);
        const p1 = THREE.MathUtils.degToRad(a0 + (s + 1) * da);
        const A = [Math.cos(p0) * ra, ya, Math.sin(p0) * ra];
        const B = [Math.cos(p1) * ra, ya, Math.sin(p1) * ra];
        const C = [Math.cos(p1) * rb, yb, Math.sin(p1) * rb];
        const D = [Math.cos(p0) * rb, yb, Math.sin(p0) * rb];
        arr.push(...A, ...B, ...C, ...A, ...C, ...D);
      }
    }
    for (const [key, pos] of byKey) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      this.add(key, g, new THREE.Matrix4());
      g.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  floor(): void {
    const g = new THREE.CircleGeometry(DIM.floorR + 0.6, 96);
    g.rotateX(-Math.PI / 2);
    this.add('floor', g, new THREE.Matrix4(), false);
    // under-structure floor between the wall and the stands (and below the gates)
    this.add('shadow', floorRing(DIM.floorR + 0.5, 62, 96), trs(0, -0.02, 0), false);
  }

  /** Hazard paint (non-emissive decals at y = 0.005). */
  paint(): void {
    const y = 0.005;
    this.add('paint', floorRing(26.875, 27.125, 160), trs(0, y, 0), false);
    // striped ring r 28 × 0.4 (PAINT on SHADOW)
    this.add('paintDark', floorRing(27.8, 28.2, 160), trs(0, y, 0), false);
    this.add('paint', floorStripeRing(27.8, 28.2, 0.4), trs(0, y + 0.002, 0), false);
    // warning triangles 1.2 m in front of each gate
    for (const gate of GATES) {
      const r = DIM.wallIn - 1.2 - 0.7;
      const [x, z] = polar(gate.angle, r);
      const ry = outwardRy(gate.angle) + Math.PI; // apex toward the gate
      this.add('paint', triangleGeo(1.5), trs(x, y + 0.003, z, 1, 1, 1, 0, ry, 0), false);
      this.add('paintDark', triangleGeo(0.95), trs(x, y + 0.005, z, 1, 1, 1, 0, ry, 0), false);
      this.add('paint', UNIT_BOX, this.tmpM.multiplyMatrices(trs(x, y + 0.006, z, 1, 1, 1, 0, ry, 0), trs(0, 0, 0.02, 0.08, 0.002, 0.34)).clone(), false);
    }
  }

  /** Precast round wall with chamfered coping; gaps where the gates are. */
  wall(): void {
    const n = DIM.panels;
    const step = 360 / n;
    const rC = (DIM.wallIn + DIM.wallOut) / 2;
    const depth = DIM.wallOut - DIM.wallIn;
    const panelW = (2 * Math.PI * DIM.wallIn) / n - 0.1;
    const gateSkip = (deg: number) => GATES.some((g) => {
      const d = Math.abs(((deg - g.angle + 540) % 360) - 180);
      return g.kind === 'boss' ? d < step * 1.5 - 0.1 : d < step * 0.5;
    });
    for (let i = 0; i < n; i++) {
      const deg = i * step;
      if (gateSkip(deg)) continue;
      const F = this.frame(deg, rC);
      this.slabLocal('concrete', F, 0, DIM.wallH / 2, 0, panelW, DIM.wallH, depth, 0, 0.1);
      this.slabLocal('concreteLit', F, 0, DIM.wallH + DIM.copingH / 2, 0.08, panelW + 0.08, DIM.copingH, depth + 0.3, 0, 0.09);
      // LED ribbon along the coping front (Iron+, toggled by the league)
      this.boxLocal('ribbon', F, 0, DIM.wallH + 0.04, depth / 2 + 0.24, panelW + 0.1, 0.07, 0.02);
      // low steel kick plate (patched steel in Scrap reads as plates)
      if (this.rand() < 0.22) this.boxLocal('steel', F, (this.rand() - 0.5) * 2, 0.9, depth / 2 + 0.03, 1.4 + this.rand(), 1.1 + this.rand() * 0.8, 0.05);
      // grimdark: rusted steel kick band and a riveted rib at the panel seam (visual only, 15 cm)
      this.boxLocal('steel', F, 0, 0.42, depth / 2 + 0.04, panelW, 0.62, 0.06);
      this.boxLocal('steel', F, -panelW / 2, DIM.wallH / 2, depth / 2 + 0.07, 0.3, DIM.wallH - 0.1, 0.16);
      this.boxLocal('steelDark', F, -panelW / 2, DIM.wallH / 2, depth / 2 + 0.16, 0.12, DIM.wallH - 0.4, 0.04);
      const a0 = deg - step / 2;
      this.arcBoxes(a0, a0 + step, DIM.wallIn, DIM.wallIn + 1.0, 0, DIM.wallH + DIM.copingH);
    }
    // dark backing ring (seams between panels read dark); open at the gates so the airlock
    // tunnels read through open doors
    for (const [a0, a1] of ringRangesWithoutGates(5.7, 11.5)) {
      this.revolve([[DIM.wallOut - 0.1, 0, 'shadow'], [DIM.wallOut - 0.1, DIM.wallH, null]], Math.max(2, Math.round((a1 - a0) / 3.75)), a0, a1);
    }
  }

  /** One mob/player airlock: jambs, lintel with hazard stripes, recess, door collision. */
  gate(g: GateDef): void {
    const deg = g.angle;
    const halfDeg = THREE.MathUtils.radToDeg(3.0 / DIM.wallIn);
    const jambDeg = THREE.MathUtils.radToDeg(3.6 / DIM.wallIn);
    const F = this.frame(deg, 31.4);
    // jambs + lintel (portal 6 × 5)
    for (const sx of [-1, 1]) this.slabLocal('concreteLit', F, sx * 3.3, 2.8, 0, 0.6, 5.6, 2.4, 0, 0.1);
    this.slabLocal('concreteLit', F, 0, 5.4, 0, 7.4, 0.8, 2.4, 0, 0.1);
    // hazard stripes on the lintel face
    this.add('paintDark', UNIT_BOX, this.tmpM.multiplyMatrices(F, trs(0, 5.4, 1.21, 6.6, 0.5, 0.01)).clone());
    this.add('paint', stripeBand(6.6, 0.5, 0.5), this.tmpM.multiplyMatrices(F, trs(0, 5.4, 1.225)).clone());
    // recess side walls + dark tunnel behind the doors (back to the tunnel end wall)
    for (const sx of [-1, 1]) this.boxLocal('concreteDark', F, sx * 3.05, 2.5, -1.2, 0.1, 5, 3.0);
    this.boxLocal('shadow', F, 0, 2.5, -2.4, 6.2, 5, 0.2);
    this.boxLocal('shadow', F, 0, 4.95, -1.3, 6.2, 0.1, 2.2);
    // stencil plate next to the gate
    this.boxLocal('bone', F, -4.6, 2.7, 0.92, 0.9, 0.5, 0.02);
    // collision: jambs + doors (doors stay solid; they are airlocks)
    this.arcBoxes(deg - jambDeg, deg - halfDeg, 30.2, 32.6, 0, 5.8);
    this.arcBoxes(deg + halfDeg, deg + jambDeg, 30.2, 32.6, 0, 5.8);
    this.arcBoxes(deg - halfDeg, deg + halfDeg, 32.2, 32.9, 0, 5.8);
  }

  /** North boss gate: 12 × 9 opening, 45° angled jambs with accent strips. */
  bossGate(g: GateDef): void {
    const deg = g.angle;
    const F = this.frame(deg, 31.6);
    for (const sx of [-1, 1]) {
      // angled jamb (45°), splayed toward the arena
      const J = new THREE.Matrix4().multiplyMatrices(F, trs(sx * 7.6, 0, 0.4, 1, 1, 1, 0, sx * Math.PI / 4, 0));
      this.slabLocal('concreteLit', J, 0, 5.2, 0, 2.6, 10.4, 2.0, 0, 0.12);
      this.boxLocal('accent', J, -sx * 0.25, 5.4, 1.01, 0.14, 7.5, 0.02);
      // outer wall return to the round wall
      this.slabLocal('concrete', F, sx * 9.6, 2.0, -0.2, 2.6, 4.0, 1.6, 0, 0.1);
      this.slabLocal('concreteLit', F, sx * 9.6, 4.17, -0.1, 2.7, 0.35, 1.9, 0, 0.09);
    }
    this.slabLocal('concreteLit', F, 0, 9.9, 0.1, 17, 1.6, 2.6, 0, 0.12);
    this.add('paintDark', UNIT_BOX, this.tmpM.multiplyMatrices(F, trs(0, 9.55, 1.41, 12, 0.6, 0.01)).clone());
    this.add('paint', stripeBand(12, 0.6, 0.6), this.tmpM.multiplyMatrices(F, trs(0, 9.55, 1.425)).clone());
    this.boxLocal('accent', F, 0, 10.55, 1.41, 15, 0.12, 0.02);
    // tunnel behind
    this.boxLocal('shadow', F, 0, 4.6, -3.2, 13, 9.2, 0.3);
    for (const sx of [-1, 1]) this.boxLocal('concreteDark', F, sx * 6.15, 4.6, -1.6, 0.3, 9.2, 3.2);
    this.boxLocal('shadow', F, 0, 9.1, -1.6, 12.4, 0.2, 3.2);
    // collision: wall returns + jamb footprint + doors
    const deg6 = THREE.MathUtils.radToDeg(6 / DIM.wallIn);
    const deg9 = THREE.MathUtils.radToDeg(11 / DIM.wallIn);
    this.arcBoxes(deg - deg9, deg - deg6, 30.2, 32.6, 0, 10);
    this.arcBoxes(deg + deg6, deg + deg9, 30.2, 32.6, 0, 10);
    this.arcBoxes(deg - deg6, deg + deg6, 32.5, 33.2, 0, 9.5);
    for (const sx of [-1, 1]) {
      const p = new THREE.Vector3(sx * 7.6, 0, 0.4).applyMatrix4(F);
      this.col.addBoxC(p.x, p.z, 2.4, 2.4, 10);
    }
  }

  /** Pillars every 15° at r = 33 (offset 7.5° so gates sit between them), with accent strips. */
  pillars(): void {
    for (let i = 0; i < 24; i++) {
      const deg = 7.5 + i * 15;
      const F = this.frame(deg, DIM.pillarR);
      const h = DIM.roofY - 1;
      this.slabLocal('concrete', F, 0, h / 2, 0, 1.6, h, 1.6, 0, 0.1);
      this.boxLocal('accent', F, 0, 13, 0.81, 0.12, 14, 0.02);
      // grimdark buttress: a massive footing rising above the wall coping with a 45° set-back,
      // steel bands and a riveted plate (the boss gatehouse keeps its clean jambs)
      const nearBoss = Math.abs(((deg - 270 + 540) % 360) - 180) < 12;
      if (!nearBoss) {
        this.slabLocal('concreteDark', F, 0, 3.6, 0.25, 2.2, 7.2, 2.1, 0, 0.14);
        this.add('concreteDark', wedgeGeo(2.2, 1.1, 1.05), this.tmpM.multiplyMatrices(F, trs(0, 7.75, 0.775)).clone());
        this.boxLocal('steelDark', F, 0, 6.4, 0.25, 2.32, 0.4, 2.22);
      }
      for (const y of [9.2, 16, 22.5]) this.boxLocal('steelDark', F, 0, y, 0, 1.78, 0.42, 1.78);
      this.boxLocal('steel', F, 0, 18.3, 0.83, 1.3, 2.6, 0.06);
      // vertical rust-stained rib up the outer side (heavier silhouette against the stands)
      this.boxLocal('concreteDark', F, 0, h / 2 + 3, -1.0, 0.9, h - 6, 0.6);
    }
  }

  /** Cable bundles sagging along the tier faces between the pillars (smooth tubes, decor only). */
  cables(): void {
    const sagged = (a: THREE.Vector3, b: THREE.Vector3, sag: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y -= 4 * sag * t * (1 - t);
        pts.push(p);
      }
      return new THREE.CatmullRomCurve3(pts);
    };
    const P = (deg: number, r: number, y: number) => {
      const [x, z] = polar(deg, r);
      return new THREE.Vector3(x, y, z);
    };
    for (const [r, y] of [[TIERS[1].r0 - 0.12, TIERS[1].faceBottom - 0.1], [TIERS[2].r0 - 0.12, TIERS[2].faceBottom - 0.1]] as const) {
      for (let i = 0; i < 24; i++) {
        const d0 = 7.5 + i * 15;
        for (let k = 0; k < 3; k++) {
          const sag = 0.5 + k * 0.35 + this.rand() * 0.3;
          const tube = new THREE.TubeGeometry(sagged(P(d0, r - k * 0.06, y - k * 0.05), P(d0 + 15, r - k * 0.06, y - k * 0.05), sag), 14, 0.045 + k * 0.012, 5, false);
          this.add('cable', tube, new THREE.Matrix4(), false);
          tube.dispose();
        }
      }
    }
  }

  /** Floor burn barrel (rusted drum, two hoops, charred rim); the fire itself lives in fire.ts. */
  burnBarrel(x: number, z: number, h: number, y0 = 0): void {
    this.add('barrel', barrelGeo(0.42, h), trs(x, y0 + h / 2, z), true);
    for (const y of [0.22, h - 0.2]) this.add('steelDark', barrelGeo(0.445, 0.07), trs(x, y0 + y, z), true);
    this.add('shadow', barrelGeo(0.38, 0.02), trs(x, y0 + h - 0.06, z), true);
    this.col.addBoxC(x, z, 0.9, 0.9, h, y0);
  }

  /** Three stand tiers with tier faces, risers, railings; back wall to the roof. */
  stands(): void {
    /** Tier profile: front face (optional) then the rows from `fromRow`. */
    const tierProfile = (t: (typeof TIERS)[number], face: boolean, fromRow = 0): [number, number, string | null][] => {
      const prof: [number, number, string | null][] = [];
      if (face) prof.push([t.r0, t.faceBottom, 'standFace']); // tier front face
      let r: number = t.r0 + ROW_DEPTH * fromRow;
      let y: number = t.faceTop + ROW_RISE * fromRow;
      if (!face && fromRow > 0) prof.push([r, y - ROW_RISE, 'standRiser']); // riser up to the first kept tread
      for (let k = fromRow; k < ROWS; k++) {
        prof.push([r, y, 'standRiser']); // tread
        r += ROW_DEPTH;
        prof.push([r, y, k < ROWS - 1 ? 'standRiser' : null]); // riser
        y += ROW_RISE;
      }
      return prof;
    };
    // tiers 1 and 2: full rings (each face starts where the tier below ends)
    for (const t of [TIERS[1], TIERS[2]]) this.revolve(tierProfile(t, true), 96);
    // tier 0: its face (r 33, 0–5 m) would close every gate tunnel, so it is cut at the gates;
    // at the boss gate the two lowest rows are cut too (they would cross its 9 m tunnel)
    const t0 = TIERS[0];
    const segs = (a0: number, a1: number) => Math.max(2, Math.round((a1 - a0) / 3.75));
    for (const [a0, a1] of ringRangesWithoutGates(6.2, 11.5)) this.revolve(tierProfile(t0, true).slice(0, 2), segs(a0, a1), a0, a1);
    for (const [a0, a1] of ringRangesWithoutGates(0, 11.5)) this.revolve(tierProfile(t0, false), segs(a0, a1), a0, a1);
    const boss = GATES.find((g) => g.kind === 'boss');
    if (boss) this.revolve(tierProfile(t0, false, 2), 8, boss.angle - 11.5, boss.angle + 11.5);
    // back wall from the top tier to the roof
    const top = TIERS[2].faceTop + ROW_RISE * (ROWS - 1);
    this.revolve([[DIM.backR, top - 0.8, 'concreteDark'], [DIM.backR, DIM.roofY - 1, null]], 96);
    // railings on each tier lip
    TIERS.forEach((t) => {
      this.revolve([[t.r0 - 0.05, t.faceTop + 1.0, 'steel'], [t.r0 - 0.05, t.faceTop + 1.06, 'steel'], [t.r0 + 0.05, t.faceTop + 1.06, null]], 96);
      for (let i = 0; i < 72; i++) {
        const F = this.frame(i * 5, t.r0);
        this.boxLocal('steel', F, 0, t.faceTop + 0.5, 0, 0.05, 1.0, 0.05);
      }
    });
    // vomitory slots (dark entrances) in the tier faces
    for (let i = 0; i < 12; i++) {
      const deg = 15 + i * 30;
      const t = TIERS[1 + (i % 2)];
      const F = this.frame(deg, t.r0 - 0.02);
      this.boxLocal('shadow', F, 0, (t.faceBottom + t.faceTop) / 2, 0, 2.2, t.faceTop - t.faceBottom - 0.1, 0.05);
    }
  }

  /** Roof ring (annulus) with ribs, chamfered CONCRETE_LIT lip, and 4 radial trusses. */
  roof(): void {
    const y0 = DIM.roofY - 1;
    const y1 = DIM.roofY + 1;
    this.revolve([
      [DIM.roofOut, y0, 'roof'], [DIM.roofIn, y0, 'concreteLit'], [DIM.roofIn - 0.4, y0 + 0.4, 'concreteLit'],
      [DIM.roofIn - 0.4, y1 - 0.4, 'concreteLit'], [DIM.roofIn, y1, 'roof'], [DIM.roofOut, y1, null],
    ], 120);
    for (let i = 0; i < 24; i++) {
      const F = this.frame(i * 15, (DIM.roofIn + DIM.backR) / 2 + 0.5);
      this.boxLocal('steelDark', F, 0, y0 - 0.6, 0, 0.5, 1.2, DIM.backR - DIM.roofIn - 1);
    }
    // trusses across the oculus (two full spans = four radial arms), rotated off the gate axes
    for (const deg of [22.5, 112.5]) {
      const ry = -THREE.MathUtils.degToRad(deg);
      const L = DIM.roofIn * 2 + 1;
      const T = trs(0, 0, 0, 1, 1, 1, 0, ry, 0);
      const yT = y0 + 0.2, yB = y0 - 1.6;
      for (const sz of [-0.6, 0.6]) {
        this.boxLocal('steelDark', T, 0, yT, sz, L, 0.3, 0.3);
        this.boxLocal('steelDark', T, 0, yB, sz, L, 0.3, 0.3);
      }
      const n = 30;
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + (L * (i + 0.5)) / n;
        const dx = L / n;
        const ang = Math.atan2(yT - yB, dx) * (i % 2 ? 1 : -1);
        for (const sz of [-0.6, 0.6]) this.boxLocal('steelDark', T, x, (yT + yB) / 2, sz, Math.hypot(dx, yT - yB), 0.14, 0.14, 0, 0, ang);
        this.boxLocal('steelDark', T, x - dx / 2, (yT + yB) / 2, 0, 0.14, yT - yB, 1.2);
      }
    }
  }

  /** Octagonal boss plinth, two steps (each ≤ STEP_HEIGHT), CONCRETE_LIT top, paint circle. */
  plinth(): void {
    this.add('concrete', octPrism(10, 0.3, 0.06), trs(0, 0.15, 0));
    this.add('concreteLit', octPrism(8.4, 0.3, 0.08), trs(0, 0.45, 0));
    this.add('paint', floorRing(3.75, 4.0, 64), trs(0, 0.605, 0), false);
    this.add('inlay', floorRing(2.6, 2.72, 64), trs(0, 0.606, 0), false);
    // collision: octagon ≈ cross + square
    const plus = (w: number, h: number, y0: number) => {
      const s = w * (Math.SQRT2 - 1);
      this.col.addBoxC(0, 0, w, s, h, y0);
      this.col.addBoxC(0, 0, s, w, h, y0);
      this.col.addBoxC(0, 0, w * 0.707, w * 0.707, h, y0);
    };
    plus(10, 0.3, 0);
    plus(8.4, 0.6, 0);
  }

  /** Void floor ring (accent, flush with the floor). */
  floorAccentRing(): void {
    this.add('floorRing', floorRing(24.4, 24.55, 160), trs(0, 0.006, 0), false);
  }

  // ---------------------------------------------------------------------------
  // Cover props
  // ---------------------------------------------------------------------------
  /** STEEL cargo container 6 × 2.6 × 2.4 with ribs every 0.6 m. */
  container(x: number, z: number, alongX: boolean): void {
    const ry = alongX ? 0 : Math.PI / 2;
    const P = trs(x, 0, z, 1, 1, 1, 0, ry, 0);
    this.slabLocal('steel', P, 0, 1.3, 0, 6, 2.6, 2.4, 0, 0.06);
    for (let i = 0; i <= 9; i++) {
      const lx = -2.7 + i * 0.6;
      for (const sz of [-1, 1]) this.boxLocal('steelDark', P, lx, 1.3, sz * 1.215, 0.12, 2.3, 0.05);
    }
    for (const sx of [-1, 1]) this.boxLocal('steelDark', P, sx * 3.0, 1.3, 0, 0.06, 2.5, 2.3);
    this.boxLocal('bone', P, 1.6, 1.9, 1.245, 1.2, 0.35, 0.01);
    this.boxLocal('paint', P, -2.2, 0.35, 1.245, 1.0, 0.25, 0.01);
    const hw = alongX ? 3 : 1.2;
    const hd = alongX ? 1.2 : 3;
    this.col.addBox(x - hw, 0, z - hd, x + hw, 2.6, z + hd);
  }

  /** Concrete block 2 × 1.2 × 1. */
  block(x: number, z: number, ry = 0, y0 = 0): void {
    this.slab('concrete', x, y0 + 0.6, z, 2, 1.2, 1, ry, 0.1);
    const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
    const hx = c * 1 + s * 0.5, hz = s * 1 + c * 0.5;
    this.col.addBox(x - hx, y0, z - hz, x + hx, y0 + 1.2, z + hz);
  }

  /** Jersey barrier line, 1.1 m tall. */
  barrier(x: number, z: number, len: number, alongX: boolean): void {
    const n = Math.max(1, Math.round(len / 2));
    const seg = len / n;
    for (let i = 0; i < n; i++) {
      const o = -len / 2 + seg * (i + 0.5);
      const bx = alongX ? x + o : x;
      const bz = alongX ? z : z + o;
      this.add(i % 2 ? 'concreteLit' : 'concrete', jerseyGeo(seg - 0.06), trs(bx, 0.55, bz, 1, 1, 1, 0, alongX ? 0 : Math.PI / 2, 0));
    }
    const hw = alongX ? len / 2 : 0.4;
    const hd = alongX ? 0.4 : len / 2;
    this.col.addBox(x - hw, 0, z - hd, x + hw, 1.1, z + hd);
  }

  /** Square pillar 1.2 m. */
  squarePillar(x: number, z: number, h = 4.5): void {
    this.slab('concrete', x, h / 2, z, 1.2, h, 1.2, 0, 0.1);
    this.box('paint', x, 0.5, z, 1.22, 0.3, 1.22);
    this.col.addBoxC(x, z, 1.2, 1.2, h);
  }

  /** Raised concrete deck with stairs (each step ≤ STEP_HEIGHT) and a hazard-paint edge strip. */
  deck(
    x0: number, z0: number, x1: number, z1: number, top: number,
    stairs: { dir: 'x-' | 'x+' | 'z-' | 'z+'; from: number; to: number; steps: number },
  ): void {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const w = x1 - x0;
    const d = z1 - z0;
    this.slab('concrete', cx, top / 2, cz, w, top, d, 0, 0.12);
    // hazard edge strip around the top
    this.box('paint', cx, top + 0.004, z0 + 0.12, w - 0.3, 0.008, 0.16);
    this.box('paint', cx, top + 0.004, z1 - 0.12, w - 0.3, 0.008, 0.16);
    this.box('paint', x0 + 0.12, top + 0.004, cz, 0.16, 0.008, d - 0.3);
    this.box('paint', x1 - 0.12, top + 0.004, cz, 0.16, 0.008, d - 0.3);
    this.col.addBox(x0, 0, z0, x1, top, z1);

    const n = stairs.steps;
    const stepH = top / (n + 1);
    for (let i = 0; i < n; i++) {
      const h = stepH * (n - i);
      const depth = 0.9;
      let bx0: number, bx1: number, bz0: number, bz1: number;
      if (stairs.dir === 'x-') { bx1 = x0 - i * depth; bx0 = bx1 - depth; bz0 = stairs.from; bz1 = stairs.to; }
      else if (stairs.dir === 'x+') { bx0 = x1 + i * depth; bx1 = bx0 + depth; bz0 = stairs.from; bz1 = stairs.to; }
      else if (stairs.dir === 'z-') { bz1 = z0 - i * depth; bz0 = bz1 - depth; bx0 = stairs.from; bx1 = stairs.to; }
      else { bz0 = z1 + i * depth; bz1 = bz0 + depth; bx0 = stairs.from; bx1 = stairs.to; }
      const scx = (bx0 + bx1) / 2;
      const scz = (bz0 + bz1) / 2;
      this.slab(i % 2 ? 'concreteLit' : 'concrete', scx, h / 2, scz, bx1 - bx0, h, bz1 - bz0, 0, 0.05);
      this.col.addBox(bx0, 0, bz0, bx1, h, bz1);
    }
  }
}
