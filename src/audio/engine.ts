/**
 * Audio graph + voice management.
 *
 *   voices ─┬─────────────▶ sfx bus ──┐
 *           └─▶ echo send ─▶ sfx bus  │
 *   music tracks ─────────▶ music bus ├─▶ master ─▶ compressor ─▶ destination
 *   wind ─────────────────▶ ambience ─┘
 *
 * Voice limiter: at most MAX_VOICES SFX voices. When full, every active voice gets a score
 * (level × remaining fraction of its length, so quiet and nearly-finished voices score low)
 * and the lowest is stolen with a 15 ms fade — unless the new voice would score lower still,
 * in which case the new one is dropped instead.
 */
import type * as THREE from 'three';
import { NodeGroup, clamp } from './nodes';

export const DEFAULT_VOLUMES = { master: 0.8, sfx: 1, music: 0.45, ambience: 0.35 };
export type BusName = keyof typeof DEFAULT_VOLUMES;

export const MAX_VOICES = 24;

/** One playing sound effect. Synth nodes connect to `input`. */
export class Voice extends NodeGroup {
  readonly input: GainNode;
  readonly out: GainNode;
  readonly startTime: number;
  private send: GainNode | null = null;

  constructor(ac: AudioContext, dest: AudioNode, readonly level: number, pan: number, cutoff: number) {
    super(ac);
    this.startTime = ac.currentTime;
    this.input = this.gain(1);
    this.out = this.gain(level);
    let last: AudioNode = this.input;
    if (cutoff > 0) {
      const f = this.filter('lowpass', cutoff, 0.5);
      last.connect(f);
      last = f;
    }
    if (pan !== 0) {
      const p = this.node(ac.createStereoPanner());
      p.pan.value = pan;
      last.connect(p);
      last = p;
    }
    last.connect(this.out);
    this.out.connect(dest);
  }

  /** Send some of this voice into a shared feedback-delay (echo) bus. */
  echo(bus: AudioNode, amount: number): void {
    if (this.send || amount <= 0) return;
    this.send = this.gain(amount);
    this.out.connect(this.send);
    this.send.connect(bus);
  }

  score(now: number): number {
    const len = Math.max(0.01, this.end - this.startTime);
    const remaining = clamp((this.end - now) / len, 0, 1);
    return this.level * (0.2 + 0.8 * remaining);
  }

  /** Fast fade-out and stop (voice stealing). */
  kill(now: number): void {
    if (this.disposed) return;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.015);
    this.stopAll(now + 0.03);
  }
}

export class AudioEngine {
  readonly master: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly sfx: GainNode;
  readonly music: GainNode;
  readonly ambience: GainNode;
  /** Input of the shared SFX feedback delay. */
  readonly echoIn: GainNode;
  readonly volumes = { ...DEFAULT_VOLUMES };
  private voices: Voice[] = [];

  constructor(readonly ac: AudioContext) {
    const c = ac.createDynamicsCompressor();
    c.threshold.value = -14;
    c.knee.value = 10;
    c.ratio.value = 4;
    c.attack.value = 0.003;
    c.release.value = 0.25;
    c.connect(ac.destination);
    this.compressor = c;

    this.master = ac.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(c);

    const bus = (v: number) => {
      const g = ac.createGain();
      g.gain.value = v;
      g.connect(this.master);
      return g;
    };
    this.sfx = bus(this.volumes.sfx);
    this.music = bus(this.volumes.music);
    this.ambience = bus(this.volumes.ambience);

    // Shared slap/echo for big sounds (sniper, explosions, roars): ~130 ms, darkened feedback.
    this.echoIn = ac.createGain();
    const delay = ac.createDelay(1);
    delay.delayTime.value = 0.13;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;
    const fb = ac.createGain();
    fb.gain.value = 0.34;
    const wet = ac.createGain();
    wet.gain.value = 0.55;
    this.echoIn.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(this.sfx);
  }

  get now(): number {
    return this.ac.currentTime;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  /** Allocate a voice, stealing the weakest one when the pool is full. Null = dropped. */
  allocate(level: number, pan: number, cutoff: number): Voice | null {
    const now = this.ac.currentTime;
    if (this.voices.length >= MAX_VOICES) {
      let worst: Voice | null = null;
      let worstScore = Infinity;
      for (const v of this.voices) {
        // Older voices lose ties: subtract a hair per second of age.
        const s = v.score(now) - (now - v.startTime) * 1e-3;
        if (s < worstScore) {
          worstScore = s;
          worst = v;
        }
      }
      if (!worst || level <= worstScore) return null;
      this.release(worst);
      worst.kill(now);
    }
    const v = new Voice(this.ac, this.sfx, level, pan, cutoff);
    v.onDispose = () => this.release(v);
    this.voices.push(v);
    return v;
  }

  private release(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Safety net: drop voices whose sources should long have ended (e.g. onended never fired). */
  sweep(): void {
    const now = this.ac.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end > 0 && now > v.end + 2) v.dispose();
    }
  }

  setVolume(bus: BusName, value: number): void {
    const v = clamp(value, 0, 2);
    this.volumes[bus] = v;
    const node = bus === 'master' ? this.master : this[bus];
    node.gain.setTargetAtTime(v, this.ac.currentTime, 0.05);
  }
}

// ---------------------------------------------------------------------------
// Listener-relative positioning (StereoPanner + distance attenuation + air absorption)
// ---------------------------------------------------------------------------
export interface Spatial {
  att: number;
  pan: number;
  /** Lowpass cutoff in Hz (distance/behind dulling). */
  cutoff: number;
}

const REF_DIST = 2;
const ROLLOFF = 40;

export function spatialize(camera: THREE.Object3D, pos: { x: number; y: number; z: number }): Spatial {
  const e = camera.matrixWorld.elements;
  const dx = pos.x - e[12];
  const dy = pos.y - e[13];
  const dz = pos.z - e[14];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.05) return { att: 1, pan: 0, cutoff: 0 };
  const inv = 1 / dist;
  const rl = Math.hypot(e[0], e[1], e[2]) || 1;
  const fl = Math.hypot(e[8], e[9], e[10]) || 1;
  const right = ((dx * e[0] + dy * e[1] + dz * e[2]) * inv) / rl;
  const fwd = (-(dx * e[8] + dy * e[9] + dz * e[10]) * inv) / fl;
  const x = clamp((dist - REF_DIST) / ROLLOFF, 0, 1);
  const att = Math.pow(1 - x, 1.6);
  // Very close sources pan less (they are "around" you).
  const proximity = clamp(dist / 3, 0, 1);
  const pan = clamp(right * 0.85 * proximity, -0.85, 0.85);
  let cutoff = 18000 * Math.pow(0.2, x); // 18 kHz near → ~3.6 kHz at the roll-off edge
  if (fwd < 0) cutoff *= 1 + 0.45 * fwd; // behind the listener: duller
  return { att, pan, cutoff: Math.max(700, cutoff) };
}
