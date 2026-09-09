import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId, World } from '../../src/core/types';
import { createWorld } from '../../src/sim/world';
import { spawnBuilding, spawnUnit } from '../../src/sim/entities';
import { syncUnitViews } from '../../src/render/unitViews';
import { sharedFlatMaterialCount, sharedMaterialCount } from '../../src/render/materials';
import type { VisibilityController } from '../../src/ui/visibility';

/**
 * Drives the real `syncUnitViews` against a real `THREE.Scene`.
 *
 * No WebGL context is created — Three builds its object graph on the CPU, so
 * everything up to the draw call is testable in Node. That covers the parts
 * that broke in practice: a body that vanished on the frame it died, and a
 * status layer whose instance count is the §2.2 mark budget.
 *
 * What it cannot cover is whether the shaders draw what the buffers describe.
 * One defect in this round was exactly that — the ground-mark quad was wound
 * face-down and every ring was back-face culled, with correct data in every
 * buffer — and it was found by taking a screenshot, not by a test.
 */

const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000);
  c.position.set(0, 8, 8);
  return c;
};

const seeAll = {
  mode: 'omniscient',
  entityVisible: () => true,
  resourceVisible: () => true,
  terrainKnown: () => true,
  stateAt: () => 2,
  setMode: () => undefined,
  toggle: () => 'omniscient',
} as unknown as VisibilityController;

const sync = (scene: THREE.Scene, world: World, views: Map<EntityId, THREE.Group>): void => {
  syncUnitViews(scene, world, views, 0, new Set(), camera(), 'medium', seeAll);
};

const groundLayerOf = (scene: THREE.Scene): THREE.Mesh | undefined =>
  scene.children.find((o): o is THREE.Mesh =>
    (o as THREE.Mesh).isMesh === true
    && (o as THREE.Mesh).geometry?.getAttribute('aRadius') !== undefined) as THREE.Mesh | undefined;

const barLayerOf = (scene: THREE.Scene): THREE.Mesh | undefined =>
  scene.children.find((o): o is THREE.Mesh =>
    (o as THREE.Mesh).isMesh === true
    && (o as THREE.Mesh).geometry?.getAttribute('aFill') !== undefined) as THREE.Mesh | undefined;

const instances = (mesh: THREE.Mesh | undefined): number =>
  (mesh?.geometry as THREE.InstancedBufferGeometry | undefined)?.instanceCount ?? -1;

describe('a death is drawn before the body leaves the scene', () => {
  it('keeps the body in the scene after the reaper removes the unit', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    const doomed = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    spawnUnit(world, 'legionnaire', 'player', 2, 0);
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    const body = views.get(doomed.id);
    expect(body).toBeDefined();

    // What `stepReaper` does, in the same tick `stepCombat` killed it.
    world.tick += 1;
    world.units = world.units.filter(u => u.id !== doomed.id);
    sync(scene, world, views);

    // Gone from the view map, so the picker cannot select it...
    expect(views.has(doomed.id)).toBe(false);
    // ...but still in the scene, coming apart.
    expect(scene.children).toContain(body);
  });

  it('actually animates the body rather than parking it', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    const doomed = spawnUnit(world, 'legionnaire', 'player', 0, 0);
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    const body = views.get(doomed.id)!;
    const standingY = body.position.y;

    world.tick += 1;
    world.units = [];
    sync(scene, world, views);
    world.tick += 8;
    sync(scene, world, views);

    expect(body.position.y).toBeLessThan(standingY);
    expect(body.children[0]!.scale.x).toBeLessThan(1);
    expect(body.children[0]!.rotation.z).toBeGreaterThan(0);
  });

  it('clears the body once the animation finishes', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    spawnUnit(world, 'legionnaire', 'player', 0, 0);
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    const before = scene.children.length;

    world.tick += 1;
    world.units = [];
    sync(scene, world, views);
    expect(scene.children.length).toBe(before);

    world.tick += 40;   // past the 22-tick fall
    sync(scene, world, views);
    expect(scene.children.length).toBe(before - 1);
  });

  it('does not leave a corpse for a unit that was never on screen', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    spawnUnit(world, 'legionnaire', 'rival', 0, 0);
    const views = new Map<EntityId, THREE.Group>();
    const blind = { ...seeAll, entityVisible: () => false } as unknown as VisibilityController;
    syncUnitViews(scene, world, views, 0, new Set(), camera(), 'medium', blind);
    const before = scene.children.length;

    world.tick += 1;
    world.units = [];
    syncUnitViews(scene, world, views, 0, new Set(), camera(), 'medium', blind);
    expect(scene.children.length).toBe(before - 1);
  });
});

describe('the status layer, as the frame actually builds it', () => {
  it('uploads no bars for an untouched army and some for a hurt one', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    const units = [
      spawnUnit(world, 'legionnaire', 'player', 0, 0),
      spawnUnit(world, 'legionnaire', 'rival', 2, 0),
    ];
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    expect(instances(barLayerOf(scene))).toBe(0);
    expect(barLayerOf(scene)!.visible).toBe(false);

    units[0]!.hp -= 40;
    world.tick += 1;
    sync(scene, world, views);
    expect(instances(barLayerOf(scene))).toBe(1);
    expect(barLayerOf(scene)!.visible).toBe(true);
  });

  it('gives every unit a ground identity ring whatever its health', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    for (let i = 0; i < 5; i++) spawnUnit(world, 'marksman', 'player', i * 1.5 - 3, 0);
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    // Marksmen form no shield wall and nothing is selected, so this is the
    // identity pass alone.
    expect(instances(groundLayerOf(scene))).toBe(5);
  });

  it('costs two draw calls for the whole board, not two per unit', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    for (let i = 0; i < 40; i++) {
      const u = spawnUnit(world, 'legionnaire', i % 2 ? 'player' : 'rival', (i % 8) * 2 - 8, Math.floor(i / 8) * 2);
      u.hp -= 5;
      u.selected = i % 4 === 0;
    }
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    const layers = scene.children.filter(o =>
      (o as THREE.Mesh).geometry !== undefined
      && ((o as THREE.Mesh).geometry as THREE.BufferGeometry).getAttribute('aAnchor') !== undefined);
    // Bars, ground rings, combat effects: three batches, and the effect batch
    // is invisible until something is hit.
    expect(layers).toHaveLength(3);
    expect(instances(barLayerOf(scene))).toBe(40);
    expect(instances(groundLayerOf(scene))).toBeGreaterThanOrEqual(40);
  });
});

describe('materials do not multiply with the army (D-006)', () => {
  it('adds no material per unit', () => {
    const scene = new THREE.Scene();
    const world = createWorld(1);
    spawnBuilding(world, 'standard', 'player', 0, 12);
    for (let i = 0; i < 4; i++) spawnUnit(world, 'legionnaire', 'player', i, 0);
    const views = new Map<EntityId, THREE.Group>();
    sync(scene, world, views);
    const shadersAtFour = sharedMaterialCount();
    const flatsAtFour = sharedFlatMaterialCount();

    for (let i = 0; i < 60; i++) spawnUnit(world, 'marksman', 'rival', i * 0.4 - 12, 3);
    world.tick += 1;
    sync(scene, world, views);

    // Bone and trim for the rival are two new shared entries; nothing scales
    // with the sixty units that arrived.
    expect(sharedMaterialCount() - shadersAtFour).toBeLessThanOrEqual(3);
    expect(sharedFlatMaterialCount() - flatsAtFour).toBeLessThanOrEqual(2);
  });
});
