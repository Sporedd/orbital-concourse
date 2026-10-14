import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/core/events';
import { createRng, pick, randInt, randRange } from '@/core/rng';

describe('EventBus', () => {
  it('delivers payloads to every handler of an event', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('round:cleared', a);
    bus.on('round:cleared', b);
    bus.emit('round:cleared', { round: 3 });
    expect(a).toHaveBeenCalledWith({ round: 3 });
    expect(b).toHaveBeenCalledWith({ round: 3 });
  });

  it('does not deliver other events and tolerates emits with no listeners', () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.on('round:cleared', h);
    bus.emit('round:boss', { round: 1, bossKind: 'brute' });
    bus.emit('game:started', {});
    expect(h).not.toHaveBeenCalled();
  });

  it('on() returns an unsubscribe function; off() removes a handler', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unA = bus.on('loot:expired', a);
    bus.on('loot:expired', b);
    unA();
    bus.off('loot:expired', b);
    bus.emit('loot:expired', { itemId: 'x' });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('once() fires a single time and can be cancelled before firing', () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.once('loot:expired', h);
    bus.emit('loot:expired', { itemId: '1' });
    bus.emit('loot:expired', { itemId: '2' });
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith({ itemId: '1' });

    const g = vi.fn();
    const off = bus.once('loot:expired', g);
    off();
    bus.emit('loot:expired', { itemId: '3' });
    expect(g).not.toHaveBeenCalled();
  });

  it('isolates a throwing handler: later handlers still run and the error is logged', () => {
    const bus = new EventBus();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.on('game:started', () => { throw new Error('boom'); });
    bus.on('game:started', after);
    expect(() => bus.emit('game:started', {})).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain('game:started');
  });

  it('handlers added during emit do not run in that same emit; removed ones still finish the snapshot', () => {
    const bus = new EventBus();
    const late = vi.fn();
    const second = vi.fn();
    bus.on('game:started', () => {
      bus.on('game:started', late);
      bus.off('game:started', second);
    });
    bus.on('game:started', second);
    bus.emit('game:started', {});
    expect(late).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1); // snapshot semantics
    bus.emit('game:started', {});
    expect(late).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('createRng', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sa = Array.from({ length: 50 }, () => a());
    const sb = Array.from({ length: 50 }, () => b());
    const sc = Array.from({ length: 50 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('produces values in [0,1) with a roughly uniform mean', () => {
    const r = createRng(7);
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const v = r();
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      sum += v;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(1);
    expect(sum / 20000).toBeGreaterThan(0.48);
    expect(sum / 20000).toBeLessThan(0.52);
  });

  it('treats seeds as uint32 (negative and >2^32 seeds are accepted)', () => {
    expect(createRng(-1)()).toBe(createRng(0xffffffff)());
    expect(Number.isFinite(createRng(Date.now() & 0xffffffff)())).toBe(true);
  });

  it('randRange / randInt / pick stay within bounds', () => {
    const r = createRng(99);
    const seen = new Set<number>();
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const f = randRange(r, -2, 3);
      if (!(f >= -2 && f < 3)) bad.push(`randRange ${f}`);
      const n = randInt(r, 3, 5);
      if (![3, 4, 5].includes(n)) bad.push(`randInt ${n}`);
      seen.add(n);
      if (!['a', 'b', 'c'].includes(pick(r, ['a', 'b', 'c'] as const))) bad.push('pick');
    }
    expect(bad).toEqual([]);
    expect(seen.size).toBe(3);
  });
});
