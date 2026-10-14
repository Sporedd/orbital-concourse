/**
 * Co-op lobby overlay in the Brutalist Arena UI language (docs/ART_DIRECTION.md §10): one flat
 * opaque panel with a 2 px BONE top rule, hazard tab header, mono labels, keycap-style buttons,
 * the join code in Saira Stencil. Host (shows the join code) / Join (code + name) / player list /
 * Leave / Close. The overlay root carries the `.sb` class, so it uses the UI tokens and fonts.
 *
 *   const lobby = mountLobby(ctx, session, { hotkey: 'F2' });
 *   lobby.show();   // e.g. from the "Co-op" row on the start screen
 *
 * mountLobby is idempotent per session: a second call (e.g. from src/ui) returns the same lobby
 * (adding the hotkey if the first call had none). `getLobby(session)` returns it without mounting.
 */
import type { GameContext } from '@/core/types';
import { CODE_LENGTH, MAX_PEERS } from './relayProtocol';
import { NET_NAME_KEY, describeNetError, type NetSession } from './session';

export interface Lobby {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  destroy(): void;
}

export interface LobbyOptions {
  /** KeyboardEvent.code that toggles the lobby (e.g. 'F2'); omitted = no hotkey. */
  hotkey?: string;
  /** Parent element (default ctx.uiRoot). */
  parent?: HTMLElement;
}

const NAME_KEY = NET_NAME_KEY;

const CSS = `
.sb.sbn-lobby{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  background:rgba(12,13,14,.82);pointer-events:auto;cursor:default;overflow:auto}
.sb.sbn-lobby.sbn-hidden{display:none}
.sbn-card{width:min(480px,calc(100vw - 32px));background:var(--panel-solid);border-top:2px solid var(--bone)}
.sbn-card .sb-tab{height:8px}
.sbn-body{padding:16px}
.sbn-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:16px}
.sbn-title{font-family:var(--display);font-stretch:125%;font-weight:900;font-size:28px;line-height:1;letter-spacing:-.01em;text-transform:uppercase}
.sbn-field{display:flex;flex-direction:column;gap:8px;margin:0 0 16px}
.sb.sbn-lobby .sbn-field > input,.sb.sbn-lobby .sbn-field > .sbn-btn{flex:none}
.sbn-row{display:flex;gap:8px;align-items:stretch}
.sbn-lobby input{flex:1;min-width:0;box-sizing:border-box;height:40px;background:#0c0d0e;color:var(--bone);border:0;border-bottom:2px solid var(--rule);
  border-radius:0;padding:0 12px;font:700 14px var(--mono);letter-spacing:.08em;outline:none}
.sbn-lobby input:focus{border-bottom-color:var(--bone)}
.sbn-lobby input::placeholder{color:var(--dim);font-weight:400}
.sbn-lobby input:disabled{color:var(--label)}
.sbn-lobby input.sbn-code{flex:0 0 160px;text-transform:uppercase;letter-spacing:.32em;font-size:18px}
.sbn-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;cursor:pointer;
  background:var(--bone);color:var(--panel-solid);font:700 13px var(--mono);letter-spacing:.12em;text-transform:uppercase}
.sbn-btn:hover:not(:disabled){background:#FFFFFF}
.sbn-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sbn-btn.sec{background:var(--panel);color:var(--bone);border-top:2px solid var(--bone)}
.sbn-btn.sec:hover:not(:disabled){background:#2E3134}
.sbn-btn:disabled{opacity:.45;cursor:default}
.sbn-btn.wide{flex:1}
.sbn-or{display:flex;align-items:center;gap:12px;margin:0 0 16px}
.sbn-or::before,.sbn-or::after{content:'';flex:1;height:1px;background:var(--rule)}
.sbn-codebig{font-family:var(--stencil);font-size:56px;line-height:1;letter-spacing:.18em;text-align:center;margin:8px 0 16px;color:var(--accent);
  background:#0c0d0e;padding:12px 0 8px}
.sbn-list{list-style:none;margin:0 0 16px;padding:0;display:flex;flex-direction:column;gap:2px}
.sbn-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;background:var(--panel);font:700 13px var(--mono);letter-spacing:.06em}
.sbn-list li .n{display:flex;align-items:center;gap:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbn-list li .ix{color:var(--label);font-weight:400}
.sbn-list li .tag{font-size:12px;letter-spacing:.12em;padding:2px 6px;background:var(--bone);color:var(--panel-solid)}
.sbn-list li .tag.you{background:transparent;color:var(--label);outline:1px solid var(--rule)}
.sbn-status{min-height:18px;font:400 12px/1.5 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--label);margin:0 0 12px}
.sbn-status.err{color:var(--bone);font-weight:700}
.sbn-status.err::before{content:'▲ ';color:var(--threat)}
.sbn-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:12px;border-top:1px solid var(--rule)}
.sbn-hint{font:400 12px var(--mono);letter-spacing:.06em;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
`;

const lobbies = new WeakMap<NetSession, { lobby: Lobby; addHotkey(code: string): void }>();

/** The lobby already mounted for this session, if any. */
export function getLobby(session: NetSession): Lobby | null {
  return lobbies.get(session)?.lobby ?? null;
}

export function mountLobby(ctx: GameContext, session: NetSession, opts: LobbyOptions = {}): Lobby {
  const existing = lobbies.get(session);
  if (existing) {
    if (opts.hotkey) existing.addHotkey(opts.hotkey);
    return existing.lobby;
  }
  const parent = opts.parent ?? ctx.uiRoot;
  if (!document.getElementById('sbn-styles')) {
    const st = document.createElement('style');
    st.id = 'sbn-styles';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string, into?: HTMLElement): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    (into ?? body).appendChild(e);
    return e;
  };

  const root = document.createElement('div');
  root.className = 'sb sbn-lobby sbn-hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Co-op lobby');
  const card = document.createElement('div');
  card.className = 'sbn-card';
  const tab = document.createElement('div');
  tab.className = 'sb-tab';
  card.appendChild(tab);
  const body = document.createElement('div');
  body.className = 'sbn-body';
  card.appendChild(body);
  root.appendChild(card);
  parent.appendChild(root);

  const head = el('div', 'sbn-head');
  el('div', 'sbn-title', 'Co-op', head);
  el('span', 'sb-lbl', `UP TO ${MAX_PEERS} PLAYERS`, head);

  const nameField = el('label', 'sbn-field');
  el('span', 'sb-lbl', '01 · CALL SIGN', nameField);
  const nameIn = el('input', '', undefined, nameField);
  nameIn.placeholder = 'YOUR NAME';
  nameIn.maxLength = 20;
  try { nameIn.value = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* ignore */ }

  const offline = el('div');
  const hostField = el('div', 'sbn-field', undefined, offline);
  el('span', 'sb-lbl', '02 · HOST A ROOM', hostField);
  const hostBtn = el('button', 'sbn-btn wide', 'Host game', hostField);
  hostBtn.type = 'button';
  el('div', 'sbn-or sb-lbl', 'OR', offline);
  const joinField = el('label', 'sbn-field', undefined, offline);
  el('span', 'sb-lbl', `03 · JOIN WITH A ${CODE_LENGTH}-LETTER CODE`, joinField);
  const joinRow = el('div', 'sbn-row', undefined, joinField);
  const codeIn = el('input', 'sbn-code', undefined, joinRow);
  codeIn.placeholder = 'CODE';
  codeIn.maxLength = CODE_LENGTH;
  codeIn.autocomplete = 'off';
  codeIn.spellcheck = false;
  const joinBtn = el('button', 'sbn-btn wide', 'Join', joinRow);
  joinBtn.type = 'button';

  const online = el('div');
  const roleEl = el('div', 'sb-lbl', '', online);
  const codeBig = el('div', 'sbn-codebig', '', online);
  el('div', 'sb-lbl', 'IN THE PIT', online).style.marginBottom = '8px';
  const list = el('ul', 'sbn-list', undefined, online);
  const leaveRow = el('div', 'sbn-row', undefined, online);
  leaveRow.style.marginBottom = '16px';
  const leaveBtn = el('button', 'sbn-btn sec wide', 'Leave room', leaveRow);
  leaveBtn.type = 'button';

  const status = el('div', 'sbn-status');
  status.setAttribute('aria-live', 'polite');
  const foot = el('div', 'sbn-foot');
  const urlHint = el('div', 'sbn-hint', '', foot);
  const closeBtn = el('button', 'sbn-btn sec', 'Close', foot);
  closeBtn.type = 'button';

  const name = () => {
    const n = nameIn.value.trim();
    try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
    return n || undefined;
  };

  // Keep game hotkeys (WASD, M, Tab…) and the start-screen click from firing while typing.
  for (const inp of [nameIn, codeIn]) {
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && inp === codeIn) joinBtn.click();
      if (e.key === 'Escape') lobby.hide();
    });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
  }
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === root) lobby.hide();
  });

  hostBtn.addEventListener('click', () => {
    session.host(name()).catch(() => render());
  });
  joinBtn.addEventListener('click', () => {
    session.join(codeIn.value, name()).catch(() => render());
  });
  leaveBtn.addEventListener('click', () => session.leave());
  closeBtn.addEventListener('click', () => lobby.hide());

  function render(): void {
    const on = session.status === 'connected';
    offline.style.display = on ? 'none' : '';
    online.style.display = on ? '' : 'none';
    nameIn.disabled = on;
    const busy = session.status === 'connecting';
    hostBtn.disabled = busy;
    joinBtn.disabled = busy;
    urlHint.textContent = `RELAY ${session.url}`;
    urlHint.title = session.url;
    if (on) {
      roleEl.textContent = session.role === 'host' ? 'HOSTING · SHARE THIS CODE' : 'JOINED ROOM';
      codeBig.textContent = session.code ?? '';
      list.innerHTML = '';
      session.peers.forEach((p, i) => {
        const li = el('li', '', undefined, list);
        const n = el('span', 'n', undefined, li);
        el('span', 'ix', String(i + 1).padStart(2, '0'), n);
        el('span', '', p.name.toUpperCase(), n);
        if (p.host) el('span', 'tag', 'HOST', li);
        else if (p.peer === session.peerId) el('span', 'tag you', 'YOU', li);
        if (p.host && p.peer === session.peerId) el('span', 'tag you', 'YOU', li);
      });
      status.className = 'sbn-status';
      status.textContent = `${session.peers.length}/${MAX_PEERS} PLAYERS${session.rtt ? ` · ${Math.round(session.rtt)} MS` : ''}`;
    } else {
      status.className = session.error ? 'sbn-status err' : 'sbn-status';
      status.textContent = busy ? 'CONNECTING…' : describeNetError(session.error);
    }
  }

  const off = session.onChange(render);
  const hotkeys = new Set<string>();
  if (opts.hotkey) hotkeys.add(opts.hotkey);
  const onKey = (e: KeyboardEvent) => {
    if (hotkeys.has(e.code)) {
      e.preventDefault();
      lobby.toggle();
    } else if (e.code === 'Escape' && lobby.visible) {
      lobby.hide();
    }
  };
  window.addEventListener('keydown', onKey);
  render();

  const lobby: Lobby = {
    get visible() { return !root.classList.contains('sbn-hidden'); },
    show() {
      root.classList.remove('sbn-hidden');
      ctx.input?.unlock();
      render();
      (session.status === 'connected' ? closeBtn : nameIn.value ? hostBtn : nameIn).focus?.();
    },
    hide() {
      root.classList.add('sbn-hidden');
    },
    toggle() {
      if (lobby.visible) lobby.hide();
      else lobby.show();
    },
    destroy() {
      off();
      window.removeEventListener('keydown', onKey);
      root.remove();
      lobbies.delete(session);
    },
  };
  lobbies.set(session, { lobby, addHotkey: (c) => hotkeys.add(c) });
  return lobby;
}
