// @vitest-environment jsdom
/**
 * UI smoke test (src/ui): screen flow with the meta systems wired like main.ts — start menu rows
 * for optional systems, key I inventory screen (pauses + captures input), settings persistence +
 * the sensitivity setting read by the controller, and the game-over recap (damage dealt, kills, standing).
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CAMERA } from '@/core/config';
import { EventBus } from '@/core/events';
import { Input } from '@/core/input';
import { createRng } from '@/core/rng';
import { localPlayerId } from '@/core/storage';
import type { GameContext } from '@/core/types';
import { createMaterialFactory } from '@/rendering';
import { createWorld } from '@/world';
import { createPlayer, createPlayerRegistry } from '@/player';
import { createEnemyManager } from '@/enemies';
import { createLootSystem } from '@/loot';
import { createProgression } from '@/progression';
import { createStandingSystem } from '@/standing';
import { createGearSystem } from '@/gear';
import { createNetSession } from '@/net';
import { createRoundManager } from '@/rounds';
import { createHud } from '@/ui';
import { SETTINGS_KEY, getSettings, reloadSettings, setSetting } from '@/ui/settings';
import { vitalText } from '@/ui/hud';
import { Controller, MOUSE_SENSITIVITY } from '@/player/controller';
import { createAudio } from '@/audio';
import { createFakeFx, createFakeRenderer } from '../helpers/fakeContext';

function boot(meta = true) {
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
    rng: createRng(0x51ab),
    isHost: true,
    nextId: (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`,
  } as GameContext;
  ctx.materials = createMaterialFactory();
  ctx.fx = createFakeFx();
  ctx.audio = createAudio(ctx);
  ctx.world = createWorld(ctx);
  ctx.players = createPlayerRegistry();
  const p = createPlayer(ctx, { id: localPlayerId(), name: 'Challenger' });
  ctx.players.add(p);
  ctx.player = p;
  ctx.enemies = createEnemyManager(ctx);
  ctx.loot = createLootSystem(ctx);
  ctx.progression = createProgression(ctx);
  if (meta) {
    ctx.standing = createStandingSystem(ctx);
    ctx.gear = createGearSystem(ctx);
    ctx.net = createNetSession(ctx, { avatars: false, url: 'ws://127.0.0.1:1' });
  }
  ctx.hud = createHud(ctx);
  ctx.rounds = createRoundManager(ctx);
  const frame = (dt: number) => {
    ctx.hud.update(dt);
    if (ctx.hud.screen === 'none') {
      p.update(dt);
      ctx.enemies.update(dt);
      ctx.loot.update(dt);
      ctx.rounds.update(dt);
    }
    ctx.input.endFrame();
  };
  const key = (code: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code }));
    frame(0.05);
    window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  };
  return { ctx, frame, key };
}

const visibleRows = (root: HTMLElement, screenIdx: number) =>
  Array.from(root.querySelectorAll('.sb-screen')[screenIdx].querySelectorAll('.sb-menu button'))
    .filter((b) => !b.classList.contains('sb-hidden'))
    .map((b) => b.querySelector('.v')!.textContent);

describe('UI screens', () => {
  it('start menu hides rows for missing systems and shows them when wired', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bare = boot(false);
    expect(visibleRows(bare.ctx.uiRoot, 0)).toEqual(['ENTER THE PIT', 'SKILL TREE', 'SETTINGS', 'SOUND: OFF']);
    const full = boot(true);
    const rows = visibleRows(full.ctx.uiRoot, 0);
    expect(rows).toContain('LOADOUT');
    expect(rows).toContain('CO-OP');
    expect(rows.some((r) => r?.startsWith('SPONSOR'))).toBe(true);
    expect(full.ctx.uiRoot.querySelector('.sbs-badge')).not.toBeNull();
  });

  it('key I opens the inventory screen (captures input, pauses) and Esc closes it', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, frame, key } = boot(true);
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.05);
    key('KeyI');
    expect(ctx.hud.screen).toBe('inventory');
    expect(ctx.input.uiCaptured).toBe(true);
    const inv = ctx.uiRoot.querySelector('.sbg-inv') as HTMLElement;
    expect(inv.hidden).toBe(false);
    const t = ctx.rounds.state.phaseTime;
    for (let i = 0; i < 5; i++) frame(0.1);
    expect(ctx.rounds.state.phaseTime).toBe(t);
    key('Escape');
    expect(ctx.hud.screen).toBe('none');
    expect(inv.hidden).toBe(true);
  });

  it('persists mouse sensitivity and the controller scales its look by it (deltas stay raw)', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx } = boot(false);
    setSetting('mouseSensitivity', 2);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).mouseSensitivity).toBe(2);
    setSetting('mouseSensitivity', 99);
    expect(getSettings().mouseSensitivity).toBe(3);
    ctx.input.uiCaptured = false;
    ctx.input.lock();
    const ev = new MouseEvent('mousemove');
    Object.defineProperty(ev, 'movementX', { value: 10 });
    Object.defineProperty(ev, 'movementY', { value: -4 });
    window.dispatchEvent(ev);
    // The input layer no longer scales (the interim hook is gone): the controller applies the setting once.
    const c = new Controller(ctx);
    const yaw0 = c.yaw;
    c.look(true);
    expect(yaw0 - c.yaw).toBeCloseTo(10 * MOUSE_SENSITIVITY * 3, 8);
    expect(c.pitch).toBeCloseTo(4 * MOUSE_SENSITIVITY * 3, 8);
    setSetting('mouseSensitivity', 1);
    reloadSettings();
    expect(getSettings().mouseSensitivity).toBe(1);
  });

  it('vitals text rounds current and max consistently (no 119 / 118)', () => {
    expect(vitalText(118.4, 118.4)).toBe('118 / 118');
    expect(vitalText(130.24, 130.24)).toBe('130 / 130');
    expect(vitalText(0.3, 100)).toBe('1 / 100');
    expect(vitalText(99.2, 100)).toBe('100 / 100');
    expect(vitalText(0, 80)).toBe('0 / 80');
  });

  it('game over recap shows damage dealt, kills and standing earned', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame } = boot(true);
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.05);
    for (let i = 0; i < 3; i++) {
      const e = ctx.enemies.spawnMob('grunt', ctx.world.randomNavigablePoint(), 1);
      e.damage(1e5, { sourceId: ctx.player.id, point: e.position.clone() });
    }
    ctx.standing!.standing.award(100, 'round', 'Round 1 cleared');
    ctx.player.takeDamage(1e6);
    for (let i = 0; i < 80 && ctx.hud.screen !== 'gameover'; i++) frame(0.05);
    expect(ctx.hud.screen).toBe('gameover');
    const text = (ctx.uiRoot.querySelector('.sb-recap') as HTMLElement).textContent!;
    expect(text).toMatch(/Damage dealt/i);
    expect(text).not.toMatch(/Damage dealt\s*0(?!\d)/i);
    expect(text).toMatch(/Standing earned\s*\+\d+/i);
    expect(text).toMatch(/Best weapon/i);
  });
});
