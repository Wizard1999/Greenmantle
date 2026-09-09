import { describe, expect, it } from 'vitest';
import { createWorld, simStep } from '../src/sim/world';
import { buildTestMap } from '../src/sim/map';
import { cmdFormSquad, cmdSetSelection } from '../src/sim/commands';
import {
  cmdAssignSquadToMission, cmdCancelMission, cmdCreateMission,
  cmdRemoveSquadFromMission, cmdSetMissionFallback, cmdSetMissionPriority, findMission,
} from '../src/sim/missions';
import { hash } from '../src/sim/snapshot';
import { Recorder, checkReplay, playback } from '../src/sim/replay';
import { must, run } from './helpers';
import type { World } from '../src/core/types';

/** Missions sit above squads (D-007). These tests guard the primitive —
 *  creation, assignment, lifecycle, replay. What a mission makes its squads
 *  actually *do* (D-041) is `missionOrders.test.ts`. */

const fresh = (seed = 1337) => buildTestMap(createWorld(seed));

function playerSquad(w: World, number = 1): number {
  const units = w.units.filter(u => u.team === 'player' && !u.gather).map(u => u.id);
  cmdSetSelection(w, units);
  const res = cmdFormSquad(w, 'player', units, number);
  return must(res.siteId, 'squad id');
}

describe('creating missions', () => {
  it('creates an active mission with defaults', () => {
    const w = fresh();
    const res = cmdCreateMission(w, 'player', 'assault');
    expect(res.ok).toBe(true);
    const mission = findMission(w, must(res.siteId, 'mission id'));
    expect(mission?.status).toBe('active');
    expect(mission?.priority).toBe('normal');
    expect(mission?.squadIds).toEqual([]);
    expect(mission?.team).toBe('player');
    // Unresolved until the mission has a squad to resolve it from, and no
    // strength recorded until one is on it. A mission with neither drives
    // nothing, which is what makes ordering one free.
    expect(mission?.target).toBeNull();
    expect(mission?.strengthPeak).toBe(0);
    expect(mission?.fallback).toBeNull();
  });

  it('accepts an initial squad list, filtered to the team', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const res = cmdCreateMission(w, 'player', 'defend', {
      priority: 'high', squadIds: [squadId, 999999],
    });
    const mission = findMission(w, must(res.siteId, 'mission id'));
    expect(mission?.squadIds).toEqual([squadId]);
    expect(mission?.priority).toBe('high');
  });
});

describe('assigning squads', () => {
  it('a squad can be assigned and unassigned', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const missionId = must(cmdCreateMission(w, 'player', 'scout').siteId, 'mission id');

    expect(cmdAssignSquadToMission(w, missionId, squadId).ok).toBe(true);
    expect(findMission(w, missionId)?.squadIds).toEqual([squadId]);

    expect(cmdRemoveSquadFromMission(w, missionId, squadId).ok).toBe(true);
    expect(findMission(w, missionId)?.squadIds).toEqual([]);
  });

  it('a squad serves at most one mission at a time', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const a = must(cmdCreateMission(w, 'player', 'assault').siteId, 'a');
    const b = must(cmdCreateMission(w, 'player', 'defend').siteId, 'b');

    cmdAssignSquadToMission(w, a, squadId);
    expect(findMission(w, a)?.squadIds).toEqual([squadId]);

    cmdAssignSquadToMission(w, b, squadId);
    expect(findMission(w, a)?.squadIds).toEqual([]);
    expect(findMission(w, b)?.squadIds).toEqual([squadId]);
  });

  it('refuses a squad belonging to another team', () => {
    const w = fresh();
    const enemyUnits = w.units.filter(u => u.team === 'rival' && !u.gather).map(u => u.id);
    const enemySquad = must(cmdFormSquad(w, 'rival', enemyUnits, 1).siteId, 'enemy squad');
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    expect(cmdAssignSquadToMission(w, missionId, enemySquad).ok).toBe(false);
  });

  it('refuses assignment to a mission that is not active', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    cmdCancelMission(w, missionId);
    expect(cmdAssignSquadToMission(w, missionId, squadId).ok).toBe(false);
  });
});

describe('mission lifecycle', () => {
  it('priority and fallback can be changed', () => {
    const w = fresh();
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    expect(cmdSetMissionPriority(w, missionId, 'low').ok).toBe(true);
    expect(findMission(w, missionId)?.priority).toBe('low');
    expect(cmdSetMissionFallback(w, missionId, { x: 4, z: -2 }).ok).toBe(true);
    expect(findMission(w, missionId)?.fallback).toEqual({ x: 4, z: -2 });
  });

  it('cancelling is terminal', () => {
    const w = fresh();
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    expect(cmdCancelMission(w, missionId).ok).toBe(true);
    expect(findMission(w, missionId)?.status).toBe('cancelled');
    expect(cmdCancelMission(w, missionId).ok).toBe(false);
  });

  it('a disbanded squad is pruned from its mission the next tick', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    cmdAssignSquadToMission(w, missionId, squadId);
    expect(findMission(w, missionId)?.squadIds).toEqual([squadId]);

    // Kill every member of the squad; the reaper removes the squad on the
    // next tick, and missions must not be left holding a dangling id.
    for (const u of w.units) if (u.team === 'player' && !u.gather) u.hp = 0;
    run(w, 1);
    expect(w.squads.some(sq => sq.id === squadId)).toBe(false);
    expect(findMission(w, missionId)?.squadIds).toEqual([]);
  });
});

describe('missions are deterministic sim state', () => {
  it('are part of the hash', () => {
    const a = fresh(9); const b = fresh(9);
    expect(hash(a)).toBe(hash(b));
    cmdCreateMission(a, 'player', 'assault');
    expect(hash(a)).not.toBe(hash(b));
  });

  it('priority changes affect the hash', () => {
    const w = fresh(9);
    const missionId = must(cmdCreateMission(w, 'player', 'assault').siteId, 'mission id');
    const before = hash(w);
    cmdSetMissionPriority(w, missionId, 'high');
    expect(hash(w)).not.toBe(before);
  });

  it('survives a serialize round trip', () => {
    const w = fresh();
    const squadId = playerSquad(w);
    const missionId = must(cmdCreateMission(w, 'player', 'defend', { squadIds: [squadId] }).siteId, 'mission id');
    cmdSetMissionFallback(w, missionId, { x: 1, z: 2 });
    const wire = JSON.parse(JSON.stringify(w)) as World;
    expect(hash(wire)).toBe(hash(w));
  });
});

describe('missions replay correctly', () => {
  it('mission commands round-trip through record and playback', () => {
    const world = fresh();
    const rec = new Recorder(1337, 8);
    let missionId = -1;
    let squadId = -1;

    for (let t = 0; t < 60; t++) {
      if (t === 3) {
        // Every command must go through the recorder, including squad
        // formation — anything applied directly to `world` is invisible to
        // playback and desyncs nextId consumption for everything after it.
        const units = world.units.filter(u => u.team === 'player' && !u.gather).map(u => u.id);
        rec.apply(world, { t: 'select', units });
        rec.apply(world, { t: 'formSquad', team: 'player', units, number: 1 });
        squadId = must(world.squads.at(-1)).id;
      }
      if (t === 10) {
        rec.apply(world, { t: 'createMission', team: 'player', objective: 'assault', priority: 'high' });
        missionId = must(world.missions.at(-1)).id;
      }
      if (t === 20 && missionId > 0) {
        rec.apply(world, { t: 'assignSquadToMission', mission: missionId, squad: squadId });
      }
      if (t === 30 && missionId > 0) {
        rec.apply(world, { t: 'setMissionFallback', mission: missionId, fallback: { x: -3, z: 5 } });
      }
      simStep(world);
    }

    const replay = rec.finish(world);
    expect(checkReplay(replay).ok).toBe(true);
    const replayed = playback(replay, 60);
    expect(hash(replayed)).toBe(hash(world));
    expect(findMission(replayed, missionId)?.fallback).toEqual({ x: -3, z: 5 });
  });
});
