/**
 * Synth building blocks. Every helper registers its nodes in a NodeGroup (so they are
 * disconnected when done) and connects its output to `dest`.
 */
import { NodeGroup, noiseBuffers } from './nodes';

const MIN = 0.0001;

/** Gain node with a percussive envelope: 0 → peak (attack) → hold → exp decay to silence at t+dur. */
export function envelope(
  g: NodeGroup, t: number, attack: number, peak: number, dur: number, hold = 0,
): GainNode {
  const e = g.gain(0);
  const p = Math.max(peak, MIN * 2);
  const a = Math.max(attack, 0.001);
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(p, t + a);
  if (hold > 0) e.gain.setValueAtTime(p, t + a + hold);
  e.gain.exponentialRampToValueAtTime(MIN, t + Math.max(dur, a + hold + 0.005));
  return e;
}

/** Gain with linear attack, sustain, linear release (pads, drones). */
export function sustainEnv(
  g: NodeGroup, t: number, attack: number, level: number, dur: number, release: number,
): GainNode {
  const e = g.gain(0);
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(level, t + attack);
  e.gain.setValueAtTime(level, t + Math.max(attack, dur - release));
  e.gain.linearRampToValueAtTime(0, t + dur);
  return e;
}

export interface ToneOpts {
  type?: OscillatorType;
  f: number;
  /** Glide target frequency (exponential). */
  f2?: number;
  /** Glide time, default = dur. */
  glide?: number;
  t: number;
  dur: number;
  peak: number;
  attack?: number;
  hold?: number;
  detune?: number;
}

export function tone(g: NodeGroup, dest: AudioNode, o: ToneOpts): { osc: OscillatorNode; env: GainNode } {
  const osc = g.ac.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f, o.t);
  if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), o.t + (o.glide ?? o.dur));
  if (o.detune) osc.detune.value = o.detune;
  const env = envelope(g, o.t, o.attack ?? 0.002, o.peak, o.dur, o.hold ?? 0);
  osc.connect(env);
  env.connect(dest);
  g.source(osc, o.t, o.t + o.dur + 0.03);
  return { osc, env };
}

export interface NoiseOpts {
  t: number;
  dur: number;
  peak: number;
  attack?: number;
  hold?: number;
  /** Filter; omit for raw noise. */
  type?: BiquadFilterType;
  f?: number;
  /** Sweep target for the filter frequency (exponential). */
  f2?: number;
  /** Sweep time, default = dur. */
  sweep?: number;
  q?: number;
  /** Playback rate (pitch-shifts the noise colour). */
  rate?: number;
  brown?: boolean;
}

export function noise(
  g: NodeGroup, dest: AudioNode, o: NoiseOpts,
): { src: AudioBufferSourceNode; filter: BiquadFilterNode | null; env: GainNode } {
  const bufs = noiseBuffers(g.ac);
  const src = g.ac.createBufferSource();
  src.buffer = o.brown ? bufs.brown : bufs.white;
  src.loop = true;
  src.playbackRate.value = o.rate ?? 1;
  const env = envelope(g, o.t, o.attack ?? 0.001, o.peak, o.dur, o.hold ?? 0);
  let filter: BiquadFilterNode | null = null;
  if (o.type) {
    filter = g.filter(o.type, o.f ?? 1000, o.q ?? 0.7);
    filter.frequency.setValueAtTime(o.f ?? 1000, o.t);
    if (o.f2 !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), o.t + (o.sweep ?? o.dur));
    }
    src.connect(filter);
    filter.connect(env);
  } else {
    src.connect(env);
  }
  env.connect(dest);
  g.source(src, o.t, o.t + o.dur + 0.03, Math.random() * 1.5);
  return { src, filter, env };
}

export interface FmOpts {
  f: number;
  f2?: number;
  glide?: number;
  /** Modulator frequency = carrier × ratio. */
  ratio: number;
  /** Modulation index (deviation = index × carrier freq). */
  index: number;
  /** Index at the end of the note (exp ramp), default = index. */
  index2?: number;
  t: number;
  dur: number;
  peak: number;
  attack?: number;
  hold?: number;
  type?: OscillatorType;
  modType?: OscillatorType;
}

export function fm(g: NodeGroup, dest: AudioNode, o: FmOpts): { carrier: OscillatorNode; env: GainNode } {
  const ac = g.ac;
  const carrier = ac.createOscillator();
  carrier.type = o.type ?? 'sine';
  const mod = ac.createOscillator();
  mod.type = o.modType ?? 'sine';
  const depth = g.gain(0);
  const end = o.t + (o.glide ?? o.dur);
  carrier.frequency.setValueAtTime(o.f, o.t);
  mod.frequency.setValueAtTime(o.f * o.ratio, o.t);
  if (o.f2 !== undefined) {
    carrier.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), end);
    mod.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2 * o.ratio), end);
  }
  depth.gain.setValueAtTime(Math.max(MIN, o.index * o.f), o.t);
  const i2 = o.index2 ?? o.index;
  depth.gain.exponentialRampToValueAtTime(Math.max(MIN, i2 * (o.f2 ?? o.f)), o.t + o.dur);
  mod.connect(depth);
  depth.connect(carrier.frequency);
  const env = envelope(g, o.t, o.attack ?? 0.002, o.peak, o.dur, o.hold ?? 0);
  carrier.connect(env);
  env.connect(dest);
  g.source(carrier, o.t, o.t + o.dur + 0.03);
  g.source(mod, o.t, o.t + o.dur + 0.03);
  return { carrier, env };
}

/** Low-frequency vibrato/wobble applied to an AudioParam (e.g. an oscillator's frequency). */
export function lfo(
  g: NodeGroup, param: AudioParam, rate: number, depth: number, t: number, dur: number, type: OscillatorType = 'sine',
): OscillatorNode {
  const o = g.ac.createOscillator();
  o.type = type;
  o.frequency.value = rate;
  const d = g.gain(depth);
  o.connect(d);
  d.connect(param);
  g.source(o, t, t + dur + 0.03);
  return o;
}
