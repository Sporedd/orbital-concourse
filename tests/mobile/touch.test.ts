/**
 * Touch → input mapping (src/mobile/touch.ts): stick dead zone, 8-way keys and the sprint ring,
 * look sensitivity + acceleration, auto-fire dwell / grace / fire-rate pulses.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_FIRE, AutoFire, FloatingStick, LOOK, LookTracker, STICK, lookGain, stickToKeys } from '@/mobile/touch';

const R = STICK.radius;

describe('stick', () => {
  it('dead zone: small offsets press nothing', () => {
    const k = stickToKeys(0, -R * STICK.deadZone * 0.9);
    expect(k).toEqual({ forward: false, back: false, left: false, right: false, sprint: false });
    expect(stickToKeys(0, -R * STICK.deadZone * 1.2).forward).toBe(true);
  });

  it('8-way directions (screen y grows downwards)', () => {
    expect(stickToKeys(0, -R)).toMatchObject({ forward: true, back: false, left: false, right: false });
    expect(stickToKeys(0, R)).toMatchObject({ forward: false, back: true });
    expect(stickToKeys(R, 0)).toMatchObject({ right: true, forward: false, back: false });
    expect(stickToKeys(-R, 0)).toMatchObject({ left: true });
    const diag = stickToKeys(R * 0.7, -R * 0.7);
    expect(diag).toMatchObject({ forward: true, right: true, left: false, back: false });
    // 15° off straight ahead is still pure forward (no strafe)
    const a = (15 * Math.PI) / 180;
    expect(stickToKeys(Math.sin(a) * R, -Math.cos(a) * R)).toMatchObject({ forward: true, right: false });
  });

  it('outer ring = sprint, only when pushing forward', () => {
    expect(stickToKeys(0, -R).sprint).toBe(false);
    expect(stickToKeys(0, -R * (STICK.sprintAt + 0.05)).sprint).toBe(true);
    expect(stickToKeys(0, R * 1.6).sprint).toBe(false); // backwards
    expect(stickToKeys(R * 1.6, 0).sprint).toBe(false); // sideways
  });

  it('floats: appears where the thumb lands and follows a thumb that slides far past the ring', () => {
    const s = new FloatingStick();
    expect(s.start(1, 100, 300)).toBe(true);
    expect(s.start(2, 50, 50)).toBe(false); // one pointer per stick
    expect(s.keys().forward).toBe(false);
    s.move(1, 100, 300 - R);
    expect(s.keys().forward).toBe(true);
    s.move(1, 100, 300 - R * 4);
    const { dy } = s.offset();
    expect(-dy).toBeCloseTo(R * STICK.followAt, 5);
    expect(s.originY).toBeLessThan(300);
    expect(s.keys().sprint).toBe(true);
    // the drawn knob stops at the sprint ring
    expect(Math.hypot(s.knob().dx, s.knob().dy)).toBeCloseTo(R * STICK.sprintAt, 5);
    expect(s.move(2, 0, 0)).toBe(false); // other pointers are ignored
    expect(s.end(1)).toBe(true);
    expect(s.keys().forward).toBe(false);
  });
});

describe('look', () => {
  it('gain is 1 for slow drags and rises smoothly to 1 + accel for flicks', () => {
    expect(lookGain(0)).toBe(1);
    expect(lookGain(LOOK.v0)).toBe(1);
    expect(lookGain(LOOK.v1)).toBeCloseTo(1 + LOOK.accel, 6);
    expect(lookGain(LOOK.v1 * 10)).toBeCloseTo(1 + LOOK.accel, 6);
    let prev = 0;
    for (let v = 0; v <= LOOK.v1; v += 50) {
      const g = lookGain(v);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(LOOK.accel).toBeLessThanOrEqual(1); // mild
  });

  it('slow drag: delta = pixels × base × sensitivity', () => {
    const t = new LookTracker();
    t.start(7, 500, 200, 0);
    const d = t.move(7, 502, 199, 100, 1)!; // 2 px in 100 ms: 22 px/s, no acceleration
    expect(d.dx).toBeCloseTo(2 * LOOK.base, 6);
    expect(d.dy).toBeCloseTo(-1 * LOOK.base, 6);
    const t2 = new LookTracker();
    t2.start(7, 500, 200, 0);
    const d2 = t2.move(7, 502, 199, 100, 2)!;
    expect(d2.dx).toBeCloseTo(d.dx * 2, 6);
  });

  it('fast swipes turn further per pixel; other pointers are ignored', () => {
    const t = new LookTracker();
    t.start(1, 0, 0, 0);
    let last = { dx: 0, dy: 0 };
    for (let i = 1; i <= 6; i++) last = t.move(1, i * 40, 0, i * 16, 1)!; // 2500 px/s
    expect(last.dx / 40).toBeGreaterThan(LOOK.base * 1.4);
    expect(t.move(2, 0, 0, 200, 1)).toBeNull();
  });
});

describe('auto-fire', () => {
  const rifle = { auto: true, fireRate: 10 };
  const pistol = { auto: false, fireRate: 4 };
  const run = (af: AutoFire, frames: number, onTarget: boolean, w = rifle, dt = 1 / 60, enabled = true) => {
    const out: boolean[] = [];
    for (let i = 0; i < frames; i++) out.push(af.update(dt, onTarget, w, enabled));
    return out;
  };

  it(`holds fire only after the crosshair rested ${AUTO_FIRE.dwell} s on a target`, () => {
    const af = new AutoFire();
    const dwellFrames = Math.round(AUTO_FIRE.dwell * 60);
    const out = run(af, dwellFrames + 3, true);
    expect(out.slice(0, dwellFrames - 1).every((v) => !v)).toBe(true);
    expect(out.slice(dwellFrames + 1).every((v) => v)).toBe(true);
  });

  it('keeps firing through a brief loss of the target, stops after the grace time', () => {
    const af = new AutoFire();
    run(af, 20, true);
    expect(run(af, Math.floor(AUTO_FIRE.grace * 60) - 1, false).every((v) => v)).toBe(true);
    expect(run(af, 10, false).at(-1)).toBe(false);
    // and the dwell starts over
    expect(run(af, 3, true).some((v) => v)).toBe(false);
  });

  it('disabled or no weapon: never fires', () => {
    expect(run(new AutoFire(), 60, true, rifle, 1 / 60, false).some((v) => v)).toBe(false);
    const af = new AutoFire();
    expect([...Array(60)].map(() => af.update(1 / 60, true, null, true)).some((v) => v)).toBe(false);
  });

  it('semi-auto guns: one trigger pull per shot interval (fire rate obeyed)', () => {
    const af = new AutoFire();
    const out = run(af, 60 * 3, true, pistol); // 3 s on target
    let presses = 0;
    for (let i = 0; i < out.length; i++) if (out[i] && !out[i - 1]) presses++;
    // ~ (3 - dwell) s × 4 shots/s, first shot at the end of the dwell
    expect(presses).toBeGreaterThanOrEqual(10);
    expect(presses).toBeLessThanOrEqual(12);
    // each pull is released the next frame (a new press every time)
    for (let i = 1; i < out.length; i++) expect(out[i] && out[i - 1]).toBe(false);
  });
});
