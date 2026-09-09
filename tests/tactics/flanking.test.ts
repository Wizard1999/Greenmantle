import { describe, expect, it } from 'vitest';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';
import type { Outcome, Placement } from './harness';
import { approachFrom, elevationMultiplier, findTarget, shieldWallStacks } from '../../src/sim/combat';
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
 * **Re-measured against a split turn rate (B-011).** Facing was first rewritten
 * instantly and unboundedly by `stepMovement`; then bounded by `stepFacing` at
 * a single `turnRate`; it is now bounded at *two* rates — `turnRate` toward the
 * direction of travel, `refaceRate` toward a target the unit is standing and
 * fighting. Every reading in this file has been taken again against that.
 *
 * **Why one rate could not work.** A single rate has to be quick enough that
 * movement does not read as sludge and slow enough that being caught the wrong
 * way round costs something, and those are not the same number. At 0.110
 * rad/tick a Legionnaire reversed in 30 ticks against its own 24-tick attack
 * cooldown, so a defender taken completely from behind was square-on before the
 * second blow landed and a flank was worth *exactly one volley*: 21.94 HP at
 * ten a side, 1.8% of a 1,200 HP pool, and the 10v10 whose defender faced
 * entirely away annihilated on tick 456 — the same tick, with the same
 * survivors, as the head-on fight. The tell was that the rear-to-side lead
 * ratio came out at 2.3333, which is (1.35-1)/(1.15-1) to four figures: one
 * boosted volley each and nothing else.
 *
 * **What a flank is worth now.** `refaceRate` is 0.0367 — one third of the
 * travel rate — so the rear arc holds for 29 ticks and the side arc for 28
 * more. Against a 24-tick cooldown that is **two rear volleys and one side
 * volley**, verified strike by strike below, and the difference is a change of
 * result rather than a change of margin:
 *
 * | defender facing | before | now |
 * |---|---|---|
 * | toward the attack | 0–0, tick 456 | 0–0, tick 456 |
 * | side-on | 0–0, tick 456 | 0–0, tick 456 |
 * | fully away | 0–0, tick 456 | **10–0, tick 432** |
 *
 * Two degrees of facing across the rear boundary now separates a dead heat from
 * an 8–0 win, where before it separated 0 HP of lead from 9.40 HP of lead and
 * nothing else.
 *
 * **And it converts at scale.** Marching ten models around the back of ten,
 * against a mobile enemy nobody is holding, used to be worth *exactly* zero
 * under instant facing and a permanent 21.94 HP lead with no change of result
 * under one bounded rate. It now wins outright, 8–0, at every separation inside
 * 5 — and past 5 it is still worth nothing, because the defenders finish coming
 * about while the attackers are still walking. The far edge of the tactic is
 * unchanged and is recorded below.
 *
 * Hammer-and-anvil is unmoved by any of this, and that is itself a result: an
 * anvil holds the defending line's attention, so the line never turns away from
 * it in the first place and there is no re-facing for a slower rate to slow
 * down. It still pays inside a *band* of hammer distances, roughly 4 to 6, and
 * the near edge of that band is not a facing effect at all — it is the shield
 * wall, which a wing reinforcing from the front stacks into and a wing arriving
 * behind cannot.
 *
 * Elevation is the obvious confound for all of this, since `highGroundBonus`
 * 1.25 is the same order as `flankBonus` 1.35 — and terrain relief was raised
 * by 1.35x in the same change (B-009), so it can no longer be waved away. Every
 * reading below carries a count of attacks resolved across an elevation band,
 * and every one of them is zero; the first test measures the ground and says
 * exactly how much margin that answer has.
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

/** Radians of facing a walking Legionnaire buys per tick. */
const TURN = UNIT_TYPES.legionnaire.turnRate;

/** ...and per tick spent standing and coming about toward a target. Every
 *  window measured in this file is some arc divided by one of these two. */
const REFACE = UNIT_TYPES.legionnaire.refaceRate;

/** Ticks of rear arc a defender taken completely from behind has left, and then
 *  ticks of side arc after that. Both are how far it still has to turn divided
 *  by how fast it turns, plus the tick it spends acquiring before it starts. */
const REAR_WINDOW = Math.floor(COMBAT.rearArc / REFACE) + 1;
const SIDE_WINDOW = Math.floor((Math.PI - COMBAT.rearArc - COMBAT.frontArc) / REFACE);

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
  /**
   * The player's health lead at the tick the two sides stood furthest apart,
   * signed.
   *
   * Since turning became bounded, mirrored engagements nearly all end in mutual
   * annihilation, where the *final* lead is zero by construction and can tell
   * nothing apart. What a flank buys is visible only while both sides are still
   * standing, so it has to be read mid-fight or not at all.
   */
  peakLead: number;
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
  let peakLead = 0;
  let ticks = 0;
  for (; ticks < 5400; ticks++) {
    const step = fightOut(world, 1);
    uphill += observe(world, arc);
    const lead = step.hp.player - step.hp.rival;
    if (Math.abs(lead) > Math.abs(peakLead)) peakLead = lead;
    if (step.survivors.player === 0 || step.survivors.rival === 0) break;
  }
  const outcome: Outcome = { ticks, ...tally(world) };
  return { outcome, arc, uphill, lead: outcome.hp.player - outcome.hp.rival, peakLead };
}

const defenders = (count: number, x: number, facing: number): Placement[] =>
  line('legionnaire', 'rival', count, x, { facing });
const attackers = (count: number, x: number, facing: number): Placement[] =>
  line('legionnaire', 'player', count, x, { facing });

// --- The ground these fights are measured on ------------------------------

/** Worst height gap between a point in the footprint and a point one melee
 *  reach away from it, over the given set of directions. */
function worstGap(directions: readonly number[]): { gap: number; x: number; z: number } {
  let worst = { gap: 0, x: 0, z: 0 };
  for (let x = FOOTPRINT.minX; x <= FOOTPRINT.maxX + 1e-9; x += 0.1) {
    for (let z = FOOTPRINT.minZ; z <= FOOTPRINT.maxZ + 1e-9; z += 0.1) {
      const here = terrainHeightAt(x, z);
      for (const angle of directions) {
        const gap = Math.abs(here - terrainHeightAt(
          x + Math.cos(angle) * REACH, z + Math.sin(angle) * REACH));
        if (gap > worst.gap) worst = { gap, x, z };
      }
    }
  }
  return worst;
}

describe('the arena is one elevation band', () => {
  it('keeps every pair separated along the axis these lines fight on level', () => {
    // Every margin in this file is meant to be a facing effect, and
    // `highGroundBonus` 1.25 is the same order as `flankBonus` 1.35, so a slope
    // inside the footprint would be indistinguishable from the thing under
    // test. B-007 is the reminder that terrain asymmetry hid inside a
    // "mirrored" fight once already.
    //
    // This used to assert the strongest possible form — that no two points
    // within melee reach anywhere in the footprint are in different bands, in
    // any direction — and that is no longer true. Raising relief by 1.35x to
    // give melee access to high ground at all (B-009) necessarily raised it
    // here too, because the footprint contains very nearly the steepest ground
    // on the board at this scale: 0.4724 of the global 0.4783 before the
    // change. There is no amplitude that gives a Legionnaire a hill somewhere
    // and denies it one here.
    //
    // So the property asserted is the one the scenarios actually use. These are
    // ranked lines that meet along x, so the gaps that can land between an
    // attacker and its target are the gaps along x.
    const alongX = worstGap([0]);
    expect(alongX.gap).toBeLessThan(HIGH_GROUND_THRESHOLD);
    expect(alongX.gap).toBeCloseTo(0.5898, 3);   // 98.3% of the threshold — thin
  });

  it('says where the ground can cross the threshold, and how far that is from any fight', () => {
    // The honest remainder. Sweeping every direction rather than only x finds
    // 0.6377 — over the 0.600 threshold — at (-10.2, 0.2), on a diagonal.
    // Nothing in this file ever fights there: the deepest any placement reaches
    // is x = -9, and at that separation the two sides are 9 apart, five times
    // melee reach, so no pair is ever *in contact* on that ground. That is an
    // argument, not a proof, which is why every reading below carries `uphill`
    // and every scenario asserts it is zero. Those assertions are the real
    // guard; this test exists so the margin is written down rather than assumed.
    const directions = Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2);
    const omni = worstGap(directions);
    expect(omni.gap).toBeCloseTo(0.6377, 3);
    expect(omni.x).toBeCloseTo(-10.2, 6);
    expect(Math.hypot(omni.x, omni.z)).toBeGreaterThan(REACH * 5);
  });

  it('resolves not one attack across an elevation band, across every scenario shape', () => {
    // The aggregate of what the individual readings assert one at a time: run
    // the four shapes this file uses — contact, approach, hammer, split — and
    // require that no attacker in any of them was ever in a different elevation
    // band from its target.
    const twelve = defenders(12, 0, WEST);
    const shapes = [
      [...attackers(10, -CONTACT / 2, EAST), ...defenders(10, CONTACT / 2, EAST)],
      [...attackers(10, 4, WEST), ...defenders(10, 0, WEST)],
      [...attackers(6, -CONTACT, EAST), ...attackers(6, 6, WEST), ...twelve],
      [...attackers(6, -8, EAST), ...attackers(6, 8, WEST), ...twelve],
    ];
    for (const shape of shapes) expect(fight(shape).uphill).toBe(0);
  });
});

// --- How long a facing advantage lasts ------------------------------------

describe('a defender comes about at a bounded rate', () => {
  it('costs a standing defender three and a half attack cycles to reverse', () => {
    // The mechanic B-011 changed, isolated: two models already in contact, the
    // defender facing entirely the wrong way, neither of them moving. This is
    // the case `refaceRate` governs — `turnRate` never runs here — and it is
    // where the whole shortfall lived, because at the travel rate the defender
    // was square-on before the attacker's second blow landed.
    const world = arena([
      ...attackers(1, -CONTACT / 2, EAST),
      ...defenders(1, CONTACT / 2, EAST),
    ]);
    const defender = unitsOf(world, 'rival')[0];
    const attacker = unitsOf(world, 'player')[0];
    if (!defender || !attacker) throw new Error('the pair did not spawn');

    const struck: Array<[number, Approach]> = [];
    let lastRear = -1;
    let lastSide = -1;
    let reversed = -1;
    for (let tick = 1; tick <= 120 && world.units.length === 2; tick++) {
      const arc = approachFrom(attacker, defender);
      fightOut(world, 1);
      // `stepCombat` resets the cooldown to its full value on exactly the tick
      // a unit strikes, and nothing else writes it, so this is unambiguous.
      if (attacker.attackCd === UNIT_TYPES.legionnaire.combat.attackTicks) {
        struck.push([tick, arc]);
      }
      const seen = approachFrom(attacker, defender);
      if (seen === 'rear') lastRear = tick;
      if (seen === 'side') lastSide = tick;
      if (reversed < 0 && defender.facing === WEST) reversed = tick;
    }

    // Neither unit moves, so both windows are pure arc over `refaceRate`. They
    // are asserted against the derivation as well as against the measurement,
    // so retuning the rate has to be acknowledged in both places.
    expect(lastRear).toBe(REAR_WINDOW);
    expect(lastRear).toBe(29);
    expect(lastSide).toBe(REAR_WINDOW + SIDE_WINDOW);
    expect(lastSide).toBe(57);
    expect(reversed).toBe(87);   // 2.9s, against 30 ticks at the travel rate

    // The point of all of it: the attacker's cooldown is 24, so the rear window
    // now contains two of its blows and the side window a third. Under one
    // shared turn rate it contained exactly one, and that is what made a flank
    // worth 1.8% of a health pool.
    expect(struck.slice(0, 4)).toEqual([
      [1, 'rear'], [25, 'rear'], [49, 'side'], [73, 'front'],
    ]);
    expect(struck.filter(([, arc]) => arc === 'rear')).toHaveLength(2);
  });

  it('takes a full second to reverse while walking, and finishes before the attacker is in reach', () => {
    // One attacker walking at one defender that is looking the other way, from
    // the far edge of acquire range. This is the mechanic every scenario below
    // is built on, isolated: how many ticks of rear arc a march can buy, and
    // whether any of them land inside weapon reach.
    const world = arena([
      ...attackers(1, 9, WEST),
      ...defenders(1, 0, WEST),
    ]);
    const defender = unitsOf(world, 'rival')[0];
    const attacker = unitsOf(world, 'player')[0];
    if (!defender || !attacker) throw new Error('the pair did not spawn');

    expect(defender.facing).toBe(WEST);

    // Nothing on tick one: `stepFacing` runs before `stepCombat`, so a defender
    // standing still has not yet acquired anything to turn toward.
    fightOut(world, 1);
    expect(defender.facing).toBe(WEST);

    let firstSide = -1;
    let firstFront = -1;
    let reversed = -1;
    let contact = -1;
    let gapAtFront = 0;
    for (let tick = 2; tick <= 60; tick++) {
      fightOut(world, 1);
      const seen = approachFrom(attacker, defender);
      const gap = Math.hypot(attacker.x - defender.x, attacker.z - defender.z);
      if (firstSide < 0 && seen === 'side') firstSide = tick;
      if (firstFront < 0 && seen === 'front') { firstFront = tick; gapAtFront = gap; }
      if (reversed < 0 && defender.facing === EAST) reversed = tick;
      if (contact < 0 && gap <= REACH) contact = tick;
    }

    // The defender pursues, so this is the *travel* rate for as long as it is
    // walking — which is deliberate and is the half of B-011 that did not
    // change. An order is obeyed on the tick it lands, and a unit closing on an
    // enemy is by definition looking where it is going.
    expect(defender.facing).toBe(EAST);
    expect(firstSide).toBe(Math.ceil(COMBAT.rearArc / TURN) + 1);
    expect(firstFront).toBe(Math.ceil((Math.PI - COMBAT.frontArc) / TURN) + 1);
    expect(firstSide).toBe(11);
    expect(firstFront).toBe(21);

    // Squaring up completely takes 35 ticks rather than the 30 the travel rate
    // alone would give, because the last stretch is spent in contact and
    // standing still, where `refaceRate` governs. The split shows up here as a
    // five-tick tail and nowhere else in this scenario.
    expect(reversed).toBe(35);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured, and unchanged by
    // B-011. Twenty ticks of exposed arc sounds like a lot and is worth nothing
    // here, because all of it is spent out of reach: the defender is square-on
    // at tick 21 with 3.40 still between them — 1.95 melee reaches — and
    // contact is not until tick 27, six ticks later. A lone unit marching round
    // the back of a lone mobile enemy from acquire range lands no rear attack
    // at all. The window is real but it opens too early, and only a force that
    // begins its approach inside about five units gets any of it into weapon
    // range (measured below). The mechanic at fault is that a defender *walking
    // toward* an attacker turns faster than the attacker closes, and slowing
    // the re-facing rate cannot touch it — the defender here is not re-facing,
    // it is travelling.
    expect(gapAtFront).toBeCloseTo(3.4, 1);
    expect(gapAtFront).toBeGreaterThan(REACH * 1.9);
    expect(contact).toBe(27);
    expect(contact).toBeGreaterThan(firstFront);
  });
});

// --- What facing is worth at the moment of contact -------------------------

/** Two identical ten-model lines already in contact. The player always faces
 *  its enemy; only the defender's facing changes between runs. Nothing else in
 *  the world differs — same models, same positions, same ground. */
function facingFight(rivalFacing: number): Reading {
  return fight([
    ...attackers(10, -CONTACT / 2, EAST),
    ...defenders(10, CONTACT / 2, rivalFacing),
  ]);
}

describe('flanking at the moment of contact', () => {
  it('turns a dead heat into a clean sweep when the defender is facing away', () => {
    const head = facingFight(WEST);
    const back = facingFight(EAST);

    // The control is a true 180-degree rotation of the board, and terrain is
    // even under that rotation since B-007, so it must resolve as a dead heat.
    // If this ever comes out lopsided the suite is measuring array order again.
    expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(margin(head.outcome)).toBe(0);
    expect(head.arc.rear).toBe(0);
    expect(head.peakLead).toBe(0);

    // The defender starts with its back turned and buys 29 unit-ticks of rear
    // arc per model, then 28 of side, then it is square-on. 29 ticks spans two
    // 24-tick attack cycles, so each attacker lands two boosted blows before
    // the rear arc shuts and a third at the side multiplier after it.
    expect(back.arc.rear).toBe(10 * REAR_WINDOW);
    expect(back.arc.side).toBe(10 * SIDE_WINDOW);
    expect(back.arc.rear).toBe(290);
    expect(back.arc.side).toBe(280);
    expect(back.uphill).toBe(0);

    // THE CLAIM, MET. Identical models, identical ground, identical positions;
    // the defending line is looking the wrong way and is wiped out without
    // losing the attackers a single model, twenty-four ticks — one attack
    // cycle — sooner than the head-on fight takes to annihilate both sides.
    //
    // Before B-011 this same pair of runs was 0–0 on tick 456 *both ways*: a
    // 30-tick about-face against a 24-tick cooldown gave the attacker exactly
    // one boosted volley, worth 21.94 HP against a 1,200 HP pool. The margin is
    // still not large in absolute terms — the survivors finish on 4.9 HP each —
    // but §2 asks flanking to be important to fight *outcomes*, and the outcome
    // is now the thing that moves.
    expect(back.outcome.winner).toBe('player');
    expect(back.outcome.survivors).toEqual({ player: 10, rival: 0 });
    expect(back.outcome.hp.player).toBeCloseTo(49.152, 3);
    expect(back.peakLead).toBeCloseTo(61.198, 2);
    expect(head.outcome.ticks - back.outcome.ticks)
      .toBe(UNIT_TYPES.legionnaire.combat.attackTicks);
    expect(back.outcome.ticks).toBe(432);
    expect(head.outcome.ticks).toBe(456);
  });

  it('separates front, side and rear by how many volleys each arc contains', () => {
    const head = facingFight(WEST);
    const flank = facingFight(NORTH);
    const back = facingFight(EAST);

    // Side-on, the defender is already half way round, so its remaining turn is
    // the side arc alone and the window is roughly half the rear one.
    expect(flank.arc.side).toBe(150);
    expect(flank.arc.rear).toBe(0);
    expect(back.arc.rear).toBe(290);
    expect(head.arc.side + head.arc.rear).toBe(0);

    // What the three are worth, read as the peak health lead rather than the
    // final one, because two of the three still annihilate. The old suite could
    // assert that rear/side came out at exactly (1.35-1)/(1.15-1) — that exact
    // proportionality *was* the defect, the signature of one volley each and
    // nothing else. It no longer holds, because the arcs no longer contain the
    // same number of blows: two rear plus one side against one side.
    expect(head.peakLead).toBe(0);
    expect(flank.peakLead).toBeCloseTo(9.404, 2);
    expect(back.peakLead).toBeCloseTo(61.198, 2);
    expect(back.peakLead / flank.peakLead)
      .toBeGreaterThan((COMBAT.flankBonus - 1) / (COMBAT.sideBonus - 1) * 2);

    // Only the rear approach converts. A side window of 15 ticks holds one
    // volley, which is worth 9.40 HP and changes nothing — so the fight the
    // flank wins is genuinely the flank, not merely "any arc but the front".
    expect(head.outcome.ticks).toBe(456);
    expect(flank.outcome.ticks).toBe(456);
    expect(flank.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(back.outcome.survivors).toEqual({ player: 10, rival: 0 });
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

    // Two degrees of facing buys or forfeits a whole volley: nothing on one
    // side of the line, a full side bonus on the other, off a single tick of
    // contact before the defender rotates into the front arc anyway. The edge
    // being a step and not a ramp is what makes the arc worth drawing on
    // screen — a soft falloff would be unreadable and unactionable.
    expect(justInside.arc.side).toBe(0);
    expect(justInside.peakLead).toBe(0);
    expect(justOutside.arc.side).toBe(10);
    expect(justOutside.peakLead).toBeCloseTo(9.404, 2);

    // ...and again at the rear boundary. One tick of rear arc plus the side
    // window behind it is 31.35 HP against the 18.81 that two side volleys buy.
    expect(stillSide.arc.side).toBe(280);
    expect(stillSide.peakLead).toBeCloseTo(18.808, 2);
    expect(justRear.arc.rear).toBe(10);
    expect(justRear.peakLead).toBeCloseTo(31.347, 2);

    // THE CLAIM, MET, and this is the sharpest form of it available. The edge
    // used to be sharp in *price* and invisible in *result* — all four runs
    // annihilated on tick 456, and a step worth 9.40 HP is not a step a player
    // would ever notice. Two degrees of facing across the rear boundary now
    // separates a dead heat from an 8–0 win a full attack cycle sooner.
    for (const reading of [justInside, justOutside, stillSide]) {
      expect(reading.outcome.survivors).toEqual({ player: 0, rival: 0 });
      expect(reading.outcome.ticks).toBe(456);
      expect(reading.uphill).toBe(0);
    }
    expect(justRear.outcome.survivors).toEqual({ player: 8, rival: 0 });
    expect(justRear.outcome.ticks).toBe(432);
    expect(justRear.outcome.hp.player).toBeCloseTo(23.154, 3);
    expect(justRear.uphill).toBe(0);
  });
});

// --- Marching round the back of an enemy nobody is holding -----------------

describe('approach angle against an unengaged, mobile enemy', () => {
  it('buys a rear window that closes as the approach lengthens', () => {
    // The scenario a player would call flanking, and the one this whole change
    // exists for: ten models march into a defending line of ten, either head-on
    // or all the way around behind it. Identical forces, identical distance,
    // opposite sides. The defenders are free to acquire, pursue and turn, which
    // is what makes this the hard case — nobody is holding their attention.
    //
    // Against instant facing this was worth *exactly* zero at every separation:
    // same tick count, same survivors, same health, not one unit-tick of rear
    // arc. It now buys a measured, distance-dependent window.
    const rear: number[] = [];
    const side: number[] = [];
    const bought: number[] = [];
    for (const d of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const head = fight([...attackers(10, -d, EAST), ...defenders(10, 0, WEST)]);
      const behind = fight([...attackers(10, d, WEST), ...defenders(10, 0, WEST)]);
      expect(head.arc.side + head.arc.rear).toBe(0); // the control never leaves the front arc
      expect(head.peakLead).toBe(0);
      expect(behind.uphill).toBe(0);
      rear.push(behind.arc.rear);
      side.push(behind.arc.side);
      bought.push(Number(behind.peakLead.toFixed(3)));
    }

    // Both sides close, so the defender spends the march turning as it walks —
    // at the *travel* rate, which B-011 deliberately left fast — and has burned
    // most of its about-face by the time anyone is in reach. What the slower
    // re-facing rate adds is the ticks after contact, when both sides have
    // stopped: the rear window nearly triples, from 90 unit-ticks to 260 at a
    // separation of 2. Rear contact still survives only inside 5 and side
    // contact only inside 8, and past that the long way round is once again
    // worth literally nothing.
    expect(rear).toEqual([260, 140, 20, 0, 0, 0, 0, 0]);
    expect(side).toEqual([280, 290, 290, 220, 100, 10, 0, 0]);
    expect(bought).toEqual([62.092, 31.347, 31.347, 9.404, 9.404, 9.404, 0, 0]);
  });

  it('converts that window at ten a side, inside the distance the window survives', () => {
    // THE CLAIM, MET, and this is the scenario a player would actually call
    // flanking: ten models against ten, nobody pinning anyone, the only
    // difference between the two runs being which side of the enemy line the
    // attack arrives on.
    //
    // Under instant facing this was worth *exactly* zero — byte-identical
    // outcomes. Under a single bounded turn rate it was worth a permanent 21.94
    // HP lead that never crossed a 120-HP kill threshold, so the two runs still
    // ended as the same object. It now wins the fight outright with eight of ten
    // models standing, a full attack cycle sooner.
    for (const d of [2, 3, 4]) {
      const head = fight([...attackers(10, -d, EAST), ...defenders(10, 0, WEST)]);
      const behind = fight([...attackers(10, d, WEST), ...defenders(10, 0, WEST)]);
      expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
      expect(behind.outcome.winner).toBe('player');
      expect(behind.outcome.survivors).toEqual({ player: 8, rival: 0 });
      expect(head.outcome.ticks - behind.outcome.ticks).toBe(24);
      expect(behind.uphill).toBe(0);
    }

    // THE HONEST LIMIT, unchanged by B-011 and worth keeping in view. Past a
    // separation of 4 the two runs are once again the same object at every
    // distance out to acquire range, because a defender that is *walking* turns
    // at the travel rate and has squared up long before contact. A flank must
    // still be launched from inside about five units — which is to say from a
    // distance at which the enemy can already see it coming. The mechanic at
    // fault is not the price of a flank any more, it is how long the approach
    // takes relative to how fast a mobile enemy comes about.
    for (const d of [5, 6, 8]) {
      const head = fight([...attackers(10, -d, EAST), ...defenders(10, 0, WEST)]);
      const behind = fight([...attackers(10, d, WEST), ...defenders(10, 0, WEST)]);
      expect(behind.outcome).toEqual(head.outcome);
      expect(margin(behind.outcome)).toBe(0);
    }
  });

  it('reverses the result at three a side too, and by more than one model', () => {
    // Three a side was the scale at which a single boosted volley used to cross
    // a kill threshold instead of being absorbed — the only scale at which the
    // old build could show a reversal at all. It still reverses, and now by two
    // models rather than one at close range.
    for (const d of [2, 3, 4]) {
      const head = fight([...attackers(3, -d, EAST), ...defenders(3, 0, WEST)]);
      const behind = fight([...attackers(3, d, WEST), ...defenders(3, 0, WEST)]);

      expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
      expect(head.outcome.winner).toBeNull();
      expect(behind.outcome.winner).toBe('player');
      expect(behind.uphill).toBe(0);
    }

    // At 2 the rear window holds two volleys and the tactic is worth two models
    // and two whole attack cycles; at 3 and 4 it holds one and is worth one.
    const near = fight([...attackers(3, 2, WEST), ...defenders(3, 0, WEST)]);
    expect(near.outcome.survivors).toEqual({ player: 2, rival: 0 });
    expect(near.outcome.hp.player).toBeCloseTo(21.057, 3);
    expect(fight([...attackers(3, -2, EAST), ...defenders(3, 0, WEST)]).outcome.ticks
      - near.outcome.ticks).toBe(48);

    const far = fight([...attackers(3, 4, WEST), ...defenders(3, 0, WEST)]);
    expect(far.outcome.survivors).toEqual({ player: 1, rival: 0 });
    expect(far.outcome.hp.player).toBeCloseTo(1.902, 2);

    // The far edge of it, and the honest limit of the tactic. At 5 the defenders
    // have finished coming about before contact, the rear window is empty and
    // the reversal is gone — a side window worth 2.94 HP is all that survives.
    const head5 = fight([...attackers(3, -5, EAST), ...defenders(3, 0, WEST)]);
    const behind5 = fight([...attackers(3, 5, WEST), ...defenders(3, 0, WEST)]);
    expect(behind5.arc.rear).toBe(0);
    expect(behind5.peakLead).toBeCloseTo(2.94, 2);
    expect(behind5.outcome).toEqual(head5.outcome);
  });
});

// --- Is it worth splitting a force to get behind someone? -----------------

/** Twelve defenders holding a line, faced the way an attack is coming from. */
const holdingLine = (): Placement[] => defenders(12, 0, WEST);
/** Six models already locked in melee with that line — the anvil. */
const anvil = (): Placement[] => attackers(6, -CONTACT, EAST);

/** Average shield-wall neighbours a team has formed once the lines have met.
 *  The confound the hammer has to be read against: a wing that reinforces from
 *  the front thickens an existing wall, and a wing arriving behind cannot. */
function wallAfter(placements: readonly Placement[], ticks: number, team: 'player' | 'rival'): number {
  const world = arena(placements);
  fightOut(world, ticks);
  const own = unitsOf(world, team);
  return own.reduce((sum, u) => sum + shieldWallStacks(world, u), 0) / own.length;
}

describe('splitting a force to take the enemy from behind', () => {
  it('rewards the wing that arrives behind rather than in front', () => {
    // The control that matters. Both runs field twelve models, six of them
    // already in contact and six marching in from exactly `d` away. The only
    // difference is which side the second wing comes from — so anything the
    // hammer gains cannot be the extra numbers, the staggered arrival, or the
    // march time, all of which are held equal.
    //
    // This is the one place the old readings were *propped up* by the defect
    // rather than inflated by it: facings used to freeze the moment a unit
    // stopped moving, so a pinned defender could not turn to meet the hammer at
    // all. It now can, and the hammer's rear-arc time falls by about 12% (876
    // unit-ticks at d = 4, against over 1000 before) — but the anvil holds the
    // line's attention well enough that the arc never actually shuts.
    for (const d of [4, 6, 8]) {
      const hammer = fight([...anvil(), ...attackers(6, d, WEST), ...holdingLine()]);
      const column = fight([...anvil(), ...attackers(6, -d, EAST), ...holdingLine()]);

      expect(hammer.uphill).toBe(0);
      expect(column.uphill).toBe(0);
      expect(column.arc.rear).toBe(0); // reinforcing from the front earns nothing
      expect(hammer.arc.rear).toBeGreaterThan(750);
      expect(hammer.lead).toBeGreaterThan(column.lead);
    }

    // The size of it, at d = 6: arriving behind wins the fight outright, and
    // arriving in front loses it. Same twelve models, same second wave, same
    // distance walked.
    const hammer6 = fight([...anvil(), ...attackers(6, 6, WEST), ...holdingLine()]);
    const column6 = fight([...anvil(), ...attackers(6, -6, EAST), ...holdingLine()]);
    expect(hammer6.outcome.winner).toBe('player');
    expect(column6.outcome.winner).toBe('rival');
    expect(hammer6.lead).toBeCloseTo(192.4, 0);
    expect(column6.lead).toBeCloseTo(-137.9, 0);
  });

  it('loses to reinforcing from the front once the hammer is close enough to form a wall', () => {
    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured, and it is a *new*
    // near edge — the old suite found only a far one. Bring the hammer in to 2
    // and the manoeuvre inverts: going round the back loses with four rivals
    // standing, while walking the same six models into the back of the anvil
    // wins with eight of twelve alive and a 371.6 HP lead.
    //
    // It is not a facing effect. A wing arriving from the front halts one rank
    // behind the anvil, inside `shieldWallRadius`, and thickens the wall —
    // measured 120 ticks in, 4.33 wall-mates per model against the hammer's
    // 1.60, which is 0.19 more defense on every model of the block. A 1.35 rear
    // multiplier does not repay splitting a phalanx in half. So the flank pays
    // in a band and not below it, and the near edge of that band is set by a
    // mechanic with nothing to do with flanking.
    const hammer2 = fight([...anvil(), ...attackers(6, 2, WEST), ...holdingLine()]);
    const column2 = fight([...anvil(), ...attackers(6, -2, EAST), ...holdingLine()]);

    expect(hammer2.outcome.winner).toBe('rival');
    expect(hammer2.outcome.survivors).toEqual({ player: 0, rival: 4 });
    expect(column2.outcome.winner).toBe('player');
    expect(column2.outcome.survivors).toEqual({ player: 8, rival: 0 });
    expect(column2.lead).toBeCloseTo(371.6, 0);
    expect(column2.lead).toBeGreaterThan(hammer2.lead);

    expect(wallAfter([...anvil(), ...attackers(6, 2, WEST), ...holdingLine()], 120, 'player'))
      .toBeCloseTo(1.6, 2);
    expect(wallAfter([...anvil(), ...attackers(6, -2, EAST), ...holdingLine()], 120, 'player'))
      .toBeCloseTo(4.333, 2);
  });

  it('beats the same force attacking in one block, while the hammer is in the band', () => {
    // The block is the honest comparison: twelve models all in contact at once,
    // no march, no stagger. It is a dead heat, because nobody is behind anybody.
    const block = fight([...attackers(12, -CONTACT, EAST), ...holdingLine()]);
    expect(block.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(block.lead).toBe(0);

    // Split into anvil and hammer, the same twelve models win outright.
    const near = fight([...anvil(), ...attackers(6, 4, WEST), ...holdingLine()]);
    expect(near.outcome.survivors).toEqual({ player: 8, rival: 0 });
    expect(near.lead).toBeCloseTo(236.3, 0);

    const mid = fight([...anvil(), ...attackers(6, 6, WEST), ...holdingLine()]);
    expect(mid.outcome.winner).toBe('player');
    expect(mid.lead).toBeCloseTo(192.4, 0);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured. Push the hammer out
    // to 8 and the same manoeuvre loses a fight the block at least drew: the
    // rival finishes with 4 models and 232.3 HP standing. The anvil is six
    // against twelve for the ticks the hammer needs to march in, and 1.35x on
    // the back half of the fight does not repay being beaten in detail on the
    // front half. Bounded turning did not move this edge — it sat between 6 and
    // 8 before and it still does, because what fails here is the anvil's staying
    // power and not the arc. A flank must still be launched from inside acquire
    // range (9.0), which is to say from a distance at which the enemy can
    // already see it coming. Nothing in the design says so.
    const far = fight([...anvil(), ...attackers(6, 8, WEST), ...holdingLine()]);
    expect(far.outcome.winner).toBe('rival');
    expect(far.outcome.survivors).toEqual({ player: 0, rival: 4 });
    expect(far.lead).toBeCloseTo(-232.3, 0);
    expect(far.lead).toBeLessThan(block.lead);
  });
});

// --- Where the claim still does not hold ----------------------------------

describe('what the flank bonus still cannot be earned by', () => {
  it('makes an unpinned split a coin flip rather than a tactic', () => {
    // Both wings marching in from opposite sides with nobody holding the
    // enemy's attention. FALLS SHORT OF THE DESIGN CLAIM, recorded as measured,
    // and bounded turning did not rescue it: across five separations the split
    // still wins twice and loses three times, on exactly the separations it did
    // before, while the same twelve models in one block draw every time.
    //
    // What changed is only the explanation. The wings now *do* earn rear arc —
    // between 578 and 847 unit-ticks of it, where before they earned none — and
    // it makes no difference, because the defenders turn to face whichever wing
    // is nearest and the wings are beaten one at a time. The outcome still
    // tracks the accident of which wing arrives first rather than the plan, so
    // what an unpinned split lacks is not the bonus but a reason for the enemy
    // to keep looking the other way.
    const results = [3, 4, 5, 6, 8].map(d => {
      const block = fight([...attackers(12, -d, EAST), ...holdingLine()]);
      const split = fight([
        ...attackers(6, -d, EAST), ...attackers(6, d, WEST), ...holdingLine(),
      ]);
      return { d, block: block.lead, split: split.lead, rear: split.arc.rear };
    });

    expect(results.every(r => r.block === 0)).toBe(true);
    expect(results.every(r => r.rear > 500)).toBe(true);
    expect(results.filter(r => r.split > 0).map(r => r.d)).toEqual([4, 5]);
    expect(results.filter(r => r.split < 0).map(r => r.d)).toEqual([3, 6, 8]);
  });
});
