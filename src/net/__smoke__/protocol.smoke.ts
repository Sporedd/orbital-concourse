/**
 * Protocol unit checks (run: npx tsx src/net/__smoke__/protocol.smoke.ts).
 * encode/decode round trip, quantisation, enemy delta compression, weapon stats, interpolation.
 */
import assert from 'node:assert/strict';
import {
  applyEnemyDelta, dec, decode, diffEnemy, enc, encode, q2, qv, readWeaponStats, sanitizeWeapon, weaponStatsW,
  type ClientTickMsg, type EnemyW, type SnapMsg,
} from '../protocol';
import { ClockSync, SampleBuffer, makeSample } from '../interp';
import { cleanName, isValidCode, normalizeCode } from '../relayProtocol';
import type { WeaponDef } from '@/core/types';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const weapon: WeaponDef = {
  id: 'w1', name: 'Molten Jakko Ripper', archetype: 'shotgun', rarity: 'epic', element: 'fire', level: 3,
  damage: 14.256, fireRate: 1.5, auto: false, magSize: 6, reloadTime: 2.1, pellets: 8, spread: 0.09123, accuracy: 45, zoom: 1.1, adsSpread: 0.8,
  range: 30.04, critMultiplier: 2, elementChance: 0.25, perks: [{ id: 'splash', name: 'Splash', description: '' }], color: 0xff5a1f,
};

const enemy: EnemyW = {
  i: 'mob_1', k: enc.kind('spitter'), b: 0, t: 2, p: qv({ x: 1.23456, y: 0, z: -7.891 }), y: q2(1.5708),
  h: 44.5, m: 56, a: 1, ph: 0, an: 'walk', s: [[enc.element('fire'), 3.2]], fz: 0, sh: 0,
};

console.log('protocol');

test('quantise to 2 decimals', () => {
  assert.equal(q2(1.23456), 1.23);
  assert.equal(q2(-0.004), 0);
  assert.ok(!Object.is(q2(-0.001), -0));
  assert.equal(q2(Number.NaN), 0);
  assert.deepEqual(qv({ x: 1.005, y: 2.999, z: -3.14159 }), [1, 3, -3.14]);
});

test('enum tables round trip', () => {
  for (const k of ['grunt', 'spitter', 'bomber', 'brute', 'summoner', 'artillery'] as const) assert.equal(dec.kind(enc.kind(k)), k);
  for (const p of ['idle', 'intermission', 'wave', 'boss', 'cleared', 'gameover'] as const) assert.equal(dec.phase(enc.phase(p)), p);
  assert.equal(dec.boss(enc.boss(undefined)), undefined);
  assert.equal(dec.boss(enc.boss('artillery')), 'artillery');
  assert.equal(dec.element(99), 'none'); // out of range falls back to the first entry
});

test('snapshot encode/decode round trip', () => {
  const snap: SnapMsg = {
    t: 's', n: 7, tm: 123.45, r: [3, enc.phase('wave'), 12.3, 44, 10, 2, 61, -1],
    e: [enemy, { i: 'mob_2', h: 10 }], x: ['mob_0'],
    pr: { s: [['proj_1', 0, 1, 2, 3, 4, 5, 6]], m: [['shell_1', 0, 0, 0, 5, 0, 5, 0.3, 1.2, 9, 3.5]] },
    pl: [{ i: 'p1', n: 'Host', p: [0, 0, 0], y: 0, pt: 0, h: 100, mh: 100, s: 80, ms: 80, a: 1, w: [enc.arch('rifle'), 0xff00ff, 2] }],
    la: [{ i: 'loot_1', k: enc.loot('weapon'), r: enc.rarity('epic'), p: [1, 0, 1], ag: 0, w: weapon }],
    lr: ['loot_0'],
    fx: [['t', 0, 1, 2, 3, 4, 5, 0xffffff, 0], ['x', 1, 1, 1, 4, 0xff8a2a]],
    ev: [{ e: 'ek', i: 'mob_0', p: [1, 0, 2], b: 0, t: 3, k: 'p1' }, { e: 'ui', tx: 'hi', d: 2, st: 'info' }],
  };
  const wire = encode(snap);
  const back = decode(wire);
  assert.deepEqual(back, snap);
  // decode also accepts an already-parsed object
  assert.deepEqual(decode(JSON.parse(wire)), snap);
});

test('client tick round trip with fire + hit claims', () => {
  const tick: ClientTickMsg = {
    t: 'c', n: 1, tm: 5, p: [1, 0, 2], v: [0, 0, 0], y: 0.5, pt: -0.1, g: 1, u: 0, a: 1, mh: 100, ms: 80,
    w: [enc.arch('shotgun'), weapon.color, enc.rarity('epic')],
    f: [{ o: [1, 1.65, 2], d: [0, 0, -1], w: weaponStatsW(weapon), m: [1.16, 1], sm: 0.7, h: [['mob_1', 0.1, 1.2, 0.2, 0, 14.3, 1, 1, 1.1, 1.2, -8]] }],
    ao: [[1, 0, 1, 5, 120, 0]], pk: ['loot_1'], hl: 2.5, sd: [[10, 0]],
  };
  assert.deepEqual(decode(encode(tick)), tick);
});

test('decode rejects junk', () => {
  assert.equal(decode('not json'), null);
  assert.equal(decode('{"t":"zzz"}'), null);
  assert.equal(decode({ t: 's' }), null);
  assert.equal(decode({ t: 'c', p: [1, 2] }), null);
  assert.equal(decode(42), null);
});

test('enemy delta: only changed fields, apply reproduces state', () => {
  assert.equal(diffEnemy(enemy, { ...enemy }), null);
  const next: EnemyW = { ...enemy, p: [1.3, 0, -7.5], h: 30, s: [] };
  const d = diffEnemy(enemy, next)!;
  assert.deepEqual(Object.keys(d).sort(), ['h', 'i', 'p', 's']);
  assert.deepEqual(applyEnemyDelta(enemy, d), next);
  // full record when there is no baseline
  assert.deepEqual(diffEnemy(undefined, next), next);
  assert.deepEqual(applyEnemyDelta(undefined, next), next);
  // a delta is much smaller than the full record
  assert.ok(encode({ t: 's', n: 1, tm: 0, r: [0, 0, 0, 0, 0, 0, 0, -1], pl: [], e: [d] }).length < encode({ t: 's', n: 1, tm: 0, r: [0, 0, 0, 0, 0, 0, 0, -1], pl: [], e: [next] }).length);
});

test('weapon stats survive the wire and are clamped', () => {
  const s = readWeaponStats(weaponStatsW(weapon));
  assert.equal(s.archetype, 'shotgun');
  assert.equal(s.rarity, 'epic');
  assert.equal(s.element, 'fire');
  assert.equal(s.pellets, 8);
  assert.equal(s.damage, 14.26);
  assert.equal(s.range, 30);
  assert.equal(s.color, 0xff5a1f);
  const evil = readWeaponStats([0, 0, 0, 0, 1e9, 999, 5, -1, 99, 7, 0] as never);
  assert.equal(evil.damage, 100000);
  assert.equal(evil.pellets, 24);
  assert.equal(evil.spread, 0.6);
  assert.equal(evil.range, 1);
  assert.equal(evil.elementChance, 1);
  assert.equal(sanitizeWeapon({ id: 'x' }), null);
  assert.equal(sanitizeWeapon({ ...weapon, archetype: 'bazooka' }), null);
  assert.deepEqual(sanitizeWeapon(JSON.parse(JSON.stringify(weapon))), weapon);
});

test('join codes + names', () => {
  assert.equal(normalizeCode(' ab-cde '), 'ABCDE');
  assert.ok(isValidCode('ABCDE'));
  assert.ok(!isValidCode('ABCD'));
  assert.ok(!isValidCode('ABCDI')); // I is not in the alphabet
  assert.equal(cleanName('  <b>Zed</b>  '), 'bZed/b');
  assert.equal(cleanName(''), 'Gladiator');
  assert.equal(cleanName('x'.repeat(50)).length, 20);
});

test('sample buffer interpolates and extrapolates briefly', () => {
  const b = new SampleBuffer(8);
  b.push(1.0, 0, 0, 0, 0);
  b.push(1.05, 1, 0, 0, Math.PI - 0.1);
  b.push(1.1, 2, 0, 2, -Math.PI + 0.1); // wraps across ±π
  const s = makeSample();
  b.sample(1.025, s);
  assert.ok(Math.abs(s.x - 0.5) < 1e-9);
  b.sample(1.075, s);
  assert.ok(Math.abs(s.x - 1.5) < 1e-9 && Math.abs(s.z - 1) < 1e-9);
  assert.ok(Math.abs(Math.abs(s.yaw) - Math.PI) < 1e-6, `yaw took the short way (${s.yaw})`);
  b.sample(5, s); // far future: extrapolation capped at 0.1 s
  assert.ok(Math.abs(s.x - 4) < 1e-9, `extrapolated x ${s.x}`);
  b.sample(0, s); // before the first sample: clamp
  assert.equal(s.x, 0);
  b.push(1.05, 9, 9, 9, 0); // out of order: ignored
  b.sample(1.1, s);
  assert.equal(s.x, 2);
});

test('clock sync tracks the least-delayed packet', () => {
  const c = new ClockSync();
  c.observe(100, 1000.08); // 80 ms late
  c.observe(100.05, 1000.11); // 60 ms late → better
  c.observe(100.1, 1000.3); // jitter spike ignored
  assert.ok(Math.abs(c.senderNow(1000.2) - 100.14) < 1e-6);
  assert.ok(Math.abs(c.renderTime(0.1, 1000.2) - 100.04) < 1e-6);
});

console.log(`protocol: ${passed} checks passed`);
