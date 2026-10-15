# Orbital Concourse — loot-shooter proof of concept

(Working title was SNOWBOUND; renamed with the Brutalist Arena art direction. Storage keys moved to `concourse.*` with a one-time migration in `src/main.ts`.)

**Theme: space gladiator.** You are a fighter in an orbital arena. You go in, fight waves and a headliner boss, and come out with better gear. Winning raises your **standing**; standing unlocks a more luxurious resting area (your quarters/hub between matches), better sponsors and better loot. The look is **Brutalist Arena** (docs/ART_DIRECTION.md): a matte concrete colosseum lit by floodlights in haze; only light, loot, threat and one league accent are saturated.

Core loop: **clear a wave of mobs → fight a boss → loot shower → next round, harder.** Guns drop with random stats and rarity; kills give XP; XP buys skill points.

The arena is the orbital colosseum: concrete pit, airlock gates, stands with an instanced crowd, floodlight towers with haze shafts, LED boards, planet + stars through the roof oculus.

Stack: Vite + TypeScript + Three.js. No physics engine (custom capsule-vs-box collision is enough for an arena). No external art: everything is procedural geometry, shaders and synthesized audio, so the whole game is code.

---

## 1. Pillars

1. **Guns feel great.** Recoil, muzzle flash, tracers, hit flash, damage numbers, screen shake, crisp sound.
2. **Loot is the reward.** Rarity beams, loot showers after a boss, weapon cards you want to read.
3. **Escalation.** Every round is bigger: more mobs, tougher boss, better loot, new skill points.
4. **The look.** Lit, not drawn: 2-band soft toon ramp, chamfers, haze and floodlights; no outlines or hatching (docs/ART_DIRECTION.md).

## 2. Game loop

```
START SCREEN ─click─▶ INTERMISSION (5s, "Round N") ─▶ WAVE ─all mobs dead─▶ BOSS ─boss dead─▶ CLEARED
                            ▲                                                                   │
                            └──────────────── loot shower, XP bonus, skill tree prompt ◀────────┘
```

Round scaling (N = round number):
- Mobs to kill: `8 + 4·N` (spawned in trickle so ~6–10 are alive at once)
- Mob health/damage: `×(1 + 0.25·N)`
- Boss: health `×(1 + 0.5·N)`, boss type rotates (Brute → Summoner → Artillery → …), gets a second attack from round 3
- Loot rarity weights shift upward every round; boss drops 3–5 items with at least one Rare+

Player death → GAME OVER screen with round reached, kills, best weapon; restart keeps the skill tree.

## 3. Systems and owners

Each system lives in its own folder and is built by its own Opus subagent against the shared contracts in `src/core/types.ts`. Nobody edits another system's folder; integration happens in `src/main.ts`.

| # | System | Folder | What it delivers |
|---|--------|--------|------------------|
| A | **Rendering + World** | `src/rendering/`, `src/world/` | Toon material factory (2-band ramp + surface injection), bloom/grade/grain post chain, haze (fog, shafts, ground haze), orbital sky. Arena: concrete colosseum floor + hazard paint, round wall with airlock gates, boss gate, stands + instanced crowd, floodlight towers, LED boards, cover props, plinth; collision boxes; spawn points. Screen shake + damage-edge helpers. |
| B | **Player + Weapons** | `src/player/` | Pointer-lock FPS controller (walk, sprint, jump, gravity, capsule collision), health + recharging shield, viewmodel gun built procedurally per weapon archetype, hitscan firing with pellets/spread/recoil, reload, 2 weapon slots, elemental effects applied on hit, damage numbers spawned. |
| C | **Enemies** | `src/enemies/` | Procedural low-poly creatures: **Grunt** (melee rusher), **Spitter** (ranged projectile, keeps distance), **Bomber** (fast, explodes). Bosses: **Brute** (charge + ground slam), **Summoner** (spawns grunts, shielded phases), **Artillery** (mortar barrages, weak point). Steering with separation, hit reactions, death animations, status effects (burn DoT, shock, ice slow). |
| D | **Loot + Progression + Rounds + HUD** | `src/loot/`, `src/progression/`, `src/core/rounds.ts`, `src/ui/` | Weapon generator (5 archetypes × rarity × element × random parts → name + stats), drop tables, loot beams + pickup prompt + weapon comparison card, ammo/health pickups. XP, levels, skill points, skill tree screen (Damage, Fire Rate now; tree structured for more), localStorage persistence. Round state machine. HUD: crosshair, health/shield, ammo, round + kill counter, boss bar, round banners, game over, start screen. |
| E | **Audio** | `src/audio/` | Web Audio synthesized SFX: per-archetype gunshots, reload, hit marker, enemy hurt/death, boss roar, pickup, level up, UI. Ambient wind loop + simple procedural music bed that intensifies for the boss. |

Integration (done by the lead after agents finish): wire factories in `main.ts`, run in the browser, play through two rounds, fix.

## 4. Shared contracts (summary; full version in `src/core/types.ts`)

- `GameContext` — scene, camera, renderer, input, events, materials, time, rng, and the live systems (`world`, `player`, `enemies`, `loot`, `audio`).
- `EventBus` — typed events: `enemy:killed`, `boss:spawned`, `boss:health`, `player:damaged`, `weapon:fired`, `loot:dropped`, `loot:pickup`, `round:started`, `round:boss`, `round:cleared`, `xp:gained`, `level:up`, `game:over`, …
- `WeaponDef` — archetype, rarity, element, damage, fireRate, magSize, reloadTime, pellets, spread, range, critMultiplier, name, color.
- `PlayerStats` — multipliers from the skill tree (damage, fireRate, …) read by the weapon system every shot.
- `Enemy` — id, object3D, isBoss, health, `damage(amount, point, element)`.
- `WorldQuery` — `resolveCapsule()`, `raycast()`, spawn points.

## 5. Weapons

| Archetype | Fire | Mag | Pellets | Feel |
|-----------|------|-----|---------|------|
| Pistol | semi, 4/s | 12 | 1 | accurate, crit-focused |
| SMG | auto, 12/s | 36 | 1 | spray, high recoil |
| Shotgun | semi, 1.5/s | 6 | 8 | spread, huge close damage |
| Rifle | auto, 7/s | 30 | 1 | all-rounder |
| Sniper | semi, 1/s | 5 | 1 | ×3 crit, long range |

Rarity: Common (white) → Uncommon (green) → Rare (blue) → Epic (purple) → Legendary (orange). Each tier adds stat budget and a chance of a perk (e.g. "bullets ricochet", "crits refund ammo", "fire rate ramps while shooting").
Elements: None, Fire (burn DoT), Shock (×2 vs shields, chains), Ice (slow, shatter crit on frozen). Element colours the tracers, muzzle flash and the gun itself.
Names are generated: `[Prefix by element] [Manufacturer-style word] [Archetype noun]` → "Molten Jakko Ripper".

## 6. Skill tree (v1)

- Kills give XP; each level gives 1 skill point. Level curve `100·L^1.4`.
- Screen opens with **Tab**; nodes have 5 ranks each.
- **Damage**: +8 % per rank. **Fire Rate**: +6 % per rank.
- Tree is data-driven (`skills.ts`), so new branches (reload speed, shield capacity, crit, elemental damage, movement) are a one-line addition.
- Persisted to localStorage with level and XP.

## 7. Visual target

Direction C · **Brutalist Arena** (spec: `docs/ART_DIRECTION.md`, mood frame: `docs/concepts/C-brutalist.png`, screenshots: `docs/screenshots/`). A concrete colosseum on an orbital station: matte near-grey world (2-band soft toon ramp, concrete mottling and contact grime, chamfered slabs), floodlight shafts in haze, a silhouetted reactive crowd, hazard floor paint, LED dot-matrix boards. Saturation is spent only on light, loot (rarity beams), threat (enemy visors/cores) and one accent colour per league. Bloom is luminance-threshold based, so the brightness hierarchy decides what glows. The HUD is stadium scoreboard + station safety signage (Archivo expanded, Saira Stencil One, Martian Mono; flat panels, hazard tabs, segmented gauges).

## 8. Roadmap

Each milestone ends in something playable. Milestones are sized so one or two Opus agents can build them against the existing contracts; the lead integrates and plays.

Status 2026-10-14: M0–M4 done; M5 (hype + sponsors), M7 (standing + ranks; hub scene not yet), M9 (hazards; objectives not yet) and M12 (co-op; needs a two-tab browser test) are implemented and wired. Test suite: `npm run test:all`. Leftovers are tracked in docs/INTEGRATION_NOTES.md.

**M0 — Scaffold** ✅ Vite project, contracts, stubs.
**M1 — Core loop (POC)** ✅ Systems A–E in parallel, integration, play rounds 1–2. (Snow arena placeholder theme, since replaced.)
**M2 — Feel & balance pass** — tune movement, recoil, time-to-kill, enemy aggression, drop rates; screenshot review of the look; performance pass (60 fps with 25 enemies); death recap screen.
**M3 — Orbital colosseum re-theme** ✅ (look-dev pass) — concrete pit, stands with an instanced reactive crowd, floodlight towers with haze shafts, LED dot-matrix boards (round, your name, hype), planet + stars through the oculus, airlock gates the mobs come through. Still open: Announcer text ticker + stings.
**M4 — Gear & visual scaling (§11)** — gear slots and affixes, item level drives parametric models (horns, pauldrons, spikes), weapon viewmodels scale with level, inventory + paper-doll screen, `'gear'` loot kind, boss guarantees a piece.
**M5 — Crowd favour & sponsors** — hype meter fed by style; crowd gifts (crate, buff, bonus wave) and boos (worse drops); pre-run sponsor contracts that change the rules (elemental-only drops, double enemies/double loot, no shield/+damage, boss every round).
**M6 — Round variety** — per-round mutators (fog, low gravity, exploding enemies, all-shielded, berserk); elite enemies with affixes (Frozen, Vampiric, Shielded, Splitting) and guaranteed loot; mini-events (loot thief, contested supply pod, enemy free-for-all).
**M7 — Standing & the hub (§12)** — 25 ranks in 5 leagues; the hub scene (your quarters) that grows with rank; trophy wall, codex, sponsor board, gate to the arena; standing persisted.
**M8 — Player power** — one active ability per skill-tree branch (dash, shockwave slam, drone turret, time slow); weapon mastery per archetype; overcharge (stand still to charge a big shot, move to charge a dash); more tree nodes.
**M9 — Objectives & hazards** — objective sub-waves (hold the centre, escort a loot drone, destroy generators, survive unarmed); league-specific arena hazards (laser grids, gravity pulses, vent pulls, shrinking ring); second arena layout.
**M10 — Rival gladiators** — named recurring mid-bosses with their own escalating gear, taunts that reference past fights, drop their gear when beaten.
**M11 — Loot depth** — weapon parts (barrel/mag/stock/scope as visible model pieces), stripping parts at the hub and bolting them on another gun; gear set bonuses; cursed items with downsides; cosmetic trophies as items.
**M12 — Co-op (§9)** — relay server, lobby in the hub, join codes, remote avatars wearing their gear, snapshots and interpolation, revives, combo kills, spectator betting.
**M13 — Daily arena & leaderboards** — seeded daily run (same seed for everyone), local bests, then a small server for leaderboards and standing sync.
**M14 — Ship** — settings (sensitivity, volume, quality presets), gamepad, save slots, a proper title/menu flow, itch.io/web build, optional Electron/Tauri wrapper for Steam.

## 9. Co-op readiness (milestone 2: 2–4 player PvE)

Model: **host-authoritative over a WebSocket relay.** One browser hosts the simulation (enemies, rounds, loot); a tiny Node relay forwards messages. Clients own their own movement, send inputs/shots, and receive ~20 Hz snapshots.

Rules every system follows from day one so that co-op is an add-on, not a rewrite:
- **Sim/presentation split.** Enemies, loot and rounds keep their state in plain serializable objects (`EnemyState`, `LootItemState`, `RoundState`) and emit events. Meshes and effects are created by a *view* that only reads that state. On a client the view is fed by snapshots instead of a local sim.
- **Entity ids.** Every enemy, loot item, projectile and player has a string id, assigned by the sim.
- **Players are a registry.** `ctx.players` lists every player (local + remote); enemies target the nearest, damage carries a `playerId` for attribution and XP.
- **Loot is instanced per player** (`ownerId`), so nothing needs arbitration.
- **Seeded RNG** (`ctx.rng`) in all sim code so the host can be deterministic where it matters.
- **Local input stays local.** Nothing reads `ctx.input` except the player controller and the UI.

System **F — Networking** (`src/net/`, milestone 2): relay server (`server/relay.ts`, `ws`), lobby/join code, snapshot encode/decode, remote player avatars + name tags, interpolation, host migration out of scope.

## 11. Gear and visual scaling (milestone 3)

Loot should *look* like progress. Every item has an **item level** (`level` = round it dropped at + a rarity bonus) and the procedural model is parameterised by it, so higher-level pieces are visibly bigger, spikier and brighter.

- **Gear slots:** helm, chest, boots, gloves, trinket. Each rolls affixes from a pool (health, shield, shield recharge, move speed, crit, reload, elemental resist, grenade count...), with rarity controlling affix count and budget, like weapons.
- **Parametric growth:** each slot's model exposes "growth knobs" driven by item level — helm: horn length/curl/count, crest height; chest: pauldron size, plate layers, fur trim; boots: spike length, sole thickness; gloves: visible on the viewmodel hand (the one slot you always see first-person). Rarity drives the material: common dull toon, legendary animated glow seams + particles. Elemental affixes tint the glow.
- **Weapons too:** the viewmodel scales barrel length, magazine size, scope size and adds fins/spikes with item level; a level-20 legendary shotgun should look absurd.
- **Where you see it:** a paper-doll preview in the inventory screen (third-person model rotating, swap gear live), co-op teammates' avatars (the big payoff for multiplayer), and your own shadow/gloves in first-person.
- **Inventory:** limited backpack, compare cards for gear like for weapons, equip/drop, vendoring not needed yet.
- Drop source: same loot system (`LootKind` gains `'gear'`), bosses guarantee one gear piece.

## 12. Standing and the hub (milestone 4)

- **Standing** is a persistent score (localStorage, later server) earned from rounds cleared, bosses killed, crowd-pleasing play (multi-kills, no-damage waves, melee finishes) and gear quality worn. It unlocks **ranks**, many of them so there is always a next step: 5 leagues × 5 tiers each (25 ranks), each tier a visible change somewhere (hub prop, title, crowd size, loot weights):
  - **Scrap League:** Fodder → Deckhand → Brawler → Scrapper → Pit Dog
  - **Iron League:** Rookie → Fighter → Contender → Bruiser → Enforcer
  - **Steel League:** Veteran → Duelist → Gladiator → Warlord → Champion
  - **Star League:** Starblade → Conqueror → Titan → Legend → Immortal
  - **Void League:** Myth → Paragon → Ascendant → Icon → Eternal
  Each rank needs more standing than the last (curve like the XP curve), and each league changes the arena dressing (bigger crowd, better lights, new hazards) and the hub's floor of the station.
- **The hub** is a separate scene you load between arena runs (and optionally during intermission): your quarters on the station. It is built from the same procedural kit and upgrades with rank — Rookie: a bunk in a cargo bay with a flickering light; Contender: a real room with a gear rack and a window; Champion: lounge with a bar, trophies, a view of the arena; Legend: penthouse with a holo-wall of your fights, servants/drones, a private shuttle. Each rank adds props and lighting rather than replacing the scene, so progress is visible.
- **Hub functions:** paper-doll gear screen (see §11), skill tree, trophy wall (bosses killed, best round), sponsor board (choose a contract that modifies the next run: more enemies for more loot, elemental-only drops, etc.), and the gate to the arena. In co-op the hub is the lobby: friends appear in your quarters.
- **Arena theme:** orbital colosseum — stands with a cheering crowd (instanced billboards/particles), floodlights and stage lasers, holo-billboards showing the round and your name, a planet and stars overhead, hazards per rank (laser grids, gravity pulses) later.

## 10. Decisions (confirmed)

- **Weapons:** full depth — 5 archetypes, 5 rarities, elements (fire burn, shock ×2 vs shields, ice slow) and rarity perks.
- **Health:** health + recharging shield (Borderlands-style). Health only via pickups.
- **Enemies:** Grunt, Spitter, Bomber; bosses Brute, Summoner, Artillery with phases.
- **Progression:** level, XP, skill points and tree persist in localStorage; death restarts at round 1.
- **Audio:** synthesized SFX + ambience + music bed (Web Audio, no files).
- **Extras:** sprint + jump, melee (V), grenades (G, arc + area damage, drop as loot). No slide.
- **Pace:** fast arcade — high move speed, aggressive mobs, quick time-to-kill.
- **Round length:** medium — `20 + 8·N` mobs in 3 sub-waves, then the boss (3–5 min per round).
- **Multiplayer:** architected for 2–4 player PvE co-op now; single-player ships first, co-op is milestone 2.

## 13. Requirements added 2026-10-15

- **Gear is meta progression, not loot.** Helm/chest/boots/gloves/trinket no longer drop. They are bought in a **shop** (between rounds and from the hub/start menu) and improved through an **upgrade system** (spend cash to raise item level / reroll or add affixes; cost scales with rarity and level). Bosses may still drop *weapons*; weapon drops stay as they are.
- **Cash ("scrip").** Weapons that despawn (expire on the floor) are salvaged into cash based on rarity and item level; a manual salvage action on a weapon pickup prompt does the same. Cash persists; it funds the shop and upgrades.
- **No auto-continue between rounds.** After a round is cleared the game waits in a **pit stop**: loot stays, the player can compare/equip gear, open the shop, spend skill points, and then presses Continue to start the next intermission. (Co-op: host continues.)
- **Animations:** per-archetype reload animations (mag out / in, pump, bolt, cylinder) and a grenade throw animation on the viewmodel; melee bash kept. Timings match reloadTime and the grenade cooldown.
- Skill-tree player hooks (docs/SKILL_TREE.md §5): Q active key, Shield Bash, Deadeye, Second Wind, Overheat, Ricochet Doctrine, extras, class starter weapon; `music.setBossPhase(n)` wiring.
- XP curve: adopt `100·L^1.1` (docs/SKILL_TREE.md pacing).

## 14. Backlog added 2026-10-15 (planned, not started — user said: plan only until told otherwise)

- **Guns reset on death.** On game over (SP and co-op host) every weapon in loadout and backpack is lost; the next run starts with the class starter weapon only. Lost guns are auto-salvaged into scrip at the normal salvage value and the credit is shown on the recap. Everything else stays meta progression: gear and upgrades, scrip, skill trees, level/XP, standing/rank, sponsor, settings. Co-op clients: check whether they keep their own guns today; if so, mirror the wipe through the existing round messages rather than a protocol redesign.
- **Make "what you keep" clear, styling-wise.** Game-over screen gets a KEPT band (gear with piece count and item levels, scrip incl. the salvage credit, level/XP, standing earned, sponsor) in accent/BONE and a LOST band (each lost gun as a dimmed rarity-coloured mini card with "+N scrip salvaged") in THREAT red, plus a one-line rule under the header ("GUNS DIE WITH YOU · GEAR, SCRIP AND STANDING ARE YOURS"). Same line on the pit-stop footer and near the first-run hint. Fits 1280×720 and 844×390 under `html.mobile`. Help topics (The Loop, Weapons, Loot & Salvage, Gear & Sets), docs/ECONOMY.md and this section updated; tests for the wipe, the salvage sum and the KEPT/LOST DOM.
- **Mobile follow-ups** (after a real-phone test): analog movement instead of 8-way keys, touch wording for "DOUBLE-CLICK TO BUY" / "HOVER A PIECE" / "CLICK TO RESUME", iOS Safari fullscreen/viewport/audio-unlock checks, real-GPU frame rate against the 30 fps target.
- **Co-op parity + economy balance pass** (from docs/HANDOFF.md): client loot:expired salvage, Deadeye/Bash parity on the host sim, gear upgrades over the wire and avatar refresh, economy balance simulation against real income.
- **Enemy polish:** verify death, hit-flash and attack poses on the new trooper rigs visually; the lineup screenshot crop; fix the collision ray-along-face edge case in src/world/collision.ts.
- **Slow time while comparing weapons.** Walking over a dropped gun and holding the compare prompt (or opening the pickup compare card) eases the sim to ~0.2× time scale (`enemies.setTimeScale` already exists, extend to projectiles/hazards/round clock) with a short ease in/out, a desaturated/vignetted grade and a muffled audio filter; releases to 1× when the card closes or after a cap (~4 s) so it can't be abused as free invulnerability. Co-op: local presentation only, never changes the host sim; clients get no slow-mo in a session (or the host grants a short shared one — design call).
- **Bosses must never get stuck on arena props** (seen: the first boss wedged between arena elements and became trivial). Layers, cheapest first:
  1. *Placement guarantee:* props and dressing (crates, barrels, chains, buttresses, pit-stop furniture) are generated with a **boss-clearance test**: rasterise the floor to a 0.5 m grid, mark cells blocked by any collider inflated by the largest boss radius (Artillery 2.35 m), and require that the boss plinth, every gate and the whole central ring stay one connected region. A vitest check runs this for every league layout and seed used in tests, and the generator retries or drops the offending prop.
  2. *Steering:* enemies get whisker raycasts (left/centre/right, enemy radius) against `world.resolveCapsule` to slide around corners instead of pushing into them; bosses use the full capsule, not a point, when choosing a direction.
  3. *Navigation:* a flow field toward the player on the same grid (recomputed ~4×/s, per boss radius class), so the boss walks around obstacles instead of straight at the player.
  4. *Stuck detection + breach:* if a boss intends to move but travels < 0.3 m in 1.5 s it is "stuck": Brute smashes the prop in the way (props become destructible: crates/barrels break, chains tear; fixed architecture never blocks because of layer 1), Artillery steps over anything below knee height, Summoner floats over everything. As a last resort after 4 s, a telegraphed leap/teleport to the nearest clear cell within 6 m of the player.
  5. *Anti-cheese:* if the boss cannot reach the player for 8 s it switches to its ranged pattern and the crowd boos (hype drops); keeps the fight honest even if 1–4 fail.
  Also: scripted boss spawn always on the plinth with a cleared 6 m radius; dev overlay `window.__nav.debug()` that draws the blocked grid and flow field; a headless test that drives each boss from its gate to five player positions and asserts arrival.
- **BUG: fires vs LED/accent strips.** A thin accent strip draws as a hard line straight through the soft glow of a fire (user screenshot 2026-10-15). Likely transparent-sorting: the fire's glow halo is a large billboard sorted by its centre, so a strip that is nearer than the centre is drawn after it (or the strip writes depth and clips the halo). Fix candidates, in order: (1) fire halos/smoke in `src/world/fire.ts` get `depthWrite: false`, additive blending and a higher `renderOrder` than strips, strips (`src/world/glows.ts` / props accent strips) get `depthWrite: false`; (2) if strips are opaque glow meshes, give fire halos `depthTest: false` and draw them in a late pass before the post chain; (3) check bloom isn't double-brightening the overlap. Add a headless screenshot test that places a strip in front of a fire and asserts no hard edge (luma gradient monotonic across the strip line). Check the same for pit-stop braziers and gate lamps.
- **Progress save export / import.** All persistent state lives in localStorage (`concourse.progress.v1`, `standing.v1`, `sponsor.v1`, `gear.v1`, `wallet.v1`, `shop.v1`, `settings.v1`, `mobile.v1`, `player.id`, `net.name`), which a cleared browser or a different device loses. Add a **Save** panel (settings screen, and the start menu): *Download as .txt* (one JSON document with `version`, `exportedAt`, every key above, plus a checksum), *Copy to clipboard* (same text, base64-wrapped so it survives chat/email line breaks), and *Import* (paste box + file picker; validates version and checksum, shows a KEPT-style summary of what will change — rank, level, scrip, gear count — then asks to confirm before overwriting; a backup of the current state is written to `concourse.backup.v1` first so one undo is possible). Migrations run on import like on boot. Reject imports that would lower the schema version without a migration. Export is also offered automatically on game over and on rank-up (a small "SAVE PROGRESS" button). Mobile: share-sheet (`navigator.share` with a text file) when available. Tests: round-trip export→import equals original, tampered checksum rejected, older schema migrated.
- **Crosshair gap must match the real shot cone.** Today `src/ui/hud.ts` sets the gap to `4 + min(spread·420, 48)` CSS px (ADS ×0.6) while `src/player/weapons.ts` samples shots uniformly inside a cone of half-angle `spread` rad. Projected radius of that cone is `tan(spread) · (innerHeight/2) / tan(fov/2)` px (Three.js fov is vertical): ≈393 px/rad at 720p and 589 px/rad at 1080p with fov 85, so the bracket under-reads by ~2× at 720p and ~3× at 1080p, saturates at a 24 px radius (an SMG at full bloom really covers ~74 px at 1080p), and under ADS it shrinks ×0.6 while the zoomed FOV actually makes the on-screen cone ~1.5× bigger per radian. Fix: compute the bracket inner edge from the projection formula using the live `camera.fov` (includes sprint bump and ADS zoom) and the viewport height, remove the ADS multiplier and the 48 px cap (clamp at ~40 % of the viewport instead), keep the recoil kick as a purely visual add, and draw a faint 1 px circle at the exact cone radius while bloomed so shotgun/SMG players see the real envelope. Test: for several (spread, fov, height) triples the DOM gap equals the projected radius within 1 px; headless check: 200 shots fired at a wall all land inside the drawn circle.
- **Damage drop-off by range.** Each WeaponDef gets a falloff curve derived from its archetype and `range`: full damage up to `falloffStart` (shotgun 6 m, SMG 12 m, pistol 18 m, rifle 30 m, sniper 60 m, scaled by range/archetype-base), then a linear or smoothstep drop to `minMult` at `range` (shotgun 0.25, SMG 0.45, pistol 0.55, rifle 0.6, sniper 0.9), never below; beyond `range` the shot still hits at `minMult` (hitscan already stops at range). Elements/perks apply after the multiplier; crits multiply as now. Show it: weapon card gets a small range bar with the two markers, the hit marker/damage number is dimmer when the multiplier is < 0.6, and the help Weapons topic gains a sentence. Sniper and shotgun identities come mostly from this curve, so re-tune their base damage with it in the economy balance sim. Co-op: computed on the host from the validated hit distance. Tests: the curve is monotonic, equals 1 below start and `minMult` at range, and per-archetype values match the table.
