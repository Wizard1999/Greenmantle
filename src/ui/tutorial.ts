import type { World } from '../core/types';

export type TutorialAction = 'frameBoard';

export interface TutorialSnapshot {
  selectedWorker: boolean;
  gatheringWorker: boolean;
  selectedStandard: boolean;
  trainedLegionnaire: boolean;
  selectedCombatUnit: boolean;
  issuedCombatMove: boolean;
  framedBoard: boolean;
}

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  complete: (snapshot: TutorialSnapshot) => boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'select-worker',
    title: 'Select a caretaker',
    body: 'Left-click one of your worker units near the Standard.',
    complete: s => s.selectedWorker,
  },
  {
    id: 'gather',
    title: 'Recover Legacy',
    body: 'With the worker selected, right-click a resource node. The gather-and-return loop continues automatically.',
    complete: s => s.gatheringWorker,
  },
  {
    id: 'select-standard',
    title: 'Select the Standard',
    body: 'Left-click your main structure to open its production controls.',
    complete: s => s.selectedStandard,
  },
  {
    id: 'train-legionnaire',
    title: 'Train a Legionnaire',
    body: 'Press E or use the Legionnaire button. Production consumes resources and command capacity.',
    complete: s => s.trainedLegionnaire,
  },
  {
    id: 'select-army',
    title: 'Select a combat unit',
    body: 'Left-click or drag a selection box around one or more Legionnaires or Marksmen.',
    complete: s => s.selectedCombatUnit,
  },
  {
    id: 'move-army',
    title: 'Issue a move order',
    body: 'Right-click the battlefield to move the selected force.',
    complete: s => s.issuedCombatMove,
  },
  {
    id: 'frame-board',
    title: 'See the whole world',
    body: 'Press Home to frame the entire battlefield, then zoom and orbit freely from miniature scale to the World Turtle view.',
    complete: s => s.framedBoard,
  },
] as const;

export function firstIncompleteTutorialStep(snapshot: TutorialSnapshot): number {
  const index = TUTORIAL_STEPS.findIndex(step => !step.complete(snapshot));
  return index === -1 ? TUTORIAL_STEPS.length : index;
}

export const emptyTutorialSnapshot = (): TutorialSnapshot => ({
  selectedWorker: false,
  gatheringWorker: false,
  selectedStandard: false,
  trainedLegionnaire: false,
  selectedCombatUnit: false,
  issuedCombatMove: false,
  framedBoard: false,
});

/**
 * Fold what the world shows right now into what has already been seen.
 *
 * Every field of a `TutorialSnapshot` is a fact about the present, and several
 * of those facts exclude one another. Clicking the Standard clears the unit
 * selection (`input/mouse.ts` — a building selection and a unit selection
 * cannot both exist), so the instant a player obeys step 3 the evidence for
 * step 1 is gone. Deriving progress from the present alone therefore walked
 * backwards: `firstIncompleteTutorialStep` re-scanned from zero and the panel
 * snapped to "Step 1 of 7", and because those two steps can never hold at the
 * same time the sequence could not pass step 3 at all.
 *
 * Progress is evidence the player has already produced, so it is remembered
 * rather than re-measured. Latching also covers the transient conditions —
 * a move order clears when the unit arrives, a trained Legionnaire can die —
 * which would otherwise regress the same way for a different reason.
 *
 * Monotonicity of the *step index* follows from this only while every step's
 * `complete` stays a positive reading of the snapshot. `tests/tutorial.test.ts`
 * asserts that, so a step written with a negated condition fails loudly instead
 * of quietly reintroducing the loop.
 */
export function observeTutorialSnapshot(
  seen: TutorialSnapshot,
  now: TutorialSnapshot,
): TutorialSnapshot {
  const merged = { ...seen };
  for (const key of Object.keys(merged) as Array<keyof TutorialSnapshot>) {
    merged[key] = seen[key] || now[key];
  }
  return merged;
}

export interface TutorialController {
  update: () => void;
  notify: (action: TutorialAction) => void;
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
}

/**
 * The key keeps its old name for the same reason the save magic string does
 * (D-030): it is a storage identifier, not a display name, and renaming it
 * would make every browser that has already recorded an outcome forget it in
 * exchange for nothing.
 */
const STORAGE_KEY = 'longbarrow:tutorial-complete';

/** What the player did with the guide last time. */
export type TutorialOutcome = 'complete' | 'skipped' | 'dismissed';

const OUTCOMES: readonly string[] = ['complete', 'skipped', 'dismissed'];

/**
 * Read a recorded outcome back, or null if there is nothing this module wrote.
 *
 * Split out from storage so the decision it drives — auto-open or not, and
 * whether this is a first visit or a repeat — is testable without a browser.
 * An unrecognised value reads as null rather than as "seen": only these three
 * strings are ever written, so anything else is not an outcome the tutorial
 * recorded and should not silently suppress a first-time player's guide.
 */
export function parseTutorialOutcome(raw: string | null): TutorialOutcome | null {
  return raw !== null && OUTCOMES.includes(raw) ? raw as TutorialOutcome : null;
}

export interface TutorialUiState { selectedBuildingId: number | null; }

/** Everything the guide watches. Nothing here is written to — the tutorial
 *  observes the world and never issues a command into it. */
export interface TutorialContext {
  world: World;
  ui: TutorialUiState;
  /** Camera and input gestures the sim does not record. */
  actions: ReadonlySet<TutorialAction>;
  /** Legionnaires the player already held when the guide opened, so step 4 asks
   *  for a new one rather than being satisfied by a pre-placed army. */
  initialLegionnaires: number;
}

/** Read the world once. Exported so the progression can be driven by the real
 *  sim and the real command layer in tests, rather than by hand-built flags. */
export function tutorialSnapshot(ctx: TutorialContext): TutorialSnapshot {
  const { world, ui, actions, initialLegionnaires } = ctx;
  const selected = world.units.filter(unit => unit.team === 'player' && unit.selected);
  const selectedWorkers = selected.filter(unit => unit.type === 'worker');
  const selectedCombat = selected.filter(unit => unit.type !== 'worker');
  return {
    selectedWorker: selectedWorkers.length > 0,
    gatheringWorker: world.units.some(unit =>
      unit.team === 'player' && unit.gather !== null && unit.gather.state !== 'idle'),
    selectedStandard: ui.selectedBuildingId !== null && world.buildings.some(
      building => building.id === ui.selectedBuildingId
        && building.team === 'player'
        && building.type === 'standard',
    ),
    trainedLegionnaire: world.units.filter(
      unit => unit.team === 'player' && unit.type === 'legionnaire',
    ).length > initialLegionnaires,
    selectedCombatUnit: selectedCombat.length > 0,
    // `orderMode`, not `target`. A unit walking to its rally point after being
    // produced carries a destination with `orderMode: 'idle'`
    // (`sim/production.ts`), so testing `target` alone completed step 6 the
    // moment the player selected the Legionnaire they had just trained — the
    // step asked for an order and was satisfied without one. Every direct order
    // counts, since right-clicking an enemy is the same gesture and issues an
    // attack-move.
    issuedCombatMove: selectedCombat.some(unit => unit.orderMode !== 'idle'),
    framedBoard: actions.has('frameBoard'),
  };
}

export function createTutorial(world: World, ui: TutorialUiState): TutorialController {
  const initialLegionnaires = world.units.filter(
    unit => unit.team === 'player' && unit.type === 'legionnaire',
  ).length;
  const actions = new Set<TutorialAction>();
  const params = new URLSearchParams(window.location.search);

  /**
   * A first-time player gets the guide without asking for it.
   *
   * This replaces the permanent keybinding wall (D-032). The wall was help that
   * nobody could turn off; this is help that arrives once, at the only moment
   * it is wanted, and then stays behind the Guide button forever. `?tutorial=1`
   * still forces it for testing, and any recorded outcome — completed or
   * skipped — suppresses the automatic open.
   */
  let recorded = (() => {
    try { return parseTutorialOutcome(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  })();
  let active = params.get('tutorial') === '1'
    || (params.get('tutorial') !== '0' && recorded === null);
  let lastStep = -1;
  let observed = emptyTutorialSnapshot();

  // The launcher lives in the tools pill in `index.html` so the top-left corner
  // is one object; falling back to <body> keeps this module usable on a page
  // that has no tools bar (the tests' bare DOM, for one).
  const existing = document.getElementById('tutorial-launcher');
  const launcher = existing instanceof HTMLButtonElement
    ? existing
    : document.body.appendChild(Object.assign(document.createElement('button'), {
        id: 'tutorial-launcher', type: 'button', textContent: 'Guide',
      }));
  launcher.title = recorded === 'complete'
    ? 'Walk through the first commands again'
    : 'Walk through the first commands';

  const panel = document.createElement('section');
  panel.id = 'tutorial-panel';
  panel.className = 'panel';
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = `
    <div class="tutorial-topline">
      <span id="tutorial-progress"></span>
      <button id="tutorial-close" type="button" aria-label="Close tutorial">×</button>
    </div>
    <h2 id="tutorial-title"></h2>
    <p id="tutorial-body"></p>
    <div class="tutorial-meter"><span id="tutorial-meter-fill"></span></div>
    <button id="tutorial-skip" type="button">Skip tutorial</button>
  `;
  document.body.appendChild(panel);

  function required<T extends Element>(selector: string): T {
    const found = panel.querySelector<T>(selector);
    if (!found) throw new Error(`tutorial UI missing ${selector}`);
    return found;
  }
  const progress = required<HTMLElement>('#tutorial-progress');
  const title = required<HTMLElement>('#tutorial-title');
  const body = required<HTMLElement>('#tutorial-body');
  const fill = required<HTMLElement>('#tutorial-meter-fill');
  const close = required<HTMLButtonElement>('#tutorial-close');
  const skip = required<HTMLButtonElement>('#tutorial-skip');

  function setVisible(visible: boolean): void {
    panel.classList.toggle('visible', visible);
    // The launcher stays put and lights up instead of vanishing: a control that
    // disappears when used cannot be used to put the thing away again.
    launcher.classList.toggle('on', visible);
    launcher.setAttribute('aria-expanded', String(visible));
  }

  // Guarded because completion is rendered from the frame loop: without this,
  // finishing the guide would write to localStorage on every frame for the rest
  // of the match.
  function remember(outcome: TutorialOutcome): void {
    if (recorded === outcome) return;
    recorded = outcome;
    try { localStorage.setItem(STORAGE_KEY, outcome); } catch { /* private mode */ }
  }

  // `observed` deliberately survives a close and reopen: a player who puts the
  // guide away mid-match and brings it back should return to where they were,
  // not to step 1. Only `lastStep` resets, to force the panel to redraw.
  function start(): void {
    active = true;
    lastStep = -1;
    setVisible(true);
  }

  function stop(): void {
    active = false;
    setVisible(false);
  }

  launcher.addEventListener('click', () => { if (active) stop(); else start(); });
  // Closing is a decision too — record it, or the guide reopens on every load.
  close.addEventListener('click', () => { remember('dismissed'); stop(); });
  skip.addEventListener('click', () => { remember('skipped'); stop(); });

  const context: TutorialContext = { world, ui, actions, initialLegionnaires };

  function update(): void {
    if (!active) return;
    // Observe every frame; redraw only when the step actually changes.
    observed = observeTutorialSnapshot(observed, tutorialSnapshot(context));
    const stepIndex = firstIncompleteTutorialStep(observed);
    if (stepIndex === lastStep) return;
    lastStep = stepIndex;
    const step = TUTORIAL_STEPS[stepIndex];
    if (!step) {
      progress.textContent = 'Tutorial complete';
      title.textContent = 'The table is yours';
      // The win condition as `sim/combat.ts` actually resolves it: a team is
      // eliminated once it holds no buildings *and* nothing under construction.
      // This card is the only place a player is told, so "destroy the rival
      // Standard" was worse than saying nothing — it names one building in a
      // rule that counts all of them.
      body.textContent = 'Gather, build, form squads, and level the rival base — a team is beaten '
        + 'once it holds no buildings and nothing under construction. You can reopen this guide '
        + 'at any time.';
      fill.style.width = '100%';
      skip.textContent = 'Close';
      remember('complete');
      return;
    }
    progress.textContent = `Step ${stepIndex + 1} of ${TUTORIAL_STEPS.length}`;
    title.textContent = step.title;
    body.textContent = step.body;
    fill.style.width = `${(stepIndex / TUTORIAL_STEPS.length) * 100}%`;
    skip.textContent = 'Skip tutorial';
  }

  setVisible(active);
  return {
    update,
    notify(action) { actions.add(action); },
    start,
    stop,
    isActive: () => active,
  };
}
