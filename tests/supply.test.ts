import { describe, it, expect } from 'vitest';
import { peacefulMap, must, run, workersOf } from './helpers';
import {
  cmdCancelTrain, cmdGather, cmdPlaceBuilding, cmdTrain,
} from '../src/sim/commands';
import { canPlaceBuilding } from '../src/sim/construction';
import { isInControl, supplyCap, supplyUsed } from '../src/sim/supply';
import { nearestDropoff } from '../src/sim/economy';
import { BUILDING_TYPES } from '../src/data/buildings';
import type { World } from '../src/core/types';

function remoteBuildablePoint(w: World): { x: number; z: number } {
  for (let distance = 30; distance >= 12; distance -= 2) {
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const angle = degrees * Math.PI / 180;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      if (!isInControl(w, 'player', x, z)
        && canPlaceBuilding(w, 'player', 'outpost', x, z).ok) {
        return { x, z };
      }
    }
  }
  throw new Error('expected a remote buildable point inside the generated map');
}
import { UNIT_TYPES } from '../src/data/units';
import { MAX_QUEUE } from '../src/data/tuning';

// [14] Command supply â€” cap, cost, and enforcement (1.5)
describe('[14] Command supply', () => {
  const w = peacefulMap();
  const base = must(w.buildings.find(b => b.team === 'player'));
  const capFromStructures = supplyCap(w, 'player');
  const startUsed = supplyUsed(w, 'player');

  w.resources.player = 10000;
  const before = w.resources.player;
  const trained = cmdTrain(w, base.id, 'worker');
  const afterTrainEssence = w.resources.player;
  const usedAfterQueue = supplyUsed(w, 'player');

  // fill to the cap
  let guard = 0;
  while (cmdTrain(w, base.id, 'worker').ok && guard++ < 50) { /* fill */ }
  const refused = cmdTrain(w, base.id, 'worker');

  it('cap comes from Command structures', () => {
    expect(capFromStructures).toBe(BUILDING_TYPES.standard.command);
  });
  it('starting units consume supply', () => {
    expect(startUsed).toBe(4 * UNIT_TYPES.worker.supply + 4 * UNIT_TYPES.legionnaire.supply);
  });
  it('training deducts essence', () => {
    expect(trained.ok).toBe(true);
    expect(afterTrainEssence).toBe(before - UNIT_TYPES.worker.cost);
  });
  it('queued units count against the cap immediately', () => {
    expect(usedAfterQueue).toBe(startUsed + UNIT_TYPES.worker.supply);
  });
  it('training is refused at the cap', () => {
    expect(refused.reason).toBe('not enough Command');
  });
  it('never exceeds the cap', () => {
    expect(supplyUsed(w, 'player')).toBeLessThanOrEqual(supplyCap(w, 'player'));
  });
});

// [15] production queue
describe('[15] production queue', () => {
  const w = peacefulMap();
  const base = must(w.buildings.find(b => b.team === 'player'));
  w.resources.player = 10000;
  const unitsBefore = w.units.length;
  cmdTrain(w, base.id, 'worker');
  run(w, UNIT_TYPES.worker.buildTicks - 1);
  const countJustBefore = w.units.length;
  run(w, 1);
  const countOnSchedule = w.units.length;
  const fresh = must(w.units[w.units.length - 1]);

  for (let i = 0; i < MAX_QUEUE + 3; i++) cmdTrain(w, base.id, 'worker');
  const queueDepth = base.queue.length;

  const essenceBefore = w.resources.player;
  cmdCancelTrain(w, base.id, 0);

  it('unit has not appeared early', () => expect(countJustBefore).toBe(unitsBefore));
  it('unit appears on schedule', () => expect(countOnSchedule).toBe(unitsBefore + 1));
  it('spawns on the correct team', () => expect(fresh.team).toBe('player'));
  it('walks to the rally point', () => expect(fresh.target).not.toBeNull());
  it('queue depth is capped', () => expect(queueDepth).toBeLessThanOrEqual(MAX_QUEUE));
  it('cancelling refunds in full', () => {
    expect(w.resources.player).toBe(essenceBefore + UNIT_TYPES.worker.cost);
  });
});

// [16] outpost placement
describe('[16] outpost placement', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const base = must(w.buildings.find(b => b.team === 'player'));
  const capBefore = supplyCap(w, 'player');
  const onStructure = canPlaceBuilding(w, 'player', 'outpost', base.x + 0.5, base.z);
  const onNode = canPlaceBuilding(w, 'player', 'outpost', must(w.nodes[0]).x, must(w.nodes[0]).z);
  const offMap = canPlaceBuilding(w, 'player', 'outpost', 999, 0);
  const remote = remoteBuildablePoint(w);
  const farAway = canPlaceBuilding(w, 'player', 'outpost', remote.x, remote.z);
  const res = cmdPlaceBuilding(w, 'player', 'outpost', remote.x, remote.z);

  const poor = peacefulMap();
  poor.resources.player = 0;

  it('cannot place on top of an existing structure', () => expect(onStructure.ok).toBe(false));
  it('cannot place on an essence node', () => expect(onNode.ok).toBe(false));
  it('cannot place off the map', () => expect(offMap.ok).toBe(false));
  it('CAN place far from home â€” Cohort walks, it does not project (A7)', () => {
    expect(farAway.ok).toBe(true);
  });
  it('placement succeeds', () => expect(res.ok).toBe(true));
  it('essence was spent at placement time', () => {
    expect(w.resources.player).toBe(10000 - BUILDING_TYPES.outpost.cost);
  });
  it('an unfinished site grants NO command yet', () => {
    expect(supplyCap(w, 'player')).toBe(capBefore);
  });
  it('cannot afford, cannot place', () => {
    expect(canPlaceBuilding(poor, 'player', 'outpost', remote.x, remote.z).ok).toBe(false);
  });
});

// [17] outposts work as drop-off points
describe('[17] outposts work as drop-off points', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const node = must(w.nodes.find(n => n.x > 0));   // node on the RIVAL side, far from home
  const ws0 = workersOf(w, 'player');
  cmdPlaceBuilding(w, 'player', 'outpost', node.x - 4, node.z, [must(ws0[1]).id]);
  run(w, 1200);                                    // let the builder walk out and finish
  const finished = w.sites.length === 0 && w.buildings.length === 3;
  const u = must(ws0[0]);
  cmdGather(w, [u.id], node.id);
  run(w, 1400);
  const nearest = nearestDropoff(w, 'player', node.x, node.z);

  it('remote outpost finished', () => expect(finished).toBe(true));
  it('the outpost is the nearest drop-off to that node', () => {
    expect(must(nearest).type).toBe('outpost');
  });
  it('essence banked from a remote node', () => {
    expect(w.resources.player).toBeGreaterThan(10000 - BUILDING_TYPES.outpost.cost);
  });
});

// [18] control range is territory, not a build restriction (A7)
describe('[18] control range is territory, not a build restriction', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const base = must(w.buildings.find(b => b.team === 'player'));

  it('own base is inside own control', () => {
    expect(isInControl(w, 'player', base.x, base.z)).toBe(true);
  });
  it('rival base is not inside player control', () => {
    expect(isInControl(w, 'player', -base.x, -base.z)).toBe(false);
  });
  it('control does not gate placement', () => {
    const remote = remoteBuildablePoint(w);
    expect(canPlaceBuilding(w, 'player', 'outpost', remote.x, remote.z).ok).toBe(true);
    expect(isInControl(w, 'player', remote.x, remote.z)).toBe(false);
  });
});
