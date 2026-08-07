# Bugs

Known defects. Fixed bugs move to `CHANGELOG.md` with the version that fixed them.

Format: severity · area · description · repro · status

---

## Open

### B-005 · FIXED 2026-08-06 · sim · A mirrored fight is decided entirely by array insertion order
Two identical 10-unit forces, mirrored, inside weapon reach, resolve **10–0 for
whichever team was pushed into `world.units` first** — in exactly 384 ticks
either way. Reversing only the insertion order reverses the entire result.

This is not randomness; combat consumes no RNG by design (D-019). It is a
systematic first-mover advantage: `stepCombat` iterates `world.units` in order
and applies damage immediately, so a unit earlier in the array strikes, kills,
and its victim is removed before it ever swings back. The advantage compounds
down the line.

It invalidates the design's most load-bearing balance claim — §2's "maps are
symmetric from spawns, no spawn point has an inherent advantage" — and it
silently invalidates *every* combat measurement taken on top of it, including
any future flanking or high-ground scenario.

**Fix direction:** resolve damage in two phases — read every attacker's intent
against the state at tick start, then apply. Removing the dead must happen after
both sides have struck. Do not fix by shuffling the array; that trades a
systematic bias for a seed-dependent one and breaks D-019's "no hidden
randomness".
**Repro:** spawn 10 legionnaires per team at ±0.36 on x, mirrored on z, run
5400 ticks; swap the two `spawnUnit` calls and run again.
**Status:** **fixed.** `stepCombat` now resolves in two phases — every attacker
reads its intent against the state at tick start, then all damage applies. A
unit that dies this tick still lands the blow it had already thrown, so mutual
destruction is reachable and the mirror holds. Guarded by
`tests/combatSymmetry.test.ts`, which asserts identical health on both sides at
*every* tick of a mirrored fight, not merely at the end. `REPLAY_VERSION` → 7.

### B-006 · FIXED 2026-08-06 · sim · Units acquire targets they can never reach
`COMBAT.acquireRange` is 9.0; a Legionnaire's weapon range is **0.9**. A unit
therefore sees an enemy from ten times further away than it can hit one — and
nothing closes the gap. `stepCombat` writes `u.targetId`, but `stepMovement`
moves a unit only toward `u.target`, a *position*, and no system ever converts
one into the other.

Measured: two 10-unit lines 30 apart, 3600 ticks (120 simulated seconds).
Total HP unchanged at 2400. Distance unchanged at 30.00. No unit ever held a
move target or a target id. They stood and looked at each other.

Every fight in the game today happens only where the player has personally
parked units within 0.9 of each other. The selection card advertises
"Attack Move (A) — engage along route", which is not true: attack-move walks to
a point and engages nothing on the way.

**Fix direction:** a pursuit step that gives a unit with a `targetId` and no
order a move target toward it, bounded by a leash so units do not chase across
the map — and gated by `orderMode`, since a unit told to hold position must not
wander. This is squad-level intent under D-003, so it belongs above the unit.
**Repro:** the probe above; or in-game, attack-move past an idle enemy.
**Status:** **fixed.** `stepPursuit` (in `sim/combat.ts`, run after the reaper)
gives a unit with an acquired target a move target toward it, leashed to
`COMBAT.pursuitLeash` from where the pursuit began, and restores the
interrupted destination on disengaging. The order contract is respected
exactly: `hold` never moves, `move` never diverts, `attackMove` and `patrol`
pursue and then resume their route, `idle` defends itself and returns. Workers
never pursue. Re-running the original measurement — two ten-unit lines thirty
apart under attack-move — now goes 2400 HP to 254 rather than dealing no damage
at all. `REPLAY_VERSION` → 7.

**It broke eleven tests, and that was the most useful thing it did.** Suites for
construction, squads and supply were passing *because* combat did not work: a
lone worker could stroll to a build site at mid-map because the enemy army,
though well within acquire range, could never close. With pursuit working the
worker is hunted and killed on the way. Those fixtures now use
`peacefulMap()` — a world with no hostile army — which states the intent
plainly. A fixture that depends on a broken mechanic is a fixture that will
defend the bug.

### B-007 · FIXED 2026-08-06 · sim · Terrain is not rotationally symmetric, so spawns are not equal
§2 requires symmetric spawns. Sampling `terrainHeightAt` at 800 pairs of points
related by 180° rotation about the map centre, across 200 seeds: **mean height
delta 0.69, worst 1.36, and 600 of 800 pairs differ by more than 0.01.**

`COMBAT.highGroundBonus` is 1.25 and `lowGroundPenalty` is 0.85, so elevation
multiplies damage directly. A mirrored engagement is therefore not a mirror.

Note the terrain is still "a fixed formula" (D-017), so this is a property of
the formula rather than of any seed — every map has it, and no map browser or
generator work will fix it by itself.

`tests/world.test.ts` and `tests/mapBoundary.test.ts` assert *position* symmetry
only, which is why this survived.
**Status:** **fixed structurally, not by tuning.** `terrainHeightAt` is now a
sum of terms that are each *even* under `(x, z) → (-x, -z)` — `cos·cos`,
`sin·sin`, and `cos(x ± z)` — so symmetry holds for any coefficients a later
art pass picks, rather than depending on numbers someone got right once. All
800 mirrored pairs now differ by 0, and base anchors match across 200 seeds.
`MAP_VERSION` → 4, because every existing seed produces different ground.

Guarded by `tests/terrainSymmetry.test.ts`, which also asserts the terrain is
**not flat** — a constant height would satisfy every symmetry check and destroy
§2's "terrain decides fights" — and that a height gap crossing
`HIGH_GROUND_THRESHOLD` is reachable *within* one acquire range, so elevation
can actually matter between two units fighting rather than only across the map.

**One existing test was written against the bug.** `phase1.test.ts` searched for
an elevation gap by placing the defender at the attacker's 180° mirror, which
only ever found one *because* the terrain was asymmetric. Under the fix that
search can never succeed. It now offsets the two positions independently. A test
that passes only while a defect exists is a test defending the defect.

### B-004 · medium · render · Fog of war renders as hard tiles
The fog overlay is a coarse grid of instanced quads, so its edges are visibly
square against painterly terrain — it reads as a checkerboard rather than
concealment. The colour was fixed (was pure black, violating D-005's "shadows
shift hue, never go black"; now deep violet-blue), but the tiling is
structural.
**Fix direction:** render fog to a texture and sample it smoothly, or blur the
mask, rather than raising the grid resolution — more, smaller squares is still
squares.
**Repro:** load the game at any quality with default vision.
**Status:** open. Colour corrected 2026-07-27; softness outstanding.

### B-001 · low · render · Scenery and resource nodes use stock materials
`sceneryViews.ts` and `nodeViews.ts` still build `MeshStandardMaterial`, so they
do not match the painterly shading applied elsewhere. Cosmetic inconsistency,
not a defect in behaviour.
**Status:** open — folded into the art pass in `TODO.md`.

### B-002 · unknown · perf · 100-unit performance is unverified
`DECISIONS.md` D-006 commits to 100+ units at 1080p/30fps on a 2017 integrated
GPU. Nothing has measured this yet. It may already fail.
**Repro:** none — needs the perf harness in `TODO.md § Infrastructure`.
**Status:** open, unmeasured.

### B-003 · low · sim · Combat target acquisition is O(n²)
Every unit scans every enemy each tick. Fine at current counts, but this is the
first thing that will break the 100-unit target, and the tick-rate increase to
30 Hz makes it 1.5× more expensive per second.
**Status:** open — needs a spatial grid before unit counts grow.

---

## Watch list

Not bugs yet, but the places where bugs are most likely to appear first.

- **Determinism is not fairness.** `tests/determinism.test.ts` proves the sim
  produces the same result twice. B-005 is the reminder that this says nothing
  about whether that result is *correct*: a fight decided by array order is
  perfectly deterministic and perfectly unfair, and the determinism suite was
  green throughout. Symmetry needs its own assertions.
- **Tick-rate migration.** The 20 → 30 Hz change rescaled every tick constant by
  1.5. Any constant that was missed will produce subtly wrong timing rather than
  an obvious failure. Suspect this first if pacing feels off.
- **`MAX_CATCHUP` clamp.** After 5 catch-up steps the accumulator is zeroed,
  which silently drops simulated time. Correct for a stalled tab, but it means a
  heavily loaded client runs *slower* than real time rather than falling behind
  — relevant if lockstep multiplayer ever lands.

---

## Fixed

*(none yet — this file was created 2026-07-27)*
