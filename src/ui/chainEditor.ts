import type { BehaviourKind, Squad, World } from '../core/types';
import { AUTOMATION } from '../data/tuning';
import {
  cmdClearChain, cmdRemoveChainStep, cmdRunChain, cmdSetChainLoop, cmdStopChain,
} from '../sim/commands';
import { automationSlots, runningSquads, squadByNumber } from '../sim/squads';
import type { UiState } from '../input/selection';
import { issueCommand } from '../replay/live';

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found;
};

const BEHAVIOUR_ORDER: BehaviourKind[] = ['move', 'attackmove', 'gather', 'patrol'];
const BEHAVIOUR_LABEL: Record<BehaviourKind, string> = {
  move: 'Move',
  attackmove: 'Attack-move',
  gather: 'Gather',
  patrol: 'Patrol',
};

export interface ChainEditor {
  update: () => void;
}

/**
 * The interaction the blueprint actually judges 1.7 on: assembling a
 * three-step chain in a handful of clicks. Picking a behaviour arms it, and
 * the next click on the map sites that step — so building a chain is
 * "behaviour, place, behaviour, place", not filling in a form.
 */
export function createChainEditor(
  world: World, ui: UiState, flash: (msg: string) => void,
): ChainEditor {
  const title = el('chain-title');
  const squadRow = el('chain-squads');
  const body = el('chain-body');

  const selectedSquad = (): Squad | null =>
    world.squads.find(s => s.id === ui.selectedSquadId) ?? null;

  let key = '';

  function rebuild(squad: Squad | null): void {
    squadRow.innerHTML = '';
    for (let n = 1; n <= AUTOMATION.maxSquads; n++) {
      const existing = squadByNumber(world, 'player', n);
      const btn = document.createElement('button');
      btn.textContent = String(n);
      btn.className = squad && existing && existing.id === squad.id ? 'on'
        : existing ? '' : 'empty';
      btn.title = existing
        ? `Squad ${n} — ${existing.memberIds.length} unit(s)`
        : `Empty — select units and press Ctrl+${n}`;
      btn.onclick = () => {
        const s = squadByNumber(world, 'player', n);
        if (!s) { flash(`no squad ${n} yet — select units and press Ctrl+${n}`); return; }
        ui.selectedSquadId = s.id;
        ui.armedBehaviour = null;
        for (const u of world.units) u.selected = s.memberIds.includes(u.id);
        ui.selectedBuildingId = null;
        ui.selectedSiteId = null;
      };
      squadRow.appendChild(btn);
    }

    body.innerHTML = '';
    if (!squad) {
      title.textContent = 'Squads';
      const p = document.createElement('div');
      p.className = 'empty-state';
      // One line. The long explanation of what a squad *is* moved to the guide
      // and the control sheet (D-032) — the console states facts, it does not
      // teach, and three lines of tuition sat here for the whole match.
      p.textContent = 'Select units, then Ctrl+1 to form a squad.';
      body.appendChild(p);
      return;
    }

    title.textContent = `Squad ${squad.number} — ${squad.memberIds.length} unit(s)`;

    const list = document.createElement('ol');
    list.dataset['role'] = 'steps';
    body.appendChild(list);

    const add = document.createElement('div');
    add.className = 'add';
    for (const kind of BEHAVIOUR_ORDER) {
      const btn = document.createElement('button');
      btn.textContent = BEHAVIOUR_LABEL[kind];
      btn.dataset['behaviour'] = kind;
      btn.onclick = () => {
        ui.armedBehaviour = ui.armedBehaviour === kind ? null : kind;
        if (ui.armedBehaviour) flash(`click the map to place the ${BEHAVIOUR_LABEL[kind]} step`);
      };
      add.appendChild(btn);
    }
    body.appendChild(add);

    const runRow = document.createElement('div');
    runRow.className = 'run';
    const runBtn = document.createElement('button');
    runBtn.dataset['role'] = 'run';
    runBtn.onclick = () => {
      if (squad.running) {
        issueCommand({ t: 'stopChain', squad: squad.id }, () => cmdStopChain(world, squad.id));
        flash('chain stopped');
        return;
      }
      const res = issueCommand(
        { t: 'runChain', squad: squad.id },
        () => cmdRunChain(world, squad.id),
      );
      flash(res.ok ? `squad ${squad.number} running` : res.reason ?? 'cannot run');
    };
    runRow.appendChild(runBtn);

    const loopBtn = document.createElement('button');
    loopBtn.dataset['role'] = 'loop';
    loopBtn.onclick = () => issueCommand(
      { t: 'setChainLoop', squad: squad.id, loop: !squad.loop },
      () => cmdSetChainLoop(world, squad.id, !squad.loop),
    );
    runRow.appendChild(loopBtn);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.onclick = () => {
      issueCommand({ t: 'clearChain', squad: squad.id }, () => cmdClearChain(world, squad.id));
      ui.armedBehaviour = null;
    };
    runRow.appendChild(clearBtn);
    body.appendChild(runRow);

    const note = document.createElement('div');
    note.className = 'note';
    note.dataset['role'] = 'note';
    body.appendChild(note);
  }

  function update(): void {
    const squad = selectedSquad();
    // Rebuild only when the shape changes, so buttons stay clickable.
    const shape = squad
      ? `${squad.id}:${squad.chain.length}:${world.squads.map(s => s.number).join('')}`
      : `none:${world.squads.map(s => s.number).join('')}`;
    if (shape !== key) { key = shape; rebuild(squad); }

    // live state every frame
    for (const child of squadRow.children) {
      const btn = child as HTMLButtonElement;
      const n = Number(btn.textContent);
      const existing = squadByNumber(world, 'player', n);
      btn.className = squad && existing && existing.id === squad.id ? 'on'
        : existing ? '' : 'empty';
    }
    if (!squad) return;

    const list = body.querySelector('ol[data-role="steps"]');
    if (list) {
      list.innerHTML = '';
      squad.chain.forEach((step, i) => {
        const li = document.createElement('li');
        if (squad.running && squad.index === i) li.className = 'now';
        li.textContent = BEHAVIOUR_LABEL[step.kind];
        const rm = document.createElement('button');
        rm.textContent = '×';
        rm.title = 'remove this step';
        rm.onclick = () => issueCommand(
          { t: 'removeChainStep', squad: squad.id, index: i },
          () => cmdRemoveChainStep(world, squad.id, i),
        );
        li.appendChild(rm);
        list.appendChild(li);
      });
      if (!squad.chain.length) {
        const li = document.createElement('li');
        li.textContent = 'no steps yet';
        li.style.opacity = '0.6';
        list.appendChild(li);
      }
    }

    for (const child of body.querySelectorAll('button')) {
      const btn = child as HTMLButtonElement;
      const kind = btn.dataset['behaviour'] as BehaviourKind | undefined;
      if (kind) {
        btn.className = ui.armedBehaviour === kind ? 'arming' : '';
        btn.disabled = squad.chain.length >= AUTOMATION.maxChainSteps;
      } else if (btn.dataset['role'] === 'run') {
        btn.textContent = squad.running ? 'Stop' : 'Run';
        btn.className = squad.running ? 'stop' : 'go';
        btn.disabled = !squad.chain.length;
      } else if (btn.dataset['role'] === 'loop') {
        btn.textContent = squad.loop ? 'Loop: on' : 'Loop: off';
      }
    }

    const note = body.querySelector('div[data-role="note"]');
    if (note instanceof HTMLElement) {
      const slots = automationSlots(world, 'player');
      const used = runningSquads(world, 'player');
      const blocked = !squad.running && used >= slots;
      note.textContent = ui.armedBehaviour
        ? `click the map to place the ${BEHAVIOUR_LABEL[ui.armedBehaviour]} step`
        : `${used}/${slots} chains running — Command buys automation slots`;
      note.className = blocked ? 'note warn' : 'note';
    }
  }

  return { update };
}
