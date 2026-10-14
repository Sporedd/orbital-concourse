// @vitest-environment jsdom
/**
 * Integrated boot smoke test: the real systems wired exactly like src/main.ts, INCLUDING the
 * meta systems (standing + hype + sponsors, gear, co-op session offline), minus WebGL
 * (stub renderer, recording Fx, no setupRendering). Plays round 1 to the boss shower, checks
 * the boss guarantees a gear piece, picks it up, dies, retries with weapons + gear kept, and
 * checks the co-op pause policy (host menus do not freeze the shared sim).
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CAMERA, INTERMISSION_SECONDS } from '@/core/config';
import { EventBus } from '@/core/events';
import { Input } from '@/core/input';
import { createRng } from '@/core/rng';
import { WEAPONS_KEY, localPlayerId, simPaused } from '@/core/storage';
import type { GameContext, RoundPhase } from '@/core/types';
import { createMaterialFactory } from '@/rendering';
import { createWorld } from '@/world';
import { createPlayer, createPlayerRegistry } from '@/player';
import { getStats } from '@/player/shared';
import { createEnemyManager } from '@/enemies';
import { createLootSystem } from '@/loot';
import { createProgression } from '@/progression';
import { createStandingSystem } from '@/standing';
import { createGearSystem } from '@/gear';
import { createNetSession, type NetSession } from '@/net';
import { createRoundManager } from '@/rounds';
import { createHud } from '@/ui';
import { createAudio } from '@/audio';
import { createFakeFx, createFakeRenderer } from '../helpers/fakeContext';

function boot() {
  document.body.innerHTML = '<canvas id="app"></canvas><div id="ui"></div>';
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  let idCounter = 0;
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far),
    renderer: createFakeRenderer(canvas),
    canvas,
    uiRoot,
    input: new Input(canvas),
    events: new EventBus(),
    time: { delta: 0, elapsed: 0 },
    rng: createRng(0xc0ffee),
    isHost: true,
    nextId: (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`,
  } as GameContext;

  // ---- same order as main.ts ----
  ctx.materials = createMaterialFactory();
  ctx.fx = createFakeFx();
  ctx.audio = createAudio(ctx);
  ctx.world = createWorld(ctx);
  ctx.players = createPlayerRegistry();
  const localPlayer = createPlayer(ctx, { id: localPlayerId(), name: 'Challenger', persistKey: WEAPONS_KEY });
  ctx.players.add(localPlayer);
  ctx.player = localPlayer;
  ctx.enemies = createEnemyManager(ctx);
  ctx.loot = createLootSystem(ctx);
  ctx.progression = createProgression(ctx);
  ctx.standing = createStandingSystem(ctx);
  ctx.gear = createGearSystem(ctx);
  localPlayer.reset();
  const net = createNetSession(ctx, { avatars: false, url: 'ws://127.0.0.1:1' });
  ctx.net = net;
  ctx.hud = createHud(ctx);
  ctx.rounds = createRoundManager(ctx);

  /** Body of main.ts frame() minus the render pipeline. */
  const frame = (dt: number) => {
    ctx.time.delta = dt;
    ctx.time.elapsed += dt;
    ctx.hud.update(dt);
    const paused = simPaused(ctx.hud.screen, !!ctx.net?.inSession);
    ctx.net?.update(dt);
    ctx.world.update(dt);
    if (!paused) {
      localPlayer.update(dt);
      ctx.enemies.update(dt);
      ctx.loot.update(dt);
      ctx.rounds.update(dt);
      ctx.standing?.update(dt);
      ctx.fx.update(dt);
    }
    ctx.audio.update(dt);
    ctx.input.endFrame();
  };
  const play = () => {
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
  };
  return { ctx, frame, localPlayer, play };
}

/** Run frames, auto-killing every live enemy, until `done` (or a frame cap). */
function playUntil(b: ReturnType<typeof boot>, done: () => boolean, frames = 400) {
  for (let i = 0; i < frames && !done(); i++) {
    b.frame(0.2);
    for (const e of b.ctx.enemies.list()) if (e.alive) e.damage(1e6, { sourceId: b.ctx.player.id, point: e.position.clone(), cause: 'bullet' });
  }
}

describe('integrated boot (standing + gear + net wired like main.ts)', () => {
  it('wires the meta systems in boot order with a unique local player id', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, localPlayer } = boot();
    expect(localPlayer.id).toMatch(/^p-[a-z0-9]{8}$/);
    expect(localPlayerId()).toBe(localPlayer.id); // persisted
    expect(ctx.standing).toBeTruthy();
    expect(ctx.gear).toBeTruthy();
    expect(ctx.net?.role).toBe('offline');
    expect(ctx.net?.inSession).toBe(false);
    expect(ctx.standing!.sponsors.contract.id).toBe('free_agent');
    expect(localPlayer.loadout).toEqual({});
  });

  it('plays round 1 with standing + gear: boss drops a gear piece, walking over equips it, standing is earned', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const b = boot();
    const { ctx, localPlayer } = b;
    b.play();
    const phases: RoundPhase[] = [];
    ctx.events.on('round:phase', (e) => phases.push(e.phase));
    const hype: number[] = [];
    ctx.events.on('hype:changed', (e) => hype.push(e.value));

    playUntil(b, () => ctx.rounds.state.phase === 'cleared');
    expect(phases).toContain('boss');
    expect(ctx.rounds.state.phase).toBe('cleared');
    expect(ctx.standing!.standing.standing).toBeGreaterThan(0); // round + boss standing
    expect(hype.length).toBeGreaterThan(0);

    // the boss's guaranteed piece is at least Uncommon (mobs may also drop the odd common piece)
    const gearItem = ctx.loot.items().find((i) => i.kind === 'gear' && i.ownerId === localPlayer.id && i.rarity !== 'common');
    expect(gearItem?.gear).toBeTruthy();

    // walk onto it (teleport next to it) → walk-over pickup equips into the empty slot
    const slot = gearItem!.gear!.slot;
    const healthMultBefore = getStats(ctx).healthMult;
    localPlayer.position.set(gearItem!.position.x, gearItem!.position.y, gearItem!.position.z + 0.2);
    b.frame(1 / 60);
    expect(ctx.loot.items().some((i) => i.id === gearItem!.id)).toBe(false);
    expect(ctx.gear!.inventory.equipped(slot)?.id).toBe(gearItem!.gear!.id);
    expect(localPlayer.loadout[slot]?.id).toBe(gearItem!.gear!.id);
    expect(getStats(ctx)).not.toBe(ctx.progression.stats); // merged path
    expect(getStats(ctx).healthMult).toBeGreaterThanOrEqual(healthMultBefore);
  });

  it('death keeps weapons and gear; retry restarts at round 1 with full vitals from the merged stats', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const b = boot();
    const { ctx, localPlayer } = b;
    // a loadout from an earlier run
    const chest = ctx.gear!.generate(4, { slot: 'chest', rarity: 'epic', setId: null });
    ctx.gear!.inventory.pickUp(chest);
    const gun = ctx.loot.generateWeapon(4, 'rare');
    b.play();
    localPlayer.equip(gun);
    run(b, INTERMISSION_SECONDS + 1);
    expect(ctx.rounds.state.phase).toBe('wave');

    localPlayer.takeDamage(1e9);
    expect(ctx.rounds.state.phase).toBe('gameover');
    for (let i = 0; i < 30; i++) b.frame(0.1);
    expect(ctx.hud.screen).toBe('gameover');
    expect(ctx.standing!.sponsors.locked).toBe(false);

    // retry (what the game-over screen's click does)
    b.play();
    expect(ctx.rounds.state).toMatchObject({ round: 1, phase: 'intermission', totalKills: 0 });
    expect(localPlayer.alive).toBe(true);
    expect(localPlayer.weapons.some((w) => w?.id === gun.id)).toBe(true);
    expect(localPlayer.weapons.filter(Boolean)).toHaveLength(2); // starter + the rare: no extra starter added
    expect(ctx.gear!.inventory.equipped('chest')?.id).toBe(chest.id);
    const stats = getStats(ctx);
    expect(localPlayer.maxHealth).toBeCloseTo(100 * stats.healthMult, 5);
    expect(localPlayer.health).toBeCloseTo(localPlayer.maxHealth, 5);
    expect(localPlayer.shield).toBeCloseTo(localPlayer.maxShield, 5);
    expect(ctx.hud.screen).toBe('none');
    // and the weapons were persisted for the next session
    const saved = JSON.parse(localStorage.getItem(WEAPONS_KEY)!);
    expect(saved.slots.some((w: { name: string } | null) => w?.name === gun.name)).toBe(true);
  });

  it('single-player pause freezes the sim; in a co-op session it does not (input only)', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const b = boot();
    const { ctx } = b;
    b.play();
    ctx.hud.showScreen('pause');
    const t0 = ctx.rounds.state.phaseTime;
    for (let i = 0; i < 10; i++) b.frame(0.1);
    expect(ctx.rounds.state.phaseTime).toBe(t0);

    // pretend we are hosting: same screen, the sim keeps going
    const real = ctx.net!;
    ctx.net = { ...real, inSession: true, role: 'host', update: () => {} } as unknown as NetSession;
    for (let i = 0; i < 10; i++) b.frame(0.1);
    expect(ctx.rounds.state.phaseTime).toBeGreaterThan(t0 + 0.9);
    expect(ctx.input.uiCaptured).toBe(true); // the pause screen still captures this peer's input
    ctx.net = real;
  });
});

function run(b: ReturnType<typeof boot>, seconds: number, dt = 0.1) {
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) b.frame(dt);
}
