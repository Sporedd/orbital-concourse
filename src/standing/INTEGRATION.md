# System I — standing, ranks, crowd favour, sponsors: integration

> **Status (2026-10-14): applied by the integration pass.** The diffs below are kept as design
> notes; the code has moved on (see `docs/INTEGRATION_NOTES.md` for what landed where, the
> contract changes and what is still open).

Owner folder: `src/standing/`. Nothing outside it was edited. Everything below is a diff for the
lead (or the owning agent) to apply. Each hook is guarded with `ctx.standing?.` so it can land in
any order; until a hook lands, that one effect is simply missing.

Files:

| File | What it is |
|------|------------|
| `types.ts` | `RankDef`, `League`, `HypeModifiers`, `RunModifiers`, `SponsorContract`, `StandingEvents`, typed `emitStanding` / `onStanding` |
| `ranks.ts` | 25 ranks / 5 leagues, `rankThreshold`, `rankForStanding`, `progressToNext`, `dressingForRank`, `leagueLootBoost` |
| `standing.ts` | `createStanding(ctx)`: persistent score `concourse.standing.v1`, rank-up events |
| `hype.ts` | `createHype(ctx)`: crowd meter, tiers, gifts, boos, `HypeModifiers`; all tuning in `HYPE` |
| `sponsors.ts` | 8 contracts + Free Agent, `createSponsors(ctx)`, `composeModifiers`, hook helpers; last pick persisted in `concourse.sponsor.v1` |
| `index.ts` | `createStandingSystem(ctx)` → `{ standing, hype, sponsors, rarityBoost(), damageMult(), xpMult(), dropBoost(base), update(dt) }`, re-exports everything |
| `hud.ts` | Ready-made DOM widgets: `createHypeMeter`, `createStandingPanel` (rank badge + sponsor cards) |
| `smoke.test.ts` | Headless test (199 checks), run as described in §9 |

---

## 1. Events: `src/core/events.ts`

```diff
 import type {
   BossKind, Element, Enemy, LootItemState, PlayerStats, RoundPhase, Screen, WeaponDef,
 } from './types';
+import type { StandingEvents } from '@/standing/types';

-export interface GameEvents {
+export interface GameEvents extends StandingEvents {
```

This adds the following events. Until the diff lands, `onStanding(ctx.events, name, fn)` /
`emitStanding(...)` give the same typing.

| Event | Payload | When |
|-------|---------|------|
| `standing:gained` | `{ amount, standing, rank, reason, label }` | every award (`reason`: `round` / `boss` / `hype` / `consolation`) |
| `standing:rank` | `{ rank, league, previous, leagueUp }` | the rank index goes up (also sends a `ui:message`) |
| `hype:changed` | `{ value, tier, previousTier, tierChanged }` | immediately on a tier change, and every 0.5 s while the value moves |
| `hype:reaction` | `{ reason, label, amount, value }` | each labelled crowd reaction ("TRIPLE KILL · AIRBORNE", "SHIELD DOWN") for the ticker |
| `hype:gift` | `{ kind: 'crate'\|'buff'\|'bonuswave', round, position?, mobs?, buffSeconds? }` | every 25 s at ROARING |
| `hype:boo` | `{ seconds, rarityPenalty }` | Cold for more than 20 s (once per cold stretch) |
| `sponsor:chosen` | `{ id, name, title, modifiers }` | a contract is picked |

Optional, for an exact melee check (see §10, gap 1): add `cause?: 'bullet' | 'melee' | 'grenade' | 'status'` to `enemy:killed`.

## 2. Contract: `src/core/types.ts`

```diff
 import type { EventBus } from './events';
 import type { Input } from './input';
+import type { StandingSystem } from '@/standing';
 ...
-// Boot order: materials, fx, audio → world → players → enemies → loot → progression → hud → rounds
+// Boot order: materials, fx, audio → world → players → enemies → loot → progression → standing → hud → rounds
 ...
   progression: Progression; // boot
+  /** Standing, crowd favour (hype) and the sponsor contract. Read run modifiers from here. */
+  standing: StandingSystem; // boot
   hud: Hud; // boot
```

## 3. Wiring: `src/main.ts`

```diff
 import { createProgression } from './progression';
+import { createStandingSystem } from './standing';
 ...
 ctx.progression = createProgression(ctx);
+ctx.standing = createStandingSystem(ctx);
 ctx.hud = createHud(ctx);
 ...
     ctx.rounds.update(dt);
+    ctx.standing.update(dt); // hype decay/gifts/boos run only while the sim runs
     ctx.fx.update(dt);
```

`createStandingSystem` must be created before `createRoundManager`. Both listen to
`enemy:killed`; standing does not depend on the order. The hype meter's crate gift calls
`ctx.loot.dropLoot` itself, owned by the local player.

---

## 4. Effects exposed

`ctx.standing.hype.modifiers` is a `HypeModifiers` object that is mutated in place, so you can keep a reference to it:

| Tier | value | rarityBoost | xpMult | extra |
|------|-------|-------------|--------|-------|
| Cold | 0–25 | 0 (−0.1 while booed) | ×1 | after 20 s: `hype:boo` |
| Warm | 25–50 | +0.10 | ×1.1 | |
| Hot | 50–75 | +0.25 | ×1.25 | +15 standing (first time each round) |
| ROARING | 75–100 | +0.50 | ×1.5 | a gift every 25 s; +30 standing (first time each round) |

The meter rises to a tier at once and drops out of it only 2 points below the bound, so the tier does not flicker at the edge.
Gift buff: `damageMult` is 1.3 for 10 s and `buffRemaining` counts down.

`ctx.standing.sponsors.active` is a `RunModifiers` object, also mutated in place. It is locked from `game:started` until `game:over`.

Combined getters, which are what the hooks below use:

- `ctx.standing.dropBoost(base)` gives `clamp01(base + sponsor.lootRarityBoost + hype.rarityBoost + leagueLootBoost)`. The league bonus is 0.03 per league (0 to 0.12) and is the "better loot with rank" knob; turn it off with `createStandingSystem(ctx, { leagueLoot: false })`.
- `ctx.standing.damageMult()` gives `sponsor.damageMult × hype buff`.
- `ctx.standing.xpMult()` gives the hype tier's XP multiplier.

---

## 5. Hook diffs, in the systems that apply them

### 5a. Loot rarity, elements and grenadeless: `src/loot/index.ts` + `src/loot/weapons.ts`

`src/loot/weapons.ts`: let the generator take a forced element.

```diff
 export interface GenerateOpts {
   archetype?: WeaponArchetype;
   rarity?: Rarity;
   rarityBoost?: number;
   minRarity?: Rarity;
+  /** Force this element (sponsor "elementsOnly"). 'none' forces a plain gun. */
+  element?: Element;
 }
 ...
   // Element
   let element: Element = 'none';
-  if (rng() < ELEMENT_CHANCE[rarity]) element = pick(rng, ['fire', 'shock', 'ice'] as const);
+  if (opts.element !== undefined) element = opts.element;
+  else if (rng() < ELEMENT_CHANCE[rarity]) element = pick(rng, ['fire', 'shock', 'ice'] as const);
```

`src/loot/index.ts`: add the sponsor, hype and league boost to every drop, and apply elementsOnly and grenadeless.
Keep the boss Rare floor keyed on the caller's own boost; otherwise a ROARING crowd would turn every mob weapon into a Rare+.

```diff
   function makeItem(kind: LootKind, pos: THREE.Vector3, ownerId: string, tier: number, rarity?: Rarity, boost = 0, minRarity?: Rarity): LootItemState {
+    const run = ctx.standing?.sponsors.active;
+    if (kind === 'grenade' && run?.grenadeless) kind = 'ammo';
     const weapon = kind === 'weapon'
-      ? genWeapon(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity })
+      ? genWeapon(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity, element: run?.elementsOnly })
       : undefined;
 ...
   function dropLoot(position: THREE.Vector3, opts: DropOpts): LootItemState[] {
     const guaranteed = opts.guaranteed ?? [];
     const count = Math.max(opts.count ?? 1, guaranteed.length);
-    const boost = opts.rarityBoost ?? 0;
+    const baseBoost = opts.rarityBoost ?? 0;
+    // sponsor + crowd (hype, boos) + league bonus, clamped 0..1
+    const boost = ctx.standing ? ctx.standing.dropBoost(baseBoost) : baseBoost;
 ...
-        if (kind === 'weapon' && boost >= 0.5 && i < guaranteed.length && !bossWeaponFloorUsed) {
+        if (kind === 'weapon' && baseBoost >= 0.5 && i < guaranteed.length && !bossWeaponFloorUsed) {
```

`generateWeapon(tier, rarity)` on the `LootSystem` contract, used for vendors and debugging, can stay unforced.
`starterWeapon()` stays plain.

### 5b. Enemy count, loot count, bonus wave and boss-every-sub-wave: `src/rounds/index.ts`

```diff
 import { randInt, randRange } from '@/core/rng';
 import type { BossKind, GameContext, LootKind, RoundManager, RoundPhase, RoundState } from '@/core/types';
+import { onStanding, scaleEnemyCount, scaleLootCount } from '@/standing';
+
+const BOSS_CYCLE: BossKind[] = ['brute', 'summoner', 'artillery'];
 ...
   let bossDead = false;
+  let midBossSpawned = false; // sponsor bossEveryRound: a boss closes every sub-wave
   const bossPos = new THREE.Vector3();
+  const run = () => ctx.standing?.sponsors.active;
+  const mobsThisRound = (round: number) => {
+    const m = run();
+    return m ? scaleEnemyCount(mobsForRound(round), m) : mobsForRound(round);
+  };
 ...
   function beginIntermission(): void {
     state.kills = 0;
-    state.killsRequired = mobsForRound(state.round);
+    state.killsRequired = mobsThisRound(state.round);
 ...
   function beginWave(): void {
-    state.killsRequired = mobsForRound(state.round);
+    state.killsRequired = mobsThisRound(state.round);
 ...
   function beginSubWave(): void {
     state.subWave++;
     spawnedInSub = 0;
+    midBossSpawned = false;
 ...
     // Quota spawned: sub-wave ends when everything is dead.
     if (aliveMobs() > 0) return;
+    if (run()?.bossEveryRound && state.subWave < SUB_WAVES) {
+      if (!midBossSpawned) {
+        midBossSpawned = true;
+        ctx.enemies.spawnBoss(BOSS_CYCLE[(state.round + state.subWave) % BOSS_CYCLE.length], ctx.world.bossSpawn, state.round);
+        ctx.events.emit('ui:message', { text: 'Sponsor segment: a headliner enters!', duration: 3, style: 'warning' });
+        return;
+      }
+      if (ctx.enemies.bossAlive()) return;
+    }
     if (state.subWave < SUB_WAVES) beginSubWave();
     else beginBoss();
 ...
   function beginCleared(): void {
     setPhase('cleared');
+    const drops = randInt(ctx.rng, LOOT.bossDrops.min, LOOT.bossDrops.max);
     ctx.loot.dropLoot(bossPos.clone(), {
       tier: state.round,
       rarityBoost: 0.5,
-      count: randInt(ctx.rng, LOOT.bossDrops.min, LOOT.bossDrops.max),
+      count: run() ? scaleLootCount(drops, run()!) : drops,
       guaranteed: ['weapon'],
     });
 ...
   function rollMobDrops(position: THREE.Vector3): void {
     const kinds: LootKind[] = [];
-    if (ctx.rng() < LOOT.mobWeaponDropChance) kinds.push('weapon');
-    if (ctx.rng() < LOOT.mobAmmoDropChance) kinds.push('ammo');
-    if (ctx.rng() < LOOT.mobHealthDropChance) kinds.push('health');
-    if (ctx.rng() < LOOT.mobGrenadeDropChance) kinds.push('grenade');
+    const m = run();
+    // lootCountMult 2 → roll the table twice; fractional part = chance of one more roll
+    const mult = m ? m.lootCountMult : 1;
+    const rolls = Math.floor(mult) + (ctx.rng() < mult % 1 ? 1 : 0);
+    for (let r = 0; r < rolls; r++) {
+      if (ctx.rng() < LOOT.mobWeaponDropChance) kinds.push('weapon');
+      if (ctx.rng() < LOOT.mobAmmoDropChance) kinds.push('ammo');
+      if (ctx.rng() < LOOT.mobHealthDropChance) kinds.push('health');
+      if (!m?.grenadeless && ctx.rng() < LOOT.mobGrenadeDropChance) kinds.push('grenade');
+    }
     if (!kinds.length) return;
 ...
   ctx.events.on('enemy:killed', (e) => {
     ...
     if (e.isBoss) {
+      // sponsor mid-boss (wave phase): small shower, does not end the round
+      if (state.phase === 'wave') {
+        ctx.loot.dropLoot(e.position.clone(), { tier: state.round, rarityBoost: 0.3, count: 2, guaranteed: ['weapon'] });
+        return;
+      }
       if (state.phase === 'boss' && (!bossId || e.enemy.id === bossId) && !bossDead) {
 ...
+  // Crowd gift "bonus wave": extend the current sub-wave.
+  onStanding(ctx.events, 'hype:gift', (g) => {
+    if (!ctx.isHost || g.kind !== 'bonuswave' || state.phase !== 'wave' || !g.mobs) return;
+    quotas[state.subWave - 1] = (quotas[state.subWave - 1] ?? 0) + g.mobs;
+    state.killsRequired += g.mobs;
+    ctx.events.emit('round:progress', { kills: state.kills, killsRequired: state.killsRequired });
+  });
```

`maxAliveForRound` stays as it is, so double enemies means a longer wave, not a busier screen. That keeps the arena readable.

### 5c. Enemy health: `src/enemies/manager.ts`

```diff
   private add(e: BaseEnemy): void {
+    const hm = this.ctx.standing?.sponsors.active.enemyHealthMult ?? 1;
+    if (hm !== 1) {
+      e.state.maxHealth *= hm;
+      e.state.health = e.state.maxHealth;
+    }
     this.enemies.push(e);
```

`spawnBoss` calls `b.emitHealth()` after `add`, so the boss bar shows the scaled health.

### 5d. Player shield, grenades and damage: `src/player/`

`src/player/shared.ts`:

```diff
+/** Run-level damage multiplier: sponsor contract × crowd-gift buff (1 when system I is absent). */
+export function runDamageMult(ctx: GameContext): number {
+  const s = (ctx as Partial<GameContext>).standing;
+  return s ? s.damageMult() : 1;
+}
```

`src/player/weapons.ts`:

```diff
-import { damp, getStats } from './shared';
+import { damp, getStats, runDamageMult } from './shared';
 ...
-    const baseDmg = def.damage * stats.damageMult;
+    const baseDmg = def.damage * stats.damageMult * runDamageMult(ctx);
```

`src/player/melee.ts`:

```diff
-import { getStats } from './shared';
+import { getStats, runDamageMult } from './shared';
 ...
-  const amount = PLAYER.meleeDamage * getStats(ctx).damageMult;
+  const amount = PLAYER.meleeDamage * getStats(ctx).damageMult * runDamageMult(ctx);
```

`src/player/grenades.ts`:

```diff
-import { getStats } from './shared';
+import { getStats, runDamageMult } from './shared';
 ...
-    ctx.enemies?.damageRadius(pos, R, PLAYER.grenadeDamage * stats.damageMult, {
+    ctx.enemies?.damageRadius(pos, R, PLAYER.grenadeDamage * stats.damageMult * runDamageMult(ctx), {
```

`src/player/index.ts`, for noShield and grenadeless:

```diff
+  const run = () => (ctx as Partial<GameContext>).standing?.sponsors.active;
+
   function applyMaxStats(stats: PlayerStats, fill: boolean): void {
     const mh = PLAYER.maxHealth * stats.healthMult;
-    const ms = PLAYER.maxShield * stats.shieldMult;
+    const ms = run()?.noShield ? 0 : PLAYER.maxShield * stats.shieldMult;
 ...
     addGrenades(n: number) {
+      if (run()?.grenadeless) return;
       const before = p.grenades;
 ...
     reset() {
       alive = true;
       applyMaxStats(getStats(ctx), true);
 ...
-      p.grenades = START_GRENADES;
+      p.grenades = run()?.grenadeless ? 0 : START_GRENADES;
```

`rounds.start()` calls `player.reset()` before it emits `game:started`. The contract is already
applied at that point, because `choose()` applies it straight away, so `reset()` reads the right rules.

### 5e. XP multiplier: `src/progression/index.ts`

```diff
+  const xpMult = () => (ctx as Partial<GameContext>).standing?.xpMult() ?? 1;
   ctx.events.on('enemy:killed', (e) => {
     if (!ctx.isHost) return;
-    addXp(e.isBoss ? XP.boss : XP.mob);
+    addXp(Math.round((e.isBoss ? XP.boss : XP.mob) * xpMult()));
   });
   ctx.events.on('round:cleared', () => {
     if (!ctx.isHost) return;
-    addXp(XP.roundClear);
+    addXp(Math.round(XP.roundClear * xpMult()));
   });
```

### 5f. Audio (optional, `src/audio/index.ts`)

```ts
import { onStanding } from '@/standing';
onStanding(ctx.events, 'hype:gift', () => play('round_clear', { volume: 0.7 }));
onStanding(ctx.events, 'standing:rank', () => play('levelup'));
onStanding(ctx.events, 'hype:changed', (e) => { if (e.tierChanged && e.tier === 'roaring') play('boss_roar', { volume: 0.4, pitch: 1.4 }); });
onStanding(ctx.events, 'hype:boo', () => play('player_hurt', { volume: 0.3, pitch: 0.6 })); // placeholder until a crowd-boo synth exists
```

A crowd bed whose loudness follows `hype.modifiers.value` is the natural M3 follow-up.

### 5g. World and hub (M3 / M7, data only)

`dressingForRank(ctx.standing.standing.rank)` returns `{ crowdSizeMult, floodlights, lasers,
holoBillboards, hazard, hubFloor, notes }`. The league sets the base and the crowd grows 10 % per tier.
Each `RankDef.unlock` says which hub prop or arena change that rank adds. Use
`ctx.standing.standing.accentColor` for floodlight and billboard tint, and listen to `standing:rank` to
re-dress the scene live.

---

## 6. HUD widgets (`src/ui/`)

The widgets are already built in `src/standing/hud.ts`. They use the UI's CSS variables and inject their own
`sbs-` styles, so integrating them takes only a few lines.

### 6a. Hype meter: `src/ui/hud.ts`

Spec: top-left, 230 px wide. It shows:
- a "CROWD" label and the tier label in Bangers: COLD in grey, WARM in yellow, HOT in orange, ROARING in the league accent;
- a 14 px ink-bordered bar with ticks at 25/50/75 that pulses while ROARING;
- chips for "FRENZY ×1.3 · 8s" and "BOOING";
- a three-line ticker of crowd reactions ("+11 TRIPLE KILL", "−4 SHIELD DOWN", "CROWD GIFT: CRATE") that fade after 1.8 s.

```diff
+import { createHypeMeter } from '@/standing';
 ...
   const muteEl = h('div', 'sb-mute sb-hidden', hud);
 ...
+  // ---- crowd favour (system I) -----------------------------------------------
+  const hypeMeter = ctx.standing ? createHypeMeter(ctx, ctx.standing, hud) : null;
 ...
   function update(dt: number): void {
 ...
+    hypeMeter?.update(dt);
     numbers.update(dt);
   }
```

If the mute pill overlaps it, move the meter with `.sbs-hype { top: … }` in `styles.ts`; it sits at 52 px by default.
The tier-change lines ("The crowd is roaring!") arrive through the existing `ui:message` queue.

### 6b. Standing badge and sponsor picker: `src/ui/screens.ts`

Spec:
- **Badge:** a league-accent plate, the league name with tier N/5, and the rank name in Bangers. Below them, a progress bar to the next rank and "Standing 1,203 / 1,450 → Scrapper". On game over it adds "+N this run".
- **Picker:** a wrap row of 200 px cards. Each card shows the sponsor name, the contract title, the blurb, green upsides and red downsides. Locked cards are greyed out and read "Reach the Iron League". The selected card gets an accent outline.
- **Clicks:** the panel stops click propagation, so picking a card does not start the game.

```diff
+import { createStandingPanel, type StandingPanelWidget } from '@/standing';
 ...
   const startBest = h('div', 'sb-best', start);
+  const startStanding: StandingPanelWidget | null = ctx.standing
+    ? createStandingPanel(ctx, ctx.standing, start, { picker: true, onChoose: () => ctx.audio.play('ui_click') })
+    : null;
   h('div', 'sb-cta', start, 'Click to play');
 ...
   const goBest = statBox('Best round');
+  const goStanding: StandingPanelWidget | null = ctx.standing
+    ? createStandingPanel(ctx, ctx.standing, over, { picker: true, showRunGain: true, onChoose: () => ctx.audio.play('ui_click') })
+    : null;
   h('div', 'sb-cta', over, 'Click to retry');
 ...
   function show(screen: Screen): void {
     for (const [k, el] of Object.entries(all)) el!.classList.toggle('sb-hidden', k !== screen);
     if (screen === 'start' || screen === 'gameover') refreshBest();
+    if (screen === 'start') startStanding?.refresh();
+    if (screen === 'gameover') goStanding?.refresh();
```

The picker also goes on game over because Retry skips the start screen, and that is the
only point between runs where the player can pick a contract. The start screen gets tall
with nine cards. If it overflows, either make `.sb-controls` collapsible or show only
the unlocked cards (`sys.sponsors.list().filter(e => e.unlocked)`).

---

## 7. Standing rules

| Source | Standing (× sponsor `standingMult`) |
|--------|-------------------------------|
| `round:cleared` | 40 + 15·round |
| boss `enemy:killed` (any killer: team credit) | 60 + 20·tier |
| Hype Hot, first time each round | 15 |
| Hype ROARING, first time each round | 30 |
| Crowd gift | 10 |
| Flawless sub-wave | 10 |
| Multi-kill chain (≥ 3 kills in 2 s) | 5 |
| `game:over` (once per run) | 5·round reached |

A typical round-5 death at Free Agent earns about 750–900, so the first rank (Deckhand, 250) comes in the first
run and Iron (3,283) after about four decent runs. Eternal (40,390) is a long-term goal.

## 8. Hype rules (all in `HYPE` in `hype.ts`)

Gains:
- +1 per kill.
- +0.5 per crit hit, at most once every 0.2 s.
- +4 extra for a crit kill.
- Multi-kill (≥ 3 kills in a sliding 2 s window): +8 on the kill that triggers it, then +3 for each further kill in the chain.
- Kill finishers: +8 melee, +5 airborne (feet more than 0.45 m above ground), +6 comeback (health under 25 %).
- +15 for a flawless sub-wave (no `player:damaged` during it).
- +10 per boss phase change, +12 for a boss kill.

Losses:
- Decay of −2/s during wave and boss.
- Idle penalty of a further −3/s after 5 s without dealing damage.
- Half decay and no idle penalty during intermission and loot-up.
- Damage taken costs 12 % of the amount, clamped to 1–6 per hit.
- −4 when the shield breaks.

The meter starts each run at 10.

---

## 9. Smoke test

```
npx tsx src/standing/smoke.test.ts
```

tsx is not installed in this repo, and the build tooling uses the esbuild that ships with Vite, which
honours the tsconfig `@/` paths. The equivalent command:

```
npx esbuild src/standing/smoke.test.ts --bundle --platform=node --format=esm --outfile=%TEMP%/standing-smoke.mjs && node %TEMP%/standing-smoke.mjs
```

It covers rank thresholds and boundaries, decay, idle and damage maths, hysteresis, every style gain over a simulated
event stream, the tier sequence and messages, gift cadence, crate drop options, the buff window, bonus-wave gating,
boos, standing awards, rank and league ups, persistence, sponsor locks and unlocks, and modifier composition.
Current result: 199 passed.

## 10. Contract gaps and notes

1. **No kill cause.** `enemy:killed` has no `cause`, so a melee kill is inferred: the kill and `player:melee {hit:true}` land in the same frame. A bullet kill in the very same frame as a melee hit could be miscounted. The fix is to add `cause?: 'bullet' | 'melee' | 'grenade' | 'status'` to `enemy:killed` and `damage:dealt`. Hype would then use it; this is a two-line change in `hype.ts`.
2. **No `onGround` on `PlayerState`.** Airborne is estimated as feet more than 0.45 m above `world.groundHeight`. An `onGround` flag on the contract would be exact.
3. **No run-modifier slot in `GameContext`.** §2 adds `standing: StandingSystem`. M6 round mutators should merge into the same object with `composeModifiers(sponsor.active, mutator)`, rather than adding a second set of hooks.
4. **"Boss every round" already happens in the base loop.** The contract flag is therefore read as "a boss closes every sub-wave" (§5b).
5. **Gear quality worn** (PLAN §12 standing source) is not implemented, because there is no gear yet (M4). Add it later as `ctx.standing.standing.award(n, 'gear', …)` on `round:cleared`.
6. **Co-op.** Standing and hype are per local player. Boss and round standing is team credit. Hype only counts the local player's damage and kills. A remote player's sponsor contract should come from the host's lobby, which is out of scope here.
7. **Browser check pending.** `hud.ts` widgets have only been type-checked, because the browser belongs to another agent. Check the layout after integration.
