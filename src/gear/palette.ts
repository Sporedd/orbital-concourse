/**
 * Every colour and glow level the gear system uses lives here, so the look can be swapped in
 * one place. Follows docs/ART_DIRECTION.md (C · Brutalist Arena):
 *  - gear is matte STEEL / STEEL_DARK with CONCRETE_LIT plates and BONE stencil plates;
 *  - "rarity is the only colour on gear", as emissive seams: common none, uncommon..epic at
 *    lum 1.2, legendary at lum 2.5 plus slow motes (§8);
 *  - the league accent never goes on loot, enemies or health UI (§14), so it is exported for
 *    names/UI only and the models do not use it;
 *  - glow brightness is set by a luminance target, not a fixed multiplier (§1.2, §2.4).
 * Keep this file data-only (no THREE import) so the sim can use it.
 */
import { RARITY_COLORS, type Element, type Rarity } from '@/core/types';
import type { League } from './types';

/** ART_DIRECTION §1.1 / §1.4 tokens used by gear and the paper doll. */
export const GEAR_PALETTE = {
  shadow: 0x1c1e21,
  concreteDark: 0x4a4a48,
  concrete: 0x6f6d68,
  concreteLit: 0x9a978f,
  steel: 0x4e555c,
  steelDark: 0x2a2c2f,
  bone: 0xeceae4,
  floodlight: 0xf3eedf,
  // paper doll (a neutral mannequin, not an enemy: no olive ARMOUR, no THREAT)
  dollBody: 0x5b5f64,
  dollJoint: 0x2a2c2f,
  dollFloor: 0x9a978f,
  dollFloorRing: 0x4a4a48,
  dollBackground: 0x1c1e21,
  dollKeyLight: 0xf3eedf,
  dollRimLight: 0xf3eedf,
  dollSky: 0x3a3e45,
  dollGround: 0x6f6d68,
} as const;

/** League accent (§1.2). UI and names only, never on the gear models (§14). */
export const LEAGUE_ACCENT: Record<League, number> = {
  scrap: 0xff5f1f,
  iron: 0xffc61a,
  steel: 0x1fd1c1,
  star: 0xe8368f,
  void: 0x8c6cff,
};

/** Seam colour per rarity: the unchanged core RARITY_COLORS (§1.3). */
export const RARITY_ACCENT: Record<Rarity, number> = { ...RARITY_COLORS };

/**
 * ART_DIRECTION says rarity is the only colour on gear; PLAN §11 says elemental affixes tint
 * the glow. Default follows the art direction; flip to let the element tint the seams.
 */
export const ELEMENT_TINTS_SEAMS = false;
export const ELEMENT_ACCENT: Record<Exclude<Element, 'none'>, number> = {
  fire: 0xff5a1f,
  shock: 0x4fd9ff,
  ice: 0x9fe8ff,
};

/**
 * Finish per rarity. `seamLum` = target linear luminance of the emissive seams (0 = none),
 * `motes` = number of slow glowing motes, `pulse` = animated seam pulse.
 */
export const RARITY_FINISH: Record<Rarity, { seamLum: number; motes: number; pulse: boolean }> = {
  common: { seamLum: 0, motes: 0, pulse: false },
  uncommon: { seamLum: 1.2, motes: 0, pulse: false },
  rare: { seamLum: 1.2, motes: 0, pulse: false },
  epic: { seamLum: 1.2, motes: 0, pulse: false },
  legendary: { seamLum: 2.5, motes: 6, pulse: true },
};

/** Visor/lens glow (BONE, not a colour): dim at ilvl 1, just reaching bloom at max growth. */
export const VISOR_LUM = { min: 0.45, max: 1.15 } as const;

/** Toon options for gear/doll materials: no hatching (§0.1); surface 'character' (ART_DIRECTION §2.2). */
export const GEAR_TOON_HATCH = false;

// ---------------------------------------------------------------------------
// Colour helpers (pure numbers)
// ---------------------------------------------------------------------------
export function mixColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * k) << s;
  return (m(16) | m(8) | m(0)) >>> 0;
}

/** Lighten (amount > 0) or darken (amount < 0). */
export function shadeColor(c: number, amount: number): number {
  return amount >= 0 ? mixColor(c, 0xffffff, amount) : mixColor(c, 0x000000, -amount);
}

const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** Linear luminance of an sRGB hex colour (§1 "Lum"). */
export function lumLinear(hex: number): number {
  return 0.2126 * toLinear((hex >> 16) & 0xff) + 0.7152 * toLinear((hex >> 8) & 0xff) + 0.0722 * toLinear(hex & 0xff);
}

/** glow() intensity that hits a luminance target, clamped to 4 (§1.2). */
export function glowLum(hex: number, targetLum: number): number {
  return Math.min(4, targetLum / Math.max(lumLinear(hex), 1e-4));
}

/** Body colour of a piece: plain STEEL for every rarity (rarity shows only in the seams). */
export function gearBodyColor(_rarity: Rarity): number {
  return GEAR_PALETTE.steel;
}

/** Seam colour of a piece: rarity (or element when ELEMENT_TINTS_SEAMS). */
export function gearAccentColor(rarity: Rarity, element?: Element): number {
  return ELEMENT_TINTS_SEAMS && element && element !== 'none' ? ELEMENT_ACCENT[element] : RARITY_ACCENT[rarity];
}
