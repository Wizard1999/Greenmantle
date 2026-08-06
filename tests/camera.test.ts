import { describe, expect, it } from 'vitest';
import {
  cameraOffset, clampCameraState, distanceToFrameBoard, normalizeAngle, panDelta,
  smoothedFocusHeight,
} from '../src/render/cameraMath';
import { terrainHeightAt } from '../src/sim/terrain';

describe('war-table camera math', () => {
  it('clamps focus, pitch, and distance to safe limits', () => {
    const state = clampCameraState({ focusX: 1000, focusZ: -1000, yaw: 20, pitch: -2, distance: 900 });
    expect(state.focusX).toBe(180);
    expect(state.focusZ).toBe(-180);
    expect(state.pitch).toBeGreaterThan(0);
    expect(state.distance).toBe(520);
    expect(state.yaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(state.yaw).toBeLessThan(Math.PI);
  });

  it('keeps camera offset exactly at the requested distance', () => {
    const offset = cameraOffset({ focusX: 0, focusZ: 0, yaw: 0.8, pitch: 0.7, distance: 43 });
    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(43, 10);
  });

  it('rotates pan directions with camera yaw', () => {
    const north = panDelta(0, 0, 1, 34);
    const eastFacing = panDelta(Math.PI / 2, 0, 1, 34);
    expect(north.z).toBeLessThan(0);
    expect(eastFacing.x).toBeLessThan(0);
  });

  it('computes a complete-board overview for different viewport shapes', () => {
    const landscape = distanceToFrameBoard(80, 80, Math.PI / 4, 16 / 9);
    const portrait = distanceToFrameBoard(80, 80, Math.PI / 4, 9 / 16);
    expect(landscape).toBeGreaterThan(80);
    expect(portrait).toBeGreaterThan(landscape);
    expect(portrait).toBeLessThan(520);
  });

  it('normalizes angles without changing equivalent orientation', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(-Math.PI);
  });
});

/**
 * The camera used to bob while panning, which read as a walk cycle.
 *
 * `syncCamera` anchored the look-at point to the raw ground height under the
 * focus, and `terrainHeightAt` carries a short-wavelength ripple — roughly one
 * bump every 18 world units — on top of its broad swell. Dragging the focus
 * across that ripple moved the target vertically every frame.
 *
 * Measure the thing the player actually complained about: how much the look-at
 * height moves per step along a pan path. Asserting the shape of the filter
 * would only restate the implementation.
 */
describe('focus height smoothing', () => {
  /** Worst vertical jump between consecutive frames of a diagonal pan. */
  const roughness = (height: (x: number, z: number) => number): number => {
    let worst = 0;
    let previous = height(-40, -40);
    for (let i = 1; i <= 400; i++) {
      const current = height(-40 + i * 0.2, -40 + i * 0.15);
      worst = Math.max(worst, Math.abs(current - previous));
      previous = current;
    }
    return worst;
  };

  const raw = (x: number, z: number): number => terrainHeightAt(x, z);
  const smoothed = (distance: number) => (x: number, z: number): number =>
    smoothedFocusHeight(terrainHeightAt, x, z, distance);

  it('cuts per-frame vertical movement at ordinary play distance', () => {
    expect(roughness(smoothed(42))).toBeLessThan(roughness(raw) * 0.5);
  });

  it('flattens further the further the camera pulls back, and never re-roughens', () => {
    const byDistance = [2.5, 9, 20, 42, 150, 420].map(d => roughness(smoothed(d)));
    for (let i = 1; i < byDistance.length; i++) {
      expect(byDistance[i]!).toBeLessThanOrEqual(byDistance[i - 1]!);
    }
    // The failure this replaced: a radius that grew with distance aliased once
    // it passed a ripple wavelength, so pulling back made the bob *worse*.
    expect(byDistance.at(-1)).toBe(0);
    expect(byDistance[0]!).toBeGreaterThan(0);
  });

  it('still follows the ground close up, so miniature inspection works', () => {
    // Inside the near threshold the camera tracks real relief; a view pinned to
    // a constant height would sit underground on a rise.
    const low = smoothedFocusHeight(terrainHeightAt, 0, 0, 2.5);
    const high = smoothedFocusHeight(terrainHeightAt, 10.5, 0, 2.5);
    expect(Math.abs(high - low)).toBeGreaterThan(0.1);
  });

  it('settles onto the table plane at war-table range', () => {
    // Past the far threshold the board is an object being examined, not a
    // landscape being flown over, so the height contributes nothing at all.
    for (const x of [-30, 0, 7, 22]) {
      expect(smoothedFocusHeight(terrainHeightAt, x, -13, 150)).toBeCloseTo(0, 10);
    }
  });

  it('never returns a height outside the terrain it sampled', () => {
    for (const d of [2.5, 42, 150, 520]) {
      const value = smoothedFocusHeight(terrainHeightAt, 7, -13, d);
      expect(value).toBeGreaterThan(-1);
      expect(value).toBeLessThan(2.2);
    }
  });
});
