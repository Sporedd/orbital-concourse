# Integration notes: standing, gear, co-op

Integration pass of 2026-10-14. Systems I (standing), G (gear) and F (co-op) are now wired into the game.
The three `INTEGRATION.md` files (`src/standing`, `src/gear`, `src/net`) are kept as design notes, and each one carries a status header that points here.

## Verify

```
npm run typecheck     # app (src/, includes the net smoke tests)
npm run test:types    # tests/
npm test              # vitest: 15 files, 265 tests
npm run test:smoke    # standing smoke (199 checks) + gear smoke (~7.9k checks)
npm run test:net      # protocol + relay + end-to-end co-op session (18 checks)
npm run test:all      # all of the above
```

All of these pass headless. The production bundle (`vite build`) also builds.
Nothing was checked in a browser: the browser pane belongs to the rendering agent, and the UI agent checks the screens.

## How to run co-op

```
npm run relay         # ws://localhost:8787   (--port N / RELAY_PORT, RELAY_HOST to bind)
npm run dev           # open two tabs or two browsers
```

1. In each tab, press **F2** to open the lobby. A UI button can open it too, with `ctx.net?.lobby?.show()`.
2. In one tab, click **Host** and read the join code. In the other tab, enter the code and click **Join**.
3. The relay URL comes from the `?relay=ws://host:port` query parameter. If that is absent it uses `VITE_RELAY_URL`, and failing that `ws(s)://<page host>:8787`.

Two tabs of the **same browser profile** share `localStorage`, so they share the player id. The host then renames the second player (`<id>-<peer>`), and the client maps the id back. To get distinct ids, use two profiles or a private window.

## What was wired

### Boot (`src/main.ts`)

The boot order is now:

```
materials, fx, audio → world → players → enemies → loot → progression → standing → gear
→ net session → hud → rounds → lobby → rendering
```

- The player is created with `localPlayerId()` and `persistKey: 'concourse.weapons.v1'`.
- After gear boots, `localPlayer.reset()` runs once, so the loaded gear sets max health/shield and the gloves before the first run.
- `ctx.net` is created before the HUD so that UI widgets can read it at boot.
- `mountLobby(ctx, net, { hotkey: 'F2' })` is stored on `ctx.net.lobby`.

Each frame runs in this order:

1. `hud.update`
2. `paused = simPaused(screen, net.inSession)`
3. `net.update(dt)`: every frame, before the local player, outside the paused block
4. `world.update`
5. If not paused, the sim block: player, enemies, loot, rounds, `standing.update`, fx

**Host pause.** Single-player behaves as before: any screen freezes the sim. While `ctx.net.inSession` is true (role `host` or `client`), nothing freezes, and the open screen only captures that peer's input (`input.uiCaptured`). The round manager's own menu freeze (pause, skills, inventory) has the same co-op exception.

The boot-time helpers live in `src/core/storage.ts` so tests can import them: `migrateStorage`, `localPlayerId`, `simPaused`, `WEAPONS_KEY`.

### Storage (all keys are `concourse.*`)

`migrateStorage()` copies each old key to its new key once, then drops the old one. It never overwrites a new key that already exists.

| Old key | New key |
|---|---|
| `snowbound.progress.v1` | `concourse.progress.v1` |
| `snowbound.standing.v1` | `concourse.standing.v1` |
| `snowbound.sponsor.v1` | `concourse.sponsor.v1` |
| `snowbound.gear.v1` | `concourse.gear.v1` (`GEAR_STORAGE_KEY`, plus `LEGACY_GEAR_STORAGE_KEY`) |
| `snowbound.net.name` | `concourse.net.name` (`NET_NAME_KEY`; the old key is **kept**, see open items) |

Two keys are new:

- `concourse.weapons.v1`: the two weapon slots.
- `concourse.player.id`: `'p-'` followed by 8 base36 characters.

### Standing (system I)

**Events.** `GameEvents extends StandingEvents`, which adds `standing:*`, `hype:*` and `sponsor:chosen`. `onStanding` and `emitStanding` still work.

**Loot.**
- Every drop gets `ctx.standing.dropBoost(base)`: sponsor + crowd/boos + league.
- The boss floors stay keyed on the caller's own boost.
- `elementsOnly` forces the element of every generated weapon (new `GenerateOpts.element`).
- With `grenadeless`, grenade drops become ammo, mob tables skip grenades, the player starts with 0 grenades and refuses grenade pickups.

**Rounds.**
- `enemyCountMult` scales the round quota.
- `lootCountMult` scales the mob-table rolls (fractional part = chance of one extra roll) and the boss shower (minimum 2, for the two guaranteed items).
- With `bossEveryRound`, a headliner closes sub-waves 1 and 2 while the phase stays `wave`. Its kill drops 2 items and does not end the round.
- The crowd gift `hype:gift bonuswave` extends the current sub-wave and the kill quota.

**Enemies.** `enemyHealthMult` is applied in `EnemyManager.add()`, so the boss bar shows the scaled value.

**Player.**
- `runDamageMult(ctx)` (sponsor × crowd-gift buff) multiplies bullets, splash, ricochet, melee and grenades.
- `noShield` sets max shield to 0. It also applies at once on `sponsor:chosen`.

**Progression.** XP for kills and round clears is multiplied by `standing.xpMult()`. Co-op clients apply the same multiplier to relayed XP.

**Hype.**
- With `enemy:killed.cause === 'melee'`, melee finishers are scored exactly. Kills without a cause fall back to the old same-frame inference.
- Airborne kills use `PlayerState.onGround`, with a 0.2 m floor.

**Gear quality worn (PLAN §12).** On `round:cleared`, the player gets `round(gear score / 10)` standing as `reason: 'gear'`. A full tier-1 common loadout is about +2, a tier-20 legendary loadout about +50.

### Gear (system G)

**Contracts.**
- `LootKind` gains `'gear'`.
- `LootItemState` gains `gear?: GearDef`.
- `PlayerState` gains `loadout`.
- `Screen` gains `'inventory'`.
- `GameEvents` gains `'gear:changed'`. It is emitted typed now; the loose bridge was removed.

**Loot.**
- `'gear'` is in the random kind weights (0.1).
- `LOOT.mobGearDropChance` is 0.03.
- Bosses guarantee `['weapon', 'gear']`; the gear piece is at least Uncommon.
- Gear is picked up on walk-over: an empty slot equips it, otherwise it goes to the backpack. A full backpack leaves it on the ground.
- Grenade pickups respect `gear.maxGrenades`.
- The loot icon is the real parametric gear model with a rarity beam. The rendering agent had already added this to `src/loot/view.ts`, so no placeholder was needed.

**One stat path.** `player/shared.getStats(ctx)` returns progression stats × gear stats via `gear.mergedStats`. Max health and shield, fire rate, reload, crit, move speed and damage all read it. Run modifiers are not `PlayerStats`, so they multiply in through `runDamageMult`. `effectiveDamageMult(ctx)` is the product of both and is what co-op sends.

Gear extras, via `gearExtras(ctx)`:
- elemental resist (taken damage)
- shield regen
- melee multiplier
- element-chance bonus on weapons
- grenade capacity

`skill:changed` and `gear:changed` both recompute max values through the merged path.

**Set hooks.** All three are implemented, not just documented:

| Hook | Effect | Where |
|---|---|---|
| `voidrunner_dash` | A sprint-jump with movement input becomes an 18 m/s horizontal dash, with a 4 s cooldown and a small camera shake. | `Controller.dashEnabled` / `DASH_SPEED` |
| `bulwark_last_stand` | 50 % damage reduction for 2 s after the shield breaks, with a 10 s cooldown. | Player `takeDamage` |
| `pitfighter_bloodlust` | A melee kill refills the shield and refunds a grenade (unless `grenadeless`). | Player `doMelee` |

They are tuned only on paper and need a feel pass in the browser.

**Viewmodel** (`src/player/viewmodel.ts`, surgical, no material changes):
- The builder parts carry `vmRole` tags.
- `applyWeaponGrowth` runs in `applyTarget`. The seam is the existing accent glow, null for commons.
- `setGloves(def)` shows equipped gloves on the first-person hand and hides the default fist and cuff. It is called on `gear:changed` and on `reset()`.
- The glove model animates every frame and is disposed with the viewmodel.

**Materials.** Gear models and the paper doll now pass `surface: 'character'`.

### Co-op (system F)

**Ids.** Every peer boots with a unique persisted id, so ids pass through the host unchanged. The collision fallback (`<pid>-<peer>`) and the client's `toLocal` mapping stay for two tabs of one profile. The smoke test still covers that path.

**Loot.**
- `LOOT_KINDS` gains `'gear'`. The table is append-only, because indices go on the wire.
- `LootW.g` and the `pk` event's `g` carry the `GearDef`.
- The client validates it with `sanitizeGear`, picks it up on walk-over through the host, and its own gear system moves it into the inventory.
- The host uses `loot.remove()` instead of splicing `items()`.
- `LootMirror` implements `dropItem` and `remove`. Client drops are local-only items.
- `HEALTH_PICKUP` and `AMMO_PICKUP` are now exported from `src/loot` instead of being duplicated.

**Revives.** The host calls `PlayerState.revive()` for local and remote players. `reviveLocalPlayer` is kept as a thin wrapper. Ammo is no longer refilled and the player no longer snaps to the start position.

**Damage claims.**
- Fires send `effectiveDamageMult` (skill tree × gear × sponsor/crowd) and the merged `critMult`.
- Ticks send `mm: [damageMult, gearMeleeMult]`, so the host's melee claim cap allows gear melee bonuses without loosening the gun cap.
- The `g` (on-ground) flag now comes from `PlayerState.onGround`.

**Mirror damage.** `MirrorEnemy.damage()` returns the predicted amount (0 while shielded). This means hit counts, crit refund and lifesteal now work for client shots. Before, they read a health delta that never changed on the mirror.

**`NetSession` additions:**
- `inSession`
- `lobby?` (set by main.ts)
- `net:changed` (role/status/code/peers/error) on every state change, for UI widgets

## Contract changes (`src/core/types.ts` / `events.ts`)

| Change | Notes |
|---|---|
| `Enemy.damage(): number` | Returns the damage actually applied: 0 when dead or immune, overkill excluded. Callers use the return instead of a health delta: weapons (hits, crit refund, lifesteal, ricochet). Updated fakes: `tests/helpers/fakeContext`, rounds, knownBugs. |
| `DamageCause` + `DamageOpts.cause` | `'bullet' \| 'melee' \| 'grenade' \| 'status' \| 'explosion' \| 'other'`. Carried on `damage:dealt.cause` and `enemy:killed.cause`. Bullets, splash and ricochet send `bullet`; melee sends `melee`; grenades send `grenade`; burn ticks and shock chains send `status`; bomber self-detonation sends `explosion`. |
| `LootSystem.dropItem(spec)` / `remove(id)` | `LootDropSpec` = an item without id/owner/age. Used for backpack drops (the UI's inventory screen already calls it), swapped weapons and co-op. |
| `PlayerState.revive(fraction)` | No-op if alive. Emits the new `player:revived`. |
| `PlayerState.onGround`, `PlayerState.loadout` | |
| `PlayerState.reset()` doc | Weapons and gear are kept. |
| `LootKind 'gear'`, `LootItemState.gear`, `Screen 'inventory'` | |
| `GameEvents` | Extends `StandingEvents`. Adds `gear:changed`, `net:changed`, `player:revived`. |
| `GameContext.standing / gear / net` | Stay optional (tests and tools boot without them). main.ts always wires all three. |
| `LOOT.mobGearDropChance` | 0.03. |

## Design decision: death keeps loot

Weapons and gear persist across runs and sessions, like the skill tree, and runs restart at round 1.

- `rounds.start()` clears enemies and ground loot and calls `player.reset()`, which restores vitals, ammo, grenades and position and keeps weapons. It adds the starter gun only when both slots are empty.
- The inventory is never cleared.
- Weapons are saved to `concourse.weapons.v1` on every `weapon:equipped` and reloaded with fresh ids at boot.
- `tests/smoke/integrated.test.ts` checks the game-over → retry path with gear equipped: full vitals from the merged stats, both weapons kept, no extra starter gun, sponsor unlocked after game over.

## Tests added or changed

**Added:**
- `tests/smoke/integrated.test.ts` (jsdom, main.ts wiring with standing, gear and an offline net session):
  - boot order and a unique id
  - round 1 to the boss shower, with a guaranteed non-common gear piece, a walk-over equip, the merged stats and standing earned
  - death → retry keeping weapons and gear
  - the single-player vs co-op pause policy
- `tests/integration/gearStats.test.ts`:
  - pickup → equip → `getStats` → max health
  - melee with the gear bonus and cause
  - full backpack
  - `dropItem` / `remove`
  - boss gear floor
  - weapon persistence
  - `revive`, `onGround`
  - elemental resist, `bulwark_last_stand`, grenade capacity
- `tests/integration/sponsors.test.ts` (real rounds, enemies, loot, player, progression, standing):
  - Free Agent, Double Trouble, Glass Cannon, Burn It All, Bare Knuckle, Prime Time
  - the contract lock
  - bonus wave on and off phase
  - XP multiplier
- `tests/core/storage.test.ts`: migration, the local id, `simPaused`.
- `tests/enemies/enemies.test.ts`: a new block on the applied-damage return, cause propagation and sponsor health scaling.
- `src/net/__smoke__/session.smoke.ts`: a new check that gear loot crosses the wire and lands in the client's inventory. The `FakePlayer` there gained `loadout`, `onGround` and `revive`.

**Changed:**
- `tests/rounds/rounds.test.ts`: boss guarantee is now `['weapon', 'gear']`; the fake enemy's `damage` returns 0; `FakeLoot` gained `dropItem` and `remove`.
- `tests/knownBugs.test.ts`: the immune fake returns 0.
- `tests/helpers/fakeContext.ts`: the fake player gained `revive`, `loadout` and `onGround`; the fake enemy returns the applied damage.
- `package.json`: added `test:smoke` and `test:all`.

## Open items

1. **Two-tab co-op browser test.** Everything above is verified only headless. Still to check in the browser:
   - F2 lobby, host/join
   - avatars, revives
   - gear pickups on a client
   - host pause not freezing the client
2. **`src/net/ui.ts` (UI agent).** Change `NAME_KEY` to the exported `NET_NAME_KEY` (`concourse.net.name`, from `@/net`). Then drop `keepOld: true` from the `snowbound.net.name` row in `src/core/storage.ts`. Until then, the lobby keeps reading the old key, which migration leaves in place.
3. **Lobby button (UI agent).** Call `ctx.net?.lobby?.show()` and stop the click from propagating, so it does not start a run. A "waiting for host" label on client start and retry would help, because `rounds.start()` is a no-op on a client.
4. **Remote avatars wearing gear.** `PlayerState.loadout` exists, but loadouts are not on the wire yet: `RemotePlayer.loadout` stays `{}`.
   - Proposal: send the loadout (5 `GearDef`s, about 1–2 KiB) in the client tick only when `gear:changed` fires, and relay it in `PlayerW`.
   - Each piece is validated with `sanitizeGear` and attached with `buildGearModel` at the `src/gear/models.ts` anchors (`paperDoll.ts` is the reference).
   - Remote shield regen on the host also ignores the client's gear (`shieldRegenMult`).
5. **Set-hook feel pass.** The three hooks are implemented but untuned: dash speed and cooldown, the last-stand window, bloodlust.
6. **Kill cause on co-op clients.** The relayed `ek` event carries no cause, so client-side hype falls back to inferring melee finishers. Adding `c` to `ek` is a one-line protocol change.
7. **Sponsors in co-op.** Each peer's contract is local: the client's `noShield` and damage apply to itself, while enemy health and count follow the host's contract. A lobby-wide contract chosen by the host is still to do.
8. **Optional audio hooks** (`src/standing/INTEGRATION.md` §5f) are not wired. `src/audio` has no owner in this pass.
9. **Earlier contract gaps still open** (`src/net/INTEGRATION.md` §4):
   - `ProjectileSystem.snapshot()`
   - `EnemyState.frozen` / `immune`
   - an exported `ENEMY_CONFIGS` table
   - enemy audio and shakes on clients
