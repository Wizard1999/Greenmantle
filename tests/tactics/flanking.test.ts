import { describe, expect, it } from 'vitest';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';
import type { Outcome, Placement } from './harness';
import { approachFrom, elevationMultiplier, findTarget } from '../../src/sim/combat';
import type { Approach } from '../../src/sim/combat';
import { HIGH_GROUND_THRESHOLD, terrainHeightAt } from '../../src/sim/terrain';
import { COMBAT } from '../../src/data/tuning';
import { UNIT_TYPES } from '../../src/data/units';
import type { World } from '../../src/core/types';

/**
 * Flanking (§2 — "flanking, high ground, ambush and terrain are extremely
 * important to fight outcomes"; `COMBAT.flankBonus` 1.35 against `sideBonus`
 * 1.15, front arc ±1.05 rad).
 *
 * The claim under test is not "a multiplier exists" — that is a one-line unit
 * test and it proves nothing about play. It is that *attacking from behind
 * changes who wins*. So every scenario below is two forces that are identical
 * in composition, in numbers and in the distance they march, differing only in
 * facing or in the side they arrive on, and the thing measured is the result of
 * the fight rather than a damage number.
 *
 * **What was found.** The multiplier is decisive — enormously so. A 10v10 that
 * both sides face into is mutual annihilation; the same 10v10 with the defender
 * facing away is 10–0. Twelve models split into an anvil and a hammer beat the
 * same twelve in one block, and beat the same twelve split into two waves that
 * both arrive in front.
 *
 * **What was also found, and matters more.** *Approach angle on its own buys
 * nothing at all.* Two forces marching into an unengaged defender from exactly
 * opposite sides produce byte-identical outcomes at every separation tested,
 * because `stepPursuit` sends the defender at whatever it has acquired and
 * `stepMovement` then writes `facing = atan2(dx, dz)` with no turn rate — so a
 * defender reverses its facing in a single tick, nine units short of contact,
 * for free. Flanking is therefore only purchasable against an enemy someone
 * else is already holding. The scenarios that fall short say so in place, with
 * the measured numbers, rather than being softened until they pass.
 *
 * Elevation is the obvious confound for all of this, since `highGroundBonus`
 * 1.25 is the same order as `flankBonus` 1.35. Every reading below carries a
 * count of attacks resolved across an elevation band, and every one of them is
 * zero; the first test explains why.
 */

/** Facings, in the `atan2(dx, dz)` convention `approachFrom` and movement share. */
const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;
const NORTH = 0;

/** Close enough that both lines open fire on tick one and neither has to walk. */
const CONTACT = 1.2;

/** The box every placement below sits in, plus room for a leashed pursuit. */
const FOOTPRINT = { minX: -14, maxX: 14, minZ: -10, maxZ: 10 };

/** Melee reach: weapon range plus both radii, so the widest gap over which one
 *  Legionnaire can strike another. */
const REACH = UNIT_TYPES.legionnaire.combat.range + UNIT_TYPES.legionnaire.radius * 2;

interface Reading {
  outcome: Outcome;
  /** Player unit-ticks spent inside weapon reach, split by the arc they stood
   *  in. A proportion, not an attack count — cooldowns are not modelled here. */
  arc: Record<Approach, number>;
  /** Unit-ticks in which an attacker and its target were in different elevation
   *  bands. Zero everywhere, which is what keeps these readings about facing. */
  uphill: number;
  /** Surviving health lead in absolute HP. `margin` saturates at ±1 the moment
   *  one side is wiped out, and most of these fights end that way, so the
   *  comparisons need a score that keeps moving after the win is decided. */
  lead: number;
}

function observe(world: World, arc: Record<Approach, number>): number {
  let uphill = 0;
  for (const unit of world.units) {
    const target = findTarget(world, unit);
    if (!target) continue;
    if (Math.hypot(target.x - unit.x, target.z - unit.z) > REACH) continue;
    if (elevationMultiplier(unit, target) !== 1) uphill++;
    if (unit.team === 'player') arc[approachFrom(unit, target)]++;
  }
  return uphill;
}

/** Fight it out, watching the arcs the player's units actually stood in. */
function fight(placements: readonly Placement[]): Reading {
  const world = arena(placements);
  const arc: Record<Approach, number> = { front: 0, side: 0, rear: 0 };
  let uphill = 0;
  let ticks = 0;
  for (; ticks < 5400; ticks++) {
    const step = fightOut(world, 1);
    uphill += observe(world, arc);
    if (step.survivors.player === 0 || step.survivors.rival === 0) break;
  }
  const outcome: Outcome = { ticks, ...tally(world) };
  return { outcome, arc, uphill, lead: outcome.hp.player - outcome.hp.rival };
}

const defenders = (count: number, x: number, facing: number): Placement[] =>
  line('legionnaire', 'rival', count, x, { facing });
const attackers = (count: number, x: number, facing: number): Placement[] =>
  line('legionnaire', 'player', count, x, { facing });

// --- The ground these fights are measured on ------------------------------

describe('the arena is one elevation band', () => {
  it('never lets a melee pair straddle the high-ground threshold', () => {
    // Every margin in this file is meant to be a facing effect. `highGroundBonus`
    // is 1.25 against `flankBonus` 1.35, so a slope inside the footprint would
    // be indistinguishable from the thing under test — and B-007 is the
    // reminder that terrain asymmetry hid inside a "mirrored" fight once
    // already. This checks the stronger property: not that the ground is
    // symmetric, but that no two points close enough to fight are in different
    // bands at all, so `elevationMultiplier` is 1 for every pair, always.
    let worst = 0;
    const offsets = [[REACH, 0], [0, REACH], [REACH * 0.71, REACH * 0.71], [REACH * 0.71, -REACH * 0.71]];
    for (let x = FOOTPRINT.minX; x <= FOOTPRINT.maxX; x += 0.5) {
      for (let z = FOOTPRINT.minZ; z <= FOOTPRINT.maxZ; z += 0.5) {
        for (const offset of offsets) {
          const dx = offset[0] ?? 0;
          const dz = offset[1] ?? 0;
          worst = Math.max(worst, Math.abs(terrainHeightAt(x, z) - terrainHeightAt(x + dx, z + dz)));
        }
      }
    }
    expect(worst).toBeLessThan(HIGH_GROUND_THRESHOLD); // measured 0.442 against 0.6
  });
});

// --- Does facing decide who wins? -----------------------------------------

/** Two identical ten-model lines already in contact. The player always faces
 *  its enemy; only the defender's facing changes between runs. Nothing else in
 *  the world differs — same models, same positions, same ground. */
function facingFight(rivalFacing: number): Reading {
  return fight([
    ...attackers(10, -CONTACT / 2, EAST),
    ...defenders(10, CONTACT / 2, rivalFacing),
  ]);
}

describe('flanking decides who wins', () => {
  it('turns a mutual annihilation into a fight without a single loss', () => {
    const head = facingFight(WEST);
    const back = facingFight(EAST);

    // The control is a true 180-degree rotation of the board, and terrain is
    // even under that rotation since B-007, so it must resolve as a dead heat.
    // If this ever comes out lopsided the suite is measuring array order again.
    expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(margin(head.outcome)).toBe(0);
    expect(head.arc.rear).toBe(0);

    // Same models, same ground, same tick one. The defender is looking the
    // other way and loses every single unit without killing one.
    expect(back.outcome.winner).toBe('player');
    expect(back.outcome.survivors).toEqual({ player: 10, rival: 0 });
    expect(back.arc.front).toBe(0);
    expect(back.uphill).toBe(0);

    // Decisive, and quicker: 336 ticks against 456, so the fight is not merely
    // won but over 120 ticks — four simulated seconds — sooner.
    expect(back.outcome.ticks).toBeLessThan(head.outcome.ticks);
    expect(back.outcome.ticks).toBe(336);
    expect(head.outcome.ticks).toBe(456);
  });

  it('separates front, side and rear into three distinguishable outcomes', () => {
    const head = facingFight(WEST);
    const flank = facingFight(NORTH);
    const back = facingFight(EAST);

    expect(flank.arc.side).toBeGreaterThan(flank.arc.front + flank.arc.rear);
    expect(back.arc.rear).toBeGreaterThan(back.arc.front + back.arc.side);

    // Survivor count cannot tell side from rear — both are 10–0 — so the
    // separation has to be read in surviving health and in how long the loser
    // held out. All three are far apart on both.
    expect(head.outcome.hp.player).toBe(0);
    expect(flank.outcome.hp.player).toBeCloseTo(147.65, 0);
    expect(back.outcome.hp.player).toBeCloseTo(273.04, 0);
    expect(head.outcome.ticks).toBe(456);
    expect(flank.outcome.ticks).toBe(384);
    expect(back.outcome.ticks).toBe(336);

    // The whole point of the claim: rear is not a slightly better side. It
    // returns 1.85x the surviving force, against a bonus only 17% larger.
    expect(back.outcome.hp.player / flank.outcome.hp.player).toBeGreaterThan(1.8);
  });

  it('treats the frontal arc as a hard edge, not a gradient', () => {
    // Bearing from a defender at +CONTACT/2 to the attacking line at -CONTACT/2.
    const bearing = WEST;
    const at = (offset: number): Reading => facingFight(bearing - offset);
    const eps = 0.02; // a little over one degree either side of the arc

    const justInside = at(COMBAT.frontArc - eps);
    const justOutside = at(COMBAT.frontArc + eps);
    const stillSide = at(Math.PI - COMBAT.rearArc - eps);
    const justRear = at(Math.PI - COMBAT.rearArc + eps);

    // Two degrees of facing is the whole difference between losing every model
    // and losing none. That edge is what makes the arc worth scouting and worth
    // drawing on screen; a soft falloff would make it unreadable and
    // unactionable, which is the opposite of §2's "initial positioning decides".
    expect(justInside.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(justOutside.outcome.survivors).toEqual({ player: 10, rival: 0 });
    expect(justInside.arc.side).toBe(0);
    expect(justOutside.arc.side).toBeGreaterThan(justOutside.arc.front * 100);

    // ...and the same again at the rear boundary, where the step is smaller but
    // still worth 125 HP of surviving force.
    expect(stillSide.outcome.hp.player).toBeCloseTo(147.65, 0);
    expect(justRear.outcome.hp.player).toBeCloseTo(273.04, 0);
  });
});

// --- Is it worth splitting a force to get behind someone? -----------------

/** Twelve defenders holding a line, faced the way an attack is coming from. */
const holdingLine = (): Placement[] => defenders(12, 0, WEST);
/** Six models already locked in melee with that line — the anvil. */
const anvil = (): Placement[] => attackers(6, -CONTACT, EAST);

describe('splitting a force to take the enemy from behind', () => {
  it('rewards the wing that arrives behind rather than in front', () => {
    // The control that matters. Both runs field twelve models, six of them
    // already in contact and six marching in from exactly `d` away. The only
    // difference is which side the second wing comes from — so anything the
    // hammer gains cannot be the extra numbers, the staggered arrival, or the
    // march time, all of which are held equal.
    for (const d of [4, 6, 8]) {
      const hammer = fight([...anvil(), ...attackers(6, d, WEST), ...holdingLine()]);
      const column = fight([...anvil(), ...attackers(6, -d, EAST), ...holdingLine()]);

      expect(hammer.uphill).toBe(0);
      expect(column.uphill).toBe(0);
      expect(column.arc.rear).toBeLessThan(10); // reinforcing from the front earns nothing
      expect(hammer.arc.rear).toBeGreaterThan(1000);
      expect(hammer.lead).toBeGreaterThan(column.lead);
    }

    // The size of it, at d = 6: arriving behind wins the fight outright, and
    // arriving in front loses it. Same twelve models, same second wave, same
    // distance walked.
    const hammer6 = fight([...anvil(), ...attackers(6, 6, WEST), ...holdingLine()]);
    const column6 = fight([...anvil(), ...attackers(6, -6, EAST), ...holdingLine()]);
    expect(hammer6.outcome.winner).toBe('player');
    expect(column6.outcome.winner).toBe('rival');
  });

  it('beats the same force attacking in one block, while the hammer is close', () => {
    // The block is the honest comparison: twelve models all in contact at once,
    // no march, no stagger. It is a dead heat, because nobody is behind anybody.
    const block = fight([...attackers(12, -CONTACT, EAST), ...holdingLine()]);
    expect(block.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(block.lead).toBe(0);

    // Split into anvil and hammer, the same twelve models win outright.
    const near = fight([...anvil(), ...attackers(6, 4, WEST), ...holdingLine()]);
    expect(near.outcome.survivors).toEqual({ player: 8, rival: 0 });
    expect(near.lead).toBeCloseTo(290.1, 0);

    const mid = fight([...anvil(), ...attackers(6, 6, WEST), ...holdingLine()]);
    expect(mid.outcome.winner).toBe('player');
    expect(mid.lead).toBeCloseTo(35.9, 0);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured. Push the hammer out
    // to 8 and the same manoeuvre loses a fight the block at least drew: the
    // rival finishes with 4 models and 214.9 HP standing. The anvil is six
    // against twelve for the ~45 ticks the hammer needs to march in, and 1.35x
    // on the back half of the fight does not repay being beaten in detail on the
    // front half. So the bonus is decisive but the *manoeuvre* only pays inside
    // a radius, and that radius sits between 6 and 8 — under one acquire range
    // (9.0), which is to say a flank must be launched from a distance at which
    // the enemy can already see it coming. Nothing in the design says so, and it
    // is the number to revisit if flanking is meant to reward planning.
    const far = fight([...anvil(), ...attackers(6, 8, WEST), ...holdingLine()]);
    expect(far.outcome.winner).toBe('rival');
    expect(far.lead).toBeCloseTo(-214.9, 0);
    expect(far.lead).toBeLessThan(block.lead);
  });
});

// --- Where the claim does not hold ----------------------------------------

describe('what the flank bonus cannot be earned by', () => {
  it('gives approach angle against an unengaged enemy no value whatsoever', () => {
    // The scenario a player would call flanking: ten models march into a
    // defending line of ten, either head-on or all the way around behind it.
    // Identical forces, identical distance, opposite sides.
    //
    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured — and the shortfall
    // is exact rather than approximate. The two outcomes are not merely close,
    // they are *the same object*: same tick count, same survivors, same
    // surviving health, at every separation from 3 up to acquire range. The
    // long march around the back is worth precisely zero.
    for (const d of [3, 5, 7, 9]) {
      const head = fight([...attackers(10, -d, EAST), ...defenders(10, 0, WEST)]);
      const behind = fight([...attackers(10, d, WEST), ...defenders(10, 0, WEST)]);

      expect(behind.outcome).toEqual(head.outcome);
      expect(behind.arc).toEqual(head.arc);
      expect(behind.arc.rear).toBe(0); // not one unit-tick spent behind anybody
      expect(margin(behind.outcome)).toBe(0);
    }
  });

  it('lets a defender reverse its facing in one tick, nine units from contact', () => {
    // The mechanic responsible for the test above, isolated. `stepPursuit` hands
    // an idle defender a move target the instant it acquires, and `stepMovement`
    // then writes `facing = atan2(dx, dz)` outright — no turn rate, no cost, no
    // delay. So the defender is square-on to its attacker long before the
    // attacker is in reach, and there is no approach angle left to exploit.
    //
    // This is the mechanic to change if flanking is meant to be reachable by
    // manoeuvre: a turn rate would give the march around the back something to
    // buy. It is a balance decision and not this suite's to make, so what is
    // asserted here is only the present behaviour.
    const world = arena([
      ...attackers(1, 9, WEST),
      ...defenders(1, 0, WEST),
    ]);
    const defender = unitsOf(world, 'rival')[0];
    const attacker = unitsOf(world, 'player')[0];
    if (!defender || !attacker) throw new Error('the pair did not spawn');

    expect(defender.facing).toBe(WEST);
    fightOut(world, 1);
    fightOut(world, 1);

    // Fully reversed on tick two, while the two are still more than four melee
    // reaches apart. There is no window in which the attacker is behind it.
    expect(defender.facing).toBe(EAST);
    expect(Math.hypot(attacker.x - defender.x, attacker.z - defender.z))
      .toBeGreaterThan(REACH * 4);
  });

  it('makes an unpinned split a coin flip rather than a tactic', () => {
    // Both wings marching in from opposite sides with nobody holding the
    // enemy's attention. FALLS SHORT OF THE DESIGN CLAIM, recorded as measured:
    // across five separations the split wins twice and loses three times, while
    // the same twelve models in one block draw every time. The defenders simply
    // turn to face whichever wing is nearest, and the wings get beaten one at a
    // time — the outcome tracks the accident of which wing arrives first, not
    // the plan.
    const results = [3, 4, 5, 6, 8].map(d => {
      const block = fight([...attackers(12, -d, EAST), ...holdingLine()]);
      const split = fight([
        ...attackers(6, -d, EAST), ...attackers(6, d, WEST), ...holdingLine(),
      ]);
      return { d, block: block.lead, split: split.lead };
    });

    expect(results.every(r => r.block === 0)).toBe(true);
    expect(results.filter(r => r.split > 0).map(r => r.d)).toEqual([4, 5]);
    expect(results.filter(r => r.split < 0).map(r => r.d)).toEqual([3, 6, 8]);
  });
});
