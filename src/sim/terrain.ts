export const TERRAIN_SIZE = 80;
export const TERRAIN_FLOOR = -0.2;

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
  const h = Math.cos(x * 0.15) * Math.cos(z * 0.15) * 1.15
          + Math.sin(x * 0.11) * Math.sin(z * 0.11) * 0.95
          + Math.cos((x + z) * 0.09) * 0.45
          + Math.cos((x - z) * 0.13) * 0.35;
  // NOTE (B-009): at these amplitudes no melee unit can ever receive an
  // elevation modifier. The largest height difference available anywhere on the
  // board at a Legionnaire's contact reach of 1.74 is 0.4797, against
  // HIGH_GROUND_THRESHOLD of 0.6 — so high ground is a Marksman-only mechanic
  // while §8.7 builds Cohort's core melee unit around holding a line. Adding a
  // short-wavelength term fixes it, and was tried; it is a balance lever with
  // two equally valid alternatives (lower the threshold, or lengthen melee
  // reach), so it is the designer's call rather than a defect to patch quietly.
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
