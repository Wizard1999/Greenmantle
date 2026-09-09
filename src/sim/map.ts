import type { World } from '../core/types';
import { rngSeed } from '../core/rng';
import { generateScenery, spawnBuilding, spawnResourceNode, spawnSquad } from './entities';
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
 * 6 — terrain amplitude raised so melee units can reach the high-ground
 * threshold at contact range (B-009). Every seed produces different ground.
 *
 * 4 — `terrainHeightAt` rebuilt from terms that are even under 180° rotation,
 * so height is symmetric between spawns (B-007). Every existing seed produces
 * different ground, which is exactly what this version guards.
 */
export const MAP_VERSION = 6;

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

  spawnSquad(world, 'worker', 'player', layout.playerWorkers.x, layout.playerWorkers.z, 4);
  spawnSquad(world, 'legionnaire', 'player', layout.playerArmy.x, layout.playerArmy.z, 4);
  spawnSquad(world, 'worker', 'rival', layout.rivalWorkers.x, layout.rivalWorkers.z, 4);
  spawnSquad(world, 'legionnaire', 'rival', layout.rivalArmy.x, layout.rivalArmy.z, 4);

  generateScenery(world, 26, mapRng);
  return world;
}
