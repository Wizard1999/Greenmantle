import { describe, expect, it } from 'vitest';
import { HIGH_GROUND_THRESHOLD, terrainHeightAt } from '../src/sim/terrain';
import { mapBoundaryForSeed, mapLayoutForBoundary } from '../src/sim/mapBoundary';
import { COMBAT } from '../src/data/tuning';
import { UNIT_TYPES } from '../src/data/units';

/**
 * Spawn fairness, in elevation (B-007).
 *
 * §2: "Maps are symmetric from spawns — no spawn point has an inherent
 * advantage." The boundary already delivered that, by giving opposite vertices
 * the same radius. Height did not, and nothing checked it: `world.test.ts` and
 * `mapBoundary.test.ts` assert *position* symmetry only, so a terrain formula
 * that was anti-symmetric in one term and asymmetric in the other survived
 * indefinitely. Measured before the fix across 800 mirrored point-pairs: mean
 * difference 0.69, worst 1.36, 600 of 800 pairs unequal.
 *
 * D-037 generalises this: environmental variation is legitimate only when both
 * sides face the same conditions, which makes symmetry a property to assert
 * rather than to hope for. Night, biome and weather effects land under the same
 * rule and belong in this file.
 */
describe('terrain is symmetric between spawns', () => {
  /** Rotating 180° about the origin must not change the ground. */
  const rotationPairs = (): Array<[number, number]> => {
    const points: Array<[number, number]> = [];
    for (let x = -40; x <= 40; x += 2.5) {
      for (let z = -40; z <= 40; z += 2.5) points.push([x, z]);
    }
    return points;
  };

  it('height is identical at every point and its 180° mirror', () => {
    let worst = 0;
    let unequal = 0;
    const points = rotationPairs();
    for (const [x, z] of points) {
      const delta = Math.abs(terrainHeightAt(x, z) - terrainHeightAt(-x, -z));
      worst = Math.max(worst, delta);
      if (delta > 1e-12) unequal++;
    }
    expect(unequal, `${unequal} of ${points.length} pairs differ`).toBe(0);
    expect(worst).toBeLessThan(1e-12);
  });

  it('gives neither side a high-ground advantage anywhere on the field', () => {
    // The consequence that made this a defect rather than a curiosity: with
    // highGroundBonus 1.25 against lowGroundPenalty 0.85, a height gap across
    // the threshold is free damage in a nominally even fight.
    for (const [x, z] of rotationPairs()) {
      const advantage = terrainHeightAt(x, z) - terrainHeightAt(-x, -z);
      expect(Math.abs(advantage)).toBeLessThan(HIGH_GROUND_THRESHOLD);
    }
    expect(COMBAT.highGroundBonus).toBeGreaterThan(COMBAT.lowGroundPenalty);
  });

  it('puts the two starting bases on equal ground, for every seed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const layout = mapLayoutForBoundary(mapBoundaryForSeed(seed));
      const player = terrainHeightAt(layout.playerBase.x, layout.playerBase.z);
      const rival = terrainHeightAt(layout.rivalBase.x, layout.rivalBase.z);
      expect(Math.abs(player - rival), `seed ${seed}`).toBeLessThan(1e-9);
    }
  });

  it('is still worth fighting over — symmetric is not the same as flat', () => {
    // A constant height would satisfy every assertion above and destroy the
    // §2 pillar that terrain decides fights. Require real relief.
    let lowest = Infinity;
    let highest = -Infinity;
    for (const [x, z] of rotationPairs()) {
      const h = terrainHeightAt(x, z);
      lowest = Math.min(lowest, h);
      highest = Math.max(highest, h);
    }
    expect(highest - lowest).toBeGreaterThan(HIGH_GROUND_THRESHOLD * 2);
    expect(highest - lowest).toBeCloseTo(3.635, 2);   // measured, after B-009
  });

  it('carries enough relief for a melee unit to hold a hill (B-009)', () => {
    // The floor under the amplitude, kept next to the symmetry assertions
    // because the two constrain the same formula from opposite sides and a
    // later art pass will be reading both. B-009: at the original amplitude the
    // largest height gap available anywhere at a Legionnaire's 1.74 contact
    // reach was 0.4783 against a 0.600 threshold, so §8.7's core melee unit
    // could never receive or suffer an elevation modifier on any map. Relief is
    // now scaled 1.35x and the gap is 0.6435.
    //
    // Asserted as the local *gradient* rather than by re-running the exhaustive
    // sweep in `tactics/highGround.test.ts`, which is where the tactical
    // consequences are measured. This is the cheap guard that fails first if
    // someone flattens the terrain again.
    const reach = UNIT_TYPES.legionnaire.combat.range + UNIT_TYPES.legionnaire.radius * 2;
    let steepest = 0;
    for (let x = -40; x <= 40; x += 0.5) {
      for (let z = -40; z <= 40; z += 0.5) {
        const here = terrainHeightAt(x, z);
        for (let k = 0; k < 16; k++) {
          const angle = (k / 16) * Math.PI * 2;
          steepest = Math.max(steepest, here - terrainHeightAt(
            x + Math.cos(angle) * reach, z + Math.sin(angle) * reach));
        }
      }
    }
    expect(steepest).toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);
  });

  it('has high ground reachable within an engagement, not only across the map', () => {
    // Relief that only varies over the whole board would never produce an
    // elevation advantage between two units actually fighting each other.
    let found = false;
    for (let x = -36; x <= 36 && !found; x += 1.5) {
      for (let z = -36; z <= 36 && !found; z += 1.5) {
        const here = terrainHeightAt(x, z);
        const probes: Array<[number, number]> = [[COMBAT.acquireRange, 0], [0, COMBAT.acquireRange]];
        for (const [dx, dz] of probes) {
          if (Math.abs(here - terrainHeightAt(x + dx, z + dz)) >= HIGH_GROUND_THRESHOLD) {
            found = true;
            break;
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
