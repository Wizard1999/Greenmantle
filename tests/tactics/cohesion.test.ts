import { describe, expect, it } from 'vitest';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';
import { simStep } from '../../src/sim/world';
import { cmdHoldPosition } from '../../src/sim/commands';
import {
  cohesionEffectiveness, elevationMultiplier, flankMultiplier, localCrowding,
} from '../../src/sim/combat';
import { terrainHeightAt } from '../../src/sim/terrain';
import { COHESION, COMBAT } from '../../src/data/tuning';
import type { Placement } from './harness';
import type { Team, UnitTypeKey, World } from '../../src/core/types';

/**
 * Crowding, as a *tactical* fact rather than as arithmetic.
 *
 * §2 wants "multiple smaller, spread-out squads ... strategically favored over
 * one large deathball", and D-020 implements that as a proximity-counted
 * effectiveness penalty. `phase1.test.ts` already asserts the effective-unit
 * ratio the constants were solved backwards from, and this file deliberately
 * does not repeat it. The question here is the one a player actually asks:
 * **does splitting the same army win a fight it would otherwise lose?**
 *
 * That is a different question, because `cohesionEffectiveness` multiplies
 * damage only. It does not touch hit points, unit count or how many attackers
 * can reach a target, and a fight is decided by all four. A multiplier that
 * looks decisive on paper can be worth nothing on the field, and — as the last
 * describe block records — the reverse is also true.
 *
 * **Answer: yes, and by a lot, for units that can fight without converging.**
 * Thirty marksmen that annihilate themselves against a thirty-strong mass win
 * that same fight 12–0 when the identical thirty are split into two wings
 * standing further apart than `COHESION.radius`. Nothing else about the
 * engagement changes.
 *
 * Two things are measured and do *not* deliver the design, both marked below:
 * a melee force loses its dispersion the moment it advances to contact, and
 * §2's "a 30–40 unit army should only barely beat a 20–25 unit army" is not
 * what happens in a fight.
 */

// The engagement is staged on the one patch of this map where terrain cannot
// contribute anything. `terrainHeightAt` is still a fixed formula (D-017), and
// a disc of radius 9 about this point lies entirely on `TERRAIN_FLOOR`, so
// every pair in these arenas is exactly level. Elevation is §2's *other*
// positional pillar with `COMBAT.highGroundBonus` at 1.25 against
// `lowGroundPenalty` at 0.85 — staging a crowding scenario on a slope would
// measure the two of them added together and call the total cohesion.
const FLAT_X = -23;
const FLAT_Z = 1;

/**
 * Both configurations put the same units the same distance apart along z; only
 * the lateral gap between the two player wings changes.
 *
 * The two numbers straddle `COHESION.radius` (8.0) once the block footprints
 * are accounted for: at 3.0 every friendly pair on the field is inside one
 * radius of every other, which is what the mechanic *means* by one mass, and at
 * 5.2 no cross-wing pair is. Nothing else in the scenario moves.
 */
const MASSED_HALF_GAP = 3.0;
const SPLIT_HALF_GAP = 5.2;

/** Five-deep columns, tight enough that a wing reads as one body of troops. */
function block(
  type: UnitTypeKey, team: Team, count: number, cx: number, cz: number, facing: number,
): Placement[] {
  const cols = Math.ceil(count / 5);
  const out: Placement[] = [];
  let left = count;
  for (let c = 0; c < cols; c++) {
    const n = Math.min(5, left);
    left -= n;
    out.push(...line(type, team, n, cx + (c - (cols - 1) / 2) * 0.3, {
      spacing: 0.3, zOffset: cz, facing,
    }));
  }
  return out;
}

const toward = (fx: number, fz: number, tx: number, tz: number): number =>
  Math.atan2(tx - fx, tz - fz);

/**
 * A mass of `total` defenders with `total` attackers in two wings on either
 * side of the approach, every unit holding position.
 *
 * Ranged, static and symmetric on purpose. Marksmen reach 8.3 — a shade more
 * than `COHESION.radius` — which is the only way in the Phase 1 roster for two
 * groups to be *further apart than one crowd* and still both shooting the same
 * enemy. Melee units cannot do it, and the last block measures what happens to
 * them when they try. Holding position also freezes accuracy (everyone is fully
 * settled) and freezes facing, so settle state and flanking are constants
 * rather than variables.
 */
function pincer(type: UnitTypeKey, total: number, halfGap: number, hold: boolean): World {
  const wingZ = FLAT_Z + 5;
  const world = arena([
    ...block(type, 'rival', total, FLAT_X, FLAT_Z, toward(FLAT_X, FLAT_Z, FLAT_X, wingZ)),
    ...block(type, 'player', total / 2, FLAT_X - halfGap, wingZ,
      toward(FLAT_X - halfGap, wingZ, FLAT_X, FLAT_Z)),
    ...block(type, 'player', total / 2, FLAT_X + halfGap, wingZ,
      toward(FLAT_X + halfGap, wingZ, FLAT_X, FLAT_Z)),
  ]);
  if (hold) cmdHoldPosition(world, world.units.map(u => u.id));
  return world;
}

/** Two blocks facing each other — the shape §2's "30–40 vs 20–25" describes. */
function facingBlocks(type: UnitTypeKey, big: number, small: number, hold: boolean): World {
  const world = arena([
    ...block(type, 'player', big, FLAT_X, FLAT_Z, toward(FLAT_X, FLAT_Z, FLAT_X, FLAT_Z + 5)),
    ...block(type, 'rival', small, FLAT_X, FLAT_Z + 5, toward(FLAT_X, FLAT_Z + 5, FLAT_X, FLAT_Z)),
  ]);
  if (hold) cmdHoldPosition(world, world.units.map(u => u.id));
  return world;
}

/**
 * Every positional modifier *except* crowding, over every pair that could ever
 * trade blows.
 *
 * Checked across all cross-team pairs inside acquire range rather than over the
 * pairs that happen to fight, because targets change as units die and the claim
 * has to hold for all of them. If this returns anything but level ground and
 * frontal approaches, the scenario is measuring elevation or flanking wearing
 * cohesion's name.
 */
function positionalNoise(world: World): { elevation: number[]; flank: number[]; heightSpread: number } {
  const elevation = new Set<number>();
  const flank = new Set<number>();
  for (const a of world.units) {
    for (const b of world.units) {
      if (b.team === a.team) continue;
      if (Math.hypot(b.x - a.x, b.z - a.z) > COMBAT.acquireRange) continue;
      elevation.add(elevationMultiplier(a, b));
      flank.add(flankMultiplier(a, b));
    }
  }
  const heights = world.units.map(u => terrainHeightAt(u.x, u.z));
  return {
    elevation: [...elevation],
    flank: [...flank],
    heightSpread: Math.max(...heights) - Math.min(...heights),
  };
}

const crowdRange = (world: World, team: Team): [number, number] => {
  const counts = unitsOf(world, team).map(u => localCrowding(world, u));
  return [Math.min(...counts), Math.max(...counts)];
};

describe('the same army, massed or split', () => {
  it('leaves the ground and the angles out of it', () => {
    // The control on the control. Both configurations have to be level and
    // wholly frontal or the headline comparison below proves nothing.
    for (const halfGap of [MASSED_HALF_GAP, SPLIT_HALF_GAP]) {
      const noise = positionalNoise(pincer('marksman', 30, halfGap, true));
      expect(noise.heightSpread).toBe(0);
      expect(noise.elevation).toEqual([1]);
      expect(noise.flank).toEqual([1]);
    }
  });

  it('gains nothing from the pincer while both sides are under the cap', () => {
    // Twenty a side is exactly `COHESION.cap`, so every unit in every
    // configuration fights at full effectiveness and the mechanic is switched
    // off. Whatever the split wings win at thirty and forty, they do not win it
    // here — which is what rules out the *shape* of the deployment, focus fire
    // and standoff distance as the cause. Measured: mutual annihilation both
    // ways, 720 ticks massed and 756 ticks split.
    for (const halfGap of [MASSED_HALF_GAP, SPLIT_HALF_GAP]) {
      const world = pincer('marksman', 20, halfGap, true);
      expect(cohesionEffectiveness(world, unitsOf(world, 'player')[0]!)).toBe(1);
      expect(cohesionEffectiveness(world, unitsOf(world, 'rival')[0]!)).toBe(1);

      const outcome = fightOut(world);
      expect(outcome.winner).toBeNull();
      expect(outcome.survivors.player).toBe(0);
      expect(outcome.survivors.rival).toBe(0);
    }
  });

  it('turns a mutual annihilation into a 12–0 win at thirty', () => {
    // The headline. Same thirty attackers, same thirty defenders, same ground,
    // same facings, same weapon; the wings move 2.2 further out and that is the
    // whole of the difference.
    const massed = pincer('marksman', 30, MASSED_HALF_GAP, true);
    expect(crowdRange(massed, 'player')).toEqual([30, 30]);
    expect(cohesionEffectiveness(massed, unitsOf(massed, 'player')[0]!)).toBe(0.75);

    const split = pincer('marksman', 30, SPLIT_HALF_GAP, true);
    expect(crowdRange(split, 'player')).toEqual([15, 15]);
    expect(cohesionEffectiveness(split, unitsOf(split, 'player')[0]!)).toBe(1);
    // The defenders are one crowd of thirty in both, so only the attacker's
    // dispersion is in play.
    expect(crowdRange(split, 'rival')).toEqual([30, 30]);
    expect(crowdRange(massed, 'rival')).toEqual([30, 30]);

    const massedOut = fightOut(massed);
    const splitOut = fightOut(split);

    // Massed: everyone dies, 936 ticks. Split: 12 of 30 walk away untouched by
    // tick 432 — the fight is both won and less than half as long.
    expect(massedOut.winner).toBeNull();
    expect(massedOut.survivors.player).toBe(0);
    expect(splitOut.winner).toBe('player');
    expect(splitOut.survivors.rival).toBe(0);
    expect(splitOut.survivors.player).toBeGreaterThanOrEqual(12);
    expect(margin(splitOut)).toBe(1);
    expect(margin(massedOut)).toBe(0);
    expect(splitOut.ticks).toBeLessThan(massedOut.ticks);
  });

  it('widens the gap at forty, where the mass is at half effectiveness', () => {
    // Forty splits into two wings of exactly `COHESION.cap`, which is the
    // largest squad that costs nothing — so the design's own cap is the answer
    // to "how big should a squad be". The mass opposite it is at 0.5.
    const massed = fightOut(pincer('marksman', 40, MASSED_HALF_GAP, true));
    const split = pincer('marksman', 40, SPLIT_HALF_GAP, true);
    expect(crowdRange(split, 'player')).toEqual([COHESION.cap, COHESION.cap]);
    expect(cohesionEffectiveness(split, unitsOf(split, 'rival')[0]!)).toBe(0.5);

    const splitOut = fightOut(split);
    expect(massed.winner).toBeNull();     // 0–0 at 1044 ticks
    expect(splitOut.winner).toBe('player');
    expect(splitOut.survivors.player).toBeGreaterThanOrEqual(14); // 14 of 40, 980 hp to 0
    expect(splitOut.survivors.rival).toBe(0);
  });

  it('switches on where the wings clear COHESION.radius, not before', () => {
    // Swept rather than sampled, so the result cannot be one lucky spacing. The
    // dividing line is the mechanic's own radius: while every attacker is still
    // inside one crowd the fight is a mutual kill, and as soon as none of them
    // are it is a clean win. Measured crowding per band: 30/30, 30/30, 25/30
    // against 15/15, 15/15, 15/15.
    for (const halfGap of [3.0, 3.4, 3.8]) {
      const world = pincer('marksman', 30, halfGap, true);
      expect(crowdRange(world, 'player')[0]).toBeGreaterThan(COHESION.cap);
      const outcome = fightOut(world);
      expect(outcome.winner, `halfGap ${halfGap}`).toBeNull();
      expect(outcome.survivors.player, `halfGap ${halfGap}`).toBe(0);
    }
    for (const halfGap of [4.4, 4.8, 5.2]) {
      const world = pincer('marksman', 30, halfGap, true);
      expect(crowdRange(world, 'player')[1]).toBeLessThanOrEqual(COHESION.cap);
      const outcome = fightOut(world);
      expect(outcome.winner, `halfGap ${halfGap}`).toBe('player');
      expect(outcome.survivors.player, `halfGap ${halfGap}`).toBeGreaterThan(0);
    }
  });
});

describe('what limits the advantage', () => {
  it('hands the mass its effectiveness back as it takes casualties', () => {
    // The penalty is levied on being at full strength, and it repairs itself:
    // ten dead bodies later a thirty-stack is back to 1.0 and fights the rest
    // of the engagement unpenalised. Measured: full effectiveness restored at
    // tick 109 of a 432-tick fight (30 a side) and 217 of 576 (40 a side), so
    // roughly three quarters and two thirds of each fight is fought at no
    // penalty at all. This is the ceiling on everything above — the split force
    // is only ever ahead for the opening of the battle.
    for (const [total, cap] of [[30, 0.4], [40, 0.6]] as [number, number][]) {
      const world = pincer('marksman', total, SPLIT_HALF_GAP, true);
      let restoredAt = -1;
      let ticks = 0;
      for (; ticks < 5400; ticks++) {
        simStep(world);
        const mass = unitsOf(world, 'rival');
        if (!mass.length) break;
        if (restoredAt < 0 && mass.every(u => cohesionEffectiveness(world, u) === 1)) {
          restoredAt = ticks + 1;
        }
        if (!unitsOf(world, 'player').length) break;
      }
      expect(restoredAt).toBeGreaterThan(0);
      expect(restoredAt / ticks).toBeLessThan(cap);
    }
  });

  it('falls short for melee: advancing to contact re-concentrates a split force', () => {
    // §2's promise is not qualified by unit type, but this is where it stops.
    // A Legionnaire reaches 0.9 while `COHESION.radius` is 8.0, so two wings
    // far enough apart to count as separate crowds cannot both be in contact
    // with the same enemy. `stepPursuit` walks them in, they merge, and the
    // dispersion the penalty rewards is gone before the first blow lands.
    //
    // Measured, and this is the shortfall stated plainly: the split wings start
    // at 15 crowding apiece and peak at 30 — identical to the massed
    // deployment — and both configurations end in mutual annihilation, 1499
    // ticks massed against 1700 split. Splitting a melee army buys nothing.
    // Only ranged units can hold a formation the mechanic will reward.
    for (const halfGap of [MASSED_HALF_GAP, SPLIT_HALF_GAP]) {
      const world = pincer('legionnaire', 30, halfGap, false);
      let peak = 0;
      let ticks = 0;
      for (; ticks < 5400; ticks++) {
        simStep(world);
        const attackers = unitsOf(world, 'player');
        if (attackers.length) {
          peak = Math.max(peak, ...attackers.map(u => localCrowding(world, u)));
        }
        if (!attackers.length || !unitsOf(world, 'rival').length) break;
      }
      expect(peak).toBe(30);
      expect(tally(world).winner).toBeNull();
      expect(tally(world).survivors.player).toBe(0);
    }
    // Contrast: the same split, ranged, never converges — pursuit stops at
    // weapon range and the wings hold their ground.
    const held = pincer('marksman', 30, SPLIT_HALF_GAP, false);
    let rangedPeak = 0;
    for (let t = 0; t < 5400; t++) {
      simStep(held);
      const attackers = unitsOf(held, 'player');
      if (attackers.length) rangedPeak = Math.max(rangedPeak, ...attackers.map(u => localCrowding(held, u)));
      if (!attackers.length || !unitsOf(held, 'rival').length) break;
    }
    expect(rangedPeak).toBe(15);
    expect(tally(held).winner).toBe('player');
  });
});

describe('§2 measured as a fight rather than as effective units', () => {
  it('falls short: a 35-stack routs a 22-stack instead of barely beating it', () => {
    // §2 requires that "a 30–40 unit army should only barely beat a 20–25 unit
    // army", and D-020 tuned `penaltyPerUnit` to deliver it: 35 units at 0.625
    // field ~21.9 effective against a 22-stack's ~20.9, a 4.7% edge. That
    // arithmetic is correct and `phase1.test.ts` guards it. It is also not what
    // a fight does, because it models army strength as linear in effective
    // units while combat resolution is not: every attacker can engage, and the
    // penalty is applied to damage while hit points and body count are left
    // untouched, so the larger army keeps its whole durability advantage.
    //
    // Measured on level ground, all frontal, both sides fully settled:
    //
    //   22 v 22  ->  0–0            mutual annihilation, the reference point
    //   23 v 22  ->  4–0            one extra body is already a clean win
    //   35 v 22  -> 17–0            49% of the larger army walks away untouched
    //   42 v 22  -> 25–0            *at* COHESION.minEffectiveness, 60% survive
    //
    // "Barely" would be a handful of survivors on a knife edge. What the
    // simulation delivers is annihilation of the smaller force every time, and
    // the numbers below encode that measured behaviour rather than the design's.
    const even = fightOut(facingBlocks('marksman', 22, 22, true));
    expect(even.winner).toBeNull();
    expect(even.survivors.player).toBe(0);

    const oneMore = fightOut(facingBlocks('marksman', 23, 22, true));
    expect(oneMore.winner).toBe('player');
    expect(oneMore.survivors.player).toBeGreaterThanOrEqual(4);

    const design = facingBlocks('marksman', 35, 22, true);
    expect(cohesionEffectiveness(design, unitsOf(design, 'player')[0]!)).toBe(0.625);
    const designOut = fightOut(design);
    expect(designOut.winner).toBe('player');
    expect(designOut.survivors.rival).toBe(0);
    expect(designOut.survivors.player).toBeGreaterThanOrEqual(17);
    expect(margin(designOut)).toBe(1);
  });

  it('falls short at the floor too: minEffectiveness does not save the smaller army', () => {
    // Worth separating, because it says the slope is not the only thing to
    // retune. 42 units sit exactly on `COHESION.minEffectiveness`, the hardest
    // the mechanic can ever hit a stack — and the stack still annihilates 22
    // and keeps 25 of its own. No value of `penaltyPerUnit` reaches §2's
    // outcome while the floor is 0.45 and the penalty is applied to damage
    // alone; 42 × 42 × 0.45 is still far more fighting power than 22 × 22 ×
    // 0.95. Melee agrees: 35 Legionnaires advancing on 22 keep 25 of 35.
    const floored = facingBlocks('marksman', 42, 22, true);
    expect(cohesionEffectiveness(floored, unitsOf(floored, 'player')[0]!))
      .toBe(COHESION.minEffectiveness);
    const flooredOut = fightOut(floored);
    expect(flooredOut.winner).toBe('player');
    expect(flooredOut.survivors.player).toBeGreaterThanOrEqual(25);

    const melee = fightOut(facingBlocks('legionnaire', 35, 22, false));
    expect(melee.winner).toBe('player');
    expect(melee.survivors.player).toBeGreaterThanOrEqual(25);
  });
});
