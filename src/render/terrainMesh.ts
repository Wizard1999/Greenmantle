import * as THREE from 'three';
import { terrainHeightAt } from '../sim/terrain';
import { mapBoundaryForSeed, pointInMapBoundary, type MapBoundary } from '../sim/mapBoundary';
import { createPainterlyMaterial } from './painterly';
import { PALETTE } from './palette';
import type { QualitySettings } from './quality';
import { shouldShowWorldSupport } from './lod';

export interface TerrainPresentation {
  mesh: THREE.Mesh;
  boundary: MapBoundary;
  update(camera: THREE.Camera): void;
}

function buildPolygonTerrain(boundary: MapBoundary, segments: number): THREE.BufferGeometry {
  const { minX, minZ, width, depth } = boundary.bounds;
  const segX = Math.max(8, segments);
  const segZ = Math.max(8, Math.round(segments * depth / Math.max(width, 0.001)));
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexByGrid = new Map<string, number>();

  const addVertex = (gx: number, gz: number): number => {
    const key = `${gx}:${gz}`;
    const existing = vertexByGrid.get(key);
    if (existing !== undefined) return existing;
    const x = minX + (gx / segX) * width;
    const z = minZ + (gz / segZ) * depth;
    const index = vertices.length / 3;
    vertices.push(x, terrainHeightAt(x, z), z);
    normals.push(0, 1, 0);
    uvs.push(gx / segX, gz / segZ);
    vertexByGrid.set(key, index);
    return index;
  };

  for (let gz = 0; gz < segZ; gz++) {
    for (let gx = 0; gx < segX; gx++) {
      const cx = minX + ((gx + 0.5) / segX) * width;
      const cz = minZ + ((gz + 0.5) / segZ) * depth;
      if (!pointInMapBoundary(boundary, cx, cz)) continue;
      const a = addVertex(gx, gz);
      const b = addVertex(gx + 1, gz);
      const c = addVertex(gx + 1, gz + 1);
      const d = addVertex(gx, gz + 1);
      indices.push(a, d, b, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** How flat the shell is relative to its radius. */
export const SHELL_FLATTEN = 0.34;

/**
 * Where the World Turtle's parts sit, so that none of it rises above the board
 * it carries.
 *
 * Pure and exported so it can be tested without a GPU. The bug it exists to
 * prevent is subtle and was shipped: the shell's radius scaled with the map
 * while its Y position was a constant, so the carrier grew *upward through* the
 * terrain as the board grew. Deriving every offset from the shell's own
 * half-height makes "below the board" a property of the arithmetic rather than
 * of four magic numbers that happened to suit one map size.
 */
export function worldSupportPlacement(span: number, bodyDepth: number): {
  shellRadius: number;
  shellHalfHeight: number;
  shellTop: number;
  shellY: number;
  headY: number;
  limbY: number;
  tailY: number;
} {
  const shellRadius = span * 0.43;
  const shellHalfHeight = shellRadius * SHELL_FLATTEN;
  // Tucked just under the rim of the descending skirt, so the seam is hidden
  // and nothing of the carrier is visible from directly above.
  const shellTop = -bodyDepth * 0.98;
  const shellY = shellTop - shellHalfHeight;
  return {
    shellRadius,
    shellHalfHeight,
    shellTop,
    shellY,
    headY: shellY + shellHalfHeight * 0.30,
    limbY: shellY + shellHalfHeight * 0.10,
    tailY: shellY + shellHalfHeight * 0.25,
  };
}

function buildBoundarySkirt(boundary: MapBoundary, depth: number): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  const n = boundary.vertices.length;
  for (let i = 0; i < n; i++) {
    const v = boundary.vertices[i]!;
    const top = terrainHeightAt(v.x, v.z) - 0.06;
    vertices.push(v.x, top, v.z, v.x, -depth, v.z);
  }
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const topA = i * 2;
    const bottomA = topA + 1;
    const topB = next * 2;
    const bottomB = topB + 1;
    indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildTerrainMesh(scene: THREE.Scene, q: QualitySettings, mapSeed = 1337): TerrainPresentation {
  const boundary = mapBoundaryForSeed(mapSeed);
  const geo = buildPolygonTerrain(boundary, q.terrainSegments);
  const mesh = new THREE.Mesh(geo, createPainterlyMaterial(PALETTE.grass, {
    soft: 0.2,
    rim: 0.15,
    jitter: 0.07,
  }));
  mesh.receiveShadow = true;
  mesh.name = 'polygon-battlefield';
  scene.add(mesh);

  // Scales with the board: a 12-deep rim reads as a table edge on a 78-wide
  // map and as a sheet of paper on a 312-wide one.
  const bodyDepth = Math.max(12, Math.max(boundary.bounds.width, boundary.bounds.depth) * 0.14);
  const skirt = new THREE.Mesh(
    buildBoundarySkirt(boundary, bodyDepth),
    new THREE.MeshStandardMaterial({ color: 0x11130f, roughness: 0.96, metalness: 0 }),
  );
  skirt.receiveShadow = true;
  skirt.castShadow = true;
  skirt.name = 'battlefield-skirt';
  scene.add(skirt);

  const worldSupport = new THREE.Group();
  worldSupport.name = 'world-turtle-support';
  const span = Math.max(boundary.bounds.width, boundary.bounds.depth);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x182019, roughness: 1, flatShading: true });
  const fleshMat = new THREE.MeshStandardMaterial({ color: 0x111712, roughness: 1, flatShading: true });
  /*
   * Every vertical placement below is derived from the shell's own size.
   *
   * They were absolute constants — shell at y = -8.8, head at -9.8, limbs at
   * -10.2 — while the shell's *radius* scaled with the board. So the shell grew
   * upward as the map grew: at the old 78-unit span its top already sat at
   * +2.6, poking through the terrain, and on the 312-unit board it reached
   * +36.8 and swallowed the battlefield whole. D-026 is explicit that the
   * carrier stays "hidden or only subtly implied" during ordinary play and
   * resolves only at cosmic zoom; a shell you look down onto instead of the
   * ground is the opposite of that.
   */
  const place = worldSupportPlacement(span, bodyDepth);

  const shell = new THREE.Mesh(new THREE.SphereGeometry(place.shellRadius, 18, 10), shellMat);
  shell.scale.set(boundary.bounds.width / span * 1.18, SHELL_FLATTEN, boundary.bounds.depth / span * 1.06);
  shell.position.y = place.shellY;
  worldSupport.add(shell);
  const head = new THREE.Mesh(new THREE.SphereGeometry(span * 0.105, 10, 7), fleshMat);
  head.scale.set(1.3, 0.75, 0.8);
  head.position.set(0, place.headY, -boundary.bounds.depth * 0.63);
  worldSupport.add(head);
  const limbGeo = new THREE.SphereGeometry(span * 0.09, 9, 6);
  for (const [x, z, rz] of [
    [-0.38, -0.33, -0.35], [0.38, -0.33, 0.35],
    [-0.38, 0.34, 0.35], [0.38, 0.34, -0.35],
  ] as const) {
    const limb = new THREE.Mesh(limbGeo, fleshMat);
    limb.scale.set(1.45, 0.52, 0.75);
    limb.position.set(boundary.bounds.width * x, place.limbY, boundary.bounds.depth * z);
    limb.rotation.y = rz;
    worldSupport.add(limb);
  }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(span * 0.055, span * 0.24, 8), fleshMat);
  tail.rotation.x = Math.PI / 2;
  tail.position.set(0, place.tailY, boundary.bounds.depth * 0.65);
  worldSupport.add(tail);
  worldSupport.visible = false;
  scene.add(worldSupport);

  return {
    mesh,
    boundary,
    update(camera) {
      const reveal = shouldShowWorldSupport(camera.position.length());
      worldSupport.visible = reveal;
      skirt.visible = !reveal;
    },
  };
}
