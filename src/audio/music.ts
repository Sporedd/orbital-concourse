/**
 * Procedural music bed in D minor.
 *
 * Scheduler: a 50 ms setInterval looks 150 ms ahead and schedules every 16th-note step that
 * falls inside that window with sample-accurate AudioContext times. Each MusicState is a
 * Track (own tempo, step counter, output gain and dotted-8th feedback delay). Switching state
 * starts a new Track fading in over 1.5 s while the old one fades out and stops scheduling at
 * the end of the fade, so two grooves overlap briefly in a crossfade.
 */
import type { MusicState } from '@/core/types';
import type { AudioEngine } from './engine';
import { NodeGroup, midiToFreq } from './nodes';
import { envelope, fm, noise, sustainEnv, tone } from './synth';

const LOOKAHEAD = 0.15;
const TICK_MS = 50;
const FADE = 1.5;

interface Chord {
  notes: number[]; // MIDI, around octave 3
  root: number; // MIDI bass root, octave 2
}

const C = {
  Dm: { notes: [50, 53, 57], root: 38 },
  Bb: { notes: [50, 53, 58], root: 34 },
  F: { notes: [48, 53, 57], root: 41 },
  C: { notes: [48, 52, 55], root: 36 },
  Gm: { notes: [50, 55, 58], root: 43 },
  A: { notes: [49, 52, 57], root: 33 },
  Eb: { notes: [51, 55, 58], root: 39 },
  Dmaj: { notes: [50, 54, 57], root: 38 },
} satisfies Record<string, Chord>;

const PROG: Record<MusicState, Chord[]> = {
  menu: [C.Dm, C.Bb, C.F, C.C],
  intermission: [C.Dm, C.Gm, C.Bb, C.A],
  wave: [C.Dm, C.Dm, C.Bb, C.C],
  boss: [C.Dm, C.Dm, C.Eb, C.C],
  cleared: [C.F, C.C, C.Dm, C.Bb],
  dead: [C.Dm],
};

const BPM: Record<MusicState, number> = {
  menu: 70, intermission: 84, wave: 128, boss: 140, cleared: 92, dead: 60,
};

/** D minor pentatonic-ish bell pool (D F G A C) in octaves 5–6. */
const BELL_POOL = [74, 77, 79, 81, 84, 86, 89];

const rand = Math.random;
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];

/** Instruments bound to one track's dry/wet outputs. */
class Kit {
  constructor(private ac: AudioContext, private dry: AudioNode, private wet: AudioNode) {}

  private group(): NodeGroup {
    return new NodeGroup(this.ac);
  }

  pad(notes: number[], t: number, dur: number, vol: number, cutoff = 1000): void {
    const g = this.group();
    const lp = g.filter('lowpass', cutoff * 0.5, 0.8);
    lp.frequency.setValueAtTime(cutoff * 0.5, t);
    lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(cutoff * 0.6, t + dur);
    const env = sustainEnv(g, t, Math.min(0.9, dur * 0.3), vol / Math.sqrt(notes.length * 2), dur, Math.min(1.2, dur * 0.35));
    lp.connect(env);
    env.connect(this.dry);
    for (const n of notes) {
      for (const det of [-8, 8]) {
        const o = this.ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n);
        o.detune.value = det;
        o.connect(lp);
        g.source(o, t, t + dur + 0.05);
      }
    }
  }

  bell(note: number, t: number, vol: number): void {
    const g = this.group();
    const out = g.gain(1);
    out.connect(this.dry);
    const send = g.gain(0.7);
    out.connect(send);
    send.connect(this.wet);
    fm(g, out, { f: midiToFreq(note), ratio: 3.5, index: 2, index2: 0.15, t, dur: 1.6, peak: vol, attack: 0.003 });
  }

  bass(note: number, t: number, dur: number, cutoff: number, vol: number, type: OscillatorType = 'sawtooth'): void {
    const g = this.group();
    const lp = g.filter('lowpass', cutoff, 4);
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.35), t + dur);
    lp.connect(this.dry);
    tone(g, lp, { type, f: midiToFreq(note), t, dur, peak: vol, attack: 0.004 });
  }

  sub(note: number, t: number, dur: number, vol: number): void {
    const g = this.group();
    tone(g, this.dry, { f: midiToFreq(note), t, dur, peak: vol, attack: 0.01, hold: dur * 0.5 });
  }

  kick(t: number, vol: number): void {
    const g = this.group();
    tone(g, this.dry, { f: 150, f2: 42, glide: 0.13, t, dur: 0.32, peak: vol, attack: 0.002 });
    noise(g, this.dry, { t, dur: 0.012, peak: vol * 0.3, type: 'highpass', f: 3000 });
  }

  snare(t: number, vol: number): void {
    const g = this.group();
    noise(g, this.dry, { t, dur: 0.17, peak: vol, type: 'bandpass', f: 1900, q: 0.8 });
    tone(g, this.dry, { type: 'triangle', f: 195, f2: 160, t, dur: 0.08, peak: vol * 0.6 });
  }

  hat(t: number, vol: number, open = false): void {
    const g = this.group();
    noise(g, this.dry, { t, dur: open ? 0.13 : 0.035, peak: vol, type: 'highpass', f: 7500 });
  }

  arp(note: number, t: number, vol: number, len = 0.12): void {
    const g = this.group();
    const lp = g.filter('lowpass', 2600, 1);
    const out = g.gain(1);
    lp.connect(out);
    out.connect(this.dry);
    const send = g.gain(0.6);
    out.connect(send);
    send.connect(this.wet);
    tone(g, lp, { type: 'square', f: midiToFreq(note), t, dur: len, peak: vol, attack: 0.003 });
  }

  stab(notes: number[], t: number, dur: number, vol: number): void {
    const g = this.group();
    const sh = g.shaper(3);
    const lp = g.filter('lowpass', 2200, 1.5);
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const env = envelope(g, t, 0.004, vol, dur);
    sh.connect(lp);
    lp.connect(env);
    env.connect(this.dry);
    const send = g.gain(0.5);
    env.connect(send);
    send.connect(this.wet);
    for (const n of notes) {
      const o = this.ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToFreq(n);
      const pre = g.gain(0.35);
      o.connect(pre);
      pre.connect(sh);
      g.source(o, t, t + dur + 0.05);
    }
  }

  pulse(note: number, t: number, vol: number): void {
    const g = this.group();
    const lp = g.filter('lowpass', 800, 1);
    lp.connect(this.dry);
    tone(g, lp, { type: 'triangle', f: midiToFreq(note), t, dur: 0.35, peak: vol, attack: 0.012 });
  }

  brass(notes: number[], t: number, dur: number, vol: number): void {
    const g = this.group();
    const lp = g.filter('lowpass', 300, 1.2);
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.25);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    const env = sustainEnv(g, t, 0.06, vol / Math.sqrt(notes.length * 2), dur, dur * 0.6);
    lp.connect(env);
    env.connect(this.dry);
    const send = g.gain(0.4);
    env.connect(send);
    send.connect(this.wet);
    for (const n of notes) {
      for (const det of [-6, 6]) {
        const o = this.ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n);
        o.detune.value = det;
        o.connect(lp);
        g.source(o, t, t + dur + 0.05);
      }
    }
  }

  drone(notes: number[], t: number, dur: number, vol: number): void {
    const g = this.group();
    const lp = g.filter('lowpass', 320, 2);
    const env = sustainEnv(g, t, 2, vol / Math.sqrt(notes.length * 2), dur, 2);
    lp.connect(env);
    env.connect(this.dry);
    const l = this.ac.createOscillator();
    l.frequency.value = 0.13;
    const ld = g.gain(160);
    l.connect(ld);
    ld.connect(lp.frequency);
    g.source(l, t, t + dur + 0.05);
    for (const n of notes) {
      for (const det of [-10, 10]) {
        const o = this.ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n);
        o.detune.value = det;
        o.connect(lp);
        g.source(o, t, t + dur + 0.05);
      }
    }
  }
}

type Pattern = (k: Kit, step: number, t: number, sd: number) => void;

const PATTERNS: Record<MusicState, Pattern> = {
  menu(k, step, t, sd) {
    const s = step % 16;
    const ch = PROG.menu[Math.floor(step / 16) % 4];
    if (s === 0) {
      k.pad(ch.notes, t, 16 * sd + 0.8, 0.16, 900);
      k.sub(ch.root, t, 16 * sd, 0.12);
    }
    if (s % 2 === 0 && rand() < 0.16) k.bell(pick(BELL_POOL), t, 0.06);
  },

  intermission(k, step, t, sd) {
    const s = step % 16;
    const ch = PROG.intermission[Math.floor(step / 16) % 4];
    if (s === 0) k.pad(ch.notes, t, 16 * sd + 0.6, 0.13, 1100);
    if (s % 4 === 0) k.pulse(ch.root + 12, t, 0.12);
    else if (s % 4 === 2) k.pulse(ch.root + 24, t, 0.05);
    if (s % 4 === 2 && rand() < 0.1) k.bell(pick(BELL_POOL), t, 0.045);
  },

  wave(k, step, t, sd) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const ch = PROG.wave[bar % 4];
    if (s % 4 === 0) k.kick(t, 0.55);
    if (s === 4 || s === 12) k.snare(t, 0.2);
    if (s % 2 === 1) k.hat(t, 0.045);
    if (s % 4 === 2) k.hat(t, 0.07, true);
    const accent = s % 2 === 0;
    const note = ch.root + (s % 4 === 2 ? 12 : 0);
    k.bass(note, t, sd * 0.9, accent ? 1100 : 650 + 400 * ((bar % 2) * 0.5 + (s / 16)), accent ? 0.17 : 0.11);
    if (s === 0) k.pad(ch.notes, t, 16 * sd + 0.3, 0.06, 1400);
    // Arpeggio enters on the second half of each 8-bar phrase, sparse before.
    const arpOn = bar % 8 >= 4 || s % 4 === 0;
    if (arpOn) {
      const seq = [0, 1, 2, 1, 2, 0, 2, 1];
      const n = ch.notes[seq[s % 8]] + 24;
      k.arp(n, t, 0.045, sd * 0.8);
    }
  },

  boss(k, step, t, sd) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const ch = PROG.boss[bar % 4];
    if (s % 4 === 0 || s === 14) k.kick(t, 0.62);
    if (s === 4 || s === 12) k.snare(t, 0.26);
    k.hat(t, s % 2 === 1 ? 0.06 : 0.035, s % 4 === 2);
    k.bass(ch.root + (s % 8 === 6 ? 12 : 0), t, sd * 0.85, s % 2 === 0 ? 1300 : 800, s % 2 === 0 ? 0.18 : 0.12);
    if (s % 8 === 0) k.sub(ch.root - 12, t, sd * 7.5, 0.22);
    if ((s === 0 && bar % 2 === 0) || s === 6 || (s === 10 && bar % 4 === 3)) {
      const r = ch.root + 24;
      k.stab([r, r + 1, r + 6], t, 0.14, 0.13);
    }
    const arpSeq = [0, 3, 7, 1, 12, 7, 3, 1];
    k.arp(ch.root + 36 + arpSeq[s % 8], t, 0.035, sd * 0.7);
    if (s === 0 && bar % 2 === 0) k.drone([ch.root, ch.root + 7], t, 32 * sd + 0.5, 0.08);
  },

  cleared(k, step, t, sd) {
    if (step === 0) {
      k.brass([62, 66, 69, 74], t, 2.2, 0.17);
      k.kick(t, 0.5);
      k.sub(38, t, 2.2, 0.18);
      return;
    }
    if (step < 16) return;
    const s = step % 16;
    const ch = PROG.cleared[Math.floor((step - 16) / 16) % 4];
    if (s === 0) {
      k.pad(ch.notes, t, 16 * sd + 0.8, 0.13, 1000);
      k.sub(ch.root, t, 16 * sd, 0.08);
    }
    if (s % 4 === 0 && rand() < 0.2) k.bell(pick(BELL_POOL), t, 0.05);
  },

  dead(k, step, t, sd) {
    if (step % 32 === 0) k.drone([26, 38, 45], t, 32 * sd + 2, 0.18);
    if (step % 8 === 4 && rand() < 0.25) k.bell(pick([62, 57, 53, 50]), t, 0.035);
  },
};

interface Track {
  state: MusicState;
  kit: Kit;
  out: GainNode;
  /** Every node the track owns outside per-note groups (delay chain). */
  nodes: AudioNode[];
  step: number;
  next: number;
  stepDur: number;
  /** AudioContext time after which the track stops scheduling; Infinity while current. */
  stopAt: number;
}

export class Music {
  private tracks: Track[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  current: MusicState | null = null;

  constructor(private eng: AudioEngine) {}

  set(state: MusicState): void {
    if (state === this.current) return;
    this.current = state;
    const ac = this.eng.ac;
    const now = ac.currentTime;
    for (const tr of this.tracks) {
      if (tr.stopAt !== Infinity) continue;
      const g = tr.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + FADE);
      tr.stopAt = now + FADE;
    }
    this.tracks.push(this.createTrack(state, now));
    if (this.timer === null) this.timer = setInterval(this.tick, TICK_MS);
    this.tick();
  }

  private createTrack(state: MusicState, now: number): Track {
    const ac = this.eng.ac;
    const stepDur = 60 / BPM[state] / 4;
    const out = ac.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + (state === 'cleared' ? 0.15 : FADE));
    out.connect(this.eng.music);
    const dry = ac.createGain();
    dry.connect(out);
    // Dotted-8th feedback delay for bells/arps/stabs.
    const wet = ac.createGain();
    const delay = ac.createDelay(2);
    delay.delayTime.value = stepDur * 3;
    const fb = ac.createGain();
    fb.gain.value = 0.35;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2200;
    const wetOut = ac.createGain();
    wetOut.gain.value = 0.45;
    wet.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wetOut);
    wetOut.connect(out);
    return {
      state,
      kit: new Kit(ac, dry, wet),
      out,
      nodes: [out, dry, wet, delay, fb, damp, wetOut],
      step: 0,
      next: now + 0.05,
      stepDur,
      stopAt: Infinity,
    };
  }

  private tick = (): void => {
    const now = this.eng.ac.currentTime;
    const horizon = now + LOOKAHEAD;
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const tr = this.tracks[i];
      if (now > tr.stopAt + 0.1) {
        for (const n of tr.nodes) n.disconnect();
        this.tracks.splice(i, 1);
        continue;
      }
      // Throttled tab / suspended context: skip missed steps instead of bursting them.
      if (tr.next < now - 0.1) {
        const missed = Math.ceil((now - tr.next) / tr.stepDur);
        tr.step += missed;
        tr.next += missed * tr.stepDur;
      }
      while (tr.next < horizon && tr.next < tr.stopAt) {
        try {
          PATTERNS[tr.state](tr.kit, tr.step, tr.next, tr.stepDur);
        } catch (err) {
          console.error('[audio] music pattern failed', err);
        }
        tr.step++;
        tr.next += tr.stepDur;
      }
    }
    if (this.tracks.length === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const tr of this.tracks) for (const n of tr.nodes) n.disconnect();
    this.tracks = [];
    this.current = null;
  }
}
