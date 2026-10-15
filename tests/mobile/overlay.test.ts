// @vitest-environment jsdom
/**
 * Touch overlay → the real Input (src/core/input.ts attachVirtual): buttons press and release
 * the same key codes the keyboard uses, the stick drives W/A/S/D + sprint, look drags become
 * mouse deltas, FIRE holds mouse button 0, AIM toggles button 2, auto-fire fires on a target, and
 * everything is released when a screen opens. Plus the injection API itself and the settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '@/core/input';
import type { GameContext } from '@/core/types';

const aim = vi.hoisted(() => ({ target: false }));
vi.mock('@/mobile/aim', () => ({ enemyUnderCrosshair: () => (aim.target ? { id: 'e1' } : null) }));

import { createOverlay } from '@/mobile/overlay';
import { MOBILE_SETTINGS_KEY, createMobileSettings, loadMobileSettings } from '@/mobile/settings';
import { LOOK, STICK } from '@/mobile/touch';

function pointer(target: Element, type: string, id: number, x: number, y: number): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: id });
  target.dispatchEvent(e);
}

describe('Input.attachVirtual', () => {
  let input: Input;
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    input = new Input(canvas);
  });

  it('press / release behave like keydown / keyup (one press edge while held)', () => {
    const v = input.attachVirtual();
    v.press('Space');
    expect(input.justPressed('Space')).toBe(true);
    expect(input.isDown('Space')).toBe(true);
    input.endFrame();
    v.press('Space'); // still held: no new edge
    expect(input.justPressed('Space')).toBe(false);
    v.release('Space');
    expect(input.isDown('Space')).toBe(false);
    expect(input.justReleased('Space')).toBe(true);
    // a tap shorter than a frame still counts as pressed this frame
    input.endFrame();
    v.press('KeyR');
    v.release('KeyR');
    expect(input.justPressed('KeyR')).toBe(true);
  });

  it('switches to the virtual lock: look deltas only while locked, unlock() releases', () => {
    const v = input.attachVirtual();
    expect(input.locked()).toBe(false);
    v.look(10, 5);
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
    input.lock();
    expect(input.locked()).toBe(true);
    v.look(10, 5);
    v.look(2, 1);
    expect(input.mouseDelta()).toEqual({ dx: 12, dy: 6 });
    input.endFrame();
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
    input.unlock();
    expect(input.locked()).toBe(false);
  });

  it('mouse buttons and wheel', () => {
    const v = input.attachVirtual();
    v.pressMouse(0);
    expect(input.mouseIsDown(0)).toBe(true);
    expect(input.mouseJustPressed(0)).toBe(true);
    v.releaseMouse(0);
    expect(input.mouseIsDown(0)).toBe(false);
    v.wheel(3);
    expect(input.wheelDelta()).toBe(1);
  });

  it('uiCaptured still hides virtual gameplay input', () => {
    const v = input.attachVirtual();
    input.uiCaptured = true;
    v.press('KeyW');
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.rawJustPressed('KeyW')).toBe(true);
  });
});

describe('mobile settings', () => {
  it(`persist under ${MOBILE_SETTINGS_KEY}; auto-fire defaults on`, () => {
    expect(loadMobileSettings()).toEqual({ autoFire: true, lookSensitivity: 1 });
    const s = createMobileSettings();
    s.set('autoFire', false);
    s.set('lookSensitivity', 99);
    const raw = JSON.parse(localStorage.getItem(MOBILE_SETTINGS_KEY)!);
    expect(raw).toMatchObject({ version: 1, autoFire: false, lookSensitivity: 3 });
    expect(loadMobileSettings()).toEqual({ autoFire: false, lookSensitivity: 3 });
  });
});

describe('touch overlay', () => {
  let input: Input;
  let ctx: GameContext;
  let overlay: ReturnType<typeof createOverlay>;
  const hud = { screen: 'none' as string, showScreen: vi.fn((s: string) => { hud.screen = s; }) };
  const weapon = { auto: true, fireRate: 10, range: 60 };

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    aim.target = false;
    document.body.innerHTML = '<canvas id="app"></canvas><div id="ui"><div class="sb-settings"><div class="hd"></div><div class="sb-set-row"></div><div class="note"></div><div class="acts"></div></div></div>';
    Object.defineProperty(window, 'innerWidth', { value: 844, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 390, configurable: true });
    hud.screen = 'none';
    input = new Input(document.getElementById('app') as HTMLCanvasElement);
    ctx = {
      uiRoot: document.getElementById('ui')!,
      input,
      hud,
      rounds: { state: { phase: 'fighting' } },
      player: { alive: true, activeWeapon: weapon },
      audio: { play() {}, resume() {} },
      net: { inSession: false },
    } as unknown as GameContext;
    overlay = createOverlay(ctx, input.attachVirtual(), createMobileSettings());
    input.lock();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  const btn = (id: string) => document.querySelector(`.sbm-b-${id}`)!;
  const frame = (dt = 1 / 60) => {
    overlay.update(dt);
  };

  it('shows the controls only while playing with no screen open', () => {
    frame();
    expect(document.documentElement.classList.contains('sbm-play')).toBe(true);
    hud.screen = 'pause';
    frame();
    expect(document.documentElement.classList.contains('sbm-play')).toBe(false);
  });

  it('buttons press the keyboard codes; release on pointerup', () => {
    for (const [id, code] of [['jump', 'Space'], ['reload', 'KeyR'], ['melee', 'KeyV'], ['grenade', 'KeyG'], ['skill', 'KeyQ'], ['pause', 'Escape'], ['help', 'KeyH'], ['skills', 'Tab'], ['shop', 'KeyB']] as const) {
      pointer(btn(id), 'pointerdown', 3, 0, 0);
      expect(input.rawJustPressed(code)).toBe(true);
      pointer(btn(id), 'pointerup', 3, 0, 0);
      input.endFrame();
      expect(input.rawJustPressed(code)).toBe(false);
    }
    pointer(btn('swap'), 'pointerdown', 3, 0, 0);
    expect(input.wheelDelta()).toBe(1);
  });

  it('touches that start on a button do not move the stick or the view', () => {
    pointer(btn('jump'), 'pointerdown', 4, 100, 300);
    pointer(btn('jump'), 'pointermove', 4, 100, 100);
    frame();
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
  });

  it('left half = stick (W/A/S/D + sprint), right half = look; both at once by pointer id', () => {
    const touch = overlay.touch;
    pointer(touch, 'pointerdown', 1, 150, 300);
    pointer(touch, 'pointerdown', 2, 600, 200);
    pointer(touch, 'pointermove', 1, 150, 300 - STICK.radius);
    pointer(touch, 'pointermove', 2, 602, 200);
    frame();
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.isDown('ShiftLeft')).toBe(false);
    expect(input.mouseDelta().dx).toBeGreaterThan(0);
    expect(input.mouseDelta().dx).toBeLessThanOrEqual(2 * LOOK.base * (1 + LOOK.accel) + 1e-9);
    input.endFrame();
    pointer(touch, 'pointermove', 1, 150, 300 - STICK.radius * 1.5);
    frame();
    expect(input.isDown('ShiftLeft')).toBe(true);
    pointer(touch, 'pointermove', 1, 150 - STICK.radius, 300);
    frame();
    expect(input.isDown('KeyA')).toBe(true);
    expect(input.isDown('KeyW')).toBe(false);
    pointer(touch, 'pointerup', 1, 0, 0);
    frame();
    expect(input.isDown('KeyA')).toBe(false);
  });

  it('FIRE holds mouse 0 (a quick tap still pulls the trigger); AIM toggles mouse 2', () => {
    pointer(btn('fire'), 'pointerdown', 5, 0, 0);
    expect(input.mouseJustPressed(0)).toBe(true);
    frame();
    expect(input.mouseIsDown(0)).toBe(true);
    pointer(btn('fire'), 'pointerup', 5, 0, 0);
    frame();
    expect(input.mouseIsDown(0)).toBe(false);
    pointer(btn('ads'), 'pointerdown', 6, 0, 0);
    pointer(btn('ads'), 'pointerup', 6, 0, 0);
    frame();
    expect(input.mouseIsDown(2)).toBe(true);
    pointer(btn('ads'), 'pointerdown', 6, 0, 0);
    frame();
    expect(input.mouseIsDown(2)).toBe(false);
  });

  it('auto-fire: holds the trigger after the dwell on a target; off in settings = never', () => {
    aim.target = true;
    for (let i = 0; i < 5; i++) frame();
    expect(input.mouseIsDown(0)).toBe(false);
    for (let i = 0; i < 10; i++) frame();
    expect(input.mouseIsDown(0)).toBe(true);
    aim.target = false;
    for (let i = 0; i < 20; i++) frame();
    expect(input.mouseIsDown(0)).toBe(false);
  });

  it('opening a screen releases everything that was held', () => {
    pointer(overlay.touch, 'pointerdown', 1, 150, 300);
    pointer(overlay.touch, 'pointermove', 1, 150, 200);
    pointer(btn('fire'), 'pointerdown', 5, 0, 0);
    pointer(btn('jump'), 'pointerdown', 6, 0, 0);
    frame();
    expect(input.isDown('KeyW')).toBe(true);
    hud.screen = 'pause';
    frame();
    input.uiCaptured = false;
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.isDown('Space')).toBe(false);
    expect(input.mouseIsDown(0)).toBe(false);
  });

  it('adds LOOK SENSITIVITY + AUTO-FIRE rows to the settings panels, hides the mouse row', () => {
    const panel = document.querySelector('.sb-settings')!;
    expect(panel.textContent).toContain('LOOK SENSITIVITY');
    expect(panel.textContent).toContain('AUTO-FIRE');
    expect(panel.querySelector('.sb-set-row')!.classList.contains('sbm-desk')).toBe(true);
    const tog = panel.querySelector('.sbm-row .sb-toggle') as HTMLButtonElement;
    expect(tog.getAttribute('aria-checked')).toBe('true');
    tog.click();
    expect(tog.getAttribute('aria-checked')).toBe('false');
    aim.target = true;
    for (let i = 0; i < 30; i++) frame();
    expect(input.mouseIsDown(0)).toBe(false);
  });

  it('portrait while playing pauses the fight', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    frame();
    expect(hud.showScreen).toHaveBeenCalledWith('pause');
  });
});
