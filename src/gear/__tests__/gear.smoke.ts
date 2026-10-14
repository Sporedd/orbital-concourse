/**
 * Headless smoke test for system G (generator invariants, stat math, inventory, models).
 *
 * Run:  npx tsx src/gear/__tests__/gear.smoke.ts
 *  or (no tsx installed, uses Vite's esbuild):
 *    node -e "require('esbuild').buildSync({entryPoints:['src/gear/__tests__/gear.smoke.ts'],bundle:true,platform:'node',format:'esm',outfile:'node_modules/.cache/gear.smoke.mjs'})" && node node_modules/.cache/gear.smoke.mjs
 *
 * Exits non-zero (throws) on the first failed assertion batch; prints a summary otherwise.
 */
import * as THREE from 'three';
import { RARITY_ORDER, type GameContext, type LootItemState, type MaterialFactory, type Rarity, type WeaponDef } from '@/core/types';
import { createRng } from '@/core/rng';
import { EventBus } from '@/core/events';
import { createGearSystem } from '../index';
import {
  AFFIX_COUNT, AFFIX_POOLS, GEAR_CAPS, GEAR_SETS, GEAR_STATS, IMPLICIT_STAT, LEVEL_BONUS,
  affixBounds, computeLoadoutStats, gearScore, generateGear, growthForLevel, leagueForLevel, mergeStats, rarityIndex,
} from '../generator';
import { buildGearModel, buildGloveViewmodel, countMeshes, type GearModel } from '../models';
import { Inventory, compareGear, type GearStorage } from '../inventory';
import { applyWeaponGrowth, weaponGrowthParams } from '../weaponGrowth';
import { GEAR_SLOTS, type GearDef, type GearSlot, type Loadout } from '../types';

let checks = 0;
const failures: string[] = [];
function assert(cond: unknown, msg: string): void {
  checks++;
  if (!cond) failures.push(msg);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const rng = createRng(0xC0FFEE);
let idN = 0;
const nextId = (p: string) => `${p}${++idN}`;

// ---------------------------------------------------------------------------
// 1. Generator invariants over 200 pieces
// ---------------------------------------------------------------------------
const pieces: GearDef[] = [];
const byRarity: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
let setCount = 0;
let elemCount = 0;
let minLevel = Infinity;
let maxLevel = -Infinity;
const statRange: Record<string, [number, number]> = {};

for (let i = 0; i < 200; i++) {
  const tier = 1 + (i % 25);
  const slot = GEAR_SLOTS[i % GEAR_SLOTS.length];
  const forced = i % 2 === 0;
  const rarity = forced ? RARITY_ORDER[Math.floor(i / 2) % RARITY_ORDER.length] : undefined;
  const d = generateGear(rng, nextId, tier, { slot, rarity, rarityBoost: forced ? 0 : (i % 7) / 7 });
  pieces.push(d);
  byRarity[d.rarity]++;
  if (d.setId) setCount++;
  if (d.element) elemCount++;
  minLevel = Math.min(minLevel, d.level);
  maxLevel = Math.max(maxLevel, d.level);
  const tag = `#${i} ${d.name} (${d.slot}/${d.rarity}/L${d.level})`;

  assert(d.slot === slot, `${tag}: slot`);
  if (rarity) assert(d.rarity === rarity, `${tag}: forced rarity`);
  assert(d.tier === tier, `${tag}: tier`);
  assert(d.level === tier + LEVEL_BONUS[d.rarity], `${tag}: level = tier + bonus`);
  assert(d.affixes.length === AFFIX_COUNT[d.rarity], `${tag}: affix count ${d.affixes.length}`);
  assert(new Set(d.affixes.map((a) => a.stat)).size === d.affixes.length, `${tag}: duplicate affix stats`);
  assert(d.implicit.stat === IMPLICIT_STAT[d.slot], `${tag}: implicit stat`);
  const [imin, imax] = affixBounds(d.implicit.stat, d.level, d.rarity, true);
  assert(d.implicit.value >= imin && d.implicit.value <= imax, `${tag}: implicit ${d.implicit.value} not in [${imin},${imax}]`);
  const pool = [...AFFIX_POOLS[d.slot].primary, ...AFFIX_POOLS[d.slot].secondary];
  for (const a of [d.implicit, ...d.affixes]) {
    const r = (statRange[a.stat] ??= [Infinity, -Infinity]);
    r[0] = Math.min(r[0], a.value);
    r[1] = Math.max(r[1], a.value);
    assert(a.description.length > 0 && a.id === `aff_${a.stat}`, `${tag}: affix text/id`);
  }
  for (const a of d.affixes) {
    const [lo, hi] = affixBounds(a.stat, d.level, d.rarity);
    assert(a.value >= lo && a.value <= hi, `${tag}: ${a.stat}=${a.value} not in [${lo},${hi}]`);
    assert(pool.includes(a.stat), `${tag}: ${a.stat} not in ${d.slot} pool`);
    if (a.stat === 'elementChance') assert(!!d.element, `${tag}: elementChance without element`);
    if (a.stat === 'grenades') assert(Number.isInteger(a.value) && a.value >= 1 && a.value <= 3, `${tag}: grenades int`);
  }
  if (d.setId) {
    assert(GEAR_SETS[d.setId].slots.includes(d.slot), `${tag}: set ${d.setId} does not contain ${d.slot}`);
    assert(rarityIndex(d.rarity) >= 2, `${tag}: set piece below rare`);
    assert(d.name.includes(GEAR_SETS[d.setId].name), `${tag}: set name missing`);
  }
  assert(d.growth === growthForLevel(d.level) && d.growth >= 0 && d.growth < 1, `${tag}: growth`);
  assert(d.league === leagueForLevel(d.level), `${tag}: league`);
  assert(d.name.startsWith('★ ') === (d.rarity === 'legendary'), `${tag}: ★ iff legendary`);
  assert(d.name.includes(' of '), `${tag}: name format`);
  assert(gearScore(d) > 0, `${tag}: score`);
  assert(Number.isInteger(d.seed) && d.seed >= 0, `${tag}: seed`);
}
assert(Object.values(byRarity).every((n) => n > 0), 'every rarity generated');

// growth curve monotonic, 0 at level 1
assert(growthForLevel(1) === 0, 'growth(1) = 0');
for (let l = 2; l < 40; l++) assert(growthForLevel(l) > growthForLevel(l - 1), `growth monotonic at ${l}`);

// determinism: same seed -> same piece
{
  let a = 0;
  let b = 0;
  const x = generateGear(createRng(42), (p) => `${p}${++a}`, 7, { rarity: 'epic' });
  const y = generateGear(createRng(42), (p) => `${p}${++b}`, 7, { rarity: 'epic' });
  assert(JSON.stringify(x) === JSON.stringify(y), 'deterministic for a seed');
}

// forced sets
for (const set of Object.values(GEAR_SETS)) {
  for (const slot of set.slots) {
    const d = generateGear(rng, nextId, 5, { slot, rarity: 'rare', setId: set.id });
    assert(d.setId === set.id, `forced set ${set.id}/${slot}`);
  }
}
assert(generateGear(rng, nextId, 5, { slot: 'trinket', rarity: 'legendary', setId: 'bulwark' }).setId === undefined, 'set ignored for non-member slot');
assert(generateGear(rng, nextId, 5, { slot: 'chest', rarity: 'legendary', setId: null }).setId === undefined, 'setId null forbids sets');

// ---------------------------------------------------------------------------
// 2. Loadout stats + set bonuses
// ---------------------------------------------------------------------------
{
  const empty = computeLoadoutStats({});
  assert(Object.values(empty.stats).every((v) => v === 1), 'empty loadout is neutral');
  assert(empty.extraGrenades === 0 && empty.sets.length === 0 && empty.hooks.length === 0, 'empty extras');

  const bulwark: Loadout = {};
  for (const slot of GEAR_SETS.bulwark.slots) bulwark[slot] = generateGear(rng, nextId, 3, { slot, rarity: 'epic', setId: 'bulwark' });
  const bs = computeLoadoutStats(bulwark);
  assert(bs.sets.length === 1 && bs.sets[0].pieces === 3 && bs.sets[0].active.length === 2, 'bulwark 3/3 active');
  assert(bs.hooks.includes('bulwark_last_stand'), 'bulwark hook');
  let shieldSum = 0.2;
  for (const d of Object.values(bulwark)) for (const a of [d!.implicit, ...d!.affixes]) if (a.stat === 'shieldMult') shieldSum += a.value;
  assert(near(bs.stats.shieldMult, Math.round((1 + Math.min(shieldSum, GEAR_CAPS.shieldMult)) * 1000) / 1000, 0.0015), `bulwark shield ${bs.stats.shieldMult} vs ${1 + shieldSum}`);

  const vr: Loadout = {
    helm: generateGear(rng, nextId, 3, { slot: 'helm', rarity: 'rare', setId: 'voidrunner' }),
    boots: generateGear(rng, nextId, 3, { slot: 'boots', rarity: 'rare', setId: 'voidrunner' }),
  };
  const vs = computeLoadoutStats(vr);
  assert(vs.sets[0]?.pieces === 2 && vs.sets[0].active.length === 1 && vs.hooks.length === 0, 'voidrunner 2/3: bonus, no hook');
  assert(vs.stats.moveSpeedMult >= 1.1 && vs.stats.reloadMult <= 0.9, 'voidrunner 2pc stats applied');

  // mismatched slot key is ignored
  assert(computeLoadoutStats({ helm: vr.boots }).score === 0, 'piece in wrong slot ignored');

  // random loadouts: everything inside caps
  for (let n = 0; n < 150; n++) {
    const lo: Loadout = {};
    for (const s of GEAR_SLOTS) if (rng() < 0.85) lo[s] = generateGear(rng, nextId, 1 + Math.floor(rng() * 30), { slot: s, rarityBoost: rng() });
    const st = computeLoadoutStats(lo);
    for (const [k, v] of Object.entries(st.stats)) {
      if (k === 'reloadMult') assert(v <= 1 && v >= 1 - GEAR_CAPS.reloadMult - 1e-9, `reloadMult ${v}`);
      else assert(v >= 1 && v <= 1 + GEAR_CAPS[k as keyof typeof GEAR_CAPS] + 1e-9, `${k} ${v} out of cap`);
    }
    for (const s of GEAR_STATS) assert(st.totals[s] >= 0 && st.totals[s] <= GEAR_CAPS[s] + 1e-9, `total ${s}`);
    assert(Number.isInteger(st.extraGrenades) && st.extraGrenades <= GEAR_CAPS.grenades, 'grenades int/cap');
    assert(st.elementalResist <= GEAR_CAPS.elementalResist, 'resist cap');
  }

  const base = { damageMult: 1.4, fireRateMult: 1.12, reloadMult: 0.88, critMult: 1, healthMult: 1, shieldMult: 1.3, moveSpeedMult: 1.08 };
  const m = mergeStats(base, bs.stats);
  assert(near(m.shieldMult, 1.3 * bs.stats.shieldMult) && near(m.damageMult, 1.4 * bs.stats.damageMult), 'mergeStats multiplies');
}

// ---------------------------------------------------------------------------
// 3. Inventory
// ---------------------------------------------------------------------------
{
  const inv = new Inventory(12, 'test.gear');
  let fullEvents = 0;
  let changes = 0;
  inv.events.on('gear:full', () => fullEvents++);
  inv.events.on('gear:changed', () => changes++);
  const helmA = generateGear(rng, nextId, 4, { slot: 'helm', rarity: 'rare' });
  assert(inv.pickUp(helmA) === 'equipped', 'pickUp equips into empty slot');
  assert(inv.pickUp(helmA) === 'duplicate', 'duplicate refused');
  for (let i = 0; i < 12; i++) assert(inv.add(generateGear(rng, nextId, 4, { slot: GEAR_SLOTS[i % 5] })), `add ${i}`);
  assert(inv.isFull() && !inv.add(generateGear(rng, nextId, 4)) && fullEvents === 1, 'capacity 12 enforced');
  assert(!inv.unequip('helm'), 'unequip refused when full');
  const helmB = inv.backpack.find((d) => d.slot === 'helm')!;
  assert(inv.equip(helmB.id) && inv.equipped('helm')?.id === helmB.id, 'equip from backpack');
  assert(inv.backpack.some((d) => d.id === helmA.id) && inv.backpack.length === 12, 'swapped piece back in backpack');
  assert(inv.remove(helmA.id)?.id === helmA.id && inv.backpack.length === 11, 'remove');
  assert(inv.unequip('helm') && !inv.equipped('helm'), 'unequip');
  assert(inv.stats === inv.stats && changes > 0, 'stats cached + change events');

  const cmp = compareGear(helmA, helmB, inv.loadout);
  assert(cmp.delta === cmp.scoreA - cmp.scoreB && cmp.lines.length > 0, 'compare');
  assert(compareGear(helmA, null).scoreB === 0, 'compare vs empty');

  // persistence round trip through a memory storage
  const mem = new Map<string, string>();
  const storage: GearStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  inv.equip(inv.backpack.find((d) => d.slot === 'chest')!.id);
  inv.save(storage);
  const inv2 = new Inventory(12, 'test.gear');
  assert(inv2.load(storage), 'load');
  assert(inv2.serialize() === inv.serialize(), 'serialize round trip');
  const inv3 = new Inventory(12, 'test.gear');
  let r = 0;
  assert(inv3.load(storage, (p) => `${p}re${++r}`) && inv3.backpack.every((d) => d.id.includes('re')), 're-id on load');
  assert(!inv3.deserialize('{"v":99}') && !inv3.deserialize('nope'), 'reject bad saves');
  const tampered = JSON.parse(inv.serialize());
  tampered.backpack.push({ id: 'x', slot: 'hat', rarity: 'epic' }, 42, null);
  tampered.loadout.boots = tampered.loadout.chest; // wrong slot
  const inv4 = new Inventory();
  assert(inv4.deserialize(JSON.stringify(tampered)) && inv4.backpack.length === inv.backpack.length && !inv4.equipped('boots'), 'sanitises junk');
}

// ---------------------------------------------------------------------------
// 4. Models at growth 0 / 0.5 / 1 for every slot and rarity
// ---------------------------------------------------------------------------
const stubMaterials: MaterialFactory = {
  toon: (o) => new THREE.MeshToonMaterial({ color: o.color, emissive: o.emissive ?? 0x000000 }),
  glow: (c, i = 2.2) => {
    const m = new THREE.MeshBasicMaterial({ color: c });
    m.color.multiplyScalar(i);
    return m;
  },
};

const meshCounts: Record<string, number[]> = {};
const box = new THREE.Box3();
for (const slot of GEAR_SLOTS) {
  for (const rarity of RARITY_ORDER) {
    const base = generateGear(rng, nextId, 6, { slot, rarity });
    let prev: GearModel | null = null;
    for (const growth of [0, 0.5, 1]) {
      const def = { ...base, growth };
      const tag = `${slot}/${rarity}/g${growth}`;
      let model: GearModel | null = null;
      try {
        model = buildGearModel(def, stubMaterials);
        for (let t = 0; t < 3; t += 0.37) model.animate(t);
        model.updateMatrixWorld(true);
        box.setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        assert(Number.isFinite(size.x) && size.x > 0 && size.length() < 3, `${tag}: bounding box ${size.toArray()}`);
        const n = countMeshes(model);
        assert(n > 3, `${tag}: meshes ${n}`);
        (meshCounts[`${slot}/${rarity}`] ??= []).push(n);
        if (slot === 'boots' || slot === 'gloves') assert(model.left && model.right, `${tag}: left/right`);
        if (rarity === 'legendary') assert(model.ownedMaterials.length === 1, `${tag}: legendary owns a pulsing seam`);
        if (model.params.slot === 'trinket') {
          let orbs = 0;
          model.traverse((o) => {
            if (o.userData.orb) orbs++;
          });
          assert(orbs === model.params.orbCount, `${tag}: orbs ${orbs} vs ${model.params.orbCount}`);
        }
        // seams: none on commons, glow (MeshBasic) above
        let glowMeshes = 0;
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && (mesh.material as THREE.Material).type === 'MeshBasicMaterial' && mesh.material !== undefined) glowMeshes++;
        });
        const visorOnly = slot === 'helm' ? 1 : 0;
        if (rarity === 'common') assert(glowMeshes === visorOnly, `${tag}: common has no seams (${glowMeshes})`);
        else assert(glowMeshes > visorOnly, `${tag}: seams present`);
        // discrete steps (ART_DIRECTION §8)
        const pr = model.params;
        if (growth === 0) {
          if (pr.slot === 'helm') assert(pr.finCount === 0 && pr.mastCount === 0 && pr.ribCount === 0, `${tag}: ilvl1 = slabs only`);
          if (pr.slot === 'chest') assert(pr.finCount === 0 && pr.mastCount === 0, `${tag}: ilvl1 chest`);
        }
        if (growth === 1) {
          if (pr.slot === 'helm') assert(pr.finCount > 0 && pr.mastCount > 0 && pr.doublePlates === 1, `${tag}: max helm has fins+masts+double plates`);
          if (pr.slot === 'chest') assert(pr.finCount > 0 && pr.mastCount > 0 && pr.doublePlates === 1, `${tag}: max chest`);
          if (pr.slot === 'boots') assert(pr.finCount > 0 && pr.doublePlates === 1, `${tag}: max boots`);
          if (pr.slot === 'gloves') assert(pr.finCount > 0 && pr.knuckleStuds > 0 && pr.doublePlates === 1, `${tag}: max gloves`);
        }
        if (prev) {
          const a = prev.params;
          const b = model.params;
          if (a.slot === 'helm' && b.slot === 'helm') assert(b.crestHeight > a.crestHeight && b.shellScale > a.shellScale && b.visorLum > a.visorLum && b.ribCount >= a.ribCount && b.finCount >= a.finCount && b.mastCount >= a.mastCount, `${tag}: helm grows`);
          if (a.slot === 'chest' && b.slot === 'chest') assert(b.pauldronSize > a.pauldronSize && b.plateLayers > a.plateLayers && b.plateSize > a.plateSize && b.collarHeight > a.collarHeight, `${tag}: chest grows`);
          if (a.slot === 'boots' && b.slot === 'boots') assert(b.soleThickness > a.soleThickness && b.greaveHeight > a.greaveHeight && b.ribCount >= a.ribCount, `${tag}: boots grow`);
          if (a.slot === 'gloves' && b.slot === 'gloves') assert(b.gauntletLength > a.gauntletLength && b.cuffFlare > a.cuffFlare && b.knuckleStuds >= a.knuckleStuds, `${tag}: gloves grow`);
          if (a.slot === 'trinket' && b.slot === 'trinket') assert(b.orbCount > a.orbCount && b.coreSize > a.coreSize && b.orbitRadius > a.orbitRadius, `${tag}: trinket grows`);
          assert(countMeshes(model) >= countMeshes(prev), `${tag}: never fewer parts when growing`);
          prev.dispose();
        }
        if (slot === 'gloves') {
          const vm = buildGloveViewmodel(def, stubMaterials);
          vm.animate(1.2);
          assert(countMeshes(vm) >= 4, `${tag}: glove viewmodel`);
          vm.dispose();
        }
      } catch (err) {
        failures.push(`${tag}: threw ${(err as Error).stack ?? err}`);
      }
      prev = model;
    }
    prev?.dispose();
  }
}

// ---------------------------------------------------------------------------
// 5. Weapon viewmodel growth
// ---------------------------------------------------------------------------
{
  const mkGun = () => {
    const gun = new THREE.Group();
    const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.24, 8);
    barrelGeo.rotateX(Math.PI / 2);
    const barrel = new THREE.Mesh(barrelGeo);
    barrel.position.set(0, 0.06, -0.5);
    barrel.userData.vmRole = 'barrel';
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.17, 0.08));
    mag.position.set(0, -0.09, -0.13);
    mag.userData.vmRole = 'mag';
    gun.add(barrel, mag);
    return { gun, barrel, mag };
  };
  const mats = { dark: new THREE.MeshToonMaterial(), seam: new THREE.MeshBasicMaterial() };
  const w = (level: number, rarity: Rarity): WeaponDef => ({
    id: 'w', name: 'x', archetype: 'rifle', rarity, element: 'none', level, damage: 1, fireRate: 1, auto: true,
    magSize: 30, reloadTime: 1, pellets: 1, spread: 0, accuracy: 100, zoom: 1.45, adsSpread: 0.5, range: 1, critMultiplier: 1, elementChance: 0, perks: [], color: 0x888888,
  });
  const muzzle = new THREE.Vector3(0, 0.06, -0.63);
  const a = mkGun();
  const m0 = applyWeaponGrowth(a.gun, w(1, 'common'), mats, muzzle);
  assert(m0.equals(muzzle) && a.gun.children.length === 2, 'level-1 common weapon unchanged');
  const b = mkGun();
  const p = weaponGrowthParams(w(20, 'legendary'));
  const m1 = applyWeaponGrowth(b.gun, w(20, 'legendary'), mats, muzzle);
  assert(p.growth > 0.9 && p.fins === 5 && p.brakeStages === 4 && p.magExtension, `L20 legendary params ${JSON.stringify(p)}`);
  assert(m1.z < muzzle.z - 0.1, 'muzzle moved forward');
  assert(near(b.barrel.position.z - 0.12 * p.barrelScale, -0.62 - 0.24 * (p.barrelScale - 1), 1e-6), 'barrel grows forward from its rear');
  assert(near(b.mag.position.y + 0.085 * p.magScale, -0.005, 1e-6), 'mag grows down from its top');
  assert(b.gun.children.length === 2 + p.fins + p.brakeStages + 1, 'fins + brake + mag extension added');

  // chained barrels (SMG shroud -> tip) + a muzzle part + a tilted mag with an end band
  const cylZ = (r: number, len: number) => {
    const g = new THREE.CylinderGeometry(r, r, len, 8);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const gun = new THREE.Group();
  const shroud = new THREE.Mesh(cylZ(0.026, 0.14));
  shroud.position.set(0, 0.05, -0.36);
  shroud.userData.vmRole = 'barrel';
  const tip = new THREE.Mesh(cylZ(0.014, 0.06));
  tip.position.set(0, 0.05, -0.46);
  tip.userData.vmRole = 'barrel';
  const brake = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02));
  brake.position.set(0, 0.05, -0.49);
  brake.userData.vmRole = 'muzzle';
  const smgMag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.26, 0.06));
  smgMag.position.set(0, -0.13, -0.17);
  smgMag.rotation.x = 0.12;
  smgMag.userData.vmRole = 'mag';
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.022, 0.066));
  band.position.set(0, -0.22, -0.18);
  band.userData.vmRole = 'magEnd';
  gun.add(shroud, tip, brake, smgMag, band);
  const ws: WeaponDef = { ...w(20, 'epic'), archetype: 'smg' };
  const ps = weaponGrowthParams(ws);
  const bandBefore = band.position.clone();
  const mz = applyWeaponGrowth(gun, ws, mats, new THREE.Vector3(0, 0.05, -0.5));
  const shroudFront = shroud.position.z - 0.07 * ps.barrelScale;
  const tipRear = tip.position.z + 0.03 * ps.barrelScale;
  assert(near(shroudFront, tipRear, 1e-6), `chained tip starts at shroud front (${shroudFront} vs ${tipRear})`);
  const tipFront = tip.position.z - 0.03 * ps.barrelScale;
  assert(near(brake.position.z, tipFront, 1e-6), 'muzzle part follows the tip');
  assert(mz.z < tipFront, 'muzzle in front of the tip');
  assert(band.position.y < bandBefore.y - 0.1 && band.position.z < bandBefore.z, 'mag end band moves down the tilted mag axis');
}

// ---------------------------------------------------------------------------
// 6. Runtime facade (createGearSystem) with a minimal context
// ---------------------------------------------------------------------------
{
  const events = new EventBus();
  const messages: string[] = [];
  events.on('ui:message', (m) => void messages.push(m.text));
  let changed = 0;
  (events as unknown as { on(n: string, f: () => void): void }).on('gear:changed', () => void changed++);
  const ctx = {
    events, rng: createRng(9), nextId, isHost: true, player: { id: 'p1' },
  } as unknown as GameContext;
  const sys = createGearSystem(ctx, { persist: false });
  const piece = sys.generate(8, { slot: 'boots', rarity: 'epic' });
  assert(sys.canPickUp(piece), 'facade canPickUp');
  const lootItem = { id: 'loot1', kind: 'gear', rarity: piece.rarity, position: { x: 0, y: 0, z: 0 }, ownerId: 'p1', gear: piece, age: 0 };
  events.emit('loot:pickup', { playerId: 'p1', item: lootItem as unknown as LootItemState });
  assert(sys.inventory.equipped('boots')?.id === piece.id && changed === 1 && messages.length === 1, 'loot:pickup gear -> equipped + gear:changed + message');
  const merged = sys.mergedStats({ damageMult: 2, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1 });
  assert(near(merged.moveSpeedMult, sys.gearStats.stats.moveSpeedMult) && merged.moveSpeedMult > 1 && merged.damageMult >= 2, 'facade mergedStats');
  assert(sys.maxGrenades(4) === 4 + sys.gearStats.extraGrenades, 'facade maxGrenades');
  events.emit('loot:pickup', { playerId: 'p2', item: { ...lootItem, gear: sys.generate(3) } as unknown as LootItemState });
  assert(sys.inventory.backpack.length === 0, 'other players\' pickups ignored');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const fmt = (v: number) => (Math.abs(v) >= 1 ? v.toFixed(0) : `${(v * 100).toFixed(1)}%`);
console.log(`gear smoke: ${checks} checks, ${failures.length} failures`);
console.log(`  200 pieces: levels ${minLevel}..${maxLevel}, rarity ${JSON.stringify(byRarity)}, sets ${setCount}, elemental ${elemCount}`);
console.log(`  stat ranges seen: ${Object.entries(statRange).map(([k, [lo, hi]]) => `${k} ${fmt(lo)}..${fmt(hi)}`).join(', ')}`);
console.log(`  meshes per model (g0/g.5/g1): ${Object.entries(meshCounts).filter(([k]) => k.endsWith('/common') || k.endsWith('/legendary')).map(([k, v]) => `${k} ${v.join('/')}`).join(', ')}`);
console.log(`  sample names: ${pieces.filter((_, i) => i % 23 === 0).map((d) => d.name).join(' | ')}`);
if (failures.length) {
  for (const f of failures.slice(0, 40)) console.error('  FAIL ' + f);
  throw new Error(`gear smoke failed: ${failures.length} failures`);
}
export {};
