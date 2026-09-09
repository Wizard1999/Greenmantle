export const TERRAIN_SIZE = 80;
export const TERRAIN_FLOOR = -0.2;

/**
 * Vertical scale on the whole formula (B-009).
 *
 * At 1.0 no melee unit could ever receive an elevation modifier anywhere on any
 * map. The largest height difference available at a Legionnaire's contact reach
 * of 1.74 was 0.4783 against a `HIGH_GROUND_THRESHOLD` of 0.600 — 80% of the
 * way and no further — so high ground was a Marksman-only mechanic while §8.7
 * builds Cohort's core melee unit around holding a line.
 *
 * Three levers could have closed that: lower the threshold, lengthen melee
 * reach, or raise the ground. Raising the ground is the one that keeps high
 * ground *positional*. Lowering the threshold to 0.47 would fire the bonus on
 * very nearly every slope on the board, and a bonus that is always on is not
 * something a commander positions for; lengthening reach would change what
 * melee *is* in order to fix where it can stand.
 *
 * 1.35 rather than the 1.26 that just clears the threshold, because 1.26 clears
 * it at exactly one point. Melee high ground has to be findable to be worth
 * marching to: at 1.26 no sampled site on the board offers it, at 1.30 about
 * 1.3% do, and at 1.35 about 4.0% — roughly one tile in twenty-five, which is
 * scarce enough to be terrain a player reads for and common enough to exist.
 * The ceiling is 1.37: past that a melee pair separated along one axis inside
 * the tactical arena can straddle the threshold, and the flanking suite stops
 * being able to hold elevation still while it measures facing.
 *
 * A scalar cannot disturb the rotational symmetry below — scaling an even
 * function leaves it even — which is what keeps B-007 fixed and is why the
 * amplitude is one multiplier rather than four retuned coefficients.
 */
const RELIEF = 1.35;

/**
 * Single source of truth for terrain height. The render mesh samples this same
 * function rather than duplicating the formula — the two drifting apart was a
 * real Phase 0 bug (06 §6).
 *
 * **Every term is even under 180° rotation about the origin (B-007).** §2
 * requires that no spawn hold an inherent advantage, and the map boundary
 * already delivers that by giving opposite vertices the same radius — but
 * height was left out of it. The previous formula was
 * `sin(0.15x)·cos(0.15z)·1.6 + sin(0.35x + 3.0)·0.5`, whose first term is
 * *anti*-symmetric (rotating negates it) and whose second has no symmetry at
 * all. Measured across 800 mirrored point-pairs: mean height difference 0.69,
 * worst 1.36, and 600 of the 800 pairs differed. With `highGroundBonus` 1.25
 * against `lowGroundPenalty` 0.85, that handed one side free damage in a
 * nominally mirrored engagement, and `world.test.ts` never caught it because it
 * asserts *position* symmetry only.
 *
 * The fix is structural rather than a tuning pass, so it cannot regress by
 * accident. `cos` is even, and `sin·sin` and `cos(x ± z)` are both even under
 * `(x, z) → (-x, -z)`, so any sum of these terms is symmetric by construction —
 * whatever coefficients a later art pass chooses. Clamping to the floor
 * preserves it too.
 *
 * Still a fixed formula, not procedural generation (D-017). D-034 puts passes,
 * cliffs and routes in the generator's hands; when that lands it inherits this
 * constraint, and `tests/terrainSymmetry.test.ts` will hold it to it.
 */
export function terrainHeightAt(x: number, z: number): number {
  const h = (Math.cos(x * 0.15) * Math.cos(z * 0.15) * 1.15
          + Math.sin(x * 0.11) * Math.sin(z * 0.11) * 0.95
          + Math.cos((x + z) * 0.09) * 0.45
          + Math.cos((x - z) * 0.13) * 0.35) * RELIEF;
  return Math.max(h, TERRAIN_FLOOR);
}

// Groundwork for 1.3. Wired to combat at 1.8/1.9.
export const HIGH_GROUND_THRESHOLD = 0.6;

export function elevationAdvantage(ax: number, az: number, bx: number, bz: number): number {
  return terrainHeightAt(ax, az) - terrainHeightAt(bx, bz);
}

export function hasHighGroundOver(ax: number, az: number, bx: number, bz: number): boolean {
  return elevationAdvantage(ax, az, bx, bz) >= HIGH_GROUND_THRESHOLD;
}
