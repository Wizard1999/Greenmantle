import { describe, it, expect } from 'vitest';
import { buildOf, peacefulMap, gatherOf, must, run, workersOf } from './helpers';
import { simStep } from '../src/sim/world';
import {
  cmdAssignBuilders, cmdCancelSite, cmdGather, cmdMove, cmdPlaceBuilding,
} from '../src/sim/commands';
import { canPlaceBuilding } from '../src/sim/construction';
import { supplyCap } from '../src/sim/supply';
import { BUILDING_TYPES } from '../src/data/buildings';

// [19] Queue & Walk â€” construction is walked to, not conjured (1.6)
describe('[19] Queue & Walk', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const u = must(workersOf(w, 'player')[0]);
  const buildingsBefore = w.buildings.length;

  const res = cmdPlaceBuilding(w, 'player', 'outpost', -2, 6, [u.id]);
  const madeSite = res.ok && w.sites.length === 1 && w.buildings.length === buildingsBefore;
  const assigned = buildOf(u).siteId === res.siteId;
  const startProgress = must(w.sites[0]).progress;

  run(w, 3);
  const progressWhileWalking = must(w.sites[0]).progress;

  run(w, 400);
  const completed = w.sites.length === 0 && w.buildings.length === buildingsBefore + 1;

  it('placing creates a site, not a building', () => expect(madeSite).toBe(true));
  it('the worker was assigned', () => expect(assigned).toBe(true));
  it('progress starts at zero', () => expect(startProgress).toBe(0));
  it('no progress while still walking', () => expect(progressWhileWalking).toBe(0));
  it('site completed into a real building', () => expect(completed).toBe(true));
  it('builder was released', () => expect(buildOf(u).siteId).toBeNull());
  it('finished outpost grants command', () => {
    expect(supplyCap(w, 'player')).toBeGreaterThan(BUILDING_TYPES.standard.command);
  });
});

// [20] reassignment PAUSES, it does not cancel (the point of Â§8.1)
describe('[20] reassignment pauses, it does not cancel', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const u = must(workersOf(w, 'player')[0]);
  const res = cmdPlaceBuilding(w, 'player', 'outpost', -2, 6, [u.id]);
  for (let ticks = 0; ticks < 400 && must(w.sites[0]).progress === 0; ticks++) {
    simStep(w);
  }
  const partial = must(w.sites[0]).progress;

  cmdMove(w, [u.id], 20, 20);                 // yank the worker away
  const released = buildOf(u).siteId === null;
  run(w, 80);
  const stillThere = w.sites.length === 1;
  const afterUnattended = must(w.sites[0]).progress;

  cmdAssignBuilders(w, [u.id], must(res.siteId));   // send it back
  run(w, 400);
  const resumed = w.sites.length === 0;

  it('some progress was made', () => expect(partial).toBeGreaterThan(0));
  it('worker released from the site', () => expect(released).toBe(true));
  it('site still exists', () => expect(stillThere).toBe(true));
  it('progress was RETAINED, not lost', () => expect(afterUnattended).toBe(partial));
  it('and did not advance while unattended', () => expect(afterUnattended).toBe(partial));
  it('resumes and completes', () => expect(resumed).toBe(true));
});

// [21] gathering and building are mutually exclusive
describe('[21] gathering and building are mutually exclusive', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const u = must(workersOf(w, 'player')[0]);
  cmdGather(w, [u.id], must(w.nodes[0]).id);
  const res = cmdPlaceBuilding(w, 'player', 'outpost', -2, 6, [u.id]);
  const gatherStopped = gatherOf(u).state === 'idle';
  run(w, 40);
  cmdGather(w, [u.id], must(w.nodes[0]).id);
  const buildReleased = buildOf(u).siteId === null;
  const sitePaused = w.sites.length === 1;
  const nonWorkers = cmdAssignBuilders(
    w, w.units.filter(x => !x.build).map(x => x.id), must(res.siteId),
  );

  it('build order stops gathering', () => expect(gatherStopped).toBe(true));
  it('gather order releases the build site', () => expect(buildReleased).toBe(true));
  it('site survives as paused', () => expect(sitePaused).toBe(true));
  it('non-workers cannot be assigned as builders', () => expect(nonWorkers.length).toBe(0));
});

// [22] site cancellation and placement blocking
describe('[22] site cancellation and placement blocking', () => {
  const w = peacefulMap();
  w.resources.player = 10000;
  const u = must(workersOf(w, 'player')[0]);
  const res = cmdPlaceBuilding(w, 'player', 'outpost', -2, 6, [u.id]);
  run(w, 60);
  const blocked = canPlaceBuilding(w, 'player', 'outpost', -2, 6);

  const before = w.resources.player;
  cmdCancelSite(w, must(res.siteId));

  it('cannot place a second site on top of the first', () => expect(blocked.ok).toBe(false));
  it('cancelling refunds in full', () => {
    expect(w.resources.player).toBe(before + BUILDING_TYPES.outpost.cost);
  });
  it('site is gone', () => expect(w.sites.length).toBe(0));
  it('builder was released', () => expect(buildOf(u).siteId).toBeNull());
  it('the spot is free again', () => {
    expect(canPlaceBuilding(w, 'player', 'outpost', -2, 6).ok).toBe(true);
  });
});

// [23] multiple workers do not rush a build (assumption A8)
describe('[23] multiple workers do not rush a build', () => {
  const timeWith = (n: number) => {
    const w = peacefulMap();
    w.resources.player = 10000;
    const ws = workersOf(w, 'player').slice(0, n).map(u => u.id);
    const placed = cmdPlaceBuilding(w, 'player', 'outpost', -2, 6, ws);
    const site = must(w.sites.find(candidate => candidate.id === placed.siteId));
    for (const worker of workersOf(w, 'player').filter(u => ws.includes(u.id))) {
      worker.x = site.x;
      worker.z = site.z;
    }
    let t = 0;
    while (w.sites.length && t < 2000) { simStep(w); t++; }
    return t;
  };
  const one = timeWith(1);
  const four = timeWith(4);

  it(`four workers build no faster than one (1 worker ${one}t, 4 workers ${four}t)`, () => {
    expect(Math.abs(one - four)).toBeLessThanOrEqual(2);
  });
});
