import { describe, expect, it } from 'vitest';
import type { EntityId, Team, World } from '../../src/core/types';
import { createWorld } from '../../src/sim/world';
import { spawnBuilding, spawnUnit } from '../../src/sim/entities';
import { UNIT_TYPES } from '../../src/data/units';
import { BUILDING_TYPES } from '../../src/data/buildings';
import {
  UNIT_SILHOUETTE, collectGroundMarks, collectStatusMarks,
  type StatusOptions,
} from '../../src/render/healthBars';
import type { ViewLod } from '../../src/render/lod';

/**
 * The §2.2 contract, asserted as arithmetic over world state.
 *
 * `collectStatusMarks` is a plain function precisely so this suite needs no
 * browser, no renderer and no WebGL context. What it cannot check is that the
 * shader draws what the array describes; that half was verified by driving
 * `?dev=battle` and looking.
 */

const options = (over: Partial<StatusOptions & { shieldWallFraction: (id: EntityId) => number }> = {}) => ({
  alwaysShow: false,
  squadMemberIds: new Set<EntityId>(),
  alpha: 0,
  entityVisible: () => true,
  lodAt: (): ViewLod => 'close',
  heightAt: () => 0,
  flashOf: () => 0,
  shieldWallFraction: () => 0,
  ...over,
});

const emptyWorld = (): World => createWorld(1);

describe('status marks — what earns a bar (BENCHMARKS §2.2)', () => {
  it('draws nothing at all when every unit is whole', () => {
    const world = emptyWorld();
    for (let i = 0; i < 12; i++) spawnUnit(world, 'legionnaire', 'player', i * 2, 0);
    for (let i = 0; i < 12; i++) spawnUnit(world, 'marksman', 'rival', i * 2, 8);
    expect(collectStatusMarks(world, options())).toEqual([]);
  });

  it('draws exactly one mark for a damaged unit, and only that unit', () => {
    const world = emptyWorld();
    const hurt = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    spawnUnit(world, 'legionnaire', 'player', 3, 0);
    spawnUnit(world, 'legionnaire', 'rival', 6, 0);
    hurt.hp -= 30;

    const marks = collectStatusMarks(world, options());
    expect(marks).toHaveLength(1);
    expect(marks[0]!.entityId).toBe(hurt.id);
    expect(marks[0]!.fill).toBeCloseTo(90 / 120, 5);
  });

  it('draws a mark for a selected unit even at full health', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'worker', 'player', 0, 0);
    expect(collectStatusMarks(world, options())).toHaveLength(0);
    unit.selected = true;
    const marks = collectStatusMarks(world, options());
    expect(marks).toHaveLength(1);
    expect(marks[0]!.fill).toBe(1);
  });

  it('never emits two marks for one entity', () => {
    const world = emptyWorld();
    for (let i = 0; i < 20; i++) {
      const u = spawnUnit(world, 'legionnaire', 'player', i * 2, 0);
      u.hp -= 10;
      u.selected = i % 3 === 0;
    }
    const marks = collectStatusMarks(world, options());
    const ids = marks.filter(m => m.kind === 'unit').map(m => m.entityId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });

  it('reports what remains, clamped, never a negative bar', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'marksman', 'player', 0, 0);
    unit.hp = -14;
    const marks = collectStatusMarks(world, options());
    expect(marks[0]!.fill).toBe(0);
  });

  it('hides marks for units the player cannot see', () => {
    const world = emptyWorld();
    const hidden = spawnUnit(world, 'legionnaire', 'rival', 40, 40);
    hidden.hp -= 50;
    const marks = collectStatusMarks(world, options({
      entityVisible: (team: Team) => team === 'player',
    }));
    expect(marks).toEqual([]);
  });
});

describe('squad-first granularity (D-003)', () => {
  const squadOfThree = (world: World) => {
    const members = [
      spawnUnit(world, 'legionnaire', 'player', 0, 0),
      spawnUnit(world, 'legionnaire', 'player', 1, 0),
      spawnUnit(world, 'legionnaire', 'player', 2, 0),
    ];
    world.squads.push({
      id: 900, team: 'player', number: 1, memberIds: members.map(m => m.id),
      chain: [], index: 0, running: false, loop: true, dispatched: false, stepTicks: 0,
      patrolFrom: null, patrolTo: null, patrolHeading: 'to', servingMissionId: null,
    });
    return members;
  };

  it('replaces three damaged unit bars with one squad decorator', () => {
    const world = emptyWorld();
    const members = squadOfThree(world);
    for (const m of members) m.hp -= 20;

    const marks = collectStatusMarks(world, options({
      squadMemberIds: new Set(members.map(m => m.id)),
    }));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('squad');
    expect(marks[0]!.entityId).toBe(900);
  });

  it('shows the squad total, not one member', () => {
    const world = emptyWorld();
    const members = squadOfThree(world);
    members[0]!.hp = 0;
    const marks = collectStatusMarks(world, options({
      squadMemberIds: new Set(members.map(m => m.id)),
    }));
    // 0 + 120 + 120 of a 360 ceiling.
    expect(marks[0]!.fill).toBeCloseTo(240 / 360, 5);
  });

  it('places the decorator at the squad centroid and above the tallest member', () => {
    const world = emptyWorld();
    const members = squadOfThree(world);
    members[0]!.hp -= 1;
    const marks = collectStatusMarks(world, options({
      squadMemberIds: new Set(members.map(m => m.id)),
    }));
    expect(marks[0]!.x).toBeCloseTo(1, 5);
    expect(marks[0]!.y).toBeGreaterThan(UNIT_SILHOUETTE.legionnaire.markY);
  });

  it('draws no decorator for an untouched squad', () => {
    const world = emptyWorld();
    const members = squadOfThree(world);
    expect(collectStatusMarks(world, options({
      squadMemberIds: new Set(members.map(m => m.id)),
    }))).toEqual([]);
  });
});

describe('the persistent always-show option (§2.2, Warcraft III)', () => {
  it('marks every unit including squad members, at full health', () => {
    const world = emptyWorld();
    const a = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    const b = spawnUnit(world, 'marksman', 'player', 2, 0);
    const marks = collectStatusMarks(world, options({
      alwaysShow: true, squadMemberIds: new Set([a.id]),
    }));
    expect(marks.map(m => m.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(marks.every(m => m.fill === 1)).toBe(true);
  });
});

describe('buildings and construction sites', () => {
  it('marks a damaged building and leaves an untouched one alone', () => {
    const world = emptyWorld();
    const hit = spawnBuilding(world, 'standard', 'player', 0, 0);
    spawnBuilding(world, 'outpost', 'rival', 20, 0);
    hit.hp -= 700;
    const marks = collectStatusMarks(world, options());
    expect(marks).toHaveLength(1);
    expect(marks[0]!.kind).toBe('building');
    expect(marks[0]!.fill).toBeCloseTo((BUILDING_TYPES.standard.hp - 700) / BUILDING_TYPES.standard.hp, 5);
  });

  it('always gives a construction site a progress mark, including at zero', () => {
    const world = emptyWorld();
    world.sites.push({
      id: 5, type: 'outpost', team: 'player', x: 3, z: 4, radius: 1.4,
      progress: 0, required: 150,
    });
    const zero = collectStatusMarks(world, options());
    expect(zero).toHaveLength(1);
    expect(zero[0]!.kind).toBe('site');
    expect(zero[0]!.fill).toBe(0);

    world.sites[0]!.progress = 90;
    expect(collectStatusMarks(world, options())[0]!.fill).toBeCloseTo(0.6, 5);
  });
});

describe('mark geometry', () => {
  /**
   * Vertical pixels per world unit at distance d, for the 45-degree camera in
   * `camera.ts` at 1080 lines. Pixels are square, so the same figure sizes a
   * bar's height and its width.
   */
  const pxPerWorldUnit = (d: number, fovDeg = 45, height = 1080) =>
    height / (2 * d * Math.tan((fovDeg * Math.PI) / 180 / 2));

  it('clears three device pixels at the far edge of every tactical tier', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'worker', 'player', 0, 0);
    unit.hp -= 1;
    const bar = collectStatusMarks(world, options())[0]!;
    // The `tactical` thresholds in lod.ts, low through high.
    for (const farEdge of [62, 82, 105]) {
      expect(bar.height * pxPerWorldUnit(farEdge)).toBeGreaterThanOrEqual(3);
    }
  });

  it('is never narrower than the body it belongs to', () => {
    const world = emptyWorld();
    for (const type of ['legionnaire', 'marksman', 'worker'] as const) {
      const unit = spawnUnit(world, type, 'player', 0, 0);
      unit.hp -= 1;
      const bar = collectStatusMarks(world, options())[0]!;
      // A hexagonal cylinder projects between 1.732r and 2r wide depending on
      // yaw, so the widest the body can ever read is its full diameter.
      expect(bar.width).toBeGreaterThanOrEqual(UNIT_SILHOUETTE[type].radiusBottom * 2);
      world.units.length = 0;
    }
  });

  it('clears the top of the body it describes, including the marksman stave', () => {
    for (const type of ['legionnaire', 'marksman', 'worker'] as const) {
      const shape = UNIT_SILHOUETTE[type];
      expect(shape.markY).toBeGreaterThan(shape.bodyHeight + 0.35 + shape.headRadius);
    }
    // The stave reaches roughly bodyHeight + 0.1 + half its 1.6 length.
    expect(UNIT_SILHOUETTE.marksman.markY)
      .toBeGreaterThan(UNIT_SILHOUETTE.marksman.bodyHeight + 0.1 + 0.8);
  });

  it('keeps silhouette declarations in step with the combat radii they stand on', () => {
    for (const type of ['legionnaire', 'marksman', 'worker'] as const) {
      expect(UNIT_SILHOUETTE[type].halfWidth).toBeGreaterThan(UNIT_TYPES[type].radius);
    }
  });
});

describe('level of detail', () => {
  it('drops unit bars once the body is replaced by a strategic marker', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    unit.hp -= 40;
    expect(collectStatusMarks(world, options({ lodAt: (): ViewLod => 'tactical' }))).toHaveLength(1);
    expect(collectStatusMarks(world, options({ lodAt: (): ViewLod => 'strategic' }))).toEqual([]);
  });

  it('keeps building bars at strategic zoom, where a base is still a shape', () => {
    const world = emptyWorld();
    const b = spawnBuilding(world, 'standard', 'player', 0, 0);
    b.hp -= 100;
    expect(collectStatusMarks(world, options({ lodAt: (): ViewLod => 'strategic' }))).toHaveLength(1);
    expect(collectStatusMarks(world, options({ lodAt: (): ViewLod => 'world' }))).toEqual([]);
  });
});

describe('ground marks — ownership at a glance (BENCHMARKS §2.3)', () => {
  it('gives every visible unit an identity ring, whatever its health', () => {
    const world = emptyWorld();
    spawnUnit(world, 'legionnaire', 'player', 0, 0);
    spawnUnit(world, 'marksman', 'rival', 4, 0);
    const identity = collectGroundMarks(world, options()).filter(m => m.kind === 'identity');
    expect(identity).toHaveLength(2);
  });

  it('separates the two teams by colour, not by shape', () => {
    const world = emptyWorld();
    const mine = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    const theirs = spawnUnit(world, 'legionnaire', 'rival', 4, 0);
    const marks = collectGroundMarks(world, options());
    const ringOf = (id: EntityId) =>
      marks.find(m => m.kind === 'identity' && m.entityId === id)!;
    expect(ringOf(mine.id).color.getHex()).not.toBe(ringOf(theirs.id).color.getHex());
    expect(ringOf(mine.id).radius).toBeCloseTo(ringOf(theirs.id).radius, 6);
  });

  it('adds selection and squad rings without removing the identity ring', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    unit.selected = true;
    const marks = collectGroundMarks(world, options({ squadMemberIds: new Set([unit.id]) }));
    expect(marks.map(m => m.kind).sort()).toEqual(['identity', 'selection', 'squad']);
    // Nested outward, so all three read at once instead of overprinting.
    const radius = (kind: string) => marks.find(m => m.kind === kind)!.radius;
    expect(radius('identity')).toBeLessThan(radius('selection'));
    expect(radius('selection')).toBeLessThan(radius('squad'));
  });

  it('draws the shield-wall glow only for units actually in formation', () => {
    const world = emptyWorld();
    const formed = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    spawnUnit(world, 'legionnaire', 'player', 6, 0);
    const marks = collectGroundMarks(world, options({
      shieldWallFraction: id => (id === formed.id ? 0.6 : 0),
    }));
    const wall = marks.filter(m => m.kind === 'shieldWall');
    expect(wall).toHaveLength(1);
    expect(wall[0]!.entityId).toBe(formed.id);
    expect(wall[0]!.alpha).toBeCloseTo(0.6 * 0.35, 5);
  });

  it('follows the interpolated position, not the raw tick position', () => {
    const world = emptyWorld();
    const unit = spawnUnit(world, 'legionnaire', 'player', 10, 0);
    unit.prevX = 8;
    const half = collectGroundMarks(world, options({ alpha: 0.5 }))
      .find(m => m.kind === 'identity')!;
    expect(half.x).toBeCloseTo(9, 5);
  });
});
