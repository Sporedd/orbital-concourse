/**
 * Mobile layer (phones / tablets). Loaded only by the one dynamic `import('@/mobile')` in
 * src/main.ts after src/mobile/detect.ts said yes; the desktop build never fetches this chunk.
 *
 *   prepareMobile()     before boot: html.mobile, the mobile stylesheet, the viewport, and the
 *                       'mobile' quality preset (the world and the pipeline read it while booting)
 *   installMobile(ctx)  after boot: mobile render settings, the touch overlay driving the
 *                       existing Input through input.attachVirtual(); returns the per-frame hook
 */
import type { GameContext } from '@/core/types';
import { createOverlay, type MobileOverlay } from './overlay';
import { applyMobileRendering, requestMobileQuality } from './quality';
import { createMobileSettings } from './settings';
import { MOBILE_STYLE_ID, injectMobileStyles } from './styles';

export { isMobileDevice } from './detect';

export interface MobileLayer {
  /** Per frame, after ctx.hud.update and before the player update. */
  update(dt: number): void;
  readonly overlay: MobileOverlay;
}

let prepared = false;

export function prepareMobile(): void {
  if (prepared) return;
  prepared = true;
  document.documentElement.classList.add('mobile');
  injectMobileStyles();
  // notch-safe layout (env(safe-area-inset-*) is 0 without viewport-fit=cover), no pinch zoom
  const vp = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (vp) vp.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
  requestMobileQuality();
}

export function installMobile(ctx: GameContext): MobileLayer {
  prepareMobile();
  // after the HUD's own sheet in <head>, so equal-specificity rules resolve to the mobile ones
  const sheet = document.getElementById(MOBILE_STYLE_ID);
  if (sheet) document.head.appendChild(sheet);
  applyMobileRendering(ctx);
  const settings = createMobileSettings();
  const overlay = createOverlay(ctx, ctx.input.attachVirtual(), settings);
  const layer: MobileLayer = { update: (dt) => overlay.update(dt), overlay };
  (window as unknown as Record<string, unknown>).__mobile = { layer, settings };
  return layer;
}
