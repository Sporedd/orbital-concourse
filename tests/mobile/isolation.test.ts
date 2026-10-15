// @vitest-environment jsdom
/**
 * The mobile layer is a separate module that the desktop never loads: boots the real src/main.ts
 * (every system mocked, so this is only the boot/branching code) under a desktop and a mobile
 * probe and checks that '@/mobile' is fetched, html.mobile is set and the touch overlay exists
 * only in the mobile case. Also checks the static guarantees (one dynamic import in main.ts,
 * the mobile stylesheet scoped under html.mobile, the desktop stylesheet untouched).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMobileDevice } from '@/mobile/detect';

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ---- mocks for everything main.ts boots ----------------------------------------------------------
const loads = vi.hoisted(() => ({ mobile: 0 }));

/** Counts real loads of the mobile module (re-registered per test, after vi.resetModules). */
const watchMobileModule = () =>
  vi.doMock('@/mobile', async (importOriginal) => {
    loads.mobile++;
    return importOriginal();
  });

vi.mock('three', async (importOriginal) => {
  const t = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement: HTMLCanvasElement;
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    private pr = 1;
    constructor(o: { canvas: HTMLCanvasElement }) { this.domElement = o.canvas; }
    setPixelRatio(v: number) { this.pr = v; }
    getPixelRatio() { return this.pr; }
    setSize() {}
    render() {}
  }
  return { ...t, WebGLRenderer: FakeRenderer };
});

const stub = () => ({ update() {}, reset() {} });
vi.mock('@/rendering', () => ({
  createMaterialFactory: () => ({}),
  createFx: () => ({ burst() {}, update() {} }),
  setupRendering: () => ({ render() {}, resize() {}, update() {} }),
}));
vi.mock('@/world', async () => {
  const { Vector3 } = await vi.importActual<typeof import('three')>('three');
  return { createWorld: () => ({ update() {}, playerStart: new Vector3(), raycast: () => null, groundHeight: () => 0 }) };
});
vi.mock('@/player', () => ({
  createPlayer: (_: unknown, o: { id: string }) => ({ id: o.id, reset() {}, update() {}, alive: true, activeWeapon: null }),
  createPlayerRegistry: () => ({ add() {} }),
}));
vi.mock('@/enemies', () => ({ createEnemyManager: () => ({ ...stub(), list: () => [] }) }));
vi.mock('@/loot', () => ({ createLootSystem: stub }));
vi.mock('@/progression', () => ({ createProgression: stub }));
vi.mock('@/standing', () => ({ createStandingSystem: stub }));
vi.mock('@/gear', () => ({ createGearSystem: stub }));
vi.mock('@/gear/economy', () => ({ createEconomy: stub }));
vi.mock('@/net', () => ({ createNetSession: () => ({ ...stub(), inSession: false }), mountLobby: () => ({}) }));
vi.mock('@/rounds', () => ({ createRoundManager: () => ({ ...stub(), state: { phase: 'idle' } }) }));
vi.mock('@/ui', () => ({ createHud: () => ({ screen: 'start', update() {}, showScreen() {} }) }));
vi.mock('@/audio', () => ({ createAudio: () => ({ update() {}, resume() {}, play() {} }) }));

function setProbe(search: string, coarse: boolean, touchPoints: number): void {
  window.history.replaceState({}, '', `/${search}`);
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false, media: q, addEventListener() {}, removeEventListener() {} }));
}

async function bootMain(): Promise<void> {
  await import('@/main');
  // main.ts loads the mobile layer asynchronously; let the dynamic import settle
  for (let i = 0; i < 20 && document.documentElement.dataset.booted !== '1'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if ((window as unknown as { game?: unknown }).game) document.documentElement.dataset.booted = '1';
  }
}

describe('mobile isolation: main.ts boot', () => {
  beforeEach(() => {
    vi.resetModules();
    loads.mobile = 0;
    watchMobileModule();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    document.documentElement.className = '';
    delete document.documentElement.dataset.booted;
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
    document.body.innerHTML = '<canvas id="app"></canvas><div id="ui"></div>';
    delete (window as unknown as { game?: unknown }).game;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('desktop (fine pointer, no touch): the module is never imported, no html.mobile, no overlay', async () => {
    setProbe('', false, 0);
    await bootMain();
    expect((window as unknown as { game?: unknown }).game).toBeTruthy();
    expect(loads.mobile).toBe(0);
    expect(document.documentElement.classList.contains('mobile')).toBe(false);
    expect(document.getElementById('sbm-touch')).toBeNull();
    expect(document.getElementById('sbm-controls')).toBeNull();
    expect(document.getElementById('sbm-styles')).toBeNull();
    expect(document.querySelector('.sbm-rotate')).toBeNull();
    expect((window as unknown as { __mobile?: unknown }).__mobile).toBeUndefined();
  });

  it('touch laptop (fine primary pointer + touch points) stays desktop', async () => {
    setProbe('', false, 10);
    await bootMain();
    expect(loads.mobile).toBe(0);
    expect(document.documentElement.classList.contains('mobile')).toBe(false);
  });

  it('?mobile=0 keeps a phone on the desktop path', async () => {
    setProbe('?mobile=0', true, 5);
    await bootMain();
    expect(loads.mobile).toBe(0);
    expect(document.getElementById('sbm-touch')).toBeNull();
  });

  it('phone (coarse pointer + touch): the module loads, html.mobile and the overlay exist', async () => {
    setProbe('', true, 5);
    await bootMain();
    expect(loads.mobile).toBe(1);
    expect(document.documentElement.classList.contains('mobile')).toBe(true);
    expect(document.getElementById('sbm-touch')).not.toBeNull();
    expect(document.getElementById('sbm-controls')).not.toBeNull();
    expect(document.getElementById('sbm-styles')).not.toBeNull();
    // layers sit around #ui: touch under it, controls over it
    const ui = document.getElementById('ui')!;
    expect(ui.previousElementSibling?.id).toBe('sbm-touch');
    expect(ui.nextElementSibling?.id).toBe('sbm-controls');
    expect(document.querySelector('meta[name="viewport"]')!.getAttribute('content')).toContain('viewport-fit=cover');
  });

  it('?mobile=1 forces the layer on a desktop', async () => {
    setProbe('?mobile=1', false, 0);
    await bootMain();
    expect(loads.mobile).toBe(1);
    expect(document.documentElement.classList.contains('mobile')).toBe(true);
    expect(document.querySelectorAll('.sbm-cluster .sbm-btn').length).toBeGreaterThanOrEqual(8);
  });
});

describe('isMobileDevice', () => {
  it('needs a coarse primary pointer and touch points; ?mobile= overrides', () => {
    expect(isMobileDevice({ search: '', maxTouchPoints: 0, coarse: false })).toBe(false);
    expect(isMobileDevice({ search: '', maxTouchPoints: 10, coarse: false })).toBe(false);
    expect(isMobileDevice({ search: '', maxTouchPoints: 0, coarse: true })).toBe(false);
    expect(isMobileDevice({ search: '', maxTouchPoints: 5, coarse: true })).toBe(true);
    expect(isMobileDevice({ search: '?mobile=1', maxTouchPoints: 0, coarse: false })).toBe(true);
    expect(isMobileDevice({ search: '?quality=low&mobile=0', maxTouchPoints: 5, coarse: true })).toBe(false);
  });
});

describe('static isolation', () => {
  it('main.ts has exactly one dynamic import of @/mobile, behind isMobileDevice()', () => {
    const main = src('src/main.ts');
    expect(main.match(/import\(\s*['"]@\/mobile['"]\s*\)/g)?.length).toBe(1);
    expect(main).toMatch(/if \(isMobileDevice\(\)\) \{\s*\n(\s*\/\/.*\n)?\s*import\('@\/mobile'\)/);
    // static imports from src/mobile: only the detector, plus a type-only import (erased)
    const statics = [...main.matchAll(/^import (type )?.*from '([^']*mobile[^']*)';$/gm)];
    for (const m of statics) expect(m[1] === 'type ' || m[2] === './mobile/detect').toBe(true);
  });

  it('no other source file imports the mobile layer', () => {
    const files = ['src/ui/index.ts', 'src/ui/screens.ts', 'src/ui/styles.ts', 'src/core/input.ts', 'src/player/controller.ts',
      'src/player/index.ts', 'src/rendering/style.ts', 'src/rendering/pipeline.ts'];
    for (const f of files) expect(src(f)).not.toMatch(/@\/mobile|\.\/mobile|\.\.\/mobile/);
  });

  it('every mobile CSS rule is scoped under html.mobile; the desktop sheet has none', async () => {
    const { MOBILE_CSS } = await import('@/mobile/styles');
    const css = MOBILE_CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{([^{}]*\{[^{}]*\})*\s*\}/g, '');
    const selectors: string[] = [];
    const re = /([^{}]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const sel = m[1].trim();
      if (!sel || sel.startsWith('@')) continue;
      selectors.push(...sel.split(',').map((s) => s.trim()));
    }
    expect(selectors.length).toBeGreaterThan(100);
    for (const s of selectors) expect(s.startsWith('html.mobile'), s).toBe(true);
    expect(src('src/ui/styles.ts')).not.toContain('html.mobile');
  });

  it('no mobile text below 12 px', async () => {
    const { MOBILE_CSS } = await import('@/mobile/styles');
    for (const m of MOBILE_CSS.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)) {
      expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(12);
    }
  });
});
