# Handoff — 2026-10-15

Repo: https://github.com/Sporedd/orbital-concourse (private), branch `main`. Everything is committed; working tree clean at handoff.

## State
- Playable: `npm run dev` → http://localhost:5173 (audio starts muted; M unmutes). Co-op: `npm run relay` + F2.
- `npm run test:all` = typecheck + 377 vitest tests + standing/gear/net smoke suites. All green.
- Docs: PLAN.md (roadmap, §13 latest requirements), docs/ART_DIRECTION.md, docs/SKILL_TREE.md, docs/ECONOMY.md, docs/INTEGRATION_NOTES.md.

## Done since the previous handoff
- Class skill trees (4 classes, Pit tree, actives on Q, all nodes live).
- ADS on right mouse with per-weapon zoom; accuracy stat with bloom.
- Reload animations per archetype; grenade throw animation (world grenade spawns at release).
- Dark industrial-metal music (music.setBossPhase wired).
- Gear is meta progression: scrip from salvaged/expired weapons and round bounties, shop (B), upgrade bay, pit stop that waits for Continue, class starter weapons, XP curve 100·L^1.1.

## Open items (from agent reports)
- Co-op: client loot mirror never emits loot:expired (no expiry salvage on clients); Deadeye only slows the host sim; Bash knockback on clients is overwritten by snapshots.
- Teammate avatars and first-person gloves don't refresh after a gear upgrade until re-equipped (compare by id only).
- Economy balance is first-pass; prices/costs unchecked against real income.
- Start menu has nine rows and crowds the league plaque at 720p.
- Glass Jaw: −40 % shield vs the suggested −50 % regen penalty (design call).
- Not started: hub scene (M7), objectives (M9), rivals (M10), weapon parts (M11), daily arena (M13), ship (M14).
