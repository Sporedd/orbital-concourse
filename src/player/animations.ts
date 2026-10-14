/**
 * Viewmodel animation clips (PLAN §13 "Animations"): per-archetype reloads and the grenade throw.
 *
 * Pure keyframe data + samplers; src/player/viewmodel.ts owns the rig (tagged gun parts, the
 * off-hand, shells, grenade) and applies a clip on top of the procedural pose (sway, bob, recoil,
 * ADS, swap, bash), additively.
 *
 * Reload clips run in NORMALISED time u = t / duration, so they always fill whatever duration the
 * weapon system passes (reloadTime × stats). Throw keys are in seconds (THROW_TIME).
 *
 * Units: gun pose channels are pivot offsets (camera-local viewmodel units, radians); part channels
 * are model-space offsets (pivot units: the gun group sits at identity inside the pivot).
 */
import * as THREE from 'three';
import type { WeaponArchetype } from '@/core/types';

// ---- easing / keys ----------------------------------------------------------
export type Ease = (t: number) => number;

const BACK = 1.70158;
export const ease = {
  lin: (t: number) => t,
  /** smoothstep: the default in-between */
  io: (t: number) => t * t * (3 - 2 * t),
  /** fast start, soft landing */
  out: (t: number) => 1 - (1 - t) ** 3,
  /** slow start, hard landing (snaps, falls, impacts) */
  in: (t: number) => t ** 3,
  /** overshoots the target by ~10 % then settles on it (zero velocity at the end) */
  back: (t: number) => {
    const x = t - 1;
    return 1 + (BACK + 1) * x * x * x + BACK * x * x;
  },
} as const;
const { io: IO, out: O, in: I, back: B } = ease;

/** [time, value, ease used to arrive at this key (default smoothstep)]. Times non-decreasing. */
export type Key = readonly [t: number, v: number, e?: Ease];

/** Sample a key track at t (clamped to the first/last key). Missing track = 0. */
export function sample(keys: readonly Key[] | undefined, t: number): number {
  if (!keys || keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const k1 = keys[i];
    if (t <= k1[0]) {
      const k0 = keys[i - 1];
      const span = k1[0] - k0[0];
      const k = span > 0 ? (t - k0[0]) / span : 1;
      return k0[1] + (k1[1] - k0[1]) * (k1[2] ?? IO)(k);
    }
  }
  return keys[keys.length - 1][1];
}

export type Span = readonly [from: number, to: number];
export const inSpans = (spans: readonly Span[] | undefined, u: number) => !!spans?.some(([a, b]) => u >= a && u < b);

// ---- hand keys ----------------------------------------------------------------
/**
 * Where the off-hand is, relative to a (moving) rig point, so it follows the magazine, slide,
 * handle, pump or bolt and adapts to grown parts. 'off' = below the screen.
 */
export type Anchor = 'off' | 'mag' | 'slide' | 'handle' | 'pump' | 'bolt' | 'port';
export type HandKey = readonly [t: number, anchor: Anchor, dx: number, dy: number, dz: number, e?: Ease];
export type AnchorResolver = (a: Anchor, out: THREE.Vector3) => THREE.Vector3;

const hA = new THREE.Vector3();
const hB = new THREE.Vector3();
function handPoint(k: HandKey, resolve: AnchorResolver, out: THREE.Vector3): THREE.Vector3 {
  resolve(k[1], out);
  out.x += k[2];
  out.y += k[3];
  out.z += k[4];
  return out;
}

/** Sample the off-hand position: both ends of the segment are resolved against the CURRENT rig. */
export function sampleHand(keys: readonly HandKey[], u: number, resolve: AnchorResolver, out: THREE.Vector3): THREE.Vector3 {
  if (u <= keys[0][0]) return handPoint(keys[0], resolve, out);
  for (let i = 1; i < keys.length; i++) {
    const k1 = keys[i];
    if (u <= k1[0]) {
      const k0 = keys[i - 1];
      const span = k1[0] - k0[0];
      const k = span > 0 ? (u - k0[0]) / span : 1;
      handPoint(k0, resolve, hA);
      handPoint(k1, resolve, hB);
      return out.copy(hA).lerp(hB, (k1[5] ?? IO)(k));
    }
  }
  return handPoint(keys[keys.length - 1], resolve, out);
}

// ---- clips ----------------------------------------------------------------------
export interface PoseTracks {
  px?: Key[]; py?: Key[]; pz?: Key[];
  rx?: Key[]; ry?: Key[]; rz?: Key[];
}

export interface ReloadClip {
  archetype: WeaponArchetype;
  /** Named phase starts (u), for docs/tests/tuning. */
  phases: readonly (readonly [name: string, u: number])[];
  /** Additive gun pose. Every channel starts and ends at 0. */
  gun: PoseTracks;
  /** Magazine travel along its own down axis (+ = out of the well). */
  magDrop?: Key[];
  /** Magazine rock about its top-front edge (+ = bottom swings forward). */
  magTilt?: Key[];
  /** Magazine hidden (dropped away / not yet in hand) while u is inside. */
  magHidden?: Span[];
  /** Rear travel (+z) of the pistol slide, charging handle, pump forend, sniper bolt. */
  slide?: Key[];
  handle?: Key[];
  pump?: Key[];
  boltBack?: Key[];
  /** Sniper bolt handle lift about the bore axis (rad). */
  boltLift?: Key[];
  hand: HandKey[];
  handRot?: PoseTracks;
  /** A shell is in the off-hand while u is inside one of these. */
  shells?: Span[];
}

/** Sniper reloads at least this long also swap the magazine (shorter = thumb a round in). */
export const SNIPER_MAG_SWAP_MIN = 1.8;

/** Shells the shotgun tube reload shows (2-4, scaled with the duration). */
export function shotgunShellCount(duration: number): number {
  return duration < 1 ? 2 : duration < 1.6 ? 3 : 4;
}

function pistolClip(): ReloadClip {
  return {
    archetype: 'pistol',
    phases: [['tilt', 0], ['mag out', 0.2], ['new mag up', 0.36], ['seat', 0.5], ['slide rack', 0.64], ['settle', 0.82]],
    // the grip sits near the bottom edge: the gun comes UP and in so the mag well stays on screen
    gun: {
      px: [[0, 0], [0.2, -0.08], [0.6, -0.08], [0.7, -0.05], [0.84, -0.04], [1, 0, B]],
      py: [[0, 0], [0.06, -0.015, O], [0.2, 0.12], [0.5, 0.12], [0.53, 0.14, O], [0.6, 0.12], [0.7, 0.05], [0.78, 0.05], [0.8, 0.065, O], [0.86, 0.05], [1, 0, B]],
      pz: [[0, 0], [0.2, -0.08], [0.6, -0.08], [0.7, -0.04], [0.86, -0.04], [1, 0, B]],
      rx: [[0, 0], [0.06, -0.05, O], [0.2, 0.3], [0.5, 0.3], [0.53, 0.38, O], [0.6, 0.3], [0.68, 0.1], [0.78, 0.1], [0.8, 0.17, O], [0.86, 0.1], [1, 0, B]],
      ry: [[0, 0], [0.6, 0], [0.68, -0.25], [0.84, -0.2], [1, 0, B]],
      rz: [[0, 0], [0.06, 0.04, O], [0.2, -0.45], [0.58, -0.45], [0.68, 0.3], [0.84, 0.3], [1, 0, B]],
    },
    magDrop: [[0, 0], [0.2, 0], [0.24, 0.035, O], [0.34, 0.55, I], [0.38, 0.5], [0.47, 0.06, O], [0.5, 0.025], [0.53, -0.006, O], [0.57, 0]],
    magHidden: [[0.33, 0.38]],
    slide: [[0, 0], [0.71, 0], [0.78, 0.065, O], [0.79, 0.065], [0.81, 0, I], [0.83, -0.004], [0.86, 0]],
    hand: [
      [0, 'off', 0, 0, 0], [0.3, 'off', 0, 0, 0], [0.38, 'mag', 0, -0.005, 0, O], [0.57, 'mag', 0, -0.005, 0],
      [0.62, 'mag', -0.03, -0.05, 0.04], [0.69, 'slide', -0.06, 0.04, 0], [0.71, 'slide', -0.055, 0.035, 0], [0.79, 'slide', -0.055, 0.035, 0],
      [0.83, 'slide', -0.1, 0.12, 0.1, O], [0.96, 'off', 0, 0, 0, I], [1, 'off', 0, 0, 0],
    ],
    handRot: { rz: [[0, 0], [0.6, 0], [0.69, -0.9], [0.83, -0.9], [0.96, 0]] },
  };
}

function smgClip(): ReloadClip {
  return {
    archetype: 'smg',
    phases: [['tilt', 0], ['grab mag', 0.08], ['mag out', 0.16], ['new mag up', 0.36], ['seat', 0.5], ['charging handle', 0.62], ['settle', 0.82]],
    gun: {
      px: [[0, 0], [0.16, -0.03], [0.6, -0.03], [0.68, 0], [1, 0, B]],
      py: [[0, 0], [0.06, -0.012, O], [0.16, 0.05], [0.2, 0.04], [0.24, 0.055, O], [0.3, 0.045], [0.5, 0.045], [0.53, 0.065, O], [0.58, 0.045], [0.66, 0], [0.78, 0], [0.8, 0.012, O], [0.86, 0], [1, 0, B]],
      pz: [[0, 0], [0.16, -0.05], [0.6, -0.05], [0.68, 0.02], [0.82, 0.02], [1, 0, B]],
      rx: [[0, 0], [0.06, -0.05, O], [0.16, 0.12], [0.5, 0.12], [0.53, 0.2, O], [0.58, 0.1], [0.66, -0.04], [0.78, -0.04], [0.8, 0.04, O], [0.86, -0.02], [1, 0, B]],
      ry: [[0, 0], [0.6, 0], [0.68, 0.18], [0.84, 0.14], [1, 0, B]],
      rz: [[0, 0], [0.06, 0.04, O], [0.16, -0.45], [0.58, -0.45], [0.66, 0.15], [0.84, 0.15], [1, 0, B]],
    },
    magDrop: [[0, 0], [0.16, 0], [0.24, 0.11, O], [0.27, 0.13], [0.36, 0.7, I], [0.4, 0.65], [0.47, 0.08, O], [0.5, 0.035], [0.53, -0.008, O], [0.57, 0]],
    magHidden: [[0.35, 0.4]],
    handle: [[0, 0], [0.71, 0], [0.78, 0.09, O], [0.79, 0.09], [0.81, 0, I], [0.83, -0.005], [0.86, 0]],
    hand: [
      [0, 'off', 0, 0, 0], [0.06, 'off', 0, 0, 0], [0.14, 'mag', 0, 0.02, 0, O], [0.27, 'mag', 0, 0.02, 0],
      [0.33, 'mag', -0.06, 0.02, 0.06, I], [0.4, 'mag', 0, 0.02, 0], [0.57, 'mag', 0, 0.02, 0], [0.61, 'mag', -0.03, -0.03, 0.05],
      [0.68, 'handle', -0.04, 0, 0.01], [0.71, 'handle', -0.035, 0, 0], [0.79, 'handle', -0.035, 0, 0],
      [0.83, 'handle', -0.1, 0.08, 0.1, O], [0.96, 'off', 0, 0, 0, I], [1, 'off', 0, 0, 0],
    ],
    handRot: { rz: [[0, 0], [0.6, 0], [0.68, -0.6], [0.83, -0.6], [0.96, 0]] },
  };
}

function rifleClip(): ReloadClip {
  return {
    archetype: 'rifle',
    phases: [['tilt', 0], ['mag out', 0.16], ['new mag up', 0.38], ['rock in', 0.5], ['handle slap', 0.64], ['settle', 0.84]],
    gun: {
      px: [[0, 0], [0.16, -0.03], [0.62, -0.03], [0.7, 0], [1, 0, B]],
      py: [[0, 0], [0.06, -0.012, O], [0.16, 0.0], [0.54, 0.0], [0.57, 0.02, O], [0.62, 0.0], [0.7, -0.045], [0.72, -0.045], [0.74, -0.06, O], [0.78, -0.045], [0.8, -0.032, O], [0.86, -0.045], [1, 0, B]],
      pz: [[0, 0], [0.16, -0.03], [0.62, -0.03], [0.7, 0.03], [0.84, 0.03], [1, 0, B]],
      rx: [[0, 0], [0.06, -0.05, O], [0.16, 0.1], [0.5, 0.1], [0.56, 0.18, O], [0.62, 0.08], [0.7, -0.02], [0.73, -0.06, O], [0.78, -0.02], [0.8, 0.05, O], [0.86, 0], [1, 0, B]],
      rz: [[0, 0], [0.06, 0.04, O], [0.16, -0.45], [0.6, -0.45], [0.68, 0.2], [0.86, 0.2], [1, 0, B]],
    },
    magTilt: [[0, 0], [0.18, 0], [0.24, 0.3, O], [0.34, 0.35], [0.4, 0.3], [0.5, 0.3], [0.56, -0.04, O], [0.6, 0]],
    magDrop: [[0, 0], [0.2, 0], [0.26, 0.04, O], [0.36, 0.6, I], [0.4, 0.55], [0.5, 0.03, O], [0.54, -0.006, O], [0.58, 0]],
    magHidden: [[0.35, 0.4]],
    handle: [[0, 0], [0.73, 0], [0.78, 0.07, O], [0.79, 0.07], [0.81, 0, I], [0.83, -0.004], [0.86, 0]],
    hand: [
      [0, 'off', 0, 0, 0], [0.08, 'off', 0, 0, 0], [0.16, 'mag', 0, 0, 0, O], [0.26, 'mag', 0, 0, 0],
      [0.32, 'mag', -0.08, 0.06, 0.06, O], [0.4, 'mag', 0, 0, 0, I], [0.58, 'mag', 0, 0, 0], [0.62, 'mag', -0.03, -0.04, 0.04],
      [0.7, 'handle', -0.03, 0.07, 0.02], [0.73, 'handle', 0, 0.025, 0, I], [0.79, 'handle', 0, 0.025, 0],
      [0.83, 'handle', -0.06, 0.12, 0.08, O], [0.96, 'off', 0, 0, 0, I], [1, 'off', 0, 0, 0],
    ],
    handRot: { rx: [[0, 0], [0.62, 0], [0.7, 0.5], [0.83, 0.5], [0.96, 0]], rz: [[0, 0], [0.62, 0], [0.7, -1.2], [0.83, -1.2], [0.96, 0]] },
  };
}

function sniperClip(duration: number): ReloadClip {
  if (duration >= SNIPER_MAG_SWAP_MIN) {
    return {
      archetype: 'sniper',
      phases: [['roll', 0], ['bolt up', 0.08], ['bolt back', 0.15], ['mag out', 0.28], ['new mag up', 0.44], ['seat', 0.56], ['bolt forward', 0.68], ['bolt down', 0.76], ['settle', 0.84]],
      gun: {
        px: [[0, 0], [0.14, -0.03], [0.84, -0.03], [1, 0, B]],
        py: [[0, 0], [0.06, 0.01, O], [0.14, -0.04], [0.22, -0.04], [0.25, -0.03, O], [0.3, -0.05], [0.58, -0.05], [0.61, -0.03, O], [0.66, -0.045], [0.74, -0.045], [0.76, -0.032, O], [0.8, -0.045], [1, 0, B]],
        pz: [[0, 0], [0.14, 0.03], [0.22, 0.03], [0.25, 0.045, O], [0.3, 0.03], [0.84, 0.03], [1, 0, B]],
        rx: [[0, 0], [0.06, -0.04, O], [0.14, 0.08], [0.58, 0.08], [0.61, 0.14, O], [0.66, 0.06], [0.84, 0.06], [1, 0, B]],
        rz: [[0, 0], [0.06, -0.04, O], [0.14, 0.4], [0.28, 0.4], [0.34, -0.2], [0.64, -0.2], [0.7, 0.4], [0.84, 0.4], [1, 0, B]],
      },
      boltLift: [[0, 0], [0.08, 0], [0.15, 1.2, O], [0.76, 1.2], [0.81, -0.06, O], [0.84, 0]],
      boltBack: [[0, 0], [0.15, 0], [0.23, 0.11, O], [0.68, 0.11], [0.74, -0.004, I], [0.76, 0]],
      magDrop: [[0, 0], [0.3, 0], [0.34, 0.03, O], [0.42, 0.5, I], [0.46, 0.45], [0.54, 0.03, O], [0.58, -0.005, O], [0.62, 0]],
      magHidden: [[0.41, 0.46]],
      hand: [
        [0, 'off', 0, 0, 0], [0.03, 'off', 0, 0, 0], [0.08, 'bolt', 0, 0, 0, O], [0.24, 'bolt', 0, 0, 0],
        [0.3, 'mag', 0, 0, 0], [0.38, 'mag', 0, 0, 0], [0.46, 'mag', 0, 0, 0], [0.62, 'mag', 0, 0, 0],
        [0.67, 'bolt', 0, 0.01, 0.01], [0.68, 'bolt', 0, 0, 0], [0.83, 'bolt', 0, 0, 0],
        [0.87, 'bolt', -0.06, 0.1, 0.08, O], [0.98, 'off', 0, 0, 0, I], [1, 'off', 0, 0, 0],
      ],
    };
  }
  // short (stat-boosted) reload: no mag swap, a round is thumbed into the open action
  return {
    archetype: 'sniper',
    phases: [['roll', 0], ['bolt up', 0.08], ['bolt back', 0.15], ['load round', 0.28], ['bolt forward', 0.54], ['bolt down', 0.64], ['settle', 0.72]],
    gun: {
      px: [[0, 0], [0.14, -0.03], [0.72, -0.03], [1, 0, B]],
      py: [[0, 0], [0.06, 0.01, O], [0.14, -0.04], [0.23, -0.04], [0.26, -0.03, O], [0.3, -0.045], [0.4, -0.045], [0.42, -0.035, O], [0.46, -0.045], [0.6, -0.045], [0.62, -0.032, O], [0.66, -0.045], [1, 0, B]],
      pz: [[0, 0], [0.14, 0.03], [0.72, 0.03], [1, 0, B]],
      rx: [[0, 0], [0.06, -0.04, O], [0.14, 0.08], [0.72, 0.08], [1, 0, B]],
      rz: [[0, 0], [0.06, -0.04, O], [0.14, 0.4], [0.72, 0.4], [1, 0, B]],
    },
    boltLift: [[0, 0], [0.08, 0], [0.15, 1.2, O], [0.64, 1.2], [0.69, -0.06, O], [0.72, 0]],
    boltBack: [[0, 0], [0.15, 0], [0.24, 0.11, O], [0.54, 0.11], [0.61, -0.004, I], [0.63, 0]],
    hand: [
      [0, 'off', 0, 0, 0], [0.03, 'off', 0, 0, 0], [0.08, 'bolt', 0, 0, 0, O], [0.25, 'bolt', 0, 0, 0],
      [0.34, 'port', 0, 0.04, 0, O], [0.38, 'port', 0, 0.04, 0], [0.42, 'port', 0, 0, 0, I], [0.46, 'port', 0, 0.04, 0, O],
      [0.52, 'bolt', 0, 0, 0], [0.71, 'bolt', 0, 0, 0], [0.75, 'bolt', -0.06, 0.1, 0.08, O], [0.9, 'off', 0, 0, 0, I], [1, 'off', 0, 0, 0],
    ],
    shells: [[0.3, 0.42]],
  };
}

function shotgunClip(duration: number): ReloadClip {
  const n = shotgunShellCount(duration);
  const start = 0.12;
  const L = 0.66 / n;
  const end = start + n * L; // 0.78
  // the off-hand dips to a "belt" point just off the lower edge between shells
  const belt = [-0.1, -0.2, 0.1] as const;
  const hand: HandKey[] = [[0, 'off', 0, 0, 0], [start, 'port', ...belt, O]];
  // the gun rolls onto its side and comes up so the loading port stays on screen
  const Y = 0.08;
  const X = 0.22;
  const py: Key[] = [[0, 0], [0.05, -0.012, O], [start, Y]];
  const rx: Key[] = [[0, 0], [0.05, -0.05, O], [start, X]];
  const shells: Span[] = [];
  const phases: [string, number][] = [['tilt', 0]];
  for (let i = 0; i < n; i++) {
    const s0 = start + i * L;
    const push = s0 + 0.7 * L;
    phases.push([`shell ${i + 1}`, s0]);
    hand.push([s0 + 0.45 * L, 'port', 0, -0.035, 0.03], [push, 'port', 0, -0.005, -0.03, O], [s0 + L, 'port', ...belt, I]);
    py.push([push - 0.01, Y], [push + 0.015, Y + 0.012, O], [s0 + L, Y]);
    rx.push([push - 0.01, X], [push + 0.015, X + 0.04, O], [s0 + L, X]);
    shells.push([s0, push]);
  }
  phases.push(['pump', 0.84], ['settle', 0.95]);
  hand.push([0.84, 'pump', 0, -0.03, 0], [0.95, 'pump', 0, -0.03, 0], [1, 'off', 0, 0, 0, I]);
  py.push([0.84, -0.03], [0.88, -0.02], [0.93, -0.045, I], [1, 0, B]);
  rx.push([0.84, 0.04], [0.93, 0.06], [0.95, 0.1, O], [1, 0, B]);
  return {
    archetype: 'shotgun',
    phases,
    gun: {
      px: [[0, 0], [start, -0.05], [end, -0.05], [0.84, 0], [1, 0, B]],
      py,
      pz: [[0, 0], [start, -0.06], [end, -0.06], [0.84, 0.03], [0.93, 0.03], [1, 0, B]],
      rx,
      rz: [[0, 0], [0.05, 0.04, O], [start, -0.5], [end, -0.5], [0.84, 0.12], [1, 0, B]],
    },
    pump: [[0, 0], [0.86, 0], [0.89, 0.07, O], [0.9, 0.07], [0.93, 0, I], [0.95, -0.004], [0.97, 0]],
    hand,
    handRot: { rx: [[0, 0], [start, 0.25], [end, 0.25], [0.84, 0]] },
    shells,
  };
}

export function reloadClip(archetype: WeaponArchetype, duration: number): ReloadClip {
  switch (archetype) {
    case 'pistol': return pistolClip();
    case 'smg': return smgClip();
    case 'shotgun': return shotgunClip(duration);
    case 'sniper': return sniperClip(duration);
    default: return rifleClip();
  }
}

// ---- grenade throw --------------------------------------------------------------
/** Visual length of the throw (≈ the grenade cooldown). */
export const THROW_TIME = 0.6;
/** When the grenade leaves the hand (s). */
export const THROW_RELEASE = 0.25;

/** Throw clip, keys in seconds. Hand keys are viewmodel-root positions (camera-local units). */
export const THROW_CLIP = {
  gun: {
    px: [[0, 0], [0.16, 0.06], [0.3, 0.07], [0.46, 0.01], [0.6, 0, B]],
    py: [[0, 0], [0.05, 0.015, O], [0.16, -0.16], [0.3, -0.18], [0.46, -0.03, O], [0.6, 0, B]],
    pz: [[0, 0], [0.16, 0.05], [0.25, 0.08, O], [0.4, 0.03], [0.6, 0, B]],
    rx: [[0, 0], [0.05, 0.04, O], [0.16, -0.35], [0.3, -0.4], [0.46, -0.05], [0.6, 0, B]],
    ry: [[0, 0], [0.16, -0.25], [0.3, -0.3], [0.46, -0.04], [0.6, 0, B]],
    rz: [[0, 0], [0.16, -0.4], [0.3, -0.45], [0.46, -0.05], [0.6, 0, B]],
  } satisfies PoseTracks,
  hand: {
    px: [[0, -0.72], [0.16, -0.77, O], [0.22, -0.82], [THROW_RELEASE, -0.52, I], [0.33, -0.32, O], [0.46, -0.47], [0.6, -0.72]],
    py: [[0, -0.6], [0.16, 0.33, O], [0.22, 0.4], [THROW_RELEASE, 0.42, I], [0.33, 0.0, O], [0.46, -0.6, I], [0.6, -0.6]],
    pz: [[0, 0.06], [0.16, -0.14, O], [0.22, -0.04], [THROW_RELEASE, -0.29, I], [0.33, -0.24, O], [0.46, 0.06], [0.6, 0.06]],
    rx: [[0, -0.4], [0.16, 0.25], [0.22, 0.4], [THROW_RELEASE, -0.2, I], [0.33, -0.7, O], [0.46, -0.6], [0.6, -0.4]],
    ry: [[0, 0], [0.16, 0.3], [0.22, 0.4], [THROW_RELEASE, 0, I], [0.46, -0.2], [0.6, 0]],
    rz: [[0, 0], [0.16, -0.3], [THROW_RELEASE, 0.1], [0.6, 0]],
  } satisfies PoseTracks,
  /** Release velocity / gravity of the visual grenade (root units/s, toward the camera forward). */
  velocity: new THREE.Vector3(0.45, 1.1, -7.5),
  gravity: -5.5,
  /** The visual grenade hides once it is this far along (s after release); the real one is in the world. */
  flight: 0.24,
} as const;
