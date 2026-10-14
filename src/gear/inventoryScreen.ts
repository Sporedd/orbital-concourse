/**
 * Inventory screen component (key I): paper doll + equipped slots + 12-slot backpack + a
 * cargo-manifest compare card, in the Brutalist Arena UI language (ART_DIRECTION §10): flat
 * opaque panels with a 2 px BONE top rule, hazard tab header, Martian Mono numbers/labels,
 * Archivo expanded names, no outlines/skew/rounded corners. Mounted inside the `.sb` UI root
 * (uses its tokens); own CSS with the `sbg-` prefix. src/ui mounts it as Screen 'inventory'.
 *
 * Mouse: hover = compare card, LMB = select (pins the card and, with an economy, opens the
 * UPGRADE BAY in place of the totals), double-click backpack = equip, double-click equipped
 * slot = unequip, RMB backpack = drop (only when opts.onDrop is given). The bay's header also
 * has EQUIP / UNEQUIP / DROP buttons. Rarity is always shown as a label too.
 */
import { RARITY_COLORS, type MaterialFactory } from '@/core/types';
import type { EconomySystem } from './economy';
import { fmtScrip } from './economyMath';
import { createUpgradePanel, type UpgradePanel } from './upgradePanel';
import { AFFIXES, GEAR_SETS, GEAR_STATS, formatAffixValue, gearScore } from './generator';
import type { Inventory } from './inventory';
import { createPaperDoll, type PaperDoll } from './paperDoll';
import { GEAR_SLOTS, GEAR_SLOT_LABEL, type GearDef, type GearSlot, type GearStat } from './types';

export interface InventoryScreenOptions {
  /** Drop a backpack piece back into the world (spawn it as loot). Without it there is no drop action. */
  onDrop?: (item: GearDef) => void;
  /** Close button clicked. */
  onClose?: () => void;
  /** Scrip economy: enables the UPGRADE BAY (src/gear/upgradePanel.ts) and the scrip chip. */
  economy?: EconomySystem | (() => EconomySystem | undefined);
  /** UI click sound etc. */
  onUpgrade?: () => void;
}

export interface InventoryScreen {
  readonly el: HTMLElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  /** Call every frame (drives the paper doll while visible). */
  update(dt: number): void;
  dispose(): void;
}

const CSS = `
.sbg-inv{position:absolute;inset:0;z-index:40;box-sizing:border-box;padding:32px;display:grid;gap:16px;pointer-events:auto;user-select:none;cursor:default;
  grid-template-columns:minmax(240px,320px) minmax(280px,360px) minmax(320px,1fr);grid-template-rows:auto minmax(0,1fr) auto;
  background:var(--floor,#1C1E21);color:var(--bone);font:400 12px/1.5 var(--mono)}
.sbg-inv[hidden]{display:none}
.sbg-inv *{box-sizing:border-box}
.sbg-head{grid-column:1/-1;display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.sbg-head .h{font-family:var(--display);font-stretch:125%;font-weight:900;font-size:32px;line-height:1;letter-spacing:-.01em;text-transform:uppercase;margin-top:4px}
.sbg-chip{background:var(--bone);color:var(--panel-solid);font:700 12px var(--mono);letter-spacing:.12em;padding:8px 12px}
.sbg-col{display:flex;flex-direction:column;gap:16px;min-height:0}
.sbg-panel{background:var(--panel-solid);border-top:2px solid var(--bone);padding:12px 16px;min-height:0;overflow:auto}
.sbg-panel.grow{flex:1}
.sbg-label{font:400 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--label);margin:0 0 8px;display:flex;justify-content:space-between;gap:12px}
.sbg-label b{color:var(--bone);font-weight:700}
.sbg-doll{display:flex;flex-direction:column}
.sbg-doll canvas{display:block;width:100%;flex:1;min-height:160px;height:0;background:#141516;cursor:grab}
.sbg-sets{margin-top:8px}
.sbg-row{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:center;min-height:40px;padding:4px 8px;border-bottom:1px solid var(--rule);cursor:pointer}
.sbg-row:hover,.sbg-cell:not(.free):hover{background:#2E3134}
.sbg-row .k{font-size:12px;letter-spacing:.12em;color:var(--label);text-transform:uppercase}
.sbg-row .n{min-width:0;display:flex;flex-direction:column}
.sbg-row .n b{font-family:var(--display);font-stretch:125%;font-weight:800;font-size:13px;letter-spacing:-.01em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbg-row .empty{color:var(--dim);letter-spacing:.08em}
.sbg-row .il{font-weight:700}
.sbg-row.no{cursor:default}
.sbg-row.sel,.sbg-cell.sel{box-shadow:inset 4px 0 0 var(--accent);background:#2E3134}
.sbg-chips2{display:flex;gap:8px}
.sbg-rar{display:inline-flex;align-items:center;gap:6px;font:400 12px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--label)}
.sbg-sq{width:10px;height:10px;display:inline-block;flex:none}
.sbg-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.sbg-cell{height:80px;background:#0f1011;padding:6px 8px;cursor:pointer;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;border-top:3px solid var(--rc,transparent)}
.sbg-cell.free{cursor:default;border-top:0;outline:1px dashed #4a4c50;outline-offset:-1px;background:transparent}
.sbg-cell.hov{background:#2E3134}
.sbg-cell .t{font-size:12px;letter-spacing:.1em;color:var(--label);display:flex;justify-content:space-between;text-transform:uppercase}
.sbg-cell .n{font-family:var(--display);font-stretch:105%;font-weight:800;font-size:12px;line-height:1.25;overflow:hidden;text-transform:uppercase;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;word-break:break-word}
.sbg-cell .r{font-size:12px;letter-spacing:.1em;color:var(--label);text-transform:uppercase}
.sbg-kv{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid rgba(58,60,64,.6);text-transform:uppercase;letter-spacing:.06em}
.sbg-kv .v{font-weight:700}
.sbg-set{margin:8px 0 2px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.sbg-set + div,.sbg-on,.sbg-off{line-height:1.5}
.sbg-on{color:var(--bone)} .sbg-off{color:var(--dim)}
.sbg-card{background:var(--panel-solid);min-height:0;overflow:auto;max-width:560px}
.sbg-card[hidden]{display:none}
.sbg-empty{max-width:560px;border-top:2px solid var(--rule);background:transparent;padding:12px 16px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase}
.sbg-band{display:flex;justify-content:space-between;padding:4px 12px;font:700 12px var(--mono);letter-spacing:.12em;color:var(--panel-solid)}
.sbg-card .body{padding:12px}
.sbg-title{font-family:var(--display);font-stretch:125%;font-weight:800;font-size:18px;line-height:1.1;letter-spacing:-.01em;text-transform:uppercase;margin:0 0 4px}
.sbg-card table{width:100%;border-collapse:collapse;margin:8px 0}
.sbg-card th{font-size:12px;letter-spacing:.12em;color:var(--label);text-align:right;font-weight:400;padding:0 0 4px;border-bottom:1px solid var(--rule)}
.sbg-card th:first-child,.sbg-card td:first-child{text-align:left}
.sbg-card td{text-align:right;padding:4px 0;border-bottom:1px solid rgba(58,60,64,.6);text-transform:uppercase}
.sbg-card td:first-child{color:var(--label);letter-spacing:.06em}
.sbg-card td.a{font-weight:700}
.sbg-card td.b{color:var(--dim)}
.sbg-up{color:var(--bone);font-weight:700} .sbg-down{color:var(--dim)}
.sbg-sub{font-size:12px;letter-spacing:.1em;color:var(--label);text-transform:uppercase;line-height:1.5}
.sbg-cfoot{display:flex;justify-content:space-between;gap:12px;margin-top:8px;padding-top:8px;border-top:1px solid var(--rule)}
.sbg-foot{grid-column:1/-1;display:flex;gap:24px;align-items:center;font:700 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--bone)}
.sbg-key{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;border:2px solid var(--bone);color:var(--bone);font-weight:700;margin-right:8px}
.sbg-close{all:unset;cursor:pointer;margin-left:auto;display:inline-flex;align-items:center;background:var(--panel);border-top:2px solid var(--bone);color:var(--bone);font:700 12px var(--mono);letter-spacing:.12em;padding:8px 16px}
.sbg-close:hover{background:var(--bone);color:var(--panel-solid)}
@media (max-width:1100px){.sbg-inv{grid-template-columns:minmax(200px,260px) minmax(240px,300px) minmax(300px,1fr)}}
@media (max-height:800px){.sbg-inv{gap:8px 16px;padding:24px 32px}.sbg-head .h{font-size:24px}.sbg-cell{height:76px}.sbg-row{min-height:36px}}
`;

let cssInjected = false;
/** The shared `sbg-` CSS (panels, rows, cells, cards); the shop screen reuses it. */
export function injectInventoryCss(): void {
  injectCss();
}
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const s = document.createElement('style');
  s.dataset.gear = 'inventory';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const hex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const rarityCss = (d: GearDef) => hex(RARITY_COLORS[d.rarity]);
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Cargo-manifest card body for a gear piece, compared against what is worn in its slot
 * (rarity band, name, slot · set · element, STAT / THIS / WORN / Δ table, set lines, score, serial).
 * Also used by the HUD pickup card.
 */
export function gearManifestHtml(d: GearDef, inv: Inventory, opts: { equipped?: boolean } = {}): string {
  const worn = opts.equipped ? null : inv.equipped(d.slot) ?? null;
  const cmp = inv.compareToEquipped(d);
  const lines: { label: string; a: number; b: number; delta: number; stat: GearStat }[] = opts.equipped
    ? [d.implicit, ...d.affixes].map((a) => ({ label: a.name, a: a.value, b: 0, delta: 0, stat: a.stat }))
    : cmp.lines;
  const fmt = (s: GearStat, v: number) => (v ? formatAffixValue(s, v) : '—');
  const rows = lines.map((l) => {
    const glyph = l.delta > 0 ? `<span class="sbg-up">▲ ${formatAffixValue(l.stat, Math.abs(l.delta))}</span>`
      : l.delta < 0 ? `<span class="sbg-down">▼ ${formatAffixValue(l.stat, Math.abs(l.delta))}</span>` : '<span class="sbg-down">=</span>';
    return `<tr><td>${esc(l.label)}</td><td class="a">${fmt(l.stat, l.a)}</td><td class="b">${worn ? fmt(l.stat, l.b) : '—'}</td><td>${opts.equipped ? '' : glyph}</td></tr>`;
  }).join('');
  const set = d.setId ? GEAR_SETS[d.setId] : null;
  const sub = [GEAR_SLOT_LABEL[d.slot], set ? `${set.name} set` : '', d.element ?? ''].filter(Boolean).join(' · ');
  const setLines = set
    ? set.bonuses.map((b) => `<div class="sbg-sub">(${b.pieces}) ${esc(b.description)}</div>`).join('') + (cmp.setNote && !opts.equipped ? `<div class="sbg-sub" style="color:var(--bone)">▲ ${esc(cmp.setNote)}</div>` : '')
    : '';
  const score = opts.equipped
    ? `SCORE ${gearScore(d)} · WORN`
    : `SCORE ${gearScore(d)}${worn ? ` · WORN ${gearScore(worn)} · ${cmp.delta > 0 ? '▲' : cmp.delta < 0 ? '▼' : '='} ${Math.abs(cmp.delta)}` : ' · SLOT EMPTY'}`;
  return `<div class="sbg-band" style="background:${rarityCss(d)}"><span>${d.rarity.toUpperCase()}</span><span>ILV ${pad2(d.level)}</span></div>`
    + `<div class="body"><div class="sbg-title">${esc(d.name)}</div><div class="sbg-sub">${esc(sub)}</div>`
    + `<table><tr><th>STAT</th><th>THIS</th><th>WORN</th><th>Δ</th></tr>${rows}</table>${setLines}`
    + `<div class="sbg-cfoot"><span class="sbg-sub">${score}</span><span class="sbg-sub">SB-${pad2(d.level)}-${esc(d.id.toUpperCase())}-${d.rarity[0].toUpperCase()}</span></div></div>`;
}

export function createInventoryScreen(
  parent: HTMLElement, gear: { inventory: Inventory }, materials: MaterialFactory, opts: InventoryScreenOptions = {},
): InventoryScreen {
  injectCss();
  const inv = gear.inventory;
  const root = el('div', 'sbg-inv', parent);
  root.hidden = true;
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  const head = el('div', 'sbg-head', root);
  const headL = el('div', '', head, '<div class="sb-tab" style="width:240px;margin-bottom:8px"></div><div class="sbg-label" style="margin:0">QUARTERS · GEAR RACK</div><div class="h">LOADOUT</div>');
  void headL;
  const chips = el('div', 'sbg-chips2', head);
  const scripChip = el('div', 'sbg-chip', chips);
  scripChip.hidden = true;
  const scoreChip = el('div', 'sbg-chip', chips);
  const economy = (): EconomySystem | undefined => (typeof opts.economy === 'function' ? opts.economy() : opts.economy);

  // column 1: paper doll + sets
  const col1 = el('div', 'sbg-col', root);
  const dollPanel = el('div', 'sbg-panel sbg-doll grow', col1);
  el('div', 'sbg-label', dollPanel, '<span>01 · MANNEQUIN</span><span>DRAG TO TURN</span>');
  const canvas = el('canvas', '', dollPanel);
  const setsEl = el('div', 'sbg-sets', dollPanel);

  // column 2: equipped + totals
  const col2 = el('div', 'sbg-col', root);
  const wornPanel = el('div', 'sbg-panel', col2);
  el('div', 'sbg-label', wornPanel, '<span>02 · EQUIPPED</span><span>DBL UNEQUIP</span>');
  const slotsEl = el('div', '', wornPanel);
  const totalsPanel = el('div', 'sbg-panel grow', col2);
  el('div', 'sbg-label', totalsPanel, '<span>03 · GEAR TOTALS</span>');
  const totalsEl = el('div', '', totalsPanel);
  const upgPanel = el('div', 'sbg-panel grow', col2);
  const upgLabel = el('div', 'sbg-label', upgPanel, '<span>03 · UPGRADE BAY</span>');
  upgPanel.hidden = true;
  let upgrade: UpgradePanel | null = null;
  let selectedId: string | null = null;

  // column 3: backpack + compare card
  const col3 = el('div', 'sbg-col', root);
  const bagPanel = el('div', 'sbg-panel', col3);
  const bagLabel = el('div', 'sbg-label', bagPanel);
  const gridEl = el('div', 'sbg-grid', bagPanel);
  const card = el('div', 'sbg-card', col3);
  const cardEmpty = el('div', 'sbg-empty', col3, 'HOVER A PIECE TO COMPARE IT WITH WHAT YOU WEAR');
  card.hidden = true;

  const foot = el('div', 'sbg-foot', root,
    `<span><span class="sbg-key">I</span>CLOSE</span><span><span class="sbg-key">LMB</span>SELECT / UPGRADE</span><span><span class="sbg-key">DBL</span>EQUIP / UNEQUIP</span>${opts.onDrop ? '<span><span class="sbg-key">RMB</span>DROP</span>' : ''}`);
  const closeBtn = el('button', 'sbg-close', foot, 'CLOSE');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => opts.onClose?.());

  let doll: PaperDoll | null = null;
  let visible = false;
  let hoverId: string | null = null;

  // ---- rendering ------------------------------------------------------------
  function renderSlots(): void {
    slotsEl.innerHTML = '';
    for (const slot of GEAR_SLOTS) {
      const d = inv.equipped(slot);
      const row = el('div', d ? 'sbg-row' : 'sbg-row no', slotsEl);
      if (d) row.title = `${d.name} (${d.rarity}, ILV ${d.level})`;
      row.innerHTML = d
        ? `<span class="k">${GEAR_SLOT_LABEL[slot]}</span><span class="n"><b>${esc(d.name)}</b><span class="sbg-rar"><span class="sbg-sq" style="background:${rarityCss(d)}"></span>${d.rarity}</span></span><span class="il">ILV ${pad2(d.level)}</span>`
        : `<span class="k">${GEAR_SLOT_LABEL[slot]}</span><span class="n empty">— EMPTY —</span><span></span>`;
      if (d) {
        row.dataset.id = d.id;
        if (d.id === selectedId) row.classList.add('sel');
        row.addEventListener('click', () => select(d.id));
        row.addEventListener('dblclick', () => {
          if (!inv.unequip(slot)) flash(row);
        });
        row.addEventListener('mouseenter', () => showCard(d.id));
        row.addEventListener('mouseleave', () => showCard(null));
      }
    }
  }

  function renderBag(): void {
    bagLabel.innerHTML = `<span>04 · BACKPACK</span><span><b>${pad2(inv.backpack.length)}</b> / ${inv.capacity}</span>`;
    gridEl.innerHTML = '';
    for (let i = 0; i < inv.capacity; i++) {
      const d = inv.backpack[i];
      const cell = el('div', d ? 'sbg-cell' : 'sbg-cell free', gridEl);
      if (!d) continue;
      cell.style.setProperty('--rc', rarityCss(d));
      const cmp = inv.compareToEquipped(d);
      const arrow = cmp.delta > 0 ? '▲' : cmp.delta < 0 ? '▼' : '=';
      cell.innerHTML = `<div class="t"><span>${GEAR_SLOT_LABEL[d.slot]}</span><span class="${cmp.delta > 0 ? 'sbg-up' : 'sbg-down'}">${arrow}</span></div>`
        + `<div class="n">${esc(d.name)}</div><div class="r">${d.rarity} · ${pad2(d.level)}</div>`;
      cell.title = `${d.name} (${d.rarity}, ILV ${d.level})`;
      cell.dataset.id = d.id;
      if (d.id === selectedId) cell.classList.add('sel');
      cell.addEventListener('click', () => select(d.id));
      cell.addEventListener('dblclick', () => inv.equip(d.id));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!opts.onDrop) return;
        const item = inv.remove(d.id);
        if (item) opts.onDrop(item);
      });
      cell.addEventListener('mouseenter', () => showCard(d.id));
      cell.addEventListener('mouseleave', () => showCard(null));
    }
  }

  function renderTotals(): void {
    const st = inv.stats;
    const rows: string[] = [];
    for (const s of GEAR_STATS) {
      const v = st.totals[s];
      if (!v) continue;
      const sign = s === 'reloadMult' || s === 'elementalResist' ? '−' : '+';
      rows.push(`<div class="sbg-kv"><span>${esc(AFFIXES[s].name)}</span><span class="v">${sign}${formatAffixValue(s, v)}</span></div>`);
    }
    totalsEl.innerHTML = rows.length ? rows.join('') : '<div class="sbg-off">NO GEAR BONUSES YET</div>';
    scoreChip.textContent = `GEAR SCORE ${st.score}`;
    const sets: string[] = [];
    for (const a of st.sets) {
      const def = GEAR_SETS[a.setId];
      sets.push(`<div class="sbg-set">${esc(def.name)} SET ${a.pieces}/${def.slots.length}</div>`);
      for (const b of def.bonuses) {
        const on = a.pieces >= b.pieces;
        sets.push(`<div class="${on ? 'sbg-on' : 'sbg-off'}">${on ? '■' : '□'} (${b.pieces}) ${esc(b.description)}</div>`);
      }
    }
    setsEl.innerHTML = sets.join('');
  }

  /** LMB: pin a piece (card + upgrade bay). No DOM rebuild, so a double-click still lands. */
  function select(id: string | null): void {
    selectedId = id && inv.has(id) ? id : null;
    for (const n of Array.from(root.querySelectorAll<HTMLElement>('[data-id]'))) n.classList.toggle('sel', n.dataset.id === selectedId);
    renderUpgrade();
    showCard(hoverId);
  }

  function renderUpgrade(): void {
    const eco = economy();
    scripChip.hidden = !eco;
    if (eco) scripChip.textContent = `SCRIP ${fmtScrip(eco.scrip)}`;
    const on = !!eco && !!selectedId;
    upgPanel.hidden = !on;
    totalsPanel.hidden = on;
    if (!eco) return;
    if (!upgrade) {
      upgrade = createUpgradePanel(upgPanel, eco, inv, {
        actions: (item, where) => {
          const out = [where === 'backpack'
            ? { label: 'EQUIP', run: () => { inv.equip(item.id); } }
            : { label: 'UNEQUIP', run: () => { inv.unequip(item.slot); } }];
          if (where === 'backpack' && opts.onDrop) {
            out.push({ label: 'DROP', run: () => { const it = inv.remove(item.id); if (it) opts.onDrop!(it); } });
          }
          return out;
        },
        onUpgrade: () => opts.onUpgrade?.(),
        onClear: () => select(null),
      });
      void upgLabel;
    }
    if (upgrade.target !== selectedId) upgrade.setTarget(selectedId);
    else upgrade.render();
  }

  function showCard(id: string | null): void {
    hoverId = id;
    for (const c of Array.from(gridEl.children)) c.classList.remove('hov');
    id = id ?? selectedId;
    const found = id ? inv.find(id) : null;
    if (!found) {
      card.hidden = true;
      cardEmpty.hidden = false;
      return;
    }
    card.innerHTML = gearManifestHtml(found.item, inv, { equipped: found.where === 'equipped' });
    card.hidden = false;
    cardEmpty.hidden = true;
  }

  function flash(row: HTMLElement): void {
    row.style.background = '#3A3C40';
    setTimeout(() => (row.style.background = ''), 160);
  }

  function render(): void {
    if (selectedId && !inv.has(selectedId)) selectedId = null;
    renderSlots();
    renderBag();
    renderTotals();
    renderUpgrade();
    if (hoverId && !inv.has(hoverId)) hoverId = null;
    showCard(hoverId);
    doll?.setLoadout(inv.loadout);
  }

  const off = inv.events.on('gear:changed', () => {
    if (visible) render();
  });

  return {
    el: root,
    get visible() {
      return visible;
    },
    show() {
      if (visible) return;
      visible = true;
      root.hidden = false;
      if (!doll) {
        try {
          doll = createPaperDoll(canvas, materials, { background: 0x141516 });
        } catch (err) {
          console.warn('[gear] paper doll unavailable', err);
        }
      }
      render();
    },
    hide() {
      visible = false;
      root.hidden = true;
      card.hidden = true;
    },
    update(dt: number) {
      if (visible && doll) doll.update(dt);
    },
    dispose() {
      off();
      doll?.dispose();
      doll = null;
      root.remove();
    },
  };
}

export type { GearSlot };
