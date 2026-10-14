/**
 * Pooled damage tags (docs/ART_DIRECTION.md §10.3): Martian Mono 700 on a small panel-solid
 * rectangle; crits inverted (panel text on BONE) with a tiny CRIT label; elemental damage in
 * the element colour. Motion: rise 24 px over 0.6 s and cut out — no bounce, no scale pop.
 */
import * as THREE from 'three';
import type { Element, GameContext } from '@/core/types';
import { elementCss, h } from './dom';

const POOL = 56;
const LIFE = 0.6;
const RISE = 24;
const MERGE_WINDOW = 0.12;

interface Num {
  el: HTMLDivElement;
  active: boolean;
  world: THREE.Vector3;
  age: number;
  amount: number;
  crit: boolean;
  enemyId: string;
  ox: number;
}

export interface DamageNumbers {
  spawn(enemyId: string, point: THREE.Vector3, amount: number, crit: boolean, element: Element): void;
  update(dt: number): void;
  clear(): void;
}

export function createDamageNumbers(ctx: GameContext, parent: HTMLElement): DamageNumbers {
  const layer = h('div', '', parent);
  layer.style.cssText = 'position:absolute;inset:0;';
  const pool: Num[] = [];
  for (let i = 0; i < POOL; i++) {
    const el = h('div', 'sb-dmg', layer);
    el.style.display = 'none';
    pool.push({ el, active: false, world: new THREE.Vector3(), age: 0, amount: 0, crit: false, enemyId: '', ox: 0 });
  }
  let cursor = 0;
  let side = 0;
  const v = new THREE.Vector3();

  function spawn(enemyId: string, point: THREE.Vector3, amount: number, crit: boolean, element: Element): void {
    // Merge pellets/rapid hits on the same enemy into one tag.
    for (const n of pool) {
      if (n.active && n.enemyId === enemyId && n.age < MERGE_WINDOW && n.crit === crit) {
        n.amount += amount;
        n.el.textContent = `${Math.round(n.amount)}`;
        return;
      }
    }
    let n = pool.find((p) => !p.active);
    if (!n) {
      n = pool[cursor];
      cursor = (cursor + 1) % POOL;
    }
    n.active = true;
    n.world.copy(point);
    n.age = 0;
    n.amount = amount;
    n.crit = crit;
    n.enemyId = enemyId;
    side = (side + 1) % 3;
    n.ox = (side - 1) * 18;
    n.el.className = crit ? 'sb-dmg crit' : 'sb-dmg';
    n.el.style.color = crit ? '' : element === 'none' ? '' : elementCss(element);
    n.el.textContent = `${Math.round(amount)}`;
    n.el.style.display = '';
  }

  function update(dt: number): void {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const cam = ctx.camera;
    for (const n of pool) {
      if (!n.active) continue;
      n.age += dt;
      if (n.age >= LIFE) {
        n.active = false;
        n.el.style.display = 'none';
        continue;
      }
      v.copy(n.world).project(cam);
      if (v.z > 1 || v.z < -1) {
        n.el.style.visibility = 'hidden';
        continue;
      }
      n.el.style.visibility = '';
      const t = n.age / LIFE;
      const x = Math.round((v.x * 0.5 + 0.5) * w + n.ox);
      const y = Math.round((-v.y * 0.5 + 0.5) * hgt - 28 - RISE * t);
      n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  function clear(): void {
    for (const n of pool) {
      n.active = false;
      n.el.style.display = 'none';
    }
  }

  return { spawn, update, clear };
}
