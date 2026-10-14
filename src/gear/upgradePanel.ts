/**
 * UPGRADE BAY panel (inventory + shop screens): the four scrip upgrades for one owned piece,
 * in the Brutalist Arena language (flat panel rows, mono costs, keycap-style buttons, rarity
 * always carries a label). Reads/acts through ctx.economy; the inventory emits gear:changed.
 *
 *   REINFORCE  ILV 06 → 07 · GROWTH 41 → 47 %      ¤ 120  [BUY]
 *   RETUNE     pick a stat chip, reroll it in range  ¤ 80   [BUY]
 *   AUGMENT    AFFIXES 2/3 → 3/3                     ¤ 480  [BUY]
 *   ASCEND     EPIC → LEGENDARY                      ¤ 2000 [BUY]
 */
import { RARITY_COLORS, RARITY_ORDER } from '@/core/types';
import type { EconomySystem } from './economy';
import { fmtScrip, type UpgradeKind } from './economyMath';
import { AFFIX_COUNT, LEVEL_BONUS, formatAffixValue, growthForLevel } from './generator';
import type { Inventory } from './inventory';
import { GEAR_SLOT_LABEL, type GearDef } from './types';
import { affixRange, retuneTargets } from './upgrades';

export interface UpgradePanel {
  readonly el: HTMLElement;
  readonly target: string | null;
  setTarget(id: string | null): void;
  render(): void;
  dispose(): void;
}

export interface UpgradePanelOptions {
  /** Extra header actions for the target (EQUIP / UNEQUIP / DROP). */
  actions?: (item: GearDef, where: 'backpack' | 'equipped') => { label: string; run: () => void }[];
  /** Called after an upgrade went through (sound, etc.). */
  onUpgrade?: (kind: UpgradeKind, item: GearDef) => void;
  /** Clear button clicked. */
  onClear?: () => void;
}

const CSS = `
.sbg-upg .tgt{display:grid;grid-template-columns:1fr;gap:6px;align-items:start;padding-bottom:8px;border-bottom:1px solid var(--rule)}
.sbg-upg .tgt b{font-family:var(--display);font-stretch:125%;font-weight:800;font-size:14px;line-height:1.15;letter-spacing:-.01em;text-transform:uppercase;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.sbg-upg .acts{display:flex;gap:4px;flex-wrap:wrap}
.sbg-upg .acts .sbg-btn{min-width:0}
.sbg-upg .gro{display:flex;align-items:center;gap:8px}
.sbg-upg .gro .bar{flex:1;height:6px;background:#2E3134;position:relative}
.sbg-upg .gro .bar i{position:absolute;inset:0;background:var(--bone);transform-origin:left}
.sbg-up-row{display:grid;grid-template-columns:1fr auto auto;gap:4px 12px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(58,60,64,.6)}
.sbg-up-row .nm{font:700 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--bone)}
.sbg-up-row .ds{grid-column:1/2;font-size:12px;letter-spacing:.06em;color:var(--label);text-transform:uppercase;line-height:1.4}
.sbg-up-row .cost{font:700 13px var(--mono);white-space:nowrap;text-align:right}
.sbg-up-row .cost.poor{color:var(--dim)}
.sbg-up-row .why{grid-column:1/-1;font-size:12px;letter-spacing:.08em;color:var(--dim);text-transform:uppercase}
.sbg-chips{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px}
.sbg-chipbtn{all:unset;cursor:pointer;font:400 12px var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;background:#2E3134;color:var(--bone)}
.sbg-chipbtn.on{background:var(--bone);color:var(--panel-solid);font-weight:700}
.sbg-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:28px;min-width:56px;padding:4px 10px;font:700 12px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--bone);background:var(--panel);border-top:2px solid var(--bone);white-space:nowrap}
.sbg-btn:hover:not(:disabled),.sbg-btn:focus-visible{background:var(--bone);color:var(--panel-solid)}
.sbg-btn:disabled{opacity:.45;cursor:default}
.sbg-btn[hidden]{display:none}
.sbg-btn.acc{background:var(--accent);color:var(--panel-solid);border-top-color:var(--accent)}
.sbg-btn.acc:hover:not(:disabled){background:var(--bone)}
.sbg-upg .res{margin-top:8px;min-height:18px;font:700 12px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--bone)}
.sbg-upg .res.neg{color:var(--dim)}
.sbg-upg .hint{color:var(--dim);letter-spacing:.08em;text-transform:uppercase;padding:8px 0}
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const s = document.createElement('style');
  s.dataset.gear = 'upgrade';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const hex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
const pct = (g: number) => `${Math.round(g * 100)}%`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

const TITLE: Record<UpgradeKind, string> = { reinforce: 'Reinforce', retune: 'Retune', augment: 'Augment', ascend: 'Ascend' };

export function createUpgradePanel(
  parent: HTMLElement, economy: EconomySystem, inv: Inventory, opts: UpgradePanelOptions = {},
): UpgradePanel {
  injectCss();
  const root = el('div', 'sbg-upg', parent);
  let target: string | null = null;
  let retuneIdx = 0;
  let result: { text: string; neg: boolean } | null = null;

  function describe(kind: UpgradeKind, d: GearDef): string {
    switch (kind) {
      case 'reinforce':
        return `ILV ${pad2(d.level)} → ${pad2(d.level + 1)} · GROWTH ${pct(d.growth)} → ${pct(growthForLevel(d.level + 1))} · ALL STATS UP`;
      case 'retune': {
        const t = retuneTargets(d)[retuneIdx];
        if (!t) return 'PICK A STAT';
        const [lo, hi] = affixRange(t.stat, d.level, d.rarity, retuneIdx === 0);
        return `${t.name} ${formatAffixValue(t.stat, t.value)} · REROLL IN ${formatAffixValue(t.stat, lo)}–${formatAffixValue(t.stat, hi)}`;
      }
      case 'augment':
        return `AFFIXES ${d.affixes.length}/${AFFIX_COUNT[d.rarity]} → ${Math.min(AFFIX_COUNT[d.rarity], d.affixes.length + 1)}/${AFFIX_COUNT[d.rarity]} · NEW RANDOM AFFIX`;
      case 'ascend': {
        const next = RARITY_ORDER[RARITY_ORDER.indexOf(d.rarity) + 1];
        return next
          ? `${d.rarity} → ${next} · ILV +${LEVEL_BONUS[next] - LEVEL_BONUS[d.rarity]} · CAP ${AFFIX_COUNT[next]} AFFIXES`
          : `${d.rarity} · TOP RARITY`;
      }
    }
  }

  function render(): void {
    root.innerHTML = '';
    const found = target ? inv.find(target) : null;
    if (!found) {
      target = null;
      el('div', 'hint', root, 'SELECT A PIECE (LMB) TO OPEN THE UPGRADE BAY');
      if (result) el('div', `res${result.neg ? ' neg' : ''}`, root, esc(result.text));
      return;
    }
    const d = found.item;
    const tgt = el('div', 'tgt', root);
    el('div', '', tgt, `<b>${esc(d.name)}</b><div class="sbg-rar" style="margin-top:4px"><span class="sbg-sq" style="background:${hex(RARITY_COLORS[d.rarity])}"></span>${d.rarity} · ${GEAR_SLOT_LABEL[d.slot]} · ILV ${pad2(d.level)}${found.where === 'equipped' ? ' · WORN' : ''}</div>`);
    const acts = el('div', 'acts', tgt);
    for (const a of opts.actions?.(d, found.where) ?? []) {
      const b = el('button', 'sbg-btn', acts, esc(a.label));
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); a.run(); });
    }
    const x = el('button', 'sbg-btn', acts, '×');
    x.type = 'button';
    x.title = 'Clear selection';
    x.addEventListener('click', () => { setTarget(null); opts.onClear?.(); });
    const gro = el('div', 'gro', tgt);
    el('span', 'sbg-sub', gro, 'GROWTH');
    const bar = el('div', 'bar', gro);
    el('i', '', bar).style.transform = `scaleX(${d.growth})`;
    el('span', 'sbg-sub', gro, pct(d.growth));

    const targets = retuneTargets(d);
    if (retuneIdx >= targets.length) retuneIdx = 0;
    for (const kind of ['reinforce', 'retune', 'augment', 'ascend'] as UpgradeKind[]) {
      const row = el('div', 'sbg-up-row', root);
      const cost = economy.upgradeCost(kind, d);
      const why = economy.upgradeBlocker(kind, d);
      const capped = why && why !== 'NOT ENOUGH SCRIP';
      el('span', 'nm', row, TITLE[kind]);
      el('span', `cost${economy.wallet.canAfford(cost) ? '' : ' poor'}`, row, capped ? '—' : fmtScrip(cost));
      const btn = el('button', 'sbg-btn acc', row, 'BUY');
      btn.type = 'button';
      btn.disabled = !!why;
      btn.dataset.upgrade = kind;
      btn.addEventListener('click', () => {
        const res = economy.upgrade(kind, d.id, retuneIdx);
        if (res.ok) {
          result = { text: `${TITLE[kind]} −${fmtScrip(res.cost)} · ${summary(kind, d, res.item)}`, neg: false };
          opts.onUpgrade?.(kind, res.item);
        } else {
          result = { text: res.reason, neg: true };
        }
        render();
      });
      el('span', 'ds', row, esc(describe(kind, d)));
      if (kind === 'retune') {
        const chips = el('div', 'sbg-chips', row);
        targets.forEach((t, i) => {
          const c = el('button', `sbg-chipbtn${i === retuneIdx ? ' on' : ''}`, chips, `${i === 0 ? '◆ ' : ''}${esc(t.name)} ${formatAffixValue(t.stat, t.value)}`);
          c.type = 'button';
          c.title = i === 0 ? 'Implicit (base stat)' : 'Rolled affix';
          c.addEventListener('click', () => { retuneIdx = i; render(); });
        });
      }
      if (capped) el('span', 'why', row, esc(why!));
    }
    el('div', `res${result?.neg ? ' neg' : ''}`, root, result ? esc(result.text) : `WALLET ${fmtScrip(economy.scrip)}`);
  }

  function summary(kind: UpgradeKind, before: GearDef, after: GearDef): string {
    switch (kind) {
      case 'reinforce': return `ILV ${pad2(after.level)}`;
      case 'retune': {
        const a = retuneTargets(before)[retuneIdx];
        const b = retuneTargets(after)[retuneIdx];
        return a && b ? `${b.name} ${formatAffixValue(a.stat, a.value)} → ${formatAffixValue(b.stat, b.value)}` : 'DONE';
      }
      case 'augment': {
        const n = after.affixes[after.affixes.length - 1];
        return n ? `+ ${n.description}` : 'DONE';
      }
      case 'ascend': return `${after.rarity} · ILV ${pad2(after.level)}`;
    }
  }

  function setTarget(id: string | null): void {
    if (id !== target) {
      retuneIdx = 0;
      result = null;
    }
    target = id;
    render();
  }

  const off = economy.wallet.onChange(() => {
    if (root.isConnected) render();
  });

  render();
  return {
    el: root,
    get target() { return target; },
    setTarget,
    render,
    dispose() {
      off();
      root.remove();
    },
  };
}
