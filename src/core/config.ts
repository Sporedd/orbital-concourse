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
export const xpForLevel = (level: number) => Math.round(100 * Math.pow(level, 1.4));
export const XP = { mob: 10, boss: 150, roundClear: 50 } as const;

// ---- Loot -----------------------------------------------------------------
export const LOOT = {
  mobWeaponDropChance: 0.12,
  mobAmmoDropChance: 0.25,
  mobHealthDropChance: 0.1,
  mobGrenadeDropChance: 0.06,
  /** Gear from regular mobs (bosses always drop one piece). */
  mobGearDropChance: 0.03,
  bossDrops: { min: 3, max: 5 },
  pickupRadius: 2.0,
  lifetime: 90,
} as const;

// ---- Arena ----------------------------------------------------------------
export const ARENA = { halfSize: 32 } as const;
