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

export interface TutorialController {
  update: () => void;
  notify: (action: TutorialAction) => void;
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
}

const STORAGE_KEY = 'longbarrow:tutorial-complete';

export interface TutorialUiState { selectedBuildingId: number | null; }

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
  const seen = (() => {
    try { return localStorage.getItem(STORAGE_KEY) !== null; } catch { return false; }
  })();
  let active = params.get('tutorial') === '1' || (params.get('tutorial') !== '0' && !seen);
  let lastStep = -1;

  // The launcher lives in the tools pill in `index.html` so the top-left corner
  // is one object; falling back to <body> keeps this module usable on a page
  // that has no tools bar (the tests' bare DOM, for one).
  const existing = document.getElementById('tutorial-launcher');
  const launcher = existing instanceof HTMLButtonElement
    ? existing
    : document.body.appendChild(Object.assign(document.createElement('button'), {
        id: 'tutorial-launcher', type: 'button', textContent: 'Guide',
      }));
  launcher.title = 'Walk through the first commands';

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

  function remember(outcome: string): void {
    try { localStorage.setItem(STORAGE_KEY, outcome); } catch { /* private mode */ }
  }

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

  function snapshot(): TutorialSnapshot {
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
      issuedCombatMove: selectedCombat.some(unit => unit.target !== null),
      framedBoard: actions.has('frameBoard'),
    };
  }

  function update(): void {
    if (!active) return;
    const stepIndex = firstIncompleteTutorialStep(snapshot());
    if (stepIndex >= TUTORIAL_STEPS.length) {
      progress.textContent = 'Tutorial complete';
      title.textContent = 'The table is yours';
      body.textContent = 'Gather, build, form squads, and destroy the rival Standard. You can reopen this guide at any time.';
      fill.style.width = '100%';
      skip.textContent = 'Close';
      remember('complete');
      return;
    }
    if (stepIndex === lastStep) return;
    lastStep = stepIndex;
    const step = TUTORIAL_STEPS[stepIndex];
    if (!step) return;
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
