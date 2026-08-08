import { describe, expect, it } from 'vitest';
import { arena, fightOut, line, margin, tally, unitsOf } from './harness';
import { cmdHoldPosition, cmdMove } from '../../src/sim/commands';
import { COMBAT } from '../../src/data/tuning';
import { UNIT_TYPES } from '../../src/data/units';
import { approachFrom, elevationMultiplier, flankMultiplier } from '../../src/sim/combat';
import { hash } from '../../src/sim/snapshot';
import { simStep } from '../../src/sim/world';
import type { Approach } from '../../src/sim/combat';
import type { Outcome, Placement } from './harness';
import type { Team, UnitTypeKey, World } from '../../src/core/types';

/**
 * Preparation versus numbers, and the absence of randomness underneath both.
 *
 * §2 claims that "initial positioning determines the outcome more than mid-fight
 * adjustments" and that battles are "quick and decisive"; D-019 claims combat
 * consumes no RNG at all. This file turns all three into scenarios.
 *
 * The mechanic that carries the positioning claim in the Phase 1 roster is the
 * Marksman's `accuracyStationary` (0.95) against its `accuracyMoving` (0.35),
 * ramped over `COMBAT.settleTicks`. A force that has been standing still shoots
 * 2.7x as hard as one still on its feet, and §8.7 says so in words: "accuracy
 * bonus stationary, penalty moving — rewards setup over kiting".
 *
 * **Settle is no longer the only thing these scenarios measure.** Now that
 * `turnRate` bounds how fast a unit comes about, facing is a second and
 * independent axis of preparation: reversing costs a Marksman 26 ticks of
 * turning and a Legionnaire 29, so a force caught pointing the wrong way cannot
 * correct it inside the engagement that punishes it. That turns out to decide
 * both scenarios where preparation used to look worthless — the drifting
 * defence below, which used to be shot in the back by its own drift, and the
 * Legionnaire, which had no way to earn a positional advantage at all.
 *
 * **Three confounds had to be removed before any of this measures setup.** A
 * first attempt used long single-rank lines and lost with a *settled* defence
 * against equal numbers — not because setup is worthless but because a line
 * 10.8 deep in z has its flank units further than `COMBAT.acquireRange` from a
 * converged attacker, so half the defence never fires. So every scenario here
 * uses the same compact block shape for both sides, and:
 *
 * | confound | how it is held still | verified by |
 * |---|---|---|
 * | elevation | both blocks sit near the terrain crest, height spread 0.169 against a 0.6 threshold | `neutral ground` below |
 * | facing | *ranged only.* Both sides spawn looking at each other and no Marksman ever turns more than 0.375 rad off that, so no flank bonus is collected | `neutral ground`, and the swing readings in `not told to hold` |
 * | crowding | every force is <= `COHESION.cap`, so no side is docked for packing | counts capped at 20 |
 * | shape | attackers march to individual slots, arriving in the same block the control uses | `block()` |
 *
 * The melee scenario is the exception and deliberately so: blocks at
 * `MELEE_CONTACT` intermix, both sides end up behind each other, and the flank
 * bonus is then part of what is being measured rather than a confound to
 * suppress. That scenario reports its arcs instead of assuming them away.
 *
 * The attackers get one `cmdMove` each rather than one group order because
 * `cmdMove` fans a group onto a circle of radius up to 2.5 — which would change
 * the attacking formation as well as its settle state, and then the scenario
 * would be measuring two things.
 */

const MARKSMAN = UNIT_TYPES.marksman;
/** How far a Marksman can actually shoot another one: reach plus both radii. */
const REACH = MARKSMAN.combat.range + MARKSMAN.radius * 2;

const FRONTAGE = 5;
const FILE_SPACING = 0.8;
const RANK_STEP = 0.7;
/** Gap between the two front ranks. Chosen well inside REACH so that every unit
 *  of both blocks is in range of every enemy — at max range only the units
 *  nearest the centre engage, which would quietly turn a numbers test into a
 *  frontage test. */
const CONTACT = 4.0;
/** Melee blocks have to stand closer than that or nobody can reach anybody. */
const MELEE_CONTACT = 1.2;
/** Far enough out that the attackers are unambiguously a force arriving, not a
 *  force already there — roughly 125 ticks of walking. */
const MARCH = 20;

/**
 * A force in ranks: `FRONTAGE` abreast, extra units stacked behind.
 *
 * Depth rather than width, deliberately. A bigger force built by widening the
 * line pushes its own flanks out of `acquireRange` and loses for a reason that
 * has nothing to do with preparation; a bigger force built by adding ranks
 * keeps every model in the fight, so "larger" means larger.
 */
function block(
  type: UnitTypeKey, team: Team, count: number, sign: number, contact: number, xOffset = 0,
): Placement[] {
  const facing = sign > 0 ? -Math.PI / 2 : Math.PI / 2;   // looking across the gap
  const out: Placement[] = [];
  let placed = 0;
  let rank = 0;
  while (placed < count) {
    const n = Math.min(FRONTAGE, count - placed);
    const x = sign * (contact / 2 + rank * RANK_STEP) + xOffset;
    out.push(...line(type, team, n, x, { spacing: FILE_SPACING, facing }));
    placed += n;
    rank++;
  }
  return out;
}

/** Both sides already at contact, neither prepared. The numbers-only control. */
function evenStart(
  defenders: number, attackers: number,
  type: UnitTypeKey = 'marksman', contact = CONTACT,
): World {
  return arena([
    ...block(type, 'player', defenders, -1, contact),
    ...block(type, 'rival', attackers, +1, contact),
  ]);
}

/**
 * A prepared defence against a force that walks into it.
 *
 * `hold` is what "in position" means as a player action — it is the one order
 * that guarantees a unit does not give its settle back. `hold: false` is the
 * same defence left on its default idle behaviour, which is the comparison that
 * shows what the order is actually worth.
 */
function setupVsArrival(
  defenders: number, attackers: number, hold: boolean,
  type: UnitTypeKey = 'marksman', contact = CONTACT, seed = 1337,
): World {
  const world = arena([
    ...block(type, 'player', defenders, -1, contact),
    ...block(type, 'rival', attackers, +1, contact, MARCH),
  ], seed);
  if (hold) cmdHoldPosition(world, unitsOf(world, 'player').map(u => u.id));
  const slots = block(type, 'rival', attackers, +1, contact);
  unitsOf(world, 'rival').forEach((u, i) => {
    const slot = slots[i]!;
    cmdMove(world, [u.id], slot.x, slot.z);
  });
  return world;
}

/** Largest attacking force the defence still beats outright. */
function largestForceBeaten(defenders: number, hold: boolean, cap = 20): number {
  let best = 0;
  for (let attackers = defenders; attackers <= cap; attackers++) {
    if (fightOut(setupVsArrival(defenders, attackers, hold)).winner !== 'player') break;
    best = attackers;
  }
  return best;
}

interface FightReading {
  /** Blows landed by each side, counted by the arc they came in from. */
  blows: Record<Team, Record<Approach, number>>;
  /** The furthest any unit of that side ever turned from where it spawned
   *  looking, in radians. Compare against `COMBAT.frontArc` to see whether a
   *  force could have been flanked at all. */
  swing: Record<Team, number>;
}

/**
 * Fight the world out, recording who struck whom from where.
 *
 * Outcomes alone cannot say *why* a defence held, and since facing became
 * bounded that question decides two of the scenarios below. Blows are
 * identified by the cooldown sitting at the full `attackTicks` — `stepCombat`
 * resets it on exactly the tick a unit strikes, and nothing else writes it.
 *
 * A blow whose victim dies on the same tick is not counted: the reaper has
 * already removed the target by the time this reads the world, and there is no
 * arc to attribute it to. That undercounts the final tick of each fight
 * identically for both sides, which is acceptable for a comparison and is why
 * these totals are smaller than the damage actually dealt.
 */
function measureFight(world: World, maxTicks = 5400): FightReading {
  const spawnFacing = new Map(world.units.map(u => [u.id, u.facing]));
  const blows = {
    player: { front: 0, side: 0, rear: 0 },
    rival: { front: 0, side: 0, rear: 0 },
  } as Record<Team, Record<Approach, number>>;
  const swing = { player: 0, rival: 0 } as Record<Team, number>;
  for (let tick = 0; tick < maxTicks; tick++) {
    simStep(world);
    for (const u of world.units) {
      swing[u.team] = Math.max(swing[u.team], angleBetween(u.facing, spawnFacing.get(u.id)!));
      if (u.attackCd !== UNIT_TYPES[u.type].combat.attackTicks) continue;
      const struck = world.units.find(o => o.id === u.targetId);
      if (struck) blows[u.team][approachFrom(u, struck)]++;
    }
    if (world.units.every(u => u.team === 'player') || world.units.every(u => u.team === 'rival')) break;
  }
  return { blows, swing };
}

/** Absolute angle between two headings, the short way round. */
function angleBetween(a: number, b: number): number {
  const tau = Math.PI * 2;
  const d = Math.abs(a - b) % tau;
  return d > Math.PI ? tau - d : d;
}

// ---------------------------------------------------------------------------

describe('no hidden randomness (D-019)', () => {
  it('replays a fight tick for tick, not merely end to end', () => {
    // Comparing only the final tally would pass on a sim that diverged mid-fight
    // and happened to converge again — and B-005 is the reminder that a wrong
    // result can be perfectly repeatable.
    const a = setupVsArrival(10, 11, true);
    const b = setupVsArrival(10, 11, true);
    for (let tick = 0; tick < 600; tick++) {
      simStep(a);
      simStep(b);
      expect(hash(a), `diverged at tick ${tick}`).toBe(hash(b));
    }
    expect(JSON.stringify(tally(a))).toBe(JSON.stringify(tally(b)));
  });

  it('leaves the match generator exactly where it found it', () => {
    // D-019's secondary benefit: the generator's position stays independent of
    // how much fighting happened, which is what keeps a replay's later draws
    // aligned with the recording's. A fight that consumed one draw would desync
    // everything downstream of it and nothing here would look wrong.
    const world = setupVsArrival(10, 11, true);
    const before = world.rngState;
    const outcome = fightOut(world);
    expect(outcome.ticks).toBeGreaterThan(100);   // a real fight, not a no-op
    expect(world.rngState).toBe(before);
  });

  it('resolves identically under four different match seeds', () => {
    // The strongest form of the claim: the seed is not an input to combat at
    // all, so changing it may not move a single hit point. Survivors and health
    // are compared rather than hash(), since the seed itself is hashed.
    const results = [1337, 99, 7, 20260806]
      .map(seed => fightOut(setupVsArrival(10, 11, true, 'marksman', CONTACT, seed)))
      .map(o => JSON.stringify(o));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain('"ticks":489');
  });
});

describe('the ground these scenarios are fought on is neutral', () => {
  it('gives neither side elevation or facing', () => {
    // Without this the setup result would be unreadable: highGroundBonus is
    // 1.25 and flankBonus 1.35, either of which swamps the settle advantage
    // being measured. B-007 is why it cannot be assumed.
    const world = setupVsArrival(10, 14, true);
    for (let t = 0; t < 260; t++) simStep(world);
    const defenders = unitsOf(world, 'player');
    const attackers = unitsOf(world, 'rival');
    expect(defenders.length).toBeGreaterThan(0);
    expect(attackers.length).toBeGreaterThan(0);
    for (const d of defenders) {
      for (const a of attackers) {
        expect(elevationMultiplier(d, a)).toBe(1);
        expect(elevationMultiplier(a, d)).toBe(1);
        expect(flankMultiplier(d, a)).toBe(1);
        expect(flankMultiplier(a, d)).toBe(1);
      }
    }
  });

  it('does not let the control fight move at all', () => {
    // The numbers-only control has to be genuinely static, or it is quietly a
    // second setup scenario with the roles unassigned.
    const world = evenStart(10, 11);
    const start = world.units.map(u => ({ id: u.id, x: u.x, z: u.z }));
    for (let t = 0; t < 120; t++) simStep(world);
    for (const u of world.units) {
      const was = start.find(s => s.id === u.id)!;
      expect(Math.hypot(u.x - was.x, u.z - was.z)).toBe(0);
    }
    expect(world.units.every(u => u.stillTicks >= COMBAT.settleTicks)).toBe(true);
  });
});

describe('preparation beats modest numerical superiority (§2)', () => {
  it('hands the fight to the bigger force when neither side is prepared', () => {
    // The baseline the setup claim has to beat. Equal blocks annihilate each
    // other exactly — which is also a live check that the B-005 fix holds, since
    // any first-mover bias would show up here as a survivor.
    const even = fightOut(evenStart(10, 10));
    expect(even.winner).toBe(null);
    expect(even.survivors.player).toBe(0);
    expect(even.survivors.rival).toBe(0);

    // One extra Marksman, nothing else changed, and it is not close: the larger
    // force keeps half its models. Numbers alone are decisive at +10%.
    const outnumbered = fightOut(evenStart(10, 11));
    expect(outnumbered.winner).toBe('rival');
    expect(outnumbered.survivors.rival).toBe(5);
  });

  it('lets ten prepared Marksmen beat eleven that walk into contact', () => {
    // The claim itself. Same eleven attackers that swept the control 5-0 above;
    // the only difference is that the defence was told to hold, so it is settled
    // at accuracyStationary 0.95 when the attackers arrive still at 0.35.
    const outcome = fightOut(setupVsArrival(10, 11, true));
    expect(outcome.winner).toBe('player');
    expect(outcome.survivors.rival).toBe(0);
    expect(outcome.survivors.player).toBe(3);
    expect(margin(outcome)).toBe(1);
  });

  it('overcomes about a 10-15% deficit and no more', () => {
    // The number the claim is actually worth, swept rather than asserted. §2 says
    // "modest" numerical superiority, and this is what modest turns out to mean:
    //
    //   defenders |  6   8  10  12  14  16
    //   beats     |  7   9  11  13  16  18
    //   deficit   | +1  +1  +1  +1  +2  +2
    //   ratio     | 1.17 1.13 1.10 1.08 1.14 1.13
    //
    // Twelve attackers beat the same prepared ten (4 survivors), so preparation
    // is a ~1.1x multiplier on force size, not a licence to be outnumbered.
    const ceiling: Record<number, number> = {};
    for (const defenders of [6, 8, 10, 12, 14, 16]) {
      ceiling[defenders] = largestForceBeaten(defenders, true);
    }
    expect(ceiling).toEqual({ 6: 7, 8: 9, 10: 11, 12: 13, 14: 16, 16: 18 });

    for (const [defenders, beaten] of Object.entries(ceiling)) {
      const ratio = beaten / Number(defenders);
      expect(ratio).toBeGreaterThan(1.05);
      expect(ratio).toBeLessThan(1.20);
    }

    const overrun = fightOut(setupVsArrival(10, 12, true));
    expect(overrun.winner).toBe('rival');
    expect(overrun.survivors.rival).toBe(4);
  });

  it('gives back the settle but not the facing if the defence is not told to hold', () => {
    // The mechanic, isolated. `COMBAT.acquireRange` is 9.0 and a Marksman
    // reaches 8.26, so an *idle* defender acquires a target it cannot yet shoot
    // and `stepPursuit` walks it 0.38 across that 0.74-wide band. Measured: the
    // defence sits at accuracy 0.95 until tick 118, steps forward on tick 119,
    // and is back at 0.35 for the volley that decides the fight. The attackers,
    // under an explicit move order, never divert — so the side that prepared is
    // the side caught moving.
    //
    // That used to cost the defence the fight outright, and the reason was not
    // the settle. With facing rewritten instantly every tick, a defender that
    // drifted forward and then walked back to its anchor turned its back on the
    // enemy for free, and the attackers put 15 of their 45 blows into it at
    // `flankBonus` 1.35 — measured, on the pre-`turnRate` sim. A bounded turn
    // rate removes that half of the penalty and only that half.
    const prepared = fightOut(setupVsArrival(10, 10, true));
    const drifting = fightOut(setupVsArrival(10, 10, false));
    expect(prepared.winner).toBe('player');
    expect(prepared.survivors.player).toBe(5);
    expect(drifting.winner).toBe('player');
    expect(drifting.survivors.player).toBe(5);

    // Same five models standing at the end, and that is the whole reason body
    // count is the wrong yardstick here: the held defence finishes on 217.0 hp
    // and the drifting one on 17.5, 8% of the health for the same nominal win.
    // Losing the settle is now worth a mauling rather than the battle.
    expect(prepared.hp.player).toBeCloseTo(217, 6);
    expect(drifting.hp.player).toBeCloseTo(17.5, 6);

    // Why the drift is survivable at all: the defence moves on 9 scattered
    // ticks, never more than 3 consecutively, and 3 ticks at the Marksman's
    // 0.125 rad/tick is 0.375 rad — 21.5°, comfortably inside the 60° front
    // arc. Neither side ever lands a blow from anywhere but the front, so no
    // part of this result is a flank bonus.
    const drift = measureFight(setupVsArrival(10, 10, false));
    expect(drift.blows.player).toEqual({ front: 55, side: 0, rear: 0 });
    expect(drift.blows.rival).toEqual({ front: 50, side: 0, rear: 0 });
    expect(drift.swing.player).toBeCloseTo(3 * MARKSMAN.turnRate, 6);
    expect(drift.swing.player).toBeLessThan(COMBAT.frontArc);
    expect(drift.swing.rival).toBe(0);

    // What the hold order is worth, then: exactly one extra attacker. Unheld,
    // ten defenders beat ten and nothing larger; held, they beat eleven.
    expect(largestForceBeaten(10, false)).toBe(10);
    expect(largestForceBeaten(10, true)).toBe(11);
  });

  it('buys a Legionnaire nothing, and holding one still costs it the fight', () => {
    // The attribution control. A Legionnaire's accuracyStationary and
    // accuracyMoving are both 0.9, so settling cannot pay it — and it does not:
    // the same preparation that wins a Marksman fight 5-0 loses a Legionnaire
    // one 0-10, against equal numbers.
    //
    // **§2's setup claim still does not hold for half the Phase 1 roster, and
    // the gap between the prepared line and the unprepared one has widened in
    // the wrong direction: from 4 models to 16.** The mechanic at fault is
    // `hold` rather than settle. A held Legionnaire may never step, and melee
    // reach is 1.74, so once its own front rank dies it can no longer touch
    // anything: it lands 109 blows and takes 208. Both counts, and the hp it
    // leaves the attackers on, are identical to the pre-`turnRate` sim — the
    // cleanest evidence available that no facing rule rescues a unit that
    // cannot close.
    const gap = MARKSMAN.combat.accuracyStationary - MARKSMAN.combat.accuracyMoving;
    const melee = UNIT_TYPES.legionnaire.combat;
    expect(gap).toBeGreaterThan(0.5);
    expect(melee.accuracyStationary - melee.accuracyMoving).toBe(0);

    const held = fightOut(setupVsArrival(10, 10, true, 'legionnaire', MELEE_CONTACT));
    expect(held.winner).toBe('rival');
    expect(held.survivors.rival).toBe(10);          // not one attacker lost

    // What did change is the thing it is being compared against. Left idle, the
    // same ten now *win* 6-0 where they used to lose 0-4, because manoeuvre
    // finally buys something a scrum cannot take straight back: free to pursue,
    // they land 20 rear-arc and 8 side-arc blows on a block that arrived under
    // move orders and stopped. So the hold order does not merely fail to help a
    // melee line, it inverts a 6-0 win into a 0-10 loss — a 16-model swing on
    // the same twenty models and the same ground.
    const idle = fightOut(setupVsArrival(10, 10, false, 'legionnaire', MELEE_CONTACT));
    expect(idle.winner).toBe('player');
    expect(idle.survivors.player).toBe(6);

    // And it buys manoeuvre, not invulnerability: eleven attackers put the same
    // idle defence back to nothing.
    const outnumbered = fightOut(setupVsArrival(10, 11, false, 'legionnaire', MELEE_CONTACT));
    expect(outnumbered.winner).toBe('rival');
    expect(outnumbered.survivors.rival).toBe(5);

    // The arcs are the attribution, and they are the reason this reads as a §2
    // result rather than a fluke: a held line never lands a blow outside the
    // enemy's front arc, an idle one lands 28 of its 211 outside it. §2's
    // positioning pillar therefore does reach melee — through the flank arc,
    // and not through anything the word "setup" describes.
    const heldBlows = measureFight(setupVsArrival(10, 10, true, 'legionnaire', MELEE_CONTACT)).blows;
    const idleBlows = measureFight(setupVsArrival(10, 10, false, 'legionnaire', MELEE_CONTACT)).blows;
    expect(heldBlows.player).toEqual({ front: 109, side: 0, rear: 0 });
    expect(heldBlows.rival).toEqual({ front: 208, side: 0, rear: 0 });
    expect(idleBlows.player).toEqual({ front: 183, side: 8, rear: 20 });
    expect(idleBlows.rival).toEqual({ front: 159, side: 2, rear: 19 });

    // Worth recording because it bounds how much of the above is flanking: with
    // facing rewritten instantly, 208 of that fight's 297 blows landed in
    // somebody's back and the winner was whoever spun fastest. Bounded turning
    // cuts that to 39 of 391 — the flank is now earned by walking round a line
    // that cannot come about, which is the mechanic §2 asks for.
    const idleTotal = Object.values(idleBlows.player).concat(Object.values(idleBlows.rival));
    expect(idleTotal.reduce((a, b) => a + b, 0)).toBe(391);
  });
});

describe('battles are quick and decisive (§2)', () => {
  /** 30 seconds at 30 Hz. §3 targets 10-15 minute matches, so an engagement
   *  that ran past this would be a measurable share of the whole game. */
  const BUDGET = 900;

  it('resolves a representative engagement in about eleven seconds', () => {
    // Ten against eleven, prepared — the headline scenario above. 489 ticks is
    // 16.3s; the even 10v10 control is 324 ticks, 10.8s.
    const engagement = fightOut(setupVsArrival(10, 11, true));
    const control = fightOut(evenStart(10, 10));
    expect(engagement.ticks).toBe(489);
    expect(control.ticks).toBe(324);
    expect(engagement.ticks).toBeLessThan(BUDGET);
  });

  it('annihilates the loser rather than trading down to a stalemate', () => {
    // "Decisive" measured as a body count, not a feeling: in every shape tested
    // the losing side ends on zero, so no engagement finishes with two damaged
    // armies still facing each other.
    const shapes: Outcome[] = [
      fightOut(evenStart(10, 11)),
      fightOut(setupVsArrival(10, 11, true)),
      fightOut(setupVsArrival(10, 12, true)),
      fightOut(setupVsArrival(10, 10, false)),
    ];
    for (const outcome of shapes) {
      expect(Math.min(outcome.survivors.player, outcome.survivors.rival)).toBe(0);
      expect(Math.abs(margin(outcome))).toBe(1);
      expect(outcome.ticks).toBeLessThan(BUDGET);
    }
  });

  it('takes melee about two and a half times as long as ranged', () => {
    // Worth recording because it is the closest thing in the roster to a grind:
    // 796 ticks is 26.5s against the Marksman's 324. Still inside budget, but it
    // is the number to watch if attackTicks or hp are ever raised.
    const ranged = fightOut(evenStart(10, 10));
    const melee = fightOut(evenStart(10, 10, 'legionnaire', MELEE_CONTACT));
    expect(ranged.ticks).toBe(324);
    expect(melee.ticks).toBe(796);
    expect(melee.ticks).toBeLessThan(BUDGET);
    expect(melee.ticks / ranged.ticks).toBeGreaterThan(2);
  });

  it('never leans on the harness tick budget to finish', () => {
    // A fight that only ended because fightOut ran out would report a tally that
    // means nothing, and every assertion above would be measuring the cap.
    const outcome = fightOut(setupVsArrival(10, 11, true), BUDGET);
    expect(outcome.ticks).toBeLessThan(BUDGET - 1);
    expect(REACH).toBeLessThan(COMBAT.acquireRange);   // the band the drift test uses
  });
});
