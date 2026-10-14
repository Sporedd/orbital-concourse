/**
 * Weapon card as a cargo manifest (docs/ART_DIRECTION.md §10.3): rarity band (rarity + ILV),
 * expanded name, ARCHETYPE · ELEMENT · MAKER, a STAT / THIS / YOURS / Δ table (▲ in BONE,
 * ▼ in dim — glyph and lightness, never red/green), element row, perk box with a rarity
 * hazard tab, procedural barcode + serial and keycaps.
 */
import type { WeaponDef } from '@/core/types';
import { ARCHETYPE_LABEL, weaponAccuracy, weaponDps } from '@/loot/weapons';
import { SPONSOR_WORDS } from '@/rendering/style';
import { ELEMENT_LABEL, elementCss, esc, rarityCss } from './dom';

export function makerOf(w: WeaponDef): string {
  const up = w.name.toUpperCase();
  return SPONSOR_WORDS.find((m) => up.includes(m)) ?? 'UNBRANDED';
}

export function subLine(w: WeaponDef): string {
  const el = w.element !== 'none' ? ELEMENT_LABEL[w.element].toUpperCase() : 'KINETIC';
  const maker = makerOf(w);
  return `${ARCHETYPE_LABEL[w.archetype].toUpperCase()} · ${el}${maker === 'UNBRANDED' ? '' : ` · ${maker}`}`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function barcode(id: string): string {
  let h = hash(id);
  let html = '';
  for (let i = 0; i < 34; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const w = 1 + (h % 3);
    const gap = (h >>> 3) % 2;
    html += `<i style="width:${w}px;margin-right:${gap}px"></i>`;
  }
  return `<div class="sb-barcode">${html}</div>`;
}

export function serialOf(w: WeaponDef): string {
  const id = (hash(w.id) % 46656).toString(36).toUpperCase().padStart(3, '0');
  return `OC-${String(w.level).padStart(2, '0')}-${id}-${w.rarity[0].toUpperCase()}`;
}

type Row = { label: string; a: number; b: number | null; fmt: (v: number) => string; higherIsBetter: boolean };

function delta(r: Row): string {
  if (r.b === null) return '<span class="down">—</span>';
  const base = Math.abs(r.b) > 1e-6 ? Math.abs(r.b) : 1;
  const pct = ((r.a - r.b) / base) * 100;
  if (Math.abs(pct) < 0.5) return '<span class="down">=</span>';
  const better = (pct > 0) === r.higherIsBetter;
  return `<span class="${better ? 'up' : 'down'}">${better ? '▲' : '▼'} ${Math.round(Math.abs(pct))}%</span>`;
}

/** Full manifest card for a candidate weapon (`next`) against the current one. */
export function manifestHtml(next: WeaponDef, cur: WeaponDef | null, opts: { swap?: boolean } = {}): string {
  const dmg = (w: WeaponDef) => w.damage * w.pellets;
  const rows: Row[] = [
    { label: 'DPS', a: weaponDps(next), b: cur ? weaponDps(cur) : null, fmt: (v) => v.toFixed(0), higherIsBetter: true },
    { label: 'DMG', a: dmg(next), b: cur ? dmg(cur) : null, fmt: (v) => v.toFixed(0), higherIsBetter: true },
    { label: 'RATE', a: next.fireRate, b: cur ? cur.fireRate : null, fmt: (v) => v.toFixed(1), higherIsBetter: true },
    { label: 'MAG', a: next.magSize, b: cur ? cur.magSize : null, fmt: (v) => v.toFixed(0), higherIsBetter: true },
    { label: 'ACC', a: weaponAccuracy(next), b: cur ? weaponAccuracy(cur) : null, fmt: (v) => v.toFixed(0), higherIsBetter: true },
    { label: 'RELOAD', a: next.reloadTime, b: cur ? cur.reloadTime : null, fmt: (v) => `${v.toFixed(1)}s`, higherIsBetter: false },
  ];
  const body = rows.map((r) => `<tr><td class="k">${r.label}</td><td class="this">${r.fmt(r.a)}</td><td class="yours">${r.b === null ? '—' : r.fmt(r.b)}</td><td>${delta(r)}</td></tr>`).join('');
  const rc = rarityCss(next.rarity);
  const elem = next.element !== 'none'
    ? `<div class="elem"><span class="sb-sq" style="background:${elementCss(next.element)}"></span><span class="sb-lbl" style="color:var(--bone)">${ELEMENT_LABEL[next.element].toUpperCase()} · ${Math.round(next.elementChance * 100)}% PROC</span></div>`
    : '';
  const perks = next.perks.length
    ? `<div class="perk"><div class="sb-tab thin" style="--tabc:${rc}"></div><div class="pb">${next.perks.map((p) => `<b>${esc(p.name)}</b>${esc(p.description)}`).join('<br>')}</div></div>`
    : '';
  const dmgLabel = next.pellets > 1 ? ` <span class="sb-lbl">(${Math.round(next.damage)}×${next.pellets})</span>` : '';
  return `
    <div class="band" style="background:${rc}"><span>${next.rarity.toUpperCase()}</span><span>ILV ${String(next.level).padStart(2, '0')}</span></div>
    <div class="body">
      <div class="cname">${esc(next.name)}</div>
      <div class="csub sb-lbl">${subLine(next)}${dmgLabel}</div>
      <table><thead><tr><th>STAT</th><th>THIS</th><th>YOURS</th><th>Δ</th></tr></thead><tbody>${body}</tbody></table>
      ${elem}
      ${perks}
      <div class="foot">
        <div>${barcode(next.id)}<div class="sb-serial">${serialOf(next)}</div></div>
        <div class="keys"><span><span class="sb-key">E</span><span class="sb-act">${opts.swap ? 'SWAP' : 'TAKE'}</span></span></div>
      </div>
    </div>`;
}

/** Back-compat names (older imports). */
export const compareHtml = (next: WeaponDef, cur: WeaponDef | null) => manifestHtml(next, cur);
export const weaponCardHtml = (w: WeaponDef) => manifestHtml(w, null);
