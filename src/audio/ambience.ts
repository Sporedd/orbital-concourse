/**
 * Looping wind: brown-noise body through a lowpass whose cutoff drifts with a slow LFO,
 * a quiet whistling band-passed white-noise layer that wanders in pitch and stereo,
 * plus random gusts scheduled from update().
 */
import type { AudioEngine } from './engine';
import { noiseBuffers } from './nodes';

const BODY_LEVEL = 0.55;
const BODY_CUTOFF = 420;
const WHISTLE_LEVEL = 0.07;

export class Wind {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private bodyGain: GainNode | null = null;
  private bodyFilter: BiquadFilterNode | null = null;
  private whistleGain: GainNode | null = null;
  private gustTimer = 3;
  private running = false;

  constructor(private eng: AudioEngine) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const ac = this.eng.ac;
    const now = ac.currentTime;
    const bufs = noiseBuffers(ac);
    const keep = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n);
      return n;
    };
    const src = <T extends AudioScheduledSourceNode>(n: T): T => {
      keep(n);
      this.sources.push(n);
      return n;
    };

    const out = keep(ac.createGain());
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + 3);
    out.connect(this.eng.ambience);

    // Body
    const body = src(ac.createBufferSource());
    body.buffer = bufs.brown;
    body.loop = true;
    const lp = keep(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = BODY_CUTOFF;
    lp.Q.value = 0.9;
    const bg = keep(ac.createGain());
    bg.gain.value = BODY_LEVEL;
    body.connect(lp);
    lp.connect(bg);
    bg.connect(out);
    const lfo = src(ac.createOscillator());
    lfo.frequency.value = 0.07;
    const lfoDepth = keep(ac.createGain());
    lfoDepth.gain.value = 180;
    lfo.connect(lfoDepth);
    lfoDepth.connect(lp.frequency);
    // Slow amplitude swell
    const amp = src(ac.createOscillator());
    amp.frequency.value = 0.045;
    const ampDepth = keep(ac.createGain());
    ampDepth.gain.value = BODY_LEVEL * 0.3;
    amp.connect(ampDepth);
    ampDepth.connect(bg.gain);

    // Whistle
    const wsrc = src(ac.createBufferSource());
    wsrc.buffer = bufs.white;
    wsrc.loop = true;
    const bp = keep(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 950;
    bp.Q.value = 7;
    const wg = keep(ac.createGain());
    wg.gain.value = WHISTLE_LEVEL;
    const pan = keep(ac.createStereoPanner());
    wsrc.connect(bp);
    bp.connect(wg);
    wg.connect(pan);
    pan.connect(out);
    const wl = src(ac.createOscillator());
    wl.frequency.value = 0.11;
    const wlDepth = keep(ac.createGain());
    wlDepth.gain.value = 320;
    wl.connect(wlDepth);
    wlDepth.connect(bp.frequency);
    const pl = src(ac.createOscillator());
    pl.frequency.value = 0.031;
    const plDepth = keep(ac.createGain());
    plDepth.gain.value = 0.5;
    pl.connect(plDepth);
    plDepth.connect(pan.pan);

    body.start(now, 0);
    wsrc.start(now, 1);
    lfo.start(now);
    amp.start(now);
    wl.start(now);
    pl.start(now);

    this.bodyGain = bg;
    this.bodyFilter = lp;
    this.whistleGain = wg;
  }

  update(dt: number): void {
    if (!this.running || !this.bodyGain || !this.bodyFilter || !this.whistleGain) return;
    this.gustTimer -= dt;
    if (this.gustTimer > 0) return;
    this.gustTimer = 4 + Math.random() * 8;
    const now = this.eng.ac.currentTime;
    const s = 0.3 + Math.random() * 0.7; // gust strength
    const rise = 0.6 + Math.random() * 0.8;
    const hold = 0.8 + Math.random() * 1.8;
    const ramp = (p: AudioParam, base: number, peak: number) => {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(peak, now, rise / 3);
      p.setTargetAtTime(base, now + rise + hold, 0.9);
    };
    ramp(this.bodyGain.gain, BODY_LEVEL, BODY_LEVEL * (1 + 0.9 * s));
    ramp(this.bodyFilter.frequency, BODY_CUTOFF, BODY_CUTOFF + 700 * s);
    ramp(this.whistleGain.gain, WHISTLE_LEVEL, WHISTLE_LEVEL * (1 + 2 * s));
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.sources = [];
    this.running = false;
    this.bodyGain = this.bodyFilter = null;
    this.whistleGain = null;
  }
}
