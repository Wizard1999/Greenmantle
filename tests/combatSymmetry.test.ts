import { describe, expect, it } from 'vitest';
import { createWorld, simStep } from '../src/sim/world';
import { spawnUnit } from '../src/sim/entities';
import { stepCombat } from '../src/sim/combat';
import { UNIT_TYPES } from '../src/data/units';
import type { Team, World } from '../src/core/types';

/**
 * Fairness, which is not the same property as determinism (B-005).
 *
 * `determinism.test.ts` proves the simulation produces the same result twice.
 * It was green while a mirrored engagement resolved **10–0 for whichever team
 * was pushed into `world.units` first** — reversing only the insertion order
 * reversed the entire outcome. A fight decided by array position is perfectly
 * deterministic and perfectly unfair, so symmetry needs its own assertions.
 *
 * §2: "Maps are symmetric from spawns — no spawn point has an inherent
 * advantage." That is the claim under test here.
 */

const REACH = UNIT_TYPES.legionnaire.combat.range;

/**
 * Two identical facing lines, mirrored through the origin.
 *
 * `playerFirst` controls only the order the two teams enter `world.units`.
 * Nothing else differs, so any divergence in outcome is array order and
 * nothing more.
 */
function mirroredEngagement(playerFirst: boolean, count = 10): World {
  const world = createWorld(1337, 8, 1337);
  for (let i = 0; i < count; i++) {
    const z = i - (count - 1) / 2;
    const spawn = (team: Team, x: number): void => { spawnUnit(world, 'legionnaire', team, x, z); };
    if (playerFirst) {
      spawn('player', -REACH * 0.4);
      spawn('rival', REACH * 0.4);
    } else {
      spawn('rival', REACH * 0.4);
      spawn('player', -REACH * 0.4);
    }
  }
  return world;
}

function tally(world: World): { player: number; rival: number; playerHp: number; rivalHp: number } {
  const of = (team: Team) => world.units.filter(u => u.team === team);
  return {
    player: of('player').length,
    rival: of('rival').length,
    playerHp: +of('player').reduce((n, u) => n + u.hp, 0).toFixed(6),
    rivalHp: +of('rival').reduce((n, u) => n + u.hp, 0).toFixed(6),
  };
}

function fightToConclusion(world: World, limit = 5400): number {
  let tick = 0;
  for (; tick < limit; tick++) {
    simStep(world);
    const player = world.units.some(u => u.team === 'player');
    const rival = world.units.some(u => u.team === 'rival');
    if (!player || !rival) break;
  }
  return tick;
}

describe('a mirrored engagement is a mirror', () => {
  it('does not depend on which team entered world.units first', () => {
    const a = mirroredEngagement(true);
    const b = mirroredEngagement(false);
    fightToConclusion(a);
    fightToConclusion(b);

    const left = tally(a);
    const right = tally(b);

    // The exact failure that shipped: 10-0 one way, 0-10 the other.
    expect(left.player).toBe(left.rival);
    expect(right.player).toBe(right.rival);
    expect(left).toEqual(right);
  });

  it('leaves both sides on identical health at every tick of the fight', () => {
    // Checking only the end state would miss a bias that opens mid-fight and
    // happens to close by the time everyone is dead.
    const world = mirroredEngagement(true);
    for (let tick = 0; tick < 600; tick++) {
      simStep(world);
      const state = tally(world);
      expect(state.playerHp, `diverged at tick ${tick}`).toBe(state.rivalHp);
      expect(state.player, `diverged at tick ${tick}`).toBe(state.rival);
      if (!state.player || !state.rival) break;
    }
  });

  it('lets a dying unit land the blow it had already thrown', () => {
    // Simultaneous resolution means mutual destruction is reachable. Under the
    // old sequential loop the second unit was removed before it could strike,
    // so one side always walked away.
    const world = createWorld(1337, 8, 1337);
    const a = spawnUnit(world, 'legionnaire', 'player', -REACH * 0.4, 0);
    const b = spawnUnit(world, 'legionnaire', 'rival', REACH * 0.4, 0);
    a.hp = 1;
    b.hp = 1;
    stepCombat(world);
    expect(a.hp).toBeLessThanOrEqual(0);
    expect(b.hp).toBeLessThanOrEqual(0);
  });

  it('applies every attacker on a shared target, not just the first', () => {
    const world = createWorld(1337, 8, 1337);
    const victim = spawnUnit(world, 'legionnaire', 'rival', 0, 0);
    const solo = victim.hp;
    stepCombat(world);
    expect(victim.hp).toBe(solo); // no attackers yet

    const world2 = createWorld(1337, 8, 1337);
    const target = spawnUnit(world2, 'legionnaire', 'rival', 0, 0);
    const before = target.hp;
    spawnUnit(world2, 'legionnaire', 'player', -REACH * 0.4, 0);
    stepCombat(world2);
    const oneAttacker = before - target.hp;

    const world3 = createWorld(1337, 8, 1337);
    const target3 = spawnUnit(world3, 'legionnaire', 'rival', 0, 0);
    const before3 = target3.hp;
    spawnUnit(world3, 'legionnaire', 'player', -REACH * 0.4, 0);
    spawnUnit(world3, 'legionnaire', 'player', REACH * 0.4, 0);
    stepCombat(world3);
    const twoAttackers = before3 - target3.hp;

    expect(oneAttacker).toBeGreaterThan(0);
    expect(twoAttackers).toBeGreaterThan(oneAttacker);
  });
});
