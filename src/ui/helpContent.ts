/**
 * In-game HELP content (the field manual). Pure data: src/ui/help.ts renders it as the 'help'
 * screen, and renderHelpMarkdown() turns the same data into docs/HELP.md.
 *
 * Regenerate the markdown after editing:   npx tsx scripts/help-md.ts
 * (tests/smoke/ui.test.ts fails while docs/HELP.md is out of date.)
 *
 * Inline syntax inside strings: **bold**, and [KEY] for a keycap (uppercase key names only,
 * e.g. [E], [ENTER], [F2], [LMB]). Tuning numbers that live in src/core/config.ts are
 * interpolated so the text follows balance changes; the rest is written by hand from the
 * sources listed per topic.
 */
import { ACCURACY, ADS, ECONOMY, INTERMISSION_SECONDS, LOOT, PLAYER } from '@/core/config';
import { ELEMENT_COLORS, RARITY_COLORS, type Rarity } from '@/core/types';

export type HelpBlock =
  | { h: string }
  | { p: string }
  | { list: string[] }
  | { table: { head: string[]; rows: string[][] } }
  | { keys: [key: string, action: string][] }
  | { swatches: { color: string; label: string; text: string }[] };

export interface HelpTopic {
  id: string;
  /** Topic list label (short, caps in the UI). */
  title: string;
  /** One line under the title. */
  summary: string;
  blocks: HelpBlock[];
}

const css = (n: number) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const pct = (v: number) => `${Math.round(v * 100)} %`;
const rarityLine = (r: Rarity, label: string, text: string) => ({ color: css(RARITY_COLORS[r]), label, text });
const adsLine = (a: keyof typeof ADS.archetype) => `${ADS.archetype[a].zoom}× · cone ×${ADS.archetype[a].adsSpread}`;
const bloomLine = (a: keyof typeof ACCURACY.bloom) => `+${pct(ACCURACY.bloom[a].perShot)} / shot, max +${pct(ACCURACY.bloom[a].cap)}`;

export const HELP_TOPICS: readonly HelpTopic[] = [
  // ---- 01 -------------------------------------------------------------------------------------
  {
    id: 'loop',
    title: 'The Loop',
    summary: 'Waves, a headliner boss, then a pit stop that waits for you.',
    blocks: [
      { p: `Every round runs the same way: a ${INTERMISSION_SECONDS} s intermission, three sub-waves, then the **headliner** (a boss), then a **pit stop**. The run ends when you die; there is no last round.` },
      {
        table: {
          head: ['Round N', 'What happens'],
          rows: [
            ['Waves', '20 + 8·N mobs over 3 sub-waves, at most 8 + 2·N alive at once (cap 18). Grunts rush, Spitters shoot from range, Bombers run in and explode.'],
            ['Headliner', 'Brute → Summoner → Artillery, repeating. Bosses have phases; a shielded Summoner ignores hits until its shield phase ends.'],
            ['Scaling', 'Mobs +25 % health and +15 % damage per round. Bosses +50 % health and +20 % damage per round.'],
            ['Clear', `The boss drops ${LOOT.bossDrops.min}–${LOOT.bossDrops.max} weapons. You get XP, standing (40 + 15·N) and a scrip bounty (${ECONOMY.bountyBase} + ${ECONOMY.bountyPerRound}·N). Leftover mobs die.`],
          ],
        },
      },
      { h: 'Pit stop' },
      { p: 'After the boss the game waits; there is no timer. Loot on the floor stops ageing, so you can walk around, compare and take guns at your own pace. The PIT STOP band shows the keys:' },
      {
        keys: [
          ['ENTER', 'Continue to the next round'],
          ['B', 'Shop (gear, rerolls, upgrades)'],
          ['I', 'Loadout (equip gear, upgrade bay)'],
          ['TAB', 'Skill tree (spend points)'],
        ],
      },
      { p: 'The pause menu has the same CONTINUE and SHOP rows. In co-op only the host can continue; clients see WAITING FOR HOST.' },
      { h: 'What you keep' },
      { p: 'On death you return to round 1. Level, skill points, class, standing, scrip, your gear and the two guns you carry are all kept.' },
    ],
  },
  // ---- 02 -------------------------------------------------------------------------------------
  {
    id: 'vitals',
    title: 'Shield & Health',
    summary: 'The shield recharges; health does not.',
    blocks: [
      { p: `You start with **${PLAYER.maxShield} shield** and **${PLAYER.maxHealth} health** (class, skills and gear raise both). Damage always hits the shield first; what is left goes to health.` },
      {
        list: [
          `**Recharge:** after ${PLAYER.shieldRechargeDelay} s without taking damage the shield refills at ${PLAYER.shieldRechargeRate} points per second. Any hit restarts the delay. Shield Recharge affixes speed up the refill.`,
          '**Shock ×2:** shock damage drains a shield twice as fast (the Steel League laser grid is shock). Once the shield is gone, shock hits health normally.',
          '**Elemental Resist** (gear affix) reduces fire, shock and ice damage you take.',
          '**Health never regenerates.** It comes back only from health pickups (mob drops, crowd supply crates) and from skills such as Finisher, Scar Tissue, Glory Hound or the Vampiric perk.',
          'Below 25 % health the vitals panel blinks a red hazard tab.',
          'Some sponsor contracts (Glass Cannon, Blood Sport) remove the shield entirely in exchange for damage.',
        ],
      },
      { p: '**Second Wind** (Pit node P5) saves you once per round: lethal damage leaves you at 1 HP with half a shield and 2 s of invulnerability.' },
    ],
  },
  // ---- 03 -------------------------------------------------------------------------------------
  {
    id: 'weapons',
    title: 'Weapons',
    summary: 'Archetypes, rarity, accuracy and bloom, aiming, elements and perks.',
    blocks: [
      { p: 'You carry two guns ([1] [2] or the mouse wheel). Every gun is one of five archetypes with random rolls on top, an item level (ILV) and a rarity.' },
      {
        table: {
          head: ['Archetype', 'Fire', 'Mag', 'Crit', 'Accuracy', 'Aim (RMB)'],
          rows: [
            ['Pistol', 'semi 4/s', '12', '×2.0', `${ACCURACY.base.pistol}`, adsLine('pistol')],
            ['SMG', 'auto 12/s', '36', '×1.6', `${ACCURACY.base.smg}`, adsLine('smg')],
            ['Shotgun', 'semi 1.5/s, 8 pellets', '6', '×1.5', `${ACCURACY.base.shotgun}`, adsLine('shotgun')],
            ['Rifle', 'auto 7/s', '30', '×1.8', `${ACCURACY.base.rifle}`, adsLine('rifle')],
            ['Sniper', 'semi 1/s', '5', '×3.0', `${ACCURACY.base.sniper}`, adsLine('sniper')],
          ],
        },
      },
      { h: 'Rarity' },
      {
        swatches: [
          rarityLine('common', 'Common', 'base stats, no element, no perk'),
          rarityLine('uncommon', 'Uncommon', '×1.12 stat budget, 15 % element chance'),
          rarityLine('rare', 'Rare', '×1.25, 40 % element, 1 perk'),
          rarityLine('epic', 'Epic', '×1.4, 70 % element, 1–2 perks'),
          rarityLine('legendary', 'Legendary', '×1.6, always elemental, 2 perks'),
        ],
      },
      { p: 'Loot beams, card bands and the HUD square use these colours. Better rarities get more common each round and with crowd favour, sponsors and league.' },
      { h: 'Accuracy & bloom' },
      {
        p: `**Accuracy** (0–100 on the card) sets the base cone: spread = ${ACCURACY.maxSpread} rad × (1 − accuracy/100)². Moving changes it: standing still ×0.7, walking ×1.15, sprinting about ×1.36, in the air ×1.8. **Bloom** widens the cone with every shot and drains ${ACCURACY.recoverDelay} s after you stop, over ${ACCURACY.recoverTime} s. The crosshair gap shows the current cone, so tap or burst to stay accurate.`,
      },
      {
        table: {
          head: ['Archetype', 'Bloom'],
          rows: [
            ['Pistol', bloomLine('pistol')], ['SMG', bloomLine('smg')], ['Shotgun', bloomLine('shotgun')],
            ['Rifle', bloomLine('rifle')], ['Sniper', bloomLine('sniper')],
          ],
        },
      },
      { p: `**Aim down sights:** hold [RMB]. Zoom and the aimed cone depend on the gun (table above; the card shows the exact values). While aiming you move at ${ADS.moveMult}× walk speed, cannot sprint, and recoil drops to ${ADS.recoilMult}×. Zoom ${ADS.scopeZoom}× or more shows a scope.` },
      { h: 'Elements' },
      { p: 'An elemental gun colours its tracers and has a **status chance** per hit (on the card; the Status Chance affix adds to it). On a proc:' },
      {
        swatches: [
          { color: css(ELEMENT_COLORS.fire), label: 'Fire', text: 'burns for 4 s, 15 % of the hit per second (60 % extra in total)' },
          { color: css(ELEMENT_COLORS.shock), label: 'Shock', text: 'chains 30 % of the hit to the nearest enemy within 6 m and stuns non-bosses for 0.5 s; ×2 against shields' },
          { color: css(ELEMENT_COLORS.ice), label: 'Ice', text: 'slows by 35 % for 3 s; 3 ice procs within 4 s freeze the target for 2 s (bosses 1 s)' },
        ],
      },
      { h: 'Perks' },
      { p: 'Rare and better guns roll perks; they are listed on the card under a hazard tab.' },
      {
        table: {
          head: ['Perk', 'Effect'],
          rows: [
            ['Ricochet', 'Hits bounce to another enemy within 8 m for 50 % damage'],
            ['Sharp Eye', 'Critical hits put 1 round back in the magazine'],
            ['Spin-Up', 'Fire rate +3 % per shot while firing, up to +30 %; resets after 0.5 s without firing'],
            ['Splash', 'Hits deal 30 % of their damage to enemies within 2 m'],
            ['Vampiric', 'Heal 3 % of the damage you deal'],
            ['Double Tap', '10 % chance that a shot fires twice'],
          ],
        },
      },
      { p: `Melee [V] deals ${PLAYER.meleeDamage} damage at ${PLAYER.meleeRange} m. Grenades [G] arc and explode for ${PLAYER.grenadeDamage} damage in ${PLAYER.grenadeRadius} m (yours can hurt you); you hold ${PLAYER.maxGrenades} by default.` },
    ],
  },
  // ---- 04 -------------------------------------------------------------------------------------
  {
    id: 'loot',
    title: 'Loot & Salvage',
    summary: 'Your drops are yours. Take them, or turn them into scrip.',
    blocks: [
      { p: 'Loot is **per player**: every drop belongs to the player who earned it, and in co-op nobody else sees or can take it. Weapons stand in a beam of their rarity colour.' },
      {
        list: [
          `Mobs drop a weapon ${pct(LOOT.mobWeaponDropChance)} of the time, ammo ${pct(LOOT.mobAmmoDropChance)}, health ${pct(LOOT.mobHealthDropChance)}, a grenade ${pct(LOOT.mobGrenadeDropChance)}. Ammo, health and grenades are picked up by walking over them (not when you are full).`,
          'Walk up to a weapon to see its manifest card compared with the gun in your hand (▲ better, ▼ worse).',
          '[E] **takes** the gun: it fills an empty slot, otherwise it replaces the gun in your hand, which drops at your feet so you can swap back.',
          '[F] **salvages** the gun on the spot for scrip; the prompt shows the amount ([F] SALVAGE +NN).',
          `A weapon left on the floor for ${LOOT.lifetime} s salvages itself and pays you anyway (+NN SALVAGE on the HUD). During the pit stop loot does not age.`,
          'Gear never drops. It comes from the shop (see Scrip, Shop & Upgrades).',
        ],
      },
      {
        p: `Salvage value: ${ECONOMY.salvageBase} × rarity (common 1, uncommon 2, rare 4, epic 8, legendary 16) × (1 + ${ECONOMY.levelRate} per item level above 1). A common level-1 gun is worth 10, a level-10 legendary 376.`,
      },
    ],
  },
  // ---- 05 -------------------------------------------------------------------------------------
  {
    id: 'economy',
    title: 'Scrip, Shop & Upgrades',
    summary: 'The currency, the vendor deck and the upgrade bay.',
    blocks: [
      { p: '**Scrip** (¤) is kept between runs. You earn it from weapon salvage (manual [F] or floor expiry) and from the round-clear bounty.' },
      { h: 'Shop' },
      {
        list: [
          'Opens with [B] at a pit stop, from the pause menu at a pit stop, or from the start menu row SHOP. Never mid-fight.',
          'Sells 6–8 gear pieces: one per slot (helm, chest, boots, gloves, trinket) plus random extras, at the level of your best round so far.',
          '**League rarity cap:** Scrap League stock goes up to rare, Iron and Steel up to epic, Star and Void up to legendary.',
          'Stock stays until you **reroll** (a small fee) or clear a round, which restocks it for free.',
          'Click a piece to compare it with what you wear; double-click buys. A purchase goes into an empty slot, otherwise into the backpack (12 places). With a full backpack nothing is charged.',
        ],
      },
      { h: 'Upgrade bay' },
      { p: 'In the loadout screen [I] and the shop: select a piece and spend scrip on it. Costs scale with rarity and item level.' },
      {
        table: {
          head: ['Upgrade', 'Effect'],
          rows: [
            ['Reinforce', `Item level +1 (max ${ECONOMY.maxItemLevel}). All values grow and so does the model.`],
            ['Retune', 'Reroll one value within its range. Click a stat chip to pick it (◆ is the implicit).'],
            ['Augment', 'Add one random affix, while the piece is below its rarity cap (uncommon 1 … legendary 4).'],
            ['Ascend', 'Rarity +1 (up to legendary). Rescales every value, raises the affix cap and the level.'],
          ],
        },
      },
    ],
  },
  // ---- 06 -------------------------------------------------------------------------------------
  {
    id: 'gear',
    title: 'Gear & Sets',
    summary: 'Five slots of meta progression, bought and upgraded, never dropped.',
    blocks: [
      { p: 'Gear is permanent progression: you buy it in the shop and improve it in the upgrade bay. It never drops from enemies.' },
      {
        table: {
          head: ['Slot', 'Implicit', 'Likely affixes'],
          rows: [
            ['Helm', 'shield capacity', 'crit damage, reload'],
            ['Chest', 'max health', 'max health, shield capacity'],
            ['Boots', 'move speed', 'move speed, shield recharge'],
            ['Gloves', 'gun damage', 'fire rate, gun damage'],
            ['Trinket', 'shield recharge', 'grenade capacity, elemental resist, status chance'],
          ],
        },
      },
      {
        list: [
          'Every piece has an **implicit** (◆) plus 0–4 rolled **affixes**: common 0, uncommon 1, rare 2, epic 3, legendary 4.',
          '**Item level** = the round it was rolled for + a rarity bonus (uncommon +1 … legendary +5). Values grow 7 % per level, up to ×3.',
          'Higher item level visibly grows the model: horns and crests on helms, pauldrons and plates on chests, spikes on boots. Gloves are the slot you see in first person; teammates see all of it.',
          'Totals are capped, e.g. reload time never drops below 50 % and move speed tops out at +40 %.',
          'In the loadout [I]: click selects a piece, double-click equips or unequips it, right-click drops it.',
        ],
      },
      { h: 'Sets' },
      { p: 'Rare and better pieces can belong to a set (18 % rare, 32 % epic, 50 % legendary). Bonuses count equipped pieces:' },
      {
        table: {
          head: ['Set', 'Slots', '2 pieces', '3 pieces'],
          rows: [
            ['Voidrunner', 'helm, boots, gloves', '+10 % move speed, −10 % reload time', '+12 % fire rate; sprint + jump becomes a short blink dash (4 s cooldown)'],
            ['Bulwark', 'helm, chest, boots', '+20 % shield capacity and recharge', '+15 % max health; when your shield breaks you take 50 % less damage for 2 s (10 s cooldown)'],
            ['Pitfighter', 'chest, gloves, trinket', '+10 % gun damage, +40 % melee damage', '+15 % crit damage; melee kills refill your shield and refund a grenade'],
          ],
        },
      },
    ],
  },
  // ---- 07 -------------------------------------------------------------------------------------
  {
    id: 'skills',
    title: 'Classes & Skills',
    summary: 'Four classes, three branches each, one active on Q.',
    blocks: [
      { p: 'Kills, bosses and round clears give XP; each level gives **1 skill point**. Pick a class on your first run (start menu row CLASS or the CLASS button in the tree). Changing class refunds the class tree and keeps the Pit.' },
      {
        table: {
          head: ['Class', 'Identity', 'Starter', 'Active [Q]'],
          rows: [
            ['Vanguard', '+20 % shield, +10 % health', 'Shotgun', 'Shield Bash (12 s): dash 6 m, 150 % melee damage and knockback on the path, 1 s invulnerable'],
            ['Marksman', '+20 % crit damage', 'Pistol', 'Deadeye (25 s): 5 s of 50 % time for everything but you; every bullet crits'],
            ['Technician', '−10 % reload, +5 % fire rate', 'Rifle', 'Shock Pulse (14 s): 8 m shock nova, chains, restores 25 % shield'],
            ['Showman', '+8 % move speed, +10 % hype gains', 'SMG', 'Encore (30 s): refills the magazine, then 8 s of double hype and +20 % fire rate'],
          ],
        },
      },
      { h: 'The tree [TAB]' },
      {
        list: [
          'Each class has three branches (A, B, C) of six nodes in three tiers. Tier 2 needs 3 points in that branch, tier 3 needs 6.',
          '**Keystones** (accent top bar) change how something works and often trade something away, e.g. Glass Jaw: +25 % gun damage, −40 % shield. Owning **any keystone** unlocks your active on [Q].',
          'The **capstone** (CX, hazard tab) needs 25 points in the class tree.',
          '**The Pit** (P1–P5) is shared by all classes: reload, move speed, extra grenades, Pack Mule, and Second Wind (once per round, lethal damage leaves you at 1 HP with 2 s of invulnerability).',
          'Class tree 40 points + Pit 10 = 50 points in total. **Respec** is free (button in the tree).',
          'A HUD chip shows when the active is ready and its cooldown.',
        ],
      },
    ],
  },
  // ---- 08 -------------------------------------------------------------------------------------
  {
    id: 'hype',
    title: 'Crowd Favour',
    summary: 'Play to the stands: hype raises loot and XP, a bored crowd boos.',
    blocks: [
      { p: 'The **hype** meter (0–100, top right) tracks how much the crowd likes the run. It starts at 10 each run and decays all the time, faster when you stop dealing damage for 5 s.' },
      {
        table: {
          head: ['Tier', 'Hype', 'Loot rarity', 'XP'],
          rows: [
            ['Cold', '0–24', '—', '×1'],
            ['Warm', '25–49', '+0.10', '×1.1'],
            ['Hot', '50–74', '+0.25', '×1.25'],
            ['ROARING', '75–100', '+0.50', '×1.5'],
          ],
        },
      },
      {
        list: [
          '**Raises it:** kills +1, crit kills +4, multi-kills (3 kills within 2 s) +8 and +3 per extra kill, melee finishers +8, airborne kills +5, comeback kills below 25 % health +6, a sub-wave without taking damage +15, boss phase breaks +10, boss kill +12.',
          '**Lowers it:** taking damage (up to −6 per hit), a broken shield −4, idling.',
          '**Gifts:** while ROARING the crowd throws a gift every 25 s: a supply crate (3 items: a weapon, ammo and health), a frenzy (×1.3 damage for 10 s) or a bonus wave of extra mobs.',
          '**Boos:** a Cold crowd for more than 20 s of fighting boos you, and sponsors cut drop rarity (−0.1) until it warms up.',
          'Reaching Hot or ROARING in a round, and every gift, also earns standing.',
        ],
      },
    ],
  },
  // ---- 09 -------------------------------------------------------------------------------------
  {
    id: 'standing',
    title: 'Standing & Leagues',
    summary: 'Your permanent reputation: 5 leagues of 5 ranks.',
    blocks: [
      { p: '**Standing** is a permanent score. It never goes down and it decides your rank (start menu plaque, game-over screen). All gains are multiplied by your sponsor contract.' },
      {
        list: [
          'Round clear: 40 + 15·round, plus your worn gear score ÷ 10.',
          'Headliner kill: 60 + 20·round.',
          'Crowd milestones: Hot +15, ROARING +30, each gift +10.',
          'Game over: a small consolation of 5·round, once per run.',
        ],
      },
      {
        table: {
          head: ['League', 'From', 'Ranks', 'Arena', 'Hazard'],
          rows: [
            ['Scrap', '0', 'Fodder → Pit Dog', 'sparse crowd, 2 floodlights', 'none'],
            ['Iron', '3 283', 'Rookie → Enforcer', 'half full, 4 floodlights, 1 holo-board', 'vent pulls'],
            ['Steel', '9 953', 'Veteran → Champion', 'packed, 6 floodlights, stage lasers', 'laser grid'],
            ['Star', '19 041', 'Starblade → Immortal', 'full house, 8 floodlights', 'gravity pulse pads'],
            ['Void', '30 171', 'Myth → Eternal (40 390)', 'overflowing, 10 floodlights, holo-dome', 'shrinking ring'],
          ],
        },
      },
      { p: 'A new league also changes the arena accent colour, unlocks its sponsors, raises the shop rarity cap (Scrap rare, Iron/Steel epic, Star/Void legendary) and adds a small drop rarity bonus (+0.03 per league). Every rank inside a league grows the crowd a little.' },
    ],
  },
  // ---- 10 -------------------------------------------------------------------------------------
  {
    id: 'sponsors',
    title: 'Sponsors',
    summary: 'Pre-run contracts that bend the rules for better pay.',
    blocks: [
      { p: 'Choose a contract on the start menu row SPONSOR before a run. It is locked in when the run starts and frees up at game over. Contracts unlock by league; Free Agent (no rules) is always available.' },
      {
        table: {
          head: ['Contract', 'League', 'Upside', 'Downside'],
          rows: [
            ['Safety First', 'Scrap', 'enemy health −20 %', 'loot rarity −0.1, standing ×0.7'],
            ['Double Trouble', 'Scrap', 'loot ×2, enemy health −10 %, standing ×1.3', 'enemies ×2'],
            ['Glass Cannon', 'Iron', 'your damage +40 %, standing ×1.35', 'no shield'],
            ['Burn It All', 'Iron', 'loot rarity +0.1, standing ×1.15', 'only fire weapons drop, enemy health +15 %'],
            ['Bare Knuckle', 'Steel', 'loot rarity +0.15, damage +10 %, standing ×1.2', 'no grenades'],
            ['Prime Time', 'Steel', 'enemies ×0.75, loot rarity +0.2, standing ×1.5', 'a boss closes every sub-wave'],
            ['Cold Open', 'Star', 'loot rarity +0.25, standing ×1.4', 'only ice weapons drop, enemies ×1.3'],
            ['Blood Sport', 'Void', 'damage +25 %, loot rarity +0.4, standing ×2', 'no shield, no grenades, enemy health +50 %, enemies ×1.25'],
          ],
        },
      },
    ],
  },
  // ---- 11 -------------------------------------------------------------------------------------
  {
    id: 'hazards',
    title: 'Hazards',
    summary: 'One arena hazard per league from Iron up, always telegraphed.',
    blocks: [
      { p: 'Hazards run only during waves and boss fights. The round banner announces them (ARENA HAZARD · …). Each one warns before it acts, and no single hit is above 8 damage.' },
      {
        table: {
          head: ['League', 'Hazard', 'Telegraph', 'What it does', 'How to deal with it'],
          rows: [
            ['Iron', 'Vent pulls', 'a wall vent lamp strobes red, chevrons light up on the floor, haze trickles (1.4 s)', 'a 1.3 s blast drags you toward the arena centre; no damage', 'step sideways out of the chevron lane, or use the push'],
            ['Steel', 'Laser grid', 'a thin warning line for 1.2 s', 'a red beam at knee height sweeps across the floor; 8 shock damage per 0.5 s (×2 on shields)', 'jump over it or stand on cover'],
            ['Star', 'Gravity pulse', 'ring pads (2.4 m) charge for 1.2 s', 'launches anyone standing on a pad into the air; no damage', 'step off, or use it to get height (airborne kills please the crowd)'],
            ['Void', 'Shrinking ring', 'RING CLOSING · GET INSIDE, the accent ring flashes for 2 s', 'the safe circle closes from 29.5 m to 12 m around the centre, holds, then opens; 6 damage per 0.5 s outside', 'move toward the centre as soon as the warning shows'],
          ],
        },
      },
    ],
  },
  // ---- 12 -------------------------------------------------------------------------------------
  {
    id: 'coop',
    title: 'Co-op',
    summary: '2–4 players against the same arena.',
    blocks: [
      {
        list: [
          '[F2] (or the CO-OP menu row) opens the lobby. **Host** creates a room and gets a 5-character join code; others enter the code and a name and **Join**.',
          'The host runs the enemies, rounds and loot. Enemies get +60 % health per extra player.',
          'Loot stays per player: each of you sees and takes only your own drops, and salvages into your own scrip wallet.',
          '**Revives:** a downed player stays on the floor. Stand within 2.2 m and **hold [E] for 3 s** to bring them back at 35 % health; letting go drains the progress. The run ends when everyone is down.',
          'At a pit stop only the **host** can continue; everyone else sees WAITING FOR HOST.',
          'Menus (pause, help, shop, loadout, skills) do **not** pause a co-op session. Find cover first.',
          "Actives are local: the host's Deadeye slows enemies for everyone, a client's Deadeye still crits but does not slow.",
        ],
      },
    ],
  },
  // ---- 13 -------------------------------------------------------------------------------------
  {
    id: 'controls',
    title: 'Controls',
    summary: 'Keyboard and mouse.',
    blocks: [
      { h: 'Fighting' },
      {
        keys: [
          ['WASD', 'Move'], ['SHIFT', 'Sprint'], ['SPACE', 'Jump'], ['LMB', 'Fire'], ['RMB', 'Aim down sights (hold)'],
          ['R', 'Reload'], ['1 2', 'Weapon slot (or mouse wheel)'], ['V', 'Melee'], ['G', 'Grenade'], ['Q', 'Class active'],
          ['E', 'Take weapon · hold to revive'], ['F', 'Salvage weapon for scrip'],
        ],
      },
      { h: 'Menus' },
      {
        keys: [
          ['ESC', 'Pause / close a screen'], ['TAB', 'Skill tree'], ['I', 'Loadout'], ['B', 'Shop (pit stop)'],
          ['ENTER', 'Continue (pit stop)'], ['H', 'This help'], ['M', 'Mute'], ['F2', 'Co-op lobby'],
        ],
      },
      { h: 'In this help' },
      { keys: [['↑ ↓', 'Previous / next topic'], ['1–9 0', 'Jump to a topic (two digits for 11+)'], ['PGUP PGDN', 'Scroll the page'], ['H ESC', 'Close']] },
      { p: 'Mouse sensitivity and sound are in SETTINGS on the start and pause screens.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Markdown (docs/HELP.md)
// ---------------------------------------------------------------------------
/** [E] / [ENTER] / [F2] / [1 2] / [↑ ↓] … : the keycap syntax shared by the HTML and markdown renderers. */
export const KEYCAP_RE = /\[([A-Z0-9↑↓←→][A-Z0-9 ↑↓←→–/]{0,9})\]/g;

const mdInline = (s: string) => s.replace(KEYCAP_RE, '<kbd>$1</kbd>');
const mdCell = (s: string) => mdInline(s).replace(/\|/g, '\\|');

export function renderHelpMarkdown(topics: readonly HelpTopic[] = HELP_TOPICS): string {
  const out: string[] = [
    '# Orbital Concourse — help',
    '',
    '<!-- Generated from src/ui/helpContent.ts by `npx tsx scripts/help-md.ts`. Edit the source, not this file. -->',
    '',
    'The same text is in the game: press <kbd>H</kbd> anywhere, or pick HELP on the start or pause menu.',
    '',
    ...topics.map((t, i) => `${i + 1}. [${t.title}](#${String(i + 1).padStart(2, '0')}-${t.id})`),
    '',
  ];
  topics.forEach((t, i) => {
    out.push(`<a id="${String(i + 1).padStart(2, '0')}-${t.id}"></a>`, '', `## ${String(i + 1).padStart(2, '0')} · ${t.title}`, '', `*${t.summary}*`, '');
    for (const b of t.blocks) {
      if ('h' in b) out.push(`### ${b.h}`, '');
      else if ('p' in b) out.push(mdInline(b.p), '');
      else if ('list' in b) out.push(...b.list.map((l) => `- ${mdInline(l)}`), '');
      else if ('keys' in b) out.push('| Key | Action |', '|---|---|', ...b.keys.map(([k, a]) => `| <kbd>${k}</kbd> | ${mdCell(a)} |`), '');
      else if ('swatches' in b) out.push(...b.swatches.map((s) => `- **${s.label}** — ${mdInline(s.text)}`), '');
      else if ('table' in b) {
        out.push(`| ${b.table.head.map(mdCell).join(' | ')} |`, `|${b.table.head.map(() => '---').join('|')}|`);
        for (const r of b.table.rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
        out.push('');
      }
    }
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
