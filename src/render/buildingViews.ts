import * as THREE from 'three';
import type { Building, EntityId, World } from '../core/types';
import { BUILDING_TYPES } from '../data/buildings';
import { terrainHeightAt } from '../sim/terrain';
import type { QualityTier } from './quality';
import { lodDistance3D, lodForDistance, strategicMarkerScale } from './lod';
import type { VisibilityController } from '../ui/visibility';
import {
  boneMaterial, glowMaterial, mossMaterial, selectionMarkMaterial, teamMarkMaterial,
  territoryMarkMaterial,
} from './materials';

interface BuildingViewData {
  core: THREE.Mesh;
  sel: THREE.Mesh;
  buildingId: EntityId;
  pickTarget: THREE.Mesh;
  detailPickTarget: THREE.Mesh;
  detailRoot: THREE.Group;
  strategicMarker: THREE.Mesh;
  territoryRing: THREE.Mesh;
}

/**
 * The fossil-and-glow direction from §8.8: bone-pale stone, no visible
 * mechanism, warm internal light at the vital point, moss collecting in the
 * seams. Rival version tinted, same silhouette — still clearly the same
 * civilisation, just a different force.
 */
function makeBuildingView(scene: THREE.Scene, b: Building): THREE.Group {
  const t = BUILDING_TYPES[b.type];
  const isPlayer = b.team === 'player';
  const s = t.radius / 2.2;                        // scale off the Standard
  const stoneMat = boneMaterial(b.team);
  const glowMat = glowMaterial(b.team);
  const mossMat = mossMaterial();

  const g = new THREE.Group();
  const detailRoot = new THREE.Group();
  g.add(detailRoot);

  const drum = new THREE.Mesh(new THREE.CylinderGeometry(2.0 * s, 2.4 * s, 1.5 * s, 6), stoneMat);
  drum.position.y = 0.75 * s;
  drum.castShadow = true;
  drum.receiveShadow = true;
  detailRoot.add(drum);

  // Ribs — fossil, not machinery: no joints, no gears, just weathered bone.
  const ribCount = b.type === 'outpost' ? 4 : 6;
  for (let i = 0; i < ribCount; i++) {
    const a = (i / ribCount) * Math.PI * 2;
    const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.22 * s, 2.6 * s, 5), stoneMat);
    rib.position.set(Math.cos(a) * 1.85 * s, 1.5 * s, Math.sin(a) * 1.85 * s);
    rib.rotation.z = Math.cos(a) * 0.16;
    rib.rotation.x = -Math.sin(a) * 0.16;
    rib.castShadow = true;
    detailRoot.add(rib);
    if (i % 2 === 0) {   // moss gathers in the seams
      const moss = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 * s, 0), mossMat);
      moss.position.set(Math.cos(a) * 1.85 * s, (0.35 + (i % 3) * 0.2) * s, Math.sin(a) * 1.85 * s);
      moss.scale.set(1, 0.55, 1);
      detailRoot.add(moss);
    }
  }

  // The "still faintly alive" tell.
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72 * s, 0), glowMat);
  core.position.y = 2.5 * s;
  detailRoot.add(core);
  const light = new THREE.PointLight(isPlayer ? 0xffcc66 : 0xff8866, 6, 11 * s);
  light.position.y = 2.5 * s;
  detailRoot.add(light);

  // Shared mark materials, not per-building literals. The three colours below
  // used to be four hardcoded hexes that agreed with nothing else on the board;
  // they now come from the one identity table in `palette.ts` (BENCHMARKS §2.3).
  const sel = new THREE.Mesh(
    new THREE.RingGeometry(t.radius + 0.15, t.radius + 0.38, 28), selectionMarkMaterial());
  sel.rotation.x = -Math.PI / 2;
  sel.position.y = 0.06;
  sel.visible = false;
  g.add(sel);


  const strategicMarker = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(0.9, t.radius * 0.42), 14), teamMarkMaterial(b.team),
  );
  strategicMarker.rotation.x = -Math.PI / 2;
  strategicMarker.position.y = 0.12;
  strategicMarker.visible = false;
  g.add(strategicMarker);

  g.position.set(b.x, terrainHeightAt(b.x, b.z), b.z);
  scene.add(g);

  // Control range — territory held, drawn flat on the ground. Follows the
  // terrain so it reads as land rather than a floating UI circle.
  const ringGeo = new THREE.RingGeometry(t.controlRadius - 0.22, t.controlRadius, 96);
  ringGeo.rotateX(-Math.PI / 2);
  const rp = ringGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rp.count; i++) {
    rp.setY(i, terrainHeightAt(b.x + rp.getX(i), b.z + rp.getZ(i)) + 0.09);
  }
  const ring = new THREE.Mesh(ringGeo, territoryMarkMaterial(b.team));
  ring.position.set(b.x, 0, b.z);
  scene.add(ring);
  g.userData = {
    core, sel, buildingId: b.id, pickTarget: drum, detailPickTarget: drum,
    detailRoot, strategicMarker, territoryRing: ring,
  } satisfies BuildingViewData;

  return g;
}

export function syncBuildingViews(
  scene: THREE.Scene, world: World, views: Map<EntityId, THREE.Group>,
  selectedBuildingId: EntityId | null, camera: THREE.Camera, qualityTier: QualityTier,
  visibility: VisibilityController,
): void {
  for (const b of world.buildings) {
    if (!views.has(b.id)) views.set(b.id, makeBuildingView(scene, b));
  }
  // slow pulse on the cores — "still faintly alive", not machinery
  const pulse = 1 + Math.sin(world.tick * 0.045) * 0.09;
  for (const [id, v] of views) {
    const d = v.userData as BuildingViewData;
    const building = world.buildings.find(candidate => candidate.id === id);
    if (!building) { scene.remove(v); views.delete(id); continue; }
    const informationVisible = visibility.entityVisible(building.team, building.x, building.z);
    v.visible = informationVisible;
    d.territoryRing.visible = informationVisible;
    if (!informationVisible) continue;
    d.core.scale.setScalar(pulse);
    const distance = lodDistance3D(
      camera.position.x, camera.position.y, camera.position.z,
      v.position.x, v.position.y, v.position.z,
    );
    const lod = lodForDistance(distance, qualityTier);
    d.detailRoot.visible = lod === 'close' || lod === 'tactical';
    d.strategicMarker.visible = lod === 'strategic' || lod === 'world';
    d.strategicMarker.scale.setScalar(strategicMarkerScale(distance, lod));
    d.pickTarget = d.detailRoot.visible ? d.detailPickTarget : d.strategicMarker;
    v.userData.pickTarget = d.pickTarget;
    d.sel.visible = d.buildingId === selectedBuildingId;
  }
  for (const [id, v] of views) {
    if (world.buildings.some(building => building.id === id)) continue;
    const d = v.userData as BuildingViewData;
    scene.remove(d.territoryRing, v);
    views.delete(id);
  }
}
