import { describe, expect, it } from 'vitest';
import { createWorld, simStep } from '../src/sim/world';
import { spawnUnit } from '../src/sim/entities';
import { cmdAttackMove, cmdHoldPosition, cmdMove } from '../src/sim/commands';
import { COMBAT } from '../src/data/tuning';
import { UNIT_TYPES } from '../src/data/units';
import type { Team, World } from '../src/core/types';

/**
 * Advance to contact (B-006).
 *
 * `COMBAT.acquireRange` is 9.0 and a Legionnaire's weapon reach is 0.9, so a
 * unit sees an enemy from ten times further than it can hit one. Nothing closed
 * that gap: `stepCombat` wrote `targetId` and `stepMovement` read only
 * `u.target`, a position. Measured before the fix — two ten-unit lines thirty
 * apart, 3600 ticks, **zero damage and zero movement**. Every fight in the game
 * happened only where the player had personally parked units inside 0.9.
 */

function facingPair(gap: number): { world: World; a: ReturnType<typeof spawnUnit>; b: ReturnType<typeof spawnUnit> } {
  const world = createWorld(1337, 8, 1337);
  const a = spawnUnit(world, 'legionnaire', 'player', -gap / 2, 0);
  const b = spawnUnit(world, 'legionnaire', 'rival', gap / 2, 0);
  return { world, a, b };
}

const totalHp = (world: World): number => world.units.reduce((n, u) => n + u.hp, 0);
const teamOf = (world: World, team: Team) => world.units.filter(u => u.team === team);

describe('advance to contact', () => {
  it('closes on an enemy acquired beyond weapon reach', () => {
    // Inside acquire range, far outside weapon range — the exact band that did
    // nothing before.
    const { world, a, b } = facingPair(COMBAT.acquireRange * 0.8);
    const startGap = Math.hypot(b.x - a.x, b.z - a.z);
    const startHp = totalHp(world);

    for (let t = 0; t < 900 && world.units.length === 2; t++) simStep(world);

    const survivors = world.units;
    if (survivors.length === 2) {
      const gap = Math.hypot(survivors[1]!.x - survivors[0]!.x, survivors[1]!.z - survivors[0]!.z);
      expect(gap).toBeLessThan(startGap);
    }
    expect(totalHp(world)).toBeLessThan(startHp);
  });

  it('resolves two lines that start far apart but within acquire range', () => {
    const world = createWorld(1337, 8, 1337);
    for (let i = 0; i < 6; i++) {
      spawnUnit(world, 'legionnaire', 'player', -4, i - 2.5);
      spawnUnit(world, 'legionnaire', 'rival', 4, i - 2.5);
    }
    const startHp = totalHp(world);
    for (let t = 0; t < 2700; t++) {
      simStep(world);
      if (!teamOf(world, 'player').length || !teamOf(world, 'rival').length) break;
    }
    expect(totalHp(world)).toBeLessThan(startHp);
  });

  it('does not chase past the leash', () => {
    const { world, a, b } = facingPair(COMBAT.acquireRange * 0.9);
    const anchorX = a.x;
    // The quarry retreats every tick, staying just inside acquire range, which
    // is exactly the case an unleashed pursuit would follow across the map.
    for (let t = 0; t < 1200; t++) {
      b.x += 0.35;
      b.hp = UNIT_TYPES.legionnaire.combat.hp;
      simStep(world);
      if (!world.units.some(u => u.id === a.id)) break;
    }
    const chaser = world.units.find(u => u.id === a.id);
    if (chaser) {
      expect(Math.abs(chaser.x - anchorX)).toBeLessThanOrEqual(COMBAT.pursuitLeash + 2);
    }
  });

  it('never moves a unit on hold position', () => {
    const { world, a } = facingPair(COMBAT.acquireRange * 0.8);
    cmdHoldPosition(world, [a.id]);
    const x = a.x;
    const z = a.z;
    for (let t = 0; t < 300; t++) simStep(world);
    const held = world.units.find(u => u.id === a.id);
    if (held) {
      expect(held.x).toBeCloseTo(x, 6);
      expect(held.z).toBeCloseTo(z, 6);
    }
  });

  it('does not divert a unit under an explicit move order', () => {
    // A move order names a destination. Wandering off to fight would quietly
    // substitute the engine's judgement for the player's.
    const world = createWorld(1337, 8, 1337);
    const runner = spawnUnit(world, 'legionnaire', 'player', -20, 0);
    spawnUnit(world, 'legionnaire', 'rival', -20, 6);
    cmdMove(world, [runner.id], 20, 0);
    for (let t = 0; t < 240; t++) simStep(world);
    const moved = world.units.find(u => u.id === runner.id);
    // It should be heading east toward the destination, not north to the enemy.
    if (moved) expect(moved.x).toBeGreaterThan(-20);
  });

  it('never sends a worker chasing', () => {
    const world = createWorld(1337, 8, 1337);
    const worker = spawnUnit(world, 'worker', 'player', 0, 0);
    spawnUnit(world, 'legionnaire', 'rival', COMBAT.acquireRange * 0.7, 0);
    const x = worker.x;
    for (let t = 0; t < 200; t++) simStep(world);
    const still = world.units.find(u => u.id === worker.id);
    if (still) expect(still.x).toBeCloseTo(x, 6);
  });

  it('resumes an attack-move route after the fight ends', () => {
    const world = createWorld(1337, 8, 1337);
    const trooper = spawnUnit(world, 'legionnaire', 'player', -20, 0);
    const enemy = spawnUnit(world, 'legionnaire', 'rival', -14, 4);
    // Deliberately outmatched. Two equal Legionnaires now annihilate each other
    // — correct under simultaneous resolution (B-005) — and this test needs a
    // survivor to observe resuming its route.
    enemy.hp = 1;
    cmdAttackMove(world, [trooper.id], 20, 0);

    // Fight until the enemy dies, then keep simulating.
    for (let t = 0; t < 1800; t++) {
      simStep(world);
      if (!world.units.some(u => u.id === enemy.id)) break;
    }
    const before = world.units.find(u => u.id === trooper.id)?.x ?? 0;
    for (let t = 0; t < 600; t++) simStep(world);
    const after = world.units.find(u => u.id === trooper.id)?.x ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});
