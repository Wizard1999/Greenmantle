import type { TechId } from '../data/tech';
// Shared ids, vectors and enums. Deliberately dependency-free so that both the
// sim and the presentation layers can name the same things without the sim
// ever reaching outward (06 §3).

export type EntityId = number;

export type Team = 'player' | 'rival';
export const TEAMS: readonly Team[] = ['player', 'rival'];

export type UnitTypeKey = 'legionnaire' | 'marksman' | 'worker';
export type BuildingTypeKey = 'standard' | 'outpost';

export interface Vec2 {
  x: number;
  z: number;
}

/** Four-state worker job machine. Once it leaves 'idle' it never returns
 *  without a new order — that is the whole of §8.2 set-and-forget. */
export type UnitOrderMode = 'idle' | 'move' | 'attackMove' | 'patrol' | 'hold';

export type GatherState = 'idle' | 'toNode' | 'gathering' | 'toBase' | 'depositing';

export interface GatherJob {
  state: GatherState;
  nodeId: EntityId | null;
  carrying: number;
  timer: number;
}

/** Progress lives on the site, not here — that is what makes reassignment
 *  pause construction instead of cancelling it (§8.1). */
export interface BuildJob {
  siteId: EntityId | null;
}

export interface Unit {
  id: EntityId;
  type: UnitTypeKey;
  team: Team;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  facing: number;
  prevFacing: number;
  speed: number;
  radius: number;
  target: Vec2 | null;
  /** Current direct player order. Plain data for saves, replays and lockstep. */
  orderMode: UnitOrderMode;
  patrolFrom: Vec2 | null;
  patrolTo: Vec2 | null;
  patrolHeading: 'to' | 'from';
  selected: boolean;
  gather: GatherJob | null;
  build: BuildJob | null;
  hp: number;
  /** Consecutive ticks spent not moving. Drives the Marksman's settle ramp —
   *  stopping doesn't restore accuracy instantly, which is what stops kiting
   *  from being free (§8.7). */
  stillTicks: number;
  /** Current attack target, or null. An id, never a reference — see D-010. */
  targetId: EntityId | null;
  /** Ticks until this unit may attack again. */
  attackCd: number;
  /** Where a pursuit began. Doubles as the leash anchor — a unit may chase up
   *  to `COMBAT.pursuitLeash` from here and no further, which is what stops a
   *  skirmish turning into a map-wide rout. Null when not pursuing. */
  pursuitFrom: Vec2 | null;
  /** The destination to resume once a pursuit ends, so breaking off to fight
   *  does not silently cancel the order that was already given. */
  pursuitResume: Vec2 | null;
}

export interface QueueItem {
  type: UnitTypeKey;
  ticksLeft: number;
}

/**
 * A rally point that can carry intent, not just a destination.
 *
 * "Send new workers to that patch" is one decision the player should make once,
 * not a move order they reissue after every worker. That is the §8.2
 * set-and-forget economy pillar, and the UI blueprint's "constant worker
 * babysitting" listed explicitly as a thing the interface must not require.
 */
export interface RallyPoint {
  x: number;
  z: number;
  /** What the arriving unit does: walk there, mine there, or help build there. */
  kind: RallyKind;
  /** Node or site the rally refers to. Null for a plain move. An id rather
   *  than a reference, so the world stays snapshot-safe (D-010). */
  targetId: EntityId | null;
}

export type RallyKind = 'move' | 'gather' | 'build';

export interface Building {
  id: EntityId;
  type: BuildingTypeKey;
  team: Team;
  x: number;
  z: number;
  radius: number;
  /** Buildings are destructible — the win condition is pure base destruction
   *  (§2), so a base has to be something an army can actually knock down. */
  hp: number;
  queue: QueueItem[];
  /** Where units go when they finish training, and what they do on arrival. */
  rally: RallyPoint;
  /**
   * Per-unit-type overrides. A base can send new workers straight to a mineral
   * patch while new soldiers go to the front, without the player retargeting
   * the rally between every build.
   *
   * A plain object keyed by unit type, deliberately — it has to survive
   * structuredClone and JSON for snapshots and replays (D-010), which a Map
   * would not.
   */
  rallyByType: Partial<Record<UnitTypeKey, RallyPoint>>;
}

export interface ResourceNode {
  id: EntityId;
  x: number;
  z: number;
  amount: number;
  maxAmount: number;
}

export interface Site {
  id: EntityId;
  type: BuildingTypeKey;
  team: Team;
  x: number;
  z: number;
  radius: number;
  progress: number;
  required: number;
}

export interface Scenery {
  kind: 'rock' | 'tree';
  x: number;
  z: number;
  scale: number;
  spin: number;
}

/**
 * The four Phase 1 behaviours (§4 / blueprint 1.7). Two complete and hand over
 * to the next step; two are ongoing and hold the squad until it is redirected.
 */
export type BehaviourKind = 'move' | 'attackmove' | 'gather' | 'patrol';

export interface ChainStep {
  kind: BehaviourKind;
  x: number;
  z: number;
}

/**
 * A squad is a PERSISTENT group, not a transient selection (assumption Q1). It
 * has to persist for §8.3 to mean anything — you cannot cap "how many squads
 * are running a chain" if a squad stops existing the moment you click
 * elsewhere.
 */
export interface Squad {
  id: EntityId;
  team: Team;
  number: number;
  memberIds: EntityId[];
  chain: ChainStep[];
  index: number;
  running: boolean;
  /** Chains loop by default (Q3), with this per-chain toggle. */
  loop: boolean;
  dispatched: boolean;
  stepTicks: number;
  patrolFrom: Vec2 | null;
  patrolTo: Vec2 | null;
  patrolHeading: 'to' | 'from';
  /**
   * The mission whose plan this squad carried out last tick, or null when it
   * was following its own chain or nothing at all.
   *
   * Stored rather than derived, for the same reason `dispatched` is: it records
   * what the squad *was* doing. When the plan changes hands the step counters
   * above describe a chain that no longer applies, and nothing in the current
   * tick says so.
   */
  servingMissionId: EntityId | null;
}

/**
 * A mission is the player's unit of intent, sitting above squads (D-007,
 * UI_BLUEPRINT.md). It has to live in the sim, not the UI: objective,
 * priority and assigned squads all affect what the game considers "assigned"
 * and must be identical across replay/lockstep peers.
 *
 * A mission drives its squads (D-041). It supplies behaviour to a squad that
 * is not running a chain of its own, never overwrites one that is, and governs
 * withdrawal in both cases. `sim/missions.ts` turns the objective into a plan;
 * `sim/squads.ts` executes it through the same machinery a hand-written chain
 * uses.
 */
export type MissionObjective =
  | 'assault' | 'defend' | 'scout' | 'escort' | 'expand' | 'harvest' | 'custom';

export type MissionPriority = 'low' | 'normal' | 'high';

export type MissionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface Mission {
  id: EntityId;
  team: Team;
  objective: MissionObjective;
  priority: MissionPriority;
  status: MissionStatus;
  /** Squads carrying out this mission. Ids, not references (D-010). */
  squadIds: EntityId[];
  /**
   * Where assigned squads fall back to once the operation is spent.
   *
   * Setting it is what arms the withdrawal doctrine: a mission with a fallback
   * breaks off when its force drops below the strength its priority tolerates,
   * a mission without one fights where it stands. That is the whole of the
   * player-facing doctrine, expressed in one placed marker (D-041).
   */
  fallback: Vec2 | null;
  /**
   * The ground the operation is aimed at, worked out from the objective on the
   * first tick the mission has a squad on it.
   *
   * Resolved once, then left alone. Re-deriving it every tick would let the
   * destination move under the army — the nearest enemy structure changes as
   * structures fall — and a plan whose destination moves is not a plan. Stays
   * null for objectives the world cannot answer on its own, and such a mission
   * drives nothing until it is given one.
   */
  target: Vec2 | null;
  /**
   * Greatest total hit points the assigned squads have held at once.
   *
   * The one piece of mission state that cannot be recovered from the current
   * tick: dead members leave their squad's roster entirely, so the survivors of
   * a mauled force always read as full strength. Withdrawal is measured against
   * this, so it has to be remembered.
   */
  strengthPeak: number;
  createdTick: number;
}

export interface World {
  seed: number;
  /** Plain-number PRNG state, not a closure — snapshot/restore and hashing
   *  depend on every byte of sim state being reachable data (D-010). */
  rngState: number;
  /** Seed for map generation, deliberately separate from the match seed. Same
   *  mapSeed always yields the same map; browsing maps never touches the match
   *  generator. */
  mapSeed: number;
  /** Generator version the map was built with — a seed alone cannot reproduce
   *  a map if the generator has changed underneath it. */
  mapVersion: number;
  tick: number;
  /** Tick offset into the day/night cycle at match start, so a game can
   *  begin at any hour and still replay identically. */
  dayStartTick: number;
  nextId: EntityId;
  units: Unit[];
  buildings: Building[];
  nodes: ResourceNode[];
  sites: Site[];
  scenery: Scenery[];
  squads: Squad[];
  resources: Record<Team, number>;
  /** Set once a team has won. The sim keeps running; presentation decides what
   *  to do about it. */
  winner: Team | null;
  /** Ticks each team has spent holding no buildings. */
  eliminationTicks: Record<Team, number>;
  /**
   * The AI opponent's state, or null for a match with no AI.
   *
   * Lives in the sim rather than beside it, because an AI that decided outside
   * the simulation would not reproduce during replay — the match would diverge
   * the moment the AI made its first choice. Being deterministic sim state also
   * means AI commands must NOT be recorded into the replay log: playback
   * re-derives them exactly, and recording them too would apply each twice.
   */
  ai: AiState | null;
  missions: Mission[];
  /** Research per team. The researched list is the single source of truth for
   *  stat modifiers — they are derived on demand, never baked into units, so
   *  restore/replay cannot leave a unit carrying stats it should not have. */
  tech: Record<Team, TeamTechState>;
}

export interface TeamTechState {
  researched: TechId[];
  researching: { id: TechId; ticksLeft: number } | null;
}

export interface AiState {
  team: Team;
  nextThinkTick: number;
  attacking: boolean;
}

export interface CommandResult {
  ok: boolean;
  reason?: string;
  siteId?: EntityId;
}
