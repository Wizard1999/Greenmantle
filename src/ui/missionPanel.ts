import type {
  BehaviourKind, Building, EntityId, Mission, MissionObjective, MissionPriority,
  MissionStatus, Squad, Team, Vec2, World,
} from '../core/types';
import { BUILDING_TYPES } from '../data/buildings';
import { cmdSetSelection } from '../sim/commands';
import {
  cmdAssignSquadToMission, cmdCancelMission, cmdCreateMission,
  cmdRemoveSquadFromMission, cmdSetMissionFallback, cmdSetMissionPriority,
} from '../sim/missions';
import type { UiState } from '../input/selection';
import { issueCommand } from '../replay/live';

/**
 * The mission panel and squad cards — Level 2 of the blueprint's three command
 * depths, and the layer the player is meant to spend a match in.
 *
 * Missions have been real simulation state since D-027 and had no surface at
 * all: `grep -rn mission src/ui src/input` returned nothing, so the layer
 * `UI_BLUEPRINT.md` calls "the primary gameplay layer" could not be reached
 * from the interface. This is that surface.
 *
 * Two rules govern it.
 *
 * **Facts, never advice** (blueprint § "Information, never advice"). Every
 * string here reports what a squad *is* doing and where it is standing. None
 * says what it ought to do instead, and none rates a plan — which is why a
 * squad card reads "Advancing · NE 38" and never anything resembling a
 * success estimate.
 *
 * **Every action routes through `issueCommand`.** Calling a mission command
 * directly would leave it out of the recording, and a replay re-simulated
 * without it diverges from the tick the mission was created — the exact
 * failure the gateway exists to prevent.
 */

export const OBJECTIVE_ORDER: readonly MissionObjective[] = [
  'assault', 'defend', 'scout', 'escort', 'expand', 'harvest', 'custom',
];

export const OBJECTIVE_LABEL: Record<MissionObjective, string> = {
  assault: 'Assault', defend: 'Defend', scout: 'Scout', escort: 'Escort',
  expand: 'Expand', harvest: 'Harvest', custom: 'Custom',
};

export const PRIORITY_ORDER: readonly MissionPriority[] = ['low', 'normal', 'high'];

export const PRIORITY_LABEL: Record<MissionPriority, string> = {
  low: 'Low', normal: 'Normal', high: 'High',
};

export const STATUS_LABEL: Record<MissionStatus, string> = {
  active: 'Active', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

/**
 * Stated because the alternative is letting the player infer it from silence.
 * A mission is inert on its own (D-027) — assigning a squad to an assault does
 * not yet make it assault — and a panel that showed the assignment without
 * saying so would be describing a game that does not exist yet.
 *
 * **Delete this the day missions drive squad behaviour.** It is a fact about
 * the current build, and a stale fact reads as a lie.
 */
export const MISSION_INERT_NOTE =
  'A mission records intent. It does not yet drive squad behaviour.';

/** Concluded operations kept on screen. A cancelled mission is still a record
 *  of an order the player gave, but the list must not grow without bound over
 *  a long match; full history belongs to the operations log, which is unbuilt. */
export const CONCLUDED_SHOWN = 3;

/** Blueprint § "Squad Cards" names them in words — "Squad One", not "Squad 1".
 *  Past the table the number stands in, so raising the squad cap in
 *  `data/tuning.ts` cannot produce a card with a blank name. */
const NUMBER_WORDS = ['One', 'Two', 'Three', 'Four', 'Five'];

export function squadName(n: number): string {
  return `Squad ${NUMBER_WORDS[n - 1] ?? n}`;
}

/**
 * Eight-point bearing.
 *
 * `+z` is north because that is the direction `minimapWorldToCanvas` puts at
 * the top of the tactical map. A bearing that disagreed with the minimap would
 * be worse than no bearing at all.
 */
const COMPASS: ReadonlyArray<{ short: string; long: string }> = [
  { short: 'N', long: 'north' }, { short: 'NE', long: 'north-east' },
  { short: 'E', long: 'east' }, { short: 'SE', long: 'south-east' },
  { short: 'S', long: 'south' }, { short: 'SW', long: 'south-west' },
  { short: 'W', long: 'west' }, { short: 'NW', long: 'north-west' },
];

export interface Bearing {
  short: string;
  long: string;
  distance: number;
}

export function bearingBetween(from: Vec2, to: Vec2): Bearing {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const degrees = (Math.atan2(dx, dz) * 180) / Math.PI;
  const index = ((Math.round(degrees / 45) % 8) + 8) % 8;
  const point = COMPASS[index] ?? { short: 'N', long: 'north' };
  return { short: point.short, long: point.long, distance: Math.round(Math.hypot(dx, dz)) };
}

/** The landmark every other position is described against. The Standard is the
 *  one fixed thing a player always knows the location of; if it has fallen, any
 *  surviving structure is still a better reference than raw coordinates. */
export function referenceBuilding(world: World, team: Team): Building | null {
  const own = world.buildings.filter(b => b.team === team);
  return own.find(b => b.type === 'standard') ?? own[0] ?? null;
}

export interface Place {
  /** Short enough for a squad card's third column. */
  short: string;
  /** The same fact spelled out, for the tooltip. */
  long: string;
}

/** There are no place names on the board yet, so "where" is a bearing from the
 *  player's own base — a fact, rather than a name the game invented. */
export function placeOf(world: World, team: Team, at: Vec2 | null): Place {
  if (!at) return { short: '—', long: 'no position' };
  const ref = referenceBuilding(world, team);
  if (!ref) {
    const coords = `${Math.round(at.x)}, ${Math.round(at.z)}`;
    return { short: coords, long: `at ${coords} on the board` };
  }
  const label = BUILDING_TYPES[ref.type].label;
  const bearing = bearingBetween(ref, at);
  if (bearing.distance === 0) return { short: 'at base', long: `at your ${label}` };
  return {
    short: `${bearing.short} ${bearing.distance}`,
    long: `${bearing.distance} ${bearing.long} of your ${label}`,
  };
}

/** Centre of mass, which is where a squad *is* in the sense a commander means
 *  it — not the position of whichever member happens to be first in the array. */
export function squadPosition(world: World, squad: Squad): Vec2 | null {
  const ids = new Set(squad.memberIds);
  let x = 0;
  let z = 0;
  let n = 0;
  for (const u of world.units) {
    if (!ids.has(u.id)) continue;
    x += u.x;
    z += u.z;
    n++;
  }
  return n ? { x: x / n, z: z / n } : null;
}

const CHAIN_ACTIVITY: Record<BehaviourKind, string> = {
  move: 'Moving', attackmove: 'Advancing', gather: 'Gathering', patrol: 'Patrolling',
};

/**
 * What the squad is doing, in one word.
 *
 * Engagement outranks the chain step on purpose: a squad part-way through an
 * attack-move that is currently trading blows is *fighting*, and reporting
 * "Advancing" because that is what the chain says would describe the order
 * rather than the battlefield.
 */
export function squadActivity(world: World, squad: Squad): string {
  const ids = new Set(squad.memberIds);
  const members = world.units.filter(u => ids.has(u.id));
  if (!members.length) return 'No units';
  if (members.some(u => u.targetId !== null)) return 'Fighting';
  if (squad.running) {
    const step = squad.chain[squad.index];
    if (step) return CHAIN_ACTIVITY[step.kind];
  }
  if (members.some(u => u.build && u.build.siteId !== null)) return 'Building';
  if (members.some(u => u.gather && u.gather.state !== 'idle')) return 'Gathering';
  if (members.some(u => u.orderMode === 'patrol')) return 'Patrolling';
  if (members.some(u => u.orderMode === 'attackMove')) return 'Advancing';
  if (members.some(u => u.orderMode === 'move')) return 'Moving';
  if (members.some(u => u.orderMode === 'hold')) return 'Holding';
  // One word, and the shortest true one: the card's middle column is ~55px on
  // the compact layout and a longer phrase would arrive ellipsised.
  return 'Idle';
}

/** Blueprint § "Squad Cards": name, purpose, place — "Squad One  Holding  Hill
 *  Alpha". Three facts on one line, no portrait and no unit list. */
export interface SquadCard {
  squadId: EntityId;
  number: number;
  name: string;
  activity: string;
  where: string;
  /** The whole card as one sentence, for the tooltip. */
  detail: string;
  units: number;
}

export function squadCard(world: World, squad: Squad): SquadCard {
  const activity = squadActivity(world, squad);
  const place = placeOf(world, squad.team, squadPosition(world, squad));
  const name = squadName(squad.number);
  const units = squad.memberIds.length;
  return {
    squadId: squad.id,
    number: squad.number,
    name,
    activity,
    where: place.short,
    detail: `${name} — ${units} unit${units === 1 ? '' : 's'} — ${activity} — ${place.long}`,
    units,
  };
}

/** The blueprint's mission panel is a label/value table. This is that table, in
 *  its order, so the DOM renders it without deciding what it says. */
export interface MissionSummary {
  id: EntityId;
  objective: MissionObjective;
  status: MissionStatus;
  priority: MissionPriority;
  squadNumbers: number[];
  fallback: Place | null;
  rows: Array<{ label: string; value: string }>;
}

export function missionSummary(world: World, mission: Mission): MissionSummary {
  const squadNumbers = mission.squadIds
    .map(id => world.squads.find(s => s.id === id)?.number)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  const fallback = mission.fallback ? placeOf(world, mission.team, mission.fallback) : null;
  return {
    id: mission.id,
    objective: mission.objective,
    status: mission.status,
    priority: mission.priority,
    squadNumbers,
    fallback,
    rows: [
      { label: 'Objective', value: OBJECTIVE_LABEL[mission.objective] },
      { label: 'Status', value: STATUS_LABEL[mission.status] },
      { label: 'Priority', value: PRIORITY_LABEL[mission.priority] },
      { label: 'Squads', value: squadNumbers.length ? squadNumbers.join(', ') : 'none' },
      { label: 'Fallback', value: fallback ? fallback.short : 'none' },
    ],
  };
}

export interface MissionPanelModel {
  /** Active operations in the order they were given, then the last few that
   *  concluded — so the status field means something. */
  missions: MissionSummary[];
  selectedId: EntityId | null;
  /** Cards for the squads on the open operation. */
  assigned: SquadCard[];
  /** Cards for every other squad the team has. */
  unassigned: SquadCard[];
}

export function missionPanelModel(
  world: World, team: Team, selectedId: EntityId | null,
): MissionPanelModel {
  const own = world.missions.filter(m => m.team === team);
  const active = own.filter(m => m.status === 'active');
  const concluded = own.filter(m => m.status !== 'active').slice(-CONCLUDED_SHOWN);
  const listed = [...active, ...concluded];

  const selected = listed.find(m => m.id === selectedId) ?? active[0] ?? listed[0] ?? null;
  const onSelected = new Set(selected ? selected.squadIds : []);
  const squads = world.squads.filter(s => s.team === team).sort((a, b) => a.number - b.number);

  return {
    missions: listed.map(m => missionSummary(world, m)),
    selectedId: selected ? selected.id : null,
    assigned: squads.filter(s => onSelected.has(s.id)).map(s => squadCard(world, s)),
    unassigned: squads.filter(s => !onSelected.has(s.id)).map(s => squadCard(world, s)),
  };
}

export interface MissionPanel {
  update: () => void;
}

const TEAM: Team = 'player';

/** Option value for a fallback that stands on no building of the player's, so
 *  the control can show it without pretending it can be re-chosen. */
const HELD_FALLBACK = 'held';

export function createMissionPanel(
  world: World,
  ui: UiState,
  flash: (msg: string) => void,
): MissionPanel {
  const body = document.getElementById('missions-body');
  const newRow = document.getElementById('missions-new');
  const note = document.getElementById('missions-note');
  if (!body || !newRow || !note) {
    return { update: () => { /* panel absent from this page */ } };
  }

  // Presentation-only: which operation the panel has open. Deliberately not on
  // `UiState` — nothing outside this panel needs it, and sim state it is not.
  let selectedId: EntityId | null = null;

  // Rebuilt only when the shape changes, so a button survives long enough to be
  // clicked and the DOM is not thrashed sixty times a second.
  let renderedKey = '';

  note.textContent = MISSION_INERT_NOTE;

  const squadById = (id: EntityId): Squad | undefined => world.squads.find(s => s.id === id);

  function create(objective: MissionObjective): void {
    // Blueprint § "Selection Philosophy": picking an objective with a squad in
    // hand is one click, not create-then-assign.
    const squad = world.squads.find(s => s.id === ui.selectedSquadId && s.team === TEAM);
    const squadIds = squad ? [squad.id] : [];
    const res = issueCommand(
      { t: 'createMission', team: TEAM, objective, squadIds },
      () => cmdCreateMission(world, TEAM, objective, { squadIds: [...squadIds] }),
    );
    if (res.ok && res.siteId !== undefined) selectedId = res.siteId;
    flash(squad
      ? `${OBJECTIVE_LABEL[objective]} ordered — ${squadName(squad.number).toLowerCase()} assigned`
      : `${OBJECTIVE_LABEL[objective]} ordered`);
  }

  function assign(missionId: EntityId, squad: Squad): void {
    const res = issueCommand(
      { t: 'assignSquadToMission', mission: missionId, squad: squad.id },
      () => cmdAssignSquadToMission(world, missionId, squad.id),
    );
    flash(res.ok
      ? `${squadName(squad.number).toLowerCase()} assigned`
      : res.reason ?? 'cannot assign that squad');
  }

  function release(missionId: EntityId, squad: Squad): void {
    issueCommand(
      { t: 'removeSquadFromMission', mission: missionId, squad: squad.id },
      () => cmdRemoveSquadFromMission(world, missionId, squad.id),
    );
    flash(`${squadName(squad.number).toLowerCase()} released`);
  }

  function setPriority(missionId: EntityId, priority: MissionPriority): void {
    issueCommand(
      { t: 'setMissionPriority', mission: missionId, priority },
      () => cmdSetMissionPriority(world, missionId, priority),
    );
  }

  function setFallback(missionId: EntityId, building: Building | null): void {
    const fallback: Vec2 | null = building ? { x: building.x, z: building.z } : null;
    issueCommand(
      { t: 'setMissionFallback', mission: missionId, fallback },
      // A separate object for the world: the recorded command must not share a
      // mutable value with sim state, or editing one would edit the record.
      () => cmdSetMissionFallback(
        world, missionId, building ? { x: building.x, z: building.z } : null),
    );
    flash(building
      ? `fallback set to the ${BUILDING_TYPES[building.type].label}`
      : 'fallback cleared');
  }

  function cancel(missionId: EntityId, objective: MissionObjective): void {
    const res = issueCommand(
      { t: 'cancelMission', mission: missionId },
      () => cmdCancelMission(world, missionId),
    );
    flash(res.ok
      ? `${OBJECTIVE_LABEL[objective]} cancelled`
      : res.reason ?? 'cannot cancel that operation');
  }

  /** Opening a squad from its card hands it to the chain editor, which is the
   *  bridge from Level 2 back down to Level 3. Selection goes through the
   *  gateway rather than writing `unit.selected` in place. */
  function open(squad: Squad): void {
    ui.selectedSquadId = squad.id;
    ui.armedBehaviour = null;
    ui.selectedBuildingId = null;
    ui.selectedSiteId = null;
    issueCommand(
      { t: 'select', units: squad.memberIds },
      () => cmdSetSelection(world, squad.memberIds),
    );
  }

  /** Which building, if any, the mission's fallback stands on. The control
   *  offers landmarks rather than coordinates, so it can only show back a
   *  fallback it is able to name. */
  function fallbackBuildingId(mission: Mission): string {
    const at = mission.fallback;
    if (!at) return '';
    const match = world.buildings.find(
      b => b.team === mission.team && b.x === at.x && b.z === at.z);
    return match ? String(match.id) : '';
  }

  function buildCard(
    card: SquadCard, action: 'assign' | 'release' | null, onAction: () => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'squad-card';
    row.dataset['squad'] = String(card.squadId);

    const pick = document.createElement('button');
    pick.className = 'squad-pick';
    pick.title = card.detail;
    const columns: Array<[string, string]> = [
      ['squad-name', card.name],
      ['squad-activity', card.activity],
      ['squad-where', card.where],
    ];
    for (const [cls, text] of columns) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      pick.append(span);
    }
    const squad = squadById(card.squadId);
    if (squad) pick.onclick = () => open(squad);
    row.append(pick);

    if (action && squad) {
      const act = document.createElement('button');
      act.className = 'squad-act';
      act.textContent = action === 'assign' ? '+' : '×';
      act.title = action === 'assign'
        ? `Assign ${card.name} to this operation`
        : `Release ${card.name} from this operation`;
      act.onclick = onAction;
      row.append(act);
    }
    return row;
  }

  function buildFields(summary: MissionSummary, mission: Mission, live: boolean): HTMLElement {
    const fields = document.createElement('dl');
    fields.className = 'op-fields';
    for (const row of summary.rows) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');

      if (row.label === 'Priority' && live) {
        dd.className = 'op-priority';
        for (const p of PRIORITY_ORDER) {
          const btn = document.createElement('button');
          btn.textContent = PRIORITY_LABEL[p];
          btn.className = mission.priority === p ? 'on' : '';
          btn.onclick = () => setPriority(mission.id, p);
          dd.append(btn);
        }
      } else if (row.label === 'Fallback' && live) {
        const select = document.createElement('select');
        select.title = 'Where the squads on this operation fall back to';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'none';
        select.append(none);
        // A fallback set from somewhere other than this control — a replay, or
        // a future map pick — stands on no building and would otherwise read
        // back as "none", which is the panel lying about sim state.
        const standing = fallbackBuildingId(mission);
        if (mission.fallback && !standing) {
          const held = document.createElement('option');
          held.value = HELD_FALLBACK;
          held.textContent = placeOf(world, TEAM, mission.fallback).short;
          select.append(held);
        }
        for (const b of world.buildings.filter(x => x.team === TEAM)) {
          const option = document.createElement('option');
          option.value = String(b.id);
          option.textContent = `${BUILDING_TYPES[b.type].label} · ${placeOf(world, TEAM, b).short}`;
          select.append(option);
        }
        select.value = mission.fallback && !standing ? HELD_FALLBACK : standing;
        select.onchange = () => {
          if (select.value === HELD_FALLBACK) return;
          setFallback(mission.id,
            world.buildings.find(b => String(b.id) === select.value) ?? null);
        };
        dd.append(select);
      } else {
        dd.textContent = row.value;
      }
      fields.append(dt, dd);
    }
    return fields;
  }

  function rebuild(model: MissionPanelModel): void {
    body!.replaceChildren();
    const summary = model.missions.find(m => m.id === model.selectedId);
    const mission = summary ? world.missions.find(m => m.id === summary.id) : undefined;
    const live = mission !== undefined && mission.status === 'active';

    if (!model.missions.length) {
      const empty = document.createElement('p');
      empty.className = 'ops-empty';
      empty.textContent = 'No operations ordered.';
      body!.append(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'ops-list';
      for (const m of model.missions) {
        const row = document.createElement('button');
        row.className = m.id === model.selectedId ? 'op-row on' : 'op-row';
        row.dataset['mission'] = String(m.id);
        const label = document.createElement('span');
        label.className = 'op-name';
        label.textContent = OBJECTIVE_LABEL[m.objective];
        const state = document.createElement('span');
        state.className = 'op-state';
        state.textContent = m.status === 'active'
          ? PRIORITY_LABEL[m.priority] : STATUS_LABEL[m.status];
        const count = document.createElement('span');
        count.className = 'op-count';
        count.textContent = m.squadNumbers.length ? `${m.squadNumbers.length} sq` : '—';
        row.append(label, state, count);
        row.title = `${OBJECTIVE_LABEL[m.objective]} — ${STATUS_LABEL[m.status]}`;
        row.onclick = () => { selectedId = m.id; };
        list.append(row);
      }
      body!.append(list);
    }

    if (summary && mission) {
      body!.append(buildFields(summary, mission, live));

      const assigned = document.createElement('div');
      assigned.className = 'squad-cards';
      for (const card of model.assigned) {
        const squad = squadById(card.squadId);
        if (squad) assigned.append(buildCard(card, live ? 'release' : null,
          () => release(mission.id, squad)));
      }
      if (!model.assigned.length) {
        const none = document.createElement('p');
        none.className = 'ops-empty';
        none.textContent = 'No squads on this operation.';
        assigned.append(none);
      }
      body!.append(assigned);
    }

    // Squads exist whether or not an operation does, and a squad card is a
    // fact about the army rather than about the mission — so the panel still
    // reports them when nothing has been ordered yet.
    if (model.unassigned.length) {
      const head = document.createElement('h4');
      head.textContent = mission ? 'Other squads' : 'Squads';
      body!.append(head);
      const rest = document.createElement('div');
      rest.className = 'squad-cards';
      for (const card of model.unassigned) {
        const squad = squadById(card.squadId);
        if (squad) rest.append(buildCard(card, live && mission ? 'assign' : null,
          () => { if (mission) assign(mission.id, squad); }));
      }
      body!.append(rest);
    }

    // Last, deliberately. The body scrolls once an operation is open, and what
    // goes below the fold should be the control the player reaches for least.
    if (live && mission) {
      const stop = document.createElement('button');
      stop.className = 'op-cancel';
      stop.textContent = 'Cancel operation';
      stop.title = 'Call this operation off';
      stop.onclick = () => cancel(mission.id, mission.objective);
      body!.append(stop);
    }
  }

  // The objectives never change, so this row is built once and its buttons are
  // never replaced under the player's cursor.
  for (const objective of OBJECTIVE_ORDER) {
    const btn = document.createElement('button');
    btn.textContent = OBJECTIVE_LABEL[objective];
    btn.dataset['objective'] = objective;
    btn.title = `Order a ${OBJECTIVE_LABEL[objective]} operation`;
    btn.onclick = () => create(objective);
    newRow.append(btn);
  }

  function update(): void {
    const model = missionPanelModel(world, TEAM, selectedId);
    selectedId = model.selectedId;

    const key = [
      String(selectedId),
      world.missions.filter(m => m.team === TEAM).map(m =>
        [m.id, m.objective, m.status, m.priority, m.squadIds.join('.'),
          m.fallback ? `${m.fallback.x},${m.fallback.z}` : ''].join('/')).join('|'),
      world.squads.filter(s => s.team === TEAM).map(s => `${s.id}:${s.number}`).join('.'),
      world.buildings.filter(b => b.team === TEAM).map(b => b.id).join('.'),
    ].join('#');
    if (key !== renderedKey) { renderedKey = key; rebuild(model); }

    // The note is only true of a build that has an operation in it, and an
    // empty panel is cheaper on screen without it.
    note!.hidden = model.missions.length === 0;

    // Live text every frame: a squad's activity and position change constantly
    // and neither belongs in the rebuild key.
    for (const card of [...model.assigned, ...model.unassigned]) {
      const el = body!.querySelector(`[data-squad="${card.squadId}"]`);
      if (!el) continue;
      const activity = el.querySelector('.squad-activity');
      const where = el.querySelector('.squad-where');
      const pick = el.querySelector('button.squad-pick');
      if (activity) activity.textContent = card.activity;
      if (where) where.textContent = card.where;
      if (pick instanceof HTMLElement) pick.title = card.detail;
      el.classList.toggle('is-selected', card.squadId === ui.selectedSquadId);
    }
  }

  return { update };
}
