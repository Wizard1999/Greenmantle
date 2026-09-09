import * as THREE from 'three';
import type { EntityId, Team, Unit, World } from '../core/types';
import { UNIT_TYPES } from '../data/units';
import { terrainHeightAt } from '../sim/terrain';
import { shieldWallStacks } from '../sim/combat';
import { COMBAT } from '../data/tuning';
import { essenceMat } from './nodeViews';
import type { QualityTier } from './quality';
import { lodDistance3D, lodForDistance, strategicMarkerScale } from './lod';
import type { VisibilityController } from '../ui/visibility';
import { boneMaterial, teamMarkMaterial, trimMaterial } from './materials';
import { TEAM_IDENTITY } from './palette';
import {
  UNIT_SILHOUETTE, collectGroundMarks, collectStatusMarks, createBarPreference, createStatusLayer,
  type BarPreference, type StatusLayer, type StatusOptions,
} from './healthBars';
import { createCombatFeedback, type CombatFeedback } from './combatFeedback';

/**
 * Team identity, for anything that still wants a raw hex.
 *
 * Derived rather than declared: this used to be its own literal table, and the
 * player team consequently read as 47 degrees of hue on the body, 228 on the
 * strategic marker and 44 on the minimap — three vocabularies for one fact
 * (BENCHMARKS §2.3). `palette.ts` holds the one table now.
 */
export const TEAM_COLORS: Record<Team, number> = {
  player: TEAM_IDENTITY.player.mid.getHex(),
  rival: TEAM_IDENTITY.rival.mid.getHex(),
};

/** How long a body takes to come apart, in ticks. Under a second at 30 Hz —
 *  long enough to be seen, short enough that a corpse is never mistaken for a
 *  unit still in the fight. */
const DEATH_TICKS = 22;
/** A rout kills many units at once. Past this the oldest bodies are cleared
 *  immediately rather than letting a wipe cost hundreds of draw calls. */
const MAX_CORPSES = 48;

interface UnitViewData {
  unitId: EntityId;
  carry: THREE.Mesh | null;
  pickTarget: THREE.Mesh;
  detailPickTarget: THREE.Mesh;
  detailRoot: THREE.Group;
  strategicMarker: THREE.Mesh;
}

interface Corpse {
  group: THREE.Group;
  detailRoot: THREE.Group;
  baseY: number;
  diedAt: number;
}

/**
 * Everything the battlefield draws that is not a body, per scene.
 *
 * Hung off the scene rather than held as a module singleton because the
 * screenshot harness and the game each build their own, and a shared pool would
 * mean one scene's corpses sinking into the other's ground. It is built on the
 * first sync rather than passed in because the render callback's call into this
 * module already carries every argument these layers need.
 */
interface BattleLayers {
  status: StatusLayer;
  feedback: CombatFeedback;
  bars: BarPreference;
  corpses: Corpse[];
}

const layersByScene = new WeakMap<THREE.Scene, BattleLayers>();

function layersFor(scene: THREE.Scene): BattleLayers {
  const hit = layersByScene.get(scene);
  if (hit) return hit;
  const made: BattleLayers = {
    status: createStatusLayer(scene),
    feedback: createCombatFeedback(scene),
    bars: createBarPreference(typeof window === 'undefined' ? '' : window.location.search),
    corpses: [],
  };
  layersByScene.set(scene, made);
  return made;
}

function makeUnitView(scene: THREE.Scene, unit: Unit): THREE.Group {
  const g = new THREE.Group();
  const detailRoot = new THREE.Group();
  g.add(detailRoot);
  const isWorker = UNIT_TYPES[unit.type].isWorker;
  const isMarksman = unit.type === 'marksman';
  // Shared, not per-unit: a ShaderMaterial per unit means a shader compile per
  // unit, which stalls exactly when a battle is busiest (see render/materials.ts).
  const bodyMat = boneMaterial(unit.team);
  const trimMat = trimMaterial(unit.team);

  // Silhouette carries the role, since the design brief wants the battlefield
  // readable at a glance: the Legionnaire is broad and low, the Marksman is
  // narrow and tall with a visible long weapon, the worker is smallest. The
  // numbers live in `healthBars.ts` because the status layer sizes marks from
  // the same silhouette, and §2.2 requires a mark never to be narrower than the
  // body it belongs to.
  const shape = UNIT_SILHOUETTE[unit.type];
  const bodyH = shape.bodyHeight;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(shape.radiusTop, shape.radiusBottom, bodyH, 6), bodyMat);
  body.position.y = bodyH * 0.7;
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(shape.headRadius, 0), trimMat);
  head.position.y = bodyH + 0.35;
  body.castShadow = true;
  head.castShadow = true;
  detailRoot.add(body, head);

  if (isMarksman) {
    // Long bone stave, angled back over the shoulder — reads as "ranged"
    // without adding a second material or a projectile.
    const stave = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.6, 5), trimMat);
    stave.position.set(0.26, bodyH + 0.1, -0.05);
    stave.rotation.z = -0.32;
    stave.castShadow = true;
    detailRoot.add(stave);
  }

  if (unit.type === 'legionnaire') {
    // Shield, and the thing the wall bonus is drawn on.
    const shield = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.5), trimMat);
    shield.position.set(-0.36, bodyH * 0.72, 0.06);
    shield.castShadow = true;
    detailRoot.add(shield);
  }

  // carried essence — only workers, only visible while hauling
  let carry: THREE.Mesh | null = null;
  if (isWorker) {
    carry = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), essenceMat);
    carry.position.y = bodyH + 0.85;
    carry.visible = false;
    detailRoot.add(carry);
  }

  // Selection, squad membership and the shield-wall glow are no longer meshes
  // on this group. They are instances in the status layer's single ground
  // batch: three meshes and four `MeshBasicMaterial` objects per unit became
  // two draw calls for the whole board, which is the D-006 argument applied to
  // marks rather than to bodies.
  const strategicMarker = new THREE.Mesh(
    new THREE.CircleGeometry(isWorker ? 0.42 : 0.52, 10), teamMarkMaterial(unit.team));
  strategicMarker.rotation.x = -Math.PI / 2;
  strategicMarker.position.y = 0.08;
  strategicMarker.visible = false;
  g.add(strategicMarker);

  g.userData = {
    unitId: unit.id, carry, pickTarget: body, detailPickTarget: body, detailRoot, strategicMarker,
  } satisfies UnitViewData;
  scene.add(g);
  return g;
}

function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  const d = (((b - a + Math.PI) % TAU) + TAU) % TAU - Math.PI;
  return a + d * t;
}

/**
 * Advance the bodies of units that are no longer in the world.
 *
 * `stepReaper` deletes a unit on the same tick `stepCombat` kills it, so
 * without this a body is present in one frame and absent in the next and the
 * player watches an army thin out without ever seeing it die. BENCHMARKS §6
 * asks for the animation to finish before the geometry leaves the scene, and
 * this is the whole of it: the fossil tips, shrinks and sinks back into the
 * ground while a bone-dust puff blooms at chest height.
 *
 * It sinks rather than fades because the bodies use shared materials (D-006) —
 * setting opacity on one would dissolve every unit on its team at once.
 */
function advanceCorpses(scene: THREE.Scene, corpses: Corpse[], simTime: number): void {
  for (let i = corpses.length - 1; i >= 0; i--) {
    const corpse = corpses[i]!;
    const t = (simTime - corpse.diedAt) / DEATH_TICKS;
    // A negative age means the clock went backwards — a restore or a replay
    // scrub, not a body that has not fallen yet.
    if (t >= 1 || t < 0) {
      scene.remove(corpse.group);
      corpses.splice(i, 1);
      continue;
    }
    // Eased, not squared. A pure `t*t` fall barely moves for the first third
    // of its life, which at three ticks a frame meant the body still looked
    // like it was standing when the player's eye went back to it — measured on
    // a captured death sequence, not guessed. It topples first and sinks after.
    const fall = t * (0.35 + 0.65 * t);
    corpse.detailRoot.rotation.z = fall * 1.6;
    corpse.detailRoot.scale.setScalar(Math.max(0.05, 1 - t * 0.35));
    corpse.group.position.y = corpse.baseY - fall * 1.25;
  }
}

/**
 * Interpolates between the previous and current tick so a 30Hz simulation
 * still looks smooth at display refresh rate. Nothing here advances game state.
 *
 * This is also where the status layer and the combat feedback run. They are
 * driven from here rather than from the render callback because everything they
 * need — the world, the camera, the interpolation alpha, the quality tier, the
 * visibility policy and squad membership — is already an argument to this
 * function, and because the marks must be placed at exactly the interpolated
 * positions the bodies are drawn at or they visibly swim a tick behind.
 */
export function syncUnitViews(
  scene: THREE.Scene, world: World, views: Map<EntityId, THREE.Group>,
  alpha: number, squadMemberIds: Set<EntityId>, camera: THREE.Camera, qualityTier: QualityTier,
  visibility: VisibilityController,
): void {
  const layers = layersFor(scene);
  // One index, three consumers below. The removal sweep used to ask
  // `world.units.some(...)` per view, which is a hundred-by-hundred scan every
  // frame at the D-006 target.
  const unitsById = new Map(world.units.map(u => [u.id, u]));
  // The sim clock, not the wall clock: effects freeze with a paused loop and
  // run at quarter speed in the sandbox rather than playing out over a frozen
  // board, and a single-stepped tick advances them exactly one tick.
  const simTime = world.tick + alpha;

  for (const u of world.units) {
    let v = views.get(u.id);
    if (!v) { v = makeUnitView(scene, u); views.set(u.id, v); }
    const d = v.userData as UnitViewData;
    const informationVisible = visibility.entityVisible(u.team, u.x, u.z);
    v.visible = informationVisible;
    if (!informationVisible) continue;
    const x = u.prevX + (u.x - u.prevX) * alpha;
    const z = u.prevZ + (u.z - u.prevZ) * alpha;
    const y = terrainHeightAt(x, z);
    v.position.set(x, y, z);
    v.rotation.y = lerpAngle(u.prevFacing, u.facing, alpha);
    const distance = lodDistance3D(camera.position.x, camera.position.y, camera.position.z, x, y, z);
    const lod = lodForDistance(distance, qualityTier);
    d.detailRoot.visible = lod === 'close' || lod === 'tactical';
    d.strategicMarker.visible = lod === 'strategic' || lod === 'world';
    d.strategicMarker.scale.setScalar(strategicMarkerScale(distance, lod));
    d.pickTarget = d.detailRoot.visible ? d.detailPickTarget : d.strategicMarker;
    v.userData.pickTarget = d.pickTarget;
    if (d.carry) d.carry.visible = (u.gather?.carrying ?? 0) > 0;
  }

  // A view whose unit has left the world becomes a body, not a disappearance.
  // It leaves `views` on the same frame, so the picker can never select a
  // corpse — the selection box reads that map.
  for (const [id, v] of views) {
    if (unitsById.has(id)) continue;
    views.delete(id);
    const d = v.userData as UnitViewData;
    if (!v.visible || !d.detailRoot.visible) { scene.remove(v); continue; }
    d.strategicMarker.visible = false;
    if (d.carry) d.carry.visible = false;
    layers.corpses.push({ group: v, detailRoot: d.detailRoot, baseY: v.position.y, diedAt: simTime });
    layers.feedback.emitDeath(v.position.x, v.position.y + 0.9, v.position.z, 2.2);
  }
  while (layers.corpses.length > MAX_CORPSES) {
    const oldest = layers.corpses.shift();
    if (oldest) scene.remove(oldest.group);
  }
  advanceCorpses(scene, layers.corpses, simTime);

  layers.feedback.observe(world, simTime, terrainHeightAt);
  layers.feedback.update(simTime);

  const wallCap = COMBAT.shieldWallMaxNeighbours;
  const options: StatusOptions & { shieldWallFraction: (id: EntityId) => number } = {
    alwaysShow: layers.bars.alwaysShow,
    squadMemberIds,
    alpha,
    entityVisible: (team, x, z) => visibility.entityVisible(team, x, z),
    lodAt: (x, y, z) => lodForDistance(
      lodDistance3D(camera.position.x, camera.position.y, camera.position.z, x, y, z), qualityTier),
    heightAt: terrainHeightAt,
    flashOf: (kind, id) => layers.feedback.flashOf(kind, id),
    shieldWallFraction: id => {
      const u = unitsById.get(id);
      if (!u || !UNIT_TYPES[u.type].formsShieldWall) return 0;
      return shieldWallStacks(world, u) / wallCap;
    },
  };
  layers.status.syncGround(collectGroundMarks(world, options));
  layers.status.syncBars(collectStatusMarks(world, options));
}
