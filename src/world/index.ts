/**
 * System A — world: Orbital Concourse, a concrete colosseum on an orbital station
 * (docs/ART_DIRECTION.md §7). Round play floor (r 30) with hazard paint, precast wall with
 * airlock gates (mobs come through them), a north boss gate, pillars, three stand tiers with
 * an instanced crowd, floodlight towers with haze shafts, a roof ring framing the oculus,
 * LED boards and sponsor plates, cover props and a central plinth, plus the league hazards.
 * Static geometry is merged per material; collision is AABBs (round pieces as arc sub-boxes).
 * League dressing: setLeague(id) (default Scrap). Without an explicit setLeague call the world
 * follows ctx.standing's league (and rank tier: +10 % crowd per tier) when that system exists.
 */
import * as THREE from 'three';
import { ARENA } from '@/core/config';
import { createRng } from '@/core/rng';
import type { GameContext, WorldQuery } from '@/core/types';
import { DEFAULT_LEAGUE, GRIM, LEAGUE_STYLE, leagueStyle, type LeagueKey, type LeagueStyle } from '@/rendering/style';
import { createBanners } from './banners';
import { createBoards } from './boards';
import { createChains } from './chains';
import { Collision } from './collision';
import { CROWD_MAX, createCrowd } from './crowd';
import { BARREL_H, BARREL_SITES, createFire } from './fire';
import { createGlows } from './glows';
import { createHazards, type Hazards } from './hazards';
import { ArenaBuilder, GATES } from './props';
import { createSponsors } from './sponsors';
import { createStage } from './stage';

export type { HazardKind, Hazards } from './hazards';

const HALF = ARENA.halfSize;
/** Random points stay well inside the round floor (wall at r 30.5). */
const NAV_R = 27;

/** WorldQuery plus the arena's presentation hooks (league dressing, crowd hype). */
export interface ArenaWorld extends WorldQuery {
  readonly leagueStyle: LeagueStyle;
  /** Switch the arena dressing to a league ('scrap' | 'iron' | 'steel' | 'star' | 'void'). */
  setLeague(league: LeagueKey | string): void;
  /** Crowd excitement 0..1 (from the standing system when present, else a local estimate). */
  readonly hype: number;
  /** League hazards (M9): vent pulls / laser grid / gravity pulse pads / shrinking ring. */
  readonly hazards: Hazards;
}

export function createWorld(ctx: GameContext): ArenaWorld {
  const root = new THREE.Group();
  root.name = 'world';
  ctx.scene.add(root);

  const layoutRng = createRng(0x51e7); // fixed layout: identical on every peer
  const presRng = createRng(0xc0105); // presentation-only
  const col = new Collision(HALF);
  const b = new ArenaBuilder(col, layoutRng);

  // ---- architecture -------------------------------------------------------------------
  b.floor();
  b.paint();
  b.wall();
  for (const g of GATES) {
    if (g.kind === 'boss') b.bossGate(g);
    else b.gate(g);
  }
  b.pillars();
  b.stands();
  b.roof();
  b.plinth();
  b.floorAccentRing();
  b.cables();
  for (const [x, z, y0] of BARREL_SITES) b.burnBarrel(x, z, BARREL_H, y0);

  // ---- cover ---------------------------------------------------------------------------
  b.container(-15, -9, true);
  b.container(16, 8, false);
  b.container(7, -19.5, true);
  b.container(-9.5, 16.5, true);

  for (const [x, z, ry] of [
    [-6, -13, 0], [-3.9, -13.2, 0.25], [11, -5.5, Math.PI / 2], [12.4, -7.2, 0.4],
    [-12.5, 6, 0], [-13.4, 7.4, Math.PI / 2], [20.5, -13.5, 0.3], [-21, -13, -0.3],
    [3.5, 12.5, 0.15], [16.5, 16, 0.6], [-17.5, 19, 0.2], [-3, 21, 0],
  ] as const) b.block(x, z, ry);
  b.block(-5, -13.1, 0.1, 1.2);

  b.barrier(0, -9, 4, true);
  b.barrier(-8.5, 3, 4, false);
  b.barrier(8.5, 3, 4, false);
  b.barrier(-19, 6, 4, false);
  b.barrier(14, -14, 4, true);
  b.barrier(5.5, 17.5, 4, true);
  b.barrier(-14, -20, 4, true);
  b.barrier(22, 3, 4, false);

  b.squarePillar(-10, -3.5);
  b.squarePillar(9.5, 12.5);
  b.squarePillar(-12, -23);
  b.squarePillar(1.5, -24.5);
  b.squarePillar(23, -9);

  b.deck(17.5, -4.5, 22.5, 0.5, 1.8, { dir: 'x-', from: -3.5, to: -0.5, steps: 3 });
  b.deck(-22.5, 0, -17.5, 5, 1.8, { dir: 'x+', from: 1, to: 4, steps: 3 });

  const meshes = b.batch.build(root);
  const ribbonMesh = meshes.find((m) => m.name === 'world-ribbon');
  const inlayMesh = meshes.find((m) => m.name === 'world-inlay');
  const floorRingMesh = meshes.find((m) => m.name === 'world-floorRing');

  // ---- live parts ----------------------------------------------------------------------
  const glows = createGlows(256, presRng);
  root.add(glows.mesh);
  const stage = createStage(ctx.scene, GATES, presRng, glows);
  root.add(stage.group);
  const fire = createFire(glows, presRng);
  root.add(fire.group);
  root.add(createChains(presRng));
  const banners = createBanners();
  root.add(banners.group);
  const crowd = createCrowd(presRng);
  root.add(crowd.mesh);
  const boards = createBoards(GATES);
  root.add(boards.group);
  const sponsors = createSponsors();
  root.add(sponsors.group);
  const hazards = createHazards(ctx, col, stage.puffs, presRng);
  root.add(hazards.group);

  // ---- spawn data ------------------------------------------------------------------------
  const playerStart = new THREE.Vector3(0, 0, 23.5);
  const bossSpawn = new THREE.Vector3(0, 0, -14);
  const mobSpawnPoints: THREE.Vector3[] = [];
  for (const g of GATES) {
    if (g.kind !== 'mob') continue;
    const a = THREE.MathUtils.degToRad(g.angle);
    const c = Math.cos(a), s = Math.sin(a);
    for (const t of [-1.8, 0, 1.8]) {
      const x = c * 28.6 - s * t;
      const z = s * 28.6 + c * t;
      if (col.isBlocked(x, z, 1.2)) continue;
      if (Math.hypot(x - playerStart.x, z - playerStart.z) < 9) continue;
      mobSpawnPoints.push(new THREE.Vector3(x, 0, z));
    }
  }

  // ---- league ------------------------------------------------------------------------------
  let ls: LeagueStyle = LEAGUE_STYLE[DEFAULT_LEAGUE];
  let rankTier = 1;
  /** Set once setLeague() is called explicitly: stop following ctx.standing. */
  let manualLeague = false;
  const fog = new THREE.FogExp2(GRIM.HAZE, ls.fogDensity);
  ctx.scene.fog = fog;
  const crowdCount = () => Math.min(CROWD_MAX, Math.round(ls.crowd * (1 + 0.1 * (rankTier - 1))));
  const applyLeague = (next: LeagueStyle) => {
    ls = next;
    fog.density = ls.fogDensity;
    b.applyLeague(ls);
    stage.setLeague(ls);
    crowd.setLeague(ls);
    crowd.setCount(crowdCount());
    boards.setLeague(ls);
    sponsors.setLeague(ls);
    hazards.setLeague(ls);
    fire.setLeague(ls);
    banners.setLeague(ls);
    if (ribbonMesh) ribbonMesh.visible = ls.ribbon;
    if (inlayMesh) inlayMesh.visible = ls.plinthInlay;
    if (floorRingMesh) floorRingMesh.visible = ls.floorRing;
  };
  applyLeague(ls);

  // ---- crowd + board reactions ---------------------------------------------------------------
  let localHype = 0;
  const killTimes: number[] = [];
  let time = 0;
  let bossName: string | null = null;
  const standing = () => (ctx as unknown as { standing?: { hype?: { modifiers?: { value?: number } }; standing?: { rank?: { name?: string } } } }).standing;

  ctx.events.on('enemy:killed', (e) => {
    crowd.flash((e.isBoss ? 0.03 : 0.003) * ls.crowdFlashMult);
    localHype = Math.min(1, localHype + (e.isBoss ? 1 : 0.06));
    killTimes.push(time);
    while (killTimes.length && time - killTimes[0] > 1.6) killTimes.shift();
    if (killTimes.length >= 3) {
      crowd.wave();
      killTimes.length = 0;
    }
    if (e.isBoss) {
      bossName = null;
      boards.takeover(['VICTORY', 'HEADLINER DOWN'], 4);
      boards.flashRibbons(2);
      sponsors.flash(2);
      crowd.burst(0.03 * ls.crowdFlashMult, 3, 0.4);
      crowd.surge(3);
    }
  });
  ctx.events.on('enemy:spawned', (e) => {
    if (!e.enemy.isBoss) stage.telegraph(e.enemy.position);
  });
  ctx.events.on('boss:spawned', (e) => {
    bossName = (e.name || `The ${e.enemy.state.kind}`).toUpperCase();
    stage.bossEntrance();
    localHype = Math.max(localHype, 0.85);
    // crowd: a flash volley as the spots swing, a bigger burst + everyone up when the doors part
    crowd.flash(0.02 * ls.crowdFlashMult);
    crowd.burst(0.03 * ls.crowdFlashMult, 4, 0.35);
    crowd.surge(4.5);
    boards.takeover(['HEADLINER', bossName], 3.5);
    boards.flashRibbons(3);
    sponsors.flash(3);
  });
  ctx.events.on('loot:dropped', (e) => {
    if (e.item.kind !== 'weapon' || e.item.rarity !== 'legendary') return;
    if (ctx.player && e.item.ownerId && e.item.ownerId !== ctx.player.id) return;
    const p = new THREE.Vector3(e.item.position.x, 0, e.item.position.z);
    stage.spotlight(p, 2, 2);
    crowd.flash(0.03 * ls.crowdFlashMult);
    boards.flashRibbons(2);
    sponsors.flash(2);
    boards.takeover(['LEGENDARY', e.item.weapon?.name?.toUpperCase() ?? 'DROP'], 4);
  });
  ctx.events.on('round:started', (e) => {
    boards.flashRibbons(1.2);
    boards.takeover([`ROUND ${String(e.round).padStart(2, '0')}`, `${ls.name} · FIGHT`], 3);
  });
  ctx.events.on('game:started', () => {
    localHype = 0;
    bossName = null;
  });
  ctx.events.on('player:damaged', (e) => {
    if (ctx.player && e.playerId === ctx.player.id) localHype = Math.max(0, localHype - 0.02);
  });

  const hypeNow = () => {
    const v = standing()?.hype?.modifiers?.value;
    return typeof v === 'number' ? THREE.MathUtils.clamp(v / 100, 0, 1) : localHype;
  };

  const groundExtent = HALF + 40;

  return {
    playerStart,
    mobSpawnPoints,
    bossSpawn,

    get leagueStyle() { return ls; },
    get hype() { return hypeNow(); },
    hazards,
    setLeague(id) {
      manualLeague = true;
      const next = leagueStyle(id);
      if (next !== ls) applyLeague(next);
    },

    groundHeight(x, z) {
      return col.groundHeight(x, z);
    },

    resolveCapsule(position, radius, height) {
      return col.resolveCapsule(position, radius, height);
    },

    raycast(origin, direction, maxDistance) {
      return col.raycast(origin, direction, maxDistance, groundExtent);
    },

    randomNavigablePoint(minDistFrom, minDist = 0) {
      const out = new THREE.Vector3();
      for (let i = 0; i < 80; i++) {
        const a = ctx.rng() * Math.PI * 2;
        const r = Math.sqrt(ctx.rng()) * NAV_R;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (col.isBlocked(x, z, 0.9)) continue;
        out.set(x, 0, z);
        if (minDistFrom && minDist > 0) {
          const dx = x - minDistFrom.x;
          const dz = z - minDistFrom.z;
          if (dx * dx + dz * dz < minDist * minDist) continue;
        }
        return out;
      }
      // fallback: the free spawn point farthest from minDistFrom
      let best = mobSpawnPoints[0] ?? playerStart;
      if (minDistFrom) {
        let bd = -1;
        for (const p of mobSpawnPoints) {
          const d = p.distanceToSquared(minDistFrom);
          if (d > bd) { bd = d; best = p; }
        }
      }
      return out.copy(best);
    },

    update(dt) {
      time += dt;
      // follow the standing system's league + rank tier unless a caller drives setLeague()
      const st = standing()?.standing as { rank?: { league?: string; tier?: number } } | undefined;
      if (!manualLeague && st?.rank?.league) {
        const next = leagueStyle(st.rank.league);
        const tier = Math.max(1, Math.min(5, st.rank.tier ?? 1));
        if (next !== ls) {
          rankTier = tier;
          applyLeague(next);
        } else if (tier !== rankTier) {
          rankTier = tier;
          crowd.setCount(crowdCount());
        }
      }
      const hype = hypeNow();
      if (!standing()) localHype = Math.max(0, localHype - dt * 0.04);
      crowd.setHype(hype);
      crowd.update(dt);
      stage.update(dt);
      fire.update(dt);
      banners.update(dt);
      glows.update(dt);
      sponsors.update(dt);
      hazards.update(dt);
      const rs = ctx.rounds?.state;
      const alive = ctx.enemies ? ctx.enemies.aliveCount() : 0;
      boards.update(dt, {
        round: rs?.round ?? 0,
        hostiles: rs ? (rs.phase === 'boss' ? 1 : Math.max(0, rs.killsRequired - rs.kills)) : alive,
        playerName: ctx.player?.name ?? 'CHALLENGER',
        rankTitle: standing()?.standing?.rank?.name ?? 'FODDER',
        boss: rs?.phase === 'boss' ? bossName : null,
        hype,
        league: ls.name,
      });
    },
  };
}
