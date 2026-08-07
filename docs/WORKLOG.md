# Work Log

Canonical record of the gauntlet. `PROGRESS.md` answers *"how far along is the
project?"*; this answers *"what is on the bench right now, what is it being
judged against, and what did the critic actually say?"*

It is public data. `npm run sync:site` publishes it to `/gauntlet.html`, and
`npm run check:site` fails the build if a section stops arriving. Edit this
file — never `public/data/progress.json`.

**Format is load-bearing.** `scripts/sync-site-progress.mjs` parses the `##`
headings below by name, the `### ` blocks inside `Pieces` and `Rounds`, and the
`- **Label:** value` fields. Rename a heading and that section silently stops
publishing, so `check-site-sync.mjs` asserts each one arrived with content.

**Round:** 2
**State:** combat repaired · slice 0 awaiting critique · committed locally, unpushed

## What finishing means

`TODO.md` carries 118 open items. A good number of them cannot honestly be
closed by an agent: four are design questions reserved for the designer, several
need a real GitHub permission or a hosting decision, and the performance
reports need actual low-, mid- and high-spec machines to run on. What is left —
the buildable, screen-shaped remainder — is a command interface that keeps the
game's central promise, and the combat proof underneath it. That is what the
StarCraft II bar was chosen for. Everything else is held back below, with the
reason it is held back.

## Pieces

### The interface tells the truth
- **Bar:** StarCraft II's command HUD in a real match, blind A/B, plus the layout budget in our own `UI_BLUEPRINT.md`
- **Status:** Building

The measured baseline is bad in ways that are not matters of taste. The HUD
occupies **49.4%** of the viewport against a blueprint that reserves 85–90% for
the battlefield. Eleven panels produce **five overlapping pairs**. Five distinct
background treatments run across two unrelated visual languages. Three of eleven
panels declare a `z-index`, so paint order is DOM order by accident.

And the research panel — the system the last handoff named as the single biggest
gap — inherits `pointer-events: none` from `.panel` and never overrides it the
way `#card` and `#chain` do. `document.elementFromPoint` at its centre returns
the canvas. Every research click passes through to the battlefield. The tech
system is not occluded; it is unreachable.

### Missions drive squad behaviour
- **Bar:** watch a replay and name what each squad was trying to do, without being told
- **Status:** Queued

`sim/missions.ts` is honest in its own header comment: a mission records
objective, priority, fallback and assigned squads, and does not reach into squad
behaviour. There is no mission interface at all. Until a squad under a mission
visibly behaves differently from one that is not, this is an RTS with a chain
editor attached, which is the one outcome the design brief rules out.

### Tactical proof
- **Bar:** `GAME_DESIGN.md` §2's own claims, as deterministic scenarios that must pass
- **Status:** Building

Two of §2's claims are now testable for the first time, because until round 2 a
mirrored fight was decided by array order and units could not advance to
contact. Symmetry and advance-to-contact are covered.
`tests/combatSymmetry.test.ts` and `tests/pursuit.test.ts` are the first two
entries in the suite this piece needs.

Still asserted only in prose: that flanking decides fights, that high ground
does, that ambush and setup beat modest numerical superiority, and that a 30–40
unit army only barely beats a 20–25 unit one. B-007 blocks the high-ground half
— terrain is not rotationally symmetric, so a mirrored engagement is not yet a
mirror in elevation.

§2 asserts that flanking, high ground, ambush and terrain decide fights, and
that a 30–40 unit army should only barely beat a 20–25 unit one. Exactly one of
those is currently tested. The rest are asserted in prose. A scenario suite
turns each claim into something that can fail, and a failure means the mechanic
is wrong rather than the numbers.

### Fog and the war table read as authored
- **Bar:** our own first-party concept art in `docs/assets/concept-art/`, blind A/B
- **Status:** Queued

At overview distance the board is dominated by hard-edged violet-blue
checkerboard tiles with stippled edges. `BUGS.md` logs this as B-004, "colour
fixed, still hard-tiled", which undersells it: at the distance the game is
actually played from, the fog is the loudest thing on screen and it overwrites
the painterly direction entirely.

## Every round

- `npm run verify` green — typecheck, lint, the full suite, production build
- a recorded benchmark at 100+ units against the D-006 target
- open the browser and play it; a green suite says nothing about feel

## Never

- relitigate a decision already logged in `DECISIONS.md`
- put sim state anywhere `structuredClone` cannot reach it (D-010)
- publish concept art as gameplay
- answer a `GAME_DESIGN.md` §11.1 question on the designer's behalf

## Held back

Not skipped. These are the items no agent can honestly close.

- **stealth-detection** — The last open item from §11.1. Two designed units already assume it; the Chronicler is blocked, and with it D-020's Command Overload mitigation. The designer believes this was settled in conversation, but a full search of `docs/` on 2026-08-06 found only restatements of the question. It needs one written answer.
- **race-redesign** — The rosters are being reapproached. Conclave and Titanfolk naming waits on that; Adept, Channeler, Phantom and Archivist all pull back toward the humanoid reading D-031 rules out, but renaming ahead of the redesign would be wasted work.
- **repo-rename** — A manual GitHub step. `START_HERE.md` warns an agent must not "correct" the remote to match the codename.
- **machine-benchmarks** — Real low-, mid- and high-spec hardware is a long way off. Performance therefore has to be gated on machine-independent counters — draw calls, per-unit scans, triangle counts — with wall-clock recorded but never asserted, plus CPU throttling in the capture harness as a proxy. `BENCHMARKS.md` §5 already specifies it that way.
- **hosting, newsletter, analytics** — All gated behind decisions he has not made.

### Answered 2026-08-06, and now written down

Seven items left this list in one sitting. Four were §11.1 questions the
designer had already answered in conversation; they had never reached a file,
and a fresh session cannot tell an unrecorded answer from an unmade decision.
`DECISIONS.md` now opens with a note about that, because §11.1 has been lost
once before and restored.

- **resource-schema** → **D-033.** Material and Legacy are gathered; Dominion is derived from territory held; Relics are won from contested encounters. **D-033a** makes Material deliberately loose — trees, rocks, a mountainside — which is an engine requirement, not flavour: `sim/economy.ts` must read declared harvestable sources and never name one.
- **map-geometry** → **D-034.** Terrain is terrain. Passes, cliffs and routes come out of map generation, not a second system.
- **air-vs-supply** → **D-035.** One pool, shared with ground.
- **world-turtle** → **D-036.** Confirmed. Build the art.
- **night-affects-play** → **D-037.** Night, biome and weather all affect play, balanced both ways. The rule: variation is legitimate when both sides face the same conditions; what is forbidden is an unearned private advantage. This makes symmetry a testable property — and B-007 is already a violation of it.
- **scope** → Cohort and Mycora working at a basic level is the target. Conclave and Titanfolk wait.

## Rounds

Newest first. Each entry is what was actually established, not what was claimed.

### round 2

Combat now works. Both blocking defects are fixed, each with a test that fails
against the old code.

**B-005, decided by array order.** `stepCombat` walked `world.units` applying
`target.hp -= damage` in place, and skipped units already at zero — so a unit
earlier in the array struck, killed, and its victim never swung back. Now two
phases: every attacker reads its intent against the state at tick start, then
all damage applies. A unit that dies this tick still lands the blow it had
already thrown, which is what makes mutual destruction reachable and the mirror
hold. The test asserts identical health on both sides at *every* tick, not
merely at the end, because a bias that opens mid-fight and closes by the end
would pass an endpoint check.

**B-006, no advance to contact.** `stepPursuit` closes the ten-to-one gap
between acquire range and weapon reach, leashed to where the pursuit began.
The leash is the whole design question: unleashed, every skirmish becomes a
map-wide rout and the win goes to whoever baits best, which is exactly the
execution skill §2 rules out as the deciding factor. One tuning constant, one
place. Re-running the original measurement — two ten-unit lines thirty apart —
now goes 2400 HP to 254 where it previously dealt no damage at all in two
simulated minutes.

**Then it broke eleven tests, which was the most valuable thing that happened
all round.** Construction, squad and supply suites had been passing *because*
combat was broken: a lone worker could walk to a build site at mid-map because
the enemy army, though well inside acquire range, could never reach it. With
pursuit working the worker is hunted down and killed, and the site never
completes. The instinct is to soften the mechanic; the correct read is that the
fixture was wrong. Those suites now use `peacefulMap()`, which says plainly that
their subject is not combat. A fixture that depends on a broken mechanic will
defend that bug.

Also corrected: `npm run verify` ran `check:site` *before* the tests, so it
reported the previous run's result and printed "RED" on a green build. The
publication step now runs after the tests it publishes.

### round 1

Three defects the designer reported by watching the build, all confirmed in
source and fixed with tests. **The ground pulsed continuously** because
`main.ts` handed `updatePainterlyGlobals` the raw rAF timestamp — milliseconds —
while the cloud-drift constants are per-second. The offset grew a thousand times
too fast, and `hash21`'s opening `fract(p * vec2(123.34, 456.21))` reached ~1.8e6
about ten minutes in. A float32 carries roughly seven significant digits, so
`fract()` had no fractional bits left and returned quantised noise that
reshuffled every frame across the whole ground.

**The minimap heading arrow pointed the wrong way**, and was wrong in a way that
survives review: it rotated an up-pointing marker by `-yaw`, which agrees with
the truth whenever `cos yaw` is zero. Facing east or west it looked right;
facing north or south it pointed exactly backwards. The correct rotation is
`yaw + π`, because `cameraOffset` puts the eye at `focus + (sin yaw, cos yaw)·h`
and the minimap maps `+z` to *negative* canvas Y. The test derives the expected
direction end-to-end from `cameraOffset` through the same transform the canvas
uses, rather than asserting a constant that would only re-encode the author's
sign convention.

**The minimap showed position but not coverage.** Replaced the arrow with the
camera's actual ground footprint — the four view corners projected onto the
ground plane — which is what StarCraft II draws and what D-014's free-orbit
camera makes necessary: one arrow means a courtyard at miniature zoom and the
whole board at war-table zoom. Rays that never meet the ground at shallow pitch
are clamped rather than dropped, so the quadrilateral stays closed instead of
inverting. The heading tick is kept, small, only to disambiguate near edge from
far when a steep camera makes the trapezoid nearly symmetric.

**The camera bobbed like a walk cycle**, reported by the designer while playing.
Two coupled defects in `camera.ts`. The look-at point was anchored to the raw
ground height under the focus, and `terrainHeightAt` carries a ripple roughly
one bump every 18 world units on top of its broad swell — so panning dragged the
target up and down continuously. Worse, `camera.position` used `offset.y` as an
*absolute* world height while x and z were relative to the target, so a change
in target height re-aimed the camera rather than moving it: the horizon rocked
instead of rising. Both fixed; all three axes are now relative.

The first fix attempt was wrong in an instructive way. A smoothing radius that
grew with camera distance aliased once it passed a ripple wavelength — eight
ring samples cannot represent a signal that repeats seven times around the ring
— so distance 150 measured *rougher* than distance 42. Replaced with a small
well-sampled local average that fades to the table plane as the camera pulls
back, which is what a war table should do anyway: past tactical range the board
is an object being examined, not a landscape being flown over. The test asserts
monotonic non-increasing roughness across six distances rather than asserting
the shape of the filter, so it would have caught the aliasing version.

**Built a screenshot harness, because none of the above could be seen.** The
embedded browser surface reported `document.hidden` and fired zero
`requestAnimationFrame` callbacks — so the render loop never ran, every capture
came back black, and that is indistinguishable from a genuinely broken game. A
verification channel that cannot tell "broken" from "not looking" is not a
verification channel. `npm run capture` now drives a real headless Chromium at
fixed camera states and exact ticks, writing PNGs a critic can open. Its own
first run was wrong in the most dangerous way available: the war-table shot
asked for distance 430 and silently stopped at 104, because `zoom()` feeds a
damped velocity clamped to ±18 per frame and one large nudge under-travels. It
produced an entirely plausible screenshot of the wrong thing. Replaced with a
converging control loop that reports where the camera actually ended up.

With that working, the flicker fix and both minimap changes were confirmed
visually, and the screenshots immediately raised the stakes on slice 0. At
war-table zoom the board is a dark disc holding roughly a tenth of the screen
while the keybinding block is physically larger than the battlefield. At tactical
zoom the fog is not merely "hard-tiled" as `BUGS.md` B-004 records — it renders
as stair-stepped terraces with terrain slivers punching through, and it is the
loudest thing in the frame. B-004 understates its own defect.

The benchmark run that was to produce `docs/BENCHMARKS.md` **partly failed**: six
research agents completed, but five of six adversarial reviewers and the
synthesis step hit a session limit. Only the performance dimension survived
review, and it was sharp — it caught that the sandbox's "200-unit" preset
actually spawns 216, that the two armies are seeded 48 units apart against a
9-unit acquire range so they never engage, and that `combat.ts` runs one to three
full `world.units` scans per unit per tick. The run has been resumed from cache
rather than restarted.

Two defects found on the progress page itself while building it, both the kind
that fail quietly. The log entries published with **zero bullets**: the parser
used `/^### (.+)$\n([\s\S]*?)(?=\n### |\n## |$)/gm`, and under the `m` flag the
`$` in that lookahead matches the end of the *first line* rather than the end of
the string, so the lazy body matched empty every time. It rendered as a titled
empty card — visibly wrong, not wrong enough to notice while skimming.
`check-site-sync.mjs` now fails the build when an entry publishes without a body.

Deep links landed on a blank screen. `/development.html#worklog` left the reader
at scroll 3601 with the section at 5393, in a gap between sections where every
`.reveal` element was still at `opacity: 0`. The cause was not images — the CSS
already reserves their space with `aspect-ratio` — it was the progress panel
*above* the work log growing when its fetch resolved. Re-anchoring after that
render fixed it; reduced-motion readers now skip the animation entirely rather
than being animated at anyway.

### round 0

Triage against the running build rather than the documents.

The verification gate did not execute at all on Windows: `check-docs.mjs`
resolved its root through `new URL('..', import.meta.url).pathname`, which
yields `/O:/…` and joins into `O:\O:\…`. With it repaired, the gate immediately
caught real drift — `src/ui/researchPanel.ts`, added in the most recent commit,
was missing from `ARCHITECTURE.md`. The previous session pushed without a green
gate.

Baseline recorded at 340 tests across 31 files, 69 modules documented, typecheck
/ lint / site-sync / production build clean. Then the build was opened and
played, which produced the three findings that outrank everything currently in
`TODO.md`: research is unreachable rather than merely hidden, a debug readout
ships unconditionally outside `?dev=`, and the public page advertised a
hardcoded 269-test count on a section that claims it "cannot flatter the build"
while the suite stood at 340.
