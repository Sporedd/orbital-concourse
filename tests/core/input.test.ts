// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '@/core/input';

function key(type: 'keydown' | 'keyup', code: string, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, bubbles: true }));
}

function mouseMove(dx: number, dy: number): void {
  const e = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(e, 'movementX', { value: dx });
  Object.defineProperty(e, 'movementY', { value: dy });
  window.dispatchEvent(e);
}

describe('Input', () => {
  let canvas: HTMLCanvasElement;
  let input: Input;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    input = new Input(canvas);
  });

  it('tracks key down / justPressed / justReleased across endFrame', () => {
    key('keydown', 'KeyW');
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.justPressed('KeyW')).toBe(true);
    input.endFrame();
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.justPressed('KeyW')).toBe(false);
    key('keyup', 'KeyW');
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.justReleased('KeyW')).toBe(true);
    input.endFrame();
    expect(input.justReleased('KeyW')).toBe(false);
  });

  it('ignores auto-repeat keydowns', () => {
    key('keydown', 'KeyE');
    input.endFrame();
    key('keydown', 'KeyE', true);
    expect(input.justPressed('KeyE')).toBe(false);
  });

  it('uiCaptured hides gameplay input but raw variants still see presses', () => {
    input.uiCaptured = true;
    key('keydown', 'Tab');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(input.isDown('Tab')).toBe(false);
    expect(input.justPressed('Tab')).toBe(false);
    expect(input.rawJustPressed('Tab')).toBe(true);
    expect(input.mouseIsDown(0)).toBe(false);
    expect(input.rawMouseJustPressed(0)).toBe(true);
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
    expect(input.wheelDelta()).toBe(0);
  });

  it('mouse buttons: canvas mousedown, window mouseup', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    expect(input.mouseIsDown(2)).toBe(true);
    expect(input.mouseJustPressed(2)).toBe(true);
    input.endFrame();
    expect(input.mouseJustPressed(2)).toBe(false);
    expect(input.mouseIsDown(2)).toBe(true);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    expect(input.mouseIsDown(2)).toBe(false);
  });

  it('window blur releases all held keys and buttons', () => {
    key('keydown', 'KeyA');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new Event('blur'));
    expect(input.isDown('KeyA')).toBe(false);
    expect(input.mouseIsDown(0)).toBe(false);
  });

  it('accumulates wheel sign and resets on endFrame', () => {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 30 }));
    expect(input.wheelDelta()).toBe(2);
    input.endFrame();
    expect(input.wheelDelta()).toBe(0);
  });

  it('ignores mouse movement while unlocked', () => {
    expect(input.locked()).toBe(false);
    mouseMove(10, 5);
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
  });

  it('falls back to a virtual lock on pointerlockerror; mouse look then accumulates', () => {
    const changes = vi.fn();
    document.addEventListener('pointerlockchange', changes);
    document.dispatchEvent(new Event('pointerlockerror'));
    expect(input.locked()).toBe(true);
    expect(changes).toHaveBeenCalled();
    mouseMove(10, -4);
    mouseMove(5, 1);
    expect(input.mouseDelta()).toEqual({ dx: 15, dy: -3 });
    input.endFrame();
    expect(input.mouseDelta()).toEqual({ dx: 0, dy: 0 });
    document.removeEventListener('pointerlockchange', changes);
  });

  it('virtual lock: Escape unlocks, lock() re-locks, unlock() unlocks', () => {
    document.dispatchEvent(new Event('pointerlockerror'));
    expect(input.locked()).toBe(true);
    key('keydown', 'Escape');
    expect(input.locked()).toBe(false);
    input.lock();
    expect(input.locked()).toBe(true);
    input.unlock();
    expect(input.locked()).toBe(false);
  });

  it('lock() falls back to the virtual lock when requestPointerLock is unavailable', () => {
    // jsdom has no requestPointerLock: calling it throws, which must not escape lock()
    expect(() => input.lock()).not.toThrow();
    expect(input.locked()).toBe(true);
  });

  it('lock() falls back when requestPointerLock returns a rejecting promise', async () => {
    (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = () => Promise.reject(new Error('denied'));
    input.lock();
    expect(input.locked()).toBe(false); // real lock pending (pointerLockElement is null)
    await Promise.resolve();
    await Promise.resolve();
    expect(input.locked()).toBe(true);
  });
});
