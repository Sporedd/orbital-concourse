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

/**
 * Grimdark revision (docs/ART_DIRECTION.md §15): black concrete, rusted steel, sodium light,
 * fire and red warning lamps. World and rendering use these; PALETTE above stays for the
 * gear/viewmodel/loot code that shares the STEEL tokens.
 */
export const GRIM = {
  CONCRETE: 0x34302c,
  CONCRETE_LIT: 0x48423b,
  CONCRETE_DARK: 0x221f1c,
  FLOOR: 0x3a3631,
  STEEL: 0x3e3029,
  STEEL_DARK: 0x1e1b19,
  SHADOW: 0x0c0b0a,
  CABLE: 0x0d0c0b,
  RUST: 0x7a3a1a,
  /** Low-pressure sodium, ≈ 2200 K: floodlights, lamp heads, shafts, pools. */
  SODIUM: 0xff8a2e,
  /** ≈ 2700 K: hub/wall lamps. */
  SODIUM_WARM: 0xffa552,
  /** Brazier / burn-barrel fire. */
  FIRE: 0xff6a1c,
  /** Red warning lamps (architecture, not THREAT: deeper, dimmer, never pulses with spawns). */
  WARN_RED: 0xd8200e,
  /** The cold shaft through the dome slit. */
  SLIT: 0x9db6d6,
  /** Fog / haze (dark warm smoke). */
  HAZE: 0x2a1a10,
  SMOKE: 0x3a2e25,
  ASH: 0x8a8580,
  CLOTH: 0x43100c,
} as const;

export type LeagueKey = 'scrap' | 'iron' | 'steel' | 'star' | 'void';
export const LEAGUE_ORDER: readonly LeagueKey[] = ['scrap', 'iron', 'steel', 'star', 'void'];

export type PlanetMode = 'none' | 'dead' | 'quarter' | 'half' | 'large' | 'eclipse';

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
  /** Fire sites lit (4 floor burn barrels first, then braziers on the wall coping). */
  fires: number;
  /** Tattered sponsor banners on the pillars. */
  banners: number;
  /** Red warning lamps on the pillars (out of 24). */
  redLamps: number;
  /** Twin sodium wall lamps on the pillars (out of 24). */
  wallLamps: number;
  /** Per-tower spot/shaft/pool gain: more towers, dimmer each (light sources, not brightness). */
  towerGain: number;
}

export const LEAGUE_STYLE: Record<LeagueKey, LeagueStyle> = {
  scrap: {
    id: 'scrap', name: 'SCRAP LEAGUE', accent: 0xff5f1f, towers: 2, spots: 2, floodColor: GRIM.SODIUM,
    fogDensity: 0.022, shaftIntensity: 0.16, crowd: 1500, crowdFill: 0.25, crowdFlashMult: 1, planet: 'dead',
    concrete: GRIM.CONCRETE, floorSheen: 0, ribbon: false, plinthInlay: false, floorRing: false, cubeBoard: false, flicker: true, fires: 6, banners: 6, redLamps: 8, wallLamps: 6, towerGain: 1,
  },
  iron: {
    id: 'iron', name: 'IRON LEAGUE', accent: 0xffc61a, towers: 4, spots: 4, floodColor: GRIM.SODIUM,
    fogDensity: 0.02, shaftIntensity: 0.13, crowd: 3000, crowdFill: 0.45, crowdFlashMult: 1, planet: 'quarter',
    concrete: GRIM.CONCRETE, floorSheen: 0, ribbon: true, plinthInlay: false, floorRing: false, cubeBoard: false, flicker: false, fires: 8, banners: 8, redLamps: 12, wallLamps: 8, towerGain: 0.5,
  },
  steel: {
    id: 'steel', name: 'STEEL LEAGUE', accent: 0x1fd1c1, towers: 4, spots: 4, floodColor: GRIM.SODIUM,
    fogDensity: 0.018, shaftIntensity: 0.12, crowd: 5000, crowdFill: 0.65, crowdFlashMult: 1, planet: 'half',
    concrete: GRIM.CONCRETE, floorSheen: 0, ribbon: true, plinthInlay: true, floorRing: false, cubeBoard: true, flicker: false, fires: 10, banners: 10, redLamps: 16, wallLamps: 12, towerGain: 0.5,
  },
  star: {
    id: 'star', name: 'STAR LEAGUE', accent: 0xe8368f, towers: 6, spots: 6, floodColor: GRIM.SODIUM,
    fogDensity: 0.017, shaftIntensity: 0.12, crowd: 7500, crowdFill: 0.85, crowdFlashMult: 2, planet: 'large',
    concrete: GRIM.CONCRETE, floorSheen: 0.2, ribbon: true, plinthInlay: true, floorRing: false, cubeBoard: true, flicker: false, fires: 12, banners: 12, redLamps: 20, wallLamps: 16, towerGain: 0.3,
  },
  void: {
    id: 'void', name: 'VOID LEAGUE', accent: 0x8c6cff, towers: 8, spots: 8, floodColor: 0xc9c2ff,
    fogDensity: 0.016, shaftIntensity: 0.10, crowd: 10000, crowdFill: 1, crowdFlashMult: 2, planet: 'eclipse',
    concrete: 0x1d1e22, floorSheen: 0.2, ribbon: true, plinthInlay: true, floorRing: true, cubeBoard: true, flicker: false, fires: 16, banners: 12, redLamps: 24, wallLamps: 20, towerGain: 0.17,
  },
};

export const DEFAULT_LEAGUE: LeagueKey = 'scrap';

/** Spec SpotLight counts per league (LEAGUE_STYLE[].spots is capped by the quality preset). */
const SPEC_SPOTS: Record<LeagueKey, number> = { scrap: 2, iron: 4, steel: 4, star: 6, void: 8 };

// ---------------------------------------------------------------------------
// Quality preset (§5: "Low-quality preset: max 4 real spots, the rest pools only")
// ---------------------------------------------------------------------------
export type Quality = 'high' | 'low' | 'mobile';

export interface QualitySettings {
  /** Real SpotLights per league at most (the rest keep their shaft + pool). */
  maxSpots: number;
  shadowMapSize: number;
  /** Dust motes per floodlight shaft (spec 30). */
  shaftMotes: number;
  /** Bloom resolution scale (UnrealBloom mips are the main post cost). */
  bloomScale: number;
  /** Real PointLights for fire sites (the rest keep glow + floor pool). */
  fireLights: number;
  /** Renderer pixel ratio as a fraction of CSS pixels (mobile only; unset = device ratio). */
  renderScale?: number;
  /** Crowd instances × this (mobile only). */
  crowdScale?: number;
  /** Hanging chain links drawn × this (mobile only). */
  chainScale?: number;
  /** Particle burst counts × this (mobile only). */
  particleScale?: number;
  /** One ground-haze quad and two stand-haze layers instead of 2 + 3 (mobile only). */
  cheapHaze?: boolean;
}

export const QUALITY_PRESETS: Record<Quality, QualitySettings> = {
  high: { maxSpots: 8, shadowMapSize: 2048, shaftMotes: 30, bloomScale: 1, fireLights: 6 },
  low: { maxSpots: 4, shadowMapSize: 1024, shaftMotes: 12, bloomScale: 0.5, fireLights: 3 },
  /** Phones and tablets: requested only by src/mobile/quality.ts (?quality= still overrides). */
  mobile: {
    maxSpots: 2, shadowMapSize: 1024, shaftMotes: 6, bloomScale: 0.25, fireLights: 2,
    renderScale: 0.7, crowdScale: 0.35, chainScale: 0.5, particleScale: 0.5, cheapHaze: true,
  },
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
// Light rig, grimdark revision (§15), in three.js physical units (r155+): a lit albedo-a surface
// under irradiance E reflects a · E / π.
//   The key is no longer the floodlight banks: it is the faint cold light falling through the
//   dome slit (shadows, a readable floor). Sodium spots, fire and red lamps make the pools; the
//   hemisphere is a cold sky over a warm (fire) bounce, the ambient a trace of lit smoke.
//   Key-lit black concrete ≈ 0.012 lum, shadowed ≈ 0.004, inside a sodium pool ≈ 0.12–0.25.
// ---------------------------------------------------------------------------
export const LIGHT = {
  key: 1.4,
  keyColor: GRIM.SLIT,
  hemiSky: 0x2a3446,
  hemiGround: 0x5a3018,
  /** Hemisphere intensity (cool from above, warm brazier bounce from below). */
  hemi: 4,
  ambientColor: 0x3a2a20,
  ambient: 0.6,
  exposure: 1.25,
  /** Shared gain on the floodlight shafts (see shafts.ts). */
  shaftGain: 3.2,
  /** Ground haze quad alpha / stand haze band total alpha. */
  groundHaze: 0.12,
  standHaze: 0.5,
  /** Rim on characters (uRimColor): a cool edge so enemies separate from warm smoke. */
  rimColor: 0x93a8c4,
  /** Grade (pipeline.ts GradeShader). */
  toe: 0.014,
  vignette: 0.6,
  grain: 0.05,
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
