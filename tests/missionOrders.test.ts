import { describe, expect, it } from 'vitest';
import { freshMap, must, peacefulMap, run } from './helpers';
import {
  cmdAddChainStep, cmdFormSquad, cmdMove, cmdRunChain,
} from '../src/sim/commands';
import {
  cmdAssignSquadToMission, cmdCancelMission, cmdCreateMission, cmdSetMissionFallback,
  cmdSetMissionPriority, findMission, missionForSquad, missionStrength, missionWithdrawing,
} from '../src/sim/missions';
import { squadCentre } from '../src/sim/squads';
import { isInControl } from '../src/sim/supply';
import { hash } from '../src/sim/snapshot';
import { Recorder, checkReplay, playback } from '../src/sim/replay';
import { MISSION } from '../src/data/tuning';
import type { EntityId, MissionObjective, MissionPriority, Vec2, World } from '../src/core/types';

/**
 * Missions drive their squads (D-041).
 *
 * `missions.test.ts` guards the primitive — creation, assignment, lifecycle.
 * This file guards the behaviour: that a mission changes what an assigned
 * squad does, that it does not trample a chain the player wrote, and that the
 * fallback position finally means something.
 *
 * Every assertion is about a squad with **no chain of its own**, unless it says
 * otherwise. That is the point of the feature: the player names an objective
 * and the army works out the doing.
 */

const rivalBase = (w: World): Vec2 => must(w.buildings.find(b => b.team === 'rival'), 'rival base');
const ownBase = (w: World): Vec2 =>
  must(w.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'player base');

function fightersOf(w: World, count?: number): EntityId[] {
  const ids = w.units.filter(u => u.team === 'player' && !u.gather).map(u => u.id);
  return count === undefined ? ids : ids.slice(0, count);
}

/** A squad with no behaviour chain, which is the case the mission has to fill. */
function bareSquad(w: World, units: EntityId[], number = 1): EntityId {
  return must(cmdFormSquad(w, 'player', units, number).siteId, 'squad id');
}

function orderMission(
  w: World, objective: MissionObjective, squadId: EntityId,
  opts: { priority?: MissionPriority; fallback?: Vec2 | null } = {},
): EntityId {
  const id = must(cmdCreateMission(w, 'player', objective, opts).siteId, 'mission id');
  cmdAssignSquadToMission(w, id, squadId);
  return id;
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

const centre = (w: World, squadId: EntityId): Vec2 =>
  must(squadCentre(w, must(w.squads.find(s => s.id === squadId), 'squad')), 'squad centre');

describe('a mission supplies behaviour to a squad that has none', () => {
  it('an assault walks the squad toward the enemy with no chain and no orders', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    orderMission(w, 'assault', squadId);

    const before = distance(centre(w, squadId), rivalBase(w));
    run(w, 300);
    const after = distance(centre(w, squadId), rivalBase(w));

    expect(must(w.squads.find(s => s.id === squadId)).chain).toEqual([]);
    expect(after).toBeLessThan(before - 20);
  });

  it('a squad with no mission and no chain stays where it is', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const before = centre(w, squadId);
    run(w, 300);
    expect(distance(centre(w, squadId), before)).toBeLessThan(0.001);
  });

  it('the objective resolves once and is then held', () => {
    const w = peacefulMap();
    orderMission(w, 'assault', bareSquad(w, fightersOf(w)));
    const missionId = must(w.missions[0]).id;

    expect(findMission(w, missionId)?.target).toBeNull();
    run(w, 1);
    const resolved = must(findMission(w, missionId)?.target, 'resolved target');
    expect(resolved).toEqual({ x: rivalBase(w).x, z: rivalBase(w).z });

    run(w, 200);
    expect(findMission(w, missionId)?.target).toEqual(resolved);
  });

  it('a cancelled mission stops driving its squad', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const missionId = orderMission(w, 'assault', squadId);
    run(w, 60);
    cmdCancelMission(w, missionId);
    run(w, 1);

    // Members finish walking to wherever they were last sent, exactly as they
    // do when a chain is stopped — cancelling an operation is not a recall.
    // What must not happen is another dispatch, so clear the outstanding one
    // and watch nothing replace it.
    for (const u of w.units) u.target = null;
    const parked = centre(w, squadId);
    run(w, 200);

    expect(must(w.squads.find(s => s.id === squadId)).servingMissionId).toBeNull();
    expect(distance(centre(w, squadId), parked)).toBeLessThan(0.001);
  });
});

describe('a mission does not overwrite a chain the player wrote', () => {
  it('the squad walks its own chain, not the objective', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const start = centre(w, squadId);
    // A destination in the opposite direction from the enemy base.
    const away = { x: start.x - (rivalBase(w).x - start.x) * 0.2, z: start.z - (rivalBase(w).z - start.z) * 0.2 };
    cmdAddChainStep(w, squadId, 'move', away.x, away.z);
    expect(cmdRunChain(w, squadId).ok).toBe(true);
    orderMission(w, 'assault', squadId);

    run(w, 200);
    expect(distance(centre(w, squadId), away)).toBeLessThan(distance(start, away));
    expect(distance(centre(w, squadId), rivalBase(w))).toBeGreaterThan(distance(start, rivalBase(w)));
  });
});

describe('withdrawal doctrine (the fallback position, at last)', () => {
  /** Reduce every member of the mission's squads to `fraction` of current hp,
   *  without killing anyone — a dead member leaves the roster and stops
   *  counting, which is a different situation. */
  function maul(w: World, missionId: EntityId, fraction: number): void {
    const mission = must(findMission(w, missionId), 'mission');
    const ids = new Set(w.squads.filter(s => mission.squadIds.includes(s.id))
      .flatMap(s => s.memberIds));
    for (const u of w.units) if (ids.has(u.id)) u.hp *= fraction;
  }

  it('a spent force falls back to the fallback position', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const home = ownBase(w);
    const missionId = orderMission(w, 'assault', squadId, { fallback: { x: home.x, z: home.z } });

    run(w, 200);                                   // commit, and set the high-water mark
    const committed = distance(centre(w, squadId), home);
    expect(committed).toBeGreaterThan(5);

    maul(w, missionId, 0.2);
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(true);

    run(w, 200);
    expect(distance(centre(w, squadId), home)).toBeLessThan(committed - 10);
  });

  it('without a fallback position there is no withdrawal, whatever the losses', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const missionId = orderMission(w, 'assault', squadId);
    run(w, 200);
    maul(w, missionId, 0.05);

    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(false);
    const pressing = distance(centre(w, squadId), rivalBase(w));
    run(w, 200);
    expect(distance(centre(w, squadId), rivalBase(w))).toBeLessThan(pressing);
  });

  it('priority decides how much loss the operation absorbs', () => {
    const at = (priority: MissionPriority, fraction: number): boolean => {
      const w = peacefulMap();
      const squadId = bareSquad(w, fightersOf(w));
      const home = ownBase(w);
      const missionId = orderMission(w, 'assault', squadId,
        { priority, fallback: { x: home.x, z: home.z } });
      run(w, 30);
      maul(w, missionId, fraction);
      return missionWithdrawing(w, must(findMission(w, missionId)));
    };

    // 60% of the force's high-water strength: past what a probe will absorb,
    // well inside what a committed push will.
    expect(at('low', 0.6)).toBe(true);
    expect(at('normal', 0.6)).toBe(false);
    expect(at('high', 0.6)).toBe(false);
    expect(at('normal', 0.4)).toBe(true);
    expect(at('high', 0.4)).toBe(false);
    expect(at('high', 0.2)).toBe(true);
  });

  it('the thresholds are ordered, so raising priority never withdraws sooner', () => {
    const t = MISSION.withdrawBelowStrength;
    expect(t.low).toBeGreaterThan(t.normal);
    expect(t.normal).toBeGreaterThan(t.high);
  });

  it('reinforcement puts a broken operation back in the fight', () => {
    const w = peacefulMap();
    const all = fightersOf(w);
    const first = bareSquad(w, all.slice(0, 2), 1);
    const reserve = bareSquad(w, all.slice(2), 2);
    const home = ownBase(w);
    const missionId = orderMission(w, 'assault', first, { fallback: { x: home.x, z: home.z } });

    run(w, 30);
    maul(w, missionId, 0.2);
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(true);

    cmdAssignSquadToMission(w, missionId, reserve);
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(false);
  });

  it('re-crewing a wiped-out operation starts the commitment over', () => {
    const w = peacefulMap();
    const all = fightersOf(w);
    const first = bareSquad(w, all.slice(0, 3), 1);
    const relief = bareSquad(w, all.slice(3), 2);
    const home = ownBase(w);
    const missionId = orderMission(w, 'assault', first, { fallback: { x: home.x, z: home.z } });

    run(w, 5);
    const objective = must(findMission(w, missionId), 'mission').target;
    expect(must(findMission(w, missionId)).strengthPeak).toBeGreaterThan(0);

    for (const u of w.units) if (all.slice(0, 3).includes(u.id)) u.hp = 0;
    run(w, 2);

    // A single relief unit is a fraction of what the destroyed force was worth.
    // It should be pressing the objective, not walking home from a defeat it
    // was not part of.
    expect(must(findMission(w, missionId)).strengthPeak).toBe(0);
    cmdAssignSquadToMission(w, missionId, relief);
    run(w, 2);
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(false);
    expect(must(findMission(w, missionId)).target).toEqual(objective);
  });

  it('withdrawal overrides a chain the player wrote, because the player wrote that too', () => {
    const w = peacefulMap();
    const squadId = bareSquad(w, fightersOf(w));
    const home = ownBase(w);
    const start = centre(w, squadId);
    const forward = { x: start.x + (rivalBase(w).x - start.x) * 0.3, z: start.z + (rivalBase(w).z - start.z) * 0.3 };
    cmdAddChainStep(w, squadId, 'move', forward.x, forward.z);
    cmdRunChain(w, squadId);
    const missionId = orderMission(w, 'defend', squadId, { fallback: { x: home.x, z: home.z } });

    run(w, 120);
    const advanced = distance(centre(w, squadId), home);
    maul(w, missionId, 0.1);
    run(w, 150);
    expect(distance(centre(w, squadId), home)).toBeLessThan(advanced);
  });
});

describe('objectives resolve to ground the world can answer for', () => {
  const targetOf = (objective: MissionObjective): { w: World; target: Vec2 | null } => {
    const w = peacefulMap();
    const squadId = bareSquad(w, objective === 'harvest'
      ? w.units.filter(u => u.team === 'player' && u.gather).map(u => u.id)
      : fightersOf(w));
    const missionId = orderMission(w, objective, squadId);
    run(w, 1);
    return { w, target: must(findMission(w, missionId), 'mission').target };
  };

  it('defend aims at ground the team already holds', () => {
    const { w, target } = targetOf('defend');
    expect(w.buildings.some(b => b.team === 'player' && b.x === target?.x && b.z === target.z)).toBe(true);
  });

  it('harvest aims at a resource that still has something in it', () => {
    const { w, target } = targetOf('harvest');
    expect(w.nodes.some(n => n.amount > 0 && n.x === target?.x && n.z === target.z)).toBe(true);
  });

  it('expand aims at ground the team does not already control', () => {
    const { w, target } = targetOf('expand');
    const at = must(target, 'expand target');
    expect(w.nodes.some(n => n.x === at.x && n.z === at.z)).toBe(true);
    expect(isInControl(w, 'player', at.x, at.z)).toBe(false);
  });

  it('escort and custom resolve to nothing, and say so by driving nothing', () => {
    for (const objective of ['escort', 'custom'] as const) {
      const w = peacefulMap();
      const squadId = bareSquad(w, fightersOf(w));
      orderMission(w, objective, squadId);
      const before = centre(w, squadId);
      run(w, 120);
      expect(must(w.missions[0]).target).toBeNull();
      expect(distance(centre(w, squadId), before)).toBeLessThan(0.001);
    }
  });

  it('a harvest operation banks resources with no chain and no worker orders', () => {
    const w = peacefulMap();
    const workers = w.units.filter(u => u.team === 'player' && u.gather).map(u => u.id);
    orderMission(w, 'harvest', bareSquad(w, workers));
    run(w, 900);
    expect(w.resources.player).toBeGreaterThan(0);
  });

  it('a defender holds its ground where an attacker presses, and the order mode says so', () => {
    const modesUnder = (objective: MissionObjective): string[] => {
      const w = peacefulMap();
      const squadId = bareSquad(w, fightersOf(w));
      orderMission(w, objective, squadId);
      run(w, 10);   // still travelling; arriving would drop the mode back to idle
      const squad = must(w.squads.find(s => s.id === squadId));
      return w.units.filter(u => squad.memberIds.includes(u.id)).map(u => u.orderMode);
    };

    // `stepPursuit` reads nothing but `orderMode` to decide whether a unit may
    // leave its destination to chase. A defender that chased would be an
    // assault with extra steps, so the two postures must differ here or they do
    // not differ at all.
    expect(modesUnder('defend').every(m => m === 'move')).toBe(true);
    expect(modesUnder('assault').every(m => m === 'attackMove')).toBe(true);
  });
});

describe('Command bandwidth governs missions as it governs chains', () => {
  it('the higher-priority operation takes the only slot', () => {
    const w = peacefulMap();
    const all = fightersOf(w);
    const quiet = bareSquad(w, all.slice(0, 2), 1);
    const urgent = bareSquad(w, all.slice(2), 2);
    orderMission(w, 'assault', quiet, { priority: 'low' });
    orderMission(w, 'assault', urgent, { priority: 'high' });

    const quietStart = centre(w, quiet);
    const urgentStart = centre(w, urgent);
    run(w, 120);

    expect(distance(centre(w, quiet), quietStart)).toBeLessThan(0.001);
    expect(distance(centre(w, urgent), urgentStart)).toBeGreaterThan(5);
  });

  it('raising the losing operation to the same priority still resolves deterministically', () => {
    const build = (): World => {
      const w = peacefulMap();
      const all = fightersOf(w);
      const a = bareSquad(w, all.slice(0, 2), 1);
      const b = bareSquad(w, all.slice(2), 2);
      orderMission(w, 'assault', a, { priority: 'low' });
      const second = orderMission(w, 'assault', b, { priority: 'high' });
      cmdSetMissionPriority(w, second, 'low');
      run(w, 120);
      return w;
    };
    expect(hash(build())).toBe(hash(build()));
  });
});

describe('a hand-issued order releases the squad from its operation', () => {
  it('moving a member takes the squad off the mission, not merely off its chain', () => {
    const w = peacefulMap();
    const units = fightersOf(w);
    const squadId = bareSquad(w, units);
    const missionId = orderMission(w, 'assault', squadId);
    run(w, 60);
    expect(missionForSquad(w, squadId)?.id).toBe(missionId);

    const start = centre(w, squadId);
    cmdMove(w, [must(units[0])], start.x, start.z);
    expect(missionForSquad(w, squadId)).toBeNull();
    expect(findMission(w, missionId)?.squadIds).toEqual([]);
  });
});

describe('mission-driven behaviour is deterministic sim state', () => {
  it('the resolved objective is hashed', () => {
    const build = (): World => {
      const w = peacefulMap(21);
      orderMission(w, 'assault', bareSquad(w, fightersOf(w)));
      return w;
    };
    const a = build();
    const b = build();
    run(a, 1);
    expect(hash(a)).not.toBe(hash(b));
    run(b, 1);
    expect(hash(a)).toBe(hash(b));
  });

  it('the high-water strength is hashed', () => {
    const w = peacefulMap(21);
    const missionId = orderMission(w, 'assault', bareSquad(w, fightersOf(w)));
    run(w, 2);
    const before = hash(w);
    must(findMission(w, missionId)).strengthPeak += 1;
    expect(hash(w)).not.toBe(before);
  });

  it('a driven mission survives a serialize round trip', () => {
    const w = peacefulMap();
    const home = ownBase(w);
    orderMission(w, 'assault', bareSquad(w, fightersOf(w)), { fallback: { x: home.x, z: home.z } });
    run(w, 90);
    const wire = JSON.parse(JSON.stringify(w)) as World;
    expect(hash(wire)).toBe(hash(w));
    expect(must(wire.missions[0]).target).toEqual(must(w.missions[0]).target);
  });

  it('a match where a mission does the driving replays exactly', () => {
    // The full map, not `peacefulMap`: playback rebuilds the world from the
    // seed alone, so a fixture that edited the world after construction would
    // be comparing two different matches.
    const world = freshMap(1337);
    const rec = new Recorder(1337, 8);
    let squadId = -1;
    let missionId = -1;
    let committedFrom = 0;

    for (let t = 0; t < 240; t++) {
      if (t === 2) {
        const units = fightersOf(world);
        rec.apply(world, { t: 'select', units });
        rec.apply(world, { t: 'formSquad', team: 'player', units, number: 1 });
        squadId = must(world.squads.at(-1)).id;
      }
      if (t === 4) {
        rec.apply(world, { t: 'createMission', team: 'player', objective: 'assault', priority: 'high' });
        missionId = must(world.missions.at(-1)).id;
        rec.apply(world, { t: 'assignSquadToMission', mission: missionId, squad: squadId });
        committedFrom = distance(centre(world, squadId), rivalBase(world));
      }
      if (t === 120) {
        const home = ownBase(world);
        rec.apply(world, { t: 'setMissionFallback', mission: missionId, fallback: { x: home.x, z: home.z } });
      }
      run(world, 1);
    }

    const replay = rec.finish(world);
    expect(checkReplay(replay).ok).toBe(true);
    // The squad never had a chain, so any ground it covered was the mission's
    // doing. Asserted here because a replay of a match where nothing moved
    // would agree perfectly and prove nothing.
    expect(missionStrength(world, must(findMission(world, missionId)))).toBeGreaterThan(0);
    expect(distance(centre(world, squadId), rivalBase(world))).toBeLessThan(committedFrom - 20);
    expect(hash(playback(replay, 240))).toBe(hash(world));
  });
});

describe('the fallback command still does what it always did', () => {
  it('clearing the fallback disarms the doctrine', () => {
    const w = peacefulMap();
    const home = ownBase(w);
    const squadId = bareSquad(w, fightersOf(w));
    const missionId = orderMission(w, 'assault', squadId, { fallback: { x: home.x, z: home.z } });
    run(w, 30);
    for (const u of w.units) if (must(w.squads.find(s => s.id === squadId)).memberIds.includes(u.id)) u.hp *= 0.1;
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(true);
    cmdSetMissionFallback(w, missionId, null);
    expect(missionWithdrawing(w, must(findMission(w, missionId)))).toBe(false);
  });
});
