// @vitest-environment jsdom
/**
 * Boot smoke test: wires the real systems exactly like src/main.ts (same boot order) in jsdom
 * with a stub renderer, skipping setupRendering (needs WebGL) and using the recording Fx
 * (the real one paints a decal texture through a 2D canvas, which jsdom lacks; see
 * tests/PROPOSED_CHANGES.md). Runs the main loop body for 300 frames while "auto-killing"
 * every enemy via enemy.damage, and asserts the round reaches 'boss' and then 'cleared'.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CAMERA } from '@/core/config';
import { EventBus } from '@/core/events';
import { Input } from '@/core/input';
import { createRng } from '@/core/rng';
import type { GameContext, RoundPhase } from '@/core/types';
import { createMaterialFactory } from '@/rendering';
import { createWorld } from '@/world';
import { createPlayer, createPlayerRegistry } from '@/player';
import { createEnemyManager } from '@/enemies';
import { createLootSystem } from '@/loot';
import { createProgression } from '@/progression';
import { createRoundManager } from '@/rounds';
import { createHud } from '@/ui';
import { createAudio } from '@/audio';
import { createFakeFx, createFakeRenderer } from '../helpers/fakeContext';

function boot() {
  document.body.innerHTML = '<canvas id="app"></canvas><div id="ui"></div>';
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
  let idCounter = 0;
  const ctx = {
    scene,
    camera,
    renderer: createFakeRenderer(canvas),
    canvas,
    uiRoot,
    input: new Input(canvas),
    events: new EventBus(),
    time: { delta: 0, elapsed: 0 },
    rng: createRng(0x5eed),
    isHost: true,
    nextId: (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`,
  } as GameContext;

  ctx.materials = createMaterialFactory();
  ctx.fx = createFakeFx();
  ctx.audio = createAudio(ctx);
  ctx.world = createWorld(ctx);
  ctx.players = createPlayerRegistry();
  const localPlayer = createPlayer(ctx, { id: 'p1', name: 'Vault Hunter' });
  ctx.players.add(localPlayer);
  ctx.player = localPlayer;
  ctx.enemies = createEnemyManager(ctx);
  ctx.loot = createLootSystem(ctx);
  ctx.progression = createProgression(ctx);
  ctx.hud = createHud(ctx);
  ctx.rounds = createRoundManager(ctx);

  /** Body of main.ts frame() minus the render pipeline. */
  const frame = (dt: number) => {
    ctx.time.delta = dt;
    ctx.time.elapsed += dt;
    ctx.hud.update(dt);
    const paused = ctx.hud.screen !== 'none';
    ctx.world.update(dt);
    if (!paused) {
      localPlayer.update(dt);
      ctx.enemies.update(dt);
      ctx.loot.update(dt);
      ctx.rounds.update(dt);
      ctx.fx.update(dt);
    }
    ctx.audio.update(dt);
    ctx.input.endFrame();
  };
  return { ctx, frame, localPlayer };
}

describe('boot smoke test (main.ts wiring, headless)', () => {
  it('boots, starts a run and plays round 1 to boss and cleared within 300 frames', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, localPlayer } = boot();
    expect(ctx.hud.screen).toBe('start');
    expect(ctx.rounds.state.phase).toBe('idle');

    // Paused on the start screen: the sim must not advance.
    for (let i = 0; i < 10; i++) frame(0.05);
    expect(ctx.rounds.state.phase).toBe('idle');

    // What the start screen's onStart does (minus audio): start the run and enter play.
    ctx.rounds.start();
    ctx.input.lock(); // jsdom has no pointer lock → virtual lock fallback
    ctx.hud.showScreen('none');
    expect(ctx.input.locked()).toBe(true);
    expect(localPlayer.activeWeapon?.name).toBe('Rusty Iron');

    const phases = new Set<RoundPhase>();
    const order: RoundPhase[] = [];
    ctx.events.on('round:phase', (e) => { phases.add(e.phase); order.push(e.phase); });
    let kills = 0;
    ctx.events.on('enemy:killed', () => kills++);
    let spawned = 0;
    ctx.events.on('enemy:spawned', () => spawned++);

    // dt 0.2 so a full round (intermission 6 s, 28 trickled mobs in 3 sub-waves, boss) fits in 300 frames
    for (let i = 0; i < 300; i++) {
      frame(0.2);
      for (const e of ctx.enemies.list()) {
        if (e.alive) e.damage(1e6, { sourceId: 'p1', point: e.position.clone() });
      }
      expect(ctx.hud.screen, `frame ${i}`).toBe('none');
      if (phases.has('cleared') && ctx.rounds.state.phase === 'intermission') break;
    }

    expect(phases.has('wave')).toBe(true);
    expect(phases.has('boss')).toBe(true);
    expect(phases.has('cleared')).toBe(true);
    expect(order.indexOf('boss')).toBeLessThan(order.indexOf('cleared'));
    expect(ctx.rounds.state.round).toBe(2);
    expect(spawned).toBeGreaterThanOrEqual(29);
    expect(kills).toBeGreaterThanOrEqual(29);
    expect(ctx.rounds.state.totalKills).toBeGreaterThanOrEqual(29);
    expect(localPlayer.alive).toBe(true);
    expect(ctx.progression.level).toBeGreaterThan(1); // 28 mobs + boss + clear = 490 XP
    expect(ctx.loot.items().some((it) => it.kind === 'weapon')).toBe(true); // boss shower
    // HUD rendered something into the UI root
    expect(ctx.uiRoot.querySelectorAll('*').length).toBeGreaterThan(10);
  });

  it('opening the skills screen with Tab pauses the simulation', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame } = boot();
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.1);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    frame(0.1);
    expect(ctx.hud.screen).toBe('skills');
    const t = ctx.rounds.state.phaseTime;
    for (let i = 0; i < 20; i++) frame(0.1);
    expect(ctx.rounds.state.phaseTime).toBe(t);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    frame(0.1);
    expect(ctx.hud.screen).toBe('none');
  });

  it('player death leads to game over and the game-over screen', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, localPlayer } = boot();
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.1);
    localPlayer.takeDamage(1e6);
    expect(ctx.rounds.state.phase).toBe('gameover');
    for (let i = 0; i < 30; i++) frame(0.1);
    expect(ctx.hud.screen).toBe('gameover');
  });
});
