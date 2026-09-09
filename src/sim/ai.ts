import type {
  AiState, Building, EntityId, ResourceNode, Team, Unit, UnitTypeKey, Vec2, World,
} from '../core/types';
import { AI, SUPPLY_MAX } from '../data/tuning';
import { BUILDING_TYPES } from '../data/buildings';
import { UNIT_TYPES } from '../data/units';
import { cmdAttackMove, cmdGather, cmdPlaceBuilding, cmdSetRally, cmdTrain } from './commands';
import { findTarget } from './combat';
import { supplyCap, supplyFree } from './supply';
import { availableTech, cmdResearch } from './tech';
import { TECH } from '../data/tech';
import { circleInMapBoundary, clampPointToMapBoundary, mapBoundaryForSeed } from './mapBoundary';

/**
 * A simple AI opponent (step 1.11).
 *
 * Deliberately "simple, not necessarily smart" per the Phase 1 scope. Its value
 * right now is not being a worthy opponent — it is being *something to play
 * against*, and being a continuous integration test of the systems it drives.
 * If the AI stops gathering, gathering is broken; if it stops attacking, target
 * acquisition is broken. That is worth more in Phase 1 than cleverness.
 *
 * Two rules it must keep obeying as it grows (D-009):
 *
 * 1. **It issues the same commands a human does**, through `sim/commands.ts`.
 *    No privileged mutation of world state, no reaching past the command layer.
 *    That keeps it honest, keeps it replayable, and means anything it can do a
 *    player could also do.
 * 2. **It reads only what it could legitimately see.** There is no fog of war
 *    yet, so this is currently on trust — when fog arrives, this is the file
 *    that has to start respecting it rather than a thing to bolt on afterwards.
 *
 * It runs on a slow cadence rather than every tick: it has no reflexes to
 * exercise, and thinking 30 times a second would cost real time at 100+ units
 * for no behavioural gain.
 *
 * **It no longer names a unit.** Army composition is read off the roster of the
 * building it produces from, and the worker is whichever entry declares
 * `isWorker`. That closes the one exception D-029 recorded against itself: a
 * race swapped in wholesale is now played by this file without editing it,
 * because the file holds no opinion about what a Legionnaire is.
 */

export function createAi(team: Team): AiState {
  return { team, nextThinkTick: 0, attacking: false };
}

/** Give a world an AI opponent. Opt-in, so a bare world stays inert. */
export function enableAi(world: World, team: Team = 'rival'): World {
  world.ai = createAi(team);
  return world;
}

function myUnits(world: World, team: Team): Unit[] {
  return world.units.filter(u => u.team === team && u.hp > 0);
}

/**
 * The building the AI produces from: the first one whose roster contains
 * something that is not a worker, falling back to any building it holds.
 *
 * Previously this was `buildings.find(b => b.team === team)` — the team's first
 * building, which is the Standard only by the accident of having been spawned
 * first. Lose the Standard with an Outpost still standing and every army order
 * would have gone to a building that produces workers and nothing else, so
 * `cmdTrain` would refuse forever and the AI would sit on its essence.
 */
function producerFor(world: World, team: Team): Building | null {
  let fallback: Building | null = null;
  for (const b of world.buildings) {
    if (b.team !== team) continue;
    fallback ??= b;
    if (BUILDING_TYPES[b.type].produces.some(k => !UNIT_TYPES[k].isWorker)) return b;
  }
  return fallback;
}

/** Live nodes, nearest first, ties by id so array order cannot decide (D-010). */
function nearestNodes(world: World, x: number, z: number, count: number): ResourceNode[] {
  return world.nodes
    .filter(n => n.amount > 0)
    .sort((a, b) =>
      Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z) || a.id - b.id)
    .slice(0, count);
}

/**
 * One decision pass. Cheap, greedy, and ordered by priority: keep the economy
 * running, then build an army, then commit it.
 */
export function stepAi(world: World, ai: AiState): void {
  if (world.winner) return;
  if (world.tick < ai.nextThinkTick) return;
  ai.nextThinkTick = world.tick + AI.thinkInterval;

  const units = myUnits(world, ai.team);
  const workers = units.filter(u => u.gather);
  const fighters = units.filter(u => !u.gather);
  const base = producerFor(world, ai.team);
  if (!base) return;

  // 1. Idle workers go and gather. This is the whole economy: set-and-forget
  //    (§8.2) means an idle worker is always a mistake, never a decision.
  //    Excluding anyone already assigned to a build site: cmdAssignBuilders
  //    parks a builder's gather job in 'idle', so without this check the AI
  //    would re-task its own builder back to mining on the very next think and
  //    no construction would ever finish.
  //
  //    Split across the nearest few patches rather than piled onto one. A patch
  //    holds `ECON.nodeCapacity` and a full crew strips it inside a couple of
  //    minutes, at which point every worker walks to the same replacement
  //    together and the whole economy takes the travel hit in one step.
  const idle = workers.filter(u =>
    (!u.gather || u.gather.state === 'idle') && !u.build?.siteId);
  if (idle.length) {
    const patches = nearestNodes(world, base.x, base.z, AI.gatherNodes);
    if (patches.length) {
      idle.forEach((u, i) => { cmdGather(world, [u.id], patches[i % patches.length]!.id); });
    }
  }

  // 2. Expand supply before it becomes the binding constraint.
  //
  //    Command gates population, control range and automation together (§8.1),
  //    so an AI that never builds simply stops: its starting Standard provides
  //    just enough Command for its starting army, and it then banks essence
  //    forever with a full supply bar. Outposts are the only way out.
  const capped = supplyFree(world, ai.team) <= AI.expandAtSupplyFree;
  const roomToGrow = supplyCap(world, ai.team) < SUPPLY_MAX;
  const building = world.sites.some(st => st.team === ai.team);
  if (capped && roomToGrow && !building && workers.length > 1) {
    const spot = expansionSpot(world, ai.team, base);
    if (spot) {
      // Send one worker, not the whole economy — construction is a flat rate
      // regardless of how many are assigned (§8.1), so extra builders are
      // pure economic loss.
      const builder = workers.filter(u => !u.build?.siteId).at(-1);
      cmdPlaceBuilding(world, ai.team, 'outpost', spot.x, spot.z,
                       builder ? [builder.id] : []);
    }
  }

  // 3. Keep producing. Workers until the economy is staffed, then army.
  //    Training is attempted rather than gated on affordability: cmdTrain
  //    already validates, and letting it refuse is simpler than duplicating
  //    the cost rules here where they would drift out of sync.
  //
  //    What to build comes off the producing building's own roster, so this
  //    file names no unit (D-029). The army cycles evenly through whatever
  //    fighting types that building offers: an even mix is the only defensible
  //    default for an engine that cannot know what any of them do, and a fixed
  //    ratio here would be one race's counter-play encoded inside `sim/`.
  const roster = BUILDING_TYPES[base.type].produces;
  const workerType = roster.find(k => UNIT_TYPES[k].isWorker);
  const fighterTypes = roster.filter(k => !UNIT_TYPES[k].isWorker);
  const next: UnitTypeKey | undefined = workerType && workers.length < AI.targetWorkers
    ? workerType
    : fighterTypes[fighters.length % Math.max(fighterTypes.length, 1)];
  if (next && base.queue.length < AI.maxQueueDepth) {
    cmdTrain(world, base.id, next);
  }

  // 4. Research whatever is affordable and reachable.
  //
  //    Without this the AI falls permanently behind any human who techs, since
  //    upgrades are category-wide multipliers that compound. It picks the
  //    cheapest available option rather than planning a build: Cohort's track
  //    is deliberately forgiving (§8.5, D-028), so researching in cost order is
  //    a genuinely reasonable strategy rather than a placeholder.
  if (!world.tech[ai.team].researching) {
    const options = availableTech(world, ai.team)
      .filter(id => TECH[id].cost <= world.resources[ai.team] - AI.techReserve)
      .sort((a, b) => TECH[a].cost - TECH[b].cost || (a < b ? -1 : 1));
    const pick = options[0];
    if (pick) cmdResearch(world, ai.team, pick);
  }

  commandArmy(world, ai, base, fighters, fighterTypes);
}

/**
 * The army, in waves.
 *
 * The previous version had one rule — commit at `attackAtArmySize`, stay
 * committed until the last fighter is dead — and three consequences followed
 * from it, all of them visible in a headless match.
 *
 * **It never advanced to contact.** The assault went out as `cmdMove`, and
 * `stepPursuit` explicitly refuses to divert a unit under a move order, because
 * a named destination is a promise the player made. So the army walked to a
 * coordinate through everything in its path and shot only what strayed inside
 * weapon reach — 0.9 for the melee line against an acquire range of 9.
 * `cmdAttackMove` is the order that means "engage along the route", and it is
 * what an assault should always have carried.
 *
 * **It fed itself in piecemeal.** Every 15 ticks it re-ordered *all* unengaged
 * fighters at the objective, so each unit trained during a push left the base
 * alone and crossed the map alone into an intact enemy army. One boolean fixes
 * that without adding state a snapshot would have to carry (D-010): the wave
 * ends when the army is spent rather than when it is extinct, and the survivors
 * mass with new production until they are worth committing again. The match
 * gains a rhythm — build, push, break, rebuild — which is also what makes it
 * legible to somebody watching it rather than playing it.
 *
 * **It did not defend.** An enemy inside its own base did not interrupt an
 * attack already in progress, so both sides could walk past each other and race
 * to raze an empty home. Defence is a derived override rather than a fourth
 * state: anything hostile within `AI.defendRadius` of anything the AI owns
 * becomes the objective, whatever the wave was doing.
 *
 * New fighters are pointed at the staging area by a rally rather than an order,
 * so they walk to the front on their own and this only ever has to talk to
 * stragglers. The staging point is derived from the line between the two bases.
 * The old rally was `base.x + (base.x < 0 ? 4 : -4)`, which assumed the two
 * spawns straddle the origin along X, and was four units on a board 260 across
 * (D-038 — nothing outside `data/` may assume the map).
 */
function commandArmy(
  world: World, ai: AiState, base: Building, fighters: Unit[], types: readonly UnitTypeKey[],
): void {
  const staging = stagingPoint(world, ai.team, base);
  for (const t of types) {
    cmdSetRally(world, base.id, staging.x, staging.z, { unitType: t });
  }

  // Commit on a full wave, or earlier on a decisive advantage. The second rule
  // is what stops the AI banking units against an opponent who has stopped
  // building: a fixed threshold makes it wait for a wave it does not need,
  // which reads as an opponent that is ignoring you. Floored, so "ahead" never
  // means two units against one.
  const opposition = enemyFighters(world, ai.team);
  const ahead = fighters.length >= opposition + AI.attackAdvantage
    && fighters.length >= AI.attackMinArmySize;
  if (!ai.attacking && (fighters.length >= AI.attackAtArmySize || ahead)) ai.attacking = true;
  if (ai.attacking && fighters.length <= AI.regroupAtArmySize) ai.attacking = false;

  // Anything hostile standing in its own territory outranks the wave.
  const threat = threatToHome(world, ai.team);
  if (threat) {
    const free = fighters.filter(u => findTarget(world, u) === null);
    if (free.length) cmdAttackMove(world, free.map(u => u.id), threat.x, threat.z);
    return;
  }

  // The home guard: the fighters standing nearest the base never join a push.
  // Emptying the base to attack loses to the counterattack it invites, and that
  // is precisely how the mirror match resolved before this existed — both
  // armies met in the middle of the board, and whoever had two units left
  // walked into an economy with nothing in front of it. Derived from position
  // each think rather than remembered, so it costs the snapshot nothing (D-010)
  // and the guard is always whoever is actually closest to home.
  const nearestFirst = [...fighters].sort((a, b) =>
    Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z)
    || a.id - b.id);
  const guard = new Set(nearestFirst.slice(0, AI.garrisonSize).map(u => u.id));

  const objective = ai.attacking ? pickObjective(world, ai.team) : null;
  if (objective) {
    // Only redirect units that are not already busy fighting something, so an
    // ordered advance does not repeatedly interrupt an ongoing fight.
    const free = fighters.filter(u => !guard.has(u.id) && findTarget(world, u) === null);
    if (free.length) cmdAttackMove(world, free.map(u => u.id), objective.x, objective.z);
  }

  // Everyone not in the assault masses. Slack, so it is not re-ordering a
  // stationary army twice a second — and attack-move rather than move, so a
  // unit that walks into something on the way to the staging area fights it
  // instead of ignoring it.
  const holding = objective ? fighters.filter(u => guard.has(u.id)) : fighters;
  const stragglers = holding.filter(u =>
    findTarget(world, u) === null
    && Math.hypot(u.x - staging.x, u.z - staging.z) > AI.rallySlack);
  if (stragglers.length) {
    cmdAttackMove(world, stragglers.map(u => u.id), staging.x, staging.z);
  }
}

/**
 * Everything hostile that is not a worker.
 *
 * Read straight off the world, which is the same trust the objective picker
 * already runs on: there is no fog of war in the simulation yet, so this file
 * is on its honour until there is (D-009). When fog lands, this is one of the
 * two places that has to start asking what the AI has actually seen.
 */
function enemyFighters(world: World, team: Team): number {
  let n = 0;
  for (const u of world.units) {
    if (u.team === team || u.hp <= 0) continue;
    if (!UNIT_TYPES[u.type].isWorker) n++;
  }
  return n;
}

/** Where the army gathers between pushes: in front of the base, on the line
 *  toward the enemy, so a wave forms already facing the way it will go. */
function stagingPoint(world: World, team: Team, base: Building): Vec2 {
  const enemy = nearestEnemyBuilding(world, team, base.x, base.z);
  const dx = enemy ? enemy.x - base.x : 0;
  const dz = enemy ? enemy.z - base.z : 1;
  const mag = Math.hypot(dx, dz) || 1;
  return clampPointToMapBoundary(
    mapBoundaryForSeed(world.mapSeed),
    base.x + (dx / mag) * AI.stagingDistance,
    base.z + (dz / mag) * AI.stagingDistance,
    1.0,
  );
}

/**
 * The nearest enemy standing inside the AI's own territory, if any.
 *
 * Measured from every building it holds rather than from the Standard alone, so
 * a raid on an expansion is answered too — losing the Outposts one at a time
 * while the army is away is how a defended base loses anyway.
 */
function threatToHome(world: World, team: Team): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  let bestId = 0;
  for (const u of world.units) {
    if (u.team === team || u.hp <= 0) continue;
    let d = Infinity;
    for (const b of world.buildings) {
      if (b.team !== team) continue;
      d = Math.min(d, Math.hypot(u.x - b.x, u.z - b.z) - b.radius);
    }
    if (d > AI.defendRadius) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && u.id < bestId)) {
      best = { x: u.x, z: u.z };
      bestD = d;
      bestId = u.id;
    }
  }
  return best;
}

/**
 * Where to put the next Outpost.
 *
 * §8.1 gives Cohort a **methodical** expansion philosophy — "road, then
 * outpost, then permanently held" — and an Outpost is a drop-off as well as
 * eight more Command, so the two halves of the decision are the same decision.
 * This tries an unworked resource patch first and only falls back to ringing
 * the base when there is none in reach.
 *
 * The old version only ever ringed the base, and the cost of that was the
 * middle of every match. The home cluster is two patches (B-008) holding
 * `ECON.nodeCapacity` apiece; a full crew strips them inside three minutes and
 * then walks forty to sixty units each way to the next one, at which point
 * income roughly halves and both sides stop being able to replace losses. The
 * game was then decided by whichever army happened to be alive when that
 * happened, which is why matches resolved in a third of §3's window with more
 * than a third of the map's essence still in the ground.
 *
 * Deterministic by construction — it walks a fixed ring of candidate angles and
 * takes the first that fits, rather than sampling randomly. Two peers must pick
 * the same spot from the same state (D-010), and it keeps the AI off the RNG.
 */
function expansionSpot(world: World, team: Team, base: Building): Vec2 | null {
  const target = unworkedNode(world, team, base);
  if (target) {
    const spot = clearSpotNear(world, target.x, target.z, AI.expandNodeStandoff);
    if (spot) return spot;
  }
  return clearSpotNear(world, base.x, base.z, AI.expandMinRadius);
}

/**
 * The nearest live patch with no friendly drop-off near it.
 *
 * "Near" is `AI.expandNodeRange` rather than a hauling-cost model: a worker
 * already walks to whatever is closest, so the only question worth asking is
 * whether this patch has somewhere to unload at all.
 */
function unworkedNode(world: World, team: Team, base: Building): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bestD = Infinity;
  for (const n of world.nodes) {
    if (n.amount <= 0) continue;
    const covered = world.buildings.some(b =>
      b.team === team && BUILDING_TYPES[b.type].dropoff
      && Math.hypot(b.x - n.x, b.z - n.z) <= AI.expandNodeRange);
    if (covered) continue;
    const claimed = world.sites.some(st =>
      Math.hypot(st.x - n.x, st.z - n.z) <= AI.expandNodeRange);
    if (claimed) continue;
    const d = Math.hypot(n.x - base.x, n.z - base.z);
    if (d > AI.expandReach) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && n.id < best.id)) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** First point on an expanding ring around (cx, cz) that a building fits on. */
function clearSpotNear(world: World, cx: number, cz: number, from: number): Vec2 | null {
  for (let ring = 0; ring < AI.expandRings; ring++) {
    const r = from + ring * AI.expandRingStep;
    for (let i = 0; i < AI.expandAngles; i++) {
      const a = (i / AI.expandAngles) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!circleInMapBoundary(mapBoundaryForSeed(world.mapSeed), x, z, 4.5)) continue;
      const clearOfBuildings = world.buildings.every(b => Math.hypot(b.x - x, b.z - z) > b.radius + 4);
      const clearOfSites = world.sites.every(st => Math.hypot(st.x - x, st.z - z) > st.radius + 4);
      const clearOfNodes = world.nodes.every(n => Math.hypot(n.x - x, n.z - z) > 4);
      if (clearOfBuildings && clearOfSites && clearOfNodes) return { x, z };
    }
  }
  return null;
}

/** Nearest enemy building to a point, ties by id (D-010). */
function nearestEnemyBuilding(
  world: World, team: Team, x: number, z: number,
): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of world.buildings) {
    if (b.team === team) continue;
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && b.id < best.id)) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * What to attack: the nearest enemy building, since the win condition is pure
 * base destruction (§2). Falls back to the nearest enemy unit so an army with
 * nothing left to siege still does something.
 */
function pickObjective(world: World, team: Team): { x: number; z: number } | null {
  const origin = world.buildings.find(b => b.team === team);
  const ox = origin?.x ?? 0;
  const oz = origin?.z ?? 0;

  const target = nearestEnemyBuilding(world, team, ox, oz);
  if (target) return { x: target.x, z: target.z };

  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const u of world.units) {
    if (u.team === team || u.hp <= 0) continue;
    const d = Math.hypot(u.x - ox, u.z - oz);
    if (d < bestD) { bestD = d; best = { x: u.x, z: u.z }; }
  }
  return best;
}

/** Ids of everything the AI commands — used by tests and debug overlays. */
export function aiUnitIds(world: World, ai: AiState): EntityId[] {
  return myUnits(world, ai.team)
    .filter(u => !UNIT_TYPES[u.type].isWorker)
    .map(u => u.id);
}
