import { describe, it, expect } from 'vitest';
import { buildSpotNearBase as spot, peacefulMap, gatherOf, must, run, workersOf } from './helpers';
import {
  cmdAddChainStep, cmdClearChain, cmdFormSquad, cmdMove, cmdPlaceBuilding,
  cmdRemoveChainStep, cmdRunChain, cmdSetChainLoop, cmdStopChain,
} from '../src/sim/commands';
import {
  automationSlots, runningSquads, squadByNumber, squadCentre, squadMembers,
} from '../src/sim/squads';
import { AUTOMATION } from '../src/data/tuning';
import { BUILDING_TYPES } from '../src/data/buildings';
import type { EntityId, World } from '../src/core/types';

const fighters = (w: World): EntityId[] =>
  w.units.filter(u => u.team === 'player' && !u.gather).map(u => u.id);

const squad1 = (w: World) => must(squadByNumber(w, 'player', 1), 'squad 1');

// [24] squads are persistent groups, not selections (Q1)
describe('[24] squads are persistent groups', () => {
  const w = peacefulMap();
  const ids = fighters(w);
  const formed = cmdFormSquad(w, 'player', ids, 1);

  it('forming a squad succeeds', () => expect(formed.ok).toBe(true));
  it('the squad holds its members', () => {
    expect(squadMembers(w, squad1(w)).map(u => u.id).sort()).toEqual([...ids].sort());
  });
  it('it survives ticks with nothing selected', () => {
    run(w, 100);
    expect(squadByNumber(w, 'player', 1)).not.toBeNull();
  });
  it('it is addressable by its number', () => expect(squad1(w).number).toBe(1));
  it('a unit belongs to at most one squad', () => {
    cmdFormSquad(w, 'player', ids.slice(0, 2), 2);
    const one = must(squadByNumber(w, 'player', 1)).memberIds;
    const two = must(squadByNumber(w, 'player', 2)).memberIds;
    expect(one.some(id => two.includes(id))).toBe(false);
  });
  it('rejects an out-of-range slot', () => {
    expect(cmdFormSquad(w, 'player', ids, 99).ok).toBe(false);
  });
  it('rejects an empty selection', () => {
    expect(cmdFormSquad(w, 'player', [], 3).ok).toBe(false);
  });
});

// [25] a chain runs unattended (blueprint 1.7 acceptance)
describe('[25] a three-step chain runs unattended', () => {
  const w = peacefulMap();
  cmdFormSquad(w, 'player', fighters(w), 1);
  const s = squad1(w);
  cmdAddChainStep(w, s.id, 'move', -4, 2);
  cmdAddChainStep(w, s.id, 'attackmove', 2, -2);
  cmdAddChainStep(w, s.id, 'patrol', -6, -6);
  const started = cmdRunChain(w, s.id);

  const stepsVisited = new Set<number>();
  for (let t = 0; t < 4000; t++) {
    run(w, 1);
    stepsVisited.add(s.index);
  }

  it('the chain has three steps', () => expect(s.chain.length).toBe(3));
  it('running it succeeds', () => expect(started.ok).toBe(true));
  it('it advanced through every step with zero further input', () => {
    expect(stepsVisited).toEqual(new Set([0, 1, 2]));
  });
  it('it is still running at the end', () => expect(s.running).toBe(true));
  it('the squad ended up near the patrol leg, not parked at step 1', () => {
    const c = must(squadCentre(w, s));
    expect(Math.hypot(c.x - (-4), c.z - 2)).toBeGreaterThan(2);
  });
});

// [26] chains loop by default, with a per-chain toggle (Q3)
describe('[26] chains loop by default', () => {
  it('a new squad loops by default', () => {
    const w = peacefulMap();
    cmdFormSquad(w, 'player', fighters(w), 1);
    expect(squad1(w).loop).toBe(true);
  });

  it('a looping chain returns to step 0 and keeps running', () => {
    const w = peacefulMap();
    cmdFormSquad(w, 'player', fighters(w), 1);
    const s = squad1(w);
    cmdAddChainStep(w, s.id, 'move', -6, 4);
    cmdAddChainStep(w, s.id, 'move', -2, 12);
    cmdRunChain(w, s.id);
    let wrapped = false;
    let seenLast = false;
    for (let t = 0; t < 3000; t++) {
      run(w, 1);
      if (s.index === 1) seenLast = true;
      if (seenLast && s.index === 0) wrapped = true;
    }
    expect(wrapped).toBe(true);
    expect(s.running).toBe(true);
  });

  it('with loop off, the chain stops after the last step', () => {
    const w = peacefulMap();
    cmdFormSquad(w, 'player', fighters(w), 1);
    const s = squad1(w);
    cmdAddChainStep(w, s.id, 'move', -6, 4);
    cmdAddChainStep(w, s.id, 'move', -2, 12);
    cmdSetChainLoop(w, s.id, false);
    cmdRunChain(w, s.id);
    run(w, 3000);
    expect(s.running).toBe(false);
  });
});

// [27] Command gates simultaneous chains (assumption A4, Â§8.3)
describe('[27] Command gates simultaneous chains', () => {
  const w = peacefulMap();
  const ws = workersOf(w, 'player');
  cmdFormSquad(w, 'player', fighters(w), 1);
  cmdFormSquad(w, 'player', ws.map(u => u.id), 2);
  const a = must(squadByNumber(w, 'player', 1));
  const b = must(squadByNumber(w, 'player', 2));
  cmdAddChainStep(w, a.id, 'move', -6, 4);
  cmdAddChainStep(w, b.id, 'move', -10, 4);

  const slotsAtStart = automationSlots(w, 'player');
  const first = cmdRunChain(w, a.id);
  const second = cmdRunChain(w, b.id);

  it('starting Command buys exactly one automation slot', () => {
    // 15 command / 8 per slot -> 1
    expect(slotsAtStart).toBe(Math.floor(BUILDING_TYPES.standard.command / AUTOMATION.commandPerSlot));
    expect(slotsAtStart).toBe(1);
  });
  it('the first chain starts', () => expect(first.ok).toBe(true));
  it('the second is refused for lack of Command', () => {
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('Command');
  });
  it('only one chain is actually running', () => expect(runningSquads(w, 'player')).toBe(1));

  it('an outpost raises the cap and lets a second chain run', () => {
    const w2 = peacefulMap();
    w2.resources.player = 10000;
    const ws2 = workersOf(w2, 'player');
    const builder = must(ws2[0]);
    cmdPlaceBuilding(w2, 'player', 'outpost', spot(w2).x, spot(w2).z, [builder.id]);
    run(w2, 400);                                  // let it finish
    expect(automationSlots(w2, 'player')).toBe(2); // (15 + 8) / 8 -> 2

    cmdFormSquad(w2, 'player', fighters(w2).slice(0, 2), 1);
    cmdFormSquad(w2, 'player', fighters(w2).slice(2), 2);
    const x = must(squadByNumber(w2, 'player', 1));
    const y = must(squadByNumber(w2, 'player', 2));
    cmdAddChainStep(w2, x.id, 'move', -6, 4);
    cmdAddChainStep(w2, y.id, 'move', -10, 4);
    expect(cmdRunChain(w2, x.id).ok).toBe(true);
    expect(cmdRunChain(w2, y.id).ok).toBe(true);
  });
});

// [28] "continues until redirected" (Â§4)
describe('[28] a chain runs until redirected', () => {
  const w = peacefulMap();
  const ids = fighters(w);
  cmdFormSquad(w, 'player', ids, 1);
  const s = squad1(w);
  cmdAddChainStep(w, s.id, 'move', -6, 4);
  cmdAddChainStep(w, s.id, 'move', 4, -4);
  cmdRunChain(w, s.id);
  run(w, 40);
  const runningBefore = s.running;
  cmdMove(w, [must(ids[0])], 12, 12);          // hand-issued order to one member

  it('was running before the order', () => expect(runningBefore).toBe(true));
  it('a manual order takes the squad off automation', () => expect(s.running).toBe(false));
  it('the squad still exists â€” redirected, not disbanded', () => {
    expect(squadByNumber(w, 'player', 1)).not.toBeNull();
  });
  it('and it can be restarted', () => {
    expect(cmdRunChain(w, s.id).ok).toBe(true);
    expect(s.running).toBe(true);
  });
});

// [29] a gather step is ongoing, and works
describe('[29] a gather chain step puts workers to work', () => {
  const w = peacefulMap();
  const ws = workersOf(w, 'player');
  cmdFormSquad(w, 'player', ws.map(u => u.id), 1);
  const s = squad1(w);
  const node = must(w.nodes.find(n => n.x < 0));
  cmdAddChainStep(w, s.id, 'gather', node.x, node.z);
  cmdRunChain(w, s.id);
  run(w, 1200);

  it('essence is being banked with no further input', () => {
    expect(w.resources.player).toBeGreaterThan(0);
  });
  it('workers are employed', () => {
    expect(ws.some(u => gatherOf(u).state !== 'idle')).toBe(true);
  });
  it('the step is ongoing â€” the chain has not advanced past it', () => {
    expect(s.index).toBe(0);
    expect(s.running).toBe(true);
  });
});

// [30] a step that cannot finish must not wedge the chain
describe('[30] an unreachable step times out instead of deadlocking', () => {
  const w = peacefulMap();
  cmdFormSquad(w, 'player', fighters(w), 1);
  const s = squad1(w);
  // far outside the map â€” the squad can never arrive
  cmdAddChainStep(w, s.id, 'move', 5000, 5000);
  cmdAddChainStep(w, s.id, 'move', -6, 4);
  cmdRunChain(w, s.id);
  run(w, AUTOMATION.stepTimeout + 60);

  it('the chain moved past the impossible step', () => expect(s.index).not.toBe(0));
  it('and is still running', () => expect(s.running).toBe(true));
});

// [31] chain editing
describe('[31] chain editing', () => {
  const w = peacefulMap();
  cmdFormSquad(w, 'player', fighters(w), 1);
  const s = squad1(w);

  it('steps are capped', () => {
    for (let i = 0; i < AUTOMATION.maxChainSteps + 3; i++) {
      cmdAddChainStep(w, s.id, 'move', i, i);
    }
    expect(s.chain.length).toBe(AUTOMATION.maxChainSteps);
  });
  it('a step can be removed', () => {
    const before = s.chain.length;
    expect(cmdRemoveChainStep(w, s.id, 0).ok).toBe(true);
    expect(s.chain.length).toBe(before - 1);
  });
  it('removing a nonexistent step is refused', () => {
    expect(cmdRemoveChainStep(w, s.id, 99).ok).toBe(false);
  });
  it('the chain can be cleared, which stops it', () => {
    cmdRunChain(w, s.id);
    cmdClearChain(w, s.id);
    expect(s.chain.length).toBe(0);
    expect(s.running).toBe(false);
  });
  it('an empty chain cannot be run', () => {
    expect(cmdRunChain(w, s.id).ok).toBe(false);
  });
  it('stopping frees the automation slot for another squad', () => {
    cmdAddChainStep(w, s.id, 'move', -6, 4);
    cmdRunChain(w, s.id);
    expect(runningSquads(w, 'player')).toBe(1);
    cmdStopChain(w, s.id);
    expect(runningSquads(w, 'player')).toBe(0);
  });
});

// [32] squads clean up after themselves
describe('[32] squads prune dead members', () => {
  it('a squad disbands once it has no members left', () => {
    const w = peacefulMap();
    const ids = fighters(w);
    cmdFormSquad(w, 'player', ids, 1);
    w.units = w.units.filter(u => !ids.includes(u.id));   // wipe the squad out
    run(w, 2);
    expect(squadByNumber(w, 'player', 1)).toBeNull();
  });
});
