import * as THREE from 'three';
import { createPainterlyMaterial } from './painterly';
import { MARK, PALETTE, TEAM_IDENTITY } from './palette';
import type { HuePath } from './palette';
import type { Team } from '../core/types';

/**
 * Shared painterly materials, cached by role.
 *
 * The cache is the whole point. `createPainterlyMaterial` builds a
 * `ShaderMaterial`, and Three compiles a shader program per distinct material —
 * so creating one per unit would mean 100+ compiles during a battle, stalling
 * the frame exactly when the game is busiest. That would break the 100-unit
 * performance target (D-006) in the most visible way possible.
 *
 * Sharing is safe here because these materials carry no per-instance state:
 * position and orientation live on the mesh, and the only per-object variation
 * we need is team, which is a cache key rather than a uniform.
 *
 * Colour policy (§8.8): Cohort bodies are bone-pale fossil stone, never
 * team-coloured plastic. Team readability comes from the warm internal glow and
 * the existing selection/squad rings, not from painting the whole unit blue.
 * The rival is the same silhouette in a warmer, browner bone — "still clearly
 * the same civilisation, just a different force".
 */

const cache = new Map<string, THREE.ShaderMaterial>();

function shared(key: string, path: HuePath, opts: Parameters<typeof createPainterlyMaterial>[1] = {}): THREE.ShaderMaterial {
  const hit = cache.get(key);
  if (hit) return hit;
  const mat = createPainterlyMaterial(path, opts);
  cache.set(key, mat);
  return mat;
}

const boneFor = (team: Team): HuePath => (team === 'player' ? PALETTE.bone : PALETTE.boneRival);

/** Fossil stone — unit and building bodies. */
export function boneMaterial(team: Team): THREE.ShaderMaterial {
  return shared(`bone:${team}`, boneFor(team), { soft: 0.13, rim: 0.6, jitter: 0.04 });
}

/** Paler trim: heads, staves, shields. Reads as worn-smooth bone. */
export function trimMaterial(team: Team): THREE.ShaderMaterial {
  const base = boneFor(team);
  return shared(`trim:${team}`, { shade: base.mid, mid: base.lit, lit: PALETTE.bone.lit },
    { soft: 0.16, rim: 0.7, jitter: 0.03 });
}

/**
 * The "still faintly alive" glow (§8.8) — warm gold for the player, warmer
 * amber for the rival. Never red, never hard-edged.
 */
export function glowMaterial(team: Team): THREE.ShaderMaterial {
  const path: HuePath = team === 'player'
    ? { shade: new THREE.Color(0xb8791f), mid: new THREE.Color(0xffcc55), lit: new THREE.Color(0xfff3d0) }
    : { shade: new THREE.Color(0xb3502a), mid: new THREE.Color(0xff8a55), lit: new THREE.Color(0xffe0c8) };
  // Ambient lifted so the core reads as emitting rather than merely lit.
  return shared(`glow:${team}`, path, { soft: 0.3, rim: 0.9, jitter: 0, ambient: 2.4 });
}

/** Moss and lichen gathering in the seams — a real material, not a decal. */
export function mossMaterial(): THREE.ShaderMaterial {
  return shared('moss', PALETTE.moss, { soft: 0.2, rim: 0.35, jitter: 0.08 });
}

/** The gatherable resource. Violet, never teal (D-025). */
export function legacyMaterial(): THREE.ShaderMaterial {
  return shared('legacy', PALETTE.legacy, { soft: 0.26, rim: 1.0, jitter: 0.02, ambient: 1.8 });
}

export function rockMaterial(): THREE.ShaderMaterial {
  return shared('rock', PALETTE.rock, { soft: 0.12, rim: 0.4, jitter: 0.06 });
}

export function barkMaterial(): THREE.ShaderMaterial {
  return shared('bark', PALETTE.bark, { soft: 0.15, rim: 0.4, jitter: 0.06 });
}

export function leafMaterial(): THREE.ShaderMaterial {
  return shared('leaf', PALETTE.leaf, { soft: 0.22, rim: 0.5, jitter: 0.07 });
}

/** How many distinct shader programs the painterly set costs. Used by tests to
 *  guard against per-instance material creation creeping back in. */
export function sharedMaterialCount(): number {
  return cache.size;
}

/**
 * Flat marks — rings, markers, decorators.
 *
 * These are `MeshBasicMaterial`, so they do not cost a shader compile the way
 * the painterly set does, and the D-006 argument above does not apply verbatim.
 * They were still being allocated per entity: `makeUnitView` built four of them
 * for every unit, so a hundred-unit battle carried four hundred material objects
 * whose only distinguishing property was a colour shared by all of them. Cached
 * by role and team, the same battle carries eight.
 *
 * Kept in a separate cache from the painterly one so `sharedMaterialCount()`
 * keeps meaning "shader programs", which is the number the performance guard
 * actually cares about.
 */
const flatCache = new Map<string, THREE.MeshBasicMaterial>();

function flat(key: string, color: THREE.Color, opacity: number): THREE.MeshBasicMaterial {
  const hit = flatCache.get(key);
  if (hit) return hit;
  const mat = new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false,
  });
  flatCache.set(key, mat);
  return mat;
}

/** The selection ring, on units and on buildings alike. One mark, one colour. */
export function selectionMarkMaterial(): THREE.MeshBasicMaterial {
  return flat('mark:selection', MARK.selection, 0.92);
}

/** Team identity at strategic and world zoom, where the silhouette is gone. */
export function teamMarkMaterial(team: Team): THREE.MeshBasicMaterial {
  return flat(`mark:team:${team}`, TEAM_IDENTITY[team].mid, 0.92);
}

/** Territory held. Same identity hue as everything else the team owns. */
export function territoryMarkMaterial(team: Team): THREE.MeshBasicMaterial {
  return flat(`mark:territory:${team}`, TEAM_IDENTITY[team].lit, 0.4);
}

/** How many flat mark materials exist. Guards the per-entity allocation
 *  regression this cache was added to remove. */
export function sharedFlatMaterialCount(): number {
  return flatCache.size;
}
