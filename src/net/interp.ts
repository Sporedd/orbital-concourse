/**
 * Snapshot interpolation helpers: a clock offset estimator (sender time ↔ local time) and a
 * small per-entity sample buffer that is rendered `delay` seconds in the past.
 */

/** Interpolation delay (render this far behind the newest sender time). */
export const INTERP_DELAY = 0.1;

export const nowSeconds = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

/**
 * Estimates `localTime - senderTime` from message timestamps. Uses the smallest observed
 * offset (= the least-delayed packet) over a sliding window, so jitter only ever delays.
 */
export class ClockSync {
  private offset = NaN;
  private windowMin = Infinity;
  private windowStart = 0;

  observe(senderTime: number, localNow = nowSeconds()): void {
    const o = localNow - senderTime;
    if (Number.isNaN(this.offset)) {
      this.offset = o;
      this.windowStart = localNow;
    }
    this.windowMin = Math.min(this.windowMin, o);
    // Faster packets show up immediately; slow drift (clock skew / route change) is
    // tracked by re-basing on the window minimum every 2 s.
    if (o < this.offset) this.offset = o;
    if (localNow - this.windowStart > 2) {
      this.offset += (this.windowMin - this.offset) * 0.5;
      this.windowMin = Infinity;
      this.windowStart = localNow;
    }
  }

  get ready(): boolean {
    return !Number.isNaN(this.offset);
  }

  /** Sender-clock time that corresponds to `localNow`. */
  senderNow(localNow = nowSeconds()): number {
    return Number.isNaN(this.offset) ? 0 : localNow - this.offset;
  }

  /** Sender-clock time to render at (now minus the interpolation delay). */
  renderTime(delay = INTERP_DELAY, localNow = nowSeconds()): number {
    return this.senderNow(localNow) - delay;
  }
}

export interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const lerpAngle = (a: number, b: number, t: number) => a + wrap(b - a) * t;

/** Position/orientation samples for one entity; sampled at a render time with linear interpolation. */
export class SampleBuffer {
  private readonly samples: Sample[] = [];

  constructor(private readonly capacity = 12) {}

  push(t: number, x: number, y: number, z: number, yaw: number, pitch = 0): void {
    const s = this.samples;
    // ignore out-of-order / duplicate timestamps
    if (s.length && t <= s[s.length - 1].t) {
      const last = s[s.length - 1];
      if (t === last.t) Object.assign(last, { x, y, z, yaw, pitch });
      return;
    }
    s.push({ t, x, y, z, yaw, pitch });
    if (s.length > this.capacity) s.shift();
  }

  get size(): number {
    return this.samples.length;
  }

  latest(): Sample | undefined {
    return this.samples[this.samples.length - 1];
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Interpolated sample at time t (clamped to the buffer; short extrapolation up to `maxExtrap`). */
  sample(t: number, out: Sample, maxExtrap = 0.1): Sample | null {
    const s = this.samples;
    if (!s.length) return null;
    if (s.length === 1 || t <= s[0].t) {
      Object.assign(out, s[0]);
      out.t = t;
      return out;
    }
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (t >= a.t && t <= b.t) {
        const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        out.t = t;
        out.x = a.x + (b.x - a.x) * k;
        out.y = a.y + (b.y - a.y) * k;
        out.z = a.z + (b.z - a.z) * k;
        out.yaw = lerpAngle(a.yaw, b.yaw, k);
        out.pitch = a.pitch + (b.pitch - a.pitch) * k;
        return out;
      }
    }
    // t is newer than the newest sample: extrapolate a little along the last segment
    const a = s[s.length - 2];
    const b = s[s.length - 1];
    const dt = Math.min(t - b.t, maxExtrap);
    const span = Math.max(1e-3, b.t - a.t);
    out.t = t;
    out.x = b.x + ((b.x - a.x) / span) * dt;
    out.y = b.y + ((b.y - a.y) / span) * dt;
    out.z = b.z + ((b.z - a.z) / span) * dt;
    out.yaw = b.yaw;
    out.pitch = b.pitch;
    return out;
  }
}

export const makeSample = (): Sample => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
