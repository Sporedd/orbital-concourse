/**
 * DOM widgets for system I in the Brutalist Arena UI language (docs/ART_DIRECTION.md §10):
 * flat opaque panels with a 2 px BONE top rule, hazard tabs, segmented gauges, Martian Mono
 * numbers/labels, Archivo expanded names. They are mounted inside the `.sb` UI root and use its
 * CSS tokens (--bone, --panel, --panel-solid, --label, --dim, --rule, --track, --accent).
 *
 *  - createStandingBadge(ctx, sys, parent)   league plaque: rank, standing gauge, next rank, run gain
 *  - createSponsorPicker(ctx, sys, parent)   sponsor contract list + detail (next run)
 *  - createStandingPanel(ctx, sys, parent)   badge (+ optional picker), back-compat wrapper
 *  - createHypeMeter(ctx, sys, parent)       stand-alone crowd meter (the HUD has its own hype panel)
 *
 * League accents come from the art direction (LEAGUE_STYLE), not from the rank data, so the UI
 * matches the arena dressing. Up/down lines use ▲/▼ glyphs and lightness, never red/green.
 */
import type { GameContext } from '@/core/types';
import { css, leagueStyle } from '@/rendering/style';
import type { StandingSystem } from './index';
import { LEAGUES, RANKS, leagueOf } from './ranks';
import { HYPE_TIER_LABEL, onStanding, type League, type SponsorContract } from './types';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

/** Art-direction accent for a league (CSS hex). */
export const leagueAccentCss = (l: Pick<League, 'id'>) => css(leagueStyle(l.id).accent);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const CSS = /* css */ `
/* standing badge (league plaque) */
.sbs-badge { width: 100%; pointer-events: auto; }
.sbs-badge .sb-panel { border-top: 0; padding: 12px 16px; }
.sbs-badge .lg { display: flex; justify-content: space-between; gap: 16px; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.sbs-badge .lg b { color: var(--sbs-accent, var(--accent)); font-weight: 700; }
.sbs-badge .lg span { color: var(--label); font-weight: 400; }
.sbs-badge .rk { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-top: 8px; }
.sbs-badge .rk .nm { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 24px; line-height: 1; letter-spacing: -0.01em; text-transform: uppercase; }
.sbs-badge .rk .ix { font-family: var(--mono); font-size: 13px; font-weight: 700; }
.sbs-badge .sb-gauge { height: 8px; margin: 8px 0; --seg: calc((100% - 18px) / 10); }
.sbs-badge .sb-gauge .fill { background: var(--sbs-accent, var(--accent)); }
.sbs-badge .meta { display: flex; justify-content: space-between; gap: 16px; font-family: var(--mono); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--label); }
.sbs-badge .meta b { color: var(--bone); font-weight: 700; }
.sbs-badge .gain { display: inline-block; background: var(--bone); color: var(--panel-solid); font-weight: 700; padding: 0 6px; letter-spacing: .08em; }

/* sponsor picker */
.sbs-sp { pointer-events: auto; cursor: default; }
.sbs-sp .hd { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.sbs-sp .list { display: flex; flex-direction: column; gap: 2px; }
.sbs-sp button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 12px 1fr auto; align-items: center; gap: 0 12px; padding: 6px 10px; min-height: 32px; background: var(--panel-solid); cursor: pointer; }
.sbs-sp button .sq { width: 12px; height: 12px; background: var(--sbs-c); }
.sbs-sp button .tt { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 13px; letter-spacing: -0.01em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sbs-sp button .tt small { font-family: var(--mono); font-stretch: 100%; font-weight: 400; font-size: 12px; letter-spacing: .08em; color: var(--label); margin-left: 8px; }
.sbs-sp button .r { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.sbs-sp button:hover:not(:disabled), .sbs-sp button.hov:not(:disabled) { background: #2E3134; }
.sbs-sp button.sel { background: var(--bone); color: var(--panel-solid); }
.sbs-sp button.sel .tt small { color: #3A3C40; }
.sbs-sp button:disabled { cursor: default; background: transparent; outline: 1px dashed #5A5C60; outline-offset: -1px; color: var(--dim); }
.sbs-sp button:disabled .sq { background: transparent; outline: 1px dashed var(--dim); }
.sbs-sp .det { margin-top: 8px; background: var(--panel-solid); padding: 8px 12px 10px; min-height: 92px; }
.sbs-sp .det .bl { font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--bone); margin-bottom: 4px; }
.sbs-sp .det .ln { font-family: var(--mono); font-size: 12px; line-height: 1.5; letter-spacing: .04em; text-transform: uppercase; }
.sbs-sp .det .ln.up { color: var(--bone); font-weight: 700; }
.sbs-sp .det .ln.dn { color: var(--dim); }
.sbs-sp .det .lock { font-family: var(--mono); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--label); margin-top: 4px; }

/* stand-alone hype meter (same language as the HUD hype panel) */
.sbs-hype { position: absolute; right: 32px; top: 32px; width: 240px; pointer-events: none; }
.sbs-hype .sb-gauge { height: 10px; margin: 8px 0; --seg: calc((100% - 18px) / 10); }
.sbs-hype .sb-gauge .fill { background: var(--sbs-accent, var(--accent)); }
.sbs-hype .chips { display: flex; gap: 8px; margin-bottom: 4px; }
.sbs-hype .chip { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; padding: 2px 6px; background: var(--bone); color: var(--panel-solid); }
.sbs-hype .chip.boo { background: var(--track); color: var(--bone); }
.sbs-hype .rx { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sbs-hype .rx.neg { color: var(--dim); }
`;

function injectCss(): void {
  if (typeof document === 'undefined' || document.getElementById('sbs-styles')) return;
  const style = document.createElement('style');
  style.id = 'sbs-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Standing badge (league plaque)
// ---------------------------------------------------------------------------
export interface StandingBadgeWidget {
  readonly el: HTMLElement;
  refresh(): void;
}

export interface StandingBadgeOptions {
  /** Show "+N THIS RUN" (game over). */
  showRunGain?: boolean;
  /** Override the run gain (e.g. summed from standing.history since the run start). */
  runGain?: () => number;
}

export function createStandingBadge(
  ctx: GameContext, sys: StandingSystem, parent: HTMLElement, opts: StandingBadgeOptions = {},
): StandingBadgeWidget {
  injectCss();
  const root = el('div', 'sbs-badge', parent);
  const tab = el('div', 'sb-tab', root);
  const body = el('div', 'sb-panel', root);
  let runGain = 0;
  ctx.events.on('game:started', () => { runGain = 0; });
  onStanding(ctx.events, 'standing:gained', (g) => { runGain += g.amount; });

  function refresh(): void {
    const st = sys.standing;
    const p = st.progress;
    const league = leagueOf(st.rank);
    const accent = leagueAccentCss(league);
    root.style.setProperty('--sbs-accent', accent);
    tab.style.setProperty('--tabc', accent);
    const gain = opts.showRunGain ? (opts.runGain ? opts.runGain() : runGain) : 0;
    const next = p.next ? `NEXT: <b>${esc(p.next.name.toUpperCase())}</b>` : '<b>MAX RANK</b>';
    const nums = p.next ? `<b>${fmtInt(st.standing)}</b> / ${fmtInt(p.next.threshold)} STANDING` : `<b>${fmtInt(st.standing)}</b> STANDING`;
    const f = Math.max(0, Math.min(1, p.fraction));
    body.innerHTML = `
      <div class="lg"><b>${esc(league.name.toUpperCase())}</b><span>TIER ${st.rank.tier}/5</span></div>
      <div class="rk"><span class="nm">${esc(st.rank.name)}</span><span class="ix">RANK ${pad2(st.rank.index + 1)}/${RANKS.length}</span></div>
      <div class="sb-gauge"><div class="fill" style="transform:scaleX(${(Math.ceil(f * 10 - 1e-6) / 10).toFixed(2)})"></div><div class="mask"></div></div>
      <div class="meta"><span>${nums}</span><span>${next}</span></div>
      ${gain > 0 ? `<div class="meta" style="margin-top:8px"><span>THIS RUN</span><span class="gain">+${fmtInt(gain)} STANDING</span></div>` : ''}`;
  }
  refresh();
  return { el: root, refresh };
}

// ---------------------------------------------------------------------------
// Sponsor picker
// ---------------------------------------------------------------------------
export interface SponsorPickerWidget {
  readonly el: HTMLElement;
  refresh(): void;
}

export interface SponsorPickerOptions {
  /** Called after a contract was chosen (e.g. play a click sound). */
  onChoose?: (c: SponsorContract) => void;
}

/** Most telling number of a contract for the row's right column. */
function headline(c: SponsorContract): string {
  if (c.rules.standingMult !== 1) return `×${c.rules.standingMult} STANDING`;
  return 'NEUTRAL';
}

export function createSponsorPicker(
  ctx: GameContext, sys: StandingSystem, parent: HTMLElement, opts: SponsorPickerOptions = {},
): SponsorPickerWidget {
  injectCss();
  void ctx;
  const root = el('div', 'sbs-sp', parent);
  root.addEventListener('click', (e) => e.stopPropagation());
  const hd = el('div', 'hd', root);
  el('span', 'sb-lbl', hd, 'SPONSOR · NEXT RUN');
  const signed = el('span', 'sb-lbl', hd);
  const list = el('div', 'list', root);
  const det = el('div', 'det', root);
  let hover: string | null = null;

  function renderDetail(): void {
    const sp = sys.sponsors;
    const entry = sp.list().find((e) => e.contract.id === (hover ?? sp.contract.id)) ?? sp.list()[0];
    if (!entry) return;
    const c = entry.contract;
    const lines = [
      ...c.perks.map((t) => `<div class="ln up">▲ ${esc(t)}</div>`),
      ...c.drawbacks.map((t) => `<div class="ln dn">▼ ${esc(t)}</div>`),
    ].join('') || '<div class="ln dn">= NO RULE CHANGES</div>';
    const lock = !entry.unlocked
      ? `<div class="lock">LOCKED · REACH THE ${esc((LEAGUES[c.unlockLeague]?.name ?? '').toUpperCase())}</div>`
      : sp.locked ? '<div class="lock">CONTRACT IS FIXED UNTIL THE RUN ENDS</div>' : '';
    det.innerHTML = `<div class="bl">${esc(c.blurb)}</div>${lines}${lock}`;
  }

  function refresh(): void {
    const sp = sys.sponsors;
    signed.textContent = `SIGNED: ${sp.contract.title.toUpperCase()}`;
    list.innerHTML = sp.list().map(({ contract: c, unlocked, selected }) => {
      const right = !unlocked ? `LOCKED · ${esc((LEAGUES[c.unlockLeague]?.name ?? '').split(' ')[0].toUpperCase())}` : selected ? 'SIGNED ■' : headline(c);
      const accent = leagueAccentCss(LEAGUES[c.unlockLeague] ?? LEAGUES[0]);
      return `<button type="button" class="${selected ? 'sel' : ''}${hover === c.id ? ' hov' : ''}" data-sponsor="${esc(c.id)}" style="--sbs-c:${accent}" ${unlocked && !sp.locked ? '' : 'disabled'}>
        <span class="sq"></span><span class="tt">${esc(c.title)}<small>${esc(c.name)}</small></span><span class="r">${right}</span></button>`;
    }).join('');
    renderDetail();
  }

  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-sponsor]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    if (sys.sponsors.choose(b.dataset.sponsor!)) opts.onChoose?.(sys.sponsors.contract);
    refresh();
  });
  list.addEventListener('mouseover', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-sponsor]') as HTMLButtonElement | null;
    const id = b?.dataset.sponsor ?? null;
    if (id === hover) return;
    hover = id;
    renderDetail();
  });
  list.addEventListener('mouseleave', () => {
    hover = null;
    renderDetail();
  });

  refresh();
  return { el: root, refresh };
}

// ---------------------------------------------------------------------------
// Back-compat: badge + optional picker in one column
// ---------------------------------------------------------------------------
export interface StandingPanelWidget {
  readonly el: HTMLElement;
  /** Re-render from current state (call when the screen is shown). */
  refresh(): void;
}

export interface StandingPanelOptions {
  /** Show the sponsor contract list. */
  picker?: boolean;
  /** Show "+N standing this run" (game over). */
  showRunGain?: boolean;
  /** Called after a contract was chosen (e.g. play a click sound). */
  onChoose?: (c: SponsorContract) => void;
}

export function createStandingPanel(
  ctx: GameContext, sys: StandingSystem, parent: HTMLElement, opts: StandingPanelOptions = {},
): StandingPanelWidget {
  injectCss();
  const root = el('div', '', parent);
  root.style.cssText = 'display:flex;flex-direction:column;gap:16px;pointer-events:auto;';
  root.addEventListener('click', (e) => e.stopPropagation());
  const badge = createStandingBadge(ctx, sys, root, { showRunGain: opts.showRunGain });
  const picker = opts.picker ? createSponsorPicker(ctx, sys, root, { onChoose: opts.onChoose }) : null;
  const refresh = () => {
    badge.refresh();
    picker?.refresh();
  };
  return { el: root, refresh };
}

// ---------------------------------------------------------------------------
// Stand-alone hype meter
// ---------------------------------------------------------------------------
export interface HypeMeterWidget {
  readonly el: HTMLElement;
  update(dt: number): void;
  setVisible(v: boolean): void;
}

export function createHypeMeter(ctx: GameContext, sys: StandingSystem, parent: HTMLElement): HypeMeterWidget {
  injectCss();
  const root = el('div', 'sbs-hype sb-panel', parent);
  const row = el('div', 'sb-row', root);
  el('span', 'sb-lbl', row, 'CROWD');
  const tierEl = el('span', 'sb-val', row);
  const gauge = el('div', 'sb-gauge', root);
  const fill = el('div', 'fill', gauge);
  el('div', 'mask', gauge);
  const chips = el('div', 'chips', root);
  const buffChip = el('span', 'chip', chips);
  const booChip = el('span', 'chip boo', chips, 'BOOING');
  const ticker = el('div', '', root);
  const lines: { e: HTMLElement; t: number }[] = [];

  const push = (text: string, neg: boolean, t: number) => {
    const line = el('div', `rx${neg ? ' neg' : ''}`, undefined, text);
    ticker.prepend(line);
    lines.unshift({ e: line, t });
    while (lines.length > 3) lines.pop()!.e.remove();
  };
  onStanding(ctx.events, 'hype:reaction', (r) => {
    if (!r.label) return;
    const amt = Math.round(r.amount);
    push(`${amt >= 0 ? '▲' : '▼'} ${r.label} · ${amt >= 0 ? '+' : '−'}${Math.abs(amt)}`, r.amount < 0, 1.8);
  });
  onStanding(ctx.events, 'hype:gift', (g) => {
    push(g.kind === 'crate' ? 'CROWD GIFT · CRATE' : g.kind === 'buff' ? 'CROWD GIFT · FRENZY' : 'CROWD GIFT · BONUS WAVE', false, 2.5);
  });
  ctx.events.on('game:started', () => {
    for (const l of lines) l.e.remove();
    lines.length = 0;
  });

  function update(dt: number): void {
    const m = sys.hype.modifiers;
    root.style.setProperty('--sbs-accent', leagueAccentCss(sys.standing.league));
    tierEl.textContent = HYPE_TIER_LABEL[m.tier];
    const f = Math.ceil(Math.max(0, Math.min(1, m.value / 100)) * 10 - 1e-6) / 10;
    fill.style.transform = `scaleX(${f.toFixed(2)})`;
    buffChip.style.display = m.buffRemaining > 0 ? '' : 'none';
    if (m.buffRemaining > 0) buffChip.textContent = `FRENZY ×1.3 · ${Math.ceil(m.buffRemaining)}S`;
    booChip.style.display = m.booing ? '' : 'none';
    for (let i = lines.length - 1; i >= 0; i--) {
      lines[i].t -= dt;
      if (lines[i].t <= 0) {
        lines[i].e.remove();
        lines.splice(i, 1);
      }
    }
  }

  return {
    el: root,
    update,
    setVisible(v: boolean) {
      root.style.display = v ? '' : 'none';
    },
  };
}
