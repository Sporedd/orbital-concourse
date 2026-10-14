/**
 * System D — UI (Orbital Concourse, docs/ART_DIRECTION.md §10): HUD widgets + full-screen
 * menus, pointer-lock aware screen flow.
 *  start ─click→ none ⇄ pause (Esc / lock lost) ; none ⇄ skills (Tab) ; none ⇄ inventory (I, with ctx.gear)
 *  game:over → gameover ─click→ none (retry) / start (main menu)
 * Every screen other than 'none' unlocks the pointer and sets input.uiCaptured (sim pauses).
 */
import type { GameContext, Hud, Screen } from '@/core/types';
import { createInventoryScreen, type InventoryScreen } from '@/gear/inventoryScreen';
import { h } from './dom';
import { createHudWidgets } from './hud';
import { createRunStats } from './runStats';
import { createScreens } from './screens';
import { installSensitivityHook } from './settings';
import { injectStyles } from './styles';

/** Grace period for pointer lock to engage after a click before we fall back to the pause screen. */
const LOCK_GRACE = 0.8;
const GAMEOVER_DELAY = 1.6;

export function createHud(ctx: GameContext): Hud {
  injectStyles();
  // Interim mouse-sensitivity hook (see settings.ts): remove once the controller reads the setting.
  installSensitivityHook(ctx.input);
  const root = h('div', 'sb', ctx.uiRoot);

  let screen: Screen = 'start';
  /** Where Tab / I return to when the overlay screen closes. */
  let overlayReturn: Screen = 'none';
  let unlockedFor = 0;
  let gameOverIn = -1;

  const playing = () => {
    const ph = ctx.rounds?.state.phase;
    return !!ph && ph !== 'idle' && ph !== 'gameover';
  };

  const widgets = createHudWidgets(ctx, root);
  const run = createRunStats(ctx);

  const enterPlay = () => {
    ctx.input.lock();
    unlockedFor = 0;
    showScreen('none');
  };

  // ---- inventory (key I), created on first use so ctx.gear may be wired after the HUD ----------
  let inventory: InventoryScreen | null = null;
  const getInventory = (): InventoryScreen | null => {
    if (inventory || !ctx.gear) return inventory;
    const canDrop = typeof ctx.loot?.dropItem === 'function';
    inventory = createInventoryScreen(root, ctx.gear, ctx.materials, {
      onClose: () => closeOverlay(),
      onDrop: canDrop
        ? (item) => {
          const p = ctx.player;
          const x = p.position.x - Math.sin(p.yaw) * 0.8;
          const z = p.position.z - Math.cos(p.yaw) * 0.8;
          ctx.loot.dropItem({ kind: 'gear', gear: item, rarity: item.rarity, position: { x, y: ctx.world.groundHeight(x, z), z } });
          ctx.audio.play('ui_click');
        }
        : undefined,
    });
    return inventory;
  };

  const screens = createScreens(ctx, root, {
    onStart() {
      ctx.audio.resume();
      ctx.audio.play('ui_click');
      ctx.rounds.start();
      enterPlay();
    },
    onResume() {
      ctx.audio.resume();
      ctx.audio.play('ui_click');
      enterPlay();
    },
    onRetry() {
      ctx.audio.resume();
      ctx.audio.play('ui_click');
      ctx.rounds.start();
      enterPlay();
    },
    onMainMenu() {
      ctx.audio.play('ui_click');
      showScreen('start');
    },
    onCloseSkills: () => closeOverlay(),
    onOpenSkills: () => openOverlay('skills'),
    onOpenInventory: () => openOverlay('inventory'),
  }, run);

  function showScreen(s: Screen): void {
    if (s === screen) return;
    if (s === 'inventory' && !getInventory()) return;
    screen = s;
    screens.show(s);
    if (s === 'inventory') inventory!.show();
    else inventory?.hide();
    widgets.setVisible(s !== 'start' && s !== 'gameover' && s !== 'inventory');
    if (s !== 'none') {
      ctx.input.unlock();
      if (s === 'skills' || s === 'pause' || s === 'inventory') ctx.audio.play('ui_open');
    }
    ctx.input.uiCaptured = s !== 'none';
    ctx.events.emit('ui:screen', { screen: s });
  }

  /** Skills / inventory: remember the screen they were opened from. */
  function openOverlay(s: 'skills' | 'inventory'): void {
    if (screen !== 'skills' && screen !== 'inventory') overlayReturn = screen;
    showScreen(s);
  }

  function closeOverlay(): void {
    const back = overlayReturn;
    overlayReturn = 'none';
    if (back === 'none') {
      if (playing()) enterPlay();
      else showScreen('start');
    } else {
      showScreen(back);
    }
  }

  // Losing pointer lock mid-game (browser eats Esc) → pause.
  document.addEventListener('pointerlockchange', () => {
    if (!ctx.input.locked() && screen === 'none' && playing()) showScreen('pause');
  });

  ctx.events.on('game:over', (e) => {
    screens.setGameOver(e.round, e.kills);
    gameOverIn = GAMEOVER_DELAY;
  });
  ctx.events.on('game:started', () => {
    gameOverIn = -1;
  });
  ctx.events.on('skill:changed', () => {
    if (screen === 'skills') screens.renderSkills();
  });
  ctx.events.on('level:up', () => {
    if (screen === 'skills') screens.renderSkills();
  });

  function update(dt: number): void {
    const input = ctx.input;

    // Pending game-over screen (lets the death land first).
    if (gameOverIn > 0) {
      gameOverIn -= dt;
      if (gameOverIn <= 0) {
        gameOverIn = -1;
        if (screen === 'skills' || screen === 'inventory') overlayReturn = 'gameover';
        else showScreen('gameover');
      }
    }

    // Keyboard screen toggles (raw: work while a screen captures input).
    const tab = input.rawJustPressed('Tab');
    const invKey = input.rawJustPressed('KeyI');
    const escKey = input.rawJustPressed('Escape');
    if (screen === 'skills') {
      if (tab || escKey) closeOverlay();
      else if (invKey && ctx.gear) showScreen('inventory');
    } else if (screen === 'inventory') {
      if (invKey || escKey) closeOverlay();
      else if (tab) showScreen('skills');
    } else if (tab) {
      if (screen === 'none' || screen === 'pause' || screen === 'start' || screen === 'gameover') openOverlay('skills');
    } else if (invKey && ctx.gear) {
      if (screen === 'none' || screen === 'pause' || screen === 'start' || screen === 'gameover') openOverlay('inventory');
    } else if (escKey && screen === 'none' && playing()) {
      showScreen('pause');
    }

    // Pointer lock didn't engage (or was lost without an event) → pause.
    if (screen === 'none' && playing() && !input.locked()) {
      unlockedFor += dt;
      if (unlockedFor > LOCK_GRACE) showScreen('pause');
    } else {
      unlockedFor = 0;
    }

    input.uiCaptured = screen !== 'none';
    run.update(dt, screen === 'none' && playing());
    widgets.update(dt);
    inventory?.update(dt);
    if (screen !== 'none') screens.syncSound();
  }

  // Initial state
  screens.show('start');
  widgets.setVisible(false);
  ctx.input.uiCaptured = true;

  return {
    get screen() { return screen; },
    showScreen,
    update,
  };
}
