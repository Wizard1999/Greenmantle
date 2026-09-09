import * as THREE from 'three';
import type { Team } from '../core/types';

/**
 * The painterly palette (design doc §1, §8.8, §10.1 — "Ghibli-influenced,
 * warm painterly lighting").
 *
 * The load-bearing idea, taken from the designer's reference scene: a surface
 * is not one colour lit and darkened. It is a **hue path** — three distinct
 * colours for shade, midtone and light — that the shading model walks along.
 * Shadows shift hue instead of going black, which is the single biggest
 * difference between "stylised" and "3D render with the lights turned down".
 */
export interface HuePath {
  shade: THREE.Color;
  mid: THREE.Color;
  lit: THREE.Color;
}

const c = (hex: number) => new THREE.Color(hex);

/** Cool violet-green shade -> saturated mid -> warm sunlit tip. */
export const PALETTE = {
  grass: { shade: c(0x3f5d4a), mid: c(0x5f9147), lit: c(0xa8c85c) },
  rock: { shade: c(0x4d4f52), mid: c(0x83837c), lit: c(0xc3bda9) },
  bark: { shade: c(0x3d2e24), mid: c(0x6b4a2f), lit: c(0x9c7746) },
  leaf: { shade: c(0x2f5535), mid: c(0x4f8f3d), lit: c(0x9ccc5a) },

  // Cohort: bone-pale fossil stone, never grey machinery (§8.8).
  bone: { shade: c(0x6d6a5f), mid: c(0xbdb7a2), lit: c(0xf3ecd8) },
  boneRival: { shade: c(0x6b5148), mid: c(0xb69184), lit: c(0xe8cfc0) },
  moss: { shade: c(0x33502f), mid: c(0x5f8a45), lit: c(0x9ec464) },

  /**
   * The gatherable resource — "Legacy" in the vocabulary of D-021: understanding
   * inherited from a dead civilization, not a mineral.
   *
   * Violet, deliberately, and specifically NOT teal. Teal failed twice over: it
   * reads as StarCraft minerals, which §8.8 spends its length ruling out, and it
   * is Conclave's colour — Water — so the universal resource was quietly wearing
   * one race's identity. Violet is claimed by none of the four elements (bone/
   * gold, green, blue, stone), sits opposite the warm sun so it reads clearly
   * against sunlit grass, and says "precious and old" rather than "ore".
   */
  legacy: { shade: c(0x3b2a55), mid: c(0xb98ad9), lit: c(0xf0dcff) },

  teamPlayer: { shade: c(0x1e2f6b), mid: c(0x3b5bdb), lit: c(0x8fb2ff) },
  teamRival: { shade: c(0x5c1a1a), mid: c(0xb02e2e), lit: c(0xff8a7a) },
} as const satisfies Record<string, HuePath>;

/**
 * The single team-identity table (BENCHMARKS §2.3).
 *
 * Every surface that has to answer "whose is that?" reads this and nothing
 * else: the ground identity ring under each unit, the strategic marker that
 * replaces the unit at table zoom, the health bar fill, the squad decorator,
 * the building marker and the territory ring. Before this existed the answer
 * came from six unrelated literals and the player team read as three different
 * colours depending on how far the camera was pulled out — 47 degrees of hue at
 * close range, 228 at strategic, 44 on the minimap.
 *
 * Bodies are deliberately not in that list. §8.8 makes Cohort bone-pale fossil
 * stone on both sides, so identity has to ride on marks, glow and rings rather
 * than on paint. That is the reason the marks have to be unambiguous: they are
 * carrying the whole channel.
 */
export const TEAM_IDENTITY: Record<Team, HuePath> = {
  player: PALETTE.teamPlayer,
  rival: PALETTE.teamRival,
};

/**
 * Colours that mark player attention or entity state rather than identity.
 *
 * Kept apart from `TEAM_IDENTITY` on purpose: relationship (mine/theirs) and
 * state (selected/grouped/hurt) are two channels, and §2.3's failure mode is
 * letting them compete for the same one. Every colour here is at least 30
 * degrees of hue from both identity colours — `tests/render/teamColor.test.ts`
 * asserts it, because the separation is the whole point and a well-meaning
 * tweak would otherwise close it silently.
 */
export const MARK = {
  /** Selection. Warm gold at 50 degrees: 50 from the rival, 178 from the player. */
  selection: c(0xffe66d),
  /**
   * Squad membership. Jade at 150 degrees.
   *
   * Was `0x8ad6ff`, which sat 27 degrees from the player's own identity blue —
   * inside the floor, and in practice a pale blue ring around a pale blue team.
   * Jade is claimed by nothing else on the board: 68 from the player, 150 from
   * the rival, 50 from the nearest grass tone.
   */
  squad: c(0x6fe0a8),
  /** Health a unit has lost. Violet-shifted rather than black, per D-005. */
  barTrack: c(0x2b2440),
  /** One dark contour so a bar survives being drawn over sunlit grass. */
  barOutline: c(0x14111f),
  /** Impact. Warm emitted light, never a red splash. */
  hit: c(0xffd9a0),
  /** A body coming apart into bone dust. */
  death: c(0xd9cdb2),
  /** Shield wall formed — the mechanic made visible under the feet (§8.6). */
  shieldWall: c(0xbfe0ff),
} as const;

/**
 * Hue angle in degrees, 0–360, or `null` for a colour with no meaningful hue.
 *
 * Exists so the separation floors in §2.3 can be asserted as arithmetic instead
 * of eyeballed. Near-neutral colours return null rather than a fabricated angle,
 * because the hue of something with no chroma is noise.
 */
export function hueDegrees(color: THREE.Color): number | null {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, THREE.SRGBColorSpace);
  if (hsl.s < 0.04) return null;
  return hsl.h * 360;
}

/** Shortest angular distance between two hues, 0–180. */
export function hueSeparation(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Sun, sky and bounce. Warm key against a cool sky fill is what makes the
 *  midday read as golden rather than clinical. */
export const LIGHT = {
  sun: c(0xffd9a0),
  sky: c(0xbcd9f2),
  ground: c(0x7a6a44),
  /** Direction *to* the sun. Low enough to throw long shapes. */
  sunDir: new THREE.Vector3(0.42, 0.68, 0.3).normalize(),
  fog: c(0xcfe4f0),
  background: c(0xa8d3e8),
};
