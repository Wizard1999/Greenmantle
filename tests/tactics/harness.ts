import { createWorld, simStep } from '../../src/sim/world';
import { spawnUnit } from '../../src/sim/entities';
import type { Team, Unit, UnitTypeKey, World } from '../../src/core/types';

/**
 * Shared harness for the tactical-proof suite.
 *
 * `GAME_DESIGN.md` §2 makes a series of falsifiable claims — flanking decides
 * fights, high ground decides fights, setup beats modest numerical superiority,
 * crowding has legible diminishing returns, outcomes contain no hidden
 * randomness. Every one of them was asserted only in prose. This exists so each
 * can be written as a scenario that either passes or fails.
 *
 * None of it was measurable before 2026-08-06: a mirrored engagement resolved
 * 10–0 for whichever team entered `world.units` first (B-005), units could not
 * advance to contact at all (B-006), and terrain height was not symmetric
 * between spawns (B-007). A scenario suite built on top of any of those would
 * have been measuring the defect.
 *
 * **A failing scenario is a result, not a broken test.** If a claim does not
 * hold, the honest response is to report which mechanic fails to deliver it —
 * not to relax the assertion until it passes.
 */

export interface Placement {
  type: UnitTypeKey;
  team: Team;
  x: number;
  z: number;
  /** Direction the unit is looking, as `atan2(dx, dz)` — the same convention
   *  movement writes and `approachFrom` reads. Defaults to 0. */
  facing?: number;
}

export interface Outcome {
  ticks: number;
  survivors: Record<Team, number>;
  hp: Record<Team, number>;
  /** The side still standing, or null if both or neither remain. */
  winner: Team | null;
}

/** A world with no map, no economy and no AI — only the units placed. */
export function arena(placements: readonly Placement[], seed = 1337): World {
  const world = createWorld(seed, 8, seed);
  for (const p of placements) {
    const unit = spawnUnit(world, p.type, p.team, p.x, p.z);
    if (p.facing !== undefined) unit.facing = p.facing;
  }
  return world;
}

/** A line of units along z, centred on the origin. */
export function line(
  type: UnitTypeKey, team: Team, count: number, x: number,
  opts: { spacing?: number; facing?: number; zOffset?: number } = {},
): Placement[] {
  const spacing = opts.spacing ?? 1;
  const out: Placement[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      type, team, x,
      z: (i - (count - 1) / 2) * spacing + (opts.zOffset ?? 0),
      ...(opts.facing === undefined ? {} : { facing: opts.facing }),
    });
  }
  return out;
}

const teams: Team[] = ['player', 'rival'];

export function tally(world: World): Omit<Outcome, 'ticks'> {
  const survivors = { player: 0, rival: 0 } as Record<Team, number>;
  const hp = { player: 0, rival: 0 } as Record<Team, number>;
  for (const unit of world.units) {
    survivors[unit.team]++;
    hp[unit.team] += unit.hp;
  }
  const alive = teams.filter(t => survivors[t] > 0);
  return { survivors, hp, winner: alive.length === 1 ? alive[0]! : null };
}

/** Run until one side is gone or the tick budget expires. */
export function fightOut(world: World, maxTicks = 5400): Outcome {
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    simStep(world);
    if (world.units.every(u => u.team === 'player') || world.units.every(u => u.team === 'rival')) break;
  }
  return { ticks, ...tally(world) };
}

/**
 * How decisively `team` won, from -1 (annihilated) to +1 (untouched victory).
 *
 * Expressed as a share of surviving health rather than a body count, so a fight
 * won with every survivor at one hit point does not score the same as a clean
 * sweep. §2 asks for battles that resolve decisively; this is the number that
 * says whether they do.
 */
export function margin(outcome: Outcome, team: Team = 'player'): number {
  const other: Team = team === 'player' ? 'rival' : 'player';
  const total = outcome.hp[team] + outcome.hp[other];
  if (total === 0) return 0;
  return (outcome.hp[team] - outcome.hp[other]) / total;
}

/** Every unit of a team, for scenarios that need to inspect or order them. */
export function unitsOf(world: World, team: Team): Unit[] {
  return world.units.filter(u => u.team === team);
}
