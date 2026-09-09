import { describe, expect, it } from 'vitest';
import { COMBAT } from '../../src/data/tuning';
import { UNIT_TYPES } from '../../src/data/units';
import { elevationMultiplier } from '../../src/sim/combat';
import { HIGH_GROUND_THRESHOLD, terrainHeightAt } from '../../src/sim/terrain';
import type { Team, UnitTypeKey, World } from '../../src/core/types';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';
import type { Placement } from './harness';

/**
 * §2: "Flanking, high ground, ambush, and terrain are extremely important to
 * fight outcomes." This file asks whether the shipped simulation delivers the
 * high-ground half of that claim, and how much it is worth in units.
 *
 * The scenarios in the first two blocks are marksman lines, and that used to be
 * forced rather than chosen: `HIGH_GROUND_THRESHOLD` is 0.6 and the terrain
 * formula's steepest slope climbed about 0.274 per unit of ground, so two
 * combatants had to stand at least ~2.19 apart before the bonus could exist at
 * all. A Legionnaire's contact reach is 1.74, so it never could. Terrain relief
 * is now scaled by 1.35 (B-009), the steepest slope climbs about 0.370 per
 * unit, and the melee threshold distance falls to ~1.62 — inside contact reach.
 * The last block measures what melee can now do with that, and it is a
 * genuinely scarce position rather than a free one.
 *
 * Every site here is *found by sampling* `terrainHeightAt`, never assumed.
 * B-007 made the terrain even under 180° rotation, so a point and its mirror are
 * now guaranteed to be the same height — any test that located a hill by taking
 * the mirror of a spawn would be searching for something that can no longer
 * exist, and `phase1.test.ts` had exactly that bug. The search here is also
 * whole-formation rather than centre-to-centre: it maximises the gap between the
 * *lowest* point of the high line and the *highest* point of the low one, so no
 * unit in the engagement is quietly on the wrong tier.
 *
 * These fights are static by construction. Both lines start inside weapon reach,
 * so `stepPursuit` leaves them standing (B-006's pursuit only fires when a
 * target is out of range), and a scenario asserts that below. That matters
 * because a unit that walks changes its own elevation mid-fight, which would
 * make the measurement a function of pathing rather than of position.
 */

/** Furthest apart two units of these types can stand and still trade blows. */
function contactReach(attacker: UnitTypeKey, defender: UnitTypeKey): number {
  const a = UNIT_TYPES[attacker];
  return a.combat.range + a.radius + UNIT_TYPES[defender].radius;
}

/** Frontage each line occupies along z. Both sides always hold the same. */
const FRONTAGE = 7;

/** Slack under weapon reach, so a rounding error cannot drop a pair out of
 *  range and turn the scenario into a walking simulation. */
const SEPARATION = contactReach('marksman', 'marksman') - 0.4;

interface Slope {
  /** x of the uphill line. */ hiX: number;
  /** x of the downhill line. */ loX: number;
  /** z the two lines are centred on. */ z: number;
  /** Worst-case height gap across the whole engagement. */ drop: number;
}

/**
 * The steepest place on the board where two lines `separation` apart can face
 * each other with every pair of them on opposite sides of the threshold.
 *
 * Scored on the worst pair rather than the centre pair. A site chosen on its
 * midpoint can have its flanks level, and a scenario built there would measure
 * a half-applied bonus while claiming to measure a whole one.
 */
function steepestSlope(separation: number, frontage: number): Slope {
  let best: Slope = { hiX: 0, loX: separation, z: 0, drop: -Infinity };
  for (let cx = -24; cx <= 24; cx += 0.5) {
    for (let cz = -24; cz <= 24; cz += 0.5) {
      const hiX = cx - separation / 2;
      const loX = cx + separation / 2;
      let hiFloor = Infinity;
      let loCeiling = -Infinity;
      for (let dz = -frontage / 2; dz <= frontage / 2 + 1e-9; dz += 0.25) {
        hiFloor = Math.min(hiFloor, terrainHeightAt(hiX, cz + dz));
        loCeiling = Math.max(loCeiling, terrainHeightAt(loX, cz + dz));
      }
      if (hiFloor - loCeiling > best.drop) {
        best = { hiX, loX, z: cz, drop: hiFloor - loCeiling };
      }
    }
  }
  return best;
}

/** Measured: hiX 6.57, loX 14.43, z 0 — a 1.004 drop across the whole frontage. */
const RIDGE = steepestSlope(SEPARATION, FRONTAGE);

// Facing is pinned so the flank multiplier is 1 for every pair and elevation is
// the only positional term left moving. Left at the spawn default of 0 both
// lines take each other in the side arc, which would inflate both sides' damage
// by 1.15 and make it harder to attribute the result to the hill.
const LOOK_DOWNHILL = Math.PI / 2;   // toward +x, where the low line stands
const LOOK_UPHILL = -Math.PI / 2;

const other = (team: Team): Team => (team === 'player' ? 'rival' : 'player');

/** `hiCount` marksmen on the ridge against `loCount` in the hollow below. */
function slopeFight(hiCount: number, loCount: number, uphill: Team = 'player') {
  return arena([
    ...line('marksman', uphill, hiCount, RIDGE.hiX, {
      zOffset: RIDGE.z, facing: LOOK_DOWNHILL, spacing: FRONTAGE / Math.max(hiCount - 1, 1),
    }),
    ...line('marksman', other(uphill), loCount, RIDGE.loX, {
      zOffset: RIDGE.z, facing: LOOK_UPHILL, spacing: FRONTAGE / Math.max(loCount - 1, 1),
    }),
  ]);
}

/**
 * The same engagement on ground that is level *by construction*.
 *
 * The two lines sit at ±SEPARATION/2 on z = 0, which are 180° mirrors of each
 * other — so B-007's rotational symmetry guarantees they are the same height,
 * for any coefficients a later art pass picks. That makes this a control that
 * cannot silently stop being level.
 */
function levelFight(left: number, right: number) {
  return arena([
    ...line('marksman', 'player', left, -SEPARATION / 2, {
      facing: LOOK_DOWNHILL, spacing: FRONTAGE / Math.max(left - 1, 1),
    }),
    ...line('marksman', 'rival', right, SEPARATION / 2, {
      facing: LOOK_UPHILL, spacing: FRONTAGE / Math.max(right - 1, 1),
    }),
  ]);
}

describe('high ground decides fights', () => {
  it('is fought on a real height gap, found by sampling rather than assumed', () => {
    expect(RIDGE.drop, `worst pair drops ${RIDGE.drop.toFixed(3)}`)
      .toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);

    // Not a spawn asymmetry: the mirror of the ridge is the same ground, which
    // is the property B-007 installed and the reason the gap has to be hunted
    // for locally instead of read off a spawn pair.
    expect(terrainHeightAt(RIDGE.hiX, RIDGE.z))
      .toBeCloseTo(terrainHeightAt(-RIDGE.hiX, -RIDGE.z), 12);

    // Every cross pair, not just the centre one — a flank standing on level
    // ground would dilute the measurement without failing anything obvious.
    const world = slopeFight(8, 8);
    for (const up of unitsOf(world, 'player')) {
      for (const down of unitsOf(world, 'rival')) {
        expect(elevationMultiplier(up, down)).toBe(COMBAT.highGroundBonus);
        expect(elevationMultiplier(down, up)).toBe(COMBAT.lowGroundPenalty);
      }
    }
  });

  it('is decided by where the units stand, not by where they walk', () => {
    // If pursuit dragged either line off its tier the result would be about
    // movement, not elevation. Both lines open inside weapon reach, so nothing
    // should shift by a single float.
    const world = slopeFight(8, 8);
    const spawn = new Map(world.units.map(u => [u.id, { x: u.x, z: u.z }]));
    fightOut(world);
    for (const u of world.units) {
      const at = spawn.get(u.id)!;
      expect(u.x).toBe(at.x);
      expect(u.z).toBe(at.z);
    }
  });

  it('the same force wins from above and loses from below', () => {
    const above = fightOut(slopeFight(8, 8, 'player'));
    const below = fightOut(slopeFight(8, 8, 'rival'));

    expect(above.winner).toBe('player');
    expect(above.survivors).toEqual({ player: 8, rival: 0 });
    expect(margin(above)).toBe(1);

    expect(below.winner).toBe('rival');
    expect(below.survivors).toEqual({ player: 0, rival: 8 });
    expect(margin(below)).toBe(-1);

    // Identical forces, identical ground, only the side of the hill swapped —
    // so the two runs must be exact reflections. Anything else would mean the
    // outcome still carried some of B-005's insertion-order bias.
    expect(above.hp.player).toBe(below.hp.rival);
    expect(above.ticks).toBe(below.ticks);

    // Recorded measurement: a clean sweep, 163.016 HP of 960 left standing
    // (20.4 of 70 per survivor), in 144 ticks — 4.8s at 30Hz, which is §2's
    // "quick and decisive". Re-record deliberately if the tuning changes.
    expect(above.hp.player).toBeCloseTo(163.016, 3);
    expect(above.ticks).toBe(144);
  });

  it('the identical fight on level ground annihilates both sides', () => {
    // The control. Same units, same spacing, same separation, no height gap:
    // if this did anything other than cancel out, the scenario above would be
    // measuring something other than the hill.
    const world = levelFight(8, 8);
    const outcome = fightOut(world);
    expect(outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(outcome.winner).toBeNull();
    expect(margin(outcome)).toBe(0);
  });

  it('pulls ahead from the first volley rather than from a late collapse', () => {
    // §2 wants the *initial positioning* to decide the fight. Read the state
    // well before anyone dies: if the hill only mattered once bodies started
    // dropping, the advantage would be a snowball, not a position.
    const world = slopeFight(8, 8);
    fightOut(world, 108);
    const mid = tally(world);
    expect(mid.survivors).toEqual({ player: 8, rival: 8 });
    // Measured 343.9 against 242.2 — a 1.42x health lead with the casualty
    // count still level, which is the elevation multiplier compounding.
    expect(mid.hp.player / mid.hp.rival).toBeGreaterThan(1.4);
  });
});

describe('high ground against a numerical deficit', () => {
  /** The largest low-ground force the eight on the ridge still beat. */
  function breakEven(hiCount: number): number {
    let last = 0;
    for (let lo = hiCount; lo <= hiCount * 2; lo++) {
      if (fightOut(slopeFight(hiCount, lo)).winner !== 'player') break;
      last = lo;
    }
    return last;
  }

  it('carries a one-in-eight deficit and no more', () => {
    // The break-even point asked for: eight on the ridge beat nine below and
    // lose to ten. High ground is worth between 12.5% and 25% of an army —
    // call it a fifth, and nowhere near the "extremely important" §2 claims for
    // it if that is read as beating a meaningfully larger force.
    expect(breakEven(8)).toBe(9);

    const held = fightOut(slopeFight(8, 9));
    expect(held.winner).toBe('player');
    expect(held.survivors).toEqual({ player: 5, rival: 0 });

    const lost = fightOut(slopeFight(8, 10));
    expect(lost.winner).toBe('rival');
    expect(lost.survivors).toEqual({ player: 0, rival: 2 });
    // Measured 7.0 HP of 700 left on the winning side — a tenth of one unit.
    // Ten below the ridge beat eight on it, but only just, which is the shape
    // §2 asks for even though it lands one unit short of the round number.
    expect(lost.hp.rival).toBeLessThan(UNIT_TYPES.marksman.combat.hp);
  });

  it('flips a fight that level ground loses', () => {
    // The same 8-against-9 with the hill taken away. Without elevation the
    // outnumbered side is wiped and four of the nine walk away, so the hill is
    // not merely padding a win the numbers already gave.
    const level = fightOut(levelFight(8, 9));
    expect(level.winner).toBe('rival');
    expect(level.survivors).toEqual({ player: 0, rival: 4 });
    expect(fightOut(slopeFight(8, 9)).winner).toBe('player');
  });
});

// --- Melee on a hill (B-009) ----------------------------------------------

const MELEE_REACH = contactReach('legionnaire', 'legionnaire');
/** Slack under reach, so a rounding error cannot drop the two lines apart. */
const MELEE_SEPARATION = MELEE_REACH - 0.04;

interface MeleeSlope {
  hi: { x: number; z: number };
  lo: { x: number; z: number };
  /** Unit vector pointing from the high line toward the low one. */
  down: { x: number; z: number };
  /** Worst-case height gap across the whole engagement. */
  drop: number;
}

/**
 * The steepest place on the board where two melee lines of `count` models can
 * stand in contact with every cross pair across the threshold.
 *
 * This searches **orientation as well as position**, and that is the part that
 * matters. The marksman search above only has to look along x, because at 8.26
 * apart the board's broad swell dominates and any direction will do. At 1.70
 * apart the gap is the local gradient times the separation, and the steepest
 * gradient on this terrain runs diagonally — a melee line laid out along x
 * finds 0.5898 at best and never crosses 0.600, while the same line rotated
 * 112.5 degrees finds 0.6246. A search that assumed an axis would conclude
 * melee still cannot reach high ground, and would be wrong.
 */
function steepestMeleeSlope(count: number, spacing = 1): MeleeSlope {
  let best: MeleeSlope = {
    hi: { x: 0, z: 0 }, lo: { x: 0, z: 0 }, down: { x: 1, z: 0 }, drop: -Infinity,
  };
  for (let d = 0; d < 32; d++) {
    const angle = (d / 32) * Math.PI * 2;
    const ux = Math.cos(angle);
    const uz = Math.sin(angle);
    for (let cx = -32; cx <= 32; cx += 0.5) {
      for (let cz = -32; cz <= 32; cz += 0.5) {
        let hiFloor = Infinity;
        let loCeiling = -Infinity;
        for (let k = 0; k < count; k++) {
          const o = (k - (count - 1) / 2) * spacing;
          // Frontage runs perpendicular to the slope, so both lines stay level
          // with themselves and only cross the threshold against each other.
          hiFloor = Math.min(hiFloor, terrainHeightAt(
            cx - ux * MELEE_SEPARATION / 2 - uz * o, cz - uz * MELEE_SEPARATION / 2 + ux * o));
          loCeiling = Math.max(loCeiling, terrainHeightAt(
            cx + ux * MELEE_SEPARATION / 2 - uz * o, cz + uz * MELEE_SEPARATION / 2 + ux * o));
        }
        if (hiFloor - loCeiling > best.drop) {
          best = {
            hi: { x: cx - ux * MELEE_SEPARATION / 2, z: cz - uz * MELEE_SEPARATION / 2 },
            lo: { x: cx + ux * MELEE_SEPARATION / 2, z: cz + uz * MELEE_SEPARATION / 2 },
            down: { x: ux, z: uz },
            drop: hiFloor - loCeiling,
          };
        }
      }
    }
  }
  return best;
}

/** Two melee lines facing each other across `slope`, `uphill` on the high side. */
function meleeSlopeFight(slope: MeleeSlope, count: number, uphill: Team, spacing = 1): World {
  const downhill = Math.atan2(slope.down.x, slope.down.z);
  const places: Placement[] = [];
  for (let k = 0; k < count; k++) {
    const o = (k - (count - 1) / 2) * spacing;
    places.push({
      type: 'legionnaire', team: uphill,
      x: slope.hi.x - slope.down.z * o, z: slope.hi.z + slope.down.x * o,
      facing: downhill,
    });
    places.push({
      type: 'legionnaire', team: other(uphill),
      x: slope.lo.x - slope.down.z * o, z: slope.lo.z + slope.down.x * o,
      facing: downhill + Math.PI,
    });
  }
  return arena(places);
}

/**
 * Melee can now hold a hill, and only just.
 *
 * This block used to be headed "melee cannot reach high ground at all" and
 * encoded the shortfall as measured behaviour: the largest height gap available
 * anywhere on any map at a Legionnaire's contact reach of 1.74 was 0.4783
 * against a threshold of 0.600 — 80% of the way and no further — so §2 named
 * high ground as one of four things that decide fights while §8.7's core melee
 * unit could never receive or suffer the modifier.
 *
 * Terrain relief is now scaled by 1.35, which closes it. The lever was chosen
 * over lowering the threshold deliberately: a threshold of 0.47 would have
 * fired the bonus on very nearly every slope, and a bonus that is always on is
 * not something a commander positions for. Scarcity is the feature, so the
 * scarcity is measured here rather than assumed.
 */
describe('melee can hold high ground, on the few places that offer it', () => {
  it('finds a real height gap at contact reach, where there was none', () => {
    // Exhaustive over the board and over direction, not a spot check: this is a
    // claim about every tile of every map, and the terrain is a fixed formula
    // (D-017), so it is the same claim for every seed. The disc is swept out to
    // 42, past the largest polygon `mapBoundaryForSeed` can produce.
    const REACHABLE = 42;
    let steepest = 0;
    for (let x = -REACHABLE; x <= REACHABLE; x += 0.5) {
      for (let z = -REACHABLE; z <= REACHABLE; z += 0.5) {
        if (Math.hypot(x, z) > REACHABLE) continue;
        const here = terrainHeightAt(x, z);
        for (let k = 0; k < 32; k++) {
          const angle = (k / 32) * Math.PI * 2;
          const there = terrainHeightAt(
            x + Math.cos(angle) * MELEE_REACH,
            z + Math.sin(angle) * MELEE_REACH,
          );
          steepest = Math.max(steepest, here - there);
        }
      }
    }
    // 0.6435 against 0.600, from 0.4783 before. 7% of headroom, which is the
    // whole design: enough to exist, not enough to be everywhere.
    expect(steepest).toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);
    expect(steepest).toBeCloseTo(0.6435, 3);
  });

  it('offers it on about one square of ground in twenty-five', () => {
    // The scarcity number, and the reason the amplitude lever was preferred to
    // the threshold one. A commander who wants a melee hill has to go and find
    // one; there is no slope that hands it over by accident.
    let sites = 0;
    let total = 0;
    for (let x = -36; x <= 36; x += 1) {
      for (let z = -36; z <= 36; z += 1) {
        if (Math.hypot(x, z) > 36) continue;
        total++;
        const here = terrainHeightAt(x, z);
        for (let k = 0; k < 32; k++) {
          const angle = (k / 32) * Math.PI * 2;
          const gap = here - terrainHeightAt(
            x + Math.cos(angle) * MELEE_REACH, z + Math.sin(angle) * MELEE_REACH);
          if (gap >= HIGH_GROUND_THRESHOLD) { sites++; break; }
        }
      }
    }
    expect(sites / total).toBeGreaterThan(0.02);
    expect(sites / total).toBeLessThan(0.06);
    expect(sites).toBe(160);       // of 4053 sampled — 3.95%
  });

  it('sweeps the field from above and is swept from below, on the same ground', () => {
    const slope = steepestMeleeSlope(3);
    expect(slope.drop).toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);
    expect(slope.drop).toBeCloseTo(0.6246, 3);

    // Every cross pair, not only the centre one — a flank standing level would
    // dilute the measurement without failing anything obvious.
    const world = meleeSlopeFight(slope, 3, 'player');
    for (const up of unitsOf(world, 'player')) {
      for (const down of unitsOf(world, 'rival')) {
        expect(elevationMultiplier(up, down)).toBe(COMBAT.highGroundBonus);
        expect(elevationMultiplier(down, up)).toBe(COMBAT.lowGroundPenalty);
      }
    }

    // THE CLAIM, MET, for the unit §8.7 builds around holding a line. Three
    // Legionnaires uphill wipe out three below without losing a model, in 360
    // ticks. Before B-009 the same search returned the best ground on the board
    // and the best ground on the board was a dead mirror.
    const above = fightOut(meleeSlopeFight(slope, 3, 'player'));
    const below = fightOut(meleeSlopeFight(slope, 3, 'rival'));
    expect(above.winner).toBe('player');
    expect(above.survivors).toEqual({ player: 3, rival: 0 });
    expect(margin(above)).toBe(1);
    expect(above.hp.player).toBeCloseTo(103.351, 3);
    expect(above.ticks).toBe(360);

    // Identical forces, identical ground, only the side of the hill swapped, so
    // the two runs must be exact reflections of each other.
    expect(below.winner).toBe('rival');
    expect(below.hp.rival).toBe(above.hp.player);
    expect(below.ticks).toBe(above.ticks);
  });

  it('draws the identical melee fight on ground that is level by construction', () => {
    // The control. The two lines sit at 180-degree mirrors of each other, so
    // B-007's rotational symmetry guarantees equal height for any coefficients
    // a later art pass picks — this control cannot silently stop being level.
    const places: Placement[] = [];
    for (let k = 0; k < 3; k++) {
      const o = k - 1;
      places.push({ type: 'legionnaire', team: 'player', x: -MELEE_SEPARATION / 2, z: o, facing: LOOK_DOWNHILL });
      places.push({ type: 'legionnaire', team: 'rival', x: MELEE_SEPARATION / 2, z: -o, facing: LOOK_UPHILL });
    }
    const outcome = fightOut(arena(places));
    expect(outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(margin(outcome)).toBe(0);
    expect(outcome.ticks).toBe(456);
  });

  it('runs out of hill at five models abreast', () => {
    // THE HONEST LIMIT, and the number to quote if this ever needs retuning.
    // The gap shrinks as the frontage widens, because a wider line has to keep
    // its worst pair across the threshold as well as its best: 0.6246 at three
    // models, 0.6154 at four, 0.6033 at five, 0.5906 at six. So a melee hill
    // holds a section and not a battle line — a twelve-model front cannot be
    // put on high ground anywhere on this map, and §8.7's shield wall is
    // therefore still a level-ground mechanic at full frontage.
    expect(steepestMeleeSlope(4).drop).toBeGreaterThanOrEqual(HIGH_GROUND_THRESHOLD);
    expect(steepestMeleeSlope(6).drop).toBeLessThan(HIGH_GROUND_THRESHOLD);
    expect(steepestMeleeSlope(6).drop).toBeCloseTo(0.5906, 3);
  });
});
