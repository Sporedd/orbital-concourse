/**
 * System D — UI (Orbital Concourse, docs/ART_DIRECTION.md §10): HUD widgets + full-screen
 * menus, pointer-lock aware screen flow.
 *  start ─click→ none ⇄ pause (Esc / lock lost) ; none ⇄ skills (Tab) ; none ⇄ inventory (I, with ctx.gear)
 *  game:over → gameover ─click→ none (retry) / start (main menu)
 *  pit stop (phase 'cleared'): Enter = continue (host), B ⇄ shop; shop also from the start menu
 *  any screen or play ⇄ help (H, menu rows); H / Esc return to the screen it was opened from
 * Every screen other than 'none' unlocks the pointer and sets input.uiCaptured (sim pauses).
 */
import type { GameContext, Hud, Screen } from '@/core/types';
import { createInventoryScreen, type InventoryScreen } from '@/gear/inventoryScreen';
import { createShopScreen, type ShopScreen } from '@/gear/shopScreen';
import { h } from './dom';
import { createHudWidgets } from './hud';
import { createRunStats } from './runStats';
import { createScreens } from './screens';
import { injectStyles } from './styles';

/** Grace period for pointer lock to engage after a click before we fall back to the pause screen. */
const LOCK_GRACE = 0.8;
const GAMEOVER_DELAY = 1.6;

export function createHud(ctx: GameContext): Hud {
  injectStyles();
  const root = h('div', 'sb', ctx.uiRoot);

  let screen: Screen = 'start';
  /** Where Tab / I return to when the overlay screen closes. */
  let overlayReturn: Screen = 'none';
  /** Where H / Esc return to when the help screen closes (help stacks on top of any screen). */
  let helpReturn: Screen = 'none';
  let unlockedFor = 0;
  let gameOverIn = -1;

  const playing = () => {
    const ph = ctx.rounds?.state.phase;
    return !!ph && ph !== 'idle' && ph !== 'gameover';
  };

  const pitStop = () => ctx.rounds?.state.phase === 'cleared';
  /** Pit stop → next round (host / single-player; a co-op client waits for the host). */
  const continueRun = () => {
    if (!pitStop() || (ctx.net?.inSession && !ctx.isHost)) return;
    if (ctx.rounds.continue?.()) {
      ctx.audio.play('ui_click');
      if (screen !== 'none') enterPlay();
    }
  };
  /** The shop opens from the pit stop and the menus, never mid-fight. */
  const shopAllowed = () => !!ctx.economy && !!ctx.gear && (!playing() || pitStop());

  const widgets = createHudWidgets(ctx, root, {
    continue: continueRun,
    shop: () => openOverlay('shop'),
    loadout: () => openOverlay('inventory'),
    skills: () => openOverlay('skills'),
  });
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
      economy: () => ctx.economy,
      onUpgrade: () => ctx.audio.play('skill_up'),
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

  // ---- shop (key B / menus), created on first use --------------------------------------------
  let shop: ShopScreen | null = null;
  const getShop = (): ShopScreen | null => {
    if (shop || !ctx.gear || !ctx.economy) return shop;
    shop = createShopScreen(root, ctx.gear, ctx.economy, {
      onClose: () => closeOverlay(),
      onAction: (what) => ctx.audio.play(what === 'fail' ? 'empty' : what === 'upgrade' ? 'skill_up' : 'pickup'),
      context: () => {
        const rs = ctx.rounds?.state;
        return rs && rs.phase === 'cleared' ? `PIT STOP · ROUND ${String(rs.round).padStart(2, '0')} CLEARED · VENDOR DECK` : 'QUARTERS · VENDOR DECK';
      },
    });
    return shop;
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
    onOpenShop: () => openOverlay('shop'),
    onContinue: continueRun,
    onOpenHelp: () => openHelp(),
    onCloseHelp: () => closeHelp(),
  }, run);

  function showScreen(s: Screen): void {
    if (s === screen) return;
    if (s === 'inventory' && !getInventory()) return;
    if (s === 'shop' && !getShop()) return;
    screen = s;
    screens.show(s);
    if (s === 'inventory') inventory!.show();
    else inventory?.hide();
    if (s === 'shop') shop!.show();
    else shop?.hide();
    widgets.setVisible(s !== 'start' && s !== 'gameover' && s !== 'inventory' && s !== 'shop' && s !== 'help');
    if (s !== 'none') {
      ctx.input.unlock();
      if (s === 'skills' || s === 'pause' || s === 'inventory' || s === 'shop' || s === 'help') ctx.audio.play('ui_open');
    }
    ctx.input.uiCaptured = s !== 'none';
    ctx.events.emit('ui:screen', { screen: s });
  }

  /** Skills / inventory / shop: remember the screen they were opened from. */
  const isOverlay = (s: Screen) => s === 'skills' || s === 'inventory' || s === 'shop';
  function openOverlay(s: 'skills' | 'inventory' | 'shop'): void {
    if (s === 'shop' && !shopAllowed()) return;
    if (!isOverlay(screen)) overlayReturn = screen;
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

  /** Help opens on top of whatever is showing (play pauses into it) and returns there. */
  function openHelp(): void {
    if (screen === 'help') return;
    helpReturn = screen;
    showScreen('help');
  }

  function closeHelp(): void {
    if (screen !== 'help') return;
    const back = helpReturn;
    helpReturn = 'none';
    if (back === 'none') {
      if (playing()) enterPlay();
      else showScreen('start');
    } else {
      showScreen(back);
    }
  }

  /** Typing in a text field (co-op lobby name / code) must not open help. */
  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

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
        if (isOverlay(screen)) overlayReturn = 'gameover';
        else if (screen === 'help') {
          if (isOverlay(helpReturn)) overlayReturn = 'gameover';
          else helpReturn = 'gameover';
        } else showScreen('gameover');
      }
    }

    // Keyboard screen toggles (raw: work while a screen captures input).
    const tab = input.rawJustPressed('Tab');
    const invKey = input.rawJustPressed('KeyI');
    const escKey = input.rawJustPressed('Escape');
    const shopKey = input.rawJustPressed('KeyB');
    const enterKey = input.rawJustPressed('Enter') || input.rawJustPressed('NumpadEnter');
    const helpKey = input.rawJustPressed('KeyH') && !typing();
    const base = screen === 'none' || screen === 'pause' || screen === 'start' || screen === 'gameover';
    if (screen === 'help') {
      if (helpKey || escKey) closeHelp();
      else screens.help.handleInput(input, dt);
    } else if (helpKey && (screen !== 'none' || playing())) {
      openHelp();
    } else if (screen === 'skills') {
      if (tab || escKey) closeOverlay();
      else if (invKey && ctx.gear) showScreen('inventory');
      else if (shopKey && shopAllowed()) showScreen('shop');
    } else if (screen === 'inventory') {
      if (invKey || escKey) closeOverlay();
      else if (tab) showScreen('skills');
      else if (shopKey && shopAllowed()) showScreen('shop');
    } else if (screen === 'shop') {
      if (shopKey || escKey) closeOverlay();
      else if (tab) showScreen('skills');
      else if (invKey) showScreen('inventory');
    } else if (tab) {
      if (base) openOverlay('skills');
    } else if (invKey && ctx.gear) {
      if (base) openOverlay('inventory');
    } else if (shopKey && base) {
      openOverlay('shop');
    } else if (enterKey && (screen === 'none' || screen === 'pause') && pitStop()) {
      continueRun();
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
    shop?.update(dt);
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
