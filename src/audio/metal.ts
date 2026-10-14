/**
 * Metal instrument rig for the music: a per-track set of persistent signal chains (guitar amp,
 * bass amp, drum bus, lead amp, FX/ambient buses, sidechain duck, dotted-8th delay, reverb send)
 * plus per-note helpers that only create a handful of oscillators/gains per hit and reuse the
 * cached noise buffers, waveshaper curves and reverb impulse.
 *
 *   chug/power oscs ─▶ note LP ─▶ env ─▶ gtr ─▶ tight HP ─▶ drive ─▶ asym clip ─▶ DC HP ─▶ cab EQ/LP ─┬▶ L ─┐
 *                                                                                                  └▶ 13 ms ▶ R ─┤
 *   bass oscs ─▶ env ─▶ bass drive ─▶ tanh ─▶ LP ───────────────────────────────────────────────────────────────┤
 *   djent sub sines ────────────────────────────────────────────────────────────────────────────────────────────┴▶ duck ─▶ dry
 *   kick/snare/hats ─▶ drum bus ─▶ tanh ─▶ dry (+ verb)        cymbals ─▶ dry (+ verb)
 *   lead oscs ─▶ env ─▶ lead drive ─▶ asym clip ─▶ LP ─▶ dry (+ delay + verb)
 *   drones/swells/risers/clanks ─▶ amb/fx ─▶ dry (+ delay + verb)
 *
 * Every kick pulls the `duck` gain down for a few tens of ms (sidechain-style pumping of
 * guitars + bass under the kick).
 */
import { NodeGroup, driveCurve, midiToFreq } from './nodes';
import { fm, noise, sustainEnv, tone } from './synth';

type Curve = NonNullable<WaveShaperNode['curve']>;

// ---------------------------------------------------------------------------
// Cached curves / buffers
// ---------------------------------------------------------------------------
let ampC: Curve | null = null;
/** Asymmetric clipper: soft positive half, harder/lower negative half (even harmonics, "amp" grit). */
export function ampCurve(): Curve {
  if (ampC) return ampC;
  const n = 2048;
  const c = new Float32Array(n) as Curve;
  const pn = Math.tanh(2.5);
  const nn = Math.tanh(5);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = x >= 0 ? Math.tanh(2.5 * x) / pn : (0.82 * Math.tanh(5 * x)) / nn;
  }
  ampC = c;
  return c;
}

let tapeC: Curve | null = null;
/** Bus saturation: fed at half level, so out = tanh(in) for |in| ≤ 2. */
export function tapeCurve(): Curve {
  if (tapeC) return tapeC;
  const n = 2048;
  const c = new Float32Array(n) as Curve;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(2 * x);
  }
  tapeC = c;
  return c;
}

/** Ceiling input scale: the curve spans ±CEIL_RANGE of input. */
export const CEIL_RANGE = 1.5;
let ceilC: Curve | null = null;
/** Final safety clipper: linear to 0.7, then a soft knee that never exceeds 0.88. */
export function ceilingCurve(): Curve {
  if (ceilC) return ceilC;
  const n = 4096;
  const c = new Float32Array(n) as Curve;
  for (let i = 0; i < n; i++) {
    const v = ((i / (n - 1)) * 2 - 1) * CEIL_RANGE;
    const a = Math.abs(v);
    const y = a < 0.7 ? a : 0.7 + 0.18 * Math.tanh((a - 0.7) / 0.18);
    c[i] = Math.sign(v) * y;
  }
  ceilC = c;
  return c;
}

const irCache = new WeakMap<BaseAudioContext, AudioBuffer>();
/** Dark industrial-hall impulse: 2.6 s stereo noise tail, increasingly damped, rendered once per context. */
export function reverbIR(ac: BaseAudioContext): AudioBuffer {
  const hit = irCache.get(ac);
  if (hit) return hit;
  const sr = ac.sampleRate;
  const len = Math.floor(sr * 2.6);
  const pre = Math.floor(sr * 0.018);
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = pre; i < len; i++) {
      const tt = (i - pre) / sr;
      const a = 0.55 * Math.exp(-tt * 2.2) + 0.06; // damping grows over the tail
      y += a * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp((-6.9 * tt) / 2.6);
    }
  }
  irCache.set(ac, buf);
  return buf;
}


// ---------------------------------------------------------------------------
// Cached one-shot renders for the high-rate hits (chugs, short bass notes, kick). Each distinct
// (pitch, length, filter) combination is rendered once per context into a small mono buffer
// (about 0.1 s) and replayed through a gain, so a 16th-note double-kick/chug stream costs two
// nodes per hit instead of a dozen automated oscillators/filters.
// ---------------------------------------------------------------------------
const hitCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const MAX_HITS = 256;

function cachedHit(ac: BaseAudioContext, key: string, dur: number, fill: (d: Float32Array, sr: number) => void): AudioBuffer {
  let m = hitCache.get(ac);
  if (!m) {
    m = new Map();
    hitCache.set(ac, m);
  }
  let b = m.get(key);
  if (!b) {
    b = ac.createBuffer(1, Math.max(1, Math.ceil(dur * ac.sampleRate)), ac.sampleRate);
    fill(b.getChannelData(0), ac.sampleRate);
    if (m.size >= MAX_HITS) {
      const first = m.keys().next();
      if (!first.done) m.delete(first.value);
    }
    m.set(key, b);
  }
  return b;
}

/** PolyBLEP residual (band-limits saw/square edges). */
function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
const saw = (p: number, dt: number): number => 2 * p - 1 - blep(p, dt);
const sqr = (p: number, dt: number): number => (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt);

/** RBJ biquad (low-pass or band-pass) as a tiny stateful filter for offline renders. */
class Bq {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private sr: number, private band = false) {}
  set(fc: number, q: number): void {
    const w = (2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    if (this.band) {
      this.b0 = al / a0;
      this.b1 = 0;
      this.b2 = -al / a0;
    } else {
      this.b0 = (1 - cs) / 2 / a0;
      this.b1 = (1 - cs) / a0;
      this.b2 = this.b0;
    }
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const LN_MIN = Math.log(1e-4);
/** Same shape as synth.envelope(): linear attack to 1, exponential fall to 1e-4 at `dur`. */
function envAt(t: number, attack: number, dur: number): number {
  if (t < attack) return t / attack;
  if (t >= dur) return 0;
  return Math.exp((LN_MIN * (t - attack)) / (dur - attack));
}
const cents = (c: number): number => Math.pow(2, c / 1200);

/** Palm-mute chug body (pre-amp): detuned saw pair + square an octave down through a closing LP. */
function chugBuffer(ac: BaseAudioContext, midi: number, len: number, cutoff: number): AudioBuffer {
  return cachedHit(ac, `c${midi}|${len.toFixed(3)}|${cutoff}`, len + 0.01, (d, sr) => {
    const f = midiToFreq(midi);
    const dt1 = (f * cents(-7)) / sr;
    const dt2 = (f * cents(6)) / sr;
    const dt3 = f / 2 / sr;
    let p1 = 0;
    let p2 = 0.31;
    let p3 = 0;
    const lp = new Bq(sr);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      if ((i & 15) === 0) lp.set(t < 0.025 ? cutoff * 1.8 * Math.pow(1 / 1.8, t / 0.025) : cutoff, 1.4);
      const x = saw(p1, dt1) + saw(p2, dt2) + 0.45 * sqr(p3, dt3);
      p1 = (p1 + dt1) % 1;
      p2 = (p2 + dt2) % 1;
      p3 = (p3 + dt3) % 1;
      d[i] = lp.run(x) * envAt(t, 0.002, len) * 0.5;
    }
  });
}

/** Sine with 5 ms attack and exponential decay (djent sub layer). */
function subBuffer(ac: BaseAudioContext, f: number, dur: number): AudioBuffer {
  return cachedHit(ac, `s${f.toFixed(2)}|${dur.toFixed(3)}`, dur + 0.005, (d, sr) => {
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * f * t) * envAt(t, 0.005, dur);
    }
  });
}

/** Short bass note: saw + slightly detuned square. */
function bassBuffer(ac: BaseAudioContext, midi: number, len: number): AudioBuffer {
  return cachedHit(ac, `b${midi}|${len.toFixed(3)}`, len + 0.005, (d, sr) => {
    const f = midiToFreq(midi);
    const dt1 = f / sr;
    const dt2 = (f * cents(9)) / sr;
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < d.length; i++) {
      d[i] = (saw(p1, dt1) + sqr(p2, dt2)) * envAt(i / sr, 0.003, len) * 0.4;
      p1 = (p1 + dt1) % 1;
      p2 = (p2 + dt2) % 1;
    }
  });
}

/** Kick body: sine dropping 175 -> 48 Hz in 45 ms plus a short triangle knock. */
function kickBuffer(ac: BaseAudioContext): AudioBuffer {
  return cachedHit(ac, 'kick', 0.33, (d, sr) => {
    let ph = 0;
    let pk = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const f = t < 0.045 ? 175 * Math.pow(48 / 175, t / 0.045) : 48;
      ph += f / sr;
      const fk = t < 0.025 ? 420 * Math.pow(110 / 420, t / 0.025) : 110;
      pk += fk / sr;
      const tri = 1 - 4 * Math.abs((pk % 1) - 0.5);
      d[i] = Math.sin(2 * Math.PI * ph) * envAt(t, 0.001, 0.32) * 0.85 + tri * envAt(t, 0.002, 0.03) * 0.18;
    }
  });
}

/** Beater click: band-passed noise, 7 ms. */
function clickBuffer(ac: BaseAudioContext): AudioBuffer {
  return cachedHit(ac, 'click', 0.01, (d, sr) => {
    const bp = new Bq(sr, true);
    bp.set(3600, 0.7);
    for (let i = 0; i < d.length; i++) d[i] = bp.run(Math.random() * 2 - 1) * envAt(i / sr, 0.001, 0.007) * 0.9;
  });
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------
export interface RigOpts {
  /** Guitar amp output level. */
  gtr: number;
  /** Guitar reverb send. */
  gtrVerb: number;
  /** Guitar cab low-pass (Hz) — lower = darker / more distant. */
  cab: number;
  bass: number;
  drums: number;
  lead: number;
  /** Ambient/FX reverb send. */
  fxVerb: number;
  /** Feedback-delay time (s). */
  delay: number;
}

export interface PowerOpts {
  /** Intervals above the root (semitones). Default power chord [0, 7, 12]. */
  iv?: number[];
  /** Fraction of the note after which it dive-bombs (0 = no dive). */
  dive?: number;
  /** Note-filter cutoff. */
  cutoff?: number;
}

export interface LeadOpts {
  /** Slide into the note from this many semitones away. */
  slide?: number;
  /** Vibrato depth in cents (fades in). */
  vib?: number;
}

export class Rig {
  /** Persistent nodes (disconnected when the track is torn down). */
  readonly nodes: AudioNode[] = [];
  private dry: GainNode;
  private wet: GainNode;
  private verb: GainNode;
  private gtr: GainNode;
  private bassIn: GainNode;
  private duckG: GainNode;
  private drumBus: GainNode;
  private cym: GainNode;
  private leadIn: GainNode;
  private fx: GainNode;
  private amb: GainNode;

  constructor(readonly ac: BaseAudioContext, out: AudioNode, verbOut: AudioNode, o: RigOpts) {
    this.dry = this.gain(1, out);
    this.verb = this.gain(1, verbOut);

    // Dotted-8th style feedback delay (dark).
    this.wet = this.gain(1);
    const delay = this.mk(ac.createDelay(2));
    delay.delayTime.value = o.delay;
    const damp = this.biquad('lowpass', 1700, 0.7);
    const fb = this.gain(0.34);
    const wetOut = this.gain(0.4, this.dry);
    this.wet.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wetOut);

    this.duckG = this.gain(1, this.dry);

    // Guitar amp.
    this.gtr = this.gain(1);
    const tight = this.biquad('highpass', 100, 0.7);
    const push = this.biquad('peaking', 900, 0.8); // tube-screamer style mid push into the clipper
    push.gain.value = 6;
    const drive = this.gain(7);
    const clip = this.mk(ac.createWaveShaper());
    clip.curve = ampCurve();
    clip.oversample = '2x';
    const post = this.biquad('highpass', 80, 0.9);
    const body = this.biquad('peaking', 190, 1);
    body.gain.value = 1;
    const scoop = this.biquad('peaking', 520, 1);
    scoop.gain.value = -3;
    const pres = this.biquad('peaking', 2600, 0.8);
    pres.gain.value = 8;
    const cab = this.biquad('lowpass', o.cab, 1);
    const cab2 = this.biquad('lowpass', o.cab * 1.4, 0.7);
    const gOut = this.gain(o.gtr);
    chain(this.gtr, tight, push, drive, clip, post, body, scoop, pres, cab, cab2, gOut);
    // Double-tracked width: dry hard left, 13 ms copy hard right.
    const panL = this.mk(ac.createStereoPanner());
    panL.pan.value = -1;
    const haas = this.mk(ac.createDelay(0.05));
    haas.delayTime.value = 0.013;
    const panR = this.mk(ac.createStereoPanner());
    panR.pan.value = 1;
    gOut.connect(panL);
    panL.connect(this.duckG);
    gOut.connect(haas);
    haas.connect(panR);
    panR.connect(this.duckG);
    if (o.gtrVerb > 0) gOut.connect(this.gain(o.gtrVerb, this.verb));

    // Bass amp.
    this.bassIn = this.gain(2.6);
    const bClip = this.mk(ac.createWaveShaper());
    bClip.curve = driveCurve(2);
    const bLp = this.biquad('lowpass', 520, 0.9);
    const bOut = this.gain(o.bass, this.duckG);
    chain(this.bassIn, bClip, bLp, bOut);

    // Drums.
    this.drumBus = this.gain(1);
    const dClip = this.mk(ac.createWaveShaper());
    dClip.curve = driveCurve(1.5);
    const dOut = this.gain(o.drums, this.dry);
    chain(this.drumBus, dClip, dOut);
    dOut.connect(this.gain(0.12, this.verb));
    this.cym = this.gain(o.drums, this.dry);
    this.cym.connect(this.gain(0.35, this.verb));

    // Lead amp.
    this.leadIn = this.gain(5);
    const lClip = this.mk(ac.createWaveShaper());
    lClip.curve = driveCurve(3);
    lClip.oversample = '2x';
    const lHp = this.biquad('highpass', 180, 0.9);
    const lLp = this.biquad('lowpass', 3300, 2);
    const lOut = this.gain(o.lead, this.dry);
    chain(this.leadIn, lClip, lHp, lLp, lOut);
    lOut.connect(this.gain(0.45, this.wet));
    lOut.connect(this.gain(0.35, this.verb));

    // FX (clanks, risers): dry + delay + verb. Ambient (drones, swells): dry + verb.
    this.fx = this.gain(1, this.dry);
    this.fx.connect(this.gain(0.4, this.wet));
    this.fx.connect(this.gain(o.fxVerb, this.verb));
    this.amb = this.gain(1, this.dry);
    this.amb.connect(this.gain(o.fxVerb * 0.8, this.verb));
  }

  // -- persistent-node helpers ----------------------------------------------
  private mk<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private gain(v: number, dest?: AudioNode): GainNode {
    const g = this.mk(this.ac.createGain());
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  private biquad(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const b = this.mk(this.ac.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  private osc(g: NodeGroup, type: OscillatorType, f: number, detune: number, dest: AudioNode, t: number, end: number): OscillatorNode {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.detune.value = detune;
    o.connect(dest);
    g.source(o, t, end);
    return o;
  }

  /** Sidechain-style dip of guitars + bass. */
  duck(t: number, depth: number): void {
    const p = this.duckG.gain;
    p.setTargetAtTime(1 - depth, t, 0.004);
    p.setTargetAtTime(1, t + 0.03, 0.07);
  }

  // -- guitar ------------------------------------------------------------------
  /** Palm-muted chug: detuned saw pair + square an octave down, closed filter, 10–90 ms decay, djent sub. */
  chug(midi: number, t: number, len: number, vel: number, cutoff = 800, sub = 0.18): void {
    this.play(chugBuffer(this.ac, midi, len, Math.round(cutoff)), t, vel, this.gtr);
    if (sub > 0) this.play(subBuffer(this.ac, midiToFreq(midi) / 2, len + 0.07), t, vel * sub, this.duckG);
  }

  /** Replay a cached one-shot. */
  private play(buf: AudioBuffer, t: number, vel: number, dest: AudioNode, rate = 1): void {
    const g = new NodeGroup(this.ac);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const v = g.gain(vel);
    src.connect(v);
    v.connect(dest);
    g.source(src, t, t + buf.duration / rate + 0.01);
  }

  /** Open (gated) power chord; optional dive-bomb over the tail. */
  power(midi: number, t: number, len: number, vel: number, o: PowerOpts = {}): void {
    const g = new NodeGroup(this.ac);
    const f = midiToFreq(midi);
    const iv = o.iv ?? [0, 7, 12];
    const cut = o.cutoff ?? 2600;
    const lp = g.filter('lowpass', cut * 1.4, 0.9);
    lp.frequency.setValueAtTime(cut * 1.4, t);
    lp.frequency.exponentialRampToValueAtTime(cut, t + Math.min(0.3, len));
    const env = sustainEnv(g, t, 0.003, (vel * 0.5) / Math.sqrt(iv.length * 0.5 + 0.5), len, Math.min(0.06, len * 0.25));
    lp.connect(env);
    env.connect(this.gtr);
    const end = t + len + 0.03;
    const oscs: [OscillatorNode, number][] = [];
    iv.forEach((s, i) => {
      const fi = f * Math.pow(2, s / 12);
      oscs.push([this.osc(g, 'sawtooth', fi, i === 0 ? -7 : 4, lp, t, end), fi]);
      if (i === 0) oscs.push([this.osc(g, 'sawtooth', fi, 7, lp, t, end), fi]);
    });
    const sq = g.gain(0.4);
    sq.connect(lp);
    oscs.push([this.osc(g, 'square', f / 2, 0, sq, t, end), f / 2]);
    const sub = tone(g, this.duckG, { f: f / 2, t, dur: len + 0.05, peak: vel * 0.16, attack: 0.005, hold: len * 0.6 });
    oscs.push([sub.osc, f / 2]);
    if (o.dive && o.dive > 0) {
      const t0 = t + len * o.dive;
      for (const [os, fi] of oscs) {
        os.frequency.setValueAtTime(fi, t0);
        os.frequency.exponentialRampToValueAtTime(fi * 0.22, t + len);
      }
    }
  }

  // -- bass ----------------------------------------------------------------------
  bass(midi: number, t: number, len: number, vel: number): void {
    if (len < 0.2) {
      this.play(bassBuffer(this.ac, midi, Math.round(len * 200) / 200), t, vel, this.bassIn);
      return;
    }
    const g = new NodeGroup(this.ac);
    const f = midiToFreq(midi);
    const env = sustainEnv(g, t, 0.004, vel * 0.4, len, 0.05);
    env.connect(this.bassIn);
    const end = t + len + 0.03;
    this.osc(g, 'sawtooth', f, 0, env, t, end);
    this.osc(g, 'square', f, 9, env, t, end);
  }

  sub(midi: number, t: number, len: number, vel: number): void {
    const g = new NodeGroup(this.ac);
    const env = sustainEnv(g, t, 0.01, vel, len, Math.min(1, len * 0.5));
    env.connect(this.duckG);
    this.osc(g, 'sine', midiToFreq(midi), 0, env, t, t + len + 0.03);
  }

  // -- lead ----------------------------------------------------------------------
  lead(midi: number, t: number, len: number, vel: number, o: LeadOpts = {}): void {
    const g = new NodeGroup(this.ac);
    const f = midiToFreq(midi);
    const env = sustainEnv(g, t, 0.012, vel * 0.3, len, Math.min(0.1, len * 0.3));
    env.connect(this.leadIn);
    const end = t + len + 0.03;
    const a = this.osc(g, 'sawtooth', f, -9, env, t, end);
    const b = this.osc(g, 'sawtooth', f, 9, env, t, end);
    const sq = g.gain(0.5);
    sq.connect(env);
    const c = this.osc(g, 'square', f / 2, 0, sq, t, end);
    if (o.slide) {
      const from = f * Math.pow(2, o.slide / 12);
      for (const os of [a, b]) {
        os.frequency.setValueAtTime(from, t);
        os.frequency.exponentialRampToValueAtTime(f, t + 0.07);
      }
      c.frequency.setValueAtTime(from / 2, t);
      c.frequency.exponentialRampToValueAtTime(f / 2, t + 0.07);
    }
    if (o.vib) {
      const l = this.ac.createOscillator();
      l.frequency.value = 5.6;
      const d = g.gain(0);
      d.gain.setValueAtTime(0, t);
      d.gain.linearRampToValueAtTime(0, t + len * 0.25);
      d.gain.linearRampToValueAtTime(o.vib, t + len * 0.7);
      l.connect(d);
      d.connect(a.detune);
      d.connect(b.detune);
      d.connect(c.detune);
      g.source(l, t, end);
    }
  }

  /** Guitar-feedback squeal: near-pure tone through the lead amp, swelling in with vibrato. */
  feedback(midi: number, t: number, len: number, vel: number): void {
    const g = new NodeGroup(this.ac);
    const f = midiToFreq(midi);
    const env = g.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel * 0.25, t + len * 0.45);
    env.gain.setValueAtTime(vel * 0.25, t + len * 0.7);
    env.gain.linearRampToValueAtTime(0, t + len);
    env.connect(this.leadIn);
    const end = t + len + 0.03;
    const a = this.osc(g, 'sine', f, 0, env, t, end);
    const h = g.gain(0.3);
    h.connect(env);
    const b = this.osc(g, 'triangle', f * 2, 3, h, t, end);
    const l = this.ac.createOscillator();
    l.frequency.value = 4.8;
    const d = g.gain(22);
    l.connect(d);
    d.connect(a.detune);
    d.connect(b.detune);
    g.source(l, t, end);
  }

  // -- drums ---------------------------------------------------------------------
  kick(t: number, vel: number, duck = 0.5, click = 1, pitch = 1): void {
    this.play(kickBuffer(this.ac), t, vel, this.drumBus, pitch);
    if (click > 0) this.play(clickBuffer(this.ac), t, vel * 0.5 * click, this.drumBus);
    if (duck > 0) this.duck(t, duck);
  }

  snare(t: number, vel: number): void {
    const g = new NodeGroup(this.ac);
    noise(g, this.drumBus, { t, dur: 0.22, peak: vel * 0.9, type: 'bandpass', f: 2100, q: 0.5 });
    noise(g, this.drumBus, { t, dur: 0.09, peak: vel * 0.5, type: 'highpass', f: 3800 });
    tone(g, this.drumBus, { type: 'triangle', f: 230, f2: 175, t, dur: 0.07, peak: vel * 0.4 });
  }

  hat(t: number, vel: number): void {
    const g = new NodeGroup(this.ac);
    noise(g, this.cym, { t, dur: 0.028, peak: vel * 0.4, type: 'highpass', f: 8500 });
  }

  /** Crash-like wash. */
  crash(t: number, vel: number, dur = 2.2): void {
    const g = new NodeGroup(this.ac);
    noise(g, this.cym, { t, dur, peak: vel * 0.42, type: 'highpass', f: 3800, f2: 2100, sweep: dur });
    noise(g, this.cym, { t, dur: dur * 0.6, peak: vel * 0.2, type: 'bandpass', f: 5400, q: 3 });
  }

  tom(t: number, midi: number, vel: number): void {
    const g = new NodeGroup(this.ac);
    const f = midiToFreq(midi);
    tone(g, this.drumBus, { f: f * 1.6, f2: f, glide: 0.05, t, dur: 0.38, peak: vel * 0.75 });
    noise(g, this.drumBus, { t, dur: 0.05, peak: vel * 0.2, type: 'lowpass', f: 900 });
  }

  // -- textures ------------------------------------------------------------------
  /** Metallic FM clank (inharmonic ratio, fast index decay) with a noise scrape. */
  clank(t: number, vel: number, f: number, ratio: number): void {
    const g = new NodeGroup(this.ac);
    fm(g, this.fx, { f, ratio, index: 7, index2: 0.25, t, dur: 0.8, peak: vel * 0.6, attack: 0.001 });
    fm(g, this.fx, { f: f * 2.13, ratio: ratio * 1.07, index: 3, index2: 0.1, t, dur: 0.45, peak: vel * 0.3, attack: 0.001 });
    noise(g, this.fx, { t, dur: 0.06, peak: vel * 0.4, type: 'bandpass', f: Math.min(9000, f * 6), q: 6 });
  }

  /** Low distorted drone with a slow filter LFO. */
  drone(notes: number[], t: number, dur: number, vol: number, detune = 10, cutoff = 260): void {
    const g = new NodeGroup(this.ac);
    const pre = g.gain(0.3);
    const lp = g.filter('lowpass', cutoff, 3);
    const sh = g.shaper(2.5);
    const att = Math.min(2.5, dur * 0.3);
    const env = sustainEnv(g, t, att, vol / Math.sqrt(notes.length), dur, Math.min(2.5, dur * 0.3));
    chain(pre, lp, sh, env, this.amb);
    const l = this.ac.createOscillator();
    l.frequency.value = 0.09 + Math.random() * 0.06;
    const ld = g.gain(cutoff * 0.55);
    l.connect(ld);
    ld.connect(lp.frequency);
    const end = t + dur + 0.05;
    g.source(l, t, end);
    for (const n of notes) {
      for (const det of [-detune, detune]) this.osc(g, 'sawtooth', midiToFreq(n), det, pre, t, end);
    }
  }

  /** Industrial noise swell: filtered noise rising then decaying (q high = metallic groan). */
  swell(t: number, dur: number, vol: number, f1: number, f2: number, q = 2, brown = true): void {
    const g = new NodeGroup(this.ac);
    noise(g, this.amb, { t, dur, attack: dur * 0.6, peak: vol, type: 'bandpass', f: f1, f2, sweep: dur, q, brown });
  }

  /** Riser into a phrase change: noise sweeping up + a rising distorted tone, cut at the end. */
  riser(t: number, dur: number, vol: number, from = 38): void {
    const g = new NodeGroup(this.ac);
    noise(g, this.fx, { t, dur, attack: dur * 0.96, peak: vol, type: 'bandpass', f: 250, f2: 7000, sweep: dur, q: 1.2 });
    const lp = g.filter('lowpass', 400, 4);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(3000, t + dur);
    lp.connect(this.fx);
    tone(g, lp, { type: 'sawtooth', f: midiToFreq(from), f2: midiToFreq(from + 24), glide: dur, t, dur, attack: dur * 0.95, peak: vol * 0.35 });
  }
}

function chain(...n: AudioNode[]): void {
  for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]);
}
