// @vitest-environment jsdom
/**
 * UI smoke test (src/ui): screen flow with the meta systems wired like main.ts — start menu rows
 * for optional systems, key I inventory screen (pauses + captures input), settings persistence +
 * the sensitivity setting read by the controller, the game-over recap (damage dealt, kills, standing),
 * and the HELP screen (open/close from start, pause, play and overlays; every topic renders).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { HELP_SEEN_KEY } from '@/ui/help';
import { HELP_TOPICS, renderHelpMarkdown } from '@/ui/helpContent';
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
    expect(visibleRows(bare.ctx.uiRoot, 0)).toEqual(['ENTER THE PIT', 'SKILL TREE', 'CLASS', 'HELP', 'SETTINGS', 'SOUND: OFF']);
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

const rowByLabel = (root: HTMLElement, screenIdx: number, label: string) =>
  Array.from(root.querySelectorAll('.sb-screen')[screenIdx].querySelectorAll<HTMLButtonElement>('.sb-menu button'))
    .find((b) => b.querySelector('.v')!.textContent === label)!;
const helpEl = (root: HTMLElement) => root.querySelector('.sb-help') as HTMLElement;
const helpTitle = (root: HTMLElement) => root.querySelector('.sbh-pt')!.textContent;

describe('help screen', () => {
  it('opens from the start menu row and H, and closes back to start with Esc or H', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, key } = boot(true);
    expect(ctx.hud.screen).toBe('start');
    expect(helpEl(ctx.uiRoot).classList.contains('sb-hidden')).toBe(true);
    rowByLabel(ctx.uiRoot, 0, 'HELP').click();
    expect(ctx.hud.screen).toBe('help');
    expect(helpEl(ctx.uiRoot).classList.contains('sb-hidden')).toBe(false);
    expect(ctx.input.uiCaptured).toBe(true);
    key('Escape');
    expect(ctx.hud.screen).toBe('start');
    key('KeyH');
    expect(ctx.hud.screen).toBe('help');
    key('KeyH');
    expect(ctx.hud.screen).toBe('start');
  });

  it('opens from pause (row and H) and returns to pause', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, key } = boot(true);
    ctx.rounds.start();
    ctx.hud.showScreen('pause');
    frame(0.05);
    rowByLabel(ctx.uiRoot, 1, 'HELP').click();
    expect(ctx.hud.screen).toBe('help');
    key('KeyH');
    expect(ctx.hud.screen).toBe('pause');
    key('KeyH');
    expect(ctx.hud.screen).toBe('help');
    key('Escape');
    expect(ctx.hud.screen).toBe('pause');
  });

  it('H during play pauses into help and H returns to play', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, key } = boot(true);
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.05);
    key('KeyH');
    expect(ctx.hud.screen).toBe('help');
    expect(ctx.input.uiCaptured).toBe(true);
    const t = ctx.rounds.state.phaseTime;
    for (let i = 0; i < 5; i++) frame(0.1);
    expect(ctx.rounds.state.phaseTime).toBe(t);
    key('KeyH');
    expect(ctx.hud.screen).toBe('none');
    expect(ctx.input.uiCaptured).toBe(false);
  });

  it('stacks on the skill tree and returns to it; ignores H while typing', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, key } = boot(true);
    ctx.rounds.start();
    ctx.input.lock();
    ctx.hud.showScreen('none');
    frame(0.05);
    key('Tab');
    expect(ctx.hud.screen).toBe('skills');
    key('KeyH');
    expect(ctx.hud.screen).toBe('help');
    key('Escape');
    expect(ctx.hud.screen).toBe('skills');
    key('Tab');
    expect(ctx.hud.screen).toBe('none');

    ctx.hud.showScreen('start');
    const field = document.createElement('input');
    ctx.uiRoot.appendChild(field);
    field.focus();
    key('KeyH');
    expect(ctx.hud.screen).toBe('start');
    field.blur();
  });

  it('every topic renders, and arrows / number keys / two-digit jumps pick topics', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, frame, key } = boot(true);
    key('KeyH');
    expect(ctx.hud.screen).toBe('help');
    const rows = ctx.uiRoot.querySelectorAll<HTMLButtonElement>('.sbh-list button');
    expect(rows.length).toBe(HELP_TOPICS.length);
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(13);
    HELP_TOPICS.forEach((t, i) => {
      expect(() => rows[i].click()).not.toThrow();
      expect(helpTitle(ctx.uiRoot)).toBe(t.title);
      const content = ctx.uiRoot.querySelector('.sbh-content') as HTMLElement;
      expect(content.textContent!.length).toBeGreaterThan(100);
      expect(content.textContent).not.toMatch(/\*\*/); // bold markers were rendered
      expect(rows[i].classList.contains('sel')).toBe(true);
    });
    // keycaps render as elements, not bracket text
    rows[HELP_TOPICS.findIndex((t) => t.id === 'loop')].click();
    expect(ctx.uiRoot.querySelectorAll('.sbh-content .sbh-k, .sbh-content .sb-key').length).toBeGreaterThan(0);

    key('Home');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[0].title);
    key('ArrowDown');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[1].title);
    key('ArrowUp');
    key('ArrowUp'); // wraps
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[HELP_TOPICS.length - 1].title);
    for (let i = 0; i < 20; i++) frame(0.05);
    key('Digit3');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[2].title);
    for (let i = 0; i < 20; i++) frame(0.05);
    key('Digit1');
    key('Digit2');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[11].title);
    for (let i = 0; i < 20; i++) frame(0.05);
    key('Digit2');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[1].title);
    // the topic survives closing and reopening
    key('Escape');
    key('KeyH');
    expect(helpTitle(ctx.uiRoot)).toBe(HELP_TOPICS[1].title);
  });

  it('shows the first-run hint on the start screen until help has been opened', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    localStorage.removeItem(HELP_SEEN_KEY);
    const first = boot(true);
    const hint = first.ctx.uiRoot.querySelector('.sb-helphint') as HTMLElement;
    expect(hint.classList.contains('sb-hidden')).toBe(false);
    expect(hint.textContent).toMatch(/PRESS H/);
    hint.click();
    expect(first.ctx.hud.screen).toBe('help');
    expect(localStorage.getItem(HELP_SEEN_KEY)).toBe('1');
    first.key('Escape');
    expect(first.ctx.hud.screen).toBe('start');
    expect(hint.classList.contains('sb-hidden')).toBe(true);
    const again = boot(true);
    expect((again.ctx.uiRoot.querySelector('.sb-helphint') as HTMLElement).classList.contains('sb-hidden')).toBe(true);
  });

  it('docs/HELP.md is generated from the same data (npx tsx scripts/help-md.ts)', () => {
    const md = readFileSync(resolve(process.cwd(), 'docs/HELP.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(md).toBe(renderHelpMarkdown());
    for (const t of HELP_TOPICS) expect(md).toContain(`· ${t.title}`);
  });
});
