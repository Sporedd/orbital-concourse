/**
 * Boot + game loop. Wires every system through the shared GameContext.
 * Boot order matters (see types.ts): materials, fx, audio → world → players → enemies → loot →
 * progression → standing → gear → economy → net session → hud → rounds (+ lobby, rendering pipeline).
 *
 * Phones and tablets (src/mobile/detect.ts) first load the separate mobile layer with the one
 * dynamic import below, which picks the mobile quality preset before the world is built and then
 * adds touch controls. Desktop boots synchronously and never fetches it.
 */
import * as THREE from 'three';
import { CAMERA } from './core/config';
import { EventBus } from './core/events';
import { Input } from './core/input';
import { createRng } from './core/rng';
import { WEAPONS_KEY, localPlayerId, migrateStorage, simPaused } from './core/storage';
import type { GameContext } from './core/types';

import { createMaterialFactory, createFx, setupRendering } from './rendering';
import { createWorld } from './world';
import { createPlayer, createPlayerRegistry } from './player';
import { createEnemyManager } from './enemies';
import { createLootSystem } from './loot';
import { createProgression } from './progression';
import { createStandingSystem } from './standing';
import { createGearSystem } from './gear';
import { createEconomy } from './gear/economy';
import { createNetSession, mountLobby } from './net';
import { createRoundManager } from './rounds';
import { createHud } from './ui';
import { createAudio } from './audio';
import { isMobileDevice } from './mobile/detect';
import type * as MobileModule from './mobile';

// Must run before any system reads storage (progression, standing, sponsor, gear, weapons).
migrateStorage();

function boot(mobile: typeof MobileModule | null): void {
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, window.innerWidth / window.innerHeight, CAMERA.near, CAMERA.far);

  let idCounter = 0;
  const ctx = {
    scene,
    camera,
    renderer,
    canvas,
    uiRoot,
    input: new Input(canvas),
    events: new EventBus(),
    time: { delta: 0, elapsed: 0 },
    rng: createRng(Date.now() & 0xffffffff),
    isHost: true,
    nextId: (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`,
  } as GameContext;

  // ---- boot -----------------------------------------------------------------
  ctx.materials = createMaterialFactory();
  ctx.fx = createFx(ctx);
  ctx.audio = createAudio(ctx);
  ctx.world = createWorld(ctx);
  ctx.players = createPlayerRegistry();
  // Unique persisted id: co-op uses it as-is (no remapping). Weapons persist like gear.
  const localPlayer = createPlayer(ctx, { id: localPlayerId(), name: 'Challenger', persistKey: WEAPONS_KEY });
  ctx.players.add(localPlayer);
  ctx.player = localPlayer;
  ctx.enemies = createEnemyManager(ctx);
  ctx.loot = createLootSystem(ctx);
  ctx.progression = createProgression(ctx);
  ctx.standing = createStandingSystem(ctx); // standing, crowd hype, sponsor contract (run modifiers)
  ctx.gear = createGearSystem(ctx); // loads the saved inventory ('concourse.gear.v1'); kept across runs
  // Scrip wallet ('concourse.wallet.v1'), salvage, round bounty, shop stock + gear upgrades.
  ctx.economy = createEconomy(ctx, ctx.gear);
  localPlayer.reset(); // pick up the loaded gear (max health/shield, gloves) before the first run
  // Co-op session (offline until F2 → Host/Join). Created before the HUD so UI widgets can read
  // ctx.net at boot; the session swaps ctx.enemies / ctx.loot / ctx.isHost itself when it joins.
  const net = createNetSession(ctx);
  ctx.net = net;
  ctx.hud = createHud(ctx);
  ctx.rounds = createRoundManager(ctx);
  net.lobby = mountLobby(ctx, net, { hotkey: 'F2' }); // F2 toggles the lobby; UI buttons call ctx.net.lobby.show()
  const pipeline = setupRendering(ctx);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    pipeline.resize(window.innerWidth, window.innerHeight);
  });
  // Touch controls + the mobile render settings (they fire a resize, so after the handler above).
  const mobileLayer = mobile ? mobile.installMobile(ctx) : null;

  // ---- loop -----------------------------------------------------------------
  const clock = new THREE.Clock();
  let rafId = 0;
  let lastRafAt = performance.now();
  const onRaf = () => {
    lastRafAt = performance.now();
    frame();
  };
  function frame(forceDt?: number) {
    rafId = 0;
    const dt = forceDt ?? Math.min(clock.getDelta(), 1 / 20);
    ctx.time.delta = dt;
    ctx.time.elapsed += dt;

    ctx.hud.update(dt); // first: decides whether a screen captures input this frame
    mobileLayer?.update(dt); // touch → input, after the HUD picked the screen, before the player reads it
    // Single-player: any screen freezes the sim. Co-op: it keeps running for everyone; the open
    // screen only captures this peer's input (host pause must not freeze the other players).
    const paused = simPaused(ctx.hud.screen, net.inSession);
    // Every frame, also while paused, and before the local player (mirrored enemies are positioned
    // before the local hitscan): snapshots, interpolation, avatars, input ticks.
    net.update(dt);
    ctx.world.update(dt);
    if (!paused) {
      localPlayer.update(dt);
      ctx.enemies.update(dt);
      ctx.loot.update(dt);
      ctx.economy?.update(dt); // [F] salvage on the weapon prompt (after loot set the nearby item)
      ctx.rounds.update(dt);
      ctx.standing?.update(dt); // hype decay / gifts / boos run only while the sim runs
      ctx.fx.update(dt);
    }
    ctx.audio.update(dt);
    pipeline.update(dt);
    // A hidden tab / embedded pane can have a 0×0 drawing buffer: rendering it only logs
    // "framebuffer incomplete" warnings.
    if (innerWidth > 0 && innerHeight > 0) pipeline.render();

    ctx.input.endFrame();
    rafId = requestAnimationFrame(onRaf);
  }
  rafId = requestAnimationFrame(onRaf);

  // requestAnimationFrame stops in a hidden tab (or a hidden embedded pane). Single-player can
  // simply freeze, but a frozen host freezes the co-op session for every peer and the relay drops
  // the silent socket. While in a session, a timer keeps the loop alive whenever rAF goes quiet
  // (browsers throttle background timers to ~1 Hz; dt is capped at 1/20 s, so the sim slows
  // rather than jumps). The timer steps every tick while rAF stays silent; once rAF fires again
  // the timer sees a fresh rAF frame and does nothing.
  setInterval(() => {
    if (!net.inSession || performance.now() - lastRafAt < 200) return;
    if (rafId) cancelAnimationFrame(rafId);
    frame();
  }, 50);

  // Dev convenience
  (window as any).game = ctx;
  (window as any).net = net;
  (window as any).lobby = net.lobby;
  /**
   * Step the loop by hand: __step(frames, dt). For a hidden browser pane (rAF throttled to ~1 Hz)
   * and scripted play-throughs. Keeps exactly one rAF pending.
   */
  (window as any).__step = (frames = 1, dt = 1 / 30) => {
    for (let i = 0; i < frames; i++) {
      if (rafId) cancelAnimationFrame(rafId);
      frame(Math.min(dt, 1 / 20));
    }
  };
  {
    /** Free camera for look-dev: freezes the sim (pause screen) and hides the UI. __ui() restores it. */
    (window as any).__cam = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
      ctx.hud.showScreen('pause');
      uiRoot.style.opacity = '0';
      camera.position.set(x, y, z);
      camera.lookAt(tx, ty, tz);
      camera.updateMatrixWorld();
    };
    (window as any).__ui = () => { uiRoot.style.opacity = '1'; };
  }
}

if (isMobileDevice()) {
  // The only place the mobile layer is loaded (never on desktop).
  import('@/mobile').then(
    (m) => {
      m.prepareMobile();
      boot(m);
    },
    (err) => {
      console.error('[mobile] layer failed to load; starting without touch controls', err);
      boot(null);
    },
  );
} else {
  boot(null);
}
