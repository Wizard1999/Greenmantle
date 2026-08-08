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

### B-004 · FIXED 2026-08-06 · render · Fog of war renders as hard tiles
"Hard tiles" undersold it. The overlay instanced one **flat** quad per grid cell
— up to 2,304 — each parked at the terrain height of its own centre and scaled
1.04× so neighbours overlapped. Over sloping ground that produced a staircase of
terraces, z-fighting along every seam, and bright slivers of terrain punching
through. At ordinary play distance it was the loudest thing on screen and it
overwrote the painterly direction entirely.

**Status: fixed, three separate causes.**

1. **Geometry.** The fog now shares the terrain mesh's own geometry, lifted by
   depth bias rather than in space. It is the same surface as the ground, so it
   cannot step, cannot z-fight, and is clipped to the map polygon for free.
2. **Mask.** `FogOfWarField.concealment()` returns a blurred scalar field
   sampled with `LinearFilter`, so there are no cell edges. Raising the grid
   resolution would not have worked — more, smaller squares are still squares.
   Off-board cells are excluded from the blur rather than counted as concealed,
   which would have dragged a dark band inward from the rim.
3. **Colour.** The shader was writing raw linear values while every other
   surface goes through tone mapping and linear-to-sRGB. That crushed the
   intended deep violet to near-black — the exact D-005 violation the earlier
   colour fix was supposed to have cured, reintroduced by a missing
   `#include`. With the conversion restored the board stays legible as an
   object against the void at war-table zoom.

Scenery was also drawn fully lit on top of the fog, which read as trees floating
in blackness and quietly disclosed the shape of unscouted terrain. Props on
never-seen ground are now hidden; explored ground keeps them, which is what
"explored" means.

Draw calls at tactical distance fell from 150 to 106.
**Guarded by:** `tests/fogSoftness.test.ts` — including an assertion that the
mask takes many distinct values rather than the three a binary field can, which
is the property that actually removes the cell edges.

### B-011 · high · balance · Turning is fast enough to make a flank worth one volley
Adding a bounded turn rate fixed the manoeuvre (a march around the back is no
longer worth literally zero) and, on the same change, collapsed the payoff at
contact. A 10v10 whose defender faces entirely the wrong way was **10–0 in 336
ticks**; it is now **mutual annihilation on tick 456** — the same result as
attacking head-on. The flank is worth 21.94 HP out of a 1200 HP pool: **1.8%**.

The cause is a ratio, and it is exact. `turnRate` 0.110 rad/tick gives a 30-tick
about-face against `attackTicks` of 24, so a defender re-faces inside roughly
one attack cycle and the bonus lands exactly once. The measured rear/side lead
ratio is **2.3333**, which is `(1.35-1)/(1.15-1)` to four figures — the
signature of precisely one boosted volley per model.

Two consequences fall out of the same number. At ten a side, marching around the
back still changes no *outcome*: 21.94 HP never crosses a 120 HP kill step, so
the result deep-equals the head-on fight at every separation. It converts at
three a side and nowhere else tested. And a lone flanker from acquire range
lands nothing at all — the defender comes square-on at 3.40 separation while
contact is 6 ticks later, so a defender turns faster than an attacker closes.

**Fix direction, and it costs no responsiveness.** Turning already never gates
movement, so slowing it is free against the "more responsive than StarCraft"
requirement. Split the rate in two: keep the fast rate for turning toward travel
(so movement still reads crisply) and give *re-facing toward a target* a much
slower rate — around 0.037 rad/tick puts an about-face near 84 ticks, roughly
three and a half volleys of rear exposure. That targets the fight without
touching how the game feels to drive.
**Status:** open. A balance number, and it would invalidate the flanking suite a
second time, so it wants doing deliberately rather than at the end of a session.

### B-009 · high · balance · Melee units can never reach high ground
Measured by sweeping the whole board at 0.25 spacing across 64 directions: the
largest height difference available at a Legionnaire's contact reach of **1.74**
is **0.4797**, against `HIGH_GROUND_THRESHOLD` of **0.600**. A 0.6 gap first
appears somewhere between 2.00 and 2.25 units of separation. So no melee unit in
the roster can ever give or receive an elevation modifier, anywhere, on any
tile — while §2 names high ground as decisive and §8.7 builds Cohort's core
melee unit around holding a line.

Confirmed real: eight Marksmen on a measured ridge beat eight identical
Marksmen below **8–0** with 163.0 hp standing; the same eight on level ground
annihilate each other. High ground works, for exactly one unit type. Break-even
is nine low-ground units against eight high — worth about 12.5%, so "decides
fights" overstates it and "worth a modest numerical deficit" is accurate.

`elevationMultiplier` is not at fault. This is a scale mismatch between three
numbers in three files that were never checked against each other:
`HIGH_GROUND_THRESHOLD` (`sim/terrain.ts`), the amplitude of `terrainHeightAt`
(same file), and weapon range (`data/units.ts`).

**Three levers, all designer calls:** raise terrain amplitude ~1.26×, drop the
threshold to ≤0.47, or lengthen melee reach. Raising the amplitude was
implemented and then reverted — it works, but it silently invalidated the
freshly written high-ground scenarios, and picking between three valid options
is not a defect fix.
**Status:** open, needs a designer decision.

### B-010 · low · render · The descending skirt discloses the map's extent
D-039 conceals unexplored ground so the board's size and shape must be scouted.
The fog covers the top surface only; the polygon skirt around the rim is a plain
material and is never concealed, so the board's outline is still faintly legible
against the void before anything has been explored.
**Status:** open.

### B-008 · high · sim · The board is too small to contain the game
Measured on a real match, seed 1337, with the AI opponent as `main.ts` sets it
up:

```
nodes = 4, total resource 4800, all 4 inside a starting control radius (18)
peak units on map, BOTH teams = 28
match ended at 2.0 min by base destruction, 2760 resource unspent
```

Three design promises fail at once, and none of them is a balance problem:

- **Expansion is inert.** Every resource node on the map already sits inside a
  starting control radius, so §8.1's whole "expansion philosophy" row — the
  thing that distinguishes the four races economically — has nothing to act on.
- **D-006 is unreachable.** The 100+ unit performance target cannot be
  exercised by any actual match; peak is 28 across *both* teams, a factor of
  seven out. Every benchmark assuming large armies is untestable until this
  changes.
- **Pacing is an order of magnitude off.** §3 targets 10–15 minutes. Two.

Note the resources were *not* exhausted — 2,760 of 4,800 remained. The match
ended because a base fell, not because the map ran dry, so raising node amounts
would fix nothing.

**Fix direction:** D-038 — grow the board 7–16× in area, move its dimensions to
`src/data/`, derive camera limits and fog resolution from the boundary instead
of hardcoding them, and place resource nodes *outside* starting control radii so
the extra space is a reason to expand rather than empty ground.
**Status:** open, confirmed by direct measurement 2026-08-06.

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
