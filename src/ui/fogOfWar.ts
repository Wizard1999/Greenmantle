import type { Building, Unit, World } from '../core/types';
import { pointInMapBoundary, type MapBoundary } from '../sim/mapBoundary';

export type FogState = 0 | 1 | 2; // unexplored, explored, visible

/** How much a remembered-but-unwatched cell is veiled, against 1 for ground
 *  never seen. The gap between the two is what keeps "I scouted this and it is
 *  now stale" legible as a different state from "I have never been here". */
export const EXPLORED_CONCEALMENT = 0.55;

export interface VisionSource {
  x: number;
  z: number;
  radius: number;
}

export interface FogCell {
  x: number;
  z: number;
  width: number;
  depth: number;
  state: FogState;
}

const UNIT_VISION: Record<Unit['type'], number> = {
  worker: 9,
  legionnaire: 11,
  marksman: 14,
};

const BUILDING_VISION: Record<Building['type'], number> = {
  standard: 17,
  outpost: 13,
};

export function playerVisionSources(world: World): VisionSource[] {
  const sources: VisionSource[] = [];
  for (const unit of world.units) {
    if (unit.team === 'player') sources.push({ x: unit.x, z: unit.z, radius: UNIT_VISION[unit.type] });
  }
  for (const building of world.buildings) {
    if (building.team === 'player') {
      sources.push({ x: building.x, z: building.z, radius: BUILDING_VISION[building.type] });
    }
  }
  for (const site of world.sites) {
    if (site.team === 'player') sources.push({ x: site.x, z: site.z, radius: 7 });
  }
  return sources;
}

/**
 * Presentation-side explored/visible field. It never enters deterministic sim
 * state: it is derived from player-owned observers and can be rebuilt while a
 * replay is viewed. The canonical polygon still defines every valid cell.
 */
export class FogOfWarField {
  readonly columns: number;
  readonly rows: number;
  private readonly explored: Uint8Array;
  private readonly visible: Uint8Array;
  /** Cells whose centre lies on the board. Fixed for a given boundary, so it is
   *  computed once rather than re-tested every frame. */
  private readonly inside: Uint8Array;
  private readonly concealmentBuffer: Float32Array;
  private readonly blurBuffer: Float32Array;

  constructor(readonly boundary: MapBoundary, columns = 48, rows = 48) {
    this.columns = Math.max(8, Math.floor(columns));
    this.rows = Math.max(8, Math.floor(rows));
    const size = this.columns * this.rows;
    this.explored = new Uint8Array(size);
    this.visible = new Uint8Array(size);
    this.inside = new Uint8Array(size);
    this.concealmentBuffer = new Float32Array(size);
    this.blurBuffer = new Float32Array(size);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.columns; col++) {
        const p = this.cellCenter(col, row);
        this.inside[row * this.columns + col] = pointInMapBoundary(boundary, p.x, p.z) ? 1 : 0;
      }
    }
  }

  /**
   * How concealed each cell is: 0 in sight, `EXPLORED_CONCEALMENT` remembered,
   * 1 never seen — blurred so the field carries gradients rather than cells.
   *
   * The overlay used to draw one flat quad per cell, which is what made the fog
   * read as a checkerboard of terraces (B-004). Raising the grid resolution
   * would not have helped: more, smaller squares are still squares. A blurred
   * scalar field sampled with linear filtering has no cell edges at all.
   *
   * **Out-of-board cells are excluded from the average rather than treated as
   * unexplored.** Counting them as concealed would drag a dark band inward from
   * the rim; counting them as visible would put a bright halo there. Neither is
   * true — there is simply no ground to describe.
   *
   * Reuses its buffers: this runs every frame.
   */
  concealment(blurPasses = 2): Float32Array {
    const { columns, rows, inside, concealmentBuffer: out, blurBuffer: scratch } = this;
    for (let i = 0; i < out.length; i++) {
      out[i] = this.visible[i] ? 0 : this.explored[i] ? EXPLORED_CONCEALMENT : 1;
    }

    let source = out;
    let target = scratch;
    for (let pass = 0; pass < blurPasses; pass++) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          const index = row * columns + col;
          if (!inside[index]) { target[index] = 1; continue; }
          let total = 0;
          let weight = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const r = row + dz;
            if (r < 0 || r >= rows) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const c = col + dx;
              if (c < 0 || c >= columns) continue;
              const n = r * columns + c;
              if (!inside[n]) continue;
              total += source[n]!;
              weight++;
            }
          }
          target[index] = weight ? total / weight : source[index]!;
        }
      }
      const swap = source; source = target; target = swap;
    }
    if (source !== out) out.set(source);
    return out;
  }

  update(sources: readonly VisionSource[]): void {
    this.visible.fill(0);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.columns; col++) {
        const p = this.cellCenter(col, row);
        if (!pointInMapBoundary(this.boundary, p.x, p.z)) continue;
        const index = row * this.columns + col;
        for (const source of sources) {
          const dx = p.x - source.x;
          const dz = p.z - source.z;
          if (dx * dx + dz * dz <= source.radius * source.radius) {
            this.visible[index] = 1;
            this.explored[index] = 1;
            break;
          }
        }
      }
    }
  }

  stateAt(x: number, z: number): FogState {
    if (!pointInMapBoundary(this.boundary, x, z)) return 0;
    const col = Math.max(0, Math.min(this.columns - 1,
      Math.floor(((x - this.boundary.bounds.minX) / this.boundary.bounds.width) * this.columns)));
    const row = Math.max(0, Math.min(this.rows - 1,
      Math.floor(((z - this.boundary.bounds.minZ) / this.boundary.bounds.depth) * this.rows)));
    const index = row * this.columns + col;
    return this.visible[index] ? 2 : this.explored[index] ? 1 : 0;
  }

  cells(): FogCell[] {
    const width = this.boundary.bounds.width / this.columns;
    const depth = this.boundary.bounds.depth / this.rows;
    const result: FogCell[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.columns; col++) {
        const center = this.cellCenter(col, row);
        if (!pointInMapBoundary(this.boundary, center.x, center.z)) continue;
        const index = row * this.columns + col;
        result.push({
          x: center.x,
          z: center.z,
          width,
          depth,
          state: this.visible[index] ? 2 : this.explored[index] ? 1 : 0,
        });
      }
    }
    return result;
  }

  private cellCenter(col: number, row: number): { x: number; z: number } {
    return {
      x: this.boundary.bounds.minX + ((col + 0.5) / this.columns) * this.boundary.bounds.width,
      z: this.boundary.bounds.minZ + ((row + 0.5) / this.rows) * this.boundary.bounds.depth,
    };
  }
}
