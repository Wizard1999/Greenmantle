// EVERY balance number lives in data/. All of these are placeholders — the
// blueprint's scope-discipline note is explicit that systems get implemented
// faithfully now and tuned at Phase 4.4.

/**
 * The battlefield's dimensions (D-038).
 *
 * **Nothing outside this block may assume the map's size.** It is content, not
 * an engine constant, and a creator swapping in their own map
 * (`ENGINE_VISION.md`) must not have to hunt through `sim/` and `render/` to do
 * it. An audit on 2026-08-06 found five places that each independently knew how
 * big the board was — a radius in `sim/mapBoundary.ts`, a size in
 * `sim/terrain.ts`, a fallback in `render/camera.ts`, fixed camera limits in
 * `render/cameraMath.ts`, and a fixed fog grid in `ui/fogOfWar.ts`. Each was a
 * place where changing the map silently broke something else.
 *
 * `radius` was 39, which produced a board too small to contain the game:
 * measured on a real match, four resource nodes all sitting inside a starting
 * control radius, a peak of 28 units across both teams against D-006's 100+
 * target, and a two-minute match against §3's 10–15 minute pacing. The designer
 * set the floor at 7× the old area and the target at 15–16×; 156 is 4× the
 * linear scale and therefore 16× the area.
 */
export const BATTLEFIELD = {
  /** Nominal radius of the play area, before per-seed vertex jitter. */
  radius: 156,
  /**
   * World units per fog cell. Fog resolution is derived from this and the
   * boundary, so a larger map gets *more* cells rather than coarser ones — the
   * previous fixed 48×48 grid would have grown from 1.6 to 6.5 units per cell
   * at this scale, coarsening the fog exactly as the map became big enough to
   * need it fine.
   */
  fogCellSize: 2.0,
  /**
   * How far outside the board the camera may travel, as a multiple of the map
   * radius. The war table is an object in a void (D-014) and the player is
   * expected to look at it from outside, so this is deliberately generous.
   */
  cameraReach: 1.35,
} as const;

export const BUILD = {
  // Flat rate whenever at least one assigned worker is present (assumption A8).
  // Deliberately NOT "more workers = faster": stacking workers to rush a
  // building is a different race's fantasy, and Cohort's gather curve is "flat
  // and reliable" (§8.1). The interesting decision is meant to be *whether to
  // leave the worker there*, not how many to pile on.
  progressPerTick: 1,
  buildRange: 2.0,      // how close a builder must be for progress to run
  builderStandoff: 0.9, // parked just outside the site footprint
};

export const SUPPLY_MAX = 200;      // hard ceiling regardless of Command built
export const MAX_QUEUE = 5;         // production queue depth per building
export const PLACE_CLEARANCE = 1.0; // gap required between a new building and anything else

// Automation (§4, §8.3). Command gates how many squads can run a chain at
// once — Cohort's flavour of the multitasking skill is bandwidth of standing
// orders, so the cap is a count, not a distance or a complexity limit.
export const AUTOMATION = {
  commandPerSlot: 8,  // 15 command -> 1 squad; an outpost (+8) buys another
  arriveRadius: 2.2,  // how close counts as "the squad got there"
  stepTimeout: 1350,  // 45s at 30Hz — a step that cannot finish must not deadlock the chain
  maxChainSteps: 6,
  maxSquads: 5,       // squads are bound to number keys 1–5
};

/**
 * Missions (D-041). What a mission does to the squads carrying it out.
 *
 * The withdrawal table is the only balance number the mission system has, and
 * it is indexed by priority deliberately. Priority was previously a label the
 * simulation never read; making it the price the player is willing to pay in
 * casualties turns it into a real decision, expressible with the two commands
 * that already exist — set a priority, place a fallback.
 *
 * Fractions of the force's own high-water strength, so they mean the same thing
 * to a two-unit picket and a twenty-unit push:
 *
 *   low     — break off having lost 30%. A probe, not a commitment.
 *   normal  — break off at half strength, roughly where a fight is already lost.
 *   high    — press until three quarters of the force is gone.
 *
 * A mission with no fallback position never withdraws whatever its priority,
 * because there is nowhere to withdraw *to* and inventing one would be the
 * interface giving advice (`UI_BLUEPRINT.md` § "Information, never advice").
 */
export const MISSION = {
  withdrawBelowStrength: { low: 0.7, normal: 0.5, high: 0.25 },
};

// Combat (§2, §8.6, §8.7). Positioning decides fights, so every number here is
// about *where* units are, not how fast the player clicks.
export const COMBAT = {
  /** Shield wall: how close two Legionnaires must be to count as adjacent. */
  shieldWallRadius: 1.5,
  /** Defense added per adjacent Legionnaire. */
  shieldWallPerNeighbour: 0.07,
  /** Neighbours counted, at most. See assumption A12 — the design doc says
   *  "up to cohesion cap", which is ambiguous between this local adjacency
   *  limit and §8.6's ~20-unit squad cap (which arrives at 1.10). */
  shieldWallMaxNeighbours: 5,
  /** Defense can never exceed this, however tight the formation. */
  maxDefense: 0.75,
  /** Ticks of standing still before a unit is fully "set up". */
  settleTicks: 30,   // 1s

  // --- Positioning (1.10). Where a unit stands decides fights (§2). ---
  /** Damage multiplier for attacking from high ground. */
  highGroundBonus: 1.25,
  /** ...and the penalty for attacking uphill. */
  lowGroundPenalty: 0.85,
  /** Damage multiplier when attacking a defender from behind. Flanking is
   *  meant to be decisive, not a rounding error (§2). */
  flankBonus: 1.35,
  /** Attacking from the side — between flank and frontal. */
  sideBonus: 1.15,
  /** Half-angle (radians) of the defender's frontal arc. Outside this to the
   *  rear is a flank. */
  frontArc: 1.05,      // ~60 deg either side of facing
  rearArc: 1.05,       // ~60 deg either side of directly behind
  /** How far a unit will look for a target of its own accord. */
  acquireRange: 9.0,
  /**
   * How far a unit will chase, measured from where the pursuit began.
   *
   * Must exceed `acquireRange`, or a unit could acquire a target it is then
   * forbidden to walk to — which is precisely the defect this fixes (B-006):
   * acquire range is ten times weapon range, so without pursuit units stood and
   * watched each other indefinitely.
   *
   * Bounded because the alternative is worse. An unleashed chase turns every
   * skirmish into a map-wide rout and hands the win to whoever baits best,
   * which is an execution skill (§2 rules those out as the deciding factor).
   * One number, in one place, so the leash is cheap to retune.
   */
  pursuitLeash: 12.0,
  /**
   * Damage a unit does to a building, as a fraction of its normal damage.
   * Nothing in the Phase 1 roster is a siege unit, so everything chips.
   *
   * Was 0.5, which is not chipping. Measured: twenty Legionnaires took a 2,200
   * HP Standard down in about twenty-six seconds, so losing one field battle
   * ended the match inside a minute and the whole back half of every match was
   * an unopposed demolition. At 0.12 the same twenty units need about a minute
   * and three quarters — long enough that the defender's production, its
   * garrison and its remaining Outposts are all still part of the answer, which
   * is the difference between "quick and decisive battles" (§2) and a quick and
   * decisive *match* (§3 asks for 10–15 minutes).
   *
   * This is the number that says a line unit is not a siege engine. When a real
   * siege unit lands it should carry a per-unit multiplier rather than this
   * being raised back up for everybody.
   */
  buildingDamageScale: 0.12,
};

/**
 * Squad cohesion (§8.6, §2) — the universal diminishing-returns mechanic.
 *
 * §2 asks for "20+ units in one place has dramatically diminishing returns",
 * and that "a 30-40 unit army should only barely beat a 20-25 unit army".
 * These numbers are solved backwards from that requirement:
 *
 *   35 units -> 1 - 15*0.025 = 0.625 effectiveness -> ~21.9 effective units
 *   22 units -> 1 -  2*0.025 = 0.950 effectiveness -> ~20.9 effective units
 *
 * So a 35-stack beats a 22-stack by about 5% — "barely", as specified.
 *
 * Measured by local crowding rather than by squad membership. Basing it on
 * squads would make it trivially dodgeable: an ungrouped deathball would take
 * no penalty at all, which is the exact formation the rule exists to discourage.
 * See docs/OPEN_QUESTIONS.md — the design text is ambiguous between the two.
 */
export const COHESION = {
  /** Friendly combat units within this radius count as "in one place". */
  radius: 8.0,
  /** Up to this many, no penalty. */
  cap: 20,
  /** Effectiveness lost per unit over the cap. */
  penaltyPerUnit: 0.025,
  /** Effectiveness never falls below this, however dense the stack. */
  minEffectiveness: 0.45,
};

/** Win condition (1.12): a team is eliminated when it holds no buildings. */
export const VICTORY = {
  /** Ticks a team must hold zero buildings before the match is called. Stops a
   *  match ending in the instant between a base dying and a site completing. */
  graceTicks: 30,
};

export const ECON = {
  gatherTicks: 45,      // 1.5s to fill up — Cohort is "flat and reliable" (§8.1)
  /**
   * Essence per trip. Was 8.
   *
   * The gather numbers were set when the board was 39 units across and a
   * worker's round trip was a few paces. On the board D-038 built, with the AI
   * now putting Outposts on the patches it works, a worker's cycle is roughly
   * 130 ticks and eleven of them earn about fifteen essence a second — enough
   * to strip all eight patches inside five minutes, which made map exhaustion
   * the *normal* end of a match rather than §3's long case, and produced armies
   * faster than anything on the board could fight them.
   */
  carryAmount: 5,
  depositTicks: 6,      // 0.2s to unload
  gatherRange: 1.4,     // how close a worker must be to a node
  gatherStandoff: 1.05, // where a worker parks — each gets its own slot
  slotEpsilon: 0.12,    // how close to its slot counts as arrived
  dropoffRange: 2.6,    // how close a worker must be to a base
  /**
   * Essence in one patch. Was 1200, giving 9,600 on an eight-patch map.
   *
   * §3 puts exhaustion at the long end of the range — "matches can run longer
   * (until map resources are exhausted)". At 1200 it was the median: two sides
   * working forward Outposts emptied the board in five minutes, well inside the
   * 10–15 minute target, and every match after that point was fought with
   * whatever was already standing. 2400 puts the floor of the economy past the
   * end of a normal match while leaving exhaustion reachable in a long one.
   */
  nodeCapacity: 2400,
};

/**
 * The opening a match is dealt (§8.2, §4).
 *
 * Cohort's worker identity is set-and-forget, so both sides begin with their
 * workers already on the home cluster and the base already rallying new ones
 * into the same loop. `sim/map.ts` owns that setup; this is the only number in
 * it.
 */
export const OPENING = {
  /**
   * Home nodes the starting workers are split across.
   *
   * Two, because the home cluster is a pair (B-008). Opening on one patch would
   * strip it and idle the side that owns it: four workers take about a third of
   * a node's `nodeCapacity` per minute.
   */
  startingNodes: 2,
};

// Day/night cycle (§ designer request 2026-07-27). Ten real minutes per full
// in-game day. Expressed in real seconds here and converted to ticks once, in
// sim/daynight.ts, so changing TICK_HZ cannot silently change day length.
export const DAY = {
  realSecondsPerDay: 600,   // 10 real minutes
  dawnStart: 5,             // hour the sky begins to lift
  dawnEnd: 7,               // ...and is fully daylight
  duskStart: 19,            // hour the light begins to fail
  duskEnd: 21,              // ...and is fully night
};

/**
 * The Phase 1 AI opponent (§10.2 — "a simple (not necessarily smart) AI").
 *
 * Its job is to exist and to exercise the systems, not to be competitive.
 * Numbers here are placeholders like everything else in this file.
 */
export const AI = {
  /** Ticks between decisions. It has no reflexes to exercise, and thinking
   *  every tick would cost real time at 100+ units for no behavioural gain. */
  thinkInterval: 15,      // twice a second at 30Hz
  targetWorkers: 10,
  maxQueueDepth: 2,
  /** Home patches the idle-worker sweep spreads across. Two: the home cluster
   *  is a pair (B-008), and a crew that shares one patch walks to the
   *  replacement all at once when it runs dry. */
  gatherNodes: 2,
  /**
   * Fighters before it commits to attacking. Was 8.
   *
   * Eight was a wave that could not do anything on arrival once buildings
   * stopped falling over, so the AI spent the match trickling small pushes into
   * a defended base. Ten is the smallest wave that still forces the defender to
   * answer with its whole army rather than its garrison.
   */
  attackAtArmySize: 10,
  /**
   * Fighters left before the wave is called spent and the survivors go home.
   *
   * The old rule was "attack until the last one is dead", which meant every
   * unit trained during a push walked across the map alone into an intact
   * army. Breaking off at a third of the commitment threshold is what turns a
   * single terminal engagement into a rhythm of waves — measured, it is most of
   * the difference between a match that resolves in three and a half minutes
   * and one that runs the length §3 asks for.
   */
  regroupAtArmySize: 6,
  /**
   * How far ahead of the enemy's fighting strength the AI attacks without
   * waiting for a full wave.
   *
   * `attackAtArmySize` alone answers only "am I ready", never "is he". Against
   * an opponent who has stopped building — someone still learning the camera,
   * or someone who has just lost an army — a fixed threshold leaves the AI at
   * home massing against nothing, which reads as an opponent that is ignoring
   * you. Between two equal sides this rule almost never fires, so a full wave
   * stays the normal case and the pacing above is what governs a real match.
   */
  attackAdvantage: 4,
  /** ...and the floor under it. Three units against nothing is not a reason to
   *  walk an army across the board. */
  attackMinArmySize: 8,
  /**
   * Fighters that never leave home, however good the attack looks.
   *
   * Must stay below `regroupAtArmySize`, or a wave that dies leaves the guard
   * counted as a live army and the AI never rebuilds. Three is enough to make
   * a broken-through attacker fight for the economy rather than walk into it,
   * which is where the whole 2-minute razing tail at the end of a mirror match
   * came from.
   */
  garrisonSize: 4,
  /** How far in front of the base the army masses, along the line toward the
   *  enemy. Far enough to be out of the mining lines, near enough that the
   *  wave is still home defence until it is ordered off. */
  stagingDistance: 14.0,
  /**
   * An enemy this close to anything the AI owns takes priority over whatever
   * the army was doing.
   *
   * Slightly wider than a Standard's control radius, so the trigger is "inside
   * my territory" rather than "already hitting my base" — an attacker that has
   * reached weapon range of the Standard has already been allowed to pick the
   * ground, which §2 says decides the fight.
   */
  defendRadius: 22.0,
  /** How far from its rally point an idle fighter may drift before being
   *  re-ordered. Slack, so it is not reissuing move orders every think. */
  rallySlack: 6.0,
  /** Build an Outpost once free supply drops to this. Command gates army size,
   *  so without expansion the AI stalls permanently with a full supply bar. */
  expandAtSupplyFree: 4,
  expandMinRadius: 9.0,
  expandRingStep: 3.5,
  expandRings: 5,
  expandAngles: 12,
  /** A patch this far from a friendly drop-off counts as already served, so
   *  the AI does not build a second Outpost onto a node it already works. Wider
   *  than a worker's `dropoffRange` by a lot: the question is whether the patch
   *  has somewhere to unload at all, not whether the walk is short. */
  expandNodeRange: 26.0,
  /** How far out the AI will claim a patch. Beyond this an expansion is closer
   *  to the enemy's half than its own and cannot be held. */
  expandReach: 70.0,
  /** How far from a claimed patch its Outpost sits — outside the node's own
   *  clearance, inside a worker's drop-off range. */
  expandNodeStandoff: 5.0,
  /** Keep this much banked before researching, so teching never starves
   *  production entirely. */
  techReserve: 150,
};
