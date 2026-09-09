import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { spawnBuilding, spawnUnit } from '../../src/sim/entities';
import { createHealthMemory, observeDamage } from '../../src/render/combatFeedback';

/**
 * The sim has no event bus and is not getting one — a presentation concern does
 * not belong inside the deterministic core. So the render layer diffs two
 * snapshots, and these are the cases that diff has to get right. Three of them
 * are silences, which is where a naive implementation would be loudest: loading
 * a save, scrubbing a replay, and the very first frame.
 */

const world = () => createWorld(1);

describe('reading damage out of the world', () => {
  it('says nothing on the first look, however hurt the army already is', () => {
    const w = world();
    const unit = spawnUnit(w, 'legionnaire', 'player', 0, 0);
    unit.hp = 5;
    expect(observeDamage(createHealthMemory(), w)).toEqual([]);
  });

  it('reports a hit once the memory is seeded', () => {
    const w = world();
    const unit = spawnUnit(w, 'legionnaire', 'player', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);

    w.tick++;
    unit.hp -= 17;
    const events = observeDamage(memory, w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'unit', id: unit.id, fatal: false, unitType: 'legionnaire' });
    expect(events[0]!.amount).toBeCloseTo(17, 6);
  });

  it('coalesces several attackers on one defender into one impact', () => {
    const w = world();
    const target = spawnUnit(w, 'marksman', 'rival', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);

    // `stepCombat` accumulates damage per target and applies it once, so three
    // attackers land as one subtraction. One target, one effect — which is what
    // keeps §2.6's "simultaneous effects <= attacking units" true for free.
    w.tick++;
    target.hp -= 27;
    expect(observeDamage(memory, w)).toHaveLength(1);
  });

  it('stays quiet for a unit that took nothing', () => {
    const w = world();
    spawnUnit(w, 'legionnaire', 'player', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);
    w.tick++;
    expect(observeDamage(memory, w)).toEqual([])
    ;
  });

  it('ignores healing rather than reporting negative damage', () => {
    const w = world();
    const unit = spawnUnit(w, 'legionnaire', 'player', 0, 0);
    unit.hp = 40;
    const memory = createHealthMemory();
    observeDamage(memory, w);
    w.tick++;
    unit.hp = 90;
    expect(observeDamage(memory, w)).toEqual([]);
  });
});

describe('reading death out of the world', () => {
  it('reports a death on the frame the reaper removes the body', () => {
    const w = world();
    const doomed = spawnUnit(w, 'worker', 'player', 3, 4);
    const memory = createHealthMemory();
    observeDamage(memory, w);

    w.tick++;
    w.units = w.units.filter(u => u.id !== doomed.id);
    const events = observeDamage(memory, w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'unit', id: doomed.id, fatal: true, x: 3, z: 4 });
  });

  it('reports the death at the last place the unit was seen', () => {
    const w = world();
    const doomed = spawnUnit(w, 'legionnaire', 'rival', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);

    w.tick++;
    doomed.x = 21;
    doomed.z = -8;
    doomed.hp -= 50;
    observeDamage(memory, w);

    w.tick++;
    w.units = [];
    const events = observeDamage(memory, w);
    expect(events[0]).toMatchObject({ fatal: true, x: 21, z: -8, team: 'rival' });
  });

  it('reports a razed building', () => {
    const w = world();
    const base = spawnBuilding(w, 'outpost', 'rival', 12, 12);
    const memory = createHealthMemory();
    observeDamage(memory, w);

    w.tick++;
    w.buildings = [];
    const events = observeDamage(memory, w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'building', id: base.id, fatal: true });
  });

  it('forgets a dead unit, so its id cannot report a second death', () => {
    const w = world();
    const doomed = spawnUnit(w, 'worker', 'player', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);
    w.tick++;
    w.units = w.units.filter(u => u.id !== doomed.id);
    observeDamage(memory, w);
    w.tick++;
    expect(observeDamage(memory, w)).toEqual([]);
  });
});

describe('restores and replay scrubs', () => {
  it('treats a world that has gone backwards as a resync, not a massacre', () => {
    const w = world();
    for (let i = 0; i < 8; i++) spawnUnit(w, 'legionnaire', 'player', i, 0);
    const memory = createHealthMemory();
    w.tick = 400;
    observeDamage(memory, w);

    // What a sandbox restore looks like from here: an earlier tick, and most
    // of the army carrying ids the memory has never seen.
    w.tick = 120;
    w.units = w.units.slice(0, 2);
    expect(observeDamage(memory, w)).toEqual([]);
  });

  it('resumes reporting normally once the restored world moves forward', () => {
    const w = world();
    const unit = spawnUnit(w, 'legionnaire', 'player', 0, 0);
    const memory = createHealthMemory();
    w.tick = 400;
    observeDamage(memory, w);
    w.tick = 120;
    observeDamage(memory, w);

    w.tick = 121;
    unit.hp -= 9;
    expect(observeDamage(memory, w)).toHaveLength(1);
  });
});

describe('floating point', () => {
  it('does not fire on a rounding-scale change', () => {
    const w = world();
    const unit = spawnUnit(w, 'legionnaire', 'player', 0, 0);
    const memory = createHealthMemory();
    observeDamage(memory, w);
    w.tick++;
    unit.hp -= 1e-9;
    expect(observeDamage(memory, w)).toEqual([]);
  });
});
