# RTS Design Document (Working Draft)

*Untitled toybox-epic RTS. This document is updated live as design decisions are made.*

---

## 1. Core Identity

**Theme:** Not literal toys, and not fantasy/sci-fi in the generic sense — a real war between real civilizations in a world that is clearly not ours. The "kid's imagination" reference point is about *tone*, not literal content: Melee's lore reason is "toy soldiers play-fighting," but the game presents Mario, Link, and Hyrule Temple as completely real and weighty — never winking at being a toy. This game should hit the same tone: vivid and larger-than-life enough that a kid could get swept up in it, played completely straight enough that an adult takes it seriously. Grounded, epic, never toy-like, never grimdark.

**Design North Star:** Skill expression should live in *planning, scouting, positioning, and setup* — not in physical execution speed or mid-fight micro. "Easy to put the strategy in your brain onto the battlefield." Multitasking (maintaining multiple automated squads/economies at once) is the primary high-skill expression, not APM or click precision.

**Governing rule for all systems:** Every race answers the same strategic questions (build, expand, defend, scout, reshape terrain, fight, recover, finish games) *differently*, based on a core value it holds. Nothing should be "just reskinned" — mechanics should visibly follow from identity.

**Elemental framing (locked):** All four races are forces of nature at war, not civilizations or armies in the conventional sense. Each race's core value (Section 8) maps onto a classical element, and that mapping is a visual/thematic layer over the existing mechanical identity — it doesn't change any system, only what everything is visibly *made of*:

| Race | Value | Element |
|---|---|---|
| Cohort | Order | **Death** — a permanent scar the war left on the world; fixed, unchanging, inevitable |
| Mycora | Presence | **Life** — spreading, growing, unpredictable |
| Conclave | Knowledge | **Water** — flow, current, network |
| Titanfolk | Control | **Earth** — fixed, immovable, terrain itself |

Death and Life sit opposite each other by design, and the mechanics already express that opposition without needing to change: Cohort is the most linear, most predictable race in the game (Section 8.5), while Mycora is the most organic and reactive. This table only makes that contrast visible.

**Art direction (locked):** Ghibli-influenced low-poly — not generic Breath-of-the-Wild-low-poly. Specifically: warm painterly lighting, natural asymmetry over geometric precision, and weathering/overgrowth as a first-class visual language across *all four* races, not just Cohort. See Section 8.8 and Section 10.1.

---

## 2. Combat Philosophy

- Battles are **quick and decisive** — initial positioning determines the outcome more than mid-fight adjustments.
- **Diminishing returns above ~20 units** in one place. Multiple smaller, spread-out squads should be strategically favored over one large deathball. A 30–40 unit army should only barely beat a 20–25 unit army.
- Mid-battle micro should **not** be a major skill factor — the game should feel closer to Sun Tzu than to a mechanical execution test.
- **Flanking, high ground, ambush, and terrain** are extremely important to fight outcomes.
- Maps are **symmetric from spawns** — no spawn point has an inherent advantage.
- Win condition: **pure base destruction** (StarCraft-style), not objective-based.

---

## 3. Pacing

- Average match length target: **10–15 minutes**, but matches can run shorter (rushes) or longer (until map resources are exhausted) depending on how players choose to play.
- Rushing should feel just as viable and "tight" as slow play.
- Full scouting should always be possible for a player willing to invest in it.
- The game is **generally unforgiving** — a big enough mistake at any point can let the opponent end the game immediately.

---

## 4. Automation & Command System

- The game favors **as much automation as possible**, but nothing runs automatically until the player manually sets it up.
- Players should be able to chain complex behavior lists ("walk here → mine this → run here → patrol → attack") through simple, straightforward tooling.
- Once set, a squad continues its programmed behavior until redirected.
- Explicit behaviors (guard, patrol, kite, hold, auto-retreat, etc.) can be strung together like building blocks, tailored to the specific situation.
- Armies still require **ongoing babysitting** — automation reduces physical/mechanical burden, not strategic attention. **Multitasking is a deliberately emphasized core skill.**
- **Supply is tied directly into the automation system** (see Section 6) — each race's supply resource gates automation differently, giving each race a distinct "skill ceiling shape" rather than a shared numeric cap.

---

## 5. Heroes

- Each race offers a small set of hero options; the player picks **one** to match playstyle or to counter a scouted opponent.
- Only one hero available early game; a second unlocks late game.
- Heroes are **reusable generic archetypes**, not unique named characters.
- No hero is intrinsically stronger than another — choice is about playstyle fit and counterplay, not power level.

---

## 6. Late-Game / Side Resource: PvE Boss Events

- Inspired by League's Dragon / Dota's Roshan.
- Several neutral bosses spawn periodically (one every few minutes).
- To secure the kill, a player must **control the area and land the kill** — contested, third-party-able.
- Each kill grants a **permanent buff**.
- Buffs are **asymmetric per race** — may unlock endless sustained production, better tech options, scaling unit upgrades, etc., depending on the race. Exact buffs TBD per race.

---

## 7. Air Units

- **Design pillar: air should enhance the battlefield, not escape it.** Air must respect terrain nearly as much as ground units.
- Map has real **airspace**: mountains cast air shadows, tall forests reduce visibility, wind channels affect movement, high plateaus become natural anti-air positions.
- **Three classes of air units** (kept minimal, not dozens of unit types):
  1. **Recon Air** — weak in combat, reveals terrain/movement, assists scouting.
  2. **Utility Air** — transport, medical support, temporary observation, supply — enables planning rather than replacing it.
  3. **Heavy Air** — rare, expensive, powerful "flying siege," vulnerable if unsupported. Never mass-produced.
- Air units require **staging areas, travel paths, and landing zones** — no instant-appear-anywhere air.
- **Air superiority = information superiority**, not automatic damage superiority.
- Anti-air is **positional** (high ground, watchtowers, prepared emplacements, heroes, terrain) rather than purely a unit-vs-unit stat matchup.
- Air interacts with weather (rain lowers flight ceiling/vision, wind affects travel, fog conceals, snow makes ground easier to track than air) — fully deterministic and symmetrical, no randomness.
- Air leaves physical evidence on the battlefield (disturbed trees, flattened grass, landing marks) — reinforces the "read the battlefield" philosophy.
- **No deathball air**: discouraged via large turning radii, friendly collision, formation inefficiency, limited landing space, area-denial vulnerability, and command-bandwidth limits — never arbitrary stat penalties.
- Air is almost never the primary damage source in the game; its role is to reveal, transport, support, isolate, reinforce, reshape, and enable.

---

## 8. Races

Four races, designed **simultaneously** (Blizzard Terran/Protoss/Zerg method) so every mechanic exists in reaction to the others. Each race is built around one core **value**, and every system — economy, construction, worker behavior, supply, automation limits — should visibly express that value.

| Race | Value | Identity |
|---|---|---|
| **Cohort** | Order | Disciplined, modular, methodical. The accessible "default" race — forgiving of mistakes, rewards mastery less dramatically than others. |
| **Mycora** *(formerly "Throng")* | Presence | Fungal/mold/moss network — aggressive, spreading, organic. Cheap and disposable, wins through map presence rather than raw power. |
| **Conclave** | Knowledge | Technical, indirect, network-based. High skill ceiling, high fragility — a well-placed raid on infrastructure is devastating. |
| **Titanfolk** | Control | Heavy, permanent, terrain-altering. Brutal early game, unstoppable late game — buildings function as geography and fortification. |

### 8.1 Economic DNA

| System | Cohort | Mycora | Conclave | Titanfolk |
|---|---|---|---|---|
| Worker identity | Single competent generalist; good at everything, excels at nothing | Cheap, fast, expendable "spore" | Few, precious workers; each becomes more valuable the longer it stays put | One heavy worker that doubles as mobile fortification |
| Gather rate curve | Flat and reliable throughout the game | High early, degrades with overcrowding | Starts weak, scales sharply with network bonuses | Starts very weak, becomes extreme once infrastructure matures |
| Construction method | **Queue & Walk** — worker walks to site, builds, can be reassigned mid-build (pauses, doesn't cancel) | **Grow** — structure erupts/fruits from the ground over a few seconds once resources are spent; worker is freed immediately; can be denied by enemies standing on the grow-site ("needs quiet ground to root") | **Project from Network** — can only be placed within range of an existing linked node; resolves instantly but starts at reduced efficiency, ramping to full output as it syncs | **Merge** — worker physically becomes part of the structure (consumed into it); slow and deliberate; scouting reveals exactly how much economy was sacrificed for board presence |
| Supply resource | **Command** — built from Standards/Outposts; extends control range and pop cap together | **Population** — grows automatically from thriving colonies, no dedicated building | **Coordination** — a function of how many structures are linked into the network, not a flat number | **Territory** — claimed via monuments/hearths that double as strongpoints |
| Expansion philosophy | Methodical — road, then outpost, then permanently held | Opportunistic — drop a colony fast; just as easy for the enemy to erase | Networked — a new base is worthless until linked back to the main relay chain | Rare and heavy — each expansion is a fortress-seed, slow to pay off but nearly unkillable once mature |
| Resource flow | Centralized, efficient, predictable | Decentralized, redundant — losing one node barely hurts | Centralized but fragile — cut the link, everything downstream starves | Localized, self-sufficient — doesn't amplify other bases |
| Terrain relationship | Builds roads/bridges to *neutralize* terrain | Uses terrain to *hide and multiply* (thickets, ravines, spread routes) | Uses terrain to *extend reach* (network follows favorable ground) | *Becomes* terrain — buildings reshape what's defensible |

### 8.2 Worker Behavior (moment-to-moment)

- **Cohort — Set-and-forget generalist:** one command sets a full gather-return loop indefinitely, no drop-off babysitting. The "tutorial-level" expression of the automation pillar.
- **Mycora — Swarm-tap:** spores gather in loose clusters rather than one-per-node; output splits among however many are present. Encourages continuously dropping new cheap spores into hot spots rather than micromanaging individuals.
- **Conclave — Assign once, then it compounds:** a worker left on the same node accumulates value over time (refines the resource, doesn't just collect it). Raiding a Conclave economy is about resetting accumulated value, not just killing worker count.
- **Titanfolk — Dual-mode:** each worker can toggle gather/garrison; in garrison mode it stops gathering and becomes a stationary point-defense unit. A legible, low-skill defensive tool at a direct economic cost.

### 8.3 Supply & Automation Limits (per race)

| Race | What Supply gates | Flavor |
|---|---|---|
| Cohort | Number of squads that can run an automated command chain simultaneously | Disciplined chain-of-command — automation relay capacity |
| Mycora | Not squad count, but chain *complexity* — each colony allows one more step per behavior chain per squad | Loose and organic — any squad can automate, but sophistication needs population behind it |
| Conclave | Number of active network abilities (vision sharing, illusions, teleport support) running at once | Bandwidth — automation and spellcraft compete for the same pool |
| Titanfolk | Not automation count — instead, Territory gates *distance from a hearth* a squad can hold an automated order before reverting to a simple fallback behavior | Spatial, not numeric — automation is a leash-length problem |

This gives each race a genuinely different flavor of the "multitasking" skill: Cohort (bandwidth of standing orders), Mycora (constant re-queuing across many cheap squads, closer to APM-lite), Conclave (automation vs. spellcasting tradeoff), Titanfolk (managing distance from home rather than a counter).

### 8.4 Air Identity (preliminary, from Section 7)

| Race | Air Philosophy |
|---|---|
| Cohort | Command and reconnaissance |
| Mycora | Map presence and harassment |
| Conclave | Information manipulation and support |
| Titanfolk | Strategic shock units |

*(Air rosters not yet designed in detail — placeholder from early discussion, to be revisited after full ground unit rosters are complete.)*

---

## 8.5 Tech Progression

Each race's tech system matches the *shape* of its value axis — linear vs. branching, gradual vs. spiky, reversible vs. committed — not just its flavor text.

- **Cohort — Linear & Reliable:** Mostly-linear track with occasional "doctrine" choices (pick one of two upgrades first, but nothing is permanently locked out). Upgrades apply broadly to a category of unit/behavior, not a single unit. Forgiving — researching everything in order still works fine. Mastery comes from *timing* upgrades against scouted info, not from choosing correctly.
- **Mycora — Unlocked by Growth, Not Research:** No traditional research queue. New tech tiers unlock automatically once the network crosses spread thresholds (colony count / territory covered). Tech pacing is a direct function of how aggressively the player expands — turtling stunts the tech tree, not just the economy.
- **Conclave — Branching & Committing:** Real branching tree with mutually exclusive paths at key nodes; picking one forecloses another for that game. Highest skill ceiling in the tech layer — scouting an opponent's branch reveals what they can no longer do. Research draws from the same Coordination pool that gates automation, so teching hard and running many automated squads compete directly.
- **Titanfolk — Rare, Monumental, Territorial:** Very few unlocks, each a large visible transformation tied to territory rather than a lab (e.g. a hearth can be "consecrated"/"fortified" once enough Territory is banked). No small increments — tech reads as the base itself evolving. Reinforces early-slow/late-unstoppable: a contained Titanfolk player is literally locked out of their power spikes.

**Cross-race design rule (locked in):** each race's economy, automation limit, and tech system are all gated by the *same* single resource (Command / Population / Coordination / Territory respectively). One stat per race governs army size, automation bandwidth, and tech power simultaneously. No race should be given a second, unrelated resource without a very strong reason — this is what keeps the four systems feeling unified rather than bolted together.

---

## 8.6 Squad Cohesion (Universal Diminishing-Returns Mechanic)

Operationalizes the Section 2 pillar ("20+ units in one place has dramatically diminishing returns") as a real, legible system rather than a hidden penalty. Same outcome across all races (spread out, don't deathball) — different in-fiction reason per race, always readable on the battlefield:

| Race | Why big squads underperform |
|---|---|
| Cohort | **Command Overload** — beyond the cap, a squad needs a second officer-type unit to keep full accuracy; without one, effectiveness drops |
| Mycora | **Bloom Dilution** — dense clusters starve the local biomass and weaken themselves |
| Conclave | **Resonance Interference** — too many linked units in one place create feedback noise, degrading ability accuracy |
| Titanfolk | **Physical Crowding** — units are large enough to physically collide; excess units in an overpacked group can't reach the front line |

## 8.7 Full Unit Rosters

### Cohort
| Unit | Role | Notes |
|---|---|---|
| Legionnaire | Core melee | Shield-wall; defense bonus per adjacent Legionnaire up to cohesion cap |
| Marksman | Ranged | Accuracy bonus stationary, penalty moving — rewards setup over kiting |
| Outrider | Flanker/scout | Exploits flank bonuses; weak head-on |
| Sentinel | Anti-air | Doubles as fixed emplacement or slower mobile unit |
| Ballista | Siege | Strong vs. buildings, needs escort |
| Chronicler | Support/detector | Extends Command range, reveals stealth |
| Warbringer | Heavy/late-game | Formation anchor; unlocked via doctrine tech branch |
| Falcon | Air — Recon | — |
| Skiff | Air — Utility | Transport |
| Dreadnought | Air — Heavy | — |

### Mycora
| Unit | Role | Notes |
|---|---|---|
| Thornling | Core melee | Regenerates faster near friendly colony ground |
| Spitter | Ranged | Weak alone, scales with numbers |
| Strider | Flanker/scout | Moves through thickets/rough terrain other races can't |
| Bloomcap | Anti-air | Lingering damage-over-time spore cloud |
| Rotmaw | Siege | Corrodes buildings gradually — area denial, not burst |
| Weaver | Support | Links colonies for passive buffs/heals via spore network |
| The Overgrowth | Heavy/late-game | Grows larger over time alive on the field; consumes terrain |
| Driftspore | Air — Recon | — |
| Windcarrier | Air — Utility | Transport |
| Sporelord | Air — Heavy | — |

### Conclave
| Unit | Role | Notes |
|---|---|---|
| Adept | Core melee/utility hybrid | Low HP, high utility |
| Channeler | Ranged | Indirect damage, requires line back to network |
| Phantom | Flanker/scout | Illusions/stealth |
| Aegis Construct | Anti-air | Shared shield for nearby units |
| Fulcrum | Siege | Long-range, must stay stationary and networked |
| Archivist | Support/detector | Vision manipulation; draws from Coordination pool |
| Ascendant | Heavy/late-game | Extremely powerful; upkeep taxes Coordination hard (competes with automation/tech) |
| Wisp | Air — Recon | — |
| Conduit | Air — Utility | Teleport support |
| Sovereign | Air — Heavy | Vision manipulation |

### Titanfolk
| Unit | Role | Notes |
|---|---|---|
| Bulwark | Core melee | Enormous HP tank |
| Slinger | Ranged | Slow, heavy hit, no kiting fantasy |
| Trailblazer | Flanker (unconventional) | Breaks terrain to create shortcuts/chokepoints instead of moving fast |
| Skywatcher | Anti-air | Built directly into hearths |
| Breaker | Siege | Destroys terrain/walls outright, slow and telegraphed |
| Warden | Support | Formalized garrison-mode defender for undermanned bases |
| Mountain-kin | Heavy/late-game | Colossal, terrain-altering by existing; unlocked only via territory-gated "consecration" tech |
| Roc | Air — Recon | — |
| Skybarge | Air — Utility | Transport |
| Behemoth | Air — Heavy | — |

---

## 8.8 Visual Identity

*(Lore dropped per design direction — mechanical/visual identity only, prioritizing reaching a playable state. Explicitly designed to avoid reading as reskinned Terran/Protoss/Zerg. See Section 1 for the elemental framing all four rows now express.)*

**Overall art pillar:** Ghibli-influenced low-poly across all four races — warm painterly light, natural asymmetry, visible weathering/overgrowth as a real material, not an occasional decal.

| Race | Value | Element | Identity | Visual Language | Explicitly NOT |
|---|---|---|---|---|---|
| Cohort | Order | Death | The war-machine of a long-dead civilization — not a relic that stopped, but a permanent scar torn into the natural order of the planet, as inherent to the world now as any mountain or river. It doesn't remember it's a machine; it just keeps happening, the way weather keeps happening. | Fossil-proportioned, not mechanical-proportioned — bone-white and weathered stone, no visible joints or gears, closer to a skeleton than a robot. Soft internal glow at "vital" points (eyes, chest, weapon housings) in warm gold or pale green, never hard-edged or red — the visible tell that it's still, faintly, alive. Weapon effects read as light escaping through cracks in fossil bone rather than a fired projectile. Moss, lichen, and small flowering vines collect in the same seams real fossils collect sediment — denser on units that see less action, worn closer to bare bone on ones that fight constantly. *(Reference: the Laputa guardian robots in* Castle in the Sky *— ancient, armed, and gently overgrown at once.)* | NOT disciplined space-marine military (Terran), NOT steampunk/clockwork, NOT cold geometric dormant-machine horror (Necron) — warmth and overgrowth are the load-bearing details that keep this distinct |
| Mycora | Presence | Life | Hostile terrain given life | Walking wood, spreading blight, animate moss/roots overtaking ground. The race Cohort is visibly losing ground to — and vice versa — wherever their territories touch. | NOT a swarm/horde of small creatures (Zerg) |
| Conclave | Knowledge | Water | Waterway civilization ("The Current") — coordination flows through canals, locks, and reflecting pools | Flowing water channels visibly connecting structures/units, aqueducts, cisterns, locks; navigator-scholar units; network literally follows rivers/waterways across the map | NOT psionic/energy-shield mystics (Protoss), NOT steampunk cables |
| Titanfolk | Control | Earth | Land-given-form colossi | Geological, massive, moves slow because it's genuinely that size | (No direct SC parallel — kept as designed) |

**Cross-race detail worth reserving for later (not yet scheduled to a phase):** where Cohort and Mycora territory overlap, ground cover could visibly contest — ash-grey barren spreading from Cohort structures, green overgrowth spreading from Mycora ones, fighting over the same tiles the way their armies do. Flagged here so it isn't lost; revisit during Phase 2 (Mycora) or Phase 4.4 (polish).

---

## 10. Production Plan

- **Platform:** Runs entirely in-browser (WebGL) — no downloads, playable directly from the game's website.
- **Art style:** Low-poly, Ghibli-influenced — warm painterly lighting, natural asymmetry over geometric precision, weathering and overgrowth treated as real material across all races (not just Cohort's). Breath-of-the-Wild remains the closest technical reference (clean, stylized, flat/soft-shaded, easy to produce programmatically) — Ghibli is the tonal/lighting target layered on top of that technical approach, not a departure from it.
- **Development approach:** AI-assisted ("vibecoded") — majority of implementation handled by Claude Opus (via Claude Code), designer overseeing with existing coding/web development experience.
- **Build strategy (decided):** Finish the *conceptual* design (visual identity, hero archetypes, map rules) before implementation, but treat exact numbers/balance/full rosters as first-draft — expect revision once the prototype is playable. Do not attempt to fully spec every system in exhaustive detail before writing code; build in phases against a running prototype instead.

### 10.1 Recommended Tech Stack
- **Rendering:** Three.js (or React Three Fiber on top of it) — browser-native WebGL, no install, well-documented, strong fit for AI-assisted development.
- **Language:** TypeScript, for maintainability as the codebase grows.
- **Pathfinding:** Start with grid-based A* — simpler to implement and debug than a full navmesh; upgrade later only if needed.
- **Simulation:** Fixed-tick game loop kept separate from the render loop (important for consistency, replay, and any future multiplayer/lockstep).
- **Multiplayer:** Deferred. Build single-player vs. a simple AI opponent first — RTS netcode (lockstep simulation, desync handling) is a substantial project on its own and shouldn't block validating core game feel.

### 10.2 Phased Build Roadmap

**Phase 0 — Tech Spike**
Prove the stack works: one low-poly unit on a small low-poly terrain, RTS camera (pan/zoom/rotate), unit selection (click + drag box). No combat, no economy, no AI.

**Phase 1 — Single Race Core Loop**
Recommended first race: **Cohort** — its economy and tech shape (linear, forgiving) make it the simplest proving ground for the core systems before layering in asymmetry.
In scope: terrain with elevation, worker gather/return loop, Command supply resource, basic squad automation (a short behavior chain a player sets up and the unit executes), core melee + ranged units, Squad Cohesion penalty active, positioning-driven combat resolution, a simple (not necessarily smart) AI opponent, base-destruction win condition.
Out of scope: heroes, tech tree, PvE bosses, air units, the other three races, multiplayer, audio/polish.

**Phase 2 — Prove Asymmetry**
Add **Mycora** — its economy (Grow construction, swarm-tap gathering, spread-gated tech) is the most different from Cohort's, so it's the best test of whether "same problem, different answer" actually produces different-feeling gameplay rather than just different stats.

**Phase 3 — Remaining Races, Heroes, Tech Trees**
Add Conclave and Titanfolk; layer in hero archetypes and full tech branching now that the core loop is validated.

**Phase 4 — PvE Bosses, Air Units, Multiplayer, Polish**
Add the periodic PvE boss system, air unit classes, networked multiplayer, and audio/visual polish last — these all sit on top of a proven core loop rather than being load-bearing for it.

## 11. Open / Not Yet Designed

**Priority shift: get to a playable prototype ASAP. Lore/story is explicitly out of scope going forward.**

- Hero rosters (specific archetypes per race)
- Relic tech / Dominion usage (concept mentioned early, not yet defined)
- Signature abilities per race
- Late-game identity in concrete terms (beyond the general economic trajectory above)
- Weaknesses / matchup dynamics between races
- Concrete map design (symmetry patterns, PvE boss placement logic)
- Weather system mechanics in full (only air interactions defined so far)
- Mycora naming/lore pass beyond faction name (unit names, visual language). **Tonal references (designer, logged for that pass):** the Sea of Corruption in *Nausicaä of the Valley of the Wind* — fungal spread as a vast natural process indifferent to people — mixed with *The Last of Us*'s treatment of infection as an intimate, proximate threat rather than a distant spectacle. Read: Mycora is the thing creeping at your border that must be burned back now, not a blight on the horizon. Note this already reinforces existing mechanics (deniable Grow construction, cheap-to-plant/cheap-to-erase colonies, decentralized resource flow) rather than requiring changes.
- Cohort/Mycora contested-ground visual effect (ash vs. overgrowth spreading from each race's structures) — concept locked in 8.8, implementation not yet scheduled to a phase
- Whether Conclave and Titanfolk want a naming pass to lean further into their elements (Water/Earth) now that the elemental framing is explicit, or whether "The Current" and "Titanfolk" already read clearly enough — not yet raised with designer

### 11.1 Additional gaps identified in full document audit

These surfaced from a full pass through every source document looking for ideas that were mentioned once and never resolved or re-flagged.

**Three of the four are now resolved (2026-08-06).** They are kept here, marked, rather than deleted — this section was itself lost once and restored, and a reader who arrives via an older document needs to find the answer where the question was.

- ~~**Gatherable resource(s) — the core economic input.**~~ **RESOLVED — see `DECISIONS.md` D-033.** Two gatherables, **Material** and **Legacy**, both harvested from the map. **Dominion** is not gathered at all: it is derived from the territory you control. **Relics** are won from contested encounters. The build still ships a single `essence`, which becomes **Legacy**; Material is new economic work, not a rename.
- ~~**Map geometry — tunnels, ramps, hidden routes.**~~ **RESOLVED — see `DECISIONS.md` D-034.** Terrain is terrain. Mountain passes, cliffs, ramps and alternate routes are produced by map generation as terrain, not as distinct mechanical systems. The procedural generator carries this weight.
- **Stealth / detection.** *Half resolved.* The **terrain** half is settled — see `DECISIONS.md` **D-040**: elevation blocks line of sight outright (dead ground), terrain type reduces the range at which units are spotted (cover), and both must be readable from terrain the player can already see. That unblocks the Chronicler, whose "reveals stealth" becomes "sees further into cover than anything else in the roster" — a number, not a new system — and with it D-020's Command Overload mitigation. **Still open:** unit-level stealth as an ability, which only Conclave's Phantom needs. Deferred to Phase 3 with the roster redesign.
- ~~**Air units' relationship to the supply/automation resource.**~~ **RESOLVED — see `DECISIONS.md` D-035.** Air draws on the **same per-race pool** as ground — Command / Population / Coordination / Territory. No separate air supply. This makes §7's "command bandwidth limits" concrete and makes fielding air a real trade against ground.

---

*Section 11.1 added following a full audit of `01_design_document.md`, `02_development_blueprint.md`, `03_chat_transcript.md`, and `04_original_reference_conversation.md` to identify ideas that were mentioned once and never carried forward or explicitly marked as dropped. Nothing in 11.1 has been decided — these are open questions, not design decisions. Restored 2026-07-27 after being dropped in an intermediate revision.*

---

*Last updated after: elemental framing locked (Cohort=Death, Mycora=Life, Conclave=Water, Titanfolk=Earth); Cohort visual identity revised to "permanent scar / force of nature" with Ghibli/Laputa-influenced fossil-and-overgrowth direction; Ghibli established as the project-wide art pillar. See `CHANGELOG.md` for full version history.*
