import type { Vec2 } from '../core/types';
import { rngNext, rngSeed } from '../core/rng';
import { BATTLEFIELD } from '../data/tuning';

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
}

export interface MapBoundary {
  /** Counter-clockwise polygon in world X/Z coordinates. */
  vertices: readonly Vec2[];
  bounds: Readonly<MapBounds>;
  center: Readonly<Vec2>;
  radius: number;
}

const VERTEX_COUNT = 12;
/** The map's size is content, not an engine constant — see D-038 and the
 *  `BATTLEFIELD` block. Nothing in `sim/` or `render/` may assume it. */
const BASE_RADIUS = BATTLEFIELD.radius;

/**
 * Generates a deterministic, rotationally symmetric irregular battlefield.
 * Opposite vertices share the same radius, preserving fair 180-degree spawns
 * while allowing each map seed to produce a distinct silhouette.
 */
export function mapBoundaryForSeed(seed: number): MapBoundary {
  const rng = { rngState: rngSeed(seed ^ 0x6d617031) };
  const half = VERTEX_COUNT / 2;
  const radii: number[] = [];
  const angleJitter: number[] = [];
  for (let i = 0; i < half; i++) {
    radii.push(BASE_RADIUS * (0.82 + rngNext(rng) * 0.25));
    angleJitter.push((rngNext(rng) - 0.5) * 0.11);
  }

  const rotation = rngNext(rng) * Math.PI * 2;
  const vertices: Vec2[] = [];
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const pair = i % half;
    const angle = rotation + (i / VERTEX_COUNT) * Math.PI * 2 + angleJitter[pair]!;
    const radius = radii[pair]!;
    vertices.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
  }

  const xs = vertices.map(v => v.x);
  const zs = vertices.map(v => v.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return {
    vertices,
    bounds: { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ },
    center: { x: 0, z: 0 },
    radius: Math.max(...vertices.map(v => Math.hypot(v.x, v.z))),
  };
}

export function pointInMapBoundary(boundary: MapBoundary, x: number, z: number): boolean {
  let inside = false;
  const vertices = boundary.vertices;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i]!;
    const b = vertices[j]!;
    const crosses = ((a.z > z) !== (b.z > z))
      && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True only when a circular footprint remains wholly inside the polygon. */
export function circleInMapBoundary(
  boundary: MapBoundary, x: number, z: number, radius: number, samples = 16,
): boolean {
  if (!pointInMapBoundary(boundary, x, z)) return false;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    if (!pointInMapBoundary(boundary, x + Math.cos(angle) * radius, z + Math.sin(angle) * radius)) {
      return false;
    }
  }
  return true;
}


/**
 * Returns the nearest safe point on the line from the map centre toward the
 * requested destination. The generated maps are radial/star-shaped, so this
 * produces stable, deterministic clamping without needing a pathfinder.
 *
 * `inset` is the radius that must remain inside the board (unit radius,
 * building clearance, etc.). Points already valid are returned unchanged.
 */
export function clampPointToMapBoundary(
  boundary: MapBoundary, x: number, z: number, inset = 0,
): Vec2 {
  const valid = inset > 0
    ? circleInMapBoundary(boundary, x, z, inset)
    : pointInMapBoundary(boundary, x, z);
  if (valid) return { x, z };

  const cx = boundary.center.x;
  const cz = boundary.center.z;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const t = (lo + hi) * 0.5;
    const px = cx + (x - cx) * t;
    const pz = cz + (z - cz) * t;
    const ok = inset > 0
      ? circleInMapBoundary(boundary, px, pz, inset)
      : pointInMapBoundary(boundary, px, pz);
    if (ok) lo = t;
    else hi = t;
  }
  return {
    x: cx + (x - cx) * lo,
    z: cz + (z - cz) * lo,
  };
}

/** Distance from the centre to the polygon edge along a normalized ray. */
export function boundaryDistanceAlongRay(
  boundary: MapBoundary, dx: number, dz: number,
): number {
  const mag = Math.hypot(dx, dz);
  if (mag <= 1e-9) return 0;
  dx /= mag;
  dz /= mag;
  let best = Infinity;
  const vs = boundary.vertices;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const cross = dx * sz - dz * sx;
    if (Math.abs(cross) < 1e-9) continue;
    const t = (a.x * sz - a.z * sx) / cross;
    const u = (a.x * dz - a.z * dx) / cross;
    if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : boundary.radius;
}

export interface MapLayoutAnchor {
  x: number;
  z: number;
  facingX: number;
  facingZ: number;
}

export interface MapLayout {
  playerBase: MapLayoutAnchor;
  rivalBase: MapLayoutAnchor;
  playerResources: readonly Vec2[];
  rivalResources: readonly Vec2[];
  playerWorkers: Vec2;
  rivalWorkers: Vec2;
  playerArmy: Vec2;
  rivalArmy: Vec2;
}

/**
 * Derives symmetric gameplay anchors from the actual polygon instead of fixed
 * square-map coordinates. Every point is mirrored through the origin, so map
 * variety does not create a spawn advantage.
 */
export function mapLayoutForBoundary(boundary: MapBoundary): MapLayout {
  const axisVertex = boundary.vertices.reduce((best, v) =>
    Math.hypot(v.x, v.z) > Math.hypot(best.x, best.z) ? v : best,
  boundary.vertices[0]!);
  const mag = Math.hypot(axisVertex.x, axisVertex.z) || 1;
  const dx = axisVertex.x / mag;
  const dz = axisVertex.z / mag;
  const tx = -dz;
  const tz = dx;
  const edge = boundaryDistanceAlongRay(boundary, dx, dz);

  const mirrored = (p: Vec2): Vec2 => ({ x: -p.x, z: -p.z });
  const safe = (radial: number, lateral: number, inset = 2): Vec2 =>
    clampPointToMapBoundary(
      boundary,
      dx * edge * radial + tx * lateral,
      dz * edge * radial + tz * lateral,
      inset,
    );

  const playerBasePoint = safe(-0.46, 0, 5.5);
  const rivalBasePoint = mirrored(playerBasePoint);

  /**
   * A point at an absolute offset from the player's base — `inward` toward the
   * centre of the map, `lateral` across it.
   *
   * Everything near a base must be placed in world units, not as a fraction of
   * the map. `safe()` mixes a fraction of the edge with an absolute lateral
   * offset, which was invisible while the board was 39 units across and became
   * a defect the moment it grew (D-038): the starting resources moved from
   * about four units off the base to seventeen, and the opening economy stopped
   * working. How far a worker walks on its first trip is a property of the
   * game, not of how big the map happens to be.
   */
  const fromBase = (inward: number, lateral: number): Vec2 => clampPointToMapBoundary(
    boundary,
    playerBasePoint.x + dx * inward + tx * lateral,
    playerBasePoint.z + dz * inward + tz * lateral,
    2,
  );

  /**
   * Two clusters, and the split is the point (B-008).
   *
   * Previously every node on the map sat inside a starting control radius, so
   * §8.1's whole expansion row had nothing to act on — there was nowhere to
   * expand *to*. The home pair sustains the opening; the outer pair sits beyond
   * any starting control radius and toward the middle of the board, so taking
   * it is a decision with a defence problem attached.
   */
  const playerResources = [
    fromBase(7.5, 5.5),
    fromBase(6.0, -6.5),
    safe(-0.20, 11, 2),
    safe(-0.05, -13, 2),
  ];
  const rivalResources = playerResources.map(mirrored);
  const playerWorkers = fromBase(4.5, 2.5);
  const playerArmy = fromBase(8.0, -2.0);

  return {
    playerBase: { ...playerBasePoint, facingX: dx, facingZ: dz },
    rivalBase: { ...rivalBasePoint, facingX: -dx, facingZ: -dz },
    playerResources,
    rivalResources,
    playerWorkers,
    rivalWorkers: mirrored(playerWorkers),
    playerArmy,
    rivalArmy: mirrored(playerArmy),
  };
}
