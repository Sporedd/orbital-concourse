/**
 * Loot presentation (docs/ART_DIRECTION.md §9): procedural icon + rarity beam + ground ring
 * per item. Reads LootItemState only. Beams are a rarity-colour additive sheath (r 0.12 m)
 * around a white-hot core (r 0.03 m, 70 % white + 30 % rarity), both fading out toward the top,
 * fog off so they cut through the haze; height/alpha/core lum climb with rarity. Rare+ get
 * slow upward motes; legendary gets a pulsing core and a counter-rotating dashed outer ring.
 * Geometries are shared; beam materials are per item (camera-proximity fade).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RARITY_COLORS, type GameContext, type LootItemState, type Rarity, type WeaponArchetype } from '@/core/types';
import { LOOT } from '@/core/config';
import { BEAM, PALETTE, glowLum } from '@/rendering/style';
import { buildGearModel, type GearModel } from '@/gear/models';

const BLINK_WINDOW = 10;

// Shared geometries (unit-ish sizes, scaled per use)
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(0.16, 1),
  beam: new THREE.CylinderGeometry(1, 1, 1, 12, 1, true),
  ring: new THREE.RingGeometry(0.42, 0.5, 40),
  outer: dashedRing(0.66, 0.72, 14),
};
GEO.beam.translate(0, 0.5, 0);
GEO.ring.rotateX(-Math.PI / 2);

function dashedRing(inner: number, outer: number, dashes: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const step = (Math.PI * 2) / dashes;
  for (let i = 0; i < dashes; i++) {
    const g = new THREE.RingGeometry(inner, outer, 4, 1, i * step, step * 0.55);
    g.deleteAttribute('uv');
    parts.push(g.toNonIndexed());
    g.dispose();
  }
  const m = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  m.rotateX(-Math.PI / 2);
  return m;
}

/** Gun silhouette proportions per archetype: [bodyLen, barrelLen, barrelThick, stock]. */
const GUN_SHAPE: Record<WeaponArchetype, [number, number, number, boolean]> = {
  pistol: [0.28, 0.16, 0.06, false],
  smg: [0.36, 0.2, 0.06, false],
  shotgun: [0.44, 0.36, 0.09, true],
  rifle: [0.5, 0.3, 0.06, true],
  sniper: [0.56, 0.5, 0.05, true],
};

const beamVert = /* glsl */ `
varying float vY;
varying vec3 vN;
varying vec3 vV;
void main() {
  vY = position.y;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vV = normalize( -mv.xyz );
  vN = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;
const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSoft;
uniform float uFade;
varying float vY;
varying vec3 vN;
varying vec3 vV;
void main() {
  float fade = pow( 1.0 - clamp( vY, 0.0, 1.0 ), uFade ) * smoothstep( 0.0, 0.04, vY + 0.02 );
  float edge = mix( 1.0, pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.2 ), uSoft );
  float a = uAlpha * fade * edge;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

const moteVert = /* glsl */ `
attribute vec3 aSeed;
uniform float uTime;
uniform float uH;
uniform float uPR;
varying float vA;
void main() {
  float v = fract( aSeed.x + uTime * ( 0.06 + aSeed.z * 0.05 ) );
  float a = aSeed.y * 6.2831 + uTime * 0.4;
  vec3 p = vec3( cos( a ) * 0.22, v * uH, sin( a ) * 0.22 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp( 0.09 * uPR * 600.0 / max( -mv.z, 0.5 ), 1.5, 6.0 );
  vA = smoothstep( 0.0, 0.1, v ) * ( 1.0 - smoothstep( 0.6, 1.0, v ) );
}
`;
const moteFrag = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length( gl_PointCoord - 0.5 );
  float a = ( 1.0 - smoothstep( 0.2, 0.5, d ) ) * vA;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

export interface LootView {
  add(item: LootItemState): void;
  remove(id: string): void;
  update(items: LootItemState[], dt: number): void;
  clear(): void;
}

interface View {
  root: THREE.Group;
  icon: THREE.Group;
  mats: THREE.ShaderMaterial[];
  baseAlpha: number[];
  core: THREE.ShaderMaterial | null;
  coreBase: THREE.Color | null;
  ring: THREE.Mesh;
  outer: THREE.Mesh | null;
  motes: THREE.ShaderMaterial | null;
  phase: number;
  legendary: boolean;
  gear: GearModel | null;
}

/** Kinds that carry a rarity (beam per §9); the rest are consumables with a small kind-coloured beam. */
const RARITY_KINDS = new Set<LootItemState['kind']>(['weapon', 'gear']);

const KIND_COLOR: Record<Exclude<LootItemState['kind'], 'weapon' | 'gear'>, number> = {
  ammo: 0xd9cfae, // warm BONE
  health: 0xe0402f, // UI health red (not THREAT)
  grenade: PALETTE.HAZARD_PAINT,
};

export function createLootView(ctx: GameContext): LootView {
  const toonCache = new Map<string, THREE.Material>();
  const glowCache = new Map<string, THREE.MeshBasicMaterial>();
  const views = new Map<string, View>();
  let time = 0;
  const camPos = new THREE.Vector3();
  let pixelRatio = 1;

  const toon = (color: number, surface: 'steel' | 'paint' | 'character' = 'steel'): THREE.Material => {
    const key = `${color}:${surface}`;
    let m = toonCache.get(key);
    if (!m) {
      m = ctx.materials.toon({ color, surface });
      toonCache.set(key, m);
    }
    return m;
  };

  /** Additive unlit glow at a luminance target (shared). */
  const glow = (color: number, lum: number, opacity = 1): THREE.MeshBasicMaterial => {
    const key = `${color}:${lum}:${opacity}`;
    let m = glowCache.get(key);
    if (!m) {
      m = ctx.materials.glow(color, glowLum(color, lum, 12));
      m.transparent = true;
      m.opacity = opacity;
      m.blending = THREE.AdditiveBlending;
      m.depthWrite = false;
      m.side = THREE.DoubleSide;
      m.fog = false;
      glowCache.set(key, m);
    }
    return m;
  };

  const beamMat = (color: THREE.Color, alpha: number, soft: number, fadePow = 1.3): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color.clone() }, uAlpha: { value: alpha }, uSoft: { value: soft }, uFade: { value: fadePow } },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    m.userData.noInk = true;
    return m;
  };

  const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh => {
    const m = new THREE.Mesh(GEO.box, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };

  function buildIcon(item: LootItemState, color: number): { icon: THREE.Group; gear: GearModel | null } {
    if (item.kind === 'gear' && item.gear) {
      const g = new THREE.Group();
      const model = buildGearModel(item.gear, ctx.materials);
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
      model.scale.setScalar(1.5);
      g.add(model);
      return { icon: g, gear: model };
    }
    return { icon: buildBasicIcon(item, color), gear: null };
  }

  function buildBasicIcon(item: LootItemState, color: number): THREE.Group {
    const g = new THREE.Group();
    const seam = glow(color, item.rarity === 'legendary' ? 2.5 : 1.2);
    switch (item.kind) {
      case 'weapon': {
        const w = item.weapon!;
        const [len, barrel, thick, stock] = GUN_SHAPE[w.archetype];
        const body = toon(PALETTE.STEEL);
        const dark = toon(PALETTE.STEEL_DARK);
        g.add(box(body, len, 0.12, 0.08, 0, 0, 0));
        g.add(box(seam, len * 0.8, 0.018, 0.084, 0, 0.02, 0)); // rarity seam
        g.add(box(dark, barrel, thick, thick, len / 2 + barrel / 2, 0.02, 0));
        g.add(box(dark, 0.07, 0.16, 0.07, -len * 0.25, -0.13, 0)); // grip
        if (w.archetype !== 'pistol') g.add(box(dark, 0.06, 0.12, 0.06, len * 0.1, -0.11, 0)); // mag
        if (stock) g.add(box(dark, 0.18, 0.1, 0.06, -len / 2 - 0.09, -0.02, 0));
        if (w.archetype === 'sniper') g.add(box(dark, 0.18, 0.05, 0.05, 0, 0.1, 0)); // scope
        g.scale.setScalar(1.25);
        break;
      }
      case 'ammo': {
        g.add(box(toon(PALETTE.STEEL), 0.34, 0.22, 0.24));
        g.add(box(toon(PALETTE.BONE, 'paint'), 0.35, 0.05, 0.25, 0, 0.04, 0));
        break;
      }
      case 'health': {
        g.add(box(toon(PALETTE.STEEL_DARK), 0.34, 0.24, 0.12));
        g.add(box(seam, 0.24, 0.07, 0.13));
        g.add(box(seam, 0.07, 0.2, 0.13));
        break;
      }
      case 'gear': {
        // gear without a def (should not happen): a plated crate with a rarity seam
        g.add(box(toon(PALETTE.STEEL), 0.3, 0.22, 0.22));
        g.add(box(seam, 0.31, 0.02, 0.23, 0, 0.03, 0));
        break;
      }
      case 'grenade': {
        const s = new THREE.Mesh(GEO.sphere, toon(PALETTE.STEEL_DARK));
        s.castShadow = true;
        g.add(s);
        g.add(box(toon(PALETTE.HAZARD_PAINT, 'paint'), 0.34, 0.05, 0.34, 0, 0, 0));
        g.add(box(toon(PALETTE.STEEL), 0.08, 0.08, 0.08, 0, 0.17, 0));
        break;
      }
    }
    return g;
  }

  function add(item: LootItemState): void {
    if (views.has(item.id)) return;
    const weapon = RARITY_KINDS.has(item.kind);
    const color = weapon ? RARITY_COLORS[item.rarity] : KIND_COLOR[item.kind as keyof typeof KIND_COLOR];
    const spec = weapon ? BEAM[item.rarity] : { height: 1.3, sheath: 0.3, core: 1.1, motes: false, double: false };
    const legendary = weapon && item.rarity === 'legendary';

    const root = new THREE.Group();
    root.position.set(item.position.x, item.position.y, item.position.z);

    const { icon, gear } = buildIcon(item, color);
    icon.position.y = 0.7;
    root.add(icon);

    const mats: THREE.ShaderMaterial[] = [];
    const baseAlpha: number[] = [];
    const rc = new THREE.Color(color);
    // sheath: rarity colour, lum ~1 at full alpha
    const sheathCol = rc.clone().multiplyScalar(glowLum(color, 1.0, 12));
    const sheath = beamMat(sheathCol, spec.sheath, 1);
    const sheathMesh = new THREE.Mesh(GEO.beam, sheath);
    const sr = weapon ? 0.12 : 0.07;
    sheathMesh.scale.set(sr, spec.height, sr);
    sheathMesh.renderOrder = 30;
    root.add(sheathMesh);
    mats.push(sheath);
    baseAlpha.push(spec.sheath);
    // epic / legendary: a wide, faint outer halo column that keeps the drop readable from across
    // the arena (the 0.12 m sheath is only a few pixels wide at 30 m); slower fade toward the top
    if (weapon && (item.rarity === 'legendary' || item.rarity === 'epic')) {
      const leg = item.rarity === 'legendary';
      const haloA = leg ? 0.16 : 0.09;
      const halo = beamMat(rc.clone().multiplyScalar(glowLum(color, 0.9, 12)), haloA, 1, leg ? 0.9 : 1.1);
      const haloMesh = new THREE.Mesh(GEO.beam, halo);
      const hr = leg ? 0.55 : 0.36;
      haloMesh.scale.set(hr, spec.height * (leg ? 1.1 : 1), hr);
      haloMesh.renderOrder = 29;
      root.add(haloMesh);
      mats.push(halo);
      baseAlpha.push(haloA);
    }
    // core: 70 % white + 30 % rarity, at the rarity's core lum
    const coreCol = new THREE.Color(1, 1, 1).lerp(rc, 0.3);
    const cl = 0.2126 * coreCol.r + 0.7152 * coreCol.g + 0.0722 * coreCol.b;
    coreCol.multiplyScalar(spec.core / Math.max(0.05, cl));
    const core = beamMat(coreCol, 1, 0);
    const coreMesh = new THREE.Mesh(GEO.beam, core);
    const cr = weapon ? 0.03 : 0.02;
    coreMesh.scale.set(cr, spec.height * 0.92, cr);
    coreMesh.renderOrder = 31;
    root.add(coreMesh);
    mats.push(core);
    baseAlpha.push(1);

    const ring = new THREE.Mesh(GEO.ring, glow(color, 1.5, 0.9));
    ring.position.y = 0.03;
    ring.renderOrder = 30;
    ring.scale.setScalar(weapon ? 1 : 0.6);
    root.add(ring);

    let outer: THREE.Mesh | null = null;
    if (spec.double) {
      outer = new THREE.Mesh(GEO.outer, glow(color, 1.5, 0.9));
      outer.position.y = 0.035;
      outer.renderOrder = 30;
      root.add(outer);
    }

    let motes: THREE.ShaderMaterial | null = null;
    if (spec.motes) {
      const n = item.rarity === 'rare' ? 8 : item.rarity === 'epic' ? 12 : 18;
      const seeds = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        seeds[i * 3] = (i * 0.618) % 1;
        seeds[i * 3 + 1] = (i * 0.377 + 0.11) % 1;
        seeds[i * 3 + 2] = (i * 0.233) % 1;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
      motes = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uH: { value: spec.height * 0.8 }, uPR: { value: pixelRatio }, uColor: { value: rc.clone().multiplyScalar(glowLum(color, 1.6, 12)) } },
        vertexShader: moteVert,
        fragmentShader: moteFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const pts = new THREE.Points(geo, motes);
      pts.frustumCulled = false;
      pts.renderOrder = 32;
      root.add(pts);
    }

    ctx.scene.add(root);
    views.set(item.id, {
      root, icon, mats, baseAlpha, core: legendary ? core : null, coreBase: legendary ? coreCol.clone() : null,
      ring, outer, motes, phase: (views.size * 1.37) % (Math.PI * 2), legendary, gear,
    });
  }

  function remove(id: string): void {
    const v = views.get(id);
    if (!v) return;
    ctx.scene.remove(v.root);
    v.gear?.dispose();
    for (const m of v.mats) m.dispose();
    if (v.motes) {
      v.motes.dispose();
      v.root.traverse((o) => { if ((o as THREE.Points).isPoints) (o as THREE.Points).geometry.dispose(); });
    }
    views.delete(id);
  }

  function update(items: LootItemState[], dt: number): void {
    time += dt;
    pixelRatio = ctx.renderer?.getPixelRatio?.() ?? 1;
    ctx.camera.getWorldPosition(camPos);
    for (const item of items) {
      const v = views.get(item.id);
      if (!v) continue;
      const dx = camPos.x - v.root.position.x;
      const dz = camPos.z - v.root.position.z;
      // fade the beam as the camera walks into it (an additive column filling the screen whites out)
      const near = THREE.MathUtils.smoothstep(Math.sqrt(dx * dx + dz * dz), 1.0, 6);
      for (let i = 0; i < v.mats.length; i++) v.mats[i].uniforms.uAlpha.value = v.baseAlpha[i] * (0.1 + 0.9 * near);
      v.icon.position.y = 0.7 + Math.sin(time * 2.4 + v.phase) * 0.1;
      v.icon.rotation.y += dt * 1.2;
      v.gear?.animate(time);
      v.ring.rotation.y += dt * 0.6;
      if (v.outer) v.outer.rotation.y -= dt * 0.9;
      if (v.core && v.coreBase) {
        const p = 1 + 0.25 * (0.5 + 0.5 * Math.sin(time * 3 + v.phase)); // lum 4 → 5
        (v.core.uniforms.uColor.value as THREE.Color).copy(v.coreBase).multiplyScalar(p);
      }
      if (v.motes) {
        v.motes.uniforms.uTime.value = time + v.phase * 3;
        v.motes.uniforms.uPR.value = pixelRatio;
      }
      const left = LOOT.lifetime - item.age;
      if (left < BLINK_WINDOW) {
        const rate = left < 3 ? 10 : 5;
        v.root.visible = Math.sin(time * rate * Math.PI) > -0.2;
      } else {
        v.root.visible = true;
      }
    }
  }

  function clear(): void {
    for (const id of Array.from(views.keys())) remove(id);
  }

  return { add, remove, update, clear };
}

/** Rarity → beam spec (exported for tests / UI). */
export const beamSpec = (r: Rarity) => BEAM[r];
