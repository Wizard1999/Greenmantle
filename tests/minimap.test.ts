import { describe, expect, it } from 'vitest';
import { mapBoundaryForSeed } from '../src/sim/mapBoundary';
import { cameraOffset, groundViewPolygon, type CameraState } from '../src/render/cameraMath';
import {
  minimapCanvasToWorld, minimapHeadingRotation, minimapTransform, minimapWorldToCanvas,
} from '../src/ui/minimap';

describe('polygon minimap transforms', () => {
  it('round-trips world coordinates through canvas space', () => {
    const boundary = mapBoundaryForSeed(1337);
    const transform = minimapTransform(boundary, 240, 180);
    const canvas = minimapWorldToCanvas(transform, 8.25, -11.5);
    const world = minimapCanvasToWorld(transform, canvas.x, canvas.y);
    expect(world.x).toBeCloseTo(8.25, 8);
    expect(world.z).toBeCloseTo(-11.5, 8);
  });

  it('centres the canonical map centre in the canvas', () => {
    const boundary = mapBoundaryForSeed(42);
    const transform = minimapTransform(boundary, 300, 200);
    const centre = minimapWorldToCanvas(transform, boundary.center.x, boundary.center.z);
    expect(centre.x).toBeCloseTo(150, 8);
    expect(centre.y).toBeCloseTo(100, 8);
  });
});

const stateAt = (yaw: number, extra: Partial<CameraState> = {}): CameraState => ({
  focusX: 0, focusZ: 0, yaw, pitch: Math.PI * 0.29, distance: 40, ...extra,
});

/**
 * The heading marker was rotated by `-yaw`, which happens to be correct
 * whenever `cos yaw` is zero — so it looked right facing east or west and
 * pointed exactly backwards facing north or south, and survived review.
 *
 * Asserting a rotation value against a hand-derived constant would just
 * re-encode whichever sign convention the author believed. Instead, derive the
 * truth end-to-end: put the camera where `cameraOffset` says it is, project
 * both the focus and the camera through the *same* minimap transform the canvas
 * uses, and require the marker to point from one to the other.
 */
describe('minimap heading marker', () => {
  const boundary = mapBoundaryForSeed(1337);
  const transform = minimapTransform(boundary, 240, 180);

  for (const [label, yaw] of [
    ['north', 0], ['east', Math.PI / 2], ['south', Math.PI], ['west', -Math.PI / 2],
    ['north-east', Math.PI / 4], ['south-west', -Math.PI * 0.75],
  ] as const) {
    it(`points the way the camera looks — ${label}`, () => {
      const state = stateAt(yaw);
      const offset = cameraOffset(state);

      const eye = minimapWorldToCanvas(transform, state.focusX + offset.x, state.focusZ + offset.z);
      const focus = minimapWorldToCanvas(transform, state.focusX, state.focusZ);
      const lookX = focus.x - eye.x;
      const lookY = focus.y - eye.y;
      const lookLen = Math.hypot(lookX, lookY);

      // The marker is drawn apex-up at (0, -1) and rotated by this angle.
      const angle = minimapHeadingRotation(state.yaw);
      const apexX = Math.sin(angle);
      const apexY = -Math.cos(angle);

      expect(apexX).toBeCloseTo(lookX / lookLen, 6);
      expect(apexY).toBeCloseTo(lookY / lookLen, 6);
    });
  }
});

describe('minimap viewport footprint', () => {
  const FOV = (45 * Math.PI) / 180;

  it('surrounds the focus point the camera is looking at', () => {
    const polygon = groundViewPolygon(stateAt(0.7), FOV, 16 / 9);
    const xs = polygon.map(p => p.x);
    const zs = polygon.map(p => p.z);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.min(...zs)).toBeLessThan(0);
    expect(Math.max(...zs)).toBeGreaterThan(0);
  });

  it('covers more ground the further out the camera pulls', () => {
    const area = (state: CameraState): number => {
      const p = groundViewPolygon(state, FOV, 16 / 9);
      // Shoelace over the four corners.
      let sum = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i]!;
        const b = p[(i + 1) % p.length]!;
        sum += a.x * b.z - b.x * a.z;
      }
      return Math.abs(sum) / 2;
    };
    expect(area(stateAt(0, { distance: 120 }))).toBeGreaterThan(area(stateAt(0, { distance: 30 })));
  });

  it('rotates with the camera rather than staying axis-aligned', () => {
    const straight = groundViewPolygon(stateAt(0), FOV, 16 / 9);
    const turned = groundViewPolygon(stateAt(Math.PI / 4), FOV, 16 / 9);
    const moved = straight.some((p, i) => Math.abs(p.x - turned[i]!.x) > 1);
    expect(moved).toBe(true);
  });

  it('stays finite when shallow pitch aims the top corners at the horizon', () => {
    // The failure this guards is a corner ray that never meets the ground:
    // unclamped it produces Infinity and the whole footprint disappears.
    const polygon = groundViewPolygon(stateAt(0, { pitch: Math.PI * 0.026 }), FOV, 16 / 9);
    expect(polygon).toHaveLength(4);
    for (const point of polygon) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
    }
  });

  it('widens with the viewport, so an ultrawide window reports the ground it really shows', () => {
    const spanX = (aspect: number): number => {
      const xs = groundViewPolygon(stateAt(0), FOV, aspect).map(p => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spanX(21 / 9)).toBeGreaterThan(spanX(4 / 3));
  });
});
