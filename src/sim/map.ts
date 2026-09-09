import type { Team, UnitTypeKey, World } from '../core/types';
import { rngSeed } from '../core/rng';
import { OPENING } from '../data/tuning';
import { generateScenery, spawnBuilding, spawnResourceNode, spawnSquad } from './entities';
import { cmdGather, cmdSetRally } from './commands';
import { mapBoundaryForSeed, mapLayoutForBoundary } from './mapBoundary';

/**
 * Bump whenever map generation changes shape — different terrain, different
 * node placement, different scenery rules.
 *
 * A map seed alone is not enough to reproduce a map: the *generator* has to
 * match too. Without a version, changing the generator would silently make
 * every existing seed produce a different map, and old replays would play out
 * on terrain that no longer matches what was recorded. Versioning turns that
 * from a silent wrong answer into an explicit rejection.
 *
 * 7 — both sides now open with their workers already on the home cluster and a
 * gather rally standing at the base, so tick 0 of a seed is a different state
 * than it was. The ground is untouched, but a v6 replay would still desync: it
 * was recorded against a side that mined nothing for its first fifteen seconds.
 *
 * 6 — terrain amplitude raised so melee units can reach the high-ground
 * threshold at contact range (B-009). Every seed produces different ground.
 *
 * 4 — `terrainHeightAt` rebuilt from terms that are even under 180° rotation,
 * so height is symmetric between spawns (B-007). Every existing seed produces
 * different ground, which is exactly what this version guards.
 */
export const MAP_VERSION = 7;

/**
 * What a side starts the match holding.
 *
 * Named once rather than repeated at the call sites, so the type the worker
 * rally is set for is necessarily the type the starting workers were spawned
 * as. Those two drifting apart would leave every worker trained after the first
 * minute walking to a resource patch and standing next to it.
 */
const WORKER_TYPE: UnitTypeKey = 'worker';
const LINE_TYPE: UnitTypeKey = 'legionnaire';
const STARTING_WORKERS = 4;
const STARTING_ARMY = 4;

/**
 * Phase 1 seeded map (assumption A5). Boundary-derived and rotationally symmetric: rotate 180° about
 * the origin and the two sides match, satisfying §2's "maps are symmetric from
 * spawns, no spawn has an inherent advantage". Enforced by test, not by eye.
 */
export function buildTestMap(world: World): World {
  // Map generation draws from the map seed, kept entirely separate from the
  // match generator, so the same mapSeed always yields the same map regardless
  // of what the match does — and so previewing a map costs the match nothing.
  const mapRng = { rngState: rngSeed(world.mapSeed) };
  const boundary = mapBoundaryForSeed(world.mapSeed);
  const layout = mapLayoutForBoundary(boundary);

  spawnBuilding(world, 'standard', 'player', layout.playerBase.x, layout.playerBase.z);
  spawnBuilding(world, 'standard', 'rival', layout.rivalBase.x, layout.rivalBase.z);

  for (const n of layout.playerResources) spawnResourceNode(world, n.x, n.z);
  for (const n of layout.rivalResources) spawnResourceNode(world, n.x, n.z);

  spawnSquad(world, WORKER_TYPE, 'player',
    layout.playerWorkers.x, layout.playerWorkers.z, STARTING_WORKERS);
  spawnSquad(world, LINE_TYPE, 'player',
    layout.playerArmy.x, layout.playerArmy.z, STARTING_ARMY);
  spawnSquad(world, WORKER_TYPE, 'rival',
    layout.rivalWorkers.x, layout.rivalWorkers.z, STARTING_WORKERS);
  spawnSquad(world, LINE_TYPE, 'rival',
    layout.rivalArmy.x, layout.rivalArmy.z, STARTING_ARMY);

  openEconomy(world, 'player');
  openEconomy(world, 'rival');

  generateScenery(world, 26, mapRng);
  return world;
}

/**
 * Put a side to work at tick 0, and keep it working.
 *
 * §8.2 makes Cohort's worker identity **set-and-forget** — "one command sets a
 * full gather-return loop indefinitely, no drop-off babysitting". A match that
 * opens with four workers standing beside a resource patch waiting to be told
 * about it is the exact inverse of that promise, and it was not a small
 * blemish. Measured on seed 1337 before this existed: the player side banked
 * **zero** essence, trained nothing at all, and was overrun in two and a half
 * minutes without ever having played. The first thing a new player saw was a
 * still screen, and the game gave them no reason to believe it was running.
 *
 * This belongs to map setup rather than to the AI. §4's rule that "nothing runs
 * automatically until the player manually sets it up" governs the standing
 * orders a player writes — chains, missions, doctrine. It does not govern the
 * two clicks that open every RTS match ever shipped, and reading it that way
 * costs the game its first minute.
 *
 * Two halves, and it needs both. The starting workers go to the home cluster,
 * split across it so a side does not fall idle the instant one patch runs dry.
 * Then the base's worker rally is set to *the job* rather than to a place —
 * `stepProduction` treats a `gather` rally as a standing order, so every worker
 * trained for the rest of the match walks out and joins the loop with no
 * further input, and keeps working after that node is exhausted because
 * `stepGather` re-targets on arrival. A plain move rally would park them beside
 * the patch instead, which is the babysitting §8.2 exists to remove.
 *
 * Issued through the command layer rather than by writing gather state
 * directly, for the same reason the AI is (D-009): these are exactly the two
 * commands a player has, so the opening cannot drift into something a player
 * could not reproduce by hand.
 */
function openEconomy(world: World, team: Team): void {
  const base = world.buildings.find(b => b.team === team);
  if (!base) return;

  // Nearest first, ties broken by id so the choice never depends on array
  // order — two peers must derive the same opening from the same seed (D-010).
  const home = world.nodes
    .filter(n => n.amount > 0)
    .sort((a, b) =>
      Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z)
      || a.id - b.id)
    .slice(0, OPENING.startingNodes);
  if (!home.length) return;

  const workers = world.units.filter(u => u.team === team && u.gather);
  workers.forEach((u, i) => { cmdGather(world, [u.id], home[i % home.length]!.id); });

  const first = home[0]!;
  cmdSetRally(world, base.id, first.x, first.z,
    { unitType: WORKER_TYPE, kind: 'gather', targetId: first.id });
}
