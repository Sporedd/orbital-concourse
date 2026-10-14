/**
 * System A — rendering. Toon/glow material factory, post-processing pipeline
 * (ink outlines, bloom, grade, FXAA), sky, snow and pooled effects.
 */
import type { Fx, GameContext, MaterialFactory } from '@/core/types';
import { createMaterialFactoryImpl } from './materials';
import { createFxImpl } from './fx';
import { setupRenderingImpl, type RenderPipeline } from './pipeline';

export type { RenderPipeline };

export function createMaterialFactory(): MaterialFactory {
  return createMaterialFactoryImpl();
}

export function createFx(ctx: GameContext): Fx {
  return createFxImpl(ctx);
}

export function setupRendering(ctx: GameContext): RenderPipeline {
  return setupRenderingImpl(ctx);
}
