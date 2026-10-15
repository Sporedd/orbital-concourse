/**
 * Injection API for a non-keyboard input source (src/mobile/touch layer): key codes and mouse
 * buttons are the same names the keyboard/mouse path uses, look deltas are in mouse pixels.
 */
export interface VirtualInput {
  /** Look movement in mouse pixels (ignored while unlocked, like mousemove). */
  look(dx: number, dy: number): void;
  /** Hold a key (KeyboardEvent.code: 'KeyW', 'Space', 'ShiftLeft', 'Escape'...). */
  press(code: string): void;
  release(code: string): void;
  /** Hold a mouse button (0 fire, 2 aim). */
  pressMouse(button: number): void;
  releaseMouse(button: number): void;
  /** Mouse-wheel steps (sign only: +1 next weapon, -1 previous). */
  wheel(steps: number): void;
}

/**
 * Keyboard/mouse state with pointer lock. Key names are KeyboardEvent.code
 * ('KeyW', 'Space', 'ShiftLeft', 'Digit1', 'Tab', 'Escape'...). Mouse buttons: 0 left, 1 middle, 2 right.
 * Only the local player controller and the UI read this (co-op rule).
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private mouseDown = new Set<number>();
  private mousePressed = new Set<number>();
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  /** When true, gameplay input is ignored (a menu is open). */
  uiCaptured = false;
  /**
   * Fallback when the browser refuses pointer lock (embedded webviews, some iframes):
   * we emulate the lock state so mouse look still works from movementX/Y and Escape still "unlocks".
   */
  private lockless = false;
  private virtualLocked = false;
  /** Real pointer lock has worked at least once: later failures are transient (e.g. Chrome
   * refuses a re-lock right after Esc), so they must not switch to the lockless fallback. */
  private everLocked = false;
  readonly locked = () => (this.lockless ? this.virtualLocked : document.pointerLockElement === this.canvas);

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        // still held (e.g. after alt-tab, where blur cleared `down`): held, not newly pressed
        this.down.add(e.code);
        if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
        return;
      }
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.code === 'Escape' && this.lockless && this.virtualLocked) {
        this.virtualLocked = false;
        document.dispatchEvent(new Event('pointerlockchange'));
      }
    });
    document.addEventListener('pointerlockerror', () => this.lockFailed());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.canvas) this.everLocked = true;
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseDown.clear();
    });
    canvas.addEventListener('mousedown', (e) => {
      this.mouseDown.add(e.button);
      this.mousePressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.mouseDown.delete(e.button));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked()) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  lock(): void {
    if (this.locked()) return;
    if (this.lockless) {
      this.virtualLocked = true;
      document.dispatchEvent(new Event('pointerlockchange'));
      return;
    }
    try {
      const res = this.canvas.requestPointerLock() as unknown;
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch(() => this.lockFailed());
      }
    } catch {
      this.lockFailed();
    }
  }

  unlock(): void {
    if (this.lockless) {
      if (this.virtualLocked) {
        this.virtualLocked = false;
        document.dispatchEvent(new Event('pointerlockchange'));
      }
      return;
    }
    if (this.locked()) document.exitPointerLock();
  }

  private lockFailed(): void {
    // Transient refusal in a browser that can lock: stay unlocked (the pause screen asks for
    // another click). Only an environment that never granted a lock gets the fallback.
    if (this.everLocked) return;
    this.enterLockless();
  }

  private enterLockless(): void {
    if (this.lockless) return;
    console.info('[input] pointer lock unavailable; using virtual lock (mouse look without capture)');
    this.lockless = true;
    this.virtualLocked = true;
    document.dispatchEvent(new Event('pointerlockchange'));
  }

  isDown(code: string): boolean { return !this.uiCaptured && this.down.has(code); }
  justPressed(code: string): boolean { return !this.uiCaptured && this.pressed.has(code); }
  justReleased(code: string): boolean { return !this.uiCaptured && this.released.has(code); }
  /** Raw variants ignore uiCaptured (for the UI itself: Tab, Escape, clicks on screens). */
  rawJustPressed(code: string): boolean { return this.pressed.has(code); }
  mouseIsDown(button = 0): boolean { return !this.uiCaptured && this.mouseDown.has(button); }
  mouseJustPressed(button = 0): boolean { return !this.uiCaptured && this.mousePressed.has(button); }
  rawMouseJustPressed(button = 0): boolean { return this.mousePressed.has(button); }

  /** Accumulated mouse movement since last frame. Reset by endFrame(). */
  mouseDelta(): { dx: number; dy: number } {
    return this.uiCaptured ? { dx: 0, dy: 0 } : { dx: this.dx, dy: this.dy };
  }
  wheelDelta(): number { return this.uiCaptured ? 0 : this.wheel; }

  /**
   * Programmatic input source (the touch layer in src/mobile is the only caller). It drives the
   * same key / button / look state the keyboard and mouse do, so every reader (controller,
   * weapons, UI) sees ordinary input. Touch screens have no pointer lock: from now on lock()
   * and unlock() use the virtual lock (the same state as the lockless fallback above).
   * Never called on desktop, where nothing here changes.
   */
  attachVirtual(): VirtualInput {
    if (!this.lockless) {
      this.lockless = true;
      this.virtualLocked = false;
    }
    return {
      look: (dx, dy) => {
        if (!this.locked()) return; // same rule as mousemove
        this.dx += dx;
        this.dy += dy;
      },
      press: (code) => {
        if (!this.down.has(code)) this.pressed.add(code); // a held key is not pressed again
        this.down.add(code);
      },
      release: (code) => {
        if (!this.down.has(code)) return;
        this.down.delete(code);
        this.released.add(code);
      },
      pressMouse: (button) => {
        if (!this.mouseDown.has(button)) this.mousePressed.add(button);
        this.mouseDown.add(button);
      },
      releaseMouse: (button) => {
        this.mouseDown.delete(button);
      },
      wheel: (steps) => {
        this.wheel += Math.sign(steps);
      },
    };
  }

  /** Called by main.ts at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }
}
