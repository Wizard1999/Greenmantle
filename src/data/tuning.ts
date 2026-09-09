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
  /** Damage a unit does to a building, as a fraction of its normal damage.
   *  Nothing in the Phase 1 roster is a siege unit, so everything chips. */
  buildingDamageScale: 0.5,
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
  carryAmount: 8,       // essence per trip
  depositTicks: 6,      // 0.2s to unload
  gatherRange: 1.4,     // how close a worker must be to a node
  gatherStandoff: 1.05, // where a worker parks — each gets its own slot
  slotEpsilon: 0.12,    // how close to its slot counts as arrived
  dropoffRange: 2.6,    // how close a worker must be to a base
  nodeCapacity: 1200,   // finite: matches can run until the map is exhausted (§3)
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
  /** Fighters before it commits to attacking. */
  attackAtArmySize: 8,
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
  /** Keep this much banked before researching, so teching never starves
   *  production entirely. */
  techReserve: 150,
};
