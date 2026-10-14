/**
 * Paper-doll preview: a standalone mini scene (own Scene / camera / WebGLRenderer on the given
 * canvas) with a procedural mannequin wearing a Loadout, slowly rotating on a concrete plinth.
 * Embed it in the inventory screen: create once, setLoadout() on every change, update(dt)
 * each frame while the screen is open, dispose() when the screen is torn down.
 * Drag on the canvas to spin the doll; it resumes auto-rotation after a moment.
 */
import * as THREE from 'three';
import type { MaterialFactory } from '@/core/types';
import { buildGearModel, gearGeometry, type GearModel } from './models';
import { GEAR_PALETTE, GEAR_TOON_HATCH } from './palette';
import { GEAR_SLOTS, type GearSlot, type Loadout } from './types';

export interface PaperDollOptions {
  /** Spin on its own (default true). */
  autoRotate?: boolean;
  /** Clear colour; null = transparent canvas (default palette dollBackground). */
  background?: number | null;
  /** Cap on devicePixelRatio (default 2). */
  maxPixelRatio?: number;
}

export interface PaperDoll {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  setLoadout(loadout: Loadout): void;
  update(dt: number): void;
  /** Resize the drawing buffer; defaults to the canvas' CSS size. Called automatically when it changes. */
  resize(width?: number, height?: number): void;
  setAutoRotate(on: boolean): void;
  dispose(): void;
}

/** Mannequin anchor points that gear attaches to (see models.ts anchor conventions). */
interface Mannequin {
  root: THREE.Group;
  figure: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Object3D;
  chest: THREE.Object3D;
  wrists: [THREE.Object3D, THREE.Object3D]; // [left (-x), right (+x)]
  ankles: [THREE.Object3D, THREE.Object3D];
  hands: [THREE.Mesh, THREE.Mesh];
  feet: [THREE.Mesh, THREE.Mesh];
  shoulders: [THREE.Group, THREE.Group];
  trinket: THREE.Group;
}

const ANKLE_Y = 0.088;

export function createPaperDoll(canvas: HTMLCanvasElement, materials: MaterialFactory, opts: PaperDollOptions = {}): PaperDoll {
  const background = opts.background === undefined ? GEAR_PALETTE.dollBackground : opts.background;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: background === null });
  renderer.setPixelRatio(Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, opts.maxPixelRatio ?? 2));
  if (background === null) renderer.setClearColor(0x000000, 0);
  else renderer.setClearColor(background, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
  camera.position.set(0, 1.12, 4.6);
  camera.lookAt(0, 0.98, 0);

  // lights (ART_DIRECTION §5 in miniature): FLOODLIGHT key from high front-left, cool
  // hemisphere fill with floor bounce, a FLOODLIGHT back-rim so the silhouette reads
  scene.add(new THREE.HemisphereLight(GEAR_PALETTE.dollSky, GEAR_PALETTE.dollGround, 1.1));
  const key = new THREE.DirectionalLight(GEAR_PALETTE.dollKeyLight, 3.2);
  key.position.set(-2, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(GEAR_PALETTE.dollRimLight, 1.2);
  rim.position.set(2.5, 2, -3);
  scene.add(rim);

  // doll-owned materials (disposed with the doll)
  const ownedMats: THREE.Material[] = [];
  const toon = (color: number) => {
    const m = materials.toon({ color, surface: 'character', hatch: GEAR_TOON_HATCH });
    ownedMats.push(m);
    return m;
  };
  const bodyMat = toon(GEAR_PALETTE.dollBody);
  const jointMat = toon(GEAR_PALETTE.dollJoint);
  const floorMat = toon(GEAR_PALETTE.dollFloor);
  const ringMat = toon(GEAR_PALETTE.dollFloorRing);

  const g = gearGeometry();
  const plinth = new THREE.Mesh(g.cyl, floorMat);
  plinth.scale.set(1.3, 0.06, 1.3);
  plinth.position.y = -0.03;
  scene.add(plinth);
  const plinthRing = new THREE.Mesh(g.cyl, ringMat);
  plinthRing.scale.set(1.42, 0.04, 1.42);
  plinthRing.position.y = -0.05;
  scene.add(plinthRing);

  const man = buildMannequin(g, bodyMat, jointMat);
  scene.add(man.root);

  // ---- loadout --------------------------------------------------------------
  const models = new Map<GearSlot, { model: GearModel; id: string; attached: THREE.Object3D[] }>();
  let soleLift = 0;

  function detach(slot: GearSlot): void {
    const cur = models.get(slot);
    if (!cur) return;
    for (const o of cur.attached) o.removeFromParent();
    cur.model.dispose();
    models.delete(slot);
  }

  function attach(slot: GearSlot, model: GearModel): THREE.Object3D[] {
    switch (slot) {
      case 'helm':
        man.head.add(model);
        return [model];
      case 'chest':
        man.chest.add(model);
        return [model];
      case 'trinket':
        model.scale.setScalar(1.15);
        man.trinket.add(model);
        return [model];
      case 'boots':
      case 'gloves': {
        const anchors = slot === 'boots' ? man.ankles : man.wrists;
        const out: THREE.Object3D[] = [];
        const sides = [model.left, model.right];
        for (let i = 0; i < 2; i++) {
          const side = sides[i];
          if (!side) continue;
          side.position.set(0, 0, 0);
          anchors[i].add(side);
          out.push(side);
        }
        return out;
      }
    }
  }

  function setLoadout(loadout: Loadout): void {
    for (const slot of GEAR_SLOTS) {
      const def = loadout[slot];
      const cur = models.get(slot);
      if (cur && def && cur.id === def.id) continue;
      detach(slot);
      if (!def || def.slot !== slot) continue;
      const model = buildGearModel(def, materials);
      models.set(slot, { model, id: def.id, attached: attach(slot, model) });
    }
    const boots = models.get('boots');
    soleLift = boots && boots.model.params.slot === 'boots' ? boots.model.params.soleThickness : 0;
    man.figure.position.y = soleLift;
    const gloved = models.has('gloves');
    const booted = models.has('boots');
    for (const h of man.hands) h.visible = !gloved;
    for (const f of man.feet) f.visible = !booted;
  }

  // ---- interaction ----------------------------------------------------------
  let autoRotate = opts.autoRotate ?? true;
  let dragging = false;
  let lastX = 0;
  let idleAfterDrag = 0;
  let spinVel = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    man.root.rotation.y += dx * 0.012;
    spinVel = dx * 0.6;
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    idleAfterDrag = 2.5;
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ---- frame ----------------------------------------------------------------
  let lastW = 0;
  let lastH = 0;
  function resize(width?: number, height?: number): void {
    const w = Math.max(1, Math.floor(width ?? canvas.clientWidth ?? canvas.width));
    const h = Math.max(1, Math.floor(height ?? canvas.clientHeight ?? canvas.height));
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  let t = 0;
  function update(dt: number): void {
    t += dt;
    const cw = canvas.clientWidth || canvas.width;
    const ch = canvas.clientHeight || canvas.height;
    if (cw !== lastW || ch !== lastH) resize(cw, ch);

    if (!dragging) {
      if (idleAfterDrag > 0) {
        idleAfterDrag -= dt;
        man.root.rotation.y += spinVel * dt * 0.02;
        spinVel *= Math.exp(-4 * dt);
      } else if (autoRotate) {
        man.root.rotation.y += dt * 0.55;
      }
    }

    // idle: breathing + arm sway
    const breath = Math.sin(t * 1.8);
    man.torso.scale.y = 1 + breath * 0.012;
    man.chest.position.y = 1.28 + breath * 0.004;
    man.shoulders[0].rotation.x = Math.sin(t * 1.1) * 0.05;
    man.shoulders[1].rotation.x = -Math.sin(t * 1.1) * 0.05;
    man.trinket.position.y = 1.02 + Math.sin(t * 1.6) * 0.03;

    for (const { model } of models.values()) model.animate(t);
    renderer.render(scene, camera);
  }

  function dispose(): void {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    for (const slot of GEAR_SLOTS) detach(slot);
    for (const m of ownedMats) m.dispose();
    ownedMats.length = 0;
    scene.clear();
    renderer.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    setLoadout,
    update,
    resize,
    setAutoRotate: (on) => {
      autoRotate = on;
    },
    dispose,
  };
}

/** Blocky mannequin, feet on y=0, facing +Z, ~1.82 m tall. All meshes use shared unit geometry. */
function buildMannequin(g: ReturnType<typeof gearGeometry>, body: THREE.Material, joint: THREE.Material): Mannequin {
  const root = new THREE.Group();
  const figure = new THREE.Group();
  root.add(figure);
  const box = (parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(g.chamfer, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  box(figure, joint, 0.32, 0.14, 0.2, 0, 0.95, 0); // pelvis
  const torso = box(figure, body, 0.38, 0.52, 0.22, 0, 1.28, 0);
  const neck = new THREE.Mesh(g.cyl, joint);
  neck.scale.set(0.1, 0.1, 0.1);
  neck.position.y = 1.58;
  figure.add(neck);
  box(figure, body, 0.2, 0.24, 0.22, 0, 1.7, 0); // head block
  const head = new THREE.Group();
  head.position.y = 1.7;
  figure.add(head);
  const chest = new THREE.Group();
  chest.position.y = 1.28;
  figure.add(chest);

  const wrists: THREE.Object3D[] = [];
  const ankles: THREE.Object3D[] = [];
  const hands: THREE.Mesh[] = [];
  const feet: THREE.Mesh[] = [];
  const shoulders: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    // leg
    box(figure, body, 0.13, 0.42, 0.14, s * 0.1, 0.7, 0);
    box(figure, joint, 0.11, 0.06, 0.12, s * 0.1, 0.48, 0.01); // knee
    box(figure, body, 0.11, 0.36, 0.12, s * 0.1, 0.28, 0);
    const ankle = new THREE.Group();
    ankle.position.set(s * 0.1, ANKLE_Y, 0);
    figure.add(ankle);
    ankles.push(ankle);
    feet.push(box(ankle, joint, 0.1, 0.075, 0.2, 0, -0.05, 0.045));

    // arm: shoulder pivot -> upper arm -> elbow -> forearm -> wrist anchor
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.25, 1.49, 0);
    shoulder.rotation.z = s * 0.1;
    figure.add(shoulder);
    shoulders.push(shoulder);
    box(shoulder, body, 0.1, 0.3, 0.1, 0, -0.16, 0);
    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    elbow.rotation.x = -0.12;
    shoulder.add(elbow);
    box(elbow, joint, 0.085, 0.04, 0.085, 0, 0, 0);
    box(elbow, body, 0.09, 0.26, 0.09, 0, -0.14, 0);
    const wrist = new THREE.Group();
    wrist.position.y = -0.28;
    wrist.rotation.y = s * Math.PI / 2; // back of the hand (+Z in glove space) faces outward
    elbow.add(wrist);
    wrists.push(wrist);
    hands.push(box(wrist, joint, 0.08, 0.1, 0.04, 0, -0.06, 0));
  }

  const trinket = new THREE.Group();
  trinket.position.set(0.42, 1.02, 0.12);
  figure.add(trinket);

  return {
    root, figure, torso, head, chest,
    wrists: wrists as [THREE.Object3D, THREE.Object3D],
    ankles: ankles as [THREE.Object3D, THREE.Object3D],
    hands: hands as [THREE.Mesh, THREE.Mesh],
    feet: feet as [THREE.Mesh, THREE.Mesh],
    shoulders: shoulders as [THREE.Group, THREE.Group],
    trinket,
  };
}
