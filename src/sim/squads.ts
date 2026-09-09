import type {
  BehaviourKind, ChainStep, EntityId, MissionPriority, Squad, Team, Unit,
  UnitOrderMode, Vec2, World,
} from '../core/types';
import { AUTOMATION } from '../data/tuning';
import { assignGather, nearestNodeWithResources } from './economy';
import { supplyCap } from './supply';
import type { MissionOrder } from './missions';
import { missionOrderFor } from './missions';
import { clampPointToMapBoundary, mapBoundaryForSeed } from './mapBoundary';

/**
 * A chain is a short list of steps the squad walks through on its own. Two
 * behaviours complete and hand over to the next step; two are ongoing and hold
 * the squad there until it is redirected.
 */
export const BEHAVIOURS: Record<BehaviourKind, { label: string; ongoing: boolean }> = {
  move: { label: 'Move', ongoing: false },
  attackmove: { label: 'Attack-move', ongoing: false },
  gather: { label: 'Gather', ongoing: true },
  patrol: { label: 'Patrol', ongoing: true },
};

/**
 * The order mode each behaviour puts its members into.
 *
 * Previously a chain dispatched members without touching `orderMode` at all, so
 * a `move` step and an `attackmove` step produced byte-identical behaviour and
 * the editor's "Attack-move" label described nothing. `stepPursuit` reads this
 * field and nothing else to decide whether a unit may leave its destination to
 * chase, which is the entire difference between the two.
 */
const STEP_MODE: Record<BehaviourKind, UnitOrderMode> = {
  move: 'move',
  attackmove: 'attackMove',
  gather: 'move',
  patrol: 'patrol',
};

/** Structural ordering of the priority enum, for deciding which operations get
 *  Command bandwidth first. Not a balance number — it is what "high" means. */
const PRIORITY_RANK: Record<MissionPriority, number> = { low: 0, normal: 1, high: 2 };

/** Assumption A4: Command gates both the population cap and the number of
 *  squads that can run a chain simultaneously (§8.3). */
export function automationSlots(world: World, team: Team): number {
  return Math.floor(supplyCap(world, team) / AUTOMATION.commandPerSlot);
}

export function runningSquads(world: World, team: Team): number {
  return world.squads.filter(s => s.team === team && s.running).length;
}

export function findSquad(world: World, id: EntityId | null): Squad | null {
  return world.squads.find(s => s.id === id) ?? null;
}

export function squadByNumber(world: World, team: Team, n: number): Squad | null {
  return world.squads.find(s => s.team === team && s.number === n) ?? null;
}

export function squadMembers(world: World, squad: Squad): Unit[] {
  return world.units.filter(u => squad.memberIds.includes(u.id));
}

export function squadOf(world: World, unitId: EntityId): Squad | null {
  return world.squads.find(s => s.memberIds.includes(unitId)) ?? null;
}

export function createSquad(
  world: World, team: Team, unitIds: EntityId[], number: number,
): Squad {
  // a unit belongs to at most one squad
  for (const sq of world.squads) {
    sq.memberIds = sq.memberIds.filter(id => !unitIds.includes(id));
  }
  const existing = world.squads.findIndex(s => s.team === team && s.number === number);
  if (existing >= 0) world.squads.splice(existing, 1);
  const squad: Squad = {
    id: world.nextId++,
    team, number,
    memberIds: [...unitIds],
    chain: [],
    index: 0,
    running: false,
    loop: true,
    dispatched: false,
    stepTicks: 0,
    patrolFrom: null,
    patrolTo: null,
    patrolHeading: 'to',
    servingMissionId: null,
  };
  world.squads.push(squad);
  pruneSquads(world);
  return squad;
}

/** Drop dead members; disband squads that have none left. */
export function pruneSquads(world: World): void {
  const alive = new Set(world.units.map(u => u.id));
  for (let i = world.squads.length - 1; i >= 0; i--) {
    const sq = world.squads[i];
    if (!sq) continue;
    sq.memberIds = sq.memberIds.filter(id => alive.has(id));
    if (!sq.memberIds.length) world.squads.splice(i, 1);
  }
}

export function squadCentre(world: World, squad: Squad): Vec2 | null {
  const ms = squadMembers(world, squad);
  if (!ms.length) return null;
  let x = 0;
  let z = 0;
  for (const u of ms) { x += u.x; z += u.z; }
  return { x: x / ms.length, z: z / ms.length };
}

/** Forget where a squad had got to. Used whenever the plan it was executing is
 *  replaced, because the step counters describe a chain that no longer applies. */
export function resetChainProgress(squad: Squad): void {
  squad.index = 0;
  squad.dispatched = false;
  squad.stepTicks = 0;
  squad.patrolFrom = null;
  squad.patrolTo = null;
  squad.patrolHeading = 'to';
}

/** Send the squad to a point in formation. Same spread rule as a manual order,
 *  so an automated move looks exactly like a hand-issued one. */
function dispatchTo(
  world: World, squad: Squad, x: number, z: number, mode: UnitOrderMode,
): void {
  const ms = squadMembers(world, squad);
  const boundary = mapBoundaryForSeed(world.mapSeed);
  ms.forEach((u, i) => {
    if (u.gather) { u.gather.state = 'idle'; u.gather.nodeId = null; }
    if (u.build) u.build.siteId = null;
    // A squad dispatch supersedes any direct patrol the unit was walking;
    // leaving the old leg in place would have `stepMovement` bounce the unit
    // between two points nobody asked for the moment the mode became 'patrol'.
    u.patrolFrom = null;
    u.patrolTo = null;
    u.patrolHeading = 'to';
    u.orderMode = mode;
    if (ms.length === 1) { u.target = clampPointToMapBoundary(boundary, x, z, u.radius); return; }
    const a = (i / ms.length) * Math.PI * 2;
    const spread = Math.min(0.5 * ms.length, 3.0);
    u.target = clampPointToMapBoundary(
      boundary, x + Math.cos(a) * spread, z + Math.sin(a) * spread, u.radius,
    );
  });
}

function squadArrived(world: World, squad: Squad, x: number, z: number): boolean {
  const ms = squadMembers(world, squad);
  if (!ms.length) return true;
  return ms.every(u => Math.hypot(u.x - x, u.z - z) <= AUTOMATION.arriveRadius + ms.length * 0.12);
}

function advanceStep(squad: Squad, chainLength: number, loop: boolean): void {
  squad.index++;
  squad.dispatched = false;
  squad.stepTicks = 0;
  squad.patrolFrom = null;
  squad.patrolTo = null;
  if (squad.index >= chainLength) {
    if (loop && chainLength) squad.index = 0;
    else { squad.index = Math.max(0, chainLength - 1); squad.running = false; }
  }
}

/**
 * What one squad is executing this tick.
 *
 * `missionId` is null for a chain the player wrote and started, and `mode` is
 * null when the behaviour's own default applies — a mission overrides it,
 * because two objectives can walk the same kind of step for different reasons
 * (a scout and a picket both patrol; only one of them may be drawn into a
 * fight).
 */
type SquadOrder =
  | {
      kind: 'chain'; chain: readonly ChainStep[]; loop: boolean;
      missionId: EntityId | null; mode: UnitOrderMode | null;
    }
  | { kind: 'withdraw'; to: Vec2; missionId: EntityId };

/**
 * Decide what every squad is doing this tick, and who gets the bandwidth.
 *
 * Three rules, in order:
 *
 * **Withdrawal outranks everything.** It is doctrine the player set on the
 * mission, so it overrides a hand-written chain as readily as a derived one,
 * and it is exempt from the Command cap. Bandwidth limits how many operations a
 * commander can *run*; trapping a broken squad in place because the army is
 * over-tasked would be perverse.
 *
 * **A running chain wins over its mission's plan.** `cmdRunChain` already
 * granted that squad a slot and the player already answered "how", so the
 * mission has nothing left to say except when to break off. The alternative —
 * a mission overwriting the chain — throws away work the player did and makes
 * the chain editor and the mission panel fight over the same squad.
 *
 * **Mission plans take what bandwidth is left, highest priority first.** §8.3
 * gates how many squads may run a chain at once and a derived chain is still a
 * chain; leaving missions outside the cap would make automation free the moment
 * the player used the layer the blueprint calls primary. Ties break by the tick
 * the operation was ordered, then by squad id, so precedence never depends on
 * array order. A squad the cap excludes simply holds — its assignment stands,
 * so the panel shows an operation waiting on Command rather than one that
 * silently evaporated.
 */
function planSquads(world: World): Map<EntityId, SquadOrder> {
  const plan = new Map<EntityId, SquadOrder>();
  const used: Record<Team, number> = { player: 0, rival: 0 };
  const waiting: Array<{ squad: Squad; order: Extract<MissionOrder, { kind: 'execute' }> }> = [];

  for (const squad of world.squads) {
    const order = missionOrderFor(world, squad);
    if (order && order.kind === 'withdraw') {
      plan.set(squad.id, { kind: 'withdraw', to: order.to, missionId: order.missionId });
      continue;
    }
    if (squad.running && squad.chain.length) {
      plan.set(squad.id, {
        kind: 'chain', chain: squad.chain, loop: squad.loop, missionId: null, mode: null,
      });
      used[squad.team]++;
      continue;
    }
    if (order) waiting.push({ squad, order });
  }

  waiting.sort((a, b) =>
    PRIORITY_RANK[b.order.priority] - PRIORITY_RANK[a.order.priority]
    || a.order.orderedTick - b.order.orderedTick
    || a.squad.id - b.squad.id);

  const slots: Record<Team, number> = {
    player: automationSlots(world, 'player'),
    rival: automationSlots(world, 'rival'),
  };
  for (const { squad, order } of waiting) {
    if (used[squad.team] >= slots[squad.team]) continue;
    used[squad.team]++;
    plan.set(squad.id, {
      kind: 'chain', chain: order.chain, loop: order.loop,
      missionId: order.missionId, mode: order.mode,
    });
  }
  return plan;
}

export function stepSquads(world: World): void {
  pruneSquads(world);
  const orders = planSquads(world);

  for (const squad of world.squads) {
    const order = orders.get(squad.id) ?? null;
    const serving = order ? order.missionId : null;
    if (squad.servingMissionId !== serving) {
      resetChainProgress(squad);
      squad.servingMissionId = serving;
    }
    if (!order) continue;

    if (order.kind === 'withdraw') {
      // Re-dispatched every tick until the squad is home, and that is the point:
      // a withdrawal must not be re-decided by whatever the squad is fighting.
      // `stepPursuit` writes the unit's target when it chases and restores it
      // when it breaks off, so a single dispatch would be overwritten by the
      // first enemy that stayed in acquire range. Dispatching in 'move' mode
      // also tells `stepPursuit` to disengage outright.
      squad.dispatched = false;
      squad.stepTicks = 0;
      if (!squadArrived(world, squad, order.to.x, order.to.z)) {
        dispatchTo(world, squad, order.to.x, order.to.z, 'move');
      }
      continue;
    }

    const ms = squadMembers(world, squad);
    if (!ms.length) continue;
    const chain = order.chain;
    if (squad.index >= chain.length) resetChainProgress(squad);
    const step = chain[squad.index];
    if (!step) { squad.running = false; continue; }
    const mode = order.mode ?? STEP_MODE[step.kind];
    squad.stepTicks++;

    // A step that cannot finish (unreachable point, blocked) must not wedge the
    // whole chain forever — give up and move on.
    if (squad.stepTicks > AUTOMATION.stepTimeout && !BEHAVIOURS[step.kind].ongoing) {
      advanceStep(squad, chain.length, order.loop);
      continue;
    }

    if (step.kind === 'move' || step.kind === 'attackmove') {
      if (!squad.dispatched) {
        dispatchTo(world, squad, step.x, step.z, mode);
        squad.dispatched = true;
      }
      if (squadArrived(world, squad, step.x, step.z)) {
        advanceStep(squad, chain.length, order.loop);
      }
      continue;
    }

    if (step.kind === 'gather') {
      // ongoing: put every worker in the squad on the nearest live node
      if (!squad.dispatched) {
        const node = nearestNodeWithResources(world, step.x, step.z);
        if (node) {
          const ids = ms.filter(u => u.gather).map(u => u.id);
          if (ids.length) assignGather(world, ids, node.id);
          // members that cannot gather just stand guard at the point
          for (const u of ms) {
            if (!u.gather) {
              u.orderMode = mode;
              u.target = clampPointToMapBoundary(
                mapBoundaryForSeed(world.mapSeed), step.x, step.z, u.radius,
              );
            }
          }
        }
        squad.dispatched = true;
      }
      // if the node ran out and no worker is still employed, fall through
      const stillWorking = ms.some(u => u.gather && u.gather.state !== 'idle');
      if (!stillWorking && !nearestNodeWithResources(world, step.x, step.z)) {
        advanceStep(squad, chain.length, order.loop);
      }
      continue;
    }

    if (step.kind === 'patrol') {
      // ongoing: pace between the previous step's point and this one
      if (!squad.patrolFrom || !squad.patrolTo) {
        const prev = chain[squad.index - 1];
        const c = squadCentre(world, squad);
        squad.patrolFrom = prev ? { x: prev.x, z: prev.z } : { x: c?.x ?? step.x, z: c?.z ?? step.z };
        squad.patrolTo = { x: step.x, z: step.z };
        squad.patrolHeading = 'to';
        dispatchTo(world, squad, squad.patrolTo.x, squad.patrolTo.z, mode);
      }
      const goal = squad.patrolHeading === 'to' ? squad.patrolTo : squad.patrolFrom;
      if (squadArrived(world, squad, goal.x, goal.z)) {
        squad.patrolHeading = squad.patrolHeading === 'to' ? 'from' : 'to';
        const next = squad.patrolHeading === 'to' ? squad.patrolTo : squad.patrolFrom;
        dispatchTo(world, squad, next.x, next.z, mode);
      }
    }
  }
}

/**
 * Stops any running chain that owns one of these units, and releases the squad
 * from the operation it was serving.
 *
 * This is what "runs unattended until redirected" (§4) means mechanically: a
 * manual order to a squad member takes the squad off automation rather than
 * fighting it. Releasing it from its mission as well is the same rule applied
 * one level up — otherwise the mission would re-issue its plan on the very next
 * tick and the hand-issued order would be silently undone. Putting the squad
 * back is one command either way: run the chain, or assign it again.
 */
export function stopSquadsContaining(world: World, unitIds: EntityId[]): void {
  for (const sq of world.squads) {
    if (!unitIds.some(id => sq.memberIds.includes(id))) continue;
    sq.running = false;
    for (const m of world.missions) {
      // Concluded missions keep their roster: it is a record of an order that
      // was given, not a live assignment.
      if (m.status !== 'active') continue;
      m.squadIds = m.squadIds.filter(id => id !== sq.id);
    }
  }
}
