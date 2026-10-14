/** Tiny DOM + formatting helpers for the HUD. */
import { ELEMENT_COLORS, RARITY_COLORS, type Element, type Rarity } from '@/core/types';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', parent?: HTMLElement, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

export const hex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
export const rarityCss = (r: Rarity) => hex(RARITY_COLORS[r]);
export const elementCss = (e: Element) => hex(ELEMENT_COLORS[e]);

export const ELEMENT_LABEL: Record<Element, string> = { none: '', fire: 'Fire', shock: 'Shock', ice: 'Ice' };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Set textContent only when it changes (avoids layout churn every frame). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Set a scaleX transform only when it changes noticeably. */
export function setScaleX(el: HTMLElement, v: number): void {
  const s = `scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})`;
  if (el.style.transform !== s) el.style.transform = s;
}

export function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}
