# Orbital Concourse — help

<!-- Generated from src/ui/helpContent.ts by `npx tsx scripts/help-md.ts`. Edit the source, not this file. -->

The same text is in the game: press <kbd>H</kbd> anywhere, or pick HELP on the start or pause menu.

1. [The Loop](#01-loop)
2. [Shield & Health](#02-vitals)
3. [Weapons](#03-weapons)
4. [Loot & Salvage](#04-loot)
5. [Scrip, Shop & Upgrades](#05-economy)
6. [Gear & Sets](#06-gear)
7. [Classes & Skills](#07-skills)
8. [Crowd Favour](#08-hype)
9. [Standing & Leagues](#09-standing)
10. [Sponsors](#10-sponsors)
11. [Hazards](#11-hazards)
12. [Co-op](#12-coop)
13. [Controls](#13-controls)

<a id="01-loop"></a>

## 01 · The Loop

*Waves, a headliner boss, then a pit stop that waits for you.*

Every round runs the same way: a 6 s intermission, three sub-waves, then the **headliner** (a boss), then a **pit stop**. The run ends when you die; there is no last round.

| Round N | What happens |
|---|---|
| Waves | 20 + 8·N mobs over 3 sub-waves, at most 8 + 2·N alive at once (cap 18). Grunts rush, Spitters shoot from range, Bombers run in and explode. |
| Headliner | Brute → Summoner → Artillery, repeating. Bosses have phases; a shielded Summoner ignores hits until its shield phase ends. |
| Scaling | Mobs +25 % health and +15 % damage per round. Bosses +50 % health and +20 % damage per round. |
| Clear | The boss drops 3–5 weapons. You get XP, standing (40 + 15·N) and a scrip bounty (25 + 10·N). Leftover mobs die. |

### Pit stop

After the boss the game waits; there is no timer. Loot on the floor stops ageing, so you can walk around, compare and take guns at your own pace. The PIT STOP band shows the keys:

| Key | Action |
|---|---|
| <kbd>ENTER</kbd> | Continue to the next round |
| <kbd>B</kbd> | Shop (gear, rerolls, upgrades) |
| <kbd>I</kbd> | Loadout (equip gear, upgrade bay) |
| <kbd>TAB</kbd> | Skill tree (spend points) |

The pause menu has the same CONTINUE and SHOP rows. In co-op only the host can continue; clients see WAITING FOR HOST.

### What you keep

On death you return to round 1. Level, skill points, class, standing, scrip, your gear and the two guns you carry are all kept.

<a id="02-vitals"></a>

## 02 · Shield & Health

*The shield recharges; health does not.*

You start with **80 shield** and **100 health** (class, skills and gear raise both). Damage always hits the shield first; what is left goes to health.

- **Recharge:** after 4 s without taking damage the shield refills at 30 points per second. Any hit restarts the delay. Shield Recharge affixes speed up the refill.
- **Shock ×2:** shock damage drains a shield twice as fast (the Steel League laser grid is shock). Once the shield is gone, shock hits health normally.
- **Elemental Resist** (gear affix) reduces fire, shock and ice damage you take.
- **Health never regenerates.** It comes back only from health pickups (mob drops, crowd supply crates) and from skills such as Finisher, Scar Tissue, Glory Hound or the Vampiric perk.
- Below 25 % health the vitals panel blinks a red hazard tab.
- Some sponsor contracts (Glass Cannon, Blood Sport) remove the shield entirely in exchange for damage.

**Second Wind** (Pit node P5) saves you once per round: lethal damage leaves you at 1 HP with half a shield and 2 s of invulnerability.

<a id="03-weapons"></a>

## 03 · Weapons

*Archetypes, rarity, accuracy and bloom, aiming, elements and perks.*

You carry two guns (<kbd>1</kbd> <kbd>2</kbd> or the mouse wheel). Every gun is one of five archetypes with random rolls on top, an item level (ILV) and a rarity.

| Archetype | Fire | Mag | Crit | Accuracy | Aim (RMB) |
|---|---|---|---|---|---|
| Pistol | semi 4/s | 12 | ×2.0 | 80 | 1.25× · cone ×0.6 |
| SMG | auto 12/s | 36 | ×1.6 | 60 | 1.15× · cone ×0.7 |
| Shotgun | semi 1.5/s, 8 pellets | 6 | ×1.5 | 45 | 1.1× · cone ×0.8 |
| Rifle | auto 7/s | 30 | ×1.8 | 72 | 1.45× · cone ×0.5 |
| Sniper | semi 1/s | 5 | ×3.0 | 95 | 3× · cone ×0.15 |

### Rarity

- **Common** — base stats, no element, no perk
- **Uncommon** — ×1.12 stat budget, 15 % element chance
- **Rare** — ×1.25, 40 % element, 1 perk
- **Epic** — ×1.4, 70 % element, 1–2 perks
- **Legendary** — ×1.6, always elemental, 2 perks

Loot beams, card bands and the HUD square use these colours. Better rarities get more common each round and with crowd favour, sponsors and league.

### Accuracy & bloom

**Accuracy** (0–100 on the card) sets the base cone: spread = 0.3 rad × (1 − accuracy/100)². Moving changes it: standing still ×0.7, walking ×1.15, sprinting about ×1.36, in the air ×1.8. **Bloom** widens the cone with every shot and drains 0.12 s after you stop, over 0.35 s. The crosshair gap shows the current cone, so tap or burst to stay accurate.

| Archetype | Bloom |
|---|---|
| Pistol | +22 % / shot, max +90 % |
| SMG | +16 % / shot, max +160 % |
| Shotgun | +12 % / shot, max +40 % |
| Rifle | +14 % / shot, max +140 % |
| Sniper | +3 % / shot, max +8 % |

**Aim down sights:** hold <kbd>RMB</kbd>. Zoom and the aimed cone depend on the gun (table above; the card shows the exact values). While aiming you move at 0.7× walk speed, cannot sprint, and recoil drops to 0.7×. Zoom 2× or more shows a scope.

### Elements

An elemental gun colours its tracers and has a **status chance** per hit (on the card; the Status Chance affix adds to it). On a proc:

- **Fire** — burns for 4 s, 15 % of the hit per second (60 % extra in total)
- **Shock** — chains 30 % of the hit to the nearest enemy within 6 m and stuns non-bosses for 0.5 s; ×2 against shields
- **Ice** — slows by 35 % for 3 s; 3 ice procs within 4 s freeze the target for 2 s (bosses 1 s)

### Perks

Rare and better guns roll perks; they are listed on the card under a hazard tab.

| Perk | Effect |
|---|---|
| Ricochet | Hits bounce to another enemy within 8 m for 50 % damage |
| Sharp Eye | Critical hits put 1 round back in the magazine |
| Spin-Up | Fire rate +3 % per shot while firing, up to +30 %; resets after 0.5 s without firing |
| Splash | Hits deal 30 % of their damage to enemies within 2 m |
| Vampiric | Heal 3 % of the damage you deal |
| Double Tap | 10 % chance that a shot fires twice |

Melee <kbd>V</kbd> deals 45 damage at 2.2 m. Grenades <kbd>G</kbd> arc and explode for 120 damage in 5 m (yours can hurt you); you hold 4 by default.

<a id="04-loot"></a>

## 04 · Loot & Salvage

*Your drops are yours. Take them, or turn them into scrip.*

Loot is **per player**: every drop belongs to the player who earned it, and in co-op nobody else sees or can take it. Weapons stand in a beam of their rarity colour.

- Mobs drop a weapon 12 % of the time, ammo 25 %, health 10 %, a grenade 6 %. Ammo, health and grenades are picked up by walking over them (not when you are full).
- Walk up to a weapon to see its manifest card compared with the gun in your hand (▲ better, ▼ worse).
- <kbd>E</kbd> **takes** the gun: it fills an empty slot, otherwise it replaces the gun in your hand, which drops at your feet so you can swap back.
- <kbd>F</kbd> **salvages** the gun on the spot for scrip; the prompt shows the amount (<kbd>F</kbd> SALVAGE +NN).
- A weapon left on the floor for 90 s salvages itself and pays you anyway (+NN SALVAGE on the HUD). During the pit stop loot does not age.
- Gear never drops. It comes from the shop (see Scrip, Shop & Upgrades).

Salvage value: 10 × rarity (common 1, uncommon 2, rare 4, epic 8, legendary 16) × (1 + 0.15 per item level above 1). A common level-1 gun is worth 10, a level-10 legendary 376.

<a id="05-economy"></a>

## 05 · Scrip, Shop & Upgrades

*The currency, the vendor deck and the upgrade bay.*

**Scrip** (¤) is kept between runs. You earn it from weapon salvage (manual <kbd>F</kbd> or floor expiry) and from the round-clear bounty.

### Shop

- Opens with <kbd>B</kbd> at a pit stop, from the pause menu at a pit stop, or from the start menu row SHOP. Never mid-fight.
- Sells 6–8 gear pieces: one per slot (helm, chest, boots, gloves, trinket) plus random extras, at the level of your best round so far.
- **League rarity cap:** Scrap League stock goes up to rare, Iron and Steel up to epic, Star and Void up to legendary.
- Stock stays until you **reroll** (a small fee) or clear a round, which restocks it for free.
- Click a piece to compare it with what you wear; double-click buys. A purchase goes into an empty slot, otherwise into the backpack (12 places). With a full backpack nothing is charged.

### Upgrade bay

In the loadout screen <kbd>I</kbd> and the shop: select a piece and spend scrip on it. Costs scale with rarity and item level.

| Upgrade | Effect |
|---|---|
| Reinforce | Item level +1 (max 40). All values grow and so does the model. |
| Retune | Reroll one value within its range. Click a stat chip to pick it (◆ is the implicit). |
| Augment | Add one random affix, while the piece is below its rarity cap (uncommon 1 … legendary 4). |
| Ascend | Rarity +1 (up to legendary). Rescales every value, raises the affix cap and the level. |

<a id="06-gear"></a>

## 06 · Gear & Sets

*Five slots of meta progression, bought and upgraded, never dropped.*

Gear is permanent progression: you buy it in the shop and improve it in the upgrade bay. It never drops from enemies.

| Slot | Implicit | Likely affixes |
|---|---|---|
| Helm | shield capacity | crit damage, reload |
| Chest | max health | max health, shield capacity |
| Boots | move speed | move speed, shield recharge |
| Gloves | gun damage | fire rate, gun damage |
| Trinket | shield recharge | grenade capacity, elemental resist, status chance |

- Every piece has an **implicit** (◆) plus 0–4 rolled **affixes**: common 0, uncommon 1, rare 2, epic 3, legendary 4.
- **Item level** = the round it was rolled for + a rarity bonus (uncommon +1 … legendary +5). Values grow 7 % per level, up to ×3.
- Higher item level visibly grows the model: horns and crests on helms, pauldrons and plates on chests, spikes on boots. Gloves are the slot you see in first person; teammates see all of it.
- Totals are capped, e.g. reload time never drops below 50 % and move speed tops out at +40 %.
- In the loadout <kbd>I</kbd>: click selects a piece, double-click equips or unequips it, right-click drops it.

### Sets

Rare and better pieces can belong to a set (18 % rare, 32 % epic, 50 % legendary). Bonuses count equipped pieces:

| Set | Slots | 2 pieces | 3 pieces |
|---|---|---|---|
| Voidrunner | helm, boots, gloves | +10 % move speed, −10 % reload time | +12 % fire rate; sprint + jump becomes a short blink dash (4 s cooldown) |
| Bulwark | helm, chest, boots | +20 % shield capacity and recharge | +15 % max health; when your shield breaks you take 50 % less damage for 2 s (10 s cooldown) |
| Pitfighter | chest, gloves, trinket | +10 % gun damage, +40 % melee damage | +15 % crit damage; melee kills refill your shield and refund a grenade |

<a id="07-skills"></a>

## 07 · Classes & Skills

*Four classes, three branches each, one active on Q.*

Kills, bosses and round clears give XP; each level gives **1 skill point**. Pick a class on your first run (start menu row CLASS or the CLASS button in the tree). Changing class refunds the class tree and keeps the Pit.

| Class | Identity | Starter | Active <kbd>Q</kbd> |
|---|---|---|---|
| Vanguard | +20 % shield, +10 % health | Shotgun | Shield Bash (12 s): dash 6 m, 150 % melee damage and knockback on the path, 1 s invulnerable |
| Marksman | +20 % crit damage | Pistol | Deadeye (25 s): 5 s of 50 % time for everything but you; every bullet crits |
| Technician | −10 % reload, +5 % fire rate | Rifle | Shock Pulse (14 s): 8 m shock nova, chains, restores 25 % shield |
| Showman | +8 % move speed, +10 % hype gains | SMG | Encore (30 s): refills the magazine, then 8 s of double hype and +20 % fire rate |

### The tree [TAB]

- Each class has three branches (A, B, C) of six nodes in three tiers. Tier 2 needs 3 points in that branch, tier 3 needs 6.
- **Keystones** (accent top bar) change how something works and often trade something away, e.g. Glass Jaw: +25 % gun damage, −40 % shield. Owning **any keystone** unlocks your active on <kbd>Q</kbd>.
- The **capstone** (CX, hazard tab) needs 25 points in the class tree.
- **The Pit** (P1–P5) is shared by all classes: reload, move speed, extra grenades, Pack Mule, and Second Wind (once per round, lethal damage leaves you at 1 HP with 2 s of invulnerability).
- Class tree 40 points + Pit 10 = 50 points in total. **Respec** is free (button in the tree).
- A HUD chip shows when the active is ready and its cooldown.

<a id="08-hype"></a>

## 08 · Crowd Favour

*Play to the stands: hype raises loot and XP, a bored crowd boos.*

The **hype** meter (0–100, top right) tracks how much the crowd likes the run. It starts at 10 each run and decays all the time, faster when you stop dealing damage for 5 s.

| Tier | Hype | Loot rarity | XP |
|---|---|---|---|
| Cold | 0–24 | — | ×1 |
| Warm | 25–49 | +0.10 | ×1.1 |
| Hot | 50–74 | +0.25 | ×1.25 |
| ROARING | 75–100 | +0.50 | ×1.5 |

- **Raises it:** kills +1, crit kills +4, multi-kills (3 kills within 2 s) +8 and +3 per extra kill, melee finishers +8, airborne kills +5, comeback kills below 25 % health +6, a sub-wave without taking damage +15, boss phase breaks +10, boss kill +12.
- **Lowers it:** taking damage (up to −6 per hit), a broken shield −4, idling.
- **Gifts:** while ROARING the crowd throws a gift every 25 s: a supply crate (3 items: a weapon, ammo and health), a frenzy (×1.3 damage for 10 s) or a bonus wave of extra mobs.
- **Boos:** a Cold crowd for more than 20 s of fighting boos you, and sponsors cut drop rarity (−0.1) until it warms up.
- Reaching Hot or ROARING in a round, and every gift, also earns standing.

<a id="09-standing"></a>

## 09 · Standing & Leagues

*Your permanent reputation: 5 leagues of 5 ranks.*

**Standing** is a permanent score. It never goes down and it decides your rank (start menu plaque, game-over screen). All gains are multiplied by your sponsor contract.

- Round clear: 40 + 15·round, plus your worn gear score ÷ 10.
- Headliner kill: 60 + 20·round.
- Crowd milestones: Hot +15, ROARING +30, each gift +10.
- Game over: a small consolation of 5·round, once per run.

| League | From | Ranks | Arena | Hazard |
|---|---|---|---|---|
| Scrap | 0 | Fodder → Pit Dog | sparse crowd, 2 floodlights | none |
| Iron | 3 283 | Rookie → Enforcer | half full, 4 floodlights, 1 holo-board | vent pulls |
| Steel | 9 953 | Veteran → Champion | packed, 6 floodlights, stage lasers | laser grid |
| Star | 19 041 | Starblade → Immortal | full house, 8 floodlights | gravity pulse pads |
| Void | 30 171 | Myth → Eternal (40 390) | overflowing, 10 floodlights, holo-dome | shrinking ring |

A new league also changes the arena accent colour, unlocks its sponsors, raises the shop rarity cap (Scrap rare, Iron/Steel epic, Star/Void legendary) and adds a small drop rarity bonus (+0.03 per league). Every rank inside a league grows the crowd a little.

<a id="10-sponsors"></a>

## 10 · Sponsors

*Pre-run contracts that bend the rules for better pay.*

Choose a contract on the start menu row SPONSOR before a run. It is locked in when the run starts and frees up at game over. Contracts unlock by league; Free Agent (no rules) is always available.

| Contract | League | Upside | Downside |
|---|---|---|---|
| Safety First | Scrap | enemy health −20 % | loot rarity −0.1, standing ×0.7 |
| Double Trouble | Scrap | loot ×2, enemy health −10 %, standing ×1.3 | enemies ×2 |
| Glass Cannon | Iron | your damage +40 %, standing ×1.35 | no shield |
| Burn It All | Iron | loot rarity +0.1, standing ×1.15 | only fire weapons drop, enemy health +15 % |
| Bare Knuckle | Steel | loot rarity +0.15, damage +10 %, standing ×1.2 | no grenades |
| Prime Time | Steel | enemies ×0.75, loot rarity +0.2, standing ×1.5 | a boss closes every sub-wave |
| Cold Open | Star | loot rarity +0.25, standing ×1.4 | only ice weapons drop, enemies ×1.3 |
| Blood Sport | Void | damage +25 %, loot rarity +0.4, standing ×2 | no shield, no grenades, enemy health +50 %, enemies ×1.25 |

<a id="11-hazards"></a>

## 11 · Hazards

*One arena hazard per league from Iron up, always telegraphed.*

Hazards run only during waves and boss fights. The round banner announces them (ARENA HAZARD · …). Each one warns before it acts, and no single hit is above 8 damage.

| League | Hazard | Telegraph | What it does | How to deal with it |
|---|---|---|---|---|
| Iron | Vent pulls | a wall vent lamp strobes red, chevrons light up on the floor, haze trickles (1.4 s) | a 1.3 s blast drags you toward the arena centre; no damage | step sideways out of the chevron lane, or use the push |
| Steel | Laser grid | a thin warning line for 1.2 s | a red beam at knee height sweeps across the floor; 8 shock damage per 0.5 s (×2 on shields) | jump over it or stand on cover |
| Star | Gravity pulse | ring pads (2.4 m) charge for 1.2 s | launches anyone standing on a pad into the air; no damage | step off, or use it to get height (airborne kills please the crowd) |
| Void | Shrinking ring | RING CLOSING · GET INSIDE, the accent ring flashes for 2 s | the safe circle closes from 29.5 m to 12 m around the centre, holds, then opens; 6 damage per 0.5 s outside | move toward the centre as soon as the warning shows |

<a id="12-coop"></a>

## 12 · Co-op

*2–4 players against the same arena.*

- <kbd>F2</kbd> (or the CO-OP menu row) opens the lobby. **Host** creates a room and gets a 5-character join code; others enter the code and a name and **Join**.
- The host runs the enemies, rounds and loot. Enemies get +60 % health per extra player.
- Loot stays per player: each of you sees and takes only your own drops, and salvages into your own scrip wallet.
- **Revives:** a downed player stays on the floor. Stand within 2.2 m and **hold <kbd>E</kbd> for 3 s** to bring them back at 35 % health; letting go drains the progress. The run ends when everyone is down.
- At a pit stop only the **host** can continue; everyone else sees WAITING FOR HOST.
- Menus (pause, help, shop, loadout, skills) do **not** pause a co-op session. Find cover first.
- Actives are local: the host's Deadeye slows enemies for everyone, a client's Deadeye still crits but does not slow.

<a id="13-controls"></a>

## 13 · Controls

*Keyboard and mouse.*

### Fighting

| Key | Action |
|---|---|
| <kbd>WASD</kbd> | Move |
| <kbd>SHIFT</kbd> | Sprint |
| <kbd>SPACE</kbd> | Jump |
| <kbd>LMB</kbd> | Fire |
| <kbd>RMB</kbd> | Aim down sights (hold) |
| <kbd>R</kbd> | Reload |
| <kbd>1 2</kbd> | Weapon slot (or mouse wheel) |
| <kbd>V</kbd> | Melee |
| <kbd>G</kbd> | Grenade |
| <kbd>Q</kbd> | Class active |
| <kbd>E</kbd> | Take weapon · hold to revive |
| <kbd>F</kbd> | Salvage weapon for scrip |

### Menus

| Key | Action |
|---|---|
| <kbd>ESC</kbd> | Pause / close a screen |
| <kbd>TAB</kbd> | Skill tree |
| <kbd>I</kbd> | Loadout |
| <kbd>B</kbd> | Shop (pit stop) |
| <kbd>ENTER</kbd> | Continue (pit stop) |
| <kbd>H</kbd> | This help |
| <kbd>M</kbd> | Mute |
| <kbd>F2</kbd> | Co-op lobby |

### In this help

| Key | Action |
|---|---|
| <kbd>↑ ↓</kbd> | Previous / next topic |
| <kbd>1–9 0</kbd> | Jump to a topic (two digits for 11+) |
| <kbd>PGUP PGDN</kbd> | Scroll the page |
| <kbd>H ESC</kbd> | Close |

Mouse sensitivity and sound are in SETTINGS on the start and pause screens.
