/**
 * Headless GameContext for tests: real THREE.Scene/PerspectiveCamera, stub renderer,
 * fake MaterialFactory, recording no-op Fx/Audio, real EventBus, seeded rng, fake Input,
 * and a flat world built on the real Collision class (optionally with boxes).
 *
 * Systems are left unset (like main.ts before boot); tests assign the ones they need,
 * real or fake. Everything here works in both the 'node' and 'jsdom' environments.
 */
import * as THREE from 'three';
import { ARENA, CAMERA, PLAYER } from '@/core/config';
import { EventBus, type EventName, type GameEvents } from '@/core/events';
import type { Input } from '@/core/input';
import { createRng } from '@/core/rng';
import type {
  AudioSystem, DamageOpts, Enemy, Fx, GameContext, Hud, MaterialFactory, PlayerState, PlayerStats,
  Progression, ToonOptions, WeaponDef, WorldQuery,
} from '@/core/types';
import { Collision } from '@/world/collision';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
/** Same public surface as core/input.ts Input, driven programmatically. */
export class FakeInput {
  uiCaptured = false;
  isLocked = true;
  readonly down = new Set<string>();
  readonly pressed = new Set<string>();
  readonly released = new Set<string>();
  readonly mouseDownSet = new Set<number>();
  readonly mousePressedSet = new Set<number>();
  dx = 0;
  dy = 0;
  wheel = 0;

  readonly locked = () => this.isLocked;
  lock(): void { this.isLocked = true; }
  unlock(): void { this.isLocked = false; }

  isDown(code: string): boolean { return !this.uiCaptured && this.down.has(code); }
  justPressed(code: string): boolean { return !this.uiCaptured && this.pressed.has(code); }
  justReleased(code: string): boolean { return !this.uiCaptured && this.released.has(code); }
  rawJustPressed(code: string): boolean { return this.pressed.has(code); }
  mouseIsDown(button = 0): boolean { return !this.uiCaptured && this.mouseDownSet.has(button); }
  mouseJustPressed(button = 0): boolean { return !this.uiCaptured && this.mousePressedSet.has(button); }
  rawMouseJustPressed(button = 0): boolean { return this.mousePressedSet.has(button); }
  mouseDelta(): { dx: number; dy: number } { return this.uiCaptured ? { dx: 0, dy: 0 } : { dx: this.dx, dy: this.dy }; }
  wheelDelta(): number { return this.uiCaptured ? 0 : this.wheel; }

  // drivers
  press(code: string): void { this.down.add(code); this.pressed.add(code); }
  release(code: string): void { this.down.delete(code); this.released.add(code); }
  mousePress(button = 0): void { this.mouseDownSet.add(button); this.mousePressedSet.add(button); }
  mouseRelease(button = 0): void { this.mouseDownSet.delete(button); }
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressedSet.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }
}

// ---------------------------------------------------------------------------
// Materials / Fx / Audio
// ---------------------------------------------------------------------------
export function createFakeMaterials(): MaterialFactory {
  return {
    toon(opts: ToonOptions) {
      const m = new THREE.MeshToonMaterial({ color: opts.color });
      if (opts.emissive !== undefined) m.emissive.set(opts.emissive);
      if (opts.emissiveIntensity !== undefined) m.emissiveIntensity = opts.emissiveIntensity;
      return m;
    },
    glow(color, intensity = 1) {
      const m = new THREE.MeshBasicMaterial({ color });
      m.color.multiplyScalar(intensity);
      return m;
    },
  };
}

export interface FxCall { name: keyof Fx; args: unknown[] }

export function createFakeFx(): Fx & { calls: FxCall[]; count(name: keyof Fx): number } {
  const calls: FxCall[] = [];
  const rec = (name: keyof Fx) => (...args: unknown[]) => { calls.push({ name, args }); };
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    tracer: rec('tracer'),
    impact: rec('impact'),
    explosion: rec('explosion'),
    burst: rec('burst'),
    shake: rec('shake'),
    flash: rec('flash'),
    update: () => {},
  };
}

export function createFakeAudio(): AudioSystem & { played: string[] } {
  const played: string[] = [];
  return {
    played,
    play(name) { played.push(name); },
    setMusic() {},
    resume() {},
    muted: true,
    setMuted() {},
    update() {},
  };
}

export function createFakeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const stub = {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0 },
    outputColorSpace: THREE.SRGBColorSpace,
    setPixelRatio() {},
    getPixelRatio: () => 1,
    setSize() {},
    getSize: (v: THREE.Vector2) => v.set(1280, 720),
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720),
    render() {},
    compile() {},
    dispose() {},
    setRenderTarget() {},
    getRenderTarget: () => null,
    setClearColor() {},
    clear() {},
    capabilities: { isWebGL2: true, maxTextures: 16 },
    info: { render: { calls: 0, triangles: 0 }, memory: {} },
  };
  return stub as unknown as THREE.WebGLRenderer;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export type BoxSpec = [minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number];

export interface FlatWorld extends WorldQuery {
  readonly col: Collision;
}

/** Flat arena (±ARENA.halfSize) using the real Collision class, plus optional boxes. */
export function createFlatWorld(rng: () => number, boxes: BoxSpec[] = []): FlatWorld {
  const half = ARENA.halfSize;
  const col = new Collision(half);
  for (const b of boxes) col.addBox(...b);
  const playerStart = new THREE.Vector3(0, 0, half - 6);
  const bossSpawn = new THREE.Vector3(0, 0, -14);
  const mobSpawnPoints = [
    new THREE.Vector3(-24, 0, -29), new THREE.Vector3(24, 0, -29),
    new THREE.Vector3(-29, 0, 0), new THREE.Vector3(29, 0, 0),
    new THREE.Vector3(0, 0, -29),
  ];
  return {
    col,
    playerStart,
    bossSpawn,
    mobSpawnPoints,
    groundHeight: (x, z) => col.groundHeight(x, z),
    resolveCapsule: (p, r, h) => col.resolveCapsule(p, r, h),
    raycast: (o, d, max) => col.raycast(o, d, max, half + 40),
    randomNavigablePoint(from, minDist = 0) {
      const lim = half - 2;
      for (let i = 0; i < 80; i++) {
        const x = (rng() * 2 - 1) * lim;
        const z = (rng() * 2 - 1) * lim;
        if (col.isBlocked(x, z, 0.9)) continue;
        if (from && minDist > 0 && Math.hypot(x - from.x, z - from.z) < minDist) continue;
        return new THREE.Vector3(x, 0, z);
      }
      return mobSpawnPoints[0].clone();
    },
    update() {},
  };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------
export interface FakePlayer extends PlayerState {
  position: THREE.Vector3;
  alive: boolean;
  yaw: number;
  weapons: (WeaponDef | null)[];
  calls: { method: string; args: unknown[] }[];
}

/** Lightweight PlayerState that records calls (for loot/rounds/enemy tests). */
export function createFakePlayer(id: string, position = new THREE.Vector3(), isLocal = true): FakePlayer {
  const calls: { method: string; args: unknown[] }[] = [];
  const p: FakePlayer = {
    id,
    name: id,
    isLocal,
    position,
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    health: PLAYER.maxHealth,
    maxHealth: PLAYER.maxHealth,
    shield: PLAYER.maxShield,
    maxShield: PLAYER.maxShield,
    alive: true,
    weapons: [null, null],
    activeSlot: 0,
    get activeWeapon() { return p.weapons[0]; },
    grenades: 2,
    ammo: 0,
    reserve: 0,
    calls,
    takeDamage(amount: number, opts?: DamageOpts) {
      calls.push({ method: 'takeDamage', args: [amount, opts] });
      if (!p.alive) return;
      p.health = Math.max(0, p.health - amount);
      if (p.health <= 0) p.alive = false;
    },
    heal(amount: number) {
      calls.push({ method: 'heal', args: [amount] });
      p.health = Math.min(p.maxHealth, p.health + amount);
    },
    addAmmo(fraction: number) { calls.push({ method: 'addAmmo', args: [fraction] }); },
    addGrenades(n: number) {
      calls.push({ method: 'addGrenades', args: [n] });
      p.grenades = Math.min(PLAYER.maxGrenades, p.grenades + n);
    },
    equip(weapon: WeaponDef) {
      calls.push({ method: 'equip', args: [weapon] });
      const empty = p.weapons.findIndex((w) => !w);
      if (empty >= 0) {
        p.weapons[empty] = weapon;
        return null;
      }
      const old = p.weapons[0];
      p.weapons[0] = weapon;
      return old;
    },
    reset() {
      calls.push({ method: 'reset', args: [] });
      p.alive = true;
      p.health = p.maxHealth;
      p.shield = p.maxShield;
    },
    revive(fraction: number) {
      calls.push({ method: 'revive', args: [fraction] });
      if (p.alive) return;
      p.alive = true;
      p.health = Math.max(1, p.maxHealth * fraction);
      p.shield = 0;
    },
    loadout: {},
    onGround: true,
  };
  return p;
}

export const callsOf = (p: FakePlayer, method: string) => p.calls.filter((c) => c.method === method);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
export interface FakeContextOptions {
  seed?: number;
  world?: WorldQuery | 'flat' | 'none';
  boxes?: BoxSpec[];
  input?: Input | FakeInput;
  canvas?: HTMLCanvasElement;
  uiRoot?: HTMLElement;
}

export type TestContext = GameContext & {
  fx: ReturnType<typeof createFakeFx>;
  audio: ReturnType<typeof createFakeAudio>;
  fakeInput: FakeInput;
};

export function createFakeContext(opts: FakeContextOptions = {}): TestContext {
  const hasDom = typeof document !== 'undefined';
  const canvas = opts.canvas ?? (hasDom ? document.createElement('canvas') : ({} as HTMLCanvasElement));
  const uiRoot = opts.uiRoot ?? (hasDom ? document.createElement('div') : ({} as HTMLElement));
  const fakeInput = opts.input instanceof FakeInput ? opts.input : new FakeInput();
  const input = (opts.input ?? fakeInput) as unknown as Input;
  let idCounter = 0;
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far),
    renderer: createFakeRenderer(canvas),
    canvas,
    uiRoot,
    input,
    events: new EventBus(),
    time: { delta: 0, elapsed: 0 },
    rng: createRng(opts.seed ?? 12345),
    isHost: true,
    nextId: (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`,
    materials: createFakeMaterials(),
    fx: createFakeFx(),
    audio: createFakeAudio(),
    fakeInput,
  } as unknown as TestContext;
  const world = opts.world ?? 'flat';
  if (world === 'flat') ctx.world = createFlatWorld(() => ctx.rng(), opts.boxes);
  else if (world !== 'none') ctx.world = world;
  return ctx;
}

export function fakeHud(screen: Hud['screen'] = 'none'): Hud {
  let s = screen;
  return { get screen() { return s; }, showScreen(x) { s = x; }, update() {} };
}

export function fakeProgression(stats: Partial<PlayerStats> = {}): Progression {
  return {
    level: 1, xp: 0, xpToNext: 100, skillPoints: 0,
    stats: {
      damageMult: 1, fireRateMult: 1, reloadMult: 1, critMult: 1, healthMult: 1, shieldMult: 1, moveSpeedMult: 1,
      ...stats,
    },
    skills: [],
    rank: () => 0, canUpgrade: () => false, upgrade: () => false, addXp() {}, save() {}, load() {}, resetTree() {},
  };
}

// ---------------------------------------------------------------------------
// Event recording
// ---------------------------------------------------------------------------
export interface Recorder {
  readonly log: { name: EventName; payload: unknown }[];
  of<K extends EventName>(name: K): GameEvents[K][];
  count(name: EventName): number;
  clear(): void;
}

/** Record every emitted event (wraps bus.emit). */
export function recordEvents(bus: EventBus): Recorder {
  const log: { name: EventName; payload: unknown }[] = [];
  const orig = bus.emit.bind(bus);
  bus.emit = ((name: EventName, payload: unknown) => {
    log.push({ name, payload });
    orig(name as never, payload as never);
  }) as EventBus['emit'];
  return {
    log,
    of: <K extends EventName>(name: K) => log.filter((e) => e.name === name).map((e) => e.payload as GameEvents[K]),
    count: (name) => log.filter((e) => e.name === name).length,
    clear: () => { log.length = 0; },
  };
}

// ---------------------------------------------------------------------------
// Simple fake enemy (a box mesh) for weapon tests
// ---------------------------------------------------------------------------
export interface FakeEnemy extends Enemy {
  hits: { amount: number; opts?: DamageOpts }[];
  statuses: unknown[];
  health: number;
  mesh: THREE.Mesh;
  critAbove: number;
}

/**
 * A 1×2×1 box standing at `pos` (feet). Hits whose point is above `critAbove` (world y)
 * are crits. Records every damage call.
 */
export function createFakeEnemy(id: string, pos: THREE.Vector3, critAbove = pos.y + 1.6, health = 1e6): FakeEnemy {
  const geo = new THREE.BoxGeometry(1, 2, 1);
  geo.translate(0, 1, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  const root = new THREE.Group();
  root.add(mesh);
  root.position.copy(pos);
  root.updateMatrixWorld(true);
  const e: FakeEnemy = {
    id,
    hits: [],
    statuses: [],
    health,
    mesh,
    critAbove,
    state: {
      id, kind: 'grunt', isBoss: false, tier: 1, position: pos, yaw: 0, health, maxHealth: health,
      alive: true, phase: 0, anim: 'idle', statuses: [],
    },
    object: root,
    isBoss: false,
    position: pos,
    get alive() { return e.health > 0; },
    radius: 0.5,
    height: 2,
    isCritPoint: (point) => point.y >= e.critAbove,
    damage(amount, opts) {
      e.hits.push({ amount, opts });
      const applied = Math.max(0, Math.min(amount, e.health));
      e.health -= amount;
      e.state.health = e.health; // real enemies keep state.health live
      return applied; // contract: damage() returns the damage actually applied
    },
    applyStatus(st) { e.statuses.push(st); },
  };
  return e;
}
