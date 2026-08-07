import type {
  BehaviourKind, BuildingTypeKey, EntityId, MissionObjective, MissionPriority, RallyKind,
  Team, UnitTypeKey, Vec2, World,
} from '../core/types';
import { TICK_HZ } from '../core/loop';
import { createWorld, simStep } from './world';
import { enableAi } from './ai';
import { hash } from './snapshot';
import { MAP_VERSION, buildTestMap } from './map';
import {
  cmdAddChainStep, cmdAssignBuilders, cmdCancelSite, cmdCancelTrain, cmdClearChain,
  cmdAttackMove, cmdDisbandSquad, cmdFormSquad, cmdGather, cmdHoldPosition, cmdMove, cmdPatrol, cmdPlaceBuilding,
  cmdClearRally, cmdRemoveChainStep, cmdRunChain, cmdSetChainLoop, cmdSetRally,
  cmdSetSelection,
  cmdStop, cmdStopChain, cmdTrain,
} from './commands';
import {
  cmdAssignSquadToMission, cmdCancelMission, cmdCreateMission,
  cmdRemoveSquadFromMission, cmdSetMissionFallback, cmdSetMissionPriority,
} from './missions';
import { cmdCancelResearch, cmdResearch } from './tech';
import type { TechId } from '../data/tech';

/**
 * Match recording and playback.
 *
 * A replay is the seed, the starting hour and the stream of commands — never a
 * stream of world states. Command streams are orders of magnitude smaller, and
 * re-simulating is a continuous proof that determinism still holds: if a replay
 * diverges, that is a real determinism bug worth finding.
 *
 * See docs/DECISIONS.md D-008 and D-012.
 */

/**
 * Bump when the meaning of a command or of a sim rule changes.
 *
 * 7 — combat resolves simultaneously instead of in array order (B-005), and
 * units now pursue acquired targets under a leash (B-006). Both change what the
 * same command stream produces, so every replay recorded before this would play
 * out differently and must be rejected rather than silently replayed wrong.
 */
export const REPLAY_VERSION = 7;

/**
 * Every player action, as plain serializable data.
 *
 * The discriminated union is the point: it forces commands to stay
 * serializable. A command carrying a function, a Three.js object or an entity
 * reference could not appear here, and that is exactly the constraint replays,
 * rollback and networking all need.
 */
export type Command =
  | { t: 'move'; units: EntityId[]; x: number; z: number }
  | { t: 'attackMove'; units: EntityId[]; x: number; z: number }
  | { t: 'patrol'; units: EntityId[]; x: number; z: number }
  | { t: 'stop'; units: EntityId[] }
  | { t: 'hold'; units: EntityId[] }
  | { t: 'gather'; units: EntityId[]; node: EntityId }
  | { t: 'train'; building: EntityId; unit: UnitTypeKey }
  | { t: 'cancelTrain'; building: EntityId; index: number }
  | {
      t: 'rally'; building: EntityId; x: number; z: number;
      unitType?: UnitTypeKey; kind?: RallyKind; targetId?: EntityId | null;
    }
  | { t: 'clearRally'; building: EntityId; unitType: UnitTypeKey }
  | { t: 'place'; team: Team; type: BuildingTypeKey; x: number; z: number; builders: EntityId[] }
  | { t: 'assignBuilders'; units: EntityId[]; site: EntityId }
  | { t: 'cancelSite'; site: EntityId }
  | { t: 'select'; units: EntityId[] }
  | { t: 'formSquad'; team: Team; units: EntityId[]; number: number }
  | { t: 'disbandSquad'; squad: EntityId }
  | { t: 'addChainStep'; squad: EntityId; kind: BehaviourKind; x: number; z: number }
  | { t: 'removeChainStep'; squad: EntityId; index: number }
  | { t: 'clearChain'; squad: EntityId }
  | { t: 'setChainLoop'; squad: EntityId; loop: boolean }
  | { t: 'runChain'; squad: EntityId }
  | { t: 'stopChain'; squad: EntityId }
  | {
      t: 'createMission'; team: Team; objective: MissionObjective;
      priority?: MissionPriority; squadIds?: EntityId[]; fallback?: Vec2 | null;
    }
  | { t: 'assignSquadToMission'; mission: EntityId; squad: EntityId }
  | { t: 'removeSquadFromMission'; mission: EntityId; squad: EntityId }
  | { t: 'setMissionPriority'; mission: EntityId; priority: MissionPriority }
  | { t: 'setMissionFallback'; mission: EntityId; fallback: Vec2 | null }
  | { t: 'cancelMission'; mission: EntityId }
  | { t: 'research'; team: Team; tech: TechId }
  | { t: 'cancelResearch'; team: Team };

export interface TimedCommand {
  tick: number;
  cmd: Command;
}

export interface Replay {
  version: number;
  seed: number;
  /** Hour of the in-game day the match began at. Omitting this would make a
   *  replay silently wrong rather than obviously broken — the sim would run
   *  correctly but at the wrong time of day. */
  startHour: number;
  /** Recorded because tick rate is baked into every duration constant. A replay
   *  from a different tick rate must be rejected, not played. */
  tickRate: number;
  /** The map, recorded separately from the match seed so a replay pins the
   *  terrain it was actually played on. */
  mapSeed: number;
  /** The generator that built that map. A seed alone cannot reproduce a map if
   *  the generator changed underneath it — without this, altering map
   *  generation would silently replay old matches on different terrain. */
  mapVersion: number;
  /** Match setup is part of deterministic reproduction. */
  opponent: 'none' | 'standardAi';
  /** Tick reached when this recording was exported, when known. */
  endTick?: number;
  /** Optional integrity checkpoint for the exported end state. */
  finalHash?: string;
  commands: TimedCommand[];
}

/**
 * Apply one command to the world.
 *
 * The single funnel every player action passes through, so recording is one
 * call rather than 25 scattered ones. Results are intentionally discarded — a
 * rejected command is still part of the honest record of what the player tried.
 */
export function dispatch(world: World, c: Command): void {
  switch (c.t) {
    case 'move': cmdMove(world, c.units, c.x, c.z); break;
    case 'attackMove': cmdAttackMove(world, c.units, c.x, c.z); break;
    case 'patrol': cmdPatrol(world, c.units, c.x, c.z); break;
    case 'stop': cmdStop(world, c.units); break;
    case 'hold': cmdHoldPosition(world, c.units); break;
    case 'gather': cmdGather(world, c.units, c.node); break;
    case 'train': cmdTrain(world, c.building, c.unit); break;
    case 'cancelTrain': cmdCancelTrain(world, c.building, c.index); break;
    case 'rally':
      cmdSetRally(world, c.building, c.x, c.z, {
        ...(c.unitType ? { unitType: c.unitType } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
        ...(c.targetId !== undefined ? { targetId: c.targetId } : {}),
      });
      break;
    case 'clearRally': cmdClearRally(world, c.building, c.unitType); break;
    case 'place': cmdPlaceBuilding(world, c.team, c.type, c.x, c.z, c.builders); break;
    case 'assignBuilders': cmdAssignBuilders(world, c.units, c.site); break;
    case 'cancelSite': cmdCancelSite(world, c.site); break;
    case 'select': cmdSetSelection(world, c.units); break;
    case 'formSquad': cmdFormSquad(world, c.team, c.units, c.number); break;
    case 'disbandSquad': cmdDisbandSquad(world, c.squad); break;
    case 'addChainStep': cmdAddChainStep(world, c.squad, c.kind, c.x, c.z); break;
    case 'removeChainStep': cmdRemoveChainStep(world, c.squad, c.index); break;
    case 'clearChain': cmdClearChain(world, c.squad); break;
    case 'setChainLoop': cmdSetChainLoop(world, c.squad, c.loop); break;
    case 'runChain': cmdRunChain(world, c.squad); break;
    case 'stopChain': cmdStopChain(world, c.squad); break;
    case 'createMission':
      cmdCreateMission(world, c.team, c.objective, {
        ...(c.priority !== undefined ? { priority: c.priority } : {}),
        ...(c.squadIds !== undefined ? { squadIds: c.squadIds } : {}),
        ...(c.fallback !== undefined ? { fallback: c.fallback } : {}),
      });
      break;
    case 'assignSquadToMission': cmdAssignSquadToMission(world, c.mission, c.squad); break;
    case 'removeSquadFromMission': cmdRemoveSquadFromMission(world, c.mission, c.squad); break;
    case 'setMissionPriority': cmdSetMissionPriority(world, c.mission, c.priority); break;
    case 'setMissionFallback': cmdSetMissionFallback(world, c.mission, c.fallback); break;
    case 'cancelMission': cmdCancelMission(world, c.mission); break;
    case 'research': cmdResearch(world, c.team, c.tech); break;
    case 'cancelResearch': cmdCancelResearch(world, c.team); break;
  }
}

/**
 * Records a match while it is played.
 *
 * Commands are stamped with the tick they were issued on. In live play a
 * command is issued during a render frame and takes effect before the next
 * `simStep`, so playback applies every command stamped `t` *before* stepping
 * from `t`. Getting that ordering wrong produces a replay that is subtly one
 * tick out and diverges slowly — the worst kind of bug to chase.
 */
export class Recorder {
  private readonly log: TimedCommand[] = [];
  private invalidReasonValue: string | null = null;

  constructor(
    private readonly seed: number,
    private readonly startHour: number,
    private readonly mapSeed: number = seed,
    private readonly opponent: Replay['opponent'] = 'none',
  ) {}

  invalidate(reason: string): void {
    this.invalidReasonValue = reason;
  }

  get isValid(): boolean { return this.invalidReasonValue === null; }
  get invalidReason(): string | null { return this.invalidReasonValue; }

  /** Record without applying. Used by browser UI that needs command results. */
  record(world: World, cmd: Command): void {
    this.log.push({ tick: world.tick, cmd });
  }

  /** Record and apply in one step, so the two can never drift apart. */
  apply(world: World, cmd: Command): void {
    this.record(world, cmd);
    dispatch(world, cmd);
  }

  get length(): number {
    return this.log.length;
  }

  finish(world?: World): Replay {
    if (!this.isValid) throw new Error(`recording unavailable: ${this.invalidReasonValue}`);
    return {
      version: REPLAY_VERSION,
      seed: this.seed,
      startHour: this.startHour,
      tickRate: TICK_HZ,
      mapSeed: this.mapSeed,
      mapVersion: MAP_VERSION,
      opponent: this.opponent,
      endTick: world?.tick,
      finalHash: world ? hash(world) : undefined,
      commands: [...this.log],
    };
  }
}

export interface ReplayCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Reject replays that cannot be played correctly.
 *
 * Deliberately refuses rather than attempting a best effort: a replay played at
 * the wrong tick rate runs every duration in the game at the wrong speed and
 * looks plausible while being wrong throughout.
 */
export function checkReplay(r: Replay): ReplayCheck {
  if (r.version !== REPLAY_VERSION) {
    return { ok: false, reason: `replay version ${r.version}, expected ${REPLAY_VERSION}` };
  }
  if (r.tickRate !== TICK_HZ) {
    return { ok: false, reason: `replay recorded at ${r.tickRate}Hz, this build runs at ${TICK_HZ}Hz` };
  }
  if (r.opponent !== 'none' && r.opponent !== 'standardAi') {
    return { ok: false, reason: `unknown replay opponent mode ${String(r.opponent)}` };
  }
  if (r.mapVersion !== MAP_VERSION) {
    return {
      ok: false,
      reason: `replay built on map generator v${r.mapVersion}, this build has v${MAP_VERSION}`,
    };
  }
  return { ok: true };
}

/**
 * Re-simulate a replay up to `untilTick` and return the resulting world.
 *
 * Plays from tick 0 rather than seeking. Keyframe seeking is a later
 * optimisation and belongs with `snapshot()`; this is the correctness baseline
 * that seeking will be checked against.
 */
export function playback(r: Replay, untilTick: number): World {
  const check = checkReplay(r);
  if (!check.ok) throw new Error(`cannot play replay: ${check.reason}`);

  const base = buildTestMap(createWorld(r.seed, r.startHour, r.mapSeed));
  const world = r.opponent === 'standardAi' ? enableAi(base) : base;

  // Bucket by tick so playback is O(commands) rather than O(ticks x commands).
  const byTick = new Map<number, Command[]>();
  for (const { tick, cmd } of r.commands) {
    const list = byTick.get(tick);
    if (list) list.push(cmd);
    else byTick.set(tick, [cmd]);
  }

  for (let t = 0; t < untilTick; t++) {
    const due = byTick.get(t);
    if (due) for (const c of due) dispatch(world, c);
    simStep(world);
  }
  return world;
}

export function serializeReplay(r: Replay): string {
  return JSON.stringify(r);
}

export function parseReplay(text: string): Replay {
  const parsed = JSON.parse(text) as Replay;
  const check = checkReplay(parsed);
  if (!check.ok) throw new Error(`cannot load replay: ${check.reason}`);
  return parsed;
}

/** Re-simulate the recorded endpoint and validate its optional hash checkpoint. */
export function verifyReplay(r: Replay): ReplayCheck {
  const check = checkReplay(r);
  if (!check.ok) return check;
  if (r.endTick === undefined || r.finalHash === undefined) {
    return { ok: false, reason: 'replay has no endpoint hash checkpoint' };
  }
  const actual = hash(playback(r, r.endTick));
  return actual === r.finalHash
    ? { ok: true }
    : { ok: false, reason: `desync at tick ${r.endTick}: expected ${r.finalHash}, got ${actual}` };
}

