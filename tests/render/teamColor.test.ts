import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARK, TEAM_IDENTITY, hueDegrees, hueSeparation } from '../../src/render/palette';
import { TEAM_COLORS } from '../../src/render/unitViews';
import {
  selectionMarkMaterial, sharedFlatMaterialCount, teamMarkMaterial, territoryMarkMaterial,
} from '../../src/render/materials';

/**
 * BENCHMARKS §2.3, converted to arithmetic.
 *
 * The state this replaces: the player team read as 47 degrees of hue at close
 * range, 228 at strategic and 44 on the minimap — three vocabularies for one
 * fact — and the selection ring sat four degrees from the player's own bone.
 * The floor of 30 degrees is the benchmark's proposed threshold, not a
 * published figure, but the point of writing it down is that closing it takes a
 * deliberate edit to this file rather than an accident in a colour literal.
 */

const SEPARATION_FLOOR = 30;

const hue = (color: Parameters<typeof hueDegrees>[0]): number => {
  const h = hueDegrees(color);
  if (h === null) throw new Error('identity and mark colours must have a hue');
  return h;
};

describe('one identity vocabulary per team', () => {
  it('keeps both teams far enough apart to tell apart mid-fight', () => {
    expect(hueSeparation(hue(TEAM_IDENTITY.player.mid), hue(TEAM_IDENTITY.rival.mid)))
      .toBeGreaterThanOrEqual(90);
  });

  it('walks a hue path, so a team is one colour rather than three', () => {
    for (const team of ['player', 'rival'] as const) {
      const path = TEAM_IDENTITY[team];
      expect(hueSeparation(hue(path.mid), hue(path.lit))).toBeLessThan(20);
      expect(hueSeparation(hue(path.mid), hue(path.shade))).toBeLessThan(20);
    }
  });

  it('derives every consumer from the one table rather than from a literal', () => {
    expect(TEAM_COLORS.player).toBe(TEAM_IDENTITY.player.mid.getHex());
    expect(TEAM_COLORS.rival).toBe(TEAM_IDENTITY.rival.mid.getHex());
    expect(teamMarkMaterial('player').color.getHex()).toBe(TEAM_IDENTITY.player.mid.getHex());
    expect(teamMarkMaterial('rival').color.getHex()).toBe(TEAM_IDENTITY.rival.mid.getHex());
    expect(territoryMarkMaterial('player').color.getHex()).toBe(TEAM_IDENTITY.player.lit.getHex());
  });
});

describe('relationship stays off the identity channel', () => {
  it('keeps the selection ring clear of both team colours', () => {
    for (const team of ['player', 'rival'] as const) {
      expect(hueSeparation(hue(MARK.selection), hue(TEAM_IDENTITY[team].mid)))
        .toBeGreaterThanOrEqual(SEPARATION_FLOOR);
      expect(hueSeparation(hue(MARK.selection), hue(TEAM_IDENTITY[team].lit)))
        .toBeGreaterThanOrEqual(SEPARATION_FLOOR);
    }
  });

  it('keeps the squad ring clear of both team colours', () => {
    for (const team of ['player', 'rival'] as const) {
      expect(hueSeparation(hue(MARK.squad), hue(TEAM_IDENTITY[team].mid)))
        .toBeGreaterThanOrEqual(SEPARATION_FLOOR);
      expect(hueSeparation(hue(MARK.squad), hue(TEAM_IDENTITY[team].lit)))
        .toBeGreaterThanOrEqual(SEPARATION_FLOOR);
    }
  });

  it('keeps the two attention rings apart from each other', () => {
    expect(hueSeparation(hue(MARK.selection), hue(MARK.squad)))
      .toBeGreaterThanOrEqual(SEPARATION_FLOOR);
  });

  it('was the specific defect the critic found: the squad ring sat inside the floor', () => {
    // `0x8ad6ff`, the colour this replaced.
    const wasSquadRing = { r: 0x8a / 255, g: 0xd6 / 255, b: 0xff / 255 };
    const asHue = (() => {
      const { r, g, b } = wasSquadRing;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    })();
    expect(hueSeparation(asHue, hue(TEAM_IDENTITY.player.mid))).toBeLessThan(SEPARATION_FLOOR);
  });
});

describe('the resource stays violet everywhere it is drawn (D-025)', () => {
  it('is not wearing a team identity', () => {
    for (const team of ['player', 'rival'] as const) {
      expect(hueSeparation(275.7, hue(TEAM_IDENTITY[team].mid))).toBeGreaterThan(45);
    }
  });
});

describe('mark materials are shared, not allocated per entity', () => {
  it('hands back the same object for the same role', () => {
    expect(selectionMarkMaterial()).toBe(selectionMarkMaterial());
    expect(teamMarkMaterial('player')).toBe(teamMarkMaterial('player'));
    expect(teamMarkMaterial('player')).not.toBe(teamMarkMaterial('rival'));
  });

  it('costs a fixed handful however many units exist', () => {
    for (let i = 0; i < 200; i++) {
      selectionMarkMaterial();
      teamMarkMaterial(i % 2 === 0 ? 'player' : 'rival');
      territoryMarkMaterial(i % 2 === 0 ? 'player' : 'rival');
    }
    expect(sharedFlatMaterialCount()).toBeLessThanOrEqual(8);
  });
});

describe('no view keeps its own colour table', () => {
  const read = (file: string) =>
    readFileSync(join(import.meta.dirname, '..', '..', 'src', 'render', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  /**
   * A regression guard with teeth, because the failure mode here is silent: a
   * new hex literal in a view looks perfectly reasonable in a diff and only
   * shows up as "the enemy is a slightly different blue at this zoom".
   *
   * Warm dressing colours are exempt by name — the pulse light in a building's
   * core is not claiming to identify anyone.
   */
  it('leaves no bare team-coloured hex in the unit or building views', () => {
    const allowed = new Set(['0xffcc66', '0xff8866']);   // the fossil's internal glow
    for (const file of ['unitViews.ts', 'buildingViews.ts']) {
      const hexes = [...read(file).matchAll(/0x[0-9a-f]{6}/gi)].map(m => m[0].toLowerCase());
      expect(hexes.filter(h => !allowed.has(h))).toEqual([]);
    }
  });
});
