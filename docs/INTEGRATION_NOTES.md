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
| `snowbound.net.name` | `concourse.net.name` (`NET_NAME_KEY`; the lobby reads it, so the old key is dropped like the others) |

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
| `voidrunner_dash` | A sprint-jump with movement input becomes a 15 m/s horizontal dash (about 1.4× the 11 m/s sprint), with a 5 s cooldown and a small camera shake. | `Controller.dashEnabled`, `DASH_SPEED`, `DASH_COOLDOWN` |
| `bulwark_last_stand` | 40 % damage reduction for 2.5 s after the shield breaks, with a 12 s cooldown. | Player `takeDamage`, `LAST_STAND_*` |
| `pitfighter_bloodlust` | A melee kill restores 35 % of max shield (additive, capped) and refunds one grenade at most every 8 s (never past the cap, never with `grenadeless`). | Player `doMelee`, `BLOODLUST_*` |

Tuning pass of 2026-10-14 (see "Cleanup pass" below): the first numbers were 18 m/s / 4 s, 50 % / 2 s / 10 s, and a full shield refill plus a grenade on every melee kill. The dash at 18 m/s crossed half the pit in one jump and the full refill made melee chains unkillable; the values above are meant to be felt but not to carry a build. The constants are exported, so a later feel pass only touches `src/player/controller.ts` and `src/player/index.ts`.

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

## Cleanup pass (2026-10-14, evening)

A second pass over the leftovers the build agents reported. Everything below is covered by `npm run test:all` and was checked in the browser pane where noted.

1. **League accents.** `src/standing/ranks.ts` now reads its accents from `LEAGUE_STYLE` in `src/rendering/style.ts` (Scrap `#FF5F1F`, Iron `#FFC61A`, Steel `#1FD1C1`, Star `#E8368F`, Void `#8C6CFF`). One source of truth; the standing smoke test checks the new values.
2. **Mouse sensitivity.** `Controller.look()` multiplies `MOUSE_SENSITIVITY` by `getSettings().mouseSensitivity`. The interim `installSensitivityHook` is gone (function and call), so the scale applies once. `tests/smoke/ui.test.ts` checks the controller path and that `Input.mouseDelta()` stays raw.
3. **Health overshoot (119 / 118).** The sim clamp in `applyMaxStats` was already correct: a fractional max such as 100 × 1.1 × 1.184 = 130.24 was shown as `ceil(current) / round(max)`. The HUD now uses `vitalText()` (`src/ui/hud.ts`): current rounds up, max rounds to nearest, and current never reads above max. Tests: a sim test in `tests/integration/gearStats.test.ts` (gear on, hurt, gear off, re-equip, skill change) and a formatter test in the UI smoke.
4. **Hit flash.** Enemies and co-op mirrors flash emissive BONE at exactly lum 1.2 (`glowLum(PALETTE.BONE, LUM.seam)`), was BONE × 1.4.
5. **Boss size.** Rigs carry a `scale` (`Rig.scale`, `BOSS_SCALE` in `src/enemies/models.ts`) that the view applies to the root every frame, including the death sink: brute ×1.35 (5.0 m, 2.7× grunt), summoner ×1.3 (5.85 m, 3.2×), artillery ×1.3 (4.95 m, 2.7×). Config radius/height/centerHeight, the weak-point radii (0.88 / 0.62 / 1.17) and `KIND_INFO` in `src/net/enemyMirror.ts` carry the same factors; the brute's probe/chest heights and the summoner bubble follow. Browser: round 1 reached the boss phase in co-op; both tabs showed the boss bar (`HEADLINER · HULLBREAKER THE BRUTE · PHASE 1/3 · 100 %`) and a 5 m brute at rig scale 1.35.
6. **Gear set hooks.** Tuned, see the Set hooks table above.
7. **Standing audio hooks.** `src/audio/index.ts` listens to `standing:rank` (levelup, higher pitch on a league-up), `hype:changed` (tier up: boss_roar, full at ROARING; tier down: ui_open pitched down), `hype:gift` (round_clear) and `hype:boo` (low player_hurt). Existing SfxNames only; a crowd synth is still the natural follow-up.
8. **Co-op in the browser pane.** See the next section.
9. **`snowbound.net.name`.** `src/net/ui.ts` reads `NET_NAME_KEY`, so the `keepOld` flag is gone from `STORAGE_MIGRATIONS`.

### Co-op browser test (2026-10-14)

Setup: `npm run relay` and the app in two tabs of the browser pane, host + join by code through the F2 lobby. `.claude/launch.json` now has `relay` (port 8787) and `preview` (`vite preview` on 4173) entries next to `dev`.

What worked, through the UI where the pane allowed it and `window.game` otherwise:

- Host game → 5-letter code → Join in the other tab: the lobby lists both players (`HOSTY · HOST`, `CHALLENGER · YOU`, `2/4 PLAYERS`). Same-profile tabs share the player id and the host renames the second one (`<id>-<peer>`), as designed.
- `rounds.start()` on the host: enemies spawn and are mirrored on the client with the same ids; kills and XP reach the client (`totalKills` and `progression.xp` advance).
- The host's pause screen does not freeze the client: round `phaseTime` advanced at the same rate with the host on `pause` and on `none`.
- Boss phase: boss bar on both sides (item 5 above), mirrored boss health and phase.
- Revive: killing the client's `RemotePlayer` on the host downed the client (`player:died`), `revive(0.35)` brought it back (`player:revived`, 44 / 126 health shown as `45 / 126`).
- Gear on avatars (new, see below): the client's avatar on the host wore the client's chest, the host's avatar on the client wore the host's helm.
- Zero console errors in both tabs during all of the above.

What broke and was fixed:

- **A hidden tab freezes the host.** The browser pane runs `requestAnimationFrame` only for a visible pane, and a real browser stops it for a background tab, so a host that alt-tabs freezes the whole session and the relay eventually drops the silent socket. `src/main.ts` now keeps a 50 ms timer that steps `frame()` whenever rAF has been silent for 200 ms **while `net.inSession`** (single-player still freezes, which is what a hidden tab should do). `dt` stays capped at 1/20 s, so under a browser's 1 Hz background throttle the sim slows rather than jumps. The same frame skips `pipeline.render()` when the drawing buffer is 0 × 0, which removes the `GL_INVALID_FRAMEBUFFER_OPERATION` warning spam from hidden tabs.
- **Vite reloads.** With other sessions editing the tree, every save reloaded both tabs and killed the room mid-wave. The test was finished against `vite build` + `vite preview` (no HMR); the `preview` launch entry is for that.

Known limits of the pane: it cannot pointer-lock, so after the 0.8 s grace the HUD shows the pause screen in both tabs (the sim keeps running in co-op). A click on the canvas in a real browser locks the pointer and the screen goes away.

### Loadouts over the wire

`PlayerState.loadout` now crosses the wire, once per change rather than per snapshot:

- `ClientTickMsg.ld` carries the client's `Loadout` on the first tick after the welcome and whenever `gear:changed` fires for the local player.
- The host validates every piece with `sanitizeLoadout` (`src/net/protocol.ts`: `sanitizeGear` per slot, the slot must match), stores it on the `RemotePlayer`, dresses the host-side avatar and bumps that player's loadout version. The host's own loadout starts at version 1 (a persisted loadout reaches every joiner) and bumps on `gear:changed`.
- `PlayerW.lv` is the version; each snapshot includes `SnapMsg.ld` (`{ i, v, l }`) only for players whose version that client has not seen (per-link `sentLv`), never the client's own.
- The client validates again, keeps the loadout on its remote view and calls `Avatar.setLoadout()`.
- `Avatar` (`src/net/avatar.ts`) has gear anchors following the `src/gear/models.ts` conventions (helm at the head centre, chest at the torso centre, gloves at the wrists hanging along the arm, boots at the ankles, trinket beside the hip), turned by π because the avatar faces −Z, and scaled 1.15–1.5 to the avatar's chunkier proportions. Unchanged pieces are kept; legendary seams animate.
- Host-side shield regen for a remote player now includes the client's `shieldRegenMult` from `computeLoadoutStats`.
- `src/net/__smoke__/session.smoke.ts` checks both directions and that an invalid piece is dropped.

## Open items

1. **Lobby label on a client.** The start-menu `CO-OP` row opens the lobby without starting a run (verified). A "waiting for host" label on client start and retry would still help, because `rounds.start()` is a no-op on a client.
2. **Kill cause on co-op clients.** The relayed `ek` event carries no cause, so client-side hype falls back to inferring melee finishers. Adding `c` to `ek` is a one-line protocol change.
3. **Sponsors in co-op.** Each peer's contract is local: the client's `noShield` and damage apply to itself, while enemy health and count follow the host's contract. A lobby-wide contract chosen by the host is still to do.
4. **Crowd audio.** The standing hooks reuse existing sounds; a crowd bed whose loudness follows `hype.modifiers.value` is the natural follow-up.
5. **Earlier contract gaps still open** (`src/net/INTEGRATION.md` §4):
   - `ProjectileSystem.snapshot()`
   - `EnemyState.frozen` / `immune`
   - an exported `ENEMY_CONFIGS` table (`KIND_INFO` still mirrors the boss numbers by hand)
   - enemy audio and shakes on clients
