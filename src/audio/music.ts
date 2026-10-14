/**
 * Procedural metal score (DOOM-style: low-tuned, distorted, industrial). Key: D Phrygian with
 * tritones and chromatic half-steps — guitar root D2 with a D1 "8th string" layer and D1 sub.
 *
 * Scheduler: a 50 ms setInterval looks 150 ms ahead and schedules every 16th-note step that
 * falls inside that window with sample-accurate AudioContext times. Each MusicState is a
 * Track (own tempo, step counter, output gain, instrument Rig — see metal.ts). Switching state
 * starts a new Track fading in while the old one fades out and stops scheduling at the end of
 * its fade. When the tab is throttled, missed steps are skipped instead of burst-scheduled.
 *
 * All tracks feed one music chain: tape saturation → glue compressor → limiter → soft ceiling
 * (≤ 0.88) → output trim → engine music bus, with a shared dark reverb.
 *
 * States:
 *  - menu         76 bpm   low tritone drone, distant FM clanks, noise groans, half-speed riff fragment every 8 bars
 *  - intermission 160 bpm  4-bar (6 s) build: pulsing palm-mutes, riser, drums only in the last bars
 *  - wave         160 bpm  full syncopated chug riffs + drums, new riff form every 8 bars, breakdowns, lead motif
 *  - boss         186 bpm  double-kick, blast bars, tritone stabs, dive-bombs, evil half-step lead (more layers at phase 2/3)
 *  - cleared      90 bpm   power-chord sting + crash + feedback tail, then a low drone
 *  - dead         52 bpm   detuned half-step drone, slow heartbeat kick, no riff
 */
import type { MusicState } from '@/core/types';
import type { AudioEngine } from './engine';
import { CEIL_RANGE, Rig, ceilingCurve, reverbIR, tapeCurve, type RigOpts } from './metal';

const LOOKAHEAD = 0.15;
/** Output trim after the ceiling: keeps the dense metal mix near the old score's level against SFX. */
const OUT_TRIM = 0.7;
const TICK_MS = 50;

/** Fade-in time of the incoming state (also the fade-out of the outgoing one). */
const FADE: Record<MusicState, number> = {
  menu: 1.5, intermission: 1.0, wave: 0.35, boss: 0.3, cleared: 0.05, dead: 1.5,
};

const BPM: Record<MusicState, number> = {
  menu: 76, intermission: 160, wave: 160, boss: 186, cleared: 90, dead: 52,
};

/** Per-state level trim (loudness matching after the shared limiter). */
const LEVEL: Record<MusicState, number> = {
  menu: 0.13, intermission: 0.15, wave: 0.2, boss: 0.1, cleared: 0.16, dead: 0.14,
};

const RIG: Record<MusicState, Omit<RigOpts, 'delay'>> = {
  menu: { gtr: 0.32, gtrVerb: 0.9, cab: 1500, bass: 0.35, drums: 0.55, lead: 0.3, fxVerb: 1 },
  intermission: { gtr: 0.45, gtrVerb: 0.25, cab: 2600, bass: 0.3, drums: 0.7, lead: 0.3, fxVerb: 0.6 },
  wave: { gtr: 0.55, gtrVerb: 0.12, cab: 4200, bass: 0.2, drums: 0.8, lead: 0.13, fxVerb: 0.5 },
  boss: { gtr: 0.55, gtrVerb: 0.12, cab: 4600, bass: 0.2, drums: 0.8, lead: 0.12, fxVerb: 0.5 },
  cleared: { gtr: 0.4, gtrVerb: 0.5, cab: 3600, bass: 0.45, drums: 0.8, lead: 0.3, fxVerb: 0.8 },
  dead: { gtr: 0.3, gtrVerb: 0.5, cab: 2000, bass: 0.4, drums: 0.8, lead: 0.3, fxVerb: 0.9 },
};

const rand = Math.random;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

// ---------------------------------------------------------------------------
// Riff language (one 16-char string per bar, one char per 16th):
//   x  palm-muted chug on the root      X  accented chug (kick follows)
//   y  palm-muted chug a half-step up   -  rest            .  hold previous open note
//   o  open root power chord            D  open root power chord that dive-bombs
//   1 3 5 6 7 8  open power chord that many semitones above the root
//   t  tritone stab (root + b5 + octave)
// ---------------------------------------------------------------------------
const OFF: Record<string, number> = { o: 0, D: 0, t: 0, '1': 1, '3': 3, '5': 5, '6': 6, '7': 7, '8': 8 };

const ROOT = 38; // D2

// Wave riffs.
const W = {
  A: 'X--x--X-x--x-xx-', // 3-3-2 syncopation with a gallop out
  B: 'X--x--X-1...o...',
  C: 'Xxx-Xxx-Xxx-3.1.', // gallops then F → Eb
  F: 'X-xyX-xyX-xy1.o.', // chromatic half-step chugs
  E: 'o..x-xx-6...5...', // root → tritone → fourth
  G: 'x-x-xxx-x-x-7.6.', // A → Ab
  H: 'X--x--X-x-xxD...', // phrase end: dive-bomb
  K1: 'X-----x-X--x--x-', // breakdown (half-time)
  K2: 'X-----x-t.......',
  K3: 'X--x----X--x-x--',
  K4: 'X-----x-6...D...',
};
interface Form {
  bars: string[];
  half?: boolean;
  lead?: boolean;
}
const WAVE_FORMS: Form[] = [
  { bars: [W.A, W.A, W.A, W.B, W.A, W.A, W.C, W.H] },
  { bars: [W.F, W.F, W.F, W.E, W.F, W.F, W.G, W.H], lead: true },
  { bars: [W.A, W.C, W.A, W.E, W.A, W.C, W.G, W.H], lead: true },
  { bars: [W.K1, W.K2, W.K1, W.K3, W.K1, W.K2, W.K3, W.K4], half: true },
];

// Boss riffs.
const B = {
  A: 'XxxxXxxxt.t.Xxxx', // relentless 16ths + tritone stabs
  B: 'X-xyX-xyX-xy6.7.',
  C: 'o..1..o..1..t...', // b2 motif in dotted 8ths over 4/4
  D: 'XxxXxxXxxXxxD...', // triplet gallop + dive-bomb
  E: 't...o...t...1...', // blast-beat bar
};
const BOSS_FORMS: Form[] = [
  { bars: [B.A, B.A, B.B, B.C, B.A, B.A, B.B, B.D] },
  { bars: [B.C, B.C, B.E, B.B, B.C, B.C, B.E, B.D], lead: true },
  { bars: [B.B, B.B, B.A, B.A, B.E, B.E, B.C, B.D], lead: true },
];

/** Lead motifs: [step in 2-bar cycle, semitones over the lead root, length in steps, slide-in]. */
type LeadNote = [number, number, number, number];
const LEADS: LeadNote[][] = [
  // evil half-step: D – Eb – D, then the tritone Ab with vibrato, falling to G
  [[0, 0, 6, 0], [6, 1, 6, -1], [12, 0, 4, 0], [16, 6, 10, -1], [26, 5, 6, 0]],
  // A – Ab – A – Bb, then A long, Ab
  [[0, 7, 4, 0], [4, 6, 4, 0], [8, 7, 4, 0], [12, 8, 4, -1], [16, 7, 12, 0], [28, 6, 4, 0]],
  // chromatic crawl D Eb E F … Eb
  [[0, 0, 3, 0], [3, 1, 3, 0], [6, 2, 3, 0], [9, 3, 7, -1], [16, 1, 12, 0], [28, 0, 4, -2]],
];

/** Mutable per-track state the patterns read/write. */
interface Song {
  form: Form;
  formIdx: number;
  root: number;
  phrase: number;
  lead: LeadNote[];
  /** Boss intensity 1..3 (extra lead layers). */
  intensity: number;
}

interface Step {
  r: Rig;
  step: number;
  s: number;
  bar: number;
  t: number;
  sd: number;
  song: Song;
}

type Hit = 'chug' | 'accent' | 'open' | null;

/** Plays one step of a riff bar; returns what kind of hit it was (drums follow the guitar). */
function riffStep(r: Rig, bar: string, s: number, t: number, sd: number, root: number, vel: number, lenScale = 1): Hit {
  const c = bar[s];
  if (c === undefined || c === '-' || c === '.') return null;
  if (c === 'x' || c === 'X' || c === 'y') {
    const acc = c === 'X';
    const n = root + (c === 'y' ? 1 : 0);
    const len = (acc ? 0.085 : 0.05) * lenScale;
    r.chug(n, t, len, vel * (acc ? 1 : 0.82), acc ? 1700 : 1000);
    r.bass(n - 12, t, len * 1.5, vel * (acc ? 1 : 0.8));
    return acc ? 'accent' : 'chug';
  }
  let k = 1;
  while (s + k < bar.length && bar[s + k] === '.') k++;
  const len = k * sd * 0.94;
  const off = OFF[c] ?? 0;
  const n = root + off;
  r.power(n, t, len, vel, {
    iv: c === 't' ? [0, 6, 12] : [0, 7, 12],
    dive: c === 'D' ? 0.3 : 0,
    cutoff: 3200,
  });
  r.bass(n - 12, t, len, vel);
  return 'open';
}

function newPhrase(song: Song, forms: Form[], roots: number[]): void {
  let i = Math.floor(rand() * forms.length);
  if (i === song.formIdx && forms.length > 1) i = (i + 1 + Math.floor(rand() * (forms.length - 1))) % forms.length;
  song.formIdx = i;
  song.form = forms[i];
  song.phrase++;
  song.root = ROOT + roots[song.phrase % roots.length];
  song.lead = pick(LEADS);
}

function playLead(r: Rig, motif: LeadNote[], cycleStep: number, t: number, sd: number, root: number, vel: number): void {
  for (const [at, off, len, slide] of motif) {
    if (at === cycleStep) r.lead(root + off, t, len * sd * 0.96, vel, { slide, vib: len >= 8 ? 28 : 10 });
  }
}

const CLANK_F = [110, 147, 196, 233];
const CLANK_R = [1.41, 2.76, 3.53, 1.73];

type Pattern = (p: Step) => void;

const PATTERNS: Record<MusicState, Pattern> = {
  menu({ r, s, bar, t, sd }) {
    if (s === 0 && bar % 4 === 0) r.drone([26, 32, 38], t, 64 * sd + 3, 0.55, 14, 230); // D1, Ab1, D2
    if (s === 0 && bar % 4 === 2) r.swell(t, 24 * sd, 0.16, 140, 520, 2);
    if (s === 8 && bar % 8 === 3) r.swell(t, 20 * sd, 0.05, 900, 2400, 14, false); // metal groan
    if (s % 4 === 0 && rand() < 0.12) r.clank(t, 0.09, pick(CLANK_F), pick(CLANK_R));
    // Half-speed riff fragment (8th notes) over the last two bars of every 8.
    const pb = bar % 8;
    if (pb >= 6 && s % 2 === 0) {
      const frag = 'X--x--X-o...1...';
      const i = (pb - 6) * 8 + s / 2;
      const hit = riffStep(r, frag, i, t, sd * 2, ROOT, 0.75, 1.6);
      if (hit === 'accent' || hit === 'open') r.kick(t, 0.6, 0.4, 0.3, 0.85);
    }
    if (pb === 6 && s === 0) r.tom(t, 33, 0.5);
  },

  intermission({ r, s, bar, t }) {
    const b = bar % 4; // 4 bars = 6 s = the intermission
    const sd = 60 / BPM.intermission / 4;
    if (b === 0 && s === 0) {
      r.riser(t, 64 * sd, 0.2);
      r.drone([26, 38], t, 64 * sd + 1, 0.35, 8, 300);
      r.clank(t, 0.12, 147, 1.41);
    }
    // Pulsing palm-mutes: 8ths, then 16ths; half-step tension, chromatic climb at the end.
    if (b >= 2 || s % 2 === 0) {
      let note = ROOT;
      if (s === 14 && b % 2 === 1) note += 1;
      if (b === 3 && s >= 12) note += s - 12;
      r.chug(note, t, 0.045, 0.45 + 0.15 * b + 0.01 * s, 600 + b * 180, 0.35);
      if (s % 4 === 0) r.bass(note - 12, t, 0.08, 0.5 + 0.1 * b);
    }
    // Drums only in the last bars.
    if (b === 2 && s % 4 === 0) r.kick(t, 0.7, 0.35);
    if (b === 3) {
      if (s % 2 === 0) r.kick(t, 0.75, 0.3);
      r.snare(t, 0.12 + 0.04 * s);
    }
    if (b === 2 && (s === 8 || s === 12)) r.tom(t, 38 - (s - 8) / 2, 0.55);
  },

  wave({ r, s, bar, t, sd, song }) {
    const pb = bar % 8;
    if (s === 0 && pb === 0 && bar > 0) newPhrase(song, WAVE_FORMS, [0, 0, 1, 0, 0, -2]);
    const f = song.form;
    const hit = riffStep(r, f.bars[pb], s, t, sd, song.root, 1);
    const half = !!f.half;
    if (hit === 'accent' || hit === 'open' || (hit === 'chug' && song.phrase % 2 === 1 && !half)) r.kick(t, 0.85);
    else if (!half && s % 8 === 0) r.kick(t, 0.8);
    const fill = pb === 7 && s >= 12;
    if (fill) r.snare(t, 0.45 + 0.12 * (s - 12));
    else if (half ? s === 8 : s === 4 || s === 12) r.snare(t, 0.75);
    if (!half && pb >= 4 && s % 4 === 2) r.hat(t, 0.3);
    if (half && s % 4 === 0 && s !== 8) r.hat(t, 0.22);
    if (s === 0 && (pb === 0 || pb === 4)) r.crash(t, pb === 0 ? 0.55 : 0.32);
    if (s === 0 && bar % 16 === 12) r.riser(t, 64 * sd, 0.16);
    if (half && s === 0 && pb % 4 === 0) r.drone([song.root - 12, song.root - 6], t, 64 * sd, 0.25, 12, 200);
    if (f.lead && pb >= 4) playLead(r, song.lead, (pb % 2) * 16 + s, t, sd, song.root + 24, 0.8);
    if (s === 14 && pb % 2 === 1 && rand() < 0.5) r.clank(t, 0.1, pick(CLANK_F), pick(CLANK_R));
  },

  boss({ r, s, bar, t, sd, song }) {
    const pb = bar % 8;
    if (s === 0 && pb === 0 && bar > 0) newPhrase(song, BOSS_FORMS, [0, 0, 1, 0, 6, 0]);
    const f = song.form;
    const riff = f.bars[pb];
    const hit = riffStep(r, riff, s, t, sd, song.root, 1);
    const blast = riff === B.E;
    if (blast) {
      if (s % 2 === 0) r.kick(t, 0.8, 0.3);
      else r.snare(t, 0.42);
    } else {
      // Double-kick 16ths, accents with the riff.
      const acc = hit === 'accent' || hit === 'open' || s % 4 === 0;
      r.kick(t, acc ? 0.85 : 0.5, acc ? 0.45 : 0.15, acc ? 1 : 0.5);
      if (s === 4 || s === 12) r.snare(t, 0.8);
    }
    if (s === 0 && (pb === 0 || pb === 4)) r.crash(t, pb === 0 ? 0.6 : 0.4);
    if (s === 8 && blast) r.crash(t, 0.35, 1.2);
    if (s === 0 && bar % 16 === 12) r.riser(t, 64 * sd, 0.15);
    if (s === 0 && pb === 0) r.drone([song.root - 12, song.root - 6], t, 128 * sd, 0.2, 14, 220);
    // Evil lead: second half by default; every bar from phase 2; tritone harmony at phase 3.
    const leadOn = song.intensity >= 2 || (f.lead ?? false) || pb >= 4;
    if (leadOn) {
      const cs = (pb % 2) * 16 + s;
      playLead(r, song.lead, cs, t, sd, song.root + 24, 0.8);
      if (song.intensity >= 2) playLead(r, song.lead, cs, t, sd, song.root + 36, 0.4);
      if (song.intensity >= 3) playLead(r, song.lead, cs, t, sd, song.root + 30, 0.45);
    }
    if (s === 10 && rand() < 0.35) r.clank(t, 0.12, pick(CLANK_F), pick(CLANK_R));
  },

  cleared({ r, step, t, sd }) {
    if (step === 0) {
      r.power(ROOT, t, 3.2, 1.1, { iv: [0, 7, 12], cutoff: 3000 });
      r.bass(ROOT - 12, t, 3.0, 1);
      r.kick(t, 1, 0.3);
      r.crash(t, 0.75, 3.2);
      r.clank(t, 0.2, 110, 1.41);
      r.sub(26, t, 3.5, 0.45);
      r.feedback(74, t + 1.0, 4.5, 0.3);
      return;
    }
    if (step < 16) return;
    const k = (step - 16) % 64;
    if (k === 0) r.drone([26, 33, 38], t, 64 * sd + 2.5, 0.5, 12, 240); // D1 A1 D2 — no third
    if (k === 32) r.swell(t, 24 * sd, 0.12, 120, 420, 2);
    if (step % 8 === 4 && rand() < 0.2) r.clank(t, 0.06, pick(CLANK_F), pick(CLANK_R));
  },

  dead({ r, step, t, sd }) {
    if (step % 32 === 0) r.drone([26, 27, 38], t, 32 * sd + 3, 0.6, 28, 190); // D1 + Eb1 cluster, detuned
    if (step % 4 === 0) {
      r.kick(t, 0.6, 0.15, 0.15, 0.7); // heartbeat: lub …
      r.kick(t + 0.2, 0.36, 0.1, 0, 0.7); // … dub
    }
    if (step % 32 === 16) r.swell(t, 16 * sd, 0.12, 200, 80, 2);
    if (step % 16 === 8 && rand() < 0.3) r.clank(t, 0.05, 98, 2.76);
  },
};

// ---------------------------------------------------------------------------
// Tracks + shared music chain
// ---------------------------------------------------------------------------
interface Track {
  state: MusicState;
  rig: Rig;
  song: Song;
  /** Fade gains (dry out + reverb send). */
  fades: GainNode[];
  /** Every node the track owns outside per-note groups. */
  nodes: AudioNode[];
  step: number;
  next: number;
  stepDur: number;
  /** AudioContext time after which the track stops scheduling; Infinity while current. */
  stopAt: number;
}

interface Chain {
  input: GainNode;
  verbIn: ConvolverNode;
  nodes: AudioNode[];
}

export class Music {
  private tracks: Track[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Chain | null = null;
  private intensity = 1;
  current: MusicState | null = null;

  constructor(private eng: AudioEngine) {}

  set(state: MusicState): void {
    if (state === this.current) return;
    this.current = state;
    const ac = this.eng.ac;
    const now = ac.currentTime;
    const fade = FADE[state];
    for (const tr of this.tracks) {
      if (tr.stopAt !== Infinity) continue;
      for (const f of tr.fades) {
        const g = f.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + Math.max(0.3, fade));
      }
      tr.stopAt = now + Math.max(0.3, fade);
    }
    this.tracks.push(this.createTrack(state, now));
    if (this.timer === null) this.timer = setInterval(this.tick, TICK_MS);
    this.tick();
  }

  /**
   * Optional: boss phase (1..3). Phase 2 doubles the lead an octave up, phase 3 adds a tritone
   * harmony. Without calls the boss stays at phase 1.
   */
  setBossPhase(phase: number): void {
    this.intensity = Math.max(1, Math.min(3, Math.round(phase)));
    for (const tr of this.tracks) tr.song.intensity = this.intensity;
  }

  private getChain(): Chain {
    if (this.chain) return this.chain;
    const ac = this.eng.ac;
    const nodes: AudioNode[] = [];
    const mk = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };
    const input = mk(ac.createGain());
    input.gain.value = 0.5; // tape curve spans ±2 of input
    const tape = mk(ac.createWaveShaper());
    tape.curve = tapeCurve();
    const glue = mk(ac.createDynamicsCompressor());
    glue.threshold.value = -20;
    glue.knee.value = 8;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    const makeup = mk(ac.createGain());
    makeup.gain.value = 1.5;
    const lim = mk(ac.createDynamicsCompressor());
    lim.threshold.value = -6;
    lim.knee.value = 2;
    lim.ratio.value = 20;
    lim.attack.value = 0.0015;
    lim.release.value = 0.1;
    const pre = mk(ac.createGain());
    pre.gain.value = 1 / CEIL_RANGE;
    const ceil = mk(ac.createWaveShaper());
    ceil.curve = ceilingCurve();
    input.connect(tape);
    tape.connect(glue);
    glue.connect(makeup);
    makeup.connect(lim);
    lim.connect(pre);
    const trim = mk(ac.createGain());
    trim.gain.value = OUT_TRIM;
    pre.connect(ceil);
    ceil.connect(trim);
    trim.connect(this.eng.music);
    const verbIn = mk(ac.createConvolver());
    verbIn.buffer = reverbIR(ac);
    const verbRet = mk(ac.createGain());
    verbRet.gain.value = 0.5;
    verbIn.connect(verbRet);
    verbRet.connect(input);
    this.chain = { input, verbIn, nodes };
    return this.chain;
  }

  private createTrack(state: MusicState, now: number): Track {
    const ac = this.eng.ac;
    const chain = this.getChain();
    const stepDur = 60 / BPM[state] / 4;
    const fade = FADE[state];
    const out = ac.createGain();
    const verb = ac.createGain();
    for (const g of [out, verb]) {
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(LEVEL[state], now + fade);
    }
    out.connect(chain.input);
    verb.connect(chain.verbIn);
    const rig = new Rig(ac, out, verb, { ...RIG[state], delay: stepDur * 3 });
    return {
      state,
      rig,
      song: { form: (state === 'boss' ? BOSS_FORMS : WAVE_FORMS)[0], formIdx: 0, root: ROOT, phrase: 0, lead: LEADS[0], intensity: this.intensity },
      fades: [out, verb],
      nodes: [out, verb, ...rig.nodes],
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
          PATTERNS[tr.state]({
            r: tr.rig, step: tr.step, s: tr.step % 16, bar: Math.floor(tr.step / 16), t: tr.next, sd: tr.stepDur, song: tr.song,
          });
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
    if (this.chain) for (const n of this.chain.nodes) n.disconnect();
    this.chain = null;
    this.current = null;
  }
}
