/**
 * Remote player avatar: procedural toon humanoid (helmet, visor, armour plates) holding a
 * simplified gun in the weapon's colour, DOM name tag projected each frame, walk cycle by
 * speed, aim pitch, muzzle flash and a death pose. Local space: feet at y=0, facing -Z
 * (the player controller's forward at yaw 0), so root.rotation.y = yaw.
 */
import * as THREE from 'three';
import type { GameContext, WeaponArchetype } from '@/core/types';
import { RARITY_COLORS, type Rarity } from '@/core/types';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(1, 12, 9);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 8);

/** [bodyLength, barrelLength, barrelThickness, hasStock] (metres), like the loot icon. */
const GUN_SHAPE: Record<WeaponArchetype, [number, number, number, boolean]> = {
  pistol: [0.22, 0.12, 0.05, false],
  smg: [0.32, 0.16, 0.05, false],
  shotgun: [0.42, 0.34, 0.08, true],
  rifle: [0.46, 0.28, 0.05, true],
  sniper: [0.5, 0.46, 0.045, true],
};

/** Stable per-player suit colour. */
const SUIT_COLORS = [0x3d6fd8, 0xd8573d, 0x3dbf6a, 0xc9a53d, 0x9b4dd8, 0x3dc2c9];
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const _head = new THREE.Vector3();
const _proj = new THREE.Vector3();

export interface AvatarPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export class Avatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly aim = new THREE.Group();
  private readonly gun = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly legs: THREE.Group[] = [];
  private readonly arms: THREE.Group[] = [];
  private readonly flashMesh: THREE.Mesh;
  private readonly owned: THREE.Material[] = [];
  private gunMats: THREE.Material[] = [];
  private gunKey = '';
  private walkPhase = 0;
  private speed = 0;
  private flashT = 0;
  private deathT = 0;
  private alive = true;
  private readonly last = new THREE.Vector3();
  private hasLast = false;
  private tag: HTMLDivElement | null = null;
  private tagName: HTMLSpanElement | null = null;
  private tagBar: HTMLDivElement | null = null;
  private tagText = '';
  health01 = 1;
  shield01 = 1;
  /** Extra text shown under the name (DOWNED, revive %). */
  status = '';

  constructor(private readonly ctx: GameContext, readonly id: string, public name: string) {
    const suit = SUIT_COLORS[hashId(id) % SUIT_COLORS.length];
    const m = (color: number, emissive?: number, intensity?: number) => {
      const mat = ctx.materials.toon({ color, emissive, emissiveIntensity: intensity });
      this.owned.push(mat);
      return mat;
    };
    const suitMat = m(suit);
    const dark = m(0x272b36);
    const plate = m(0xc9d2e0);
    const visorMat = ctx.materials.glow(0x8fe8ff, 2.2);
    this.owned.push(visorMat);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number], s: [number, number, number]) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.scale.set(s[0], s[1], s[2]);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    this.root.name = `avatar:${id}`;
    this.root.rotation.order = 'YXZ';
    // legs (hip pivots)
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(0.13 * sx, 0.9, 0);
      add(leg, BOX, dark, [0, -0.24, 0], [0.18, 0.48, 0.2]);
      add(leg, BOX, suitMat, [0, -0.64, 0], [0.16, 0.42, 0.18]);
      add(leg, BOX, dark, [0, -0.86, -0.04], [0.2, 0.1, 0.3]);
      add(leg, BOX, plate, [0, -0.42, -0.1], [0.14, 0.14, 0.04]);
      this.root.add(leg);
      this.legs.push(leg);
    }
    // torso
    this.body.position.set(0, 0.9, 0);
    this.root.add(this.body);
    add(this.body, BOX, dark, [0, 0.05, 0], [0.36, 0.16, 0.22]);
    add(this.body, BOX, suitMat, [0, 0.36, 0], [0.46, 0.46, 0.26]);
    add(this.body, BOX, plate, [0, 0.4, -0.14], [0.36, 0.3, 0.04]);
    for (const sx of [-1, 1]) add(this.body, SPHERE, plate, [0.27 * sx, 0.58, 0], [0.12, 0.09, 0.13]);
    add(this.body, BOX, dark, [0, 0.38, 0.17], [0.3, 0.34, 0.1]); // backpack
    // head
    this.head.position.set(0, 0.68, 0);
    this.body.add(this.head);
    add(this.head, SPHERE, suitMat, [0, 0.13, 0], [0.16, 0.17, 0.17]);
    add(this.head, BOX, visorMat, [0, 0.14, -0.13], [0.22, 0.07, 0.08]);
    add(this.head, BOX, dark, [0, 0.29, 0.02], [0.05, 0.06, 0.24]); // crest

    // aim pivot: arms + gun pitch with the view
    this.aim.position.set(0, 0.5, 0);
    this.body.add(this.aim);
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(0.26 * sx, 0.06, 0);
      add(arm, CYL, suitMat, [0, 0, -0.18], [0.055, 0.36, 0.055]).rotation.x = Math.PI / 2;
      add(arm, SPHERE, dark, [0, 0, -0.38], [0.06, 0.06, 0.06]);
      // arms angle inward to meet at the gun
      arm.rotation.y = 0.32 * sx;
      this.aim.add(arm);
      this.arms.push(arm);
    }
    this.gun.position.set(0.04, 0.02, -0.42);
    this.aim.add(this.gun);
    this.gun.add(this.muzzle);
    const flashMat = ctx.materials.glow(0xffe9b0, 3);
    flashMat.transparent = true;
    flashMat.depthWrite = false;
    this.owned.push(flashMat);
    this.flashMesh = new THREE.Mesh(SPHERE, flashMat);
    this.flashMesh.scale.setScalar(0.09);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);
    this.setWeapon('rifle', 0xb0b0b0, 'common');

    // avatars are not hitscan targets for the local player's weapons
    this.root.traverse((o) => { o.raycast = () => {}; });
    ctx.scene.add(this.root);
    this.makeTag();
  }

  setWeapon(archetype: WeaponArchetype | null, color: number, rarity: Rarity): void {
    const key = archetype ? `${archetype}:${color}:${rarity}` : 'none';
    if (key === this.gunKey) return;
    this.gunKey = key;
    for (const c of [...this.gun.children]) if (c !== this.muzzle) this.gun.remove(c);
    for (const mm of this.gunMats) mm.dispose();
    this.gunMats = [];
    if (!archetype) return;
    const [len, barrel, thick, stock] = GUN_SHAPE[archetype];
    const bodyMat = this.ctx.materials.toon({ color, emissive: color, emissiveIntensity: 0.2 });
    const darkMat = this.ctx.materials.toon({ color: 0x2a2c33 });
    const trimMat = this.ctx.materials.glow(RARITY_COLORS[rarity] ?? 0xffffff, 1.6);
    this.gunMats.push(bodyMat, darkMat, trimMat);
    const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(BOX, mat);
      mesh.scale.set(sx, sy, sz);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.raycast = () => {};
      this.gun.add(mesh);
    };
    // gun points along -Z
    box(bodyMat, 0.07, 0.1, len, 0, 0, 0);
    box(darkMat, thick, thick, barrel, 0, 0.015, -len / 2 - barrel / 2);
    box(darkMat, 0.06, 0.13, 0.06, 0, -0.1, len * 0.2);
    box(trimMat, 0.075, 0.02, len * 0.6, 0, 0.055, 0);
    if (archetype !== 'pistol') box(bodyMat, 0.05, 0.11, 0.06, 0, -0.1, -len * 0.1);
    if (stock) box(darkMat, 0.05, 0.09, 0.16, 0, -0.02, len / 2 + 0.08);
    if (archetype === 'sniper') box(darkMat, 0.045, 0.045, 0.16, 0, 0.09, 0);
    this.muzzle.position.set(0, 0.015, -len / 2 - barrel - 0.03);
  }

  /** Muzzle world position (tracer origin for remote shots). */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(out);
  }

  flash(): void {
    this.flashT = 0.05;
  }

  setAlive(alive: boolean): void {
    if (alive === this.alive) return;
    this.alive = alive;
    this.deathT = 0;
  }

  /** Pose from interpolated network state; derives walk speed from motion. */
  update(dt: number, pose: AvatarPose): void {
    const r = this.root;
    if (this.hasLast && dt > 0) {
      const sp = Math.hypot(pose.x - this.last.x, pose.z - this.last.z) / dt;
      this.speed += (Math.min(sp, 14) - this.speed) * Math.min(1, dt * 10);
    }
    this.last.set(pose.x, pose.y, pose.z);
    this.hasLast = true;
    r.position.set(pose.x, pose.y, pose.z);
    r.rotation.y = pose.yaw;

    if (this.alive) {
      const k = Math.min(1, this.speed / 7.5);
      this.walkPhase += this.speed * dt * 1.6;
      const swing = Math.sin(this.walkPhase) * 0.75 * k;
      this.legs[0].rotation.x = swing;
      this.legs[1].rotation.x = -swing;
      this.body.position.y = 0.9 + Math.abs(Math.cos(this.walkPhase)) * 0.04 * k;
      this.body.rotation.x = -0.08 * k; // lean into the run
      this.aim.rotation.x = THREE.MathUtils.clamp(pose.pitch, -1.2, 1.2) + 0.08 * k;
      this.head.rotation.x = THREE.MathUtils.clamp(pose.pitch * 0.6, -0.6, 0.6);
      r.rotation.x = 0;
    } else {
      this.deathT += dt;
      const f = 1 - Math.pow(1 - Math.min(1, this.deathT / 0.5), 2);
      r.rotation.x = f * (Math.PI / 2 - 0.1);
      r.position.y = pose.y + f * 0.18;
      this.legs[0].rotation.x = 0.2 * f;
      this.legs[1].rotation.x = -0.15 * f;
      this.aim.rotation.x = -0.6 * f;
    }

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashMesh.visible = true;
      this.flashMesh.rotation.z = Math.random() * Math.PI;
    } else {
      this.flashMesh.visible = false;
    }
    this.updateTag();
  }

  // ---- name tag (DOM, projected) -------------------------------------------------
  private makeTag(): void {
    if (typeof document === 'undefined' || !this.ctx.uiRoot) return;
    const tag = document.createElement('div');
    tag.style.cssText =
      'position:absolute;left:0;top:0;pointer-events:none;transform:translate(-9999px,0);' +
      'font:600 12px/1.1 system-ui,sans-serif;color:#fff;text-align:center;white-space:nowrap;' +
      'text-shadow:0 1px 2px #000,0 0 4px #000;z-index:5;will-change:transform';
    const name = document.createElement('span');
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'width:56px;height:4px;margin:3px auto 0;background:rgba(0,0,0,.55);border:1px solid rgba(0,0,0,.8)';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:100%;width:100%;background:#ff4a4a;transform-origin:left center';
    barWrap.appendChild(bar);
    tag.appendChild(name);
    tag.appendChild(barWrap);
    this.ctx.uiRoot.appendChild(tag);
    this.tag = tag;
    this.tagName = name;
    this.tagBar = bar;
  }

  private updateTag(): void {
    const tag = this.tag;
    if (!tag) return;
    const text = this.status ? `${this.name} · ${this.status}` : this.name;
    if (text !== this.tagText) {
      this.tagText = text;
      this.tagName!.textContent = text;
      this.tagName!.style.color = this.status ? '#ffb347' : '#fff';
    }
    this.tagBar!.style.transform = `scaleX(${Math.max(0, Math.min(1, this.health01)).toFixed(3)})`;
    this.tagBar!.style.background = this.shield01 > 0.01 ? '#5fb8ff' : '#ff4a4a';
    const cam = this.ctx.camera;
    _head.set(this.root.position.x, this.root.position.y + (this.alive ? 2.15 : 0.9), this.root.position.z);
    const dist = _head.distanceTo(cam.position);
    _proj.copy(_head).project(cam);
    const w = this.ctx.renderer?.domElement?.clientWidth || window.innerWidth;
    const h = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight;
    if (_proj.z > 1 || _proj.z < -1 || dist > 80) {
      tag.style.transform = 'translate(-9999px,0)';
      return;
    }
    const x = (_proj.x * 0.5 + 0.5) * w;
    const y = (-_proj.y * 0.5 + 0.5) * h;
    const scale = THREE.MathUtils.clamp(14 / Math.max(1, dist), 0.65, 1.15);
    tag.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%) scale(${scale.toFixed(2)})`;
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    for (const m of this.owned) m.dispose();
    for (const m of this.gunMats) m.dispose();
    this.tag?.remove();
    this.tag = null;
  }
}
