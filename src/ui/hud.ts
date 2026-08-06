import type { UnitTypeKey, World } from '../core/types';
import { TICK_HZ } from '../core/loop';
import { BUILDING_TYPES } from '../data/buildings';
import { UNIT_TYPES } from '../data/units';
import { canTrain } from '../sim/production';
import { cmdCancelSite, cmdHoldPosition, cmdStop, cmdTrain } from '../sim/commands';
import { builderIsWorking, buildersOn } from '../sim/construction';
import { countGathering, totalResourcesRemaining } from '../sim/economy';
import { supplyCap, supplyUsed } from '../sim/supply';
import { automationSlots, runningSquads } from '../sim/squads';
import type { UiState } from '../input/selection';
import { dayNumber, dayPeriod, daylight, formatClock } from '../sim/daynight';
import { issueCommand } from '../replay/live';
import { createDebugReadout } from './debugReadout';

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found;
};

/** Matches `--alert` in index.html. The only inline colour the HUD sets. */
const ALERT = '#a33a2a';

export interface Hud {
  flash: (msg: string) => void;
  tryTrain: (unitType: UnitTypeKey) => void;
  update: (now: number, throttled: boolean) => void;
}

export function createHud(world: World, ui: UiState): Hud {
  // Developer scaffolding, and only present behind `?dev=`. In a player build
  // this is inert and there is no panel in the DOM at all.
  const debug = createDebugReadout();
  const resUi = {
    essence: el('r-essence'), gathering: el('r-gathering'),
    workers: el('r-workers'), remaining: el('r-remaining'), supply: el('r-supply'),
    chains: el('r-chains'),
  };
  const clockUi = { time: el('c-time'), period: el('c-period'), dial: el('c-dial') };
  const cardTitle = el('card-title');
  const cardBtns = el('card-btns');
  const cardQueue = el('card-queue');
  const cardHint = el('card-hint');
  const flashEl = el('flash');

  let announcedWinner = false;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(msg: string): void {
    flashEl.textContent = msg;
    flashEl.style.opacity = '1';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.style.opacity = '0'; }, 1600);
  }

  function tryTrain(unitType: UnitTypeKey): void {
    if (ui.selectedBuildingId === null) { flash('select a structure first'); return; }
    const building = ui.selectedBuildingId;
    const res = issueCommand(
      { t: 'train', building, unit: unitType },
      () => cmdTrain(world, building, unitType),
    );
    if (!res.ok) flash(res.reason ?? 'cannot train that');
  }

  // Rebuilt only when the selection changes, so buttons stay clickable.
  let cardKey = '';
  function renderCard(): void {
    const sel = world.units.filter(u => u.selected);
    const b = ui.selectedBuildingId !== null
      ? world.buildings.find(x => x.id === ui.selectedBuildingId) : undefined;
    const site = ui.selectedSiteId !== null
      ? world.sites.find(x => x.id === ui.selectedSiteId) : undefined;
    const first = sel[0];
    const key = site ? `s${site.id}`
      : b ? `b${b.id}`
      : first ? `u${sel.length}:${first.type}`
      : 'none';

    if (key !== cardKey) {
      cardKey = key;
      cardBtns.innerHTML = '';
      // The band is a fixed grid of command columns; with nothing to command it
      // carries one sentence instead, which needs the full width.
      cardBtns.classList.toggle('is-empty', key === 'none');
      if (site) {
        cardTitle.textContent = `${BUILDING_TYPES[site.type].label} — under construction`;
        const btn = document.createElement('button');
        // Two short lines per button: name, then hotkey and cost. The prose that
        // used to be the second line ("full refund", "engage along route") is a
        // tooltip and lives in full in the controls sheet — at five buttons the
        // card's columns are ~100px and prose clipped inside them (D-032).
        btn.title = 'Cancel this build site and refund the essence in full';
        btn.innerHTML = '<b>Cancel</b><span class="c">Esc · refund</span>';
        btn.onclick = () => {
          issueCommand(
            { t: 'cancelSite', site: site.id },
            () => cmdCancelSite(world, site.id),
          );
          ui.selectedSiteId = null;
          flash('site cancelled, essence refunded');
        };
        cardBtns.appendChild(btn);
        cardHint.textContent = 'right-click the site with a worker selected to resume';
      } else if (b) {
        const t = BUILDING_TYPES[b.type];
        cardTitle.textContent = `${t.label} — +${t.command} command`;
        const hotkeys: Partial<Record<UnitTypeKey, string>> = { worker: 'Q', legionnaire: 'E', marksman: 'R' };
        for (const ut of t.produces) {
          const u = UNIT_TYPES[ut];
          const btn = document.createElement('button');
          const key = hotkeys[ut];
          btn.title = `Train a ${u.label} — ${u.cost} essence, ${u.supply} command`;
          btn.innerHTML = `<b>${u.label}</b><span class="c">${key ? `${key} · ` : ''}${u.cost}</span>`;
          btn.dataset['unit'] = ut;
          btn.onclick = () => tryTrain(ut);
          cardBtns.appendChild(btn);
        }
        cardHint.textContent = 'right-click the ground to set a rally point';
      } else if (first) {
        const workers = sel.filter(u => u.gather).length;
        cardTitle.textContent = `${sel.length} selected (${workers} worker${workers === 1 ? '' : 's'})`;
        if (workers) {
          const t = BUILDING_TYPES.outpost;
          const btn = document.createElement('button');
          btn.title = `Site an outpost — ${t.cost} essence, +${t.command} command, holds territory`;
          btn.innerHTML = `<b>Outpost</b><span class="c">B · ${t.cost}</span>`;
          btn.dataset['build'] = 'outpost';
          btn.onclick = () => { ui.placingType = 'outpost'; };
          cardBtns.appendChild(btn);
          cardHint.textContent = 'outposts add command, hold territory, and accept essence';
        }
        const combat = sel.some(u => !u.gather);
        if (combat) {
          const orders: Array<[string, string, string, () => void]> = [
            ['Attack', 'A', 'Attack-move: engage anything met along the route', () => { ui.armedOrder = 'attackMove'; ui.armedBehaviour = null; flash('attack-move armed — click the battlefield'); }],
            ['Patrol', 'P', 'Patrol between here and the next click', () => { ui.armedOrder = 'patrol'; ui.armedBehaviour = null; flash('patrol armed — click the battlefield'); }],
            ['Stop', 'S', 'Cancel the current orders', () => { const ids = sel.map(u => u.id); issueCommand({ t: 'stop', units: ids }, () => cmdStop(world, ids)); flash('orders stopped'); }],
            ['Hold', 'H', 'Hold this ground', () => { const ids = sel.map(u => u.id); issueCommand({ t: 'hold', units: ids }, () => cmdHoldPosition(world, ids)); flash('holding position'); }],
          ];
          for (const [label, key, note, action] of orders) {
            const btn = document.createElement('button');
            btn.title = note;
            btn.innerHTML = `<b>${label}</b><span class="c">${key}</span>`;
            btn.onclick = action;
            cardBtns.appendChild(btn);
          }
        }
        cardHint.textContent = workers ? 'workers can build; combat hotkeys remain available for mixed selections' : 'A attack-move · P patrol · S stop · H hold';
      } else {
        cardTitle.textContent = 'Nothing selected';
        // The card is a fixed slab so the flash line above it cannot be walked
        // into; say something in the button band rather than leaving it blank.
        const idle = document.createElement('span');
        idle.className = 'empty';
        idle.textContent = 'Click a unit or the Standard. Drag to select a group.';
        cardBtns.appendChild(idle);
        cardHint.textContent = 'Right-click the ground to move · A attack-move · P patrol';
      }
    }

    // live state on every frame: affordability and queue
    for (const child of cardBtns.children) {
      const btn = child as HTMLButtonElement;
      const unit = btn.dataset['unit'] as UnitTypeKey | undefined;
      const build = btn.dataset['build'];
      if (unit) {
        btn.disabled = !(b && canTrain(world, b.id, unit).ok);
      } else if (build === 'outpost') {
        btn.disabled = world.resources.player < BUILDING_TYPES.outpost.cost;
      }
    }

    if (site) {
      const pct = Math.round((site.progress / site.required) * 100);
      const working = buildersOn(world, site.id).some(u => builderIsWorking(world, u));
      cardQueue.textContent = `${pct}% — ${working ? 'building' : 'PAUSED (no worker)'}`;
      cardQueue.style.color = working ? '' : ALERT;
    } else if (b?.queue.length) {
      const head = b.queue[0];
      cardQueue.style.color = '';
      if (head) {
        const pct = Math.round((1 - head.ticksLeft / UNIT_TYPES[head.type].buildTicks) * 100);
        const rest = b.queue.length > 1 ? ` (+${b.queue.length - 1} queued)` : '';
        cardQueue.textContent = `${UNIT_TYPES[head.type].label} ${pct}%${rest}`;
      }
    } else {
      cardQueue.textContent = '';
    }
  }

  let frameCount = 0;
  let tickAtLastSample = 0;
  let lastSample = 0;
  let essenceAtLastSample = 0;

  function update(now: number, throttled: boolean): void {
    frameCount++;
    if (now - lastSample >= 500) {
      const elapsed = (now - lastSample) / 1000;
      const fps = frameCount / elapsed;
      const tps = (world.tick - tickAtLastSample) / elapsed;
      const measuredRate = ((world.resources.player - essenceAtLastSample) / elapsed) * 60;

      frameCount = 0;
      tickAtLastSample = world.tick;
      essenceAtLastSample = world.resources.player;
      lastSample = now;

      debug.sampled({
        fps,
        ticksPerSecond: tps,
        tickRateOk: Math.abs(tps - TICK_HZ) <= 1.5,
        essencePerMinute: measuredRate,
      });
    }
    if (debug.active) {
      debug.live({
        tick: world.tick,
        units: world.units.length,
        selected: world.units.filter(u => u.selected).length,
        throttled,
      });
    }

    // Always visible, never hidden behind a toggle — the designer's ask is that
    // the player can tell the time of day at any moment.
    clockUi.time.textContent = formatClock(world);
    const period = dayPeriod(world);
    clockUi.period.textContent = period;
    const lit = Math.round(daylight(world) * 100);
    clockUi.dial.style.background =
      `conic-gradient(#ffd9a0 0 ${lit}%, #2b3557 ${lit}% 100%)`;
    clockUi.dial.title = `Day ${dayNumber(world) + 1} — ${period}`;

    // The match is over: say so once, plainly. Information, never advice
    // (UI_BLUEPRINT § "Information, never advice").
    if (world.winner && !announcedWinner) {
      announcedWinner = true;
      flash(world.winner === 'player' ? 'VICTORY — enemy base destroyed'
                                      : 'DEFEAT — your base was destroyed');
    }

    resUi.essence.textContent = String(world.resources.player);
    resUi.gathering.textContent = String(countGathering(world, 'player'));
    resUi.workers.textContent = String(world.units.filter(u => u.team === 'player' && u.gather).length);
    resUi.remaining.textContent = String(totalResourcesRemaining(world));

    const used = supplyUsed(world, 'player');
    const cap = supplyCap(world, 'player');
    resUi.supply.textContent = `${used}/${cap}`;
    resUi.supply.style.color = used >= cap ? ALERT : '';

    // Command buys automation slots as well as population (A4, §8.3).
    const slots = automationSlots(world, 'player');
    const chains = runningSquads(world, 'player');
    resUi.chains.textContent = `${chains}/${slots}`;
    resUi.chains.style.color = chains >= slots ? ALERT : '';

    renderCard();
  }

  return { flash, tryTrain, update };
}
