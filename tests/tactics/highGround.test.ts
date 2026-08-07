import { describe, expect, it } from 'vitest';
import { COMBAT } from '../../src/data/tuning';
import { UNIT_TYPES } from '../../src/data/units';
import { elevationMultiplier } from '../../src/sim/combat';
import { HIGH_GROUND_THRESHOLD, terrainHeightAt } from '../../src/sim/terrain';
import type { Team, UnitTypeKey } from '../../src/core/types';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';

/**
 * §2: "Flanking, high ground, ambush, and terrain are extremely important to
 * fight outcomes." This file asks whether the shipped simulation delivers the
 * high-ground half of that claim, and how much it is worth in units.
 *
 * The scenarios are marksman lines rather than legionnaire lines, and that is
 * not a stylistic choice — it is forced, and the reason is the headline finding
 * at the bottom of this file. `HIGH_GROUND_THRESHOLD` is 0.6 and the terrain
 * formula's steepest slope climbs about 0.274 per unit of ground, so the two
 * combatants must stand at least ~2.25 apart before the bonus can exist at all.
 * A Legionnaire's contact reach is 1.74. Only the Marksman, at 8.26, can be far
 * enough from what it is shooting to be meaningfully above it.
 *
 * Every site here is *found by sampling* `terrainHeightAt`, never assumed.
 * B-007 made the terrain even under 180° rotation, so a point and its mirror are
 * now guaranteed to be the same height — any test that located a hill by taking
 * the mirror of a spawn would be searching for something that can no longer
 * exist, and `phase1.test.ts` had exactly that bug. The search here is also
 * whole-formation rather than centre-to-centre: it maximises the gap between the
 * *lowest* point of the high line and the *highest* point of the low one, so no
 * unit in the engagement is quietly on the wrong tier.
 *
 * These fights are static by construction. Both lines start inside weapon reach,
 * so `stepPursuit` leaves them standing (B-006's pursuit only fires when a
 * target is out of range), and a scenario asserts that below. That matters
 * because a unit that walks changes its own elevation mid-fight, which would
 * make the measurement a function of pathing rather than of position.
 */

/** Furthest apart two units of these types can stand and still trade blows. */
function contactReach(attacker: UnitTypeKey, defender: UnitTypeKey): number {
  const a = UNIT_TYPES[attacker];
  return a.combat.range + a.radius + UNIT_TYPES[defender].radius;
}

/** Frontage each line occupies along z. Both sides always hold the same. */
const FRONTAGE = 7;

/** Slack under weapon reach, so a rounding error cannot drop a pair out of
 *  range and turn the scenario into a walking simulation. */
const SEPARATION = contactReach('marksman', 'marksman') - 0.4;

interface Slope {
  /** x of the uphill line. */ hiX: number;
  /** x of the downhill line. */ loX: number;
  /** z the two lines are centred on. */ z: number;
  /** Worst-case height gap across the whole engagement. */ drop: number;
}

/**
 * The steepest place on the board where two lines `separation` apart can face
 * each other with every pair of them on opposite sides of the threshold.
 *
 * Scored on the worst pair rather than the centre pair. A site chosen on its
 * midpoint can have its flanks level, and a scenario built there would measure
 * a half-applied bonus while claiming to measure a whole one.
 */
function steepestSlope(separation: number, frontage: number): Slope {
  let best: Slope = { hiX: 0, loX: separation, z: 0, drop: -Infinity };
  for (let cx = -24; cx <= 24; cx += 0.5) {
    for (let cz = -24; cz <= 24; cz += 0.5) {
      const hiX = cx - separation / 2;
      const loX = cx + separation / 2;
      let hiFloor = Infinity;
      let loCeiling = -Infinity;
      for (let dz = -frontage / 2; dz <= frontage / 2 + 1e-9; dz += 0.25) {
        hiFloor = Math.min(hiFloor, terrainHeightAt(hiX, cz + dz));
        loCeiling = Math.max(loCeiling, terrainHeightAt(loX, cz + dz));
      }
      if (hiFloor - loCeiling > best.drop) {
        best = { hiX, loX, z: cz, drop: hiFloor - loCeiling };
      }
    }
  }
  return best;
}

/** Measured: hiX 6.57, loX 14.43, z 0 — a 1.004 drop across the whole frontage. */
const RIDGE = steepestSlope(SEPARATION, FRONTAGE);

// Facing is pinned so the flank multiplier is 1 for every pair and elevation is
// the only positional term left moving. Left at the spawn default of 0 both
// lines take each other in the side arc, which would inflate both sides' damage
// by 1.15 and make it harder to attribute the result to the hill.
const LOOK_DOWNHILL = Math.PI / 2;   // toward +x, where the low line stands
const LOOK_UPHILL = -Math.PI / 2;

const other = (team: Team): Team => (team === 'player' ? 'rival' : 'player');

/** `hiCount` marksmen on the ridge against `loCount` in the hollow below. */
function slopeFight(hiCount: number, loCount: number, uphill: Team = 'player') {
  return arena([
    ...line('marksman', uphill, hiCount, RIDGE.hiX, {
      zOffset: RIDGE.z, facing: LOOK_DOWNHILL, spacing: FRONTAGE / Math.max(hiCount - 1, 1),
    }),
    ...line('marksman', other(uphill), loCount, RIDGE.loX, {
      zOffset: RIDGE.z, facing: LOOK_UPHILL, spacing: FRONTAGE / Math.max(loCount - 1, 1),
    }),
  ]);
}

/**
 * The same engagement on ground that is level *by construction*.
 *
 * The two lines sit at ±SEPARATION/2 on z = 0, which are 180° mirrors of each
 * other — so B-007's rotational symmetry guarantees they are the same height,
 * for any coefficients a later art pass picks. That makes this a control that
 * cannot silently stop being level.
 */
function levelFight(left: number, right: number) {
  return arena([
    ...line('marksman', 'player', left, -SEPARATION / 2, {
      facing: LOOK_DOWNHILL, spacing: FRONTAGE / Math.max(left - 1, 1),
    }),
    ...line('marksman', 'rival', right, SEPARATION / 2, {
      facing: LOOK_UPHILL, spacing: FRONTAGE / Math.max(right - 1, 1),
    }),
  ]);
}

describe('high ground decides fights', () => {
  it('is fought on a real height gap, found by sampling rather than assumed', () => {
    expect(RIDGE.drop, `worst pair drops ${RIDGE.drop.toFixed(3)}`)
      .toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);

    // Not a spawn asymmetry: the mirror of the ridge is the same ground, which
    // is the property B-007 installed and the reason the gap has to be hunted
    // for locally instead of read off a spawn pair.
    expect(terrainHeightAt(RIDGE.hiX, RIDGE.z))
      .toBeCloseTo(terrainHeightAt(-RIDGE.hiX, -RIDGE.z), 12);

    // Every cross pair, not just the centre one — a flank standing on level
    // ground would dilute the measurement without failing anything obvious.
    const world = slopeFight(8, 8);
    for (const up of unitsOf(world, 'player')) {
      for (const down of unitsOf(world, 'rival')) {
        expect(elevationMultiplier(up, down)).toBe(COMBAT.highGroundBonus);
        expect(elevationMultiplier(down, up)).toBe(COMBAT.lowGroundPenalty);
      }
    }
  });

  it('is decided by where the units stand, not by where they walk', () => {
    // If pursuit dragged either line off its tier the result would be about
    // movement, not elevation. Both lines open inside weapon reach, so nothing
    // should shift by a single float.
    const world = slopeFight(8, 8);
    const spawn = new Map(world.units.map(u => [u.id, { x: u.x, z: u.z }]));
    fightOut(world);
    for (const u of world.units) {
      const at = spawn.get(u.id)!;
      expect(u.x).toBe(at.x);
      expect(u.z).toBe(at.z);
    }
  });

  it('the same force wins from above and loses from below', () => {
    const above = fightOut(slopeFight(8, 8, 'player'));
    const below = fightOut(slopeFight(8, 8, 'rival'));

    expect(above.winner).toBe('player');
    expect(above.survivors).toEqual({ player: 8, rival: 0 });
    expect(margin(above)).toBe(1);

    expect(below.winner).toBe('rival');
    expect(below.survivors).toEqual({ player: 0, rival: 8 });
    expect(margin(below)).toBe(-1);

    // Identical forces, identical ground, only the side of the hill swapped —
    // so the two runs must be exact reflections. Anything else would mean the
    // outcome still carried some of B-005's insertion-order bias.
    expect(above.hp.player).toBe(below.hp.rival);
    expect(above.ticks).toBe(below.ticks);

    // Recorded measurement: a clean sweep, 163.016 HP of 960 left standing
    // (20.4 of 70 per survivor), in 144 ticks — 4.8s at 30Hz, which is §2's
    // "quick and decisive". Re-record deliberately if the tuning changes.
    expect(above.hp.player).toBeCloseTo(163.016, 3);
    expect(above.ticks).toBe(144);
  });

  it('the identical fight on level ground annihilates both sides', () => {
    // The control. Same units, same spacing, same separation, no height gap:
    // if this did anything other than cancel out, the scenario above would be
    // measuring something other than the hill.
    const world = levelFight(8, 8);
    const outcome = fightOut(world);
    expect(outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(outcome.winner).toBeNull();
    expect(margin(outcome)).toBe(0);
  });

  it('pulls ahead from the first volley rather than from a late collapse', () => {
    // §2 wants the *initial positioning* to decide the fight. Read the state
    // well before anyone dies: if the hill only mattered once bodies started
    // dropping, the advantage would be a snowball, not a position.
    const world = slopeFight(8, 8);
    fightOut(world, 108);
    const mid = tally(world);
    expect(mid.survivors).toEqual({ player: 8, rival: 8 });
    // Measured 343.9 against 242.2 — a 1.42x health lead with the casualty
    // count still level, which is the elevation multiplier compounding.
    expect(mid.hp.player / mid.hp.rival).toBeGreaterThan(1.4);
  });
});

describe('high ground against a numerical deficit', () => {
  /** The largest low-ground force the eight on the ridge still beat. */
  function breakEven(hiCount: number): number {
    let last = 0;
    for (let lo = hiCount; lo <= hiCount * 2; lo++) {
      if (fightOut(slopeFight(hiCount, lo)).winner !== 'player') break;
      last = lo;
    }
    return last;
  }

  it('carries a one-in-eight deficit and no more', () => {
    // The break-even point asked for: eight on the ridge beat nine below and
    // lose to ten. High ground is worth between 12.5% and 25% of an army —
    // call it a fifth, and nowhere near the "extremely important" §2 claims for
    // it if that is read as beating a meaningfully larger force.
    expect(breakEven(8)).toBe(9);

    const held = fightOut(slopeFight(8, 9));
    expect(held.winner).toBe('player');
    expect(held.survivors).toEqual({ player: 5, rival: 0 });

    const lost = fightOut(slopeFight(8, 10));
    expect(lost.winner).toBe('rival');
    expect(lost.survivors).toEqual({ player: 0, rival: 2 });
    // Measured 7.0 HP of 700 left on the winning side — a tenth of one unit.
    // Ten below the ridge beat eight on it, but only just, which is the shape
    // §2 asks for even though it lands one unit short of the round number.
    expect(lost.hp.rival).toBeLessThan(UNIT_TYPES.marksman.combat.hp);
  });

  it('flips a fight that level ground loses', () => {
    // The same 8-against-9 with the hill taken away. Without elevation the
    // outnumbered side is wiped and four of the nine walk away, so the hill is
    // not merely padding a win the numbers already gave.
    const level = fightOut(levelFight(8, 9));
    expect(level.winner).toBe('rival');
    expect(level.survivors).toEqual({ player: 0, rival: 4 });
    expect(fightOut(slopeFight(8, 9)).winner).toBe('player');
  });
});

/**
 * Where the claim falls short, and it is not a small shortfall.
 *
 * These two scenarios encode *measured current behaviour*, not the design
 * intent. §2 names high ground as one of four things that decide fights, and
 * §8.7 gives Cohort a core melee unit built entirely around holding a line —
 * but a Legionnaire can never receive or suffer an elevation modifier anywhere
 * on any map, because it has to stand too close to what it is hitting.
 *
 * If either assertion below goes red, the shortfall has been closed and these
 * should be rewritten as the positive claim rather than relaxed.
 */
describe('melee cannot reach high ground at all', () => {
  const MELEE_REACH = contactReach('legionnaire', 'legionnaire');

  it('no two units in melee contact can be on different elevation tiers', () => {
    // Exhaustive over the board and over direction, not a spot check: this is a
    // claim about every tile of every map, and the terrain is a fixed formula
    // (D-017), so it is the same claim for every seed. The disc is swept out to
    // 42, past the largest polygon `mapBoundaryForSeed` can produce (39 x 1.07
    // = 41.7), so the answer covers ground no seed can even reach.
    const REACHABLE = 42;
    let steepest = 0;
    for (let x = -REACHABLE; x <= REACHABLE; x += 0.5) {
      for (let z = -REACHABLE; z <= REACHABLE; z += 0.5) {
        if (Math.hypot(x, z) > REACHABLE) continue;
        const here = terrainHeightAt(x, z);
        for (let k = 0; k < 32; k++) {
          const angle = (k / 32) * Math.PI * 2;
          const there = terrainHeightAt(
            x + Math.cos(angle) * MELEE_REACH,
            z + Math.sin(angle) * MELEE_REACH,
          );
          steepest = Math.max(steepest, here - there);
        }
      }
    }
    // Measured 0.478 against a threshold of 0.600 — 80% of the way there and no
    // further, anywhere. The terrain would have to be ~1.26x steeper, or the
    // threshold drop to 0.47, before a Legionnaire could ever hold a hill.
    // Which lever to pull is the lead's call, not a test's.
    expect(steepest).toBeLessThan(HIGH_GROUND_THRESHOLD);
    expect(steepest).toBeCloseTo(0.478, 2);
  });

  it('so a melee line fights a dead mirror on the steepest ground there is', () => {
    // Same search that found the marksman ridge, run at melee contact distance
    // and a six-unit frontage. It returns the best the map has to offer, and
    // the best the map has to offer is nothing.
    const slope = steepestSlope(MELEE_REACH - 0.04, 5);
    const world = arena([
      ...line('legionnaire', 'player', 6, slope.hiX, { zOffset: slope.z, facing: LOOK_DOWNHILL }),
      ...line('legionnaire', 'rival', 6, slope.loX, { zOffset: slope.z, facing: LOOK_UPHILL }),
    ]);

    for (const up of unitsOf(world, 'player')) {
      for (const down of unitsOf(world, 'rival')) {
        expect(elevationMultiplier(up, down)).toBe(1);
        expect(elevationMultiplier(down, up)).toBe(1);
      }
    }

    const outcome = fightOut(world);
    expect(outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(margin(outcome)).toBe(0);
  });
});
