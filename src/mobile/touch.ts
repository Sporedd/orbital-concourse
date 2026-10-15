/**
 * Touch → input mapping, as plain logic (no DOM, no THREE) so tests can drive it:
 *  - FloatingStick: the left-thumb stick appears where the thumb lands; a dead zone, 8-way
 *    W/A/S/D, and an outer ring past the base that holds sprint. It follows a thumb that slides
 *    far past the ring so the ring stays reachable.
 *  - LookTracker: right-thumb drag → look deltas in mouse pixels (the controller multiplies them
 *    by its own rad/pixel), × the mobile look sensitivity × a mild acceleration curve.
 *  - AutoFire: holds the virtual trigger once the crosshair has rested on an enemy for
 *    AUTO_FIRE.dwell seconds; semi-auto guns get one press per shot interval (the weapon system
 *    still applies its own fire rate, spread and reload rules).
 * Multi-touch is by pointer id: each tracker owns at most one pointer.
 */

export interface StickConfig { radius: number; deadZone: number; sprintAt: number; followAt: number; axis: number; sprintForward: number }
export interface LookConfig { base: number; accel: number; v0: number; v1: number }
export interface AutoFireConfig { dwell: number; grace: number }

export const STICK: Readonly<StickConfig> = {
  /** Base radius (CSS px): full deflection. */
  radius: 56,
  /** Fraction of the radius with no movement. */
  deadZone: 0.18,
  /** Deflection (× radius) where the outer sprint ring starts. */
  sprintAt: 1.3,
  /** Past this (× radius) the stick origin follows the thumb. */
  followAt: 1.8,
  /** Direction component (of the unit vector) that counts as pressing that way: sin 22.5°. */
  axis: 0.38,
  /** Sprint only while pushing mostly forward (unit-vector forward component). */
  sprintForward: 0.6,
};

export interface StickKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

export const NO_KEYS: Readonly<StickKeys> = { forward: false, back: false, left: false, right: false, sprint: false };

/** Keys for a stick offset (screen px from the origin; dy grows downwards). */
export function stickToKeys(dx: number, dy: number, cfg: StickConfig = STICK): StickKeys {
  const dist = Math.hypot(dx, dy);
  const m = dist / cfg.radius;
  if (!(m > cfg.deadZone)) return { ...NO_KEYS };
  const nx = dx / dist;
  const ny = -dy / dist; // forward = up the screen
  const forward = ny > cfg.axis;
  return {
    forward,
    back: ny < -cfg.axis,
    right: nx > cfg.axis,
    left: nx < -cfg.axis,
    sprint: forward && m >= cfg.sprintAt && ny >= cfg.sprintForward,
  };
}

export class FloatingStick {
  pointerId: number | null = null;
  originX = 0;
  originY = 0;
  x = 0;
  y = 0;

  constructor(readonly cfg: StickConfig = STICK) {}

  get active(): boolean {
    return this.pointerId !== null;
  }

  start(id: number, x: number, y: number): boolean {
    if (this.pointerId !== null) return false;
    this.pointerId = id;
    this.originX = this.x = x;
    this.originY = this.y = y;
    return true;
  }

  move(id: number, x: number, y: number): boolean {
    if (id !== this.pointerId) return false;
    this.x = x;
    this.y = y;
    const dx = x - this.originX;
    const dy = y - this.originY;
    const dist = Math.hypot(dx, dy);
    const max = this.cfg.radius * this.cfg.followAt;
    if (dist > max) {
      const k = (dist - max) / dist;
      this.originX += dx * k;
      this.originY += dy * k;
    }
    return true;
  }

  end(id: number): boolean {
    if (id !== this.pointerId) return false;
    this.pointerId = null;
    return true;
  }

  reset(): void {
    this.pointerId = null;
  }

  /** Offset from the origin (px). */
  offset(): { dx: number; dy: number } {
    return this.active ? { dx: this.x - this.originX, dy: this.y - this.originY } : { dx: 0, dy: 0 };
  }

  keys(): StickKeys {
    const { dx, dy } = this.offset();
    return this.active ? stickToKeys(dx, dy, this.cfg) : { ...NO_KEYS };
  }

  /** Knob position relative to the origin, clamped to the sprint ring (for drawing). */
  knob(): { dx: number; dy: number } {
    const { dx, dy } = this.offset();
    const d = Math.hypot(dx, dy);
    const max = this.cfg.radius * this.cfg.sprintAt;
    return d > max ? { dx: (dx / d) * max, dy: (dy / d) * max } : { dx, dy };
  }
}

export const LOOK: Readonly<LookConfig> = {
  /** Mouse pixels per CSS pixel of drag at sensitivity 1 (mouse look is 0.0022 rad/px). */
  base: 2.4,
  /** Extra gain at fast swipes: up to ×(1 + accel). */
  accel: 0.6,
  /** Swipe speed (CSS px/s) where acceleration starts / reaches its maximum. */
  v0: 250,
  v1: 1600,
};

/** Mild acceleration: 1 at slow drags (precise aim), up to 1 + accel for fast flicks (turns). */
export function lookGain(speed: number, cfg: LookConfig = LOOK): number {
  const t = Math.min(1, Math.max(0, (speed - cfg.v0) / (cfg.v1 - cfg.v0)));
  return 1 + cfg.accel * t * t * (3 - 2 * t);
}

export class LookTracker {
  pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  /** Smoothed swipe speed (CSS px/s). */
  speed = 0;

  constructor(readonly cfg: LookConfig = LOOK) {}

  get active(): boolean {
    return this.pointerId !== null;
  }

  start(id: number, x: number, y: number, t: number): boolean {
    if (this.pointerId !== null) return false;
    this.pointerId = id;
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;
    this.speed = 0;
    return true;
  }

  /** Look delta (mouse px) for this move, or null if the pointer is not ours. t in ms. */
  move(id: number, x: number, y: number, t: number, sensitivity: number): { dx: number; dy: number } | null {
    if (id !== this.pointerId) return null;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const dt = Math.max(1, t - this.lastT) / 1000;
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;
    const inst = Math.hypot(dx, dy) / dt;
    this.speed = this.speed * 0.5 + inst * 0.5;
    const k = this.cfg.base * sensitivity * lookGain(this.speed, this.cfg);
    return { dx: dx * k, dy: dy * k };
  }

  end(id: number): boolean {
    if (id !== this.pointerId) return false;
    this.pointerId = null;
    return true;
  }

  reset(): void {
    this.pointerId = null;
  }
}

export const AUTO_FIRE: Readonly<AutoFireConfig> = {
  /** Crosshair must rest on an enemy this long before the trigger is held (s). */
  dwell: 0.15,
  /** Brief loss of the target (strafing, recoil) keeps firing this long (s). */
  grace: 0.1,
};

export interface AutoFireWeapon {
  auto: boolean;
  /** Shots per second. */
  fireRate: number;
}

export class AutoFire {
  private onFor = 0;
  private offFor = Infinity;
  private sincePulse = Infinity;
  private pulseDown = false;
  firing = false;

  constructor(readonly cfg: AutoFireConfig = AUTO_FIRE) {}

  reset(): void {
    this.onFor = 0;
    this.offFor = Infinity;
    this.sincePulse = Infinity;
    this.pulseDown = false;
    this.firing = false;
  }

  /**
   * Advance by dt. Returns whether the virtual trigger should be down this frame.
   * Full-auto: held while firing. Semi-auto: down for one frame every 1 / fireRate seconds.
   */
  update(dt: number, onTarget: boolean, weapon: AutoFireWeapon | null, enabled: boolean): boolean {
    if (!enabled || !weapon) {
      this.reset();
      return false;
    }
    if (onTarget) {
      this.onFor += dt;
      this.offFor = 0;
    } else {
      this.offFor += dt;
      if (this.offFor > this.cfg.grace) this.onFor = 0;
    }
    this.firing = this.onFor >= this.cfg.dwell && this.offFor <= this.cfg.grace;
    if (!this.firing) {
      this.sincePulse = Infinity;
      this.pulseDown = false;
      return false;
    }
    if (weapon.auto) return true;
    this.sincePulse += dt;
    if (this.pulseDown) {
      this.pulseDown = false; // release so the next press is a new trigger pull
      return false;
    }
    if (this.sincePulse >= 1 / Math.max(0.1, weapon.fireRate)) {
      this.sincePulse = 0;
      this.pulseDown = true;
      return true;
    }
    return false;
  }
}

/** Key codes the stick drives. */
export const STICK_CODES = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft' } as const;
