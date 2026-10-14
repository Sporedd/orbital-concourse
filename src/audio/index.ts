/**
 * System E — audio. Everything is synthesized with the Web Audio API.
 *
 * createAudio(ctx) returns the AudioSystem and subscribes to the gameplay events itself;
 * other systems only call play() directly for: empty, explosion, spitter_shot, bomber_fuse,
 * boss_roar (telegraphs), ui_click, ui_open.
 *
 * The AudioContext is created lazily on the first resume() (or first pointer/key gesture,
 * as a fallback), so nothing is heard before the player has interacted with the page.
 */
import type * as THREE from 'three';
import type { AudioSystem, GameContext, MusicState, RoundPhase, SfxName } from '@/core/types';
import { Wind } from './ambience';
import { AudioEngine, DEFAULT_VOLUMES, spatialize, type BusName } from './engine';
import { Music } from './music';
import { SFX, SFX_META } from './sfx';

export { DEFAULT_VOLUMES, type BusName } from './engine';

/** Extra mixer controls on the object returned by createAudio (cast to reach them). */
export interface AudioMixer {
  setVolume(bus: BusName, value: number): void;
  getVolume(bus: BusName): number;
}

const PHASE_MUSIC: Record<RoundPhase, MusicState> = {
  idle: 'menu',
  intermission: 'intermission',
  wave: 'wave',
  boss: 'boss',
  cleared: 'cleared',
  gameover: 'dead',
};

type PlayOpts = { position?: THREE.Vector3; volume?: number; pitch?: number };

export function createAudio(ctx: GameContext): AudioSystem {
  let engine: AudioEngine | null = null;
  let music: Music | null = null;
  let wind: Wind | null = null;
  let wantedMusic: MusicState | null = null;
  const volumes = { ...DEFAULT_VOLUMES };
  const lastPlayed = new Map<SfxName, number>();

  // Mute-all: ALWAYS starts muted; unmuting (M / sound button) lasts for the session only.
  // Implemented by driving the master bus to 0. The key is still written for diagnostics.
  const MUTE_KEY = 'concourse.audio.muted';
  let muted = true;

  function applyMute(): void {
    engine?.setVolume('master', muted ? 0 : volumes.master);
  }

  function setMuted(m: boolean): void {
    muted = m;
    try { localStorage.setItem(MUTE_KEY, String(m)); } catch { /* ignore */ }
    applyMute();
    ctx.events.emit('ui:message', { text: m ? 'Audio muted' : 'Audio on', duration: 1.5 });
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat) setMuted(!muted);
  });

  function ensure(): AudioEngine | null {
    if (engine) return engine;
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      engine = new AudioEngine(new AC({ latencyHint: 'interactive' }));
    } catch (err) {
      console.warn('[audio] could not create AudioContext', err);
      return null;
    }
    for (const k of Object.keys(volumes) as BusName[]) engine.setVolume(k, volumes[k]);
    applyMute();
    music = new Music(engine);
    wind = new Wind(engine);
    wind.start();
    if (wantedMusic) music.set(wantedMusic);
    return engine;
  }

  function resume(): void {
    const e = ensure();
    if (e && e.ac.state !== 'running') e.ac.resume().catch(() => {});
  }

  // Fallback unlock: the first real gesture anywhere resumes the context.
  const unlock = () => {
    resume();
    if (engine && engine.ac.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  function play(name: SfxName, opts?: PlayOpts): void {
    const e = engine;
    if (!e || e.ac.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    const meta = SFX_META[name];
    const now = e.ac.currentTime;
    const last = lastPlayed.get(name);
    if (last !== undefined && now - last < (meta.interval ?? 0.03)) return;

    let level = (opts?.volume ?? 1) * (meta.gain ?? 1);
    let pan = 0;
    let cutoff = 0;
    if (opts?.position) {
      const s = spatialize(ctx.camera, opts.position);
      level *= s.att;
      pan = s.pan;
      cutoff = s.cutoff;
    }
    if (level < 0.003) return;

    const vary = meta.vary ?? 0.06;
    const pitch = Math.max(0.1, (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * vary));
    const v = e.allocate(level, pan, cutoff);
    if (!v) return;
    lastPlayed.set(name, now);
    try {
      fn(v, now + 0.003, pitch);
      if (meta.echo) v.echo(e.echoIn, meta.echo);
    } catch (err) {
      console.error(`[audio] sfx ${name} failed`, err);
    }
    v.finalize();
  }

  function setMusic(state: MusicState): void {
    wantedMusic = state;
    music?.set(state);
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  const isLocal = (playerId?: string): boolean => {
    const local = ctx.players?.local ?? ctx.player;
    return !playerId || !local || playerId === local.id;
  };

  const ev = ctx.events;
  let hitCounter = 0;
  const deadIds = new Set<string>();
  const markDead = (id: string): boolean => {
    if (deadIds.has(id)) return false;
    if (deadIds.size > 256) deadIds.clear();
    deadIds.add(id);
    return true;
  };

  ev.on('weapon:fired', (p) => {
    const name = `shot_${p.weapon.archetype}` as SfxName;
    if (isLocal(p.playerId)) play(name);
    else play(name, { position: p.origin });
  });
  ev.on('weapon:reload', (p) => {
    if (isLocal(p.playerId)) play('reload');
  });
  ev.on('weapon:equipped', (p) => {
    if (isLocal(p.playerId)) play('equip');
  });
  ev.on('player:melee', (p) => {
    if (isLocal(p.playerId)) play('melee');
  });
  ev.on('player:grenade', (p) => {
    if (isLocal(p.playerId)) play('grenade_throw');
    else play('grenade_throw', { position: p.position });
  });

  ev.on('damage:dealt', (p) => {
    if (p.amount <= 0) return;
    if (isLocal(p.playerId)) play(p.crit ? 'crit' : 'hit', { volume: p.crit ? 0.9 : 0.7 });
    if (p.killed) {
      const enemy = ctx.enemies?.get(p.enemyId);
      // Bosses are voiced by enemy:killed (boss_die); unknown ids are left to enemy:killed too.
      if (enemy && !enemy.isBoss && markDead(p.enemyId)) play('enemy_die', { position: p.point });
      return;
    }
    hitCounter++;
    if (hitCounter % 3 === 0) play('enemy_hurt', { position: p.point, volume: 0.8 });
  });

  ev.on('enemy:killed', (p) => {
    if (!markDead(p.enemy.id)) return;
    if (p.isBoss) play('boss_die');
    else play('enemy_die', { position: p.position });
  });
  ev.on('boss:spawned', () => play('boss_roar'));

  ev.on('player:damaged', (p) => {
    if (!isLocal(p.playerId) || p.amount <= 0) return;
    play('player_hurt', { volume: 0.6 + Math.min(0.4, p.amount / 50) });
  });

  // Shield: break on the broken edge; recharge once when the shield starts climbing again.
  let lastShield = -1;
  let lastBroken = false;
  let rechargeLatched = false;
  ev.on('player:shield', (p) => {
    if (!isLocal(p.playerId)) return;
    if (p.broken && !lastBroken) play('shield_break');
    if (p.shield < lastShield || p.shield >= p.maxShield) rechargeLatched = false;
    const climbing = lastShield >= 0 && p.shield > lastShield;
    const unbroke = lastBroken && !p.broken; // "recharge started" emitted as broken → false
    if (!p.broken && !rechargeLatched && p.shield < p.maxShield && (climbing || unbroke)) {
      play('shield_recharge');
      rechargeLatched = true;
    }
    lastShield = p.shield;
    lastBroken = p.broken;
  });
  ev.on('player:died', (p) => {
    if (isLocal(p.playerId)) play('player_die');
  });

  ev.on('loot:pickup', (p) => {
    if (!isLocal(p.playerId)) return;
    play(p.item.kind === 'weapon' ? 'pickup_weapon' : 'pickup');
  });
  ev.on('level:up', (p) => {
    if (isLocal(p.playerId)) play('levelup');
  });
  ev.on('skill:changed', () => play('skill_up'));

  ev.on('round:started', () => play('round_start'));
  ev.on('round:cleared', () => play('round_clear'));
  ev.on('round:phase', (p) => setMusic(PHASE_MUSIC[p.phase] ?? 'menu'));
  ev.on('ui:screen', (p) => {
    if (p.screen === 'start') setMusic('menu');
  });

  // ---------------------------------------------------------------------------
  const system: AudioSystem & AudioMixer = {
    play,
    setMusic,
    resume,
    update(dt: number) {
      if (!engine) return;
      engine.sweep();
      wind?.update(dt);
    },
    get muted() {
      return muted;
    },
    setMuted,
    setVolume(bus: BusName, value: number) {
      volumes[bus] = value;
      if (bus === 'master') applyMute();
      else engine?.setVolume(bus, value);
    },
    getVolume(bus: BusName) {
      return volumes[bus];
    },
  };
  return system;
}
