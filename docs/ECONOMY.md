# Economy: scrip, shop, upgrades, pit stop

Spec: PLAN.md §13 (requirements added 2026-10-15). Gear is **meta progression**: it no longer drops. You buy it in the shop and improve it with upgrades. Weapons still drop, and the ones you do not want turn into **scrip**, the currency.

All tuning lives in `ECONOMY` in `src/core/config.ts`. The pure formulas are in `src/gear/economyMath.ts`, and the tests are in `tests/economy/economy.test.ts`.

## Code map

| File | What it does |
|---|---|
| `src/gear/economyMath.ts` | Formulas: salvage, bounty, prices, reroll fee, upgrade costs, shop tier, `fmtScrip` |
| `src/gear/wallet.ts` | `Wallet`: integer balance, persisted to `concourse.wallet.v1` (`{ v, scrip, earned }`) |
| `src/gear/shop.ts` | Stock generation, league rarity gating, persisted to `concourse.shop.v1` |
| `src/gear/upgrades.ts` | Pure functions `reinforce`, `retune`, `augment`, `ascend`. Each returns an upgraded copy with the same id. |
| `src/gear/economy.ts` | `createEconomy(ctx, gear)` → `ctx.economy`: wallet events, salvage, bounty, buy, reroll and upgrade |
| `src/gear/shopScreen.ts` | Screen `'shop'` |
| `src/gear/upgradePanel.ts` | The UPGRADE BAY panel, used by the shop and the inventory screen |
| `src/ui/hud.ts` | SCRIP row with a `+NN` tag, the `[F] SALVAGE +NN` prompt, the PIT STOP band |
| `src/rounds/index.ts` | Pit stop (`continue()`), boss shower drops weapons only, class starter weapon |

Events: `wallet:changed { scrip, delta, reason }` and `loot:salvaged { playerId, itemId, weapon, value, manual }`. `loot:expired` now also carries the `item`.

## Formulas

`levelMult(L) = 1 + 0.15·(L − 1)`. `rarityMult`: common 1, uncommon 2, rare 4, epic 8, legendary 16.

| What | Formula | Examples |
|---|---|---|
| Weapon salvage (manual or expiry) | `round(10 × rarityMult × levelMult(L))` | common L1 **10**, rare L1 **40**, epic L5 **128**, legendary L10 **376** |
| Round-clear bounty | `25 + 10·round` | round 1 **35**, round 5 **75** |
| Shop gear price | `round(40 × rarityMult × levelMult(L))` | common L1 **40**, uncommon L2 **92**, rare L3 **208** |
| Shop reroll | `round(15 × levelMult(tier))` | tier 1 **15**, tier 5 **24** |
| Reinforce (item level +1) | `round(15 × rarityMult × 1.18^(L − 1))` | common L1 **15**, rare L5 **116**, epic L12 **741** |
| Retune (reroll one value) | `round(10 × rarityMult × levelMult(L))` | uncommon L2 **23** |
| Augment (add an affix) | `round(60 × rarityMult × levelMult(L))` | rare L3 **312** |
| Ascend (rarity +1) | `round(250 × rarityMult × levelMult(L))` | common L1 **250**, epic L5 **3 200** |

Salvage is paid only for weapons owned by the local player. In co-op every peer has its own wallet.

## Earning scrip

- **Expiry.** A local weapon left on the floor for `LOOT.lifetime` (90 s) salvages itself. The HUD shows `+NN SALVAGE`.
- **Manual.** The weapon pickup prompt reads `[E] TAKE … [F] SALVAGE +NN`, and the manifest card has the same keycap. Pressing **F** removes the gun and pays its value.
- **Bounty.** Each round clear pays `25 + 10·round`, shown on the CLEARED ribbon (`ROUND 03 · BOUNTY +55 · PIT STOP`).

## Shop

- **Where.** In the pit stop: key **B**, the band button, or the pause menu row. Also from the start menu row `SHOP [B]`. It never opens mid-fight.
- **Stock.** 6–8 pieces. The first five cover one per slot (helm, chest, boots, gloves, trinket); the rest are random slots. Pieces come from `generateGear` at `tier = max(1, best round reached, live round)`.
- **Rarity gating.** Rarity uses `rarityWeights(tier, 0.08 · leagueIndex)` with every rarity above the league cap set to 0:
  - Scrap: up to rare
  - Iron and Steel: up to epic
  - Star and Void: up to legendary
- **Persistence.** The stock is kept until you reroll (fee) or clear a round. A round clear restocks for free.
- **Buying.** A purchase equips into an empty slot, otherwise it goes to the backpack. With a full backpack the purchase is refused and nothing is charged.
- **Controls.** LMB selects a piece, which shows the manifest card against what you wear plus `BUY · ¤ NN`. Double-click buys. The right column is YOUR GEAR plus the UPGRADE BAY.

## Upgrades (UPGRADE BAY: inventory screen and shop)

The upgrade functions are pure and return an upgraded copy with the same id. `Inventory.replace()` swaps the copy in place and emits `gear:changed`, so stats, the paper doll and the HUD all refresh. The paper doll keys its models on `id|level|rarity|affixCount`, so an upgraded piece is rebuilt.

- **Reinforce.** Item level +1, capped at `ECONOMY.maxItemLevel` (40). Every non-integer value is multiplied by `affixLevelScale(L+1) / affixLevelScale(L)`. `growth = growthForLevel(L)` is recomputed; this is the knob that drives the parametric model, so horns, crests, spikes and pauldrons grow.
- **Retune.** Rerolls one value inside its range at the piece's level and rarity. Click a stat chip to pick it: `◆` is the implicit, the others are rolled affixes. The range is `[min, max] × affixLevelScale(L) × RARITY_BUDGET[r]`, times 0.6 for implicits. Grenade capacity rolls 1..cap.
- **Augment.** Adds one rolled affix from the slot pools, with no duplicate stat, while the piece is below `AFFIX_COUNT[rarity]` (common 0, uncommon 1, rare 2, epic 3, legendary 4).
- **Ascend.** Rarity +1, with legendary as the cap. The level goes up by the rarity level bonus difference. Values are rescaled by `RARITY_BUDGET[next] / RARITY_BUDGET[cur]` times the level-scale ratio. Colours and glow are recomputed, and a legendary gets the `★` prefix. Ascending raises the affix cap, so Augment becomes available.

Inventory controls changed: LMB **selects** a piece (pins the card and opens the bay in place of GEAR TOTALS). **Double-click** equips or unequips, and RMB still drops. The bay header also has EQUIP / UNEQUIP / DROP buttons.

## Pit stop flow

```
BOSS dies ─▶ CLEARED (pit stop: no timeout)
              ├─ leftover minions killed (no killer → no drops); boss shower = weapons only
              ├─ bounty paid, shop restocked
              ├─ loot does not age (src/loot skips ageing while phase === 'cleared')
              ├─ PIT STOP band: [ENTER] CONTINUE · [B] SHOP · [I] LOADOUT · [TAB] SKILLS
              │   (co-op client: WAITING FOR HOST in place of CONTINUE)
              └─ Enter / CONTINUE (host) ─▶ rounds.continue() ─▶ INTERMISSION round N+1
```

- The player can walk around, pick up and compare loot. The pause menu also gets `CONTINUE · NEXT ROUND` and `SHOP` rows.
- Music stays on `'cleared'` through `round:phase`.
- In co-op only the host can continue (`continue()` returns false when `!ctx.isHost`), and clients follow through the phase snapshot.

## Other changes in this milestone

- **No gear drops.** `LOOT.mobGearDropChance = 0`, the `'gear'` kind was removed from the random drop-kind weights, and bosses guarantee `['weapon']` only. `LootKind 'gear'` and `dropItem` stay, for backpack drops and co-op. No starting gear.
- **Class starter weapon.** `rounds.start()` equips `ctx.loot.starterWeapon(classDef.starterArchetype)`. This only happens when both weapon slots are empty, as before. `starterWeapon(nextId, archetype)` makes a common level-1 base-stat gun: Rusty Iron / Chatterbox / Doorkicker / Trooper / Needle. `generateWeapon` already takes `opts.archetype`.
- **XP curve.** `xpForLevel(L) = round(100 · max(1, L)^1.1)`. Old saves keep their level and XP. If the saved XP is above the new (cheaper) step, the HUD bar clamps at full and the next XP gain levels up normally.
- **Dev helper.** `window.__step(frames, dt)` steps the main loop by hand. Use it in a hidden browser pane, where rAF is throttled to about 1 Hz.

## Open items

- **Co-op salvage on clients.** The client loot mirror does not emit `loot:expired`, so a client earns no expiry salvage. Manual [F] salvage works locally, but the host keeps a ghost copy until it expires.
- **Co-op avatars and first-person gloves.** `src/net/avatar.ts` and `viewmodel.setGloves` diff gear by id only. After an upgrade, a teammate's avatar and the first-person gloves keep the old model until the piece is re-equipped.
- **Balance.** Prices and costs are first-pass numbers. They have not been checked against a real income curve, which is roughly 35 + 10·round in bounty plus about 3–6 salvaged guns per round.
