# Handoff — 2026-10-14 (end of session)

Repo: https://github.com/Sporedd/orbital-concourse (private), branch `main`, last commit `cf3ed62`.

## State
- Playable at `npm run dev` → http://localhost:5173 (audio starts muted; M unmutes). Co-op: `npm run relay` + F2.
- `npm run test:all` runs typecheck, vitest, standing/gear/net smoke suites. At handoff: 268 tests green excluding `tests/progression` (being rewritten, see below).
- Roadmap: PLAN.md §8. Integration status/leftovers: docs/INTEGRATION_NOTES.md. Art spec: docs/ART_DIRECTION.md.

## Uncommitted work in flight (two Opus agents were still running when the session ended)
1. **Dark industrial-metal music rewrite** — `src/audio/music.ts`, `src/audio/metal.ts` (new), `src/audio/zz_legacy_music_tmp.ts` (temp, delete when done). Goal: DOOM-style drop-tuned riffs, chugs, double-kick for bosses, limiter. Keep the Music class API used by `src/audio/index.ts`.
2. **Class-based skill trees** — `docs/SKILL_TREE.md`, `src/progression/{classes,effects,skills,index}.ts`, `src/ui/screens.ts` skill-tree section, `tests/progression/*`. Goal: 4 classes (Vanguard, Marksman, Technician, Showman) + shared Pit tree, class select screen, old-save migration; actives/player-code nodes tagged with hooks and hidden as "SOON".

Next session: check both compile (`npx tsc --noEmit`) and `npm test` is fully green, then commit each separately and push (standing rule: commit + push each agent's work after tests pass).

## Known open items
- Two-tab co-op was tested once; see docs/INTEGRATION_NOTES.md for caveats (host leaving closes the room; no host migration).
- Hub scene (M7) and objectives (M9) not started; weapon parts/sets (M11), rivals (M10), daily arena (M13) not started.
- Active abilities need player-code wiring once the skill-tree agent reports its hook list.
