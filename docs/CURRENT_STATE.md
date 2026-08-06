# Current State

> **Cold start?** Read `START_HERE.md` first. This file is chronological:
> the newest entry is immediately below, older history is archived further
> down under "Historical log".

## 2026-08-06 — In-game HUD rebuilt as one command surface (D-032)

Presentation only. `src/sim/` untouched.

**The defect that mattered:** `.panel` set `pointer-events: none` and
`#research` never overrode it, so every research button passed its click
through to the canvas. `document.elementFromPoint` at the panel centre returned
the CANVAS. The tech system (D-028) had shipped with **no player access at
all**. Panels now default to `pointer-events: auto` and four read-only surfaces
opt out, so that failure mode cannot recur silently.

**Measured, at the baseline's own 1237x604 viewport** (`npm run capture` for
pictures, `node scripts/measure-hud.mjs` for numbers — both need a dev server):

| | before | after (steady) |
|---|---|---|
| HUD share | 49.4% | 23.8% |
| overlapping panel pairs | 5 | 0 |
| distinct panel backgrounds | 5 | 1 |
| panels declaring z-index | 3 / 11 | 8 / 8 |
| buttons a click cannot reach | 3 / 13 | 0 / 13 |

At 1920x1080 the battlefield holds 90.5%; at 1280x800 it holds 82.6%, which is
short of `UI_BLUEPRINT.md`'s 85–90% and is the honest weak point.

**What moved.** The 12-line keybinding wall headed "Phase 1.7 — Squads &
Behaviour Chains" is gone; the tutorial now opens itself once on a first visit
(`localStorage` records completed/skipped/dismissed), and the full reference
lives on `?` / the Keys button in `src/ui/controlsSheet.ts`. The debug readout
moved to `src/ui/debugReadout.ts` and is built **only** under `?dev=`. The
quality selector moved into the reference sheet. New files:
`src/ui/controlsSheet.ts`, `src/ui/debugReadout.ts`, `scripts/measure-hud.mjs`,
`tests/controlsSheet.test.ts`, `tests/debugReadout.test.ts`.

**Fixed in passing:** the minimap drew resource nodes teal, contradicting D-025;
`#build-id` had no `.panel` class so it laid out as a full-width static block.

**Not done:** `#res` still says "essence" while the tutorial and research panel
say "Legacy". D-021 explicitly defers that rename, so it was left alone — but a
player sees both words for one resource.

---

## 🔑 SESSION HANDOFF — 2026-08-06 — read before starting work

**Paused mid-run at the designer's request, ahead of a usage limit. Resume from
"Resume here" below.**

### Where things are

- **369 tests · 72 modules documented · `npm run verify` green.**
- **Working tree has substantial uncommitted work.** It is committed locally on
  branch `session/2026-08-06-gauntlet` — see the commit for the full diff.
  **Nothing has been pushed.** The designer has not authorised a push.
- The dev server runs on `:5173`. `npm run capture` needs it running.

### The three things that matter most

**1. Combat does not work, and this is now proven rather than suspected.**
Three blocking defects, each confirmed by direct measurement this session and
written up with repros in `BUGS.md`:

- **B-005** — a mirrored 10v10 resolves **10–0 for whichever team was pushed
  into `world.units` first**, in exactly 384 ticks either way. `stepCombat`
  walks the array applying damage immediately, so an earlier unit strikes,
  kills, and its victim is gone before it swings back. This is not RNG (D-019
  removed all of it). It invalidates §2's "no spawn point has an inherent
  advantage" and silently invalidates every combat measurement taken on top of
  it. **Fix: two-phase resolution** — read all attack intents against tick-start
  state, then apply, then reap. Do **not** shuffle the array; that trades a
  systematic bias for a seed-dependent one and breaks D-019.
- **B-006** — `COMBAT.acquireRange` is 9.0; a Legionnaire's weapon range is
  **0.9**. Units see enemies ten times further than they can hit them and
  nothing closes the gap: `stepCombat` writes `u.targetId`, `stepMovement` reads
  only `u.target` (a position), and nothing converts one to the other. Measured:
  two 10-unit lines 30 apart, 3600 ticks, **zero damage, zero movement**. The
  selection card advertises "Attack Move — engage along route", which is false.
  **Fix needs a designer call on leash length** — unbounded pursuit turns every
  skirmish into a map-wide rout. Recommendation: leashed pursuit gated by
  `orderMode` so hold-position never wanders, leash as a `tuning.ts` value.
- **B-007** — terrain is not rotationally symmetric. 800 mirrored point-pairs
  across 200 seeds: mean height delta **0.69**, worst **1.36**, 600/800 differ
  by >0.01. With `highGroundBonus` 1.25 / `lowGroundPenalty` 0.85 one spawn owns
  high ground for free. Existing tests assert *position* symmetry only.

**Determinism is not fairness.** `determinism.test.ts` was green through all of
this. A fight decided by array order is perfectly deterministic and perfectly
unfair. Symmetry needs its own assertions.

**2. Seven held-back items were answered by the designer and are now written
down.** Four were §11.1 questions that had been answered in conversation but
never reached a file — a fresh session cannot tell an unrecorded answer from an
unmade decision. `DECISIONS.md` now opens with a standing note about this.
D-031 (no race is humanoid), D-032 (HUD is one surface), D-033 + D-033a
(resource schema; Material is loose, which is an *engine* requirement), D-034
(terrain is terrain), D-035 (air shares supply), D-036 (World Turtle confirmed),
D-037 (night/biome/weather affect play, symmetric).

**3. Scope narrowed by the designer: get Cohort and Mycora working at a basic
level.** Conclave and Titanfolk wait for a roster redesign. Do not spend effort
on their naming or art.

### New tooling — read before trying to look at the game

`npm run capture` drives a real headless Chromium and writes reproducible
screenshots to `.capture/` (gitignored) plus an `index.json` manifest.

**You will probably need it.** Editor-embedded browser surfaces here report
`document.hidden` and fire **zero** `requestAnimationFrame` callbacks — the
render loop never runs, every screenshot is black, and that is indistinguishable
from a genuinely broken game. Do not diagnose a "broken build" from a black
screenshot without checking `document.hidden` first.

Shots name an exact camera state and tick, driven through `loop.stepOnce()` and
the camera's public methods, so there is no capture-only render path. A
`window.__greenmantle` handle exists **only** under `?capture=1`.

### Interrupted work, resumable

The slice-0 HUD gauntlet was stopped mid-critique to avoid a usage limit. The
**builder finished and its work is in the tree** (`controlsSheet.ts`,
`debugReadout.ts`, D-032, HUD rebuild). The three critics and the synthesis step
did not complete. Resume with:

```
Workflow({ scriptPath: "<session>/workflows/scripts/slice0-interface-truth-wf_86a44b30-34e.js",
           resumeFromRunId: "wf_86a44b30-34e" })
```

### Resume here — priority order

1. **B-005, two-phase combat resolution.** Nothing else about combat can be
   measured until this is fixed. Add a symmetry test that fails today.
2. **B-006, pursuit.** Needs the leash decision first — ask, do not guess.
3. **B-007, symmetric terrain.** Make `terrainHeightAt` symmetric under the same
   rotation the boundary already uses, and assert height symmetry.
4. **Finish slice 0** — resume the critic phase above.
5. **B-004, the fog.** Now the loudest thing on screen at every zoom: stair-
   stepped terraces with terrain slivers punching through. `BUGS.md` calls it
   "hard-tiled", which understates it.
6. **Mycora**, per the narrowed scope.

### The one open designer question

**Stealth / detection.** Every other §11.1 item is now resolved. The designer
believes this was settled in conversation; a full search of `docs/` on
2026-08-06 found only restatements of the question, never an answer. It blocks
the Chronicler, and through it D-020's Command Overload mitigation. One written
sentence closes it.

### Environment hazards

1. **The verification gate did not run on Windows.** `check-docs.mjs` resolved
   its root via `new URL('..', import.meta.url).pathname`, which yields `/O:/…`
   and joins into `O:\O:\…`. Fixed. It immediately caught real drift, which
   means the previous session pushed without a green gate.
2. **The git remote resets.** Unchanged from the previous handoff — always
   `git remote -v` before trusting a push.
3. **Usage limits interrupt workflows mid-run.** Both workflows this session hit
   one. `resumeFromRunId` replays completed agents from cache; use it
   immediately rather than reporting the failure and moving on.

### Superseded from the previous handoff

- "Research UI is the single biggest gap" — **done**, and it was worse than
  recorded: the panel shipped with `pointer-events: none` inherited from
  `.panel`, so every research button passed clicks through to the canvas. It was
  unreachable, not merely occluded. Now visible and clickable.
- "340 tests · 68 modules" — now 369 · 72.
- **D-026 World Turtle no longer needs confirming.** D-036 confirms it.

### Known environment hazards

1. **The git remote resets.** Containers are recreated between sessions and
   re-clone from the *original* repo (`Wizard1999/RTS`), silently resetting
   `origin`. This happened **three times** in one session and sent commits to
   the wrong repository. A push to the wrong remote **reports success**.
   Always `git remote -v` before trusting a push. Fix in `START_HERE.md § 0`.
2. **Tag pushes are blocked.** `git push origin <tag>` fails with a proxy
   disconnect/403 — a different permission from repository contents, which
   works fine. `v1.12.0` exists locally and could not be published. Not worth
   chasing: the authoritative version lives in `package.json` and `VERSION`.
   If tags matter later, create the release through the GitHub web UI.
3. **Pushes to `main` intermittently reject** as non-fast-forward even when a
   clean fast-forward is available. Retrying later has worked every time. Do
   not force-push in response to this.

### Decisions taken without designer review

- **D-026 "World Turtle"** — the far-zoom world silhouette — arrived in an
  external import, not from the designer, and is recorded as a *locked*
  presentation direction. It is a real scope addition. **Worth confirming it is
  wanted** before more art is built on it.

### Immediate next work, in priority order

1. **Research UI.** The tech system (D-028) is complete, hashed and replayed —
   and no player can reach it. A whole system is invisible. This is the single
   biggest gap between "Phase 1 complete" and "an alpha that makes sense".
2. **Dev console.** Last unchecked Phase 1 roadmap item; already specced in
   `TODO.md`. Must route through `sim/commands.ts` and be recorded into the
   replay stream, or replays of dev sessions desync.
3. **Soften the fog** (B-004). Colour was fixed (it was pure black, violating
   D-005); the hard tiling is structural and remains.
4. **Outrider unit.** Highest-value roster addition: flanking mechanics already
   exist in combat and nothing currently exploits them.

### Which model to use

Not everything here needs the strongest model. From experience across this
project:

- **Needs the strong model:** anything touching `src/sim/` (determinism is
  subtle and fails silently), the replay/hash format, the mission→squad
  behaviour design, the race-roster abstraction, and vetting external imports.
- **Fine for a cheaper model:** new units and views following existing
  patterns, CSS and landing-page work, documentation prose, tests for systems
  that already have an established test shape, `.bat` launchers.

### Still pending on the designer

- **Rename the GitHub repository** to match the Greenmantle codename. Until
  then `origin` must stay `Wizard1999/Greenmantle` (D-030 explains why an agent
  must not "correct" this).
- Four design blockers remain unanswered in `GAME_DESIGN.md § 11.1` — resource
  naming, stealth/detection, map geometry, air-vs-supply. Each blocks specific
  work listed in `TODO.md`.

---

## ⚡ Latest — renamed to Greenmantle; painterly pass on units and buildings

**340 tests · 68 modules documented · full gate green.**

- **Project renamed Longbarrow → Greenmantle (D-030).** The old name described
  a burial mound — bones — which fit a fossil race on a terrain slab and no
  longer fits four living elemental forces, overgrowth-as-material, and a
  world-bearing turtle. Two things deliberately did *not* change: the GitHub
  repo is still `Wizard1999/Greenmantle` (renaming it is a manual step, and an
  agent "correcting" the remote would break it), and the save-file magic string
  is still `longbarrow-save` (a format identifier, not branding — renaming it
  would orphan every existing save).
- **Painterly materials on units, buildings, scenery and nodes.** Previously
  terrain only. Shared and cached by role/team in `render/materials.ts` —
  per-unit ShaderMaterials would mean 100+ shader compiles mid-battle and break
  the 100-unit target.
- **Fog recoloured** from pure black (violating D-005) to deep violet-blue.
  Still hard-tiled — logged as B-004, not claimed as fixed.
- **AI now researches**, closing a balance regression from the tech system.

**Phase 1 ≈ 90%.** Remaining for a coherent alpha: **research UI** (the tech
system exists but no player can reach it — top priority), the dev console, and
softening the fog.

## ⚡ Previous — research lands, engine boundary tightened

**340 tests · typecheck/lint/build clean.**

- **Tech system (D-028).** Cohort's linear track: 7 upgrades, 3 tiers, one
  doctrine pair that deliberately does *not* lock the other option out. Effects
  are category-wide (melee/ranged/worker/all) and derived from the researched
  list on demand rather than baked into units — baking would survive tests but
  break `restore()` silently. Hashed, replayed (`REPLAY_VERSION` 6), 24 tests.
  Research now genuinely changes damage, defense, HP, siege and income.
- **Engine-first fix (D-029).** `combat.ts` was implementing the shield wall as
  `if (unit.type !== 'legionnaire')` — a Cohort mechanic inside the engine. Now
  a declared `formsShieldWall` trait the engine reads generically. `sim/` no
  longer names any Cohort unit except in `ai.ts`, which is tracked.

**Roster status: 3 of 7 Cohort ground units.** A match is playable but shallow;
the Outrider (flanker) is the highest-value next unit because it makes the
already-implemented flanking mechanics matter.

## ⚡ Session catch-up — 2026-07-27

**315 tests · typecheck/lint/build clean · `main` current at the commit after this one.**

Two independent tracks landed this session and were reconciled:

1. **External import "v1.23.0"** (72 files, +3,248 lines) — fog of war,
   minimap, direct orders (attack-move/patrol/stop/hold), map boundary polygon,
   LOD, guided tutorial, and the **World Turtle** far-zoom silhouette (D-026,
   a genuine scope addition to the presentation layer — see that entry before
   assuming it's settled art direction rather than a first pass). Fast-forward
   merged and **independently re-verified**: typecheck, lint, all 302 tests
   including `architecture.test.ts` (sim purity), and a manual audit for
   `Math.random`/`Date.now`/`performance.now` leaking into `sim/`. Clean.
2. **`Mission` as a sim entity** (D-007/D-027) — built this session on top of
   (1). `src/sim/missions.ts`, `REPLAY_VERSION` → 5, 11 tests. **Deliberately
   inert** — a mission does not yet change what an assigned squad does; that
   wiring is mission-panel UI work, intentionally left for later so it's built
   against a real primitive instead of inventing its own state.

**Known recurring hazard:** this session's `origin` remote reset to the old
`RTS` repo mid-session (container recreation), *twice*. Always check
`git remote -v` says `Greenmantle` before trusting a push succeeded.

---

## v1.23.0 core direct RTS orders — 84%

- Added deterministic attack-move, patrol, stop, and hold-position commands.
- Commands are available from A/P/S/H hotkeys and the selected-unit card.
- Patrol state is plain snapshot-safe data; replay format advanced to v4 and state hashing now includes direct-order state.
- Orders remain constrained by the generated polygon boundary.
- Clean dependency installation, site consistency, typecheck, lint, all 302 tests, and the production build pass.


---

# Historical log

_Older checkpoints, newest first. Kept for provenance; the current picture
is the top of this file._


## v1.22.0 guided tutorial foundation

Greenmantle now includes an optional seven-step browser tutorial, launchable from the permanent in-game **Tutorial** button or with `?tutorial=1`. The guide observes existing deterministic world and UI state rather than injecting timer-driven simulation changes. It teaches worker selection, set-and-forget gathering, Standard selection, Legionnaire production, combat-unit selection, movement orders, and whole-board camera framing. Completion/skip state is stored locally, and the guide can be reopened at any time. Pure progression tests cover prerequisite ordering and completion. Dedicated tutorial-map setup, contextual world highlights, accessibility review, and real-player pacing validation remain.

## v1.21.0 full-world fog enforcement

A single presentation-side visibility controller now governs the tactical map, 3D unit/building/site/resource views, world picking, right-click target acquisition, and replay/spectator overrides. Unseen rival entities are hidden and cannot be clicked or attacked through fog; discovered resource nodes remain remembered. The battlefield now carries an instanced polygon-clipped fog overlay with distinct unexplored and explored treatments. Replay viewing automatically switches to omniscient vision, developer sandbox modes can toggle player/omniscient visibility, and `?vision=omniscient` supports explicit spectator testing. Deterministic simulation remains untouched.

## v1.20.1 documentation and public-roadmap synchronization

The public development page now embeds the complete contents of `docs/ROADMAP.md`, including all phases, tables, extensions, multiplayer staging, engine-platform stages, World Turtle direction, and polygon-map milestones. `scripts/sync-site-progress.mjs` is the only publication path, so editing the canonical roadmap and running or building the project updates the site automatically. A documentation audit also corrected stale camera, replay, save/load, minimap, AI, and engine-progress statuses across the roadmap and TODO list.

## v1.20.0 tactical fog and seed browsing

The tactical map now maintains a polygon-clipped presentation-side visibility field with unexplored, explored, and currently visible states. Player units, buildings, and sites provide vision; rival markers appear only under current vision, while discovered resources remain known. A compact seed control loads an exact `mapSeed` or generates a new one without consuming the deterministic match RNG. The next visibility milestone applies the same information policy to the 3D world, picking, and commands.


**Date:** 2026-07-27
**Repository:** `Wizard1999/Greenmantle` (public) — migrated from `Wizard1999/RTS`
**Branch:** `main` is the canonical public branch for this handoff
**Last known upstream verification:** 226 passing · typecheck clean · lint clean · build clean
**Current working-copy verification:** 302 passing; site consistency, typecheck, lint, and production build clean

---



## 2026-07-27 active production checkpoint — 84% / v1.23.0

The renderer now has its first camera-distance LOD architecture. Units and buildings retain their authored silhouettes at close and tactical distance, then swap to inexpensive, team-readable strategic markers at overview and whole-world distance. Selection remains available because the active pick target follows the visible representation. Decorative scenery is culled beyond tactical range. The policy is quality-tier aware and isolated in `src/render/lod.ts` with dedicated tests.

The temporary terrain slab now gives way at cosmological zoom to a first World Turtle blockout: shell, head, four limbs, and tail. This is deliberately silhouette-first and not final art. It remains hidden during ordinary RTS play and exists to validate scale, reveal distance, framing, and the transition from battlefield to mythic world-object.

Verification note: a clean `npm ci` completed successfully. `npm run verify`
passes site synchronization and consistency, typecheck, lint, all 302 tests,
and the production Vite build.

## 2026-07-27 active production checkpoint — 44%

The developer sandbox foundation is now complete: scenario presets, simulation controls, render metrics, selected-order diagnostics, and toggleable world overlays are available through `?dev=<mode>`. The war-table camera pans and orbits smoothly, zooms around the cursor, focuses at the actual terrain height, and uses the rendered terrain for anchoring. Selection now rejects hidden projections and resolves overlapping unit/site/building hits through a tested RTS priority policy. Move, gather, rally, attack, and invalid commands all provide immediate world-space acknowledgement.

Automated verification now passes. Manual browser feel, accessibility, and
real-machine performance checks remain pending and are tracked separately.


### Deterministic save files
`src/sim/save.ts` + `tests/save.test.ts` add a versioned, hash-validated save envelope on top of the existing snapshot/restore system. Developer sandbox modes now support browser quick-save/load and portable JSON import/export. Save loading rejects wrong formats, save versions, map-generator versions, tick metadata, and tampered state instead of attempting an unsafe best-effort restore. See `SAVE_AND_REPLAY.md`.

## Developer sandbox diagnostics

Opening the game with `?dev=camera`, `?dev=battle`, `?dev=units`, `?dev=economy`, or `?dev=performance` enables the developer panel. It supports pause, one-tick stepping, simulation speeds, spawning, scenario presets, and live diagnostics for FPS, draw calls, triangle count, entity totals, camera state, and the current selected-unit order. The performance preset creates a repeatable 200-unit formation.

## Last completed

### Repository restructure
- Deleted 21.5 MB / ~150 files of tracked waste: `Claude.html` and `2/3/4/5/7.html`
  plus their six `_files` directories. These were saved copies of the claude.ai
  **app shell** — 1,627 characters of visible text each (a sidebar chat list),
  no design content, and the six asset directories were byte-identical.
- Repo went **222 tracked files / 22 MB → 57 files / 604 KB**.
- Removed `Claude Code Transfer/` (duplicated root files); kept its design doc
  as `docs/GAME_DESIGN.md`.
- Moved working docs to `docs/`, HTML prototypes to `legacy/`, session notes to
  `docs/history/`. Deleted `test_sim.mjs` (superseded by `tests/*.test.ts`).

### Documentation brain
Created `CLAUDE.md`, `START_HERE.md`, `README.md`, and `docs/`:
`ARCHITECTURE.md`, `CURRENT_STATE.md`, `TODO.md`, `DECISIONS.md`, `BUGS.md`,
`UI_BLUEPRINT.md`, `ROADMAP.md`, `ART_REFERENCES.md`.

### Recovered lost design content
The designer re-uploaded `01_design_document.md`. Diffing it against the repo
copy showed the repo version was newer in most respects (elemental framing, art
direction) **but had silently dropped Section 11.1** — four unresolved design
gaps (gatherable resource naming, map tunnels/ramps, stealth/detection, air
units vs. supply pool). These existed in *neither* `GAME_DESIGN.md` nor
`OPEN_QUESTIONS.md` and would have been lost. Merged back into
`docs/GAME_DESIGN.md § 11.1`.

### Tick rate 20 Hz → 30 Hz  (`DECISIONS.md` D-004)
Rescaled every tick-denominated constant by 1.5 to preserve wall-clock behaviour:

| Constant | 20 Hz | 30 Hz |
|---|---|---|
| `AUTOMATION.stepTimeout` | 900 | 1350 |
| `COMBAT.settleTicks` | 20 | 30 |
| `ECON.gatherTicks` | 30 | 45 |
| `ECON.depositTicks` | 4 | 6 |
| `legionnaire.buildTicks` / `attackTicks` | 80 / 16 | 120 / 24 |
| `marksman.buildTicks` / `attackTicks` | 90 / 24 | 135 / 36 |
| `worker.buildTicks` / `attackTicks` | 60 / 24 | 90 / 36 |
| `outpost.buildTicks` | 100 | 150 |
| `MAX_CATCHUP` | 5 | 8 |

Two things deliberately **not** changed:
- `BUILD.progressPerTick` stays 1 — it is a rate, and `buildTicks` scaling
  already preserves wall-clock build duration.
- Unit `speed` stays as-is — movement is `speed * DT`, i.e. per-second, so it is
  tick-rate independent by construction.

`MAX_CATCHUP` was raised because it was sized to absorb exactly one
maximally-clamped 250 ms frame (5 × 50 ms). At 30 Hz that needs 8 steps; leaving
it at 5 would have silently dropped simulated time on slow frames.

All 146 tests passed unchanged, because they reference constants symbolically
(`COMBAT.settleTicks`, `TICK_HZ`) rather than hardcoding numbers.

---

### Determinism foundation — snapshot / restore / hash
New `src/sim/snapshot.ts` + `tests/determinism.test.ts` (10 tests).

Found and fixed a real latent blocker: **`World.rng` was a closure**, so the
generator's position was unreachable state. Nothing failed visibly — a fresh sim
from tick 0 works fine — but rollback could not have restored the RNG position
and every rewind would have desynced. Now `rngState: number`, verified by a test
that JSON round-trips the world (which a closure cannot survive).

This is the shared foundation under all three networked requirements: rollback
is `restore()` + N × `simStep()`, replay seeking is `restore()` to a keyframe,
desync detection is comparing `hash()`, and MMR validation is a server
re-simulating and confirming the final hash.

### Day/night cycle
`src/sim/daynight.ts` + `src/render/skyCycle.ts` + HUD clock, 18 tests.

10 real minutes per in-game day, derived from `world.tick` — **not** wall clock.
A match can start at any hour via `createWorld(seed, startHour)`, and
`dayStartTick` is part of the hashed state so a replay cannot restore a match to
the wrong time of day and still report agreement. Day length is declared in real
seconds in `data/tuning.ts` and converted to ticks once, so changing `TICK_HZ`
cannot silently change day length.

The HUD shows a conic-gradient dial plus `HH:MM` and the period name, always
visible. The sun tracks a real arc and the sky/fog/exposure follow it.

### Replay system
`src/sim/replay.ts` + 11 tests. Records `{ version, seed, startHour, tickRate,
commands[] }` and plays back by re-simulating from tick 0.

All 17 player actions are now a serializable discriminated union routed through
one `dispatch()` funnel, which is what makes recording a single call rather than
25 scattered ones — and forces commands to stay serializable, the property
rollback and networking both need.

Verified to reproduce a recorded match at **every intermediate tick**, not only
the final one; a replay agreeing only at the end could be right by luck. Also
tested: JSON round trip, correct time-of-day restoration, and rejection of
mismatched tick rate or version rather than playing them wrong.

**Live recording is now wired.** Browser input and UI commands pass through a single `issueCommand()` gateway that records the serializable command before invoking the normal `cmd*` function, preserving command results needed by the interface. Replay v3 also records whether the standard AI was enabled plus an optional endpoint tick/hash. The sandbox can export, independently verify, and load the exact verified endpoint. The sandbox now includes an interactive timeline viewer with deterministic lazy keyframes, start/end navigation, 10-second skips, play/pause, and direct scrubbing. Remaining replay work is observed-event integration and cinematic camera framing.

### Map seeds separated from match seeds
`mapSeed` + `MAP_VERSION`, 12 tests.

Map generation now draws from its own generator, never `world.rngState`. That
separation is what makes a **map browser** possible at all — previewing a seed
would otherwise advance the match generator, so the match you played after
browsing would differ from the one you would have played without.

`MAP_VERSION` is the non-obvious half: a seed alone does not reproduce a map,
the generator has to match too. Without it, improving map generation would
silently replay old matches on different terrain. Replay format bumped to v2
and now carries both.

**Not yet procedural** — terrain is still a fixed formula and the layout is
hand-placed, so seeds currently vary only scenery. The plumbing is the part that
would have been expensive to retrofit; the generator itself can be written
whenever.

### PHASE 1 COMPLETE — steps 1.9 to 1.12
29 new tests. Greenmantle is now a game you can win or lose.

**1.9 Squad cohesion.** Diminishing returns past 20 units, measured by
*proximity* not squad membership (D-020) — squad-based counting would be
trivially dodged by simply not grouping, which is the exact formation the rule
exists to discourage. Constants solved backwards from §2's requirement that "a
30-40 unit army should only barely beat a 20-25 unit army"; a test asserts that
ratio so retuning cannot silently break the design intent. Workers exempt.

**1.10 Positioning-driven combat.** High ground, flanking (rear/side/front arcs
off the defender's facing), settle state and cohesion all multiply into
`resolvedDamage()`. Units acquire targets and fight unprompted. Damage is a
deterministic expectation, not a to-hit roll (D-019) — combat consumes no RNG
at all, verified by test.

**1.11 AI opponent.** Gathers, expands supply, builds an army, commits to
attacking. Issues the same commands a human does, and lives inside the sim so
AI matches replay correctly. **Opt-in** via `enableAi()` — a bare world is
inert, so tests and replays are not silently driven by an opponent.

**1.12 Win condition.** Buildings are destructible; a team with no buildings
*and no construction sites* loses after a grace period, so a match cannot be
decided by a one-tick race between a base falling and a site completing.

Two real bugs found and fixed while building this:
- The AI stalled permanently at 7 workers with 2,300 essence banked — it was
  supply-capped and never built anything. Command gates population, so an AI
  that cannot build cannot grow.
- The AI re-tasked its own builder back to mining every think, because
  `cmdAssignBuilders` parks a builder's gather job in `idle`. Construction
  never finished.

## Currently working on

**Development infrastructure and war-table camera prerequisites.**

Completed in the current working copy:
- Windows one-button Play, LAN Play, Tests, and Build launchers.
- Unified `npm run verify` command.
- `docs/PROGRESS.md` live benchmark/percentage scoreboard.
- First developer sandbox entry point and deterministic pause/step/speed controls.
- War-table camera iteration one: camera-relative smooth pan, cursor-anchored smooth zoom, middle-mouse orbit, pure camera math, and safe bounds.

Active next work:
1. Re-test picking, drag selection, and commands at all camera angles.
2. Validate the new move/gather/rally markers and add expanded diagnostics.
3. Refine cursor anchoring against actual terrain height after browser validation.
4. Continue manual cross-browser and real-machine performance validation.

The war-table camera (D-014) remains the next major feature and unblocks the
remaining art pass.

### Paused: the painterly art pass (`DECISIONS.md` D-005) — partially landed.

Built and wired:
- `render/palette.ts` — hue paths (shade/mid/lit) per material, sun/sky/fog
- `render/painterly.ts` — the shading model, plus a `facet()` geometry helper
- `render/quality.ts` — low/medium/high tiers + capability detection
- `render/renderer.ts` — tone mapping, tiered shadows, pixel-ratio cap, fog
- `render/terrainMesh.ts` — terrain now uses the painterly material
- `main.ts` — quality flows through; cloud-shadow globals update per frame

**Still to do:** apply painterly materials to units, buildings, scenery, nodes
and sites; add a quality selector to the HUD; verify the 100-unit target.

### Note on `flatShading`
`PainterlyOptions.flatShading` was removed rather than fixed. Three implements
that flag by recomputing normals per-fragment with `dFdx/dFdy` inside
`<normal_fragment_begin>` — a chunk this shader does not include, since it
carries its own world-space normal through a varying. Setting it would have been
a **silent no-op**. Faceting is now done at geometry level via `facet()`, which
works with any shader. Use that, not the flag.

---

## ⚠️ Sequencing change — read before doing more art

The **war table camera** (D-014) is now the direction: the map as a hologram in
empty space, free flight from any angle, player scaling from miniature to
enormous. Deferred by the designer, but it **should land before** the remaining
art work on units, buildings and scenery — otherwise that work gets done twice.

It also invalidates an assumption baked into the art pass: D-005 justified
omitting close-range detail because the camera was far and top-down. If the
player can shrink into the map, close-up detail is exactly what they will be
looking at. Treat those omissions as scoped to a camera that is being replaced,
not as settled. LOD stops being optional.

### LAN testing and future multiplayer

`PLAY_ON_LAN.bat` now starts Vite on all local interfaces, allowing another
device on the same private network to load the exact development build. This is
currently **shared build access only**; browsers do not yet participate in the
same simulation. True LAN multiplayer is recorded in the roadmap as the first
networking target, ahead of internet lobbies, and depends on replay recording,
periodic state hashes, and deterministic command lockstep.

## Blockers

### ✅ GitHub push access — RESOLVED 2026-07-27
Write access was granted; all commits are pushed and the branch tracks
`origin/claude/project-plan-review-34kyva`. Historical note below kept in case
it recurs.

### ~~🔴 GitHub push access is read-only~~ (resolved)
Commits land locally but **cannot be pushed**. Both credential paths fail:

- `git push` → `403` from the session git proxy
- GitHub API `create_branch` → `403 Resource not accessible by integration`

Reads work fine (`git ls-remote`, `get_me` → authenticated as `Wizard1999`), so
this is a **permissions scope** problem, not a network or auth failure. The
GitHub App installed on the repo has Contents: **Read**, and needs
**Read & Write**.

**Fix:** github.com → Settings → Applications → Installed GitHub Apps → Claude →
Repository permissions → grant **Contents: Read & write** (and **Pull requests:
Read & write** if PRs are wanted), then re-authorize.

Until then, work accumulates as local commits on
`claude/project-plan-review-34kyva`. Nothing is lost, but **nothing is backed
up either** — this container is ephemeral.

---

## Next session

In priority order — full detail in `TODO.md`:

1. **War table camera** (D-014) — free flight, player scaling, table edge, LOD.
   Do this *before* the remaining art work, not after.
2. **Then finish the art pass** — units, buildings, scenery, nodes, sites; HUD
   quality selector. Against the new camera, with LOD in mind.
3. **Dev console** — backtick to open; `/add`, `/pause`, `/speed`, `/spawn`,
   `/kill`, `/reveal`, `/tick`, `/help`. Must route through `sim/commands.ts`
   and be recorded into the replay stream, or replays will desync.
4. **Replay system** (`DECISIONS.md` D-008) — record `{seed, tickRate, version,
   commands[]}`, play back by re-simulating. Ship the determinism test with it.
5. **Basic CPU opponent** (`DECISIONS.md` D-009) — grown alongside features, not
   written late; issues the same commands a human does.

## Rollback: deferred, and that is fine (D-016)

Rollback netcode is **not being pursued for now**. This costs nothing later:

- The snapshot/restore/hash work was never rollback-specific. Replay seeking,
  desync detection, save/load, MMR validation and AI lookahead each need it
  independently. None of it is dead code.
- The expensive parts — per-tick snapshotting, a structure-of-arrays rewrite,
  prediction/reconciliation — were deliberately never started.
- The only thing rollback needs preserved is D-010's plain-data rule, which is
  required by replays and networking anyway and is enforced by tests.

**When multiplayer arrives, start with deterministic lockstep + input delay.**
It is what most RTS ship, and it reuses the command stream `sim/replay.ts`
already produces with no snapshotting at all.

**The one thing that would genuinely hurt:** letting unreachable state back into
`World` — a closure, a `Map`, an object reference between entities. That breaks
replays and validation too, not just rollback, and stays invisible until
something desyncs.

## Still gated on a measurement

- **The 100-unit performance target** (D-006) remains unverified.

## Design decisions awaiting the designer

Four gaps block dependent work — see `GAME_DESIGN.md § 11.1` and `TODO.md`.
The most urgent is **resource naming**: `UI_BLUEPRINT.md` shows a resource panel
reading "Material / Essence / Dominion / Relics", but none of those names were
ever formally adopted. That panel cannot be built until it is settled.

---

## Design philosophy — do not lose this

The game is about **commanding intent**, not clicking fast. The player is an
Operations Commander issuing objectives and doctrine to an army that executes
intelligently. Direct StarCraft-style unit control still exists and always
will — it is simply the *worse* way to play, never a removed capability.

The interface asks *"What are you trying to accomplish?"*, never *"Where do you
want this unit to stand?"* It presents **information, never advice**: "Enemy
Hero Sighted", never "Retreat Recommended". The player owns every decision.

The engineering counterpart: `src/sim/` is pure and deterministic and never
imports outward. Replays, lockstep multiplayer and a testable AI are all free if
that holds and near-impossible to retrofit if it doesn't.


## Public development site

A production-facing one-page site now lives at `/development.html`. It presents the game fantasy, factions, resource language, concept art, active roadmap, completed milestones, and current development focus. Its primary and closing calls to action open `/index.html`, so visitors can play the current browser build without installing anything.

The page does not maintain a second hand-edited progress number. `npm run sync:site` parses `docs/PROGRESS.md` and writes `public/data/progress.json`; `predev` and `prebuild` run that synchronization automatically. Any milestone that changes the live percentage must therefore update `PROGRESS.md` first.

## Performance harness

The performance sandbox now supports repeatable quality-tier comparisons at
`?dev=performance&quality=low|medium|high`. Its fixed 200-unit preset records
average FPS, p50/p95/worst frame time, renderer workload, viewport/device pixel
ratio, and world counts. **Export report** downloads a JSON artifact suitable for
tester bug reports. See `PERFORMANCE_TESTING.md`. Real hardware budgets are not
yet claimed; reports still need to be collected outside this container.

## Replay camera groundwork

A pure optional cinematic replay-director policy now exists in
`src/replay/director.ts`. It ranks plain replay events while enforcing minimum
shot duration, switch cooldowns, score thresholds, distance penalties, and a
manual-camera override window. It is not yet connected to live replay playback
or camera interpolation.


### 2026-07-27 tabletop freedom and website usability
- Public site uses one obvious top-navigation button labelled **Play**.
- Concept-art gallery supports full-screen click/keyboard viewing.
- Hero war-table artwork is smaller and visually farther back in black negative space.
- Camera envelope supports miniature-level inspection, near-overhead overview, full orbit, and travel beyond the authored terrain.
- World backdrop is pure black and the terrain has temporary descending table edges pending the later support-world concept.


### Replay timeline and far-zoom cosmology

`src/replay/timeline.ts` now provides deterministic keyframe-backed seeking. The
developer sandbox can open the current recording or import a verified replay,
scrub to any tick, jump by ten seconds, and play from the timeline while the main
simulation loop remains paused. The first seek builds keyframes lazily and later
seeks restore the nearest cached state.

D-026 locks the maximum-zoom world silhouette to a stylized World Turtle. The
current black void and descending terrain body are intentionally temporary; the
carrier geometry should be introduced through LOD so normal play reads as a war
table and cosmic zoom reveals the complete mythic support creature.


## Whole-board visibility and future map silhouettes

Global distance fog has been removed so the board is never erased by an arbitrary render cutoff. The perspective far plane is 10,000 world units, camera overview range extends to 520 units, and `Home` invokes a tested aspect-aware whole-board framing calculation. Production maps are planned as seeded polygonal boundaries rather than permanent squares; see `MAP_GENERATION.md`.


## v1.17.0 seeded polygon battlefield

The test map is no longer rendered or bounded as a permanent square. A seeded,
rotationally symmetric twelve-vertex polygon is now the canonical battlefield
boundary. The terrain top, descending perimeter, construction validation,
scenery placement, whole-board camera framing, and World Turtle proportions all
consume that same boundary. `MAP_VERSION` advanced to 3 because identical seeds
now produce a different physical map shape.

## v1.16.0 strategic-view readability

The first LOD pass now keeps strategic unit and building markers readable as the camera moves from tactical play to whole-world overview. Marker scale grows sublinearly with camera distance and remains capped, so it does not explode during transition shots. Players can choose Low, Medium, or High rendering quality inside the running game; the choice is persisted and applied through a clean reload because terrain and renderer construction depend on the tier. Perspective near clipping now adapts to camera distance to preserve close inspection while improving depth precision at extreme zoom.


## v1.19.0 polygon tactical map

The HUD now includes a polygon-aware tactical map derived from the same canonical boundary as terrain and gameplay. It renders live units, structures, sites, resources, and the current camera focus/heading. Clicking or dragging on the map recentres the tabletop camera while clamping the requested focus to valid battlefield space. The coordinate transform is pure and covered by tests, leaving a clean future insertion point for fog-of-war masking.

## v1.18.0 polygon-safe gameplay layout

The polygon boundary is now a gameplay constraint rather than only a rendering shape. Manual moves, formation offsets, rallies, behaviour-chain steps, unit-production exits, and per-tick movement are projected into safe navigable space. The simulation safety clamp prevents future systems from accidentally driving units off the table even if they bypass the normal command UI.

Match setup no longer assumes square-map coordinates. Bases, mirrored resource clusters, starting workers, and starting armies are derived from the actual seeded boundary through a deterministic symmetric layout. The AI expansion search now validates circular footprints against the polygon instead of using hard-coded `±34` square limits. `MAP_VERSION` is 3 because this changes the physical setup produced by existing seeds.
