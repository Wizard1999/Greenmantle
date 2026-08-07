import { describe, expect, it } from 'vitest';
import { EXPLORED_CONCEALMENT, FogOfWarField } from '../src/ui/fogOfWar';
import { mapBoundaryForSeed } from '../src/sim/mapBoundary';

/**
 * The fog reads as a field, not as tiles (B-004).
 *
 * `BUGS.md` recorded this as "hard-tiled", which undersold it: the overlay drew
 * one flat quad per grid cell at the terrain height of that cell's centre, so
 * over sloping ground it produced a staircase of terraces with z-fighting seams
 * and terrain slivers punching through. At ordinary play distance it was the
 * loudest thing on screen.
 *
 * The rendering half of the fix — sharing the terrain geometry and sampling
 * with linear filtering — cannot be asserted without a GPU. What *can* be
 * asserted, and is the half that actually removes the cell edges, is that the
 * mask carries gradients rather than a small set of flat values.
 */
describe('fog concealment field', () => {
  const boundary = mapBoundaryForSeed(1337);
  const field = (): FogOfWarField => new FogOfWarField(boundary);

  it('is fully concealed before anything has been seen', () => {
    const values = field().concealment();
    expect(Math.min(...values)).toBe(1);
  });

  it('opens a hole where a vision source stands', () => {
    const f = field();
    f.update([{ x: 0, z: 0, radius: 14 }]);
    const values = f.concealment();
    expect(Math.min(...values)).toBeLessThan(0.05);
    expect(Math.max(...values)).toBe(1);
  });

  it('grades between seen and unseen instead of stepping', () => {
    // The defect in one assertion: a binary mask takes at most three distinct
    // values, so every edge is a cliff. A blurred field takes many, which is
    // what linear filtering then renders as a soft boundary.
    const f = field();
    f.update([{ x: 0, z: 0, radius: 14 }]);
    const values = f.concealment();
    const distinct = new Set(Array.from(values, v => Math.round(v * 100)));
    expect(distinct.size).toBeGreaterThan(8);
  });

  it('keeps remembered ground distinguishable from ground never seen', () => {
    const f = field();
    f.update([{ x: 0, z: 0, radius: 14 }]);
    f.update([]); // the observer leaves; the ground stays explored
    const values = f.concealment();
    const remembered = Math.min(...values);
    expect(remembered).toBeGreaterThan(0.1);
    expect(remembered).toBeLessThan(1);
    expect(remembered).toBeLessThan(EXPLORED_CONCEALMENT + 0.25);
  });

  it('does not drag a dark rim inward from off-board cells', () => {
    // Cells outside the polygon describe no ground. Averaging them in as
    // "unexplored" would darken the whole edge of a fully scouted map.
    const f = field();
    f.update([{ x: 0, z: 0, radius: 500 }]);
    const values = f.concealment();
    expect(Math.max(...values.filter((_, i) => values[i]! < 1))).toBeLessThan(0.05);
  });

  it('reuses its buffer rather than allocating every frame', () => {
    const f = field();
    expect(f.concealment()).toBe(f.concealment());
  });
});
