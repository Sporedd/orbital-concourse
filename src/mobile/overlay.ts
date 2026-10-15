/**
 * Touch overlay (mobile only): two layers around the HUD root (#ui) plus a portrait blocker.
 *   #sbm-touch     under #ui: left half = floating move stick, right half = look. Taps on HUD
 *                  widgets fall through to it (they are pointer-events: none); the pit-stop band
 *                  and every menu screen sit above it and get their taps as usual.
 *   #sbm-controls  over #ui: fire cluster (fire, jump, aim, reload, melee, grenade, swap,
 *                  skill), contextual TAKE / SALVAGE, top bar (pause, help, skills, shop).
 *                  Visible only while playing with no screen open (html.sbm-play).
 *   .sbm-rotate    portrait blocker ("rotate your phone").
 * Everything goes into the game through the VirtualInput of src/core/input.ts: the same key codes
 * and mouse buttons the keyboard and mouse use, so no gameplay code knows about touch.
 */
import type { VirtualInput } from '@/core/input';
import type { GameContext } from '@/core/types';
import { enemyUnderCrosshair } from './aim';
import { LOOK_SENS_RANGE, type MobileSettingsStore } from './settings';
import { AutoFire, FloatingStick, LookTracker, STICK, STICK_CODES, type AutoFireWeapon } from './touch';

export interface MobileOverlay {
  /** Once per frame, after the HUD update and before the player update (main.ts). */
  update(dt: number): void;
  readonly touch: HTMLElement;
  readonly controls: HTMLElement;
  readonly rotate: HTMLElement;
}

type Kind = 'key' | 'fire' | 'ads' | 'swap';
interface ButtonSpec {
  id: string;
  label: string;
  kind: Kind;
  code?: string;
  aria: string;
}

/** Fire cluster (right thumb). Positions are in the stylesheet (.sbm-b-<id>). */
export const CLUSTER: readonly ButtonSpec[] = [
  { id: 'fire', label: 'FIRE', kind: 'fire', aria: 'Fire (hold)' },
  { id: 'jump', label: 'JUMP', kind: 'key', code: 'Space', aria: 'Jump' },
  { id: 'ads', label: 'AIM', kind: 'ads', aria: 'Aim down sights (toggle)' },
  { id: 'reload', label: 'RELOAD', kind: 'key', code: 'KeyR', aria: 'Reload' },
  { id: 'melee', label: 'MELEE', kind: 'key', code: 'KeyV', aria: 'Melee' },
  { id: 'grenade', label: 'GREN', kind: 'key', code: 'KeyG', aria: 'Throw grenade' },
  { id: 'swap', label: 'SWAP', kind: 'swap', aria: 'Swap weapon' },
  { id: 'skill', label: 'SKILL', kind: 'key', code: 'KeyQ', aria: 'Class active skill' },
];
/** Shown only near loot (TAKE also in co-op: hold to revive). */
export const CONTEXT: readonly ButtonSpec[] = [
  { id: 'take', label: 'TAKE', kind: 'key', code: 'KeyE', aria: 'Take weapon / hold to revive' },
  { id: 'salvage', label: 'SALVAGE', kind: 'key', code: 'KeyF', aria: 'Salvage weapon for scrip' },
];
/** Top bar: the same keys the menus listen for. */
export const TOP_BAR: readonly ButtonSpec[] = [
  { id: 'pause', label: 'II', kind: 'key', code: 'Escape', aria: 'Pause' },
  { id: 'help', label: '?', kind: 'key', code: 'KeyH', aria: 'Help' },
  { id: 'skills', label: 'SKILLS', kind: 'key', code: 'Tab', aria: 'Skill tree' },
  { id: 'shop', label: 'SHOP', kind: 'key', code: 'KeyB', aria: 'Shop (pit stop)' },
];

/** One line per control, for the start screen's CONTROLS panel (help has the same in helpContent). */
export const TOUCH_CONTROLS: readonly [string, string][] = [
  ['LEFT THUMB', 'Move · push past the ring to sprint'],
  ['RIGHT THUMB', 'Look · drag on FIRE to aim while shooting'],
  ['FIRE', 'Hold to shoot · AUTO fires on a target'],
  ['AIM', 'Aim down sights (toggle)'],
  ['JUMP RELOAD', 'Jump · reload'],
  ['MELEE GREN', 'Melee · grenade'],
  ['SWAP SKILL', 'Next weapon · class active'],
  ['TAKE SALVAGE', 'Appear next to a dropped gun'],
  ['II ? SKILLS SHOP', 'Pause · help · skill tree · shop'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export function createOverlay(ctx: GameContext, v: VirtualInput, settings: MobileSettingsStore): MobileOverlay {
  const doc = document.documentElement;
  const uiRoot = ctx.uiRoot;

  // ---- layers -------------------------------------------------------------------------------
  const touch = el('div', 'sbm-touch');
  touch.id = 'sbm-touch';
  uiRoot.parentElement!.insertBefore(touch, uiRoot);
  const stickEl = el('div', 'sbm-stick', touch);
  const ringEl = el('div', 'ring', stickEl);
  const baseEl = el('div', 'base', stickEl);
  const knobEl = el('div', 'knob', stickEl);
  void ringEl;
  void baseEl;

  const controls = el('div', 'sbm-controls');
  controls.id = 'sbm-controls';
  uiRoot.parentElement!.insertBefore(controls, uiRoot.nextSibling);
  const top = el('div', 'sbm-top', controls);
  const cluster = el('div', 'sbm-cluster', controls);
  const ctxRow = el('div', 'sbm-ctx', controls);

  const rotate = el('div', 'sbm-rotate', document.body);
  rotate.innerHTML = '<div class="in"><div class="ph"><i></i></div><div class="t">ROTATE YOUR PHONE</div><div class="s">THE PIT PLAYS IN LANDSCAPE</div></div>';

  // ---- state --------------------------------------------------------------------------------
  const stick = new FloatingStick();
  const look = new LookTracker();
  const fireLook = new LookTracker();
  const autoFire = new AutoFire();
  /** Manual hold of FIRE: full-auto holds, semi-auto repeats at the gun's fire rate. */
  const manualFire = new AutoFire({ dwell: 0, grace: 0 });
  const stickHeld = new Set<string>();
  /** pointerId → the button it went down on. */
  const buttonPointers = new Map<number, { spec: ButtonSpec; btn: HTMLElement }>();
  const firePointers = new Set<number>();
  let mouse0 = false;
  let mouse2 = false;
  let adsOn = false;
  let wasPlaying = false;
  const buttons = new Map<string, HTMLElement>();

  // ---- buttons ------------------------------------------------------------------------------
  const pointerDownButton = (spec: ButtonSpec, btn: HTMLElement, e: PointerEvent) => {
    buttonPointers.set(e.pointerId, { spec, btn });
    btn.classList.add('on');
    switch (spec.kind) {
      case 'key':
        v.press(spec.code!);
        break;
      case 'fire':
        firePointers.add(e.pointerId);
        fireLook.start(e.pointerId, e.clientX, e.clientY, e.timeStamp);
        if (!mouse0) {
          v.pressMouse(0); // at once: a tap shorter than a frame still pulls the trigger
          mouse0 = true;
        }
        break;
      case 'ads':
        adsOn = !adsOn;
        break;
      case 'swap':
        v.wheel(1);
        break;
    }
  };
  const pointerUpButton = (pointerId: number) => {
    const held = buttonPointers.get(pointerId);
    if (!held) return;
    buttonPointers.delete(pointerId);
    const { spec, btn } = held;
    if (![...buttonPointers.values()].some((h) => h.btn === btn)) btn.classList.remove('on');
    if (spec.kind === 'key') {
      if (![...buttonPointers.values()].some((h) => h.spec.code === spec.code)) v.release(spec.code!);
    } else if (spec.kind === 'fire') {
      firePointers.delete(pointerId);
      fireLook.end(pointerId);
    }
  };

  const makeButton = (spec: ButtonSpec, parent: HTMLElement, cls: string): HTMLElement => {
    const b = el('button', `sbm-btn ${cls} sbm-b-${spec.id}`, parent);
    b.type = 'button';
    b.setAttribute('aria-label', spec.aria);
    b.dataset.id = spec.id;
    el('span', 'l', b, spec.label);
    if (spec.kind === 'fire') el('span', 'auto', b, 'AUTO');
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // no compatibility mouse events (they would reach the game's mouse path)
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      pointerDownButton(spec, b, e);
    });
    b.addEventListener('pointermove', (e) => {
      if (spec.kind !== 'fire' || !firePointers.has(e.pointerId)) return;
      const d = fireLook.move(e.pointerId, e.clientX, e.clientY, e.timeStamp, settings.get().lookSensitivity);
      if (d) v.look(d.dx, d.dy);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      b.addEventListener(t, (e) => pointerUpButton(e.pointerId));
    }
    // no synthesized click: a pause / help tap would otherwise land on the screen it opens
    // (whose click resumes) a moment later
    b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    buttons.set(spec.id, b);
    return b;
  };
  for (const s of TOP_BAR) makeButton(s, top, 'top');
  for (const s of CLUSTER) makeButton(s, cluster, s.kind === 'fire' ? 'fire' : 'round');
  for (const s of CONTEXT) makeButton(s, ctxRow, 'ctx');

  // ---- stick + look --------------------------------------------------------------------------
  touch.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const leftHalf = e.clientX < window.innerWidth * 0.5;
    const ok = leftHalf ? stick.start(e.pointerId, e.clientX, e.clientY) : look.start(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    if (!ok) return;
    try {
      touch.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    if (leftHalf) drawStick();
  });
  touch.addEventListener('pointermove', (e) => {
    if (stick.move(e.pointerId, e.clientX, e.clientY)) {
      drawStick();
      return;
    }
    const d = look.move(e.pointerId, e.clientX, e.clientY, e.timeStamp, settings.get().lookSensitivity);
    if (d) v.look(d.dx, d.dy);
  });
  const endTouch = (e: PointerEvent) => {
    if (stick.end(e.pointerId)) drawStick();
    look.end(e.pointerId);
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) touch.addEventListener(t, endTouch);
  touch.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  touch.addEventListener('contextmenu', (e) => e.preventDefault());

  function drawStick(): void {
    stickEl.classList.toggle('live', stick.active);
    if (!stick.active) {
      stickEl.style.removeProperty('transform');
      knobEl.style.transform = 'translate(-50%, -50%)';
      stickEl.classList.remove('sprint');
      return;
    }
    stickEl.style.transform = `translate(${stick.originX}px, ${stick.originY}px)`;
    const k = stick.knob();
    knobEl.style.transform = `translate(calc(-50% + ${k.dx.toFixed(1)}px), calc(-50% + ${k.dy.toFixed(1)}px))`;
    stickEl.classList.toggle('sprint', stick.keys().sprint);
  }
  stickEl.style.setProperty('--r', `${STICK.radius}px`);
  stickEl.style.setProperty('--sr', `${STICK.radius * STICK.sprintAt}px`);
  drawStick();

  // ---- settings rows (start + pause SETTINGS panels) ----------------------------------------
  const settingsSyncs: (() => void)[] = [];
  function addSettingsRows(panel: HTMLElement, idx: number): void {
    // the desktop mouse-sensitivity row, its note and reset button do nothing on a touch screen
    panel.querySelector('.sb-set-row')?.classList.add('sbm-desk');
    panel.querySelector('.note')?.classList.add('sbm-desk');
    panel.querySelector('.acts')?.classList.add('sbm-desk');
    const anchor = panel.querySelector('.note');

    const sens = el('div', 'sb-set-row sbm-row');
    const id = `sbm-sens-${idx}`;
    const lbl = el('label', 'sb-lbl', sens, 'LOOK SENSITIVITY');
    lbl.htmlFor = id;
    const val = el('span', 'sb-val', sens);
    const ctl = el('div', 'ctl', sens);
    const minus = el('button', 'sb-step', ctl, '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Lower look sensitivity');
    const range = el('input', 'sb-range', ctl);
    range.type = 'range';
    range.id = id;
    range.min = String(LOOK_SENS_RANGE.min);
    range.max = String(LOOK_SENS_RANGE.max);
    range.step = String(LOOK_SENS_RANGE.step);
    const plus = el('button', 'sb-step', ctl, '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Raise look sensitivity');
    range.addEventListener('input', () => settings.set('lookSensitivity', Number(range.value)));
    const nudge = (d: number) => settings.set('lookSensitivity', Math.round((settings.get().lookSensitivity + d) * 20) / 20);
    minus.addEventListener('click', () => nudge(-0.1));
    plus.addEventListener('click', () => nudge(0.1));

    const af = el('div', 'sb-set-row sbm-row');
    el('span', 'sb-lbl', af, 'AUTO-FIRE');
    const tog = el('button', 'sb-toggle', af);
    tog.type = 'button';
    tog.setAttribute('role', 'switch');
    tog.setAttribute('aria-label', 'Auto-fire');
    tog.innerHTML = '<span>OFF</span><span>ON</span>';
    tog.addEventListener('click', () => {
      settings.set('autoFire', !settings.get().autoFire);
      ctx.audio.play('ui_click');
    });
    const note = el('div', 'note sb-lbl sbm-row', undefined, 'AUTO-FIRE SHOOTS WHEN THE CROSSHAIR RESTS ON AN ENEMY');

    panel.insertBefore(sens, anchor);
    panel.insertBefore(af, anchor);
    panel.insertBefore(note, anchor);
    const sync = () => {
      const s = settings.get();
      if (document.activeElement !== range) range.value = String(s.lookSensitivity);
      val.textContent = `${s.lookSensitivity.toFixed(2)}×`;
      const p = ((s.lookSensitivity - LOOK_SENS_RANGE.min) / (LOOK_SENS_RANGE.max - LOOK_SENS_RANGE.min)) * 100;
      range.style.setProperty('--p', `${p.toFixed(1)}%`);
      tog.setAttribute('aria-checked', String(s.autoFire));
      tog.children[0]?.classList.toggle('on', !s.autoFire);
      tog.children[1]?.classList.toggle('on', s.autoFire);
    };
    settingsSyncs.push(sync);
    sync();
  }
  uiRoot.querySelectorAll<HTMLElement>('.sb-settings').forEach((p, i) => addSettingsRows(p, i));
  settings.onChange(() => settingsSyncs.forEach((s) => s()));

  // ---- menus: touch wording ------------------------------------------------------------------
  // keyboard hints on menu rows ([LMB], [TAB] ...) mean nothing here
  uiRoot.querySelectorAll<HTMLElement>('.sb-menu button .r').forEach((r) => {
    if (/^\[.*\]$/.test(r.textContent ?? '')) r.classList.add('sbm-desk');
  });
  // start screen CONTROLS panel: touch controls instead of the keyboard grid
  const ctrlPanel = uiRoot.querySelector<HTMLElement>('.sb-controls');
  if (ctrlPanel) {
    const list = el('div', 'sbm-ctrls', ctrlPanel);
    for (const [k, d] of TOUCH_CONTROLS) {
      el('span', 'k', list, k);
      el('span', 'd', list, d);
    }
    const sub = ctrlPanel.querySelector('.hd .sb-lbl:last-child');
    if (sub) {
      sub.classList.add('sbm-desk');
      el('span', 'sb-lbl sbm-only', sub.parentElement as HTMLElement, 'TOUCH');
    }
  }
  // skill tree: a tap on the empty floor plan would close the screen; on a phone that tap is
  // usually the end of a scroll, so only BACK (and the screen edges) close it
  uiRoot.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest('.sb-skills .sb-plan')) return;
    if (t.closest('.sb-node') || t.closest('button')) return;
    e.stopPropagation();
  }, true);

  // loadout: picking a backpack piece opens the upgrade bay further down the scrolling screen
  uiRoot.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    const inv = t?.closest('.sbg-inv:not(.sbg-shop)');
    if (!inv || !t!.closest('.sbg-cell, .sbg-row')) return;
    requestAnimationFrame(() => {
      const bay = [...inv.querySelectorAll<HTMLElement>('.sbg-panel')].find((p) => !p.hidden && p.textContent?.includes('UPGRADE BAY'));
      bay?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });

  // ---- browser chrome: fullscreen + landscape on the first tap, audio on every touch ---------
  let askedFullscreen = false;
  const firstTap = () => {
    if (askedFullscreen) return;
    askedFullscreen = true;
    document.removeEventListener('pointerup', firstTap, true);
    try {
      const req = doc.requestFullscreen?.({ navigationUI: 'hide' });
      req?.then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
        .catch(() => { /* not allowed (iOS, embedded): play in the browser UI */ });
    } catch {
      /* no fullscreen API */
    }
  };
  document.addEventListener('pointerup', firstTap, true);
  // The audio system unlocks on pointerdown; iOS Safari only counts touchend as a gesture.
  document.addEventListener('touchend', () => ctx.audio.resume(), { capture: true, passive: true });

  // the app went to the background mid-fight: pause (the desktop gets this from pointer lock)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && wasPlaying) ctx.hud.showScreen('pause');
  });

  // ---- per frame -----------------------------------------------------------------------------
  const setKey = (code: string, want: boolean) => {
    if (want && !stickHeld.has(code)) {
      stickHeld.add(code);
      v.press(code);
    } else if (!want && stickHeld.has(code)) {
      stickHeld.delete(code);
      v.release(code);
    }
  };
  const setMouse = (button: 0 | 2, want: boolean) => {
    const cur = button === 0 ? mouse0 : mouse2;
    if (want === cur) return;
    if (want) v.pressMouse(button);
    else v.releaseMouse(button);
    if (button === 0) mouse0 = want;
    else mouse2 = want;
  };

  function releaseAll(): void {
    for (const c of stickHeld) v.release(c);
    stickHeld.clear();
    for (const { spec } of buttonPointers.values()) if (spec.kind === 'key') v.release(spec.code!);
    buttonPointers.clear();
    firePointers.clear();
    setMouse(0, false);
    setMouse(2, false);
    adsOn = false;
    stick.reset();
    look.reset();
    fireLook.reset();
    autoFire.reset();
    manualFire.reset();
    for (const b of buttons.values()) b.classList.remove('on');
    drawStick();
  }

  const prompt = () => uiRoot.querySelector<HTMLElement>('.sb-prompt');
  const qchip = () => uiRoot.querySelector<HTMLElement>('.sb-qchip');
  const show = (id: string, on: boolean) => buttons.get(id)?.classList.toggle('sbm-off', !on);
  let promptEl: HTMLElement | null = null;
  let qEl: HTMLElement | null = null;
  let ptsEl: HTMLElement | null = null;

  function update(dt: number): void {
    const phase = ctx.rounds?.state.phase;
    const playing = ctx.hud.screen === 'none' && !!phase && phase !== 'idle' && phase !== 'gameover';
    doc.classList.toggle('sbm-play', playing);
    if (!playing) {
      if (wasPlaying) releaseAll();
      wasPlaying = false;
      return;
    }
    wasPlaying = true;
    if (window.innerHeight > window.innerWidth) {
      // portrait: the rotate blocker covers the screen; freeze the fight behind it
      ctx.hud.showScreen('pause');
      return;
    }

    // left thumb → W A S D + sprint
    const k = stick.keys();
    setKey(STICK_CODES.forward, k.forward);
    setKey(STICK_CODES.back, k.back);
    setKey(STICK_CODES.left, k.left);
    setKey(STICK_CODES.right, k.right);
    setKey(STICK_CODES.sprint, k.sprint);

    const player = ctx.player;
    const alive = !!player?.alive;
    if (!alive) adsOn = false;
    setMouse(2, adsOn);
    buttons.get('ads')?.classList.toggle('on', adsOn);

    // trigger: manual hold, else auto-fire on a target under the crosshair
    const def = alive ? player.activeWeapon : null;
    const weapon: AutoFireWeapon | null = def ? { auto: def.auto, fireRate: def.fireRate } : null;
    const manual = firePointers.size > 0;
    const autoOn = settings.get().autoFire && !manual && !!weapon;
    const onTarget = autoOn && !!enemyUnderCrosshair(ctx, def!.range);
    const auto = autoFire.update(dt, onTarget, weapon, autoOn);
    const held = manualFire.update(dt, manual, weapon, manual);
    setMouse(0, manual ? held : auto);
    const fireBtn = buttons.get('fire');
    fireBtn?.classList.toggle('autoon', settings.get().autoFire);
    fireBtn?.classList.toggle('firing', autoFire.firing);

    // contextual buttons follow the HUD
    if (!promptEl || !promptEl.isConnected) promptEl = prompt();
    const near = !!promptEl && !promptEl.classList.contains('sb-hidden');
    show('take', near || !!ctx.net?.inSession);
    show('salvage', near && !!promptEl?.querySelector('.salv'));
    show('shop', phase === 'cleared' && !!ctx.economy);
    // the vitals footer (grenades) and the points tab are hidden here: show them on the buttons
    const gren = buttons.get('grenade');
    if (gren) {
      const n = String(Math.max(0, player?.grenades ?? 0));
      if (gren.dataset.count !== n) gren.dataset.count = n;
    }
    if (!ptsEl || !ptsEl.isConnected) ptsEl = uiRoot.querySelector<HTMLElement>('.sb-pts');
    buttons.get('skills')?.classList.toggle('badge', !!ptsEl && ptsEl.style.display !== 'none');
    if (!qEl || !qEl.isConnected) qEl = qchip();
    const q = qEl?.className ?? 'sb-hidden';
    const skill = buttons.get('skill');
    if (skill) {
      skill.classList.toggle('sbm-off', q.includes('sb-hidden'));
      skill.classList.toggle('ready', q.includes('ready'));
      skill.classList.toggle('live', /\bon\b/.test(q));
    }
  }

  return { update, touch, controls, rotate };
}
