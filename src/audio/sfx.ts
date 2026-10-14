/**
 * SFX bank: one synth function per SfxName. Each builds its nodes into the given Voice
 * (connecting to voice.input), starting at time `t`, with pitch multiplier `p`.
 */
import type { SfxName } from '@/core/types';
import type { Voice } from './engine';
import { fm, lfo, noise, tone } from './synth';

export type SfxFn = (v: Voice, t: number, p: number) => void;

export interface SfxMeta {
  /** Base level multiplier. */
  gain?: number;
  /** Minimum seconds between two plays of this sound (rate limit). Default 0.03. */
  interval?: number;
  /** Random pitch variation (fraction). Default 0.06. */
  vary?: number;
  /** Amount sent to the shared echo. */
  echo?: number;
}

export const SFX_META: Record<SfxName, SfxMeta> = {
  shot_pistol: { gain: 0.8, echo: 0.12 },
  shot_smg: { gain: 0.6, interval: 0.025, echo: 0.06 },
  shot_shotgun: { gain: 0.95, echo: 0.22 },
  shot_rifle: { gain: 0.7, echo: 0.1 },
  shot_sniper: { gain: 0.95, echo: 0.35 },
  reload: { gain: 0.6, interval: 0.2, vary: 0.03 },
  empty: { gain: 0.55, interval: 0.1 },
  equip: { gain: 0.55, interval: 0.1 },
  melee: { gain: 0.75, interval: 0.1 },
  grenade_throw: { gain: 0.6, interval: 0.1 },
  explosion: { gain: 1, echo: 0.3, vary: 0.08 },
  hit: { gain: 0.42, interval: 0.045, vary: 0.04 },
  crit: { gain: 0.55, interval: 0.05, vary: 0.03 },
  enemy_hurt: { gain: 0.55, interval: 0.08, vary: 0.14 },
  enemy_die: { gain: 0.75, interval: 0.04, vary: 0.12 },
  boss_roar: { gain: 0.9, interval: 0.6, echo: 0.3, vary: 0.04 },
  boss_die: { gain: 1, interval: 1, echo: 0.35, vary: 0.02 },
  spitter_shot: { gain: 0.6, vary: 0.1 },
  bomber_fuse: { gain: 0.6, interval: 0.25, vary: 0.02 },
  player_hurt: { gain: 0.75, interval: 0.25, vary: 0.05 },
  shield_break: { gain: 0.75, interval: 0.5, vary: 0.02 },
  shield_recharge: { gain: 0.5, interval: 1, vary: 0.01 },
  player_die: { gain: 0.9, interval: 1, vary: 0 },
  pickup: { gain: 0.55, interval: 0.05, vary: 0.02 },
  pickup_weapon: { gain: 0.6, interval: 0.08, echo: 0.2, vary: 0.01 },
  levelup: { gain: 0.65, interval: 0.5, echo: 0.25, vary: 0 },
  skill_up: { gain: 0.55, interval: 0.06, echo: 0.12, vary: 0.02 },
  round_start: { gain: 0.6, interval: 0.5, echo: 0.2, vary: 0 },
  round_clear: { gain: 0.65, interval: 0.5, echo: 0.25, vary: 0 },
  ui_click: { gain: 0.4, interval: 0.03, vary: 0.04 },
  ui_open: { gain: 0.4, interval: 0.06, vary: 0.04 },
};

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
function click(v: Voice, dest: AudioNode, t: number, f: number, peak: number, dur = 0.012): void {
  tone(v, dest, { type: 'square', f, f2: f * 0.45, t, dur, peak, attack: 0.0005 });
}

function explosionCore(v: Voice, dest: AudioNode, t: number, p: number, size = 1): void {
  const len = 0.7 * size;
  tone(v, dest, { f: 85 * p, f2: 26 * p, t, dur: len, peak: 1.0, attack: 0.004, glide: len * 0.7 });
  tone(v, dest, { type: 'triangle', f: 55 * p, f2: 24 * p, t, dur: len * 0.85, peak: 0.6, attack: 0.006 });
  noise(v, dest, {
    t, dur: len, peak: 1.0, attack: 0.003, type: 'lowpass', f: 9000, f2: 180, sweep: len * 0.8, q: 0.9, rate: p,
  });
  noise(v, dest, { t: t + 0.02, dur: len * 0.9, peak: 0.6, brown: true, type: 'lowpass', f: 900, f2: 120, rate: p });
  noise(v, dest, { t, dur: 0.05, peak: 0.6, type: 'highpass', f: 2500 });
}

function growl(v: Voice, dest: AudioNode, t: number, f: number, f2: number, dur: number, peak: number, cut: number): void {
  const lp = v.filter('lowpass', cut, 3);
  lp.frequency.setValueAtTime(cut, t);
  lp.frequency.exponentialRampToValueAtTime(cut * 0.4, t + dur);
  lp.connect(dest);
  const { osc } = tone(v, lp, { type: 'sawtooth', f, f2, t, dur, peak, attack: 0.02 });
  lfo(v, osc.frequency, 28 + Math.random() * 10, f * 0.12, t, dur, 'square');
  const { osc: o2 } = tone(v, lp, { type: 'sawtooth', f: f * 1.5, f2: f2 * 1.5, t, dur, peak: peak * 0.4, attack: 0.02, detune: 14 });
  lfo(v, o2.frequency, 22, f * 0.1, t, dur);
}

/** Single-oscillator gated beeps (cheaper than one oscillator per beep). */
function beeps(v: Voice, dest: AudioNode, times: number[], t: number, f: number, f2: number, len: number, peak: number, beepLen: number): void {
  const osc = v.ac.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.linearRampToValueAtTime(f2, t + len);
  const gate = v.gain(0);
  gate.gain.setValueAtTime(0, t);
  for (const bt of times) {
    gate.gain.setValueAtTime(0, t + bt);
    gate.gain.linearRampToValueAtTime(peak, t + bt + 0.003);
    gate.gain.setValueAtTime(peak, t + bt + beepLen);
    gate.gain.linearRampToValueAtTime(0, t + bt + beepLen + 0.004);
  }
  const lp = v.filter('lowpass', 4500, 0.7);
  osc.connect(gate);
  gate.connect(lp);
  lp.connect(dest);
  v.source(osc, t, t + len + 0.05);
}

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------
export const SFX: Record<SfxName, SfxFn> = {
  // ---- guns ---------------------------------------------------------------
  shot_pistol(v, t, p) {
    const d = v.shaper(2.5);
    d.connect(v.input);
    click(v, d, t, 2400 * p, 0.35, 0.01);
    noise(v, d, { t, dur: 0.15, peak: 0.85, type: 'bandpass', f: 3200 * p, f2: 700 * p, q: 0.8, rate: p });
    noise(v, d, { t, dur: 0.03, peak: 0.5, type: 'highpass', f: 5000 });
    tone(v, d, { f: 190 * p, f2: 60 * p, t, dur: 0.1, peak: 0.75 });
  },

  shot_smg(v, t, p) {
    const d = v.shaper(3);
    d.connect(v.input);
    click(v, d, t, 3200 * p, 0.28, 0.008);
    noise(v, d, { t, dur: 0.085, peak: 0.75, type: 'bandpass', f: 4200 * p, f2: 1500 * p, q: 1.1, rate: p });
    tone(v, d, { f: 240 * p, f2: 90 * p, t, dur: 0.055, peak: 0.55 });
  },

  shot_shotgun(v, t, p) {
    const d = v.shaper(2);
    d.connect(v.input);
    tone(v, d, { f: 120 * p, f2: 36 * p, t, dur: 0.3, peak: 1.0, attack: 0.002, glide: 0.18 });
    tone(v, d, { type: 'triangle', f: 75 * p, f2: 30 * p, t, dur: 0.26, peak: 0.6 });
    noise(v, d, { t, dur: 0.3, peak: 1.0, type: 'lowpass', f: 7000 * p, f2: 450 * p, sweep: 0.22, q: 0.5, rate: p });
    noise(v, d, { t, dur: 0.22, peak: 0.45, type: 'bandpass', f: 1200 * p, f2: 400, q: 0.5 });
    noise(v, d, { t, dur: 0.02, peak: 0.6, type: 'highpass', f: 4000 });
    // Pump-ish rattle tail
    noise(v, v.input, { t: t + 0.08, dur: 0.2, peak: 0.12, type: 'bandpass', f: 2600, q: 3 });
  },

  shot_rifle(v, t, p) {
    const d = v.shaper(2.5);
    d.connect(v.input);
    noise(v, d, { t, dur: 0.14, peak: 0.9, type: 'bandpass', f: 2000 * p, f2: 650 * p, q: 1.2, rate: p });
    noise(v, d, { t, dur: 0.025, peak: 0.55, type: 'highpass', f: 4500 });
    tone(v, d, { type: 'square', f: 1500 * p, f2: 280 * p, t, dur: 0.03, peak: 0.22 });
    tone(v, d, { f: 165 * p, f2: 55 * p, t, dur: 0.11, peak: 0.75 });
  },

  shot_sniper(v, t, p) {
    const d = v.shaper(2.5);
    d.connect(v.input);
    noise(v, d, { t, dur: 0.045, peak: 0.95, type: 'highpass', f: 2500 });
    noise(v, d, { t, dur: 0.45, peak: 0.8, type: 'bandpass', f: 1400 * p, f2: 260 * p, q: 0.9, rate: p * 0.9 });
    noise(v, v.input, { t: t + 0.03, dur: 0.45, peak: 0.35, brown: true, type: 'lowpass', f: 700, f2: 120 });
    tone(v, d, { f: 95 * p, f2: 33 * p, t, dur: 0.42, peak: 1.0, glide: 0.3 });
    tone(v, d, { type: 'sawtooth', f: 320 * p, f2: 80 * p, t, dur: 0.08, peak: 0.25 });
  },

  // ---- weapon handling ----------------------------------------------------
  reload(v, t, p) {
    // mag out
    noise(v, v.input, { t, dur: 0.035, peak: 0.6, type: 'bandpass', f: 3000 * p, q: 4 });
    click(v, v.input, t, 1800 * p, 0.2, 0.015);
    // mag in + slap
    const t2 = t + 0.22;
    noise(v, v.input, { t: t2, dur: 0.045, peak: 0.7, type: 'bandpass', f: 2200 * p, q: 3 });
    click(v, v.input, t2, 1200 * p, 0.25, 0.02);
    tone(v, v.input, { f: 320 * p, f2: 150 * p, t: t2, dur: 0.06, peak: 0.45 });
  },

  empty(v, t, p) {
    click(v, v.input, t, 2600 * p, 0.25, 0.01);
    noise(v, v.input, { t, dur: 0.018, peak: 0.35, type: 'highpass', f: 4000 * p });
  },

  equip(v, t, p) {
    noise(v, v.input, { t, dur: 0.18, peak: 0.35, attack: 0.04, type: 'bandpass', f: 800 * p, f2: 3200 * p, q: 2 });
    const t2 = t + 0.19;
    click(v, v.input, t2, 2000 * p, 0.25, 0.012);
    noise(v, v.input, { t: t2, dur: 0.03, peak: 0.45, type: 'bandpass', f: 3500 * p, q: 3 });
  },

  melee(v, t, p) {
    noise(v, v.input, { t, dur: 0.2, peak: 0.55, attack: 0.07, type: 'bandpass', f: 350 * p, f2: 2000 * p, sweep: 0.15, q: 1.5 });
    const t2 = t + 0.13;
    tone(v, v.input, { f: 150 * p, f2: 48 * p, t: t2, dur: 0.13, peak: 0.85 });
    noise(v, v.input, { t: t2, dur: 0.07, peak: 0.45, type: 'lowpass', f: 700 * p, q: 1 });
  },

  grenade_throw(v, t, p) {
    click(v, v.input, t, 3000 * p, 0.12, 0.008);
    noise(v, v.input, { t: t + 0.02, dur: 0.3, peak: 0.5, attack: 0.1, type: 'bandpass', f: 600 * p, f2: 2400 * p, sweep: 0.25, q: 1.6 });
  },

  explosion(v, t, p) {
    const d = v.shaper(1.8);
    d.connect(v.input);
    explosionCore(v, d, t, p, 1);
  },

  // ---- hit feedback -------------------------------------------------------
  hit(v, t, p) {
    tone(v, v.input, { type: 'triangle', f: 1900 * p, t, dur: 0.035, peak: 0.45, attack: 0.0005 });
    tone(v, v.input, { f: 2900 * p, t, dur: 0.02, peak: 0.2, attack: 0.0005 });
  },

  crit(v, t, p) {
    tone(v, v.input, { type: 'triangle', f: 2200 * p, t, dur: 0.03, peak: 0.35, attack: 0.0005 });
    fm(v, v.input, { f: 2350 * p, ratio: 2.76, index: 1.4, index2: 0.1, t, dur: 0.25, peak: 0.35, attack: 0.001 });
    tone(v, v.input, { f: 3520 * p, t: t + 0.015, dur: 0.18, peak: 0.18 });
  },

  enemy_hurt(v, t, p) {
    growl(v, v.input, t, 170 * p, 120 * p, 0.22, 0.4, 1100 * p);
    noise(v, v.input, { t, dur: 0.12, peak: 0.25, type: 'bandpass', f: 600 * p, q: 2 });
  },

  enemy_die(v, t, p) {
    growl(v, v.input, t, 230 * p, 55 * p, 0.5, 0.45, 1400 * p);
    noise(v, v.input, { t: t + 0.04, dur: 0.12, peak: 0.6, type: 'bandpass', f: 1300 * p, q: 0.7 });
    noise(v, v.input, { t: t + 0.06, dur: 0.25, peak: 0.45, brown: true, type: 'lowpass', f: 500, q: 0.8 });
  },

  boss_roar(v, t, p) {
    const dur = 1.8;
    const d = v.shaper(2);
    const lp = v.filter('lowpass', 500, 1.5);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.linearRampToValueAtTime(1600, t + 0.35);
    lp.frequency.exponentialRampToValueAtTime(350, t + dur);
    d.connect(lp);
    lp.connect(v.input);
    const a = fm(v, d, { type: 'sawtooth', f: 70 * p, f2: 52 * p, ratio: 0.5, index: 3, index2: 1.5, t, dur, peak: 0.6, attack: 0.25, hold: 0.6 });
    a.carrier.frequency.linearRampToValueAtTime(92 * p, t + 0.4);
    a.carrier.frequency.exponentialRampToValueAtTime(52 * p, t + dur);
    const { osc } = tone(v, d, { type: 'sawtooth', f: 104 * p, f2: 78 * p, t, dur: dur * 0.95, peak: 0.35, attack: 0.3, hold: 0.5, detune: 18 });
    lfo(v, osc.frequency, 7, 6, t, dur);
    noise(v, v.input, { t, dur: 1.6, peak: 0.35, attack: 0.3, hold: 0.5, type: 'bandpass', f: 450 * p, f2: 250, q: 1.5 });
    tone(v, v.input, { f: 45 * p, f2: 32 * p, t, dur, peak: 0.5, attack: 0.3, hold: 0.6 });
  },

  boss_die(v, t, p) {
    const dur = 2.4;
    const d = v.shaper(2);
    d.connect(v.input);
    const lp = v.filter('lowpass', 1400, 1.2);
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + dur);
    lp.connect(v.input);
    fm(v, lp, { type: 'sawtooth', f: 95 * p, f2: 28 * p, ratio: 0.5, index: 3, index2: 1, t, dur, peak: 0.55, attack: 0.08, hold: 0.4 });
    tone(v, lp, { type: 'sawtooth', f: 140 * p, f2: 40 * p, t, dur: dur * 0.9, peak: 0.3, attack: 0.1, detune: 20 });
    explosionCore(v, d, t + 0.15, p, 1.2);
    explosionCore(v, d, t + 0.75, p * 0.8, 1.5);
  },

  spitter_shot(v, t, p) {
    fm(v, v.input, { f: 950 * p, f2: 230 * p, ratio: 1.5, index: 2, index2: 0.3, t, dur: 0.18, peak: 0.45 });
    noise(v, v.input, { t, dur: 0.13, peak: 0.35, type: 'bandpass', f: 1600 * p, f2: 500 * p, q: 3 });
    const { osc } = tone(v, v.input, { type: 'triangle', f: 300 * p, f2: 160 * p, t: t + 0.02, dur: 0.15, peak: 0.25 });
    lfo(v, osc.frequency, 45, 60, t, 0.17);
  },

  bomber_fuse(v, t, p) {
    const times = [0, 0.14, 0.26, 0.36, 0.45, 0.53, 0.6, 0.66, 0.71, 0.75, 0.78];
    beeps(v, v.input, times, t, 1500 * p, 2100 * p, 0.8, 0.28, 0.03);
    noise(v, v.input, { t, dur: 0.8, peak: 0.06, type: 'highpass', f: 6000 });
  },

  // ---- player -------------------------------------------------------------
  player_hurt(v, t, p) {
    tone(v, v.input, { f: 115 * p, f2: 48 * p, t, dur: 0.18, peak: 0.85 });
    noise(v, v.input, { t, dur: 0.12, peak: 0.45, type: 'lowpass', f: 320, q: 0.8 });
    // heartbeat lub-dub
    tone(v, v.input, { f: 62, f2: 40, t: t + 0.24, dur: 0.13, peak: 0.6 });
    tone(v, v.input, { f: 58, f2: 38, t: t + 0.42, dur: 0.12, peak: 0.45 });
  },

  shield_break(v, t, p) {
    // glass: random high pings
    for (let i = 0; i < 8; i++) {
      const f = (3000 + Math.random() * 4500) * p;
      tone(v, v.input, { type: i % 2 ? 'triangle' : 'sine', f, t: t + Math.random() * 0.12, dur: 0.08 + Math.random() * 0.15, peak: 0.12 });
    }
    noise(v, v.input, { t, dur: 0.3, peak: 0.45, type: 'highpass', f: 3500, f2: 6000 });
    // descending zap
    const bp = v.filter('bandpass', 1500, 2);
    bp.connect(v.input);
    fm(v, bp, { type: 'sawtooth', f: 1800 * p, f2: 110 * p, ratio: 0.51, index: 1.5, t, dur: 0.42, peak: 0.4 });
  },

  shield_recharge(v, t, p) {
    const lp = v.filter('lowpass', 400, 2);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.9);
    lp.connect(v.input);
    const { osc } = tone(v, lp, { type: 'sawtooth', f: 220 * p, f2: 440 * p, t, dur: 1.0, peak: 0.28, attack: 0.35, hold: 0.4 });
    lfo(v, osc.frequency, 11, 4, t, 1.0);
    tone(v, v.input, { f: 440 * p, f2: 880 * p, t, dur: 1.0, peak: 0.15, attack: 0.4, hold: 0.35 });
  },

  player_die(v, t, p) {
    const dur = 1.7;
    const lp = v.filter('lowpass', 2000, 1.5);
    lp.frequency.setValueAtTime(2000, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + dur);
    lp.connect(v.input);
    tone(v, lp, { type: 'sawtooth', f: 300 * p, f2: 38 * p, t, dur, peak: 0.55, attack: 0.02, hold: 0.3 });
    tone(v, lp, { type: 'sawtooth', f: 303 * p, f2: 37 * p, t, dur, peak: 0.4, attack: 0.02, hold: 0.3, detune: 15 });
    tone(v, v.input, { f: 120 * p, f2: 28 * p, t, dur, peak: 0.7, hold: 0.4 });
    noise(v, v.input, { t, dur: 1.3, peak: 0.35, brown: true, type: 'lowpass', f: 600, f2: 100 });
  },

  // ---- loot / progression -------------------------------------------------
  pickup(v, t, p) {
    const notes = [1047, 1319, 1568];
    notes.forEach((f, i) => {
      const tt = t + i * 0.045;
      tone(v, v.input, { type: 'triangle', f: f * p, t: tt, dur: 0.09, peak: 0.3 });
      tone(v, v.input, { f: f * 2 * p, t: tt, dur: 0.06, peak: 0.08 });
    });
  },

  pickup_weapon(v, t, p) {
    fm(v, v.input, { f: 880 * p, ratio: 3.5, index: 1.6, index2: 0.1, t, dur: 0.5, peak: 0.35 });
    fm(v, v.input, { f: 1320 * p, ratio: 3.5, index: 1.6, index2: 0.1, t: t + 0.1, dur: 0.6, peak: 0.35 });
    noise(v, v.input, { t, dur: 0.06, peak: 0.15, type: 'bandpass', f: 3000, q: 3 });
  },

  levelup(v, t, p) {
    const notes = [587.3, 740, 880, 1174.7];
    notes.forEach((f, i) => {
      const tt = t + i * 0.08;
      const last = i === notes.length - 1;
      tone(v, v.input, { type: 'triangle', f: f * p, t: tt, dur: last ? 0.9 : 0.35, peak: 0.3, hold: last ? 0.2 : 0 });
      tone(v, v.input, { type: 'square', f: f * p, t: tt, dur: last ? 0.5 : 0.2, peak: 0.05, detune: 6 });
    });
    // sustain chord under the top note
    for (const f of [293.7, 370, 440]) tone(v, v.input, { type: 'triangle', f: f * p, t: t + 0.24, dur: 0.9, peak: 0.1, attack: 0.03, hold: 0.2 });
    // sparkle
    for (let i = 0; i < 10; i++) {
      const tt = t + 0.28 + Math.random() * 0.65;
      tone(v, v.input, { f: (2500 + Math.random() * 3500) * p, t: tt, dur: 0.12, peak: 0.07 });
    }
  },

  skill_up(v, t, p) {
    click(v, v.input, t, 2000 * p, 0.2, 0.01);
    fm(v, v.input, { f: 1174.7 * p, ratio: 3.5, index: 1.2, index2: 0.1, t: t + 0.03, dur: 0.4, peak: 0.28 });
    fm(v, v.input, { f: 1760 * p, ratio: 3.5, index: 1.2, index2: 0.1, t: t + 0.1, dur: 0.45, peak: 0.22 });
  },

  // ---- rounds -------------------------------------------------------------
  round_start(v, t, p) {
    const dur = 1.5;
    const lp = v.filter('lowpass', 300, 1.2);
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(1900, t + 0.6);
    lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    lp.connect(v.input);
    for (const f of [146.8, 220, 293.7]) {
      for (const det of [-7, 7]) {
        const { osc } = tone(v, lp, { type: 'sawtooth', f: f * p, t, dur, peak: 0.14, attack: 0.5, hold: 0.5, detune: det });
        lfo(v, osc.frequency, 5, f * 0.006, t, dur);
      }
    }
    tone(v, v.input, { f: 73.4 * p, t, dur, peak: 0.35, attack: 0.4, hold: 0.6 });
  },

  round_clear(v, t, p) {
    const notes = [587.3, 880, 1174.7];
    notes.forEach((f, i) => {
      const tt = t + i * 0.14;
      const last = i === notes.length - 1;
      const dur = last ? 1.0 : 0.22;
      const lp = v.filter('lowpass', 3000, 1);
      lp.connect(v.input);
      tone(v, lp, { type: 'sawtooth', f: f * p, t: tt, dur, peak: 0.16, attack: 0.02, hold: last ? 0.3 : 0.08 });
      tone(v, lp, { type: 'sawtooth', f: f * p, t: tt, dur, peak: 0.12, attack: 0.02, hold: last ? 0.3 : 0.08, detune: 9 });
      fm(v, v.input, { f: f * 2 * p, ratio: 3.5, index: 1, index2: 0.1, t: tt, dur: last ? 0.8 : 0.3, peak: 0.08 });
    });
    tone(v, v.input, { type: 'triangle', f: 146.8 * p, t: t + 0.28, dur: 1.0, peak: 0.35, hold: 0.3 });
    tone(v, v.input, { f: 73.4 * p, t: t + 0.28, dur: 1.0, peak: 0.4, hold: 0.3 });
  },

  // ---- ui -----------------------------------------------------------------
  ui_click(v, t, p) {
    tone(v, v.input, { f: 1800 * p, f2: 1400 * p, t, dur: 0.03, peak: 0.25, attack: 0.0005 });
    noise(v, v.input, { t, dur: 0.01, peak: 0.12, type: 'highpass', f: 5000 });
  },

  ui_open(v, t, p) {
    noise(v, v.input, { t, dur: 0.22, peak: 0.3, attack: 0.08, type: 'bandpass', f: 500 * p, f2: 2600 * p, sweep: 0.2, q: 1.2 });
    tone(v, v.input, { f: 600 * p, f2: 900 * p, t: t + 0.03, dur: 0.15, peak: 0.07, attack: 0.04 });
  },
};

