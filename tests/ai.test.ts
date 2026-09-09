import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Unit, UnitTypeKey, World } from '../src/core/types';
import { enableAi, stepAi } from '../src/sim/ai';
import { spawnUnit } from '../src/sim/entities';
import { rallyFor } from '../src/sim/commands';
import { UNIT_TYPES } from '../src/data/units';
import { AI } from '../src/data/tuning';
import { freshMap, must, run } from './helpers';

/**
 * What the AI opponent has to keep doing.
 *
 * These are behaviour tests rather than shape tests: each one fails on a
 * defect that was actually measured in a headless match, and none of them
 * would be caught by the AI merely continuing to issue orders.
 */

/** Whatever this roster calls a fighting unit. Derived, so the suite does not
 *  hardcode a race's names any more than `sim/ai.ts` now does (D-029). */
const FIGHTER = (Object.keys(UNIT_TYPES) as UnitTypeKey[])
  .find(k => !UNIT_TYPES[k].isWorker)!;

const rivalFighters = (w: World): Unit[] =>
  w.units.filter(u => u.team === 'rival' && !u.gather && u.hp > 0);

/** One decision pass, now, whatever the think cadence says. */
const think = (w: World): void => {
  const ai = must(w.ai, 'ai');
  ai.nextThinkTick = w.tick;
  stepAi(w, ai);
};

/** A field army, out at the middle of the board so the four starting fighters
 *  next to the base are the ones the home guard claims. */
const putArmyInTheField = (w: World, count: number): Unit[] => {
  const out: Unit[] = [];
  for (let i = 0; i < count; i++) {
    out.push(spawnUnit(w, FIGHTER, 'rival', i * 1.5 - count, 0));
  }
  return out;
};

const distTo = (u: { x: number; z: number }, p: { x: number; z: number }): number =>
  Math.hypot(u.x - p.x, u.z - p.z);

describe('the assault is an attack-move, not a march', () => {
  // The measured defect: the assault went out as `cmdMove`, and `stepPursuit`
  // refuses to divert a unit under a move order. So the army walked past
  // everything it could see and only ever hit what strayed inside weapon reach
  // — 0.9 units for the melee line, against an acquire range of 9.
  const w = enableAi(freshMap(1337));
  putArmyInTheField(w, 8);
  must(w.ai).attacking = true;
  think(w);

  it('nothing is left on a plain move order', () => {
    expect(rivalFighters(w).filter(u => u.orderMode === 'move')).toHaveLength(0);
  });

  it('the army is under attack-move', () => {
    expect(rivalFighters(w).filter(u => u.orderMode === 'attackMove').length)
      .toBeGreaterThan(0);
  });

  it('an ordered unit closes on an enemy it can see but not reach', () => {
    const world = enableAi(freshMap(1337));
    const army = putArmyInTheField(world, 8);
    const scout = must(army[0], 'unit');
    // Well inside acquire range, well outside any weapon in the roster.
    const prey = spawnUnit(world, FIGHTER, 'player', scout.x + 6, scout.z);
    must(world.ai).attacking = true;
    const before = distTo(scout, prey);
    think(world);
    run(world, 20);
    expect(distTo(scout, prey)).toBeLessThan(before);
  });
});

describe('the army moves in waves', () => {
  it('commits once the wave is assembled', () => {
    const w = enableAi(freshMap(1337));
    putArmyInTheField(w, AI.attackAtArmySize);
    expect(must(w.ai).attacking).toBe(false);
    think(w);
    expect(must(w.ai).attacking).toBe(true);
  });

  it('breaks off when the wave is spent, rather than when it is extinct', () => {
    // The old rule was `fighters.length === 0`, which meant every unit trained
    // during a failing push left home alone and crossed the map alone.
    const w = enableAi(freshMap(1337));
    must(w.ai).attacking = true;
    expect(rivalFighters(w).length).toBeLessThanOrEqual(AI.regroupAtArmySize);
    think(w);
    expect(must(w.ai).attacking).toBe(false);
  });

  it('attacks early against an opponent it is well ahead of', () => {
    const w = enableAi(freshMap(1337));
    // Take the player's army off the board, then field less than a full wave.
    w.units = w.units.filter(u => u.team !== 'player' || u.gather);
    putArmyInTheField(w, AI.attackMinArmySize - rivalFighters(w).length);
    expect(rivalFighters(w).length).toBeLessThan(AI.attackAtArmySize);
    think(w);
    expect(must(w.ai).attacking).toBe(true);
  });
});

describe('it keeps a home guard', () => {
  const w = enableAi(freshMap(1337));
  const base = must(w.buildings.find(b => b.team === 'rival'), 'rival base');
  const enemyBase = must(w.buildings.find(b => b.team === 'player'), 'player base');
  putArmyInTheField(w, 12);
  must(w.ai).attacking = true;
  think(w);

  // A unit already standing on the staging point is given no order at all, so
  // "held back" is counted as "not sent at the enemy" rather than as an order
  // pointing home.
  const sentAway = rivalFighters(w).filter(u =>
    u.target && distTo(u.target, enemyBase) < distTo(u.target, base));

  it('some of the army is sent at the enemy', () => {
    expect(sentAway.length).toBeGreaterThan(0);
  });

  it('and the fighters nearest the base are not', () => {
    // Emptying the base to attack loses to the counterattack it invites: a
    // mirror match used to end with both armies in the middle of the board and
    // the winner walking into an economy with nothing in front of it.
    expect(sentAway.length).toBeLessThanOrEqual(rivalFighters(w).length - AI.garrisonSize);
  });
});

describe('it defends what it owns', () => {
  const w = enableAi(freshMap(1337));
  const base = must(w.buildings.find(b => b.team === 'rival'), 'rival base');
  const enemyBase = must(w.buildings.find(b => b.team === 'player'), 'player base');
  const army = putArmyInTheField(w, 10);
  must(w.ai).attacking = true;
  // A raider inside its territory but outside the range at which anything at
  // home would notice on its own.
  spawnUnit(w, FIGHTER, 'player', base.x + AI.defendRadius * 0.7, base.z);
  think(w);

  it('an attack already in progress turns around', () => {
    for (const u of army) {
      const target = must(u.target, 'target');
      expect(distTo(target, base)).toBeLessThan(distTo(target, enemyBase));
    }
  });
});

describe('it expands onto essence it is not already working', () => {
  // Ringing the base was the old rule, and it cost the middle of every match:
  // the home pair runs dry, the crew walks forty to sixty units each way, and
  // both economies halve at the same moment.
  const w = enableAi(freshMap(1337));
  const base = must(w.buildings.find(b => b.team === 'rival'), 'rival base');
  w.resources.rival = 500;
  think(w);

  it('places a site', () => {
    expect(w.sites.filter(s => s.team === 'rival')).toHaveLength(1);
  });

  it('and places it on a patch no drop-off already serves', () => {
    const site = must(w.sites.find(s => s.team === 'rival'), 'site');
    const claimed = w.nodes
      .filter(n => Math.hypot(n.x - site.x, n.z - site.z) <= AI.expandNodeStandoff * 2.5)
      .filter(n => Math.hypot(n.x - base.x, n.z - base.z) > AI.expandNodeRange);
    expect(claimed.length).toBeGreaterThan(0);
  });
});

describe('it rallies production without trampling the economy', () => {
  const w = enableAi(freshMap(1337));
  const base = must(w.buildings.find(b => b.team === 'rival'), 'rival base');
  const enemyBase = must(w.buildings.find(b => b.team === 'player'), 'player base');
  const workerType = (Object.keys(UNIT_TYPES) as UnitTypeKey[])
    .find(k => UNIT_TYPES[k].isWorker)!;
  think(w);

  it('new fighters walk to the front on their own', () => {
    const rally = rallyFor(base, FIGHTER);
    expect(distTo(rally, enemyBase)).toBeLessThan(distTo(base, enemyBase));
  });

  it('and the worker rally the map set is left alone', () => {
    // The AI sets a rally per fighting type precisely so it cannot overwrite
    // the standing gather job the opening depends on.
    expect(rallyFor(base, workerType).kind).toBe('gather');
  });
});

describe('the engine holds no opinion about the roster (D-029)', () => {
  it('sim/ai.ts names no unit type', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'sim', 'ai.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const named = Object.keys(UNIT_TYPES).filter(k => src.includes(`'${k}'`));
    expect(named).toEqual([]);
  });
});
