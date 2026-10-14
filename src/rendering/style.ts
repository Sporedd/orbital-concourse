/**
 * Orbital Concourse — Brutalist Arena style data (docs/ART_DIRECTION.md).
 * One place for the palette, per-league numbers and the luminance-target glow helper.
 * World, sky, crowd, loot, fx and UI all read from here. Data only (no THREE import),
 * so headless code (tests, sim) can use it.
 */
import type { Rarity } from '@/core/types';

/** §1.1 / §1.4 tokens (sRGB hex). */
export const PALETTE = {
  SHADOW: 0x1c1e21,
  CONCRETE_DARK: 0x4a4a48,
  CONCRETE: 0x6f6d68,
  CONCRETE_LIT: 0x9a978f,
  STEEL: 0x4e555c,
  STEEL_DARK: 0x2a2c2f,
  HAZE: 0x3a3d42,
  HAZE_LIT: 0xa9abad,
  FLOODLIGHT: 0xf3eedf,
  FLOODLIGHT_VOID: 0xe6e2ff,
  HAZARD_PAINT: 0xc9a227,
  THREAT: 0xff2238,
  BONE: 0xeceae4,
  ARMOUR: 0x4e5249,
  ARMOUR_LIT: 0x6e7366,
  UNDERSUIT: 0x2d302a,
  LAMP_IDLE: 0x5a5c5e,
} as const;

export type LeagueKey = 'scrap' | 'iron' | 'steel' | 'star' | 'void';
export const LEAGUE_ORDER: readonly LeagueKey[] = ['scrap', 'iron', 'steel', 'star', 'void'];

export type PlanetMode = 'none' | 'quarter' | 'half' | 'large' | 'eclipse';

export interface LeagueStyle {
  id: LeagueKey;
  name: string;
  accent: number;
  /** Floodlight towers on the top tier. */
  towers: number;
  /** Real SpotLights (high quality); the rest get pools only. */
  spots: number;
  floodColor: number;
  fogDensity: number;
  shaftIntensity: number;
  /** Crowd instances. */
  crowd: number;
  /** How full the stands look (0..1), used to thin the seating rows. */
  crowdFill: number;
  crowdFlashMult: number;
  planet: PlanetMode;
  /** Concrete base albedo (Void: black monolith). */
  concrete: number;
  /** Floor sheen (Star: polished). */
  floorSheen: number;
  /** LED ribbon along the wall coping. */
  ribbon: boolean;
  /** Accent inlay ring in the plinth. */
  plinthInlay: boolean;
  /** Accent floor ring (Void). */
  floorRing: boolean;
  /** Scoreboard: single panel or 4-face cube. */
  cubeBoard: boolean;
  /** One tower flickers (Scrap). */
  flicker: boolean;
}

export const LEAGUE_STYLE: Record<LeagueKey, LeagueStyle> = {
  scrap: {
    id: 'scrap', name: 'SCRAP LEAGUE', accent: 0xff5f1f, towers: 2, spots: 2, floodColor: PALETTE.FLOODLIGHT,
    fogDensity: 0.016, shaftIntensity: 0.16, crowd: 1500, crowdFill: 0.25, crowdFlashMult: 1, planet: 'none',
    concrete: PALETTE.CONCRETE, floorSheen: 0, ribbon: false, plinthInlay: false, floorRing: false, cubeBoard: false, flicker: true,
  },
  iron: {
    id: 'iron', name: 'IRON LEAGUE', accent: 0xffc61a, towers: 4, spots: 4, floodColor: PALETTE.FLOODLIGHT,
    fogDensity: 0.013, shaftIntensity: 0.13, crowd: 3000, crowdFill: 0.45, crowdFlashMult: 1, planet: 'quarter',
    concrete: PALETTE.CONCRETE, floorSheen: 0, ribbon: true, plinthInlay: false, floorRing: false, cubeBoard: false, flicker: false,
  },
  steel: {
    id: 'steel', name: 'STEEL LEAGUE', accent: 0x1fd1c1, towers: 4, spots: 4, floodColor: PALETTE.FLOODLIGHT,
    fogDensity: 0.011, shaftIntensity: 0.12, crowd: 5000, crowdFill: 0.65, crowdFlashMult: 1, planet: 'half',
    concrete: PALETTE.CONCRETE, floorSheen: 0, ribbon: true, plinthInlay: true, floorRing: false, cubeBoard: true, flicker: false,
  },
  star: {
    id: 'star', name: 'STAR LEAGUE', accent: 0xe8368f, towers: 6, spots: 6, floodColor: PALETTE.FLOODLIGHT,
    fogDensity: 0.009, shaftIntensity: 0.12, crowd: 7500, crowdFill: 0.85, crowdFlashMult: 2, planet: 'large',
    concrete: PALETTE.CONCRETE, floorSheen: 0.2, ribbon: true, plinthInlay: true, floorRing: false, cubeBoard: true, flicker: false,
  },
  void: {
    id: 'void', name: 'VOID LEAGUE', accent: 0x8c6cff, towers: 8, spots: 8, floodColor: PALETTE.FLOODLIGHT_VOID,
    fogDensity: 0.006, shaftIntensity: 0.10, crowd: 10000, crowdFill: 1, crowdFlashMult: 2, planet: 'eclipse',
    concrete: 0x2e2f33, floorSheen: 0.2, ribbon: true, plinthInlay: true, floorRing: true, cubeBoard: true, flicker: false,
  },
};

export const DEFAULT_LEAGUE: LeagueKey = 'scrap';

/** Spec SpotLight counts per league (LEAGUE_STYLE[].spots is capped by the quality preset). */
const SPEC_SPOTS: Record<LeagueKey, number> = { scrap: 2, iron: 4, steel: 4, star: 6, void: 8 };

// ---------------------------------------------------------------------------
// Quality preset (§5: "Low-quality preset: max 4 real spots, the rest pools only")
// ---------------------------------------------------------------------------
export type Quality = 'high' | 'low';

export interface QualitySettings {
  /** Real SpotLights per league at most (the rest keep their shaft + pool). */
  maxSpots: number;
  shadowMapSize: number;
  /** Dust motes per floodlight shaft (spec 30). */
  shaftMotes: number;
  /** Bloom resolution scale (UnrealBloom mips are the main post cost). */
  bloomScale: number;
}

export const QUALITY_PRESETS: Record<Quality, QualitySettings> = {
  high: { maxSpots: 8, shadowMapSize: 2048, shaftMotes: 30, bloomScale: 1 },
  low: { maxSpots: 4, shadowMapSize: 1024, shaftMotes: 12, bloomScale: 0.5 },
};

function readQuality(): Quality {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;
    if (q === 'low' || q === 'high') return q;
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem('concourse.quality') : null;
    if (s === 'low' || s === 'high') return s;
  } catch {
    /* no storage / location (tests) */
  }
  return 'high';
}

/**
 * Current quality. Read once at boot (?quality=low or localStorage 'concourse.quality');
 * set it before the world and the pipeline are built. Data only: the pipeline reads
 * shadowMapSize/bloomScale, shafts read shaftMotes, the world reads the capped `spots`.
 */
export const STYLE = {
  quality: readQuality() as Quality,
  /** Kept for the spec's "ink = false" switch (the outline pass is not in the chain). */
  ink: false,
  get q(): QualitySettings {
    return QUALITY_PRESETS[this.quality];
  },
};

/** Switch the preset (persists). Applies the spot cap to LEAGUE_STYLE; a league change re-applies it in the world. */
export function setQuality(q: Quality): void {
  STYLE.quality = q;
  try {
    localStorage.setItem('concourse.quality', q);
  } catch {
    /* ignore */
  }
  applySpotCap();
}

function applySpotCap(): void {
  for (const k of LEAGUE_ORDER) LEAGUE_STYLE[k].spots = Math.min(SPEC_SPOTS[k], STYLE.q.maxSpots);
}
applySpotCap();

// ---------------------------------------------------------------------------
// Light rig (§5), in three.js physical units (r155+): a lit albedo-a surface under a light of
// intensity I reflects a · I / π, so these numbers are the spec's intent (shadow faces read as
// mid-dark grey, not black), not its legacy-unit values.
//   key-lit CONCRETE ≈ 0.25 lum, back-faces ≈ 0.08 (3:1), cast-shadowed floor ≈ 0.03 (before
//   grade) — shadow faces stay readable mid-dark grey, the stands stay darker than the pit.
// ---------------------------------------------------------------------------
export const LIGHT = {
  key: 4.2,
  hemiSky: 0x3a3e45,
  hemiGround: 0x6f6d68,
  /** Hemisphere intensity: E(vertical face) = I · lum(mix(sky, ground)) / π ≈ 0.24. */
  hemi: 7.5,
  /** Flat ambient in the HAZE colour (scattered floodlight in the haze): E ≈ 0.045. */
  ambientColor: 0x3a3d42,
  ambient: 3.0,
  exposure: 1.0,
  /** Shared gain on the floodlight shafts (see shafts.ts). */
  shaftGain: 3.6,
  /** Ground haze quad alpha / stand haze band total alpha (§5.1: 0.08 / 0.18). */
  groundHaze: 0.08,
  standHaze: 0.18,
} as const;

export function leagueStyle(id: string | undefined | null): LeagueStyle {
  return (id && (LEAGUE_STYLE as Record<string, LeagueStyle>)[id]) || LEAGUE_STYLE[DEFAULT_LEAGUE];
}

// ---------------------------------------------------------------------------
// Luminance helpers (§1, §2.4)
// ---------------------------------------------------------------------------
const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** Linear luminance of an sRGB hex colour. */
export function lumLinear(hex: number): number {
  return 0.2126 * toLinear((hex >> 16) & 0xff) + 0.7152 * toLinear((hex >> 8) & 0xff) + 0.0722 * toLinear(hex & 0xff);
}

/**
 * glow() intensity that puts `hex` at a linear luminance target. Architecture accents clamp
 * at 4 (§1.2). Threat/loot/fx pass a higher clamp: a saturated red needs ×6+ to reach lum 1.5.
 */
export function glowLum(hex: number, targetLum: number, maxIntensity = 4): number {
  return Math.min(maxIntensity, targetLum / Math.max(lumLinear(hex), 1e-4));
}

/** §2.4 emissive tiers (target linear luminance). */
export const LUM = {
  board: 0.9,
  accent: 1.1,
  visor: 1.5,
  weak: 2.5,
  lamp: 3.0,
  flash: 6.5,
  seam: 1.2,
} as const;

/** §9 beam table. */
export const BEAM: Record<Rarity, { height: number; sheath: number; core: number; motes: boolean; double: boolean }> = {
  common: { height: 2.5, sheath: 0.35, core: 1.2, motes: false, double: false },
  uncommon: { height: 4, sheath: 0.5, core: 2.0, motes: false, double: false },
  rare: { height: 5.5, sheath: 0.6, core: 2.6, motes: true, double: false },
  epic: { height: 7, sheath: 0.7, core: 3.2, motes: true, double: false },
  legendary: { height: 10, sheath: 0.8, core: 4.0, motes: true, double: true },
};

/** CSS hex string. */
export const css = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

/** Weapon manufacturer words used on sponsor plates (from the loot name generator). */
export const SPONSOR_WORDS = ['JAKKO', 'VEXLIN', 'KORD', 'SABLE', 'BRISK', 'DAHLGREN', 'ORVO', 'TESSALINE', 'GRIMWALD'];
