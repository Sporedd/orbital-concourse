# Skill tree v2 — classes, branches, keystones, actives

Replaces the 5-node placeholder (PLAN §6). Owner: `src/progression/**`, the skill-tree and class
sections of `src/ui/screens.ts`, `tests/progression/*`. Data is the source of truth
(`src/progression/skills.ts`, `classes.ts`); this document is the design and the wiring contract.

## 1. Shape

- **Four classes.** You pick one per profile (first run shows the class picker; change it any time
  from the start menu row `CLASS` or the skill tree, free for now). The class sets a small base-stat
  identity, a starter weapon archetype and one **active ability**.
- **Each class tree has three branches** (`A`, `B`, `C`) of six nodes in three tiers, plus one
  **capstone**: 19 nodes, 40 points.
- **The Pit** is a shared five-node tree (reload, movement, grenades, survival) open to every class:
  10 points. **Class tree + Pit = 50 points.**
- Node kinds:
  - **passive** (2–3 ranks): a number or a small behaviour, per rank.
  - **keystone** (1 rank, one per tier 2 and tier 3 of every branch): changes how something works
    or is a trade-off. Drawn with an accent top bar.
  - **capstone** (1 rank, one per class): the class fantasy at full volume. Drawn larger with a
    hazard tab.
- **Gates.** Tier 1 is open. Tier 2 needs **3 points in that branch**, tier 3 needs **6**. The
  capstone needs **25 points in the class tree**. A node also needs its `requires` node at rank ≥ 1
  (drawn as an orthogonal line). Prerequisites that are not implemented yet count as met (players
  cannot buy them, so they must not block live nodes).
- **Active ability**: unlocked by owning **any keystone** of your class tree (the first keystone is
  reachable at 3 branch points, i.e. level 5). Bound to one key (`Q`, see §6), with a cooldown.

### 1.1 Pacing

1 skill point per level (unchanged), so the full 50 points arrive at **level 51**.

| Curve | Lv 11 | Lv 21 | Lv 31 | Lv 51 (full tree) |
|---|---|---|---|---|
| current `100·L^1.4` | 11.7k XP | 58.6k | 152k | 510k |
| proposed `100·L^1.1` | 6.6k | 27.1k | 62.3k | 180k |

A run to round 10 is ~8.4k XP (×1.1–1.5 with the crowd). With the current curve the first keystone
(lv 5) lands in run 1, the active by run 1–2, the first capstone (lv 26 ≈ 99k XP) after ~10 deep
runs, and the full tree after ~55 deep runs — too slow for a 3-branch build to come together.
**Recommendation for the lead (`src/core/config.ts`, not owned here):** `xpForLevel = 100·L^1.1`
(full tree after ~20 deep runs, capstone after ~4). Nothing in progression depends on the curve.

**Respec** is free (button in the tree; class change refunds the class tree and keeps the Pit).
A future cost could be standing or a round-gated token; the API (`respec()`) does not change.

## 2. The classes

| Class | Fantasy | Identity (always on) | Starter | Active |
|---|---|---|---|---|
| **Vanguard** | The wall the crowd paid to see break. Shields, health, melee finishers. | +20 % shield capacity, +10 % max health | Shotgun | **Shield Bash** — 12 s cd. Dash 6 m along your view; enemies in the path take 150 % melee damage and are knocked back; 1 s invulnerability. |
| **Marksman** | The quiet one in the loud arena. Crits, patience, pistols and snipers. | +20 % crit damage | Pistol | **Deadeye** — 25 s cd, 5 s. Time slows to 50 % for everything but you; every bullet crits. |
| **Technician** | Brought a toolbox to a gunfight. Elements, grenades, salvage. | −10 % reload time, +5 % fire rate | Rifle | **Shock Pulse** — 14 s cd. 8 m shock nova for `(80 + 20·round) × gun damage`, shocks (chains) everything hit, restores 25 % shield. |
| **Showman** | Plays to the stands. Hype, mobility, SMG/shotgun at kissing distance, loot luck. | +8 % move speed, +10 % hype gains | SMG | **Encore** — 30 s cd, 8 s. Refills magazine and adds a reserve load, doubles hype gains, +20 % fire rate. |

Branches:

| Class | A | B | C |
|---|---|---|---|
| Vanguard | **Bulwark** (shield/health) | **Brawler** (melee) | **Champion** (crowd brawling, trade-offs) |
| Marksman | **Precision** (crits) | **Long Game** (ADS, pistols/snipers) | **Hunter** (mobility, bosses) |
| Technician | **Elementalist** (status) | **Demolitions** (grenades) | **Salvage** (pickups, loot, gear) |
| Showman | **Spectacle** (hype) | **Knife-Edge** (close range, movement) | **Luck** (drops, standing) |

## 3. Nodes

Columns: **code** (plinth label: branch letter + index; `CX` capstone; `P` Pit) · **id** ·
**name** · ranks · per-rank value · **mechanics** · requires · **hook** · balance note.
Flavour lines live in the data (`flavour`) and show in the detail panel.

Hook kinds (see §5):
`stat` = PlayerStats via `apply()` · `cond` = PlayerStats modifier evaluated whenever stats are read ·
`buff` = timed PlayerStats modifier · `event` = listener in `effects.ts` using existing contracts ·
`player:<name>` = needs player code (**not live**, shown dimmed `SOON`).

### 3.1 Vanguard

| Code | id | Name | R | Value | Mechanics | Requires | Hook | Balance |
|---|---|---|---|---|---|---|---|---|
| A1 | van_plating | Reinforced Plating | 3 | 8 % | +shield capacity (regen scales with it) | — | stat | 24 % on top of identity 20 % |
| A2 | van_constitution | Iron Constitution | 3 | 6 % | +max health | — | stat | |
| A3 | van_scar_tissue | Scar Tissue | 3 | 4 % | Shield break heals % of max health (6 s cd) | A1 | event | 12 % ≈ one grunt hit back |
| A4 ◆ | van_overcharge | Overcharge Cell | 1 | 40 % | When your shield breaks it snaps back to 40 % (15 s cd) | A1 | event | effectively +40 % shield per fight |
| A5 | van_hold_line | Hold the Line | 2 | 6 % | +gun damage while your shield is full | A3 | cond | rewards not getting hit |
| A6 ◆ | van_immovable | Immovable | 1 | — | +35 % shield capacity, −10 % move speed | A4 | stat | trade-off |
| B1 | van_heavy_hands | Heavy Hands | 3 | 15 % | +melee damage | — | event* | *follow-up hit until player reads `extras.meleeMult` |
| B2 | van_knuckles | Iron Knuckles | 3 | 4 % | Melee hits restore % of max shield | — | event | |
| B3 | van_finisher | Finisher | 3 | 5 % | Melee kills heal % of max health | B1 | event | |
| B4 ◆ | van_crowd_work | Crowd Work | 1 | — | Melee kills refund a grenade (4 s cd) and +6 hype | B2 | event | stacks with Pitfighter 3/3 by design |
| B5 | van_momentum | Momentum | 2 | 8 % | Melee kills: +move speed for 4 s | B3 | buff | |
| B6 ◆ | van_executioner | Executioner | 1 | 25 % | Melee hits finish non-boss enemies below 25 % health; bosses take +50 % melee damage | B4 | event | the finisher fantasy |
| C1 | van_brute_force | Brute Force | 3 | 4 % | +gun damage | — | stat | |
| C2 | van_showboat | Showboat | 3 | 2 | Kills within 6 m: +hype | — | event | |
| C3 | van_bloodlust | Bloodlust | 3 | 4 % | Kills: +fire rate for 4 s | C1 | buff | |
| C4 ◆ | van_juggernaut | Juggernaut | 1 | — | +30 % max health, −30 % shield capacity | C2 | stat | health build (health only from pickups) |
| C5 | van_last_stand | Last Stand | 2 | 10 % | +gun damage while below 35 % health | C3 | cond | |
| C6 ◆ | van_center_ring | Center Ring | 1 | 20 % | While 3+ enemies are within 8 m: +gun damage and fire rate | C4 | cond | |
| CX ★ | van_unbroken | Unbroken | 1 | — | Kills restore 8 % shield; with the shield down they heal 4 % health instead | 25 pts | event | |

### 3.2 Marksman

| Code | id | Name | R | Value | Mechanics | Requires | Hook | Balance |
|---|---|---|---|---|---|---|---|---|
| A1 | mar_steady | Steady Hand | 3 | 10 % | +crit damage | — | stat | |
| A2 | mar_calibre | Heavy Calibre | 3 | 4 % | +gun damage | — | stat | |
| A3 | mar_headhunter | Headhunter | 3 | 5 % | Crit kills: +gun damage for 5 s | A1 | buff | |
| A4 ◆ | mar_bullseye | Bullseye | 1 | 1 | Crit hits put a round back in the magazine (once per shot) | A2 | event | infinite mag if you never miss the head |
| A5 | mar_patience | Patience | 2 | 12 % | +crit damage on the first shot after 1 s without firing | A3 | cond | sniper/pistol rhythm |
| A6 ◆ | mar_glass_jaw | Glass Jaw | 1 | — | +25 % gun damage, −40 % shield capacity (and so recharge) | A4 | stat | trade-off; switch to `−50 % regen` once player reads `extras.shieldRegenMult` |
| B1 | mar_breath | Breath Control | 3 | 10 % | −ADS spread | — | **player:extras.adsSpreadMult** | SOON |
| B2 | mar_quickdraw | Quickdraw | 3 | 5 % | −reload time | — | stat | |
| B3 | mar_scoped | Scoped In | 3 | 5 % | +gun damage while aiming down sights | B2 | cond (`player.aiming`) | live (ADS exposes `aiming`) |
| B4 ◆ | mar_ricochet | Ricochet Doctrine | 1 | 2 m | Bullets that miss within 2 m of an enemy curve into it | B2 | **player:ricochetDoctrine** | SOON |
| B5 | mar_specialist | Specialist | 2 | 8 % | +gun damage with a pistol or sniper | B3 | cond | |
| B6 ◆ | mar_one_shot | One Shot, One Kill | 1 | — | Pistols and snipers: +30 % damage and crit damage, −20 % fire rate | B3 | cond | |
| C1 | mar_light_step | Light Step | 3 | 3 % | +move speed | — | stat | |
| C2 | mar_vantage | Vantage | 3 | 8 % | +crit damage while airborne | — | cond | |
| C3 | mar_reposition | Reposition | 3 | 5 % | Crit kills: +move speed for 3 s | C1 | buff | |
| C4 ◆ | mar_trophy | Trophy Hunter | 1 | ×1.5 | Boss kills grant ×1.5 standing | C2 | event | +50 % of the boss award, raw |
| C5 | mar_spotter | Spotter | 2 | 10 % | Crits have a chance to shock the target, chaining 25 % of the hit | C3 | event | |
| C6 ◆ | mar_big_game | Big Game | 1 | — | +20 % gun damage while a boss is alive, −10 % otherwise | C4 | cond | trade-off |
| CX ★ | mar_perfect_form | Perfect Form | 1 | 2 % | Every crit hit: +2 % crit damage for 6 s, up to 15 stacks; a shot that lands only body hits removes 3 | 25 pts | event+buff | +30 % crit at full stacks |

### 3.3 Technician

| Code | id | Name | R | Value | Mechanics | Requires | Hook | Balance |
|---|---|---|---|---|---|---|---|---|
| A1 | tec_conductor | Conductor | 3 | 5 % | Elemental hits get an extra chance to apply their status | — | event | |
| A2 | tec_overclock | Overclock | 3 | 4 % | +fire rate | — | stat | |
| A3 | tec_catalyst | Catalyst | 3 | 10 % | Elemental kills burst for % of the victim's max health in 3 m (same element) | A1 | event | no chain: bursts are `cause: 'explosion'` |
| A4 ◆ | tec_overheat | Overheat | 1 | 40 % | Fire rate ramps up to +40 % over 1.5 s of sustained fire; spread grows up to +50 % | A2 | **player:overheat** | SOON |
| A5 | tec_affinity | Elemental Affinity | 2 | 8 % | +gun damage with an elemental weapon | A3 | cond | |
| A6 ◆ | tec_meltdown | Meltdown | 1 | 25 % | Burning enemies explode on death: 25 % of their max health as fire damage in 4 m, igniting what survives | A3 | event | |
| B1 | tec_payload | Bigger Payload | 3 | 12 % | +grenade damage | — | **player:extras.grenadeDamageMult** | SOON |
| B2 | tec_recycler | Recycler | 3 | 15 % | Grenade kills have a chance to refund a grenade | — | event | |
| B3 | tec_cluster | Cluster Charge | 3 | 30 | Grenade kills set off a 3 m secondary blast (× gun damage) | B2 | event | |
| B4 ◆ | tec_resupply | Field Resupply | 1 | — | Round start and every boss phase break: grenades to max, +50 % of a reserve load | B2 | event | |
| B5 | tec_wide | Wide Spread | 2 | 15 % | +grenade radius | B3 | **player:extras.grenadeRadiusMult** | SOON |
| B6 ◆ | tec_ordnance | Ordnance Bay | 1 | — | +2 max grenades, +30 % grenade damage, −10 % gun damage | B4 | **player:extras** | SOON |
| C1 | tec_scrounger | Scrounger | 3 | 20 % | Ammo pickups give more | — | event | |
| C2 | tec_field_medic | Field Medic | 3 | 15 % | Health pickups heal more | — | event | |
| C3 | tec_kitted | Kitted Out | 3 | 1.5 % | +gun damage per equipped gear piece | C1 | cond | 22.5 % with 5 pieces at rank 3 |
| C4 ◆ | tec_salvage | Salvage Rights | 1 | 6 % | Your kills have a chance to drop an extra item | C2 | event (host) | |
| C5 | tec_tuning | Shield Tuning | 2 | 8 % | +shield capacity | C3 | stat | |
| C6 ◆ | tec_siphon | Power Siphon | 1 | 10 % | Kills by elemental status (burn ticks, shock chains) restore 10 % shield | C4 | event | |
| CX ★ | tec_storm_engine | Storm Engine | 1 | — | Shock Pulse fires on its own when your shield breaks, and its cooldown is 30 % shorter | 25 pts | event | live even before the key is wired |

### 3.4 Showman

| Code | id | Name | R | Value | Mechanics | Requires | Hook | Balance |
|---|---|---|---|---|---|---|---|---|
| A1 | sho_crowd_fav | Crowd Favourite | 3 | 10 % | +hype gains (kills and style moves) | — | event | |
| A2 | sho_spray | Spray and Pray | 3 | 5 % | +fire rate with an SMG or shotgun | — | cond | |
| A3 | sho_feed | Feed Off the Crowd | 3 | 3 % | +gun damage per crowd tier above Cold | A1 | cond | 27 % while ROARING at rank 3 |
| A4 ◆ | sho_showstopper | Showstopper | 1 | — | Multi-kills refill your magazine | A2 | event | |
| A5 | sho_curtain | Curtain Call | 2 | 15 % | −Encore cooldown | A3 | **player:activeKey** | SOON until the key exists |
| A6 ◆ | sho_sponsor | Sponsor's Favourite | 1 | +1 | Bosses drop one extra item for you (+0.3 rarity) | A4 | event (host) | |
| B1 | sho_footwork | Footwork | 3 | 4 % | +move speed | — | stat | |
| B2 | sho_in_your_face | In Your Face | 3 | 6 % | +gun damage with an SMG or shotgun | — | cond | |
| B3 | sho_hit_run | Hit and Run | 3 | 4 % | Kills: +move speed for 3 s | B1 | buff | |
| B4 ◆ | sho_point_blank | Point Blank | 1 | 25 % | While an enemy is within 5 m: +gun damage and crit damage | B2 | cond | |
| B5 | sho_aerialist | Aerialist | 2 | 8 % | +gun damage while airborne | B3 | cond | |
| B6 ◆ | sho_daredevil | Daredevil | 1 | 20 % | −15 % max health; below 50 % health: +20 % gun damage and fire rate | B4 | stat+cond | trade-off |
| C1 | sho_lucky | Lucky Break | 3 | 2 % | Kills have a chance to drop an ammo/health/grenade pickup | — | event (host) | |
| C2 | sho_tip_jar | Tip Jar | 3 | 15 % | +standing from crowd milestones | — | event | |
| C3 | sho_jackpot | Jackpot | 3 | 3 % | Crit kills have a chance to drop a weapon | C1 | event (host) | |
| C4 ◆ | sho_fan_service | Fan Service | 1 | 25 % | When the crowd reaches HOT or ROARING: grenades to max, heal 25 %, shield full (20 s cd) | C2 | event | |
| C5 | sho_high_roller | High Roller | 2 | 5 % | Kills have a chance to refill your magazine | C3 | event | |
| C6 ◆ | sho_glory | Glory Hound | 1 | — | Kills while the crowd is HOT or louder heal 3 % and restore 5 % shield | C4 | event | |
| CX ★ | sho_ovation | Standing Ovation | 1 | — | While the crowd is ROARING: +25 % gun damage, +25 % fire rate, +15 % move speed | 25 pts | cond | |

### 3.5 The Pit (all classes)

| Code | id | Name | R | Value | Mechanics | Requires | Hook | Note |
|---|---|---|---|---|---|---|---|---|
| P1 | reload | Quick Hands | 3 | 6 % | −reload time | — | stat | old id/name: migrated |
| P2 | speed | Fleet Foot | 3 | 4 % | +move speed | — | stat | old id/name: migrated |
| P3 | pit_bandolier | Bandolier | 2 | 1 | +max grenades | P1 | **player:extras.extraGrenades** | SOON |
| P4 | pit_pack_mule | Pack Mule | 1 | — | Round clears give +1 grenade and 50 % of a reserve load | P2 | event | |
| P5 | pit_second_wind | Second Wind | 1 | 2 s | Once per round, lethal damage leaves you at 1 HP with 2 s of invulnerability | P4 | **player:secondWind** | SOON |

**Live today:** 72 of 81 nodes and the Storm Engine pulse. **Needs wiring:** 9 nodes + the 4 active
keys (§6).

## 4. Stacking rules

- `stat` nodes and the class identity multiply into `PlayerStats` like before
  (`stats[key] *= 1 + v·rank`, reload uses negative values). Gear multiplies on top (`getStats`).
- `cond` and `buff` modifiers only touch `damageMult`, `fireRateMult`, `reloadMult`, `critMult`,
  `moveSpeedMult` (never health/shield, whose maxima only update on events). Each modifier
  multiplies: `final = static × Π(1 + v)`. The progression `stats` object exposes these as getters,
  so the existing per-shot `getStats(ctx)` reads pick them up with no player change.
- Buffs from the same node refresh instead of stacking (Perfect Form is the one stacking buff).
- Buffs, cooldowns and stacks clear on `game:started`.
- Run time for buffs/cooldowns is `ctx.time.elapsed` (keeps ticking while paused — acceptable for
  seconds-long buffs; the player can pass a sim clock later).
- Co-op: drop-creating nodes (`Salvage Rights`, `Lucky Break`, `Jackpot`, `Sponsor's Favourite`) run
  on the host only, because loot is host-authoritative. A client's own skills stay local (the host
  does not know them); proper co-op support means sending `classId` + ranks in the hello message.

## 5. Hooks — the interface for the player agent

Everything the player code needs is on the progression object. Type: `ClassProgression`
(`import type { ClassProgression } from '@/progression'`); cast `ctx.progression` to it.

```ts
interface ClassProgression extends Progression {
  readonly classId: ClassId | null;          // 'vanguard' | 'marksman' | 'technician' | 'showman'
  readonly classDef: ClassDef | null;        // name, identity, starterArchetype, active spec
  readonly extras: Readonly<SkillExtras>;    // non-PlayerStats numbers, see below
  readonly hooks: readonly string[];         // owned 'player:*' hook ids, e.g. 'player:secondWind'
  readonly activeAbility: ActiveAbilityState | null;
  useActive(): boolean;                      // call on the ability key; false if locked/cooling down
  setClass(id: ClassId): boolean;
  respec(): void;
}
interface SkillExtras {          // neutral values in brackets; mirrors GearStats conventions
  meleeMult: number;             // [1] × melee damage            (bridged today, see §5.2)
  extraGrenades: number;         // [0] + max grenades (integer)  → maxGrenades()
  grenadeDamageMult: number;     // [1] × grenade damage           → grenades.ts explode
  grenadeRadiusMult: number;     // [1] × grenade radius
  adsSpreadMult: number;         // [1] × spread while aiming
  shieldRegenMult: number;       // [1] × shield recharge rate     (next to gearExtras().shieldRegenMult)
  abilityCooldownMult: number;   // [1] × active cooldown (used internally)
}
interface ActiveAbilityState {
  readonly def: ActiveAbilityDef;  // id, name, key, cooldown, duration, description, hook
  readonly unlocked: boolean;      // owns any keystone of the class
  readonly ready: boolean;
  readonly cooldownLeft: number;   // s
  readonly cooldown: number;       // s, after abilityCooldownMult
  readonly activeLeft: number;     // s left of the effect window (0 when idle)
  readonly active: boolean;        // activeLeft > 0 — read this for invuln / forced crits / time scale
}
```

### 5.1 Hook list (all `player:*`)

| Hook | Who | What the player code does |
|---|---|---|
| `player:activeKey` | all actives, Curtain Call | On `KeyQ` (`justPressed`, alive, not in a screen): `(ctx.progression as ClassProgression).useActive()`. The live part of each active runs inside `useActive()` (damage, refills, buffs, shield). Add `Q` to the controls list. HUD: show `activeAbility.cooldownLeft` (optional). |
| `player:shieldBash` | Vanguard active | While `activeAbility.active` and the class is `vanguard`: dash 6 m along the view over 0.35 s (reuse the voidrunner dash path in the controller), ignore damage in `takeDamage`. `useActive()` already deals the 3 m melee hit at the start. |
| `player:deadeye` | Marksman active | While active: every bullet `crit = true` in `weapons.shoot`, and the sim time scale for enemies/projectiles is 0.5 (main loop: `enemies.update(dt * 0.5)`). `useActive()` applies a +50 % crit damage buff as the fallback. |
| `player:secondWind` | Pit P5 | In `takeDamage`, when `health` would hit 0 and `hooks.includes('player:secondWind')` and not used this round: set health 1, 2 s invulnerability, `ui:message`. Reset on `round:started`. |
| `player:overheat` | Technician A4 | In `WeaponSystem.update`: while the trigger is held, `heat` rises 0→1 over 1.5 s (drains in 0.5 s); fire rate × `(1 + 0.4·heat)`, spread × `(1 + 0.5·heat)`. |
| `player:ricochetDoctrine` | Marksman B4 | In `shoot()` on a miss: find the nearest living enemy whose centre is within 2 m of the ray (segment-point distance); if it has line of sight from the closest ray point, apply the hit to it (no crit), with a bent tracer. |
| `player:extras` | Bandolier, Bigger Payload, Wide Spread, Ordnance Bay, Breath Control | Read `extras` next to `gearExtras(ctx)`: `maxGrenades(ctx, base) + extras.extraGrenades`, grenade damage × `grenadeDamageMult`, radius × `grenadeRadiusMult`, ADS spread × `adsSpreadMult`, shield regen × `shieldRegenMult`, melee × `meleeMult`. Then flip `implemented: true` on those nodes in `skills.ts`. |
| `rounds:starterWeapon` | class identity | `rounds/index.ts` / `net/client.ts` equip `ctx.loot.starterWeapon()` when both slots are empty. Use `generateWeapon(tier 1, 'common')` forced to `classDef.starterArchetype` (needs an `archetype` option on the loot generator, owned by loot). |

### 5.2 Bridges (remove when the player adopts the hook)

- **Heavy Hands / Executioner melee bonus**: until the player multiplies melee damage by
  `extras.meleeMult`, `effects.ts` deals the bonus as a follow-up hit on the same enemy
  (`cause: 'melee'`, guarded against re-entry). When the player reads `extras.meleeMult`, set
  `MELEE_BRIDGE = false` in `effects.ts`.

### 5.3 Contracts the live effects use

`ctx.player.heal / addAmmo / addGrenades`, the writable `shield` and `ammo` fields of
`PlayerState`, `ctx.enemies.get / list / damageRadius / bossAlive`, `Enemy.damage / applyStatus`,
`ctx.loot.dropLoot`, `ctx.standing?.hype.add`, `ctx.standing?.standing.award(…, raw = true)`,
`ctx.fx`, `ui:message`. Events read: `enemy:killed`, `damage:dealt`, `weapon:fired`,
`player:shield`, `loot:pickup`, `round:started`, `round:cleared`, `boss:phase`, `hype:reaction`,
`hype:changed`, `standing:gained`, `game:started`.

## 6. UI (`src/ui/skillTree.ts`, mounted by `src/ui/screens.ts`; CSS block "skill tree v2" in `styles.ts`)

- **Class picker** (first run with no class; start row `CLASS`; `CLASS` button in the tree): four
  manifest cards (class name, blurb, identity lines, starter, active card). Picking one confirms;
  changing class asks once (refunds the class tree).
- **Skill tree**: header (`<CLASS> · SKILL TREE`, level, points chip), three branch columns and the
  Pit on the floor-plan grid, two plinth columns per branch, tier rows, capstone centred below the
  branches. Plinth codes `A1…C6`, `CX`, `P1…P5`; keystones get an accent top bar, the capstone is
  larger with a hazard tab. Requirement lines orthogonal 2 px. Right column: detail panel (flavour,
  mechanics, `RANK 1/3 · +8 % → +16 %`, gate/lock reason, INVEST) and the active ability card
  (`[Q]`, cooldown, LOCKED until the first keystone). Footer: `[TAB] BACK`, `CLASS`, `RESPEC`.
- Unimplemented nodes render dimmed with `SOON` and cannot be bought. With the dev flag
  (`localStorage['concourse.dev'] = '1'` or `?dev` in the URL) they read `NEEDS WIRING ·
  <hook>` and can be bought for testing.

## 7. Persistence and migration

`concourse.progress.v1` keeps its key; the payload gains `version: 2` and `classId`.
Loading a version-1 save: ranks whose id still exists in the Pit (`reload` → Quick Hands,
`speed` → Fleet Foot; same names) are kept, clamped to the new max rank; every other rank
(`damage`, `fire_rate`, `shield`) and any excess is refunded as skill points. Level, XP and best
round are untouched. Ranks in nodes of another class than the saved `classId` are refunded too.

## 8. Events

- `skill:changed` — as before on every invest; a respec or class change emits it once with
  `skillId: '*'` (the player re-reads max health/shield from `stats`).
- `class:changed` — `{ classId, previous }` (added to `GameEvents`).

Screenshots (1280×720): `docs/screenshots/07-class-select.jpg`, `08-skilltree-v2.jpg`, `09-skilltree-v2-dev.jpg` (dev flag).
