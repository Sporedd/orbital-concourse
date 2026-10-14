# System F — co-op networking: integration

> **Status (2026-10-14): applied by the integration pass.** The diffs below are kept as design
> notes; the code has moved on (see `docs/INTEGRATION_NOTES.md` for what landed where, the
> contract changes and what is still open).

Host-authoritative over a WebSocket relay (PLAN §9). Nothing outside `src/net/` and
`server/` was edited; the lead applies the patch below.

## Run it

```
npm run relay            # ws://localhost:8787  (--port N or RELAY_PORT=N; RELAY_HOST to bind)
npm run dev              # two tabs/browsers → F2 opens the lobby → Host in one, Join <code> in the other
npm run test:net         # headless: protocol unit checks, relay test, end-to-end session test
```

Relay URL in the browser: `?relay=ws://host:port` query param, else `VITE_RELAY_URL`,
else `ws(s)://<page hostname>:8787`.

## 1. main.ts patch (required, minimal)

```diff
--- a/src/main.ts
+++ b/src/main.ts
@@
 import { createHud } from './ui';
 import { createAudio } from './audio';
+import { createNetSession, mountLobby } from './net';
@@
 ctx.rounds = createRoundManager(ctx);
 const pipeline = setupRendering(ctx);
+// Co-op (system F). The session swaps ctx.enemies / ctx.loot / ctx.isHost itself when it joins as a client.
+const net = createNetSession(ctx);
+const lobby = mountLobby(ctx, net, { hotkey: 'F2' });
@@
   ctx.hud.update(dt); // first: decides whether a screen captures input this frame
   const paused = ctx.hud.screen !== 'none';
+  net.update(dt); // every frame, also while paused: snapshots, interpolation, avatars, input ticks
   ctx.world.update(dt);
@@
 // Dev convenience
 (window as any).game = ctx;
+(window as any).net = net;
+(window as any).lobby = lobby;
```

`net.update(dt)` must run before `localPlayer.update(dt)` (mirrored enemies are positioned
before the local hitscan) and outside the `paused` block (snapshots keep flowing in menus).

Optional: a "Co-op" button on the start screen (src/ui/screens.ts) that calls `lobby.show()`
(stop the click from propagating so it does not start the run).

## 2. Optional main.ts tweak: don't freeze the shared sim while the host is in a menu

Today the host's pause/skills/start screen freezes enemies, loot and rounds for everyone.
For co-op the host should keep simulating while clients are connected:

```diff
-  const paused = ctx.hud.screen !== 'none';
+  const paused = ctx.hud.screen !== 'none';
+  const simPaused = paused && !(net.role === 'host' && net.peers.length > 1);
   ctx.world.update(dt);
-  if (!paused) {
-    // Simulation freezes while any screen (start, pause, skills, game over) is open.
-    localPlayer.update(dt);
-    ctx.enemies.update(dt);
-    ctx.loot.update(dt);
-    ctx.rounds.update(dt);
-    ctx.fx.update(dt);
-  }
+  if (!paused) localPlayer.update(dt);
+  if (!simPaused) {
+    ctx.enemies.update(dt);
+    ctx.loot.update(dt);
+    ctx.rounds.update(dt);
+    ctx.fx.update(dt);
+  }
```
(The round manager also freezes its own clock on the host's pause/skills screen — see
src/rounds/index.ts `update()`; that would need the same co-op exception.)

## 3. How it plugs in (no other system changes needed)

| | Host | Client |
|---|---|---|
| `ctx.isHost` | stays `true` | set to `false` on join (rounds / progression / loot sims are already gated) |
| `ctx.players` | + one `RemotePlayer` per client (input-driven position, authoritative health/shield) | local player only; other players are avatars |
| `ctx.enemies` | real EnemyManager | `MirrorEnemyRegistry` (rigs from `enemies/models.ts`, interpolated 100 ms behind) |
| `ctx.loot` | real LootSystem; client-owned items go into that client's snapshot | `LootMirror` (loot view + local pickup checks, host confirms) |
| `ctx.rounds.state` | real | fields overwritten from snapshots; round:* events re-emitted so the HUD is unchanged |
| `ctx.fx` | tracer/impact/explosion/burst wrapped → recorded → replayed on clients | tracer/impact/explosion wrapped → sent up → replayed on host (+ other clients) |

On leave everything is restored (`ctx.isHost`, original `ctx.enemies` / `ctx.loot`, fx).

Client shots: the local `WeaponSystem` is untouched. It traces against the mirrored rigs
and calls `enemy.damage()`, which on a mirror records a **hit claim** (enemy id, point
relative to the enemy, crit, amount, element, status roll). On `weapon:fired` the claims are
packed into a `fire` record with origin/direction/weapon stats/skill multipliers. The host
validates every claim (`src/net/hitscan.ts`: enemy alive, point on the body, in range with
4 m lag tolerance, no wall between the shooter's eye and the point it hit, damage ≤ the
weapon's crit cap) and applies it with `sourceId` = that client. A `fire` without claims is
traced by the host itself (`hostHitscan`: pellets, spread × movement, isCritPoint,
damage × damageMult, × critMultiplier × critMult on crits). Melee hits arrive as unattached
claims, grenades/splash as area damage, lifesteal as heals, own-grenade damage as self damage.

Revives (host-side): a downed player (alive = false) is revived by any living player within
2.2 m holding **E** for 3 s (35 % health). Prompts go out as `ui:message`; the avatar name
tag shows `DOWN — hold E` / `REVIVING n%`. Game over still triggers only when everyone is
down (existing rounds logic).

XP: the host's progression awards XP for every kill (shared); clients get the same by
calling `progression.addXp()` on relayed `enemy:killed` / `round:cleared`.

## 4. Contract gaps (worked around locally — please consider adding)

1. **Enemy projectiles are private.** `host.ts` reads `EnemyManager.projectiles.shots/shells`
   structurally. Suggest `ProjectileSystem.snapshot(): {shots, shells}` (plain data).
2. **EnemyState lacks `frozen` / `shielded`.** Read structurally from `EnemySimState`
   (`frozen`, summoner `shield`). Suggest adding `frozen: boolean` / `immune: boolean` to EnemyState.
3. **Enemy geometry is not exported.** `enemyMirror.ts KIND_INFO` duplicates radius / height /
   centre / head & weak-point radius per kind from the `CFG` constants. Suggest exporting a
   `ENEMY_CONFIGS` table from `src/enemies`.
4. **LootSystem has no `remove(id)` / `add(item)`.** The host removes picked-up client items by
   splicing `loot.items()` (the live array); weapons a client swaps out are dropped as
   client-local items. `HEALTH_PICKUP` / `AMMO_PICKUP` are duplicated in `lootMirror.ts`.
5. **PlayerState has no `revive()` / external vitals setter.** Revive uses `reset()` and then
   restores position/grenades (side effects: ammo refilled, yaw faces the arena centre).
   Health/shield are written through the public fields as specified.
6. **Every peer's local player id is `'p1'`.** The host renames a colliding client (`p1-n2`)
   and tells it in the welcome; the client maps ids back. A unique local id at boot
   (`createPlayer(ctx, { id: \`p_${crypto.randomUUID().slice(0, 8)}\`, ... })`) would remove
   the mapping, but `'p1'` works.
7. **Progression XP is gated by `isHost`.** Clients award XP from relayed events (see above).
8. **Client start/retry buttons** call `rounds.start()`, which is a no-op on a client; the run
   (and restart after game over) is driven by the host. A "waiting for host" label would help.
9. **Direct `ctx.audio.play()` calls in enemy code** don't reach clients. Explosions are voiced
   from replayed fx; boss roar comes from `boss:spawned`; spitter/bomber cues are missing.
10. **Camera shake from enemy slams** (`shakeFrom`) is host-local; clients only shake when hit.

## 5. Protocol summary

Envelope (`relayProtocol.ts`): `host` / `join {code,name,pid,v}` / `leave` / `ping`; relay
answers `welcome {code, peer, host, hostPeer, peers}` / `peer-join` / `peer-leave` / `closed` /
`error {reason}` / `pong`. Game payloads ride in `{t:'g', to?, d}` (host: `to` = one peer or
all; client: always to the host; the relay stamps `from`). JSON text frames only.

Game (`protocol.ts`), compact keys, floats quantised to 2 decimals:
- `w` welcome (host → client): the client's host-side player id, host's id, host clock.
- `s` snapshot (host → each client, 20 Hz): round tuple, enemies as deltas vs. what that
  client has (new = full record), removed ids, projectiles, all players' public state,
  this client's loot adds/removes, fx not caused by this client, one-shot events
  (round/boss/kill/damage-dealt/hurt/pickup/shot/ui/game over/start).
- `c` client tick (client → host, 30 Hz): position/velocity/yaw/pitch/use/alive/max vitals/
  avatar weapon + batched fires (with claims), hits, area damage, pickup requests, fx, heals,
  self damage.

Measured headless: ~330 B per snapshot with a boss + mobs alive (≈ 7 KiB/s per client).

## 6. Not done / next

- Real two-tab browser test (everything above is verified headless only).
- Start-screen "Co-op" button (src/ui), "waiting for host" state, host-pause policy (§2).
- Host migration, binary encoding, spectator betting, combo kills (PLAN M12 extras).
- Hit markers/damage numbers for client shots arrive one round trip later (host-confirmed);
  a local predicted hit marker would feel snappier.
