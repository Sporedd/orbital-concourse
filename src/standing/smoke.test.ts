/**
 * Headless smoke test for system I (ranks, standing, hype, sponsors). No DOM, no WebGL.
 *
 *   npx tsx src/standing/smoke.test.ts
 * or, without tsx installed (esbuild ships with Vite and honours the tsconfig '@/' paths):
 *   npx esbuild src/standing/smoke.test.ts --bundle --platform=node --format=esm --outfile=%TEMP%/standing-smoke.mjs && node %TEMP%/standing-smoke.mjs
 *
 * Throws (non-zero exit) on the first summary with failures.
 */
import * as THREE from 'three';
import { EventBus } from '@/core/events';
import { createRng } from '@/core/rng';
import type { Enemy, GameContext, RoundPhase } from '@/core/types';
import {
  HYPE, LEAGUES, RANKS, SPONSORS, FREE_AGENT, composeModifiers, createStandingSystem, modifiers,
  onStanding, progressToNext, rankForStanding, rankThreshold, scaleEnemyCount, scaleLootCount, clampBoost,
  type KeyValueStore, type StandingEvents,
} from './index';

let failures = 0;
let passes = 0;
function check(cond: unknown, msg: string): void {
  if (cond) passes++;
  else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
function section(name: string): void {
  console.log(`\n== ${name}`);
}

// ---------------------------------------------------------------------------
// Fake context
// ---------------------------------------------------------------------------
function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

interface Harness {
  ctx: GameContext;
  rounds: { phase: RoundPhase; round: number };
  player: { id: string; position: THREE.Vector3; yaw: number; health: number; maxHealth: number; alive: boolean };
  drops: { position: THREE.Vector3; opts: unknown }[];
  messages: string[];
  log: { name: keyof StandingEvents; payload: unknown }[];
}

function makeHarness(): Harness {
  const events = new EventBus();
  const rounds = { phase: 'wave' as RoundPhase, round: 3 };
  const player = { id: 'p1', position: new THREE.Vector3(0, 0, 0), yaw: 0, health: 100, maxHealth: 100, alive: true };
  const drops: Harness['drops'] = [];
  const messages: string[] = [];
  const ctx = {
    events,
    rng: createRng(1234),
    isHost: true,
    time: { delta: 0, elapsed: 0 },
    nextId: (p: string) => `${p}_x`,
    player,
    players: { local: player, list: () => [player] },
    world: { groundHeight: () => 0 },
    rounds: { state: rounds },
    loot: {
      dropLoot: (position: THREE.Vector3, opts: unknown) => {
        drops.push({ position: position.clone(), opts });
        return [];
      },
    },
  } as unknown as GameContext;
  const log: Harness['log'] = [];
  const names: (keyof StandingEvents)[] = [
    'standing:gained', 'standing:rank', 'hype:changed', 'hype:reaction', 'hype:gift', 'hype:boo', 'sponsor:chosen',
  ];
  for (const n of names) onStanding(events, n, (payload) => log.push({ name: n, payload }));
  events.on('ui:message', (m) => messages.push(m.text));
  return { ctx, rounds, player, drops, messages, log };
}

let enemySeq = 0;
function kill(h: Harness, o: { crit?: boolean; boss?: boolean; tier?: number } = {}): void {
  const id = `e${++enemySeq}`;
  const enemy = { id, isBoss: !!o.boss } as unknown as Enemy;
  const point = new THREE.Vector3();
  h.ctx.events.emit('damage:dealt', { enemyId: id, playerId: 'p1', amount: 50, crit: !!o.crit, element: 'none', point, killed: true });
  h.ctx.events.emit('enemy:killed', { enemy, position: point, isBoss: !!o.boss, tier: o.tier ?? 1, killerId: 'p1' });
}
function hit(h: Harness): void {
  h.ctx.events.emit('damage:dealt', { enemyId: 'x', playerId: 'p1', amount: 5, crit: false, element: 'none', point: new THREE.Vector3(), killed: false });
}
const count = (h: Harness, n: keyof StandingEvents) => h.log.filter((e) => e.name === n).length;

// ---------------------------------------------------------------------------
section('ranks');
check(RANKS.length === 25, '25 ranks');
check(LEAGUES.length === 5, '5 leagues');
check(RANKS[0].threshold === 0 && RANKS[0].name === 'Fodder', 'rank 0 Fodder is free');
for (let i = 1; i < RANKS.length; i++) {
  check(RANKS[i].threshold > RANKS[i - 1].threshold, `threshold monotone at ${i}`);
  check(RANKS[i].threshold === rankThreshold(i), `threshold formula at ${i}`);
}
check(RANKS[24].name === 'Eternal' && RANKS[24].league === 'void', 'rank 24 is Void Eternal');
check(RANKS.filter((r) => r.league === 'steel').map((r) => r.name).join() === 'Veteran,Duelist,Gladiator,Warlord,Champion', 'steel names');
for (const r of RANKS) {
  check(rankForStanding(r.threshold).index === r.index, `boundary at ${r.name}`);
  if (r.index > 0) check(rankForStanding(r.threshold - 1).index === r.index - 1, `just below ${r.name}`);
}
check(rankForStanding(-5).index === 0 && rankForStanding(NaN).index === 0, 'negative/NaN → Fodder');
check(rankForStanding(1e9).index === 24, 'huge → Eternal');
{
  const p = progressToNext(RANKS[3].threshold + 10);
  const span = RANKS[4].threshold - RANKS[3].threshold;
  check(p.rank.index === 3 && p.next?.index === 4 && p.into === 10 && near(p.fraction, 10 / span), 'progressToNext mid');
  check(p.remaining === RANKS[4].threshold - (RANKS[3].threshold + 10), 'progressToNext remaining');
  const max = progressToNext(1e9);
  check(max.next === null && max.fraction === 1 && max.remaining === 0, 'progressToNext at max');
}
console.log('  idx  rank        league  threshold');
for (const r of RANKS) console.log(`  ${String(r.index).padStart(3)}  ${r.name.padEnd(10)}  ${r.league.padEnd(6)}  ${r.threshold}`);

// ---------------------------------------------------------------------------
section('hype: decay, damage, hysteresis');
{
  const h = makeHarness();
  const sys = createStandingSystem(h.ctx, { storage: memStore() });
  const hy = sys.hype;
  check(hy.value === HYPE.start && hy.tier === 'cold', 'starts at 10 cold');
  hit(h);
  sys.update(1);
  check(near(hy.value, 8), `decay 2/s (got ${hy.value})`);
  // idle: 5 s grace then +3/s
  hy.add(50, 'kill');
  hit(h);
  const v0 = hy.value;
  for (let i = 0; i < 70; i++) sys.update(0.1); // 7 s: 5 s at 2/s + 2 s at 5/s = 20
  check(near(hy.value, v0 - 20, 1e-6), `idle decay (got ${(v0 - hy.value).toFixed(3)} lost, want 20)`);
  // inactive phases decay at half rate, no idle penalty
  h.rounds.phase = 'intermission';
  const v1 = hy.value;
  for (let i = 0; i < 100; i++) sys.update(0.1);
  check(near(hy.value, v1 - 10, 1e-6), `intermission half decay (lost ${(v1 - hy.value).toFixed(3)})`);
  h.rounds.phase = 'wave';
  // damage taken: 12 % of amount, clamped 1..6
  const v2 = hy.value;
  h.ctx.events.emit('player:damaged', { playerId: 'p1', amount: 20, health: 80, shield: 0, element: 'none' });
  check(near(hy.value, v2 - 2.4), 'damage −2.4 for 20 dmg');
  h.ctx.events.emit('player:damaged', { playerId: 'p1', amount: 500, health: 80, shield: 0, element: 'none' });
  check(near(hy.value, v2 - 2.4 - 6), 'damage loss capped at 6');
  h.ctx.events.emit('player:damaged', { playerId: 'p2', amount: 50, health: 80, shield: 0, element: 'none' });
  check(near(hy.value, v2 - 8.4), 'remote player damage ignored');
  // hysteresis around 25
  hy.add(26 - hy.value, 'kill');
  check(hy.tier === 'warm', 'warm at 26');
  hy.add(-2, 'kill');
  check(hy.tier === 'warm', 'still warm at 24 (hysteresis)');
  hy.add(-1.5, 'kill');
  check(hy.tier === 'cold', 'cold at 22.5');
  hy.add(-500, 'kill');
  check(hy.value === 0, 'clamped at 0');
  hy.add(500, 'kill');
  check(hy.value === 100 && hy.tier === 'roaring', 'clamped at 100, roaring');
}

section('hype: style gains from an event stream');
{
  const h = makeHarness();
  const sys = createStandingSystem(h.ctx, { storage: memStore() });
  const hy = sys.hype;
  // triple kill inside 2 s: 1 + 1 + (1 + 8) = 11
  const v0 = hy.value;
  kill(h); sys.update(0.3);
  kill(h); sys.update(0.3);
  kill(h);
  const decay = 0.6 * HYPE.decayPerSec;
  check(near(hy.value, v0 + 11 - decay, 1e-6), `triple kill (got +${(hy.value - v0 + decay).toFixed(2)})`);
  const labels = h.log.filter((e) => e.name === 'hype:reaction').map((e) => (e.payload as { label: string }).label);
  check(labels.includes('TRIPLE KILL'), 'TRIPLE KILL reaction');
  // 4th kill inside window: +1 +3
  let v = hy.value;
  kill(h);
  check(near(hy.value, v + 4), 'chain extra +3');
  // break chain
  sys.update(2.5);
  v = hy.value;
  kill(h, { crit: true });
  check(near(hy.value, v + 1 + HYPE.gain.critKill), 'crit kill +5');
  // airborne + comeback
  sys.update(2.5);
  h.player.position.y = 2;
  h.player.health = 20;
  v = hy.value;
  kill(h);
  check(near(hy.value, v + 1 + HYPE.gain.airborneKill + HYPE.gain.comebackKill), 'airborne + comeback kill');
  h.player.position.y = 0;
  h.player.health = 100;
  // melee: kill resolves, then player:melee in the same frame
  sys.update(2.5);
  v = hy.value;
  kill(h);
  h.ctx.events.emit('player:melee', { playerId: 'p1', hit: true });
  check(near(hy.value, v + 1 + HYPE.gain.meleeKill), 'melee finish +8');
  sys.update(0.1);
  v = hy.value;
  h.ctx.events.emit('player:melee', { playerId: 'p1', hit: true });
  check(near(hy.value, v), 'melee without a kill: nothing');
  // crit hits, rate-limited
  v = hy.value;
  for (let i = 0; i < 5; i++) h.ctx.events.emit('damage:dealt', { enemyId: 'z', playerId: 'p1', amount: 5, crit: true, element: 'none', point: new THREE.Vector3(), killed: false });
  check(near(hy.value, v + HYPE.gain.critHit), 'crit hits rate-limited to one per 0.2 s');
  // boss phase + boss kill
  v = hy.value;
  h.ctx.events.emit('boss:phase', { enemyId: 'b', phase: 1 });
  check(near(hy.value, v + HYPE.gain.bossPhase), 'boss phase +10');
  // flawless sub-wave
  h.ctx.events.emit('round:subwave', { round: 3, subWave: 1, total: 3 });
  kill(h); sys.update(2.5);
  v = hy.value;
  h.ctx.events.emit('round:subwave', { round: 3, subWave: 2, total: 3 });
  check(near(hy.value, v + HYPE.gain.flawlessSubwave), 'flawless sub-wave +15');
  kill(h); sys.update(2.5);
  h.ctx.events.emit('player:damaged', { playerId: 'p1', amount: 10, health: 90, shield: 0, element: 'none' });
  v = hy.value;
  h.ctx.events.emit('round:boss', { round: 3, bossKind: 'brute' });
  check(near(hy.value, v), 'damaged sub-wave: no flawless bonus');
}

section('hype: tiers, modifiers, events, gifts, boos');
{
  const h = makeHarness();
  const sys = createStandingSystem(h.ctx, { storage: memStore() });
  const hy = sys.hype;
  const tiers: string[] = [];
  onStanding(h.ctx.events, 'hype:changed', (e) => { if (e.tierChanged) tiers.push(e.tier); });
  hy.add(20, 'kill'); hy.add(30, 'kill'); hy.add(30, 'kill');
  check(tiers.join() === 'warm,hot,roaring', `tier sequence (${tiers.join()})`);
  check(h.messages.includes('The crowd is roaring!'), 'roaring message');
  check(sys.hype.modifiers.rarityBoost === 0.5 && sys.hype.modifiers.xpMult === 1.5, 'roaring modifiers 0.5 / ×1.5');
  check(sys.standing.history.some((g) => g.label === 'Crowd roaring'), 'roaring milestone awarded standing');
  // periodic hype:changed while value changes: 2 s at dt 0.1 → 4 events
  const before = count(h, 'hype:changed');
  for (let i = 0; i < 20; i++) { hit(h); sys.update(0.1); }
  check(count(h, 'hype:changed') - before === 4, `hype:changed every 0.5 s (${count(h, 'hype:changed') - before})`);
  // stay ROARING for 100 s (pump hype), expect 4 gifts
  for (let i = 0; i < 1000; i++) {
    hit(h);
    if (hy.value < 95) hy.add(100 - hy.value, 'kill');
    sys.update(0.1);
  }
  const gifts = h.log.filter((e) => e.name === 'hype:gift').map((e) => (e.payload as { kind: string }).kind);
  check(gifts.length === 4, `4 gifts in 100 s ROARING (${gifts.join()})`);
  const crates = gifts.filter((k) => k === 'crate').length;
  check(h.drops.length === crates, 'every crate gift dropped loot via ctx.loot.dropLoot');
  if (h.drops.length) {
    const o = h.drops[0].opts as { ownerId: string; tier: number; rarityBoost: number };
    check(o.ownerId === 'p1' && o.tier === 3 && o.rarityBoost === HYPE.crateRarityBoost, 'crate drop opts (owner, tier, base boost)');
    check(near(h.drops[0].position.z, -3), 'crate lands 3 m in front of the player');
  }
  // buff: force one and check the 10 s window
  let tries = 0;
  while (!gifts.includes('buff') && tries++ < 40) {
    for (let i = 0; i < 250; i++) { hit(h); hy.add(100 - hy.value, 'kill'); sys.update(0.1); }
    gifts.push(...h.log.filter((e) => e.name === 'hype:gift').slice(gifts.length).map((e) => (e.payload as { kind: string }).kind));
  }
  check(gifts.includes('buff'), 'a buff gift eventually rolls');
  {
    // fresh buff check on its own harness: set timer via a gift at exactly 25 s
    const h2 = makeHarness();
    h2.ctx.rng = () => 0.6; // crate 0.5, buff 0.35 → 0.6 lands in buff
    const s2 = createStandingSystem(h2.ctx, { storage: memStore() });
    s2.hype.add(90, 'kill');
    for (let i = 0; i < 250; i++) { hit(h2); s2.hype.add(100 - s2.hype.value, 'kill'); s2.update(0.1); }
    check(s2.hype.modifiers.damageMult === 1.3 && s2.hype.modifiers.buffRemaining > 9.8, 'buff active ×1.3 for 10 s');
    check(near(s2.damageMult(), 1.3), 'system damageMult includes buff');
    for (let i = 0; i < 101; i++) { hit(h2); s2.hype.add(100 - s2.hype.value, 'kill'); s2.update(0.1); }
    check(s2.hype.modifiers.damageMult === 1, 'buff expired after 10 s');
  }
  {
    // bonus wave only during 'wave'
    const h3 = makeHarness();
    h3.ctx.rng = () => 0.99;
    const s3 = createStandingSystem(h3.ctx, { storage: memStore() });
    s3.hype.add(90, 'kill');
    for (let i = 0; i < 250; i++) { hit(h3); s3.hype.add(100 - s3.hype.value, 'kill'); s3.update(0.1); }
    const g = h3.log.find((e) => e.name === 'hype:gift')?.payload as { kind: string; mobs: number } | undefined;
    check(g?.kind === 'bonuswave' && g.mobs === 10, 'bonus wave suggestion with mobs = 4 + 2·round');
    h3.rounds.phase = 'boss';
    for (let i = 0; i < 250; i++) { hit(h3); s3.hype.add(100 - s3.hype.value, 'kill'); s3.update(0.1); }
    const last = h3.log.filter((e) => e.name === 'hype:gift').pop()?.payload as { kind: string };
    check(last.kind !== 'bonuswave', 'no bonus wave during boss');
  }
  // boos: drop to cold and sit there > 20 s
  hy.add(-200, 'kill');
  check(hy.tier === 'cold', 'back to cold');
  for (let i = 0; i < 205; i++) { hit(h); sys.update(0.1); }
  check(count(h, 'hype:boo') === 1, 'one boo after 20 s cold');
  check(near(hy.modifiers.rarityBoost, -0.1), 'boo rarity −0.1');
  check(near(sys.rarityBoost(), -0.1) && sys.dropBoost(0) === 0 && near(sys.dropBoost(0.5), 0.4), 'combined boost clamps at drop site');
  for (let i = 0; i < 300; i++) { hit(h); sys.update(0.1); }
  check(count(h, 'hype:boo') === 1, 'boo once per cold stretch');
  hy.add(30, 'kill');
  check(!hy.modifiers.booing && hy.modifiers.rarityBoost === 0.1, 'booing ends when warm');
  // reset on a new run
  h.ctx.events.emit('game:started', {});
  check(hy.value === HYPE.start && hy.tier === 'cold' && hy.modifiers.damageMult === 1, 'reset on game:started');
}

// ---------------------------------------------------------------------------
section('standing');
{
  const store = memStore();
  const h = makeHarness();
  const sys = createStandingSystem(h.ctx, { storage: store, leagueLoot: false });
  const st = sys.standing;
  check(st.standing === 0 && st.rank.name === 'Fodder' && st.accentColor === 0xff5f1f, 'fresh: 0, Fodder, scrap accent');
  h.ctx.events.emit('round:cleared', { round: 3 });
  check(st.standing === 85, `round 3 cleared = 85 (${st.standing})`);
  kill(h, { boss: true, tier: 2 });
  check(st.standing === 185, `boss tier 2 = +100 (${st.standing})`);
  const ranks0 = count(h, 'standing:rank');
  h.ctx.events.emit('round:cleared', { round: 5 }); // +115 → 300 ≥ 250 → Deckhand
  check(st.rank.name === 'Deckhand' && count(h, 'standing:rank') === ranks0 + 1, 'rank-up event to Deckhand');
  h.ctx.events.emit('game:over', { round: 4, kills: 10 });
  h.ctx.events.emit('game:over', { round: 4, kills: 10 });
  check(st.standing === 320, `consolation 5·round once per run (${st.standing})`);
  check(st.lifetime.runs === 1 && st.lifetime.roundsCleared === 2 && st.lifetime.bossesKilled === 1, 'lifetime stats');
  // sponsor multiplier
  check(sys.sponsors.choose('double_trouble'), 'choose scrap contract');
  h.ctx.events.emit('game:started', {});
  h.ctx.events.emit('round:cleared', { round: 1 }); // 55 × 1.3 = 71.5 → 72
  check(st.standing === 392, `standingMult ×1.3 (${st.standing})`);
  const gained = h.log.filter((e) => e.name === 'standing:gained');
  check(gained.length >= 5 && (gained[gained.length - 1].payload as { amount: number }).amount === 72, 'standing:gained payload');
  // persistence
  const h2 = makeHarness();
  const sys2 = createStandingSystem(h2.ctx, { storage: store });
  check(sys2.standing.standing === 392 && sys2.standing.rank.name === 'Deckhand', 'standing persisted');
  check(sys2.sponsors.contract.id === 'double_trouble', 'last sponsor persisted');
  // league promotion
  sys2.standing.award(RANKS[5].threshold - 392, 'debug', 'debug', true);
  const promo = h2.log.find((e) => e.name === 'standing:rank')?.payload as { leagueUp: boolean; rank: { name: string } };
  check(promo?.leagueUp && promo.rank.name === 'Rookie', 'league-up to Iron Rookie');
  check(sys2.standing.accentColor === 0xffc61a, 'iron accent');
}

// ---------------------------------------------------------------------------
section('sponsors');
{
  check(SPONSORS.length === 8, '8 contracts');
  check(new Set(SPONSORS.map((s) => s.id)).size === 8, 'unique ids');
  for (const s of SPONSORS) {
    check(s.perks.length > 0 && s.drawbacks.length > 0, `${s.id} has a trade-off`);
    check(s.unlockLeague >= 0 && s.unlockLeague <= 4, `${s.id} unlock league`);
  }
  const neutral = composeModifiers();
  check(neutral.enemyCountMult === 1 && neutral.lootRarityBoost === 0 && !neutral.noShield, 'neutral compose');
  const a = modifiers({ enemyCountMult: 2, lootRarityBoost: 0.1, elementsOnly: 'fire', standingMult: 1.5 });
  const b = { enemyCountMult: 1.5, lootRarityBoost: 0.2, elementsOnly: 'ice' as const, noShield: true, standingMult: 2 };
  const c = composeModifiers(a, b);
  check(c.enemyCountMult === 3 && near(c.lootRarityBoost, 0.3) && c.standingMult === 3, 'mults multiply, boosts add');
  check(c.elementsOnly === 'fire' && c.noShield === true && !c.grenadeless, 'first element wins, flags OR');
  check(scaleEnemyCount(44, c) === 132 && scaleEnemyCount(1, modifiers({ enemyCountMult: 0.1 })) === 1, 'scaleEnemyCount');
  check(scaleLootCount(3, modifiers({ lootCountMult: 2 })) === 6 && scaleLootCount(1, modifiers({ lootCountMult: 0.4 }), 1) === 1, 'scaleLootCount');
  check(clampBoost(0.8, 0.5) === 1 && clampBoost(0, -0.1) === 0, 'clampBoost');

  const h = makeHarness();
  const sys = createStandingSystem(h.ctx, { storage: memStore() });
  const sp = sys.sponsors;
  check(sp.contract.id === FREE_AGENT.id, 'default Free Agent');
  const ref = sp.active;
  check(!sp.choose('blood_sport'), 'void contract locked at Scrap');
  check(sp.list().filter((e) => e.unlocked).length === 3, 'Scrap unlocks Free Agent + 2');
  check(sp.choose('safety_first') && sp.active === ref && sp.active.standingMult === 0.7, 'choose keeps live object');
  h.ctx.events.emit('game:started', {});
  check(sp.locked && !sp.choose('double_trouble'), 'locked during a run');
  h.ctx.events.emit('game:over', { round: 1, kills: 0 });
  sys.standing.award(RANKS[20].threshold, 'debug', 'debug', true);
  check(sp.choose('blood_sport'), 'void contract unlocked at Void');
  check(sp.active.noShield && sp.active.grenadeless && sp.active.standingMult === 2 && sp.active.elementsOnly === undefined, 'flags applied, stale flags cleared');
  check(sp.choose('pyre') && sp.active.elementsOnly === 'fire' && !sp.active.noShield, 'switching clears previous flags');
  check(near(sys.rarityBoost(), 0.1 + 0 + 0.12), `combined rarity sponsor + hype + league (${sys.rarityBoost()})`);
  check(count(h, 'sponsor:chosen') === 3, 'sponsor:chosen events');
  console.log('  contracts:');
  for (const s of [FREE_AGENT, ...SPONSORS]) {
    console.log(`   [${LEAGUES[s.unlockLeague].name.split(' ')[0]}] ${s.name} — ${s.title}: + ${s.perks.join(', ') || '—'} | − ${s.drawbacks.join(', ') || '—'}`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) throw new Error(`standing smoke test: ${failures} failure(s)`);
