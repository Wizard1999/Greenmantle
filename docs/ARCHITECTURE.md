# Architecture

**Complete module map.** Every file in `src/` appears here. If you add a file,
add a row — a map missing half the territory is worse than no map, because it
is trusted.

---

## The three rules

**1. `src/sim/` is pure, deterministic, headless.** It never imports from
`render/`, `input/` or `ui/`. Enforced by `tests/architecture.test.ts`.

**2. No sim state may live anywhere unreachable.** No closures, functions,
`Map`/`Set` on `World`, or object references between entities — ids only. If
`structuredClone` cannot carry it, replays, save/load and future multiplayer
all break *simultaneously*, and a fresh sim from tick 0 still passes every
test. (D-010)

**3. Engine-first.** `sim/` must not name a specific unit, building or
technology. Race content lives in `data/` and declares **traits** the engine
reads generically, so scrapping the races and rebuilding stays cheap. (D-029)

Everything downstream follows from three things we want:

| Want | Requires |
|---|---|
| Replays | Same inputs + same seed ⇒ same state, every time |
| Lockstep multiplayer | Every client computes an identical tick |
| Testable AI opponent | Run the sim headless for thousands of ticks |

---

## `src/core/` — no dependencies at all

| File | Purpose |
|---|---|
| `types.ts` | Every shared type: `World`, `Unit`, `Building`, `Squad`, `Mission`, `RallyPoint`, ids, vectors. The shape of the whole game. |
| `rng.ts` | Seeded mulberry32. The **only** randomness in the sim. State is a plain number on `World`, never a closure (D-010). |
| `loop.ts` | `TICK_HZ` (30), fixed-timestep accumulator, pause/step/speed. Durations are ticks, never seconds (D-004). |

## `src/data/` — numbers and content, no logic

Race content lives here so the engine stays generic.

| File | Purpose |
|---|---|
| `tuning.ts` | Every balance constant: build, combat, cohesion, economy, automation, AI, victory, day length. |
| `units.ts` | Unit stat table + **traits** (`isWorker`, `formsShieldWall`). |
| `buildings.ts` | Building stats: HP, command supply, control radius, what it produces. |
| `tech.ts` | Cohort's research track (D-028). Declarative effects, category-wide. |

## `src/sim/` — the deterministic simulation

Imports `core/` and `data/` **only**.

| File | Purpose |
|---|---|
| `world.ts` | `World` construction and `simStep()` — the tick entry point and system ordering. |
| `entities.ts` | Spawn/despawn units, buildings, sites, scenery. |
| `commands.ts` | The **only** way outside code mutates the world. Validates, returns `{ok, reason}`, never throws. |
| `movement.ts` | Steering toward targets, boundary-constrained. |
| `combat.ts` | Target acquisition, damage, cohesion, high ground, flanking, the reaper, victory. |
| `economy.ts` | Worker gather state machine (set-and-forget, §8.2). |
| `construction.ts` | Build sites and progress. |
| `production.ts` | Training queues; applies rally points on spawn. |
| `supply.ts` | Command supply — population cap, control range, automation bandwidth in one stat (§8.1). |
| `squads.ts` | Persistent squads and behaviour chains. |
| `missions.ts` | Missions above squads (D-007/D-027). **Currently inert** — records intent, does not yet drive squad behaviour. |
| `tech.ts` | Research engine. Modifiers **derived** from the researched list, never baked into units (D-028). |
| `terrain.ts` | Single source of truth for terrain height; the render mesh samples this rather than duplicating the formula. |
| `mapBoundary.ts` | Generated polygon play area; orders and movement are clamped to it. |
| `map.ts` | Map assembly + `MAP_VERSION`. Map seed is separate from match seed (D-017). |
| `daynight.ts` | Day/night cycle derived from `world.tick` — never wall clock (D-013). |
| `snapshot.ts` | `snapshot()` / `restore()` / `hash()`. The foundation under replays, save/load and desync detection. |
| `replay.ts` | `Command` union, `dispatch()`, `Recorder`, `playback()`, `REPLAY_VERSION`. |
| `save.ts` | Versioned, hash-validated save envelope. Rejects mismatches rather than best-effort loading. |
| `ai.ts` | The CPU opponent. Issues the **same commands a human does**; lives in the sim so AI matches replay (D-009). |

## `src/render/` — reads sim, never writes it

| File | Purpose |
|---|---|
| `renderer.ts` | WebGLRenderer, lights, tone mapping, quality-tiered setup. |
| `camera.ts` | War-table camera: free orbit, zoom, miniature-to-cosmological range (D-014). |
| `cameraMath.ts` | Pure camera maths, unit-testable without a browser. |
| `palette.ts` | Hue paths (shade/mid/lit) per material. Resource is **violet**, never teal (D-025). |
| `painterly.ts` | The stylised shading model + `facet()`. Shadows shift hue, never go black (D-005). |
| `materials.ts` | **Shared** painterly materials cached by role/team. One `ShaderMaterial` per unit would mean a shader compile per unit and would break the 100-unit target (D-006). |
| `skyCycle.ts` | Sun/sky/fog derived from the sim clock. Read-only on the sim. |
| `quality.ts` | Low/medium/high tiers. The *look* is not tiered; the *cost* is. |
| `lod.ts` | Camera-distance level of detail — real silhouettes close, strategic markers at table scale. |
| `terrainMesh.ts` | Ground mesh, polygon skirt, World Turtle far-zoom silhouette (D-026). |
| `unitViews.ts` | Unit meshes; interpolates with the loop's `alpha`. |
| `buildingViews.ts` | Building meshes — fossil-and-glow, not machinery (§8.8). |
| `siteViews.ts` | Construction sites in progress. |
| `nodeViews.ts` | Resource nodes; shrink visibly as they deplete. |
| `sceneryViews.ts` | Decorative rocks and trees; culled beyond tactical range. |
| `fogOverlay.ts` | Instanced polygon-clipped fog, unexplored vs explored. |
| `chainVisuals.ts` | Selected squad's behaviour chain drawn on the ground. |
| `commandFeedback.ts` | Immediate click acknowledgement — fires on the frame of the click, before the tick applies it (D-004). |
| `placementGhost.ts` | Building placement preview. |

**Never move a unit in `render/`.** Units carry `prevX/prevZ/prevFacing`; views
lerp using the loop's `alpha`. That is why a 30 Hz sim looks smooth at 144 fps.

## `src/input/` — events become commands

| File | Purpose |
|---|---|
| `mouse.ts` | Selection, orders, placement. Routes through `replay/live.ts`, not `commands.ts` directly. |
| `keyboard.ts` | Hotkeys — squads, orders (A/P/S/H), training. |
| `selection.ts` | What is currently selected; UI state that is not sim state. |
| `selectionMath.ts` | Pure box/frustum selection maths. |
| `pickPriority.ts` | Resolves overlapping click targets so a large base mesh cannot steal a unit click. |

## `src/ui/` — DOM overlays

| File | Purpose |
|---|---|
| `hud.ts` | Resources, supply, clock, selection card, victory announcement. Feeds `debugReadout.ts` rather than owning debug DOM. |
| `controlsSheet.ts` | The control reference and settings host — `?` or the Keys button. `CONTROL_GROUPS` is plain data so `tests/controlsSheet.test.ts` can assert coverage without a DOM (D-032). |
| `debugReadout.ts` | Frame/tick/economy readout, built **only** when `?dev=` is present. In a player build it is an inert object and no panel exists (D-032). |
| `chainEditor.ts` | Behaviour-chain editor. |
| `minimap.ts` | Tactical map with visibility state. |
| `researchPanel.ts` | Research interface over the tech engine (D-028) — available upgrades, prerequisites, cost gating. |
| `fogOfWar.ts` | Presentation-side visibility field (unexplored/explored/visible). |
| `visibility.ts` | Single controller governing what the player may see, click and target. |
| `tutorial.ts` | Optional seven-step guided tutorial; observes state, never injects sim changes. |
| `qualityControl.ts` | Runtime quality switching (rebuilds renderer/terrain). |
| `mapSeedControl.ts` | Load or generate a `mapSeed` without consuming match RNG. |
| `buildBadge.ts` | Visible build identifier so testers can report an exact version. |

## `src/replay/` — recording and playback

| File | Purpose |
|---|---|
| `live.ts` | Browser command gateway. **Every human order goes through `issueCommand()`** so real matches record. |
| `timeline.ts` | Deterministic seeking with lazily-created keyframes. |
| `director.ts` | Cinematic director — ranks observed events for camera framing. |

## `src/dev/` — developer tooling (`?dev=<mode>`)

| File | Purpose |
|---|---|
| `sandbox.ts` | Scenario presets, sim controls, save/load, visibility toggles. |
| `performanceMonitor.ts` | Frame and render metrics. |
| `diagnosticVisuals.ts` | World overlays for debugging. |

## Site

| File | Purpose |
|---|---|
| `site.ts` / `site.css` | The public development page (`development.html`). Badges all art as concept art automatically. |
| `gauntlet.ts` / `gauntlet.css` | The live build-loop record (`gauntlet.html`) — each piece, the bar it is judged against, critic verdicts, and what is held back. Reads the same `progress.json` as `site.ts`, so the two pages cannot disagree. |
| `main.ts` | Game entry point: wires world, renderer, input, UI, recorder, loop. |

## `scripts/` — build and verification tooling

| File | Purpose |
|---|---|
| `sync-site-progress.mjs` | The **only** publication path. Turns `PROGRESS.md`, `ROADMAP.md` and `WORKLOG.md` into `public/data/progress.json`, and folds in the real test count from `.verify/tests.json`. |
| `check-site-sync.mjs` | Fails the build when published data goes stale or a work-log section stops arriving. Parsers that match by heading name fail silently otherwise. |
| `check-docs.mjs` | Fails the build when a `src/` module is missing from this file. |
| `generate-build-info.mjs` | Stamps the visible build identifier. |
| `tag-release.mjs` | Release tagging. |
| `capture.mjs` | **Deterministic screenshot harness** (`npm run capture`). See below. |
| `measure-hud.mjs` | Machine measurement of the in-game HUD at four viewports: screen share, overlapping panel pairs, declared z-indexes, distinct backgrounds, and a `document.elementFromPoint` reachability check on every button. No judgement in the output — it is how a claim about the HUD gets checked rather than asserted (D-032). Needs a dev server; `--dismiss` measures the steady state with the first-run guide closed. |

### The screenshot harness

`npm run capture` drives a real headless Chromium over the running dev server and
writes PNGs plus an `index.json` manifest to `.capture/` (gitignored).

It exists because the gauntlet requires critics to inspect the *real* build, and
an agent cannot inspect what it cannot photograph. Editor-embedded browser
surfaces routinely report `document.hidden`, which stops `requestAnimationFrame`
entirely — the render loop never runs, every screenshot is black, and that is
indistinguishable from a genuinely broken game.

Two properties are load-bearing:

- **Reproducible.** Every shot names an exact camera state and an exact tick, so
  two runs are comparable. `PERFORMANCE_TESTING.md` forbids free-flown camera
  paths for the same reason.
- **The real game.** Shots are driven through `loop.stepOnce()` and the camera's
  own public methods — the same paths the sandbox and the mouse use. There is no
  capture-only render path that could flatter the build.

`src/main.ts` exposes a `window.__greenmantle` handle **only** under
`?capture=1`. It is deliberately not `?dev=`: the sandbox is a human tool with
its own panel, and conflating the two means changing one silently alters the
other. A global handing out the mutable `World` must never exist in a build a
player loads.

The camera is flown to each target by a converging control loop, not a single
delta — `zoom()` feeds a damped velocity clamped to ±18 per frame, so one large
nudge under-travels. That produced a "war table" shot at distance 104 instead of
430, which looked like a perfectly plausible screenshot. Silent under-travel in a
verification tool is worse than a crash.

---

## The tick

`simStep()` order matters and is deliberate:

```
ai → tech → production → construction → squads → gather → build
   → movement → settle → combat → reaper → missions → victory
```

The reaper runs before missions so a mission can never hold a squad id that was
pruned this tick; victory runs last so it sees the settled state.

## Snapshot / restore / hash

| Feature | Implementation |
|---|---|
| Replay seek | `restore()` to nearest keyframe, then re-simulate |
| Save / load | `snapshot()` + `restore()` |
| Desync detection | compare `hash()` per tick |
| Match validation | server re-simulates, confirms final `hash()` |

`restore()` mutates in place — swapping the object would leave every view
holding an orphan. `hash()` excludes `prevX/prevZ/prevFacing` (render
interpolation, not sim inputs) and quantises floats to 1e-6 so peers agreeing
within tolerance are not reported as desynced.

## Testing

`npm run verify` = typecheck + lint + tests + build. Every system has a suite;
`tests/architecture.test.ts` enforces rule 1 and `tests/determinism.test.ts`
enforces rule 2.
