import { describe, expect, it } from 'vitest';
import { SHELL_FLATTEN, worldSupportPlacement } from '../../src/render/terrainMesh';
import { TERRAIN_FLOOR } from '../../src/sim/terrain';

/**
 * The World Turtle stays under the board it carries.
 *
 * D-026 is explicit that the carrier is "hidden or only subtly implied" during
 * ordinary play and resolves into a silhouette only at cosmic zoom. What
 * shipped did the opposite: the shell's radius scaled with the map while its Y
 * position was the constant -8.8, so the carrier grew *upward through* the
 * ground. At the original 78-unit span its top already sat at +2.6, above the
 * terrain; on a 312-unit board it reached +36.8 and the player looking down at
 * maximum zoom saw a shell filling the screen instead of a battlefield.
 *
 * Four magic numbers happened to suit one map size. These assert the property
 * instead, at every scale the board might take.
 */
describe('world turtle placement', () => {
  const spans = [78, 156, 312, 640];
  const depthFor = (span: number): number => Math.max(12, span * 0.14);

  it('never rises above the underside of the board, at any map size', () => {
    for (const span of spans) {
      const bodyDepth = depthFor(span);
      const p = worldSupportPlacement(span, bodyDepth);
      const highest = p.shellY + p.shellHalfHeight;
      expect(highest, `span ${span}`).toBeLessThan(-bodyDepth * 0.9);
      // And comfortably below the ground itself, not merely below the rim.
      expect(highest, `span ${span}`).toBeLessThan(TERRAIN_FLOOR);
    }
  });

  it('keeps head, limbs and tail beneath the shell top', () => {
    for (const span of spans) {
      const p = worldSupportPlacement(span, depthFor(span));
      for (const [name, y] of [['head', p.headY], ['limb', p.limbY], ['tail', p.tailY]] as const) {
        expect(y, `${name} at span ${span}`).toBeLessThan(p.shellTop);
      }
    }
  });

  it('scales with the board rather than staying a fixed lump', () => {
    // A carrier that did not grow would look like a pebble under a large map,
    // which is the mirror of the bug above.
    const small = worldSupportPlacement(78, depthFor(78));
    const large = worldSupportPlacement(312, depthFor(312));
    expect(large.shellRadius).toBeCloseTo(small.shellRadius * 4, 6);
    expect(large.shellY).toBeLessThan(small.shellY);
  });

  it('would have caught the shipped defect', () => {
    // The old placement, expressed directly: a constant Y against a radius that
    // scaled. Both map sizes put the shell top above the ground.
    for (const span of spans.slice(0, 3)) {
      const shippedTop = -8.8 + span * 0.43 * SHELL_FLATTEN;
      expect(shippedTop).toBeGreaterThan(TERRAIN_FLOOR);
    }
  });
});
