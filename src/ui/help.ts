/**
 * HELP screen (Screen 'help'): the field manual for the game's non-standard mechanics.
 * Content is data (./helpContent.ts); this file only renders it in the UI language of
 * docs/ART_DIRECTION.md §10: hazard-tab header, numbered mono topic rows on the left, one flat
 * panel with the topic on the right, keycaps inline.
 *
 * Keys (fed by src/ui/index.ts while the screen is open): ↑/↓ (W/S) topic, Home/End, number keys
 * (1–9, 0 = 10, two digits within 0.6 s for 11+), PgUp/PgDn scroll. H / Esc close (index.ts).
 * Mouse: click a topic row, wheel scrolls the page, BACK closes.
 */
import type { Input } from '@/core/input';
import { esc, h } from './dom';
import { HELP_TOPICS, KEYCAP_RE, type HelpBlock, type HelpTopic } from './helpContent';

/** localStorage flag: set the first time the help screen opens (hides the start-menu hint). */
export const HELP_SEEN_KEY = 'concourse.help.seen';

export function helpSeen(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked: don't nag
  }
}

export function markHelpSeen(): void {
  try {
    localStorage.setItem(HELP_SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

export interface HelpScreen {
  readonly el: HTMLElement;
  /** Index of the open topic. */
  readonly topic: number;
  readonly topics: readonly HelpTopic[];
  select(index: number): void;
  /** Keyboard navigation; call every frame while the screen is open. */
  handleInput(input: Input, dt: number): void;
}

export interface HelpOptions {
  onClose(): void;
  /** Topic changed by the player (click sound). */
  onSelect?(): void;
  topics?: readonly HelpTopic[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Escape, then **bold** and [KEY] keycaps. */
export function helpInline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(KEYCAP_RE, '<span class="sbh-k">$1</span>');
}

function renderBlock(b: HelpBlock): string {
  if ('h' in b) return `<h3 class="sbh-h">${esc(b.h)}</h3>`;
  if ('p' in b) return `<p class="sbh-p">${helpInline(b.p)}</p>`;
  if ('list' in b) return `<ul class="sbh-ul">${b.list.map((l) => `<li>${helpInline(l)}</li>`).join('')}</ul>`;
  if ('keys' in b) {
    return `<div class="sbh-keys">${b.keys
      .map(([k, a]) => `<div class="kr">${k.split(' ').map((x) => `<span class="sb-key">${esc(x)}</span>`).join('')}<span class="a">${helpInline(a)}</span></div>`)
      .join('')}</div>`;
  }
  if ('swatches' in b) {
    return `<div class="sbh-sw">${b.swatches
      .map((s) => `<div class="sr"><span class="sb-sq" style="background:${esc(s.color)}"></span><b>${esc(s.label)}</b><span class="t">${helpInline(s.text)}</span></div>`)
      .join('')}</div>`;
  }
  const head = b.table.head.map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${helpInline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="sbh-tw"><table class="sbh-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderTopicHtml(t: HelpTopic): string {
  return t.blocks.map(renderBlock).join('');
}

const DIGITS: Record<string, number> = {};
for (let d = 0; d <= 9; d++) {
  DIGITS[`Digit${d}`] = d;
  DIGITS[`Numpad${d}`] = d;
}
const DIGIT_WINDOW = 0.6;

export function createHelpScreen(parent: HTMLElement, opts: HelpOptions): HelpScreen {
  const topics = opts.topics ?? HELP_TOPICS;
  const el = h('div', 'sb-screen sb-help', parent);
  el.addEventListener('click', (e) => e.stopPropagation());

  const wrap = h('div', 'sbh-wrap', el);
  const head = h('div', 'sbh-head', wrap);
  h('div', 'sb-tab', head);
  const hrow = h('div', 'sbh-hrow sb-solid', head);
  const ht = h('div', 'sbh-ht', hrow);
  h('div', 'sbh-title', ht, 'Field Manual');
  h('div', 'sb-lbl', ht, `HELP · ${topics.length} TOPICS · HOW THE PIT REALLY WORKS`);
  const hk = h('div', 'sbh-hk sb-lbl', hrow);
  hk.innerHTML = '<span class="sb-key">↑</span><span class="sb-key">↓</span>TOPIC<span class="sb-key">1–9</span>JUMP<span class="sb-key">H</span>/<span class="sb-key">ESC</span>CLOSE';

  const body = h('div', 'sbh-body', wrap);
  const list = h('div', 'sbh-list sb-menu', body);
  const rows: HTMLButtonElement[] = topics.map((t, i) => {
    const b = h('button', '', list);
    b.type = 'button';
    b.dataset.topic = t.id;
    b.innerHTML = `<span class="n">${pad2(i + 1)}</span><span class="v">${esc(t.title)}</span><span class="r"></span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (i !== current) opts.onSelect?.();
      select(i);
    });
    return b;
  });

  const page = h('div', 'sbh-page sb-panel', body);
  const ph = h('div', 'sbh-ph', page);
  const phLbl = h('span', 'sb-lbl', ph);
  const phTitle = h('h2', 'sbh-pt', ph);
  const phSum = h('div', 'sbh-sum', ph);
  const content = h('div', 'sbh-content', page);

  const foot = h('div', 'sbh-foot', wrap);
  const back = h('button', 'sb-btn', foot);
  back.type = 'button';
  back.innerHTML = '<span class="sb-key">ESC</span>BACK';
  back.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onClose();
  });
  const prev = h('button', 'sb-btn', foot);
  prev.type = 'button';
  const next = h('button', 'sb-btn', foot);
  next.type = 'button';
  prev.addEventListener('click', (e) => {
    e.stopPropagation();
    step(-1);
  });
  next.addEventListener('click', (e) => {
    e.stopPropagation();
    step(1);
  });
  h('span', 'sb-lbl sbh-src', foot, 'FULL TEXT: DOCS/HELP.MD');

  let current = -1;
  let digit: number | null = null;
  let digitT = 0;

  function select(index: number): void {
    const n = topics.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor(index)));
    if (i === current) return;
    current = i;
    const t = topics[i];
    rows.forEach((r, k) => {
      r.classList.toggle('sel', k === i);
      r.setAttribute('aria-current', k === i ? 'true' : 'false');
      r.querySelector('.r')!.textContent = k === i ? '▸' : '';
    });
    phLbl.textContent = `TOPIC ${pad2(i + 1)}/${pad2(n)}`;
    phTitle.textContent = t.title;
    phSum.textContent = t.summary;
    content.innerHTML = renderTopicHtml(t);
    page.scrollTop = 0;
    const pt = topics[(i - 1 + n) % n];
    const nt = topics[(i + 1) % n];
    prev.innerHTML = `<span class="sb-key">↑</span>${esc(pt.title)}`;
    next.innerHTML = `<span class="sb-key">↓</span>${esc(nt.title)}`;
    // keep the selected row in view when the list scrolls (short screens)
    const r = rows[i];
    if (r.offsetTop < list.scrollTop) list.scrollTop = r.offsetTop;
    else if (r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = r.offsetTop + r.offsetHeight - list.clientHeight;
  }

  function step(d: number): void {
    const n = topics.length;
    opts.onSelect?.();
    select((current + d + n) % n);
  }

  function handleInput(input: Input, dt: number): void {
    digitT = Math.max(0, digitT - dt);
    if (digitT <= 0) digit = null;
    const n = topics.length;
    if (input.rawJustPressed('ArrowUp') || input.rawJustPressed('KeyW')) step(-1);
    else if (input.rawJustPressed('ArrowDown') || input.rawJustPressed('KeyS')) step(1);
    else if (input.rawJustPressed('Home')) select(0);
    else if (input.rawJustPressed('End')) select(n - 1);
    else if (input.rawJustPressed('PageDown')) page.scrollTop += Math.max(80, page.clientHeight * 0.8);
    else if (input.rawJustPressed('PageUp')) page.scrollTop -= Math.max(80, page.clientHeight * 0.8);
    else {
      for (const code in DIGITS) {
        if (!input.rawJustPressed(code)) continue;
        const d = DIGITS[code];
        if (digit !== null) {
          const two = digit * 10 + d;
          if (two >= 1 && two <= n) {
            digit = null;
            digitT = 0;
            opts.onSelect?.();
            select(two - 1);
            break;
          }
        }
        const idx = d === 0 ? 10 : d;
        if (idx <= n) {
          opts.onSelect?.();
          select(idx - 1);
        }
        digit = d;
        digitT = DIGIT_WINDOW;
        break;
      }
    }
  }

  select(0);
  return {
    el,
    get topic() { return current; },
    topics,
    select,
    handleInput,
  };
}
