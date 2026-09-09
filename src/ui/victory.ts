import type { Team, World } from '../core/types';
import { TICK_HZ } from '../core/loop';
import { dayNumber, formatClock } from '../sim/daynight';
import { totalResourcesRemaining } from '../sim/economy';

/**
 * The outcome surface — what the match was, once it is over.
 *
 * What it replaces: `hud.ts` announced the end of the match through `flash()`,
 * the same 1.6-second transient that carries "orders stopped" and "patrol
 * armed". A result the player can miss by looking at the minimap is not a
 * result, and sharing a channel with routine acknowledgements said the two
 * were the same kind of event.
 *
 * Three things it must answer, and it answers them in this order because that
 * is the order they are asked: **who won**, **why**, and **how long it took**.
 *
 * Everything below the headline is a fact read off the world. Nothing here
 * rates the match, explains what would have worked, or offers a next step —
 * `UI_BLUEPRINT.md` § "Information, never advice" applies to the losing screen
 * more than anywhere else, because a defeat is exactly where an interface is
 * tempted to start coaching.
 *
 * The panel is dismissable and the simulation is untouched by it. `World`'s own
 * comment on `winner` is that "the sim keeps running; presentation decides what
 * to do about it" — so dismissing this returns the player to a board that is
 * still moving, rather than to a frozen screenshot.
 */

/** How the two teams are named in a readout. `Team` is an internal key and has
 *  never had a player-facing form; the fact rows below are the first place one
 *  is needed, so it is declared once here rather than spelled inline. */
export const TEAM_NAME: Record<Team, string> = {
  player: 'You',
  rival: 'Rival',
};

export interface OutcomeFact {
  label: string;
  value: string;
}

export interface MatchOutcome {
  winner: Team;
  /** From the viewing team's side. The panel is one surface, not two. */
  result: 'victory' | 'defeat';
  headline: string;
  /** The win condition, stated as what happened rather than as a rule. */
  cause: string;
  durationTicks: number;
  /** `m:ss` of real match time. */
  duration: string;
  facts: OutcomeFact[];
}

/**
 * Match length as the player experiences it: real seconds, derived from ticks.
 *
 * Deliberately not the in-game clock. Ten real minutes is a full in-game day
 * (D-013), so a match reported in in-game hours would read as a day and a half
 * for something that took four minutes. The in-game time is carried separately
 * as its own fact.
 */
export function formatDuration(ticks: number): string {
  const seconds = Math.max(0, Math.round(ticks / TICK_HZ));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Thousands separated, because the resource left on the map runs to five
 *  digits and an unseparated 7120 is read as a phone number. */
function thousands(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function count(world: World, team: Team): { units: number; structures: number } {
  return {
    units: world.units.filter(u => u.team === team).length,
    // Sites count: a team holding only a half-built outpost has not lost, and
    // `stepVictory` agrees — so the readout must agree with the rule it reports.
    structures: world.buildings.filter(b => b.team === team).length
      + world.sites.filter(s => s.team === team).length,
  };
}

/**
 * The whole outcome, or `null` while the match is still being played.
 *
 * `endedTick` is passed in rather than read from `world.tick`, because the sim
 * keeps stepping after the winner is set and the panel must keep reporting the
 * length of the match rather than the length of the session. The overlay latches
 * it on the frame it first sees a winner; that is within a few ticks of the
 * tick `stepVictory` fired, which is invisible at `m:ss` resolution.
 */
export function matchOutcome(
  world: World, viewer: Team, endedTick: number,
): MatchOutcome | null {
  if (!world.winner) return null;
  const winner = world.winner;
  const loser: Team = winner === 'player' ? 'rival' : 'player';
  const result = winner === viewer ? 'victory' : 'defeat';

  const other: Team = viewer === 'player' ? 'rival' : 'player';
  const mine = count(world, viewer);
  const theirs = count(world, other);
  const pair = (a: number | string, b: number | string): string =>
    `${TEAM_NAME[viewer]} ${a} · ${TEAM_NAME[other]} ${b}`;

  // The only win condition the simulation has (`stepVictory`): a team holding
  // no structure and no build site for the grace period is eliminated. Stated
  // as the event, not as the rule — the player watched it happen.
  const cause = loser === viewer
    ? 'Every structure you held was destroyed.'
    : 'Every structure the rival held was destroyed.';

  return {
    winner,
    result,
    headline: result === 'victory' ? 'Victory' : 'Defeat',
    cause,
    durationTicks: endedTick,
    duration: formatDuration(endedTick),
    facts: [
      { label: 'Match length', value: formatDuration(endedTick) },
      { label: 'Ended', value: `day ${dayNumber(world) + 1} · ${formatClock(world)}` },
      { label: 'Structures standing', value: pair(mine.structures, theirs.structures) },
      { label: 'Units standing', value: pair(mine.units, theirs.units) },
      {
        label: 'Legacy held',
        value: pair(thousands(world.resources[viewer]), thousands(world.resources[other])),
      },
      {
        label: 'Legacy left on the map',
        value: `${thousands(totalResourcesRemaining(world))} in ${world.nodes.length} node${world.nodes.length === 1 ? '' : 's'}`,
      },
    ],
  };
}

export interface VictoryOverlay {
  update: () => void;
  /** Whether the panel is on screen right now. Read-only; the panel is opened
   *  by the match ending and closed by the player, never by a caller. */
  readonly shown: boolean;
}

/**
 * Builds its own DOM and appends it to the body, the way `controlsSheet.ts`
 * does. The styles live in `index.html` with the rest of the command surface,
 * so the outcome is the same warm-vellum material as every other panel rather
 * than a second visual language arriving at the most-looked-at moment (D-032).
 */
export function createVictoryOverlay(world: World, viewer: Team = 'player'): VictoryOverlay {
  const root = document.createElement('section');
  root.id = 'outcome';
  root.className = 'panel';
  root.setAttribute('role', 'status');

  const head = document.createElement('h2');
  head.id = 'outcome-head';
  const cause = document.createElement('p');
  cause.id = 'outcome-cause';
  const list = document.createElement('dl');
  list.id = 'outcome-facts';
  const dismiss = document.createElement('button');
  dismiss.id = 'outcome-dismiss';
  dismiss.type = 'button';
  dismiss.textContent = 'Continue watching';
  dismiss.title = 'Close this and return to the board, which is still running';

  root.append(head, cause, list, dismiss);
  document.body.appendChild(root);

  let endedTick: number | null = null;
  let rendered = false;
  let visible = false;

  function hide(): void {
    visible = false;
    root.classList.remove('visible');
  }
  dismiss.addEventListener('click', hide);

  function update(): void {
    if (!world.winner) return;
    if (endedTick === null) endedTick = world.tick;
    // Rendered once, on the frame the winner appears, and never again. The
    // simulation keeps stepping — the rival goes on gathering after the match
    // is decided — so a panel that re-read the world would show a board that
    // moved on rather than the state the match ended in.
    if (rendered) return;
    const outcome = matchOutcome(world, viewer, endedTick);
    if (!outcome) return;
    rendered = true;
    visible = true;

    head.textContent = outcome.headline;
    // Victory takes the gold the rest of the console uses for a live control;
    // defeat takes the alert brown it uses for a supply cap reached. Neither is
    // a new colour, which is the point (D-032, one visual language).
    root.dataset['result'] = outcome.result;
    cause.textContent = outcome.cause;

    list.replaceChildren();
    for (const fact of outcome.facts) {
      const dt = document.createElement('dt');
      dt.textContent = fact.label;
      const dd = document.createElement('dd');
      dd.textContent = fact.value;
      list.append(dt, dd);
    }
    root.classList.add('visible');
  }

  return {
    update,
    get shown(): boolean { return visible; },
  };
}
