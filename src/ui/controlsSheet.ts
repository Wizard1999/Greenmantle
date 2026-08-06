/**
 * The control reference — the keybinding wall, moved behind a door.
 *
 * What was there before: twelve lines of keys pinned open in the top-left
 * corner of every match, headed "Phase 1.7 — Squads & Behaviour Chains". Two
 * separate failures. It told a first-time player an internal milestone number
 * before it told them anything about the game, and it charged every player who
 * already knew the keys the same screen real estate forever.
 *
 * The replacement splits help by *when it is wanted*:
 *
 *   - **Learning to play** is the guided tutorial (`tutorial.ts`), which now
 *     opens itself on a first visit and never again. It teaches six actions in
 *     order and watches the world to know when each is done.
 *   - **Looking something up** is this sheet: every binding in the build,
 *     grouped by what the player is trying to do, one keypress away and gone
 *     again the moment it is read.
 *
 * Nothing was deleted. `CONTROL_GROUPS` is a superset of the old wall — it adds
 * the bindings the wall never listed (R for marksman, Esc, the minimap click)
 * and drops only the milestone header, which was never help.
 *
 * The table is exported as plain data so a test can assert coverage without a
 * DOM, and so a future settings screen can rebind against the same list.
 */

export interface ControlBinding {
  /** Keys or mouse actions, rendered as separate <kbd> chips. */
  keys: string[];
  what: string;
}

export interface ControlGroup {
  title: string;
  bindings: ControlBinding[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: 'Camera',
    bindings: [
      { keys: ['W', 'A', 'S', 'D'], what: 'Pan the table (or push the pointer to a screen edge)' },
      { keys: ['Scroll'], what: 'Zoom from miniature scale out to the whole world' },
      { keys: ['Middle-drag'], what: 'Orbit around the focus' },
      { keys: ['Home'], what: 'Frame the whole board' },
      { keys: ['Click map'], what: 'Jump the camera there' },
    ],
  },
  {
    title: 'Selection',
    bindings: [
      { keys: ['Left-click'], what: 'Select a unit, structure or build site' },
      { keys: ['Drag'], what: 'Box-select everything inside' },
      { keys: ['G'], what: 'Select every worker you own' },
      { keys: ['1', '…', '5'], what: 'Select a squad' },
      { keys: ['Esc'], what: 'Cancel the armed order, placement or site' },
    ],
  },
  {
    title: 'Orders',
    bindings: [
      { keys: ['Right-click'], what: 'Move — or gather, if the target is a resource node' },
      { keys: ['A'], what: 'Attack-move: engage anything met on the way' },
      { keys: ['P'], what: 'Patrol between here and the next click' },
      { keys: ['S'], what: 'Stop' },
      { keys: ['H'], what: 'Hold this ground' },
    ],
  },
  {
    title: 'Building and production',
    bindings: [
      { keys: ['Q'], what: 'Train a worker at the selected structure' },
      { keys: ['E'], what: 'Train a legionnaire' },
      { keys: ['R'], what: 'Train a marksman' },
      { keys: ['B'], what: 'Site an outpost — with a worker selected, then click the ground' },
      { keys: ['Right-click'], what: 'Set a rally point, with a structure selected' },
    ],
  },
  {
    title: 'Squads and chains',
    bindings: [
      { keys: ['Ctrl', '1', '…', '5'], what: 'Form a persistent squad from the selection' },
      { keys: ['Click a behaviour'], what: 'Arm it, then click the map to place that step' },
      { keys: ['Run'], what: 'Execute the chain; Loop repeats it until you redirect' },
    ],
  },
  {
    title: 'This screen',
    bindings: [
      { keys: ['?'], what: 'Open or close this reference' },
      { keys: ['F1'], what: 'The same' },
      { keys: ['T'], what: 'Throttle test — simulate a slow machine' },
    ],
  },
] as const;

/** Every binding, flattened. Used by tests and by any future rebinding UI. */
export function allBindings(): ControlBinding[] {
  return CONTROL_GROUPS.flatMap(group => group.bindings);
}

export interface ControlsSheet {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

export function mountControlsSheet(): ControlsSheet {
  const sheet = document.createElement('section');
  sheet.id = 'controls-sheet';
  sheet.className = 'panel';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Control reference');

  const head = document.createElement('div');
  head.className = 'sheet-head';
  const title = document.createElement('h2');
  title.textContent = 'Controls';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sheet-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close control reference');
  head.append(title, close);

  const lead = document.createElement('p');
  lead.className = 'sheet-lead';
  lead.textContent = 'Press ? at any time to bring this back.';

  const groups = document.createElement('div');
  groups.className = 'groups';
  for (const group of CONTROL_GROUPS) {
    const section = document.createElement('div');
    const heading = document.createElement('h4');
    heading.textContent = group.title;
    const list = document.createElement('dl');
    for (const binding of group.bindings) {
      const dt = document.createElement('dt');
      binding.keys.forEach((key, index) => {
        if (index > 0) dt.append(document.createTextNode(' '));
        const chip = document.createElement('kbd');
        chip.textContent = key;
        dt.append(chip);
      });
      const dd = document.createElement('dd');
      dd.textContent = binding.what;
      list.append(dt, dd);
    }
    section.append(heading, list);
    groups.appendChild(section);
  }

  const foot = document.createElement('p');
  foot.className = 'sheet-foot';
  foot.textContent = 'New to it? Close this and press Guide — it walks through the first six commands in order.';

  // Settings host. The quality selector used to float over the battlefield as
  // its own dark chip; it is a once-a-match choice, so it belongs behind the
  // same door as the reference rather than in the command surface.
  const settings = document.createElement('div');
  settings.id = 'controls-settings';

  // Settings sit above the reference table, not below it. The table is tall
  // enough to scroll on a laptop, and anything past the fold is a control the
  // player has to go looking for — which is the failure this whole pass is
  // about. Verified by hit-testing the select after opening the sheet.
  sheet.append(head, lead, settings, groups, foot);
  document.body.appendChild(sheet);

  const setOpen = (open: boolean): void => { sheet.classList.toggle('visible', open); };
  const isOpen = (): boolean => sheet.classList.contains('visible');

  const api: ControlsSheet = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen()),
    isOpen,
  };

  close.addEventListener('click', api.close);
  document.getElementById('controls-toggle')?.addEventListener('click', api.toggle);

  // Handled here rather than in `input/keyboard.ts`: that module drives the
  // battlefield and should not have to know a help overlay exists. Escape only
  // closes when the sheet is up, so it keeps its order-cancelling meaning.
  window.addEventListener('keydown', (event) => {
    if (event.key === '?' || event.key === 'F1') {
      event.preventDefault();
      api.toggle();
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      api.close();
    }
  });

  return api;
}
