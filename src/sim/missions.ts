import type {
  ChainStep, CommandResult, EntityId, Mission, MissionObjective, MissionPriority,
  Squad, Team, UnitOrderMode, Vec2, World,
} from '../core/types';
import { MISSION } from '../data/tuning';
import { isInControl } from './supply';

/**
 * Missions (D-007, D-027, D-041). The player's unit of intent, sitting above
 * squads.
 *
 * A mission answers *why* a squad is somewhere. The squad's own behaviour chain
 * answers *how*. This file turns the first into the second: it works out the
 * ground an objective is aimed at, hands `sim/squads.ts` a plan in the ordinary
 * `ChainStep[]` currency, and decides when the operation is spent.
 *
 * Three rules govern the relationship, and D-041 records why each rejected
 * alternative is worse:
 *
 *   - A mission **supplies** behaviour to a squad that has none running. It
 *     never overwrites a chain the player wrote and started.
 *   - A mission **governs** withdrawal in both cases. "Break off below this
 *     much strength and fall back to there" is doctrine the player set, so it
 *     outranks the squad's current step whichever supplied it.
 *   - Everything a mission does to a squad is **derived from mission state**,
 *     never written into the squad. Baking a chain onto a squad at assignment
 *     would survive every test and break `restore()` silently, exactly as
 *     baking tech modifiers onto units would have (D-028).
 *
 * Nothing here names a unit, building or resource type (D-029). An objective is
 * resolved against whatever the world happens to contain.
 */

export function findMission(world: World, missionId: EntityId): Mission | undefined {
  return world.missions.find(m => m.id === missionId);
}

/** The active mission a squad serves, if any. A squad serves at most one. */
export function missionForSquad(world: World, squadId: EntityId): Mission | null {
  return world.missions.find(m => m.status === 'active' && m.squadIds.includes(squadId)) ?? null;
}

export function cmdCreateMission(
  world: World, team: Team, objective: MissionObjective,
  opts: { priority?: MissionPriority; squadIds?: EntityId[]; fallback?: Vec2 | null } = {},
): CommandResult {
  const squadIds = (opts.squadIds ?? []).filter(id =>
    world.squads.some(sq => sq.id === id && sq.team === team));

  const mission: Mission = {
    id: world.nextId++,
    team,
    objective,
    priority: opts.priority ?? 'normal',
    status: 'active',
    squadIds,
    fallback: opts.fallback ?? null,
    target: null,
    strengthPeak: 0,
    createdTick: world.tick,
  };
  world.missions.push(mission);
  return { ok: true, siteId: mission.id };
}

/** A squad serves at most one mission at a time — it is dropped from any
 *  other mission it was carrying out, the same way forming a new squad
 *  supersedes a unit's old one. */
export function cmdAssignSquadToMission(
  world: World, missionId: EntityId, squadId: EntityId,
): CommandResult {
  const mission = findMission(world, missionId);
  if (!mission) return { ok: false, reason: 'no such mission' };
  if (mission.status !== 'active') return { ok: false, reason: 'mission is not active' };
  const squad = world.squads.find(sq => sq.id === squadId);
  if (!squad) return { ok: false, reason: 'no such squad' };
  if (squad.team !== mission.team) return { ok: false, reason: 'not your squad' };

  for (const m of world.missions) {
    if (m.id !== mission.id) m.squadIds = m.squadIds.filter(id => id !== squadId);
  }
  if (!mission.squadIds.includes(squadId)) mission.squadIds.push(squadId);
  return { ok: true };
}

export function cmdRemoveSquadFromMission(
  world: World, missionId: EntityId, squadId: EntityId,
): CommandResult {
  const mission = findMission(world, missionId);
  if (!mission) return { ok: false, reason: 'no such mission' };
  mission.squadIds = mission.squadIds.filter(id => id !== squadId);
  return { ok: true };
}

export function cmdSetMissionPriority(
  world: World, missionId: EntityId, priority: MissionPriority,
): CommandResult {
  const mission = findMission(world, missionId);
  if (!mission) return { ok: false, reason: 'no such mission' };
  mission.priority = priority;
  return { ok: true };
}

export function cmdSetMissionFallback(
  world: World, missionId: EntityId, fallback: Vec2 | null,
): CommandResult {
  const mission = findMission(world, missionId);
  if (!mission) return { ok: false, reason: 'no such mission' };
  mission.fallback = fallback;
  return { ok: true };
}

/** Cancelling is explicit and terminal, distinct from completion/failure —
 *  those are outcome judgements a future objective-tracking system makes;
 *  cancellation is simply the player calling it off. Assigned squads stop
 *  being driven and hold where they stand; the roster is left intact so the
 *  panel can still say who was on it. */
export function cmdCancelMission(world: World, missionId: EntityId): CommandResult {
  const mission = findMission(world, missionId);
  if (!mission) return { ok: false, reason: 'no such mission' };
  if (mission.status !== 'active') return { ok: false, reason: 'mission is already over' };
  mission.status = 'cancelled';
  return { ok: true };
}

// --- Strength and withdrawal (D-041) --------------------------------------

function assignedMemberIds(world: World, mission: Mission): Set<EntityId> {
  const ids = new Set<EntityId>();
  for (const sq of world.squads) {
    if (!mission.squadIds.includes(sq.id)) continue;
    for (const id of sq.memberIds) ids.add(id);
  }
  return ids;
}

/**
 * The operation's current strength, in hit points across every assigned squad.
 *
 * Hit points rather than a head count because a force ground down to healthy
 * survivors and a force still whole but badly hurt are not the same situation,
 * and only one of them should keep pressing. Iterates `world.units` rather than
 * the id set so the order of floating-point addition is array order, which is
 * identical on every peer (D-010).
 */
export function missionStrength(world: World, mission: Mission): number {
  const ids = assignedMemberIds(world, mission);
  if (!ids.size) return 0;
  let hp = 0;
  for (const u of world.units) if (ids.has(u.id)) hp += u.hp;
  return hp;
}

/**
 * Whether the operation is spent and its squads should be falling back.
 *
 * Derived every tick from the high-water mark rather than latched, so
 * reinforcing a broken mission genuinely puts it back in the fight. There is no
 * oscillation to guard against: nothing in the game heals, so strength only
 * falls except when squads are added, and adding squads raises the threshold by
 * the same amount it raises the strength.
 *
 * No fallback position means no withdrawal, whatever the losses. Where a beaten
 * squad should go is a decision the player makes by placing the marker, and a
 * simulation that picked one for them would be the interface giving advice.
 */
export function missionWithdrawing(world: World, mission: Mission): boolean {
  if (!mission.fallback || mission.strengthPeak <= 0) return false;
  return missionStrength(world, mission)
    < mission.strengthPeak * MISSION.withdrawBelowStrength[mission.priority];
}

// --- Turning an objective into ground --------------------------------------

/**
 * Where the operation is being run from, for the purpose of "nearest".
 *
 * The force's own centre of mass, not a base: an objective is resolved once,
 * when squads are first put on it, and what a squad is nearest to is the
 * question a commander is actually asking when they point at a map.
 */
function forceCentre(world: World, mission: Mission): Vec2 | null {
  const ids = assignedMemberIds(world, mission);
  if (!ids.size) return null;
  let x = 0;
  let z = 0;
  let n = 0;
  for (const u of world.units) {
    if (!ids.has(u.id)) continue;
    x += u.x; z += u.z; n++;
  }
  return n ? { x: x / n, z: z / n } : null;
}

/** Ties broken by id, so the choice cannot depend on array order (D-010). */
function nearest<T extends { id: EntityId; x: number; z: number }>(
  items: readonly T[], from: Vec2, want: (item: T) => boolean,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const item of items) {
    if (!want(item)) continue;
    const d = Math.hypot(item.x - from.x, item.z - from.z);
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && best && item.id < best.id)) {
      best = item;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The ground an objective points at, worked out from the world.
 *
 * This is the half of "intent over execution" (D-003) that the mission system
 * exists for: the player names what the squad is *for* and the army works out
 * where that is. Naming a place explicitly is a refinement, not a requirement —
 * and it is one the command stream cannot carry yet, so today every plan comes
 * from here.
 *
 * `escort` and `custom` deliberately resolve to nothing. Escort needs a subject
 * to escort and `Mission` carries no such field; custom means the player is
 * writing the chain themselves. Giving either a plausible-looking derived point
 * would be worse than leaving it visibly unimplemented.
 */
export function resolveMissionTarget(world: World, mission: Mission): Vec2 | null {
  const from = forceCentre(world, mission);
  if (!from) return null;
  const point = (at: { x: number; z: number } | null): Vec2 | null =>
    at ? { x: at.x, z: at.z } : null;

  switch (mission.objective) {
    // Where the enemy is. Scouting aims at the same ground and only paces to
    // it — see MISSION_POSTURE.
    case 'assault':
    case 'scout':
      return point(nearest(world.buildings, from, b => b.team !== mission.team));

    case 'defend':
      return point(nearest(world.buildings, from, b => b.team === mission.team));

    case 'harvest':
      return point(nearest(world.nodes, from, n => n.amount > 0));

    // Ground worth taking is ground you do not already hold (§8.1, D-038 —
    // resource placement puts nodes outside starting control radii precisely so
    // that expansion has somewhere to go). If every patch is already inside
    // friendly control there is nothing to expand to, so fall back to securing
    // the nearest one rather than resolving to nothing.
    case 'expand': {
      const outside = nearest(world.nodes, from, n =>
        n.amount > 0 && !isInControl(world, mission.team, n.x, n.z));
      return point(outside ?? nearest(world.nodes, from, n => n.amount > 0));
    }

    case 'escort':
    case 'custom':
      return null;
  }
}

// --- Turning ground into a plan --------------------------------------------

/**
 * How a squad carries an objective out.
 *
 * Six objectives, four postures. The vocabulary is kept small on purpose: a
 * posture is a promise about when a squad will and will not leave the ground it
 * was sent to, and a player who cannot predict that cannot plan with it. Adding
 * a fifth should be a decision, not a quiet elaboration.
 *
 *   press   — take the ground and hold it, engaging and pursuing within the
 *             combat leash. `attackMove`.
 *   hold    — stand on the ground and shoot what comes into reach, but never be
 *             drawn off it. `move`, which `stepPursuit` refuses to divert.
 *   observe — pace between where the squad started and the objective, without
 *             committing. Also `move`: a scout that chases is not scouting.
 *   work    — put the squad's workers on the ground and leave them there.
 */
type Posture = 'press' | 'hold' | 'observe' | 'work';

const MISSION_POSTURE: Record<MissionObjective, Posture | null> = {
  assault: 'press',
  expand: 'press',
  defend: 'hold',
  escort: 'hold',
  scout: 'observe',
  harvest: 'work',
  custom: null,
};

/**
 * One step, always. A mission plan is a standing intent rather than a route —
 * the squad re-forms on its objective whenever it drifts, which is what makes
 * `loop` true throughout. Routes are what the chain editor is for, and a
 * mission that overwrote one would be answering a question the player already
 * answered.
 */
interface Plan {
  chain: ChainStep[];
  loop: boolean;
  mode: UnitOrderMode;
}

function planFor(posture: Posture, at: Vec2): Plan {
  switch (posture) {
    case 'press':
      return { chain: [{ kind: 'attackmove', x: at.x, z: at.z }], loop: true, mode: 'attackMove' };
    case 'hold':
      return { chain: [{ kind: 'move', x: at.x, z: at.z }], loop: true, mode: 'move' };
    case 'observe':
      return { chain: [{ kind: 'patrol', x: at.x, z: at.z }], loop: true, mode: 'move' };
    case 'work':
      return { chain: [{ kind: 'gather', x: at.x, z: at.z }], loop: true, mode: 'move' };
  }
}

/**
 * What a mission is telling one of its squads to do this tick, or null when it
 * is telling it nothing.
 *
 * Transient — recomputed every tick and never stored on the squad. The only
 * thing the squad keeps is which mission it was serving, so it knows when its
 * step counters have gone stale.
 */
export type MissionOrder =
  | { kind: 'withdraw'; missionId: EntityId; to: Vec2 }
  | {
      kind: 'execute'; missionId: EntityId; priority: MissionPriority;
      orderedTick: number; chain: ChainStep[]; loop: boolean; mode: UnitOrderMode;
    };

export function missionOrderFor(world: World, squad: Squad): MissionOrder | null {
  const mission = missionForSquad(world, squad.id);
  if (!mission) return null;

  if (mission.fallback && missionWithdrawing(world, mission)) {
    return {
      kind: 'withdraw',
      missionId: mission.id,
      to: { x: mission.fallback.x, z: mission.fallback.z },
    };
  }

  const posture = MISSION_POSTURE[mission.objective];
  if (!posture || !mission.target) return null;
  return {
    kind: 'execute',
    missionId: mission.id,
    priority: mission.priority,
    orderedTick: mission.createdTick,
    ...planFor(posture, mission.target),
  };
}

/**
 * Per-tick upkeep: prune dead squads, resolve the objective, track strength.
 *
 * Squads are pruned by `combat.stepReaper` when their last member dies, which
 * would otherwise leave a mission holding a dangling id — invisible until
 * something tries to look the squad up and finds nothing, or a hash disagrees
 * because one peer pruned and the other has not gotten there yet. Run this
 * every tick, not lazily, so it is never a source of order-dependent drift.
 *
 * Runs after combat, so the strength it records is the strength the operation
 * finished the tick with, and `stepSquads` reads it at the start of the next.
 * One tick of lag, identical on every peer.
 */
export function stepMissions(world: World): void {
  if (!world.missions.length) return;
  const liveSquads = new Set(world.squads.map(sq => sq.id));
  for (const m of world.missions) {
    if (m.squadIds.length) m.squadIds = m.squadIds.filter(id => liveSquads.has(id));
    if (m.status !== 'active') continue;
    if (!m.squadIds.length) {
      // Nobody is carrying it out, so there is no commitment to measure against.
      // Without this, a mission whose force was wiped out would keep the dead
      // force's high-water mark and send its replacements straight back home.
      // The objective is kept: re-crewing an operation continues it, and the
      // ground it was aimed at has not changed.
      m.strengthPeak = 0;
      continue;
    }
    if (!m.target) m.target = resolveMissionTarget(world, m);
    const strength = missionStrength(world, m);
    if (strength > m.strengthPeak) m.strengthPeak = strength;
  }
}
