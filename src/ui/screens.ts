/**
 * Full-screen menus (docs/ART_DIRECTION.md §10.3):
 *  - start: floodlight shaft, closed gate with an accent lintel, title, numbered menu rows,
 *    a right column that switches between CONTROLS / SPONSOR / SETTINGS, league plaque (the
 *    standing badge when ctx.standing exists), CLICK TO ENTER
 *  - pause: hazard-tab band + menu + settings (mouse sensitivity, sound)
 *  - skill tree: floor plan of plinths + class picker (./skillTree.ts, docs/SKILL_TREE.md)
 *  - game over: THREAT ribbon + manifest recap (round, kills, damage, time, best weapon,
 *    standing earned, rank) + standing badge
 * Optional systems (ctx.standing, ctx.gear, ctx.net) are looked up when a screen is shown, so
 * their rows/panels appear as soon as main.ts wires them and stay hidden otherwise.
 */
import type { GameContext, Screen, WeaponDef } from '@/core/types';
import { asClassProgression, readBestRound } from '@/progression';
import { weaponDps } from '@/loot/weapons';
import { mountLobby } from '@/net/ui';
import { RANKS } from '@/standing/ranks';
import { createSponsorPicker, createStandingBadge, type SponsorPickerWidget, type StandingBadgeWidget } from '@/standing/hud';
import { esc, h, rarityCss } from './dom';
import { currentLeague } from './hud';
import { fmtInt, fmtTime, type RunStats } from './runStats';
import { createSkillTree } from './skillTree';
import { SENSITIVITY_RANGE, getSettings, onSettingsChange, setSetting } from './settings';

export interface ScreenCallbacks {
  onStart(): void;
  onResume(): void;
  onRetry(): void;
  onCloseSkills(): void;
  onOpenSkills?(): void;
  /** Key-I loadout screen (only offered when ctx.gear exists). */
  onOpenInventory?(): void;
  /** Game over → start screen (sponsor, co-op, settings). */
  onMainMenu?(): void;
  /** Shop screen (only offered when ctx.economy exists). */
  onOpenShop?(): void;
  /** Pit stop → next round (pause menu row while the round sits cleared). */
  onContinue?(): void;
}

export interface Screens {
  show(screen: Screen): void;
  renderSkills(): void;
  refreshBest(): void;
  setGameOver(round: number, kills: number): void;
  /** Refresh the SOUND ON/OFF rows from ctx.audio.muted (cheap; call every frame). */
  syncSound(): void;
}

export const GAME_TITLE = 'Orbital Concourse';

const CONTROLS: [string, string][] = [
  ['WASD', 'Move'], ['SHIFT', 'Sprint'], ['SPACE', 'Jump'], ['LMB', 'Fire'],
  ['R', 'Reload'], ['1 2', 'Swap weapon'], ['E', 'Take / swap'], ['V', 'Melee'],
  ['G', 'Grenade'], ['Q', 'Active'], ['TAB', 'Skill tree'], ['ESC', 'Pause'], ['M', 'Mute'],
];

const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

type SidePanel = 'controls' | 'sponsor' | 'settings';

interface MenuRow {
  el: HTMLButtonElement;
  when?: () => boolean;
  panel?: SidePanel;
}

export function createScreens(ctx: GameContext, root: HTMLElement, cb: ScreenCallbacks, run?: RunStats): Screens {
  // ---- sound rows / toggles (start + pause) ----------------------------------------------
  const soundRows: HTMLButtonElement[] = [];
  const soundToggles: HTMLButtonElement[] = [];
  let soundShown: boolean | null = null;
  function syncSound(): void {
    const m = ctx.audio.muted;
    if (m === soundShown) return;
    soundShown = m;
    for (const b of soundRows) {
      const v = b.querySelector('.v');
      if (v) v.textContent = m ? 'SOUND: OFF' : 'SOUND: ON';
    }
    for (const t of soundToggles) {
      t.setAttribute('aria-checked', String(!m));
      t.children[0]?.classList.toggle('on', m);
      t.children[1]?.classList.toggle('on', !m);
    }
  }
  const toggleSound = () => {
    ctx.audio.resume(); // user gesture: unlock the context so unmuting is audible
    ctx.audio.setMuted(!ctx.audio.muted);
    ctx.audio.play('ui_click');
    soundShown = null;
    syncSound();
  };

  /** Numbered menu row; clicks on rows don't fall through to the screen's click-to-play. */
  const row = (menu: HTMLElement, label: string, right: string, onClick: () => void, sel = false) => {
    const b = h('button', sel ? 'sel' : '', menu);
    b.type = 'button';
    b.innerHTML = `<span class="n">00</span><span class="v">${esc(label)}</span><span class="r">${esc(right)}</span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  const soundRow = (menu: HTMLElement) => {
    const b = row(menu, 'SOUND: OFF', '[M]', toggleSound);
    soundRows.push(b);
    return b;
  };
  /** Number the visible rows 01, 02, … and hide rows whose system is missing. */
  const renumber = (rows: MenuRow[]) => {
    let n = 0;
    for (const r of rows) {
      const on = r.when ? r.when() : true;
      r.el.classList.toggle('sb-hidden', !on);
      if (on) r.el.querySelector('.n')!.textContent = pad2(++n);
    }
  };
  const backdrop = (parent: HTMLElement) => {
    h('div', 'sb-shaftbg', parent);
    const gate = h('div', 'sb-gateart', parent);
    gate.innerHTML = '<div class="floor"></div><div class="jamb l"></div><div class="jamb r"></div><div class="lintel"><i></i></div>' +
      '<div class="door l"><b style="left:30%"></b><b style="left:65%"></b></div><div class="door r"><b style="left:35%"></b><b style="left:70%"></b></div>';
  };
  const stop = (el: HTMLElement) => el.addEventListener('click', (e) => e.stopPropagation());

  const openCoop = () => {
    if (!ctx.net) return;
    ctx.audio.play('ui_open');
    (ctx.net.lobby ?? mountLobby(ctx, ctx.net)).show();
  };

  // ---- settings panel (shared builder) ----------------------------------------------------
  const settingsSyncs: (() => void)[] = [];
  function buildSettings(parent: HTMLElement): HTMLElement {
    const panel = h('div', 'sb-settings sb-panel sb-side-panel', parent);
    stop(panel);
    const hd = h('div', 'hd', panel);
    h('span', 'sb-lbl', hd, 'SETTINGS');
    h('span', 'sb-lbl', hd, 'SAVED ON THIS DEVICE');

    const sens = h('div', 'sb-set-row', panel);
    const sensId = `sb-sens-${settingsSyncs.length}`;
    const lbl = h('label', 'sb-lbl', sens, 'MOUSE SENSITIVITY');
    lbl.htmlFor = sensId;
    const val = h('span', 'sb-val', sens);
    const ctl = h('div', 'ctl', sens);
    const minus = h('button', 'sb-step', ctl, '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Lower sensitivity');
    const range = h('input', 'sb-range', ctl);
    range.type = 'range';
    range.id = sensId;
    range.min = String(SENSITIVITY_RANGE.min);
    range.max = String(SENSITIVITY_RANGE.max);
    range.step = String(SENSITIVITY_RANGE.step);
    const plus = h('button', 'sb-step', ctl, '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Raise sensitivity');
    const sync = () => {
      const v = getSettings().mouseSensitivity;
      if (document.activeElement !== range) range.value = String(v);
      val.textContent = `${v.toFixed(2)}×`;
      const p = ((v - SENSITIVITY_RANGE.min) / (SENSITIVITY_RANGE.max - SENSITIVITY_RANGE.min)) * 100;
      range.style.setProperty('--p', `${p.toFixed(1)}%`);
      range.setAttribute('aria-valuetext', `${v.toFixed(2)} times`);
    };
    range.addEventListener('input', () => setSetting('mouseSensitivity', Number(range.value)));
    // keep arrow keys / WASD from reaching the game while the slider has focus
    range.addEventListener('keydown', (e) => e.stopPropagation());
    const nudge = (d: number) => setSetting('mouseSensitivity', Math.round((getSettings().mouseSensitivity + d) * 20) / 20);
    minus.addEventListener('click', () => nudge(-0.1));
    plus.addEventListener('click', () => nudge(0.1));
    settingsSyncs.push(sync);
    sync();

    const snd = h('div', 'sb-set-row', panel);
    h('span', 'sb-lbl', snd, 'SOUND');
    const tog = h('button', 'sb-toggle', snd);
    tog.type = 'button';
    tog.setAttribute('role', 'switch');
    tog.setAttribute('aria-label', 'Sound');
    tog.innerHTML = '<span>OFF</span><span>ON</span>';
    tog.addEventListener('click', toggleSound);
    soundToggles.push(tog);

    h('div', 'note sb-lbl', panel, '1.00× = DEFAULT AIM SPEED');
    const acts = h('div', 'acts', panel);
    const reset = h('button', 'sb-btn', acts, 'RESET DEFAULTS');
    reset.type = 'button';
    reset.addEventListener('click', () => setSetting('mouseSensitivity', 1));
    soundShown = null;
    return panel;
  }
  onSettingsChange(() => settingsSyncs.forEach((s) => s()));

  // ---- start ---------------------------------------------------------------------------------
  const start = h('div', 'sb-screen', root);
  backdrop(start);
  const st = h('div', 'sb-start', start);
  const topBlock = h('div', 'tb', st);
  h('div', 'sb-title', topBlock, GAME_TITLE);
  h('div', 'sb-tagline', topBlock, 'ORBITAL COLOSSEUM · SEASON 01');
  const menu = h('div', 'sb-menu', st);
  let side: SidePanel = 'controls';
  const startRows: MenuRow[] = [];
  const panelRow = (label: string, panel: SidePanel, when?: () => boolean): MenuRow => {
    const r: MenuRow = { el: row(menu, label, '▸', () => setSide(side === panel ? 'controls' : panel)), panel, when };
    return r;
  };
  const enterRow = row(menu, 'ENTER THE PIT', '[LMB]', () => cb.onStart(), true);
  startRows.push({ el: enterRow });
  startRows.push({ el: row(menu, 'SKILL TREE', '[TAB]', () => cb.onOpenSkills?.()) });
  const classRow = row(menu, 'CLASS', '▸', () => tree.openPicker());
  startRows.push({ el: classRow, when: () => !!asClassProgression(ctx.progression) });
  startRows.push({ el: row(menu, 'LOADOUT', '[I]', () => cb.onOpenInventory?.()), when: () => !!ctx.gear });
  startRows.push({ el: row(menu, 'SHOP', '[B]', () => cb.onOpenShop?.()), when: () => !!ctx.economy && !!cb.onOpenShop });
  const sponsorRow = panelRow('SPONSOR', 'sponsor', () => !!ctx.standing);
  startRows.push(sponsorRow);
  startRows.push({ el: row(menu, 'CO-OP', '[F2]', openCoop), when: () => !!ctx.net });
  startRows.push(panelRow('SETTINGS', 'settings'));
  startRows.push({ el: soundRow(menu) });

  const sideWrap = h('div', 'side', st);
  stop(sideWrap);
  const ctrl = h('div', 'sb-controls sb-panel sb-side-panel', sideWrap);
  const chd = h('div', 'hd', ctrl);
  h('span', 'sb-lbl', chd, 'CONTROLS');
  h('span', 'sb-lbl', chd, 'KEYBOARD + MOUSE');
  const grid = h('div', 'grid', ctrl);
  const controlKeys: HTMLElement[] = [];
  for (const [k, d] of CONTROLS) {
    h('span', 'sb-key', grid, k);
    h('span', 'd', grid, d);
  }
  // optional-system keys (shown when the system exists)
  for (const [k, d, sys] of [['I', 'Loadout', 'gear'], ['F', 'Salvage gun', 'economy'], ['B', 'Shop (pit stop)', 'economy'], ['F2', 'Co-op', 'net']] as const) {
    const a = h('span', 'sb-key', grid, k);
    const b = h('span', 'd', grid, d);
    a.dataset.sys = sys;
    b.dataset.sys = sys;
    controlKeys.push(a, b);
  }
  const sponsorWrap = h('div', 'sb-panel sb-side-panel', sideWrap);
  let picker: SponsorPickerWidget | null = null;
  const startSettings = buildSettings(sideWrap);

  function setSide(p: SidePanel): void {
    if (p === 'sponsor' && !ctx.standing) p = 'controls';
    side = p;
    ctrl.classList.toggle('sb-hidden', p !== 'controls');
    sponsorWrap.classList.toggle('sb-hidden', p !== 'sponsor');
    startSettings.classList.toggle('sb-hidden', p !== 'settings');
    for (const r of startRows) {
      if (!r.panel) continue;
      r.el.classList.toggle('open', r.panel === p);
      r.el.querySelector('.r')!.textContent = r.panel === p ? '◂' : '▸';
    }
    if (p === 'sponsor' && ctx.standing) {
      if (!picker) picker = createSponsorPicker(ctx, ctx.standing, sponsorWrap, { onChoose: () => { ctx.audio.play('ui_click'); refreshMenuLabels(); } });
      picker.refresh();
    }
    if (p !== 'controls') ctx.audio.play('ui_click');
  }

  const plaque = h('div', 'sb-plaque', st);
  stop(plaque);
  const plaqueTab = h('div', 'sb-tab', plaque);
  const plaqueBody = h('div', 'sb-panel', plaque);
  const plaqueLine = h('div', 'pl', plaqueBody);
  const startBest = h('div', 'best sb-lbl', plaque);
  let startBadge: StandingBadgeWidget | null = null;
  const startCta = h('div', 'sb-cta', st, 'CLICK TO ENTER');
  start.addEventListener('click', () => cb.onStart());

  function refreshMenuLabels(): void {
    const sp = ctx.standing?.sponsors;
    const v = sponsorRow.el.querySelector('.v')!;
    v.textContent = sp ? `SPONSOR: ${sp.contract.title.toUpperCase()}` : 'SPONSOR';
    const cls = asClassProgression(ctx.progression)?.classDef;
    classRow.querySelector('.v')!.textContent = cls ? `CLASS: ${cls.name.toUpperCase()}` : 'CLASS';
  }

  // ---- pause ---------------------------------------------------------------------------------
  const pause = h('div', 'sb-screen overlay', root);
  const pc = h('div', 'sb-center', pause);
  const pband = h('div', 'sb-band', pc);
  h('div', 'sb-tab', pband);
  const pin = h('div', 'inner', pband);
  h('div', 't', pin, 'PAUSED');
  h('div', 's', pin, 'THE CROWD WAITS · CLICK TO RESUME');
  h('div', 'sb-tab', pband);
  const prow = h('div', 'sb-pause-row', pc);
  const pmenu = h('div', 'sb-menu', prow);
  const pitStop = () => ctx.rounds?.state.phase === 'cleared';
  const pauseRows: MenuRow[] = [
    { el: row(pmenu, 'RESUME', '[LMB]', () => cb.onResume(), true) },
    {
      el: row(pmenu, 'CONTINUE · NEXT ROUND', '[ENTER]', () => cb.onContinue?.()),
      when: () => pitStop() && !!cb.onContinue && !(ctx.net?.inSession && !ctx.isHost),
    },
    { el: row(pmenu, 'SHOP', '[B]', () => cb.onOpenShop?.()), when: () => pitStop() && !!ctx.economy && !!cb.onOpenShop },
    { el: row(pmenu, 'SKILL TREE', '[TAB]', () => cb.onOpenSkills?.()) },
    { el: row(pmenu, 'LOADOUT', '[I]', () => cb.onOpenInventory?.()), when: () => !!ctx.gear },
    { el: row(pmenu, 'CO-OP', '[F2]', openCoop), when: () => !!ctx.net },
    { el: soundRow(pmenu) },
  ];
  buildSettings(prow);
  pause.addEventListener('click', () => cb.onResume());

  // ---- skills (tree + class picker live in ./skillTree.ts) -----------------------------------
  const skills = h('div', 'sb-screen skills-screen', root);
  h('div', 'sb-floorplan', skills);
  const panel = h('div', 'sb-skills', skills);
  const tree = createSkillTree(ctx, panel, root, { onClose: () => cb.onCloseSkills() });

  // ---- game over -------------------------------------------------------------------------------
  const over = h('div', 'sb-screen overlay', root);
  const oc = h('div', 'sb-center', over);
  const oband = h('div', 'sb-band threat', oc);
  h('div', 'sb-tab threat', oband);
  const oin = h('div', 'inner', oband);
  const goTitle = h('div', 't', oin, 'ELIMINATED');
  h('div', 's', oin, 'THE PIT KEEPS WHAT IT TAKES');
  h('div', 'sb-tab threat', oband);
  const orow = h('div', 'sb-over-row', oc);
  const recap = h('div', 'sb-recap sb-panel', orow);
  const rhd = h('div', 'hd', recap);
  h('span', 'sb-lbl', rhd, 'MANIFEST · RUN RECAP');
  const recapSerial = h('span', 'sb-lbl', rhd);
  const recapTable = h('table', '', recap);
  const overSide = h('div', 'sb-over-side', orow);
  stop(overSide);
  let overBadge: StandingBadgeWidget | null = null;
  const acts = h('div', 'sb-over-acts', oc);
  const omenu = h('div', 'sb-menu', acts);
  let retryRow: HTMLButtonElement | null = null;
  const overRows: MenuRow[] = [
    { el: retryRow = row(omenu, 'RETRY', '[LMB]', () => cb.onRetry(), true) },
    { el: row(omenu, 'MAIN MENU', '', () => cb.onMainMenu?.()), when: () => !!cb.onMainMenu },
    { el: row(omenu, 'SKILL TREE', '[TAB]', () => cb.onOpenSkills?.()) },
  ];
  const overHint = h('div', 'sb-lbl', oc, 'LEVEL, SKILL TREE AND STANDING ARE KEPT · [TAB] TO SPEND POINTS');
  over.addEventListener('click', () => cb.onRetry());
  let goRound = 0;
  let goKills = 0;
  let bestWeapon: WeaponDef | null = null;

  const all: Partial<Record<Screen, HTMLElement>> = { start, pause, skills, gameover: over };

  function refreshPlaque(): void {
    const sys = ctx.standing;
    if (sys) {
      if (!startBadge) startBadge = createStandingBadge(ctx, sys, plaque);
      plaque.insertBefore(startBadge.el, startBest);
      startBadge.refresh();
      plaqueTab.classList.add('sb-hidden');
      plaqueBody.classList.add('sb-hidden');
      return;
    }
    const ls = currentLeague(ctx);
    const rank = RANKS[0];
    const next = RANKS[1]?.name ?? '—';
    plaqueLine.innerHTML = `<b>${esc(ls.name)}</b> · RANK ${pad2(rank.index + 1)}/${RANKS.length} · ${esc(rank.name.toUpperCase())} · NEXT: ${esc(next.toUpperCase())}`;
  }

  function refreshBest(): void {
    const best = readBestRound();
    startBest.textContent = best > 0 ? `BEST ROUND ${pad2(best)}` : 'NO RUNS YET · THE CROWD WANTS A NEW NAME';
    renderRecap();
  }

  /** Standing earned since the run started (standing history, newest last). */
  function runStanding(): number {
    const s = ctx.standing?.standing;
    if (!s) return 0;
    const since = run?.startedAt ?? 0;
    let sum = 0;
    for (const g of s.history) if (g.at >= since) sum += g.amount;
    return sum;
  }

  function renderRecap(): void {
    const best = Math.max(readBestRound(), goRound);
    const bw = run?.bestWeapon ?? bestWeapon;
    const bwHtml = bw
      ? `<span class="sb-mini"><span class="sb-sq" style="background:${rarityCss(bw.rarity)};margin:0"></span><span class="nm">${esc(bw.name)}</span>
         <span class="sub">${bw.rarity.toUpperCase()} · ${Math.round(weaponDps(bw))} DPS · ILV ${pad2(bw.level)}</span></span>`
      : '—';
    const s = ctx.standing?.standing;
    let standingRows = '';
    if (s) {
      const gained = runStanding();
      const up = run && run.rankAtStart >= 0 && s.rank.index > run.rankAtStart;
      standingRows = `<tr><td>Standing earned</td><td>+${fmtInt(gained)}</td></tr>
        <tr><td>Rank</td><td>${up ? '▲ ' : ''}${esc(s.rank.name.toUpperCase())} · ${pad2(s.rank.index + 1)}/${RANKS.length}</td></tr>`;
    } else {
      standingRows = '<tr><td>Standing earned</td><td>—</td></tr>';
    }
    recapTable.innerHTML = `
      <tr class="big"><td>Round reached</td><td>${pad2(goRound)}</td></tr>
      <tr><td>Kills</td><td>${fmtInt(Math.max(goKills, 0))}</td></tr>
      <tr><td>Damage dealt</td><td>${fmtInt(run?.damage ?? 0)}</td></tr>
      <tr><td>Time survived</td><td>${fmtTime(run?.time ?? 0)}</td></tr>
      <tr><td>Best weapon</td><td>${bwHtml}</td></tr>
      <tr><td>Best round</td><td>${pad2(best)}</td></tr>
      ${standingRows}`;
    recapSerial.textContent = `RUN ${pad2(goRound)}-${pad2(goKills % 100)}`;
    overSide.classList.toggle('sb-hidden', !ctx.standing);
    if (ctx.standing) {
      if (!overBadge) overBadge = createStandingBadge(ctx, ctx.standing, overSide, { showRunGain: true, runGain: runStanding });
      overBadge.refresh();
    }
  }

  /** Co-op client: runs are started by the host (rounds.start() is a no-op there). */
  const isClient = () => !!ctx.net?.inSession && !ctx.isHost;
  function refreshNet(): void {
    const client = isClient();
    const live = !!ctx.rounds && ctx.rounds.state.phase !== 'idle' && ctx.rounds.state.phase !== 'gameover';
    const waiting = client && !live;
    enterRow.querySelector('.v')!.textContent = client ? (live ? 'JOIN THE FIGHT' : 'ENTER · WAIT FOR HOST') : 'ENTER THE PIT';
    startCta.textContent = waiting ? 'WAITING FOR HOST' : 'CLICK TO ENTER';
    startCta.classList.toggle('wait', waiting);
    if (retryRow) retryRow.querySelector('.v')!.textContent = client ? 'BACK TO THE PIT' : 'RETRY';
    overHint.textContent = client
      ? 'WAITING FOR HOST TO START THE NEXT RUN · LEVEL, SKILL TREE AND STANDING ARE KEPT'
      : 'LEVEL, SKILL TREE AND STANDING ARE KEPT · [TAB] TO SPEND POINTS';
  }
  ctx.events.on('net:changed', () => refreshNet());
  ctx.events.on('round:phase', () => refreshNet());

  function show(screen: Screen): void {
    refreshNet();
    for (const [k, el] of Object.entries(all)) el!.classList.toggle('sb-hidden', k !== screen);
    if (screen === 'start') {
      renumber(startRows);
      refreshMenuLabels();
      for (const el of controlKeys) el.classList.toggle('sb-hidden', !(ctx as unknown as Record<string, unknown>)[el.dataset.sys!]);
      setSide(side === 'sponsor' && !ctx.standing ? 'controls' : side);
    }
    if (screen === 'pause') renumber(pauseRows);
    if (screen === 'gameover') renumber(overRows);
    if (screen === 'start' || screen === 'gameover') {
      refreshBest();
      refreshPlaque();
    }
    if (screen === 'skills') renderSkills();
    tree.syncPicker(screen);
    settingsSyncs.forEach((s) => s());
    soundShown = null;
    syncSound();
  }

  // ---- skill tree --------------------------------------------------------------------------
  function renderSkills(): void {
    tree.render();
  }

  function setGameOver(round: number, kills: number): void {
    goRound = round;
    goKills = kills;
    const ws = (ctx.player?.weapons ?? []).filter((w): w is WeaponDef => !!w);
    bestWeapon = ws.sort((a, b) => weaponDps(b) - weaponDps(a))[0] ?? null;
    goTitle.textContent = `ELIMINATED · ROUND ${pad2(round)}`;
    refreshBest();
  }

  show('none');
  return { show, renderSkills, refreshBest, setGameOver, syncSound };
}
