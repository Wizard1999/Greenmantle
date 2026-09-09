import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EntityId, Mission, MissionObjective, MissionPriority, Squad, Team, Vec2, World,
} from '../src/core/types';
import { cmdFormSquad } from '../src/sim/commands';
import { buildTestMap } from '../src/sim/map';
import { cmdCreateMission, cmdSetMissionFallback } from '../src/sim/missions';
import { Recorder, playback } from '../src/sim/replay';
import { hash } from '../src/sim/snapshot';
import { createWorld, simStep } from '../src/sim/world';
import type { MissionSummary } from '../src/ui/missionPanel';
import {
  CONCLUDED_SHOWN, MISSION_LAYER_NOTE, OBJECTIVE_LABEL, OBJECTIVE_NOTE,
  OBJECTIVE_ORDER, PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL,
  bearingBetween, missionPanelModel, missionSummary, placeOf, referenceBuilding,
  squadActivity, squadCard, squadName, squadPosition,
} from '../src/ui/missionPanel';
import { must, peacefulMap } from './helpers';

/**
 * The panel is tested through its model rather than through a DOM: the suite
 * runs in node (`vite.config.ts`), and everything worth asserting about a
 * mission panel is what it *says*, not which element says it.
 * `controlsSheet.test.ts` takes the same shape for the same reason.
 */

/** Two units apiece so squads formed in one test do not quietly empty each
 *  other — `createSquad` moves a unit out of its old squad. */
const formSquad = (world: World, n: number): Squad => {
  const pool = world.units.filter(u => u.team === 'player' && !u.gather).map(u => u.id);
  const ids = pool.slice((n - 1) * 2, (n - 1) * 2 + 2);
  expect(cmdFormSquad(world, 'player', ids, n).ok).toBe(true);
  return must(world.squads.find(s => s.team === 'player' && s.number === n), `squad ${n}`);
};

const newMission = (
  world: World, team: Team, objective: MissionObjective,
  opts: { priority?: MissionPriority; squadIds?: EntityId[]; fallback?: Vec2 | null } = {},
): Mission => {
  const res = cmdCreateMission(world, team, objective, opts);
  return must(world.missions.find(m => m.id === res.siteId), 'mission');
};

describe('bearings', () => {
  const origin = { x: 0, z: 0 };

  it('reads +z as north, matching the minimap', () => {
    // minimapWorldToCanvas maps +z to negative canvas Y, i.e. up the map. A
    // bearing that disagreed with the minimap would be worse than none.
    expect(bearingBetween(origin, { x: 0, z: 10 }).short).toBe('N');
    expect(bearingBetween(origin, { x: 0, z: -10 }).short).toBe('S');
  });

  it('covers all eight points', () => {
    const cases: Array<[number, number, string]> = [
      [0, 10, 'N'], [10, 10, 'NE'], [10, 0, 'E'], [10, -10, 'SE'],
      [0, -10, 'S'], [-10, -10, 'SW'], [-10, 0, 'W'], [-10, 10, 'NW'],
    ];
    for (const [x, z, short] of cases) {
      expect(bearingBetween(origin, { x, z }).short, `${x},${z}`).toBe(short);
    }
  });

  it('reports whole-unit distance', () => {
    expect(bearingBetween(origin, { x: 3, z: 4 }).distance).toBe(5);
  });
});

describe('place labels', () => {
  it('describes a position against the player\'s own Standard', () => {
    const world = peacefulMap();
    const standard = must(referenceBuilding(world, 'player'), 'reference building');
    const place = placeOf(world, 'player', { x: standard.x, z: standard.z + 20 });
    expect(place.short).toBe('N 20');
    expect(place.long).toBe('20 north of your Standard');
  });

  it('says "at base" rather than printing a zero bearing', () => {
    const world = peacefulMap();
    const standard = must(referenceBuilding(world, 'player'), 'reference building');
    expect(placeOf(world, 'player', { x: standard.x, z: standard.z }).short).toBe('at base');
  });

  it('falls back to coordinates when the team has no building left', () => {
    const world = peacefulMap();
    world.buildings = world.buildings.filter(b => b.team !== 'player');
    expect(referenceBuilding(world, 'player')).toBeNull();
    expect(placeOf(world, 'player', { x: 12, z: -4 }).short).toBe('12, -4');
  });

  it('has something to say about a position that does not exist', () => {
    expect(placeOf(peacefulMap(), 'player', null).short).toBe('—');
  });
});

describe('squad cards', () => {
  it('reads as name, purpose, place — the blueprint\'s three columns', () => {
    const world = peacefulMap();
    const card = squadCard(world, formSquad(world, 1));
    expect(card.name).toBe('Squad One');
    expect(card.activity.length).toBeGreaterThan(0);
    expect(card.where.length).toBeGreaterThan(0);
    expect(card.detail).toContain('Squad One');
    expect(card.detail).toContain(card.activity);
  });

  it('names squads in words, and survives a raised squad cap', () => {
    expect(squadName(1)).toBe('Squad One');
    expect(squadName(5)).toBe('Squad Five');
    expect(squadName(9)).toBe('Squad 9');
  });

  it('reports the centre of mass, not the first member', () => {
    const world = peacefulMap();
    const squad = formSquad(world, 1);
    const members = world.units.filter(u => squad.memberIds.includes(u.id));
    members.forEach((u, i) => { u.x = i * 10; u.z = 0; });
    const at = must(squadPosition(world, squad), 'squad position');
    expect(at.x).toBeCloseTo(((members.length - 1) * 10) / 2, 6);
  });

  it('states what the squad is doing, engagement before orders', () => {
    const world = peacefulMap();
    const squad = formSquad(world, 1);
    const members = world.units.filter(u => squad.memberIds.includes(u.id));
    for (const u of members) u.orderMode = 'idle';
    expect(squadActivity(world, squad)).toBe('Idle');

    for (const u of members) u.orderMode = 'hold';
    expect(squadActivity(world, squad)).toBe('Holding');

    squad.chain = [{ kind: 'attackmove', x: 0, z: 0 }];
    squad.index = 0;
    squad.running = true;
    expect(squadActivity(world, squad)).toBe('Advancing');

    // A chain step is the order; a fight is the battlefield. The battlefield wins.
    must(members[0], 'member').targetId = 999;
    expect(squadActivity(world, squad)).toBe('Fighting');
  });

  it('says so when a squad has lost every unit', () => {
    const world = peacefulMap();
    const squad = formSquad(world, 1);
    world.units = world.units.filter(u => !squad.memberIds.includes(u.id));
    expect(squadActivity(world, squad)).toBe('No units');
    expect(squadPosition(world, squad)).toBeNull();
  });
});

describe('mission summary', () => {
  /** By label, not by index — the row list grows, and a positional assertion
   *  starts testing a different field silently when it does. */
  const rowValue = (summary: MissionSummary, label: string): string =>
    must(summary.rows.find(r => r.label === label), `${label} row`).value;

  it('carries exactly the fields the blueprint specifies, in order', () => {
    const world = peacefulMap();
    const labels = missionSummary(world, newMission(world, 'player', 'assault'))
      .rows.map(r => r.label);
    expect(labels).toEqual(
      ['Objective', 'Ground', 'Status', 'Priority', 'Squads', 'Fallback']);
  });

  it('lists assigned squads by number, the way the blueprint prints them', () => {
    const world = peacefulMap();
    const one = formSquad(world, 1);
    const two = formSquad(world, 2);
    const mission = newMission(world, 'player', 'defend', { squadIds: [two.id, one.id] });
    const summary = missionSummary(world, mission);
    expect(summary.squadNumbers).toEqual([1, 2]);
    expect(rowValue(summary, 'Squads')).toBe('1, 2');
  });

  it('says "none" rather than leaving a field blank', () => {
    const world = peacefulMap();
    const summary = missionSummary(world, newMission(world, 'player', 'scout'));
    expect(rowValue(summary, 'Squads')).toBe('none');
    expect(rowValue(summary, 'Fallback')).toBe('none');
  });

  it('reports the ground the objective resolved to, and says so when it has not', () => {
    // The panel's one claim about D-041: the player names what a squad is for
    // and the simulation works out where. An unresolved objective has to say so
    // rather than print a blank, which reads as a panel still loading.
    const world = peacefulMap();
    const unresolved = missionSummary(world, newMission(world, 'player', 'assault'));
    expect(unresolved.ground).toBeNull();
    expect(rowValue(unresolved, 'Ground')).toBe('not resolved');

    const squad = formSquad(world, 1);
    const mission = newMission(world, 'player', 'assault', { squadIds: [squad.id] });
    simStep(world);
    expect(mission.target).not.toBeNull();
    const resolved = missionSummary(world, mission);
    expect(rowValue(resolved, 'Ground')).toBe(must(resolved.ground, 'ground').short);
    expect(rowValue(resolved, 'Ground')).not.toBe('not resolved');
  });

  it('describes a fallback as a place', () => {
    const world = peacefulMap();
    const mission = newMission(world, 'player', 'defend');
    const standard = must(referenceBuilding(world, 'player'), 'reference building');
    cmdSetMissionFallback(world, mission.id, { x: standard.x, z: standard.z - 30 });
    expect(must(missionSummary(world, mission).fallback, 'fallback').short).toBe('S 30');
  });
});

describe('mission panel model', () => {
  it('shows only the player\'s own operations', () => {
    const world = peacefulMap();
    newMission(world, 'player', 'assault');
    newMission(world, 'rival', 'defend');
    const model = missionPanelModel(world, 'player', null);
    expect(model.missions.map(m => m.objective)).toEqual(['assault']);
  });

  it('opens an operation on its own when nothing is selected', () => {
    const world = peacefulMap();
    const mission = newMission(world, 'player', 'expand');
    expect(missionPanelModel(world, 'player', null).selectedId).toBe(mission.id);
  });

  it('falls back to a live operation when the selected one is gone', () => {
    const world = peacefulMap();
    const live = newMission(world, 'player', 'harvest');
    expect(missionPanelModel(world, 'player', 9999).selectedId).toBe(live.id);
  });

  it('reports nothing selected when there is nothing to select', () => {
    const model = missionPanelModel(peacefulMap(), 'player', null);
    expect(model.missions).toEqual([]);
    expect(model.selectedId).toBeNull();
  });

  it('still reports squads when nothing has been ordered', () => {
    const world = peacefulMap();
    formSquad(world, 1);
    formSquad(world, 2);
    const model = missionPanelModel(world, 'player', null);
    expect(model.missions).toEqual([]);
    expect(model.unassigned.map(c => c.name)).toEqual(['Squad One', 'Squad Two']);
  });

  it('splits squads into the ones on the open operation and the rest', () => {
    const world = peacefulMap();
    const one = formSquad(world, 1);
    formSquad(world, 2);
    const mission = newMission(world, 'player', 'assault', { squadIds: [one.id] });
    const model = missionPanelModel(world, 'player', mission.id);
    expect(model.assigned.map(c => c.number)).toEqual([1]);
    expect(model.unassigned.map(c => c.number)).toEqual([2]);
  });

  it('keeps active operations and only the last few concluded ones', () => {
    const world = peacefulMap();
    for (let i = 0; i < CONCLUDED_SHOWN + 2; i++) {
      newMission(world, 'player', 'scout').status = 'cancelled';
    }
    const active = newMission(world, 'player', 'assault');
    const model = missionPanelModel(world, 'player', null);
    expect(model.missions).toHaveLength(CONCLUDED_SHOWN + 1);
    // Active first, so a running operation is never scrolled off by history.
    expect(must(model.missions[0], 'first row').id).toBe(active.id);
    expect(model.missions.filter(m => m.status === 'cancelled')).toHaveLength(CONCLUDED_SHOWN);
  });

  it('does not reorder the world\'s own arrays while reading them', () => {
    const world = peacefulMap();
    formSquad(world, 2);
    formSquad(world, 1);
    const before = world.squads.map(s => s.id);
    missionPanelModel(world, 'player', null);
    expect(world.squads.map(s => s.id)).toEqual(before);
  });
});

describe('information, never advice', () => {
  /** Blueprint § 3 rules out recommendations and success estimates. These are
   *  the words a panel drifts toward the moment it starts helping. */
  const ADVICE =
    /\b(recommend\w*|should|advise\w*|suggest\w*|consider|better|best|optimal|chance|likely|risky?|instead)\b/i;

  it('carries no advisory vocabulary in any label it ships', () => {
    const shipped = [
      ...Object.values(OBJECTIVE_LABEL),
      ...Object.values(PRIORITY_LABEL),
      ...Object.values(STATUS_LABEL),
      ...Object.values(OBJECTIVE_NOTE),
      MISSION_LAYER_NOTE,
    ];
    for (const text of shipped) expect(text, text).not.toMatch(ADVICE);
  });

  it('states no advice in a rendered summary or squad card', () => {
    const world = peacefulMap();
    const squad = formSquad(world, 1);
    const mission = newMission(world, 'player', 'assault', { squadIds: [squad.id] });
    const model = missionPanelModel(world, 'player', mission.id);
    expect(JSON.stringify(model)).not.toMatch(ADVICE);
  });

  it('offers every objective and priority the simulation defines', () => {
    expect([...OBJECTIVE_ORDER].sort()).toEqual(Object.keys(OBJECTIVE_LABEL).sort());
    expect([...PRIORITY_ORDER].sort()).toEqual(Object.keys(PRIORITY_LABEL).sort());
  });

  it('states how a mission layers over a chain, and no longer claims it is inert', () => {
    // The note read "does not yet drive squad behaviour" until D-041 made it
    // drive squad behaviour, at which point the panel's one standing sentence
    // became its one false one. This guards the replacement against the same
    // decay: it must state both halves of D-041's layering rule.
    expect(MISSION_LAYER_NOTE).not.toMatch(/does not yet|inert/i);
    expect(MISSION_LAYER_NOTE).toMatch(/supplies behaviour/i);
    expect(MISSION_LAYER_NOTE).toMatch(/never overwrites/i);
  });

  it('describes what every objective resolves to, including the two that do not', () => {
    // D-041 kept `escort` and `custom` visibly unimplemented rather than have
    // them guess at ground. A button that looks identical to the six that work
    // is not visible, so the note is where that shows.
    expect(Object.keys(OBJECTIVE_NOTE).sort()).toEqual(Object.keys(OBJECTIVE_LABEL).sort());
    for (const [objective, note] of Object.entries(OBJECTIVE_NOTE)) {
      expect(note.length, objective).toBeGreaterThan(0);
    }
    expect(OBJECTIVE_NOTE.escort).toMatch(/no ground/i);
    expect(OBJECTIVE_NOTE.custom).toMatch(/no ground/i);
  });
});

describe('every action is recordable', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'ui', 'missionPanel.ts'), 'utf8');

  const COMMANDS = [
    'cmdCreateMission', 'cmdAssignSquadToMission', 'cmdRemoveSquadFromMission',
    'cmdSetMissionPriority', 'cmdSetMissionFallback', 'cmdCancelMission',
    'cmdSetSelection',
  ];

  /** Everything outside a balanced `issueCommand( … )` call. */
  const outsideGateway = (src: string): string => {
    const token = 'issueCommand(';
    let out = '';
    let i = 0;
    for (;;) {
      const at = src.indexOf(token, i);
      if (at === -1) return out + src.slice(i);
      out += src.slice(i, at);
      let depth = 0;
      let j = at + token.length - 1;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
      }
      i = j + 1;
    }
  };

  it('reaches every mission command the simulation exposes', () => {
    for (const name of COMMANDS) expect(source.includes(`${name}(`), name).toBe(true);
  });

  it('records a stream that reproduces the operation it built', () => {
    // The literals below mirror the commands `createMissionPanel` hands to
    // `issueCommand`. Recording is worth nothing if playback of the recording
    // does not land on the same world, so play it and compare hashes — no
    // mission command had a round-trip test before this one.
    const seed = 1337;
    const world = buildTestMap(createWorld(seed, 8, seed));
    const recorder = new Recorder(seed, 8, seed, 'none');
    const units = world.units.filter(u => u.team === 'player' && !u.gather).slice(0, 2)
      .map(u => u.id);
    recorder.apply(world, { t: 'formSquad', team: 'player', units, number: 1 });
    const squad = must(world.squads.find(s => s.team === 'player' && s.number === 1), 'squad');
    const standard = must(referenceBuilding(world, 'player'), 'reference building');

    recorder.apply(world,
      { t: 'createMission', team: 'player', objective: 'assault', squadIds: [] });
    const mission = must(world.missions[0], 'mission');

    for (const cmd of [
      { t: 'assignSquadToMission', mission: mission.id, squad: squad.id },
      { t: 'setMissionPriority', mission: mission.id, priority: 'high' },
      { t: 'setMissionFallback', mission: mission.id, fallback: { x: standard.x, z: standard.z } },
      { t: 'removeSquadFromMission', mission: mission.id, squad: squad.id },
      { t: 'cancelMission', mission: mission.id },
    ] as const) {
      recorder.apply(world, cmd);
      simStep(world);
    }

    expect(mission.priority).toBe('high');
    expect(mission.status).toBe('cancelled');
    expect(hash(playback(recorder.finish(world), world.tick))).toBe(hash(world));
  });

  it('calls no simulation command outside issueCommand', () => {
    // A direct call records nothing, so playback re-simulates a match in which
    // the mission was never created and diverges from that tick onward.
    const rest = outsideGateway(source);
    expect(rest.length).toBeGreaterThan(0);
    for (const name of COMMANDS) {
      expect(rest.includes(`${name}(`), `${name} called outside issueCommand`).toBe(false);
    }
  });
});
