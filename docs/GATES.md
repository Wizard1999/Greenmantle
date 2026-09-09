# Gates

Questions only the designer can answer, and what each one blocks.

**How this file works.** Work does not stop at a gate. Everything that does not
depend on the answer gets built; the question is written here with the smallest
decision packet that makes it answerable — the options, what each costs, and a
recommendation. Answer inline, in any form, and the answer is transcribed into
`DECISIONS.md` the same day.

That last part matters: this project has twice lost decisions that were made in
conversation and never written to a file, and a fresh session cannot tell an
unrecorded answer from an unmade one. `GAME_DESIGN.md` §11.1 had to be restored
after being dropped, and four of its questions were asked a second time because
the answers existed only in a chat that had ended.

Closed gates are moved to `DECISIONS.md`, not deleted from history.

---

## Open

### G-01 · What should the tutorial teach?
**Blocks:** any confident first-time-player demo.

All seven steps are select a worker, gather, select the base, train, select the
army, move, frame the camera. Not one covers missions, doctrine, terrain or
fallback — the things the project exists for. A newcomer who finishes it has
been taught only the mode of play `CLAUDE.md` calls *the worse way to play*.

The mechanical bugs are fixed (it no longer rewinds, and it can reach step 7).
This is a content question.

**Round 7 made one of the seven steps unreachable, which narrows the choice.**
`map.ts` MAP_VERSION 7 now deals every side a running economy at tick 0 — the
change that took the player side from banking zero essence in twenty minutes to
banking 665 — and step 2's predicate ("some player worker is gathering") is
therefore true before the player touches anything. The observable result is that
the guide jumps from *Step 1 of 7* straight to *Step 3 of 7* and never shows
"Recover Legacy" at all. No predicate written against world state can fix this:
nothing distinguishes the opening's gather order from the player's. It needs
either the guide to watch the *command stream* (`replay/live.ts` is the one
auditable seam every player command already passes through) or the step to teach
something the game has not already done — retasking a worker, most likely.
`tests/tutorial.test.ts` pins the current behaviour explicitly rather than
hiding it behind a softened step index.

- **A** — Rebuild around one objective, one mission, one piece of ground. Teaches the actual identity; costs a rewrite.
- **B** — Keep the basics and append three steps on missions and terrain. Cheaper; the first two thirds still teach a 1998 RTS.
- **C** — Leave it for now and demo without onboarding.

*Either A or B must also decide what step 2 becomes; C ships a guide that skips
a numbered step in front of the person it is there for.*

*Recommendation: B for the demo, A before anyone outside the room plays it.*

### G-02 · Should a flank launched from a distance be worth anything?
**Blocks:** whether flanking is a plan or a reaction. Nothing is broken either way.

B-011 priced the flank correctly **at the moment of contact** — a 10v10 against
a defender facing away went from mutual annihilation to 10–0. It did nothing for
the approach. Beyond about five units of separation a flank is still worth
exactly zero, because a *walking* defender re-faces at the fast travel rate and
squares up long before contact.

So a flank must be launched from inside acquire range (9.0) — near enough that
the enemy can already see it coming, which is close to the opposite of §2's
"planning, scouting, positioning and setup".

- **A** — Slow the travel-facing rate too. Flanks become launchable from range; costs some of the crispness that makes movement read well.
- **B** — Leave it. Flanking is a close-quarters manoeuvre and hammer-and-anvil is the doctrine that earns it.
- **C** — Make a unit that is *travelling under orders* re-face more slowly than one manoeuvring locally, so distance flanks work without touching short-range feel.

*Recommendation: C. It targets exactly the case that fails.*

### G-03 · Is the 10–0 flank result robust enough, or should Legionnaire stats move?
**Blocks:** confidence in every §2 balance claim measured on Legionnaires.

The headline result is a knife edge and the builder said so rather than selling
it. The head-on control annihilates both sides within one volley of
simultaneity, so a 5% peak lead is enough to flip a draw into a clean sweep
whose survivors finish on 4.9 HP each. The *result* moved, which is what §2
asks, but the margin is thin: a modest change to Legionnaire HP, damage or
defense could put both runs back on the same side of the line and flanking would
read as worthless again.

- **A** — Leave it and accept that Phase 1 balance is provisional anyway.
- **B** — Widen the margin now by separating damage and HP so fights are less knife-edged.

*Recommendation: A. §10 says treat exact numbers as first-draft until there is a playable prototype, and this is one.*

### G-04 · Unit-level stealth
**Blocks:** Conclave's Phantom only. Terrain concealment is settled in D-040 and
the Chronicler is unblocked by it.

Deferred to Phase 3 with the roster redesign. Recorded so it is not rediscovered
as a surprise.

---

## Answered, and where the answer lives

| Gate | Answer |
|---|---|
| Resource schema | D-033, D-033a |
| Map geometry — tunnels and ramps | D-034 |
| Air versus the supply pool | D-035 |
| World Turtle scope | D-036 |
| Night, biome and weather affecting play | D-037 |
| Terrain concealment and ambush | D-040 |
| Turn rate on facing | D-041 and B-011 |
| Which high-ground lever | B-009 — terrain amplitude |
| No race is humanoid | D-031 |
