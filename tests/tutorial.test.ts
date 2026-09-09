import { describe, expect, it } from 'vitest';
import type { EntityId } from '../src/core/types';
import { cmdGather, cmdMove, cmdSetSelection, cmdTrain } from '../src/sim/commands';
import {
  emptyTutorialSnapshot, firstIncompleteTutorialStep, observeTutorialSnapshot,
  parseTutorialOutcome, TUTORIAL_STEPS, tutorialSnapshot,
  type TutorialAction, type TutorialContext, type TutorialSnapshot,
} from '../src/ui/tutorial';
import { must, peacefulMap, run } from './helpers';

const blank = emptyTutorialSnapshot;

const KEYS = Object.keys(blank()) as Array<keyof TutorialSnapshot>;

describe('tutorial progression', () => {
  it('begins at worker selection', () => {
    expect(firstIncompleteTutorialStep(blank())).toBe(0);
  });

  it('advances only through completed prerequisites', () => {
    const snapshot = blank();
    snapshot.selectedWorker = true;
    snapshot.gatheringWorker = true;
    expect(firstIncompleteTutorialStep(snapshot)).toBe(2);
  });

  it('reports completion when every step is satisfied', () => {
    const snapshot = blank();
    for (const key of KEYS) snapshot[key] = true;
    expect(firstIncompleteTutorialStep(snapshot)).toBe(TUTORIAL_STEPS.length);
  });
});

/**
 * The defect these guard: step conditions are facts about the present, and
 * several of them exclude each other, so obeying a later step destroyed the
 * evidence for an earlier one and the sequence fell back to step 1.
 */
describe('tutorial progress is remembered, not re-measured', () => {
  it('keeps a step complete after the world stops showing it', () => {
    const worker = { ...blank(), selectedWorker: true };
    const standard = { ...blank(), selectedStandard: true };
    // What the world actually reports at that moment, taken alone.
    expect(firstIncompleteTutorialStep(standard)).toBe(0);
    // What the guide has been shown by then.
    expect(firstIncompleteTutorialStep(observeTutorialSnapshot(worker, standard))).toBe(1);
  });

  it('unions observations without mutating either side', () => {
    const seen = { ...blank(), selectedWorker: true };
    const now = { ...blank(), gatheringWorker: true };
    const merged = observeTutorialSnapshot(seen, now);
    expect(merged.selectedWorker).toBe(true);
    expect(merged.gatheringWorker).toBe(true);
    expect(merged.framedBoard).toBe(false);
    expect(seen.gatheringWorker).toBe(false);
    expect(now.selectedWorker).toBe(false);
  });

  /**
   * Latching only guarantees a forward-moving step index while every step reads
   * its evidence positively. A step written as `s => !s.something` would satisfy
   * itself by *losing* evidence and quietly restore the loop, so the shape of
   * the conditions is asserted rather than assumed.
   */
  it('has no step that a gained observation can un-complete', () => {
    for (const step of TUTORIAL_STEPS) {
      for (let bits = 0; bits < 1 << KEYS.length; bits++) {
        const snapshot = blank();
        KEYS.forEach((key, i) => { snapshot[key] = (bits & (1 << i)) !== 0; });
        if (!step.complete(snapshot)) continue;
        for (const key of KEYS) {
          const richer = { ...snapshot, [key]: true };
          expect(step.complete(richer), `${step.id} un-completed by ${key}`).toBe(true);
        }
      }
    }
  });
});

describe('tutorial outcome storage', () => {
  it('reads back each outcome the tutorial writes', () => {
    expect(parseTutorialOutcome('complete')).toBe('complete');
    expect(parseTutorialOutcome('skipped')).toBe('skipped');
    expect(parseTutorialOutcome('dismissed')).toBe('dismissed');
  });

  it('treats a missing or foreign value as a first visit', () => {
    expect(parseTutorialOutcome(null)).toBe(null);
    expect(parseTutorialOutcome('')).toBe(null);
    expect(parseTutorialOutcome('true')).toBe(null);
  });
});

/**
 * The progression driven end to end by the real sim and the real command layer,
 * in the order and by the gestures `input/mouse.ts` produces. Hand-built
 * snapshots cannot show the bug, because the bug was that two of the conditions
 * can never hold in the same world at the same time.
 */
describe('a player can finish the tutorial', () => {
  it('advances monotonically through all seven steps and completes', () => {
    const world = peacefulMap();
    const ui = { selectedBuildingId: null as EntityId | null };
    const actions = new Set<TutorialAction>();
    const context: TutorialContext = {
      world,
      ui,
      actions,
      initialLegionnaires: world.units.filter(
        u => u.team === 'player' && u.type === 'legionnaire',
      ).length,
    };

    let observed = blank();
    const seen: number[] = [];
    /** What the world reports on its own, with nothing remembered — the old
     *  derivation, sampled alongside the fixed one so the regression stays
     *  pinned rather than described. */
    const forgetful: number[] = [];
    const momentary = (): number => {
      const index = firstIncompleteTutorialStep(tutorialSnapshot(context));
      forgetful.push(index);
      return index;
    };
    const step = (): number => {
      momentary();
      observed = observeTutorialSnapshot(observed, tutorialSnapshot(context));
      const index = firstIncompleteTutorialStep(observed);
      seen.push(index);
      return index;
    };

    expect(step()).toBe(0);

    // 1 — select a caretaker.
    const worker = must(world.units.find(u => u.team === 'player' && u.gather), 'worker');
    cmdSetSelection(world, [worker.id]);
    expect(step()).toBe(1);

    // 2 — send it to a node.
    const node = must(world.nodes[0], 'resource node');
    cmdGather(world, [worker.id], node.id);
    expect(step()).toBe(2);

    // 3 — select the Standard. `input/mouse.ts` clears the unit selection first:
    // a building selection and a unit selection cannot coexist, which is exactly
    // what used to throw the guide back to step 1.
    const standard = must(
      world.buildings.find(b => b.team === 'player' && b.type === 'standard'), 'standard',
    );
    cmdSetSelection(world, []);
    ui.selectedBuildingId = standard.id;
    expect(momentary()).toBe(0);
    expect(step()).toBe(3);

    // 4 — train a Legionnaire. Topped up deliberately: this is a test about
    // progression, not about how long gathering takes.
    world.resources.player = 500;
    const before = world.units.filter(u => u.team === 'player' && u.type === 'legionnaire');
    expect(cmdTrain(world, standard.id, 'legionnaire').ok).toBe(true);
    run(world, 130);
    const legionnaire = must(
      world.units.find(
        u => u.team === 'player' && u.type === 'legionnaire' && !before.includes(u),
      ),
      'trained legionnaire',
    );
    expect(step()).toBe(4);

    // 5 — select it. Selecting a unit clears the building selection in turn.
    // It is still walking to its rally point, so it already has a destination:
    // step 6 must not count that as an order the player gave.
    ui.selectedBuildingId = null;
    cmdSetSelection(world, [legionnaire.id]);
    expect(legionnaire.target).not.toBe(null);
    expect(legionnaire.orderMode).toBe('idle');
    expect(momentary()).toBe(0);
    expect(step()).toBe(5);

    // 6 — order it somewhere.
    cmdMove(world, [legionnaire.id], legionnaire.x + 6, legionnaire.z + 6);
    expect(step()).toBe(6);

    // 7 — frame the board. Not sim state, so it arrives through `notify`.
    actions.add('frameBoard');
    expect(step()).toBe(TUTORIAL_STEPS.length);

    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `step went backwards at ${i}: ${seen.join(' -> ')}`)
        .toBeGreaterThanOrEqual(must(seen[i - 1]));
    }

    // The same player, if the guide kept no memory: it climbs to step 3, drops
    // to step 1 when the Standard is clicked, and never climbs again. Steps 5,
    // 6 and 7 are unreachable and the completion card cannot render.
    expect(Math.max(...forgetful), forgetful.join(' -> ')).toBe(2);
    expect(forgetful.at(-1)).toBe(0);
  });
});
