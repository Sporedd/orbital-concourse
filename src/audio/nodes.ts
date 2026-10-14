/**
 * Low-level Web Audio plumbing shared by SFX, music and ambience:
 * - NodeGroup: owns the nodes of one sound/note and disconnects them all once every source has ended.
 * - Pre-rendered noise buffers (one per AudioContext, never allocated per call).
 * - Cached waveshaper curves for saturation.
 */

type ShaperCurve = NonNullable<WaveShaperNode['curve']>;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Tracks the nodes of one sound; disconnects them when all scheduled sources have ended. */
export class NodeGroup {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Latest scheduled stop time of any source (AudioContext time). */
  end = 0;
  disposed = false;
  onDispose: (() => void) | null = null;
  private live = 0;

  constructor(readonly ac: BaseAudioContext) {}

  node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(value = 1): GainNode {
    const g = this.node(this.ac.createGain());
    g.gain.value = value;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.node(this.ac.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  shaper(amount: number): WaveShaperNode {
    const s = this.node(this.ac.createWaveShaper());
    s.curve = driveCurve(amount);
    return s;
  }

  /** Register + schedule a source. Its end triggers cleanup once every source is done. */
  source(src: AudioScheduledSourceNode, t0: number, t1: number, offset?: number): void {
    this.node(src);
    this.sources.push(src);
    this.live++;
    src.onended = () => {
      this.live--;
      if (this.live <= 0) this.dispose();
    };
    if (offset !== undefined && src instanceof AudioBufferSourceNode) src.start(t0, offset);
    else src.start(t0);
    src.stop(t1);
    if (t1 > this.end) this.end = t1;
  }

  /** Stop everything at time t (already-scheduled stops later than t are overridden). */
  stopAll(t: number): void {
    for (const s of this.sources) {
      try {
        s.stop(t);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Call after building: a group with no sources would never be cleaned up otherwise. */
  finalize(): void {
    if (this.live <= 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    const cb = this.onDispose;
    this.onDispose = null;
    cb?.();
  }
}

// ---------------------------------------------------------------------------
// Noise buffers (2 s, rendered once per context)
// ---------------------------------------------------------------------------
export interface NoiseBuffers {
  white: AudioBuffer;
  brown: AudioBuffer;
}

const noiseCache = new WeakMap<BaseAudioContext, NoiseBuffers>();

export function noiseBuffers(ac: BaseAudioContext): NoiseBuffers {
  let b = noiseCache.get(ac);
  if (b) return b;
  const len = Math.floor(ac.sampleRate * 2);
  const white = ac.createBuffer(1, len, ac.sampleRate);
  const brown = ac.createBuffer(1, len, ac.sampleRate);
  const w = white.getChannelData(0);
  const br = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const r = Math.random() * 2 - 1;
    w[i] = r;
    last = (last + 0.02 * r) / 1.02;
    br[i] = last;
  }
  // Detrend so the loop point is seamless (no click every 2 s in the wind), then normalise.
  const drift = br[len - 1] - br[0];
  let peak = 1e-6;
  for (let i = 0; i < len; i++) {
    br[i] -= (drift * i) / (len - 1);
    peak = Math.max(peak, Math.abs(br[i]));
  }
  const norm = 0.9 / peak;
  for (let i = 0; i < len; i++) br[i] *= norm;
  b = { white, brown };
  noiseCache.set(ac, b);
  return b;
}

// ---------------------------------------------------------------------------
// Saturation curves
// ---------------------------------------------------------------------------
const curveCache = new Map<number, ShaperCurve>();

export function driveCurve(amount: number): ShaperCurve {
  const k = Math.max(0.5, Math.round(amount * 2) / 2);
  let c = curveCache.get(k);
  if (c) return c;
  const n = 1024;
  c = new Float32Array(n) as ShaperCurve;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  curveCache.set(k, c);
  return c;
}
