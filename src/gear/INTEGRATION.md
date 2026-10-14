# System G — Gear (M4): integration guide

> **Status (2026-10-14): applied by the integration pass.** The diffs below are kept as design
> notes; the code has moved on (see `docs/INTEGRATION_NOTES.md` for what landed where, the
> contract changes and what is still open).

Everything in `src/gear/` type-checks on its own and runs headlessly. The diffs below are the
only changes needed outside `src/gear/`. Each one is small and independent, in boot order.
Line numbers are as of 2026-10-14; match on the quoted text.

```
src/gear/
  types.ts            GearSlot, GearAffix, GearDef, Loadout, GearSetDef, GearStats
  palette.ts          every colour / glow level (ART_DIRECTION tokens, glowLum)
  generator.ts        generateGear, sets, computeLoadoutStats, mergeStats, growthForLevel, weaponGrowth
  models.ts           buildGearModel, buildGloveViewmodel, per-slot growth params, shared geometry
  weaponGrowth.ts     applyWeaponGrowth for the viewmodel gun (§6)
  paperDoll.ts        createPaperDoll(canvas, materials): standalone preview scene
  inventory.ts        Inventory (backpack 12, equip/unequip, compare, save/load), Emitter
  inventoryScreen.ts  createInventoryScreen(...): the ready-made key-I screen (§7)
  index.ts            createGearSystem(ctx) facade + re-exports
  __tests__/gear.smoke.ts   headless smoke test (~7.9k checks)
```

Run the smoke test: `npx tsx src/gear/__tests__/gear.smoke.ts` (when tsx is installed), or
with Vite's esbuild:
```
node -e "require('esbuild').buildSync({entryPoints:['src/gear/__tests__/gear.smoke.ts'],bundle:true,platform:'node',format:'esm',outfile:'node_modules/.cache/gear.smoke.mjs'})" && node node_modules/.cache/gear.smoke.mjs
```

---

## 1. Contracts: `src/core/types.ts`

```diff
 import type * as THREE from 'three';
 import type { EventBus } from './events';
 import type { Input } from './input';
+import type { GearDef, Loadout } from '@/gear/types';
+import type { GearSystem } from '@/gear/index';
```
```diff
-export type LootKind = 'weapon' | 'ammo' | 'health' | 'grenade';
+export type LootKind = 'weapon' | 'ammo' | 'health' | 'grenade' | 'gear';
```
```diff
 export interface LootItemState {
   ...
   weapon?: WeaponDef;
+  gear?: GearDef;
   age: number;
 }
```
```diff
 export interface PlayerState {
   ...
   readonly activeWeapon: WeaponDef | null;
+  /** Equipped gear (local: the inventory's loadout; remote: from snapshots, for avatars). */
+  readonly loadout: Readonly<Loadout>;
   grenades: number;
```
```diff
-export type Screen = 'none' | 'start' | 'pause' | 'skills' | 'gameover';
+export type Screen = 'none' | 'start' | 'pause' | 'skills' | 'inventory' | 'gameover';
```
```diff
   progression: Progression; // boot
+  gear: GearSystem; // boot (right after progression)
   hud: Hud; // boot
```
and in the boot-order comment: `... → loot → progression → gear → hud → rounds`.

## 2. Events: `src/core/events.ts`

```diff
+import type { GearStats, Loadout } from '@/gear/types';
 ...
   'skill:changed': { skillId: string; rank: number; stats: PlayerStats };
+
+  // gear
+  'gear:changed': { playerId: string; stats: GearStats; loadout: Readonly<Loadout> };
```
`createGearSystem` already emits this (through a loose cast until the type exists). After
this diff, the cast in `src/gear/index.ts` can stay or become a plain `ctx.events.emit`.

The inventory's own events (`inv.events.on('gear:equipped' | 'gear:unequipped' | 'gear:added'
| 'gear:removed' | 'gear:full' | 'gear:changed')`) stay local. Only `gear:changed` is bridged.

## 3. Boot: `src/main.ts`

```diff
+import { createGearSystem } from './gear';
 ...
 ctx.progression = createProgression(ctx);
+ctx.gear = createGearSystem(ctx); // loads the saved inventory (localStorage 'snowbound.gear.v1')
 ctx.hud = createHud(ctx);
```
Gear persists across runs like the skill tree. For a roguelite reset, add
`ctx.events.on('game:started', () => ctx.gear.inventory.clear())`.

## 4. Loot

### 4a. `src/loot/index.ts`: generate gear, pick it up on walk-over

```diff
+import { generateGear } from '@/gear/generator';
 ...
-const KIND_WEIGHTS: [LootKind, number][] = [['weapon', 0.3], ['ammo', 0.36], ['health', 0.2], ['grenade', 0.14]];
+const KIND_WEIGHTS: [LootKind, number][] = [['weapon', 0.3], ['ammo', 0.36], ['health', 0.2], ['grenade', 0.14], ['gear', 0.1]];
```
```diff
   function makeItem(kind: LootKind, pos: THREE.Vector3, ownerId: string, tier: number, rarity?: Rarity, boost = 0, minRarity?: Rarity): LootItemState {
     const weapon = kind === 'weapon'
       ? genWeapon(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity })
       : undefined;
+    const gear = kind === 'gear'
+      ? generateGear(ctx.rng, ctx.nextId, tier, { rarity, rarityBoost: boost, minRarity })
+      : undefined;
     return {
       id: ctx.nextId('loot'),
       kind,
-      rarity: weapon ? weapon.rarity : 'common',
+      rarity: weapon ? weapon.rarity : gear ? gear.rarity : 'common',
       position: { x: pos.x, y: pos.y, z: pos.z },
       ownerId,
       weapon,
+      gear,
       age: 0,
     };
   }
```
Boss floor for the guaranteed gear piece (in `dropLoot`, next to the weapon floor):
```diff
         if (kind === 'weapon' && boost >= 0.5 && i < guaranteed.length && !bossWeaponFloorUsed) {
           minRarity = 'rare';
           bossWeaponFloorUsed = true;
         }
+        if (kind === 'gear' && boost >= 0.5 && i < guaranteed.length) minRarity = 'uncommon';
```
Pickup (in `update`, the `switch (it.kind)`):
```diff
         case 'grenade':
-          if (p.grenades < PLAYER.maxGrenades) {
+          if (p.grenades < (ctx.gear ? ctx.gear.maxGrenades(PLAYER.maxGrenades) : PLAYER.maxGrenades)) {
             p.addGrenades(1);
             pickup(it);
           }
           break;
+        case 'gear':
+          // walk-over: empty slot -> equipped, else backpack; a full backpack leaves it on the ground
+          if (it.gear && ctx.gear?.canPickUp(it.gear)) pickup(it);
+          break;
```
`createGearSystem` listens to `loot:pickup` and moves `item.gear` into the inventory, with a
`ui:message` ("Equipped …" / "… → backpack [I]" / "Backpack full").

### 4b. `src/rounds/index.ts`: bosses guarantee one gear piece

```diff
     ctx.loot.dropLoot(bossPos.clone(), {
       tier: state.round,
       rarityBoost: 0.5,
       count: randInt(ctx.rng, LOOT.bossDrops.min, LOOT.bossDrops.max),
-      guaranteed: ['weapon'],
+      guaranteed: ['weapon', 'gear'],
     });
```
Optional mob gear drops: add `mobGearDropChance: 0.03` to `LOOT` in `src/core/config.ts`, and in
`rollMobDrops` add `if (ctx.rng() < LOOT.mobGearDropChance) kinds.push('gear');`.

### 4c. `src/loot/view.ts`: gear icon (the real parametric model) + rarity beam

```diff
+import { buildGearModel, type GearModel } from '@/gear/models';
+import type { GearSlot } from '@/gear/types';
+
+/** Loot icon scale per gear slot (models are real size: a helm is ~0.3 m). */
+const GEAR_ICON_SCALE: Record<GearSlot, number> = { helm: 1.8, chest: 1.0, boots: 1.4, gloves: 1.5, trinket: 2.0 };
```
Add `gear?: GearModel` to the `views` map value type, then in `buildIcon`:
```diff
       case 'grenade': {
         ...
       }
+      case 'gear': {
+        const m = buildGearModel(item.gear!, ctx.materials);
+        m.scale.setScalar(GEAR_ICON_SCALE[item.gear!.slot]);
+        g.add(m);
+        g.userData.gearModel = m;
+        break;
+      }
```
In `add()` treat gear like weapons for the beam/ring (rarity colour, height, "big"):
```diff
-    const color = item.kind === 'weapon' ? RARITY_COLORS[item.rarity] : kindColor(item.kind);
+    const rarityLoot = item.kind === 'weapon' || item.kind === 'gear';
+    const color = rarityLoot ? RARITY_COLORS[item.rarity] : kindColor(item.kind);
     const rIdx = RARITY_ORDER.indexOf(item.rarity);
-    const big = item.kind === 'weapon' && rIdx >= 2;
+    const big = rarityLoot && rIdx >= 2;
 ...
-    const beamH = item.kind === 'weapon' ? 4 + rIdx * 1.5 : 1.6;
-    const beamR = item.kind === 'weapon' ? (big ? 0.11 + 0.03 * (rIdx - 2) : 0.06) : 0.04;
+    const beamH = rarityLoot ? 4 + rIdx * 1.5 : 1.6;
+    const beamR = rarityLoot ? (big ? 0.11 + 0.03 * (rIdx - 2) : 0.06) : 0.04;
 ...
-    const ringScale = big ? 1.3 : item.kind === 'weapon' ? 1.0 : 0.7;
+    const ringScale = big ? 1.3 : rarityLoot ? 1.0 : 0.7;
 ...
-    views.set(item.id, { root, icon, beam, beamMat, beamOpacity, ring, phase: ... });
+    views.set(item.id, { root, icon, beam, beamMat, beamOpacity, ring, phase: ..., gear: icon.userData.gearModel as GearModel | undefined });
```
(if the ART_DIRECTION §9 beam table lands first, apply the same `rarityLoot` substitution to it).
In `update()` animate it, in `remove()` free it:
```diff
       v.icon.rotation.y += dt * 1.6;
+      v.gear?.animate(time);
```
```diff
     ctx.scene.remove(v.root);
     v.beamMat.dispose();
+    v.gear?.dispose();
```

## 5. Player: loadout, stats merging, extra stats

### 5a. `src/player/shared.ts`: progression × gear

```diff
 export function getStats(ctx: GameContext): PlayerStats {
   const prog = ctx.progression as GameContext['progression'] | undefined;
-  return (prog && prog.stats) || DEFAULT_STATS;
+  const base = (prog && prog.stats) || DEFAULT_STATS;
+  const gear = ctx.gear as GameContext['gear'] | undefined;
+  return gear ? gear.mergedStats(base) : base; // reused object: read it, don't keep it
 }
```

### 5b. `src/player/index.ts`

`'skill:changed'` carries progression-only stats, so recompute through `getStats` and also
react to gear:
```diff
-  ctx.events.on('skill:changed', (e) => applyMaxStats(e.stats ?? getStats(ctx), false));
+  ctx.events.on('skill:changed', () => applyMaxStats(getStats(ctx), false));
+  ctx.events.on('gear:changed', (e) => {
+    if (e.playerId !== opts.id) return;
+    applyMaxStats(getStats(ctx), false);
+    viewmodel.setGloves(e.loadout.gloves ?? null); // §6b
+  });
```
`loadout` on the PlayerState object (`const p: Player = { ...`):
```diff
     get activeWeapon() {
       return weapons.activeWeapon;
     },
+    get loadout() {
+      return ctx.gear ? ctx.gear.inventory.loadout : {};
+    },
```
Elemental resist (in `takeDamage`):
```diff
       const element = o?.element ?? 'none';
+      if (element !== 'none' && ctx.gear) amount *= 1 - ctx.gear.gearStats.elementalResist;
       let rest = amount;
```
Shield recharge rate:
```diff
-          p.shield = Math.min(p.maxShield, p.shield + PLAYER.shieldRechargeRate * stats.shieldMult * dt);
+          const regen = ctx.gear ? ctx.gear.gearStats.shieldRegenMult : 1;
+          p.shield = Math.min(p.maxShield, p.shield + PLAYER.shieldRechargeRate * stats.shieldMult * regen * dt);
```
Grenade capacity:
```diff
-      p.grenades = clamp(p.grenades + Math.floor(n), 0, PLAYER.maxGrenades);
+      p.grenades = clamp(p.grenades + Math.floor(n), 0, ctx.gear ? ctx.gear.maxGrenades(PLAYER.maxGrenades) : PLAYER.maxGrenades);
```

### 5c. `src/player/melee.ts` and `src/player/weapons.ts`

```diff
-  const amount = PLAYER.meleeDamage * getStats(ctx).damageMult;
+  const amount = PLAYER.meleeDamage * getStats(ctx).damageMult * (ctx.gear ? ctx.gear.gearStats.meleeMult : 1);
```
```diff
-    const rollStatus = () => def.element !== 'none' && def.elementChance > 0 && ctx.rng() < def.elementChance;
+    const bonus = ctx.gear ? ctx.gear.gearStats.elementChanceBonus : 0;
+    const rollStatus = () => def.element !== 'none' && def.elementChance > 0 && ctx.rng() < def.elementChance + bonus;
```

### 5d. Set-bonus gameplay hooks (`ctx.gear.gearStats.hooks`)

The stat parts of every set bonus are already applied by `computeLoadoutStats`. These three
need gameplay code (proposals, not yet implemented):

| hook id | set (pieces) | effect | where |
|---|---|---|---|
| `voidrunner_dash` | Voidrunner 3/3 (helm, boots, gloves) | Sprint + jump while grounded → a 0.15 s blink dash: set horizontal velocity to 18 m/s along the move direction, keep y, 4 s cooldown, `fx.shake(0.1)`. | `Controller.move()` in `src/player/controller.ts`: on jump, `if (sprinting && hooks.includes('voidrunner_dash') && dashCd <= 0)`. |
| `bulwark_last_stand` | Bulwark 3/3 (helm, chest, boots) | When the shield breaks: 50 % damage reduction for 2 s, 10 s cooldown. | `takeDamage` in `src/player/index.ts`: where `player:shield … broken: true` is emitted, start `lastStandT = 2`; at the top of `takeDamage`, `if (lastStandT > 0) amount *= 0.5`. |
| `pitfighter_bloodlust` | Pitfighter 3/3 (chest, gloves, trinket) | Melee kills refill the shield and refund one grenade. | `doMelee()` in `src/player/index.ts`: `performMelee` returns the hit enemy; `if (hit && !hit.alive && hooks.includes('pitfighter_bloodlust')) { p.shield = p.maxShield; p.addGrenades(1); }`. |

## 6. Viewmodel: `src/player/viewmodel.ts`

### 6a. Weapon growth with weapon level (barrel, mag, optic, fins, brake)

Formulas (`weaponGrowthParams`, `src/gear/weaponGrowth.ts`), with
`g = growthForLevel(weapon.level + LEVEL_BONUS[rarity])`, `growthForLevel(L) = 1 - e^(-(L-1)/9)`:

| knob | formula | tier 1 common (g 0) | tier 10 rare (ilvl 12, g 0.71) | tier 20 legendary (ilvl 25, g 0.93) |
|---|---|---|---|---|
| barrel length | `1 + 0.6·g·k` (k: pistol/smg 1, shotgun 0.8, rifle 0.9, sniper 0.6) | ×1 | ×1.42 (smg) | ×1.56 (smg), ×1.45 (shotgun) |
| barrel radius | `1 + 0.3·g` | ×1 | ×1.21 | ×1.28 |
| magazine length | `1 + 0.8·g` | ×1 | ×1.56 | ×1.74 |
| optic size | `1 + 0.5·g` | ×1 | ×1.35 | ×1.47 |
| heat-sink fins | `g < 0.25 ? 0 : min(5, 1 + ⌊(g-0.25)·6⌋)`, height `0.012 + 0.03·g` | 0 | 3 | 5 |
| muzzle brake stages | `g < 0.5 ? 0 : min(3, 1 + ⌊(g-0.5)·5⌋)` + 1 for legendary | 0 | 2 | 4 |
| mag extension plate | `g ≥ 0.7` | no | yes | yes |

Tag the parts in `BUILDERS` (every `p.box`/`p.cyl` call returns its Mesh):
```diff
 pistol:
-    p.cyl(0.017, 0.06, m.dark, 0, 0.05, -0.27);
+    p.cyl(0.017, 0.06, m.dark, 0, 0.05, -0.27).userData.vmRole = 'barrel';
 smg:
-    p.cyl(0.026, 0.14, m.dark, 0, 0.05, -0.36, 8); // shroud
-    p.cyl(0.014, 0.06, m.dark, 0, 0.05, -0.46);
-    p.box(0.045, 0.26, 0.06, m.dark, 0, -0.13, -0.17, 0.12); // long mag
-    p.box(0.05, 0.022, 0.066, m.accent, 0, -0.22, -0.18, 0.12); // mag band
+    p.cyl(0.026, 0.14, m.dark, 0, 0.05, -0.36, 8).userData.vmRole = 'barrel'; // shroud
+    p.cyl(0.014, 0.06, m.dark, 0, 0.05, -0.46).userData.vmRole = 'barrel'; // chained after the shroud
+    p.box(0.045, 0.26, 0.06, m.dark, 0, -0.13, -0.17, 0.12).userData.vmRole = 'mag'; // long mag
+    p.box(0.05, 0.022, 0.066, m.accent, 0, -0.22, -0.18, 0.12).userData.vmRole = 'magEnd'; // mag band
 shotgun:
-    p.cyl(0.025, 0.52, m.dark, -0.026, 0.065, -0.42, 10);
-    p.cyl(0.025, 0.52, m.dark, 0.026, 0.065, -0.42, 10);
+    p.cyl(0.025, 0.52, m.dark, -0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
+    p.cyl(0.025, 0.52, m.dark, 0.026, 0.065, -0.42, 10).userData.vmRole = 'barrel';
 ...
-    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.098, -0.62); // muzzle band
-    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.032, -0.62);
+    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.098, -0.62).userData.vmRole = 'muzzle'; // muzzle band
+    p.box(0.11, 0.016, 0.03, m.accent, 0, 0.032, -0.62).userData.vmRole = 'muzzle';
 rifle:
-    p.cyl(0.018, 0.24, m.dark, 0, 0.06, -0.5);
-    p.box(0.05, 0.17, 0.08, m.dark, 0, -0.09, -0.13, 0.25); // mag
+    p.cyl(0.018, 0.24, m.dark, 0, 0.06, -0.5).userData.vmRole = 'barrel';
+    p.box(0.05, 0.17, 0.08, m.dark, 0, -0.09, -0.13, 0.25).userData.vmRole = 'mag'; // mag
 ...
-    p.box(0.045, 0.05, 0.06, m.dark, 0, 0.135, -0.08); // red-dot housing
-    p.box(0.032, 0.032, 0.006, m.accent, 0, 0.138, -0.112); // lens
+    p.box(0.045, 0.05, 0.06, m.dark, 0, 0.135, -0.08).userData.vmRole = 'scope'; // red-dot housing
+    p.box(0.032, 0.032, 0.006, m.accent, 0, 0.138, -0.112).userData.vmRole = 'scope'; // lens
 sniper:
-    p.cyl(0.017, 0.52, m.dark, 0, 0.055, -0.58); // long barrel
-    p.box(0.045, 0.036, 0.07, m.dark, 0, 0.055, -0.86); // muzzle brake
-    p.box(0.05, 0.012, 0.074, m.accent, 0, 0.075, -0.86);
+    p.cyl(0.017, 0.52, m.dark, 0, 0.055, -0.58).userData.vmRole = 'barrel'; // long barrel
+    p.box(0.045, 0.036, 0.07, m.dark, 0, 0.055, -0.86).userData.vmRole = 'muzzle'; // muzzle brake
+    p.box(0.05, 0.012, 0.074, m.accent, 0, 0.075, -0.86).userData.vmRole = 'muzzle';
     (scope tube, objective bell, front lens, eyepiece and both scope rings: append `.userData.vmRole = 'scope'`)
-    p.box(0.05, 0.08, 0.08, m.dark, 0, -0.04, -0.07); // mag
+    p.box(0.05, 0.08, 0.08, m.dark, 0, -0.04, -0.07).userData.vmRole = 'mag'; // mag
```
Apply it in `applyTarget()`:
```diff
+import { RARITY_COLORS } from '@/core/types';
+import { applyWeaponGrowth } from '@/gear/weaponGrowth';
+import { glowLum } from '@/gear/palette';
 ...
     const muzzle = builder(parts, mats);
+    const seam = def.rarity === 'common' ? null : this.glowMat(RARITY_COLORS[def.rarity], glowLum(RARITY_COLORS[def.rarity], def.rarity === 'legendary' ? 2.5 : 1.2));
+    const grownMuzzle = applyWeaponGrowth(group, def, { dark: mats.dark, body: mats.body, seam }, muzzle);
     this.model = group;
     this.pivot.add(group);
-    this.flashGroup.position.copy(muzzle);
+    this.flashGroup.position.copy(grownMuzzle);
```
Growth parts use the shared gear geometries and the viewmodel's cached materials, so
`disposeModel()` stays as is (it only frees `this.geoms`).

### 6b. Equipped gloves on the first-person hand

```diff
+import { buildGloveViewmodel, type GearModel } from '@/gear/models';
+import type { GearDef } from '@/gear/types';
 ...
+  private defaultHand: THREE.Object3D[] = [];
+  private gloveModel: GearModel | null = null;
 ...
   private buildArm(): void {
     ...
-    parts.box(0.08, 0.09, 0.1, glove, 0.0, -0.075, 0.035, -0.25);
+    const fist = parts.box(0.08, 0.09, 0.1, glove, 0.0, -0.075, 0.035, -0.25);
     ...
     const cuff = parts.cyl(0.056, 0.05, glove, 0, 0, 0, 10);
     cuff.quaternion.copy(arm.quaternion);
     cuff.position.set(0.0, -0.1, 0.07).addScaledVector(dir, 0.02);
+    this.defaultHand = [fist, cuff];
     this.pivot.add(group);
   }
+
+  /** Show equipped gloves on the hand (null = bare default glove). */
+  setGloves(def: GearDef | null): void {
+    if (this.gloveModel?.def.id === def?.id) return;
+    this.gloveModel?.dispose();
+    this.gloveModel = def ? buildGloveViewmodel(def, this.ctx.materials) : null;
+    if (this.gloveModel) this.pivot.add(this.gloveModel);
+    for (const o of this.defaultHand) o.visible = !this.gloveModel;
+  }
```
In `update()`: `this.gloveModel?.animate(this.ctx.time.elapsed);`. In `dispose()`:
`this.gloveModel?.dispose();`. At player creation (after `createGearSystem` has booted, e.g.
in `reset()`): `viewmodel.setGloves(ctx.gear?.inventory.equipped('gloves') ?? null);`.

## 7. Inventory screen (key I): `src/ui/`

`createInventoryScreen(parent, ctx.gear, ctx.materials, { onDrop, onClose })` is the whole
screen (paper doll + equipped slots + 4×3 backpack + cargo-manifest compare card, styled per
ART_DIRECTION §10, own CSS with an `sbg-` prefix). Hover shows the compare card, LMB on a
backpack piece equips it, LMB on an equipped slot unequips it, RMB on a backpack piece drops it.

`src/ui/index.ts`:
```diff
+import { createInventoryScreen } from '@/gear/inventoryScreen';
 ...
+  const inventory = createInventoryScreen(root, ctx.gear, ctx.materials, {
+    onClose: () => closeSkills(),
+    onDrop: (item) => {
+      const p = ctx.player;
+      const x = p.position.x - Math.sin(p.yaw) * 0.8;
+      const z = p.position.z - Math.cos(p.yaw) * 0.8;
+      // needs LootSystem.dropItem (see contract gaps) — or skip onDrop to disable dropping
+      ctx.loot.dropItem?.({ kind: 'gear', gear: item, rarity: item.rarity, position: { x, y: ctx.world.groundHeight(x, z), z } });
+    },
+  });
 ...
   function showScreen(s: Screen): void {
     if (s === screen) return;
     screen = s;
     screens.show(s);
+    if (s === 'inventory') inventory.show(); else inventory.hide();
     widgets.setVisible(s !== 'start' && s !== 'gameover');
     if (s !== 'none') {
       ctx.input.unlock();
-      if (s === 'skills' || s === 'pause') ctx.audio.play('ui_open');
+      if (s === 'skills' || s === 'pause' || s === 'inventory') ctx.audio.play('ui_open');
     }
```
Key handling (reuse the skills return logic; `closeSkills()` already returns to the previous screen):
```diff
     const tab = input.rawJustPressed('Tab');
+    const invKey = input.rawJustPressed('KeyI');
     const escKey = input.rawJustPressed('Escape');
-    if (screen === 'skills') {
+    if (screen === 'inventory') {
+      if (invKey || escKey) closeSkills();
+    } else if (screen === 'skills') {
       if (tab || escKey) closeSkills();
+    } else if (invKey) {
+      if (screen === 'none' || screen === 'pause') { skillsReturn = screen; showScreen('inventory'); }
     } else if (tab) {
```
```diff
     widgets.update(dt);
+    inventory.update(dt);
```
`src/ui/screens.ts`: `screens.show('inventory')` must just hide the other screens (it has no
inventory markup), and add `['I', 'Inventory']` to the controls list next to `['Tab', 'Skill tree']`.

## 8. Standing: "gear quality worn" (`src/standing`, PLAN §12)

`ctx.gear.gearStats.score` is the summed gear score of the worn pieces (a mid level-1 affix is
~5 points; a full tier-1 common loadout is ~15, a full tier-20 legendary loadout ~500). Suggested award on `round:cleared`:
`ctx.standing.standing.award(Math.round(ctx.gear.gearStats.score / 10), 'gear', …)`.

## 9. Co-op avatars (M12)

A remote player's `loadout` comes from snapshots as plain `GearDef`s; validate each with
`sanitizeGear()` (it also recomputes growth/colours locally) and attach
`buildGearModel(def, ctx.materials)` to the avatar using the anchor conventions in the
header of `src/gear/models.ts` (paperDoll.ts is a working reference for every anchor).

---

## Contract gaps (for the lead)

1. `LootKind`, `LootItemState.gear`, `PlayerState.loadout`, `Screen 'inventory'`,
   `GameContext.gear` and `GameEvents['gear:changed']` do not exist yet (§1, §2). Until then
   `src/gear/index.ts` reads `LootItemState.gear` through a local intersection type and emits
   `gear:changed` through a loose cast.
2. `LootSystem` has no way to drop a specific existing item (needed for "drop from
   backpack"). Proposal: `dropItem(state: Omit<LootItemState, 'id' | 'ownerId' | 'age'> & { ownerId?: string }): LootItemState`.
   Without it, leave `onDrop` out and the screen hides the drop action.
3. `ToonOptions` has no `surface` yet (ART_DIRECTION §2.2). Gear and the paper doll should use
   `surface: 'character'` once it exists (one-line change in `toonMat` in `models.ts` and in
   `paperDoll.ts`). They pass `hatch: false` for now.
4. The ART_DIRECTION forbids organic horns and colour other than rarity on gear, so the
   brief's "horn length/curl/count" became antenna masts / temple fins / crest slab growth, and
   gear seams use rarity only (`ELEMENT_TINTS_SEAMS = false` in `palette.ts` flips PLAN §11's
   "elemental affixes tint the glow" back on). The league accent is not used on gear models.
5. Set-bonus hooks `voidrunner_dash`, `bulwark_last_stand` and `pitfighter_bloodlust` need the
   player code in §5d. Their stat parts already work.
6. Extra stats (`grenades`, `shieldRegen`, `elementalResist`, `meleeMult`, `elementChance`)
   only take effect with the player diffs in §5b and §5c.
7. Gear ids: saved items get fresh session ids on load (`inventory.load(storage, ctx.nextId)`),
   because `ctx.nextId` counters restart every session.
