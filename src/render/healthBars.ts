import * as THREE from 'three';
import type { EntityId, Team, UnitTypeKey, World } from '../core/types';
import { BUILDING_TYPES } from '../data/buildings';
import { maxHp } from '../sim/combat';
import { MARK, TEAM_IDENTITY } from './palette';
import type { ViewLod } from './lod';

/**
 * The status layer: damage, ownership and selection, drawn on the battlefield.
 *
 * Before this file, `grep -rniE "health|\bhp\b" src/render src/ui` returned
 * nothing. A player watching a battle could not tell which side was winning
 * except by counting corpses afterwards, which BENCHMARKS §2.2 names as the
 * largest gap in the presentation layer. Ownership was in a similar state:
 * §8.8 makes both sides bone-pale fossil stone on purpose, so identity has to
 * ride on marks — and the marks disagreed with each other, the player team
 * reading as three unrelated hues depending on camera distance.
 *
 * Two things decide the shape of this module.
 *
 * **It is two draw calls, not two per entity.** §2.2 caps the whole status
 * layer at two draw calls with a hundred units on screen. Everything here is
 * therefore instanced: one screen-facing quad batch for bars and decorators,
 * one ground-plane quad batch for identity, selection, squad and shield-wall
 * rings. The per-unit ring meshes those replace cost three draw calls and four
 * material objects *each*. `fogOverlay.ts` is the pattern being followed;
 * `commandFeedback.ts`, which allocates geometry per event, is the pattern
 * explicitly not being followed.
 *
 * **The policy is pure and the GPU part is thin.** `collectStatusMarks` and
 * `collectGroundMarks` are ordinary functions over world state that return
 * plain arrays, so "no marks at full health", "one mark per damaged entity"
 * and "squads before units" are asserted directly in `tests/render/` with no
 * browser and no renderer. The layer below them only uploads what it is given.
 */

/**
 * On-screen size of each unit body, in world units.
 *
 * Lives here rather than in `unitViews.ts` because two places need the same
 * numbers and they must not drift: the view builds the body from them, and the
 * status layer sizes marks from them. §2.2 requires every mark to be at least
 * as wide as the silhouette it belongs to, and a bar narrower than its unit
 * reads as belonging to whatever is behind it.
 *
 * `markY` clears the tallest part of each unit — the Marksman's stave, the
 * worker's carried Legacy — so a bar never overlaps the thing it describes.
 */
export const UNIT_SILHOUETTE: Record<UnitTypeKey, {
  bodyHeight: number;
  radiusTop: number;
  radiusBottom: number;
  headRadius: number;
  halfWidth: number;
  markY: number;
}> = {
  legionnaire: {
    bodyHeight: 1.0, radiusTop: 0.32, radiusBottom: 0.4, headRadius: 0.28,
    halfWidth: 0.5, markY: 1.98,
  },
  marksman: {
    bodyHeight: 1.1, radiusTop: 0.22, radiusBottom: 0.28, headRadius: 0.21,
    halfWidth: 0.46, markY: 2.22,
  },
  worker: {
    bodyHeight: 0.8, radiusTop: 0.26, radiusBottom: 0.34, headRadius: 0.23,
    halfWidth: 0.44, markY: 1.86,
  },
};

/**
 * Bar height in world units.
 *
 * §2.2 asks for at least three device pixels. Vertical pixels per world unit at
 * distance d is `1080 / (2 * d * tan(fov/2))`, and with the 45-degree camera
 * that is 12.4 at the furthest tactical edge in the codebase (d = 105, the high
 * tier). 0.26 lands at 3.2 px there and 4.2 px at the medium tier's edge.
 * `tests/render/healthBars.test.ts` recomputes that rather than trusting it.
 */
const BAR_HEIGHT = 0.26;
const DECORATOR_HEIGHT = 0.34;

/** Below this fraction of maximum, an entity counts as damaged and earns a
 *  mark. Not 1.0 exactly: damage is floating point and a unit that has taken
 *  none should never flicker a bar from rounding. */
const FULL_HEALTH = 0.999;

export type StatusMarkKind = 'unit' | 'squad' | 'building' | 'site';

export interface StatusMark {
  kind: StatusMarkKind;
  /** Unit, squad, building or site id. One mark per entity, so this is unique
   *  within a kind and the tests can assert exactly that. */
  entityId: EntityId;
  team: Team;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** 0..1. What remains, not what was lost. */
  fill: number;
  /** 0..1 emphasis applied on the frames just after a hit lands. */
  flash: number;
}

export type GroundMarkKind = 'identity' | 'selection' | 'squad' | 'shieldWall';

export interface GroundMark {
  kind: GroundMarkKind;
  entityId: EntityId;
  x: number;
  y: number;
  z: number;
  /** Outer radius in world units. */
  radius: number;
  /** Inner edge as a fraction of the outer radius. 0 draws a filled disc. */
  inner: number;
  color: THREE.Color;
  alpha: number;
}

export interface StatusOptions {
  /** The persistent always-show option (§2.2). Not a held key: §§2 and 4 rule
   *  out a modifier the player holds during a fight, because that is an
   *  execution affordance and this game is not about execution. */
  alwaysShow: boolean;
  /** Every unit currently in any squad, for either team. */
  squadMemberIds: Set<EntityId>;
  /** Interpolation between the previous and current tick, as the render loop
   *  supplies it. Marks lerp with the units they belong to or they lag a whole
   *  tick behind and visibly swim. */
  alpha: number;
  entityVisible: (team: Team, x: number, z: number) => boolean;
  lodAt: (x: number, y: number, z: number) => ViewLod;
  heightAt: (x: number, z: number) => number;
  flashOf: (kind: 'unit' | 'building', id: EntityId) => number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** LODs at which a real silhouette is drawn, so a mark has something to sit on. */
const detailLod = (lod: ViewLod): boolean => lod === 'close' || lod === 'tactical';
/** ...and the wider set, for marks big enough to survive table zoom. */
const coarseLod = (lod: ViewLod): boolean => lod !== 'world';

/**
 * Which entities earn a bar this frame, and how full it is.
 *
 * The rules are §2.2's, in order:
 *
 * - Nothing at full health, unless the always-show option is on. A board of
 *   untouched units carries zero marks, so a mark appearing *means* something.
 * - Exactly one mark per damaged, selected or hovered entity. Hover is not
 *   implemented — there is no hover state anywhere in the project yet — so this
 *   covers damaged and selected only.
 * - The squad decorator is the primary granularity (D-003). A unit in a squad
 *   is represented by its squad's decorator and gets no bar of its own, which
 *   is what keeps a twenty-unit push from becoming twenty bars. The always-show
 *   option is the escape hatch, and turning it on is the player asking for
 *   per-unit detail.
 * - Construction sites carry a progress mark whatever their state, because
 *   progress *is* a site's state and a site at zero is still information.
 */
export function collectStatusMarks(world: World, opts: StatusOptions): StatusMark[] {
  const marks: StatusMark[] = [];
  const ceiling = new Map<string, number>();
  const unitCeiling = (unit: World['units'][number]): number => {
    const key = `${unit.team}:${unit.type}`;
    let hit = ceiling.get(key);
    if (hit === undefined) { hit = maxHp(world, unit); ceiling.set(key, hit); }
    return hit;
  };

  for (const u of world.units) {
    const x = lerp(u.prevX, u.x, opts.alpha);
    const z = lerp(u.prevZ, u.z, opts.alpha);
    if (!opts.entityVisible(u.team, x, z)) continue;
    const ground = opts.heightAt(x, z);
    if (!detailLod(opts.lodAt(x, ground, z))) continue;
    if (opts.squadMemberIds.has(u.id) && !opts.alwaysShow) continue;

    const ceilingHp = unitCeiling(u);
    const fill = ceilingHp > 0 ? Math.min(1, Math.max(0, u.hp / ceilingHp)) : 0;
    if (!opts.alwaysShow && fill >= FULL_HEALTH && !u.selected) continue;

    const shape = UNIT_SILHOUETTE[u.type];
    marks.push({
      kind: 'unit', entityId: u.id, team: u.team,
      x, y: ground + shape.markY, z,
      width: shape.halfWidth * 2, height: BAR_HEIGHT,
      fill, flash: opts.flashOf('unit', u.id),
    });
  }

  // Squad rosters are ids, so an index is the difference between one pass over
  // the units and one pass per member (D-010 buys determinism, not lookup).
  const byId = new Map(world.units.map(u => [u.id, u]));

  for (const squad of world.squads) {
    let sumHp = 0;
    let sumMax = 0;
    let cx = 0;
    let cz = 0;
    let top = 0;
    let seen = 0;
    let selected = false;
    let flash = 0;
    for (const id of squad.memberIds) {
      const u = byId.get(id);
      if (!u) continue;
      const x = lerp(u.prevX, u.x, opts.alpha);
      const z = lerp(u.prevZ, u.z, opts.alpha);
      if (!opts.entityVisible(u.team, x, z)) continue;
      sumHp += Math.max(0, u.hp);
      sumMax += unitCeiling(u);
      cx += x;
      cz += z;
      top = Math.max(top, UNIT_SILHOUETTE[u.type].markY);
      selected = selected || u.selected;
      flash = Math.max(flash, opts.flashOf('unit', u.id));
      seen++;
    }
    if (seen === 0 || sumMax <= 0) continue;
    const x = cx / seen;
    const z = cz / seen;
    const ground = opts.heightAt(x, z);
    if (!coarseLod(opts.lodAt(x, ground, z))) continue;
    const fill = Math.min(1, Math.max(0, sumHp / sumMax));
    if (!opts.alwaysShow && fill >= FULL_HEALTH && !selected) continue;
    marks.push({
      kind: 'squad', entityId: squad.id, team: squad.team,
      x, y: ground + top + 1.15, z,
      // Wide enough that it reads as belonging to a group rather than to
      // whichever unit happens to stand under the centroid.
      width: 2.4, height: DECORATOR_HEIGHT,
      fill, flash,
    });
  }

  for (const b of world.buildings) {
    if (!opts.entityVisible(b.team, b.x, b.z)) continue;
    const ground = opts.heightAt(b.x, b.z);
    if (!coarseLod(opts.lodAt(b.x, ground, b.z))) continue;
    const def = BUILDING_TYPES[b.type];
    const fill = Math.min(1, Math.max(0, b.hp / def.hp));
    if (!opts.alwaysShow && fill >= FULL_HEALTH) continue;
    marks.push({
      kind: 'building', entityId: b.id, team: b.team,
      x: b.x, y: ground + b.radius * 1.55 + 0.35, z: b.z,
      width: b.radius * 1.7, height: DECORATOR_HEIGHT,
      fill, flash: opts.flashOf('building', b.id),
    });
  }

  for (const site of world.sites) {
    if (!opts.entityVisible(site.team, site.x, site.z)) continue;
    const ground = opts.heightAt(site.x, site.z);
    if (!detailLod(opts.lodAt(site.x, ground, site.z))) continue;
    marks.push({
      kind: 'site', entityId: site.id, team: site.team,
      x: site.x, y: ground + site.radius * 1.3 + 0.5, z: site.z,
      width: Math.max(1.2, site.radius * 1.7), height: BAR_HEIGHT,
      fill: site.required > 0 ? Math.min(1, Math.max(0, site.progress / site.required)) : 0,
      flash: 0,
    });
  }

  return marks;
}

/**
 * Ground rings: whose unit this is, and what the player has done with it.
 *
 * The identity ring is the answer to the critic's "nothing on the first screen
 * identifies which pixels are a unit at all". It is drawn under every visible
 * unit at all times, in the one team colour, because §8.8 forbids solving the
 * same problem by painting the bodies.
 *
 * Emission order is the blend order inside the single draw call, so the passes
 * run bottom-up: the shield-wall glow washes the ground, identity sits on it,
 * and the two attention rings sit outside both.
 */
export function collectGroundMarks(
  world: World,
  opts: StatusOptions & { shieldWallFraction: (unitId: EntityId) => number },
): GroundMark[] {
  const marks: GroundMark[] = [];
  const placed: {
    id: EntityId; x: number; y: number; z: number;
    half: number; team: Team; selected: boolean;
  }[] = [];

  for (const u of world.units) {
    const x = lerp(u.prevX, u.x, opts.alpha);
    const z = lerp(u.prevZ, u.z, opts.alpha);
    if (!opts.entityVisible(u.team, x, z)) continue;
    const ground = opts.heightAt(x, z);
    if (!detailLod(opts.lodAt(x, ground, z))) continue;
    placed.push({
      id: u.id, x, y: ground + 0.05, z,
      half: UNIT_SILHOUETTE[u.type].halfWidth, team: u.team, selected: u.selected,
    });
  }

  for (const p of placed) {
    const frac = opts.shieldWallFraction(p.id);
    if (frac <= 0) continue;
    marks.push({
      kind: 'shieldWall', entityId: p.id, x: p.x, y: p.y - 0.012, z: p.z,
      radius: p.half * 1.25, inner: 0, color: MARK.shieldWall, alpha: frac * 0.35,
    });
  }
  for (const p of placed) {
    marks.push({
      kind: 'identity', entityId: p.id, x: p.x, y: p.y, z: p.z,
      radius: p.half * 1.5, inner: 0.52,
      color: TEAM_IDENTITY[p.team].lit, alpha: 0.55,
    });
  }
  for (const p of placed) {
    if (!opts.squadMemberIds.has(p.id)) continue;
    marks.push({
      kind: 'squad', entityId: p.id, x: p.x, y: p.y + 0.012, z: p.z,
      radius: p.half * 2.2, inner: 0.86, color: MARK.squad, alpha: 0.8,
    });
  }
  for (const p of placed) {
    if (!p.selected) continue;
    marks.push({
      kind: 'selection', entityId: p.id, x: p.x, y: p.y + 0.024, z: p.z,
      radius: p.half * 1.85, inner: 0.79, color: MARK.selection, alpha: 0.95,
    });
  }

  return marks;
}

// --- GPU side -------------------------------------------------------------

/** Instances the two batches will hold before they start dropping marks.
 *  Sized for well past the 100-unit target: four ground rings and one bar each,
 *  plus buildings, sites and squad decorators. */
const BAR_CAPACITY = 384;
const GROUND_CAPACITY = 768;

function quad(inPlaneXZ: boolean): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const p = inPlaneXZ
    ? [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]
    : [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 2, 3, 0]);
  // Anchors live in instance attributes, so the geometry's own bounds describe
  // a unit quad at the origin and culling against them would be nonsense.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

function instanced(geo: THREE.InstancedBufferGeometry, name: string, size: number, capacity: number): Float32Array {
  const array = new Float32Array(capacity * size);
  const attribute = new THREE.InstancedBufferAttribute(array, size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute(name, attribute);
  return array;
}

const upload = (geo: THREE.InstancedBufferGeometry, name: string): void => {
  geo.getAttribute(name).needsUpdate = true;
};

export interface StatusLayer {
  syncBars: (marks: readonly StatusMark[]) => void;
  syncGround: (marks: readonly GroundMark[]) => void;
  /** How many bar instances were uploaded last frame. The §2.2 count. */
  barCount: () => number;
  groundCount: () => number;
  /** Draw calls the whole layer costs. Constant by construction. */
  drawCalls: () => number;
  dispose: () => void;
}

/**
 * A bar drawn in the fragment shader rather than as three nested quads.
 *
 * The outline is measured with `fwidth`, so it stays one screen pixel at every
 * camera distance instead of thinning to nothing when the war table pulls out.
 * Without it a 3px-tall bar at the tactical edge either loses its outline or
 * loses its interior, depending which way a fixed world-space border rounds.
 */
function barMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTrack: { value: MARK.barTrack },
      uOutline: { value: MARK.barOutline },
    },
    vertexShader: /* glsl */`
      attribute vec3 aAnchor;
      attribute vec2 aSize;
      attribute float aFill;
      attribute vec3 aColor;
      attribute float aFlash;
      varying vec2 vUv;
      varying float vFill;
      varying vec3 vColor;
      varying float vFlash;
      void main() {
        vUv = uv;
        vFill = aFill;
        vColor = aColor;
        vFlash = aFlash;
        // Screen-facing: the anchor goes through the view transform, the corner
        // offset does not. A bar that pitched with the war table would be a
        // sliver from directly above, which is the angle the game is played at.
        vec4 mv = modelViewMatrix * vec4(aAnchor, 1.0);
        mv.xy += position.xy * aSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      uniform vec3 uTrack;
      uniform vec3 uOutline;
      varying vec2 vUv;
      varying float vFill;
      varying vec3 vColor;
      varying float vFlash;
      void main() {
        vec2 texel = fwidth(vUv);
        // Clamped, or a bar only a few pixels tall is entirely outline.
        float ox = min(texel.x * 1.1, 0.09);
        float oy = min(texel.y * 1.1, 0.26);
        float inside = step(ox, vUv.x) * step(vUv.x, 1.0 - ox)
                     * step(oy, vUv.y) * step(vUv.y, 1.0 - oy);
        vec3 body = mix(uTrack, vColor, step(vUv.x, vFill));
        // Impact reads as light landing on the mark, never as a red splash —
        // and as a highlight travelling with the fill's edge rather than a wash
        // over the whole bar. A flat wash was measured against a real fight and
        // it destroyed the read: units under fire are hit every eight to twelve
        // ticks, so every bar on screen sat permanently white and the team
        // colour the bar exists to carry was gone.
        float edge = 1.0 - smoothstep(0.0, 0.13, abs(vUv.x - vFill));
        body = mix(body, vec3(1.0, 0.96, 0.86), vFlash * (0.18 + 0.6 * edge));
        vec3 rgb = mix(uOutline, body, inside);
        gl_FragColor = vec4(rgb, mix(1.0, 0.94, inside));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

function groundMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // The quad lies in XZ and its winding puts the face normal at -Y, so
    // front-face culling removed every ring when seen from a camera that is
    // always above the board. Nothing in the array or the uploads was wrong,
    // which is exactly why it took a screenshot rather than a test to find.
    side: THREE.DoubleSide,
    // Shares ground with the terrain surface, so bias in depth rather than
    // lifting further in Y — height would make the rings float on slopes.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {},
    vertexShader: /* glsl */`
      attribute vec3 aAnchor;
      attribute float aRadius;
      attribute float aInner;
      attribute vec3 aColor;
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vInner;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vInner = aInner;
        vColor = aColor;
        vAlpha = aAlpha;
        vec3 world = aAnchor + position * (aRadius * 2.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      varying vec2 vUv;
      varying float vInner;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        // Soft on both edges. A hard-edged ring reads as UI stuck to the
        // ground; a soft one reads as painted onto it, which is D-005's whole
        // argument about surfaces.
        float outer = 1.0 - smoothstep(0.84, 1.0, d);
        float inner = smoothstep(max(vInner - 0.16, 0.0), vInner + 0.05, d);
        float a = outer * inner * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

export function createStatusLayer(scene: THREE.Scene): StatusLayer {
  const barGeo = quad(false);
  const barAnchor = instanced(barGeo, 'aAnchor', 3, BAR_CAPACITY);
  const barSize = instanced(barGeo, 'aSize', 2, BAR_CAPACITY);
  const barFill = instanced(barGeo, 'aFill', 1, BAR_CAPACITY);
  const barColor = instanced(barGeo, 'aColor', 3, BAR_CAPACITY);
  const barFlash = instanced(barGeo, 'aFlash', 1, BAR_CAPACITY);
  barGeo.instanceCount = 0;
  const bars = new THREE.Mesh(barGeo, barMaterial());
  bars.frustumCulled = false;
  bars.renderOrder = 26;
  scene.add(bars);

  const groundGeo = quad(true);
  const groundAnchor = instanced(groundGeo, 'aAnchor', 3, GROUND_CAPACITY);
  const groundRadius = instanced(groundGeo, 'aRadius', 1, GROUND_CAPACITY);
  const groundInner = instanced(groundGeo, 'aInner', 1, GROUND_CAPACITY);
  const groundColor = instanced(groundGeo, 'aColor', 3, GROUND_CAPACITY);
  const groundAlpha = instanced(groundGeo, 'aAlpha', 1, GROUND_CAPACITY);
  groundGeo.instanceCount = 0;
  const ground = new THREE.Mesh(groundGeo, groundMaterial());
  ground.frustumCulled = false;
  ground.renderOrder = 6;
  scene.add(ground);

  return {
    syncBars(marks) {
      const n = Math.min(marks.length, BAR_CAPACITY);
      for (let i = 0; i < n; i++) {
        const m = marks[i]!;
        barAnchor[i * 3] = m.x;
        barAnchor[i * 3 + 1] = m.y;
        barAnchor[i * 3 + 2] = m.z;
        barSize[i * 2] = m.width;
        barSize[i * 2 + 1] = m.height;
        barFill[i] = m.fill;
        // The identity `mid`, not `lit`. The pale end of the hue path survived
        // tone mapping as very nearly white on both teams, so a screen full of
        // bars carried no ownership at all — the exact failure the bars were
        // added to fix.
        const identity = TEAM_IDENTITY[m.team].mid;
        barColor[i * 3] = identity.r;
        barColor[i * 3 + 1] = identity.g;
        barColor[i * 3 + 2] = identity.b;
        barFlash[i] = m.flash;
      }
      barGeo.instanceCount = n;
      // An empty batch still issues a draw call, and §2.2 counts calls at rest
      // as well as during a fight. A board with nothing damaged costs nothing.
      bars.visible = n > 0;
      upload(barGeo, 'aAnchor');
      upload(barGeo, 'aSize');
      upload(barGeo, 'aFill');
      upload(barGeo, 'aColor');
      upload(barGeo, 'aFlash');
    },
    syncGround(marks) {
      const n = Math.min(marks.length, GROUND_CAPACITY);
      for (let i = 0; i < n; i++) {
        const m = marks[i]!;
        groundAnchor[i * 3] = m.x;
        groundAnchor[i * 3 + 1] = m.y;
        groundAnchor[i * 3 + 2] = m.z;
        groundRadius[i] = m.radius;
        groundInner[i] = m.inner;
        groundColor[i * 3] = m.color.r;
        groundColor[i * 3 + 1] = m.color.g;
        groundColor[i * 3 + 2] = m.color.b;
        groundAlpha[i] = m.alpha;
      }
      groundGeo.instanceCount = n;
      ground.visible = n > 0;
      upload(groundGeo, 'aAnchor');
      upload(groundGeo, 'aRadius');
      upload(groundGeo, 'aInner');
      upload(groundGeo, 'aColor');
      upload(groundGeo, 'aAlpha');
    },
    barCount: () => barGeo.instanceCount,
    groundCount: () => groundGeo.instanceCount,
    drawCalls: () => (bars.visible ? 1 : 0) + (ground.visible ? 1 : 0),
    dispose() {
      scene.remove(bars, ground);
      barGeo.dispose();
      groundGeo.dispose();
      bars.material.dispose();
      ground.material.dispose();
    },
  };
}

// --- The always-show option ----------------------------------------------

const STORAGE_KEY = 'greenmantle.bars.alwaysShow';

export interface BarPreference {
  readonly alwaysShow: boolean;
  toggle: () => boolean;
  dispose: () => void;
}

/**
 * Warcraft III's persistent always-show health option, rather than StarCraft's
 * held Alt.
 *
 * §2.2 prefers the toggle and §§2 and 4 say why: a modifier the player holds
 * mid-fight is an execution affordance, and this game's whole claim is that
 * skill lives in what you decide rather than in what your hands do during the
 * three seconds a fight takes. So it is a setting, it persists across sessions,
 * and pressing the key once changes state permanently.
 *
 * `V` for vitals. It is bound here rather than in `input/keyboard.ts` because
 * this is a display preference with no simulation effect — nothing about it
 * reaches a command. The consequence is that it does not yet appear in the
 * controls reference sheet; that is logged as `bars-toggle-home` in
 * `docs/WORKLOG.md`.
 */
export function createBarPreference(search = '', key = 'v'): BarPreference {
  let alwaysShow = false;
  try {
    alwaysShow = new URLSearchParams(search).get('bars') === 'always'
      || localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    alwaysShow = false;   // private mode, storage disabled — not worth failing over
  }

  const typing = (target: EventTarget | null): boolean => {
    const tag = (target as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() !== key || e.ctrlKey || e.metaKey || e.altKey) return;
    // The map-seed field is one keystroke away from the battlefield.
    if (typing(e.target)) return;
    alwaysShow = !alwaysShow;
    try { localStorage.setItem(STORAGE_KEY, alwaysShow ? 'on' : 'off'); } catch { /* ignore */ }
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  return {
    get alwaysShow() { return alwaysShow; },
    toggle() {
      alwaysShow = !alwaysShow;
      try { localStorage.setItem(STORAGE_KEY, alwaysShow ? 'on' : 'off'); } catch { /* ignore */ }
      return alwaysShow;
    },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
    },
  };
}
