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
 * **Re-measured against bounded turning.** Facing used to be rewritten
 * instantly and unboundedly by `stepMovement`, and every reading in this file
 * was taken against that. It is now `stepFacing` at `UNIT_TYPES[t].turnRate`,
 * and a unit that has stopped moving keeps turning toward what it is fighting.
 * Both halves of that change move numbers here, in opposite directions.
 *
 * **What a flank is now worth.** A facing advantage is a *window*, not a state.
 * A Legionnaire reverses in 30 ticks — one second — and its attack cooldown is
 * 24, so a force that opens fire into an enemy's back lands exactly one boosted
 * volley before the arc closes. Measured at ten a side in contact: 21.94 HP of
 * health lead from the rear, 9.40 from the side, 0 from the front, and the
 * ratio between the two reproduces the ratio of the two bonuses to four figures
 * because each is one volley and nothing else.
 *
 * **What that costs the design claim.** 21.94 HP is 1.8% of a ten-model health
 * pool, and it no longer decides anything at contact: the 10v10 that used to go
 * 10–0 against a defender facing the wrong way is now mutual annihilation on
 * the same tick as the head-on fight, and so is every arc between them. Facing
 * at the moment of contact has gone from deciding the fight to costing one
 * volley. That shortfall is recorded in place, with the numbers, below.
 *
 * **What it buys back, and this is the reason for the change.** Approach angle
 * against an unengaged, mobile enemy used to be worth *exactly* zero —
 * byte-identical outcomes marching head-on and marching all the way round the
 * back, at every separation. It is now worth something real: rear-arc contact
 * out to a separation of 4, side-arc contact out to 7, a lead that persists to
 * the end of the fight, and at three a side an outright reversal — mutual
 * annihilation head-on against a 1–0 win from behind, twenty-four ticks
 * quicker. At ten a side the same manoeuvre still fails to convert; both ends
 * of that are measured below.
 *
 * Hammer-and-anvil survives, but its old result leaned on facings freezing on
 * contact and the numbers have moved: it now pays inside a *band* of hammer
 * distances, roughly 4 to 6, and the near edge of that band is not a facing
 * effect at all — it is the shield wall, which a wing reinforcing from the
 * front stacks into and a wing arriving behind cannot.
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

/** Radians of combat facing a Legionnaire buys per tick. Every window measured
 *  in this file is some arc divided by this. */
const TURN = UNIT_TYPES.legionnaire.turnRate;

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

// --- How long a facing advantage lasts ------------------------------------

describe('a defender comes about at a bounded rate', () => {
  it('takes a full second to reverse, and finishes before the attacker is in reach', () => {
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

    // A full about-face is now a measurable, bounded cost rather than free.
    expect(defender.facing).toBe(EAST);
    expect(reversed).toBe(30); // ceil(pi / 0.110) = 29 ticks of turning, begun on tick 2

    // The arcs the attacker passes through on the way in: the rear holds for
    // ten ticks and the side for ten more, which is what a 1.05 rad arc costs
    // at 0.110 rad/tick. Asserted both ways round so a change to either the
    // arcs or the rate has to be acknowledged here.
    expect(firstSide).toBe(Math.ceil(COMBAT.rearArc / TURN) + 1);
    expect(firstFront).toBe(Math.ceil((Math.PI - COMBAT.frontArc) / TURN) + 1);
    expect(firstSide).toBe(11);
    expect(firstFront).toBe(21);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured. Twenty ticks of
    // exposed arc sounds like a lot and is worth nothing here, because all of
    // it is spent out of reach: the defender is square-on at tick 21 with 3.40
    // still between them — 1.95 melee reaches — and contact is not until tick
    // 27, six ticks later. A lone unit marching round the back of a lone mobile
    // enemy from acquire range lands no rear attack at all. The window is real
    // but it opens too early, and only a force that begins its approach inside
    // about four units gets any of it into weapon range (measured below). The
    // mechanic at fault is that a defender turns faster than an attacker closes.
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
  it('prices a facing advantage at one volley rather than at the fight', () => {
    const head = facingFight(WEST);
    const back = facingFight(EAST);

    // The control is a true 180-degree rotation of the board, and terrain is
    // even under that rotation since B-007, so it must resolve as a dead heat.
    // If this ever comes out lopsided the suite is measuring array order again.
    expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(margin(head.outcome)).toBe(0);
    expect(head.arc.rear).toBe(0);
    expect(head.peakLead).toBe(0);

    // The defender starts with its back turned and buys ten unit-ticks of rear
    // arc per model, then ten of side, then it is square-on. Ten ticks is less
    // than one 24-tick attack cycle, so every attacker lands exactly one
    // boosted blow and the arc has shut before the next one comes round.
    expect(back.arc.rear).toBe(100);
    expect(back.arc.side).toBe(100);
    expect(back.uphill).toBe(0);
    expect(back.peakLead).toBeCloseTo(21.943, 2);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured, and it is a
    // regression rather than a shortfall inherited from before: against instant
    // facing this same pair of runs was a dead heat against 10–0 in 336 ticks.
    // The boosted volley is now worth 21.94 HP — 1.8% of the defender's
    // 1200-HP pool — and the fight ends the same way on the same tick whichever
    // way the defender was looking. §2 wants flanking "extremely important to
    // fight outcomes"; at contact it is worth one attack in nineteen. The
    // mechanic at fault is the ratio between `turnRate` and `attackTicks`, and
    // setting it is the lead's call, not this suite's.
    expect(back.outcome.survivors).toEqual({ player: 0, rival: 0 });
    expect(back.outcome.ticks).toBe(head.outcome.ticks);
    expect(back.outcome.ticks).toBe(456);
    expect(back.lead).toBe(0);
  });

  it('separates front, side and rear in exact proportion to their multipliers', () => {
    const head = facingFight(WEST);
    const flank = facingFight(NORTH);
    const back = facingFight(EAST);

    // The three are still cleanly distinguishable in the arcs the attackers
    // stand in, and the side window is half the rear one because it is half the
    // angle the defender has left to turn through.
    expect(flank.arc.side).toBe(50);
    expect(flank.arc.rear).toBe(0);
    expect(back.arc.rear).toBe(100);
    expect(head.arc.side + head.arc.rear).toBe(0);

    // Survivor count cannot tell them apart any more — all three annihilate on
    // tick 456 — so the separation has to be read in the health lead the opening
    // volley buys. That it comes out *exactly* proportional to the excess
    // multipliers is the signature of the one-volley mechanism: same models,
    // same targets, one attack each, differing only by 0.35 against 0.15.
    expect(head.peakLead).toBe(0);
    expect(flank.peakLead).toBeCloseTo(9.404, 2);
    expect(back.peakLead).toBeCloseTo(21.943, 2);
    expect(back.peakLead / flank.peakLead)
      .toBeCloseTo((COMBAT.flankBonus - 1) / (COMBAT.sideBonus - 1), 3);
    expect(head.outcome.ticks).toBe(456);
    expect(flank.outcome.ticks).toBe(456);
    expect(back.outcome.ticks).toBe(456);
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

    // Two degrees of facing still buys or forfeits a whole volley: nothing on
    // one side of the line, a full side bonus on the other, off a single tick of
    // contact before the defender rotates into the front arc anyway. The edge
    // being a step and not a ramp is what would make the arc worth drawing on
    // screen — a soft falloff would be unreadable and unactionable.
    expect(justInside.arc.side).toBe(0);
    expect(justInside.peakLead).toBe(0);
    expect(justOutside.arc.side).toBe(10);
    expect(justOutside.peakLead).toBeCloseTo(9.404, 2);

    // ...and the same again at the rear boundary, where one tick of rear arc is
    // worth 2.33x what one tick of side arc is worth.
    expect(stillSide.peakLead).toBeCloseTo(9.404, 2);
    expect(justRear.arc.rear).toBe(10);
    expect(justRear.peakLead).toBeCloseTo(21.943, 2);

    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured. The edge is sharp
    // in *price* and invisible in *result*: all four runs are 0–0 on tick 456.
    // Under instant facing the same two degrees separated losing every model
    // from losing none. A step worth 9.40 HP is not a step a player will ever
    // notice, so the arc is currently legible to this test and to nobody else.
    for (const reading of [justInside, justOutside, stillSide, justRear]) {
      expect(reading.outcome.survivors).toEqual({ player: 0, rival: 0 });
      expect(reading.outcome.ticks).toBe(456);
      expect(reading.uphill).toBe(0);
    }
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

    // Both sides close, so the defender spends the march turning as it walks and
    // has burned most of its 30-tick about-face by the time anyone is in reach.
    // Rear contact survives only inside 5, side contact only inside 8, and past
    // that the long way round is once again worth literally nothing.
    expect(rear).toEqual([90, 50, 10, 0, 0, 0, 0, 0]);
    expect(side).toEqual([100, 100, 100, 80, 40, 10, 0, 0]);
    expect(bought).toEqual([21.943, 21.943, 21.943, 9.404, 9.404, 9.404, 0, 0]);
  });

  it('still cannot convert that window at ten a side', () => {
    // FALLS SHORT OF THE DESIGN CLAIM, recorded as measured. The window is real
    // and the lead it buys is permanent — still 21.94 HP at tick 400 — but
    // 21.94 out of 1200 never crosses a 120-HP kill threshold, so the two runs
    // end as the same object: same tick, same survivors, same health, at every
    // separation. Marching round the back of ten models is worth a 1.8% health
    // lead and no change of result. The mechanic at fault is the same
    // one-volley cap as at contact.
    for (const d of [2, 4, 6, 8]) {
      const head = fight([...attackers(10, -d, EAST), ...defenders(10, 0, WEST)]);
      const behind = fight([...attackers(10, d, WEST), ...defenders(10, 0, WEST)]);
      expect(behind.outcome).toEqual(head.outcome);
      expect(margin(behind.outcome)).toBe(0);
    }
  });

  it('reverses the result at the scale where one volley is worth a model', () => {
    // Three a side is the scale at which a single boosted volley crosses a kill
    // threshold instead of being absorbed, and it is the proof that approach
    // angle is no longer free of consequence: the *same* three models marching
    // the *same* distance annihilate each other coming from the front and win
    // outright coming from behind.
    for (const d of [2, 3, 4]) {
      const head = fight([...attackers(3, -d, EAST), ...defenders(3, 0, WEST)]);
      const behind = fight([...attackers(3, d, WEST), ...defenders(3, 0, WEST)]);

      expect(head.outcome.survivors).toEqual({ player: 0, rival: 0 });
      expect(head.outcome.winner).toBeNull();
      expect(behind.outcome.winner).toBe('player');
      expect(behind.outcome.survivors).toEqual({ player: 1, rival: 0 });
      expect(behind.outcome.hp.player).toBeCloseTo(1.902, 2);
      expect(behind.uphill).toBe(0);

      // ...and 24 ticks sooner, which is exactly one attack cycle: the fight
      // ends a whole exchange early because it started one blow ahead.
      expect(head.outcome.ticks - behind.outcome.ticks).toBe(24);
    }

    // The far edge of it, and the honest limit of the tactic. At 5 the defenders
    // have finished coming about before contact, the rear window is empty and
    // the reversal is gone — a side window worth 2.94 HP is all that survives.
    const head5 = fight([...attackers(3, -5, EAST), ...defenders(3, 0, WEST)]);
    const behind5 = fight([...attackers(3, 5, WEST), ...defenders(3, 0, WEST)]);
    expect(behind5.arc.rear).toBe(0);
    expect(behind5.arc.side).toBe(24);
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
