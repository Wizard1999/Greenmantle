import type { Team, Unit, World } from '../src/core/types';
import { createWorld, simStep } from '../src/sim/world';
import { buildTestMap } from '../src/sim/map';

/** Narrow away `undefined` from array/lookup access without scattering
 *  non-null assertions through the suites. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

export const freshMap = (seed = 1337): World => buildTestMap(createWorld(seed));

/**
 * A test map with no hostile army.
 *
 * `freshMap` places both sides' armies, and until B-006 was fixed those armies
 * could not reach each other: units acquired targets at range 9 and never
 * closed, so a lone worker could stroll to a build site at the middle of the
 * map unmolested. Now it is hunted and killed on the way — correct behaviour,
 * and a terrible fixture for a suite about construction.
 *
 * Use this whenever the subject under test is *not* combat. Keeping the rival
 * base and workers means supply, victory and drop-off logic still see a normal
 * two-player world; only the thing that shoots is absent.
 */
export const peacefulMap = (seed = 1337): World => {
  const world = freshMap(seed);
  world.units = world.units.filter(u => u.team === 'player' || u.gather !== null);
  return world;
};

export const run = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) simStep(w);
};

/**
 * A build spot a short walk from the player's Standard.
 *
 * Suites used to name a fixed world coordinate like `(-2, 6)`, which sat beside
 * the base only because the whole board was 39 units across. When the map grew
 * to 156 (D-038) that same point landed roughly seventy units away and every
 * construction test failed, because the worker could not walk there inside the
 * tick budget. Where a test builds is incidental to what it is testing; that it
 * is reachable is not.
 */
export const buildSpotNearBase = (w: World, team: Team = 'player'): { x: number; z: number } => {
  const base = w.buildings.find(b => b.team === team && b.type === 'standard');
  if (!base) throw new Error('no Standard to build near');
  return { x: base.x + 6, z: base.z + 6 };
};

export const workersOf = (w: World, team: Team): Unit[] =>
  w.units.filter(u => u.team === team && u.gather);

export const gatherOf = (u: Unit) => must(u.gather, 'gather job');
export const buildOf = (u: Unit) => must(u.build, 'build job');
