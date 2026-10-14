# Test-suite findings (2026-10-14)

Found while writing the headless suite. Line numbers are as of 2026-10-14; `src/` is being edited by others, so grep if they drift. `tests/knownBugs.test.ts` has `it.fails` tests for #1 and #2; flip to `it` once fixed.

1. **[FIXED 2026-10-14] Self-detonating bombers count as player kills (low–medium).** `src/enemies/mobs/bomber.ts:100` `explode()` calls `this.die(undefined)`, which emits `enemy:killed` with no killer. `src/progression/index.ts:150` gives XP for any kill, and `src/rounds/index.ts:177` rolls mob drops for it. Confirmed: a bomber blowing up on the player gave 10 XP.
   - Fix: in progression, `if (!ctx.isHost || !e.killerId || !ctx.players.get(e.killerId)) return;`.
   - In rounds, roll drops only when `e.killerId` is set, but keep counting the kill for wave progress.

2. **[FIXED 2026-10-14] Hits on immune targets still count for crit_refund, lifesteal and the hit counter (low, exploit).** In `src/player/weapons.ts:432-463`, `hits++`, `dealt += amount` and the crit refund happen even when the enemy took no damage. A shielded Summoner swallows hits, but its core still reports crits. Effects: Sharp Eye on the shielded core = infinite ammo; Vampiric heals off the shield; ricochet, splash and overkill counted the same way.
   - Fix: `const before = enemy.state.health; enemy.damage(...); const applied = Math.max(0, before - enemy.state.health);` and gate hits, lifesteal and refund on `applied > 0`. Or change the contract so `Enemy.damage()` returns the damage applied.

3. **[FIXED 2026-10-14] Splash also hits the enemy it splashed from (low; confirm intent).** `src/player/weapons.ts:449`: `damageRadius(hit.point, …)` includes the target at full strength, so it takes 130 %. If "area damage" means nearby enemies only, exclude the target (needs an `excludeId` option on `damageRadius`).

4. **[FIXED 2026-10-14] Perfectly stacked enemies are pushed the same way (low).** `src/enemies/base.ts:453`: the push axis is `dx = (this.id.length % 2) - 0.5`, and ids are usually the same length, so both enemies get the same push. Fix: base the sign on the pair, e.g. `const s = this.id < o.id ? 1 : -1`.

5. **[FIXED 2026-10-14] Presentation code uses the sim RNG (low, co-op determinism).** `src/player/viewmodel.ts:309,315,316` (kick roll, flash rotation and scale) and `src/player/weapons.ts:477-478` (recoil jitter) draw from `ctx.rng`, which breaks PLAN §9 seed reproducibility. Fix: give them a local `createRng`, the way `fx.ts` does.

6. **[FIXED 2026-10-14] Kills during intermission aren't counted at all (low).** `src/rounds/index.ts:167` excludes `'intermission'`. Summoner grunts can survive into the next intermission; killing them gives XP but not `totalKills`. Fix: count `totalKills` in every phase except idle and gameover.

7. **[FIXED 2026-10-14] Spawn selection only considers the local player (co-op, low).** `src/rounds/index.ts:76` sorts spawn points by distance to `ctx.player`. Fix: maximise the minimum distance to every living player.

8. **[FIXED 2026-10-14] Held keys after alt-tab (very low).** `src/core/input.ts:30` drops repeat keydowns, and blur clears held keys, so a key still held after returning to the window reads as released. Fix: on repeats, still add the key to `down`.

**Checked and found OK:** collision and raycasts; navigable points; weapon generator ranges; loot instancing and pickups; XP and persistence; the round state machine; enemy scaling, statuses and boss mechanics; player shield, reload, fire rate and perks.

See also `tests/PROPOSED_CHANGES.md` for non-bug source changes that would make testing easier.
