/**
 * Shared tuning constants. Every system reads these instead of inventing its own
 * numbers, so balance lives in one place. Units: metres, seconds, radians.
 */

// ---- Player ---------------------------------------------------------------
export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  eyeHeight: 1.65,
  walkSpeed: 7.5,
  sprintSpeed: 11,
  jumpSpeed: 7.5,
  gravity: -24,
  maxHealth: 100,
  maxShield: 80,
  shieldRechargeDelay: 4, // seconds without damage before recharge
  shieldRechargeRate: 30, // per second
  maxGrenades: 4,
  grenadeDamage: 120,
  grenadeRadius: 5,
  meleeDamage: 45,
  meleeRange: 2.2,
  meleeCooldown: 0.6,
  weaponSlots: 2,
} as const;

// ---- Camera ---------------------------------------------------------------
export const CAMERA = { fov: 85, near: 0.05, far: 400 } as const;

// ---- Aim down sights --------------------------------------------------------
/**
 * Hold RMB to aim: FOV → CAMERA.fov / weapon.zoom, spread × weapon.adsSpread. The per-archetype
 * table is the generator's base and the fallback for WeaponDefs saved/sent before ADS existed.
 */
export const ADS = {
  archetype: {
    pistol: { zoom: 1.25, adsSpread: 0.6 },
    smg: { zoom: 1.15, adsSpread: 0.7 },
    shotgun: { zoom: 1.1, adsSpread: 0.8 },
    rifle: { zoom: 1.45, adsSpread: 0.5 },
    sniper: { zoom: 3.0, adsSpread: 0.15 },
  } as Record<import('./types').WeaponArchetype, { zoom: number; adsSpread: number }>,
  inTime: 0.12, // s, hip → aimed
  outTime: 0.1, // s, aimed → hip
  moveMult: 0.7, // aiming forces walk speed × this (no sprint)
  recoilMult: 0.7,
  /** zoom at or above this shows the scope overlay instead of the crosshair. */
  scopeZoom: 2,
} as const;

// ---- Accuracy + bloom -------------------------------------------------------
/**
 * Accuracy 0..100 ↔ base spread (radians): spread = ACCURACY.maxSpread × (1 − acc/100)².
 * Bloom: each shot adds `perShot` to a spread multiplier bonus (capped at `cap`); after
 * `recoverDelay` without a shot it drains to 0 over `recoverTime`.
 */
export const ACCURACY = {
  maxSpread: 0.3,
  base: { pistol: 80, smg: 60, shotgun: 45, rifle: 72, sniper: 95 } as Record<import('./types').WeaponArchetype, number>,
  bloom: {
    pistol: { perShot: 0.22, cap: 0.9 },
    smg: { perShot: 0.16, cap: 1.6 },
    shotgun: { perShot: 0.12, cap: 0.4 },
    rifle: { perShot: 0.14, cap: 1.4 },
    sniper: { perShot: 0.03, cap: 0.08 },
  } as Record<import('./types').WeaponArchetype, { perShot: number; cap: number }>,
  recoverDelay: 0.12,
  recoverTime: 0.35,
} as const;

export const spreadFromAccuracy = (acc: number) => {
  const a = Math.min(100, Math.max(0, acc));
  return Math.round(ACCURACY.maxSpread * (1 - a / 100) ** 2 * 1e5) / 1e5;
};
export const accuracyFromSpread = (spread: number) =>
  Math.round(Math.min(100, Math.max(0, 100 * (1 - Math.sqrt(Math.max(0, spread) / ACCURACY.maxSpread)))));

// ---- Rounds ---------------------------------------------------------------
/** Total mobs to kill in round N (N starts at 1). Split into SUB_WAVES. */
export const mobsForRound = (round: number) => 20 + 8 * round;
export const SUB_WAVES = 3;
/** Max mobs alive at once (keeps the arena readable). */
export const maxAliveForRound = (round: number) => Math.min(8 + 2 * round, 18);
export const INTERMISSION_SECONDS = 6;

/** Enemy scaling multipliers for a given tier (tier === round number). */
export const mobHealthMult = (tier: number) => 1 + 0.25 * (tier - 1);
export const mobDamageMult = (tier: number) => 1 + 0.15 * (tier - 1);
export const bossHealthMult = (tier: number) => 1 + 0.5 * (tier - 1);
export const bossDamageMult = (tier: number) => 1 + 0.2 * (tier - 1);
/** Co-op: extra health per additional player. */
export const playerCountHealthMult = (players: number) => 1 + 0.6 * (players - 1);

// ---- Progression ----------------------------------------------------------
/** XP to go from `level` to `level + 1` (docs/SKILL_TREE.md §1.1 pacing: 100·L^1.1, was 100·L^1.4). */
export const xpForLevel = (level: number) => Math.round(100 * Math.pow(Math.max(1, level), 1.1));
export const XP = { mob: 10, boss: 150, roundClear: 50 } as const;

// ---- Loot -----------------------------------------------------------------
export const LOOT = {
  mobWeaponDropChance: 0.12,
  mobAmmoDropChance: 0.25,
  mobHealthDropChance: 0.1,
  mobGrenadeDropChance: 0.06,
  /** Gear is meta progression (bought in the shop, PLAN §13): nothing rolls it as a drop any more. */
  mobGearDropChance: 0,
  bossDrops: { min: 3, max: 5 },
  pickupRadius: 2.0,
  lifetime: 90,
} as const;

// ---- Arena ----------------------------------------------------------------
export const ARENA = { halfSize: 32 } as const;

// ---- Economy (scrip, shop, upgrades: docs/ECONOMY.md) ------------------------
export const ECONOMY = {
  /** Value multiplier per rarity (salvage, prices, upgrade costs). */
  rarityMult: { common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 16 } as Record<import('./types').Rarity, number>,
  /** Per item level above 1: value × (1 + levelRate·(level − 1)). */
  levelRate: 0.15,
  /** Weapon salvage: salvageBase × rarityMult × levelMult. */
  salvageBase: 10,
  /** Round-clear bounty: bountyBase + bountyPerRound · round. */
  bountyBase: 25,
  bountyPerRound: 10,
  /** Shop gear price: priceBase × rarityMult × levelMult. */
  priceBase: 40,
  /** Stock size range (one piece per slot first, then random slots). */
  stockMin: 6,
  stockMax: 8,
  /** Shop reroll fee: rerollBase × (1 + levelRate·(tier − 1)). */
  rerollBase: 15,
  /** Reinforce (+1 item level): reinforceBase × rarityMult × reinforceGrowth^(level − 1). */
  reinforceBase: 15,
  reinforceGrowth: 1.18,
  /** Retune (reroll one affix in its range): retuneBase × rarityMult × levelMult. */
  retuneBase: 10,
  /** Augment (add an affix below the rarity cap): augmentBase × rarityMult × levelMult. */
  augmentBase: 60,
  /** Ascend (rarity + 1): ascendBase × rarityMult × levelMult. */
  ascendBase: 250,
  /** Reinforce stops at this item level. */
  maxItemLevel: 40,
} as const;
