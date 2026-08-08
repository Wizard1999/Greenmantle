# Design Decisions

Append-only. Each entry records what was decided, why, and what was rejected.
**Do not relitigate these without a new entry superseding the old one.**

> **If the designer decides something in conversation, it lands here the same
> day.** This has failed twice already: `GAME_DESIGN.md` §11.1 had to be
> *restored* after being dropped in an intermediate revision, and the current
> `CURRENT_STATE.md` handoff opens by saying its contents "existed only in a
> chat that has ended". A fresh session has the repository and nothing else — a
> decision that was made but never written down is indistinguishable from one
> that was never made, and will be raised as an open question again. D-033
> through D-036 are all answers that had to be given a second time.

---

## D-001 — The simulation is pure and headless
**Date:** 2026-07-26

**Decision:** `src/sim/` never imports from `render/`, `input/` or `ui/`.
Enforced by `tests/architecture.test.ts`.

**Reason:** Replays, lockstep multiplayer and a testable AI opponent are all
free if determinism holds from day one, and all three are near-impossible to
retrofit. The cost of the rule is close to zero.

**Rejected:** Letting views read/write sim state directly for convenience.

---

## D-002 — All durations are ticks, never seconds
**Date:** 2026-07-26

**Decision:** Every duration in the simulation is expressed in ticks.

**Reason:** Wall-clock time is non-deterministic and frame-rate dependent.

**Consequence:** Changing `TICK_HZ` rescales the meaning of every constant —
see D-004.

---

## D-003 — Units do not execute player commands directly
**Date:** 2026-07-26

**Decision:** Player intent flows through squads and behaviour chains rather
than into individual units.

```
Player command → Squad → Behaviour chain → Individual units
```

**Reason:** The game is about expressing intent, not mechanical execution.

**Rejected:** Direct per-unit commands as the primary interaction, StarCraft
style. Note this remains *possible* — it is simply the worse way to play, not
a removed capability.

---

## D-004 — Tick rate is 30 Hz, not 20 and not 128
**Date:** 2026-07-27

**Decision:** `TICK_HZ` raised from 20 to **30**. All tick-denominated
constants multiplied by 1.5 to preserve wall-clock behaviour.

**Reason.** The 128-tick figure comes from competitive Counter-Strike, and it
solves a problem this game does not have. In a hitscan FPS, tick rate governs
*hit registration* — whether a shot fired at a target moving across your screen
at high angular velocity connects. That is a genuine 8 ms-scale problem.

An RTS has a different bottleneck. Perceived responsiveness here is dominated
by **input-to-feedback latency**, not simulation granularity, and tick rate is
only one small term in that sum:

| Tick rate | Worst-case command delay | Average |
|---|---|---|
| 20 Hz | 50 ms | 25 ms |
| **30 Hz** | **33 ms** | **17 ms** |
| 60 Hz | 17 ms | 8 ms |
| 128 Hz | 8 ms | 4 ms |

Going 20 → 30 buys 8 ms of average latency for a 1.5× sim cost. Going 30 → 128
would buy a further 13 ms for a **4.3× sim cost** — and sim cost is exactly the
budget we committed to spending on 100+ units at 1080p/30fps on a 2017
integrated GPU. Target acquisition is the expensive part and scales with unit
count; multiplying it by 4.3 to save 13 ms is a bad trade.

For reference, shipped RTS tick rates: StarCraft II ≈ 22.4, Age of Empires II
≈ 20–30, Company of Heroes ≈ 10, Supreme Commander 10. None of these feel
unresponsive, because they spend their responsiveness budget elsewhere.

30 Hz also divides evenly into 60 Hz displays (exactly 2 render frames per
tick), which keeps interpolation judder-free. 128 divides into nothing.

**Where responsiveness actually comes from** — these matter far more than tick
rate and are the real work:
1. **Render interpolation** (already built) — views lerp with the loop's `alpha`,
   so motion is smooth at any framerate regardless of tick rate.
2. **Immediate input acknowledgement** — click feedback (marker, cursor, sound)
   must fire on the frame of the click, before the tick applies the command.
   *Not yet built — see TODO.*
3. **Command batching at tick boundaries** rather than dropping input between ticks.

**Rejected:** 128 Hz (cost without benefit), 60 Hz (2× cost for 8 ms; revisit
only if profiling shows headroom at 100+ units), staying at 20 Hz.

**Locked because:** tick rate is baked into the replay format. Changing it later
invalidates every recorded replay. Decided now, deliberately, before the replay
system is built.

---

## D-005 — Art direction: Ghibli-influenced, hue-path shading
**Date:** 2026-07-27

**Decision:** Surfaces are shaded along a **hue path** — three distinct colours
(shade / mid / lit) — rather than one colour lit and darkened. Shadows shift
hue instead of going black.

**Reason:** This is the single largest difference between "stylised" and "3D
render with the lights turned down". It is fragment maths, so it costs
essentially nothing and can ship in every quality tier.

**Consequence:** The *look* is not tiered; the *cost* is. Quality tiers scale
shadow resolution, antialiasing, pixel ratio and mesh subdivision only.

---

## D-006 — Performance target
**Date:** 2026-07-27

**Decision:** 1080p, 30 fps, **100+ units**, on a ~2017 integrated GPU
(Intel HD 620 class), from a cold page load in a browser.

**Reason:** The game must run on practically any machine straight from the
website. Late-game unit counts are where performance actually collapses, so the
target is set at late-game load rather than a comfortable early-game figure.

---

## D-007 — Missions become first-class simulation objects
**Date:** 2026-07-27

**Decision:** When the mission system is built, `Mission` lives in `src/sim/`
and is serialized in replays. It is **not** a UI construct.

**Reason:** Missions carry objective, priority, fallback position and
completion/failure conditions — all of which affect unit behaviour and
therefore must be deterministic and replayable. Building it in the UI layer
first would make it unreplayable and force a rewrite.

**Consequence:** `Mission` sits *above* `Squad` in the hierarchy. Squads
currently own behaviour chains directly; that ownership moves up when missions
land. See `UI_BLUEPRINT.md`.

---

## D-008 — Replays record commands, not state
**Date:** 2026-07-27

**Decision:** A replay is `{ seed, tickRate, version, commands[] }` where each
command is `{ tick, playerId, command }`. Playback re-simulates from tick 0.

**Reason:** Command streams are orders of magnitude smaller than state
snapshots, and re-simulation is a continuous proof that determinism holds — a
desync in playback is a determinism bug worth knowing about.

**Consequence:** Every command in `sim/commands.ts` must stay **serializable** —
no functions, no Three.js objects, no DOM references in a command payload.
Replays must store the tick rate and a version so old replays can be rejected
rather than silently desyncing.

---

## D-009 — The AI opponent is developed incrementally alongside features
**Date:** 2026-07-27

**Decision:** A basic CPU opponent is built now and levelled up with each new
system, rather than written from scratch late.

**Reason:** An AI written after the fact has to reverse-engineer every system at
once. An AI grown alongside the game stays cheap to extend, and it doubles as a
continuous integration test of the systems it drives — if the AI can't gather,
gathering is broken. It also means there is always something to play against.

**Consequence:** The AI issues the *same* commands a human does, through
`sim/commands.ts`. It gets no privileged access to state it should not see.
This keeps it honest and keeps it replayable.

---

## D-010 — Sim state is plain, reachable data (rollback prerequisite)
**Date:** 2026-07-27

**Decision:** No sim state may live anywhere a structured clone cannot reach.
No closures, no functions, no `Map`/`Set` held on `World`, no references
between entities other than ids.

**Reason:** Rollback netcode, replays and server-side match validation are all
the same three operations — snapshot, restore, hash — and all three break on
unreachable state. This was not hypothetical: `World.rng` was a closure, so the
generator's position was unreachable. A fresh sim from tick 0 still worked, so
nothing failed visibly, but rollback could not have restored the RNG position
and every rewind would have desynced. Fixed by storing `rngState` as a number.

**Consequence:** `sim/snapshot.ts` owns `snapshot()`, `restore()` and `hash()`.
`restore()` mutates in place rather than returning a new object, because views
hold long-lived references to the `World`. `tests/determinism.test.ts` guards
all of it, including a JSON round trip — which a closure cannot survive.

**Cost if deferred:** this is cheap now and near-impossible later. Retrofitting
snapshot-safety means auditing every field added in between.

---

## D-011 — Rollback netcode: the state layout is the real decision
**Date:** 2026-07-27
**Amended 2026-07-27:** rollback **deferred** by the designer as too ambitious
for now. See D-016 for what that does and does not cost.

**Decision:** Target rollback netcode. Keep `structuredClone` for now; route
every snapshot through `sim/snapshot.ts` so the representation can change
without touching call sites.

**Reason, and the honest caveat.** Rollback is standard in fighting games — two
players, tiny state, snapshot 60×/sec trivially. An RTS is the opposite: 100+
entities means state is orders of magnitude larger, which is exactly why most
RTS ship **lockstep with input delay** instead. Rollback here is achievable but
it is a genuine engineering commitment, and the thing that decides whether it
is affordable is **state layout**, not netcode cleverness.

- Object graph + `structuredClone` (today): allocates, walks the graph, GC
  pressure. Fine at current scale, will not hold at 100+ units × 30 Hz.
- Structure-of-arrays over typed arrays: snapshot becomes `TypedArray.set()`
  into a ring buffer — a memcpy, microseconds, zero allocation.

**Not rewriting to SoA yet** — it would stall Phase 1 for a system that has no
consumer. But D-010's plain-data rule keeps the option open at zero cost, and
`snapshot.ts` is the single file that changes when the time comes.

**Interaction with D-004:** rollback multiplies sim cost by the rollback window.
A 7-tick rewind is 7× the work in one frame. This *strengthens* the case for
30 Hz over 128 — at 128 Hz the same wall-clock window is ~30 ticks to
re-simulate.

**Measure before committing:** snapshot+restore cost at 50 / 100 / 200 units.
If a snapshot exceeds roughly a third of a frame at target unit count, take
lockstep-with-input-delay instead and revisit. That is a real outcome, not a
failure.

---

## D-012 — Replays, matchmaking and MMR ride on determinism
**Date:** 2026-07-27

**Decision:** Automated match replays and global matchmaking with MMR are
product requirements. All three of replay, rollback and rating validation are
served by the same foundation from D-010.

**Reason:** A deterministic sim makes each of these cheap rather than each
needing its own machinery:

| Requirement | What it needs |
|---|---|
| Automated replays | Command stream + seed + start hour (D-008) |
| Replay seeking | `restore()` to the nearest keyframe, then re-simulate |
| Rollback | `restore()` + N × `simStep()` |
| Desync detection | `hash()` compared per tick |
| MMR result validation | Server re-simulates and confirms the final `hash()` |
| Anti-cheat | A client cannot report a result the command stream does not produce |

**Consequence:** replays must record seed, tick rate, **start hour** and a
version. Any of these missing makes a replay silently wrong rather than
obviously broken. MMR is otherwise a backend concern and does not constrain the
sim beyond this.

---

## D-013 — Day/night cycle is simulation state, in ticks
**Date:** 2026-07-27

**Decision:** Ten real minutes per full in-game day. The cycle is derived from
`world.tick` plus a `dayStartTick` offset, so a match may begin at any hour.
Time of day is displayed at all times in the HUD.

**Reason:** A day counter looks like pure decoration, and the obvious
implementation is `performance.now()` in the renderer. That is a trap. The
moment anything gameplay-facing reads the time of day — night vision ranges, a
night-only unit, a timed objective, or simply a player choosing to attack at
dusk — a wall-clock cycle desyncs across peers and cannot be replayed. Deriving
it from the tick costs nothing and closes the door before anyone walks through
it.

**Consequence:** `dayStartTick` is part of hashed state, so a replay cannot
restore a match to the wrong time of day and still report agreement. Day length
is declared in `data/tuning.ts` as **real seconds** and converted to ticks once,
so changing `TICK_HZ` cannot silently change day length.

**Presentation:** `render/skyCycle.ts` derives sun direction, light colour, sky
and fog from the sim clock and never writes back. Night lifts ambient well above
physical darkness deliberately — a strategy game that is hard to read at night
is one people refuse to play at night.

---

## D-014 — The war table: free-flight camera, not a traditional RTS view
**Date:** 2026-07-27
**Status:** direction locked, implementation deliberately deferred

**Decision:** Replace the top-down pan/zoom camera. The map is a holographic
war table floating in an otherwise empty universe. The player flies freely
around it and views it from any angle, scaling themselves from *miniature*
(down inside the map, among the units) to *enormous* (the whole table at a
glance).

**Reason:** It is the camera the rest of the design already implies. The player
is an Operations Commander reading an operational picture, not a soldier with a
fixed viewport — a war table is literally what commanders use. It also makes
`UI_BLUEPRINT.md`'s mission visualisation (arrows, fallback lines, logistics
routes) read as objects on a table rather than overlays on a screen.

**Rejected:** traditional pan/zoom/edge-scroll. Retained only as a fallback if
free flight proves to hurt readability in competitive play.

### Consequences — these are the parts that cost something

1. **It invalidates an assumption in the art pass (D-005).** That work justified
   omitting close-range detail because "at a far top-down RTS camera it buys
   little". If the player can shrink into the map, close-up detail is exactly
   what they will be looking at. The renderer will need real LOD: cheap
   impostors at table scale, genuine detail at miniature scale. **Do not read
   D-005's omissions as permanent — they were scoped to a camera that is now
   being replaced.**

2. **It changes the sky cycle (D-013).** Aerial-perspective fog fading toward a
   sky colour assumes a horizon. In an empty universe there is none. The day/
   night cycle must light *the table* while the surround stays void — closer to
   a lit diorama than a landscape. Fog becomes a table-edge falloff, not
   distance haze. `render/skyCycle.ts` will need revisiting; the sim-side clock
   in `sim/daynight.ts` is unaffected, which is the point of the split.

3. **The map needs a defined edge.** Terrain is currently an infinite-feeling
   plane. A floating table has a visible rim, underside and silhouette, and all
   three become art surfaces.

4. **Culling and LOD stop being optional.** A fixed top-down camera makes both
   easy. Arbitrary angles plus arbitrary scale make them load-bearing for the
   100-unit target (D-006).

5. **The minimap is reconsidered.** In `UI_BLUEPRINT.md` the minimap is a
   strategic intelligence display. With a war table already showing the whole
   map at a glance, the minimap may be redundant, or may become the *fast
   travel* control rather than an overview. Open question.

**Sequencing:** deferred by the designer's explicit instruction — capture now,
build in the right order. It should land **before** the remaining art work on
units, buildings and scenery, so that work is done once against the real camera
rather than twice. The sim is entirely unaffected either way, which is why
deferring it is safe.

---

## D-015 — Project codename is Longbarrow, distinct from the race names
**Date:** 2026-07-27

**Decision:** The project is codenamed **Longbarrow**. Repository, package name
and page title use it. The four races keep their own names.

**Reason:** The project was previously titled "Cohort RTS", which conflates the
project with *Cohort*, one of four playable races and the Phase 1 proving
ground. That naming ages badly — by Phase 3 the game contains four races and
being named after one of them is misleading, and it quietly implies Cohort is
the protagonist faction when the design explicitly treats all four as forces of
nature with no privileged viewpoint.

A longbarrow is a prehistoric burial mound, grassed over. It carries the same
imagery Cohort's visual identity is built from — ancient machinery of death,
gently overgrown, as inherent to the landscape as a hill — without being the
race's name. Evocative of the world rather than of one faction in it.

**Consequence:** `Cohort` continues to mean the race, everywhere in the design
documents. Only project-level titles changed: `README.md`, `CLAUDE.md`,
`package.json`, and the page `<title>`.


---

## D-016 — Rollback deferred; the foundation stays because it was never rollback-specific
**Date:** 2026-07-27

**Decision:** Stop pursuing rollback netcode for now. Keep `sim/snapshot.ts`,
the plain-data rule (D-010) and the determinism tests exactly as they are.

**The question this answers:** does deferring rollback hurt development later?
**No** — and specifically:

**Nothing built for it is wasted.** Snapshot, restore and hash were never
rollback-only. Each has an independent consumer that is still wanted:

| Capability | Needs | Still wanted? |
|---|---|---|
| Replay seeking | `restore()` to a keyframe | Yes — D-012 |
| Desync detection | `hash()` per tick | Yes, for any netcode |
| Save / load a match | `snapshot()` + `restore()` | Yes |
| Server-side MMR validation | re-simulate, compare `hash()` | Yes — D-012 |
| Determinism regression tests | all three | Yes, already running |
| AI lookahead ("what if I attack here?") | `snapshot()` + simulate + `restore()` | Likely — D-009 |

Even if rollback is never built, none of this becomes dead code.

**Nothing was spent that would not have been spent anyway.** The costly parts
of rollback — per-tick snapshotting, a structure-of-arrays rewrite, prediction
and reconciliation — were deliberately *not* started. D-011 gated them behind a
measurement precisely so they would not be built on speculation.

**The option stays open at zero ongoing cost.** The only thing rollback needs
preserved is D-010's rule: sim state must be plain reachable data — no closures,
no functions, no `Map`/`Set` on `World`. That rule is worth keeping on its own
merits (replays and networking both require it), it is enforced by existing
tests, and it costs nothing to follow.

**What to do instead when multiplayer arrives:** deterministic lockstep with
input delay. It is what most RTS ship, it reuses the same command stream
`sim/replay.ts` already produces, and it needs no snapshotting at all. If
rollback is ever revisited, D-011's measurement gate is still the right first
step — do not start with netcode, start by measuring snapshot cost at 100+ units.

**The one thing that would genuinely hurt later:** letting unreachable state
back into `World`. A closure, a `Map`, or an object reference between entities
would break replays and validation too, not just rollback — and it would be
invisible until something desyncs. Keep the rule.

---

## D-017 — Map seed is separate from match seed
**Date:** 2026-07-27

**Decision:** `World.mapSeed` is distinct from the match seed. The same map seed
always produces the same map, and map generation draws from its own generator —
never from `world.rngState`. Maps also carry a `MAP_VERSION`.

**Reason.** They look like one number and must not be. Three things break if
they are shared:

1. **A map browser becomes impossible.** Previewing a seed would advance the
   match generator, so the match you then played would differ from the match
   you would have played without previewing.
2. **You cannot replay a match on a map you liked.** With one seed there is no
   way to hold the map fixed and vary the match, or vice versa.
3. **Matches on different maps diverge for unrelated reasons.** Generating a
   larger map consumes more random draws, silently shifting every later combat
   roll.

**`MAP_VERSION` is the non-obvious half.** A seed alone does not reproduce a
map — the generator must match too. Without a version, improving map generation
would silently make every existing seed produce different terrain, and old
replays would play out on ground that no longer matches what was recorded.
Versioning converts that from a plausible wrong answer into an explicit
rejection, exactly as tick rate already does.

**Consequence:** `mapSeed` and `mapVersion` are in the hashed state and in the
replay format (`REPLAY_VERSION` → 2). `generateScenery()` takes its RNG source
as an argument rather than reaching for the world's.

**Still to build:** actual procedural generation. Terrain is currently a fixed
formula and the map layout is hand-placed, so seeds vary only scenery today.
The seed *plumbing* is done and correct, which is the part that would have been
expensive to retrofit; the generator can be written whenever.

---

## D-018 — Multiplayer path: deterministic lockstep with input delay
**Date:** 2026-07-27

**Decision:** When multiplayer arrives, build **deterministic lockstep with
input delay**. Confirmed by the designer, superseding rollback (D-016).

**Reason:** It is what most RTS ship, for the reason RTS keep choosing it —
state is far too large to snapshot per frame at 100+ units. It also reuses what
already exists: `sim/replay.ts` produces exactly the serializable per-tick
command stream lockstep needs to exchange, and `hash()` gives per-tick desync
detection for free.

**Consequence:** input delay becomes a tuning number (typically 2–4 ticks; at
30 Hz that is 66–133 ms). This raises the value of the immediate
input-acknowledgement work already in `TODO.md` — under lockstep, local
feedback on the frame of the click is what hides the delay.

---

## D-019 — Combat damage is a deterministic expectation, not a die roll
**Date:** 2026-07-27

**Decision:** Accuracy multiplies damage rather than gating a hit/miss roll.
Combat consumes no RNG at all.

**Reason:** §2 asks for battles that are "quick and decisive", where "initial
positioning determines the outcome more than mid-fight adjustments" and micro is
"not a major skill factor". A to-hit roll works against all three — it adds
variance that rewards neither positioning nor skill, only luck, and it makes
identical engagements resolve differently for no reason a player can act on.

Folding accuracy in as a multiplier keeps every modifier in the game positional:
settle state, cohesion, elevation and facing all multiply together, and none of
them can be improved by clicking faster.

**Secondary benefit:** combat touching no RNG keeps the generator's position
independent of how many fights happened, which makes replays and future lockstep
markedly easier to reason about. Verified by test.

**Rejected:** per-attack hit rolls. Revisit only if playtesting shows fights
feel too deterministic — and if so, prefer variance in *damage magnitude* over
hit/miss, which preserves expected outcomes.

---

## D-020 — Cohesion is measured by proximity, not squad membership
**Date:** 2026-07-27

**Decision:** The diminishing-returns penalty counts friendly combat units
within `COHESION.radius`, not members of a squad. Workers are exempt.

**Reason:** The design text is ambiguous — §8.6 names the mechanic "Squad
Cohesion", while §2 describes it as "20+ units in one place". Squad-based
counting is the more literal reading and the wrong one: it is trivially
dodgeable, because an *ungrouped* blob would take no penalty at all, and that
blob is precisely the formation the rule exists to discourage.

Proximity-based counting cannot be gamed, is readable on the battlefield (you
can see the crowd), and matches the §2 wording. Workers are exempt because a
mining camp is a dense cluster that has nothing to do with deathballing.

**Numbers solved backwards from §2's requirement** that "a 30–40 unit army
should only barely beat a 20–25 unit army": at cap 20 and 0.025 per excess unit,
a 35-stack fields ~21.9 effective units against a 22-stack's ~20.9 — a ~5% edge.
A test asserts this ratio directly, so retuning the constants cannot silently
break the design intent.

**Open:** Cohort's stated flavour is Command Overload — past the cap a squad
needs a second officer-type unit (the Chronicler) to keep full accuracy. That
unit is Phase 1 roster but unimplemented, so the penalty currently always
applies; the Chronicler becomes a mitigation hook when it lands.

---

## D-021 — Resource vocabulary direction: Material / Legacy / Dominion / Relics
**Date:** 2026-07-27 · **Status:** direction accepted; implementation naming deferred

**Direction:** The resource set should tell the game's history rather than read
as minerals plus energy:

- **Material** — the physical world; used to build.
- **Legacy** — understanding inherited from previous civilizations; used to learn.
- **Dominion** — control exercised in the present.
- **Relics** — rare opportunities that change future options.

**Reason:** `Essence` no longer accurately describes the gatherable resource if
its role is understanding rather than energy. The proposed quartet communicates
build / learn / rule / adapt and fits the "Miniature Myth" identity.

**Consequence:** Do not globally rename `essence` yet. First resolve which of the
four concepts are currencies, territory statistics, map objectives, or upgrade
choices. A premature search-and-replace would collapse distinct systems into one.
Track the final schema in `OPEN_QUESTIONS.md` before migration.

---

## D-022 — Mycora fantasy: aggressive life as a tidal infection
**Date:** 2026-07-27

**Decision:** Mycora is a distributed hivemind that advances and recedes like
water. Units are temporary shapes inside the larger organism, not fully
individual creatures. Death leaves living stains—moss, fungus, flowers, and
iridescent growth—that can grant vision, expand domain, and later support other
mechanics.

**Art constraint:** It is a burst of thriving rainbow life with inspiration from
*Annihilation*, but it must never read as benevolent nature or as a visual copy
of the Zerg. The inversion is deliberate: abundant life behaves like cancer.

**Gameplay consequence:** Corpse stains/domain residue must eventually be sim
state, deterministic, replayable, and readable by AI. It is not merely a decal.

---

## D-023 — Cohort Marksman weapon language
**Date:** 2026-07-27

**Decision:** The Marksman carries its staff vertically and upright in one hand.
Its attack is genuinely emitted light, not a projectile merely styled like a
laser. Animation, effects, sound, and damage timing should preserve that read.

---

## D-024 — Conclave material language
**Date:** 2026-07-27 · **Status:** art direction seed · **extended by D-031**

**Decision:** Conclave forms should appear almost constructed from water and
fabric. This is a silhouette/material constraint for later concept development,
not yet a finalized production specification.

> **Superseded in part.** D-024 constrained what Conclave is *made of* and left
> its *proportions* open, which permitted the humanoid scholar-navigator read
> that D-031 rejects. Material language stands; silhouette does not.

---

## D-025 — The gatherable resource is violet, never teal
**Date:** 2026-07-27

**Decision:** `PALETTE.legacy` (formerly `essence`) is violet — shade `#3b2a55`,
mid `#b98ad9`, lit `#f0dcff`. Teal and cyan-blue are retired from the resource
entirely.

**Reason.** Teal failed on two counts, and the second is the more serious:

1. **It reads as StarCraft minerals.** Glowing blue crystal shards are the most
   recognisable resource in the genre. §8.8 spends its length ruling out
   accidental StarCraft parallels for the races; leaving the resource looking
   like minerals undoes that at the most-looked-at object on the map.
2. **Teal is Conclave's colour.** Conclave is Water (D-021 framing, §8.8). A
   universal resource wearing one race's element quietly steals that race's
   visual identity before it is even implemented — and Conclave arrives in
   Phase 3, so the collision would have been discovered late and expensively.

Violet is claimed by none of the four elements (Cohort bone-and-gold, Mycora
green, Conclave blue, Titanfolk stone), sits opposite the warm sun so it stays
legible against sunlit grass, and reads as "precious and old" rather than "ore" —
which matches what the resource actually *is* under D-021: **Legacy**,
understanding inherited from a dead civilization, not a mineral.

**Consequence:** `essenceMat` is aliased to `legacyMat` rather than renamed
outright, because D-021 explicitly defers the global `essence` rename until the
four-resource schema is settled. The colour changes now; the vocabulary waits.

---

## D-026 — Far-zoom world silhouette: the World Turtle
**Date:** 2026-07-27 · **Status:** locked presentation direction

**Decision:** At normal gameplay distance the battlefield remains a readable
physical war table in a black void. As the camera pulls far enough away for the
whole board to become small, the support form must resolve into a monumental,
stylized world-bearing turtle: the land rests on its shell/back and the complete
silhouette becomes legible only at strategic/cosmic scale.

**Progressive reveal:**
- Close and normal play: terrain surface and temporary descending skirts dominate;
  the carrier is hidden or only subtly implied.
- Mid zoom: shell curvature and the sculptural underside begin to read.
- Maximum zoom: head, limbs, tail, and shell produce a clear mythic silhouette in
  the black void while the battlefield remains visible on top.

**Constraint:** This is not a cartoon turtle and not decorative scenery pasted
under the map. It should feel like an ancient cosmological model, sacred gaming
relic, and living world-support structure. Geometry, LOD, lighting, camera
clipping, and far-distance composition must be designed together.

**Future extension:** The current descending terrain body remains a temporary
placeholder. A later exploration may extend the cosmology into a restrained
"turtles all the way down" recursive reveal, but that is not required for the
first production World Turtle.


---

## D-027 — Mission lands as a sim entity, inert on its own
**Date:** 2026-07-27

**Decision:** `Mission` (D-007) is now real sim state — `src/sim/missions.ts`,
hashed, replayed, tested. It does **not** yet drive squad behaviour.

**Reason:** the UI blueprint's mission panel needs a real primitive to build
against, not an ad-hoc UI state it invents itself and later has to retrofit
into the sim. Landing the data model first (objective, priority, assigned
squads, fallback, status) means that UI work is additive rather than a rewrite.

Deliberately inert: a mission does not currently change what an assigned squad
does. Deciding "assault mission -> squad behaviour X" is a real design
question (does it override the squad's own chain? layer on top of it? require
one?) that belongs with the mission-panel UI, not bundled into the primitive.

**Consequence:** `World.missions`, `REPLAY_VERSION` -> 5. A squad serves at
most one mission at a time — assigning it to a second silently drops the first,
mirroring how forming a new squad supersedes a unit's old one. Missions are
pruned of dead squad ids every tick by `stepMissions`, run after the reaper, so
a mission can never hold a dangling id that diverges between replay peers.

**Also verified this session:** the external "v1.23.0" import (fog of war,
minimap, LOD, tutorial, direct orders, map boundary, World Turtle far-zoom
silhouette — D-026) was fast-forward merged and independently re-verified:
typecheck, lint, 302 tests, `architecture.test.ts` (sim purity), and a manual
grep for `Math.random`/`Date.now`/`performance.now` in `sim/`. All clean.

---

## D-028 — Research: category-wide, derived-not-baked, engine-agnostic
**Date:** 2026-07-27

**Decision:** Cohort's tech track ships as `src/data/tech.ts` (content) plus
`src/sim/tech.ts` (engine). Seven upgrades across three tiers, including one
doctrine pair.

**Three choices worth recording, because the obvious alternative is wrong in
each case:**

**1. Effects are category-wide, never per-unit.** §8.5 asks for upgrades that
apply "broadly to a category of unit/behavior, not a single unit". A per-unit
upgrade list turns the roster into independent tuning knobs; a category list is
a doctrine. Categories are derived from unit stats (`isWorker`, weapon range),
not from a hardcoded name list, so a new unit joins the right upgrades by
declaring its stats.

**2. Modifiers are derived on demand, never baked into units on completion.**
Baking is faster and is what most engines do. It is also silently wrong under
`restore()`: rewinding to a tick before a tech completed would leave units
carrying stats they should not have, and nothing would catch it, because the
baked stats are not themselves the hashed source of truth. Deriving keeps the
researched list as the only truth — which is what `hash()` covers. A test
asserts that clearing the researched list restores original stats.

**3. Doctrine pairs do not lock each other out.** Taking Attrition first leaves
Vanguard fully available. That is the specific property distinguishing Cohort
(§8.5 "nothing permanently locked out", mastery is *timing*) from Conclave
(genuine foreclosure). Easy to get wrong by copying the usual RTS branch model;
a test guards it.

**Consequence:** `World.tech` per team, hashed with the researched list sorted
so two equivalent research orders agree. `REPLAY_VERSION` → 6.

---

## D-029 — Engine-first: race content declares traits, the engine reads them
**Date:** 2026-07-27

**Decision:** `src/sim/` must not name any specific unit, building or
technology. Race-specific mechanics are declared as **traits in `src/data/`**
and read generically by the engine.

**Reason:** the stated project philosophy is that scrapping all four races and
rebuilding should be cheap. That only holds if the simulation is a rules engine
and races are content. It had already drifted: `combat.ts` implemented the
shield wall as `if (unit.type !== 'legionnaire') return 0` — a Cohort mechanic
living inside the engine, which a from-scratch race would have had to edit
`sim/` to reuse.

Now `UnitDef.formsShieldWall` is a declared trait and the engine counts
same-type wall-forming neighbours generically. A future race gets the mechanic
by setting a boolean.

**Known remaining leak:** `sim/ai.ts` still names `'legionnaire'`/`'marksman'`
when choosing what to build. Left deliberately — fixing it properly needs a
race-roster abstraction ("give me this race's basic melee unit"), which is
worth doing when the second race lands and there is a real second case to
generalise against, rather than guessing the shape now. Tracked in TODO.

**Test:** `tests/tech.test.ts` asserts the tech engine drives entirely off the
data table and has no dangling prerequisites.

---

## D-030 — Project codename becomes Greenmantle (supersedes D-015)
**Date:** 2026-07-27

**Decision:** The project is renamed from **Longbarrow** to **Greenmantle**.

**Reason:** Longbarrow named a burial mound — bones, a dead thing grassed over.
That was right when the project was a fossil race and a terrain slab. It is no
longer what the project is. The build now carries four races framed as living
elemental forces, an overgrowth-first art direction where weathering is a real
material across *all* races, a day/night world, and a world-bearing turtle at
cosmological zoom. The old name described only the dead half.

*Greenmantle* keeps the same duality — a mantle is both a cloak and a layer of
the earth — but leads with the living side: the green that has grown over the
ancient machine, rather than the barrow underneath it. It carries forward
rather than replacing, which is the right relationship to a codename that was
never wrong, only outgrown.

**Unchanged deliberately:**

- **The GitHub repository is still `Wizard1999/Greenmantle`.** The codename
  moved first; renaming the repo is a separate manual step. `START_HERE.md`
  says so explicitly, because an agent that "corrects" the remote to match the
  codename would point it at nothing.
- **The save-file magic string stays `longbarrow-save`.** It is a format
  identifier, not a display name. Renaming it would make every save written
  before today fail to load, in exchange for nothing. Format identifiers follow
  the format's history, not the project's branding.
- **`CHANGELOG.md` and earlier decisions keep the old name.** They are dated
  records of what was true then; rewriting history to match present branding
  would make them lies.

**Consequence:** `package.json`, all live docs, page titles, the launcher
scripts (`PLAY_GREENMANTLE.bat`, `OPEN_GREENMANTLE_WEBSITE.bat`) and versioned
handoff naming (`Greenmantle-v1.23.0-work`) now use Greenmantle. D-015 is
superseded but retained — the reasoning that produced Longbarrow is still the
reasoning that produced its successor.

---

## D-031 — No race is humanoid; each reads as a *kind of thing*
**Date:** 2026-08-06 · **Status:** locked, from the designer · extends D-024

**Decision:** Conclave must not read as human. No race may. Each of the four is
recognisable at a glance as a distinct category of thing, and "people" is not
one of the categories:

| Race | Reads unmistakably as |
|---|---|
| Cohort | technology — a machine, however fossilised |
| Mycora | plant life |
| Titanfolk | earthen beasts |
| Conclave | *(its own kind of thing — water and fabric, not a person made of them)* |

**Reason.** §1 states the four races are **forces of nature, not
civilizations**, and §8.8 goes to some length ruling out accidental
Terran/Protoss/Zerg parallels. Three of the four already honour that: nothing
about a fossil war-machine, a walking blight, or a standing landform invites a
human read. Conclave was the exception, and the drift is traceable — §8.7
describes "navigator-scholar units", §8.8 says "waterway civilization", and
D-024 constrained only the *material* while leaving proportion open. Water and
fabric draped on a two-arms-two-legs frame is a robed person, which makes
Conclave the one race that reads as a civilization in a game whose premise is
that none of them are. It also lands it closest to Protoss, the exact parallel
§8.8 spends its length avoiding.

The governing rule in §1 — every race answers the same questions differently,
*based on a core value it holds* — is what makes the fix straightforward.
Conclave's value is Knowledge and its element is Water, and its mechanics are
already network-shaped: Project from Network construction, Coordination as a
function of links, an economy that starves when a link is cut. A humanoid is
the one silhouette that expresses none of that. **The form should follow the
network, not carry it** — Conclave should read as *current given purpose*
rather than as a people who direct currents.

**Consequence:**

- The existing `conclave-ritual.webp` concept image is now a **reference for
  material and palette only**, not for silhouette or proportion. It is not
  deleted — it records what was explored — but it must not be used as a
  production target for form. `ART_REFERENCES.md` and `ART_PROMPTS.md` need
  correcting before any Conclave art is generated against them.
- The unit roster names in §8.7 (Adept, Channeler, Phantom, Archivist,
  Ascendant) read as scholarly job titles and pull toward the humanoid reading.
  Renaming is **not** decided here — it is a designer call, and it is logged in
  `WORKLOG.md` as held back.
- Nothing mechanical changes. Conclave is Phase 3; this lands before any
  Conclave art or geometry is produced, which is the cheapest possible moment.

**Rejected:** keeping a humanoid Conclave as deliberate contrast against three
non-humanoid races. It is a coherent argument — one recognisable silhouette
among three alien ones would read as *the* civilization — but it directly
contradicts the locked §1 framing that no race is a civilization, and it hands
the most familiar shape in the genre to the race already nearest a StarCraft
parallel.

---

## D-033 — The resource schema, resolved
**Date:** 2026-08-06 · **Status:** locked, from the designer · resolves D-021 and `GAME_DESIGN.md` §11.1

**Decision:** Four resources, in three different *kinds*. The distinction that
D-021 deferred was never "what are they called" but "how is each one obtained",
and that is what this settles:

| Resource | Kind | How it is obtained |
|---|---|---|
| **Material** | Gatherable | Harvested from the map |
| **Legacy** | Gatherable | Harvested from the map |
| **Dominion** | Derived statistic | Determined by the territory you control |
| **Relics** | Contested objective | Won from encounters players compete over |

**Reason.** D-021 accepted the vocabulary and explicitly refused to migrate the
code until this was known, because a premature rename would "collapse distinct
systems into one" — and it would have. Three of the four are not currencies at
all in the same sense: Dominion is never picked up, it is a readout of board
control, and Relics are not harvested but won. Renaming `essence` to any of
these before knowing that would have produced a gather loop for a statistic.

**Consequence — and the part that is real work:**

- **There are now two gatherables where the build ships one.** `essence` becomes
  **Legacy** — D-025 already made the gatherable violet and named the palette
  entry `PALETTE.legacy` precisely in anticipation of this. **Material** is a
  new node type, a new colour outside the four race elements and outside
  violet, and a second number in the economy. This is not a rename; it is an
  economic system change, and it should land against `sim/economy.ts` with its
  own tests rather than as a search-and-replace.
- **Dominion needs a territory model.** `supply.ts` already computes control
  radius per building. Dominion is derived from that and must be *hashed state*
  if anything spends it (D-010, D-012).
- **Relics ride on the PvE/PvP encounter system** in §6, which is Phase 4. No
  work is unblocked yet, but the resource is now defined rather than floating.
- **This does not give any race a second unrelated resource.** §8.5's rule —
  one per-race stat gates army size, automation bandwidth and tech together —
  is about Command / Population / Coordination / Territory, which are supply,
  not gatherables. Material and Legacy are universal inputs; the per-race stat
  is unchanged.

**Flagged, not decided:** Titanfolk's supply stat is named **Territory** (§8.3)
and Dominion is "determined by the territory you control". Two different systems
currently wear the same word. Worth a naming pass before Titanfolk is built;
recorded here so it is not discovered late.

### D-033a — Material is loosely defined, and that is an engine requirement

**Decision:** *What* Material comes from is deliberately open — trees, nearby
rocks, digging into a mountainside. All of it yields Material for now.

**Reason, and why this is architecture rather than flavour.** The point is not
that the sources are varied; it is that the engine must not care. Underneath
the game is a reusable RTS engine (`ENGINE_VISION.md`, D-029), and the test of
that claim is whether the entire game design can be redrawn without touching
anything outside the design data. A gather loop that knows about crystals fails
that test the first time the resource becomes a forest.

**Consequence:** a resource node is a **harvestable source** declaring what it
yields, how much, how it is worked and how it presents — all in `src/data/`.
`sim/economy.ts` reads those declarations generically and must never name a
source type. Adding "mine the mountainside" then costs a data entry and a mesh,
not an engine change. This is the same rule D-029 applied to unit traits,
applied to the economy.

---

## D-034 — Terrain is terrain; there is no separate map-feature system
**Date:** 2026-08-06 · **Status:** locked, from the designer · resolves `GAME_DESIGN.md` §11.1

**Decision:** Mountain passes, cliffs, ramps, chokepoints and alternate routes
are **produced by map generation as terrain**, not implemented as distinct
mechanical systems layered on top of it. There is no "tunnel object", no "ramp
entity", no special-cased hidden route.

**Reason:** §2 already locks high ground, flanking, chokepoints and terrain as
the things that decide fights. A second system that also produces tactical
geography would mean two sources of truth for the same question — a unit would
have to ask both "how high am I" and "am I in a tunnel", and the answers could
disagree. One heightfield and one boundary polygon answer everything, and every
existing consumer — pathing, placement, fog, the minimap, saves, replays — is
already wired to those.

**Consequence:** the procedural generator carries this weight. Interesting
geography is a *generator* requirement (`MAP_GENERATION.md`), not a gameplay
feature to be scheduled separately. `MAP_VERSION` must be bumped whenever the
generator changes, or old replays play out on ground that no longer matches.

**Rejected:** tunnels and hidden routes as first-class map elements, the early
"living playset" idea recorded in §11.1. Kept as a rejected alternative rather
than deleted, because the reason it was attractive — surprise and asymmetric
routes — is a real goal that the generator now owns.

---

## D-035 — Air and ground draw on the same supply pool
**Date:** 2026-08-06 · **Status:** locked, from the designer · resolves `GAME_DESIGN.md` §11.1

**Decision:** Air units draw on the **same per-race supply resource** as ground
units — Command for Cohort, Population for Mycora, Coordination for Conclave,
Territory for Titanfolk. There is no separate air pool.

**Reason:** §8.5's cross-race rule is that one stat per race governs army size,
automation bandwidth and tech power simultaneously, and that this is "what keeps
the four systems feeling unified rather than bolted together". A dedicated air
pool would be exactly the second unrelated resource that rule forbids. It also
makes air a genuine *choice* rather than a free additional army: fielding air
costs ground, which is the trade §7 wants when it says air should "enhance the
battlefield, not escape it".

**Consequence:** §7's "command-bandwidth limits" as an anti-deathball measure is
now concrete rather than aspirational — it is the shared pool. Air rosters must
be costed against ground units in the same currency when Phase 4.2 arrives.

---

## D-036 — The World Turtle is confirmed by the designer
**Date:** 2026-08-06 · **Status:** locked, from the designer · confirms D-026

**Decision:** D-026's far-zoom World Turtle is wanted. Build whatever art it
needs.

**Reason:** D-026 arrived in an external import rather than from the designer,
and the previous handoff flagged it as "a real scope addition, worth confirming
before more art is built on it". It is confirmed. That caveat is now closed and
should not be raised again.

**Consequence:** the World Turtle work in `TODO.md` — distance-tiered shell,
low-detail far silhouette for head, limbs and tail, far-zoom profiling — is
approved scope rather than provisional.

---

## D-037 — Environmental variation is symmetric, never a die roll
**Date:** 2026-08-06 · **Status:** locked, from the designer

**Decision:** Night, biome and any future weather **do** affect gameplay. Each
carries advantages *and* disadvantages, balanced overall, so the effect is a
change of feel rather than a change of who is winning. The governing rule:

> Variation is legitimate when both sides face the same conditions. What is
> forbidden is variation that hands one player an advantage they did not earn.

**Reason:** this is the precise form of the "no randomness" pillar, and it is
narrower than it first appears. D-019 removed the to-hit roll because it added
variance that "rewards neither positioning nor skill, only luck". Night falling
on both armies at once is not that: it is a *known, symmetric, readable*
condition that both players can plan around, and planning around it is exactly
the skill §1 wants to reward. A dice roll is unfair because it is private and
unearned; a night cycle is public and shared.

**Consequence:**

- Night may change vision range, and races may perform differently in different
  biomes or weather. Each such effect must be a declared trait in `src/data/`,
  never a unit-name check in `sim/` (D-029).
- **Symmetry is a testable property and must be tested.** An effect that applies
  at different times, or to different amounts of the map, for the two players is
  a bug — and B-007 shows this project already ships one: terrain height is not
  rotationally symmetric, so one spawn holds high ground for free.
- Every environmental effect stays derived from `world.tick` and the map seed
  (D-013, D-017), never from wall clock and never from `world.rngState` at
  match time — so a replay reproduces the same weather on the same tick.
- Effects must be **readable before they matter**. A player who cannot see night
  approaching cannot plan around it, and an unplannable condition is a die roll
  wearing a clock.

**Rejected:** night as purely cosmetic. It was the safe option and it wastes a
system that is already simulation state, already hashed, and already displayed.

---

## D-038 — The map is far larger, and nothing may assume its size
**Date:** 2026-08-06 · **Status:** locked, from the designer

**Decision:** Two things, and the second matters more than the first.

**1. The battlefield grows by roughly an order of magnitude in area.** The floor
is 7× the current area; the target is 15–16×. `BASE_RADIUS` moves from 39 to
**156** — 4× the linear scale, 16× the area — expressed as a single value in
`src/data/`, so the whole range is one edit.

**2. No code may know the map's size except the map definition.** Size is
discovered from data, never assumed.

**Reason.** The measurement that prompted this: a real match ships **4 resource
nodes, every one inside a starting control radius**, peaks at **28 units across
both teams**, and ends in **2.0 minutes** with 2,760 resource unspent. Three
separate design promises fail at once on a board that small — §8.1's expansion
philosophy is inert because there is nothing to expand *to*, D-006's 100-unit
performance target is unreachable by a factor of seven in any actual match, and
§3's 10–15 minute pacing target is off by an order of magnitude. None of those
are balance problems. The board is too small to contain the game.

The second half is the engine-first rule (D-029, D-033a) applied to geography.
An audit found five places that each independently assumed the map's
dimensions:

| Location | Assumption |
|---|---|
| `sim/mapBoundary.ts` | `BASE_RADIUS = 39`, a content number living inside the engine |
| `sim/terrain.ts` | `TERRAIN_SIZE = 80` |
| `render/camera.ts` | `boundary?.bounds.width ?? 80` |
| `render/cameraMath.ts` | camera limits fixed at ±180, `maxDistance` 520 |
| `ui/fogOfWar.ts` | a 48×48 grid regardless of how much ground it covers |

Every one is a place where changing the map silently breaks something else —
the fog grid is the clearest: at 16× area its cells become 6.5 world units
across instead of 1.6, so the fog would coarsen exactly as the map got big
enough to need it fine. A creator swapping in their own map (`ENGINE_VISION.md`)
would hit all five.

**Consequence:**

- Map dimensions move to `src/data/`, per CLAUDE.md's rule that no balance or
  content number lives outside it.
- **Camera limits derive from the boundary** rather than being constants. A
  fixed ±180 pan limit on a 312-wide board would fence the player inside the
  middle of their own map.
- **Fog resolution derives from the boundary**, so cell size in world units is
  what stays constant, not cell count.
- `MAP_VERSION` bumps: every seed produces a different board.
- Resource placement must put nodes **outside** starting control radii, or a
  bigger map changes nothing about the economy. Expansion has to be the reason
  the space exists.
- Crossing time grows with the map. At 4× linear and a Legionnaire's speed of
  4.2, a full traverse is roughly 74 seconds — that is a real strategic
  distance, and it is what makes scouting, screening and fallback positions
  mean anything.

---

## D-039 — Fog conceals the map's extent, not merely its contents
**Date:** 2026-08-06 · **Status:** locked, from the designer · amends D-005 in one respect

**Decision:** Unexplored ground is not a dim version of the board — it is
**absence**. The player cannot see the shape, size or edge of the map until
they have explored it. Explored-but-unwatched ground remains a legible dim
veil; only *never seen* reads as nothing at all.

**Reason.** The map's extent is information, and it is exactly the information
scouting is supposed to buy. A board whose silhouette is visible from the first
frame has already answered "how much space is there, and where does it end?"
before anyone has walked anywhere — which makes the first minutes of §3's
"full scouting should always be possible for a player willing to invest in it"
a formality.

**This reverses a change made earlier the same day.** When the fog was rebuilt
(B-004), its unexplored tone was deliberately *lifted* so the board would stay
"legible as an object against the void" at war-table zoom. That was a
defensible reading of D-005 — shadows shift hue rather than going to black —
and it was the wrong call, because it optimised for the board looking like a
war table over the player not knowing what they had not seen.

**The distinction that resolves it with D-005:** D-005 governs *shading*. A
surface in shadow is still a surface, and rendering it black throws away form
that is really there. Unexplored ground is not shaded — it is unknown. There is
no form to preserve, and drawing one is a claim the game has no business
making. Shadow is dark; the unknown is empty. They are not the same and should
not look the same.

**Consequence:** the three fog states now differ in kind, not only in degree —
unknown reads as void, remembered as a violet veil over real ground, visible as
clear. The board's silhouette against the void therefore *grows* as the match
proceeds, which is a better expression of D-014's war table than a complete
board revealed at the start.

---

## D-040 — Concealment: dead ground and cover are two different mechanics
**Date:** 2026-08-07 · **Status:** locked, from the designer · resolves the ambush half of `GAME_DESIGN.md` §11.1

**Decision:** Terrain hides units in **both** of the ways real ground does, and
they are deliberately not the same system:

| | **Dead ground** | **Cover** |
|---|---|---|
| Cause | Elevation blocks line of sight | Terrain type — thicket, ravine, ruin |
| Effect | Seen not at all | Seen only at short range |
| Nature | Geometric and absolute | A reduction, never a binary |
| Real analogue | You cannot see over the ridge | You can see into the wood if you are close |

**Reason.** §2 lists ambush beside flanking and high ground as decisive, and
nothing in the build delivers it — vision is a plain radius, so there is no
ground on the map where an army can wait unseen. One mechanic would not have
been enough: a ridge and a thicket conceal for genuinely different reasons, and
collapsing them into one "stealth" value would lose the distinction a commander
actually reasons about. Dead ground is a fact about geometry that both players
can read off the terrain; cover is a gamble on how close the enemy gets.

**The constraint that governs the implementation: it must be readable.** The
designer's phrase is "the highest amount of easily readable reasonable
variety" — variety is the goal, but legibility is the limit. Concretely:

- **Cover is visible; what is in it is not.** A player can always see the
  thicket. That is what makes moving past it a decision rather than a surprise.
- **Dead ground is inferable from the terrain the player can already see.** If a
  ridge blocks sight, the ridge is on screen. Nothing is hidden that has no
  visible cause.
- **A concealed unit that *is* detected must show why.** Otherwise the player
  learns that units randomly fail to be seen, which is indistinguishable from a
  bug.
- **No randomness.** D-019 stands: detection is a deterministic function of
  distance, terrain and vision, never a roll. An ambush that sometimes fails for
  no readable reason is exactly the variance §2 rules out.

**Consequence — and the parts that cost something:**

1. **Vision stops being a circle.** `ui/fogOfWar.ts` tests radius only. Line of
   sight has to sample terrain height along the ray from observer to cell. This
   is the expensive part: on the 156-radius board (D-038) the fog grid is large
   and this runs per vision source per frame. It needs a cheap silhouette walk
   and probably a lower update cadence than the render loop, and it must be
   profiled against D-006 before it ships. **This is the reason the feature is
   not free**, and it should be built with the benchmark harness in hand.
2. **Terrain gains declared types.** Thicket, ravine and open ground become map
   data with a declared `concealment` value in `src/data/`, read generically —
   never a check for a specific feature name inside `sim/` (D-029). Scenery is
   currently decorative (`render/sceneryViews.ts`); cover makes some of it
   gameplay, so it moves into the map definition rather than being generated
   for looks.
3. **It belongs to map generation.** D-034 put passes, cliffs and routes in the
   generator's hands, and cover is the same kind of thing. Ambush positions are
   a *generator* requirement: a map with no thickets on its approaches has no
   ambushes, however good the mechanic is.
4. **Detection range becomes a unit stat.** A scout sees further into cover
   than a line unit does. That is the trait the Chronicler's "reveals stealth"
   should become — see below.
5. **The AI must obey it.** `sim/ai.ts` currently reads every unit and node
   regardless of visibility, which its own header admits is "on trust". Ambush
   is meaningless against an opponent that cannot be surprised, so this has to
   land with the AI's information model, not before it.

**What this does *not* decide.** Unit-level stealth as an ability — Conclave's
Phantom, and whatever "illusions" turns out to mean — stays open. It is Phase 3
and the roster is being reapproached. Cohort's **Chronicler** is unblocked by
this decision: "reveals stealth" becomes "sees further into cover than anything
else in the roster", which is a number rather than a new system.

---

## D-032 — The HUD is one command surface; help is timed, not permanent
**Date:** 2026-08-06

**Decision:** The in-game HUD is rebuilt as a single console in one visual
language ("warm vellum"), laid out from the four screen corners, with the
battlefield uninterrupted between them. Permanent instructional text is
replaced by help that arrives when it is wanted. Developer scaffolding is gated
behind `?dev=` at the point of construction, not merely hidden.

**What was actually wrong.** Measured, not asserted (`scripts/measure-hud.mjs`,
run against the running build at 1237x604 to match the recorded baseline):

| | Before | After |
|---|---|---|
| HUD share of viewport | 49.4% | 23.8% |
| Panels overlapping | 5 pairs | 0 |
| Distinct panel backgrounds | 5, across two visual languages | 1 |
| Panels declaring a z-index | 3 of 11 | 8 of 8 |
| Buttons a click cannot reach | 3 of 13 | 0 of 13 |

The last row is the one that mattered. `.panel` set `pointer-events: none`;
`#card` and `#chain` overrode it and `#research` did not, so every research
button passed its click through to the battlefield. `elementFromPoint` at the
panel's centre returned the CANVAS. The tech system (D-028) had shipped with no
player access at all, and nothing failed loudly enough to notice.

**Five choices worth recording:**

**1. Panels accept pointer events by default.** The old default was `none` with
per-panel opt-ins. Both failure modes are now inverted: a panel that wrongly
swallows a click is immediately visible, and one that wrongly drops a click can
no longer exist. Read-only surfaces (`#res`, `#flash`, `#build-id`, `#selbox`)
opt *out*, and there are four of them, so the exception list is short enough to
read.

**2. The keybinding wall is split by *when* help is wanted, not deleted.** The
twelve-line block headed "Phase 1.7 — Squads & Behaviour Chains" was doing two
jobs badly. Learning the game is now the guided tutorial, which opens itself
once on a first visit and never again — it already existed and already watched
world state to know when a step was done, it was just hidden behind a button
nobody had a reason to press. Looking a key up is now a reference sheet on `?`,
grouped by intent, which is a *superset* of the old wall: it adds the bindings
the wall never listed (R, Esc, minimap click) and drops only the milestone
number, which was never help. `CONTROL_GROUPS` is plain data and a test asserts
it covers every key `input/keyboard.ts` binds, so the sheet cannot silently
rot into a lie.

**3. The debug readout is gated by construction, not by CSS.** `?dev=` decides
whether the DOM is built at all. A `display: none` gate would have kept the
panel one stylesheet edit away from shipping again, and would still have put
seven live counters in a player's document.

**4. Settings live inside the reference sheet.** The quality selector was a dark
monospace chip floating over the battlefield, in a different visual language
from everything within 200 px of it, for a choice a player makes once a session.
It is now a row at the *top* of the sheet — above the reference table, because
the table is tall enough to scroll on a laptop and a control past the fold is a
control the player has to go looking for. That was verified by hit-testing the
select after opening the sheet, not by reading the markup.

**5. One panel material, chosen against the art direction rather than the
genre.** The bar was StarCraft II's command console — one coherent surface,
nothing overlapping, everything reachable. Its *look* was deliberately not
copied: D-005 asks for warm painterly light with shadows shifting toward violet,
so panels are aged vellum with a weathered brown edge and a violet-shifted
shadow, headings in Georgia, costs in `PALETTE.legacy` violet. Monospace now
appears nowhere a player can see it, which makes a leak of developer chrome
visible at a glance.

**Also fixed in passing:** the minimap drew resource nodes in teal, directly
contradicting D-025 on the surface a player scans most often. Now violet.
`#build-id` carried no `.panel` class, so it had no positioning at all and laid
out as a full-width static block behind the top of the HUD.

**Rejected:** collapsing the research panel to a header to buy back screen
share. It would have traded the actual defect — a system the player could not
find — for a percentage point.

**Honest limit:** panels are fixed-size objects, so screen share is
viewport-dependent. At 1920x1080 the battlefield holds **90.5%**, inside
`UI_BLUEPRINT.md`'s 85–90% target. At 1280x800 it holds **82.6%**, short of it,
even after a media query tightens the whole console. Going further means
shrinking the selection card or the minimap past legibility, which is the wrong
trade — but the gap is real and is not closed.
