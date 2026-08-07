import { describe, expect, it } from 'vitest';
import { createWorld, simStep } from '../src/sim/world';
import { spawnUnit } from '../src/sim/entities';
import { cmdAttackMove, cmdMove } from '../src/sim/commands';
import { COMBAT } from '../src/data/tuning';
import type { World } from '../src/core/types';

/**
 * Right-clicking an enemy has to actually attack it.
 *
 * The gesture issued `cmdMove`, which sets `orderMode: 'move'` — the one mode
 * that must never divert, because a move order is a destination the player
 * named. So units walked to a fixed point and engaged only whatever ended up
 * within 0.9 of them on arrival, while the flash message said "attack order".
 * It went unnoticed because until pursuit landed (B-006) *nothing* closed on a
 * target, so no order looked any different from any other.
 *
 * These assert the behaviour a player expects rather than which command
 * function is called, so a future refactor is free to introduce a real
 * target-locked attack order without rewriting them.
 */

const enemyAt = (world: World, x: number, z: number) =>
  spawnUnit(world, 'legionnaire', 'rival', x, z);

describe('ordering an attack', () => {
  it('closes on and destroys a target beyond weapon reach', () => {
    const world = createWorld(1337, 8, 1337);
    const squad = [
      spawnUnit(world, 'legionnaire', 'player', -12, -1),
      spawnUnit(world, 'legionnaire', 'player', -12, 0),
      spawnUnit(world, 'legionnaire', 'player', -12, 1),
    ];
    const target = enemyAt(world, -12 + COMBAT.acquireRange * 0.9, 0);

    cmdAttackMove(world, squad.map(u => u.id), target.x, target.z);
    for (let t = 0; t < 1800; t++) {
      simStep(world);
      if (!world.units.some(u => u.id === target.id)) break;
    }
    expect(world.units.some(u => u.id === target.id)).toBe(false);
  });

  it('engages something met on the way, not only the point clicked', () => {
    // The specific promise the old comment made and the old command broke.
    const world = createWorld(1337, 8, 1337);
    const trooper = spawnUnit(world, 'legionnaire', 'player', -20, 0);
    const bystander = enemyAt(world, -8, 3);

    cmdAttackMove(world, [trooper.id], 25, 0);
    for (let t = 0; t < 2400; t++) {
      simStep(world);
      if (!world.units.some(u => u.id === bystander.id)) break;
    }
    expect(world.units.some(u => u.id === bystander.id)).toBe(false);
  });

  it('a plain move still refuses to divert, so the two orders stay distinct', () => {
    // If move and attack-move behaved the same there would be no way to cross a
    // contested field without being dragged into every skirmish on it.
    const world = createWorld(1337, 8, 1337);
    const runner = spawnUnit(world, 'legionnaire', 'player', -20, 0);
    const bystander = enemyAt(world, -8, 5);
    bystander.hp = 1_000_000; // survives incidental contact, so only diversion shows
    // Pinned: an idle unit pursues, so an unpinned invincible bystander simply
    // walks over and kills the runner, which tests the wrong thing entirely.
    bystander.orderMode = 'hold';

    cmdMove(world, [runner.id], 25, 0);
    for (let t = 0; t < 900; t++) simStep(world);

    const moved = world.units.find(u => u.id === runner.id);
    expect(moved).toBeDefined();
    // Held its line rather than turning aside to the enemy off the route.
    expect(Math.abs(moved!.z)).toBeLessThan(3);
  });
});
