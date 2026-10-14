/**
 * SHOP screen (Screen 'shop', PLAN §13): the vendor deck of the pit stop and the start menu.
 * Three columns in the inventory's `sbg-` language: STOCK (6–8 pieces at the player's tier,
 * league-gated rarity, price per piece, reroll for a fee) · the cargo-manifest card of the
 * selected piece against what you wear + BUY · YOUR GEAR (equipped rows) + the UPGRADE BAY.
 *
 * Mouse: hover = card, LMB = select, double-click a stock piece = buy. Buying equips into an
 * empty slot, else the backpack (refused when the backpack is full).
 */
import { RARITY_COLORS } from '@/core/types';
import { LEAGUES } from '@/standing/ranks';
import type { EconomySystem } from './economy';
import { fmtScrip } from './economyMath';
import type { Inventory } from './inventory';
import { gearManifestHtml, injectInventoryCss } from './inventoryScreen';
import { GEAR_SLOTS, GEAR_SLOT_LABEL, type GearDef } from './types';
import { createUpgradePanel, type UpgradePanel } from './upgradePanel';

export interface ShopScreenOptions {
  onClose?: () => void;
  /** After a purchase / reroll / upgrade (UI sound). */
  onAction?: (what: 'buy' | 'reroll' | 'upgrade' | 'fail') => void;
  /** Header line, e.g. "PIT STOP · ROUND 03 CLEARED" (default "QUARTERS · VENDOR DECK"). */
  context?: () => string;
}

export interface ShopScreen {
  readonly el: HTMLElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  update(dt: number): void;
  dispose(): void;
}

const CSS = `
.sbg-shop{grid-template-columns:minmax(340px,1.15fr) minmax(300px,1fr) minmax(300px,380px)}
.sbg-shop .sbg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.sbg-shop .sbg-cell{height:auto;min-height:104px;justify-content:flex-start;gap:4px}
.sbg-shop .sbg-cell .pr{margin-top:auto;display:flex;justify-content:space-between;align-items:baseline;font:700 13px var(--mono);color:var(--bone)}
.sbg-shop .sbg-cell .pr.poor{color:var(--dim)}
.sbg-shop .rr{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}
.sbg-shop .buy{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--panel-solid);border-top:2px solid var(--bone);padding:12px 16px;max-width:560px}
.sbg-shop .buy .msg{font:700 12px var(--mono);letter-spacing:.1em;text-transform:uppercase}
.sbg-shop .buy .msg.neg{color:var(--dim)}
.sbg-shop .sbg-btn.big{min-height:36px;padding:6px 16px;font-size:13px}
@media (max-width:1100px){.sbg-shop{grid-template-columns:minmax(300px,1fr) minmax(260px,1fr) minmax(280px,320px)}}
@media (max-height:800px){.sbg-shop .sbg-cell{min-height:96px}}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const s = document.createElement('style');
  s.dataset.gear = 'shop';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const hex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

export function createShopScreen(
  parent: HTMLElement, gear: { inventory: Inventory }, economy: EconomySystem, opts: ShopScreenOptions = {},
): ShopScreen {
  injectInventoryCss();
  injectCss();
  const inv = gear.inventory;
  const root = el('div', 'sbg-inv sbg-shop', parent);
  root.hidden = true;
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  const head = el('div', 'sbg-head', root);
  const headL = el('div', '', head);
  el('div', 'sb-tab', headL).style.cssText = 'width:240px;margin-bottom:8px';
  const ctxLine = el('div', 'sbg-label', headL);
  ctxLine.style.margin = '0';
  el('div', 'h', headL, 'SHOP');
  const chips = el('div', 'sbg-chips2', head);
  const tierChip = el('div', 'sbg-chip', chips);
  tierChip.style.background = 'var(--rule)';
  tierChip.style.color = 'var(--bone)';
  const scripChip = el('div', 'sbg-chip', chips);

  // column 1: stock
  const col1 = el('div', 'sbg-col', root);
  const stockPanel = el('div', 'sbg-panel grow', col1);
  const stockLabel = el('div', 'sbg-label', stockPanel);
  const gridEl = el('div', 'sbg-grid', stockPanel);
  const rr = el('div', 'rr', stockPanel);
  const rrHint = el('span', 'sbg-sub', rr, 'FREE RESTOCK EVERY ROUND CLEAR');
  const rerollBtn = el('button', 'sbg-btn', rr);
  rerollBtn.type = 'button';
  rerollBtn.addEventListener('click', () => {
    const ok = economy.reroll();
    selectedId = null;
    message = ok ? { text: 'STOCK REROLLED', neg: false } : { text: 'NOT ENOUGH SCRIP TO REROLL', neg: true };
    opts.onAction?.(ok ? 'reroll' : 'fail');
    render();
  });

  // column 2: manifest card + buy bar
  const col2 = el('div', 'sbg-col', root);
  const card = el('div', 'sbg-card', col2);
  const cardEmpty = el('div', 'sbg-empty', col2, 'SELECT A PIECE TO COMPARE IT WITH WHAT YOU WEAR');
  const buyBar = el('div', 'buy', col2);
  const buyMsg = el('span', 'msg', buyBar);
  const buyBtn = el('button', 'sbg-btn acc big', buyBar);
  buyBtn.type = 'button';
  buyBtn.addEventListener('click', () => { if (selectedId) buy(selectedId); });

  // column 3: your gear + upgrade bay
  const col3 = el('div', 'sbg-col', root);
  const wornPanel = el('div', 'sbg-panel', col3);
  el('div', 'sbg-label', wornPanel, '<span>02 · YOUR GEAR</span><span>LMB UPGRADE</span>');
  const slotsEl = el('div', '', wornPanel);
  const upgPanel = el('div', 'sbg-panel grow', col3);
  el('div', 'sbg-label', upgPanel, '<span>03 · UPGRADE BAY</span>');
  let upgradeTarget: string | null = null;
  const upgrade: UpgradePanel = createUpgradePanel(upgPanel, economy, inv, {
    onUpgrade: () => opts.onAction?.('upgrade'),
    onClear: () => { upgradeTarget = null; renderSlots(); },
  });

  const foot = el('div', 'sbg-foot', root,
    '<span><span class="sbg-key">B</span>CLOSE</span><span><span class="sbg-key">LMB</span>SELECT</span><span><span class="sbg-key">DBL</span>BUY</span><span><span class="sbg-key">I</span>LOADOUT</span>');
  const closeBtn = el('button', 'sbg-close', foot, 'CLOSE');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => opts.onClose?.());

  let visible = false;
  let selectedId: string | null = null;
  let hoverId: string | null = null;
  let message: { text: string; neg: boolean } | null = null;

  const stockItem = (id: string | null) => (id ? economy.stock.find((d) => d.id === id) ?? null : null);

  function buy(id: string): void {
    const item = stockItem(id);
    if (!item) return;
    const res = economy.buy(id);
    if (res === 'ok') {
      const where = inv.equipped(item.slot)?.id === item.id ? 'EQUIPPED' : 'IN BACKPACK';
      message = { text: `BOUGHT −${fmtScrip(economy.price(item))} · ${where}`, neg: false };
      selectedId = null;
      upgradeTarget = item.id;
      upgrade.setTarget(item.id);
      opts.onAction?.('buy');
    } else {
      message = { text: res === 'poor' ? 'NOT ENOUGH SCRIP' : res === 'full' ? 'BACKPACK FULL · MAKE ROOM [I]' : 'SOLD OUT', neg: true };
      opts.onAction?.('fail');
    }
    render();
  }

  function renderHead(): void {
    ctxLine.textContent = opts.context?.() ?? 'QUARTERS · VENDOR DECK';
    const league = LEAGUES[economy.leagueIndex()]?.name ?? 'Scrap League';
    tierChip.textContent = `TIER ${pad2(economy.stockTier)} · ${league.toUpperCase()} · UP TO ${economy.rarityCap().toUpperCase()}`;
    scripChip.textContent = `SCRIP ${fmtScrip(economy.scrip)}`;
  }

  function renderStock(): void {
    const stock = economy.stock;
    stockLabel.innerHTML = `<span>01 · STOCK</span><span><b>${pad2(stock.length)}</b> PIECES</span>`;
    gridEl.innerHTML = '';
    for (const d of stock) {
      const cell = el('div', 'sbg-cell', gridEl);
      cell.dataset.id = d.id;
      cell.style.setProperty('--rc', hex(RARITY_COLORS[d.rarity]));
      if (d.id === selectedId) cell.classList.add('sel');
      const cmp = inv.compareToEquipped(d);
      const worn = inv.equipped(d.slot);
      const arrow = !worn ? 'NEW' : cmp.delta > 0 ? '▲' : cmp.delta < 0 ? '▼' : '=';
      const price = economy.price(d);
      cell.innerHTML = `<div class="t"><span>${GEAR_SLOT_LABEL[d.slot]}</span><span class="${!worn || cmp.delta > 0 ? 'sbg-up' : 'sbg-down'}">${arrow}</span></div>`
        + `<div class="n">${esc(d.name)}</div><div class="r">${d.rarity} · ILV ${pad2(d.level)}</div>`
        + `<div class="pr${economy.wallet.canAfford(price) ? '' : ' poor'}"><span class="sbg-sub">PRICE</span><span>${fmtScrip(price)}</span></div>`;
      cell.title = `${d.name} (${d.rarity}, ILV ${d.level}) · ${fmtScrip(price)}`;
      cell.addEventListener('click', () => select(d.id));
      cell.addEventListener('dblclick', () => buy(d.id));
      cell.addEventListener('mouseenter', () => { hoverId = d.id; renderCard(); });
      cell.addEventListener('mouseleave', () => { hoverId = null; renderCard(); });
    }
    if (!stock.length) el('div', 'sbg-off', gridEl, 'SOLD OUT · REROLL OR CLEAR A ROUND');
    const fee = economy.rerollCost();
    rerollBtn.textContent = `REROLL · ${fmtScrip(fee)}`;
    rerollBtn.disabled = !economy.wallet.canAfford(fee);
    rrHint.textContent = 'FREE RESTOCK EVERY ROUND CLEAR';
  }

  function renderCard(): void {
    const d = stockItem(hoverId) ?? stockItem(selectedId);
    if (!d) {
      card.hidden = true;
      cardEmpty.hidden = false;
    } else {
      card.innerHTML = gearManifestHtml(d, inv);
      card.hidden = false;
      cardEmpty.hidden = true;
    }
    const sel = stockItem(selectedId);
    if (sel) {
      const price = economy.price(sel);
      buyBtn.textContent = `BUY · ${fmtScrip(price)}`;
      buyBtn.disabled = !economy.wallet.canAfford(price);
      buyBtn.hidden = false;
    } else {
      buyBtn.hidden = true;
    }
    buyMsg.className = `msg${message?.neg ? ' neg' : ''}`;
    buyMsg.textContent = message?.text ?? (sel ? (inv.equipped(sel.slot) ? 'GOES TO THE BACKPACK' : 'SLOT EMPTY · EQUIPS ON BUY') : 'SELECT A PIECE · DOUBLE-CLICK TO BUY');
  }

  function renderSlots(): void {
    slotsEl.innerHTML = '';
    const rows: GearDef[] = [];
    for (const slot of GEAR_SLOTS) {
      const d = inv.equipped(slot);
      const row = el('div', d ? 'sbg-row' : 'sbg-row no', slotsEl);
      row.innerHTML = d
        ? `<span class="k">${GEAR_SLOT_LABEL[slot]}</span><span class="n"><b>${esc(d.name)}</b><span class="sbg-rar"><span class="sbg-sq" style="background:${hex(RARITY_COLORS[d.rarity])}"></span>${d.rarity}</span></span><span class="il">ILV ${pad2(d.level)}</span>`
        : `<span class="k">${GEAR_SLOT_LABEL[slot]}</span><span class="n empty">— EMPTY —</span><span></span>`;
      if (!d) continue;
      rows.push(d);
      if (d.id === upgradeTarget) row.classList.add('sel');
      row.addEventListener('click', () => {
        upgradeTarget = d.id;
        upgrade.setTarget(d.id);
        renderSlots();
      });
    }
    // a backpack piece picked in the bay (e.g. just bought) shows as one extra row
    const t = upgradeTarget ? inv.find(upgradeTarget) : null;
    if (t && t.where === 'backpack') {
      const row = el('div', 'sbg-row sel', slotsEl);
      row.innerHTML = `<span class="k">BAG</span><span class="n"><b>${esc(t.item.name)}</b><span class="sbg-rar"><span class="sbg-sq" style="background:${hex(RARITY_COLORS[t.item.rarity])}"></span>${t.item.rarity}</span></span><span class="il">ILV ${pad2(t.item.level)}</span>`;
    }
    if (!rows.length && !t) el('div', 'sbg-off', slotsEl, 'NOTHING WORN YET · BUY A PIECE');
  }

  function select(id: string): void {
    selectedId = stockItem(id) ? id : null;
    message = null;
    for (const n of Array.from(gridEl.querySelectorAll<HTMLElement>('[data-id]'))) n.classList.toggle('sel', n.dataset.id === selectedId);
    renderCard();
  }

  function render(): void {
    if (selectedId && !stockItem(selectedId)) selectedId = null;
    if (upgradeTarget && !inv.has(upgradeTarget)) upgradeTarget = null;
    renderHead();
    renderStock();
    renderCard();
    renderSlots();
    if (upgrade.target !== upgradeTarget) upgrade.setTarget(upgradeTarget);
    else upgrade.render();
  }

  const offGear = inv.events.on('gear:changed', () => { if (visible) render(); });
  const offWallet = economy.wallet.onChange(() => { if (visible) { renderHead(); renderStock(); renderCard(); } });

  return {
    el: root,
    get visible() { return visible; },
    show() {
      if (visible) return;
      visible = true;
      root.hidden = false;
      message = null;
      render();
    },
    hide() {
      visible = false;
      root.hidden = true;
      hoverId = null;
    },
    update() {},
    dispose() {
      offGear();
      offWallet();
      upgrade.dispose();
      root.remove();
    },
  };
}
