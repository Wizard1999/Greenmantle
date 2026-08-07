import * as THREE from 'three';
import type { World } from '../core/types';
import { terrainHeightAt } from '../sim/terrain';
import type { QualityTier } from './quality';
import { lodForDistance } from './lod';
import { barkMaterial, leafMaterial, rockMaterial } from './materials';

export interface SceneryViews {
  root: THREE.Group;
  sync(camera: THREE.Camera, qualityTier: QualityTier): void;
}

/** Just enough of the visibility controller to ask "may the player see this
 *  ground?" — kept narrow so scenery does not gain a dependency on the whole
 *  fog system. */
export interface SceneryVisibility {
  terrainKnown(x: number, z: number): boolean;
}

export function buildSceneryViews(
  scene: THREE.Scene,
  world: World,
  visibility?: SceneryVisibility,
): SceneryViews {
  const root = new THREE.Group();
  root.name = 'scenery-root';
  scene.add(root);

  /** Each prop with its position, so concealment is a lookup rather than a
   *  search through the scene graph every frame. */
  const placed: Array<{ object: THREE.Object3D; x: number; z: number }> = [];

  const rockMat = rockMaterial();
  const trunkMat = barkMaterial();
  const leafMat = leafMaterial();

  for (const s of world.scenery) {
    const y = terrainHeightAt(s.x, s.z);
    if (s.kind === 'rock') {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s.scale, 0), rockMat);
      rock.position.set(s.x, y + s.scale * 0.6, s.z);
      rock.rotation.set(s.spin, s.spin * 1.7, s.spin * 0.4);
      rock.castShadow = true;
      root.add(rock);
      placed.push({ object: rock, x: s.x, z: s.z });
    } else {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 1.4, 6), trunkMat);
      trunk.position.y = 0.7;
      const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.0, 7), leafMat);
      leaves.position.y = 2.1;
      trunk.castShadow = true;
      leaves.castShadow = true;
      tree.add(trunk, leaves);
      tree.position.set(s.x, y, s.z);
      tree.rotation.y = s.spin;
      root.add(tree);
      placed.push({ object: tree, x: s.x, z: s.z });
    }
  }

  return {
    root,
    sync(camera, qualityTier) {
      const lod = lodForDistance(camera.position.length(), qualityTier);
      root.visible = lod === 'close' || lod === 'tactical';
      if (!root.visible || !visibility) return;

      // Props on ground the player has never seen stay hidden. They were
      // previously drawn fully lit on top of the fog, which looked like trees
      // floating in a void and quietly told the player the shape of terrain
      // they had not scouted. Remembered ground keeps its scenery — that is
      // what "explored" means.
      for (const item of placed) {
        item.object.visible = visibility.terrainKnown(item.x, item.z);
      }
    },
  };
}
