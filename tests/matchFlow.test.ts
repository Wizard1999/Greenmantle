import { describe, expect, it } from 'vitest';
import type { Team, UnitTypeKey, World } from '../src/core/types';
import { createWorld, simStep } from '../src/sim/world';
import { buildTestMap } from '../src/sim/map';
import { createAi, enableAi, stepAi } from '../src/sim/ai';
import { cmdTrain, rallyFor } from '../src/sim/commands';
import { totalResourcesRemaining } from '../src/sim/economy';
import { UNIT_TYPES } from '../src/data/units';
import { ECON } from '../src/data/tuning';
import { freshMap, gatherOf, must, run, workersOf } from './helpers';

/**
 * A match, end to end.
 *
 * The two things a demo has to be able to show — that the game starts playing
 * itself the moment it is opened, and that it finishes — measured rather than
 * asserted in the abstract. Before this suite existed, a real match on seed
 * 1337 had the player side bank zero essence across twenty simulated minutes
 * and never issue an order, because nothing had ever put its workers to work.
 */

const WORKER = (Object.keys(UNIT_TYPES) as UnitTypeKey[])
  .find(k => UNIT_TYPES[k].isWorker)!;

const TEAMS: Team[] = ['player', 'rival'];

describe('the opening runs itself (§8.2)', () => {
  const w = freshMap(1337);

  for (const team of TEAMS) {
    it(`every ${team} worker is already gathering at tick 0`, () => {
      const crew = workersOf(w, team);
      expect(crew.length).toBeGreaterThan(0);
      expect(crew.filter(u => gatherOf(u).state === 'idle')).toHaveLength(0);
    });

    it(`the ${team} crew is split across the home cluster`, () => {
      // One patch would idle the whole side the moment it ran dry.
      const nodes = new Set(workersOf(w, team).map(u => gatherOf(u).nodeId));
      expect(nodes.size).toBeGreaterThan(1);
    });

    it(`the ${team} base rallies new workers into the same loop`, () => {
      const base = must(w.buildings.find(b => b.team === team), 'base');
      expect(rallyFor(base, WORKER).kind).toBe('gather');
    });
  }

  it('essence arrives without a single command being issued', () => {
    const world = freshMap(1337);
    run(world, 900);   // 30 seconds
    expect(world.resources.player).toBeGreaterThan(0);
    expect(world.resources.rival).toBeGreaterThan(0);
  });

  it('the two sides open level', () => {
    // §2: no spawn has an inherent advantage, and the opening is part of the
    // spawn. A one-sided opening would be worth more than any map asymmetry.
    //
    // Not exact, and the residue is not this file's. `economy.ts` gives each
    // worker its own parking slot at an angle derived from its entity id, so
    // the two crews — which necessarily hold different ids — walk fractionally
    // different distances. Measured at 30 seconds on seed 1337: 135 against
    // 125, two loads apart out of roughly seventeen. Real, small, and in a file
    // this change does not own; the tolerance is a few trips rather than none
    // so that a genuinely one-sided opening still fails here.
    const world = freshMap(1337);
    run(world, 900);
    const gap = Math.abs(world.resources.player - world.resources.rival);
    expect(gap).toBeLessThanOrEqual(4 * ECON.carryAmount);
    expect(world.resources.player).toBeGreaterThan(0);
  });
});

describe('a worker trained later needs no instruction either', () => {
  const w = freshMap(1337);
  const base = must(w.buildings.find(b => b.team === 'player'), 'player base');
  const before = workersOf(w, 'player').length;
  w.resources.player = 500;
  cmdTrain(w, base.id, WORKER);
  run(w, UNIT_TYPES[WORKER].buildTicks + 30);

  it('it exists', () => {
    expect(workersOf(w, 'player').length).toBe(before + 1);
  });

  it('and it walked out to work rather than standing at the rally point', () => {
    const newest = must(workersOf(w, 'player').at(-1), 'new worker');
    expect(gatherOf(newest).state).not.toBe('idle');
  });
});

describe('the loop survives its own patch running out', () => {
  it('a rallied worker re-targets when the node it was sent to is empty', () => {
    // This is what makes the rally a standing *job* rather than a destination.
    const w = freshMap(1337);
    const base = must(w.buildings.find(b => b.team === 'player'), 'player base');
    const rallied = must(rallyFor(base, WORKER).targetId, 'rally node');
    must(w.nodes.find(n => n.id === rallied), 'node').amount = 0;

    w.resources.player = 500;
    cmdTrain(w, base.id, WORKER);
    run(w, UNIT_TYPES[WORKER].buildTicks + 600);

    const newest = must(workersOf(w, 'player').at(-1), 'new worker');
    expect(gatherOf(newest).state).not.toBe('idle');
    expect(gatherOf(newest).nodeId).not.toBe(rallied);
  });
});

describe('nothing is created or destroyed while both sides mine', () => {
  const w = freshMap(1337);
  const onMap = totalResourcesRemaining(w);
  run(w, 1500);
  const carried = w.units
    .filter(u => u.gather)
    .reduce((sum, u) => sum + gatherOf(u).carrying, 0);

  it('banked + carried + remaining == starting total', () => {
    expect(w.resources.player + w.resources.rival + carried + totalResourcesRemaining(w))
      .toBe(onMap);
  });

  it('every banked trip is a whole number of loads', () => {
    expect(w.resources.player % ECON.carryAmount).toBe(0);
  });
});

/**
 * Both sides played by the same opponent.
 *
 * The only self-playing measurement available: `World` carries one AI, so the
 * second is driven from here exactly as a human would drive it — through
 * `stepAi`, which issues nothing but commands (D-009). It is not a fair mirror
 * to the tick, because the side stepped first each tick sees the other's
 * orders a moment late, so this asserts that a match *finishes*, not who wins.
 */
function mirrorMatch(seed: number, ticks: number): { world: World; tick: number } {
  const world = buildTestMap(createWorld(seed, 8, seed));
  world.ai = createAi('rival');
  const playerAi = createAi('player');
  for (let t = 0; t < ticks && !world.winner; t++) {
    stepAi(world, playerAi);
    simStep(world);
  }
  return { world, tick: world.tick };
}

describe('a match ends', () => {
  const BUDGET = 30 * 60 * 30;   // 30 simulated minutes

  for (const seed of [1337, 7, 2024]) {
    it(`seed ${seed} reaches a winner`, () => {
      const { world, tick } = mirrorMatch(seed, BUDGET);
      expect(world.winner).not.toBeNull();
      // §3 targets 10–15 minutes. Measured at the time of writing: 7.6–9.8
      // minutes across twelve seeds. The bound here is deliberately loose —
      // it is guarding against a match that never resolves, which is what this
      // suite was written for, not against the pacing drifting by a minute.
      expect(tick).toBeLessThan(BUDGET);
      expect(tick).toBeGreaterThan(3 * 60 * 30);
    }, 60_000);
  }

  it('a side that never plays loses, and does not take all day about it', () => {
    // The opening gathers, but nobody trains anything: an idle opponent should
    // be beaten, and beaten within the match length, or the AI is not applying
    // any pressure at all.
    const w = enableAi(freshMap(1337));
    for (let t = 0; t < 30 * 60 * 30 && !w.winner; t++) simStep(w);
    expect(w.winner).toBe('rival');
    expect(w.resources.player).toBeGreaterThan(0);   // it did gather, all the same
  }, 60_000);
});
