# Proposed source changes for testability

The test agent does not edit `src/`. Everything is testable today without these changes; each one removes a
workaround the suite currently needs. Diffs are minimal and should not change behaviour.

## 1. `rendering/fx.ts`: survive a missing 2D canvas context (lets the smoke test use the real Fx)

jsdom (and some locked-down webviews) return `null` from `getContext('2d')`, so `createFx` throws in
`makeDecalTexture()`. The smoke test currently swaps in a recording Fx.

```diff
 function makeDecalTexture(): THREE.Texture {
   const size = 64;
   const c = document.createElement('canvas');
   c.width = c.height = size;
-  const g = c.getContext('2d')!;
+  const g = c.getContext('2d');
+  if (!g) {
+    // headless / no 2D canvas: flat dark decal so the rest of fx still works
+    const data = new Uint8Array([10, 12, 20, 200]);
+    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
+    tex.needsUpdate = true;
+    return tex;
+  }
   const grad = g.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
```

## 2. `main.ts`: split the boot wiring from the browser entry point

`tests/smoke/boot.test.ts` re-creates main.ts's boot sequence and frame body by hand, and will drift whenever
main.ts changes. A `bootGame()` that main.ts calls would let the test drive the real wiring.

```diff
+// src/game.ts (new)
+export interface BootOptions {
+  canvas: HTMLCanvasElement;
+  uiRoot: HTMLElement;
+  renderer: THREE.WebGLRenderer;
+  seed?: number;
+  /** Skip the post-processing pipeline (headless tests). */
+  headless?: boolean;
+  fx?: Fx; // override (tests)
+}
+export function bootGame(o: BootOptions): { ctx: GameContext; frame(dt: number): void; resize(w: number, h: number): void } {
+  // …the body of main.ts from `const scene = …` through `ctx.rounds = createRoundManager(ctx)`,
+  // then `const pipeline = o.headless ? null : setupRendering(ctx)`, and frame(dt) = the loop body
+  // with `pipeline?.update(dt); pipeline?.render();`
+}
```
```diff
 // src/main.ts
-…all wiring…
+const { ctx, frame, resize } = bootGame({ canvas, uiRoot, renderer, seed: Date.now() & 0xffffffff });
+window.addEventListener('resize', () => resize(window.innerWidth, window.innerHeight));
+const clock = new THREE.Clock();
+requestAnimationFrame(function loop() { frame(Math.min(clock.getDelta(), 1 / 20)); requestAnimationFrame(loop); });
```

## 3. `enemies/manager.ts`: refresh world matrices on spawn

Hitscan (`player/weapons.ts` `trace()`) raycasts against `object.matrixWorld`, which only `renderer.render()`
refreshes. In the game loop every spawn is followed by a render before the next shot, so nothing is broken. But an
enemy spawned and shot within the same tick (tests, a future server-side sim, or a reordered loop) is tested at
the world origin. The tests work around this with `ctx.scene.updateMatrixWorld(true)`.

```diff
   private add(e: BaseEnemy): void {
     this.enemies.push(e);
     this.ctx.scene.add(e.object);
     for (const x of e.extras) this.ctx.scene.add(x);
+    e.object.updateMatrixWorld(true);
     this.ctx.events.emit('enemy:spawned', { enemy: e });
   }
```
(For a headless host sim, calling `e.object.updateMatrixWorld()` at the end of `syncView()` would make the whole
sim independent of rendering.)

## 4. `core/types.ts` (contract, lead only): `Enemy.damage()` returns the damage applied

Fixes FINDINGS #2 cleanly and lets weapon tests assert applied damage directly.

```diff
-  damage(amount: number, opts?: DamageOpts): void;
+  /** Returns the health actually removed (0 when immune, dead or fully absorbed). */
+  damage(amount: number, opts?: DamageOpts): number;
```
`BaseEnemy.damage/applyDamage` would return `amount` after `modifyIncoming` (or 0 on the early returns).

## 5. `progression/index.ts`: optional storage injection (nice to have)

Progression reads the global `localStorage` and registers a `beforeunload` listener on the global `window`
for every instance. The node test environment stubs both in `tests/setup.ts`. An optional
`createProgression(ctx, { storage = localStorage, autoSaveOnUnload = true })` would remove the global stubs and
the listener leak (one per instance) in tests.

```diff
-export function createProgression(ctx: GameContext): Progression {
+export function createProgression(
+  ctx: GameContext,
+  opts: { storage?: Pick<Storage, 'getItem' | 'setItem'>; autoSaveOnUnload?: boolean } = {},
+): Progression {
+  const storage = opts.storage ?? localStorage;
 …
-  window.addEventListener('beforeunload', save);
+  if (opts.autoSaveOnUnload !== false) window.addEventListener('beforeunload', save);
```
(`readProgress()` would take the same optional `storage` argument.)
