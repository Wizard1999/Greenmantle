export interface CameraState {
  focusX: number;
  focusZ: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface CameraLimits {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minPitch: number;
  maxPitch: number;
  minDistance: number;
  maxDistance: number;
}

export interface CameraOffset {
  x: number;
  y: number;
  z: number;
}

export const DEFAULT_CAMERA_LIMITS: CameraLimits = {
  // Deliberately wider than the authored terrain: the battlefield is a physical
  // table floating in a void, so the viewer may move beyond its edge and inspect
  // it from miniature level through an almost map-like overhead view.
  minX: -180,
  maxX: 180,
  minZ: -180,
  maxZ: 180,
  minPitch: Math.PI * 0.025,
  maxPitch: Math.PI * 0.495,
  minDistance: 2.5,
  maxDistance: 520,
};

export function clampCameraState(state: CameraState, limits = DEFAULT_CAMERA_LIMITS): CameraState {
  return {
    focusX: Math.min(limits.maxX, Math.max(limits.minX, state.focusX)),
    focusZ: Math.min(limits.maxZ, Math.max(limits.minZ, state.focusZ)),
    yaw: normalizeAngle(state.yaw),
    pitch: Math.min(limits.maxPitch, Math.max(limits.minPitch, state.pitch)),
    distance: Math.min(limits.maxDistance, Math.max(limits.minDistance, state.distance)),
  };
}

/**
 * Returns a conservative perspective-camera distance that frames a rectangular
 * board with breathing room. The calculation uses the tighter vertical or
 * horizontal field of view, so ultrawide and portrait windows both receive a
 * complete-board overview.
 */
export function distanceToFrameBoard(
  width: number,
  depth: number,
  verticalFovRadians: number,
  aspect: number,
  padding = 1.18,
): number {
  const safeAspect = Math.max(0.1, aspect);
  const verticalHalfFov = Math.max(0.01, verticalFovRadians / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
  const halfWidth = Math.max(0, width) * 0.5 * padding;
  const halfDepth = Math.max(0, depth) * 0.5 * padding;
  const forWidth = halfWidth / Math.tan(horizontalHalfFov);
  const forDepth = halfDepth / Math.tan(verticalHalfFov);
  return Math.hypot(Math.max(forWidth, forDepth), Math.max(halfWidth, halfDepth));
}

/**
 * The height the camera should look at, with terrain micro-relief filtered out.
 *
 * Anchoring the look-at point to the raw ground height under the focus makes
 * the camera bob: `terrainHeightAt` carries a short-wavelength ripple (roughly
 * one bump every 18 world units) on top of its broad swell, so panning drags
 * the target up and down continuously and the view reads as a walk cycle. Worse,
 * it is a *rotation* rather than a translation, because the eye's altitude does
 * not move with it — so the horizon rocks.
 *
 * Averaging a ring of samples removes the ripple while keeping the broad shape,
 * and the radius scales with camera distance: close in, the radius is small and
 * the camera still hugs the ground for miniature inspection (D-014); pulled
 * back, it spans more than a full wavelength of both terrain components and the
 * height goes essentially flat, which is what a war table should do.
 *
 * Spatial rather than temporal smoothing on purpose — a time-based filter would
 * be frame-rate dependent and would make the screenshot harness irreproducible.
 * This is a pure function of position and distance.
 */
export function smoothedFocusHeight(
  sample: (x: number, z: number) => number,
  x: number,
  z: number,
  distance: number,
): number {
  // Local average over a ring small enough that eight samples still resolve the
  // terrain ripple. A radius that grows with distance was tried first and is
  // wrong: past about one ripple wavelength the ring aliases, and distance 150
  // came out measurably *rougher* than distance 42.
  const RADIUS = 3;
  const SAMPLES = 8;
  let local = sample(x, z) * SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    local += sample(x + Math.cos(a) * RADIUS, z + Math.sin(a) * RADIUS);
  }
  local /= SAMPLES * 2;

  // Then fade to the table plane as the camera pulls back. This is the war
  // table, not a hovercraft: past tactical range the board is an object being
  // examined and the view should not ride its hills at all. Close in, the
  // camera still follows the ground so miniature inspection works (D-014).
  const NEAR = 8;
  const FAR = 45;
  const away = Math.min(1, Math.max(0, (distance - NEAR) / (FAR - NEAR)));
  return local * (1 - away);
}

export function normalizeAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

export function cameraOffset(state: CameraState): CameraOffset {
  const horizontal = state.distance * Math.cos(state.pitch);
  return {
    x: Math.sin(state.yaw) * horizontal,
    y: Math.sin(state.pitch) * state.distance,
    z: Math.cos(state.yaw) * horizontal,
  };
}

/**
 * The ground footprint of what the camera can currently see, as four world-XZ
 * corners in screen order: bottom-left, bottom-right, top-right, top-left.
 *
 * This is what the minimap draws so the player can read *coverage* rather than
 * merely position. A heading arrow cannot express coverage under D-014's
 * free-orbit camera — the same arrow means a courtyard at miniature zoom and
 * the entire board at war-table zoom.
 *
 * Corners are projected onto the ground plane, not the terrain mesh: a footprint
 * that deforms over every hill would shimmer while the camera moves and would
 * cost a raycast per corner per frame. The error is a few world units on slopes
 * and invisible at minimap scale.
 *
 * **Rays that never meet the ground are clamped, not dropped.** At shallow
 * pitch the upper corners point at or above the horizon and have no
 * intersection at all; `maxRange` pins them to a finite distance so the
 * quadrilateral stays closed and readable instead of inverting or vanishing.
 * The footprint is then a truthful "at least this much" rather than a lie about
 * an infinite view.
 */
export function groundViewPolygon(
  state: CameraState,
  verticalFovRadians: number,
  aspect: number,
  groundY = 0,
  maxRange = DEFAULT_CAMERA_LIMITS.maxDistance * 3,
): Array<{ x: number; z: number }> {
  const offset = cameraOffset(state);
  const eye = { x: state.focusX + offset.x, y: groundY + offset.y, z: state.focusZ + offset.z };

  // Camera basis. Forward points from the eye down at the focus; `right` is
  // horizontal because world up is (0,1,0) and the camera never rolls.
  const fx = -offset.x;
  const fy = -offset.y;
  const fz = -offset.z;
  const fLen = Math.hypot(fx, fy, fz) || 1;
  const forward = { x: fx / fLen, y: fy / fLen, z: fz / fLen };

  const rLen = Math.hypot(forward.z, forward.x) || 1;
  const right = { x: forward.z / rLen, y: 0, z: -forward.x / rLen };

  // up = right × forward
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };

  const tanV = Math.tan(Math.max(0.001, verticalFovRadians / 2));
  const tanH = tanV * Math.max(0.1, aspect);

  const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return corners.map(([sx, sy]) => {
    const dx = forward.x + right.x * sx * tanH + up.x * sy * tanV;
    const dy = forward.y + right.y * sx * tanH + up.y * sy * tanV;
    const dz = forward.z + right.z * sx * tanH + up.z * sy * tanV;
    const dLen = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / dLen;
    const ny = dy / dLen;
    const nz = dz / dLen;

    // Descending rays meet the ground; level or rising ones never do.
    const travel = ny < -1e-6
      ? Math.min((groundY - eye.y) / ny, maxRange)
      : maxRange;

    return { x: eye.x + nx * travel, z: eye.z + nz * travel };
  });
}

/** Converts screen/keyboard pan intent to world-space movement relative to yaw. */
export function panDelta(yaw: number, right: number, forward: number, distance: number): { x: number; z: number } {
  const length = Math.hypot(right, forward);
  if (length === 0) return { x: 0, z: 0 };
  const r = right / length;
  const f = forward / length;
  const scale = 0.65 + distance / 34;
  return {
    x: (Math.cos(yaw) * r - Math.sin(yaw) * f) * scale,
    z: (-Math.sin(yaw) * r - Math.cos(yaw) * f) * scale,
  };
}
